import { Modal, type App } from 'obsidian';
import { ERRORS } from '../core/run-machine';
import { formatBytes } from '../core/cost';
import type { RunLogEntry } from '../core/types';

function resultText(r: RunLogEntry['result']): string {
	if (r.kind === 'failed') return `${ERRORS[r.error.code].message} (${r.error.code}: ${r.error.detail})`;
	return r.snapshotId === null ? 'No changes' : r.snapshotId;
}

export class LogModal extends Modal {
	constructor(
		app: App,
		private readonly entries: RunLogEntry[],
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Backup log');
		if (this.entries.length === 0) {
			this.contentEl.createEl('p', { text: 'No backups have run yet.' });
			return;
		}
		const table = this.contentEl.createEl('table', { cls: 'r2-vault-sync-log' });
		const head = table.createEl('thead').createEl('tr');
		for (const h of ['Time', 'Trigger', 'Result', 'Uploaded']) head.createEl('th', { text: h });
		const body = table.createEl('tbody');
		for (const e of [...this.entries].sort((a, b) => b.startedAt - a.startedAt)) {
			const row = body.createEl('tr');
			row.createEl('td', { text: new Date(e.startedAt).toLocaleString() });
			row.createEl('td', { text: e.trigger });
			row.createEl('td', { text: resultText(e.result), cls: e.result.kind === 'failed' ? 'r2-vault-sync-log-failed' : '' });
			const stats = e.result.kind === 'done' ? e.result.stats : null;
			row.createEl('td', { text: stats ? `${stats.uploaded} files, ${formatBytes(stats.uploadedBytes)}` : '' });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
