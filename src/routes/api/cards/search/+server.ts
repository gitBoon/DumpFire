/**
 * Card search for the dependency and milestone pickers.
 *
 * Searches by "#id" or by title across every board the caller can see, because
 * dependencies are deliberately cross-board — a migration touches several
 * projects, and the picker has to be able to reach those cards.
 */
import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns, boards } from '$lib/server/db/schema';
import { eq, like, isNull, and, inArray } from 'drizzle-orm';
import { canViewBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const q = (url.searchParams.get('q') ?? '').trim();
	const excludeId = Number(url.searchParams.get('exclude') ?? '0');
	if (q.length === 0) return json([]);

	// "#1234" or a bare number is an id lookup, not a title search.
	const idMatch = q.match(/^#?(\d+)$/);

	const matches = idMatch
		? db.select().from(cards).where(and(eq(cards.id, Number(idMatch[1])), isNull(cards.archivedAt))).all()
		: db
				.select()
				.from(cards)
				.where(and(like(cards.title, `%${q}%`), isNull(cards.archivedAt)))
				.limit(60)
				.all();

	if (matches.length === 0) return json([]);

	const colIds = [...new Set(matches.map((c) => c.columnId))];
	const cols = db.select().from(columns).where(inArray(columns.id, colIds)).all();
	const colById = new Map(cols.map((c) => [c.id, c]));

	const boardIds = [...new Set(cols.map((c) => c.boardId))];
	const brds = boardIds.length
		? db.select({ id: boards.id, name: boards.name, emoji: boards.emoji }).from(boards).where(inArray(boards.id, boardIds)).all()
		: [];
	const boardById = new Map(brds.map((b) => [b.id, b]));

	// Filter by visibility per board rather than per card — the access check hits
	// the DB, and a title search can match cards across a dozen boards.
	const visible = new Map<number, boolean>();
	const isVisible = (boardId: number) => {
		if (!visible.has(boardId)) visible.set(boardId, canViewBoard(locals.user!, boardId));
		return visible.get(boardId)!;
	};

	const results = matches
		.filter((c) => c.id !== excludeId)
		.map((c) => {
			const col = colById.get(c.columnId);
			if (!col) return null;
			if (!isVisible(col.boardId)) return null;
			const board = boardById.get(col.boardId);
			return {
				id: c.id,
				title: c.title,
				priority: c.priority,
				columnName: col.title,
				boardId: col.boardId,
				boardName: board?.name ?? 'Unknown board',
				boardEmoji: board?.emoji ?? '📋',
				milestoneId: c.milestoneId ?? null
			};
		})
		.filter((r): r is NonNullable<typeof r> => r !== null)
		.slice(0, 25);

	return json(results);
};
