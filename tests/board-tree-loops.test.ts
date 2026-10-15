/**
 * Loops in the board tree (cards 2141 and 2142).
 *
 * A board hangs under a card, and the card is on a board, so the boards make a
 * tree. A card moved onto its own sub-board, or onto a board beneath one, made
 * the tree go round: a loop with no top. Every route that moves a card to
 * another board saved that move (2141), and the board page's breadcrumbs then
 * walked round the loop for ever, holding the one Node thread, for every user,
 * the moment anyone opened a board in it or below it (2142).
 *
 * Here:
 *   - the refusal of such a move, on both routes that can move a card to
 *     another board, with nothing written and nothing sent;
 *   - the board page's breadcrumbs on every shape of loop;
 *   - every other walk of the tree, run on a loop, ending;
 *   - `boardsInLoops` and the start-up line that names them;
 *   - what a delete does on a loop, as the admin guide says it;
 *   - that no recursive query uses UNION ALL, which would follow a loop for
 *     ever.
 *
 * A vitest timeout cannot stop a walk that never ends: it never gives the
 * event loop back. So every call that meets a loop runs under `readBudget`,
 * which throws past 1,000 reads, and the test asserts that the budget was not
 * spent as well as what the call answered.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { boards, cards, type Card, type Column } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { getCompletionBlocker } from '$lib/server/card-completion';
import { generateAllBoardsReport, generateBoardReport } from '$lib/server/reports';
import { reportBoardLoops, reportInstallation } from '$lib/server/startup-checks';
import { boardsInLoops } from '$lib/server/sub-boards';
import { boardPlaces, type LinkedBoard } from '$lib/board-tree';
import { pageLoad } from './helpers/actions';
import { api, type ApiResult } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import {
	addBoardMember,
	assignCard,
	makeBoard,
	makeCard,
	makeSmtp,
	makeSubBoard,
	makeUser,
	makeWebhook,
	resetDb,
	type BoardFixture
} from './helpers/fixtures';
import { readBudget, watchReads } from './helpers/reads';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

beforeEach(resetDb);
afterEach(() => {
	process.env.LOG_LEVEL = 'ERROR';
	vi.restoreAllMocks();
});

/** Reads a walk may make before it is taken for one that never ends. */
const BUDGET = 1000;

/**
 * Run `call` under the read budget. A walk that never ends fails it with the
 * budget's error, in milliseconds; a walk that caught that error and went on
 * fails the check that the budget was not spent.
 */
async function withinBudget<T>(call: () => T | Promise<T>): Promise<T> {
	const budget = readBudget(BUDGET);
	let result: T;
	try {
		result = await call();
	} finally {
		budget.restore();
	}
	expect(budget.spent, 'the read budget was spent: a walk that does not end').toBe(false);
	return result;
}

/** Put a card in a column, as a move before card 2141 could, or a restored backup holds. */
function putOn(card: Card, column: Column): void {
	db.update(cards).set({ columnId: column.id }).where(eq(cards.id, card.id)).run();
}

const columnOf = (card: Card) => db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, card.id)).get()?.columnId;
const boardNames = () => db.select({ name: boards.name }).from(boards).orderBy(boards.id).all().map((b) => b.name);

/**
 * Every shape of loop, and the boards around them, all owned by `owner`:
 *
 *     P            top-level
 *     C1, C2       a clean chain under P: C1 under a card on P, C2 under a card on C1
 *     S            under card `s`, which is on S itself
 *     A, B         A under card `a`, which is on B; B under card `b`, which is on A
 *     Z            under a card on S: below the loop, not in it
 *     W            under a card on Z
 *     Y            under a card on A
 */
