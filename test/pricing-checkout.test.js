'use strict';

const {
    extractCheckoutUrlFromPayload,
    isCheckoutLikeUrl
} = require('../pricing-checkout');

describe('pricing checkout url extraction', () => {
    it('prefers an absolute checkout url from the API payload', () => {
        expect(extractCheckoutUrlFromPayload({ url: 'https://pay.openai.com/c/pay/cs_live_123' }))
            .toBe('https://pay.openai.com/c/pay/cs_live_123');
    });

    it('builds a chatgpt checkout url from checkout_session_id', () => {
        expect(extractCheckoutUrlFromPayload({ checkout_session_id: 'cs_live_abc123' }))
            .toBe('https://chatgpt.com/checkout/openai_llc/cs_live_abc123');
    });

    it('finds a session id embedded elsewhere in the payload', () => {
        expect(extractCheckoutUrlFromPayload({ redirect: 'https://chatgpt.com/checkout/openai_llc/cs_live_xyz789' }))
            .toBe('https://chatgpt.com/checkout/openai_llc/cs_live_xyz789');
    });

    it('distinguishes checkout urls from the pricing hash', () => {
        expect(isCheckoutLikeUrl('https://chatgpt.com/checkout/openai_llc/cs_live_1')).toBe(true);
        expect(isCheckoutLikeUrl('https://pay.openai.com/c/pay/cs_live_1')).toBe(true);
        expect(isCheckoutLikeUrl('https://chatgpt.com/#pricing')).toBe(false);
    });
});
