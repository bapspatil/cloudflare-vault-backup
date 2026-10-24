import { Notice, Platform, Plugin, normalizePath, type WorkspaceLeaf } from 'obsidian';
import { runBackup } from './backup/backup-runner';
import { runLockedPrune } from './backup/prune-runner';
import { runVerify } from './backup/verify-runner';
import { createScheduler, type Scheduler } from './backup/scheduler';
import { ERRORS, LABEL } from './core/run-machine';
import type { RunLogEntry, RunState } from './core/types';
import { LEGACY_PLUGIN_ID, loadSettings, type Settings } from './settings';
import { probeConnection, ServiceFactory, SetupError } from './services';
import { createRemoteStore } from './io/remote-store';
import { RestoreView, RESTORE_VIEW_TYPE } from './ui/restore-view';
import { SettingsTab } from './ui/settings-tab';
import { StatusBar } from './ui/status-bar';
import { StaleBackupWarning } from './ui/stale-backup-warning';

export default class R2VaultSyncPlugin extends Plugin {
	settings!: Settings;
	services!: ServiceFactory;
	state: RunState = { kind: 'idle' };
	private scheduler!: Scheduler;
	private statusBar: StatusBar | null = null;
	private staleWarning: StaleBackupWarning | null = null;
	private lastRunEndedAt: number | null = null;
	private exclusiveTasks = 0;
	private readonly stateListeners = new Set<(s: RunState) => void>();

	async onload() {
		this.settings = loadSettings((await this.loadData()) ?? (await this.loadLegacyData()));
		await this.saveSettings();
		this.services = new ServiceFactory(this.app, () => this.settings);

		if (!Platform.isMobile) this.statusBar = new StatusBar(this.addStatusBarItem(), () => this.backupNow('manual'));
		const health = await this.services.local.loadBackupHealth().catch(() => ({ trackedSince: Date.now(), lastSuccessAt: null, lastWarningAt: null }));
		await this.services.local.saveBackupHealth(health).catch(() => undefined);
		this.staleWarning = new StaleBackupWarning(health, this.services.local, (stale) => this.statusBar?.render(this.state, stale));
		await this.staleWarning.check(this.settings);
		this.register(() => this.staleWarning?.hide());
		this.addSettingTab(new SettingsTab(this.app, this));
		this.registerView(RESTORE_VIEW_TYPE, (leaf: WorkspaceLeaf) => new RestoreView(leaf, this));
		this.addRibbonIcon('cloud-upload', 'Back up vault to R2', () => void this.backupNow('manual'));

		this.addCommand({ id: 'back-up-now', name: 'Back up now', callback: () => void this.backupNow('manual') });
		this.addCommand({ id: 'open-restore-view', name: 'Open restore browser', callback: () => void this.openRestoreView() });
		this.addCommand({ id: 'test-connection', name: 'Test R2 connection', callback: () => void this.testConnection() });
		this.addCommand({ id: 'prune-now', name: 'Prune old snapshots now', callback: () => void this.pruneNow() });
		this.addCommand({ id: 'verify-latest-backup', name: 'Verify latest backup', callback: () => void this.verifyLatestBackup() });

		this.scheduler = createScheduler({
			now: Date.now,
			setInterval: (fn, ms) => window.setInterval(fn, ms),
			clearInterval: (id) => window.clearInterval(id),
			getSettings: () => this.settings.schedule,
			isRunning: () => this.isRunning(),
			lastRunEndedAt: () => this.lastRunEndedAt,
			run: () => this.backupNow('scheduled'),
			onTick: () => void this.staleWarning?.check(this.settings),
		});
		this.register(() => this.scheduler.stop());

		this.app.workspace.onLayoutReady(() => {
			const note = () => this.scheduler.noteVaultEvent();
			this.registerEvent(this.app.vault.on('create', note));
			this.registerEvent(this.app.vault.on('modify', note));
			this.registerEvent(this.app.vault.on('delete', note));
			this.registerEvent(this.app.vault.on('rename', note));
			this.scheduler.start();
			if (this.settings.schedule.onStartup) {
				const startup = window.setTimeout(() => void this.backupNow('startup'), 30_000);
				this.register(() => window.clearTimeout(startup));
			}
		});
	}

	onunload() {
		this.statusBar = null;
	}

