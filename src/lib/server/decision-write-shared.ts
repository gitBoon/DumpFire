/**
 * decision-write-shared.ts — the pieces the decision services share (card
 * 2713, D2): a plain module called inside a decision service write, never a
 * service itself. It imports no `inWrite`, exports no function whose first
 * parameter is the caller, declares no `READS`, and writes nothing; it is
 * imported by name by the decision services (`decision-*-writes.ts`) alone,
 * and imports none of them (`tests/check-at-the-write.test.ts`, the helper
 * pin). Each helper used by one service alone stays private there.
 *
 * Card 2682 adds the API v1 routes (`src/routes/api/v1/decisions`), which
 * call `createDecision`, `updateDraft`, `setDecider`, `setParticipants`,
 * `extendDecision`, `withdrawDecision`, `deleteDecision`,
 * `supersedeDecision`, `askQuestion`, `answerQuestion`, `linkCard` and
 * `unlinkCard` with `source: 'api'`. A write is an API key's by the route's
 * word or by the credential it was let in with (`sourceOf`, D7), either
 * alone, so that a later route handing `'ui'` by mistake opens nothing. A key
 * is refused what mails people (opening, re-publishing, a dry run, Resend:
 * D3), closing (D29), a participant's account and address (D6), participants
 * and the decider of a decision ever opened (D4), and withdrawing or deleting
 * one (D5), and reopening a closed one by Extend (code review S2), or any
 * Extend that would ask someone for their view (card 2744, D5): each is a
 * person's act on the decision's page. Extend never brings a closing time
 * earlier, for anyone (D30).
 *
 * Each write has the one shape of a service (`ServiceOptions` in
 * `write-as.ts`): `inWrite()` first, then the guard (`requireDecision`, or
 * `requireBoard` for a new draft: 401, 404, 403), every field read from the
 * body (400), the status and the other checks (409), and the writes, with
 * `updated_at` stamped. Then the record's events, the activity entry, the
 * live event and the mails. Refusals are kit `error()`s. Who may do what is
 * `DECISION_RULES` in decision-access.ts: a grant resting on authorship or
 * board ownership also needs edit access to the board now (decision 6).
 *
 * What the record holds is written through decision-record.ts alone, links
 * through decision-links.ts, and mail through decision-mail.ts, whose links
 * are made on the App URL or `ORIGIN` and never on `opts.baseUrl` (decision
 * 28). A draft is nobody's business but its author's, its decider's, the
 * board's owners' and administrators': it writes no activity entry, no live
 * event and no event naming a participant (decisions 5 and 21, comment
 * 5599). Each lifecycle step of a decision that has been opened and whose
 * board is there writes its activity entry, its action written out at its
 * call as `activity-twins.test.ts` requires, and the `decision` live event
 * (decisions 21 and 23).
 *
 * Card 2684 (R5, R15; its plan review's E-M4) adds what a participant's
 * concern, question and objection or request to talk share: the cap and the
 * rest on raising one (`requireUnderCap`, `requireRested`), the decider's
 * notice of one (`deciderNoticeOf`, on the one rule of a notice held a day
 * per participant, `recipientNoticeOf`), and the notice to the person whose
 * question or flag is answered (`participantNoticeOf`). Each keeps the words
 * and statuses its callers gave before.
 */
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db, sqlite } from './db';
import { decisionParticipants, users, type Decision, type DecisionParticipant } from './db/schema';
import { accountTimeUnreadable } from './access-changes';
import type { SessionUser } from './auth';
import { allOptionsOf, participantsOf, revisionOf } from './decision-content';
import { accountHistory, eventsOfKind, lastMailAt, mailsSince, peopleById, recordMailsSince, snapshotOf, type RecordActor } from './decision-record';
import { mailedLinkOf, participantForLink, reachOf, type Reach } from './decision-links';
import { CALLER_MAIL_DAILY_CAP, DAY_MS, dailyCapFrom, decisionLinkBase, type HoldReason, later, mailRestOf, RECORD_MAIL_MIN_MINUTES } from './decision-mail';
import { isSmtpConfigured } from './email';
import { shouldNotifyUser } from './notifications';
import { actorOf, type ActivityDecision } from './logActivity';
import { decisionStatus } from './decision-status';
import { takeAllowance } from './rate-limit';
import { DECISION_TEXT_MAX } from '$lib/decision-rules';
import { DEAD_DECISION_LINK, NO_LONGER_REACHED, STALE_REVISION } from '$lib/decision-words';
import { stamp, type Stamp } from '$lib/timestamps';
import { writingWithKey, type ServiceOptions } from './write-as';

