import { describe, it, expect } from 'vitest';
import { decideTick, type TickDecision, type TickInput } from '../../src/core/schedule';

const base: TickInput = {
	nowMs: 10_000_000,
	lastVaultEventAtMs: null,
	lastRunEndedAtMs: null,
	running: false,
	intervalMs: 3_600_000,
	quietMs: 90_000,
};

const cases: Array<[string, Partial<TickInput>, TickDecision]> = [
	['never run, no events', {}, { kind: 'run' }],
	['disabled by zero interval', { intervalMs: 0 }, { kind: 'skip', reason: 'disabled' }],
	['disabled by negative interval', { intervalMs: -1 }, { kind: 'skip', reason: 'disabled' }],
	['disabled wins over running', { intervalMs: 0, running: true }, { kind: 'skip', reason: 'disabled' }],
	['running', { running: true }, { kind: 'skip', reason: 'running' }],
	['running wins over not-due', { running: true, lastRunEndedAtMs: 9_999_000 }, { kind: 'skip', reason: 'running' }],
	['not due', { lastRunEndedAtMs: 9_000_000 }, { kind: 'skip', reason: 'not-due' }],
	['due exactly at interval', { lastRunEndedAtMs: 6_400_000 }, { kind: 'run' }],
	['one ms before due', { lastRunEndedAtMs: 6_400_001 }, { kind: 'skip', reason: 'not-due' }],
	['due, event 30s ago, defers 60s', { lastRunEndedAtMs: 1_000_000, lastVaultEventAtMs: 9_970_000 }, { kind: 'defer', ms: 60_000 }],
	['due, event just now, defers full quiet', { lastRunEndedAtMs: 1_000_000, lastVaultEventAtMs: 10_000_000 }, { kind: 'defer', ms: 90_000 }],
	['due, event exactly quietMs ago', { lastVaultEventAtMs: 9_910_000 }, { kind: 'run' }],
	['due, old event', { lastRunEndedAtMs: 1_000_000, lastVaultEventAtMs: 5_000_000 }, { kind: 'run' }],
	['not due beats quiet defer', { lastRunEndedAtMs: 9_000_000, lastVaultEventAtMs: 9_990_000 }, { kind: 'skip', reason: 'not-due' }],
];

describe('decideTick', () => {
	it.each(cases)('%s', (_name, patch, expected) => {
		expect(decideTick({ ...base, ...patch })).toEqual(expected);
	});
});
