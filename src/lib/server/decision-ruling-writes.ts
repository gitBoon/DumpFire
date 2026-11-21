/**
 * decision-ruling-writes.ts — the ruling (`ruleDecision`), the release of
 * results (`releaseResults`), superseding a ruled decision with a draft
 * (`supersedeDecision`), and a participant's concern about the ruling
 * (`raiseConcern`, `raiseConcernByLink`) (card 2679), with the guards of the
 * ruling and the release (`READS`). Card 2713 moved them here from the
 * former decision service, unchanged (D1).
 *
 * The ruling and the release are a person's acts alone (`source: 'ui'`), and
 * their guards (`decisionRuleGuard`, `resultsReleaseGuard`, on `READS`) make
 * every refusal, so that their routes can ask for the caller's password after
 * them. A participant's concern about the ruling (`raiseConcern`,
 * `raiseConcernByLink`, sharing `concernAs`) is a response row of its own
 * kind, a person's act alone, which tells the decider by a notice that names
 * nobody, at most once a day for each participant (decisions 3 and 4).
 *
 * Card 2682 adds the API v1 routes, which call `supersedeDecision` with
 * `source: 'api'`.
 *
 * Each write has the one shape of a service, and the record, the activity
 * entry, the live event and the mail are written as decision-write-shared.ts's
 * header says.
 */
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db, sqlite } from './db';
import { boards, decisionOptions, decisionSurveyQuestions, decisionVersions, decisions, users, type Decision, type DecisionParticipant } from './db/schema';
import type { SessionUser } from './auth';
import { canEditBoard } from './board-access';
import { decisionAccess, mayDo } from './decision-access';
import { allOptionsOf, parseVersionContent, readMultiline, readTitle, workingFromVersion, CONTENT_LIMITS } from './decision-content';
import {
	actorFor,
	appendEvent,
	appendResponse,
	appendRuling,
	concernsOf,
	currentRound,
	eventsOfKind,
	hasSeen,
	liveOptionIds,
	responsesOf,
	supersedingOf,
	type RecordActor
} from './decision-record';
import { commentKeysOf, currentResultsOf, releaseRefusals, resultsRevisionFor, rulingRefusals, versionOptionsOf } from './decision-results';
import { DAY_MS, decisionLinkBase, later, queueRecordMails, RECORD_MAIL_MIN_MINUTES } from './decision-mail';
import { DECISION_ACTION_WORDS, decisionStatus, linkUsable, requireTransition, rulesEarly } from './decision-status';
import { isSmtpConfigured } from './email';
import { emit } from './events';
import { ACTIONS, logActivity } from './logActivity';
import { notifyDecisionConcern, shouldNotifyUser } from './notifications';
import { readBoolean, readId, readList, readText, type RequestBody } from './request-body';
import { againstOf, CONCERNS_PER_PARTICIPANT, DECISION_TEXT_MAX, mostChosenOf } from '$lib/decision-rules';
import type { OwnConcern } from '$lib/decision-view-types';
import { CONCERN_SUPERSEDED, CONCERN_WINDOW_ENDED, STALE_REVISION } from '$lib/decision-words';
import { requireDecision, requireUser } from './route-guards';
import { stamp, type Stamp } from '$lib/timestamps';
import { inWrite, type ServiceOptions } from './write-as';
import {
	COMMENT_MAX,
	decisionEntry,
	keyed,
	MOST_PARTICIPANTS,
	participantOn,
	requireLinkHolder,
	requireDeciderRecordable,
	requireReachedByAccount,
	sourceOf
} from './decision-write-shared';
import { ACCESS_KIND, recordAccessChange } from './access-changes';

/**
 * The functions here that only read: the guards of the ruling and the
 * release, which their routes ask before the caller's password (card 2679,
 * decision 2). Every other export is a write, and starts with `inWrite()`.
 */
export const READS: readonly string[] = ['decisionRuleGuard', 'resultsReleaseGuard'];

