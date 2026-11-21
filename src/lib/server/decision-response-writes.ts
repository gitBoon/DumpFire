/**
 * decision-response-writes.ts — a participant's own writes (card 2677): a
 * response (`respondToDecision`, `respondByLink`) and being recorded as
 * having seen a version (`recordSeen`, `recordSeenByLink`), signed in or by a
 * personal link. Card 2713 moved them here from the former decision service,
 * unchanged (D1).
 *
 * Both ways in share `respondAs` and `seenAs`, so they cannot drift. A link
 * write decides by its token, through `participantForLink`, and is handed
 * `caller` only to note a signed-in browser's account beside the link holder
 * (decision 9); its source is `link` whatever the route says. Each is a
 * person's act alone (`source: 'ui'`), for a participant `reachOf` still
 * reaches, and none writes an activity entry, a live event, a webhook or a
 * mail (design S3).
 *
 * Card 2679: a response records the version of the who-sees statement it was
 * given under (decision 25), and `RESPONSE_KINDS` is decision-record.ts's, so
 * that every read of a vote skips a concern.
 *
 * Each write has the one shape of a service, and the record is written as
 * decision-write-shared.ts's header says.
 */
import { error } from '@sveltejs/kit';
import type { Decision, DecisionParticipant } from './db/schema';
import type { SessionUser } from './auth';
import { publishedSurveyOf, readMultiline, requireClosed, type VersionContent } from './decision-content';
import {
	actorFor,
	appendEvent,
	appendResponse,
	currentRound,
	latestResponse,
	liveOptionIds,
	liveSurveyQuestionIds,
	ownResponseOf,
	RESPONSE_KINDS,
	responsesInRound,
	seenStands,
	statementsOf,
	surveysAskedIn,
	type RecordActor
} from './decision-record';
import { DECISION_ACTION_WORDS, decisionStatus, requireTransition } from './decision-status';
import { asObject, readChoice, readId, readNumber, readText, type RequestBody } from './request-body';
import type { OwnResponse } from '$lib/decision-view-types';
import { STALE_REVISION, WHO_SEES_STATEMENT_VERSION } from '$lib/decision-words';
import { requireDecision, requireUser } from './route-guards';
import { stamp } from '$lib/timestamps';
import { inWrite, type ServiceOptions } from './write-as';
import { COMMENT_MAX, keyed, participantOn, requireLinkHolder, requireReachedByAccount, sourceOf } from './decision-write-shared';

/** None of a participant's own writes has a guard of its own: every export here is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = [];

/** The stages a participant is recorded as having seen (card 2677, decision 14). */
const SEEN_STAGES = ['question', 'ruling', 'withdrawal'] as const;

/** The most responses one participant gives in one round (decision 11). Private: a service module exports its functions alone (D5). */
const RESPONSES_PER_ROUND = 50;

/** How long each comment on an option may be (decision 11); a response's comment's is decision-write-shared.ts's `COMMENT_MAX`. */
const OPTION_COMMENT_MAX = 2000;

/** How long a written answer to a survey question may be (card 2683, R13): an option comment's limit. */
const ANSWER_MAX = 2000;

/** A survey question as the current version published it, with the id of its row. */
type AskedQuestion = VersionContent['surveyQuestions'][number];

/** The 403 for a participant's write through an API key (decision 10, D19). */
const PERSONS_ACT = "Responding is a person's act: it cannot be done with an API key";
// The 403 for a participant `reachOf` no longer reaches (decision 10, D12) is `$lib/decision-words.ts`'s `NO_LONGER_REACHED`, which
// card 2678's questions read says too.

/**
 * A signed-in participant's response (card 2677, decisions 10 to 13): the
 * body of `respondAs`. 403 through an API key (D19), for an informed
 * participant, and for one `reachOf` no longer reaches through their account
 * (D12). Answers the response as `OwnResponse`, never the row, and whether it
 * was the same as the last, which writes nothing.
 */
export function respondToDecision(
	caller: SessionUser | null,
	at: { decisionId: number },
	body: RequestBody,
	opts: ServiceOptions
): { response: OwnResponse; unchanged: boolean } {
	inWrite();
	const user = requireUser(caller);
	const { decision, access } = requireDecision(user, at.decisionId, 'respond');
	if (keyed(opts)) error(403, PERSONS_ACT);
	const participant = ownParticipant(decision, access.participantId);
	if (participant.role !== 'consulted') error(403, 'Someone kept informed gives no response');
	requireReachedByAccount(decision.id, participant);

	return respondAs(decision, participant, body, actorFor(user, sourceOf(opts)), 'session', null);
}

