/**
 * decision-question-writes.ts — a participant's clarification questions
 * (`askQuestion`, `askQuestionByLink`) and the author's or decider's answers
 * to them (`answerQuestion`, `publishAnswer`) (card 2678), beside
 * decision-questions.ts, which reads them. Card 2713 moved them here from the
 * former decision service, unchanged (D1).
 *
 * Card 2678 adds a participant's clarification questions and their answers:
 * a question (`askQuestion`, signed in or through an API key, and
 * `askQuestionByLink`, a person's act alone, sharing `questionAs`), and the
 * author's or decider's answer (`answerQuestion`), which through an API key is
 * an agent's draft that a person publishes (`publishAnswer`) or replaces with
 * their own (`answerQuestion` with `replacesDraft`), each a person's act
 * alone. A question tells whoever may answer it now, and an answer a person
 * stands behind tells the asker, by notices that name nobody and quote
 * nothing, sent after the commit (`questionNoticesOf`, `answerNoticeOf`). Each
 * settling of an answer is a guarded update that a 409 ends when it changes
 * nothing. No activity entry, live event or webhook (design S3).
 *
 * Card 2682 adds the API v1 routes, which call `askQuestion` and
 * `answerQuestion` with `source: 'api'`. Through a key an answer is an agent's
 * draft, and a key is refused a question by a personal link (S5), publishing
 * a draft and replacing one (decision 8).
 *
 * Each write has the one shape of a service, and the record is written as
 * decision-write-shared.ts's header says.
 */
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { decisionParticipants, users, type Decision, type DecisionParticipant, type DecisionQuestion } from './db/schema';
import type { SessionUser } from './auth';
import { decisionAccess, mayDo, type DecisionAccess } from './decision-access';
import { readMultiline } from './decision-content';
import {
	actorFor,
	appendEvent,
	appendQuestion,
	eventsOfKind,
	questionOn,
	questionsAskedSince,
	questionsBy,
	questionsOf,
	recordAnswer,
	recordDraftPublished,
	recordDraftReplaced,
	type RecordActor
} from './decision-record';
import { answererRoleOf, pendingDraft, questionsFor } from './decision-questions';
import { mailedLinkOf } from './decision-links';
import { DAY_MS, dailyCapFrom, decisionLinkBase, later, RECORD_MAIL_MIN_MINUTES } from './decision-mail';
import { DECISION_ACTION_WORDS, requireTransition } from './decision-status';
import { isSmtpConfigured } from './email';
import { notifyDecisionQuestion, notifyQuestionAnswered, shouldNotifyUser } from './notifications';
import { takeAllowance } from './rate-limit';
import { readBoolean, type RequestBody } from './request-body';
import { DECISION_TEXT_MAX, QUESTION_TEXT_MAX, QUESTIONS_PER_PARTICIPANT } from '$lib/decision-rules';
import type { OwnQuestion, QuestionView } from '$lib/decision-view-types';
import {
	ALREADY_PUBLISHED,
	ANSWERED,
	DRAFT_PENDING,
	NO_DRAFT,
	NOTHING_TO_PUBLISH,
	PERSON_ANSWERED,
	QUESTIONS_CLOSED,
	questionsLimitWords
} from '$lib/decision-words';
import { requireDecision, requireUser } from './route-guards';
import { stamp, type Stamp } from '$lib/timestamps';
import { inWrite, type ServiceOptions } from './write-as';
import { dayBefore, keyed, participantOn, reachesOf, requireLinkHolder, requireReachedByAccount, sourceOf } from './decision-write-shared';

/** None of the question writes has a guard of its own: every export here is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = [];

// ─── Clarification questions and their answers (card 2678) ───────────────────

// The most questions one participant asks on one decision (decision 4) is `$lib/decision-rules.ts`'s `QUESTIONS_PER_PARTICIPANT`, which
// the page asks too, so that it offers no form past it.

/** The most questions one decision takes, from everyone (decision 4): the page draws every one. */
const QUESTIONS_PER_DECISION = 200;

