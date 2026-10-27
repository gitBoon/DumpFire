/**
 * The board page's two views (card 2079): the Kanban board, every column side
 * by side, and the list, one column at a time at full width, for a portrait
 * monitor. The choice is the viewer's own, per board, in this browser: in the
 * address while the list is shown (`?view=list&column=<id>`), so a monitor can
 * bookmark its list, and in `localStorage`, so the board opens the way it was
 * left. Nothing here talks to the server.
 *
 * Browser storage can be blocked, full or absent (a private window, the
 * server's render): every read and write is inside a `try`, and with storage
 * blocked the view still switches and nothing is remembered.
 */

import type { CardType, CategoryType, ColumnType } from '$lib/types';
import { matchesSearch, sortCards } from '$lib/utils/card-utils';
import { isTodoColumnTitle } from '$lib/column-role';
import { parseStamp } from '$lib/timestamps';

export type BoardViewName = 'board' | 'list';

/** Priority: pinned first, then critical to low, the board's order within each. Board: the column as the board shows it. */
export type ListOrder = 'priority' | 'board';

export type BoardViewChoice = {
	view: BoardViewName;
	/** The column the list shows. Kept while the board is shown, so List goes back to it. */
	columnId: number | null;
	order: ListOrder;
};

/** What a board opens as when nothing says otherwise. */
export const BOARD_VIEW: BoardViewChoice = { view: 'board', columnId: null, order: 'priority' };

/** The `localStorage` key: one viewer's choice for one board. */
export function boardViewKey(userId: number, boardId: number): string {
	return `dumpfire-board-view:${userId}:${boardId}`;
}

/** The choice this viewer left this board in, or null when none is remembered or storage cannot be read. */
export function readBoardView(userId: number, boardId: number): BoardViewChoice | null {
	let raw: string | null;
	try {
		raw = localStorage.getItem(boardViewKey(userId, boardId));
	} catch {
		return null;
	}
	if (!raw) return null;
	let stored: unknown;
	try {
		stored = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!stored || typeof stored !== 'object') return null;
	const { view, columnId, order } = stored as Record<string, unknown>;
	if (view !== 'board' && view !== 'list') return null;
	return {
		view,
		columnId: typeof columnId === 'number' && Number.isInteger(columnId) && columnId > 0 ? columnId : null,
		order: order === 'board' ? 'board' : 'priority'
	};
}

/** Remembers the choice. Storage that cannot be written remembers nothing, and says nothing. */
export function writeBoardView(userId: number, boardId: number, choice: BoardViewChoice): void {
	try {
		localStorage.setItem(boardViewKey(userId, boardId), JSON.stringify(choice));
	} catch {
		// Blocked or full: the view still switches, and is forgotten on reload.
	}
}

/**
 * The view an address asks for: the list, on the column it names, when it
 * carries `view=list`; null when it asks for nothing, which is how the board
 * view is written. The order is not in the address: it is the remembered one.
 */
export function viewFromUrl(url: URL): { view: 'list'; columnId: number | null } | null {
	if (url.searchParams.get('view') !== 'list') return null;
	const column = Number(url.searchParams.get('column'));
	return { view: 'list', columnId: Number.isInteger(column) && column > 0 ? column : null };
}

/** A copy of the address carrying the choice: `view` and `column` for the list, neither for the board. */
export function withViewParams(url: URL, choice: BoardViewChoice): URL {
	const next = new URL(url);
	if (choice.view === 'list') {
		next.searchParams.set('view', 'list');
		if (choice.columnId !== null) next.searchParams.set('column', String(choice.columnId));
		else next.searchParams.delete('column');
	} else {
		next.searchParams.delete('view');
		next.searchParams.delete('column');
	}
	return next;
}

/**
 * How a board opens: the address's choice, else the remembered one, else the
 * board. An address asking for the list keeps the remembered order, and the
 * remembered column when it names none.
 */
export function openingView(
	fromUrl: { view: 'list'; columnId: number | null } | null,
	remembered: BoardViewChoice | null
): BoardViewChoice {
	if (fromUrl) {
		return {
			view: 'list',
			columnId: fromUrl.columnId ?? remembered?.columnId ?? null,
			order: remembered?.order ?? 'priority'
		};
	}
	return remembered ?? { ...BOARD_VIEW };
}

/** A column as the list's choice of column reads it; `role` where the page has it (milestone 22). */
type ListColumn = Pick<ColumnType, 'id' | 'title'> & { role?: string | null };

