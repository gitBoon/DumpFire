/**
 * A participant's part in a decision (card 2677): a response, and being
 * recorded as having seen a version, signed in or by a personal link
 * (`respondToDecision`, `respondByLink`, `recordSeen` and `recordSeenByLink`
 * in `src/lib/server/decisions.ts`, and their rows in
 * `src/lib/server/decision-record.ts`), slice 1; what the page is given
 * (`readDecisionPage` and `readLinkPage` in `src/lib/server/decision-view.ts`),
 * and the four routes' same-origin guard through the gate, slice 2; the
 * personal link's page through the gate (its headers, no session, the one 404
 * and the wrong-link limit), slice 3. What the pages draw is in
 * `decision-participation.svelte.test.ts`.
 *
 * Each write is called as a route will call it, inside `writeAs` and handed
 * its `caller` (`{}` as the locals for a link holder with no session), with
 * `effects()` installed. A reader's own refusals are `request-body.test.ts`'s
 * and role refusals the access table's; neither is repeated. Case 1 alone
 * asserts that nothing else hears of a response. The cap is written as 50:
 * `RESPONSES_PER_ROUND` is private to the service (D5). The cases are the
 * plan's, `docs/planning/card-2677-participant-page.md`, section 6, by
 * number.
 */
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { addressToCount } from '$lib/server/client-address';
import { appendEvent, SYSTEM_ACTOR } from '$lib/server/decision-record';
import { readDecisionPage, readLinkPage, refuseWrongLink } from '$lib/server/decision-view';
import { requireSameOriginJson } from '$lib/server/same-origin';
import { subscribeToLogs, type LogEntry } from '$lib/server/logger';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { decisions, people, peopleGroupMembers, peopleGroups, type Board, type Decision, type DecisionOption } from '$lib/server/db/schema';
import { recordSeen, recordSeenByLink, releaseResults, respondByLink, respondToDecision } from '$lib/server/decisions';
import { resultsRevisionFor } from '$lib/server/decision-results';
import { writeAs, type ServiceOptions } from '$lib/server/write-as';
import { DEAD_DECISION_LINK, STALE_REVISION, tooManyWrongLinks, WHO_SEES_STATEMENT_VERSION } from '$lib/decision-words';
import { stamp } from '$lib/timestamps';
import { effects, type Effects } from './helpers/effects';
import {
	addBoardMember,
	makeBoard,
	makeDecision,
	makeOption,
	makeParticipant,
	makePerson,
	makeResponse,
	makeRuling,
	makeSession,
	makeSmtp,
	makeUser,
	makeVersion,
	makeWebhook,
	resetDb
} from './helpers/fixtures';
import { gate, gateRoutes } from './helpers/gate';

const UI: ServiceOptions = { source: 'ui' };
const API: ServiceOptions = { source: 'api' };
const FUTURE = '2099-01-01 12:00:00';
const STAMPED = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const DAY = 24 * 60 * 60 * 1000;

let sent: Effects;
let owner: SessionUser;
let board: Board;

beforeEach(() => {
	resetDb();
	makeSmtp();
	owner = makeUser({ username: 'owner' });
	board = makeBoard({ owner, name: 'The board' }).board;
	sent = effects();
});

afterEach(() => {
	sent.restore();
});

/** Call a write as `user`, or as a link holder with no session for null, as a route calls it inside its writeAs callback. */
const as = <T>(user: SessionUser | null, write: (caller: SessionUser | null) => T): T =>
	writeAs((user === null ? {} : { user }) as App.Locals, write as never) as T;

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

type EventRow = { kind: string; participantId: number | null; versionNumber: number | null; detail: any; actorUserId: number | null; actorName: string; source: string };

/** The decision's events of a participant's own part, `responded` and `seen`, in order, their detail read. */
function ownEventsOf(decisionId: number): EventRow[] {
	return (
		sqlite
			.prepare(
				'SELECT kind, participant_id AS participantId, version_number AS versionNumber, detail, actor_user_id AS actorUserId, actor_name AS actorName, source ' +
					"FROM decision_events WHERE decision_id = ? AND kind IN ('responded', 'seen') ORDER BY id"
			)
			.all(decisionId) as (Omit<EventRow, 'detail'> & { detail: string | null })[]
	).map((row) => ({ ...row, detail: row.detail === null ? null : JSON.parse(row.detail) }));
}

type ResponseRow = {
	id: number;
	versionNumber: number;
	round: number;
	kind: string;
	optionId: number | null;
	scores: string | null;
	comment: string | null;
	optionComments: string | null;
	replacesId: number | null;
	via: string;
	createdAt: string;
};

/** The decision's response rows, in order. */
const responsesOf = (decisionId: number) =>
	sqlite
		.prepare(
			'SELECT id, version_number AS versionNumber, round, kind, option_id AS optionId, scores, comment, option_comments AS optionComments, ' +
				'replaces_id AS replacesId, via, created_at AS createdAt FROM decision_responses WHERE decision_id = ? ORDER BY id'
		)
		.all(decisionId) as ResponseRow[];

const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
/** What a participant's writes write: response rows, and their `responded` and `seen` events. */
const written = () => ({
	responses: count('decision_responses'),
	events: (sqlite.prepare("SELECT COUNT(*) AS n FROM decision_events WHERE kind IN ('responded', 'seen')").get() as { n: number }).n
});
const decisionRow = (id: number) => db.select().from(decisions).where(eq(decisions.id, id)).get()!;

/**
 * An opened decision on the board, as `openDecision` leaves one: version 1,
 * asking for views, with options A, B and C live in it, and option N made but
 * never published. `extra` is more of version 1's content, made from the
 * options (card 2677, slice 2).
 */
function opened(row: Partial<Decision> = {}, extra: (o: { a: DecisionOption; b: DecisionOption; c: DecisionOption }) => Record<string, unknown> = () => ({})) {
	const decider = makeUser({ username: `decider${count('users')}` });
	addBoardMember(board, decider, 'editor');
	const made = makeDecision({ board, author: decider, decider, status: 'open', closesAt: FUTURE, openedAt: '2026-11-01 09:00:00', ...row });
	const a = makeOption(made, { label: 'A', position: 0, addedInVersion: 1 });
	const b = makeOption(made, { label: 'B', position: 1, addedInVersion: 1 });
	const c = makeOption(made, { label: 'C', position: 2, addedInVersion: 1 });
	const unpublished = makeOption(made, { label: 'N', position: 3 });
	makeVersion(made, { situation: 'Money is short.', options: [a, b, c].map((o) => ({ optionId: o.id, label: o.label, title: o.label })), ...extra({ a, b, c }) }, { number: 1 });
	return { decision: decisionRow(made.id), a, b, c, unpublished, decider };
}

/** A participant of the decision reached through their account. */
function withAccount(decision: Decision, role: 'consulted' | 'informed' = 'consulted', username = 'pat') {
	const account = makeUser({ username });
	const person = makePerson({ fullName: `${username} Page`, user: account });
	const participant = makeParticipant(decision, { person, role });
	return { account, person, participant };
}

