'use strict';

const axios = require('axios');
const crypto = require('crypto');
const store = require('./mysql-store');
const { getRegionConfig } = require('./region-config');
const { executePaymentWithRetry } = require('./payment-retry');
const { redactSensitiveText } = require('./redaction');
const { extractProfileFromToken } = require('./session-auth');

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const CHECKOUT_ENDPOINT = `${CHATGPT_ORIGIN}/backend-api/payments/checkout`;
const SENTINEL_HEADER = 'OpenAI-Sentinel-Token';
const CHECKOUT_SOURCE = 'chatgpt_web_merged';

const checkoutHeaderCache = new WeakMap();

function normalizePromoCampaign(value) {
    if (value && typeof value === 'object') {
        const id = String(value.promo_campaign_id || value.id || '').trim();
        if (!id) return null;
        return {
            promo_campaign_id: id,
            is_coupon_from_query_param: Boolean(value.is_coupon_from_query_param)
        };
    }
    const id = String(value || '').trim();
    if (!id || id === '0' || id.toLowerCase() === 'none' || id.toLowerCase() === 'off') {
        return null;
    }
    return { promo_campaign_id: id, is_coupon_from_query_param: false };
}

function resolvePromoCampaign(planType) {
    const configured = process.env.CHECKOUT_PROMO_CAMPAIGN;
    if (configured != null && String(configured).trim() !== '') {
        return normalizePromoCampaign(configured);
    }
    const defaultEnabled = String(process.env.CHECKOUT_DEFAULT_PROMO || '1') !== '0';
    const normalizedPlan = String(planType || '').toLowerCase();
    if (defaultEnabled && (normalizedPlan === 'plus' || normalizedPlan === 'chatgptplusplan')) {
        return normalizePromoCampaign('plus-1-month-free');
    }
    return null;
}

function buildPricingReferer(planType, promoCampaign, withUpgradeLocation = false) {
    const url = new URL(`${CHATGPT_ORIGIN}/`);
    url.searchParams.set('cta_tab', 'personal');
    url.searchParams.set('highlight_plan', String(planType || 'plus').toLowerCase() === 'plus' ? 'plus' : String(planType || 'plus'));
    if (withUpgradeLocation) {
        url.searchParams.set('codex_upgrade_location', 'sidebar profile');
    }
    if (promoCampaign?.promo_campaign_id) {
        url.searchParams.set('promo_campaign', promoCampaign.promo_campaign_id);
    }
    return url.toString();
}

function buildCheckoutCancelUrl(planType, promoCampaign) {
    const url = new URL(buildPricingReferer(planType, promoCampaign, true));
    url.hash = 'pricing';
    return url.toString();
}

function buildCheckoutPayload(planName, country, currency, options = {}) {
    const uiMode = String(process.env.CHECKOUT_UI_MODE || 'custom').trim() || 'custom';
    const planType = options.planType || planName;
    const promoCampaign = options.promoCampaign !== undefined
        ? normalizePromoCampaign(options.promoCampaign)
        : resolvePromoCampaign(planType);
    return {
        plan_name: planName,
        ...(promoCampaign ? { promo_campaign: promoCampaign } : {}),
        checkout_source: CHECKOUT_SOURCE,
        entry_point: 'all_plans_pricing_modal',
        billing_details: { country, currency },
        supports_saved_payment_link: true,
        checkout_ui_mode: uiMode,
        checkout_appearance: 'light',
        cancel_url: options.cancelUrl || buildCheckoutCancelUrl(planType, promoCampaign),
        purchase_attempt_id: options.purchaseAttemptId || crypto.randomUUID()
    };
}

function formatBrandList(brands) {
    if (!Array.isArray(brands) || !brands.length) return '';
    return brands
        .map((item) => `"${String(item.brand || '')}";v="${String(item.version || '')}"`)
        .join(', ');
}

function buildClientHintHeaders(hints) {
    if (!hints || typeof hints !== 'object') return {};
    const headers = {};
    const brands = formatBrandList(hints.brands);
    const fullBrands = formatBrandList(hints.fullVersionList);
    const chromeVersion = Array.isArray(hints.fullVersionList)
        ? hints.fullVersionList.find((item) => /Google Chrome/i.test(String(item.brand || '')))?.version
        : '';

    if (brands) headers['sec-ch-ua'] = brands;
    if (fullBrands) headers['sec-ch-ua-full-version-list'] = fullBrands;
    if (chromeVersion) headers['sec-ch-ua-full-version'] = JSON.stringify(String(chromeVersion));
    if (hints.mobile != null) headers['sec-ch-ua-mobile'] = hints.mobile ? '?1' : '?0';
    if (hints.platform) headers['sec-ch-ua-platform'] = JSON.stringify(String(hints.platform));
    if (hints.platformVersion) headers['sec-ch-ua-platform-version'] = JSON.stringify(String(hints.platformVersion));
    if (hints.architecture) headers['sec-ch-ua-arch'] = JSON.stringify(String(hints.architecture));
    if (hints.bitness) headers['sec-ch-ua-bitness'] = JSON.stringify(String(hints.bitness));
    if (hints.model) headers['sec-ch-ua-model'] = JSON.stringify(String(hints.model));
    return headers;
}

function resolveAccountId(accessToken, sessionData = null) {
    return String(
        sessionData?.accountId
        || sessionData?.account_id
        || sessionData?.account?.id
        || sessionData?.user?.account_id
        || sessionData?.user?.accountId
        || extractProfileFromToken(accessToken).accountId
        || ''
    ).trim();
}

function buildCheckoutRequestHeaders(accessToken, browserContext = {}, options = {}) {
    const hints = browserContext.clientHints || {};
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'OAI-Telemetry': '[1,null]',
        'x-openai-checkout-source': CHECKOUT_SOURCE,
        'x-openai-rejoin-pro-cta': '1',
        'x-openai-rate-limit-join-workspace': '1',
        Referer: buildPricingReferer(options.planType || 'plus', options.promoCampaign),
        ...buildClientHintHeaders(hints)
    };

    if (browserContext.accountId) headers['ChatGPT-Account-Id'] = browserContext.accountId;
    if (browserContext.deviceId) {
        headers['oai-did'] = browserContext.deviceId;
        headers['OAI-Device-Id'] = browserContext.deviceId;
    }
    if (browserContext.language) headers['OAI-Language'] = browserContext.language;
    if (browserContext.userAgent) headers['User-Agent'] = browserContext.userAgent;
    if (browserContext.sentinelToken) headers[SENTINEL_HEADER] = browserContext.sentinelToken;
    const sentinelHeaderMap = {
        sentinel: SENTINEL_HEADER,
        sentinelheader: SENTINEL_HEADER,
        sentineltoken: SENTINEL_HEADER,
        token: SENTINEL_HEADER,
        extradata: 'OpenAI-Sentinel-Extra-Data',
        sentinelextradata: 'OpenAI-Sentinel-Extra-Data',
        sessionobservertoken: 'X-OAI-Client-Session-Identity-Version'
    };
    for (const [name, value] of Object.entries(browserContext.sentinelHeaders || {})) {
        if (!value) continue;
        if (/^(openai-|x-oai-|oai-)/i.test(name)) {
            headers[name] = String(value);
            continue;
        }
        const mapped = sentinelHeaderMap[name.toLowerCase().replace(/[^a-z0-9]/g, '')];
        if (mapped === SENTINEL_HEADER && headers[SENTINEL_HEADER]) continue;
        if (mapped) headers[mapped] = String(value);
    }
    return headers;
}

