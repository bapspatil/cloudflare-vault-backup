import { randomHex } from '../core/crypto';
import { manifestTotals, newSnapshotId } from '../core/manifest';
import { isIncluded, lockKey } from '../core/paths';
import { hasChanges, knownHashes, planScan, type Plan, type ScanEntry } from '../core/planner';
import { runPool } from '../core/pool';
import { classifyHttp, transition } from '../core/run-machine';
import {
	MANIFEST_FORMAT,
	VAULT_DESCRIPTOR_FORMAT,
	type BackupError,
	type FileEntry,
	type Hash,
	type LocalIndex,
	type Manifest,
	type RunLogEntry,
	type RunState,
	type RunStats,
	type SkippedFile,
} from '../core/types';
import { acquireLock } from '../io/lock';
import { R2Error, type LockHandle } from '../io/types';
import { PLUGIN_ID } from '../settings';
import type { BackupContext } from './context';
import { keepLock, type LockKeeper } from './lock-keeper';
import { runPrune } from './prune-runner';

const LOCK_TTL_MS = 10 * 60_000;
const LOCK_REFRESH_MS = 60_000;
const INDEX_FLUSH_EVERY = 25;
const HOUR_MS = 3_600_000;
const MB = 1024 * 1024;

class RunFailure extends Error {
	constructor(readonly error: BackupError) {
		super(error.detail);
	}
}

type Go = (next: RunState) => void;

interface Uploaded {
	files: Record<string, FileEntry>;
	skipped: SkippedFile[];
	uploaded: number;
	uploadedBytes: number;
	reused: number;
}

export async function runBackup(ctx: BackupContext, trigger: RunLogEntry['trigger']): Promise<RunState> {
	const startedAt = ctx.now();
	let state: RunState = { kind: 'idle' };
	const go: Go = (next) => {
		state = transition(state, next);
		ctx.onState(state);
	};
	let lock: LockHandle | null = null;
	let keeper: LockKeeper | null = null;
	try {
		const { s, index, plan, scanned } = await scan(ctx, go);
		if (!hasChanges(plan, index.files) && index.lastSnapshotId !== null) {
			go({ kind: 'done', snapshotId: null, stats: stats(ctx, startedAt, scanned, plan.skipped.length) });
		} else {
			go({ kind: 'locking' });
			lock = await acquireLock(ctx.client, lockKey(ctx.store.root), {
				deviceId: ctx.deviceId,
				ttlMs: LOCK_TTL_MS,
				now: ctx.now,
			});
			if (!lock) throw new RunFailure({ code: 'locked', detail: 'another device holds the backup lock' });
			const held = keepLock(lock, LOCK_REFRESH_MS);
			keeper = held;
			await ensureDescriptor(ctx);
			const graceMs = s.retention.graceHours * HOUR_MS;
			const known = await learnKnown(ctx, index, graceMs / 2);
			const up = await upload(ctx, go, plan, index, known, held);
			assertHeld(held);
			go({ kind: 'committing' });
			const manifest = buildManifest(ctx, plan, up);
			await ctx.store.writeManifest(manifest);
			let next: LocalIndex = { ...index, files: manifest.files, lastSnapshotId: manifest.id, pendingBlobs: {} };
			await ctx.local.saveIndex(next);
			const lastGcAt = index.lastGcAt;
			if (lastGcAt === null || ctx.now() - lastGcAt >= s.retention.gcIntervalHours * HOUR_MS) {
				assertHeld(held);
				go({ kind: 'pruning', deleted: 0 });
				await runPrune(ctx, (deleted) => {
					assertHeld(held);
					go({ kind: 'pruning', deleted });
				});
				next = { ...next, lastGcAt: ctx.now() };
				await ctx.local.saveIndex(next);
			}
			go({
				kind: 'done',
				snapshotId: manifest.id,
				stats: { ...stats(ctx, startedAt, scanned, manifest.skipped.length), ...counts(up) },
			});
		}
	} catch (e) {
		go({ kind: 'failed', phase: state.kind, error: toBackupError(e) });
	} finally {
		if (keeper) await keeper.stop();
		if (lock) await lock.release().catch(() => undefined);
	}
	await record(ctx, trigger, startedAt, state);
	return state;
}

