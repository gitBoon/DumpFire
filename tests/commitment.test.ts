/**
 * A move across the commitment point (milestone 22, card 2460, slice S2).
 *
 * A card in an upstream column, the board's Options column or any column of
 * an ideas board, is an option: `committed_at` and `committed_by` are NULL. A
 * move out of upstream into a committed column commits it, now and by the
 * mover, with a `card_committed` entry in place of `card_moved`; a move back
 * into upstream clears both, with `card_returned_to_options`. A move within
 * upstream, or between committed columns, leaves them as they are. An
 * archived card never crosses (ruling n), and a card with sub-boards never
 * goes into upstream (ruling o).
 *
 * Every move goes through `moveCard` in `$lib/server/card-moves`, so each
 * route that moves a card is held to the same, with the stored commitment
 * read back after each (the S1a review's R6), and the start-up repair asked
 * to find nothing to fill or clear after it: a non-zero count there means a
 * route forgot. The routes are the drag, the board page's menu move and its
 * bulk move, which all send `PUT /api/cards/reorder`; All Tasks' move, `PUT
 * /api/cards/:id` with a `columnId`; and the v1 move. v1's card update takes
 * no move, and nothing else changes a card's column. Creation is held in
 * `tests/card-completion.test.ts` (the S1a review's R2). The webhooks are in
 * `tests/webhooks.test.ts`, the twins in `tests/activity-twins.test.ts`.
 *
 * The plan is `docs/planning/milestone-22-upstream-kanban.md`, section 3's
 * card B and section 7.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { runBackfills } from '$lib/server/db/migrate';
import { activityLog, boards, cards, userXp, type Card, type Column } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { stamp } from '$lib/timestamps';
import { toasts } from '$lib/stores/toast';
import { commitmentToasts, confirmOnHold, handleCardDndFinalize } from '$lib/board/dnd-handlers';
import { bulkMove, type BoardWriter } from '$lib/board/bulk-actions';
import type { CardType, ColumnType } from '$lib/types';
import { api, type ApiResult } from './helpers/api';
import { effects } from './helpers/effects';
import { addBoardMember, makeBoard, makeCard, makeSubBoard, makeSubtask, makeUser, makeWebhook, resetDb, type BoardFixture } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

/** When every card here was made and, if committed, committed: long before any move. */
const OLD = '2026-01-05 09:00:00';

let owner: SessionUser;
let mover: SessionUser;
/** Delivery boards A and B, each with its Options column (card 2527); ideas board I. */
let A: BoardFixture;
let B: BoardFixture;
let I: BoardFixture;

const DELIVERY = ['To Do', 'In Progress', 'Complete'];

beforeEach(() => {
	resetDb();
	owner = makeUser({ username: 'owner' });
	mover = makeUser({ username: 'mover' });
	A = makeBoard({ owner, name: 'A', options: true, columns: DELIVERY });
	B = makeBoard({ owner, name: 'B', options: true, columns: DELIVERY });
	I = makeBoard({ owner, name: 'I', columns: ['New Ideas', 'Shaping'] });
	db.update(boards).set({ kind: 'ideas' }).where(eq(boards.id, I.board.id)).run();
	for (const board of [A, B, I]) addBoardMember(board.board, mover, 'editor');
});

/** A card made long ago by the owner: an option in an upstream column, committed then by the owner in any other. */
const cardIn = (column: Column, title: string, opts: Partial<typeof cards.$inferInsert> = {}) =>
	makeCard(column, { title, createdAt: OLD, updatedAt: OLD, createdBy: owner.id, ...opts });

const commitmentOf = (card: Card) => {
	const row = db.select().from(cards).where(eq(cards.id, card.id)).get()!;
	return { committedAt: row.committedAt, committedBy: row.committedBy };
};

/** The card's entries, oldest first: the stored action, the board and the detail. */
const entriesOf = (card: Card) =>
	db
		.select()
		.from(activityLog)
		.where(eq(activityLog.cardId, card.id))
		.orderBy(activityLog.id)
		.all()
		.map((e) => [e.action, e.boardId, e.detail]);

/** The start-up repair finds nothing to fill and nothing to clear: every route kept the rule. */
function nothingToRepair() {
	expect(runBackfills(sqlite)).toMatchObject({ committedFilled: 0, upstreamCleared: 0 });
}

