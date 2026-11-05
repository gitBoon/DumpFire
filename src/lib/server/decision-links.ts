/**
 * decision-links.ts — the personal links that let a participant with no
 * account see a decision and answer it (card 2675, plan section 4.5 and
 * decisions 9 to 12 and 16).
 *
 * A link is `/decision-link/<token>`, the token 32 random bytes in base64url.
 * Only its SHA-256, in hex, is stored (`link_token_hash`, unique), with
 * `link_issued_at`: the token itself is handed back once, by `issueLink`, to
 * be put in the mail, and is never stored, logged, put in a subject, or
 * written to an event or to activity. So a later mail cannot carry the link
 * an earlier one did: every record-bearing mail to a link holder carries a
 * fresh one, which replaces the last (decision 10).
 *
 * Who is mailed at all, and who may hold a link, is one rule, `reachOf`
 * (decision 16): every mail, every re-send and every link asks it. Whether a
 * link holder still holds a link a mail with none may point them to is
 * `mailedLinkOf` (card 2721), which `reachOf` does not ask.
 *
 * A link ends when `revokeLinks` empties it, with a `link_revoked` event
 * giving the reason (decision 12), and it lapses 90 days after the moment
 * that bounds it, worked out when it is read (`linkUsable`, decision 11).
 * `participantForLink` is the one place a link is checked. The path is masked
 * in the system log by `SECRET_IN_PATH` in secret-paths.ts.
 *
 * Plain functions with no caller, called inside a write's transaction.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from './db';
import { decisionParticipants, decisions, people, type Decision, type DecisionParticipant, type Person } from './db/schema';
import { accountHistory, appendEvent, deliveryOf, type RecordActor } from './decision-record';
import { linkUsable } from './decision-status';
import { stamp, type Stamp } from '$lib/timestamps';

/** Why a link was ended (decision 12). */
export type RevokeReason =
	| 'removed'
	| 'left'
	| 'linked'
	| 'unlinked'
	| 'address_changed'
	| 'person_deleted'
	| 'account_attached'
	| 'participant_address'
	| 'restore';

/** Why a participant was not mailed (decision 16), the first that applies in this order. */
export type SkipReason = 'deleted' | 'left' | 'account_not_attached' | 'account_removed' | 'address_changed';

/** How a participant is reached: through their account, through a link, or not, with why. */
export type Reach = { via: 'account' } | { via: 'link' } | { skip: SkipReason };

/**
 * Why a participant cannot be mailed, in words, for each reason `reachOf`
 * skips them (card 2675, decision 16): the 409 of a re-send, and the words
 * the editor's delivery panel shows (card 2697, F3: moved here from the
 * former decision service (card 2713), unchanged, as a service exports its
 * reads and writes alone).
 */
export const SKIP_WORDS: Readonly<Record<SkipReason, (name: string) => string>> = {
	deleted: (name) => `${name} is no longer in the people directory: they cannot be mailed about this decision`,
	left: (name) => `${name} has left: they cannot be mailed about this decision`,
	account_not_attached: (name) =>
		`${name}'s account on this decision is not the one the people directory holds for them: an administrator attaches it before they can be mailed`,
	account_removed: (name) =>
		`${name}'s account on this decision has been deleted: an administrator clears it before they can be mailed a personal link`,
	address_changed: (name) =>
		`${name}'s address on this decision is not the one the people directory holds for them: an administrator changes it before they can be mailed`
};

/** Why a removed participant cannot be sent their invitation again: the 409 of a re-send, and the delivery panel's words (card 2697, Q13). */
export const REMOVED_WORDS = (name: string) => `${name} has been removed from this decision: they cannot be mailed about it`;

/**
 * Why a consulted participant cannot be sent their invitation again while the
 * decision is not shown open (card 2743, D4): it asks for a view they cannot
 * give. The 409 of a re-send, and the delivery panel's words.
 */
export const CLOSED_ASK_WORDS = (name: string) => `This decision is awaiting a ruling: ${name} is consulted, and cannot be asked for their view until it is reopened`;

/** Why a participant's personal link was ended, in words, for the editor's delivery panel (card 2697, Q13). */
export const REVOKE_WORDS: Readonly<Record<RevokeReason, string>> = {
	removed: 'Their link was ended when they were removed from this decision',
	left: 'Their link was ended when they were marked as having left',
	linked: 'Their link was ended when an account was linked to them in the people directory',
	unlinked: 'Their link was ended when their account was unlinked from them in the people directory',
	address_changed: 'Their link was ended when their address was changed in the people directory',
	person_deleted: 'Their link was ended when they were deleted from the people directory',
	account_attached: 'Their link was ended when an administrator attached their account on this decision',
	participant_address: 'Their link was ended when an administrator changed their address on this decision',
	restore: 'Their link was ended by a restore from a backup: Resend sends them a new one'
};

/**
 * The stored form of a token: its SHA-256, in hex, as an API key's is kept.
 * The mail effect asks it too, to see that a link it is about to send is
 * still the one the row holds (the code review's F2).
 */
