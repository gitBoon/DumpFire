/**
 * deletes.ts — what goes when a card, a column or a board is deleted for good.
 *
 * One routine for both API trees and for the admin routes that delete cards
 * wholesale, so that every one of them removes the same things. The foreign
 * keys take most of it by cascade. Three things they do not take:
 *
 *   - `work_dependencies`. Its ids are a card's or a subtask's, with no key,
 *     so nothing cascades. Every link with something deleted at either end is
 *     removed here, in the same transaction.
 *   - Attachment files. The rows cascade and the files do not. The rows are
 *     read before they go, and the files are moved to the trash once the
 *     delete is committed (`uploads.ts`).
 *   - What names a deleted board by id with no key: `cards.milestone_id`, for
 *     a card elsewhere in one of the board's milestones, and a report
 *     schedule for the board. And its card categories, whose key would keep
 *     them as categories of no board, which are listed to everyone.
 *
 * Sub-boards are deleted by name too, and not left to the cascade from the
 * card they hang from: on a database where the migration runner left
 * `boards` in the shape it had, `boards.parent_card_id` has no key.
 *
 * Archiving is not deleting. `archiveCard` stamps the card and writes the
 * entry, and touches nothing else, so that restoring it brings it back whole.
 *
 * A user is deleted here too (`deleteUser`). The keys take what was theirs,
 * except for five columns that name a user with no `ON DELETE` action, which
 * are cleared first.
 *
 * Every function here opens its own `inTransaction`. A route calls it inside
 * the one in which it read the row and checked the caller, and that makes
 * this a savepoint of it. None of them checks access: that is the route's.
 *
 * The open pages of every board a delete removes or empties are told, once it
 * is committed (card 2108): each sub-board that went, a deleted board and the
 * board of the card it hung from, and each board a purge or a clear took
 * cards from. A route still tells the board of the card or column it deleted
 * itself. See `tell`. A board a purge or a clear took cards from and that
 * went with them, as a board in a loop does, is told it was deleted, and a
 * line in the system log names it.
 */
import { sqlite } from './db';
import { afterCommit, inTransaction } from './db/transaction';
import { emit } from './events';
import { ACTIONS, logActivity, type ActivitySource } from './logActivity';
import { createLogger } from './logger';
import { moveToTrash, type UploadFile } from './uploads';

const log = createLogger('DELETE');

/** Who is deleting: the signed-in user. */
export type DeleteActor = { id: number; username: string; emoji?: string | null };

/** What went with a permanent delete, the row asked for included. */
export type Removed = {
	/** Cards, those on sub-boards among them. */
	cards: number;
	subtasks: number;
	/** Sub-boards at every depth. A deleted board itself is not counted. */
	subBoards: number;
	/** `work_dependencies` rows with a deleted card or subtask at either end. */
	dependencies: number;
	/** Attachment rows, whose files go to the trash after the commit. */
	attachments: number;
	/** Report schedules that named a deleted board. */
	reportSchedules: number;
	/** Cards left in place that were in a deleted board's milestone, and are in none now. */
	cardsReleased: number;
};

/**
 * What a delete starts from: a query for the cards asked for, with its
 * parameters, and the board asked for when it is a board.
 */
type Scope = { seed: string; params: number[]; board?: number };

/**
 * The cards, subtasks and boards under a scope, as common table expressions
 * to put in front of a statement.
 *
 * `sub_boards` follows `boards.parent_card_id` from the cards asked for to
 * every sub-board beneath them, at any depth. It is built with `UNION`, which
 * keeps each board once: a card that was moved into its own sub-board makes a
 * loop, and with `UNION ALL` the query would follow it for ever.
 *
 * The parameters are the seed's, and then the board's if there is one.
 */
