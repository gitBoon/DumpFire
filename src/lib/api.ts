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

// ─── Failures ────────────────────────────────────────────────────────────────

/**
 * Why a request was refused or failed, in words for the page: the server's
 * own message if the answer carries one, or `fallback`.
 *
 * Every failure the API answers is `{ message }`, which is what SvelteKit's
 * `error()` sends, and `tests/error-shape.test.ts` keeps it so. An answer
 * without one, a proxy's error page among them, gets the fallback. So does
 * "Internal Error", which is what SvelteKit answers for a failure it was not
 * told about, and says less than the fallback does.
 */
export async function failureMessage(res: Response, fallback: string): Promise<string> {
	try {
		const body = await res.json();
		const said = body?.message;
		if (typeof said === 'string' && said.trim() && said !== 'Internal Error') return said;
	} catch {
		// Not JSON.
	}
	return fallback;
}

// ─── Uploads ─────────────────────────────────────────────────────────────────
//
// A file that is not accepted fails in one of four ways, and the page that
// sent it says which. They used to be one message on the import ("Invalid
// backup file", which blamed the file for a proxy's size limit) and none at
// all on a card's attachments.
//
//   1. The file could not be read on this computer.   `uploadNotRead`
//   2. The server gave no answer.                     `uploadNoAnswer`
//   3. Something answered that was not DumpFire.      `uploadFailure`
//   4. DumpFire answered 413: it is too large.        `uploadFailure`
//
// Anything else DumpFire answers is said in its own words, by `failureMessage`.

/** The body of an answer, if it is a JSON object, and otherwise null. It reads the answer: give it a `clone()` to read it twice. */
export async function answerBody(res: Response): Promise<Record<string, unknown> | null> {
	try {
		const body: unknown = await res.json();
		return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
	} catch {
		// Not JSON.
		return null;
	}
}

/** A number of bytes as a person reads it: `512 KB`, `26 MB`, `1.5 GB`. */
export function sizeInWords(bytes: number): string {
	const shown = (value: number, unit: string) => `${Number.isInteger(value) ? value : value.toFixed(1)} ${unit}`;
	if (bytes >= 1024 ** 3) return shown(bytes / 1024 ** 3, 'GB');
	if (bytes >= 1024 ** 2) return shown(bytes / 1024 ** 2, 'MB');
	if (bytes >= 1024) return shown(bytes / 1024, 'KB');
	return `${bytes} bytes`;
}

/** The first way: `what` could not be read where it is, so nothing was sent. */
export function uploadNotRead(what: string): string {
	return `${what} could not be read on this computer, so nothing was sent.`;
}

/** The second: no answer. A request that got none is not known to have failed, and is said so. */
export function uploadNoAnswer(what: string): string {
	return `No answer from the server. It is not known whether ${what} was accepted.`;
}

/**
 * Why an upload that was answered was not accepted, in words for the page.
 * `what` names it, to begin a sentence: "The backup", "notes.pdf".
 *
 * An answer that is not a JSON object is not DumpFire's: every failure
 * DumpFire answers is `{ message }`. It is a proxy's own page, and when a
 * proxy turns an upload away it is nearly always for its size (nginx refuses
 * a body over 1 MB unless it is told otherwise), so that is what is said,
 * with the status it gave. A success that is not JSON is a page too, and
 * what a browser is shown in place of an answer when its session has ended.
 *
 * A 413 from DumpFire carries the limit of the route it was sent to, as
 * `limitBytes`, and that is said with it.
 */
export async function uploadFailure(res: Response, what: string): Promise<string> {
	const body = await answerBody(res.clone());

	if (body === null) {
		return res.ok
			? `${what} was not accepted: the answer was a page and not DumpFire's (HTTP ${res.status}). You may have been signed out. Reload the page and try again.`
			: `${what} was refused before it reached DumpFire, probably a size limit at the proxy in front of it (HTTP ${res.status}).`;
	}
	if (res.status === 413) {
		const limit = body.limitBytes;
		return typeof limit === 'number' && Number.isFinite(limit)
			? `${what} is larger than this server accepts. The limit here is ${sizeInWords(limit)}.`
			: `${what} is larger than this server accepts.`;
	}
	return failureMessage(res, `${what} was not accepted (HTTP ${res.status}).`);
}

/**
 * Send a delete and say how it went: null if the server answered that it was
 * done, and if not, what to tell the reader. `what` names the thing in the
 * fallback: "card", "board". `done` is what the request does to it: a card
 * deleted from a board is archived (`deleteCard` below), and is said to be; a
 * member taken off a team or a card is removed. A restore, which undoes an
 * archive, is asked the same way and is said to be restored.
 *
 * A request that got no answer is not known to have failed, and is said so.
 */
export async function deleteFailure(
	send: () => Promise<Response>,
	what: string,
	done: 'deleted' | 'archived' | 'removed' | 'restored' = 'deleted'
): Promise<string | null> {
	try {
		const res = await send();
		return res.ok ? null : await failureMessage(res, `The ${what} was not ${done}.`);
	} catch {
		return `No answer from the server. The ${what} may not have been ${done}.`;
	}
}

