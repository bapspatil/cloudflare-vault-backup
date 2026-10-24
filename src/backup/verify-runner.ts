import { blobKey } from '../core/paths';
import type { Hash, SnapshotId } from '../core/types';
import type { RemoteStore } from '../io/types';

export interface VerifyDeps {
	store: Pick<RemoteStore, 'root' | 'listSnapshots' | 'readManifest' | 'listBlobs' | 'getBlob'>;
	random: () => number;
}

export interface VerifyResult {
	snapshotId: SnapshotId;
	blobs: number;
	sampled: number;
	verified: number;
	missing: Hash[];
	corrupt: Hash[];
}

export async function runVerify(deps: VerifyDeps, sampleCount = 20): Promise<VerifyResult> {
	if (!Number.isSafeInteger(sampleCount) || sampleCount < 0) throw new Error('Invalid verification sample count.');
	const { store } = deps;
	const ids = await store.listSnapshots();
	const latest = ids[ids.length - 1];
	if (latest === undefined) throw new Error('No snapshots to verify.');
	const manifest = await store.readManifest(latest);
	if (!manifest) throw new Error(`Snapshot manifest missing: ${latest}`);
	const hashes = [...new Set(Object.values(manifest.files).map((entry) => entry.h))];
	const listed = new Set((await store.listBlobs()).objects.map((object) => object.key));
	const missing = hashes.filter((hash) => !listed.has(blobKey(store.root, hash)));
	const present = hashes.filter((hash) => listed.has(blobKey(store.root, hash)));
	const sample: Hash[] = [];
	for (const [index, hash] of present.entries()) {
		if (index < sampleCount) sample.push(hash);
		else {
			const slot = Math.floor(deps.random() * (index + 1));
			if (slot < sampleCount) sample[slot] = hash;
		}
	}
	const result: VerifyResult = { snapshotId: latest, blobs: hashes.length, sampled: sample.length, verified: 0, missing, corrupt: [] };
	for (const hash of sample) {
		try {
			if (await store.getBlob(hash) === null) result.missing.push(hash);
			else result.verified++;
		} catch (e) {
			if (!(e instanceof Error) || !/^(crypto:|format:)/.test(e.message)) throw e;
			result.corrupt.push(hash);
		}
	}
	return result;
}
