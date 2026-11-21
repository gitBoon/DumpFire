/**
 * decision-lifecycle-writes.ts — a decision opened, re-published, closed,
 * extended, withdrawn and deleted (card 2675, plan section 4.7), with the
 * guards of the withdrawal and the delete (`READS`). Card 2713 moved them
 * here from the former decision service, unchanged (D1).
 *
 * Card 2697 requires the revision on opening and re-publishing, and limits
 * the mail these writes send: per caller, the publishes and (its code
 * review's part B, S2) the record mails caused, across decisions, in 24
 * hours; per participant, the record mails in 24 hours; and a closing time at
 * most a year ahead. Its guards (`READS`) make every refusal of the writes
 * whose routes ask for the caller's password, so that none costs a check:
 * the delete and the withdrawal of a decision that was ever opened (Q9, Q10,
 * Q29).
 *
 * Card 2680: deleting a linked decision leaves an entry on each linked card's
 * board.
 *
 * Card 2682 adds the API v1 routes, which call `extendDecision`,
 * `withdrawDecision` and `deleteDecision` with `source: 'api'`. A key is
 * refused opening and re-publishing (D3), closing (D29), withdrawing or
 * deleting a decision ever opened (D5), and reopening a closed one by Extend
 * (code review S2), or any Extend that would ask someone for their view (card
 * 2744, D5). Extend never brings a closing time earlier, for anyone (D30).
 *
 * Each write has the one shape of a service, and the record, the activity
 * entry, the live event and the mail are written as decision-write-shared.ts's
 * header says.
 */
import { error } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { db, sqlite } from './db';
import { cards, columns, decisionCardLinks, decisionOptions, decisionParticipants, decisions, type Decision, type DecisionOption, type DecisionParticipant } from './db/schema';
import { requirePasswordHeld, type SessionUser } from './auth';
import { listedOptionIds, liveOptionsOf, openFactsOf, optionChanges, participantsOf } from './decision-content';
import { actorFor, appendEvent, appendVersion, askingMailsOf, currentRound, publishesSince, snapshotOf, type RecordActor } from './decision-record';
import { currentResultsOf } from './decision-results';
import { DAY_MS, dailyCapFrom, decisionLinkBase, PUBLISH_DAILY_CAP, queueRecordMails } from './decision-mail';
import { decisionStatus, requireTransition } from './decision-status';
import { NO_LINK_ADDRESS } from './email';
import { emit } from './events';
import { ACTIONS, logActivity } from './logActivity';
import { takeAllowance } from './rate-limit';
import { readBoolean, readText, readTimestamp, type RequestBody } from './request-body';
import { CLOSES_TOO_FAR, CLOSES_TOO_FAR_TO_REPUBLISH, closesTooFar, refusalsOf } from '$lib/decision-readiness';
import { openForInput } from '$lib/decision-rules';
import { requireDecision, requireUser } from './route-guards';
import { stamp, type Stamp } from '$lib/timestamps';
import { inWrite, type ServiceOptions } from './write-as';
import {
	dayBefore,
	decisionEntry,
	heldAsks,
	keyed,
	MAIL_ACT,
	reachesOf,
	requireMailRested,
	requireRecordMailAllowed,
	requireRevision,
	snapshotColumns,
	sourceOf
} from './decision-write-shared';
import { ACCESS_KIND, recordAccessChange } from './access-changes';

/**
 * The functions here that only read: the guards of the withdrawal and the
 * delete, which their routes ask before the caller's password (card 2697,
 * Q10, Q29). Every other export is a write, and starts with `inWrite()`.
 */
export const READS: readonly string[] = ['decisionWithdrawGuard', 'decisionDeleteGuard'];

// ─── What an API key may not do (card 2682, D3 to D6, D29, D30) ──────────────
// Module constants, not exported (D20): a service module exports its functions alone.

/** The 403 for withdrawing or deleting a decision ever opened, through an API key (card 2682, D5): the page asks the password. */
const OPENED_ACT = "This decision has been opened: withdrawing or deleting it asks for your password on the decision's page. An API key cannot";

/** The 403 for closing a decision through an API key (card 2682, D29): an early close makes a later ruling early. */
const CLOSE_ACT =
	"Closing a decision for input before its closing time is done on the decision's page: it makes a later ruling early. An API key cannot";

