export async function legacySeal(aes: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, plain.slice()));
	const out = new Uint8Array(17 + ciphertext.length);
	out.set([0x52, 0x32, 0x56, 0x53, 0x01], 0);
	out.set(iv, 5);
	out.set(ciphertext, 17);
	return out;
}
