/**
 * A decision as a PDF (card 2688): the two projections in
 * `src/lib/server/decision-export.ts` (`readFullExport`, the decider's and
 * administrators' full record; `readShareableExport`, the copy every viewer
 * may take), the renderer and its bounds in `src/lib/server/decision-report.ts`
 * (`generateDecisionPdf`), and the entry a full record writes on the
 * decision's record (`recordExport`, `src/lib/server/decision-export-writes.ts`),
 * called as the route will call it, inside `writeAs` and handed its `caller`.
 *
 * The PDF's text is read with `pdfText` (tests/helpers/pdf.ts), one line a
 * text showing: markers are planted in every field, ASCII so that the reader
 * decodes them, and a marker a long line may break is looked for in the text
 * with its line breaks taken out (`flat`). The cases are the plan's,
 * `docs/planning/card-2688-decision-pdf-export.md`, section 9, by id; those
 * through the route (E13 to E15, E20) are slice S2's, called as the page
 * calls it (`api`, and through the gate for its headers). Ruled at S1 (F2) and
 * built in S2: the full record's order and its 500 responses by name (E1,
 * E21), the event loop given back while drawing (E21), and the four cases the
 * S1 builder found missing: the private band on every page (E24), the byte
 * ceiling on its own (E25), the "?" note set off by the title or the
 * exporter's name alone (T3), and `holdDrawing` at the service (E26).
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { inflateSync } from 'node:zlib';
import { isHttpError } from '@sveltejs/kit';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { boards, decisionParticipants, decisionSurveyQuestions, decisions, peopleGroupMembers, peopleGroups, type Board, type Decision } from '$lib/server/db/schema';
import { appendEvent, SYSTEM_ACTOR } from '$lib/server/decision-record';
import { readRecord, RECORD_READ_MAX } from '$lib/server/decision-register';
import { readDecisionPage } from '$lib/server/decision-view';
import { readFullExport, readShareableExport, type DecisionExport, type FullExport } from '$lib/server/decision-export';
import { recordExport } from '$lib/server/decision-export-writes';
import {
	DRAWING_KEY,
	EXPORT_READ_DEADLINE_MS,
	EXPORT_WINDOW_MS,
	exportAllowanceKey,
	EXPORTS_AN_HOUR,
	generateDecisionPdf,
	holdDrawing,
	PDF_BYTE_CEILING,
	PDF_PAGE_CEILING,
	PDF_TEXT_MOST,
	RESPONSES_MOST
} from '$lib/server/decision-report';
import { allowanceState, enterInFlight, inFlightAt, leaveInFlight, resetAllRateLimits } from '$lib/server/rate-limit';
import { subscribeToLogs, type LogEntry } from '$lib/server/logger';
import { stamp } from '$lib/timestamps';
import { writeAs, type ServiceOptions } from '$lib/server/write-as';
import {
	detailWords,
	DRAFT_NOT_EXPORTED,
	EARLIER_ROUND_HELD,
	eventWords,
	EXPORT_BUSY,
	EXPORT_CHANGED,
	FULL_RECORD_CLOSING,
	exportLateWords,
	NO_OPTIONS_PUT,
	NOT_REACHED_WORDS,
	PDF_CEILING_LINE,
	PDF_REPLACED_NOTE,
	PRIVATE_BAND,
	RECORD_MORE,
	REMOVED_RESPONSE_HELD,
	responsesHeldWords,
	RESULTS_NOT_RELEASED,
	SHAREABLE_CLOSING,
	STATUS_WORDS,
	TEXT_CUT
} from '$lib/decision-words';
import type { ResultFlag, ResultRow } from '$lib/decision-view-types';
import { api } from './helpers/api';
import { gate, gateRoutes } from './helpers/gate';
import { pdfText } from './helpers/pdf';
import {
	addBoardMember,
	makeBoard,
	makeDecision,
	makeOption,
	makeParticipant,
	makePerson,
	makeQuestion,
	makeResponse,
	makeRuling,
	makeSession,
	makeUser,
	makeVersion,
	resetDb
} from './helpers/fixtures';

const UI: ServiceOptions = { source: 'ui' };
const PAST = '2026-11-03 09:00:00';
const FUTURE = '2099-01-01 12:00:00';

let owner: SessionUser;
let board: Board;
let seq = 0;

beforeEach(() => {
	resetDb();
	// E-L4: no case spends another's hour or drawing place.
	resetAllRateLimits();
	owner = makeUser({ username: 'owner' });
	board = makeBoard({ owner, name: 'The board' }).board;
});

/** Call a write as `user`, as a route calls it inside its writeAs callback. */
const as = <T>(user: SessionUser, write: (caller: SessionUser | null) => T): T => writeAs({ user } as App.Locals, write as never) as T;

/** What a call was answered with: 'passed', or the refusal's status and words. */
function outcome(run: () => unknown): 'passed' | { status: number; message: string } {
	try {
		run();
		return 'passed';
	} catch (err) {
		if (isHttpError(err)) return { status: err.status, message: err.body.message };
		throw err;
	}
}

const eventCount = (decisionId: number) => (sqlite.prepare('SELECT COUNT(*) AS n FROM decision_events WHERE decision_id = ?').get(decisionId) as { n: number }).n;
const decisionRow = (id: number) => db.select().from(decisions).where(eq(decisions.id, id)).get()!;

/** The PDF of a projection, as its text. */
async function textOf(exported: DecisionExport): Promise<string> {
	return pdfText((await generateDecisionPdf(exported)).pdf);
}

/** The text with every line break and run of white space taken out, for a marker a wrapped line may break. */
const flat = (text: string) => text.replace(/\s+/g, '');

/** Whether `words` are in the text, wherever its lines broke them. */
const has = (text: string, words: string) => flat(text).includes(flat(words));

/** Whether a line holding `label` is followed, within a few lines, by one holding `marker`: words inside their labelled block (R7). */
function inBlock(text: string, label: string, marker: string): boolean {
	const lines = text.split('\n');
	return lines.some((line, i) => line.includes(label) && lines.slice(i + 1, i + 8).some((after) => after.includes(marker)));
}

/** A fact's value (card 3077): the line after its label, which the facts grid draws first. */
const factOf = (text: string, label: string): string | undefined => {
	const lines = text.split('\n');
	const at = lines.indexOf(label);
	return at === -1 ? undefined : lines[at + 1];
};

/** A figure tile's value (card 3077): the line before its label, since a tile draws its value first. */
const tileOf = (text: string, label: string): string | undefined => {
	const lines = text.split('\n');
	const at = lines.indexOf(label);
	return at < 1 ? undefined : lines[at - 1];
};

/** Whether `cells` are drawn one after another as lines, in order: a table row's cells, or a sentence and what follows it. */
const hasRow = (text: string, cells: string[]) => {
	const lines = text.split('\n');
	return lines.some((_, i) => cells.every((cell, j) => lines[i + j] === cell));
};

/**
 * Each text showing of a PDF that `pdfkit` wrote, in drawing order, with the standard font it is shown in (card 3077's
 * code review, M1): read as `pdfText` reads the text, each `Tf` naming the font of the showings after it, and each
 * font's name (`/F1`) taken to its `/BaseFont` through the document's font objects.
 */