/** The most participants one decision may be given at once. */
export const MOST_PARTICIPANTS = 5000;

/** How long a response's comment, and each comment on an option, may be (decision 11): the comment's is the shared `DECISION_TEXT_MAX`. */
export const COMMENT_MAX = DECISION_TEXT_MAX;

// ─── What an API key may not do (card 2682, D3 to D6, D29, D30) ──────────────
// Shared by more than one decision service. A non-service module may export constants; each service still exports its
// functions alone (D20).

/** The 403 for opening, re-publishing, a dry run and Resend through an API key (card 2682, D3): each mails people. */
export const MAIL_ACT =
	"Opening, re-publishing, a dry run and sending an invitation again mail people: a person does them on the decision's page. An API key cannot";

/** The 403 for participants or the decider of a decision ever opened, through an API key (card 2682, D4). */
export const OPENED_PEOPLE =
	"This decision has been opened: who is included in it, and who decides it, are changed on the decision's page. An API key cannot";

/**
 * The source a write is recorded and judged by (card 2682, D7): `'api'` when
 * the route said so, or when the write was let in with an API key, whatever
 * the route said (`writingWithKey()`). The one place the decision services read the
 * route's word, so that a later route handing `'ui'` by mistake opens no
 * person's act to a key and records no agent's write as a person's
 * (`tests/decisions-api.test.ts` case 3).
 */
export function sourceOf(opts: ServiceOptions): ServiceOptions['source'] {
	return opts.source !== 'ui' || writingWithKey() ? 'api' : 'ui';
}

/** Whether the write is an API key's, by the route's word or by the credential (card 2682, D7). */
export function keyed(opts: ServiceOptions): boolean {
	return sourceOf(opts) === 'api';
}

// ─── Inside the writes ───────────────────────────────────────────────────────

/** What a participant row copies from a person's snapshot (S7). */
export function snapshotColumns(snapshot: NonNullable<ReturnType<typeof snapshotOf>>) {
	return { name: snapshot.name, email: snapshot.email, jobTitle: snapshot.jobTitle, groups: snapshot.groups, userId: snapshot.userId };
}

/** The participant row of this decision, or 404 for one that is not on it. */
export function participantOn(decisionId: number, participantId: number): DecisionParticipant {
	const row = db
		.select()
		.from(decisionParticipants)
		.where(and(eq(decisionParticipants.id, participantId), eq(decisionParticipants.decisionId, decisionId)))
		.get();
	if (!row) error(404, 'Participant not found');
	return row;
}

/** A 403 unless `reachOf` still reaches the participant through their account (card 2677, D12): one who has left, or lost the account or the address, is not. */
export function requireReachedByAccount(decisionId: number, participant: DecisionParticipant): void {
	const reach = reachesOf(decisionId, [participant]).get(participant.id)!;
	if (!('via' in reach) || reach.via !== 'account') error(403, NO_LONGER_REACHED);
}

/**
 * The participant and decision a personal link is for, or the one 404 for any
 * link that opens none (card 2677, decision 6); with the record's actor for
 * the link holder, no account, the participant's snapshot name, and the link's
 * own source (decision 10); and the signed-in account beside the link holder's
 * act, noted in its event's detail (decision 9, R8), or null with no session.
 * Card 2713 (D3) folds `requireLink`, `linkActor` and `signedInOf` into this
 * one helper: the token first, the session second, and nothing decided by the
 * session. The two it adds read nothing, so no refusal, order or record moves.
 */
export function requireLinkHolder(
	token: string,
	signedIn: SessionUser | null
): { decision: Decision; participant: DecisionParticipant; by: RecordActor; signedIn: { userId: number; name: string } | null } {
	const found = participantForLink(token);
	if ('refused' in found) error(404, DEAD_DECISION_LINK);
	const { decision, participant } = found;
	return {
		decision,
		participant,
		by: { userId: null, name: participant.name, source: 'link' },
		signedIn: signedIn ? { userId: signedIn.id, name: signedIn.username } : null
	};
}

/** How each of the rows would be reached by a record-bearing mail now (`reachOf`, decision 16), by participant id. */
export function reachesOf(decisionId: number, rows: DecisionParticipant[]): Map<number, Reach> {
	const persons = peopleById(rows.map((row) => row.personId).filter((id): id is number => id !== null));
	const history = accountHistory(decisionId);
	return new Map(
		rows.map((row) => [row.id, reachOf(row, row.personId === null ? null : (persons.get(row.personId) ?? null), history.get(row.id) ?? false)])
	);
}

