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
 *
 * Milestone 22 (card 2463) gave a board a kind: a delivery board, as every
 * board was, or an ideas board, every column of which is upstream of the
 * commitment point, holding options nobody has committed to. Each kind has
 * its own default columns. The kind is chosen when the board is made and
 * changed by its owner while it is empty (`updateBoard`, which replaces the
 * columns), and a board holding cards becomes an ideas board only by the
 * conversion, which asks first and is recorded (`convertBoardFor`). A
 * sub-board is a delivery board, and no sub-board hangs under an option.
 */
import { error } from '@sveltejs/kit';
import { count, desc, eq, inArray, and } from 'drizzle-orm';
import { db, sqlite } from './db';
import { boardMembers, boards, cards, columns, type Board, type Card, type Column } from './db/schema';
import type { SessionUser } from './auth';
import { getAccessibleBoardIds } from './board-access';
import { deleteBoard } from './deletes';
import { emit } from './events';
import { changedFields } from './card-changes';
import { ACTIONS, actorOf, logActivity } from './logActivity';
import { choiceRefusal, readBoolean, readChoice, readId, readNumber, readText, type RequestBody } from './request-body';
import { requireBoard, requireBoardCategory, requireBoardOwner, requireParentCard, requireSubBoardLink, requireUser } from './route-guards';
import { tooDeepToMake, tooDeepUnder } from './sub-boards';
import { getCardBoardId } from './work-access';
import { boardConversionSuffix } from './upstream';
import { COLUMN_ORDER } from './card-order';
import { stamp } from '$lib/timestamps';
import { inWrite, type ServiceOptions } from './write-as';
import { BOARD_KINDS, OPTIONS_COLOUR, OPTIONS_TITLE, columnRole, isOptionsColumn, isUpstreamColumn, type BoardKind, type StoredColumnRole } from '$lib/column-role';

/** The functions here that only read. Every other export is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = ['listBoardsFor'];

/**
 * The columns a new board is made with, by its kind, left to right
 * (milestone 22, decisions M22-5 and M22-12): a delivery board's Options
 * column, which every delivery board has (card 2527, rulings O1 and O2), and
 * then the four every board has had; an ideas board's three, all upstream,
 * with no Complete column. A board switched from one kind to the other while
 * empty is given the other kind's (ruling j, decision M22-18). Boards made
 * before card 2527 are given their Options column by `runBackfills`.
 */
const DEFAULT_COLUMNS: Record<BoardKind, readonly { title: string; color: string; role?: StoredColumnRole }[]> = {
	delivery: [
		{ title: OPTIONS_TITLE, color: OPTIONS_COLOUR, role: 'options' },
		{ title: 'To Do', color: '#6366f1' },
		{ title: 'On Hold', color: '#ef4444' },
		{ title: 'In Progress', color: '#f59e0b' },
		{ title: 'Complete', color: '#10b981' }
	],
	ideas: [
		{ title: 'New Ideas', color: '#8b5cf6' },
		{ title: 'Shaping', color: '#6366f1' },
		{ title: 'Ready for Replenishment', color: '#0ea5e9' }
	]
};

/** Make board `boardId`'s default columns for `kind`, at 0, 1, 2… */
function makeDefaultColumns(boardId: number, kind: BoardKind): void {
	db.insert(columns)
		.values(DEFAULT_COLUMNS[kind].map(({ title, color, role }, position) => ({ boardId, title, position, color, role: role ?? null })))
		.run();
}

/**
 * The 400 for a kind that is not one, quoting what was sent (ruling r):
 * `kind must be "delivery" or "ideas", not "portfolio"`. Long text is cut, so
 * the refusal does not repeat a whole body back (`choiceRefusal`, the one
 * wording of every such refusal, the S6 review's Q4).
 */
function kindRefusal(sent: unknown, kinds: readonly string[] = BOARD_KINDS): string {
	return choiceRefusal('kind', kinds, sent);
}

/** The refusal of an ideas board under a card (card 2463, ruling p): a sub-board is part of a card's delivery. */
const SUB_BOARD_IS_DELIVERY = 'A sub-board is a delivery board.';

