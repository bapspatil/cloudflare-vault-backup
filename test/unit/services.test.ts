import type { App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runVerify } from '../../src/backup/verify-runner';
import { descriptorKey } from '../../src/core/paths';
import { VAULT_DESCRIPTOR_FORMAT } from '../../src/core/types';
import { createRemoteStore } from '../../src/io/remote-store';
import { newEncryptionDescriptor, plainSealer } from '../../src/io/sealer';
import { createObsidianVaultPort } from '../../src/io/vault-port';
import { ServiceFactory } from '../../src/services';
import { loadSettings } from '../../src/settings';
import { createFakeR2 } from '../helpers/fake-r2';
import { createMemoryVault } from '../helpers/memory-vault';

vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));
vi.mock('../../src/io/vault-port', () => ({ createObsidianVaultPort: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

function setup(encrypted: boolean) {
	const vault = createMemoryVault({ files: { 'a.md': 'unchanged' } });
	vi.mocked(createObsidianVaultPort).mockReturnValue(vault);
	const settings = loadSettings({ vaultId: 'v1', encryption: { enabled: encrypted } });
	const app = { secretStorage: { getSecret: () => 'test passphrase' } } as unknown as App;
	const factory = new ServiceFactory(app, () => settings);
	const client = createFakeR2();
	vi.spyOn(factory, 'client').mockResolvedValue({ client, root: 'backups/v1' });
	return { factory, client, vault };
}

describe('read-only verification services', () => {
	it('does not initialize an absent encrypted backup set', async () => {
		const { factory, client, vault } = setup(true);
		const put = vi.spyOn(client, 'put');
		const before = structuredClone(vault.files);
		await expect(factory.services(true)).rejects.toThrow('No encrypted backup set');
		expect(put).not.toHaveBeenCalled();
		expect(client.objects.size).toBe(0);
		expect(vault.files).toEqual(before);
		expect(vault.pluginFiles.size).toBe(0);
	});

	it('leaves an absent plaintext backup set untouched', async () => {
		const { factory, client, vault } = setup(false);
		const { root, sealer } = await factory.services(true);
		await expect(runVerify({ store: createRemoteStore(client, root, sealer), random: () => 0 })).rejects.toThrow('No snapshots');
		expect(client.objects.size).toBe(0);
		expect(vault.pluginFiles.size).toBe(0);
	});

	it('unlocks an existing encrypted set without writing to it or the vault', async () => {
		const { factory, client, vault } = setup(true);
		const encryption = await newEncryptionDescriptor('test passphrase', 100_000);
		await createRemoteStore(client, 'backups/v1', plainSealer()).writeDescriptor({
			format: VAULT_DESCRIPTOR_FORMAT, vaultId: 'v1', vaultName: 'Test Vault',
			createdAt: '2026-10-16T12:00:00.000Z', encryption: encryption.descriptor,
		});
		const before = structuredClone(client.objects);
		const { sealer } = await factory.services(true);
		expect(sealer.scheme).toBe('hmac-sha256');
		expect(client.objects).toEqual(before);
		expect(client.objects.has(descriptorKey('backups/v1'))).toBe(true);
		expect(vault.pluginFiles.size).toBe(0);
	});
});
