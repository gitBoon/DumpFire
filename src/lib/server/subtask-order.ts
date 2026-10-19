/**
 * subtask-order.ts — the one order of a card's subtasks, and where a new one
 * goes (card 2223).
 *
 * A card's subtasks are listed by `position`, and by id where two share it, so
 * subtasks at one position read in the order they were made. Every reader that
 * hands out a card's subtasks as a list orders them this way: the board page,
 * All Tasks and All To Do, the card window, both subtask routes, the v1 card,
 * the reports and both CSV exports. Before, some ordered by `position` alone,
 * so a tie came in whatever order SQLite read it, and some had no order.
 *
 * A new subtask goes after the card's last one, from either create. The v1
 * create gave every subtask sent with no `position` 0, so a card filled by a
 * script had them all at 0. Subtasks already at 0 keep it: the id tiebreak
 * shows them in the order they were made.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { db } from './db';
import { subtasks } from './db/schema';

/** `.orderBy(...SUBTASK_ORDER)`: by position, then by id. */
export const SUBTASK_ORDER = [asc(subtasks.position), asc(subtasks.id)] as const;

/**
 * The position after the card's last subtask: one more than the largest, or 0
 * for a card with none. One `MAX`, read inside the caller's transaction, so two
 * creates cannot both take it.
 */
export function nextSubtaskPosition(cardId: number): number {
	const row = db
		.select({ next: sql<number>`COALESCE(MAX(${subtasks.position}), -1) + 1` })
		.from(subtasks)
		.where(eq(subtasks.cardId, cardId))
		.get();
	return Number(row?.next ?? 0);
}
