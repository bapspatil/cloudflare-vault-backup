import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type R2VaultSyncPlugin from '../main';

export const RESTORE_VIEW_TYPE = 'r2-vault-sync-restore';

export class RestoreView extends ItemView {
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
}
