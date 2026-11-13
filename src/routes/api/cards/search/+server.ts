/**
 * Card search for the dependency and milestone pickers.
 *
 * Searches by "#id" or by title across every board the caller can see, because
 * dependencies are deliberately cross-board — a migration touches several
 * projects, and the picker has to be able to reach those cards.
 *
 * `?kinds=card,subtask` (default `card`) also returns subtasks, so one picker
 * can link either. Every result carries a `kind`, because "#32" is ambiguous
 * between card 32 and subtask 32. `kinds=subtask` alone answers the matching
 * cards too: the card read always runs.
 *
 * A card or subtask is a candidate only on a board the caller can open
 * (`getAccessibleBoardIds`, the set `canViewBoard` answers yes for; every board
 * for an administrator), and that, with "not archived", the `exclude` card and
 * the card's column being there, is asked in the query, before its limit of
 * 60 (card 2327). The 60 were read from every board and the hidden ones
 * dropped afterwards, so matches on boards the caller cannot open pushed their
 * own out of the answer, and an answer's length told them roughly how many
 * there were. Both reads are by id, ascending: the order the plain read gave,
 * which a join through `columns` would otherwise turn into results grouped by
 * board.
 *
 * The title is matched as typed (card 2718): `instr` of both sides lowered by
 * SQLite, where it was a `LIKE` built from the text, so `%` and `_` were
 * wildcards and "50%" found "500 tests". `lower()` folds A to Z alone, as
 * `LIKE` did, so what matched in another case still does, and a title in
 * letters beyond them is matched exactly as it was.
 *
 * `?editable=1` keeps only cards on boards the caller can edit
 * (`editableBoardIds`), for a picker whose choice is an edit of the card's
 * board: the decision page's linked cards, where every card on a board the
 * caller could only read was offered and its link refused 403.
 */
import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns, boards, subtasks } from '$lib/server/db/schema';
import { eq, isNull, and, inArray, ne, asc, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { editableBoardIds, getAccessibleBoardIds } from '$lib/server/board-access';
import { readQueryId } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/** `column` holds `text` as typed, in any case of A to Z: no character of it is a wildcard. */
function holds(column: SQLiteColumn, text: string): SQL {
	return sql`instr(lower(${column}), lower(${text})) > 0`;
}

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const q = (url.searchParams.get('q') ?? '').trim();
	// An id, as an id in the path is read (card 2117): `Number()` read `2.5`
	// and `5abc` as something else. Not sent is no card to leave out.
	const excludeId = readQueryId(url.searchParams.get('exclude'), 'card') ?? 0;
	const kinds = (url.searchParams.get('kinds') ?? 'card').split(',').map((k) => k.trim());
	if (q.length === 0) return json([]);

	// "#1234" or a bare number is an id lookup, not a title search.
	const idMatch = q.match(/^#?(\d+)$/);

	// The boards the caller can open, or null for every board (an
	// administrator). None: nothing to search, and no empty `IN ()` is built.
	const accessible = getAccessibleBoardIds(locals.user);
	const editable = url.searchParams.get('editable') === '1' ? editableBoardIds(locals.user) : null;
	const open = editable === null ? accessible : (accessible ?? [...editable]).filter((id) => editable.has(id));
	if (open !== null && open.length === 0) return json([]);
	const onOpenBoard = open === null ? undefined : inArray(columns.boardId, open);

	// The card's column is joined, so a card whose column is gone is no
	// candidate, and its board is the column's.
	const matches = db
		.select({ card: cards, columnTitle: columns.title, boardId: columns.boardId })
		.from(cards)
		.innerJoin(columns, eq(cards.columnId, columns.id))
		.where(
			and(
				idMatch ? eq(cards.id, Number(idMatch[1])) : holds(cards.title, q),
				isNull(cards.archivedAt),
				excludeId ? ne(cards.id, excludeId) : undefined,
				onOpenBoard
			)
		)
		.orderBy(asc(cards.id))
		.limit(60)
		.all();

	// Subtasks inherit their parent card's board, so visibility is the parent's;
	// a subtask of an archived card is no candidate. One read, where it was
	// three queries for each subtask matched.
	const subMatches = kinds.includes('subtask')
		? db
				.select({ st: subtasks, cardId: cards.id, boardId: columns.boardId })
				.from(subtasks)
				.innerJoin(cards, eq(subtasks.cardId, cards.id))
				.innerJoin(columns, eq(cards.columnId, columns.id))
				.where(
					and(
						idMatch ? eq(subtasks.id, Number(idMatch[1])) : holds(subtasks.title, q),
						isNull(cards.archivedAt),
						onOpenBoard
					)
				)
				.orderBy(asc(subtasks.id))
				.limit(60)
				.all()
		: [];

	// The names of the boards in the answer, in one read.
	const boardIds = [...new Set([...matches, ...subMatches].map((m) => m.boardId))];
	const brds = boardIds.length
		? db.select({ id: boards.id, name: boards.name, emoji: boards.emoji }).from(boards).where(inArray(boards.id, boardIds)).all()
		: [];
	const boardById = new Map(brds.map((b) => [b.id, b]));

	const cardResults = matches.map(({ card: c, columnTitle, boardId }) => {
		const board = boardById.get(boardId);
		return {
			id: c.id,
			title: c.title,
			priority: c.priority,
			columnName: columnTitle,
			boardId,
			boardName: board?.name ?? 'Unknown board',
			boardEmoji: board?.emoji ?? '📋',
			milestoneId: c.milestoneId ?? null,
			kind: 'card' as const,
			parentCardId: null as number | null
		};
	});

	if (!kinds.includes('subtask')) return json(cardResults.slice(0, 25));

	const subResults = subMatches.map(({ st, cardId, boardId }) => {
		const board = boardById.get(boardId);
		return {
			id: st.id,
			kind: 'subtask' as const,
			parentCardId: cardId,
			title: st.title,
			priority: st.priority,
			// A subtask has no column of its own; showing its parent card here is
			// what makes it findable in a picker.
			columnName: `in #${cardId}`,
			boardId,
			boardName: board?.name ?? 'Unknown board',
			boardEmoji: board?.emoji ?? '📋',
			milestoneId: null as number | null
		};
	});

	// Cards first, then subtasks: concatenated, not interleaved, so 40 matching
	// cards leave no room for a subtask. No page asks for subtasks today.
	return json([...cardResults, ...subResults].slice(0, 40));
};