function filterBrowserFetchHeaders(headers) {
    const forbidden = new Set([
        'user-agent', 'referer', 'origin', 'cookie', 'host', 'content-length',
        'accept-encoding', 'connection', 'sec-ch-ua', 'sec-ch-ua-full-version-list',
        'sec-ch-ua-full-version', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
        'sec-ch-ua-platform-version', 'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-model'
    ]);
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !forbidden.has(name.toLowerCase())));
}

async function readSentinelFromPageStorage(page) {
    try {
        return await page.evaluate(() => {
            const looksLikeSentinel = (value) => {
                if (typeof value !== 'string' || value.length < 80) return false;
                const text = value.trim();
                return text.startsWith('{') && /"p"\s*:/.test(text) && /"t"\s*:/.test(text) && /"c"\s*:/.test(text);
            };
            for (const storage of [window.localStorage, window.sessionStorage]) {
                for (let i = 0; i < storage.length; i += 1) {
                    const key = storage.key(i);
                    const value = key ? storage.getItem(key) : '';
                    if (looksLikeSentinel(value)) return value;
                }
            }
            for (const script of document.scripts) {
                const text = script.textContent || '';
                if (looksLikeSentinel(text)) return text;
            }
            const windowKeys = Object.keys(window).filter((key) => /sentinel/i.test(key));
            for (const key of windowKeys) {
                let value;
                try { value = window[key]; } catch (_) { continue; }
                if (looksLikeSentinel(value)) return value;
                if (value && typeof value === 'object') {
                    for (const innerKey of Object.keys(value)) {
                        if (looksLikeSentinel(value[innerKey])) return value[innerKey];
                    }
                }
            }
            return '';
        });
    } catch (_) {
        return '';
    }
}

