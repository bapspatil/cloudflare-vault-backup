import { Platform, normalizePath, type App } from 'obsidian';
import type { VaultFileStat, VaultPort } from './types';

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	const out = new ArrayBuffer(data.byteLength);
	new Uint8Array(out).set(data);
	return out;
}

function parentOf(path: string): string {
	const i = path.lastIndexOf('/');
	return i < 0 ? '' : path.slice(0, i);
}

export function createObsidianVaultPort(app: App, pluginId: string): VaultPort {
	const { vault } = app;
	const adapter = vault.adapter;
	const configDir = vault.configDir;
	const pluginDir = `${configDir}/plugins/${pluginId}`;

	async function ensureFolder(dir: string): Promise<void> {
		const missing: string[] = [];
		let cur = normalizePath(dir);
		while (cur && cur !== '/' && !(await adapter.exists(cur))) {
			missing.push(cur);
			cur = parentOf(cur);
		}
		for (const d of missing.reverse()) await adapter.mkdir(d);
	}

	async function walkConfigDir(dir: string, out: VaultFileStat[]): Promise<void> {
		if (!(await adapter.exists(dir))) return;
		const listing = await adapter.list(dir);
		for (const file of listing.files) {
			if (file !== configDir && !file.startsWith(`${configDir}/`)) continue;
			const stat = await adapter.stat(file);
			if (stat?.type === 'file') out.push({ path: file, size: stat.size, mtime: stat.mtime });
		}
		for (const folder of listing.folders) {
			if (folder !== configDir && !folder.startsWith(`${configDir}/`)) continue;
			await walkConfigDir(folder, out);
		}
	}

	return {
		configDir,
		vaultName: vault.getName(),
		isMobile: Platform.isMobile,

		async scan(includeConfigDir) {
			const out: VaultFileStat[] = vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
			if (includeConfigDir) await walkConfigDir(configDir, out);
			return out;
		},

		async read(path) {
			const file = vault.getFileByPath(path);
			const buf = file ? await vault.readBinary(file) : await adapter.readBinary(normalizePath(path));
			return new Uint8Array(buf);
		},

		async write(path, data) {
			await ensureFolder(parentOf(path));
			const buf = toArrayBuffer(data);
			const file = vault.getFileByPath(path);
			if (file) await vault.modifyBinary(file, buf);
			else if (path.startsWith(`${configDir}/`)) await adapter.writeBinary(normalizePath(path), buf);
			else await vault.createBinary(normalizePath(path), buf);
		},

		exists: (path) => adapter.exists(normalizePath(path)),

		async readPluginFile(name) {
			const path = normalizePath(`${pluginDir}/${name}`);
			if (!(await adapter.exists(path))) return null;
			return new Uint8Array(await adapter.readBinary(path));
		},

		async writePluginFile(name, data) {
			await ensureFolder(pluginDir);
			await adapter.writeBinary(normalizePath(`${pluginDir}/${name}`), toArrayBuffer(data));
		},
	};
}
