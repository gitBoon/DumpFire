/**
 * cards.ts — a card made, changed, archived or deleted, moved and restored:
 * one function for each, which both API trees call (card 2012, part A).
 *
 * The two trees are there for the reason they are everywhere in this
 * codebase: the pages call `src/routes/api/**` on a session, other programs
 * call `src/routes/api/v1/**` with a key. Each pair's handlers had the same
 * middle written twice, the field reads, the write, the change check, the
 * entry and the live event, and two copies drift (card 2143). They call here
 * now. What each tree keeps is its own: its path ids, its body, its single
 * `writeAs` and its answer, and, through the options each handler passes,
 * what it accepts and the words it refuses with, exactly as before (R2 of
 * the plan, `docs/planning/card-2012-service-layer-and-pages.md`).
 *
 * Every function here has the one shape of a service (`ServiceOptions` in
 * `write-as.ts`):
 *
 *     service(caller, at: { …the ids in the path }, body, opts: ServiceOptions & { …the tree's options })
 *
 * and:
 *
 *   - starts with `inWrite()`: it runs only inside a `writeAs` callback, and
 *     is handed that callback's `caller`, never the request's locals;
 *   - asks `requireUser(caller)` next (401), then its guard (404, then 403),
 *     then reads its fields from the body through the readers of
 *     `request-body.ts` (400), ids named in the body among them, so a session
 *     that ended while the body arrived is refused 401 before any of them is
 *     looked for (S2). Two read an id from the body before their guard, as
 *     intended: where the id names the row the guard is asked of, it is read
 *     first (`createCard`'s column for the internal route, `restoreCardFor`'s
 *     card for the board's archive); and `moveCards` reads the drop's ids and
 *     caps, which read no row, before it looks for any card;
 *   - writes through the helpers that already exist (`applyCardMove`,
 *     `archiveCard`, `deleteCard`, `restoreCard`, `recordCardCreated`; and a
 *     new card's subtasks, labels, assignees and sub-boards through the
 *     services their own routes call, card 2296), and
 *     records and announces itself: every entry, event, webhook and mail
 *     waits for the commit (`afterCommit`);
 *   - throws kit `error()`, as the guards do, a `CardMoveError` or a
 *     `MilestoneError` turned into one, so a handler has nothing to catch.
 *
 * `tests/check-at-the-write.test.ts` holds the routes and this module to
 * that, `tests/activity-twins.test.ts` holds each pair to what it did, and
 * `tests/openapi-document.test.ts` reads each v1 handler through here with
 * the options it passes.
 */
import { error, isHttpError } from '@sveltejs/kit';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db } from './db';
import { boards, cards, columns, type Card, type Column } from './db/schema';
import type { SessionUser } from './auth';
import { editableBoardIds } from './board-access';
import { requireBoard, requireCard, requireColumn, requireUser } from './route-guards';
import { announceCardCreated, recordCardCreated } from './card-create';
import { readCardPatch, readNewCardFields, requireCardCategory } from './card-fields';
import { changedFields } from './card-changes';
import {
	applyCardMove,
	announceCardMoves,
	archivedAcrossCommitment,
	leftMilestoneOf,
	recordUnblockedByMoves,
	reorderTooLarge,
	tooManyMoved,
	CardMoveError,
	MAX_CARDS_MOVED_AT_ONCE,
	MAX_REORDER_ENTRIES,
	type CardMove,
	type MoveRequest
} from './card-moves';
import { archiveCard, deleteCard } from './deletes';
import { restoreCard } from './card-restore';
import { emit } from './events';
import { ACTIONS, actorOf, logActivity } from './logActivity';
import { setCardMilestone, takeCardOutOfMilestone, MilestoneError } from './milestones';
import { readChoice, readId, readIds, readNumber, readObjects, type RequestBody } from './request-body';
import { COLUMN_ORDER } from './card-order';
import { columnRoleOf, isOptionsColumn, isUpstreamColumn } from '$lib/column-role';
import { CREATE_SUBTASK_PAGE_OPTIONS, createSubtask } from './subtasks';
import { TOGGLE_LABEL_PAGE_OPTIONS, toggleCardLabel } from './card-labels';
import { ASSIGN_PAGE_OPTIONS, assignToCard } from './card-assignees';
import { CREATE_BOARD_PAGE_OPTIONS, createBoard } from './boards';
import { stamp, toStamp } from '$lib/timestamps';
import { inWrite, type ServiceOptions } from './write-as';

/** The functions here that only read: where an option can be sent. Every other export is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = ['sendTargetsFor'];

/** A move, as `applyCardMove` makes it, with its refusal a kit error. */
function moved(request: MoveRequest): CardMove {
	try {
		return applyCardMove(request);
	} catch (e) {
		if (e instanceof CardMoveError) throw error(e.status, e.message);
		throw e;
	}
}

