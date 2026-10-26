/**
 * ideas-board.ts — what the board page decides and sends for a board's kind
 * and for Send to board (milestone 22, card 2463, slice S5b; moved out of the
 * page by the S5b review's P3, so that each runs in a test).
 *
 *   - `ideasConversion` and `deliverySwitch`: from the columns the page draws
 *     and the archived cards counted by column, either what the server would
 *     refuse, in its own words, said before anything is asked (the S1b review's
 *     U5), or the question to ask and the count to send.
 *   - `convertBoardAndRead` and `switchBoardKindAndRead`: the change sent
 *     through the board state, and then the board's contents read again, as
 *     the answer is the board alone and its columns have changed.
 *   - `columnDeleteRefusal`: why a column holding options cannot be deleted,
 *     said before the delete is asked (ruling m; the S5a review's L2).
 *   - `sendOption`: a Send through the board state, the card taken off the
 *     board once it is sent and its window closed, and what to say.
 *   - `isUpstreamCard`: whether a card is an option, for All Tasks, from the
 *     card's column and its board's kind.
 *
 * Each reads only what it is given, and the board state's writes hold the
 * board's reads while they are out (slice B2b).
 */
import * as api from '$lib/api';
import { columnRole, isOptionsColumn, isUpstreamColumn } from '$lib/column-role';
import type { CardType, ColumnType } from '$lib/types';
import * as boardActions from './board-actions';
import { removeCard } from './board-patches';
import type { BoardState, WriteResult, WriteWords } from './board-state.svelte';

/** What the page does with a kind change: say why not, or ask, sending `cards` once it is confirmed. */
export type KindQuestion = { refused: string } | { question: string; cards: number };

/** How many cards the columns hold, live, and how many archived cards `archived` counts. */
function counts(columns: readonly ColumnType[], archived: ReadonlyMap<number, number>) {
	return {
		live: columns.reduce((n, column) => n + column.cards.length, 0),
		archived: [...archived.values()].reduce((n, k) => n + k, 0)
	};
}

/** A card with a sub-board, one the viewer can open or one counted only. */
export function hasSubBoards(card: Pick<CardType, 'subBoards' | 'hiddenOpenCount'>): boolean {
	return card.subBoards.length > 0 || (card.hiddenOpenCount ?? 0) > 0;
}

/**
 * "Make this an ideas board…" (ruling i): what the server would refuse of a
 * board holding cards, said at once, a live card with a sub-board or a To Do,
 * On Hold or Complete column holding cards, live or archived (the S5a
 * review's L1); else the question, naming the counts and the empty titled
 * columns that go, or, for a board with no card at all, the columns the ideas
 * board's replace (decision M22-18). A hidden or archived sub-board is the
 * server's to refuse (the S5b review's P4).
 */
export function ideasConversion(name: string, columns: readonly ColumnType[], archived: ReadonlyMap<number, number>): KindQuestion {
	const { live, archived: archivedCount } = counts(columns, archived);
	const titled = columns.filter((column) => !isOptionsColumn(column) && columnRole(column.title) !== null);
	if (live + archivedCount > 0) {
		const parent = columns.flatMap((column) => column.cards).find(hasSubBoards);
		if (parent) return { refused: api.ideasBoardSubBoardRefusal(parent.title) };
		const held = (column: ColumnType) => column.cards.length + (archived.get(column.id) ?? 0);
		for (const column of titled) {
			const role = columnRole(column.title);
			if (role && held(column) > 0) return { refused: api.ideasBoardColumnRefusal(column.title, held(column), role) };
		}
	}
	const removed = live + archivedCount > 0 ? titled.map((column) => column.title) : [];
	return {
		question: api.ideasBoardWarning(name, live, archivedCount, columns.map((column) => column.title), removed),
		cards: live + archivedCount
	};
}

/** "Make this a delivery board…": refused while the ideas board holds any card, live or archived; else the question. */
export function deliverySwitch(name: string, columns: readonly ColumnType[], archived: ReadonlyMap<number, number>): KindQuestion {
	const { live, archived: archivedCount } = counts(columns, archived);
	if (live + archivedCount > 0) return { refused: api.deliveryBoardRefusal(live + archivedCount) };
	return { question: api.deliveryBoardWarning(name, columns.map((column) => column.title)), cards: 0 };
}

