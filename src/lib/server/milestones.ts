/**
 * milestones.ts — milestone CRUD, card assignment and access rules.
 *
 * Shared by the bearer-token API under /api/v1/milestones and the
 * session-cookie API under /api/milestones so there is exactly one
 * implementation of "who may see this goal" and "what happens when it is
 * deleted". Route files are left as thin auth-and-shape wrappers.
 */

import { db } from './db';
import { milestones, cards, columns, boards } from './db/schema';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import { canViewBoard, canEditBoard, getAccessibleBoardIds } from './board-access';
import { isCompleteColumnTitle } from './card-completion';
import { getMilestoneBoardIds } from './planning';
import type { SessionUser } from './auth';

export type MilestoneRow = typeof milestones.$inferSelect;

export interface MilestoneListEntry extends MilestoneRow {
	boardName: string | null;
	cardCount: number;
	doneCount: number;
	/** Boards the milestone's cards actually live on — a goal can span several. */
	boardIds: number[];
}

export class MilestoneError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

function isAdmin(user: SessionUser): boolean {
	return user.role === 'admin' || user.role === 'superadmin';
}

/**
 * May this user read the milestone?
 *
 * Board-scoped: view access to that board. Cross-board (`boardId` null): view
 * access to every board its cards live on — the summary carries card titles
 * from all of them, so partial access must not be enough.
 */
export function canViewMilestone(user: SessionUser, milestone: MilestoneRow): boolean {
	if (isAdmin(user)) return true;
	if (milestone.boardId !== null) return canViewBoard(user, milestone.boardId);

	const touched = getMilestoneBoardIds(milestone.id);
	if (touched.length === 0) return milestone.createdBy === user.id;
	return touched.every((b) => canViewBoard(user, b));
}

/**
 * May this user change the milestone?
 *
 * Board-scoped: edit access to that board. Cross-board: admins and whoever
 * created it — a goal spanning several projects has no single board owner to
 * defer to, and locking it to admins alone would leave the creator unable to
 * rename their own milestone.
 */
export function canEditMilestone(user: SessionUser, milestone: MilestoneRow): boolean {
	if (isAdmin(user)) return true;
	if (milestone.boardId !== null) return canEditBoard(user, milestone.boardId);
	return milestone.createdBy === user.id;
}

/** Load a milestone, or throw the right HTTP status. */
export function requireMilestone(user: SessionUser, milestoneId: number, forEdit = false): MilestoneRow {
	const m = db.select().from(milestones).where(eq(milestones.id, milestoneId)).get();
	if (!m) throw new MilestoneError(404, 'Milestone not found');
	if (!canViewMilestone(user, m)) throw new MilestoneError(403, 'No access to this milestone');
	if (forEdit && !canEditMilestone(user, m)) throw new MilestoneError(403, 'No edit access to this milestone');
	return m;
}

/**
 * How a `boardId` filter should treat cross-board goals.
 *
 * `scoped`   — only milestones whose own boardId matches. This is the v1 API's
 *              long-standing meaning and stays the default.
 * `touching` — also include cross-board goals that have cards on that board.
 *              What the planning view wants: arriving from a board, a goal the
 *              board is half of is exactly the goal being asked about, and
 *              hiding it would make the filter lie.
 */
export type BoardFilterMode = 'scoped' | 'touching';

/**
 * Milestones this user can see, with card counts.
 *
 * Counts are done in two queries over all the milestones at once rather than
 * per milestone — the planning index lists every goal in the workspace.
 */
