/**
 * board-stats.ts — the figures at the top of the board's Stats panel, worked
 * out from the columns the page holds (milestone 22, card 2462).
 *
 * They were worked out inside `StatsPanel.svelte`, where no test could reach
 * them, and counted every column. Here they count the board's committed work
 * only: a card in the Options column, or on an ideas board, is an option, in
 * neither the totals, the completed and overdue counts, the average age (it
 * is not aging work, ruling g, and committed work ages from its commitment,
 * the S4a review's H2) nor the per-column and per-category bars. The
 * panel shows the options apart, from `optionsCount` and the metrics answer's
 * `upstream` (`optionsLine`, `showsUpstream`, slice S4b). For a board with no
 * upstream column every figure is what the panel worked out before.
 *
 * No server imports: the panel runs in the browser.
 */
import { isCompleteColumnTitle, isUpstreamColumn } from '$lib/column-role';
import { getDueStatus } from '$lib/utils/date-utils';
import { parseStamp } from '$lib/timestamps';

/**
 * What the figures read of a card. `committedAt` is when it was committed to,
 * which its age runs from (the S4a review's H2); a card that does not carry
 * it, or has none, ages from `createdAt`, as every card made before
 * milestone 22, whose commitment is its creation.
 */
export type StatsCard = { createdAt: string; committedAt?: string | null; dueDate: string | null; categoryId: number | null };

/** What the figures read of a column, with its cards. */
export type StatsColumn = { id: number; title: string; color: string; role: string | null; cards: readonly StatsCard[] };

export type BoardStats = {
	/** Cards in the board's committed columns. */
	totalCards: number;
	/** Of those, the cards in a Complete column. */
	completedCards: number;
	/** Of those, the cards with a due date before today, in the viewer's own day (`getDueStatus`). Complete cards too, as the panel always counted them. */
	overdueCards: number;
	/** Their average age in whole days, from `committedAt ?? createdAt`, rounded; 0 for none. A card whose time cannot be read is left out. */
	avgAgeDays: number;
	/** The same, as the panel shows it: "5d". */
	avgAge: string;
	/** Each committed column with its count, in the order given, for the per-column bars. */
	columns: { id: number; title: string; color: string; count: number }[];
	/** The committed cards of each category, by category id, for the per-category bars; a category with none is absent. */
	byCategory: Map<number, number>;
	/** The board's options now: cards in its Options column, or every card of an ideas board. */
	optionsCount: number;
};

/**
 * The Stats panel's figures for `columns`, all of one board, whose kind is
 * `boardKind` ('delivery' or 'ideas'). `now` is for tests.
 */
export function boardStats(columns: readonly StatsColumn[], boardKind: string | null, now: number = Date.now()): BoardStats {
	const delivery = columns.filter((c) => !isUpstreamColumn(c, boardKind));
	const cards = delivery.flatMap((c) => c.cards);
	const ages = cards
		.map((c) => parseStamp(c.committedAt ?? c.createdAt))
		.filter((at): at is Date => at !== null)
		.map((at) => Math.floor((now - at.getTime()) / 86400000));
	const avgAgeDays = ages.length === 0 ? 0 : Math.round(ages.reduce((sum, days) => sum + days, 0) / ages.length);
	const byCategory = new Map<number, number>();
	for (const card of cards) {
		if (card.categoryId !== null) byCategory.set(card.categoryId, (byCategory.get(card.categoryId) ?? 0) + 1);
	}
	return {
		totalCards: cards.length,
		completedCards: delivery.filter((c) => isCompleteColumnTitle(c.title)).flatMap((c) => c.cards).length,
		overdueCards: cards.filter((c) => c.dueDate && getDueStatus(c.dueDate) === 'overdue').length,
		avgAgeDays,
		avgAge: `${avgAgeDays}d`,
		columns: delivery.map((c) => ({ id: c.id, title: c.title, color: c.color, count: c.cards.length })),
		byCategory,
		optionsCount: columns.filter((c) => isUpstreamColumn(c, boardKind)).reduce((sum, c) => sum + c.cards.length, 0)
	};
}

/**
 * The upstream figures of `GET /api/boards/:id/metrics`, as the panel reads
 * them (`upstreamFigures` on the server, milestone 22): counts of cards over
 * the window, but `options`, `oldestOptionDays` and `agingOptions`, which are
 * the options held now. `discardRate` is a fraction from 0 to 1.
 */
export type UpstreamFiguresShown = {
	options: number;
	committedFromOptions: number;
	returnedToOptions: number;
	discarded: number;
	sentOn: number;
	abandoned: number;
	discardRate: number | null;
	oldestOptionDays: number | null;
	agingOptions: number;
};

/** A discard rate as the panel and the reports show it: "25%", or "—" with nothing to rate. */
export function discardRateText(rate: number | null | undefined): string {
	return rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`;
}

/**
 * The Stats panel's line for the board's options (milestone 22, card 2462):
 * "Options 3 · discard rate 25%", the rate once the metrics have come, or
 * null for a board with no option, which shows no line.
 */
export function optionsLine(optionsCount: number, upstream: Pick<UpstreamFiguresShown, 'discardRate'> | null | undefined): string | null {
	if (optionsCount === 0) return null;
	return upstream ? `Options ${optionsCount} · discard rate ${discardRateText(upstream.discardRate)}` : `Options ${optionsCount}`;
}

/** What `showsUpstream` reads of the board: its kind, whether it has an upstream column, and how many cards its upstream columns hold now. */
export type UpstreamBoard = { kind: string | null; hasUpstreamColumn: boolean; upstreamCards: number };

/**
 * Whether the panel shows the upstream figures and offers the flow diagram's
 * "Show upstream" (card 2527, R12). Every delivery board has an Options
 * column now, mostly empty, so both show only where there is something to
 * show: the board has an upstream column, and either it holds a card now or
 * one of the period's figures is not zero. An ideas board, all of whose
 * columns are upstream, always shows them: they are its figures. Abandoned
 * work is not among them: it is committed work, which any board can have,
 * and the panel shows it on its own.
 */
export function showsUpstream(board: UpstreamBoard, upstream: UpstreamFiguresShown | null | undefined, timeInOptions: unknown = null): boolean {
	if (!board.hasUpstreamColumn) return false;
	if (board.kind === 'ideas' || board.upstreamCards > 0) return true;
	if (!upstream) return false;
	return (
		upstream.options > 0 ||
		upstream.committedFromOptions > 0 ||
		upstream.returnedToOptions > 0 ||
		upstream.discarded > 0 ||
		upstream.sentOn > 0 ||
		upstream.agingOptions > 0 ||
		timeInOptions !== null
	);
}
