/**
 * audit-log.ts — the one reader of the activity log behind both audit routes
 * (card 2294): `GET /api/audit`, the Audit & Logging page's log, and
 * `GET /api/v1/audit-log`, the documented one.
 *
 * The two routes repeated the same fifty lines and had come apart in seven
 * ways. Each is now settled here, once:
 *
 *   1. An action filter written with `api:` in front is read as the route
 *      shows the action. Shown stored (`canonical: false`, the page, whose
 *      rows read `api:card_moved`), it also means done through the API, as the
 *      page has always offered `api:*` to mean; shown canonical (v1, whose rows
 *      read `card_moved` with a `source`), it is a spelling, as v1 documents
 *      (card 2127).
 *   2. `cardId` filters both.
 *   3. Every row carries `rawAction`, the stored spelling, and `source`, read
 *      by `readSource`; `action` is canonical on v1 and as stored on the page.
 *   4. Both answers carry the same `pagination`, `total` and `hasMore` with it.
 *   5. The board names are read in one query, not one per entry.
 *   6. (In the routes) one admin check, `isAdmin`.
 *   7. The ids are refused in v1's words: `Invalid board ID`, `Invalid user ID`,
 *      `Invalid card ID`.
 *
 * What stays each route's own is how a stored time is answered: v1 answers
 * ISO 8601 through `v1-json`, the page the stored form (`v1-json.ts`).
 *
 * Both page by a cursor as well as by `offset` (card 2387): `before`, the
 * last entry held. Paged by `offset`, an entry written between two pages
 * pushed every older one down a place, and the next page began with one
 * already shown.
 */
import { error } from '@sveltejs/kit';
import { and, desc, eq, gte, like, lte, notLike, sql } from 'drizzle-orm';
import { db, sqlite } from './db';
import { activityLog } from './db/schema';
import { actionCondition, canonicalAction, readSource } from './logActivity';
import { pathId, readLimit, readOffset, readQueryDate, readQueryId, refuseReversedRange } from './request-body';
import type { Stamp } from '$lib/timestamps';

/** Default page size. Stated here, in the docs, and in every response. */
export const AUDIT_DEFAULT_LIMIT = 100;
/** Hard ceiling on a page. A caller wanting more pages through with `before` (or `offset`). */
export const AUDIT_MAX_LIMIT = 500;

/** The filters and the page of one request, as `readAuditParams` read them. */
export type AuditLogParams = {
	boardId?: number;
	userId?: number;
	cardId?: number;
	action: string | null;
	source: 'ui' | 'api' | null;
	from?: Stamp;
	to?: Stamp;
	limit: number;
	offset: number;
	/** The last entry the caller holds (card 2387): the page is the entries older than it. */
	before?: AuditCursor;
};

/** An entry's place in the log's order: its time, in the stored form, and its id. */
export type AuditCursor = { createdAt: Stamp; id: number };

/** What a `before` that is not a cursor is answered, in v1's style. */
export const AUDIT_BEFORE_SAYS = "before must be an entry's createdAt and id, as 2026-10-21T09:00:00Z,1234";

/**
 * `before`: the `createdAt` and `id` of the last entry the caller holds,
 * joined by a comma, as the route answered them, `2026-10-21T09:00:00.000Z,1234`
 * on v1 and `2026-10-21 09:00:00,1234` on the page's route. The time is read
 * as `from` is, but a date alone names no entry and is refused with the rest.
 * Not sent, or empty, is no cursor.
 */
export function readBefore(value: string | null): AuditCursor | undefined {
	if (value === null || value === '') return undefined;
	const comma = value.lastIndexOf(',');
	const time = comma < 0 ? '' : value.slice(0, comma);
	if (!/\d[T ]\d/.test(time)) throw error(400, AUDIT_BEFORE_SAYS);
	const createdAt = readQueryDate(time, 'before', 'lower', AUDIT_BEFORE_SAYS)!;
	return { createdAt, id: pathId(value.slice(comma + 1), 'entry', AUDIT_BEFORE_SAYS) };
}

/**
 * The query string of either route, read, or a 400 that names what is wrong.
 *
 *   ?boardId=N       — the board at the time of the event
 *   ?action=string   — the action, however it was done; a trailing `*` is a
 *                      prefix match, and nothing else is a wildcard
 *   ?source=ui|api   — where it was done, or `400 source must be "ui" or "api"`
 *   ?userId=N, ?cardId=N
 *   ?from=, ?to=     — each a date, an ISO 8601 timestamp or `YYYY-MM-DD
 *                      HH:MM:SS` in UTC, or `400 from is not a date`; a bare
 *                      `to` is the whole day; a `from` after its `to` is a 400
 *                      (`` `from` is after `to` ``), equal bounds one second
 *   ?limit=N         — a whole number held between 1 and 500, default 100:
 *                      -1 is 1, and not every row; text is the default
 *   ?offset=N        — rounded down, and 0 or more
 *   ?before=T,N      — the `createdAt` and `id` of the last entry held, or
 *                      `400 before must be an entry's createdAt and id, …`
 *                      (`readBefore`, card 2387)
 *
 * The three ids are read as an id in the path is read: `2.5` and `abc` are
 * `400 Invalid <thing> ID`, where they matched nothing, or a row they did not
 * name.
 */