	// Versions before 1.2.1 used the plugin id r2-vault-sync, which another author's plugin also
	// uses, so the old folder is adopted only when its manifest names this plugin's author. Adopting
	// its settings keeps the vaultId, so this install keeps backing up to the same backup set.
	private async loadLegacyData(): Promise<unknown> {
		const dir = normalizePath(`${this.app.vault.configDir}/plugins/${LEGACY_PLUGIN_ID}`);
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(`${dir}/data.json`)) || !(await adapter.exists(`${dir}/manifest.json`))) return null;
		try {
			const manifest = JSON.parse(await adapter.read(`${dir}/manifest.json`)) as { author?: unknown };
			if (manifest.author !== this.manifest.author) return null;
			const data: unknown = JSON.parse(await adapter.read(`${dir}/data.json`));
			new Notice('Copied settings from the old install of this plugin. Uninstall the old copy from your community plugins.');
			return data;
		} catch {
			return null;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		await this.staleWarning?.check(this.settings);
	}

	isRunning(): boolean {
		return this.exclusiveTasks > 0 || !['idle', 'done', 'failed'].includes(this.state.kind);
	}

	async runExclusive<T>(task: () => Promise<T>): Promise<T> {
		this.exclusiveTasks++;
		try {
			return await task();
		} finally {
			this.exclusiveTasks--;
		}
	}

	onState(listener: (s: RunState) => void): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	private setState(state: RunState) {
		this.state = state;
		this.statusBar?.render(state, this.staleWarning?.stale);
		for (const l of this.stateListeners) l(state);
	}

	async backupNow(trigger: RunLogEntry['trigger']): Promise<RunState> {
		if (this.isRunning()) {
			if (trigger === 'manual') new Notice('A backup is already running.');
			return this.state;
		}
		return this.runExclusive(async () => {
			try {
				const ctx = await this.services.context((s) => this.setState(s), this.manifest.version);
				const result = await runBackup(ctx, trigger);
				if (result.kind === 'done') await this.staleWarning?.succeeded();
				else await this.staleWarning?.check(this.settings);
				await this.services.local.saveCounters(ctx.client.counters());
				this.lastRunEndedAt = Date.now();
				if (result.kind === 'failed') {
					new Notice(`Backup failed: ${ERRORS[result.error.code].message}`, 8000);
				} else if (trigger === 'manual') {
					new Notice(LABEL.done(result));
				}
				return result;
			} catch (e) {
				this.lastRunEndedAt = Date.now();
				const detail = e instanceof Error ? e.message : String(e);
				const failed: RunState = { kind: 'failed', phase: 'idle', error: { code: e instanceof SetupError ? 'auth' : 'io', detail } };
				this.setState(failed);
				new Notice(detail, 8000);
				await this.staleWarning?.check(this.settings);
				return failed;
			}
		});
	}

	async verifyLatestBackup(): Promise<void> {
		if (this.isRunning()) {
			new Notice('A backup or maintenance task is already running.');
			return;
		}
		await this.runExclusive(async () => {
			try {
				const { client, root, sealer } = await this.services.services(true);
				const result = await runVerify({ store: createRemoteStore(client, root, sealer), random: Math.random });
				const counts = `${result.blobs} blobs checked for existence, ${result.verified}/${result.sampled} sampled blobs verified`;
				const issues = [
					...result.missing.map((hash) => `Missing: ${hash}`),
					...result.corrupt.map((hash) => `Corrupt: ${hash}`),
				];
				new Notice(issues.length === 0
					? `Backup verification OK: ${counts}.`
					: `Backup verification: ${counts}; ${result.missing.length} missing, ${result.corrupt.length} corrupt.\n${issues.slice(0, 5).join('\n')}${issues.length > 5 ? '\n…' : ''}`, 15_000);
			} catch (e) {
				new Notice(`Backup verification failed: ${e instanceof Error ? e.message : String(e)}`, 8000);
			}
		});
	}

	async testConnection(): Promise<string> {
		try {
			const { client, root } = await this.services.client();
			const steps = await probeConnection(client, root);
			const summary = steps.join(', ');
			new Notice(`R2 connection: ${summary}`);
			return summary;
		} catch (e) {
			const detail = e instanceof Error ? e.message : String(e);
			new Notice(`R2 connection failed: ${detail}`, 8000);
			return detail;
		}
	}

	async pruneNow(): Promise<void> {
		if (this.isRunning()) {
			new Notice('A backup is already running.');
			return;
		}
		await this.runExclusive(async () => {
			try {
				const ctx = await this.services.context((s) => this.setState(s), this.manifest.version);
				this.setState({ kind: 'pruning', deleted: 0 });
				const result = await runLockedPrune(ctx, (deleted) => this.setState({ kind: 'pruning', deleted }));
				this.setState({ kind: 'idle' });
				new Notice(
					result.kind === 'locked'
						? 'Another device is backing up. Try pruning again later.'
						: `Pruned ${result.manifestsDeleted} snapshots and ${result.blobsDeleted} blobs.`,
				);
			} catch (e) {
				this.setState({ kind: 'idle' });
				new Notice(`Prune failed: ${e instanceof Error ? e.message : String(e)}`, 8000);
			}
		});
	}

	async openRestoreView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(RESTORE_VIEW_TYPE)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: RESTORE_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}
}