function extractSentinelHeaderValue(payload, depth = 0) {
    if (payload == null || depth > 6) return '';
    if (typeof payload === 'string') {
        const text = payload.trim();
        if (!text.startsWith('{')) return '';
        try {
            return extractSentinelHeaderValue(JSON.parse(text), depth + 1);
        } catch (_) {
            return '';
        }
    }
    if (typeof payload !== 'object') return '';

    const p = payload.p;
    const t = payload.t;
    const c = payload.c;
    if (typeof p === 'string' && typeof t === 'string' && typeof c === 'string') {
        const token = { p, t, c };
        for (const key of ['id', 'flow']) {
            if (typeof payload[key] === 'string' && payload[key]) token[key] = payload[key];
        }
        return JSON.stringify(token);
    }

    for (const [key, value] of Object.entries(payload)) {
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (['openaisentineltoken', 'sentineltoken', 'sentinelheader'].includes(normalized)) {
            const found = extractSentinelHeaderValue(value, depth + 1);
            if (found) return found;
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
    }

    for (const value of Object.values(payload)) {
        const found = extractSentinelHeaderValue(value, depth + 1);
        if (found) return found;
    }
    return '';
}

function normalizeSentinelResult(result) {
    const headers = {};
    let token = '';
    const visit = (value, depth = 0) => {
        if (value == null || depth > 4) return;
        if (typeof value === 'string') {
            if (!token) {
                const found = extractSentinelHeaderValue(value);
                if (found) token = found;
            }
            return;
        }
        if (typeof value !== 'object') return;
        if (value.p && value.t && value.c) {
            token = token || extractSentinelHeaderValue(value) || JSON.stringify({ p: value.p, t: value.t, c: value.c });
        }
        for (const [key, inner] of Object.entries(value)) {
            const lower = key.toLowerCase();
            if (typeof inner === 'string' && inner) {
                headers[key] = inner;
                if (!token && /sentinel|header|token/i.test(lower)) {
                    token = extractSentinelHeaderValue(inner) || (/^\{/.test(inner) ? inner : '');
                }
            } else {
                visit(inner, depth + 1);
            }
        }
    };
    visit(result);
    return { token, headers };
}

function normalizeSentinelToken(rawToken, { deviceId = '', flow = 'chatgpt_checkout' } = {}) {
    const raw = String(rawToken || '').trim();
    if (!raw) return '';
    const normalized = extractSentinelHeaderValue(raw) || raw;
    let parsed;
    try {
        parsed = JSON.parse(normalized);
    } catch (_) {
        return normalized;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.p !== 'string' || typeof parsed.t !== 'string' || typeof parsed.c !== 'string') {
        return normalized;
    }
    const token = { p: parsed.p, t: parsed.t, c: parsed.c };
    const resolvedId = String(parsed.id || deviceId || '').trim();
    const resolvedFlow = String(parsed.flow || flow || '').trim();
    if (resolvedId) token.id = resolvedId;
    if (resolvedFlow) token.flow = resolvedFlow;
    return JSON.stringify(token);
}

const sentinelAcquireCache = new WeakMap();

function acquireSentinelFromPage(page, options = {}) {
    const deviceId = String(options.deviceId || '');
    const flow = String(options.flow || 'chatgpt_checkout');
    const cacheKey = `${deviceId}:${flow}`;
    const cached = sentinelAcquireCache.get(page);
    if (cached && cached.key === cacheKey && cached.expiresAt > Date.now()) {
        return cached.promise;
    }
    const entry = {
        key: cacheKey,
        expiresAt: Date.now() + 60000,
        promise: null
    };
    entry.promise = acquireSentinelFromPageUncached(page, { deviceId, flow });
    sentinelAcquireCache.set(page, entry);
    return entry.promise;
}

async function warmSentinelModule(page, { planType = 'plus' } = {}) {
    try {
        const hasAsset = await page.evaluate(() => performance.getEntriesByType('resource')
            .some((entry) => /\/assets\/sentinel-[^/]+\.js(?:\?|$)/i.test(entry.name)));
        if (hasAsset) return true;
        const url = new URL(`${CHATGPT_ORIGIN}/`);
        url.searchParams.set('cta_tab', 'personal');
        url.searchParams.set('highlight_plan', String(planType || 'plus').toLowerCase());
        url.hash = 'pricing';
        console.log('[ChatGPT] 加载定价模块以预热 Sentinel（不点击升级按钮）...');
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(5000);
        const loaded = await page.evaluate(() => performance.getEntriesByType('resource')
            .some((entry) => /\/assets\/sentinel-[^/]+\.js(?:\?|$)/i.test(entry.name)));
        console.log(`[ChatGPT] Sentinel 预热${loaded ? '成功' : '后仍未发现模块'}`);
        return loaded;
    } catch (error) {
        console.warn(`[ChatGPT] Sentinel 预热失败: ${String(error?.message || error).slice(0, 120)}`);
        return false;
    }
}
async function acquireSentinelFromPageUncached(page, { deviceId: fallbackDeviceId = '', flow = 'chatgpt_checkout' } = {}) {
    try {
        await page.bringToFront().catch(() => {});
        const viewport = page.viewportSize();
        await page.mouse.click(Math.max(3, (viewport?.width || 1280) - 3), 3).catch(() => {});
        const result = await page.evaluate(async ({ fallbackDeviceId, flow }) => {
            const startedAt = Date.now();
            const deadline = startedAt + 30000;
            const remaining = () => Math.max(0, deadline - Date.now());
            const withTimeout = (promise, ms) => Promise.race([
                promise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('调用超时')), Math.max(150, Math.min(ms, remaining() || 150))))
            ]);
            const safeFetchText = async (url, ms) => {
                try {
                    const response = await withTimeout(fetch(url, { credentials: 'include' }), ms);
                    if (!response || !response.ok) return '';
                    return (await withTimeout(response.text(), ms)) || '';
                } catch (_) {
                    return '';
                }
            };

            const matchesSentinelAsset = (url) => /\/assets\/sentinel-[^/]+\.js(?:\?|$)/i.test(String(url || ''));
            const assetUrlSet = new Set([
                ...performance.getEntriesByType('resource').map((entry) => entry.name),
                ...[...document.scripts].map((script) => script.src),
                ...[...document.querySelectorAll('link[rel="modulepreload"]')].map((link) => link.href)
            ].filter(matchesSentinelAsset));
            const discovery = {
                loadedAssets: [...assetUrlSet],
                scannedChunks: 0,
                fetchedChunks: 0,
                scannedHits: []
            };

            if (!assetUrlSet.size) {
                const allJs = [...new Set(performance.getEntriesByType('resource')
                    .map((entry) => entry.name)
                    .filter((url) => /\.js(?:\?|$)/i.test(url)))];
                const priority = allJs.filter((url) => /(sentinel|checkout|pricing|payment|upgrade|chat|conversation|app|main|index)/i.test(url));
                const rest = allJs.filter((url) => !priority.includes(url));
                const candidates = [...priority, ...rest].slice(0, 30);
                const scanDeadline = Math.min(deadline, startedAt + 12000);
                for (let index = 0; index < candidates.length && Date.now() < scanDeadline && !assetUrlSet.size; index += 6) {
                    const batch = candidates.slice(index, index + 6);
                    const texts = await Promise.all(batch.map((url) => safeFetchText(url, 2000)));
                    discovery.scannedChunks += batch.length;
                    discovery.fetchedChunks += texts.filter(Boolean).length;
                    batch.forEach((url, idx) => {
                        const source = texts[idx];
                        if (!source) return;
                        const matches = source.match(/(?:\.{0,2}\/)?(?:assets\/)?sentinel-[A-Za-z0-9_-]+\.js/g) || [];
                        for (const match of matches) {
                            try {
                                assetUrlSet.add(new URL(match.replace(/^\.\//, ''), url).href);
                                discovery.scannedHits.push(url);
                            } catch (_) { /* ignore */ }
                        }
                    });
                }
            }

            const readDeviceId = () => {
                for (const part of String(document.cookie || '').split(';')) {
                    const index = part.indexOf('=');
                    if (index < 0) continue;
                    const name = part.slice(0, index).trim();
                    if (/^(oai-did|oai-device-id|__oai-did)$/i.test(name)) {
                        return decodeURIComponent(part.slice(index + 1).trim());
                    }
                }
                return '';
            };
            const deviceId = readDeviceId() || String(fallbackDeviceId || '');
            if (!assetUrlSet.size) {
                assetUrlSet.add('https://cdn.oaistatic.com/assets/sentinel-B87GhLwH.js');
                discovery.knownCandidate = true;
            }
            const assetUrls = [...assetUrlSet];
            if (!assetUrls.length) {
                return {
                    ok: false,
                    error: `页面未加载 sentinel 模块，扫描 ${discovery.scannedChunks} 个 chunk 未发现引用`,
                    assetUrls: [],
                    discovery
                };
            }

            let mod = null;
            const importErrors = [];
            for (const assetUrl of assetUrls) {
                try {
                    mod = await withTimeout(import(assetUrl), 5000);
                    break;
                } catch (error) {
                    importErrors.push(String(error?.message || error));
                }
            }
            if (!mod) {
                return { ok: false, error: `sentinel 模块导入失败: ${importErrors.join(' | ')}`, assetUrls, discovery };
            }

            const collectStrings = (input, prefix = '', depth = 0, output = {}) => {
                if (input == null || depth > 4) return output;
                if (typeof input === 'string') {
                    if (prefix) output[prefix] = input;
                    return output;
                }
                if (typeof input !== 'object') return output;
                if (typeof input.entries === 'function') {
                    try {
                        for (const [key, value] of input.entries()) {
                            collectStrings(value, prefix ? `${prefix}.${key}` : String(key), depth + 1, output);
                        }
                        return output;
                    } catch (_) { /* fall through */ }
                }
                for (const key of Object.keys(input)) {
                    try {
                        collectStrings(input[key], prefix ? `${prefix}.${key}` : key, depth + 1, output);
                    } catch (_) { /* ignore getter errors */ }
                }
                return output;
            };
            const looksLikeToken = (value) => typeof value === 'string'
                && /"p"\s*:/.test(value) && /"t"\s*:/.test(value) && /"c"\s*:/.test(value);
            const describeReturn = (value) => {
                const strings = collectStrings(value);
                if (typeof value === 'string') strings.__value = value;
                let keys = [];
                if (value && typeof value === 'object') {
                    try {
                        keys = [...new Set([
                            ...Object.keys(value),
                            ...Object.getOwnPropertyNames(value)
                        ])].filter((key) => key !== 'constructor').slice(0, 24);
                    } catch (_) { keys = []; }
                }
                return {
                    kind: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
                    keys,
                    strings,
                    hasToken: Object.values(strings).some(looksLikeToken)
                };
            };

            const exports = Object.entries(mod);
            const functionExports = exports.filter(([, value]) => typeof value === 'function');
            const describeExports = functionExports.map(([name, fn]) => ({
                name,
                arity: fn.length,
                source: String(fn).slice(0, 300)
            }));
            const candidates = [];
            const pushCandidate = (fn) => {
                if (typeof fn === 'function' && !candidates.includes(fn)) candidates.push(fn);
            };
            pushCandidate(mod.i);
            pushCandidate(mod.default);
            for (const [name, fn] of functionExports) {
                if (/sentinel|checkout|requirement|token/i.test(name) || /chatgpt_checkout|sentinel/i.test(String(fn))) {
                    pushCandidate(fn);
                }
            }
            for (const [, fn] of functionExports) pushCandidate(fn);

            const variants = [
                {
                    flow,
                    deviceId,
                    device_id: deviceId,
                    allowPreparedOnly: false,
                    publishForceLogin: false,
                    captureSessionObserver: true,
                    requestSignal: new AbortController().signal
                },
                { flow },
                { flow, forceRefresh: true },
                flow,
                {}
            ];
            const attempts = [];
            const strings = {};
            let resolved = false;
            for (let index = 0; index < candidates.length && index < 4 && !resolved && remaining() > 1000; index += 1) {
                for (const variant of variants) {
                    if (remaining() <= 800) break;
                    const callArgs = typeof variant === 'string' ? variant : { ...variant };
                    const attempt = { index, args: typeof variant === 'string' ? 'flow-string' : Object.keys(variant).join(',') };
                    try {
                        const callTimeout = attempts.length === 0 ? 20000 : 6000;
                        const value = await withTimeout(Promise.resolve(candidates[index](callArgs)), callTimeout);
                        const described = describeReturn(value);
                        attempt.ok = true;
                        attempt.kind = described.kind;
                        attempt.keys = described.keys;
                        attempt.stringKeys = Object.keys(described.strings).slice(0, 12);
                        Object.assign(strings, described.strings);
                        if (described.hasToken) resolved = true;
                    } catch (error) {
                        attempt.ok = false;
                        attempt.error = String(error?.message || error);
                    }
                    attempts.push(attempt);
                    if (resolved) break;
                }
            }

            return {
                ok: true,
                assetUrls,
                discovery,
                deviceId,
                timedOut: !resolved && remaining() <= 800,
                exportNames: exports.map(([name, value]) => `${name}:${typeof value}`).slice(0, 20),
                functionExports: describeExports.slice(0, 4),
                attempts,
                returnKeys: Object.keys(strings),
                strings
            };
        }, { fallbackDeviceId, flow });

        if (!result?.ok) {
            return { token: '', headers: {}, error: result?.error || 'sentinel 获取失败', diagnostics: result || {} };
        }
        const normalized = normalizeSentinelResult(result.strings || {});
        return {
            token: normalizeSentinelToken(normalized.token, { deviceId: result.deviceId || fallbackDeviceId, flow }),
            headers: normalized.headers,
            error: result.timedOut && !normalized.token ? 'Sentinel 模块调用超时' : '',
            diagnostics: {
                assetUrls: result.assetUrls || [],
                discovery: result.discovery || {},
                exportNames: result.exportNames || [],
                functionExports: result.functionExports || [],
                attempts: result.attempts || [],
                returnKeys: result.returnKeys || []
            }
        };
    } catch (error) {
        return { token: '', headers: {}, error: String(error?.message || error), diagnostics: {} };
    }
}

async function withTimeout(promise, timeoutMs, fallback) {
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(fallback), timeoutMs);
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function watchCheckoutBrowserHeaders(page) {
    const existing = checkoutHeaderCache.get(page);
    if (existing) return existing;

    const captured = { headers: {}, sentinelToken: '', sentinelPayloadKeys: [], sentinelResponsePaths: [], sentinelResponseDetails: [], updatedAt: 0 };
    const onRequest = (request) => {
        const url = request.url();
        if (!/^https:\/\/chatgpt\.com\//i.test(url)) return;
        const headers = request.headers();
        for (const [name, value] of Object.entries(headers)) {
            const lower = name.toLowerCase();
            if (lower === 'openai-sentinel-token' && value) {
                captured.sentinelToken = String(value);
                captured.updatedAt = Date.now();
            }
            if (['chatgpt-account-id', 'oai-did', 'oai-device-id', 'oai-language', 'openai-sentinel-token'].includes(lower)) {
                captured.headers[lower] = String(value || '');
            }
        }
    };
    const onResponse = (response) => {
        const responseUrl = response.url();
        if (!/\/backend-api\/sentinel\//i.test(responseUrl)) return;
        const responsePath = responseUrl.replace('https://chatgpt.com', '').split('?')[0];
        if (!captured.sentinelResponsePaths.includes(responsePath)) {
            captured.sentinelResponsePaths.push(responsePath);
        }
        response.text().then((text) => {
            let data = null;
            try { data = JSON.parse(text); } catch (_) { data = null; }
            const detail = {
                path: responsePath,
                status: response.status(),
                contentType: String(response.headers()['content-type'] || '').slice(0, 60),
                length: text.length,
                keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 30) : []
            };
            captured.sentinelResponseDetails = [...(captured.sentinelResponseDetails || []), detail].slice(-10);
            if (data && typeof data === 'object') {
                captured.sentinelPayloadKeys = detail.keys;
            }
            const token = extractSentinelHeaderValue(data || text);
            if (token) {
                captured.sentinelToken = token;
                captured.updatedAt = Date.now();
            }
        }).catch(() => {});
    };
    page.on('request', onRequest);
    page.on('response', onResponse);
    captured.dispose = () => {
        try { page.off('request', onRequest); } catch (_) { /* ignore */ }
        try { page.off('response', onResponse); } catch (_) { /* ignore */ }
        checkoutHeaderCache.delete(page);
    };
    checkoutHeaderCache.set(page, captured);
    return captured;
}

async function readBrowserClientHints(page) {
    try {
        return await page.evaluate(async () => {
            const base = {
                userAgent: navigator.userAgent,
                language: navigator.language || 'en-US'
            };
            const uaData = navigator.userAgentData;
            if (!uaData) return base;
            const highEntropy = await uaData.getHighEntropyValues([
                'architecture', 'bitness', 'brands', 'fullVersionList', 'mobile', 'model', 'platform', 'platformVersion'
            ]).catch(() => ({}));
            return {
                ...base,
                brands: highEntropy.brands || uaData.brands || [],
                fullVersionList: highEntropy.fullVersionList || [],
                mobile: highEntropy.mobile != null ? highEntropy.mobile : uaData.mobile,
                platform: highEntropy.platform || uaData.platform || '',
                platformVersion: highEntropy.platformVersion || '',
                architecture: highEntropy.architecture || '',
                bitness: highEntropy.bitness || '',
                model: highEntropy.model || ''
            };
        });
    } catch (_) {
        return {};
    }
}

async function collectCheckoutBrowserContext(page, { accessToken, sessionData = null } = {}) {
    const captured = watchCheckoutBrowserHeaders(page);
    const hints = await readBrowserClientHints(page);
    const cookies = await page.context().cookies(CHATGPT_ORIGIN).catch(() => []);
    const cookieDeviceId = cookies.find((cookie) => /^(oai-did|oai-device-id|__oai-did)$/i.test(cookie.name))?.value || '';
    const deviceId = String(
        captured.headers['oai-device-id']
        || captured.headers['oai-did']
        || cookieDeviceId
        || sessionData?.deviceId
        || sessionData?.device_id
        || sessionData?.['oai-did']
        || ''
    ).trim();
    let sentinelToken = captured.sentinelToken || await readSentinelFromPageStorage(page);
    let sentinelHeaders = {};
    let sentinelAcquireError = '';
    let sentinelDiagnostics = {};
    if (sentinelToken) {
        sentinelToken = normalizeSentinelToken(sentinelToken, { deviceId, flow: 'chatgpt_checkout' });
    }
    if (!sentinelToken) {
        const acquired = await withTimeout(
            acquireSentinelFromPage(page, { deviceId, flow: 'chatgpt_checkout' }),
            35000,
            { token: '', headers: {}, error: '等待 Sentinel 模块超时', diagnostics: {} }
        );
        sentinelToken = normalizeSentinelToken(acquired.token || '', { deviceId, flow: 'chatgpt_checkout' });
        sentinelHeaders = acquired.headers || {};
        sentinelAcquireError = acquired.error || '';
        sentinelDiagnostics = acquired.diagnostics || {};
    }
    return {
        accountId: captured.headers['chatgpt-account-id'] || resolveAccountId(accessToken, sessionData),
        deviceId,
        language: captured.headers['oai-language'] || hints.language || '',
        sentinelToken,
        sentinelHeaders,
        sentinelAcquireError,
        sentinelDiagnostics,
        sentinelPayloadKeys: captured.sentinelPayloadKeys || [],
        sentinelResponsePaths: captured.sentinelResponsePaths || [],
        sentinelResponseDetails: captured.sentinelResponseDetails || [],
        userAgent: hints.userAgent || '',
        clientHints: hints
    };
}

function formatApiErrorDetail(detail, fallback = '') {
    if (detail == null || detail === '') return fallback;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
        return detail.map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item))).join('; ');
    }
    if (typeof detail === 'object') {
        if (detail.message) return String(detail.message);
        if (detail.msg) return String(detail.msg);
        return JSON.stringify(detail);
    }
    return String(detail);
}

