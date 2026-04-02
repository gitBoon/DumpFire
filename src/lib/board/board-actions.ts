/**
 * board-actions.ts — Board-level mutations (name, emoji, columns, categories).
 *
 * All functions accept the required IDs/data and return promises.
 * They delegate to the shared API client and handle any necessary
 * position calculation logic (e.g. column insertion positions).
 */

import * as api from '$lib/api';
import type { ColumnType } from '$lib/types';

// ─── Board Identity ──────────────────────────────────────────────────────────

/** Updates the board name on the server. */
export async function saveBoardName(boardId: number, name: string): Promise<void> {
	if (name.trim()) {
		await api.updateBoard(boardId, { name: name.trim() });
	}
}

/** Updates the board emoji on the server. */
export async function saveBoardEmoji(boardId: number, emoji: string): Promise<void> {
	await api.updateBoard(boardId, { emoji });
}

// ─── Columns ─────────────────────────────────────────────────────────────────

/**
 * Calculates insertion position based on user's choice and adds a new column.
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
): Promise<void> {
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

	await api.createColumn({
		boardId,
		title: title.trim() || 'New Column',
		position,
		color
	});
}

/** Updates arbitrary column properties (title, colour, etc.). */
export async function updateColumn(colId: number, updates: Record<string, unknown>, boardId: number): Promise<void> {
	await api.updateColumn(colId, { ...updates, boardId });
}

/** Deletes a column via the API. */
export async function deleteColumn(colId: number, boardId: number): Promise<void> {
	await api.deleteColumn(colId, boardId);
}

/** Persists a new column ordering after drag-and-drop. */
export async function reorderColumns(columns: ColumnType[], boardId: number): Promise<void> {
	const updates = columns.map((col, i) => ({ id: col.id, position: i }));
	await api.reorderColumns(updates, boardId);
}

// ─── Categories ──────────────────────────────────────────────────────────────

/** Creates a new category on a board. */
export async function addCategory(boardId: number, name: string, color: string): Promise<void> {
	if (!name.trim()) return;
	await api.createCategory({ boardId, name: name.trim(), color });
}

/** Deletes a category by ID. */
export async function deleteCategory(categoryId: number): Promise<void> {
	await api.deleteCategoryApi(categoryId);
}
