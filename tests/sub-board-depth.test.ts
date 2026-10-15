/**
 * How deep sub-boards may nest (card 2172).
 *
 * A board hangs under a card, and the card is on a board, so the boards make a
 * tree, and nothing bounded how deep it went: any signed-in user could nest
 * boards by script as deep as they liked, and every load of the deepest board
 * walked its breadcrumbs up the whole chain, three reads a level. Now a
 * sub-board may be at most `MAX_SUB_BOARD_DEPTH` (20) levels below a board
 * that hangs under no card.
 *
 * Here:
 *   - the two queries that count depth and height, on a chain, a loop and a
 *     board whose parent card is gone;
 *   - each way a board gets deeper refused past the limit, 409, with nothing
 *     written: made (both routes), moved with its card (both routes that move
 *     a card to another board) and linked under a card;
 *   - a tree already deeper, which keeps working and can be lifted;
 *   - the board page's breadcrumbs, which show the nearest 20 and a "…".
 *
 * The board page's own refusals (Create Sub-board, the new-card window) are
 * in `tests/page-failures.test.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { boards, cards, type Card } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import {
	depthOf,
	heightOfBoard,
	heightUnderCard,
	linkableBoards,
	MAX_SUB_BOARD_DEPTH,
	tooDeepToLink,
	tooDeepToMake,
	tooDeepToMove
} from '$lib/server/sub-boards';
import { pageLoad } from './helpers/actions';
import { api, type ApiResult } from './helpers/api';
import { makeBoard, makeCard, makeSubBoard, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';
import { watchReads } from './helpers/reads';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

beforeEach(resetDb);

/** A board of a chain and the card on it that the next board hangs under. */
type Level = BoardFixture & { card: Card };

/**
 * A chain of boards, each under the card of the one before, all owned by
 * `owner`: `levels[0]` hangs under no card, and `levels[i]` is `i` levels
 * deep. Made with the fixtures, which write the rows directly, so a chain past
 * the limit can be made as a restored backup would hold it.
 */
function chain(owner: SessionUser, deepest: number, name = 'Level'): Level[] {
	const top = makeBoard({ owner, name: `${name} 0` });
	const levels: Level[] = [{ ...top, card: makeCard(top.cols['To Do'], { title: `On ${name} 0` }) }];
	for (let depth = 1; depth <= deepest; depth++) {
		const sub = makeSubBoard(levels[depth - 1].card, { owner, name: `${name} ${depth}`, cards: {} });
		levels.push({ ...sub, card: makeCard(sub.cols['To Do'], { title: `On ${name} ${depth}` }) });
	}
	return levels;
}

/** Put a card in a column directly, as a restored backup could hold it. */
function putOn(card: Card, columnId: number): void {
	db.update(cards).set({ columnId }).where(eq(cards.id, card.id)).run();
}

const parentOf = (boardId: number) => db.select({ parentCardId: boards.parentCardId }).from(boards).where(eq(boards.id, boardId)).get()!.parentCardId;
const columnOf = (card: Card) => db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, card.id)).get()!.columnId;

/** The two routes that make a board. */
const MAKERS = [
	{ route: 'POST /api/boards', make: (user: SessionUser, parentCardId: number) => api('POST', '/api/boards', { user, body: { name: 'New', parentCardId } }) },
	{ route: 'POST /api/v1/boards', make: (user: SessionUser, parentCardId: number) => api('POST', '/api/v1/boards', { user, body: { name: 'New', parentCardId } }) }
];

/** The two routes that move a card to another board. */
const MOVERS = [
	{
		route: 'PUT /api/v1/cards/{id}/move',
		move: (user: SessionUser, card: Card, columnId: number) => api('PUT', `/api/v1/cards/${card.id}/move`, { user, body: { columnId } })
	},
	{
		route: 'PUT /api/cards/{id} with a columnId',
		move: (user: SessionUser, card: Card, columnId: number) => api('PUT', `/api/cards/${card.id}`, { user, body: { columnId } })
	}
];

