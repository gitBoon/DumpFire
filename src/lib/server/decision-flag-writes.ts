/**
 * decision-flag-writes.ts — a participant's objection or request to talk to
 * the decider (card 2684, R3 to R6), signed in (`raiseFlag`) or by personal
 * link (`raiseFlagByLink`), sharing `flagAs`; and the decider's reply to
 * either (`replyToFlag`, R7); beside decision-flags.ts, which reads them
 * tolerantly.
 *
 * An objection says "I cannot live with this" and must give a reason; a
 * request to talk may carry a note. Neither is a vote, nor a veto: an
 * objection is answered before the ruling, which is the ruling's own gate
 * (`rulingRefusals`, R8). Each is a person's act alone (D19): through an API
 * key, both ways in, a 403. The row is inserted once (`appendFlag`); the event
 * naming the participant (`objection_raised`, `talk_requested`) is the
 * decider's and administrators' alone, and never given to a key. The decider
 * is told by a notice that names nobody and quotes nothing, sent after the
 * commit (`deciderNoticeOf`, shared with concerns, R15). No activity entry, no
 * live event and no webhook (design S3): nothing may tell a watcher that
 * someone objected.
 *
 * The reply is the current decider's alone, signed in, settled once by a
 * guarded update (`recordFlagReply`); its event (`objection_answered`,
 * `talk_outcome`) names no participant, and the person who raised it is told
 * by a notice that names nobody and quotes nothing (`participantNoticeOf`,
 * shared with the answer to a question). `replied_by` is kept for the record
 * alone: nothing here reads it.
 *
 * Each write has the one shape of a service, and the record is written as
 * decision-write-shared.ts's header says.
 */
import { error } from '@sveltejs/kit';
import type { SessionUser } from './auth';
import { actorFor, appendEvent, appendFlag, eventsOfKind, flagsCounted, flagTextProblem, recordFlagReply, type RecordActor } from './decision-record';
import { flagsOf, flagsOfParticipants } from './decision-flags';
import { RECORD_MAIL_MIN_MINUTES } from './decision-mail';
import { resultFlagOf } from './decision-results';
import { DECISION_ACTION_WORDS, requireTransition } from './decision-status';
import { notifyDecisionFlag, notifyFlagReplied } from './notifications';
import { readChoice, readText, type RequestBody } from './request-body';
import { FLAG_KINDS, FLAG_TEXT_RULES, FLAGS_PER_DECISION, FLAGS_PER_PARTICIPANT_VERSION, REPLY_TEXT_RULE, type FlagTextRule } from '$lib/decision-rules';
import type { OwnFlag, ResultFlag } from '$lib/decision-view-types';
import { FLAGS_CLOSED, flagRestWords, flagsFullWords, flagsLimitWords, TALK_OPEN } from '$lib/decision-words';
import { requireDecision, requireUser } from './route-guards';
import { stamp, type Stamp } from '$lib/timestamps';
import { inWrite, type ServiceOptions } from './write-as';
import type { Decision, DecisionFlag, DecisionParticipant } from './db/schema';
import {
	deciderNoticeOf,
	keyed,
	participantNoticeOf,
	participantOn,
	requireLinkHolder,
	requireReachedByAccount,
	requireRested,
	requireUnderCap,
	sourceOf
} from './decision-write-shared';

/** None of the flag writes has a guard of its own: every export here is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = [];

/** The 403 for an objection or a request to talk through an API key, either way in (card 2684, R3; D19). */
const FLAG_ACT = "Raising an objection or asking to talk is a person's act: it cannot be done with an API key";

/** The event each kind of flag is recorded by when it is raised (card 2684, R6, R16). */
const RAISED_EVENT = { objection: 'objection_raised', talk: 'talk_requested' } as const;

/** The event each kind of flag's reply is recorded by (card 2684, R7, R16). */
const REPLIED_EVENT = { objection: 'objection_answered', talk: 'talk_outcome' } as const;

/** The 403 for a reply through an API key (card 2684, R7; D19): no v1 route replies, and the service refuses a key. */
const REPLY_ACT = "Replying to an objection or a request to talk is a person's act: it cannot be done with an API key";

/** The 404 for a flag that is not this decision's, or that the tolerant reader leaves out (card 2684, R7, R19). */
const FLAG_NOT_FOUND = 'Objection or request to talk not found';

/** The 409 for an objection's reply once the decision is ruled or superseded (card 2684, R7): it was to be answered before. */
const OBJECTION_PAST = 'This decision has been ruled on: an objection is answered before the ruling, and this one can no longer be';

/** The 409 for a second reply (card 2684, R2, R7): settled once. */
const ALREADY_REPLIED = {
	objection: 'This objection has already been answered',
	talk: 'The outcome of this request to talk has already been recorded'
} as const;

/** What `flagTextProblem` answers about `field`, in the 400's words, which never repeat the text (card 2684, R4). */
const textRefusal = (field: 'reason' | 'reply', problem: 'empty' | 'too_long' | 'unprintable', max: number) =>
	problem === 'empty'
		? `${field} is required`
		: problem === 'too_long'
			? `${field} must be at most ${max} characters`
			: `${field} cannot hold control, direction or invisible characters`;