/**
 * A link holder's response (card 2677, decisions 4, 9 and 10): the token
 * decides, through `participantForLink`, and any link that does not open a
 * decision is the one 404 (decision 6). Recorded `via: 'link'` with source
 * `link`, whatever source the route gives; a signed-in browser's account is noted
 * in the event's detail as `signedIn`, never as the actor (R8). Otherwise as
 * `respondToDecision`.
 */
export function respondByLink(
	caller: SessionUser | null,
	at: { token: string },
	body: RequestBody,
	opts: ServiceOptions
): { response: OwnResponse; unchanged: boolean } {
	inWrite();
	const { decision, participant, by, signedIn } = requireLinkHolder(at.token, caller);
	if (keyed(opts)) error(403, PERSONS_ACT);
	if (participant.role !== 'consulted') error(403, 'Someone kept informed gives no response');

	return respondAs(decision, participant, body, by, 'link', signedIn);
}

/**
 * Record that a signed-in participant has seen a version (card 2677,
 * decision 14): the body of `seenAs`. 403 through an API key, for a caller who
 * may view the decision and is no participant of it, and for one `reachOf`
 * no longer reaches through their account (D12).
 */
export function recordSeen(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): { recorded: boolean } {
	inWrite();
	const user = requireUser(caller);
	const { decision, access } = requireDecision(user, at.decisionId, 'view');
	if (keyed(opts)) error(403, "Being recorded as having seen a decision is a person's act: it cannot be done with an API key");
	if (access.participantId === null) error(403, 'Only a participant of this decision is recorded as having seen it');
	const participant = ownParticipant(decision, access.participantId);
	requireReachedByAccount(decision.id, participant);

	return seenAs(decision, participant, body, actorFor(user, sourceOf(opts)), null);
}

/** Record that a link holder has seen a version (card 2677, decisions 9 and 14): as `recordSeen`, decided by the token, with the link's source. */
export function recordSeenByLink(caller: SessionUser | null, at: { token: string }, body: RequestBody, opts: ServiceOptions): { recorded: boolean } {
	inWrite();
	const { decision, participant, by, signedIn } = requireLinkHolder(at.token, caller);
	if (keyed(opts)) error(403, "Being recorded as having seen a decision is a person's act: it cannot be done with an API key");

	return seenAs(decision, participant, body, by, signedIn);
}

// ─── Inside the writes ───────────────────────────────────────────────────────
// Those more than one decision service shares are decision-write-shared.ts's (card 2713, D2).

/** The caller's own live participant row, which the guard found (`access.participantId`); 403 for none. */
function ownParticipant(decision: Decision, participantId: number | null): DecisionParticipant {
	if (participantId === null) error(403, `You cannot ${DECISION_ACTION_WORDS.respond.verb} this decision`);
	return participantOn(decision.id, participantId);
}

/**
 * A response, from either way in (card 2677, decisions 11 to 13). The body:
 * `versionNumber` and `kind` (`vote`, `abstain`, `no_concerns`, `answered`), required; a
 * vote's `optionId`, one of the current version's live options, in single
 * mode, or its `scores`, a whole number 0 to 5 for every live option and no
 * other, in score mode; neither for the others; `comment`, trimmed, up to
 * 4,000; `optionComments`, keyed by live option ids, each trimmed, up to
 * 2,000, the empty ones dropped. The keyed objects are stored as built from
 * the live ids, never from the body's keys (R9). A version that is not the
 * current one is a 409 as soon as it is read, before any other field (card
 * 2683, code review F2). Then 409 unless the decision is stored and shown
 * open (decision 12), and past `RESPONSES_PER_ROUND` in the round. A response the
 * same as the participant's latest in the round, for the same version,
 * writes nothing; the same answer for a newer version is a new row bound to
 * it. Otherwise the
 * row (`replaces_id` that latest), `responded { responseId }`, and
 * `seen { stage: 'question' }` for the version where none stands
 * (`seenStands`, card 2741).
 *
 * Card 2679 (decision 25): `statement`, optional, a whole number, the version
 * of the who-sees statement the page showed. The current one is recorded on
 * `responded { responseId, statement }`; any other is a 409 (the page is out
 * of date); none sent records none. The same answer sent with the current
 * statement, where the latest was recorded under none, is a new row, so that
 * a participant can bring an answer under the statement that says the results
 * may be released.
 *
 * Card 2683 (R12, R13): in a survey-only round (no live option, at least one
 * live survey question) `kind` is `answered` or `abstain`, and `vote` and
 * `no_concerns` are refused by name before anything else is read, so a vote
 * with no live option is never read (F1); with options, `answered` is
 * refused. `answers`, optional, keyed by the current version's live survey
 * question ids (`liveSurveyQuestionIds`) and by no other, a draft-only or
 * retired one included, each read by `answerOf`; stored as JSON built by
 * walking those ids, a written answer empty once trimmed left out as
 * unanswered, null when none is left. `answered` needs at least one answer,
 * and every kind but `abstain` an answer to every required question. A
 * refusal names the question by its number, never what was written.
 */
