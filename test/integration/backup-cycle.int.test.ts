import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cwd, env } from 'node:process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runBackup } from '../../src/backup/backup-runner';
import type { BackupContext } from '../../src/backup/context';
import { runPrune } from '../../src/backup/prune-runner';
import { sha256Hex } from '../../src/core/crypto';
import { backupRoot, blobKey, blobsPrefix, snapshotsPrefix } from '../../src/core/paths';
import type { RunState } from '../../src/core/types';
import { createLocalState } from '../../src/io/local-state';
import { createR2Client } from '../../src/io/r2-client';
import { createRemoteStore } from '../../src/io/remote-store';
import { plainSealer } from '../../src/io/sealer';
import { loadSettings } from '../../src/settings';
import { createMemoryVault } from '../helpers/memory-vault';
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
const enc = new TextEncoder();

describe.skipIf(!ready)('backup cycle against a real bucket', () => {
	const client = createR2Client(
		{
			accountId: env.R2_ACCOUNT_ID ?? '',
			bucket: env.R2_BUCKET ?? '',
			accessKeyId: env.R2_KEY_ID ?? '',
			secretAccessKey: env.R2_SECRET ?? '',
		},
		fetchTransport,
	);
	const prefix = `it-${randomBytes(6).toString('hex')}`;
	const settings = loadSettings({ vaultId: randomBytes(8).toString('hex'), connection: { prefix } });
	const root = backupRoot(prefix, settings.vaultId);
	const vault = createMemoryVault({ files: { 'a.md': 'alpha', 'b.md': 'bravo', 'notes/c.md': 'charlie' } });
	const sealer = plainSealer();
	let clockOffset = 0;
	const ctx: BackupContext = {
		vault,
		store: createRemoteStore(client, root, sealer),
		sealer,
		client,
		local: createLocalState(vault),
		settings,
		deviceId: 'it-device',
		pluginVersion: '0.1.0',
		now: () => Date.now() + clockOffset,
		random: Math.random,
		onState: () => undefined,
		log: () => undefined,
	};

	const keys = async (p: string) => (await client.listAll(p)).objects.map((o) => o.key).sort();
	const blobKeysFor = async (texts: string[]) =>
		(await Promise.all(texts.map(async (t) => blobKey(root, await sha256Hex(enc.encode(t)))))).sort();
	const doneId = (s: RunState): string => {
		if (s.kind !== 'done' || s.snapshotId === null) throw new Error(`expected a snapshot, got ${JSON.stringify(s)}`);
		return s.snapshotId;
	};

	beforeAll(() => {
		vi.stubGlobal('window', { setInterval, clearInterval });
	});

	afterAll(async () => {
		const page = await client.listAll(`${prefix}/`);
		if (page.objects.length > 0) await client.deleteMany(page.objects.map((o) => o.key));
	});

	it('backs up, dedupes an edit, then prunes to one snapshot', async () => {
		const first = doneId(await runBackup(ctx, 'manual'));
		vault.files.set('a.md', enc.encode('alpha v2'));
		vault.touch('a.md', 9_000_000);
		const second = doneId(await runBackup(ctx, 'manual'));
		expect(second > first).toBe(true);
		expect(await keys(snapshotsPrefix(root))).toEqual([
			`${snapshotsPrefix(root)}${first}.json`,
			`${snapshotsPrefix(root)}${second}.json`,
		]);
		expect(await keys(blobsPrefix(root))).toEqual(await blobKeysFor(['alpha', 'alpha v2', 'bravo', 'charlie']));

		Object.assign(settings.retention, { keepLast: 1, daily: 0, weekly: 0, monthly: 0, graceHours: 0 });
		clockOffset = 5 * 60_000;
		const pruned = await runPrune(ctx, () => undefined);
		expect(pruned).toEqual({ manifestsDeleted: 1, blobsDeleted: 1 });
		expect(await keys(snapshotsPrefix(root))).toEqual([`${snapshotsPrefix(root)}${second}.json`]);
		expect(await keys(blobsPrefix(root))).toEqual(await blobKeysFor(['alpha v2', 'bravo', 'charlie']));
	});
});
