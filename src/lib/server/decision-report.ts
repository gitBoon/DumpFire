/**
 * decision-report.ts — a decision as a PDF (card 2688): the shareable copy
 * and the full private record, drawn from the projections of
 * decision-export.ts; the download's file name; the one place on the server
 * where a decision's PDF is drawn; and the caps and the ceiling that bound one.
 *
 * Drawn with the board reports' palette (`REPORT_COLORS`), as the plan PDF
 * is, since these documents land in the same packs. Every string drawn goes
 * through `pdfSafe` (R11), and the document ends with one note where any
 * character had to be drawn as "?". Every value drawn as a line, heading or
 * label of the document's own (a board's name, a person's, a group's, a quoted
 * block's label, the exporter's) is drawn on one line (`oneLine`, card 2688's
 * code review, S-L1); people's own words keep their line breaks in their
 * quoted blocks.
 *
 * People's words never pose as the document (R7): everything a person or an
 * agent wrote (content sections, options, audiences, stories, survey
 * questions, comments, answers, reasons, replies, questions, the record's
 * detail) is drawn in body text in an indented block with a rule beside it,
 * under a fixed label saying whose words they are, never in heading style
 * and never in a header or footer. No link annotation is made from any text.
 * The PDF's information dictionary is set here alone (S-L3): the title
 * `Decision #<id>: <title>`, " (private record)" after it on the full record,
 * author, creator and producer DumpFire, no subject and no keywords, and the
 * creation date the export's UTC day at midnight (S-L1).
 *
 * Every page carries its footer, drawn at the end over the buffered pages
 * with the bottom margin lifted, so that pdfkit adds no page: "Full record"
 * or "Shareable copy", the decision's number, who exported it and the day,
 * and "page n of N"; and on the full record the private band at the top
 * (R8). The rule beside each quoted block is drawn in the same pass, from the
 * pieces noted while the block was drawn, one per page it runs across.
 *
 * Bounds (R9, R10, E-H3, S-M3): each piece of a person's own text in the
 * results is printed up to `PDF_TEXT_MOST` characters, then `TEXT_CUT`; long
 * text is drawn in pieces of at most `PIECE` characters and `PIECE_LINES`
 * lines (card 2688's code review, E-L1), and before each the
 * drawing asks whether it has room: once it reaches `PDF_PAGE_CEILING` pages
 * (less a reserve for the lines that close it) or `PDF_BYTE_CEILING` bytes
 * (each finished page's content as it will be written, compressed, the page
 * being drawn as written so far before compression, and a reserve for each
 * page's footer and the piece being drawn), it stops, says so
 * (`PDF_CEILING_LINE`) and closes the document. One export is drawn at a time server-wide (`holdDrawing`).
 *
 * A large full record (F2, ruled at S1): the ruling's context (the decision,
 * the ruling and release, the version, the objections and requests to talk,
 * the concerns and the questions) is drawn before the responses, which are
 * listed by name up to `RESPONSES_MOST` and then counted in one line, the
 * totals and the group breakdown always whole; the record comes last. The
 * drawing gives the event loop back at least every 50 rows and every 20 ms
 * (`breathe`), and the last pass writes the pages out a few at a time, so no
 * stretch of it holds other requests for long.
 *
 * A plain module: no row, no caller, no write. The route draws the PDF
 * outside any transaction, between the `writeAs` that reads the projection
 * and the one that notes a full record on the decision's record.
 */
import { deflateSync } from 'node:zlib';
// pdfkit is pinned to the exact version installed (card 2688's code review, E-L4): this module reads two things of its
// own inside it (a page's content chunks, `contentOf`; its page buffer, `pageBufferOf`) and draws the ceiling from
// them. An upgrade must pass tests/decision-export.test.ts's E17 (every field drawn, footers on every page), E22 (the
// page ceiling), E24 (the band on every page) and E25 (the byte ceiling) before it is taken.
import PDFDocument from 'pdfkit';
import { REPORT_COLORS as C } from './reports';
import { oneLine, pdfSafe } from './pdf-text';
import { enterInFlight, leaveInFlight } from './rate-limit';
import type { ExportContent, FullExport, DecisionExport, ShareableExport, RoundTotals } from './decision-export';
import type { ReleasedResults, ResultRow, SurveyTally, ViewOption, ViewSurveyQuestion } from '$lib/decision-view-types';
import {
	AGENT_UNREVIEWED,
	ASKED_BY_AGENT,
	detailWords,
	EARLIER_ROUND_HELD,
	earlierDecisionWords,
	eventWords,
	FLAG_KIND_WORDS,
	flagUnrepliedWords,
	FULL_RECORD_CLOSING,
	laterDecisionWords,
	NO_OPTIONS_PUT,
	NOT_REACHED_WORDS,
	PDF_CEILING_LINE,
	PDF_REPLACED_NOTE,
	PRIVATE_BAND,
	RECORD_MORE,
	REMOVED_RESPONSE_HELD,
	responsesHeldWords,
	RESULTS_NOT_RELEASED,
	releasedFigure,
	rulingWords,
	SHAREABLE_CLOSING,
	STATUS_WORDS,
	surveyAnswerWords,
	TEXT_CUT,
	unansweredWords
} from '$lib/decision-words';

/** The most characters of one piece of a person's own text in the results the full record prints (R3.6). */
export const PDF_TEXT_MOST = 1000;

/** The most pages one decision PDF holds (R10). */
export const PDF_PAGE_CEILING = 1500;

/** The most bytes one decision PDF holds (R10): 20 MB. */
export const PDF_BYTE_CEILING = 20 * 1024 * 1024;

/** The one place a decision's PDF is drawn in, server-wide (R9a): `enterInFlight` at this key, one allowed. */
export const DRAWING_KEY = 'decision-pdf:server';

/** The exports one account may take in an hour, both copies counted together, in memory (R9b, D2: the route's). */
export const EXPORTS_AN_HOUR = 20;

