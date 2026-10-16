import type { RunState } from '../core/types';
import type { Settings } from '../settings';
import type { LocalState, RemoteStore, R2Client, VaultPort } from '../io/types';

export interface BackupContext {
	vault: VaultPort;
	store: RemoteStore;
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