/**
 * After the last move, so that a card a drop both unblocked and completed
 * gets no notice: the "Unblocked" notices, then the events and mail, all
 * after the commit.
 */
function announceMoves(moves: CardMove[], user: SessionUser, opts: ServiceOptions): void {
	const unblocked = recordUnblockedByMoves(moves, user);
	announceCardMoves(moves, unblocked, user, opts.source, opts.baseUrl ?? null);
}

/**
 * The most entries each of a new card's four lists may hold (card 2296,
 * ruling 3): each is a write, an entry and an event, and all of them are one
 * transaction holding the write lock. A drop's moves have the same cap. The
 * cap is per list, so one request can still hold 400 parts, some 1,000 rows
 * and more (a sub-board alone is a board, four columns, an owner and an
 * entry): far past what a window sends, and far short of the some 25,000
 * sub-boards a 512 KB body could hold without it (the review).
 */
const MAX_NEW_CARD_PARTS = 100;

/** What each tree's card create does differently today (R2). */
export type CreateCardOptions = {
	/**
	 * `subtasks`, `labelIds`, `assigneeIds` and `subBoards` are read and written
	 * with the card (the internal route, card 2296). v1 does not pass it, and
	 * ignores them, as any field it does not read.
	 */
	withContents?: boolean;
};

/**
 * One part of a new card, written by its own service: a refusal refuses the
 * whole request, with the part's status and words, the entry named first
 * (`subtasks[1]: title is required`), so the reader knows which part it was.
 * The part's own error is thrown on, its words prefixed, so its status is the
 * one its service wrote (and that `tests/error-shape.test.ts` reads there).
 */
function asPart<T>(entry: string, write: () => T): T {
	try {
		return write();
	} catch (e) {
		if (isHttpError(e)) e.body.message = `${entry}: ${e.body.message}`;
		throw e;
	}
}

/**
 * Each id once, in the order first sent: a label toggled twice would come off
 * again (card 2296, ruling 4). Each with the place it was first sent at, which
 * a refusal names: `[bug, bug, 999999]`'s third is `labelIds[2]`, as sent, not
 * the second of the list without the repeat (the review).
 */
function once(ids: number[]): [id: number, sentAt: number][] {
	const seen = new Set<number>();
	return ids.map((id, sentAt): [number, number] => [id, sentAt]).filter(([id]) => !seen.has(id) && Boolean(seen.add(id)));
}

/**
 * Raise a card in a column (`POST /api/cards`, and `POST
 * /api/v1/boards/:boardId/cards` with `at.boardId`).
 *
 * The internal route names no board: `columnId` is the row it guards, so it
 * is read first, and the column looked for and the caller checked (404, then
 * 403); a `boardId` in the body is ignored, as it once let a caller name a
 * board they could edit while creating a card on one they could not. v1
 * guards the board in its path first, reads the fields, and then a column
 * that is not that board's is a 400. Each keeps its own words for a
 * `columnId` that is missing.
 *
 * Then the category the body names: one of the card's board, or one that
 * belongs to no board (R3), `404 Category not found on this board`
 * otherwise. A card created in a Complete column is completed as it is
 * created, as a card moved into one is (card 2134, `card-create.ts`). The
 * answer is the card as written, with its `completedAt`.
 *
 * With `withContents` (the internal route, card 2296) the card is made with
 * what the New Task window gathered for it, in its transaction: `subtasks`
 * (objects, as `POST /api/subtasks` takes them), `labelIds`, `assigneeIds`
 * (ids, each once) and `subBoards` (objects, as `POST /api/boards` takes them,
 * under this card), each a list of at most 100, its shape read with the
 * card's fields (400). Each part is then written, in that order, by the
 * service its own route calls, with that route's options: the same checks,
 * entries, events and mail, sent after the one commit in the order they were
 * queued. Any refusal refuses the whole request (`asPart`), and nothing of
 * it is written or sent; the window sent each part on its own after the
 * card, so a refusal left half a card.
 */
