import { requestUrl } from 'obsidian';
import type { Transport } from './types';

function toArrayBuffer(body: Uint8Array | string | undefined): ArrayBuffer | string | undefined {
	if (body === undefined || typeof body === 'string') return body;
	const copy = new ArrayBuffer(body.byteLength);
	new Uint8Array(copy).set(body);
	return copy;
}

export const obsidianTransport: Transport = async (req) => {
	let timer: number | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => reject(new Error('network: timeout')), req.timeoutMs);
	});
	try {
		const res = await Promise.race([
			requestUrl({
				url: req.url,
				method: req.method,
				headers: req.headers,
				body: toArrayBuffer(req.body),
				contentType: req.headers['content-type'],
				throw: false,
			}),
			timeout,
		]);
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = v;
		const body = req.method === 'HEAD' ? new Uint8Array(0) : new Uint8Array(res.arrayBuffer);
		return { status: res.status, headers, body };
	} finally {
		window.clearTimeout(timer);
	}
};
