/**
 * A decision's results, its ruling, the release of its results and its
 * supersession (card 2679): `ruleDecision`, `releaseResults`,
 * `supersedeDecision` and their guards in `src/lib/server/decision-ruling-writes.ts`; the
 * results read and the release's projection in
 * `src/lib/server/decision-results.ts`; the ruling's row and the record's
 * reads in `src/lib/server/decision-record.ts`; and, from slice 1b, what the
 * pages read of them (`decision-view.ts`, `decision-authoring.ts`).
 *
 * Each write is called as a route will call it, inside `writeAs` and handed
 * its `caller`, with `effects()` installed so that no mail leaves, mail set up
 * (`makeSmtp`) and an App URL saved. A reader's own refusals are
 * `request-body.test.ts`'s and the role table's `decision-access.test.ts`'s;
 * neither is repeated. The cases are the plan's,
 * `docs/planning/card-2679-results-ruling.md`, section 7.1, by number.
 */
import { createHash, createHmac } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { addressToCount } from '$lib/server/client-address';
import {
	boards,
	decisionOptions,
	decisionParticipants,
	decisionSurveyQuestions,
	decisions,
	people,
	sessions,
	settings,
	users,
	type Board,
	type Decision,
	type DecisionParticipant
} from '$lib/server/db/schema';
import { DECISION_RULES } from '$lib/server/decision-access';
import { resultsRevisionOf, allOptionsOf, participantsOf } from '$lib/server/decision-content';
import { appendEvent, concernsOf, currentRound, DECIDER_ONLY_EVENTS, latestResponse, reachedInRound, rulingOf, seenStands, SYSTEM_ACTOR } from '$lib/server/decision-record';
import { revokeLinks } from '$lib/server/decision-links';
import { STEP_UP_MISSING, STEP_UP_WRONG } from '$lib/server/step-up';
import {
	ALREADY_RELEASED,
	CHAIN_TOO_CLOSE,
	commentKeyOf,
	previewOf,
	readResults,
	releasedOf,
	releaseRefusals,
	releaseRowsOf,
	resultsRevisionFor,
	rulingRefusals,
	TOO_FEW_TO_RELEASE
} from '$lib/server/decision-results';
import { raiseFlag, raiseFlagByLink, replyToFlag } from '$lib/server/decision-flag-writes';
import { closeDecision, extendDecision, republishDecision } from '$lib/server/decision-lifecycle-writes';
import { recordSeen, respondToDecision } from '$lib/server/decision-response-writes';
import { raiseConcern, raiseConcernByLink, releaseResults, ruleDecision, supersedeDecision } from '$lib/server/decision-ruling-writes';
import { resendInvitation, setParticipants } from '$lib/server/decision-participant-writes';
import { setDecider } from '$lib/server/decision-authoring-writes';
import { rulesEarly } from '$lib/server/decision-status';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { purposeKey } from '$lib/server/request-tokens';
import { writeAs, type ServiceOptions } from '$lib/server/write-as';
import {
	CONCERN_SUPERSEDED,
	CONCERN_WINDOW_ENDED,
	DEAD_DECISION_LINK,
	NO_OPTIONS_TO_RELEASE,
	STALE_REVISION,
	tooManyWrongLinks,
	WHO_SEES_STATEMENT_VERSION
} from '$lib/decision-words';
import type { GroupTally, ReleasedResults, RoundTally } from '$lib/decision-view-types';
import { decisionAnswer, readBoardDecisions, readEditPage, revisionFor } from '$lib/server/decision-authoring';
import { readDecisionPage, readLinkPage, refuseWrongLink } from '$lib/server/decision-view';
import { parseStamp, stamp } from '$lib/timestamps';
import { pageLoad } from './helpers/actions';
import { api } from './helpers/api';
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
	resetDb,
	stepUp,
	sessionHashOf
} from './helpers/fixtures';
import { gate, gateRoutes } from './helpers/gate';

const APP = 'https://kanban.example.test';
const UI: ServiceOptions = { source: 'ui' };
const API: ServiceOptions = { source: 'api' };
/** A closing time that has passed: a closed decision is awaiting a ruling, and a ruling of it is not early. */
const PAST = '2026-11-02 09:00:00';
const FUTURE = '2099-01-01 12:00:00';

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
});

afterEach(() => {
	sent.restore();
});

/** Call a write as `user`, or with no session for null, as a route calls it inside its writeAs callback. */
const as = <T>(user: SessionUser | null, write: (caller: SessionUser | null) => T): T =>
	writeAs((user === null ? {} : { user }) as App.Locals, write as never) as T;

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

type EventRow = { kind: string; participantId: number | null; versionNumber: number | null; detail: any };
const eventsOf = (decisionId: number): EventRow[] =>
	(
		sqlite
			.prepare('SELECT kind, participant_id AS participantId, version_number AS versionNumber, detail FROM decision_events WHERE decision_id = ? ORDER BY id')
			.all(decisionId) as (Omit<EventRow, 'detail'> & { detail: string | null })[]
	).map((row) => ({ ...row, detail: row.detail === null ? null : JSON.parse(row.detail) }));
const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const decisionRow = (id: number) => db.select().from(decisions).where(eq(decisions.id, id)).get()!;
const activityRows = () => sqlite.prepare('SELECT board_id AS boardId, action, detail FROM activity_log ORDER BY id').all() as { boardId: number; action: string; detail: string }[];
/** The `decision` live events sent, each by the board it went to, the decision and its status. */
const liveEvents = () =>
	sent.events.filter((event) => event.event === 'decision').map((event) => ({ decisionId: event.data.decisionId, status: event.data.status, boardId: event.boardId }));
/** What a write leaves behind: rulings, events, decisions, activity. */
const written = () => ({ rulings: count('decision_rulings'), events: count('decision_events'), decisions: count('decisions'), activity: count('activity_log') });
/** Wait until every ruling mail asked for has its outcome, and every invitation an Extend that reopened it sent (card 2744). */
const settled = (decisionId: number) =>
	vi.waitFor(() =>
		expect(eventsOf(decisionId).filter((event) => event.kind === 'mail_outcome')).toHaveLength(
			eventsOf(decisionId).filter((event) => ['invited', 'told_ruling'].includes(event.kind)).length
		)
	);

/**
 * A decision on the board (or none) opened as version 1 with options A, B and
 * C, its decider able to edit the board: closed and awaiting a ruling unless
 * told otherwise.
 */
function opened(opts: { status?: string; closesAt?: string; voteMode?: 'single' | 'score'; board?: Board | null; title?: string; supersedesId?: number | null; decider?: SessionUser } = {}) {
	const on = opts.board === undefined ? board : opts.board;
	const decider = opts.decider ?? makeUser({ username: `decider${++seq}` });
	if (on !== null && opts.decider === undefined) addBoardMember(on, decider, 'editor');
	const made = makeDecision({
		board: on,
		author: decider,
		decider,
		title: opts.title ?? 'Which plan?',
		status: opts.status ?? 'closed',
		closesAt: opts.closesAt ?? PAST,
		openedAt: '2026-11-01 09:00:00',
		voteMode: opts.voteMode ?? 'single',
		supersedesId: opts.supersedesId ?? null
	});
	const a = makeOption(made, { label: 'A', position: 0, addedInVersion: 1 });
	const b = makeOption(made, { label: 'B', position: 1, addedInVersion: 1 });
	const c = makeOption(made, { label: 'C', position: 2, addedInVersion: 1 });
	makeVersion(made, { situation: 'Money is short.', question: 'Which plan?', options: [a, b, c].map((o) => ({ optionId: o.id, label: o.label, title: `Plan ${o.label}` })) }, { number: 1 });
	return { decision: decisionRow(made.id), a, b, c, decider };
}

/** A participant of the decision reached through their account. */
function withAccount(decision: Decision, name: string, role: 'consulted' | 'informed' = 'consulted') {
	const account = makeUser({ username: `${name}${++seq}` });
	const person = makePerson({ fullName: `${name} Person`, user: account });
	const participant = makeParticipant(decision, { person, role });
	return { account, person, participant };
}

/** A response of the participant in round 1 of version 1, with its `responded` event, under the current statement unless told otherwise (null: none). */
function answer(participant: DecisionParticipant, opts: Parameters<typeof makeResponse>[1] = {}, statement: number | null = WHO_SEES_STATEMENT_VERSION) {
	const row = makeResponse(participant, { kind: 'vote', ...opts });
	appendEvent(
		{
			decisionId: participant.decisionId,
			kind: 'responded',
			participantId: participant.id,
			versionNumber: row.versionNumber,
			detail: { responseId: row.id, ...(statement === null ? {} : { statement }) }
		},
		SYSTEM_ACTOR
	);
	return row;
}

const rule = (user: SessionUser | null, decision: Decision, body: Record<string, unknown>, opts = UI) =>
	as(user, (caller) => ruleDecision(caller, { decisionId: decision.id }, { revision: resultsRevisionFor(decision.id), ...body }, opts));
const release = (user: SessionUser | null, decision: Decision, body: Record<string, unknown> = {}, opts = UI) =>
	as(user, (caller) => releaseResults(caller, { decisionId: decision.id }, { revision: resultsRevisionFor(decision.id), ...body }, opts));
const supersede = (user: SessionUser | null, decision: Decision, body: Record<string, unknown> = {}, opts = UI) =>
	as(user, (caller) => supersedeDecision(caller, { decisionId: decision.id }, body, opts));
/** Card 2684: a participant's objection or request to talk, signed in, and the decider's reply to one. */
const flag = (user: SessionUser, decision: Decision, body: Record<string, unknown>) => as(user, (caller) => raiseFlag(caller, { decisionId: decision.id }, body, UI));
const replyTo = (user: SessionUser, decision: Decision, flagId: number, reply: string) =>
	as(user, (caller) => replyToFlag(caller, { decisionId: decision.id, flagId }, { reply }, UI));
/** The decision's flag ids, oldest first. */
const flagIdsOf = (decisionId: number) => (sqlite.prepare('SELECT id FROM decision_flags WHERE decision_id = ? ORDER BY id').all(decisionId) as { id: number }[]).map((row) => row.id);
/** A flag row written as a restore could leave one, replied to where `reply` is given; answers its id. */
const plantFlag = (decisionId: number, participantId: number, row: { kind: string; reason?: string; reply?: string; repliedAt?: string }): number =>
	Number(
		sqlite
			.prepare(
				'INSERT INTO decision_flags (decision_id, participant_id, kind, reason, version_number, via, raised_at, reply, replied_by_name, replied_at) ' +
					"VALUES (?, ?, ?, ?, 1, 'session', '2026-11-02 09:30:00', ?, ?, ?)"
			)
			.run(decisionId, participantId, row.kind, row.reason ?? 'A planted reason.', row.reply ?? null, row.reply === undefined ? null : 'A decider', row.repliedAt ?? null)
			.lastInsertRowid
	);

/**
 * A ruled decision whose results may be released: three live consulted
 * participants who answered under the current statement, each with a comment
 * and one with a comment on an option.
 */
function releasable(opts: { voteMode?: 'single' | 'score' } = {}) {
	const made = opened(opts);
	const pat = withAccount(made.decision, 'pat');
	const quin = withAccount(made.decision, 'quin');
	const ria = withAccount(made.decision, 'ria');
	const pats = answer(pat.participant, { optionId: made.a.id, comment: 'Plan A is enough.', optionComments: JSON.stringify({ [made.b.id]: 'B costs too much.' }) });
	const quins = answer(quin.participant, { optionId: made.a.id, comment: 'A, gladly.' });
	const rias = answer(ria.participant, { kind: 'abstain', optionId: null, comment: 'Either is fine.' });
	makeRuling(made.decision, { optionId: made.a.id, ruledAt: stamp() });
	return { ...made, decision: decisionRow(made.decision.id), pat, quin, ria, responses: { pats, quins, rias } };
}

/** A participant of the decision with no account, holding the personal link `token`. */
function withLink(decision: Decision, token: string, role: 'consulted' | 'informed' = 'informed') {
	const person = makePerson({ fullName: `Linky ${token}` });
	return { person, participant: makeParticipant(decision, { person, role, token }) };
}

/** A board reader: may view every decision on the board that is not a draft. */
function boardReader() {
	const reader = makeUser({ username: `reader${++seq}` });
	addBoardMember(board, reader, 'viewer');
	return reader;
}

// ─── Ruling (cases 1 to 9) ───────────────────────────────────────────────────

