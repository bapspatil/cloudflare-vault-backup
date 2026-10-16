import { AwsV4Signer } from 'aws4fetch';
import { jitteredBackoffMs, sleep } from '../core/pool';
import type { ListPage, OpCounters } from '../core/types';
import { buildDeleteObjectsBody, parseDeleteObjectsResult, parseErrorResponse, parseListObjectsV2 } from '../core/xml';
import { R2Error } from './types';
import type {
	GetResult,
	HeadResult,
	PutCondition,
	PutResult,
	R2Client,
	R2Credentials,
	Transport,
	TransportRequest,
	TransportResponse,
} from './types';

export interface R2ClientOptions {
	now?: () => number;
	random?: () => number;
	maxAttempts?: number;
	timeoutMs?: number;
	initialCounters?: OpCounters | null;
}

interface Op {
	method: TransportRequest['method'];
	key?: string;
	query?: [string, string][];
	headers?: Record<string, string>;
	body?: Uint8Array | string;
	opClass: 'A' | 'B';
	okStatuses: number[];
	countDownload?: boolean;
}

const DELETE_BATCH = 1000;

function encodeSegment(s: string): string {
	return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function encodeKey(key: string): string {
	return key.split('/').map(encodeSegment).join('/');
}

function stripQuotes(etag: string | undefined): string {
	// R2 serves compressed JSON with a weak validator; If-Match needs the strong form.
	return (etag ?? '').replace(/^W\//, '').replace(/^"+|"+$/g, '');
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
	return out;
}

function byteLength(body: Uint8Array | string | undefined): number {
	if (body === undefined) return 0;
	return typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength;
}

function monthOf(ms: number): string {
	return new Date(ms).toISOString().slice(0, 7);
}

function amzDate(ms: number): string {
	return new Date(ms).toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function errorFrom(res: TransportResponse): R2Error {
	const parsed = res.body.byteLength > 0 ? parseErrorResponse(new TextDecoder().decode(res.body)) : null;
	const fallback = res.status === 401 || res.status === 403 ? 'auth' : `http-${res.status}`;
	return new R2Error(res.status, parsed?.code ?? fallback, parsed?.message || `R2 request failed with HTTP ${res.status}`);
}

function isRetryable(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 599);
}

export function createR2Client(creds: R2Credentials, transport: Transport, opts: R2ClientOptions = {}): R2Client {
	const now = opts.now ?? Date.now;
	const random = opts.random ?? Math.random;
	const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
	const timeoutMs = opts.timeoutMs ?? 30_000;
	if (!/^[0-9a-f]{32}$/i.test(creds.accountId)) {
		throw new R2Error(0, 'config', 'Account ID must be 32 hexadecimal characters');
	}
	const origin = `https://${creds.accountId}.r2.cloudflarestorage.com`;

	let counters: OpCounters =
		opts.initialCounters && opts.initialCounters.month === monthOf(now())
			? { ...opts.initialCounters }
			: { month: monthOf(now()), classA: 0, classB: 0, bytesUploaded: 0, bytesDownloaded: 0 };

	const current = (): OpCounters => {
		const month = monthOf(now());
		if (counters.month !== month) {
			counters = { month, classA: 0, classB: 0, bytesUploaded: 0, bytesDownloaded: 0 };
		}
		return counters;
	};

	const buildUrl = (op: Op): string => {
		const path = `/${encodeSegment(creds.bucket)}` + (op.key === undefined ? '' : `/${encodeKey(op.key)}`);
		const qs = (op.query ?? []).map(([k, v]) => (v === '' ? encodeSegment(k) : `${encodeSegment(k)}=${encodeSegment(v)}`));
		return origin + path + (qs.length > 0 ? `?${qs.join('&')}` : '');
	};

	const signedRequest = async (op: Op): Promise<TransportRequest> => {
		const signer = new AwsV4Signer({
			method: op.method,
			url: buildUrl(op),
			// Lock and manifest reads must see the latest write; Obsidian's request layer otherwise serves cached GETs.
			headers: { ...op.headers, 'cache-control': 'no-cache', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
			accessKeyId: creds.accessKeyId,
			secretAccessKey: creds.secretAccessKey,
			service: 's3',
			region: 'auto',
			allHeaders: true,
			datetime: amzDate(now()),
		});
		const signed = await signer.sign();
		const headers: Record<string, string> = {};
		signed.headers.forEach((v, k) => {
			headers[k.toLowerCase()] = v;
		});
		return { url: signed.url.toString(), method: op.method, headers, body: op.body, timeoutMs };
	};

	const send = async (op: Op): Promise<TransportResponse> => {
		for (let attempt = 0; ; attempt++) {
			const last = attempt >= maxAttempts - 1;
			const req = await signedRequest(op);
			const c = current();
			if (op.opClass === 'A') c.classA++;
			else c.classB++;
			c.bytesUploaded += byteLength(op.body);
			let res: TransportResponse;
			try {
				const raw = await transport(req);
				res = { status: raw.status, headers: lowerKeys(raw.headers), body: raw.body };
			} catch (e) {
				if (last) throw new R2Error(0, 'network', e instanceof Error ? e.message : String(e));
				await sleep(jitteredBackoffMs(attempt, 500, 8000, random));
				continue;
			}
			if (op.okStatuses.includes(res.status)) {
				if (op.countDownload) current().bytesDownloaded += res.body.byteLength;
				return res;
			}
			if (!isRetryable(res.status) || last) throw errorFrom(res);
			await sleep(jitteredBackoffMs(attempt, 500, 8000, random));
		}
	};

	const serverDate = (res: TransportResponse): number => {
		const parsed = Date.parse(res.headers['date'] ?? '');
		return Number.isNaN(parsed) ? now() : parsed;
	};

	const list = async (prefix: string, o: { delimiter?: string; maxKeys?: number; token?: string } = {}): Promise<ListPage> => {
		const query: [string, string][] = [['list-type', '2'], ['prefix', prefix]];
		if (o.delimiter !== undefined) query.push(['delimiter', o.delimiter]);
		if (o.maxKeys !== undefined) query.push(['max-keys', String(o.maxKeys)]);
		if (o.token !== undefined) query.push(['continuation-token', o.token]);
		const res = await send({ method: 'GET', query, opClass: 'A', okStatuses: [200] });
		return parseListObjectsV2(new TextDecoder().decode(res.body));
	};

	const deleteChunk = async (keys: string[]): Promise<{ deleted: string[]; failed: string[] }> => {
		const res = await send({
			method: 'POST',
			query: [['delete', '']],
			headers: { 'content-type': 'application/xml' },
			body: buildDeleteObjectsBody(keys),
			opClass: 'A',
			okStatuses: [200],
		});
		const result = parseDeleteObjectsResult(new TextDecoder().decode(res.body));
		const failed = new Set(result.errors.map((e) => e.key));
		return { deleted: keys.filter((k) => !failed.has(k)), failed: keys.filter((k) => failed.has(k)) };
	};

	return {
		async put(key, body, o: { contentType?: string; condition?: PutCondition } = {}): Promise<PutResult> {
			const headers: Record<string, string> = { 'content-type': o.contentType ?? 'application/octet-stream' };
			if (o.condition?.ifNoneMatch) headers['if-none-match'] = o.condition.ifNoneMatch;
			if (o.condition?.ifMatch) headers['if-match'] = `"${stripQuotes(o.condition.ifMatch)}"`;
			const res = await send({ method: 'PUT', key, headers, body, opClass: 'A', okStatuses: [200, 412] });
			if (res.status === 412) return { ok: false, status: 412 };
			return { ok: true, etag: stripQuotes(res.headers['etag']) };
		},

		async get(key): Promise<GetResult> {
			const res = await send({ method: 'GET', key, opClass: 'B', okStatuses: [200, 404], countDownload: true });
			if (res.status === 404) return { ok: false, status: 404 };
			return { ok: true, body: res.body, etag: stripQuotes(res.headers['etag']), serverDate: serverDate(res) };
		},

		async head(key): Promise<HeadResult> {
			const res = await send({ method: 'HEAD', key, opClass: 'B', okStatuses: [200, 404] });
			if (res.status === 404) return { ok: false, status: 404 };
			return {
				ok: true,
				size: Number(res.headers['content-length'] ?? 0),
				etag: stripQuotes(res.headers['etag']),
				serverDate: serverDate(res),
			};
		},

		async delete(key): Promise<void> {
			await send({ method: 'DELETE', key, opClass: 'A', okStatuses: [200, 204, 404] });
		},

		async deleteMany(keys) {
			const deleted: string[] = [];
			const failed: string[] = [];
			for (let i = 0; i < keys.length; i += DELETE_BATCH) {
				const r = await deleteChunk(keys.slice(i, i + DELETE_BATCH));
				deleted.push(...r.deleted);
				failed.push(...r.failed);
			}
			return { deleted, failed };
		},

		list,

		async listAll(prefix, o: { delimiter?: string } = {}): Promise<ListPage> {
			const merged: ListPage = { objects: [], commonPrefixes: [], nextToken: null };
			let token: string | undefined;
			do {
				const page = await list(prefix, { delimiter: o.delimiter, token });
				merged.objects.push(...page.objects);
				merged.commonPrefixes.push(...page.commonPrefixes);
				token = page.nextToken ?? undefined;
			} while (token !== undefined);
			return merged;
		},

		counters(): OpCounters {
			return { ...current() };
		},
	};
}