describe('depthOf and heightUnderCard: how deep a board is, and how many levels hang below', () => {
	it('count a chain, and stop one past the limit', () => {
		const owner = makeUser({ username: 'owner' });
		const levels = chain(owner, 25);

		expect(MAX_SUB_BOARD_DEPTH).toBe(20);
		expect(depthOf(levels[0].board.id)).toBe(0);
		expect(depthOf(levels[1].board.id)).toBe(1);
		expect(depthOf(levels[20].board.id)).toBe(20);
		// Past the limit, one past it: the walk up stops there.
		expect(depthOf(levels[21].board.id)).toBe(21);
		expect(depthOf(levels[25].board.id)).toBe(21);

		// The last card has no sub-board; the one before it, one level.
		expect(heightUnderCard(levels[25].card.id)).toBe(0);
		expect(heightUnderCard(levels[24].card.id)).toBe(1);
		expect(heightUnderCard(levels[0].card.id)).toBe(21);
		expect(heightOfBoard(levels[25].board.id)).toBe(0);
		expect(heightOfBoard(levels[23].board.id)).toBe(2);
		expect(heightOfBoard(levels[0].board.id)).toBe(21);
		// Asked for no more than it needs, it stops there.
		expect(heightUnderCard(levels[0].card.id, 3)).toBe(3);
		expect(heightOfBoard(levels[0].board.id, 2)).toBe(2);
	});

	it('end on a loop, which reads as past the limit, and read a board whose parent card is gone as the top', () => {
		const owner = makeUser({ username: 'owner' });
		const P = makeBoard({ owner, name: 'P' });
		// S hangs under card s, which is on S itself.
		const s = makeCard(P.cols['To Do'], { title: 'Holds S' });
		const S = makeSubBoard(s, { owner, name: 'S' });
		putOn(s, S.cols['To Do'].id);
		// Z hangs under a card on S: below the loop, not in it.
		const Z = makeSubBoard(S.cards[0], { owner, name: 'Z' });

		// What proves that each ends is that this test finishes: each is one
		// statement, where no read budget can reach.
		expect(depthOf(S.board.id)).toBe(21);
		expect(depthOf(Z.board.id)).toBe(21);
		expect(heightUnderCard(s.id)).toBe(21);
		expect(heightOfBoard(S.board.id)).toBe(21);

		// Production's boards have no key on parent_card_id (the schema test's
		// fixture), so a board can name a card that is gone. Made here with the
		// keys off, as the breadcrumbs meet it: the top.
		sqlite.pragma('foreign_keys = OFF');
		let orphan: BoardFixture;
		try {
			orphan = makeBoard({ owner, name: 'Orphan', parentCardId: 999999 });
		} finally {
			sqlite.pragma('foreign_keys = ON');
		}
		expect(depthOf(orphan.board.id)).toBe(0);
	});
});

describe('making a sub-board past the limit is refused', () => {
	for (const { route, make } of MAKERS) {
		describe(route, () => {
			it('makes one 20 levels deep, and refuses one 21 deep with 409, writing nothing', async () => {
				const owner = makeUser({ username: 'owner' });
				const levels = chain(owner, 20);

				const made = await make(owner, levels[19].card.id);
				expect(made.status, JSON.stringify(made.body)).toBe(201);
				expect(depthOf((made.body as { id: number }).id)).toBe(20);

				const before = snapshotDb();
				const refused = await make(owner, levels[20].card.id);
				expect(refused.status).toBe(409);
				expect(refused.body).toEqual({ message: tooDeepToMake() });
				expect(refused.body).toEqual({ message: 'Sub-boards can be nested at most 20 levels deep, and a board under this card would be deeper.' });
				expectUnchanged(before);
			});

			it('refuses one under a card on a board below a loop, and ends', async () => {
				const owner = makeUser({ username: 'owner' });
				const P = makeBoard({ owner, name: 'P' });
				const s = makeCard(P.cols['To Do'], { title: 'Holds S' });
				const S = makeSubBoard(s, { owner, name: 'S' });
				putOn(s, S.cols['To Do'].id);
				const Z = makeSubBoard(S.cards[0], { owner, name: 'Z' });
				const before = snapshotDb();

				const res = await make(owner, Z.cards[0].id);

				expect(res.status).toBe(409);
				expect(res.body).toEqual({ message: tooDeepToMake() });
				expectUnchanged(before);
			});

			it('makes one under a card on a top-level board, as before', async () => {
				const owner = makeUser({ username: 'owner' });
				const top = makeBoard({ owner, name: 'Top' });
				const res = await make(owner, makeCard(top.cols['To Do']).id);

				expect(res.status, JSON.stringify(res.body)).toBe(201);
			});
		});
	}
});

