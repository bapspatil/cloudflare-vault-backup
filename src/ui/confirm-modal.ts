import { ButtonComponent, Modal, Setting, type App } from 'obsidian';

interface Action {
	label: string;
	style: 'cta' | 'warning';
	onConfirm: () => void;
}

export class ConfirmModal extends Modal {
	private body = '';
	private readonly actions: Action[] = [];
	private cancelLabel: string | null = null;
	private typedWord: string | null = null;
	private acknowledgeLabel: string | null = null;
	private typed = '';
	private acknowledged = false;
	private readonly confirmButtons: ButtonComponent[] = [];
	private resolve: ((ok: boolean) => void) | null = null;

	constructor(app: App) {
		super(app);
	}

	setBody(text: string): this {
		this.body = text;
		return this;
	}

	addAction(label: string, onConfirm: () => void = () => {}): this {
		this.actions.push({ label, style: 'cta', onConfirm });
		return this;
	}

	addDanger(label: string, onConfirm: () => void = () => {}): this {
		this.actions.push({ label, style: 'warning', onConfirm });
		return this;
	}

	addCancel(label = 'Cancel'): this {
		this.cancelLabel = label;
		return this;
	}

	requireTyped(word: string): this {
		this.typedWord = word;
		return this;
	}

	requireAcknowledge(label: string): this {
		this.acknowledgeLabel = label;
		return this;
	}

	ask(): Promise<boolean> {
		const result = new Promise<boolean>((resolve) => (this.resolve = resolve));
		this.open();
		return result;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('r2-vault-sync-restore-confirm');
		if (this.body) {
			for (const para of this.body.split('\n\n')) contentEl.createEl('p', { text: para });
		}
		if (this.acknowledgeLabel !== null) {
			new Setting(contentEl).setName(this.acknowledgeLabel).addToggle((t) =>
				t.setValue(false).onChange((v) => {
					this.acknowledged = v;
					this.refresh();
				}),
			);
		}
		if (this.typedWord !== null) {
			const word = this.typedWord;
			new Setting(contentEl).setName(`Type "${word}" to confirm`).addText((t) =>
				t.setPlaceholder(word).onChange((v) => {
					this.typed = v.trim();
					this.refresh();
				}),
			);
		}
		const row = contentEl.createDiv({ cls: 'modal-button-container' });
		for (const action of this.actions) {
			const button = new ButtonComponent(row).setButtonText(action.label).onClick(() => {
				if (!this.ready()) return;
				action.onConfirm();
				this.finish(true);
			});
			if (action.style === 'cta') button.setCta();
			else button.buttonEl.addClass('mod-warning');
			this.confirmButtons.push(button);
		}
		if (this.cancelLabel !== null) {
			new ButtonComponent(row).setButtonText(this.cancelLabel).onClick(() => this.finish(false));
		}
		this.refresh();
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve?.(false);
		this.resolve = null;
	}

	private ready(): boolean {
		const typedOk = this.typedWord === null || this.typed.toLowerCase() === this.typedWord.toLowerCase();
		const ackOk = this.acknowledgeLabel === null || this.acknowledged;
		return typedOk && ackOk;
	}

	private refresh(): void {
		const ready = this.ready();
		for (const b of this.confirmButtons) b.setDisabled(!ready);
	}

	private finish(ok: boolean): void {
		this.resolve?.(ok);
		this.resolve = null;
		this.close();
	}
}
