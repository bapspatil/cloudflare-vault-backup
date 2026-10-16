import { Plugin } from 'obsidian';
import { loadSettings, Settings } from './settings';

export default class R2VaultSyncPlugin extends Plugin {
	settings!: Settings;

	async onload() {
		this.settings = loadSettings(await this.loadData());
		await this.saveSettings();
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
