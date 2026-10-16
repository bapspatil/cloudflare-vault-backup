import { describe, expect, it } from 'vitest';
import { acquireLock, parseLockRecord } from '../../src/io/lock';
import type { R2Client } from '../../src/io/types';
import { createFakeR2 } from '../helpers/fake-r2';

// Models the client's retry after a lost response: the first conditional PUT lands, the retry sees 412.
function landsThenRetries(inner: R2Client, enabled: { on: boolean }): R2Client {
	return {
		...inner,
		put: async (key, body, opts) => {
			const first = await inner.put(key, body, opts);
			if (!enabled.on || !opts?.condition || !first.ok) return first;
			return inner.put(key, body, opts);
		},
	};
}

const KEY = 'backups/v1/lock.json';
const TTL = 600_000;
const utf8 = (s: string) => new TextEncoder().encode(s);

function setup() {
	const r2 = createFakeR2();
	const opts = (deviceId: string) => ({ deviceId, ttlMs: TTL, now: () => r2.serverNow() });
	const stored = () => parseLockRecord(r2.objects.get(KEY)!.body);
	return { r2, opts, stored };
}

describe('acquireLock', () => {
	it('writes a record expiring one TTL from now', async () => {
		const { r2, opts, stored } = setup();
		const handle = await acquireLock(r2, KEY, opts('a'));
		expect(handle!.record.expiresAt).toBe('2026-01-01T00:10:00.000Z');
		expect(handle!.record.runId).toMatch(/^[0-9a-f]{16}$/);
		expect(stored()).toEqual(handle!.record);
	});

	it('refuses a second acquire while the lock is held', async () => {
		const { r2, opts, stored } = setup();
		const first = await acquireLock(r2, KEY, opts('a'));
		expect(await acquireLock(r2, KEY, opts('b'))).toBe(null);
		expect(stored()!.runId).toBe(first!.record.runId);
	});

	it('takes over an expired lock using the server clock, and the old holder loses it', async () => {
		const { r2, stored } = setup();
		const first = await acquireLock(r2, KEY, { deviceId: 'a', ttlMs: TTL, now: () => r2.serverNow() });
		const skewedClock = () => Date.parse('2020-01-01T00:00:00.000Z');
		r2.setServerNow(Date.parse('2026-01-01T00:10:00.000Z'));
		const second = await acquireLock(r2, KEY, { deviceId: 'b', ttlMs: TTL, now: skewedClock });
		expect(second!.record.deviceId).toBe('b');
		expect(stored()!.deviceId).toBe('b');
		expect(await first!.refresh()).toBe(false);
		await first!.release();
		expect(stored()!.runId).toBe(second!.record.runId);
	});

	it('does not take over a lock that expires one millisecond after the server time', async () => {
		const { r2, opts } = setup();
		await acquireLock(r2, KEY, opts('a'));
		r2.setServerNow(Date.parse('2026-01-01T00:09:59.999Z'));
		expect(await acquireLock(r2, KEY, opts('b'))).toBe(null);
	});

	it('takes over a corrupt lock record', async () => {
		const { r2, opts, stored } = setup();
		await r2.put(KEY, 'garbage');
		const handle = await acquireLock(r2, KEY, opts('b'));
		expect(stored()!.runId).toBe(handle!.record.runId);
	});

	it('retries the create once when the lock disappears between the 412 and the GET', async () => {
		const { r2, opts, stored } = setup();
		await r2.put(KEY, '{}');
		const realGet = r2.get.bind(r2);
		r2.get = async (key) => {
			r2.objects.delete(key);
			return realGet(key);
		};
		const handle = await acquireLock(r2, KEY, opts('b'));
		expect(stored()!.deviceId).toBe('b');
		expect(handle!.record.deviceId).toBe('b');
	});

	it('gives up when another device wins the takeover race', async () => {
		const { r2, opts, stored } = setup();
		await acquireLock(r2, KEY, opts('a'));
		r2.setServerNow(Date.parse('2026-01-01T01:00:00.000Z'));
		const realGet = r2.get.bind(r2);
		r2.get = async (key) => {
			const res = await realGet(key);
			await r2.put(key, '{"deviceId":"c","runId":"cc","expiresAt":"2026-01-01T02:00:00.000Z"}');
			return res;
		};
		expect(await acquireLock(r2, KEY, opts('b'))).toBe(null);
		expect(stored()!.deviceId).toBe('c');
	});
});

