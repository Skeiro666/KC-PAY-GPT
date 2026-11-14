'use strict';

const { cancelAutoRenew } = require('./subscription-check');

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function readInteger(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function parseAutoCancelConfig(env = process.env) {
    const configured = env.AUTO_CANCEL_RENEW;
    const enabled = configured == null || String(configured).trim() === ''
        ? true
        : TRUE_VALUES.has(String(configured).trim().toLowerCase());
    return {
        enabled,
        initialDelayMs: readInteger(env.AUTO_CANCEL_RENEW_DELAY_MS, 8000, 0, 120000),
        intervalMs: readInteger(env.AUTO_CANCEL_RENEW_INTERVAL_MS, 5000, 1000, 60000),
        maxAttempts: readInteger(env.AUTO_CANCEL_RENEW_RETRIES, 6, 1, 20)
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cancelAutoRenewWithRetry(options = {}) {
    const env = options.env || process.env;
    const config = parseAutoCancelConfig(env);
    const logger = options.logger || console;
    const cancelFn = options.cancelFn || cancelAutoRenew;
    const sleepFn = options.sleepFn || sleep;
    const token = String(options.accessToken || '').trim();
    const email = String(options.email || '').trim();

    if (!config.enabled) {
        return { ok: false, skipped: true, reason: 'disabled' };
    }
    if (!token) {
        return { ok: false, skipped: true, reason: 'missing_access_token' };
    }

    if (config.initialDelayMs > 0) {
        logger.log(`[续费] 等待 ${Math.round(config.initialDelayMs / 1000)} 秒，让新订阅生效后自动关闭续费...`);
        await sleepFn(config.initialDelayMs);
    }

    let lastError = '';
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
        let result;
        try {
            result = await cancelFn(token, { email });
        } catch (error) {
            result = { ok: false, error: error?.message || String(error) };
        }

        if (result?.ok) {
            const data = result.data || {};
            if (data.autoRenewRaw === false || data.alreadyCancelled === true) {
                logger.log('[续费] 自动续费已关闭，本周期结束后不会自动扣费');
                return { ok: true, attempt, data, verified: data.autoRenewRaw === false };
            }
            lastError = data.message || '取消请求已提交，但自动续费状态尚未确认';
        } else {
            lastError = result?.error || '取消自动续费失败';
        }

        if (attempt < config.maxAttempts) {
            logger.warn(`[续费] 第 ${attempt}/${config.maxAttempts} 次未完成：${lastError}；稍后重试...`);
            await sleepFn(config.intervalMs);
        }
    }

    logger.warn(`[续费] 自动取消续费失败：${lastError}。请到后台「续费管理」手动取消`);
    return { ok: false, attempts: config.maxAttempts, error: lastError };
}

module.exports = {
    parseAutoCancelConfig,
    cancelAutoRenewWithRetry
};
