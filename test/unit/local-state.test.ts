import { describe, expect, it } from 'vitest';
import { INDEX_FORMAT } from '../../src/core/types';
import type { LocalIndex, OpCounters, RunLogEntry } from '../../src/core/types';
import { createLocalState } from '../../src/io/local-state';
import { createMemoryVault } from '../helpers/memory-vault';
import { isIncluded } from '../../src/core/paths';
import { PLUGIN_ID } from '../../src/settings';

const enc = new TextEncoder();

function setup() {
	const vault = createMemoryVault();
	return { vault, state: createLocalState(vault) };
}

function entry(n: number): RunLogEntry {
	return {
		startedAt: n,
		endedAt: n + 1,
		trigger: 'manual',
		result: { kind: 'done', snapshotId: null, stats: {} as never },
	};
}

const hash = 'a'.repeat(64);

describe('local state index', () => {
	it('returns a fresh index when missing', async () => {
		const { state } = setup();
		expect(await state.loadIndex('v1')).toEqual({
			format: INDEX_FORMAT,
			vaultId: 'v1',
			lastSnapshotId: null,
			lastGcAt: null,
			files: {},
			pendingBlobs: {},
		});
	});

	it('round-trips a saved index', async () => {
		const { state } = setup();
		const idx: LocalIndex = {
			format: INDEX_FORMAT,
			vaultId: 'v1',
			lastSnapshotId: '20260101T000000Z-abcd',
			lastGcAt: 123,
			files: { 'a.md': { h: hash, s: 5, m: 10 } },
			pendingBlobs: { [hash]: 77 },
		};
		await state.saveIndex(idx);
		expect(await state.loadIndex('v1')).toEqual(idx);
	});

	it('yields fresh on corrupt index', async () => {
		const { state, vault } = setup();
		vault.pluginFiles.set('index.json', enc.encode('{not json'));
		expect((await state.loadIndex('v1')).files).toEqual({});
	});

	it('yields fresh on vaultId mismatch', async () => {
		const { state } = setup();
		await state.saveIndex({ ...(await state.loadIndex('v1')), lastGcAt: 9 });
		const idx = await state.loadIndex('v2');
		expect(idx.vaultId).toBe('v2');
		expect(idx.lastGcAt).toBeNull();
	});
});

describe('local state log and counters', () => {
	it('keeps the 100 newest, newest first', async () => {
		const { state } = setup();
		for (let i = 0; i < 105; i++) await state.appendLog(entry(i));
		const log = await state.loadLog();
		expect(log).toHaveLength(100);
		expect(log[0]?.startedAt).toBe(104);
		expect(log[99]?.startedAt).toBe(5);
	});

	it('treats a corrupt log as empty', async () => {
		const { state, vault } = setup();
		vault.pluginFiles.set('log.json', enc.encode('garbage'));
		expect(await state.loadLog()).toEqual([]);
		await state.appendLog(entry(1));
		expect(await state.loadLog()).toHaveLength(1);
	});

	it('round-trips counters and returns null when corrupt', async () => {
		const { state, vault } = setup();
		expect(await state.loadCounters()).toBeNull();
		const c: OpCounters = { month: '2026-10', classA: 1, classB: 2, bytesUploaded: 3, bytesDownloaded: 4 };
		await state.saveCounters(c);
		expect(await state.loadCounters()).toEqual(c);
		vault.pluginFiles.set('counters.json', enc.encode('{"month":1}'));
		expect(await state.loadCounters()).toBeNull();
	});
});

describe('plugin state never reaches a backup', () => {
	it('excludes every file local state writes', async () => {
		const { vault, state } = setup();
		await state.saveIndex(await state.loadIndex('v1'));
		await state.appendLog(entry(1));
		await state.saveCounters({ month: '2026-10', classA: 1, classB: 1, bytesUploaded: 1, bytesDownloaded: 1 });
		const written = [...vault.pluginFiles.keys()].map((name) => `.obsidian/plugins/${PLUGIN_ID}/${name}`);
		expect(written.sort()).toEqual([
			'.obsidian/plugins/r2-vault-sync/counters.json',
			'.obsidian/plugins/r2-vault-sync/index.json',
			'.obsidian/plugins/r2-vault-sync/log.json',
		]);
		const opts = { configDir: '.obsidian', includeConfigDir: true, excludeGlobs: [], pluginId: PLUGIN_ID };
		expect(written.filter((p) => isIncluded(p, opts))).toEqual([]);
	});
});
