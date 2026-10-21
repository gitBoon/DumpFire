/**
 * card-assignees.ts — someone assigned to a card, and taken off it: one
 * function for each, which both API trees call (card 2012, part A, slice A2).
 *
 * `POST` and `DELETE /api/cards/:id/assignees` (the card window) and their
 * twins under `/api/v1/cards/:cardId/assignees` had the same middle written
 * twice: the guard, the user looked for, the row, the mail, the entry and the
 * live event. Each tree keeps its path, its body, its single `writeAs`, its
 * answer and, through `says`, its own words for a caller who may not edit the
 * card's board (R2 of `docs/planning/card-2012-service-layer-and-pages.md`).
 *
 * Each function has the one shape of a service (`ServiceOptions` in
 * `write-as.ts`): `inWrite()` first, then `requireUser(caller)` (401), the
 * card's guard (404, then 403), then `userId` read from the body (400) and
 * looked for (404), so a session that ended while the body arrived is refused
 * 401 before any of them is read (S2). Every entry, event and mail waits for
 * the commit. Refusals are kit `error()`s, as the guards throw them.
 */
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { cardAssignees, users } from './db/schema';
import type { SessionUser } from './auth';
import { getBoardRole } from './board-access';
import { requireCard, requireUser } from './route-guards';
import { emit } from './events';
import { ACTIONS, actorOf, logActivity } from './logActivity';
import { notifyUserAssigned } from './notifications';
import { readId, type RequestBody } from './request-body';
import { inWrite, type ServiceOptions } from './write-as';

/** The functions here that only read. None: every export but this list is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = [];

/**
 * Assign a user to a card. Body: `{ userId }`, an id (card 2117).
 *
 * The user must be able to open the card's board (400 otherwise). Someone
 * already assigned is left as they are: no row, no entry and no mail, and the
 * board is told either way, as both trees always have. Whether they were is
 * read in this transaction, so two requests cannot both find them unassigned.
 * The answer says whether they already were, for v1's `message`.
 */
export function assignToCard(
	caller: SessionUser | null,
	at: { cardId: number },
	body: RequestBody,
	opts: ServiceOptions
): { already: boolean } {
	inWrite();
	const user = requireUser(caller);
	const { cardId } = at;
	const { card, boardId } = requireCard(user, cardId, 'edit', opts.says);

	const userId = readId(body, 'userId', { required: true, says: { missing: 'userId is required' } });

	// The user, and their access to this board.
	const assignee = db
		.select({ id: users.id, email: users.email, username: users.username, role: users.role })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (!assignee) throw error(404, 'User not found');
	if (!getBoardRole(assignee, boardId)) throw error(400, 'User does not have access to this board');

	const existing = db
		.select()
		.from(cardAssignees)
		.where(and(eq(cardAssignees.cardId, cardId), eq(cardAssignees.userId, userId)))
		.get();

	// Nobody is mailed about assigning themselves (card 2286), as nobody is
	// about a move they made themselves: the row, the entry and the update are
	// as for anyone else.
	if (!existing) {
		db.insert(cardAssignees).values({ cardId, userId }).run();
		if (assignee.id !== user.id) {
			notifyUserAssigned(boardId, cardId, card.title, assignee.email, assignee.username, user.username, opts.baseUrl ?? null);
		}
	}

	emit(boardId, 'update', { type: 'card' });

	if (!existing) {
		logActivity({
			boardId,
			cardId,
			action: ACTIONS.assigneeAdded,
			detail: `Assigned ${assignee.username} to "${card.title}"`,
			source: opts.source,
			...actorOf(user)
		});
	}

	return { already: !!existing };
}

/**
 * Take a user off a card. Body: `{ userId }`, an id. Someone who is not
 * assigned to it is `404 User is not assigned to this card` (card 2117,
 * decision 9), with nothing written and nobody told.
 */
export function unassignFromCard(caller: SessionUser | null, at: { cardId: number }, body: RequestBody, opts: ServiceOptions): void {
	inWrite();
	const user = requireUser(caller);
	const { cardId } = at;
	const { card, boardId } = requireCard(user, cardId, 'edit', opts.says);

	const userId = readId(body, 'userId', { required: true, says: { missing: 'userId is required' } });

	const removed = db
		.delete(cardAssignees)
		.where(and(eq(cardAssignees.cardId, cardId), eq(cardAssignees.userId, userId)))
		.run();
	if (removed.changes === 0) throw error(404, 'User is not assigned to this card');

	emit(boardId, 'update', { type: 'card' });

	const removedUser = db.select({ username: users.username }).from(users).where(eq(users.id, userId)).get();
	logActivity({
		boardId,
		cardId,
		action: ACTIONS.assigneeRemoved,
		detail: `Removed ${removedUser?.username || 'user'} from "${card.title}"`,
		source: opts.source,
		...actorOf(user)
	});
}
