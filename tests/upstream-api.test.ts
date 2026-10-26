/**
 * The public API's reads of upstream (milestone 22, card 2464, slice S6).
 *
 * The 1.3.0 release adds two filters and one operation to v1, and a field to
 * another, each a read:
 *
 * - `GET /api/v1/boards?kind=delivery|ideas` (item 2), a filter of the list
 *   the caller already gets, so it never lists a board they cannot open;
 * - `GET /api/v1/boards/{boardId}/cards?stage=option|committed` (item 3), by
 *   the column each card is in, on the board's kind;
 * - `GET /api/v1/boards/{boardId}/upstream?days=N` (item 5), view access, the
 *   board's `upstreamFigures` over the window and its "Committed (all)";
 * - `avgLeadTimeDays` on `GET /api/v1/me/stats` (the S4a review's "For S6"),
 *   the same value as `avgCycleTimeDays`, which is a lead time named cycle time
 *   for history.
 *
 * Each refusal is the request-body readers' kind: 400 quoting what was sent.
 * Who may call the new route is in `tests/access-every-route.test.ts`; what
 * its answer holds against the OpenAPI document in
 * `tests/openapi-document.test.ts`. The writes of the milestone and their
 * twins are in `tests/options-column.test.ts`, `tests/commitment.test.ts`,
 * `tests/discard.test.ts`, `tests/ideas-board.test.ts` and
 * `tests/activity-twins.test.ts`.
 *
 * The plan is `docs/planning/milestone-22-upstream-kanban.md`, section 3's
 * card F and section 7.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { activityLog, boards, cards, columns, type Card, type Column } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { committedAll, upstreamFigures } from '$lib/server/upstream';
import { stamp, toIso } from '$lib/timestamps';
import { api } from './helpers/api';
import { addBoardMember, assignCard, makeBoard, makeCard, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';

/** The moment every test runs at: the clock is fixed, so every window is. */
const NOW = new Date('2026-10-26T12:00:00Z');

beforeEach(() => {
	resetDb();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.useRealTimers();
});

/** A stored moment `days` days before now. */
const daysAgo = (days: number) => stamp(new Date(NOW.getTime() - days * 86400000));

/** An Options column titled "Ideas", at the left of the board. */
function optionsColumnOn(board: BoardFixture): Column {
	return db.insert(columns).values({ boardId: board.board.id, title: 'Ideas', position: -1, role: 'options', wipLimit: 0 }).returning().get();
}

/** An ideas board of `owner`'s, made a board of kind ideas before any card is put on it, so its cards are options. */
function ideasBoard(owner: SessionUser, name: string): BoardFixture {
	const made = makeBoard({ owner, name, columns: ['New Ideas', 'Shaping', 'Ready for Replenishment'] });
	db.update(boards).set({ kind: 'ideas' }).where(eq(boards.id, made.board.id)).run();
	return { ...made, board: { ...made.board, kind: 'ideas' } };
}

/** An activity entry, at a moment of the test's choosing. */
function entry(board: BoardFixture, card: Card | null, action: string, createdAt: string) {
	db.insert(activityLog).values({ boardId: board.board.id, cardId: card?.id ?? null, action, detail: '', createdAt }).run();
}

type Scene = {
	owner: SessionUser;
	viewer: SessionUser;
	outsider: SessionUser;
	/** A delivery board with an Options column. */
	D: BoardFixture;
	ideas: Column;
	/** An ideas board. */
	I: BoardFixture;
	/** The outsider's own ideas board, which nobody else can open. */
	X: BoardFixture;
	c: Record<'option' | 'discarded' | 'todo' | 'done' | 'idea', Card>;
};

/**
 * The owner's delivery board D, with an Options column holding one live
 * option and one discarded (archived from it), a card in To Do and one in
 * Complete; the owner's ideas board I with one idea; the outsider's ideas
 * board X. The viewer may look at D and I.
 */
function scene(): Scene {
	const owner = makeUser({ username: 'owner' });
	const viewer = makeUser({ username: 'viewer' });
	const outsider = makeUser({ username: 'outsider' });
	const D = makeBoard({ owner, name: 'D' });
	const ideas = optionsColumnOn(D);
	const I = ideasBoard(owner, 'I');
	const X = ideasBoard(outsider, 'X');
	addBoardMember(D.board, viewer, 'viewer');
	addBoardMember(I.board, viewer, 'viewer');
	// Made at the test's own now: the database's default is the real clock's.
	const at = { createdAt: stamp(NOW), updatedAt: stamp(NOW), createdBy: owner.id };
	const c = {
		option: makeCard(ideas, { title: 'Option', ...at }),
		discarded: makeCard(ideas, { title: 'Discarded', ...at, archivedAt: daysAgo(1), discardedAt: daysAgo(1), discardedBy: owner.id }),
		todo: makeCard(D.cols['To Do'], { title: 'Todo', ...at }),
		done: makeCard(D.cols['Complete'], { title: 'Done', ...at, completedAt: daysAgo(2) }),
		idea: makeCard(I.cols['New Ideas'], { title: 'Idea', ...at })
	};
	return { owner, viewer, outsider, D, ideas, I, X, c };
}

