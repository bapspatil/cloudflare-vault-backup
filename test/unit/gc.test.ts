import { describe, it, expect } from 'vitest';
import { chunk, selectGarbage } from '../../src/core/gc';
import type { ListedObject } from '../../src/core/types';

const NOW = 1_000_000_000;
const GRACE = 86_400_000;

const obj = (key: string, lastModified: number): ListedObject => ({ key, size: 1, lastModified, etag: 'e' });

const hashFromKey = (key: string): string | null => {
	const m = /^p\/v\/blobs\/[0-9a-f]{2}\/([0-9a-f]+)$/.exec(key);
	return m?.[1] ?? null;
};

describe('selectGarbage', () => {
	const cutoff = NOW - GRACE;

	it('returns unreferenced blobs strictly older than the grace cutoff', () => {
		const listed = [
			obj('p/v/blobs/aa/aa01', cutoff - 1),
			obj('p/v/blobs/aa/aa02', cutoff),
			obj('p/v/blobs/aa/aa03', cutoff + 1),
			obj('p/v/blobs/bb/bb01', 0),
		];
		expect(selectGarbage(listed, new Set(['bb01']), NOW, GRACE, hashFromKey)).toEqual(['p/v/blobs/aa/aa01']);
	});

	it('keeps referenced blobs however old', () => {
		const listed = [obj('p/v/blobs/aa/aa01', 0)];
		expect(selectGarbage(listed, new Set(['aa01']), NOW, GRACE, hashFromKey)).toEqual([]);
	});

	it('never returns keys the parser rejects', () => {
		const listed = [obj('p/v/vault.json', 0), obj('p/v/blobs/aa/ZZ', 0), obj('p/v/blobs/cc/cc01', 0)];
		expect(selectGarbage(listed, new Set(), NOW, GRACE, hashFromKey)).toEqual(['p/v/blobs/cc/cc01']);
	});

	it('zero grace collects anything older than now', () => {
		const listed = [obj('p/v/blobs/aa/aa01', NOW - 1), obj('p/v/blobs/aa/aa02', NOW)];
		expect(selectGarbage(listed, new Set(), NOW, 0, hashFromKey)).toEqual(['p/v/blobs/aa/aa01']);
	});

	it('handles an empty listing', () => {
		expect(selectGarbage([], new Set(), NOW, GRACE, hashFromKey)).toEqual([]);
	});
});

describe('chunk', () => {
	it('splits with a short tail', () => {
		expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
	});

	it('returns exact multiples', () => {
		expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
	});

	it('returns no chunks for empty input', () => {
		expect(chunk([], 3)).toEqual([]);
	});

	it('rejects a non-positive size', () => {
		expect(() => chunk([1], 0)).toThrow(RangeError);
	});
});