export function readAuditParams(search: URLSearchParams): AuditLogParams {
	const boardId = readQueryId(search.get('boardId'), 'board');
	const action = search.get('action');
	const source = search.get('source');
	const userId = readQueryId(search.get('userId'), 'user');
	const cardId = readQueryId(search.get('cardId'), 'card');
	// Each bound a date or a timestamp, in the stored form, a bare `to` the
	// whole of its day (card 2095, decision 10). They were compared as sent,
	// so a bound in the other form gained or lost the day at its end, a bare
	// `to` lost the whole of its day, and `from=yesterday` was taken.
	const from = readQueryDate(search.get('from'), 'from', 'lower');
	const to = readQueryDate(search.get('to'), 'to', 'upper');
	// The stored form orders moments as text, so a reversed pair is caught
	// here (card 2217): it was answered with an empty page, which reads as "no
	// entries". Equal bounds name one second, and are allowed. One check for
	// the four routes that read a range (card 2262).
	refuseReversedRange(from, to);
	const limit = readLimit(search.get('limit'), { max: AUDIT_MAX_LIMIT, fallback: AUDIT_DEFAULT_LIMIT });
	const offset = readOffset(search.get('offset'));
	const before = readBefore(search.get('before'));

	if (source && source !== 'ui' && source !== 'api') {
		throw error(400, 'source must be "ui" or "api"');
	}

	return { boardId, userId, cardId, action, source: (source || null) as 'ui' | 'api' | null, from, to, limit, offset, before };
}

/**
 * One page of the activity log, newest first, with each entry's board name,
 * and the count of every entry the filters find.
 *
 * `canonical` is how the route shows an action: canonical (`card_moved`, v1)
 * or as stored (`api:card_moved`, the page). It decides `action` in each row
 * and what an `api:` in front of the action filter means (see the top).
 */
export function queryAuditLog(params: AuditLogParams, { canonical }: { canonical: boolean }) {
	const { boardId, userId, cardId, action, source, from, to, limit, offset, before } = params;

	const conditions = [];
	if (boardId !== undefined) conditions.push(eq(activityLog.boardId, boardId));
	// With a board or a card as well, the person is asked as `+user_id`, which
	// no index can answer, so SQLite reads that board's or card's entries by
	// their own index. Asked plainly, it took the person's index for its order
	// and read every entry of theirs to find the few on that board or card.
	if (userId !== undefined) {
		conditions.push(
			boardId !== undefined || cardId !== undefined
				? eq(sql`+${activityLog.userId}`, userId)
				: eq(activityLog.userId, userId)
		);
	}
	if (cardId !== undefined) conditions.push(eq(activityLog.cardId, cardId));
	// The same action is stored as `card_moved` from the UI and
	// `api:card_moved` from the API, so a filter has to match both or it
	// answers a different question than the caller asked.
	if (action) {
		conditions.push(actionCondition(action));
		// Where the rows show the stored spelling, `api:` in front means what
		// those rows mean by it: done through the API.
		if (!canonical && action.startsWith('api:')) conditions.push(like(activityLog.action, 'api:%'));
	}
	// Source is filtered on the stored spelling, not the `source` column, because
	// rows written before that column existed have it null. The prefix is the
	// same fact and covers the whole history, so a source filter does not make
	// two and a half thousand older entries disappear.
	if (source === 'api') conditions.push(like(activityLog.action, 'api:%'));
	if (source === 'ui') conditions.push(notLike(activityLog.action, 'api:%'));
	if (from) conditions.push(gte(activityLog.createdAt, from));
	if (to) conditions.push(lte(activityLog.createdAt, to));
	// The entries older than the cursor, in the order the page is read in
	// (card 2387). Written as a row value, SQLite answers it from the index
	// the order reads (`idx_activity_log_created_at`, and the board's and the
	// person's), each of which ends in the id; written as `<` OR (`=` AND `<`)
	// it scanned the whole index. It is one more filter, so `total` and `hasMore`
	// count from the cursor: what this page and the pages after it can give.
	if (before) conditions.push(sql`(${activityLog.createdAt}, ${activityLog.id}) < (${before.createdAt}, ${before.id})`);

	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const entries = db
		.select({
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
		// Newest first, and by id within a second (card 2217): entries are stored
		// in whole seconds, and ordered by the time alone, a page boundary inside
		// one second could give an entry twice and skip another.
		.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
		.limit(limit)
		.offset(offset)
		.all();

	// One query for the board names, not one per entry: on a 500-row page that
	// was 500 round trips to answer a question with at most a couple of dozen
	// distinct answers. A page holds at most 500 ids, well under SQLite's limit
	// on parameters.
	const boardNames = new Map<number, string>();
	const wanted = [...new Set(entries.map((e) => e.boardId))];
	if (wanted.length > 0) {
		const rows = sqlite
			.prepare(`SELECT id, name FROM boards WHERE id IN (${wanted.map(() => '?').join(',')})`)
			.all(...wanted) as { id: number; name: string }[];
		for (const r of rows) boardNames.set(r.id, r.name);
	}

	const data = entries.map((e) => ({
		...e,
		// The canonical name is what callers of v1 filter and group on; the page
		// shows the stored one, and its `api:` draws the API chip. The stored
		// spelling is there either way, so no consumer is broken.
		action: canonical ? canonicalAction(e.action) : e.action,
		rawAction: e.action,
		source: readSource(e),
		boardName: boardNames.get(e.boardId) || 'Unknown'
	}));

	// The total is computed over the same filter, so `hasMore` is a fact rather
	// than an inference from "the page came back full". A full default page of
	// 100 looked exactly like a complete result, which is how a 2,500-entry scan
	// quietly became a 100-entry one.
	const total = Number(db.select({ n: sql<number>`COUNT(*)` }).from(activityLog).where(where).get()?.n ?? 0);

	return {
		data,
		pagination: {
			limit,
			offset,
			count: data.length,
			total,
			hasMore: offset + data.length < total,
			defaultLimit: AUDIT_DEFAULT_LIMIT,
			maxLimit: AUDIT_MAX_LIMIT
		}
	};
}