/**
 * The column the list opens on: the first To Do column (`isTodoColumnTitle`:
 * "To Do" or "Todo", any case, spaces trimmed), else the first that is not
 * the Options column (milestone 22: options are not where work is picked up).
 * Never the Options column (card 2527, K1), which every delivery board has: a
 * board with no other column opens on none, and the list asks for one, its
 * strip offering the Options column. It falls back where the All To Do page
 * does not.
 */
export function defaultListColumn(columns: ListColumn[]): number | null {
	const todo = columns.find((c) => isTodoColumnTitle(c.title) && c.role !== 'options');
	return (todo ?? columns.find((c) => c.role !== 'options'))?.id ?? null;
}

/** The column to show: the one chosen while it is still on the board, else the one the list opens on. */
export function resolveListColumn(columns: ListColumn[], columnId: number | null): number | null {
	if (columnId !== null && columns.some((c) => c.id === columnId)) return columnId;
	return defaultListColumn(columns);
}

// ─── The Options strip (milestone 22) ───────────────────────────────────────

/**
 * The `localStorage` key of one viewer's choice, for one board, of whether its
 * Options column is open or collapsed to a strip.
 */
export function optionsOpenKey(userId: number, boardId: number): string {
	return `dumpfire-options-open:${userId}:${boardId}`;
}

/**
 * Whether this viewer left this board's Options column open. Collapsed, false,
 * when nothing is remembered or storage cannot be read: the board opens with
 * the options out of the way, and their count on the strip.
 */
export function readOptionsOpen(userId: number, boardId: number): boolean {
	try {
		return localStorage.getItem(optionsOpenKey(userId, boardId)) === 'open';
	} catch {
		return false;
	}
}

/** Remembers the choice. Storage that cannot be written remembers nothing, and says nothing. */
export function writeOptionsOpen(userId: number, boardId: number, open: boolean): void {
	try {
		if (open) localStorage.setItem(optionsOpenKey(userId, boardId), 'open');
		else localStorage.removeItem(optionsOpenKey(userId, boardId));
	} catch {
		// Blocked or full: the strip still opens and closes, and is collapsed again on reload.
	}
}

/** How many days old an option is before the strip counts it as aging. */
export const OPTION_AGING_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Options aging (milestone 22, ruling g): how many whole days the oldest
 * option has waited, and how many have waited more than `OPTION_AGING_DAYS`.
 * An option's age runs from `optionSince`, which the board's contents give
 * each card in the Options column (its latest return to options, else its
 * creation), else from its `createdAt`: a card dropped into the column since
 * the last read. `null` for an empty column.
 */
export function optionsAging(
	cards: Pick<CardType, 'createdAt' | 'optionSince'>[],
	now: number = Date.now()
): { oldestDays: number | null; over: number } {
	let oldest: number | null = null;
	let over = 0;
	for (const card of cards) {
		const since = parseStamp(card.optionSince ?? card.createdAt);
		if (!since) continue;
		const days = Math.max(0, Math.floor((now - since.getTime()) / DAY_MS));
		if (oldest === null || days > oldest) oldest = days;
		if (days > OPTION_AGING_DAYS) over++;
	}
	return { oldestDays: oldest, over };
}

/** The header's filters, as the board applies them. */
export type ListFilter = { search: string; assigneeId: number | null; hideBlocked: boolean };

/** True while any filter is on, when counts read "shown/total" as the board's column headers do. */
export function isFiltering(filter: ListFilter): boolean {
	return filter.search.trim() !== '' || filter.assigneeId !== null || filter.hideBlocked;
}

/**
 * The board's own test of a card against the filters: the search, the
 * assignee, and Hide blocked, which hides a card only while a blocker is open.
 */
export function passesFilter(
	card: CardType,
	filter: ListFilter,
	categories: CategoryType[],
	isBlocked: (cardId: number) => boolean
): boolean {
	return (
		matchesSearch(card, filter.search, categories) &&
		(filter.assigneeId === null || (card.assignees?.some((a) => a.id === filter.assigneeId) ?? false)) &&
		(!filter.hideBlocked || !isBlocked(card.id))
	);
}

/**
 * The rows of the list: the cards that pass, in the order chosen. Priority is
 * the board's own priority sort, which puts pinned cards first and keeps the
 * board's order within a priority. Neither order changes the column's own
 * array: the board's order is not touched.
 */
export function listCards(
	cards: CardType[],
	order: ListOrder,
	categories: CategoryType[],
	keep: (card: CardType) => boolean
): CardType[] {
	const shown = cards.filter(keep);
	return order === 'priority' ? sortCards(shown, 'priority', categories) : shown;
}
