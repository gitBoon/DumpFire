/**
 * boards.ts — the boards a caller can open listed, a board made, changed and
 * deleted: one function for each, which both API trees call (card 2012,
 * part A, slice A4).
 *
 * `/api/boards` and `/api/boards/:id` (the dashboard and the board page) and
 * their twins `/api/v1/boards` and `/api/v1/boards/:boardId` had the same
 * middle written twice: the guards, the field reads, the board with its four
 * columns and its owner, the entry and the live update. Each tree keeps its
 * path, its body, its single `writeAs`, its answer and, through its options,
 * what it does differently today: the page files a new board under a
 * dashboard grouping (`allowCategory`) and moves a board under another card
 * (`allowParent`); v1 refuses a change that names no field (`refuseEmpty`)
 * and tells the board before it writes the entry (`tellBeforeEntry`). R2 of
 * `docs/planning/card-2012-service-layer-and-pages.md`.
 *
 * Each write has the one shape of a service (`ServiceOptions` in
 * `write-as.ts`): `inWrite()` first, then `requireUser(caller)` (401), the
 * guard (404, then 403), then every field read from the body (400), and the
 * write. A new board has no row to guard, so its fields are read first and the
 * rows they name (its parent card, its grouping) looked for after. Every entry
 * and event waits for the commit. Refusals are kit `error()`s.
 */
import { error } from '@sveltejs/kit';
import { desc, eq, inArray } from 'drizzle-orm';
import { db } from './db';
import { boardMembers, boards, columns, type Board } from './db/schema';
import type { SessionUser } from './auth';
import { getAccessibleBoardIds } from './board-access';
import { deleteBoard } from './deletes';
import { emit } from './events';
import { changedFields } from './card-changes';
import { ACTIONS, actorOf, logActivity } from './logActivity';
import { readBoolean, readId, readText, type RequestBody } from './request-body';
import { requireBoard, requireBoardCategory, requireBoardOwner, requireParentCard, requireSubBoardLink, requireUser } from './route-guards';
import { tooDeepToMake, tooDeepUnder } from './sub-boards';
import { getCardBoardId } from './work-access';
import { stamp } from '$lib/timestamps';
import { inWrite, type ServiceOptions } from './write-as';

/** The functions here that only read. Every other export is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = ['listBoardsFor'];

/**
 * The boards the caller can open, newest first (`GET /api/boards`, `GET
 * /api/v1/boards`): every board for an administrator.
 */
export function listBoardsFor(user: SessionUser | null | undefined, at: Record<string, never>, opts: Record<string, never>): Board[] {
	const caller = requireUser(user);
	const accessibleIds = getAccessibleBoardIds(caller);

	if (accessibleIds === null) {
		// Admin — sees everything
		return db.select().from(boards).orderBy(desc(boards.createdAt)).all();
	}
	if (accessibleIds.length === 0) return [];
	return db.select().from(boards).where(inArray(boards.id, accessibleIds)).orderBy(desc(boards.createdAt)).all();
}

/** What each tree's new board does differently today (R2). */
export type CreateBoardOptions = {
	/** `categoryId`, the dashboard grouping, is read and filed under (the page, and v1 since card 2287, which ignored it). */
	allowCategory?: boolean;
};

/**
 * What `POST /api/boards` hands `createBoard`, and so does a new card's
 * sub-board (`createCard`, card 2296): one constant, so the two cannot drift
 * (the card 2296 review). Written out, as every service's options are
 * (tests/check-at-the-write.test.ts).
 */
export const CREATE_BOARD_PAGE_OPTIONS = { source: 'ui', allowCategory: true } as const satisfies ServiceOptions & CreateBoardOptions;

/**
 * Make a board, with its four columns and its owner (`POST /api/boards`,
 * `POST /api/v1/boards`).
 *
 * The fields (card 2117, R1): `name` text, trimmed, of 1 to 200 characters;
 * `emoji` text of 1 to 32; `parentCardId` an id, or null for none; and
 * `categoryId`, the dashboard grouping, an id or null (both trees pass
 * `allowCategory`: v1 since card 2287, where it made the board unfiled). `{}` made
 * "Untitled Board", and a grouping that was not there was stored as sent:
 * `boards.category_id` has no foreign key.
 *
 * One transaction: the board, its columns and its owner are made together. A
 * failure after the first used to leave a board with no columns, or one that
 * nobody owned. The parent card is read and the caller checked in it. With
 * them the `board_created` entry, and for a sub-board the live update that
 * shows it on its card (card 2143). The answer is the board as written.
 */
