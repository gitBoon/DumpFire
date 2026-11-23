/**
 * A participant's objections and requests to talk to the decider (card 2684):
 * from slice S1b, raising one signed in and by personal link
 * (`decision-flag-writes.ts`), its limits, the decider's notice
 * (`deciderNoticeOf` in decision-write-shared.ts, `notifyDecisionFlag` in
 * notifications.ts), and the link route's first statements and wrong-link
 * counter, through the gate. From slice S2, the decider's reply
 * (`replyToFlag`), the notice to the person who raised it
 * (`participantNoticeOf`, `notifyFlagReplied`), who may reply, and what a
 * change of decider hands over.
 *
 * The cases are the plan's, `docs/planning/card-2684-decision-objections-and-need-to-talk.md`,
 * section 9, by number. The tolerant reader's own cases (T24, T56) are
 * tests/decision-record.test.ts's; the gate's lists (T25) tests/gate.test.ts's;
 * the every-route table (T26) tests/access-every-route.test.ts's.
 */
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every live event asked for, through a pass-through of `emit` that records each call (as the question cases do, their code review's S4). */
vi.mock('$lib/server/events', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/events')>();
	return { ...real, emit: vi.fn(real.emit) };
});

import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { decisionParticipants, decisions, people, settings, users, type Board, type Decision } from '$lib/server/db/schema';
import { actorFor, appendEvent, FLAG_TEXT_ALLOWED, FLAG_TEXT_UNPRINTABLE, recordFlagReply, SYSTEM_ACTOR } from '$lib/server/decision-record';
import { flagsOf } from '$lib/server/decision-flags';
import { raiseFlag, raiseFlagByLink, replyToFlag } from '$lib/server/decision-flag-writes';
import { revisionFor } from '$lib/server/decision-authoring';
import { setDecider } from '$lib/server/decision-authoring-writes';
import { readPersonRecord, readRecord } from '$lib/server/decision-register';
import { readResults } from '$lib/server/decision-results';
import { readDecisionPage } from '$lib/server/decision-view';
import { emit } from '$lib/server/events';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { writeAs, type ServiceOptions } from '$lib/server/write-as';
import { FLAG_NOTE_MAX, FLAG_REASON_MAX, FLAG_TEXT_RULES, REPLY_TEXT_RULE } from '$lib/decision-rules';
import {
	ASK_FOR_LINK_LINE,
	DEAD_DECISION_LINK,
	FLAGS_CLOSED,
	flagRestWords,
	flagsFullWords,
	flagsLimitWords,
	LATEST_LINK_LINE,
	NO_LONGER_REACHED,
	TALK_OPEN,
	tooManyWrongLinks
} from '$lib/decision-words';
import { parseStamp, stamp } from '$lib/timestamps';
import { effects, type Effects } from './helpers/effects';
import {
	addBoardMember,
	linkHashOf,
	makeBoard,
	makeDecision,
	makeOption,
	makeParticipant,
	makePerson,
	makeRuling,
	makeSession,
	makeSmtp,
	makeUser,
	makeVersion,
	makeWebhook,
	resetDb
} from './helpers/fixtures';
import { FROM_THE_PAGE, gate, gateRoutes } from './helpers/gate';
import { heldBody } from './helpers/held-body';

const APP = 'https://kanban.example.test';
const FUTURE = '2099-01-01 12:00:00';
/** A closing time that has passed: a closed decision is awaiting a ruling. */
const PAST = '2026-11-02 09:00:00';
const STAMPED = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const UI: ServiceOptions = { source: 'ui' };
const API: ServiceOptions = { source: 'api' };

/** The 403 for a flag through an API key, either way in (R3; D19). */
const FLAG_ACT = "Raising an objection or asking to talk is a person's act: it cannot be done with an API key";

let sent: Effects;
let owner: SessionUser;
let board: Board;
let seq = 0;

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	makeSmtp();
	db.insert(settings).values({ key: 'app_url', value: APP }).run();
	owner = makeUser({ username: 'owner' });
	board = makeBoard({ owner, name: 'The board' }).board;
	sent = effects();
	emitted.mockClear();
});

/** Every live event asked for since the test began. */
const emitted = vi.mocked(emit);

afterEach(() => {
	sent.restore();
});

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

const decisionRow = (id: number) => db.select().from(decisions).where(eq(decisions.id, id)).get()!;

/**
 * A decision on the board opened as version 1 with options A and B, open until
 * far ahead unless told otherwise: its author and its decider two accounts,
 * each able to edit the board.
 */
function opened(opts: { status?: string; closesAt?: string | null } = {}) {
	const author = makeUser({ username: `author${++seq}` });
	const decider = makeUser({ username: `decider${++seq}` });
	addBoardMember(board, author, 'editor');
	addBoardMember(board, decider, 'editor');
	const made = makeDecision({
		board,
		author,
		decider,
		title: 'Which plan?',
		status: opts.status ?? 'open',
		closesAt: opts.closesAt === undefined ? FUTURE : opts.closesAt,
		openedAt: '2026-11-01 09:00:00'
	});
	const a = makeOption(made, { label: 'A', position: 0, addedInVersion: 1 });
	const b = makeOption(made, { label: 'B', position: 1, addedInVersion: 1 });
	makeVersion(made, { situation: 'Money is short.', question: 'Which plan?', options: [a, b].map((o) => ({ optionId: o.id, label: o.label, title: `Plan ${o.label}` })) }, { number: 1 });
	return { decision: decisionRow(made.id), author, decider };
}

/** A participant of the decision reached through their account. */
function withAccount(decision: Decision, name: string, role: 'consulted' | 'informed' = 'consulted') {
	const account = makeUser({ username: `${name}${++seq}` });
	const person = makePerson({ fullName: `${name} Person`, user: account });
	const participant = makeParticipant(decision, { person, role });
	return { account, person, participant };
}

/** A participant of the decision with no account, holding the personal link `token`. */
function withLink(decision: Decision, token: string, role: 'consulted' | 'informed' = 'consulted') {
	const person = makePerson({ fullName: `Linky ${token}` });
	return { person, participant: makeParticipant(decision, { person, role, token }) };
}

/** A board reader: may view every decision on the board that is not a draft. */
function boardReader() {
	const reader = makeUser({ username: `reader${++seq}` });
	addBoardMember(board, reader, 'viewer');
	return reader;
}

/** Call a write as `user`, or with no session for null, as a route calls it inside its writeAs callback. */
const as = <T>(user: SessionUser | null, write: (caller: SessionUser | null) => T): T =>
	writeAs((user === null ? {} : { user }) as App.Locals, write as never) as T;

const OBJECTION = { kind: 'objection', reason: 'The cost is not covered.' };
const raise = (user: SessionUser | null, decision: Decision, body: Record<string, unknown> = OBJECTION, opts: ServiceOptions = UI) =>
	as(user, (caller) => raiseFlag(caller, { decisionId: decision.id }, body, opts));
const raiseByLink = (token: string, body: Record<string, unknown> = OBJECTION, browser: SessionUser | null = null, opts: ServiceOptions = UI) =>
	as(browser, (caller) => raiseFlagByLink(caller, { token }, body, opts));

type EventRow = { kind: string; participantId: number | null; versionNumber: number | null; detail: any; actorUserId: number | null; actorName: string; source: string };
const eventsOf = (decisionId: number): EventRow[] =>
	(
		sqlite
			.prepare(
				'SELECT kind, participant_id AS participantId, version_number AS versionNumber, detail, actor_user_id AS actorUserId, actor_name AS actorName, source ' +
					'FROM decision_events WHERE decision_id = ? ORDER BY id'
			)
			.all(decisionId) as (Omit<EventRow, 'detail'> & { detail: string | null })[]
	).map((row) => ({ ...row, detail: row.detail === null ? null : JSON.parse(row.detail) }));
