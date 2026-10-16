import { ButtonComponent, DropdownComponent, ItemView, Notice, SearchComponent, type WorkspaceLeaf } from 'obsidian';
import { restoreFile, restoreSnapshot, type RestoreDeps, type RestoreMode } from '../backup/restore-runner';
import { isRestoreConfigPath } from '../core/paths';
import { buildTree, type TreeNode } from '../core/tree';
import type { Manifest, SnapshotId } from '../core/types';
import { createRemoteStore } from '../io/remote-store';
import type { RemoteStore } from '../io/types';
import type R2VaultSyncPlugin from '../main';
import type { Services } from '../services';
import {
	confirmFileRestore,
	openDiff,
	pickSnapshotMode,
	RELOAD_NOTICE,
	renderResults,
	snapshotLabel,
} from './restore-prompts';
import { renderTree } from './restore-tree';

export const RESTORE_VIEW_TYPE = 'r2-vault-sync-restore';

const MAX_FILTERED = 500;

interface Els {
	dropdown: DropdownComponent;
	status: HTMLElement;
	note: HTMLElement;
	tree: HTMLElement;
	footer: HTMLElement;
	results: HTMLElement;
}

interface Session {
	services: Services;
	store: RemoteStore;
	ids: SnapshotId[];
	manifests: Map<SnapshotId, Manifest>;
	trees: Map<SnapshotId, TreeNode>;
	selected: SnapshotId | null;
}