function world() {
	const owner = makeUser({ username: 'owner' });
	const admin = makeUser({ username: 'admin', role: 'admin' });
	const P = makeBoard({ owner, name: 'P' });
	const top = makeCard(P.cols['To Do'], { title: 'Holds C1' });
	const C1 = makeSubBoard(top, { owner, name: 'C1' });
	const C2 = makeSubBoard(C1.cards[0], { owner, name: 'C2' });

	const s = makeCard(P.cols['To Do'], { title: 'Holds S' });
	const S = makeSubBoard(s, { owner, name: 'S' });
	putOn(s, S.cols['To Do']);

	const a = makeCard(P.cols['To Do'], { title: 'Holds A' });
	const b = makeCard(P.cols['To Do'], { title: 'Holds B' });
	const A = makeSubBoard(a, { owner, name: 'A' });
	const B = makeSubBoard(b, { owner, name: 'B' });
	putOn(a, B.cols['To Do']);
	putOn(b, A.cols['To Do']);

	const Z = makeSubBoard(S.cards[0], { owner, name: 'Z' });
	const W = makeSubBoard(Z.cards[0], { owner, name: 'W' });
	const Y = makeSubBoard(A.cards[0], { owner, name: 'Y' });

	const named: Record<string, BoardFixture> = { P, C1, C2, S, A, B, Z, W, Y };
	return { owner, admin, P, top, C1, C2, s, S, a, A, b, B, Z, W, Y, named };
}

/** Query 1 of the plan's section 4, the owner's read-only check: every board that is its own ancestor. */
const QUERY_1 = `
	WITH RECURSIVE up(start, board) AS (
	  SELECT b.id, col.board_id FROM boards b
	    JOIN cards c ON c.id = b.parent_card_id
	    JOIN columns col ON col.id = c.column_id
	  UNION
	  SELECT up.start, col.board_id FROM up
	    JOIN boards b ON b.id = up.board
	    JOIN cards c ON c.id = b.parent_card_id
	    JOIN columns col ON col.id = c.column_id
	)
	SELECT start AS board_in_a_loop FROM up WHERE board = start ORDER BY start`;

// ─── Card 2141: a card is not moved onto its own sub-board ──────────────────