// ─── What a permanent delete takes ───────────────────────────────────────────
//
// The texts the confirmations show, in one place so that every page says the
// same thing. They describe `$lib/server/deletes.ts`, and the trash and its 30
// days in `$lib/server/uploads.ts` (`TRASH_DAYS`), which a page cannot import.
// Change them together.

const TRASH_SENTENCE = 'Attachment files are kept in a trash for 30 days and then removed.';

/** What goes with a card that is deleted for good. */
export function cardDeleteWarning(title: string): string {
	return `Permanently delete "${title}"? Its subtasks, comments and dependency links go with it, and so does every sub-board under it with everything on it. ${TRASH_SENTENCE}`;
}

/** What goes with a column: every card in it, deleted for good and not archived. */
export function columnDeleteWarning(title: string): string {
	return `Delete "${title}" and every card in it? The cards are deleted for good, not archived, each with its subtasks, comments and dependency links and with every sub-board under it. ${TRASH_SENTENCE}`;
}

/** What goes with a board or a sub-board, and what stays. */
export function boardDeleteWarning(name: string): string {
	return `Permanently delete "${name}"? Everything on it goes: its columns and cards, every sub-board under it, and any report schedules for it. Cards on other boards that were in one of its milestones stay, in no milestone. Its card categories stay, with no board. ${TRASH_SENTENCE}`;
}

/**
 * What putting an existing board under a card does, asked before it is done.
 * The dashboard lists top-level boards only, and shows a sub-board on its
 * parent board's tile, so a member of the board who cannot open the parent
 * board no longer sees it there. Whoever can open the parent board sees the
 * sub-board on its card only if they can open the sub-board too (card 2130),
 * and until card 2150 is built the parent board's reports, scheduled ones
 * included, walk into it for all of them (`reports.ts`). A card moved to
 * another board takes its sub-boards with it. A card is not
 * completed while a board under it has open cards (`getCompletionBlocker`);
 * and a sub-board goes with its card, the card's column and the card's board
 * (`deletes.ts`).
 */
export function subBoardLinkWarning(name: string): string {
	return `Put "${name}" under this card? It will be shown on this card instead of on the dashboard, and its members who cannot open this board will no longer see it on theirs. Those who can open this board see it on this card only if they can open "${name}" too, but this board's reports, scheduled ones included, will include its cards for all of them. This board's editors can move this card, taking "${name}" with it. This card cannot be completed while "${name}" has cards that are not complete, and "${name}" is deleted for good, with everything on it, if this card, its column or this board is ever deleted for good.`;
}

const PURGE_TAKES = `Each goes with its subtasks, comments and dependency links, and with every sub-board under it and everything on it. ${TRASH_SENTENCE}`;

/** What goes when every archived card is purged. */
export const PURGE_WARNING = `Permanently delete every archived card on every board? ${PURGE_TAKES}`;

/** The same, as the description beside the button. */
export const PURGE_DESCRIPTION = `Permanently deletes every archived card on every board. ${PURGE_TAKES}`;

/** What goes when a board's cards are cleared, and what stays. */
export function clearCardsWarning(boardName: string): string {
	return `Permanently delete every card on "${boardName}", archived ones included? Each goes with its subtasks, comments and dependency links, and with every sub-board under it and everything on it. The board, its columns and its categories are kept. ${TRASH_SENTENCE}`;
}

/**
 * What goes with a deleted user, and what is left (`deleteUser`).
 *
 * A template can be deleted by whoever made it or an administrator, and a
 * milestone that belongs to no board can be changed by the same two. A request
 * can be accepted, rejected or replied to by whoever it is addressed to or an
 * administrator. With the user gone, each of those leaves the administrators.
 *
 * A board's owner is whoever created it (`boards.created_by`) and any member
 * with the role `owner` (`getBoardRole`). The key clears the first and the
 * creator's `board_members` row cascades, so a board nobody else was made an
 * owner of has none. Its sharing, its deletion and putting it under a card
 * (`requireSubBoardLink`) are an owner's or an administrator's, and what its
 * other members and teams could do, they still can.
 */
export function userDeleteWarning(username: string): string {
	return `Delete user "${username}"? Their comments, API keys and report schedules are deleted, and so are their team and board memberships and their card assignments. Files they uploaded and the milestones, templates and dependencies they created are kept. Boards they created are kept, and each board's other members and teams keep their access. A board with no other owner then has no owner, and only an administrator can change who it is shared with, put it under a card or delete it. Templates they created, and milestones of theirs that belong to no board, can then be managed by administrators only. Requests addressed to them are kept, and only an administrator can then accept, reject or reply to them. Their XP stays on the leaderboard.`;
}