/** A participant of the decision with no account, holding a personal link. */
function withLink(decision: Decision, token: string, role: 'consulted' | 'informed' = 'consulted') {
	const person = makePerson({ fullName: `Linky ${token}` });
	const participant = makeParticipant(decision, { person, role, token });
	return { person, participant };
}

const respond = (user: SessionUser, decision: Decision, body: Record<string, unknown>, opts = UI) =>
	as(user, (caller) => respondToDecision(caller, { decisionId: decision.id }, body, opts));
const respondWith = (user: SessionUser | null, token: string, body: Record<string, unknown>) =>
	as(user, (caller) => respondByLink(caller, { token }, body, UI));
const seen = (user: SessionUser, decision: Decision, body: Record<string, unknown>, opts = UI) =>
	as(user, (caller) => recordSeen(caller, { decisionId: decision.id }, body, opts));

// ─── Responses (cases 1 to 9) ────────────────────────────────────────────────

describe('respondToDecision', () => {
	it('records a consulted participant’s vote as one row, a responded and a seen event, and answers the one projection; nothing else hears of it (1)', async () => {
		const { decision, a, b } = opened();
		const { account, participant } = withAccount(decision);
		makeWebhook(board);

		const answer = respond(account, decision, {
			versionNumber: 1,
			kind: 'vote',
			optionId: a.id,
			comment: '  Lean is enough.  ',
			optionComments: { [b.id]: ' Too dear. ' }
		});

		const [row] = responsesOf(decision.id);
		expect(responsesOf(decision.id)).toEqual([
			{
				id: expect.any(Number),
				versionNumber: 1,
				round: 1,
				kind: 'vote',
				optionId: a.id,
				scores: null,
				comment: 'Lean is enough.',
				optionComments: JSON.stringify({ [b.id]: 'Too dear.' }),
				replacesId: null,
				via: 'session',
				createdAt: expect.stringMatching(STAMPED)
			}
		]);
		// OwnResponse, whole: no id, decisionId, participantId or replacesId.
		expect(answer).toEqual({
			response: {
				versionNumber: 1,
				round: 1,
				kind: 'vote',
				optionId: a.id,
				scores: null,
				comment: 'Lean is enough.',
				optionComments: { [b.id]: 'Too dear.' },
				createdAt: row.createdAt
			},
			unchanged: false
		});
		expect(ownEventsOf(decision.id)).toEqual([
			{ kind: 'responded', participantId: participant.id, versionNumber: 1, detail: { responseId: row.id }, actorUserId: account.id, actorName: 'pat', source: 'ui' },
			{ kind: 'seen', participantId: participant.id, versionNumber: 1, detail: { stage: 'question' }, actorUserId: account.id, actorName: 'pat', source: 'ui' }
		]);
		await sent.settle();
		expect(count('activity_log')).toBe(0);
		expect(sent.all).toEqual([]);
	});

	it('writes a change of answer as a new row replacing the last, and an answer the same as the last as nothing (2)', () => {
		const { decision, a } = opened();
		const { account } = withAccount(decision);

		respond(account, decision, { versionNumber: 1, kind: 'vote', optionId: a.id });
		const [first] = responsesOf(decision.id);
		respond(account, decision, { versionNumber: 1, kind: 'abstain' });
		const last = respond(account, decision, { versionNumber: 1, kind: 'no_concerns' });

		const rows = responsesOf(decision.id);
		expect(rows.map((row) => [row.kind, row.replacesId])).toEqual([
			['vote', null],
			['abstain', rows[0].id],
			['no_concerns', rows[1].id]
		]);
		expect(rows[0]).toEqual(first);
		expect(ownEventsOf(decision.id).filter((event) => event.kind === 'seen')).toHaveLength(1);

		const again = respond(account, decision, { versionNumber: 1, kind: 'no_concerns' });
		expect(responsesOf(decision.id)).toHaveLength(3);
		expect(again).toEqual({ response: last.response, unchanged: true });
		expect(ownEventsOf(decision.id).filter((event) => event.kind === 'responded')).toHaveLength(3);
	});

	it('binds the same answer, confirmed after a re-publish that only tells, to the new version: a new row with its responded and seen events (2, code review C1)', () => {
		const { decision, a } = opened();
		const { account, participant } = withAccount(decision);
		respond(account, decision, { versionNumber: 1, kind: 'vote', optionId: a.id });
		makeVersion(decision, {}, { number: 2, asksAgain: false });

		const confirmed = respond(account, decisionRow(decision.id), { versionNumber: 2, kind: 'vote', optionId: a.id });

		const rows = responsesOf(decision.id);
		expect(rows.map((row) => [row.versionNumber, row.round, row.optionId, row.replacesId])).toEqual([
			[1, 1, a.id, null],
			[2, 1, a.id, rows[0].id]
		]);
		expect(confirmed).toEqual({ response: expect.objectContaining({ versionNumber: 2, round: 1, optionId: a.id }), unchanged: false });
		expect(ownEventsOf(decision.id).map((event) => [event.kind, event.participantId, event.versionNumber, event.detail])).toEqual([
			['responded', participant.id, 1, { responseId: rows[0].id }],
			['seen', participant.id, 1, { stage: 'question' }],
			['responded', participant.id, 2, { responseId: rows[1].id }],
			['seen', participant.id, 2, { stage: 'question' }]
		]);
		// The same again on version 2 is now the unchanged answer.
		expect(respond(account, decisionRow(decision.id), { versionNumber: 2, kind: 'vote', optionId: a.id }).unchanged).toBe(true);
		expect(responsesOf(decision.id)).toHaveLength(2);
	});

	it('saves a score for every live option, built from the live ids in their order, with no option (3)', () => {
		const { decision, a, b, c } = opened({ voteMode: 'score' });
		const { account } = withAccount(decision);

		const answer = respond(account, decision, { versionNumber: 1, kind: 'vote', scores: { [c.id]: 5, [b.id]: 0, [a.id]: 3 } });

		const [row] = responsesOf(decision.id);
		expect(row).toMatchObject({ kind: 'vote', optionId: null });
		expect(row.scores).toBe(JSON.stringify({ [a.id]: 3, [b.id]: 0, [c.id]: 5 }));
		expect(Object.keys(JSON.parse(row.scores!))).toEqual([a, b, c].map((option) => `${option.id}`));
		expect(answer.response.scores).toEqual({ [a.id]: 3, [b.id]: 0, [c.id]: 5 });
	});

	it('refuses each score-mode body that is not a whole score for every live option and no other, writing nothing (4)', () => {
		const { decision, a, b, c, unpublished } = opened({ voteMode: 'score' });
		const { account } = withAccount(decision);
		const full = { [a.id]: 1, [b.id]: 2, [c.id]: 3 };
		const rows: [string, Record<string, unknown>, RegExp][] = [
			['(a) a live option with no score', { scores: { [a.id]: 1, [b.id]: 2 } }, new RegExp(`^scores must hold a score for every option: option ${c.id}`)],
			['(b) a score of 6', { scores: { ...full, [a.id]: 6 } }, new RegExp(`^scores\\.${a.id} must be a whole number from 0 to 5$`)],
			['(c) a score of 2.5', { scores: { ...full, [a.id]: 2.5 } }, new RegExp(`^scores\\.${a.id} must be a whole number from 0 to 5$`)],
			['(d) a score for an option not live', { scores: { ...full, [unpublished.id]: 1 } }, new RegExp(`^scores\\.${unpublished.id} is not a field of`)],
			['(e) optionId sent', { scores: full, optionId: a.id }, /^optionId cannot be sent/],
			[
				'(f) a __proto__ key, sent as raw JSON',
				{ scores: JSON.parse(`{"__proto__": 1, "${a.id}": 1, "${b.id}": 2, "${c.id}": 3}`) },
				/^scores\.__proto__ is not a field of/
			]
		];
		for (const [name, extra, words] of rows) {
			const result = outcome(() => respond(account, decision, { versionNumber: 1, kind: 'vote', ...extra }));
			expect(result, name).toEqual({ status: 400, message: expect.stringMatching(words) });
		}
		expect(written()).toEqual({ responses: 0, events: 0 });
	});

	it('refuses each single-mode body that is not one, naming the field and writing nothing (5)', () => {
		const { decision, a, b } = opened();
		// Version 2 asks again, with option B retired in it.
		makeVersion(decision, {}, { number: 2, asksAgain: true });
		sqlite.prepare('UPDATE decision_options SET retired_in_version = 2 WHERE id = ?').run(b.id);
		const { account } = withAccount(decision);
		const at2 = decisionRow(decision.id);
		const rows: [string, Record<string, unknown>, string][] = [
			['(a) kind concern', { versionNumber: 2, kind: 'concern' }, 'kind'],
			['(b) a vote with no optionId', { versionNumber: 2, kind: 'vote' }, 'optionId'],
			['(c) an optionId retired in the current version', { versionNumber: 2, kind: 'vote', optionId: b.id }, 'optionId'],
			['(d) scores sent', { versionNumber: 2, kind: 'vote', optionId: a.id, scores: { [a.id]: 1 } }, 'scores'],
			['(e) abstain with an optionId', { versionNumber: 2, kind: 'abstain', optionId: a.id }, 'optionId'],
			['(f) a comment holding U+202E', { versionNumber: 2, kind: 'abstain', comment: 'Fine ‮enif' }, 'comment'],
			['(g) an option comment for an option not live', { versionNumber: 2, kind: 'abstain', optionComments: { [b.id]: 'Gone' } }, `optionComments.${b.id}`],
			['(h) no versionNumber', { kind: 'abstain' }, 'versionNumber'],
			['(i) a constructor key in optionComments, sent as raw JSON', { versionNumber: 2, kind: 'abstain', optionComments: JSON.parse('{"constructor": "x"}') }, 'optionComments.constructor']
		];
		for (const [name, body, field] of rows) {
			const result = outcome(() => respond(account, at2, body));
			expect(result, name).toEqual({ status: 400, message: expect.stringContaining(field) });
		}
		expect(written()).toEqual({ responses: 0, events: 0 });
	});

	it('refuses, 409, a decision past its closing time or closed, and a version that is not the current one, writing nothing (6)', () => {
		const { decision: pastIt, a } = opened({ closesAt: '2026-01-01 00:00:00' });
		const { decision: closed, a: closedA } = opened({ status: 'closed' });
		const { decision: changed, a: changedA } = opened();
		makeVersion(changed, {}, { number: 2, asksAgain: false });
		const first = withAccount(pastIt, 'consulted', 'pat');
		const second = withAccount(closed, 'consulted', 'sam');
		const third = withAccount(changed, 'consulted', 'kim');

		expect(outcome(() => respond(first.account, pastIt, { versionNumber: 1, kind: 'vote', optionId: a.id })), '(a)').toEqual({
			status: 409,
			message: 'This decision is awaiting a ruling: responses are closed'
		});
		expect(outcome(() => respond(second.account, closed, { versionNumber: 1, kind: 'vote', optionId: closedA.id })), '(b)').toEqual({
			status: 409,
			message: 'This decision is awaiting a ruling: responses are closed'
		});
		expect(outcome(() => respond(third.account, decisionRow(changed.id), { versionNumber: 1, kind: 'vote', optionId: changedA.id })), '(c)').toEqual({
			status: 409,
			message: STALE_REVISION
		});
		expect(written()).toEqual({ responses: 0, events: 0 });
	});

	it('gives a response after a re-publish asking again round 2, replacing nothing, and leaves round 1’s rows as they were (7)', () => {
		const { decision, a, b } = opened();
		const { account } = withAccount(decision);
		respond(account, decision, { versionNumber: 1, kind: 'vote', optionId: a.id });
		const roundOne = responsesOf(decision.id);

		makeVersion(decision, {}, { number: 2, asksAgain: true });
		respond(account, decisionRow(decision.id), { versionNumber: 2, kind: 'vote', optionId: b.id });

		const rows = responsesOf(decision.id);
		expect(rows[0]).toEqual(roundOne[0]);
		expect(rows[1]).toMatchObject({ versionNumber: 2, round: 2, optionId: b.id, replacesId: null });
	});

	it('refuses, 403, an informed participant, an API key, and a participant no longer reached, writing nothing (8)', () => {
		const { decision, a } = opened();
		const consulted = withAccount(decision, 'consulted', 'pat');
		const informed = withAccount(decision, 'informed', 'ida');
		const vote = { versionNumber: 1, kind: 'vote', optionId: a.id };

		expect(outcome(() => respond(informed.account, decision, vote)), '(a)').toEqual({ status: 403, message: 'Someone kept informed gives no response' });
		expect(outcome(() => respond(consulted.account, decision, vote, API)), '(b)').toEqual({
			status: 403,
			message: "Responding is a person's act: it cannot be done with an API key"
		});
		expect(outcome(() => seen(consulted.account, decision, { versionNumber: 1, stage: 'question' }, API)), '(c)').toEqual({
			status: 403,
			message: "Being recorded as having seen a decision is a person's act: it cannot be done with an API key"
		});

		// (d) The person has left: the row still holds the account, and reachOf no longer reaches them through it (D12).
		db.update(people).set({ status: 'left', leftAt: '2026-11-02 09:00:00' }).where(eq(people.id, consulted.person.id)).run();
		const gone = { status: 403, message: 'This decision no longer reaches you as a participant: ask whoever sent it to you' };
		expect(outcome(() => respond(consulted.account, decision, vote)), '(d) respond').toEqual(gone);
		expect(outcome(() => seen(consulted.account, decision, { versionNumber: 1, stage: 'question' })), '(d) seen').toEqual(gone);
		expect(written()).toEqual({ responses: 0, events: 0 });
	});

	it('refuses, 409, a 51st response in a round, writing nothing (9)', () => {
		const { decision, a } = opened();
		const { account, participant } = withAccount(decision);
		for (let n = 0; n < 50; n++) makeResponse(participant, { round: 1, kind: 'abstain' });

		expect(outcome(() => respond(account, decision, { versionNumber: 1, kind: 'vote', optionId: a.id }))).toEqual({
			status: 409,
			message: 'You have changed your response too many times in this round: ask the decider'
		});
		expect(written()).toEqual({ responses: 50, events: 0 });
	});
});