/** The window of `EXPORTS_AN_HOUR`. */
export const EXPORT_WINDOW_MS = 60 * 60 * 1000;

/** The key of an account's hourly allowance of exports (`takeAllowance`, R9b). */
export const exportAllowanceKey = (userId: number) => `decision-export:${userId}`;

/**
 * How long the route waits for its body, `{ "copy": … }`, a few bytes (card 2688's code review, S-M1): read with
 * `readBodyWithin`, as an upload's is (card 2910), and answered 408 past it. Nothing is held while it is read.
 */
export const EXPORT_READ_DEADLINE_MS = 5_000;

/**
 * The most responses by name the full record lists (F2, ruled at S1): the current round's first, then a removed
 * participant's latest; past it, `responsesHeldWords` and `REMOVED_RESPONSE_HELD` say the results page holds them. The
 * totals and the group breakdown always count every response.
 */
export const RESPONSES_MOST = 500;

/** The drawing gives the event loop back at least once every this many rows (F2) … */
const BREATHE_ROWS = 50;
/** … and once this many milliseconds have passed since it last did, whichever comes first. */
const BREATHE_MS = 20;

/** Pages decorated (rules, band, footer) and written out between each giving back of the event loop, in the last pass (F2). */
const PAGES_A_TURN = 25;

/** Give the event loop back, so that other requests are answered while a large PDF is drawn (F2). */
const giveBack = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Long text is drawn in pieces of at most this many characters, the drawing asking for room before each (R10) … */
const PIECE = 2000;
/**
 * … and of at most this many lines (card 2688's code review, E-L1), so that text made mostly of line breaks cannot
 * draw a piece of many pages past the reserve: 60 lines and a piece's wrapped characters fit in fewer pages than
 * `PAGE_RESERVE`.
 */
const PIECE_LINES = 60;

/** Pages kept back from the ceiling for the piece being drawn, the ceiling line and the closing lines. */
const PAGE_RESERVE = 3;

/** Bytes counted for each page's footer, band and rules, drawn at the end, and for the piece being drawn. */
const PAGE_BYTES_RESERVE = 2048;
const PIECE_BYTES_RESERVE = 64 * 1024;

const MARGIN = 40;
const BODY = 9;
const QUOTE_INDENT = 14;

/**
 * Take the one place where a decision's PDF is drawn (R9a, A25): a closure
 * that gives it back, which the route calls in a `finally`, or null while
 * another export holds it, which the route answers 503 with `Retry-After`.
 * The route takes it only once the body is read and the caller may take the
 * copy asked for, and holds it around the projection and the drawing alone
 * (card 2688's code review, S-M1). A place a fault never gave back lapses with
 * card 2910's sweep.
 */
export function holdDrawing(): (() => void) | null {
	const token = enterInFlight(DRAWING_KEY, 1);
	if (token === null) return null;
	return () => leaveInFlight(DRAWING_KEY, token);
}

/**
 * The download's file name (R13): `decision-<id>-<slug>-full-record-<day>.pdf`
 * or `…-shareable-<day>.pdf`, the slug the title folded to ASCII, lower case,
 * each run of anything else one hyphen, at most 50 characters, `decision`
 * where nothing is left; the day the export's UTC day. Only `[a-z0-9.-]`, so
 * nothing in a `Content-Disposition` needs escaping.
 */
export function decisionPdfFilename(decisionId: number, title: string, copy: 'full' | 'shareable', exportDate: string): string {
	if (!Number.isSafeInteger(decisionId) || !/^\d{4}-\d{2}-\d{2}$/.test(exportDate)) {
		throw new Error(`decisionPdfFilename: a decision id and a YYYY-MM-DD day, not ${decisionId} and ${exportDate}`);
	}
	const ascii = pdfSafe(title).text.normalize('NFD').replace(/\p{M}/gu, '');
	const slug =
		ascii
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 50)
			.replace(/-+$/, '') || 'decision';
	return `decision-${decisionId}-${slug}-${copy === 'full' ? 'full-record' : 'shareable'}-${exportDate}.pdf`;
}

// ─── Words of the document's own ─────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/;

/** A stored day or moment as its UTC day, `24 Nov 2026` (R12). */
function dayOf(at: string): string {
	const found = STAMP.exec(at);
	return found === null ? at : `${Number(found[3])} ${MONTHS[Number(found[2]) - 1] ?? found[2]} ${found[1]}`;
}

/** A stored moment in UTC with "UTC" written, `24 Nov 2026, 10:46 UTC` (R12); `unset` where there is none. */
function momentOf(at: string | null, unset = 'not recorded'): string {
	if (at === null || at === '') return unset;
	const found = STAMP.exec(at);
	if (found === null) return at;
	return found[4] === undefined ? dayOf(at) : `${dayOf(at)}, ${found[4]}:${found[5]} UTC`;
}

const yesNo = (value: boolean) => (value ? 'yes' : 'no');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const viaWords = (via: string) => (via === 'link' ? 'by personal link' : via === 'session' ? 'signed in' : via === 'api' ? 'by an agent' : via);

/** A person's own text, at most `PDF_TEXT_MOST` characters, then `TEXT_CUT` (R3.6). */
function capped(text: string): string {
	const chars = Array.from(text);
	return chars.length <= PDF_TEXT_MOST ? text : `${chars.slice(0, PDF_TEXT_MOST).join('')}\n${TEXT_CUT}`;
}

/** Where `text` has its `n`th line break, or -1 where it has fewer. */
function nthBreak(text: string, n: number): number {
	let at = -1;
	for (let i = 0; i < n; i++) {
		at = text.indexOf('\n', at + 1);
		if (at === -1) return -1;
	}
	return at;
}

/**
 * Text in pieces of at most `PIECE` characters and `PIECE_LINES` lines: at the line break that ends the last line a
 * piece may hold, else at a line break or a space near the end of its characters.
 */
