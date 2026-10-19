/**
 * labels.ts — a board's labels listed, one made, changed and deleted: one
 * function for each, which both API trees call (card 2012, part A, slice A4).
 * Putting a label on a card and taking it off is `card-labels.ts`.
 *
 * `/api/labels` (the card window's label picker, every id in the body or the
 * query) and its twins `/api/v1/boards/:boardId/labels` and
 * `/api/v1/labels/:labelId` (every id in the path) had the same middle
 * written twice. Each tree keeps its path, its body, its single `writeAs`,
 * its answer and, through its options, what it does differently today: the
 * page's words for a change that names neither field (`sendNameOrColor`). R2
 * of `docs/planning/card-2012-service-layer-and-pages.md`.
 *
 * Each write has the one shape of a service (`ServiceOptions` in
 * `write-as.ts`): `inWrite()` first, then `requireUser(caller)` (401), the
 * guard (404, then 403), then every field read from the body (400), and the
 * write; but from the page the board's or the label's id is read from the
 * body before the guard, as the row the guard is asked of, so its `400
 * Invalid board ID` or `Invalid label ID` comes before a 404. No label write
 * records an entry, in either tree. Every event waits for the commit.
 * Refusals are kit `error()`s.
 */
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { labels, type Label } from './db/schema';
import type { SessionUser } from './auth';
import { emit } from './events';
import { readColour, readId, readText, type RequestBody } from './request-body';
import { requireBoard, requireLabel, requireUser } from './route-guards';
import { inWrite, type ServiceOptions } from './write-as';

/** The functions here that only read. Every other export is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = ['labelsOfBoard'];

/**
 * A label's `name` and `color`, as creating one and changing one read them,
 * one rule for both: `name` text, trimmed, of 1 to 200 characters (card
 * 2117's rule), and `color` a colour written `#rrggbb` (card 2010's decision
 * 14: a label's colour is drawn in a `style` on every page that shows it).
 *
 * With no `label`, a new one is read: `name` is required and `color` is
 * `#6366f1` when it is not sent. With the label being changed, either may be
 * left out, and what the label holds now, sent back unchanged, is kept as it
 * is: a colour stored before the rule does not stop a rename.
 */
function readLabelFields(body: RequestBody): { name: string; color: string };
function readLabelFields(body: RequestBody, label: Label): { name?: string; color?: string };
function readLabelFields(body: RequestBody, label?: Label): { name?: string; color?: string } {
	const name = readText(body, 'name', {
		required: !label,
		trim: true,
		min: 1,
		max: 200,
		keep: label?.name,
		says: {
			missing: 'name is required',
			empty: label ? 'name cannot be empty' : 'name is required'
		}
	});
	const color = readColour(body, 'color', { keep: label?.color });
	if (!label) return { name, color: color ?? '#6366f1' };

	const changes: { name?: string; color?: string } = {};
	if (name !== undefined) changes.name = name;
	if (color !== undefined) changes.color = color;
	return changes;
}

/**
 * A board's labels (`GET /api/labels?boardId=`, `GET
 * /api/v1/boards/:boardId/labels`). The board is looked for and the caller
 * asked for view access (404, then 403).
 */
export function labelsOfBoard(user: SessionUser | null | undefined, at: { boardId: number }, opts: Record<string, never>): Label[] {
	requireBoard(user, at.boardId, 'view');
	return db.select().from(labels).where(eq(labels.boardId, at.boardId)).all();
}

/**
 * Make a label: `POST /api/labels` with the board in its body, read first as
 * the row the guard is asked of, and `POST /api/v1/boards/:boardId/labels`
 * with `at.boardId`; then `name` and `color` (`readLabelFields`). A label
 * with no name was a 500, and any colour was stored. The answer is the label
 * as written.
 */
export function createLabel(caller: SessionUser | null, at: { boardId?: number }, body: RequestBody, opts: ServiceOptions): Label {
	inWrite();
	const user = requireUser(caller);
	// The board the label is created on, so it is the right one to check.
	const boardId = requireBoard(user, at.boardId ?? readId(body, 'boardId', { required: true, says: 'Invalid board ID' }), 'edit').id;

	const { name, color } = readLabelFields(body);

	const label = db.insert(labels).values({ boardId, name, color }).returning().get();
	emit(boardId, 'update', { type: 'label' });
	return label;
}

/** What each tree's label change does differently today (R2). */
export type UpdateLabelOptions = {
	/** A body that names neither field is `400 Send name or color to change` (the page); v1 says `No valid fields to update`. */
	sendNameOrColor?: boolean;
};

/**
 * Rename or recolour a label: `PATCH /api/labels` with `{ id, name?, color?
 * }` (a page cannot call v1, which needs an API key), and `PUT
 * /api/v1/labels/:labelId` with `at.labelId`. The label is looked for and the
 * caller checked (404, then 403: edit access to the label's own board), then
 * the fields are read (400), in the transaction that writes them; a `boardId`
 * in the body is ignored. Someone taken off the board while the body was
 * arriving is refused, and a label deleted meanwhile is 404. A body that
 * names neither field is a 400. The answer is the row.
 */
export function updateLabel(caller: SessionUser | null, at: { labelId?: number }, body: RequestBody, opts: ServiceOptions & UpdateLabelOptions): Label {
	inWrite();
	const user = requireUser(caller);
	const labelId = at.labelId ?? readId(body, 'id', { required: true, says: 'Invalid label ID' });
	const { label, boardId } = requireLabel(user, labelId, 'edit');

	const changes = readLabelFields(body, label);
	if (changes.name === undefined && changes.color === undefined) {
		throw error(400, opts.sendNameOrColor ? 'Send name or color to change' : 'No valid fields to update');
	}

	const row = db.update(labels).set(changes).where(eq(labels.id, labelId)).returning().get();
	emit(boardId, 'update', { type: 'label' });
	return row;
}

/**
 * Delete a label: `DELETE /api/labels` with `{ id }`, an id (card 2117), and
 * `DELETE /api/v1/labels/:labelId`. The label read, the caller checked and
 * the label deleted in one transaction: the board is the label's own. The
 * check and the delete were two steps with no transaction around them.
 */
export function deleteLabel(caller: SessionUser | null, at: { labelId?: number }, body: RequestBody | null, opts: ServiceOptions): void {
	inWrite();
	const user = requireUser(caller);
	const labelId = at.labelId ?? readId(body ?? {}, 'id', { required: true, says: 'Invalid label ID' });
	const { boardId } = requireLabel(user, labelId, 'edit');

	db.delete(labels).where(eq(labels.id, labelId)).run();
	emit(boardId, 'update', { type: 'label' });
}