export function createCard(
	caller: SessionUser | null,
	at: { boardId?: number },
	body: RequestBody,
	opts: ServiceOptions & CreateCardOptions
): Card {
	inWrite();
	const user = requireUser(caller);

	let boardId: number;
	let columnId: number;
	let column: Column | undefined;
	if (at.boardId === undefined) {
		columnId = readId(body, 'columnId', { required: true, says: 'Invalid column ID' });
		({ column, boardId } = requireColumn(user, columnId, 'edit'));
	} else {
		boardId = at.boardId;
		requireBoard(user, boardId, 'edit');
		columnId = readId(body, 'columnId', { required: true, says: { missing: 'columnId is required' } });
	}

	const fields = readNewCardFields(body);
	// The four lists' shapes, read with the fields; each entry's own fields are
	// its service's to read, as it is written.
	const list = { max: MAX_NEW_CARD_PARTS };
	const contents = opts.withContents
		? {
				subtasks: readObjects(body, 'subtasks', list) ?? [],
				labelIds: once(readIds(body, 'labelIds', list) ?? []),
				assigneeIds: once(readIds(body, 'assigneeIds', list) ?? []),
				subBoards: readObjects(body, 'subBoards', list) ?? []
			}
		: null;

	if (!column) {
		const named = db.select().from(columns).where(eq(columns.id, columnId)).get();
		if (!named || named.boardId !== boardId) throw error(400, 'Column does not belong to this board');
		column = named;
	}
	if (fields.categoryId != null) requireCardCategory(fields.categoryId, boardId);

	const card = db
		.insert(cards)
		.values({
			columnId,
			categoryId: fields.categoryId ?? null,
			title: fields.title,
			description: fields.description ?? '',
			position: fields.position ?? 0,
			priority: fields.priority ?? 'medium',
			colorTag: fields.colorTag ?? '',
			dueDate: fields.dueDate ?? null,
			businessValue: fields.businessValue ?? '',
			createdBy: user.id,
			...fields.reporting
		})
		.returning()
		.get();

	// The `card_created` entry and, in a Complete column, the completion; then
	// the live update and, for a completion, the celebration, after the commit.
	const creation = recordCardCreated({ card, column, actor: user, source: opts.source });
	announceCardCreated(creation, user, opts.baseUrl ?? null);

	// What the window gathered, in the order it sent each part on its own
	// before (card 2296): each through its own route's service, with the
	// options that route hands it, the one constant both use (the review: they
	// were copied here by hand, and nothing tied the copies to the routes).
	// Asked of `opts` as well, so that a reader of the source sees v1 never
	// comes here (`tests/openapi-document.test.ts` reads v1's create so).
	if (opts.withContents && contents) {
		const cardId = card.id;
		contents.subtasks.forEach((entry, i) => asPart(`subtasks[${i}]`, () => createSubtask(user, { cardId }, entry, CREATE_SUBTASK_PAGE_OPTIONS)));
		contents.labelIds.forEach(([labelId, i]) =>
			asPart(`labelIds[${i}]`, () => toggleCardLabel(user, {}, { cardId, labelId }, TOGGLE_LABEL_PAGE_OPTIONS))
		);
		contents.assigneeIds.forEach(([userId, i]) =>
			asPart(`assigneeIds[${i}]`, () => assignToCard(user, { cardId }, { userId }, { ...ASSIGN_PAGE_OPTIONS, baseUrl: opts.baseUrl }))
		);
		// What `POST /api/boards` takes, under this card whatever `parentCardId` was sent.
		contents.subBoards.forEach((entry, i) =>
			asPart(`subBoards[${i}]`, () => createBoard(user, {}, { ...entry, parentCardId: cardId }, CREATE_BOARD_PAGE_OPTIONS))
		);
	}
	return creation.card;
}

/** What each tree's card update takes beyond the fields both do, and how it tells. */
export type UpdateCardOptions = {
	/** `columnId` and `position`: a change of column is a move (the internal route). */
	allowMove?: boolean;
	/**
	 * `columnId` is taken only as the column the card is in, so a card read with
	 * GET can be sent back whole; any other is a 400 naming the move route (v1,
	 * card 2287). `position` is still not read. Never combined with `allowMove`.
	 */
	refuseMove?: boolean;
	/** `milestoneId` (v1). */
	allowMilestone?: boolean;
	/** `archivedAt: null` restores the card; any other value is a 400 (v1). */
	allowRestore?: boolean;
	/** A body that names nothing to change is `400 No valid fields to update` (v1); the internal route answers it 200. */
	refuseEmpty?: boolean;
	/**
	 * Tell the board before writing the entry (and so before queueing its
	 * `card.updated` webhook), as v1 always has; the internal route writes the
	 * entry first. A webhook receiver can see the order, so each tree keeps its own.
	 */
	tellBeforeEntry?: boolean;
};