/** The most questions one account asks, signed in or through an API key, across every decision, in 24 hours (decision 4, S10). */
const QUESTIONS_PER_CALLER_DAILY = 30;

/** The 403 for a question by a personal link through an API key (S5): a personal link is no API credential. */
const LINK_QUESTION_ACT = "Asking by a personal link is a person's act: it cannot be done with an API key";

/** The 403 for publishing an agent's draft through an API key (decision 8): publishing is the review. */
const PUBLISH_ACT = "Publishing an agent's answer is a person's act: it cannot be done with an API key";

/** The 403 for replacing an agent's draft through an API key (decision 8). */
const REPLACE_ACT = "Replacing an agent's answer is a person's act: it cannot be done with an API key";

/**
 * A participant's clarification question, signed in or through an API key
 * (card 2678, decisions 1 and 17): the body of `questionAs`. 403 for a caller
 * who is no participant, and for one `reachOf` no longer reaches through their
 * account (D12). A participant kept informed may ask. Through an API key the
 * question is the key's own account's, recorded `via: 'api'`. Answers the
 * question as `OwnQuestion`, with no id.
 */
export function askQuestion(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): { question: OwnQuestion } {
	inWrite();
	const user = requireUser(caller);
	const { decision, access } = requireDecision(user, at.decisionId, 'ask');
	if (access.participantId === null) error(403, `You cannot ${DECISION_ACTION_WORDS.ask.verb} this decision`);
	const participant = participantOn(decision.id, access.participantId);
	requireReachedByAccount(decision.id, participant);

	// Fail closed (code review S3): only the page's own source is recorded as a session.
	return questionAs(decision, participant, body, actorFor(user, sourceOf(opts)), keyed(opts) ? 'api' : 'session', null, user, sourceOf(opts));
}

/**
 * A link holder's clarification question (card 2678, decisions 13 and 17):
 * the token decides, through `participantForLink`, and any link that opens no
 * decision is the one 404. A person's act alone (S5): 403 unless `source:
 * 'ui'`. Recorded `via: 'link'` with source `link`; a signed-in browser's
 * account is noted as `signedIn`, never as the asker. No per-caller cap: a
 * link holder has no account, and the per-participant cap holds them.
 */
export function askQuestionByLink(caller: SessionUser | null, at: { token: string }, body: RequestBody, opts: ServiceOptions): { question: OwnQuestion } {
	inWrite();
	const { decision, participant, by, signedIn } = requireLinkHolder(at.token, caller);
	if (keyed(opts)) error(403, LINK_QUESTION_ACT);

	return questionAs(decision, participant, body, by, 'link', signedIn, null, sourceOf(opts));
}

/**
 * The author's or the decider's answer to a question of the decision (card
 * 2678, decisions 7, 8, 17 and 19), or, with `replacesDraft: true`, a
 * person's answer in place of an agent's draft. The body: `answer`, required,
 * trimmed, 1 to 4,000 characters, with no control character (400); and
 * `replacesDraft`, true or false. In decision 17's order: the guard (404,
 * 403), 403 for `replacesDraft` through an API key, 404 for a question not on
 * this decision, the body's 400, the status's 409 (open or closed), and the
 * state's 409: answered, a draft waiting without `replacesDraft`
 * (`DRAFT_PENDING`), or `replacesDraft` with none (`NO_DRAFT`).
 *
 * Through an API key the answer is an agent's draft, which only the author,
 * the decider and administrators see and the asker is not told of
 * (`awaiting_review`). A replacement copies the draft into the record's
 * `answer_replaced` before it is overwritten. The row is settled by a guarded
 * update, and one that changes nothing is a 409 that rolls the write back.
 * The answerer's role is fixed now, on the event. Answers the question as the
 * caller is given it.
 */