function parseCheckoutApiResponse(status, bodyText) {
    let data = {};
    try {
        data = bodyText ? JSON.parse(bodyText) : {};
    } catch (_) {
        data = {};
    }

    if (status !== 200) {
        const detail = formatApiErrorDetail(
            data.detail ?? data.message ?? data.error,
            bodyText.slice(0, 500) || `HTTP ${status}`
        );
        return { ok: false, status, data, error: detail };
    }

    const service = new ChatGPTService(null, '');
    const resolved = service.resolveCheckoutUrl(data);
    if (!resolved.checkoutUrl) {
        return {
            ok: false,
            status,
            data,
            error: `API 未返回 checkout_session_id 或 url: ${JSON.stringify(data).slice(0, 300)}`
        };
    }

    return { ok: true, status, data, ...resolved };
}

async function createCheckoutSessionViaPage(page, {
    accessToken,
    planType = 'plus',
    country,
    currency,
    planNameOverride
}) {
    const token = String(accessToken || '').trim();
    if (!token) {
        return { sessionId: null, checkoutUrl: null, error: '缺少 AccessToken' };
    }

    const planName = String(planNameOverride || store.resolvePlanName(planType)).trim();
    const promoCampaign = resolvePromoCampaign(planType);
    const payload = buildCheckoutPayload(planName, country, currency, { planType, promoCampaign });

    try {
        if (!/^https:\/\/chatgpt\.com/i.test(page.url())) {
            await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        }

        const browserContext = await collectCheckoutBrowserContext(page, { accessToken: token });
        const headers = filterBrowserFetchHeaders(buildCheckoutRequestHeaders(token, browserContext, { planType, promoCampaign }));
        console.log(`[ChatGPT] 页面内调用 Checkout API: plan_name=${planName}, country=${country}, currency=${currency}, checkout_ui_mode=${payload.checkout_ui_mode}`);
        const result = await page.evaluate(async ({ url, body, requestHeaders }) => {
            const response = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: requestHeaders,
                body: JSON.stringify(body)
            });
            const text = await response.text();
            return { status: response.status, text };
        }, {
            url: CHECKOUT_ENDPOINT,
            body: payload,
            requestHeaders: headers
        });

        const parsed = parseCheckoutApiResponse(result.status, result.text);
        if (!parsed.ok) {
            const detail = redactSensitiveText(parsed.error);
            console.error(`[-] 页面内订单创建失败 (Status: ${parsed.status})`);
            console.error(`    响应: ${detail}`);
            return { sessionId: null, checkoutUrl: null, error: detail };
        }

        console.log(`✅ 页面内订单创建成功 (session: ${parsed.sessionId ? parsed.sessionId.slice(0, 24) + '...' : 'unknown'})`);
        if (parsed.checkoutUrl) {
            console.log(`    支付链接: ${parsed.checkoutUrl.slice(0, 120)}...`);
        }
        return { sessionId: parsed.sessionId, checkoutUrl: parsed.checkoutUrl };
    } catch (error) {
        const safeMessage = redactSensitiveText(error.message);
        console.error('[-] 页面内创建 Checkout Session 异常:', safeMessage);
        return { sessionId: null, checkoutUrl: null, error: safeMessage };
    }
}

