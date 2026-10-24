import type { App, Command, PluginManifest } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createObsidianVaultPort } from '../../src/io/vault-port';
import type { Services } from '../../src/services';
import R2VaultSyncPlugin from '../../src/main';
import { createFakeR2 } from '../helpers/fake-r2';
import { createMemoryVault } from '../helpers/memory-vault';

const mocks = vi.hoisted(() => ({ notices: vi.fn(), hidden: vi.fn(), commands: [] as Command[], cleanup: [] as Array<() => void> }));
vi.mock('obsidian', () => ({
	Plugin: class {
		constructor(readonly app: App, readonly manifest: PluginManifest) {}
		async loadData() { return { vaultId: 'v1', schedule: { intervalMinutes: 0 }, connection: { accountId: 'a'.repeat(32), bucket: 'backups' } }; }
		async saveData() {}
		addSettingTab() {}
		registerView() {}
		addRibbonIcon() {}
		addCommand(command: Command) { mocks.commands.push(command); }
		register(cleanup: () => void) { mocks.cleanup.push(cleanup); }
	},
	Notice: class {
		constructor(message: string, timeout?: number) { mocks.notices(message, timeout); }
		hide() { mocks.hidden(); }
	},
	Platform: { isMobile: true },
}));
vi.mock('../../src/io/vault-port', () => ({ createObsidianVaultPort: vi.fn() }));
vi.mock('../../src/ui/settings-tab', () => ({ SettingsTab: class {} }));
vi.mock('../../src/ui/restore-view', () => ({ RestoreView: class {}, RESTORE_VIEW_TYPE: 'restore' }));

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(Date.parse('2026-10-24T12:00:00Z'));
	vi.stubGlobal('window', { setInterval, clearInterval });
});

