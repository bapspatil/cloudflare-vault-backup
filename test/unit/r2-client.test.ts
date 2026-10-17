import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createR2Client, encodeKey } from '../../src/io/r2-client';
import { R2Error } from '../../src/io/types';
import type { R2Credentials, TransportRequest, TransportResponse } from '../../src/io/types';

const creds: R2Credentials = { accountId: '0123456789abcdef0123456789abcdef', bucket: 'bkt', accessKeyId: 'KEYID', secretAccessKey: 'secret' };
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const enc = new TextEncoder();

type Reply = Partial<TransportResponse> | Error;

function fake(replies: Reply[] | ((req: TransportRequest) => Reply)) {
	const requests: TransportRequest[] = [];
	const transport = (req: TransportRequest): Promise<TransportResponse> => {
		requests.push(req);
		const r = typeof replies === 'function' ? replies(req) : replies.shift();
		if (r === undefined) throw new Error('no reply queued');
		if (r instanceof Error) return Promise.reject(r);
		return Promise.resolve({ status: r.status ?? 200, headers: r.headers ?? {}, body: r.body ?? new Uint8Array(0) });
	};
	return { requests, transport };
}

function client(t: ReturnType<typeof fake>, now = () => NOW) {
	return createR2Client(creds, t.transport, { now, random: () => 0 });
}

function listXml(keys: string[], next: string | null): Uint8Array {
	const contents = keys
		.map((k) => `<Contents><Key>${k}</Key><Size>1</Size><LastModified>2026-10-16T00:00:00.000Z</LastModified><ETag>"e"</ETag></Contents>`)
		.join('');
	const tail = next ? `<IsTruncated>true</IsTruncated><NextContinuationToken>${next}</NextContinuationToken>` : '<IsTruncated>false</IsTruncated>';
	return enc.encode(`<ListBucketResult>${contents}${tail}</ListBucketResult>`);
}

beforeAll(() => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
});

