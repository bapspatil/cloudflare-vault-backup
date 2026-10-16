import { describe, expect, it } from 'vitest';
import { hasChanges, knownHashes, planScan } from '../../src/core/planner';
import type { FileEntry } from '../../src/core/types';

const e = (h: string, s: number, m: number): FileEntry => ({ h, s, m });

describe('planScan', () => {
	const index = { 'a.md': e('h1', 10, 100), 'Notes/b.md': e('h2', 20, 200), 'gone.md': e('h3', 5, 50), 'ünï/日本.md': e('h4', 7, 70) };

	it('classifies entries', () => {
		const plan = planScan(
			[
				{ path: 'a.md', size: 10, mtime: 100 },
				{ path: 'Notes/b.md', size: 20, mtime: 201 },
				{ path: 'new.md', size: 1, mtime: 1 },
				{ path: 'ünï/日本.md', size: 7, mtime: 70 },
				{ path: 'big.mov', size: 101, mtime: 5 },
			],
			index,
			100,
		);
		expect(plan.unchanged).toEqual({ 'a.md': e('h1', 10, 100), 'ünï/日本.md': e('h4', 7, 70) });
		expect(plan.toHash).toEqual([
			{ path: 'Notes/b.md', size: 20, mtime: 201 },
			{ path: 'new.md', size: 1, mtime: 1 },
		]);
		expect(plan.removed).toEqual(['gone.md']);
		expect(plan.skipped).toEqual([{ path: 'big.mov', reason: 'too-large', size: 101 }]);
	});

	it('size change with same mtime is rehashed', () => {
		const plan = planScan([{ path: 'a.md', size: 11, mtime: 100 }], { 'a.md': e('h1', 10, 100) }, 100);
		expect(plan.toHash).toEqual([{ path: 'a.md', size: 11, mtime: 100 }]);
	});

	it('size equal to the limit is not skipped', () => {
		const plan = planScan([{ path: 'x', size: 100, mtime: 1 }], {}, 100);
		expect(plan.toHash).toHaveLength(1);
		expect(plan.skipped).toEqual([]);
	});

	it('oversize file that was indexed is neither unchanged nor removed', () => {
		const plan = planScan([{ path: 'a.md', size: 500, mtime: 100 }], { 'a.md': e('h1', 500, 100) }, 100);
		expect(plan.unchanged).toEqual({});
		expect(plan.removed).toEqual([]);
		expect(plan.skipped).toEqual([{ path: 'a.md', reason: 'too-large', size: 500 }]);
	});

	it('handles prototype-like paths', () => {
		const plan = planScan([{ path: 'constructor', size: 1, mtime: 1 }], {}, 100);
		expect(plan.toHash).toHaveLength(1);
	});
});

describe('hasChanges', () => {
	const none = { unchanged: {}, toHash: [], removed: [], skipped: [] };
	it.each([
		['empty', none, {}, false],
		['toHash', { ...none, toHash: [{ path: 'a', size: 1, mtime: 1 }] }, {}, true],
		['removed', { ...none, removed: ['a'] }, {}, true],
		['new skipped only', { ...none, skipped: [{ path: 'big', reason: 'too-large' as const, size: 9 }] }, {}, false],
		['skipped that was indexed', { ...none, skipped: [{ path: 'big', reason: 'too-large' as const, size: 9 }] }, { big: e('h', 9, 1) }, true],
	])('%s', (_n, plan, index, expected) => {
		expect(hasChanges(plan, index)).toBe(expected);
	});
});

describe('knownHashes', () => {
	it('unions index hashes with fresh pending hashes', () => {
		const known = knownHashes(
			{ 'a.md': e('h1', 1, 1), 'b.md': e('h1', 1, 1), 'c.md': e('h2', 1, 1) },
			{ p1: 9_000, p2: 1_000, p3: 500 },
			10_000,
			5_000,
		);
		expect([...known].sort()).toEqual(['h1', 'h2', 'p1']);
	});

	it('pending exactly at max age is expired', () => {
		expect([...knownHashes({}, { p: 5_000 }, 10_000, 5_000)]).toEqual([]);
	});
});