export function listMilestones(
	user: SessionUser,
	boardId?: number,
	status?: string,
	mode: BoardFilterMode = 'scoped'
): MilestoneListEntry[] {
	const all = db.select().from(milestones).all();

	// In 'touching' mode the board test needs the milestone's cards, which are
	// only counted below — so do it in two stages rather than one filter.
	const touchingIds =
		boardId !== undefined && mode === 'touching'
			? new Set(
					db
						.select({ milestoneId: cards.milestoneId })
						.from(cards)
						.innerJoin(columns, eq(cards.columnId, columns.id))
						.where(and(eq(columns.boardId, boardId), isNull(cards.archivedAt)))
						.all()
						.map((r) => r.milestoneId)
						.filter((id): id is number => id !== null)
				)
			: null;

	const matchesBoard = (m: MilestoneRow) => {
		if (boardId === undefined) return true;
		if (m.boardId === boardId) return true;
		return touchingIds !== null && touchingIds.has(m.id);
	};

	const filtered = all
		.filter(matchesBoard)
		.filter((m) => (status ? m.status === status : true))
		.filter((m) => canViewMilestone(user, m));
	if (filtered.length === 0) return [];

	const ids = filtered.map((m) => m.id);
	const memberRows = db
		.select({ milestoneId: cards.milestoneId, columnTitle: columns.title, boardId: columns.boardId })
		.from(cards)
		.innerJoin(columns, eq(cards.columnId, columns.id))
		.where(and(inArray(cards.milestoneId, ids), isNull(cards.archivedAt)))
		.all();

	const counts = new Map<number, { total: number; done: number; boards: Set<number> }>();
	for (const r of memberRows) {
		if (r.milestoneId === null) continue;
		const entry = counts.get(r.milestoneId) ?? { total: 0, done: 0, boards: new Set<number>() };
		entry.total++;
		if (isCompleteColumnTitle(r.columnTitle)) entry.done++;
		entry.boards.add(r.boardId);
		counts.set(r.milestoneId, entry);
	}

	const boardIds = [...new Set(filtered.map((m) => m.boardId).filter((b): b is number => b !== null))];
	const boardNames = boardIds.length
		? new Map(
				db
					.select({ id: boards.id, name: boards.name })
					.from(boards)
					.where(inArray(boards.id, boardIds))
					.all()
					.map((b) => [b.id, b.name])
			)
		: new Map<number, string>();

	return filtered
		.map((m) => {
			const c = counts.get(m.id) ?? { total: 0, done: 0, boards: new Set<number>() };
			return {
				...m,
				boardName: m.boardId === null ? null : (boardNames.get(m.boardId) ?? null),
				cardCount: c.total,
				doneCount: c.done,
				boardIds: [...c.boards]
			};
		})
		.sort((a, b) => {
			// Open goals first, then by target date (undated last), then newest.
			if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
			if (a.targetDate && b.targetDate) return a.targetDate.localeCompare(b.targetDate);
			if (a.targetDate) return -1;
			if (b.targetDate) return 1;
			return b.id - a.id;
		});
}

export interface CreateMilestoneInput {
	name: string;
	boardId?: number | null;
	description?: string;
	targetDate?: string | null;
}

export function createMilestone(user: SessionUser, input: CreateMilestoneInput): MilestoneRow {
	const name = (input.name ?? '').trim();
	if (!name) throw new MilestoneError(400, 'name is required');
	if (name.length > 200) throw new MilestoneError(400, 'name too long (max 200 chars)');

	const boardId = input.boardId ?? null;
	if (boardId !== null) {
		const board = db.select({ id: boards.id }).from(boards).where(eq(boards.id, boardId)).get();
		if (!board) throw new MilestoneError(404, 'Board not found');
		if (!canEditBoard(user, boardId)) throw new MilestoneError(403, 'No edit access to that board');
	}

	return db
		.insert(milestones)
		.values({
			boardId,
			name,
			description: input.description ?? '',
			targetDate: input.targetDate ?? null,
			createdBy: user.id
		})
		.returning()
		.get();
}

export interface UpdateMilestoneInput {
	name?: string;
	description?: string;
	targetDate?: string | null;
	status?: string;
	boardId?: number | null;
}