type Route = {
	name: string;
	/** The prefix the route's entries are stored with. */
	prefix: '' | 'api:';
	/** It can move a card to another board. */
	acrossBoards: boolean;
	move: (card: Card, to: Column, position?: number) => Promise<ApiResult>;
};

const ROUTES: Route[] = [
	{
		name: 'the drag, the menu move and the bulk move (PUT /api/cards/reorder)',
		prefix: '',
		acrossBoards: false,
		move: (card, to, position = 0) =>
			api('PUT', '/api/cards/reorder', { user: mover, body: { updates: [{ id: card.id, columnId: to.id, position }] } })
	},
	{
		name: "All Tasks' move (PUT /api/cards/:id with a columnId)",
		prefix: '',
		acrossBoards: true,
		move: (card, to, position) =>
			api('PUT', `/api/cards/${card.id}`, { user: mover, body: position === undefined ? { columnId: to.id } : { columnId: to.id, position } })
	},
	{
		name: 'the v1 move (PUT /api/v1/cards/:cardId/move)',
		prefix: 'api:',
		acrossBoards: true,
		move: (card, to, position) =>
			api('PUT', `/api/v1/cards/${card.id}/move`, { user: mover, body: position === undefined ? { columnId: to.id } : { columnId: to.id, position } })
	}
];

