import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalState } from '../../src/io/local-state';
import { loadSettings } from '../../src/settings';
import { StaleBackupWarning } from '../../src/ui/stale-backup-warning';
import { createMemoryVault } from '../helpers/memory-vault';

const notices = vi.hoisted(() => ({ shown: vi.fn(), hidden: vi.fn() }));
vi.mock('obsidian', () => ({
	Notice: class {
		constructor(message: string, timeout: number) { notices.shown(message, timeout); }
		hide() { notices.hidden(); }
	},
}));

const HOUR = 3_600_000;
const connection = { accountId: 'a'.repeat(32), bucket: 'backups' };

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(48 * HOUR);
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe('stale backup warning', () => {
	it.each([
		{ accountId: '', bucket: '' },
		{ accountId: '', bucket: 'backups' },
		{ accountId: connection.accountId, bucket: '' },
		{ accountId: '   ', bucket: 'backups' },
	])('suppresses notices and status warnings for an unconfigured connection: %j', async (missingConnection) => {
		const local = createLocalState(createMemoryVault());
		const status = vi.fn();
		const warning = new StaleBackupWarning({ trackedSince: 0, lastSuccessAt: null, lastWarningAt: null }, local, status);
		await warning.check(loadSettings({ vaultId: 'v1', connection: missingConnection }));
		expect(warning.stale).toBe(false);
		expect(status).toHaveBeenLastCalledWith(false);
		expect(notices.shown).not.toHaveBeenCalled();
	});

	it('clears an existing notice and status warning if the connection is removed', async () => {
		const local = createLocalState(createMemoryVault());
		const status = vi.fn();
		const warning = new StaleBackupWarning({ trackedSince: 0, lastSuccessAt: 0, lastWarningAt: null }, local, status);
		const settings = loadSettings({ vaultId: 'v1', connection });
		await warning.check(settings);
		expect(warning.stale).toBe(true);
		await warning.check({ ...settings, connection: { ...settings.connection, bucket: '' } });
		expect(warning.stale).toBe(false);
		expect(status).toHaveBeenLastCalledWith(false);
		expect(notices.hidden).toHaveBeenCalledOnce();
	});

	it('persists deduplication across reloads, retains the status warning, and clears on success', async () => {
		const vault = createMemoryVault({ files: { 'a.md': 'unchanged' } });
		const local = createLocalState(vault);
		const status = vi.fn();
		const settings = loadSettings({ vaultId: 'v1', connection });
		const warning = new StaleBackupWarning({ trackedSince: 0, lastSuccessAt: HOUR, lastWarningAt: null }, local, status);
		await warning.check(settings);
		expect(notices.shown).toHaveBeenCalledTimes(1);
		expect(notices.shown.mock.calls[0]?.[1]).toBe(0);
		expect(status).toHaveBeenLastCalledWith(true);
		await warning.check(settings);
		expect(notices.shown).toHaveBeenCalledTimes(1);
		warning.hide();
		const reloaded = new StaleBackupWarning(await local.loadBackupHealth(), local, status);
		await reloaded.check(settings);
		expect(notices.shown).toHaveBeenCalledTimes(1);
		expect(reloaded.stale).toBe(true);
		vi.setSystemTime(72 * HOUR);
		await reloaded.check(settings);
		expect(notices.shown).toHaveBeenCalledTimes(2);
		await reloaded.succeeded();
		expect(reloaded.stale).toBe(false);
		expect(status).toHaveBeenLastCalledWith(false);
		expect(notices.hidden).toHaveBeenCalledTimes(2);
		expect(await local.loadBackupHealth()).toEqual({ trackedSince: 0, lastSuccessAt: 72 * HOUR, lastWarningAt: null });
		await reloaded.check(settings);
		expect(notices.shown).toHaveBeenCalledTimes(2);
		expect(new TextDecoder().decode(vault.files.get('a.md'))).toBe('unchanged');
	});

	it('gives fresh installs a threshold window before warning and clears when scheduling or warnings are disabled', async () => {
		const settings = loadSettings({ vaultId: 'v1', connection });
		const local = createLocalState(createMemoryVault());
		const status = vi.fn();
		const warning = new StaleBackupWarning(await local.loadBackupHealth(), local, status);
		await warning.check(settings);
		expect(warning.stale).toBe(false);
		expect(notices.shown).not.toHaveBeenCalled();
		vi.setSystemTime(72 * HOUR + 1);
		await warning.check(settings);
		expect(warning.stale).toBe(true);
		expect(notices.shown.mock.calls[0]?.[0]).toContain('No successful backup');
		await warning.check({ ...settings, staleBackupWarningHours: 0 });
		expect(warning.stale).toBe(false);
		expect(status).toHaveBeenLastCalledWith(false);
		await warning.check({ ...settings, schedule: { ...settings.schedule, intervalMinutes: 0 } });
		expect(warning.stale).toBe(false);
		expect(notices.shown).toHaveBeenCalledTimes(1);
	});

	it('also warns when only startup backups are enabled', async () => {
		const settings = loadSettings({ vaultId: 'v1', connection, schedule: { intervalMinutes: 0, onStartup: true } });
		const local = createLocalState(createMemoryVault());
		const warning = new StaleBackupWarning(await local.loadBackupHealth(), local, () => {});
		vi.setSystemTime(72 * HOUR + 1);
		await warning.check(settings);
		expect(warning.stale).toBe(true);
	});

	it('keeps saves ordered across a warning immediately followed by success', async () => {
		const local = createLocalState(createMemoryVault());
		const warning = new StaleBackupWarning(await local.loadBackupHealth(), local, () => {});
		vi.setSystemTime(72 * HOUR + 1);
		const checked = warning.check(loadSettings({ vaultId: 'v1', connection }));
		const succeeded = warning.succeeded();
		await Promise.all([checked, succeeded]);
		expect(await local.loadBackupHealth()).toEqual({ trackedSince: 48 * HOUR, lastSuccessAt: Date.now(), lastWarningAt: null });
	});

	it('clears the visible warning even if persistence fails', async () => {
		const local = { saveBackupHealth: vi.fn().mockRejectedValue(new Error('disk unavailable')) };
		const warning = new StaleBackupWarning({ trackedSince: 0, lastSuccessAt: null, lastWarningAt: null }, local, () => {});
		await warning.check(loadSettings({ vaultId: 'v1', connection }));
		await warning.succeeded();
		expect(warning.stale).toBe(false);
		expect(notices.hidden).toHaveBeenCalledOnce();
	});
});