/**
 * 使用 axios 直接调用 Checkout API（供后台调试 / 无 Playwright 场景）
 */
async function createHostedCheckoutLink({ accessToken, planType = 'plus', planName, country, currency }) {
    const token = String(accessToken || '').trim();
    if (!token) {
        return { success: false, error: '缺少 AccessToken' };
    }

    const region = String(country || 'PH').toUpperCase();
    const billingCurrency = String(currency || getRegionConfig(region)?.currency || 'PHP').toUpperCase();
    const planNameResolved = String(planName || store.resolvePlanName(planType)).trim();
    const promoCampaign = resolvePromoCampaign(planType);
    const payload = buildCheckoutPayload(planNameResolved, region, billingCurrency, { planType, promoCampaign });
    const headers = buildCheckoutRequestHeaders(token, {
        accountId: resolveAccountId(token)
    }, { planType, promoCampaign });

    const response = await axios.post(
        CHECKOUT_ENDPOINT,
        payload,
        {
            headers,
            validateStatus: () => true,
            timeout: 30000
        }
    );

    const parsed = parseCheckoutApiResponse(response.status, JSON.stringify(response.data ?? {}));
    const base = {
        plan_type: planType,
        plan_name: planNameResolved,
        country: region,
        currency: billingCurrency,
        request: payload,
        response: parsed.data,
        http_status: parsed.status
    };

    if (!parsed.ok) {
        return { success: false, ...base, error: parsed.error };
    }

    return {
        success: true,
        ...base,
        url: parsed.checkoutUrl,
        session_id: parsed.sessionId
    };
}

