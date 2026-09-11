/**
 * Card search for the dependency and milestone pickers.
 *
 * Searches by "#id" or by title across every board the caller can see, because
 * dependencies are deliberately cross-board — a migration touches several
 * projects, and the picker has to be able to reach those cards.
 *
 * `?kinds=card,subtask` (default `card`) also returns subtasks, so one picker
 * can link either. Every result carries a `kind`, because "#32" is ambiguous
 * between card 32 and subtask 32.
 */
import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns, boards, subtasks } from '$lib/server/db/schema';
import { eq, like, isNull, and, inArray } from 'drizzle-orm';
import { canViewBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const q = (url.searchParams.get('q') ?? '').trim();
	const excludeId = Number(url.searchParams.get('exclude') ?? '0');
	const kinds = (url.searchParams.get('kinds') ?? 'card').split(',').map((k) => k.trim());
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

	const cardResults = matches
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
		.map((r) => ({ ...r, kind: 'card' as const, parentCardId: null as number | null }));

	if (!kinds.includes('subtask')) return json(cardResults.slice(0, 25));

	// Subtasks inherit their parent card's board, so visibility is the parent's.
	const subMatches = idMatch
		? db.select().from(subtasks).where(eq(subtasks.id, Number(idMatch[1]))).all()
		: db.select().from(subtasks).where(like(subtasks.title, `%${q}%`)).limit(60).all();

	const subResults = subMatches
		.map((st) => {
			const card = db.select({ id: cards.id, columnId: cards.columnId, title: cards.title, archivedAt: cards.archivedAt })
				.from(cards).where(eq(cards.id, st.cardId)).get();
			if (!card || card.archivedAt) return null;
			const col = db.select().from(columns).where(eq(columns.id, card.columnId)).get();
			if (!col || !isVisible(col.boardId)) return null;
			const board = db.select({ name: boards.name, emoji: boards.emoji }).from(boards).where(eq(boards.id, col.boardId)).get();
			return {
				id: st.id,
				kind: 'subtask' as const,
				parentCardId: card.id,
				title: st.title,
				priority: st.priority,
				// A subtask has no column of its own; showing its parent card here is
				// what makes it findable in a picker.
				columnName: `in #${card.id}`,
				boardId: col.boardId,
				boardName: board?.name ?? 'Unknown board',
				boardEmoji: board?.emoji ?? '📋',
				milestoneId: null as number | null
			};
		})
		.filter((r): r is NonNullable<typeof r> => r !== null);

	// Interleave rather than concatenate: a title search that matches both should
	// not bury every subtask below twenty-five cards.
	return json([...cardResults, ...subResults].slice(0, 40));
};
