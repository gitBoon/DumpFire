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

/**
 * The column the list opens on: the first To Do column (`isTodoColumnTitle`:
 * "To Do" or "Todo", any case, spaces trimmed), else the first. The list must
 * show some column, so it falls back where the All To Do page does not.
 */
export function defaultListColumn(columns: Pick<ColumnType, 'id' | 'title'>[]): number | null {
	const todo = columns.find((c) => isTodoColumnTitle(c.title));
	return (todo ?? columns[0])?.id ?? null;
}

/** The column to show: the one chosen while it is still on the board, else the one the list opens on. */
export function resolveListColumn(columns: Pick<ColumnType, 'id' | 'title'>[], columnId: number | null): number | null {
	if (columnId !== null && columns.some((c) => c.id === columnId)) return columnId;
	return defaultListColumn(columns);
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
