/**
 * card-fields.ts — what a card's and a subtask's fields may hold, where more
 * than one handler writes them (card 2117).
 *
 * The readers of `request-body.ts` say what type a field is. What is here is
 * what the field is for: the four priorities every page draws, and which
 * categories a card may be filed under. The handlers of both API trees that
 * create or change a card or a subtask read their fields against these.
 */
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { categories } from './db/schema';

/**
 * The priorities a card, a subtask and a template may have, in the order a
 * refusal lists them. A page draws these four; anything else it draws as
 * none. Read in any case, and stored in lower case, as the reporting fields
 * are.
 */
export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;

/**
 * The category a card is to be filed under, if it is one of the card's board's
 * or one that belongs to no board (card 2117, R3): a shared category, made by
 * an administrator, is everybody's. Anything else is
 * `404 Category not found on this board`, a category that is not there
 * among them, which the foreign key refused with a 500.
 *
 * A handler that changes a card asks this only of a category that is not the
 * one the card already holds: one sent back unchanged is kept (decision 8).
 */
export function requireCardCategory(categoryId: number, boardId: number): void {
	const category = db.select({ boardId: categories.boardId }).from(categories).where(eq(categories.id, categoryId)).get();
	if (!category || (category.boardId !== null && category.boardId !== boardId)) {
		error(404, 'Category not found on this board');
	}
}
