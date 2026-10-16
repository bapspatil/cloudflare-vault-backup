import { bytesToBase64, base64ToBytes, deriveKeys, hmacSha256Hex, makeCheck, open, seal, sha256Hex, verifyCheck } from '../core/crypto';
import type { EncryptionDescriptor } from '../core/types';
import type { Sealer } from './types';

export interface EncryptionKeys {
	aes: CryptoKey;
	hmac: CryptoKey;
}

const SALT_BYTES = 16;

export function plainSealer(): Sealer {
	return {
		scheme: 'sha256',
		hash: (plain) => sha256Hex(plain),
		seal: (plain) => Promise.resolve(plain),
		open: (stored) => Promise.resolve(stored),
	};
}

export function encryptedSealer(keys: EncryptionKeys): Sealer {
	return {
		scheme: 'hmac-sha256',
		hash: (plain) => hmacSha256Hex(keys.hmac, plain),
		seal: (plain, context) => seal(keys.aes, plain, context),
		open: (stored, context) => open(keys.aes, stored, context),
	};
}

export async function newEncryptionDescriptor(
	passphrase: string,
	iterations = 600_000,
): Promise<{ descriptor: EncryptionDescriptor; keys: EncryptionKeys }> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const keys = await deriveKeys(passphrase, salt, iterations);
	const descriptor: EncryptionDescriptor = {
		kdf: 'PBKDF2-SHA256',
		iterations,
		salt: bytesToBase64(salt),
		check: await makeCheck(keys.aes),
	};
	return { descriptor, keys };
}

export async function unlockEncryption(passphrase: string, d: EncryptionDescriptor): Promise<EncryptionKeys | null> {
	const keys = await deriveKeys(passphrase, base64ToBytes(d.salt), d.iterations);
	return (await verifyCheck(keys.aes, d.check)) ? keys : null;
}
