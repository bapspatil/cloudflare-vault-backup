import { Notice, PluginSettingTab, Setting, type App } from 'obsidian';
import type R2VaultSyncPlugin from '../main';
import { LABEL } from '../core/run-machine';
import type { RunState } from '../core/types';
import { LogModal } from './log-modal';
import { addIntSetting, addSecretSetting, formatRelative } from './settings-controls';
import { computeUsage, PRICE_NOTE } from './usage';

const INTERVALS: [number, string][] = [
	[0, 'Off'],
	[15, '15 minutes'],
	[30, '30 minutes'],
	[60, '1 hour'],
	[180, '3 hours'],
	[360, '6 hours'],
	[720, '12 hours'],
	[1440, '24 hours'],
];

export class SettingsTab extends PluginSettingTab {
	private unsubscribe: (() => void) | null = null;
	private stateEl: HTMLElement | null = null;
	private usageEl: HTMLElement | null = null;
	private generation = 0;

	constructor(
		app: App,
		readonly plugin: R2VaultSyncPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		this.hide();
		containerEl.empty();
		this.renderStatus(containerEl);
		this.renderConnection(containerEl);
		this.renderEncryption(containerEl);
		this.renderScope(containerEl);
		this.renderSchedule(containerEl);
		this.renderRetention(containerEl);
		this.renderUsage(containerEl);
		this.renderLog(containerEl);
	}

	hide(): void {
		this.generation++;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.stateEl = null;
		this.usageEl = null;
	}

	private save(): Promise<void> {
		return this.plugin.saveSettings();
	}

	private heading(el: HTMLElement, name: string): void {
		new Setting(el).setName(name).setHeading();
	}

	private renderStatus(el: HTMLElement): void {
		const gen = this.generation;
		const setting = new Setting(el).setName('Status').setDesc('Last backup: checking');
		const refresh = async () => {
			try {
				const log = await this.plugin.services.local.loadLog();
				if (gen !== this.generation) return;
				const newest = log.reduce(
					(m, e) => Math.max(m, e.endedAt),
					0,
				);
				setting.setDesc(newest === 0 ? 'No backups yet.' : `Last backup: ${formatRelative(newest, Date.now())}`);
			} catch {
				if (gen === this.generation) setting.setDesc('Last backup: unknown');
			}
		};
		setting.addButton((b) =>
			b.setButtonText('Back up now').setCta().onClick(async () => {
				b.setDisabled(true);
				await this.plugin.backupNow('manual');
				b.setDisabled(false);
				await refresh();
			}),
		);
		void refresh();
	}

	private renderConnection(el: HTMLElement): void {
		const c = this.plugin.settings.connection;
		this.heading(el, 'Connection');
		new Setting(el)
			.setName('Account ID')
			.setDesc('Your 32 character Cloudflare account ID.')
			.addText((t) =>
				t.setValue(c.accountId).onChange(async (v) => {
					c.accountId = v.trim();
					await this.save();
				}),
			);
		new Setting(el)
			.setName('Bucket')
			.setDesc('The R2 bucket that holds your backups.')
			.addText((t) =>
				t.setValue(c.bucket).onChange(async (v) => {
					c.bucket = v.trim();
					await this.save();
				}),
			);
		new Setting(el)
			.setName('Prefix')
			.setDesc('Folder inside the bucket. One bucket can hold several vaults.')
			.addText((t) =>
				t.setValue(c.prefix).onChange(async (v) => {
					c.prefix = v.trim();
					await this.save();
				}),
			);
		const keyDesc = "Keys are stored in Obsidian's secret storage, not in the plugin data file.";
		addSecretSetting(this.app, new Setting(el).setName('Access key ID').setDesc(keyDesc), c.accessKeyIdSecretId, 'r2-vault-sync-access-key-id', async (id) => {
			c.accessKeyIdSecretId = id;
			await this.save();
		});
		addSecretSetting(this.app, new Setting(el).setName('Secret access key').setDesc(keyDesc), c.secretKeySecretId, 'r2-vault-sync-secret-access-key', async (id) => {
			c.secretKeySecretId = id;
			await this.save();
		});
		const test = new Setting(el).setName('Test connection').setDesc('Writes, reads and deletes a small probe object.');
		test.addButton((b) =>
			b.setButtonText('Test connection').onClick(async () => {
				b.setDisabled(true);
				test.setDesc('Testing...');
				test.setDesc(await this.plugin.testConnection());
				b.setDisabled(false);
			}),
		);
	}

	private renderEncryption(el: HTMLElement): void {
		const e = this.plugin.settings.encryption;
		this.heading(el, 'Encryption');
		new Setting(el)
			.setName('Encrypt backups')
			.setDesc(
				'Files are encrypted on this device before upload. A lost passphrase means the backup cannot be read. Turning encryption on or off for an existing backup set requires a new prefix.',
			)
			.addToggle((t) =>
				t.setValue(e.enabled).onChange(async (v) => {
					e.enabled = v;
					this.plugin.services.forgetKeys();
					await this.save();
				}),
			);
		addSecretSetting(this.app, new Setting(el).setName('Passphrase').setDesc("Stored in Obsidian's secret storage."), e.passphraseSecretId, 'r2-vault-sync-passphrase', async (id) => {
			e.passphraseSecretId = id;
			this.plugin.services.forgetKeys();
			await this.save();
		});
	}