const raises = (decisionId: number) => eventsOf(decisionId).filter((event) => event.kind === 'objection_raised' || event.kind === 'talk_requested');
const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
/** What a write leaves behind: every flag row as it is, the events and the activity. */
const written = () => ({
	flags: sqlite.prepare('SELECT * FROM decision_flags ORDER BY id').all(),
	events: count('decision_events'),
	activity: count('activity_log')
});
const flagRows = (participantId: number) => sqlite.prepare('SELECT * FROM decision_flags WHERE participant_id = ? ORDER BY id').all(participantId) as Record<string, any>[];
/** The decider's notices of a flag mailed. */
const flagMails = () => sent.emails.filter((mail) => mail.subject.startsWith('An objection to') || mail.subject.startsWith('A request to talk about'));
/** Let every mail asked for so far be sent, then forget them: what follows is the next write's alone. */
const fresh = async () => {
	await sent.settle();
	sent.clear();
};

/** Move a participant's flags, and the events raising them, `minutes` back: a test's own change to the record, past the rest or the day. */
function ageFlags(participantId: number, minutes: number) {
	const back = `-${minutes} minutes`;
	sqlite.prepare('UPDATE decision_flags SET raised_at = datetime(raised_at, ?) WHERE participant_id = ?').run(back, participantId);
	sqlite
		.prepare("UPDATE decision_events SET created_at = datetime(created_at, ?) WHERE participant_id = ? AND kind IN ('objection_raised', 'talk_requested')")
		.run(back, participantId);
}

/** A flag row written as a restore could leave one, every column given; answers its id. */
const plant = (row: { decisionId: number; participantId: number; kind: string; reason: string; versionNumber?: number }): number =>
	Number(
		sqlite
			.prepare(
				'INSERT INTO decision_flags (decision_id, participant_id, kind, reason, version_number, via, raised_at) ' +
					"VALUES (@decisionId, @participantId, @kind, @reason, @versionNumber, 'session', '2026-11-02 09:00:00')"
			)
			.run({ versionNumber: 1, ...row }).lastInsertRowid
	);

// ─── Raising (T6 to T13, T55, T50) ───────────────────────────────────────────

