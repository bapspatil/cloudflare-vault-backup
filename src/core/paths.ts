import type { Hash, SnapshotId } from './types';

const TEXT_EXTENSIONS = new Set([
	'md', 'txt', 'canvas', 'json', 'css', 'js', 'ts', 'yaml', 'yml', 'csv', 'base', 'html', 'xml', 'svg',
]);

const trimSlashes = (s: string): string => s.replace(/^\/+|\/+$/g, '');

export function backupRoot(prefix: string, vaultId: string): string {
	const p = trimSlashes(prefix);
	return p === '' ? vaultId : `${p}/${vaultId}`;
}

export const descriptorKey = (root: string): string => `${root}/vault.json`;
export const lockKey = (root: string): string => `${root}/lock.json`;
export const snapshotsPrefix = (root: string): string => `${root}/snapshots/`;
export const snapshotKey = (root: string, id: SnapshotId): string => `${root}/snapshots/${id}.json`;
export const blobsPrefix = (root: string): string => `${root}/blobs/`;
export const blobKey = (root: string, hash: Hash): string => `${root}/blobs/${hash.slice(0, 2)}/${hash}`;

export function hashFromBlobKey(root: string, key: string): Hash | null {
	const prefix = blobsPrefix(root);
	if (!key.startsWith(prefix)) return null;
	const parts = key.slice(prefix.length).split('/');
	if (parts.length !== 2) return null;
	const [shard, hash] = parts as [string, string];
	if (hash.length < 2 || shard !== hash.slice(0, 2)) return null;
	return hash;
}

export function snapshotIdFromKey(root: string, key: string): SnapshotId | null {
	const prefix = snapshotsPrefix(root);
	if (!key.startsWith(prefix) || !key.endsWith('.json')) return null;
	const id = key.slice(prefix.length, -'.json'.length);
	return id === '' || id.includes('/') ? null : id;
}

const regexCache = new Map<string, RegExp>();

function globToRegex(pattern: string): RegExp {
	const cached = regexCache.get(pattern);
	if (cached) return cached;
	let src = '';
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i] as string;
		if (c === '*') {
			if (pattern[i + 1] === '*') {
				if (pattern[i + 2] === '/') {
					src += '(?:.*/)?';
					i += 2;
				} else {
					src += '.*';
					i += 1;
				}
			} else {
				src += '[^/]*';
			}
		} else if (c === '?') {
			src += '[^/]';
		} else {
			src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	const re = new RegExp(`^${src}$`, 'u');
	regexCache.set(pattern, re);
	return re;
}

export function matchGlob(pattern: string, path: string): boolean {
	const re = globToRegex(pattern);
	if (re.test(path)) return true;
	if (pattern.includes('/')) return false;
	return re.test(path.slice(path.lastIndexOf('/') + 1));
}

export const PLUGIN_STATE_FILES = {
	settings: 'data.json',
	index: 'index.json',
	log: 'log.json',
	counters: 'counters.json',
} as const;

export function defaultExcludes(configDir: string, pluginId: string): string[] {
	return [
		`${configDir}/workspace.json`,
		`${configDir}/workspace-mobile.json`,
		...Object.values(PLUGIN_STATE_FILES).map((name) => `${configDir}/plugins/${pluginId}/${name}`),
	];
}

export interface IncludeOptions {
	configDir: string;
	includeConfigDir: boolean;
	excludeGlobs: string[];
	pluginId: string;
}

export function isIncluded(path: string, opts: IncludeOptions): boolean {
	if (isUnderConfigDir(path, opts.configDir)) {
		if (!opts.includeConfigDir) return false;
		if (defaultExcludes(opts.configDir, opts.pluginId).some((p) => samePath(p, path))) return false;
	}
	return !opts.excludeGlobs.some((g) => matchGlob(g, path));
}

// Structural checks only: anything the host file system rejects fails per file at write time.
export function isSafeVaultPath(path: string): boolean {
	if (path === '' || path.length > 1024) return false;
	if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
	if (/^[a-zA-Z]:/.test(path)) return false;
	return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// NFKC folds compatibility look-alikes (Kelvin sign, ligatures), and Windows ignores trailing
// dots and spaces and treats ':' as a stream separator, so the gate folds all of those too.
const foldSegment = (seg: string): string =>
	seg.normalize('NFKC').toLowerCase().replace(/:.*$/, '').replace(/[. ]+$/, '');
const fold = (path: string): string[] => path.split('/').map(foldSegment);
const SHORT_NAME = /~\d/;

export function isUnderConfigDir(path: string, configDir: string): boolean {
	const dir = fold(configDir);
	const segs = fold(path);
	if (segs.length < dir.length) return false;
	return dir.every((d, i) => segs[i] === d || SHORT_NAME.test(segs[i] ?? ''));
}

// A scan reads the config folder and the files Obsidian indexes, and Obsidian skips every dot name.
export function isBackupPath(path: string, configDir: string): boolean {
	return isUnderConfigDir(path, configDir) || !path.split('/').some((seg) => seg.startsWith('.'));
}

export function samePath(a: string, b: string): boolean {
	return fold(a).join('/') === fold(b).join('/');
}

// HFS+ drops these code points (git's core.protectHFS list) and compares names case-insensitively
// up to canonical, not compatibility, equivalence, so restore also gates a path that matches a
// config path under that rule.
const HFS_IGNORABLE = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/g;
const foldHfs = (path: string): string[] =>
	path.split('/').map((seg) => seg.replace(HFS_IGNORABLE, '').normalize('NFC').toLowerCase());

export function isRestoreConfigPath(path: string, configDir: string): boolean {
	if (isUnderConfigDir(path, configDir)) return true;
	const dir = foldHfs(configDir);
	const segs = foldHfs(path);
	return segs.length >= dir.length && dir.every((d, i) => segs[i] === d);
}

export function sameRestorePath(a: string, b: string): boolean {
	return samePath(a, b) || foldHfs(a).join('/') === foldHfs(b).join('/');
}

export function isTextPath(path: string): boolean {
	const base = path.slice(path.lastIndexOf('/') + 1);
	const dot = base.lastIndexOf('.');
	if (dot <= 0) return false;
	return TEXT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

export function restoredCopyPath(path: string, dateIso: string): string {
	const slash = path.lastIndexOf('/');
	const base = path.slice(slash + 1);
	const dot = base.lastIndexOf('.');
	const suffix = ` (restored ${dateIso})`;
	if (dot <= 0) return `${path}${suffix}`;
	const cut = slash + 1 + dot;
	return `${path.slice(0, cut)}${suffix}${path.slice(cut)}`;
}
