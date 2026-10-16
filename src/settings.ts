export const PLUGIN_ID = 'cloudflare-vault-backup';
export const LEGACY_PLUGIN_ID = 'r2-vault-sync';
export const SETTINGS_VERSION = 1;

export interface ConnectionSettings {
	accountId: string;
	bucket: string;
	prefix: string;
	accessKeyIdSecretId: string;
	secretKeySecretId: string;
}

export interface EncryptionSettings {
	enabled: boolean;
	passphraseSecretId: string;
}

export interface ScopeSettings {
	includeConfigDir: boolean;
	excludeGlobs: string[];
	maxFileSizeMb: number;
	maxFileSizeMbMobile: number;
}

export interface ScheduleSettings {
	intervalMinutes: number;
	quietSeconds: number;
	onStartup: boolean;
}

export interface RetentionSettings {
	keepLast: number;
	daily: number;
	weekly: number;
	monthly: number;
	graceHours: number;
	gcIntervalHours: number;
}

export interface Settings {
	version: typeof SETTINGS_VERSION;
	vaultId: string;
	connection: ConnectionSettings;
	encryption: EncryptionSettings;
	scope: ScopeSettings;
	schedule: ScheduleSettings;
	retention: RetentionSettings;
	concurrency: number;
}

export const DEFAULT_SETTINGS: Omit<Settings, 'vaultId'> = {
	version: SETTINGS_VERSION,
	connection: {
		accountId: '',
		bucket: '',
		prefix: 'obsidian',
		accessKeyIdSecretId: `${PLUGIN_ID}-access-key-id`,
		secretKeySecretId: `${PLUGIN_ID}-secret-access-key`,
	},
	encryption: {
		enabled: false,
		passphraseSecretId: `${PLUGIN_ID}-passphrase`,
	},
	scope: {
		includeConfigDir: true,
		excludeGlobs: [],
		maxFileSizeMb: 50,
		maxFileSizeMbMobile: 20,
	},
	schedule: {
		intervalMinutes: 60,
		quietSeconds: 90,
		onStartup: false,
	},
	retention: {
		keepLast: 10,
		daily: 7,
		weekly: 4,
		monthly: 6,
		graceHours: 24,
		gcIntervalHours: 24,
	},
	concurrency: 4,
};

export function newVaultId(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function loadSettings(raw: unknown): Settings {
	const stored = (raw ?? {}) as Partial<Settings>;
	return {
		...DEFAULT_SETTINGS,
		...stored,
		vaultId: stored.vaultId && stored.vaultId.length > 0 ? stored.vaultId : newVaultId(),
		connection: { ...DEFAULT_SETTINGS.connection, ...stored.connection },
		encryption: { ...DEFAULT_SETTINGS.encryption, ...stored.encryption },
		scope: { ...DEFAULT_SETTINGS.scope, ...stored.scope },
		schedule: { ...DEFAULT_SETTINGS.schedule, ...stored.schedule },
		retention: { ...DEFAULT_SETTINGS.retention, ...stored.retention },
		version: SETTINGS_VERSION,
	};
}
