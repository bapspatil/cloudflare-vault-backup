import { beforeAll, describe, expect, it, vi } from 'vitest';
import { runBackup } from '../../src/backup/backup-runner';
import type { BackupContext } from '../../src/backup/context';
import { sha256Hex } from '../../src/core/crypto';
import { backupRoot, blobKey, blobsPrefix, descriptorKey, lockKey, snapshotsPrefix } from '../../src/core/paths';
import type { RunState } from '../../src/core/types';
import { createLocalState } from '../../src/io/local-state';
import { createRemoteStore } from '../../src/io/remote-store';
import { plainSealer } from '../../src/io/sealer';
import { R2Error, type R2Client } from '../../src/io/types';
import { loadSettings, type Settings } from '../../src/settings';
import { createFakeR2, type FakeR2 } from '../helpers/fake-r2';
import { createMemoryVault, type MemoryVault } from '../helpers/memory-vault';

const enc = new TextEncoder();
const START = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const SNAP_ID = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;

beforeAll(() => {
	vi.stubGlobal('window', { setInterval, clearInterval });
});

interface Harness {
	fake: FakeR2;
	vault: MemoryVault;
	settings: Settings;
	root: string;
	ctx: BackupContext;
	requests: () => number;
	states: RunState[];
	failBlobPut: { nth: number };
	advance(ms: number): void;
	run(): Promise<RunState>;
	keys(prefix: string): string[];
}

function countingClient(inner: R2Client, failBlobPut: { nth: number }): { client: R2Client; requests: () => number } {
	let n = 0;
	let blobPuts = 0;
	const tick = () => n++;
	return {
		requests: () => n,
		client: {
			put: async (key, body, opts) => {
				tick();
				if (key.includes('/blobs/') && ++blobPuts === failBlobPut.nth) {
					throw new R2Error(0, 'network', 'connection reset');
				}
				return inner.put(key, body, opts);
			},
			get: (key) => (tick(), inner.get(key)),
			head: (key) => (tick(), inner.head(key)),
			delete: (key) => (tick(), inner.delete(key)),
			deleteMany: (keys) => (tick(), inner.deleteMany(keys)),
			list: (prefix, opts) => (tick(), inner.list(prefix, opts)),
			listAll: (prefix, opts) => (tick(), inner.listAll(prefix, opts)),
			counters: () => inner.counters(),
		},
	};
}

