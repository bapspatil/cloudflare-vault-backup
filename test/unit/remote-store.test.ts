import { describe, expect, it } from 'vitest';
import type { Manifest, VaultDescriptor } from '../../src/core/types';
import { createRemoteStore } from '../../src/io/remote-store';
import { encryptedSealer, newEncryptionDescriptor, plainSealer } from '../../src/io/sealer';
import { createFakeR2 } from '../helpers/fake-r2';

const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const ROOT = 'backups/v1';
const ABC_SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function manifest(id: string): Manifest {
	return {
		format: 1,
		id,
		createdAt: '2026-01-01T00:00:00.000Z',
		deviceId: 'dev-a',
		pluginVersion: '0.1.0',
		blobScheme: 'sha256',
		totals: { files: 1, bytes: 3 },
		files: { 'a.md': { h: ABC_SHA, s: 3, m: 1700000000000 } },
		skipped: [],
	};
}

const descriptor: VaultDescriptor = {
	format: 1,
	vaultId: 'v1',
	vaultName: 'Notes',
	createdAt: '2026-01-01T00:00:00.000Z',
	encryption: null,
};

describe('descriptor', () => {
	it('returns null when missing and round-trips as plaintext JSON', async () => {
		const r2 = createFakeR2();
		const store = createRemoteStore(r2, ROOT, plainSealer());
		expect(await store.readDescriptor()).toBe(null);
		await store.writeDescriptor(descriptor);
		expect((JSON.parse(text(r2.objects.get('backups/v1/vault.json')!.body)) as VaultDescriptor).vaultName).toBe('Notes');
		expect(await store.readDescriptor()).toEqual(descriptor);
	});

	it('throws a format error for a corrupt descriptor', async () => {
		const r2 = createFakeR2();
		await r2.put('backups/v1/vault.json', '{"format":1}');
		await expect(createRemoteStore(r2, ROOT, plainSealer()).readDescriptor()).rejects.toThrow(
			'format: vault descriptor corrupt',
		);
	});
});

describe('manifests', () => {
	it('writes once then reports exists', async () => {
		const store = createRemoteStore(createFakeR2(), ROOT, plainSealer());
		expect(await store.writeManifest(manifest('20260101T000000Z-aaaa'))).toBe('written');
		expect(await store.writeManifest(manifest('20260101T000000Z-aaaa'))).toBe('exists');
	});

	it('round-trips through the encrypted sealer without plaintext at rest', async () => {
		const r2 = createFakeR2();
		const { keys } = await newEncryptionDescriptor('pw', 1000);
		const store = createRemoteStore(r2, ROOT, encryptedSealer(keys));
		await store.writeManifest(manifest('20260101T000000Z-aaaa'));
		const stored = text(r2.objects.get('backups/v1/snapshots/20260101T000000Z-aaaa.json')!.body);
		expect(stored.includes('a.md')).toBe(false);
		expect(await store.readManifest('20260101T000000Z-aaaa')).toEqual(manifest('20260101T000000Z-aaaa'));
		expect(await store.readManifest('20260102T000000Z-bbbb')).toBe(null);
	});

	it('throws a format error naming the snapshot for a corrupt manifest', async () => {
		const r2 = createFakeR2();
		await r2.put('backups/v1/snapshots/20260101T000000Z-aaaa.json', 'not json');
		await expect(createRemoteStore(r2, ROOT, plainSealer()).readManifest('20260101T000000Z-aaaa')).rejects.toThrow(
			'format: manifest 20260101T000000Z-aaaa corrupt',
		);
	});

	it('lists snapshot ids sorted, ignoring foreign keys, and deletes them', async () => {
		const r2 = createFakeR2();
		const store = createRemoteStore(r2, ROOT, plainSealer());
		for (const id of ['20260301T000000Z-cccc', '20260101T000000Z-aaaa', '20260201T000000Z-bbbb']) {
			await store.writeManifest(manifest(id));
		}
		await r2.put('backups/v1/snapshots/notes.txt', 'x');
		await r2.put('backups/v1/snapshots/nested/x.json', 'x');
		expect(await store.listSnapshots()).toEqual([
			'20260101T000000Z-aaaa',
			'20260201T000000Z-bbbb',
			'20260301T000000Z-cccc',
		]);
		await store.deleteManifests(['20260101T000000Z-aaaa', '20260301T000000Z-cccc']);
		expect(await store.listSnapshots()).toEqual(['20260201T000000Z-bbbb']);
	});
});

describe('blobs', () => {
	it('stores under the sharded key, reports presence, and reads back', async () => {
		const r2 = createFakeR2();
		const store = createRemoteStore(r2, ROOT, plainSealer());
		expect(await store.hasBlob(ABC_SHA)).toBe(false);
		expect(await store.putBlob(ABC_SHA, utf8('abc'))).toBe(3);
		expect([...r2.objects.keys()]).toEqual([`backups/v1/blobs/ba/${ABC_SHA}`]);
		expect(await store.hasBlob(ABC_SHA)).toBe(true);
		expect(text((await store.getBlob(ABC_SHA))!)).toBe('abc');
		expect(await store.getBlob('ffff')).toBe(null);
	});

	it('returns the sealed size for encrypted blobs and opens them on read', async () => {
		const { keys } = await newEncryptionDescriptor('pw', 1000);
		const sealer = encryptedSealer(keys);
		const store = createRemoteStore(createFakeR2(), ROOT, sealer);
		const hash = await sealer.hash(utf8('abc'));
		expect(await store.putBlob(hash, utf8('abc'))).toBe(36);
		expect(text((await store.getBlob(hash))!)).toBe('abc');
	});

	it('throws when stored bytes no longer match the hash', async () => {
		const r2 = createFakeR2();
		const store = createRemoteStore(r2, ROOT, plainSealer());
		await store.putBlob(ABC_SHA, utf8('abc'));
		r2.objects.get(`backups/v1/blobs/ba/${ABC_SHA}`)!.body = utf8('abd');
		await expect(store.getBlob(ABC_SHA)).rejects.toThrow('format: blob hash mismatch');
	});

	it('lists every blob across pages and deletes by key', async () => {
		const r2 = createFakeR2();
		const store = createRemoteStore(r2, ROOT, plainSealer());
		const hashes = Array.from({ length: 1003 }, (_, i) => i.toString(16).padStart(4, '0'));
		for (const h of hashes) await r2.put(`backups/v1/blobs/${h.slice(0, 2)}/${h}`, 'x');
		await r2.put('backups/v1/snapshots/20260101T000000Z-aaaa.json', 'x');
		const listed = await store.listBlobs();
		expect(listed.objects.length).toBe(1003);
		expect(listed.objects[1002]!.key).toBe('backups/v1/blobs/03/03ea');
		expect(await store.deleteBlobKeys(listed.objects.slice(0, 1000).map((o) => o.key))).toBe(1000);
		expect((await store.listBlobs()).objects.map((o) => o.key)).toEqual([
			'backups/v1/blobs/03/03e8',
			'backups/v1/blobs/03/03e9',
			'backups/v1/blobs/03/03ea',
		]);
	});
});
