/**
 * decision-participant-writes.ts — a decision's participants set
 * (`setParticipants`), an invitation sent again (`resendInvitation`), and the
 * administrator's changes to a participant's account and address
 * (`setParticipantAccount`, `changeParticipantAddress`) (card 2675, plan
 * section 4.7), with the guards of the last two (`READS`). Card 2713 moved
 * them here from the former decision service, unchanged (D1).
 *
 * Card 2697 limits the mail these writes send: per caller, the record mails
 * caused (its code review's part B, S2), across decisions, in 24 hours; and
 * per participant, the record mails in 24 hours. Its guards (`READS`) make
 * every refusal of the writes whose routes ask for the caller's password, so
 * that none costs a check: the administrator's participant account and
 * address (Q9, Q10).
 *
 * Card 2682 adds the API v1 routes, which call `setParticipants` with
 * `source: 'api'`. A key is refused Resend (D3), as it mails people, a
 * participant's account and address (D6), and the participants of a decision
 * ever opened (D4).
 *
 * Each write has the one shape of a service, and the record, the activity
 * entry, the live event and the mail are written as decision-write-shared.ts's
 * header says.
 */
import { error } from '@sveltejs/kit';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db, sqlite } from './db';
import { decisionParticipants, decisions, users, type Decision, type DecisionParticipant } from './db/schema';
import type { SessionUser } from './auth';
import { isAdmin } from './board-access';
import { mayDo } from './decision-access';
import { participantsOf, withChosenFlag } from './decision-content';
import { accountHistory, actorFor, appendEvent, IDS_AT_ONCE, peopleById, snapshotOf } from './decision-record';
import { addressRefusal, attachRefusal, clearRefusal, CLOSED_ASK_WORDS, REMOVED_WORDS, revokeLinks, SKIP_WORDS } from './decision-links';
import { decisionLinkBase, queueRecordMails } from './decision-mail';
import { DECISION_ACTION_WORDS, decisionStatus, requireTransition } from './decision-status';
import { NO_LINK_ADDRESS } from './email';
import { readChoice, readId, readObjects, readText, type RequestBody } from './request-body';
import { mailedOnSave, openForInput } from '$lib/decision-rules';
import { requireDecision, requireUser } from './route-guards';
import { stamp, type Stamp } from '$lib/timestamps';
import { inWrite, type ServiceOptions } from './write-as';
import {
	heldAsks,
	keyed,
	MAIL_ACT,
	MOST_PARTICIPANTS,
	OPENED_PEOPLE,
	participantOn,
	reachesOf,
	requireMailRested,
	requireRecordMailAllowed,
	requireRevision,
	snapshotColumns,
	sourceOf
} from './decision-write-shared';
import { ACCESS_KIND, recordAccessChange } from './access-changes';

/**
 * The functions here that only read: the guards of the administrator's two
 * participant writes, which their routes ask before the caller's password
 * (card 2697, Q10). Every other export is a write, and starts with
 * `inWrite()`.
 */
export const READS: readonly string[] = ['participantAccountGuard', 'participantAddressGuard'];

/** A participant's part in a decision. */
const ROLES = ['consulted', 'informed'] as const;

/** What an administrator does to a participant's account (decision 14). */
const ACCOUNT_CHANGES = ['person', 'none'] as const;

// ─── What an API key may not do (card 2682, D3 to D6, D29, D30) ──────────────
// Module constants, not exported (D20): a service module exports its functions alone. Those more than one decision service
// shares are decision-write-shared.ts's (card 2713).

/** The 403 for a participant's account or address through an API key (card 2682, D6): both ask the password on the page. */
const STEP_UP_ACT = "Changing a participant's account or address asks for your password on the decision's page. An API key cannot";

