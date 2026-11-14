#!/usr/bin/env node
/**
 * UI 审计截图脚本（隔离环境，不连接真实数据库 / 不发起真实付款）
 *
 * 做法：
 * 1. 启动一个只读静态服务器，把 public/ 暴露出来；
 * 2. 所有 /api/* 请求由本脚本返回固定的模拟数据（mock）；
 * 3. 用系统 Chrome（Playwright）按场景截图，桌面与手机各一组；
 * 4. 记录每个场景的 console 报错与失败请求，输出 docs/ui-audit/report.json。
 *
 * 说明：截图中的业务数据全部为虚构数据，只能证明界面与状态渲染，
 * 不能作为"已接通真实支付流程"的证据。
 *
 * 用法：node scripts/ui-audit/capture.mjs
 */

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_DIR = path.join(ROOT, 'docs', 'ui-audit');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8',
    '.ico': 'image/x-icon'
};

/* ---------------- 模拟数据 ---------------- */
const MOCK_LOGS = [
    {
        id: 1,
        time: '2026-11-09 14:02:11',
        cdk: 'KC-7X2M9QK4T1',
        token: 'demo@example.com',
        message: '激活成功，订阅已生效',
        progress: 100,
        status: 'success',
        automation: { phase: 'completed', checkoutOpened: true }
    },
    {
        id: 2,
        time: '2026-11-09 13:58:40',
        cdk: 'KC-4P8N2ZK7W5',
        token: 'demo2@example.com',
        message: '支付被拒，已自动更换银行卡重试',
        progress: 64,
        status: 'running',
        automation: { phase: 'stripe_form', checkoutOpened: true }
    },
    {
        id: 3,
        time: '2026-11-09 13:41:05',
        cdk: 'KC-9T3R6YB1S8',
        token: 'demo3@example.com',
        message: '卡池暂无可用卡片，任务未启动',
        progress: 0,
        status: 'failed',
        automation: { phase: 'precheck' }
    },
    {
        id: 4,
        time: '2026-11-09 13:22:57',
        cdk: 'KC-2K5V8WD3X7',
        token: 'demo4@example.com',
        message: '需要人工处理：Checkout 页面结构变化',
        progress: 72,
        status: 'manual',
        automation: { phase: 'checkout', checkoutOpened: true }
    }
];

const MOCK_ADMIN_DATA = {
    success: true,
    runtime: {
        system: {
            cpu: { percent: 18, text: '8 核 · 实时采样' },
            memory: { percent: 42, text: '6.7G/16.0G' },
            disk: { percent: 53, usedText: '264G', totalText: '500G', drive: 'C:' },
            uptime: { seconds: 128400 }
        },
        active_foreground_jobs: 1,
        browser_pool: { enabled: true, size: 2, idle: 2, waiting: 0 }
    },
    stats: {
        total: 128,
        success: 119,
        failed: 9,
        cdk_total: 240,
        cdk_used: 131,
        cdk_unused: 109,
        billing_currency: 'PHP',
        billing_revenue: 18320.5,
        billing_paid_count: 96
    },
    config: {
        max_concurrent_activations: 4,
        maintenance_mode: false,
        card_pool: [{ last4: '4242' }, { last4: '1881' }]
    },
    logs: MOCK_LOGS,
    telegram: { enabled: false },
    hcaptcha: { mode: 'vlm' }
};

function sendJson(res, payload, status = 200) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
    });
    res.end(body);
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (_) {
        return {};
    }
}

