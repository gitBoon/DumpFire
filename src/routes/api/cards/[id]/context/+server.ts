/**
 * A card plus the board context its modal needs, in one round trip.
 *
 * The board page gets all of this from its own page payload, but the planning
 * view spans boards — a goal's cards can sit on any of them — so it cannot
 * carry every board's categories, labels and members up front. It asks for the
 * one card it is about to open instead.
 */
import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	cards,
	columns,
	boards,
	subtasks,
	categories,
	labels,
	cardLabels,
	cardAssignees,
	users,
	boardMembers,
	boardTeams,
	teamMembers
} from '$lib/server/db/schema';
import { eq, asc, inArray, isNull, and } from 'drizzle-orm';
import { canViewBoard } from '$lib/server/board-access';
import { milestonesForBoard } from '$lib/server/milestones';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.id);
	if (isNaN(cardId)) throw error(400, 'Invalid card ID');

	const card = db.select().from(cards).where(eq(cards.id, cardId)).get();
	if (!card) throw error(404, 'Card not found');

	const col = db.select().from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) throw error(404, 'Card column not found');

	const boardId = col.boardId;
	if (!canViewBoard(locals.user, boardId)) throw error(403, 'No access to this card\'s board');

	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();

	const cardSubtasks = db
		.select()
		.from(subtasks)
		.where(eq(subtasks.cardId, cardId))
		.orderBy(asc(subtasks.position))
		.all();

	const labelIds = db
		.select({ labelId: cardLabels.labelId })
		.from(cardLabels)
		.where(eq(cardLabels.cardId, cardId))
		.all()
		.map((r) => r.labelId);

	const assignees = db
		.select({ id: users.id, username: users.username, emoji: users.emoji })
		.from(cardAssignees)
		.innerJoin(users, eq(cardAssignees.userId, users.id))
		.where(eq(cardAssignees.cardId, cardId))
		.all()
		.map((a) => ({ ...a, emoji: a.emoji || '👤' }));

	// Sub-boards hanging off this card, with their progress — the modal shows
	// them and the plan view should not silently drop them.
	const subBoards = db.select().from(boards).where(eq(boards.parentCardId, cardId)).all();
	const subBoardsWithProgress = subBoards.map((sb) => {
		const cols = db.select().from(columns).where(eq(columns.boardId, sb.id)).all();
		const colIds = cols.map((c) => c.id);
		const sbCards = colIds.length
			? db
					.select({ columnId: cards.columnId })
					.from(cards)
					.where(and(inArray(cards.columnId, colIds), isNull(cards.archivedAt)))
					.all()
			: [];
		const doneCols = new Set(
			cols.filter((c) => ['complete', 'done'].includes(c.title.toLowerCase())).map((c) => c.id)
		);
		return {
			id: sb.id,
			name: sb.name,
			emoji: sb.emoji || '📋',
			total: sbCards.length,
			done: sbCards.filter((c) => doneCols.has(c.columnId)).length
		};
	});

	// ── Board context for the pickers ────────────────────────────────────────

	const boardCategories = db.select().from(categories).orderBy(asc(categories.name)).all();
	const boardLabels = db.select().from(labels).where(eq(labels.boardId, boardId)).all();

	// Who can be assigned: creator, direct members, members of shared teams, and
	// every admin (who can reach any board).
	const userIds = new Set<number>();
	if (board?.createdBy) userIds.add(board.createdBy);
	for (const m of db.select({ userId: boardMembers.userId }).from(boardMembers).where(eq(boardMembers.boardId, boardId)).all()) {
		userIds.add(m.userId);
	}
	const sharedTeams = db.select({ teamId: boardTeams.teamId }).from(boardTeams).where(eq(boardTeams.boardId, boardId)).all();
	if (sharedTeams.length > 0) {
		for (const r of db
			.select({ userId: teamMembers.userId })
			.from(teamMembers)
			.where(inArray(teamMembers.teamId, sharedTeams.map((t) => t.teamId)))
			.all()) {
			userIds.add(r.userId);
		}
	}
	for (const a of db.select({ id: users.id }).from(users).where(inArray(users.role, ['admin', 'superadmin'])).all()) {
		userIds.add(a.id);
	}
	const boardUsers = userIds.size
		? db
				.select({ id: users.id, username: users.username, email: users.email, emoji: users.emoji })
				.from(users)
				.where(inArray(users.id, [...userIds]))
				.all()
				.map((u) => ({ ...u, emoji: u.emoji || '👤' }))
		: [];

	return json({
		card: {
			...card,
			subtasks: cardSubtasks,
			labelIds,
			assignees,
			subBoards: subBoardsWithProgress
		},
		boardId,
		boardName: board?.name ?? 'Unknown board',
		columnTitle: col.title,
		categories: boardCategories,
		labels: boardLabels,
		boardUsers,
		milestones: milestonesForBoard(locals.user, boardId)
	});
};
