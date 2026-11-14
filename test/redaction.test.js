'use strict';

const { redactSensitiveText } = require('../redaction');

describe('log redaction', () => {
    it('redacts authorization and cookie headers from playwright errors', () => {
        const input = [
            '- Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456',
            '- cookie: __Secure-next-auth.session-token=very-secret-cookie-value; oai-did=abc',
            '- Content-Type: application/json'
        ].join('\n');
        const output = redactSensitiveText(input);
        expect(output).toContain('Authorization: Bearer [REDACTED]');
        expect(output).toContain('cookie: [REDACTED]');
        expect(output).toContain('Content-Type: application/json');
        expect(output).not.toContain('very-secret-cookie-value');
        expect(output).not.toContain('signature123456');
    });

    it('redacts token fields and standalone jwts', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
        const input = `accessToken=${jwt} sessionToken: "abc123" ?api_key=secret-key`;
        const output = redactSensitiveText(input);
        expect(output).not.toContain(jwt);
        expect(output).not.toContain('abc123');
        expect(output).not.toContain('secret-key');
        expect(output).toContain('[REDACTED');
    });

    it('keeps ordinary text unchanged', () => {
        expect(redactSensitiveText('订单创建失败 (Status: 400)')).toBe('订单创建失败 (Status: 400)');
    });

    it('keeps diagnostic text after the word Cookie', () => {
        const input = '无法验证 session Cookie: net::ERR_TUNNEL_CONNECTION_FAILED';
        expect(redactSensitiveText(input)).toBe(input);
    });

    it('redacts cookie headers even when ansi color codes precede them', () => {
        const input = '\u001b[2m    - cookie: oai-did=abc; __cf_bm=very-long-secret-cookie-value\u001b[22m';
        const output = redactSensitiveText(input);
        expect(output).toContain('cookie: [REDACTED]');
        expect(output).not.toContain('very-long-secret-cookie-value');
    });

    it('redacts sentinel tokens', () => {
        const input = 'OpenAI-Sentinel-Token: {"p":"gAAAAA-secret-proof","t":"secret-token","c":"secret-clearance"}';
        const output = redactSensitiveText(input);
        expect(output).toBe('OpenAI-Sentinel-Token: [REDACTED]');
    });
});