// ─── The ruling, the release and superseding (card 2679) ─────────────────────

/** How long a ruling's reason and its conditions may be (S7): the shared limit the ruling form shows (code review F8). */
const RULING_TEXT_MAX = DECISION_TEXT_MAX;

/** The most comment keys a release's `omit` may name: one for each comment the most participants could give. */
const MOST_OMITTED = MOST_PARTICIPANTS * (CONTENT_LIMITS.options + 1);

/**
 * Every refusal of `ruleDecision`, in its order, read only (card 2679,
 * decisions 2, 13 and 14): the decision looked for and the caller checked
 * (`rule`: its decider, who can edit its board while it exists; 401, 404,
 * 403), 403 through an API key, the body (400): `optionId`, one of the
 * current version's options or null for none of these, `reason`, 1 to 4,000
 * characters, `conditions`, up to 4,000, `revision`, and
 * `openQuestionsConfirmed`; the status (409: open or closed); and then
 * `rulingRefusals`' 409s, a results revision that is not the decision's as it
 * is now and questions still open unconfirmed. The rule route will ask it
 * before the caller's password, so that none of these costs a check; the
 * write asks it first, so the rules are one.
 */
export function decisionRuleGuard(
	caller: SessionUser | null,
	at: { decisionId: number },
	body: RequestBody,
	opts: ServiceOptions
): { user: SessionUser; decision: Decision; ruling: { optionId: number | null; reason: string; conditions: string | null } } {
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'rule');
	if (keyed(opts)) error(403, "Ruling is a person's act: it cannot be done with an API key");

	const optionId = readId(body, 'optionId', { required: true, nullable: true });
	if (optionId !== null && !liveOptionIds(decision.id, decision.currentVersion).includes(optionId)) {
		error(400, `optionId ${optionId} is not an option of this decision's current version`);
	}
	const reason = readMultiline(body.reason, 'reason', RULING_TEXT_MAX, { trim: true });
	if (reason === '') error(400, 'reason is required');
	const conditions = readMultiline(body.conditions, 'conditions', RULING_TEXT_MAX, { trim: true });
	const revision = readText(body, 'revision', { required: true });
	const openQuestionsConfirmed = readBoolean(body, 'openQuestionsConfirmed', {}) ?? false;

	requireTransition(decision, 'rule');
	const [refusal] = rulingRefusals(decision, { revision, openQuestionsConfirmed });
	if (refusal !== undefined) error(409, refusal);
	return { user, decision, ruling: { optionId, reason, conditions: conditions === '' ? null : conditions } };
}

/**
 * Rule on an open or closed decision (card 2679, decisions 3, 5, 7, 11 and
 * 12): the option chosen, or none of these, the reason and the conditions.
 * Every refusal is `decisionRuleGuard`'s, asked first.
 *
 * The ruling row, `early` when the decision is shown open now or was closed
 * for input before its closing time (`rulesEarly`, card 2727) and `against`
 * when there were votes and the choice is not among the most chosen; the
 * decision `ruled`, with `ruled_at`; `ruled { optionId, early,
 * againstResponses, productOwnerUserId }`, the last the board's Product Owner
 * now, or null, which is the one `productOwner` who may supersede this ruling
 * from then on (code review S1); on an early ruling `cut_off { reached }` for each live consulted
 * participant with no response in the round, `reached` whether the round's
 * request ever reached them (`reachedInRound`, card 2738); and the ruling mail to every
 * live participant, which is held to no rest or cap and counted against
 * none, and with no link address goes ahead recorded as not sent. While its
 * board is there, `decision_ruled` (the title alone) and the live event.
 *
 * A decision that supersedes another still ruled (decision 5, S2): when the
 * caller may supersede that one now (its decider, its board's Product Owner or
 * an administrator, with the board-edit rule), it becomes `superseded`, with
 * `superseded { byDecisionId }`, `decision_superseded` on its board and the
 * live event; otherwise it stays ruled and nothing is written on it. The
 * ruling's event says which, `supersededOld`.
 */