/**
 * Set who is consulted on the decision and who is told of it: `participants`,
 * up to 5,000 objects `{ personId, role }`, each person once, each one who is
 * in the directory and has not left (400 naming them otherwise). Answers
 * every participant row of the decision, in order.
 *
 * On a draft the set replaces the rows: a new person gets a row with their
 * snapshots (decision 19), a role is changed, and a row not named is
 * deleted. No event names a participant (comment 5599). Card 2728 (D2):
 * through an API key a save that adds, removes or re-roles anyone is flagged
 * `agentDrafted.participants`, its review stamp removed, until a person
 * marks it reviewed; a person's save keeps the flag (D3). A key reaches no
 * other status (`OPENED_PEOPLE`).
 *
 * Once open, nothing the record can name is deleted (decision 25). A new
 * person is included (`included`), a removed one comes back on the same row
 * (`re_included`), and each is invited, with a link if they have no account;
 * card 2743: but while the decision is not shown open (closed, or past its
 * closing time), one included or brought back as consulted is sent nothing,
 * no link and no `mail_skipped`, as they cannot respond until it is reopened
 * (card 2744: the Extend or the re-publish asking again that reopens it sends
 * them the invitation then, as the caps allow), and one
 * as informed is still sent their invitation, which asks nothing (who is
 * mailed is `$lib/decision-rules.ts`'s `mailedOnSave`, which the picker
 * shares). The 10-minute rest holds only one the write mails; the caller's
 * cap counts every inclusion, mailed now or at the ruling.
 * One left out is marked removed (`removed`) and their link ended. A changed
 * role writes `role_changed`. Card 2740: one made consulted while the
 * decision is shown open (not closed, nor past its closing time) is sent the
 * invitation, which asks for their view, by the normal record-mail path (a
 * fresh link for a link holder); where their rest or daily cap, or the
 * caller's, holds it back (`heldAsks`), the role is changed all the same and
 * `mail_skipped { mail: 'invitation', reason }` written, `resting`,
 * `daily_cap` or `caller_cap`. One made informed is sent nothing, and so is
 * one made consulted on a decision closed or past its closing time, who is
 * asked at the reopening (card 2744). A live
 * row whose person has been deleted is marked removed in the same way, as the body cannot name it, so its account
 * no longer holds the participant role (card 2676, the code review's C1,
 * superseding decision 29's "left as it is"). Including anyone is refused, 409, with
 * no address to make a link on (decision 28), and re-including a
 * participant this write would mail who was mailed in the last 10 minutes
 * (decision 31); and 429 where including them would take the caller past
 * their record mail limit (the code review's part B, S2; card 2743's code
 * review: every inclusion, as each is mailed at the ruling if not now).
 *
 * 409, naming the person, for a row that would hold the same account as
 * another live row of the decision (decision 29).
 *
 * Card 2676: on a decision that is not a draft, including people is the
 * author's and the decider's alone (`include`, R3), 403 for anyone else.
 * `revision` is required, and a different one is a 409 (decision 10). A
 * caller who is not an administrator, naming someone who has left or an id
 * that is no person, is told only that the id cannot be included, as their
 * picker holds neither (R6); a participant of this decision who has since
 * left is named to every editor, as their name is already on it (D6).
 *
 * Card 3033 (D4, D5): each change of a place is recorded in the record of
 * access changes, in the write's transaction: a place deleted from a draft as
 * `removed` (before the delete, while the place can be read), one removed,
 * re-roled, brought back or added as its role after the write, and the
 * account a place brought back or added holds as `held`. R10: on a draft only
 * the live places are read, so a place a restore or the start marked removed
 * is neither kept nor deleted, and a person whose only place is removed is
 * given a new one.
 */