describe('ruleDecision', () => {
	it('rules an awaiting-ruling decision on an option: the row, ruled, its events, told_ruling, the activity and the live event, and a mail with no figure (1)', async () => {
		const { decision, a, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const ivy = withAccount(decision, 'ivy', 'informed');
		answer(pat.participant, { optionId: a.id });
		const before = eventsOf(decision.id).length;

		const row = rule(decider, decision, { optionId: a.id, reason: '  It is what we can afford.  ', conditions: 'Looked at again in March.' });

		expect(rulingOf(decision.id)).toEqual({
			decisionId: decision.id,
			optionId: a.id,
			reason: 'It is what we can afford.',
			conditions: 'Looked at again in March.',
			againstResponses: false,
			early: false,
			versionNumber: 1,
			ruledBy: decider.id,
			ruledByName: decider.username,
			ruledAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
		});
		expect(row).toMatchObject({ status: 'ruled', ruledAt: rulingOf(decision.id)!.ruledAt });
		expect(decisionRow(decision.id)).toEqual(row);
		expect(eventsOf(decision.id).slice(before).map((event) => [event.kind, event.participantId, event.detail])).toEqual([
			['ruled', null, { optionId: a.id, early: false, againstResponses: false, productOwnerUserId: null }],
			['told_ruling', pat.participant.id, null],
			['told_ruling', ivy.participant.id, null]
		]);
		expect(activityRows()).toEqual([{ boardId: board.id, action: 'decision_ruled', detail: `"${decision.title}"` }]);
		expect(liveEvents()).toEqual([{ decisionId: decision.id, status: 'ruled', boardId: board.id }]);

		await settled(decision.id);
		expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([
			[pat.person.email, `Ruled: ${decision.title}`],
			[ivy.person.email, `Ruled: ${decision.title}`]
		]);
		for (const mail of sent.emails) {
			expect(mail.html).toContain('A: Plan A');
			expect(mail.html).toContain('It is what we can afford.');
			expect(mail.html).toContain('Looked at again in March.');
			expect(mail.html).toContain('You can raise a concern about this ruling from the page for 90 days.');
			expect(mail.html).not.toMatch(/respon|vote|against|cut-off|cut off|\b\d+ of \d+\b/i);
		}
		expect(sent.duringTransaction).toEqual([]);
	});

	it('rules early on a decision shown open, and cuts off each live consulted participant with no response, and nobody else (2)', async () => {
		const { decision, a, decider } = opened({ status: 'open', closesAt: FUTURE });
		const responder = withAccount(decision, 'res');
		const silent = withAccount(decision, 'sil');
		withAccount(decision, 'inf', 'informed');
		const gone = withAccount(decision, 'gone');
		db.update(decisionParticipants).set({ removedAt: PAST }).where(eq(decisionParticipants.id, gone.participant.id)).run();
		answer(responder.participant, { optionId: a.id });

		rule(decider, decision, { optionId: a.id, reason: 'Early.' });

		expect(rulingOf(decision.id)?.early).toBe(true);
		expect(eventsOf(decision.id).filter((event) => ['ruled', 'cut_off'].includes(event.kind)).map((event) => [event.kind, event.participantId, event.detail])).toEqual([
			['ruled', null, { optionId: a.id, early: true, againstResponses: false, productOwnerUserId: null }],
			// Card 2738: no asking mail of the round is on the record for them, so it says they were never reached.
			['cut_off', silent.participant.id, { reached: false }]
		]);
		await settled(decision.id);
	});

	// ─── Card 2727: a close before the closing time makes the ruling early ───────

	const close = (user: SessionUser, decision: Decision) => as(user, (caller) => closeDecision(caller, { decisionId: decision.id }, null, UI));
	const extend = (user: SessionUser, decision: Decision, closesAt: string) =>
		as(user, (caller) => extendDecision(caller, { decisionId: decision.id }, { closesAt: `${closesAt.replace(' ', 'T')}Z` }, UI));
	const daysAhead = (days: number) => stamp(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
	const rulingEvents = (decisionId: number) =>
		eventsOf(decisionId)
			.filter((event) => ['ruled', 'cut_off'].includes(event.kind))
			.map((event) => [event.kind, event.participantId, event.kind === 'ruled' ? event.detail.early : null]);

	it('rules early on a decision closed before its closing time, and cuts off each live consulted participant with no response, and nobody else (2a, card 2727)', async () => {
		const { decision, a, decider } = opened({ status: 'open', closesAt: FUTURE });
		const responder = withAccount(decision, 'res');
		const silent = withAccount(decision, 'sil');
		withAccount(decision, 'inf', 'informed');
		const gone = withAccount(decision, 'gone');
		db.update(decisionParticipants).set({ removedAt: PAST }).where(eq(decisionParticipants.id, gone.participant.id)).run();
		answer(responder.participant, { optionId: a.id });

		const closed = close(decider, decision);
		expect(closed).toMatchObject({ status: 'closed', closesAt: FUTURE });
		expect(readResults(decider, decision.id, { source: 'ui' }).rulesEarly, 'the form is told').toBe(true);

		rule(decider, closed, { optionId: a.id, reason: 'Closed early.' });

		expect(rulingOf(decision.id)?.early).toBe(true);
		expect(rulingEvents(decision.id)).toEqual([
			['ruled', null, true],
			['cut_off', silent.participant.id, null]
		]);
		await settled(decision.id);
	});

	it('is not early when closed at or after the closing time: no cut_off (2b, card 2727)', async () => {
		// The real path: stored open past its closing time, then closed, so closed_at is after closes_at.
		const late = opened({ status: 'open', closesAt: PAST });
		const lateSilent = withAccount(late.decision, 'late');
		const closed = close(late.decider, late.decision);
		expect(closed.closedAt! > PAST).toBe(true);
		expect(readResults(late.decider, late.decision.id, { source: 'ui' }).rulesEarly).toBe(false);
		rule(late.decider, closed, { optionId: late.a.id, reason: 'On time.' });
		expect(rulingOf(late.decision.id)?.early).toBe(false);
		expect(rulingEvents(late.decision.id)).toEqual([['ruled', null, false]]);
		expect(eventsOf(late.decision.id).some((event) => event.participantId === lateSilent.participant.id && event.kind === 'cut_off')).toBe(false);

		// Closed at the very moment of its closing time.
		const onTime = opened({ status: 'closed', closesAt: PAST });
		db.update(decisions).set({ closedAt: PAST }).where(eq(decisions.id, onTime.decision.id)).run();
		withAccount(onTime.decision, 'ontime');
		rule(onTime.decider, decisionRow(onTime.decision.id), { optionId: onTime.a.id, reason: 'At the time.' });
		expect(rulingOf(onTime.decision.id)?.early).toBe(false);
		expect(rulingEvents(onTime.decision.id)).toEqual([['ruled', null, false]]);
		await settled(late.decision.id);
		await settled(onTime.decision.id);
	});

	it('counts the latest close after a reopen, against the closing time then in force (2c, card 2727)', async () => {
		// Closed early, reopened by Extend, then left past the new closing time and closed: not early.
		const first = opened({ status: 'open', closesAt: daysAhead(1) });
		withAccount(first.decision, 'first');
		close(first.decider, first.decision);
		const extended = extend(first.decider, decisionRow(first.decision.id), daysAhead(2));
		expect(extended).toMatchObject({ status: 'open', closedAt: null });
		db.update(decisions).set({ closesAt: PAST }).where(eq(decisions.id, first.decision.id)).run(); // the new closing time passes
		close(first.decider, decisionRow(first.decision.id));
		rule(first.decider, decisionRow(first.decision.id), { optionId: first.a.id, reason: 'After the extension.' });
		expect(rulingOf(first.decision.id)?.early).toBe(false);
		expect(rulingEvents(first.decision.id)).toEqual([['ruled', null, false]]);

		// Closed early, reopened by Extend, and closed early again: early, against the extended time.
		const second = opened({ status: 'open', closesAt: daysAhead(1) });
		const secondSilent = withAccount(second.decision, 'second');
		close(second.decider, second.decision);
		const reopened = extend(second.decider, decisionRow(second.decision.id), daysAhead(2));
		const again = close(second.decider, decisionRow(second.decision.id));
		expect(again.closesAt, 'the extended closing time').toBe(reopened.closesAt);
		rule(second.decider, again, { optionId: second.a.id, reason: 'Closed early again.' });
		expect(rulingOf(second.decision.id)?.early).toBe(true);
		expect(rulingEvents(second.decision.id)).toEqual([
			['ruled', null, true],
			['cut_off', secondSilent.participant.id, null]
		]);
		await settled(first.decision.id);
		await settled(second.decision.id);
	});

	it('counts the latest close after a re-publish asking again, against the closing time then in force (2e, card 2727)', async () => {
		const askAgain = (user: SessionUser, decisionId: number) =>
			as(user, (caller) => republishDecision(caller, { decisionId }, { changeNote: 'Asked again.', askAgain: true, revision: revisionFor(decisionId) }, UI));
		/** Every invitation (card 2744: the reopening sends one to whom the round never reached), asked_again and told_ruling mail has its outcome. */
		const mailsSettled = (decisionId: number) =>
			vi.waitFor(() =>
				expect(eventsOf(decisionId).filter((event) => event.kind === 'mail_outcome')).toHaveLength(
					eventsOf(decisionId).filter((event) => ['invited', 'asked_again', 'told_ruling'].includes(event.kind)).length
				)
			);

		// Closed early, reopened by asking again, and closed early again: early, and the silent one is cut off.
		const first = opened({ status: 'open', closesAt: daysAhead(1) });
		const firstSilent = withAccount(first.decision, 'first');
		close(first.decider, first.decision);
		const reopened = askAgain(first.decider, first.decision.id);
		expect(reopened).toMatchObject({ status: 'open', closedAt: null, closesAt: first.decision.closesAt });
		const again = close(first.decider, reopened);
		rule(first.decider, again, { optionId: first.a.id, reason: 'Closed early after asking again.' });
		expect(rulingOf(first.decision.id)?.early).toBe(true);
		expect(rulingEvents(first.decision.id)).toEqual([
			['ruled', null, true],
			['cut_off', firstSilent.participant.id, null]
		]);

		// Closed early, reopened by asking again, then left past its closing time and closed: not early.
		const second = opened({ status: 'open', closesAt: daysAhead(1) });
		withAccount(second.decision, 'second');
		close(second.decider, second.decision);
		expect(askAgain(second.decider, second.decision.id)).toMatchObject({ status: 'open', closedAt: null });
		db.update(decisions).set({ closesAt: PAST }).where(eq(decisions.id, second.decision.id)).run(); // the closing time passes
		close(second.decider, decisionRow(second.decision.id));
		rule(second.decider, decisionRow(second.decision.id), { optionId: second.a.id, reason: 'After asking again.' });
		expect(rulingOf(second.decision.id)?.early).toBe(false);
		expect(rulingEvents(second.decision.id)).toEqual([['ruled', null, false]]);
		await mailsSettled(first.decision.id);
		await mailsSettled(second.decision.id);
	});

	it('rulesEarly: shown open, open past its time, closed with no closed_at, closed with no closes_at, and every other status (2d, card 2727)', () => {
		const now = '2026-11-05 12:00:00';
		const row = (status: string, closesAt: string | null, closedAt: string | null) => ({ status, closesAt, closedAt });
		expect(rulesEarly(row('open', '2026-11-06 12:00:00', null), now), 'shown open').toBe(true);
		expect(rulesEarly(row('open', null, null), now), 'open with no closing time').toBe(true);
		expect(rulesEarly(row('open', now, null), now), 'open at its closing time').toBe(false);
		expect(rulesEarly(row('closed', '2026-11-06 12:00:00', '2026-11-05 10:00:00'), now), 'closed before').toBe(true);
		expect(rulesEarly(row('closed', '2026-11-05 10:00:00', '2026-11-05 10:00:00'), now), 'closed at').toBe(false);
		expect(rulesEarly(row('closed', '2026-11-05 09:00:00', '2026-11-05 10:00:00'), now), 'closed after').toBe(false);
		expect(rulesEarly(row('closed', '2026-11-06 12:00:00', null), now), 'closed with no closed_at').toBe(false);
		// Without the closed_at guard this row would be early: nothing on it says when it closed.
		expect(rulesEarly(row('closed', null, null), now), 'closed with neither closed_at nor closing time').toBe(false);
		expect(rulesEarly(row('closed', null, '2026-11-05 10:00:00'), now), 'closed with no closing time').toBe(true);
		for (const status of ['draft', 'ruled', 'superseded', 'withdrawn']) expect(rulesEarly(row(status, '2026-11-06 12:00:00', '2026-11-05 10:00:00'), now), status).toBe(false);
	});

	// ─── Card 2738: an early ruling says whom the round's request never reached ──

	describe('card 2738: whom the round’s request reached', () => {
		const askAgain = (user: SessionUser, decisionId: number) =>
			as(user, (caller) => republishDecision(caller, { decisionId }, { changeNote: 'Asked again.', askAgain: true, revision: revisionFor(decisionId) }, UI));
		/** Every record mail asked for has its outcome. */
		const mailsSettled = (decisionId: number) =>
			vi.waitFor(() =>
				expect(eventsOf(decisionId).filter((event) => event.kind === 'mail_outcome')).toHaveLength(
					eventsOf(decisionId).filter((event) => ['invited', 'asked_again', 'told_ruling'].includes(event.kind)).length
				)
			);
		const cutOffs = (decisionId: number) => eventsOf(decisionId).filter((event) => event.kind === 'cut_off').map((event) => [event.participantId, event.detail]);
		/** A record mail of the participant now, with its outcome: delivered, not delivered, or none written yet (undefined). */
		function mailed(p: DecisionParticipant, kind: 'invited' | 'asked_again', delivered: boolean | undefined) {
			const of = appendEvent({ decisionId: p.decisionId, kind, participantId: p.id, versionNumber: kind === 'asked_again' ? 1 : null }, SYSTEM_ACTOR);
			if (delivered !== undefined) {
				const mail = kind === 'invited' ? 'invitation' : 'asked_again';
				appendEvent({ decisionId: p.decisionId, kind: 'mail_outcome', participantId: p.id, detail: { of, mail, delivered, ...(delivered ? {} : { problem: 'no_link_address' }) } }, SYSTEM_ACTOR);
			}
		}
		const rowOf = (p: DecisionParticipant) => db.select().from(decisionParticipants).where(eq(decisionParticipants.id, p.id)).get()!;
		const reachedOf = (decision: Decision, round: number, ...who: DecisionParticipant[]) => [...reachedInRound(decision.id, round, who.map(rowOf))].sort((x, y) => x - y);
		/** The `published` event a version's publishing writes (the `opened()` fixture writes none): it opens the round by id. */
		const published = (decision: Decision, number: number, asksAgain = true) =>
			appendEvent({ decisionId: decision.id, kind: 'published', versionNumber: number, detail: { asksAgain, changeNote: number === 1 ? null : 'A change' } }, SYSTEM_ACTOR);
		/** A question seen by the participant now. */
		const sees = (p: DecisionParticipant, versionNumber: number) =>
			appendEvent({ decisionId: p.decisionId, kind: 'seen', participantId: p.id, versionNumber, detail: { stage: 'question' } }, SYSTEM_ACTOR);
		const close = (user: SessionUser, decisionId: number) => as(user, (caller) => closeDecision(caller, { decisionId }, null, UI));

		it('records never reached for one whose address changed and one who had left before the request, and reached for one it was delivered to (2738-1)', async () => {
			// Within a year, so that it may be re-published.
			const { decision, a, decider } = opened({ status: 'open', closesAt: daysAhead(30) });
			const told = withAccount(decision, 'told');
			const moved = withAccount(decision, 'moved');
			const gone = withAccount(decision, 'gone');
			db.update(people).set({ email: 'moved-elsewhere@example.test' }).where(eq(people.id, moved.person.id)).run();
			db.update(people).set({ status: 'left', leftAt: stamp() }).where(eq(people.id, gone.person.id)).run();

			askAgain(decider, decision.id);
			await mailsSettled(decision.id);
			expect(eventsOf(decision.id).filter((event) => event.kind === 'mail_skipped').map((event) => [event.participantId, event.detail.reason])).toEqual([
				[moved.participant.id, 'address_changed'],
				[gone.participant.id, 'left']
			]);
			// The results page marks them before the ruling, by the rule the ruling records.
			expect(readResults(decider, decision.id, { source: 'ui' }).notResponded.map((p) => [p.participantId, p.reached])).toEqual([
				[told.participant.id, true],
				[moved.participant.id, false],
				[gone.participant.id, false]
			]);

			rule(decider, decisionRow(decision.id), { optionId: a.id, reason: 'Early.' });

			expect(cutOffs(decision.id)).toEqual([
				[told.participant.id, { reached: true }],
				[moved.participant.id, { reached: false }],
				[gone.participant.id, { reached: false }]
			]);
			const { ruling } = readResults(decider, decision.id, { source: 'ui' });
			expect(ruling?.cutOff).toEqual([told.participant.name, moved.participant.name, gone.participant.name]);
			expect(ruling?.cutOffReached).toEqual([true, false, false]);
			await mailsSettled(decision.id);
		});

		it('keeps a link holder whose link was revoked after a delivered request a true cut-off (2738-2)', async () => {
			const { decision, a, decider } = opened({ status: 'open', closesAt: daysAhead(30) });
			const linky = withLink(decision, 'token-2738', 'consulted');
			askAgain(decider, decision.id);
			await mailsSettled(decision.id);
			expect(rowOf(linky.participant).linkTokenHash, 'the request issued a new link').not.toBeNull();

			db.update(people).set({ status: 'left', leftAt: stamp() }).where(eq(people.id, linky.person.id)).run();
			revokeLinks({ participantId: linky.participant.id }, 'left', SYSTEM_ACTOR);
			expect(rowOf(linky.participant).linkTokenHash).toBeNull();

			rule(decider, decisionRow(decision.id), { optionId: a.id, reason: 'Early.' });
			expect(cutOffs(decision.id)).toEqual([[linky.participant.id, { reached: true }]]);
			await mailsSettled(decision.id);
		});

		it('counts any delivered request, not only the latest; one never delivered, or with no outcome yet, did not reach them (2738-3)', async () => {
			const { decision, a, decider } = opened({ status: 'open', closesAt: FUTURE });
			published(decision, 1);
			const resent = withAccount(decision, 'resent');
			const failed = withAccount(decision, 'failed');
			const pending = withAccount(decision, 'pending');
			mailed(resent.participant, 'invited', true);
			mailed(resent.participant, 'invited', false);
			mailed(failed.participant, 'invited', false);
			mailed(pending.participant, 'invited', undefined);

			rule(decider, decision, { optionId: a.id, reason: 'Early.' });
			expect(cutOffs(decision.id)).toEqual([
				[resent.participant.id, { reached: true }],
				[failed.participant.id, { reached: false }],
				[pending.participant.id, { reached: false }]
			]);
			// The made-up outcomes above are not the ruling mail's: wait for those alone.
			await vi.waitFor(() =>
				expect(eventsOf(decision.id).filter((event) => event.kind === 'mail_outcome' && event.detail.mail === 'ruling')).toHaveLength(
					eventsOf(decision.id).filter((event) => event.kind === 'told_ruling').length
				)
			);
		});

		it('counts a request only while consulted: an invitation delivered while informed asked nothing (2738-4)', () => {
			const { decision } = opened({ status: 'open', closesAt: FUTURE });
			published(decision, 1);
			const makeConsulted = (p: DecisionParticipant) => {
				db.update(decisionParticipants).set({ role: 'consulted' }).where(eq(decisionParticipants.id, p.id)).run();
				appendEvent({ decisionId: decision.id, kind: 'role_changed', participantId: p.id, detail: { from: 'informed', to: 'consulted' } }, SYSTEM_ACTOR);
			};
			// Included informed, told for their information, then made consulted: never asked.
			const switched = withAccount(decision, 'switched', 'informed');
			appendEvent({ decisionId: decision.id, kind: 'included', participantId: switched.participant.id, detail: { role: 'informed', hadAccount: true } }, SYSTEM_ACTOR);
			mailed(switched.participant, 'invited', true);
			makeConsulted(switched.participant);
			// The same, then asked again once consulted: reached.
			const askedLater = withAccount(decision, 'askedlater', 'informed');
			appendEvent({ decisionId: decision.id, kind: 'included', participantId: askedLater.participant.id, detail: { role: 'informed', hadAccount: true } }, SYSTEM_ACTOR);
			mailed(askedLater.participant, 'invited', true);
			makeConsulted(askedLater.participant);
			mailed(askedLater.participant, 'asked_again', true);
			// No inclusion on the record: the role before the first role_changed is its `from`.
			const unrecorded = withAccount(decision, 'unrecorded', 'informed');
			mailed(unrecorded.participant, 'invited', true);
			makeConsulted(unrecorded.participant);
			// Consulted throughout, with no role event at all: the row's role.
			const plain = withAccount(decision, 'plain');
			mailed(plain.participant, 'invited', true);

			expect(reachedOf(decision, 1, switched.participant, askedLater.participant, unrecorded.participant, plain.participant)).toEqual(
				[askedLater.participant.id, plain.participant.id].sort((x, y) => x - y)
			);
		});

		it('reads the current round alone: a request delivered in round 1 does not reach them in round 2 (2738-5)', () => {
			const { decision, a, b, c, decider } = opened({ status: 'open', closesAt: FUTURE });
			published(decision, 1);
			const old = withAccount(decision, 'old');
			mailed(old.participant, 'invited', true);
			expect(reachedOf(decision, 1, old.participant)).toEqual([old.participant.id]);

			const options = [a, b, c].map((o) => ({ optionId: o.id, label: o.label, title: `Plan ${o.label}` }));
			makeVersion(decision, { question: 'Which plan?', options }, { number: 2, asksAgain: true, publishedAt: stamp() });
			published(decision, 2);
			expect(currentRound(decision.id)).toBe(2);
			expect(reachedOf(decision, 2, old.participant)).toEqual([]);
			expect(readResults(decider, decision.id, { source: 'ui' }).notResponded).toEqual([{ participantId: old.participant.id, name: old.participant.name, groups: [], reached: false }]);
			// A round with no version reaches nobody.
			expect(reachedOf(decision, 3, old.participant)).toEqual([]);
		});

		it('counts the question seen in the round as reached, by account with no mail delivered; not one of an earlier round, nor the ruling seen (2738-6)', () => {
			const { decision, a, b, c } = opened({ status: 'open', closesAt: FUTURE });
			published(decision, 1);
			const seer = withAccount(decision, 'seer');
			const other = withAccount(decision, 'other');
			appendEvent({ decisionId: decision.id, kind: 'seen', participantId: seer.participant.id, versionNumber: 1, detail: { stage: 'question' } }, SYSTEM_ACTOR);
			appendEvent({ decisionId: decision.id, kind: 'seen', participantId: other.participant.id, versionNumber: 1, detail: { stage: 'ruling' } }, SYSTEM_ACTOR);
			expect(reachedOf(decision, 1, seer.participant, other.participant)).toEqual([seer.participant.id]);

			const options = [a, b, c].map((o) => ({ optionId: o.id, label: o.label, title: `Plan ${o.label}` }));
			makeVersion(decision, { question: 'Which plan?', options }, { number: 2, asksAgain: true, publishedAt: stamp() });
			published(decision, 2);
			expect(reachedOf(decision, 2, seer.participant), 'round 1 seen').toEqual([]);
			appendEvent({ decisionId: decision.id, kind: 'seen', participantId: seer.participant.id, versionNumber: 2, detail: { stage: 'question' } }, SYSTEM_ACTOR);
			expect(reachedOf(decision, 2, seer.participant)).toEqual([seer.participant.id]);
		});

		it('says neither of a cut-off recorded before card 2738 (2738-7)', () => {
			const { decision, a, decider } = opened({ status: 'open', closesAt: FUTURE });
			const before = withAccount(decision, 'before');
			makeRuling(decision, { optionId: a.id, early: true, ruledAt: stamp() });
			appendEvent({ decisionId: decision.id, kind: 'cut_off', participantId: before.participant.id }, SYSTEM_ACTOR);
			const { ruling } = readResults(decider, decision.id, { source: 'ui' });
			expect(ruling?.cutOff).toEqual([before.participant.name]);
			expect(ruling?.cutOffReached).toEqual([null]);
		});

		// ─── Code review 2026-11-05: only what was written while the decision was open for input counts ──

		it('records never reached for one added and invited after an early close, the invitation delivered; and says the ruling followed that close (2738-8, R1 scenario A, R6)', async () => {
			const { decision, a, decider } = opened({ status: 'open', closesAt: daysAhead(30) });
			const asked = withAccount(decision, 'asked');
			askAgain(decider, decision.id);
			await mailsSettled(decision.id);

			close(decider, decision.id);
			// Y is added and invited after the close, and the invitation is delivered.
			const late = withAccount(decision, 'late');
			appendEvent({ decisionId: decision.id, kind: 'included', participantId: late.participant.id, detail: { role: 'consulted', hadAccount: true } }, SYSTEM_ACTOR);
			mailed(late.participant, 'invited', true);
			expect(readResults(decider, decision.id, { source: 'ui' }).notResponded.map((p) => [p.participantId, p.reached])).toEqual([
				[asked.participant.id, true],
				[late.participant.id, false]
			]);

			rule(decider, decisionRow(decision.id), { optionId: a.id, reason: 'Early, after the close.' });
			expect(cutOffs(decision.id)).toEqual([
				[asked.participant.id, { reached: true }],
				[late.participant.id, { reached: false }]
			]);
			expect(readResults(decider, decision.id, { source: 'ui' }).ruling).toMatchObject({ early: true, closedEarly: true });
			await mailsSettled(decision.id);
		});

		it('counts the question seen before an early close and after an extend reopened it, never one seen while it was closed (2738-9, R1 scenario B)', async () => {
			const { decision, a, decider } = opened({ status: 'open', closesAt: daysAhead(30) });
			published(decision, 1);
			const before = withAccount(decision, 'before');
			const during = withAccount(decision, 'during');
			const reopened = withAccount(decision, 'reopened');
			sees(before.participant, 1);
			close(decider, decision.id);
			// One signs in after the close and a question-stage seen is recorded.
			sees(during.participant, 1);
			expect(reachedOf(decision, 1, before.participant, during.participant, reopened.participant)).toEqual([before.participant.id]);

			const closesAt = daysAhead(40);
			as(decider, (caller) => extendDecision(caller, { decisionId: decision.id }, { closesAt: `${closesAt.replace(' ', 'T')}Z` }, UI));
			// Card 2744: the reopening sends the invitation to the two the round never reached; neither is delivered before the ruling.
			// This leans on timing, and the timing is deterministic: `queueRecordMails` hands the send to `afterCommit`, so no
			// `mail_outcome { delivered: true }` can be written until that async send runs, and nothing here awaits before
			// `rule()` below. Were the send ever made synchronous, `during` would read as reached and the cut-off would change.
			expect(eventsOf(decision.id).filter((event) => event.kind === 'invited').map((event) => event.participantId)).toEqual([during.participant.id, reopened.participant.id]);
			sees(reopened.participant, 1);

			rule(decider, decisionRow(decision.id), { optionId: a.id, reason: 'Early, while open again.' });
			expect(cutOffs(decision.id)).toEqual([
				[before.participant.id, { reached: true }],
				[during.participant.id, { reached: false }],
				[reopened.participant.id, { reached: true }]
			]);
			// The extend emptied closed_at: this ruling was made while the decision was open.
			expect(readResults(decider, decision.id, { source: 'ui' }).ruling).toMatchObject({ early: true, closedEarly: false });
			await settled(decision.id);
		});

		it('counts nothing written after the closing time passed, until an extend reopens it (2738-10, R1)', () => {
			const { decision } = opened({ status: 'open', closesAt: FUTURE });
			published(decision, 1);
			const lapsed = withAccount(decision, 'lapsed');
			const back = withAccount(decision, 'back');
			// Seen now, when the closing time then in force (the extend's `from`) had passed.
			sees(lapsed.participant, 1);
			appendEvent({ decisionId: decision.id, kind: 'extended', detail: { from: PAST, to: FUTURE } }, SYSTEM_ACTOR);
			sees(back.participant, 1);
			expect(reachedOf(decision, 1, lapsed.participant, back.participant)).toEqual([back.participant.id]);
		});

		it('counts one who saw the question while informed and was then made consulted as reached once the invitation the role change sends is delivered; not one whose invitation was held back (2740-6, R5)', async () => {
			const { decision, a, decider } = opened({ status: 'open', closesAt: daysAhead(30) });
			published(decision, 1);
			const seenFirst = withAccount(decision, 'seenfirst', 'informed');
			const heldBack = withAccount(decision, 'heldback', 'informed');
			for (const p of [seenFirst, heldBack]) {
				appendEvent({ decisionId: decision.id, kind: 'included', participantId: p.participant.id, detail: { role: 'informed', hadAccount: true } }, SYSTEM_ACTOR);
				sees(p.participant, 1);
			}
			// Told for their information a moment ago: the 10-minute rest holds the asking mail back.
			mailed(heldBack.participant, 'invited', true);
			// R5: seen while informed, and `seen` is written once per version and stage, so neither is reached yet.
			expect(reachedOf(decision, 1, seenFirst.participant, heldBack.participant)).toEqual([]);

			const participants = [seenFirst, heldBack].map((p) => ({ personId: p.person.id, role: 'consulted' }));
			as(decider, (caller) => setParticipants(caller, { decisionId: decision.id }, { participants, revision: revisionFor(decision.id) }, UI));
			await mailsSettled(decision.id);
			expect(eventsOf(decision.id).filter((event) => event.kind === 'mail_skipped').map((event) => [event.participantId, event.detail])).toEqual([
				[heldBack.participant.id, { mail: 'invitation', reason: 'resting' }]
			]);
			expect(reachedOf(decision, 1, seenFirst.participant, heldBack.participant)).toEqual([seenFirst.participant.id]);

			rule(decider, decisionRow(decision.id), { optionId: a.id, reason: 'Early.' });
			expect(cutOffs(decision.id)).toEqual([
				[seenFirst.participant.id, { reached: true }],
				[heldBack.participant.id, { reached: false }]
			]);
			await mailsSettled(decision.id);
		});

		it('bounds the round by the id of its published event, not its moment: a mail of round 1 in the same second does not count in round 2 (2738-11, R2)', () => {
			const { decision, a, b, c } = opened({ status: 'open', closesAt: FUTURE });
			published(decision, 1);
			const earlier = withAccount(decision, 'earlier');
			const later = withAccount(decision, 'later');
			mailed(earlier.participant, 'invited', true);
			const options = [a, b, c].map((o) => ({ optionId: o.id, label: o.label, title: `Plan ${o.label}` }));
			makeVersion(decision, { question: 'Which plan?', options }, { number: 2, asksAgain: true, publishedAt: stamp() });
			published(decision, 2);
			mailed(later.participant, 'asked_again', true);
			// Every event, and the version, in one second.
			const second = stamp();
			sqlite.prepare('UPDATE decision_events SET created_at = ? WHERE decision_id = ?').run(second, decision.id);
			sqlite.prepare('UPDATE decision_versions SET published_at = ? WHERE decision_id = ?').run(second, decision.id);

			expect(reachedOf(decision, 2, earlier.participant, later.participant)).toEqual([later.participant.id]);
		});

		it('resets reach on removal: only what follows the latest re-inclusion counts, as consulted (2738-12, R3)', () => {
			const { decision } = opened({ status: 'open', closesAt: FUTURE });
			published(decision, 1);
			const included = (p: DecisionParticipant) =>
				appendEvent({ decisionId: decision.id, kind: 'included', participantId: p.id, detail: { role: 'consulted', hadAccount: true } }, SYSTEM_ACTOR);
			const removedAndBack = (p: DecisionParticipant, role: 'consulted' | 'informed') => {
				appendEvent({ decisionId: decision.id, kind: 'removed', participantId: p.id }, SYSTEM_ACTOR);
				appendEvent({ decisionId: decision.id, kind: 're_included', participantId: p.id, detail: { role, hadAccount: true } }, SYSTEM_ACTOR);
				db.update(decisionParticipants).set({ role }).where(eq(decisionParticipants.id, p.id)).run();
			};
			// Reached, then removed and brought back with nothing since: not reached.
			const stale = withAccount(decision, 'stale');
			included(stale.participant);
			mailed(stale.participant, 'invited', true);
			sees(stale.participant, 1);
			removedAndBack(stale.participant, 'consulted');
			// Removed, then re-included as informed and invited: the invitation asked nothing.
			const informed = withAccount(decision, 'informedback');
			included(informed.participant);
			removedAndBack(informed.participant, 'informed');
			mailed(informed.participant, 'invited', true);
			// Removed, then re-included as consulted and invited: reached.
			const consulted = withAccount(decision, 'consultedback');
			included(consulted.participant);
			removedAndBack(consulted.participant, 'consulted');
			mailed(consulted.participant, 'invited', true);
			// Removed, then re-included as consulted, then the question seen: reached.
			const seen = withAccount(decision, 'seenback');
			included(seen.participant);
			removedAndBack(seen.participant, 'consulted');
			sees(seen.participant, 1);

			expect(reachedOf(decision, 1, stale.participant, informed.participant, consulted.participant, seen.participant)).toEqual(
				[consulted.participant.id, seen.participant.id].sort((x, y) => x - y)
			);
		});

		it('counts the question seen of a tell-only version within the round, and a tell-only publish reopens nothing (2738-13)', () => {
			const { decision, a, b, c } = opened({ status: 'open', closesAt: FUTURE });
			published(decision, 1);
			const options = [a, b, c].map((o) => ({ optionId: o.id, label: o.label, title: `Plan ${o.label}` }));
			makeVersion(decision, { question: 'Which plan?', options }, { number: 2, asksAgain: false, publishedAt: stamp() });
			published(decision, 2, false);
			expect(currentRound(decision.id)).toBe(1);
			const told = withAccount(decision, 'told');
			const shut = withAccount(decision, 'shut');
			// Version 2 is within round 1: its question seen is the round's.
			sees(told.participant, 2);
			appendEvent({ decisionId: decision.id, kind: 'closed' }, SYSTEM_ACTOR);
			makeVersion(decision, { question: 'Which plan?', options }, { number: 3, asksAgain: false, publishedAt: stamp() });
			published(decision, 3, false);
			sees(shut.participant, 3);

			expect(reachedOf(decision, 1, told.participant, shut.participant)).toEqual([told.participant.id]);
		});

		// ─── Card 2741: a seen made while shut, or before a re-inclusion, does not hide a later view while open ──

		describe('card 2741: a view while open is recorded where no earlier seen counts', () => {
			/** The question seens of the participant, in order: how many the record holds. */
			const seensOf = (p: DecisionParticipant) => eventsOf(p.decisionId).filter((event) => event.kind === 'seen' && event.participantId === p.id).length;
			/**
			 * The participant opens their page and it posts the seen it says it would (card 2736): the page's `seenRecorded`
			 * is read first, and must be false exactly when the write records one. Answers whether one was recorded.
			 */
			const views = (who: { account: SessionUser; participant: DecisionParticipant }, versionNumber = 1) => {
				const page = readDecisionPage(who.account, who.participant.decisionId);
				expect(page.stage).toBe('question');
				const { recorded } = as(who.account, (caller) => recordSeen(caller, { decisionId: who.participant.decisionId }, { versionNumber, stage: 'question' }, UI));
				expect(recorded, 'the page posts a seen exactly when the write records one').toBe(!page.seenRecorded);
				return recorded;
			};
			/** The decider sets the participants to `who`, each consulted unless `role` says otherwise: one left out is removed, one put back re-included. */
			const setTo = (decider: SessionUser, decisionId: number, who: { person: { id: number } }[], role: (index: number) => 'consulted' | 'informed' = () => 'consulted') =>
				as(decider, (caller) =>
					setParticipants(caller, { decisionId }, { participants: who.map((p, index) => ({ personId: p.person.id, role: role(index) })), revision: revisionFor(decisionId) }, UI)
				);

			it('records a view after an extend reopened it where the only seen was made while closed, once; never again, nor for one seen before the close (2741-1)', async () => {
				const { decision, a, decider } = opened({ status: 'open', closesAt: daysAhead(30) });
				published(decision, 1);
				const before = withAccount(decision, 'before');
				const shut = withAccount(decision, 'shut');
				const responder = withAccount(decision, 'responder');
				expect(views(before), 'seen while open').toBe(true);
				close(decider, decision.id);
				expect(views(shut), 'seen while closed').toBe(true);
				expect(views(responder), 'seen while closed').toBe(true);
				// While it stays closed a view adds nothing: a new seen would count for nothing either.
				expect(views(shut), 'again while closed').toBe(false);
				expect(reachedOf(decision, 1, before.participant, shut.participant, responder.participant)).toEqual([before.participant.id]);

				as(decider, (caller) => extendDecision(caller, { decisionId: decision.id }, { closesAt: `${daysAhead(40).replace(' ', 'T')}Z` }, UI));
				// The view while open again is recorded, once; the one seen while open before the close needs none.
				expect(views(shut), 'after the extend').toBe(true);
				expect(views(shut), 'again after the extend').toBe(false);
				expect(views(before), 'seen before the close').toBe(false);
				expect([seensOf(before.participant), seensOf(shut.participant)]).toEqual([1, 2]);
				// A response records the seen by the same test.
				as(responder.account, (caller) => respondToDecision(caller, { decisionId: decision.id }, { versionNumber: 1, kind: 'vote', optionId: a.id }, UI));
				expect(seensOf(responder.participant), 'a response after the extend').toBe(2);

				expect(reachedOf(decision, 1, before.participant, shut.participant, responder.participant)).toEqual(
					[before.participant.id, shut.participant.id, responder.participant.id].sort((x, y) => x - y)
				);
				await settled(decision.id);
			});

			it('records a view after a re-inclusion as consulted where the only seen was before the removal; not after one as informed (2741-2)', async () => {
				const { decision, decider } = opened({ status: 'open', closesAt: daysAhead(30) });
				published(decision, 1);
				const stay = withAccount(decision, 'stay');
				const back = withAccount(decision, 'back');
				const told = withAccount(decision, 'told');
				expect(views(back), 'seen before the removal').toBe(true);
				expect(views(told), 'seen before the removal').toBe(true);
				expect(reachedOf(decision, 1, back.participant, told.participant)).toEqual([back.participant.id, told.participant.id].sort((x, y) => x - y));

				setTo(decider, decision.id, [stay]);
				expect(rowOf(back.participant).removedAt).not.toBeNull();
				// Brought back, `back` consulted and `told` informed.
				setTo(decider, decision.id, [stay, back, told], (index) => (index === 2 ? 'informed' : 'consulted'));
				expect([rowOf(back.participant).removedAt, rowOf(told.participant).role]).toEqual([null, 'informed']);

				expect(views(back), 'after the re-inclusion as consulted').toBe(true);
				expect(views(back), 'again').toBe(false);
				// Informed now, a new seen would count for nothing: the one before the removal stands.
				expect(views(told), 'after the re-inclusion as informed').toBe(false);
				expect([seensOf(back.participant), seensOf(told.participant)]).toEqual([2, 1]);
				expect(reachedOf(decision, 1, back.participant)).toEqual([back.participant.id]);
				await mailsSettled(decision.id);
			});

			it('records a view once made consulted where the only seen was made while informed (2741-3, R5)', () => {
				const { decision } = opened({ status: 'open', closesAt: FUTURE });
				published(decision, 1);
				const switched = withAccount(decision, 'switched', 'informed');
				appendEvent({ decisionId: decision.id, kind: 'included', participantId: switched.participant.id, detail: { role: 'informed', hadAccount: true } }, SYSTEM_ACTOR);
				expect(views(switched), 'seen while informed').toBe(true);
				expect(views(switched), 'again while informed').toBe(false);
				db.update(decisionParticipants).set({ role: 'consulted' }).where(eq(decisionParticipants.id, switched.participant.id)).run();
				appendEvent({ decisionId: decision.id, kind: 'role_changed', participantId: switched.participant.id, detail: { from: 'informed', to: 'consulted' } }, SYSTEM_ACTOR);
				expect(reachedOf(decision, 1, switched.participant)).toEqual([]);

				expect(views(switched), 'once consulted').toBe(true);
				expect(views(switched), 'again').toBe(false);
				expect(reachedOf(decision, 1, switched.participant)).toEqual([switched.participant.id]);
			});

			it('records nothing more where the round has no published event, or the closing time has passed with no extend (2741-4)', () => {
				// No `published` event (an older record): the seen stands, as before.
				const old = opened({ status: 'open', closesAt: FUTURE });
				const unpublished = withAccount(old.decision, 'unpublished');
				expect(views(unpublished)).toBe(true);
				appendEvent({ decisionId: old.decision.id, kind: 'extended', detail: { from: FUTURE, to: FUTURE } }, SYSTEM_ACTOR);
				expect(views(unpublished), 'no round to count in').toBe(false);
				// Open past its closing time: shown awaiting a ruling, so a view adds nothing.
				const lapsed = opened({ status: 'open', closesAt: daysAhead(30) });
				published(lapsed.decision, 1);
				const late = withAccount(lapsed.decision, 'late');
				db.update(decisions).set({ closesAt: PAST }).where(eq(decisions.id, lapsed.decision.id)).run();
				expect(views(late), 'seen past the closing time').toBe(true);
				expect(views(late), 'again past it').toBe(false);
				// An extend's record and row reopen it: the view is recorded.
				db.update(decisions).set({ closesAt: FUTURE }).where(eq(decisions.id, lapsed.decision.id)).run();
				appendEvent({ decisionId: lapsed.decision.id, kind: 'extended', detail: { from: PAST, to: FUTURE } }, SYSTEM_ACTOR);
				expect(views(late), 'after the extend').toBe(true);
				expect(reachedOf(lapsed.decision, 1, late.participant)).toEqual([late.participant.id]);
			});

			// ─── Code review 2026-11-05 ──

			it('records no second seen of a tell-only version where a seen of an earlier version of the round already counts (2741-5)', async () => {
				const { decision, a, b, c, decider } = opened({ status: 'open', closesAt: daysAhead(30) });
				published(decision, 1);
				const reader = withAccount(decision, 'reader');
				expect(views(reader), 'version 1 while open').toBe(true);
				// A tell-only re-publish: version 2 is within round 1.
				const options = [a, b, c].map((o) => ({ optionId: o.id, label: o.label, title: `Plan ${o.label}` }));
				makeVersion(decision, { question: 'Which plan?', options }, { number: 2, asksAgain: false, publishedAt: stamp() });
				published(decision, 2, false);
				expect(currentRound(decision.id)).toBe(1);
				close(decider, decision.id);
				expect(views(reader, 2), 'version 2 while closed').toBe(true);

				as(decider, (caller) => extendDecision(caller, { decisionId: decision.id }, { closesAt: `${daysAhead(40).replace(' ', 'T')}Z` }, UI));
				// Its seen of version 1 while open already counts in the round: a view of version 2 adds nothing.
				expect(views(reader, 2), 'version 2 after the extend').toBe(false);
				expect(seensOf(reader.participant)).toBe(2);
				expect(reachedOf(decision, 1, reader.participant)).toEqual([reader.participant.id]);
				await settled(decision.id);
			});

			it('asks both the row and the record: where either says a new seen would count for nothing, the one there stands (2741-6)', () => {
				const { decision } = opened({ status: 'open', closesAt: FUTURE });
				published(decision, 1);
				const stands = (p: DecisionParticipant, row: DecisionParticipant = rowOf(p), shown: Decision = decisionRow(decision.id)) =>
					seenStands(shown, row, 1, 'question', stamp());
				/** One who saw the question while informed and was then made consulted, by row and record alike: a view now is recorded. */
				const ready = (name: string) => {
					const { participant } = withAccount(decision, name, 'informed');
					sees(participant, 1);
					db.update(decisionParticipants).set({ role: 'consulted' }).where(eq(decisionParticipants.id, participant.id)).run();
					appendEvent({ decisionId: decision.id, kind: 'role_changed', participantId: participant.id, detail: { from: 'informed', to: 'consulted' } }, SYSTEM_ACTOR);
					expect(stands(participant), 'row and record agree: live, consulted and open').toBe(false);
					return participant;
				};

				// The row says shut where the record says open.
				const rowSide = ready('rowside');
				expect(stands(rowSide, { ...rowOf(rowSide), removedAt: stamp() }), 'the row removed, the record not').toBe(true);
				expect(stands(rowSide, { ...rowOf(rowSide), role: 'informed' }), 'the row informed, the record consulted').toBe(true);
				expect(stands(rowSide, rowOf(rowSide), { ...decisionRow(decision.id), status: 'closed' }), 'the row closed, the record open').toBe(true);
				// The record says shut where the row says open.
				const informedOnRecord = ready('informedonrecord');
				appendEvent({ decisionId: decision.id, kind: 'role_changed', participantId: informedOnRecord.id, detail: { from: 'consulted', to: 'informed' } }, SYSTEM_ACTOR);
				expect(stands(informedOnRecord), 'the record informed, the row consulted').toBe(true);
				const removedOnRecord = ready('removedonrecord');
				appendEvent({ decisionId: decision.id, kind: 'removed', participantId: removedOnRecord.id }, SYSTEM_ACTOR);
				expect(stands(removedOnRecord), 'the record removed, the row live').toBe(true);
				const closedOnRecord = ready('closedonrecord');
				appendEvent({ decisionId: decision.id, kind: 'closed' }, SYSTEM_ACTOR);
				expect(stands(closedOnRecord), 'the record closed, the row open').toBe(true);
			});
		});
	});

	it('records againstResponses by the most chosen, one row per branch (3)', async () => {
		const against = (voteMode: 'single' | 'score', give: (o: ReturnType<typeof opened>, three: DecisionParticipant[]) => void, choose: (o: ReturnType<typeof opened>) => number | null) => {
			const made = opened({ voteMode });
			const three = ['x', 'y', 'z'].map((name) => withAccount(made.decision, name).participant);
			give(made, three);
			rule(made.decider, made.decision, { optionId: choose(made), reason: 'Ruled.' });
			return rulingOf(made.decision.id)!.againstResponses;
		};
		expect(
			against('single', (o, [x, y, z]) => [answer(x, { optionId: o.a.id }), answer(y, { optionId: o.a.id }), answer(z, { optionId: o.b.id })], (o) => o.b.id),
			'(a) a majority not chosen'
		).toBe(true);
		expect(
			against('single', (o, [x, y]) => [answer(x, { optionId: o.a.id }), answer(y, { optionId: o.b.id })], (o) => o.a.id),
			'(b) a tie that includes the choice'
		).toBe(false);
		expect(against('single', (o, [x]) => answer(x, { optionId: o.a.id }), () => null), '(c) none of these with votes').toBe(true);
		expect(against('single', (o, [x]) => answer(x, { kind: 'abstain', optionId: null }), (o) => o.a.id), '(d) no votes').toBe(false);
		expect(
			against(
				'score',
				(o, [x, y]) => [
					answer(x, { optionId: null, scores: JSON.stringify({ [o.a.id]: 5, [o.b.id]: 1, [o.c.id]: 0 }) }),
					answer(y, { optionId: null, scores: JSON.stringify({ [o.a.id]: 4, [o.b.id]: 2, [o.c.id]: 0 }) })
				],
				(o) => o.b.id
			),
			'(e) score mode, by totals'
		).toBe(true);
		await sent.settle();
	});

	it('rules none of these: no option on the row, and the mail says so (4)', async () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');

		rule(decider, decision, { optionId: null, reason: 'None will do.', conditions: '   ' });

		expect(rulingOf(decision.id)).toMatchObject({ optionId: null, conditions: null });
		await settled(decision.id);
		expect(sent.emails.map((mail) => mail.to)).toEqual([pat.person.email]);
		expect(sent.emails[0].html).toContain('None of these');
	});

	it('refuses, in order, writing nothing, one row each (5)', () => {
		const { decision, a, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const retired = makeOption(decision, { label: 'R', position: 3, addedInVersion: 1, retiredInVersion: 1 });
		const admin = makeUser({ role: 'admin' });
		const outsider = makeUser();
		const draft = makeDecision({ board, author: decider, decider });
		const fine = { optionId: a.id, reason: 'Fine.' };
		const before = written();

		const rows: [string, () => unknown, { status: number; message: string }][] = [
			['401 none', () => rule(null, decision, fine), { status: 401, message: 'Not authenticated' }],
			['404 a non-viewer', () => rule(outsider, decision, fine), { status: 404, message: 'Decision not found' }],
			['403 an administrator not the decider', () => rule(admin, decision, fine), { status: 403, message: 'You cannot rule on this decision' }],
			['403 through an API key', () => rule(decider, decision, fine, API), { status: 403, message: "Ruling is a person's act: it cannot be done with an API key" }],
			['400 optionId missing', () => rule(decider, decision, { reason: 'Fine.' }), { status: 400, message: 'optionId is required' }],
			[
				'400 a retired option',
				() => rule(decider, decision, { optionId: retired.id, reason: 'Fine.' }),
				{ status: 400, message: `optionId ${retired.id} is not an option of this decision's current version` }
			],
			['400 reason empty', () => rule(decider, decision, { optionId: a.id, reason: '   ' }), { status: 400, message: 'reason is required' }],
			['400 reason of 4,001', () => rule(decider, decision, { optionId: a.id, reason: 'r'.repeat(4001) }), { status: 400, message: 'reason must be at most 4000 characters' }],
			[
				'400 conditions of 4,001',
				() => rule(decider, decision, { optionId: a.id, reason: 'Fine.', conditions: 'c'.repeat(4001) }),
				{ status: 400, message: 'conditions must be at most 4000 characters' }
			],
			['409 a draft', () => rule(decider, draft, { optionId: null, reason: 'Fine.' }), { status: 409, message: 'This decision is a draft: it cannot be ruled on' }],
			// Code review F5: two faults at once, the earlier refusal answered.
			['404 before 403: a non-viewer through an API key', () => rule(outsider, decision, fine, API), { status: 404, message: 'Decision not found' }],
			[
				'403 before 400: an API key with optionId missing',
				() => rule(decider, decision, { reason: 'Fine.' }, API),
				{ status: 403, message: "Ruling is a person's act: it cannot be done with an API key" }
			],
			['400 before 409: an empty reason on a draft', () => rule(decider, draft, { optionId: null, reason: ' ' }), { status: 400, message: 'reason is required' }],
			[
				'409 status before 409 revision: a draft with a stale revision',
				() => rule(decider, draft, { optionId: null, reason: 'Fine.', revision: 'stale' }),
				{ status: 409, message: 'This decision is a draft: it cannot be ruled on' }
			]
		];
		for (const [name, run, refusal] of rows) expect(outcome(run), name).toEqual(refusal);
		expect(written()).toEqual(before);

		// 403 a decider who has lost board edit (S8).
		sqlite.prepare("UPDATE board_members SET role = 'viewer' WHERE board_id = ? AND user_id = ?").run(board.id, decider.id);
		expect(outcome(() => rule(decider, decision, fine)), '403 board edit lost').toEqual({ status: 403, message: 'You cannot rule on this decision' });
		sqlite.prepare("UPDATE board_members SET role = 'editor' WHERE board_id = ? AND user_id = ?").run(board.id, decider.id);
		expect(written()).toEqual(before);

		// 409 a results revision read before a response arrived.
		const read = resultsRevisionFor(decision.id);
		answer(pat.participant, { optionId: a.id });
		const afterResponse = written();
		expect(outcome(() => as(decider, (caller) => ruleDecision(caller, { decisionId: decision.id }, { ...fine, revision: read }, UI))), '409 stale').toEqual({
			status: 409,
			message: STALE_REVISION
		});
		expect(afterResponse.events).toBe(before.events + 1);
		expect(written()).toEqual(afterResponse);
		expect(decisionRow(decision.id).status).toBe('closed');
	});

	it('refuses with a question open unless it is confirmed, and rules once it is (6)', async () => {
		const { decision, a, decider } = opened();
		sqlite
			.prepare("INSERT INTO decision_questions (decision_id, asker_name, question, asked_in_version, via, asked_at) VALUES (?, 'Pat', 'Why A?', 1, 'session', ?)")
			.run(decision.id, PAST);

		expect(outcome(() => rule(decider, decision, { optionId: a.id, reason: 'Fine.' }))).toEqual({
			status: 409,
			message: '1 question is still open: confirm that you rule with it open'
		});
		expect(rulingOf(decision.id)).toBeNull();
		expect(outcome(() => rule(decider, decision, { optionId: a.id, reason: 'Fine.', openQuestionsConfirmed: true }))).toBe('passed');
		expect(decisionRow(decision.id).status).toBe('ruled');
		await sent.settle();
	});

	it('moves the results revision with a response, a participant changed, a question answered, a release, a kind not yet counted, an objection or request to talk raised and one replied to, and not with a seen, a mail outcome, a concern, updated_at alone or a planted flag the reader leaves out (7; card 2684, T41)', () => {
		const { decision, a, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const questionId = Number(
			sqlite
				.prepare("INSERT INTO decision_questions (decision_id, asker_name, question, asked_in_version, via, asked_at) VALUES (?, 'Pat', 'Why A?', 1, 'session', ?)")
				.run(decision.id, PAST).lastInsertRowid
		);
		const moves = (change: () => void) => {
			const was = resultsRevisionFor(decision.id);
			change();
			return resultsRevisionFor(decision.id) !== was;
		};

		expect(moves(() => answer(pat.participant, { optionId: a.id })), 'a response').toBe(true);
		expect(moves(() => db.update(decisionParticipants).set({ role: 'informed' }).where(eq(decisionParticipants.id, pat.participant.id)).run()), 'a participant').toBe(true);
		// Card 2706 (D1): the editor revision no longer covers a participant's account or address; this one still does.
		const editorRevision = revisionFor(decision.id);
		expect(moves(() => db.update(decisionParticipants).set({ userId: null }).where(eq(decisionParticipants.id, pat.participant.id)).run()), 'an account').toBe(true);
		expect(
			moves(() => db.update(decisionParticipants).set({ email: 'pat.moved@example.test' }).where(eq(decisionParticipants.id, pat.participant.id)).run()),
			'an address'
		).toBe(true);
		expect(revisionFor(decision.id), 'the editor revision').toBe(editorRevision);
		expect(moves(() => sqlite.prepare("UPDATE decision_questions SET answer = 'Cost.', answered_at = ? WHERE id = ?").run(PAST, questionId)), 'an answer').toBe(true);
		expect(
			moves(() => appendEvent({ decisionId: decision.id, kind: 'seen', participantId: pat.participant.id, versionNumber: 1, detail: { stage: 'question' } }, SYSTEM_ACTOR)),
			'a seen'
		).toBe(false);
		expect(
			moves(() => appendEvent({ decisionId: decision.id, kind: 'mail_outcome', participantId: pat.participant.id, detail: { of: 1, delivered: true } }, SYSTEM_ACTOR)),
			'a mail outcome'
		).toBe(false);
		expect(moves(() => makeResponse(pat.participant, { kind: 'concern', comment: 'I worry.' })), 'a concern').toBe(false);
		// Card 2734: `updated_at` stamped alone, as a Resend's `touch` stamps it, no longer moves it; a release's column does.
		expect(moves(() => db.update(decisions).set({ updatedAt: '2026-11-04 12:00:00' }).where(eq(decisions.id, decision.id)).run()), 'updated_at alone').toBe(false);
		expect(
			moves(() => db.update(decisions).set({ resultsReleasedAt: '2026-11-04 12:00:00' }).where(eq(decisions.id, decision.id)).run()),
			'results_released_at'
		).toBe(true);
		// Code review F1: it fails closed, so a kind no tally counts yet moves it.
		expect(moves(() => makeResponse(pat.participant, { kind: 'not_a_kind', comment: 'A kind not yet counted.' })), 'a kind not yet counted').toBe(true);
		// Card 2684 (R10, T41): an objection raised, a request to talk raised, and each replied to.
		// Pat's place no longer holds an account: two others raise them.
		const ria = withAccount(decision, 'ria');
		const quin = withAccount(decision, 'quin');
		expect(moves(() => flag(ria.account, decision, { kind: 'objection', reason: 'Too dear.' })), 'an objection raised').toBe(true);
		expect(moves(() => flag(quin.account, decision, { kind: 'talk' })), 'a request to talk raised').toBe(true);
		const [objectionId, talkId] = flagIdsOf(decision.id);
		expect(moves(() => replyTo(decider, decision, objectionId, 'The budget covers it.')), 'an objection answered').toBe(true);
		expect(moves(() => replyTo(decider, decision, talkId, 'We spoke.')), 'a talk outcome').toBe(true);
		// A row the tolerant reader leaves out is not covered (R10, R19).
		const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(moves(() => plantFlag(decision.id, pat.participant.id, { kind: 'veto' })), 'a planted flag left out').toBe(false);
		} finally {
			quiet.mockRestore();
		}
		// The keyed HMAC, not the draft revision.
		const flagRows = sqlite.prepare("SELECT id, replied_at AS repliedAt FROM decision_flags WHERE decision_id = ? AND kind != 'veto' ORDER BY id").all(decision.id) as {
			id: number;
			repliedAt: string;
		}[];
		expect(resultsRevisionFor(decision.id)).toBe(
			resultsRevisionOf({
				decision: decisionRow(decision.id),
				options: allOptionsOf(decision.id),
				participants: participantsOf(decision.id),
				responseIds: (sqlite.prepare("SELECT id FROM decision_responses WHERE decision_id = ? AND kind != 'concern'").all(decision.id) as { id: number }[]).map((r) => r.id),
				// Card 2678 (decision 11): the publishing moment of an agent's draft, and its flag, too.
				questions: [{ id: questionId, answeredAt: PAST, answerReviewedAt: null, answerAgentDrafted: false }],
				// Card 2684 (R10): each flag the reader keeps, and when it was replied to.
				flags: flagRows
			})
		);
	});

	it('leaves the results revision as the decider read it across a Resend, so the ruling passes with it, and still moves with a response, a participant change and a release (7b, card 2734)', async () => {
		const { decision, a, decider } = opened({ status: 'open', closesAt: FUTURE });
		const pat = withAccount(decision, 'pat');
		const sam = withAccount(decision, 'sam');
		const ivy = withAccount(decision, 'ivy');
		const admin = makeUser({ username: `admin${++seq}`, role: 'admin' });
		db.update(decisions).set({ updatedAt: '2026-11-01 09:00:00' }).where(eq(decisions.id, decision.id)).run();
		const read = resultsRevisionFor(decision.id);
		const before = eventsOf(decision.id).length;

		// An administrator's Resend while the decider's results page is open: a delivery act alone.
		as(admin, (caller) => resendInvitation(caller, { decisionId: decision.id, participantId: pat.participant.id }, null, UI));
		await sent.settle();

		expect(decisionRow(decision.id).updatedAt, 'updated_at still stamped (D2)').not.toBe('2026-11-01 09:00:00');
		expect(eventsOf(decision.id).slice(before).map((event) => event.kind)).toEqual(['invited', 'mail_outcome']);
		expect(sent.emails.map((mail) => mail.to)).toEqual([pat.person.email]);
		expect(resultsRevisionFor(decision.id), 'the revision the decider read').toBe(read);

		// What still moves it, between reading the results and ruling on them.
		const moves = (change: () => void) => {
			const was = resultsRevisionFor(decision.id);
			change();
			return resultsRevisionFor(decision.id) !== was;
		};
		expect(moves(() => answer(sam.participant, { optionId: a.id })), 'a response').toBe(true);
		expect(
			moves(() =>
				as(decider, (caller) =>
					setParticipants(
						caller,
						{ decisionId: decision.id },
						{
							participants: [
								{ personId: pat.person.id, role: 'consulted' },
								{ personId: ivy.person.id, role: 'consulted' }
							],
							revision: revisionFor(decision.id)
						},
						UI
					)
				)
			),
			'a participant removed'
		).toBe(true);
		await sent.settle();

		// The ruling with the revision read after the response and the removal, and another Resend between: passed.
		const now = resultsRevisionFor(decision.id);
		as(admin, (caller) => resendInvitation(caller, { decisionId: decision.id, participantId: ivy.participant.id }, null, UI));
		await sent.settle();
		expect(
			outcome(() => as(decider, (caller) => ruleDecision(caller, { decisionId: decision.id }, { optionId: a.id, reason: 'A is enough.', revision: now }, UI)))
		).toBe('passed');
		await sent.settle();

		// A release moves it: `results_released_at`, which stands where `updated_at` stood.
		const ruled = releasable();
		const beforeRelease = resultsRevisionFor(ruled.decision.id);
		release(ruled.decider, ruled.decision);
		expect(decisionRow(ruled.decision.id).resultsReleasedAt).not.toBeNull();
		expect(resultsRevisionFor(ruled.decision.id), 'a release').not.toBe(beforeRelease);
	});

	it("is the keyed HMAC of its JSON built by hand: the decision with results_released_at last (card 2734, in place of updated_at), the options, each participant's account and address, the responses, the questions (card 2706, D1) and the flags (card 2684, R10)", () => {
		const { decision, a, b, c } = opened();
		const pat = withAccount(decision, 'pat');
		const linky = withLink(decision, 'linky-token');
		const gone = makeParticipant(decision, { person: makePerson({ fullName: 'Gone Person' }), role: 'informed', removedAt: PAST });
		const vote = answer(pat.participant, { optionId: a.id });
		const abstain = answer(linky.participant, { kind: 'abstain', optionId: null });
		makeResponse(pat.participant, { kind: 'concern', comment: 'Never covered.' });
		const askAt = (question: string) =>
			Number(
				sqlite
					.prepare("INSERT INTO decision_questions (decision_id, asker_name, question, asked_in_version, via, asked_at) VALUES (?, 'Pat', ?, 1, 'session', ?)")
					.run(decision.id, question, PAST).lastInsertRowid
			);
		const open = askAt('Why A?');
		const drafted = askAt('Why not B?');
		sqlite
			.prepare("UPDATE decision_questions SET answer = 'Cost.', answered_at = ?, answer_reviewed_at = ?, answer_agent_drafted = 1 WHERE id = ?")
			.run(PAST, '2026-11-02 10:00:00', drafted);
		// Card 2734: a moment set, so the pin tells the column from a null in its place.
		db.update(decisions).set({ resultsReleasedAt: '2026-11-04 12:00:00' }).where(eq(decisions.id, decision.id)).run();
		// Card 2684 (R10): a flag replied to, and one not, the reply's moment covered.
		const objection = plantFlag(decision.id, pat.participant.id, { kind: 'objection', reply: 'Covered.', repliedAt: '2026-11-03 10:00:00' });
		const talk = plantFlag(decision.id, linky.participant.id, { kind: 'talk' });
		const row = decisionRow(decision.id);
		expect(pat.participant.userId, 'an account to cover').toBe(pat.account.id);

		// Card 2734 changed this value on purpose: `updated_at` is gone from the end of the decision's columns and
		// `results_released_at` stands there. Before, this test pinned that card 2706 left the value as it was.
		const covered = JSON.stringify({
			decision: [row.title, row.status, row.closesAt, row.voteMode, row.workingContent, row.currentVersion, row.deciderUserId, row.resultsReleasedAt],
			options: [a, b, c].map((o) => [o.id, o.label, o.position, o.addedInVersion, o.retiredInVersion]),
			participants: [pat.participant, linky.participant, gone].map((p) => [p.id, p.personId, p.role, p.userId, p.email, p.removedAt]),
			responses: [vote.id, abstain.id],
			questions: [
				[open, null, null, false],
				[drafted, PAST, '2026-11-02 10:00:00', true]
			],
			flags: [
				[objection, '2026-11-03 10:00:00'],
				[talk, null]
			]
		});

		const revision = resultsRevisionFor(decision.id);

		expect(revision).toMatch(/^[0-9a-f]{64}$/);
		expect(revision).not.toBe(createHash('sha256').update(covered).digest('hex'));
		expect(revision).not.toBe(createHmac('sha256', purposeKey('decision-revision')).update(covered).digest('hex'));
		expect(revision).toBe(createHmac('sha256', purposeKey('decision-results-revision')).update(covered).digest('hex'));
		// And `updated_at` alone, as a Resend stamps it, leaves it as it was.
		db.update(decisions).set({ updatedAt: '2026-11-05 08:00:00' }).where(eq(decisions.id, decision.id)).run();
		expect(resultsRevisionFor(decision.id)).toBe(revision);
	});

	it('marks the old decision superseded when its decider rules the one superseding it, and not when someone else does (8)', async () => {
		// (a) The old decision's decider rules the new one.
		const old = opened({ title: 'The old one' });
		makeRuling(old.decision);
		const next = opened({ title: 'The new one', supersedesId: old.decision.id, decider: old.decider });
		rule(old.decider, next.decision, { optionId: next.a.id, reason: 'Changed.' });

		expect(decisionRow(old.decision.id).status, '(a)').toBe('superseded');
		const afterRuling = (decisionId: number) => eventsOf(decisionId).filter((event) => event.kind !== 'ruled');
		expect(afterRuling(old.decision.id).map((event) => [event.kind, event.detail]), '(a)').toEqual([['superseded', { byDecisionId: next.decision.id }]]);
		expect(eventsOf(next.decision.id).find((event) => event.kind === 'ruled')?.detail, '(a)').toEqual({
			optionId: next.a.id,
			early: false,
			againstResponses: false,
			productOwnerUserId: null,
			supersededOld: true
		});
		expect(activityRows().map((row) => [row.action, row.detail]), '(a)').toEqual([
			['decision_ruled', '"The new one"'],
			['decision_superseded', '"The old one"']
		]);
		expect(liveEvents(), '(a)').toEqual([
			{ decisionId: next.decision.id, status: 'ruled', boardId: board.id },
			{ decisionId: old.decision.id, status: 'superseded', boardId: board.id }
		]);

		// (b) A decider named on the draft who is not the old decider, the Product Owner or an administrator.
		const older = opened({ title: 'Older' });
		makeRuling(older.decision);
		const other = opened({ title: 'Other', supersedesId: older.decision.id });
		rule(other.decider, other.decision, { optionId: other.a.id, reason: 'Changed.' });

		expect(decisionRow(older.decision.id).status, '(b)').toBe('ruled');
		expect(afterRuling(older.decision.id), '(b)').toEqual([]);
		expect(eventsOf(other.decision.id).find((event) => event.kind === 'ruled')?.detail.supersededOld, '(b)').toBe(false);

		// (c) Code review S1: a board owner who makes themselves Product Owner after the old ruling neither supersedes it nor,
		// ruling a decision that supersedes it, marks it superseded. Whom the ruling recorded as Product Owner (none) is asked.
		const oldest = opened({ title: 'Oldest' });
		makeRuling(oldest.decision);
		db.update(boards).set({ productOwnerUserId: owner.id }).where(eq(boards.id, board.id)).run();
		expect(outcome(() => supersede(owner, decisionRow(oldest.decision.id))), '(c) supersede').toEqual({ status: 403, message: 'You cannot supersede this decision' });
		const owners = opened({ title: "The owner's", supersedesId: oldest.decision.id, decider: owner });
		rule(owner, owners.decision, { optionId: owners.a.id, reason: 'Mine now.' });
		expect(decisionRow(oldest.decision.id).status, '(c)').toBe('ruled');
		expect(afterRuling(oldest.decision.id), '(c)').toEqual([]);
		expect(eventsOf(owners.decision.id).find((event) => event.kind === 'ruled')?.detail, '(c) recorded now').toMatchObject({
			productOwnerUserId: owner.id,
			supersededOld: false
		});
		await sent.settle();
	});

	it('rules a decision whose board is gone, with no activity entry and no live event (9)', async () => {
		const decider = makeUser({ username: 'boardless' });
		const { decision, a } = opened({ board: null, decider });

		rule(decider, decision, { optionId: a.id, reason: 'Ruled.' });

		expect(decisionRow(decision.id).status).toBe('ruled');
		expect(activityRows()).toEqual([]);
		expect(liveEvents()).toEqual([]);
		await sent.settle();
	});
});

// ─── Release (cases 11, 12, 14 to 16) ────────────────────────────────────────

describe('releaseResults', () => {
	it('sets the release, records it with the highest response id and nothing left out, logs it, and mails nobody (11)', async () => {
		const r = releasable();

		const row = release(r.decider, r.decision);

		expect(row).toMatchObject({ resultsReleasedAt: expect.any(String), resultsReleasedBy: r.decider.id });
		expect(eventsOf(r.decision.id).filter((event) => event.kind === 'results_released').map((event) => event.detail)).toEqual([
			{ upToResponseId: r.responses.rias.id, omitted: [] }
		]);
		expect(activityRows()).toEqual([{ boardId: board.id, action: 'decision_results_released', detail: `"${r.decision.title}"` }]);
		expect(liveEvents()).toEqual([{ decisionId: r.decision.id, status: 'ruled', boardId: board.id }]);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('[1b] shows the released results on a board reader’s page and a link holder’s, and on neither before (11)', () => {
		const r = releasable();
		withLink(r.decision, 'token-released');
		const reader = boardReader();
		expect(readDecisionPage(reader, r.decision.id).released).toBeNull();
		expect(readLinkPage('token-released', null)?.released).toBeNull();

		release(r.decider, decisionRow(r.decision.id));

		const released = releasedOf(decisionRow(r.decision.id));
		expect(released).not.toBeNull();
		expect(readDecisionPage(reader, r.decision.id).released).toEqual(released);
		expect(readLinkPage('token-released', null)?.released).toEqual(released);
	});

	it('refuses, writing nothing, one row each (12)', () => {
		const refusal = (make: (r: ReturnType<typeof releasable>) => { user: SessionUser; decision: Decision; body?: Record<string, unknown>; opts?: ServiceOptions }) => {
			const r = releasable();
			const { user, decision, body, opts } = make(r);
			const before = written();
			const answered = outcome(() => release(user, decisionRow(decision.id), body, opts));
			expect(written()).toEqual(before);
			return answered;
		};
		const words = (status: number, message: string) => ({ status, message });

		expect(refusal((r) => ({ user: makeUser({ role: 'admin' }), decision: r.decision })), 'an administrator').toEqual(words(403, 'You cannot release the results of this decision'));
		expect(refusal((r) => ({ user: r.decider, decision: r.decision, opts: API })), 'an API key').toEqual(
			words(403, "Releasing results is a person's act: it cannot be done with an API key")
		);
		expect(
			refusal((r) => {
				db.update(decisions).set({ status: 'open', closesAt: FUTURE }).where(eq(decisions.id, r.decision.id)).run();
				return { user: r.decider, decision: r.decision };
			}),
			'open'
		).toEqual(words(409, 'This decision is open: its results cannot be released'));
		expect(
			refusal((r) => {
				db.update(decisions).set({ status: 'superseded' }).where(eq(decisions.id, r.decision.id)).run();
				return { user: r.decider, decision: r.decision };
			}),
			'superseded'
		).toEqual(words(409, 'This decision is superseded: its results cannot be released'));
		expect(
			refusal((r) => {
				release(r.decider, r.decision);
				return { user: r.decider, decision: r.decision };
			}),
			'already released'
		).toEqual(words(409, ALREADY_RELEASED));
		expect(
			refusal((r) => {
				db.update(decisionParticipants).set({ removedAt: PAST }).where(eq(decisionParticipants.id, r.ria.participant.id)).run();
				return { user: r.decider, decision: r.decision };
			}),
			'fewer than 3'
		).toEqual(words(409, TOO_FEW_TO_RELEASE));
		expect(
			refusal((r) => {
				answer(r.ria.participant, { kind: 'no_concerns', optionId: null }, null);
				return { user: r.decider, decision: r.decision };
			}),
			'under the old statement'
		).toEqual(words(409, '1 of these responses were given before the page said the results could be released: they cannot be released'));
		expect(refusal((r) => ({ user: r.decider, decision: r.decision, body: { revision: 'stale' } })), 'a stale revision').toEqual(words(409, STALE_REVISION));
		expect(refusal((r) => ({ user: r.decider, decision: r.decision, body: { omit: ['not-a-key'] } })), 'an unknown key').toEqual(
			words(400, 'omit[0] is not a comment this release would show')
		);

		// Code review F5: two faults at once, the earlier refusal answered.
		expect(refusal((r) => ({ user: makeUser({ role: 'admin' }), decision: r.decision, opts: API })), 'an administrator through an API key').toEqual(
			words(403, 'You cannot release the results of this decision')
		);
		expect(
			refusal((r) => {
				db.update(decisions).set({ status: 'open', closesAt: FUTURE }).where(eq(decisions.id, r.decision.id)).run();
				return { user: r.decider, decision: r.decision, body: { revision: 'stale' } };
			}),
			'open, with a stale revision'
		).toEqual(words(409, 'This decision is open: its results cannot be released'));
		expect(
			refusal((r) => {
				db.update(decisionParticipants).set({ removedAt: PAST }).where(eq(decisionParticipants.id, r.ria.participant.id)).run();
				return { user: r.decider, decision: r.decision, body: { revision: 'stale', omit: ['not-a-key'] } };
			}),
			'fewer than 3, with a stale revision and an unknown key'
		).toEqual(words(409, TOO_FEW_TO_RELEASE));
		expect(
			refusal((r) => {
				release(r.decider, r.decision);
				return { user: r.decider, decision: r.decision, body: { omit: ['not-a-key'] } };
			}),
			'already released, with an unknown key'
		).toEqual(words(409, ALREADY_RELEASED));
	});

	it('leaves out a comment named by its key, and records which (14)', () => {
		const r = releasable();
		const preview = previewOf(r.decision);
		const left = preview.comments.find((comment) => comment.text === 'A, gladly.')!;

		release(r.decider, r.decision, { omit: [left.key] });

		const released = releasedOf(decisionRow(r.decision.id))!;
		expect(released.comments).toEqual(['Either is fine.', 'Plan A is enough.']);
		expect(released.options.find((option) => option.optionId === r.b.id)?.comments).toEqual(['B costs too much.']);
		expect(eventsOf(r.decision.id).find((event) => event.kind === 'results_released')?.detail.omitted).toEqual([{ responseId: r.responses.quins.id, field: 'comment' }]);
		// The key is not the response id, and another decision gives the same response another.
		expect(left.key).toMatch(/^[0-9a-f]{64}$/);
		expect(left.key).toBe(commentKeyOf(r.decision.id, r.responses.quins.id, 'comment'));
		expect(commentKeyOf(r.decision.id + 1, r.responses.quins.id, 'comment')).not.toBe(left.key);
	});

	it('is frozen at the release: a response written after it changes nothing shown (15)', () => {
		const r = releasable();
		release(r.decider, r.decision);
		const before = releasedOf(decisionRow(r.decision.id));

		answer(r.ria.participant, { optionId: r.b.id, comment: 'Changed my mind.' });

		expect(releasedOf(decisionRow(r.decision.id))).toEqual(before);
	});

	it('refuses a release 1 or 2 people from another in its supersede chain, and allows the same people or 3 apart (16)', () => {
		const people = Array.from({ length: 6 }, (_, i) => makePerson({ fullName: `Chain ${i}` }));
		/** A ruled decision answered under the current statement by the people named (null: a participant whose person is gone). */
		const ruledBy = (persons: (number | null)[], supersedesId: number | null = null) => {
			const made = opened({ supersedesId });
			for (const index of persons) {
				const participant = makeParticipant(made.decision, { person: index === null ? null : people[index] });
				answer(participant, { optionId: made.a.id });
			}
			makeRuling(made.decision, { optionId: made.a.id });
			return { ...made, decision: decisionRow(made.decision.id) };
		};
		const chain = (these: (number | null)[]) => {
			const earlier = ruledBy([0, 1, 2]);
			release(earlier.decider, earlier.decision);
			const later = ruledBy(these, earlier.decision.id);
			return outcome(() => release(later.decider, later.decision));
		};

		expect(chain([0, 1, null]), '(a) one apart, a participant with no person among them').toEqual({ status: 409, message: CHAIN_TOO_CLOSE });
		expect(chain([0, 3, 4]), '(b) two apart').toEqual({ status: 409, message: CHAIN_TOO_CLOSE });
		expect(chain([0, 1, 2]), '(c) the same people').toBe('passed');
		expect(chain([3, 4, 5]), '(d) three apart').toBe('passed');
		// Code review F5: the same three and one whose person is gone, [0, 1, 2, null] against [0, 1, 2], is one apart.
		expect(chain([0, 1, 2, null]), '(e) the same people and one with no person').toEqual({ status: 409, message: CHAIN_TOO_CLOSE });
	});
});

// ─── What is released (cases 17 to 19) ───────────────────────────────────────

describe('releasedOf', () => {
	it('holds nothing beside a comment, sorts comments by text, and counts only live consulted participants’ latest in the ruling round, never a concern (17)', () => {
		const r = releasable();
		// What is not released: an earlier answer replaced, a removed participant's, an informed one's, an earlier round's, and a concern.
		const gone = withAccount(r.decision, 'gone');
		answer(gone.participant, { optionId: r.c.id, comment: 'Removed said this.' });
		db.update(decisionParticipants).set({ removedAt: PAST }).where(eq(decisionParticipants.id, gone.participant.id)).run();
		const told = withAccount(r.decision, 'told', 'informed');
		answer(told.participant, { optionId: r.c.id, comment: 'Informed said this.' });
		answer(r.pat.participant, { optionId: r.c.id, comment: 'An earlier round.', round: 0 });
		makeResponse(r.quin.participant, { kind: 'concern', comment: 'A concern said this.' });
		release(r.decider, r.decision);

		const released = releasedOf(decisionRow(r.decision.id))!;

		expect(released).toEqual({
			voteMode: 'single',
			responded: null,
			voted: null,
			abstained: null,
			noConcerns: 0,
			options: [
				{ optionId: r.a.id, label: 'A', title: 'Plan A', votes: null, mean: null, comments: [] },
				{ optionId: r.b.id, label: 'B', title: 'Plan B', votes: 0, mean: null, comments: ['B costs too much.'] },
				{ optionId: r.c.id, label: 'C', title: 'Plan C', votes: 0, mean: null, comments: [] }
			],
			comments: ['A, gladly.', 'Either is fine.', 'Plan A is enough.']
		});
		const text = JSON.stringify(released);
		for (const absent of ['Removed said', 'Informed said', 'An earlier round', 'A concern said', 'pat', 'Person', '2026-11', 'session']) expect(text).not.toContain(absent);
	});

	it('hands the projection rows with no group, and gives exactly the released shape (18)', () => {
		const r = releasable();
		db.update(decisionParticipants).set({ groups: JSON.stringify(['Finance']) }).run();
		release(r.decider, r.decision);

		for (const row of releaseRowsOf(decisionRow(r.decision.id), null)) expect(Object.keys(row).sort()).toEqual(['comment', 'kind', 'optionComments', 'optionId', 'participantId', 'responseId', 'scores']);
		const released = releasedOf(decisionRow(r.decision.id))!;
		const shape: (keyof ReleasedResults)[] = ['abstained', 'comments', 'noConcerns', 'options', 'responded', 'voteMode', 'voted'];
		expect(Object.keys(released).sort()).toEqual(shape);
		for (const option of released.options) expect(Object.keys(option).sort()).toEqual(['comments', 'label', 'mean', 'optionId', 'title', 'votes']);
		expect(JSON.stringify(released)).not.toContain('Finance');
	});

	it('withholds each figure that could single someone out, one row per branch (19)', () => {
		/** The preview's figures for a decision answered as `give` says, by people of a fresh decision. */
		const figures = (voteMode: 'single' | 'score', give: (o: ReturnType<typeof opened>) => Record<string, unknown>[]) => {
			const made = opened({ voteMode });
			for (const response of give(made)) answer(withAccount(made.decision, 'p').participant, response);
			makeRuling(made.decision);
			const preview = previewOf(decisionRow(made.decision.id));
			return {
				responded: preview.responded,
				voted: preview.voted,
				votes: preview.options.map((option) => option.votes),
				means: preview.options.map((option) => option.mean),
				abstained: preview.abstained,
				noConcerns: preview.noConcerns
			};
		};
		const votes = (o: ReturnType<typeof opened>, a: number, b: number, c: number) => [
			...Array.from({ length: a }, () => ({ optionId: o.a.id })),
			...Array.from({ length: b }, () => ({ optionId: o.b.id })),
			...Array.from({ length: c }, () => ({ optionId: o.c.id }))
		];
		const scores = (o: ReturnType<typeof opened>, a: number, b: number) => ({ optionId: null, scores: JSON.stringify({ [o.a.id]: a, [o.b.id]: b, [o.c.id]: 0 }) });

		expect(figures('single', (o) => votes(o, 3, 3, 0)), '(a) every cell 0 or 3 and more, none everyone').toMatchObject({
			responded: 6,
			votes: [3, 3, 0],
			abstained: 0,
			noConcerns: 0
		});
		expect(figures('single', (o) => votes(o, 3, 3, 1)), '(b) a cell of 1').toMatchObject({ responded: null, votes: [3, 3, null] });
		expect(figures('single', (o) => votes(o, 1, 2, 3)), '(c) cells of 1 and 2').toMatchObject({ responded: null, votes: [null, null, 3] });
		expect(figures('single', (o) => votes(o, 2, 2, 0)), '(d) every cell 2').toMatchObject({ responded: null, votes: [null, null, 0] });
		expect(figures('single', (o) => votes(o, 4, 0, 0)), '(e) one cell holds every response').toEqual({
			responded: null,
			voted: null,
			votes: [null, null, null],
			means: [null, null, null],
			abstained: null,
			noConcerns: null
		});
		expect(
			figures('score', (o) => [scores(o, 5, 1), scores(o, 3, 2), { kind: 'abstain', optionId: null }]),
			'(f) score mode with 2 votes'
		).toMatchObject({ means: [null, null, null] });
		expect(
			figures('score', (o) => [scores(o, 4, 1), scores(o, 4, 2), scores(o, 4, 5)]),
			'(g) every voter gave A the same score, and B three scores of one voter each'
		).toMatchObject({ means: [null, null, null] });
		// Code review S2: an option's scores are cells, and a mean is shown only where none of them would be withheld.
		expect(figures('score', (o) => [scores(o, 5, 0), scores(o, 5, 0), scores(o, 4, 0)]), '(h) {5, 5, 4}: cells of 2 and 1').toMatchObject({
			means: [null, null, null]
		});
		expect(
			figures('score', (o) => [scores(o, 5, 0), scores(o, 5, 0), scores(o, 5, 0), scores(o, 1, 4), scores(o, 1, 4), scores(o, 1, 4)]),
			'(i) three at each score given: shown'
		).toMatchObject({ means: [3, 2, null] });
	});

	it('withholds, beside another release in its supersede chain, the number who responded always and never one cell alone (S4)', () => {
		const eight = Array.from({ length: 8 }, (_, i) => makePerson({ fullName: `Eight ${i}` }));
		/** A ruled decision the eight answered, `a`, `b` and `c` of them choosing each option. */
		const answeredBy = (counts: [number, number, number], supersedesId: number | null = null) => {
			const made = opened({ supersedesId });
			const choices = [...Array(counts[0]).fill(made.a.id), ...Array(counts[1]).fill(made.b.id), ...Array(counts[2]).fill(made.c.id)];
			eight.forEach((person, index) => answer(makeParticipant(made.decision, { person }), { optionId: choices[index] }));
			makeRuling(made.decision);
			return { ...made, decision: decisionRow(made.decision.id) };
		};
		const first = answeredBy([3, 3, 2]);
		// Alone, one cell of 2 is withheld, and the number who responded with it.
		expect(previewOf(first.decision), 'alone').toMatchObject({ responded: null, options: [{ votes: 3 }, { votes: 3 }, { votes: null }] });
		release(first.decider, first.decision);

		// The same eight on the decision superseding it: every cell may be shown, but not the number who responded.
		const second = answeredBy([4, 4, 0], first.decision.id);
		const preview = previewOf(second.decision);
		expect(preview, 'the second, before its release').toMatchObject({ responded: null, abstained: 0, noConcerns: 0, options: [{ votes: 4 }, { votes: 4 }, { votes: 0 }] });
		release(second.decider, second.decision);
		expect(releasedOf(decisionRow(second.decision.id))?.responded, 'the second').toBeNull();

		// The first, read beside it, withholds a second cell with its 2: 8 - 3 - 3 can no longer be worked out from either.
		const firstNow = releasedOf(decisionRow(first.decision.id))!;
		expect(firstNow.responded, 'the first').toBeNull();
		expect(firstNow.options.map((option) => option.votes), 'the first').toEqual([null, 3, null]);
	});

	it('[1b] shows a board reader after the release exactly what the decider previewed, less its keys and the comments left out (20)', () => {
		const r = releasable();
		const reader = boardReader();
		const preview = readResults(r.decider, r.decision.id, { source: 'ui' }).releasePreview!;
		const left = preview.options.find((option) => option.optionId === r.b.id)!.comments[0].key;

		release(r.decider, r.decision, { omit: [left] });

		const kept = (comments: { text: string; key: string }[]) => comments.filter((comment) => comment.key !== left).map((comment) => comment.text);
		expect(readDecisionPage(reader, r.decision.id).released).toEqual({
			...preview,
			options: preview.options.map((option) => ({ ...option, comments: kept(option.comments) })),
			comments: kept(preview.comments)
		});
	});
});

// ─── The results (cases 21 to 23) ────────────────────────────────────────────

describe('readResults', () => {
	it('gives the decider and an administrator the tallies, each latest response by name, who has not answered, the removed, questions, concerns, the ruling and the preview (21)', async () => {
		const { decision, a, b, c, decider } = opened({ status: 'open', closesAt: FUTURE });
		const pat = withAccount(decision, 'pat');
		const quin = withAccount(decision, 'quin');
		const ria = withAccount(decision, 'ria');
		withAccount(decision, 'ivy', 'informed');
		const rem = withAccount(decision, 'rem');
		answer(pat.participant, { optionId: a.id });
		answer(rem.participant, { optionId: b.id });
		makeVersion(decision, { question: 'Which plan?', options: [a, b, c].map((o) => ({ optionId: o.id, label: o.label, title: `Plan ${o.label}` })) }, { number: 2, asksAgain: true });
		answer(pat.participant, { optionId: a.id, round: 2, versionNumber: 2, comment: 'A first.' });
		answer(pat.participant, { optionId: b.id, round: 2, versionNumber: 2, comment: 'B after all.', createdAt: '2026-11-01 11:00:00' });
		answer(quin.participant, { kind: 'abstain', optionId: null, round: 2, versionNumber: 2, comment: 'Not my area.' });
		const remsLast = answer(rem.participant, { optionId: c.id, round: 2, versionNumber: 2 });
		db.update(decisionParticipants).set({ removedAt: PAST }).where(eq(decisionParticipants.id, rem.participant.id)).run();
		sqlite
			.prepare("INSERT INTO decision_questions (decision_id, asker_name, question, asked_in_version, via, asked_at) VALUES (?, 'Quin', 'Why C?', 2, 'session', ?)")
			.run(decision.id, PAST);
		rule(decider, decisionRow(decision.id), { optionId: c.id, reason: 'C, for the long run.', openQuestionsConfirmed: true });
		makeResponse(pat.participant, { kind: 'concern', comment: 'I worry about C.', round: 2, versionNumber: 2, createdAt: '2026-11-03 09:00:00' });

		const results = readResults(decider, decision.id, { source: 'ui' });

		// Card 2684 (R7, T42): the same but `mayReply`, which is the decider's alone.
		expect(readResults(makeUser({ role: 'admin' }), decision.id, { source: 'ui' })).toEqual({ ...results, mayReply: false });
		const row = (who: { participant: DecisionParticipant }, more: Record<string, unknown>) => ({
			participantId: who.participant.id,
			name: who.participant.name,
			role: 'consulted',
			groups: [],
			optionId: null,
			scores: null,
			comment: null,
			optionComments: {},
			// Card 2683: no survey answer.
			answers: {},
			versionNumber: 2,
			createdAt: '2026-11-01 10:00:00',
			via: 'session',
			changes: 0,
			...more
		});
		expect(results.current).toEqual({
			round: 2,
			responded: 2,
			voted: 1,
			votes: [
				{ optionId: a.id, count: 0 },
				{ optionId: b.id, count: 1 },
				{ optionId: c.id, count: 0 }
			],
			scores: [],
			abstained: 1,
			noConcerns: 0,
			// Card 2683: no version asked a survey question.
			survey: [],
			rows: [
				row(pat, { kind: 'vote', optionId: b.id, comment: 'B after all.', createdAt: '2026-11-01 11:00:00', changes: 1 }),
				row(quin, { kind: 'abstain', comment: 'Not my area.' })
			]
		});
		expect(results.earlierRounds.map((tally) => [tally.round, tally.responded, tally.votes.map((v) => v.count)])).toEqual([[1, 1, [1, 0, 0]]]);
		expect(results.notResponded).toEqual([{ participantId: ria.participant.id, name: ria.participant.name, groups: [], reached: false }]);
		expect(results.removed).toEqual([
			{ participantId: rem.participant.id, name: rem.participant.name, role: 'consulted', latest: row(rem, { kind: 'vote', optionId: c.id }) }
		]);
		expect(remsLast.round).toBe(2);
		expect(results.openQuestions).toEqual([{ askerName: 'Quin', question: 'Why C?', askedAt: PAST, agentAnswered: false }]);
		expect(results.concerns).toEqual([{ name: pat.participant.name, comment: 'I worry about C.', createdAt: '2026-11-03 09:00:00', via: 'session' }]);
		expect(results.ruling).toEqual({
			optionId: c.id,
			label: 'C',
			title: 'Plan C',
			reason: 'C, for the long run.',
			conditions: null,
			early: true,
			closedEarly: false,
			againstResponses: true,
			cutOff: [ria.participant.name],
			cutOffReached: [false],
			supersededOld: null,
			byName: decider.username,
			at: expect.any(String)
		});
		expect(results.releasePreview?.comments).toEqual([
			{ text: 'B after all.', key: expect.stringMatching(/^[0-9a-f]{64}$/) },
			{ text: 'Not my area.', key: expect.stringMatching(/^[0-9a-f]{64}$/) }
		]);
		expect(results).toMatchObject({ round: 2, mayRule: false, released: null, mostChosen: [b.id], revision: resultsRevisionFor(decision.id) });
		expect(results.mayRelease).toBe(false);
		expect(results.releaseRefusal).toBe(TOO_FEW_TO_RELEASE);
		await settled(decision.id);
	});

	it('refuses an author who is not the decider (22)', () => {
		const author = makeUser({ username: 'author' });
		addBoardMember(board, author, 'editor');
		const { decision } = opened();
		db.update(decisions).set({ authorUserId: author.id }).where(eq(decisions.id, decision.id)).run();

		expect(outcome(() => readResults(author, decision.id, { source: 'ui' }))).toEqual({ status: 403, message: 'You cannot read the results of this decision' });
	});

	it('takes a participant’s latest row in a round past a concern and a kind it does not count, and counts one changed twice once (23)', () => {
		const { decision, a, b, decider } = opened();
		const pat = withAccount(decision, 'pat');
		answer(pat.participant, { optionId: a.id });
		answer(pat.participant, { optionId: b.id });
		const last = answer(pat.participant, { kind: 'abstain', optionId: null });
		makeResponse(pat.participant, { kind: 'concern', comment: 'A concern.' });
		makeResponse(pat.participant, { kind: 'not_a_kind', comment: 'A kind not yet counted.' });

		const results = readResults(decider, decision.id, { source: 'ui' });

		expect(results.current.rows.map((row) => [row.kind, row.changes])).toEqual([['abstain', 2]]);
		expect(results.current).toMatchObject({ responded: 1, voted: 0, abstained: 1 });
		expect(latestResponse(pat.participant.id, 1)?.id).toBe(last.id);
	});
});

// ─── Supersede (cases 31 and 32) ─────────────────────────────────────────────

describe('supersedeDecision', () => {
	it('makes a draft on the same board from the version ruled on, its decider the old decider while they can edit the board, else the caller (31)', () => {
		const old = opened({ title: 'The old one', voteMode: 'score' });
		sqlite.prepare('DELETE FROM decision_versions WHERE decision_id = ?').run(old.decision.id);
		makeVersion(
			old.decision,
			{
				situation: 'Money is short.',
				question: 'Which plan?',
				ask: 'Score each.',
				options: [old.a, old.b].map((o) => ({ optionId: o.id, label: o.label, title: `Plan ${o.label}`, summary: 'S', pros: ['P'], cons: ['C'], commercial: '' })),
				audiences: [{ groupId: null, heading: 'Everyone', body: 'All of us.' }],
				stories: [{ title: 'As a buyer', body: 'I pay less.' }],
				agentDrafted: { situation: true, [`options.${old.b.id}`]: true },
				reviewed: { question: { byName: 'Rae Viewer', at: PAST } }
			},
			{ number: 1 }
		);
		makeRuling(old.decision);
		db.update(decisions).set({ ruledAt: PAST }).where(eq(decisions.id, old.decision.id)).run();
		const activity = count('activity_log');

		// (a) The old decider supersedes, and is the decider of the draft.
		const draft = supersede(old.decider, decisionRow(old.decision.id), { title: 'Again' });

		expect(draft, '(a)').toMatchObject({
			boardId: board.id,
			boardName: 'The board',
			title: 'Again',
			status: 'draft',
			voteMode: 'score',
			closesAt: null,
			supersedesId: old.decision.id,
			authorUserId: old.decider.id,
			deciderUserId: old.decider.id,
			currentVersion: 0
		});
		const options = db.select().from(decisionOptions).where(eq(decisionOptions.decisionId, draft.id)).all();
		expect(options.map((o) => [o.label, o.position, o.addedInVersion])).toEqual([
			['A', 0, null],
			['B', 1, null]
		]);
		expect(options.map((o) => o.id)).not.toContain(old.a.id);
		expect(JSON.parse(draft.workingContent)).toEqual({
			situation: 'Money is short.',
			question: 'Which plan?',
			ask: 'Score each.',
			options: options.map((o) => ({ optionId: o.id, title: `Plan ${o.label}`, summary: 'S', pros: ['P'], cons: ['C'], commercial: '' })),
			audiences: [{ groupId: null, heading: 'Everyone', body: 'All of us.' }],
			stories: [{ title: 'As a buyer', body: 'I pay less.' }],
			unknowns: '',
			alreadyRuled: '',
			technicalDetail: '',
			surveyQuestions: [],
			agentDrafted: { situation: true, [`options.${options[1].id}`]: true },
			reviewed: {},
			lastLabel: null
		});
		expect(participantsOf(draft.id)).toEqual([]);
		expect(eventsOf(draft.id).map((event) => [event.kind, event.detail])).toEqual([['created', { decider: 'previous_decider', supersedes: old.decision.id }]]);
		expect(count('activity_log')).toBe(activity);
		expect(liveEvents()).toEqual([]);

		// (b) The old decider has lost board edit: the board's Product Owner when it was ruled (S1) supersedes, and decides.
		const older = opened({ title: 'Older' });
		const productOwner = makeUser({ username: 'po' });
		addBoardMember(board, productOwner, 'editor');
		db.update(boards).set({ productOwnerUserId: productOwner.id }).where(eq(boards.id, board.id)).run();
		makeRuling(older.decision);
		sqlite.prepare("UPDATE board_members SET role = 'viewer' WHERE board_id = ? AND user_id = ?").run(board.id, older.decider.id);

		const second = supersede(productOwner, decisionRow(older.decision.id));

		expect(second, '(b)').toMatchObject({ title: 'Older', authorUserId: productOwner.id, deciderUserId: productOwner.id, supersedesId: older.decision.id });
		expect(eventsOf(second.id).map((event) => event.detail), '(b)').toEqual([{ decider: 'author', supersedes: older.decision.id }]);
	});

	it('T26 (card 2683, R9): copies the survey questions of the version ruled on as new rows in order, their ids mapped and their flags renamed', () => {
		const old = opened({ title: 'Asked first' });
		const [where, depot] = [0, 1].map((position) =>
			db.insert(decisionSurveyQuestions).values({ decisionId: old.decision.id, position, addedInVersion: 1 }).returning().get()
		);
		const asked = [
			{ questionId: where.id, kind: 'text', prompt: 'Where from?', help: 'Your site.', required: true },
			{ questionId: depot.id, kind: 'choice', prompt: 'Which depot?', help: '', required: false, choices: ['Leeds', 'York'] }
		];
		sqlite.prepare('DELETE FROM decision_versions WHERE decision_id = ?').run(old.decision.id);
		makeVersion(old.decision, { question: 'Which plan?', surveyQuestions: asked, agentDrafted: { [`survey.${depot.id}`]: true } }, { number: 1 });
		makeRuling(old.decision);

		const draft = supersede(old.decider, decisionRow(old.decision.id));

		const rows = db.select().from(decisionSurveyQuestions).where(eq(decisionSurveyQuestions.decisionId, draft.id)).orderBy(decisionSurveyQuestions.id).all();
		expect(rows.map((row) => [row.position, row.addedInVersion, row.retiredInVersion])).toEqual([
			[0, null, null],
			[1, null, null]
		]);
		expect(rows.map((row) => row.id)).not.toContain(where.id);
		expect(rows.map((row) => row.id)).not.toContain(depot.id);
		const working = JSON.parse(draft.workingContent);
		expect(working.surveyQuestions).toEqual([
			{ ...asked[0], questionId: rows[0].id },
			{ ...asked[1], questionId: rows[1].id }
		]);
		expect(working.agentDrafted).toEqual({ [`survey.${rows[1].id}`]: true });
		// The old decision's rows are as they were.
		expect(db.select().from(decisionSurveyQuestions).where(eq(decisionSurveyQuestions.decisionId, old.decision.id)).all()).toEqual([where, depot]);
	});

	it('refuses, writing nothing, one row each (32)', () => {
		const ruled = () => {
			const made = opened();
			makeRuling(made.decision);
			return { ...made, decision: decisionRow(made.decision.id) };
		};
		const refused = (user: SessionUser, decision: Decision) => {
			const before = written();
			const answered = outcome(() => supersede(user, decision));
			expect(written()).toEqual(before);
			return answered;
		};

		const closed = opened();
		expect(refused(closed.decider, closed.decision), 'not ruled').toEqual({ status: 409, message: 'This decision is awaiting a ruling: it cannot be superseded' });

		const boardless = opened({ board: null, decider: makeUser({ username: 'nob' }) });
		makeRuling(boardless.decision);
		expect(refused(boardless.decider, decisionRow(boardless.decision.id)), 'the board gone').toEqual({
			status: 409,
			message: "This decision's board has been deleted: a decision superseding it could never be opened"
		});

		const taken = ruled();
		makeDecision({ board, author: taken.decider, decider: taken.decider, status: 'withdrawn', supersedesId: taken.decision.id });
		expect(outcome(() => supersede(taken.decider, taken.decision)), 'a withdrawn one does not block').toBe('passed');
		expect(refused(taken.decider, taken.decision), 'one not withdrawn').toEqual({ status: 409, message: 'A later decision that supersedes this one already exists' });

		const editor = makeUser({ username: 'ed' });
		addBoardMember(board, editor, 'editor');
		const reader = makeUser({ username: 'rd' });
		addBoardMember(board, reader, 'viewer');
		const target = ruled();
		expect(refused(editor, target.decision), 'a board editor').toEqual({ status: 403, message: 'You cannot supersede this decision' });
		expect(refused(reader, target.decision), 'a board reader').toEqual({ status: 403, message: 'You cannot supersede this decision' });
		expect(refused(makeUser(), target.decision), 'a non-viewer').toEqual({ status: 404, message: 'Decision not found' });
	});

	it('keeps the decider a superseding decision was made with: naming another is 409 as a draft and once open, so the one it would name cannot rule (S1)', async () => {
		const FIXED = /^This decision supersedes a ruled one: its decider was set when it was made and cannot be changed/;
		const old = opened({ title: 'The old one' });
		makeRuling(old.decision);
		const swapIn = makeUser({ username: 'swapin' });
		addBoardMember(board, swapIn, 'editor');
		const swap = (user: SessionUser, decision: Decision) =>
			outcome(() => as(user, (caller) => setDecider(caller, { decisionId: decision.id }, { deciderUserId: swapIn.id, revision: 'any' }, UI)));

		// As a draft: its author, and the board's owner, are refused alike, writing nothing.
		const draft = supersede(old.decider, decisionRow(old.decision.id));
		const before = written();
		expect(swap(old.decider, draft), 'the draft, its author').toEqual({ status: 409, message: expect.stringMatching(FIXED) });
		expect(swap(owner, draft), 'the draft, the board owner').toEqual({ status: 409, message: expect.stringMatching(FIXED) });
		expect(written()).toEqual(before);
		expect(decisionRow(draft.id).deciderUserId).toBe(old.decider.id);

		// Once closed and awaiting a ruling: still refused, and the account it would have named cannot rule.
		db.update(decisions).set({ status: 'withdrawn' }).where(eq(decisions.id, draft.id)).run();
		const next = opened({ title: 'The new one', supersedesId: old.decision.id, decider: old.decider });
		expect(swap(old.decider, next.decision), 'closed').toEqual({ status: 409, message: expect.stringMatching(FIXED) });
		expect(outcome(() => rule(swapIn, next.decision, { optionId: next.a.id, reason: 'Mine.' })), 'the one it would name').toEqual({
			status: 403,
			message: 'You cannot rule on this decision'
		});
		expect(decisionRow(old.decision.id).status).toBe('ruled');
		await sent.settle();
	});
});

// ─── What the pages read (cases 33 to 36, slice 1b) ──────────────────────────

describe('[1b] the participant page, the editor and the board’s list', () => {
	it('links a ruled decision and the one superseding it, only once that one is ruled, and names each only to a viewer of it (33)', async () => {
		const reader = boardReader();
		const old = opened({ title: 'The old one' });
		const oldsOwn = withAccount(old.decision, 'oldp');
		withLink(old.decision, 'token-old');
		makeRuling(old.decision, { ruledAt: stamp() });
		const next = opened({ title: 'The new one', status: 'open', closesAt: FUTURE, supersedesId: old.decision.id, decider: old.decider });
		const nextsOwn = withAccount(next.decision, 'newp');

		// While the superseding decision is open, neither page says anything of the other.
		expect(readDecisionPage(reader, old.decision.id).laterDecision, 'open: the old page').toBeNull();
		expect(readDecisionPage(reader, next.decision.id).supersedes, 'open: the new page').toBeNull();

		rule(old.decider, decisionRow(next.decision.id), { optionId: next.a.id, reason: 'Changed.' });
		// Made after the ruling, whose mail replaces every link it finds.
		withLink(next.decision, 'token-new');

		expect(readDecisionPage(reader, old.decision.id).laterDecision, 'a viewer of the new one').toEqual({ superseded: true, id: next.decision.id, title: 'The new one' });
		expect(readDecisionPage(oldsOwn.account, old.decision.id).laterDecision, 'a participant who cannot view it').toEqual({ superseded: true });
		expect(readLinkPage('token-old', null)?.laterDecision, 'a link holder').toEqual({ superseded: true });
		expect(readDecisionPage(reader, next.decision.id).supersedes, 'the new page, to a viewer of the old').toEqual({ id: old.decision.id, title: 'The old one' });
		expect(readDecisionPage(nextsOwn.account, next.decision.id).supersedes, 'the new page, to one who cannot view it').toEqual({});
		expect(readLinkPage('token-new', null)?.supersedes, 'the new page, by a link').toEqual({});

		// Ruled on by someone who may not supersede the old one (case 8 (b)).
		const older = opened({ title: 'Older' });
		makeRuling(older.decision, { ruledAt: stamp() });
		const beside = opened({ title: 'Beside it', supersedesId: older.decision.id });
		rule(beside.decider, beside.decision, { optionId: beside.a.id, reason: 'Ruled.' });
		expect(readDecisionPage(reader, older.decision.id).laterDecision, 'ruled without superseding').toEqual({ superseded: false, id: beside.decision.id, title: 'Beside it' });
		await sent.settle();
	});

	it('gives a ruled decision’s participant the ruling stage and the ruling with no moment, a board reader the ruling and no stage, and nobody the closing time (34)', async () => {
		const { decision, b, decider } = opened({ status: 'open', closesAt: FUTURE });
		const pat = withAccount(decision, 'pat');
		const reader = boardReader();
		rule(decider, decision, { optionId: b.id, reason: 'B, on balance.', conditions: 'Reviewed in March.' });
		// Made after the ruling, whose mail replaces every link it finds.
		withLink(decision, 'token-ruled', 'consulted');
		const ruledAt = decisionRow(decision.id).ruledAt!;
		const ruling = { label: 'B', title: 'Plan B', noneOfThese: false, reason: 'B, on balance.', conditions: 'Reviewed in March.', ruledByName: decider.username };

		const signedIn = readDecisionPage(pat.account, decision.id);
		const byLink = readLinkPage('token-ruled', null)!;
		const asReader = readDecisionPage(reader, decision.id);

		for (const [who, page] of [['signed in', signedIn], ['by link', byLink]] as const) {
			expect([page.stage, page.ruling, page.decision.closesAt, page.released], who).toEqual(['ruling', ruling, null, null]);
		}
		expect([asReader.stage, asReader.ruling, asReader.decision.closesAt, asReader.released], 'a board reader').toEqual([null, ruling, null, null]);
		for (const page of [signedIn, byLink, asReader]) {
			const text = JSON.stringify(page);
			expect(text).not.toContain(ruledAt);
			expect(text).not.toContain(FUTURE);
			for (const key of ['"early"', '"againstResponses"', '"ruledAt"', '"at"']) expect(text).not.toContain(key);
		}
		await settled(decision.id);
	});

	it('says who may raise a concern, read the results and supersede (35)', () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		withLink(decision, 'token-flags', 'consulted');
		makeRuling(decision, { ruledAt: stamp() });
		const reader = boardReader();
		const admin = makeUser({ role: 'admin' });
		const editor = makeUser({ username: 'ed' });
		addBoardMember(board, editor, 'editor');
		db.update(decisions).set({ authorUserId: editor.id }).where(eq(decisions.id, decision.id)).run();

		expect(readDecisionPage(pat.account, decision.id).mayRaiseConcern, 'a reached participant').toBe(true);
		expect(readLinkPage('token-flags', null)?.mayRaiseConcern, 'a link holder').toBe(true);
		expect(readDecisionPage(reader, decision.id).mayRaiseConcern, 'a board reader').toBe(false);
		expect(
			[decider, admin, reader, editor].map((user) => [readDecisionPage(user, decision.id).mayReadResults, readDecisionPage(user, decision.id).maySupersede]),
			'the decider, an administrator, a reader, the author'
		).toEqual([
			[true, true],
			[true, true],
			[false, false],
			[false, false]
		]);

		// Past the window, the participant may raise none.
		db.update(decisions).set({ ruledAt: stamp(new Date(Date.now() - 91 * 24 * 60 * 60 * 1000)) }).where(eq(decisions.id, decision.id)).run();
		expect(readDecisionPage(pat.account, decision.id).mayRaiseConcern, 'past 90 days').toBe(false);
		db.update(decisions).set({ ruledAt: stamp() }).where(eq(decisions.id, decision.id)).run();

		// Once superseded, nobody may raise one or supersede it again.
		supersede(decider, decisionRow(decision.id));
		expect(readDecisionPage(decider, decision.id).maySupersede, 'a superseding draft exists').toBe(false);
		db.update(decisions).set({ status: 'superseded' }).where(eq(decisions.id, decision.id)).run();
		expect(readDecisionPage(pat.account, decision.id).mayRaiseConcern, 'superseded').toBe(false);
	});

	it('gives an author and a board owner no early, against, cut-off, ruling moment or closing time, in each read and in what the loads give (36)', async () => {
		const author = makeUser({ username: 'author' });
		addBoardMember(board, author, 'editor');
		const closesAt = stamp(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
		const { decision, a, b, decider } = opened({ status: 'open', closesAt });
		db.update(decisions).set({ authorUserId: author.id, authorName: author.username }).where(eq(decisions.id, decision.id)).run();
		const voter = withAccount(decision, 'voter');
		const silent = withAccount(decision, 'silentone');
		answer(voter.participant, { optionId: a.id });
		rule(decider, decisionRow(decision.id), { optionId: b.id, reason: 'B anyway.' });
		expect(rulingOf(decision.id)).toMatchObject({ early: true, againstResponses: true });
		const ruled = decisionRow(decision.id);

		for (const [who, user] of [['the author', author], ['the board owner', owner]] as const) {
			const page = JSON.stringify(readDecisionPage(user, decision.id));
			const loaded = await pageLoad(`/decisions/${decision.id}`, { user });
			expect(loaded.type, who).toBe('data');
			for (const text of [page, JSON.stringify((loaded as { data: unknown }).data)]) {
				for (const absent of ['"early"', '"againstResponses"', '"ruledAt"', '"cutOff"', '"cutOffReached"', '"reached"', silent.participant.name, ruled.ruledAt!, closesAt]) {
					expect(text, `${who}: ${absent}`).not.toContain(absent);
				}
			}
			const edit = readEditPage(user, decision.id);
			expect(edit.decision.closesAt, who).toBeNull();
			const editLoaded = await pageLoad(`/decisions/${decision.id}/edit`, { user });
			expect(editLoaded.type, who).toBe('data');
			for (const text of [JSON.stringify(edit), JSON.stringify((editLoaded as { data: unknown }).data)]) {
				for (const absent of ['"early"', '"againstResponses"', '"ruledAt"', '"cutOff"', '"cutOffReached"', '"reached"', 'cut_off', closesAt]) {
					expect(text, `${who}, editor: ${absent}`).not.toContain(absent);
				}
			}
			expect(readBoardDecisions(user, board.id).decisions.find((row) => row.id === decision.id)?.closesAt, `${who}, the board's list`).toBeNull();
		}
		expect(decisionAnswer(ruled, false).closesAt).toBeNull();
		expect(decisionAnswer(ruled, true).closesAt).toBe(closesAt);
		await settled(decision.id);
	});
});

// ─── Concerns (cases 24 to 30, slice 1c) ─────────────────────────────────────

/** A decision on the board, ruled just now on none of these by its decider (`makeRuling`), with no participant yet. */
function ruledOne(opts: Parameters<typeof opened>[0] = {}) {
	const made = opened(opts);
	makeRuling(made.decision, { ruledAt: stamp() });
	return { ...made, decision: decisionRow(made.decision.id) };
}

const concern = (user: SessionUser | null, decision: Decision, body: Record<string, unknown> = { comment: 'I have a concern.' }, opts: ServiceOptions = UI) =>
	as(user, (caller) => raiseConcern(caller, { decisionId: decision.id }, body, opts));
const concernByLink = (token: string, body: Record<string, unknown> = { comment: 'I have a concern.' }, user: SessionUser | null = null, opts: ServiceOptions = UI) =>
	as(user, (caller) => raiseConcernByLink(caller, { token }, body, opts));

/** Move a participant's concerns, and the events about them, `minutes` back: a test's own change to the record, past the rest or the day. */
function ageConcerns(participantId: number, minutes: number) {
	const back = `-${minutes} minutes`;
	sqlite.prepare("UPDATE decision_responses SET created_at = datetime(created_at, ?) WHERE participant_id = ? AND kind = 'concern'").run(back, participantId);
	sqlite.prepare("UPDATE decision_events SET created_at = datetime(created_at, ?) WHERE participant_id = ? AND kind = 'concern_raised'").run(back, participantId);
}
/** The notice each concern of the decision was recorded with, in order, by participant. */
const notices = (decisionId: number) =>
	eventsOf(decisionId)
		.filter((event) => event.kind === 'concern_raised')
		.map((event) => [event.participantId, event.detail.notice]);
const responseCount = () => count('decision_responses');
const concernWritten = () => ({ responses: responseCount(), events: count('decision_events'), activity: count('activity_log') });
/** The concern notices mailed, each by its address and its html. */
const noticesMailed = () => sent.emails.filter((mail) => mail.subject.startsWith('A concern about the ruling on'));

describe('raiseConcern and raiseConcernByLink', () => {
	// The first request through the harness starts SvelteKit's server for this file (case 39), as the other gate files warm it.
	beforeAll(async () => {
		await gateRoutes();
	}, 30_000);

	it('records a signed-in concern on the current round and version, its event and the ruling seen once, and tells the decider without a name or the text (24)', async () => {
		const { decision, decider } = ruledOne();
		const pat = withAccount(decision, 'pat');
		const before = eventsOf(decision.id).length;

		const answer = concern(pat.account, decision, { comment: '  The cost is wrong.  ' });

		expect(answer).toEqual({ concern: { comment: 'The cost is wrong.', createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) } });
		expect(JSON.stringify(answer)).not.toMatch(/"(id|responseId|participantId)"/);
		const [row] = concernsOf({ participantId: pat.participant.id });
		expect(row).toMatchObject({
			kind: 'concern',
			round: currentRound(decision.id),
			versionNumber: 1,
			optionId: null,
			scores: null,
			optionComments: null,
			replacesId: null,
			comment: 'The cost is wrong.',
			via: 'session'
		});
		expect(eventsOf(decision.id).slice(before).map((event) => [event.kind, event.participantId, event.versionNumber, event.detail])).toEqual([
			['concern_raised', pat.participant.id, 1, { responseId: row.id, notice: 'asked' }],
			['seen', pat.participant.id, 1, { stage: 'ruling' }]
		]);
		expect(activityRows()).toEqual([]);
		expect(liveEvents()).toEqual([]);

		// A second, past the rest: the ruling is seen once.
		ageConcerns(pat.participant.id, 11);
		concern(pat.account, decision, { comment: 'And another.' });
		expect(eventsOf(decision.id).filter((event) => event.kind === 'seen')).toHaveLength(1);

		await sent.settle();
		const [mail] = noticesMailed();
		expect(mail.to).toBe(decider.email);
		expect(mail.subject).toBe(`A concern about the ruling on ${decision.title}`);
		expect(mail.html).toContain(`${APP}/decisions/${decision.id}/results`);
		for (const absent of ['The cost is wrong.', pat.person.fullName, pat.account.username]) expect(mail.html, absent).not.toContain(absent);
		expect(sent.duringTransaction).toEqual([]);
	});

	it('records a link holder’s concern by the link, noting a signed-in browser’s account beside it (25)', () => {
		const { decision } = ruledOne();
		const linked = withLink(decision, 'token-c25', 'consulted');
		const browser = makeUser({ username: 'browser' });

		concernByLink('token-c25', { comment: 'By link.' }, browser);

		expect(concernsOf({ participantId: linked.participant.id })[0]).toMatchObject({ kind: 'concern', via: 'link', comment: 'By link.' });
		const raised = sqlite
			.prepare("SELECT actor_user_id AS userId, actor_name AS name, source, detail FROM decision_events WHERE decision_id = ? AND kind = 'concern_raised'")
			.get(decision.id) as { userId: number | null; name: string; source: string; detail: string };
		expect({ ...raised, detail: JSON.parse(raised.detail) }).toEqual({
			userId: null,
			name: linked.participant.name,
			source: 'link',
			detail: { responseId: expect.any(Number), notice: 'asked', signedIn: { userId: browser.id, name: browser.username } }
		});
	});

	it('lets a participant kept informed raise a concern (26)', () => {
		const { decision } = ruledOne();
		const ivy = withAccount(decision, 'ivy', 'informed');

		expect(outcome(() => concern(ivy.account, decision))).toBe('passed');
		expect(concernsOf({ participantId: ivy.participant.id })).toHaveLength(1);
	});

	it('refuses, writing nothing, one row each (27)', () => {
		const { decision } = ruledOne();
		const pat = withAccount(decision, 'pat');
		const reader = boardReader();
		const gone = withAccount(decision, 'gone');
		db.update(people).set({ status: 'left', leftAt: PAST }).where(eq(people.id, gone.person.id)).run();
		const open = opened({ status: 'open', closesAt: FUTURE });
		const openOne = withAccount(open.decision, 'early');
		const superseded = ruledOne();
		const late = withAccount(superseded.decision, 'late');
		db.update(decisions).set({ status: 'superseded' }).where(eq(decisions.id, superseded.decision.id)).run();
		const past = opened();
		const longAgo = stamp(new Date(Date.now() - 91 * 24 * 60 * 60 * 1000));
		makeRuling(past.decision, { ruledAt: longAgo });
		const tardy = withAccount(past.decision, 'tardy');
		withLink(past.decision, 'token-c27-past', 'consulted');
		const full = withAccount(decision, 'full');
		for (let n = 0; n < 5; n++) makeResponse(full.participant, { kind: 'concern', comment: `Concern ${n}`, createdAt: '2026-11-02 10:00:00' });
		const supersededLong = opened();
		makeRuling(supersededLong.decision, { ruledAt: longAgo });
		const lateAndPast = withAccount(supersededLong.decision, 'lap');
		db.update(decisions).set({ status: 'superseded' }).where(eq(decisions.id, supersededLong.decision.id)).run();

		const rows: [string, () => unknown, number, string | RegExp][] = [
			["(a) source: 'api'", () => concern(pat.account, decision, undefined, API), 403, "Raising a concern is a person's act: it cannot be done with an API key"],
			['(b) a board reader who is no participant', () => concern(reader, decision), 403, 'You cannot raise a concern on this decision'],
			['(c) a participant no longer reached', () => concern(gone.account, decision), 403, 'This decision no longer reaches you as a participant: ask whoever sent it to you'],
			['(d) open', () => concern(openOne.account, decisionRow(open.decision.id)), 409, /a concern cannot be raised on it$/],
			['(e) superseded', () => concern(late.account, decisionRow(superseded.decision.id)), 409, CONCERN_SUPERSEDED],
			['(f) signed in, past 90 days', () => concern(tardy.account, decisionRow(past.decision.id)), 409, CONCERN_WINDOW_ENDED],
			['(g) by link, past 90 days', () => concernByLink('token-c27-past'), 404, DEAD_DECISION_LINK],
			['(h) an empty comment', () => concern(pat.account, decision, { comment: '   ' }), 400, 'comment is required'],
			['(i) a sixth concern', () => concern(full.account, decision), 409, 'You have raised 5 concerns about this ruling: no more can be raised'],
			// Code review F5: two faults at once, the earlier refusal answered.
			['(j) 403 before 400: an API key with an empty comment', () => concern(pat.account, decision, { comment: '' }, API), 403, "Raising a concern is a person's act: it cannot be done with an API key"],
			['(k) 400 before 409: an empty comment while open', () => concern(openOne.account, decisionRow(open.decision.id), { comment: ' ' }), 400, 'comment is required'],
			['(l) superseded before the window: superseded, past 90 days', () => concern(lateAndPast.account, decisionRow(supersededLong.decision.id)), 409, CONCERN_SUPERSEDED]
		];
		for (const [name, run, status, message] of rows) {
			const before = concernWritten();
			const got = outcome(run);
			expect(got, name).toEqual({ status, message: typeof message === 'string' ? message : expect.stringMatching(message) });
			expect(concernWritten(), name).toEqual(before);
		}
	});

	it('refuses a second concern within 10 minutes 429, saying from when, in UTC (28)', () => {
		const { decision } = ruledOne();
		const pat = withAccount(decision, 'pat');
		concern(pat.account, decision);
		const first = concernsOf({ participantId: pat.participant.id })[0];
		const before = concernWritten();

		const refused = outcome(() => concern(pat.account, decision, { comment: 'Again.' }));

		const from = stamp(new Date(parseStamp(first.createdAt)!.getTime() + 10 * 60 * 1000));
		expect(refused).toEqual({ status: 429, message: `Your last concern was raised less than 10 minutes ago: the next can be raised from ${from} UTC` });
		expect(concernWritten()).toEqual(before);
	});

	it('notices the decider once a day per participant, a participant’s first always, and records why not otherwise, one row each (29)', async () => {
		const { decision, decider } = ruledOne();
		const pat = withAccount(decision, 'pat');
		const quin = withAccount(decision, 'quin');

		// (a) quin's first notifies, though pat's was noticed a minute before.
		concern(pat.account, decision);
		ageConcerns(pat.participant.id, 1);
		concern(quin.account, decision);
		expect(notices(decision.id), '(a)').toEqual([
			[pat.participant.id, 'asked'],
			[quin.participant.id, 'asked']
		]);
		await sent.settle();
		expect(noticesMailed(), '(a)').toHaveLength(2);

		// (b) pat's next, within the day: held, and no mail.
		ageConcerns(pat.participant.id, 11);
		concern(pat.account, decision, { comment: 'Held.' });
		expect(notices(decision.id).at(-1), '(b)').toEqual([pat.participant.id, 'held']);
		await sent.settle();
		expect(noticesMailed(), '(b)').toHaveLength(2);

		// (c) a day on: noticed, saying one more was held.
		ageConcerns(pat.participant.id, 25 * 60);
		concern(pat.account, decision, { comment: 'A day on.' });
		expect(notices(decision.id).at(-1), '(c)').toEqual([pat.participant.id, 'asked']);
		await sent.settle();
		expect(noticesMailed(), '(c)').toHaveLength(3);
		expect(noticesMailed().at(-1)!.html, '(c)').toContain('They raised 1 more since the last notice about them, which was not mailed.');
		expect(noticesMailed()[0].html, '(c), the first').not.toContain('more since the last notice');

		// (d) with no decider account.
		const nobody = ruledOne();
		const ria = withAccount(nobody.decision, 'ria');
		db.update(decisions).set({ deciderUserId: null }).where(eq(decisions.id, nobody.decision.id)).run();
		concern(ria.account, decisionRow(nobody.decision.id));
		expect(notices(nobody.decision.id), '(d)').toEqual([[ria.participant.id, 'no_decider']]);

		// (f) the decider's decision mail switched off: written, no mail, and not counted, so the next one notifies.
		const quiet = ruledOne();
		const sam = withAccount(quiet.decision, 'sam');
		db.update(users).set({ notificationPrefs: JSON.stringify({ email_decisions: false }) }).where(eq(users.id, quiet.decider.id)).run();
		concern(sam.account, quiet.decision);
		expect(notices(quiet.decision.id), '(f)').toEqual([[sam.participant.id, 'prefs_off']]);
		await sent.settle();
		expect(noticesMailed().filter((mail) => mail.to === quiet.decider.email), '(f)').toEqual([]);
		db.update(users).set({ notificationPrefs: null }).where(eq(users.id, quiet.decider.id)).run();
		ageConcerns(sam.participant.id, 11);
		concern(sam.account, quiet.decision, { comment: 'Now on.' });
		expect(notices(quiet.decision.id).at(-1), '(f) next').toEqual([sam.participant.id, 'asked']);
		await sent.settle();
		const samMail = noticesMailed().filter((mail) => mail.to === quiet.decider.email);
		expect(samMail, '(f) next').toHaveLength(1);
		expect(samMail[0].html, '(f) none held').not.toContain('more since the last notice');

		// (g) the link is made on the App URL, whatever opts.baseUrl says.
		const elsewhere = ruledOne();
		const tia = withAccount(elsewhere.decision, 'tia');
		concern(tia.account, elsewhere.decision, undefined, { source: 'ui', baseUrl: 'https://attacker.example.test' });
		await sent.settle();
		const tiaMail = noticesMailed().filter((mail) => mail.to === elsewhere.decider.email);
		expect(tiaMail, '(g)').toHaveLength(1);
		expect(tiaMail[0].html, '(g)').toContain(`${APP}/decisions/${elsewhere.decision.id}/results`);
		expect(tiaMail[0].html, '(g)').not.toContain('attacker.example.test');

		// (h) Code review F2: with no mail host, `no_mail_host`, and not counted, so the next one, once mail is set up, notifies.
		const hostless = ruledOne();
		const una = withAccount(hostless.decision, 'una');
		db.delete(settings).where(eq(settings.key, 'smtp_host')).run();
		concern(una.account, hostless.decision);
		expect(notices(hostless.decision.id), '(h)').toEqual([[una.participant.id, 'no_mail_host']]);
		db.insert(settings).values({ key: 'smtp_host', value: 'smtp.example.test' }).run();
		ageConcerns(una.participant.id, 11);
		concern(una.account, hostless.decision, { comment: 'Mail is back.' });
		expect(notices(hostless.decision.id).at(-1), '(h) next').toEqual([una.participant.id, 'asked']);
		await sent.settle();
		expect(noticesMailed().filter((mail) => mail.to === hostless.decider.email), '(h) next').toHaveLength(1);

		// (e) with no App URL and no ORIGIN.
		db.delete(settings).where(eq(settings.key, 'app_url')).run();
		const unaddressed = ruledOne();
		const uma = withAccount(unaddressed.decision, 'uma');
		concern(uma.account, unaddressed.decision);
		expect(notices(unaddressed.decision.id), '(e)').toEqual([[uma.participant.id, 'no_link_address']]);
		await sent.settle();
		expect(noticesMailed().filter((mail) => mail.to === unaddressed.decider.email), '(e)').toEqual([]);
		expect(
			noticesMailed().every((mail) => [decider.email, quiet.decider.email, elsewhere.decider.email, hostless.decider.email].includes(mail.to)),
			'nobody else'
		).toBe(true);
	});

	it('asks a new decider on the participant’s first concern after a change of decider, though the former was asked within the day (code review C-S-L4)', async () => {
		const { decision, decider } = ruledOne();
		const pat = withAccount(decision, 'pat');
		concern(pat.account, decision);
		await sent.settle();
		expect(noticesMailed().map((mail) => mail.to)).toEqual([decider.email]);
		sent.clear();
		// No write changes the decider of a ruled decision today, so the change is the test's own, as `setDecider` records
		// it: the rule is `deciderNoticeOf`'s, shared with objections and requests to talk, whose decider can change.
		const next = makeUser({ username: 'next' });
		db.update(decisions).set({ deciderUserId: next.id, deciderName: next.username }).where(eq(decisions.id, decision.id)).run();
		appendEvent(
			{ decisionId: decision.id, kind: 'decider_changed', detail: { fromUserId: decider.id, fromName: decider.username, toUserId: next.id, toName: next.username } },
			SYSTEM_ACTOR
		);

		ageConcerns(pat.participant.id, 11);
		concern(pat.account, decisionRow(decision.id), { comment: 'To the new decider.' });
		expect(notices(decision.id)).toEqual([
			[pat.participant.id, 'asked'],
			[pat.participant.id, 'asked']
		]);
		await sent.settle();
		expect(noticesMailed().map((mail) => mail.to)).toEqual([next.email]);
		expect(noticesMailed()[0].html).not.toContain('more since the last notice');
	});

	it('leaves a participant’s own response their last vote after a concern (30)', () => {
		const { decision, a } = opened();
		const pat = withAccount(decision, 'pat');
		answer(pat.participant, { optionId: a.id });
		makeRuling(decision, { ruledAt: stamp() });

		concern(pat.account, decisionRow(decision.id), { comment: 'Not this.' });

		expect(readDecisionPage(pat.account, decision.id).ownResponse).toMatchObject({ kind: 'vote', optionId: a.id });
		expect(readDecisionPage(pat.account, decision.id).concerns).toEqual([{ comment: 'Not this.', createdAt: expect.any(String) }]);
		expect(latestResponse(pat.participant.id, 1)?.kind).toBe('vote');
	});

	it('takes same-origin JSON alone at both routes, before the body, and counts a wrong link by address, one past its window among them, the 21st 429 (39)', async () => {
		const { decision } = ruledOne();
		const pat = withAccount(decision, 'pat');
		withLink(decision, 'token-c39', 'consulted');
		const stale = opened();
		makeRuling(stale.decision, { ruledAt: stamp(new Date(Date.now() - 91 * 24 * 60 * 60 * 1000)) });
		withLink(stale.decision, 'token-c39-past', 'consulted');
		const signedIn = { cookie: `${SESSION_COOKIE_NAME}=${makeSession(pat.account)}` };
		const routes = [
			{ path: `/api/decisions/${decision.id}/concerns`, body: { comment: 'Signed in.' }, session: signedIn },
			{ path: '/api/decision-by-link/concerns', body: { token: 'token-c39', comment: 'By link.' }, session: {} }
		];
		const ORIGIN = 'http://localhost';
		const ACCEPT = { accept: '*/*' };
		const rows: [string, Record<string, string>, number, string][] = [
			['(a) text/plain', { origin: ORIGIN, 'content-type': 'text/plain' }, 415, 'This route takes JSON only'],
			['(b) no Content-Type', { origin: ORIGIN }, 415, 'This route takes JSON only'],
			['(c) Sec-Fetch-Site: cross-site', { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'cross-site' }, 403, 'Cross-site requests are refused']
		];
		// 18 wrong links counted from the caller's address already.
		const address = addressToCount({ getClientAddress: () => '127.0.0.1' });
		for (let n = 0; n < 18; n++) refuseWrongLink(address);
		const before = concernWritten();
		for (const route of routes) {
			for (const [name, headers, status, message] of rows) {
				const res = await gate('POST', route.path, { headers: { ...ACCEPT, ...route.session, ...headers }, body: JSON.stringify(route.body) });
				expect({ status: res.status, body: await res.json() }, `${route.path} ${name}`).toEqual({ status, body: { message } });
			}
		}
		expect(concernWritten(), 'refused before the body').toEqual(before);

		// The 19th and 20th: a wrong link, and one past its window; the one 404 each.
		for (const token of ['token-c39-never', 'token-c39-past']) {
			const res = await gate('POST', '/api/decision-by-link/concerns', { headers: { ...ACCEPT, 'sec-fetch-site': 'same-origin' }, body: { token, comment: 'x' } });
			expect({ status: res.status, body: await res.json() }, token).toEqual({ status: 404, body: { message: DEAD_DECISION_LINK } });
		}
		const limited = await gate('POST', '/api/decision-by-link/concerns', { headers: { ...ACCEPT, 'sec-fetch-site': 'same-origin' }, body: { token: 'token-c39-21', comment: 'x' } });
		const wait = Number(limited.headers.get('retry-after'));
		expect({ status: limited.status, body: await limited.json() }).toEqual({ status: 429, body: { message: tooManyWrongLinks(wait) } });

		// Same origin: each is answered by its handler, and a live link is never refused.
		for (const route of routes) {
			const res = await gate('POST', route.path, { headers: { ...ACCEPT, ...route.session, 'sec-fetch-site': 'same-origin' }, body: route.body });
			expect(res.status, `${route.path}: ${await res.clone().text()}`).toBe(200);
			expect(await res.json()).toEqual({ concern: { comment: route.body.comment, createdAt: expect.any(String) } });
		}
		expect(concernsOf({ decisionId: decision.id })).toHaveLength(2);
		await sent.settle();
	});
});

// ─── The rule and release routes ask for the password (cases 10 and 13, slice 2a)

describe('the rule and release routes', () => {
	const WRONG = 'not the password';
	/** The session's count of wrong current passwords. */
	const countOf = (made: { headers: Record<string, string> }) =>
		db.select({ count: sessions.wrongPasswordCount }).from(sessions).where(eq(sessions.tokenHash, sessionHashOf(made.headers.cookie.slice(`${SESSION_COOKIE_NAME}=`.length)))).get()?.count;
	const unasked = (user: SessionUser, body: Record<string, unknown>) => ({ ...stepUp(user), body });

	it('asks the ruling’s password after every other refusal, then rules with the right one (10)', async () => {
		const { decision, a, decider } = opened();
		const path = `/api/decisions/${decision.id}/rule`;
		const body = { optionId: a.id, reason: 'Plan A.', revision: resultsRevisionFor(decision.id) };
		const before = written();

		const stale = stepUp(decider, { ...body, revision: 'not-the-revision' }, WRONG);
		const staleRes = await api('POST', path, stale);
		expect({ status: staleRes.status, body: staleRes.body }, 'a stale revision').toEqual({ status: 409, body: { message: STALE_REVISION } });
		expect(countOf(stale), 'nothing counted').toBe(0);

		const missing = unasked(decider, body);
		const missingRes = await api('POST', path, missing);
		expect({ status: missingRes.status, body: missingRes.body }, 'no password').toEqual({ status: 400, body: { message: STEP_UP_MISSING, stepUp: 'missing' } });
		expect(countOf(missing)).toBe(0);

		const wrong = stepUp(decider, body, WRONG);
		const wrongRes = await api('POST', path, wrong);
		expect({ status: wrongRes.status, body: wrongRes.body }, 'a wrong one').toEqual({ status: 403, body: { message: STEP_UP_WRONG, stepUp: 'wrong' } });
		expect(countOf(wrong)).toBe(1);
		expect(written()).toEqual(before);

		const right = await api('POST', path, stepUp(decider, body));
		expect(right.status, JSON.stringify(right.body)).toBe(200);
		expect(right.body).toEqual({ decision: decisionAnswer(decisionRow(decision.id), false), revision: resultsRevisionFor(decision.id) });
		expect(decisionRow(decision.id).status).toBe('ruled');
		await settled(decision.id);
	});

	it('asks the release’s password after its refusals, refusing a wrong one and releasing with the right one (13)', async () => {
		const { decision, decider } = releasable();
		const path = `/api/decisions/${decision.id}/release`;
		const body = { revision: resultsRevisionFor(decision.id) };
		const before = written();

		const wrong = stepUp(decider, body, WRONG);
		const wrongRes = await api('POST', path, wrong);
		expect({ status: wrongRes.status, body: wrongRes.body }).toEqual({ status: 403, body: { message: STEP_UP_WRONG, stepUp: 'wrong' } });
		expect(countOf(wrong)).toBe(1);
		expect(written()).toEqual(before);
		expect(decisionRow(decision.id).resultsReleasedAt).toBeNull();

		const right = await api('POST', path, stepUp(decider, body));
		expect(right.status, JSON.stringify(right.body)).toBe(200);
		expect(right.body).toEqual({ decision: decisionAnswer(decisionRow(decision.id), false), revision: resultsRevisionFor(decision.id) });
		expect(decisionRow(decision.id).resultsReleasedAt).not.toBeNull();
	});
});

// ─── The rules later cards build on (cases 37, 38 and 40) ────────────────────

describe('the decider-only details, the statement version and the API', () => {
	it('names the decider-only events, and keeps the record and the results the decider’s and administrators’ (37)', () => {
		// Card 2678 (decision 2): the four question events too; and card 2684's four flag events (R16).
		expect(DECIDER_ONLY_EVENTS).toEqual([
			'ruled',
			'cut_off',
			'concern_raised',
			'question_asked',
			'question_answered',
			'answer_published',
			'answer_replaced',
			'objection_raised',
			'talk_requested',
			'objection_answered',
			'talk_outcome',
			// Card 2688 (R5): a full record taken as a PDF.
			'record_exported'
		]);
		expect(DECISION_RULES.record).toEqual(['admin', 'decider']);
		expect(DECISION_RULES.results).toEqual(['admin', 'decider']);
	});

	it('records the who-sees statement a response was given under, refuses another, and brings an old answer under it once (38)', () => {
		const { decision, a } = opened({ status: 'open', closesAt: FUTURE });
		const pat = withAccount(decision, 'pat');
		const respond = (body: Record<string, unknown>) => as(pat.account, (caller) => respondToDecision(caller, { decisionId: decision.id }, { versionNumber: 1, kind: 'vote', ...body }, UI));
		const responded = () => eventsOf(decision.id).filter((event) => event.kind === 'responded').map((event) => event.detail);

		respond({ optionId: a.id, statement: WHO_SEES_STATEMENT_VERSION });
		expect(responded().at(-1), '(a)').toEqual({ responseId: expect.any(Number), statement: 2 });

		const before = written();
		expect(outcome(() => respond({ optionId: a.id, comment: 'New', statement: 1 })), '(b)').toEqual({ status: 409, message: STALE_REVISION });
		expect(written(), '(b)').toEqual(before);

		const other = withAccount(decision, 'old');
		const sendAs = (body: Record<string, unknown>) => as(other.account, (caller) => respondToDecision(caller, { decisionId: decision.id }, { versionNumber: 1, kind: 'vote', optionId: a.id, ...body }, UI));
		sendAs({});
		expect(responded().at(-1), '(c) none sent, none recorded').toEqual({ responseId: expect.any(Number) });
		expect(sendAs({ statement: 2 }).unchanged, '(c) brought under the statement').toBe(false);
		expect(responded().at(-1), '(c)').toEqual({ responseId: expect.any(Number), statement: 2 });
		const brought = written();
		expect(sendAs({ statement: 2 }).unchanged, '(c) again').toBe(true);
		expect(written(), '(c) again').toEqual(brought);
	});

	it('gives the ruling, the release and the concerns no route of the documented API (40)', () => {
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (statSync(path).isDirectory()) walk(path);
				else if (/\.(ts|js|svelte)$/.test(name)) files.push(path);
			}
		};
		walk(join(process.cwd(), 'src/routes/api/v1'));
		expect(files.length).toBeGreaterThan(20);
		const NAMES = /\b(ruleDecision|releaseResults|raiseConcern|raiseConcernByLink|decisionRuleGuard|resultsReleaseGuard)\b/;
		expect(files.filter((file) => NAMES.test(readFileSync(file, 'utf8')))).toEqual([]);
	});
});

// ─── Survey answers in the results, the ruling and the release (card 2683, slice S2b) ─

/** The survey questions `surveyOn` asks, in order: a choice, a scale and a written answer. */
const SURVEY = [
	{ kind: 'choice', prompt: 'Which depot ships it?', help: '', required: false, choices: ['Leeds', 'York', 'Hull'] },
	{ kind: 'scale', prompt: 'How urgent is it?', help: '', required: false, scale: { max: 5, lowLabel: 'Not at all', highLabel: 'Very' } },
	{ kind: 'text', prompt: 'Anything else?', help: '', required: false }
] as const;

/** `SURVEY` as a version's content holds it, each under the id of its row, `choice`'s choices `choices` where given. */
const surveyContent = (ids: { choice: { id: number }; scale: { id: number }; text: { id: number } }, more: { choices?: string[]; help?: string } = {}) => [
	{ ...SURVEY[0], questionId: ids.choice.id, ...(more.choices === undefined ? {} : { choices: more.choices }), ...(more.help === undefined ? {} : { help: more.help }) },
	{ ...SURVEY[1], questionId: ids.scale.id },
	{ ...SURVEY[2], questionId: ids.text.id }
];

/**
 * Card 2683: `SURVEY`'s questions on the decision's version 1, beside `options` (none: a survey), as `openDecision`
 * leaves them: a row for each, added in version 1, and version 1 made again to hold them.
 */
function surveyOn(decision: Decision, options: { id: number; label: string }[] = []) {
	const [choice, scale, text] = SURVEY.map((_words, position) =>
		db.insert(decisionSurveyQuestions).values({ decisionId: decision.id, position, addedInVersion: 1 }).returning().get()
	);
	sqlite.prepare('DELETE FROM decision_versions WHERE decision_id = ?').run(decision.id);
	makeVersion(
		decision,
		{ question: 'Which plan?', options: options.map((o) => ({ optionId: o.id, label: o.label, title: `Plan ${o.label}` })), surveyQuestions: surveyContent({ choice, scale, text }) },
		{ number: 1 }
	);
	return { choice, scale, text };
}

/** Card 2683: a decision that is a survey, version 1 putting no options and asking `SURVEY`; closed and awaiting a ruling unless told otherwise. */
function surveyed(opts: { status?: string; closesAt?: string } = {}) {
	const decider = makeUser({ username: `decider${++seq}` });
	addBoardMember(board, decider, 'editor');
	const made = makeDecision({ board, author: decider, decider, title: 'Where from?', status: opts.status ?? 'closed', closesAt: opts.closesAt ?? PAST, openedAt: '2026-11-01 09:00:00' });
	makeVersion(made, {}, { number: 1 });
	return { decision: decisionRow(made.id), decider, ...surveyOn(decisionRow(made.id)) };
}

/** An `answered` response of the participant, its answers stored as `appendResponse` stores them, with its `responded` event. */
const answered = (participant: DecisionParticipant, answers: Record<number, number | string>, opts: Parameters<typeof makeResponse>[1] = {}) =>
	answer(participant, { kind: 'answered', optionId: null, answers: JSON.stringify(answers), ...opts });

/** Version `number`'s new options A and B, live from it. */
function optionsFrom(decision: Decision, number: number) {
	const a = makeOption(decision, { label: 'A', position: 0, addedInVersion: number });
	const b = makeOption(decision, { label: 'B', position: 1, addedInVersion: number });
	return { a, b, content: [a, b].map((o) => ({ optionId: o.id, label: o.label, title: `Plan ${o.label}` })) };
}

describe('survey answers in the results, the ruling and the release (card 2683)', () => {
	it("T44. gives the decider a round's survey figures, labelled with the version answered under, and each row's answers", () => {
		const { decision, decider, choice, scale, text } = surveyed();
		const pat = withAccount(decision, 'pat');
		const quin = withAccount(decision, 'quin');
		const ria = withAccount(decision, 'ria');
		answered(pat.participant, { [choice.id]: 0, [scale.id]: 4, [text.id]: 'Leeds ships on Tuesdays.' });
		answered(quin.participant, { [choice.id]: 0, [scale.id]: 2 });
		answer(ria.participant, { kind: 'abstain', optionId: null });

		const results = readResults(decider, decision.id, { source: 'ui' });

		expect(readResults(makeUser({ role: 'admin' }), decision.id, { source: 'ui' }).current, 'an administrator').toEqual(results.current);
		expect(results.surveyQuestions).toEqual(surveyContent({ choice, scale, text }));
		expect(results.current).toMatchObject({ round: 1, responded: 3, voted: 0, votes: [], abstained: 1, noConcerns: 0 });
		expect(results.current.survey).toEqual([
			{
				versionNumber: 1,
				questions: [
					{
						questionId: choice.id,
						kind: 'choice',
						prompt: 'Which depot ships it?',
						answered: 2,
						choices: [
							{ choice: 'Leeds', count: 2 },
							{ choice: 'York', count: 0 },
							{ choice: 'Hull', count: 0 }
						],
						scale: null
					},
					{
						questionId: scale.id,
						kind: 'scale',
						prompt: 'How urgent is it?',
						answered: 2,
						choices: null,
						scale: {
							max: 5,
							lowLabel: 'Not at all',
							highLabel: 'Very',
							counts: [1, 2, 3, 4, 5].map((value) => ({ value, count: value === 2 || value === 4 ? 1 : 0 })),
							mean: 3
						}
					},
					{ questionId: text.id, kind: 'text', prompt: 'Anything else?', answered: 1, choices: null, scale: null }
				]
			}
		]);
		expect(results.current.rows.map((row) => [row.name, row.kind, row.versionNumber, row.answers])).toEqual([
			[pat.participant.name, 'answered', 1, { [choice.id]: 0, [scale.id]: 4, [text.id]: 'Leeds ships on Tuesdays.' }],
			[quin.participant.name, 'answered', 1, { [choice.id]: 0, [scale.id]: 2 }],
			[ria.participant.name, 'abstain', 1, {}]
		]);
	});

	it('T45. keeps the survey round apart, as an earlier round, once the decision is asked again with options', () => {
		const { decision, decider, choice, scale, text } = surveyed({ status: 'open', closesAt: FUTURE });
		const pat = withAccount(decision, 'pat');
		const quin = withAccount(decision, 'quin');
		answered(pat.participant, { [choice.id]: 1 }, { comment: 'From York.' });
		answered(quin.participant, { [choice.id]: 2 });
		// Version 2 asks again with options A and B, keeping the questions: the decision is now a vote.
		const { a, b, content } = optionsFrom(decision, 2);
		makeVersion(decision, { options: content, surveyQuestions: surveyContent({ choice, scale, text }) }, { number: 2, asksAgain: true });
		answer(pat.participant, { optionId: a.id, round: 2, versionNumber: 2 });

		const results = readResults(decider, decision.id, { source: 'ui' });

		expect(results.round).toBe(2);
		expect(results.options.map((option) => option.label)).toEqual(['A', 'B']);
		expect(results.current).toMatchObject({ round: 2, responded: 1, voted: 1, votes: [{ optionId: a.id, count: 1 }, { optionId: b.id, count: 0 }] });
		expect(results.current.rows.map((row) => [row.kind, row.answers])).toEqual([['vote', {}]]);
		expect(results.notResponded.map((row) => row.name)).toEqual([quin.participant.name]);
		expect(results.earlierRounds).toHaveLength(1);
		const [survey] = results.earlierRounds;
		expect(survey).toMatchObject({ round: 1, responded: 2, voted: 0, votes: [] });
		expect(survey.rows.map((row) => [row.kind, row.comment, row.answers])).toEqual([
			['answered', 'From York.', { [choice.id]: 1 }],
			['answered', null, { [choice.id]: 2 }]
		]);
		expect(survey.survey.map((tally) => [tally.versionNumber, tally.questions[0].choices])).toEqual([
			[
				1,
				[
					{ choice: 'Leeds', count: 0 },
					{ choice: 'York', count: 1 },
					{ choice: 'Hull', count: 1 }
				]
			]
		]);
	});

	it('T46. rules a survey on no option: ruled, not against the responses, and the mail, the results and the page say no options were put to a vote', async () => {
		const { decision, decider, choice } = surveyed();
		const pat = withAccount(decision, 'pat');
		answered(pat.participant, { [choice.id]: 0 });

		rule(decider, decision, { optionId: null, reason: 'Leeds ships it.' });

		expect(rulingOf(decision.id)).toMatchObject({ optionId: null, againstResponses: false, reason: 'Leeds ships it.' });
		expect(decisionRow(decision.id).status).toBe('ruled');
		await settled(decision.id);
		expect(sent.emails.map((mail) => mail.to)).toEqual([pat.person.email]);
		expect(sent.emails[0].html).toContain('No options were put to a vote');
		expect(sent.emails[0].html).not.toContain('None of these');
		expect(sent.emails[0].html).toContain('Leeds ships it.');
		expect(readResults(decider, decision.id, { source: 'ui' }).ruling).toMatchObject({ optionId: null, againstResponses: false, noOptions: true });
		expect(readDecisionPage(pat.account, decision.id).ruling).toEqual({
			label: null,
			title: null,
			noneOfThese: true,
			reason: 'Leeds ships it.',
			conditions: null,
			ruledByName: decider.username,
			noOptions: true
		});
	});

	it("T47. refuses a release of a survey's ruling in R11's words, writing nothing, and the results page says so", () => {
		const { decision, decider, choice } = surveyed();
		for (const name of ['pat', 'quin', 'ria']) answer(withAccount(decision, name).participant, { kind: 'abstain', optionId: null, comment: `${name} abstains.` });
		answered(withAccount(decision, 'sam').participant, { [choice.id]: 0 });
		makeRuling(decision, { ruledAt: stamp() });
		const before = written();

		expect(outcome(() => release(decider, decisionRow(decision.id)))).toEqual({ status: 409, message: NO_OPTIONS_TO_RELEASE });
		expect(NO_OPTIONS_TO_RELEASE).toBe('This decision put no options to a vote: there are no totals to release, and survey answers are never released');
		expect(written()).toEqual(before);
		expect(decisionRow(decision.id).resultsReleasedAt).toBeNull();
		expect(readResults(decider, decision.id, { source: 'ui' })).toMatchObject({ mayRelease: false, releaseRefusal: NO_OPTIONS_TO_RELEASE, releasePreview: null });
	});

	it('T48. holds no answer, no answer text and no survey figure in a release, or its preview, of a decision with options', () => {
		const r = releasable();
		const { choice, scale, text } = surveyOn(r.decision, [r.a, r.b, r.c]);
		sqlite.prepare('UPDATE decision_responses SET answers = ? WHERE decision_id = ?').run(JSON.stringify({ [choice.id]: 1, [scale.id]: 5, [text.id]: 'A secret depot note.' }), r.decision.id);
		// The results hold the answers, so it is the release that leaves them out.
		expect(readResults(r.decider, r.decision.id, { source: 'ui' }).current.rows.map((row) => row.answers[`${text.id}`])).toEqual(Array(3).fill('A secret depot note.'));

		const preview = previewOf(decisionRow(r.decision.id));
		release(r.decider, r.decision);
		const released = releasedOf(decisionRow(r.decision.id))!;

		for (const [name, shown] of [['preview', preview], ['release', released]] as const) {
			const said = JSON.stringify(shown);
			for (const absent of ['A secret depot note.', 'York', 'Which depot', 'How urgent', 'Not at all', 'survey', 'answers']) expect(said, `${name}: ${absent}`).not.toContain(absent);
			expect(Object.keys(shown).sort(), name).toEqual(['abstained', 'comments', 'noConcerns', 'options', 'responded', 'voteMode', 'voted']);
		}
		expect(released.comments).toEqual(['A, gladly.', 'Either is fine.', 'Plan A is enough.']);
		for (const row of releaseRowsOf(decisionRow(r.decision.id), null)) expect(row).not.toHaveProperty('answers');
	});

	it('T56. tallies and labels answers by the version answered under, never adding a reordered question\'s answers together by position', () => {
		const { decision, decider, choice, scale, text } = surveyed({ status: 'open', closesAt: FUTURE });
		const pat = withAccount(decision, 'pat');
		const quin = withAccount(decision, 'quin');
		const ria = withAccount(decision, 'ria');
		answered(pat.participant, { [choice.id]: 0 });
		// Version 2 asks again with the choices reordered; version 3 tells only, the choice question's help corrected.
		const reordered = ['Hull', 'Leeds', 'York'];
		makeVersion(decision, { surveyQuestions: surveyContent({ choice, scale, text }, { choices: reordered }) }, { number: 2, asksAgain: true });
		answered(quin.participant, { [choice.id]: 0 }, { round: 2, versionNumber: 2 });
		makeVersion(decision, { surveyQuestions: surveyContent({ choice, scale, text }, { choices: reordered, help: 'Where it leaves from.' }) }, { number: 3, asksAgain: false });
		answered(ria.participant, { [choice.id]: 1 }, { round: 2, versionNumber: 3 });

		const results = readResults(decider, decision.id, { source: 'ui' });

		const choicesOf = (tally: RoundTally) => tally.survey.map((group) => [group.versionNumber, group.questions[0].choices]);
		expect(choicesOf(results.earlierRounds[0]), 'round 1').toEqual([
			[
				1,
				[
					{ choice: 'Leeds', count: 1 },
					{ choice: 'York', count: 0 },
					{ choice: 'Hull', count: 0 }
				]
			]
		]);
		expect(choicesOf(results.current), 'round 2').toEqual([
			[
				2,
				[
					{ choice: 'Hull', count: 1 },
					{ choice: 'Leeds', count: 0 },
					{ choice: 'York', count: 0 }
				]
			],
			[
				3,
				[
					{ choice: 'Hull', count: 0 },
					{ choice: 'Leeds', count: 1 },
					{ choice: 'York', count: 0 }
				]
			]
		]);
	});

	it('T63. shows the answers given with a vote on a decision with options in its results row, and counts them', () => {
		const { decision, decider, a, b, c } = opened();
		const { choice, scale } = surveyOn(decision, [a, b, c]);
		const pat = withAccount(decision, 'pat');
		answer(pat.participant, { optionId: a.id, answers: JSON.stringify({ [choice.id]: 2, [scale.id]: 5 }) });

		const results = readResults(decider, decision.id, { source: 'ui' });

		expect(results.current.rows).toEqual([expect.objectContaining({ kind: 'vote', optionId: a.id, answers: { [choice.id]: 2, [scale.id]: 5 } })]);
		expect(results.current.votes).toEqual([
			{ optionId: a.id, count: 1 },
			{ optionId: b.id, count: 0 },
			{ optionId: c.id, count: 0 }
		]);
		expect(results.current.survey.map((group) => [group.versionNumber, group.questions.map((question) => question.answered)])).toEqual([[1, [1, 1, 0]]]);
		expect(results.current.survey[0].questions[1].scale?.mean).toBe(5);
	});

	it('T67. never releases a comment given with a survey answer: not from the survey round once the decision is a vote, nor an answered row in the ruling round', () => {
		const { decision, decider, choice, scale, text } = surveyed();
		const [pat, quin, ria, sam] = ['pat', 'quin', 'ria', 'sam'].map((name) => withAccount(decision, name));
		answered(pat.participant, { [choice.id]: 0 }, { comment: 'Said with a survey answer.' });
		const { a, content } = optionsFrom(decision, 2);
		makeVersion(decision, { options: content, surveyQuestions: surveyContent({ choice, scale, text }) }, { number: 2, asksAgain: true });
		for (const [who, words] of [[pat, 'A for pat.'], [quin, 'A for quin.'], [ria, 'A for ria.']] as const) {
			answer(who.participant, { optionId: a.id, round: 2, versionNumber: 2, comment: words });
		}
		// An answered row in the ruling round, which no write leaves beside options, as an unsealed restore could plant one.
		answered(sam.participant, { [choice.id]: 1 }, { round: 2, versionNumber: 2, comment: 'Planted with an answer.' });
		makeRuling(decision, { optionId: a.id, ruledAt: stamp() });

		const preview = previewOf(decisionRow(decision.id));
		release(decider, decisionRow(decision.id));
		const released = releasedOf(decisionRow(decision.id))!;

		for (const [name, shown] of [['preview', preview], ['release', released]] as const) {
			const said = JSON.stringify(shown);
			for (const absent of ['Said with a survey answer.', 'Planted with an answer.']) expect(said, `${name}: ${absent}`).not.toContain(absent);
		}
		expect(released.comments).toEqual(['A for pat.', 'A for quin.', 'A for ria.']);
		expect(releaseRowsOf(decisionRow(decision.id), null).map((row) => row.kind)).toEqual(['vote', 'vote', 'vote']);
	});

	it('F1. a release reads no survey answer: its refusals, preview, write and released read never read the survey questions, though the votes carry answers', () => {
		const { decision, decider, choice, scale, text } = surveyed();
		const { a, content } = optionsFrom(decision, 2);
		makeVersion(decision, { options: content, surveyQuestions: surveyContent({ choice, scale, text }) }, { number: 2, asksAgain: true });
		for (const name of ['pat', 'quin', 'ria']) {
			answer(withAccount(decision, name).participant, { optionId: a.id, round: 2, versionNumber: 2, comment: `A for ${name}.`, answers: JSON.stringify({ [choice.id]: 1, [text.id]: `Leeds, says ${name}.` }) });
		}
		answered(withAccount(decision, 'sam').participant, { [choice.id]: 2 }, { round: 2, versionNumber: 2, comment: 'Planted with an answer.' });
		makeRuling(decision, { optionId: a.id, ruledAt: stamp() });

		/** The statements `read` prepares that name the survey question table: how an answer is read against its version. */
		const surveyReadsIn = <T>(read: () => T): { value: T; reads: number } => {
			const prepare = vi.spyOn(sqlite, 'prepare');
			try {
				const value = read();
				return { value, reads: prepare.mock.calls.filter(([source]) => String(source).includes('decision_survey_questions')).length };
			} finally {
				prepare.mockRestore();
			}
		};

		// The probe sees the read where answers are read: the decider's results.
		const results = surveyReadsIn(() => readResults(decider, decision.id, UI));
		expect(results.reads).toBeGreaterThan(0);
		expect(results.value.current.rows.map((row) => row.answers[`${choice.id}`])).toEqual([1, 1, 1, 2]);

		expect(surveyReadsIn(() => releaseRefusals(decisionRow(decision.id)))).toEqual({ value: [], reads: 0 });
		const preview = surveyReadsIn(() => previewOf(decisionRow(decision.id)));
		expect(preview.reads).toBe(0);
		expect(JSON.stringify(preview.value)).not.toContain('Leeds, says');
		expect(surveyReadsIn(() => releaseRowsOf(decisionRow(decision.id), null)).reads).toBe(0);
		expect(surveyReadsIn(() => release(decider, decisionRow(decision.id))).reads).toBe(0);
		const released = surveyReadsIn(() => releasedOf(decisionRow(decision.id)));
		expect(released.reads).toBe(0);
		expect(released.value?.comments).toEqual(['A for pat.', 'A for quin.', 'A for ria.']);
	});
});

// ─── Objections and requests to talk at the ruling and in the results (card 2684, S2) ─

describe('objections and requests to talk at the ruling and in the results (card 2684)', () => {
	const ONE_OBJECTION = '1 objection has no answer: answer it before ruling';
	const ONE_TALK = '1 request to talk has no outcome recorded: confirm that you rule with it open';
	const fine = (a: { id: number }) => ({ optionId: a.id, reason: 'A is enough.' });
	const raisedAt = (flagId: number) => (sqlite.prepare('SELECT raised_at AS at FROM decision_flags WHERE id = ?').get(flagId) as { at: string }).at;

	it('T37. refuses the ruling while an objection has no answer, whatever is confirmed, writing nothing, and rules once each is answered', async () => {
		const { decision, a, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const quin = withAccount(decision, 'quin');
		flag(pat.account, decision, { kind: 'objection', reason: 'Too dear.' });
		let before = written();
		expect(outcome(() => rule(decider, decision, fine(a))), 'one').toEqual({ status: 409, message: ONE_OBJECTION });
		expect(written(), 'one').toEqual(before);

		flag(quin.account, decision, { kind: 'objection', reason: 'Too slow.' });
		const [first, second] = flagIdsOf(decision.id);
		before = written();
		expect(outcome(() => rule(decider, decision, { ...fine(a), openQuestionsConfirmed: true, openTalksConfirmed: true })), 'two, everything confirmed').toEqual({
			status: 409,
			message: '2 objections have no answer: answer each before ruling'
		});
		expect(written(), 'two').toEqual(before);

		replyTo(decider, decision, first, 'The budget covers it.');
		expect(outcome(() => rule(decider, decision, fine(a))), 'one answered').toEqual({ status: 409, message: ONE_OBJECTION });
		// An answer need not agree: neither is a veto.
		replyTo(decider, decision, second, 'I hear you, and it stays as it is.');
		expect(outcome(() => rule(decider, decision, fine(a))), 'both answered').toBe('passed');
		expect(decisionRow(decision.id).status).toBe('ruled');
		await settled(decision.id);
	});

	it('T38. refuses the ruling while a removed participant’s objection has no answer', async () => {
		const { decision, a, decider } = opened();
		const gone = withAccount(decision, 'gone');
		flag(gone.account, decision, { kind: 'objection', reason: 'Before I was removed.' });
		db.update(decisionParticipants).set({ removedAt: PAST }).where(eq(decisionParticipants.id, gone.participant.id)).run();

		expect(outcome(() => rule(decider, decision, fine(a)))).toEqual({ status: 409, message: ONE_OBJECTION });
		replyTo(decider, decision, flagIdsOf(decision.id)[0], 'Heard, after your removal.');
		expect(outcome(() => rule(decider, decision, fine(a))), 'answered').toBe('passed');
		await settled(decision.id);
	});

	it('T59. refuses the ruling after a re-publish while an objection raised on version 1 has no answer', async () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		flag(pat.account, decision, { kind: 'objection', reason: 'On version 1.' });
		makeVersion(decision, { situation: 'Money is shorter.' }, { number: 2 });
		const republished = decisionRow(decision.id);
		expect(republished.currentVersion).toBe(2);

		expect(outcome(() => rule(decider, republished, { optionId: null, reason: 'None of these.' }))).toEqual({ status: 409, message: ONE_OBJECTION });
		replyTo(decider, republished, flagIdsOf(decision.id)[0], 'Version 2 answers it.');
		expect(outcome(() => rule(decider, republished, { optionId: null, reason: 'None of these.' })), 'answered').toBe('passed');
		await settled(decision.id);
	});

	it('T39. refuses the ruling while a request to talk has no outcome unless openTalksConfirmed, and rules with it', async () => {
		const { decision, a, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const quin = withAccount(decision, 'quin', 'informed');
		flag(pat.account, decision, { kind: 'talk' });
		flag(quin.account, decision, { kind: 'talk', reason: 'Call me.' });
		const before = written();

		expect(outcome(() => rule(decider, decision, fine(a))), 'two').toEqual({
			status: 409,
			message: '2 requests to talk have no outcome recorded: confirm that you rule with them open'
		});
		replyTo(decider, decision, flagIdsOf(decision.id)[1], 'We spoke.');
		const replied = written();
		expect(replied.events).toBe(before.events + 1);
		expect(outcome(() => rule(decider, decision, fine(a))), 'one').toEqual({ status: 409, message: ONE_TALK });
		// The questions' confirmation is not this one.
		expect(outcome(() => rule(decider, decision, { ...fine(a), openQuestionsConfirmed: true })), 'questions confirmed').toEqual({ status: 409, message: ONE_TALK });
		expect(outcome(() => rule(decider, decision, { ...fine(a), openTalksConfirmed: 'yes' })), 'not a boolean').toEqual({
			status: 400,
			message: 'openTalksConfirmed must be true or false'
		});
		expect(written()).toEqual(replied);
		expect(outcome(() => rule(decider, decision, { ...fine(a), openTalksConfirmed: true })), 'confirmed').toBe('passed');
		expect(decisionRow(decision.id).status).toBe('ruled');
		await settled(decision.id);
	});

	it('T40. lists the refusals in order: stale, objections, questions, requests to talk', () => {
		const { decision, a, decider } = opened();
		flag(withAccount(decision, 'pat').account, decision, { kind: 'objection', reason: 'Too dear.' });
		flag(withAccount(decision, 'quin').account, decision, { kind: 'talk' });
		sqlite
			.prepare("INSERT INTO decision_questions (decision_id, asker_name, question, asked_in_version, via, asked_at) VALUES (?, 'Ria', 'Why A?', 1, 'session', ?)")
			.run(decision.id, PAST);

		expect(rulingRefusals(decisionRow(decision.id), { revision: 'stale', openQuestionsConfirmed: false, openTalksConfirmed: false })).toEqual([
			STALE_REVISION,
			ONE_OBJECTION,
			'1 question is still open: confirm that you rule with it open',
			ONE_TALK
		]);
		// The guard answers the first: with the revision as it is, the objection, whatever is confirmed.
		expect(outcome(() => rule(decider, decision, { ...fine(a), openQuestionsConfirmed: true, openTalksConfirmed: true }))).toEqual({ status: 409, message: ONE_OBJECTION });
	});

	it('T42. gives the decider and an administrator every flag with names and replies, the replier by name alone, and mayReply to the decider alone', () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const lia = withLink(decision, 'token-t42');
		flag(pat.account, decision, { kind: 'objection', reason: 'Too dear.' });
		as(null, (caller) => raiseFlagByLink(caller, { token: 'token-t42' }, { kind: 'talk', reason: 'Call me.' }, UI));
		const [objection, talk] = flagIdsOf(decision.id);
		replyTo(decider, decision, objection, 'The budget covers it.');
		const admin = makeUser({ username: `admin${++seq}`, role: 'admin' });

		const results = readResults(decider, decision.id, { source: 'ui' });

		expect(results.flags).toEqual([
			{
				flagId: objection,
				kind: 'objection',
				name: pat.participant.name,
				reason: 'Too dear.',
				raisedAt: raisedAt(objection),
				via: 'session',
				versionNumber: 1,
				reply: 'The budget covers it.',
				repliedByName: decider.username,
				repliedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
			},
			{
				flagId: talk,
				kind: 'talk',
				name: lia.participant.name,
				reason: 'Call me.',
				raisedAt: raisedAt(talk),
				via: 'link',
				versionNumber: 1,
				reply: null,
				repliedByName: null,
				repliedAt: null
			}
		]);
		expect(results.mayReply).toBe(true);
		const asAdmin = readResults(admin, decision.id, { source: 'ui' });
		expect(asAdmin.flags).toEqual(results.flags);
		expect(asAdmin.mayReply).toBe(false);
		// The replier's account is kept for the record alone (S-L4).
		expect(JSON.stringify(results.flags)).not.toMatch(/"repliedBy"|"replied_by"|"participantId"|"decisionId"/);
	});

	it('T61. gives no flags key under source api, to the decider or an administrator', () => {
		const { decision, decider } = opened();
		flag(withAccount(decision, 'pat').account, decision, { kind: 'objection', reason: 'SECRET-OBJECTION' });
		const admin = makeUser({ username: `admin${++seq}`, role: 'admin' });

		for (const [who, user] of [
			['the decider', decider],
			['an administrator', admin]
		] as const) {
			const results = readResults(user, decision.id, { source: 'api' });
			expect('flags' in results, who).toBe(false);
			expect(JSON.stringify(results), who).not.toContain('SECRET-OBJECTION');
			// The page's read still has them: the source alone decides.
			expect(readResults(user, decision.id, { source: 'ui' }).flags, who).toHaveLength(1);
		}
	});

	it('T43. holds no flag text in a release, its preview, or what a board reader’s page is given of it', () => {
		const made = releasable();
		plantFlag(made.decision.id, made.pat.participant.id, { kind: 'objection', reason: 'SECRET-OBJECTION', reply: 'SECRET-REPLY', repliedAt: '2026-11-03 10:00:00' });
		plantFlag(made.decision.id, made.quin.participant.id, { kind: 'talk', reason: 'SECRET-TALK' });
		expect(readResults(made.decider, made.decision.id, { source: 'ui' }).flags, 'the reader keeps both').toHaveLength(2);

		const preview = readResults(made.decider, made.decision.id, { source: 'ui' }).releasePreview;
		expect(preview).not.toBeNull();
		expect(JSON.stringify(preview)).not.toContain('SECRET');
		expect(JSON.stringify(previewOf(decisionRow(made.decision.id)))).not.toContain('SECRET');
		release(made.decider, decisionRow(made.decision.id));
		const released = releasedOf(decisionRow(made.decision.id));
		expect(released).not.toBeNull();
		expect(JSON.stringify(released)).not.toContain('SECRET');
		expect(JSON.stringify(readDecisionPage(boardReader(), made.decision.id))).not.toContain('SECRET');
	});
});

// ─── The group breakdown in the results (card 2686, cases G1 to G6) ─────────

describe('group breakdown (card 2686)', () => {
	/** A participant whose group snapshot is `groups`, stored as given (JSON text, or not). */
	const member = (decision: Decision, name: string, groups: string, role: 'consulted' | 'informed' = 'consulted') =>
		makeParticipant(decision, { person: makePerson({ fullName: `${name} Person` }), role, groups });
	/** A group's figures: none unless given. */
	const group = (name: string | null, more: Partial<GroupTally> = {}): GroupTally => ({
		name,
		consulted: 0,
		responded: 0,
		voted: 0,
		votes: [],
		scores: [],
		abstained: 0,
		noConcerns: 0,
		mostChosen: [],
		...more
	});
	/** Each option's votes, in order. */
	const votesOf = (options: { id: number }[], counts: number[]) => options.map((option, index) => ({ optionId: option.id, count: counts[index] }));
	const FINANCE = JSON.stringify(['Finance']);

	it('G1. gives the current round per group, by name and No group last, a person in two groups counted in both, the same to the decider and an administrator', () => {
		const { decision, a, b, c, decider } = opened();
		answer(member(decision, 'fay', FINANCE), { optionId: a.id });
		answer(member(decision, 'fin', JSON.stringify(['Finance', 'Development'])), { optionId: a.id });
		answer(member(decision, 'dev', JSON.stringify(['Development'])), { optionId: b.id });
		answer(member(decision, 'dan', JSON.stringify(['Development'])), { kind: 'abstain', optionId: null });
		answer(member(decision, 'nan', '[]'), { kind: 'no_concerns', optionId: null });
		answer(member(decision, 'noe', '[]'), { optionId: c.id });
		const votes = (counts: number[]) => votesOf([a, b, c], counts);

		const results = readResults(decider, decision.id, { source: 'ui' });

		expect(results.groupBreakdown).toEqual([
			group('Development', { consulted: 3, responded: 3, voted: 2, votes: votes([1, 1, 0]), abstained: 1, mostChosen: [a.id, b.id] }),
			group('Finance', { consulted: 2, responded: 2, voted: 2, votes: votes([2, 0, 0]), mostChosen: [a.id] }),
			group(null, { consulted: 2, responded: 2, voted: 1, votes: votes([0, 0, 1]), noConcerns: 1, mostChosen: [c.id] })
		]);
		expect(readResults(makeUser({ role: 'admin' }), decision.id, { source: 'ui' }).groupBreakdown, 'an administrator').toEqual(results.groupBreakdown);
	});

	it('G2. counts in consulted a group’s live consulted people who have not responded, and no informed or removed participant anywhere', () => {
		const { decision, a, b, c, decider } = opened();
		answer(member(decision, 'fay', FINANCE), { optionId: a.id });
		member(decision, 'fin', FINANCE);
		member(decision, 'oli', JSON.stringify(['Ops']));
		makeResponse(member(decision, 'ivy', JSON.stringify(['Finance', 'Legal']), 'informed'), { kind: 'vote', optionId: b.id });
		const gone = member(decision, 'rem', JSON.stringify(['Finance', 'Legal']));
		answer(gone, { optionId: b.id });
		db.update(decisionParticipants).set({ removedAt: PAST }).where(eq(decisionParticipants.id, gone.id)).run();
		const votes = (counts: number[]) => votesOf([a, b, c], counts);

		expect(readResults(decider, decision.id, { source: 'ui' }).groupBreakdown).toEqual([
			group('Finance', { consulted: 2, responded: 1, voted: 1, votes: votes([1, 0, 0]), mostChosen: [a.id] }),
			group('Ops', { consulted: 1, votes: votes([0, 0, 0]) })
		]);
	});

	it('G3. gives no breakdown where no live consulted participant names a group', () => {
		const { decision, a, decider } = opened();
		answer(member(decision, 'pat', '[]'), { optionId: a.id });
		member(decision, 'quin', '[]');
		member(decision, 'ivy', FINANCE, 'informed');

		expect(readResults(decider, decision.id, { source: 'ui' }).groupBreakdown).toEqual([]);
	});

	it('G4. counts a person whose snapshot names a group twice once, and one whose snapshot cannot be read under No group', () => {
		const { decision, a, b, c, decider } = opened();
		answer(member(decision, 'fay', JSON.stringify(['Finance', 'Finance'])), { optionId: a.id });
		answer(member(decision, 'bad', 'not json'), { optionId: b.id });
		const votes = (counts: number[]) => votesOf([a, b, c], counts);

		expect(readResults(decider, decision.id, { source: 'ui' }).groupBreakdown).toEqual([
			group('Finance', { consulted: 1, responded: 1, voted: 1, votes: votes([1, 0, 0]), mostChosen: [a.id] }),
			group(null, { consulted: 1, responded: 1, voted: 1, votes: votes([0, 1, 0]), mostChosen: [b.id] })
		]);
	});

	it('G5. counts a survey answer as responded and not voted, in its group, with no survey question figure per group', () => {
		const { decision, decider, choice, scale, text } = surveyed();
		answered(member(decision, 'fay', FINANCE), { [choice.id]: 0, [scale.id]: 4, [text.id]: 'SECRET-ANSWER' });
		answer(member(decision, 'fin', FINANCE), { kind: 'abstain', optionId: null });
		answered(member(decision, 'noe', '[]'), { [choice.id]: 1 });

		const breakdown = readResults(decider, decision.id, { source: 'ui' }).groupBreakdown;

		expect(breakdown).toEqual([group('Finance', { consulted: 2, responded: 2, abstained: 1 }), group(null, { consulted: 1, responded: 1 })]);
		expect(JSON.stringify(breakdown)).not.toMatch(/SECRET|Which depot|How urgent|Leeds|"survey"|"answers"/);
	});

	it('G6. counts no objection or request to talk: planted flags of group members change no figure', () => {
		const { decision, a, b, c, decider } = opened();
		const fay = member(decision, 'fay', FINANCE);
		const fin = member(decision, 'fin', FINANCE);
		answer(fay, { optionId: a.id });
		const before = readResults(decider, decision.id, { source: 'ui' });
		plantFlag(decision.id, fay.id, { kind: 'objection', reason: 'Too dear.' });
		plantFlag(decision.id, fin.id, { kind: 'talk', reason: 'Call me.' });
		plantFlag(decision.id, fin.id, { kind: 'objection', reason: 'Too slow.', reply: 'Heard.', repliedAt: '2026-11-03 10:00:00' });

		const after = readResults(decider, decision.id, { source: 'ui' });

		expect(after.flags, 'the reader has the flags').toHaveLength(3);
		expect(after.groupBreakdown).toEqual(before.groupBreakdown);
		expect(after.groupBreakdown).toEqual([
			group('Finance', { consulted: 2, responded: 1, voted: 1, votes: votesOf([a, b, c], [1, 0, 0]), mostChosen: [a.id] })
		]);
	});
});