export function ruleDecision(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const { user, decision, ruling } = decisionRuleGuard(caller, at, body, opts);

	const now = stamp();
	const by = actorFor(user, sourceOf(opts));
	const voteMode = decision.voteMode === 'score' ? 'score' : 'single';
	const { tally, notResponded, reached } = currentResultsOf(decision);
	// Card 2727: early when shown open, or when closed for input before its closing time.
	const early = rulesEarly(decision, now);
	const againstResponses = againstOf(ruling.optionId, tally.voted, mostChosenOf(tally, voteMode));
	// Code review S1: who may supersede this ruling is frozen at it, the board's Product Owner as it names one now.
	const productOwnerUserId =
		decision.boardId === null ? null : (db.select({ id: boards.productOwnerUserId }).from(boards).where(eq(boards.id, decision.boardId)).get()?.id ?? null);

	// Decision 5 (S2): the old decision is superseded only by a ruler who may supersede it now, its Product Owner as its ruling recorded them (S1).
	const old = decision.supersedesId === null ? null : (db.select().from(decisions).where(eq(decisions.id, decision.supersedesId)).get() ?? null);
	const supersedesOld = old !== null && old.status === 'ruled' && mayDo(decisionAccess(user, old), 'supersede', old);

	const record = appendRuling({ decisionId: decision.id, versionNumber: decision.currentVersion, ...ruling, againstResponses, early }, by);
	const row = db
		.update(decisions)
		.set({ status: 'ruled', ruledAt: record.ruledAt, updatedAt: now })
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	appendEvent(
		{
			decisionId: decision.id,
			kind: 'ruled',
			versionNumber: decision.currentVersion,
			detail: {
				optionId: ruling.optionId,
				early,
				againstResponses,
				productOwnerUserId,
				...(decision.supersedesId === null ? {} : { supersededOld: supersedesOld })
			}
		},
		by
	);
	// Card 2738 (D2): every cut-off says whether the round's request ever reached them, both ways.
	if (early) {
		for (const participant of notResponded) {
			appendEvent({ decisionId: decision.id, kind: 'cut_off', participantId: participant.id, detail: { reached: reached.has(participant.id) } }, by);
		}
	}

	const chosen = ruling.optionId === null ? undefined : versionOptionsOf(decision.id, decision.currentVersion).find((option) => option.optionId === ruling.optionId);
	const label = ruling.optionId === null ? null : (chosen?.label ?? allOptionsOf(decision.id).find((option) => option.id === ruling.optionId)?.label ?? null);
	// Card 2683 (R18): a survey's ruling says no options were put to a vote, not "None of these".
	const noOptions = versionOptionsOf(decision.id, decision.currentVersion).length === 0;
	queueRecordMails(row, 'ruling', {
		by,
		ruling: { optionLabel: label, optionTitle: chosen?.title || null, reason: ruling.reason, conditions: ruling.conditions, noOptions }
	});

	if (row.boardId !== null) {
		logActivity({ action: ACTIONS.decisionRuled, ...decisionEntry(row.boardId, `"${row.title}"`, user, opts) });
		emit(row.boardId, 'decision', { decisionId: row.id, status: decisionStatus(row, now), boardId: row.boardId });
	}

	if (old !== null && supersedesOld) {
		const superseded = db.update(decisions).set({ status: 'superseded', updatedAt: now }).where(eq(decisions.id, old.id)).returning().get();
		appendEvent({ decisionId: old.id, kind: 'superseded', detail: { byDecisionId: decision.id } }, by);
		if (superseded.boardId !== null) {
			logActivity({ action: ACTIONS.decisionSuperseded, ...decisionEntry(superseded.boardId, `"${superseded.title}"`, user, opts) });
			emit(superseded.boardId, 'decision', { decisionId: superseded.id, status: decisionStatus(superseded, now), boardId: superseded.boardId });
		}
	}
	return row;
}