async function scan(ctx: BackupContext, go: Go) {
	const s = ctx.settings;
	go({ kind: 'scanning', seen: 0 });
	const listed = await ctx.vault.scan(s.scope.includeConfigDir);
	const opts = {
		configDir: ctx.vault.configDir,
		includeConfigDir: s.scope.includeConfigDir,
		excludeGlobs: s.scope.excludeGlobs,
		pluginId: PLUGIN_ID,
	};
	const entries: ScanEntry[] = listed.filter((f) => isIncluded(f.path, opts));
	go({ kind: 'scanning', seen: entries.length });
	const index = await ctx.local.loadIndex(s.vaultId);
	const maxMb = ctx.vault.isMobile ? s.scope.maxFileSizeMbMobile : s.scope.maxFileSizeMb;
	const plan = planScan(entries, index.files, Math.floor(maxMb * MB));
	return { s, index, plan, scanned: entries.length };
}

async function ensureDescriptor(ctx: BackupContext): Promise<void> {
	const encrypted = ctx.settings.encryption.enabled || ctx.sealer.scheme !== 'sha256';
	let descriptor = await ctx.store.readDescriptor();
	if (descriptor === null) {
		if (encrypted) throw new RunFailure({ code: 'crypto', detail: 'encryption not initialised' });
		descriptor = {
			format: VAULT_DESCRIPTOR_FORMAT,
			vaultId: ctx.settings.vaultId,
			vaultName: ctx.vault.vaultName,
			createdAt: new Date(ctx.now()).toISOString(),
			encryption: null,
		};
		await ctx.store.writeDescriptor(descriptor);
	}
	if (encrypted && descriptor.encryption === null) {
		throw new RunFailure({ code: 'crypto', detail: 'encryption not initialised' });
	}
	if (!encrypted && descriptor.encryption !== null) {
		throw new RunFailure({ code: 'crypto', detail: 'backup set is encrypted but encryption is off' });
	}
}

async function learnKnown(ctx: BackupContext, index: LocalIndex, maxPendingAgeMs: number): Promise<Set<Hash>> {
	const ids = await ctx.store.listSnapshots();
	const latest = ids[ids.length - 1];
	const now = ctx.now();
	if (latest !== undefined && latest === index.lastSnapshotId) {
		return knownHashes(index.files, index.pendingBlobs, now, maxPendingAgeMs);
	}
	const known = knownHashes({}, index.pendingBlobs, now, maxPendingAgeMs);
	if (latest === undefined) return known;
	const manifest = await ctx.store.readManifest(latest);
	for (const entry of Object.values(manifest?.files ?? {})) known.add(entry.h);
	return known;
}

async function upload(
	ctx: BackupContext,
	go: Go,
	plan: Plan,
	index: LocalIndex,
	known: Set<Hash>,
	keeper: LockKeeper,
): Promise<Uploaded> {
	const out: Uploaded = {
		files: { ...plan.unchanged },
		skipped: [...plan.skipped],
		uploaded: 0,
		uploadedBytes: 0,
		reused: Object.keys(plan.unchanged).length,
	};
	const pending: Record<Hash, number> = { ...index.pendingBlobs };
	const total = plan.toHash.length;
	const bytesTotal = plan.toHash.reduce((n, e) => n + e.size, 0);
	let done = 0;
	let bytesDone = 0;
	go({ kind: 'uploading', done, total, bytesDone, bytesTotal });
	const concurrency = Math.max(1, Math.min(ctx.settings.concurrency, ctx.vault.isMobile ? 2 : 4));
	try {
		await runPool(plan.toHash, concurrency, async (entry) => {
			assertHeld(keeper);
			const bytes = await readOrSkip(ctx, entry, out.skipped);
			if (bytes) {
				const hash = await ctx.sealer.hash(bytes);
				if (known.has(hash)) {
					out.reused++;
				} else {
					known.add(hash);
					out.uploadedBytes += await ctx.store.putBlob(hash, bytes);
					out.uploaded++;
					pending[hash] = ctx.now();
					if (out.uploaded % INDEX_FLUSH_EVERY === 0) await ctx.local.saveIndex({ ...index, pendingBlobs: { ...pending } });
				}
				out.files[entry.path] = { h: hash, s: bytes.byteLength, m: entry.mtime };
			}
			done++;
			bytesDone += entry.size;
			go({ kind: 'uploading', done, total, bytesDone, bytesTotal });
		});
	} catch (e) {
		await ctx.local.saveIndex({ ...index, pendingBlobs: pending }).catch(() => undefined);
		throw e;
	}
	return out;
}

