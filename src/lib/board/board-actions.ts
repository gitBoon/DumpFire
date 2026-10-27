/**
 * board-actions.ts — Board-level mutations (name, emoji, columns).
 *
 * All functions accept the required IDs/data and return the answer, for the
 * caller to check: the board page sends each through its board state, which
 * shows the change at once and puts it back on a refusal (card 2280, slice
 * B2b). They delegate to the shared API client and handle any necessary
 * position calculation logic (e.g. column insertion positions). The board's
 * categories are added and deleted by the page's category window through the
 * API itself.
 */

import * as api from '$lib/api';
import type { ColumnType } from '$lib/types';

// ─── Board Identity ──────────────────────────────────────────────────────────

/** Renames the board. The page sends no empty name. Returns the answer. */
export async function saveBoardName(boardId: number, name: string): Promise<Response> {
	return api.updateBoard(boardId, { name: name.trim() });
}

/** Updates the board emoji. Returns the answer. */
export async function saveBoardEmoji(boardId: number, emoji: string): Promise<Response> {
	return api.updateBoard(boardId, { emoji });
}

/**
 * Makes the board an ideas board, cards and all, once the page has asked
 * (milestone 22, card 2463, ruling i): `cards` is the count the question
 * named. Returns the answer: the board as written, with its columns.
 */
export async function convertBoard(boardId: number, cards: number): Promise<Response> {
	return api.convertBoard(boardId, cards);
}

/**
 * Switches an empty board's kind (ruling j, decision M22-18): its columns
 * are replaced with the other kind's. A board holding cards is refused.
 * Returns the answer: the board row alone, so the page reads its columns again.
 */
export async function setBoardKind(boardId: number, kind: 'delivery' | 'ideas'): Promise<Response> {
	return api.updateBoard(boardId, { kind });
}

// ─── Columns ─────────────────────────────────────────────────────────────────

/**
 * Calculates insertion position based on user's choice and adds a new column.
 * Returns the answer: a success answers the new column, `201`.
 *
 * @param positionChoice — 'start', 'end', or 'after-{columnId}'
 * @param columns — Current board columns (for calculating relative positions)
 */
export async function addColumn(
	boardId: number,
	title: string,
	color: string,
	positionChoice: string,
	columns: ColumnType[]
): Promise<Response> {
	let position: number;
	if (positionChoice === 'end') {
		position = columns.length > 0 ? Math.max(...columns.map((c) => c.position)) + 1 : 0;
	} else if (positionChoice === 'start') {
		position = columns.length > 0 ? Math.min(...columns.map((c) => c.position)) - 1 : 0;
	} else {
		// 'after-{columnId}' — insert between this column and the next
		const afterId = Number(positionChoice.replace('after-', ''));
		const afterCol = columns.find((c) => c.id === afterId);
		const afterIdx = columns.indexOf(afterCol!);
		if (afterIdx < columns.length - 1) {
			position = (afterCol!.position + columns[afterIdx + 1].position) / 2;
		} else {
			position = afterCol!.position + 1;
		}
	}

	return api.createColumn({
		boardId,
		title: title.trim() || 'New Column',
		position,
		color
	});
}

/**
 * Updates arbitrary column properties (title, colour, etc.). Returns the
 * answer, for the caller to check: a rename that would change whether the
 * column is a Complete column is refused while it holds cards (card 2134).
 */
export async function updateColumn(colId: number, updates: Record<string, unknown>, boardId: number): Promise<Response> {
	return api.updateColumn(colId, { ...updates, boardId });
}

/** Deletes a column via the API. Returns the answer, for the caller to check. */
export async function deleteColumn(colId: number, boardId: number): Promise<Response> {
	return api.deleteColumn(colId, boardId);
}
