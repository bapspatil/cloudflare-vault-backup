import { describe, expect, it } from 'vitest';
import { createScheduler, type SchedulerDeps } from '../../src/backup/scheduler';

function setup(over: Partial<SchedulerDeps> = {}) {
	const state = { now: 10_000_000, running: false, runs: 0, cleared: [] as number[], registered: [] as Array<{ ms: number }> };
	const deps: SchedulerDeps = {
		now: () => state.now,
		setInterval: (_fn, ms) => {
			state.registered.push({ ms });
			return 42;
		},
		clearInterval: (id) => state.cleared.push(id),
		getSettings: () => ({ intervalMinutes: 60, quietSeconds: 90, onStartup: false }),
		isRunning: () => state.running,
		lastRunEndedAt: () => null,
		run: async () => {
			state.runs++;
		},
		...over,
	};
	return { state, scheduler: createScheduler(deps) };
}

describe('scheduler', () => {
	it('checks backup health on every tick, even while disabled, running, or in the quiet period', () => {
		let checks = 0;
		const { state, scheduler } = setup({ onTick: () => { checks++; } });
		state.running = true;
		scheduler.tick();
		state.running = false;
		scheduler.noteVaultEvent();
		scheduler.tick();
		expect(checks).toBe(2);
		expect(state.runs).toBe(0);
		const disabled = setup({
			onTick: () => { checks++; },
			getSettings: () => ({ intervalMinutes: 0, quietSeconds: 90, onStartup: false }),
		});
		disabled.scheduler.tick();
		expect(checks).toBe(3);
	});

	it('registers a 60000 ms interval on start', () => {
		const { state, scheduler } = setup();
		scheduler.start();
		expect(state.registered).toEqual([{ ms: 60_000 }]);
	});

	it('skips as disabled when intervalMinutes is 0', () => {
		const { state, scheduler } = setup({ getSettings: () => ({ intervalMinutes: 0, quietSeconds: 90, onStartup: false }) });
		expect(scheduler.tick()).toEqual({ kind: 'skip', reason: 'disabled' });
		expect(state.runs).toBe(0);
	});

	it('runs exactly once when due', () => {
		const { state, scheduler } = setup();
		expect(scheduler.tick()).toEqual({ kind: 'run' });
		expect(state.runs).toBe(1);
	});

	it('swallows run rejections', async () => {
		const { scheduler } = setup({ run: () => Promise.reject(new Error('boom')) });
		expect(scheduler.tick()).toEqual({ kind: 'run' });
		await Promise.resolve();
	});

	it('defers by the exact remaining quiet time after a vault event', () => {
		const { state, scheduler } = setup();
		scheduler.noteVaultEvent();
		state.now += 30_000;
		expect(scheduler.tick()).toEqual({ kind: 'defer', ms: 60_000 });
		expect(state.runs).toBe(0);
	});

	it('skips while running', () => {
		const { state, scheduler } = setup();
		state.running = true;
		expect(scheduler.tick()).toEqual({ kind: 'skip', reason: 'running' });
		expect(state.runs).toBe(0);
	});

	it('clears the interval id on stop', () => {
		const { state, scheduler } = setup();
		scheduler.start();
		scheduler.stop();
		expect(state.cleared).toEqual([42]);
	});
});
