/**
 * Drafting a decision (card 2676, slice A1a): the working copy saved by
 * `updateDraft`, its content read strictly, its option rows and labels kept
 * in step, the draft revision every authoring write requires, agent-drafted
 * flags and Mark reviewed, the changed refusals of `setParticipants`, and
 * the readability check, whose refusals are `openDecision`'s
 * (`src/lib/server/decision-authoring-writes.ts`, `src/lib/server/decision-lifecycle-writes.ts`,
 * `src/lib/server/decision-participant-writes.ts`, `src/lib/server/decision-content.ts`,
 * `src/lib/decision-readiness.ts`). Slice A1b: the authoring reads, the one
 * projection every answer goes through, and the card-A routes
 * (`src/lib/server/decision-authoring.ts`, `src/routes/api/.../decisions`).
 *
 * Each write is called as a route will call it, inside `writeAs` and handed
 * its `caller`, with `effects()` installed so that no mail leaves. Every write
 * is sent the current revision unless the case is about it. A reader's own
 * refusals are `request-body.test.ts`'s, and role refusals the access
 * table's. The cases are the plan's,
 * `docs/planning/card-2676-decision-authoring.md`, section 6, by number.
 */
import { createHash, createHmac } from 'node:crypto';
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import type { SessionUser } from '$lib/server/auth';
import {
	decisionOptions,
	decisionParticipants,
	decisions,
	people,
	peopleGroupMembers,
	peopleGroups,
	settings,
	type Board,
	type Decision,
	type DecisionOption,
	type DecisionParticipant
} from '$lib/server/db/schema';
import { editorsOf } from '$lib/server/board-access';
import { decisionAccess, mayDo } from '$lib/server/decision-access';
import {
	decisionAnswer,
	optionAnswers,
	participantAnswers,
	readBoardDecisions,
	readEditPage,
	readinessOf
} from '$lib/server/decision-authoring';
import { audienceFactsOf, openFactsOf, parseWorkingContent, revisionOf } from '$lib/server/decision-content';
import { appendVersion, SYSTEM_ACTOR } from '$lib/server/decision-record';
import { markReviewed, setDecider, updateDraft } from '$lib/server/decision-authoring-writes';
import { openDecision } from '$lib/server/decision-lifecycle-writes';
import { setParticipants } from '$lib/server/decision-participant-writes';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { purposeKey, resetFormSecretCache } from '$lib/server/request-tokens';
import { requireRevision } from '$lib/server/decision-write-shared';
import { checkContent, refusalsOf, WARNING_CODES, type WorkingContent } from '$lib/decision-readiness';
import { STALE_REVISION } from '$lib/decision-words';
import { stamp } from '$lib/timestamps';
import { writeAs, type ServiceOptions } from '$lib/server/write-as';
import { api } from './helpers/api';
import { FUTURE, OPEN_FAULTS, readyDraft, revisionNow } from './helpers/decision-faults';
import { effects, type Effects } from './helpers/effects';
import {
	addBoardMember,
	linkHashOf,
	makeBoard,
	makeDecision,
	makeOption,
	makeParticipant,
	makePerson,
	makeSmtp,
	makeUser,
	resetDb
} from './helpers/fixtures';

const UI: ServiceOptions = { source: 'ui' };
const API: ServiceOptions = { source: 'api' };
const STALE = 'This decision was changed since you opened it: reload it to see the change';
const UNPRINTABLE_WORDS = (field: string) => `${field} cannot hold control, direction or invisible characters`;

let sent: Effects;
let owner: SessionUser;
let board: Board;

beforeEach(() => {
	resetDb();
	// Card 2697 (Q32): the publish limit's allowance is in memory, and ids repeat after resetDb.
	resetAllRateLimits();
	makeSmtp();
	db.insert(settings).values({ key: 'app_url', value: 'https://kanban.example.test' }).run();
	owner = makeUser({ username: 'owner' });
	board = makeBoard({ owner, name: 'The board' }).board;
	sent = effects();
});

afterEach(() => {
	sent.restore();
});

/** Call a write as `user`, as a route calls it inside its writeAs callback. */
const as = <T>(user: SessionUser, write: (caller: SessionUser | null) => T): T => writeAs({ user } as App.Locals, write as never) as T;

/** What a write was answered with: 'passed', or the refusal's status and words. */
function outcome(run: () => unknown): 'passed' | { status: number; message: string } {
	try {
		run();
		return 'passed';
	} catch (err) {
		if (isHttpError(err)) return { status: err.status, message: err.body.message };
		throw err;
	}
}

/**
 * A closing time a month ahead, as stored and as sent: a changed closing time
 * is at most a year ahead (card 2697, Q25), so `FUTURE` is a stored one alone.
 */
