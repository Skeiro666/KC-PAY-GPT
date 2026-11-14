const fs = require('fs');
const vm = require('vm');
const path = require('path');
function source(name) { return fs.readFileSync(path.join(__dirname, '..', name), 'utf8'); }
function extract(text, start, end, env = {}) {
    return vm.runInNewContext(text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start))) + '\n' + start.match(/function (\w+)/)[1], env);
}
function handler(store, extra = {}) {
    return extract(source('server.js'), 'async function handleActivationRequest', "app.post('/api/run-process'", {
        store, console: { log() {} }, pendingActivationCdks: new Set(), activeForegroundJobs: new Set(),
        parseSessionJson: () => null, normalizeSessionToken: x => x, getClientIp: () => '',
        validateAccessToken: () => ({ valid: true }), ensureStoreReady: async () => {},
        ...extra
    });
}
function response() { return { code: 200, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } }; }
const request = { body: { token: 'test', cdk: 'CDK' }, path: '/api/run-process' };
describe('task lifecycle regressions', () => {
    it('does not unlock another task when validation lookup throws', async () => {
        const unlock = vi.fn();
        const run = handler({ getMaintenanceModeState: async () => { throw Error('db unavailable'); }, markCdkUnused: unlock });
        const res = response(); await run(request, res);
        expect(res.code).toBe(500); expect(unlock).not.toHaveBeenCalled();
    });
    it('rejects overlapping requests for the same CDK before database awaits', async () => {
        let resume; const gate = new Promise(r => { resume = r; });
        const run = handler({ getMaintenanceModeState: async () => { await gate; return { enabled: true }; }, markCdkUnused: vi.fn() });
        const first = run(request, response());
        const res = response(); await run(request, res);
        expect(res.code).toBe(409); resume(); await first;
        const after = response(); await run(request, after); expect(after.code).toBe(503);
    });
    it('closes the context even when recording is disabled', async () => {
        const close = vi.fn().mockResolvedValue();
        const fn = extract(source('index.js'), 'async function finalizeVideo', '\nfunction ', { RECORD_VIDEO: false });
        await fn({ close }, null); expect(close).toHaveBeenCalledOnce();
    });
    it('never leases a slot twice while its health probe is pending', async () => {
        let resume; const gate = new Promise(r => { resume = r; });
        const slot = { slotId: 1, inUse: false, uses: 0, port: 123, cdpUrl: 'test' };
        const queue = [];
        const acquire = extract(source('browser-pool.js'), 'async function acquireSlot', 'async function withBrowserSlot', {
            initialized: true, slots: [slot], waitQueue: queue, isSlotAlive: async () => { await gate; return true; },
            setTimeout: () => 1, ACQUIRE_TIMEOUT_MS: 1000, console
        });
        const first = acquire('a'); const second = acquire('b');
        resume(); await first;
        expect(queue).toHaveLength(1);
        queue[0].resolve(null); await second;
    });
    it.each(['manual', 'success', 'throw'])('preserves the CDK after worker result %s', async (outcome) => {
        let done; const finished = new Promise(r => { done = r; });
        const unlock = vi.fn(); const updates = vi.fn().mockResolvedValue();
        const run = extract(source('server.js'), 'function spawnActivationWorker', 'async function handleActivationRequest', {
            path, __dirname, process: { env: {} }, console, MAX_PROCESS_ATTEMPTS: 1,
            store: {
                getActiveProxy: async () => '', getHcaptchaConfig: async () => ({}),
                updateTaskLog: updates, markCdkUnused: unlock,
                resetCdkFailure: async () => {}, getMaintenanceModeState: async () => ({ enabled: false })
            },
            spawnWorkerWithBrowser: async () => {
                if (outcome === 'throw') throw Error('worker disconnected');
                return { output: '', analysis: { status: outcome, shouldRetry: false } };
            },
            logTask() {}, extractEmailFromSession: () => '', normalizeTaskProgress: x => x,
            broadcastToTask() {}, buildHcaptchaEnvFromConfig: () => ({ env: {} }),
            extractCardLast4FromOutput: () => '', getCheckoutProgress: () => 60,
            extractTaskMediaFromOutput: () => ({ screenshots: [], videos: [] }),
            isCardPoolExhaustedIssue: () => false, isNoActivationEligibilityMessage: () => false,
            notifyTaskOutcome() {}, releaseForegroundSlot: () => done(), getTotalActiveJobs: () => 0
        });
        run({ task: { jobKey: 'test' }, cdk: 'CDK', cdkDetails: {}, sessionRaw: '' });
        await finished;
        expect(unlock).not.toHaveBeenCalled();
        expect(updates.mock.calls.some(([, payload]) => payload.status === (outcome === 'success' ? 'success' : 'manual'))).toBe(true);
    });
    it('reserves capacity while a request awaits database validation', async () => {
        let resume; const gate = new Promise(r => { resume = r; });
        const active = new Set();
        const run = handler({
            getMaintenanceModeState: async () => ({ enabled: false }), getMaxConcurrentActivations: async () => 1,
            verifyCdkDetails: async () => { await gate; return null; }
        }, { activeForegroundJobs: active });
        const first = run(request, response());
        await new Promise(r => setImmediate(r));
        const second = response(); await run({ ...request, body: { ...request.body, cdk: 'OTHER' } }, second);
        resume(); await first;
        expect(second.code).toBe(429); expect(active.size).toBe(0);
    });

});
