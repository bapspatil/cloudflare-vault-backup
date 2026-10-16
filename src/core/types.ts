export const MANIFEST_FORMAT = 1;
export const INDEX_FORMAT = 1;
export const VAULT_DESCRIPTOR_FORMAT = 1;

export type Hash = string;
export type SnapshotId = string;
export type VaultPath = string;

export type BlobScheme = 'sha256' | 'hmac-sha256';

export interface FileEntry {
	h: Hash;
	s: number;
	m: number;
}

export type SkipReason = 'too-large' | 'unreadable';

export interface SkippedFile {
	path: VaultPath;
	reason: SkipReason;
	size: number;
}

export interface Manifest {
	format: typeof MANIFEST_FORMAT;
	id: SnapshotId;
	createdAt: string;
	deviceId: string;
	pluginVersion: string;
	blobScheme: BlobScheme;
	totals: { files: number; bytes: number };
	files: Record<VaultPath, FileEntry>;
	skipped: SkippedFile[];
}

export type DecodeError = 'unknown-format' | 'corrupt';
export type Decoded<T> = { ok: true; value: T } | { ok: false; error: DecodeError };

export interface EncryptionDescriptor {
	kdf: 'PBKDF2-SHA256';
	iterations: number;
	salt: string;
	check: string;
}

export interface VaultDescriptor {
	format: typeof VAULT_DESCRIPTOR_FORMAT;
	vaultId: string;
	vaultName: string;
	createdAt: string;
	encryption: EncryptionDescriptor | null;
}

export interface LockRecord {
	deviceId: string;
	runId: string;
	expiresAt: string;
}

export interface LocalIndex {
	format: typeof INDEX_FORMAT;
	vaultId: string;
	lastSnapshotId: SnapshotId | null;
	lastGcAt: number | null;
	files: Record<VaultPath, FileEntry>;
	pendingBlobs: Record<Hash, number>;
}

export interface LocalFileStat {
	path: VaultPath;
	size: number;
	mtime: number;
}

export type Phase =
	| 'idle'
	| 'locking'
	| 'scanning'
	| 'uploading'
	| 'committing'
	| 'pruning'
	| 'done'
	| 'failed';

export type ErrorCode =
	| 'auth'
	| 'network'
	| 'throttled'
	| 'locked'
	| 'crypto'
	| 'io'
	| 'format'
	| 'cancelled';

export interface BackupError {
	code: ErrorCode;
	detail: string;
}

export interface RunStats {
	scanned: number;
	uploaded: number;
	uploadedBytes: number;
	reused: number;
	skipped: number;
	durationMs: number;
}

export type RunState =
	| { kind: 'idle' }
	| { kind: 'locking' }
	| { kind: 'scanning'; seen: number }
	| { kind: 'uploading'; done: number; total: number; bytesDone: number; bytesTotal: number }
	| { kind: 'committing' }
	| { kind: 'pruning'; deleted: number }
	| { kind: 'done'; snapshotId: SnapshotId | null; stats: RunStats }
	| { kind: 'failed'; phase: Phase; error: BackupError };

export interface RetentionPolicy {
	keepLast: number;
	daily: number;
	weekly: number;
	monthly: number;
}

export interface SnapshotRef {
	id: SnapshotId;
	createdAt: number;
}

export interface ListedObject {
	key: string;
	size: number;
	lastModified: number;
	etag: string;
}

export interface ListPage {
	objects: ListedObject[];
	commonPrefixes: string[];
	nextToken: string | null;
}

export interface RunLogEntry {
	startedAt: number;
	endedAt: number;
	trigger: 'manual' | 'scheduled' | 'startup';
	result: { kind: 'done'; snapshotId: SnapshotId | null; stats: RunStats } | { kind: 'failed'; error: BackupError };
}

export interface OpCounters {
	month: string;
	classA: number;
	classB: number;
	bytesUploaded: number;
	bytesDownloaded: number;
}