/**
 * Change a card (`PUT /api/cards/:id`, `PUT /api/v1/cards/:cardId`).
 *
 * The card is looked for and the caller checked first (404, then 403), then
 * every field is read (400), then what the body names is looked for: the
 * column it moves to (404, 403), the category (404) and the milestone. A
 * value the card already holds, sent back unchanged, is accepted as it is,
 * whatever the rules say of it (decision 8): the card window sends the stored
 * priority, due date and category back on every save.
 *
 * Only what differs from the card as it then stands is written, named and
 * announced (card 2183): a request that changes nothing writes nothing,
 * records no entry, sends no `card.updated` and no live event, and is
 * answered with the card.
 *
 * A `position` (the page's route alone takes one) with no change of column
 * is not an edit to the card either (card 2288): a changed one goes through
 * the drag's path, which writes the position alone and records nothing, and
 * one the card holds is dropped. Other fields sent with it are recorded as
 * ever, the entry naming them alone.
 *
 * v1 takes no move (card 2287): a `columnId` other than the card's own is
 * refused with a 400 that names the move route, and nothing is written; a
 * `position` is not read at all, whatever is sent.
 *
 * A changed `milestoneId` (v1 alone takes one) is recorded as the goal's own
 * entry, `milestone_card_added` or `milestone_card_removed`, and not named in
 * `card_updated` (card 2289): a milestone alone sends no `card.updated`.
 *
 * The answer is the card, and the milestone of the board it left that a
 * move to another board took it out of (card 2155), null otherwise; and
 * whether the move took it across the commitment point, out of upstream
 * (`committed`) or back into it (`returnedToOptions`), for All Tasks to say
 * so (milestone 22, the S2 review's C7).
 */
