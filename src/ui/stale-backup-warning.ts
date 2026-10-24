import { Notice } from 'obsidian';
import { decideStaleBackup, type BackupHealth } from '../core/stale-backup';
import type { LocalState } from '../io/types';
import type { Settings } from '../settings';

export class StaleBackupWarning {
	stale = false;
	private notice: Notice | null = null;
	private pendingSave: Promise<void> = Promise.resolve();

	constructor(
		private health: BackupHealth,
		private readonly local: Pick<LocalState, 'saveBackupHealth'>,
		private readonly onChange: (stale: boolean) => void,
	) {}

	check(settings: Pick<Settings, 'connection' | 'schedule' | 'staleBackupWarningHours'>): Promise<void> {
		const now = Date.now();
		const decision = decideStaleBackup({
			...this.health,
			now,
			scheduled: settings.schedule.intervalMinutes > 0 || settings.schedule.onStartup,
			configured: settings.connection.accountId.trim() !== '' && settings.connection.bucket.trim() !== '',
			thresholdHours: settings.staleBackupWarningHours,
		});
		this.stale = decision.stale;
		this.onChange(this.stale);
		if (!this.stale) this.hide();
		if (!decision.notify) return this.pendingSave;
		this.hide();
		const detail = this.health.lastSuccessAt === null
			? 'No successful backup has been recorded on this device.'
			: `The last successful backup is older than ${settings.staleBackupWarningHours} hours.`;
		this.notice = new Notice(`Backup warning: ${detail} Check your backup settings and connection.`, 0);
		this.health = { ...this.health, lastWarningAt: now };
		return this.save();
	}

	succeeded(): Promise<void> {
		this.health = { ...this.health, lastSuccessAt: Date.now(), lastWarningAt: null };
		this.stale = false;
		this.hide();
		this.onChange(false);
		return this.save();
	}

	hide(): void {
		this.notice?.hide();
		this.notice = null;
	}

	private save(): Promise<void> {
		const health = this.health;
		this.pendingSave = this.pendingSave.then(() => this.local.saveBackupHealth(health)).catch(() => undefined);
		return this.pendingSave;
	}
}