function under(scope: Scope): string {
	return `
		WITH RECURSIVE
		seed(id) AS (${scope.seed}),
		sub_boards(id) AS (
			SELECT b.id FROM boards b WHERE b.parent_card_id IN (SELECT id FROM seed)
			UNION
			SELECT b.id FROM sub_boards s
				JOIN columns col ON col.board_id = s.id
				JOIN cards c ON c.column_id = col.id
				JOIN boards b ON b.parent_card_id = c.id
		),
		doomed_cards(id) AS (
			SELECT id FROM seed
			UNION
			SELECT c.id FROM cards c
				JOIN columns col ON col.id = c.column_id
				WHERE col.board_id IN (SELECT id FROM sub_boards)
		),
		doomed_subtasks(id) AS (
			SELECT id FROM subtasks WHERE card_id IN (SELECT id FROM doomed_cards)
		),
		doomed_boards(id) AS (
			SELECT id FROM sub_boards
			${scope.board === undefined ? '' : 'UNION SELECT id FROM boards WHERE id = ?'}
		)
	`;
}

/**
 * Sub-boards in the order to delete them: the deepest first, so that each is
 * deleted by its own statement and not as a side effect of the one above it.
 * `parent` is the board the sub-board's card is on.
 */
function deepestFirst(rows: { id: number; parent: number | null }[]): number[] {
	const parentOf = new Map(rows.map((row) => [row.id, row.parent]));
	const depthOf = (id: number): number => {
		const seen = new Set<number>();
		let at: number | null | undefined = id;
		// `seen` ends the walk on a loop, which a card in its own sub-board makes.
		while (at != null && parentOf.has(at) && !seen.has(at)) {
			seen.add(at);
			at = parentOf.get(at);
		}
		return seen.size;
	};
	return rows
		.map((row) => ({ id: row.id, depth: depthOf(row.id) }))
		.sort((a, b) => b.depth - a.depth || b.id - a.id)
		.map((row) => row.id);
}

/**
 * Delete everything under `scope`, and then whatever `removeRow` deletes.
 * Returns what went, the number of cards asked for, the files to move, and
 * the ids of the sub-boards deleted, lowest first, whose pages are to be told.
 *
 * Everything is read before anything is deleted: once a row is gone, the
 * rows the cascade took with it cannot be asked about.
 */
function removeUnder(
	scope: Scope,
	removeRow: () => void
): { removed: Removed; asked: number; files: UploadFile[]; subBoardIds: number[] } {
	const cte = under(scope);
	const params = scope.board === undefined ? scope.params : [...scope.params, scope.board];
	// Every write below starts with the same long WITH clause. The comment at
	// the front says which it is, to whatever prints the start of a statement.
	const write = (what: string) => `/* ${what} */ ${cte}`;

	const counts = sqlite
		.prepare(
			`${cte} SELECT
				(SELECT COUNT(*) FROM seed) AS asked,
				(SELECT COUNT(*) FROM doomed_cards) AS cards,
				(SELECT COUNT(*) FROM doomed_subtasks) AS subtasks`
		)
		.get(...params) as { asked: number; cards: number; subtasks: number };

	const subBoards = deepestFirst(
		sqlite
			.prepare(
				`${cte} SELECT b.id AS id,
					(SELECT col.board_id FROM cards c JOIN columns col ON col.id = c.column_id
					 WHERE c.id = b.parent_card_id) AS parent
				FROM boards b WHERE b.id IN (SELECT id FROM sub_boards)`
			)
			.all(...params) as { id: number; parent: number | null }[]
	);

	const files = sqlite
		.prepare(
			`${cte} SELECT card_id AS cardId, filename FROM card_attachments
			WHERE card_id IN (SELECT id FROM doomed_cards) ORDER BY id`
		)
		.all(...params) as UploadFile[];

	// Type and id are matched together: card 7 and subtask 7 are different
	// work. By subquery, because a board can hold more cards than a statement
	// takes parameters.
	const dependencies = sqlite
		.prepare(
			`${write('delete from work_dependencies')} DELETE FROM work_dependencies WHERE
				(blocked_type = 'card' AND blocked_id IN (SELECT id FROM doomed_cards))
				OR (blocked_type = 'subtask' AND blocked_id IN (SELECT id FROM doomed_subtasks))
				OR (blocker_type = 'card' AND blocker_id IN (SELECT id FROM doomed_cards))
				OR (blocker_type = 'subtask' AND blocker_id IN (SELECT id FROM doomed_subtasks))`
		)
		.run(...params).changes;

	// What names a board that is going, with no key to clear it. A sub-board is
	// a board, so this is done for those too, whatever was asked for.
	let cardsReleased = 0;
	let reportSchedules = 0;
	if (scope.board !== undefined || subBoards.length > 0) {
		cardsReleased = sqlite
			.prepare(
				`${write('update cards set milestone_id')} UPDATE cards SET milestone_id = NULL
				WHERE milestone_id IN (SELECT id FROM milestones WHERE board_id IN (SELECT id FROM doomed_boards))
					AND id NOT IN (SELECT id FROM doomed_cards)`
			)
			.run(...params).changes;
		reportSchedules = sqlite
			.prepare(
				`${write('delete from report_schedules')} DELETE FROM report_schedules
				WHERE scope = 'board' AND scope_id IN (SELECT id FROM doomed_boards)`
			)
			.run(...params).changes;
		// A board's card categories go with it. Its key is `ON DELETE SET NULL`,
		// which left them as categories of no board, the shared ones, and so
		// listed to everyone (card 2128's review). A card elsewhere that carries
		// one is set to none by the key on `cards.category_id`.
		sqlite
			.prepare(
				`${write('delete from categories')} DELETE FROM categories
				WHERE board_id IN (SELECT id FROM doomed_boards)`
			)
			.run(...params);
	}

	const removeBoard = sqlite.prepare('DELETE FROM boards WHERE id = ?');
	for (const id of subBoards) removeBoard.run(id);
	removeRow();

	return {
		removed: {
			cards: counts.cards,
			subtasks: counts.subtasks,
			subBoards: subBoards.length,
			dependencies,
			attachments: files.length,
			reportSchedules,
			cardsReleased
		},
		asked: counts.asked,
		files,
		subBoardIds: [...subBoards].sort((a, b) => a - b)
	};
}