function piecesOf(text: string): string[] {
	const pieces: string[] = [];
	let rest = text;
	for (;;) {
		const lines = nthBreak(rest, PIECE_LINES);
		let cut: number;
		if (lines !== -1 && lines <= PIECE) {
			cut = lines;
		} else if (rest.length > PIECE) {
			cut = rest.lastIndexOf('\n', PIECE);
			if (cut < PIECE / 2) {
				const space = rest.lastIndexOf(' ', PIECE);
				cut = space >= PIECE / 2 ? space : PIECE;
			}
		} else {
			break;
		}
		pieces.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^[\n ]/, '');
	}
	if (rest !== '') pieces.push(rest);
	return pieces;
}

/** A page's content stream as pdfkit holds it until the document ends: its chunks, and their length before compression. */
function contentOf(page: PDFKit.PDFPage): { buffer: Uint8Array[]; uncompressedLength: number } {
	const content = (page as unknown as { content?: { buffer?: unknown; uncompressedLength?: unknown } }).content;
	if (!Array.isArray(content?.buffer) || typeof content.uncompressedLength !== 'number') {
		throw new Error('decision-report: pdfkit no longer holds a page content as chunks; the PDF ceiling cannot be kept');
	}
	return { buffer: content.buffer as Uint8Array[], uncompressedLength: content.uncompressedLength };
}

/** The bytes a finished page's content takes in the file: compressed, as pdfkit will write it. */
const finishedBytesOf = (page: PDFKit.PDFPage) => deflateSync(Buffer.concat(contentOf(page).buffer)).length;

// ─── The sheet: drawing with room asked for ──────────────────────────────────

type Rule = { page: number; from: number; to: number };

/** The most pages and bytes one PDF holds: `PDF_PAGE_CEILING` and `PDF_BYTE_CEILING`, whatever the route draws. */
type Ceilings = { pages: number; bytes: number };

/**
 * The document being drawn, with what the bounds and the last pass need: the
 * pages added, whether the ceiling stopped it, whether any character was drawn
 * as "?", and the pieces of rule beside each quoted block.
 */
class Sheet {
	readonly doc: PDFKit.PDFDocument;
	readonly width: number;
	pages = 1;
	stopped = false;
	replaced = false;
	readonly rules: Rule[] = [];
	private quoting: { page: number; from: number } | null = null;
	private bytesBefore = 0;
	private current: PDFKit.PDFPage;
	private readonly ceilings: Ceilings;
	private rowsSince = 0;
	private lastBreath = performance.now();

	constructor(doc: PDFKit.PDFDocument, ceilings: Ceilings) {
		this.doc = doc;
		this.ceilings = ceilings;
		this.width = doc.page.width - MARGIN * 2;
		this.current = doc.page;
		doc.on('pageAdded', () => {
			this.bytesBefore += finishedBytesOf(this.current);
			this.current = doc.page;
			this.pages++;
			if (this.quoting !== null) {
				this.rules.push({ ...this.quoting, to: doc.page.height - doc.page.margins.bottom });
				this.quoting = { page: this.pages - 1, from: doc.page.margins.top };
			}
		});
	}

	/** `text` as the standard fonts draw it, noting a "?" (R11). */
	safe(text: string): string {
		const shown = pdfSafe(text);
		if (shown.replaced) this.replaced = true;
		return shown.text;
	}

	/** `text` as `safe` draws it, on one line (S-L1): for a line, heading or label of the document's own. */
	safeLine(text: string): string {
		return oneLine(this.safe(text));
	}

	private bytes(): number {
		return this.bytesBefore + contentOf(this.current).uncompressedLength;
	}

	/**
	 * After each row or block (F2): the event loop given back once `BREATHE_ROWS` rows have been drawn since it last
	 * was, or `BREATHE_MS` have passed, so that no stretch of drawing holds other requests for long.
	 */
	async breathe(): Promise<void> {
		this.rowsSince++;
		if (this.rowsSince < BREATHE_ROWS && performance.now() - this.lastBreath < BREATHE_MS) return;
		await giveBack();
		this.rowsSince = 0;
		this.lastBreath = performance.now();
	}

	/** Whether there is room for one more piece (R10); at the first answer no, the ceiling line is drawn and nothing else is. */
	room(): boolean {
		if (this.stopped) return false;
		const full =
			this.pages >= this.ceilings.pages - PAGE_RESERVE ||
			this.bytes() + this.pages * PAGE_BYTES_RESERVE + PIECE_BYTES_RESERVE >= this.ceilings.bytes;
		if (!full) return true;
		this.stopped = true;
		this.endQuote();
		this.doc.y += 8;
		this.doc.font('Helvetica-Bold').fontSize(BODY).fillColor(C.red).text(PDF_CEILING_LINE, MARGIN, this.doc.y, { width: this.width });
		return false;
	}

	/** A new page unless `needed` points fit above the bottom margin. */
	keep(needed: number): void {
		const page = this.doc.page;
		if (this.doc.y + needed > page.height - page.margins.bottom) this.doc.addPage();
	}

	/** A section title of the document's own. */
	heading(text: string): void {
		if (!this.room()) return;
		this.keep(60);
		this.doc.y += 8;
		this.doc.font('Helvetica-Bold').fontSize(12).fillColor(C.heading).text(this.safeLine(text), MARGIN, this.doc.y, { width: this.width });
		const y = this.doc.y + 2;
		this.doc.rect(MARGIN, y, 40, 2).fill(C.accent);
		this.doc.y = y + 8;
	}

	/** A sub-title of the document's own. */
	subheading(text: string): void {
		if (!this.room()) return;
		this.keep(40);
		this.doc.y += 4;
		this.doc.font('Helvetica-Bold').fontSize(10).fillColor(C.heading).text(this.safeLine(text), MARGIN, this.doc.y, { width: this.width });
		this.doc.y += 2;
	}

