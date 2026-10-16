import { describe, expect, it } from 'vitest';
import { ERRORS, LABEL, NEXT, classifyHttp, transition } from '../../src/core/run-machine';
import type { RunState, RunStats } from '../../src/core/types';

const stats: RunStats = { scanned: 1, uploaded: 1, uploadedBytes: 1, reused: 0, skipped: 0, durationMs: 1 };
const failed: RunState = { kind: 'failed', phase: 'uploading', error: { code: 'network', detail: 'x' } };

describe('transition', () => {
	it('allows the happy path', () => {
		let s: RunState = { kind: 'idle' };
		s = transition(s, { kind: 'scanning', seen: 0 });
		s = transition(s, { kind: 'locking' });
		s = transition(s, { kind: 'uploading', done: 0, total: 2, bytesDone: 0, bytesTotal: 10 });
		s = transition(s, { kind: 'committing' });
		s = transition(s, { kind: 'pruning', deleted: 0 });
		s = transition(s, { kind: 'done', snapshotId: 's1', stats });
		s = transition(s, { kind: 'idle' });
		expect(s).toEqual({ kind: 'idle' });
	});

	it('allows progress updates within a phase', () => {
		const a: RunState = { kind: 'uploading', done: 1, total: 2, bytesDone: 1, bytesTotal: 2 };
		const b: RunState = { kind: 'uploading', done: 2, total: 2, bytesDone: 2, bytesTotal: 2 };
		expect(transition(a, b)).toBe(b);
	});

	it('allows an unchanged scan to finish offline', () => {
		const done: RunState = { kind: 'done', snapshotId: null, stats };
		expect(transition({ kind: 'scanning', seen: 5 }, done)).toBe(done);
	});

	it('throws on illegal transitions', () => {
		expect(() => transition({ kind: 'idle' }, { kind: 'committing' })).toThrow(
			'run-machine: illegal transition idle -> committing',
		);
		expect(() => transition({ kind: 'uploading', done: 0, total: 0, bytesDone: 0, bytesTotal: 0 }, { kind: 'pruning', deleted: 0 })).toThrow(
			'run-machine: illegal transition uploading -> pruning',
		);
		expect(() => transition({ kind: 'idle' }, failed)).toThrow('run-machine: illegal transition idle -> failed');
		expect(() => transition({ kind: 'committing' }, { kind: 'idle' })).toThrow();
	});

	it('lets every active phase fail', () => {
		for (const p of ['scanning', 'locking', 'uploading', 'committing', 'pruning'] as const) {
			expect(NEXT[p]).toContain('failed');
		}
		expect(NEXT.idle).not.toContain('failed');
		expect(NEXT.done).not.toContain('failed');
		expect(NEXT.failed).toEqual(['idle']);
	});
});

describe('LABEL', () => {
	it('renders short sentence-case strings', () => {
		expect(LABEL.uploading({ kind: 'uploading', done: 12, total: 40, bytesDone: 0, bytesTotal: 0 })).toBe('Backing up 12/40');
		expect(LABEL.failed(failed)).toBe('Backup failed: network');
		expect(LABEL.done({ kind: 'done', snapshotId: null, stats })).toBe('Backup up to date');
		expect(LABEL.done({ kind: 'done', snapshotId: 's', stats })).toBe('Backup complete');
		expect(LABEL.scanning({ kind: 'scanning', seen: 7 })).toBe('Scanning 7');
	});
});

describe('ERRORS and classifyHttp', () => {
	it('marks retryability', () => {
		expect(ERRORS.network.retryable).toBe(true);
		expect(ERRORS.throttled.retryable).toBe(true);
		expect(ERRORS.auth.retryable).toBe(false);
		expect(ERRORS.cancelled.retryable).toBe(false);
	});

	it('classifies status codes', () => {
		expect(classifyHttp(401)).toBe('auth');
		expect(classifyHttp(403)).toBe('auth');
		expect(classifyHttp(429)).toBe('throttled');
		expect(classifyHttp(500)).toBe('network');
		expect(classifyHttp(503)).toBe('network');
		expect(classifyHttp(412)).toBe('locked');
		expect(classifyHttp(200)).toBeNull();
		expect(classifyHttp(404)).toBeNull();
	});
});
