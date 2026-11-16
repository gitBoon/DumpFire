/**
 * Decisions under API v1 (card 2682): what an API key may do to a decision,
 * and what it never may, by the credential the write was let in with as well
 * as the route's word.
 *
 * A key proves no person is present and cannot give a password. So through a
 * key a decision is drafted, edited, read by its editors, its participants
 * and decider chosen while it was never opened, extended by its decider (never
 * earlier), withdrawn or deleted while it was never opened, superseded, asked
 * and answered (an answer a draft), and its summary and record read by its
 * decider and administrators. Opening, re-publishing, a dry run, Resend,
 * closing, a participant's account and address, and every person's act are
 * the decision's page's. The service refuses those by `sourceOf(opts)`: the
 * route's word or `writingWithKey()`, either alone.
 *
 * Slice 1's cases (1 to 8) call the service and the reads directly, inside
 * `writeAs` with a real API key's credential (or a real session's) where they
 * write. The refusals the access table owns (`tests/access-every-route.test.ts`)
 * and the service refusals cards 2675 to 2680 and 2697 own are not repeated.
 *
 * The cases are the plan's, `docs/planning/card-2682-decisions-api.md`,
 * section 6.1, by number. Case 27 is card 2728's: a title, participant list
 * or decider a key chose is flagged until a person marks it reviewed
 * (`docs/planning/card-2728-agent-chosen-flags.md`, section 6).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { apiKeys, decisions, people, settings, type Board, type Column, type Decision } from '$lib/server/db/schema';
import { STALE_REVISION } from '$lib/decision-words';
import type { Credential, SessionUser } from '$lib/server/auth';
import { decisionAnswer, readDecisionForKey, readinessOf, revisionFor, versionContentAnswer, workingViewContent } from '$lib/server/decision-authoring';
import { parseVersionContent, parseWorkingContent } from '$lib/server/decision-content';
import { appendEvent, SYSTEM_ACTOR } from '$lib/server/decision-record';
import { readPersonRecord, readRecord, readRegister, recordEntryOf, registerQueryOf } from '$lib/server/decision-register';
import { readSummary } from '$lib/server/decision-results';
import { createDecision, dryRunDecision, markReviewed, setDecider, updateDraft } from '$lib/server/decision-authoring-writes';
import { closeDecision, deleteDecision, extendDecision, openDecision, republishDecision, withdrawDecision } from '$lib/server/decision-lifecycle-writes';
import { changeParticipantAddress, resendInvitation, setParticipantAccount, setParticipants } from '$lib/server/decision-participant-writes';
import { recordSeen, recordSeenByLink, respondByLink, respondToDecision } from '$lib/server/decision-response-writes';
import { raiseConcern, raiseConcernByLink, releaseResults, ruleDecision, supersedeDecision } from '$lib/server/decision-ruling-writes';
import { answerQuestion, askQuestion, askQuestionByLink, publishAnswer } from '$lib/server/decision-question-writes';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { writeAs, type ServiceOptions } from '$lib/server/write-as';
import { stamp } from '$lib/timestamps';
import { api, type ApiResult } from './helpers/api';
import { DECISION_SERVICE, SERVICE_HELPERS, SERVICES } from './helpers/source-scan';
import { FUTURE, readyDraft, revisionNow } from './helpers/decision-faults';
import { effects, type Effects } from './helpers/effects';
import { gate, gateApiRoutes } from './helpers/gate';
import {
	addBoardMember,
	FIXTURE_PASSWORD,
	makeApiKey,
	makeBoard,
	makeCard,
	makeDecision,
	makeOption,
	makeParticipant,
	makePerson,
	makeQuestion,
	makeResponse,
	makeRuling,
	makeSession,
	makeSmtp,
	makeUser,
	makeVersion,
	resetDb,
	sessionCredential
} from './helpers/fixtures';

type Row = Record<string, unknown>;

const APP = 'https://kanban.example.test';
const UI: ServiceOptions = { source: 'ui' };
const API: ServiceOptions = { source: 'api' };

/** The refusals the decision services word (card 2682, D20), written out here so that a change of words is seen. */
const MAIL_ACT =
	"Opening, re-publishing, a dry run and sending an invitation again mail people: a person does them on the decision's page. An API key cannot";
const STEP_UP_ACT = "Changing a participant's account or address asks for your password on the decision's page. An API key cannot";
const OPENED_PEOPLE =
	"This decision has been opened: who is included in it, and who decides it, are changed on the decision's page. An API key cannot";
const OPENED_ACT = "This decision has been opened: withdrawing or deleting it asks for your password on the decision's page. An API key cannot";
const CLOSE_ACT =
	"Closing a decision for input before its closing time is done on the decision's page: it makes a later ruling early. An API key cannot";
const EXTENDS_EARLIER = "closesAt must be later than the decision's current closing time: Extend never brings it earlier";
const REOPEN_ACT = "This decision is closed for input: reopening it by Extend is done on the decision's page. An API key cannot";
const REOPEN_ASKS_ACT =
	"This Extend reopens the decision for input and would ask people consulted on it for their view by mail: a person does that on the decision's page. An API key cannot";

/** The words each person's act was already refused in through a key (cards 2676 to 2679). */
const PERSONS_ACT = "Responding is a person's act: it cannot be done with an API key";
const SEEN_ACT = "Being recorded as having seen a decision is a person's act: it cannot be done with an API key";
const CONCERN_ACT = "Raising a concern is a person's act: it cannot be done with an API key";
const RULE_ACT = "Ruling is a person's act: it cannot be done with an API key";
const RELEASE_ACT = "Releasing results is a person's act: it cannot be done with an API key";
const PUBLISH_ACT = "Publishing an agent's answer is a person's act: it cannot be done with an API key";
const REPLACE_ACT = "Replacing an agent's answer is a person's act: it cannot be done with an API key";
const LINK_QUESTION_ACT = "Asking by a personal link is a person's act: it cannot be done with an API key";
const REVIEW_ACT = "Marking text reviewed is a person's act: it cannot be done with an API key";

let sent: Effects;
let owner: SessionUser;
let board: Board;
let cols: Record<string, Column>;
let seq = 0;

// The first request through the gate (cases 14(c) and 19) starts the server and loads the gate, which takes seconds while
// every other file is starting too: done here, with time to do it in, as tests/people-api.test.ts does (its departure 4).
beforeAll(async () => {
	await gateApiRoutes();
	await gate('GET', '/login', { headers: { accept: 'text/html' } });
}, 120_000);

beforeEach(() => {
	resetDb();
	// The publish and question allowances are in memory, and ids repeat after resetDb.
	resetAllRateLimits();
	makeSmtp();
	db.insert(settings).values({ key: 'app_url', value: APP }).run();
	owner = makeUser({ username: 'owner' });
	({ board, cols } = makeBoard({ owner, name: 'The board' }));
	sent = effects();
});

afterEach(() => {
	sent.restore();
});

/** The credential a gate records for a real API key of the user. */
function keyCredential(user: SessionUser): Credential {
	const key = makeApiKey(user);
	const row = db.select().from(apiKeys).all().find((k) => key.startsWith(k.keyPrefix))!;
	return { kind: 'api key', id: row.id };
}

/** Call a write as a route under /api/v1/ would, inside writeAs let in with a real API key of `user`. */
const asKey = <T>(user: SessionUser, write: (caller: SessionUser | null) => T): T =>
	writeAs({ user, credential: keyCredential(user) } as App.Locals, write as never) as T;

/** Call a write as a page's route would, inside writeAs let in with a real session of `user`. */
const asSession = <T>(user: SessionUser, write: (caller: SessionUser | null) => T): T =>
	writeAs({ user, credential: sessionCredential(makeSession(user)) } as App.Locals, write as never) as T;

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

type EventRow = { id: number; kind: string; participantId: number | null; detail: any; actorName: string; source: string };
const eventsOf = (decisionId: number): EventRow[] =>
	(
		sqlite
			.prepare('SELECT id, kind, participant_id AS participantId, detail, actor_name AS actorName, source FROM decision_events WHERE decision_id = ? ORDER BY id')
			.all(decisionId) as (Omit<EventRow, 'detail'> & { detail: string | null })[]
	).map((row) => ({ ...row, detail: row.detail === null ? null : JSON.parse(row.detail) }));
const kindsOf = (decisionId: number) => eventsOf(decisionId).map((event) => event.kind);
const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const decisionRow = (id: number) => db.select().from(decisions).where(eq(decisions.id, id)).get()!;
const activityRows = () => sqlite.prepare('SELECT board_id AS boardId, action, source FROM activity_log ORDER BY id').all() as Row[];
/** What a refused write would have left: nothing. */
const written = () => ({
	events: count('decision_events'),
	responses: count('decision_responses'),
	questions: count('decision_questions'),
	participants: count('decision_participants'),
	activity: count('activity_log')
});

