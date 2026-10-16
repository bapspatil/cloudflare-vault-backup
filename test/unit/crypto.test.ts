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
import { legacySeal } from '../helpers/legacy-envelope';

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
		const env = await seal(aes, plain, 'blob:abc');
		expect(Array.from(env.subarray(0, 5))).toEqual([0x52, 0x32, 0x56, 0x53, 0x02]);
		expect(env.length).toBe(plain.length + 33);
		expect(ENVELOPE_OVERHEAD).toBe(33);
		expect(isEnvelope(env)).toBe(true);
		expect(isEnvelope(plain)).toBe(false);
		expect(new TextDecoder().decode(await open(aes, env, 'blob:abc'))).toBe('secret note');
	});

	it('rejects a flipped ciphertext byte', async () => {
		const { aes } = await deriveKeys('correct horse', salt, 1000);
		const env = await seal(aes, utf8('secret note'), 'blob:abc');
		env[20] = (env[20] as number) ^ 0x01;
		await expect(open(aes, env, 'blob:abc')).rejects.toThrow(/^crypto:/);
	});

	it('rejects wrong magic, wrong version and truncated input', async () => {
		const { aes } = await deriveKeys('correct horse', salt, 1000);
		const env = await seal(aes, utf8('x'), 'blob:abc');
		const badMagic = env.slice();
		badMagic[0] = 0x58;
		await expect(open(aes, badMagic, 'blob:abc')).rejects.toThrow(/^crypto: bad envelope magic/);
		const badVersion = env.slice();
		badVersion[4] = 0x03;
		await expect(open(aes, badVersion, 'blob:abc')).rejects.toThrow(/^crypto: unsupported envelope version/);
		await expect(open(aes, env.slice(0, 20), 'blob:abc')).rejects.toThrow(/^crypto: envelope truncated/);
	});

	it('rejects a different passphrase', async () => {
		const a = await deriveKeys('correct horse', salt, 1000);
		const b = await deriveKeys('wrong horse', salt, 1000);
		await expect(open(b.aes, await seal(a.aes, utf8('x'), 'blob:abc'), 'blob:abc')).rejects.toThrow(
			/^crypto: authentication failed/,
		);
	});

	it('binds the envelope to the context it was sealed for', async () => {
		const { aes } = await deriveKeys('correct horse', salt, 1000);
		const env = await seal(aes, utf8('note'), 'blob:abc');
		expect(new TextDecoder().decode(await open(aes, env, 'blob:abc'))).toBe('note');
		await expect(open(aes, env, 'manifest:20260101T000000Z-aaaa')).rejects.toThrow(/^crypto: authentication failed/);
		await expect(open(aes, env, 'blob:abd')).rejects.toThrow(/^crypto: authentication failed/);
	});

	it('opens a legacy version 1 envelope and refuses a version 2 envelope relabeled as version 1', async () => {
		const { aes } = await deriveKeys('correct horse', salt, 1000);
		const legacy = await legacySeal(aes, utf8('old note'));
		expect(new TextDecoder().decode(await open(aes, legacy, 'blob:abc'))).toBe('old note');
		const env = await seal(aes, utf8('note'), 'blob:abc');
		env[4] = 0x01;
		await expect(open(aes, env, 'blob:abc')).rejects.toThrow(/^crypto: authentication failed/);
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

	it('verifies a check written by the legacy version 1 envelope', async () => {
		const { aes } = await deriveKeys('pw', salt, 1000);
		expect(await verifyCheck(aes, bytesToBase64(await legacySeal(aes, utf8('r2-vault-sync-check'))))).toBe(true);
	});

	it('does not accept a blob envelope as a check', async () => {
		const { aes } = await deriveKeys('pw', salt, 1000);
		expect(await verifyCheck(aes, bytesToBase64(await seal(aes, utf8('r2-vault-sync-check'), 'blob:abc')))).toBe(false);
	});
});