	/** One line or paragraph of the document's own words (names and figures among them). */
	line(text: string, style: { bold?: boolean; muted?: boolean; italic?: boolean } = {}): void {
		if (!this.room()) return;
		const font = style.bold ? 'Helvetica-Bold' : style.italic ? 'Helvetica-Oblique' : 'Helvetica';
		this.doc.font(font).fontSize(BODY).fillColor(style.muted ? C.textMuted : C.text).text(this.safeLine(text), MARGIN, this.doc.y, { width: this.width });
	}

	/**
	 * Words a person or an agent wrote (R7): under `label`, which says whose
	 * they are, in an indented block with a rule beside it. `lines` are drawn
	 * one after another, each in pieces, asking for room before each.
	 */
	quote(label: string, lines: string | string[]): void {
		const shown = (Array.isArray(lines) ? lines : [lines]).filter((text) => text !== '');
		if (shown.length === 0 || !this.room()) return;
		this.keep(34);
		this.doc.y += 2;
		this.doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.textMuted).text(this.safeLine(label), MARGIN, this.doc.y, { width: this.width });
		this.quoting = { page: this.pages - 1, from: this.doc.y };
		for (const text of shown) {
			for (const piece of piecesOf(this.safe(text))) {
				if (!this.room()) return;
				this.doc.font('Helvetica').fontSize(BODY).fillColor(C.text).text(piece, MARGIN + QUOTE_INDENT, this.doc.y, { width: this.width - QUOTE_INDENT });
			}
		}
		this.endQuote();
		this.doc.y += 3;
	}

	private endQuote(): void {
		if (this.quoting === null) return;
		this.rules.push({ ...this.quoting, to: this.doc.y });
		this.quoting = null;
	}

	gap(points = 4): void {
		if (!this.stopped) this.doc.y += points;
	}
}

// ─── What both copies draw ───────────────────────────────────────────────────

/** The label of a section of the version, with the agent's mark where an agent drafted it and no person reviewed it (R3.4). */
const sectionLabel = (name: string, content: ExportContent, key: string) =>
	Object.hasOwn(content.agentDrafted, key) ? `${name} (${AGENT_UNREVIEWED.toLowerCase()})` : name;

/** The version in full (R3.4, R4): its text sections, options, audiences, stories and survey questions, each a quoted block. */
async function drawVersion(
	sheet: Sheet,
	version: { number: number; publishedAt: string; content: ExportContent },
	options: ViewOption[],
	audiences: { heading: string; body: string }[],
	surveyQuestions: ViewSurveyQuestion[],
	published: string
): Promise<void> {
	const content = version.content;
	sheet.heading(`The decision as published in version ${version.number}`);
	sheet.line(`Published ${published}.`, { muted: true });
	sheet.gap();
	for (const [name, key] of [
		['The situation', 'situation'],
		['The question', 'question'],
		['What is asked', 'ask']
	] as const) {
		sheet.quote(sectionLabel(name, content, key), content[key]);
		await sheet.breathe();
	}
	for (const option of options) {
		const agent = option.agentDrafted ? ` (${AGENT_UNREVIEWED.toLowerCase()})` : '';
		sheet.quote(`Option ${option.label}${agent}`, [
			option.title,
			option.summary,
			...option.pros.map((pro) => `Pro: ${pro}`),
			...option.cons.map((con) => `Con: ${con}`),
			option.commercial === '' ? '' : `Commercial: ${option.commercial}`
		]);
		await sheet.breathe();
	}
	for (const [i, audience] of audiences.entries()) {
		sheet.quote(sectionLabel(`Who it affects, ${i + 1} of ${audiences.length}`, content, 'audiences'), [audience.heading, audience.body]);
		await sheet.breathe();
	}
	for (const [i, story] of content.stories.entries()) {
		sheet.quote(sectionLabel(`Story ${i + 1}`, content, 'stories'), [story.title, story.body]);
		await sheet.breathe();
	}
	for (const [name, key] of [
		['What is not known', 'unknowns'],
		['Already settled', 'alreadyRuled'],
		['Technical detail', 'technicalDetail']
	] as const) {
		sheet.quote(sectionLabel(name, content, key), content[key]);
		await sheet.breathe();
	}
	for (const [i, question] of surveyQuestions.entries()) {
		const agent = question.agentDrafted ? ` (${AGENT_UNREVIEWED.toLowerCase()})` : '';
		const answers =
			question.kind === 'choice'
				? `Choices: ${(question.choices ?? []).join(' / ')}`
				: question.kind === 'scale' && question.scale !== undefined
					? `A scale from 1 (${question.scale.lowLabel}) to ${question.scale.max} (${question.scale.highLabel})`
					: 'A written answer';
		sheet.quote(`Survey question ${i + 1}${question.required ? ', required' : ''}${agent}`, [question.prompt, question.help, answers]);
		await sheet.breathe();
	}
}

/** A ruling's option in words: the option, "None of these", or that no options were put to a vote (binding note 6519). */
const rulingOptionWords = (ruling: { optionId?: number | null; label: string | null; title: string | null; noOptions?: true }) =>
	ruling.noOptions ? NO_OPTIONS_PUT : ruling.label === null ? 'None of these' : `Option ${ruling.label}${ruling.title ? `: ${ruling.title}` : ''}`;

/** The released totals and comments, without names (decision 10), as every viewer is given them. */
async function drawReleased(sheet: Sheet, released: ReleasedResults): Promise<void> {
	const figures = [
		`Responded: ${releasedFigure(released.responded)}`,
		...(released.voteMode === 'score' ? [`Voted: ${releasedFigure(released.voted)}`] : []),
		`Abstained: ${releasedFigure(released.abstained)}`,
		`No concerns: ${releasedFigure(released.noConcerns)}`
	];
	sheet.line(figures.join('  ·  '));
	for (const option of released.options) {
		const figure = released.voteMode === 'score' ? `mean ${releasedFigure(option.mean)}` : `${releasedFigure(option.votes)} votes`;
		sheet.line(`Option ${option.label}: ${figure}`);
	}
	for (const option of released.options) {
		for (const comment of option.comments) {
			sheet.quote(`A comment on option ${option.label}, released without a name`, comment);
			await sheet.breathe();
		}
	}
	for (const comment of released.comments) {
		sheet.quote('A comment, released without a name', comment);
		await sheet.breathe();
	}
}

