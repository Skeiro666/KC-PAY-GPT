'use strict';

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){2,4}/g;

function redactSensitiveText(value) {
    let text = String(value ?? '');
    if (!text) {
        return text;
    }

    text = text.replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]');
    text = text.replace(/((?:openai-sentinel-token|openai-sentinel-extra-data|openai-sentinel-chat-requirements-token|x-oai-client-session-identity-version)\s*:\s*)[^\r\n]*/gi, '$1[REDACTED]');
    text = text.replace(
        /^((?:\u001b\[[0-9;]*m)*[ \t]*(?:[-*]\s*)?)((?:cookie|set-cookie)\s*:\s*)[^\r\n]*/gim,
        '$1$2[REDACTED]'
    );
    text = text.replace(
        /((?:accessToken|access_token|sessionToken|session_token|refresh_token|id_token|idToken|api_key|apikey|apiKey|password|secret)\s*["']?\s*[:=]\s*["']?)[^"'\s,;}\]]+/gi,
        '$1[REDACTED]'
    );
    text = text.replace(/((?:^|[?&])(?:token|access_token|api_key|key|secret|password)=)[^&\s]+/gi, '$1[REDACTED]');
    text = text.replace(JWT_PATTERN, '[REDACTED_TOKEN]');
    text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[REDACTED]');

    return text;
}

module.exports = { redactSensitiveText };
