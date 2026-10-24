import { setIcon } from 'obsidian';
import { LABEL } from '../core/run-machine';
import type { RunState } from '../core/types';

export class StatusBar {
	private readonly iconEl: HTMLElement;
	private readonly textEl: HTMLElement;

	constructor(
		private readonly el: HTMLElement,
		onClick: () => Promise<unknown>,
	) {
		el.addClass('mod-clickable', 'r2-vault-sync-status');
		this.iconEl = el.createSpan({ cls: 'r2-vault-sync-status-icon' });
		this.textEl = el.createSpan({ cls: 'r2-vault-sync-status-text' });
		el.setAttribute('aria-label', 'Back up vault to R2');
		el.addEventListener('click', () => void onClick());
		this.render({ kind: 'idle' });
	}

	render(state: RunState, stale = false): void {
		const busy = !['idle', 'done', 'failed'].includes(state.kind);
		setIcon(this.iconEl, stale ? 'alert-triangle' : state.kind === 'failed' ? 'cloud-off' : busy ? 'refresh-cw' : 'cloud-upload');
		this.textEl.setText(stale ? `Backup overdue · ${LABEL[state.kind](state)}` : LABEL[state.kind](state));
		this.el.toggleClass('r2-vault-sync-status-busy', busy);
		this.el.toggleClass('r2-vault-sync-status-failed', stale || state.kind === 'failed');
	}
}