export function setParticipants(
	caller: SessionUser | null,
	at: { decisionId: number },
	body: RequestBody,
	opts: ServiceOptions
): DecisionParticipant[] {
	inWrite();
	const user = requireUser(caller);
	const { decision, access } = requireDecision(user, at.decisionId, 'edit');
	if (decision.status !== 'draft' && !mayDo(access, 'include', decision)) error(403, `You cannot ${DECISION_ACTION_WORDS.include.verb} this decision`);
	// Card 2682, D4: once ever opened, saving the set mails whoever it includes; before the body is read.
	if (decision.openedAt !== null && keyed(opts)) error(403, OPENED_PEOPLE);

	const entries = readObjects(body, 'participants', { required: true, max: MOST_PARTICIPANTS });
	const wanted = entries.map((entry) => ({
		personId: readId(entry, 'personId', { required: true }),
		role: readChoice(entry, 'role', { required: true, from: ROLES })
	}));
	const revision = readText(body, 'revision', { required: true });
	const seen = new Set<number>();
	for (const { personId } of wanted) {
		if (seen.has(personId)) error(400, `personId ${personId} is named twice`);
		seen.add(personId);
	}
	const persons = peopleById([...seen]);
	const rows = participantsOf(decision.id, { live: decision.status === 'draft' });
	const admin = isAdmin(user);
	for (const { personId } of wanted) {
		const person = persons.get(personId);
		if (!person) error(400, admin ? `personId ${personId} is not a person` : `personId ${personId} cannot be included`);
		if (person.status !== 'active') {
			const own = rows.find((row) => row.personId === personId);
			if (own) error(400, `participants: ${own.name} has left: remove before saving`);
			error(400, admin ? `${person.fullName} (person ${personId}) has left, and cannot be included` : `personId ${personId} cannot be included`);
		}
	}

	requireTransition(decision, 'edit');
	requireRevision(decision, revision);
	const by = actorFor(user, sourceOf(opts));
	const now = stamp();

	if (decision.status === 'draft') {
		const named = new Map(wanted.map((w) => [w.personId, w.role]));
		const kept = rows.filter((row) => row.personId !== null && named.has(row.personId));
		const held = new Set(kept.map((row) => row.personId));
		const inserts = wanted.filter((w) => !held.has(w.personId)).map((w) => ({ ...w, snapshot: snapshotOf(w.personId)! }));
		requireOneRowPerAccount(
			inserts.map((i) => ({ name: i.snapshot.name, userId: i.snapshot.userId })),
			kept.map((row) => row.userId)
		);

		const gone = rows.filter((row) => row.personId === null || !named.has(row.personId)).map((row) => row.id);
		// Card 3033 (D4): recorded before the delete, as the record reads the place it names.
		for (const id of gone) recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionParticipant, subject: decision.id, holder: id, access: 'removed' });
		for (let from = 0; from < gone.length; from += IDS_AT_ONCE) {
			db.delete(decisionParticipants).where(inArray(decisionParticipants.id, gone.slice(from, from + IDS_AT_ONCE))).run();
		}
		const reRoled = kept.filter((row) => named.get(row.personId!) !== row.role);
		for (const row of reRoled) {
			db.update(decisionParticipants).set({ role: named.get(row.personId!)! }).where(eq(decisionParticipants.id, row.id)).run();
			recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionParticipant, subject: decision.id, holder: row.id, access: named.get(row.personId!)! });
		}
		for (const insert of inserts) {
			const row = db
				.insert(decisionParticipants)
				.values({ decisionId: decision.id, personId: insert.personId, role: insert.role, ...snapshotColumns(insert.snapshot), includedAt: now, includedBy: user.id, includedByName: user.username })
				.returning({ id: decisionParticipants.id, userId: decisionParticipants.userId })
				.get();
			recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionParticipant, subject: decision.id, holder: row.id, access: insert.role });
			if (row.userId !== null) recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionAccount, subject: row.id, holder: row.userId, access: 'held' });
		}
		// Card 2728 (D2): a key's save that adds, removes or re-roles anyone is the key's choice of who is mailed at Open.
		const changed = gone.length > 0 || reRoled.length > 0 || inserts.length > 0;
		if (keyed(opts) && changed) {
			db.update(decisions)
				.set({ workingContent: withChosenFlag(decision.workingContent, 'participants'), updatedAt: now })
				.where(eq(decisions.id, decision.id))
				.run();
		} else {
			touch(decision.id, now);
		}
		return participantsOf(decision.id);
	}

	// Open or closed: rows are added, brought back, re-roled and marked removed, never deleted.
	const live = new Map<number, DecisionParticipant>();
	const removed = new Map<number, DecisionParticipant>();
	for (const row of rows) {
		if (row.personId === null) continue;
		if (row.removedAt === null) live.set(row.personId, row);
		else removed.set(row.personId, row); // The latest, as rows are read in order.
	}
	const named = new Set(wanted.map((w) => w.personId));
	const additions = wanted.filter((w) => !live.has(w.personId) && !removed.has(w.personId)).map((w) => ({ ...w, snapshot: snapshotOf(w.personId)! }));
	const returns = wanted.filter((w) => !live.has(w.personId) && removed.has(w.personId)).map((w) => ({ ...w, row: removed.get(w.personId)! }));
	const roleChanges = wanted.filter((w) => live.has(w.personId) && live.get(w.personId)!.role !== w.role).map((w) => ({ ...w, row: live.get(w.personId)! }));
	// The code review's C1: a live row whose person has been deleted cannot be named by any body, so it is removed like one left out.
	const removals = rows.filter((row) => row.removedAt === null && (row.personId === null || !named.has(row.personId)));

	// Who this save mails now: `$lib/decision-rules.ts`'s `mailedOnSave`, which the participant picker counts by too, read at the
	// shown status (open for input: stored open and not past its closing time; cards 2740 and 2743, and card 2744 at a reopening).
	// Card 2743 (D1, D2): while it is not open for input, one included or brought back as consulted is sent nothing, as they cannot
	// respond; one as informed is still sent their invitation, which asks nothing.
	const shown = decisionStatus(decision, now);
	const mailedNow = (role: string) => mailedOnSave('included', role, shown);
	const inclusions = additions.length + returns.length;

	if (inclusions > 0) {
		// Decision 28 for every inclusion (card 2743, D3): one not mailed now is mailed later, and a link holder needs the address.
		if (decisionLinkBase() === null) error(409, NO_LINK_ADDRESS);
		// Card 2743 (D3): the 10-minute rest and the participant's daily cap are about mail to that participant, so only one this write
		// mails is held by them.
		requireMailRested(
			returns.filter((r) => mailedNow(r.role)).map((r) => r.row),
			now
		);
		const staying = rows.filter((row) => row.removedAt === null && !removals.includes(row));
		requireOneRowPerAccount(
			[...additions.map((a) => ({ name: a.snapshot.name, userId: a.snapshot.userId })), ...returns.map((r) => ({ name: r.row.name, userId: r.row.userId }))],
			staying.map((row) => row.userId)
		);
		// The code review's part B (S2): each one included or brought back is invited by the caller, now or later. Card 2743 (D3, its
		// code review): every inclusion counts, mailed now or not, as for decision 28. One not mailed now is mailed at the ruling or
		// the withdrawal, which mail every live participant with no cap of their own, so an inclusion that took nothing here would let
		// a caller close a decision, include thousands for free and have the ruling mail them all.
		requireRecordMailAllowed(user, inclusions, now);
	}
	// Card 2740 (D1, D4): one made consulted while the decision is open for input is asked for their view, by the invitation, now;
	// a rest or a cap holds that mail back (D3), never the role change. Asked last, so that a refused write takes no allowance.
	const asking = roleChanges.filter((change) => mailedOnSave('role_changed', change.role, shown)).map((change) => change.row);
	const held = heldAsks(user, decision.id, asking, inclusions, now);

	for (const row of removals) {
		db.update(decisionParticipants).set({ removedAt: now, removedBy: user.id }).where(eq(decisionParticipants.id, row.id)).run();
		recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionParticipant, subject: decision.id, holder: row.id, access: 'removed' });
		appendEvent({ decisionId: decision.id, kind: 'removed', participantId: row.id }, by);
		revokeLinks({ participantId: row.id }, 'removed', by);
	}
	for (const change of roleChanges) {
		db.update(decisionParticipants).set({ role: change.role }).where(eq(decisionParticipants.id, change.row.id)).run();
		recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionParticipant, subject: decision.id, holder: change.row.id, access: change.role });
		appendEvent({ decisionId: decision.id, kind: 'role_changed', participantId: change.row.id, detail: { from: change.row.role, to: change.role } }, by);
		const hold = held.get(change.row.id);
		if (hold !== undefined) appendEvent({ decisionId: decision.id, kind: 'mail_skipped', participantId: change.row.id, detail: { mail: 'invitation', reason: hold } }, by);
	}
	const invited: number[] = asking.filter((row) => !held.has(row.id)).map((row) => row.id);
	const history = returns.length > 0 ? accountHistory(decision.id) : new Map<number, boolean>();
	for (const back of returns) {
		db.update(decisionParticipants).set({ role: back.role, removedAt: null, removedBy: null }).where(eq(decisionParticipants.id, back.row.id)).run();
		// Card 3033 (D5): the place's role and the account it comes back with, so that a later restore keeps both (R6).
		recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionParticipant, subject: decision.id, holder: back.row.id, access: back.role });
		if (back.row.userId !== null) recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionAccount, subject: back.row.id, holder: back.row.userId, access: 'held' });
		// Once a row held an account on this decision it is never read as one that did not: bringing it back cannot undo R1.
		const hadAccount = back.row.userId !== null || history.get(back.row.id) === true;
		appendEvent({ decisionId: decision.id, kind: 're_included', participantId: back.row.id, detail: { role: back.role, hadAccount } }, by);
		if (mailedNow(back.role)) invited.push(back.row.id);
	}
	for (const addition of additions) {
		const row = db
			.insert(decisionParticipants)
			.values({
				decisionId: decision.id,
				personId: addition.personId,
				role: addition.role,
				...snapshotColumns(addition.snapshot),
				includedAt: now,
				includedBy: user.id,
				includedByName: user.username
			})
			.returning()
			.get();
		recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionParticipant, subject: decision.id, holder: row.id, access: addition.role });
		if (row.userId !== null) recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionAccount, subject: row.id, holder: row.userId, access: 'held' });
		appendEvent({ decisionId: decision.id, kind: 'included', participantId: row.id, detail: { role: addition.role, hadAccount: row.userId !== null } }, by);
		if (mailedNow(addition.role)) invited.push(row.id);
	}
	const after = touch(decision.id, now);
	if (invited.length > 0) {
		queueRecordMails(after, 'invitation', { by, participants: participantsOf(decision.id).filter((row) => invited.includes(row.id)) });
	}
	return participantsOf(decision.id);
}