/** What a reset clears and what it keeps (`api/admin/reset`). */
export const RESET_WARNING = `This clears everything: every board, card, user, team and setting. Only the system log and the backup history are kept. ${TRASH_SENTENCE} Ids are not reused, so new boards and cards are numbered on from the old ones. You will be signed out and will set DumpFire up from scratch.`;

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
	/** Left out, a card's priority is medium, and its due date and category none. */
	priority?: string;
	colorTag: string;
	categoryId?: number | null;
	dueDate?: string | null;
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
 * What archiving a card does, asked before it is done: on a board, and in the
 * card's window in All Tasks. `title` is the card's, when it is known.
 */
export function cardArchiveWarning(title?: string | null): string {
	return `Archive ${title ? `"${title}"` : 'this card'}? It is taken off the board and nothing on it is deleted. It can be restored from Archived Cards, in the More menu.`;
}

/**
 * Archives a card. `DELETE` with no `permanent` stamps the card as archived
 * and touches nothing else: its subtasks, comments, files, dependency links
 * and sub-boards are as they were, and a restore brings it back whole.
 * @param boardId — Sent in the body. The server does not read it: the board
 * is the card's own.
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

// ─── Dependencies ────────────────────────────────────────────────────────────
//
// A row of the card window's two lists is a card or a subtask. Its `cardId`
// is the row's own id: for a subtask row, the subtask's, which names some
// other card if it is taken for a card's. The remove button sent it as a card
// whatever the row was, and removed nothing or another link; the row's link
// opened that other card. Both are built here from the row's kind.

/** Which list of the card window: what this card waits on, or what waits on it. */
export type DependencyMode = 'blocked-by' | 'blocks';

/** A row of those lists, as far as these need it. */
export type DependencyEnd = { kind: 'card' | 'subtask'; cardId: number; parentCardId?: number | null };

/**
 * The body naming the other end of a link, to add it or remove it at
 * `/api/cards/{id}/dependencies`: `dependsOnCardId` or `dependsOnSubtaskId`
 * for an end this card waits on, `blocksCardId` or `blocksSubtaskId` for one
 * that waits on this card.
 */
export function dependencyEndBody(mode: DependencyMode, end: DependencyEnd): Record<string, number> {
	const subtask = end.kind === 'subtask';
	if (mode === 'blocked-by') return subtask ? { dependsOnSubtaskId: end.cardId } : { dependsOnCardId: end.cardId };
	return subtask ? { blocksSubtaskId: end.cardId } : { blocksCardId: end.cardId };
}

/**
 * How a row reads, and where its link goes. A card: "#12", opening card 12.
 * A subtask: "subtask #45 of #12", opening its card, 12. Made from the kind
 * and the ids alone, so that it reads the same for a row whose title and
 * board are not shown. A subtask whose card is not known has no link, and nor
 * has a withheld row, on a board the caller cannot open (card 2129): it would
 * open a page that refuses them.
 */
export function dependencyRow(
	end: DependencyEnd & { boardId: number | null; withheld?: boolean }
): { label: string; href: string | undefined } {
	const opens = (card: number) => (end.withheld || end.boardId === null ? undefined : `/board/${end.boardId}?card=${card}`);
	if (end.kind === 'card') return { label: `#${end.cardId}`, href: opens(end.cardId) };
	if (end.parentCardId == null) return { label: `subtask #${end.cardId}`, href: undefined };
	return { label: `subtask #${end.cardId} of #${end.parentCardId}`, href: opens(end.parentCardId) };
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
	/** Left out, a subtask's priority is medium, and its due date none. */
	priority?: string;
	colorTag: string;
	dueDate?: string | null;
	completed: boolean;
	boardId: number;
}): Promise<Response> {
	return jsonRequest('/api/subtasks', 'POST', data);
}

// ─── Labels ──────────────────────────────────────────────────────────────────
//
// Each returns the answer, for the caller to check: a label's name is text of
// 1 to 200 characters and its colour `#rrggbb`, and a refusal says which in
// its `message` (card 2010).

/**
 * Toggles a label on/off for a card.
 * The server handles the add/remove logic.
 */
export async function toggleLabel(cardId: number, labelId: number, boardId: number): Promise<Response> {
	return jsonRequest('/api/labels', 'PUT', { cardId, labelId, boardId });
}

/** Creates a label on a board. A success answers the new label, `201`. */
export async function createLabel(boardId: number, name: string, color: string): Promise<Response> {
	return jsonRequest('/api/labels', 'POST', { boardId, name, color });
}

/** Renames or recolours a label: send either, or both. A success answers the label as it is now. */
export async function updateLabel(labelId: number, changes: { name?: string; color?: string }): Promise<Response> {
	return jsonRequest('/api/labels', 'PATCH', { id: labelId, ...changes });
}

/** Deletes a label, which takes it off every card of its board. */
export async function deleteLabel(labelId: number): Promise<Response> {
	return jsonRequest('/api/labels', 'DELETE', { id: labelId });
}

// ─── Activity ────────────────────────────────────────────────────────────────

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
