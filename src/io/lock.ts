import { randomHex } from '../core/crypto';
import type { LockRecord } from '../core/types';
import type { LockHandle, LockOptions, R2Client } from './types';

const LOCK_FIELDS = ['deviceId', 'runId', 'expiresAt'] as const;

export function parseLockRecord(bytes: Uint8Array): LockRecord | null {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const o = value as Record<string, unknown>;
	if (Object.keys(o).length !== LOCK_FIELDS.length) return null;
	const [deviceId, runId, expiresAt] = LOCK_FIELDS.map((k) => o[k]);
	if (typeof deviceId !== 'string' || deviceId === '') return null;
	if (typeof runId !== 'string' || runId === '') return null;
	if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) return null;
	return { deviceId, runId, expiresAt };
}

const encodeRecord = (r: LockRecord): string =>
	JSON.stringify({ deviceId: r.deviceId, runId: r.runId, expiresAt: r.expiresAt });

const JSON_TYPE = 'application/json';

export async function acquireLock(client: R2Client, key: string, opts: LockOptions): Promise<LockHandle | null> {
	const runId = randomHex(8);
	const recordAt = (): LockRecord => ({
		deviceId: opts.deviceId,
		runId,
		expiresAt: new Date(opts.now() + opts.ttlMs).toISOString(),
	});

	const claimed = await claim(client, key, recordAt);
	if (claimed === null) return null;
	return makeHandle(client, key, claimed.record, claimed.etag, recordAt);
}

async function claim(
	client: R2Client,
	key: string,
	recordAt: () => LockRecord,
): Promise<{ record: LockRecord; etag: string } | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const record = recordAt();
		const created = await client.put(key, encodeRecord(record), {
			contentType: JSON_TYPE,
			condition: { ifNoneMatch: '*' },
		});
		if (created.ok) return { record, etag: created.etag };

		const existing = await client.get(key);
		if (!existing.ok) continue;
		const held = parseLockRecord(existing.body);
		// The client retries after network errors, so a 412 can be our own create landing on an earlier attempt.
		if (held !== null && held.runId === record.runId) return { record: held, etag: existing.etag };
		// A corrupt record has no live holder that could refresh it, so it is treated as expired. Neither does
		// a live record from this device: runs never overlap within one vault, so it was left by a killed process.
		const live = held !== null && Date.parse(held.expiresAt) > existing.serverDate;
		if (live && held.deviceId !== record.deviceId) return null;

		const taken = recordAt();
		const takeover = await client.put(key, encodeRecord(taken), {
			contentType: JSON_TYPE,
			condition: { ifMatch: existing.etag },
		});
		if (takeover.ok) return { record: taken, etag: takeover.etag };
		const etag = await ownedEtag(client, key, taken);
		return etag === null ? null : { record: taken, etag };
	}
	return null;
}

async function ownedEtag(client: R2Client, key: string, mine: LockRecord): Promise<string | null> {
	const now = await client.get(key);
	if (!now.ok) return null;
	const held = parseLockRecord(now.body);
	return held !== null && encodeRecord(held) === encodeRecord(mine) ? now.etag : null;
}

function makeHandle(
	client: R2Client,
	key: string,
	initial: LockRecord,
	initialEtag: string,
	recordAt: () => LockRecord,
): LockHandle {
	let record = initial;
	let etag = initialEtag;
	let held = true;
	return {
		get record() {
			return record;
		},
		async refresh() {
			if (!held) return false;
			const next = recordAt();
			const res = await client.put(key, encodeRecord(next), { contentType: JSON_TYPE, condition: { ifMatch: etag } });
			const nextEtag = res.ok ? res.etag : await ownedEtag(client, key, next);
			if (nextEtag === null) {
				held = false;
				return false;
			}
			record = next;
			etag = nextEtag;
			return true;
		},
		async release() {
			if (!held) return;
			held = false;
			const expired = { ...record, expiresAt: new Date(0).toISOString() };
			await client.put(key, encodeRecord(expired), { contentType: JSON_TYPE, condition: { ifMatch: etag } });
		},
	};
}