// ─── By a personal link (cases 10 and 11) ────────────────────────────────────

describe('respondByLink', () => {
	it('records the link holder as the actor with the link’s source, and a signed-in browser’s account beside it, with no session made (10)', () => {
		const { decision, a, b } = opened();
		const { participant } = withLink(decision, 'token-one');
		const browser = makeUser({ username: 'browser' });
		const sessions = count('sessions');

		respondWith(null, 'token-one', { versionNumber: 1, kind: 'vote', optionId: a.id });
		respondWith(browser, 'token-one', { versionNumber: 1, kind: 'vote', optionId: b.id });

		const rows = responsesOf(decision.id);
		expect(rows.map((row) => row.via)).toEqual(['link', 'link']);
		const holder = { participantId: participant.id, versionNumber: 1, actorUserId: null, actorName: participant.name, source: 'link' };
		expect(ownEventsOf(decision.id)).toEqual([
			{ kind: 'responded', ...holder, detail: { responseId: rows[0].id } },
			{ kind: 'seen', ...holder, detail: { stage: 'question' } },
			{ kind: 'responded', ...holder, detail: { responseId: rows[1].id, signedIn: { userId: browser.id, name: 'browser' } } }
		]);

		const other = withLink(decision, 'token-two');
		expect(as(browser, (caller) => recordSeenByLink(caller, { token: 'token-two' }, { versionNumber: 1, stage: 'question' }, UI))).toEqual({ recorded: true });
		expect(ownEventsOf(decision.id).at(-1)).toEqual({
			kind: 'seen',
			participantId: other.participant.id,
			versionNumber: 1,
			detail: { stage: 'question', signedIn: { userId: browser.id, name: 'browser' } },
			actorUserId: null,
			actorName: other.participant.name,
			source: 'link'
		});
		expect(count('sessions')).toBe(sessions);
	});

	it('answers every link that opens no decision with the one 404, writing nothing (11)', () => {
		const { decision, a } = opened();
		const ruledLong = opened({ status: 'ruled', ruledAt: stamp(new Date(Date.now() - 91 * DAY)) });
		withLink(ruledLong.decision, 'token-ruled');
		makeParticipant(decision, { person: makePerson(), token: 'token-removed', removedAt: '2026-11-02 09:00:00' });
		const left = withLink(decision, 'token-left');
		db.update(people).set({ status: 'left', leftAt: '2026-11-02 09:00:00' }).where(eq(people.id, left.person.id)).run();

		const rows: [string, string, number][] = [
			['(a) a token never issued', 'token-never', a.id],
			['(b) a link on a decision ruled 91 days ago', 'token-ruled', ruledLong.a.id],
			['(c) a removed participant’s former token', 'token-removed', a.id],
			['(d) a person marked left since the link was issued', 'token-left', a.id]
		];
		for (const [name, token, optionId] of rows) {
			expect(outcome(() => respondWith(null, token, { versionNumber: 1, kind: 'vote', optionId })), name).toEqual({ status: 404, message: DEAD_DECISION_LINK });
		}
		expect(written()).toEqual({ responses: 0, events: 0 });
	});
});

