/**
 * /api/graph — Graph data endpoint for the Contextual Graph View.
 *
 * Returns workspace relationship data as { nodes, edges } for the
 * force-directed graph visualization. Supports three modes:
 *
 * 1. **Overview mode** (no params): All accessible boards + their users.
 *
 * 2. **Board expand** (?boardId=N): Columns of that board only.
 *    Keeps the graph clean — cards load on the next click.
 *
 * 3. **Column expand** (?columnId=N): Cards in that column + their
 *    assignees, sub-boards, and dependencies.
 *
 * All queries are bounded. Hard limit: max 500 nodes per request.
 *
 * Each mode answers only with what the caller can view: the overview lists
 * the boards they can open, a board or a column is expanded for a caller who
 * can view the board it is on, and a card's sub-board is listed only where
 * the caller can view that sub-board too. A dependency is drawn only where
 * the caller can view the board of the card that is waited on as well.
 */
import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	boards, columns, cards, cardAssignees, workDependencies,
	users, boardMembers
} from '$lib/server/db/schema';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { canViewBoard, getAccessibleBoardIds, type Actor } from '$lib/server/board-access';
import { requireBoard, requireColumn } from '$lib/server/route-guards';
import { readQueryId } from '$lib/server/request-body';
import { getCardBoardId } from '$lib/server/work-access';
import type { GraphNode, GraphEdge } from '$lib/types/graph-types';
import type { RequestHandler } from './$types';

/** Hard cap on nodes to prevent runaway responses. */
const MAX_NODES = 500;

// ─── Overview: all accessible boards + their members ─────────────────────────

function buildOverview(accessibleIds: number[] | null): { nodes: GraphNode[]; edges: GraphEdge[] } {
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	const seenUsers = new Set<number>();

	// Fetch all accessible boards (exclude sub-boards — they appear via card expansion)
	let allBoards;
	if (accessibleIds === null) {
		allBoards = db.select().from(boards).where(isNull(boards.parentCardId)).all();
	} else if (accessibleIds.length === 0) {
		return { nodes, edges };
	} else {
		allBoards = db.select().from(boards)
			.where(and(inArray(boards.id, accessibleIds), isNull(boards.parentCardId)))
			.all();
	}

	for (const board of allBoards) {
		if (nodes.length >= MAX_NODES) break;

		nodes.push({
			id: `board:${board.id}`,
			type: 'board',
			label: board.name,
			emoji: board.emoji || '📋',
			meta: { isPublic: board.isPublic, categoryId: board.categoryId }
		});

		// Board members (direct)
		const members = db.select({ userId: boardMembers.userId })
			.from(boardMembers)
			.where(eq(boardMembers.boardId, board.id))
			.all();

		for (const m of members) {
			if (!seenUsers.has(m.userId)) {
				const user = db.select().from(users).where(eq(users.id, m.userId)).get();
				if (user && nodes.length < MAX_NODES) {
					nodes.push({
						id: `user:${user.id}`,
						type: 'user',
						label: user.username,
						emoji: user.emoji || '👤',
						meta: { role: user.role }
					});
					seenUsers.add(user.id);
				}
			}
			edges.push({
				source: `user:${m.userId}`,
				target: `board:${board.id}`,
				relation: 'member_of'
			});
		}

		// Board creator
		if (board.createdBy && !seenUsers.has(board.createdBy)) {
			const creator = db.select().from(users).where(eq(users.id, board.createdBy)).get();
			if (creator && nodes.length < MAX_NODES) {
				nodes.push({
					id: `user:${creator.id}`,
					type: 'user',
					label: creator.username,
					emoji: creator.emoji || '👤',
					meta: { role: creator.role }
				});
				seenUsers.add(creator.id);
			}
			edges.push({
				source: `user:${board.createdBy}`,
				target: `board:${board.id}`,
				relation: 'created'
			});
		}
	}

	// ─── Admins: implicit members of ALL boards ──────────────────────────
	// The superadmin is one of them (card 2117): it was left out, and drawn
	// with fewer boards than any administrator.
	const adminUsers = db.select().from(users)
		.where(inArray(users.role, ['admin', 'superadmin']))
		.all();

	const boardIds = allBoards.map(b => `board:${b.id}`);

	for (const admin of adminUsers) {
		// Add admin user node if not already present
		if (!seenUsers.has(admin.id) && nodes.length < MAX_NODES) {
			nodes.push({
				id: `user:${admin.id}`,
				type: 'user',
				label: admin.username,
				emoji: admin.emoji || '👤',
				meta: { role: admin.role }
			});
			seenUsers.add(admin.id);
		}

		// Connect admin to every board
		for (const boardNodeId of boardIds) {
			edges.push({
				source: `user:${admin.id}`,
				target: boardNodeId,
				relation: 'admin_of'
			});
		}
	}

	return { nodes, edges };
}

// ─── Board Expand: columns only (lightweight) ────────────────────────────────

