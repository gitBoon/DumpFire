/**
 * columns.ts — a column added to a board, changed, deleted, and a board's
 * columns put in order: one function for each, which both API trees call
 * (card 2012, part A, slice A4).
 *
 * `/api/columns`, `/api/columns/:id` and `/api/columns/reorder` (the board
 * page) and their twins `/api/v1/boards/:boardId/columns` and
 * `/api/v1/columns/:columnId` had the same middle written twice, the WIP
 * limit's reading among it, copied with a note to keep the two alike. Each
 * tree keeps its path, its body, its single `writeAs`, its answer and,
 * through its options, what it does differently today: where a new column
 * sent with no position goes (first from the page, after the last through v1,
 * `placeAfterLast`) and the order a new column's fields are read in
 * (`colorBeforePosition`, v1). The reorder is the page's alone. R2 of
 * `docs/planning/card-2012-service-layer-and-pages.md`.
 *
 * Each write has the one shape of a service (`ServiceOptions` in
 * `write-as.ts`): `inWrite()` first, then `requireUser(caller)` (401), the
 * guard (404, then 403), then every field read from the body (400), and the
 * write; but the page's `createColumn` reads the board's id from the body
 * before the guard, as the row the guard is asked of, so its `400 Invalid
 * board ID` comes before a 404, and the reorder reads its list and each id
 * before it asks of any column. No column write records an entry but a
 * column deleted (`deletes.ts`) and a column converted to the Options column
 * (`convertColumnFor`). Every event waits for the commit. Refusals
 * are kit `error()`s.
 *
 * Milestone 22 (card 2459) gave a column a stored role, `'options'`: the
 * board's Options column, upstream of the commitment point, whose cards are
 * options and not committed work. The rules for it are here, asked by every
 * write in both trees after each field is read (see `optionsRoleRefusal` and
 * `optionsPlacement`), and so is the one way a column holding cards becomes
 * the Options column, `convertColumnFor`, which asks first and is recorded.
 */
import { error } from '@sveltejs/kit';
import { asc, count, eq } from 'drizzle-orm';
import { db, sqlite } from './db';
import { boards, cards, columns, type Column } from './db/schema';
import type { SessionUser } from './auth';
import { changedFields } from './card-changes';
import { completionRoleRefusal } from './card-completion';
import { deleteColumn } from './deletes';
import { emit } from './events';
import { ACTIONS, actorOf, logActivity } from './logActivity';
import { choiceRefusal, readBoolean, readChoice, readColour, readId, readNumber, readObjects, readText, type RequestBody } from './request-body';
import { requireBoard, requireBoardOwner, requireColumn, requireUser } from './route-guards';
import { inWrite, type ServiceOptions } from './write-as';
import { COLUMN_ROLES, columnRole, isOptionsColumn, isUpstreamColumn } from '$lib/column-role';
import { boardKinds, conversionSuffix } from './upstream';

/** The functions here that only read. None: every export but this list is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = [];

/**
 * The 400 for a role that is not one, quoting what was sent (milestone 22,
 * ruling r): `role must be "options" or null, not "backlog"`. Long text is
 * cut, so the refusal does not repeat a whole body back (`choiceRefusal`, the
 * S6 review's Q4).
 */
function roleRefusal(sent: unknown, nullable = true): string {
	return choiceRefusal('role', nullable ? ['options', null] : ['options'], sent);
}

/** A column as the Options rules read it: the board's other columns, and the one being written. */
type Placed = Pick<Column, 'id' | 'title' | 'position' | 'role'>;

/** The board's kind and every one of its columns, in two reads: what the Options rules ask about. */
function boardForOptions(boardId: number): { kind: string; placed: Placed[] } {
	const board = db.select({ kind: boards.kind }).from(boards).where(eq(boards.id, boardId)).get();
	const placed = db
		.select({ id: columns.id, title: columns.title, position: columns.position, role: columns.role })
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.all();
	return { kind: board?.kind ?? 'delivery', placed };
}

/** How many cards column `columnId` holds, archived ones included, and how many of them are archived. */
function cardsHeld(columnId: number): { total: number; archived: number } {
	const held = db.select({ total: count(), archived: count(cards.archivedAt) }).from(cards).where(eq(cards.columnId, columnId)).get();
	return { total: held?.total ?? 0, archived: held?.archived ?? 0 };
}

/** "1 card" or "N cards". */
const cardsWord = (n: number) => (n === 1 ? '1 card' : `${n} cards`);

