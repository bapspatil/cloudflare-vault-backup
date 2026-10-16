import { SecretComponent, Setting, type App } from 'obsidian';

export interface IntOptions {
	min: number;
	max: number;
	get: () => number;
	set: (n: number) => Promise<void>;
}

export function addIntSetting(setting: Setting, opts: IntOptions): Setting {
	return setting.addText((text) => {
		text.setValue(String(opts.get()));
		text.inputEl.inputMode = 'numeric';
		text.inputEl.addClass('r2-vault-sync-number');
		text.onChange((raw) => {
			const n = parseInt(raw.trim(), 10);
			if (/^\d+$/.test(raw.trim()) && n >= opts.min && n <= opts.max) void opts.set(n);
		});
		text.inputEl.addEventListener('blur', () => {
			text.setValue(String(opts.get()));
		});
	});
}

export function addSecretSetting(
	app: App,
	setting: Setting,
	current: string,
	fallbackId: string,
	onId: (id: string) => Promise<void>,
): Setting {
	return setting.addComponent((el) =>
		new SecretComponent(app, el).setValue(current).onChange((id) => void onId(id && id.length > 0 ? id : fallbackId)),
	);
}

export function formatRelative(then: number, now: number): string {
	const sec = Math.max(0, Math.round((now - then) / 1000));
	if (sec < 60) return 'just now';
	const units: [number, string][] = [
		[86400, 'day'],
		[3600, 'hour'],
		[60, 'minute'],
	];
	for (const [size, name] of units) {
		if (sec >= size) {
			const n = Math.floor(sec / size);
			return `${n} ${name}${n === 1 ? '' : 's'} ago`;
		}
	}
	return 'just now';
}