describe('GET /api/v1/boards?kind= (card 2464, item 2)', () => {
	it('lists only the boards of the kind asked for, and every board for none or an empty kind', async () => {
		const s = scene();
		const names = async (query: string) => ((await api('GET', `/api/v1/boards${query}`, { user: s.owner })).body as { name: string }[]).map((b) => b.name).sort();

		expect(await names('')).toEqual(['D', 'I']);
		expect(await names('?kind=')).toEqual(['D', 'I']);
		expect(await names('?kind=delivery')).toEqual(['D']);
		expect(await names('?kind=ideas')).toEqual(['I']);
	});

	it('lists a board of a kind this release does not know as a delivery board, as every rule reads a kind (the S6 review\'s Q5)', async () => {
		const s = scene();
		const P = makeBoard({ owner: s.owner, name: 'P' });
		db.update(boards).set({ kind: 'portfolio' }).where(eq(boards.id, P.board.id)).run();
		const names = async (query: string) => ((await api('GET', `/api/v1/boards${query}`, { user: s.owner })).body as { name: string }[]).map((b) => b.name).sort();

		expect(await names('?kind=delivery')).toEqual(['D', 'P']);
		expect(await names('?kind=ideas')).toEqual(['I']);
	});

	it('never lists a board the caller cannot open, of either kind; an administrator is listed every one', async () => {
		const s = scene();
		const admin = makeUser({ role: 'admin', username: 'admin' });
		const names = async (user: SessionUser) => ((await api('GET', '/api/v1/boards?kind=ideas', { user })).body as { name: string }[]).map((b) => b.name).sort();

		expect(await names(s.outsider)).toEqual(['X']);
		expect(await names(s.viewer)).toEqual(['I']);
		expect(await names(admin)).toEqual(['I', 'X']);
	});

	it.each(['backlog', 'Ideas', 'IDEAS', 'delivery,ideas', ' ideas'])('answers 400 for kind=%s, quoting it', async (kind) => {
		const s = scene();
		const res = await api('GET', `/api/v1/boards?kind=${encodeURIComponent(kind)}`, { user: s.owner });

		expect(res.status).toBe(400);
		expect(res.body).toEqual({ message: `kind must be "delivery" or "ideas", not ${JSON.stringify(kind)}` });
	});

	it('cuts a long kind short in its refusal', async () => {
		const s = scene();
		const res = await api('GET', `/api/v1/boards?kind=${'x'.repeat(100)}`, { user: s.owner });

		expect(res.status).toBe(400);
		expect(res.body.message).toBe(`kind must be "delivery" or "ideas", not "${'x'.repeat(56)}...`);
	});
});