// ─── Being recorded as having seen (cases 12 and 13) ─────────────────────────

describe('recordSeen and recordSeenByLink', () => {
	it('records one seen event per version and stage, the ruling’s and the withdrawal’s among them (12)', () => {
		const { decision } = opened();
		const { account, participant } = withAccount(decision);

		expect(seen(account, decision, { versionNumber: 1, stage: 'question' })).toEqual({ recorded: true });
		expect(seen(account, decision, { versionNumber: 1, stage: 'question' })).toEqual({ recorded: false });
		makeVersion(decision, {}, { number: 2, asksAgain: false });
		expect(seen(account, decisionRow(decision.id), { versionNumber: 2, stage: 'question' })).toEqual({ recorded: true });
		expect(ownEventsOf(decision.id).map((event) => [event.kind, event.participantId, event.versionNumber, event.detail])).toEqual([
			['seen', participant.id, 1, { stage: 'question' }],
			['seen', participant.id, 2, { stage: 'question' }]
		]);

		const ruled = opened({ status: 'ruled', ruledAt: stamp(new Date(Date.now() - 10 * DAY)) });
		const holder = withLink(ruled.decision, 'token-ruled', 'informed');
		expect(as(null, (caller) => recordSeenByLink(caller, { token: 'token-ruled' }, { versionNumber: 1, stage: 'ruling' }, UI))).toEqual({ recorded: true });
		expect(ownEventsOf(ruled.decision.id)).toEqual([
			{ kind: 'seen', participantId: holder.participant.id, versionNumber: 1, detail: { stage: 'ruling' }, actorUserId: null, actorName: holder.participant.name, source: 'link' }
		]);

		const withdrawn = opened({ status: 'withdrawn', withdrawnAt: '2026-11-02 09:00:00', withdrawnReason: 'Overtaken' });
		const reader = withAccount(withdrawn.decision, 'informed', 'wes');
		expect(seen(reader.account, withdrawn.decision, { versionNumber: 1, stage: 'withdrawal' })).toEqual({ recorded: true });
		expect(ownEventsOf(withdrawn.decision.id).map((event) => [event.kind, event.detail, event.source])).toEqual([['seen', { stage: 'withdrawal' }, 'ui']]);
	});

	it('refuses a stage the status does not have, a version not published, and a caller who is no participant, writing nothing (13)', () => {
		const { decision } = opened();
		const { account } = withAccount(decision);
		const reader = makeUser({ username: 'reader' });
		addBoardMember(board, reader, 'viewer');

		expect(outcome(() => seen(account, decision, { versionNumber: 1, stage: 'ruling' })), '(a)').toEqual({
			status: 409,
			message: 'This decision has not been ruled on: there is no ruling to have seen'
		});
		expect(outcome(() => seen(account, decision, { versionNumber: 1, stage: 'withdrawal' })), '(b)').toEqual({
			status: 409,
			message: 'This decision has not been withdrawn: there is no withdrawal to have seen'
		});
		expect(outcome(() => seen(account, decision, { versionNumber: 0, stage: 'question' })), '(c) 0').toEqual({
			status: 400,
			message: 'versionNumber must be at least 1'
		});
		expect(outcome(() => seen(account, decision, { versionNumber: 2, stage: 'question' })), '(c) above').toEqual({
			status: 400,
			message: 'versionNumber 2 is not the current version of this decision'
		});
		expect(outcome(() => seen(reader, decision, { versionNumber: 1, stage: 'question' })), '(d)').toEqual({
			status: 403,
			message: 'Only a participant of this decision is recorded as having seen it'
		});
		// (e) An earlier version, once a later one is published (code review C4).
		makeVersion(decision, {}, { number: 2, asksAgain: false });
		expect(outcome(() => seen(account, decisionRow(decision.id), { versionNumber: 1, stage: 'question' })), '(e) earlier').toEqual({
			status: 400,
			message: 'versionNumber 1 is not the current version of this decision'
		});
		expect(written()).toEqual({ responses: 0, events: 0 });
	});
});