describe.each(ROUTES)('a move by $name', ({ move, prefix }) => {
	it('out of the Options column into To Do commits the card, now and by the mover, with card_committed in place of card_moved', async () => {
		const option = cardIn(A.cols['Options'], 'An option');
		expect(commitmentOf(option)).toEqual({ committedAt: null, committedBy: null });
		const before = stamp();

		const res = await move(option, A.cols['To Do']);

		expect(res.status).toBe(200);
		const { committedAt, committedBy } = commitmentOf(option);
		expect(committedBy).toBe(mover.id);
		expect(committedAt! >= before).toBe(true);
		// The column it went into named by its id too, for the cycle time (the S2 review's C3), and
		// the column it left, for its time in options (the S4a review's H3).
		expect(entriesOf(option)).toEqual([
			[`${prefix}card_committed`, A.board.id, `"An option": Options → To Do (column ${A.cols['To Do'].id}, from column ${A.cols['Options'].id})`]
		]);
		nothingToRepair();
	});

	it('back from To Do into the Options column clears the commitment, with card_returned_to_options', async () => {
		const work = cardIn(A.cols['To Do'], 'Work');
		expect(commitmentOf(work)).toEqual({ committedAt: OLD, committedBy: owner.id });

		expect((await move(work, A.cols['Options'])).status).toBe(200);

		expect(commitmentOf(work)).toEqual({ committedAt: null, committedBy: null });
		expect(entriesOf(work)).toEqual([[`${prefix}card_returned_to_options`, A.board.id, '"Work": To Do → Options']]);
		nothingToRepair();
	});

	it('between committed columns, and within the Options column, leaves the commitment as it was', async () => {
		const work = cardIn(A.cols['To Do'], 'Work');
		const option = cardIn(A.cols['Options'], 'An option', { position: 0 });

		expect((await move(work, A.cols['In Progress'])).status).toBe(200);
		expect((await move(option, A.cols['Options'], 3)).status).toBe(200);

		expect(commitmentOf(work)).toEqual({ committedAt: OLD, committedBy: owner.id });
		expect(entriesOf(work)).toEqual([[`${prefix}card_moved`, A.board.id, '"Work": To Do → In Progress']]);
		expect(commitmentOf(option)).toEqual({ committedAt: null, committedBy: null });
		expect(entriesOf(option)).toEqual([]);
		nothingToRepair();
	});

	it('straight from the Options column to Complete writes card_committed and then card_completed, and awards the XP', async () => {
		const option = cardIn(A.cols['Options'], 'Done at once', { priority: 'high' });

		expect((await move(option, A.cols['Complete'])).status).toBe(200);

		const row = db.select().from(cards).where(eq(cards.id, option.id)).get()!;
		expect(row.committedBy).toBe(mover.id);
		expect(row.committedAt).toBe(row.completedAt);
		expect(entriesOf(option)).toEqual([
			[`${prefix}card_committed`, A.board.id, `"Done at once": Options → Complete (column ${A.cols['Complete'].id}, from column ${A.cols['Options'].id})`],
			[`${prefix}card_completed`, A.board.id, '"Done at once": Options → Complete']
		]);
		expect(db.select().from(userXp).where(eq(userXp.name, 'mover')).get()?.xp).toBe(150);
		nothingToRepair();
	});

	it('from Complete back to the Options column writes card_reopened and then card_returned_to_options, and clears both dates', async () => {
		const done = cardIn(A.cols['Complete'], 'Not needed after all', { completedAt: OLD, firstCompletedAt: OLD });

		expect((await move(done, A.cols['Options'])).status).toBe(200);

		const row = db.select().from(cards).where(eq(cards.id, done.id)).get()!;
		expect([row.completedAt, row.committedAt, row.committedBy]).toEqual([null, null, null]);
		expect(entriesOf(done)).toEqual([
			[`${prefix}card_reopened`, A.board.id, '"Not needed after all": Complete → Options'],
			[`${prefix}card_returned_to_options`, A.board.id, '"Not needed after all": Complete → Options']
		]);
		nothingToRepair();
	});

	it('from the Options column to Complete with an open subtask is refused, as any completion is, and writes nothing', async () => {
		const option = cardIn(A.cols['Options'], 'Half thought out');
		makeSubtask(option, { title: 'Think it through' });
		const before = snapshotDb();

		const res = await move(option, A.cols['Complete']);

		expect(res.status).toBe(409);
		expect(res.body.message).toBe('Card has 1 incomplete subtask that must be completed first');
		expectUnchanged(before);
	});

	it('refuses an archived card across the commitment point, either way, and writes nothing; within one side it moves (ruling n)', async () => {
		const option = cardIn(A.cols['Options'], 'Archived option', { archivedAt: OLD });
		const work = cardIn(A.cols['To Do'], 'Archived work', { archivedAt: OLD });
		const before = snapshotDb();

		const out = await move(option, A.cols['To Do']);
		const back = await move(work, A.cols['Options']);

		expect([out.status, out.body.message]).toEqual([409, 'Card "Archived option" is archived: restore it before moving it out of or back into Options']);
		expect([back.status, back.body.message]).toEqual([409, 'Card "Archived work" is archived: restore it before moving it out of or back into Options']);
		expectUnchanged(before);

		expect((await move(work, A.cols['In Progress'])).status).toBe(200);
		expect(commitmentOf(work)).toEqual({ committedAt: OLD, committedBy: owner.id });
		nothingToRepair();
	});

	it('refuses a committed card with a sub-board going into the Options column, and writes nothing; one already there moves out (ruling o)', async () => {
		const parent = cardIn(A.cols['To Do'], 'Broken down');
		makeSubBoard(parent, { owner });
		const before = snapshotDb();

		const res = await move(parent, A.cols['Options']);

		expect([res.status, res.body.message]).toEqual([
			409,
			'Card "Broken down" has a sub-board, so it cannot go into the Options column: a card with sub-boards is committed work. Keep it in a committed column, or archive it if it is no longer wanted.'
		]);
		expectUnchanged(before);

		// An option given a sub-board before the rule is not held there.
		const option = cardIn(A.cols['Options'], 'An option with a sub-board');
		makeSubBoard(option, { owner });
		expect((await move(option, A.cols['To Do'])).status).toBe(200);
		expect(commitmentOf(option).committedBy).toBe(mover.id);
		nothingToRepair();
	});
});