	private renderScope(el: HTMLElement): void {
		const s = this.plugin.settings.scope;
		this.heading(el, 'What to back up');
		new Setting(el)
			.setName('Include configuration folder')
			.setDesc('Back up plugins, themes and snippets. Workspace files and this plugin\'s own data are always skipped.')
			.addToggle((t) =>
				t.setValue(s.includeConfigDir).onChange(async (v) => {
					s.includeConfigDir = v;
					await this.save();
				}),
			);
		new Setting(el)
			.setName('Exclude patterns')
			.setDesc('One glob per line, for example Templates/** or *.pdf.')
			.addTextArea((t) =>
				t.setValue(s.excludeGlobs.join('\n')).onChange(async (v) => {
					s.excludeGlobs = v.split('\n').map((l) => l.trim()).filter((l) => l !== '');
					await this.save();
				}),
			);
		addIntSetting(new Setting(el).setName('Maximum file size on desktop (megabytes)'), {
			min: 1,
			max: 10_000,
			get: () => s.maxFileSizeMb,
			set: async (n) => {
				s.maxFileSizeMb = n;
				await this.save();
			},
		});
		addIntSetting(new Setting(el).setName('Maximum file size on mobile (megabytes)'), {
			min: 1,
			max: 10_000,
			get: () => s.maxFileSizeMbMobile,
			set: async (n) => {
				s.maxFileSizeMbMobile = n;
				await this.save();
			},
		});
	}

	private renderSchedule(el: HTMLElement): void {
		const s = this.plugin.settings.schedule;
		this.heading(el, 'Schedule');
		const options = INTERVALS.some(([m]) => m === s.intervalMinutes) ? INTERVALS : [...INTERVALS, [s.intervalMinutes, `${s.intervalMinutes} minutes (custom)`] as [number, string]];
		new Setting(el).setName('Backup interval').addDropdown((d) => {
			for (const [m, label] of options) d.addOption(String(m), label);
			d.setValue(String(s.intervalMinutes)).onChange(async (v) => {
				s.intervalMinutes = Number(v);
				await this.save();
			});
		});
		new Setting(el)
			.setName('Quiet period after edits (seconds)')
			.setDesc('Wait this long after the last edit before a scheduled backup starts.')
			.addSlider((sl) =>
				sl
					.setLimits(0, 600, 30)
					.setValue(s.quietSeconds)
					.onChange(async (v) => {
						s.quietSeconds = v;
						await this.save();
					}),
			);
		new Setting(el).setName('Back up on startup').addToggle((t) =>
			t.setValue(s.onStartup).onChange(async (v) => {
				s.onStartup = v;
				await this.save();
			}),
		);
	}

	private renderRetention(el: HTMLElement): void {
		const r = this.plugin.settings.retention;
		this.heading(el, 'Retention');
		const rows: [string, keyof typeof r, string?][] = [
			['Keep latest', 'keepLast', 'Number of most recent snapshots to keep.'],
			['Keep daily', 'daily'],
			['Keep weekly', 'weekly'],
			['Keep monthly', 'monthly'],
			['Grace period before deleting unreferenced data (hours)', 'graceHours'],
			['Garbage collection interval (hours)', 'gcIntervalHours'],
		];
		for (const [name, key, desc] of rows) {
			const setting = new Setting(el).setName(name);
			if (desc) setting.setDesc(desc);
			addIntSetting(setting, {
				min: 0,
				max: 100_000,
				get: () => r[key],
				set: async (n) => {
					r[key] = n;
					await this.save();
				},
			});
		}
	}

	private renderUsage(el: HTMLElement): void {
		this.heading(el, 'Usage and cost');
		const setting = new Setting(el).setName('Estimate').setDesc(PRICE_NOTE);
		setting.addButton((b) => b.setButtonText('Refresh').onClick(() => void this.loadUsage()));
		this.usageEl = el.createEl('pre', { cls: 'r2-vault-sync-usage', text: 'Loading...' });
		void this.loadUsage();
	}

	private async loadUsage(): Promise<void> {
		const gen = this.generation;
		const target = this.usageEl;
		if (!target) return;
		target.setText('Loading...');
		const c = this.plugin.settings.connection;
		const configured = /^[0-9a-f]{32}$/i.test(c.accountId) && c.bucket !== '';
		let text: string;
		try {
			text = await computeUsage(this.plugin.services, configured);
		} catch (e) {
			text = `Could not load usage: ${e instanceof Error ? e.message : String(e)}`;
		}
		if (gen === this.generation) target.setText(text);
	}

	private renderLog(el: HTMLElement): void {
		this.heading(el, 'Backup log');
		const setting = new Setting(el).setName('Current state').setDesc(LABEL[this.plugin.state.kind](this.plugin.state));
		this.stateEl = setting.descEl;
		this.unsubscribe = this.plugin.onState((s: RunState) => this.stateEl?.setText(LABEL[s.kind](s)));
		setting.addButton((b) =>
			b.setButtonText('View log').onClick(async () => {
				try {
					new LogModal(this.app, await this.plugin.services.local.loadLog()).open();
				} catch (e) {
					new Notice(`Could not read the log: ${e instanceof Error ? e.message : String(e)}`);
				}
			}),
		);
	}
}
