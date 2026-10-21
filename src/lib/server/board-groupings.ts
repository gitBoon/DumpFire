/**
 * board-groupings.ts — a dashboard grouping made, renamed and deleted: one
 * function for each, which both API trees call (card 2012, part A, slice A4).
 *
 * `/api/board-categories` and `/api/board-categories/:id` (the dashboard)
 * and their twins under `/api/v1/board-categories` had the same middle
 * written twice. A grouping is on no board: boards are filed under it
 * (`boards.category_id`). Each tree keeps its path, its body, its single
 * `writeAs` and its answer; the two do nothing differently today. Listing
 * the groupings a caller is listed is `boardCategoriesFor` in
 * `list-access.ts`, which both trees call already.
 *
 * Each write has the one shape of a service (`ServiceOptions` in
 * `write-as.ts`): `inWrite()` first, then the caller (401), the guard (404,
 * then 403), then every field read from the body (400), and the write. No
 * grouping write records an entry or tells anyone. Deleting one takes every
 * board filed under it out of it, in the same transaction (card 2293).
 * Refusals are kit `error()`s.
 */
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { boardCategories, boards, type BoardCategory } from './db/schema';
import type { SessionUser } from './auth';
import { changedFields } from './card-changes';
import { readColour, readText, type RequestBody } from './request-body';
import { requireBoardCategoryEdit, requireUser } from './route-guards';
import { inWrite, type ServiceOptions } from './write-as';

/** The functions here that only read. None: every export but this list is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = [];

/**
 * Make a dashboard grouping (`POST /api/board-categories`, `POST
 * /api/v1/board-categories`). Any signed-in caller may make one, so the
 * account as it is now is asked nothing more.
 *
 * A grouping is on no board, so there is no row to guard and its fields are
 * read at once (card 2117): `name` text, trimmed, of 1 to 200 characters, and
 * `color` a colour written `#rrggbb`. A name that was missing or empty gave
 * "New Category", and any colour was stored.
 */
export function createBoardGrouping(caller: SessionUser | null, at: Record<string, never>, body: RequestBody, opts: ServiceOptions): BoardCategory {
	inWrite();
	requireUser(caller);

	const name = readText(body, 'name', {
		required: true,
		trim: true,
		min: 1,
		max: 200,
		says: { missing: 'name is required', empty: 'name is required' }
	});
	const color = readColour(body, 'color', {});

	return db
		.insert(boardCategories)
		.values({
			name,
			color: color ?? '#6366f1'
		})
		.returning()
		.get();
}

/**
 * Rename or recolour a grouping (`PUT /api/board-categories/:id`, `PUT
 * /api/v1/board-categories/:categoryId`). Renaming a grouping changes how
 * every board filed under it is shown, so the caller must be able to edit
 * each of them (`requireBoardCategoryEdit`); the boards filed under it are
 * read in the transaction that renames it. A body that names neither field is
 * a 400. Only the fields whose value changes are written; a save that changes
 * nothing writes nothing (card 2359). The answer is the row.
 */
export function updateBoardGrouping(caller: SessionUser | null, at: { categoryId: number }, body: RequestBody, opts: ServiceOptions): BoardCategory {
	inWrite();
	const grouping = requireBoardCategoryEdit(caller, at.categoryId);

	const updates: Partial<typeof boardCategories.$inferInsert> = {};
	const name = readText(body, 'name', {
		trim: true,
		min: 1,
		max: 200,
		keep: grouping.name,
		says: { empty: 'name cannot be empty' }
	});
	if (name !== undefined) updates.name = name;
	const color = readColour(body, 'color', { keep: grouping.color });
	if (color !== undefined) updates.color = color;

	if (Object.keys(updates).length === 0) throw error(400, 'No valid fields to update');

	// Card 2183's rule (card 2359), after every refusal: a name and colour as
	// the grouping holds them write nothing, and the grouping is answered as it
	// is; otherwise only what changes is written.
	const changed = changedFields(grouping, updates);
	if (Object.keys(changed).length === 0) return grouping;
	return db.update(boardCategories).set(changed).where(eq(boardCategories.id, at.categoryId)).returning().get();
}

/**
 * Delete a grouping (`DELETE /api/board-categories/:id`, `DELETE
 * /api/v1/board-categories/:categoryId`): read, the caller checked and
 * deleted in one transaction. The check and the delete were two steps with no
 * transaction around them. There is no body.
 *
 * Every board filed under it, sub-boards included, is taken out of it first,
 * as the page's confirm promises ("Boards using it will become
 * uncategorised"). `boards.category_id` has no foreign key, so nothing else
 * clears it: the boards kept the id, every board read answered it, and a
 * grouping given that id again would have had them filed under it (card
 * 2293). The guard has already asked for edit access to each of them. Their
 * `updated_at` is left as it is and nothing is recorded or told: nobody
 * edited them, and every page showed them as uncategorised already.
 */
export function deleteBoardGrouping(caller: SessionUser | null, at: { categoryId: number }, body: null, opts: ServiceOptions): void {
	inWrite();
	requireBoardCategoryEdit(caller, at.categoryId);

	db.update(boards).set({ categoryId: null }).where(eq(boards.categoryId, at.categoryId)).run();
	db.delete(boardCategories).where(eq(boardCategories.id, at.categoryId)).run();
}