describe.each(ROUTES.filter((route) => route.acrossBoards))('a move to another board by $name', ({ move, prefix }) => {
	it("from an ideas board into a delivery board's To Do commits the card, after the pair of entries", async () => {
		const idea = cardIn(I.cols['Shaping'], 'An idea');

		expect((await move(idea, B.cols['To Do'])).status).toBe(200);

		expect(commitmentOf(idea).committedBy).toBe(mover.id);
		// An option moved to another board is sent on, as by a Send (card 2463, the S5a review's L5).
		expect(entriesOf(idea)).toEqual([
			[`${prefix}card_sent`, I.board.id, '"An idea" sent to another board\'s To Do (Shaping → To Do)'],
			[`${prefix}card_moved_in`, B.board.id, '"An idea" moved from another board (Shaping → To Do)'],
			[`${prefix}card_committed`, B.board.id, `"An idea": Shaping → To Do (column ${B.cols['To Do'].id}, from column ${I.cols['Shaping'].id})`]
		]);
		nothingToRepair();
	});

	it("from an ideas board into a delivery board's Options column, it stays an option", async () => {
		const idea = cardIn(I.cols['Shaping'], 'An idea');

		expect((await move(idea, B.cols['Options'])).status).toBe(200);

		expect(commitmentOf(idea)).toEqual({ committedAt: null, committedBy: null });
		expect(entriesOf(idea).map(([action]) => action)).toEqual([`${prefix}card_sent`, `${prefix}card_moved_in`]);
		nothingToRepair();
	});

	it('between committed columns of two delivery boards, the commitment is kept', async () => {
		const work = cardIn(A.cols['To Do'], 'Work');

		expect((await move(work, B.cols['In Progress'])).status).toBe(200);

		expect(commitmentOf(work)).toEqual({ committedAt: OLD, committedBy: owner.id });
		expect(entriesOf(work).map(([action]) => action)).toEqual([`${prefix}card_moved_away`, `${prefix}card_moved_in`]);
		nothingToRepair();
	});

	it('from To Do onto an ideas board, the card is returned to options there', async () => {
		const work = cardIn(A.cols['To Do'], 'Work');

		expect((await move(work, I.cols['New Ideas'])).status).toBe(200);

		expect(commitmentOf(work)).toEqual({ committedAt: null, committedBy: null });
		expect(entriesOf(work)).toEqual([
			[`${prefix}card_moved_away`, A.board.id, '"Work" moved to another board (To Do → New Ideas)'],
			[`${prefix}card_moved_in`, I.board.id, '"Work" moved from another board (To Do → New Ideas)'],
			[`${prefix}card_returned_to_options`, I.board.id, '"Work": To Do → New Ideas']
		]);
		nothingToRepair();
	});

	it('refuses a card with a sub-board onto an ideas board, and an archived option off one, writing nothing', async () => {
		const parent = cardIn(A.cols['To Do'], 'Broken down');
		makeSubBoard(parent, { owner });
		const archived = cardIn(I.cols['Shaping'], 'Archived idea', { archivedAt: OLD });
		const before = snapshotDb();

		const onto = await move(parent, I.cols['New Ideas']);
		const off = await move(archived, B.cols['To Do']);

		expect([onto.status, onto.body.message]).toEqual([
			409,
			'Card "Broken down" has a sub-board, so it cannot go onto an ideas board: a card with sub-boards is committed work. Keep it in a committed column, or archive it if it is no longer wanted.'
		]);
		expect([off.status, off.body.message]).toEqual([409, 'Card "Archived idea" is archived: restore it before moving it out of or back into Options']);
		expectUnchanged(before);
	});

	it('refuses an option with a sub-board, made before that was refused, going into another board’s upstream: off an ideas board into another board’s Options column (the S5a review’s L6, which narrows the S2 review’s C1)', async () => {
		const idea = cardIn(I.cols['Shaping'], 'An idea with a sub-board');
		makeSubBoard(idea, { owner });

		const res = await move(idea, B.cols['Options']);

		expect(res.status).toBe(409);
		expect(res.body.message).toBe(
			'Card "An idea with a sub-board" has a sub-board, so it cannot go into the Options column: a card with sub-boards is committed work. Keep it in a committed column, or archive it if it is no longer wanted.'
		);
		expect(db.select().from(cards).where(eq(cards.id, idea.id)).get()!.columnId).toBe(I.cols['Shaping'].id);
		// Out of upstream, into another board's committed work, it still goes.
		expect((await move(idea, B.cols['To Do'])).status).toBe(200);
		nothingToRepair();
	});

	it("from another board's Complete into the Options column: the pair, then card_reopened and card_returned_to_options on the board it joined (the S2 review's C4)", async () => {
		const done = cardIn(A.cols['Complete'], 'Not needed', { completedAt: OLD, firstCompletedAt: OLD });

		expect((await move(done, B.cols['Options'])).status).toBe(200);

		const row = db.select().from(cards).where(eq(cards.id, done.id)).get()!;
		expect([row.columnId, row.completedAt, row.committedAt, row.committedBy]).toEqual([B.cols['Options'].id, null, null, null]);
		expect(entriesOf(done)).toEqual([
			[`${prefix}card_moved_away`, A.board.id, '"Not needed" moved to another board (Complete → Options)'],
			[`${prefix}card_moved_in`, B.board.id, '"Not needed" moved from another board (Complete → Options)'],
			[`${prefix}card_reopened`, B.board.id, '"Not needed": Complete → Options'],
			[`${prefix}card_returned_to_options`, B.board.id, '"Not needed": Complete → Options']
		]);
		nothingToRepair();
	});
});