describe('a card moved onto a board beneath it, at any depth, is refused (card 2141)', () => {
	let sent: Effects;
	beforeEach(() => {
		sent = effects();
	});
	afterEach(() => sent.restore());

	/**
	 * P and Q, top-level; card "Parent card" on P, sub-board X under it, and Y
	 * under a card on X. Someone assigned to the card, who can view every
	 * board, mail set up and a webhook on each board, so that anything a move
	 * sent would be seen.
	 */
	function family() {
		const owner = makeUser({ username: 'owner' });
		const other = makeUser({ username: 'other' });
		const P = makeBoard({ owner, name: 'P' });
		const Q = makeBoard({ owner, name: 'Q' });
		const card = makeCard(P.cols['To Do'], { title: 'Parent card' });
		const X = makeSubBoard(card, { owner, name: 'X' });
		const Y = makeSubBoard(X.cards[0], { owner, name: 'Y' });
		for (const fixture of [P, Q, X, Y]) {
			addBoardMember(fixture.board, other, 'viewer');
			makeWebhook(fixture.board);
		}
		assignCard(card, other);
		makeSmtp();
		return { owner, P, Q, card, X, Y };
	}

	/** The two routes that can move a card to another board. */
	const ROUTES: { route: string; move: (user: SessionUser, card: Card, to: Column, also?: object) => Promise<ApiResult> }[] = [
		{
			route: 'PUT /api/v1/cards/{id}/move',
			move: (user, card, to) => api('PUT', `/api/v1/cards/${card.id}/move`, { user, body: { columnId: to.id } })
		},
		{
			route: 'PUT /api/cards/{id} with a columnId',
			move: (user, card, to, also = {}) => api('PUT', `/api/cards/${card.id}`, { user, body: { ...also, columnId: to.id } })
		}
	];

	/** Make the move, and expect it refused with nothing written and nothing sent. */
	async function expectRefused(move: () => Promise<ApiResult>, card: string, board: string): Promise<void> {
		const before = snapshotDb();
		const res = await move();
		await sent.settle();

		expect(res.status).toBe(409);
		expect(res.body.message).toBe(`Card "${card}" cannot go onto "${board}", which hangs beneath it`);
		expectUnchanged(before);
		expect(sent.all).toEqual([]);
	}

	for (const { route, move } of ROUTES) {
		describe(route, () => {
			it('onto the card’s own sub-board: 409, nothing saved, nothing sent', async () => {
				const f = family();
				await expectRefused(() => move(f.owner, f.card, f.X.cols['In Progress']), 'Parent card', 'X');
			});

			it('onto a board two levels beneath it: 409, and the same through a card in the chain that is archived', async () => {
				const f = family();
				await expectRefused(() => move(f.owner, f.card, f.Y.cols['To Do']), 'Parent card', 'Y');

				db.update(cards).set({ archivedAt: new Date().toISOString() }).where(eq(cards.id, f.X.cards[0].id)).run();
				await expectRefused(() => move(f.owner, f.card, f.Y.cols['To Do']), 'Parent card', 'Y');
			});

			it('a card with two sub-boards, the target beneath the second: 409, so every sub-board is looked at', async () => {
				const f = family();
				const second = makeSubBoard(f.card, { owner: f.owner, name: 'X2' });
				const below = makeSubBoard(second.cards[0], { owner: f.owner, name: 'Under X2' });

				await expectRefused(() => move(f.owner, f.card, below.cols['To Do']), 'Parent card', 'Under X2');
			});

			it('onto a board not beneath it, with a loop elsewhere and above the target: moved, and the check ends', async () => {
				const f = family();
				// A loop on Q's side: S2 under a card on S2 itself, and T under a card on S2.
				const holder = makeCard(f.Q.cols['To Do'], { title: 'Holds S2' });
				const S2 = makeSubBoard(holder, { owner: f.owner, name: 'S2' });
				putOn(holder, S2.cols['To Do']);
				const T = makeSubBoard(S2.cards[0], { owner: f.owner, name: 'T' });

				const res = await withinBudget(() => move(f.owner, f.card, T.cols['To Do']));

				expect(res.status).toBe(200);
				expect(columnOf(f.card)).toBe(T.cols['To Do'].id);
			});

			it('the card a loop hangs from, onto a board outside the loop: moved, and the loop is gone', async () => {
				const f = family();
				// The card now sits on X, the board that hangs from it.
				putOn(f.card, f.X.cols['To Do']);
				expect(boardsInLoops().map((b) => b.boardName)).toEqual(['X']);

				const res = await withinBudget(() => move(f.owner, f.card, f.Q.cols['To Do']));

				expect(res.status).toBe(200);
				expect(columnOf(f.card)).toBe(f.Q.cols['To Do'].id);
				expect(boardsInLoops()).toEqual([]);
			});

			it('a move within a board of a loop: moved, as a move within one board is not looked at', async () => {
				const f = family();
				putOn(f.card, f.X.cols['To Do']);

				const res = await withinBudget(() => move(f.owner, f.card, f.X.cols['In Progress']));

				expect(res.status).toBe(200);
				expect(columnOf(f.card)).toBe(f.X.cols['In Progress'].id);
			});
		});
	}

	it('PUT /api/cards/{id}: a title sent beside the refused columnId is not saved either', async () => {
		const f = family();
		const { move } = ROUTES[1];

		await expectRefused(() => move(f.owner, f.card, f.X.cols['To Do'], { title: 'Renamed' }), 'Parent card', 'X');
		expect(db.select({ title: cards.title }).from(cards).where(eq(cards.id, f.card.id)).get()?.title).toBe('Parent card');
	});

	it('reads the boards inside the transaction that would write the move', async () => {
		const f = family();
		const reads = watchReads('boards');
		let res: ApiResult;
		try {
			res = await ROUTES[0].move(f.owner, f.card, f.X.cols['To Do']);
		} finally {
			reads.restore();
		}

		expect(res.status).toBe(409);
		expect(reads.inTransaction.length).toBeGreaterThan(0);
		expect(reads.inTransaction.every(Boolean)).toBe(true);
	});

	it('costs the same reads for a card with 200 sub-boards as for a card with one: one walk up from the target', async () => {
		// Asking each sub-board in turn walked up from the same target once for
		// each: 2,000 sub-boards on a target 2,000 deep held the one thread for
		// seconds a move, and any editor could build that and repeat it.
		const owner = makeUser({ username: 'owner' });
		const P = makeBoard({ owner, name: 'P' });
		const Q = makeBoard({ owner, name: 'Q' });
		/** A card on P with `count` sub-boards, and a board beneath the last of them. */
		const holding = (count: number) => {
			const card = makeCard(P.cols['To Do'], { title: `Holds ${count}` });
			for (let i = 1; i < count; i++) makeSubBoard(card, { owner, name: `${count}: sub-board ${i}`, cards: {} });
			const last = makeSubBoard(card, { owner, name: `${count}: sub-board ${count}` });
			return { card, below: makeSubBoard(last.cards[0], { owner, name: `${count}: below` }) };
		};
		/** The reads a v1 move makes, every read of every table. */
		const readsOf = async (card: Card, to: Column, status: number) => {
			const budget = readBudget(BUDGET);
			let res: ApiResult;
			try {
				res = await api('PUT', `/api/v1/cards/${card.id}/move`, { user: owner, body: { columnId: to.id } });
			} finally {
				budget.restore();
			}
			expect(res.status).toBe(status);
			expect(budget.spent).toBe(false);
			return budget.count;
		};
		const warm = holding(1);
		const one = holding(1);
		const many = holding(200);
		// Once first, uncounted, so that a statement a module keeps after its
		// first use is counted alike in the two that are compared.
		await readsOf(warm.card, warm.below.cols['To Do'], 409);
		await readsOf(warm.card, Q.cols['To Do'], 200);

		// Refused, the target beneath the last sub-board, and moved, onto Q.
		expect(await readsOf(many.card, many.below.cols['To Do'], 409)).toBe(await readsOf(one.card, one.below.cols['To Do'], 409));
		expect(await readsOf(many.card, Q.cols['To Do'], 200)).toBe(await readsOf(one.card, Q.cols['To Do'], 200));
	});

	it('PUT /api/cards/reorder across boards is still refused before any move', async () => {
		const f = family();
		const before = snapshotDb();

		const res = await api('PUT', '/api/cards/reorder', {
			user: f.owner,
			body: { updates: [{ id: f.card.id, columnId: f.X.cols['To Do'].id, position: 0 }] }
		});

		expect(res.status).toBe(400);
		expect(res.body.message).toBe('A reorder must stay within one board');
		expectUnchanged(before);
	});
});

