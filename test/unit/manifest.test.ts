import { describe, expect, it } from 'vitest';
import {
	compareSnapshotIds,
	decodeLocalIndex,
	decodeManifest,
	decodeVaultDescriptor,
	encodeLocalIndex,
	encodeManifest,
	encodeVaultDescriptor,
	manifestTotals,
	newSnapshotId,
	parseSnapshotId,
} from '../../src/core/manifest';
import type { LocalIndex, Manifest, VaultDescriptor } from '../../src/core/types';

const utf8 = (s: string) => new TextEncoder().encode(s);
const json = (v: unknown) => utf8(JSON.stringify(v));

function manifest(files: Manifest['files']): Manifest {
	return {
		format: 1,
		id: '20261016T162233Z-3fa9',
		createdAt: '2026-10-16T16:22:33.000Z',
		deviceId: 'dev1',
		pluginVersion: '1.0.0',
		blobScheme: 'sha256',
		totals: { files: 2, bytes: 30 },
		files,
		skipped: [{ path: 'big.mov', reason: 'too-large', size: 999 }],
	};
}

const a = { h: 'aa', s: 10, m: 1 };
const b = { h: 'bb', s: 20, m: 2 };

describe('manifest codec', () => {
	it('encodes byte-identically regardless of files key order', () => {
		const one = encodeManifest(manifest({ 'b.md': b, 'a.md': a }));
		const two = encodeManifest(manifest({ 'a.md': a, 'b.md': b }));
		expect(new TextDecoder().decode(one)).toBe(new TextDecoder().decode(two));
		expect(new TextDecoder().decode(one)).toContain('"files":{"a.md":{"h":"aa","s":10,"m":1},"b.md"');
	});

	it('round-trips', () => {
		const m = manifest({ 'a.md': a, 'Notes/ü.md': b });
		expect(decodeManifest(encodeManifest(m))).toEqual({ ok: true, value: m });
	});

	it('rejects a newer format as unknown-format', () => {
		expect(decodeManifest(json({ ...manifest({}), format: 2 }))).toEqual({ ok: false, error: 'unknown-format' });
	});

	it('rejects malformed input as corrupt', () => {
		const { files: _files, ...noFiles } = manifest({});
		const corrupt = { ok: false, error: 'corrupt' };
		expect(decodeManifest(json(noFiles))).toEqual(corrupt);
		expect(decodeManifest(json({ ...manifest({}), format: 0 }))).toEqual(corrupt);
		expect(decodeManifest(json({ ...manifest({}), blobScheme: 'md5' }))).toEqual(corrupt);
		expect(decodeManifest(json(manifest({ 'a.md': { h: 'aa', s: -1, m: 1 } })))).toEqual(corrupt);
		expect(decodeManifest(json(manifest({ 'a.md': { h: 1, s: 1, m: 1 } as never })))).toEqual(corrupt);
		expect(decodeManifest(json({ ...manifest({}), skipped: [{ path: 'x', reason: 'gone', size: 1 }] }))).toEqual(
			corrupt,
		);
		expect(decodeManifest(utf8('{not json'))).toEqual(corrupt);
		expect(decodeManifest(json([1]))).toEqual(corrupt);
	});

	it('computes totals', () => {
		expect(manifestTotals({ 'a.md': a, 'b.md': b })).toEqual({ files: 2, bytes: 30 });
	});
});

describe('manifest path safety', () => {
	it('rejects a manifest whose file path escapes the vault', () => {
		const bytes = new TextEncoder().encode(
			JSON.stringify({
				format: 1, id: '20261016T162233Z-3fa9', createdAt: 'x', deviceId: 'd', pluginVersion: '0.1.0',
				blobScheme: 'sha256', totals: { files: 1, bytes: 1 },
				files: { '../escape.md': { h: 'ab', s: 1, m: 1 } }, skipped: [],
			}),
		);
		expect(decodeManifest(bytes)).toEqual({ ok: false, error: 'corrupt' });
	});
});

