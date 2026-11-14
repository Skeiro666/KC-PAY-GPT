'use strict';

const store = require('../mysql-store');

describe('stale task recovery', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('fails leftover running tasks and only rolls back CDKs before payment', async () => {
        const query = vi.fn().mockResolvedValue([
            { job_key: 'safe-job', cdk_code: 'CDK-SAFE', progress: 20 },
            { job_key: 'payment-job', cdk_code: 'CDK-PAYMENT', progress: 60 },
            { job_key: 'debug-job', cdk_code: '[checkout-debug]', progress: 5 }
        ]);
        const execute = vi.fn().mockImplementation(async () => ({
            affectedRows: 1
        }));

        const result = await store.failInterruptedRunningTasks({
            reason: '服务重启，上一任务已中断，请重新提交',
            query,
            execute
        });

        expect(result.count).toBe(3);
        expect(result.rolledBackCdks).toEqual(['CDK-SAFE']);
        const rollbackCalls = execute.mock.calls.filter(([sql]) => String(sql).includes('UPDATE cdk_codes'));
        expect(rollbackCalls).toHaveLength(1);
        expect(rollbackCalls[0][1]).toEqual(['CDK-SAFE']);
    });
});