export function updateCard(
	caller: SessionUser | null,
	at: { cardId: number },
	body: RequestBody,
	opts: ServiceOptions & UpdateCardOptions
): { card: Card; leftMilestone: { id: number; name: string } | null; committed: boolean; returnedToOptions: boolean } {
	inWrite();
	const user = requireUser(caller);
	const { cardId } = at;
	// The board comes from the card's own row. A `boardId` in the body is
	// ignored: it names the board the caller wants to be judged against, which
	// need not be the one this card is on.
	const { card, boardId: currentBoardId } = requireCard(user, cardId, 'edit', opts.says);

	// Every field, read against its rule and the value the card holds.
	const patch = readCardPatch(body, card, { position: opts.allowMove === true });
	const { categoryId, onHoldNote } = patch;
	const columnId = opts.allowMove ? readId(body, 'columnId', { keep: card.columnId, says: 'Invalid column ID' }) : undefined;

	// `archivedAt` restores, and does nothing else (decision 12). The stamp the
	// card already holds, sent back, changes nothing: it is read with `toStamp`
	// (card 2095), so the ISO form v1 answers with is the same moment as the
	// stored form the card holds.
	const restoring = opts.allowRestore === true && 'archivedAt' in body && body.archivedAt === null;
	if (opts.allowRestore && 'archivedAt' in body && !restoring) {
		const sent = toStamp(body.archivedAt);
		if (sent === null || sent !== card.archivedAt) {
			throw error(400, 'archivedAt may only be null, which restores the card. Archive a card with DELETE /cards/{cardId}');
		}
	}

	const milestoneId = opts.allowMilestone ? readId(body, 'milestoneId', { nullable: true, keep: card.milestoneId }) : undefined;

	// A move is its own act, on its own route, with its own answer and effects
	// (card 2287): v1 refuses another column here, where it saved the other
	// fields and left the card where it was. The column the card is in, sent
	// back, is taken: the value the reader returns is compared, so "14" is the
	// card's column 14. Asked after every other field, so a body wrong in two
	// ways names the first as before, and before the empty check, so another
	// column sent alone is told about the move. The column named is not looked for.
	if (opts.refuseMove) {
		const sentColumn = readId(body, 'columnId', { keep: card.columnId });
		if (sentColumn !== undefined && sentColumn !== card.columnId) {
			throw error(
				400,
				`columnId ${sentColumn} is not this card's column (${card.columnId}): the card has moved since it was read, or a move was meant. Move a card with PUT /cards/{cardId}/move`
			);
		}
	}

	if (opts.refuseEmpty && Object.keys(patch).length === 0 && milestoneId === undefined && !('archivedAt' in body)) {
		throw error(400, 'No valid fields to update');
	}

	// A change of column is a move, possibly to another board (the All Tasks
	// page does this). The caller needs edit access at both ends: without the
	// check on the target, anyone who could edit one card could push it into a
	// board they cannot open. The move goes through the same path as a drag
	// and an API move, so a completion stamps the date, awards the XP and logs
	// the completion exactly as those do.
	const target = opts.allowMove && columnId !== undefined && columnId !== card.columnId ? requireColumn(user, columnId, 'edit') : null;
	const boardId = target?.boardId ?? currentBoardId;

	// What else the body names, once every field is known to be sound: a
	// category of the board the card ends on, or a shared one (R3). One the
	// card already holds, sent back, is not looked at again.
	//
	// But on a move to another board, the one it holds sent back is not
	// written: the move decides, and clears one of the old board's, which
	// cannot follow the card. The card window sends the category back on every
	// save, and wrote the old board's over the move's clearing. A different one
	// sent is checked against the board the card ends on.
	if (target && target.boardId !== currentBoardId && categoryId === card.categoryId) {
		delete patch.categoryId;
	}
	if (categoryId !== undefined && categoryId !== null && categoryId !== card.categoryId) {
		requireCardCategory(categoryId, boardId);
	}

	let move: CardMove | null = null;
	if (opts.allowMove && target) {
		move = moved({ cardId, toColumnId: target.column.id, position: patch.position, actor: user, source: opts.source });
		delete patch.position;
	} else if (opts.allowMove && patch.position !== undefined) {
		// A change of position within the card's column is not an edit to the
		// card (card 2288): it goes through the drag's path, which writes the
		// position alone, stamps no `updatedAt`, records nothing and sends the
		// drag's `reorder` update. The position the card holds, sent back, is
		// dropped before anything is called: that path sends its update even
		// when nothing moved, which would break card 2183's rule.
		if (patch.position !== card.position) {
			move = moved({ cardId, toColumnId: card.columnId, position: patch.position, actor: user, source: opts.source });
		}
		delete patch.position;
	}

	// A move out of an On Hold column clears the note (card 2208). The note the
	// card held before the move, sent back with it, is not written over the
	// clearing: the move decides, as for the category above. A different note
	// sent with the move is a new reason, and is written.
	if (move && card.onHoldNote && move.card.onHoldNote === '' && onHoldNote === card.onHoldNote) {
		delete patch.onHoldNote;
	}

	// Restored before the milestone is set, which refuses an archived card:
	// `archivedAt: null` with a `milestoneId` was refused as archived. A
	// milestone refused rolls the restore back, and its entry, with everything
	// else. A restore has its own entry, written by `restoreCard`.
	const restored = restoring && restoreCard(cardId, user, opts.source)?.restored === true;

	// A milestone is not a plain field. Joining one needs the caller to be able
	// to see it, and a single-board milestone only takes that board's cards.
	// Leaving one needs edit access to it, as joining does: R5's rule, the same
	// on every route that takes a card out, and on a move from one milestone to
	// another. The milestone the card is already in, sent back, changes nothing.
	//
	// It writes the goal's own entry, `milestone_card_added` or
	// `milestone_card_removed`, as every route that puts a card in a goal or
	// takes it out does, naming the card by its title after this request; it
	// is not named in `card_updated`, so `card.updated` is not sent when it is
	// the only change (card 2289, decision 9).
	const settingMilestone = milestoneId !== undefined && milestoneId !== card.milestoneId;
	if (settingMilestone) {
		const record = { source: opts.source, title: patch.title ?? card.title };
		try {
			if (milestoneId === null) takeCardOutOfMilestone(user, cardId, record);
			else setCardMilestone(user, cardId, milestoneId, record);
		} catch (e) {
			if (e instanceof MilestoneError) throw error(e.status, e.message);
			throw e;
		}
	}

	// Only what differs from the card as it now stands (after a move, the
	// moved row, which may have lost its category or its note).
	let row = move?.card ?? card;
	const fields = changedFields(row, patch);
	const named = Object.keys(fields);
	const touched = named.length > 0 || restored;
	if (touched) {
		const written = db
			.update(cards)
			.set({ ...fields, updatedAt: stamp() })
			.where(eq(cards.id, cardId))
			.returning()
			.get();
		if (!written) throw error(404, 'Card not found');
		row = written;
	} else if (settingMilestone) {
		// The milestone alone was written, with its own `updatedAt`: the card as it left it.
		row = db.select().from(cards).where(eq(cards.id, cardId)).get() ?? row;
	}

	// Nothing here is sent before the commit, or at all if this rolls back.
	const tell = () => {
		if (move) announceMoves([move], user, opts);
		else if (touched || settingMilestone) emit(boardId, 'update', { type: 'card' });
	};
	if (opts.tellBeforeEntry) tell();
	if (named.length > 0) {
		logActivity({
			boardId,
			cardId,
			action: ACTIONS.cardUpdated,
			detail: `Updated fields: ${named.join(', ')} on "${row.title}"`,
			source: opts.source,
			...actorOf(user)
		});
	}
	if (!opts.tellBeforeEntry) tell();

	return { card: row, leftMilestone: leftMilestoneOf(move), committed: move?.committed === true, returnedToOptions: move?.returnedToOptions === true };
}

