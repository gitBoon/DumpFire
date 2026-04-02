import { db } from '$lib/server/db';
import { boards, columns, cards, categories, subtasks, labels, cardLabels } from '$lib/server/db/schema';
import { asc, inArray } from 'drizzle-orm';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const allBoards = db.select().from(boards).all();
	const allColumns = db.select().from(columns).orderBy(asc(columns.position)).all();

	const columnIds = allColumns.map(c => c.id);
	const allCards = columnIds.length > 0
		? db.select().from(cards).where(inArray(cards.columnId, columnIds)).orderBy(asc(cards.position)).all()
		: [];

	const cardIds = allCards.map(c => c.id);
	const allSubtasks = cardIds.length > 0
		? db.select().from(subtasks).where(inArray(subtasks.cardId, cardIds)).orderBy(asc(subtasks.position)).all()
		: [];

	const allCardLabels = cardIds.length > 0
		? db.select().from(cardLabels).where(inArray(cardLabels.cardId, cardIds)).all()
		: [];

	const allCategories = db.select().from(categories).orderBy(asc(categories.name)).all();
	const allLabels = db.select().from(labels).all();

	// Build a map of column id -> column info (with board name)
	const columnMap = new Map<number, { title: string; boardId: number }>();
	for (const col of allColumns) {
		columnMap.set(col.id, { title: col.title, boardId: col.boardId });
	}

	const boardMap = new Map<number, { name: string; emoji: string }>();
	for (const b of allBoards) {
		boardMap.set(b.id, { name: b.name, emoji: b.emoji || '📋' });
	}

	// Normalize column titles into buckets
	function getBucket(colTitle: string): string {
		const t = colTitle.toLowerCase().trim();
		if (t === 'complete' || t === 'done') return 'Complete';
		if (t === 'in progress' || t === 'in-progress' || t === 'doing') return 'In Progress';
		if (t === 'on hold' || t === 'blocked' || t === 'waiting') return 'On Hold';
		return 'To Do';
	}

	// Build enriched cards with board info
	const enrichedCards = allCards.map(card => {
		const colInfo = columnMap.get(card.columnId);
		const boardInfo = colInfo ? boardMap.get(colInfo.boardId) : null;
		return {
			...card,
			subtasks: allSubtasks.filter(st => st.cardId === card.id),
			labelIds: allCardLabels.filter(cl => cl.cardId === card.id).map(cl => cl.labelId),
			boardName: boardInfo?.name || 'Unknown',
			boardEmoji: boardInfo?.emoji || '📋',
			boardId: colInfo?.boardId || 0,
			columnTitle: colInfo?.title || 'Unknown',
			bucket: colInfo ? getBucket(colInfo.title) : 'To Do'
		};
	});

	// Group into buckets
	const buckets = ['To Do', 'On Hold', 'In Progress', 'Complete'];
	const grouped = buckets.map(bucket => ({
		title: bucket,
		cards: enrichedCards.filter(c => c.bucket === bucket)
	}));

	return {
		boards: allBoards.map(b => ({ ...b, ...boardMap.get(b.id)! })),
		buckets: grouped,
		categories: allCategories,
		labels: allLabels,
		totalCards: allCards.length,
		completedCards: enrichedCards.filter(c => c.bucket === 'Complete').length
	};
};
