/**
 * The two audit routes, side by side (card 2294): `GET /api/audit`, the
 * Audit & Logging page's log, and `GET /api/v1/audit-log`. Both read the log
 * through `queryAuditLog` (`src/lib/server/audit-log.ts`), and the seven ways
 * they had come apart are each settled there:
 *
 *   1. `api:` in the action filter is read as each route shows the action:
 *      done through the API on the page's route, whose rows show the stored
 *      spelling; a spelling on v1, whose rows show it canonical.
 *   2. `cardId` filters both.
 *   3. Both rows carry `rawAction` and `source`; `action` is as stored on the
 *      page's route and canonical on v1.
 *   4. Both answers carry v1's `pagination`, with `total` and `hasMore`.
 *   5. The board names are read in one query on both.
 *   6. One admin check, a superadmin included.
 *   7. The ids are refused in v1's words on both.
 *
 * As the twin files do, one fixture is asked the same question through both
 * routes, and the answers are compared whole, the differences kept on purpose
 * written in: `action`, and the form of `createdAt` (the stored form on the
 * page's route, ISO 8601 on v1, each tree's rule for every route).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, sqlite } from '$lib/server/db';
import { activityLog } from '$lib/server/db/schema';
import { toIso } from '$lib/timestamps';
import { api } from './helpers/api';
import { makeBoard, makeCard, makeUser, resetDb } from './helpers/fixtures';

beforeEach(resetDb);

const ROUTES = ['/api/audit', '/api/v1/audit-log'] as const;

/**
 * Boards Alpha, Bravo and Charlie, a card on each, and five entries: a page
 * move and an API completion on Alpha's card, an API move on Bravo's, a page
 * comment on Charlie's, and one older entry on Alpha written before `source`
 * existed (its column null).
 */
function world() {
	const admin = makeUser({ username: 'auditor', role: 'admin' });
	const owner = makeUser({ username: 'owner' });
	const A = makeBoard({ owner, name: 'Alpha' });
	const B = makeBoard({ owner, name: 'Bravo' });
	const C = makeBoard({ owner, name: 'Charlie' });
	const a = makeCard(A.cols['To Do'], { title: 'Plan' });
	const b = makeCard(B.cols['To Do'], { title: 'Ship' });
	const c = makeCard(C.cols['To Do'], { title: 'Tell' });
	const entry = (boardId: number, cardId: number, action: string, source: string | null, createdAt: string) =>
		db
			.insert(activityLog)
			.values({ boardId, cardId, userId: owner.id, action, detail: `${action} on ${cardId}`, userName: 'owner', userEmoji: '🦊', source, createdAt })
			.returning()
			.get();
	const rows = [
		entry(A.board.id, a.id, 'api:card_moved', null, '2026-10-01 09:00:00'),
		entry(A.board.id, a.id, 'card_moved', 'ui', '2026-10-02 09:00:00'),
		entry(A.board.id, a.id, 'api:card_completed', 'api', '2026-10-03 09:00:00'),
		entry(B.board.id, b.id, 'api:card_moved', 'api', '2026-10-04 09:00:00'),
		entry(C.board.id, c.id, 'comment_added', 'ui', '2026-10-05 09:00:00')
	];
	return { admin, owner, A, B, C, a, b, c, rows };
}

/** Both routes' answers to one query, each 200. */
async function both(query: string, user: ReturnType<typeof makeUser>) {
	const [internal, v1] = await Promise.all(ROUTES.map((route) => api('GET', `${route}${query}`, { user })));
	expect([internal.status, v1.status], JSON.stringify([internal.body, v1.body])).toEqual([200, 200]);
	return { internal: internal.body, v1: v1.body };
}