export function answerQuestion(
	caller: SessionUser | null,
	at: { decisionId: number; questionId: number },
	body: RequestBody,
	opts: ServiceOptions
): { question: QuestionView } {
	inWrite();
	const user = requireUser(caller);
	const { decision, access } = requireDecision(user, at.decisionId, 'answer');
	// A key may only draft (decision 8): putting a person's answer in place of an agent's is a person's act.
	if (keyed(opts) && body.replacesDraft !== undefined && body.replacesDraft !== false) error(403, REPLACE_ACT);
	const row = requireQuestion(decision, at.questionId);
	const answer = readMultiline(body.answer, 'answer', DECISION_TEXT_MAX, { trim: true });
	if (answer === '') error(400, 'answer is required');
	const replacesDraft = readBoolean(body, 'replacesDraft', {}) ?? false;

	requireTransition(decision, 'answer', stamp());
	const drafted = pendingDraft(row);
	if (replacesDraft && !drafted) error(409, NO_DRAFT);
	if (!replacesDraft && row.answer !== null) error(409, drafted ? DRAFT_PENDING : ANSWERED);

	const by = actorFor(user, sourceOf(opts));
	const role = answererRoleOf(access);
	if (replacesDraft) {
		const discarded = { text: row.answer, byName: row.answeredByName, at: row.answeredAt };
		if (!recordDraftReplaced(row.id, answer, by)) error(409, NO_DRAFT);
		const notice = answerNoticeOf(decision, row);
		appendEvent({ decisionId: decision.id, kind: 'answer_replaced', detail: { questionId: row.id, role, discarded, notice: notice.outcome } }, by);
		const replaced = answererViewOf(decision, access, row.id, sourceOf(opts));
		if (notice.outcome === 'asked') notifyQuestionAnswered(notice.to, decision.id, decision.title);
		return { question: replaced };
	}

	// Fail closed (code review S3): any source but the page's drafts, and a person must stand behind it.
	const agentDrafted = keyed(opts);
	if (!recordAnswer(row.id, answer, by, agentDrafted)) error(409, ANSWERED);
	// Decision 8: an agent's draft is not mailed until a person stands behind it.
	const notice = agentDrafted ? { outcome: 'awaiting_review' as const } : answerNoticeOf(decision, row);
	appendEvent({ decisionId: decision.id, kind: 'question_answered', detail: { questionId: row.id, role, agentDrafted, notice: notice.outcome } }, by);
	const answered = answererViewOf(decision, access, row.id, sourceOf(opts));
	if (notice.outcome === 'asked') notifyQuestionAnswered(notice.to, decision.id, decision.title);
	return { question: answered };
}

/**
 * Publish an agent's draft answer (card 2678, decisions 8 and 17): the
 * review, by the author or the decider, signed in alone (403 through an API
 * key). The text cannot change in it. 404 for a question not on this
 * decision; the status's 409; and 409 for a question with no answer, one a
 * person answered (a replaced draft among them) and a draft published
 * already. The row is settled by a guarded update (a 409 when it changes
 * nothing), `answer_published` recorded, and the asker told. It takes no body.
 */
export function publishAnswer(
	caller: SessionUser | null,
	at: { decisionId: number; questionId: number },
	body: null,
	opts: ServiceOptions
): { question: QuestionView } {
	inWrite();
	const user = requireUser(caller);
	const { decision, access } = requireDecision(user, at.decisionId, 'answer');
	if (keyed(opts)) error(403, PUBLISH_ACT);
	const row = requireQuestion(decision, at.questionId);

	requireTransition(decision, 'answer', stamp());
	if (row.answer === null) error(409, NOTHING_TO_PUBLISH);
	if (!row.answerAgentDrafted) error(409, PERSON_ANSWERED);
	if (row.answerReviewedAt !== null) error(409, ALREADY_PUBLISHED);

	const by = actorFor(user, sourceOf(opts));
	if (!recordDraftPublished(row.id, by)) error(409, ALREADY_PUBLISHED);
	const notice = answerNoticeOf(decision, row);
	appendEvent({ decisionId: decision.id, kind: 'answer_published', detail: { questionId: row.id, notice: notice.outcome } }, by);
	const published = answererViewOf(decision, access, row.id, sourceOf(opts));
	if (notice.outcome === 'asked') notifyQuestionAnswered(notice.to, decision.id, decision.title);
	return { question: published };
}