/**
 * Every refusal of `releaseResults`, in its order, read only (card 2679,
 * decisions 2, 10, 14, 20, 25 and 27): the decision looked for and the caller
 * checked (`release`: its decider alone; 401, 404, 403), 403 through an API
 * key, the body (400): `revision`, required, and `omit`, an optional list of
 * the preview's comment keys; the status (409: stored `ruled` alone); then
 * `releaseRefusals`' 409s, already released, ruled on a version that put no
 * options to a vote (card 2683, R11), fewer than 3 responses, a
 * response given before the who-sees statement said the results could be
 * released, and a release in the supersede chain from people 1 or 2 apart; a
 * results revision that is not the decision's as it is now (409); and, last,
 * an `omit` key that is no comment the release would show (400). Answers the
 * comments left out, each as its response and field.
 */
export function resultsReleaseGuard(
	caller: SessionUser | null,
	at: { decisionId: number },
	body: RequestBody,
	opts: ServiceOptions
): { user: SessionUser; decision: Decision; omitted: { responseId: number; field: string }[] } {
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'release');
	if (keyed(opts)) error(403, "Releasing results is a person's act: it cannot be done with an API key");

	const revision = readText(body, 'revision', { required: true });
	const omit = readList(body, 'omit', { max: MOST_OMITTED }) ?? [];
	const keys = omit.map((key, index) => {
		if (typeof key !== 'string') error(400, `omit[${index}] must be text`);
		return key;
	});

	requireTransition(decision, 'release');
	const [refusal] = releaseRefusals(decision);
	if (refusal !== undefined) error(409, refusal);
	if (resultsRevisionFor(decision.id) !== revision) error(409, STALE_REVISION);
	const shown = commentKeysOf(decision);
	const omitted = new Map<string, { responseId: number; field: string }>();
	keys.forEach((key, index) => {
		const comment = shown.get(key);
		if (comment === undefined) error(400, `omit[${index}] is not a comment this release would show`);
		omitted.set(key, comment);
	});
	return { user, decision, omitted: [...omitted.values()] };
}

/**
 * Release a ruled decision's totals and comments, without names, to everyone
 * who may view it (card 2679, decision 10): for good. Every refusal is
 * `resultsReleaseGuard`'s, asked first. `results_released_at` and `_by`;
 * `results_released { upToResponseId, omitted }`, the highest response id
 * counted, which freezes what is shown, and each comment left out; and, while
 * its board is there, `decision_results_released` (the title alone) and the
 * live event. It mails nobody.
 */
export function releaseResults(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const { user, decision, omitted } = resultsReleaseGuard(caller, at, body, opts);

	const now = stamp();
	const upToResponseId = responsesOf(decision.id).at(-1)?.id ?? 0;
	const row = db
		.update(decisions)
		.set({ resultsReleasedAt: now, resultsReleasedBy: user.id, updatedAt: now })
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	appendEvent({ decisionId: decision.id, kind: 'results_released', detail: { upToResponseId, omitted } }, actorFor(user, sourceOf(opts)));

	if (row.boardId !== null) {
		logActivity({ action: ACTIONS.decisionResultsReleased, ...decisionEntry(row.boardId, `"${row.title}"`, user, opts) });
		emit(row.boardId, 'decision', { decisionId: row.id, status: decisionStatus(row, now), boardId: row.boardId });
	}
	return row;
}