/**
 * Why a column called `title` cannot be the Options column, or `null` if it
 * can (ruling x): its title already means To Do, On Hold or Complete.
 */
function titleRefusal(title: string): string | null {
	const titled = columnRole(title);
	if (!titled) return null;
	const what = titled === 'todo' ? 'a To Do column' : titled === 'hold' ? 'an On Hold column' : 'a Complete column';
	return `An Options column cannot be called "${title}", which makes a column ${what}. Choose another name.`;
}

/** The refusal of a column that would sit at or left of the Options column, on every write that places one. */
const OPTIONS_LEFTMOST = 'The Options column stays at the left of the board.';

/**
 * Why a column of an ideas board cannot be called `title`, or `null` if it
 * can (milestone 22, card 2463; the S5a review's L1, which extends ruling x
 * to ideas boards): a title that makes a column To Do, On Hold or Complete.
 * Every card on an ideas board is an option, committed on a delivery board
 * and finished there; about thirty places still read a column's meaning from
 * its title alone, and would take the ideas there for work waiting, paused or
 * done.
 */
function ideasTitleRefusal(title: string): string | null {
	const titled = columnRole(title);
	if (!titled) return null;
	const what = titled === 'todo' ? 'To Do' : titled === 'hold' ? 'On Hold' : 'Complete';
	return `An ideas board has no ${what} column: "${title}" would make one. Choose another name.`;
}

/**
 * Why a column may not be, or stop being, the board's Options column with
 * this write, or `null` if it may (milestone 22, card 2459). `was` is the
 * column as stored, `null` for a new one; `next` what it will be once the
 * write is made; `board` its board's kind and columns. Asked inside the write's
 * transaction, after every field is read and after `completionRoleRefusal`,
 * so a refusal writes nothing and nothing can arrive between the check and
 * the write. Each message is one template, so the OpenAPI document's check of
 * its examples can find it here. In this order:
 *
 *   1. Options on an ideas board, every column of which is upstream already.
 *   2. A second Options column: a board has one at most.
 *   3. The role given or taken away while the column holds a card, archived
 *      ones included: that would change whether the cards are committed
 *      without anyone committing them (decision M22-3). Giving it is what the
 *      conversion is for (ruling i), which counts the cards first and records
 *      it, named as the page's menu item to the page and as the operation to
 *      the API (`source`); taking it away waits until the column is empty,
 *      and says so of archived cards, which cannot be moved: they are
 *      restored and moved, or deleted.
 *   4. Options on a column whose title already means To Do, On Hold or
 *      Complete, given the role or renamed (ruling x, the S1a review's R5):
 *      about thirty places still ask the title alone, and would take the
 *      column for what its title says. It covers the plan's "an Options column
 *      cannot be a Complete column".
 *   5. A WIP limit above 0 sent for a column that is, or becomes, Options.
 */
function optionsRoleRefusal(
	board: { kind: string; placed: Placed[] },
	was: { id: number; role: string | null } | null,
	next: { title: string; role: string | null; wipLimit: number | undefined },
	source: ServiceOptions['source']
): string | null {
	const options = next.role === 'options';
	if (options && board.kind === 'ideas') {
		return 'Every column of an ideas board is already upstream, so it has no Options column.';
	}
	if (options) {
		const other = board.placed.find((c) => c.id !== was?.id && isOptionsColumn(c));
		if (other) return `This board already has an Options column, "${other.title}".`;
	}
	if (was && (was.role ?? null) !== next.role) {
		const { total, archived } = cardsHeld(was.id);
		const [they, them] = total === 1 ? ['it an option', 'it'] : ['them options', 'them'];
		if (total > 0 && options) {
			// From the page the way is the menu item; through the API, the operation (the S1b review's B5).
			const instead = source === 'ui' ? '"Make this the Options column…" in its menu' : `POST /api/v1/columns/${was.id}/convert`;
			return `This column holds ${cardsWord(total)}. Giving it the Options role would make ${they} without anyone deciding it: convert it to the Options column instead (${instead}), which counts the cards first and records it.`;
		}
		if (total > 0 && archived === total) {
			// Only archived cards are left, which cannot be moved (the S1b review's U6).
			return `This Options column holds ${total === 1 ? '1 archived card' : `${total} archived cards`}. Taking the role away would commit ${them} without anyone committing ${them}: restore and move ${them}, or delete ${them}, first.`;
		}
		if (total > 0 && archived === 0) {
			return `This Options column holds ${cardsWord(total)}. Taking the role away would commit ${them} without anyone committing ${them}: move ${them} out of the column first.`;
		}
		if (total > 0) {
			const theArchived = archived === 1 ? 'the archived one' : 'the archived ones';
			return `This Options column holds ${cardsWord(total)}, ${archived} of them archived. Taking the role away would commit them without anyone committing them: move the others out of the column first, and restore and move, or delete, ${theArchived}.`;
		}
	}
	const titled = options ? titleRefusal(next.title) : null;
	if (titled) return titled;
	if (options && next.wipLimit !== undefined && next.wipLimit > 0) return 'An Options column has no WIP limit.';
	return null;
}

