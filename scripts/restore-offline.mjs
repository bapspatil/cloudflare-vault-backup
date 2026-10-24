import { createHash, createHmac, webcrypto } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

const usage = 'Usage: node scripts/restore-offline.mjs --src <dir-of-local-vault-prefix> --out <dir> [--snapshot <snapId>] [--passphrase-env VAR]';
const decoder = new TextDecoder('utf-8', { fatal: true });
const utf8 = (text) => new TextEncoder().encode(text);
const json = (bytes) => JSON.parse(decoder.decode(bytes));
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const hashPattern = /^[0-9a-f]{64}$/;
const ignorable = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/g;
const fold = (segment) => segment.replace(ignorable, '').normalize('NFKC').toLowerCase();

function requireValid(condition, message) {
	if (!condition) throw new Error(message);
}

function validSnapshot(id) {
	if (!/^\d{8}T\d{6}Z-[0-9a-f]{4}$/.test(id)) return false;
	const stamp = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:${id.slice(13, 15)}Z`;
	const time = Date.parse(stamp);
	return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === stamp.slice(0, 19);
}

function safePath(path) {
	if (typeof path !== 'string' || path === '' || path.length > 1024) return false;
	if (/[\\\u0000-\u001f\u007f<>:"|?*]/.test(path)) return false;
	const segments = path.split('/');
	const names = segments.map(fold);
	if (names.some((name) => name === '' || name === '.' || name === '..' || /[. ]$/.test(name))) return false;
	if (names.some((name) => /[\\/:]/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(name))) return false;
	if (names[0] !== '.obsidian' && names.some((name) => name.startsWith('.') || /~\d/.test(name))) return false;
	if (names[0] === '.obsidian') {
		if (names.length === 2 && ['workspace.json', 'workspace-mobile.json'].includes(names[1])) return false;
		if (names.length === 4 && names[1] === 'plugins' && names[2] === 'cloudflare-vault-backup' &&
			['data.json', 'index.json', 'log.json', 'counters.json', 'backup-health.json'].includes(names[3])) return false;
	}
	return true;
}

async function unlock(descriptor, variable) {
	const encryption = descriptor.encryption;
	if (encryption === null) return null;
	requireValid(record(encryption) && encryption.kdf === 'PBKDF2-SHA256' &&
		Number.isInteger(encryption.iterations) && encryption.iterations >= 100_000 && encryption.iterations <= 10_000_000 &&
		typeof encryption.salt === 'string' && typeof encryption.check === 'string', 'Invalid encryption descriptor');
	requireValid(variable && Object.hasOwn(process.env, variable), 'Encrypted backup: set the environment variable named by --passphrase-env');
	const base = await webcrypto.subtle.importKey('raw', utf8(process.env[variable]), 'PBKDF2', false, ['deriveBits']);
	const bits = Buffer.from(await webcrypto.subtle.deriveBits({
		name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(encryption.salt, 'base64'), iterations: encryption.iterations,
	}, base, 512));
	const keys = {
		aes: await webcrypto.subtle.importKey('raw', bits.subarray(0, 32), 'AES-GCM', false, ['decrypt']),
		hmac: bits.subarray(32),
	};
	const check = await open(Buffer.from(encryption.check, 'base64'), keys, 'check');
	requireValid(decoder.decode(check) === 'r2-vault-sync-check', 'Wrong passphrase or corrupted encryption check');
	return keys;
}

async function open(stored, keys, context) {
	if (keys === null) return stored;
	requireValid(stored.length >= 33 && stored.subarray(0, 4).equals(Buffer.from('R2VS')),
		'Invalid or truncated encrypted envelope');
	const version = stored[4];
	requireValid(version === 1 || version === 2, 'Unsupported envelope version');
	const params = { name: 'AES-GCM', iv: stored.subarray(5, 17), tagLength: 128 };
	if (version === 2) params.additionalData = utf8(`r2vs:v2:${context}`);
	try {
		return Buffer.from(await webcrypto.subtle.decrypt(params, keys.aes, stored.subarray(17)));
	} catch {
		throw new Error('Authentication failed: wrong passphrase or corrupted data');
	}
}

function validateManifest(manifest, id, scheme) {
	requireValid(record(manifest) && manifest.format === 1 && manifest.id === id && manifest.blobScheme === scheme &&
		['createdAt', 'deviceId', 'pluginVersion'].every((key) => typeof manifest[key] === 'string') &&
		record(manifest.files) && record(manifest.totals) && Array.isArray(manifest.skipped), 'Invalid or unsupported snapshot manifest');
	const files = Object.entries(manifest.files);
	const names = new Set();
	let bytes = 0;
	for (const [path, entry] of files) {
		requireValid(safePath(path), `Unsafe restore path: ${path}`);
		const name = path.split('/').map(fold).join('/');
		requireValid(!names.has(name), `Conflicting restore path: ${path}`);
		names.add(name);
		requireValid(record(entry) && typeof entry.h === 'string' && hashPattern.test(entry.h) && count(entry.s) && count(entry.m),
			`Invalid file entry: ${path}`);
		bytes += entry.s;
	}
	for (const entry of manifest.skipped) {
		requireValid(record(entry) && safePath(entry.path) && ['too-large', 'unreadable'].includes(entry.reason) && count(entry.size),
			'Invalid skipped file entry');
	}
	requireValid(manifest.totals.files === files.length && manifest.totals.bytes === bytes, 'Invalid manifest totals');
	return files;
}

async function main() {
	const args = process.argv.slice(2);
	const options = new Map();
	for (let i = 0; i < args.length; i += 2) {
		const name = args[i];
		const value = args[i + 1];
		requireValid(['--src', '--out', '--snapshot', '--passphrase-env'].includes(name) &&
			value && !value.startsWith('--') && !options.has(name), usage);
		options.set(name, value);
	}
	const src = options.get('--src');
	const out = options.get('--out');
	requireValid(src && out, usage);
	const descriptor = json(await readFile(`${src}/vault.json`));
	requireValid(record(descriptor) && descriptor.format === 1 &&
		['vaultId', 'vaultName', 'createdAt'].every((key) => typeof descriptor[key] === 'string'),
		'Invalid or unsupported vault descriptor');
	const keys = await unlock(descriptor, options.get('--passphrase-env'));
	let id = options.get('--snapshot');
	if (id === undefined) {
		const snapshots = (await readdir(`${src}/snapshots`))
			.filter((name) => name.endsWith('.json') && validSnapshot(name.slice(0, -5))).sort();
		id = snapshots.at(-1)?.slice(0, -5);
	}
	requireValid(typeof id === 'string' && validSnapshot(id), 'No valid snapshot selected');
	const manifest = json(await open(await readFile(`${src}/snapshots/${id}.json`), keys, `manifest:${id}`));
	const files = validateManifest(manifest, id, keys === null ? 'sha256' : 'hmac-sha256');
	await mkdir(out);
	const directories = new Set(['']);
	for (const [path, entry] of files) {
		const bytes = await open(await readFile(`${src}/blobs/${entry.h.slice(0, 2)}/${entry.h}`), keys, `blob:${entry.h}`);
		const hash = keys === null ? createHash('sha256') : createHmac('sha256', keys.hmac);
		requireValid(hash.update(bytes).digest('hex') === entry.h && bytes.length === entry.s, `Blob hash or size mismatch: ${path}`);
		const segments = path.split('/');
		segments.pop();
		let parent = '';
		for (const segment of segments) {
			parent = parent ? `${parent}/${segment}` : segment;
			if (!directories.has(parent)) {
				await mkdir(`${out}/${parent}`);
				directories.add(parent);
			}
		}
		await writeFile(`${out}/${path}`, bytes, { flag: 'wx' });
	}
	console.log(`Restored ${files.length} files from ${id}; ${manifest.skipped.length} skipped in the backup.`);
}

main().catch((error) => {
	console.error(`Restore failed: ${error.message}`);
	process.exitCode = 1;
});
