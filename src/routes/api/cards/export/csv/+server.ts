import { db } from '$lib/server/db';
import { boards, columns, cards, categories, labels, cardLabels, cardAssignees, users, subtasks, boardMembers, boardTeams, teamMembers } from '$lib/server/db/schema';
import { eq, and, isNull, inArray, asc } from 'drizzle-orm';
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

/** GET — Export all cards across all accessible boards as CSV */
export const GET: RequestHandler = async ({ locals, url }) => {
	const user = locals.user!;
	const isAdmin = user.role === 'admin' || user.role === 'superadmin';
	const boardFilterParam = url.searchParams.get('boardId');

	// Get accessible boards
	let accessibleBoardIds: number[];
	if (isAdmin) {
		accessibleBoardIds = db.select({ id: boards.id }).from(boards).all().map(b => b.id);
	} else {
		const ids = new Set<number>();
		// Direct board membership
		db.select({ boardId: boardMembers.boardId })
			.from(boardMembers)
			.where(eq(boardMembers.userId, user.id))
			.all()
			.forEach(m => ids.add(m.boardId));
		// Team-based access
		const userTeams = db.select({ teamId: teamMembers.teamId })
			.from(teamMembers)
			.where(eq(teamMembers.userId, user.id))
			.all();
		if (userTeams.length > 0) {
			db.select({ boardId: boardTeams.boardId })
				.from(boardTeams)
				.where(inArray(boardTeams.teamId, userTeams.map(t => t.teamId)))
				.all()
				.forEach(m => ids.add(m.boardId));
		}
		// Boards created by user
		db.select({ id: boards.id })
			.from(boards)
			.where(eq(boards.createdBy, user.id))
			.all()
			.forEach(b => ids.add(b.id));
		// Public boards
		db.select({ id: boards.id })
			.from(boards)
			.where(eq(boards.isPublic, true))
			.all()
			.forEach(b => ids.add(b.id));
		accessibleBoardIds = Array.from(ids);
	}

	// Apply board filter if provided
	if (boardFilterParam) {
		const filterId = Number(boardFilterParam);
		if (accessibleBoardIds.includes(filterId)) {
			accessibleBoardIds = [filterId];
		} else {
			return new Response('Board,Title,Description,Priority,Column,Assignees,Due Date,Created,Completed,Labels,Category,Subtasks\n', {
				headers: {
					'Content-Type': 'text/csv; charset=utf-8',
					'Content-Disposition': `attachment; filename="dumpfire-export.csv"`
				}
			});
		}
	}

	if (accessibleBoardIds.length === 0) {
		return new Response('Board,Title,Description,Priority,Column,Assignees,Due Date,Created,Completed,Labels,Category,Subtasks\n', {
			headers: {
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': `attachment; filename="dumpfire-export.csv"`
			}
		});
	}

	// Get all boards
	const allBoards = db.select().from(boards).where(inArray(boards.id, accessibleBoardIds)).all();
	const boardMap = new Map(allBoards.map(b => [b.id, b.name]));

	// Get all columns
	const allCols = db.select().from(columns)
		.where(inArray(columns.boardId, accessibleBoardIds))
		.orderBy(asc(columns.position))
		.all();
	const colIds = allCols.map(c => c.id);
	const colMap = new Map(allCols.map(c => [c.id, c.title]));
	const colBoardMap = new Map(allCols.map(c => [c.id, c.boardId]));

	if (colIds.length === 0) {
		return new Response('Board,Title,Description,Priority,Column,Assignees,Due Date,Created,Completed,Labels,Category,Subtasks\n', {
			headers: {
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': `attachment; filename="dumpfire-export.csv"`
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

	// Get all labels
	const allLabels = db.select().from(labels)
		.where(inArray(labels.boardId, accessibleBoardIds))
		.all();
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
	const header = 'Board,Title,Description,Priority,Column,Assignees,Due Date,Created,Completed,Labels,Category,Subtasks';
	const rows = allCards.map(card => {
		const boardId = colBoardMap.get(card.columnId) || 0;
		const boardName = boardMap.get(boardId) || '';
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
			csvEscape(boardName),
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

	return new Response(csv, {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="dumpfire-all-tasks-${new Date().toISOString().slice(0, 10)}.csv"`
		}
	});
};
