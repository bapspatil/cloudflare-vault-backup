import { PLUGIN_STATE_FILES } from '../core/paths';
import { INDEX_FORMAT } from '../core/types';
import type { OpCounters, RunLogEntry } from '../core/types';
import { decodeLocalIndex, encodeLocalIndex } from '../core/manifest';
import type { LocalState, VaultPort } from './types';

const LOG_LIMIT = 100;
const dec = new TextDecoder();
const enc = new TextEncoder();

function parseJson(bytes: Uint8Array | null): unknown {
	if (!bytes) return undefined;
	try {
		return JSON.parse(dec.decode(bytes));
	} catch {
		return undefined;
	}
}

function isCounters(v: unknown): v is OpCounters {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.month === 'string' &&
		['classA', 'classB', 'bytesUploaded', 'bytesDownloaded'].every((k) => typeof o[k] === 'number' && Number.isFinite(o[k]))
	);
}

function isLogEntry(v: unknown): v is RunLogEntry {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o.startedAt === 'number' && typeof o.endedAt === 'number' && typeof o.result === 'object' && o.result !== null;
}

export function createLocalState(port: Pick<VaultPort, 'readPluginFile' | 'writePluginFile'>): LocalState {
	async function loadLog(): Promise<RunLogEntry[]> {
		const v = parseJson(await port.readPluginFile(PLUGIN_STATE_FILES.log));
		return Array.isArray(v) ? v.filter(isLogEntry) : [];
	}

	return {
		async loadIndex(backupSet) {
			const bytes = await port.readPluginFile(PLUGIN_STATE_FILES.index);
			if (bytes) {
				const d = decodeLocalIndex(bytes);
				if (d.ok && d.value.backupSet === backupSet) return d.value;
			}
			return { format: INDEX_FORMAT, backupSet, lastSnapshotId: null, lastGcAt: null, files: {}, pendingBlobs: {} };
		},

		saveIndex: (index) => port.writePluginFile(PLUGIN_STATE_FILES.index, encodeLocalIndex(index)),

		loadLog,

		async appendLog(entry) {
			const next = [entry, ...(await loadLog())].slice(0, LOG_LIMIT);
			await port.writePluginFile(PLUGIN_STATE_FILES.log, enc.encode(JSON.stringify(next)));
		},

		async loadCounters() {
			const v = parseJson(await port.readPluginFile(PLUGIN_STATE_FILES.counters));
			return isCounters(v) ? v : null;
		},

		saveCounters: (c) => port.writePluginFile(PLUGIN_STATE_FILES.counters, enc.encode(JSON.stringify(c))),
	};
}