describe('raiseFlag and raiseFlagByLink', () => {
	it('records a consulted participant’s objection signed in: the row, objection_raised naming them, and OwnFlag with no id (T6)', () => {
		const { decision } = opened();
		const pat = withAccount(decision, 'pat');
		const before = eventsOf(decision.id).length;

		const got = raise(pat.account, decision, { kind: 'objection', reason: '  The cost is not covered.  ' });

		expect(got).toEqual({
			flag: { kind: 'objection', reason: 'The cost is not covered.', raisedAt: expect.stringMatching(STAMPED), versionNumber: 1, reply: null, repliedAt: null }
		});
		expect(JSON.stringify(got)).not.toMatch(/"(id|flagId|participantId|decisionId|repliedBy)"/);
		const [row] = flagRows(pat.participant.id);
		expect(row).toEqual({
			id: expect.any(Number),
			decision_id: decision.id,
			participant_id: pat.participant.id,
			kind: 'objection',
			reason: 'The cost is not covered.',
			version_number: 1,
			via: 'session',
			raised_at: got.flag.raisedAt,
			reply: null,
			replied_by: null,
			replied_by_name: null,
			replied_at: null
		});
		expect(eventsOf(decision.id).slice(before)).toEqual([
			{
				kind: 'objection_raised',
				participantId: pat.participant.id,
				versionNumber: 1,
				detail: { flagId: row.id, notice: 'asked' },
				actorUserId: pat.account.id,
				actorName: pat.account.username,
				source: 'ui'
			}
		]);
	});

	it('takes an informed participant’s request to talk with no note, its reason stored empty (T7)', () => {
		const { decision } = opened();
		const ivy = withAccount(decision, 'ivy', 'informed');
		const una = withAccount(decision, 'una', 'informed');

		expect(raise(ivy.account, decision, { kind: 'talk' }).flag).toMatchObject({ kind: 'talk', reason: '' });
		// A note of white space alone is no note.
		expect(raise(una.account, decision, { kind: 'talk', reason: '   ' }).flag).toMatchObject({ kind: 'talk', reason: '' });
		expect([...flagRows(ivy.participant.id), ...flagRows(una.participant.id)].map((row) => [row.kind, row.reason])).toEqual([
			['talk', ''],
			['talk', '']
		]);
		expect(raises(decision.id).map((event) => event.kind)).toEqual(['talk_requested', 'talk_requested']);
	});

	it('refuses an objection with no reason, or one of spaces, 400, writing nothing (T8)', () => {
		const { decision } = opened();
		const pat = withAccount(decision, 'pat');
		const before = written();

		for (const [name, body] of [
			['no reason', { kind: 'objection' }],
			['an empty reason', { kind: 'objection', reason: '' }],
			['spaces', { kind: 'objection', reason: '  \t  ' }],
			// Code review C-E-L3: the invisible characters a reason may hold are no reason on their own.
			['a lone zero-width joiner', { kind: 'objection', reason: '\u200d' }],
			['zero-width joiners among spaces', { kind: 'objection', reason: ' \u200d\n\u200d ' }]
		] as const) {
			expect(outcome(() => raise(pat.account, decision, body)), name).toEqual({ status: 400, message: 'reason is required' });
		}
		expect(written()).toEqual(before);
	});

	it.each([
		['objection', 4000],
		['talk', 2000]
	] as const)('refuses, for kind %s, a reason past its limit 400, in words that do not repeat it (T9)', (kind, max) => {
		const { decision } = opened();
		const pat = withAccount(decision, 'pat');
		const before = written();
		const reason = 'Too long, '.repeat(max / 10) + 'x';

		const got = outcome(() => raise(pat.account, decision, { kind, reason }));

		expect(reason.length).toBe(max + 1);
		expect(got).toEqual({ status: 400, message: `reason must be at most ${max} characters` });
		expect(JSON.stringify(got)).not.toContain('Too long');
		expect(written()).toEqual(before);
	});

	it('refuses a kind other than objection or talk 400, writing nothing (T10)', () => {
		const { decision } = opened();
		const pat = withAccount(decision, 'pat');
		const before = written();

		for (const kind of ['veto', 'Objection', 'concern', '', 7, null]) {
			expect(outcome(() => raise(pat.account, decision, { kind, reason: 'A reason.' })), String(kind)).toEqual({
				status: 400,
				message: 'kind must be one of: objection, talk'
			});
		}
		expect(outcome(() => raise(pat.account, decision, { reason: 'A reason.' })), 'no kind').toEqual({ status: 400, message: 'kind is required' });
		expect(written()).toEqual(before);
	});

	it('refuses a flag through an API key 403, signed in and by a personal link (T11)', () => {
		const { decision } = opened();
		const pat = withAccount(decision, 'pat');
		withLink(decision, 'token-t11');
		const before = written();

		expect(outcome(() => raise(pat.account, decision, OBJECTION, API)), 'signed in').toEqual({ status: 403, message: FLAG_ACT });
		expect(outcome(() => raise(pat.account, decision, { kind: 'talk' }, API)), 'signed in, a request to talk').toEqual({ status: 403, message: FLAG_ACT });
		// Fail closed: any source but the page's is a key's.
		expect(outcome(() => raise(pat.account, decision, OBJECTION, { source: 'cli' as ServiceOptions['source'] })), 'an unknown source').toEqual({
			status: 403,
			message: FLAG_ACT
		});
		expect(outcome(() => raiseByLink('token-t11', OBJECTION, null, API)), 'by link').toEqual({ status: 403, message: FLAG_ACT });
		expect(written()).toEqual(before);
	});

	it('refuses a caller who is no live participant 403 (T12)', () => {
		const { decision } = opened();
		const reader = boardReader();
		// Removed, and able to view the decision as a reader of its board: no participant now.
		const removed = withAccount(decision, 'gone');
		addBoardMember(board, removed.account, 'viewer');
		sqlite.prepare('UPDATE decision_participants SET removed_at = ? WHERE id = ?').run(PAST, removed.participant.id);
		const words = 'You cannot raise an objection or ask to talk on this decision';
		const before = written();

		for (const [name, user] of [
			['a board reader', reader],
			['a removed participant', removed.account]
		] as const) {
			for (const body of [OBJECTION, { kind: 'talk' }]) {
				expect(outcome(() => raise(user, decision, body)), `${name} ${body.kind}`).toEqual({ status: 403, message: words });
			}
		}
		expect(written()).toEqual(before);
	});

	it('refuses a participant who has left 403 signed in, and their link the one 404 (T55)', () => {
		const { decision } = opened();
		const gone = withAccount(decision, 'gone');
		const linked = withLink(decision, 'token-t55');
		for (const person of [gone.person, linked.person]) db.update(people).set({ status: 'left', leftAt: PAST }).where(eq(people.id, person.id)).run();
		const before = written();

		expect(outcome(() => raise(gone.account, decision)), 'signed in').toEqual({ status: 403, message: NO_LONGER_REACHED });
		expect(outcome(() => raise(gone.account, decision, { kind: 'talk' })), 'signed in, a request to talk').toEqual({ status: 403, message: NO_LONGER_REACHED });
		// A link holder who has left holds no link that opens anything: the one answer for every link that opens nothing (R3).
		expect(outcome(() => raiseByLink('token-t55')), 'by link').toEqual({ status: 404, message: DEAD_DECISION_LINK });
		expect(written()).toEqual(before);
	});

	it('takes a flag while open or awaiting the ruling, and refuses it in every other status, one row each (T13)', () => {
		const accepted: [string, ReturnType<typeof opened>][] = [
			['open', opened()],
			['stored closed', opened({ status: 'closed', closesAt: PAST })],
			['stored open, past closes_at', opened({ status: 'open', closesAt: PAST })]
		];
		for (const [name, { decision }] of accepted) {
			const pat = withAccount(decision, 'pat');
			withLink(decision, `token-t13-${decision.id}`);
			expect(outcome(() => raise(pat.account, decision)), `${name}, signed in`).toBe('passed');
			expect(outcome(() => raiseByLink(`token-t13-${decision.id}`, { kind: 'talk' })), `${name}, by link`).toBe('passed');
		}

		const draft = opened({ status: 'draft', closesAt: null });
		const ruled = opened();
		makeRuling(ruled.decision, { ruledAt: stamp() });
		const superseded = opened({ status: 'superseded' });
		const withdrawn = opened({ status: 'withdrawn' });
		const refused: [string, Decision, number, string][] = [
			['a draft', draft.decision, 404, 'Decision not found'],
			['ruled', ruled.decision, 409, FLAGS_CLOSED],
			['superseded', superseded.decision, 409, 'This decision is superseded: objections and requests to talk are closed'],
			['withdrawn', withdrawn.decision, 409, 'This decision is withdrawn: objections and requests to talk are closed']
		];
		for (const [name, decision, status, message] of refused) {
			const pat = withAccount(decision, 'pat');
			const before = written();
			for (const body of [OBJECTION, { kind: 'talk' }]) {
				expect(outcome(() => raise(pat.account, decision, body)), `${name}, ${body.kind}`).toEqual({ status, message });
			}
			expect(written(), name).toEqual(before);
		}
		// By link, a ruled decision is refused in the same words; a draft's link opens nothing.
		withLink(ruled.decision, 'token-t13-ruled');
		expect(outcome(() => raiseByLink('token-t13-ruled')), 'ruled, by link').toEqual({ status: 409, message: FLAGS_CLOSED });
		withLink(draft.decision, 'token-t13-draft');
		expect(outcome(() => raiseByLink('token-t13-draft')), 'a draft, by link').toEqual({ status: 404, message: DEAD_DECISION_LINK });
	});

	it.each([
		['a tab', 'Cost:\tnot covered.'],
		['CRLF', 'First line.\r\nSecond line.'],
		['a zero-width joiner', 'Family 👨‍👩‍👧 plan.'],
		['an astral character', 'Too dear 💸 by half.'],
		['exactly an objection’s most', 'x'.repeat(FLAG_TEXT_RULES.objection.max), 'objection'],
		['exactly a request to talk’s most', 'y'.repeat(FLAG_TEXT_RULES.talk.max), 'talk'],
		['an astral character at an objection’s most', 'z'.repeat(FLAG_TEXT_RULES.objection.max - 2) + '😀', 'objection'],
		['an astral character at a request to talk’s most', 'w'.repeat(FLAG_TEXT_RULES.talk.max - 2) + '😀', 'talk']
	] as const)('keeps in flagsOf, as it is, every text raiseFlag takes: %s (T50)', (_name, reason, only?: 'objection' | 'talk') => {
		const { decision } = opened();
		const kinds = only === undefined ? (['objection', 'talk'] as const) : [only];
		for (const kind of kinds) {
			const pat = withAccount(decision, `pat${kind}`);
			expect(raise(pat.account, decision, { kind, reason }).flag.reason, kind).toBe(reason);
		}
		const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(flagsOf(decision.id).map((flag) => [flag.kind, flag.reason])).toEqual(kinds.map((kind) => [kind, reason]));
			expect(quiet, 'no row left out').not.toHaveBeenCalled();
		} finally {
			quiet.mockRestore();
		}
	});

	// Code review C-S-L2. These are the flags' own text rules, asked by `flagTextProblem` alone, at the write and by the
	// tolerant reader. Changing any of them can drop stored objections from the ruling's gate: a stored flag the new rule
	// refuses is left out everywhere, so an unanswered objection would no longer hold a ruling back. A change here needs a
	// migration-style review of the stored flags, never only a new expected value below.
	it('pins the flags’ own text rules to their exact values (code review C-S-L2)', () => {
		expect(FLAG_TEXT_UNPRINTABLE.source).toBe('[\\x00-\\x1f\\x7f-\\x9f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff\\p{Cf}]');
		expect(FLAG_TEXT_UNPRINTABLE.flags).toBe('u');
		expect(FLAG_TEXT_ALLOWED.source).toBe('[\\t\\n\\r\\u200d]');
		expect(FLAG_TEXT_ALLOWED.flags).toBe('g');
		expect([FLAG_REASON_MAX, FLAG_NOTE_MAX]).toEqual([4000, 2000]);
		expect({ ...FLAG_TEXT_RULES, reply: REPLY_TEXT_RULE }).toEqual({
			objection: { required: true, max: 4000 },
			talk: { required: false, max: 2000 },
			reply: { required: true, max: 4000 }
		});
	});
});

// ─── Limits (T16 to T19) ─────────────────────────────────────────────────────

