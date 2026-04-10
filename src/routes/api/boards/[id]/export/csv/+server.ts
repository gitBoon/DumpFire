import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, columns, cards, categories, labels, cardLabels, cardAssignees, users, subtasks } from '$lib/server/db/schema';
import { eq, and, isNull, inArray, asc } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/** Escape a value for CSV: wrap in quotes if it contains commas, quotes, or newlines. */
function csvEscape(val: string | null | undefined): string {
	if (val == null) return '';
	const str = String(val);
	if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
		return '"' + str.replace(/"/g, '""') + '"';
	}
	return str;
}

/** GET — Export all cards from a board as CSV */
export const GET: RequestHandler = async ({ params, locals }) => {
	const boardId = Number(params.id);
	const user = locals.user!;

	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) throw error(404, 'Board not found');

	const role = getBoardRole(user, boardId);
	if (!role) throw error(403, 'No access to this board');

	// Get columns
	const boardCols = db.select().from(columns)
		.where(eq(columns.boardId, boardId))
		.orderBy(asc(columns.position))
		.all();
	const colIds = boardCols.map(c => c.id);
	const colMap = new Map(boardCols.map(c => [c.id, c.title]));

	if (colIds.length === 0) {
		return new Response('Title,Description,Priority,Column,Assignees,Due Date,Created,Completed,Labels,Category,Subtasks\n', {
			headers: {
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': `attachment; filename="${board.name}-export.csv"`
			}
		});
	}

	// Get all active cards
	const allCards = db.select().from(cards)
		.where(and(inArray(cards.columnId, colIds), isNull(cards.archivedAt)))
		.orderBy(asc(cards.position))
		.all();

	const cardIds = allCards.map(c => c.id);

	// Get categories
	const allCategories = db.select().from(categories).all();
	const catMap = new Map(allCategories.map(c => [c.id, c.name]));

	// Get labels
	const allLabels = db.select().from(labels).where(eq(labels.boardId, boardId)).all();
	const labelMap = new Map(allLabels.map(l => [l.id, l.name]));

	const allCardLabels = cardIds.length > 0
		? db.select().from(cardLabels).where(inArray(cardLabels.cardId, cardIds)).all()
		: [];

	// Get assignees
	const allAssignees = cardIds.length > 0
		? db.select({ cardId: cardAssignees.cardId, username: users.username })
			.from(cardAssignees)
			.innerJoin(users, eq(cardAssignees.userId, users.id))
			.where(inArray(cardAssignees.cardId, cardIds))
			.all()
		: [];

	// Get subtasks
	const allSubtasks = cardIds.length > 0
		? db.select().from(subtasks).where(inArray(subtasks.cardId, cardIds)).all()
		: [];

	// Build CSV
	const header = 'Title,Description,Priority,Column,Assignees,Due Date,Created,Completed,Labels,Category,Subtasks';
	const rows = allCards.map(card => {
		const columnName = colMap.get(card.columnId) || '';
		const categoryName = card.categoryId ? (catMap.get(card.categoryId) || '') : '';
		const cardLabelNames = allCardLabels
			.filter(cl => cl.cardId === card.id)
			.map(cl => labelMap.get(cl.labelId) || '')
			.filter(Boolean)
			.join('; ');
		const assigneeNames = allAssignees
			.filter(a => a.cardId === card.id)
			.map(a => a.username)
			.join('; ');
		const cardSubtasks = allSubtasks
			.filter(s => s.cardId === card.id)
			.map(s => `${s.completed ? '✓' : '○'} ${s.title}`)
			.join('; ');

		return [
			csvEscape(card.title),
			csvEscape(card.description),
			csvEscape(card.priority),
			csvEscape(columnName),
			csvEscape(assigneeNames),
			csvEscape(card.dueDate),
			csvEscape(card.createdAt),
			csvEscape(card.completedAt),
			csvEscape(cardLabelNames),
			csvEscape(categoryName),
			csvEscape(cardSubtasks)
		].join(',');
	});

	const csv = header + '\n' + rows.join('\n') + '\n';
	const safeName = board.name.replace(/[^a-zA-Z0-9-_]/g, '_');

	return new Response(csv, {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="${safeName}-${new Date().toISOString().slice(0, 10)}.csv"`
		}
	});
};
