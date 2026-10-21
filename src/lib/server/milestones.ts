/**
 * milestones.ts — milestone CRUD, card assignment and access rules.
 *
 * Shared by the bearer-token API under /api/v1/milestones and the
 * session-cookie API under /api/milestones so there is exactly one
 * implementation of "who may see this goal" and "what happens when it is
 * deleted". Route files are left as thin auth-and-shape wrappers.
 *
 * A goal's changes are recorded (card 2289): a card put in or taken out here,
 * on every route, and a change to the goal itself by `milestone-service.ts`,
 * with `goalBoards` and `goalAsNamedOn` from here. A change that changes
 * nothing writes nothing, and is found only after every refusal, so a request
 * that would be refused still is (decision 8).
 */

import { db } from './db';
import { inTransaction } from './db/transaction';
import { milestones, cards, columns, boards } from './db/schema';
import { eq, and, isNull, inArray, ne } from 'drizzle-orm';
import { canViewBoard, canEditBoard, getAccessibleBoardIds, type Actor } from './board-access';
import { isCompleteColumnTitle } from './card-completion';
import { changedFields } from './card-changes';
import { ACTIONS, actorOf, logActivity, type ActivitySource } from './logActivity';
import { boardsOpenTo, getMilestoneBoardIds } from './planning';
import type { SessionUser } from './auth';
import { stamp } from '$lib/timestamps';

export type MilestoneRow = typeof milestones.$inferSelect;

