const MAGIC = [0x52, 0x32, 0x56, 0x53];
const VERSION = 0x02;
const LEGACY_VERSION = 0x01;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + 1 + IV_LENGTH;
const CHECK_PLAINTEXT = 'r2-vault-sync-check';
const CHECK_CONTEXT = 'check';

export const ENVELOPE_OVERHEAD = HEADER_LENGTH + TAG_LENGTH;

type Bytes = ArrayBuffer | Uint8Array;

const subtle = () => crypto.subtle;

// TS 5.7+ BufferSource rejects Uint8Array<ArrayBufferLike>; vault data never sits in a SharedArrayBuffer.
const source = (data: Bytes) => data as BufferSource;

const additionalData = (context: string) => source(new TextEncoder().encode(`r2vs:v2:${context}`));

export function bytesToHex(bytes: Uint8Array): string {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export function randomHex(bytes: number): string {
	return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(data: Bytes): Promise<string> {
	return bytesToHex(new Uint8Array(await subtle().digest('SHA-256', source(data))));
}

export async function hmacSha256Hex(key: CryptoKey, data: Bytes): Promise<string> {
	return bytesToHex(new Uint8Array(await subtle().sign('HMAC', key, source(data))));
}

export async function deriveKeys(
	passphrase: string,
	salt: Uint8Array,
	iterations: number,
): Promise<{ aes: CryptoKey; hmac: CryptoKey }> {
	const base = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
		'deriveBits',
	]);
	const bits = new Uint8Array(
		await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: source(salt), iterations }, base, 512),
	);
	const aes = await subtle().importKey('raw', bits.slice(0, 32), { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt',
	]);
	const hmac = await subtle().importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
	]);
	return { aes, hmac };
}

export function isEnvelope(bytes: Uint8Array): boolean {
	return bytes.length >= ENVELOPE_OVERHEAD && MAGIC.every((b, i) => bytes[i] === b);
}

export async function seal(aes: CryptoKey, plaintext: Uint8Array, context: string): Promise<Uint8Array> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const ciphertext = new Uint8Array(
		await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(context) }, aes, source(plaintext)),
	);
	const out = new Uint8Array(HEADER_LENGTH + ciphertext.length);
	out.set(MAGIC, 0);
	out[MAGIC.length] = VERSION;
	out.set(iv, MAGIC.length + 1);
	out.set(ciphertext, HEADER_LENGTH);
	return out;
}

export async function open(aes: CryptoKey, envelope: Uint8Array, context: string): Promise<Uint8Array> {
	if (envelope.length < ENVELOPE_OVERHEAD) throw new Error('crypto: envelope truncated');
	if (!MAGIC.every((b, i) => envelope[i] === b)) throw new Error('crypto: bad envelope magic');
	const version = envelope[MAGIC.length];
	if (version !== VERSION && version !== LEGACY_VERSION) throw new Error('crypto: unsupported envelope version');
	const iv = envelope.slice(MAGIC.length + 1, HEADER_LENGTH);
	const params: AesGcmParams =
		version === VERSION ? { name: 'AES-GCM', iv, additionalData: additionalData(context) } : { name: 'AES-GCM', iv };
	try {
		return new Uint8Array(await subtle().decrypt(params, aes, source(envelope.subarray(HEADER_LENGTH))));
	} catch {
		throw new Error('crypto: authentication failed (wrong passphrase or corrupted data)');
	}
}

export async function makeCheck(aes: CryptoKey): Promise<string> {
	return bytesToBase64(await seal(aes, new TextEncoder().encode(CHECK_PLAINTEXT), CHECK_CONTEXT));
}

export async function verifyCheck(aes: CryptoKey, check: string): Promise<boolean> {
	try {
		const plain = await open(aes, base64ToBytes(check), CHECK_CONTEXT);
		return new TextDecoder().decode(plain) === CHECK_PLAINTEXT;
	} catch {
		return false;
	}
}