describe('the S2 review: moves within upstream, and a drop that a refusal rolls back whole', () => {
	it.each(ROUTES)('$name moves an idea with a sub-board between two columns of its ideas board (C1)', async ({ move, prefix }) => {
		const idea = cardIn(I.cols['New Ideas'], 'An idea with a sub-board');
		makeSubBoard(idea, { owner });

		expect((await move(idea, I.cols['Shaping'])).status).toBe(200);

		expect(commitmentOf(idea)).toEqual({ committedAt: null, committedBy: null });
		expect(entriesOf(idea)).toEqual([[`${prefix}card_moved`, I.board.id, '"An idea with a sub-board": New Ideas → Shaping']]);
		nothingToRepair();
	});

	/** A bulk drop of one card that commits and one the server refuses: nothing moves, nothing is sent. */
	async function refusedWhole(refused: Card) {
		const option = cardIn(A.cols['Options'], 'An option');
		makeWebhook(A.board);
		const before = snapshotDb();
		const sent = effects();
		try {
			const res = await api('PUT', '/api/cards/reorder', {
				user: mover,
				body: {
					updates: [
						{ id: option.id, columnId: A.cols['To Do'].id, position: 0 },
						{ id: refused.id, columnId: A.cols[refused.columnId === A.cols['Options'].id ? 'To Do' : 'Options'].id, position: 0 }
					]
				}
			});
			await sent.settle();
			expectUnchanged(before);
			expect(sent.all).toEqual([]);
			return [res.status, res.body.message];
		} finally {
			sent.restore();
		}
	}

	it('a bulk move of an option and an archived card, out of Options, is refused whole: nothing committed, no webhook (C4, ruling n)', async () => {
		const archived = cardIn(A.cols['Options'], 'Archived option', { archivedAt: OLD });

		expect(await refusedWhole(archived)).toEqual([409, 'Card "Archived option" is archived: restore it before moving it out of or back into Options']);
	});

	it('a bulk move committing an option and returning a card with a sub-board is refused whole: nothing committed, no webhook (C4, ruling o)', async () => {
		const parent = cardIn(A.cols['To Do'], 'Broken down');
		makeSubBoard(parent, { owner });

		expect(await refusedWhole(parent)).toEqual([
			409,
			'Card "Broken down" has a sub-board, so it cannot go into the Options column: a card with sub-boards is committed work. Keep it in a committed column, or archive it if it is no longer wanted.'
		]);
	});
});