const API_ROUTES = {
    'GET /api/public/payment-region': () => ({
        success: true,
        region: 'PH',
        label: '菲律宾',
        currency: 'PHP'
    }),
    'GET /api/public/runtime': () => ({
        success: true,
        runtime: { active_foreground_jobs: 1, max_foreground_jobs: 4 }
    }),
    'GET /api/public/admin-paths': () => ({
        success: true,
        panelPath: 'admin',
        loginPath: 'admin-login',
        panelUrl: '/admin',
        loginUrl: '/admin-login'
    }),
    'POST /api/verify-cdk': () => ({
        success: true,
        data: { plan_type: 'plus', plan_label: 'ChatGPT Plus', status: 'valid' }
    }),
    'POST /api/run-process': () => ({
        success: true,
        jobKey: 'mock-job-0001',
        message: '任务已启动'
    }),
    'GET /api/cdk/query': () => ({
        success: true,
        data: { status: '已使用', usedAt: '2026-11-09 14:02:11' }
    }),
    'POST /api/public/subscription/check': () => ({
        success: true,
        data: {
            hasActiveSubscription: true,
            email: 'demo@example.com',
            accountId: 'acct_demo_0001',
            plan: 'ChatGPT Plus',
            subscriptionChannel: 'Stripe',
            currency: 'PHP',
            expiresAtDisplay: '2026-12-09 14:02',
            remainingDaysDisplay: '29 天',
            autoRenew: '已关闭',
            hasPreviouslyPaid: '是',
            queriedAtDisplay: '2026-11-09 15:20',
            billingPageUrl: 'https://chatgpt.com/account/manage'
        }
    }),
    'GET /api/admin/session': () => ({ success: true, refreshed: false }),
    'GET /api/admin/data': () => MOCK_ADMIN_DATA,
    'GET /api/admin/cdks': () => ({ success: true, cdks: [] }),
    'GET /api/admin/cards': () => ({ success: true, cards: [] }),
    'GET /api/admin/region': () => ({ success: true, region: 'PH', label: '菲律宾', currency: 'PHP' }),
    'GET /api/admin/gpt-api': () => ({ success: true, config: { enabled: false } }),
    'GET /api/admin/security/status': () => ({
        success: true,
        login2faMode: 'either',
        methods: ['totp', 'telegram']
    }),
    'GET /api/admin/runtime-logs': () => ({ success: true, logs: [] }),
    'GET /api/admin/task-logs': () => ({ success: true, logs: MOCK_LOGS }),
    'GET /api/admin/browser-pool': () => ({
        success: true,
        mode: 'pool',
        slots: [{ index: 0, busy: false }, { index: 1, busy: true }]
    }),
    'POST /api/admin/login': () => ({ success: true, token: 'mock-admin-token', panelPath: '/admin' })
};

function startServer() {
    const server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const pathname = decodeURIComponent(url.pathname);

        const key = `${req.method} ${pathname}`;
        if (API_ROUTES[key]) {
            await readBody(req);
            return sendJson(res, API_ROUTES[key]());
        }
        if (pathname.startsWith('/api/')) {
            await readBody(req);
            return sendJson(res, { success: true });
        }

        let filePath;
        if (pathname === '/' || pathname === '/index.html') {
            filePath = path.join(PUBLIC_DIR, 'index.html');
        } else if (pathname === '/admin') {
            filePath = path.join(PUBLIC_DIR, 'admin.html');
        } else if (pathname === '/admin-login') {
            filePath = path.join(PUBLIC_DIR, 'admin-login.html');
        } else if (pathname === '/subscription') {
            filePath = path.join(PUBLIC_DIR, 'subscription.html');
        } else {
            filePath = path.join(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
        }

        if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            return res.end('not found');
        }

        const ext = path.extname(filePath).toLowerCase();
        const data = await readFile(filePath);
        res.writeHead(200, {
            'content-type': MIME[ext] || 'application/octet-stream',
            'cache-control': 'no-store'
        });
        res.end(data);
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
        });
    });
}