describe('the limits on raising', () => {
	it('refuses a fourth objection and a fourth request to talk on a version, takes the next on a new version, and counts a row the reader drops (T16)', () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		for (let n = 1; n <= 3; n++) {
			raise(pat.account, decision, { kind: 'objection', reason: `Objection ${n}.` });
			ageFlags(pat.participant.id, 11);
		}
		for (let n = 1; n <= 3; n++) {
			raise(pat.account, decision, { kind: 'talk', reason: `Talk ${n}.` });
			ageFlags(pat.participant.id, 11);
			// The decider records each outcome, so that only the cap is left to refuse the fourth.
			recordFlagReply(flagRows(pat.participant.id).at(-1)!.id, 'We spoke.', actorFor(decider, 'ui'));
		}
		const before = written();
		expect(outcome(() => raise(pat.account, decision, { kind: 'objection', reason: 'A fourth.' })), 'a fourth objection').toEqual({
			status: 409,
			message: flagsLimitWords('objection', 3)
		});
		expect(outcome(() => raise(pat.account, decision, { kind: 'talk' })), 'a fourth request to talk').toEqual({ status: 409, message: flagsLimitWords('talk', 3) });
		expect(flagsLimitWords('objection', 3)).toBe('You have raised 3 objections on this version of the decision: no more can be raised');
		expect(flagsLimitWords('talk', 3)).toBe('You have asked to talk 3 times on this version of the decision: no more can be asked');
		expect(written()).toEqual(before);

		// A re-publish: version 2 takes one of each again, recorded against it.
		makeVersion(decision, { situation: 'Money is shorter.' }, { number: 2 });
		expect(raise(pat.account, decisionRow(decision.id), { kind: 'objection', reason: 'Still too dear.' }).flag.versionNumber).toBe(2);
		ageFlags(pat.participant.id, 11);
		expect(raise(pat.account, decisionRow(decision.id), { kind: 'talk' }).flag.versionNumber).toBe(2);

		// Three objections a restore planted, which the reader leaves out, still count: the first raised is a fourth.
		const quin = withAccount(decision, 'quin');
		for (let n = 0; n < 3; n++) plant({ decisionId: decision.id, participantId: quin.participant.id, kind: 'objection', reason: '   ', versionNumber: 2 });
		const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(flagsOf(decision.id).filter((flag) => flag.participantId === quin.participant.id)).toEqual([]);
		} finally {
			quiet.mockRestore();
		}
		expect(outcome(() => raise(quin.account, decisionRow(decision.id))), 'past planted rows').toEqual({ status: 409, message: flagsLimitWords('objection', 3) });
	});

	it('refuses a second request to talk while one has no outcome recorded 409, and takes one once it has (T17)', () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		raise(pat.account, decision, { kind: 'talk', reason: 'A word, please.' });
		ageFlags(pat.participant.id, 11);
		const before = written();

		expect(outcome(() => raise(pat.account, decision, { kind: 'talk' }))).toEqual({ status: 409, message: TALK_OPEN });
		expect(written()).toEqual(before);
		// An objection is not held back by it.
		expect(outcome(() => raise(pat.account, decision)), 'an objection').toBe('passed');
		ageFlags(pat.participant.id, 11);

		recordFlagReply(flagRows(pat.participant.id)[0].id, 'We spoke on Monday.', actorFor(decider, 'ui'));
		expect(outcome(() => raise(pat.account, decision, { kind: 'talk' })), 'once the first has its outcome').toBe('passed');

		// Code review C-E-L2: a request to talk a restore planted, which the reader leaves out and so no one could ever reply
		// to, does not hold the participant back, on the page or at the write. The caps still count it.
		const quin = withAccount(decision, 'quin');
		plant({ decisionId: decision.id, participantId: quin.participant.id, kind: 'talk', reason: 'y'.repeat(FLAG_TEXT_RULES.talk.max + 1) });
		const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(readDecisionPage(quin.account, decision.id).mayAskToTalk, 'offered on the page').toBe(true);
			expect(outcome(() => raise(quin.account, decision, { kind: 'talk' })), 'past a planted open request').toBe('passed');
		} finally {
			quiet.mockRestore();
		}
		expect(flagRows(quin.participant.id)).toHaveLength(2);
	});

	it('refuses a flag within 10 minutes of the participant’s last, of either kind, 429 naming the moment in UTC (T18)', () => {
		const { decision } = opened();
		const pat = withAccount(decision, 'pat');
		const quin = withAccount(decision, 'quin');
		raise(pat.account, decision);
		const from = stamp(new Date(parseStamp(flagRows(pat.participant.id)[0].raised_at)!.getTime() + 10 * 60 * 1000));
		const words = `Your last objection or request to talk was raised less than 10 minutes ago: the next can be raised from ${from} UTC`;
		const before = written();

		expect(outcome(() => raise(pat.account, decision, { kind: 'objection', reason: 'Again.' })), 'an objection').toEqual({ status: 429, message: words });
		expect(outcome(() => raise(pat.account, decision, { kind: 'talk' })), 'a request to talk').toEqual({ status: 429, message: words });
		expect(flagRestWords(10, from)).toBe(words);
		expect(written()).toEqual(before);
		// Another participant is not held back by it; and past the rest, the first is not either.
		expect(outcome(() => raise(quin.account, decision)), 'another participant').toBe('passed');
		ageFlags(pat.participant.id, 11);
		expect(outcome(() => raise(pat.account, decision, { kind: 'talk' })), 'past the rest').toBe('passed');
	});

	it('refuses the 201st flag on a decision 409, counted over every version and every stored row (T19)', () => {
		const { decision } = opened();
		const filler = withAccount(decision, 'filler');
		const other = withAccount(decision, 'other');
		makeVersion(decision, { situation: 'Money is shorter.' }, { number: 2 });
		// 200 rows: over two versions, and among them rows the reader leaves out (an unknown kind, an empty objection).
		for (let n = 0; n < 200; n++) {
			const kind = n % 10 === 0 ? 'veto' : n % 10 === 1 ? 'objection' : 'talk';
			plant({ decisionId: decision.id, participantId: n % 2 === 0 ? filler.participant.id : other.participant.id, kind, reason: n % 10 === 1 ? '' : 'A note.', versionNumber: n < 100 ? 1 : 2 });
		}
		const late = withAccount(decision, 'late');
		const before = written();

		for (const body of [OBJECTION, { kind: 'talk' }]) {
			expect(outcome(() => raise(late.account, decisionRow(decision.id), body)), body.kind).toEqual({ status: 409, message: flagsFullWords(200) });
		}
		expect(flagsFullWords(200)).toBe('This decision has 200 objections and requests to talk: no more can be raised. Speak to the decider directly');
		expect(written()).toEqual(before);
	});
});

// ─── By link (T20) ───────────────────────────────────────────────────────────

