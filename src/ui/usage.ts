import { estimateMonthly, formatBytes, formatUsd, R2_PRICES, uniqueBlobBytes } from '../core/cost';
import { ENVELOPE_OVERHEAD } from '../core/crypto';
import { createRemoteStore } from '../io/remote-store';
import type { Manifest } from '../core/types';
import type { ServiceFactory } from '../services';

export async function computeUsage(factory: ServiceFactory, configured: boolean): Promise<string> {
	const counters = await factory.local.loadCounters();
	const month = new Date().toISOString().slice(0, 7);
	const current = counters && counters.month === month ? counters : null;
	const lines: string[] = [];
	let storedBytes = 0;
	if (configured) {
		const s = await factory.services();
		const store = createRemoteStore(s.client, s.root, s.sealer);
		const ids = await store.listSnapshots();
		const manifests: Manifest[] = [];
		for (const id of ids) {
			const m = await store.readManifest(id);
			if (m) manifests.push(m);
		}
		storedBytes = uniqueBlobBytes(manifests, s.sealer.scheme === 'sha256' ? 0 : ENVELOPE_OVERHEAD);
		lines.push(`Snapshots: ${manifests.length}`, `Stored: ${formatBytes(storedBytes)}`);
	} else {
		lines.push('Snapshots: connect to R2 to see stored data');
	}
	const classA = current?.classA ?? 0;
	const classB = current?.classB ?? 0;
	lines.push(`Operations this month: ${classA} class A, ${classB} class B`);
	const now = new Date();
	const est = estimateMonthly({
		storedBytes,
		classA,
		classB,
		dayOfMonth: now.getUTCDate(),
		daysInMonth: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate(),
	});
	lines.push(`Estimated cost: ${formatUsd(est.usd)}/month${est.withinFreeTier ? ' (within free tier)' : ''}`);
	return lines.join('\n');
}

export const PRICE_NOTE = `Prices as of ${R2_PRICES.asOf}. The free tier is shared across your whole Cloudflare account.`;
