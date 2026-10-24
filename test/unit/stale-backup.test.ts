import { describe, expect, it } from 'vitest';
import { decideStaleBackup } from '../../src/core/stale-backup';
import { loadSettings } from '../../src/settings';

const HOUR = 3_600_000;
const input = { now: 48 * HOUR, trackedSince: 0, lastSuccessAt: 24 * HOUR, lastWarningAt: null, scheduled: true, configured: true, thresholdHours: 24 };

describe('stale backup decision', () => {
	it('warns only after the threshold has elapsed', () => {
		expect(decideStaleBackup({ ...input, now: input.now - 1 })).toEqual({ stale: false, notify: false });
		expect(decideStaleBackup(input)).toEqual({ stale: false, notify: false });
		expect(decideStaleBackup({ ...input, now: input.now + 1 })).toEqual({ stale: true, notify: true });
	});

	it.each([0, -1, NaN, Infinity])('disables warnings for threshold %s', (thresholdHours) => {
		expect(decideStaleBackup({ ...input, thresholdHours, lastSuccessAt: null })).toEqual({ stale: false, notify: false });
	});

	it('disables warnings when scheduling is off', () => {
		expect(decideStaleBackup({ ...input, scheduled: false, lastSuccessAt: null })).toEqual({ stale: false, notify: false });
	});

	it('waits a full threshold window from first tracking if no successful backup has been recorded', () => {
		const fresh = { ...input, trackedSince: input.now, lastSuccessAt: null };
		expect(decideStaleBackup(fresh)).toEqual({ stale: false, notify: false });
		expect(decideStaleBackup({ ...fresh, now: input.now + 24 * HOUR })).toEqual({ stale: false, notify: false });
		expect(decideStaleBackup({ ...fresh, now: input.now + 24 * HOUR + 1 })).toEqual({ stale: true, notify: true });
	});

	it('suppresses stale warnings when the connection is not configured', () => {
		expect(decideStaleBackup({ ...input, now: input.now + 1, configured: false })).toEqual({ stale: false, notify: false });
		expect(decideStaleBackup({ ...input, lastSuccessAt: null, configured: false })).toEqual({ stale: false, notify: false });
	});

	it('keeps the warning active while deduplicating notices for a full threshold window', () => {
		const stale = { ...input, lastSuccessAt: null, lastWarningAt: input.now };
		expect(decideStaleBackup(stale)).toEqual({ stale: true, notify: false });
		expect(decideStaleBackup({ ...stale, now: input.now + 24 * HOUR - 1 })).toEqual({ stale: true, notify: false });
		expect(decideStaleBackup({ ...stale, now: input.now + 24 * HOUR })).toEqual({ stale: true, notify: true });
	});

	it('clears the warning on success, including success at epoch zero', () => {
		expect(decideStaleBackup({ ...input, lastSuccessAt: input.now, lastWarningAt: input.now - 1 })).toEqual({ stale: false, notify: false });
		expect(decideStaleBackup({ ...input, now: HOUR, lastSuccessAt: 0 })).toEqual({ stale: false, notify: false });
	});

	it('does not repeat a notice when the clock moves backwards', () => {
		expect(decideStaleBackup({ ...input, lastSuccessAt: null, lastWarningAt: input.now + HOUR })).toEqual({ stale: true, notify: false });
	});

	it('defaults existing installations to a 24-hour warning and preserves off', () => {
		expect(loadSettings({ vaultId: 'v1' }).staleBackupWarningHours).toBe(24);
		expect(loadSettings({ vaultId: 'v1', staleBackupWarningHours: 0 }).staleBackupWarningHours).toBe(0);
	});

	it.each([-1, '24', NaN, Infinity])('defaults invalid stored warning threshold %s', (threshold) => {
		expect(loadSettings({ vaultId: 'v1', staleBackupWarningHours: threshold }).staleBackupWarningHours).toBe(24);
	});
});
