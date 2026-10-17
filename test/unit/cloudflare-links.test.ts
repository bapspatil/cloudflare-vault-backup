import { describe, expect, it } from 'vitest';
import { r2TokenTemplateUrl } from '../../src/utils/cloudflare-links';

describe('r2TokenTemplateUrl', () => {
	it('builds an account-token URL with the R2 permission pre-filled', () => {
		const url = r2TokenTemplateUrl();
		expect(url.startsWith('https://dash.cloudflare.com/?to=/:account/api-tokens&')).toBe(true);
		expect(url).toContain('permissionGroupKeys=');
		expect(url).toContain('name=Cloudflare%20Vault%20Backup');
		const params = new URL(url).searchParams;
		const decoded = decodeURIComponent(params.get('permissionGroupKeys') ?? '');
		expect(JSON.parse(decoded)).toEqual([{ key: 'workers_r2', type: 'edit' }]);
	});
	it('allows a custom token name', () => {
		expect(r2TokenTemplateUrl('My Vault')).toContain('name=My%20Vault');
	});
});