/**
 * ChatGPT 订阅服务 — Stripe 信用卡直付版本
 *
 * 职责：
 * 1. 根据 plan_type 解析 plan_name（通过 store.resolvePlanName）
 * 2. 创建 Stripe Checkout Session（调用 OpenAI 后端 API）
 * 3. 协调卡池管理、免税地址、Stripe 表单自动化完成支付
 * 4. 委托 payment-retry.js 处理支付重试与卡片轮换逻辑
 * 5. 记录账单信息（成功/失败）
 */
class ChatGPTService {
    /**
     * @param {object} request - Playwright context.request 实例
     * @param {string} token - OpenAI Bearer Token
     */
    constructor(request, token, browserContext = {}) {
        this.request = request;
        this.token = token;
        this.browserContext = browserContext || {};
    }

    /**
     * 从 checkout API 响应解析支付链接
     * custom 模式：用 checkout_session_id 拼 https://chatgpt.com/checkout/openai_llc/{id}
     * hosted 模式：优先使用 API 返回的 url
     */
    resolveCheckoutUrl(data) {
        if (!data || typeof data !== 'object') {
            return { sessionId: null, checkoutUrl: null };
        }

        const jsonText = JSON.stringify(data);
        const sessionId = data.checkout_session_id
            || data.session_id
            || jsonText.match(/cs_(?:live|test)_[A-Za-z0-9]+/)?.[0]
            || null;

        const apiUrl = String(data.url || '').trim();
        if (apiUrl.startsWith('http')) {
            return { sessionId, checkoutUrl: apiUrl };
        }

        if (sessionId) {
            return {
                sessionId,
                checkoutUrl: `https://chatgpt.com/checkout/openai_llc/${sessionId}`
            };
        }

        return { sessionId, checkoutUrl: null };
    }

    /**
     * 创建 Stripe Checkout Session，根据 plan_type 选择对应 plan_name
     * @param {string} planType - 'plus' | 'pro_5x' | 'pro_20x'
     * @param {string} country - ISO 3166-1 alpha-2 国家代码
     * @param {string} currency - 币种代码 (USD/SGD/MYR)
     * @param {string} [planNameOverride] - 可选，覆盖默认 plan_name
     * @returns {Promise<{ sessionId: string|null, checkoutUrl: string|null, error?: string }>}
     */
    async createCheckoutSession(planType, country, currency, planNameOverride) {
        try {
            const planName = String(planNameOverride || store.resolvePlanName(planType)).trim();
            const promoCampaign = resolvePromoCampaign(planType);
            const payload = buildCheckoutPayload(planName, country, currency, { planType, promoCampaign });
            const headers = buildCheckoutRequestHeaders(this.token, this.browserContext, { planType, promoCampaign });
            console.log(`[ChatGPT] 创建 Checkout Session: plan_name=${planName}, country=${country}, currency=${currency}, checkout_ui_mode=${payload.checkout_ui_mode}`);
            console.log(`[ChatGPT] 请求上下文: account=${Boolean(headers['ChatGPT-Account-Id'])}, device=${Boolean(headers['oai-did'])}, sentinel=${Boolean(headers[SENTINEL_HEADER])}, language=${headers['OAI-Language'] || '-'}`);
            if (!headers[SENTINEL_HEADER]) {
                const sentinelKeys = Array.isArray(this.browserContext.sentinelPayloadKeys) && this.browserContext.sentinelPayloadKeys.length
                    ? this.browserContext.sentinelPayloadKeys.join(',')
                    : '-';
                const sentinelPaths = Array.isArray(this.browserContext.sentinelResponsePaths) && this.browserContext.sentinelResponsePaths.length
                    ? this.browserContext.sentinelResponsePaths.join(',')
                    : '-';
                console.warn(`[Warn] 未捕获 OpenAI-Sentinel-Token；sentinel 接口=${sentinelPaths} 字段=${sentinelKeys} 模块获取=${this.browserContext.sentinelAcquireError || '未执行'}`);
                const diagnostics = this.browserContext.sentinelDiagnostics || {};
                const responses = this.browserContext.sentinelResponseDetails || [];
                if (responses.length) {
                    const summary = responses.map((item) => `${item.path}:${item.status}:${item.length}:${(item.keys || []).join('/')}`);
                    console.warn(`[ChatGPT] sentinel 响应: ${summary.join(' ; ')}`);
                }
                if (Array.isArray(diagnostics.assetUrls) && diagnostics.assetUrls.length) {
                    console.warn(`[ChatGPT] sentinel 资源: ${diagnostics.assetUrls.join(' | ')}`);
                }
                if (Array.isArray(diagnostics.exportNames) && diagnostics.exportNames.length) {
                    console.warn(`[ChatGPT] sentinel 导出: ${diagnostics.exportNames.join(', ')}`);
                }
                if (diagnostics.discovery) {
                    const discovery = diagnostics.discovery;
                    console.warn(`[ChatGPT] sentinel 发现: loaded=${(discovery.loadedAssets || []).length} scanned=${discovery.scannedChunks || 0} fetched=${discovery.fetchedChunks || 0} hits=${(discovery.scannedHits || []).length}`);
                }
                if (Array.isArray(diagnostics.functionExports) && diagnostics.functionExports.length) {
                    const functions = diagnostics.functionExports
                        .slice(0, 2)
                        .map((item) => `${item.name}/${item.arity}: ${String(item.source || '').slice(0, 160)}`);
                    console.warn(`[ChatGPT] sentinel 函数: ${functions.join(' || ')}`);
                }
                if (Array.isArray(diagnostics.attempts) && diagnostics.attempts.length) {
                    const attempts = diagnostics.attempts.map((item) => `${item.index}:${item.args}:${item.ok ? `${item.kind}|${(item.keys || []).join('/')}` : item.error}`);
                    console.warn(`[ChatGPT] sentinel 调用: ${attempts.join(' ; ')}`);
                }
            }

            const response = await this.request.post(CHECKOUT_ENDPOINT, {
                headers,
                data: payload
            });

            const bodyText = await response.text().catch(() => "");
            const parsed = parseCheckoutApiResponse(response.status(), bodyText);

            if (!parsed.ok) {
                const detail = parsed.error;
                console.error(`[-] 订单创建失败 (Status: ${parsed.status})`);
                console.error(`    响应: ${redactSensitiveText(detail)}`);
                if (String(detail).includes('not_eligible') || String(detail).includes('Offer not found')) {
                    console.error("❌ [提示] 该账号不符合当前套餐/地区订阅条件");
                } else if (String(detail).includes('permission') || String(detail).includes('already_subscribed')) {
                    console.error("❌ [提示] 该账号可能已订阅或无权重复开通");
                }
                return { sessionId: null, checkoutUrl: null, error: detail };
            }

            console.log(`✅ 订单创建成功 (session: ${parsed.sessionId ? parsed.sessionId.slice(0, 24) + '...' : 'unknown'})`);
            if (parsed.checkoutUrl) {
                console.log(`    支付链接: ${parsed.checkoutUrl.slice(0, 120)}...`);
            }
            return { sessionId: parsed.sessionId, checkoutUrl: parsed.checkoutUrl };
        } catch (e) {
            const safeMessage = redactSensitiveText(e.message);
            console.error("[-] 创建 Checkout Session 异常:", safeMessage);
            return { sessionId: null, checkoutUrl: null, error: safeMessage };
        }
    }

