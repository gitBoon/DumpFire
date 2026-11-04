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
 * Card 2680 (decision 12) extracts the projection of one row,
 * `questionViewOf`, so that a person record shows a participant's questions
 * by the same rule: `questionsOfParticipations`, `'own'` as the participant
 * page gives them their own, and `'privileged'` as the author, the decider
 * and administrators are given them, for a whole page of participations in
 * two reads (its code review's F2).
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
import { accountHistory, eventsOfKindsOn, questionsBy, questionsByParticipants, questionsOf } from './decision-record';
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
	return rolesOfDecisions([decisionId]);
}

/**
 * `rolesOf` for many decisions in one read (card 2680 code review, F2), by
 * question id, which no two decisions share: every `question_answered` first,
 * then every `answer_replaced`, each in id order, so that a replacement's
 * role stands over the answer it replaced.
 */
function rolesOfDecisions(decisionIds: readonly number[]): Map<number, 'author' | 'decider'> {
	const roles = new Map<number, 'author' | 'decider'>();
	const events = eventsOfKindsOn(decisionIds, ['question_answered', 'answer_replaced']);
	for (const kind of ['question_answered', 'answer_replaced'] as const) {
		for (const event of events) {
			if (event.kind !== kind) continue;
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

	const ctx: QuestionViewContext = {
		own,
		privileged,
		ids: mayAnswerOf(decision, viewer.access),
		roles: rolesOf(decision.id),
		closedBy: closedByOf(decision),
		source: viewer.source
	};
	return questionsOf(decision.id).map((row) => questionViewOf(row, ctx));
}

/**
 * What `questionViewOf` projects a question row for (card 2680, decision 12):
 * the viewer's own participant row, or null; whether they see who asked and
 * the drafts (`askers`); whether they are given its id (they may answer it
 * now); the role each answer was given in; what closed the questions, if
 * anything; and the tree. `upTo`, where it is given, shows an answer only
 * when it was given at or before that moment.
 */
export type QuestionViewContext = {
	own: number | null;
	privileged: boolean;
	ids: boolean;
	roles: ReadonlyMap<number, 'author' | 'decider'>;
	closedBy: QuestionView['closedUnanswered'];
	source: 'ui' | 'api';
	upTo?: Stamp;
};

/** What closed a decision's questions unanswered: its ruling (or supersession), its withdrawal, or nothing yet. */
function closedByOf(decision: Pick<Decision, 'status'>): QuestionView['closedUnanswered'] {
	return decision.status === 'ruled' || decision.status === 'superseded' ? 'ruling' : decision.status === 'withdrawn' ? 'withdrawal' : null;
}

/**
 * The one projection of a question row (card 2678, decision 2; extracted
 * unchanged from `questionsFor` by card 2680, decision 12): every field the
 * viewer is not given is left out. `questionsFor` and
 * `questionsOfParticipations` call it.
 */
export function questionViewOf(row: DecisionQuestion, ctx: QuestionViewContext): QuestionView {
	const mine = ctx.own !== null && row.participantId === ctx.own;
	const named = ctx.privileged && ctx.source === 'ui';
	// A published draft's moment is its publishing (decision 8).
	const answeredAt = (row.answerAgentDrafted ? row.answerReviewedAt : row.answeredAt) ?? '';
	const inTime = ctx.upTo === undefined || (answeredAt !== '' && answeredAt <= ctx.upTo);
	const answer: QuestionAnswer | null =
		standsBehind(row) && inTime
			? {
					text: row.answer!,
					answererName: row.answeredByName ?? '',
					answererRole: ctx.roles.get(row.id) ?? null,
					answeredAt,
					agentDrafted: row.answerAgentDrafted
				}
			: null;
	return {
		...(ctx.ids ? { id: row.id } : {}),
		question: row.question,
		askedInVersion: row.askedInVersion,
		own: mine,
		...(named ? { askerName: row.askerName } : {}),
		...(named || (mine && ctx.source === 'ui') ? { askedAt: row.askedAt } : {}),
		...(row.via === 'api' && (ctx.privileged || mine) ? { askedByAgent: true as const } : {}),
		answer,
		...(ctx.privileged && pendingDraft(row) ? { draft: { text: row.answer!, drafterName: row.answeredByName ?? '', draftedAt: row.answeredAt ?? '' } } : {}),
		closedUnanswered: answer === null ? ctx.closedBy : null,
		// Fail closed (code review S3): any source but the page's marks the text as a participant's words.
		...(ctx.source !== 'ui' ? { untrusted: true as const } : {})
	};
}

/**
 * The questions each participation's participant asked, by participant id,
 * for a page of a person record at once (card 2680, decisions 9, 12 and 14;
 * batched by its code review's F2): the questions in one read, and the role
 * each answer was given in in one read, however many participations the page
 * holds.
 *
 *   - `'own'`: as the participant page gives them their own (decision 12):
 *     `own: true`, no privilege, no id, no asker's name, no draft; the answer
 *     only where a person stands behind it. With `upTo`, the moment the
 *     participant was removed from a decision they may no longer view
 *     (decision 14, S2), an answer only where it was given at or before it,
 *     and nothing of what closed the questions, which would say what became
 *     of the decision.
 *   - `'privileged'`: as the author, the decider and administrators are given
 *     them (decision 9): who asked and when on the page, and an agent's draft;
 *     never an id, which only the decision's page gives, to one who may
 *     answer it now.
 */
export function questionsOfParticipations(
	rows: readonly { decision: Decision; participantId: number; upTo?: Stamp }[],
	audience: 'own' | 'privileged',
	source: 'ui' | 'api'
): Map<number, QuestionView[]> {
	const roles = rolesOfDecisions(rows.map((row) => row.decision.id));
	const asked = questionsByParticipants(rows.map((row) => row.participantId));
	const found = new Map<number, QuestionView[]>();
	for (const { decision, participantId, upTo } of rows) {
		const ctx: QuestionViewContext =
			audience === 'own'
				? {
						own: participantId,
						privileged: false,
						ids: false,
						roles,
						closedBy: upTo === undefined ? closedByOf(decision) : null,
						source,
						...(upTo === undefined ? {} : { upTo })
					}
				: { own: null, privileged: true, ids: false, roles, closedBy: closedByOf(decision), source };
		found.set(
			participantId,
			(asked.get(participantId) ?? []).map((row) => questionViewOf(row, ctx))
		);
	}
	return found;
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