const boardExists = (boardId: number): boolean =>
	sqlite.prepare('SELECT 1 FROM boards WHERE id = ?').get(boardId) !== undefined;

/**
 * Tell the open pages of each board, once, that it was deleted or emptied,
 * or that a sub-board of it was deleted. The event waits for the commit, as
 * every `emit` does.
 *
 * The payload says what kind of change it was and nothing else: no board
 * name, no card title, no user (R6). An event for a board reaches everyone
 * who can view that board, and the parent card's board can be viewed by
 * people who could never open the sub-board that went under it. The page
 * only re-reads, under its own access check.
 *
 * A member's dashboard is not told of a deleted board: the global stream
 * checks the caller against the board each event is for, and a board that is
 * gone can be viewed by no one but an administrator. It catches up when it is
 * next brought to the front.
 */
function tell(
	boardIds: Iterable<number>,
	what:
		| { type: 'board'; action: 'deleted' | 'sub_board_deleted' }
		| { type: 'card'; action: 'purged' | 'cleared' }
): void {
	for (const boardId of new Set(boardIds)) emit(boardId, 'update', { type: what.type, action: what.action });
}

const actorFields = (actor: DeleteActor) => ({
	userId: actor.id,
	userName: actor.username,
	userEmoji: actor.emoji || '👤'
});

/** What went, in words, for a log line. */
function account(removed: Removed): string {
	return (
		`${removed.cards} card(s), ${removed.subtasks} subtask(s), ${removed.subBoards} sub-board(s), ` +
		`${removed.dependencies} dependency link(s), ${removed.reportSchedules} report schedule(s); ` +
		`${removed.attachments} attachment file(s) to the trash; ` +
		`${removed.cardsReleased} card(s) elsewhere released from its milestones`
	);
}

/**
 * Move the files of deleted attachment rows to the trash, once the delete
 * that removed the rows is committed. If it rolls back, nothing is moved.
 *
 * A file that cannot be moved is logged at WARN and fails nothing: the delete
 * is committed, and the file is where it was.
 */