// ─── Card 2142: the board page on a loop ────────────────────────────────────

describe('the board page’s breadcrumbs end on a loop (card 2142)', () => {
	/** Each board, and the crumbs above it, by board name. */
	const CRUMBS: [string, string[]][] = [
		['P', []],
		['C1', ['P']],
		['C2', ['P', 'C1']],
		// Each loop is shown once round, closing on the board it came back to.
		['S', ['S']],
		['A', ['A', 'B']],
		['B', ['B', 'A']],
		// Below a loop: the walk climbs into it and goes round it once.
		['Z', ['S', 'S']],
		['W', ['S', 'S', 'Z']],
		['Y', ['A', 'B', 'A']]
	];

	for (const [opened, crumbs] of CRUMBS) {
		it(`${opened}: ${crumbs.length === 0 ? 'none' : crumbs.join(' › ')}`, async () => {
			const w = world();

			const res = await withinBudget(() => pageLoad(`/board/${w.named[opened].board.id}`, { user: w.owner }));

			expect(res.type).toBe('data');
			const shown = res.type === 'data' ? res.data.breadcrumbs : [];
			expect(shown.map((crumb: { label: string; href: string | null }) => [crumb.label, crumb.href])).toEqual(
				crumbs.map((name) => [name, `/board/${w.named[name].board.id}`])
			);
		});
	}
});

describe('every other walk of the board tree ends on a loop', () => {
	const PERIOD = ['2000-01-01', '2100-01-01'] as const;

	// Each passes without any change of these cards. They are here so that no
	// later change takes a guard away unseen.
	it('the board report of S, and of A, which walk down from a board in the loop', async () => {
		const w = world();

		const ofS = await withinBudget(() => generateBoardReport(w.S.board.id, ...PERIOD, w.owner));
		const ofA = await withinBudget(() => generateBoardReport(w.A.board.id, ...PERIOD, w.owner));

		expect(ofS).not.toBeNull();
		expect(ofA).not.toBeNull();
	});

	// These two start from top-level boards, which never reach a loop: they
	// pin that the walks still start there, and prove no guard of their own.
	it('the All Boards report', async () => {
		const w = world();
		expect(await withinBudget(() => generateAllBoardsReport(...PERIOD, w.admin))).not.toBeNull();
	});

	it('the dashboard, as an administrator', async () => {
		const w = world();
		expect((await withinBudget(() => pageLoad('/', { user: w.admin }))).type).toBe('data');
	});

	it('All Tasks, which names the boards above each board, each loop once round as the breadcrumbs do (card 1990)', async () => {
		const w = world();

		const res = await withinBudget(() => pageLoad('/all', { user: w.owner }));

		expect(res.type).toBe('data');
		// The load sends each board's nearest parent; the page builds the paths from them.
		const places = boardPlaces(res.type === 'data' ? (res.data.boards as LinkedBoard[]) : []);
		const paths = new Map<number, (string | undefined)[]>([...places].map(([id, place]) => [id, place.path.map((s) => s?.name)]));
		expect(paths.get(w.S.board.id)).toEqual(['S']);
		expect(paths.get(w.A.board.id)).toEqual(['A', 'B']);
		expect(paths.get(w.W.board.id)).toEqual(['S', 'S', 'Z']);
		expect(paths.get(w.C2.board.id)).toEqual(['P', 'C1']);
	});

	it('the completion check of the card S hangs from, which can never pass while the loop is there', async () => {
		const w = world();
		expect(await withinBudget(() => getCompletionBlocker(w.s.id))).toMatch(/^Sub-board "S" has 2 incomplete cards/);
	});

	it('the card context of that card, and the graph of S', async () => {
		const w = world();

		expect((await withinBudget(() => api('GET', `/api/cards/${w.s.id}/context`, { user: w.owner }))).status).toBe(200);
		expect((await withinBudget(() => api('GET', `/api/graph?boardId=${w.S.board.id}`, { user: w.owner }))).status).toBe(200);
	});
});