describe('moving a card whose sub-boards would go past the limit is refused', () => {
	/**
	 * A card on a top-level board carrying three levels of sub-boards, and a
	 * chain to move it onto.
	 */
	function scene() {
		const owner = makeUser({ username: 'owner' });
		const home = makeBoard({ owner, name: 'Home' });
		const card = makeCard(home.cols['To Do'], { title: 'Carries three' });
		const one = makeSubBoard(card, { owner, name: 'One' });
		const two = makeSubBoard(one.cards[0], { owner, name: 'Two' });
		makeSubBoard(two.cards[0], { owner, name: 'Three' });
		return { owner, home, card, levels: chain(owner, 20) };
	}

	for (const { route, move } of MOVERS) {
		describe(route, () => {
			it('onto a board 18 deep, where its deepest sub-board would be 21: 409, nothing changed', async () => {
				const { owner, card, levels } = scene();
				expect(heightUnderCard(card.id)).toBe(3);
				const before = snapshotDb();

				const res = await move(owner, card, levels[18].cols['To Do'].id);

				expect(res.status).toBe(409);
				expect(res.body).toEqual({ message: tooDeepToMove('Carries three', 'Level 18') });
				expect(res.body).toEqual({ message: 'Card "Carries three" cannot go onto "Level 18": its sub-boards would then be nested more than 20 levels deep.' });
				expectUnchanged(before);
			});

			it('onto a board 17 deep, where its deepest would be 20: moved', async () => {
				const { owner, card, levels } = scene();

				const res = await move(owner, card, levels[17].cols['To Do'].id);

				expect(res.status, JSON.stringify(res.body)).toBe(200);
				expect(columnOf(card)).toBe(levels[17].cols['To Do'].id);
			});

			it('a card with no sub-board onto the deepest board: moved', async () => {
				const { owner, home, levels } = scene();
				const plain = makeCard(home.cols['To Do'], { title: 'Carries none' });

				const res = await move(owner, plain, levels[20].cols['To Do'].id);

				expect(res.status, JSON.stringify(res.body)).toBe(200);
			});

			it('in a tree already 25 deep: lifted part of the way, and moved within the deepest board, it is moved', async () => {
				const owner = makeUser({ username: 'owner' });
				const levels = chain(owner, 25);

				// The card on level 24 carries level 25: lifted onto level 10.
				const lifted = await move(owner, levels[24].card, levels[10].cols['To Do'].id);
				expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
				expect(depthOf(levels[25].board.id)).toBe(11);

				// Within one board, whatever its depth: nothing in the tree changes.
				const within = await move(owner, levels[20].card, levels[20].cols['In Progress'].id);
				expect(within.status, JSON.stringify(within.body)).toBe(200);
			});
		});
	}
});