describe('GET /api/v1/boards/{boardId}/cards?stage= (card 2464, item 3)', () => {
	const titles = async (s: Scene, board: BoardFixture, query: string) => {
		const res = await api('GET', `/api/v1/boards/${board.board.id}/cards${query}`, { user: s.viewer });
		expect(res.status).toBe(200);
		return (res.body as { title: string }[]).map((c) => c.title).sort();
	};

	it('on a delivery board lists the cards of its Options column as options, and every other card as committed', async () => {
		const s = scene();

		expect(await titles(s, s.D, '')).toEqual(['Done', 'Option', 'Todo']);
		expect(await titles(s, s.D, '?stage=')).toEqual(['Done', 'Option', 'Todo']);
		expect(await titles(s, s.D, '?stage=option')).toEqual(['Option']);
		expect(await titles(s, s.D, '?stage=committed')).toEqual(['Done', 'Todo']);
	});

	it('takes an archived card by its column: a discarded card, archived from Options, is an option', async () => {
		const s = scene();
		makeCard(s.D.cols['In Progress'], { title: 'Abandoned', archivedAt: daysAgo(1) });

		expect(await titles(s, s.D, '?stage=option&archived=true')).toEqual(['Discarded', 'Option']);
		expect(await titles(s, s.D, '?stage=committed&archived=true')).toEqual(['Abandoned', 'Done', 'Todo']);
	});

	it('on an ideas board lists every card as an option and none as committed', async () => {
		const s = scene();
		makeCard(s.I.cols['Shaping'], { title: 'Shaped' });

		expect(await titles(s, s.I, '?stage=option')).toEqual(['Idea', 'Shaped']);
		expect(await titles(s, s.I, '?stage=committed')).toEqual([]);
	});

	it('applies with a column filter, both conditions holding', async () => {
		const s = scene();

		expect(await titles(s, s.D, `?stage=committed&columnId=${s.ideas.id}`)).toEqual([]);
		expect(await titles(s, s.D, `?stage=option&columnId=${s.ideas.id}`)).toEqual(['Option']);
		expect(await titles(s, s.D, `?stage=option&columnId=${s.D.cols['To Do'].id}`)).toEqual([]);
	});

	it('takes an ordinary column whose role is NULL as committed, and a column titled "Ideas" without the role too', async () => {
		const s = scene();
		const N = makeBoard({ owner: s.owner, name: 'N', columns: ['Ideas', 'Doing'] });
		makeCard(N.cols['Ideas'], { title: 'Not an option' });
		addBoardMember(N.board, s.viewer, 'viewer');

		expect(await titles(s, N, '?stage=committed')).toEqual(['Not an option']);
		expect(await titles(s, N, '?stage=option')).toEqual([]);
	});

	it.each(['options', 'Option', 'upstream', 'committed,option'])('answers 400 for stage=%s, quoting it', async (stage) => {
		const s = scene();
		const res = await api('GET', `/api/v1/boards/${s.D.board.id}/cards?stage=${encodeURIComponent(stage)}`, { user: s.viewer });

		expect(res.status).toBe(400);
		expect(res.body).toEqual({ message: `stage must be "option" or "committed", not ${JSON.stringify(stage)}` });
	});

	it('looks for the board, and checks the caller, before it reads stage', async () => {
		const s = scene();

		expect((await api('GET', '/api/v1/boards/999/cards?stage=nonsense', { user: s.viewer })).status).toBe(404);
		expect((await api('GET', `/api/v1/boards/${s.X.board.id}/cards?stage=nonsense`, { user: s.viewer })).status).toBe(403);
	});
});

