import { decideTick, type TickDecision } from '../core/schedule';
import type { ScheduleSettings } from '../settings';

export interface SchedulerDeps {
	now: () => number;
	setInterval: (fn: () => void, ms: number) => number;
	clearInterval: (id: number) => void;
	getSettings: () => ScheduleSettings;
	isRunning: () => boolean;
	lastRunEndedAt: () => number | null;
	run: () => Promise<unknown>;
}

export interface Scheduler {
	start(): void;
	stop(): void;
	noteVaultEvent(): void;
	tick(): TickDecision;
}

const TICK_MS = 60_000;

export function createScheduler(deps: SchedulerDeps): Scheduler {
	let timer: number | null = null;
	let lastVaultEventAt: number | null = null;

	const tick = (): TickDecision => {
		const s = deps.getSettings();
		const decision = decideTick({
			nowMs: deps.now(),
			lastVaultEventAtMs: lastVaultEventAt,
			lastRunEndedAtMs: deps.lastRunEndedAt(),
			running: deps.isRunning(),
			intervalMs: s.intervalMinutes * 60_000,
			quietMs: s.quietSeconds * 1000,
		});
		if (decision.kind === 'run') {
			// The runner logs its own failures; a rejection here must not become unhandled.
			deps.run().catch(() => undefined);
		}
		return decision;
	};

	return {
		start() {
			if (timer !== null) return;
			timer = deps.setInterval(tick, TICK_MS);
		},
		stop() {
			if (timer === null) return;
			deps.clearInterval(timer);
			timer = null;
		},
		noteVaultEvent() {
			lastVaultEventAt = deps.now();
		},
		tick,
	};
}