export function hashOf(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/**
 * Whether the participant may hold a link (S6, decision 9): not removed; no
 * account on the row, now or ever on this decision (`hadAccount`); and a
 * person who exists and has no account now.
 */
export function mayHoldLink(p: DecisionParticipant, person: Person | null, hadAccount: boolean): boolean {
	return p.removedAt === null && p.userId === null && !hadAccount && person !== null && person.userId === null;
}

/**
 * How a participant who is not removed is reached by a record-bearing mail
 * (decision 16, R1, R2, R7). Their person must exist and be active, and the
 * snapshot address must be the person's address now, on either route (the
 * code review's S2: the mail goes to the snapshot address). Then either the
 * row's account is the person's account still (`account`, the mail links to
 * the page behind a sign-in), or `mayHoldLink` passes (`link`). Anyone else
 * is skipped, with the first reason that applies.
 */
export function reachOf(p: DecisionParticipant, person: Person | null, hadAccount: boolean): Reach {
	if (person === null) return { skip: 'deleted' };
	if (person.status !== 'active') return { skip: 'left' };
	if (p.userId !== null) {
		if (person.userId !== p.userId) return { skip: 'account_not_attached' };
		return p.email === person.email ? { via: 'account' } : { skip: 'address_changed' };
	}
	if (person.userId !== null) return { skip: 'account_not_attached' };
	if (hadAccount) return { skip: 'account_removed' };
	if (p.email !== person.email) return { skip: 'address_changed' };
	return { via: 'link' }; // mayHoldLink holds here
}

/**
 * The live link a link holder holds, and the record mail that carried it, or
 * null where they may hold no working link (card 2685, S1; card 2721, D2):
 * the row holds a hash, the decision's links are usable at `at`
 * (`linkUsable`), and their latest record mail, which issued that hash (only
 * a record mail calls `issueLink`), has `mail_outcome { delivered: true }`.
 * An outcome not yet written is not delivered: fail closed. `reachOf` reads
 * no hash, so a mail that tells a link holder to use the link in their latest
 * email asks this first: the closing-date reminder (`standsAt`) and the
 * answer notice (`answerNoticeOf`) alike. A read alone: it issues and revokes
 * nothing.
 */
export function mailedLinkOf(
	decision: Pick<Decision, 'id' | 'status' | 'ruledAt' | 'withdrawnAt' | 'closesAt'>,
	p: DecisionParticipant,
	at: Stamp
): { linkHash: string; lastMailEventId: number } | null {
	if (p.linkTokenHash === null || !linkUsable(decision, at)) return null;
	const last = deliveryOf(decision.id).get(p.id)?.lastMail ?? null;
	if (last === null || last.outcome?.delivered !== true) return null;
	return { linkHash: p.linkTokenHash, lastMailEventId: last.eventId };
}

// ─── The administrator's account and address changes (card 2697, Q10, Q22) ───
//
// One rule each, which the write's guard in decision-participant-writes.ts asks, refusing with
// the words, and the edit page's delivery panel asks too, offering the action
// only where it is null (the code review's part B, F2), as `mailRestOf` serves
// Resend: so the panel cannot offer what the write refuses, nor hide what it
// allows.

/**
 * Why Attach account cannot be done for the participant now, in the 409's
 * words, or the account it would copy: their person is no longer in the
 * directory or has no account, the row already holds that account, or
 * another live row of the decision (`rows`) holds it (decision 29).
 */
export function attachRefusal(participant: DecisionParticipant, person: Person | undefined, rows: readonly DecisionParticipant[]): { refusal: string } | { accountId: number } {
	if (!person) return { refusal: `${participant.name} is no longer in the people directory: there is no account to attach` };
	if (person.userId === null) return { refusal: `${person.fullName} has no account in the people directory: there is no account to attach` };
	const accountId = person.userId;
	// The code review's part B (F2): as the address's rule refuses a copy that changes nothing.
	if (participant.userId === accountId) {
		return { refusal: `${participant.name} already holds the account the people directory holds for them on this decision: there is nothing to attach` };
	}
	if (rows.some((row) => row.id !== participant.id && row.removedAt === null && row.userId === accountId)) {
		return { refusal: `${person.fullName} cannot be given that account: another participant of this decision holds it` };
	}
	return { accountId };
}

/**
 * Why Clear account cannot be done for the participant now, in the 409's
 * words, or null: a row that holds no account and is not read as having held
 * one (`hadAccount`, decision 16) has nothing to clear. A row whose account
 * was deleted holds none and had one, and is cleared so that a link may reach
 * it (`account_removed`).
 */
export function clearRefusal(participant: DecisionParticipant, hadAccount: boolean): string | null {
	return participant.userId === null && !hadAccount ? `${participant.name} holds no account on this decision: there is nothing to clear` : null;
}

/**
 * Why Use the directory's address cannot be done for the participant now, in
 * the 409's words, or the address it would copy, lower-cased: their person is
 * no longer in the directory, has left, or the row already holds that
 * address.
 */
export function addressRefusal(participant: DecisionParticipant, person: Person | undefined): { refusal: string } | { email: string } {
	if (!person) return { refusal: `${participant.name} is no longer in the people directory: there is no address to use` };
	if (person.status !== 'active') return { refusal: `${person.fullName} has left: their address in the people directory is not used` };
	const email = person.email.toLowerCase();
	if (email === participant.email.toLowerCase()) {
		return { refusal: `${participant.name}'s address on this decision is already the one the people directory holds: there is nothing to change` };
	}
	return { email };
}

/**
 * Give the participant a new link, replacing any they held, write
 * `link_issued { replaced }`, and answer the token: the only time it exists
 * outside the mail it is put in. A participant `reachOf` would not reach by
 * link is a fault, a plain `Error`: a caller that skipped the rule.
 *
 * `known` is what the caller has already read for `reachOf`: the person, as
 * read in the same transaction, and `hadAccount` from `accountHistory`. It is
 * handed in, not read again, so that a mail to N link holders reads the
 * decision's history once and not N + 1 times (the code review's F1). The
 * participant row itself is read again here, by its key.
 */
export function issueLink(
	participantId: number,
	by: RecordActor,
	replaced: boolean,
	known: { person: Person | null; hadAccount: boolean }
): string {
	const participant = db.select().from(decisionParticipants).where(eq(decisionParticipants.id, participantId)).get();
	if (!participant) throw new Error(`Participant ${participantId} is not there: no link was issued`);
	const { person, hadAccount } = known;
	if (person !== null && person.id !== participant.personId) {
		throw new Error(`Participant ${participantId} is not person ${person.id}'s: no link was issued`);
	}
	const reach = reachOf(participant, person, hadAccount);
	// mayHoldLink adds what reachOf is not asked: that the row is not removed.
	if (!('via' in reach) || reach.via !== 'link' || !mayHoldLink(participant, person, hadAccount)) {
		throw new Error(`Participant ${participantId} of decision ${participant.decisionId} may not hold a personal link: no link was issued`);
	}

	const token = randomBytes(32).toString('base64url');
	db.update(decisionParticipants)
		.set({ linkTokenHash: hashOf(token), linkIssuedAt: stamp() })
		.where(eq(decisionParticipants.id, participant.id))
		.run();
	appendEvent({ decisionId: participant.decisionId, kind: 'link_issued', participantId: participant.id, detail: { replaced } }, by);
	return token;
}

/**
 * End every link held by the person's participant rows, or by the one
 * participant: empty `link_token_hash` and `link_issued_at`, and write
 * `link_revoked { reason }` for each row emptied. A row with no link is left
 * as it is and is not counted. Answers the ids emptied, in order.
 */
export function revokeLinks(where: { personId: number } | { participantId: number }, reason: RevokeReason, by: RecordActor): number[] {
	const which = 'personId' in where ? eq(decisionParticipants.personId, where.personId) : eq(decisionParticipants.id, where.participantId);
	const rows = db
		.update(decisionParticipants)
		.set({ linkTokenHash: null, linkIssuedAt: null })
		.where(and(which, isNotNull(decisionParticipants.linkTokenHash)))
		.returning({ id: decisionParticipants.id, decisionId: decisionParticipants.decisionId })
		.all()
		.sort((a, b) => a.id - b.id);
	for (const row of rows) {
		appendEvent({ decisionId: row.decisionId, kind: 'link_revoked', participantId: row.id, detail: { reason } }, by);
	}
	return rows.map((row) => row.id);
}

/**
 * The participant and decision a link is for, or why it is refused: the one
 * place a link is checked (plan 4.5). The token is compared only as its hash,
 * through the unique index. `unknown` for a token no live row holds, a
 * removed participant's included (their link was emptied when they were
 * removed); `expired` once `linkUsable` says the decision's link has lapsed.
 * And `unknown` for a holder `reachOf` would no longer reach by link, asked
 * again at use (the code review's S3): a person left, deleted, given an
 * account or a new address by a path that did not end the link.
 */
export function participantForLink(
	token: string,
	now: Stamp = stamp()
): { participant: DecisionParticipant; decision: Decision } | { refused: 'unknown' | 'expired' } {
	if (typeof token !== 'string' || token === '') return { refused: 'unknown' };
	const participant = db.select().from(decisionParticipants).where(eq(decisionParticipants.linkTokenHash, hashOf(token))).get();
	if (!participant || participant.removedAt !== null) return { refused: 'unknown' };
	const decision = db.select().from(decisions).where(eq(decisions.id, participant.decisionId)).get();
	if (!decision) return { refused: 'unknown' };
	if (!linkUsable(decision, now)) return { refused: 'expired' };
	const person = participant.personId === null ? null : (db.select().from(people).where(eq(people.id, participant.personId)).get() ?? null);
	const hadAccount = accountHistory(decision.id).get(participant.id) ?? false;
	const reach = reachOf(participant, person, hadAccount);
	if (!('via' in reach) || reach.via !== 'link') return { refused: 'unknown' };
	return { participant, decision };
}

/** The address a link holder's mail carries: `<base>/decision-link/<token>`. */
export function linkUrl(baseUrl: string, token: string): string {
	return `${baseUrl}/decision-link/${token}`;
}