/**
 * A signed-in participant's objection or request to talk (card 2684, R3): the
 * body of `flagAs`. 404 for a decision the caller may not view, a draft among
 * them; 403 through an API key (D19); 403 for a caller who is no live
 * participant, consulted or informed; and 403 for one `reachOf` no longer
 * reaches through their account (card 2677, D12), a person who has left
 * (card 3020) among them. Answers the flag as `OwnFlag`, with no id.
 */
export function raiseFlag(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): { flag: OwnFlag } {
	inWrite();
	const user = requireUser(caller);
	const { decision, access } = requireDecision(user, at.decisionId, 'flag');
	if (keyed(opts)) error(403, FLAG_ACT);
	if (access.participantId === null) error(403, `You cannot ${DECISION_ACTION_WORDS.flag.verb} this decision`);
	const participant = participantOn(decision.id, access.participantId);
	requireReachedByAccount(decision.id, participant);

	return flagAs(decision, participant, body, actorFor(user, sourceOf(opts)), 'session', null);
}

/**
 * A link holder's objection or request to talk (card 2684, R3): the token
 * decides, through `participantForLink`, and any link that opens no decision
 * is the one 404, a removed participant's and a person's who has left among
 * them, as for every write by a link. A person's act alone: 403 through an
 * API key. Recorded `via: 'link'` with source `link`; a signed-in browser's
 * account is noted as `signedIn`, never as the raiser. No per-caller cap: a
 * link holder has no account, and the per-participant caps hold them.
 */
export function raiseFlagByLink(caller: SessionUser | null, at: { token: string }, body: RequestBody, opts: ServiceOptions): { flag: OwnFlag } {
	inWrite();
	const { decision, participant, by, signedIn } = requireLinkHolder(at.token, caller);
	if (keyed(opts)) error(403, FLAG_ACT);

	return flagAs(decision, participant, body, by, 'link', signedIn);
}

/**
 * The decider's reply to an objection, or the outcome of a request to talk
 * (card 2684, R7): `{ reply }`, required, trimmed, asked of
 * `flagTextProblem` with `REPLY_TEXT_RULE` (1 to 4,000 characters). In order:
 * the guard (`reply`: the current decider alone, with board edit; 401, 404
 * for a caller who may not view the decision, 403 for the author, a board
 * owner, an administrator or a former decider), 403 through an API key, 404
 * for a flag not on this decision (or one the tolerant reader leaves out),
 * the body's 400, the status's 409 (`TRANSITIONS.reply`: withdrawn and draft
 * refused), 409 for an objection once the decision is ruled or superseded (a
 * request to talk's outcome may still be recorded, row 11), and 409 for a
 * flag replied to already, as for a guarded update that changes nothing.
 *
 * Writes the reply (`recordFlagReply`, `replied_by` for the record alone),
 * `objection_answered` or `talk_outcome` `{ flagId, notice }` naming no
 * participant, and, after the commit, the notice to the person who raised it
 * where its outcome is `asked` (`participantNoticeOf`): their account by
 * their preferences, or a link holder's snapshot address with no link issued.
 * No activity entry, no live event and no webhook (design S3). Answers the
 * flag as the results page gives it.
 */
export function replyToFlag(
	caller: SessionUser | null,
	at: { decisionId: number; flagId: number },
	body: RequestBody,
	opts: ServiceOptions
): { flag: ResultFlag } {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'reply');
	if (keyed(opts)) error(403, REPLY_ACT);
	const row = requireFlag(decision, at.flagId);
	const reply = readFlagText(body, 'reply', REPLY_TEXT_RULE);

	requireTransition(decision, 'reply', stamp());
	const kind = row.kind === 'talk' ? 'talk' : 'objection';
	if (kind === 'objection' && decision.status !== 'open' && decision.status !== 'closed') error(409, OBJECTION_PAST);
	if (row.reply !== null) error(409, ALREADY_REPLIED[kind]);

	const by = actorFor(user, sourceOf(opts));
	if (!recordFlagReply(row.id, reply, by)) error(409, ALREADY_REPLIED[kind]);
	const notice = participantNoticeOf(decision, row.participantId);
	appendEvent({ decisionId: decision.id, kind: REPLIED_EVENT[kind], detail: { flagId: row.id, notice: notice.outcome } }, by);
	const replied = flagsOf(decision.id).find((flag) => flag.id === row.id);
	if (replied === undefined) error(500, 'The reply could not be read back');
	const flag = resultFlagOf(replied, participantOn(decision.id, row.participantId).name);
	if (notice.outcome === 'asked') notifyFlagReplied(notice.to, decision.id, decision.title, kind);
	return { flag };
}

// ─── Inside the writes ───────────────────────────────────────────────────────
// Those more than one decision service shares are decision-write-shared.ts's (card 2713, D2).