describe('a flag by personal link, and its route', () => {
	// The first request through the harness starts SvelteKit's server for this file, as the other gate files warm it.
	beforeAll(async () => {
		await gateRoutes();
	}, 30_000);

	const ORIGIN = 'http://localhost';
	const ACCEPT = { accept: '*/*' };
	const SAME = { ...ACCEPT, 'sec-fetch-site': 'same-origin' };

	it('records a link holder’s flag by the link; the route refuses a cross-site post before its body, counts a dead link and not a working one, and the 21st is 429 (T20)', async () => {
		const { decision } = opened();
		const linked = withLink(decision, 'token-t20');
		const browser = makeUser({ username: 'browser' });

		// The service: via the link, the signed-in browser's account beside it and never as the raiser.
		raiseByLink('token-t20', { kind: 'talk', reason: 'By link.' }, browser);
		expect(flagRows(linked.participant.id).map((row) => [row.kind, row.reason, row.via])).toEqual([['talk', 'By link.', 'link']]);
		expect(raises(decision.id)).toEqual([
			{
				kind: 'talk_requested',
				participantId: linked.participant.id,
				versionNumber: 1,
				detail: { flagId: flagRows(linked.participant.id)[0].id, notice: 'asked', signedIn: { userId: browser.id, name: browser.username } },
				actorUserId: null,
				actorName: linked.participant.name,
				source: 'link'
			}
		]);

		// The route: a cross-site or non-JSON post is refused before its body is read.
		const lia = withLink(decision, 'token-t20-route');
		const crossing: [string, Record<string, string>, number, string][] = [
			['text/plain', { origin: ORIGIN, 'content-type': 'text/plain' }, 415, 'This route takes JSON only'],
			['no Content-Type', { origin: ORIGIN }, 415, 'This route takes JSON only'],
			['Sec-Fetch-Site: cross-site', { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'cross-site' }, 403, 'Cross-site requests are refused']
		];
		const before = written();
		for (const [name, headers, status, message] of crossing) {
			const res = await gate('POST', '/api/decision-by-link/flags', { headers: { ...ACCEPT, ...headers }, body: JSON.stringify({ token: 'token-t20-route', ...OBJECTION }) });
			expect({ status: res.status, body: await res.json() }, name).toEqual({ status, body: { message } });
		}
		expect(written(), 'refused before the body').toEqual(before);

		const ruled = opened();
		withLink(ruled.decision, 'token-t20-ruled');
		makeRuling(ruled.decision, { ruledAt: stamp() });
		const post = (token: string, body: Record<string, unknown> = OBJECTION) => gate('POST', '/api/decision-by-link/flags', { headers: SAME, body: { token, ...body } });

		// A working link's refusals: an empty objection, one within the rest, and one on a ruled decision; and its success.
		expect((await post('token-t20-route', { kind: 'objection', reason: ' ' })).status).toBe(400);
		const first = await post('token-t20-route');
		expect(first.status).toBe(200);
		expect(first.headers.get('cache-control')).toBe('no-store');
		expect(await first.json()).toEqual({
			flag: { kind: 'objection', reason: OBJECTION.reason, raisedAt: expect.stringMatching(STAMPED), versionNumber: 1, reply: null, repliedAt: null }
		});
		expect(flagRows(lia.participant.id).map((row) => row.via)).toEqual(['link']);
		expect((await post('token-t20-route', { kind: 'talk' })).status).toBe(429);
		const closed = await post('token-t20-ruled');
		expect({ status: closed.status, body: await closed.json() }).toEqual({ status: 409, body: { message: FLAGS_CLOSED } });

		// Twenty dead links are each the one 404, so none of the four above was counted; the 21st is 429 with Retry-After.
		for (let n = 1; n <= 20; n++) {
			const res = await post(`token-t20-never-${n}`);
			expect({ status: res.status, body: await res.json() }, `dead link ${n}`).toEqual({ status: 404, body: { message: DEAD_DECISION_LINK } });
		}
		const limited = await post('token-t20-never-21');
		const wait = Number(limited.headers.get('retry-after'));
		expect(wait).toBeGreaterThan(0);
		expect({ status: limited.status, body: await limited.json() }).toEqual({ status: 429, body: { message: tooManyWrongLinks(wait) } });
		expect(limited.headers.get('referrer-policy')).toBe('no-referrer');
		await sent.settle();
	});
});

// ─── The decider's notice (T21 to T23) ───────────────────────────────────────

describe('the decider’s notice of a flag', () => {
	/** The notice each raise of the decision was recorded with, in order, by participant. */
	const notices = (decisionId: number) => raises(decisionId).map((event) => [event.participantId, event.detail.notice]);

	it('asks the decider, then holds the same participant’s next within the day, either kind, and says how many were held on the next (T21)', async () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const quin = withAccount(decision, 'quin');

		raise(pat.account, decision, { kind: 'objection', reason: 'SECRET-REASON one.' });
		await sent.settle();
		expect(flagMails().map((mail) => [mail.to, mail.subject])).toEqual([[decider.email, `An objection to ${decision.title}`]]);
		const [first] = flagMails();
		expect(first.html).toContain(`${APP}/decisions/${decision.id}/results`);
		for (const absent of ['SECRET-REASON', pat.person.fullName, pat.account.username, 'more since the last notice']) expect(first.html, absent).not.toContain(absent);
		await fresh();

		// The same participant's next, of the other kind, within the day: held. Another's first: asked.
		ageFlags(pat.participant.id, 11);
		raise(pat.account, decision, { kind: 'talk', reason: 'SECRET-NOTE' });
		raise(quin.account, decision, { kind: 'talk' });
		expect(notices(decision.id)).toEqual([
			[pat.participant.id, 'asked'],
			[pat.participant.id, 'held'],
			[quin.participant.id, 'asked']
		]);
		await sent.settle();
		expect(flagMails().map((mail) => [mail.to, mail.subject])).toEqual([[decider.email, `A request to talk about ${decision.title}`]]);
		expect(flagMails()[0].html).not.toContain('more since the last notice');
		await fresh();

		// A day on: asked again, saying one more was held.
		ageFlags(pat.participant.id, 25 * 60);
		raise(pat.account, decision, { kind: 'objection', reason: 'SECRET-REASON two.' });
		expect(notices(decision.id).at(-1)).toEqual([pat.participant.id, 'asked']);
		await sent.settle();
		expect(flagMails()).toHaveLength(1);
		expect(flagMails()[0].html).toContain('They raised 1 more since the last notice about them, which was not mailed.');
		expect(flagMails()[0].html).not.toContain('SECRET');
		expect(sent.duringTransaction).toEqual([]);
	});

	/** What makes each outcome so, done to the decision `opened` made before the raise. */
	const arranged: [string, (made: { decision: Decision; decider: SessionUser }) => void][] = [
		['no_decider', (made) => void sqlite.prepare('UPDATE decisions SET decider_user_id = NULL WHERE id = ?').run(made.decision.id)],
		['no_link_address', () => void db.delete(settings).where(eq(settings.key, 'app_url')).run()],
		['prefs_off', (made) => void db.update(users).set({ notificationPrefs: JSON.stringify({ email_decisions: false }) }).where(eq(users.id, made.decider.id)).run()],
		['no_mail_host', () => void db.delete(settings).where(eq(settings.key, 'smtp_host')).run()],
		['own', () => undefined]
	];

	it.each(arranged)('records %s and mails nobody (T22)', async (expected, arrange) => {
		const made = opened();
		arrange(made);
		// `own`: the decider is included in their own decision, and raises a flag on it.
		const raiser =
			expected === 'own'
				? { account: made.decider, participant: makeParticipant(made.decision, { person: makePerson({ fullName: 'Decider Person', user: made.decider }) }) }
				: withAccount(made.decision, 'pat');

		raise(raiser.account, decisionRow(made.decision.id));

		expect(notices(made.decision.id)).toEqual([[raiser.participant.id, expected]]);
		await sent.settle();
		expect(sent.emails).toEqual([]);
		// Not counted as asked: the next, past the 10-minute rest and well within the day, with nothing changed, is recorded
		// the same, never held.
		ageFlags(raiser.participant.id, 11);
		raise(raiser.account, decisionRow(made.decision.id), { kind: 'talk' });
		expect(notices(made.decision.id).at(-1)).toEqual([raiser.participant.id, expected]);
	});

	it('asks a new decider on the participant’s first flag after a change of decider, though the former decider was asked within the day (code review C-S-L4)', async () => {
		const { decision, author, decider } = opened();
		const pat = withAccount(decision, 'pat');
		raise(pat.account, decision);
		await sent.settle();
		expect(flagMails().map((mail) => mail.to)).toEqual([decider.email]);
		await fresh();
		const next = makeUser({ username: 'next' });
		addBoardMember(board, next, 'editor');
		as(author, (caller) => setDecider(caller, { decisionId: decision.id }, { deciderUserId: next.id, revision: revisionFor(decision.id) }, UI));

		// Within the day of the former decider's notice: the new decider is asked, and nothing held is counted to them.
		ageFlags(pat.participant.id, 11);
		raise(pat.account, decisionRow(decision.id), { kind: 'talk' });
		expect(notices(decision.id)).toEqual([
			[pat.participant.id, 'asked'],
			[pat.participant.id, 'asked']
		]);
		await sent.settle();
		expect(flagMails().map((mail) => [mail.to, mail.subject])).toEqual([[next.email, `A request to talk about ${decision.title}`]]);
		expect(flagMails()[0].html).not.toContain('more since the last notice');
		await fresh();

		// The hold then runs from the new decider's notice.
		ageFlags(pat.participant.id, 11);
		raise(pat.account, decisionRow(decision.id), { kind: 'objection', reason: 'Again.' });
		expect(notices(decision.id).at(-1)).toEqual([pat.participant.id, 'held']);
		await sent.settle();
		expect(flagMails()).toEqual([]);
	});

	it('writes no activity entry, asks for no live event and sends no webhook on a raise, either way in (T23)', async () => {
		const { decision } = opened();
		const pat = withAccount(decision, 'pat');
		withLink(decision, 'token-t23');
		makeWebhook(board);

		raise(pat.account, decision);
		raiseByLink('token-t23', { kind: 'talk' });

		expect(count('decision_flags')).toBe(2);
		expect(count('activity_log')).toBe(0);
		expect(emitted, 'no live event asked for').not.toHaveBeenCalled();
		await sent.settle();
		expect(sent.webhooks).toEqual([]);
		expect(sent.events).toEqual([]);
		// The decider's two notices alone.
		expect(sent.all.map((effect) => effect.kind)).toEqual(['email', 'email']);
	});
});