/**
 * Number a board's columns again 0, 1, 2… in their order (position, ties by
 * id), writing only those whose position changes, and the rows given with
 * them. No column changes place among the others.
 */
function renumberColumns(placed: Placed[]): void {
	const ordered = [...placed].sort((a, b) => a.position - b.position || a.id - b.id);
	ordered.forEach((column, index) => {
		if (column.position === index) return;
		db.update(columns).set({ position: index }).where(eq(columns.id, column.id)).run();
		column.position = index;
	});
}

/**
 * Where a column goes on a board that has, or is getting, an Options column
 * (milestone 22, rule 4 and ruling s): the Options column stays the leftmost.
 *
 *   - A column given the role, made or changed, goes left of every other
 *     column, whatever position was sent.
 *   - Any other column at or left of the Options column is 409
 *     `OPTIONS_LEFTMOST`, and so is the Options column moved to or past
 *     another.
 *   - A column made on the page with no position (`unplaced`) goes straight
 *     after the Options column, between it and the next. It went to 0, left
 *     of it.
 *
 * Returns the position to write, or `undefined` to write none.
 */
function optionsPlacement(
	board: { placed: Placed[] },
	id: number | null,
	role: string | null,
	becomesOptions: boolean,
	position: number | undefined,
	unplaced: 'start' | 'end' | null
): number | undefined {
	const others = board.placed.filter((c) => c.id !== id);
	if (becomesOptions) return others.length > 0 ? Math.min(...others.map((c) => c.position)) - 1 : 0;
	if (role === 'options') {
		if (position !== undefined && others.some((c) => c.position <= position)) error(409, OPTIONS_LEFTMOST);
		return position;
	}
	const options = others.find(isOptionsColumn);
	if (!options) return position;
	if (position === undefined && unplaced === 'start') {
		const between = () => {
			const after = others.filter((c) => c.position > options.position).map((c) => c.position);
			if (after.length === 0) return options.position + 1;
			const next = Math.min(...after);
			const middle = (options.position + next) / 2;
			return middle > options.position && middle < next ? middle : undefined;
		};
		// Halving the gap again and again reaches a point with no number strictly
		// between (about 53 creates: the S1b review's B1). The board's columns are
		// then numbered again 0, 1, 2… in their order, in this transaction, first.
		const placed = between();
		if (placed !== undefined) return placed;
		renumberColumns(board.placed);
		return between();
	}
	if (position !== undefined && position <= options.position) error(409, OPTIONS_LEFTMOST);
	return position;
}

/**
 * A WIP limit as the database takes it: a whole number, 0 or more, where 0
 * means no limit.
 *
 * `columns.wip_limit` is NOT NULL, so a limit is cleared by storing 0. A null
 * was once passed straight to the database, which refused it, and clearing a
 * limit answered 500. Here a null, or anything else that is not a finite
 * number, becomes 0; so does a negative number; and a fraction loses its
 * fractional part. A number sent as text ("5") is read as that number.
 */
function wipLimitOf(value: unknown): number {
	const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	if (typeof number !== 'number' || !Number.isFinite(number)) return 0;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(number)));
}

/** What each tree's new column does differently today (R2). */
export type CreateColumnOptions = {
	/** A column sent with no position goes after the board's last (v1). From the page it goes at 0. */
	placeAfterLast?: boolean;
	/** `color` is read before `position` (v1); the page reads `position` first. */
	colorBeforePosition?: boolean;
};