/* ---------------- 客户端可校验的模拟 Session ---------------- */
function base64url(obj) {
    return Buffer.from(JSON.stringify(obj), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function buildMockSession() {
    const now = Math.floor(Date.now() / 1000);
    const token = [
        base64url({ alg: 'RS256', typ: 'JWT' }),
        base64url({
            iss: 'https://auth.openai.com',
            aud: ['https://api.openai.com/v1'],
            scp: ['model.request'],
            exp: now + 3600,
            'https://api.openai.com/auth': {
                chatgpt_account_id: 'acct_demo_0001',
                chatgpt_user_id: 'user_demo_0001'
            },
            'https://api.openai.com/profile': { email: 'demo@example.com' }
        }),
        'MOCK_SIGNATURE_NOT_VALID'
    ].join('.');
    return JSON.stringify({ user: { email: 'demo@example.com' }, expires: new Date((now + 3600) * 1000).toISOString(), accessToken: token }, null, 2);
}

/* ---------------- 场景定义 ---------------- */
const DESKTOP = { width: 1440, height: 900 };
const LAPTOP = { width: 1280, height: 800 };
const TABLET = { width: 768, height: 1024 };
const MOBILE = { width: 390, height: 844 };

async function run() {
    await mkdir(OUT_DIR, { recursive: true });
    const { server, baseUrl } = await startServer();
    const executablePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const browser = await chromium.launch({
        headless: true,
        executablePath: existsSync(executablePath) ? executablePath : undefined,
        channel: existsSync(executablePath) ? undefined : 'chrome',
        args: ['--force-color-profile=srgb', '--font-render-hinting=none']
    });

    const report = { baseUrl, generatedAt: new Date().toISOString(), scenarios: [] };

    async function capture(name, { url, viewport, prepare, expect }) {
        const context = await browser.newContext({
            viewport,
            deviceScaleFactor: 1,
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
            reducedMotion: 'no-preference'
        });
        const page = await context.newPage();
        const errors = [];
        page.on('console', (msg) => {
            if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
        });
        page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
        page.on('requestfailed', (req) => {
            const failure = req.failure()?.errorText || '';
            // WebSocket 在隔离环境下不可用，属预期；仅记录非 ws 失败
            if (!/WebSocket|ws:/i.test(req.url() + failure)) {
                errors.push(`requestfailed: ${req.url()} ${failure}`);
            }
        });

        try {
            if (url === '/admin') {
                await page.addInitScript(() => {
                    try {
                        localStorage.setItem('plus_admin_token', 'mock-admin-token');
                    } catch (_) { }
                });
            }
            await page.goto(`${baseUrl}${url}`, { waitUntil: 'networkidle', timeout: 20000 });
            if (prepare) await prepare(page);
            await page.waitForTimeout(500);
            // 整页截图时把吸顶元素放回文档流，避免它被渲染到页面中间；
            // 效果等同于"页面位于滚动顶部"时用户看到的样子。
            await page.evaluate(() => {
                window.scrollTo(0, 0);
                document.querySelectorAll('.site-nav, .admin-mobile-bar').forEach((el) => {
                    el.style.position = 'static';
                });
            });
            await page.waitForTimeout(120);
            const file = path.join(OUT_DIR, `${name}.png`);
            await page.screenshot({ path: file, fullPage: true });
            report.scenarios.push({ name, url, viewport, file: path.relative(ROOT, file), errors, note: expect || '' });
            console.log(`[ok] ${name} -> ${path.relative(ROOT, file)}${errors.length ? ` (${errors.length} console/network issues)` : ''}`);
        } catch (error) {
            report.scenarios.push({ name, url, viewport, error: String(error && error.message || error), errors });
            console.error(`[fail] ${name}: ${error && error.message}`);
        } finally {
            await context.close();
        }
    }

    const session = buildMockSession();

    /* ---- 前台兑换页 ---- */
    await capture('front-empty-desktop', { url: '/', viewport: DESKTOP, expect: '初始状态' });
    await capture('front-empty-laptop', { url: '/', viewport: LAPTOP, expect: '笔记本宽度' });
    await capture('front-empty-tablet', { url: '/', viewport: TABLET, expect: '平板宽度' });
    await capture('front-empty-mobile', { url: '/', viewport: MOBILE, expect: '手机宽度' });

    await capture('front-step2-desktop', {
        url: '/',
        viewport: DESKTOP,
        expect: '卡密校验通过、等待提交 Session',
        prepare: async (page) => {
            await page.fill('#cdkInput', 'KC-7X2M9QK4T1');
            await page.click('#redeemBtn');
            await page.waitForSelector('#step2', { state: 'visible' });
            await page.fill('#tokenInput', session);
        }
    });

    await capture('front-error-mobile', {
        url: '/',
        viewport: MOBILE,
        expect: '卡密无效错误态（模拟接口返回失败）',
        prepare: async (page) => {
            await page.route('**/api/verify-cdk', (route) => route.fulfill({
                status: 403,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, message: 'CDK 无效、已使用或非自助激活码' })
            }));
            await page.fill('#cdkInput', 'KC-INVALID-0000');
            await page.click('#redeemBtn');
            await page.waitForSelector('#statusMessage', { state: 'visible' });
        }
    });

    await capture('front-running-desktop', {
        url: '/',
        viewport: DESKTOP,
        expect: '任务进行中（用现有 setProgress/updateFlowUI 渲染真实状态组件）',
        prepare: async (page) => {
            await page.evaluate(() => {
                document.getElementById('step1').style.display = 'none';
                document.getElementById('step2').style.display = 'block';
                document.getElementById('redeemPlanInfo').style.display = 'block';
                document.getElementById('redeemPlanInfo').innerHTML = '<span>套餐类型</span><strong>ChatGPT Plus</strong>';
                document.getElementById('startBtn').disabled = true;
                updateFlowUI(2, 'running');
                showProgress();
                setProgress(64, '正在填写账单信息（Stripe Checkout）', 'running', { force: true });
                setConnState('reconnecting');
            });
        }
    });

    await capture('front-success-desktop', {
        url: '/',
        viewport: DESKTOP,
        expect: '成功终态',
        prepare: async (page) => {
            await page.evaluate(() => {
                document.getElementById('step1').style.display = 'none';
                document.getElementById('step2').style.display = 'block';
                showProgress();
                applyTaskState({ type: 'status', status: 'success', progress: 100, message: '激活成功，订阅已生效' });
            });
        }
    });

    await capture('front-query-result-desktop', {
        url: '/',
        viewport: DESKTOP,
        expect: '查询状态结果（mock /api/cdk/query）',
        prepare: async (page) => {
            await page.click('.tab-btn[data-tab="query"]');
            await page.fill('#queryInput', 'KC-7X2M9QK4T1');
            await page.click('#queryBtn');
            await page.waitForSelector('.query-result-card');
        }
    });

    /* ---- 订阅查询页 ---- */
    await capture('subscription-empty-desktop', { url: '/subscription', viewport: DESKTOP });
    await capture('subscription-result-desktop', {
        url: '/subscription',
        viewport: DESKTOP,
        expect: '查询成功结果（mock 接口）',
        prepare: async (page) => {
            await page.fill('#sessionInput', session);
            await page.click('#checkBtn');
            await page.waitForSelector('#resultSection', { state: 'visible' });
        }
    });
    await capture('subscription-empty-mobile', { url: '/subscription', viewport: MOBILE });

    /* ---- 登录页 ---- */
    await capture('login-desktop', { url: '/admin-login', viewport: DESKTOP });
    await capture('login-mobile', { url: '/admin-login', viewport: MOBILE });
    await capture('login-2fa-desktop', {
        url: '/admin-login',
        viewport: DESKTOP,
        expect: '二次验证步骤（mock 登录返回 requires2fa）',
        prepare: async (page) => {
            await page.route('**/api/admin/login', (route) => route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    requires2fa: true,
                    challengeToken: 'mock-challenge',
                    methods: ['totp', 'telegram'],
                    defaultMethod: 'totp',
                    login2faMode: 'either',
                    email: 'admin@example.com'
                })
            }));
            await page.fill('#email', 'admin@example.com');
            await page.fill('#password', 'demo-password');
            await page.click('#loginBtn');
            await page.waitForSelector('#step2fa.active');
        }
    });

    /* ---- 管理后台 ---- */
    await capture('admin-dashboard-desktop', { url: '/admin', viewport: DESKTOP, expect: '概览中心' });
    await capture('admin-dashboard-laptop', { url: '/admin', viewport: LAPTOP });
    await capture('admin-dashboard-mobile', { url: '/admin', viewport: MOBILE });
    await capture('admin-drawer-mobile', {
        url: '/admin',
        viewport: MOBILE,
        expect: '移动端抽屉导航展开',
        prepare: async (page) => {
            await page.click('.admin-nav-toggle');
            await page.waitForTimeout(350);
        }
    });
    await capture('admin-tasks-desktop', {
        url: '/admin',
        viewport: DESKTOP,
        expect: '任务管理列表（mock 日志）',
        prepare: async (page) => {
            await page.click('.nav-item:has-text("任务管理")');
            await page.waitForTimeout(400);
            await page.evaluate((rows) => {
                if (typeof renderLogTable === 'function') {
                    renderLogTable(Array.isArray(window.__adminLogs) && window.__adminLogs.length ? window.__adminLogs : rows);
                }
            }, MOCK_LOGS);
            await page.waitForTimeout(300);
        }
    });

    await browser.close();
    server.close();

    await writeFile(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    const failed = report.scenarios.filter((s) => s.error).length;
    const noisy = report.scenarios.filter((s) => s.errors && s.errors.length).length;
    console.log(`\n完成：${report.scenarios.length} 个场景，失败 ${failed} 个，带 console/network 记录 ${noisy} 个`);
    console.log(`报告：${path.relative(ROOT, path.join(OUT_DIR, 'report.json'))}`);
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
