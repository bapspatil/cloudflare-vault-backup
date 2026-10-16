import { sha256Hex } from '../core/crypto';
import { isTextPath, restoredCopyPath } from '../core/paths';
import { runPool } from '../core/pool';
import type { Manifest } from '../core/types';
import type { RemoteStore, VaultPort } from '../io/types';

export interface RestoreDeps {
	store: RemoteStore;
	vault: VaultPort;
	now: () => number;
}

export type RestoreMode = { kind: 'copy' } | { kind: 'overwrite' } | { kind: 'into-folder'; folder: string };

export interface RestoreFileResult {
	path: string;
	outcome: 'written' | 'unchanged' | 'failed';
	target: string;
	detail?: string;
}

const MAX_TEXT_BYTES = 1024 * 1024;

function targetPath(deps: RestoreDeps, manifest: Manifest, path: string, mode: RestoreMode): string {
	if (mode.kind === 'overwrite') return path;
	if (mode.kind === 'copy') return restoredCopyPath(path, new Date(deps.now()).toISOString().slice(0, 10));
	return `${mode.folder.replace(/^\/+|\/+$/g, '')}/${path}`;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
}

export async function restoreFile(
	deps: RestoreDeps,
	manifest: Manifest,
	path: string,
	mode: RestoreMode,
): Promise<RestoreFileResult> {
	const target = targetPath(deps, manifest, path, mode);
	try {
		const entry = manifest.files[path];
		if (!entry) return { path, outcome: 'failed', target, detail: 'not in snapshot' };
		const bytes = await deps.store.getBlob(entry.h);
		if (!bytes) return { path, outcome: 'failed', target, detail: 'blob missing' };
		if (await deps.vault.exists(target)) {
			const current = await deps.vault.read(target);
			const same =
				manifest.blobScheme === 'sha256' ? (await sha256Hex(current)) === entry.h : sameBytes(current, bytes);
			if (same) return { path, outcome: 'unchanged', target };
		}
		await deps.vault.write(target, bytes);
		return { path, outcome: 'written', target };
	} catch (e) {
		return { path, outcome: 'failed', target, detail: e instanceof Error ? e.message : String(e) };
	}
}

export async function restoreSnapshot(
	deps: RestoreDeps,
	manifest: Manifest,
	mode: RestoreMode,
	onProgress: (done: number, total: number) => void,
	concurrency = 2,
): Promise<RestoreFileResult[]> {
	const paths = Object.keys(manifest.files);
	let done = 0;
	return runPool(paths, concurrency, async (path) => {
		const result = await restoreFile(deps, manifest, path, mode);
		onProgress(++done, paths.length);
		return result;
	});
}

export async function loadSnapshotText(deps: RestoreDeps, manifest: Manifest, path: string): Promise<string | null> {
	const entry = manifest.files[path];
	if (!entry || !isTextPath(path) || entry.s > MAX_TEXT_BYTES) return null;
	try {
		const bytes = await deps.store.getBlob(entry.h);
		if (!bytes || bytes.byteLength > MAX_TEXT_BYTES) return null;
		return new TextDecoder().decode(bytes);
	} catch {
		return null;
	}
}
