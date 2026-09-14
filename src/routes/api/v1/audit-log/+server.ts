import { json, error } from '@sveltejs/kit';
import { db, sqlite } from '$lib/server/db';
import { activityLog } from '$lib/server/db/schema';
import { eq, desc, and, gte, lte, like, notLike, or, sql } from 'drizzle-orm';
import { canonicalAction, readSource } from '$lib/server/logActivity';
import type { RequestHandler } from './$types';

/** Default page size. Stated here, in the docs, and in every response. */
const DEFAULT_LIMIT = 100;
/** Hard ceiling on a page. A caller wanting more pages through with `offset`. */
const MAX_LIMIT = 500;

/**
 * GET /api/v1/audit-log — Query system-wide activity log.
 *
 * Filters:
 *   ?boardId=N       — Filter by board (the board at the time of the event)
 *   ?action=string   — Action type. Matches the canonical name regardless of
 *                      source, so `card_moved` finds both UI and API moves;
 *                      a trailing `*` is a prefix match.
 *   ?source=ui|api   — Where the action came from
 *   ?userId=N        — Filter by user
 *   ?cardId=N        — Filter by card
 *   ?from=ISO        — From date (inclusive)
 *   ?to=ISO          — To date (inclusive)
 *   ?limit=N         — Max results (default 100, max 500)
 *   ?offset=N        — Pagination offset
 *
 * Every response carries `pagination.total` and `pagination.hasMore`, so a
 * truncated page is obvious. It was not before: the default limit of 100 was
 * undocumented and a full page looked exactly like a complete result, which is
 * how a 2,500-entry scan quietly became a 100-entry one.
 *
 * Requires admin role.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	if (locals.user.role !== 'admin') throw error(403, 'Admin access required');

	const boardId = url.searchParams.get('boardId');
	const action = url.searchParams.get('action');
	const source = url.searchParams.get('source');
	const userId = url.searchParams.get('userId');
	const cardId = url.searchParams.get('cardId');
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	const limit = Math.min(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT, MAX_LIMIT);
	const offset = Number(url.searchParams.get('offset')) || 0;

	if (source && source !== 'ui' && source !== 'api') {
		throw error(400, 'source must be "ui" or "api"');
	}

	// Build conditions array
	const conditions = [];
	if (boardId) conditions.push(eq(activityLog.boardId, Number(boardId)));
	if (userId) conditions.push(eq(activityLog.userId, Number(userId)));
	if (cardId) conditions.push(eq(activityLog.cardId, Number(cardId)));
	if (action) {
		// The same action is stored as `card_moved` from the UI and
		// `api:card_moved` from the API, so a filter has to match both or it
		// answers a different question than the caller asked.
		const canonical = canonicalAction(action);
		if (canonical.endsWith('*')) {
			const stem = canonical.replace('*', '%');
			conditions.push(or(like(activityLog.action, stem), like(activityLog.action, `api:${stem}`)));
		} else {
			conditions.push(
				or(eq(activityLog.action, canonical), eq(activityLog.action, `api:${canonical}`))
			);
		}
	}
	// Source is filtered on the stored spelling, not the `source` column, because
	// rows written before that column existed have it null. The prefix is the
	// same fact and covers the whole history, so a source filter does not make
	// two and a half thousand older entries disappear.
	if (source === 'api') conditions.push(like(activityLog.action, 'api:%'));
	if (source === 'ui') conditions.push(notLike(activityLog.action, 'api:%'));
	if (from) conditions.push(gte(activityLog.createdAt, from));
	if (to) conditions.push(lte(activityLog.createdAt, to));

	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const entries = db.select({
		id: activityLog.id,
		boardId: activityLog.boardId,
		cardId: activityLog.cardId,
		userId: activityLog.userId,
		action: activityLog.action,
		detail: activityLog.detail,
		userName: activityLog.userName,
		userEmoji: activityLog.userEmoji,
		source: activityLog.source,
		createdAt: activityLog.createdAt
	})
	.from(activityLog)
	.where(where)
	.orderBy(desc(activityLog.createdAt))
	.limit(limit)
	.offset(offset)
	.all();

	// One query for the board names, not one per entry. The previous version ran
	// a lookup inside the loop — on a 500-row page that was 500 round trips to
	// answer a question with at most a couple of dozen distinct answers.
	const boardNames = new Map<number, string>();
	const wanted = [...new Set(entries.map((e) => e.boardId))];
	if (wanted.length > 0) {
		const rows = sqlite
			.prepare(`SELECT id, name FROM boards WHERE id IN (${wanted.map(() => '?').join(',')})`)
			.all(...wanted) as { id: number; name: string }[];
		for (const r of rows) boardNames.set(r.id, r.name);
	}

	const enriched = entries.map(e => ({
		...e,
		// The canonical name is what callers should filter and group on; the
		// stored spelling stays available so an existing consumer is not broken.
		action: canonicalAction(e.action),
		rawAction: e.action,
		source: readSource(e),
		boardName: boardNames.get(e.boardId) || 'Unknown'
	}));

	// The total is computed over the same filter, so `hasMore` is a fact rather
	// than an inference from "the page came back full".
	const total = Number(
		db.select({ n: sql<number>`COUNT(*)` }).from(activityLog).where(where).get()?.n ?? 0
	);

	return json({
		data: enriched,
		pagination: {
			limit,
			offset,
			count: enriched.length,
			total,
			hasMore: offset + enriched.length < total,
			defaultLimit: DEFAULT_LIMIT,
			maxLimit: MAX_LIMIT
		}
	});
};