function respondAs(
	decision: Decision,
	participant: DecisionParticipant,
	body: RequestBody,
	by: RecordActor,
	via: 'session' | 'link',
	signedIn: { userId: number; name: string } | null
): { response: OwnResponse; unchanged: boolean } {
	const versionNumber = readNumber(body, 'versionNumber', { required: true, whole: true, min: 1 });
	// Card 2683 (code review F2): a page of another version is out of date, refused before the kinds, scores and answers
	// are read against the current version's, so it is told to reload, not given a refusal its page cannot explain.
	if (versionNumber !== decision.currentVersion) error(409, STALE_REVISION);
	const kind = readChoice(body, 'kind', { required: true, from: RESPONSE_KINDS });
	const live = liveOptionIds(decision.id, decision.currentVersion);
	const keys = live.map((id) => `${id}`);
	const asked = askedQuestions(decision);
	// Card 2683 (R12): the kinds the round allows, asked by name before a vote's fields are read (F1).
	const surveyOnly = live.length === 0 && asked.length > 0;
	if (surveyOnly && (kind === 'vote' || kind === 'no_concerns')) {
		error(400, `kind ${kind} cannot be given: this decision puts no options to a vote, so answer its survey questions (kind answered), or abstain`);
	}
	if (!surveyOnly && kind === 'answered') error(400, 'kind answered cannot be given: this decision puts options to a vote, so vote, abstain or say you have no concerns');
	let optionId: number | null = null;
	let scores: string | null = null;
	if (kind === 'vote' && decision.voteMode === 'score') {
		if (Object.hasOwn(body, 'optionId')) error(400, 'optionId cannot be sent: this decision asks for a score for each option');
		scores = readScores(body, keys);
	} else {
		if (Object.hasOwn(body, 'scores')) error(400, kind === 'vote' ? 'scores cannot be sent: this decision asks for one choice' : `scores cannot be sent with ${kind}`);
		if (kind === 'vote') {
			optionId = readId(body, 'optionId', { required: true });
			if (!live.includes(optionId)) error(400, `optionId ${optionId} is not an option of this decision's current version`);
		} else if (Object.hasOwn(body, 'optionId')) {
			error(400, `optionId cannot be sent with ${kind}`);
		}
	}
	const comment = readMultiline(body.comment, 'comment', COMMENT_MAX, { trim: true });
	const optionComments = readOptionComments(body, keys);
	const answers = readAnswers(body, asked);
	if (kind === 'answered' && answers.given.size === 0) error(400, 'kind answered must hold an answer to at least one survey question');
	if (kind !== 'abstain') {
		asked.forEach((question, index) => {
			if (question.required && !answers.given.has(question.questionId)) error(400, `Survey question ${index + 1} must be answered: answer it, or abstain`);
		});
	}
	// Card 2679 (decision 25): the version of the who-sees statement the page showed.
	const statement = readNumber(body, 'statement', { whole: true });

	const now = stamp();
	requireTransition(decision, 'respond', now);
	// Decision 12: stored open is not enough once `closes_at` has passed.
	if (decisionStatus(decision, now) !== 'open') error(409, 'This decision is awaiting a ruling: responses are closed');
	// A page that showed another statement is out of date: it must be reloaded (card 2679, decision 25).
	if (statement !== undefined && statement !== WHO_SEES_STATEMENT_VERSION) error(409, STALE_REVISION);
	const round = currentRound(decision.id);
	const latest = latestResponse(participant.id, round);
	const answer = { kind, optionId, scores, comment: comment === '' ? null : comment, optionComments, answers: answers.json };
	// Code review F4: the questions the answers are read back against, read once, and only where there are answers to read.
	const answeredAgainst = answers.json === null ? undefined : surveysAskedIn([decision.id], [decision.currentVersion]);
	// The same answer on the same version alone writes nothing: confirmed on a newer one, it is bound to that one (code review C1);
	// sent under the current statement where the last was given under none, it is recorded anew under it (card 2679, decision 25).
	if (
		latest !== null &&
		latest.versionNumber === versionNumber &&
		latest.kind === answer.kind &&
		latest.optionId === answer.optionId &&
		latest.scores === answer.scores &&
		latest.comment === answer.comment &&
		latest.optionComments === answer.optionComments &&
		latest.answers === answer.answers &&
		(statement === undefined || statementsOf(decision.id).get(latest.id) === WHO_SEES_STATEMENT_VERSION)
	) {
		return { response: ownResponseOf(latest, answeredAgainst), unchanged: true };
	}
	if (responsesInRound(participant.id, round) >= RESPONSES_PER_ROUND) {
		error(409, 'You have changed your response too many times in this round: ask the decider');
	}

	const row = appendResponse({
		decisionId: decision.id,
		participantId: participant.id,
		versionNumber,
		round,
		...answer,
		replacesId: latest?.id ?? null,
		via
	});
	const signed = signedIn === null ? {} : { signedIn };
	appendEvent(
		{
			decisionId: decision.id,
			kind: 'responded',
			participantId: participant.id,
			versionNumber,
			detail: { responseId: row.id, ...(statement === undefined ? {} : { statement }), ...signed }
		},
		by
	);
	// Card 2741: by `seenAs`'s own test, so a response after an extend or a re-inclusion records the seen reach counts.
	if (!seenStands(decision, participant, versionNumber, 'question', now)) {
		appendEvent({ decisionId: decision.id, kind: 'seen', participantId: participant.id, versionNumber, detail: { stage: 'question', ...signed } }, by);
	}
	return { response: ownResponseOf(row, answeredAgainst), unchanged: false };
}

