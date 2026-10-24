export interface BackupHealth {
	trackedSince: number;
	lastSuccessAt: number | null;
	lastWarningAt: number | null;
}

export function decideStaleBackup(input: BackupHealth & { now: number; scheduled: boolean; configured: boolean; thresholdHours: number }): { stale: boolean; notify: boolean } {
	const thresholdMs = input.thresholdHours * 3_600_000;
	const stale = input.configured && input.scheduled && Number.isFinite(thresholdMs) && thresholdMs > 0 &&
		input.now - (input.lastSuccessAt ?? input.trackedSince) > thresholdMs;
	return {
		stale,
		notify: stale && (input.lastWarningAt === null || input.now - input.lastWarningAt >= thresholdMs),
	};
}