    /**
     * @deprecated 请使用 createCheckoutSession 返回的 checkoutUrl
     */
    buildCheckoutUrl(checkoutSessionId) {
        if (!checkoutSessionId) {
            return null;
        }
        return `https://pay.openai.com/c/pay/${checkoutSessionId}`;
    }

    /**
     * 完整的 Stripe 信用卡支付流程
     *
     * 委托 payment-retry.js 处理卡片轮换和重试逻辑：
     * - 从卡池分配卡片（store.reserveCard）
     * - 填写 Stripe 表单（completeStripeCardPayment）
     * - 表单校验失败 → 同卡重试最多 2 次
     * - Stripe 拒绝 → 标记卡片报废，换卡
     * - 连续 3 张卡失败 → 终止，status='payment_failed'
     * - 记录账单（store.createBillingRecord）
     *
     * @param {import('playwright').Page} page - Playwright Page 实例
     * @param {object} options
     * @param {string} options.planType - 'plus' | 'pro_5x' | 'pro_20x'
     * @param {string} [options.cdkCode] - 关联的 CDK 码
     * @param {string} [options.email] - 关联的邮箱
     * @returns {Promise<{ success: boolean, error?: string, status?: string }>}
     */
    async processStripePayment(page, options = {}) {
        const { planType = 'plus', cdkCode = null, email = null } = options;

        console.log(`[ChatGPT] 启动 Stripe 信用卡支付流程 (plan: ${planType})`);

        // 委托 payment-retry.js 处理完整的支付重试逻辑
        // 包含：地区配置获取、免税地址选取、卡池分配、表单填写、重试换卡、账单记录
        const result = await executePaymentWithRetry(page, { planType, cdkCode, email });

        if (result.success) {
            console.log(`✅ [ChatGPT] 支付成功！`);
        } else {
            console.error(`❌ [ChatGPT] 支付失败: ${result.error}`);
        }

        return result;
    }

    /**
     * 根据 plan_type 和 currency 获取预估金额
     * 用于外部调用方查询参考价格
     * @param {string} planType - 'plus' | 'pro_5x' | 'pro_20x'
     * @param {string} currency - 币种代码
     * @returns {number} 预估金额
     */
    getPlanAmount(planType, currency) {
        // 基础美元定价
        const baseAmounts = {
            plus: 20.00,
            pro_5x: 100.00,
            pro_20x: 200.00
        };
        const amount = baseAmounts[planType] || baseAmounts.plus;

        // 非 USD 币种的简单转换（实际金额由 Stripe 返回，这里仅用于记录参考）
        if (currency === 'SGD') return Math.round(amount * 1.35 * 100) / 100;
        if (currency === 'MYR') return Math.round(amount * 4.50 * 100) / 100;
        if (currency === 'PHP') return Math.round(amount * 56 * 100) / 100;
        return amount;
    }
}

/**
 * 端到端 Stripe 信用卡支付入口函数
 *
 * 用户流程：CDK → GPT session token → 自动支付
 * 此函数封装完整流程：创建 Checkout Session → 导航到 Stripe 页面 → 执行支付（含重试换卡）
 *
 * @param {object} params
 * @param {import('playwright').Page} params.page - Playwright Page 实例
 * @param {string} params.accessToken - OpenAI Bearer Token（用于创建 checkout session）
 * @param {string} params.planType - 'plus' | 'pro_5x' | 'pro_20x'
 * @param {string} [params.cdkCode] - 关联的 CDK 码
 * @param {string} [params.email] - 关联的邮箱
 * @param {function} [params.onProgress] - 进度回调 (message: string) => void
 * @returns {Promise<{ success: boolean, error?: string, sessionId?: string }>}
 */
async function activateSubscription({ page, accessToken, planType, cdkCode, email, onProgress }) {
    const notify = typeof onProgress === 'function' ? onProgress : () => {};

    // Step 1: Resolve billing region and currency
    const region = await store.getPaymentRegion();
    const regionConfig = getRegionConfig(region);
    if (!regionConfig) {
        return { success: false, error: `不支持的支付地区: ${region}` };
    }
    const { currency } = regionConfig;
    const country = region;

    notify(`地区: ${region}, 币种: ${currency}, 套餐: ${planType}`);

    // Step 2: Create Checkout Session via OpenAI API
    notify('正在创建 Stripe Checkout Session...');
    const browserContext = await collectCheckoutBrowserContext(page, { accessToken });
    const gpt = new ChatGPTService(page.context().request, accessToken, browserContext);
    const checkout = await gpt.createCheckoutSession(planType, country, currency);

    if (!checkout.checkoutUrl) {
        return { success: false, error: '无法获取支付链接 (createCheckoutSession 失败)' };
    }

    // Step 3: Navigate to Stripe Checkout URL
    const checkoutUrl = checkout.checkoutUrl;
    notify('正在打开 Stripe Checkout 页面...');

    await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    notify('Checkout 页面已打开，开始信用卡支付...');

    // Step 4: Execute payment with card pool retry logic
    const result = await executePaymentWithRetry(page, { planType, cdkCode, email });

    if (result.success) {
        notify('支付成功！');
        return { success: true, sessionId: checkout.sessionId };
    }

    return { success: false, error: result.error, sessionId: checkout.sessionId };
}

