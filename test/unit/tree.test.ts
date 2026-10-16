import { describe, expect, it } from 'vitest';
import { buildTree, type TreeNode } from '../../src/core/tree';
import type { FileEntry } from '../../src/core/types';

const e = (h: string): FileEntry => ({ h, s: 1, m: 1 });

const shape = (n: TreeNode): unknown =>
	n.kind === 'file' ? `${n.path}` : { [`${n.name}|${n.path}`]: n.children.map(shape) };

describe('buildTree', () => {
	it('empty input gives an empty root', () => {
		expect(buildTree({})).toEqual({ name: '', path: '', kind: 'folder', children: [] });
	});

	it('nests folders, sorts folders first then files, case-insensitively', () => {
		const tree = buildTree({
			'zeta.md': e('1'),
			'Alpha.md': e('2'),
			'beta/two.md': e('3'),
			'Beta/One.md': e('4'),
			'Notes/Deep/x.md': e('5'),
			'Notes/a.md': e('6'),
			'ünï/日本.md': e('7'),
			'a-folder/z.md': e('8'),
		});
		expect(shape(tree)).toEqual({
			'|': [
				{ 'a-folder|a-folder': ['a-folder/z.md'] },
				{ 'Beta|Beta': ['Beta/One.md'] },
				{ 'beta|beta': ['beta/two.md'] },
				{ 'Notes|Notes': [{ 'Deep|Notes/Deep': ['Notes/Deep/x.md'] }, 'Notes/a.md'] },
				{ 'ünï|ünï': ['ünï/日本.md'] },
				'Alpha.md',
				'zeta.md',
			],
		});
	});

	it('file nodes carry the entry and no children', () => {
		const tree = buildTree({ 'Notes/a.md': e('abc') });
		const file = tree.children[0]?.children[0];
		expect(file).toEqual({ name: 'a.md', path: 'Notes/a.md', kind: 'file', entry: e('abc'), children: [] });
	});
});
