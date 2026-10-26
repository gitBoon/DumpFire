/**
 * column-role.ts — what a column means, decided in one place.
 *
 * A column's title is the only thing that says whether cards in it are finished,
 * paused or waiting to be started. That used to be worked out by comparing the title to a word list
 * wherever the answer was needed: about twenty places, with three different
 * lists. The browser accepted only "complete" where the server also accepted
 * "done", and the dashboard counted a "Waiting" column as on hold where the
 * reports did not. So the same card could be complete on one screen and in
 * progress on another, depending on what its column happened to be called.
 *
 * To Do joined them with card 2240: All Tasks' To Do bucket, the list view's
 * opening column and the All To Do page each tested the title for themselves,
 * and the list view and All Tasks did not quite agree on which columns.
 *
 * Everything now asks here. This module has no server imports, so the browser
 * and the server share the one definition.
 *
 * Upstream joined them with milestone 22, and it is the one meaning that is
 * stored rather than read from the title: a column whose `role` is 'options'
 * is the board's Options column, and every column of a board whose `kind` is
 * 'ideas' is upstream too. Cards there are options, not committed work. An
 * Options column is never also To Do, On Hold or Complete, whatever it is
 * called.
 */

/** What a column means for the cards in it. `null` is an ordinary working column. */
export type ColumnRole = 'complete' | 'hold' | 'todo';

/** The roles a column can have stored (`columns.role`); NULL is none, and the title decides. */
export const COLUMN_ROLES = ['options'] as const;
export type StoredColumnRole = (typeof COLUMN_ROLES)[number];

/** The kinds of board (`boards.kind`). Every board was a delivery board before milestone 22. */
export const BOARD_KINDS = ['delivery', 'ideas'] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];

/** True if this is a board's Options column: upstream of the commitment point. */
export function isOptionsColumn(column: { role: string | null }): boolean {
	return column.role === 'options';
}

/**
 * True if cards in this column are upstream, options rather than committed
 * work: it is the Options column, or its board is an ideas board. Every rule
 * about commitment, discards and what the delivery measures count asks this.
 *
 * Both are required, the column's `role` and its board's kind (the S1a
 * review's R4), so that a caller that forgot to read either is told so by the
 * compiler instead of taking every column for an ordinary one. A board of any
 * kind but 'ideas' is a delivery board here, as in the backfills.
 */
export function isUpstreamColumn(column: { role: string | null }, boardKind: string | null): boolean {
	return isOptionsColumn(column) || boardKind === 'ideas';
}

/**
 * What a column means, its stored role first: an Options column is 'options'
 * whatever its title, and so never To Do, On Hold or Complete on any page.
 * Any other column is what its title says.
 */
export function columnRoleOf(column: { title: string | null | undefined; role: string | null }): 'options' | ColumnRole | null {
	return isOptionsColumn(column) ? 'options' : columnRole(column.title);
}

/** Titles that mean the work is finished. */
const COMPLETE_TITLES: ReadonlySet<string> = new Set(['complete', 'done']);

/**
 * Titles that mean the work is deliberately paused.
 *
 * The union of the three lists that existed: nothing that counted as on hold
 * anywhere stops counting.
 */
const HOLD_TITLES: ReadonlySet<string> = new Set(['on hold', 'hold', 'blocked', 'parked', 'waiting']);

/**
 * Titles that mean the work is waiting to be started (card 2240).
 *
 * Only these two, which All Tasks already put in its To Do bucket. Not "To-Do",
 * "Backlog" or the like, which reports count as To Do: adding one here would
 * move cards between buckets on All Tasks, which nobody asked for.
 */
const TODO_TITLES: ReadonlySet<string> = new Set(['to do', 'todo']);

/** The role a column title implies. Case and surrounding space are ignored. */
export function columnRole(title: string | null | undefined): ColumnRole | null {
	const t = (title ?? '').trim().toLowerCase();
	if (COMPLETE_TITLES.has(t)) return 'complete';
	if (HOLD_TITLES.has(t)) return 'hold';
	if (TODO_TITLES.has(t)) return 'todo';
	return null;
}

/** True if cards in a column with this title are finished. */
export function isCompleteColumnTitle(title: string | null | undefined): boolean {
	return columnRole(title) === 'complete';
}

/**
 * True if cards in a column with this title are deliberately paused.
 *
 * Reports need this separate from "in progress": a board with nine cards on hold
 * and one being worked is not the same as ten in flight, and reading them the
 * same way overstates what is moving.
 */
export function isHoldColumnTitle(title: string | null | undefined): boolean {
	return columnRole(title) === 'hold';
}

/**
 * True if cards in a column with this title are waiting to be started: the
 * column All Tasks calls To Do and the All To Do page lists (card 2240).
 */
export function isTodoColumnTitle(title: string | null | undefined): boolean {
	return columnRole(title) === 'todo';
}

/**
 * The first column, by position, that is not a Complete column, or undefined
 * when every one is.
 *
 * Where new work goes when nobody chose its column. A card created in a
 * Complete column is completed as it is created, with XP and fireworks for
 * whoever made it (card 2134), so a card made for some other reason, the copy
 * of a finished card or a sub-board's parent card, is not put in one when the
 * board has another column.
 *
 * Nor in the Options column (milestone 22): a copy of finished work is not an
 * idea, and would be hidden in a collapsed strip. The Options column is taken
 * only when the board has no other column that is not Complete.
 */
export function firstOpenColumn<C extends { title: string; position: number; role: string | null }>(
	columns: readonly C[]
): C | undefined {
	const open = [...columns].sort((a, b) => a.position - b.position).filter((c) => columnRoleOf(c) !== 'complete');
	return open.find((c) => !isOptionsColumn(c)) ?? open[0];
}

/** The ids of the columns, among these, that mean finished. Never the Options column. */
export function completeColumnIds(columns: readonly { id: number; title: string; role: string | null }[]): Set<number> {
	return new Set(columns.filter((c) => columnRoleOf(c) === 'complete').map((c) => c.id));
}

/** The ids of the columns, among these, that mean paused. Never the Options column. */
export function holdColumnIds(columns: readonly { id: number; title: string; role: string | null }[]): Set<number> {
	return new Set(columns.filter((c) => columnRoleOf(c) === 'hold').map((c) => c.id));
}

/**
 * The ids of the columns, among these, that mean waiting to be started: every one, a board may have two.
 * Never the Options column: an option is not yet work anyone has taken on.
 */
export function todoColumnIds(columns: readonly { id: number; title: string; role: string | null }[]): Set<number> {
	return new Set(columns.filter((c) => columnRoleOf(c) === 'todo').map((c) => c.id));
}
