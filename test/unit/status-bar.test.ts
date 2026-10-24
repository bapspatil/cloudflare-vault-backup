import { describe, expect, it, vi } from 'vitest';
import { setIcon } from 'obsidian';
import { StatusBar } from '../../src/ui/status-bar';

vi.mock('obsidian', () => ({ setIcon: vi.fn() }));

describe('status bar warning', () => {
	it('keeps overdue backups visible across run states and clears after success', () => {
		const icon = {} as HTMLElement;
		const text = { setText: vi.fn() };
		const root = {
			addClass: vi.fn(), setAttribute: vi.fn(), addEventListener: vi.fn(), toggleClass: vi.fn(),
			createSpan: vi.fn().mockReturnValueOnce(icon).mockReturnValueOnce(text),
		};
		const bar = new StatusBar(root as unknown as HTMLElement, async () => {});
		bar.render({ kind: 'idle' }, true);
		expect(text.setText).toHaveBeenLastCalledWith(expect.stringContaining('Backup overdue'));
		expect(setIcon).toHaveBeenLastCalledWith(icon, 'alert-triangle');
		expect(root.toggleClass).toHaveBeenLastCalledWith('r2-vault-sync-status-failed', true);
		bar.render({ kind: 'scanning', seen: 0 }, true);
		expect(text.setText).toHaveBeenLastCalledWith(expect.stringContaining('Backup overdue'));
		expect(root.toggleClass).toHaveBeenCalledWith('r2-vault-sync-status-busy', true);
		bar.render({
			kind: 'done', snapshotId: null,
			stats: { scanned: 0, uploaded: 0, uploadedBytes: 0, reused: 0, skipped: 0, durationMs: 1 },
		});
		expect(text.setText).toHaveBeenLastCalledWith(expect.not.stringContaining('Backup overdue'));
		expect(setIcon).toHaveBeenLastCalledWith(icon, 'cloud-upload');
		expect(root.toggleClass).toHaveBeenLastCalledWith('r2-vault-sync-status-failed', false);
	});
});