/**
 * The 403 for extending a closed decision through an API key (card 2682, code review S2): Extend on a closed decision
 * reopens it, undoing a person's close, so a key extends only an open one.
 */
const REOPEN_ACT = "This decision is closed for input: reopening it by Extend is done on the decision's page. An API key cannot";

/**
 * The 403 for a key's Extend that would ask someone for their view (card 2744, D5): a decision stored open past its closing
 * time is reopened for input by Extend, which mails each consulted participant the round has not reached, and a key never
 * causes record mail. A key's Extend with nobody to ask goes ahead.
 */
const REOPEN_ASKS_ACT =
	"This Extend reopens the decision for input and would ask people consulted on it for their view by mail: a person does that on the decision's page. An API key cannot";

/** The 400 for an Extend that would not move the closing time later, for every source (card 2682, D30). */
const EXTENDS_EARLIER = "closesAt must be later than the decision's current closing time: Extend never brings it earlier";

/**
 * Open a draft: the one moment its participants are told. Refused, 409 with
 * nothing written or sent (decision 20), for no decider; a board that is gone;
 * a decider who can no longer edit it; no `closes_at` in the future; fewer
 * than two live options; no consulted participant; a participant whose person
 * has left or been deleted; a closing time more than `CLOSES_WITHIN_DAYS`
 * ahead (the code review's part B, S3); no mail host; no address to make a link on (the
 * App URL or `ORIGIN`, decision 28); and two participants whose snapshots,
 * taken again now, hold the same account (decision 29).
 *
 * Then the snapshots are taken again, `included_at` now (decision 19); the
 * decision is `open`, version 1, its live options added in it; version 1 is
 * the working content with the live options' text, asking for views; the
 * events `published`, `opened` and `included { role, hadAccount }` for each
 * participant; the invitations, through `reachOf`; `decision_opened`; and the
 * `decision` live event.
 *
 * The refusals are `refusalsOf` in `$lib/decision-readiness`, from the facts
 * `openFactsOf` reads, and the first is answered (card 2676, decision 11):
 * the readability check on the edit page is the same list, so it cannot say
 * a draft opens when this refuses it.
 *
 * Card 2697: `revision` is required (Q1): opening mails everyone the working
 * copy, so a presser who has not seen a change made since they read it must
 * not send it. A different one is a 409, asked after the status and before
 * every other 409. Then the caller's record mail limit (the code review's
 * part B, S2): 429 where inviting every participant would take them past
 * `CALLER_MAIL_DAILY_CAP` in 24 hours. Last of all, the caller's publish
 * limit (Q23): 429 once they have opened or re-published `PUBLISH_DAILY_CAP`
 * decisions in 24 hours.
 *
 * Card 3033: the live places alone are read (R10), so a place a restore or
 * the start marked removed is not counted, snapshotted or included; and where
 * a place's snapshot, taken again, holds another account than the place did,
 * `decision_account` is recorded (D7): `none` for the one it held and `held`
 * for the one it now holds.
 */
