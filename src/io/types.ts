import type { Hash, ListPage, LocalIndex, LockRecord, Manifest, OpCounters, RunLogEntry, SnapshotId, VaultDescriptor } from '../core/types';
import type { BackupHealth } from '../core/stale-backup';

export interface TransportRequest {
	url: string;
	method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
	headers: Record<string, string>;
	body?: Uint8Array | string;
	timeoutMs: number;
}

export interface TransportResponse {
	status: number;
	headers: Record<string, string>;
	body: Uint8Array;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface R2Credentials {
	accountId: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
}

export interface PutCondition {
	ifNoneMatch?: '*';
	ifMatch?: string;
}

export type PutResult = { ok: true; etag: string } | { ok: false; status: 412 };

export type GetResult = { ok: true; body: Uint8Array; etag: string; serverDate: number } | { ok: false; status: 404 };

export type HeadResult = { ok: true; size: number; etag: string; serverDate: number } | { ok: false; status: 404 };

export interface R2Client {
	put(key: string, body: Uint8Array | string, opts?: { contentType?: string; condition?: PutCondition }): Promise<PutResult>;
	get(key: string): Promise<GetResult>;
	head(key: string): Promise<HeadResult>;
	delete(key: string): Promise<void>;
	deleteMany(keys: string[]): Promise<{ deleted: string[]; failed: string[] }>;
	list(prefix: string, opts?: { delimiter?: string; maxKeys?: number; token?: string }): Promise<ListPage>;
	listAll(prefix: string, opts?: { delimiter?: string }): Promise<ListPage>;
	counters(): OpCounters;
}

export class R2Error extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'R2Error';
	}
}

export interface Sealer {
	scheme: 'sha256' | 'hmac-sha256';
	hash(plain: Uint8Array): Promise<Hash>;
	seal(plain: Uint8Array, context: string): Promise<Uint8Array>;
	open(stored: Uint8Array, context: string): Promise<Uint8Array>;
}

export interface RemoteStore {
	readDescriptor(): Promise<VaultDescriptor | null>;
	writeDescriptor(d: VaultDescriptor): Promise<void>;
	listSnapshots(): Promise<SnapshotId[]>;
	readManifest(id: SnapshotId): Promise<Manifest | null>;
	writeManifest(m: Manifest): Promise<'written' | 'exists'>;
	deleteManifests(ids: SnapshotId[]): Promise<void>;
	hasBlob(hash: Hash): Promise<boolean>;
	putBlob(hash: Hash, plain: Uint8Array): Promise<number>;
	getBlob(hash: Hash): Promise<Uint8Array | null>;
	listBlobs(): Promise<ListPage>;
	deleteBlobKeys(keys: string[]): Promise<number>;
	root: string;
}

export interface LockHandle {
	record: LockRecord;
	refresh(): Promise<boolean>;
	release(): Promise<void>;
}

export interface LockOptions {
	deviceId: string;
	ttlMs: number;
	now: () => number;
}

export interface VaultFileStat {
	path: string;
	size: number;
	mtime: number;
}

export interface VaultPort {
	configDir: string;
	vaultName: string;
	isMobile: boolean;
	scan(includeConfigDir: boolean): Promise<VaultFileStat[]>;
	read(path: string): Promise<Uint8Array>;
	write(path: string, data: Uint8Array): Promise<void>;
	exists(path: string): Promise<boolean>;
	readPluginFile(name: string): Promise<Uint8Array | null>;
	writePluginFile(name: string, data: Uint8Array): Promise<void>;
}

export interface LocalState {
	loadBackupHealth(): Promise<BackupHealth>;
	saveBackupHealth(health: BackupHealth): Promise<void>;
	loadIndex(backupSet: string): Promise<LocalIndex>;
	saveIndex(index: LocalIndex): Promise<void>;
	loadLog(): Promise<RunLogEntry[]>;
	appendLog(entry: RunLogEntry): Promise<void>;
	loadCounters(): Promise<OpCounters | null>;
	saveCounters(c: OpCounters): Promise<void>;
}