// ─── The decider's reply (T28 to T36, T57, T58, T60) ─────────────────────────

describe('replyToFlag', () => {
	const PAGE = { source: 'ui' } as const;
	/** The 403 for a reply through an API key (R7; D19). */
	const REPLY_ACT = "Replying to an objection or a request to talk is a person's act: it cannot be done with an API key";
	/** The 403 for anyone but the current decider with board edit (R7). */
	const NOT_YOURS = 'You cannot reply to objections and requests to talk on this decision';
	const NOT_FOUND = 'Objection or request to talk not found';
	const OBJECTION_PAST = 'This decision has been ruled on: an objection is answered before the ruling, and this one can no longer be';
	const ANSWERED = 'This objection has already been answered';
	const OUTCOME_RECORDED = 'The outcome of this request to talk has already been recorded';

	const reply = (user: SessionUser | null, decision: Decision, flagId: number, body: Record<string, unknown> = { reply: 'We have the budget.' }, opts: ServiceOptions = UI) =>
		as(user, (caller) => replyToFlag(caller, { decisionId: decision.id, flagId }, body, opts));
	/** The id of the flag last written. */
	const lastFlagId = () => (sqlite.prepare('SELECT MAX(id) AS id FROM decision_flags').get() as { id: number }).id;
	/** Raise a flag as `user`, answering its id. */
	const raised = (user: SessionUser, decision: Decision, body: Record<string, unknown> = OBJECTION) => {
		raise(user, decision, body);
		return lastFlagId();
	};
	const replies = (decisionId: number) => eventsOf(decisionId).filter((event) => event.kind === 'objection_answered' || event.kind === 'talk_outcome');
	/** The notices to the person whose flag was replied to. */
	const replyMails = () => sent.emails.filter((mail) => mail.subject.startsWith('Your objection to') || mail.subject.startsWith('The outcome of your request to talk'));
	const flagRow = (id: number) => sqlite.prepare('SELECT * FROM decision_flags WHERE id = ?').get(id) as Record<string, any>;

	it('answers an objection as the decider: the row settled once, objection_answered naming nobody, and a notice to the account that names nobody (T28)', async () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const flagId = raised(pat.account, decision, { kind: 'objection', reason: 'SECRET-REASON: the cost.' });
		await fresh();
		const row = flagRow(flagId);
		const before = eventsOf(decision.id).length;

		const got = reply(decider, decision, flagId, { reply: '  SECRET-REPLY: the budget covers it.  ' });

		expect(got).toEqual({
			flag: {
				flagId,
				kind: 'objection',
				name: pat.participant.name,
				reason: 'SECRET-REASON: the cost.',
				raisedAt: row.raised_at,
				via: 'session',
				versionNumber: 1,
				reply: 'SECRET-REPLY: the budget covers it.',
				repliedByName: decider.username,
				repliedAt: expect.stringMatching(STAMPED)
			}
		});
		expect(JSON.stringify(got)).not.toContain('repliedBy"');
		expect(flagRow(flagId)).toEqual({
			...row,
			reply: 'SECRET-REPLY: the budget covers it.',
			replied_by: decider.id,
			replied_by_name: decider.username,
			replied_at: got.flag.repliedAt
		});
		expect(eventsOf(decision.id).slice(before)).toEqual([
			{
				kind: 'objection_answered',
				participantId: null,
				versionNumber: null,
				detail: { flagId, notice: 'asked' },
				actorUserId: decider.id,
				actorName: decider.username,
				source: 'ui'
			}
		]);
		await sent.settle();
		expect(replyMails().map((mail) => [mail.to, mail.subject])).toEqual([[pat.account.email, `Your objection to ${decision.title} has been answered`]]);
		const [mail] = replyMails();
		expect(mail.html).toContain(`${APP}/decisions/${decision.id}`);
		for (const absent of ['SECRET', decider.username, pat.person.fullName, pat.account.username]) expect(mail.html, absent).not.toContain(absent);
		expect(sent.duringTransaction).toEqual([]);
		// No activity entry and no live event (design S3).
		expect(count('activity_log')).toBe(0);
		expect(emitted).not.toHaveBeenCalled();
	});

	it('records the outcome of a request to talk as talk_outcome, and tells the person (T29)', async () => {
		const { decision, decider } = opened();
		const ivy = withAccount(decision, 'ivy', 'informed');
		const flagId = raised(ivy.account, decision, { kind: 'talk', reason: 'A word, please.' });
		await fresh();

		expect(reply(decider, decision, flagId, { reply: 'We spoke on Monday and agreed on B.' }).flag).toMatchObject({ kind: 'talk', reply: 'We spoke on Monday and agreed on B.' });

		expect(replies(decision.id).map((event) => [event.kind, event.participantId, event.detail])).toEqual([['talk_outcome', null, { flagId, notice: 'asked' }]]);
		await sent.settle();
		expect(replyMails().map((mail) => [mail.to, mail.subject])).toEqual([[ivy.account.email, `The outcome of your request to talk about ${decision.title} has been recorded`]]);
		expect(replyMails()[0].html).not.toContain('agreed on B');
	});

	it('tells a link holder at the snapshot address, to use the link in their latest email, with no link in it and none issued (T30)', async () => {
		const { decision, decider } = opened();
		const lia = withLink(decision, 'token-t30');
		const browser = makeUser({ username: 'browser' });
		// The invitation that carried their link, delivered.
		const of = appendEvent({ decisionId: decision.id, kind: 'invited', participantId: lia.participant.id, versionNumber: 1 }, SYSTEM_ACTOR);
		appendEvent({ decisionId: decision.id, kind: 'mail_outcome', participantId: lia.participant.id, detail: { of, mail: 'invitation', delivered: true } }, SYSTEM_ACTOR);
		raiseByLink('token-t30', { kind: 'talk' }, browser);
		const flagId = lastFlagId();
		await fresh();

		reply(decider, decision, flagId, { reply: 'We spoke.' });

		expect(replies(decision.id).at(-1)?.detail.notice).toBe('asked');
		await sent.settle();
		// The snapshot address, never the account a browser beside the link was signed in as.
		expect(replyMails().map((mail) => mail.to)).toEqual([lia.participant.email]);
		const [mail] = replyMails();
		expect(mail.html).toContain(LATEST_LINK_LINE);
		expect(mail.html).not.toContain(ASK_FOR_LINK_LINE);
		expect(mail.html).not.toMatch(/\/decision-link\/|\/decisions\/|href=/);
		expect(eventsOf(decision.id).filter((event) => event.kind === 'link_issued')).toEqual([]);
		expect(db.select().from(decisionParticipants).where(eq(decisionParticipants.id, lia.participant.id)).get()?.linkTokenHash).toBe(linkHashOf('token-t30'));
	});

	it('records not_reached for a removed participant’s flag and mails nobody (T31)', async () => {
		const { decision, decider } = opened();
		const gone = withAccount(decision, 'gone');
		const flagId = raised(gone.account, decision);
		await fresh();
		db.update(decisionParticipants).set({ removedAt: PAST }).where(eq(decisionParticipants.id, gone.participant.id)).run();

		reply(decider, decision, flagId);

		expect(replies(decision.id).map((event) => event.detail.notice)).toEqual(['not_reached']);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('refuses a second reply 409, either kind, leaving the row and the record as they were (T32)', () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const objection = raised(pat.account, decision);
		ageFlags(pat.participant.id, 11);
		const talk = raised(pat.account, decision, { kind: 'talk' });
		reply(decider, decision, objection, { reply: 'First answer.' });
		reply(decider, decision, talk, { reply: 'First outcome.' });
		const before = written();

		expect(outcome(() => reply(decider, decision, objection, { reply: 'Second answer.' })), 'an objection').toEqual({ status: 409, message: ANSWERED });
		expect(outcome(() => reply(decider, decision, talk, { reply: 'Second outcome.' })), 'a request to talk').toEqual({ status: 409, message: OUTCOME_RECORDED });
		expect(written()).toEqual(before);
		expect([flagRow(objection).reply, flagRow(talk).reply]).toEqual(['First answer.', 'First outcome.']);
	});

	it('refuses the author, a board owner and an administrator who is not the decider 403, writing nothing (T33)', () => {
		const { decision, author } = opened();
		const pat = withAccount(decision, 'pat');
		const flagId = raised(pat.account, decision);
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const before = written();

		for (const [name, user] of [
			['the author', author],
			['a board owner', owner],
			['an administrator', admin]
		] as const) {
			expect(outcome(() => reply(user, decision, flagId)), name).toEqual({ status: 403, message: NOT_YOURS });
		}
		expect(written()).toEqual(before);
	});

	it('refuses a decider who has lost edit access to the board 403 (T58)', () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const flagId = raised(pat.account, decision);
		sqlite.prepare("UPDATE board_members SET role = 'viewer' WHERE board_id = ? AND user_id = ?").run(board.id, decider.id);
		const before = written();

		expect(outcome(() => reply(decider, decision, flagId))).toEqual({ status: 403, message: NOT_YOURS });
		expect(written()).toEqual(before);
	});

	it('refuses a reply through an API key 403, writing nothing (T34)', () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const flagId = raised(pat.account, decision);
		const before = written();

		expect(outcome(() => reply(decider, decision, flagId, { reply: 'By key.' }, API))).toEqual({ status: 403, message: REPLY_ACT });
		// Fail closed: any source but the page's is a key's.
		expect(outcome(() => reply(decider, decision, flagId, { reply: 'By key.' }, { source: 'cli' as ServiceOptions['source'] })), 'an unknown source').toEqual({
			status: 403,
			message: REPLY_ACT
		});
		expect(written()).toEqual(before);
	});

	it('refuses an empty reply 400, and a flag not of this decision, or one the reader leaves out, 404 (T35)', () => {
		const { decision, decider } = opened();
		const other = opened();
		const pat = withAccount(decision, 'pat');
		const flagId = raised(pat.account, decision);
		const elsewhere = raised(withAccount(other.decision, 'oda').account, other.decision);
		const planted = plant({ decisionId: decision.id, participantId: pat.participant.id, kind: 'veto', reason: 'Planted.' });
		const before = written();

		for (const [name, body] of [
			['no reply', {}],
			['an empty reply', { reply: '' }],
			['spaces', { reply: '  \n ' }]
		] as const) {
			expect(outcome(() => reply(decider, decision, flagId, body)), name).toEqual({ status: 400, message: 'reply is required' });
		}
		const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			for (const [name, id] of [
				['another decision’s flag', elsewhere],
				['a planted row the reader leaves out', planted],
				['no flag', planted + 100]
			] as const) {
				expect(outcome(() => reply(decider, decision, id)), name).toEqual({ status: 404, message: NOT_FOUND });
			}
		} finally {
			quiet.mockRestore();
		}
		expect(written()).toEqual(before);
	});

	it('refuses an objection’s reply on a ruled decision 409, and takes a talk outcome there (T36)', async () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const objection = raised(pat.account, decision);
		ageFlags(pat.participant.id, 11);
		const talk = raised(pat.account, decision, { kind: 'talk' });
		makeRuling(decision, { ruledAt: stamp() });
		const ruled = decisionRow(decision.id);
		const before = written();

		expect(outcome(() => reply(decider, ruled, objection))).toEqual({ status: 409, message: OBJECTION_PAST });
		expect(written()).toEqual(before);
		expect(outcome(() => reply(decider, ruled, talk, { reply: 'We spoke after the ruling.' })), 'a talk outcome').toBe('passed');
		expect(flagRow(talk).reply).toBe('We spoke after the ruling.');
		await sent.settle();
	});

	it('takes a talk outcome and refuses an objection’s reply on a superseded decision, and refuses both on a withdrawn one, 409 (T57)', async () => {
		const superseded = opened();
		const withdrawn = opened();
		const ids = new Map<number, { objection: number; talk: number }>();
		for (const { decision } of [superseded, withdrawn]) {
			const pat = withAccount(decision, 'pat');
			const objection = raised(pat.account, decision);
			ageFlags(pat.participant.id, 11);
			ids.set(decision.id, { objection, talk: raised(pat.account, decision, { kind: 'talk' }) });
		}
		makeRuling(superseded.decision, { ruledAt: stamp() });
		db.update(decisions).set({ status: 'superseded' }).where(eq(decisions.id, superseded.decision.id)).run();
		db.update(decisions).set({ status: 'withdrawn', withdrawnAt: stamp() }).where(eq(decisions.id, withdrawn.decision.id)).run();
		const before = written();

		const onSuperseded = ids.get(superseded.decision.id)!;
		expect(outcome(() => reply(superseded.decider, decisionRow(superseded.decision.id), onSuperseded.objection)), 'superseded, an objection').toEqual({
			status: 409,
			message: OBJECTION_PAST
		});
		const onWithdrawn = ids.get(withdrawn.decision.id)!;
		const WITHDRAWN = 'This decision is withdrawn: objections and requests to talk on it cannot be replied to';
		for (const [name, flagId] of [
			['withdrawn, an objection', onWithdrawn.objection],
			['withdrawn, a request to talk', onWithdrawn.talk]
		] as const) {
			expect(outcome(() => reply(withdrawn.decider, decisionRow(withdrawn.decision.id), flagId)), name).toEqual({ status: 409, message: WITHDRAWN });
		}
		expect(written()).toEqual(before);
		expect(outcome(() => reply(superseded.decider, decisionRow(superseded.decision.id), onSuperseded.talk)), 'superseded, a talk outcome').toBe('passed');
		await sent.settle();
	});

	it('gives a new decider every earlier flag on the results, the record and the person record, and the reply; the former decider none of them (T60)', async () => {
		const { decision, author, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const objection = raised(pat.account, decision, { kind: 'objection', reason: 'Raised before the change.' });
		ageFlags(pat.participant.id, 11);
		const talk = raised(pat.account, decision, { kind: 'talk' });
		const next = makeUser({ username: 'next' });
		addBoardMember(board, next, 'editor');

		as(author, (caller) => setDecider(caller, { decisionId: decision.id }, { deciderUserId: next.id, revision: revisionFor(decision.id) }, UI));
		await fresh();

		// The new decider: all three views, with names, and every reply.
		expect(readResults(next, decision.id, PAGE).flags?.map((flag) => [flag.flagId, flag.name, flag.reason])).toEqual([
			[objection, pat.participant.name, 'Raised before the change.'],
			[talk, pat.participant.name, '']
		]);
		const entries = readRecord(next, decision.id, { participant: null, after: null }, { source: 'ui', limit: 500 }).entries;
		expect(entries.filter((entry) => entry.kind === 'objection_raised' || entry.kind === 'talk_requested').map((entry) => [entry.kind, entry.participant])).toEqual([
			['objection_raised', pat.participant.name],
			['talk_requested', pat.participant.name]
		]);
		const record = readPersonRecord(next, pat.person.id, { before: null }, PAGE);
		if (record.audience !== 'decider') throw new Error('the decider’s person record was expected');
		expect(record.participations.flatMap((participation) => participation.flags.map((flag) => flag.reason))).toEqual(['Raised before the change.', '']);
		expect(outcome(() => reply(next, decisionRow(decision.id), objection, { reply: 'Answered by the new decider.' })), 'the new decider replies').toBe('passed');

		// The former decider: none of the three, and no reply.
		expect(outcome(() => readResults(decider, decision.id, PAGE)), 'results').toEqual({ status: 403, message: 'You cannot read the results of this decision' });
		expect(outcome(() => readRecord(decider, decision.id, { participant: null, after: null }, { source: 'ui', limit: 500 })), 'record').toEqual({
			status: 403,
			message: 'You cannot read the record of this decision'
		});
		expect(outcome(() => readPersonRecord(decider, pat.person.id, { before: null }, PAGE)), 'person record').toEqual({ status: 404, message: 'Person not found' });
		const before = written();
		expect(outcome(() => reply(decider, decisionRow(decision.id), talk)), 'a reply').toEqual({ status: 403, message: NOT_YOURS });
		expect(written()).toEqual(before);
		await sent.settle();
	});

	it('gives mayReply to the decider with board edit alone: an administrator reads false, and a decider who has lost board edit is given no results to reply from (T64)', () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		raised(pat.account, decision);
		const admin = makeUser({ username: 'admin', role: 'admin' });

		expect(readResults(decider, decision.id, PAGE).mayReply, 'the decider').toBe(true);
		expect(readResults(admin, decision.id, PAGE).mayReply, 'an administrator').toBe(false);
		sqlite.prepare("UPDATE board_members SET role = 'viewer' WHERE board_id = ? AND user_id = ?").run(board.id, decider.id);
		// The results are the decider's with board edit too, so no page carries a mayReply to them at all.
		expect(outcome(() => readResults(decider, decision.id, PAGE)), 'a decider without board edit').toEqual({ status: 403, message: 'You cannot read the results of this decision' });
	});

	it('tells a link holder whose link may no longer work to ask for a new one, with no link in the notice (T65)', async () => {
		const { decision, decider } = opened();
		// No invitation delivered with their link: the link they hold may not be one that works.
		const lia = withLink(decision, 'token-t65');
		raiseByLink('token-t65', { kind: 'talk' });
		const flagId = lastFlagId();
		await fresh();

		reply(decider, decision, flagId, { reply: 'We spoke.' });

		expect(replies(decision.id).at(-1)?.detail.notice).toBe('asked');
		await sent.settle();
		expect(replyMails().map((mail) => mail.to)).toEqual([lia.participant.email]);
		const [mail] = replyMails();
		expect(mail.html).toContain(ASK_FOR_LINK_LINE);
		expect(mail.html).not.toContain(LATEST_LINK_LINE);
		expect(mail.html).not.toMatch(/\/decision-link\/|\/decisions\/|href=/);
		expect(eventsOf(decision.id).filter((event) => event.kind === 'link_issued')).toEqual([]);
	});
});