describe('the two audit routes, one reader (card 2294)', () => {
	it('answer the same rows and the same pagination, but for action (as stored, against canonical) and the form of createdAt', async () => {
		const w = world();

		const { internal, v1 } = await both('?limit=3', w.admin);

		// Newest first; what the Audit page reads of each row is there.
		const expected = [w.rows[4], w.rows[3], w.rows[2]].map((row) => ({
			id: row.id,
			boardId: row.boardId,
			cardId: row.cardId,
			userId: w.owner.id,
			action: row.action,
			detail: row.detail,
			userName: 'owner',
			userEmoji: '🦊',
			source: row.action.startsWith('api:') ? 'api' : 'ui',
			createdAt: row.createdAt,
			rawAction: row.action,
			boardName: row.boardId === w.A.board.id ? 'Alpha' : row.boardId === w.B.board.id ? 'Bravo' : 'Charlie'
		}));
		expect(internal.data).toEqual(expected);
		expect(v1.data).toEqual(
			expected.map((row) => ({ ...row, action: row.action.replace(/^api:/, ''), createdAt: toIso(row.createdAt) }))
		);
		const pagination = { limit: 3, offset: 0, count: 3, total: 5, hasMore: true, defaultLimit: 100, maxLimit: 500 };
		expect(internal.pagination).toEqual(pagination);
		expect(v1.pagination).toEqual(pagination);
	});

	it('read an older entry’s source from its spelling on both, where the page’s route answered null', async () => {
		const w = world();

		const { internal, v1 } = await both(`?boardId=${w.A.board.id}&from=2026-10-01&to=2026-10-01`, w.admin);

		expect(internal.data.map((row: { action: string; rawAction: string; source: string }) => [row.action, row.rawAction, row.source])).toEqual([
			['api:card_moved', 'api:card_moved', 'api']
		]);
		expect(v1.data.map((row: { action: string; rawAction: string; source: string }) => [row.action, row.rawAction, row.source])).toEqual([
			['card_moved', 'api:card_moved', 'api']
		]);
		expect(internal.pagination).toMatchObject({ count: 1, total: 1, hasMore: false });
	});

	it('read api: in the action filter as each shows the action: through the API on the page’s route, a spelling on v1', async () => {
		const w = world();
		const ids = (rows: { id: number }[]) => rows.map((row) => row.id);

		const { internal, v1 } = await both('?action=api:card_moved', w.admin);

		expect(ids(internal.data)).toEqual([w.rows[3].id, w.rows[0].id]);
		expect(ids(v1.data)).toEqual([w.rows[3].id, w.rows[1].id, w.rows[0].id]);
		// Written bare, both find the action however it was done.
		const bare = await both('?action=card_moved', w.admin);
		expect(ids(bare.internal.data)).toEqual(ids(bare.v1.data));
		expect(ids(bare.internal.data)).toEqual([w.rows[3].id, w.rows[1].id, w.rows[0].id]);
	});

	it('filter by cardId on both, where the page’s route ignored it and answered every entry', async () => {
		const w = world();

		const { internal, v1 } = await both(`?cardId=${w.b.id}`, w.admin);

		expect(internal.data.map((row: { id: number }) => row.id)).toEqual([w.rows[3].id]);
		expect(v1.data.map((row: { id: number }) => row.id)).toEqual([w.rows[3].id]);
		expect(internal.pagination).toMatchObject({ total: 1, hasMore: false });
	});

	it.each(ROUTES)('%s reads the board names of a page in one query, entries on three boards', async (route) => {
		const w = world();
		const prepared: string[] = [];
		const prepare = sqlite.prepare.bind(sqlite);
		const spy = vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
			prepared.push(source);
			return prepare(source);
		}) as typeof sqlite.prepare);
		try {
			const res = await api('GET', route, { user: w.admin });
			expect(res.status).toBe(200);
			expect(new Set(res.body.data.map((row: { boardName: string }) => row.boardName))).toEqual(new Set(['Alpha', 'Bravo', 'Charlie']));
		} finally {
			spy.mockRestore();
		}
		// Drizzle's `from "boards"` and the reader's `FROM boards`, whichever wrote it.
		const boardReads = prepared.filter((source) => /\bfrom "?boards"?(\s|$)/i.test(source));
		expect(boardReads).toHaveLength(1);
		expect(boardReads[0]).toMatch(/WHERE id IN \(\?,\?,\?\)/);
	});

	it.each([
		['boardId=2.5', 'Invalid board ID'],
		['userId=5abc', 'Invalid user ID'],
		['cardId=0', 'Invalid card ID']
	])('refuse %s in the same words on both: %s', async (query, message) => {
		const w = world();
		for (const route of ROUTES) {
			const res = await api('GET', `${route}?${query}`, { user: w.admin });
			expect([route, res.status, res.body]).toEqual([route, 400, { message }]);
		}
	});

	it('refuse a member who is no administrator in the same words, and let a superadmin read both', async () => {
		const w = world();
		const superadmin = makeUser({ username: 'root', role: 'superadmin' });
		for (const route of ROUTES) {
			const refused = await api('GET', route, { user: w.owner });
			expect([route, refused.status, refused.body]).toEqual([route, 403, { message: 'Admin access required' }]);
			const read = await api('GET', route, { user: superadmin });
			expect([route, read.status, read.body.pagination.total]).toEqual([route, 200, 5]);
		}
	});
});

