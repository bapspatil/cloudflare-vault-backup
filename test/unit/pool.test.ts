import { describe, expect, it } from 'vitest';
import { jitteredBackoffMs, runPool, sleep } from '../../src/core/pool';

describe('runPool', () => {
	it('never exceeds concurrency and preserves order', async () => {
		let inFlight = 0;
		let max = 0;
		const items = Array.from({ length: 12 }, (_, i) => i);
		const out = await runPool(items, 3, async (n) => {
			inFlight++;
			max = Math.max(max, inFlight);
			await sleep((12 - n) % 4);
			inFlight--;
			return n * 2;
		});
		expect(max).toBe(3);
		expect(out).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
	});

	it('handles empty input', async () => {
		expect(await runPool([], 3, async (n: number) => n)).toEqual([]);
	});

	it('rejects with the first error after in-flight workers settle', async () => {
		const settled: number[] = [];
		const started: number[] = [];
		const p = runPool([0, 1, 2, 3, 4, 5], 2, async (n) => {
			started.push(n);
			if (n === 0) {
				await sleep(1);
				throw new Error('boom');
			}
			await sleep(10);
			settled.push(n);
			return n;
		});
		await expect(p).rejects.toThrow('boom');
		expect(settled).toEqual([1]);
		expect(started).toEqual([0, 1]);
	});
});

describe('jitteredBackoffMs', () => {
	it('scales exponentially and caps', () => {
		expect(jitteredBackoffMs(0, 100, 10_000, () => 0.5)).toBe(50);
		expect(jitteredBackoffMs(3, 100, 10_000, () => 0.5)).toBe(400);
		expect(jitteredBackoffMs(10, 100, 1_000, () => 0.5)).toBe(500);
		expect(jitteredBackoffMs(2, 100, 10_000, () => 0)).toBe(0);
	});
});
