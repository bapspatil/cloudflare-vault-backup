import { acquireLock } from '../io/lock';
import type { LockHandle, LockOptions, R2Client } from '../io/types';

export interface LockKeeper {
	lost(): boolean;
	stop(): Promise<void>;
}

export function keepLock(handle: LockHandle, intervalMs: number): LockKeeper {
	let lost = false;
	let inFlight: Promise<void> | null = null;
	const refresh = async () => {
		try {
			if (!(await handle.refresh())) lost = true;
		} catch {
			lost = true;
		} finally {
			inFlight = null;
		}
	};
	const timer = window.setInterval(() => {
		if (lost || inFlight) return;
		inFlight = refresh();
	}, intervalMs);
	return {
		lost: () => lost,
		async stop() {
			window.clearInterval(timer);
			if (inFlight) await inFlight;
		},
	};
}

const LOCK_TTL_MS = 10 * 60_000;
const LOCK_REFRESH_MS = 60_000;

export const lockOptions = (who: { deviceId: string; now: () => number }): LockOptions => ({
	deviceId: who.deviceId,
	ttlMs: LOCK_TTL_MS,
	now: who.now,
});

export async function withLock<T>(
	client: R2Client,
	key: string,
	opts: LockOptions,
	task: (held: LockKeeper) => Promise<T>,
): Promise<{ held: true; value: T } | { held: false }> {
	const lock = await acquireLock(client, key, opts);
	if (!lock) return { held: false };
	const keeper = keepLock(lock, LOCK_REFRESH_MS);
	try {
		return { held: true, value: await task(keeper) };
	} finally {
		await keeper.stop();
		await lock.release().catch(() => undefined);
	}
}
