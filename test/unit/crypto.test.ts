import { describe, expect, it } from 'vitest';
import {
	base64ToBytes,
	bytesToBase64,
	deriveKeys,
	ENVELOPE_OVERHEAD,
	hmacSha256Hex,
	isEnvelope,
	makeCheck,
	open,
	seal,
	sha256Hex,
	verifyCheck,
} from '../../src/core/crypto';

const utf8 = (s: string) => new TextEncoder().encode(s);
const salt = utf8('0123456789abcdef');

async function hmacKey(raw: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', utf8(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

describe('hashing', () => {
	it('computes SHA-256 hex', async () => {
		expect(await sha256Hex(utf8('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});

	it('computes SHA-256 hex from an ArrayBuffer', async () => {
		expect(await sha256Hex(utf8('abc').buffer)).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		);
	});

	it('computes HMAC-SHA256 hex', async () => {
		const key = await hmacKey('key');
		expect(await hmacSha256Hex(key, utf8('The quick brown fox jumps over the lazy dog'))).toBe(
			'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
		);
	});
});

describe('base64', () => {
	it('encodes and decodes bytes', () => {
		expect(bytesToBase64(utf8('hello'))).toBe('aGVsbG8=');
		expect(Array.from(base64ToBytes('aGVsbG8='))).toEqual([104, 101, 108, 108, 111]);
	});
});

describe('envelope', () => {
	it('round-trips through seal and open with the expected layout', async () => {
		const { aes } = await deriveKeys('correct horse', salt, 1000);
		const plain = utf8('secret note');
		const env = await seal(aes, plain);
		expect(Array.from(env.subarray(0, 5))).toEqual([0x52, 0x32, 0x56, 0x53, 0x01]);
		expect(env.length).toBe(plain.length + 33);
		expect(ENVELOPE_OVERHEAD).toBe(33);
		expect(isEnvelope(env)).toBe(true);
		expect(isEnvelope(plain)).toBe(false);
		expect(new TextDecoder().decode(await open(aes, env))).toBe('secret note');
	});

	it('rejects a flipped ciphertext byte', async () => {
		const { aes } = await deriveKeys('correct horse', salt, 1000);
		const env = await seal(aes, utf8('secret note'));
		env[20] = (env[20] as number) ^ 0x01;
		await expect(open(aes, env)).rejects.toThrow(/^crypto:/);
	});

	it('rejects wrong magic, wrong version and truncated input', async () => {
		const { aes } = await deriveKeys('correct horse', salt, 1000);
		const env = await seal(aes, utf8('x'));
		const badMagic = env.slice();
		badMagic[0] = 0x58;
		await expect(open(aes, badMagic)).rejects.toThrow(/^crypto: bad envelope magic/);
		const badVersion = env.slice();
		badVersion[4] = 0x02;
		await expect(open(aes, badVersion)).rejects.toThrow(/^crypto: unsupported envelope version/);
		await expect(open(aes, env.slice(0, 20))).rejects.toThrow(/^crypto: envelope truncated/);
	});

	it('rejects a different passphrase', async () => {
		const a = await deriveKeys('correct horse', salt, 1000);
		const b = await deriveKeys('wrong horse', salt, 1000);
		await expect(open(b.aes, await seal(a.aes, utf8('x')))).rejects.toThrow(/^crypto: authentication failed/);
	});
});

describe('deriveKeys', () => {
	it('derives a deterministic HMAC key distinct per passphrase', async () => {
		const a1 = await deriveKeys('pw', salt, 1000);
		const a2 = await deriveKeys('pw', salt, 1000);
		const b = await deriveKeys('pw2', salt, 1000);
		const h1 = await hmacSha256Hex(a1.hmac, utf8('note'));
		expect(h1).toMatch(/^[0-9a-f]{64}$/);
		expect(await hmacSha256Hex(a2.hmac, utf8('note'))).toBe(h1);
		expect(await hmacSha256Hex(b.hmac, utf8('note'))).not.toBe(h1);
	});
});

describe('passphrase check', () => {
	it('verifies with the right key and fails with the wrong one', async () => {
		const right = await deriveKeys('pw', salt, 1000);
		const wrong = await deriveKeys('nope', salt, 1000);
		const check = await makeCheck(right.aes);
		expect(await verifyCheck(right.aes, check)).toBe(true);
		expect(await verifyCheck(wrong.aes, check)).toBe(false);
		expect(await verifyCheck(right.aes, 'not base64!')).toBe(false);
	});
});