/**
 * Archive a card, or with `permanent` delete it (`DELETE /api/cards/:id`,
 * `DELETE /api/v1/cards/:cardId`). There is no body. See `deletes.ts` for
 * what goes with a permanent delete; an archive touches nothing but the card.
 * A card already archived is answered the same, with nothing written and its
 * board not told (card 2285), so a retried archive does not fail.
 */
export function removeCard(
	caller: SessionUser | null,
	at: { cardId: number },
	body: null,
	opts: ServiceOptions & { permanent: boolean }
): void {
	inWrite();
	const user = requireUser(caller);
	const { boardId } = requireCard(user, at.cardId, 'edit', opts.says);

	if (opts.permanent) deleteCard(at.cardId, user, opts.source);
	else if (!archiveCard(at.cardId, user, opts.source)?.archived) return;

	emit(boardId, 'update', { type: 'card' });
}

/**
 * Move one card to a column (`PUT /api/v1/cards/:cardId/move`), on its board
 * or another: edit access to the board it is going to as well as the one it
 * is on. `columnId` is an id and `position` a number, or one written as text
 * (a position that was not a number is a 400). The move, its entry and the
 * "Unblocked" notices are saved together or not at all.
 */
export function moveCard(caller: SessionUser | null, at: { cardId: number }, body: RequestBody, opts: ServiceOptions): CardMove {
	inWrite();
	const user = requireUser(caller);
	requireCard(user, at.cardId, 'edit');
	const toColumnId = readId(body, 'columnId', { required: true, says: { missing: 'columnId is required' } });
	const position = readNumber(body, 'position', {});

	const target = requireColumn(user, toColumnId, 'edit');
	const move = moved({ cardId: at.cardId, toColumnId: target.column.id, position, actor: user, source: opts.source });
	announceMoves([move], user, opts);
	return move;
}

/** Where a Send takes a card on the other board (milestone 22, card 2463): its Options column, or its To Do. */
const SEND_TO = ['options', 'todo'] as const;

/** The 400 for a `to` that is not one, quoting what was sent, as the role's is (ruling r). */
function sendToRefusal(sent: unknown): string {
	const shown = JSON.stringify(sent) ?? 'nothing';
	return `to must be "options" or "todo", not ${shown.length > 60 ? `${shown.slice(0, 57)}...` : shown}`;
}

/**
 * The column "Send to To Do" commits a card into, on a delivery board whose
 * columns are `boardColumns`, in their order (ruling l): the first column
 * titled To Do, or else the first committed column that is neither Complete
 * nor On Hold. Never the Options column, and never On Hold: a card sent to be
 * worked on is not parked. Undefined when no column qualifies.
 */
function sendToTodoColumn<C extends { title: string; role: string | null }>(boardColumns: readonly C[]): C | undefined {
	return (
		boardColumns.find((c) => columnRoleOf(c) === 'todo') ??
		boardColumns.find((c) => {
			const role = columnRoleOf(c);
			return role !== 'options' && role !== 'complete' && role !== 'hold';
		})
	);
}

/**
 * Send an option to another delivery board (`POST /api/cards/:id/send`, `POST
 * /api/v1/cards/:cardId/send`; milestone 22, card 2463, rulings b and l).
 *
 * An option is sent from where it waits, any upstream column, a column of an
 * ideas board or a delivery board's Options column, to another delivery board:
 * to its Options column, where it is still an option and keeps its age
 * (decision M22-20), or to its To Do, which commits it on arrival. Committed
 * work is moved, never sent.
 *
 * Body: `boardId`, the board it goes to, an id; `to`, `"options"` or
 * `"todo"`; and `position`, a number, optional, where in the column it goes.
 * In this order:
 *
 *   - 401; the card looked for and the caller checked for edit access to its
 *     board (404, then 403);
 *   - the body's fields (400): `boardId is required`, `to must be "options"
 *     or "todo", not "backlog"`;
 *   - the board it goes to, looked for and edit access to it (404, then 403);
 *   - 400: the card is committed ("A committed card is moved, not sent"); the
 *     board is an ideas board, or the card's own board;
 *   - 409: the card is archived (ruling n, as a move across the commitment
 *     point is); `to: "options"` and the board has no Options column; `to:
 *     "todo"` and it has no column to commit into (`sendToTodoColumn`).
 *
 * Then the move, as every move is made (`applyCardMove`): every move refusal,
 * the board's labels, a board's category and a milestone of the board it
 * left shed, the commitment on arrival in To Do, and the entries. The board it
 * leaves records `card_sent` in place of `card_moved_away` (decision M22-19),
 * which sends `card.moved`; the board it joins records `card_moved_in`, and
 * `card_committed` for To Do, which sends `card.committed`; all at one
 * moment, so that the Send is paired with its arrival (ruling b). Neither
 * names the other board (card 2181). The live updates and mail are a move's.
 */
