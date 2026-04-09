import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { subtasks, cards, columns } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/** Resolve the boardId for a given card. */
function getCardBoardId(cardId: number): number | null {
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) return null;
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	return col?.boardId ?? null;
}

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(url.searchParams.get('cardId'));
	if (!cardId) return json([]);

	const boardId = getCardBoardId(cardId);
	if (boardId && !canViewBoard(locals.user, boardId)) throw error(403, 'No access');

	const all = db.select().from(subtasks).where(eq(subtasks.cardId, cardId)).orderBy(asc(subtasks.position)).all();
	return json(all);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const { cardId, title, description, priority, colorTag, dueDate, boardId } = await request.json();

	// Resolve and verify board access
	const resolvedBoardId = boardId || getCardBoardId(cardId);
	if (resolvedBoardId && !canEditBoard(locals.user, resolvedBoardId)) {
		throw error(403, 'No edit access to this board');
	}

	const existing = db.select().from(subtasks).where(eq(subtasks.cardId, cardId)).all();
	const maxPos = existing.length > 0 ? Math.max(...existing.map((s) => s.position)) + 1 : 0;

	const subtask = db
		.insert(subtasks)
		.values({
			cardId,
			title: title || 'New subtask',
			description: description || '',
			priority: priority || 'medium',
			colorTag: colorTag || '',
			dueDate: dueDate || null,
			position: maxPos
		})
		.returning()
		.get();

	if (resolvedBoardId) emit(resolvedBoardId, 'update', { type: 'subtask' });
	return json(subtask, { status: 201 });
};
