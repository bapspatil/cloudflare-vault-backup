import { describe, expect, it } from 'vitest';
import { loadSnapshotText, restoreFile, restoreSnapshot, type RestoreDeps } from '../../src/backup/restore-runner';
import { sha256Hex } from '../../src/core/crypto';
import type { Manifest } from '../../src/core/types';
import { createRemoteStore } from '../../src/io/remote-store';
import { plainSealer } from '../../src/io/sealer';
import { createFakeR2 } from '../helpers/fake-r2';
import { createMemoryVault } from '../helpers/memory-vault';

const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);
const ID = '20261016T120000Z-ab12';

async function setup(files: Record<string, Uint8Array | string> = {}) {
	const store = createRemoteStore(createFakeR2(), 'backups/v1', plainSealer());
	const vault = createMemoryVault({ files });
	const contents: Record<string, Uint8Array> = {
		'Notes/a.md': utf8('# alpha'),
		'b.md': utf8('beta'),
		'img/c.png': new Uint8Array([137, 80, 78, 71]),
	};
	const entries: Manifest['files'] = {};
	for (const [path, bytes] of Object.entries(contents)) {
		const h = await sha256Hex(bytes);
		await store.putBlob(h, bytes);
		entries[path] = { h, s: bytes.byteLength, m: 1 };
	}
	const manifest: Manifest = {
		format: 1,
		id: ID,
		createdAt: '2026-10-16T12:00:00.000Z',
		deviceId: 'dev',
		pluginVersion: '0.1.0',
		blobScheme: 'sha256',
		totals: { files: 3, bytes: 0 },
		files: entries,
		skipped: [],
	};
	await store.writeManifest(manifest);
	const deps: RestoreDeps = { store, vault, now: () => Date.UTC(2026, 9, 16, 15, 0, 0), allowConfigDir: false };
	return { deps, vault, manifest, store };
}

describe('config folder protection', () => {
	async function withConfigFile(path: string) {
		const ctx = await setup();
		const bytes = utf8('alert(1)');
		const h = await sha256Hex(bytes);
		await ctx.store.putBlob(h, bytes);
		ctx.manifest.files[path] = { h, s: bytes.byteLength, m: 1 };
		return ctx;
	}

	it('refuses config folder targets unless allowed', async () => {
		const { deps, manifest, vault } = await withConfigFile('.obsidian/plugins/evil/main.js');
		const refused = await restoreFile(deps, manifest, '.obsidian/plugins/evil/main.js', { kind: 'overwrite' });
		expect(refused).toEqual({
			path: '.obsidian/plugins/evil/main.js', outcome: 'failed', target: '.obsidian/plugins/evil/main.js',
			detail: 'refused: config folder (enable config restore)',
		});
		expect(vault.files.has('.obsidian/plugins/evil/main.js')).toBe(false);
		const allowed = await restoreFile({ ...deps, allowConfigDir: true }, manifest, '.obsidian/plugins/evil/main.js', { kind: 'overwrite' });
		expect(allowed.outcome).toBe('written');
	});

	it('refuses a case-variant config folder target', async () => {
		const path = '.Obsidian/snippets/evil.css';
		const { deps, manifest } = await withConfigFile(path);
		const result = await restoreFile(deps, manifest, path, { kind: 'overwrite' });
		expect(result.detail).toBe('refused: config folder (enable config restore)');
	});

	it('always refuses this plugin\'s own state files', async () => {
		const path = '.obsidian/plugins/r2-vault-sync/data.json';
		const { deps, manifest } = await withConfigFile(path);
		const result = await restoreFile({ ...deps, allowConfigDir: true }, manifest, path, { kind: 'overwrite' });
		expect(result.detail).toBe('refused: plugin state file');
	});
});

describe('restoreFile', () => {
	it('copy writes a dated sibling with exact bytes', async () => {
		const { deps, vault, manifest } = await setup();
		const r = await restoreFile(deps, manifest, 'Notes/a.md', { kind: 'copy' });
		expect(r).toEqual({ path: 'Notes/a.md', outcome: 'written', target: 'Notes/a (restored 2026-10-16).md' });
		expect(text(vault.files.get('Notes/a (restored 2026-10-16).md'))).toBe('# alpha');
	});

	it('overwrite is unchanged on identical content', async () => {
		const { deps, manifest } = await setup({ 'Notes/a.md': '# alpha' });
		const r = await restoreFile(deps, manifest, 'Notes/a.md', { kind: 'overwrite' });
		expect(r.outcome).toBe('unchanged');
	});

	it('overwrite replaces different content', async () => {
		const { deps, vault, manifest } = await setup({ 'Notes/a.md': 'edited' });
		const r = await restoreFile(deps, manifest, 'Notes/a.md', { kind: 'overwrite' });
		expect(r.outcome).toBe('written');
		expect(text(vault.files.get('Notes/a.md'))).toBe('# alpha');
	});

	it('into-folder writes under the folder', async () => {
		const { deps, vault, manifest } = await setup();
		const r = await restoreFile(deps, manifest, 'Notes/a.md', { kind: 'into-folder', folder: `/Restored/${ID}/` });
		expect(r.target).toBe(`Restored/${ID}/Notes/a.md`);
		expect(text(vault.files.get(`Restored/${ID}/Notes/a.md`))).toBe('# alpha');
	});

	it('reports a missing blob', async () => {
		const { deps, manifest } = await setup();
		manifest.files['gone.md'] = { h: 'f'.repeat(64), s: 1, m: 1 };
		const r = await restoreFile(deps, manifest, 'gone.md', { kind: 'copy' });
		expect(r).toMatchObject({ outcome: 'failed', detail: 'blob missing' });
	});
});

describe('restoreSnapshot', () => {
	it('returns results in manifest key order and reports progress', async () => {
		const { deps, manifest } = await setup();
		const calls: Array<[number, number]> = [];
		const results = await restoreSnapshot(deps, manifest, { kind: 'overwrite' }, (d, t) => calls.push([d, t]));
		expect(results.map((r) => [r.path, r.outcome])).toEqual([
			['Notes/a.md', 'written'],
			['b.md', 'written'],
			['img/c.png', 'written'],
		]);
		expect(calls).toHaveLength(3);
		expect(calls.at(-1)).toEqual([3, 3]);
	});
});

describe('loadSnapshotText', () => {
	it('returns text for md and null for png', async () => {
		const { deps, manifest } = await setup();
		expect(await loadSnapshotText(deps, manifest, 'Notes/a.md')).toBe('# alpha');
		expect(await loadSnapshotText(deps, manifest, 'img/c.png')).toBe(null);
	});
});