/**
 * Card 3033 R14: a 409 for a decider whose account's creation time names no
 * moment, before anything is written. The record of access changes names a
 * decider by its account's id and creation time, so such an account could
 * only be recorded as no decider, and a later restore would take it off.
 */
export function requireDeciderRecordable(account: { id: number; username: string }): void {
	if (accountTimeUnreadable(sqlite, account.id)) {
		error(409, `${account.username}'s account has a creation time this server cannot read, so it cannot be recorded as a decision's decider: an administrator puts it right on the host first`);
	}
}

/**
 * A 409 unless `sent` is the decision's revision as it is now (card 2676,
 * decision 10): someone changed it since the caller read it.
 */
export function requireRevision(decision: Decision, sent: string): void {
	if (revisionOf(decision, allOptionsOf(decision.id), participantsOf(decision.id)) !== sent) error(409, STALE_REVISION);
}

/**
 * A 409 for a participant mailed by the record less than
 * `RECORD_MAIL_MIN_MINUTES` ago, or `RECORD_MAIL_DAILY_CAP` times in the last
 * 24 hours (card 2697, Q24), saying from when, in UTC, they may be mailed
 * again (decision 31): `mailRestOf`, the rule the editor's delivery panel
 * asks too. Read from the record alone: a participant's events go only with
 * their decision, whose rows can then no longer be mailed.
 */
export function requireMailRested(rows: DecisionParticipant[], now: Stamp): void {
	if (rows.length === 0) return;
	const ids = rows.map((row) => row.id);
	const last = lastMailAt(ids);
	const recent = mailsSince(ids, dayBefore());
	for (const row of rows) {
		const held = mailRestOf(row.name, last.get(row.id), recent.get(row.id) ?? [], now);
		if (held !== null) error(409, held.words);
	}
}

/**
 * A 429 when `coming` more record mails would take the caller past
 * `CALLER_MAIL_DAILY_CAP` in the last 24 hours, across every decision (card
 * 2697's code review, part B, S2), saying from when, in UTC, they would fit:
 * read from the mail events the caller's writes have recorded, and then from
 * an allowance held in memory, which a deletion of the decisions, and their
 * events with them, does not give back. `coming` is the participants the
 * write would mail. Asked after the write's other refusals, so that a write
 * they refuse takes nothing; on opening and re-publishing, before the publish
 * limit, which stays the last thing asked. A publish that limit then refuses
 * has taken from this allowance: it errs towards less mail.
 */
export function requireRecordMailAllowed(user: SessionUser, coming: number, now: Stamp): void {
	const refusal = recordMailRefusal(user, coming, now);
	if (refusal !== null) error(429, refusal);
}

/**
 * `requireRecordMailAllowed`'s rule, answering its words rather than
 * refusing, null where the mail fits (card 2740: a role change's asking mails
 * are held back, not the write refused). `pending` is the mail this same
 * write has already been allowed and not yet recorded, so that the events'
 * count holds it too. The allowance in memory is taken only where the events
 * let the mail through, as before.
 */
function recordMailRefusal(user: SessionUser, coming: number, now: Stamp, pending = 0): string | null {
	if (coming === 0) return null;
	if (coming > CALLER_MAIL_DAILY_CAP) {
		return `This would mail ${coming} participants: one account may cause at most ${CALLER_MAIL_DAILY_CAP} decision mails in 24 hours`;
	}
	const words = (from: Stamp) =>
		`This would take your decision mail past ${CALLER_MAIL_DAILY_CAP} in the last 24 hours: it can be sent from ${from} UTC`;
	const fromEvents = dailyCapFrom(recordMailsSince(user.id, dayBefore()), CALLER_MAIL_DAILY_CAP, pending + coming);
	if (fromEvents !== null && now < fromEvents) return words(fromEvents);
	const took = takeAllowance(`decision-record-mail:${user.id}`, coming, CALLER_MAIL_DAILY_CAP, DAY_MS);
	if (!took.taken) return words(stamp(new Date(Date.now() + took.retryAfterSecs * 1000)));
	return null;
}

