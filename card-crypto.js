'use strict';

/**
 * 银行卡敏感字段加密工具（AES-256-GCM）
 *
 * 密钥优先级：
 * 1. CARD_ENCRYPTION_KEY 环境变量（64 位 hex 或 32 字节原文）
 * 2. data/card-encryption.key 文件（首次启动自动生成）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENCRYPTED_PREFIX = 'enc:v1:';
const KEY_FILE = path.join(__dirname, 'data', 'card-encryption.key');
let cachedKey = null;

function parseKey(raw) {
    const value = String(raw || '').trim();
    if (!value) {
        throw new Error('CARD_ENCRYPTION_KEY 为空');
    }
    if (/^[0-9a-fA-F]{64}$/.test(value)) {
        return Buffer.from(value, 'hex');
    }
    if (value.length === 32) {
        return Buffer.from(value, 'utf8');
    }
    const fromBase64 = Buffer.from(value, 'base64');
    if (fromBase64.length === 32) {
        return fromBase64;
    }
    throw new Error('CARD_ENCRYPTION_KEY 必须是 64 位 hex 或 32 字节密钥');
}

function loadOrCreateKey() {
    const envKey = String(process.env.CARD_ENCRYPTION_KEY || '').trim();
    if (envKey) {
        return parseKey(envKey);
    }

    if (!fs.existsSync(KEY_FILE)) {
        fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
        const generated = crypto.randomBytes(32);
        try {
            fs.writeFileSync(KEY_FILE, `${generated.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
            try {
                fs.chmodSync(KEY_FILE, 0o600);
            } catch (_) { /* Windows 下可能不支持，忽略 */ }
            console.log(`[CardCrypto] 已生成银行卡加密密钥: ${KEY_FILE}`);
            console.warn('[CardCrypto] 请备份 data/card-encryption.key；密钥丢失后已加密的卡数据无法解密');
            return generated;
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
        }
    }

    return parseKey(fs.readFileSync(KEY_FILE, 'utf8'));
}

function getKey() {
    if (!cachedKey) {
        cachedKey = loadOrCreateKey();
    }
    return cachedKey;
}

function resetKeyCache() {
    cachedKey = null;
}

function isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

function encrypt(value) {
    const plain = value == null ? '' : String(value);
    if (!plain) return '';
    if (isEncrypted(plain)) return plain;

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENCRYPTED_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function decrypt(value) {
    const stored = value == null ? '' : String(value);
    if (!stored) return '';
    if (!isEncrypted(stored)) return stored;

    const payload = stored.slice(ENCRYPTED_PREFIX.length);
    const parts = payload.split(':');
    if (parts.length !== 3) {
        throw new Error('加密字段格式无效');
    }
    const [ivPart, tagPart, ciphertextPart] = parts;
    try {
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            getKey(),
            Buffer.from(ivPart, 'base64url')
        );
        decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
        const plain = Buffer.concat([
            decipher.update(Buffer.from(ciphertextPart, 'base64url')),
            decipher.final()
        ]);
        return plain.toString('utf8');
    } catch (_) {
        throw new Error('银行卡加密数据解密失败，请检查 CARD_ENCRYPTION_KEY 是否与加密时一致');
    }
}

function normalizeCardNumber(value) {
    return String(value == null ? '' : value).replace(/\s+/g, '').trim();
}

function hashCardNumber(value) {
    const normalized = normalizeCardNumber(value);
    if (!normalized) return '';
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

function getCardLast4(value) {
    const normalized = normalizeCardNumber(value);
    return normalized ? normalized.slice(-4) : '';
}

function maskCardNumber(value) {
    const last4 = getCardLast4(value);
    return last4 ? `**** **** **** ${last4}` : '****';
}

/**
 * 从数据库行读取解密后的卡片敏感字段。
 * enc 列优先；enc 为空时回退旧明文列（迁移期间兼容）。
 */
function decryptCardRow(row = {}) {
    return {
        number: decrypt(row.card_number_enc) || String(row.card_number || ''),
        expiry: decrypt(row.card_expiry_enc) || String(row.card_expiry || ''),
        cvc: decrypt(row.card_cvc_enc) || String(row.card_cvc || ''),
        holder: decrypt(row.card_holder_enc) || String(row.card_holder || '')
    };
}

function buildEncryptedCardFields(card = {}) {
    const number = normalizeCardNumber(card.card_number || card.number || '');
    return {
        card_number_enc: encrypt(number),
        card_expiry_enc: encrypt(card.card_expiry || card.expiry || ''),
        card_cvc_enc: encrypt(card.card_cvc || card.cvc || ''),
        card_holder_enc: encrypt(card.card_holder || card.holder || ''),
        card_last4: getCardLast4(number),
        card_number_hash: hashCardNumber(number)
    };
}

module.exports = {
    ENCRYPTED_PREFIX,
    KEY_FILE,
    parseKey,
    getKey,
    resetKeyCache,
    isEncrypted,
    encrypt,
    decrypt,
    hashCardNumber,
    getCardLast4,
    maskCardNumber,
    decryptCardRow,
    buildEncryptedCardFields
};
