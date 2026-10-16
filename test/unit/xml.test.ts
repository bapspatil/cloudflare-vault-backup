import { describe, expect, it } from 'vitest';
import {
	buildDeleteObjectsBody,
	parseDeleteObjectsResult,
	parseErrorResponse,
	parseListObjectsV2,
} from '../../src/core/xml';

const LIST = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<Name>vault</Name><Prefix>blobs/</Prefix><KeyCount>3</KeyCount><MaxKeys>3</MaxKeys>
<IsTruncated>true</IsTruncated>
<NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken>
<Contents><Key>blobs/aa/aaa111</Key><LastModified>2026-10-01T12:00:00.000Z</LastModified><ETag>&quot;d41d8cd98f00b204e9800998ecf8427e&quot;</ETag><Size>1234</Size><StorageClass>STANDARD</StorageClass></Contents>
<Contents><Key>notes/Tom &amp; Jerry.md</Key><LastModified>2026-10-02T08:30:15.500Z</LastModified><ETag>"abc123"</ETag><Size>0</Size></Contents>
<Contents><Key>notes/日本語 &#233;&#x1F600;.md</Key><LastModified>2026-10-03T00:00:00.000Z</LastModified><ETag>"ffff"</ETag><Size>20971520</Size></Contents>
<CommonPrefixes><Prefix>snapshots/</Prefix></CommonPrefixes>
<CommonPrefixes><Prefix>a&amp;b/</Prefix></CommonPrefixes>
</ListBucketResult>`;

describe('parseListObjectsV2', () => {
	it('parses objects, prefixes and token', () => {
		const page = parseListObjectsV2(LIST);
		expect(page.objects).toEqual([
			{
				key: 'blobs/aa/aaa111',
				size: 1234,
				lastModified: Date.UTC(2026, 9, 1, 12, 0, 0),
				etag: 'd41d8cd98f00b204e9800998ecf8427e',
			},
			{
				key: 'notes/Tom & Jerry.md',
				size: 0,
				lastModified: Date.UTC(2026, 9, 2, 8, 30, 15, 500),
				etag: 'abc123',
			},
			{
				key: 'notes/日本語 é😀.md',
				size: 20971520,
				lastModified: Date.UTC(2026, 9, 3),
				etag: 'ffff',
			},
		]);
		expect(page.commonPrefixes).toEqual(['snapshots/', 'a&b/']);
		expect(page.nextToken).toBe('1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=');
	});

	it('returns null token when not truncated', () => {
		const xml = '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>';
		expect(parseListObjectsV2(xml)).toEqual({ objects: [], commonPrefixes: [], nextToken: null });
	});
});

describe('delete objects', () => {
	it('builds an escaped body', () => {
		expect(buildDeleteObjectsBody(['a/b', 'x&y<z>"\''])).toBe(
			'<Delete><Quiet>true</Quiet><Object><Key>a/b</Key></Object><Object><Key>x&amp;y&lt;z&gt;&quot;&apos;</Key></Object></Delete>',
		);
	});

	it('parses deleted and errors', () => {
		const xml = `<DeleteResult><Deleted><Key>a&amp;b</Key></Deleted><Error><Key>c</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error></DeleteResult>`;
		expect(parseDeleteObjectsResult(xml)).toEqual({
			deleted: ['a&b'],
			errors: [{ key: 'c', code: 'AccessDenied', message: 'Access Denied' }],
		});
	});

	it('parses an empty quiet result', () => {
		expect(parseDeleteObjectsResult('<DeleteResult></DeleteResult>')).toEqual({ deleted: [], errors: [] });
	});
});

describe('parseErrorResponse', () => {
	it('parses an S3 error', () => {
		const xml = '<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>';
		expect(parseErrorResponse(xml)).toEqual({ code: 'NoSuchKey', message: 'The specified key does not exist.' });
	});

	it('returns null for non-error bodies', () => {
		expect(parseErrorResponse('<ListBucketResult></ListBucketResult>')).toBeNull();
		expect(parseErrorResponse('')).toBeNull();
	});
});