afterEach(() => {
	for (const cleanup of mocks.cleanup) cleanup();
	mocks.cleanup.length = 0;
	mocks.commands.length = 0;
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function setup() {
	const vault = createMemoryVault({ files: { 'a.md': 'alpha' } });
	vi.mocked(createObsidianVaultPort).mockReturnValue(vault);
	const app = {
		workspace: { onLayoutReady: () => {} },
		loadLocalStorage: () => 'device',
	} as unknown as App;
	const plugin = new R2VaultSyncPlugin(app, {
		id: 'cloudflare-vault-backup', name: 'Cloudflare Vault Backup', version: '1.3.0',
		minAppVersion: '1.11.4', description: 'Backup', author: 'Test',
	});
	await plugin.onload();
	const client = createFakeR2();
	vi.spyOn(plugin.services, 'client').mockResolvedValue({ client, root: 'backups/v1' });
	return { plugin, client, vault };
}

describe('backup reliability commands', () => {
	it('registers verification and reports a successful check without modifying the bucket or vault', async () => {
		const { plugin, client, vault } = await setup();
		expect(mocks.commands.find((command) => command.id === 'verify-latest-backup')?.name).toBe('Verify latest backup');
		expect((await plugin.backupNow('manual')).kind).toBe('done');
		const before = structuredClone({ objects: client.objects, files: vault.files, pluginFiles: vault.pluginFiles });
		await plugin.verifyLatestBackup();
		expect(mocks.notices).toHaveBeenLastCalledWith(expect.stringContaining('Backup verification OK: 1 blobs'), 15_000);
		expect({ objects: client.objects, files: vault.files, pluginFiles: vault.pluginFiles }).toEqual(before);
	});

	it('blocks verification as soon as backup setup starts', async () => {
		const { plugin } = await setup();
		const original = plugin.services.services.bind(plugin.services);
		let release = () => {};
		const wait = new Promise<void>((resolve) => { release = resolve; });
		const services = vi.spyOn(plugin.services, 'services').mockImplementation(async () => {
			await wait;
			return original();
		});
		const backup = plugin.backupNow('manual');
		expect(plugin.isRunning()).toBe(true);
		await plugin.verifyLatestBackup();
		expect(services).toHaveBeenCalledOnce();
		expect(mocks.notices).toHaveBeenLastCalledWith(expect.stringContaining('already running'), undefined);
		release();
		await backup;
		expect(plugin.isRunning()).toBe(false);
	});

	it('blocks backups and duplicate verification while verification setup is pending, and releases on failure', async () => {
		const { plugin } = await setup();
		let rejectSetup = (_error: Error) => {};
		const services = vi.spyOn(plugin.services, 'services').mockImplementation(() => new Promise<Services>((_resolve, reject) => { rejectSetup = reject; }));
		const verification = plugin.verifyLatestBackup();
		expect(plugin.isRunning()).toBe(true);
		await plugin.backupNow('scheduled');
		await plugin.verifyLatestBackup();
		expect(services).toHaveBeenCalledExactlyOnceWith(true);
		rejectSetup(new Error('network unavailable'));
		await verification;
		expect(plugin.isRunning()).toBe(false);
		expect(mocks.notices).toHaveBeenLastCalledWith('Backup verification failed: network unavailable', 8000);
	});

	it('shows a persistent warning after setup failure and clears it after a successful backup', async () => {
		const { plugin } = await setup();
		const trackedSince = Date.now();
		vi.setSystemTime(trackedSince + 25 * 3_600_000);
		plugin.settings.schedule.intervalMinutes = 60;
		vi.spyOn(plugin.services, 'services').mockRejectedValueOnce(new Error('network unavailable'));
		expect((await plugin.backupNow('scheduled')).kind).toBe('failed');
		expect(mocks.notices).toHaveBeenCalledWith(expect.stringContaining('Backup warning:'), 0);
		await plugin.backupNow('scheduled');
		expect(mocks.hidden).toHaveBeenCalledOnce();
		expect(await plugin.services.local.loadBackupHealth()).toEqual({ trackedSince, lastSuccessAt: Date.now(), lastWarningAt: null });
	});

	it('checks failed runner results as well as setup failures, without repeating notices', async () => {
		const { plugin, client } = await setup();
		vi.setSystemTime(Date.now() + 25 * 3_600_000);
		plugin.settings.schedule.intervalMinutes = 60;
		vi.spyOn(client, 'put').mockRejectedValue(new Error('network unavailable'));
		expect((await plugin.backupNow('scheduled')).kind).toBe('failed');
		expect((await plugin.backupNow('scheduled')).kind).toBe('failed');
		expect(mocks.notices.mock.calls.filter(([, timeout]) => timeout === 0)).toHaveLength(1);
	});

	it('loads a stale success on startup and preserves it independently of the run log', async () => {
		const { plugin, vault } = await setup();
		await plugin.services.local.appendLog({
			startedAt: 1, endedAt: 2, trigger: 'scheduled',
			result: { kind: 'done', snapshotId: null, stats: { scanned: 0, uploaded: 0, uploadedBytes: 0, reused: 0, skipped: 0, durationMs: 1 } },
		});
		vault.pluginFiles.delete('backup-health.json');
		const reloaded = new R2VaultSyncPlugin(plugin.app, plugin.manifest);
		vi.spyOn(reloaded, 'loadData').mockResolvedValue({ vaultId: 'v1', connection: plugin.settings.connection, schedule: { intervalMinutes: 60 } });
		await reloaded.onload();
		expect(mocks.notices).toHaveBeenCalledWith(expect.stringContaining('older than 24 hours'), 0);
		expect(await reloaded.services.local.loadBackupHealth()).toEqual({ trackedSince: Date.now(), lastSuccessAt: 2, lastWarningAt: Date.now() });
	});

	it('persists the first-run baseline across reloads and warns only after the threshold', async () => {
		const { plugin } = await setup();
		const trackedSince = Date.now();
		const reloaded = new R2VaultSyncPlugin(plugin.app, plugin.manifest);
		vi.spyOn(reloaded, 'loadData').mockResolvedValue({ vaultId: 'v1', connection: plugin.settings.connection });
		vi.setSystemTime(trackedSince + 3_600_000);
		await reloaded.onload();
		expect(await reloaded.services.local.loadBackupHealth()).toEqual({ trackedSince, lastSuccessAt: null, lastWarningAt: null });
		expect(mocks.notices).not.toHaveBeenCalled();
		vi.setSystemTime(trackedSince + 24 * 3_600_000 + 1);
		await reloaded.saveSettings();
		expect(mocks.notices).toHaveBeenCalledWith(expect.stringContaining('No successful backup'), 0);
	});
});
