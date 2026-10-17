// Builds a Cloudflare dashboard URL that pre-fills the R2 read/write permission
// on the API token creation form. The user still completes creation in the
// dashboard and copies the resulting Access Key ID and Secret Access Key.
export function r2TokenTemplateUrl(tokenName = 'Cloudflare Vault Backup'): string {
	const permissions = encodeURIComponent(JSON.stringify([{ key: 'workers_r2', type: 'edit' }]));
	return `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${permissions}&name=${encodeURIComponent(tokenName)}`;
}