/**
 * Make a draft that supersedes a ruled decision (card 2679, decision 5, S2):
 * its decider's, its board's Product Owner's or an administrator's, each who
 * can edit the board now (`supersede`; 401, 404, 403). `title`, optional, the
 * old title when not sent (as `readTitle`, 400). 409 unless the decision is
 * stored `ruled`; when its board is gone, as a draft with no board could never
 * be opened; and while another decision superseding it is not withdrawn.
 *
 * The draft is on the same board, its name as now, the caller its author,
 * `vote_mode` copied, no closing time and no participants, `supersedes_id`
 * this decision. Its decider is the old decision's, while that account can
 * edit the board now, and otherwise the caller: never anyone the caller
 * named, so that a ruling cannot be overturned through a draft whose decider
 * they chose. Its working content is the version ruled on, through
 * `workingFromVersion`, each option a new row labelled from A in order. Writes
 * `created { decider, supersedes }` on the draft alone; no activity entry, no
 * live event and no mail (a draft). Card 2728 (D6): the version's
 * `participants` and `decider` flags are not carried, and its `title` flag
 * only with the old title; a new title given through an API key is flagged.
 * Card 3033 (D3): `decision tracked` and `decision_decider yes` recorded for
 * the draft after its insert; R14: 409 first where the decider's account's
 * creation time names no moment.
 *
 * Card 2683 (R9): the version's survey questions are copied too, each a new
 * row in order, its id mapped and its `survey.<id>` flag renamed.
 */
export function supersedeDecision(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'supersede');

	const title = readTitle(body, { required: false }) ?? decision.title;

	requireTransition(decision, 'supersede');
	const board = decision.boardId === null ? undefined : db.select().from(boards).where(eq(boards.id, decision.boardId)).get();
	if (board === undefined) error(409, "This decision's board has been deleted: a decision superseding it could never be opened");
	if (supersedingOf(decision.id) !== null) error(409, 'A later decision that supersedes this one already exists');

	const previous =
		decision.deciderUserId === null
			? undefined
			: db.select({ id: users.id, username: users.username, role: users.role }).from(users).where(eq(users.id, decision.deciderUserId)).get();
	const decider = previous !== undefined && canEditBoard(previous, board.id) ? previous : null;
	requireDeciderRecordable(decider ?? user);
	const version = db
		.select({ content: decisionVersions.content })
		.from(decisionVersions)
		.where(and(eq(decisionVersions.decisionId, decision.id), eq(decisionVersions.number, decision.currentVersion)))
		.get();
	const content = parseVersionContent(version?.content ?? '{}');

	const now = stamp();
	const draft = db
		.insert(decisions)
		.values({
			boardId: board.id,
			boardName: board.name,
			title,
			voteMode: decision.voteMode,
			authorUserId: user.id,
			authorName: user.username,
			deciderUserId: decider?.id ?? user.id,
			deciderName: decider?.username ?? user.username,
			closesAt: null,
			supersedesId: decision.id,
			createdAt: now,
			updatedAt: now
		})
		.returning()
		.get();
	recordAccessChange(sqlite, { kind: ACCESS_KIND.decision, subject: draft.id, access: 'tracked' });
	recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionDecider, subject: draft.id, holder: draft.deciderUserId, access: 'yes' });
	const optionIds = new Map<number, number>();
	content.options.forEach((option, index) => {
		const made = db.insert(decisionOptions).values({ decisionId: draft.id, label: String.fromCharCode(65 + index), position: index }).returning().get();
		optionIds.set(option.optionId, made.id);
	});
	const questionIds = new Map<number, number>();
	content.surveyQuestions.forEach((question, index) => {
		const made = db.insert(decisionSurveyQuestions).values({ decisionId: draft.id, position: index }).returning().get();
		questionIds.set(question.questionId, made.id);
	});
	// Card 2728 (D6): the old title's flag goes with the old title; a new title replaces it, flagged when a key chose it.
	const working = workingFromVersion(content, optionIds, questionIds);
	if (title !== decision.title) {
		delete working.agentDrafted.title;
		if (keyed(opts)) working.agentDrafted.title = true;
	}
	const row = db
		.update(decisions)
		.set({ workingContent: JSON.stringify(working) })
		.where(eq(decisions.id, draft.id))
		.returning()
		.get();
	appendEvent(
		{ decisionId: draft.id, kind: 'created', detail: { decider: decider !== null ? 'previous_decider' : 'author', supersedes: decision.id } },
		actorFor(user, sourceOf(opts))
	);
	return row;
}