// ─── Inside the writes ───────────────────────────────────────────────────────
// Those more than one decision service shares are decision-write-shared.ts's (card 2713, D2).

/**
 * A clarification question, from either way in (card 2678, decisions 3, 4,
 * 10 and 17). The body: `question`, required, trimmed, 1 to 2,000
 * characters, with no control, direction or invisible character (400). Then
 * 409 on a ruled decision (`QUESTIONS_CLOSED`, pointing to a concern), and for
 * any status but open and closed in `requireTransition`'s words; 409 for the
 * participant's 11th question and the decision's 201st; 429 within 10 minutes
 * of the participant's last, saying from when, in UTC; and, for an account
 * (`account`, signed in or a key's), 429 for its 31st in 24 hours across
 * decisions: counted from the record, then from an allowance held in memory,
 * taken last so that a refused question never spends it, and which deleting a
 * decision does not give back (S10).
 *
 * Writes the row (the participant's snapshot name, the current version, via
 * the way in), `question_asked { questionId, notices }` naming the
 * participant, and, last, a notice after the commit for each who may answer
 * now and was `asked`. No activity entry, no live event (design S3). Mail
 * never refuses a question.
 */
function questionAs(
	decision: Decision,
	participant: DecisionParticipant,
	body: RequestBody,
	by: RecordActor,
	via: 'session' | 'link' | 'api',
	signedIn: { userId: number; name: string } | null,
	account: SessionUser | null,
	source: ServiceOptions['source']
): { question: OwnQuestion } {
	const question = readMultiline(body.question, 'question', QUESTION_TEXT_MAX, { trim: true });
	if (question === '') error(400, 'question is required');

	const now = stamp();
	// S9: a ruled decision's own words, pointing to a concern; a superseded or withdrawn one in the status's, which point to none.
	if (decision.status === 'ruled') error(409, QUESTIONS_CLOSED);
	requireTransition(decision, 'ask', now);
	const theirs = questionsBy(participant.id);
	if (theirs.length >= QUESTIONS_PER_PARTICIPANT) error(409, questionsLimitWords(QUESTIONS_PER_PARTICIPANT));
	if (questionsOf(decision.id).length >= QUESTIONS_PER_DECISION) {
		error(409, `This decision has ${QUESTIONS_PER_DECISION} questions: no more can be asked. Ask the decider directly`);
	}
	const last = theirs.at(-1);
	const rested = last === undefined ? null : later(last.askedAt, RECORD_MAIL_MIN_MINUTES * 60 * 1000);
	if (rested !== null && now < rested) {
		error(429, `Your last question was asked less than ${RECORD_MAIL_MIN_MINUTES} minutes ago: the next can be asked from ${rested} UTC`);
	}
	if (account !== null) requireQuestionAllowed(account, now);

	const row = appendQuestion({
		decisionId: decision.id,
		participantId: participant.id,
		askerName: participant.name,
		question,
		askedInVersion: decision.currentVersion,
		via
	});
	const notices = questionNoticesOf(decision, participant, account, now);
	appendEvent(
		{
			decisionId: decision.id,
			kind: 'question_asked',
			participantId: participant.id,
			versionNumber: decision.currentVersion,
			detail: {
				questionId: row.id,
				notices: notices.map((notice) => ({ userId: notice.userId, outcome: notice.outcome })),
				...(signedIn === null ? {} : { signedIn })
			}
		},
		by
	);
	for (const notice of notices) if (notice.outcome === 'asked') notifyDecisionQuestion(notice.userId, decision.id, decision.title, notice.heldBefore);
	// Code review S2: through any source but the page's, no moment, and the text marked as a participant's words.
	if (source !== 'ui') return { question: { question: row.question, askedInVersion: row.askedInVersion, untrusted: true } };
	return { question: { question: row.question, askedInVersion: row.askedInVersion, askedAt: row.askedAt } };
}