/**
 * Card 2740 (D3): which of `rows`, live participants just made consulted on
 * a decision open for input, are not to be sent the asking invitation now,
 * and why, by participant id; the rest are sent it. One `reachOf` skips is
 * left to `queueRecordMails`, which records its own reason. Of the others,
 * one the 10-minute rest or the daily cap holds (`mailRestOf`, the rule the
 * re-send and the delivery panel ask) is held as `resting` or `daily_cap`;
 * then, if the caller's daily cap would not take the rest of them, together
 * with the `pending` invitations this write sends to people it includes,
 * every one left is held as `caller_cap`. Read only, but for the caller's
 * allowance, taken where the mail fits.
 */
export function heldAsks(user: SessionUser, decisionId: number, rows: DecisionParticipant[], pending: number, now: Stamp): Map<number, HoldReason> {
	const held = new Map<number, HoldReason>();
	if (rows.length === 0) return held;
	const reaches = reachesOf(decisionId, rows);
	const reachable = rows.filter((row) => !('skip' in reaches.get(row.id)!));
	if (reachable.length === 0) return held;
	const ids = reachable.map((row) => row.id);
	const last = lastMailAt(ids);
	const recent = mailsSince(ids, dayBefore());
	for (const row of reachable) {
		const rest = mailRestOf(row.name, last.get(row.id), recent.get(row.id) ?? [], now);
		if (rest !== null) held.set(row.id, rest.reason);
	}
	const sending = reachable.filter((row) => !held.has(row.id));
	if (recordMailRefusal(user, sending.length, now, pending) !== null) for (const row of sending) held.set(row.id, 'caller_cap');
	return held;
}

// ─── A participant's concern, question, objection or request to talk (card 2684, R5, R15) ─

/** A 409 in `words` once `count` has reached `cap` (card 2684, R5): the per-participant and per-decision caps on raising. */
export function requireUnderCap(count: number, cap: number, words: string): void {
	if (count >= cap) error(409, words);
}

/**
 * A 429 while `RECORD_MAIL_MIN_MINUTES` have not passed since `lastAt`, the
 * participant's last concern, question, objection or request to talk (card
 * 2684, R5), in `words` given the moment, in UTC, from which the next may be
 * raised. None with no last, or a last that names no moment.
 */
export function requireRested(lastAt: Stamp | undefined, now: Stamp, words: (from: Stamp) => string): void {
	const rested = lastAt === undefined ? null : later(lastAt, RECORD_MAIL_MIN_MINUTES * 60 * 1000);
	if (rested !== null && now < rested) error(429, words(rested));
}

/** One earlier notice about the same participant to the same recipient, as its event recorded it: its outcome and when. */
export type EarlierNotice = { outcome: unknown; at: Stamp };

/**
 * The one rule of a notice to `userId` about something a participant raised
 * (card 2679, decision 3; card 2678, decision 5; card 2684, R15), decided
 * inside the write: `no_link_address` with no App URL or `ORIGIN`; `prefs_off`
 * when their `email_decisions` or every mail is switched off; `no_mail_host`
 * with no mail host (2679's code review, F2: nothing would be sent, so nothing
 * holds the next one back); `held` within 24 hours of the last `asked` of
 * `earlier`, the same participant's notices to them in order; and `asked`
 * otherwise, carrying how many were held since that one. Only `asked` holds
 * the next back, as only it sent anything.
 */
export function recipientNoticeOf(
	userId: number,
	earlier: readonly EarlierNotice[],
	now: Stamp
): { outcome: 'no_link_address' | 'prefs_off' | 'no_mail_host' | 'held' } | { outcome: 'asked'; heldBefore: number } {
	if (decisionLinkBase() === null) return { outcome: 'no_link_address' };
	if (!shouldNotifyUser(userId, 'email_decisions')) return { outcome: 'prefs_off' };
	if (!isSmtpConfigured()) return { outcome: 'no_mail_host' };
	const lastAsked = earlier.findLastIndex((notice) => notice.outcome === 'asked');
	if (lastAsked !== -1) {
		const rested = later(earlier[lastAsked].at, DAY_MS);
		if (rested === null || now < rested) return { outcome: 'held' };
	}
	return { outcome: 'asked', heldBefore: earlier.slice(lastAsked + 1).filter((notice) => notice.outcome === 'held').length };
}

/** The decider's notice of a concern or a flag, as decided inside the write (`deciderNoticeOf`). */
export type DeciderNotice =
	| { outcome: 'no_decider' | 'own' | 'no_link_address' | 'prefs_off' | 'no_mail_host' | 'held' }
	| { outcome: 'asked'; deciderUserId: number; heldBefore: number };