describe('what the drag is answered, and the toast it shows (dnd-handlers.ts)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		for (const shown of get(toasts)) toasts.dismiss(shown.id);
	});

	it('answers the ids of the cards a drop committed and returned, and empty lists for any other drop', async () => {
		const option = cardIn(A.cols['Options'], 'An option');
		const work = cardIn(A.cols['To Do'], 'Work');
		const other = cardIn(A.cols['In Progress'], 'Other');

		const res = await api('PUT', '/api/cards/reorder', {
			user: mover,
			body: {
				updates: [
					{ id: option.id, columnId: A.cols['To Do'].id, position: 0 },
					{ id: work.id, columnId: A.cols['Options'].id, position: 0 },
					{ id: other.id, columnId: A.cols['Complete'].id, position: 0 }
				]
			}
		});
		const plain = await api('PUT', '/api/cards/reorder', { user: mover, body: { updates: [{ id: other.id, columnId: A.cols['In Progress'].id, position: 0 }] } });

		expect([res.status, res.body]).toEqual([200, { success: true, committed: [option.id], returnedToOptions: [work.id] }]);
		expect([plain.status, plain.body]).toEqual([200, { success: true, committed: [], returnedToOptions: [] }]);
	});

	it('says what crossed: one card by its title, several by their count, and nothing for an answer that names neither', () => {
		const moved = [{ id: 7, title: 'Seven' }, { id: 8, title: 'Eight' }] as unknown as CardType[];

		expect(commitmentToasts({ success: true, committed: [7], returnedToOptions: [] }, moved)).toEqual(['Committed "Seven"']);
		expect(commitmentToasts({ success: true, committed: [], returnedToOptions: [8] }, moved)).toEqual(['Returned "Eight" to Options']);
		expect(commitmentToasts({ committed: [7, 8], returnedToOptions: [9, 10, 11] }, moved)).toEqual(['Committed 2 cards', 'Returned 3 cards to Options']);
		// A card the page does not hold is counted, not named.
		expect(commitmentToasts({ committed: [9] }, moved)).toEqual(['Committed 1 card']);
		for (const answer of [{ success: true }, null, 'OK', { committed: 'all' }, { committed: ['7'] }]) {
			expect(commitmentToasts(answer, moved)).toEqual([]);
		}
	});

	it('shows the toast for a drop out of the Options column the server took, as the server answered it', async () => {
		const option = cardIn(A.cols['Options'], 'An option');
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			const res = await api(init.method as 'PUT', url, { user: mover, body: JSON.parse(String(init.body)) });
			return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
		});
		// As the drag leaves the page: the card gone from the column it left, still carrying that column.
		const page = [
			{ ...A.cols['Options'], cards: [] },
			{ ...A.cols['To Do'], cards: [] }
		] as unknown as ColumnType[];

		const result = await handleCardDndFinalize(A.cols['To Do'].id, [option as unknown as CardType], page, A.board.id, 'mover', '🦊');

		expect(result.action).toBe('committed');
		expect(get(toasts).map((t) => `${t.type}: ${t.message}`)).toEqual(['success: Committed "An option"']);
		// And hands what it said to the page, which says no more of a drop on the folded strip (card 2535).
		expect(result.action === 'committed' ? result.said : null).toEqual(['Committed "An option"']);
		expect(commitmentOf(option).committedBy).toBe(mover.id);
	});

	it('shows no such toast for a drop between committed columns', async () => {
		const work = cardIn(A.cols['To Do'], 'Work');
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			const res = await api(init.method as 'PUT', url, { user: mover, body: JSON.parse(String(init.body)) });
			return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
		});
		const page = [
			{ ...A.cols['To Do'], cards: [] },
			{ ...A.cols['In Progress'], cards: [] }
		] as unknown as ColumnType[];

		expect((await handleCardDndFinalize(A.cols['In Progress'].id, [work as unknown as CardType], page, A.board.id, 'mover', '🦊')).action).toBe('committed');
		expect(get(toasts)).toEqual([]);
	});

	it('hands the page the toast for a card dropped back into Options, so a drop on the folded strip is said once (card 2535)', async () => {
		const work = cardIn(A.cols['To Do'], 'Work');
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			const res = await api(init.method as 'PUT', url, { user: mover, body: JSON.parse(String(init.body)) });
			return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
		});
		const page = [
			{ ...A.cols['Options'], cards: [] },
			{ ...A.cols['To Do'], cards: [] }
		] as unknown as ColumnType[];

		const result = await handleCardDndFinalize(A.cols['Options'].id, [work as unknown as CardType], page, A.board.id, 'mover', '🦊');

		expect(get(toasts).map((t) => `${t.type}: ${t.message}`)).toEqual(['success: Returned "Work" to Options']);
		expect(result.action === 'committed' ? result.said : null).toEqual(['Returned "Work" to Options']);
	});
});

