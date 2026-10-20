/**
 * bulk-actions.ts — Bulk card operations (move, delete, priority).
 *
 * These are used by the BulkActionBar component. Each sends its writes
 * through the board state it is given (card 2280, slice B2b): every card
 * selected is changed on the screen at once, and each the server does not
 * take is put back, alone, by the board state, which reads the board once
 * afterwards. Each card is still sent in turn, one answered before the next
 * is sent, to avoid race conditions on the server. Given no board state (a
 * test), the answers alone are read.
 */

import * as api from '$lib/api';
import type { BoardState, WriteResult, WriteWords } from './board-state.svelte';
import { moveCards, removeCard } from './board-patches';

/** What the bulk changes need of the board state: its writes. */
export type BoardWriter = Pick<BoardState, 'write' | 'writeCard'>;

/** Each card the server did not take, with what to tell the reader about it. */
export type CardFailure = { cardId: number; message: string };

/** No board on the screen: each answer read alone, as the board state reads it. */
const answersOnly: BoardWriter = {
	async write(_change, send, words): Promise<WriteResult> {
		let res: Response;
		try {
			res = await send();
		} catch {
			return { ok: false, failure: words.noAnswer };
		}
		if (!res.ok) return { ok: false, failure: await api.failureMessage(res, words.refused) };
		return { ok: true, res, answer: await api.answerBody(res) };
	},
	writeCard(_cardId, _fields, send, words) {
		return answersOnly.write(null, send, words);
	}
};

/**
 * Moves all selected cards into a target column.
 * Positions them at the end of the target column.
 *
 * @returns Null when they moved; otherwise what to tell the reader: the
 * server's words, or that there was no answer. The move is all or nothing,
 * and one of more than 100 cards to another column is refused whole (card
 * 2209), so a refusal puts every card back. The answer used to be thrown
 * away, so a refusal went unseen.
 */
export async function bulkMove(
	selectedCardIds: Set<number>,
	targetColumnId: number,
	targetColumnCardCount: number,
	boardId: number,
	userName: string,
	userEmoji: string,
	boardState: BoardWriter = answersOnly
): Promise<string | null> {
	const updates: { id: number; columnId: number; position: number }[] = [];
	let pos = targetColumnCardCount;
	for (const cardId of selectedCardIds) {
		updates.push({ id: cardId, columnId: targetColumnId, position: pos++ });
	}
	const written = await boardState.write((columns) => moveCards(columns, updates), () => api.reorderCards(updates, boardId, userName, userEmoji), {
		refused: 'The cards were not moved.',
		noAnswer: 'No answer from the server. The cards may not have been moved.'
	});
	return written.ok ? null : written.failure;
}

/** Card `cardId`'s archive, sent once `before`, the card before it, is settled. */
async function archiveInTurn(before: Promise<unknown>, cardId: number, boardId: number): Promise<Response> {
	await before;
	return api.deleteCard(cardId, boardId);
}

/**
 * Archives all selected cards (`api.deleteCard` archives): every one taken
 * off the board at once, sent one at a time.
 *
 * @returns How many the server said were archived, and each card that was
 * not, with what to tell the reader about it, in the order selected.
 */
export async function bulkDelete(
	selectedCardIds: Set<number>,
	boardId: number,
	boardState: BoardWriter = answersOnly
): Promise<{ archived: number; failed: CardFailure[] }> {
	const words: WriteWords = { refused: 'The card was not archived.', noAnswer: 'No answer from the server. The card may not have been archived.' };
	let before: Promise<unknown> = Promise.resolve();
	const writes: Promise<[number, WriteResult]>[] = [];
	for (const cardId of selectedCardIds) {
		const turn = before;
		const written = boardState.write((columns) => removeCard(columns, cardId), () => archiveInTurn(turn, cardId, boardId), words);
		before = written;
		writes.push(written.then((result) => [cardId, result]));
	}
	const { taken, failed } = tally(await Promise.all(writes));
	return { archived: taken, failed };
}

/** Card `cardId`'s priority, sent once `before`, the card before it, is settled. */
async function priorityInTurn(before: Promise<unknown>, cardId: number, priority: string, boardId: number): Promise<Response> {
	await before;
	return api.updateCard(cardId, { priority, boardId });
}

/**
 * Sets the priority on all selected cards: every one changed at once, sent
 * one at a time. The answers used to be thrown away, and the page cleared the
 * selection whatever they were.
 *
 * @returns How many the server changed, and each card it did not, with what
 * to tell the reader about it, in the order selected.
 */
export async function bulkPriority(
	selectedCardIds: Set<number>,
	priority: string,
	boardId: number,
	boardState: BoardWriter = answersOnly
): Promise<{ changed: number; failed: CardFailure[] }> {
	const words: WriteWords = { refused: 'The priority was not changed.', noAnswer: 'No answer from the server. The priority may not have been changed.' };
	let before: Promise<unknown> = Promise.resolve();
	const writes: Promise<[number, WriteResult]>[] = [];
	for (const cardId of selectedCardIds) {
		const turn = before;
		const written = boardState.writeCard(cardId, { priority }, () => priorityInTurn(turn, cardId, priority, boardId), words);
		before = written;
		writes.push(written.then((result) => [cardId, result]));
	}
	const { taken, failed } = tally(await Promise.all(writes));
	return { changed: taken, failed };
}

/** How many writes were taken, and each card whose write was not. */
function tally(results: [number, WriteResult][]): { taken: number; failed: CardFailure[] } {
	const failed: CardFailure[] = [];
	for (const [cardId, result] of results) if (!result.ok) failed.push({ cardId, message: result.failure });
	return { taken: results.length - failed.length, failed };
}
