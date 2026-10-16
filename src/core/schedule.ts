export interface TickInput {
	nowMs: number;
	lastVaultEventAtMs: number | null;
	lastRunEndedAtMs: number | null;
	running: boolean;
	intervalMs: number;
	quietMs: number;
}

export type TickDecision =
	| { kind: 'run' }
	| { kind: 'skip'; reason: 'running' | 'disabled' | 'not-due' }
	| { kind: 'defer'; ms: number };

export function decideTick(i: TickInput): TickDecision {
	if (i.intervalMs <= 0) return { kind: 'skip', reason: 'disabled' };
	if (i.running) return { kind: 'skip', reason: 'running' };
	if (i.lastRunEndedAtMs !== null && i.nowMs - i.lastRunEndedAtMs < i.intervalMs) {
		return { kind: 'skip', reason: 'not-due' };
	}
	if (i.lastVaultEventAtMs !== null) {
		const quietFor = i.nowMs - i.lastVaultEventAtMs;
		if (quietFor < i.quietMs) return { kind: 'defer', ms: i.quietMs - quietFor };
	}
	return { kind: 'run' };
}