describe('the reply route through the gate', () => {
	beforeAll(async () => {
		await gateRoutes();
	}, 30_000);

	it('refuses a cross-site or non-JSON post before reading its body, and reads it from the page (T63)', async () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		raise(pat.account, decision);
		const flagId = (sqlite.prepare('SELECT MAX(id) AS id FROM decision_flags').get() as { id: number }).id;
		const path = `/api/decisions/${decision.id}/flags/${flagId}/reply`;
		const session = makeSession(decider);

		/** Posts `{ reply }` with its body held back: whether it was read before the answer came, and the answer. */
		const post = async (headers: Record<string, string>) => {
			const held = heldBody({ reply: 'Through the gate.' });
			const answered = gate('POST', path, { headers: { accept: 'application/json', cookie: `${SESSION_COOKIE_NAME}=${session}`, ...headers }, body: held.body });
			const first = await Promise.race([held.wasAsked.then(() => 'asked' as const), answered.then(() => 'answered' as const)]);
			if (first === 'asked') held.release();
			const res = await answered;
			return { first, status: res.status, body: await res.json() };
		};

		const before = written();
		for (const [name, headers, status, message] of [
			// The page's own Origin, as T20 sends, or SvelteKit refuses a form's type before the gate.
			['text/plain', { ...FROM_THE_PAGE, origin: 'http://localhost', 'content-type': 'text/plain' }, 415, 'This route takes JSON only'],
			['Sec-Fetch-Site: cross-site', { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, 403, 'Cross-site requests are refused'],
			['another Origin', { 'content-type': 'application/json', origin: 'https://elsewhere.example.test' }, 403, 'Cross-site requests are refused']
		] as const) {
			expect(await post(headers), name).toEqual({ first: 'answered', status, body: { message } });
		}
		expect(written(), 'refused before the body').toEqual(before);

		// From the page: the body is read, and the reply recorded.
		const taken = await post({ ...FROM_THE_PAGE, 'content-type': 'application/json' });
		expect([taken.first, taken.status, taken.body.flag?.reply]).toEqual(['asked', 200, 'Through the gate.']);
		await sent.settle();
	});
});