// ─── What the page is given (cases 14 to 19) ─────────────────────────────────

/** Every key anywhere in `value`, as the page is handed it, with the value it holds. */
function entriesIn(value: unknown, into: [string, unknown][] = []): [string, unknown][] {
	if (Array.isArray(value)) for (const item of value) entriesIn(item, into);
	else if (value !== null && typeof value === 'object') {
		for (const [key, inner] of Object.entries(value)) {
			into.push([key, inner]);
			entriesIn(inner, into);
		}
	}
	return into;
}

/** The keys no answer of the page holds, anywhere in it (decision 16, R3, D3). */
const NEVER_GIVEN = ['userId', 'byUserId', 'byName', 'groupId', 'deciderUserId', 'authorUserId', 'email', 'linkTokenHash', 'participantId', 'decisionId', 'replacesId'];
const ADDRESS = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const keysGiven = (page: unknown) => entriesIn(page).map(([key]) => key).filter((key) => NEVER_GIVEN.includes(key));

/** Two groups of the directory. */
function groups() {
	return {
		finance: db.insert(peopleGroups).values({ name: 'Finance' }).returning().get(),
		sales: db.insert(peopleGroups).values({ name: 'Sales' }).returning().get()
	};
}
const join = (groupId: number, personId: number) => void db.insert(peopleGroupMembers).values({ groupId, personId }).run();

/**
 * A decision opened with every section of content: agent flags on the
 * situation and option B, a review stamp on the question by a named reviewer,
 * a story, and audiences for Sales and then Finance.
 */
function fullyOpened(g: ReturnType<typeof groups>) {
	return opened({}, ({ b }) => ({
		question: 'Which plan?',
		ask: 'Choose one by Friday.',
		unknowns: 'The exact price.',
		alreadyRuled: 'The budget.',
		technicalDetail: 'Two servers.',
		audiences: [
			{ groupId: g.sales.id, heading: 'Sales', body: 'Fewer calls.' },
			{ groupId: g.finance.id, heading: 'Finance', body: 'A smaller bill.' }
		],
		stories: [{ title: 'As a buyer', body: 'I pay less.' }],
		agentDrafted: { situation: true, [`options.${b.id}`]: true },
		reviewed: { question: { byName: 'Rae Viewer', at: '2026-10-31 09:00:00' } }
	}));
}

/** What `fullyOpened`'s version gives a link holder as its content: the text, the story and the flags. */
const contentOf = (b: DecisionOption) => ({
	situation: 'Money is short.',
	question: 'Which plan?',
	ask: 'Choose one by Friday.',
	unknowns: 'The exact price.',
	alreadyRuled: 'The budget.',
	technicalDetail: 'Two servers.',
	stories: [{ title: 'As a buyer', body: 'I pay less.' }],
	agentDrafted: { situation: true, [`options.${b.id}`]: true }
});

/** Its options as the page shows them, with their labels, B flagged. */
const optionsOf = (o: { a: DecisionOption; b: DecisionOption; c: DecisionOption }) =>
	[o.a, o.b, o.c].map((option) => ({
		optionId: option.id,
		label: option.label,
		title: option.label,
		summary: '',
		pros: [],
		cons: [],
		commercial: '',
		agentDrafted: option.id === o.b.id
	}));

/** Its audiences to a member of Finance: theirs first and open. */
const FINANCE_FIRST = [
	{ heading: 'Finance', body: 'A smaller bill.', own: true, open: true },
	{ heading: 'Sales', body: 'Fewer calls.', own: false, open: false }
];

/** The participant's invitation, and its delivery's outcome (D8). */
function invite(decision: Decision, participantId: number, delivered: boolean) {
	const of = appendEvent({ decisionId: decision.id, kind: 'invited', participantId, versionNumber: 1 }, SYSTEM_ACTOR);
	appendEvent({ decisionId: decision.id, kind: 'mail_outcome', participantId, detail: { of, mail: 'invitation', delivered } }, SYSTEM_ACTOR);
}