/**
 * A score-mode vote's `scores` (decision 11, R9): an object holding a whole
 * number 0 to 5 for each of `keys`, the live option ids, and no other key,
 * which `requireClosed` refuses before any is read. Stored as JSON built by
 * walking `keys`. Card 2683 (F1, R12): refused when there is no live option,
 * so that no path can store a vote of `{}`, whatever refused it before.
 */
function readScores(body: RequestBody, keys: string[]): string {
	if (keys.length === 0) error(400, 'scores cannot be given: this decision has no options to score');
	const sent = asObject(body.scores);
	if (sent === undefined) error(400, body.scores === undefined ? 'scores is required' : 'scores must be an object');
	requireClosed(sent, keys, 'scores', "this decision's current options");
	const scores: Record<string, number> = {};
	for (const key of keys) {
		if (!Object.hasOwn(sent, key)) error(400, `scores must hold a score for every option: option ${key} has none`);
		scores[key] = readNumber(sent, key, { required: true, whole: true, min: 0, max: 5, says: `scores.${key} must be a whole number from 0 to 5` });
	}
	return JSON.stringify(scores);
}

/**
 * A response's `optionComments` (decision 11, R9): an object keyed by `keys`,
 * the live option ids, and by no other, each comment read as a response's
 * comment is, up to 2,000. Stored as JSON built by walking `keys`, the empty
 * ones dropped; null when none is left.
 */
function readOptionComments(body: RequestBody, keys: string[]): string | null {
	if (body.optionComments === undefined) return null;
	const sent = asObject(body.optionComments);
	if (sent === undefined) error(400, 'optionComments must be an object');
	requireClosed(sent, keys, 'optionComments', "this decision's current options");
	const kept: [string, string][] = [];
	for (const key of keys) {
		if (!Object.hasOwn(sent, key)) continue;
		const path = `optionComments.${key}`;
		const text = readMultiline(readText(sent, key, { says: `${path} must be text` }), path, OPTION_COMMENT_MAX, { trim: true });
		if (text !== '') kept.push([key, text]);
	}
	return kept.length === 0 ? null : JSON.stringify(Object.fromEntries(kept));
}

/**
 * The survey questions a response may answer (card 2683, R13): the current
 * version's live ids (`liveSurveyQuestionIds`), in their order, each with its
 * kind, choices, scale and required flag as that version published it. A
 * question's number in a refusal is its place in this list, from 1.
 */
function askedQuestions(decision: Decision): AskedQuestion[] {
	const ids = liveSurveyQuestionIds(decision.id, decision.currentVersion);
	if (ids.length === 0) return [];
	const published = new Map(publishedSurveyOf(decision.id, decision.currentVersion).map((question) => [question.questionId, question]));
	return ids.flatMap((id) => published.get(id) ?? []);
}

