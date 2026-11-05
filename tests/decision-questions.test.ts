/**
 * A decision's clarification questions and their answers (card 2678): the
 * one projection of a question for every viewer and both sources, and the
 * rules of who may ask and answer now (`src/lib/server/decision-questions.ts`);
 * the open questions and the results revision (`decision-results.ts`); and the
 * question row's insert and its three guarded updates
 * (`decision-record.ts`). From slice 1b, the four writes and their two
 * notices (`decision-question-writes.ts`, since card 2713, and
 * `notifications.ts`); from slice 1c, what the pages
 * read of them (`decision-view.ts`); from slice 2b, the four routes' first
 * statements and the link route's wrong-link counter, through the gate.
 *
 * The cases are the plan's, `docs/planning/card-2678-clarification-questions.md`,
 * section 7.1, by number. The insert-only scan's settled-once table is
 * tests/decision-record.test.ts's (case 32).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Case 20 (S3): each of the question row's three guarded updates made to
 * report that it changed nothing, as a race with another tab would leave it,
 * by a pass-through of the record module that the switch turns off for one
 * update at a time. Switched, the real update still runs first (code review
 * F7), so the 409 must roll back a change the write made. Off, every
 * function is the real one.
 */
const stub = vi.hoisted(() => ({ noChange: null as null | 'recordAnswer' | 'recordDraftPublished' | 'recordDraftReplaced' }));

vi.mock('$lib/server/decision-record', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/decision-record')>();
	// Code review F7: switched, the real update still runs and its change is made, then reported as none, so the rollback of partial work is what the case holds.
	const noChange = (update: () => boolean) => {
		update();
		return false;
	};
	return {
		...real,
		recordAnswer: (...args: Parameters<typeof real.recordAnswer>) =>
			stub.noChange === 'recordAnswer' ? noChange(() => real.recordAnswer(...args)) : real.recordAnswer(...args),
		recordDraftPublished: (...args: Parameters<typeof real.recordDraftPublished>) =>
			stub.noChange === 'recordDraftPublished' ? noChange(() => real.recordDraftPublished(...args)) : real.recordDraftPublished(...args),
		recordDraftReplaced: (...args: Parameters<typeof real.recordDraftReplaced>) =>
			stub.noChange === 'recordDraftReplaced' ? noChange(() => real.recordDraftReplaced(...args)) : real.recordDraftReplaced(...args)
	};
});

/**
 * Code review S4: every live event asked for, through a pass-through of
 * `emit` that records each call, so that a write asking for one is caught
 * even where the event would be dropped before delivery.
 */
vi.mock('$lib/server/events', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/events')>();
	return { ...real, emit: vi.fn(real.emit) };
});

import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { decisionParticipants, decisionQuestions, decisions, people, settings, users, type Board, type Decision } from '$lib/server/db/schema';
import { decisionAccess } from '$lib/server/decision-access';
import { actorFor, appendEvent, appendQuestion, recordAnswer, recordDraftPublished, recordDraftReplaced, SYSTEM_ACTOR } from '$lib/server/decision-record';
import { revokeLinks } from '$lib/server/decision-links';
import { answererRoleOf, pendingDraft, questionsFor, readQuestions, type QuestionViewer } from '$lib/server/decision-questions';
import { openQuestionsOf, readResults, resultsRevisionFor, rulingRefusals } from '$lib/server/decision-results';
import { answerQuestion, askQuestion, askQuestionByLink, publishAnswer } from '$lib/server/decision-question-writes';
import { ruleDecision } from '$lib/server/decision-ruling-writes';
import { readDecisionPage, readLinkPage } from '$lib/server/decision-view';
import { emit } from '$lib/server/events';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { writeAs, type ServiceOptions } from '$lib/server/write-as';
import {
	ALREADY_PUBLISHED,
	ANSWERED,
	ASK_FOR_LINK_LINE,
	DEAD_DECISION_LINK,
	DRAFT_PENDING,
	LATEST_LINK_LINE,
	NO_DRAFT,
	NO_LONGER_REACHED,
	NOTHING_TO_PUBLISH,
	PERSON_ANSWERED,
	QUESTIONS_CLOSED,
	questionsLimitWords,
	tooManyWrongLinks
} from '$lib/decision-words';
import { parseStamp, stamp } from '$lib/timestamps';
import { pageLoad } from './helpers/actions';
import { effects, type Effects } from './helpers/effects';
import {
	addBoardMember,
	linkHashOf,
	makeBoard,
	makeDecision,
	makeOption,
	makeParticipant,
	makePerson,
	makeQuestion,
	makeRuling,
	makeSession,
	makeSmtp,
	makeUser,
	makeVersion,
	NEVER_GIVEN,
	resetDb
} from './helpers/fixtures';
import { gate, gateRoutes } from './helpers/gate';

const APP = 'https://kanban.example.test';
const FUTURE = '2099-01-01 12:00:00';
/** A closing time that has passed: a closed decision is awaiting a ruling. */
const PAST = '2026-11-02 09:00:00';

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

/** Every live event asked for since the test began (code review S4). */
const emitted = vi.mocked(emit);