function buildBoardExpansion(boardId: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];

	const boardColumns = db.select().from(columns)
		.where(eq(columns.boardId, boardId))
		.all();

	for (const col of boardColumns) {
		if (nodes.length >= MAX_NODES) break;

		// Count cards in this column for the label
		const cardCount = db.select().from(cards)
			.where(and(eq(cards.columnId, col.id), isNull(cards.archivedAt)))
			.all().length;

		nodes.push({
			id: `column:${col.id}`,
			type: 'column',
			label: col.title,
			meta: { color: col.color, position: col.position, cardCount }
		});
		edges.push({
			source: `board:${boardId}`,
			target: `column:${col.id}`,
			relation: 'contains'
		});
	}

	return { nodes, edges };
}

// ─── Column Expand: cards + assignees + sub-boards + dependencies ────────────

function buildColumnExpansion(columnId: number, user: Actor): { nodes: GraphNode[]; edges: GraphEdge[] } {
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	const seenUsers = new Set<number>();

	// Cards in this column (exclude archived)
	const colCards = db.select().from(cards)
		.where(and(eq(cards.columnId, columnId), isNull(cards.archivedAt)))
		.all();

	for (const card of colCards) {
		if (nodes.length >= MAX_NODES) break;

		nodes.push({
			id: `card:${card.id}`,
			type: 'card',
			label: card.title,
			meta: {
				priority: card.priority,
				completedAt: card.completedAt,
				dueDate: card.dueDate
			}
		});
		edges.push({
			source: `column:${columnId}`,
			target: `card:${card.id}`,
			relation: 'contains'
		});

		// Card assignees
		const assignees = db.select({ userId: cardAssignees.userId })
			.from(cardAssignees)
			.where(eq(cardAssignees.cardId, card.id))
			.all();

		for (const a of assignees) {
			if (!seenUsers.has(a.userId)) {
				const user = db.select().from(users).where(eq(users.id, a.userId)).get();
				if (user && nodes.length < MAX_NODES) {
					nodes.push({
						id: `user:${user.id}`,
						type: 'user',
						label: user.username,
						emoji: user.emoji || '👤'
					});
					seenUsers.add(user.id);
				}
			}
			edges.push({
				source: `user:${a.userId}`,
				target: `card:${card.id}`,
				relation: 'assigned_to'
			});
		}

		// Sub-boards linked to this card. A sub-board is a board of its own,
		// shared with whoever it is shared with: being able to open the card's
		// board does not open it, so one the caller cannot view is not named.
		const subBoards = db.select().from(boards)
			.where(eq(boards.parentCardId, card.id))
			.all()
			.filter((sb) => canViewBoard(user, sb.id));

		for (const sb of subBoards) {
			if (nodes.length >= MAX_NODES) break;
			nodes.push({
				id: `board:${sb.id}`,
				type: 'board',
				label: sb.name,
				emoji: sb.emoji || '📋',
				meta: { isSubBoard: true }
			});
			edges.push({
				source: `card:${card.id}`,
				target: `board:${sb.id}`,
				relation: 'sub_board'
			});
		}

		// Card dependencies: the cards this card waits on, from the table the
		// dependency routes write. These used to be read from
		// `card_dependencies`, which nothing has written since migration 0043,
		// so a link made since was never drawn and one removed since still was.
		//
		// Card to card only. The graph has no node for a subtask, so a link
		// with a subtask at either end is not drawn.
		const deps = db.select({ blockerId: workDependencies.blockerId })
			.from(workDependencies)
			.where(and(
				eq(workDependencies.blockedType, 'card'),
				eq(workDependencies.blockedId, card.id),
				eq(workDependencies.blockerType, 'card')
			))
			.all();

		for (const dep of deps) {
			// A link may reach a card of another board. One on a board the
			// caller cannot view is not drawn: its id would say that this card
			// waits on something there, and which card it is. Nor is one whose
			// card is gone.
			const blockerBoardId = getCardBoardId(dep.blockerId);
			if (blockerBoardId === null || !canViewBoard(user, blockerBoardId)) continue;

			edges.push({
				source: `card:${card.id}`,
				target: `card:${dep.blockerId}`,
				relation: 'depends_on'
			});
		}
	}

	return { nodes, edges };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardIdParam = url.searchParams.get('boardId');
	const columnIdParam = url.searchParams.get('columnId');

	// Each id is read as an id in the path is (card 2117): `parseInt` read
	// `2.5` as 2 and `5abc` as 5.
	const columnId = readQueryId(columnIdParam, 'column', 'Invalid columnId');
	if (columnId !== undefined) {
		// Column expand — return cards + assignees + sub-boards
		// The column says which board this is: the caller is judged against the
		// board the column is on, whatever boardId came with it. This used to
		// answer anyone signed in with the cards of any column.
		requireColumn(locals.user, columnId, 'view');
		return json(buildColumnExpansion(columnId, locals.user));
	}

	const boardId = readQueryId(boardIdParam, 'board', 'Invalid boardId');
	if (boardId !== undefined) {
		// Board expand — return columns only
		// As above: this used to answer anyone signed in with any board's columns.
		requireBoard(locals.user, boardId, 'view');
		return json(buildBoardExpansion(boardId));
	}

	// Overview — all accessible boards + users
	const accessibleIds = getAccessibleBoardIds(locals.user);
	return json(buildOverview(accessibleIds));
};
