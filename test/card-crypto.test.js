'use strict';

process.env.CARD_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const cardCrypto = require('../card-crypto');

describe('card crypto', () => {
    it('encrypts and decrypts card fields with AES-256-GCM', () => {
        const ciphertext = cardCrypto.encrypt('4242424242424242');
        expect(ciphertext.startsWith(cardCrypto.ENCRYPTED_PREFIX)).toBe(true);
        expect(ciphertext).not.toContain('4242424242424242');
        expect(cardCrypto.decrypt(ciphertext)).toBe('4242424242424242');
    });

    it('uses a random IV for each encryption', () => {
        const first = cardCrypto.encrypt('4242424242424242');
        const second = cardCrypto.encrypt('4242424242424242');
        expect(first).not.toBe(second);
        expect(cardCrypto.decrypt(first)).toBe(cardCrypto.decrypt(second));
    });

    it('rejects tampered ciphertext', () => {
        const ciphertext = cardCrypto.encrypt('4242424242424242');
        const parts = ciphertext.slice(cardCrypto.ENCRYPTED_PREFIX.length).split(':');
        const body = parts[2];
        const tamperedBody = `${body[0] === 'A' ? 'B' : 'A'}${body.slice(1)}`;
        const tampered = `${cardCrypto.ENCRYPTED_PREFIX}${parts[0]}:${parts[1]}:${tamperedBody}`;
        expect(() => cardCrypto.decrypt(tampered)).toThrow(/解密失败/);
    });

    it('hashes card numbers and masks all but the last four digits', () => {
        expect(cardCrypto.hashCardNumber('4242 4242 4242 4242')).toBe(cardCrypto.hashCardNumber('4242424242424242'));
        expect(cardCrypto.getCardLast4('4242 4242 4242 4242')).toBe('4242');
        expect(cardCrypto.maskCardNumber('4242 4242 4242 4242')).toBe('**** **** **** 4242');
    });

    it('builds encrypted database fields and decrypts them back', () => {
        const fields = cardCrypto.buildEncryptedCardFields({
            card_number: '4242424242424242',
            card_expiry: '12/30',
            card_cvc: '123',
            card_holder: 'Test User'
        });
        expect(fields.card_last4).toBe('4242');
        expect(fields.card_number_hash).toHaveLength(64);
        expect(cardCrypto.decryptCardRow(fields)).toEqual({
            number: '4242424242424242',
            expiry: '12/30',
            cvc: '123',
            holder: 'Test User'
        });
    });

    it('falls back to legacy plaintext columns only before migration', () => {
        expect(cardCrypto.decryptCardRow({
            card_number: '4242424242424242',
            card_expiry: '12/30',
            card_cvc: '123',
            card_holder: 'Legacy'
        })).toEqual({
            number: '4242424242424242',
            expiry: '12/30',
            cvc: '123',
            holder: 'Legacy'
        });
    });
});