const SOON = stamp(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
const SOON_SENT = `${SOON.replace(' ', 'T')}Z`;

const decisionRow = (id: number) => db.select().from(decisions).where(eq(decisions.id, id)).get()!;
const optionRows = (id: number) => db.select().from(decisionOptions).where(eq(decisionOptions.decisionId, id)).orderBy(decisionOptions.id).all();
const participantRows = (id: number) =>
	db.select().from(decisionParticipants).where(eq(decisionParticipants.decisionId, id)).orderBy(decisionParticipants.id).all();
const stored = (id: number) => JSON.parse(decisionRow(id).workingContent) as WorkingContent;
const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Content with every field empty, and `more` over it. */
const contentOf = (more: Partial<Record<keyof WorkingContent, unknown>> = {}) => ({
	situation: '',
	question: '',
	ask: '',
	options: [] as unknown[],
	audiences: [] as unknown[],
	stories: [] as unknown[],
	unknowns: '',
	alreadyRuled: '',
	technicalDetail: '',
	...more
});

/** An option of the content, every field empty, and `more` over it. */
const optionOf = (more: Record<string, unknown> = {}) => ({ title: '', summary: '', pros: [], cons: [], commercial: '', ...more });

/** Save the working copy as `user`, with the current revision unless the body names one. */
const save = (user: SessionUser, id: number, body: Record<string, unknown>, opts: ServiceOptions = UI) =>
	as(user, (caller) => updateDraft(caller, { decisionId: id }, { revision: revisionNow(id), ...body }, opts));

const review = (user: SessionUser, id: number, sections: string[] | 'all', opts: ServiceOptions = UI) =>
	as(user, (caller) => markReviewed(caller, { decisionId: id }, { sections, revision: revisionNow(id) }, opts));

const participate = (user: SessionUser, id: number, participants: { personId: number; role: string }[]) =>
	as(user, (caller) => setParticipants(caller, { decisionId: id }, { participants, revision: revisionNow(id) }, UI));

/** A draft on `board` by `owner`, its decider `owner`. */
const draftOf = (row: Partial<Parameters<typeof makeDecision>[0]> = {}) => makeDecision({ board, author: owner, decider: owner, ...row });

/** Run `body` with neither an App URL saved nor `ORIGIN` or `APP_URL` set when `bare`, and put them back. */
function withEnvironment<T>(bare: boolean, body: () => T): T {
	const env = { ORIGIN: process.env.ORIGIN, APP_URL: process.env.APP_URL };
	if (bare) {
		delete process.env.ORIGIN;
		delete process.env.APP_URL;
	}
	try {
		return body();
	} finally {
		for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
	}
}

// ─── Saving the working copy (cases 1 to 5) ─────────────────────────────────

describe('updateDraft', () => {
	it('saves title, closesAt, voteMode and content on a draft, gives two new options rows A and B, and changes the revision (1)', async () => {
		const draft = draftOf();
		const before = revisionNow(draft.id);

		const answer = save(owner, draft.id, {
			title: '  Pick a supplier  ',
			closesAt: SOON_SENT,
			voteMode: 'score',
			content: contentOf({ situation: 'We need one.', options: [optionOf({ title: 'Acme' }), optionOf({ title: 'Bolt', pros: ['Cheap', '  '] })] })
		});

		const rows = optionRows(draft.id);
		expect(rows.map((row) => [row.label, row.position, row.addedInVersion, row.retiredInVersion])).toEqual([
			['A', 0, null, null],
			['B', 1, null, null]
		]);
		expect(decisionRow(draft.id)).toMatchObject({ title: 'Pick a supplier', closesAt: SOON, voteMode: 'score', status: 'draft' });
		const content = stored(draft.id);
		expect(content.options).toEqual([
			{ optionId: rows[0].id, title: 'Acme', summary: '', pros: [], cons: [], commercial: '' },
			{ optionId: rows[1].id, title: 'Bolt', summary: '', pros: ['Cheap'], cons: [], commercial: '' }
		]);
		expect(content).toMatchObject({ situation: 'We need one.', lastLabel: 'B', agentDrafted: {}, reviewed: {} });
		expect(answer.decision).toEqual(decisionRow(draft.id));
		expect(answer.options).toEqual(rows);
		expect(revisionNow(draft.id)).not.toBe(before);
		// A draft is nobody's business: no event, activity entry, live event or mail.
		expect(count('decision_events')).toBe(0);
		expect(count('activity_log')).toBe(0);
		await sent.settle();
		expect(sent.all).toEqual([]);
	});

	it('deletes an unpublished option left out, gives a new one the next label never used, and places each at its index (2)', () => {
		const draft = draftOf();
		save(owner, draft.id, { content: contentOf({ options: [optionOf({ title: 'Acme' }), optionOf({ title: 'Bolt' })] }) });
		const [acme, bolt] = optionRows(draft.id);

		save(owner, draft.id, { content: contentOf({ options: [optionOf({ title: 'Crane' }), optionOf({ optionId: acme.id, title: 'Acme' })] }) });

		const rows = optionRows(draft.id);
		expect(rows.find((row) => row.id === bolt.id)).toBeUndefined();
		expect(rows.map((row) => [row.id === acme.id ? 'acme' : 'new', row.label, row.position])).toEqual([
			['acme', 'A', 1],
			['new', 'C', 0]
		]);
		expect(stored(draft.id).options.map((option) => [option.optionId, option.title])).toEqual([
			[rows[1].id, 'Crane'],
			[acme.id, 'Acme']
		]);
		expect(stored(draft.id).lastLabel).toBe('C');
	});

	describe('never issues a label twice (3)', () => {
		it('skips a label known only from lastLabel, its option deleted before it was published', () => {
			const draft = draftOf();
			save(owner, draft.id, { content: contentOf({ options: ['A', 'B', 'C', 'D'].map((title) => optionOf({ title })) }) });
			const [a, b] = optionRows(draft.id);
			save(owner, draft.id, { content: contentOf({ options: [optionOf({ optionId: a.id }), optionOf({ optionId: b.id })] }) });
			expect(optionRows(draft.id).map((row) => row.label)).toEqual(['A', 'B']);

			save(owner, draft.id, { content: contentOf({ options: [optionOf({ optionId: a.id }), optionOf({ optionId: b.id }), optionOf({ title: 'New' })] }) });

			expect(optionRows(draft.id).map((row) => row.label)).toEqual(['A', 'B', 'E']);
		});

		it('skips a label found only in a published version', () => {
			const decision = draftOf({ status: 'open', closesAt: FUTURE, currentVersion: 1, openedAt: '2026-11-01 09:00:00' });
			const a = makeOption(decision, { label: 'A', position: 0, addedInVersion: 1 });
			appendVersion(
				{ decisionId: decision.id, number: 1, content: JSON.stringify({ options: [{ optionId: a.id, label: 'A' }, { optionId: 999, label: 'C' }] }), changeNote: null, asksAgain: true },
				SYSTEM_ACTOR
			);

			save(owner, decision.id, { content: contentOf({ options: [optionOf({ optionId: a.id }), optionOf({ title: 'Next' })] }) });

			expect(optionRows(decision.id).map((row) => row.label)).toEqual(['A', 'D']);
		});

		it('refuses a new option once "Z" has been used, 409, with nothing written', () => {
			const draft = draftOf();
			const z = makeOption(draft, { label: 'Z', position: 0 });
			db.update(decisions).set({ workingContent: JSON.stringify(contentOf({ options: [optionOf({ optionId: z.id })] })) }).where(eq(decisions.id, draft.id)).run();
			const before = { row: decisionRow(draft.id), options: optionRows(draft.id) };

			expect(outcome(() => save(owner, draft.id, { content: contentOf({ options: [optionOf({ optionId: z.id }), optionOf({ title: 'One more' })] }) }))).toEqual({
				status: 409,
				message: 'This decision has used every option label from A to Z: no option can be added'
			});
			expect(decisionRow(draft.id)).toEqual(before.row);
			expect(optionRows(draft.id)).toEqual(before.options);
		});
	});

	describe('on an open decision (4)', () => {
		let open: Decision;
		let a: DecisionOption;
		let b: DecisionOption;
		beforeEach(() => {
			open = draftOf({ status: 'open', closesAt: FUTURE, currentVersion: 1, openedAt: '2026-11-01 09:00:00', title: 'Open one', voteMode: 'single' });
			a = makeOption(open, { label: 'A', position: 0, addedInVersion: 1 });
			b = makeOption(open, { label: 'B', position: 1, addedInVersion: 1 });
			db.update(decisions)
				.set({ workingContent: JSON.stringify(contentOf({ options: [optionOf({ optionId: a.id, title: 'A' }), optionOf({ optionId: b.id, title: 'B' })] })) })
				.where(eq(decisions.id, open.id))
				.run();
		});

		it('saves the content, and a published option left out stays live, to be retired at the next publish', () => {
			save(owner, open.id, { content: contentOf({ situation: 'Edited between versions.', options: [optionOf({ optionId: a.id, title: 'A' })] }) });

			expect(stored(open.id)).toMatchObject({ situation: 'Edited between versions.', options: [{ optionId: a.id }] });
			expect(optionRows(open.id).map((row) => [row.id, row.retiredInVersion])).toEqual([
				[a.id, null],
				[b.id, null]
			]);
		});

		it.each([
			['a changed title', { title: 'Renamed' }, 'This decision has been opened: its title cannot be changed'],
			['a changed closesAt', { closesAt: SOON_SENT }, 'This decision has been opened: the closing time of an open decision changes by Extend'],
			['a changed voteMode', { voteMode: 'score' }, 'This decision has been opened: its vote mode cannot be changed']
		])('refuses %s, 409, with nothing written', (_case, change, message) => {
			const before = decisionRow(open.id);
			expect(outcome(() => save(owner, open.id, { ...change, content: contentOf({ situation: 'Not saved.' }) }))).toEqual({ status: 409, message });
			expect(decisionRow(open.id)).toEqual(before);
		});

		it('accepts title, closesAt and voteMode sent equal to the stored values, and saves the content', () => {
			save(owner, open.id, {
				title: ' Open one ',
				closesAt: `${FUTURE.replace(' ', 'T')}Z`,
				voteMode: 'single',
				content: contentOf({ situation: 'Saved with the whole form.', options: [optionOf({ optionId: a.id }), optionOf({ optionId: b.id })] })
			});

			expect(decisionRow(open.id)).toMatchObject({ title: 'Open one', closesAt: FUTURE, voteMode: 'single' });
			expect(stored(open.id).situation).toBe('Saved with the whole form.');
		});
	});

	describe("a draft's closing time (5)", () => {
		it('refuses a changed closesAt in the past, 400', () => {
			const draft = draftOf({ closesAt: FUTURE });
			expect(outcome(() => save(owner, draft.id, { closesAt: '2020-01-01T00:00:00Z' }))).toEqual({ status: 400, message: 'closesAt must be in the future' });
			expect(decisionRow(draft.id).closesAt).toBe(FUTURE);
		});

		it('re-saves a stored closesAt that has since passed, sent unchanged, and the readability check refuses no_closing_time', () => {
			const draft = draftOf({ closesAt: '2020-01-01 00:00:00' });

			save(owner, draft.id, { closesAt: '2020-01-01T00:00:00Z', content: contentOf({ situation: 'Still a draft.' }) });

			expect(decisionRow(draft.id)).toMatchObject({ closesAt: '2020-01-01 00:00:00' });
			expect(stored(draft.id).situation).toBe('Still a draft.');
			expect(refusalsOf(openFactsOf(decisionRow(draft.id), stamp())).map((refusal) => refusal.code)).toContain('no_closing_time');
		});
	});
});

// ─── The content, read strictly (cases 6, 7 and 12) ─────────────────────────

describe('the content shape', () => {
	let draft: Decision;
	let a: DecisionOption;
	let retired: DecisionOption;
	let elsewhere: DecisionOption;
	beforeEach(() => {
		draft = draftOf();
		a = makeOption(draft, { label: 'A', position: 0 });
		retired = makeOption(draft, { label: 'B', position: 1, addedInVersion: 1, retiredInVersion: 2 });
		elsewhere = makeOption(draftOf(), { label: 'A' });
		db.update(decisions).set({ workingContent: JSON.stringify(contentOf({ options: [optionOf({ optionId: a.id, title: 'A' })] })) }).where(eq(decisions.id, draft.id)).run();
	});

	/** Twenty options, each with twenty pros and twenty cons of 500 characters: every field in its limit, the whole over 256 KB. */
	const oversized = () =>
		contentOf({ options: Array.from({ length: 20 }, () => optionOf({ pros: Array(20).fill('p'.repeat(500)), cons: Array(20).fill('c'.repeat(500)) })) });

	/** What each row sends, and the words; words naming an option made in `beforeEach` are worked out when the row runs. */
	const rows: [string, () => Record<string, unknown>, string | (() => string)][] = [
		['an unknown top-level key', () => ({ content: { ...contentOf(), colour: 'red' } }), "content.colour is not a field of a decision's content"],
		['an unknown key in an option', () => ({ content: contentOf({ options: [{ ...optionOf(), colour: 'red' }] }) }), 'content.options[0].colour is not a field of an option'],
		[
			'an unknown key in an audience',
			() => ({ content: contentOf({ audiences: [{ groupId: null, heading: '', body: '', colour: 'red' }] }) }),
			'content.audiences[0].colour is not a field of an audience'
		],
		['an unknown key in a story', () => ({ content: contentOf({ stories: [{ title: '', body: '', colour: 'red' }] }) }), 'content.stories[0].colour is not a field of a user story'],
		['agentDrafted sent', () => ({ content: { ...contentOf(), agentDrafted: {} } }), 'content.agentDrafted is kept by the server: it cannot be sent'],
		['reviewed sent', () => ({ content: { ...contentOf(), reviewed: {} } }), 'content.reviewed is kept by the server: it cannot be sent'],
		['lastLabel sent', () => ({ content: { ...contentOf(), lastLabel: 'A' } }), 'content.lastLabel is kept by the server: it cannot be sent'],
		[
			'an optionId named twice',
			() => ({ content: contentOf({ options: [optionOf({ optionId: a.id }), optionOf({ optionId: a.id })] }) }),
			() => `options[1].optionId ${a.id} is named twice`
		],
		[
			'an option id of another decision',
			() => ({ content: contentOf({ options: [optionOf({ optionId: elsewhere.id })] }) }),
			() => `options[0].optionId ${elsewhere.id} is not a live option of this decision`
		],
		[
			'a retired option id',
			() => ({ content: contentOf({ options: [optionOf({ optionId: retired.id })] }) }),
			() => `options[0].optionId ${retired.id} is not a live option of this decision`
		],
		['a title holding U+202E', () => ({ title: 'Budget \u202e evil' }), UNPRINTABLE_WORDS('title')],
		['situation holding U+202E', () => ({ content: contentOf({ situation: 'Money \u202e short' }) }), UNPRINTABLE_WORDS('situation')],
		['options[0].title holding U+200D', () => ({ content: contentOf({ options: [optionOf({ title: 'Zero\u200dwidth' })] }) }), UNPRINTABLE_WORDS('options[0].title')],
		['content over 256 KB', () => ({ content: oversized() }), 'content must be at most 256 KB']
	];

	it.each(rows)('refuses %s, 400, with nothing written (6)', (_case, body, words) => {
		const before = { row: decisionRow(draft.id), options: optionRows(draft.id) };
		expect(outcome(() => save(owner, draft.id, body()))).toEqual({ status: 400, message: typeof words === 'string' ? words : words() });
		expect(decisionRow(draft.id)).toEqual(before.row);
		expect(optionRows(draft.id)).toEqual(before.options);
	});

	it('keeps tab, newline, carriage return and an emoji joined by U+200D in situation and in an option summary (7)', () => {
		const text = 'Line one\tTabbed\nLine two\r\nA coder: \u{1f469}\u200d\u{1f4bb}';

		save(owner, draft.id, { content: contentOf({ situation: text, options: [optionOf({ optionId: a.id, summary: text })] }) });

		expect(stored(draft.id).situation).toBe(text);
		expect(stored(draft.id).options[0].summary).toBe(text);
	});

	it.each([
		['U+200E in situation', { situation: 'Left\u200emark' }, 'situation'],
		["U+2067 in a story's body", { stories: [{ title: 'A story', body: 'Right\u2067isolate' }] }, 'stories[0].body']
	])('still refuses %s, 400 naming the field (7)', (_case, more, field) => {
		expect(outcome(() => save(owner, draft.id, { content: contentOf(more) }))).toEqual({ status: 400, message: UNPRINTABLE_WORDS(field) });
	});

	it("refuses a new audience groupId that is no group, 400; and re-saves one whose group was since deleted (12)", () => {
		expect(outcome(() => save(owner, draft.id, { content: contentOf({ audiences: [{ groupId: 9999, heading: 'Finance', body: '' }] }) }))).toEqual({
			status: 400,
			message: 'audiences[0].groupId 9999 is not a group'
		});

		const finance = db.insert(peopleGroups).values({ name: 'Finance' }).returning().get();
		const audiences = [{ groupId: finance.id, heading: 'Finance', body: 'Costs move.' }];
		save(owner, draft.id, { content: contentOf({ audiences }) });
		db.delete(peopleGroups).where(eq(peopleGroups.id, finance.id)).run();

		expect(outcome(() => save(owner, draft.id, { content: contentOf({ audiences, situation: 'Saved again.' }) }))).toBe('passed');
		expect(stored(draft.id)).toMatchObject({ situation: 'Saved again.', audiences });
	});
});

// ─── The revision (cases 8 and 9) ───────────────────────────────────────────

describe('the draft revision', () => {
	let editor: SessionUser;
	let person: ReturnType<typeof makePerson>;
	beforeEach(() => {
		editor = makeUser({ username: 'editor' });
		addBoardMember(board, editor, 'editor');
		person = makePerson();
	});
	const withRevision = (body: Record<string, unknown>, revision: string | undefined) => (revision === undefined ? body : { ...body, revision });

	/** Each authoring write, called with `revision` set as given (or left out), on a draft it would change. */
	const writes: [string, (decision: Decision, revision: string | undefined) => unknown][] = [
		['updateDraft', (d, r) => as(owner, (caller) => updateDraft(caller, { decisionId: d.id }, withRevision({ title: 'Changed' }, r), UI))],
		['setDecider', (d, r) => as(owner, (caller) => setDecider(caller, { decisionId: d.id }, withRevision({ deciderUserId: editor.id }, r), UI))],
		[
			'setParticipants',
			(d, r) => as(owner, (caller) => setParticipants(caller, { decisionId: d.id }, withRevision({ participants: [{ personId: person.id, role: 'consulted' }] }, r), UI))
		],
		['markReviewed', (d, r) => as(owner, (caller) => markReviewed(caller, { decisionId: d.id }, withRevision({ sections: 'all' }, r), UI))]
	];

	/** A draft with a section flagged, so that each write would change something. */
	const flaggedDraft = () => draftOf({ title: 'Before', workingContent: JSON.stringify({ ...contentOf({ situation: 'An agent wrote this.' }), agentDrafted: { situation: true } }) });

	it.each(writes)('refuses %s with no revision, 400, and with a stale one, 409, each with nothing written (8)', (_name, write) => {
		const draft = flaggedDraft();
		const before = { row: decisionRow(draft.id), participants: participantRows(draft.id) };

		expect(outcome(() => write(draft, undefined))).toEqual({ status: 400, message: 'revision is required' });
		expect(decisionRow(draft.id)).toEqual(before.row);
		expect(participantRows(draft.id)).toEqual(before.participants);

		// Read, and then changed by another write before this one lands: another editor's title (card 2706, N2: no longer
		// `updated_at` alone, which the editor revision does not cover).
		const read = revisionNow(draft.id);
		db.update(decisions).set({ title: 'Changed by another editor', updatedAt: '2026-11-03 10:00:00' }).where(eq(decisions.id, draft.id)).run();
		const changed = decisionRow(draft.id);
		expect(outcome(() => write(draft, read))).toEqual({ status: 409, message: STALE });
		expect(decisionRow(draft.id)).toEqual(changed);
		expect(participantRows(draft.id)).toEqual(before.participants);
		expect(count('decision_events')).toBe(0);
	});

	it('is keyed with the purpose key derived from the server secret, not the plain SHA-256 of what it covers (C2), and is the words the editor reloads on (C6)', () => {
		const decision = draftOf({ closesAt: FUTURE });
		const options = [makeOption(decision, { label: 'A', position: 0 })];
		const participants = [makeParticipant(decision, { person: makePerson(), userId: owner.id })];
		const row = decisionRow(decision.id);
		const covered = JSON.stringify({
			decision: [row.title, row.status, row.closesAt, row.voteMode, row.workingContent, row.currentVersion, row.deciderUserId],
			options: options.map((o) => [o.id, o.label, o.position, o.addedInVersion, o.retiredInVersion]),
			participants: participants.map((p) => [p.id, p.personId, p.role, p.removedAt])
		});

		const revision = revisionOf(row, options, participants);

		expect(revision).toMatch(/^[0-9a-f]{64}$/);
		expect(revision).not.toBe(createHash('sha256').update(covered).digest('hex'));
		expect(revision).toBe(createHmac('sha256', purposeKey('decision-revision')).update(covered).digest('hex'));
		// A purpose key is that purpose's alone.
		expect(purposeKey('decision-revision').equals(purposeKey('another purpose'))).toBe(false);
		expect(STALE_REVISION).toBe(STALE);
	});

	// Card 2750: the revision is keyed with the form signing key, which was made
	// at its first use, so the first revision check after a start, a reset or a
	// restore could write a settings row. requireRevision stands for every read
	// guard that signs (decisionRuleGuard and resultsReleaseGuard reach the same
	// revisionOf).
	it('is checked by requireRevision with no write, and refused where the signing key is missing, with none written', () => {
		const draft = draftOf({ closesAt: FUTURE });
		const changes = () => (sqlite.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
		// As a process that has just started: the key is in the settings, and nothing is held.
		resetFormSecretCache();
		const atStart = changes();
		expect(() => requireRevision(decisionRow(draft.id), revisionNow(draft.id))).not.toThrow();
		expect(changes()).toBe(atStart);

		sqlite.prepare("DELETE FROM settings WHERE key = 'request_form_secret'").run();
		resetFormSecretCache();
		const withoutKey = changes();
		expect(() => requireRevision(decisionRow(draft.id), 'a'.repeat(64))).toThrow(/form signing key is missing/);
		expect(changes()).toBe(withoutKey);
		expect(sqlite.prepare("SELECT key FROM settings WHERE key = 'request_form_secret'").all()).toEqual([]);
	});

	describe("covers every column the editor's writes change (9)", () => {
		let decision: Decision;
		let option: DecisionOption;
		let participant: DecisionParticipant;
		beforeEach(() => {
			decision = draftOf({ closesAt: FUTURE });
			option = makeOption(decision, { label: 'A', position: 0 });
			participant = makeParticipant(decision, { person: makePerson() });
		});
		const of = (d: Decision, options: DecisionOption[], participants: DecisionParticipant[]) => revisionOf(d, options, participants);

		const changes: [string, (d: Decision, o: DecisionOption, p: DecisionParticipant) => [Decision, DecisionOption[], DecisionParticipant[]]][] = [
			["the decision's title", (d, o, p) => [{ ...d, title: 'Other' }, [o], [p]]],
			["the decision's status", (d, o, p) => [{ ...d, status: 'open' }, [o], [p]]],
			["the decision's closes_at", (d, o, p) => [{ ...d, closesAt: '2099-02-01 00:00:00' }, [o], [p]]],
			["the decision's vote_mode", (d, o, p) => [{ ...d, voteMode: 'score' }, [o], [p]]],
			["the decision's working_content", (d, o, p) => [{ ...d, workingContent: '{"situation":"x"}' }, [o], [p]]],
			["the decision's current_version", (d, o, p) => [{ ...d, currentVersion: 1 }, [o], [p]]],
			["the decision's decider_user_id", (d, o, p) => [{ ...d, deciderUserId: null }, [o], [p]]],
			['an option added', (d, o, p) => [d, [o, { ...o, id: o.id + 100, label: 'B' }], [p]]],
			["an option's label", (d, o, p) => [d, [{ ...o, label: 'C' }], [p]]],
			["an option's position", (d, o, p) => [d, [{ ...o, position: 5 }], [p]]],
			["an option's added_in_version", (d, o, p) => [d, [{ ...o, addedInVersion: 1 }], [p]]],
			["an option's retired_in_version", (d, o, p) => [d, [{ ...o, retiredInVersion: 2 }], [p]]],
			["a participant's person_id", (d, o, p) => [d, [o], [{ ...p, personId: null }]]],
			["a participant's role", (d, o, p) => [d, [o], [{ ...p, role: 'informed' }]]],
			["a participant's removed_at", (d, o, p) => [d, [o], [{ ...p, removedAt: '2026-11-03 10:00:00' }]]],
			['a participant added', (d, o, p) => [d, [o], [p, { ...p, id: p.id + 100 }]]]
		];

		it.each(changes)('changes with %s alone', (_case, change) => {
			const base = of(decision, [option], [participant]);
			expect(of(decision, [{ ...option }], [{ ...participant }])).toBe(base);
			expect(of(...change(decision, option, participant))).not.toBe(base);
		});

		// Card 2706 (D2, D4): a Resend and an administrator's account and address writes change these alone, and no write
		// that asks the revision reads them as its caller saw them; the results revision still covers a participant's
		// user_id and email, and since card 2734 not updated_at either.
		// The last two rows are regression guards: `link_token_hash` and `link_issued_at` were never covered, before card
		// 2706 or since, and the rows pin that no later change adds them.
		const unchanged: [string, (d: Decision, o: DecisionOption, p: DecisionParticipant) => [Decision, DecisionOption[], DecisionParticipant[]]][] = [
			["the decision's updated_at", (d, o, p) => [{ ...d, updatedAt: '2026-11-03 10:00:01' }, [o], [p]]],
			["a participant's user_id", (d, o, p) => [d, [o], [{ ...p, userId: owner.id }]]],
			["a participant's email", (d, o, p) => [d, [o], [{ ...p, email: 'moved@example.test' }]]],
			["a participant's link_token_hash (a regression guard: never covered)", (d, o, p) => [d, [o], [{ ...p, linkTokenHash: 'a-new-link' }]]],
			["a participant's link_issued_at (a regression guard: never covered)", (d, o, p) => [d, [o], [{ ...p, linkIssuedAt: '2026-11-03 10:00:00' }]]]
		];

		it.each(unchanged)('does not change with %s (card 2706)', (_case, change) => {
			const base = of(decision, [option], [participant]);
			expect(of(...change(decision, option, participant))).toBe(base);
		});
	});
});

// ─── Agent-drafted text (cases 10 and 11) ───────────────────────────────────

describe('agent-drafted flags', () => {
	it("flags each section an API key changed, and not one it left, and a person's later edit keeps the flag (10)", () => {
		const draft = draftOf();
		const audiences = [{ groupId: null, heading: 'Everyone', body: 'Little changes.' }];
		save(owner, draft.id, { content: contentOf({ situation: 'Before.', question: 'Which?', options: [optionOf({ title: 'Acme' }), optionOf({ title: 'Bolt' })], audiences }) });
		const [acme, bolt] = optionRows(draft.id);

		save(
			owner,
			draft.id,
			{
				content: contentOf({
					situation: 'After, by an agent.',
					question: 'Which?',
					options: [optionOf({ optionId: acme.id, title: 'Acme, rewritten' }), optionOf({ optionId: bolt.id, title: 'Bolt' })],
					audiences: [{ ...audiences[0], body: 'More changes than we thought.' }]
				})
			},
			API
		);
		expect(stored(draft.id).agentDrafted).toEqual({ situation: true, [`options.${acme.id}`]: true, audiences: true });

		const { agentDrafted: _flags, reviewed: _stamps, lastLabel: _label, ...fields } = stored(draft.id);
		save(owner, draft.id, { content: { ...fields, situation: 'Edited by a person.' } });
		expect(stored(draft.id)).toMatchObject({ situation: 'Edited by a person.', agentDrafted: { situation: true, [`options.${acme.id}`]: true, audiences: true } });
	});

	describe('markReviewed (11)', () => {
		/** A ready draft whose situation, question and first option an API key wrote. */
		function agentDraft() {
			const ready = readyDraft({ board });
			save(
				ready.author,
				ready.draft.id,
				{
					content: contentOf({
						...ready.working,
						situation: 'Written by an agent.',
						question: 'Which budget, the agent asks?',
						options: [{ ...ready.working.options[0], title: 'Lean, by an agent' }, ready.working.options[1]]
					})
				},
				API
			);
			const leanKey = `options.${ready.lean.id}`;
			expect(stored(ready.draft.id).agentDrafted).toEqual({ situation: true, question: true, [leanKey]: true });
			return { ...ready, leanKey };
		}

		it("clears ['situation'] alone, stamping who reviewed it and when", () => {
			const r = agentDraft();

			review(r.author, r.draft.id, ['situation']);

			expect(stored(r.draft.id)).toMatchObject({
				agentDrafted: { question: true, [r.leanKey]: true },
				reviewed: { situation: { byUserId: r.author.id, byName: 'author', at: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/) } }
			});
			expect(Object.keys(stored(r.draft.id).reviewed)).toEqual(['situation']);
		});

		it("clears the rest with 'all', stamping each", () => {
			const r = agentDraft();
			review(r.author, r.draft.id, ['situation']);

			review(r.decider, r.draft.id, 'all');

			const content = stored(r.draft.id);
			expect(content.agentDrafted).toEqual({});
			expect(content.reviewed).toEqual({
				situation: expect.objectContaining({ byUserId: r.author.id, byName: 'author' }),
				question: expect.objectContaining({ byUserId: r.decider.id, byName: 'decider' }),
				[r.leanKey]: expect.objectContaining({ byUserId: r.decider.id, byName: 'decider' })
			});
		});

		it('refuses an API key, 403, with nothing written', () => {
			const r = agentDraft();
			const before = decisionRow(r.draft.id);

			expect(outcome(() => review(r.author, r.draft.id, 'all', API))).toEqual({
				status: 403,
				message: "Marking text reviewed is a person's act: it cannot be done with an API key"
			});
			expect(decisionRow(r.draft.id)).toEqual(before);
		});

		it('refuses a key that is no section of the decision, 400', () => {
			const r = agentDraft();

			expect(outcome(() => review(r.author, r.draft.id, ['situation', 'colour']))).toEqual({ status: 400, message: 'sections[1] is not a section of this decision' });
			expect(stored(r.draft.id).agentDrafted).toHaveProperty('situation', true);
		});

		it('publishes the flags and the review stamps as they are in version 1, each stamp by name and time alone, and nothing outside the allowlist (C3)', () => {
			const r = agentDraft();
			review(r.author, r.draft.id, ['situation']);
			// A key the content holds that is none of a version's: never copied.
			db.update(decisions)
				.set({ workingContent: JSON.stringify({ ...stored(r.draft.id), lastLabel: 'B', stray: 'not for participants' }) })
				.where(eq(decisions.id, r.draft.id))
				.run();
			const content = stored(r.draft.id);
			expect(content.reviewed.situation).toMatchObject({ byUserId: r.author.id });

			as(r.author, (caller) => openDecision(caller, { decisionId: r.draft.id }, { revision: revisionNow(r.draft.id) }, UI));

			const version = sqlite.prepare('SELECT content FROM decision_versions WHERE decision_id = ? AND number = 1').get(r.draft.id) as { content: string };
			const published = JSON.parse(version.content);
			expect(published).toMatchObject({ agentDrafted: { question: true, [r.leanKey]: true }, reviewed: { situation: { byName: 'author', at: content.reviewed.situation.at } } });
			expect(published.reviewed.situation).toEqual({ byName: 'author', at: content.reviewed.situation.at });
			expect(Object.keys(published).sort()).toEqual(
				['agentDrafted', 'alreadyRuled', 'ask', 'audiences', 'options', 'question', 'reviewed', 'situation', 'stories', 'technicalDetail', 'unknowns'].sort()
			);
			expect(Object.keys(published.options[0]).sort()).toEqual(['commercial', 'cons', 'label', 'optionId', 'pros', 'summary', 'title']);
			expect(version.content).not.toContain('byUserId');
			expect(version.content).not.toContain('lastLabel');
			expect(version.content).not.toContain('not for participants');
		});
	});
});

// ─── setParticipants (cases 13 and 14) ──────────────────────────────────────

describe("setParticipants' refusals of a named person (13)", () => {
	let draft: Decision;
	let admin: SessionUser;
	let gone: ReturnType<typeof makePerson>;
	beforeEach(() => {
		draft = draftOf();
		admin = makeUser({ role: 'admin' });
		gone = makePerson({ fullName: 'Gone Away', status: 'left' });
	});

	it.each([
		['a caller who is no administrator, a person who has left', () => owner, () => gone.id, () => `personId ${gone.id} cannot be included`],
		['a caller who is no administrator, an id that is no person', () => owner, () => 9999, () => 'personId 9999 cannot be included'],
		['an administrator, a person who has left', () => admin, () => gone.id, () => `Gone Away (person ${gone.id}) has left, and cannot be included`],
		['an administrator, an id that is no person', () => admin, () => 9999, () => 'personId 9999 is not a person']
	])('refuses, 400 for %s', (_case, who, personId, words) => {
		expect(outcome(() => participate(who(), draft.id, [{ personId: personId(), role: 'consulted' }]))).toEqual({ status: 400, message: words() });
		expect(participantRows(draft.id)).toEqual([]);
	});

	it('names, to a caller who is no administrator, a participant of this decision who has since left; left out, they are taken off', () => {
		const leaving = makePerson({ fullName: 'Leaving Soon' });
		const staying = makePerson({ fullName: 'Staying' });
		participate(owner, draft.id, [
			{ personId: leaving.id, role: 'consulted' },
			{ personId: staying.id, role: 'informed' }
		]);
		db.update(people).set({ status: 'left', leftAt: '2026-11-03 09:00:00' }).where(eq(people.id, leaving.id)).run();

		expect(
			outcome(() =>
				participate(owner, draft.id, [
					{ personId: leaving.id, role: 'consulted' },
					{ personId: staying.id, role: 'consulted' }
				])
			)
		).toEqual({ status: 400, message: 'participants: Leaving Soon has left: remove before saving' });
		expect(participantRows(draft.id).map((row) => row.personId)).toEqual([leaving.id, staying.id]);

		participate(owner, draft.id, [{ personId: staying.id, role: 'consulted' }]);
		expect(participantRows(draft.id).map((row) => [row.personId, row.role])).toEqual([[staying.id, 'consulted']]);
	});
});

describe('setParticipants by status: including people once opened is the accountable people’s (14)', () => {
	let author: SessionUser;
	let decider: SessionUser;
	beforeEach(() => {
		author = makeUser({ username: 'author' });
		addBoardMember(board, author, 'editor');
		decider = makeUser({ username: 'decider' });
		addBoardMember(board, decider, 'editor');
	});

	it("lets a board owner who is neither author nor decider set a draft's participants", () => {
		const draft = makeDecision({ board, author, decider });
		const person = makePerson();

		participate(owner, draft.id, [{ personId: person.id, role: 'consulted' }]);

		expect(participantRows(draft.id).map((row) => row.personId)).toEqual([person.id]);
	});

	it('refuses that board owner on an open decision, 403, with nothing written or mailed', async () => {
		const open = makeDecision({ board, author, decider, status: 'open', closesAt: FUTURE, currentVersion: 1, openedAt: '2026-11-01 09:00:00' });

		expect(outcome(() => participate(owner, open.id, [{ personId: makePerson().id, role: 'consulted' }]))).toEqual({
			status: 403,
			message: 'You cannot include people in this decision'
		});
		expect(participantRows(open.id)).toEqual([]);
		expect(count('decision_events')).toBe(0);
		await sent.settle();
		expect(sent.all).toEqual([]);
	});

	it('lets the decider include someone on the open decision', async () => {
		const open = makeDecision({ board, author, decider, status: 'open', closesAt: FUTURE, currentVersion: 1, openedAt: '2026-11-01 09:00:00' });
		const person = makePerson({ email: 'newcomer@example.test' });

		const [row] = participate(decider, open.id, [{ personId: person.id, role: 'consulted' }]);

		expect(row).toMatchObject({ personId: person.id, includedByName: 'decider', removedAt: null });
		await vi.waitFor(() => expect(sent.emails.map((mail) => mail.to)).toEqual(['newcomer@example.test']));
	});
});

// ─── The readability check (cases 15 and 16) ────────────────────────────────

describe('checkContent (15)', () => {
	const complete = (): WorkingContent => ({
		situation: 'Money is short.',
		question: 'Which budget?',
		ask: 'Pick one.',
		options: [{ optionId: 1, title: 'Lean', summary: '', pros: ['Cheap'], cons: ['Slow'], commercial: 'Costs less.' }],
		audiences: [{ groupId: 6, heading: 'Finance', body: 'The figures move.' }],
		stories: [],
		unknowns: '',
		alreadyRuled: '',
		technicalDetail: '',
		agentDrafted: {},
		reviewed: {},
		lastLabel: 'A'
	});

	it('answers every warning code once across two inputs with every fault, the agent warning keyed', () => {
		const empty: WorkingContent = {
			...complete(),
			situation: ' ',
			question: '',
			ask: '',
			options: [{ optionId: 1, title: '', summary: '', pros: [], cons: [' '], commercial: '' }],
			audiences: [{ groupId: 5, heading: 'Gone', body: '' }],
			agentDrafted: { situation: true }
		};
		const nobody: WorkingContent = { ...complete() };

		// Card 2697's code review, part B (S3): a closing time more than a year ahead, handed with the content.
		const far = { closesAt: '2027-11-04 09:00:01', now: '2026-11-04 09:00:00' };
		const first = checkContent(empty, { groups: { 5: { exists: false, activeMemberIds: [] } }, participantPersonIds: [7] }, far);
		const second = checkContent(nobody, { groups: { 6: { exists: true, activeMemberIds: [8] } }, participantPersonIds: [7] });

		expect([...first, ...second].map((warning) => warning.code).sort()).toEqual([...WARNING_CODES].sort());
		expect(first.find((warning) => warning.code === 'closes_too_far')!.words).toBe(
			'The closing time is more than 365 days ahead: it cannot be opened or re-published so (closesAt must be no more than 365 days from now)'
		);
		expect(first.find((warning) => warning.code === 'agent_drafted')).toEqual({
			code: 'agent_drafted',
			key: 'situation',
			words: 'Situation was drafted by an agent and not yet reviewed by a person'
		});
		expect(second).toEqual([
			{ code: 'audience_nobody_ticked', key: 'audiences[0]', words: '"Finance" in How it affects you is for a group none of whose members is included' }
		]);
	});

	it('answers the title, participants and decider an agent chose after the sections, in that order, each keyed (card 2728, D8)', () => {
		const chosen: WorkingContent = { ...complete(), agentDrafted: { decider: true, participants: true, situation: true, title: true } };

		const warnings = checkContent(chosen, { groups: { 6: { exists: true, activeMemberIds: [7] } }, participantPersonIds: [7] });

		expect(warnings).toEqual([
			{ code: 'agent_drafted', key: 'situation', words: 'Situation was drafted by an agent and not yet reviewed by a person' },
			{ code: 'agent_drafted', key: 'title', words: 'The title was chosen by an agent and not yet reviewed by a person' },
			{ code: 'agent_drafted', key: 'participants', words: 'The participants were chosen by an agent and not yet reviewed by a person' },
			{ code: 'agent_drafted', key: 'decider', words: 'The decider was chosen by an agent and not yet reviewed by a person' }
		]);
	});

	it('answers no warning for a complete input', () => {
		expect(checkContent(complete(), { groups: { 6: { exists: true, activeMemberIds: [7, 8] } }, participantPersonIds: [7] })).toEqual([]);
		// S3: a closing time exactly 365 days ahead, or none, is no warning.
		const groups = { groups: { 6: { exists: true, activeMemberIds: [7, 8] } }, participantPersonIds: [7] };
		expect(checkContent(complete(), groups, { closesAt: '2027-11-04 09:00:00', now: '2026-11-04 09:00:00' })).toEqual([]);
		expect(checkContent(complete(), groups, { closesAt: null, now: '2026-11-04 09:00:00' })).toEqual([]);
	});
});

describe('the drift guard: the readability refusals are openDecision’s (16)', () => {
	it.each(OPEN_FAULTS)('%s: refusalsOf answers that code alone, and openDecision its words', async (name, make, words, code) => {
		const ready = readyDraft({ board });
		make(ready);
		const bare = name.startsWith('(h)');

		const codes = withEnvironment(bare, () => refusalsOf(openFactsOf(decisionRow(ready.draft.id), stamp())).map((refusal) => refusal.code));
		expect(codes).toEqual([code]);
		expect(
			withEnvironment(bare, () =>
				outcome(() => as(ready.author, (caller) => openDecision(caller, { decisionId: ready.draft.id }, { revision: revisionNow(ready.draft.id) }, UI)))
			)
		).toEqual({
			status: 409,
			message: words
		});
		expect(decisionRow(ready.draft.id).status).toBe('draft');
		await sent.settle();
		expect(sent.all).toEqual([]);
	});

	it("lists a first row that has left and a second that was deleted in row order, and openDecision answers the first row's words", () => {
		const ready = readyDraft({ board });
		db.update(people).set({ status: 'left', leftAt: '2026-11-02 09:00:00' }).where(eq(people.id, ready.holderPerson.id)).run();
		db.delete(people).where(eq(people.id, ready.linkPerson.id)).run();

		expect(refusalsOf(openFactsOf(decisionRow(ready.draft.id), stamp()))).toEqual([
			{ code: 'participant_left', words: 'Holder has left: this decision cannot be opened until they are taken off it' },
			{ code: 'participant_deleted', words: 'Linky is no longer in the people directory: this decision cannot be opened until they are taken off it' }
		]);
		expect(outcome(() => as(ready.author, (caller) => openDecision(caller, { decisionId: ready.draft.id }, { revision: revisionNow(ready.draft.id) }, UI)))).toEqual({
			status: 409,
			message: 'Holder has left: this decision cannot be opened until they are taken off it'
		});
	});
});

// ─── The authoring reads (cases 17 to 19) ───────────────────────────────────

/** What the one projection gives of a decision, of an option and of a participant, and an administrator besides (decision 15). */
const DECISION_KEYS = [
	'id',
	'boardId',
	'boardName',
	'title',
	'status',
	'shownStatus',
	'voteMode',
	'closesAt',
	'currentVersion',
	'authorName',
	'deciderUserId',
	'deciderName',
	'content',
	'createdAt',
	'updatedAt',
	'openedAt',
	'closedAt',
	'withdrawnAt',
	'withdrawnReason',
	// Card 2679 (decision 22).
	'supersedesId',
	'resultsReleasedAt'
].sort();
const OPTION_KEYS = ['id', 'label', 'position', 'addedInVersion', 'retiredInVersion'].sort();
const PARTICIPANT_KEYS = ['id', 'personId', 'role', 'name', 'jobTitle', 'groups', 'includedAt', 'includedByName', 'removedAt', 'reach', 'hasLeft', 'notInDirectory'];
const ADMIN_PARTICIPANT_KEYS = [...PARTICIPANT_KEYS, 'email', 'userId', 'includedBy', 'removedBy', 'linkIssuedAt'].sort();
PARTICIPANT_KEYS.sort();

const keysOf = (rows: object[]) => [...new Set(rows.map((row) => JSON.stringify(Object.keys(row).sort())))].map((keys) => JSON.parse(keys) as string[]);

/** A token a participant's link is stored as the hash of: neither may reach any answer. */
const TOKEN = 'a-personal-link-token';

describe('readEditPage (17)', () => {
	/** A ready draft with a participant who has since left, a group, and a link held by one row. */
	function scene() {
		const ready = readyDraft({ board });
		const leaving = makePerson({ fullName: 'Leaving Soon', email: 'leaving@example.test' });
		const leavingRow = makeParticipant(ready.draft, { person: leaving, role: 'informed' });
		db.update(people).set({ status: 'left', leftAt: '2026-11-02 09:00:00' }).where(eq(people.id, leaving.id)).run();
		const finance = db.insert(peopleGroups).values({ name: 'Finance', description: 'Never in the picker' }).returning().get();
		db.insert(peopleGroupMembers)
			.values([
				{ groupId: finance.id, personId: ready.holderPerson.id },
				{ groupId: finance.id, personId: leaving.id }
			])
			.run();
		db.update(decisionParticipants)
			.set({ includedBy: ready.author.id, includedByName: 'author', linkTokenHash: linkHashOf(TOKEN), linkIssuedAt: '2026-11-01 09:00:00' })
			.where(eq(decisionParticipants.id, ready.linked.id))
			.run();
		// A section the author reviewed, and the last label issued: what the projection keeps from all but an administrator (C3).
		db.update(decisions)
			.set({ workingContent: JSON.stringify({ ...ready.working, reviewed: { situation: { byUserId: ready.author.id, byName: 'author', at: '2026-11-02 10:00:00' } }, lastLabel: 'B' }) })
			.where(eq(decisions.id, ready.draft.id))
			.run();
		return { ...ready, leaving, leavingRow, finance };
	}

	it('gives the author, who is no administrator, the projection alone, the picker without addresses, the candidates, the revision and the readability check', () => {
		const s = scene();

		const page = readEditPage(s.author, s.draft.id);

		expect(Object.keys(page.decision).sort()).toEqual(DECISION_KEYS);
		expect(keysOf(page.options)).toEqual([OPTION_KEYS]);
		expect(keysOf(page.participants)).toEqual([PARTICIPANT_KEYS]);
		const text = JSON.stringify(page);
		expect(text).not.toContain('@example.test');
		expect(text).not.toContain('linkTokenHash');
		expect(text).not.toContain(linkHashOf(TOKEN));
		expect(text).not.toContain('Never in the picker');
		expect(page.decision.content.reviewed).toEqual({ situation: { byName: 'author', at: '2026-11-02 10:00:00' } });
		expect(page.decision.content).not.toHaveProperty('lastLabel');
		expect(text).not.toContain('byUserId');

		expect(page.people).toEqual([
			{ id: s.holderPerson.id, fullName: 'Holder', jobTitle: 'Old title', groupIds: [s.finance.id] },
			{ id: s.linkPerson.id, fullName: 'Linky', jobTitle: '', groupIds: [] }
		]);
		expect(page.groups).toEqual([{ id: s.finance.id, name: 'Finance', activeMemberIds: [s.holderPerson.id] }]);
		expect(page.participants.map((row) => [row.name, row.reach, row.hasLeft, row.notInDirectory])).toEqual([
			['Holder', 'account', false, false],
			['Linky', 'link', false, false],
			['Leaving Soon', 'link', true, false]
		]);
		expect(page.deciderCandidates).toEqual(editorsOf(board));
		expect(page.deciderCandidates.map((account) => account.username)).toEqual(['author', 'decider', 'owner']);
		expect(page).toMatchObject({ editable: true, canSetDecider: true, canReview: true, canSetParticipants: true });
		// Card 2679: a draft has no results, and an author who is not the decider reads none.
		expect(page.mayReadResults).toBe(false);

		expect(page.revision).toBe(revisionNow(s.draft.id));
		const row = decisionRow(s.draft.id);
		const content = parseWorkingContent(row.workingContent);
		expect(page.readiness.refusals).toEqual(refusalsOf(openFactsOf(row, stamp())));
		expect(page.readiness.refusals.map((refusal) => refusal.code)).toEqual(['participant_left']);
		expect(page.readiness.warnings).toEqual(checkContent(content, audienceFactsOf(content, participantRows(s.draft.id))));
		expect(page.readiness.warnings.length).toBeGreaterThan(0);
	});

	it("gives an administrator people's and participants' addresses and the administrator's keys, and still no linkTokenHash", () => {
		const s = scene();
		const admin = makeUser({ username: 'admin', role: 'admin' });

		const page = readEditPage(admin, s.draft.id);

		expect(keysOf(page.people)).toEqual([['email', 'fullName', 'groupIds', 'id', 'jobTitle']]);
		expect(page.people.map((person) => 'email' in person && person.email)).toEqual([s.holderPerson.email, 'linky@example.test']);
		expect(keysOf(page.participants)).toEqual([ADMIN_PARTICIPANT_KEYS]);
		expect(page.participants.find((row) => row.id === s.linked.id)).toMatchObject({
			email: 'linky@example.test',
			userId: null,
			includedBy: s.author.id,
			removedBy: null,
			linkIssuedAt: '2026-11-01 09:00:00'
		});
		expect(page.participants.find((row) => row.id === s.holder.id)).toMatchObject({ userId: s.holderAccount.id });
		expect(page.decision.content.reviewed).toEqual({ situation: { byName: 'author', at: '2026-11-02 10:00:00', byUserId: s.author.id } });
		expect(page.decision.content).not.toHaveProperty('lastLabel');
		const text = JSON.stringify(page);
		expect(text).not.toContain('linkTokenHash');
		expect(text).not.toContain(linkHashOf(TOKEN));
	});

	it('refuses a board editor who is not the author on an open decision, 403: they can view it and cannot edit it', () => {
		const author = makeUser({ username: 'author' });
		addBoardMember(board, author, 'editor');
		const other = makeUser({ username: 'other' });
		addBoardMember(board, other, 'editor');
		const open = makeDecision({ board, author, decider: author, status: 'open', closesAt: FUTURE, currentVersion: 1, openedAt: '2026-11-01 09:00:00' });

		expect(outcome(() => readEditPage(other, open.id))).toEqual({ status: 403, message: 'You cannot edit this decision' });
	});
});

describe('readEditPage of a draft not theirs (18)', () => {
	it('answers a board editor who is not the author of a draft 404, not 403: the page does not say the draft exists', () => {
		const author = makeUser({ username: 'author' });
		addBoardMember(board, author, 'editor');
		const other = makeUser({ username: 'other' });
		addBoardMember(board, other, 'editor');
		const draft = makeDecision({ board, author, decider: author });

		expect(outcome(() => readEditPage(other, draft.id))).toEqual({ status: 404, message: 'Decision not found' });
	});
});

describe('readEditPage leaves the picker data out where nothing can be saved with it (19)', () => {
	beforeEach(() => {
		const person = makePerson({ fullName: 'In the directory' });
		const group = db.insert(peopleGroups).values({ name: 'Finance' }).returning().get();
		db.insert(peopleGroupMembers).values({ groupId: group.id, personId: person.id }).run();
	});

	it.each([
		['withdrawn', { status: 'withdrawn', withdrawnAt: '2026-11-02 09:00:00', withdrawnReason: 'No longer needed' }],
		['ruled', { status: 'ruled', closesAt: '2026-11-01 09:00:00', currentVersion: 1, openedAt: '2026-10-01 09:00:00', ruledAt: '2026-11-02 09:00:00' }]
	])('gives no people, groups or decider candidates on a %s decision', (_status, row) => {
		const decision = draftOf(row);

		const page = readEditPage(owner, decision.id);

		expect(page).toMatchObject({ people: [], groups: [], deciderCandidates: [], editable: false, canSetDecider: false, canSetParticipants: false });
		expect(page.decision.status).toBe(row.status);
	});

	it('gives a decider who is not the author no decider candidates, and canSetDecider false, but the people and groups', () => {
		const author = makeUser({ username: 'author' });
		addBoardMember(board, author, 'editor');
		const decider = makeUser({ username: 'decider' });
		addBoardMember(board, decider, 'editor');
		const draft = makeDecision({ board, author, decider });

		const page = readEditPage(decider, draft.id);

		expect(page).toMatchObject({ deciderCandidates: [], canSetDecider: false, editable: true, canReview: true });
		expect(page.people.map((person) => person.fullName)).toEqual(['In the directory']);
		expect(page.groups.map((group) => group.name)).toEqual(['Finance']);
		// The author, by the same rule, is offered them.
		expect(readEditPage(author, draft.id).deciderCandidates.map((account) => account.username)).toEqual(['author', 'decider', 'owner']);
	});

	it('gives a board owner who may edit an open decision but not include people the group names alone and no people; the author both (C4)', () => {
		const author = makeUser({ username: 'author' });
		addBoardMember(board, author, 'editor');
		const open = makeDecision({ board, author, decider: author, status: 'open', closesAt: FUTURE, currentVersion: 1, openedAt: '2026-11-01 09:00:00' });

		const page = readEditPage(owner, open.id);

		expect(page).toMatchObject({ editable: true, canSetParticipants: false, people: [] });
		expect(page.groups).toEqual([{ id: expect.any(Number), name: 'Finance' }]);
		expect(JSON.stringify(page)).not.toContain('activeMemberIds');
		expect(JSON.stringify(page)).not.toContain('In the directory');

		const asAuthor = readEditPage(author, open.id);
		expect(asAuthor.canSetParticipants).toBe(true);
		expect(asAuthor.people.map((person) => person.fullName)).toEqual(['In the directory']);
		expect(asAuthor.groups).toEqual([{ id: page.groups[0].id, name: 'Finance', activeMemberIds: [asAuthor.people[0].id] }]);
	});
});

describe("setDecider's refusal of an id (C5)", () => {
	let viewer: SessionUser;
	beforeEach(() => {
		viewer = makeUser({ username: 'viewer' });
		addBoardMember(board, viewer, 'viewer');
	});
	const name = (user: SessionUser, decision: Decision, deciderUserId: number, revision = revisionNow(decision.id)) =>
		outcome(() => as(user, (caller) => setDecider(caller, { decisionId: decision.id }, { deciderUserId, revision }, UI)));
	const cannot = (id: number) => `deciderUserId ${id} cannot edit this board: a decision's decider must be an account that can edit its board`;

	it('tells a caller who is no administrator the same for an id that is no account as for an account that cannot edit, at the same step; an administrator the detail', () => {
		const draft = draftOf();

		expect(name(owner, draft, 99_999)).toEqual({ status: 400, message: cannot(99_999) });
		expect(name(owner, draft, viewer.id)).toEqual({ status: 400, message: cannot(viewer.id) });
		// A stale revision is asked first for both, so the order of the refusals says nothing either.
		expect(name(owner, draft, 99_999, 'stale')).toEqual({ status: 409, message: STALE });
		expect(name(owner, draft, viewer.id, 'stale')).toEqual({ status: 409, message: STALE });

		const admin = makeUser({ username: 'admin', role: 'admin' });
		expect(name(admin, draft, 99_999)).toEqual({ status: 400, message: 'deciderUserId 99999 is not an account' });
		expect(name(admin, draft, viewer.id)).toEqual({ status: 400, message: cannot(viewer.id) });
		expect(decisionRow(draft.id).deciderUserId).toBe(owner.id);
	});
});

// ─── The routes (case 20) ───────────────────────────────────────────────────

describe('every card-A route answers through the one projection (20)', () => {
	let author: SessionUser;
	let admin: SessionUser;
	let draft: Decision;
	let option: DecisionOption;
	let personId: number;
	beforeEach(() => {
		author = makeUser({ username: 'author' });
		addBoardMember(board, author, 'editor');
		// The decider, so that every route lets an administrator in, Mark reviewed among them.
		admin = makeUser({ username: 'admin', role: 'admin' });
		draft = makeDecision({
			board,
			author,
			decider: admin,
			title: 'Routed',
			closesAt: FUTURE,
			workingContent: JSON.stringify({ ...contentOf({ situation: 'An agent wrote this.' }), agentDrafted: { situation: true } })
		});
		option = makeOption(draft, { label: 'A', position: 0 });
		const person = makePerson({ fullName: 'Linked', email: 'linked@example.test' });
		personId = person.id;
		makeParticipant(draft, { person, token: TOKEN, includedBy: author.id, includedByName: 'author' });
	});

	/** The answer a value would be given on the wire. */
	const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

	/**
	 * Each route: its method and path, the body `who` sends, and the answer it
	 * must be, worked out after the write from the rows and the projection.
	 */
	const routes: [
		name: string,
		method: 'POST' | 'PUT',
		path: () => string,
		body: (who: SessionUser) => Record<string, unknown>,
		expected: (answer: { decision?: { id: number } }, admin: boolean) => unknown
	][] = [
		[
			'POST /api/boards/[id]/decisions',
			'POST',
			() => `/api/boards/${board.id}/decisions`,
			() => ({ title: 'Made by the route' }),
			(answer, asAdmin) => ({ decision: decisionAnswer(decisionRow(answer.decision!.id), asAdmin), revision: revisionNow(answer.decision!.id) })
		],
		[
			'PUT /api/decisions/[id]',
			'PUT',
			() => `/api/decisions/${draft.id}`,
			(who) => ({ revision: revisionNow(draft.id), content: contentOf({ situation: `Saved by ${who.username}.`, options: [optionOf({ optionId: option.id, title: 'A' })] }) }),
			(_answer, asAdmin) => ({
				decision: decisionAnswer(decisionRow(draft.id), asAdmin),
				options: optionAnswers(optionRows(draft.id)),
				revision: revisionNow(draft.id),
				readiness: readinessOf(decisionRow(draft.id))
			})
		],
		[
			'PUT /api/decisions/[id]/decider',
			'PUT',
			() => `/api/decisions/${draft.id}/decider`,
			(who) => ({ deciderUserId: who.id === author.id ? owner.id : admin.id, revision: revisionNow(draft.id) }),
			(_answer, asAdmin) => ({ decision: decisionAnswer(decisionRow(draft.id), asAdmin), revision: revisionNow(draft.id) })
		],
		[
			'PUT /api/decisions/[id]/participants',
			'PUT',
			() => `/api/decisions/${draft.id}/participants`,
			(who) => ({ participants: [{ personId, role: who.id === author.id ? 'informed' : 'consulted' }], revision: revisionNow(draft.id) }),
			(_answer, asAdmin) => ({ participants: participantAnswers(participantRows(draft.id), asAdmin), revision: revisionNow(draft.id) })
		],
		[
			'POST /api/decisions/[id]/reviewed',
			'POST',
			() => `/api/decisions/${draft.id}/reviewed`,
			() => ({ sections: 'all', revision: revisionNow(draft.id) }),
			(_answer, asAdmin) => ({ decision: decisionAnswer(decisionRow(draft.id), asAdmin), revision: revisionNow(draft.id) })
		]
	];

	it.each(routes)(
		'%s answers the author exactly the projection of what it wrote, and an administrator no linkTokenHash',
		async (_name, method, path, body, expected) => {
			const asAuthor = await api(method, path(), { user: author, body: body(author) });
			expect(asAuthor.status, JSON.stringify(asAuthor.body)).toBeLessThan(300);
			expect(asAuthor.body).toEqual(wire(expected(asAuthor.body, false)));
			expect(JSON.stringify(asAuthor.body)).not.toContain('@example.test');
			// C3: the content as projected, the last label issued and a reviewer's account id to nobody but an administrator.
			expect(JSON.stringify(asAuthor.body)).not.toContain('lastLabel');
			expect(JSON.stringify(asAuthor.body)).not.toContain('byUserId');
			for (const row of (asAuthor.body as { participants?: object[] }).participants ?? []) expect(Object.keys(row).sort()).toEqual(PARTICIPANT_KEYS);

			const asAdmin = await api(method, path(), { user: admin, body: body(admin) });
			expect(asAdmin.status, JSON.stringify(asAdmin.body)).toBeLessThan(300);
			expect(asAdmin.body).toEqual(wire(expected(asAdmin.body, true)));
			expect(JSON.stringify(asAdmin.body)).not.toContain('linkTokenHash');
			expect(JSON.stringify(asAdmin.body)).not.toContain(linkHashOf(TOKEN));
			expect(JSON.stringify(asAdmin.body)).not.toContain('lastLabel');
			if (path().endsWith('/reviewed')) {
				// The author's stamp, given to them by name and time, and to an administrator with their account id.
				expect((asAuthor.body as any).decision.content.reviewed).toEqual({ situation: { byName: 'author', at: expect.any(String) } });
				expect((asAdmin.body as any).decision.content.reviewed).toEqual({ situation: { byName: 'author', at: expect.any(String), byUserId: author.id } });
			}
		},
		30_000
	);
});

// ─── The board's decision list (case 21) ────────────────────────────────────

describe('readBoardDecisions (21)', () => {
	it("lists every decision but the drafts a caller may not see, and each row's mayEdit, as mayDo answers them", () => {
		const editor = makeUser({ username: 'editor' });
		addBoardMember(board, editor, 'editor');
		const viewer = makeUser({ username: 'viewer' });
		addBoardMember(board, viewer, 'viewer');
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const ownersDraft = draftOf({ title: "The owner's draft" });
		const editorsDraft = makeDecision({ board, author: editor, decider: editor, title: "The editor's draft" });
		const open = draftOf({ title: 'Open', status: 'open', closesAt: FUTURE, currentVersion: 1, openedAt: '2026-11-01 09:00:00' });
		// A decision on another board is never listed.
		makeDecision({ board: makeBoard({ owner }).board, author: owner, decider: owner, status: 'open', closesAt: FUTURE });

		const listed = (user: SessionUser) => readBoardDecisions(user, board.id).decisions.map((row) => row.id);
		// Newest first: made in one second, by id.
		expect(listed(owner)).toEqual([open.id, editorsDraft.id, ownersDraft.id]);
		expect(listed(editor)).toEqual([open.id, editorsDraft.id]);
		expect(listed(viewer)).toEqual([open.id]);

		for (const user of [owner, editor, viewer, admin]) {
			const answer = readBoardDecisions(user, board.id);
			expect(answer.board).toEqual({ id: board.id, name: 'The board' });
			expect(answer.canCreate).toBe(user !== viewer);
			for (const decision of [ownersDraft, editorsDraft, open]) {
				const row = decisionRow(decision.id);
				const access = decisionAccess(user, row);
				const shown = answer.decisions.find((entry) => entry.id === decision.id);
				expect([user.username, decision.title, shown !== undefined], 'listed as mayDo view answers').toEqual([user.username, decision.title, mayDo(access, 'view', row)]);
				if (shown) expect([user.username, decision.title, shown.mayEdit], 'mayEdit as mayDo edit answers').toEqual([user.username, decision.title, mayDo(access, 'edit', row)]);
			}
		}
		expect(readBoardDecisions(editor, board.id).decisions.map((row) => [row.title, row.mayEdit])).toEqual([
			['Open', false],
			["The editor's draft", true]
		]);
	});
});