/**
 * A 429 once the account has asked `QUESTIONS_PER_CALLER_DAILY` questions in
 * the last 24 hours, on any decision (card 2678, decision 4, S10): read from
 * its `question_asked` events, and then, last of all, from an allowance held
 * in memory, which a deletion of the decisions, and their events with them,
 * does not give back. As the dry run's cap.
 */
function requireQuestionAllowed(user: SessionUser, now: Stamp): void {
	const words = (from: Stamp) => `You have asked ${QUESTIONS_PER_CALLER_DAILY} questions in the last 24 hours: the next can be asked from ${from} UTC`;
	const fromEvents = dailyCapFrom(questionsAskedSince(user.id, dayBefore()), QUESTIONS_PER_CALLER_DAILY);
	if (fromEvents !== null && now < fromEvents) error(429, words(fromEvents));
	const took = takeAllowance(`decision-question:${user.id}`, 1, QUESTIONS_PER_CALLER_DAILY, DAY_MS);
	if (!took.taken) error(429, words(stamp(new Date(Date.now() + took.retryAfterSecs * 1000))));
}

/** A new question's notice to one who may answer it, as decided inside the write: `asked` carries how many were held before it. */
type QuestionNotice = { userId: number; outcome: 'no_link_address' | 'prefs_off' | 'no_mail_host' | 'held' | 'asked'; heldBefore: number };

/**
 * Whom a new question from `participant` tells, and how (card 2678, decision
 * 5, S6), decided inside the write: the decider and the author, once each for
 * one account, each only while the account is there and `answer` lets it in
 * now (board edit), and never the asker's own account (`account`, or the
 * participant's). For each, in order: `no_link_address` with no App URL or
 * `ORIGIN`; `prefs_off` when their `email_decisions` or every mail is
 * switched off; `no_mail_host` with no mail host; `held` within 24 hours of
 * the last notice about this participant to them; and `asked` otherwise,
 * carrying how many of this participant's were held for them since. Only
 * `asked` holds the next one back. Per participant, so another's question
 * never holds back a first notice. Empty: nobody may answer now.
 */
function questionNoticesOf(decision: Decision, participant: DecisionParticipant, account: SessionUser | null, now: Stamp): QuestionNotice[] {
	const askers = new Set([participant.userId, account?.id ?? null].filter((id): id is number => id !== null));
	const recipients = [...new Set([decision.deciderUserId, decision.authorUserId].filter((id): id is number => id !== null))];
	const earlier = eventsOfKind(decision.id, 'question_asked').filter((event) => event.participantId === participant.id);
	const notices: QuestionNotice[] = [];
	for (const userId of recipients) {
		if (askers.has(userId)) continue;
		const recipient = db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, userId)).get();
		if (recipient === undefined || !mayDo(decisionAccess(recipient, decision), 'answer', decision)) continue;
		notices.push({ userId, ...questionNoticeFor(userId, earlier, now) });
	}
	return notices;
}

