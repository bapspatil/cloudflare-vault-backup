import type { ErrorCode, Phase, RunState } from './types';

export const NEXT: Record<Phase, readonly Phase[]> = {
	idle: ['scanning', 'locking'],
	scanning: ['locking', 'done', 'failed'],
	locking: ['uploading', 'failed'],
	uploading: ['committing', 'failed'],
	committing: ['pruning', 'done', 'failed'],
	pruning: ['done', 'failed'],
	done: ['idle'],
	failed: ['idle'],
};

// Progress updates re-enter the same phase; only these carry progress payloads.
const SELF_LOOP: ReadonlySet<Phase> = new Set(['scanning', 'uploading', 'pruning']);

export function transition(current: RunState, next: RunState): RunState {
	const from = current.kind;
	const to = next.kind;
	if (from === to && SELF_LOOP.has(from)) return next;
	if (!NEXT[from].includes(to)) {
		throw new Error(`run-machine: illegal transition ${from} -> ${to}`);
	}
	return next;
}

export const LABEL: Record<RunState['kind'], (s: RunState) => string> = {
	idle: () => 'Backup idle',
	locking: () => 'Preparing backup',
	scanning: (s) => (s.kind === 'scanning' ? `Scanning ${s.seen}` : 'Scanning'),
	uploading: (s) => (s.kind === 'uploading' ? `Backing up ${s.done}/${s.total}` : 'Backing up'),
	committing: () => 'Saving snapshot',
	pruning: (s) => (s.kind === 'pruning' ? `Cleaning up ${s.deleted}` : 'Cleaning up'),
	done: (s) => (s.kind === 'done' && s.snapshotId === null ? 'Backup up to date' : 'Backup complete'),
	failed: (s) => (s.kind === 'failed' ? `Backup failed: ${s.error.code}` : 'Backup failed'),
};

export const ERRORS: Record<ErrorCode, { retryable: boolean; message: string }> = {
	auth: { retryable: false, message: 'Check your R2 access key and secret.' },
	network: { retryable: true, message: 'Could not reach R2. Check your connection and endpoint.' },
	throttled: { retryable: true, message: 'R2 is rate limiting requests. Retrying soon.' },
	locked: { retryable: true, message: 'Another device is backing up this vault.' },
	crypto: { retryable: false, message: 'Encryption failed. Check your passphrase.' },
	io: { retryable: false, message: 'Could not read or write a vault file.' },
	format: { retryable: false, message: 'Backup data is in an unknown or corrupt format.' },
	cancelled: { retryable: false, message: 'Backup cancelled.' },
};

export function classifyHttp(status: number): ErrorCode | null {
	if (status === 401 || status === 403) return 'auth';
	if (status === 429) return 'throttled';
	if (status === 412) return 'locked';
	if (status >= 500 && status <= 599) return 'network';
	return null;
}
