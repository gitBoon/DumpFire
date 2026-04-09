import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { canEditBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/** Resolve the board that a card belongs to. */
function getCardBoardId(cardId: number): number | null {
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) return null;
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	return col?.boardId ?? null;
}

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	const data = await request.json();
	const { boardId: clientBoardId, ...rawData } = data;

	// Resolve and verify board access
	const resolvedBoardId = clientBoardId || getCardBoardId(id);
	if (!resolvedBoardId) throw error(404, 'Card not found');
	if (!canEditBoard(locals.user, resolvedBoardId)) {
		throw error(403, 'No edit access to this board');
	}

	// Whitelist allowed fields to prevent mass assignment
	const updateData: Record<string, unknown> = {};
	const allowed = ['title', 'description', 'priority', 'colorTag', 'categoryId', 'dueDate',
		'onHoldNote', 'businessValue', 'pinned', 'position', 'columnId', 'completedAt',
		'archivedAt', 'coverUrl', 'recurrenceRule'];
	for (const key of allowed) {
		if (key in rawData) updateData[key] = rawData[key];
	}
	updateData.updatedAt = new Date().toISOString();

	const updated = db
		.update(cards)
		.set(updateData)
		.where(eq(cards.id, id))
		.returning()
		.get();
	if (!updated) throw error(404, 'Card not found');
	if (resolvedBoardId) emit(resolvedBoardId, 'update', { type: 'card' });
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, request, url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	const permanent = url.searchParams.get('permanent') === 'true';

	let clientBoardId: number | undefined;
	try {
		const data = await request.json();
		clientBoardId = data.boardId;
	} catch {}

	// Resolve and verify board access
	const resolvedBoardId = clientBoardId || getCardBoardId(id);
	if (resolvedBoardId && !canEditBoard(locals.user, resolvedBoardId)) {
		throw error(403, 'No edit access to this board');
	}

	if (permanent) {
		db.delete(cards).where(eq(cards.id, id)).run();
	} else {
		// Soft-delete: move to archive
		db.update(cards)
			.set({ archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
			.where(eq(cards.id, id))
			.run();
	}
	if (resolvedBoardId) emit(resolvedBoardId, 'update', { type: 'card' });
	return json({ success: true });
};
