import { describe, expect, it } from 'vitest';
import {
	backupRoot, blobKey, blobsPrefix, defaultExcludes, descriptorKey, hashFromBlobKey, isIncluded,
	isSafeVaultPath, isTextPath, isUnderConfigDir, lockKey, matchGlob, restoredCopyPath, snapshotIdFromKey, snapshotKey, snapshotsPrefix,
} from '../../src/core/paths';

describe('key builders', () => {
	const root = backupRoot('obsidian', 'abcd1234abcd1234');
	it('builds keys', () => {
		expect(root).toBe('obsidian/abcd1234abcd1234');
		expect(descriptorKey(root)).toBe('obsidian/abcd1234abcd1234/vault.json');
		expect(lockKey(root)).toBe('obsidian/abcd1234abcd1234/lock.json');
		expect(snapshotKey(root, '20261016T162233Z-3fa9')).toBe('obsidian/abcd1234abcd1234/snapshots/20261016T162233Z-3fa9.json');
		expect(snapshotsPrefix(root)).toBe('obsidian/abcd1234abcd1234/snapshots/');
		expect(blobsPrefix(root)).toBe('obsidian/abcd1234abcd1234/blobs/');
		expect(blobKey(root, 'ab12cd')).toBe('obsidian/abcd1234abcd1234/blobs/ab/ab12cd');
	});
	it.each([
		['', 'v1', 'v1'],
		['/', 'v1', 'v1'],
		['/obsidian/', 'v1', 'obsidian/v1'],
		['a/b', 'v1', 'a/b/v1'],
	])('backupRoot(%j, %j) = %j', (prefix, id, expected) => {
		expect(backupRoot(prefix, id)).toBe(expected);
	});
	it('empty prefix has no leading slash', () => {
		expect(blobKey(backupRoot('', 'v1'), 'ffee')).toBe('v1/blobs/ff/ffee');
	});
	it.each([
		['obsidian/v1/blobs/ab/abcdef', 'abcdef'],
		['obsidian/v1/blobs/ab/xbcdef', null],
		['obsidian/v1/blobs/abcdef', null],
		['obsidian/v1/snapshots/abcdef', null],
		['other/v1/blobs/ab/abcdef', null],
		['obsidian/v1/blobs/ab/abcdef/extra', null],
	])('hashFromBlobKey(%j) = %j', (key, expected) => {
		expect(hashFromBlobKey('obsidian/v1', key)).toBe(expected);
	});
	it.each([
		['obsidian/v1/snapshots/20261016T162233Z-3fa9.json', '20261016T162233Z-3fa9'],
		['obsidian/v1/snapshots/.json', null],
		['obsidian/v1/snapshots/a/b.json', null],
		['obsidian/v1/snapshots/a.txt', null],
		['obsidian/v1/vault.json', null],
	])('snapshotIdFromKey(%j) = %j', (key, expected) => {
		expect(snapshotIdFromKey('obsidian/v1', key)).toBe(expected);
	});
});

describe('matchGlob', () => {
	it.each([
		['Templates/**', 'Templates/a.md', true],
		['Templates/**', 'Templates/sub/deep/a.md', true],
		['Templates/**', 'Other/Templates/a.md', false],
		['**/Templates/**', 'Other/Templates/a.md', true],
		['**/Templates/**', 'Templates/a.md', true],
		['*.pdf', 'report.pdf', true],
		['*.pdf', 'docs/report.pdf', true],
		['*.pdf', 'docs/report.PDF', false],
		['*.pdf', 'docs/report.pdf.md', false],
		['.trash/**', '.trash/old.md', true],
		['.trash/**', 'notes/.trash/old.md', false],
		['docs/*.md', 'docs/a.md', true],
		['docs/*.md', 'docs/sub/a.md', false],
		['a?c.md', 'abc.md', true],
		['a?c.md', 'a/c.md', false],
		['Notes/ünï.md', 'Notes/ünï.md', true],
		['日本語/**', '日本語/メモ.md', true],
		['*.md', 'Ünï/日本.md', true],
		['file+(1).md', 'file+(1).md', true],
		['a.b', 'axb', false],
		['Notes/a.md', 'notes/a.md', false],
	])('matchGlob(%j, %j) = %j', (pattern, path, expected) => {
		expect(matchGlob(pattern, path)).toBe(expected);
	});
});

describe('defaultExcludes', () => {
	it.each([
		['.obsidian', [
			'.obsidian/workspace.json',
			'.obsidian/workspace-mobile.json',
			'.obsidian/plugins/r2-vault-sync/data.json',
			'.obsidian/plugins/r2-vault-sync/index.json',
			'.obsidian/plugins/r2-vault-sync/log.json',
		]],
		['cfg', [
			'cfg/workspace.json',
			'cfg/workspace-mobile.json',
			'cfg/plugins/r2-vault-sync/data.json',
			'cfg/plugins/r2-vault-sync/index.json',
			'cfg/plugins/r2-vault-sync/log.json',
		]],
	])('configDir %j', (dir, expected) => {
		expect(defaultExcludes(dir, 'r2-vault-sync')).toEqual(expected);
	});
});