/**
 * Whether something a participant raised notifies the decision's decider
 * (card 2679, decision 3, S3; card 2684, R15), decided inside the write:
 * `no_decider` with no decider account; `own` where the decider's account is
 * one of `raisedBy`, the raiser's (never asked of a concern, whose `raisedBy`
 * is empty, so its outcomes are as before); and then `recipientNoticeOf`'s
 * rule over `earlier`, the same participant's notices of the same kind or
 * kinds, in order. Per participant: their first always notifies, and nobody
 * else's holds it back. Only the notices after the decision's last
 * `decider_changed` event are asked (code review C-S-L4): those went to an
 * earlier decider, so a new decider is told of the first after the change.
 * Each of `earlier` names its event's id, which places it against the change.
 */
export function deciderNoticeOf(
	decision: Decision,
	earlier: readonly (EarlierNotice & { eventId: number })[],
	now: Stamp,
	raisedBy: readonly (number | null)[] = []
): DeciderNotice {
	const decider =
		decision.deciderUserId === null ? undefined : db.select({ id: users.id }).from(users).where(eq(users.id, decision.deciderUserId)).get();
	if (decider === undefined) return { outcome: 'no_decider' };
	if (raisedBy.includes(decider.id)) return { outcome: 'own' };
	const changedAt = eventsOfKind(decision.id, 'decider_changed').at(-1)?.id ?? 0;
	const notice = recipientNoticeOf(
		decider.id,
		earlier.filter((before) => before.eventId > changedAt),
		now
	);
	return notice.outcome === 'asked' ? { outcome: 'asked', deciderUserId: decider.id, heldBefore: notice.heldBefore } : notice;
}

/** The notice to a participant whose question or flag is answered, as decided inside the write (`participantNoticeOf`). */
export type ParticipantNotice =
	| { outcome: 'not_reached' | 'no_link_address' | 'prefs_off' | 'no_mail_host' }
	| { outcome: 'asked'; to: { userId: number } | { address: string; latestLink: boolean } };

/**
 * Whether an answer a person now stands behind tells the participant who
 * asked or raised it (card 2678, decision 5; card 2684, R15, moved here from
 * the question module in its slice S1b), decided inside the write:
 * `not_reached` for no participant, one removed, or one `reachOf` skips (card
 * 3020's people who have left among them); an account holder
 * `no_link_address`, `prefs_off`, `no_mail_host`, or `asked` to their
 * account; a link holder `no_mail_host`, or `asked` to the participant's
 * snapshot address, which no preference governs, and never to an account a
 * browser beside their link was signed in as. No rest: each is answered once.
 *
 * A link holder's notice issues no link (card 2721, D1). `latestLink` is
 * whether it may tell them to use the one in their latest email:
 * `mailedLinkOf`, the closing-date reminder's rule, on the write's clock (D2,
 * D4). Otherwise it tells them to ask for a new one (D3).
 */
export function participantNoticeOf(decision: Decision, participantId: number | null): ParticipantNotice {
	if (participantId === null) return { outcome: 'not_reached' };
	const participant = db
		.select()
		.from(decisionParticipants)
		.where(and(eq(decisionParticipants.id, participantId), eq(decisionParticipants.decisionId, decision.id)))
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

/** The moment 24 hours ago, from which the daily caps count. */
export function dayBefore(): Stamp {
	return stamp(new Date(Date.now() - DAY_MS));
}

/**
 * What a decision's activity entry holds but its action (decision 21, 4.10):
 * its board, no card, the actor and the tree. The action is written at each
 * call, as `activity-twins.test.ts` requires. Card 2680 (decision 22): a
 * link's entry names its card, on the card's board.
 */
export function decisionEntry(boardId: number, detail: string, user: SessionUser, opts: ServiceOptions, cardId: number | null = null) {
	return { boardId, cardId, detail, source: sourceOf(opts), ...actorOf(user) };
}

/**
 * What a decision event says of its decision (card 2689, R5, R10), for the
 * entry of the four acts that send one: its id, its title, its shown status
 * at `now`, and on a supersede the id of the decision that replaced it. Never
 * a name, a count, an option, a reason or a moment: `logActivity` builds the
 * payload from this alone, and sends nothing for an entry without it.
 */
export function decisionWebhookOf(row: Pick<Decision, 'id' | 'title' | 'status' | 'closesAt'>, now: Stamp, supersededById?: number): ActivityDecision {
	return { id: row.id, title: row.title, status: decisionStatus(row, now), ...(supersededById === undefined ? {} : { supersededById }) };
}