/** One recipient's outcome of a new question's notice, from the participant's earlier `question_asked` events (`questionNoticesOf`). */
function questionNoticeFor(userId: number, earlier: { detail: Record<string, unknown>; at: Stamp }[], now: Stamp): Omit<QuestionNotice, 'userId'> {
	if (decisionLinkBase() === null) return { outcome: 'no_link_address', heldBefore: 0 };
	if (!shouldNotifyUser(userId, 'email_decisions')) return { outcome: 'prefs_off', heldBefore: 0 };
	// As the concern's notice (2679's code review F2): with no mail host nothing would be sent, so nothing holds the next one back.
	if (!isSmtpConfigured()) return { outcome: 'no_mail_host', heldBefore: 0 };
	const outcomes = earlier.map((event) => {
		const sent = Array.isArray(event.detail.notices) ? (event.detail.notices as unknown[]) : [];
		const mine = sent.find((entry) => entry !== null && typeof entry === 'object' && (entry as { userId?: unknown }).userId === userId);
		return mine === undefined ? null : (mine as { outcome?: unknown }).outcome;
	});
	const lastAsked = outcomes.lastIndexOf('asked');
	if (lastAsked !== -1) {
		const rested = later(earlier[lastAsked].at, DAY_MS);
		if (rested === null || now < rested) return { outcome: 'held', heldBefore: 0 };
	}
	return { outcome: 'asked', heldBefore: outcomes.slice(lastAsked + 1).filter((outcome) => outcome === 'held').length };
}

/**
 * Whether an answer a person now stands behind tells the asker (card 2678,
 * decision 5), decided inside the write: `not_reached` for a participant
 * removed, or one `reachOf` skips; an account holder `no_link_address`,
 * `prefs_off`, `no_mail_host`, or `asked` to their account; a link holder
 * `no_mail_host`, or `asked` to the participant's snapshot address, which no
 * preference governs, and never to an account a browser beside their link
 * was signed in as. No rest: each question is answered once.
 *
 * A link holder's notice issues no link (card 2721, D1). `latestLink` is
 * whether it may tell them to use the one in their latest email:
 * `mailedLinkOf`, the closing-date reminder's rule, on the write's clock (D2,
 * D4). Otherwise it tells them to ask for a new one (D3).
 */
function answerNoticeOf(
	decision: Decision,
	row: DecisionQuestion
):
	| { outcome: 'not_reached' | 'no_link_address' | 'prefs_off' | 'no_mail_host' }
	| { outcome: 'asked'; to: { userId: number } | { address: string; latestLink: boolean } } {
	if (row.participantId === null) return { outcome: 'not_reached' };
	const participant = db
		.select()
		.from(decisionParticipants)
		.where(and(eq(decisionParticipants.id, row.participantId), eq(decisionParticipants.decisionId, decision.id)))
		.get();
	if (participant === undefined || participant.removedAt !== null) return { outcome: 'not_reached' };
	const reach = reachesOf(decision.id, [participant]).get(participant.id)!;
	if (!('via' in reach)) return { outcome: 'not_reached' };
	if (reach.via === 'account' && participant.userId !== null) {
		if (decisionLinkBase() === null) return { outcome: 'no_link_address' };
		if (!shouldNotifyUser(participant.userId, 'email_decisions')) return { outcome: 'prefs_off' };
		if (!isSmtpConfigured()) return { outcome: 'no_mail_host' };
		return { outcome: 'asked', to: { userId: participant.userId } };
	}
	if (!isSmtpConfigured()) return { outcome: 'no_mail_host' };
	return { outcome: 'asked', to: { address: participant.email, latestLink: mailedLinkOf(decision, participant, stamp()) !== null } };
}

/** The question of this decision, or 404 for one that is not on it (card 2678, decision 17). */
function requireQuestion(decision: Decision, questionId: number): DecisionQuestion {
	const row = questionOn(decision.id, questionId);
	if (row === null) error(404, 'Question not found');
	return row;
}

/** The question as the answerer is given it now, after their write: through the one projection (decision 2). */
function answererViewOf(decision: Decision, access: DecisionAccess, questionId: number, source: ServiceOptions['source']): QuestionView {
	const view = questionsFor(decision, { access, participantId: access.participantId, source }).find((question) => question.id === questionId);
	if (view === undefined) error(500, 'The answered question could not be read back');
	return view;
}