/**
 * Send a participant their invitation again, to their snapshot address: a
 * link holder with a new link, replacing the last, and an account holder
 * with the decision's page. Writes `invited { resend: true }`. 404 for a
 * participant not on this decision. 409 for one removed; for one consulted
 * while the decision is not shown open (card 2743, D4: it would ask a view
 * they cannot give); for each reason
 * `reachOf` skips one, in its words (decision 16); with no address to make a
 * link on (decision 28); and for one mailed in the last 10 minutes
 * (decision 31). 429 past the caller's record mail limit (the code review's
 * part B, S2).
 */
export function resendInvitation(
	caller: SessionUser | null,
	at: { decisionId: number; participantId: number },
	body: null,
	opts: ServiceOptions
): DecisionParticipant {
	inWrite();
	const user = requireUser(caller);
	if (keyed(opts)) error(403, MAIL_ACT);
	const { decision } = requireDecision(user, at.decisionId, 'resend');
	const participant = participantOn(decision.id, at.participantId);

	const now = stamp();
	requireTransition(decision, 'resend', now);
	if (participant.removedAt !== null) error(409, REMOVED_WORDS(participant.name));
	// Card 2743 (D4): a consulted participant's invitation asks for their view, which cannot be given while it is not shown open.
	if (participant.role === 'consulted' && !openForInput(decisionStatus(decision, now))) error(409, CLOSED_ASK_WORDS(participant.name));
	const reach = reachesOf(decision.id, [participant]).get(participant.id)!;
	if ('skip' in reach) error(409, SKIP_WORDS[reach.skip](participant.name));
	if (decisionLinkBase() === null) error(409, NO_LINK_ADDRESS);
	requireMailRested([participant], now);
	requireRecordMailAllowed(user, 1, now);

	const after = touch(decision.id, now);
	queueRecordMails(after, 'invitation', { by: actorFor(user, sourceOf(opts)), participants: [participant], resend: true });
	return participantOn(decision.id, participant.id);
}