// ─── The shareable copy (R4) ─────────────────────────────────────────────────

async function drawShareable(sheet: Sheet, exported: ShareableExport): Promise<void> {
	const d = exported.decision;
	sheet.doc.font('Helvetica-Bold').fontSize(16).fillColor(C.heading).text(`Decision #${d.id}`, MARGIN, sheet.doc.y, { width: sheet.width });
	sheet.line('Shareable copy', { muted: true });
	sheet.gap(6);
	sheet.quote('Title', d.title);
	sheet.line(`Board: ${d.boardName}`);
	sheet.line(`Status: ${STATUS_WORDS[d.shownStatus] ?? d.shownStatus}`);
	sheet.line(`Vote: ${d.voteMode === 'score' ? 'each option scored' : 'one option chosen'}`);
	sheet.line(`Decider: ${d.deciderName ?? 'none named'}`);
	if (d.withdrawnAt !== null) {
		// A day, as every other moment in the shareable copy (card 2688's code review, S-L3).
		sheet.line(`Withdrawn on ${dayOf(d.withdrawnAt)}.`);
		if (d.withdrawnReason) sheet.quote('The reason given for the withdrawal', d.withdrawnReason);
	}
	if (exported.supersedes !== null) sheet.line(earlierDecisionWords(exported.supersedes));
	if (exported.laterDecision !== null) sheet.line(laterDecisionWords(exported.laterDecision));

	if (exported.version !== null) {
		await drawVersion(sheet, exported.version, exported.options, exported.audiences, exported.surveyQuestions, dayOf(exported.version.publishedAt));
	}

	sheet.heading('The ruling');
	if (exported.ruling === null) {
		sheet.line('Not ruled yet.');
	} else {
		sheet.line(rulingWords(exported.ruling));
		sheet.quote(`The reason given by ${exported.ruling.ruledByName}`, exported.ruling.reason);
		if (exported.ruling.conditions) sheet.quote(`The conditions set by ${exported.ruling.ruledByName}`, exported.ruling.conditions);
	}

	sheet.heading('Results');
	if (exported.released === null) sheet.line(RESULTS_NOT_RELEASED);
	else await drawReleased(sheet, exported.released);
}

// ─── The full record (R3) ────────────────────────────────────────────────────

/** A round's figures (R3.6, R3.7): totals, each option's votes or scores, and the survey figures by the version asked. */
function drawTotals(sheet: Sheet, tally: RoundTotals, options: { optionId: number; label: string }[], voteMode: 'single' | 'score'): void {
	const labelOf = (optionId: number) => options.find((option) => option.optionId === optionId)?.label ?? 'no longer offered';
	sheet.line(
		[`Responded: ${tally.responded}`, `Voted: ${tally.voted}`, `Abstained: ${tally.abstained}`, `No concerns: ${tally.noConcerns}`].join('  ·  ')
	);
	if (voteMode === 'single') for (const vote of tally.votes) sheet.line(`Option ${labelOf(vote.optionId)}: ${plural(vote.count, 'vote', 'votes')}`);
	else for (const score of tally.scores) sheet.line(`Option ${labelOf(score.optionId)}: total ${score.total}, mean ${score.mean ?? 'none'}`);
	drawSurveyFigures(sheet, tally.survey);
}

function drawSurveyFigures(sheet: Sheet, survey: SurveyTally[]): void {
	for (const asked of survey) {
		asked.questions.forEach((question, i) => {
			const figures =
				question.choices !== null
					? question.choices.map((choice) => `${choice.choice}: ${choice.count}`)
					: question.scale !== null
						? [`${question.scale.counts.map((value) => `${value.value}: ${value.count}`).join(', ')}; mean ${question.scale.mean ?? 'none'}`]
						: ['Written answers are given with each response.'];
			sheet.quote(`Survey question ${i + 1} as version ${asked.versionNumber} asked it: ${question.answered} answered`, [question.prompt, ...figures]);
		});
	}
}

/** One response by name (R3.6): what they chose, when and how, and their own words, each cut at `PDF_TEXT_MOST`. */
function drawResponse(sheet: Sheet, exported: FullExport, row: ResultRow): void {
	const options = exported.results.options;
	const labelOf = (optionId: number) => options.find((option) => option.optionId === optionId)?.label ?? 'no longer offered';
	sheet.keep(40);
	sheet.line(`${row.name}${row.groups.length > 0 ? ` (${row.groups.join(', ')})` : ''}`, { bold: true });
	const chose =
		row.kind === 'abstain'
			? 'Abstained.'
			: row.kind === 'no_concerns'
				? 'No concerns.'
				: row.kind === 'answered'
					? 'Answered the survey questions.'
					: row.scores !== null
						? `Scores: ${Object.entries(row.scores)
								.map(([optionId, score]) => `option ${labelOf(Number(optionId))} ${score}`)
								.join(', ')}.`
						: row.optionId !== null
							? `Chose option ${labelOf(row.optionId)}.`
							: 'Gave no choice.';
	sheet.line(chose);
	sheet.line(
		`Given ${momentOf(row.createdAt)}, ${viaWords(row.via)}, on version ${row.versionNumber}${row.changes > 0 ? `; changed ${plural(row.changes, 'time', 'times')} before` : ''}.`,
		{ muted: true }
	);
	if (row.comment) sheet.quote(`Comment by ${row.name}`, capped(row.comment));
	for (const [optionId, text] of Object.entries(row.optionComments)) {
		if (text !== '') sheet.quote(`${row.name} on option ${labelOf(Number(optionId))}`, capped(text));
	}
	const questions = exported.results.surveysByVersion[row.versionNumber] ?? [];
	const answers = questions.flatMap((question) => {
		const words = surveyAnswerWords(question, row.answers[String(question.questionId)]);
		return words === null ? [] : [`${question.prompt}: ${question.kind === 'text' ? capped(words) : words}`];
	});
	if (answers.length > 0) sheet.quote(`Survey answers by ${row.name}, as version ${row.versionNumber} asked them`, answers);
	sheet.gap(3);
}

