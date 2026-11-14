'use strict';

/**
 * 比特浏览器客户端：通过本地 API 打开指定环境，再用 CDP 接入 Playwright。
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { probeUserAgent, DEFAULT_UA } = require('./browser-standalone');

chromium.use(StealthPlugin());

const DEFAULT_API_URL = 'http://127.0.0.1:54345';

function normalizeApiUrl(value) {
    const raw = String(value || DEFAULT_API_URL).trim() || DEFAULT_API_URL;
    return raw.replace(/\/+$/, '');
}

function parseBoolean(value, fallback) {
    if (value == null || value === '') {
        return fallback;
    }
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }
    return fallback;
}

function resolveBitBrowserConfig(env = process.env) {
    return {
        apiUrl: normalizeApiUrl(env.BITBROWSER_API_URL),
        profileId: String(env.BITBROWSER_PROFILE_ID || '').trim(),
        headless: parseBoolean(env.BITBROWSER_HEADLESS, true),
        openTimeoutMs: Number(env.BITBROWSER_OPEN_TIMEOUT_MS || 60000),
        closeTimeoutMs: Number(env.BITBROWSER_CLOSE_TIMEOUT_MS || 20000)
    };
}

async function postJson(url, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(),
        Math.max(1000, Number(timeoutMs) || 30000)
    );
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        const text = await response.text();
        let payload = {};
        if (text) {
            try {
                payload = JSON.parse(text);
            } catch (_) {
                payload = { raw: text };
            }
        }
        if (!response.ok) {
            throw new Error(`BitBrowser API HTTP ${response.status}: ${payload.msg || payload.message || text || '请求失败'}`);
        }
        if (payload.success === false) {
            throw new Error(`BitBrowser API: ${payload.msg || payload.message || '未知错误'}`);
        }
        return payload;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`BitBrowser API 请求超时: ${url}`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function openBitBrowserProfile(options = {}) {
    const config = resolveBitBrowserConfig(options.env || process.env);
    if (options.apiUrl) {
        config.apiUrl = normalizeApiUrl(options.apiUrl);
    }
    if (options.profileId) {
        config.profileId = String(options.profileId).trim();
    }
    if (options.headless != null) {
        config.headless = Boolean(options.headless);
    }

    if (!config.profileId) {
        throw new Error('BitBrowser 模式缺少 BITBROWSER_PROFILE_ID');
    }

    console.log(`🧩 [Browser/bitbrowser] 打开环境 ${config.profileId}（${config.headless ? '无头' : '有头'}）...`);
    const payload = await postJson(
        `${config.apiUrl}/browser/open`,
        { id: config.profileId, headless: config.headless },
        config.openTimeoutMs
    );
    const data = payload.data || {};
    const httpEndpoint = String(data.http || '').trim();
    const cdpUrl = httpEndpoint
        ? (/^https?:\/\//i.test(httpEndpoint) ? httpEndpoint : `http://${httpEndpoint}`)
        : '';
    if (!cdpUrl) {
        throw new Error('BitBrowser 未返回 CDP 地址（data.http）');
    }

    console.log(`♻️ [Browser/bitbrowser] 接入 CDP ${cdpUrl}`);
    const browser = await chromium.connectOverCDP(cdpUrl);
    const realUserAgent = await probeUserAgent(browser, DEFAULT_UA);

    return {
        mode: 'bitbrowser',
        browser,
        ownsBrowser: false,
        cdpUrl,
        cdpPort: new URL(cdpUrl).port || '',
        profileId: config.profileId,
        apiUrl: config.apiUrl,
        realUserAgent,
        close: async () => {
            try {
                await postJson(
                    `${config.apiUrl}/browser/close`,
                    { id: config.profileId },
                    config.closeTimeoutMs
                );
            } catch (error) {
                console.warn(`⚠️ [Browser/bitbrowser] 关闭环境失败: ${error.message}`);
            } finally {
                await browser.close().catch(() => {});
            }
        }
    };
}

async function closeBitBrowserProfile(options = {}) {
    const config = resolveBitBrowserConfig(options.env || process.env);
    if (!config.profileId) {
        return;
    }
    try {
        await postJson(
            `${config.apiUrl}/browser/close`,
            { id: config.profileId },
            config.closeTimeoutMs
        );
    } catch (_) {
        /* 进程退出时尽力关闭，不阻塞主流程 */
    }
}

module.exports = {
    resolveBitBrowserConfig,
    openBitBrowserProfile,
    closeBitBrowserProfile
};
