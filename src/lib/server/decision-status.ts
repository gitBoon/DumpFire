/**
 * decision-status.ts — a decision's lifecycle (card 2675, plan section 4.2):
 * the statuses it is stored with, the one status every reader shows, which
 * action each stored status allows, and how long a personal link lasts.
 *
 * A decision is stored as `draft`, `open`, `closed`, `ruled`, `superseded` or
 * `withdrawn`. Readers never show `closed`: a closed decision, and an open one
 * whose `closes_at` has passed, are both `awaiting_ruling`. `decisionStatus`
 * says so in code and `awaitingRulingSql` in a query, and the tests hold that
 * the two agree (E10).
 *
 * Every write asks `requireTransition` after reading its body, so a refusal
 * for the status, a 409, comes after the guard's 404 and 403 and the body's
 * 400. Nothing here reads or writes a row.
 */
import { error } from '@sveltejs/kit';
import { sql, type SQL } from 'drizzle-orm';
import { decisions, type Decision } from './db/schema';
import type { ShownStatus } from '$lib/decision-view-types';
import { parseStamp, stamp, type Stamp } from '$lib/timestamps';

/** The statuses a decision is stored with. */
export const STORED_STATUSES = ['draft', 'open', 'closed', 'ruled', 'superseded', 'withdrawn'] as const;

export type StoredStatus = (typeof STORED_STATUSES)[number];

/**
 * What every reader shows: `closed`, and `open` past its `closes_at`, are
 * `awaiting_ruling`. Written in the client-safe `$lib/decision-view-types`
 * (card 2677, decision 21), and named here too for the server's readers.
 */
export type { ShownStatus };

/** The status a decision is shown with at `now`. */
export function decisionStatus(row: Pick<Decision, 'status' | 'closesAt'>, now: Stamp = stamp()): ShownStatus {
	if (row.status === 'closed') return 'awaiting_ruling';
	if (row.status === 'open' && row.closesAt !== null && row.closesAt <= now) return 'awaiting_ruling';
	return row.status as ShownStatus;
}

/**
 * The rows `decisionStatus` shows as `awaiting_ruling` at `now`, as a
 * condition on `decisions`. Stored moments are `stamp()` text, so `<=` on
 * them in SQL agrees with `<=` on strings in code.
 */
export function awaitingRulingSql(now: Stamp): SQL {
	return sql`(${decisions.status} = 'closed' OR (${decisions.status} = 'open' AND ${decisions.closesAt} IS NOT NULL AND ${decisions.closesAt} <= ${now}))`;
}

/** What a guard, a rule and a transition name. */
export type DecisionAction =
	| 'view'
	| 'edit'
	| 'setDecider'
	| 'include'
	| 'review'
	| 'open'
	| 'republish'
	| 'close'
	| 'extend'
	| 'withdraw'
	| 'delete'
	| 'resend'
	| 'participantAccount'
	| 'participantAddress'
	| 'rule'
	| 'record'
	| 'respond';

/**
 * Each action in words: `verb` for `You cannot <verb> this decision` (the
 * guard's 403), and `done` for `This decision is <status>: <done>` (a 409
 * for the status).
 */
export const DECISION_ACTION_WORDS: Readonly<Record<DecisionAction, { verb: string; done: string }>> = {
	view: { verb: 'view', done: 'it cannot be viewed' },
	edit: { verb: 'edit', done: 'it cannot be edited' },
	setDecider: { verb: 'change the decider of', done: 'its decider cannot be changed' },
	include: { verb: 'include people in', done: 'nobody can be included in it' },
	review: { verb: 'mark text reviewed on', done: 'its text cannot be marked reviewed' },
	open: { verb: 'open', done: 'it cannot be opened' },
	republish: { verb: 're-publish', done: 'it cannot be re-published' },
	close: { verb: 'close', done: 'it cannot be closed' },
	extend: { verb: 'extend', done: 'it cannot be extended' },
	withdraw: { verb: 'withdraw', done: 'it cannot be withdrawn' },
	delete: { verb: 'delete', done: 'it cannot be deleted' },
	resend: { verb: 'send an invitation again for', done: 'an invitation cannot be sent again' },
	participantAccount: { verb: "change a participant's account on", done: "a participant's account cannot be changed" },
	participantAddress: { verb: "change a participant's address on", done: "a participant's address cannot be changed" },
	rule: { verb: 'rule on', done: 'it cannot be ruled on' },
	record: { verb: 'read the record of', done: 'its record cannot be read' },
	respond: { verb: 'respond to', done: 'responses are closed' }
};