/** A record entry's shown detail in words (`detailWords`), one line a key. */
function detailLines(detail: Record<string, unknown>): string[] {
	const valueWords = (value: unknown): string => {
		if (value === null || value === undefined) return 'none';
		if (typeof value === 'boolean') return yesNo(value);
		if (typeof value === 'string' || typeof value === 'number') return String(value);
		if (Array.isArray(value)) return value.map(valueWords).join('; ');
		if (typeof value === 'object') {
			const entries = Object.entries(value as Record<string, unknown>);
			return entries.length === 0 ? 'none' : entries.map(([key, inner]) => `${detailWords(key)} ${valueWords(inner)}`).join(', ');
		}
		return '';
	};
	// Another decision the reader may not view is named by nothing (`namedFor`): said so.
	const unnamed = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
	return Object.entries(detail).map(([key, value]) =>
		`${detailWords(key)}: ${(key === 'supersedes' || key === 'by') && unnamed(value) ? 'a decision you cannot view' : valueWords(value)}`
	);
}

/**
 * The full record (R3), in the order ruled at S1 (F2): the decision, the ruling and the release, the version in full
 * and the versions listed, then the objections and requests to talk, the concerns and the questions, all before the
 * responses; then the current round (its totals and the group breakdown always, its responses by name up to
 * `RESPONSES_MOST`), the earlier rounds' totals, and the record last, so that a very large round can reach the
 * ceiling without leaving out the ruling's context. The event loop is given back after each row (`breathe`).
 */