export function trashAfterCommit(files: readonly UploadFile[]): void {
	if (files.length === 0) return;
	afterCommit(() => {
		let failed: string[];
		try {
			failed = moveToTrash(files).failed;
		} catch (err) {
			failed = [err instanceof Error ? err.message : String(err)];
		}
		if (failed.length > 0) {
			const shown = failed.slice(0, 10).join('; ') + (failed.length > 10 ? `; and ${failed.length - 10} more` : '');
			log.warn(
				`${failed.length} problem(s) moving the files of ${files.length} deleted attachment(s) to the trash. ` +
					`What could not be moved is where it was: ${shown}`
			);
		}
	});
}

/**
 * Archive a card: `archived_at`, and the entry that says so. Nothing else is
 * touched, no dependency link, file or sub-board, so a restore finds it all.
 * Returns null if there is no such card.
 */
export function archiveCard(
	cardId: number,
	actor: DeleteActor,
	source: ActivitySource
): { title: string; boardId: number } | null {
	return inTransaction(() => {
		const card = cardAndBoard(cardId);
		if (!card) return null;

		const now = new Date().toISOString();
		sqlite.prepare('UPDATE cards SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, cardId);
		logActivity({
			boardId: card.boardId,
			cardId,
			action: ACTIONS.cardArchived,
			detail: `"${card.title}"`,
			source,
			...actorFields(actor)
		});
		return card;
	});
}

function cardAndBoard(cardId: number): { title: string; boardId: number } | null {
	const row = sqlite
		.prepare(
			`SELECT c.title AS title, col.board_id AS boardId
			FROM cards c JOIN columns col ON col.id = c.column_id WHERE c.id = ?`
		)
		.get(cardId) as { title: string; boardId: number } | undefined;
	return row ?? null;
}

/**
 * Delete a card for good, with its subtasks, its sub-boards at every depth
 * and everything on them. Returns null if there is no such card.
 *
 * One `card_deleted` entry is written on the card's board. It is stored with
 * no card id, because the card it would refer to is gone; the `card.deleted`
 * webhook it queues carries the id.
 *
 * Each sub-board that went with it is told it was deleted (R7). The route
 * tells the card's board.
 */
export function deleteCard(
	cardId: number,
	actor: DeleteActor,
	source: ActivitySource
): { title: string; boardId: number; removed: Removed } | null {
	return inTransaction(() => {
		const card = cardAndBoard(cardId);
		if (!card) return null;

		const { removed, files, subBoardIds } = removeUnder(
			{ seed: 'SELECT id FROM cards WHERE id = ?', params: [cardId] },
			() => {
				sqlite.prepare('DELETE FROM cards WHERE id = ?').run(cardId);
			}
		);

		if (boardExists(card.boardId)) {
			logActivity({
				boardId: card.boardId,
				cardId: null,
				webhookCardId: cardId,
				action: ACTIONS.cardDeleted,
				detail: `"${card.title}"`,
				source,
				...actorFields(actor)
			});
		} else {
			// The card had been moved into its own sub-board, so the board it was
			// on went with it and there is no board to write the entry on.
			afterCommit(() =>
				log.info(
					`Card ${cardId} "${card.title}" was deleted by ${actor.username}, and board ${card.boardId}, ` +
						`which it was on, was its own sub-board and went with it: ${account(removed)}`,
					undefined,
					{ userId: actor.id }
				)
			);
		}
		tell(subBoardIds, { type: 'board', action: 'deleted' });
		trashAfterCommit(files);
		return { ...card, removed };
	});
}

/**
 * Delete a column and every card in it. Returns null if there is no such
 * column.
 *
 * One `column_deleted` entry is written on its board, naming the column and
 * how many cards went with it. No entry and no webhook for each card.
 *
 * If the board went too, because a card in the column had been moved onto a
 * sub-board under itself, there is no board to write the entry on, and one
 * line goes to the system log instead, once the delete is committed.
 *
 * Each sub-board that went with its cards is told it was deleted (R7). The
 * route tells the column's board.
 */
export function deleteColumn(
	columnId: number,
	actor: DeleteActor,
	source: ActivitySource
): { title: string; boardId: number; removed: Removed } | null {
	return inTransaction(() => {
		const column = sqlite.prepare('SELECT title, board_id AS boardId FROM columns WHERE id = ?').get(columnId) as
			| { title: string; boardId: number }
			| undefined;
		if (!column) return null;

		const { removed, asked, files, subBoardIds } = removeUnder(
			{ seed: 'SELECT id FROM cards WHERE column_id = ?', params: [columnId] },
			() => {
				sqlite.prepare('DELETE FROM columns WHERE id = ?').run(columnId);
			}
		);

		const below =
			removed.subBoards > 0
				? `, and ${removed.subBoards} sub-board(s) holding ${removed.cards - asked} more`
				: '';
		if (boardExists(column.boardId)) {
			logActivity({
				boardId: column.boardId,
				action: ACTIONS.columnDeleted,
				detail: `"${column.title}" with ${asked} card(s)${below}`,
				source,
				...actorFields(actor)
			});
		} else {
			// The column's board was a sub-board under one of the column's own
			// cards, so it went with them and there is no board to write the
			// entry on. As for a card: see `deleteCard`.
			afterCommit(() =>
				log.info(
					`Column ${columnId} "${column.title}" was deleted by ${actor.username}, and board ${column.boardId}, ` +
						`which it was on, was a sub-board under one of its own cards and went with it: ${account(removed)}`,
					undefined,
					{ userId: actor.id }
				)
			);
		}
		tell(subBoardIds, { type: 'board', action: 'deleted' });
		trashAfterCommit(files);
		return { ...column, removed };
	});
}

/**
 * Delete a board and everything on it. Returns null if there is no such
 * board.
 *
 * Cards on other boards that were in one of its milestones are released from
 * it, and the report schedules that name it are deleted. Its card categories
 * are deleted with it, and a card elsewhere that carries one has none: they
 * stayed, as categories of no board, which are everybody's.
 *
 * No activity entry: it would be deleted with the board. One line goes to
 * the system log once the delete is committed, naming the board, who deleted
 * it and what went. The logger holds a line written inside a transaction and
 * writes it whichever way the transaction ends, so it is queued instead.
 *
 * The board and each sub-board that went with it are each told it was
 * deleted. A page open on the board re-reads and finds it gone. It was told
 * nothing, and showed the board until it was reloaded. The board of the card
 * it hung from, if it was a sub-board, is still there, and is told
 * `sub_board_deleted` instead: a sub-board of it was deleted, and its page
 * re-reads.
 */
export function deleteBoard(boardId: number, actor: DeleteActor): { name: string; removed: Removed } | null {
	return inTransaction(() => {
		const board = sqlite.prepare('SELECT name FROM boards WHERE id = ?').get(boardId) as
			| { name: string }
			| undefined;
		if (!board) return null;

		// The board its card is on, if it is a sub-board: read now, while the card can be found.
		const parent = sqlite
			.prepare(
				`SELECT col.board_id AS boardId FROM boards b
				JOIN cards c ON c.id = b.parent_card_id
				JOIN columns col ON col.id = c.column_id
				WHERE b.id = ?`
			)
			.get(boardId) as { boardId: number } | undefined;

		const { removed, files, subBoardIds } = removeUnder(
			{
				seed: 'SELECT c.id FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.board_id = ?',
				params: [boardId],
				board: boardId
			},
			() => {
				sqlite.prepare('DELETE FROM boards WHERE id = ?').run(boardId);
			}
		);

		afterCommit(() =>
			log.info(
				`Board ${boardId} "${board.name}" was deleted by ${actor.username}: ${account(removed)}`,
				undefined,
				{ userId: actor.id }
			)
		);
		const deleted = [boardId, ...subBoardIds];
		tell(deleted, { type: 'board', action: 'deleted' });
		if (parent && !deleted.includes(parent.boardId)) {
			tell([parent.boardId], { type: 'board', action: 'sub_board_deleted' });
		}
		trashAfterCommit(files);
		return { name: board.name, removed };
	});
}

/** The boards the cards of `seed` are on, with their names and how many of the cards each holds. */
function countByBoard(seed: string, params: number[]): { boardId: number; name: string; cards: number }[] {
	return sqlite
		.prepare(
			`SELECT col.board_id AS boardId, b.name AS name, COUNT(*) AS cards
			FROM cards c JOIN columns col ON col.id = c.column_id JOIN boards b ON b.id = col.board_id
			WHERE c.id IN (${seed}) GROUP BY col.board_id ORDER BY col.board_id`
		)
		.all(...params) as { boardId: number; name: string; cards: number }[];
}

/**
 * Delete every archived card, on every board. `purged` is how many were
 * archived; `removed` counts what was on their sub-boards as well.
 *
 * One `cards_purged` entry on each board that had any, with the count. No
 * entry and no webhook for each card. Each of those boards, and each
 * sub-board that went with an archived card, is told.
 *
 * A board that held archived cards and went with the purge, being beneath
 * one of the cards purged, has no board to write its entry on. On a loop
 * that is the board beneath one of its own cards, whose own card was
 * archived, and nothing else recorded that it went. As for a card or a
 * column (see `deleteCard`), one line goes to the system log instead, naming
 * every such board, once the purge is committed, and each such board is told
 * it was deleted, not purged.
 */
export function purgeArchivedCards(actor: DeleteActor): { purged: number; removed: Removed } {
	return inTransaction(() => {
		const seed = 'SELECT id FROM cards WHERE archived_at IS NOT NULL';
		const boards = countByBoard(seed, []);

		const { removed, asked, files, subBoardIds } = removeUnder({ seed, params: [] }, () => {
			sqlite.prepare('DELETE FROM cards WHERE archived_at IS NOT NULL').run();
		});

		const told: number[] = [];
		const gone: typeof boards = [];
		for (const board of boards) {
			// A sub-board beneath an archived card went with that card: on a
			// loop, beneath its own.
			if (!boardExists(board.boardId)) {
				gone.push(board);
				continue;
			}
			logActivity({
				boardId: board.boardId,
				action: ACTIONS.cardsPurged,
				detail: `Purged ${board.cards} archived card(s)`,
				source: 'ui',
				...actorFields(actor)
			});
			told.push(board.boardId);
		}
		if (gone.length > 0) {
			const named = gone.map((board) => `board ${board.boardId} "${board.name}", which held ${board.cards}`).join('; ');
			afterCommit(() =>
				log.info(
					`Archived cards were purged by ${actor.username}, and ${gone.length} board(s) that held some of them ` +
						`went with them, each beneath one of the cards purged, as a board in a loop is beneath its own: ` +
						`${named}. In all: ${account(removed)}`,
					undefined,
					{ userId: actor.id }
				)
			);
		}
		const deleted = gone.map((board) => board.boardId);
		tell(deleted, { type: 'board', action: 'deleted' });
		tell(
			[...told, ...subBoardIds].filter((id) => !deleted.includes(id)),
			{ type: 'card', action: 'purged' }
		);
		trashAfterCommit(files);
		return { purged: asked, removed };
	});
}

/**
 * Delete every card on a board and leave the board and its columns.
 * `cleared` is how many cards the board held; `removed` counts what was on
 * their sub-boards as well.
 *
 * One `cards_cleared` entry on the board, with the count, if it held any.
 * The board and each sub-board that went with its cards are told.
 *
 * On a loop the board is not left: it is beneath one of its own cards, which
 * is among those cleared, and it goes with that card. There is then no board
 * to write the entry on, and, as for a card or a column (see `deleteCard`),
 * one line goes to the system log instead, once the clear is committed, and
 * the board is told it was deleted, not cleared.
 */
export function clearBoardCards(boardId: number, actor: DeleteActor): { cleared: number; removed: Removed } {
	return inTransaction(() => {
		// Read now: on a loop the board goes with its cards.
		const board = sqlite.prepare('SELECT name FROM boards WHERE id = ?').get(boardId) as { name: string } | undefined;
		const { removed, asked, files, subBoardIds } = removeUnder(
			{
				seed: 'SELECT c.id FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.board_id = ?',
				params: [boardId]
			},
			() => {
				sqlite
					.prepare('DELETE FROM cards WHERE column_id IN (SELECT id FROM columns WHERE board_id = ?)')
					.run(boardId);
			}
		);

		// A board that held nothing has nothing to re-read, and is not gone.
		if (asked > 0 && boardExists(boardId)) {
			logActivity({
				boardId,
				action: ACTIONS.cardsCleared,
				detail: `Cleared all ${asked} card(s) from the board`,
				source: 'ui',
				...actorFields(actor)
			});
			tell([boardId, ...subBoardIds], { type: 'card', action: 'cleared' });
		} else if (asked > 0) {
			afterCommit(() =>
				log.info(
					`The cards of board ${boardId} "${board?.name ?? ''}" were cleared by ${actor.username}, and the board ` +
						`was a sub-board under one of its own cards and went with them: ${account(removed)}`,
					undefined,
					{ userId: actor.id }
				)
			);
			tell([boardId], { type: 'board', action: 'deleted' });
			tell(
				subBoardIds.filter((id) => id !== boardId),
				{ type: 'card', action: 'cleared' }
			);
		}
		trashAfterCommit(files);
		return { cleared: asked, removed };
	});
}

/**
 * Every column that names a user through a foreign key with no `ON DELETE`
 * action. While one of them named a user, that user could not be deleted: the
 * key refused it. All five are nullable. Every other reference to a user
 * cascades or is set to NULL by its own key (`schema.ts`).
 */
const USER_REFERENCES = [
	{ table: 'card_attachments', column: 'uploaded_by' },
	{ table: 'card_templates', column: 'created_by' },
	{ table: 'milestones', column: 'created_by' },
	{ table: 'work_dependencies', column: 'created_by_user_id' },
	{ table: 'card_dependencies', column: 'created_by_user_id' }
] as const;

/** What a deleted user leaves, and what went with them. */
export type UserRemoved = {
	username: string;
	/** Rows left in place that named the user, and name nobody now. */
	referencesCleared: number;
	/** Deleted with the user, by cascade. */
	apiKeys: number;
	reportSchedules: number;
	comments: number;
};

/**
 * Delete a user. Returns null if there is no such user.
 *
 * What they uploaded, the templates and milestones they made and the
 * dependencies they recorded stay, with nobody named as having made them. A
 * milestone or template with no creator is an administrator's to change.
 * Nothing else is written here. What the keys cascade goes with the user:
 * their sessions, API keys, report schedules, comments, memberships and
 * assignments. Their XP is kept: `user_xp` is keyed by name and has no key
 * to a user.
 *
 * One line goes to the system log once the delete is committed, saying who
 * deleted whom.
 */
export function deleteUser(userId: number, actor: DeleteActor): UserRemoved | null {
	return inTransaction(() => {
		const user = sqlite
			.prepare(
				`SELECT username,
					(SELECT COUNT(*) FROM api_keys WHERE user_id = users.id) AS apiKeys,
					(SELECT COUNT(*) FROM report_schedules WHERE user_id = users.id) AS reportSchedules,
					(SELECT COUNT(*) FROM card_comments WHERE user_id = users.id) AS comments
				FROM users WHERE id = ?`
			)
			.get(userId) as Omit<UserRemoved, 'referencesCleared'> | undefined;
		if (!user) return null;

		let referencesCleared = 0;
		for (const { table, column } of USER_REFERENCES) {
			referencesCleared += sqlite
				.prepare(`UPDATE ${table} SET ${column} = NULL WHERE ${column} = ?`)
				.run(userId).changes;
		}
		sqlite.prepare('DELETE FROM users WHERE id = ?').run(userId);

		afterCommit(() =>
			log.info(
				`User ${userId} "${user.username}" was deleted by ${actor.username}: ${user.apiKeys} API key(s), ` +
					`${user.reportSchedules} report schedule(s) and ${user.comments} comment(s) went with them; ` +
					`${referencesCleared} row(s) they had uploaded, created or recorded were kept and name nobody now`,
				undefined,
				{ userId: actor.id }
			)
		);
		return { ...user, referencesCleared };
	});
}