export function openDecision(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	// Card 2682, D3: before any row is read, so the refusal says nothing about which ids exist.
	if (keyed(opts)) error(403, MAIL_ACT);
	const { decision } = requireDecision(user, at.decisionId, 'open');

	const revision = readText(body, 'revision', { required: true });

	const now = stamp();
	requireTransition(decision, 'open', now);
	requireRevision(decision, revision);
	const [refusal] = refusalsOf(openFactsOf(decision, now));
	if (refusal !== undefined) error(409, refusal.words);
	const options = liveOptionsOf(decision.id);
	const rows = participantsOf(decision.id, { live: true });
	// The code review's part B (S2): every participant counted, as each may be invited.
	requireRecordMailAllowed(user, rows.length, now);
	requirePublishAllowed(user, now);

	// Decision 19: the snapshots, taken again now, which decision 29 has been asked of above.
	const snapshots = rows.map((row) => ({ row, snapshot: snapshotOf(row.personId!)! }));

	const by = actorFor(user, sourceOf(opts));
	for (const { row, snapshot } of snapshots) {
		db.update(decisionParticipants)
			.set({ ...snapshotColumns(snapshot), includedAt: now })
			.where(eq(decisionParticipants.id, row.id))
			.run();
		if (row.userId === snapshot.userId) continue;
		if (row.userId !== null) recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionAccount, subject: row.id, holder: row.userId, access: 'none' });
		if (snapshot.userId !== null) recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionAccount, subject: row.id, holder: snapshot.userId, access: 'held' });
	}
	const opened = db
		.update(decisions)
		.set({ status: 'open', openedAt: now, currentVersion: 1, updatedAt: now })
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	db.update(decisionOptions)
		.set({ addedInVersion: 1 })
		.where(and(eq(decisionOptions.decisionId, decision.id), isNull(decisionOptions.retiredInVersion)))
		.run();
	appendVersion({ decisionId: decision.id, number: 1, content: versionContent(decision, options), changeNote: null, asksAgain: true }, by);

	appendEvent({ decisionId: decision.id, kind: 'published', versionNumber: 1, detail: { asksAgain: true, changeNote: null } }, by);
	appendEvent({ decisionId: decision.id, kind: 'opened', detail: { closesAt: opened.closesAt } }, by);
	for (const { row, snapshot } of snapshots) {
		appendEvent({ decisionId: decision.id, kind: 'included', participantId: row.id, detail: { role: row.role, hadAccount: snapshot.userId !== null } }, by);
	}
	queueRecordMails(opened, 'invitation', { by });

	// `refusalsOf` refused a decision whose board is gone (`no_board`), so it is there.
	const boardId = decision.boardId!;
	logActivity({ action: ACTIONS.decisionOpened, ...decisionEntry(boardId, `"${opened.title}"`, user, opts) });
	emit(boardId, 'decision', { decisionId: opened.id, status: decisionStatus(opened, now), boardId });
	return opened;
}

/**
 * Publish the working content again as version N+1: `changeNote` (text,
 * trimmed, 1 to 2,000) and `askAgain` (true or false). Asking again mails
 * the consulted `asked_again` and the informed `told_of_change`, and opens a
 * closed decision again; telling only mails `told_of_change`. Refused 409 once `closes_at` has passed (E10); for telling
 * only when an option would be added or retired (E2, decision 24); when the
 * new version would hold fewer than two live options (decision 20); with no
 * address to make a link on (decision 28); and while any participant it
 * would mail was mailed in the last 10 minutes (decision 31); and, the code
 * review's part B (S3), a closing time more than `CLOSES_WITHIN_DAYS` ahead.
 *
 * An option not yet published is added in the new version; a published one
 * still live but no longer in the working content's `options` is retired in
 * it (decision 24). Writes `published`, `decision_republished` and the live
 * event.
 *
 * Card 2697: `revision` is required, as on opening (Q1), and asked after the
 * status and before every other 409; a participant mailed
 * `RECORD_MAIL_DAILY_CAP` times in 24 hours is refused as one mailed in the
 * last 10 minutes is (Q24); and, last of all, the caller's publish limit
 * (Q23).
 *
 * Card 2744 (D3), widened by card 2739 (D2 to D4) to a decision open for
 * input too: each live consulted participant the current round has not
 * reached (`unaskedOf`, read before the new version) was never asked, so is
 * never sent words that assume an earlier ask: asking again (which reopens a
 * closed decision) sends them the invitation (`invited`); telling only sends
 * them nothing (as card 2743 sends nothing to one added as consulted while
 * closed; on an open decision Resend asks them), and neither the rest nor
 * the caller's cap counts them, but for one whose asking mail still awaits
 * its outcome (`askingInFlight`, code review 2026-11-05): the rest holds the
 * write over them, as before card 2739, so no new version overtakes it.
 *
 * Card 2739 (D1): asking again sends `asked_again` to the other consulted
 * participants alone; an informed participant is asked nothing, and cannot
 * respond, so is sent `told_of_change`, as telling only sends everyone it
 * mails. Every one of these mails counts against the rest and the caps.
 */