async function drawFull(sheet: Sheet, exported: FullExport): Promise<void> {
	const d = exported.decision;
	const r = exported.results;
	sheet.doc.font('Helvetica-Bold').fontSize(16).fillColor(C.heading).text(`Decision #${d.id}`, MARGIN, sheet.doc.y, { width: sheet.width });
	sheet.line('Full record', { muted: true });
	sheet.gap(6);

	// The decision.
	sheet.quote('Title', d.title);
	sheet.line(`Board: ${d.boardName}`);
	sheet.line(`Status: ${STATUS_WORDS[d.shownStatus] ?? d.shownStatus} (stored as ${d.status})`);
	sheet.line(`Vote: ${d.voteMode === 'score' ? 'each option scored' : 'one option chosen'}`);
	sheet.line(`Decider: ${d.deciderName ?? 'none named'}`);
	sheet.line(`Author: ${d.authorName}`);
	sheet.line(`Opened: ${momentOf(d.openedAt)}`);
	sheet.line(`Closes: ${momentOf(d.closesAt, 'no closing time')}`);
	if (d.closedAt !== null) sheet.line(`Closed for input: ${momentOf(d.closedAt)}`);
	if (d.withdrawnAt !== null) {
		sheet.line(`Withdrawn: ${momentOf(d.withdrawnAt)}`);
		if (d.withdrawnReason) sheet.quote('The reason given for the withdrawal', d.withdrawnReason);
	}
	if (exported.supersedes !== null) sheet.line(`Supersedes: ${exported.supersedes.title ?? 'a decision you cannot view'}`);
	if (exported.laterDecision !== null) {
		sheet.line(`${exported.laterDecision.superseded ? 'Superseded by' : 'Ruled on beside a later decision'}: ${exported.laterDecision.title ?? 'a decision you cannot view'}`);
	}

	// The ruling.
	sheet.heading('The ruling');
	const ruling = exported.ruling;
	if (ruling === null) {
		sheet.line('Not ruled yet.');
	} else {
		sheet.line(`Ruled by ${ruling.byName} on ${momentOf(ruling.at)}: ${rulingOptionWords(ruling)}`);
		sheet.quote(`The reason given by ${ruling.byName}`, ruling.reason);
		if (ruling.conditions) sheet.quote(`The conditions set by ${ruling.byName}`, ruling.conditions);
		sheet.line(`Ruled early: ${yesNo(ruling.early)}${ruling.closedEarly ? ' (closed for input before its closing time)' : ''}`);
		sheet.line(`Against the responses: ${yesNo(ruling.againstResponses)}`);
		if (ruling.supersededOld !== null) sheet.line(`Superseded the earlier ruling: ${yesNo(ruling.supersededOld)}`);
		for (const [i, name] of ruling.cutOff.entries()) {
			const reached = ruling.cutOffReached[i];
			sheet.line(`Cut off by the early ruling: ${name || 'a participant'}${reached === false ? ` (${NOT_REACHED_WORDS})` : ''}`);
			await sheet.breathe();
		}
	}

	// The release.
	sheet.heading('The release');
	if (exported.release === null || exported.released === null) {
		sheet.line('Not released.');
	} else {
		sheet.line(
			`Released on ${momentOf(exported.release.at)} by ${exported.release.byName}; ${plural(exported.release.omitted, 'comment', 'comments')} left out. Everyone who may view the decision was shown:`
		);
		await drawReleased(sheet, exported.released);
	}

	// The current version in full.
	if (exported.version !== null) {
		await drawVersion(sheet, exported.version, exported.options, exported.audiences, exported.surveyQuestions, momentOf(exported.version.publishedAt));
	}

	// The versions, listed.
	sheet.heading('Versions');
	for (const version of exported.versions) {
		sheet.line(
			`Version ${version.number}, published ${momentOf(version.publishedAt)} by ${version.publishedByName}; ${version.asksAgain ? 'asked everyone for their view again' : 'told of the change only'}.`
		);
		if (version.changeNote) sheet.quote(`The note of the change to version ${version.number}`, version.changeNote);
		await sheet.breathe();
	}

	// Objections and requests to talk.
	sheet.heading('Objections and requests to talk');
	if (r.flags.length === 0) sheet.line('None.');
	for (const flag of r.flags) {
		const kind = flag.kind === 'talk' ? 'talk' : 'objection';
		sheet.keep(40);
		sheet.line(`${FLAG_KIND_WORDS[kind]} by ${flag.name}, about version ${flag.versionNumber}, ${momentOf(flag.raisedAt)}, ${viaWords(flag.via)}`, { bold: true });
		if (flag.reason === '') sheet.line('No note was given.', { muted: true });
		else sheet.quote(`The reason given by ${flag.name}`, capped(flag.reason));
		if (flag.reply === null) sheet.line(flagUnrepliedWords(kind), { muted: true });
		else sheet.quote(`The reply by ${flag.repliedByName ?? 'the decider'}, ${momentOf(flag.repliedAt)}`, capped(flag.reply));
		await sheet.breathe();
	}

	// Concerns after the ruling.
	sheet.heading('Concerns about the ruling');
	if (r.concerns.length === 0) sheet.line('None.');
	for (const concern of r.concerns) {
		sheet.quote(`A concern raised by ${concern.name}, ${momentOf(concern.createdAt)}, ${viaWords(concern.via)}`, capped(concern.comment));
		await sheet.breathe();
	}

	// Questions.
	sheet.heading('Questions');
	if (exported.questions.length === 0) sheet.line('None.');
	for (const question of exported.questions) {
		sheet.quote(
			`A question asked by ${question.askerName ?? 'a participant'}, ${momentOf(question.askedAt ?? null)}, about version ${question.askedInVersion}${question.askedByAgent ? `. ${ASKED_BY_AGENT}` : ''}`,
			capped(question.question)
		);
		if (question.answer === null) {
			sheet.line(unansweredWords(question.closedUnanswered), { muted: true });
		} else {
			const role = question.answer.answererRole === null ? '' : `, the ${question.answer.answererRole}`;
			const agent = question.answer.agentDrafted ? ", an agent's answer published by a person" : '';
			sheet.quote(`The answer by ${question.answer.answererName}${role}, ${momentOf(question.answer.answeredAt)}${agent}`, capped(question.answer.text));
		}
		await sheet.breathe();
	}

	// The current round: its totals and the group breakdown always; its responses by name up to RESPONSES_MOST.
	sheet.heading(`Results: round ${r.round}, the current round`);
	drawTotals(sheet, r.current, r.options, d.voteMode);
	if (r.groupBreakdown.length > 0) {
		sheet.subheading('By group');
		const labelOf = (optionId: number) => r.options.find((option) => option.optionId === optionId)?.label ?? 'no longer offered';
		for (const group of r.groupBreakdown) {
			const figures =
				d.voteMode === 'single'
					? group.votes.map((vote) => `${labelOf(vote.optionId)} ${vote.count}`)
					: group.scores.map((score) => `${labelOf(score.optionId)} mean ${score.mean ?? 'none'}`);
			sheet.line(
				`${group.name ?? 'No group'}: ${group.consulted} consulted, ${group.responded} responded, ${group.voted} voted, ${group.abstained} abstained, ${group.noConcerns} no concerns` +
					(figures.length > 0 ? `; ${figures.join(', ')}` : '')
			);
			await sheet.breathe();
		}
	}
	sheet.subheading('Responses, by name');
	if (r.current.rows.length === 0) sheet.line('No responses in this round.');
	let listed = 0;
	for (const row of r.current.rows.slice(0, RESPONSES_MOST)) {
		drawResponse(sheet, exported, row);
		listed++;
		await sheet.breathe();
	}
	if (r.current.rows.length > listed) sheet.line(responsesHeldWords(r.current.rows.length - listed), { italic: true, muted: true });
	if (r.notResponded.length > 0) {
		sheet.subheading('Not responded');
		for (const row of r.notResponded) {
			sheet.line(`${row.name}${row.groups.length > 0 ? ` (${row.groups.join(', ')})` : ''}${row.reached ? '' : `: ${NOT_REACHED_WORDS}`}`);
			await sheet.breathe();
		}
	}
	if (r.removed.length > 0) {
		sheet.subheading('Removed from the decision');
		for (const removed of r.removed) {
			if (removed.latest === null) {
				sheet.line(`${removed.name}, ${removed.role}: no response in this round.`);
			} else if (listed < RESPONSES_MOST) {
				drawResponse(sheet, exported, removed.latest);
				listed++;
			} else {
				sheet.line(`${removed.name}, ${removed.role}: ${REMOVED_RESPONSE_HELD}`);
			}
			await sheet.breathe();
		}
	}

	// Earlier rounds, their totals alone.
	for (const round of r.earlierRounds) {
		sheet.heading(`Results: round ${round.round}, an earlier round`);
		drawTotals(sheet, round, r.options, d.voteMode);
		sheet.line(EARLIER_ROUND_HELD, { italic: true, muted: true });
		await sheet.breathe();
	}

	// The record, last.
	sheet.heading('The record');
	if (exported.record.entries.length === 0) sheet.line('No entries.');
	for (const entry of exported.record.entries) {
		const parts = [
			momentOf(entry.at),
			eventWords(entry.kind),
			...(entry.versionNumber === null ? [] : [`version ${entry.versionNumber}`]),
			...(entry.participant === null ? [] : [entry.participant]),
			`by ${entry.actor.name} (${entry.actor.source})`
		];
		sheet.line(parts.join('  ·  '));
		const lines = detailLines(entry.detail);
		if (lines.length > 0) sheet.quote('Detail, as recorded', lines);
		await sheet.breathe();
	}
	if (exported.record.more) sheet.line(RECORD_MORE, { italic: true });
}