describe('readDecisionPage and readLinkPage', () => {
	it('gives a consulted participant the allowlist alone: labelled options, the text with a reviewed yes, the banner’s facts and their latest response (14)', () => {
		const g = groups();
		const { decision, a, b, c } = fullyOpened(g);
		const { account, person, participant } = withAccount(decision);
		join(g.finance.id, person.id);
		invite(decision, participant.id, true);
		makeResponse(participant, { kind: 'abstain' });
		makeResponse(participant, {
			kind: 'vote',
			optionId: a.id,
			comment: 'A is enough.',
			optionComments: JSON.stringify({ [b.id]: 'Too dear.' }),
			createdAt: '2026-11-01 11:00:00'
		});

		const page = readDecisionPage(account, decision.id);

		expect(page).toEqual({
			via: 'session',
			decision: {
				id: decision.id,
				title: decision.title,
				shownStatus: 'open',
				voteMode: 'single',
				closesAt: FUTURE,
				deciderName: decision.deciderName,
				boardName: 'The board',
				withdrawnAt: null,
				withdrawnReason: null
			},
			draft: false,
			version: { number: 1, publishedAt: '2026-11-01 09:00:00', content: { ...contentOf(b), reviewed: { question: true } } },
			options: optionsOf({ a, b, c }),
			audiences: FINANCE_FIRST,
			participant: { role: 'consulted', includedAt: '2026-11-01 09:00:00', told: { kind: 'invited', at: expect.stringMatching(STAMPED), delivered: true } },
			ownResponse: {
				versionNumber: 1,
				round: 1,
				kind: 'vote',
				optionId: a.id,
				scores: null,
				comment: 'A is enough.',
				optionComments: { [b.id]: 'Too dear.' },
				createdAt: '2026-11-01 11:00:00'
			},
			earlierResponse: null,
			mayRespond: true,
			stage: 'question',
			mayEdit: false,
			signedInAs: null,
			// Card 2679 (decision 23): nothing ruled, released, raised or superseded; signed in, the results and supersede refused.
			ruling: null,
			released: null,
			concerns: [],
			mayRaiseConcern: false,
			supersedes: null,
			laterDecision: null,
			mayReadResults: false,
			maySupersede: false
		});
		expect(page.version!.content).not.toHaveProperty('options');
		expect(page.version!.content).not.toHaveProperty('audiences');
		expect(keysGiven(page)).toEqual([]);
		expect(JSON.stringify(page)).not.toMatch(ADDRESS);
		expect(JSON.stringify(page)).not.toContain('Rae Viewer');
	});

	it('gives nobody another participant’s response or name: the participant, a board reader, the decider or an administrator (15)', () => {
		const MARK = 'said-by-another-participant';
		const { decision, a, decider } = opened();
		const { account } = withAccount(decision);
		const other = makeParticipant(decision, { person: makePerson({ fullName: 'Olive Other' }), role: 'consulted' });
		makeResponse(other, { kind: 'vote', optionId: a.id, comment: MARK, optionComments: JSON.stringify({ [a.id]: MARK }) });
		const reader = makeUser({ username: 'reader' });
		addBoardMember(board, reader, 'viewer');
		const admin = makeUser({ username: 'admin', role: 'admin' });

		for (const [who, user] of [['the participant', account], ['a board reader', reader], ['the decider', decider], ['an administrator', admin]] as const) {
			const page = readDecisionPage(user, decision.id);
			expect(page.version?.number, who).toBe(1);
			expect(JSON.stringify(page), who).not.toContain(MARK);
			expect(JSON.stringify(page), who).not.toContain('Olive Other');
		}
	});

	it('puts the audience of the participant’s own group first and open, opens every one where none is theirs, and never takes a deleted group for theirs (16)', () => {
		const g = groups();
		const gone = db.insert(peopleGroups).values({ name: 'Gone' }).returning().get();
		const { decision } = opened({}, () => ({
			audiences: [
				{ groupId: g.sales.id, heading: 'Sales', body: '' },
				{ groupId: null, heading: 'Everyone', body: '' },
				{ groupId: g.finance.id, heading: 'Finance', body: '' },
				{ groupId: gone.id, heading: 'Gone', body: '' }
			]
		}));
		const member = withAccount(decision, 'consulted', 'fin');
		join(g.finance.id, member.person.id);
		join(gone.id, member.person.id);
		const outside = withAccount(decision, 'consulted', 'out');
		const former = withAccount(decision, 'consulted', 'was');
		join(gone.id, former.person.id);
		db.delete(peopleGroups).where(eq(peopleGroups.id, gone.id)).run();
		const shown = (user: SessionUser) => readDecisionPage(user, decision.id).audiences.map((audience) => [audience.heading, audience.own, audience.open]);
		const allOpen = [
			['Sales', false, true],
			['Everyone', false, true],
			['Finance', false, true],
			['Gone', false, true]
		];

		expect(shown(member.account), '(a)').toEqual([
			['Finance', true, true],
			['Sales', false, false],
			['Everyone', false, false],
			['Gone', false, false]
		]);
		expect(shown(outside.account), '(b)').toEqual(allOpen);
		expect(shown(former.account), '(c)').toEqual(allOpen);
	});

	it('gives a participant who has not answered since a re-publish asking again their earlier response, for its version (17)', () => {
		const { decision, a } = opened();
		const { account, participant } = withAccount(decision);
		makeResponse(participant, { kind: 'vote', optionId: a.id, versionNumber: 1, round: 1 });
		makeVersion(decision, { situation: 'Money is shorter.' }, { number: 2, asksAgain: true });

		const page = readDecisionPage(account, decision.id);

		expect(page.version?.number).toBe(2);
		expect(page.ownResponse).toBeNull();
		expect(page.earlierResponse).toEqual({
			versionNumber: 1,
			round: 1,
			kind: 'vote',
			optionId: a.id,
			scores: null,
			comment: null,
			optionComments: {},
			createdAt: '2026-11-01 10:00:00'
		});
	});

	it('gives a board reader no part, a draft’s author nothing but whether they may edit it, and a participant never mailed the neutral facts (18)', () => {
		const { decision } = opened();
		const reader = makeUser({ username: 'reader' });
		addBoardMember(board, reader, 'viewer');
		const asReader = readDecisionPage(reader, decision.id);
		expect([asReader.participant, asReader.mayRespond, asReader.ownResponse, asReader.version?.number], '(a)').toEqual([null, false, null, 1]);

		const draft = makeDecision({ board, author: owner, decider: owner, title: 'Not yet opened' });
		const asAuthor = readDecisionPage(owner, draft.id);
		expect(
			{ draft: asAuthor.draft, mayEdit: asAuthor.mayEdit, version: asAuthor.version, options: asAuthor.options, audiences: asAuthor.audiences, participant: asAuthor.participant },
			'(b)'
		).toEqual({ draft: true, mayEdit: true, version: null, options: [], audiences: [], participant: null });

		const { account, participant } = withAccount(decision, 'consulted', 'sam');
		appendEvent({ decisionId: decision.id, kind: 'mail_skipped', participantId: participant.id, detail: { reason: 'left' } }, SYSTEM_ACTOR);
		expect(readDecisionPage(account, decision.id).participant, '(c)').toEqual({ role: 'consulted', includedAt: '2026-11-01 09:00:00', told: null });

		// (d) A ruled decision's participant posts the ruling's stage (card 2679, decision 9), and a board reader none (F7).
		const ruled = opened({ status: 'ruled', ruledAt: stamp(new Date(Date.now() - DAY)) });
		const rue = withAccount(ruled.decision, 'consulted', 'rue');
		expect(readDecisionPage(rue.account, ruled.decision.id).stage, '(d)').toBe('ruling');
		expect(readDecisionPage(reader, ruled.decision.id).stage, '(d) a reader').toBeNull();
	});

	it('gives a link holder the same page with no reviewed yes, no board’s name and no edit link, the signed-in name it is handed, and an unknown token nothing (19)', () => {
		const g = groups();
		const { decision, a, b, c } = fullyOpened(g);
		const { person, participant } = withLink(decision, 'token-page');
		join(g.finance.id, person.id);
		invite(decision, participant.id, true);

		const page = readLinkPage('token-page', null);

		expect(page).toEqual({
			via: 'link',
			decision: {
				title: decision.title,
				shownStatus: 'open',
				voteMode: 'single',
				closesAt: FUTURE,
				deciderName: decision.deciderName,
				boardName: null,
				withdrawnAt: null,
				withdrawnReason: null
			},
			draft: false,
			version: { number: 1, publishedAt: '2026-11-01 09:00:00', content: contentOf(b) },
			options: optionsOf({ a, b, c }),
			audiences: FINANCE_FIRST,
			participant: { role: 'consulted', includedAt: '2026-11-01 09:00:00', told: { kind: 'invited', at: expect.stringMatching(STAMPED), delivered: true } },
			ownResponse: null,
			earlierResponse: null,
			mayRespond: true,
			stage: 'question',
			mayEdit: false,
			signedInAs: null,
			// Card 2679 (decision 23): as signed in, and no results or supersede flag at all by a link.
			ruling: null,
			released: null,
			concerns: [],
			mayRaiseConcern: false,
			supersedes: null,
			laterDecision: null
		});
		expect(keysGiven(page)).toEqual([]);
		// No decision id anywhere in it (code review C5): an option's own id is the only id a link holder is given.
		expect(page!.decision).not.toHaveProperty('id');
		expect(entriesIn(page).filter(([key]) => key === 'id')).toEqual([]);
		expect(entriesIn(page).filter(([key, value]) => key === 'boardName' && value !== null)).toEqual([]);
		expect(JSON.stringify(page)).not.toMatch(ADDRESS);
		expect(JSON.stringify(page)).not.toContain('The board');
		expect(JSON.stringify(page)).not.toContain('Rae Viewer');
		expect(readLinkPage('token-page', 'browser')?.signedInAs).toBe('browser');
		expect(readLinkPage('token-never', null)).toBeNull();
	});

	it('gives none of NEVER_GIVEN on a ruled, released and superseded page, nor on the page superseding it, either way in (card 2679, code review F5)', async () => {
		const old = opened({ status: 'closed', closesAt: '2026-11-02 09:00:00' });
		const voters = ['vee', 'wes', 'xan'].map((name) => withAccount(old.decision, 'consulted', name));
		withLink(old.decision, 'token-never-given');
		voters.forEach((voter, index) => {
			const row = makeResponse(voter.participant, { kind: 'vote', optionId: old.a.id, comment: `Said by ${index}.` });
			appendEvent(
				{ decisionId: old.decision.id, kind: 'responded', participantId: voter.participant.id, versionNumber: 1, detail: { responseId: row.id, statement: WHO_SEES_STATEMENT_VERSION } },
				SYSTEM_ACTOR
			);
		});
		makeRuling(old.decision, { optionId: old.a.id, ruledAt: stamp() });
		as(old.decider, (caller) => releaseResults(caller, { decisionId: old.decision.id }, { revision: resultsRevisionFor(old.decision.id) }, UI));
		const next = opened({ status: 'closed', closesAt: '2026-11-02 09:00:00', supersedesId: old.decision.id, title: 'Again' });
		const nextsOwn = withAccount(next.decision, 'consulted', 'yul');
		makeRuling(next.decision, { optionId: next.a.id, ruledAt: stamp() });
		db.update(decisions).set({ status: 'superseded' }).where(eq(decisions.id, old.decision.id)).run();
		const reader = makeUser({ username: 'rae' });
		addBoardMember(board, reader, 'viewer');

		const pages = {
			'the participant': readDecisionPage(voters[0].account, old.decision.id),
			'a board reader': readDecisionPage(reader, old.decision.id),
			'the decider': readDecisionPage(old.decider, old.decision.id),
			'the link holder': readLinkPage('token-never-given', null),
			'the page superseding it, a reader': readDecisionPage(reader, next.decision.id),
			'the page superseding it, its participant': readDecisionPage(nextsOwn.account, next.decision.id)
		};
		expect(pages['a board reader'].released, 'released').not.toBeNull();
		expect(pages['a board reader'].laterDecision, 'superseded').toEqual({ superseded: true, id: next.decision.id, title: 'Again' });
		expect(pages['the link holder']?.laterDecision, 'superseded, by a link').toEqual({ superseded: true });
		for (const [who, page] of Object.entries(pages)) {
			expect(page, who).not.toBeNull();
			expect(page!.ruling, who).not.toBeNull();
			expect(keysGiven(page), who).toEqual([]);
			expect(JSON.stringify(page), who).not.toMatch(ADDRESS);
		}
		await sent.settle();
	});
});

