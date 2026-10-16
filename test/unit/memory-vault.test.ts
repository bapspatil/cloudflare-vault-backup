import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../helpers/memory-vault';

describe('memory vault', () => {
	it('scan respects includeConfigDir and reports exact sizes and mtimes', async () => {
		const v = createMemoryVault({
			files: { 'a.md': 'hello', 'dir/b.bin': new Uint8Array([1, 2, 3]), '.obsidian/app.json': '{}' },
			mtimes: { 'a.md': 111, 'dir/b.bin': 222, '.obsidian/app.json': 333 },
		});
		const without = await v.scan(false);
		expect(without.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
			{ path: 'a.md', size: 5, mtime: 111 },
			{ path: 'dir/b.bin', size: 3, mtime: 222 },
		]);
		const withCfg = await v.scan(true);
		expect(withCfg.find((f) => f.path === '.obsidian/app.json')).toEqual({ path: '.obsidian/app.json', size: 2, mtime: 333 });
		expect(withCfg).toHaveLength(3);
	});

	it('write then read round-trips bytes and bumps mtime', async () => {
		const v = createMemoryVault({ files: { 'a.md': 'x' }, mtimes: { 'a.md': 5 } });
		await v.write('a.md', new Uint8Array([9, 8, 7]));
		expect(Array.from(await v.read('a.md'))).toEqual([9, 8, 7]);
		expect(v.mtimes.get('a.md')).toBeGreaterThan(5);
		await v.write('new/c.md', new Uint8Array([1]));
		expect(await v.exists('new/c.md')).toBe(true);
	});

	it('touch sets mtime and plugin files are separate', async () => {
		const v = createMemoryVault({ files: { 'a.md': 'x' } });
		v.touch('a.md', 42);
		expect((await v.scan(false))[0]?.mtime).toBe(42);
		expect(await v.readPluginFile('index.json')).toBeNull();
		await v.writePluginFile('index.json', new Uint8Array([1]));
		expect(Array.from((await v.readPluginFile('index.json')) as Uint8Array)).toEqual([1]);
		expect(await v.scan(true)).toHaveLength(1);
	});
});
