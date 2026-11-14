'use strict';

const { parseAutoCancelConfig, cancelAutoRenewWithRetry } = require('../auto-renew');

function quietLogger() {
    return { log: () => {}, warn: () => {} };
}

function createCancelStub(results = []) {
    const calls = [];
    const fn = async (...args) => {
        calls.push(args);
        const next = results.shift();
        return typeof next === 'function' ? next(...args) : next;
    };
    fn.calls = calls;
    return fn;
}

describe('auto cancel renew', () => {
    it('enables auto cancel by default and supports explicit disable', () => {
        expect(parseAutoCancelConfig({})).toEqual({
            enabled: true,
            initialDelayMs: 8000,
            intervalMs: 5000,
            maxAttempts: 6
        });
        expect(parseAutoCancelConfig({ AUTO_CANCEL_RENEW: '0' }).enabled).toBe(false);
        expect(parseAutoCancelConfig({
            AUTO_CANCEL_RENEW: '1',
            AUTO_CANCEL_RENEW_DELAY_MS: '0',
            AUTO_CANCEL_RENEW_INTERVAL_MS: '100',
            AUTO_CANCEL_RENEW_RETRIES: '99'
        })).toEqual({
            enabled: true,
            initialDelayMs: 0,
            intervalMs: 1000,
            maxAttempts: 20
        });
    });

    it('does nothing when disabled', async () => {
        const cancelFn = createCancelStub();
        const result = await cancelAutoRenewWithRetry({ accessToken: 'token', env: { AUTO_CANCEL_RENEW: '0' }, cancelFn, logger: quietLogger() });
        expect(result).toMatchObject({ ok: false, skipped: true, reason: 'disabled' });
        expect(cancelFn.calls.length).toBe(0);
    });

    it('returns success once auto renew is confirmed off', async () => {
        const cancelFn = createCancelStub([{
            ok: true,
            data: { autoRenewRaw: false, message: '已成功关闭自动续费' }
        }]);
        const result = await cancelAutoRenewWithRetry({
            accessToken: 'token',
            env: { AUTO_CANCEL_RENEW: '1', AUTO_CANCEL_RENEW_DELAY_MS: '0' },
            cancelFn,
            sleepFn: async () => {},
            logger: quietLogger()
        });
        expect(result).toMatchObject({ ok: true, verified: true, attempt: 1 });
        expect(cancelFn.calls.length).toBe(1);
    });

    it('retries while the subscription is not active yet', async () => {
        const cancelFn = createCancelStub([
            { ok: false, error: '账号当前无有效订阅，无需取消自动续费' },
            { ok: true, data: { autoRenewRaw: false } }
        ]);
        const result = await cancelAutoRenewWithRetry({
            accessToken: 'token',
            env: { AUTO_CANCEL_RENEW: '1', AUTO_CANCEL_RENEW_DELAY_MS: '0', AUTO_CANCEL_RENEW_RETRIES: '3' },
            cancelFn,
            sleepFn: async () => {},
            logger: quietLogger()
        });
        expect(result).toMatchObject({ ok: true, verified: true, attempt: 2 });
        expect(cancelFn.calls.length).toBe(2);
    });

    it('returns the last error after all attempts', async () => {
        const cancelFn = createCancelStub([
            { ok: false, error: '临时失败' },
            { ok: false, error: '临时失败' }
        ]);
        const result = await cancelAutoRenewWithRetry({
            accessToken: 'token',
            env: { AUTO_CANCEL_RENEW: '1', AUTO_CANCEL_RENEW_DELAY_MS: '0', AUTO_CANCEL_RENEW_RETRIES: '2' },
            cancelFn,
            sleepFn: async () => {},
            logger: quietLogger()
        });
        expect(result).toMatchObject({ ok: false, attempts: 2, error: '临时失败' });
        expect(cancelFn.calls.length).toBe(2);
    });
});