export function republishDecision(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	if (keyed(opts)) error(403, MAIL_ACT);
	const { decision } = requireDecision(user, at.decisionId, 'republish');

	const changeNote = readText(body, 'changeNote', { required: true, trim: true, min: 1, max: 2000 });
	const askAgain = readBoolean(body, 'askAgain', { required: true });
	const revision = readText(body, 'revision', { required: true });

	const now = stamp();
	requireTransition(decision, 'republish', now);
	requireRevision(decision, revision);
	if (decision.closesAt === null || decision.closesAt <= now) {
		error(409, "This decision's closing time has passed: it cannot be re-published until it is extended");
	}
	// The code review's part B (S3): as opening refuses it, a personal link must not outlast a year and 90 days.
	if (closesTooFar(decision.closesAt, now)) error(409, CLOSES_TOO_FAR_TO_REPUBLISH);
	const number = decision.currentVersion + 1;
	const live = liveOptionsOf(decision.id);
	const { adding, retiring } = optionChanges(live, listedOptionIds(decision.workingContent));
	if (!askAgain && adding.length + retiring.length > 0) {
		error(409, 'Telling of a change cannot add or retire an option: publish a change to the options by asking everyone again');
	}
	// Decision 20, as opening holds it: the new version keeps two live options (the code review's F4).
	if (live.length - retiring.length < 2) error(409, 'This decision would have fewer than two options: it cannot be re-published');
	if (decisionLinkBase() === null) error(409, NO_LINK_ADDRESS);
	// Card 2744 (D3), card 2739 (D2): whom the round has not reached, open or closed, read before the new version: asking again
	// sends them the invitation (and reopens a closed decision); telling only sends them nothing, nor counts them.
	const unaskedRows = unaskedOf(decision);
	const unasked = new Set(unaskedRows.map((row) => row.id));
	const current = participantsOf(decision.id).filter((row) => row.removedAt === null && (askAgain || !unasked.has(row.id)));
	const reaches = reachesOf(decision.id, current);
	const mailed = current.filter((row) => 'via' in reaches.get(row.id)!);
	// Code review 2026-11-05: telling only still holds the write to the rest of one it leaves out whose asking mail awaits its
	// outcome, as before card 2739, so that no new version is published while that mail, quoting the old one, is in flight.
	requireMailRested(askAgain ? mailed : [...mailed, ...askingInFlight(decision, unaskedRows)], now);
	requireRecordMailAllowed(user, mailed.length, now);
	requirePublishAllowed(user, now);

	const by = actorFor(user, sourceOf(opts));
	for (const option of adding) db.update(decisionOptions).set({ addedInVersion: number }).where(eq(decisionOptions.id, option.id)).run();
	for (const option of retiring) db.update(decisionOptions).set({ retiredInVersion: number }).where(eq(decisionOptions.id, option.id)).run();
	const reopens = askAgain && decision.status === 'closed';
	const row = db
		.update(decisions)
		.set({ currentVersion: number, updatedAt: now, ...(reopens ? { status: 'open', closedAt: null } : {}) })
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	appendVersion({ decisionId: decision.id, number, content: versionContent(decision, liveOptionsOf(decision.id)), changeNote, asksAgain: askAgain }, by);
	appendEvent({ decisionId: decision.id, kind: 'published', versionNumber: number, detail: { asksAgain: askAgain, changeNote } }, by);
	// Card 2744 (D3), card 2739 (D3): one never asked is sent the first-time invitation, not words that assume an earlier ask.
	const inviting = current.filter((participant) => unasked.has(participant.id));
	const reached = current.filter((participant) => !unasked.has(participant.id));
	// Card 2739 (D1): only a consulted participant is asked again; an informed one is asked nothing, so is told of the change.
	const askingAgain = new Set(askAgain ? reached.filter((participant) => participant.role === 'consulted').map((participant) => participant.id) : []);
	const telling = reached.filter((participant) => !askingAgain.has(participant.id));
	if (inviting.length > 0) queueRecordMails(row, 'invitation', { by, participants: inviting });
	if (askingAgain.size > 0) queueRecordMails(row, 'asked_again', { by, changeNote, participants: reached.filter((participant) => askingAgain.has(participant.id)) });
	if (telling.length > 0) queueRecordMails(row, 'told_of_change', { by, changeNote, participants: telling });

	if (row.boardId !== null) {
		const told = askAgain ? 'everyone asked again' : 'told of a change';
		logActivity({ action: ACTIONS.decisionRepublished, ...decisionEntry(row.boardId, `"${row.title}": version ${number}, ${told}`, user, opts) });
		emit(row.boardId, 'decision', { decisionId: row.id, status: decisionStatus(row, now), boardId: row.boardId });
	}
	return row;
}

