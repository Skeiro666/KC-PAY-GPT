'use strict';

const { resolveBrowserRuntimeMode, buildWorkerRuntimeEnv } = require('../browser-runtime');
const { resolveBitBrowserConfig } = require('../bitbrowser-client');

describe('bitbrowser browser provider', () => {
    it('selects bitbrowser when BROWSER_PROVIDER=bitbrowser', () => {
        expect(resolveBrowserRuntimeMode({ BROWSER_PROVIDER: 'bitbrowser' })).toBe('bitbrowser');
    });

    it('honors an explicit bitbrowser runtime mode', () => {
        expect(resolveBrowserRuntimeMode({ BROWSER_RUNTIME_MODE: 'bitbrowser' })).toBe('bitbrowser');
    });

    it('passes bitbrowser env through to the worker without pool settings', () => {
        const env = buildWorkerRuntimeEnv(
            {
                FOO: 'bar',
                BITBROWSER_PROFILE_ID: 'profile-1',
                BROWSER_POOL_CDP_URL: 'http://127.0.0.1:19222'
            },
            null,
            'bitbrowser'
        );

        expect(env).toMatchObject({
            FOO: 'bar',
            BITBROWSER_PROFILE_ID: 'profile-1',
            BROWSER_RUNTIME_MODE: 'bitbrowser',
            BROWSER_PROVIDER: 'bitbrowser',
            BROWSER_POOL: '0',
            BROWSER_POOL_CDP_URL: '',
            BROWSER_POOL_SLOT: ''
        });
    });

    it('normalizes the local API URL and parses headless mode', () => {
        expect(resolveBitBrowserConfig({
            BITBROWSER_API_URL: 'http://127.0.0.1:54345/',
            BITBROWSER_PROFILE_ID: ' profile-1 ',
            BITBROWSER_HEADLESS: '0'
        })).toMatchObject({
            apiUrl: 'http://127.0.0.1:54345',
            profileId: 'profile-1',
            headless: false
        });
    });
});
