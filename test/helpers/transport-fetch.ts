import type { Transport } from '../../src/io/types';

export const fetchTransport: Transport = async (req) => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), req.timeoutMs);
	try {
		const res = await fetch(req.url, {
			method: req.method,
			headers: req.headers,
			body: req.body as BodyInit | undefined,
			signal: controller.signal,
		});
		const headers: Record<string, string> = {};
		res.headers.forEach((v, k) => {
			headers[k.toLowerCase()] = v;
		});
		const body = req.method === 'HEAD' ? new Uint8Array(0) : new Uint8Array(await res.arrayBuffer());
		return { status: res.status, headers, body };
	} catch (e) {
		if (controller.signal.aborted) throw new Error('network: timeout');
		throw e;
	} finally {
		clearTimeout(timer);
	}
};
