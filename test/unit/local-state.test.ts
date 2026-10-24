import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INDEX_FORMAT } from '../../src/core/types';
import type { LocalIndex, OpCounters, RunLogEntry } from '../../src/core/types';
import { createLocalState } from '../../src/io/local-state';
import { createMemoryVault } from '../helpers/memory-vault';
import { isIncluded } from '../../src/core/paths';
import { PLUGIN_ID } from '../../src/settings';

const enc = new TextEncoder();
const NOW = Date.parse('2026-10-24T12:00:00Z');

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => vi.useRealTimers());

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
			backupSet: 'v1',
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
			backupSet: 'v1',
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

	it('yields fresh when the backup set changes', async () => {
		const { state } = setup();
		await state.saveIndex({ ...(await state.loadIndex('obsidian/v1|sha256')), lastGcAt: 9 });
		const idx = await state.loadIndex('obsidian/v1|hmac-sha256');
		expect(idx.backupSet).toBe('obsidian/v1|hmac-sha256');
		expect(idx.lastGcAt).toBeNull();
	});
});

describe('local state log and counters', () => {
	it('loads the latest successful log entry for existing installations', async () => {
		const { state } = setup();
		await state.appendLog(entry(10));
		await state.appendLog(entry(20));
		await state.appendLog({ ...entry(30), result: { kind: 'failed', error: { code: 'io', detail: 'disk' } } });
		expect(await state.loadBackupHealth()).toEqual({ trackedSince: NOW, lastSuccessAt: 21, lastWarningAt: null });
	});

	it('persists success and notice deduplication after log rotation', async () => {
		const { state } = setup();
		expect(await state.loadBackupHealth()).toEqual({ trackedSince: NOW, lastSuccessAt: null, lastWarningAt: null });
		await state.saveBackupHealth({ trackedSince: 0, lastSuccessAt: 10, lastWarningAt: 20 });
		for (let i = 0; i < 101; i++) {
			await state.appendLog({ ...entry(30 + i), result: { kind: 'failed', error: { code: 'network', detail: 'offline' } } });
		}
		expect(await state.loadBackupHealth()).toEqual({ trackedSince: 0, lastSuccessAt: 10, lastWarningAt: 20 });
	});

	it.each(['garbage', '{}', '{"lastSuccessAt":"yesterday","lastWarningAt":null}', '{"lastSuccessAt":null,"lastWarningAt":-1}'])('recovers invalid backup health: %s', async (raw) => {
		const { state, vault } = setup();
		await state.appendLog(entry(10));
		vault.pluginFiles.set('backup-health.json', enc.encode(raw));
		expect(await state.loadBackupHealth()).toEqual({ trackedSince: NOW, lastSuccessAt: 11, lastWarningAt: null });
	});

	it('starts tracking at first load when the log contains only failures', async () => {
		const { state } = setup();
		await state.appendLog({ ...entry(10), result: { kind: 'failed', error: { code: 'network', detail: 'offline' } } });
		const health = await state.loadBackupHealth();
		expect(health).toEqual({ trackedSince: NOW, lastSuccessAt: null, lastWarningAt: null });
		await state.saveBackupHealth(health);
		vi.setSystemTime(NOW + 3_600_000);
		expect(await state.loadBackupHealth()).toEqual(health);
	});

	it.each([null, 10])('migrates an older health record with last success %s and preserves its timestamps', async (lastSuccessAt) => {
		const { state, vault } = setup();
		vault.pluginFiles.set('backup-health.json', enc.encode(JSON.stringify({ lastSuccessAt, lastWarningAt: 20 })));
		const health = await state.loadBackupHealth();
		expect(health).toEqual({ trackedSince: NOW, lastSuccessAt, lastWarningAt: 20 });
		await state.saveBackupHealth(health);
		vi.setSystemTime(NOW + 3_600_000);
		expect(await state.loadBackupHealth()).toEqual(health);
	});

	it.each([null, -1, 'yesterday'])('replaces an invalid tracking baseline %s without losing backup history', async (trackedSince) => {
		const { state, vault } = setup();
		vault.pluginFiles.set('backup-health.json', enc.encode(JSON.stringify({ trackedSince, lastSuccessAt: 10, lastWarningAt: 20 })));
		expect(await state.loadBackupHealth()).toEqual({ trackedSince: NOW, lastSuccessAt: 10, lastWarningAt: 20 });
	});

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
		await state.saveBackupHealth({ trackedSince: NOW, lastSuccessAt: 1, lastWarningAt: null });
		const written = [...vault.pluginFiles.keys()].map((name) => `.obsidian/plugins/${PLUGIN_ID}/${name}`);
		expect(written.sort()).toEqual([
			'.obsidian/plugins/cloudflare-vault-backup/backup-health.json',
			'.obsidian/plugins/cloudflare-vault-backup/counters.json',
			'.obsidian/plugins/cloudflare-vault-backup/index.json',
			'.obsidian/plugins/cloudflare-vault-backup/log.json',
		]);
		const opts = { configDir: '.obsidian', includeConfigDir: true, excludeGlobs: [], pluginId: PLUGIN_ID };
		expect(written.filter((p) => isIncluded(p, opts))).toEqual([]);
	});
});