async function readOrSkip(ctx: BackupContext, entry: ScanEntry, skipped: SkippedFile[]): Promise<Uint8Array | null> {
	try {
		return await ctx.vault.read(entry.path);
	} catch {
		// A file deleted or locked between scan and read should not sink the whole snapshot.
		skipped.push({ path: entry.path, reason: 'unreadable', size: entry.size });
		return null;
	}
}

function buildManifest(ctx: BackupContext, plan: Plan, up: Uploaded): Manifest {
	const createdAt = new Date(ctx.now());
	return {
		format: MANIFEST_FORMAT,
		id: newSnapshotId(createdAt, randomHex(2)),
		createdAt: createdAt.toISOString(),
		deviceId: ctx.deviceId,
		pluginVersion: ctx.pluginVersion,
		blobScheme: ctx.sealer.scheme,
		files: up.files,
		skipped: up.skipped,
		totals: manifestTotals(up.files),
	};
}

function assertHeld(keeper: LockKeeper): void {
	if (keeper.lost()) throw new RunFailure({ code: 'locked', detail: 'lost the backup lock during the run' });
}

function stats(ctx: BackupContext, startedAt: number, scanned: number, skipped: number): RunStats {
	return { scanned, uploaded: 0, uploadedBytes: 0, reused: 0, skipped, durationMs: ctx.now() - startedAt };
}

const counts = (up: Uploaded) => ({ uploaded: up.uploaded, uploadedBytes: up.uploadedBytes, reused: up.reused });

export function toBackupError(e: unknown): BackupError {
	if (e instanceof RunFailure) return e.error;
	const detail = e instanceof Error ? e.message : String(e);
	if (e instanceof R2Error) {
		if (e.code === 'network' || e.status === 0) return { code: 'network', detail };
		const code = classifyHttp(e.status);
		return { code: code === null || code === 'locked' ? 'io' : code, detail };
	}
	if (detail.startsWith('crypto:')) return { code: 'crypto', detail };
	if (detail.startsWith('format:')) return { code: 'format', detail };
	return { code: 'io', detail };
}

async function record(ctx: BackupContext, trigger: RunLogEntry['trigger'], startedAt: number, state: RunState) {
	const endedAt = ctx.now();
	let result: RunLogEntry['result'];
	if (state.kind === 'done') {
		result = { kind: 'done', snapshotId: state.snapshotId, stats: state.stats };
		const st = state.stats;
		ctx.log(
			state.snapshotId === null
				? `backup (${trigger}): no changes, ${st.scanned} files scanned`
				: `backup (${trigger}): snapshot ${state.snapshotId}, ${st.uploaded} uploaded (${st.uploadedBytes} bytes), ${st.reused} reused, ${st.skipped} skipped in ${st.durationMs} ms`,
		);
	} else if (state.kind === 'failed') {
		result = { kind: 'failed', error: state.error };
		ctx.log(`backup (${trigger}): failed while ${state.phase} (${state.error.code}): ${state.error.detail}`);
	} else {
		return;
	}
	try {
		await ctx.local.appendLog({ startedAt, endedAt, trigger, result });
	} catch (e) {
		ctx.log(`backup: could not write the run log: ${e instanceof Error ? e.message : String(e)}`);
	}
}
