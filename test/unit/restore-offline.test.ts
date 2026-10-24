import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBackup } from '../../src/backup/backup-runner';
import type { BackupContext } from '../../src/backup/context';
import { bytesToBase64 } from '../../src/core/crypto';
import { encodeManifest } from '../../src/core/manifest';
import { backupRoot, blobKey, snapshotKey } from '../../src/core/paths';
import { createLocalState } from '../../src/io/local-state';
import { createRemoteStore } from '../../src/io/remote-store';
import { encryptedSealer, newEncryptionDescriptor, plainSealer } from '../../src/io/sealer';
import { loadSettings } from '../../src/settings';
import { createFakeR2 } from '../helpers/fake-r2';
import { legacySeal } from '../helpers/legacy-envelope';
import { createMemoryVault } from '../helpers/memory-vault';

const script = resolve('scripts/restore-offline.mjs');
const roots: string[] = [];
const passphrase = 'offline test passphrase 🔑';
const files = {
	'notes/hello.md': new TextEncoder().encode('# Hello, κόσμε\n'),
	'attachments/binary.bin': new Uint8Array([0, 255, 128, 13, 10, 0]),
	'empty.md': new Uint8Array(),
	'.obsidian/app.json': new TextEncoder().encode('{"showLineNumber":true}'),
};