export function updateMilestone(user: SessionUser, milestoneId: number, patch: UpdateMilestoneInput): MilestoneRow {
	requireMilestone(user, milestoneId, true);

	const updateData: Record<string, unknown> = {};
	if (patch.name !== undefined) {
		const name = patch.name.trim();
		if (!name) throw new MilestoneError(400, 'name cannot be empty');
		if (name.length > 200) throw new MilestoneError(400, 'name too long (max 200 chars)');
		updateData.name = name;
	}
	if (patch.description !== undefined) updateData.description = patch.description;
	if (patch.targetDate !== undefined) updateData.targetDate = patch.targetDate || null;
	if (patch.status !== undefined) {
		if (!['open', 'closed'].includes(patch.status)) {
			throw new MilestoneError(400, 'status must be open or closed');
		}
		updateData.status = patch.status;
	}
	if (patch.boardId !== undefined) {
		if (patch.boardId !== null && !canEditBoard(user, patch.boardId)) {
			throw new MilestoneError(403, 'No edit access to that board');
		}
		updateData.boardId = patch.boardId;
	}

	if (Object.keys(updateData).length === 0) throw new MilestoneError(400, 'No valid fields to update');
	updateData.updatedAt = new Date().toISOString();

	return db.update(milestones).set(updateData).where(eq(milestones.id, milestoneId)).returning().get();
}

/**
 * Delete a milestone. Its cards are released, never deleted — losing a goal
 * must never lose the work, so the cards go back to having no milestone.
 */
export function deleteMilestone(user: SessionUser, milestoneId: number): { released: number } {
	requireMilestone(user, milestoneId, true);

	const released = db
		.update(cards)
		.set({ milestoneId: null })
		.where(eq(cards.milestoneId, milestoneId))
		.returning()
		.all().length;

	db.delete(milestones).where(eq(milestones.id, milestoneId)).run();
	return { released };
}

/**
 * Put a card in a milestone, or take it out with `milestoneId: null`.
 *
 * Needs edit access to the card's board and to the milestone; a board-scoped
 * milestone will not take a card from another board, because the goal claims to
 * belong to that board and its counts would then be lying.
 */
export function setCardMilestone(user: SessionUser, cardId: number, milestoneId: number | null): { cardId: number; milestoneId: number | null; boardId: number } {
	const card = db.select({ id: cards.id, columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) throw new MilestoneError(404, 'Card not found');

	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) throw new MilestoneError(404, 'Card column not found');
	if (!canEditBoard(user, col.boardId)) throw new MilestoneError(403, 'No edit access to this card\'s board');

	if (milestoneId !== null) {
		const m = requireMilestone(user, milestoneId, true);
		if (m.boardId !== null && m.boardId !== col.boardId) {
			throw new MilestoneError(
				400,
				'That milestone belongs to a single board. Make it cross-board first, or move the card.'
			);
		}
	}

	db.update(cards).set({ milestoneId, updatedAt: new Date().toISOString() }).where(eq(cards.id, cardId)).run();
	return { cardId, milestoneId, boardId: col.boardId };
}

/** Milestones a user may attach a card on this board to. */
export function milestonesForBoard(user: SessionUser, boardId: number): MilestoneRow[] {
	const accessible = getAccessibleBoardIds(user);
	return db
		.select()
		.from(milestones)
		.all()
		.filter((m) => m.boardId === null || m.boardId === boardId)
		.filter((m) => accessible === null || m.boardId === null || accessible.includes(m.boardId))
		.filter((m) => canViewMilestone(user, m))
		.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'open' ? -1 : 1));
}

/**
 * Milestone id → name for a set of cards, for rendering the milestone chip.
 *
 * Deliberately not access-filtered: the caller has already decided which cards
 * the user may see, and a card they can see carries its own milestone id. All
 * this adds is the human-readable name for an id the card already exposes.
 */
export function milestoneNamesForCards(cardIds: number[]): Record<number, string> {
	if (cardIds.length === 0) return {};

	const ids = new Set<number>();
	for (let i = 0; i < cardIds.length; i += 500) {
		for (const r of db
			.select({ milestoneId: cards.milestoneId })
			.from(cards)
			.where(inArray(cards.id, cardIds.slice(i, i + 500)))
			.all()) {
			if (r.milestoneId !== null) ids.add(r.milestoneId);
		}
	}
	if (ids.size === 0) return {};

	const out: Record<number, string> = {};
	for (const m of db.select().from(milestones).where(inArray(milestones.id, [...ids])).all()) {
		out[m.id] = m.name;
	}
	return out;
}