/** Each shown status in words, for `This decision is <status>`. */
const STATUS_WORDS: Readonly<Record<ShownStatus, string>> = {
	draft: 'a draft',
	open: 'open',
	awaiting_ruling: 'awaiting a ruling',
	ruled: 'ruled',
	superseded: 'superseded',
	withdrawn: 'withdrawn'
};

/** The stored statuses each action may be taken from. `view` and `record` are allowed from any. */
export const TRANSITIONS: Readonly<Record<Exclude<DecisionAction, 'view' | 'record'>, readonly StoredStatus[]>> = {
	edit: ['draft', 'open', 'closed'],
	setDecider: ['draft', 'open', 'closed'],
	// Card 2676: including people once opened (R3), and marking agent-drafted text reviewed (decision 9).
	include: ['open', 'closed'],
	review: ['draft', 'open', 'closed'],
	open: ['draft'],
	republish: ['open', 'closed'],
	close: ['open'],
	extend: ['open', 'closed'],
	withdraw: ['draft', 'open', 'closed'],
	delete: ['draft', 'withdrawn'],
	resend: ['open', 'closed'],
	participantAccount: ['open', 'closed'],
	participantAddress: ['open', 'closed'],
	rule: ['open', 'closed'],
	// Card 2677: a participant's response, while the decision is stored open; the write also asks the shown status (decision 12).
	respond: ['open']
};

/**
 * A 409 unless the decision's stored status allows `action`, in the words of
 * the status it is shown with: `This decision is awaiting a ruling: it cannot
 * be opened`.
 */
export function requireTransition(
	row: Pick<Decision, 'status' | 'closesAt'>,
	action: Exclude<DecisionAction, 'view' | 'record'>,
	now: Stamp = stamp()
): void {
	if ((TRANSITIONS[action] as readonly string[]).includes(row.status)) return;
	error(409, `This decision is ${STATUS_WORDS[decisionStatus(row, now)] ?? row.status}: ${DECISION_ACTION_WORDS[action].done}`);
}

/** How long a personal link lasts after the moment that bounds it (D24, decision 11). */
export const LINK_DAYS_AFTER_END = 90;

/** `moment` moved on by `days` whole days, in the stored form; null when it is not a moment. */
function plusDays(moment: Stamp, days: number): Stamp | null {
	const date = parseStamp(moment);
	if (date === null) return null;
	return stamp(new Date(date.getTime() + days * 24 * 60 * 60 * 1000));
}

/**
 * Whether a personal link on this decision may be used at `now` (decision 11,
 * R9). Worked out when the link is read; nothing sweeps expired links.
 *
 * The bound is `ruled_at` for a ruled or superseded decision, `withdrawn_at`
 * for a withdrawn one, and `closes_at` for an open or closed one, and the link
 * is usable while `now` is before the bound plus 90 days. With no bound it is
 * usable only on an open decision; a draft never has a usable link.
 */
export function linkUsable(row: Pick<Decision, 'status' | 'ruledAt' | 'withdrawnAt' | 'closesAt'>, now: Stamp = stamp()): boolean {
	const bound =
		row.status === 'ruled' || row.status === 'superseded'
			? row.ruledAt
			: row.status === 'withdrawn'
				? row.withdrawnAt
				: row.status === 'open' || row.status === 'closed'
					? row.closesAt
					: undefined; // a draft, or a status that is none of these
	if (bound === undefined) return false;
	if (bound === null) return row.status === 'open';
	const end = plusDays(bound, LINK_DAYS_AFTER_END);
	// A bound that is no moment is refused: fail closed.
	return end !== null && now < end;
}