describe('isIncluded', () => {
	const base = { configDir: '.obsidian', includeConfigDir: true, excludeGlobs: [] as string[], pluginId: 'r2-vault-sync' };
	it.each([
		['Notes/a.md', base, true],
		['.obsidian/app.json', base, true],
		['.obsidian/plugins/other/main.js', base, true],
		['.obsidian/workspace.json', base, false],
		['.obsidian/workspace-mobile.json', base, false],
		['.obsidian/plugins/r2-vault-sync/data.json', base, false],
		['.obsidian/plugins/r2-vault-sync/index.json', base, false],
		['.obsidian/plugins/r2-vault-sync/log.json', base, false],
		['.obsidian/plugins/r2-vault-sync/main.js', base, true],
		['.obsidian/app.json', { ...base, includeConfigDir: false }, false],
		['Notes/a.md', { ...base, includeConfigDir: false }, true],
		['.obsidianx/a.md', { ...base, includeConfigDir: false }, true],
		['cfg/app.json', { ...base, configDir: 'cfg' }, true],
		['cfg/workspace.json', { ...base, configDir: 'cfg' }, false],
		['cfg/plugins/r2-vault-sync/data.json', { ...base, configDir: 'cfg' }, false],
		['.obsidian/workspace.json', { ...base, configDir: 'cfg' }, true],
		['Templates/t.md', { ...base, excludeGlobs: ['Templates/**'] }, false],
		['Notes/t.pdf', { ...base, excludeGlobs: ['*.pdf'] }, false],
		['.trash/x.md', { ...base, excludeGlobs: ['.trash/**'] }, false],
		['Notes/ünï.md', { ...base, excludeGlobs: ['Templates/**', '*.pdf'] }, true],
	])('isIncluded(%j) = %j', (path, opts, expected) => {
		expect(isIncluded(path, opts)).toBe(expected);
	});
});

describe('isTextPath', () => {
	it.each([
		['a.md', true], ['Notes/a.MD', true], ['x.canvas', true], ['x.base', true], ['cfg/app.json', true],
		['s.svg', true], ['d.csv', true], ['y.yml', true], ['y.yaml', true], ['p.html', true], ['p.xml', true],
		['a.css', true], ['a.js', true], ['a.ts', true], ['a.txt', true],
		['a.png', false], ['a.pdf', false], ['md', false], ['.md', false], ['dir.md/file', false], ['日本.md', true],
	])('isTextPath(%j) = %j', (path, expected) => {
		expect(isTextPath(path)).toBe(expected);
	});
});

describe('restoredCopyPath', () => {
	it.each([
		['Notes/a.md', 'Notes/a (restored 2026-10-16).md'],
		['a.md', 'a (restored 2026-10-16).md'],
		['Notes/README', 'Notes/README (restored 2026-10-16)'],
		['dir.v1/README', 'dir.v1/README (restored 2026-10-16)'],
		['Notes/a.tar.gz', 'Notes/a.tar (restored 2026-10-16).gz'],
		['.hidden', '.hidden (restored 2026-10-16)'],
		['日本/メモ.md', '日本/メモ (restored 2026-10-16).md'],
	])('restoredCopyPath(%j)', (path, expected) => {
		expect(restoredCopyPath(path, '2026-10-16')).toBe(expected);
	});
});

describe('isSafeVaultPath', () => {
	it.each([
		['Notes/a.md', true],
		['.obsidian/plugins/x/data.json', true],
		['Üñí/çødé.md', true],
		['', false],
		['/etc/passwd', false],
		['../x.md', false],
		['a/../b.md', false],
		['a/./b.md', false],
		['a//b.md', false],
		['a\\b.md', false],
		['C:/x.md', false],
		['a\0b', false],
	])('%j -> %s', (path, ok) => {
		expect(isSafeVaultPath(path)).toBe(ok);
	});
});

describe('isUnderConfigDir', () => {
	it.each([
		['.obsidian/plugins/x/main.js', '.obsidian', true],
		['.Obsidian/plugins/x/main.js', '.obsidian', true],
		['.OBSIDIAN', '.obsidian', true],
		['.obsidian-backup/x.md', '.obsidian', false],
		['Notes/.obsidian/x.md', '.obsidian', false],
		['cfg/app.json', 'cfg', true],
		['Cfg/app.json', 'cfg', true],
		['cfgx/app.json', 'cfg', false],
		['.obsidian/plugins/x/main.js', '.obsidian', true],
		['\u212Afg/app.json', 'kfg', true],
		['OBSIDI~1/plugins/x/main.js', '.obsidian', true],
		['.obsidian./plugins/x/main.js', '.obsidian', true],
		['.obsidian /plugins/x/main.js', '.obsidian', true],
		['.obsidian:stream/plugins/x/main.js', '.obsidian', true],
	])('%s under %s -> %s', (path, dir, expected) => {
		expect(isUnderConfigDir(path, dir)).toBe(expected);
	});
});