/** Close an open decision for input: `closed`, `closed_at`; the `closed` event, `decision_closed` and the live event. No mail. */
export function closeDecision(caller: SessionUser | null, at: { decisionId: number }, body: null, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	// Card 2682, D29: a close before the closing time makes a later ruling early; before any row is read.
	if (keyed(opts)) error(403, CLOSE_ACT);
	const { decision } = requireDecision(user, at.decisionId, 'close');

	const now = stamp();
	requireTransition(decision, 'close', now);
	const row = db.update(decisions).set({ status: 'closed', closedAt: now, updatedAt: now }).where(eq(decisions.id, decision.id)).returning().get();
	appendEvent({ decisionId: decision.id, kind: 'closed' }, actorFor(user, sourceOf(opts)));

	if (row.boardId !== null) {
		logActivity({ action: ACTIONS.decisionClosed, ...decisionEntry(row.boardId, `"${row.title}"`, user, opts) });
		emit(row.boardId, 'decision', { decisionId: row.id, status: decisionStatus(row, now), boardId: row.boardId });
	}
	return row;
}

/**
 * Give an open or closed decision a new closing time, `closesAt`, which must
 * be in the future and no more than `CLOSES_WITHIN_DAYS` ahead (400, card
 * 2697 Q25), and later than the decision's current closing time, for every
 * source (400, card 2682 D30): an Extend that brought it earlier would be a
 * close by another name. It is open again, `closed_at` emptied; the
 * `extended { from, to }` event, `decision_extended` and the live event.
 * Through an API key only a decision whose stored status is open is
 * extended (403 otherwise, code review S2): reopening a closed one undoes a
 * person's close, and is done on the decision's page.
 *
 * Card 2744: an Extend that reopens the decision for input (it was closed, or
 * open past its closing time) sends the invitation, asking for their view,
 * to each live consulted participant the current round has not reached
 * (`unaskedOf`, D1), after the commit; one the participant's rest or daily
 * cap, or the caller's cap, holds back is written `mail_skipped { mail:
 * 'invitation', reason }` and the reopening goes ahead all the same
 * (`askUnasked`, D2). An Extend of a decision already open for input mails
 * nobody. A key's Extend that would ask anyone is refused 403
 * (`REOPEN_ASKS_ACT`, D5), after the status and before anything is written;
 * one whom no mail could reach (`reachOf` skips them: left, deleted, address
 * changed) does not count, as they are recorded `mail_skipped` and not
 * mailed (code review 2026-11-05).
 */
export function extendDecision(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'extend');
	// Card 2682, code review S2: a key extends an open decision alone; before the body is read.
	if (keyed(opts) && decision.status === 'closed') error(403, REOPEN_ACT);

	const closesAt = readTimestamp(body, 'closesAt', { required: true, future: true });
	if (closesTooFar(closesAt, stamp())) error(400, CLOSES_TOO_FAR);
	// Card 2682, D30: never earlier, for every source; both are stamps in one format, so the text compares as the time.
	if (decision.closesAt !== null && closesAt <= decision.closesAt) error(400, EXTENDS_EARLIER);

	const now = stamp();
	requireTransition(decision, 'extend', now);
	// Card 2744 (D1, D2): a reopening asks whom the round has not reached, read before the write; D5: never through a key.
	const unasked = openForInput(decisionStatus(decision, now)) ? [] : unaskedOf(decision);
	// Code review 2026-11-05: a key is refused only where a mail would go out; one `reachOf` skips is recorded, not mailed.
	if (keyed(opts) && unasked.length > 0) {
		const reaches = reachesOf(decision.id, unasked);
		if (unasked.some((row) => !('skip' in reaches.get(row.id)!))) error(403, REOPEN_ASKS_ACT);
	}

	const by = actorFor(user, sourceOf(opts));
	const row = db
		.update(decisions)
		.set({ status: 'open', closesAt, closedAt: null, updatedAt: now })
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	appendEvent({ decisionId: decision.id, kind: 'extended', detail: { from: decision.closesAt, to: closesAt } }, by);
	askUnasked(user, row, unasked, by, now);

	if (row.boardId !== null) {
		logActivity({ action: ACTIONS.decisionExtended, ...decisionEntry(row.boardId, `"${row.title}": closes ${closesAt.slice(0, 16)} UTC`, user, opts) });
		emit(row.boardId, 'decision', { decisionId: row.id, status: decisionStatus(row, now), boardId: row.boardId });
	}
	return row;
}

