import { ButtonComponent, setIcon } from 'obsidian';
import { formatBytes } from '../core/cost';
import { isTextPath } from '../core/paths';
import type { TreeNode } from '../core/tree';

export interface TreeActions {
	diff(path: string): void;
	copy(path: string): void;
	overwrite(path: string): void;
}

export interface TreeOptions {
	expanded: Set<string>;
	forceOpen: boolean;
	disabled: boolean;
	actions: TreeActions;
}

export function renderTree(parent: HTMLElement, root: TreeNode, opts: TreeOptions): void {
	parent.empty();
	if (root.children.length === 0) {
		parent.createDiv({ cls: 'r2-vault-sync-restore-empty', text: 'No files match.' });
		return;
	}
	renderChildren(parent, root, opts);
}

function renderChildren(container: HTMLElement, node: TreeNode, opts: TreeOptions): void {
	for (const child of node.children) {
		if (child.kind === 'folder') renderFolder(container, child, opts);
		else renderFile(container, child, opts);
	}
}

function renderFolder(container: HTMLElement, node: TreeNode, opts: TreeOptions): void {
	const row = container.createDiv({ cls: 'r2-vault-sync-restore-row r2-vault-sync-restore-folder' });
	const icon = row.createSpan({ cls: 'r2-vault-sync-restore-chevron' });
	row.createSpan({ cls: 'r2-vault-sync-restore-name', text: node.name });
	const children = container.createDiv({ cls: 'r2-vault-sync-restore-children' });
	const sync = () => {
		const open = opts.forceOpen || opts.expanded.has(node.path);
		setIcon(icon, open ? 'chevron-down' : 'chevron-right');
		children.empty();
		if (open) renderChildren(children, node, opts);
	};
	row.addEventListener('click', () => {
		if (opts.forceOpen) return;
		if (opts.expanded.has(node.path)) opts.expanded.delete(node.path);
		else opts.expanded.add(node.path);
		sync();
	});
	sync();
}

function renderFile(container: HTMLElement, node: TreeNode, opts: TreeOptions): void {
	const row = container.createDiv({ cls: 'r2-vault-sync-restore-row r2-vault-sync-restore-file' });
	row.createSpan({ cls: 'r2-vault-sync-restore-name', text: node.name, attr: { title: node.path } });
	row.createSpan({ cls: 'r2-vault-sync-restore-size', text: formatBytes(node.entry?.s ?? 0) });
	const buttons = row.createDiv({ cls: 'r2-vault-sync-restore-actions' });
	const add = (label: string, onClick: () => void, disabled: boolean) =>
		new ButtonComponent(buttons).setButtonText(label).setDisabled(disabled).onClick(onClick);
	if (isTextPath(node.path)) add('Diff', () => opts.actions.diff(node.path), false);
	add('Restore as copy', () => opts.actions.copy(node.path), opts.disabled);
	add('Overwrite', () => opts.actions.overwrite(node.path), opts.disabled).buttonEl.addClass('mod-warning');
}