/**
 * Why no sub-board may hang under `card`, or null if one may (ruling o, which
 * widens decision M22-14): a card upstream, an option, is not committed work,
 * and a card with sub-boards always is. On an ideas board it is sent to a
 * delivery board first; in the Options column it is committed first, by
 * moving it out. One read.
 */
function upstreamParentRefusal(card: Card): string | null {
	const at = db
		.select({ role: columns.role, kind: boards.kind })
		.from(columns)
		.innerJoin(boards, eq(boards.id, columns.boardId))
		.where(eq(columns.id, card.columnId))
		.get();
	if (!at || !isUpstreamColumn(at, at.kind)) return null;
	return at.kind === 'ideas'
		? 'An idea has no sub-boards; send it to a delivery board first.'
		: 'An option has no sub-boards; commit it first, by moving it out of the Options column.';
}

/** How many cards board `boardId` holds, archived ones included. */
function cardsOnBoard(boardId: number): number {
	return (
		db
			.select({ total: count() })
			.from(cards)
			.innerJoin(columns, eq(columns.id, cards.columnId))
			.where(eq(columns.boardId, boardId))
			.get()?.total ?? 0
	);
}

/** "1 card" or "N cards". */
const cardsWord = (n: number) => (n === 1 ? '1 card' : `${n} cards`);

/** "its column A was" or "its columns A, B were", for an entry. */
const columnsNamed = (titles: readonly string[]) => (titles.length === 1 ? `its column ${titles[0]} was` : `its columns ${titles.join(', ')} were`);

/**
 * What an entry says of a board's columns replaced with `kind`'s defaults
 * (the S5a review's L3): "its columns A, B, C were replaced with New Ideas,
 * Shaping, Ready for Replenishment", or, for a board that had none, "it was
 * given the columns …".
 */