/**
 * Every refusal of `withdrawDecision`, in its order, read only (card 2697,
 * Q10, Q29): the decision looked for and the caller checked (`withdraw`: 401,
 * 404, 403), `reason` (400), and the status (409). Answers whether the
 * decision was ever opened (`openedAt` set: open or closed now), the one
 * thing that decides whether the withdraw route asks for the caller's
 * password: an opened decision's withdrawal is for good and mails every
 * participant the caller's words, while a draft's tells nobody.
 */
export function decisionWithdrawGuard(
	caller: SessionUser | null,
	at: { decisionId: number },
	body: RequestBody
): { user: SessionUser; decision: Decision; reason: string; wasOpened: boolean } {
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'withdraw');

	const reason = readText(body, 'reason', { required: true, trim: true, min: 1, max: 2000 });

	requireTransition(decision, 'withdraw');
	return { user, decision, reason, wasOpened: decision.openedAt !== null };
}

/**
 * Withdraw a draft, an open or a closed decision: `reason` (text, trimmed, 1
 * to 2,000). `withdrawn`, `withdrawn_at` and the reason saved, and the
 * `withdrawn` event. Once it has been opened, its participants are mailed
 * `told_withdrawn` with the reason, and `decision_withdrawn` (never the
 * reason) and the live event are written while its board is there. With no
 * address to make a link on the withdrawal goes ahead, each mail recorded as
 * not sent (decision 17). A draft: nobody was told, so none of those.
 *
 * Every refusal is `decisionWithdrawGuard`'s, asked first; its internal route
 * asks for the caller's password between the two once the decision has been
 * opened (card 2697, Q29). Once opened, the service itself refuses 400
 * `STEP_UP_MISSING` unless it runs inside `whilePasswordHolds` for the
 * caller's own account (`requirePasswordHeld`, card 2726), whatever route
 * calls it; a key is refused before that, as it always was.
 */
export function withdrawDecision(caller: SessionUser | null, at: { decisionId: number }, body: RequestBody, opts: ServiceOptions): Decision {
	inWrite();
	const { user, decision, reason, wasOpened } = decisionWithdrawGuard(caller, at, body);
	// Card 2682, D5: where the page would ask the password, after every refusal the guard makes; no password is read.
	if (wasOpened && keyed(opts)) error(403, OPENED_ACT);
	// Card 2726: the password's proof, asked by the service, not left to the route.
	if (wasOpened) requirePasswordHeld(user.id);

	const now = stamp();
	const by = actorFor(user, sourceOf(opts));
	const row = db
		.update(decisions)
		.set({ status: 'withdrawn', withdrawnAt: now, withdrawnReason: reason, updatedAt: now })
		.where(eq(decisions.id, decision.id))
		.returning()
		.get();
	appendEvent({ decisionId: decision.id, kind: 'withdrawn', detail: { reason } }, by);
	if (decision.status === 'draft') return row;

	queueRecordMails(row, 'withdrawn', { by, reason });
	if (row.boardId !== null) {
		logActivity({ action: ACTIONS.decisionWithdrawn, ...decisionEntry(row.boardId, `"${row.title}"`, user, opts) });
		emit(row.boardId, 'decision', { decisionId: row.id, status: decisionStatus(row, now), boardId: row.boardId });
	}
	return row;
}

/**
 * Every refusal of `deleteDecision`, in its order, read only (card 2697, Q9,
 * Q10): the decision looked for and the caller checked (`delete`: 401, 404,
 * 403) and the status (409). Answers whether the decision holds a record
 * (`openedAt` set: it was opened, and then withdrawn), the one thing that
 * decides whether the delete route asks for the caller's password: the
 * cascade destroys its versions, responses and events for good. A draft never
 * opened holds none.
 */
export function decisionDeleteGuard(caller: SessionUser | null, at: { decisionId: number }): { user: SessionUser; decision: Decision; holdsRecord: boolean } {
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'delete');

	requireTransition(decision, 'delete');
	return { user, decision, holdsRecord: decision.openedAt !== null };
}

/**
 * Delete a draft or a withdrawn decision, and by the cascade every row of it
 * (plan 4.9); any other status is 409 (D7). Once it had been opened,
 * `decision_deleted` and the live event, while its board is there.
 *
 * Every refusal is `decisionDeleteGuard`'s, asked first; its internal route
 * asks for the caller's password between the two where the decision holds a
 * record (card 2697, Q9). Where it holds one, the service itself refuses 400
 * `STEP_UP_MISSING` unless it runs inside `whilePasswordHolds` for the
 * caller's own account (`requirePasswordHeld`, card 2726), as the withdrawal.
 *
 * Card 3033 (D8): `decision deleted` recorded before the delete, while the
 * decision's creation time can be read, as a team's deletion is.
 */