/**
 * Add a column to a board: `POST /api/columns` with the board in its body,
 * read first as the row the guard is asked of, and `POST
 * /api/v1/boards/:boardId/columns` with `at.boardId`. The board is looked for
 * and the caller checked (404, then 403), and then the other fields are read
 * (card 2117, R1): `title` text, trimmed, of 1 to 200 characters; `position`
 * a number; `color` a colour written `#rrggbb`. A title that was missing gave
 * "New Column", text was stored as a position, and any colour was stored.
 * The answer is the column as written.
 *
 * `role` is `'options'` or null (milestone 22): an Options column is placed
 * left of every other column whatever position was sent, and is refused as
 * `optionsRoleRefusal` says. On a board with an Options column, a position
 * at or left of it is 409, and a column made on the page with no position
 * goes straight after it (`optionsPlacement`). On an ideas board a column
 * whose title makes it To Do, On Hold or Complete is 409 (`ideasTitleRefusal`,
 * card 2463).
 */
export function createColumn(caller: SessionUser | null, at: { boardId?: number }, body: RequestBody, opts: ServiceOptions & CreateColumnOptions): Column {
	inWrite();
	const user = requireUser(caller);
	// The board the column is being added to, so it is the right one to
	// check, and it has to exist.
	const boardId = requireBoard(user, at.boardId ?? readId(body, 'boardId', { required: true, says: 'Invalid board ID' }), 'edit').id;

	const title = readText(body, 'title', {
		required: true,
		trim: true,
		min: 1,
		max: 200,
		says: { missing: 'title is required', empty: 'title is required' }
	});
	let position: number | undefined;
	let color: string | undefined;
	if (opts.colorBeforePosition) {
		color = readColour(body, 'color', {});
		position = readNumber(body, 'position', {});
	} else {
		position = readNumber(body, 'position', {});
		color = readColour(body, 'color', {});
	}
	const role = readChoice(body, 'role', { from: COLUMN_ROLES, nullable: true, says: roleRefusal(body.role) }) ?? null;
	// A new column is made with no WIP limit, and `wipLimit` is not stored here.
	// It is read, as the update reads it (`wipLimitOf`), for the Options rule
	// alone: an Options column sent a limit above 0 is refused, 409, as an
	// update is, where it was made with 0 and nothing said (the S6 review's Q8).
	const wipLimit = 'wipLimit' in body ? wipLimitOf(body.wipLimit) : undefined;

	// No position sent: at 0 from the page, after the board's last through v1.
	let unplaced = 0;
	if (opts.placeAfterLast) {
		const existingCols = db.select({ position: columns.position }).from(columns).where(eq(columns.boardId, boardId)).orderBy(asc(columns.position)).all();
		unplaced = (existingCols.length > 0 ? Math.max(...existingCols.map((c) => c.position)) : -1) + 1;
	}

	// The Options rules (milestone 22), once every field is read, and then an
	// ideas board's own: it has no Complete column (card 2463).
	const board = boardForOptions(boardId);
	const refusal = optionsRoleRefusal(board, null, { title, role, wipLimit }, opts.source);
	if (refusal) throw error(409, refusal);
	const ideasTitle = board.kind === 'ideas' ? ideasTitleRefusal(title) : null;
	if (ideasTitle) throw error(409, ideasTitle);
	position = optionsPlacement(board, null, role, role === 'options', position, opts.placeAfterLast ? 'end' : 'start');

	const column = db
		.insert(columns)
		.values({
			boardId,
			title,
			position: position ?? unplaced,
			color: color ?? '#6366f1',
			role
		})
		.returning()
		.get();
	emit(boardId, 'update', { type: 'column' });
	return column;
}

/**
 * Change a column (`PUT /api/columns/:id`, `PUT /api/v1/columns/:columnId`).
 *
 * The column is looked for and the caller checked (404, then 403), and then
 * every field is read (card 2117): `title` text, trimmed, of 1 to 200
 * characters; `color` a colour written `#rrggbb`; `position` a number;
 * `showAddCard` true or false. The WIP limit keeps its own reading. A value
 * the column already holds, sent back unchanged, is accepted as it is. A body
 * with none of them is `400 No valid fields to update`. The board is the
 * column's own: a `boardId` in the body is ignored.
 *
 * `showAddCard` was left out of the page's route, so the board page's "Show
 * Add Task" was a 500 on every press; its page changed its own copy and the
 * toggle looked saved until the next load.
 *
 * A title that would make the column a Complete column, or stop it being
 * one, is `409` while the column holds any card, archived ones included, and
 * nothing is written (card 2134): see `completionRoleRefusal`. Only the fields
 * whose value changes are written, and the board told; a save that changes
 * nothing writes and tells nothing (card 2359). The answer is the row.
 *
 * `role` is `'options'` or null, read with the column's own as `keep`, so a
 * body that leaves it out keeps it (milestone 22, ruling r). Given the role,
 * an empty column goes left of every other and its WIP limit to 0; the rest
 * of the Options rules are `optionsRoleRefusal`'s and `optionsPlacement`'s,
 * asked after the completion rule. A column holding cards becomes the Options
 * column through `convertColumnFor`, never here. On an ideas board a rename to
 * a title that makes the column To Do, On Hold or Complete is 409
 * (`ideasTitleRefusal`), after the completion rule (card 2463).
 */