function replacedColumns(old: readonly string[], kind: BoardKind): string {
	const made = DEFAULT_COLUMNS[kind].map((c) => c.title).join(', ');
	return old.length === 0 ? `it was given the columns ${made}` : `${columnsNamed(old)} replaced with ${made}`;
}

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
 * Make a board, with its kind's columns and its owner (`POST /api/boards`,
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
 *
 * `kind` is `"delivery"`, the default, or `"ideas"` (milestone 22, card
 * 2463), anything else 400 quoting what was sent; each kind is made with its
 * own columns (`DEFAULT_COLUMNS`). A sub-board is refused, 409, as an ideas
 * board ("A sub-board is a delivery board.") and under a card that is an
 * option, in an Options column or on an ideas board (ruling o), after the
 * parent card is looked for and the caller checked in it.
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
	// A delivery board unless the body says otherwise (milestone 22, card 2463).
	const kind = readChoice(body, 'kind', { from: BOARD_KINDS, says: kindRefusal(body.kind) }) ?? 'delivery';

	// A sub-board hangs under a card, and is shown on it to everybody who can
	// open that card's board. The id used to be written as it was sent, so
	// anyone could hang a board under a card of a board they cannot open.
	const parent = parentCardId != null ? requireParentCard(user, parentCardId) : null;
	// And no deeper than sub-boards may nest (card 2172): 409, nothing made.
	if (parent && tooDeepUnder(parent)) error(409, tooDeepToMake());
	// A sub-board is part of its card's delivery, so it is a delivery board,
	// and it hangs under committed work, never under an option (rulings o and
	// p): 409, nothing made. A new card's sub-boards come here too, so a card
	// made in an upstream column with them is refused whole.
	if (parent && kind === 'ideas') error(409, SUB_BOARD_IS_DELIVERY);
	const upstreamParent = parent ? upstreamParentRefusal(parent) : null;
	if (upstreamParent) error(409, upstreamParent);

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
			kind,
			createdBy: user.id
		})
		.returning()
		.get();

	// Always create default columns, the kind's own.
	makeDefaultColumns(board.id, kind);

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
 *
 * `kind` (milestone 22, card 2463) is read with the board's own as `keep`; a
 * change of it is the owner's or an administrator's (403), asked only when it
 * changes, and is 409 while the board holds any card, archived ones included,
 * naming the conversion (`convertBoardFor`), or, back to delivery, saying the
 * board must be empty first. An empty board switched is given the other
 * kind's columns in place of its own (ruling j). A sub-board is a delivery
 * board: one is not made an ideas board, nor an ideas board put under a card
 * (409, ruling p); and no board is put under an option (409, ruling o).
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
	// The kind (milestone 22, card 2463), read with the board's own as `keep`,
	// so a board read with GET can be sent back whole (ruling r). A change of
	// it is the owner's or an administrator's, asked only when it changes:
	// it decides whether every card on the board is committed work.
	const kind = readChoice(body, 'kind', { from: BOARD_KINDS, keep: board.kind, says: kindRefusal(body.kind) });
	if (kind !== undefined) updates.kind = kind;
	const switching = kind !== undefined && kind !== board.kind;
	if (switching) requireBoardOwner(user, boardId, "Only the board's owner or an administrator can change whether it is an ideas board");

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
	let parent: { card: Card; boardId: number } | null = null;
	if (opts.allowParent) {
		const parentCardId = readId(body, 'parentCardId', { nullable: true, keep: board.parentCardId });
		const moves = parentCardId !== undefined && parentCardId !== board.parentCardId;
		parent = moves ? requireSubBoardLink(user, boardId, parentCardId) : null;
		if (moves) updates.parentCardId = parentCardId;
		moving = moves;
		// Under committed work only (ruling o): asked once the link is known to
		// be the caller's to make.
		const upstreamParent = parent ? upstreamParentRefusal(parent.card) : null;
		if (upstreamParent) error(409, upstreamParent);
	}

	// A sub-board is a delivery board (rulings p and i): an ideas board is not
	// put under a card, and a sub-board is not made an ideas board. Asked of
	// the board as it will be, and only when this request changes one or the
	// other, so a sub-board left from before is saved as ever.
	const nextKind = updates.kind ?? board.kind;
	const nextParent = updates.parentCardId !== undefined ? updates.parentCardId : board.parentCardId;
	if ((switching || moving) && nextKind === 'ideas' && nextParent !== null) error(409, SUB_BOARD_IS_DELIVERY);

	// A change of kind with cards on the board, archived ones included, would
	// commit them or make them options without anyone deciding it (decision
	// M22-4): 409. One holding cards becomes an ideas board by the conversion,
	// named as the page's menu item to the page and as the operation to the
	// API, which counts the cards first and records it; an ideas board becomes
	// a delivery board only once it is empty (ruling i).
	const held = switching ? cardsOnBoard(boardId) : 0;
	if (held > 0) {
		const them = held === 1 ? 'it' : 'them';
		if (kind === 'ideas') {
			const instead = opts.source === 'ui' ? '"Make this an ideas board…" in its More menu' : `POST /api/v1/boards/${boardId}/convert`;
			error(
				409,
				`This board holds ${cardsWord(held)}. Making it an ideas board would make ${held === 1 ? 'it an option' : 'them options'} without anyone deciding it: convert it instead (${instead}), which counts the cards first and records it.`
			);
		}
		error(
			409,
			`This ideas board holds ${cardsWord(held)}. Making it a delivery board would commit ${them} without anyone committing ${them}: move ${them} to a delivery board, or delete ${them}, first.`
		);
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
	// An empty board switched to the other kind is given that kind's columns
	// in place of its own (ruling j, decision M22-18): a delivery board's
	// Complete column has no place on an ideas board, and an ideas board's
	// columns are all upstream. Nothing is on them to lose.
	// The entry says what it replaced, and with what (the S5a review's L3).
	let replaced = '';
	if ('kind' in changed) {
		const nowKind: BoardKind = row.kind === 'ideas' ? 'ideas' : 'delivery';
		const old = db.select({ title: columns.title }).from(columns).where(eq(columns.boardId, boardId)).orderBy(...COLUMN_ORDER).all();
		db.delete(columns).where(eq(columns.boardId, boardId)).run();
		makeDefaultColumns(boardId, nowKind);
		replaced = `: now ${nowKind === 'ideas' ? 'an ideas' : 'a delivery'} board; ${replacedColumns(old.map((c) => c.title), nowKind)}`;
	}

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
		if ('kind' in changed) emit(boardId, 'update', { type: 'column' });
	};

	if (opts.tellBeforeEntry) tell();
	logActivity({
		boardId,
		action: ACTIONS.boardUpdated,
		detail: `Updated board "${row.name}" (fields: ${fields.join(', ')})${replaced}`,
		source: opts.source,
		...actorOf(user)
	});
	if (!opts.tellBeforeEntry) tell();
	return row;
}