export function sendCard(caller: SessionUser | null, at: { cardId: number }, body: RequestBody, opts: ServiceOptions): CardMove {
	inWrite();
	const user = requireUser(caller);
	const { card, boardId: fromBoardId } = requireCard(user, at.cardId, 'edit');
	const boardId = readId(body, 'boardId', { required: true, says: { missing: 'boardId is required' } });
	const to = readChoice(body, 'to', {
		from: SEND_TO,
		required: true,
		says: { missing: 'to is required', type: sendToRefusal(body.to), invalid: sendToRefusal(body.to) }
	});
	const position = readNumber(body, 'position', {});

	const target = requireBoard(user, boardId, 'edit');

	const from = db
		.select({ role: columns.role, kind: boards.kind })
		.from(columns)
		.innerJoin(boards, eq(boards.id, columns.boardId))
		.where(eq(columns.id, card.columnId))
		.get();
	if (!from || !isUpstreamColumn(from, from.kind)) throw error(400, 'A committed card is moved, not sent');
	if (target.kind === 'ideas') throw error(400, `"${target.name}" is an ideas board: a card is sent to a delivery board, and moved onto an ideas board`);
	if (target.id === fromBoardId) throw error(400, `The card is already on "${target.name}": move it within the board instead`);
	if (card.archivedAt) throw error(409, archivedAcrossCommitment(card.title));

	const targetColumns = db.select().from(columns).where(eq(columns.boardId, target.id)).orderBy(...COLUMN_ORDER).all();
	const column = to === 'options' ? targetColumns.find(isOptionsColumn) : sendToTodoColumn(targetColumns);
	if (!column) {
		throw error(409, to === 'options' ? `"${target.name}" has no Options column` : `"${target.name}" has no column to commit into: add a To Do column`);
	}

	const move = moved({ cardId: card.id, toColumnId: column.id, position, actor: user, source: opts.source, sent: to });
	announceMoves([move], user, opts);
	return move;
}

/** A board an option can be sent to, as the Send window lists it: whether it has an Options column, and the column To Do would commit into. */
export type SendTarget = { id: number; name: string; emoji: string | null; options: boolean; todo: string | null };

/**
 * Where an option can be sent (`GET /api/cards/:id/send`; milestone 22, card
 * 2463, slice S5b): the page's Send window lists these. The card is looked for
 * and the caller asked for edit access to its board (404, then 403), as a
 * Send asks.
 *
 * Every delivery board the caller can edit, but the card's own, by name:
 * `options` says whether it has an Options column, and `todo` names the
 * column a Send to To Do would commit into (`sendToTodoColumn`), or is null
 * where there is none. The Send itself asks every rule again; this only
 * spares the window offering what would be refused. Edit access is decided
 * in a fixed number of reads, however many boards there are
 * (`editableBoardIds`, the S5b review's P2), and the delivery boards are
 * chosen in SQL.
 */
