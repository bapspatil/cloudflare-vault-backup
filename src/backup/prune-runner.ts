import { chunk, selectGarbage } from '../core/gc';
import { parseSnapshotId } from '../core/manifest';
import { hashFromBlobKey, lockKey } from '../core/paths';
import { selectKeep } from '../core/retention';
import type { Hash, SnapshotRef } from '../core/types';
import { backupSetOf, type BackupContext } from './context';
import { lockOptions, withLock } from './lock-keeper';

const HOUR_MS = 3_600_000;
const DELETE_BATCH = 1000;

export async function runPrune(
	ctx: BackupContext,
	onProgress: (deleted: number) => void,
): Promise<{ manifestsDeleted: number; blobsDeleted: number }> {
	const { store, settings } = ctx;
	const now = ctx.now();
	const ids = await store.listSnapshots();
	const refs: SnapshotRef[] = [];
	for (const id of ids) {
		const parsed = parseSnapshotId(id);
		if (parsed) refs.push({ id, createdAt: parsed.createdAt });
	}
	const keep = selectKeep(refs, settings.retention, -new Date(now).getTimezoneOffset());
	const doomed = refs.filter((r) => !keep.has(r.id)).map((r) => r.id);
	await store.deleteManifests(doomed);
	if (doomed.length > 0) onProgress(doomed.length);

	const doomedSet = new Set(doomed);
	const referenced = new Set<Hash>();
	for (const id of ids) {
		if (doomedSet.has(id)) continue;
		const manifest = await store.readManifest(id);
		for (const entry of Object.values(manifest?.files ?? {})) referenced.add(entry.h);
	}

	const listed = await store.listBlobs();
	const graceMs = settings.retention.graceHours * HOUR_MS;
	const garbage = selectGarbage(listed.objects, referenced, now, graceMs, (k) => hashFromBlobKey(store.root, k));
	let blobsDeleted = 0;
	for (const keys of chunk(garbage, DELETE_BATCH)) {
		blobsDeleted += await store.deleteBlobKeys(keys);
		onProgress(doomed.length + blobsDeleted);
	}
	return { manifestsDeleted: doomed.length, blobsDeleted };
}

export type LockedPruneResult = { kind: 'locked' } | { kind: 'done'; manifestsDeleted: number; blobsDeleted: number };

export async function runLockedPrune(ctx: BackupContext, onProgress: (deleted: number) => void): Promise<LockedPruneResult> {
	const run = await withLock(ctx.client, lockKey(ctx.store.root), lockOptions(ctx), async (held) => {
		const check = () => {
			if (held.lost()) throw new Error('lost the backup lock during the prune');
		};
		const result = await runPrune(ctx, (deleted) => {
			check();
			onProgress(deleted);
		});
		const index = await ctx.local.loadIndex(backupSetOf(ctx));
		await ctx.local.saveIndex({ ...index, lastGcAt: ctx.now() });
		return result;
	});
	return run.held ? { kind: 'done', ...run.value } : { kind: 'locked' };
}
