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
 * (decision 16): every mail, every re-send and every link asks it.
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
import { accountHistory, appendEvent, type RecordActor } from './decision-record';
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