describe('createR2Client', () => {
	it('signs requests with SigV4 for s3/auto and an unsigned payload', async () => {
		const t = fake([{ status: 200, headers: { ETag: '"abc"' } }]);
		const res = await client(t).put('a.txt', 'hi');
		expect(res).toEqual({ ok: true, etag: 'abc' });
		const req = t.requests[0]!;
		expect(req.method).toBe('PUT');
		expect(req.url).toBe('https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/bkt/a.txt');
		expect(req.headers['authorization']).toContain('AWS4-HMAC-SHA256');
		expect(req.headers['authorization']).toContain('Credential=KEYID/20261016/auto/s3/aws4_request');
		expect(req.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
		expect(req.headers['content-type']).toBe('application/octet-stream');
		expect(Object.keys(req.headers).every((k) => k === k.toLowerCase())).toBe(true);
	});

	it('marks every request uncacheable so reads see the latest write', async () => {
		const t = fake(() => ({ status: 200, body: listXml([], null) }));
		const c = client(t);
		await c.get('lock.json');
		await c.head('lock.json');
		await c.put('lock.json', '{}');
		await c.list('p/');
		expect(t.requests.map((r) => r.headers['cache-control'])).toEqual(['no-cache', 'no-cache', 'no-cache', 'no-cache']);
		expect(t.requests[0]!.headers['authorization']).toContain('cache-control');
	});

	it('percent-encodes each key segment and keeps slashes', async () => {
		const t = fake([{ status: 200 }]);
		await client(t).get('notes/my file (1)/café.md');
		expect(t.requests[0]!.url).toBe('https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/bkt/notes/my%20file%20%281%29/caf%C3%A9.md');
		expect(encodeKey('a/b c')).toBe('a/b%20c');
	});

	it('sends conditions and maps 412 to a result', async () => {
		const t = fake([{ status: 412 }, { status: 412 }]);
		const c = client(t);
		expect(await c.put('k', 'x', { condition: { ifNoneMatch: '*' } })).toEqual({ ok: false, status: 412 });
		expect(await c.put('k', 'x', { condition: { ifMatch: 'abc' } })).toEqual({ ok: false, status: 412 });
		expect(t.requests[0]!.headers['if-none-match']).toBe('*');
		expect(t.requests[1]!.headers['if-match']).toBe('"abc"');
		expect(t.requests).toHaveLength(2);
	});

	it('retries 429 exactly once before succeeding', async () => {
		const t = fake([{ status: 429 }, { status: 200, body: enc.encode('ok'), headers: { etag: '"e1"' } }]);
		const res = await client(t).get('k');
		expect(res).toMatchObject({ ok: true, etag: 'e1' });
		expect(t.requests).toHaveLength(2);
	});

	it('retries network errors and gives up after maxAttempts', async () => {
		const t = fake(() => new Error('boom'));
		const c = createR2Client(creds, t.transport, { now: () => NOW, random: () => 0, maxAttempts: 3 });
		await expect(c.get('k')).rejects.toMatchObject({ status: 0, code: 'network' });
		expect(t.requests).toHaveLength(3);
	});

	it('throws R2Error on 403 without retrying', async () => {
		const body = enc.encode('<Error><Code>AccessDenied</Code><Message>nope</Message></Error>');
		const t = fake([{ status: 403, body }, { status: 200 }]);
		const err = await client(t).get('k').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(R2Error);
		expect(err).toMatchObject({ status: 403, code: 'AccessDenied', message: 'nope' });
		expect(t.requests).toHaveLength(1);
	});

	it('falls back to auth and http-<status> codes without an XML body', async () => {
		const t = fake([{ status: 401 }, { status: 400 }]);
		const c = client(t);
		await expect(c.head('k')).rejects.toMatchObject({ status: 401, code: 'auth' });
		await expect(c.delete('k')).rejects.toMatchObject({ status: 400, code: 'http-400' });
	});

	it('maps get and head results', async () => {
		const t = fake([
			{ status: 404 },
			{ status: 200, body: enc.encode('abc'), headers: { Date: 'Fri, 16 Oct 2026 10:00:00 GMT', ETag: '"x"' } },
			{ status: 200, headers: { 'Content-Length': '42', etag: '"y"' } },
			{ status: 404 },
		]);
		const c = client(t);
		expect(await c.get('missing')).toEqual({ ok: false, status: 404 });
		const got = await c.get('k');
		expect(got).toEqual({ ok: true, body: enc.encode('abc'), etag: 'x', serverDate: Date.UTC(2026, 9, 16, 10) });
		expect(await c.head('k')).toEqual({ ok: true, size: 42, etag: 'y', serverDate: NOW });
		expect(await c.head('missing')).toEqual({ ok: false, status: 404 });
	});

	it('treats 200, 204 and 404 as successful deletes', async () => {
		const t = fake([{ status: 204 }, { status: 200 }, { status: 404 }]);
		const c = client(t);
		await c.delete('a');
		await c.delete('b');
		await c.delete('c');
		expect(t.requests.map((r) => r.method)).toEqual(['DELETE', 'DELETE', 'DELETE']);
	});

	it('counts class A and class B operations and bytes', async () => {
		const t = fake((req) => {
			if (req.url.includes('list-type')) return { body: listXml([], null) };
			if (req.method === 'GET') return { body: new Uint8Array(7) };
			return { status: 200 };
		});
		const c = client(t);
		await c.put('a', new Uint8Array(5));
		await c.delete('a');
		await c.list('');
		await c.get('a');
		await c.head('a');
		await c.head('b');
		expect(c.counters()).toEqual({ month: '2026-10', classA: 3, classB: 3, bytesUploaded: 5, bytesDownloaded: 7 });
	});

	it('seeds counters from the same month and resets on a new month', async () => {
		let now = NOW;
		const t = fake(() => ({ status: 200 }));
		const seed = { month: '2026-10', classA: 10, classB: 20, bytesUploaded: 1, bytesDownloaded: 2 };
		const c = createR2Client(creds, t.transport, { now: () => now, random: () => 0, initialCounters: seed });
		await c.head('a');
		expect(c.counters()).toMatchObject({ classA: 10, classB: 21 });
		now = Date.UTC(2026, 10, 1);
		expect(c.counters()).toEqual({ month: '2026-11', classA: 0, classB: 0, bytesUploaded: 0, bytesDownloaded: 0 });
		const stale = createR2Client(creds, t.transport, { now: () => NOW, initialCounters: { ...seed, month: '2026-09' } });
		expect(stale.counters().classA).toBe(0);
	});

	it('list sends ListObjectsV2 query parameters', async () => {
		const t = fake([{ body: listXml(['p/a'], 'tok') }]);
		const page = await client(t).list('p/', { delimiter: '/', maxKeys: 2, token: 'a b' });
		expect(page.nextToken).toBe('tok');
		expect(t.requests[0]!.url).toBe(
			'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/bkt?list-type=2&prefix=p%2F&delimiter=%2F&max-keys=2&continuation-token=a%20b',
		);
	});

	it('listAll follows continuation tokens and merges pages', async () => {
		const t = fake([{ body: listXml(['a', 'b'], 'next1') }, { body: listXml(['c'], null) }]);
		const page = await client(t).listAll('');
		expect(page.objects.map((o) => o.key)).toEqual(['a', 'b', 'c']);
		expect(page.nextToken).toBeNull();
		expect(t.requests).toHaveLength(2);
		expect(t.requests[1]!.url).toContain('continuation-token=next1');
	});

	it('deleteMany splits into batches of 1000 and reports failures', async () => {
		const t = fake((req) => {
			const body = String(req.body);
			const err = body.includes('<Key>k1200</Key>')
				? '<Error><Key>k1200</Key><Code>InternalError</Code><Message>x</Message></Error>'
				: '';
			return { body: enc.encode(`<DeleteResult>${err}</DeleteResult>`) };
		});
		const keys = Array.from({ length: 1500 }, (_, i) => `k${i}`);
		const res = await client(t).deleteMany(keys);
		expect(t.requests).toHaveLength(2);
		expect(t.requests.every((r) => r.method === 'POST' && r.url.endsWith('/bkt?delete'))).toBe(true);
		expect(res.failed).toEqual(['k1200']);
		expect(res.deleted).toHaveLength(1499);
	});
});

describe('credential validation', () => {
	it('refuses an account id that is not 32 hex characters', () => {
		expect(() => createR2Client({ ...creds, accountId: 'evil.example.com/' }, async () => ({ status: 200, headers: {}, body: new Uint8Array() }))).toThrow(
			/32 hexadecimal/,
		);
	});
});

describe('etag normalisation', () => {
	it('strips the weak validator prefix so If-Match round-trips', async () => {
		const requests: TransportRequest[] = [];
		const client = createR2Client(creds, async (req) => {
			requests.push(req);
			return { status: 200, headers: { ETag: 'W/"abc123"' }, body: new Uint8Array() };
		});
		const got = await client.get('k');
		expect(got).toMatchObject({ ok: true, etag: 'abc123' });
		await client.put('k', 'x', { condition: { ifMatch: got.ok ? got.etag : '' } });
		expect(requests[1]!.headers['if-match']).toBe('"abc123"');
	});
});
