import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cwd, env } from 'node:process';
import { afterAll, describe, expect, it } from 'vitest';
import { createR2Client } from '../../src/io/r2-client';
import { fetchTransport } from '../helpers/transport-fetch';

function loadDotEnv(): void {
	const file = resolve(cwd(), '.env');
	if (!existsSync(file)) return;
	for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (!m || m[1] === undefined || env[m[1]] !== undefined) continue;
		env[m[1]] = (m[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
	}
}

loadDotEnv();
const ready = Boolean(env.R2_ACCOUNT_ID && env.R2_BUCKET && env.R2_KEY_ID && env.R2_SECRET);

describe.skipIf(!ready)('R2 client against a real bucket', () => {
	const client = createR2Client(
		{
			accountId: env.R2_ACCOUNT_ID ?? '',
			bucket: env.R2_BUCKET ?? '',
			accessKeyId: env.R2_KEY_ID ?? '',
			secretAccessKey: env.R2_SECRET ?? '',
		},
		fetchTransport,
	);
	const prefix = `it-${randomBytes(6).toString('hex')}/`;

	afterAll(async () => {
		const page = await client.listAll(prefix);
		if (page.objects.length > 0) await client.deleteMany(page.objects.map((o) => o.key));
	});

	it('round-trips a 1 MB binary object', async () => {
		const data = new Uint8Array(randomBytes(1024 * 1024));
		const put = await client.put(`${prefix}bin/blob with space é.bin`, data);
		expect(put.ok).toBe(true);
		const got = await client.get(`${prefix}bin/blob with space é.bin`);
		if (!got.ok) throw new Error('expected object');
		expect(got.body.byteLength).toBe(data.byteLength);
		expect(got.body).toEqual(data);
		if (put.ok) expect(got.etag).toBe(put.etag);
		expect(Math.abs(got.serverDate - Date.now())).toBeLessThan(5 * 60_000);
	});

	it('If-None-Match * returns 412 for an existing key', async () => {
		const key = `${prefix}cond/once.txt`;
		expect((await client.put(key, 'first', { condition: { ifNoneMatch: '*' } })).ok).toBe(true);
		expect(await client.put(key, 'second', { condition: { ifNoneMatch: '*' } })).toEqual({ ok: false, status: 412 });
	});

	it('If-Match rejects a wrong etag and accepts the right one', async () => {
		const key = `${prefix}cond/cas.txt`;
		const first = await client.put(key, 'v1', { contentType: 'text/plain' });
		if (!first.ok) throw new Error('expected put');
		expect(await client.put(key, 'v2', { condition: { ifMatch: '00000000000000000000000000000000' } })).toEqual({
			ok: false,
			status: 412,
		});
		const second = await client.put(key, 'v2', { condition: { ifMatch: first.etag } });
		expect(second.ok).toBe(true);
	});

	it('paginates with max-keys 2 over 3 keys', async () => {
		const p = `${prefix}page/`;
		for (const k of ['a', 'b', 'c']) await client.put(`${p}${k}`, k);
		const first = await client.list(p, { maxKeys: 2 });
		expect(first.objects).toHaveLength(2);
		expect(first.nextToken).not.toBeNull();
		const second = await client.list(p, { maxKeys: 2, token: first.nextToken ?? undefined });
		expect(second.objects.map((o) => o.key)).toEqual([`${p}c`]);
		expect(second.nextToken).toBeNull();
		const all = await client.listAll(p);
		expect(all.objects.map((o) => o.key)).toEqual([`${p}a`, `${p}b`, `${p}c`]);
		const grouped = await client.listAll(prefix, { delimiter: '/' });
		expect(grouped.commonPrefixes).toContain(p);
	});

	it('deleteMany removes keys', async () => {
		const p = `${prefix}del/`;
		const keys = [`${p}x`, `${p}y (1)`, `${p}z&w`];
		for (const k of keys) await client.put(k, 'x');
		const res = await client.deleteMany(keys);
		expect(res.failed).toEqual([]);
		expect(res.deleted.sort()).toEqual([...keys].sort());
		expect((await client.listAll(p)).objects).toHaveLength(0);
		await client.delete(`${p}never-existed`);
	});

	it('get of a missing key is 404', async () => {
		expect(await client.get(`${prefix}missing`)).toEqual({ ok: false, status: 404 });
		expect(await client.head(`${prefix}missing`)).toEqual({ ok: false, status: 404 });
	});

	it('head reports size and etag', async () => {
		const key = `${prefix}head.bin`;
		const put = await client.put(key, new Uint8Array(1234));
		const head = await client.head(key);
		if (!head.ok || !put.ok) throw new Error('expected object');
		expect(head.size).toBe(1234);
		expect(head.etag).toBe(put.etag);
	});

	it('counts operations', () => {
		const c = client.counters();
		expect(c.classA).toBeGreaterThan(0);
		expect(c.classB).toBeGreaterThan(0);
		expect(c.bytesUploaded).toBeGreaterThanOrEqual(1024 * 1024);
	});
});