export function deleteDecision(caller: SessionUser | null, at: { decisionId: number }, body: null, opts: ServiceOptions): void {
	inWrite();
	const { user, decision, holdsRecord } = decisionDeleteGuard(caller, at);
	// Card 2682, D5: as the withdrawal.
	if (holdsRecord && keyed(opts)) error(403, OPENED_ACT);
	// Card 2726: as the withdrawal.
	if (holdsRecord) requirePasswordHeld(user.id);

	const now = stamp();
	// Card 2680 (decision 19, S7): each linked card keeps a trace on its own board, written before the delete cascades the
	// links away and before the early return below; "a linked decision was deleted", naming no decision.
	const links = db
		.select({ cardId: decisionCardLinks.cardId, boardId: columns.boardId })
		.from(decisionCardLinks)
		.innerJoin(cards, eq(cards.id, decisionCardLinks.cardId))
		.innerJoin(columns, eq(columns.id, cards.columnId))
		.where(eq(decisionCardLinks.decisionId, decision.id))
		.all();
	for (const link of links) {
		logActivity({ action: ACTIONS.decisionCardLinkDeleted, ...decisionEntry(link.boardId, 'a linked decision was deleted', user, opts, link.cardId) });
	}
	recordAccessChange(sqlite, { kind: ACCESS_KIND.decision, subject: decision.id, access: 'deleted' });
	db.delete(decisions).where(eq(decisions.id, decision.id)).run();

	if (decision.openedAt === null || decision.boardId === null) return;
	logActivity({ action: ACTIONS.decisionDeleted, ...decisionEntry(decision.boardId, `"${decision.title}"`, user, opts) });
	emit(decision.boardId, 'decision', { decisionId: decision.id, status: decisionStatus(decision, now), boardId: decision.boardId });
}

// ─── Inside the writes ───────────────────────────────────────────────────────

/**
 * A 429 once the caller has opened or re-published `PUBLISH_DAILY_CAP`
 * decisions in the last 24 hours (card 2697, Q23), each of which mails every
 * participant: read from their `published` events across decisions, and
 * then, last of all, from an allowance held in memory, which a deletion of
 * the decisions, and their events with them, does not give back. Asked after
 * every other refusal, so a refused publish takes nothing.
 */
function requirePublishAllowed(user: SessionUser, now: Stamp): void {
	const words = (from: Stamp) =>
		`You have opened or re-published ${PUBLISH_DAILY_CAP} decisions in the last 24 hours: the next can be sent from ${from} UTC`;
	const fromEvents = dailyCapFrom(publishesSince(user.id, dayBefore()), PUBLISH_DAILY_CAP);
	// As `mailRestOf` compares (the code review's part B, F7): from that moment on, it may.
	if (fromEvents !== null && now < fromEvents) error(429, words(fromEvents));
	const took = takeAllowance(`decision-publish:${user.id}`, 1, PUBLISH_DAILY_CAP, DAY_MS);
	if (!took.taken) error(429, words(stamp(new Date(Date.now() + took.retryAfterSecs * 1000))));
}

/**
 * Card 2744 (D1, D4): the live consulted participants of `decision` with no
 * response in the current round whom the round has not reached, read from the
 * record alone by `currentResultsOf` (card 2738's `reachedInRound`, the very
 * pair an early ruling writes `cut_off { reached }` from): never sent an
 * asking mail that was delivered while they were consulted and the decision
 * open for input, and never shown the question then. So one included or made
 * consulted while it was closed (cards 2740 and 2743), and one whose
 * invitation was held back, refused or not yet delivered. Read before the
 * write that reopens the decision, or (card 2739) before any re-publish
 * writes its new version, as the round and its windows stand.
 */
function unaskedOf(decision: Decision): DecisionParticipant[] {
	const { notResponded, reached } = currentResultsOf(decision);
	return notResponded.filter((row) => !reached.has(row.id));
}