beforeEach(() => {
	vi.stubGlobal('window', { setInterval, clearInterval });
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(encrypted = false) {
	const temp = await mkdtemp(join(tmpdir(), 'cvb-restore-'));
	roots.push(temp);
	const src = join(temp, 'download');
	const out = join(temp, 'restored');
	const client = createFakeR2();
	const vault = createMemoryVault({ files });
	const settings = loadSettings({ vaultId: 'offline-test' });
	settings.encryption.enabled = encrypted;
	const encryption = encrypted ? await newEncryptionDescriptor(passphrase, 100_000) : null;
	const sealer = encryption ? encryptedSealer(encryption.keys) : plainSealer();
	const root = backupRoot(settings.connection.prefix, settings.vaultId);
	const store = createRemoteStore(client, root, sealer);
	if (encryption) {
		await store.writeDescriptor({
			format: 1, vaultId: settings.vaultId, vaultName: vault.vaultName,
			createdAt: new Date(client.serverNow()).toISOString(), encryption: encryption.descriptor,
		});
	}
	let now = client.serverNow();
	const context: BackupContext = {
		vault, store, sealer, client, settings, local: createLocalState(vault),
		deviceId: 'offline-device', pluginVersion: '1.3.0', now: () => now,
		random: () => 0.5, onState: () => undefined, log: () => undefined,
	};
	const backup = async () => {
		now += 60_000;
		client.setServerNow(now);
		const result = await runBackup(context, 'manual');
		if (result.kind !== 'done' || result.snapshotId === null) throw new Error('Backup did not create a snapshot');
		return result.snapshotId;
	};
	const id = await backup();
	const dump = async () => {
		for (const [key, object] of client.objects) {
			const target = join(src, key.slice(root.length + 1));
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, object.body);
		}
	};
	const run = (args: string[] = [], secret = passphrase) => spawnSync('node', [
		script, '--src', src, '--out', out, '--passphrase-env', 'CVB_TEST_PASSPHRASE', ...args,
	], { encoding: 'utf8', env: { ...process.env, CVB_TEST_PASSPHRASE: secret } });
	const manifest = await store.readManifest(id);
	if (!manifest) throw new Error('Manifest missing');
	return { temp, src, out, client, vault, root, store, encryption, sealer, id, manifest, backup, dump, run };
}

async function expectFiles(out: string, expected: Record<string, Uint8Array>) {
	for (const [path, bytes] of Object.entries(expected)) {
		expect(new Uint8Array(await readFile(join(out, path)))).toEqual(bytes);
	}
}

describe('standalone offline restore', () => {
	it.each([false, true])('restores the newest snapshot and an explicit older snapshot (encrypted: %s)', async (encrypted) => {
		const h = await setup(encrypted);
		const changed = new TextEncoder().encode('An updated note\n');
		h.vault.files.set('notes/hello.md', changed);
		h.vault.touch('notes/hello.md', 2_000_000);
		const newest = await h.backup();
		await h.dump();
		const result = h.run();
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(newest);
		await expectFiles(h.out, { ...files, 'notes/hello.md': changed });
		await rm(h.out, { recursive: true });
		expect(h.run(['--snapshot', h.id]).status).toBe(0);
		await expectFiles(h.out, files);
	});

	it('reads legacy version 1 check, manifest, and blob envelopes', async () => {
		const h = await setup(true);
		if (!h.encryption) throw new Error('Encryption missing');
		const { keys, descriptor } = h.encryption;
		const vaultDescriptor = await h.store.readDescriptor();
		if (!vaultDescriptor) throw new Error('Descriptor missing');
		descriptor.check = bytesToBase64(await legacySeal(keys.aes, new TextEncoder().encode('r2-vault-sync-check')));
		await h.store.writeDescriptor({ ...vaultDescriptor, encryption: descriptor });
		await h.client.put(snapshotKey(h.root, h.id), await legacySeal(keys.aes, encodeManifest(h.manifest)));
		for (const [path, entry] of Object.entries(h.manifest.files)) {
			await h.client.put(blobKey(h.root, entry.h), await legacySeal(keys.aes, await h.vault.read(path)));
		}
		await h.dump();
		const result = h.run();
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		await expectFiles(h.out, files);
	});

	it('restores an encrypted backup with Bun', async () => {
		const h = await setup(true);
		await h.dump();
		const result = spawnSync('bun', [script, '--src', h.src, '--out', h.out, '--passphrase-env', 'CVB_TEST_PASSPHRASE'], {
			encoding: 'utf8', env: { ...process.env, CVB_TEST_PASSPHRASE: passphrase },
		});
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		await expectFiles(h.out, files);
	});

	it.each(['manifest', 'blob'])('rejects a version 2 %s encrypted for a different name', async (role) => {
		const h = await setup(true);
		if (role === 'manifest') {
			await h.client.put(snapshotKey(h.root, h.id), await h.sealer.seal(encodeManifest(h.manifest), 'manifest:other'));
		} else {
			const entry = h.manifest.files['attachments/binary.bin'];
			if (!entry) throw new Error('File entry missing');
			await h.client.put(blobKey(h.root, entry.h), await h.sealer.seal(files['attachments/binary.bin'], 'blob:other'));
		}
		await h.dump();
		const result = h.run();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Authentication failed');
	});

	it('fails with the wrong passphrase before creating output', async () => {
		const h = await setup(true);
		await h.dump();
		const result = h.run([], 'incorrect');
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/wrong passphrase/i);
		expect(result.stderr).not.toContain('incorrect');
		expect(await readdir(h.temp)).toEqual(['download']);
	});

	it.each([
		'../escaped.md', '/absolute.md', 'notes/../../escaped.md', 'C:/escaped.md', 'notes\\escaped.md',
		'.git/config', 'HIDDEN~1/file.md', 'notes/file:stream', 'notes/NUL.txt', '.obsidian/plugins/cloudflare-vault-backup/data.json',
		'.obsidian/plugins/cloudflare-vault-backup/backup-health.json',
	])('refuses unsafe manifest path %s before creating output', async (path) => {
		const h = await setup();
		const entry = Object.values(h.manifest.files)[0];
		if (!entry) throw new Error('File entry missing');
		const manifest = { ...h.manifest, files: { [path]: entry }, totals: { files: 1, bytes: entry.s } };
		await h.client.put(snapshotKey(h.root, h.id), encodeManifest(manifest));
		await h.dump();
		const result = h.run();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Unsafe restore path');
		expect(await readdir(h.temp)).toEqual(['download']);
	});

	it.each([false, true])('refuses a corrupt blob before writing its file (encrypted: %s)', async (encrypted) => {
		const h = await setup(encrypted);
		const entry = h.manifest.files['attachments/binary.bin'];
		if (!entry) throw new Error('File entry missing');
		await h.client.put(blobKey(h.root, entry.h), await h.sealer.seal(new Uint8Array(entry.s), `blob:${entry.h}`));
		await h.dump();
		const result = h.run();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Blob hash or size mismatch');
		await expect(readFile(join(h.out, 'attachments/binary.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('refuses an existing output directory or symlink', async () => {
		const h = await setup();
		await h.dump();
		const outside = join(h.temp, 'existing');
		await mkdir(outside);
		await writeFile(join(outside, 'keep.md'), 'keep');
		await symlink(outside, h.out, 'dir');
		expect(h.run().status).toBe(1);
		expect(await readdir(outside)).toEqual(['keep.md']);
		await rm(h.out);
		await mkdir(h.out);
		expect(h.run().status).toBe(1);
		expect(await readdir(h.out)).toEqual([]);
	});

	it('rejects an unsafe snapshot argument', async () => {
		const h = await setup();
		await h.dump();
		expect(h.run(['--snapshot', '../../vault']).status).toBe(1);
		expect(await readdir(h.temp)).toEqual(['download']);
	});
});