afterEach(() => {
	stub.noChange = null;
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
 * A decision on the board opened as version 1 with options A and B, open
 * until far ahead unless told otherwise: its author and its decider two
 * accounts (one with `sameAccount`), each able to edit the board.
 */
function opened(opts: { status?: string; closesAt?: string | null; sameAccount?: boolean } = {}) {
	const author = makeUser({ username: `author${++seq}` });
	const decider = opts.sameAccount ? author : makeUser({ username: `decider${++seq}` });
	addBoardMember(board, author, 'editor');
	if (decider !== author) addBoardMember(board, decider, 'editor');
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
	return { decision: decisionRow(made.id), author, decider, a, b };
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
 * The participant's invitation, as `queueRecordMails` writes it, and its
 * delivery's outcome: delivered, refused, or (undefined) not yet known (card
 * 2721).
 */
function invited(decision: Decision, participantId: number, delivered?: boolean) {
	const of = appendEvent({ decisionId: decision.id, kind: 'invited', participantId, versionNumber: 1 }, SYSTEM_ACTOR);
	if (delivered === undefined) return;
	const detail = { of, mail: 'invitation', delivered, ...(delivered ? {} : { problem: 'refused' }) };
	appendEvent({ decisionId: decision.id, kind: 'mail_outcome', participantId, detail }, SYSTEM_ACTOR);
}

/** A signed-in account as `questionsFor` is handed it: its access, and its own participant row. */
function viewerOf(user: SessionUser, decision: Decision, source: 'ui' | 'api' = 'ui'): QuestionViewer {
	const access = decisionAccess(user, decision);
	return { access, participantId: access.participantId, source };
}

/** The account loses edit access to the board: a reader of it from now on. */
const demote = (user: SessionUser) => sqlite.prepare("UPDATE board_members SET role = 'viewer' WHERE board_id = ? AND user_id = ?").run(board.id, user.id);

/** Each row's layers laid over the row of `base` at its index. */
const layered = <T extends object>(base: T[], ...layers: object[][]) => base.map((row, index) => Object.assign({}, row, ...layers.map((layer) => layer[index] ?? {})));

// ─── Reads and the row (slice 1a) ────────────────────────────────────────────

describe('questionsFor and readQuestions', () => {
	it('gives each viewer what decision 2 gives them, one row each (1)', () => {
		const { decision, author, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const quin = withAccount(decision, 'quin');
		const lia = withLink(decision, 'token-q1');
		const gone = withAccount(decision, 'gone');
		const admin = makeUser({ role: 'admin', username: 'admin' });
		const reader = makeUser({ username: 'reader' });
		addBoardMember(board, reader, 'viewer');

		const q1 = makeQuestion(decision, pat.participant, { question: 'What does B cost?', answer: 'About 10k.', by: author, role: 'author' });
		const q2 = makeQuestion(decision, quin.participant, {
			question: 'Why not C?',
			via: 'api',
			askedAt: '2026-11-02 10:01:00',
			answer: 'C was ruled out.',
			by: decider,
			agentDrafted: true,
			published: decider
		});
		const q3 = makeQuestion(decision, pat.participant, {
			question: 'When?',
			via: 'api',
			askedAt: '2026-11-02 10:05:00',
			answer: 'In March.',
			by: decider,
			agentDrafted: true,
			answeredAt: '2026-11-02 11:30:00'
		});
		const q4 = makeQuestion(decision, lia.participant, { question: 'Who pays?', via: 'link', askedAt: '2026-11-02 10:10:00' });
		db.update(people).set({ status: 'left', leftAt: PAST }).where(eq(people.id, gone.person.id)).run();

		const base = [
			{
				question: 'What does B cost?',
				askedInVersion: 1,
				own: false,
				answer: { text: 'About 10k.', answererName: author.username, answererRole: 'author', answeredAt: '2026-11-02 11:00:00', agentDrafted: false },
				closedUnanswered: null
			},
			{
				question: 'Why not C?',
				askedInVersion: 1,
				own: false,
				// A published draft: its moment is the publishing, and no reviewer is named.
				answer: { text: 'C was ruled out.', answererName: decider.username, answererRole: 'decider', answeredAt: '2026-11-02 12:00:00', agentDrafted: true },
				closedUnanswered: null
			},
			// An agent's draft no person has published: open to everyone but the privileged.
			{ question: 'When?', askedInVersion: 1, own: false, answer: null, closedUnanswered: null },
			{ question: 'Who pays?', askedInVersion: 1, own: false, answer: null, closedUnanswered: null }
		];
		const draft = { text: 'In March.', drafterName: decider.username, draftedAt: '2026-11-02 11:30:00' };
		const named = [
			{ askerName: pat.participant.name, askedAt: q1.askedAt },
			{ askerName: quin.participant.name, askedAt: q2.askedAt, askedByAgent: true },
			{ askerName: pat.participant.name, askedAt: q3.askedAt, askedByAgent: true, draft },
			{ askerName: lia.participant.name, askedAt: q4.askedAt }
		];
		const ids = [q1, q2, q3, q4].map((q) => ({ id: q.id }));

		// (a) A participant: every question, their own marked with its moment, "asked by an agent" on their own alone, no draft, no id.
		const forPat = layered(base, [{ own: true, askedAt: q1.askedAt }, {}, { own: true, askedAt: q3.askedAt, askedByAgent: true }]);
		expect(readQuestions(pat.account, decision.id, { source: 'ui' }), '(a)').toEqual(forPat);
		expect(questionsFor(decision, viewerOf(pat.account, decision)), '(a)').toEqual(forPat);
		const patJson = JSON.stringify(readQuestions(pat.account, decision.id, { source: 'ui' }));
		for (const absent of ['In March.', quin.participant.name, lia.participant.name, '"id"', '"draft"', '"askerName"']) expect(patJson, `(a) ${absent}`).not.toContain(absent);

		// (b) A link holder: the same, by their own link.
		expect(questionsFor(decision, { access: null, participantId: lia.participant.id, source: 'ui' }), '(b)').toEqual(
			layered(base, [{}, {}, {}, { own: true, askedAt: q4.askedAt }])
		);

		// (c) The decider and (d) the author: names, moments, ids, "asked by an agent" and the draft.
		expect(readQuestions(decider, decision.id, { source: 'ui' }), '(c)').toEqual(layered(base, ids, named));
		expect(readQuestions(author, decision.id, { source: 'ui' }), '(d)').toEqual(layered(base, ids, named));

		// (e) An administrator who is not the author: names, moments and the draft, and no ids.
		expect(readQuestions(admin, decision.id, { source: 'ui' }), '(e)').toEqual(layered(base, named));

		// (f) A board reader who is none of these: nothing.
		expect(questionsFor(decision, viewerOf(reader, decision)), '(f)').toEqual([]);
		expect(outcome(() => readQuestions(reader, decision.id, { source: 'ui' })), '(f)').toEqual({ status: 403, message: 'You cannot read the questions on this decision' });

		// (i) A participant reachOf no longer reaches (F2): nothing from the projection, a 403 from the read.
		expect(questionsFor(decision, viewerOf(gone.account, decision)), '(i)').toEqual([]);
		expect(outcome(() => readQuestions(gone.account, decision.id, { source: 'ui' })), '(i)').toEqual({ status: 403, message: NO_LONGER_REACHED });

		// (j) Through an API key (S2): no name and no moment on any, the ids, the draft and "asked by an agent" kept, every item untrusted.
		const forApi = layered(base, ids, [{}, { askedByAgent: true }, { askedByAgent: true, draft }, {}], base.map(() => ({ untrusted: true })));
		expect(readQuestions(decider, decision.id, { source: 'api' }), '(j)').toEqual(forApi);
		expect(JSON.stringify(readQuestions(decider, decision.id, { source: 'api' })), '(j)').not.toMatch(/"(askerName|askedAt)"/);

		// (g) An author who has lost board edit: nothing.
		demote(author);
		expect(questionsFor(decisionRow(decision.id), viewerOf(author, decision)), '(g)').toEqual([]);
		expect(outcome(() => readQuestions(author, decision.id, { source: 'ui' })), '(g)').toEqual({ status: 403, message: 'You cannot read the questions on this decision' });

		// (h) A decider who has lost board edit (S11): nothing, so no id and no name.
		demote(decider);
		expect(questionsFor(decisionRow(decision.id), viewerOf(decider, decision)), '(h)').toEqual([]);
		expect(outcome(() => readQuestions(decider, decision.id, { source: 'ui' })), '(h)').toEqual({ status: 403, message: 'You cannot read the questions on this decision' });
	});

	it('gives each answer its shape, the role from its event, one row each (2)', () => {
		const { decision, author, decider } = opened();
		const pat = withAccount(decision, 'pat');

		const person = makeQuestion(decision, pat.participant, { question: 'A person?', answer: 'Yes.', by: author, role: 'author' });
		makeQuestion(decision, pat.participant, {
			question: 'A published draft?',
			answer: 'Drafted.',
			by: decider,
			agentDrafted: true,
			published: author,
			reviewedAt: '2026-11-02 12:30:00'
		});
		const replaced = makeQuestion(decision, pat.participant, { question: 'A replaced draft?' });
		recordAnswer(replaced.id, 'An agent wrote this.', actorFor(decider, 'api'), true);
		appendEvent(
			{ decisionId: decision.id, kind: 'question_answered', detail: { questionId: replaced.id, role: 'decider', agentDrafted: true, notice: 'awaiting_review' } },
			actorFor(decider, 'api')
		);
		recordDraftReplaced(replaced.id, 'A person wrote this.', actorFor(author, 'ui'));
		appendEvent(
			{
				decisionId: decision.id,
				kind: 'answer_replaced',
				detail: { questionId: replaced.id, role: 'author', discarded: { text: 'An agent wrote this.', byName: decider.username, at: PAST }, notice: 'asked' }
			},
			actorFor(author, 'ui')
		);
		const answers = () => readQuestions(decider, decision.id, { source: 'ui' }).map((view) => view.answer);

		const [a, b, c] = answers();
		// (a) A person's: no label, named with the role they answered in.
		expect(a, '(a)').toEqual({ text: 'Yes.', answererName: author.username, answererRole: 'author', answeredAt: '2026-11-02 11:00:00', agentDrafted: false });
		// (b) A published draft: labelled, the publishing moment, and the publisher named nowhere.
		expect(b, '(b)').toEqual({ text: 'Drafted.', answererName: decider.username, answererRole: 'decider', answeredAt: '2026-11-02 12:30:00', agentDrafted: true });
		expect(JSON.stringify(readQuestions(decider, decision.id, { source: 'ui' })[1]), '(b)').not.toContain(author.username);
		// (c) A replaced draft: the person's answer, in the role of the replacement, no label, and the discarded text in no projection.
		expect(c, '(c)').toEqual({ text: 'A person wrote this.', answererName: author.username, answererRole: 'author', answeredAt: expect.any(String), agentDrafted: false });
		expect(readQuestions(decider, decision.id, { source: 'ui' })[2].draft, '(c)').toBeUndefined();
		for (const viewer of [decider, author, pat.account]) {
			expect(JSON.stringify(readQuestions(viewer, decision.id, { source: 'ui' })), `(c) ${viewer.username}`).not.toContain('An agent wrote this.');
		}

		// (d) The role is the answer's event's, not who decides now: the author made the decider too, by raw SQL.
		sqlite.prepare('UPDATE decisions SET decider_user_id = ?, decider_name = ? WHERE id = ?').run(author.id, author.username, decision.id);
		expect(readQuestions(author, decision.id, { source: 'ui' }).find((view) => view.question === person.question)?.answer?.answererRole, '(d)').toBe('author');

		// (e) An account both author and decider answers as the decider; the author alone as the author.
		const both = opened({ sameAccount: true });
		expect(answererRoleOf(decisionAccess(both.author, both.decision)), '(e)').toBe('decider');
		const apart = opened();
		expect(answererRoleOf(decisionAccess(apart.author, apart.decision)), '(e) the author alone').toBe('author');
		expect(answererRoleOf(decisionAccess(apart.decider, apart.decision)), '(e) the decider alone').toBe('decider');
	});
});

describe('the open questions and the results', () => {
	it('counts an unanswered question and an unpublished draft as open, closes each by an answer, a publish or a replacement, and offers the answer link only to who may answer (3)', () => {
		const { decision, author, decider } = opened({ status: 'closed', closesAt: PAST });
		const pat = withAccount(decision, 'pat');
		const admin = makeUser({ role: 'admin', username: 'admin' });
		const unanswered = makeQuestion(decision, pat.participant, { question: 'Open?', askedAt: '2026-11-02 10:00:00' });
		const drafted = makeQuestion(decision, pat.participant, { question: 'Drafted?', askedAt: '2026-11-02 10:01:00', answer: 'An agent.', by: decider, agentDrafted: true });

		// (a) Both are open, the draft as answered by an agent, and the ruling's warning counts both.
		expect(openQuestionsOf(decision.id, { source: 'ui' }), '(a)').toEqual([
			{ askerName: pat.participant.name, question: 'Open?', askedAt: '2026-11-02 10:00:00', agentAnswered: false },
			{ askerName: pat.participant.name, question: 'Drafted?', askedAt: '2026-11-02 10:01:00', agentAnswered: true }
		]);
		// (a) Through an API key (code review S1), decided in the service: no name and no moment on any, every one untrusted.
		const forApi = [
			{ question: 'Open?', agentAnswered: false, untrusted: true },
			{ question: 'Drafted?', agentAnswered: true, untrusted: true }
		];
		expect(openQuestionsOf(decision.id, { source: 'api' }), '(a) api').toEqual(forApi);
		expect(readResults(decider, decision.id, { source: 'api' }).openQuestions, '(a) api results').toEqual(forApi);
		expect(JSON.stringify(readResults(decider, decision.id, { source: 'api' }).openQuestions), '(a) api results').not.toMatch(/"(askerName|askedAt)"/);
		// Fail closed: a source it does not know is not the page's.
		expect(openQuestionsOf(decision.id, { source: 'cli' as ServiceOptions['source'] }), '(a) unknown source').toEqual(forApi);
		expect(rulingRefusals(decisionRow(decision.id), { revision: resultsRevisionFor(decision.id), openQuestionsConfirmed: false }), '(a)').toEqual([
			'2 questions are still open: confirm that you rule with them open'
		]);

		// (b) A person's answer, a publish and a replacement each close one.
		const another = makeQuestion(decision, pat.participant, { question: 'Another draft?', answer: 'An agent again.', by: decider, agentDrafted: true });
		const open = () => openQuestionsOf(decision.id, { source: 'ui' });
		expect(open(), '(b)').toHaveLength(3);
		expect(recordAnswer(unanswered.id, 'A person.', actorFor(author, 'ui'), false)).toBe(true);
		expect(open().map((q) => q.question), '(b) answered').toEqual(['Drafted?', 'Another draft?']);
		expect(recordDraftPublished(drafted.id, actorFor(decider, 'ui'))).toBe(true);
		expect(open().map((q) => q.question), '(b) published').toEqual(['Another draft?']);
		expect(recordDraftReplaced(another.id, 'A person instead.', actorFor(decider, 'ui'))).toBe(true);
		expect(open(), '(b) replaced').toEqual([]);

		// (c) The decider with board edit may answer them from the results; an administrator may not.
		makeQuestion(decision, pat.participant, { question: 'Last?' });
		expect(readResults(decider, decision.id, { source: 'ui' }), '(c)').toMatchObject({ mayAnswerQuestions: true, openQuestions: [expect.objectContaining({ question: 'Last?' })] });
		expect(readResults(admin, decision.id, { source: 'ui' }).mayAnswerQuestions, '(c) an administrator').toBe(false);

		// (d) Code review F5: the SQL of the open questions and the one pending-draft rule agree, row for row, over every state a row can be in.
		makeQuestion(decision, pat.participant, { question: "A person's answer?", answer: 'Mine.', by: author, role: 'author' });
		makeQuestion(decision, pat.participant, { question: 'A fresh draft?', answer: 'An agent once more.', by: decider, agentDrafted: true });
		makeQuestion(decision, pat.participant, { question: 'A published draft?', answer: 'Reviewed.', by: decider, agentDrafted: true, published: author });
		const rows = db.select().from(decisionQuestions).where(eq(decisionQuestions.decisionId, decision.id)).orderBy(decisionQuestions.id).all();
		expect(rows.map((row) => row.question), '(d)').toEqual(['Open?', 'Drafted?', 'Another draft?', 'Last?', "A person's answer?", 'A fresh draft?', 'A published draft?']);
		expect(rows.map(pendingDraft), '(d) the rule').toEqual([false, false, false, false, false, true, false]);
		expect(open().map((q) => q.question), '(d) the SQL').toEqual(rows.filter((row) => row.answer === null || pendingDraft(row)).map((row) => row.question));
		expect(open().map((q) => q.question), '(d) the SQL').toEqual(['Last?', 'A fresh draft?']);
	});

	it('moves the results revision with a question asked, answered, a draft published and one replaced (4)', () => {
		const { decision, author, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const moves = (change: () => void) => {
			const was = resultsRevisionFor(decision.id);
			change();
			return resultsRevisionFor(decision.id) !== was;
		};
		const ask = (question: string) =>
			appendQuestion({ decisionId: decision.id, participantId: pat.participant.id, askerName: pat.participant.name, question, askedInVersion: 1, via: 'session' }).id;

		let asked = 0;
		expect(
			moves(() => {
				asked = ask('Asked?');
			}),
			'(a) a new question'
		).toBe(true);
		expect(
			moves(() => recordAnswer(asked, 'Answered.', actorFor(author, 'ui'), false)),
			'(b) an answer'
		).toBe(true);
		const toPublish = ask('To publish?');
		recordAnswer(toPublish, 'A draft.', actorFor(decider, 'api'), true);
		expect(
			moves(() => recordDraftPublished(toPublish, actorFor(decider, 'ui'))),
			'(c) a publish'
		).toBe(true);
		const toReplace = ask('To replace?');
		recordAnswer(toReplace, 'Another draft.', actorFor(decider, 'api'), true);
		expect(
			moves(() => recordDraftReplaced(toReplace, 'A person.', actorFor(decider, 'ui'))),
			'(d) a replacement, in the same second as its draft'
		).toBe(true);
	});

	it('leaves a row its guard excludes as it was, and says so, one row each (5)', () => {
		const { decision, author, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const answered = makeQuestion(decision, pat.participant, { answer: 'Mine.', by: author, role: 'author' });
		const published = makeQuestion(decision, pat.participant, { answer: 'Drafted.', by: decider, agentDrafted: true, published: author });
		const rowOf = (id: number) => sqlite.prepare('SELECT * FROM decision_questions WHERE id = ?').get(id);
		const by = actorFor(decider, 'ui');

		const rows: [string, number, () => boolean][] = [
			['(a) recordAnswer on an answered row', answered.id, () => recordAnswer(answered.id, 'Again.', by, false)],
			["(b) recordDraftPublished on a person's answer", answered.id, () => recordDraftPublished(answered.id, by)],
			['(c) recordDraftPublished on a published draft', published.id, () => recordDraftPublished(published.id, by)],
			['(d) recordDraftReplaced on a published draft', published.id, () => recordDraftReplaced(published.id, 'Over.', by)],
			["(e) recordDraftReplaced on a person's answer", answered.id, () => recordDraftReplaced(answered.id, 'Over.', by)]
		];
		for (const [name, id, run] of rows) {
			const before = rowOf(id);
			expect(run(), name).toBe(false);
			expect(rowOf(id), name).toEqual(before);
		}
	});
});

// ─── The writes (slice 1b) ───────────────────────────────────────────────────

const UI: ServiceOptions = { source: 'ui' };
const API: ServiceOptions = { source: 'api' };

/** Call a write as `user`, or with no session for null, as a route calls it inside its writeAs callback. */
const as = <T>(user: SessionUser | null, write: (caller: SessionUser | null) => T): T =>
	writeAs((user === null ? {} : { user }) as App.Locals, write as never) as T;

const ask = (user: SessionUser | null, decision: Decision, body: Record<string, unknown> = { question: 'What does B cost?' }, opts: ServiceOptions = UI) =>
	as(user, (caller) => askQuestion(caller, { decisionId: decision.id }, body, opts));
const askByLink = (token: string, body: Record<string, unknown> = { question: 'What does B cost?' }, browser: SessionUser | null = null, opts: ServiceOptions = UI) =>
	as(browser, (caller) => askQuestionByLink(caller, { token }, body, opts));
const answer = (user: SessionUser | null, decision: Decision, questionId: number, body: Record<string, unknown> = { answer: 'About 10k.' }, opts: ServiceOptions = UI) =>
	as(user, (caller) => answerQuestion(caller, { decisionId: decision.id, questionId }, body, opts));
const publish = (user: SessionUser | null, decision: Decision, questionId: number, opts: ServiceOptions = UI) =>
	as(user, (caller) => publishAnswer(caller, { decisionId: decision.id, questionId }, null, opts));

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
const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
/** What a write leaves behind: the questions, every question row as it is, the events and the activity. */
const written = () => ({
	questions: sqlite.prepare('SELECT * FROM decision_questions ORDER BY id').all(),
	events: count('decision_events'),
	activity: count('activity_log')
});
const questionRow = (id: number) => sqlite.prepare('SELECT * FROM decision_questions WHERE id = ?').get(id) as Record<string, unknown>;
/** The notices of a new question mailed, and of an answer. */
const questionMails = () => sent.emails.filter((mail) => mail.subject.startsWith('A question about'));
const answerMails = () => sent.emails.filter((mail) => mail.subject.startsWith('Your question about'));
/** The notices each question of the decision was recorded with, in order, by participant. */
const notices = (decisionId: number) =>
	eventsOf(decisionId)
		.filter((event) => event.kind === 'question_asked')
		.map((event) => [event.participantId, event.detail.notices]);
const STAMPED = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
/** Let every mail asked for so far be sent, then forget them: what follows is the next write's alone. */
const fresh = async () => {
	await sent.settle();
	sent.clear();
};

/** Move a participant's questions, and the events about them, `minutes` back: a test's own change to the record, past the rest or the day. */
function ageQuestions(participantId: number, minutes: number) {
	const back = `-${minutes} minutes`;
	sqlite.prepare('UPDATE decision_questions SET asked_at = datetime(asked_at, ?) WHERE participant_id = ?').run(back, participantId);
	sqlite.prepare("UPDATE decision_events SET created_at = datetime(created_at, ?) WHERE participant_id = ? AND kind = 'question_asked'").run(back, participantId);
}

/** A board reader: may view every decision on the board that is not a draft. */
function boardReader() {
	const reader = makeUser({ username: `reader${++seq}` });
	addBoardMember(board, reader, 'viewer');
	return reader;
}

describe('askQuestion and askQuestionByLink', () => {
	it('records a signed-in question, its event and a notice to the decider and the author naming nobody and quoting nothing (6)', async () => {
		const { decision, author, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const before = eventsOf(decision.id).length;

		const got = ask(pat.account, decision, { question: '  What does B cost?  ' });

		expect(got).toEqual({ question: { question: 'What does B cost?', askedInVersion: 1, askedAt: expect.stringMatching(STAMPED) } });
		expect(JSON.stringify(got)).not.toMatch(/"(id|participantId|askerName)"/);
		const [row] = sqlite.prepare('SELECT * FROM decision_questions WHERE decision_id = ?').all(decision.id) as Record<string, unknown>[];
		expect(row).toMatchObject({
			participant_id: pat.participant.id,
			asker_name: pat.participant.name,
			question: 'What does B cost?',
			asked_in_version: 1,
			via: 'session',
			asked_at: got.question.askedAt,
			answer: null,
			answered_by: null,
			answered_at: null,
			answer_agent_drafted: 0,
			answer_reviewed_at: null
		});
		expect(eventsOf(decision.id).slice(before)).toEqual([
			{
				kind: 'question_asked',
				participantId: pat.participant.id,
				versionNumber: 1,
				detail: {
					questionId: row.id,
					notices: [
						{ userId: decider.id, outcome: 'asked' },
						{ userId: author.id, outcome: 'asked' }
					]
				},
				actorUserId: pat.account.id,
				actorName: pat.account.username,
				source: 'ui'
			}
		]);
		expect(count('activity_log')).toBe(0);
		expect(emitted, 'no live event asked for (S4)').not.toHaveBeenCalled();

		await sent.settle();
		expect(sent.events, 'no live event').toEqual([]);
		expect(questionMails().map((mail) => mail.to).sort()).toEqual([author.email, decider.email].sort());
		for (const mail of questionMails()) {
			expect(mail.subject).toBe(`A question about ${decision.title}`);
			expect(mail.html).toContain(`${APP}/decisions/${decision.id}#questions`);
			for (const absent of ['What does B cost?', pat.person.fullName, pat.account.username, 'more since the last notice']) expect(mail.html, absent).not.toContain(absent);
		}
		expect(sent.duringTransaction).toEqual([]);
	});

	it('takes a question from a participant kept informed (7)', () => {
		const { decision } = opened();
		const ivy = withAccount(decision, 'ivy', 'informed');

		expect(outcome(() => ask(ivy.account, decision))).toBe('passed');
		expect(count('decision_questions')).toBe(1);
	});

	it('records a link holder’s question by the link, noting a signed-in browser’s account beside it (8)', () => {
		const { decision } = opened();
		const linked = withLink(decision, 'token-q8');
		const browser = makeUser({ username: 'browser' });

		askByLink('token-q8', { question: 'By link?' }, browser);

		expect(sqlite.prepare('SELECT participant_id AS p, via, asker_name AS name FROM decision_questions').get()).toEqual({
			p: linked.participant.id,
			via: 'link',
			name: linked.participant.name
		});
		const [event] = eventsOf(decision.id).filter((e) => e.kind === 'question_asked');
		expect(event).toMatchObject({
			participantId: linked.participant.id,
			actorUserId: null,
			actorName: linked.participant.name,
			source: 'link',
			detail: { questionId: expect.any(Number), notices: expect.any(Array), signedIn: { userId: browser.id, name: browser.username } }
		});
		// Code review S4: no activity entry and no live event, by a link as signed in.
		expect(count('activity_log')).toBe(0);
		expect(emitted).not.toHaveBeenCalled();
	});

	it('takes a question through an API key as the key’s own, labelled to the privileged and the asker alone (9)', () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const quin = withAccount(decision, 'quin');

		const got = ask(pat.account, decision, { question: 'From my agent?' }, API);

		// Code review S2: the answer through a key carries no moment, and marks the text as a participant's words.
		expect(got).toEqual({ question: { question: 'From my agent?', askedInVersion: 1, untrusted: true } });
		expect(sqlite.prepare('SELECT via FROM decision_questions').get()).toEqual({ via: 'api' });
		expect(eventsOf(decision.id).find((e) => e.kind === 'question_asked')).toMatchObject({ actorUserId: pat.account.id, source: 'api' });
		expect(questionsFor(decision, viewerOf(decider, decision))[0].askedByAgent, 'the decider').toBe(true);
		expect(questionsFor(decision, viewerOf(pat.account, decision))[0].askedByAgent, 'the asker').toBe(true);
		expect(questionsFor(decision, viewerOf(quin.account, decision))[0].askedByAgent, 'another participant').toBeUndefined();

		// Code review S3: fail closed, a source that is not the page's is recorded as an agent's, never as a session.
		const ray = withAccount(decision, 'ray');
		expect(ask(ray.account, decision, { question: 'From elsewhere?' }, { source: 'cli' as ServiceOptions['source'] })).toEqual({
			question: { question: 'From elsewhere?', askedInVersion: 1, untrusted: true }
		});
		expect(sqlite.prepare('SELECT via FROM decision_questions WHERE participant_id = ?').get(ray.participant.id), 'an unknown source').toEqual({ via: 'api' });
	});

	it('takes questions while a decision awaits its ruling, one row each (10)', () => {
		const closed = opened({ status: 'closed', closesAt: PAST });
		const pat = withAccount(closed.decision, 'pat');
		expect(outcome(() => ask(pat.account, closed.decision)), '(a) stored closed').toBe('passed');

		const lapsed = opened({ status: 'open', closesAt: PAST });
		const quin = withAccount(lapsed.decision, 'quin');
		expect(outcome(() => ask(quin.account, lapsed.decision)), '(b) stored open past closes_at').toBe('passed');
	});

	it('refuses in decision 17’s order, writing nothing, one row each (11)', () => {
		const { decision } = opened();
		const pat = withAccount(decision, 'pat');
		const outsider = makeUser({ username: 'outsider' });
		const reader = boardReader();
		const gone = withAccount(decision, 'gone');
		db.update(people).set({ status: 'left', leftAt: PAST }).where(eq(people.id, gone.person.id)).run();

		const ruled = opened();
		const rp = withAccount(ruled.decision, 'rp');
		makeRuling(ruled.decision, { ruledAt: stamp() });
		const withdrawn = opened({ status: 'withdrawn' });
		const wp = withAccount(withdrawn.decision, 'wp');
		const superseded = opened({ status: 'superseded' });
		const sp = withAccount(superseded.decision, 'sp');

		const full = withAccount(decision, 'full');
		for (let n = 0; n < 10; n++) makeQuestion(decision, full.participant, { askedAt: '2026-11-01 10:00:00' });
		const rested = withAccount(decision, 'rested');
		ask(rested.account, decision, { question: 'A first.' });
		const firstAt = sqlite.prepare('SELECT asked_at AS at FROM decision_questions WHERE participant_id = ?').get(rested.participant.id) as { at: string };
		const from = stamp(new Date(parseStamp(firstAt.at)!.getTime() + 10 * 60 * 1000));

		const crowded = opened();
		const filler = withAccount(crowded.decision, 'filler');
		for (let n = 0; n < 200; n++) makeQuestion(crowded.decision, filler.participant, { askedAt: '2026-11-01 10:00:00' });
		const late = withAccount(crowded.decision, 'late');

		// (q), (r): 30 questions recorded for the account in the last day, across two decisions.
		const busy = opened();
		const other = opened();
		const bee = withAccount(busy.decision, 'bee');
		makeParticipant(other.decision, { person: bee.person });
		for (let n = 0; n < 30; n++) {
			appendEvent({ decisionId: (n % 2 === 0 ? busy : other).decision.id, kind: 'question_asked', detail: { questionId: n, notices: [] } }, actorFor(bee.account, 'ui'));
		}
		const capped = /^You have asked 30 questions in the last 24 hours: the next can be asked from \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/;

		const lia = withLink(decision, 'token-q11');

		const rows: [string, () => unknown, number, string | RegExp][] = [
			['(a) no caller', () => ask(null, decision), 401, 'Not authenticated'],
			['(b) a caller who may not view it', () => ask(outsider, decision), 404, 'Decision not found'],
			['(c) a board reader who is no participant', () => ask(reader, decision), 403, 'You cannot ask a question on this decision'],
			['(d) a participant no longer reached', () => ask(gone.account, decision), 403, NO_LONGER_REACHED],
			["(e) the same, through source: 'api'", () => ask(gone.account, decision, undefined, API), 403, NO_LONGER_REACHED],
			['(f) empty after trimming', () => ask(pat.account, decision, { question: '   ' }), 400, 'question is required'],
			['(g) 2,001 characters', () => ask(pat.account, decision, { question: 'x'.repeat(2001) }), 400, 'question must be at most 2000 characters'],
			['(h) a right-to-left override', () => ask(pat.account, decision, { question: 'Why ‮on?' }), 400, /^question /],
			['(i) ruled', () => ask(rp.account, decisionRow(ruled.decision.id)), 409, QUESTIONS_CLOSED],
			['(j) withdrawn', () => ask(wp.account, withdrawn.decision), 409, 'This decision is withdrawn: questions are closed'],
			['(k) superseded', () => ask(sp.account, superseded.decision), 409, 'This decision is superseded: questions are closed'],
			['(l) an 11th question', () => ask(full.account, decision), 409, 'You have asked 10 questions on this decision: no more can be asked'],
			// The one function the closed form's words are made from too (code review F5).
			["(m) the same, through source: 'api'", () => ask(full.account, decision, undefined, API), 409, questionsLimitWords(10)],
			[
				'(n) within 10 minutes',
				() => ask(rested.account, decision, { question: 'Again.' }),
				429,
				`Your last question was asked less than 10 minutes ago: the next can be asked from ${from} UTC`
			],
			[
				"(o) the same, through source: 'api'",
				() => ask(rested.account, decision, { question: 'Again.' }, API),
				429,
				`Your last question was asked less than 10 minutes ago: the next can be asked from ${from} UTC`
			],
			['(p) the 201st on the decision', () => ask(late.account, crowded.decision), 409, 'This decision has 200 questions: no more can be asked. Ask the decider directly'],
			["(q) a caller's 31st in 24 hours, across two decisions", () => ask(bee.account, other.decision), 429, capped],
			["(r) the same, through source: 'api'", () => ask(bee.account, busy.decision, undefined, API), 429, capped],
			['(t) two faults: an empty question on a ruled decision', () => ask(rp.account, decisionRow(ruled.decision.id), { question: '' }), 400, 'question is required'],
			["(u) by link, through source: 'api'", () => askByLink('token-q11', undefined, null, API), 403, "Asking by a personal link is a person's act: it cannot be done with an API key"],
			['(v) by link, a token that opens no decision', () => askByLink('a-token-that-was-never-issued-to-anyone-000'), 404, DEAD_DECISION_LINK]
		];
		expect(lia.participant.id).toBeGreaterThan(0);
		for (const [name, run, status, message] of rows) {
			const before = written();
			const got = outcome(run);
			expect(got, name).toEqual({ status, message: typeof message === 'string' ? message : expect.stringMatching(message) });
			expect(written(), name).toEqual(before);
		}
	});

	it('refuses the 31st question in 24 hours from the allowance once the decisions holding the first 30 are withdrawn and deleted (11 s)', () => {
		const account = makeUser({ username: 'asker' });
		const person = makePerson({ fullName: 'Asker Person', user: account });
		const made = [opened(), opened(), opened()];
		for (const { decision } of made) {
			const participant = makeParticipant(decision, { person });
			for (let n = 0; n < 10; n++) {
				ask(account, decision, { question: `Question ${n}?` });
				ageQuestions(participant.id, 11);
			}
		}
		expect(count('decision_questions')).toBe(30);
		for (const { decision } of made) {
			sqlite.prepare("UPDATE decisions SET status = 'withdrawn', withdrawn_at = ? WHERE id = ?").run(stamp(), decision.id);
			sqlite.prepare('DELETE FROM decisions WHERE id = ?').run(decision.id);
		}
		expect(count('decision_questions')).toBe(0);
		const fourth = opened();
		makeParticipant(fourth.decision, { person });
		const before = written();

		expect(outcome(() => ask(account, fourth.decision))).toEqual({
			status: 429,
			message: expect.stringMatching(/^You have asked 30 questions in the last 24 hours: the next can be asked from \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/)
		});
		expect(written()).toEqual(before);
	});

	it('notices whoever may answer now, once a day per participant, and records why not otherwise, one row each (12)', async () => {
		// (a) The author and the decider are one account: one entry, one mail.
		const same = opened({ sameAccount: true });
		const ann = withAccount(same.decision, 'ann');
		ask(ann.account, same.decision);
		expect(notices(same.decision.id), '(a)').toEqual([[ann.participant.id, [{ userId: same.decider.id, outcome: 'asked' }]]]);
		await sent.settle();
		expect(questionMails().filter((mail) => mail.to === same.decider.email), '(a)').toHaveLength(1);

		// (b) The author has lost board edit: only the decider.
		const authorless = opened();
		const bob = withAccount(authorless.decision, 'bob');
		demote(authorless.author);
		ask(bob.account, authorless.decision);
		expect(notices(authorless.decision.id), '(b)').toEqual([[bob.participant.id, [{ userId: authorless.decider.id, outcome: 'asked' }]]]);

		// (c) The same participant's next, within the day: held for each; (e) another's first within the hour: asked.
		const { decision, author, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const quin = withAccount(decision, 'quin');
		ask(pat.account, decision);
		ageQuestions(pat.participant.id, 11);
		ask(pat.account, decision, { question: 'Held?' });
		expect(notices(decision.id).at(-1), '(c)').toEqual([
			pat.participant.id,
			[
				{ userId: decider.id, outcome: 'held' },
				{ userId: author.id, outcome: 'held' }
			]
		]);
		ask(quin.account, decision);
		expect(notices(decision.id).at(-1), '(e)').toEqual([
			quin.participant.id,
			[
				{ userId: decider.id, outcome: 'asked' },
				{ userId: author.id, outcome: 'asked' }
			]
		]);
		// (d) Their next after a day: asked, saying one more was held.
		ageQuestions(pat.participant.id, 25 * 60);
		await fresh();
		ask(pat.account, decision, { question: 'A day on?' });
		expect(notices(decision.id).at(-1), '(d)').toEqual([
			pat.participant.id,
			[
				{ userId: decider.id, outcome: 'asked' },
				{ userId: author.id, outcome: 'asked' }
			]
		]);
		await sent.settle();
		expect(questionMails(), '(d)').toHaveLength(2);
		for (const mail of questionMails()) expect(mail.html, '(d)').toContain('They asked 1 more since the last notice about them, which was not mailed.');

		// (f) The decider's decision mail switched off: prefs_off, and the author still asked.
		const quiet = opened();
		const sam = withAccount(quiet.decision, 'sam');
		db.update(users).set({ notificationPrefs: JSON.stringify({ email_decisions: false }) }).where(eq(users.id, quiet.decider.id)).run();
		ask(sam.account, quiet.decision);
		expect(notices(quiet.decision.id), '(f)').toEqual([
			[
				sam.participant.id,
				[
					{ userId: quiet.decider.id, outcome: 'prefs_off' },
					{ userId: quiet.author.id, outcome: 'asked' }
				]
			]
		]);

		// (g) No mail host: no_mail_host, not counted, so the next, once mail is set up, notifies.
		const hostless = opened();
		const una = withAccount(hostless.decision, 'una');
		db.delete(settings).where(eq(settings.key, 'smtp_host')).run();
		ask(una.account, hostless.decision);
		expect(notices(hostless.decision.id).at(-1)?.[1], '(g)').toEqual([
			{ userId: hostless.decider.id, outcome: 'no_mail_host' },
			{ userId: hostless.author.id, outcome: 'no_mail_host' }
		]);
		db.insert(settings).values({ key: 'smtp_host', value: 'smtp.example.test' }).run();
		ageQuestions(una.participant.id, 11);
		ask(una.account, hostless.decision, { question: 'Mail is back?' });
		expect(notices(hostless.decision.id).at(-1)?.[1], '(g) next').toEqual([
			{ userId: hostless.decider.id, outcome: 'asked' },
			{ userId: hostless.author.id, outcome: 'asked' }
		]);

		// (i) The decider's and the author's accounts gone: nobody may answer now.
		const orphan = opened();
		const vic = withAccount(orphan.decision, 'vic');
		sqlite.prepare('UPDATE decisions SET decider_user_id = NULL, author_user_id = NULL WHERE id = ?').run(orphan.decision.id);
		ask(vic.account, decisionRow(orphan.decision.id));
		expect(notices(orphan.decision.id), '(i)').toEqual([[vic.participant.id, []]]);

		// (j) The link is made on the App URL, whatever opts.baseUrl says.
		const elsewhere = opened();
		const tia = withAccount(elsewhere.decision, 'tia');
		await fresh();
		ask(tia.account, elsewhere.decision, undefined, { source: 'ui', baseUrl: 'https://attacker.example.test' });
		await sent.settle();
		expect(questionMails(), '(j)').toHaveLength(2);
		for (const mail of questionMails()) {
			expect(mail.html, '(j)').toContain(`${APP}/decisions/${elsewhere.decision.id}#questions`);
			expect(mail.html, '(j)').not.toContain('attacker.example.test');
		}

		// (k) The author, consulted as a participant, asks: no entry for their own account (S6), the decider still asked.
		const own = opened();
		const authorPerson = makePerson({ fullName: 'Author Person', user: own.author });
		const authorRow = makeParticipant(own.decision, { person: authorPerson });
		ask(own.author, own.decision);
		expect(notices(own.decision.id), '(k)').toEqual([[authorRow.id, [{ userId: own.decider.id, outcome: 'asked' }]]]);

		// (l) The decider has lost board edit (S11): only the author.
		const deciderless = opened();
		const wes = withAccount(deciderless.decision, 'wes');
		demote(deciderless.decider);
		ask(wes.account, deciderless.decision);
		expect(notices(deciderless.decision.id), '(l)').toEqual([[wes.participant.id, [{ userId: deciderless.author.id, outcome: 'asked' }]]]);

		// (h) With no App URL and no ORIGIN: no_link_address.
		db.delete(settings).where(eq(settings.key, 'app_url')).run();
		const unaddressed = opened();
		const uma = withAccount(unaddressed.decision, 'uma');
		ask(uma.account, unaddressed.decision);
		expect(notices(unaddressed.decision.id), '(h)').toEqual([
			[
				uma.participant.id,
				[
					{ userId: unaddressed.decider.id, outcome: 'no_link_address' },
					{ userId: unaddressed.author.id, outcome: 'no_link_address' }
				]
			]
		]);
		await sent.settle();
		expect(sent.duringTransaction).toEqual([]);
	});
});

describe('answerQuestion and publishAnswer', () => {
	it('records a person’s answer, its event in their role, and tells the asker naming nobody and quoting nothing, one row each (13)', async () => {
		const { decision, author, decider } = opened();
		const pat = withAccount(decision, 'pat');

		for (const [name, answerer, role] of [
			['(a) the decider', decider, 'decider'],
			['(b) the author', author, 'author']
		] as const) {
			const question = makeQuestion(decision, pat.participant, { question: `Asked of ${role}?` });
			const before = eventsOf(decision.id).length;
			await fresh();

			const got = answer(answerer, decision, question.id, { answer: '  About 10k.  ' });

			expect(questionRow(question.id), name).toMatchObject({
				answer: 'About 10k.',
				answered_by: answerer.id,
				answered_by_name: answerer.username,
				answered_at: expect.stringMatching(STAMPED),
				answer_agent_drafted: 0,
				answer_reviewed_at: null
			});
			expect(eventsOf(decision.id).slice(before), name).toEqual([
				{
					kind: 'question_answered',
					participantId: null,
					versionNumber: null,
					detail: { questionId: question.id, role, agentDrafted: false, notice: 'asked' },
					actorUserId: answerer.id,
					actorName: answerer.username,
					source: 'ui'
				}
			]);
			expect(got, name).toEqual({
				question: {
					id: question.id,
					question: `Asked of ${role}?`,
					askedInVersion: 1,
					own: false,
					askerName: pat.participant.name,
					askedAt: question.askedAt,
					answer: { text: 'About 10k.', answererName: answerer.username, answererRole: role, answeredAt: questionRow(question.id).answered_at, agentDrafted: false },
					closedUnanswered: null
				}
			});
			await sent.settle();
			expect(answerMails().map((mail) => mail.to), name).toEqual([pat.account.email]);
			const [mail] = answerMails();
			expect(mail.subject, name).toBe(`Your question about ${decision.title} has been answered`);
			expect(mail.html, name).toContain(`${APP}/decisions/${decision.id}#questions`);
			for (const absent of ['About 10k.', `Asked of ${role}?`, answerer.username]) expect(mail.html, `${name}: ${absent}`).not.toContain(absent);
		}
		expect(count('activity_log')).toBe(0);
		expect(emitted, 'no live event asked for (S4)').not.toHaveBeenCalled();
		expect(sent.events).toEqual([]);
		expect(sent.duringTransaction).toEqual([]);
	});

	it('makes an answer through an API key a draft, mailed to nobody and open to participants (14)', async () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const question = makeQuestion(decision, pat.participant);

		const got = answer(decider, decision, question.id, { answer: 'An agent says 10k.' }, API);

		expect(questionRow(question.id)).toMatchObject({ answer: 'An agent says 10k.', answer_agent_drafted: 1, answer_reviewed_at: null });
		expect(eventsOf(decision.id).at(-1)).toMatchObject({
			kind: 'question_answered',
			detail: { questionId: question.id, role: 'decider', agentDrafted: true, notice: 'awaiting_review' },
			source: 'api'
		});
		expect(got.question).toMatchObject({ id: question.id, answer: null, draft: { text: 'An agent says 10k.', drafterName: decider.username }, untrusted: true });
		expect(got.question.askerName).toBeUndefined();
		expect(readQuestions(pat.account, decision.id, { source: 'ui' })[0]).toMatchObject({ answer: null, closedUnanswered: null });
		expect(JSON.stringify(readQuestions(pat.account, decision.id, { source: 'ui' }))).not.toContain('An agent says 10k.');
		expect(openQuestionsOf(decision.id, { source: 'ui' })).toEqual([expect.objectContaining({ agentAnswered: true })]);
		await sent.settle();
		expect(answerMails()).toEqual([]);

		// Code review S3: fail closed, a source that is not the page's drafts, and the asker is not told.
		const other = makeQuestion(decision, pat.participant, { question: 'From elsewhere?' });
		answer(decider, decision, other.id, { answer: 'Someone says 11k.' }, { source: 'cli' as ServiceOptions['source'] });
		expect(questionRow(other.id), 'an unknown source').toMatchObject({ answer: 'Someone says 11k.', answer_agent_drafted: 1, answer_reviewed_at: null });
		expect(eventsOf(decision.id).at(-1)?.detail, 'an unknown source').toMatchObject({ agentDrafted: true, notice: 'awaiting_review' });
		await sent.settle();
		expect(answerMails(), 'an unknown source').toEqual([]);
	});

	it('publishes a draft signed in, its text unchanged, and tells the asker now (15)', async () => {
		const { decision, author, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const question = makeQuestion(decision, pat.participant);
		answer(decider, decision, question.id, { answer: 'An agent says 10k.' }, API);
		await sent.settle();
		const before = eventsOf(decision.id).length;

		const got = publish(author, decision, question.id);

		expect(questionRow(question.id)).toMatchObject({ answer: 'An agent says 10k.', answer_agent_drafted: 1, answer_reviewed_by: author.id, answer_reviewed_at: expect.stringMatching(STAMPED) });
		expect(eventsOf(decision.id).slice(before)).toEqual([
			{
				kind: 'answer_published',
				participantId: null,
				versionNumber: null,
				detail: { questionId: question.id, notice: 'asked' },
				actorUserId: author.id,
				actorName: author.username,
				source: 'ui'
			}
		]);
		expect(got.question.answer).toEqual({
			text: 'An agent says 10k.',
			answererName: decider.username,
			answererRole: 'decider',
			answeredAt: questionRow(question.id).answer_reviewed_at,
			agentDrafted: true
		});
		expect(got.question.draft).toBeUndefined();
		// Code review S4: no activity entry and no live event for a publish.
		expect(count('activity_log')).toBe(0);
		expect(emitted).not.toHaveBeenCalled();
		await sent.settle();
		expect(answerMails().map((mail) => mail.to)).toEqual([pat.account.email]);
		expect(answerMails()[0].html).not.toContain('An agent says 10k.');
	});

	it('replaces a draft with a person’s answer, keeping the draft on the record alone, and tells the asker (16)', async () => {
		const { decision, author, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const question = makeQuestion(decision, pat.participant);
		answer(decider, decision, question.id, { answer: 'An agent says 10k.' }, API);
		const drafted = questionRow(question.id);
		const before = eventsOf(decision.id).length;

		const got = answer(author, decision, question.id, { answer: 'About 12k, in fact.', replacesDraft: true });

		expect(questionRow(question.id)).toMatchObject({
			answer: 'About 12k, in fact.',
			answered_by: author.id,
			answered_by_name: author.username,
			answer_agent_drafted: 0,
			answer_reviewed_at: null
		});
		expect(eventsOf(decision.id).slice(before)).toEqual([
			{
				kind: 'answer_replaced',
				participantId: null,
				versionNumber: null,
				detail: {
					questionId: question.id,
					role: 'author',
					discarded: { text: 'An agent says 10k.', byName: decider.username, at: drafted.answered_at },
					notice: 'asked'
				},
				actorUserId: author.id,
				actorName: author.username,
				source: 'ui'
			}
		]);
		expect(got.question.answer).toMatchObject({ text: 'About 12k, in fact.', answererName: author.username, answererRole: 'author', agentDrafted: false });
		expect(JSON.stringify(got)).not.toContain('An agent says 10k.');
		// Code review S4: no activity entry and no live event for a replacement.
		expect(count('activity_log')).toBe(0);
		expect(emitted).not.toHaveBeenCalled();
		await sent.settle();
		expect(answerMails().map((mail) => mail.to)).toEqual([pat.account.email]);
	});

	it('refuses an answer in decision 17’s order, writing nothing, one row each (17)', () => {
		const { decision, author, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const outsider = makeUser({ username: 'outsider' });
		const admin = makeUser({ role: 'admin', username: 'admin' });
		const open = makeQuestion(decision, pat.participant, { question: 'Open?' });
		const answered = makeQuestion(decision, pat.participant, { question: 'Answered?', answer: 'The first answer.', by: author, role: 'author' });
		const drafted = makeQuestion(decision, pat.participant, { question: 'Drafted?', answer: 'A draft.', by: decider, agentDrafted: true });

		const lost = opened();
		const lp = withAccount(lost.decision, 'lp');
		const lostQuestion = makeQuestion(lost.decision, lp.participant);
		demote(lost.decider);
		const elsewhere = opened();
		const ep = withAccount(elsewhere.decision, 'ep');
		const elsewhereQuestion = makeQuestion(elsewhere.decision, ep.participant);
		const ruled = opened();
		const rq = makeQuestion(ruled.decision, withAccount(ruled.decision, 'rp').participant);
		makeRuling(ruled.decision, { ruledAt: stamp() });
		const withdrawn = opened({ status: 'withdrawn' });
		const wq = makeQuestion(withdrawn.decision, withAccount(withdrawn.decision, 'wp').participant);

		const rows: [string, () => unknown, number, string | RegExp][] = [
			['(a) no caller', () => answer(null, decision, open.id), 401, 'Not authenticated'],
			['(b) a caller who may not view it', () => answer(outsider, decision, open.id), 404, 'Decision not found'],
			['(c) a participant', () => answer(pat.account, decision, open.id), 403, 'You cannot answer questions on this decision'],
			['(d) an administrator who is neither', () => answer(admin, decision, open.id), 403, 'You cannot answer questions on this decision'],
			['(e) a decider who has lost board edit', () => answer(lost.decider, lost.decision, lostQuestion.id), 403, 'You cannot answer questions on this decision'],
			[
				"(f) replacesDraft through source: 'api'",
				() => answer(decider, decision, drafted.id, { answer: 'Mine.', replacesDraft: true }, API),
				403,
				"Replacing an agent's answer is a person's act: it cannot be done with an API key"
			],
			['(g) a question of another decision', () => answer(decider, decision, elsewhereQuestion.id), 404, 'Question not found'],
			['(h) empty', () => answer(decider, decision, open.id, { answer: ' ' }), 400, 'answer is required'],
			['(i) 4,001 characters', () => answer(decider, decision, open.id, { answer: 'x'.repeat(4001) }), 400, 'answer must be at most 4000 characters'],
			['(j) ruled', () => answer(ruled.decider, decisionRow(ruled.decision.id), rq.id), 409, 'This decision is ruled: its questions cannot be answered'],
			['(k) withdrawn', () => answer(withdrawn.decider, withdrawn.decision, wq.id), 409, 'This decision is withdrawn: its questions cannot be answered'],
			['(l) already answered, the first answer kept', () => answer(decider, decision, answered.id), 409, ANSWERED],
			['(m) a draft waiting, without replacesDraft', () => answer(decider, decision, drafted.id), 409, DRAFT_PENDING],
			['(n) replacesDraft with no draft waiting', () => answer(decider, decision, answered.id, { answer: 'Mine.', replacesDraft: true }), 409, NO_DRAFT],
			['(o) two faults: an empty answer to an answered question', () => answer(decider, decision, answered.id, { answer: '' }), 400, 'answer is required']
		];
		for (const [name, run, status, message] of rows) {
			const before = written();
			const got = outcome(run);
			expect(got, name).toEqual({ status, message: typeof message === 'string' ? message : expect.stringMatching(message) });
			expect(written(), name).toEqual(before);
		}
		expect(questionRow(answered.id).answer).toBe('The first answer.');
	});

	it('refuses a publish, writing nothing, one row each (18)', () => {
		const { decision, author, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const drafted = makeQuestion(decision, pat.participant, { answer: 'A draft.', by: decider, agentDrafted: true });
		const open = makeQuestion(decision, pat.participant);
		const person = makeQuestion(decision, pat.participant, { answer: 'A person.', by: author, role: 'author' });
		const replaced = makeQuestion(decision, pat.participant);
		recordAnswer(replaced.id, 'Draft.', actorFor(decider, 'api'), true);
		recordDraftReplaced(replaced.id, 'A person instead.', actorFor(author, 'ui'));
		const published = makeQuestion(decision, pat.participant, { answer: 'Published.', by: decider, agentDrafted: true, published: author });
		const elsewhere = opened();
		const elsewhereDraft = makeQuestion(elsewhere.decision, withAccount(elsewhere.decision, 'ep').participant, { answer: 'D.', by: elsewhere.decider, agentDrafted: true });
		const ruled = opened();
		const ruledDraft = makeQuestion(ruled.decision, withAccount(ruled.decision, 'rp').participant, { answer: 'D.', by: ruled.decider, agentDrafted: true });
		makeRuling(ruled.decision, { ruledAt: stamp() });

		const rows: [string, () => unknown, number, string][] = [
			["(a) source: 'api'", () => publish(decider, decision, drafted.id, API), 403, "Publishing an agent's answer is a person's act: it cannot be done with an API key"],
			['(b) a participant', () => publish(pat.account, decision, drafted.id), 403, 'You cannot answer questions on this decision'],
			['(c) a question of another decision', () => publish(decider, decision, elsewhereDraft.id), 404, 'Question not found'],
			['(d) ruled', () => publish(ruled.decider, decisionRow(ruled.decision.id), ruledDraft.id), 409, 'This decision is ruled: its questions cannot be answered'],
			['(e) unanswered', () => publish(decider, decision, open.id), 409, NOTHING_TO_PUBLISH],
			["(f) a person's answer", () => publish(decider, decision, person.id), 409, PERSON_ANSWERED],
			['(f) a replaced draft', () => publish(decider, decision, replaced.id), 409, PERSON_ANSWERED],
			['(g) already published', () => publish(decider, decision, published.id), 409, ALREADY_PUBLISHED]
		];
		for (const [name, run, status, message] of rows) {
			const before = written();
			expect(outcome(run), name).toEqual({ status, message });
			expect(written(), name).toEqual(before);
		}
	});

	it('tells the asker of an answer, or records why not, one row each (19)', async () => {
		const outcomeOf = (decisionId: number) => eventsOf(decisionId).filter((event) => event.kind === 'question_answered').at(-1)?.detail.notice;

		// (a) An account asker with email_decisions off.
		const a = opened();
		const pat = withAccount(a.decision, 'pat');
		db.update(users).set({ notificationPrefs: JSON.stringify({ email_decisions: false }) }).where(eq(users.id, pat.account.id)).run();
		answer(a.decider, a.decision, makeQuestion(a.decision, pat.participant).id);
		expect(outcomeOf(a.decision.id), '(a)').toBe('prefs_off');

		// (b) A link holder whose invitation, which carried the link, was delivered: mailed at the snapshot address, with no
		// link, told to use the one in their latest email (card 2721, 2721-1), and no link issued.
		const b = opened();
		const lia = withLink(b.decision, 'token-q19');
		invited(b.decision, lia.participant.id, true);
		const hash = linkHashOf('token-q19');
		await fresh();
		answer(b.decider, b.decision, makeQuestion(b.decision, lia.participant, { via: 'link' }).id);
		expect(outcomeOf(b.decision.id), '(b)').toBe('asked');
		await sent.settle();
		expect(answerMails().map((mail) => mail.to), '(b)').toEqual([lia.participant.email]);
		expect(answerMails()[0].html, '(b)').toContain('Open the decision from the personal link in the latest email you were sent about it.');
		expect(answerMails()[0].html, '(b)').not.toContain(ASK_FOR_LINK_LINE);
		expect(answerMails()[0].html, '(b)').not.toMatch(/\/decision-link\/|\/decisions\/|href=/);
		expect(eventsOf(b.decision.id).filter((event) => event.kind === 'link_issued'), '(b)').toEqual([]);
		expect(db.select().from(decisionParticipants).where(eq(decisionParticipants.id, lia.participant.id)).get()?.linkTokenHash, '(b)').toBe(hash);

		// (c) The asker removed.
		const c = opened();
		const gone = withAccount(c.decision, 'gone');
		const cq = makeQuestion(c.decision, gone.participant);
		db.update(decisionParticipants).set({ removedAt: PAST }).where(eq(decisionParticipants.id, gone.participant.id)).run();
		answer(c.decider, c.decision, cq.id);
		expect(outcomeOf(c.decision.id), '(c)').toBe('not_reached');

		// (d) No mail host.
		const d = opened();
		const dq = makeQuestion(d.decision, withAccount(d.decision, 'dee').participant);
		db.delete(settings).where(eq(settings.key, 'smtp_host')).run();
		answer(d.decider, d.decision, dq.id);
		expect(outcomeOf(d.decision.id), '(d)').toBe('no_mail_host');
		db.insert(settings).values({ key: 'smtp_host', value: 'smtp.example.test' }).run();

		// (f) Asked by link with a signed-in browser beside it: mailed at the snapshot address, never the browser's account.
		const f = opened();
		const fay = withLink(f.decision, 'token-q19f');
		const browser = makeUser({ username: 'browser' });
		askByLink('token-q19f', { question: 'Signed in beside?' }, browser);
		const fq = sqlite.prepare('SELECT id FROM decision_questions WHERE decision_id = ?').get(f.decision.id) as { id: number };
		await fresh();
		answer(f.decider, f.decision, fq.id);
		await sent.settle();
		expect(answerMails().map((mail) => mail.to), '(f)').toEqual([fay.participant.email]);

		// (e) An account asker with no App URL and no ORIGIN.
		db.delete(settings).where(eq(settings.key, 'app_url')).run();
		const e = opened();
		const eq2 = makeQuestion(e.decision, withAccount(e.decision, 'eve').participant);
		answer(e.decider, e.decision, eq2.id);
		expect(outcomeOf(e.decision.id), '(e)').toBe('no_link_address');
		await sent.settle();
		expect(sent.duringTransaction).toEqual([]);
	});

	it('tells a link holder who may hold no working link to ask for a new one, issuing none, one row each (card 2721, 2721-2)', async () => {
		const noticeOf = (decisionId: number) =>
			eventsOf(decisionId)
				.filter((event) => ['question_answered', 'answer_published', 'answer_replaced'].includes(event.kind))
				.at(-1)?.detail.notice;
		const hashOf = (participantId: number) => db.select().from(decisionParticipants).where(eq(decisionParticipants.id, participantId)).get()?.linkTokenHash;

		const rows: [string, (seq: number) => { decision: Decision; participantId: number; run: () => unknown }][] = [
			[
				'(a) the link cleared by a restore after a delivered invitation',
				(n) => {
					const { decision, decider } = opened();
					const { participant } = withLink(decision, `token-2721-${n}`);
					invited(decision, participant.id, true);
					revokeLinks({ participantId: participant.id }, 'restore', SYSTEM_ACTOR);
					const q = makeQuestion(decision, participant, { via: 'link' });
					return { decision, participantId: participant.id, run: () => answer(decider, decision, q.id) };
				}
			],
			[
				'(b) a live link whose latest record mail failed',
				(n) => {
					const { decision, decider } = opened();
					const { participant } = withLink(decision, `token-2721-${n}`);
					invited(decision, participant.id, false);
					const q = makeQuestion(decision, participant, { via: 'link' });
					return { decision, participantId: participant.id, run: () => answer(decider, decision, q.id) };
				}
			],
			[
				'(c) a live link whose latest record mail has no outcome yet',
				(n) => {
					const { decision, decider } = opened();
					const { participant } = withLink(decision, `token-2721-${n}`);
					invited(decision, participant.id);
					const q = makeQuestion(decision, participant, { via: 'link' });
					return { decision, participantId: participant.id, run: () => answer(decider, decision, q.id) };
				}
			],
			[
				'(d) a live link with no record mail at all',
				(n) => {
					const { decision, decider } = opened();
					const { participant } = withLink(decision, `token-2721-${n}`);
					const q = makeQuestion(decision, participant, { via: 'link' });
					return { decision, participantId: participant.id, run: () => answer(decider, decision, q.id) };
				}
			],
			[
				'(e) a live link past its time: closed, more than 90 days after closes_at',
				(n) => {
					const { decision, decider } = opened({ status: 'closed', closesAt: '2026-01-01 09:00:00' });
					const { participant } = withLink(decision, `token-2721-${n}`);
					invited(decision, participant.id, true);
					const q = makeQuestion(decision, participant, { via: 'link' });
					return { decision, participantId: participant.id, run: () => answer(decider, decision, q.id) };
				}
			],
			[
				"(f) the link cleared by a restore, the answer an agent's draft published",
				(n) => {
					const { decision, decider, author } = opened();
					const { participant } = withLink(decision, `token-2721-${n}`);
					invited(decision, participant.id, true);
					revokeLinks({ participantId: participant.id }, 'restore', SYSTEM_ACTOR);
					const q = makeQuestion(decision, participant, { via: 'link', answer: 'An agent says 10k.', by: decider, agentDrafted: true });
					return { decision, participantId: participant.id, run: () => publish(author, decision, q.id) };
				}
			],
			[
				"(g) the link cleared by a restore, the answer a person's in place of an agent's draft",
				(n) => {
					const { decision, decider, author } = opened();
					const { participant } = withLink(decision, `token-2721-${n}`);
					invited(decision, participant.id, true);
					revokeLinks({ participantId: participant.id }, 'restore', SYSTEM_ACTOR);
					const q = makeQuestion(decision, participant, { via: 'link', answer: 'An agent says 10k.', by: decider, agentDrafted: true });
					return { decision, participantId: participant.id, run: () => answer(author, decision, q.id, { answer: 'A person says 12k.', replacesDraft: true }) };
				}
			]
		];

		let n = 0;
		for (const [name, build] of rows) {
			const { decision, participantId, run } = build(++n);
			const hash = hashOf(participantId);
			await fresh();
			const issuedBefore = eventsOf(decision.id).filter((event) => event.kind === 'link_issued').length;
			run();
			expect(noticeOf(decision.id), name).toBe('asked');
			await sent.settle();
			const email = db.select().from(decisionParticipants).where(eq(decisionParticipants.id, participantId)).get()!.email;
			expect(answerMails().map((mail) => mail.to), name).toEqual([email]);
			const [mail] = answerMails();
			expect(mail.html, name).toContain(ASK_FOR_LINK_LINE);
			expect(mail.html, name).not.toContain(LATEST_LINK_LINE);
			expect(mail.html, name).not.toMatch(/\/decision-link\/|\/decisions\/|href=/);
			expect(eventsOf(decision.id).filter((event) => event.kind === 'link_issued').length, name).toBe(issuedBefore);
			expect(hashOf(participantId), name).toBe(hash);
		}
		expect(sent.duringTransaction).toEqual([]);
	});

	it('refuses a guarded update reported as changing nothing 409, rolling back the change it made, leaving no event and sending no mail, one row each (20)', async () => {
		const { decision, author, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const open = makeQuestion(decision, pat.participant);
		const drafted = makeQuestion(decision, pat.participant, { answer: 'A draft.', by: decider, agentDrafted: true });
		const another = makeQuestion(decision, pat.participant, { answer: 'Another draft.', by: decider, agentDrafted: true });
		await fresh();

		const rows: [string, typeof stub.noChange, () => unknown, string][] = [
			['(a) recordAnswer', 'recordAnswer', () => answer(author, decision, open.id), ANSWERED],
			['(b) recordDraftPublished', 'recordDraftPublished', () => publish(author, decision, drafted.id), ALREADY_PUBLISHED],
			['(c) recordDraftReplaced', 'recordDraftReplaced', () => answer(author, decision, another.id, { answer: 'Mine.', replacesDraft: true }), NO_DRAFT]
		];
		for (const [name, update, run, message] of rows) {
			const before = written();
			stub.noChange = update;
			expect(outcome(run), name).toEqual({ status: 409, message });
			stub.noChange = null;
			// The real update ran inside the write (code review F7): the row as it was is the rollback's work.
			expect(written(), name).toEqual(before);
			await sent.settle();
			expect(sent.emails, name).toEqual([]);
		}
	});

	it('puts no draft in the ruling mail or a record mail, ruled with an unpublished draft open (21)', async () => {
		const { decision, decider, a } = opened({ status: 'closed', closesAt: PAST });
		const pat = withAccount(decision, 'pat');
		const lia = withLink(decision, 'token-q21');
		makeQuestion(decision, pat.participant, { question: 'A question nobody mails?', answer: 'A draft nobody mails.', by: decider, agentDrafted: true });
		makeQuestion(decision, lia.participant, { question: 'Another question nobody mails?', via: 'link' });

		as(decider, (caller) =>
			ruleDecision(caller, { decisionId: decision.id }, { optionId: a.id, reason: 'A is enough.', revision: resultsRevisionFor(decision.id), openQuestionsConfirmed: true }, UI)
		);
		await vi.waitFor(() =>
			expect(eventsOf(decision.id).filter((event) => event.kind === 'mail_outcome')).toHaveLength(eventsOf(decision.id).filter((event) => event.kind === 'told_ruling').length)
		);
		await sent.settle();

		expect(sent.emails.length).toBeGreaterThan(0);
		for (const mail of sent.emails) {
			for (const absent of ['A draft nobody mails.', 'A question nobody mails?', 'Another question nobody mails?']) {
				expect(`${mail.subject}\n${mail.html}`, `${mail.to}: ${absent}`).not.toContain(absent);
			}
		}
	});

	it('is reached by no API v1 route for publishing or for a personal link (22)', () => {
		const root = join(process.cwd(), 'src/routes/api/v1');
		const files = (readdirSync(root, { recursive: true }) as string[]).filter((path) => /\.(ts|js)$/.test(path));
		expect(files.length).toBeGreaterThan(10);
		const reaching = files.filter((path) => /\b(publishAnswer|askQuestionByLink)\b/.test(readFileSync(join(root, path), 'utf8')));
		expect(reaching).toEqual([]);
	});
});

// ─── The page reads (slice 1c) ───────────────────────────────────────────────

/** Every key anywhere in `value`, with the value it holds. */
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

// The keys no answer of the page holds, anywhere in it, are card 2677's `NEVER_GIVEN`, the one list in the fixtures (code review F5).

describe('readDecisionPage and readLinkPage, with questions', () => {
	it('gives the page’s flags, one row each (23)', () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		withLink(decision, 'token-q23');
		const full = withAccount(decision, 'full');
		for (let n = 0; n < 10; n++) makeQuestion(decision, full.participant, { askedAt: '2026-11-01 10:00:00' });
		const reader = boardReader();
		const admin = makeUser({ role: 'admin', username: 'admin' });
		const ruled = opened();
		const rp = withAccount(ruled.decision, 'rp');
		makeRuling(ruled.decision, { ruledAt: stamp() });

		expect(readDecisionPage(pat.account, decision.id).mayAsk, '(a) a consulted participant, open').toBe(true);
		expect(readDecisionPage(rp.account, ruled.decision.id).mayAsk, '(b) ruled').toBe(false);
		expect(readLinkPage('token-q23', null)?.mayAsk, '(c) a link holder').toBe(true);
		expect(readDecisionPage(full.account, decision.id).mayAsk, '(d) after the 10th').toBe(false);
		expect(readDecisionPage(reader, decision.id).mayAsk, '(e) a board reader').toBe(false);
		expect(readDecisionPage(decider, decision.id).mayAnswer, '(f) the decider, open').toBe(true);
		expect(readDecisionPage(ruled.decider, ruled.decision.id).mayAnswer, '(g) ruled').toBe(false);
		expect(readDecisionPage(admin, decision.id).mayAnswer, '(h) an administrator').toBe(false);
		expect(readLinkPage('token-q23', null), 'no answer flag by a link').not.toHaveProperty('mayAnswer');
	});

	it('serialises no other asker, no moment, no id and no draft into a participant’s or a link holder’s load, and the names, ids and draft into the decider’s, one row each (24)', async () => {
		const { decision, author, decider } = opened();
		const pat = withAccount(decision, 'pat');
		const quin = withAccount(decision, 'quin');
		const lia = withLink(decision, 'token-q24');
		const admin = makeUser({ role: 'admin', username: 'admin' });
		const answered = makeQuestion(decision, pat.participant, { question: 'Mine?', answer: 'Yes.', by: author, role: 'author' });
		const drafted = makeQuestion(decision, quin.participant, {
			question: 'By an agent?',
			via: 'api',
			askedAt: '2026-11-02 10:01:00',
			answer: 'A draft nobody else sees.',
			by: decider,
			agentDrafted: true
		});
		const linked = makeQuestion(decision, lia.participant, { question: 'By link?', via: 'link', askedAt: '2026-11-02 10:02:00' });
		const others = [quin.participant.name, lia.participant.name, 'A draft nobody else sees.', drafted.askedAt, linked.askedAt];
		/** What a load's data serialises, and its questions, as `__data.json` carries them. */
		const load = async (path: string, user: SessionUser | null) => {
			const loaded = await pageLoad(path, user === null ? {} : { user });
			expect(loaded.type, path).toBe('data');
			const data = JSON.parse(JSON.stringify((loaded as { data: unknown }).data)) as { questions: Record<string, unknown>[] };
			expect(entriesIn(data).map(([key]) => key).filter((key) => NEVER_GIVEN.includes(key)), path).toEqual([]);
			return { text: JSON.stringify(data), questions: data.questions };
		};

		// (a) A participant: their own moment alone, no name, no "asked by an agent" but their own, no id and no draft.
		const forPat = await load(`/decisions/${decision.id}`, pat.account);
		for (const absent of others) expect(forPat.text, `(a) ${absent}`).not.toContain(absent);
		expect(forPat.questions.map((q) => Object.keys(q).filter((key) => ['id', 'askerName', 'askedAt', 'askedByAgent', 'draft'].includes(key))), '(a)').toEqual([['askedAt'], [], []]);
		expect(forPat.questions[0].askedAt, '(a)').toBe(answered.askedAt);

		// (b) A link holder: the same, by the link.
		const forLia = await load(`/decision-link/token-q24`, null);
		for (const absent of [pat.participant.name, quin.participant.name, 'A draft nobody else sees.', answered.askedAt, drafted.askedAt]) {
			expect(forLia.text, `(b) ${absent}`).not.toContain(absent);
		}
		expect(forLia.questions.map((q) => Object.keys(q).filter((key) => ['id', 'askerName', 'askedAt', 'askedByAgent', 'draft'].includes(key))), '(b)').toEqual([[], [], ['askedAt']]);

		// (c) The decider: names, ids and the draft.
		const forDecider = await load(`/decisions/${decision.id}`, decider);
		expect(forDecider.questions.map((q) => [q.id, q.askerName]), '(c)').toEqual([
			[answered.id, pat.participant.name],
			[drafted.id, quin.participant.name],
			[linked.id, lia.participant.name]
		]);
		expect(forDecider.questions[1].draft, '(c)').toEqual({ text: 'A draft nobody else sees.', drafterName: decider.username, draftedAt: '2026-11-02 11:00:00' });

		// (d) An administrator who is not the author (S11): names, and no ids.
		const forAdmin = await load(`/decisions/${decision.id}`, admin);
		expect(forAdmin.questions.map((q) => [q.id, q.askerName]), '(d)').toEqual([
			[undefined, pat.participant.name],
			[undefined, quin.participant.name],
			[undefined, lia.participant.name]
		]);
		expect(forAdmin.questions[1].draft, '(d)').toBeDefined();
	});
});

// ─── The routes (case 25, slice 2b) ─────────────────────────────────────────

describe('the four question routes', () => {
	// The first request through the harness starts SvelteKit's server for this file, as the other gate files warm it.
	beforeAll(async () => {
		await gateRoutes();
	}, 30_000);

	const ORIGIN = 'http://localhost';
	const ACCEPT = { accept: '*/*' };
	const SAME = { ...ACCEPT, 'sec-fetch-site': 'same-origin' };
	const sessionOf = (user: SessionUser) => ({ cookie: `${SESSION_COOKIE_NAME}=${makeSession(user)}` });

	it('25 (a): each of the four refuses a cross-site or non-JSON post before reading its body, and a same-origin post is answered by its handler', async () => {
		const { decision, decider } = opened();
		const pat = withAccount(decision, 'pat');
		withLink(decision, 'token-q25a');
		const open = makeQuestion(decision, pat.participant);
		const drafted = makeQuestion(decision, pat.participant, { answer: 'An agent drafted this.', by: decider, role: 'decider', agentDrafted: true });
		const routes = [
			{ path: `/api/decisions/${decision.id}/questions`, body: { question: 'Signed in?' }, session: sessionOf(pat.account) },
			{ path: '/api/decision-by-link/questions', body: { token: 'token-q25a', question: 'By link?' }, session: {} },
			{ path: `/api/decisions/${decision.id}/questions/${open.id}/answer`, body: { answer: 'About 10k.' }, session: sessionOf(decider) },
			{ path: `/api/decisions/${decision.id}/questions/${drafted.id}/publish`, body: {}, session: sessionOf(decider) }
		];
		const rows: [string, Record<string, string>, number, string][] = [
			['text/plain', { origin: ORIGIN, 'content-type': 'text/plain' }, 415, 'This route takes JSON only'],
			['no Content-Type', { origin: ORIGIN }, 415, 'This route takes JSON only'],
			['Sec-Fetch-Site: cross-site', { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'cross-site' }, 403, 'Cross-site requests are refused']
		];
		const before = written();
		for (const route of routes) {
			for (const [name, headers, status, message] of rows) {
				const res = await gate('POST', route.path, { headers: { ...ACCEPT, ...route.session, ...headers }, body: JSON.stringify(route.body) });
				expect({ status: res.status, body: await res.json() }, `${route.path} ${name}`).toEqual({ status, body: { message } });
			}
		}
		expect(written(), 'refused before the body').toEqual(before);

		// Same origin: each is answered by its handler, with the shape its service gives.
		const answers = [];
		for (const route of routes) {
			const res = await gate('POST', route.path, { headers: { ...SAME, ...route.session }, body: route.body });
			expect(res.status, `${route.path}: ${await res.clone().text()}`).toBe(200);
			expect(res.headers.get('cache-control'), route.path).toBe('no-store');
			answers.push(await res.json());
		}
		expect(answers[0]).toEqual({ question: { question: 'Signed in?', askedInVersion: 1, askedAt: expect.stringMatching(STAMPED) } });
		expect(answers[1]).toEqual({ question: { question: 'By link?', askedInVersion: 1, askedAt: expect.stringMatching(STAMPED) } });
		expect(answers[2].question).toMatchObject({ id: open.id, answer: { text: 'About 10k.', answererRole: 'decider', agentDrafted: false } });
		expect(answers[3].question).toMatchObject({ id: drafted.id, answer: { text: 'An agent drafted this.', agentDrafted: true } });
		await sent.settle();
	});

	it('25 (b, c): the link route counts a wrong link by address and the 21st is 429; a valid link’s 400, 409 and 429 are never counted', async () => {
		const { decision } = opened();
		withLink(decision, 'token-q25b');
		const ruled = opened();
		withLink(ruled.decision, 'token-q25-ruled');
		makeRuling(ruled.decision, { ruledAt: stamp() });
		const post = (token: string, question: string) => gate('POST', '/api/decision-by-link/questions', { headers: SAME, body: { token, question } });

		// (c) A valid link's refusals: an empty question, a question within the rest, and one on a ruled decision.
		const empty = await post('token-q25b', '   ');
		expect(empty.status).toBe(400);
		expect((await post('token-q25b', 'First?')).status).toBe(200);
		const rested = await post('token-q25b', 'Second?');
		expect(rested.status).toBe(429);
		const closed = await post('token-q25-ruled', 'After the ruling?');
		expect({ status: closed.status, body: await closed.json() }).toEqual({ status: 409, body: { message: QUESTIONS_CLOSED } });

		// (b) Twenty wrong links are each the one 404, so none of the three above was counted; the 21st is 429.
		for (let n = 1; n <= 20; n++) {
			const res = await post(`token-q25-never-${n}`, 'x');
			expect({ status: res.status, body: await res.json() }, `wrong link ${n}`).toEqual({ status: 404, body: { message: DEAD_DECISION_LINK } });
		}
		const limited = await post('token-q25-never-21', 'x');
		const wait = Number(limited.headers.get('retry-after'));
		expect(wait).toBeGreaterThan(0);
		expect({ status: limited.status, body: await limited.json() }).toEqual({ status: 429, body: { message: tooManyWrongLinks(wait) } });
		expect(limited.headers.get('referrer-policy')).toBe('no-referrer');
		await sent.settle();
	});
});