describe('GET /api/v1/boards/{boardId}/upstream (card 2464, item 5)', () => {
	it("answers the board's upstream figures over the last 30 days by default, as upstreamFigures and committedAll give them", async () => {
		const s = scene();
		// In the window: one card committed from options, one discarded (the scene's), one returned.
		// Before it: a commitment 40 days ago, which is left out.
		entry(s.D, s.c.todo, 'api:card_committed', daysAgo(3));
		entry(s.D, s.c.discarded, 'card_discarded', daysAgo(1));
		entry(s.D, s.c.option, 'card_returned_to_options', daysAgo(5));
		entry(s.D, s.c.done, 'card_committed', daysAgo(40));

		const res = await api('GET', `/api/v1/boards/${s.D.board.id}/upstream`, { user: s.viewer });

		expect(res.status).toBe(200);
		const from = daysAgo(30);
		const to = stamp(NOW);
		expect(res.body).toEqual({
			boardId: s.D.board.id,
			kind: 'delivery',
			days: 30,
			period: { from: toIso(from), to: toIso(to) },
			...upstreamFigures([s.D.board.id], from, to, NOW.getTime()),
			committedAll: committedAll([s.D.board.id], from, to)
		});
		expect(res.body).toMatchObject({
			options: 1,
			committedFromOptions: 1,
			returnedToOptions: 1,
			discarded: 1,
			sentOn: 0,
			abandoned: 0,
			discardRate: 0.5,
			agingOptions: 0
		});
	});

	it('takes days as the window, both ends included, so an act on its first second counts and one a second before it does not', async () => {
		const s = scene();
		entry(s.D, s.c.todo, 'card_committed', daysAgo(7));
		const before = stamp(new Date(NOW.getTime() - 7 * 86400000 - 1000));
		entry(s.D, s.c.done, 'card_committed', before);

		const week = await api('GET', `/api/v1/boards/${s.D.board.id}/upstream?days=7`, { user: s.viewer });
		const eight = await api('GET', `/api/v1/boards/${s.D.board.id}/upstream?days=8`, { user: s.viewer });

		expect(week.body).toMatchObject({ days: 7, committedFromOptions: 1, period: { from: toIso(daysAgo(7)) } });
		expect(eight.body).toMatchObject({ days: 8, committedFromOptions: 2 });
	});

	it('counts "Committed (all)": a card created committed in the window, and one committed from options, each once', async () => {
		const s = scene();
		// The scene's two committed cards on D, Todo and Done, were made now, straight into committed columns: two arrivals.
		expect((await api('GET', `/api/v1/boards/${s.D.board.id}/upstream`, { user: s.owner })).body.committedAll).toBe(2);

		// The option committed from options is a third; committed twice in the window, it is still one.
		entry(s.D, s.c.option, 'card_committed', daysAgo(2));
		entry(s.D, s.c.option, 'api:card_committed', daysAgo(1));
		// A card created committed and then returned to options is no arrival: its committedAt is cleared.
		db.update(cards).set({ columnId: s.ideas.id, committedAt: null, committedBy: null }).where(eq(cards.id, s.c.todo.id)).run();
		// A card created committed on another board and moved here counts here, on the board it is on now.
		const other = makeBoard({ owner: s.owner, name: 'Other' });
		const moved = makeCard(other.cols['To Do'], { title: 'Moved here', createdAt: daysAgo(1), updatedAt: daysAgo(1) });
		db.update(cards).set({ columnId: s.D.cols['In Progress'].id }).where(eq(cards.id, moved.id)).run();

		// Todo out, the option and the card moved here in: three.
		const res = await api('GET', `/api/v1/boards/${s.D.board.id}/upstream`, { user: s.owner });
		expect(res.body.committedAll).toBe(3);
		expect((await api('GET', `/api/v1/boards/${other.board.id}/upstream`, { user: s.owner })).body.committedAll).toBe(0);
	});

	it('answers an ideas board its own figures: every card on it is an option, and no card arrives committed', async () => {
		const s = scene();
		makeCard(s.I.cols['Shaping'], { title: 'Old', createdAt: daysAgo(45), updatedAt: daysAgo(45) });

		const res = await api('GET', `/api/v1/boards/${s.I.board.id}/upstream`, { user: s.viewer });

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ boardId: s.I.board.id, kind: 'ideas', options: 2, oldestOptionDays: 45, agingOptions: 1, committedAll: 0, discardRate: null });
	});

	it.each(['0', '366', '-1', '1.5', 'abc', '1e2', '30 '])('answers 400 for days=%s', async (days) => {
		const s = scene();
		const res = await api('GET', `/api/v1/boards/${s.D.board.id}/upstream?days=${encodeURIComponent(days)}`, { user: s.viewer });

		expect(res.status).toBe(400);
		expect(res.body).toEqual({ message: 'days must be a whole number from 1 to 365' });
	});

	it('takes days=1 and days=365, and an empty days as 30', async () => {
		const s = scene();
		for (const [query, days] of [['?days=1', 1], ['?days=365', 365], ['?days=', 30]] as const) {
			const res = await api('GET', `/api/v1/boards/${s.D.board.id}/upstream${query}`, { user: s.viewer });
			expect(res.status, query).toBe(200);
			expect(res.body.days, query).toBe(days);
		}
	});

	it('answers 404 for a board that is not there to everyone, 403 for one the caller cannot open, and 400 for a board id that is not one, before days is read', async () => {
		const s = scene();
		const admin = makeUser({ role: 'admin', username: 'admin' });

		expect(await api('GET', '/api/v1/boards/999/upstream?days=0', { user: admin })).toMatchObject({ status: 404, body: { message: 'Board not found' } });
		expect(await api('GET', `/api/v1/boards/${s.X.board.id}/upstream?days=0`, { user: s.viewer })).toMatchObject({ status: 403, body: { message: 'No access to this board' } });
		expect(await api('GET', '/api/v1/boards/1.5/upstream', { user: s.viewer })).toMatchObject({ status: 400, body: { message: 'Invalid board ID' } });
		expect((await api('GET', `/api/v1/boards/${s.X.board.id}/upstream`, { user: admin })).status).toBe(200);
	});

	it('writes nothing', async () => {
		const s = scene();
		const entries = () => db.select().from(activityLog).all().length;
		const before = entries();

		await api('GET', `/api/v1/boards/${s.D.board.id}/upstream`, { user: s.owner });

		expect(entries()).toBe(before);
	});
});

describe('GET /api/v1/me/stats: the average is a lead time, under both names (the S4a review)', () => {
	it('answers avgLeadTimeDays, from each card\'s commitment to its completion, and avgCycleTimeDays at the same value', async () => {
		const s = scene();
		// Created ten days ago, committed four days ago, completed now: a lead time of four days, not ten.
		const card = makeCard(s.D.cols['Complete'], {
			title: 'Committed late',
			createdAt: daysAgo(10),
			updatedAt: daysAgo(10),
			committedAt: daysAgo(4),
			completedAt: stamp(NOW)
		});
		assignCard(card, s.owner);

		const res = await api('GET', '/api/v1/me/stats', { user: s.owner });

		expect(res.status).toBe(200);
		expect(res.body.avgLeadTimeDays).toBe(4);
		expect(res.body.avgCycleTimeDays).toBe(4);
	});

	it('answers both null with no completed card, and leaves options out of activeCards', async () => {
		const s = scene();
		assignCard(s.c.option, s.owner);
		assignCard(s.c.idea, s.owner);
		assignCard(s.c.todo, s.owner);

		const res = await api('GET', '/api/v1/me/stats', { user: s.owner });

		expect(res.body).toMatchObject({ avgLeadTimeDays: null, avgCycleTimeDays: null, activeCards: 1 });
	});
});
