import type { Manifest } from './types';

export const R2_PRICES = {
	asOf: '2026-10-16',
	storageUsdPerGbMonth: 0.015,
	classAUsdPerMillion: 4.5,
	classBUsdPerMillion: 0.36,
	free: { storageGbMonth: 10, classA: 1_000_000, classB: 10_000_000 },
} as const;

export interface UsageInput {
	storedBytes: number;
	classA: number;
	classB: number;
	dayOfMonth: number;
	daysInMonth: number;
}

export interface Estimate {
	storedGb: number;
	projectedClassA: number;
	projectedClassB: number;
	usd: number;
	withinFreeTier: boolean;
}

const GB = 1_000_000_000;
const over = (used: number, free: number) => Math.max(0, used - free);

export function estimateMonthly(u: UsageInput): Estimate {
	const scale = u.daysInMonth / Math.max(1, u.dayOfMonth);
	const storedGb = u.storedBytes / GB;
	const projectedClassA = u.classA * scale;
	const projectedClassB = u.classB * scale;
	const f = R2_PRICES.free;
	const usd =
		over(storedGb, f.storageGbMonth) * R2_PRICES.storageUsdPerGbMonth +
		(over(projectedClassA, f.classA) / 1_000_000) * R2_PRICES.classAUsdPerMillion +
		(over(projectedClassB, f.classB) / 1_000_000) * R2_PRICES.classBUsdPerMillion;
	return { storedGb, projectedClassA, projectedClassB, usd, withinFreeTier: usd === 0 };
}

export function formatUsd(usd: number): string {
	return `$${usd.toFixed(2)}`;
}

export function formatBytes(n: number): string {
	if (n < 1000) return `${Math.round(n)} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = n;
	let i = -1;
	while (v >= 1000 && i < units.length - 1) {
		v /= 1000;
		i++;
	}
	return `${v.toFixed(1)} ${units[i]}`;
}

export function uniqueBlobBytes(manifests: Manifest[], envelopeOverhead: number): number {
	const seen = new Set<string>();
	let total = 0;
	for (const m of manifests) {
		for (const e of Object.values(m.files)) {
			if (seen.has(e.h)) continue;
			seen.add(e.h);
			total += e.s + envelopeOverhead;
		}
	}
	return total;
}