describe('every other way of moving a card says what crossed the commitment point (the S2 review’s C7)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		for (const shown of get(toasts)) toasts.dismiss(shown.id);
	});

	/** `fetch` answered by the routes themselves, as the mover. */
	const throughTheRoutes = () =>
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			const res = await api(init.method as 'PUT', url, { user: mover, body: JSON.parse(String(init.body)) });
			return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
		});
	const said = () => get(toasts).map((t) => `${t.type}: ${t.message}`);

	it('the bulk move: by title through the board state, which holds the cards; counted with none; nothing for a move between committed columns', async () => {
		const one = cardIn(A.cols['Options'], 'One');
		const two = cardIn(A.cols['Options'], 'Two');
		const work = cardIn(A.cols['To Do'], 'Work');
		throughTheRoutes();
		// The board state's write, as far as the bulk move needs it: the change made on the columns it shows, then the answer read.
		const page = [{ ...A.cols['Options'], cards: [one, two] }, { ...A.cols['To Do'], cards: [work] }, { ...A.cols['In Progress'], cards: [] }] as unknown as ColumnType[];
		const writer = {
			async write(change: ((columns: ColumnType[]) => unknown) | null, send: () => Promise<Response>) {
				change?.(page);
				const res = await send();
				return { ok: true as const, res, answer: await res.json() };
			},
			writeCard: () => Promise.reject(new Error('not asked'))
		} as unknown as BoardWriter;

		expect(await bulkMove(new Set([one.id]), A.cols['To Do'].id, 1, A.board.id, 'mover', '🦊', writer)).toBeNull();
		expect(said()).toEqual(['success: Committed "One"']);

		toasts.dismiss(get(toasts)[0].id);
		expect(await bulkMove(new Set([two.id, work.id]), A.cols['Options'].id, 0, A.board.id, 'mover', '🦊')).toBeNull();
		// Two came from Options and stays there; Work went back. With no board state there are no titles.
		expect(said()).toEqual(['success: Returned 1 card to Options']);

		toasts.dismiss(get(toasts)[0].id);
		const other = cardIn(A.cols['To Do'], 'Other');
		expect(await bulkMove(new Set([other.id]), A.cols['In Progress'].id, 0, A.board.id, 'mover', '🦊')).toBeNull();
		expect(said()).toEqual([]);
	});

	it('the On Hold confirmation: an option put straight on hold is committed, and said to be', async () => {
		const held = makeBoard({ owner, name: 'Held', options: true, columns: ['On Hold'] });
		addBoardMember(held.board, mover, 'editor');
		const option = cardIn(held.cols['Options'], 'Waiting idea');
		throughTheRoutes();

		const result = await confirmOnHold(
			{ show: true, cardId: option.id, cardTitle: 'Waiting idea', note: 'Waiting on the supplier', pendingUpdates: [{ id: option.id, columnId: held.cols['On Hold'].id, position: 0 }], pendingColumnId: held.cols['On Hold'].id },
			held.board.id,
			'mover',
			'🦊'
		);

		expect(result).toEqual({ failure: null, noteFailure: null });
		expect(said()).toEqual(['success: Committed "Waiting idea"']);
		expect(commitmentOf(option).committedBy).toBe(mover.id);
	});

	it('All Tasks’ move (PUT /api/cards/:id): the answer names a card committed or returned, and is as it was for any other move', async () => {
		const option = cardIn(A.cols['Options'], 'An option');
		const work = cardIn(A.cols['To Do'], 'Work');
		const other = cardIn(A.cols['To Do'], 'Other');

		const committed = await api('PUT', `/api/cards/${option.id}`, { user: mover, body: { columnId: A.cols['To Do'].id } });
		const returned = await api('PUT', `/api/cards/${work.id}`, { user: mover, body: { columnId: A.cols['Options'].id } });
		const plain = await api('PUT', `/api/cards/${other.id}`, { user: mover, body: { columnId: A.cols['In Progress'].id } });

		expect([committed.body.committed, committed.body.returnedToOptions]).toEqual([[option.id], undefined]);
		expect([returned.body.committed, returned.body.returnedToOptions]).toEqual([undefined, [work.id]]);
		expect(['committed', 'returnedToOptions'].filter((key) => key in plain.body)).toEqual([]);
		expect(commitmentToasts(committed.body, [option as unknown as CardType])).toEqual(['Committed "An option"']);
	});

	it('the card menu’s Move to and All Tasks’ Move window say it from the answer, in place of "Moved to …" (read from the source)', () => {
		const board = readFileSync(join(process.cwd(), 'src/routes/board/[id]/+page.svelte'), 'utf8').replace(/\s+/g, ' ');
		expect(board).toContain('const crossed = dndHandlers.commitmentToasts(written.answer, [card]); for (const message of crossed) toasts.add(message); if (crossed.length === 0) toasts.add(`Moved to ${col.title}`);');
		const modal = readFileSync(join(process.cwd(), 'src/lib/components/tasks/MoveCardModal.svelte'), 'utf8').replace(/\s+/g, ' ');
		expect(modal).toContain('for (const message of commitmentToasts(answer, [moveCard])) toasts.add(message);');
	});
});