/**
 * Make a board an ideas board, cards and all (`POST /api/boards/:id/convert`,
 * `POST /api/v1/boards/:boardId/convert`; milestone 22, card 2463, ruling i).
 *
 * Adopting an ideas board for one already in use meant moving every card off
 * it and back. This does it in one step, and says so: the page asks first,
 * naming how many live and archived cards the board holds, and sends that
 * count as `cards`; a count that no longer matches is 409, so a card added
 * since the question was asked is not made an option unseen.
 *
 * Only the board's owner or an administrator may (`requireBoardOwner`, after
 * the board is looked for: 404, then 403). Body: `kind`, which must be
 * `"ideas"`, and `cards`, a whole number of 0 or more. Refused, 409, in this
 * order: the board is an ideas board already; a card on it has a sub-board,
 * and a card with sub-boards is never an option (ruling o); the board is a
 * sub-board, which is a delivery board (ruling p); a card, live or archived,
 * is in a column whose title makes it To Do, On Hold or Complete, which an
 * ideas board has none of (the S5a review's L1); and the count.
 *
 * One transaction then clears `committed_at` and `committed_by` on every card
 * on the board, archived ones included, makes it an ideas board, deletes its
 * To Do, On Hold and Complete columns, empty by the rule above, and its
 * Options column with them when it holds no card, live or archived (card 2527,
 * ruling O7); one holding cards keeps them, with the Options role taken off,
 * every column now being upstream. A
 * board with no card at all is given the ideas board's default columns in
 * place of its own instead, as an empty board switched with its kind is
 * (decision M22-18). It writes one entry, `board_converted_to_ideas` ("N
 * cards became ideas; its columns … were removed", or "… were replaced with
 * …", ending with the board's id, `boardConversionSuffix`, for the aging), and
 * nothing per card: no entry, no webhook, no mail. The board's pages are told
 * once. The answer is the board as written, with its columns, in their order.
 *
 * The way back, an ideas board holding cards made a delivery board, stays
 * refused: `updateBoard` switches only an empty one.
 */