/**
 * An objection or a request to talk, from either way in (card 2684, R3 to
 * R6). The body: `kind`, `objection` or `talk` (400 otherwise); `reason`,
 * text, trimmed, asked of `flagTextProblem` with its kind's rule: an
 * objection's 1 to 4,000 characters, a request to talk's note 0 to 2,000 and
 * `''` when not sent (400 in words that never repeat it). Then 409 on a ruled
 * decision (`FLAGS_CLOSED`, pointing to a concern), and for any status but
 * open and closed in `requireTransition`'s words; 409 for the participant's
 * fourth objection, or fourth request to talk, on the current version, and
 * for a second request to talk while one has no reply; 409 for the decision's
 * 201st; and 429 within 10 minutes of the participant's last, saying from
 * when, in UTC. Every cap and the rest count stored rows as they are
 * (`flagsCounted`, E-L1); the one open request to talk is asked of the
 * tolerant reader (`flagsOfParticipants`, code review C-E-L2).
 *
 * Writes the row (the current version, via the way in), the raise's event
 * `{ flagId, notice, signedIn? }` naming the participant, and, last, the
 * decider's notice after the commit where its outcome is `asked`. Mail never
 * refuses a flag.
 */
function flagAs(
	decision: Decision,
	participant: DecisionParticipant,
	body: RequestBody,
	by: RecordActor,
	via: 'session' | 'link',
	signedIn: { userId: number; name: string } | null
): { flag: OwnFlag } {
	const kind = readChoice(body, 'kind', { from: FLAG_KINDS, required: true });
	const reason = readFlagText(body, 'reason', FLAG_TEXT_RULES[kind]);

	const now = stamp();
	if (decision.status === 'ruled') error(409, FLAGS_CLOSED);
	requireTransition(decision, 'flag', now);
	const counted = flagsCounted(decision.id, participant.id);
	const thisVersion = counted.theirs.filter((row) => row.kind === kind && row.versionNumber === decision.currentVersion);
	requireUnderCap(thisVersion.length, FLAGS_PER_PARTICIPANT_VERSION[kind], flagsLimitWords(kind, FLAGS_PER_PARTICIPANT_VERSION[kind]));
	// The one open request to talk is counted over what the tolerant reader keeps (code review C-E-L2), so that a planted
	// malformed one, which shows nowhere and could never be replied to, cannot block the participant for good.
	if (kind === 'talk' && (flagsOfParticipants([participant.id]).get(participant.id) ?? []).some((flag) => flag.kind === 'talk' && flag.reply === null)) {
		error(409, TALK_OPEN);
	}
	requireUnderCap(counted.onDecision, FLAGS_PER_DECISION, flagsFullWords(FLAGS_PER_DECISION));
	requireRested(counted.theirs.at(-1)?.raisedAt, now, (from) => flagRestWords(RECORD_MAIL_MIN_MINUTES, from));

	const row = appendFlag({ decisionId: decision.id, participantId: participant.id, kind, reason, versionNumber: decision.currentVersion, via });
	const notice = flagNoticeOf(decision, participant, now);
	appendEvent(
		{
			decisionId: decision.id,
			kind: RAISED_EVENT[kind],
			participantId: participant.id,
			versionNumber: decision.currentVersion,
			detail: { flagId: row.id, notice: notice.outcome, ...(signedIn === null ? {} : { signedIn }) }
		},
		by
	);
	if (notice.outcome === 'asked') notifyDecisionFlag(notice.deciderUserId, decision.id, decision.title, kind, notice.heldBefore);
	return { flag: { kind, reason: row.reason, raisedAt: row.raisedAt, versionNumber: row.versionNumber, reply: null, repliedAt: null } };
}

/**
 * The flag's text, `reason`, or the decider's `reply`, trimmed and asked of
 * `flagTextProblem` with `rule` (card 2684, R4): `''` when not sent, a 400
 * when it is not text, and a 400 for each problem the predicate names, in
 * words that never repeat it.
 */
function readFlagText(body: RequestBody, field: 'reason' | 'reply', rule: FlagTextRule): string {
	const text = readText(body, field, { trim: true }) ?? '';
	const problem = flagTextProblem(text, rule);
	if (problem !== null) error(400, textRefusal(field, problem, rule.max));
	return text;
}

/** The flag of this decision the tolerant reader keeps, or the one 404 for any other (card 2684, R7, R19). */
function requireFlag(decision: Decision, flagId: number): DecisionFlag {
	const flag = flagsOf(decision.id).find((row) => row.id === flagId);
	if (flag === undefined) error(404, FLAG_NOT_FOUND);
	return flag;
}

/**
 * Whether a flag from `participant` notifies the decider (card 2684, R15):
 * `deciderNoticeOf` over the participant's earlier raises of either kind, which
 * share one rest of a day (E-M4), `own` where the decider's account is the
 * participant's.
 */
function flagNoticeOf(decision: Decision, participant: DecisionParticipant, now: Stamp) {
	const theirs = eventsOfKind(decision.id, [RAISED_EVENT.objection, RAISED_EVENT.talk]).filter((event) => event.participantId === participant.id);
	return deciderNoticeOf(
		decision,
		theirs.map((event) => ({ outcome: event.detail.notice, at: event.at, eventId: event.id })),
		now,
		[participant.userId]
	);
}
