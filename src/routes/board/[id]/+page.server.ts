import { db } from '$lib/server/db';
import { boards, columns, cards, categories, subtasks, labels, cardLabels } from '$lib/server/db/schema';
import { eq, asc, inArray, isNull } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const boardId = Number(params.id);

	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) throw error(404, 'Board not found');

	// Build ancestry chain for breadcrumbs
	type BreadcrumbItem = { label: string; emoji: string; href: string };
	const breadcrumbs: BreadcrumbItem[] = [];

	let currentBoard = board;
	while (currentBoard.parentCardId) {
		// Find the parent card
		const parentCard = db.select().from(cards).where(eq(cards.id, currentBoard.parentCardId)).get();
		if (!parentCard) break;

		// Find the column to get the board
		const parentCol = db.select().from(columns).where(eq(columns.id, parentCard.columnId)).get();
		if (!parentCol) break;

		const parentBoard = db.select().from(boards).where(eq(boards.id, parentCol.boardId)).get();
		if (!parentBoard) break;

		breadcrumbs.unshift({
			label: parentBoard.name,
			emoji: parentBoard.emoji || '📋',
			href: `/board/${parentBoard.id}`
		});

		currentBoard = parentBoard;
	}

	const boardColumns = db
		.select()
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.orderBy(asc(columns.position))
		.all();

	const columnIds = boardColumns.map((c) => c.id);

	const allCards =
		columnIds.length > 0
			? db
					.select()
					.from(cards)
					.where(inArray(cards.columnId, columnIds))
					.orderBy(asc(cards.position))
					.all()
			: [];

	// Get all subtasks for all cards in one query
	const cardIds = allCards.map((c) => c.id);
	const allSubtasks =
		cardIds.length > 0
			? db
					.select()
					.from(subtasks)
					.where(inArray(subtasks.cardId, cardIds))
					.orderBy(asc(subtasks.position))
					.all()
			: [];

	// Get all card-label associations
	const allCardLabels =
		cardIds.length > 0
			? db
					.select()
					.from(cardLabels)
					.where(inArray(cardLabels.cardId, cardIds))
					.all()
			: [];

	// Get sub-board info for cards that have sub-boards
	const subBoards = cardIds.length > 0
		? db.select().from(boards).where(inArray(boards.parentCardId, cardIds)).all()
		: [];

	// Build a map of cardId -> sub-boards (supports multiple per card)
	type SubBoardInfo = { id: number; name: string; emoji: string; done: number; total: number };
	const subBoardMap = new Map<number, SubBoardInfo[]>();
	for (const sb of subBoards) {
		if (!sb.parentCardId) continue;
		const sbCols = db.select().from(columns).where(eq(columns.boardId, sb.id)).all();
		const sbColIds = sbCols.map(c => c.id);
		let done = 0, total = 0;
		if (sbColIds.length > 0) {
			const sbCards = db.select().from(cards).where(inArray(cards.columnId, sbColIds)).all();
			total = sbCards.length;
			const completeCols = sbCols.filter(c => c.title.toLowerCase() === 'complete' || c.title.toLowerCase() === 'done');
			const completeColIds = new Set(completeCols.map(c => c.id));
			done = sbCards.filter(c => completeColIds.has(c.columnId)).length;
		}
		const entry: SubBoardInfo = { id: sb.id, name: sb.name, emoji: sb.emoji || '🗂️', done, total };
		const existing = subBoardMap.get(sb.parentCardId) || [];
		existing.push(entry);
		subBoardMap.set(sb.parentCardId, existing);
	}

	// Group cards by column with their subtasks, labels, and sub-board info
	const columnsWithCards = boardColumns.map((col) => ({
		...col,
		cards: allCards
			.filter((card) => card.columnId === col.id)
			.map((card) => ({
				...card,
				subtasks: allSubtasks.filter((st) => st.cardId === card.id),
				labelIds: allCardLabels.filter((cl) => cl.cardId === card.id).map((cl) => cl.labelId),
				subBoards: subBoardMap.get(card.id) || []
			}))
	}));

	const boardCategories = db
		.select()
		.from(categories)
		.where(eq(categories.boardId, boardId))
		.orderBy(asc(categories.name))
		.all();

	const boardLabels = db
		.select()
		.from(labels)
		.where(eq(labels.boardId, boardId))
		.all();

	// Get linkable boards (top-level boards except this one)
	const linkableBoards = db.select({ id: boards.id, name: boards.name, emoji: boards.emoji })
		.from(boards)
		.where(isNull(boards.parentCardId))
		.all()
		.filter(b => b.id !== boardId);

	return {
		board,
		breadcrumbs,
		columns: columnsWithCards,
		categories: boardCategories,
		labels: boardLabels,
		linkableBoards
	};
};