/**
 * Every refusal of `setParticipantAccount`, in its order, read only (card
 * 2697, Q10): the decision looked for and the caller checked
 * (`participantAccount`: an administrator; 401, 404, 403), the participant on
 * it (404), `account` (400), the status (409), and then, for `person`, a
 * person who is gone or has no account, whose account the row already holds
 * (its code review's part B, F2), or whose account another live row holds
 * (409), and for `none`, a row that holds no account and is not read as
 * having held one (409). The account route asks it before the password, so
 * that none of these costs a check; the write asks it first, so the rules
 * are one. Answers what the write needs: the account to copy for `person`.
 */
export function participantAccountGuard(
	caller: SessionUser | null,
	at: { decisionId: number; participantId: number },
	body: RequestBody
): { user: SessionUser; decision: Decision; participant: DecisionParticipant; change: { account: 'person'; accountId: number } | { account: 'none' } } {
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'participantAccount');
	const participant = participantOn(decision.id, at.participantId);

	const account = readChoice(body, 'account', { required: true, from: ACCOUNT_CHANGES });

	requireTransition(decision, 'participantAccount');
	// The rules are decision-links.ts's, which the delivery panel's offers ask too (the code review's part B, F2).
	if (account === 'person') {
		const person = participant.personId === null ? undefined : peopleById([participant.personId]).get(participant.personId);
		const attach = attachRefusal(participant, person, participantsOf(decision.id));
		if ('refusal' in attach) error(409, attach.refusal);
		return { user, decision, participant, change: { account, accountId: attach.accountId } };
	}
	const cleared = clearRefusal(participant, accountHistory(decision.id).get(participant.id) ?? false);
	if (cleared !== null) error(409, cleared);
	return { user, decision, participant, change: { account } };
}