// ─── Which boards are in a loop, and the line at start ──────────────────────

describe('boardsInLoops()', () => {
	it('lists each board of every loop, with its card and that card’s board, and none below a loop or clean', () => {
		const w = world();

		expect(boardsInLoops()).toEqual([
			{ boardId: w.S.board.id, boardName: 'S', cardId: w.s.id, cardTitle: 'Holds S', cardArchived: false, cardBoardId: w.S.board.id },
			{ boardId: w.A.board.id, boardName: 'A', cardId: w.a.id, cardTitle: 'Holds A', cardArchived: false, cardBoardId: w.B.board.id },
			{ boardId: w.B.board.id, boardName: 'B', cardId: w.b.id, cardTitle: 'Holds B', cardArchived: false, cardBoardId: w.A.board.id }
		]);
	});

	it('names the boards the owner’s query 1 names', () => {
		world();
		const byQuery = (sqlite.prepare(QUERY_1).all() as { board_in_a_loop: number }[]).map((row) => row.board_in_a_loop);

		expect(byQuery.length).toBe(3);
		expect(boardsInLoops().map((b) => b.boardId)).toEqual(byQuery);
	});

	it('is empty with no loop', () => {
		const owner = makeUser();
		const P = makeBoard({ owner });
		const C1 = makeSubBoard(makeCard(P.cols['To Do']), { owner });
		makeSubBoard(C1.cards[0], { owner });

		expect(boardsInLoops()).toEqual([]);
	});

	it('reads the boards once, however deep they nest: a chain 5,000 deep', () => {
		const depth = 5000;
		const board = sqlite.prepare('INSERT INTO boards (name, parent_card_id) VALUES (?, ?)');
		const column = sqlite.prepare("INSERT INTO columns (board_id, title) VALUES (?, 'To Do')");
		const card = sqlite.prepare('INSERT INTO cards (column_id, title) VALUES (?, ?)');
		sqlite.transaction(() => {
			let parent: number | null = null;
			for (let level = 0; level < depth; level++) {
				const boardId: number = Number(board.run(`Level ${level}`, parent).lastInsertRowid);
				const columnId: number = Number(column.run(boardId).lastInsertRowid);
				parent = Number(card.run(columnId, `Card ${level}`).lastInsertRowid);
			}
		})();

		// Every read of every table is counted: a query for each board, of any
		// shape, would be thousands of them. (`watchReads('boards')` would not
		// see one: `wouldLoop`'s recursive query reads `FROM up`.)
		const budget = readBudget(BUDGET);
		let found: ReturnType<typeof boardsInLoops>;
		try {
			found = boardsInLoops();
		} finally {
			budget.restore();
		}

		expect(found).toEqual([]);
		expect(budget.spent).toBe(false);
		expect(budget.count).toBe(1);
	});
});