// ─── The routes' guard, through the gate (case 20) ───────────────────────────

describe('the four routes, through the gate', () => {
	// The first request through the harness starts SvelteKit's server for this file.
	beforeAll(async () => {
		await gateRoutes();
	}, 30_000);

	it('take same-origin JSON alone, refusing anything else before the body, a row or the wrong-link count, and hand it on to the handler (20)', async () => {
		resetAllRateLimits();
		const { decision, a } = opened();
		const { account } = withAccount(decision);
		withLink(decision, 'token-gate');
		const signedIn = { cookie: `${SESSION_COOKIE_NAME}=${makeSession(account)}` };
		const routes: { path: string; body: Record<string, unknown>; session: Record<string, string> }[] = [
			{ path: `/api/decisions/${decision.id}/responses`, body: { versionNumber: 1, kind: 'vote', optionId: a.id }, session: signedIn },
			{ path: `/api/decisions/${decision.id}/seen`, body: { versionNumber: 1, stage: 'question' }, session: signedIn },
			{ path: '/api/decision-by-link/responses', body: { token: 'token-gate', versionNumber: 1, kind: 'vote', optionId: a.id }, session: {} },
			{ path: '/api/decision-by-link/seen', body: { token: 'token-gate', versionNumber: 1, stage: 'question' }, session: {} }
		];
		// 19 wrong links counted from the caller's address already: a refusal counted with them would make the next the 21st.
		const address = addressToCount({ getClientAddress: () => '127.0.0.1' });
		for (let n = 0; n < 19; n++) refuseWrongLink(address);
		const ORIGIN = 'http://localhost';
		const JSON_TYPE = { 'content-type': 'application/json' };
		// As a page's `fetch` sends it.
		const ACCEPT = { accept: '*/*' };

		for (const route of routes) {
			const raw = JSON.stringify(route.body);
			// (a) sends its own Origin, so that SvelteKit's check of a form's type lets it through to the gate.
			const rows: [string, Record<string, string>, number, string][] = [
				['(a) text/plain', { origin: ORIGIN, 'content-type': 'text/plain' }, 415, 'This route takes JSON only'],
				['(b) no Content-Type', { origin: ORIGIN }, 415, 'This route takes JSON only'],
				['(c) Sec-Fetch-Site: cross-site', { ...JSON_TYPE, origin: ORIGIN, 'sec-fetch-site': 'cross-site' }, 403, 'Cross-site requests are refused'],
				['(d) no Sec-Fetch-Site, another Origin', { ...JSON_TYPE, origin: 'https://elsewhere.example.test' }, 403, 'Cross-site requests are refused'],
				// Fails both: the origin is asked first, by the gate and by the guard alike (card 2700, D8).
				['(f) text/plain and Sec-Fetch-Site: cross-site', { origin: ORIGIN, 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' }, 403, 'Cross-site requests are refused']
			];
			for (const [name, headers, status, message] of rows) {
				const res = await gate('POST', route.path, { headers: { ...ACCEPT, ...route.session, ...headers }, body: raw });
				expect({ status: res.status, body: await res.json() }, `${route.path} ${name}`).toEqual({ status, body: { message } });
			}
		}
		// (f), handed to the guard itself: the same answer, in the same order.
		const url = new URL(routes[0].path, ORIGIN);
		const both = new Request(url, {
			method: 'POST',
			headers: { origin: ORIGIN, 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' },
			body: JSON.stringify(routes[0].body)
		});
		expect(outcome(() => requireSameOriginJson({ request: both, url }))).toEqual({ status: 403, message: 'Cross-site requests are refused' });
		expect(written()).toEqual({ responses: 0, events: 0 });
		// None of them was counted: the next wrong link is the 20th, and still the one 404.
		const wrong = await gate('POST', '/api/decision-by-link/seen', {
			headers: { ...ACCEPT, 'sec-fetch-site': 'same-origin' },
			body: { token: 'token-never', versionNumber: 1, stage: 'question' }
		});
		expect({ status: wrong.status, body: await wrong.json() }).toEqual({ status: 404, body: { message: DEAD_DECISION_LINK } });

		// (e) Same origin by Sec-Fetch-Site, with no Origin: each is answered by its handler.
		for (const route of routes) {
			const res = await gate('POST', route.path, { headers: { ...ACCEPT, ...route.session, 'sec-fetch-site': 'same-origin' }, body: route.body });
			expect(res.status, `${route.path} (e): ${await res.clone().text()}`).toBe(200);
		}
		expect(written().responses).toBe(2);
	});
});

// ─── The personal link's page, through the gate (cases 22 to 24) ─────────────

describe('the personal link’s page, through the gate', () => {
	beforeAll(async () => {
		await gateRoutes();
	}, 30_000);

	/** The three headers every answer of a personal link carries (decision 7), and whether it sets a cookie. */
	const headedOf = (res: Response) => ({
		'referrer-policy': res.headers.get('referrer-policy'),
		'x-robots-tag': res.headers.get('x-robots-tag'),
		'cache-control': res.headers.get('cache-control'),
		'set-cookie': res.headers.get('set-cookie')
	});
	const HEADED = { 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store', 'set-cookie': null };
	const PAGE = { accept: 'text/html' };

	it('gives a live link its page, headed, signing nobody in and writing nothing; signed in, it names the account and draws no badge (22)', async () => {
		resetAllRateLimits();
		const { decision } = opened({}, () => ({ situation: '**Money** is short <b>now</b>.' }));
		withLink(decision, 'token-page-22');
		const before = { sessions: count('sessions'), events: count('decision_events') };

		const res = await gate('GET', '/decision-link/token-page-22', { headers: PAGE });
		const html = await res.text();

		expect(res.status).toBe(200);
		expect(headedOf(res)).toEqual(HEADED);
		expect({ sessions: count('sessions'), events: count('decision_events') }).toEqual(before);
		expect(html).toContain('This address is personal to you: do not share it.');
		expect(html).toContain('<meta name="robots" content="noindex"');
		expect(html).toContain('<meta name="referrer" content="no-referrer"');
		expect(html).not.toContain('You are signed in as');
		// The server draws the markdown as its text, escaped (decision 17, F5).
		expect(html).toContain('**Money** is short &lt;b>now&lt;/b>.');
		expect(html).not.toContain('<b>now</b>');

		const account = makeUser({ username: 'browser' });
		const cookie = `${SESSION_COOKIE_NAME}=${makeSession(account)}`;
		const sessions = count('sessions');
		const signed = await gate('GET', '/decision-link/token-page-22', { headers: { ...PAGE, cookie } });
		const signedHtml = await signed.text();

		expect(signed.status).toBe(200);
		expect(headedOf(signed)).toEqual(HEADED);
		expect(count('sessions')).toBe(sessions);
		expect(count('decision_events')).toBe(before.events);
		expect(signedHtml).toContain('You are signed in as browser; this is recorded with your response and with your having seen this version.');
		expect(signedHtml).not.toContain('user-badge');
		expect(signedHtml).not.toContain('href="/account"');

		// The same page at a percent-encoded address: the badge is hidden by the route id, which the pathname would not match (code review C6).
		const encoded = await gate('GET', '/%64ecision-link/token-page-22', { headers: { ...PAGE, cookie } });
		const encodedHtml = await encoded.text();
		expect(encoded.status).toBe(200);
		expect(encodedHtml).toContain('This address is personal to you: do not share it.');
		expect(encodedHtml).not.toContain('user-badge');
		expect(encodedHtml).not.toContain('href="/account"');
	});

	it('answers an unknown token and an expired link with the one 404, in the same words and headed alike (23)', async () => {
		resetAllRateLimits();
		const ruledLong = opened({ status: 'ruled', ruledAt: stamp(new Date(Date.now() - 91 * DAY)) });
		withLink(ruledLong.decision, 'token-expired-23');
		// The page's nonce differs from one answer to the next, and nothing else may.
		const bodyOf = async (res: Response) => (await res.text()).replace(/nonce="[^"]*"/g, 'nonce=""');

		const unknown = await gate('GET', '/decision-link/token-never-23', { headers: PAGE });
		const expired = await gate('GET', '/decision-link/token-expired-23', { headers: PAGE });
		const [unknownBody, expiredBody] = [await bodyOf(unknown), await bodyOf(expired)];

		for (const [name, res] of [['(a) unknown', unknown], ['(b) expired', expired]] as const) {
			expect({ status: res.status, ...headedOf(res) }, name).toEqual({ status: 404, ...HEADED });
		}
		expect(unknownBody).toContain(DEAD_DECISION_LINK);
		expect(expiredBody).toBe(unknownBody);
	});

	it('counts wrong links alone, by address, for the page and both routes: the 21st is 429, a live link is never refused, and one warning names no token (24)', async () => {
		resetAllRateLimits();
		const { decision } = opened();
		withLink(decision, 'token-live-24');
		const warnings: LogEntry[] = [];
		const unsubscribe = subscribeToLogs((entry) => {
			if (entry.level === 'WARN' && entry.context === 'DECISIONS') warnings.push(entry);
		});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		try {
			for (let n = 1; n <= 20; n++) {
				const res = await gate('GET', `/decision-link/token-wrong-${n}`, { headers: PAGE });
				expect(res.status, `wrong link ${n}`).toBe(404);
				await res.body?.cancel();
			}
			const limited = await gate('GET', '/decision-link/token-wrong-21', { headers: PAGE });
			expect({ status: limited.status, ...headedOf(limited) }).toEqual({ status: 429, ...HEADED });
			expect(await limited.text()).toMatch(/Too many links that do not work were tried from your network\. Try again in \d+ minute\(s\)\./);

			const api = await gate('POST', '/api/decision-by-link/responses', {
				headers: { 'sec-fetch-site': 'same-origin' },
				body: { token: 'token-wrong-22', versionNumber: 1, kind: 'abstain' }
			});
			const wait = Number(api.headers.get('retry-after'));
			expect(wait).toBeGreaterThan(0);
			expect(wait).toBeLessThanOrEqual(15 * 60);
			expect({ status: api.status, body: await api.json() }).toEqual({ status: 429, body: { message: tooManyWrongLinks(wait) } });

			// A live link from the same address is never refused, on the page or at a route.
			const live = await gate('GET', '/decision-link/token-live-24', { headers: PAGE });
			expect(live.status).toBe(200);
			await live.body?.cancel();
			const sent = await gate('POST', '/api/decision-by-link/responses', {
				headers: { 'sec-fetch-site': 'same-origin' },
				body: { token: 'token-live-24', versionNumber: 1, kind: 'abstain' }
			});
			expect(sent.status, await sent.clone().text()).toBe(200);
			// Another address has its own count.
			const elsewhere = await gate('GET', '/decision-link/token-wrong-23', { headers: PAGE, ip: '203.0.113.9' });
			expect(elsewhere.status).toBe(404);
			await elsewhere.body?.cancel();
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
			unsubscribe();
			vi.restoreAllMocks();
		}

		expect(warnings).toHaveLength(1);
		expect(warnings[0].message).toContain('decision-link:');
		expect(JSON.stringify(warnings)).not.toMatch(/token-/);
	});
});
