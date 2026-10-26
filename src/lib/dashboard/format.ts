/**
 * How the dashboard says how long ago a moment was: a board's last activity
 * in the boards table, an entry's time in the sidebar's Recent Activity
 * (card 2281, slice C2: moved from src/routes/+page.svelte as written). And
 * how a board row gives its count: "N ideas" for an ideas board (milestone 22).
 */
import { parseStamp } from '$lib/timestamps';

export function timeAgo(dateStr: string | null | undefined): string {
	const dateObj = parseStamp(dateStr);
	if (!dateObj) return 'unknown';
	const diff = Math.floor((Date.now() - dateObj.getTime()) / 1000);
	if (diff < 60) return 'just now';
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

/** What the boards table reads of a board's row for its count (milestone 22, card 2462). */
export type BoardRowFigures = { kind?: string | null; totalCards: number; optionsCount?: number };

/**
 * A board row's count, as the boards table shows it: "N ideas" for an ideas
 * board, whose every card is an idea and whose `totalCards` is 0, and "N
 * cards" for any other, its committed cards. A delivery board's options are
 * in none of its figures (`boardRowTitle` says so).
 */
export function boardRowCount(board: BoardRowFigures): string {
	if (board.kind === 'ideas') {
		const ideas = board.optionsCount ?? 0;
		return `${ideas} idea${ideas !== 1 ? 's' : ''}`;
	}
	return `${board.totalCards} card${board.totalCards !== 1 ? 's' : ''}`;
}

/** The number a row's count shows, which the Cards sort orders by: an ideas board's ideas, any other board's cards. */
export function boardRowSize(board: BoardRowFigures): number {
	return board.kind === 'ideas' ? (board.optionsCount ?? 0) : board.totalCards;
}

/** The count's tooltip on a delivery board with options: they are not counted. Null otherwise. */
export function boardRowTitle(board: BoardRowFigures): string | null {
	const options = board.optionsCount ?? 0;
	if (board.kind === 'ideas' || options === 0) return null;
	return `Committed cards only: ${options} option${options !== 1 ? 's' : ''} in its Options column ${options !== 1 ? 'are' : 'is'} not counted`;
}

/** Whether a board row draws a completion bar: never for an ideas board, which completes nothing. */
export function drawsCompletion(board: BoardRowFigures): boolean {
	return board.kind !== 'ideas';
}
