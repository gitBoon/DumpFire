/**
 * column-role.ts — what a column means, decided in one place.
 *
 * A column's title is the only thing that says whether cards in it are finished
 * or paused. That used to be worked out by comparing the title to a word list
 * wherever the answer was needed: about twenty places, with three different
 * lists. The browser accepted only "complete" where the server also accepted
 * "done", and the dashboard counted a "Waiting" column as on hold where the
 * reports did not. So the same card could be complete on one screen and in
 * progress on another, depending on what its column happened to be called.
 *
 * Everything now asks here. This module has no server imports, so the browser
 * and the server share the one definition.
 */

/** What a column means for the cards in it. `null` is an ordinary working column. */
export type ColumnRole = 'complete' | 'hold';

/** Titles that mean the work is finished. */
const COMPLETE_TITLES: ReadonlySet<string> = new Set(['complete', 'done']);

/**
 * Titles that mean the work is deliberately paused.
 *
 * The union of the three lists that existed: nothing that counted as on hold
 * anywhere stops counting.
 */
const HOLD_TITLES: ReadonlySet<string> = new Set(['on hold', 'hold', 'blocked', 'parked', 'waiting']);

/** The role a column title implies. Case and surrounding space are ignored. */
export function columnRole(title: string | null | undefined): ColumnRole | null {
	const t = (title ?? '').trim().toLowerCase();
	if (COMPLETE_TITLES.has(t)) return 'complete';
	if (HOLD_TITLES.has(t)) return 'hold';
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
 * The first column, by position, that is not a Complete column, or undefined
 * when every one is.
 *
 * Where new work goes when nobody chose its column. A card created in a
 * Complete column is completed as it is created, with XP and fireworks for
 * whoever made it (card 2134), so a card made for some other reason, the copy
 * of a finished card or a sub-board's parent card, is not put in one when the
 * board has another column.
 */
export function firstOpenColumn<C extends { title: string; position: number }>(columns: readonly C[]): C | undefined {
	return [...columns].sort((a, b) => a.position - b.position).find((c) => !isCompleteColumnTitle(c.title));
}

/** The ids of the columns, among these, that mean finished. */
export function completeColumnIds(columns: readonly { id: number; title: string }[]): Set<number> {
	return new Set(columns.filter((c) => isCompleteColumnTitle(c.title)).map((c) => c.id));
}

/** The ids of the columns, among these, that mean paused. */
export function holdColumnIds(columns: readonly { id: number; title: string }[]): Set<number> {
	return new Set(columns.filter((c) => isHoldColumnTitle(c.title)).map((c) => c.id));
}