export function updateColumn(caller: SessionUser | null, at: { columnId: number }, body: RequestBody, opts: ServiceOptions): Column {
	inWrite();
	const user = requireUser(caller);
	const { column, boardId } = requireColumn(user, at.columnId, 'edit');

	const updates: Partial<typeof columns.$inferInsert> = {};
	const title = readText(body, 'title', {
		trim: true,
		min: 1,
		max: 200,
		keep: column.title,
		says: { empty: 'title cannot be empty' }
	});
	if (title !== undefined) updates.title = title;
	const color = readColour(body, 'color', { keep: column.color });
	if (color !== undefined) updates.color = color;
	const position = readNumber(body, 'position', { keep: column.position });
	if (position !== undefined) updates.position = position;
	// The WIP limit keeps its own, wider reading: see wipLimitOf.
	if ('wipLimit' in body) updates.wipLimit = wipLimitOf(body.wipLimit);
	const showAddCard = readBoolean(body, 'showAddCard', { keep: column.showAddCard });
	if (showAddCard !== undefined) updates.showAddCard = showAddCard;
	const role = readChoice(body, 'role', { from: COLUMN_ROLES, nullable: true, keep: column.role, says: roleRefusal(body.role) });
	if (role !== undefined) updates.role = role;

	if (Object.keys(updates).length === 0) throw error(400, 'No valid fields to update');

	// Decided on the title as it will be stored, before anything is written,
	// so that the comparison below comes after every refusal (card 2359). It
	// was decided after the write, which the refusal rolled back.
	const refusal = completionRoleRefusal(column, updates.title ?? column.title);
	if (refusal) throw error(409, refusal);
	// An ideas board has no To Do, On Hold or Complete column (card 2463; the
	// S5a review's L1): its board is read only for a rename into one.
	const ideasTitle = updates.title !== undefined && updates.title !== column.title ? ideasTitleRefusal(updates.title) : null;
	if (ideasTitle && boardKinds([boardId]).get(boardId) === 'ideas') throw error(409, ideasTitle);

	// The Options rules (milestone 22), on the column as it will be stored.
	// Read only for a write that can touch them: one that gives or takes the
	// role, changes the Options column, or moves a column.
	const nextRole = updates.role !== undefined ? updates.role : column.role;
	const moves = updates.position !== undefined && updates.position !== column.position;
	if (nextRole === 'options' || column.role === 'options' || moves) {
		const board = boardForOptions(boardId);
		const optionsRefusal = optionsRoleRefusal(board, column, { title: updates.title ?? column.title, role: nextRole, wipLimit: updates.wipLimit }, opts.source);
		if (optionsRefusal) throw error(409, optionsRefusal);
		const becomesOptions = nextRole === 'options' && column.role !== 'options';
		const placed = optionsPlacement(board, column.id, nextRole, becomesOptions, moves || becomesOptions ? updates.position : undefined, null);
		if (placed !== undefined) updates.position = placed;
		if (becomesOptions) updates.wipLimit = 0;
	}

	// Card 2183's rule (card 2359): only the fields whose value changes are
	// written, compared as they will be written with the column as read in
	// this transaction. A save that changes nothing writes and tells nothing,
	// and answers the column as it is. No column change records an entry.
	const changed = changedFields(column, updates);
	if (Object.keys(changed).length === 0) return column;
	const row = db.update(columns).set(changed).where(eq(columns.id, at.columnId)).returning().get();
	emit(boardId, 'update', { type: 'column' });
	return row;
}

