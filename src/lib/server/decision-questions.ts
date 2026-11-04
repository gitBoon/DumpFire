/**
 * decision-questions.ts — what is read of a decision's clarification
 * questions (card 2678, decisions 2, 8, 15 and 19): the one projection of a
 * question for every viewer and both sources, and the rules the page and the
 * results ask of who may ask and who may answer now.
 *
 * Everyone included in a decision, the author, the decider and
 * administrators read every question (`questions`); a board reader, editor or
 * owner who is none of these reads none. Only the author, the decider and
 * administrators (`askers`) are given who asked and when, and only on the
 * page, never through an API key (S2); the asker is told which questions are
 * their own, and when they asked them. An agent's answer through an API key
 * is a draft that only the author, the decider and administrators see, until
 * a person publishes it or replaces it with their own: everyone else is
 * shown the question as open, and nothing of the draft (S1). A question's id
 * is given only to a viewer who may answer it now, and the answerer is named
 * with the role they held when they answered, as the answer's event recorded
 * it, never as who the author or decider is now (S7).
 *
 * The participant page's reach test lives here (`reachedParticipantOf`), so
 * that the page and `readQuestions`, which card 2682's API wraps, ask the
 * same rule (F2).
 *
 * A plain read module, not a service: it takes the signed-in account, `user:
 * SessionUser`, never `caller`, imports no `inWrite` and writes nothing, so
 * that a page load may call it (tests/check-at-the-write.test.ts, rule 4).
 * The writes are decisions.ts's.
 */