/**
 * An administrator's change to the account a participant is reached by
 * (decision 14): `account`, `person` or `none`. Every refusal is
 * `participantAccountGuard`'s, asked first; its internal route asks for the
 * caller's password between the two (card 2697, Q9).
 *
 * `person` copies the person's account onto the row, ends their link, and
 * writes `account_attached { userId }`. 409 for a person who is gone or has
 * no account, or whose account another live row of the decision holds
 * (decision 29).
 *
 * `none` empties the row's account and writes `account_cleared { userId }`,
 * after which the row is read as never having held one (decision 16). 409
 * when the row holds none and is not read as having held one: there is
 * nothing to clear.
 *
 * Card 3033 (D6): recorded after the write, per place (R5): attached, `held`
 * for the account and `none` for the one the place held before; cleared,
 * `none` for the account it held.
 */
export function setParticipantAccount(
	caller: SessionUser | null,
	at: { decisionId: number; participantId: number },
	body: RequestBody,
	opts: ServiceOptions
): DecisionParticipant {
	inWrite();
	requireUser(caller);
	// Card 2682, D6: the page asks the password for it; before any row is read.
	if (keyed(opts)) error(403, STEP_UP_ACT);
	const { user, decision, participant, change } = participantAccountGuard(caller, at, body);

	const by = actorFor(user, sourceOf(opts));
	const now = stamp();
	if (change.account === 'person') {
		db.update(decisionParticipants).set({ userId: change.accountId }).where(eq(decisionParticipants.id, participant.id)).run();
		recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionAccount, subject: participant.id, holder: change.accountId, access: 'held' });
		if (participant.userId !== null && participant.userId !== change.accountId) {
			recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionAccount, subject: participant.id, holder: participant.userId, access: 'none' });
		}
		revokeLinks({ participantId: participant.id }, 'account_attached', by);
		appendEvent({ decisionId: decision.id, kind: 'account_attached', participantId: participant.id, detail: { userId: change.accountId } }, by);
	} else {
		db.update(decisionParticipants).set({ userId: null }).where(eq(decisionParticipants.id, participant.id)).run();
		if (participant.userId !== null) recordAccessChange(sqlite, { kind: ACCESS_KIND.decisionAccount, subject: participant.id, holder: participant.userId, access: 'none' });
		appendEvent({ decisionId: decision.id, kind: 'account_cleared', participantId: participant.id, detail: { userId: participant.userId } }, by);
	}
	touch(decision.id, now);
	return participantOn(decision.id, participant.id);
}