export interface MilestoneListEntry extends MilestoneRow {
	boardName: string | null;
	cardCount: number;
	doneCount: number;
	/**
	 * Boards the milestone's cards actually live on that the caller can open —
	 * a goal can span several. A card on a board they cannot open is still
	 * counted, and has no id here: the read of one lists it withheld, with no
	 * board (card 2206).
	 */
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

function isAdmin(user: Pick<SessionUser, 'role'>): boolean {
	return user.role === 'admin' || user.role === 'superadmin';
}

/**
 * May this user read the milestone?
 *
 * Board-scoped: view access to that board. Cross-board (`boardId` null): view
 * access to every board its cards live on — the summary carries card titles
 * from all of them, so partial access must not be enough. Asked of a signed-in
 * caller, and of each recipient of the plan-created mail (card 2152), so it
 * takes only who they are and their role.
 */
export function canViewMilestone(user: Actor, milestone: MilestoneRow): boolean {
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

/**
 * The boards a goal's entries go on (card 2289, decision 6): its own board,
 * or for a goal across boards each board that holds one of its cards,
 * archived ones included. A goal across boards with no cards has none, as
 * `milestone_created` writes nothing for a goal of no board.
 */
export function goalBoards(goal: Pick<MilestoneRow, 'id' | 'boardId'>): number[] {
	return goal.boardId !== null ? [goal.boardId] : getMilestoneBoardIds(goal.id);
}

/**
 * A goal as an entry on `boardId`'s log names it (card 2289, decision 7): by
 * its name when it belongs to that board, and otherwise `milestone #<id>`. A
 * board's log is read by every viewer of the board, and a goal across boards
 * is opened only by someone who can open every board its cards are on, so its
 * name is given to none of them (card 2257). `goal` is the goal as that
 * board's readers knew it: before the change on a board it stays on or
 * leaves, after it on a board it joins.
 */
export function goalAsNamedOn(goal: Pick<MilestoneRow, 'id' | 'name' | 'boardId'>, boardId: number): string {
	return goal.boardId === boardId ? `milestone "${goal.name}"` : `milestone #${goal.id}`;
}

/** Who records a card put in a goal or taken out, and the title to name it by when not the one stored. */
export type CardInOrOutRecord = { source: ActivitySource; title?: string };

/**
 * The entry for a card put in a goal (`attach`) or taken out (card 2289,
 * decision 6): on the card's board, with its id, `Added "<card>" to milestone
 * "<goal>"` or `Removed "<card>" from …`. A card put in that left another goal
 * says which, `(from milestone …)`, named by the same rule, and no entry is
 * written for the goal it left. The bulk routes write theirs here too. The
 * entry sends `milestone.card_added` or `milestone.card_removed` to the card's
 * board's webhooks once the write commits (card 2343).
 */
export function logCardInOrOut(
	user: SessionUser,
	source: ActivitySource,
	card: { boardId: number; cardId: number; title: string },
	goal: MilestoneRow,
	attach: boolean,
	left: MilestoneRow | null = null
): void {
	const named = goalAsNamedOn(goal, card.boardId);
	const from = left ? ` (from ${goalAsNamedOn(left, card.boardId)})` : '';
	logActivity({
		boardId: card.boardId,
		cardId: card.cardId,
		action: attach ? ACTIONS.milestoneCardAdded : ACTIONS.milestoneCardRemoved,
		detail: attach ? `Added "${card.title}" to ${named}${from}` : `Removed "${card.title}" from ${named}`,
		source,
		...actorOf(user)
	});
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
	const opens = boardsOpenTo(user);
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
				boardIds: [...c.boards].filter(opens)
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

/**
 * The board a new milestone is to belong to, if it is there and the caller
 * may edit it. A route that reads its body field by field asks this first,
 * as the milestone's guard, and reads the other fields after it.
 */
export function requireMilestoneBoard(user: SessionUser, boardId: number): void {
	const board = db.select({ id: boards.id }).from(boards).where(eq(boards.id, boardId)).get();
	if (!board) throw new MilestoneError(404, 'Board not found');
	if (!canEditBoard(user, boardId)) throw new MilestoneError(403, 'No edit access to that board');
}

export function createMilestone(user: SessionUser, input: CreateMilestoneInput): MilestoneRow {
	const name = (input.name ?? '').trim();
	if (!name) throw new MilestoneError(400, 'name is required');
	if (name.length > 200) throw new MilestoneError(400, 'name must be at most 200 characters');

	const boardId = input.boardId ?? null;
	if (boardId !== null) requireMilestoneBoard(user, boardId);

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

/**
 * What a caller is told who gives a milestone to a board while a card in it is
 * on another (card 2179). No count and no board's name: the caller may not be
 * able to open the boards those cards are on. Taking the cards out comes first,
 * and the cost of the other way is said: a cross-board milestone can then be
 * changed only by its creator or an administrator (`canEditMilestone`), so the
 * board's other editors lose it (review of card 2179).
 */
const CARDS_ON_ANOTHER_BOARD =
	'Some cards in this milestone are not on that board (archived cards count too). ' +
	'Take those cards out of it first, or make the milestone cross-board instead; ' +
	'only its creator or an administrator can change a cross-board milestone afterwards.';

/**
 * Change a milestone.
 *
 * A `boardId` that is sent, not null and not the milestone's own gives the
 * milestone to that board. The board must be there (404) and the caller able
 * to edit it (403), and then every card in the milestone, archived ones
 * included, must be on it (400, card 2179). Otherwise everyone who can open
 * the new board would read the titles of the other boards' cards in the goal:
 * a milestone of a board is opened by whoever can open that board. An archived
 * card counts because restoring it keeps its milestone. Null, a goal across
 * boards, is always accepted.
 *
 * One transaction: the milestone and its cards are read in the one that
 * writes, so what was checked is what is written.
 *
 * Only what differs from the milestone is written (card 2183's rule, card
 * 2289 decision 8), and that is asked after every check above: a patch whose
 * every field is as stored writes nothing and answers the milestone as it is,
 * and one that would be refused is still refused. The answer says what it was
 * before and which fields changed, in the order read, for the entries.
 */
export function updateMilestone(user: SessionUser, milestoneId: number, patch: UpdateMilestoneInput): MilestoneChange {
	return inTransaction(() => {
		const was = requireMilestone(user, milestoneId, true);
		const changed = changedFields(was, fieldsToUpdate(user, was, patch));
		const names = Object.keys(changed);
		if (names.length === 0) return { milestone: was, was, changed: [] };
		const milestone = db
			.update(milestones)
			.set({ ...changed, updatedAt: stamp() })
			.where(eq(milestones.id, milestoneId))
			.returning()
			.get();
		return { milestone, was, changed: names };
	});
}

/** A milestone changed: as it is now, as it was, and the fields that changed (none when nothing did). */
export type MilestoneChange = { milestone: MilestoneRow; was: MilestoneRow; changed: string[] };

/** `updateMilestone`'s checks, in order: each field, then the board. What to write. */
function fieldsToUpdate(user: SessionUser, milestone: MilestoneRow, patch: UpdateMilestoneInput): Record<string, unknown> {
	const updateData: Record<string, unknown> = {};
	if (patch.name !== undefined) {
		const name = patch.name.trim();
		if (!name) throw new MilestoneError(400, 'name cannot be empty');
		if (name.length > 200) throw new MilestoneError(400, 'name must be at most 200 characters');
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
		// Both routes read it as a whole number or null, so the milestone's own
		// board sent back compares equal and is no change.
		const boardId = patch.boardId;
		if (boardId !== null && boardId !== milestone.boardId) {
			requireMilestoneBoard(user, boardId);
			const elsewhere = db
				.select({ id: cards.id })
				.from(cards)
				.innerJoin(columns, eq(cards.columnId, columns.id))
				.where(and(eq(cards.milestoneId, milestone.id), ne(columns.boardId, boardId)))
				.limit(1)
				.get();
			if (elsewhere) throw new MilestoneError(400, CARDS_ON_ANOTHER_BOARD);
		}
		updateData.boardId = boardId;
	}

	if (Object.keys(updateData).length === 0) throw new MilestoneError(400, 'No valid fields to update');
	return updateData;
}

/**
 * Delete a milestone. Its cards are released, never deleted — losing a goal
 * must never lose the work, so the cards go back to having no milestone.
 *
 * One transaction: the milestone is checked, its cards are released and it is
 * deleted together. A failure between the two writes used to leave the
 * milestone in place with every card taken out of it.
 *
 * The answer also holds, for the entries (card 2289), the milestone as it
 * was, its boards (`goalBoards`, read before its cards are released), and
 * how many cards of each board were released, archived ones included.
 */
export function deleteMilestone(
	user: SessionUser,
	milestoneId: number
): { released: number; milestone: MilestoneRow; boards: number[]; releasedOn: Map<number, number> } {
	return inTransaction(() => {
		const milestone = requireMilestone(user, milestoneId, true);
		const boards = goalBoards(milestone);
		const releasedOn = new Map<number, number>();
		for (const { boardId } of db
			.select({ boardId: columns.boardId })
			.from(cards)
			.innerJoin(columns, eq(cards.columnId, columns.id))
			.where(eq(cards.milestoneId, milestoneId))
			.all()) {
			releasedOn.set(boardId, (releasedOn.get(boardId) ?? 0) + 1);
		}

		const released = db
			.update(cards)
			.set({ milestoneId: null })
			.where(eq(cards.milestoneId, milestoneId))
			.returning()
			.all().length;

		db.delete(milestones).where(eq(milestones.id, milestoneId)).run();
		return { released, milestone, boards, releasedOn };
	});
}

/**
 * What a caller is told who puts an archived card in a milestone: the words
 * the batch (`POST /api/v1/milestones/:id/cards/bulk`) reports one in.
 */
export const ARCHIVED_CARD = 'Card does not exist or is archived';

/** The card, and the board it is on, if the caller may edit that board. */
function editableCard(user: SessionUser, cardId: number) {
	const card = db
		.select({ id: cards.id, title: cards.title, columnId: cards.columnId, milestoneId: cards.milestoneId, archivedAt: cards.archivedAt })
		.from(cards)
		.where(eq(cards.id, cardId))
		.get();
	if (!card) throw new MilestoneError(404, 'Card not found');

	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) throw new MilestoneError(404, 'Card column not found');
	if (!canEditBoard(user, col.boardId)) throw new MilestoneError(403, 'No edit access to this card\'s board');
	return { card, boardId: col.boardId };
}

/**
 * Put a card in a milestone. Taking one out is `takeCardOutOfMilestone`.
 *
 * Needs edit access to the card's board and to the milestone; a board-scoped
 * milestone will not take a card from another board, because the goal claims to
 * belong to that board and its counts would then be lying. An archived card is
 * refused, as the batch refuses one: it counts towards no goal.
 *
 * A card already in another milestone leaves it, so the caller needs edit
 * access to that one too, first: R5's removal rule. Without it, a card was
 * taken out of a goal its maker or an administrator alone may change by
 * putting it in another goal, and then in none.
 *
 * One transaction: the card and the milestone are read in the one that
 * writes, so what was checked is what is written.
 *
 * The card put in is recorded, `milestone_card_added` from `record.source`
 * (card 2289, `logCardInOrOut`). A card already in this milestone is answered
 * as it is, with nothing written or recorded, and `written` false: asked after
 * every refusal above, so an archived card already in it is still refused.
 */
export function setCardMilestone(
	user: SessionUser,
	cardId: number,
	milestoneId: number,
	record: CardInOrOutRecord
): { cardId: number; milestoneId: number; boardId: number; written: boolean } {
	return inTransaction(() => {
		const { card, boardId } = editableCard(user, cardId);

		const left = card.milestoneId !== null && card.milestoneId !== milestoneId ? requireMilestone(user, card.milestoneId, true) : null;
		const m = requireMilestone(user, milestoneId, true);
		if (card.archivedAt !== null) throw new MilestoneError(400, ARCHIVED_CARD);
		if (m.boardId !== null && m.boardId !== boardId) {
			throw new MilestoneError(
				400,
				'That milestone belongs to a single board. Make it cross-board first, or move the card.'
			);
		}
		if (card.milestoneId === milestoneId) return { cardId, milestoneId, boardId, written: false };

		db.update(cards).set({ milestoneId, updatedAt: stamp() }).where(eq(cards.id, cardId)).run();
		logCardInOrOut(user, record.source, { boardId, cardId, title: record.title ?? card.title }, m, true, left);
		return { cardId, milestoneId, boardId, written: true };
	});
}

/**
 * Take a card out of its milestone. The one rule for every route that does
 * (card 2117, R5): `DELETE /api/v1/milestones/:id/cards`, `milestoneId: null`
 * on `PUT /api/v1/cards/:id`, the session route's `attach: false`, and the
 * batch, which asks the same of each card. Putting a card in another
 * milestone takes it out of this one, and `setCardMilestone` and the batch
 * attach ask the same of the milestone it leaves.
 *
 * The caller needs edit access to the card's board and to the milestone the
 * card is in: someone who may edit a board, and neither made a cross-board
 * goal nor is an administrator, could not put a card in that goal and cannot
 * take one out of it. Where the route names a milestone (`named`), it must be
 * there and the caller able to change it (404, 403), and the card must be in
 * it: `404 Card is not in this milestone`. Taking a card out through another
 * milestone's id took it out of its own.
 *
 * One transaction: the card's milestone is read in the one that clears it.
 *
 * The card taken out is recorded, `milestone_card_removed` from
 * `record.source` (card 2289). A card in no milestone, with none named, is
 * answered as it is with nothing written, and `written` false.
 */
export function takeCardOutOfMilestone(
	user: SessionUser,
	cardId: number,
	record: CardInOrOutRecord,
	named?: number
): { cardId: number; milestoneId: null; boardId: number; written: boolean } {
	return inTransaction(() => {
		if (named !== undefined) requireMilestone(user, named, true);
		const { card, boardId } = editableCard(user, cardId);

		if (named !== undefined && card.milestoneId !== named) throw new MilestoneError(404, 'Card is not in this milestone');
		const left = card.milestoneId !== null ? requireMilestone(user, card.milestoneId, true) : null;
		if (left === null) return { cardId, milestoneId: null, boardId, written: false };

		db.update(cards).set({ milestoneId: null, updatedAt: stamp() }).where(eq(cards.id, cardId)).run();
		logCardInOrOut(user, record.source, { boardId, cardId, title: record.title ?? card.title }, left, false);
		return { cardId, milestoneId: null, boardId, written: true };
	});
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

/** The milestones of `ids` that `user` may open (`canViewMilestone`). */
function milestonesOpenTo(user: Actor, ids: number[]): MilestoneRow[] {
	if (ids.length === 0) return [];
	return db
		.select()
		.from(milestones)
		.where(inArray(milestones.id, ids))
		.all()
		.filter((m) => canViewMilestone(user, m));
}

/**
 * Of these milestone ids, the ones `user` may open, for a reader that names a
 * card's milestone from its own query (the activity report, card 2257).
 */
export function milestoneIdsOpenTo(user: Actor, ids: Iterable<number>): Set<number> {
	return new Set(milestonesOpenTo(user, [...new Set(ids)]).map((m) => m.id));
}

/**
 * Milestone id → name for a set of cards, for rendering the milestone chip.
 *
 * Only the milestones `user` may open (card 2257). A card they can see carries
 * its milestone's id, and that stays, but the name is the goal's: someone who
 * can open one board of a goal across boards, and is refused the goal itself,
 * was given its name here on All Tasks and All To Do. The board page and the
 * card window read `milestonesForBoard`, which already asked; so does this
 * now. A page shows no chip for a milestone not named.
 */
export function milestoneNamesForCards(user: Actor, cardIds: number[]): Record<number, string> {
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
	const out: Record<number, string> = {};
	for (const m of milestonesOpenTo(user, [...ids])) {
		out[m.id] = m.name;
	}
	return out;
}