/**
 * The conversion, `cards` the count the question named, then the board's
 * contents read again once it is taken: its kind and columns change, and the
 * answer is not the board's contents.
 */
export async function convertBoardAndRead(boardState: BoardState, boardId: number, cards: number, words: WriteWords): Promise<WriteResult> {
	const written = await boardState.write(null, () => boardActions.convertBoard(boardId, cards), words);
	if (written.ok) await boardState.refreshNow();
	return written;
}

/** An empty board's kind switched, then its contents read again: a PUT answers the board row alone. */
export async function switchBoardKindAndRead(boardState: BoardState, boardId: number, kind: 'delivery' | 'ideas', words: WriteWords): Promise<WriteResult> {
	const written = await boardState.write(null, () => boardActions.setBoardKind(boardId, kind), words);
	if (written.ok) await boardState.refreshNow();
	return written;
}

/**
 * Why column `columnId` cannot be deleted, said at once instead of asked and
 * then refused: an Options column holding options (ruling m), or a column of
 * an ideas board holding ideas (the S5a review's L2), in the server's words.
 * Null for any other column, or one that holds only archived cards, which go
 * with it.
 */
export function columnDeleteRefusal(columns: readonly ColumnType[], columnId: number, boardKind: string | null): string | null {
	const column = columns.find((c) => c.id === columnId);
	if (!column || column.cards.length === 0 || !isUpstreamColumn(column, boardKind)) return null;
	const live = column.cards.length;
	const where = isOptionsColumn(column) ? 'This Options column' : 'This column of an ideas board';
	const what = isOptionsColumn(column) ? ['option', 'options'] : ['idea', 'ideas'];
	return `${where} still holds ${live === 1 ? `1 ${what[0]}: move it out, or archive it to discard it, first.` : `${live} ${what[1]}: move them out, or archive them to discard them, first.`}`;
}

/** Where a Send goes. */
export type SendTarget = { boardId: number; boardName: string; to: 'options' | 'todo' };

/** What a Send came to: the server's words, or what to say, in order, and the goal it left. */
export type SendOutcome = { ok: false; failure: string } | { ok: true; said: string[]; leftGoal: string | null };

/**
 * Send an option (the Send window's Send). Sent through the board state,
 * which holds the reads while it is out and says a refusal in the server's
 * words; once it is sent the card is taken off the board from the answer,
 * with no read, and its window closed if it is open on it. Says where it
 * went, that it was committed when it went to To Do, and the goal of this
 * board it left, as a move to another board does.
 */
export async function sendOption(
	boardState: BoardState,
	cardWindow: { cardId: number | null; close(): void },
	card: Pick<CardType, 'id' | 'title'>,
	target: SendTarget,
	words: WriteWords
): Promise<SendOutcome> {
	const written = await boardState.write(null, () => api.sendCard(card.id, target.boardId, target.to), words, (columns) => removeCard(columns, card.id).columns);
	if (!written.ok) return { ok: false, failure: written.failure };
	if (cardWindow.cardId === card.id) cardWindow.close();
	const said = [api.cardSentMessage(card.title, target.boardName, target.to)];
	if (written.answer?.committed === true) said.push(`Committed "${card.title}"`);
	return { ok: true, said, leftGoal: api.leftMilestoneNotice(written.answer) };
}

/**
 * Whether the card in column `columnId` is an option, for All Tasks' archive
 * question (the S3 review's E6): its column is the Options column, or its
 * board, which the load gives with its kind, is an ideas board.
 */
export function isUpstreamCard(
	columnId: number | null | undefined,
	columns: readonly { id: number; boardId: number; role: string | null }[],
	boards: readonly { id: number; kind?: string | null }[]
): boolean {
	const column = columns.find((c) => c.id === columnId);
	return column !== undefined && isUpstreamColumn(column, boards.find((b) => b.id === column.boardId)?.kind ?? null);
}