/**
 * 判断 Checkout 页面是否已正常加载（避免 body 里 incidental "404" 误报）
 */
async function assertCheckoutPageReady(page) {
    const { isCloudflareWallPage, isCheckoutPaymentReady } = require('./human-verification');
    const currentUrl = page.url();
    const pageText = String(await page.textContent('body', { timeout: 8000 }).catch(() => '') || '');
    const title = String(await page.title().catch(() => '') || '');

    if (await isCloudflareWallPage(page)) {
        throw new Error('Checkout 页面仍被 Cloudflare 人机验证拦截');
    }

    if (await isCheckoutPaymentReady(page)) {
        return currentUrl;
    }

    const checkoutReady = /Configure your plan|Subscribe|Plus plan|Pro plan|Due today|Card number|Expiration date|Security code|Monthly subscription/i.test(pageText);

    if (checkoutReady) {
        return currentUrl;
    }

    if (/Page not found|could not be found|Something went wrong|contact the merchant/i.test(pageText)) {
        throw new Error(`支付链接无效: ${currentUrl.slice(0, 120)}`);
    }

    if (/accounts\.google\.com|auth\.openai\.com/i.test(currentUrl)) {
        throw new Error(`Checkout 跳转到登录页: ${currentUrl.slice(0, 80)}`);
    }

    if (/^404(\s|$)/.test(title.trim())) {
        throw new Error(`支付链接无效 (404): ${currentUrl.slice(0, 120)}`);
    }

    throw new Error(`无法确认 Checkout 支付表单已加载: ${currentUrl.slice(0, 120)}`);
}

/**
 * 通过 API 注入 billing_details 创建 Checkout，并打开 chatgpt.com/checkout
 */
async function openApiCheckout(page, { accessToken, planType, country, currency, planNameOverride, verifyPage = true, sessionData = null }) {
    const { assertChatGptLoggedIn } = require('./session-auth');
    const token = String(accessToken || '').trim();
    if (!token) {
        throw new Error('缺少 AccessToken，无法调用 Checkout API');
    }

    const region = String(country || 'PH').toUpperCase();
    const billingCurrency = String(currency || getRegionConfig(region)?.currency || 'PHP').toUpperCase();
    console.log(`🧭 [步骤] 正在通过 API 创建 Checkout (country=${region}, currency=${billingCurrency}, plan=${planType})...`);
    await warmSentinelModule(page, { planType });

    let browserContext = await collectCheckoutBrowserContext(page, { accessToken: token, sessionData });
    if (!browserContext.sentinelToken) {
        await page.waitForTimeout(1000).catch(() => {});
        const captured = watchCheckoutBrowserHeaders(page);
        const lateToken = captured.sentinelToken || await readSentinelFromPageStorage(page);
        if (lateToken) {
            browserContext = {
                ...browserContext,
                sentinelToken: normalizeSentinelToken(lateToken, { deviceId: browserContext.deviceId, flow: 'chatgpt_checkout' })
            };
        }
    }
    const gpt = new ChatGPTService(page.context().request, token, browserContext);
    const checkout = await gpt.createCheckoutSession(planType, region, billingCurrency, planNameOverride);
    if (!checkout.checkoutUrl) {
        throw new Error(`API 创建 Checkout 失败: ${checkout.error || '未返回 data.url'}`);
    }

    const url = checkout.checkoutUrl;
    console.log(`🔗 [步骤] 正在打开支付链接: ${url.slice(0, 120)}...`);

    if (!verifyPage) {
        console.log('✅ [步骤] Checkout Session 已创建（跳过页面打开验证）');
        return { checkoutUrl: url, sessionId: checkout.sessionId };
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const { hasVisibleLoginChrome, isCheckoutLoginGate, buildSessionNotLoggedInError } = require('./auth-page-detect');
    if (await isCheckoutLoginGate(page) || await hasVisibleLoginChrome(page)) {
        const title = await page.title().catch(() => '');
        console.error(`[Checkout] 打开后仍为未登录 UI url=${page.url().slice(0, 100)} title=${title}`);
        throw new Error(buildSessionNotLoggedInError('Checkout 支付页'));
    }

    const { clearHumanVerification, buildCaptchaRequiredError } = require('./human-verification');
    const captchaResult = await clearHumanVerification(page, {
        phase: 'checkout-open',
        maxWaitMs: Number(process.env.CAPTCHA_CLEAR_TIMEOUT_MS || 120000),
        maxBypassRounds: 6,
        requireCheckoutReady: true,
        checkoutReadyWaitMs: Number(process.env.CHECKOUT_READY_WAIT_MS || 60000)
    });
    if (!captchaResult.cleared) {
        const err = captchaResult.sessionRequired
            ? (captchaResult.message || buildSessionNotLoggedInError('Checkout 支付页'))
            : captchaResult.checkoutNotReady
                ? 'Checkout 支付表单未能加载，请检查网络或稍后重试'
                : buildCaptchaRequiredError();
        throw new Error(err);
    }

    const currentUrl = await assertCheckoutPageReady(page);

    await assertChatGptLoggedIn(page, 'Checkout');
    console.log(`✅ [步骤] Checkout 页面已打开: ${currentUrl.slice(0, 100)}...`);
    return { checkoutUrl: currentUrl, sessionId: checkout.sessionId };
}

module.exports = ChatGPTService;
module.exports.ChatGPTService = ChatGPTService;
module.exports.activateSubscription = activateSubscription;
module.exports.openApiCheckout = openApiCheckout;
module.exports.createHostedCheckoutLink = createHostedCheckoutLink;
module.exports.buildCheckoutPayload = buildCheckoutPayload;
module.exports.buildCheckoutRequestHeaders = buildCheckoutRequestHeaders;
module.exports.resolvePromoCampaign = resolvePromoCampaign;
module.exports.collectCheckoutBrowserContext = collectCheckoutBrowserContext;
module.exports.watchCheckoutBrowserHeaders = watchCheckoutBrowserHeaders;
module.exports.extractSentinelHeaderValue = extractSentinelHeaderValue;
module.exports.normalizeSentinelToken = normalizeSentinelToken;
module.exports.createCheckoutSessionViaPage = createCheckoutSessionViaPage;
module.exports.formatApiErrorDetail = formatApiErrorDetail;