import { error } from '@sveltejs/kit';
import { and, eq, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import { db } from './db';
import { decisionParticipants, decisionQuestions, people, type Decision, type DecisionParticipant, type DecisionQuestion } from './db/schema';
import type { SessionUser } from './auth';
import { mayDo, type DecisionAccess } from './decision-access';
import { reachOf } from './decision-links';
import { accountHistory, eventsOfKind, questionsBy, questionsOf } from './decision-record';
import { linkUsable, TRANSITIONS } from './decision-status';
import { requireDecision } from './route-guards';
import { QUESTIONS_PER_PARTICIPANT } from '$lib/decision-rules';
import type { QuestionAnswer, QuestionView } from '$lib/decision-view-types';
import { NO_LONGER_REACHED } from '$lib/decision-words';
import { stamp, type Stamp } from '$lib/timestamps';

/** Who reads the questions, and through which tree: an account's access, or none by a personal link; and their own participant row. */
export type QuestionViewer = { access: DecisionAccess | null; participantId: number | null; source: 'ui' | 'api' };

/** The live participant row `participantId` of this decision, and how `reachOf` reaches it now; null for none. */
function liveRowOf(decision: Pick<Decision, 'id'>, participantId: number): { row: DecisionParticipant; via: 'account' | 'link' | null } | null {
	const row = db
		.select()
		.from(decisionParticipants)
		.where(and(eq(decisionParticipants.id, participantId), eq(decisionParticipants.decisionId, decision.id), isNull(decisionParticipants.removedAt)))
		.get();
	if (row === undefined) return null;
	const person = row.personId === null ? null : (db.select().from(people).where(eq(people.id, row.personId)).get() ?? null);
	const reach = reachOf(row, person, accountHistory(decision.id).get(row.id) ?? false);
	return { row, via: 'via' in reach ? reach.via : null };
}

/**
 * The caller's own participant row, if `reachOf` still reaches it through
 * their account (card 2677, D12; moved here from decision-view.ts by card
 * 2678, F2); null for none, a removed one, and one who has left or lost the
 * account or the address.
 */
export function reachedParticipantOf(decision: Pick<Decision, 'id'>, participantId: number | null): DecisionParticipant | null {
	if (participantId === null) return null;
	const live = liveRowOf(decision, participantId);
	return live !== null && live.via === 'account' ? live.row : null;
}

/**
 * Whether the participant may ask a question now (decisions 4 and 10): live,
 * reached (through their account, or by their personal link while it may be
 * used), on a decision stored open or closed, and with fewer than
 * `QUESTIONS_PER_PARTICIPANT` asked. The page offers no form otherwise.
 */
export function mayAskOf(decision: Decision, participant: DecisionParticipant | null, now: Stamp = stamp()): boolean {
	if (participant === null || participant.removedAt !== null) return false;
	if (!(TRANSITIONS.ask as readonly string[]).includes(decision.status)) return false;
	const live = liveRowOf(decision, participant.id);
	if (live === null || live.via === null) return false;
	if (live.via === 'link' && !linkUsable(decision, now)) return false;
	return questionsBy(participant.id).length < QUESTIONS_PER_PARTICIPANT;
}

/**
 * Whether the caller may answer the decision's questions now (decisions 1
 * and 10, F9): the author or the decider, with board edit while the board
 * exists (`answer`), on a decision stored open or closed. The page's answer
 * form, the results' link to it and a question's id all ask this.
 */
export function mayAnswerOf(decision: Decision, access: DecisionAccess | null): boolean {
	return access !== null && (TRANSITIONS.answer as readonly string[]).includes(decision.status) && mayDo(access, 'answer', decision);
}

/**
 * The role an answer is given in, fixed at the moment it is given (decision
 * 19, S7): the decider's, for an account that is both; the author's
 * otherwise. Asked only of a caller `answer` let in.
 */
export function answererRoleOf(access: DecisionAccess): 'author' | 'decider' {
	return access.roles.has('decider') ? 'decider' : 'author';
}

/**
 * The role each answer was given in, by question id, as its event recorded it
 * (decision 19): `question_answered`'s, and a replacement's after it. A
 * published draft keeps its `question_answered` role.
 */
function rolesOf(decisionId: number): Map<number, 'author' | 'decider'> {
	const roles = new Map<number, 'author' | 'decider'>();
	for (const kind of ['question_answered', 'answer_replaced'] as const) {
		for (const event of eventsOfKind(decisionId, kind)) {
			const { questionId, role } = event.detail;
			if (typeof questionId === 'number' && (role === 'author' || role === 'decider')) roles.set(questionId, role);
		}
	}
	return roles;
}

/** Whether a person stands behind the row's answer: their own, or an agent's draft a person published. */
const standsBehind = (row: DecisionQuestion) => row.answer !== null && (!row.answerAgentDrafted || row.answerReviewedAt !== null);

/**
 * Whether the row's answer is an agent's draft no person has published or
 * replaced yet (decision 8; code review F5): the one rule, which the writes in
 * decisions.ts ask of a row and `openQuestionWhere` states in SQL beside it.
 */
export const pendingDraft = (row: Pick<DecisionQuestion, 'answer' | 'answerAgentDrafted' | 'answerReviewedAt'>) =>
	row.answer !== null && row.answerAgentDrafted && row.answerReviewedAt === null;

/**
 * The question rows still open (decision 9), in SQL: no answer, or
 * `pendingDraft`'s rule, an answer that is an agent's draft with no review.
 * Built from the same three columns as `pendingDraft`, and held to agree with
 * it row for row by tests/decision-questions.test.ts, case 3 (code review F5).
 */
export const openQuestionWhere = (): SQL =>
	or(
		isNull(decisionQuestions.answer),
		and(isNotNull(decisionQuestions.answer), eq(decisionQuestions.answerAgentDrafted, true), isNull(decisionQuestions.answerReviewedAt))
	)!;

/**
 * The decision's questions as `viewer` is given them (decision 2), oldest
 * first; none for a viewer who may read none.
 *
 * `viewer.access` is a signed-in account's, and `participantId` its own live
 * row, counted only while `reachOf` reaches it through the account; or, by a
 * personal link, `access` is null and `participantId` the link's participant,
 * whom `participantForLink` found. The author, the decider (each with board
 * edit while the board exists) and administrators (`askers`) are given every
 * question with its draft, and, on the page, who asked and when; a
 * participant every question with no name, the moment only on their own, and
 * no draft; anyone else nothing.
 */
export function questionsFor(decision: Decision, viewer: QuestionViewer): QuestionView[] {
	const privileged = viewer.access !== null && mayDo(viewer.access, 'askers', decision);
	let own: number | null = null;
	if (viewer.participantId !== null) {
		if (viewer.access === null) {
			// A personal link's participant: still live on this decision.
			if (liveRowOf(decision, viewer.participantId) !== null) own = viewer.participantId;
		} else if (viewer.participantId === viewer.access.participantId && reachedParticipantOf(decision, viewer.participantId) !== null) {
			own = viewer.participantId;
		}
	}
	if (!privileged && own === null) return [];

	const named = privileged && viewer.source === 'ui';
	const ids = mayAnswerOf(decision, viewer.access);
	const roles = rolesOf(decision.id);
	const closedBy = decision.status === 'ruled' || decision.status === 'superseded' ? 'ruling' : decision.status === 'withdrawn' ? 'withdrawal' : null;

	return questionsOf(decision.id).map((row): QuestionView => {
		const mine = own !== null && row.participantId === own;
		const answer: QuestionAnswer | null = standsBehind(row)
			? {
					text: row.answer!,
					answererName: row.answeredByName ?? '',
					answererRole: roles.get(row.id) ?? null,
					// A published draft's moment is its publishing (decision 8).
					answeredAt: (row.answerAgentDrafted ? row.answerReviewedAt : row.answeredAt) ?? '',
					agentDrafted: row.answerAgentDrafted
				}
			: null;
		return {
			...(ids ? { id: row.id } : {}),
			question: row.question,
			askedInVersion: row.askedInVersion,
			own: mine,
			...(named ? { askerName: row.askerName } : {}),
			...(named || (mine && viewer.source === 'ui') ? { askedAt: row.askedAt } : {}),
			...(row.via === 'api' && (privileged || mine) ? { askedByAgent: true as const } : {}),
			answer,
			...(privileged && pendingDraft(row) ? { draft: { text: row.answer!, drafterName: row.answeredByName ?? '', draftedAt: row.answeredAt ?? '' } } : {}),
			closedUnanswered: answer === null ? closedBy : null,
			// Fail closed (code review S3): any source but the page's marks the text as a participant's words.
			...(viewer.source !== 'ui' ? { untrusted: true as const } : {})
		};
	});
}

/**
 * The questions of a decision for a signed-in account (decision 15), as
 * card 2682's API gives them (`source: 'api'`): 404 for a caller who may not
 * view it, 403 for one who may and reads no question, and 403
 * `NO_LONGER_REACHED` for a participant `reachOf` no longer reaches through
 * their account who holds no other role that reads them. Then `questionsFor`.
 */
export function readQuestions(user: SessionUser, decisionId: number, opts: { source: 'ui' | 'api' }): QuestionView[] {
	const { decision, access } = requireDecision(user, decisionId, 'questions');
	const reached = reachedParticipantOf(decision, access.participantId);
	if (reached === null && !mayDo(access, 'askers', decision)) error(403, NO_LONGER_REACHED);
	return questionsFor(decision, { access, participantId: reached?.id ?? null, source: opts.source });
}