/**
 * Every refusal of `changeParticipantAddress`, in its order, read only (card
 * 2697, Q10, Q22): the decision looked for and the caller checked
 * (`participantAddress`: an administrator; 401, 404, 403), the participant on
 * it (404), the status (409), and then three 409s, each in plain words: the
 * person is no longer in the people directory, has left, or the row already
 * holds the address the directory holds. It reads no body: the address is
 * the directory's, never one sent. The address route asks it before the
 * password; the write asks it first. Answers the address to copy.
 */
export function participantAddressGuard(
	caller: SessionUser | null,
	at: { decisionId: number; participantId: number }
): { user: SessionUser; decision: Decision; participant: DecisionParticipant; email: string } {
	const user = requireUser(caller);
	const { decision } = requireDecision(user, at.decisionId, 'participantAddress');
	const participant = participantOn(decision.id, at.participantId);

	requireTransition(decision, 'participantAddress');
	const person = participant.personId === null ? undefined : peopleById([participant.personId]).get(participant.personId);
	const address = addressRefusal(participant, person);
	if ('refusal' in address) error(409, address.refusal);
	return { user, decision, participant, email: address.email };
}

/**
 * An administrator's "Use the directory's address" (card 2697, Q22; decision
 * 15, S7): the participant's address on the decision becomes the one the
 * people directory holds for their person now, as attaching an account copies
 * the person's account. No address is sent: one the directory does not hold
 * would make `reachOf` skip the participant for good. Ends their link and
 * writes `address_changed { from, to }`; sends nothing, as a re-send is an act
 * of its own. Every refusal is `participantAddressGuard`'s, asked first; its
 * internal route asks for the caller's password between the two (Q9).
 */
export function changeParticipantAddress(
	caller: SessionUser | null,
	at: { decisionId: number; participantId: number },
	body: null,
	opts: ServiceOptions
): DecisionParticipant {
	inWrite();
	requireUser(caller);
	if (keyed(opts)) error(403, STEP_UP_ACT);
	const { user, decision, participant, email } = participantAddressGuard(caller, at);

	const by = actorFor(user, sourceOf(opts));
	db.update(decisionParticipants).set({ email }).where(eq(decisionParticipants.id, participant.id)).run();
	revokeLinks({ participantId: participant.id }, 'participant_address', by);
	appendEvent({ decisionId: decision.id, kind: 'address_changed', participantId: participant.id, detail: { from: participant.email, to: email } }, by);
	touch(decision.id, stamp());
	return participantOn(decision.id, participant.id);
}

// ─── Inside the writes ───────────────────────────────────────────────────────
// Those more than one decision service shares are decision-write-shared.ts's (card 2713, D2).

/** Stamp the decision's `updated_at`, and answer the row as it now is. */
function touch(decisionId: number, now: Stamp): Decision {
	return db.update(decisions).set({ updatedAt: now }).where(eq(decisions.id, decisionId)).returning().get();
}

/**
 * A 409, naming the person, when a row coming onto the decision would hold an
 * account another live row holds, or that another one coming on holds
 * (decision 29). `staying` is the accounts of the live rows that stay.
 *
 * And when a row coming on, an addition or a return, would hold an account
 * that is disabled (card 2671, S2): it could neither be reached nor answer.
 * The disabled ones among them are read in one query.
 */
function requireOneRowPerAccount(coming: { name: string; userId: number | null }[], staying: (number | null)[]): void {
	const held = new Set(staying.filter((id): id is number => id !== null));
	const accounts = coming.map((row) => row.userId).filter((id): id is number => id !== null);
	const disabled = new Set(
		accounts.length === 0
			? []
			: db
					.select({ id: users.id })
					.from(users)
					.where(and(inArray(users.id, accounts), isNotNull(users.disabledAt)))
					.all()
					.map((row) => row.id)
	);
	for (const row of coming) {
		if (row.userId === null) continue;
		if (disabled.has(row.userId)) error(409, `${row.name} cannot be included: their account is disabled`);
		if (held.has(row.userId)) error(409, `${row.name} cannot be included: another participant of this decision holds the same account`);
		held.add(row.userId);
	}
}
