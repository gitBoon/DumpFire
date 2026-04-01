import { db } from '$lib/server/db';
import { boards, columns, cards, categories, subtasks, labels, cardLabels } from '$lib/server/db/schema';
import { eq, asc, inArray } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const boardId = Number(params.id);

	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) throw error(404, 'Board not found');

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

	// Group cards by column with their subtasks and labels
	const columnsWithCards = boardColumns.map((col) => ({
		...col,
		cards: allCards
			.filter((card) => card.columnId === col.id)
			.map((card) => ({
				...card,
				subtasks: allSubtasks.filter((st) => st.cardId === card.id),
				labelIds: allCardLabels.filter((cl) => cl.cardId === card.id).map((cl) => cl.labelId)
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

	return {
		board,
		columns: columnsWithCards,
		categories: boardCategories,
		labels: boardLabels
	};
};