export function createBoard(caller: SessionUser | null, at: Record<string, never>, body: RequestBody, opts: ServiceOptions & CreateBoardOptions): Board {
	inWrite();
	const user = requireUser(caller);

	const name = readText(body, 'name', {
		required: true,
		trim: true,
		min: 1,
		max: 200,
		says: { missing: 'name is required', empty: 'name is required' }
	});
	const emoji = readText(body, 'emoji', { min: 1, max: 32 });
	const parentCardId = readId(body, 'parentCardId', { nullable: true });
	const categoryId = opts.allowCategory ? readId(body, 'categoryId', { nullable: true }) : undefined;

	// A sub-board hangs under a card, and is shown on it to everybody who can
	// open that card's board. The id used to be written as it was sent, so
	// anyone could hang a board under a card of a board they cannot open.
	const parent = parentCardId != null ? requireParentCard(user, parentCardId) : null;
	// And no deeper than sub-boards may nest (card 2172): 409, nothing made.
	if (parent && tooDeepUnder(parent)) error(409, tooDeepToMake());

	// A grouping the caller is listed (card 2128, R2): 404 for none, and 403
	// for one all of whose boards they cannot open, which filing a board
	// under would put in their lists.
	if (opts.allowCategory && categoryId != null) requireBoardCategory(user, categoryId);

	const board = db
		.insert(boards)
		.values({
			name,
			emoji: emoji ?? '📋',
			parentCardId: parent?.id ?? null,
			categoryId: categoryId ?? null,
			createdBy: user.id
		})
		.returning()
		.get();

	// Always create default columns
	db.insert(columns)
		.values([
			{ boardId: board.id, title: 'To Do', position: 0, color: '#6366f1' },
			{ boardId: board.id, title: 'On Hold', position: 1, color: '#ef4444' },
			{ boardId: board.id, title: 'In Progress', position: 2, color: '#f59e0b' },
			{ boardId: board.id, title: 'Complete', position: 3, color: '#10b981' }
		])
		.run();

	// Auto-add the creator as board owner
	db.insert(boardMembers).values({ boardId: board.id, userId: user.id, role: 'owner' }).run();

	logActivity({
		boardId: board.id,
		action: ACTIONS.boardCreated,
		detail: `Created board "${board.name}"`,
		source: opts.source,
		...actorOf(user)
	});

	// A sub-board is drawn on its card, so the pages open on that card's
	// board are told: neither tree did, and the sub-board was not seen there
	// until a reload (card 2143). A top-level board is shown to nobody else
	// who has a page open: its maker and the administrators, and the maker's
	// page moves to it.
	if (parent) {
		const parentBoardId = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, parent.columnId)).get()!.boardId;
		emit(parentBoardId, 'update', { type: 'board', action: 'created' });
	}

	return board;
}

/** What each tree's board change does differently today (R2). */
export type UpdateBoardOptions = {
	/** A body that sets no field is `400 No valid fields to update` (v1). The page's route answers it as it did: nothing written, recorded or told. */
	refuseEmpty?: boolean;
	/** `parentCardId` is read, and the board moved under that card or back onto the dashboard (the page). */
	allowParent?: boolean;
	// `refuseEmpty` and `allowParent` are not meant to be combined: the empty check runs before `parentCardId` is read, so a body sending only it would be refused.
	/**
	 * `parentCardId` is taken only as the card the board hangs under, null for
	 * none, so a board read with GET can be sent back whole (an editor leaves
	 * isPublic out); any other, null on a sub-board included, is a 400 (v1, card 2287; card 2114's D8 keeps the
	 * link off v1). Never combined with `allowParent`.
	 */
	refuseParent?: boolean;
	/** Tell the board before writing the entry (v1); the page's route writes the entry first. */
	tellBeforeEntry?: boolean;
};

/**
 * Change a board (`PUT /api/boards/:id`, `PUT /api/v1/boards/:boardId`): its
 * name, emoji, dashboard grouping and whether it is public, and from the page
 * the card it hangs under.
 *
 * The board is read, the caller checked, and who may make it public asked, in
 * the transaction that changes it. A board that is not there is 404 to
 * everyone; it was 403 to all but an administrator. The fields are read in
 * the order the entry names them (card 2143). A value the board already holds,
 * sent back unchanged, is accepted as it is. v1 takes no parent card: one
 * other than the board's own is refused (`refuseParent`, card 2287). What changed is recorded, with
 * the fields named, and the board's own pages are told; a save that changes
 * nothing writes, records and tells nothing (card 2345). The answer is the row.
 */