export function convertBoardFor(caller: SessionUser | null, at: { boardId: number }, body: RequestBody, opts: ServiceOptions): Board & { columns: Column[] } {
	inWrite();
	const user = requireUser(caller);
	const board = requireBoard(user, at.boardId, 'view');
	requireBoardOwner(user, board.id, "Only the board's owner or an administrator can make it an ideas board");

	const ideasOnly = ['ideas'] as const;
	readChoice(body, 'kind', {
		from: ideasOnly,
		required: true,
		says: { missing: 'kind is required', type: kindRefusal(body.kind, ideasOnly), invalid: kindRefusal(body.kind, ideasOnly) }
	});
	const sentCount = readNumber(body, 'cards', { required: true, whole: true, min: 0 });

	if (board.kind === 'ideas') error(409, 'This board is already an ideas board.');
	const parent = sqlite
		.prepare(
			`SELECT c.title, c.archived_at AS archivedAt FROM cards c JOIN columns col ON col.id = c.column_id
			WHERE col.board_id = ? AND EXISTS (SELECT 1 FROM boards b WHERE b.parent_card_id = c.id) ORDER BY c.id LIMIT 1`
		)
		.get(board.id) as { title: string; archivedAt: string | null } | undefined;
	if (parent) {
		// An archived card cannot be moved, so it is restored first (the S5a review's L7).
		error(
			409,
			parent.archivedAt
				? `Archived card "${parent.title}" has a sub-board, and a card with sub-boards is never an option: restore it and move it to another board, or move or delete its sub-board, first.`
				: `Card "${parent.title}" has a sub-board, and a card with sub-boards is never an option: move it to another board, or move or delete its sub-board, first.`
		);
	}
	if (board.parentCardId !== null) error(409, SUB_BOARD_IS_DELIVERY);
	// The columns whose titles make them To Do, On Hold or Complete, which an
	// ideas board has none of (the S5a review's L1): removed when empty, and
	// refused while one holds a card, live or archived. A To Do or On Hold
	// column is renamed; a Complete column holding cards cannot be (card
	// 2134), so its cards go.
	const boardColumns = db.select().from(columns).where(eq(columns.boardId, board.id)).orderBy(...COLUMN_ORDER).all();
	const titled = boardColumns.filter((c) => !isOptionsColumn(c) && columnRole(c.title) !== null);
	for (const column of titled) {
		const held = db.select({ total: count() }).from(cards).where(eq(cards.columnId, column.id)).get()?.total ?? 0;
		if (held === 0) continue;
		const role = columnRole(column.title);
		if (role === 'complete') {
			error(
				409,
				`"${column.title}" holds ${cardsWord(held)}, and an ideas board has no Complete column: move ${held === 1 ? 'it' : 'them'} to a delivery board, or delete ${held === 1 ? 'it' : 'them'}, first.`
			);
		}
		error(409, `"${column.title}" holds ${cardsWord(held)}, and an ideas board has no ${role === 'todo' ? 'To Do' : 'On Hold'} column: rename it first.`);
	}
	const total = cardsOnBoard(board.id);
	if (sentCount !== total) error(409, `The board now holds ${cardsWord(total)}; look again.`);

	// A board with no card at all is switched as an empty one is, to the ideas
	// board's own columns (decision M22-18; the S5a review's L1). One that holds
	// cards keeps its columns, but the titled ones, and its cards become options.
	let changed: string;
	if (total === 0) {
		db.delete(columns).where(eq(columns.boardId, board.id)).run();
		makeDefaultColumns(board.id, 'ideas');
		changed = `; ${replacedColumns(boardColumns.map((c) => c.title), 'ideas')}`;
	} else {
		db.update(cards).set({ committedAt: null, committedBy: null }).where(inArray(cards.columnId, boardColumns.map((c) => c.id))).run();
		// An empty Options column goes with the titled ones, named among them in
		// the board's order (card 2527, ruling O7): an ideas board has none.
		const emptyOptions = new Set(
			boardColumns
				.filter((c) => isOptionsColumn(c) && (db.select({ total: count() }).from(cards).where(eq(cards.columnId, c.id)).get()?.total ?? 0) === 0)
				.map((c) => c.id)
		);
		const removed = boardColumns.filter((c) => titled.includes(c) || emptyOptions.has(c.id));
		if (removed.length > 0) db.delete(columns).where(inArray(columns.id, removed.map((c) => c.id))).run();
		db.update(columns).set({ role: null }).where(and(eq(columns.boardId, board.id), eq(columns.role, 'options'))).run();
		changed = removed.length === 0 ? '' : `; ${columnsNamed(removed.map((c) => c.title))} removed`;
	}
	const row = db.update(boards).set({ kind: 'ideas', updatedAt: stamp() }).where(eq(boards.id, board.id)).returning().get();
	// The columns removed or replaced are named before the board's id, which
	// stays last for the aging to read (the S5a review's L4).
	logActivity({
		boardId: board.id,
		action: ACTIONS.boardConvertedToIdeas,
		detail: `"${board.name}": ${total === 1 ? '1 card became an idea' : `${total} cards became ideas`}${changed}${boardConversionSuffix(board.id)}`,
		source: opts.source,
		...actorOf(user)
	});
	emit(board.id, 'update', { type: 'board' });
	return { ...row, columns: db.select().from(columns).where(eq(columns.boardId, board.id)).orderBy(...COLUMN_ORDER).all() };
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
