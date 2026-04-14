import { db } from '$lib/server/db';
import { cards, columns, boards } from '$lib/server/db/schema';
import { isNotNull } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	const accessibleIds = getAccessibleBoardIds(user);

	const allBoards = accessibleIds === null
		? db.select().from(boards).all()
		: db.select().from(boards).all().filter(b => accessibleIds.includes(b.id));

	const boardMap = new Map(allBoards.map(b => [b.id, { name: b.name, emoji: b.emoji || '📋' }]));

	const allCols = db.select().from(columns).all()
		.filter(c => boardMap.has(c.boardId));
	const colToBoardMap = new Map(allCols.map(c => [c.id, c.boardId]));

	if (allCols.length === 0) {
		return { archivedCards: [], isAdmin: user.role === 'admin' || user.role === 'superadmin' };
	}

	const archived = db.select().from(cards)
		.where(isNotNull(cards.archivedAt))
		.all()
		.filter(c => colToBoardMap.has(c.columnId));

	const archivedCards = archived.map(c => {
		const boardId = colToBoardMap.get(c.columnId)!;
		const boardInfo = boardMap.get(boardId);
		return {
			id: c.id,
			title: c.title,
			description: c.description || '',
			priority: c.priority,
			archivedAt: c.archivedAt,
			createdAt: c.createdAt,
			boardName: boardInfo?.name || 'Unknown',
			boardEmoji: boardInfo?.emoji || '📋',
			boardId
		};
	}).sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || ''));

	return {
		archivedCards,
		isAdmin: user.role === 'admin' || user.role === 'superadmin'
	};
};
