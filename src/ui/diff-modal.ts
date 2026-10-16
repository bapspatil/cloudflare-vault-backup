import { diffLines } from 'diff';
import { Modal, type App } from 'obsidian';

type Op = ' ' | '-' | '+';

interface DiffLine {
	op: Op;
	text: string;
	oldNo: number;
	newNo: number;
}

const CONTEXT = 3;

const OP_CLASS: Record<Op, string> = {
	' ': 'r2-vault-sync-diff-context',
	'-': 'r2-vault-sync-diff-removed',
	'+': 'r2-vault-sync-diff-added',
};

function splitLines(value: string): string[] {
	const lines = value.split('\n');
	if (lines[lines.length - 1] === '') lines.pop();
	return lines;
}

function toLines(oldText: string, newText: string): DiffLine[] {
	const out: DiffLine[] = [];
	let oldNo = 1;
	let newNo = 1;
	for (const change of diffLines(oldText, newText)) {
		const op: Op = change.added ? '+' : change.removed ? '-' : ' ';
		for (const text of splitLines(change.value)) {
			out.push({ op, text, oldNo, newNo });
			if (op !== '+') oldNo++;
			if (op !== '-') newNo++;
		}
	}
	return out;
}

function hunks(lines: DiffLine[]): DiffLine[][] {
	const ranges: Array<[number, number]> = [];
	lines.forEach((line, i) => {
		if (line.op === ' ') return;
		const start = Math.max(0, i - CONTEXT);
		const end = Math.min(lines.length - 1, i + CONTEXT);
		const last = ranges[ranges.length - 1];
		if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
		else ranges.push([start, end]);
	});
	return ranges.map(([s, e]) => lines.slice(s, e + 1));
}

function hunkHeader(hunk: DiffLine[]): string {
	const first = hunk[0] as DiffLine;
	const oldCount = hunk.filter((l) => l.op !== '+').length;
	const newCount = hunk.filter((l) => l.op !== '-').length;
	return `@@ -${first.oldNo},${oldCount} +${first.newNo},${newCount} @@`;
}

export class DiffModal extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly oldText: string,
		private readonly newText: string,
		private readonly note: string | null = null,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle(this.title);
		this.modalEl.addClass('r2-vault-sync-diff-modal');
		if (this.note) contentEl.createEl('p', { cls: 'r2-vault-sync-diff-note', text: this.note });
		contentEl.createEl('p', {
			cls: 'r2-vault-sync-diff-legend',
			text: 'Lines marked - are in the vault now; lines marked + come from the snapshot.',
		});
		const groups = hunks(toLines(this.oldText, this.newText));
		if (groups.length === 0) {
			contentEl.createEl('p', { text: 'No differences' });
			return;
		}
		const pre = contentEl.createEl('pre', { cls: 'r2-vault-sync-diff' });
		for (const hunk of groups) {
			pre.createSpan({ cls: 'r2-vault-sync-diff-line r2-vault-sync-diff-hunk', text: hunkHeader(hunk) });
			for (const line of hunk) {
				pre.createSpan({ cls: `r2-vault-sync-diff-line ${OP_CLASS[line.op]}`, text: `${line.op}${line.text}` });
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