/** A closing time `days` whole days ahead, in the stored form. */
const daysAhead = (days: number) => stamp(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
/** A stored moment as a body sends it. */
const sentAs = (moment: string) => `${moment.replace(' ', 'T')}Z`;

/** A board editor, by name. */
function editor(name: string): SessionUser {
	const user = makeUser({ username: `${name}${++seq}` });
	addBoardMember(board, user, 'editor');
	return user;
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

/**
 * A decision on the board opened as version 1 with options A and B, its
 * author and decider two board editors: open, closing 90 days ahead
 * (`FUTURE`), unless told otherwise.
 */
function opened(opts: { status?: string; closesAt?: string } = {}) {
	const author = editor('author');
	const decider = editor('decider');
	const made = makeDecision({
		board,
		author,
		decider,
		title: 'Which plan?',
		status: opts.status ?? 'open',
		closesAt: opts.closesAt ?? FUTURE,
		openedAt: '2026-11-01 09:00:00'
	});
	const a = makeOption(made, { label: 'A', position: 0, addedInVersion: 1 });
	const b = makeOption(made, { label: 'B', position: 1, addedInVersion: 1 });
	makeVersion(made, { situation: 'Money is short.', question: 'Which plan?', options: [a, b].map((o) => ({ optionId: o.id, label: o.label, title: `Plan ${o.label}` })) }, { number: 1 });
	return { decision: decisionRow(made.id), a, b, author, decider };
}

// ─── 1. The credential decides (D3 to D7) ────────────────────────────────────

describe('the credential decides, whatever word the route hands the service (1)', () => {
	it('(a) refuses opening a ready draft under a key handed source ui, 403 MAIL_ACT: still a draft, nothing mailed', async () => {
		const ready = readyDraft({ board });
		const before = written();

		expect(outcome(() => asKey(ready.author, (caller) => openDecision(caller, { decisionId: ready.draft.id }, { revision: revisionNow(ready.draft.id) }, UI)))).toEqual({
			status: 403,
			message: MAIL_ACT
		});
		expect(decisionRow(ready.draft.id).status).toBe('draft');
		expect(written()).toEqual(before);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('(b, c, d) refuses re-publishing, a dry run and Resend under a key handed source ui, 403 MAIL_ACT, nothing mailed', async () => {
		const { decision, author } = opened();
		const { participant } = withAccount(decision, 'pat');
		const before = written();

		const id = { decisionId: decision.id };
		expect(outcome(() => asKey(author, (caller) => republishDecision(caller, id, { changeNote: 'A change', askAgain: true, revision: revisionNow(decision.id) }, UI)))).toEqual({
			status: 403,
			message: MAIL_ACT
		});
		expect(outcome(() => asKey(author, (caller) => dryRunDecision(caller, id, { revision: revisionNow(decision.id) }, UI)))).toEqual({ status: 403, message: MAIL_ACT });
		expect(outcome(() => asKey(author, (caller) => resendInvitation(caller, { ...id, participantId: participant.id }, null, UI)))).toEqual({
			status: 403,
			message: MAIL_ACT
		});
		expect(written()).toEqual(before);
		expect(decisionRow(decision.id).currentVersion).toBe(1);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it("(e, f) refuses a participant's account and address under an administrator's key handed source ui, 403 STEP_UP_ACT", () => {
		const { decision } = opened();
		const { participant } = withAccount(decision, 'pat');
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const at = { decisionId: decision.id, participantId: participant.id };
		const before = written();

		expect(outcome(() => asKey(admin, (caller) => setParticipantAccount(caller, at, { account: 'none' }, UI)))).toEqual({ status: 403, message: STEP_UP_ACT });
		expect(outcome(() => asKey(admin, (caller) => changeParticipantAddress(caller, at, null, UI)))).toEqual({ status: 403, message: STEP_UP_ACT });
		expect(written()).toEqual(before);
	});

	it('(g, h) refuses the participants and the decider of an open decision under a key handed source ui, 403 OPENED_PEOPLE: no row, no event', async () => {
		const { decision, author } = opened();
		const newcomer = makePerson({ fullName: 'New Comer' });
		const other = editor('other');
		const before = written();

		expect(
			outcome(() =>
				asKey(author, (caller) =>
					setParticipants(caller, { decisionId: decision.id }, { participants: [{ personId: newcomer.id, role: 'consulted' }], revision: revisionNow(decision.id) }, UI)
				)
			)
		).toEqual({ status: 403, message: OPENED_PEOPLE });
		expect(outcome(() => asKey(author, (caller) => setDecider(caller, { decisionId: decision.id }, { deciderUserId: other.id, revision: revisionNow(decision.id) }, UI)))).toEqual({
			status: 403,
			message: OPENED_PEOPLE
		});
		expect(written()).toEqual(before);
		expect(kindsOf(decision.id)).not.toContain('included');
		expect(decisionRow(decision.id).deciderUserId).toBe(decision.deciderUserId);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('(i, j) refuses withdrawing an open decision, and deleting one withdrawn once opened, under a key handed source ui, 403 OPENED_ACT', async () => {
		const open = opened();
		withAccount(open.decision, 'pat');
		expect(outcome(() => asKey(open.author, (caller) => withdrawDecision(caller, { decisionId: open.decision.id }, { reason: 'Not needed.' }, UI)))).toEqual({
			status: 403,
			message: OPENED_ACT
		});
		expect(decisionRow(open.decision.id).status).toBe('open');

		const withdrawn = opened({ status: 'withdrawn' });
		appendEvent({ decisionId: withdrawn.decision.id, kind: 'withdrawn', detail: { reason: 'Gone.' } }, SYSTEM_ACTOR);
		const events = eventsOf(withdrawn.decision.id);
		expect(outcome(() => asKey(withdrawn.author, (caller) => deleteDecision(caller, { decisionId: withdrawn.decision.id }, null, UI)))).toEqual({
			status: 403,
			message: OPENED_ACT
		});
		expect(decisionRow(withdrawn.decision.id)).toBeDefined();
		expect(eventsOf(withdrawn.decision.id)).toEqual(events);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('(k) refuses Mark reviewed under a key handed source ui, in its own words', () => {
		const { decision, author } = opened();
		expect(outcome(() => asKey(author, (caller) => markReviewed(caller, { decisionId: decision.id }, { sections: 'all', revision: revisionNow(decision.id) }, UI)))).toEqual({
			status: 403,
			message: REVIEW_ACT
		});
	});

	it("(l) flags a section a key's save changed as an agent's, though the route said ui", () => {
		const author = editor('author');
		const draft = makeDecision({ board, author, decider: author, title: 'A draft' });

		asKey(author, (caller) => updateDraft(caller, { decisionId: draft.id }, { revision: revisionNow(draft.id), content: { situation: 'Written by an agent.' } }, UI));

		expect(JSON.parse(decisionRow(draft.id).workingContent).agentDrafted).toEqual({ situation: true });
	});

	it("(m) records a key's answer as an agent's draft awaiting review, though the route said ui", () => {
		const { decision, author } = opened();
		const { participant } = withAccount(decision, 'pat');
		const question = makeQuestion(decision, participant, { question: 'What does A cost?' });

		const answered = asKey(author, (caller) => answerQuestion(caller, { decisionId: decision.id, questionId: question.id }, { answer: 'About 1,000' }, UI));

		expect(answered.question).toMatchObject({ untrusted: true });
		expect(eventsOf(decision.id).at(-1)).toMatchObject({
			kind: 'question_answered',
			source: 'api',
			detail: { questionId: question.id, agentDrafted: true, notice: 'awaiting_review' }
		});
		expect(sqlite.prepare('SELECT answer_agent_drafted AS drafted FROM decision_questions WHERE id = ?').get(question.id)).toEqual({ drafted: 1 });
	});

	it("(n) records a key's draft as made through the API, though the route said ui", () => {
		const author = editor('author');
		const draft = asKey(author, (caller) => createDecision(caller, { boardId: board.id }, { title: 'From an agent' }, UI));
		expect(eventsOf(draft.id)).toEqual([expect.objectContaining({ kind: 'created', source: 'api' })]);
	});

	it('(o) refuses closing an open decision under a key handed source ui, 403 CLOSE_ACT: still open, no closed event (D29)', () => {
		const { decision, decider } = opened();
		const before = written();

		expect(outcome(() => asKey(decider, (caller) => closeDecision(caller, { decisionId: decision.id }, null, UI)))).toEqual({ status: 403, message: CLOSE_ACT });
		expect(decisionRow(decision.id).status).toBe('open');
		expect(kindsOf(decision.id)).not.toContain('closed');
		expect(written()).toEqual(before);
	});

	it("(p) records the decider's key's Extend on the record and the activity log as the API's, though the route said ui", () => {
		const { decision, decider } = opened();
		const later = daysAhead(120);

		asKey(decider, (caller) => extendDecision(caller, { decisionId: decision.id }, { closesAt: sentAs(later) }, UI));

		expect(eventsOf(decision.id).at(-1)).toMatchObject({ kind: 'extended', source: 'api', detail: { from: FUTURE, to: later } });
		// An API entry's action is stored with its `api:` prefix (logActivity.ts).
		expect(activityRows().at(-1)).toEqual({ boardId: board.id, action: 'api:decision_extended', source: 'api' });
	});

	it("(q) refuses every person's act under a key handed source ui, each in its existing words, with nothing written (plan review S5)", () => {
		const { decision, author, decider } = opened();
		const pat = withAccount(decision, 'pat');
		withLink(decision, 'link-token-q');
		const question = makeQuestion(decision, pat.participant, { answer: 'A draft.', by: author, role: 'author', agentDrafted: true });
		const ruled = opened({ status: 'closed', closesAt: '2026-11-02 09:00:00' });
		const quin = withAccount(ruled.decision, 'quin');
		withLink(ruled.decision, 'link-token-r');
		makeRuling(ruled.decision, { ruledAt: stamp() });
		const before = written();

		const id = { decisionId: decision.id };
		const ruledId = { decisionId: ruled.decision.id };
		const rows: [string, () => unknown, string][] = [
			['respondToDecision', () => asKey(pat.account, (caller) => respondToDecision(caller, id, { kind: 'abstain' }, UI)), PERSONS_ACT],
			['respondByLink', () => asKey(pat.account, (caller) => respondByLink(caller, { token: 'link-token-q' }, { kind: 'abstain' }, UI)), PERSONS_ACT],
			['recordSeen', () => asKey(pat.account, (caller) => recordSeen(caller, id, { versionNumber: 1, stage: 'question' }, UI)), SEEN_ACT],
			['recordSeenByLink', () => asKey(pat.account, (caller) => recordSeenByLink(caller, { token: 'link-token-q' }, { versionNumber: 1, stage: 'question' }, UI)), SEEN_ACT],
			['raiseConcern', () => asKey(quin.account, (caller) => raiseConcern(caller, ruledId, { comment: 'A concern.' }, UI)), CONCERN_ACT],
			['raiseConcernByLink', () => asKey(quin.account, (caller) => raiseConcernByLink(caller, { token: 'link-token-r' }, { comment: 'A concern.' }, UI)), CONCERN_ACT],
			['ruleDecision', () => asKey(decider, (caller) => ruleDecision(caller, id, { optionId: null, reason: 'Because.', revision: '' }, UI)), RULE_ACT],
			['releaseResults', () => asKey(ruled.decider, (caller) => releaseResults(caller, ruledId, { revision: '' }, UI)), RELEASE_ACT],
			['publishAnswer', () => asKey(author, (caller) => publishAnswer(caller, { ...id, questionId: question.id }, null, UI)), PUBLISH_ACT],
			[
				'answerQuestion replacing a draft',
				() => asKey(author, (caller) => answerQuestion(caller, { ...id, questionId: question.id }, { answer: 'Mine.', replacesDraft: true }, UI)),
				REPLACE_ACT
			],
			['askQuestionByLink', () => asKey(pat.account, (caller) => askQuestionByLink(caller, { token: 'link-token-q' }, { question: 'Why?' }, UI)), LINK_QUESTION_ACT]
		];
		for (const [name, run, words] of rows) expect(outcome(run), name).toEqual({ status: 403, message: words });
		expect(written()).toEqual(before);
	});

	it("(r) records a key's own participant's question as asked through the API, though the route said ui", () => {
		const { decision } = opened();
		const pat = withAccount(decision, 'pat');

		const asked = asKey(pat.account, (caller) => askQuestion(caller, { decisionId: decision.id }, { question: 'What does A cost?' }, UI));

		expect(asked.question).toEqual({ question: 'What does A cost?', askedInVersion: 1, untrusted: true });
		expect(sqlite.prepare('SELECT via FROM decision_questions WHERE decision_id = ?').get(decision.id)).toEqual({ via: 'api' });
		expect(eventsOf(decision.id).at(-1)).toMatchObject({ kind: 'question_asked', source: 'api' });
	});

	it('(s) opens a ready draft for a session handed source ui, as the page does: the page is unaffected', async () => {
		const ready = readyDraft({ board });

		const row = asSession(ready.author, (caller) => openDecision(caller, { decisionId: ready.draft.id }, { revision: revisionNow(ready.draft.id) }, UI));

		expect(row.status).toBe('open');
		expect(eventsOf(ready.draft.id).find((event) => event.kind === 'opened')).toMatchObject({ source: 'ui' });
		await vi.waitFor(() => expect(kindsOf(ready.draft.id).filter((kind) => kind === 'mail_outcome')).toHaveLength(2));
	});

	it("(t) refuses opening for a session whose route said api, 403 MAIL_ACT: the route's word refuses on its own", () => {
		const ready = readyDraft({ board });
		expect(outcome(() => asSession(ready.author, (caller) => openDecision(caller, { decisionId: ready.draft.id }, { revision: revisionNow(ready.draft.id) }, API)))).toEqual({
			status: 403,
			message: MAIL_ACT
		});
		expect(decisionRow(ready.draft.id).status).toBe('draft');
	});
});

// ─── 2. The refusals read no row (D3, D6, D29) ───────────────────────────────

describe('the key refusals come before any row is read (2)', () => {
	it('answers an id that is no decision 403, not 404: opening, the account, closing', () => {
		const author = editor('author');
		const admin = makeUser({ username: 'admin', role: 'admin' });
		expect(outcome(() => asKey(author, (caller) => openDecision(caller, { decisionId: 999999 }, { revision: 'x' }, API)))).toEqual({ status: 403, message: MAIL_ACT });
		expect(outcome(() => asKey(admin, (caller) => setParticipantAccount(caller, { decisionId: 999999, participantId: 1 }, { account: 'none' }, API)))).toEqual({
			status: 403,
			message: STEP_UP_ACT
		});
		expect(outcome(() => asKey(author, (caller) => closeDecision(caller, { decisionId: 999999 }, null, API)))).toEqual({ status: 403, message: CLOSE_ACT });
	});
});

// ─── 3. The one place the decision services read the source (D7, fail closed) ─

/** The top-level declarations of `sourceOf` in a source file: a function, or a variable that holds one (card 2713, D6 row 6). */
function sourceOfDeclarations(tree: ts.SourceFile): ts.Node[] {
	return tree.statements.flatMap((statement): ts.Node[] => {
		if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'sourceOf') return [statement];
		if (!ts.isVariableStatement(statement)) return [];
		return statement.declarationList.declarations.filter((declared) => ts.isIdentifier(declared.name) && declared.name.text === 'sourceOf');
	});
}

/**
 * Where a source file reads `opts.source` (as `opts.source`, `opts['source']`
 * or `const { source } = opts`) or names `writingWithKey`, outside the body of
 * `sourceOf`: each a finding, by line. An identifier scan of the parsed file,
 * so that a comment is never read, nor the import declaration. Card 2713 (D6
 * row 6): only a file that `mayDeclare` it (a module on SERVICE_HELPERS) may
 * declare `sourceOf` and read inside it; anywhere else the declaration is a
 * finding and its body is read like the rest, so that a service cannot grant
 * itself the exemption.
 */
function sourceReadsOutside(file: string, source: string, mayDeclare = true): string[] {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const one = mayDeclare
		? tree.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === 'sourceOf')
		: undefined;
	const inside = (node: ts.Node) => one?.body !== undefined && node.getStart(tree) >= one.body.getStart(tree) && node.getEnd() <= one.body.getEnd();
	const isOpts = (node: ts.Node) => ts.isIdentifier(node) && node.text === 'opts';
	const findings: string[] = mayDeclare ? [] : sourceOfDeclarations(tree).map((declared) => `${file}:${line(declared)} declares sourceOf: only a module on SERVICE_HELPERS may`);
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) return;
		if (!inside(node)) {
			if (ts.isPropertyAccessExpression(node) && node.name.text === 'source' && isOpts(node.expression)) findings.push(`${file}:${line(node)} reads opts.source`);
			if (ts.isElementAccessExpression(node) && isOpts(node.expression) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'source') {
				findings.push(`${file}:${line(node)} reads opts['source']`);
			}
			if (ts.isVariableDeclaration(node) && node.initializer && isOpts(node.initializer) && ts.isObjectBindingPattern(node.name)) {
				const named = node.name.elements.some((element) => ((element.propertyName ?? element.name) as ts.Identifier).text === 'source');
				if (named) findings.push(`${file}:${line(node)} takes source out of opts`);
			}
			if (ts.isIdentifier(node) && node.text === 'writingWithKey') findings.push(`${file}:${line(node)} names writingWithKey`);
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return findings;
}

describe('the decision services read the source only through sourceOf (3)', () => {
	it('reads opts.source and names writingWithKey only inside the helper’s sourceOf, which no service declares, and the scan finds one outside it', () => {
		// Card 2713 (D6 row 6, R5): the decision services on SERVICES and the modules on SERVICE_HELPERS, read from the lists
		// themselves; asserted whole: the seven services and the helper, eight files.
		const files = [...SERVICES.filter((file) => DECISION_SERVICE.test(file)), ...SERVICE_HELPERS];
		expect(files).toEqual([
			'src/lib/server/decision-authoring-writes.ts',
			'src/lib/server/decision-lifecycle-writes.ts',
			'src/lib/server/decision-participant-writes.ts',
			'src/lib/server/decision-card-link-writes.ts',
			'src/lib/server/decision-response-writes.ts',
			'src/lib/server/decision-ruling-writes.ts',
			'src/lib/server/decision-question-writes.ts',
			'src/lib/server/decision-write-shared.ts'
		]);
		expect(files).toHaveLength(8);
		const read = files.map((file) => ({ file, source: readFileSync(join(process.cwd(), file), 'utf8') }));
		const declaring = read.filter(({ file, source }) => sourceOfDeclarations(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)).length > 0);
		expect(declaring.map(({ file }) => file)).toEqual(['src/lib/server/decision-write-shared.ts']);
		expect(read.flatMap(({ file, source }) => sourceReadsOutside(file, source, SERVICE_HELPERS.includes(file)))).toEqual([]);
		// Typed as a request's tree, which `system` (card 2754, DumpFire's own entries) never is.
		// Either line ending (card 2846): a Windows checkout writes the file with CRLF.
		expect(declaring[0].source).toMatch(/function sourceOf\(opts: ServiceOptions\): ServiceOptions\['source'\] \{\r?\n\treturn opts\.source !== 'ui' \|\| writingWithKey\(\) \? 'api' : 'ui';\r?\n\}/);

		const EXAMPLE = 'src/lib/server/example.ts';
		const passes = [
			"import { writingWithKey } from './write-as';",
			'/** Says opts.source in a comment, and writingWithKey too. */',
			"function sourceOf(opts) { return opts.source !== 'ui' || writingWithKey() ? 'api' : 'ui'; }",
			'// opts.source again, in a line comment.',
			'export function write(caller, at, body, opts) { return sourceOf(opts); }'
		].join('\n');
		expect(sourceReadsOutside(EXAMPLE, passes)).toEqual([]);

		const fails = [
			"import { writingWithKey } from './write-as';",
			"function sourceOf(opts) { return opts.source !== 'ui' || writingWithKey() ? 'api' : 'ui'; }",
			"export function write(caller, at, body, opts) { if (opts.source !== 'ui') throw new Error('no'); }",
			"export function other(caller, at, body, opts) { return opts['source']; }",
			'export function third(caller, at, body, opts) { const { source } = opts; return source; }',
			'export function fourth() { return writingWithKey(); }'
		].join('\n');
		expect(sourceReadsOutside(EXAMPLE, fails)).toEqual([
			`${EXAMPLE}:3 reads opts.source`,
			`${EXAMPLE}:4 reads opts['source']`,
			`${EXAMPLE}:5 takes source out of opts`,
			`${EXAMPLE}:6 names writingWithKey`
		]);

		// Card 2713 (D6 row 6): a service that declares its own sourceOf, as a function or a constant, gains no exemption by it.
		const SERVICE = 'src/lib/server/decision-things-writes.ts';
		const own = [
			"import { writingWithKey } from './write-as';",
			"function sourceOf(opts) { return opts.source !== 'ui' || writingWithKey() ? 'api' : 'ui'; }",
			"const other = 1, sourceOf2 = 2;",
			'export function write(caller, at, body, opts) { return sourceOf(opts); }'
		].join('\n');
		expect(sourceReadsOutside(SERVICE, own, false)).toEqual([
			`${SERVICE}:2 declares sourceOf: only a module on SERVICE_HELPERS may`,
			`${SERVICE}:2 reads opts.source`,
			`${SERVICE}:2 names writingWithKey`
		]);
		expect(sourceReadsOutside(SERVICE, "const sourceOf = (opts) => opts.source;", false)).toEqual([
			`${SERVICE}:1 declares sourceOf: only a module on SERVICE_HELPERS may`,
			`${SERVICE}:1 reads opts.source`
		]);
	});
});

// ─── 4. The editors' read through a key (D9, D10, D11) ───────────────────────

/** Every key at any depth of a value. */
function keysDeep(value: unknown, into = new Set<string>()): Set<string> {
	if (Array.isArray(value)) for (const item of value) keysDeep(item, into);
	else if (value !== null && typeof value === 'object') {
		for (const [key, inner] of Object.entries(value)) {
			into.add(key);
			keysDeep(inner, into);
		}
	}
	return into;
}

/** A group of the people directory, with the persons given as its members. */
function makeGroup(name: string, personIds: number[]): number {
	const { id } = sqlite.prepare('INSERT INTO people_groups (name, description) VALUES (?, ?) RETURNING id').get(name, 'A description') as { id: number };
	for (const personId of personIds) sqlite.prepare('INSERT INTO people_group_members (group_id, person_id) VALUES (?, ?)').run(id, personId);
	return id;
}

describe('readDecisionForKey (4)', () => {
	it("(a) gives an administrator's key no address, account or reviewer id, marks every holder of words, and what a key may do to a draft", () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const author = editor('author');
		const decider = editor('decider');
		const draft = makeDecision({ board, author, decider, title: 'A draft' });
		db.update(decisions)
			.set({ workingContent: JSON.stringify({ situation: 'Money is short.', reviewed: { situation: { byUserId: author.id, byName: author.username, at: '2026-11-01 09:00:00' } } }) })
			.where(eq(decisions.id, draft.id))
			.run();
		const account = makeUser({ username: 'pat' });
		const pat = makePerson({ fullName: 'Pat Doe', email: 'pat.doe@example.test', user: account });
		makeParticipant(draft, { person: pat, role: 'consulted' });
		makeGroup('Finance', [pat.id]);

		const view = readDecisionForKey(admin, draft.id, { source: 'api' });

		const keys = keysDeep(view);
		for (const never of ['email', 'userId', 'includedBy', 'removedBy', 'linkIssuedAt', 'delivery', 'directory', 'byUserId', 'republishSummary']) {
			expect(keys.has(never), never).toBe(false);
		}
		expect(JSON.stringify(view)).not.toContain('@');
		expect(view.untrusted).toBe(true);
		expect(view.decision.untrusted).toBe(true);
		expect(view.participants.length).toBe(1);
		expect(view.people.length).toBeGreaterThan(0);
		expect(view.groups.length).toBe(1);
		expect(view.groups[0].activeMemberIds).toEqual([pat.id]);
		expect(view.deciderCandidates.length).toBeGreaterThan(0);
		for (const item of [...view.participants, ...view.people, ...view.groups, ...view.deciderCandidates]) expect(item.untrusted).toBe(true);
		expect(view.revision).toBe(revisionFor(draft.id));
		expect(view.actions).toEqual({ edit: true, setDecider: true, setParticipants: true, extend: false, withdraw: true, delete: true, supersede: false });
	});

	it('(b) gives a decider who is not the author, on an open decision, Extend alone, and no picker people or candidates', () => {
		const { decision, decider } = opened();
		makePerson({ fullName: 'Someone' });
		makeGroup('Finance', []);

		const view = readDecisionForKey(decider, decision.id, { source: 'api' });

		expect(view.actions).toMatchObject({ extend: true, setDecider: false, setParticipants: false, withdraw: false, delete: false, supersede: false });
		expect(view.people).toEqual([]);
		expect(view.deciderCandidates).toEqual([]);
		expect(view.groups.map((group) => Object.keys(group).sort())).toEqual([['id', 'name', 'untrusted']]);
	});

	it("(c) gives an administrator's key no closing time, and no moment it was closed, once ruled (code review S5)", () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const { decision } = opened({ status: 'closed', closesAt: '2026-11-02 09:00:00' });
		db.update(decisions).set({ closedAt: '2026-11-01 12:00:00' }).where(eq(decisions.id, decision.id)).run();
		makeRuling(decision, { ruledAt: stamp() });

		expect(readDecisionForKey(admin, decision.id, { source: 'api' }).decision).toMatchObject({ closesAt: null, closedAt: null });
		// The page's projection: an administrator is given both, anyone else neither (as closesAt, card 2679 decision 26).
		const row = decisionRow(decision.id);
		expect(decisionAnswer(row, true)).toMatchObject({ closesAt: '2026-11-02 09:00:00', closedAt: '2026-11-01 12:00:00' });
		expect(decisionAnswer(row, false)).toMatchObject({ closesAt: null, closedAt: null });
	});

	it('(d) gives a key the moment a closed decision not yet ruled was closed (code review S5 withholds it once ruled alone), and no Extend (S2)', () => {
		const { decision, decider } = opened({ status: 'closed', closesAt: '2026-11-02 09:00:00' });
		db.update(decisions).set({ closedAt: '2026-11-01 12:00:00' }).where(eq(decisions.id, decision.id)).run();

		const view = readDecisionForKey(decider, decision.id, { source: 'api' });
		expect(view.decision.closedAt).toBe('2026-11-01 12:00:00');
		// Code review S2: a key does not reopen a closed decision, so its decider's key is not offered Extend.
		expect(view.actions.extend).toBe(false);
	});
});

// ─── 5. The summary through a key (D10, D14) ─────────────────────────────────

describe('readSummary (5)', () => {
	function summarised() {
		const made = opened({ status: 'closed', closesAt: '2026-11-02 09:00:00' });
		const pat = withAccount(made.decision, 'pat');
		const quin = withAccount(made.decision, 'quin');
		const ria = withAccount(made.decision, 'ria');
		makeResponse(pat.participant, { kind: 'vote', optionId: made.a.id, comment: 'Plan A is enough.', optionComments: JSON.stringify({ [made.b.id]: 'B costs too much.' }) });
		makeResponse(quin.participant, { kind: 'concern', round: 1, comment: 'I worry about A.' });
		makeQuestion(made.decision, pat.participant, { question: 'What does A cost?', answer: 'About 1,000', by: made.author, role: 'author', agentDrafted: true });
		makeRuling(made.decision, { optionId: made.b.id, early: true, againstResponses: true, reason: 'B lasts.', conditions: 'Review in a year.', ruledAt: stamp() });
		appendEvent({ decisionId: made.decision.id, kind: 'cut_off', participantId: ria.participant.id }, SYSTEM_ACTOR);
		return { ...made, pat, quin, ria };
	}

	it('(a) answers exactly the allow-list, nothing to rule or release by, and an agent-answered open question with no asker', () => {
		const { decision, decider } = summarised();

		const summary = readSummary(decider, decision.id, { source: 'api' });

		expect(Object.keys(summary).sort()).toEqual(
			['concerns', 'current', 'decision', 'earlierRounds', 'mostChosen', 'notResponded', 'openQuestions', 'options', 'released', 'removed', 'round', 'ruling', 'untrusted'].sort()
		);
		expect(summary.untrusted).toBe(true);
		expect(summary.openQuestions).toEqual([{ question: 'What does A cost?', agentAnswered: true, untrusted: true }]);
	});

	it('(b) gives the ruling early, against the responses, and who was cut off', () => {
		const { decision, decider } = summarised();
		const { ruling } = readSummary(decider, decision.id, { source: 'api' });
		expect(ruling).toMatchObject({ early: true, againstResponses: true, cutOff: ['ria Person'] });
		// Card 2738: the fixture's cut_off carries no detail, as one recorded before it: neither reached nor not.
		expect(ruling?.cutOffReached).toEqual([null]);
	});

	it('(b2) says whom the round’s request reached, on notResponded and on each cut-off (card 2738)', () => {
		const { decision, decider, ria } = summarised();
		appendEvent({ decisionId: decision.id, kind: 'cut_off', participantId: ria.participant.id, detail: { reached: false } }, SYSTEM_ACTOR);
		const summary = readSummary(decider, decision.id, { source: 'api' });
		expect(summary.ruling?.cutOffReached).toEqual([null, false]);
		// Quin's concern and Ria's silence count as no response; neither was sent a request on this record.
		expect(summary.notResponded.map((row) => [row.name, row.reached])).toEqual([
			['quin Person', false],
			['ria Person', false]
		]);
	});

	it("(c) marks each response, each concern and the ruling, the objects holding people's words (plan review S7)", () => {
		const { decision, decider, b } = summarised();
		const summary = readSummary(decider, decision.id, { source: 'api' });

		expect(summary.current.rows).toEqual([
			expect.objectContaining({ comment: 'Plan A is enough.', optionComments: { [b.id]: 'B costs too much.' }, untrusted: true })
		]);
		expect(summary.concerns).toEqual([expect.objectContaining({ comment: 'I worry about A.', untrusted: true })]);
		expect(summary.ruling).toMatchObject({ reason: 'B lasts.', conditions: 'Review in a year.', untrusted: true });
	});
});

// ─── 6. The record through a key (D9, D15, D31) ──────────────────────────────

describe('readRecord by source (6)', () => {
	function recorded() {
		const { decision, author, decider } = opened();
		const linky = withLink(decision, 'link-token-6');
		const asker = withAccount(decision, 'asker');
		const question = makeQuestion(decision, asker.participant, { question: 'Why?' });
		const actor = (user: SessionUser, source: 'ui' | 'api' = 'ui') => ({ userId: user.id, name: user.username, source });
		appendEvent({ decisionId: decision.id, kind: 'included', participantId: linky.participant.id, detail: { role: 'consulted', hadAccount: false } }, actor(author));
		const included = appendEvent({ decisionId: decision.id, kind: 'included', participantId: asker.participant.id, detail: { role: 'consulted', hadAccount: true } }, actor(author));
		appendEvent(
			{ decisionId: decision.id, kind: 'responded', participantId: linky.participant.id, versionNumber: 1, detail: { responseId: 1, statement: 1, signedIn: { userId: owner.id, name: 'browser' } } },
			{ userId: null, name: linky.participant.name, source: 'link' }
		);
		appendEvent(
			{ decisionId: decision.id, kind: 'address_changed', participantId: linky.participant.id, detail: { from: 'old@example.test', to: 'new@example.test' } },
			actor(owner)
		);
		appendEvent({ decisionId: decision.id, kind: 'question_asked', participantId: asker.participant.id, versionNumber: 1, detail: { questionId: question.id, notices: [] } }, actor(asker.account));
		const seen = appendEvent({ decisionId: decision.id, kind: 'seen', participantId: asker.participant.id, versionNumber: 1, detail: { stage: 'question' } }, actor(asker.account));
		appendEvent({ decisionId: decision.id, kind: 'question_answered', detail: { questionId: question.id, role: 'author', agentDrafted: true, notice: 'awaiting_review' } }, actor(author, 'api'));
		appendEvent(
			{
				decisionId: decision.id,
				kind: 'answer_replaced',
				detail: { questionId: question.id, role: 'decider', discarded: { text: 'A draft.', byName: author.username, at: '2026-11-02 11:00:00' }, notice: 'asked' }
			},
			actor(decider)
		);
		appendEvent({ decisionId: decision.id, kind: 'answer_published', detail: { questionId: question.id, notice: 'asked' } }, actor(decider));
		// Code review S1 and S4: a question asked by personal link, its actor the link holder's snapshot name.
		const linkQuestion = makeQuestion(decision, linky.participant, { question: 'How long?' });
		appendEvent(
			{ decisionId: decision.id, kind: 'question_asked', participantId: linky.participant.id, versionNumber: 1, detail: { questionId: linkQuestion.id, notices: [] } },
			{ userId: null, name: linky.participant.name, source: 'link' }
		);
		const admin = makeUser({ username: 'admin', role: 'admin' });
		return { decision, admin, asker, linky, included, seen };
	}
	const QUESTION_KINDS = ['question_asked', 'question_answered', 'answer_published', 'answer_replaced'];
	/** The events `recorded()` writes that are no question event: two included, responded, address_changed and seen. */
	const OTHER_EVENTS = 5;
	const all = { participant: null, after: null };

	it("(a) shows an administrator's key no address and no signed-in account, and marks each entry and the page", () => {
		const { decision, admin } = recorded();
		const page = readRecord(admin, decision.id, all, { source: 'api', limit: 500 });

		expect(page.untrusted).toBe(true);
		for (const entry of page.entries) expect(entry.untrusted).toBe(true);
		expect(page.entries.find((entry) => entry.kind === 'address_changed')!.detail).toEqual({});
		expect(page.entries.find((entry) => entry.kind === 'responded')!.detail).toEqual({ statement: 1 });
		expect(JSON.stringify(page)).not.toContain('@');
	});

	it('(b) leaves all four question events out of a key\'s page, a question asked by personal link among them, in the query (code review S1)', () => {
		const { decision, admin } = recorded();
		const page = readRecord(admin, decision.id, all, { source: 'api', limit: 500 });

		expect(page.entries.filter((entry) => QUESTION_KINDS.includes(entry.kind))).toEqual([]);
		expect(page.entries).toHaveLength(OTHER_EVENTS);
		// In the query: a page exactly as long as the other events is the last, where a filter after the read would say more.
		const exact = readRecord(admin, decision.id, all, { source: 'api', limit: OTHER_EVENTS });
		expect(exact.entries).toHaveLength(OTHER_EVENTS);
		expect(exact.next).toBeNull();
		// Every other entry keeps its moment and names.
		expect(page.entries.find((entry) => entry.kind === 'seen')).toMatchObject({ participant: 'asker Person', actor: { name: expect.any(String) }, at: expect.any(String) });
		// The page holds both questions, the one asked by link among them.
		const shown = readRecord(admin, decision.id, all, { source: 'ui', limit: 500 });
		expect(shown.entries.filter((entry) => entry.kind === 'question_asked').map((entry) => entry.actor.source).sort()).toEqual(['link', 'ui']);
		// And recordEntryOf, handed a question event for a key, throws rather than show it.
		const row = { id: 1, kind: 'question_asked', participantId: null, versionNumber: 1, detail: {}, actorName: 'Someone', source: 'link', at: '2026-11-01 09:00:00' };
		const ctx = { user: admin, labels: new Map<number, string>(), participants: new Map<number, string>() };
		expect(() => recordEntryOf(row, { ...ctx, source: 'api' })).toThrow(/never given to an API key/);
		expect(recordEntryOf(row, { ...ctx, source: 'ui' })).toMatchObject({ kind: 'question_asked', actor: { name: 'Someone', source: 'link' } });
	});

	it("(c) leaves the question events out of a key's page filtered by the asker, in the query, so that next is exact", () => {
		const { decision, admin, asker, included, seen } = recorded();
		const filter = { participant: asker.participant.id, after: null };

		const first = readRecord(admin, decision.id, filter, { source: 'api', limit: 1 });
		expect(first.entries.map((entry) => entry.kind)).toEqual(['included']);
		expect(first.next).toBe(included);
		const second = readRecord(admin, decision.id, { ...filter, after: first.next }, { source: 'api', limit: 1 });
		expect(second.entries.map((entry) => entry.kind)).toEqual(['seen']);
		expect(second.next).toBeNull();
		expect(seen).toBeGreaterThan(included);

		// The page's own filter still shows the question the asker asked.
		const page = readRecord(admin, decision.id, filter, { source: 'ui', limit: 500 });
		expect(page.entries.map((entry) => entry.kind)).toEqual(['included', 'question_asked', 'seen']);
	});

	it('(d) shows the page every detail, the asker and the moments, and marks nothing', () => {
		const { decision, admin, asker } = recorded();
		const page = readRecord(admin, decision.id, all, { source: 'ui', limit: 500 });

		expect('untrusted' in page).toBe(false);
		for (const entry of page.entries) expect('untrusted' in entry).toBe(false);
		expect(page.entries.find((entry) => entry.kind === 'address_changed')!.detail).toEqual({ from: 'old@example.test', to: 'new@example.test' });
		expect(page.entries.find((entry) => entry.kind === 'responded')!.detail).toEqual({ statement: 1, signedIn: { name: 'browser' } });
		expect(page.entries.find((entry) => entry.kind === 'question_asked')).toMatchObject({ participant: 'asker Person', actor: { name: asker.account.username } });
		expect(page.entries.find((entry) => entry.kind === 'answer_replaced')!.detail).toEqual({
			role: 'decider',
			discarded: { text: 'A draft.', byName: expect.any(String), at: '2026-11-02 11:00:00' }
		});
	});
});

// ─── 7. The register by source (D10, D16) ────────────────────────────────────

describe('readRegister by source (7)', () => {
	it('(a) marks each row and the page for a key; (b) marks nothing for the page', () => {
		opened();
		opened();

		const keyed = readRegister(owner, registerQueryOf(new URLSearchParams('tab=all'), 'api'), { source: 'api' });
		expect(keyed.rows.length).toBe(2);
		expect(keyed.untrusted).toBe(true);
		for (const row of keyed.rows) expect(row.untrusted).toBe(true);

		const page = readRegister(owner, registerQueryOf(new URLSearchParams('tab=all'), 'page'), { source: 'ui' });
		expect(page.rows.length).toBe(2);
		expect('untrusted' in page).toBe(false);
		for (const row of page.rows) expect('untrusted' in row).toBe(false);
	});
});

// ─── 8. Extend never earlier, any source (D30) ───────────────────────────────

describe('extendDecision never brings the closing time earlier, for any source (8)', () => {
	const extend = (run: typeof asKey, decider: SessionUser, decision: Decision, closesAt: string, opts: ServiceOptions) =>
		run(decider, (caller) => extendDecision(caller, { decisionId: decision.id }, { closesAt: sentAs(closesAt) }, opts));

	it('(a, b, c) refuses an earlier time and the same time, from the page and from a key, 400 with nothing written', () => {
		const { decision, decider } = opened();
		const before = written();

		expect(outcome(() => extend(asSession, decider, decision, daysAhead(30), UI))).toEqual({ status: 400, message: EXTENDS_EARLIER });
		expect(outcome(() => extend(asSession, decider, decision, FUTURE, UI))).toEqual({ status: 400, message: EXTENDS_EARLIER });
		expect(outcome(() => extend(asKey, decider, decision, daysAhead(30), API))).toEqual({ status: 400, message: EXTENDS_EARLIER });
		expect(decisionRow(decision.id).closesAt).toBe(FUTURE);
		expect(written()).toEqual(before);
	});

	it('(d) takes a later time from the page: open, moved', () => {
		const { decision, decider } = opened();
		const later = daysAhead(120);
		const row = extend(asSession, decider, decision, later, UI);
		expect(row).toMatchObject({ status: 'open', closesAt: later });
	});

	it('(e) takes a week ahead for a closed decision whose time has passed', () => {
		const { decision, decider } = opened({ status: 'closed', closesAt: '2026-11-02 09:00:00' });
		const week = daysAhead(7);
		expect(extend(asSession, decider, decision, week, UI)).toMatchObject({ status: 'open', closesAt: week, closedAt: null });
	});

	it('(f) refuses the page a time between now and the old closing time of a decision closed early, 400; (g) a key is refused 403 before it (code review F2, S2, S4)', () => {
		// Closed early: status closed, its closing time still 90 days ahead.
		const { decision, decider } = opened({ status: 'closed' });
		const before = written();

		expect(outcome(() => extend(asSession, decider, decision, daysAhead(30), UI))).toEqual({ status: 400, message: EXTENDS_EARLIER });
		expect(outcome(() => extend(asKey, decider, decision, daysAhead(30), UI))).toEqual({ status: 403, message: REOPEN_ACT });
		expect(outcome(() => extend(asKey, decider, decision, daysAhead(120), API))).toEqual({ status: 403, message: REOPEN_ACT });
		expect(decisionRow(decision.id)).toMatchObject({ status: 'closed', closesAt: FUTURE });
		expect(written()).toEqual(before);
		// The page still reopens it to a later time.
		expect(extend(asSession, decider, decision, daysAhead(120), UI)).toMatchObject({ status: 'open', closedAt: null });
	});

	it('(h) refuses a key a closed decision whose time has passed, 403, where the page reopens it (code review S2)', () => {
		const { decision, decider } = opened({ status: 'closed', closesAt: '2026-11-02 09:00:00' });
		expect(outcome(() => extend(asKey, decider, decision, daysAhead(7), API))).toEqual({ status: 403, message: REOPEN_ACT });
		expect(decisionRow(decision.id).status).toBe('closed');
		expect(kindsOf(decision.id)).not.toContain('extended');
	});

	it('(i) refuses a key the Extend of a decision past its closing time that would ask someone for their view, 403; with nobody to ask, takes it and mails nobody (card 2744, D5; 2744-7)', async () => {
		const lapsedAt = '2026-11-02 09:00:00';
		const later = daysAhead(7);
		// Only an informed participant: nobody to ask, so the key's Extend is taken and mails nobody.
		const told = opened({ closesAt: lapsedAt });
		withAccount(told.decision, 'told', 'informed');
		expect(extend(asKey, told.decider, told.decision, later, API)).toMatchObject({ status: 'open', closesAt: later });
		expect(kindsOf(told.decision.id)).not.toContain('invited');

		// A consulted participant the round never reached: the reopening would ask them, so a key is refused.
		const asks = opened({ closesAt: lapsedAt });
		withAccount(asks.decision, 'unasked');
		const before = written();
		expect(outcome(() => extend(asKey, asks.decider, asks.decision, later, API))).toEqual({ status: 403, message: REOPEN_ASKS_ACT });
		expect(outcome(() => extend(asKey, asks.decider, asks.decision, later, UI))).toEqual({ status: 403, message: REOPEN_ASKS_ACT });
		expect(written()).toEqual(before);
		expect(decisionRow(asks.decision.id).closesAt).toBe(lapsedAt);
		// The page reopens it, and asks them.
		expect(extend(asSession, asks.decider, asks.decision, later, UI)).toMatchObject({ status: 'open', closesAt: later });
		expect(kindsOf(asks.decision.id).filter((kind) => kind === 'invited')).toHaveLength(1);
		await sent.settle();
		expect(sent.emails.map((mail) => mail.subject)).toEqual(['Your view is asked: Which plan?']);
	});

	it('(j) takes a key the Extend of a decision past its closing time whose only consulted participant the round already reached, and mails nobody (card 2744, D5; code review 2026-11-05)', async () => {
		const lapsedAt = '2026-11-02 09:00:00';
		const later = daysAhead(7);
		const { decision, decider } = opened({ closesAt: lapsedAt });
		const { participant } = withAccount(decision, 'reached');
		// The round's own `published`, then their invitation, delivered before the closing time then in force: reached.
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
			appendEvent({ decisionId: decision.id, kind: 'published', versionNumber: 1, detail: { asksAgain: true, changeNote: null } }, SYSTEM_ACTOR);
			const of = appendEvent({ decisionId: decision.id, kind: 'invited', participantId: participant.id }, SYSTEM_ACTOR);
			appendEvent({ decisionId: decision.id, kind: 'mail_outcome', participantId: participant.id, detail: { of, mail: 'invitation', delivered: true } }, SYSTEM_ACTOR);
		} finally {
			vi.useRealTimers();
		}
		const before = eventsOf(decision.id).length;

		expect(extend(asKey, decider, decision, later, API)).toMatchObject({ status: 'open', closesAt: later });

		expect(kindsOf(decision.id).slice(before)).toEqual(['extended']);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('(k) takes a key the Extend of a decision past its closing time whose only unasked consulted participant no mail can reach: recorded mail_skipped, nobody mailed (code review 2026-11-05)', async () => {
		const lapsedAt = '2026-11-02 09:00:00';
		const later = daysAhead(7);
		const { decision, decider } = opened({ closesAt: lapsedAt });
		const gone = withAccount(decision, 'gone');
		// Never reached, but left: `reachOf` skips them, so the reopening would mail nobody.
		db.update(people).set({ status: 'left', leftAt: stamp() }).where(eq(people.id, gone.person.id)).run();
		const before = eventsOf(decision.id).length;

		expect(extend(asKey, decider, decision, later, API)).toMatchObject({ status: 'open', closesAt: later });

		expect(eventsOf(decision.id).slice(before).map((event) => [event.kind, event.participantId, event.detail])).toEqual([
			['extended', null, { from: lapsedAt, to: later }],
			['mail_skipped', gone.participant.id, { mail: 'invitation', reason: 'left' }]
		]);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});
});

// ─── The routes of slice 2a, with a real key's credential (cases 9 to 20) ────

/** A request under /api/v1/ as `user`, with the credential of a real API key of theirs. */
const withKey = (user: SessionUser, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiResult> =>
	api(method, path, { user, credential: keyCredential(user), ...(body === undefined ? {} : { body }) });

/** A real key of the user, as a Bearer header for the gate. */
const bearer = (user: SessionUser) => ({ authorization: `Bearer ${makeApiKey(user)}` });

/** The properties of a decision as every key is given it: the OpenAPI document's Decision. */
const DECISION_KEYS = [
	'authorName', 'boardId', 'boardName', 'closedAt', 'closesAt', 'content', 'createdAt', 'currentVersion', 'deciderName', 'deciderUserId', 'id', 'openedAt',
	'resultsReleasedAt', 'shownStatus', 'status', 'supersedesId', 'title', 'untrusted', 'updatedAt', 'voteMode', 'withdrawnAt', 'withdrawnReason'
];

/** A draft on the board, its author and decider one board editor. */
function draftOf(author: SessionUser = editor('author')) {
	return { author, draft: makeDecision({ board, author, decider: author, title: 'A draft' }) };
}

const versionCount = (decisionId: number) => (sqlite.prepare('SELECT COUNT(*) AS n FROM decision_versions WHERE decision_id = ?').get(decisionId) as { n: number }).n;

describe('POST /api/v1/boards/{boardId}/decisions (9)', () => {
	it("makes a draft through a key: 201, the decision in the key's shape, its revision, and created through the API", async () => {
		const author = editor('author');
		const res = await withKey(author, 'POST', `/api/v1/boards/${board.id}/decisions`, { title: 'From an agent' });

		expect(res.status).toBe(201);
		expect(Object.keys(res.body).sort()).toEqual(['decision', 'revision']);
		expect(Object.keys(res.body.decision).sort()).toEqual(DECISION_KEYS);
		expect(res.body.decision.untrusted).toBe(true);
		expect(res.body.revision).toBe(revisionFor(res.body.decision.id));
		expect(eventsOf(res.body.decision.id)).toEqual([expect.objectContaining({ kind: 'created', source: 'api' })]);
	});
});

describe('GET /api/v1/decisions/{decisionId} (10)', () => {
	it("gives an administrator's key no participant's or picker person's address anywhere", async () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const { draft } = draftOf();
		const account = makeUser({ username: 'pat' });
		const pat = makePerson({ fullName: 'Pat Doe', email: 'pat.doe@example.test', user: account });
		makeParticipant(draft, { person: pat, role: 'consulted' });
		makePerson({ fullName: 'Sam Roe', email: 'sam.roe@example.test' });

		const res = await withKey(admin, 'GET', `/api/v1/decisions/${draft.id}`);

		expect(res.status).toBe(200);
		expect(res.body.participants).toHaveLength(1);
		expect(res.body.people.length).toBeGreaterThanOrEqual(2);
		expect(JSON.stringify(res.body)).not.toContain('@');
	});
});

describe('PATCH /api/v1/decisions/{decisionId} (11)', () => {
	it('(a) flags the section a key changed on a draft, removes its review stamp, and moves the revision', async () => {
		const { author, draft } = draftOf();
		db.update(decisions)
			.set({ workingContent: JSON.stringify({ situation: 'Old.', reviewed: { situation: { byUserId: author.id, byName: author.username, at: '2026-11-01 09:00:00' } } }) })
			.where(eq(decisions.id, draft.id))
			.run();
		const before = revisionNow(draft.id);

		const res = await withKey(author, 'PATCH', `/api/v1/decisions/${draft.id}`, { revision: before, content: { situation: 'Written by an agent.' } });

		expect(res.status).toBe(200);
		expect(res.body.decision.content.agentDrafted).toEqual({ situation: true });
		expect(res.body.decision.content.reviewed).toEqual({});
		expect(res.body.decision.untrusted).toBe(true);
		expect(res.body.revision).not.toBe(before);
		expect(res.body.revision).toBe(revisionNow(draft.id));
	});

	it('(b) flags a change to an open decision\'s content, publishes nothing and mails nobody', async () => {
		const { decision, author } = opened();
		withAccount(decision, 'pat');
		const events = eventsOf(decision.id);

		const res = await withKey(author, 'PATCH', `/api/v1/decisions/${decision.id}`, { revision: revisionNow(decision.id), content: { situation: 'Changed by an agent.' } });

		expect(res.status).toBe(200);
		expect(res.body.decision.content.agentDrafted).toMatchObject({ situation: true });
		expect(decisionRow(decision.id).currentVersion).toBe(1);
		expect(versionCount(decision.id)).toBe(1);
		expect(eventsOf(decision.id)).toEqual(events);
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it("(c) is not refused over an address changed on the page since the key's read, and is over a content save there (card 2706)", async () => {
		const { decision, author } = opened();
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const person = makePerson({ fullName: 'Pat Doe', email: 'pat.old@example.test' });
		const pat = makeParticipant(decision, { person, role: 'consulted' });
		db.update(people).set({ email: 'pat.new@example.test' }).where(eq(people.id, person.id)).run();
		const read = (await withKey(author, 'GET', `/api/v1/decisions/${decision.id}`)).body.revision as string;

		asSession(admin, (caller) => changeParticipantAddress(caller, { decisionId: decision.id, participantId: pat.id }, null, UI));
		const res = await withKey(author, 'PATCH', `/api/v1/decisions/${decision.id}`, { revision: read, content: { situation: 'Changed by an agent.' } });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const next = res.body.revision as string;
		asSession(author, (caller) => updateDraft(caller, { decisionId: decision.id }, { revision: next, content: { situation: 'Changed on the page.' } }, UI));
		const stale = await withKey(author, 'PATCH', `/api/v1/decisions/${decision.id}`, { revision: next, content: { situation: 'Changed by an agent again.' } });

		expect({ status: stale.status, message: stale.body.message }).toEqual({ status: 409, message: STALE_REVISION });
		expect(JSON.parse(decisionRow(decision.id).workingContent).situation).toBe('Changed on the page.');
	});
});

describe('PUT /api/v1/decisions/{decisionId}/decider (12)', () => {
	it('(a) names the decider of a draft, recorded through the API', async () => {
		const { author, draft } = draftOf();
		const other = editor('other');

		const res = await withKey(author, 'PUT', `/api/v1/decisions/${draft.id}/decider`, { deciderUserId: other.id, revision: revisionNow(draft.id) });

		expect(res.status).toBe(200);
		expect(res.body.decision.deciderUserId).toBe(other.id);
		expect(eventsOf(draft.id).at(-1)).toMatchObject({ kind: 'decider_changed', source: 'api' });
	});

	it('(b, c) refuses an open decision, and one opened and withdrawn, 403 OPENED_PEOPLE: the decider unchanged, no event', async () => {
		const other = editor('other');
		for (const status of ['open', 'withdrawn']) {
			const { decision, author } = opened({ status });
			const events = eventsOf(decision.id);

			const res = await withKey(author, 'PUT', `/api/v1/decisions/${decision.id}/decider`, { deciderUserId: other.id, revision: revisionNow(decision.id) });

			expect(res.status, status).toBe(403);
			expect(res.body).toEqual({ message: OPENED_PEOPLE });
			expect(decisionRow(decision.id).deciderUserId).toBe(decision.deciderUserId);
			expect(eventsOf(decision.id)).toEqual(events);
		}
	});
});

describe('PUT /api/v1/decisions/{decisionId}/participants (13)', () => {
	it("(a) sets a draft's participants through an administrator's key: no address or account in the answer, each marked, nobody mailed", async () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const { draft } = draftOf();
		const account = makeUser({ username: 'pat' });
		const pat = makePerson({ fullName: 'Pat Doe', email: 'pat.doe@example.test', user: account });

		const res = await withKey(admin, 'PUT', `/api/v1/decisions/${draft.id}/participants`, {
			participants: [{ personId: pat.id, role: 'consulted' }],
			revision: revisionNow(draft.id)
		});

		expect(res.status).toBe(200);
		expect(res.body.participants).toHaveLength(1);
		for (const participant of res.body.participants) {
			expect('email' in participant).toBe(false);
			expect('userId' in participant).toBe(false);
			expect(participant.untrusted).toBe(true);
		}
		expect(res.body.revision).toBe(revisionNow(draft.id));
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('(b) refuses an open decision, 403 OPENED_PEOPLE: no row added, no included event, nobody mailed', async () => {
		const { decision, author } = opened();
		const pat = makePerson({ fullName: 'Pat Doe' });
		const rows = count('decision_participants');

		const res = await withKey(author, 'PUT', `/api/v1/decisions/${decision.id}/participants`, {
			participants: [{ personId: pat.id, role: 'consulted' }],
			revision: revisionNow(decision.id)
		});

		expect(res.status).toBe(403);
		expect(res.body).toEqual({ message: OPENED_PEOPLE });
		expect(count('decision_participants')).toBe(rows);
		expect(kindsOf(decision.id)).not.toContain('included');
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});
});

describe('POST /api/v1/decisions/{decisionId}/extend, and no close (14)', () => {
	it("(a) extends an open decision by its decider's key: open, extended through the API, nobody mailed", async () => {
		const { decision, decider } = opened();
		withAccount(decision, 'pat');
		const later = daysAhead(120);

		const res = await withKey(decider, 'POST', `/api/v1/decisions/${decision.id}/extend`, { closesAt: sentAs(later) });

		expect(res.status).toBe(200);
		expect(res.body.decision).toMatchObject({ status: 'open', untrusted: true });
		expect(decisionRow(decision.id).closesAt).toBe(later);
		expect(eventsOf(decision.id).at(-1)).toMatchObject({ kind: 'extended', source: 'api' });
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('(b) refuses a time earlier than the current one, 400 EXTENDS_EARLIER', async () => {
		const { decision, decider } = opened();
		const res = await withKey(decider, 'POST', `/api/v1/decisions/${decision.id}/extend`, { closesAt: sentAs(daysAhead(30)) });
		expect(res.status).toBe(400);
		expect(res.body).toEqual({ message: EXTENDS_EARLIER });
		expect(decisionRow(decision.id).closesAt).toBe(FUTURE);
	});

	it('(d) refuses a decision closed for input, 403: reopening it is the page\'s (code review S2)', async () => {
		const { decision, decider } = opened({ status: 'closed' });
		const res = await withKey(decider, 'POST', `/api/v1/decisions/${decision.id}/extend`, { closesAt: sentAs(daysAhead(120)) });
		expect(res.status).toBe(403);
		expect(res.body).toEqual({ message: REOPEN_ACT });
		expect(decisionRow(decision.id)).toMatchObject({ status: 'closed', closesAt: FUTURE });
	});

	it('(c) has no close: through the gate with a real key, POST …/close is the router\'s 404 as JSON, and the decision stays open (D29)', async () => {
		const { decision, decider } = opened();

		const res = await gate('POST', `/api/v1/decisions/${decision.id}/close`, { headers: bearer(decider) });

		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toBe('application/json');
		expect(await res.json()).toEqual({ message: 'Not found' });
		expect(decisionRow(decision.id).status).toBe('open');
	});
});

describe('POST /api/v1/decisions/{decisionId}/withdraw (15)', () => {
	it('(a) withdraws a draft never opened, telling nobody', async () => {
		const { author, draft } = draftOf();
		const res = await withKey(author, 'POST', `/api/v1/decisions/${draft.id}/withdraw`, { reason: 'Not needed.' });
		expect(res.status).toBe(200);
		expect(res.body.decision).toMatchObject({ status: 'withdrawn', withdrawnReason: 'Not needed.', untrusted: true });
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('(b, c) refuses an open and a closed decision 403 OPENED_ACT, with the right password or a wrong one: no password is compared, nobody mailed', async () => {
		for (const [status, currentPassword] of [
			['open', FIXTURE_PASSWORD],
			['open', 'not the password'],
			['closed', FIXTURE_PASSWORD]
		]) {
			const { decision, author } = opened({ status });
			withAccount(decision, 'pat');

			const res = await withKey(author, 'POST', `/api/v1/decisions/${decision.id}/withdraw`, { reason: 'Not needed.', currentPassword });

			expect(res.status, `${status} ${currentPassword}`).toBe(403);
			expect(res.body).toEqual({ message: OPENED_ACT });
			expect(decisionRow(decision.id).status).toBe(status);
		}
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});
});

describe('DELETE /api/v1/decisions/{decisionId} (16)', () => {
	it('(a, b) deletes a draft, and a draft withdrawn without being opened', async () => {
		const { author, draft } = draftOf();
		const withdrawn = makeDecision({ board, author, decider: author, title: 'Withdrawn draft', status: 'withdrawn', withdrawnAt: '2026-11-02 09:00:00' });

		for (const id of [draft.id, withdrawn.id]) {
			const res = await withKey(author, 'DELETE', `/api/v1/decisions/${id}`);
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ success: true });
			expect(db.select().from(decisions).where(eq(decisions.id, id)).get()).toBeUndefined();
		}
	});

	it('(c) refuses a decision opened and withdrawn, 403 OPENED_ACT: its versions and events intact', async () => {
		const { decision, author } = opened({ status: 'withdrawn' });
		appendEvent({ decisionId: decision.id, kind: 'withdrawn', detail: { reason: 'Gone.' } }, SYSTEM_ACTOR);
		const events = eventsOf(decision.id);

		const res = await withKey(author, 'DELETE', `/api/v1/decisions/${decision.id}`);

		expect(res.status).toBe(403);
		expect(res.body).toEqual({ message: OPENED_ACT });
		expect(versionCount(decision.id)).toBe(1);
		expect(eventsOf(decision.id)).toEqual(events);
	});
});

describe('POST /api/v1/decisions/{decisionId}/supersede (17)', () => {
	it("makes a draft superseding a ruled decision by its decider's key, keeping its decider", async () => {
		const { decision, decider } = opened({ status: 'closed', closesAt: '2026-11-02 09:00:00' });
		makeRuling(decision, { ruledAt: stamp() });

		const res = await withKey(decider, 'POST', `/api/v1/decisions/${decision.id}/supersede`, {});

		expect(res.status).toBe(201);
		expect(res.body.decision).toMatchObject({ status: 'draft', supersedesId: decision.id, deciderUserId: decider.id, untrusted: true });
	});

	it("(b) makes it through the Product Owner's key the ruling recorded, keeping the old decider; (c) the caller decides once the old decider cannot edit the board (code review S4)", async () => {
		const productOwner = editor('po');
		sqlite.prepare('UPDATE boards SET product_owner_user_id = ? WHERE id = ?').run(productOwner.id, board.id);
		const kept = opened({ status: 'closed', closesAt: '2026-11-02 09:00:00' });
		makeRuling(kept.decision, { ruledAt: stamp() });
		const fallback = opened({ status: 'closed', closesAt: '2026-11-02 09:00:00' });
		makeRuling(fallback.decision, { ruledAt: stamp() });

		const res = await withKey(productOwner, 'POST', `/api/v1/decisions/${kept.decision.id}/supersede`, { title: 'Again' });
		expect(res.status).toBe(201);
		expect(res.body.decision).toMatchObject({ status: 'draft', supersedesId: kept.decision.id, authorName: productOwner.username, deciderUserId: kept.decider.id, untrusted: true });
		expect(eventsOf(res.body.decision.id)).toEqual([expect.objectContaining({ kind: 'created', source: 'api' })]);

		// The old decider loses edit access to the board: the draft's decider is the caller, never one the caller names.
		sqlite.prepare("UPDATE board_members SET role = 'viewer' WHERE board_id = ? AND user_id = ?").run(board.id, fallback.decider.id);
		const res2 = await withKey(productOwner, 'POST', `/api/v1/decisions/${fallback.decision.id}/supersede`, { deciderUserId: fallback.author.id });
		expect(res2.status).toBe(201);
		expect(res2.body.decision).toMatchObject({ supersedesId: fallback.decision.id, deciderUserId: productOwner.id, deciderName: productOwner.username });
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});
});

describe('GET /api/v1/decisions (18)', () => {
	it('(a) marks every row and the page', async () => {
		opened();
		const res = await withKey(owner, 'GET', '/api/v1/decisions?tab=all');
		expect(res.status).toBe(200);
		expect(res.body.untrusted).toBe(true);
		expect(res.body.rows.length).toBe(1);
		for (const row of res.body.rows) expect(row.untrusted).toBe(true);
	});

	it('(b) answers a malformed filter 400 naming it', async () => {
		const long = 'x'.repeat(201);
		const cases: [string, string][] = [
			['tab=nope', 'tab must be one of: waiting-response, waiting-ruling, open, ruled, all'],
			['board=x', 'Invalid board ID'],
			[`who=${long}`, 'who must be at most 100 characters'],
			[`q=${long}`, 'q must be at most 200 characters']
		];
		for (const [query, message] of cases) {
			const res = await withKey(owner, 'GET', `/api/v1/decisions?${query}`);
			expect(res.status, query).toBe(400);
			expect(res.body).toEqual({ message });
		}
	});
});

describe('through the gate, with a real Bearer key (19)', () => {
	it('(a) has no open: POST …/open is 404 as JSON, and the draft stays a draft (D3)', async () => {
		const ready = readyDraft({ board });
		const res = await gate('POST', `/api/v1/decisions/${ready.draft.id}/open`, { headers: bearer(ready.author), body: { revision: revisionNow(ready.draft.id) } });
		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toBe('application/json');
		expect(decisionRow(ready.draft.id).status).toBe('draft');
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('(b) refuses the participants of an open decision 403 OPENED_PEOPLE, with the credential the hook set', async () => {
		const { decision, author } = opened();
		const pat = makePerson({ fullName: 'Pat Doe' });
		const res = await gate('PUT', `/api/v1/decisions/${decision.id}/participants`, {
			headers: bearer(author),
			body: { participants: [{ personId: pat.id, role: 'consulted' }], revision: revisionNow(decision.id) }
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ message: OPENED_PEOPLE });
	});
});

describe('what no v1 route names (20)', () => {
	it("names none of the writes a key may never make, nor the page's reads and shapes, under src/routes/api/v1 (D19, D29)", () => {
		const NEVER = [
			'openDecision', 'republishDecision', 'dryRunDecision', 'resendInvitation', 'closeDecision', 'setParticipantAccount', 'participantAccountGuard',
			'changeParticipantAddress', 'participantAddressGuard', 'markReviewed', 'respondToDecision', 'respondByLink', 'recordSeen', 'recordSeenByLink',
			'decisionDeleteGuard', 'decisionWithdrawGuard', 'readPersonRecord', 'readEditPage', 'readDecisionPage', 'readResults', 'decisionAnswer',
			'participantAnswers', 'confirmStepUp', 'whilePasswordHolds'
		];
		const dir = join(process.cwd(), 'src/routes/api/v1');
		const files = (readdirSync(dir, { recursive: true }) as string[]).filter((path) => path.endsWith('.ts'));
		const found: string[] = [];
		for (const path of files) {
			const text = readFileSync(join(dir, path), 'utf8');
			for (const name of NEVER) if (new RegExp(`\\b${name}\\b`).test(text)) found.push(`${path}: ${name}`);
		}
		expect(found).toEqual([]);
		// 62 route files after slice 2b, this card's thirteen among them.
		expect(files.length).toBeGreaterThanOrEqual(62);
	});

	it("refuses a person's record read with any source but the page's, 403, before anything is read (code review S3)", () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const person = makePerson({ fullName: 'Pat Doe', email: 'pat.doe@example.test' });

		const asKeyWould = () => readPersonRecord(admin, person.id, { before: null }, { source: 'api' } as never);
		expect(outcome(asKeyWould)).toEqual({ status: 403, message: "A person's record is read on the decisions page: an API key cannot" });
		// An id that is no person is refused the same, not 404: the source is asked first.
		expect(outcome(() => readPersonRecord(admin, 999999, { before: null }, { source: 'api' } as never))).toMatchObject({ status: 403 });
		expect(readPersonRecord(admin, person.id, { before: null }, { source: 'ui' }).audience).toBe('admin');
	});
});

// ─── The routes of slice 2b, with a real key's credential (cases 21 to 26) ───

/**
 * An open decision of `opened()`'s, `pat` consulted on it through their
 * account, who has asked a question.
 */
function asked() {
	const made = opened();
	const pat = withAccount(made.decision, 'pat');
	const question = makeQuestion(made.decision, pat.participant, { question: 'What does A cost?' });
	return { ...made, pat, question };
}

describe('GET /api/v1/decisions/{decisionId}/questions (21)', () => {
	it("(a) shows the author's key an agent's draft, and nobody who asked or when, each question marked", async () => {
		const { decision, author, pat } = asked();
		makeQuestion(decision, pat.participant, { question: 'And B?', answer: 'An agent says 2,000.', by: author, role: 'author', agentDrafted: true });

		const res = await withKey(author, 'GET', `/api/v1/decisions/${decision.id}/questions`);

		expect(res.status).toBe(200);
		expect(res.body).toHaveLength(2);
		expect(res.body.find((q: Row) => q.question === 'And B?')).toMatchObject({ answer: null, draft: { text: 'An agent says 2,000.' }, untrusted: true });
		for (const question of res.body) expect(question.untrusted).toBe(true);
		const text = JSON.stringify(res.body);
		expect(text).not.toContain('askerName');
		expect(text).not.toContain('askedAt');
		expect(text).not.toContain(pat.participant.name);
	});

	it("(b) does not show the participant's key the draft: the question is still open to them", async () => {
		const { decision, author } = opened();
		const pat = withAccount(decision, 'pat');
		makeQuestion(decision, pat.participant, { question: 'What does A cost?', answer: 'An agent says 1,000.', by: author, role: 'author', agentDrafted: true });

		const res = await withKey(pat.account, 'GET', `/api/v1/decisions/${decision.id}/questions`);

		expect(res.status).toBe(200);
		expect(res.body).toEqual([expect.objectContaining({ question: 'What does A cost?', own: true, answer: null, untrusted: true })]);
		expect('draft' in res.body[0]).toBe(false);
		expect(JSON.stringify(res.body)).not.toContain('An agent says');
	});
});

describe('POST /api/v1/decisions/{decisionId}/questions (22)', () => {
	it("asks as the key's own participant row: no id, marked, recorded via api and through the API", async () => {
		const { decision } = opened();
		const pat = withAccount(decision, 'pat');

		const res = await withKey(pat.account, 'POST', `/api/v1/decisions/${decision.id}/questions`, { question: 'Why now?' });

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ question: { question: 'Why now?', askedInVersion: 1, untrusted: true } });
		expect(sqlite.prepare('SELECT via FROM decision_questions WHERE decision_id = ?').all(decision.id)).toEqual([{ via: 'api' }]);
		expect(eventsOf(decision.id).at(-1)).toMatchObject({ kind: 'question_asked', participantId: pat.participant.id, source: 'api' });
	});
});

describe('POST /api/v1/decisions/{decisionId}/questions/{questionId}/answer (23)', () => {
	it("(a) drafts the author's key's answer: awaiting review, the asker not mailed, marked", async () => {
		const { decision, author, question } = asked();

		const res = await withKey(author, 'POST', `/api/v1/decisions/${decision.id}/questions/${question.id}/answer`, { answer: 'About 1,000 a year.' });

		expect(res.status).toBe(200);
		expect(res.body.question).toMatchObject({ answer: null, draft: { text: 'About 1,000 a year.' }, untrusted: true });
		expect(eventsOf(decision.id).at(-1)).toMatchObject({
			kind: 'question_answered',
			source: 'api',
			detail: expect.objectContaining({ agentDrafted: true, notice: 'awaiting_review' })
		});
		await sent.settle();
		expect(sent.emails).toEqual([]);
	});

	it('(b) refuses replacesDraft, a person\'s act, 403 REPLACE_ACT: the draft stands', async () => {
		const { decision, author, question } = asked();
		await withKey(author, 'POST', `/api/v1/decisions/${decision.id}/questions/${question.id}/answer`, { answer: 'About 1,000 a year.' });
		const events = eventsOf(decision.id);

		const res = await withKey(author, 'POST', `/api/v1/decisions/${decision.id}/questions/${question.id}/answer`, { answer: 'A person says 900.', replacesDraft: true });

		expect(res.status).toBe(403);
		expect(res.body).toEqual({ message: REPLACE_ACT });
		expect(eventsOf(decision.id)).toEqual(events);
		expect(sqlite.prepare('SELECT answer FROM decision_questions WHERE id = ?').get(question.id)).toEqual({ answer: 'About 1,000 a year.' });
	});
});

describe('GET /api/v1/decisions/{decisionId}/summary (24)', () => {
	it("gives the decider's key the agent-answered question with no names, and nothing to rule or release by", async () => {
		const { decision, author, decider, question, pat } = asked();
		await withKey(author, 'POST', `/api/v1/decisions/${decision.id}/questions/${question.id}/answer`, { answer: 'About 1,000 a year.' });

		const res = await withKey(decider, 'GET', `/api/v1/decisions/${decision.id}/summary`);

		expect(res.status).toBe(200);
		expect(res.body.untrusted).toBe(true);
		expect(res.body.openQuestions).toEqual([{ question: 'What does A cost?', agentAnswered: true, untrusted: true }]);
		// Card 2727: rulesEarly is the results page's, as mayRule is.
		for (const key of ['revision', 'releasePreview', 'mayRule', 'rulesEarly', 'mayRelease', 'releaseRefusal', 'mayAnswerQuestions']) expect(key in res.body, key).toBe(false);
		expect(JSON.stringify(res.body.openQuestions)).not.toContain(pat.participant.name);
	});
});

describe('GET /api/v1/decisions/{decisionId}/record (25)', () => {
	function fiveEvents() {
		const made = asked();
		const actor = { userId: made.author.id, name: made.author.username, source: 'ui' as const };
		appendEvent({ decisionId: made.decision.id, kind: 'created' }, actor);
		appendEvent({ decisionId: made.decision.id, kind: 'included', participantId: made.pat.participant.id, detail: { role: 'consulted', hadAccount: true } }, actor);
		appendEvent({ decisionId: made.decision.id, kind: 'published', versionNumber: 1 }, actor);
		appendEvent(
			{ decisionId: made.decision.id, kind: 'question_asked', participantId: made.pat.participant.id, versionNumber: 1, detail: { questionId: made.question.id, notices: [] } },
			{ userId: made.pat.account.id, name: made.pat.account.username, source: 'api' }
		);
		appendEvent({ decisionId: made.decision.id, kind: 'seen', participantId: made.pat.participant.id, versionNumber: 1, detail: { stage: 'question' } }, actor);
		return made;
	}

	it("(a, b) pages by limit and after: two entries and next, then every event with no limit", async () => {
		const { decision, decider } = fiveEvents();

		const first = await withKey(decider, 'GET', `/api/v1/decisions/${decision.id}/record?limit=2`);
		expect(first.status).toBe(200);
		expect(first.body.entries.map((entry: Row) => entry.kind)).toEqual(['created', 'included']);
		expect(first.body.next).toEqual(expect.any(Number));
		expect(first.body.untrusted).toBe(true);
		// The question event is left out in the query (code review S1), so the second page of two is the last.
		const rest = await withKey(decider, 'GET', `/api/v1/decisions/${decision.id}/record?limit=2&after=${first.body.next}`);
		expect(rest.body.entries.map((entry: Row) => entry.kind)).toEqual(['published', 'seen']);
		expect(rest.body.next).toBeNull();

		const all = await withKey(decider, 'GET', `/api/v1/decisions/${decision.id}/record`);
		expect(all.body.entries).toHaveLength(4);
		expect(all.body.next).toBeNull();
	});

	it('(c) answers a malformed limit, participant or after 400 naming it', async () => {
		const { decision, decider } = fiveEvents();
		const cases: [string, string][] = [
			['limit=0', 'limit must be a whole number from 1 to 5000'],
			['limit=5001', 'limit must be a whole number from 1 to 5000'],
			['limit=x', 'limit must be a whole number from 1 to 5000'],
			['limit=1.5', 'limit must be a whole number from 1 to 5000'],
			['participant=x', 'Invalid participant ID'],
			['after=0', 'after must be a whole number of 1 or more']
		];
		for (const [query, message] of cases) {
			const res = await withKey(decider, 'GET', `/api/v1/decisions/${decision.id}/record?${query}`);
			expect(res.status, query).toBe(400);
			expect(res.body).toEqual({ message });
		}
	});

	it('(d) leaves every question event out, one asked by personal link among them, filtered or not (code review S1, S4)', async () => {
		const { decision, decider, pat } = fiveEvents();
		const linky = withLink(decision, 'link-token-25');
		appendEvent(
			{ decisionId: decision.id, kind: 'question_asked', participantId: linky.participant.id, versionNumber: 1, detail: { questionId: 1, notices: [] } },
			{ userId: null, name: linky.participant.name, source: 'link' }
		);

		const all = await withKey(decider, 'GET', `/api/v1/decisions/${decision.id}/record`);
		expect(all.status).toBe(200);
		expect(all.body.entries.map((entry: Row) => entry.kind)).toEqual(['created', 'included', 'published', 'seen']);
		expect(JSON.stringify(all.body.entries)).not.toContain(pat.account.username);
		expect(JSON.stringify(all.body.entries)).not.toContain(linky.participant.name);

		for (const asker of [pat.participant.id, linky.participant.id]) {
			const filtered = await withKey(decider, 'GET', `/api/v1/decisions/${decision.id}/record?participant=${asker}`);
			expect(filtered.status).toBe(200);
			expect(filtered.body.entries.map((entry: Row) => entry.kind)).toEqual(asker === pat.participant.id ? ['included', 'seen'] : []);
		}
	});

	it("(e) answers a participant row of another decision 404 under a key, as one that is not there (code review S4)", async () => {
		const { decision, decider } = fiveEvents();
		const other = opened();
		const elsewhere = withAccount(other.decision, 'elsewhere');

		const res = await withKey(decider, 'GET', `/api/v1/decisions/${decision.id}/record?participant=${elsewhere.participant.id}`);
		expect(res.status).toBe(404);
		expect(res.body).toEqual({ message: 'Participant not found' });
	});
});

describe('PUT and DELETE /api/v1/decisions/{decisionId}/cards/{cardId} (26)', () => {
	it('(a) links a card through a key, then finds it linked; (b) unlinks it: each on the card\'s board through the API', async () => {
		const { decision, author } = opened();
		const card = makeCard(cols['To Do']);
		const before = activityRows().length;

		const linked = await withKey(author, 'PUT', `/api/v1/decisions/${decision.id}/cards/${card.id}`);
		expect(linked.status).toBe(200);
		expect(linked.body).toEqual({ outcome: 'linked', linkedCards: [expect.objectContaining({ id: card.id, boardId: board.id, archived: false })] });
		const again = await withKey(author, 'PUT', `/api/v1/decisions/${decision.id}/cards/${card.id}`);
		expect(again.body.outcome).toBe('unchanged');
		expect(activityRows().slice(before)).toEqual([{ boardId: board.id, action: 'api:decision_card_linked', source: 'api' }]);

		const unlinked = await withKey(author, 'DELETE', `/api/v1/decisions/${decision.id}/cards/${card.id}`);
		expect(unlinked.status).toBe(200);
		expect(unlinked.body).toEqual({ linkedCards: [] });
		expect(activityRows().slice(before + 1)).toEqual([{ boardId: board.id, action: 'api:decision_card_unlinked', source: 'api' }]);
	});
});

// ─── 27. A title, participants or decider chosen through a key (card 2728) ───

/** The decision's agent flags and review stamps, as the server reads them. */
const flags = (id: number) => parseWorkingContent(decisionRow(id).workingContent).agentDrafted;
const stamps = (id: number) => parseWorkingContent(decisionRow(id).workingContent).reviewed;
/** The editor's agent warnings for the three chosen keys, as `[key, words]`. */
const chosenWarnings = (id: number) =>
	readinessOf(decisionRow(id))
		.warnings.filter((warning) => warning.code === 'agent_drafted' && ['title', 'participants', 'decider'].includes(warning.key ?? ''))
		.map((warning) => [warning.key, warning.words]);
const CHOSE = (what: string) => `${what} chosen by an agent and not yet reviewed by a person`;

describe('a title, participants or decider chosen through a key is flagged until a person reviews it (27, card 2728)', () => {
	it("2728-1 flags the title of a draft a key made, gives the flag in the key's answer, and warns of it in the editor; a person's draft has none", async () => {
		const author = editor('author');

		const res = await withKey(author, 'POST', `/api/v1/boards/${board.id}/decisions`, { title: 'From an agent' });

		expect(res.status).toBe(201);
		expect(res.body.decision.content.agentDrafted).toEqual({ title: true });
		expect(chosenWarnings(res.body.decision.id)).toEqual([['title', CHOSE('The title was')]]);
		const mine = asSession(author, (caller) => createDecision(caller, { boardId: board.id }, { title: 'From a person' }, UI));
		expect(decisionRow(mine.id).workingContent).toBe('{}');
	});

	it("2728-2 flags a draft's title a key changed, removing its stamp and keeping the content as stored; the same title flags nothing", async () => {
		const { author, draft } = draftOf();
		const stamp0 = { byUserId: author.id, byName: author.username, at: '2026-11-01 09:00:00' };
		db.update(decisions)
			.set({ workingContent: JSON.stringify({ situation: 'Old.', reviewed: { title: stamp0 } }) })
			.where(eq(decisions.id, draft.id))
			.run();

		const same = await withKey(author, 'PATCH', `/api/v1/decisions/${draft.id}`, { revision: revisionNow(draft.id), title: 'A draft' });
		expect(same.status).toBe(200);
		expect(flags(draft.id)).toEqual({});

		const res = await withKey(author, 'PATCH', `/api/v1/decisions/${draft.id}`, { revision: revisionNow(draft.id), title: 'Chosen by an agent' });
		expect(res.status).toBe(200);
		expect(res.body.decision).toMatchObject({ title: 'Chosen by an agent', content: { agentDrafted: { title: true }, reviewed: {} } });
		expect(JSON.parse(decisionRow(draft.id).workingContent)).toEqual({ situation: 'Old.', agentDrafted: { title: true }, reviewed: {} });
		expect(res.body.revision).toBe(revisionNow(draft.id));
		expect(res.body.readiness.warnings).toContainEqual({ code: 'agent_drafted', key: 'title', words: CHOSE('The title was') });

		// With content: the title's flag beside the changed section's, and the title's stamp removed.
		const other = draftOf(author).draft;
		db.update(decisions)
			.set({ workingContent: JSON.stringify({ reviewed: { title: stamp0 } }) })
			.where(eq(decisions.id, other.id))
			.run();
		expect(stamps(other.id)).toEqual({ title: stamp0 });
		const withContent = await withKey(author, 'PATCH', `/api/v1/decisions/${other.id}`, {
			revision: revisionNow(other.id),
			title: 'Also an agent',
			content: { situation: 'New.' }
		});
		expect(withContent.status).toBe(200);
		expect(flags(other.id)).toEqual({ situation: true, title: true });
		expect(stamps(other.id)).toEqual({});
	});

	it('2728-3 flags a decider a key named, removing its stamp; naming the same one flags nothing', async () => {
		const { author, draft } = draftOf();
		db.update(decisions)
			.set({ workingContent: JSON.stringify({ reviewed: { decider: { byUserId: author.id, byName: author.username, at: '2026-11-01 09:00:00' } } }) })
			.where(eq(decisions.id, draft.id))
			.run();

		const same = await withKey(author, 'PUT', `/api/v1/decisions/${draft.id}/decider`, { deciderUserId: author.id, revision: revisionNow(draft.id) });
		expect(same.status).toBe(200);
		expect(flags(draft.id)).toEqual({});

		const other = editor('other');
		const res = await withKey(author, 'PUT', `/api/v1/decisions/${draft.id}/decider`, { deciderUserId: other.id, revision: revisionNow(draft.id) });
		expect(res.status).toBe(200);
		expect(res.body.decision.content.agentDrafted).toEqual({ decider: true });
		expect(stamps(draft.id)).toEqual({});
		expect(res.body.revision).toBe(revisionNow(draft.id));
		expect(chosenWarnings(draft.id)).toEqual([['decider', CHOSE('The decider was')]]);
	});

	it('2728-4 flags the participants when a key adds, re-roles or removes anyone, each cleared by Mark reviewed; the same set flags nothing', async () => {
		const { author, draft } = draftOf();
		const pat = makePerson({ fullName: 'Pat Doe' });
		const sam = makePerson({ fullName: 'Sam Roe' });
		const put = (participants: { personId: number; role: string }[]) =>
			withKey(author, 'PUT', `/api/v1/decisions/${draft.id}/participants`, { participants, revision: revisionNow(draft.id) });
		const review = () => asSession(author, (caller) => markReviewed(caller, { decisionId: draft.id }, { sections: ['participants'], revision: revisionNow(draft.id) }, UI));

		expect((await put([])).status).toBe(200);
		expect(flags(draft.id)).toEqual({});

		const changes: [string, { personId: number; role: string }[]][] = [
			['added', [{ personId: pat.id, role: 'consulted' }, { personId: sam.id, role: 'informed' }]],
			['re-roled', [{ personId: pat.id, role: 'informed' }, { personId: sam.id, role: 'informed' }]],
			['removed', [{ personId: pat.id, role: 'informed' }]]
		];
		for (const [change, participants] of changes) {
			const res = await put(participants);
			expect(res.status, change).toBe(200);
			expect(flags(draft.id), change).toEqual({ participants: true });
			expect(stamps(draft.id), change).toEqual({});
			expect(chosenWarnings(draft.id), change).toEqual([['participants', CHOSE('The participants were')]]);
			review();
			expect(flags(draft.id), change).toEqual({});
			expect(stamps(draft.id).participants, change).toMatchObject({ byUserId: author.id });
		}

		// The same set again: nothing flagged, the stamp kept.
		expect((await put([{ personId: pat.id, role: 'informed' }])).status).toBe(200);
		expect(flags(draft.id)).toEqual({});
		expect(stamps(draft.id)).toHaveProperty('participants');
	});

	it("2728-5 sets no flag for a person's change of the title, decider or participants, and clears none", () => {
		const { author, draft } = draftOf();
		const other = editor('other');
		const pat = makePerson({ fullName: 'Pat Doe' });
		const byPerson = (title: string, deciderUserId: number, participants: { personId: number; role: string }[]) => {
			asSession(author, (caller) => updateDraft(caller, { decisionId: draft.id }, { revision: revisionNow(draft.id), title }, UI));
			asSession(author, (caller) => setDecider(caller, { decisionId: draft.id }, { deciderUserId, revision: revisionNow(draft.id) }, UI));
			asSession(author, (caller) => setParticipants(caller, { decisionId: draft.id }, { participants, revision: revisionNow(draft.id) }, UI));
		};

		byPerson('By a person', other.id, [{ personId: pat.id, role: 'consulted' }]);
		expect(flags(draft.id)).toEqual({});

		asKey(author, (caller) => updateDraft(caller, { decisionId: draft.id }, { revision: revisionNow(draft.id), title: 'By an agent' }, API));
		asKey(author, (caller) => setDecider(caller, { decisionId: draft.id }, { deciderUserId: author.id, revision: revisionNow(draft.id) }, API));
		asKey(author, (caller) => setParticipants(caller, { decisionId: draft.id }, { participants: [], revision: revisionNow(draft.id) }, API));
		expect(flags(draft.id)).toEqual({ title: true, decider: true, participants: true });

		byPerson('By a person again', other.id, [{ personId: pat.id, role: 'informed' }]);
		expect(decisionRow(draft.id)).toMatchObject({ title: 'By a person again', deciderUserId: other.id });
		expect(flags(draft.id)).toEqual({ title: true, decider: true, participants: true });
	});

	it("2728-6 clears ['title'] alone for a person, then 'all' the rest, stamping each; a key's Mark reviewed is 403 with nothing written", () => {
		const { author, draft } = draftOf();
		const other = editor('other');
		const pat = makePerson({ fullName: 'Pat Doe' });
		asKey(author, (caller) => updateDraft(caller, { decisionId: draft.id }, { revision: revisionNow(draft.id), title: 'By an agent' }, API));
		asKey(author, (caller) => setDecider(caller, { decisionId: draft.id }, { deciderUserId: other.id, revision: revisionNow(draft.id) }, API));
		asKey(author, (caller) => setParticipants(caller, { decisionId: draft.id }, { participants: [{ personId: pat.id, role: 'consulted' }], revision: revisionNow(draft.id) }, API));
		expect(chosenWarnings(draft.id)).toEqual([
			['title', CHOSE('The title was')],
			['participants', CHOSE('The participants were')],
			['decider', CHOSE('The decider was')]
		]);
		const before = decisionRow(draft.id);
		const review = (sections: string[] | 'all', through: typeof asKey) =>
			through(author, (caller) => markReviewed(caller, { decisionId: draft.id }, { sections, revision: revisionNow(draft.id) }, UI));

		expect(outcome(() => review(['title'], asKey))).toEqual({ status: 403, message: REVIEW_ACT });
		expect(decisionRow(draft.id)).toEqual(before);

		const revision = revisionNow(draft.id);
		review(['title'], asSession);
		expect(flags(draft.id)).toEqual({ participants: true, decider: true });
		expect(stamps(draft.id).title).toMatchObject({ byUserId: author.id, byName: author.username });
		expect(revisionNow(draft.id)).not.toBe(revision);

		review('all', asSession);
		expect(flags(draft.id)).toEqual({});
		expect(Object.keys(stamps(draft.id)).sort()).toEqual(['decider', 'participants', 'title']);
		expect(chosenWarnings(draft.id)).toEqual([]);
	});

	it("2728-7 flags a new title a key gives a superseding draft; the version's participants and decider flags are not carried, its title flag only with the old title", () => {
		const ruled = () => {
			const made = opened({ status: 'closed', closesAt: '2026-11-02 09:00:00' });
			makeRuling(made.decision, { ruledAt: stamp() });
			sqlite
				.prepare("UPDATE decision_versions SET content = json_set(content, '$.agentDrafted', json(?)) WHERE decision_id = ?")
				.run(JSON.stringify({ situation: true, title: true, participants: true, decider: true }), made.decision.id);
			return made;
		};
		const supersede = (body: Record<string, unknown>, opts: ServiceOptions) => {
			const { decision, decider } = ruled();
			return (opts === API ? asKey : asSession)(decider, (caller) => supersedeDecision(caller, { decisionId: decision.id }, body, opts)).id;
		};

		expect(flags(supersede({}, API))).toEqual({ situation: true, title: true });
		expect(flags(supersede({}, UI))).toEqual({ situation: true, title: true });
		expect(flags(supersede({ title: 'Again, by an agent' }, API))).toEqual({ situation: true, title: true });
		expect(flags(supersede({ title: 'Again, by a person' }, UI))).toEqual({ situation: true });
	});

	it('2728-8 publishes the three flags and their stamps in the version, and hands none of them to a participant page or the preview', () => {
		const ready = readyDraft({ board });
		const stamped = { byUserId: ready.author.id, byName: ready.author.username, at: '2026-11-05 09:00:00' };
		db.update(decisions)
			.set({ workingContent: JSON.stringify({ ...ready.working, agentDrafted: { situation: true, title: true, decider: true }, reviewed: { question: stamped, participants: stamped } }) })
			.where(eq(decisions.id, ready.draft.id))
			.run();
		const working = parseWorkingContent(decisionRow(ready.draft.id).workingContent);

		asSession(ready.author, (caller) => openDecision(caller, { decisionId: ready.draft.id }, { revision: revisionNow(ready.draft.id) }, UI));

		const row = sqlite.prepare('SELECT content FROM decision_versions WHERE decision_id = ? AND number = 1').get(ready.draft.id) as { content: string };
		const version = parseVersionContent(row.content);
		expect(version.agentDrafted).toEqual({ situation: true, title: true, decider: true });
		expect(version.reviewed).toEqual({ question: { byName: stamped.byName, at: stamped.at }, participants: { byName: stamped.byName, at: stamped.at } });
		for (const answer of [versionContentAnswer(version, 'session'), workingViewContent(working)]) {
			expect(answer.agentDrafted).toEqual({ situation: true });
			expect(answer.reviewed).toEqual({ question: true });
		}
		expect(versionContentAnswer(version, 'link').agentDrafted).toEqual({ situation: true });
	});
});