// ─── A participant's concern about the ruling (card 2679, decisions 3 and 4) ─

// The most concerns one participant raises about one ruling (decision 4) is `$lib/decision-rules.ts`'s
// `CONCERNS_PER_PARTICIPANT`, which the page asks too, so that it offers no form past it (code review F9).

/** The 403 for a concern through an API key (decision 14, D19). */
const CONCERN_ACT = "Raising a concern is a person's act: it cannot be done with an API key";

/**
 * A signed-in participant's concern about the ruling (card 2679, decision 4):
 * the body of `concernAs`. 403 through an API key (D19), and for one `reachOf`
 * no longer reaches through their account (D12). A participant kept informed
 * may raise one: the ruling affects them too, and a concern is not a vote.
 * Answers the concern as `OwnConcern`, with no id.
 */
export function raiseConcern(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): { concern: OwnConcern } {
	inWrite();
	const user = requireUser(caller);
	const { decision, access } = requireDecision(user, at.decisionId, 'concern');
	if (keyed(opts)) error(403, CONCERN_ACT);
	if (access.participantId === null) error(403, `You cannot ${DECISION_ACTION_WORDS.concern.verb} this decision`);
	const participant = participantOn(decision.id, access.participantId);
	requireReachedByAccount(decision.id, participant);

	return concernAs(decision, participant, body, actorFor(user, sourceOf(opts)), 'session', null);
}

/**
 * A link holder's concern about the ruling (card 2679, decision 4): the token
 * decides, through `participantForLink`, and any link that opens no decision
 * is the one 404, a link past its 90 days after the ruling among them
 * (`linkUsable`). Recorded `via: 'link'` with source `link`, whatever
 * source the route gives; a signed-in browser's account is noted as `signedIn`.
 * Otherwise as `raiseConcern`.
 */
export function raiseConcernByLink(caller: SessionUser | null, at: { token: string }, body: RequestBody, opts: ServiceOptions): { concern: OwnConcern } {
	inWrite();
	const { decision, participant, by, signedIn } = requireLinkHolder(at.token, caller);
	if (keyed(opts)) error(403, CONCERN_ACT);

	return concernAs(decision, participant, body, by, 'link', signedIn);
}

// ─── Inside the writes ───────────────────────────────────────────────────────
// Those more than one decision service shares are decision-write-shared.ts's (card 2713, D2).

/**
 * A concern about the ruling, from either way in (card 2679, decisions 3 and
 * 4). The body: `comment`, required, trimmed, 1 to 4,000 characters, with no
 * control character (400). Then 409 for a superseded ruling
 * (`CONCERN_SUPERSEDED`), for any status but stored `ruled`, past 90 days
 * after the ruling (`CONCERN_WINDOW_ENDED`; a link is refused before this by
 * `participantForLink`), and for a sixth concern; and 429 within 10 minutes
 * of the participant's last, saying from when, in UTC.
 *
 * Writes the row (`kind 'concern'`, the current round and version, no option,
 * via the way in), `concern_raised { responseId, notice }` naming the
 * participant, `seen { stage: 'ruling' }` for the version where there is none,
 * and, for `notice: 'asked'`, the decider's notice after the commit. No
 * activity entry, no live event (design S3). The notice's outcome is
 * `noticeOf`'s, and mail never refuses a concern.
 */
