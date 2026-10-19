/**
 * card-categories.ts — a card category made, changed and deleted: one
 * function for each, which both API trees call (card 2012, part A, slice A4).
 *
 * `/api/categories` and `/api/categories/:id` (the board page and the
 * category manager) and their twins `/api/v1/boards/:boardId/categories` and
 * `/api/v1/categories/:categoryId` had the same middle written twice. Each
 * tree keeps its path, its body, its single `writeAs` and its answer, and
 * what it does differently today (R2 of
 * `docs/planning/card-2012-service-layer-and-pages.md`): the page names the
 * board in its body, or none for a category that belongs to no board, which
 * is an administrator's to make (`requireCategoryCreate`); v1 names it in
 * its path. Listing the categories a caller may pick is `cardCategoriesFor`
 * in `list-access.ts`.
 *
 * Each write has the one shape of a service (`ServiceOptions` in
 * `write-as.ts`): `inWrite()` first, then `requireUser(caller)` (401), the
 * guard (404, then 403), then every field read from the body (400), and the
 * write; but the page's `createCardCategory` reads the board's id from the
 * body before the guard, as the row the guard is asked of. No category write
 * records an entry. A category's board is told after the commit; a category
 * of no board tells no one. Refusals are kit `error()`s.
 */
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { categories, type Category } from './db/schema';
import type { SessionUser } from './auth';
import { emit } from './events';
import { readColour, readId, readText, type RequestBody } from './request-body';
import { requireBoard, requireCategoryCreate, requireCategoryEdit, requireUser } from './route-guards';
import { inWrite, type ServiceOptions } from './write-as';

/** The functions here that only read. None: every export but this list is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = [];

/**
 * Make a card category: `POST /api/categories` with the board in its body
 * (an id, or null or left out for one of no board), and `POST
 * /api/v1/boards/:boardId/categories` with `at.boardId`. The board is looked
 * for and the caller checked (404, then 403), and then the other fields are
 * read (card 2117, R1): `name` text, trimmed, of 1 to 200 characters, and
 * `color` a colour written `#rrggbb`. A name that was missing gave "New
 * Category", any colour was stored, and `''` and `0` as the board meant none.
 * The answer is the category as written.
 */
export function createCardCategory(caller: SessionUser | null, at: { boardId?: number }, body: RequestBody, opts: ServiceOptions): Category {
	inWrite();
	const user = requireUser(caller);
	const boardId =
		at.boardId === undefined
			? requireCategoryCreate(user, readId(body, 'boardId', { nullable: true, says: 'Invalid board ID' }))
			: requireBoard(user, at.boardId, 'edit').id;

	const name = readText(body, 'name', {
		required: true,
		trim: true,
		min: 1,
		max: 200,
		says: { missing: 'name is required', empty: 'name is required' }
	});
	const color = readColour(body, 'color', {});

	const category = db
		.insert(categories)
		.values({
			boardId,
			name,
			color: color ?? '#6366f1'
		})
		.returning()
		.get();
	if (boardId) emit(boardId, 'update', { type: 'category' });
	return category;
}

/**
 * Rename or recolour a category (`PUT /api/categories/:id`, `PUT
 * /api/v1/categories/:categoryId`). Edit access to the board it belongs to,
 * read from its row; one of no board is an administrator's
 * (`requireCategoryEdit`). It used to be open to everyone, so any API key
 * could rename a shared one. A body that names neither field is a 400. The
 * answer is the row.
 */
export function updateCardCategory(caller: SessionUser | null, at: { categoryId: number }, body: RequestBody, opts: ServiceOptions): Category {
	inWrite();
	const user = requireUser(caller);
	const category = requireCategoryEdit(user, at.categoryId);

	const updates: Partial<typeof categories.$inferInsert> = {};
	const name = readText(body, 'name', {
		trim: true,
		min: 1,
		max: 200,
		keep: category.name,
		says: { empty: 'name cannot be empty' }
	});
	if (name !== undefined) updates.name = name;
	const color = readColour(body, 'color', { keep: category.color });
	if (color !== undefined) updates.color = color;

	if (Object.keys(updates).length === 0) throw error(400, 'No valid fields to update');

	const row = db.update(categories).set(updates).where(eq(categories.id, at.categoryId)).returning().get();
	if (category.boardId) emit(category.boardId, 'update', { type: 'category' });
	return row;
}

/**
 * Delete a category (`DELETE /api/categories/:id`, `DELETE
 * /api/v1/categories/:categoryId`): read, the caller checked and deleted in
 * one transaction. The check and the delete were two steps with no
 * transaction around them. There is no body.
 */
export function deleteCardCategory(caller: SessionUser | null, at: { categoryId: number }, body: null, opts: ServiceOptions): void {
	inWrite();
	const category = requireCategoryEdit(caller, at.categoryId);

	db.delete(categories).where(eq(categories.id, at.categoryId)).run();
	if (category.boardId) emit(category.boardId, 'update', { type: 'category' });
}
