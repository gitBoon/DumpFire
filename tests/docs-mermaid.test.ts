/**
 * The sequence diagrams in the documentation (card 2892, plan section 5).
 *
 * Mermaid, which Merview draws the diagrams with, ends a sequence-diagram
 * statement at a semicolon and skips from a bare `#` to the end of the line
 * as a comment. A message such as "INFO line; enrolmentLinkNotGiven" is drawn
 * as "INFO line", and "Move card #1686 to Complete" as "Move card".
 *
 * Write a comma or "and" in place of a semicolon, and "card 1686" in place of
 * "card #1686". Where a message quotes code or a log line exactly, write the
 * semicolon as the entity code `#59;`, which Mermaid draws as `;`.
 *
 * The scan covers every Markdown file under docs/ but docs/planning/, which
 * is git-ignored (a clone has none of it), and every ```mermaid block whose
 * first statement is `sequenceDiagram`. Flowcharts and state diagrams quote
 * their labels and read a semicolon differently: they are not scanned.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOCS = join(process.cwd(), 'docs');

interface DiagramLine {
	/** `docs/<file>:<line>`, the line's number in the file. */
	where: string;
	/** The line with its entity codes (`#59;`, `#quot;`) taken out. */
	text: string;
}

/** Every sequence diagram under docs/ but docs/planning/, as its lines. */
function sequenceDiagrams(): DiagramLine[][] {
	const files = (readdirSync(DOCS, { recursive: true }) as string[])
		.map((file) => file.split(sep).join('/'))
		.filter((file) => file.endsWith('.md') && !file.startsWith('planning/'))
		.sort();

	const diagrams: DiagramLine[][] = [];
	for (const file of files) {
		const lines = readFileSync(join(DOCS, file), 'utf8').replace(/\r\n/g, '\n').split('\n');
		let block: DiagramLine[] | null = null;
		let isSequence = false;
		let started = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (block === null) {
				if (/^\s*```mermaid\s*$/.test(line)) {
					block = [];
					isSequence = false;
					started = false;
				}
				continue;
			}
			if (/^\s*```\s*$/.test(line)) {
				if (isSequence) diagrams.push(block);
				block = null;
				continue;
			}
			const trimmed = line.trim();
			if (trimmed === '' || trimmed.startsWith('%%')) continue;
			if (!started) {
				started = true;
				isSequence = trimmed.startsWith('sequenceDiagram');
			}
			block.push({ where: `docs/${file}:${i + 1}`, text: line.replace(/#\w+;/g, '') });
		}
	}
	return diagrams;
}

describe('the sequence diagrams under docs/', () => {
	const diagrams = sequenceDiagrams();

	it('hold no semicolon outside an entity code', () => {
		// A scan that found no diagram would pass on anything.
		expect(diagrams.length).toBeGreaterThanOrEqual(80);
		const offenders = diagrams.flat().filter((line) => line.text.includes(';')).map((line) => line.where);
		expect(offenders, 'write a comma or "and" in place of the semicolon, or #59; where the text quotes code').toEqual([]);
	});

	it('hold no # that does not begin an entity code', () => {
		expect(diagrams.length).toBeGreaterThanOrEqual(80);
		const offenders = diagrams.flat().filter((line) => line.text.includes('#')).map((line) => line.where);
		expect(offenders, 'Mermaid reads a bare # as the start of a comment: write "card 1686", not "card #1686"').toEqual([]);
	});
});