export function sendTargetsFor(user: SessionUser | null | undefined, at: { cardId: number }, opts: Record<string, never>): SendTarget[] {
	const { boardId: fromBoardId } = requireCard(user, at.cardId, 'edit');
	const caller = requireUser(user);
	const editableIds = editableBoardIds(caller);
	if (editableIds !== null && editableIds.size === 0) return [];
	const delivery = and(eq(boards.kind, 'delivery'), ne(boards.id, fromBoardId));
	const editable = db
		.select({ id: boards.id, name: boards.name, emoji: boards.emoji })
		.from(boards)
		.where(editableIds === null ? delivery : and(delivery, inArray(boards.id, [...editableIds])))
		.all();
	if (editable.length === 0) return [];	const boardColumns = db
		.select({ boardId: columns.boardId, title: columns.title, role: columns.role })
		.from(columns)
		.where(inArray(columns.boardId, editable.map((b) => b.id)))
		.orderBy(...COLUMN_ORDER)
		.all();
	return editable
		.map((b) => {
			const own = boardColumns.filter((c) => c.boardId === b.id);
			return { id: b.id, name: b.name, emoji: b.emoji, options: own.some(isOptionsColumn), todo: sendToTodoColumn(own)?.title ?? null };
		})
		.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

/**
 * Persist a drag and drop (`PUT /api/cards/reorder`): `{ updates: [{ id,
 * columnId, position }] }`, any subset of one board's cards, each an object
 * with ids and a number (card 2117). No id is in the path.
 *
 * The caller first (401). Then two caps (card 2209, `card-moves.ts`): at
 * most `MAX_REORDER_ENTRIES` entries, and each card once (the review's S5),
 * checked before any card is read; and at most `MAX_CARDS_MOVED_AT_ONCE` of
 * them moving a card to another column, checked once every card and column
 * is known to be the caller's, before the first move. Either is 400 and moves
 * nothing.
 *
 * Every card in the drop moves or none does: one that cannot be completed,
 * open subtasks say, rolls the whole drop back, so the board never shows half
 * of what was dragged. An empty list moves nothing and is answered as done.
 *
 * Answers the moves made, one per entry, for the route to say which cards
 * crossed the commitment point (milestone 22).
 */
export function moveCards(caller: SessionUser | null, at: Record<string, never>, body: RequestBody, opts: ServiceOptions): CardMove[] {
	inWrite();
	const user = requireUser(caller);
	const updates = readObjects(body, 'updates', {
		required: true,
		says: { missing: 'updates must be an array', type: 'updates must be an array' }
	});
	if (updates.length === 0) return [];
	if (updates.length > MAX_REORDER_ENTRIES) throw error(400, reorderTooLarge(updates.length));
	const cardIds = updates.map((update, i) => readId(update, 'id', { required: true, says: `updates[${i}].id must be an id` }));
	const named = new Set<number>();
	for (const cardId of cardIds) {
		if (named.has(cardId)) throw error(400, `updates names card ${cardId} more than once`);
		named.add(cardId);
	}

	// Which board this reorder is on comes from the rows themselves: the column
	// each card is in now, and the column each is going to. A `boardId` in the
	// body is ignored: it used to be the only thing checked, and when it was
	// left out nothing was checked at all. Checked once per distinct column,
	// not once per card: a drop re-sends the position of every card in the
	// columns it touched.
	const columnBoards = new Map<number, number>();
	const editableBoardOf = (columnId: number): number => {
		let found = columnBoards.get(columnId);
		if (found === undefined) {
			found = requireColumn(user, columnId, 'edit').boardId;
			columnBoards.set(columnId, found);
		}
		return found;
	};

	// Each entry names two rows that are guarded, its card and the column it
	// goes to, so their ids are read first.
	const boardIds = new Set<number>();
	const drops = updates.map((update, i) => {
		const cardId = cardIds[i];
		const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
		if (!card) throw error(404, `Card ${cardId} not found`);
		boardIds.add(editableBoardOf(card.columnId));
		const toColumnId = readId(update, 'columnId', { required: true, says: `updates[${i}].columnId must be an id` });
		boardIds.add(editableBoardOf(toColumnId));
		return { cardId, fromColumnId: card.columnId, toColumnId };
	});

	// A drag and drop happens on one board. Moving a card to another board is a
	// different operation with its own routes.
	if (boardIds.size !== 1) throw error(400, 'A reorder must stay within one board');

	// Then each position, once every card and column is known to be the caller's.
	const positions = updates.map((update, i) => readNumber(update, 'position', { says: `updates[${i}].position must be a number` }));

	// Then how many cards it moves to another column, each of which is an
	// activity entry, a delivery to every webhook of the board and mail.
	const moving = drops.filter((drop) => drop.toColumnId !== drop.fromColumnId).length;
	if (moving > MAX_CARDS_MOVED_AT_ONCE) throw error(400, tooManyMoved(moving));

	const moves = drops.map((drop, i) =>
		moved({ cardId: drop.cardId, toColumnId: drop.toColumnId, position: positions[i], actor: user, source: opts.source })
	);
	announceMoves(moves, user, opts);
	return moves;
}

/**
 * Bring a card back from the archive: `POST /api/cards/:id/restore` with the
 * card in its path (`at.cardId`, no body), and `POST /api/boards/:id/archive`
 * with the board in its path (`at.boardId`) and the card in its body, read
 * first as the row the guard is asked of. Restoring is an edit to the card's
 * board; the card decides which board is checked, not the path, and a card of
 * another board is not found on this one. A card that is not archived is
 * answered as it is, with nothing written and nobody told. v1 restores
 * through the card update, `archivedAt: null`.
 */
export function restoreCardFor(
	caller: SessionUser | null,
	at: { cardId: number } | { boardId: number },
	body: RequestBody | null,
	opts: ServiceOptions
): Card {
	inWrite();
	const user = requireUser(caller);
	const cardId = 'cardId' in at ? at.cardId : readId(body ?? {}, 'cardId', { required: true, says: 'Invalid card ID' });

	const { boardId } = requireCard(user, cardId, 'edit', opts.says);
	if ('boardId' in at && boardId !== at.boardId) throw error(404, 'Card not found on this board');

	const restore = restoreCard(cardId, user, opts.source);
	if (!restore) throw error(404, 'Card not found');
	if (restore.restored) emit(boardId, 'update', { type: 'card' });
	return restore.card;
}