export function updateBoard(caller: SessionUser | null, at: { boardId: number }, body: RequestBody, opts: ServiceOptions & UpdateBoardOptions): Board {
	inWrite();
	const user = requireUser(caller);
	const { boardId } = at;
	const board = requireBoard(user, boardId, 'edit');

	// An editor changes what is on a board, and not who can see it. Sent by
	// anyone but the owner or an administrator, `isPublic` refuses the whole
	// request: no other field that came with it is saved either. It is asked
	// before the value is read, so an editor is answered 403 whatever it is.
	if ('isPublic' in body) requireBoardOwner(user, boardId);

	const updates: Partial<typeof boards.$inferInsert> = {};
	const name = readText(body, 'name', {
		trim: true,
		min: 1,
		max: 200,
		keep: board.name,
		says: { empty: 'name cannot be empty' }
	});
	if (name !== undefined) updates.name = name;
	const emoji = readText(body, 'emoji', { min: 1, max: 32, keep: board.emoji });
	if (emoji !== undefined) updates.emoji = emoji;
	// The dashboard grouping the board is filed under, or null for none.
	const categoryId = readId(body, 'categoryId', { nullable: true, keep: board.categoryId });
	if (categoryId !== undefined) updates.categoryId = categoryId;
	const isPublic = readBoolean(body, 'isPublic', { keep: board.isPublic });
	if (isPublic !== undefined) updates.isPublic = isPublic;

	// v1 links no board under a card and takes none out (card 2287): another
	// parent card is refused, where the other fields were saved and it was
	// ignored. The board's own, sent back, is taken: the value the reader
	// returns is compared, so "7" is the card 7 it hangs under. Asked before
	// the empty check, so a parent card sent alone is told why. The card named
	// is not looked for.
	if (opts.refuseParent) {
		const sentParent = readId(body, 'parentCardId', { nullable: true, keep: board.parentCardId });
		if (sentParent !== undefined && sentParent !== board.parentCardId) {
			throw error(
				400,
				`parentCardId ${sentParent} is not this board's parent card (${board.parentCardId ?? 'none'}): the board has been moved since it was read, or a link was meant. A board is put under a card, or taken out from under one, on the board page`
			);
		}
	}

	if (opts.refuseEmpty && Object.keys(updates).length === 0) throw error(400, 'No valid fields to update');

	// `boards.category_id` has no foreign key, so a grouping that is not
	// there was stored as sent: 404. One all of whose boards the caller
	// cannot open is 403, as reading it is (card 2128, R2). One sent back
	// unchanged is left alone.
	if (categoryId !== undefined && categoryId !== null && categoryId !== board.categoryId) {
		requireBoardCategory(user, categoryId);
	}

	// The card the board hangs under, or null to put it back on the
	// dashboard. Linking hands the board's deletion to the parent board's
	// editors, so its owner or an administrator is asked, and the card may
	// not be on the board or beneath it (`requireSubBoardLink`). The card
	// it already hangs under, sent back, is left alone.
	let moving = false;
	let parent: { boardId: number } | null = null;
	if (opts.allowParent) {
		const parentCardId = readId(body, 'parentCardId', { nullable: true, keep: board.parentCardId });
		const moves = parentCardId !== undefined && parentCardId !== board.parentCardId;
		parent = moves ? requireSubBoardLink(user, boardId, parentCardId) : null;
		if (moves) updates.parentCardId = parentCardId;
		moving = moves;
	}

	// Card 2183's rule (card 2345): only the fields whose value changes are
	// written, recorded and told, compared as they will be written with the
	// board as read in this transaction, after every refusal above. A save that
	// changes nothing, `{}` from the page included, writes, records and tells
	// nothing, and answers the board as it is. A sub-board move is already in
	// `updates` only when it moves.
	const changed = changedFields(board, updates);
	const fields = Object.keys(changed);
	if (fields.length === 0) return board;
	const row = db.update(boards).set({ ...changed, updatedAt: stamp() }).where(eq(boards.id, boardId)).returning().get();

	// What changed is recorded and the board's pages are told (card 2143): a
	// rename or a grouping changed on screen had neither. The board moved, and the cards
	// it left and joined show it, or stop showing it: those boards' pages are
	// told as well, each once.
	const told = new Set<number>([boardId]);
	if (opts.allowParent && moving) {
		if (parent) told.add(parent.boardId);
		const left = board.parentCardId === null ? null : getCardBoardId(board.parentCardId);
		if (left !== null) told.add(left);
	}
	const tell = () => {
		for (const id of told) emit(id, 'update', { type: 'board' });
	};

	if (opts.tellBeforeEntry) tell();
	logActivity({
		boardId,
		action: ACTIONS.boardUpdated,
		detail: `Updated board "${row.name}" (fields: ${fields.join(', ')})`,
		source: opts.source,
		...actorOf(user)
	});
	if (!opts.tellBeforeEntry) tell();
	return row;
}

/**
 * Delete a board and everything on it (`DELETE /api/boards/:id`, `DELETE
 * /api/v1/boards/:boardId`): every sub-board at every depth goes with it, and
 * what else goes is in `deletes.ts`. Only owners and administrators may; a
 * board that is not there is 404 to everyone, before who is asking is looked
 * at (card 2211). There is no body. A card elsewhere released from one of its
 * goals is recorded as this tree's (card 2381).
 */
export function deleteBoardFor(caller: SessionUser | null, at: { boardId: number }, body: null, opts: ServiceOptions): void {
	inWrite();
	const user = requireUser(caller);
	requireBoardOwner(user, at.boardId, 'Only board owners and admins can delete boards');

	if (!deleteBoard(at.boardId, user, opts.source)) throw error(404, 'Board not found');
}
