import type { ListPage, ListedObject } from './types';

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function unescapeXml(s: string): string {
	return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
		if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
		if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
		return NAMED[e] ?? m;
	});
}

export function escapeXml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function tag(block: string, name: string): string | null {
	const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
	return m ? unescapeXml(m[1] ?? '') : null;
}

function blocks(xml: string, name: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g');
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null) out.push(m[1] ?? '');
	return out;
}

export function parseListObjectsV2(xml: string): ListPage {
	const objects: ListedObject[] = blocks(xml, 'Contents').map((b) => {
		const modified = Date.parse(tag(b, 'LastModified') ?? '');
		return {
			key: tag(b, 'Key') ?? '',
			size: Number(tag(b, 'Size') ?? 0),
			lastModified: Number.isNaN(modified) ? 0 : modified,
			etag: (tag(b, 'ETag') ?? '').replace(/^(?:"|&quot;)+|(?:"|&quot;)+$/g, ''),
		};
	});
	const commonPrefixes = blocks(xml, 'CommonPrefixes')
		.map((b) => tag(b, 'Prefix'))
		.filter((p): p is string => p !== null);
	const truncated = tag(xml.replace(/<Contents>[\s\S]*?<\/Contents>/g, ''), 'IsTruncated') === 'true';
	const token = tag(xml, 'NextContinuationToken');
	return { objects, commonPrefixes, nextToken: truncated && token ? token : null };
}

export function buildDeleteObjectsBody(keys: string[]): string {
	const objs = keys.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join('');
	return `<Delete><Quiet>true</Quiet>${objs}</Delete>`;
}

export interface DeleteObjectsResult {
	deleted: string[];
	errors: { key: string; code: string; message: string }[];
}

export function parseDeleteObjectsResult(xml: string): DeleteObjectsResult {
	const deleted = blocks(xml, 'Deleted')
		.map((b) => tag(b, 'Key'))
		.filter((k): k is string => k !== null);
	const errors = blocks(xml, 'Error').map((b) => ({
		key: tag(b, 'Key') ?? '',
		code: tag(b, 'Code') ?? '',
		message: tag(b, 'Message') ?? '',
	}));
	return { deleted, errors };
}

export function parseErrorResponse(xml: string): { code: string; message: string } | null {
	const body = blocks(xml, 'Error')[0];
	if (body === undefined) return null;
	const code = tag(body, 'Code');
	if (code === null) return null;
	return { code, message: tag(body, 'Message') ?? '' };
}
