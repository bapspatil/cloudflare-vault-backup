import { Notice, type App } from 'obsidian';
import { loadSnapshotText, type RestoreDeps, type RestoreFileResult, type RestoreMode } from '../backup/restore-runner';
import { formatBytes } from '../core/cost';
import { parseSnapshotId } from '../core/manifest';
import type { Manifest, SnapshotId } from '../core/types';
import { ConfirmModal } from './confirm-modal';
import { DiffModal } from './diff-modal';

const ACKNOWLEDGE = 'I understand this can change plugin code';
const CONFIG_WARNING = 'This file is in the config folder. Plugin code and snippets there run when Obsidian loads.';
export const RELOAD_NOTICE = 'Config files were restored. Reload Obsidian to apply them.';

function stamp(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function snapshotLabel(id: SnapshotId, manifest: Manifest | undefined): string {
	const parsed = parseSnapshotId(id);
	const base = parsed ? stamp(parsed.createdAt) : id;
	if (!manifest) return base;
	const { files, bytes } = manifest.totals;
	return `${base} (device ${manifest.deviceId.slice(0, 8)}, ${files.toLocaleString()} files, ${formatBytes(bytes)})`;
}

export async function confirmFileRestore(app: App, path: string, mode: RestoreMode, config: boolean): Promise<boolean> {
	const overwrite = mode.kind === 'overwrite';
	if (!overwrite && !config) return true;
	const lead = overwrite
		? `The vault copy of ${path} will be replaced by the snapshot version.`
		: `A copy of ${path} will be written next to the original.`;
	const modal = new ConfirmModal(app)
		.setTitle(overwrite ? 'Overwrite file?' : 'Restore into the config folder?')
		.setBody(config ? `${lead}\n\n${CONFIG_WARNING}` : lead)
		.addDanger(overwrite ? 'Overwrite' : 'Restore as copy')
		.addCancel();
	if (config) modal.requireAcknowledge(ACKNOWLEDGE);
	return modal.ask();
}

export async function pickSnapshotMode(app: App, manifest: Manifest, hasConfig: boolean): Promise<RestoreMode | null> {
	const folder = `Restored/${manifest.id}`;
	let mode = { kind: 'into-folder', folder } as RestoreMode;
	const picked = await new ConfirmModal(app)
		.setTitle('Restore whole snapshot')
		.setBody(`Restore ${manifest.totals.files.toLocaleString()} files from ${snapshotLabel(manifest.id, manifest)}.`)
		.addAction(`Restore into ${folder}`)
		.addDanger('Overwrite in place', () => (mode = { kind: 'overwrite' }))
		.addCancel()
		.ask();
	if (!picked) return null;
	if (mode.kind !== 'overwrite') return mode;
	const modal = new ConfirmModal(app)
		.setTitle('Overwrite vault files?')
		.setBody(
			'Every file in the snapshot replaces its vault copy. Files that already match are skipped. A backup runs first so you can undo this.',
		)
		.requireTyped('restore')
		.addDanger('Overwrite in place')
		.addCancel();
	if (hasConfig) modal.requireAcknowledge(ACKNOWLEDGE);
	return (await modal.ask()) ? mode : null;
}

export function renderResults(el: HTMLElement, results: RestoreFileResult[]): void {
	el.empty();
	const count = (o: RestoreFileResult['outcome']) => results.filter((r) => r.outcome === o).length;
	el.createDiv({
		cls: 'r2-vault-sync-restore-summary',
		text: `Written ${count('written')}, unchanged ${count('unchanged')}, failed ${count('failed')}.`,
	});
	const failed = results.filter((r) => r.outcome === 'failed');
	if (failed.length === 0) return;
	const list = el.createEl('ul', { cls: 'r2-vault-sync-restore-failures' });
	for (const r of failed) list.createEl('li', { text: `${r.path}: ${r.detail ?? 'unknown error'}` });
}

export async function openDiff(app: App, deps: RestoreDeps, manifest: Manifest, path: string): Promise<void> {
	const snapshotText = await loadSnapshotText(deps, manifest, path);
	if (snapshotText === null) {
		new Notice('No diff available: the file is binary, too large, or missing from the snapshot.');
		return;
	}
	const inVault = await deps.vault.exists(path);
	const current = inVault ? new TextDecoder().decode(await deps.vault.read(path)) : '';
	new DiffModal(app, path, current, snapshotText, inVault ? null : 'Not in vault.').open();
}