/**
 * Delete a column and its cards (`DELETE /api/columns/:id`, `DELETE
 * /api/v1/columns/:columnId`). The board is always the column's own, read
 * from the database, never from the client. What goes with the cards, and
 * the `column_deleted` entry, are in `deletes.ts`. There is no body.
 *
 * The Options column is refused, 409, while it holds a card that is not
 * archived (milestone 22, ruling m): deleting it silently deleted the options
 * in it, which are archived or moved instead; archiving one discards it
 * (card 2461), and the refusal says so. Its archived cards go with it, as any
 * column's do. So is a column of an ideas board holding live ideas (card 2463;
 * the S5a review's L2), every column of which is upstream.
 */
export function deleteColumnFor(caller: SessionUser | null, at: { columnId: number }, body: null, opts: ServiceOptions): void {
	inWrite();
	const user = requireUser(caller);
	const { column, boardId } = requireColumn(user, at.columnId, 'edit');

	// Any upstream column, the Options column or a column of an ideas board
	// (the S5a review's L2): one read of the board's kind for the second.
	const kind = isOptionsColumn(column) ? null : (boardKinds([boardId]).get(boardId) ?? null);
	const ideasBoard = kind === 'ideas';
	if (isUpstreamColumn(column, kind)) {
		const { total, archived } = cardsHeld(column.id);
		const live = total - archived;
		if (live > 0 && ideasBoard) {
			throw error(
				409,
				`This column of an ideas board still holds ${live === 1 ? '1 idea: move it out, or archive it to discard it, first.' : `${live} ideas: move them out, or archive them to discard them, first.`}`
			);
		}
		if (live > 0) {
			throw error(
				409,
				`This Options column still holds ${live === 1 ? '1 option: move it out, or archive it to discard it, first.' : `${live} options: move them out, or archive them to discard them, first.`}`
			);
		}
	}

	deleteColumn(at.columnId, user, opts.source);
	emit(boardId, 'update', { type: 'column' });
}

/**
 * Save the order of a board's columns (`PUT /api/columns/reorder`, the
 * page's alone).
 *
 * Body: `{ updates: [{ id, position }] }`. Each entry is an object, its `id`
 * an id and its `position` a number (card 2117): `updates[<n>].position must
 * be a number`. Text was stored as a position, a missing one was a 500, and an
 * entry that was not an object was a 500.
 *
 * Every column gets its new position or none does, and a board is told only
 * once they all have. A write that failed half way used to leave the columns
 * in an order nobody had asked for. A column already at its position is not
 * written, and a board none of whose columns moves is not told (card 2369).
 * The body's `boardId` is ignored: it used to be the only thing checked, and
 * with it left out any signed-in user could reorder any board's columns.
 *
 * On a board with an Options column, an order that puts any other column at
 * or left of it is 409 `OPTIONS_LEFTMOST` (milestone 22), decided per board
 * once every position is known and before anything is written, so the whole
 * reorder is refused.
 */
export function reorderColumns(caller: SessionUser | null, at: Record<string, never>, body: RequestBody, opts: ServiceOptions): void {
	inWrite();
	const user = requireUser(caller);
	const updates = readObjects(body, 'updates', {
		required: true,
		says: { missing: 'updates must be an array', type: 'updates must be an array' }
	});

	// Every column is looked up and checked before anything is written.
	const ids = updates.map((update, i) => readId(update, 'id', { required: true, says: `updates[${i}].id must be an id` }));
	const held = new Map(ids.map((id) => [id, requireColumn(user, id, 'edit').column]));

	// Then each position, once every column is known to be the caller's.
	const positions = updates.map((update, i) => readNumber(update, 'position', { required: true, says: `updates[${i}].position must be a number` }));

	// Only the columns that move are written, and only their boards told
	// (card 2369): every column named was written and its board told to
	// re-read, even when it was dropped where it was. A column named twice
	// ends at its last position, as when each entry was written in turn.
	const wanted = new Map(ids.map((id, i) => [id, positions[i]]));

	// The Options column stays the leftmost of its board (milestone 22): each
	// board a column of which moves is looked at with every position as it
	// will be, before any is written.
	const moving = new Set([...wanted].filter(([id, position]) => held.get(id)!.position !== position).map(([id]) => held.get(id)!.boardId));
	for (const boardId of moving) {
		const placed = boardForOptions(boardId).placed.map((c) => ({ ...c, position: wanted.get(c.id) ?? c.position }));
		const options = placed.find(isOptionsColumn);
		if (options && placed.some((c) => c.id !== options.id && c.position <= options.position)) throw error(409, OPTIONS_LEFTMOST);
	}

	const boardIds = new Set<number>();
	for (const [id, position] of wanted) {
		const column = held.get(id)!;
		if (column.position === position) continue;
		db.update(columns).set({ position }).where(eq(columns.id, id)).run();
		boardIds.add(column.boardId);
	}
	for (const boardId of boardIds) emit(boardId, 'update', { type: 'column' });
}

