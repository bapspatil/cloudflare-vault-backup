import { describe, expect, it } from 'vitest';
import { estimateMonthly, formatBytes, formatUsd, uniqueBlobBytes } from '../../src/core/cost';
import type { Manifest } from '../../src/core/types';

describe('estimateMonthly', () => {
	it('bills only above the free tier', () => {
		const e = estimateMonthly({ storedBytes: 50e9, classA: 2_000_000, classB: 0, dayOfMonth: 15, daysInMonth: 30 });
		expect(e.storedGb).toBe(50);
		expect(e.projectedClassA).toBe(4_000_000);
		expect(e.projectedClassB).toBe(0);
		// 40 GB * 0.015 = 0.60; 3M class A * 4.5/M = 13.50
		expect(e.usd).toBeCloseTo(14.1, 10);
		expect(e.withinFreeTier).toBe(false);
	});

	it('is free within the tier', () => {
		const e = estimateMonthly({ storedBytes: 1e9, classA: 1000, classB: 5000, dayOfMonth: 10, daysInMonth: 30 });
		expect(e.usd).toBe(0);
		expect(e.withinFreeTier).toBe(true);
	});

	it('bills class B above 10M', () => {
		const e = estimateMonthly({ storedBytes: 0, classA: 0, classB: 10_000_000, dayOfMonth: 15, daysInMonth: 30 });
		// 20M projected, 10M over * 0.36/M
		expect(e.usd).toBeCloseTo(3.6, 10);
	});
});

describe('formatting', () => {
	it('formats usd', () => {
		expect(formatUsd(0)).toBe('$0.00');
		expect(formatUsd(1.234)).toBe('$1.23');
	});

	it('formats bytes', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(1500)).toBe('1.5 KB');
		expect(formatBytes(20_000_000)).toBe('20.0 MB');
		expect(formatBytes(1_200_000_000)).toBe('1.2 GB');
	});
});

const manifest = (files: Record<string, { h: string; s: number }>): Manifest => ({
	format: 1,
	id: 'x',
	createdAt: '',
	deviceId: 'd',
	pluginVersion: '0',
	blobScheme: 'sha256',
	totals: { files: 0, bytes: 0 },
	files: Object.fromEntries(Object.entries(files).map(([p, f]) => [p, { ...f, m: 0 }])),
	skipped: [],
});

describe('uniqueBlobBytes', () => {
	it('counts each hash once across manifests, plus overhead', () => {
		const a = manifest({ 'a.md': { h: 'h1', s: 100 }, 'b.md': { h: 'h2', s: 50 } });
		const b = manifest({ 'a.md': { h: 'h1', s: 100 }, 'c.md': { h: 'h3', s: 10 }, 'd.md': { h: 'h3', s: 10 } });
		expect(uniqueBlobBytes([a, b], 28)).toBe(100 + 50 + 10 + 3 * 28);
		expect(uniqueBlobBytes([], 28)).toBe(0);
	});
});
