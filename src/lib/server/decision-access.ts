/**
 * decision-access.ts — who may do what to a decision (card 2675, plan
 * section 4.3 and decisions 3 to 6 and 29).
 *
 * `decisionAccess` reads the caller's roles on one decision: `admin`,
 * `author`, `decider`, a board role from `getBoardRole` asked once
 * (`boardOwner`, `boardEditor`, `boardReader`), `productOwner` (card 2679:
 * the caller was the board's Product Owner when the decision was ruled, as
 * its `ruled` event recorded them, code review S1), and `participant`. A role is held only as itself: `boardOwner` does not
 * imply `boardReader`. With no board, a decision whose board was deleted, no
 * board role can arise (E3), and no `productOwner` either.
 *
 * `mayDo` decides an action from `DECISION_RULES`, with two more rules:
 *
 *   - a draft is seen only by `DRAFT_VIEWERS`: its author, its decider, the
 *     board's owners and administrators (decision 5);
 *   - while the decision's board exists, a grant resting on `author`,
 *     `decider`, `boardOwner` or `productOwner` is good for anything but
 *     `view` only if the caller can edit the board now (decision 6, R4; the
 *     decider since the code review's S8, `rule` included; the Product Owner
 *     since card 2679, decision 5). Another role the caller holds may still
 *     grant it.
 *
 * `productOwner` is listed by `supersede` alone (card 2679, S2), so it
 * changes nothing else.
 *
 * `requireDecision` in route-guards.ts asks both, and answers 404 for a
 * decision the caller may not view, as for one that is not there (decision
 * 4). This module is not the service and does not import it: the service
 * imports the guards (decision 3).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db';
import { decisionParticipants, type Decision } from './db/schema';
import { getBoardRole, isAdmin, type Actor } from './board-access';
import { eventsOfKind } from './decision-record';
import type { DecisionAction } from './decision-status';
import { createLogger } from './logger';

const log = createLogger('DECISIONS');

export type DecisionRole = 'admin' | 'author' | 'decider' | 'boardOwner' | 'boardEditor' | 'boardReader' | 'productOwner' | 'participant';

/**
 * The caller's roles on one decision; the id of their live participant row,
 * or null; and whether they can edit the decision's board now (false with no
 * board).
 */
export type DecisionAccess = { roles: ReadonlySet<DecisionRole>; participantId: number | null; canEditBoard: boolean };

/** Who may do each action, every role listed that it lets in (the table in plan section 4.3). */
export const DECISION_RULES: Readonly<Record<DecisionAction, readonly DecisionRole[]>> = {
	view: ['admin', 'author', 'decider', 'boardOwner', 'boardEditor', 'boardReader', 'participant'],
	edit: ['admin', 'author', 'decider', 'boardOwner'],
	setDecider: ['admin', 'author', 'boardOwner'],
	// Card 2676: the accountable people's acts, each with the board-edit rule while the board exists (R3, decision 9).
	include: ['author', 'decider'],
	review: ['author', 'decider'],
	open: ['author', 'decider'],
	republish: ['author', 'decider'],
	close: ['author', 'decider'],
	extend: ['decider'],
	withdraw: ['admin', 'author', 'decider'],
	delete: ['admin', 'author'],
	resend: ['admin', 'author', 'decider'],
	participantAccount: ['admin'],
	participantAddress: ['admin'],
	rule: ['decider'],
	record: ['admin', 'decider'],
	// Card 2677: a participant's response; the write refuses an informed one, and one `reachOf` no longer reaches (decision 10).
	respond: ['participant'],
	// Card 2697: a dry run mails the caller, so it is the accountable people's act (decision 5), with the board-edit rule.
	dryRun: ['author', 'decider'],
	// Card 2679: the results, with names, are the decider's and administrators' (decision 1); releasing them the decider's alone
	// (design 4.5); a concern a participant's; and superseding a ruling its decider's, the board's Product Owner's or an
	// administrator's, never any board editor's (S2).
	results: ['admin', 'decider'],
	release: ['decider'],
	concern: ['participant'],
	supersede: ['admin', 'decider', 'productOwner']
};

/** Who may view a draft (decision 5). */
export const DRAFT_VIEWERS: readonly DecisionRole[] = ['admin', 'author', 'decider', 'boardOwner'];

/**
 * The roles whose writes also need edit access to the board now, while it
 * exists (decision 6, R4): a decider who has lost the board cannot rule or
 * change it either (the code review's S8), nor a Product Owner supersede a
 * ruling (card 2679, decision 5).
 */
const NEED_BOARD_EDIT: readonly DecisionRole[] = ['author', 'decider', 'boardOwner', 'productOwner'];

/**
 * The caller's access to the decision. The participant row is the one live
 * row (`removed_at` null) holding the caller's account; more than one is a
 * fault (decision 29): no `participant` role, and one WARN line naming the
 * decision and the count, and no person.
 */
export function decisionAccess(user: Actor, decision: Pick<Decision, 'id' | 'boardId' | 'authorUserId' | 'deciderUserId'>): DecisionAccess {
	const roles = new Set<DecisionRole>();
	if (isAdmin(user)) roles.add('admin');
	if (decision.authorUserId !== null && decision.authorUserId === user.id) roles.add('author');
	if (decision.deciderUserId !== null && decision.deciderUserId === user.id) roles.add('decider');

	let canEditBoard = false;
	if (decision.boardId !== null) {
		const role = getBoardRole(user, decision.boardId);
		if (role === 'owner') roles.add('boardOwner');
		else if (role === 'editor') roles.add('boardEditor');
		else if (role === 'viewer') roles.add('boardReader');
		canEditBoard = role === 'admin' || role === 'owner' || role === 'editor';
		// Card 2679 (decision 5; code review S1): the board's Product Owner as the ruling recorded them, never as the board names
		// one now, so that nobody can make themselves Product Owner after a ruling to overturn it. No ruling, or one that
		// recorded none, gives the role to nobody.
		const productOwnerUserId = eventsOfKind(decision.id, 'ruled').at(-1)?.detail.productOwnerUserId;
		if (typeof productOwnerUserId === 'number' && productOwnerUserId === user.id) roles.add('productOwner');
	}

	const rows = db
		.select({ id: decisionParticipants.id })
		.from(decisionParticipants)
		.where(
			and(
				eq(decisionParticipants.decisionId, decision.id),
				eq(decisionParticipants.userId, user.id),
				isNull(decisionParticipants.removedAt)
			)
		)
		.all();
	let participantId: number | null = null;
	if (rows.length === 1) {
		roles.add('participant');
		participantId = rows[0].id;
	} else if (rows.length > 1) {
		log.warn(`Decision ${decision.id}: ${rows.length} live participant rows hold the caller's account; participant access refused`, {
			decisionId: decision.id,
			rows: rows.length
		});
	}
	return { roles, participantId, canEditBoard };
}

/** Whether `access` lets the caller do `action` to the decision, by the rules above. */
export function mayDo(access: DecisionAccess, action: DecisionAction, decision: Pick<Decision, 'status' | 'boardId'>): boolean {
	const allowed = action === 'view' && decision.status === 'draft' ? DRAFT_VIEWERS : DECISION_RULES[action];
	const boardEditLacking = action !== 'view' && decision.boardId !== null && !access.canEditBoard;
	return allowed.some((role) => access.roles.has(role) && !(boardEditLacking && NEED_BOARD_EDIT.includes(role)));
}
