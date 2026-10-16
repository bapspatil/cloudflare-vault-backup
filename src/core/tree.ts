import type { FileEntry } from './types';

export interface TreeNode {
	name: string;
	path: string;
	kind: 'folder' | 'file';
	entry?: FileEntry;
	children: TreeNode[];
}

const byName = (a: TreeNode, b: TreeNode): number => {
	const x = a.name.toLowerCase();
	const y = b.name.toLowerCase();
	return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

function sortNode(node: TreeNode): void {
	const folders = node.children.filter((c) => c.kind === 'folder').sort(byName);
	const files = node.children.filter((c) => c.kind === 'file').sort(byName);
	node.children = [...folders, ...files];
	folders.forEach(sortNode);
}

export function buildTree(files: Record<string, FileEntry>): TreeNode {
	const root: TreeNode = { name: '', path: '', kind: 'folder', children: [] };
	const folders = new Map<string, TreeNode>([['', root]]);
	for (const [path, entry] of Object.entries(files)) {
		const parts = path.split('/');
		let parent = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const folderPath = parts.slice(0, i + 1).join('/');
			let folder = folders.get(folderPath);
			if (!folder) {
				folder = { name: parts[i] as string, path: folderPath, kind: 'folder', children: [] };
				folders.set(folderPath, folder);
				parent.children.push(folder);
			}
			parent = folder;
		}
		parent.children.push({ name: parts[parts.length - 1] as string, path, kind: 'file', entry, children: [] });
	}
	sortNode(root);
	return root;
}