describe('linking a board under a card past the limit is refused, PUT /api/boards/{id} with parentCardId', () => {
	/** A top-level board X with two levels of sub-boards beneath it, and a chain to link it under. */
	function scene() {
		const owner = makeUser({ username: 'owner' });
		const X = makeBoard({ owner, name: 'X' });
		const below = makeSubBoard(makeCard(X.cols['To Do']), { owner, name: 'Below X' });
		makeSubBoard(below.cards[0], { owner, name: 'Two below X' });
		return { owner, X, levels: chain(owner, 20) };
	}
	const link = (user: SessionUser, boardId: number, parentCardId: number): Promise<ApiResult> =>
		api('PUT', `/api/boards/${boardId}`, { user, body: { parentCardId } });

	it('under a card on a board 18 deep, where its deepest would be 21: 409, X not moved', async () => {
		const { owner, X, levels } = scene();
		expect(heightOfBoard(X.board.id)).toBe(2);
		const before = snapshotDb();

		const res = await link(owner, X.board.id, levels[18].card.id);

		expect(res.status).toBe(409);
		expect(res.body).toEqual({ message: tooDeepToLink('X') });
		expect(res.body).toEqual({ message: 'Board "X" cannot go under this card: it and its sub-boards would then be nested more than 20 levels deep.' });
		expectUnchanged(before);
		expect(parentOf(X.board.id)).toBeNull();
	});

	it('under a card on a board 17 deep, where its deepest would be 20: linked', async () => {
		const { owner, X, levels } = scene();

		const res = await link(owner, X.board.id, levels[17].card.id);

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(parentOf(X.board.id)).toBe(levels[17].card.id);
	});

	it('a board of a tree already too deep, put higher: linked, so the tree can be put right', async () => {
		const owner = makeUser({ username: 'owner' });
		const levels = chain(owner, 25);
		const other = chain(owner, 5, 'Other');

		const res = await link(owner, levels[22].board.id, other[5].card.id);

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(depthOf(levels[25].board.id)).toBe(9);
	});

	it('is offered on the board page only where it could go: nothing on a board 20 deep, the top-level boards on one 19 deep', () => {
		const { owner, X, levels } = scene();

		expect(linkableBoards(owner, levels[20].board.id)).toEqual([]);
		expect(linkableBoards(owner, levels[19].board.id).map((b) => b.id)).toContain(X.board.id);
	});
});

describe('the board page’s breadcrumbs', () => {
	type Crumb = { label: string; emoji: string; href: string | null; title?: string };
	const crumbsOf = async (user: SessionUser, boardId: number): Promise<Crumb[]> => {
		const res = await pageLoad(`/board/${boardId}`, { user });
		expect(res.type).toBe('data');
		return (res as { data: { breadcrumbs: Crumb[] } }).data.breadcrumbs;
	};

	it('show every board above one 20 deep, with no "…"', async () => {
		const owner = makeUser({ username: 'owner' });
		const levels = chain(owner, 20);

		const crumbs = await crumbsOf(owner, levels[20].board.id);

		expect(crumbs.map((c) => c.label)).toEqual(levels.slice(0, 20).map((l) => l.board.name));
		expect(crumbs.every((c) => c.href !== null)).toBe(true);
	});

	it('show the nearest 20 above one 60 deep, and a "…" with no link above them, reading at most 30 boards', async () => {
		const owner = makeUser({ username: 'owner' });
		// An administrator: whether each board above may be opened is then
		// asked without a read, and the reads counted are the walk's own.
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const levels = chain(owner, 60);
		await crumbsOf(admin, levels[60].board.id);

		const reads = watchReads('boards');
		let crumbs: Crumb[];
		try {
			crumbs = await crumbsOf(admin, levels[60].board.id);
		} finally {
			reads.restore();
		}

		expect(crumbs).toHaveLength(21);
		expect(crumbs[0]).toEqual({ label: '…', emoji: '', href: null, title: 'More boards above' });
		expect(crumbs.slice(1).map((c) => c.label)).toEqual(levels.slice(40, 60).map((l) => l.board.name));
		expect(crumbs.slice(1).map((c) => c.href)).toEqual(levels.slice(40, 60).map((l) => `/board/${l.board.id}`));
		// 22 now. It read 62: one for every level, and two more.
		expect(reads.inTransaction.length).toBeLessThanOrEqual(30);
	});
});
