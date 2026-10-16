import type { App } from 'obsidian';
import { randomHex } from './core/crypto';
import { backupRoot } from './core/paths';
import { VAULT_DESCRIPTOR_FORMAT, type RunState } from './core/types';
import { createLocalState } from './io/local-state';
import { createR2Client } from './io/r2-client';
import { createRemoteStore } from './io/remote-store';
import { encryptedSealer, newEncryptionDescriptor, plainSealer, unlockEncryption, type EncryptionKeys } from './io/sealer';
import { obsidianTransport } from './io/transport-obsidian';
import type { LocalState, R2Client, R2Credentials, Sealer, VaultPort } from './io/types';
import { createObsidianVaultPort } from './io/vault-port';
import type { BackupContext } from './backup/context';
import { LEGACY_PLUGIN_ID, PLUGIN_ID, type Settings } from './settings';

const DEVICE_ID_KEY = `${LEGACY_PLUGIN_ID}-device-id`;

export class SetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SetupError';
	}
}

export function deviceIdFor(app: App): string {
	const stored: unknown = app.loadLocalStorage(DEVICE_ID_KEY);
	if (typeof stored === 'string' && stored.length > 0) return stored;
	const fresh = randomHex(8);
	app.saveLocalStorage(DEVICE_ID_KEY, fresh);
	return fresh;
}

export function readCredentials(app: App, settings: Settings): R2Credentials {
	const { accountId, bucket, accessKeyIdSecretId, secretKeySecretId } = settings.connection;
	if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new SetupError('Enter your 32 character Cloudflare account ID.');
	if (bucket.trim() === '') throw new SetupError('Enter the R2 bucket name.');
	const accessKeyId = app.secretStorage.getSecret(accessKeyIdSecretId);
	const secretAccessKey = app.secretStorage.getSecret(secretKeySecretId);
	if (!accessKeyId || !secretAccessKey) throw new SetupError('Add the R2 access key ID and secret access key.');
	return { accountId, bucket: bucket.trim(), accessKeyId, secretAccessKey };
}

export interface Services {
	vault: VaultPort;
	local: LocalState;
	client: R2Client;
	root: string;
	sealer: Sealer;
}

export class ServiceFactory {
	private keyCache: { passphrase: string; salt: string; keys: EncryptionKeys } | null = null;
	readonly vault: VaultPort;
	readonly local: LocalState;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => Settings,
	) {
		this.vault = createObsidianVaultPort(app, PLUGIN_ID);
		this.local = createLocalState(this.vault);
	}

	forgetKeys(): void {
		this.keyCache = null;
	}

	async client(): Promise<{ client: R2Client; root: string }> {
		const settings = this.getSettings();
		const creds = readCredentials(this.app, settings);
		const client = createR2Client(creds, obsidianTransport, {
			initialCounters: await this.local.loadCounters(),
		});
		return { client, root: backupRoot(settings.connection.prefix, settings.vaultId) };
	}

	async services(): Promise<Services> {
		const settings = this.getSettings();
		const { client, root } = await this.client();
		const sealer = await this.resolveSealer(client, root, settings);
		return { vault: this.vault, local: this.local, client, root, sealer };
	}

	async context(onState: (s: RunState) => void, pluginVersion: string): Promise<BackupContext> {
		const s = await this.services();
		return {
			vault: s.vault,
			store: createRemoteStore(s.client, s.root, s.sealer),
			client: s.client,
			local: s.local,
			sealer: s.sealer,
			settings: this.getSettings(),
			deviceId: deviceIdFor(this.app),
			pluginVersion,
			now: Date.now,
			random: Math.random,
			onState,
			log: () => undefined,
		};
	}

	private async resolveSealer(client: R2Client, root: string, settings: Settings): Promise<Sealer> {
		if (!settings.encryption.enabled) return plainSealer();
		const passphrase = this.app.secretStorage.getSecret(settings.encryption.passphraseSecretId);
		if (!passphrase) throw new SetupError('Encryption is on but no passphrase is stored.');
		const plainStore = createRemoteStore(client, root, plainSealer());
		let descriptor = await plainStore.readDescriptor();
		if (descriptor === null) {
			const created = await newEncryptionDescriptor(passphrase);
			descriptor = {
				format: VAULT_DESCRIPTOR_FORMAT,
				vaultId: settings.vaultId,
				vaultName: this.vault.vaultName,
				createdAt: new Date().toISOString(),
				encryption: created.descriptor,
			};
			await plainStore.writeDescriptor(descriptor);
			this.keyCache = { passphrase, salt: created.descriptor.salt, keys: created.keys };
			return encryptedSealer(created.keys);
		}
		if (descriptor.encryption === null) {
			throw new SetupError('This backup set was created without encryption. Turn encryption off, or use a new prefix.');
		}
		const cached = this.keyCache;
		if (cached && cached.passphrase === passphrase && cached.salt === descriptor.encryption.salt) {
			return encryptedSealer(cached.keys);
		}
		const keys = await unlockEncryption(passphrase, descriptor.encryption);
		if (!keys) throw new SetupError('The passphrase does not match this backup set.');
		this.keyCache = { passphrase, salt: descriptor.encryption.salt, keys };
		return encryptedSealer(keys);
	}
}

export async function probeConnection(client: R2Client, root: string): Promise<string[]> {
	const key = `${root}/.probe-${randomHex(4)}`;
	const steps: string[] = [];
	const put = await client.put(key, 'probe', { contentType: 'text/plain', condition: { ifNoneMatch: '*' } });
	if (!put.ok) throw new Error('Probe object already exists; try again.');
	steps.push('Write OK');
	const got = await client.get(key);
	if (!got.ok || new TextDecoder().decode(got.body) !== 'probe') throw new Error('Read back failed.');
	steps.push('Read OK');
	await client.delete(key);
	steps.push('Delete OK');
	return steps;
}
