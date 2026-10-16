import type { Hash, ListedObject } from './types';

export function selectGarbage(
	listed: ListedObject[],
	referenced: Set<Hash>,
	nowMs: number,
	graceMs: number,
	hashFromKey: (key: string) => Hash | null,
): string[] {
	const cutoff = nowMs - graceMs;
	const garbage: string[] = [];
	for (const obj of listed) {
		const hash = hashFromKey(obj.key);
		if (hash === null || referenced.has(hash)) continue;
		if (obj.lastModified < cutoff) garbage.push(obj.key);
	}
	return garbage;
}

export function chunk<T>(items: T[], size: number): T[][] {
	if (size < 1) throw new RangeError('chunk size must be at least 1');
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}
