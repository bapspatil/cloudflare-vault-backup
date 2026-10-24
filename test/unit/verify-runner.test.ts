import { describe, expect, it, vi } from 'vitest';
import { runVerify } from '../../src/backup/verify-runner';
import { blobKey, snapshotKey } from '../../src/core/paths';
import type { Manifest } from '../../src/core/types';
import { createRemoteStore } from '../../src/io/remote-store';
import { encryptedSealer, newEncryptionDescriptor, plainSealer } from '../../src/io/sealer';
import { createFakeR2 } from '../helpers/fake-r2';

const ROOT = 'backups/v1';
const ID = '20261016T120000Z-ab12';
const enc = new TextEncoder();

async function setup(encrypted = false, count = 3) {
	const client = createFakeR2();
	const sealer = encrypted ? encryptedSealer((await newEncryptionDescriptor('test passphrase', 1000)).keys) : plainSealer();
	const store = createRemoteStore(client, ROOT, sealer);
	const files: Manifest['files'] = {};
	for (let index = 0; index < count; index++) {
		const bytes = enc.encode(`contents ${index}`);
		const hash = await sealer.hash(bytes);
		await store.putBlob(hash, bytes);
		files[`${index}.md`] = { h: hash, s: bytes.length, m: 1 };
	}
	const manifest: Manifest = {
		format: 1, id: ID, createdAt: '2026-10-16T12:00:00.000Z', deviceId: 'dev',
		pluginVersion: '1.3.0', blobScheme: sealer.scheme, files, skipped: [],
		totals: { files: count, bytes: Object.values(files).reduce((sum, entry) => sum + entry.s, 0) },
	};
	await store.writeManifest(manifest);
	return { client, store, manifest, hashes: Object.values(files).map((entry) => entry.h) };
}

describe('verify latest backup', () => {
	it.each([false, true])('verifies hashes without any bucket writes (encrypted: %s)', async (encrypted) => {
		const { client, store } = await setup(encrypted);
		const before = structuredClone(client.objects);
		const writes = [vi.spyOn(client, 'put'), vi.spyOn(client, 'delete'), vi.spyOn(client, 'deleteMany')];
		const list = vi.spyOn(client, 'listAll');
		const head = vi.spyOn(client, 'head');
		expect(await runVerify({ store, random: () => 0 })).toEqual({
			snapshotId: ID, blobs: 3, sampled: 3, verified: 3, missing: [], corrupt: [],
		});
		expect(client.objects).toEqual(before);
		for (const write of writes) expect(write).not.toHaveBeenCalled();
		expect(list.mock.calls.map(([prefix]) => prefix)).toEqual([`${ROOT}/snapshots/`, `${ROOT}/blobs/`]);
		expect(head).not.toHaveBeenCalled();
	});

	it('checks the latest manifest and deduplicates blobs shared by files', async () => {
		const { store, manifest, hashes } = await setup();
		await store.writeManifest({
			...manifest, id: '20261017T120000Z-ab12', createdAt: '2026-10-17T12:00:00.000Z',
			files: { 'only.md': { h: hashes[0]!, s: 10, m: 1 }, 'copy.md': { h: hashes[0]!, s: 10, m: 1 } },
			totals: { files: 2, bytes: 20 },
		});
		expect(await runVerify({ store, random: () => 0 })).toMatchObject({
			snapshotId: '20261017T120000Z-ab12', blobs: 1, sampled: 1, verified: 1,
		});
	});

	it.each([false, true])('reports missing and corrupt blobs (encrypted: %s)', async (encrypted) => {
		const { client, store, hashes } = await setup(encrypted);
		client.objects.delete(blobKey(ROOT, hashes[0]!));
		await client.put(blobKey(ROOT, hashes[1]!), 'corrupt');
		expect(await runVerify({ store, random: () => 0 })).toMatchObject({
			blobs: 3, sampled: 2, verified: 1, missing: [hashes[0]], corrupt: [hashes[1]],
		});
	});

	it('checks existence outside the sample and downloads at most 20 unique blobs', async () => {
		const { client, store, hashes } = await setup(false, 30);
		client.objects.delete(blobKey(ROOT, hashes[29]!));
		const get = vi.spyOn(store, 'getBlob');
		const result = await runVerify({ store, random: () => 0.999 });
		expect(result).toMatchObject({ blobs: 30, sampled: 20, verified: 20, missing: [hashes[29]] });
		expect(get).toHaveBeenCalledTimes(20);
		expect(new Set(get.mock.calls.map(([hash]) => hash)).size).toBe(20);
	});

	it('uses randomness to choose the sample and supports a custom count or existence-only check', async () => {
		const { store, hashes } = await setup(false, 30);
		const get = vi.spyOn(store, 'getBlob');
		expect((await runVerify({ store, random: () => 0 }, 1)).sampled).toBe(1);
		expect(get).not.toHaveBeenLastCalledWith(hashes[0]);
		await runVerify({ store, random: () => 0.999 }, 1);
		expect(get).toHaveBeenLastCalledWith(hashes[0]);
		get.mockClear();
		expect((await runVerify({ store, random: () => 0 }, 0)).sampled).toBe(0);
		expect(get).not.toHaveBeenCalled();
	});

	it('reads blob listings across pages', async () => {
		const { client, store, manifest } = await setup(false, 0);
		const files: Manifest['files'] = {};
		for (let index = 0; index < 1003; index++) {
			const hash = index.toString(16).padStart(64, '0');
			await client.put(blobKey(ROOT, hash), 'x');
			files[`${index}.md`] = { h: hash, s: 1, m: 1 };
		}
		await client.delete(snapshotKey(ROOT, ID));
		await store.writeManifest({ ...manifest, files, totals: { files: 1003, bytes: 1003 } });
		expect(await runVerify({ store, random: () => 0 }, 0)).toMatchObject({ blobs: 1003, missing: [], corrupt: [] });
	});

	it('reports a blob disappearing between listing and download', async () => {
		const { store, hashes } = await setup();
		vi.spyOn(store, 'getBlob').mockResolvedValueOnce(null);
		expect((await runVerify({ store, random: () => 0 })).missing).toEqual([hashes[0]]);
	});

	it('does not misreport transport failures as corruption', async () => {
		const { store } = await setup();
		vi.spyOn(store, 'getBlob').mockRejectedValueOnce(new Error('network: unavailable'));
		await expect(runVerify({ store, random: () => 0 })).rejects.toThrow('network: unavailable');
	});

	it('handles empty snapshots and absent or invalid manifests', async () => {
		const { client, store } = await setup(false, 0);
		expect(await runVerify({ store, random: () => 0 })).toMatchObject({ blobs: 0, sampled: 0, missing: [], corrupt: [] });
		await client.put(snapshotKey(ROOT, ID), 'invalid manifest');
		await expect(runVerify({ store, random: () => 0 })).rejects.toThrow('format: manifest');
		vi.spyOn(store, 'readManifest').mockResolvedValueOnce(null);
		await expect(runVerify({ store, random: () => 0 })).rejects.toThrow('Snapshot manifest missing');
		client.objects.clear();
		await expect(runVerify({ store, random: () => 0 })).rejects.toThrow('No snapshots');
	});

	it.each([-1, 1.5, NaN, Infinity])('rejects invalid sample count %s', async (count) => {
		const { store } = await setup();
		await expect(runVerify({ store, random: () => 0 }, count)).rejects.toThrow('sample count');
	});
});