/**
 * A response's `answers` (card 2683, R2, R13): an object keyed by the ids of
 * `asked` and by no other, which `requireClosed` refuses before any is read,
 * each value read by `answerOf`. Stored as JSON built by walking `asked`, a
 * written answer empty once trimmed left out; null when none is left. `given`
 * holds the ids answered, for the required check.
 */
function readAnswers(body: RequestBody, asked: AskedQuestion[]): { json: string | null; given: Set<number> } {
	if (body.answers === undefined) return { json: null, given: new Set() };
	const sent = asObject(body.answers);
	if (sent === undefined) error(400, 'answers must be an object');
	requireClosed(
		sent,
		asked.map((question) => `${question.questionId}`),
		'answers',
		"this decision's current survey questions"
	);
	const kept: [string, number | string][] = [];
	asked.forEach((question, index) => {
		const key = `${question.questionId}`;
		if (!Object.hasOwn(sent, key)) return;
		const value = answerOf(question, sent, key, `Survey question ${index + 1}`);
		if (value !== '') kept.push([key, value]);
	});
	return { json: kept.length === 0 ? null : JSON.stringify(Object.fromEntries(kept)), given: new Set(kept.map(([key]) => Number(key))) };
}

/**
 * One answer, `sent[key]` (card 2683, R13), refused in words that name the
 * question, `named`, and never repeat what was sent: a choice question's the
 * 0-based index of one of its choices, a scale question's a whole number from
 * 1 to its top, each read as a score is (`readNumber`); a text question's
 * text, trimmed, up to `ANSWER_MAX`, holding of `UNPRINTABLE` only what a
 * comment may, `''` when nothing is left.
 */
function answerOf(question: AskedQuestion, sent: RequestBody, key: string, named: string): number | string {
	if (question.kind === 'text') {
		const text = readText(sent, key, { required: true, says: `${named} asks for a written answer` });
		return readMultiline(text, `${named}'s answer`, ANSWER_MAX, { trim: true });
	}
	const [min, max, asks] =
		question.kind === 'choice'
			? [0, (question.choices ?? []).length - 1, 'the number of one of its choices, counted from 0']
			: [1, question.scale?.max ?? 0, 'a whole number on its scale'];
	return readNumber(sent, key, { required: true, whole: true, min, max, says: `${named} asks for ${asks}, from ${min} to ${max}` });
}

/**
 * Being recorded as having seen a version, from either way in (card 2677,
 * decision 14). The body: `versionNumber`, the current version (400
 * otherwise, an earlier one included), and `stage`,
 * `question`, `ruling` or `withdrawal` (400 otherwise). 409 for `ruling` on a
 * decision not ruled or superseded, and for `withdrawal` on one not
 * withdrawn. One `seen { stage }` event per participant, version and stage:
 * a second writes nothing and answers `{ recorded: false }`. Card 2741: at
 * the question stage, a seen that card 2738's reach would not count (made
 * while the decision was shut, before the latest re-inclusion, or while
 * informed) does not hide a view that it would: that one is recorded too
 * (`seenStands`, the test the page's `seenRecorded` asks).
 */
function seenAs(
	decision: Decision,
	participant: DecisionParticipant,
	body: RequestBody,
	by: RecordActor,
	signedIn: { userId: number; name: string } | null
): { recorded: boolean } {
	const versionNumber = readNumber(body, 'versionNumber', { required: true, whole: true, min: 1 });
	const stage = readChoice(body, 'stage', { required: true, from: SEEN_STAGES });
	// The version shown now alone (code review C4): an earlier one is not what the page shows.
	if (versionNumber !== decision.currentVersion) error(400, `versionNumber ${versionNumber} is not the current version of this decision`);

	if (stage === 'ruling' && decision.status !== 'ruled' && decision.status !== 'superseded') {
		error(409, 'This decision has not been ruled on: there is no ruling to have seen');
	}
	if (stage === 'withdrawal' && decision.status !== 'withdrawn') error(409, 'This decision has not been withdrawn: there is no withdrawal to have seen');
	if (seenStands(decision, participant, versionNumber, stage, stamp())) return { recorded: false };
	appendEvent(
		{ decisionId: decision.id, kind: 'seen', participantId: participant.id, versionNumber, detail: { stage, ...(signedIn === null ? {} : { signedIn }) } },
		by
	);
	return { recorded: true };
}
