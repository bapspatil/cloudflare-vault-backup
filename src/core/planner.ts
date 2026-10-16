import type { FileEntry, Hash, SkippedFile } from './types';

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export interface ScanEntry {
	path: string;
	size: number;
	mtime: number;
}

export interface Plan {
	unchanged: Record<string, FileEntry>;
	toHash: ScanEntry[];
	removed: string[];
	skipped: SkippedFile[];
}

export function planScan(entries: ScanEntry[], index: Record<string, FileEntry>, maxBytes: number): Plan {
	const unchanged: Record<string, FileEntry> = {};
	const toHash: ScanEntry[] = [];
	const skipped: SkippedFile[] = [];
	const seen = new Set<string>();
	for (const e of entries) {
		seen.add(e.path);
		if (e.size > maxBytes) {
			skipped.push({ path: e.path, reason: 'too-large', size: e.size });
			continue;
		}
		const known = has(index, e.path) ? index[e.path] : undefined;
		if (known && known.s === e.size && known.m === e.mtime) unchanged[e.path] = known;
		else toHash.push(e);
	}
	const removed = Object.keys(index).filter((p) => !seen.has(p));
	return { unchanged, toHash, removed, skipped };
}

/** Files unchanged on disk still need upload when the backup set has no blob for their hash. */
export function requireKnown(plan: Plan, known: Set<Hash>): Plan {
	const unchanged: Record<string, FileEntry> = {};
	const toHash = [...plan.toHash];
	for (const [path, entry] of Object.entries(plan.unchanged)) {
		if (known.has(entry.h)) unchanged[path] = entry;
		else toHash.push({ path, size: entry.s, mtime: entry.m });
	}
	return { ...plan, unchanged, toHash };
}

export function hasChanges(plan: Plan, index: Record<string, FileEntry> = {}): boolean {
	return (
		plan.toHash.length > 0 ||
		plan.removed.length > 0 ||
		plan.skipped.some((s) => has(index, s.path))
	);
}

export function knownHashes(
	index: Record<string, FileEntry>,
	pending: Record<Hash, number>,
	nowMs: number,
	maxPendingAgeMs: number,
): Set<Hash> {
	const known = new Set<Hash>();
	for (const entry of Object.values(index)) known.add(entry.h);
	for (const [hash, uploadedAt] of Object.entries(pending)) {
		if (nowMs - uploadedAt < maxPendingAgeMs) known.add(hash);
	}
	return known;
}