// ─── The document ────────────────────────────────────────────────────────────

/** What `flushPages` writes out, read from pdfkit's own buffer so the last pass can write it a few pages at a time (F2). */
type PageBuffer = { _pageBuffer: PDFKit.PDFPage[]; _pageBufferStart: number; flushPages(): void };

function pageBufferOf(doc: PDFKit.PDFDocument): PageBuffer {
	const held = doc as unknown as Partial<PageBuffer>;
	if (!Array.isArray(held._pageBuffer) || typeof held._pageBufferStart !== 'number' || typeof held.flushPages !== 'function') {
		throw new Error('decision-report: pdfkit no longer buffers its pages as an array; the PDF cannot be written a few pages at a time');
	}
	return held as PageBuffer;
}

/**
 * Draw a decision's PDF (R3 to R12): the full record or the shareable copy,
 * as `exported` says, for the exporter it names. Answers the PDF, its pages
 * and whether it stopped at the ceiling, for the route's one log line (R15).
 * Asynchronous, as pdfkit is, so the route calls it outside any transaction;
 * and it gives the event loop back between rows and between each few pages of
 * the last pass (F2), so that a large record never holds other requests for
 * long.
 *
 * `ceilings` is `PDF_PAGE_CEILING` and `PDF_BYTE_CEILING`, which the route
 * never changes; a lower byte ceiling is how its own case reaches it, since
 * text alone does not (D3).
 */
export async function generateDecisionPdf(
	exported: DecisionExport,
	ceilings: Ceilings = { pages: PDF_PAGE_CEILING, bytes: PDF_BYTE_CEILING }
): Promise<{ pdf: Buffer; pages: number; stopped: boolean }> {
	const full = exported.copy === 'full';
	const id = exported.decision.id;
	const title = pdfSafe(exported.decision.title);
	const doc = new PDFDocument({
		size: 'A4',
		bufferPages: true,
		margins: { top: full ? 78 : 50, bottom: 54, left: MARGIN, right: MARGIN },
		// S-L3: set here alone, over pdfkit's own Producer, Creator and creation moment; no Subject, no Keywords.
		info: {
			Title: `Decision #${id}: ${title.text}${full ? ' (private record)' : ''}`,
			Author: 'DumpFire',
			Creator: 'DumpFire',
			Producer: 'DumpFire',
			CreationDate: new Date(`${exported.exporter.date}T00:00:00Z`)
		}
	});
	const chunks: Buffer[] = [];
	const ended = new Promise<Buffer>((resolve, reject) => {
		doc.on('data', (chunk: Buffer) => chunks.push(chunk));
		doc.on('end', () => resolve(Buffer.concat(chunks)));
		doc.on('error', reject);
	});

	const sheet = new Sheet(doc, ceilings);
	if (title.replaced) sheet.replaced = true;
	if (exported.copy === 'full') await drawFull(sheet, exported);
	else await drawShareable(sheet, exported);

	// The closing lines (R8), past the ceiling too: what the copy is.
	const exporter = sheet.safeLine(exported.exporter.name);
	const closing = full ? FULL_RECORD_CLOSING : SHAREABLE_CLOSING;
	doc.y += 14;
	if (doc.y + 40 > doc.page.height - doc.page.margins.bottom) doc.addPage();
	doc.font('Helvetica-Oblique').fontSize(8).fillColor(C.textMuted).text(closing, MARGIN, doc.y, { width: sheet.width });
	if (sheet.replaced) {
		doc.y += 4;
		doc.font('Helvetica-Oblique').fontSize(8).fillColor(C.textMuted).text(PDF_REPLACED_NOTE, MARGIN, doc.y, { width: sheet.width });
	}

	// The last pass over every page: the rules beside quoted blocks, the band and the footer (R7, R8); each few pages
	// then written out, compressed, before the event loop is given back (F2).
	const buffer = pageBufferOf(doc);
	const pages = [...buffer._pageBuffer];
	const start = buffer._pageBufferStart;
	const count = pages.length;
	const day = dayOf(exported.exporter.date);
	const rulesOf = new Map<number, Rule[]>();
	for (const rule of sheet.rules) {
		if (rule.to > rule.from) rulesOf.set(rule.page, [...(rulesOf.get(rule.page) ?? []), rule]);
	}
	for (let from = 0; from < count; from += PAGES_A_TURN) {
		const to = Math.min(count, from + PAGES_A_TURN);
		for (let i = from; i < to; i++) {
			doc.switchToPage(start + i);
			const page = doc.page;
			const bottom = page.margins.bottom;
			page.margins.bottom = 0;
			for (const rule of rulesOf.get(i) ?? []) doc.rect(MARGIN + 4, rule.from, 1.5, rule.to - rule.from).fill(C.accentLight);
			if (full) {
				doc.rect(0, 0, page.width, 56).fill(C.red);
				doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.white);
				doc.text(PRIVATE_BAND[0], MARGIN, 16, { width: sheet.width });
				doc.text(PRIVATE_BAND[1], MARGIN, 30, { width: sheet.width });
			}
			doc.font('Helvetica').fontSize(7).fillColor(C.textLight).text(
				`${full ? 'Full record' : 'Shareable copy'} · Decision #${id} · exported by ${exporter} on ${day} · page ${i + 1} of ${count}`,
				MARGIN,
				page.height - 34,
				{ width: sheet.width }
			);
			page.margins.bottom = bottom;
		}
		// These pages written out (pdfkit's `flushPages`, given these alone), the rest kept for the next turn.
		buffer._pageBuffer = pages.slice(from, to);
		buffer.flushPages();
		buffer._pageBuffer = pages.slice(to);
		await giveBack();
	}

	doc.end();
	return { pdf: await ended, pages: count, stopped: sheet.stopped };
}