describe('vault descriptor codec', () => {
	it('rejects out-of-range KDF iterations', () => {
		const make = (iterations: number) =>
			new TextEncoder().encode(JSON.stringify({
				format: 1, vaultId: 'v', vaultName: 'n', createdAt: 'c',
				encryption: { kdf: 'PBKDF2-SHA256', iterations, salt: 'c2FsdA==', check: 'Y2hlY2s=' },
			}));
		expect(decodeVaultDescriptor(make(10))).toEqual({ ok: false, error: 'corrupt' });
		expect(decodeVaultDescriptor(make(50_000_000))).toEqual({ ok: false, error: 'corrupt' });
		expect(decodeVaultDescriptor(make(600_000)).ok).toBe(true);
	});
	const plain: VaultDescriptor = {
		format: 1,
		vaultId: '0123456789abcdef',
		vaultName: 'Notes',
		createdAt: '2026-10-16T16:22:33.000Z',
		encryption: null,
	};
	const encrypted: VaultDescriptor = {
		...plain,
		encryption: { kdf: 'PBKDF2-SHA256', iterations: 600000, salt: 'c2FsdA==', check: 'Y2hlY2s=' },
	};

	it('round-trips with and without encryption', () => {
		expect(decodeVaultDescriptor(encodeVaultDescriptor(plain))).toEqual({ ok: true, value: plain });
		expect(decodeVaultDescriptor(encodeVaultDescriptor(encrypted))).toEqual({ ok: true, value: encrypted });
	});

	it('rejects a newer format and a bad kdf', () => {
		expect(decodeVaultDescriptor(json({ ...plain, format: 3 }))).toEqual({ ok: false, error: 'unknown-format' });
		const badKdf = { ...encrypted, encryption: { ...encrypted.encryption, kdf: 'scrypt' } };
		expect(decodeVaultDescriptor(json(badKdf))).toEqual({ ok: false, error: 'corrupt' });
	});
});

describe('local index codec', () => {
	const idx: LocalIndex = {
		format: 2,
		backupSet: 'obsidian/0123456789abcdef|sha256',
		lastSnapshotId: '20261016T162233Z-3fa9',
		lastGcAt: null,
		files: { 'a.md': a },
		pendingBlobs: { bb: 1760631753000 },
	};

	it('round-trips', () => {
		expect(decodeLocalIndex(encodeLocalIndex(idx))).toEqual({ ok: true, value: idx });
	});

	it('reports a corrupt index', () => {
		expect(decodeLocalIndex(utf8(''))).toEqual({ ok: false, error: 'corrupt' });
		expect(decodeLocalIndex(json({ ...idx, pendingBlobs: { bb: 'x' } }))).toEqual({ ok: false, error: 'corrupt' });
	});
});

describe('snapshot ids', () => {
	it('formats and parses', () => {
		const id = newSnapshotId(new Date(Date.UTC(2026, 9, 16, 16, 22, 33)), '3fa9');
		expect(id).toBe('20261016T162233Z-3fa9');
		expect(parseSnapshotId(id)).toEqual({ createdAt: Date.UTC(2026, 9, 16, 16, 22, 33) });
	});

	it('rejects malformed and impossible ids', () => {
		expect(parseSnapshotId('20261016T162233Z')).toBeNull();
		expect(parseSnapshotId('20261316T162233Z-3fa9')).toBeNull();
		expect(parseSnapshotId('20261016T162233Z-3FA9')).toBeNull();
		expect(parseSnapshotId('20261016T162233Z-3fa9')).not.toBeNull();
	});

	it('orders ids by time', () => {
		const ids = ['20261016T162233Z-0001', '20250101T000000Z-ffff', '20261016T162234Z-0000'];
		expect([...ids].sort(compareSnapshotIds)).toEqual([
			'20250101T000000Z-ffff',
			'20261016T162233Z-0001',
			'20261016T162234Z-0000',
		]);
	});
});
