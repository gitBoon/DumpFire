/**
 * api.ts — Centralised API client for the DumpFire application.
 *
 * Wraps all fetch() calls with typed functions, eliminating repeated
 * boilerplate (headers, JSON.stringify, method) from component code.
 * Each function returns the fetch Response or parsed JSON as appropriate.
 */

// ─── Internal Helpers ────────────────────────────────────────────────────────

/** Standard JSON POST/PUT/DELETE helper to reduce repetition. */
async function jsonRequest(url: string, method: string, body?: unknown): Promise<Response> {
	return fetch(url, {
		method,
		headers: { 'Content-Type': 'application/json' },
		...(body !== undefined ? { body: JSON.stringify(body) } : {})
	});
}

// ─── Cards ───────────────────────────────────────────────────────────────────

/**
 * Creates a new card in a column.
 * @returns The created card object from the server.
 */
export async function createCard(data: {
	columnId: number;
	position: number;
	boardId: number;
	title: string;
	description: string;
	priority: string;
	colorTag: string;
	categoryId: number | null;
	dueDate: string | null;
}): Promise<Response> {
	return jsonRequest('/api/cards', 'POST', data);
}

/**
 * Updates an existing card's properties.
 * Only send the fields you want to change.
 */
export async function updateCard(cardId: number, updates: Record<string, unknown>): Promise<Response> {
	return jsonRequest(`/api/cards/${cardId}`, 'PUT', updates);
}

/**
 * Deletes a card and all its subtasks.
 * @param boardId — Needed for activity logging on the server.
 */
export async function deleteCard(cardId: number, boardId: number): Promise<Response> {
	return jsonRequest(`/api/cards/${cardId}`, 'DELETE', { boardId });
}

/**
 * Batch-reorders cards across columns.
 * Used after drag-and-drop to persist the new positions.
 */
export async function reorderCards(updates: { id: number; columnId: number; position: number }[], boardId: number, userName: string, userEmoji: string): Promise<Response> {
	return jsonRequest('/api/cards/reorder', 'PUT', { updates, boardId, userName, userEmoji });
}

// ─── Columns ─────────────────────────────────────────────────────────────────

/**
 * Creates a new column on a board.
 */
export async function createColumn(data: {
	boardId: number;
	title: string;
	position: number;
	color: string;
}): Promise<Response> {
	return jsonRequest('/api/columns', 'POST', data);
}

/**
 * Updates column properties (title, colour, etc.).
 */
export async function updateColumn(colId: number, updates: Record<string, unknown>): Promise<Response> {
	return jsonRequest(`/api/columns/${colId}`, 'PUT', updates);
}

/**
 * Deletes a column and all its cards.
 */
export async function deleteColumn(colId: number, boardId: number): Promise<Response> {
	return jsonRequest(`/api/columns/${colId}`, 'DELETE', { boardId });
}

/**
 * Batch-reorders columns within a board.
 */
export async function reorderColumns(updates: { id: number; position: number }[], boardId: number): Promise<Response> {
	return jsonRequest('/api/columns/reorder', 'PUT', { updates, boardId });
}

// ─── Boards ──────────────────────────────────────────────────────────────────

/**
 * Creates a new board (optionally as a sub-board of a card).
 */
export async function createBoard(data: {
	name: string;
	emoji: string;
	parentCardId?: number;
}): Promise<Response> {
	return jsonRequest('/api/boards', 'POST', data);
}

/**
 * Updates board properties (name, emoji, parentCardId).
 */
export async function updateBoard(boardId: number, updates: Record<string, unknown>): Promise<Response> {
	return jsonRequest(`/api/boards/${boardId}`, 'PUT', updates);
}

/**
 * Deletes a board and all its columns/cards/subtasks.
 */
export async function deleteBoardApi(boardId: number): Promise<Response> {
	return fetch(`/api/boards/${boardId}`, { method: 'DELETE' });
}

// ─── Categories ──────────────────────────────────────────────────────────────

/**
 * Creates a new category on a board.
 */
export async function createCategory(data: {
	boardId: number;
	name: string;
	color: string;
}): Promise<Response> {
	return jsonRequest('/api/categories', 'POST', data);
}

/**
 * Deletes a category. Cards using it will have their categoryId set to null.
 */
export async function deleteCategoryApi(categoryId: number): Promise<Response> {
	return fetch(`/api/categories/${categoryId}`, { method: 'DELETE' });
}

// ─── Subtasks ────────────────────────────────────────────────────────────────

/**
 * Creates a new subtask on a card.
 */
export async function createSubtask(data: {
	cardId: number;
	title: string;
	description: string;
	priority: string;
	colorTag: string;
	dueDate: string | null;
	completed: boolean;
	boardId: number;
}): Promise<Response> {
	return jsonRequest('/api/subtasks', 'POST', data);
}

/**
 * Updates a subtask's properties (e.g. toggling completion).
 */
export async function updateSubtask(subtaskId: number, updates: Record<string, unknown>): Promise<Response> {
	return jsonRequest(`/api/subtasks/${subtaskId}`, 'PUT', updates);
}

// ─── Labels ──────────────────────────────────────────────────────────────────

/**
 * Toggles a label on/off for a card.
 * The server handles the add/remove logic.
 */
export async function toggleLabel(cardId: number, labelId: number, boardId: number): Promise<Response> {
	return jsonRequest('/api/labels', 'PUT', { cardId, labelId, boardId });
}

// ─── Activity ────────────────────────────────────────────────────────────────

/**
 * Logs an activity event for a board (e.g. card created, moved, completed).
 * Fire-and-forget — the UI doesn't wait for a response.
 */
export function logActivity(boardId: number, action: string, detail: string, userName: string, userEmoji: string, cardId?: number): void {
	jsonRequest('/api/activity', 'POST', {
		boardId,
		cardId: cardId || null,
		action,
		detail,
		userName,
		userEmoji
	});
}

/**
 * Fetches the activity log for a board.
 * @returns An array of activity entries.
 */
export async function loadActivities(boardId: number): Promise<Response> {
	return fetch(`/api/activity?boardId=${boardId}`);
}

// ─── XP ──────────────────────────────────────────────────────────────────────

/**
 * Fetches the XP leaderboard data.
 * @returns An array of XP entries.
 */
export async function fetchXp(): Promise<Response> {
	return fetch('/api/xp');
}
