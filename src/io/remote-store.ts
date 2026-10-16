import {
	compareSnapshotIds,
	decodeManifest,
	decodeVaultDescriptor,
	encodeManifest,
	encodeVaultDescriptor,
} from '../core/manifest';
import {
	blobKey,
	blobsPrefix,
	descriptorKey,
	snapshotIdFromKey,
	snapshotKey,
	snapshotsPrefix,
} from '../core/paths';
import type { SnapshotId } from '../core/types';
import type { R2Client, RemoteStore, Sealer } from './types';

export function createRemoteStore(client: R2Client, root: string, sealer: Sealer): RemoteStore {
	return {
		root,

		async readDescriptor() {
			const res = await client.get(descriptorKey(root));
			if (!res.ok) return null;
			const decoded = decodeVaultDescriptor(res.body);
			if (!decoded.ok) throw new Error(`format: vault descriptor ${decoded.error}`);
			return decoded.value;
		},

		async writeDescriptor(d) {
			await client.put(descriptorKey(root), encodeVaultDescriptor(d), { contentType: 'application/json' });
		},

		async listSnapshots() {
			const page = await client.listAll(snapshotsPrefix(root));
			const ids: SnapshotId[] = [];
			for (const o of page.objects) {
				const id = snapshotIdFromKey(root, o.key);
				if (id !== null) ids.push(id);
			}
			return ids.sort(compareSnapshotIds);
		},

		async readManifest(id) {
			const res = await client.get(snapshotKey(root, id));
			if (!res.ok) return null;
			const decoded = decodeManifest(await sealer.open(res.body));
			if (!decoded.ok) throw new Error(`format: manifest ${id} ${decoded.error}`);
			return decoded.value;
		},

		async writeManifest(m) {
			const body = await sealer.seal(encodeManifest(m));
			const res = await client.put(snapshotKey(root, m.id), body, {
				contentType: sealer.scheme === 'sha256' ? 'application/json' : 'application/octet-stream',
				condition: { ifNoneMatch: '*' },
			});
			return res.ok ? 'written' : 'exists';
		},

		async deleteManifests(ids) {
			if (ids.length === 0) return;
			await client.deleteMany(ids.map((id) => snapshotKey(root, id)));
		},

		async hasBlob(hash) {
			return (await client.head(blobKey(root, hash))).ok;
		},

		async putBlob(hash, plain) {
			const sealed = await sealer.seal(plain);
			await client.put(blobKey(root, hash), sealed, { contentType: 'application/octet-stream' });
			return sealed.byteLength;
		},

		async getBlob(hash) {
			const res = await client.get(blobKey(root, hash));
			if (!res.ok) return null;
			const plain = await sealer.open(res.body);
			if ((await sealer.hash(plain)) !== hash) throw new Error('format: blob hash mismatch');
			return plain;
		},

		listBlobs() {
			return client.listAll(blobsPrefix(root));
		},

		async deleteBlobKeys(keys) {
			if (keys.length === 0) return 0;
			return (await client.deleteMany(keys)).deleted.length;
		},
	};
}
