import { describe, it, expect } from 'vitest';
import { selectKeep } from '../../src/core/retention';
import type { RetentionPolicy, SnapshotRef } from '../../src/core/types';

const at = (iso: string): number => Date.parse(iso);

function fixture(): SnapshotRef[] {
	const snaps: SnapshotRef[] = [
		{ id: 'a1', createdAt: at('2026-08-05T10:00:00Z') },
		{ id: 'a2', createdAt: at('2026-08-05T18:00:00Z') },
		{ id: 'a3', createdAt: at('2026-08-20T09:00:00Z') },
		{ id: 'a4', createdAt: at('2026-08-20T21:00:00Z') },
		{ id: 'p1', createdAt: at('2026-09-02T08:00:00Z') },
		{ id: 'p2', createdAt: at('2026-09-02T20:00:00Z') },
		{ id: 'p3', createdAt: at('2026-09-10T07:00:00Z') },
		{ id: 'p4', createdAt: at('2026-09-10T19:00:00Z') },
		{ id: 'p5', createdAt: at('2026-09-15T12:00:00Z') },
		{ id: 'p6', createdAt: at('2026-09-15T18:00:00Z') },
		{ id: 'p7', createdAt: at('2026-09-28T06:00:00Z') },
		{ id: 'p8', createdAt: at('2026-09-28T23:00:00Z') },
	];
	for (let day = 1; day <= 14; day++) {
		const dd = String(day).padStart(2, '0');
		snaps.push({ id: `o${dd}a`, createdAt: at(`2026-10-${dd}T08:00:00Z`) });
		snaps.push({ id: `o${dd}b`, createdAt: at(`2026-10-${dd}T20:00:00Z`) });
	}
	return snaps;
}

const policy: RetentionPolicy = { keepLast: 3, daily: 7, weekly: 4, monthly: 6 };

const sorted = (s: Set<string>): string[] => [...s].sort();

describe('selectKeep', () => {
	it('keeps the exact expected set for the 40 snapshot fixture', () => {
		expect(fixture()).toHaveLength(40);
		expect(sorted(selectKeep(fixture(), policy, 0))).toEqual([
			'a4', 'o04b', 'o08b', 'o09b', 'o10b', 'o11b', 'o12b', 'o13b', 'o14a', 'o14b', 'p6', 'p8',
		]);
	});

	it('does not depend on input order', () => {
		const shuffled = [...fixture()].reverse();
		expect(sorted(selectKeep(shuffled, policy, 0))).toEqual(sorted(selectKeep(fixture(), policy, 0)));
	});

	it('counts N distinct populated buckets across sparse history', () => {
		const sparse: SnapshotRef[] = [
			{ id: 'x1', createdAt: at('2026-01-01T12:00:00Z') },
			{ id: 'x2', createdAt: at('2026-03-01T12:00:00Z') },
			{ id: 'x3', createdAt: at('2026-06-01T12:00:00Z') },
			{ id: 'x4', createdAt: at('2026-10-01T12:00:00Z') },
		];
		expect(sorted(selectKeep(sparse, { keepLast: 1, daily: 3, weekly: 0, monthly: 0 }, 0))).toEqual(['x2', 'x3', 'x4']);
	});

	it('shifts day buckets by the tz offset', () => {
		const snaps: SnapshotRef[] = [
			{ id: 'x2', createdAt: at('2026-10-10T10:00:00Z') },
			{ id: 'x1', createdAt: at('2026-10-10T23:30:00Z') },
			{ id: 'y', createdAt: at('2026-10-11T12:00:00Z') },
		];
		const p: RetentionPolicy = { keepLast: 1, daily: 2, weekly: 0, monthly: 0 };
		expect(sorted(selectKeep(snaps, p, 0))).toEqual(['x1', 'y']);
		expect(sorted(selectKeep(snaps, p, 120))).toEqual(['x2', 'y']);
	});

	it('treats ISO weeks as Monday to Sunday', () => {
		const snaps: SnapshotRef[] = [
			{ id: 'mon', createdAt: at('2026-10-05T01:00:00Z') },
			{ id: 'sun', createdAt: at('2026-10-04T23:00:00Z') },
			{ id: 'new', createdAt: at('2026-10-12T01:00:00Z') },
		];
		expect(sorted(selectKeep(snaps, { keepLast: 1, daily: 0, weekly: 2, monthly: 0 }, 0))).toEqual(['mon', 'new']);
	});

	it('returns every id for a zero policy', () => {
		expect(sorted(selectKeep(fixture(), { keepLast: 0, daily: 0, weekly: 0, monthly: 0 }, 0))).toEqual(
			fixture().map((s) => s.id).sort(),
		);
	});

	it('always keeps the newest snapshot', () => {
		const snaps: SnapshotRef[] = [
			{ id: 'old', createdAt: 1 },
			{ id: 'new', createdAt: at('2026-10-01T00:00:00Z') },
		];
		expect(sorted(selectKeep(snaps, { keepLast: 0, daily: 0, weekly: 0, monthly: 1 }, 0))).toEqual(['new']);
	});

	it('returns an empty set for no snapshots', () => {
		expect(selectKeep([], policy, 0).size).toBe(0);
	});
});
