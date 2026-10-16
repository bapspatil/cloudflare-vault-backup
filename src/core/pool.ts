export async function runPool<T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let failed = false;
	let firstError: unknown;

	const lane = async () => {
		while (!failed && next < items.length) {
			const i = next++;
			try {
				results[i] = await worker(items[i] as T, i);
			} catch (e) {
				if (!failed) {
					failed = true;
					firstError = e;
				}
			}
		}
	};

	const lanes = Math.max(1, Math.min(Math.floor(concurrency), items.length));
	await Promise.all(Array.from({ length: lanes }, lane));
	if (failed) throw firstError;
	return results;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function jitteredBackoffMs(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
	const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
	return Math.floor(random() * ceiling);
}
