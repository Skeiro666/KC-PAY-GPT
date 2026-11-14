'use strict';

const {
    buildCheckoutPayload,
    buildCheckoutRequestHeaders,
    extractSentinelHeaderValue,
    normalizeSentinelToken
} = require('../chatgpt');

describe('checkout request parity', () => {
    const originalPromo = process.env.CHECKOUT_PROMO_CAMPAIGN;

    afterEach(() => {
        if (originalPromo == null) {
            delete process.env.CHECKOUT_PROMO_CAMPAIGN;
        } else {
            process.env.CHECKOUT_PROMO_CAMPAIGN = originalPromo;
        }
    });

    it('builds the web checkout payload fields', () => {
        process.env.CHECKOUT_PROMO_CAMPAIGN = 'plus-1-month-free';
        const payload = buildCheckoutPayload('chatgptplusplan', 'PH', 'PHP', {
            planType: 'plus',
            purchaseAttemptId: '00000000-0000-4000-8000-000000000000'
        });

        expect(payload).toMatchObject({
            plan_name: 'chatgptplusplan',
            checkout_source: 'chatgpt_web_merged',
            entry_point: 'all_plans_pricing_modal',
            billing_details: { country: 'PH', currency: 'PHP' },
            supports_saved_payment_link: true,
            checkout_ui_mode: 'custom',
            checkout_appearance: 'light',
            purchase_attempt_id: '00000000-0000-4000-8000-000000000000'
        });
        expect(payload.promo_campaign).toEqual({
            promo_campaign_id: 'plus-1-month-free',
            is_coupon_from_query_param: false
        });
        expect(payload.cancel_url).toContain('highlight_plan=plus');
        expect(payload.cancel_url).toContain('promo_campaign=plus-1-month-free');
        expect(payload.cancel_url).toContain('#pricing');
    });

    it('adds account, device, language, sentinel and client hint headers', () => {
        const headers = buildCheckoutRequestHeaders('token-value', {
            accountId: 'account-id',
            deviceId: 'device-id',
            language: 'zh-CN',
            sentinelToken: '{"p":"proof","t":"token","c":"clearance"}',
            userAgent: 'Mozilla/5.0 Chrome/147.0.7727.15',
            clientHints: {
                brands: [{ brand: 'Google Chrome', version: '147' }],
                fullVersionList: [{ brand: 'Google Chrome', version: '147.0.7727.15' }],
                mobile: false,
                platform: 'Windows',
                architecture: 'x86',
                bitness: '64',
                model: ''
            }
        }, {
            planType: 'plus',
            promoCampaign: { promo_campaign_id: 'plus-1-month-free' }
        });

        expect(headers.Authorization).toBe('Bearer token-value');
        expect(headers['ChatGPT-Account-Id']).toBe('account-id');
        expect(headers['oai-did']).toBe('device-id');
        expect(headers['OAI-Device-Id']).toBe('device-id');
        expect(headers['OAI-Language']).toBe('zh-CN');
        expect(headers['OpenAI-Sentinel-Token']).toContain('"p":"proof"');
        expect(headers['sec-ch-ua']).toContain('Google Chrome');
        expect(headers['sec-ch-ua-platform']).toBe('"Windows"');
        expect(headers.Referer).toContain('promo_campaign=plus-1-month-free');
    });

    it('extracts a sentinel header from nested prepare/finalize responses', () => {
        expect(extractSentinelHeaderValue({
            result: {
                sentinel_header: {
                    p: 'proof',
                    t: 'turnstile',
                    c: 'clearance'
                }
            }
        })).toBe('{"p":"proof","t":"turnstile","c":"clearance"}');

        expect(extractSentinelHeaderValue({
            headers: {
                'OpenAI-Sentinel-Token': '{"p":"1","t":"2","c":"3"}'
            }
        })).toBe('{"p":"1","t":"2","c":"3"}');
    });

    it('maps values returned by the browser sentinel module to request headers', () => {
        const headers = buildCheckoutRequestHeaders('token-value', {
            sentinelToken: '{"p":"1","t":"2","c":"3"}',
            sentinelHeaders: {
                token: '{"p":"1","t":"2","c":"3"}',
                extraData: 'extra-data-value',
                'X-OAI-Client-Session-Identity-Version': 'identity-version'
            }
        }, { planType: 'plus' });

        expect(headers['OpenAI-Sentinel-Token']).toBe('{"p":"1","t":"2","c":"3"}');
        expect(headers['OpenAI-Sentinel-Extra-Data']).toBe('extra-data-value');
        expect(headers['X-OAI-Client-Session-Identity-Version']).toBe('identity-version');
    });

    it('keeps id and flow when extracting a sentinel token', () => {
        expect(extractSentinelHeaderValue({
            token: { p: 'proof', t: 'turnstile', c: 'clearance', id: 'device-id', flow: 'chatgpt_checkout' }
        })).toBe('{"p":"proof","t":"turnstile","c":"clearance","id":"device-id","flow":"chatgpt_checkout"}');
    });

    it('fills missing id and flow from the checkout context', () => {
        expect(normalizeSentinelToken('{"p":"1","t":"2","c":"3"}', {
            deviceId: 'device-id',
            flow: 'chatgpt_checkout'
        })).toBe('{"p":"1","t":"2","c":"3","id":"device-id","flow":"chatgpt_checkout"}');
    });
});