describe('LockHandle', () => {
	it('refresh extends expiry and release expires the lock in place', async () => {
		const { r2, opts, stored } = setup();
		const handle = await acquireLock(r2, KEY, opts('a'));
		r2.setServerNow(Date.parse('2026-01-01T00:01:00.000Z'));
		expect(await handle!.refresh()).toBe(true);
		expect(stored()!.expiresAt).toBe('2026-01-01T00:11:00.000Z');
		expect(handle!.record.expiresAt).toBe('2026-01-01T00:11:00.000Z');
		await handle!.release();
		expect(stored()!.expiresAt).toBe('1970-01-01T00:00:00.000Z');
		expect((await acquireLock(r2, KEY, opts('b')))!.record.deviceId).toBe('b');
	});

	it('release after a takeover leaves the new holder untouched', async () => {
		const { r2, opts, stored } = setup();
		const first = await acquireLock(r2, KEY, opts('a'));
		r2.setServerNow(Date.parse('2026-01-01T00:10:00.000Z'));
		const second = await acquireLock(r2, KEY, opts('b'));
		await first!.release();
		expect(stored()!.runId).toBe(second!.record.runId);
		expect(stored()!.expiresAt).toBe(second!.record.expiresAt);
	});
});

describe('parseLockRecord', () => {
	it('holds the lock when a retried create sees its own write', async () => {
		const { r2, opts, stored } = setup();
		const retrying = { on: true };
		const handle = await acquireLock(landsThenRetries(r2, retrying), KEY, opts('a'));
		expect(handle).not.toBe(null);
		expect(stored()).toEqual(handle!.record);
		expect(await acquireLock(r2, KEY, opts('b'))).toBe(null);
	});

	it('holds the lock when a retried takeover sees its own write', async () => {
		const { r2, opts, stored } = setup();
		const first = await acquireLock(r2, KEY, opts('a'));
		await first!.release();
		const handle = await acquireLock(landsThenRetries(r2, { on: true }), KEY, opts('b'));
		expect(handle!.record.deviceId).toBe('b');
		expect(stored()).toEqual(handle!.record);
	});

	it('keeps the lock when a retried refresh sees its own write', async () => {
		const { r2, opts, stored } = setup();
		const retrying = { on: false };
		const handle = await acquireLock(landsThenRetries(r2, retrying), KEY, opts('a'));
		r2.setServerNow(Date.parse('2026-01-01T00:05:00.000Z'));
		retrying.on = true;
		expect(await handle!.refresh()).toBe(true);
		expect(stored()!.expiresAt).toBe('2026-01-01T00:15:00.000Z');
		retrying.on = false;
		expect(await handle!.refresh()).toBe(true);
		await handle!.release();
		expect(stored()!.expiresAt).toBe('1970-01-01T00:00:00.000Z');
	});

	it('accepts exactly the three string fields with a valid date', () => {
		expect(parseLockRecord(utf8('{"deviceId":"a","runId":"r","expiresAt":"2026-01-01T00:00:00.000Z"}'))).toEqual({
			deviceId: 'a',
			runId: 'r',
			expiresAt: '2026-01-01T00:00:00.000Z',
		});
	});

	it.each([
		'not json',
		'[]',
		'null',
		'{"deviceId":"a","runId":"r"}',
		'{"deviceId":"a","runId":"r","expiresAt":"tomorrow"}',
		'{"deviceId":"","runId":"r","expiresAt":"2026-01-01T00:00:00.000Z"}',
		'{"deviceId":"a","runId":1,"expiresAt":"2026-01-01T00:00:00.000Z"}',
		'{"deviceId":"a","runId":"r","expiresAt":"2026-01-01T00:00:00.000Z","x":1}',
	])('rejects %s', (raw) => {
		expect(parseLockRecord(utf8(raw))).toBe(null);
	});
});