function setup(files: Record<string, string | Uint8Array>, opts: { isMobile?: boolean } = {}): Harness {
	const fake = createFakeR2();
	const vault = createMemoryVault({ files, isMobile: opts.isMobile });
	const settings = loadSettings({ vaultId: 'v1' });
	const root = backupRoot(settings.connection.prefix, settings.vaultId);
	const failBlobPut = { nth: 0 };
	const { client, requests } = countingClient(fake, failBlobPut);
	const sealer = plainSealer();
	let t = START;
	const states: RunState[] = [];
	const ctx: BackupContext = {
		vault,
		store: createRemoteStore(client, root, sealer),
		sealer,
		client,
		local: createLocalState(vault),
		settings,
		deviceId: 'dev-a',
		pluginVersion: '0.1.0',
		now: () => t,
		random: () => 0.5,
		onState: (s) => states.push(s),
		log: () => undefined,
	};
	return {
		fake,
		vault,
		settings,
		root,
		ctx,
		requests,
		states,
		failBlobPut,
		advance(ms) {
			t += ms;
		},
		run() {
			t += 60_000;
			return runBackup(ctx, 'manual');
		},
		keys: (prefix) => [...fake.objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
	};
}

const THREE = { 'a.md': 'alpha', 'b.md': 'bravo', 'notes/c.md': 'charlie' };

function edit(h: Harness, path: string, text: string, mtime: number): void {
	h.vault.files.set(path, enc.encode(text));
	h.vault.touch(path, mtime);
}

async function blobKeysFor(root: string, texts: string[]): Promise<string[]> {
	const keys = await Promise.all(texts.map(async (t) => blobKey(root, await sha256Hex(enc.encode(t)))));
	return keys.sort();
}

function expectDone(s: RunState): Extract<RunState, { kind: 'done' }> {
	if (s.kind !== 'done') throw new Error(`expected done, got ${JSON.stringify(s)}`);
	return s;
}

function expectFailed(s: RunState): Extract<RunState, { kind: 'failed' }> {
	if (s.kind !== 'failed') throw new Error(`expected failed, got ${JSON.stringify(s)}`);
	return s;
}

describe('runBackup', () => {
	it('first run uploads every file and writes one descriptor and manifest', async () => {
		const h = setup(THREE);
		const done = expectDone(await h.run());
		expect(done.snapshotId).toMatch(SNAP_ID);
		expect(done.stats.uploaded).toBe(3);
		expect(done.stats.reused).toBe(0);
		expect([...h.fake.objects.keys()].sort()).toEqual(
			[descriptorKey(h.root), lockKey(h.root), `${snapshotsPrefix(h.root)}${done.snapshotId}.json`, ...(await blobKeysFor(h.root, ['alpha', 'bravo', 'charlie']))].sort(),
		);
		const kinds = h.states.map((s) => s.kind);
		expect(kinds[0]).toBe('scanning');
		expect(kinds[kinds.length - 1]).toBe('done');
		expect(new Set(kinds)).toEqual(new Set(['scanning', 'locking', 'uploading', 'committing', 'pruning', 'done']));
	});

	it('a second run without changes makes zero requests', async () => {
		const h = setup(THREE);
		expectDone(await h.run());
		const before = h.requests();
		const size = h.fake.objects.size;
		const done = expectDone(await h.run());
		expect(done.snapshotId).toBeNull();
		expect(h.requests()).toBe(before);
		expect(h.fake.objects.size).toBe(size);
	});

	it('an edited file uploads exactly one blob and reuses the rest', async () => {
		const h = setup(THREE);
		expectDone(await h.run());
		edit(h, 'a.md', 'alpha v2', 5_000_000);
		const done = expectDone(await h.run());
		expect(done.stats.uploaded).toBe(1);
		expect(done.stats.reused).toBe(2);
		expect(h.keys(snapshotsPrefix(h.root))).toHaveLength(2);
		expect(h.keys(blobsPrefix(h.root))).toEqual(await blobKeysFor(h.root, ['alpha', 'alpha v2', 'bravo', 'charlie']));
		const manifest = await h.ctx.store.readManifest(done.snapshotId ?? '');
		expect(Object.keys(manifest?.files ?? {}).sort()).toEqual(['a.md', 'b.md', 'notes/c.md']);
	});

	it('a touched file with unchanged bytes counts as reused', async () => {
		const h = setup(THREE);
		expectDone(await h.run());
		h.vault.touch('b.md', 6_000_000);
		const done = expectDone(await h.run());
		expect(done.stats.uploaded).toBe(0);
		expect(done.stats.reused).toBe(3);
	});

	it('a locally deleted file leaves the next manifest but keeps its blob', async () => {
		const h = setup(THREE);
		expectDone(await h.run());
		h.vault.files.delete('b.md');
		h.vault.mtimes.delete('b.md');
		const done = expectDone(await h.run());
		const manifest = await h.ctx.store.readManifest(done.snapshotId ?? '');
		expect(Object.keys(manifest?.files ?? {}).sort()).toEqual(['a.md', 'notes/c.md']);
		expect(h.fake.objects.has((await blobKeysFor(h.root, ['bravo']))[0] ?? '')).toBe(true);
	});

	it('a crash mid-upload keeps pending blobs so the rerun uploads only the rest', async () => {
		const h = setup(THREE);
		h.settings.concurrency = 1;
		h.failBlobPut.nth = 2;
		const failed = expectFailed(await h.run());
		expect(failed.phase).toBe('uploading');
		expect(failed.error).toEqual({ code: 'network', detail: 'connection reset' });
		const index = await h.ctx.local.loadIndex('v1');
		expect(Object.keys(index.pendingBlobs)).toHaveLength(1);
		expect(index.lastSnapshotId).toBeNull();
		expect(h.keys(snapshotsPrefix(h.root))).toEqual([]);

		h.failBlobPut.nth = 0;
		const done = expectDone(await h.run());
		expect(done.stats.uploaded).toBe(2);
		expect(done.stats.reused).toBe(1);
		expect(h.keys(blobsPrefix(h.root))).toHaveLength(3);
		expect((await h.ctx.local.loadIndex('v1')).pendingBlobs).toEqual({});
	});

	it('fails with locked and uploads nothing when another device holds the lock', async () => {
		const h = setup(THREE);
		h.fake.objects.set(lockKey(h.root), {
			body: enc.encode(JSON.stringify({ deviceId: 'dev-b', runId: 'r1', expiresAt: '2099-01-01T00:00:00.000Z' })),
			etag: 'held',
		});
		const failed = expectFailed(await h.run());
		expect(failed.phase).toBe('locking');
		expect(failed.error.code).toBe('locked');
		expect(h.keys(blobsPrefix(h.root))).toEqual([]);
		expect(h.fake.objects.has(descriptorKey(h.root))).toBe(false);
		const log = await h.ctx.local.loadLog();
		expect(log.map((e) => e.result.kind)).toEqual(['failed']);
	});

	it('garbage collects pruned manifests and unreferenced blobs once due', async () => {
		const h = setup(THREE);
		const first = expectDone(await h.run());
		edit(h, 'a.md', 'alpha v2', 5_000_000);
		const second = expectDone(await h.run());
		Object.assign(h.settings.retention, { keepLast: 1, daily: 0, weekly: 0, monthly: 0 });
		await h.ctx.local.saveIndex({ ...(await h.ctx.local.loadIndex('v1')), lastGcAt: null });
		h.advance(25 * HOUR);
		edit(h, 'b.md', 'bravo v2', 7_000_000);
		const third = expectDone(await h.run());
		expect(h.keys(snapshotsPrefix(h.root))).toEqual([`${snapshotsPrefix(h.root)}${third.snapshotId}.json`]);
		expect([first.snapshotId, second.snapshotId]).not.toContain(third.snapshotId);
		expect(h.keys(blobsPrefix(h.root))).toEqual(await blobKeysFor(h.root, ['alpha v2', 'bravo v2', 'charlie']));
		expect((await h.ctx.local.loadIndex('v1')).lastGcAt).toBe(h.ctx.now());
	});

	it('skips files over the mobile size cap', async () => {
		const h = setup({ 'big.bin': new Uint8Array(2048), 'a.md': 'alpha' }, { isMobile: true });
		h.settings.scope.maxFileSizeMbMobile = 0.001;
		const done = expectDone(await h.run());
		const manifest = await h.ctx.store.readManifest(done.snapshotId ?? '');
		expect(manifest?.skipped).toEqual([{ path: 'big.bin', reason: 'too-large', size: 2048 }]);
		expect(Object.keys(manifest?.files ?? {})).toEqual(['a.md']);
		expect(done.stats.skipped).toBe(1);
	});

	it('refuses to write plain blobs when encryption is enabled but not initialised', async () => {
		const h = setup(THREE);
		h.settings.encryption.enabled = true;
		const failed = expectFailed(await h.run());
		expect(failed.error).toEqual({ code: 'crypto', detail: 'encryption not initialised' });
		expect(h.keys(blobsPrefix(h.root))).toEqual([]);
	});
});