describe('the line in the system log when a board hangs beneath one of its own cards', () => {
	const lines = () =>
		sqlite.prepare("SELECT level, context, message FROM system_logs WHERE context = 'STARTUP' ORDER BY id").all() as {
			level: string;
			context: string;
			message: string;
		}[];

	beforeEach(() => {
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('is one WARN line naming each board of a loop, its card and that card’s board, and the way out', () => {
		const w = world();

		expect(reportBoardLoops()).toBe(true);

		expect(lines()).toHaveLength(1);
		const [line] = lines();
		expect(line.level).toBe('WARN');
		expect(line.context).toBe('STARTUP');
		expect(line.message).toContain('3 board(s) hang beneath one of their own cards');
		expect(line.message).toContain(`board ${w.S.board.id} "S", under card ${w.s.id} "Holds S" on board ${w.S.board.id}`);
		expect(line.message).toContain(`board ${w.A.board.id} "A", under card ${w.a.id} "Holds A" on board ${w.B.board.id}`);
		expect(line.message).toContain(`board ${w.B.board.id} "B", under card ${w.b.id} "Holds B" on board ${w.A.board.id}`);
		expect(line.message).not.toContain('"Z"');
		// The way out, that one move puts a whole loop right, and a warning
		// against the delete that looks like one: the boards below a loop are
		// named nowhere, and every delete of the loop takes them too.
		expect(line.message).toContain(
			'. To put one right, open All Tasks, find the card and move it onto a board outside the loop: one move for ' +
				'each loop is enough. Do not delete a board, card or column of a loop to clear it: that deletes every board ' +
				'of the loop and every board below it. See docs/admin-guide.md, under "A board beneath one of its own cards".'
		);
		expect(line.message.endsWith('under "A board beneath one of its own cards".')).toBe(true);
	});

	it('marks a card that is archived, which All Tasks does not list, to be restored first', () => {
		const w = world();
		db.update(cards).set({ archivedAt: new Date().toISOString() }).where(eq(cards.id, w.s.id)).run();

		expect(boardsInLoops().map((b) => [b.boardName, b.cardArchived])).toEqual([
			['S', true],
			['A', false],
			['B', false]
		]);
		expect(reportBoardLoops()).toBe(true);

		const [line] = lines();
		expect(line.message).toContain(
			`board ${w.S.board.id} "S", under card ${w.s.id} "Holds S" (archived: restore it from Archived first) on board ${w.S.board.id}`
		);
		expect(line.message).toContain(`board ${w.A.board.id} "A", under card ${w.a.id} "Holds A" on board ${w.B.board.id}`);
	});

	it('prints a line break, or any other control character, in a name or a title as a space: a name cannot split the line', () => {
		const w = world();
		const forged = '[2026-10-15T08:00:00.000Z] [CRITICAL] [AUTH] forged';
		db.update(boards).set({ name: `S\r\n${forged}` }).where(eq(boards.id, w.S.board.id)).run();
		db.update(cards).set({ title: `Holds S\n\t\u0000\u007f${forged}` }).where(eq(cards.id, w.s.id)).run();

		expect(reportBoardLoops()).toBe(true);

		const [line] = lines();
		expect(line.message).toContain(
			`board ${w.S.board.id} "S  ${forged}", under card ${w.s.id} "Holds S    ${forged}" on board ${w.S.board.id}`
		);
		expect(line.message).not.toMatch(/[\x00-\x1f\x7f]/);
		// And on the console, where a line break would have begun a line of its own.
		const printed = vi.mocked(console.warn).mock.calls.map(([text]) => String(text));
		expect(printed).toHaveLength(1);
		expect(printed[0].split(/[\r\n]/)).toHaveLength(1);
	});

	it('is not said with no loop', () => {
		const owner = makeUser();
		const P = makeBoard({ owner });
		makeSubBoard(makeCard(P.cols['To Do']), { owner });

		expect(reportBoardLoops()).toBe(false);
		expect(lines()).toEqual([]);
	});

	it('names 20 boards, by id, and counts the rest', () => {
		const owner = makeUser();
		const P = makeBoard({ owner });
		const looped: number[] = [];
		for (let i = 1; i <= 25; i++) {
			const card = makeCard(P.cols['To Do'], { title: `Holds L${i}` });
			const L = makeSubBoard(card, { owner, name: `L${i}`, cards: {} });
			putOn(card, L.cols['To Do']);
			looped.push(L.board.id);
		}

		expect(reportBoardLoops()).toBe(true);

		const [line] = lines();
		expect(lines()).toHaveLength(1);
		expect(line.message).toContain('25 board(s) hang beneath one of their own cards');
		for (const [i, id] of looped.entries()) {
			if (i < 20) expect(line.message).toContain(`board ${id} "L${i + 1}"`);
			else expect(line.message).not.toContain(`board ${id} "L${i + 1}"`);
		}
		expect(line.message).toContain('; and 5 more.');
	});

	it('is said by what the server calls as it starts, which changes nothing else', () => {
		world();
		makeUser({ username: 'chief', role: 'superadmin' });
		const before = snapshotDb();

		reportInstallation();

		expect(lines().map((line) => line.level)).toEqual(['WARN']);
		expect(lines()[0].message).toContain('3 board(s) hang beneath one of their own cards');
		expectUnchanged(before);
	});
});

// ─── What a delete does on a loop ───────────────────────────────────────────

describe('a delete that reaches a loop takes every board of it and every board below it, and ends', () => {
	// What the admin guide warns of. None of these hangs the server; each takes
	// more than a reader of its button might expect.
	const DOORS: { door: string; request: (w: ReturnType<typeof world>) => Promise<ApiResult>; gone: string[] }[] = [
		{ door: 'deleting S', request: (w) => api('DELETE', `/api/boards/${w.S.board.id}`, { user: w.owner }), gone: ['S', 'Z', 'W'] },
		{ door: 'deleting A, of a loop of two', request: (w) => api('DELETE', `/api/boards/${w.A.board.id}`, { user: w.owner }), gone: ['A', 'B', 'Y'] },
		{ door: 'deleting Z, below the loop', request: (w) => api('DELETE', `/api/boards/${w.Z.board.id}`, { user: w.owner }), gone: ['Z', 'W'] },
		{
			door: 'deleting the card S hangs from',
			request: (w) => api('DELETE', `/api/cards/${w.s.id}?permanent=true`, { user: w.owner }),
			gone: ['S', 'Z', 'W']
		},
		{
			door: 'deleting the column that card is in',
			request: (w) => api('DELETE', `/api/columns/${w.S.cols['To Do'].id}`, { user: w.owner }),
			gone: ['S', 'Z', 'W']
		},
		{
			door: 'purging the archive while that card is archived',
			request: (w) => {
				db.update(cards).set({ archivedAt: new Date().toISOString() }).where(eq(cards.id, w.s.id)).run();
				return api('POST', '/api/admin/purge-archived', { user: w.admin });
			},
			gone: ['S', 'Z', 'W']
		},
		{
			// Its warning says the board is kept. In a loop the board's own card is
			// among those cleared, and the board goes with it.
			door: 'Clear Cards on S',
			request: (w) => api('POST', `/api/admin/boards/${w.S.board.id}/clear-cards`, { user: w.admin }),
			gone: ['S', 'Z', 'W']
		}
	];

	for (const { door, request, gone } of DOORS) {
		it(`${door}: ${gone.join(', ')}`, async () => {
			const w = world();
			const everyBoard = boardNames();

			const res = await withinBudget(() => request(w));

			expect(res.status).toBe(200);
			expect(boardNames()).toEqual(everyBoard.filter((name) => !gone.includes(name)));
		});
	}

	// Clear Cards and a purge write their entry on the board they took cards
	// from. On a loop that board went too, so nothing recorded that it went,
	// where a card or a column deleted the same way writes a line in the
	// system log; and its page was told its cards were cleared, or purged.
	describe('Clear Cards and a purge that take a loop board say so as a card or a column does', () => {
		const lines = () =>
			sqlite.prepare("SELECT level, message, user_id AS userId FROM system_logs WHERE context = 'DELETE' ORDER BY id").all();
		/** What went: S's two cards, Z's and W's, and the boards S, Z and W. */
		const WHAT_WENT =
			'4 card(s), 0 subtask(s), 3 sub-board(s), 0 dependency link(s), 0 report schedule(s); ' +
			'0 attachment file(s) to the trash; 0 card(s) elsewhere released from its milestones';

		/** Send the request as the administrator, and what each board's open page was told. */
		async function told(w: ReturnType<typeof world>, request: () => Promise<ApiResult>): Promise<string[]> {
			process.env.LOG_LEVEL = 'INFO';
			vi.spyOn(console, 'log').mockImplementation(() => {});
			const nameOf = new Map(Object.entries(w.named).map(([name, fixture]) => [fixture.board.id, name]));
			const sent = effects();
			try {
				expect((await withinBudget(request)).status).toBe(200);
				await sent.settle();
			} finally {
				sent.restore();
			}
			return sent.events.map((e) => `${nameOf.get(e.boardId) ?? e.boardId} ${JSON.stringify(e.data)}`);
		}

		it('Clear Cards on S: S is told it was deleted, and the system log names it', async () => {
			const w = world();

			const events = await told(w, () => api('POST', `/api/admin/boards/${w.S.board.id}/clear-cards`, { user: w.admin }));

			expect(lines()).toEqual([
				{
					level: 'INFO',
					userId: w.admin.id,
					message:
						`The cards of board ${w.S.board.id} "S" were cleared by admin, and the board was a sub-board under one ` +
						`of its own cards and went with them: ${WHAT_WENT}`
				}
			]);
			expect(events).toEqual([
				'S {"type":"board","action":"deleted"}',
				'Z {"type":"card","action":"cleared"}',
				'W {"type":"card","action":"cleared"}'
			]);
		});

		it('a purge with the card S hangs from archived: S is told it was deleted, and the system log names it', async () => {
			const w = world();
			db.update(cards).set({ archivedAt: new Date().toISOString() }).where(eq(cards.id, w.s.id)).run();

			const events = await told(w, () => api('POST', '/api/admin/purge-archived', { user: w.admin }));

			expect(lines()).toEqual([
				{
					level: 'INFO',
					userId: w.admin.id,
					message:
						'Archived cards were purged by admin, and 1 board(s) that held some of them went with them, each beneath ' +
						`one of the cards purged, as a board in a loop is beneath its own: board ${w.S.board.id} "S", which held 1. ` +
						`In all: ${WHAT_WENT}`
				}
			]);
			expect(events).toEqual([
				'S {"type":"board","action":"deleted"}',
				'Z {"type":"card","action":"purged"}',
				'W {"type":"card","action":"purged"}'
			]);
		});
	});
});

// ─── No recursive query uses UNION ALL ──────────────────────────────────────

describe('no recursive query of the board tree uses UNION ALL', () => {
	const ROOT = process.cwd();

	/** The text of every string and template in a file: its SQL, and none of its comments. */
	function textsOf(file: string): string {
		const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
		const texts: string[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) texts.push(node.text);
			else if (ts.isTemplateExpression(node)) texts.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text));
			ts.forEachChild(node, visit);
		};
		visit(source);
		return texts.join('\n');
	}

	const sources = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[])
		.map((path) => `src/${path.split('\\').join('/')}`)
		.filter((path) => path.endsWith('.ts'))
		.sort();
	const RECURSIVE = /\bWITH\s+RECURSIVE\b/i;
	const UNION_ALL = /\bUNION\s+ALL\b/i;

	// A recursive statement is one read, which no read budget can stop. Built
	// with UNION it keeps each row once and ends on a loop; with UNION ALL it
	// would follow the loop for ever.
	//
	// That is all this checks. UNION ends a loop only because a row it has
	// already produced is not produced again: a recursive step that carries a
	// column that changes at every step, a depth or a path, makes every row new
	// and goes round a loop for ever with UNION too. Such a step must bound
	// itself with a WHERE (a depth limit, or the path not already holding the
	// board), which this test does not look for.
	it('has no UNION ALL in a file that holds WITH RECURSIVE', () => {
		const recursive = sources.filter((path) => RECURSIVE.test(textsOf(path)));

		expect(recursive).toEqual(expect.arrayContaining(['src/lib/server/deletes.ts', 'src/lib/server/sub-boards.ts']));
		expect(recursive.filter((path) => UNION_ALL.test(textsOf(path)))).toEqual([]);
	});

	it('reads the SQL and not the comments: tokens.ts has UNION ALL and no recursion, and deletes.ts names UNION ALL only in a comment', () => {
		expect(UNION_ALL.test(textsOf('src/lib/server/tokens.ts'))).toBe(true);
		expect(RECURSIVE.test(textsOf('src/lib/server/tokens.ts'))).toBe(false);
		expect(UNION_ALL.test(readFileSync(join(ROOT, 'src/lib/server/deletes.ts'), 'utf8'))).toBe(true);
		expect(UNION_ALL.test(textsOf('src/lib/server/deletes.ts'))).toBe(false);
	});
});
