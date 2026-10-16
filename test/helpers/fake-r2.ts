import type { ListedObject, ListPage, OpCounters } from '../../src/core/types';
import type { GetResult, HeadResult, PutResult, R2Client } from '../../src/io/types';

export interface FakeObject {
	body: Uint8Array;
	etag: string;
}

export type FakeR2 = R2Client & {
	objects: Map<string, FakeObject>;
	serverNow: () => number;
	setServerNow(ms: number): void;
};

export function createFakeR2(): FakeR2 {
	const objects = new Map<string, FakeObject>();
	let now = Date.parse('2026-01-01T00:00:00.000Z');
	let nextEtag = 1;

	const list = (prefix: string, opts: { delimiter?: string; maxKeys?: number; token?: string } = {}): ListPage => {
		const maxKeys = opts.maxKeys ?? 1000;
		const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
		const out: ListedObject[] = [];
		const prefixes: string[] = [];
		let nextToken: string | null = null;
		for (const key of keys) {
			if (opts.token !== undefined && (key <= opts.token || isRolledUp(key, opts.token, opts.delimiter))) continue;
			let entry: string = key;
			if (opts.delimiter) {
				const cut = key.indexOf(opts.delimiter, prefix.length);
				if (cut !== -1) entry = key.slice(0, cut + opts.delimiter.length);
			}
			if (entry !== key && prefixes.includes(entry)) continue;
			if (out.length + prefixes.length === maxKeys) {
				nextToken = lastEntry(out, prefixes);
				break;
			}
			if (entry === key) {
				const obj = objects.get(key) as FakeObject;
				out.push({ key, size: obj.body.byteLength, lastModified: now, etag: obj.etag });
			} else {
				prefixes.push(entry);
			}
		}
		return { objects: out, commonPrefixes: prefixes, nextToken };
	};

	const toBytes = (body: Uint8Array | string): Uint8Array =>
		typeof body === 'string' ? new TextEncoder().encode(body) : body.slice();

	return {
		objects,
		serverNow: () => now,
		setServerNow(ms) {
			now = ms;
		},

		put(key, body, opts): Promise<PutResult> {
			const existing = objects.get(key);
			const cond = opts?.condition;
			if (cond?.ifNoneMatch === '*' && existing) return Promise.resolve({ ok: false, status: 412 });
			if (cond?.ifMatch !== undefined && existing?.etag !== cond.ifMatch) {
				return Promise.resolve({ ok: false, status: 412 });
			}
			const etag = String(nextEtag++);
			objects.set(key, { body: toBytes(body), etag });
			return Promise.resolve({ ok: true, etag });
		},

		get(key): Promise<GetResult> {
			const obj = objects.get(key);
			if (!obj) return Promise.resolve({ ok: false, status: 404 });
			return Promise.resolve({ ok: true, body: obj.body.slice(), etag: obj.etag, serverDate: now });
		},

		head(key): Promise<HeadResult> {
			const obj = objects.get(key);
			if (!obj) return Promise.resolve({ ok: false, status: 404 });
			return Promise.resolve({ ok: true, size: obj.body.byteLength, etag: obj.etag, serverDate: now });
		},

		delete(key) {
			objects.delete(key);
			return Promise.resolve();
		},

		deleteMany(keys) {
			const deleted: string[] = [];
			for (const k of keys) {
				objects.delete(k);
				deleted.push(k);
			}
			return Promise.resolve({ deleted, failed: [] });
		},

		list(prefix, opts) {
			return Promise.resolve(list(prefix, opts));
		},

		listAll(prefix, opts) {
			const all: ListPage = { objects: [], commonPrefixes: [], nextToken: null };
			let token: string | undefined;
			do {
				const page = list(prefix, { delimiter: opts?.delimiter, token });
				all.objects.push(...page.objects);
				all.commonPrefixes.push(...page.commonPrefixes);
				token = page.nextToken ?? undefined;
			} while (token !== undefined);
			return Promise.resolve(all);
		},

		counters(): OpCounters {
			return { month: '2026-01', classA: 0, classB: 0, bytesUploaded: 0, bytesDownloaded: 0 };
		},
	};
}

function lastEntry(objects: ListedObject[], prefixes: string[]): string {
	const lastObj = objects[objects.length - 1]?.key ?? '';
	const lastPrefix = prefixes[prefixes.length - 1] ?? '';
	return lastObj > lastPrefix ? lastObj : lastPrefix;
}

function isRolledUp(key: string, token: string, delimiter: string | undefined): boolean {
	return delimiter !== undefined && token.endsWith(delimiter) && key.startsWith(token);
}
