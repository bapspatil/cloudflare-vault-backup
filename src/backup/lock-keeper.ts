import type { LockHandle } from '../io/types';

export interface LockKeeper {
	lost(): boolean;
	stop(): Promise<void>;
}

export function keepLock(handle: LockHandle, intervalMs: number): LockKeeper {
	let lost = false;
	let inFlight: Promise<void> | null = null;
	const timer = window.setInterval(() => {
		if (lost || inFlight) return;
		inFlight = handle.refresh().then(
			(ok) => {
				if (!ok) lost = true;
			},
			() => {
				lost = true;
			},
		);
		void inFlight.finally(() => {
			inFlight = null;
		});
	}, intervalMs);
	return {
		lost: () => lost,
		async stop() {
			window.clearInterval(timer);
			if (inFlight) await inFlight;
		},
	};
}