/**
 * Make a column the board's Options column, cards and all (`POST
 * /api/columns/:id/convert`, `POST /api/v1/columns/:columnId/convert`;
 * milestone 22, ruling i).
 *
 * Adopting Options on a board already in use meant dragging every card out of
 * a column and back in. This does it in one step, and says so: the page asks
 * first, naming how many live and archived cards the column holds, and sends
 * that count as `cards`; a count that no longer matches is 409, so a card
 * moved in since the question was asked is not made an option unseen.
 *
 * Only the board's owner or an administrator may (`requireBoardOwner`, after
 * the column is looked for: 404, then 403). Body: `role`, which must be
 * `"options"`, and `cards`, a whole number of 0 or more. Refused, 409, in
 * this order: an ideas board; a board with an Options column already (this
 * one among them); a column whose title means To Do, On Hold or Complete
 * (ruling x); a card in it with sub-boards, which never goes upstream (ruling
 * o); and the count.
 *
 * One transaction then clears `committed_at` and `committed_by` on every
 * card in the column, archived ones included, gives the column the role,
 * places it left of every other column and sets its WIP limit to 0. It writes
 * one entry, `column_converted_to_options` ("N cards became options"), and
 * nothing per card: no entry, no webhook, no mail. The board is told once.
 * The answer is the column as written.
 *
 * The way back, the role taken away from a column holding cards, stays
 * refused: `updateColumn` takes it away from an empty column only.
 */
export function convertColumnFor(caller: SessionUser | null, at: { columnId: number }, body: RequestBody, opts: ServiceOptions): Column {
	inWrite();
	const user = requireUser(caller);
	const { column, boardId } = requireColumn(user, at.columnId, 'view');
	requireBoardOwner(user, boardId, "Only the board's owner or an administrator can convert a column to the Options column");

	readChoice(body, 'role', {
		from: COLUMN_ROLES,
		required: true,
		says: { missing: 'role is required', type: roleRefusal(body.role, false), invalid: roleRefusal(body.role, false) }
	});
	const sentCount = readNumber(body, 'cards', { required: true, whole: true, min: 0 });

	const board = boardForOptions(boardId);
	if (board.kind === 'ideas') throw error(409, 'Every column of an ideas board is already upstream, so it has no Options column.');
	const options = board.placed.find(isOptionsColumn);
	if (options) throw error(409, `This board already has an Options column, "${options.title}".`);
	const titled = titleRefusal(column.title);
	if (titled) throw error(409, titled);
	const parent = sqlite
		.prepare('SELECT c.title FROM cards c WHERE c.column_id = ? AND EXISTS (SELECT 1 FROM boards b WHERE b.parent_card_id = c.id) ORDER BY c.id LIMIT 1')
		.get(column.id) as { title: string } | undefined;
	if (parent) {
		throw error(409, `Card "${parent.title}" has a sub-board, and a card with sub-boards is never an option: move it out of this column first.`);
	}
	const { total } = cardsHeld(column.id);
	if (sentCount !== total) throw error(409, `The column now holds ${cardsWord(total)}; look again.`);

	db.update(cards).set({ committedAt: null, committedBy: null }).where(eq(cards.columnId, column.id)).run();
	const row = db
		.update(columns)
		.set({ role: 'options', position: optionsPlacement(board, column.id, 'options', true, undefined, null)!, wipLimit: 0 })
		.where(eq(columns.id, column.id))
		.returning()
		.get();
	// The entry ends with the column's id, which nothing in a title can come
	// after, so that the board's contents can find the column's latest
	// conversion: its cards are options from then (`conversionSuffix`, the S1b
	// review's B2). The log has no column of its own for a column.
	logActivity({
		boardId,
		action: ACTIONS.columnConvertedToOptions,
		detail: `"${column.title}": ${total === 1 ? '1 card became an option' : `${total} cards became options`}${conversionSuffix(column.id)}`,
		source: opts.source,
		...actorOf(user)
	});
	emit(boardId, 'update', { type: 'column' });
	return row;
}
