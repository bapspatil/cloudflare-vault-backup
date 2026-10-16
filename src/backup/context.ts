import type { RunState } from '../core/types';
import type { Settings } from '../settings';
import type { LocalState, RemoteStore, R2Client, Sealer, VaultPort } from '../io/types';

export const backupSetOf = (ctx: Pick<BackupContext, 'store' | 'sealer'>): string => `${ctx.store.root}|${ctx.sealer.scheme}`;

export interface BackupContext {
	vault: VaultPort;
	store: RemoteStore;
	sealer: Sealer;
	client: R2Client;
	local: LocalState;
	settings: Settings;
	deviceId: string;
	pluginVersion: string;
	now: () => number;
	random: () => number;
	onState: (state: RunState) => void;
	log: (line: string) => void;
}