function concernAs(
	decision: Decision,
	participant: DecisionParticipant,
	body: RequestBody,
	by: RecordActor,
	via: 'session' | 'link',
	signedIn: { userId: number; name: string } | null
): { concern: OwnConcern } {
	const comment = readMultiline(body.comment, 'comment', COMMENT_MAX, { trim: true });
	if (comment === '') error(400, 'comment is required');

	const now = stamp();
	if (decision.status === 'superseded') error(409, CONCERN_SUPERSEDED);
	requireTransition(decision, 'concern', now);
	if (!linkUsable(decision, now)) error(409, CONCERN_WINDOW_ENDED);
	const earlier = concernsOf({ participantId: participant.id });
	if (earlier.length >= CONCERNS_PER_PARTICIPANT) {
		error(409, `You have raised ${CONCERNS_PER_PARTICIPANT} concerns about this ruling: no more can be raised`);
	}
	const last = earlier.at(-1);
	const rested = last === undefined ? null : later(last.createdAt, RECORD_MAIL_MIN_MINUTES * 60 * 1000);
	if (rested !== null && now < rested) {
		error(429, `Your last concern was raised less than ${RECORD_MAIL_MIN_MINUTES} minutes ago: the next can be raised from ${rested} UTC`);
	}

	const row = appendResponse({
		decisionId: decision.id,
		participantId: participant.id,
		versionNumber: decision.currentVersion,
		round: currentRound(decision.id),
		kind: 'concern',
		optionId: null,
		scores: null,
		comment,
		optionComments: null,
		answers: null,
		replacesId: null,
		via
	});
	const notice = noticeOf(decision, participant.id, now);
	const signed = signedIn === null ? {} : { signedIn };
	appendEvent(
		{
			decisionId: decision.id,
			kind: 'concern_raised',
			participantId: participant.id,
			versionNumber: decision.currentVersion,
			detail: { responseId: row.id, notice: notice.outcome, ...signed }
		},
		by
	);
	if (!hasSeen(participant.id, decision.currentVersion, 'ruling')) {
		appendEvent(
			{ decisionId: decision.id, kind: 'seen', participantId: participant.id, versionNumber: decision.currentVersion, detail: { stage: 'ruling', ...signed } },
			by
		);
	}
	if (notice.outcome === 'asked') notifyDecisionConcern(notice.deciderUserId, decision.id, decision.title, notice.heldBefore);
	return { concern: { comment, createdAt: row.createdAt } };
}

/**
 * Whether a concern from `participantId` notifies the decider (card 2679,
 * decision 3, S3), decided inside the write: `no_decider` with no decider
 * account; `no_link_address` with no App URL or `ORIGIN`; `prefs_off` when the
 * decider's `email_decisions` or every mail is switched off; `no_mail_host`
 * when no mail host is set up (code review F2); `held` within 24 hours of the
 * last notice about this participant; and `asked` otherwise, carrying how
 * many of theirs were held since that notice. Per participant: a
 * participant's first concern always notifies, and nobody else's holds it
 * back. Only `asked` holds the next one back, as only it sent anything; none
 * of the others is counted as held.
 */
function noticeOf(
	decision: Decision,
	participantId: number,
	now: Stamp
): { outcome: 'no_decider' | 'no_link_address' | 'prefs_off' | 'no_mail_host' | 'held' } | { outcome: 'asked'; deciderUserId: number; heldBefore: number } {
	const decider =
		decision.deciderUserId === null ? undefined : db.select({ id: users.id }).from(users).where(eq(users.id, decision.deciderUserId)).get();
	if (decider === undefined) return { outcome: 'no_decider' };
	if (decisionLinkBase() === null) return { outcome: 'no_link_address' };
	if (!shouldNotifyUser(decider.id, 'email_decisions')) return { outcome: 'prefs_off' };
	// Code review F2, S5: with no mail host nothing would be sent, so nothing is recorded as asked to hold the next one back.
	if (!isSmtpConfigured()) return { outcome: 'no_mail_host' };

	const theirs = eventsOfKind(decision.id, 'concern_raised').filter((event) => event.participantId === participantId);
	const lastAsked = theirs.findLastIndex((event) => event.detail.notice === 'asked');
	if (lastAsked !== -1) {
		const rested = later(theirs[lastAsked].at, DAY_MS);
		if (rested === null || now < rested) return { outcome: 'held' };
	}
	const heldBefore = theirs.slice(lastAsked + 1).filter((event) => event.detail.notice === 'held').length;
	return { outcome: 'asked', deciderUserId: decider.id, heldBefore };
}
