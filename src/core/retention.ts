import type { RetentionPolicy, SnapshotId, SnapshotRef } from './types';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

type BucketOf = (localMs: number) => number;

const dayBucket: BucketOf = (ms) => Math.floor(ms / MS_PER_DAY);

// Epoch day 0 is a Thursday, so shifting by 3 aligns week boundaries to Monday.
const weekBucket: BucketOf = (ms) => Math.floor((dayBucket(ms) + 3) / 7);

const monthBucket: BucketOf = (ms) => {
	const d = new Date(ms);
	return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

function newestPerBucket(
	newestFirst: SnapshotRef[],
	count: number,
	bucketOf: BucketOf,
	tzOffsetMinutes: number,
	keep: Set<SnapshotId>,
): void {
	const seen = new Set<number>();
	for (const snap of newestFirst) {
		if (seen.size >= count) return;
		const bucket = bucketOf(snap.createdAt + tzOffsetMinutes * MS_PER_MINUTE);
		if (seen.has(bucket)) continue;
		seen.add(bucket);
		keep.add(snap.id);
	}
}

export function selectKeep(
	snapshots: SnapshotRef[],
	policy: RetentionPolicy,
	tzOffsetMinutes: number,
): Set<SnapshotId> {
	const all = new Set(snapshots.map((s) => s.id));
	const unlimited = [policy.keepLast, policy.daily, policy.weekly, policy.monthly].every((n) => n <= 0);
	if (unlimited || snapshots.length === 0) return all;

	const newestFirst = [...snapshots].sort(
		(a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
	);
	const keep = new Set<SnapshotId>();
	const newest = newestFirst[0];
	if (newest) keep.add(newest.id);
	for (const snap of newestFirst.slice(0, Math.max(0, policy.keepLast))) keep.add(snap.id);
	newestPerBucket(newestFirst, policy.daily, dayBucket, tzOffsetMinutes, keep);
	newestPerBucket(newestFirst, policy.weekly, weekBucket, tzOffsetMinutes, keep);
	newestPerBucket(newestFirst, policy.monthly, monthBucket, tzOffsetMinutes, keep);
	return keep;
}
