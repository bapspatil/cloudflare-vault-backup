// Drives the plugin inside a running Obsidian (launched with --remote-debugging-port=9222).
// Usage: bun run scripts/qa-cdp.mjs <vault-folder-name> <step...>
import { readFileSync } from 'node:fs';

const [vaultName, ...steps] = process.argv.slice(2);
const env = Object.fromEntries(
	readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => l.split('=', 2).map((s) => s.trim())),
);

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const target = targets.find((t) => t.type === 'page' && t.url.endsWith('/index.html') && t.title.includes(vaultName));
if (!target) throw new Error(`no window titled with ${vaultName}; titles: ${targets.map((t) => t.title).join(' | ')}`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
	const msg = JSON.parse(m.data);
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)(msg);
		pending.delete(msg.id);
	}
};
const send = (method, params) =>
	new Promise((resolve) => {
		const id = ++seq;
		pending.set(id, resolve);
		ws.send(JSON.stringify({ id, method, params }));
	});

async function run(expr) {
	const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
	if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? JSON.stringify(res.result.exceptionDetails));
	return res.result.result.value;
}

const plugin = `app.plugins.plugins['cloudflare-vault-backup']`;
const STEPS = {
	async enable() {
		return run(`(async () => { await app.plugins.setEnable(true); await app.plugins.enablePluginAndSave('cloudflare-vault-backup'); return Object.keys(app.plugins.plugins); })()`);
	},
	async configure() {
		return run(`(async () => {
			const p = ${plugin};
			app.secretStorage.setSecret(p.settings.connection.accessKeyIdSecretId, ${JSON.stringify(env.R2_KEY_ID)});
			app.secretStorage.setSecret(p.settings.connection.secretKeySecretId, ${JSON.stringify(env.R2_SECRET)});
			p.settings.connection.accountId = ${JSON.stringify(env.R2_ACCOUNT_ID)};
			p.settings.connection.bucket = ${JSON.stringify(env.R2_BUCKET)};
			p.settings.connection.prefix = 'qa';
			p.settings.schedule.intervalMinutes = 0;
			await p.saveSettings();
			return { vaultId: p.settings.vaultId, secrets: app.secretStorage.listSecrets() };
		})()`);
	},
	async test() {
		return run(`${plugin}.testConnection()`);
	},
	async backup() {
		return run(`(async () => { const r = await ${plugin}.backupNow('manual'); return r; })()`);
	},
	async edit() {
		return run(`(async () => { const f = app.vault.getFileByPath('Notes/alpha.md'); await app.vault.modify(f, '# Alpha\\n\\nEdited at ' + Date.now() + '\\n'); return f.stat; })()`);
	},
	async addConfig() {
		return run(`(async () => { await app.vault.adapter.write(app.vault.configDir + '/snippets/added.css', '.x{}'); return 'ok'; })()`);
	},
	async bigFile() {
		return run(`(async () => { const b = new ArrayBuffer(1024 * 1024 * 3); await app.vault.createBinary('attachments/big.bin', b); const p = ${plugin}; p.settings.scope.maxFileSizeMb = 1; await p.saveSettings(); return 'ok'; })()`);
	},
	async resetCap() {
		return run(`(async () => { const p = ${plugin}; p.settings.scope.maxFileSizeMb = 50; await p.saveSettings(); await app.vault.delete(app.vault.getFileByPath('attachments/big.bin')); return 'ok'; })()`);
	},
	async log() {
		return run(`${plugin}.services.local.loadLog()`);
	},
	async index() {
		return run(`${plugin}.services.local.loadIndex(${plugin}.settings.vaultId)`);
	},
	async openRestore() {
		return run(`(async () => { await ${plugin}.openRestoreView(); await new Promise(r => setTimeout(r, 2500)); const el = document.querySelector('.workspace-leaf-content[data-type="r2-vault-sync-restore"]'); return el ? el.innerText.slice(0, 1200) : 'no view'; })()`);
	},
	async restoreCopy() {
		return run(`(async () => {
			const v = app.workspace.getLeavesOfType('r2-vault-sync-restore')[0].view;
			const btn = [...v.contentEl.querySelectorAll('button')].find(b => b.textContent === 'Restore as copy');
			btn.click();
			await new Promise(r => setTimeout(r, 2500));
			return app.vault.getFiles().map(f => f.path).filter(p => p.includes('restored'));
		})()`);
	},
	async settings() {
		return run(`(async () => { app.setting.open(); app.setting.openTabById('cloudflare-vault-backup'); await new Promise(r => setTimeout(r, 2500)); const t = app.setting.activeTab.containerEl.innerText; app.setting.close(); return t.slice(0, 1500); })()`);
	},
	async mobile() {
		return run(`(async () => { app.emulateMobile(true); await new Promise(r => setTimeout(r, 1500)); const sb = document.querySelector('.r2-vault-sync-status'); const r = { mobile: app.isMobile, statusBarVisible: !!sb && sb.offsetParent !== null }; app.emulateMobile(false); return r; })()`);
	},
	async state() {
		return run(`${plugin}.state`);
	},
	async disable() {
		return run(`(async () => { await app.plugins.disablePluginAndSave('cloudflare-vault-backup'); return Object.keys(app.plugins.plugins); })()`);
	},
};

for (const step of steps) {
	const out = step.startsWith('eval:') ? await run(step.slice(5)) : await STEPS[step]?.();
	if (out === undefined && !step.startsWith('eval:')) throw new Error(`unknown step ${step}`);
	console.log(`== ${step}`);
	console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
}
ws.close();