/**
 * Card 2739's code review (2026-11-05): those of `rows` whose asking mail of
 * the current round (`askingMailsOf`: their latest `invited` or
 * `asked_again`) has no `mail_outcome` yet, so is queued or being sent. A
 * tell-only re-publish mails none of them, yet holds itself to their rest, as
 * it did before card 2739, so that the mail in flight is not overtaken by a
 * new version it does not quote. Read only.
 */
function askingInFlight(decision: Decision, rows: DecisionParticipant[]): DecisionParticipant[] {
	if (rows.length === 0) return [];
	const asking = askingMailsOf(decision.id, currentRound(decision.id), rows.map((row) => row.id));
	return rows.filter((row) => asking.get(row.id)?.delivered === null);
}

/**
 * Card 2744 (D2): send `unasked`, read by `unaskedOf` before an Extend
 * reopened `row`, the invitation, which asks for their view, by the
 * record-mail path after the commit; one their rest or daily cap, or the
 * caller's daily cap, holds back (`heldAsks`, card 2740) is written
 * `mail_skipped { mail: 'invitation', reason }` instead, and the reopening
 * stands. One `reachOf` skips is recorded by `queueRecordMails`.
 */
function askUnasked(user: SessionUser, row: Decision, unasked: DecisionParticipant[], by: RecordActor, now: Stamp): void {
	if (unasked.length === 0) return;
	const held = heldAsks(user, row.id, unasked, 0, now);
	for (const [participantId, reason] of held) {
		appendEvent({ decisionId: row.id, kind: 'mail_skipped', participantId, detail: { mail: 'invitation', reason } }, by);
	}
	const asking = unasked.filter((participant) => !held.has(participant.id));
	if (asking.length > 0) queueRecordMails(row, 'invitation', { by, participants: asking });
}

/** What a version copies of the working content (the code review's C3): these keys, as the content holds them. */
const VERSION_TEXT_KEYS = ['situation', 'question', 'ask', 'unknowns', 'alreadyRuled', 'technicalDetail'] as const;
/** What a version copies of each option's entry, besides the id and label it is given. */
const VERSION_OPTION_KEYS = ['title', 'summary', 'pros', 'cons', 'commercial'] as const;
const VERSION_AUDIENCE_KEYS = ['groupId', 'heading', 'body'] as const;
const VERSION_STORY_KEYS = ['title', 'body'] as const;

/**
 * A version's content: of the working content an allowlist alone (the code
 * review's C3), each key copied only where the content holds it. Its text
 * sections; its audiences and stories, each entry by its own keys; its
 * options those still live, each with its text from the working content and
 * its id and label; its agent flags; and each review stamp as `{ byName, at }`,
 * the record of who reviewed what (R7). Never `lastLabel`, nor a reviewer's
 * account id, nor a key the content may hold that is none of these.
 */
function versionContent(decision: Decision, options: DecisionOption[]): string {
	const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
	let working: Record<string, unknown> = {};
	try {
		const read = JSON.parse(decision.workingContent) as unknown;
		if (isRecord(read)) working = read;
	} catch {
		// Not JSON: the version holds the options alone.
	}
	const pick = (entry: Record<string, unknown>, keys: readonly string[]) =>
		Object.fromEntries(keys.filter((key) => Object.hasOwn(entry, key)).map((key) => [key, entry[key]]));
	const version: Record<string, unknown> = pick(working, VERSION_TEXT_KEYS);
	if (Array.isArray(working.audiences)) version.audiences = working.audiences.filter(isRecord).map((entry) => pick(entry, VERSION_AUDIENCE_KEYS));
	if (Array.isArray(working.stories)) version.stories = working.stories.filter(isRecord).map((entry) => pick(entry, VERSION_STORY_KEYS));
	const written = Array.isArray(working.options) ? working.options.filter(isRecord) : [];
	version.options = options.map((option) => ({
		...pick(written.find((entry) => entry.optionId === option.id) ?? {}, VERSION_OPTION_KEYS),
		optionId: option.id,
		label: option.label
	}));
	if (isRecord(working.agentDrafted)) version.agentDrafted = Object.fromEntries(Object.entries(working.agentDrafted).filter(([, flag]) => flag === true));
	if (isRecord(working.reviewed)) {
		version.reviewed = Object.fromEntries(
			Object.entries(working.reviewed)
				.filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
				.map(([key, stamped]) => [key, { byName: stamped.byName, at: stamped.at }])
		);
	}
	return JSON.stringify(version);
}
