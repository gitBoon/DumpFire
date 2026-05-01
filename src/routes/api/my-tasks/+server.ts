import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, columns, cards, cardAssignees } from '$lib/server/db/schema';
import { eq, inArray, isNull, and } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	const user = locals.user;
	if (!user) return json([], { status: 401 });

	// Get all card IDs assigned to this user
	const assignments = db.select({ cardId: cardAssignees.cardId })
		.from(cardAssignees)
		.where(eq(cardAssignees.userId, user.id))
		.all();

	const cardIds = assignments.map(a => a.cardId);
	if (cardIds.length === 0) return json([]);

	// Get all non-archived assigned cards
	const myCards = db.select().from(cards)
		.where(and(inArray(cards.id, cardIds), isNull(cards.archivedAt)))
		.all();

	// Get all column IDs these cards belong to
	const colIds = [...new Set(myCards.map(c => c.columnId))];
	if (colIds.length === 0) return json([]);

	// Fetch columns with their board IDs and titles
	const cols = db.select({
		id: columns.id,
		title: columns.title,
		boardId: columns.boardId
	}).from(columns).where(inArray(columns.id, colIds)).all();

	// Identify "done" columns
	const doneColIds = new Set(
		cols.filter(c => c.title.toLowerCase() === 'complete' || c.title.toLowerCase() === 'done')
			.map(c => c.id)
	);

	// Filter to only active (non-done) cards
	const activeCards = myCards.filter(c => !doneColIds.has(c.columnId));
	if (activeCards.length === 0) return json([]);

	// Build column lookup: colId -> { title, boardId }
	const colLookup = new Map(cols.map(c => [c.id, { title: c.title, boardId: c.boardId }]));

	// Get all unique board IDs
	const boardIds = [...new Set(cols.map(c => c.boardId))];

	// Fetch boards
	const boardRows = db.select({
		id: boards.id,
		name: boards.name,
		emoji: boards.emoji
	}).from(boards).where(inArray(boards.id, boardIds)).all();

	const boardLookup = new Map(boardRows.map(b => [b.id, b]));

	// Group active cards by board
	const grouped = new Map<number, {
		boardId: number;
		boardName: string;
		boardEmoji: string;
		cards: {
			id: number;
			title: string;
			priority: string;
			dueDate: string | null;
			columnName: string;
			createdAt: string;
		}[];
	}>();

	for (const card of activeCards) {
		const col = colLookup.get(card.columnId);
		if (!col) continue;
		const board = boardLookup.get(col.boardId);
		if (!board) continue;

		if (!grouped.has(board.id)) {
			grouped.set(board.id, {
				boardId: board.id,
				boardName: board.name,
				boardEmoji: board.emoji || '📋',
				cards: []
			});
		}

		grouped.get(board.id)!.cards.push({
			id: card.id,
			title: card.title,
			priority: card.priority,
			dueDate: card.dueDate,
			columnName: col.title,
			createdAt: card.createdAt
		});
	}

	// Sort boards alphabetically, cards by priority weight then creation date
	const priorityWeight: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
	const result = Array.from(grouped.values())
		.sort((a, b) => a.boardName.localeCompare(b.boardName))
		.map(group => ({
			...group,
			cards: group.cards.sort((a, b) => {
				const pw = (priorityWeight[a.priority] ?? 2) - (priorityWeight[b.priority] ?? 2);
				if (pw !== 0) return pw;
				return b.createdAt.localeCompare(a.createdAt);
			})
		}));

	return json(result);
};