type Phase =
	| { kind: 'empty' }
	| { kind: 'loading' }
	| { kind: 'error'; message: string }
	| { kind: 'ready'; session: Session };

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class RestoreView extends ItemView {
	private phase: Phase = { kind: 'empty' };
	private busy: string | null = null;
	private actionError: string | null = null;
	private filter = '';
	private readonly expanded = new Set<string>();
	private generation = 0;
	private unsubscribe: (() => void) | null = null;
	private els: Els | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		readonly plugin: R2VaultSyncPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return RESTORE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'R2 vault sync restore';
	}

	getIcon(): string {
		return 'history';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('r2-vault-sync-restore');
		const header = root.createDiv({ cls: 'r2-vault-sync-restore-header' });
		new ButtonComponent(header).setButtonText('Refresh').onClick(() => this.guard(() => this.refresh()));
		const dropdown = new DropdownComponent(header).onChange((id) => this.guard(() => this.select(id)));
		dropdown.selectEl.addClass('r2-vault-sync-restore-snapshots');
		new SearchComponent(root.createDiv({ cls: 'r2-vault-sync-restore-search' }))
			.setPlaceholder('Filter files')
			.onChange((q) => {
				this.filter = q.trim().toLowerCase();
				this.renderFiles();
			});
		const status = root.createDiv({ cls: 'r2-vault-sync-restore-status' });
		const note = root.createDiv({ cls: 'r2-vault-sync-restore-message' });
		const tree = root.createDiv({ cls: 'r2-vault-sync-restore-tree' });
		const footer = root.createDiv({ cls: 'r2-vault-sync-restore-footer' });
		const results = root.createDiv({ cls: 'r2-vault-sync-restore-results' });
		this.els = { dropdown, status, note, tree, footer, results };
		let wasRunning = this.plugin.isRunning();
		this.unsubscribe = this.plugin.onState(() => {
			if (this.plugin.isRunning() === wasRunning) return;
			wasRunning = this.plugin.isRunning();
			this.render();
		});
		this.render();
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.generation++;
		this.phase = { kind: 'empty' };
		this.expanded.clear();
		this.els = null;
		this.contentEl.empty();
	}

	private guard(task: () => Promise<void>): void {
		void task().catch((e: unknown) => {
			this.actionError = errorText(e);
			this.busy = null;
			this.render();
		});
	}

	private session(): Session | null {
		return this.phase.kind === 'ready' ? this.phase.session : null;
	}

	private selectedManifest(): Manifest | null {
		const s = this.session();
		return s?.selected ? (s.manifests.get(s.selected) ?? null) : null;
	}

	private disabledReason(): string | null {
		if (this.plugin.isRunning()) return 'A backup is running. Restore actions return when it finishes.';
		return this.busy;
	}

	private async refresh(): Promise<void> {
		const gen = ++this.generation;
		this.phase = { kind: 'loading' };
		this.actionError = null;
		this.render();
		try {
			const services = await this.plugin.services.services();
			const store = createRemoteStore(services.client, services.root, services.sealer);
			const ids = (await store.listSnapshots()).reverse();
			if (gen !== this.generation) return;
			const session: Session = { services, store, ids, manifests: new Map(), trees: new Map(), selected: null };
			this.phase = { kind: 'ready', session };
			this.render();
			const newest = ids[0];
			if (newest) this.guard(() => this.select(newest));
		} catch (e) {
			if (gen !== this.generation) return;
			this.phase = { kind: 'error', message: errorText(e) };
			this.render();
		}
	}

	private async select(id: SnapshotId): Promise<void> {
		const s = this.session();
		if (!s) return;
		s.selected = id;
		this.expanded.clear();
		this.els?.results.empty();
		this.render();
		if (s.manifests.has(id)) return;
		const manifest = await s.store.readManifest(id);
		if (!manifest) throw new Error(`Snapshot ${id} is missing.`);
		s.manifests.set(id, manifest);
		s.trees.set(id, buildTree(manifest.files));
		if (this.session() === s) this.render();
	}

	private render(): void {
		if (!this.els) return;
		const s = this.session();
		const { dropdown, status, footer } = this.els;
		dropdown.selectEl.empty();
		for (const id of s?.ids ?? []) dropdown.addOption(id, snapshotLabel(id, s?.manifests.get(id)));
		if (s?.selected) dropdown.setValue(s.selected);
		dropdown.setDisabled(!s || s.ids.length === 0);

		status.empty();
		const line = (text: string, cls = '') => status.createDiv({ cls: `r2-vault-sync-restore-message ${cls}`, text });
		if (this.phase.kind === 'loading') line('Loading snapshots...');
		if (this.phase.kind === 'error') line(this.phase.message, 'r2-vault-sync-restore-error');
		if (s && s.ids.length === 0) line('No snapshots yet. Back up the vault first.');
		if (s?.selected && !s.manifests.has(s.selected)) line('Loading snapshot...');
		if (this.actionError) line(this.actionError, 'r2-vault-sync-restore-error');
		const reason = this.disabledReason();
		if (reason) line(reason, 'r2-vault-sync-restore-busy');

		footer.empty();
		new ButtonComponent(footer)
			.setButtonText('Restore whole snapshot')
			.setDisabled(reason !== null || !this.selectedManifest())
			.onClick(() => this.guard(() => this.restoreAll()))
			.buttonEl.addClass('mod-warning');
		this.renderFiles();
	}

	private renderFiles(): void {
		if (!this.els) return;
		const s = this.session();
		const tree = s?.selected ? s.trees.get(s.selected) : undefined;
		const manifest = this.selectedManifest();
		this.els.note.empty();
		if (!s || !tree || !manifest) {
			this.els.tree.empty();
			return;
		}
		let shown = tree;
		if (this.filter) {
			const matches = Object.entries(manifest.files).filter(([p]) => p.toLowerCase().includes(this.filter));
			shown = buildTree(Object.fromEntries(matches.slice(0, MAX_FILTERED)));
			if (matches.length > MAX_FILTERED) {
				this.els.note.setText(`Showing the first ${MAX_FILTERED} of ${matches.length.toLocaleString()} matches.`);
			}
		}
		renderTree(this.els.tree, shown, {
			expanded: this.expanded,
			forceOpen: this.filter !== '',
			disabled: this.disabledReason() !== null,
			actions: {
				diff: (path) => this.guard(() => openDiff(this.app, this.deps(s, false), manifest, path)),
				copy: (path) => this.guard(() => this.restoreOne(path, { kind: 'copy' })),
				overwrite: (path) => this.guard(() => this.restoreOne(path, { kind: 'overwrite' })),
			},
		});
	}

	private deps(s: Session, allowConfigDir: boolean): RestoreDeps {
		return { store: s.store, vault: s.services.vault, now: Date.now, allowConfigDir };
	}

	private async withBusy<T>(label: string, task: () => Promise<T>, exclusive = true): Promise<T> {
		this.busy = label;
		this.actionError = null;
		this.render();
		try {
			return exclusive ? await this.plugin.runExclusive(task) : await task();
		} finally {
			this.busy = null;
			this.render();
		}
	}

	private async restoreOne(path: string, mode: RestoreMode): Promise<void> {
		const s = this.session();
		const manifest = this.selectedManifest();
		if (!s || !manifest || this.disabledReason()) return;
		const config = isRestoreConfigPath(path, s.services.vault.configDir);
		if (!(await confirmFileRestore(this.app, path, mode, config))) return;
		const result = await this.withBusy(`Restoring ${path}...`, () =>
			restoreFile(this.deps(s, config), manifest, path, mode),
		);
		if (result.outcome === 'failed') {
			this.actionError = `Restore failed for ${path}: ${result.detail ?? 'unknown error'}`;
			this.render();
			return;
		}
		new Notice(result.outcome === 'written' ? `Restored ${result.target}` : `${result.target} already matches the snapshot.`);
		if (config && result.outcome === 'written') new Notice(RELOAD_NOTICE, 0);
	}

	private async restoreAll(): Promise<void> {
		const s = this.session();
		const manifest = this.selectedManifest();
		if (!s || !manifest || this.disabledReason()) return;
		const configDir = s.services.vault.configDir;
		const hasConfig = Object.keys(manifest.files).some((p) => isRestoreConfigPath(p, configDir));
		const mode = await pickSnapshotMode(this.app, manifest, hasConfig);
		if (!mode) return;
		if (mode.kind === 'overwrite') {
			const safety = await this.withBusy('Taking a safety backup first...', () => this.plugin.backupNow('manual'), false);
			if (safety.kind === 'failed') {
				this.actionError = 'The safety backup failed, so nothing was restored.';
				this.render();
				return;
			}
		}

		const allowConfig = mode.kind === 'overwrite' && hasConfig;
		const results = await this.withBusy('Restoring...', () =>
			restoreSnapshot(this.deps(s, allowConfig), manifest, mode, (done, total) => {
				this.busy = `Restoring ${done.toLocaleString()} of ${total.toLocaleString()} files...`;
				const status = this.els?.status.querySelector('.r2-vault-sync-restore-busy');
				status?.setText(this.busy);
			}),
		);
		if (this.els) renderResults(this.els.results, results);
		const configWritten = results.some((r) => r.outcome === 'written' && isRestoreConfigPath(r.target, configDir));
		if (configWritten) new Notice(RELOAD_NOTICE, 0);
	}
}
