import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { labels, cardLabels, type Label } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { inTransaction } from '$lib/server/db/transaction';
import { readBody, readColour, readId, readQueryId, readText, type RequestBody } from '$lib/server/request-body';
import { requireBoard, requireCard, requireLabel, requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

// Get all labels for a board. A `boardId` that is no id is a 400, where `2.5`
// and `5abc` were read as another board or as none (card 2117).
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = readQueryId(url.searchParams.get('boardId'), 'board', 'Invalid boardId');
	if (boardId === undefined) return json([]);

	requireBoard(locals.user, boardId, 'view');

	const result = db.select().from(labels).where(eq(labels.boardId, boardId)).all();
	return json(result);
};

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
			empty: label ? 'name cannot be empty' : 'name is required',
			invalid: 'Label name too long (max 200 chars)'
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
 * Create a new label. `boardId` names the row guarded, so it is read first;
 * then `name` and `color` (`readLabelFields`). A label with no name was a 500,
 * and any colour was stored.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals.user);
	const body = await readBody(request);

	const label = inTransaction(() => {
		// Here the body's board id is the thing being acted on — the board the
		// label is created on — so it is the right one to check.
		const boardId = requireBoard(user, readId(body, 'boardId', { required: true, says: 'Invalid board ID' }), 'edit').id;

		const { name, color } = readLabelFields(body);

		const label = db
			.insert(labels)
			.values({ boardId, name, color })
			.returning()
			.get();
		emit(boardId, 'update', { type: 'label' });
		return label;
	});
	return json(label, { status: 201 });
};

/**
 * Rename or recolour a label, as the card window's label picker does (card
 * 2010). Body: `{ id, name?, color? }`. A page cannot call
 * `PUT /api/v1/labels/{labelId}`, which needs an API key, so this is the
 * session's own.
 *
 * The label is looked for and the caller checked first (400 for an id that is
 * no id, 404, then 403: edit access to the label's own board), then the
 * fields are read (400), in the transaction that writes them. A body that
 * names neither field is a 400. Open pages are told after the commit. No
 * activity entry is written, as no label route writes one.
 */
export const PATCH: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals.user);
	const body = await readBody(request);

	const updated = inTransaction(() => {
		const id = readId(body, 'id', { required: true, says: 'Invalid label ID' });

		// The board is the label's own. A `boardId` in the body is ignored.
		const { label, boardId } = requireLabel(user, id, 'edit');

		const changes = readLabelFields(body, label);
		if (changes.name === undefined && changes.color === undefined) throw error(400, 'Send name or color to change');

		const row = db.update(labels).set(changes).where(eq(labels.id, id)).returning().get();
		emit(boardId, 'update', { type: 'label' });
		return row;
	});
	return json(updated);
};

/**
 * Toggle a label on a card. `cardId` and `labelId` are ids (card 2117): one
 * that was not was read with `Number()`, and looked for as a card or a label.
 */
export const PUT: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals.user);
	const body = await readBody(request);

	const toggled = inTransaction(() => {
		const cardId = readId(body, 'cardId', { required: true, says: 'Invalid card ID' });

		// The board is the card's. A `boardId` in the body is ignored.
		const { boardId } = requireCard(user, cardId, 'edit');

		// A label belongs to one board and can only go on that board's cards.
		const labelId = readId(body, 'labelId', { required: true, says: 'Invalid label ID' });
		const { label } = requireLabel(user, labelId, 'view');
		if (label.boardId !== boardId) throw error(400, 'That label belongs to a different board');

		// Check if it exists
		const existing = db
			.select()
			.from(cardLabels)
			.where(and(eq(cardLabels.cardId, cardId), eq(cardLabels.labelId, labelId)))
			.get();

		if (existing) {
			db.delete(cardLabels)
				.where(and(eq(cardLabels.cardId, cardId), eq(cardLabels.labelId, labelId)))
				.run();
		} else {
			db.insert(cardLabels).values({ cardId, labelId }).run();
		}
		emit(boardId, 'update', { type: 'label' });
		return !existing;
	});
	return json({ toggled });
};

/** Delete a label. Body: `{ id }`, an id (card 2117). */
export const DELETE: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals.user);
	const body = await readBody(request);

	inTransaction(() => {
		const id = readId(body, 'id', { required: true, says: 'Invalid label ID' });

		// The board is the label's own. A `boardId` in the body is ignored.
		const { boardId } = requireLabel(user, id, 'edit');

		db.delete(labels).where(eq(labels.id, id)).run();
		emit(boardId, 'update', { type: 'label' });
	});
	return json({ success: true });
};
