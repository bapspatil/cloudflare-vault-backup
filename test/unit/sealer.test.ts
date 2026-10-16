import { describe, expect, it } from 'vitest';
import { encryptedSealer, newEncryptionDescriptor, plainSealer, unlockEncryption } from '../../src/io/sealer';

const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const ITER = 1000;

describe('plainSealer', () => {
	it('hashes with SHA-256 and stores bytes unchanged', async () => {
		const s = plainSealer();
		expect(s.scheme).toBe('sha256');
		expect(await s.hash(utf8('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(text(await s.seal(utf8('note'), 'blob:abc'))).toBe('note');
		expect(text(await s.open(utf8('note'), 'blob:abc'))).toBe('note');
	});
});

describe('encryptedSealer', () => {
	it('round-trips through an envelope that hides the plaintext', async () => {
		const { keys } = await newEncryptionDescriptor('hunter2', ITER);
		const s = encryptedSealer(keys);
		const sealed = await s.seal(utf8('secret note'), 'blob:abc');
		expect(text(sealed).includes('secret note')).toBe(false);
		expect(sealed.byteLength).toBe('secret note'.length + 33);
		expect(text(await s.open(sealed, 'blob:abc'))).toBe('secret note');
	});

	it('refuses to open an envelope under a different context', async () => {
		const { keys } = await newEncryptionDescriptor('hunter2', ITER);
		const s = encryptedSealer(keys);
		const sealed = await s.seal(utf8('secret note'), 'blob:abc');
		await expect(s.open(sealed, 'manifest:20260101T000000Z-aaaa')).rejects.toThrow(/^crypto: authentication failed/);
	});

	it('hashes with a keyed HMAC that differs from plain SHA-256 and across passphrases', async () => {
		const a = encryptedSealer((await newEncryptionDescriptor('one', ITER)).keys);
		const b = encryptedSealer((await newEncryptionDescriptor('two', ITER)).keys);
		const ha = await a.hash(utf8('abc'));
		expect(a.scheme).toBe('hmac-sha256');
		expect(ha).toMatch(/^[0-9a-f]{64}$/);
		expect(ha).toBe(await a.hash(utf8('abc')));
		expect(ha === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad').toBe(false);
		expect(ha === (await b.hash(utf8('abc')))).toBe(false);
	});
});

describe('descriptor', () => {
	it('records the KDF parameters with a 16-byte salt', async () => {
		const { descriptor } = await newEncryptionDescriptor('pw', ITER);
		expect(descriptor.kdf).toBe('PBKDF2-SHA256');
		expect(descriptor.iterations).toBe(ITER);
		expect(atob(descriptor.salt).length).toBe(16);
	});

	it('unlocks with the right passphrase and returns null for a wrong one', async () => {
		const { descriptor, keys } = await newEncryptionDescriptor('correct horse', ITER);
		const sealed = await encryptedSealer(keys).seal(utf8('payload'), 'blob:abc');
		const unlocked = await unlockEncryption('correct horse', descriptor);
		expect(unlocked === null).toBe(false);
		expect(text(await encryptedSealer(unlocked as NonNullable<typeof unlocked>).open(sealed, 'blob:abc'))).toBe('payload');
		expect(await unlockEncryption('wrong horse', descriptor)).toBe(null);
	});
});