function shownFonts(pdf: Buffer): { text: string; font: string }[] {
	const raw = pdf.toString('latin1');
	const base = new Map<string, string>();
	for (const found of raw.matchAll(/(\d+) 0 obj\s*<<\s*\/Type \/Font\s*\/BaseFont \/([\w-]+)/g)) base.set(found[1], found[2]);
	const fonts = new Map<string, string>();
	for (const found of raw.matchAll(/\/(F\d+) (\d+) 0 R/g)) fonts.set(found[1], base.get(found[2]) ?? 'unknown');
	const decode = (hex: string) => Buffer.from(hex, 'hex').toString('latin1');
	const shown: { text: string; font: string }[] = [];
	for (const stream of raw.matchAll(/\/Length (\d+)\s*\/Filter \/FlateDecode\s*>>\s*stream\r?\n/g)) {
		const start = stream.index! + stream[0].length;
		const content = inflateSync(pdf.subarray(start, start + Number(stream[1]))).toString('latin1');
		let font = 'unknown';
		for (const op of content.matchAll(/\/(F\d+) [\d.]+ Tf|\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
			if (op[1] !== undefined) font = fonts.get(op[1]) ?? 'unknown';
			else shown.push({ text: op[2] !== undefined ? [...op[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((hex) => decode(hex[1])).join('') : decode(op[3]), font });
		}
	}
	return shown;
}

/** The text with the exporter's name taken out of each footer: what two exporters' copies may differ by. */
const withoutExporter = (text: string, name: string) => text.replaceAll(`exported by ${name} on`, 'exported by EXPORTER on');

/** A participant reached through their account, in the groups named (their snapshot) and, where given, a member of `group`. */
function withAccount(decision: Decision, name: string, opts: { groups?: string[]; group?: number; role?: 'consulted' | 'informed' } = {}) {
	const account = makeUser({ username: `${name.toLowerCase()}${++seq}` });
	const person = makePerson({ fullName: `${name} Person`, user: account });
	if (opts.group !== undefined) db.insert(peopleGroupMembers).values({ groupId: opts.group, personId: person.id }).run();
	const participant = makeParticipant(decision, { person, role: opts.role ?? 'consulted', groups: JSON.stringify(opts.groups ?? []) });
	return { account, person, participant };
}

/** A flag row as `raiseFlag` and `replyToFlag` leave one; answers its id. */
const plantFlag = (decisionId: number, participantId: number, row: { kind: 'objection' | 'talk'; reason: string; reply?: string; versionNumber?: number }): number =>
	Number(
		sqlite
			.prepare(
				'INSERT INTO decision_flags (decision_id, participant_id, kind, reason, version_number, via, raised_at, reply, replied_by_name, replied_at) ' +
					"VALUES (?, ?, ?, ?, ?, 'session', '2026-11-02 09:30:00', ?, ?, ?)"
			)
			.run(decisionId, participantId, row.kind, row.reason, row.versionNumber ?? 2, row.reply ?? null, row.reply === undefined ? null : 'A decider', row.reply === undefined ? null : '2026-11-02 10:30:00')
			.lastInsertRowid
	);

/** Release the results as `releaseResults` records it: the moment, and the event naming the last response counted and the comments left out. */
function release(decision: Decision, by: SessionUser, omitted: { responseId: number; field: string }[]) {
	const upTo = (sqlite.prepare('SELECT MAX(id) AS id FROM decision_responses WHERE decision_id = ?').get(decision.id) as { id: number }).id;
	db.update(decisions).set({ resultsReleasedAt: '2026-11-02 16:00:00', resultsReleasedBy: by.id }).where(eq(decisions.id, decision.id)).run();
	appendEvent({ decisionId: decision.id, kind: 'results_released', versionNumber: 2, detail: { upToResponseId: upTo, omitted } }, { userId: by.id, name: by.username, source: 'ui' });
}

/**
 * A decision with a marker in every part (E1): version 1 asked round 1, version 2 asked round 2 (its change note
 * CHANGENOTEMARK); options A and B; audiences in stored order, the first for no group and the second for group G
 * (GROUPMARK); a written survey question; Pat (in G), Quin and Ria responded in round 2, Pat also in round 1
 * (EARLIERCOMMENTMARK), Sil did not and was cut off unreached, Tam did (REMOVEDMARK) and was then removed from the
 * decision (card 2688's code review, E-M1); then, unless `ruled` is false, ruled early and against
 * on A, released with Ria's comment left out; an objection with a reply and a request to talk; a concern; a question
 * answered.
 */
function rich(opts: { ruled?: boolean; quinComment?: string } = {}) {
	const ruled = opts.ruled ?? true;
	const decider = makeUser({ username: `decider${++seq}` });
	addBoardMember(board, decider, 'editor');
	const author = makeUser({ username: `author${++seq}` });
	addBoardMember(board, author, 'editor');
	const made = makeDecision({
		board,
		author,
		decider,
		title: 'TITLEMARK',
		status: ruled ? 'closed' : 'open',
		closesAt: ruled ? PAST : FUTURE,
		openedAt: '2026-11-01 09:00:00',
		voteMode: 'single'
	});
	const a = makeOption(made, { label: 'A', position: 0, addedInVersion: 1 });
	const b = makeOption(made, { label: 'B', position: 1, addedInVersion: 1 });
	const question = db.insert(decisionSurveyQuestions).values({ decisionId: made.id, position: 0, addedInVersion: 1 }).returning().get();
	const group = db.insert(peopleGroups).values({ name: 'GROUPMARK' }).returning().get();
	const options = [
		{ optionId: a.id, label: 'A', title: 'Plan A', summary: 'SUMMARYMARK', pros: ['PROMARK'], cons: ['CONMARK'], commercial: '' },
		{ optionId: b.id, label: 'B', title: 'Plan B', summary: '', pros: [], cons: [], commercial: '' }
	];
	const surveyQuestions = [{ questionId: question.id, kind: 'text', prompt: 'PROMPTMARK', help: '', required: false }];
	makeVersion(made, { situation: 'SITUATIONV1', question: 'Which plan?', options, surveyQuestions }, { number: 1, publishedAt: '2026-11-01 09:00:00' });
	makeVersion(
		made,
		{
			situation: 'SITUATIONMARK',
			question: 'QUESTIONMARK',
			ask: 'ASKSECTIONMARK',
			options,
			audiences: [
				{ groupId: null, heading: 'AUDIENCEONE', body: 'AUDBODYONE' },
				{ groupId: group.id, heading: 'AUDIENCEG', body: 'AUDBODYG' }
			],
			surveyQuestions
		},
		{ number: 2, publishedAt: '2026-11-01 12:00:00', changeNote: 'CHANGENOTEMARK' }
	);
	const pat = withAccount(made, 'Pat', { groups: ['GROUPMARK'], group: group.id });
	const quin = withAccount(made, 'Quin');
	const ria = withAccount(made, 'Ria');
	const sil = withAccount(made, 'Sil');
	makeResponse(pat.participant, { kind: 'vote', optionId: b.id, comment: 'EARLIERCOMMENTMARK', round: 1, versionNumber: 1, createdAt: '2026-11-01 10:00:00' });
	const pats = makeResponse(pat.participant, {
		kind: 'vote',
		optionId: a.id,
		comment: 'PATCOMMENTMARK',
		answers: JSON.stringify({ [question.id]: 'SURVEYANSWERMARK' }),
		round: 2,
		versionNumber: 2,
		createdAt: '2026-11-01 13:00:00'
	});
	makeResponse(quin.participant, { kind: 'vote', optionId: a.id, comment: opts.quinComment ?? 'QUINCOMMENTMARK', round: 2, versionNumber: 2, createdAt: '2026-11-01 13:10:00' });
	const rias = makeResponse(ria.participant, { kind: 'abstain', comment: 'RIACOMMENTMARK', round: 2, versionNumber: 2, createdAt: '2026-11-01 13:20:00' });
	// Card 2688's code review (E-M1): Tam responded in round 2 and was then removed from the decision.
	const tam = withAccount(made, 'Tam');
	makeResponse(tam.participant, { kind: 'vote', optionId: b.id, comment: 'REMOVEDMARK', round: 2, versionNumber: 2, createdAt: '2026-11-01 13:30:00' });
	db.update(decisionParticipants).set({ removedAt: '2026-11-01 14:00:00' }).where(eq(decisionParticipants.id, tam.participant.id)).run();
	plantFlag(made.id, pat.participant.id, { kind: 'objection', reason: 'OBJECTIONMARK', reply: 'REPLYMARK' });
	plantFlag(made.id, quin.participant.id, { kind: 'talk', reason: 'TALKMARK' });
	makeQuestion(made, quin.participant, { question: 'ASKMARK', askedInVersion: 2, answer: 'ANSWERMARK', by: decider, role: 'decider' });
	if (ruled) {
		makeRuling(made, { optionId: a.id, reason: 'REASONMARK', conditions: 'CONDITIONMARK', early: true, againstResponses: true, ruledAt: '2026-11-02 15:30:00' });
		appendEvent({ decisionId: made.id, kind: 'cut_off', participantId: sil.participant.id, versionNumber: 2, detail: { reached: false } }, SYSTEM_ACTOR);
		makeResponse(pat.participant, { kind: 'concern', comment: 'CONCERNMARK', round: 2, versionNumber: 2, createdAt: '2026-11-02 17:00:00' });
		release(made, decider, [{ responseId: rias.id, field: 'comment' }]);
	}
	return { decision: decisionRow(made.id), a, b, group, question, decider, author, pat, quin, ria, sil, tam, responses: { pats, rias } };
}

/** A board reader: may view every decision on the board that is not a draft. */
function boardReader(name = 'reader') {
	const reader = makeUser({ username: `${name}${++seq}` });
	addBoardMember(board, reader, 'viewer');
	return reader;
}

/** A decision opened with one version and one option, on the board, decided by a board editor. */
function plain(opts: { status?: string; title?: string; board?: Board } = {}) {
	const decider = makeUser({ username: `decider${++seq}` });
	const on = opts.board ?? board;
	addBoardMember(on, decider, 'editor');
	const made = makeDecision({
		board: on,
		author: decider,
		decider,
		title: opts.title ?? 'Plain',
		status: opts.status ?? 'open',
		closesAt: FUTURE,
		openedAt: '2026-11-01 09:00:00',
		updatedAt: '2026-11-01 09:00:00'
	});
	const a = makeOption(made, { label: 'A', position: 0, addedInVersion: 1 });
	makeVersion(made, { situation: 'Plain situation', options: [{ optionId: a.id, label: 'A', title: 'Plan A' }] }, { number: 1 });
	return { decision: decisionRow(made.id), a, decider };
}

// ─── The full record (E1 to E4, E9, E11, E12, E16, E19) ──────────────────────

describe('the full record', () => {
	it('holds a marker of every part for the decider, earlier rounds as totals alone, the band and the footer (E1)', async () => {
		const { decision, decider } = rich();
		const text = await textOf(readFullExport(decider, decision.id));

		for (const marker of ['TITLEMARK', 'SITUATIONMARK', 'QUESTIONMARK', 'ASKSECTIONMARK', 'SUMMARYMARK', 'PROMARK', 'CONMARK', 'AUDIENCEONE', 'AUDIENCEG', 'AUDBODYG', 'PROMPTMARK']) {
			expect(text, marker).toContain(marker);
		}
		expect(inBlock(text, 'Comment by Pat Person', 'PATCOMMENTMARK'), 'a comment by name').toBe(true);
		expect(inBlock(text, 'Survey answers by Pat Person', 'PROMPTMARK: SURVEYANSWERMARK'), 'a survey answer by name').toBe(true);
		expect(inBlock(text, 'The reason given by Pat Person', 'OBJECTIONMARK'), 'an objection').toBe(true);
		expect(inBlock(text, 'The reply by A decider', 'REPLYMARK'), 'its reply').toBe(true);
		expect(text).toContain('Request to talk by Quin Person');
		expect(inBlock(text, 'The reason given by Quin Person', 'TALKMARK'), 'a request to talk').toBe(true);
		// Card 3077: the group breakdown is a table; its row starts with the group's name, then its consulted count.
		expect(hasRow(text, ['GROUPMARK', '1']), 'a group row').toBe(true);
		expect(inBlock(text, 'A concern raised by Pat Person', 'CONCERNMARK'), 'a concern').toBe(true);
		expect(inBlock(text, 'A question asked by Quin Person', 'ASKMARK'), 'a question with its asker').toBe(true);
		expect(inBlock(text, 'The answer by', 'ANSWERMARK'), 'its answer').toBe(true);
		expect(factOf(text, 'RULED EARLY')).toBe('yes');
		expect(factOf(text, 'AGAINST THE RESPONSES')).toBe('yes');
		expect(factOf(text, 'CUT OFF BY THE EARLY RULING')).toBe(`Sil Person (${NOT_REACHED_WORDS})`);
		// Card 2688's code review (E-M1): a removed participant's latest response under its own heading, in its labelled
		// block; and one who has not responded, never reached by the round's request, said so.
		expect(inBlock(text, 'Removed from the decision', 'Tam Person'), 'the removed participant under its heading').toBe(true);
		expect(inBlock(text, 'Comment by Tam Person', 'REMOVEDMARK'), "the removed participant's latest, in its block").toBe(true);
		expect(text.indexOf('REMOVEDMARK', text.indexOf('Removed from the decision')), 'after the heading').toBeGreaterThan(-1);
		expect(text.split('\n').includes(`Sil Person: ${NOT_REACHED_WORDS}`), 'a "Not responded" line never reached').toBe(true);
		expect(inBlock(text, 'A comment, released without a name', 'PATCOMMENTMARK'), 'the released comment').toBe(true);
		expect(text.split('\n').some((line) => line.includes(`  ·  ${eventWords('results_released')}  ·  `)), 'a record entry in words').toBe(true);
		expect(inBlock(text, 'The note of the change to version 2', 'CHANGENOTEMARK'), "the earlier version's change note").toBe(true);
		expect(text).toContain('Results: round 1, an earlier round');
		expect(text).toContain(EARLIER_ROUND_HELD);
		expect(text).toContain(PRIVATE_BAND[0]);
		expect(text).toContain(PRIVATE_BAND[1]);
		expect(text).toMatch(new RegExp(`Full record · Decision #${decision.id} · exported by ${decider.username} on \\d{1,2} [A-Z][a-z]{2} \\d{4} · page 1 of \\d+`));
		expect(has(text, FULL_RECORD_CLOSING)).toBe(true);
		// R3.7: an earlier round's responses are never given by name.
		expect(text).not.toContain('EARLIERCOMMENTMARK');
		// F2 (ruled at S1): the ruling's context before the responses by name, and the record last.
		const lines = text.split('\n');
		const at = (heading: string) => lines.indexOf(heading);
		const order = ['The ruling', 'The release', 'Objections and requests to talk', 'Concerns about the ruling', 'Questions', 'Responses, by name', 'The record'].map(at);
		expect(order.every((index) => index >= 0), order.join(', ')).toBe(true);
		expect(order, 'the sections in the order ruled').toEqual([...order].sort((a, b) => a - b));
		expect(at('Results: round 1, an earlier round')).toBeLessThan(at('The record'));
	});

	it('gives an administrator who is not the decider the decider’s document, with no address the record holds (E2)', async () => {
		const { decision, decider, pat } = rich();
		const admin = makeUser({ role: 'admin', username: 'adminexporter' });
		appendEvent(
			{ decisionId: decision.id, kind: 'address_changed', participantId: pat.participant.id, detail: { from: 'oldaddr@example.test', to: 'newaddr@example.test' } },
			SYSTEM_ACTOR
		);
		// The administrator's own record view shows it, behind their sign-in.
		expect(readRecord(admin, decision.id, { participant: null, after: null }, { source: 'ui', limit: 500 }).entries.at(-1)!.detail).toEqual({
			from: 'oldaddr@example.test',
			to: 'newaddr@example.test'
		});

		const deciders = await textOf(readFullExport(decider, decision.id));
		const admins = await textOf(readFullExport(admin, decision.id));
		for (const text of [deciders, admins]) {
			expect(text).toContain(eventWords('address_changed'));
			expect(text).not.toMatch(/oldaddr|newaddr/);
		}
		expect(withoutExporter(admins, admin.username)).toEqual(withoutExporter(deciders, decider.username));
	});

	it('refuses the author who is not the decider, a board editor, 403, and writes nothing (E3)', () => {
		const { decision, author } = rich();
		const before = eventCount(decision.id);
		expect(outcome(() => readFullExport(author, decision.id))).toEqual({ status: 403, message: 'You cannot read the record of this decision' });
		expect(eventCount(decision.id)).toBe(before);
	});

	it('refuses either copy to an outsider who cannot view the decision, 404, and writes nothing (E4)', () => {
		const { decision } = rich();
		const outsider = makeUser({ username: 'outsider' });
		const before = eventCount(decision.id);
		expect(outcome(() => readFullExport(outsider, decision.id))).toEqual({ status: 404, message: 'Decision not found' });
		expect(outcome(() => readShareableExport(outsider, decision.id))).toEqual({ status: 404, message: 'Decision not found' });
		expect(eventCount(decision.id)).toBe(before);
	});

	it('refuses either copy of a draft, 409, and writes nothing (E9)', () => {
		const decider = makeUser({ username: 'draftdecider' });
		addBoardMember(board, decider, 'editor');
		const draft = makeDecision({ board, author: decider, decider, title: 'A draft' });
		const before = eventCount(draft.id);
		expect(outcome(() => readFullExport(decider, draft.id))).toEqual({ status: 409, message: DRAFT_NOT_EXPORTED });
		expect(outcome(() => readShareableExport(decider, draft.id))).toEqual({ status: 409, message: DRAFT_NOT_EXPORTED });
		expect(eventCount(draft.id)).toBe(before);
	});

	it('writes one record_exported for a full record, shown in words and given to the decider’s key; a shareable copy writes none (E11)', async () => {
		const { decision, decider } = rich();
		const before = eventCount(decision.id);
		const shareable = readShareableExport(decider, decision.id);
		await generateDecisionPdf(shareable);
		expect(eventCount(decision.id), 'a shareable copy').toBe(before);

		const full = readFullExport(decider, decision.id);
		await generateDecisionPdf(full);
		as(decider, (caller) => recordExport(caller, { decisionId: decision.id }, full.drawn, UI));

		const written = sqlite
			.prepare('SELECT kind, participant_id AS participantId, version_number AS versionNumber, detail, actor_user_id AS actorUserId, actor_name AS actorName, source FROM decision_events WHERE decision_id = ? ORDER BY id DESC LIMIT 1')
			.all(decision.id);
		expect(eventCount(decision.id)).toBe(before + 1);
		expect(written).toEqual([
			{ kind: 'record_exported', participantId: null, versionNumber: 2, detail: '{}', actorUserId: decider.id, actorName: decider.username, source: 'ui' }
		]);
		const page = readRecord(decider, decision.id, { participant: null, after: null }, { source: 'ui', limit: RECORD_READ_MAX });
		expect(page.entries.at(-1)).toMatchObject({ kind: 'record_exported', versionNumber: 2, participant: null, detail: {} });
		expect(eventWords('record_exported')).toBe('Full record exported as a PDF');
		expect(await textOf(readFullExport(decider, decision.id))).toContain('Full record exported as a PDF');
		const key = readRecord(decider, decision.id, { participant: null, after: null }, { source: 'api', limit: RECORD_READ_MAX });
		expect(key.entries.at(-1)).toMatchObject({ kind: 'record_exported', versionNumber: 2, untrusted: true });
	});

	it('refuses the entry, 403, to a decider who lost board edit after the copy was drawn, and writes none (E12)', async () => {
		const { decision, decider } = rich();
		const full = readFullExport(decider, decision.id);
		await generateDecisionPdf(full);
		sqlite.prepare("UPDATE board_members SET role = 'viewer' WHERE board_id = ? AND user_id = ?").run(board.id, decider.id);
		const before = eventCount(decision.id);

		expect(outcome(() => as(decider, (caller) => recordExport(caller, { decisionId: decision.id }, full.drawn, UI)))).toEqual({
			status: 403,
			message: 'You cannot read the record of this decision'
		});
		expect(eventCount(decision.id)).toBe(before);
	});

	it.each([
		{ change: 're-published to version 2', apply: (decision: Decision) => void makeVersion(decision, { situation: 'Again' }, { number: 2 }) },
		{ change: 'closed', apply: (decision: Decision) => void db.update(decisions).set({ status: 'closed' }).where(eq(decisions.id, decision.id)).run() },
		{ change: 'changed otherwise', apply: (decision: Decision) => void db.update(decisions).set({ updatedAt: '2026-11-20 10:00:00' }).where(eq(decisions.id, decision.id)).run() },
		// Card 2688's code review (E-L2): a release, its updatedAt unchanged (as in the same second as the change before it).
		{ change: 'released', apply: (decision: Decision) => void db.update(decisions).set({ resultsReleasedAt: '2026-11-20 10:00:00', resultsReleasedBy: decision.deciderUserId }).where(eq(decisions.id, decision.id)).run() }
	])('refuses the entry, 409, for a decision $change while it was drawn, and writes none (E19)', ({ apply }) => {
		const { decision, decider } = plain();
		const full = readFullExport(decider, decision.id);
		apply(decision);
		const before = eventCount(decision.id);

		expect(outcome(() => as(decider, (caller) => recordExport(caller, { decisionId: decision.id }, full.drawn, UI)))).toEqual({ status: 409, message: EXPORT_CHANGED });
		expect(eventCount(decision.id)).toBe(before);
	});

	it('ends with the record-view line past 5,000 entries, and not at 5,000 (E16)', { timeout: 120_000 }, async () => {
		const { decision, decider } = plain();
		const insert = sqlite.prepare(
			"INSERT INTO decision_events (decision_id, participant_id, kind, version_number, detail, actor_user_id, actor_name, source, created_at) VALUES (?, NULL, 'extended', 1, ?, NULL, 'DumpFire', 'system', '2026-11-02 09:00:00')"
		);
		const plant = (n: number) => sqlite.transaction(() => {
			for (let i = 0; i < n; i++) insert.run(decision.id, JSON.stringify({ from: PAST, to: FUTURE }));
		})();
		plant(RECORD_READ_MAX - eventCount(decision.id));
		expect(eventCount(decision.id)).toBe(5000);

		const atMost = readFullExport(decider, decision.id);
		expect(atMost.record.entries).toHaveLength(5000);
		expect(has(await textOf(atMost), RECORD_MORE)).toBe(false);

		plant(1);
		const past = readFullExport(decider, decision.id);
		expect(past.record.entries).toHaveLength(5000);
		expect(has(await textOf(past), RECORD_MORE)).toBe(true);
	});

	it('ends a full record whose participant is named in Cyrillic with the one note about "?" (T2)', async () => {
		const { decision, decider } = plain();
		const person = makePerson({ fullName: 'Иван Петров' });
		const participant = makeParticipant(decision, { person });
		makeResponse(participant, { kind: 'vote', optionId: null, comment: 'Mine', round: 1, versionNumber: 1 });

		const text = await textOf(readFullExport(decider, decision.id));
		expect(text).toContain('Comment by ???? ??????');
		// Once, after the closing statement.
		expect(flat(text).split(flat(PDF_REPLACED_NOTE))).toHaveLength(2);
		expect(flat(text).indexOf(flat(PDF_REPLACED_NOTE))).toBeGreaterThan(flat(text).indexOf(flat(FULL_RECORD_CLOSING)));
		// None where every character could be drawn.
		const { decision: other, decider: otherDecider } = plain({ title: 'Ascii only' });
		expect(has(await textOf(readFullExport(otherDecider, other.id)), PDF_REPLACED_NOTE)).toBe(false);
	});
});

// ─── The shareable copy (E5 to E8, E10) ──────────────────────────────────────

describe('the shareable copy', () => {
	it.each([{ state: 'ruled and released' }, { state: 'still open' }])(
		'gives a board reader of a decision $state what every viewer sees, the stored board name, and nothing private (E5)',
		async ({ state }) => {
			const ruled = state === 'ruled and released';
			const { decision } = rich({ ruled });
			const reader = boardReader();
			db.update(boards).set({ name: 'RENAMEDBOARD' }).where(eq(boards.id, board.id)).run();

			const text = await textOf(readShareableExport(reader, decision.id));
			for (const marker of ['TITLEMARK', 'SITUATIONMARK', 'QUESTIONMARK', 'PROMARK', 'AUDIENCEONE', 'AUDIENCEG', 'PROMPTMARK']) expect(text, marker).toContain(marker);
			expect(factOf(text, 'BOARD')).toBe('The board');
			if (ruled) {
				// The ruling: the document's own words, then the option's title in body type after them (card 3077, M1).
				expect(text.split('\n').some((line, i, lines) => line.endsWith(': Option A: ') && lines[i + 1] === 'Plan A')).toBe(true);
				expect(inBlock(text, 'The reason given by', 'REASONMARK')).toBe(true);
				expect(inBlock(text, 'The conditions set by', 'CONDITIONMARK')).toBe(true);
				// Card 3077: the released figures as tiles, a tile's value before its label; no VOTED tile in single mode.
				expect([tileOf(text, 'RESPONDED'), tileOf(text, 'ABSTAINED'), tileOf(text, 'NO CONCERNS'), tileOf(text, 'VOTED')]).toEqual(['withheld', 'withheld', '0', undefined]);
				expect(inBlock(text, 'A comment, released without a name', 'PATCOMMENTMARK')).toBe(true);
			} else {
				expect(text).toContain(RESULTS_NOT_RELEASED);
			}
			for (const never of [
				'RENAMEDBOARD',
				'Pat Person',
				'Quin Person',
				'Ria Person',
				'Sil Person',
				'RIACOMMENTMARK',
				'SURVEYANSWERMARK',
				'OBJECTIONMARK',
				'TALKMARK',
				'REPLYMARK',
				'GROUPMARK',
				'CONCERNMARK',
				'ASKMARK',
				'ANSWERMARK',
				'EARLIERCOMMENTMARK',
				// The ruling's moment (2 Nov 2026, 15:30), the closing time (3 Nov 2026, or 1 Jan 2099 while open), the release's.
				'15:30',
				'3 Nov 2026',
				'1 Jan 2099',
				'2 Nov 2026'
			]) {
				expect(text, never).not.toContain(never);
			}
		}
	);

	it('gives two board readers the same document but the exporter, audiences in stored order, none of a participant’s own parts (E6)', async () => {
		const { decision, group } = rich();
		const member = boardReader('member');
		const person = makePerson({ fullName: 'Member Person', user: member });
		db.insert(peopleGroupMembers).values({ groupId: group.id, personId: person.id }).run();
		const own = makeParticipant(decision, { person, groups: JSON.stringify(['GROUPMARK']) });
		makeResponse(own, { kind: 'vote', optionId: null, comment: 'OWNRESPMARK', round: 2, versionNumber: 2 });
		makeResponse(own, { kind: 'concern', comment: 'OWNCONCERNMARK', round: 2, versionNumber: 2 });
		plantFlag(decision.id, own.id, { kind: 'objection', reason: 'OWNFLAGMARK' });
		const other = boardReader('other');
		// The page itself puts the member's own group's audience first: the copy must not.
		expect(readDecisionPage(member, decision.id).audiences.map((audience) => audience.heading)).toEqual(['AUDIENCEG', 'AUDIENCEONE']);

		const members = await textOf(readShareableExport(member, decision.id));
		const others = await textOf(readShareableExport(other, decision.id));
		expect(withoutExporter(members, member.username)).toEqual(withoutExporter(others, other.username));
		expect(members.indexOf('AUDIENCEONE')).toBeLessThan(members.indexOf('AUDIENCEG'));
		for (const mine of ['OWNRESPMARK', 'OWNCONCERNMARK', 'OWNFLAGMARK', 'Member Person']) expect(members, mine).not.toContain(mine);
	});

	it('says a ruled decision’s results have not been released, with no figure (E7)', async () => {
		const { decision } = plain();
		makeRuling(decision, { optionId: null, reason: 'Nothing fits.' });
		const reader = boardReader();
		const text = await textOf(readShareableExport(reader, decision.id));
		expect(text).toContain(RESULTS_NOT_RELEASED);
		expect(text).not.toMatch(/Responded|Abstained|votes|mean/);
		// Card 3077: nor a figure tile or an options table, whose labels are drawn upper case and headings capitalised.
		expect(text).not.toMatch(/^(RESPONDED|VOTED|ABSTAINED|NO CONCERNS|Votes|Mean)$/m);
	});

	it('shows a survey-only ruling: answers by name in the full record, the questions alone and no count in the shareable copy (E8)', async () => {
		const decider = makeUser({ username: 'surveydecider' });
		addBoardMember(board, decider, 'editor');
		const made = makeDecision({ board, author: decider, decider, title: 'A survey', status: 'closed', closesAt: PAST, openedAt: '2026-11-01 09:00:00' });
		const question = db.insert(decisionSurveyQuestions).values({ decisionId: made.id, position: 0, addedInVersion: 1 }).returning().get();
		makeVersion(made, { situation: 'Tell us', options: [], surveyQuestions: [{ questionId: question.id, kind: 'text', prompt: 'SURVEYPROMPT', help: '', required: true }] }, { number: 1 });
		for (const name of ['Pat', 'Quin', 'Ria']) {
			const { participant } = withAccount(made, name);
			makeResponse(participant, { kind: 'answered', answers: JSON.stringify({ [question.id]: `ANSWEROF${name.toUpperCase()}` }), round: 1, versionNumber: 1 });
		}
		makeRuling(made, { optionId: null, reason: 'Heard.' });

		const full = await textOf(readFullExport(decider, made.id));
		for (const name of ['Pat', 'Quin', 'Ria']) expect(inBlock(full, `Survey answers by ${name} Person`, `SURVEYPROMPT: ANSWEROF${name.toUpperCase()}`), name).toBe(true);

		const shareable = await textOf(readShareableExport(boardReader(), made.id));
		expect(shareable).toContain('SURVEYPROMPT');
		expect(shareable).toContain(NO_OPTIONS_PUT);
		// No count of the three responses: narrowed to counts (card 3077, F2), since the footer's and the band's export
		// day is "3 …" on the 3rd of every month; and no figure tile.
		expect(shareable).not.toMatch(/ANSWEROF|Responded|answered:|\b3 answered\b|: 3\b|\b3 votes?\b|^3$/m);
		expect(tileOf(shareable, 'RESPONDED')).toBeUndefined();
	});

	// Card 2688's code review (S-L2): the shareable copy never names the other decision, whoever exports it; the full
	// record names it where its exporter may view it.
	it('says a decision superseded it, or that it supersedes one, never naming it, the same for an exporter who may view it, and closes saying so (E10)', async () => {
		const { decision, decider } = plain({ title: 'EARLIERTITLE' });
		makeRuling(decision, { optionId: null });
		db.update(decisions).set({ status: 'superseded' }).where(eq(decisions.id, decision.id)).run();
		const elsewhere = makeBoard({ owner, name: 'Elsewhere' }).board;
		const { decision: later } = plain({ title: 'LATERTITLE', board: elsewhere });
		db.update(decisions).set({ supersedesId: decision.id }).where(eq(decisions.id, later.id)).run();
		makeRuling(later, { optionId: null });
		// Each reader may view one board's decision; `both` may view both.
		const reader = boardReader();
		const both = boardReader('both');
		addBoardMember(elsewhere, both, 'viewer');
		const elsewhereReader = makeUser({ username: 'elsewherereader' });
		addBoardMember(elsewhere, elsewhereReader, 'viewer');

		const unseen = await textOf(readShareableExport(reader, decision.id));
		const seen = await textOf(readShareableExport(both, decision.id));
		expect(withoutExporter(seen, both.username)).toEqual(withoutExporter(unseen, reader.username));
		for (const text of [unseen, seen]) {
			expect(text).toContain('Superseded by a later decision');
			expect(text).not.toContain('LATERTITLE');
			expect(has(text, SHAREABLE_CLOSING)).toBe(true);
		}
		const laterUnseen = await textOf(readShareableExport(elsewhereReader, later.id));
		const laterSeen = await textOf(readShareableExport(both, later.id));
		expect(withoutExporter(laterSeen, both.username)).toEqual(withoutExporter(laterUnseen, elsewhereReader.username));
		for (const text of [laterUnseen, laterSeen]) {
			expect(text).toContain('This decision supersedes an earlier decision');
			expect(text).not.toContain('EARLIERTITLE');
		}

		// The full record keeps its exporter's view: the decider, who may not view the later decision, is not told it; an
		// administrator, who may, is.
		const deciders = await textOf(readFullExport(decider, decision.id));
		expect(factOf(deciders, 'SUPERSEDED BY')).toBe('a decision you cannot view');
		expect(deciders).not.toContain('LATERTITLE');
		const admin = makeUser({ role: 'admin', username: 'supersedeadmin' });
		expect(factOf(await textOf(readFullExport(admin, decision.id)), 'SUPERSEDED BY')).toBe('LATERTITLE');
	});

	// Card 2688's code review (S-L3, E-L6): the withdrawal as a day, as every other moment in the shareable copy.
	it('gives a withdrawn decision’s withdrawal as its day alone (S-L3)', async () => {
		const { decision } = plain();
		db.update(decisions).set({ status: 'withdrawn', withdrawnAt: '2026-11-02 14:45:00', withdrawnReason: 'No longer needed.' }).where(eq(decisions.id, decision.id)).run();
		const text = await textOf(readShareableExport(boardReader(), decision.id));
		expect(factOf(text, 'WITHDRAWN')).toBe('2 Nov 2026');
		expect(text.split('\n').filter((line) => /\d{1,2}:\d{2}/.test(line)), 'no time anywhere').toEqual([]);
	});
});

// ─── What both copies are drawn as (E17, E18, E21 to E23) ────────────────────

describe('the drawing', () => {
	it('draws every field at the most it allows: both ends of each section, a person’s text cut, footers on every page, in under 10 seconds (E17)', { timeout: 60_000 }, async () => {
		const longest = (marker: string, n: number) => `${marker}S${'x'.repeat(n - 2 * marker.length - 2)}${marker}E`;
		const decider = makeUser({ username: 'longdecider' });
		addBoardMember(board, decider, 'editor');
		const made = makeDecision({ board, author: decider, decider, title: longest('TTL', 200), status: 'closed', closesAt: PAST, openedAt: '2026-11-01 09:00:00' });
		const a = makeOption(made, { label: 'A', position: 0, addedInVersion: 1 });
		const b = makeOption(made, { label: 'B', position: 1, addedInVersion: 1 });
		const question = db.insert(decisionSurveyQuestions).values({ decisionId: made.id, position: 0, addedInVersion: 1 }).returning().get();
		const sections = { situation: longest('SIT', 20_000), unknowns: longest('UNK', 20_000), alreadyRuled: longest('ALR', 20_000), technicalDetail: longest('TEC', 20_000), ask: longest('ASK', 2000), question: longest('QUE', 500) };
		const options = [a, b].map((option) => ({ optionId: option.id, label: option.label, title: `Plan ${option.label}`, summary: longest(`SU${option.label}`, 4000) }));
		makeVersion(made, { ...sections, options, surveyQuestions: [{ questionId: question.id, kind: 'text', prompt: 'Why?', help: '', required: false }] }, { number: 1 });
		makeVersion(made, { ...sections, options, surveyQuestions: [{ questionId: question.id, kind: 'text', prompt: 'Why?', help: '', required: false }] }, { number: 2, asksAgain: false, changeNote: longest('CHN', 2000) });
		const people = ['Pat', 'Quin', 'Ria'].map((name) => withAccount(made, name));
		for (const { participant } of people) {
			makeResponse(participant, {
				kind: 'vote',
				optionId: a.id,
				comment: longest('CMT', 4000),
				optionComments: JSON.stringify({ [a.id]: longest('OPA', 2000), [b.id]: longest('OPB', 2000) }),
				answers: JSON.stringify({ [question.id]: longest('ANS', 2000) }),
				round: 1,
				versionNumber: 1
			});
		}
		plantFlag(made.id, people[0].participant.id, { kind: 'objection', reason: longest('OBJ', 4000), reply: longest('RPL', 4000), versionNumber: 1 });
		makeRuling(made, { optionId: a.id, reason: longest('RSN', 4000), conditions: longest('CND', 4000) });

		const started = performance.now();
		const full = await generateDecisionPdf(readFullExport(decider, made.id));
		const shareable = await generateDecisionPdf(readShareableExport(boardReader(), made.id));
		const took = performance.now() - started;
		console.log(`E17: the full record ${full.pages} pages, ${full.pdf.length} bytes; the shareable copy ${shareable.pages} pages, ${shareable.pdf.length} bytes; ${Math.round(took)} ms`);
		expect(took).toBeLessThan(10_000);

		const fullText = pdfText(full.pdf);
		const shareableText = pdfText(shareable.pdf);
		// Each page's band and footer, drawn in the last pass, are read after that page's content: taken out, so that a
		// marker a page break splits is read whole (card 3077).
		const body = (text: string) => text.split('\n').filter((line) => !(PRIVATE_BAND as readonly string[]).includes(line) && !/ · page \d+ of \d+$/.test(line)).join('\n');
		for (const text of [body(fullText), body(shareableText)]) {
			for (const marker of ['TTL', 'SIT', 'UNK', 'ALR', 'TEC', 'ASK', 'QUE', 'SUA', 'SUB', 'RSN', 'CND']) {
				expect(flat(text), `${marker} start`).toContain(`${marker}S`);
				expect(flat(text), `${marker} end`).toContain(`${marker}E`);
			}
		}
		expect(flat(fullText)).toContain('CHNE');
		// A person's own text: its start, never its end, and the cut line after it (R3.6).
		for (const marker of ['CMT', 'OPA', 'OPB', 'ANS', 'OBJ', 'RPL']) {
			expect(flat(fullText), `${marker} start`).toContain(`${marker}S`);
			expect(flat(fullText), `${marker} end`).not.toContain(`${marker}E`);
		}
		expect(fullText.split('\n').filter((line) => line === TEXT_CUT).length).toBeGreaterThanOrEqual(3 * 4 + 2);
		expect(flat(fullText)).toContain(flat(`CMTS${'x'.repeat(PDF_TEXT_MOST - 4)}${TEXT_CUT}`));

		for (const [made_, text, copy] of [
			[full, fullText, 'Full record'],
			[shareable, shareableText, 'Shareable copy']
		] as const) {
			expect(made_.pages).toBeGreaterThan(1);
			for (let page = 1; page <= made_.pages; page++) {
				expect(text, `${copy} page ${page}`).toContain(`${copy} · Decision #${made.id} · exported by`);
				expect(text, `${copy} page ${page}`).toMatch(new RegExp(` · page ${page} of ${made_.pages}$`, 'm'));
			}
		}
	});

	it('draws a comment that reads as a ruling only inside its labelled block, and the document’s ruling heading once (E18)', async () => {
		const { decision, decider } = rich({ quinComment: 'RULING: Option B' });
		for (const text of [await textOf(readFullExport(decider, decision.id)), await textOf(readShareableExport(boardReader(), decision.id))]) {
			const lines = text.split('\n');
			const at = lines.flatMap((line, i) => (line.includes('RULING: Option B') ? [i] : []));
			expect(at.length).toBeGreaterThan(0);
			for (const i of at) {
				expect(lines[i]).toBe('RULING: Option B');
				expect(lines[i - 1]).toMatch(/^(Comment by Quin Person|A comment, released without a name)$/);
			}
			expect(lines.filter((line) => line === 'The ruling')).toHaveLength(1);
		}
	});

	it('draws the full record of 5,000 participants, each with a realistic response, and 5,000 record entries, within its measured bounds (E21)', { timeout: 180_000 }, async () => {
		const { decision, decider, a, b, question } = (() => {
			const made = plain();
			const second = makeOption(made.decision, { label: 'B', position: 1, addedInVersion: 1 });
			const asked = db.insert(decisionSurveyQuestions).values({ decisionId: made.decision.id, position: 0, addedInVersion: 1 }).returning().get();
			const asked2 = db.insert(decisionSurveyQuestions).values({ decisionId: made.decision.id, position: 1, addedInVersion: 1 }).returning().get();
			makeVersion(
				made.decision,
				{
					situation: 'Many people',
					options: [
						{ optionId: made.a.id, label: 'A', title: 'Plan A' },
						{ optionId: second.id, label: 'B', title: 'Plan B' }
					],
					surveyQuestions: [
						{ questionId: asked.id, kind: 'text', prompt: 'Why?', help: '', required: false },
						{ questionId: asked2.id, kind: 'text', prompt: 'What else?', help: '', required: false }
					]
				},
				{ number: 2 }
			);
			return { ...made, b: second, question: [asked.id, asked2.id] };
		})();
		const words = (n: number, seed: number) => {
			let out = '';
			for (let i = 0; out.length < n; i++) out += `${['plan', 'cost', 'team', 'time', 'risk', 'value'][(seed + i) % 6]}${i % 7} `;
			return out.slice(0, n);
		};
		const participant = sqlite.prepare(
			"INSERT INTO decision_participants (decision_id, person_id, role, name, email, job_title, groups, included_at, user_id) VALUES (?, NULL, 'consulted', ?, ?, '', ?, '2026-11-01 09:00:00', NULL)"
		);
		const response = sqlite.prepare(
			"INSERT INTO decision_responses (decision_id, participant_id, version_number, round, kind, option_id, comment, option_comments, answers, via, created_at) VALUES (?, ?, 2, 2, 'vote', ?, ?, ?, ?, 'session', '2026-11-01 10:00:00')"
		);
		const event = sqlite.prepare(
			"INSERT INTO decision_events (decision_id, participant_id, kind, version_number, detail, actor_user_id, actor_name, source, created_at) VALUES (?, ?, 'seen', 2, ?, NULL, 'DumpFire', 'system', '2026-11-01 10:00:00')"
		);
		sqlite.transaction(() => {
			for (let i = 0; i < 5000; i++) {
				const id = Number(participant.run(decision.id, `Participant ${i}`, `p${i}@example.test`, JSON.stringify([`Group ${i % 12}`])).lastInsertRowid);
				response.run(
					decision.id,
					id,
					i % 2 === 0 ? a.id : b.id,
					words(300, i),
					JSON.stringify({ [a.id]: words(150, i + 1), [b.id]: words(150, i + 2) }),
					JSON.stringify({ [question[0]]: words(100, i + 3), [question[1]]: words(100, i + 4) })
				);
				event.run(decision.id, id, JSON.stringify({ stage: 'question' }));
			}
		})();
		expect(eventCount(decision.id)).toBe(5000);

		// Memory as the process holds it (resident), which a collection mid-drawing cannot make read lower than it was.
		const memoryBefore = process.memoryUsage().rss;
		const started = performance.now();
		const exported = readFullExport(decider, decision.id);
		const read = performance.now();
		// F2: the longest the event loop waited while the PDF was drawn (the read before it is one transaction, and not
		// measured), sampled every 10 ms.
		const loop = monitorEventLoopDelay({ resolution: 10 });
		loop.enable();
		// Its first sample only marks where it starts: taken before the drawing, so that a stretch from the drawing's start counts.
		await new Promise((resolve) => setTimeout(resolve, 30));
		const drawingFrom = performance.now();
		const drawn = await generateDecisionPdf(exported);
		const finished = performance.now();
		// The sampling timer fires once more before it is read, so that a stretch the drawing held to its end is counted.
		await new Promise((resolve) => setTimeout(resolve, 30));
		loop.disable();
		const seconds = (finished - started - (drawingFrom - read)) / 1000;
		const drawingSeconds = (finished - drawingFrom) / 1000;
		const longestMs = loop.max / 1e6;
		const heapMb = (process.memoryUsage().rss - memoryBefore) / (1024 * 1024);
		console.log(
			`E21: 5,000 participants and 5,000 record entries read and drawn in ${seconds.toFixed(1)} s (drawn in ${drawingSeconds.toFixed(1)} s), ` +
				`the event loop held at most ${longestMs.toFixed(0)} ms, memory grown ${heapMb.toFixed(0)} MB, ` +
				`${drawn.pages} pages, ${(drawn.pdf.length / (1024 * 1024)).toFixed(1)} MB, stopped at the ceiling: ${drawn.stopped}`
		);
		expect(exported.results.current.rows).toHaveLength(5000);
		expect(exported.record.entries).toHaveLength(5000);
		// Bounds set at build from the first measured run (section 9, E21), at twice its figures.
		expect(seconds).toBeLessThan(E21_SECONDS);
		expect(heapMb).toBeLessThan(E21_HEAP_MB);
		// F2: no stretch of the drawing held other requests for 200 ms.
		expect(longestMs).toBeLessThan(200);
		// F2: 500 responses by name and a line for the rest, so the record, last, is drawn whole within the ceiling.
		expect(drawn.stopped).toBe(false);
		expect(drawn.pages).toBeLessThanOrEqual(PDF_PAGE_CEILING);
		const text = pdfText(drawn.pdf);
		expect(text.split('\n').filter((line) => /^Participant \d+ \(Group \d+\)$/.test(line))).toHaveLength(RESPONSES_MOST);
		expect(has(text, responsesHeldWords(4500))).toBe(true);
		expect(text.split('\n').filter((line) => line.includes(`  ·  ${eventWords('seen')}  ·  `))).toHaveLength(5000);
	});

	it('stops a full record of 5,000 participants with every text at its limit at the ceiling, with its line and every footer (E22)', { timeout: 180_000 }, async () => {
		const { decision, decider } = plain();
		const exported = atTheLimit(readFullExport(decider, decision.id));

		const drawn = await generateDecisionPdf(exported);
		const text = pdfText(drawn.pdf);
		console.log(`E22: ${drawn.pages} pages, ${(drawn.pdf.length / (1024 * 1024)).toFixed(1)} MB`);
		expect(drawn.stopped).toBe(true);
		expect(drawn.pages).toBeLessThanOrEqual(PDF_PAGE_CEILING);
		expect(drawn.pages).toBeGreaterThan(PDF_PAGE_CEILING - 10);
		expect(drawn.pdf.length).toBeLessThanOrEqual(PDF_BYTE_CEILING);
		expect(has(text, PDF_CEILING_LINE)).toBe(true);
		expect(flat(text).indexOf(flat(PDF_CEILING_LINE))).toBeLessThan(flat(text).indexOf(flat(FULL_RECORD_CLOSING)));
		// F2: stopped among the objections, so neither the responses nor the record were reached.
		expect(text).not.toContain('Responses, by name');
		const footers = text.split('\n').filter((line) => line.startsWith(`Full record · Decision #${decision.id} · exported by`));
		expect(footers).toHaveLength(drawn.pages);
		footers.forEach((line, i) => expect(line).toMatch(new RegExp(` · page ${i + 1} of ${drawn.pages}$`)));
	});

	it('stops at the byte ceiling on its own, well short of the page ceiling, with its line and every footer (E25)', { timeout: 180_000 }, async () => {
		const { decision, decider } = plain();
		const exported = atTheLimit(readFullExport(decider, decision.id));
		const bytes = 400 * 1024;

		const drawn = await generateDecisionPdf(exported, { pages: PDF_PAGE_CEILING, bytes });
		const text = pdfText(drawn.pdf);
		console.log(`E25: ${drawn.pages} pages, ${drawn.pdf.length} bytes`);
		expect(drawn.stopped).toBe(true);
		expect(drawn.pdf.length).toBeLessThanOrEqual(bytes);
		expect(drawn.pages).toBeLessThan(PDF_PAGE_CEILING / 4);
		expect(has(text, PDF_CEILING_LINE)).toBe(true);
		expect(has(text, FULL_RECORD_CLOSING)).toBe(true);
		const footers = text.split('\n').filter((line) => line.startsWith(`Full record · Decision #${decision.id} · exported by`));
		expect(footers).toHaveLength(drawn.pages);
	});

	it('draws the private band on every page of a full record, and on no page of a shareable copy (E24)', async () => {
		const decider = makeUser({ username: 'banddecider' });
		addBoardMember(board, decider, 'editor');
		const made = makeDecision({ board, author: decider, decider, title: 'Banded', status: 'open', closesAt: FUTURE, openedAt: '2026-11-01 09:00:00' });
		const a = makeOption(made, { label: 'A', position: 0, addedInVersion: 1 });
		makeVersion(made, { situation: 'Long. '.repeat(3000), options: [{ optionId: a.id, label: 'A', title: 'Plan A' }] }, { number: 1 });

		const full = await generateDecisionPdf(readFullExport(decider, made.id));
		const shareable = await generateDecisionPdf(readShareableExport(boardReader(), made.id));
		expect(full.pages).toBeGreaterThan(2);
		expect(shareable.pages).toBeGreaterThan(2);
		for (const line of PRIVATE_BAND) {
			expect(pdfText(full.pdf).split('\n').filter((shown) => shown === line), line).toHaveLength(full.pages);
			expect(pdfText(shareable.pdf), line).not.toContain(line);
		}
	});

	it.each([
		{ copy: 'full' as const, set: 'title' as const },
		{ copy: 'full' as const, set: 'exporter' as const },
		{ copy: 'shareable' as const, set: 'title' as const },
		{ copy: 'shareable' as const, set: 'exporter' as const }
	])('ends the $copy copy with the one note about "?" where only the $set could not be drawn (T3)', async ({ copy, set }) => {
		const { decision, decider } = plain({ title: 'Ascii title' });
		const exported = copy === 'full' ? readFullExport(decider, decision.id) : readShareableExport(decider, decision.id);
		const changed: DecisionExport =
			set === 'title' ? { ...exported, decision: { ...exported.decision, title: 'Решение' } } as DecisionExport : { ...exported, exporter: { ...exported.exporter, name: 'Иван' } };

		const text = await textOf(changed);
		expect(text).toContain(set === 'title' ? '???????' : 'exported by ???? on');
		expect(flat(text).split(flat(PDF_REPLACED_NOTE))).toHaveLength(2);
		expect(has(await textOf(exported), PDF_REPLACED_NOTE), 'none for the same copy all in ASCII').toBe(false);
	});

	it.each([
		// A literal string escapes its parentheses.
		{ copy: 'full' as const, title: (id: number, t: string) => `Decision #${id}: ${t} \\(private record\\)` },
		{ copy: 'shareable' as const, title: (id: number, t: string) => `Decision #${id}: ${t}` }
	])('sets the $copy PDF’s information itself: its title, DumpFire, no subject or keywords, the export day at midnight (E23)', async ({ copy, title }) => {
		const { decision, decider } = plain({ title: 'Info title' });
		const exported = copy === 'full' ? readFullExport(decider, decision.id) : readShareableExport(decider, decision.id);
		const { pdf } = await generateDecisionPdf(exported);
		const bytes = pdf.toString('latin1');
		const day = exported.exporter.date;

		expect(bytes).toContain(`(${title(decision.id, 'Info title')})`);
		if (copy === 'shareable') expect(bytes).not.toContain('private record');
		expect(bytes).toContain('(DumpFire)');
		expect(bytes).not.toContain('PDFKit');
		expect(bytes).not.toMatch(/\/Subject|\/Keywords/);
		expect(bytes).toContain(`(D:${day.replaceAll('-', '')}000000Z)`);
		// The footer gives the day alone, no time.
		const [y, m, d] = day.split('-').map(Number);
		const shown = `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
		// Card 3077: the full record of a plain decision now runs past one page; the footer's form is what is guarded.
		expect(pdfText(pdf)).toMatch(new RegExp(`exported by ${decider.username} on ${shown} · page 1 of \\d+$`, 'm'));
		expect(pdfText(pdf)).not.toMatch(/exported by .* \d{2}:\d{2}/);
	});

	// Card 2688's code review (S-L1): a value drawn as a line or a label of the document's own is one line.
	it('draws a board’s name and a person’s name written over several lines each on one line, and keeps the line breaks of their words (S-L1)', async () => {
		const { decision, decider } = plain();
		db.update(decisions).set({ boardName: 'BOARDONE\nBOARDTWO' }).where(eq(decisions.id, decision.id)).run();
		const participant = makeParticipant(decision, { name: 'NAMEONE\n\tNAMETWO', groups: JSON.stringify(['GROUPONE\nGROUPTWO']) });
		makeResponse(participant, { kind: 'vote', optionId: null, comment: 'WORDSONE\nWORDSTWO', round: 1, versionNumber: 1 });

		const lines = pdfText((await generateDecisionPdf(readFullExport(decider, decision.id))).pdf).split('\n');
		expect(factOf(lines.join('\n'), 'BOARD')).toBe('BOARDONE BOARDTWO');
		expect(lines).toContain('NAMEONE NAMETWO (GROUPONE GROUPTWO)');
		expect(lines).toContain('Comment by NAMEONE NAMETWO');
		expect(lines.some((line) => /^(NAMETWO|BOARDTWO|GROUPTWO)\b/.test(line)), 'no value begins a line of its own').toBe(false);
		// The person's own words keep theirs.
		expect(lines).toContain('WORDSONE');
		expect(lines).toContain('WORDSTWO');
		const shareable = pdfText((await generateDecisionPdf(readShareableExport(boardReader(), decision.id))).pdf).split('\n');
		expect(factOf(shareable.join('\n'), 'BOARD')).toBe('BOARDONE BOARDTWO');
	});

	// Card 2688's code review (E-L1): a piece is held to its lines as well as its characters, so the page ceiling holds.
	it('stops a record of text made mostly of line breaks at or under the page ceiling (E-L1)', { timeout: 180_000 }, async () => {
		const { decision, decider } = plain();
		const base = readFullExport(decider, decision.id);
		const exported: FullExport = { ...base, version: { ...base.version!, content: { ...base.version!.content, situation: `x${'\n'.repeat(400_000)}x` } } };

		const drawn = await generateDecisionPdf(exported);
		console.log(`E-L1: ${drawn.pages} pages, ${drawn.pdf.length} bytes`);		expect(drawn.stopped).toBe(true);
		expect(drawn.pages).toBeLessThanOrEqual(PDF_PAGE_CEILING);
		expect(has(pdfText(drawn.pdf), PDF_CEILING_LINE)).toBe(true);
	});

	// Card 2688's code review (E-M1): a removed participant's latest, past the responses the full record lists by name.
	it('says a removed participant’s latest response is on the results page once 500 responses are listed (E-M1)', async () => {
		const { decision, decider } = plain();
		const base = readFullExport(decider, decision.id);
		const row = (i: number, name: string): ResultRow => ({
			participantId: i + 1,
			name,
			role: 'consulted',
			groups: [],
			kind: 'vote',
			optionId: null,
			scores: null,
			comment: '',
			optionComments: {},
			answers: {},
			versionNumber: 1,
			createdAt: '2026-11-01 10:00:00',
			via: 'session',
			changes: 0
		});
		const exported: FullExport = {
			...base,
			results: {
				...base.results,
				current: { ...base.results.current, responded: RESPONSES_MOST, rows: Array.from({ length: RESPONSES_MOST }, (_, i) => row(i, `Participant ${i}`)) },
				removed: [{ name: 'Removed Person', role: 'consulted', latest: row(RESPONSES_MOST, 'Removed Person') }]
			}
		};

		const lines = pdfText((await generateDecisionPdf(exported)).pdf).split('\n');
		expect(lines).toContain(`Removed Person, consulted: ${REMOVED_RESPONSE_HELD}`);
		expect(lines.filter((line) => /^Participant \d+$/.test(line))).toHaveLength(RESPONSES_MOST);
	});
});

// ─── The layout (card 3077: N1 to N7) ────────────────────────────────────────

describe('the layout (card 3077)', () => {
	/** A day as the PDF writes it, `25 Nov 2026`. */
	const dayWords = (day: string) => {
		const [y, m, d] = day.split('-').map(Number);
		return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
	};

	/** The text page by page: each page's lines up to and including its footer. */
	const pagesOf = (text: string) =>
		text.split(/^.* · page \d+ of \d+$/m).slice(0, -1).map((page) => page.split('\n').filter((line) => line !== ''));

	it.each([{ copy: 'full' as const }, { copy: 'shareable' as const }])(
		'opens page 1 of the $copy copy with the header band, once whatever its pages, and gives the full record alone its author, opening and closing (N1)',
		async ({ copy }) => {
			const { decision, decider } = rich();
			const exported = copy === 'full' ? readFullExport(decider, decision.id) : readShareableExport(boardReader(), decision.id);
			const { pdf, pages } = await generateDecisionPdf(exported);
			const text = pdfText(pdf);
			const band = [
				`Decision #${decision.id}`,
				copy === 'full' ? 'Full record' : 'Shareable copy',
				`The board  ·  ${STATUS_WORDS[exported.decision.shownStatus]}`,
				`Exported ${dayWords(exported.exporter.date)}`
			];
			expect(pages).toBeGreaterThan(1);
			expect(text.split('\n').slice(0, 4)).toEqual(band);
			for (const line of band) expect(text.split('\n').filter((shown) => shown === line), line).toHaveLength(1);
			for (const label of ['AUTHOR', 'OPENED', 'CLOSES']) {
				if (copy === 'full') expect(factOf(text, label), label).toMatch(label === 'AUTHOR' ? /^author\d+$/ : / UTC$/);
				else expect(factOf(text, label), label).toBeUndefined();
			}
			// R7 (card 3077's code review, M1): the ruling's own words in bold, the option's title after them, a person's
			// words, in regular body type.
			const fonts = shownFonts(pdf);
			const ruling = fonts.findIndex((shown) => shown.text.startsWith('Ruled by ') && shown.text.endsWith(': Option A: '));
			expect(ruling, 'the ruling sentence').toBeGreaterThan(-1);
			expect(fonts[ruling].font).toBe('Helvetica-Bold');
			expect(fonts[ruling + 1]).toEqual({ text: 'Plan A', font: 'Helvetica' });
			expect(fonts.filter((shown) => shown.text.includes('Plan A') && shown.font !== 'Helvetica'), 'the title never in bold').toEqual([]);
		}
	);

	it('cuts a 200-character board name with "..." on the header band’s one line, the status kept, the whole name in its fact (card 3077’s code review)', async () => {
		const { decision, decider } = plain();
		const name = Array.from({ length: 20 }, (_, i) => `Board${String(i).padStart(4, '0')}`).join(' ');
		expect(name.length).toBeGreaterThanOrEqual(199);
		db.update(decisions).set({ boardName: name }).where(eq(decisions.id, decision.id)).run();
		for (const exported of [readFullExport(decider, decision.id), readShareableExport(boardReader(), decision.id)]) {
			const lines = (await textOf(exported)).split('\n');
			expect(lines[2]).toMatch(/^Board0000 .*\.\.\.  ·  Open$/);
			expect(lines[2].length).toBeLessThan(name.length);
			expect(lines[3]).toMatch(/^Exported /);
			expect(has(lines.slice(lines.indexOf('BOARD') + 1, lines.indexOf('BOARD') + 5).join(' '), name), 'the whole name in its fact').toBe(true);
		}
	});

	it('gives each option’s label, title and votes in the round’s table, and the released table the same with "withheld" (N2)', async () => {
		const { decision, decider } = rich();
		const text = await textOf(readFullExport(decider, decision.id));
		expect(hasRow(text, ['Option', 'Title', 'Votes'])).toBe(true);
		expect(hasRow(text, ['A', 'Plan A', '2']), 'the current round').toBe(true);
		expect(hasRow(text, ['A', 'Plan A', 'withheld']), 'the release').toBe(true);
		expect(text).not.toMatch(/withheld votes/);
		// What a withheld cell means, once, under the released table that draws one.
		expect(text.split('\n').filter((line) => line === 'withheld: too few to show without singling someone out')).toHaveLength(1);
		expect(text).toContain('1 comment left out.');
		const { decision: none, decider: noneDecider } = plain();
		makeResponse(withAccount(none, 'Una').participant, { kind: 'vote', optionId: null, comment: '', round: 1, versionNumber: 1 });
		makeRuling(none, { optionId: null, reason: 'Nothing fits.' });
		release(none, noneDecider, []);
		expect(await textOf(readFullExport(noneDecider, none.id))).toContain('no comments left out.');
	});

	it('gives a scored decision’s total and mean in a table headed Total and Mean, and its released VOTED tile and Mean (N3)', async () => {
		const { decision, decider, a, b } = rich();
		const base = readFullExport(decider, decision.id);
		const exported: FullExport = {
			...base,
			decision: { ...base.decision, voteMode: 'score' },
			results: {
				...base.results,
				current: {
					...base.results.current,
					scores: [
						{ optionId: a.id, total: 17, mean: 4.3 },
						{ optionId: b.id, total: 6, mean: null }
					]
				}
			},
			released: {
				...base.released!,
				voteMode: 'score',
				voted: 4,
				options: base.released!.options.map((option) => ({ ...option, votes: null, mean: option.label === 'A' ? 4.3 : null }))
			}
		};
		const text = await textOf(exported);
		expect(hasRow(text, ['Option', 'Title', 'Total', 'Mean'])).toBe(true);
		expect(hasRow(text, ['A', 'Plan A', '17', '4.3'])).toBe(true);
		expect(hasRow(text, ['B', 'Plan B', '6', 'none'])).toBe(true);
		expect(tileOf(text, 'VOTED'), 'the released VOTED tile, the first VOTED drawn').toBe('4');
		expect(hasRow(text, ['Option', 'Title', 'Mean'])).toBe(true);
		expect(hasRow(text, ['A', 'Plan A', '4.3'])).toBe(true);
		expect(hasRow(text, ['B', 'Plan B', 'withheld'])).toBe(true);
	});

	it('gives a choice question’s count for each choice and a scale question’s count for each value and its mean, in tables (N4)', async () => {
		const { decision, decider } = rich();
		const base = readFullExport(decider, decision.id);
		const exported: FullExport = {
			...base,
			results: {
				...base.results,
				current: {
					...base.results.current,
					survey: [
						{
							versionNumber: 2,
							questions: [
								{ questionId: 1, kind: 'choice', prompt: 'CHOICEPROMPT', answered: 3, choices: [{ choice: 'Leeds', count: 2 }, { choice: 'York', count: 1 }], scale: null },
								{
									questionId: 2,
									kind: 'scale',
									prompt: 'SCALEPROMPT',
									answered: 3,
									choices: null,
									scale: { max: 3, lowLabel: 'Never', highLabel: 'Always', counts: [{ value: 1, count: 0 }, { value: 2, count: 1 }, { value: 3, count: 2 }], mean: 2.7 }
								}
							]
						}
					]
				}
			}
		};
		const text = await textOf(exported);
		expect(inBlock(text, 'Survey question 1 as version 2 asked it: 3 answered', 'CHOICEPROMPT')).toBe(true);
		expect(hasRow(text, ['Choice', 'Count', 'Leeds', '2', 'York', '1'])).toBe(true);
		expect(inBlock(text, 'Survey question 2 as version 2 asked it: 3 answered', 'SCALEPROMPT')).toBe(true);
		expect(hasRow(text, ['Value', 'Count', '1', '0', '2', '1', '3', '2', 'Mean 2.7'])).toBe(true);
	});

	/** A group breakdown of `n` groups, GRP0 to GRP<n-1>, on `base`. */
	const withGroups = (base: FullExport, n: number): FullExport => ({
		...base,
		results: {
			...base.results,
			groupBreakdown: Array.from({ length: n }, (_, i) => ({
				name: `GRP${i}`,
				consulted: 3,
				responded: 2,
				voted: 2,
				votes: [{ optionId: base.results.options[0].optionId, count: 2 }],
				scores: [],
				abstained: 0,
				noConcerns: 0,
				mostChosen: []
			}))
		}
	});

	it('draws the group table’s header row again on every page it runs onto (N5)', async () => {
		const { decision, decider } = plain();
		const text = await textOf(withGroups(readFullExport(decider, decision.id), 120));
		const covered = pagesOf(text).filter((page) => page.some((line) => /^GRP\d+$/.test(line)));
		expect(covered.length).toBeGreaterThan(1);
		for (const page of covered) {
			const header = page.indexOf('Group');
			expect(header, 'the header on the page').toBeGreaterThan(-1);
			expect(page.slice(header, header + 7)).toEqual(['Group', 'Consulted', 'Responded', 'Voted', 'Abstained', 'No concerns', 'Votes by option']);
			expect(page.findIndex((line) => /^GRP\d+$/.test(line)), 'before its rows').toBeGreaterThan(header);
		}
		expect(text.split('\n').filter((line) => /^GRP\d+$/.test(line))).toHaveLength(120);
	});

	it('stops a full record of 5,000 groups inside the group table at a low byte ceiling, with its line, under both ceilings, every footer drawn (N6)', { timeout: 120_000 }, async () => {
		const { decision, decider } = plain();
		const bytes = 160 * 1024;
		const drawn = await generateDecisionPdf(withGroups(readFullExport(decider, decision.id), 5000), { pages: PDF_PAGE_CEILING, bytes });
		const text = pdfText(drawn.pdf);
		const lines = text.split('\n');
		expect(drawn.stopped).toBe(true);
		expect(drawn.pdf.length).toBeLessThanOrEqual(bytes);
		expect(drawn.pages).toBeLessThan(PDF_PAGE_CEILING);
		expect(lines).toContain('GRP0');
		expect(lines).not.toContain('GRP4999');
		const ceiling = lines.indexOf(PDF_CEILING_LINE);
		expect(ceiling).toBeGreaterThan(lines.indexOf('GRP0'));
		expect(lines, 'nothing drawn after the table').not.toContain('Responses, by name');
		expect(has(text, FULL_RECORD_CLOSING)).toBe(true);
		const footers = lines.filter((line) => line.startsWith(`Full record · Decision #${decision.id} · exported by`));
		expect(footers).toHaveLength(drawn.pages);
		footers.forEach((line, i) => expect(line).toMatch(new RegExp(` · page ${i + 1} of ${drawn.pages}$`)));
	});

	it('reads "none" for a record entry whose detail holds an empty list, as the record view does (N7, F1)', async () => {
		const { decision, decider } = plain();
		appendEvent({ decisionId: decision.id, kind: 'results_released', versionNumber: 1, detail: { upToResponseId: 1, omitted: [] } }, { userId: decider.id, name: decider.username, source: 'ui' });
		const lines = (await textOf(readFullExport(decider, decision.id))).split('\n');
		expect(lines).toContain(`${detailWords('omitted')}: none`);
		expect(lines).not.toContain(`${detailWords('omitted')}: `);
	});
});

// ─── The route, POST /api/decisions/[id]/pdf (E13 to E15, E20) ───────────────

describe('the route', () => {
	// The first request through the harness starts SvelteKit's server for this file, as the other gate files warm it.
	beforeAll(async () => {
		await gateRoutes();
	}, 60_000);

	const path =(decisionId: number) => `/api/decisions/${decisionId}/pdf`;
	const allowance = (user: SessionUser) => allowanceState(exportAllowanceKey(user.id), EXPORTS_AN_HOUR, EXPORT_WINDOW_MS, Date.now());

	it('refuses the 21st export in an hour, both copies counted together, 429 naming the time, before anything is read or written (E13)', { timeout: 120_000 }, async () => {
		const { decision, decider } = plain();
		for (let i = 0; i < EXPORTS_AN_HOUR; i++) {
			const res = await api('POST', path(decision.id), { user: decider, body: { copy: i % 2 === 0 ? 'full' : 'shareable' } });
			expect(res.status, `export ${i + 1}`).toBe(200);
		}
		expect(allowance(decider).used).toBe(EXPORTS_AN_HOUR);
		const before = eventCount(decision.id);

		for (const copy of ['full', 'shareable']) {
			const res = await api('POST', path(decision.id), { user: decider, body: { copy } });
			expect(res.status, copy).toBe(429);
			expect(res.body.message).toMatch(/^You have exported 20 decisions in the last hour: the next can be exported from \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
		}
		// Before any read: a decision the caller cannot view is answered 429, not 404.
		const elsewhere = makeBoard({ owner, name: 'Elsewhere' }).board;
		const { decision: unseen } = plain({ board: elsewhere });
		expect((await api('POST', path(unseen.id), { user: decider, body: { copy: 'shareable' } })).status).toBe(429);
		expect(eventCount(decision.id), 'no entry').toBe(before);
		expect(inFlightAt(DRAWING_KEY), 'the drawing place given back').toBe(0);
	});

	it.each([
		{ sent: {}, message: 'copy is required' },
		{ sent: { copy: 'summary' }, message: 'copy must be one of: full, shareable' }
	])('refuses $sent, 400 naming the field, and counts nothing (E14)', async ({ sent, message }) => {
		const { decision, decider } = plain();
		const before = eventCount(decision.id);
		const res = await api('POST', path(decision.id), { user: decider, body: sent });
		expect({ status: res.status, message: res.body.message }).toEqual({ status: 400, message });
		expect(allowance(decider).used).toBe(0);
		expect(eventCount(decision.id)).toBe(before);
		expect(inFlightAt(DRAWING_KEY)).toBe(0);
	});

	it('answers a PDF as an attachment named by the decision, the copy and the UTC day, cached nowhere (E15)', { timeout: 60_000 }, async () => {
		const { decision, decider } = plain({ title: 'Café & Crème: Plan #2!' });
		const reader = boardReader();
		const day = stamp().slice(0, 10);
		for (const [user, copy, name] of [
			[decider, 'full', `decision-${decision.id}-cafe-creme-plan-2-full-record-${day}.pdf`],
			[reader, 'shareable', `decision-${decision.id}-cafe-creme-plan-2-shareable-${day}.pdf`]
		] as const) {
			const res = await gate('POST', path(decision.id), {
				headers: { accept: '*/*', 'sec-fetch-site': 'same-origin', cookie: `${SESSION_COOKIE_NAME}=${makeSession(user)}` },
				body: { copy }
			});
			const pdf = Buffer.from(await res.arrayBuffer());
			expect(res.status, copy).toBe(200);
			expect(res.headers.get('content-type')).toBe('application/pdf');
			expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${name}"`);
			expect(res.headers.get('content-length')).toBe(String(pdf.length));
			expect(res.headers.get('cache-control')).toBe('no-store');
			expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
			expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
			expect(pdfText(pdf)).toContain(copy === 'full' ? 'Full record · Decision #' : 'Shareable copy · Decision #');
		}
	});

	it('answers 503 with Retry-After while another export holds the drawing place, counting nothing, and 200 once it is given back, logged without its title (E20)', async () => {
		const { decision, decider } = plain({ title: 'LOGTITLEMARK' });
		const token = enterInFlight(DRAWING_KEY, 1)!;
		const before = eventCount(decision.id);

		const busy = await api('POST', path(decision.id), { user: decider, body: { copy: 'full' } });
		expect({ status: busy.status, body: busy.body, retryAfter: busy.headers.get('retry-after') }).toEqual({ status: 503, body: { message: EXPORT_BUSY }, retryAfter: '10' });
		expect(allowance(decider).used, 'the hour untouched').toBe(0);
		expect(eventCount(decision.id)).toBe(before);
		expect(inFlightAt(DRAWING_KEY), 'the other export still holds it').toBe(1);

		leaveInFlight(DRAWING_KEY, token);
		// Card 2688's code review (E-L7): the one INFO line names the decision by its id, never by its title (R15).
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'INFO';
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const logged: LogEntry[] = [];
		const stop = subscribeToLogs((entry) => logged.push(entry));
		let free: Awaited<ReturnType<typeof api>>;
		try {
			free = await api('POST', path(decision.id), { user: decider, body: { copy: 'full' } });
		} finally {
			stop();
			vi.restoreAllMocks();
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
		expect(free.status).toBe(200);
		expect(allowance(decider).used).toBe(1);
		expect(eventCount(decision.id)).toBe(before + 1);
		expect(inFlightAt(DRAWING_KEY)).toBe(0);
		const line = logged.filter((entry) => entry.context === 'DECISIONS' && entry.message.startsWith(`Decision ${decision.id} exported as a PDF`));
		expect(line).toHaveLength(1);
		expect(JSON.stringify(line), 'no title in the line or its fields').not.toContain('LOGTITLEMARK');
	});

	// Card 2688's code review (S-M1): the body is read before the drawing place is taken, under a deadline.
	it('lets a second account export while another’s body is still on its way, and answers that one 408 once its deadline passes, nothing counted (S-M1)', { timeout: 60_000 }, async () => {
		const { decision, decider } = plain();
		const reader = boardReader();
		let sent = false;
		let asked!: () => void;
		const wasAsked = new Promise<void>((resolve) => (asked = resolve));
		// Part of the body, and then nothing, as a sender that trickles it.
		const stalled = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent) return;
				sent = true;
				controller.enqueue(new TextEncoder().encode('{"copy":'));
				asked();
			}
		});
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const first = gate('POST', path(decision.id), {
				headers: { accept: '*/*', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${makeSession(decider)}` },
				body: stalled
			});
			await wasAsked;
			// The stream is pulled as soon as it is made: the handler is reading it once its deadline is set, the one
			// timer, which may wait on the route's first load.
			const until = performance.now() + 20_000;
			while (vi.getTimerCount() === 0 && performance.now() < until) await new Promise((resolve) => setImmediate(resolve));
			expect(vi.getTimerCount(), "the handler's deadline is set").toBe(1);
			expect(inFlightAt(DRAWING_KEY), 'nothing held while the body is read').toBe(0);

			const second = await api('POST', path(decision.id), { user: reader, body: { copy: 'shareable' } });
			expect(second.status, "the second account's export").toBe(200);

			await vi.advanceTimersByTimeAsync(EXPORT_READ_DEADLINE_MS);
			const late = await first;
			expect([late.status, (await late.json()).message, late.headers.get('connection')]).toEqual([408, exportLateWords(EXPORT_READ_DEADLINE_MS / 1000), 'close']);
		} finally {
			vi.useRealTimers();
		}
		expect(allowance(decider).used, 'nothing counted for the late body').toBe(0);
		expect(inFlightAt(DRAWING_KEY)).toBe(0);
	});

	// Card 2688's code review (S-M1): a caller refused never takes the drawing place, so is refused as such while another
	// export holds it, and not told to wait.
	it('answers 404, 403 and 409 while another export holds the drawing place, never 503 (S-M1)', async () => {
		const { decision, author } = rich();
		const draftDecider = makeUser({ username: 'draftexporter' });
		addBoardMember(board, draftDecider, 'editor');
		const draft = makeDecision({ board, author: draftDecider, decider: draftDecider, title: 'A draft' });
		const outsider = makeUser({ username: 'pdfoutsider' });
		const token = enterInFlight(DRAWING_KEY, 1)!;
		try {
			for (const [who, user, id, copy, status] of [
				['an outsider, the shareable copy', outsider, decision.id, 'shareable', 404],
				['an outsider, the full record', outsider, decision.id, 'full', 404],
				['the author, the full record', author, decision.id, 'full', 403],
				['the decider, a draft', draftDecider, draft.id, 'shareable', 409]
			] as const) {
				expect((await api('POST', path(id), { user, body: { copy } })).status, who).toBe(status);
			}
			expect(inFlightAt(DRAWING_KEY), 'the other export alone holds it').toBe(1);
		} finally {
			leaveInFlight(DRAWING_KEY, token);
		}
	});
});

describe('the one drawing place (R9a)', () => {
	it('is held by one export at a time, given back by its own closure alone, and free again once given back (E26)', () => {
		const first = holdDrawing();
		expect(first).toBeTypeOf('function');
		expect(inFlightAt(DRAWING_KEY)).toBe(1);
		expect(holdDrawing(), 'a second while the first holds it').toBeNull();

		first!();
		expect(inFlightAt(DRAWING_KEY)).toBe(0);
		const second = holdDrawing();
		expect(second).toBeTypeOf('function');
		// The first closure, called again, gives back nothing of the second's.
		first!();
		expect(inFlightAt(DRAWING_KEY)).toBe(1);
		expect(holdDrawing()).toBeNull();
		second!();
		expect(inFlightAt(DRAWING_KEY)).toBe(0);
	});
});

/**
 * A full record handed to the renderer with 5,000 participants' texts at their limits (E22, E25): 5,000 responses,
 * each with a 4,000-character comment, two 2,000-character option comments and two 2,000-character survey answers;
 * an objection by each with its 4,000-character reason and a 4,000-character reply; and a 4,000-character concern by
 * each.
 */
function atTheLimit(base: FullExport): FullExport {
	const at = (n: number, seed: number) => {
		let out = '';
		for (let i = 0; out.length < n; i++) out += `word${(seed + i) % 97} `;
		return out.slice(0, n);
	};
	const rows: ResultRow[] = Array.from({ length: 5000 }, (_, i) => ({
		participantId: i + 1,
		name: `Participant ${i}`,
		role: 'consulted',
		groups: ['A group'],
		kind: 'vote',
		optionId: 1,
		scores: null,
		comment: at(4000, i),
		optionComments: { 1: at(2000, i + 1), 2: at(2000, i + 2) },
		answers: { 7: at(2000, i + 3), 8: at(2000, i + 4) },
		versionNumber: 1,
		createdAt: '2026-11-01 10:00:00',
		via: 'session',
		changes: 0
	}));
	const flags: ResultFlag[] = Array.from({ length: 5000 }, (_, i) => ({
		flagId: i + 1,
		kind: 'objection',
		name: `Participant ${i}`,
		reason: at(4000, i + 5),
		raisedAt: '2026-11-01 11:00:00',
		via: 'session',
		versionNumber: 1,
		reply: at(4000, i + 6),
		repliedByName: 'A decider',
		repliedAt: '2026-11-01 12:00:00'
	}));
	const concerns = Array.from({ length: 5000 }, (_, i) => ({ name: `Participant ${i}`, comment: at(4000, i + 7), createdAt: '2026-11-02 10:00:00', via: 'session' }));
	return {
		...base,
		results: {
			...base.results,
			options: [
				{ optionId: 1, label: 'A', title: 'Plan A' },
				{ optionId: 2, label: 'B', title: 'Plan B' }
			],
			current: { ...base.results.current, responded: 5000, voted: 5000, rows },
			flags,
			concerns,
			surveysByVersion: {
				1: [
					{ questionId: 7, kind: 'text', prompt: 'Why?', help: '', required: false },
					{ questionId: 8, kind: 'text', prompt: 'What else?', help: '', required: false }
				]
			}
		}
	};
}
/**
 * E21's bounds: twice the measured figures (section 9), never above 60 seconds and 512 MB. Measured again on
 * 2026-11-24 once F2 was built (slice S2): the case alone, 2.0 s and 69 MB resident growth (a second run 2.1 s,
 * 70 MB), the event loop held at most 51 to 57 ms; inside the whole suite, with every other file's workers beside
 * it, 5.7 s, 9 MB and 93 ms. Each drew 384 pages, 0.6 MB, the record whole. The time is bounded by the suite's
 * figure, the memory by the highest; the event loop by the ruling's 200 ms. Before F2 (slice S1) the same decision
 * took 7.3 s alone and 22.6 s in the suite, 1,497 pages stopped at the ceiling, with no turn given back.
 */
const E21_SECONDS = 12;
const E21_HEAP_MB = 140;
