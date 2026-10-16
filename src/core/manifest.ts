import {
	INDEX_FORMAT,
	MANIFEST_FORMAT,
	VAULT_DESCRIPTOR_FORMAT,
	type BlobScheme,
	type Decoded,
	type EncryptionDescriptor,
	type FileEntry,
	type LocalIndex,
	type Manifest,
	type SkipReason,
	type SkippedFile,
	type VaultDescriptor,
} from './types';

type Json = Record<string, unknown>;

class Corrupt extends Error {}

const BLOB_SCHEMES: readonly BlobScheme[] = ['sha256', 'hmac-sha256'];
const SKIP_REASONS: readonly SkipReason[] = ['too-large', 'unreadable'];

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function str(v: unknown): string {
	if (typeof v !== 'string') throw new Corrupt();
	return v;
}

function count(v: unknown): number {
	if (!isCount(v)) throw new Corrupt();
	return v;
}

function record(v: unknown): Json {
	if (!isRecord(v)) throw new Corrupt();
	return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
	if (!allowed.includes(v as T)) throw new Corrupt();
	return v as T;
}

function nullable<T>(v: unknown, parse: (v: unknown) => T): T | null {
	return v === null ? null : parse(v);
}

function fileEntry(v: unknown): FileEntry {
	const o = record(v);
	return { h: str(o.h), s: count(o.s), m: count(o.m) };
}

function fileMap(v: unknown): Record<string, FileEntry> {
	const out: Record<string, FileEntry> = {};
	for (const [path, entry] of Object.entries(record(v))) out[path] = fileEntry(entry);
	return out;
}

function skippedFile(v: unknown): SkippedFile {
	const o = record(v);
	return { path: str(o.path), reason: oneOf(o.reason, SKIP_REASONS), size: count(o.size) };
}

function sortedFiles(files: Record<string, FileEntry>): Record<string, FileEntry> {
	const out: Record<string, FileEntry> = {};
	for (const path of Object.keys(files).sort()) {
		const e = files[path] as FileEntry;
		out[path] = { h: e.h, s: e.s, m: e.m };
	}
	return out;
}

function decodeVersioned<T>(bytes: Uint8Array, format: number, parse: (o: Json) => T): Decoded<T> {
	try {
		const o = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
		if (typeof o.format === 'number' && o.format > format) return { ok: false, error: 'unknown-format' };
		if (o.format !== format) return { ok: false, error: 'corrupt' };
		return { ok: true, value: parse(o) };
	} catch {
		return { ok: false, error: 'corrupt' };
	}
}

export function manifestTotals(files: Record<string, FileEntry>): { files: number; bytes: number } {
	let bytes = 0;
	let n = 0;
	for (const e of Object.values(files)) {
		bytes += e.s;
		n++;
	}
	return { files: n, bytes };
}

export function encodeManifest(m: Manifest): Uint8Array {
	return encode({
		format: m.format,
		id: m.id,
		createdAt: m.createdAt,
		deviceId: m.deviceId,
		pluginVersion: m.pluginVersion,
		blobScheme: m.blobScheme,
		totals: { files: m.totals.files, bytes: m.totals.bytes },
		files: sortedFiles(m.files),
		skipped: m.skipped.map((s) => ({ path: s.path, reason: s.reason, size: s.size })),
	});
}

export function decodeManifest(bytes: Uint8Array): Decoded<Manifest> {
	return decodeVersioned(bytes, MANIFEST_FORMAT, (o) => {
		const totals = record(o.totals);
		if (!Array.isArray(o.skipped)) throw new Corrupt();
		return {
			format: MANIFEST_FORMAT,
			id: str(o.id),
			createdAt: str(o.createdAt),
			deviceId: str(o.deviceId),
			pluginVersion: str(o.pluginVersion),
			blobScheme: oneOf(o.blobScheme, BLOB_SCHEMES),
			totals: { files: count(totals.files), bytes: count(totals.bytes) },
			files: fileMap(o.files),
			skipped: o.skipped.map(skippedFile),
		};
	});
}

export function encodeVaultDescriptor(d: VaultDescriptor): Uint8Array {
	const e = d.encryption;
	return encode({
		format: d.format,
		vaultId: d.vaultId,
		vaultName: d.vaultName,
		createdAt: d.createdAt,
		encryption: e && { kdf: e.kdf, iterations: e.iterations, salt: e.salt, check: e.check },
	});
}

function encryptionDescriptor(v: unknown): EncryptionDescriptor {
	const o = record(v);
	const iterations = count(o.iterations);
	if (!Number.isInteger(iterations) || iterations < 1) throw new Corrupt();
	return { kdf: oneOf(o.kdf, ['PBKDF2-SHA256'] as const), iterations, salt: str(o.salt), check: str(o.check) };
}

export function decodeVaultDescriptor(bytes: Uint8Array): Decoded<VaultDescriptor> {
	return decodeVersioned(bytes, VAULT_DESCRIPTOR_FORMAT, (o) => ({
		format: VAULT_DESCRIPTOR_FORMAT,
		vaultId: str(o.vaultId),
		vaultName: str(o.vaultName),
		createdAt: str(o.createdAt),
		encryption: nullable(o.encryption, encryptionDescriptor),
	}));
}

export function encodeLocalIndex(idx: LocalIndex): Uint8Array {
	const pending: Record<string, number> = {};
	for (const h of Object.keys(idx.pendingBlobs).sort()) pending[h] = idx.pendingBlobs[h] as number;
	return encode({
		format: idx.format,
		vaultId: idx.vaultId,
		lastSnapshotId: idx.lastSnapshotId,
		lastGcAt: idx.lastGcAt,
		files: sortedFiles(idx.files),
		pendingBlobs: pending,
	});
}

export function decodeLocalIndex(bytes: Uint8Array): Decoded<LocalIndex> {
	return decodeVersioned(bytes, INDEX_FORMAT, (o) => {
		const pendingBlobs: Record<string, number> = {};
		for (const [h, t] of Object.entries(record(o.pendingBlobs))) pendingBlobs[h] = count(t);
		return {
			format: INDEX_FORMAT,
			vaultId: str(o.vaultId),
			lastSnapshotId: nullable(o.lastSnapshotId, str),
			lastGcAt: nullable(o.lastGcAt, count),
			files: fileMap(o.files),
			pendingBlobs,
		};
	});
}

const SNAPSHOT_ID = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{4}$/;

export function newSnapshotId(now: Date, rand4hex: string): string {
	const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '');
	return `${stamp}Z-${rand4hex}`;
}

export function parseSnapshotId(id: string): { createdAt: number } | null {
	const match = SNAPSHOT_ID.exec(id);
	if (!match) return null;
	const [y, mo, d, h, mi, s] = match.slice(1).map(Number) as [number, number, number, number, number, number];
	const createdAt = Date.UTC(y, mo - 1, d, h, mi, s);
	return newSnapshotId(new Date(createdAt), id.slice(-4)) === id ? { createdAt } : null;
}

export function compareSnapshotIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
