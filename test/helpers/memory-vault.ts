import type { VaultFileStat, VaultPort } from '../../src/io/types';

export interface MemoryVaultOptions {
	configDir?: string;
	vaultName?: string;
	isMobile?: boolean;
	files?: Record<string, Uint8Array | string>;
	mtimes?: Record<string, number>;
}

export type MemoryVault = VaultPort & {
	files: Map<string, Uint8Array>;
	mtimes: Map<string, number>;
	pluginFiles: Map<string, Uint8Array>;
	touch(path: string, mtime: number): void;
};

const enc = new TextEncoder();

export function createMemoryVault(opts: MemoryVaultOptions = {}): MemoryVault {
	const configDir = opts.configDir ?? '.obsidian';
	const files = new Map<string, Uint8Array>();
	const mtimes = new Map<string, number>();
	const pluginFiles = new Map<string, Uint8Array>();
	let clock = 1_000_000;

	for (const [path, data] of Object.entries(opts.files ?? {})) {
		files.set(path, typeof data === 'string' ? enc.encode(data) : new Uint8Array(data));
		mtimes.set(path, opts.mtimes?.[path] ?? ++clock);
	}

	const inConfig = (p: string): boolean => p === configDir || p.startsWith(`${configDir}/`);

	return {
		configDir,
		vaultName: opts.vaultName ?? 'Test Vault',
		isMobile: opts.isMobile ?? false,
		files,
		mtimes,
		pluginFiles,

		touch(path, mtime) {
			mtimes.set(path, mtime);
		},

		async scan(includeConfigDir) {
			const out: VaultFileStat[] = [];
			for (const [path, data] of files) {
				if (!includeConfigDir && inConfig(path)) continue;
				out.push({ path, size: data.byteLength, mtime: mtimes.get(path) ?? 0 });
			}
			return out;
		},

		async read(path) {
			const data = files.get(path);
			if (!data) throw new Error(`ENOENT: ${path}`);
			return new Uint8Array(data);
		},

		async write(path, data) {
			files.set(path, new Uint8Array(data));
			mtimes.set(path, ++clock);
		},

		async exists(path) {
			return files.has(path);
		},

		async readPluginFile(name) {
			const data = pluginFiles.get(name);
			return data ? new Uint8Array(data) : null;
		},

		async writePluginFile(name, data) {
			pluginFiles.set(name, new Uint8Array(data));
		},
	};
}