// Card 2387: both routes paged by `offset` alone, newest first, so each entry written
// between two pages pushed every older one down a place and the next page began with
// one already given. `before`, the last entry held, pages by (createdAt, id) instead.
describe('the two audit routes page by a cursor, the last entry held (card 2387)', () => {
	type Row = { id: number; createdAt: string };
	const ids = (rows: Row[]) => rows.map((row) => row.id);
	const cursor = (row: Row) => encodeURIComponent(`${row.createdAt},${row.id}`);

	it.each(ROUTES)('%s: an entry written between two pages is not given twice with before, where offset gave one again', async (route) => {
		const w = world();
		const read = async (query: string) => {
			const res = await api('GET', `${route}?limit=2${query}`, { user: w.admin });
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			return res.body as { data: Row[]; pagination: Record<string, unknown> };
		};

		const first = await read('');
		expect(ids(first.data)).toEqual([w.rows[4].id, w.rows[3].id]);
		// Someone works on Alpha's card meanwhile.
		db.insert(activityLog).values({ boardId: w.A.board.id, cardId: w.a.id, userId: w.owner.id, action: 'card_moved', source: 'ui', createdAt: '2026-10-06 09:00:00' }).run();

		const byOffset = await read('&offset=2');
		expect(ids(byOffset.data)).toEqual([w.rows[3].id, w.rows[2].id]);

		const second = await read(`&before=${cursor(first.data[1])}`);
		expect(ids(second.data)).toEqual([w.rows[2].id, w.rows[1].id]);
		// The cursor is one more filter: total is what lies older than it, and hasMore whether any follows this page.
		expect(second.pagination).toMatchObject({ offset: 0, count: 2, total: 3, hasMore: true });

		const last = await read(`&before=${cursor(second.data[1])}`);
		expect(ids(last.data)).toEqual([w.rows[0].id]);
		expect(last.pagination).toMatchObject({ count: 1, total: 1, hasMore: false });
		// An offset still applies, counted from the cursor.
		expect(ids((await read(`&before=${cursor(first.data[1])}&offset=1`)).data)).toEqual([w.rows[1].id, w.rows[0].id]);
	});

	it('a page that ends inside one second goes on from the entry after it by id, on both routes, with the filters', async () => {
		const w = world();
		const same = [1, 2, 3, 4].map(() =>
			db.insert(activityLog).values({ boardId: w.B.board.id, cardId: w.b.id, userId: w.owner.id, action: 'card_moved', source: 'ui', createdAt: '2026-10-07 12:00:00' }).returning().get()
		);

		const { internal, v1 } = await both(`?boardId=${w.B.board.id}&limit=2`, w.admin);
		expect(ids(internal.data)).toEqual([same[3].id, same[2].id]);
		const next = await both(`?boardId=${w.B.board.id}&limit=2&before=${cursor(internal.data[1])}`, w.admin);
		// The page's route answers the stored form, v1 ISO 8601: each takes its own back.
		const nextV1 = await both(`?boardId=${w.B.board.id}&limit=2&before=${cursor(v1.data[1])}`, w.admin);
		for (const page of [next.internal, next.v1, nextV1.internal, nextV1.v1]) {
			expect(ids(page.data)).toEqual([same[1].id, same[0].id]);
			expect(page.pagination).toMatchObject({ total: 3, hasMore: true });
		}
	});

	it.each([
		['abc'],
		['2026-10-21'],
		['2026-10-21,5'],
		['2026-10-21T09:00:00Z'],
		['2026-10-21T09:00:00Z,0'],
		['2026-10-21T09:00:00Z,abc'],
		['2026-10-21T09:00:00Z,2.5'],
		['2026-13-01 09:00:00,5'],
		[',5']
	])('refuse before=%s in the same words on both', async (value) => {
		const w = world();
		for (const route of ROUTES) {
			const res = await api('GET', `${route}?before=${encodeURIComponent(value)}`, { user: w.admin });
			expect([route, res.status, res.body]).toEqual([route, 400, { message: "before must be an entry's createdAt and id, as 2026-10-21T09:00:00Z,1234" }]);
		}
		// Sent empty, it is no cursor.
		const { internal } = await both('?before=', w.admin);
		expect(internal.pagination.total).toBe(5);
	});

	it('is answered from the log’s time index by the row value, alone, with a board and with a person, never by a scan', async () => {
		const admin = makeUser({ username: 'auditor', role: 'admin' });
		/** The statements the reader prepares for a page with a cursor, each as SQLite's planner would answer it. */
		const plans = async (query: string) => {
			const prepared: string[] = [];
			const prepare = sqlite.prepare.bind(sqlite);
			const spy = vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
				prepared.push(source);
				return prepare(source);
			}) as typeof sqlite.prepare);
			try {
				const res = await api('GET', `/api/v1/audit-log?${query}`, { user: admin });
				expect(res.status).toBe(200);
			} finally {
				spy.mockRestore();
			}
			return prepared
				.filter((source) => /from "activity_log"/i.test(source))
				.map((source) => {
					const params = (source.match(/\?/g) ?? []).map(() => 1);
					const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${source}`).all(...params) as { detail: string }[];
					return plan.map((step) => step.detail).join(' | ');
				});
		};
		const before = encodeURIComponent('2026-10-21T09:00:00Z,1234');

		const plain = await plans(`before=${before}`);
		const board = await plans(`boardId=3&before=${before}`);
		const person = await plans(`userId=${admin.id}&before=${before}`);
		// The page, and its COUNT.
		expect(plain).toHaveLength(2);
		expect(plain[0]).toMatch(/idx_activity_log_created_at \(\(created_at,rowid\)<\(\?,\?\)\)/);
		expect(board[0]).toMatch(/idx_activity_log_board_created \(board_id=\? AND \(created_at,rowid\)<\(\?,\?\)\)/);
		// One person's: the person's own index, as the plan and the documents say (the review).
		expect(person[0]).toMatch(/idx_activity_log_user_id_created_at \(user_id=\? AND \(created_at,rowid\)<\(\?,\?\)\)/);
		for (const plan of [...plain, ...board, ...person]) expect(plan).not.toMatch(/\bSCAN\b/);
	});
});
