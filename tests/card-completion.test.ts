/**
 * One definition of Complete and On Hold, and one completion path.
 *
 * A card can be moved three ways — dragged, moved from the All Tasks page or the
 * card modal, or moved through the API. They used to disagree about what a
 * completion is. Most tests here run once per route and expect the same answer.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { runBackfills } from '$lib/server/db/migrate';
import {
	activityLog,
	boards,
	cardLabels,
	cards,
	categories,
	settings,
	subtasks,
	taskRequests,
	userXp,
	type Card,
	type Column
} from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { columnRole, firstOpenColumn, isCompleteColumnTitle, isHoldColumnTitle } from '$lib/column-role';
import { isCompleteColumn, isOnHoldColumn } from '$lib/utils/card-utils';
import { getCompletionBlocker, isCompleteColumnTitle as serverIsComplete } from '$lib/server/card-completion';
import { duplicateCard } from '$lib/board/card-actions';
import type { CardType, ColumnType } from '$lib/types';
import { api } from './helpers/api';
import { pageLoad } from './helpers/actions';
import { eachWriteInTurn } from './helpers/each-write';
import { effects, type Effects, type RecordedEffect } from './helpers/effects';
import {
	addBoardMember,
	assignCard,
	makeBoard,
	makeCard,
	makeLabel,
	makeSmtp,
	makeSubBoard,
	makeSubtask,
	makeUser,
	makeWebhook,
	resetDb,
	type BoardFixture
} from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';
import { toIso } from '$lib/timestamps';

let owner: SessionUser;
let A: BoardFixture;

beforeEach(() => {
	resetDb();
	owner = makeUser({ username: 'owner' });
	// With its Options column, as every delivery board has (card 2527), so the
	// start-up repair run below has none to add.
	A = makeBoard({ owner, name: 'A', options: true });
});

const cardRow = (id: number) => db.select().from(cards).where(eq(cards.id, id)).get()!;
const xpOf = (user: SessionUser) =>
	db.select().from(userXp).where(eq(userXp.name, user.username)).get()?.xp ?? 0;
const activityFor = (cardId: number) =>
	db.select().from(activityLog).where(eq(activityLog.cardId, cardId)).all();

/** The three ways to move a card, each as "move this card to that column". */
const routes: {
	name: string;
	source: 'ui' | 'api';
	move: (card: Card, to: Column, user: SessionUser) => Promise<{ status: number; body: any }>;
}[] = [
	{
		name: 'drag (PUT /api/cards/reorder)',
		source: 'ui',
		move: (card, to, user) =>
			api('PUT', '/api/cards/reorder', {
				user,
				body: { updates: [{ id: card.id, columnId: to.id, position: 0 }] }
			})
	},
	{
		name: 'card update (PUT /api/cards/:id)',
		source: 'ui',
		move: (card, to, user) => api('PUT', `/api/cards/${card.id}`, { user, body: { columnId: to.id } })
	},
	{
		name: 'API move (PUT /api/v1/cards/:id/move)',
		source: 'api',
		move: (card, to, user) =>
			api('PUT', `/api/v1/cards/${card.id}/move`, { user, body: { columnId: to.id } })
	}
];

describe('column roles: one definition for the browser and the server', () => {
	it('treats Complete and Done as finished, whatever the case or spacing', () => {
		for (const title of ['Complete', 'complete', 'DONE', '  Done ']) {
			expect(columnRole(title)).toBe('complete');
		}
		expect(columnRole('In Progress')).toBeNull();
		expect(columnRole('Completed work')).toBeNull();
	});

	it('treats every title that meant paused anywhere as paused everywhere', () => {
		for (const title of ['On Hold', 'Hold', 'Blocked', 'Parked', 'Waiting']) {
			expect(isHoldColumnTitle(title)).toBe(true);
		}
		expect(isHoldColumnTitle('To Do')).toBe(false);
	});

	it('gives the browser helpers the same answer as the server', () => {
		// The browser accepted only "complete", so a "Done" column was complete to
		// the server and an ordinary column to the page showing it.
		for (const title of ['Complete', 'Done', 'On Hold', 'Blocked', 'Waiting', 'In Progress']) {
			expect(isCompleteColumn({ title })).toBe(isCompleteColumnTitle(title));
			expect(serverIsComplete(title)).toBe(isCompleteColumnTitle(title));
			expect(isOnHoldColumn(title)).toBe(isHoldColumnTitle(title));
		}
		expect(isCompleteColumn({ title: 'Done' })).toBe(true);
		expect(isOnHoldColumn('Blocked')).toBe(true);
	});
});

describe.each(routes)('completing a card by $name', ({ move, source }) => {
	it('stamps the dates, awards XP once and writes one activity entry', async () => {
		const card = makeCard(A.cols['To Do'], { priority: 'high' });

		const res = await move(card, A.cols['Complete'], owner);

		expect(res.status).toBe(200);
		const row = cardRow(card.id);
		expect(row.columnId).toBe(A.cols['Complete'].id);
		expect(row.completedAt).not.toBeNull();
		expect(row.firstCompletedAt).toBe(row.completedAt);
		expect(xpOf(owner)).toBe(150);

		const entries = activityFor(card.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			action: source === 'api' ? 'api:card_completed' : 'card_completed',
			source,
			userId: owner.id,
			userName: owner.username,
			boardId: A.board.id
		});
	});

	it('treats a column called Done exactly like one called Complete', async () => {
		const B = makeBoard({ owner, columns: ['Backlog', 'Done'] });
		const card = makeCard(B.cols['Backlog']);

		await move(card, B.cols['Done'], owner);

		expect(cardRow(card.id).completedAt).not.toBeNull();
		expect(xpOf(owner)).toBe(100);
		expect(activityFor(card.id).map((e) => e.action.replace('api:', ''))).toEqual(['card_completed']);
	});

	it('clears completedAt when the card is reopened, and logs the reopening', async () => {
		const card = makeCard(A.cols['To Do']);
		await move(card, A.cols['Complete'], owner);
		const firstCompletedAt = cardRow(card.id).firstCompletedAt;

		const res = await move(cardRow(card.id), A.cols['In Progress'], owner);

		expect(res.status).toBe(200);
		const row = cardRow(card.id);
		expect(row.completedAt).toBeNull();
		// The record that it was once completed survives; that is what stops the
		// XP being earned again.
		expect(row.firstCompletedAt).toBe(firstCompletedAt);
		expect(activityFor(card.id).map((e) => e.action.replace('api:', ''))).toEqual([
			'card_completed',
			'card_reopened'
		]);
	});

	it('awards no XP for completing the same card a second time', async () => {
		const card = makeCard(A.cols['To Do'], { priority: 'critical' });

		await move(card, A.cols['Complete'], owner);
		await move(cardRow(card.id), A.cols['To Do'], owner);
		await move(cardRow(card.id), A.cols['Complete'], owner);

		expect(xpOf(owner)).toBe(200);
		expect(cardRow(card.id).completedAt).not.toBeNull();
	});

	it('logs an ordinary move as a move, and leaves completion alone', async () => {
		const card = makeCard(A.cols['To Do']);

		await move(card, A.cols['In Progress'], owner);

		const row = cardRow(card.id);
		expect(row.completedAt).toBeNull();
		expect(row.firstCompletedAt).toBeNull();
		expect(xpOf(owner)).toBe(0);
		expect(activityFor(card.id).map((e) => e.action.replace('api:', ''))).toEqual(['card_moved']);
	});

	it('refuses to complete a card with open subtasks, changing nothing', async () => {
		const card = makeCard(A.cols['To Do']);
		makeSubtask(card, { completed: false });

		const res = await move(card, A.cols['Complete'], owner);

		expect(res.status).toBe(409);
		const row = cardRow(card.id);
		expect(row.columnId).toBe(A.cols['To Do'].id);
		expect(row.completedAt).toBeNull();
		expect(xpOf(owner)).toBe(0);
		expect(activityFor(card.id)).toHaveLength(0);
	});

	it('refuses to complete a card whose sub-board has unfinished cards, changing nothing', async () => {
		const card = makeCard(A.cols['To Do']);
		makeSubBoard(card, { owner, name: 'Its parts' });
		const before = snapshotDb();

		const res = await move(card, A.cols['Complete'], owner);

		expect(res.status).toBe(409);
		expect(res.body.message).toBe('Sub-board "Its parts" has 1 incomplete card that must be completed first');
		expectUnchanged(before);
	});

	// Card 2151. Access is not inherited from a parent board: an editor of A
	// who was not given the sub-board was told its name and how many of its
	// cards were open. The card is still refused; the message names nothing.
	const HIDDEN_SUB_BOARD = "A sub-board you cannot open still has incomplete cards that must be completed first. Ask this board's owner.";

	it('refuses an editor who cannot open the unfinished sub-board, naming no sub-board and counting nothing', async () => {
		const editor = makeUser({ username: 'editor' });
		addBoardMember(A.board, editor, 'editor');
		const card = makeCard(A.cols['To Do']);
		makeSubBoard(card, { owner, name: 'HIDDENSUB', cards: { 'To Do': 3 } });
		const before = snapshotDb();

		const res = await move(card, A.cols['Complete'], editor);

		expect(res.status).toBe(409);
		expect(res.body.message).toBe(HIDDEN_SUB_BOARD);
		expect(res.body.message).not.toMatch(/HIDDENSUB|\d/);
		expectUnchanged(before);
	});

	it('names the unfinished sub-board the editor can open, before one they cannot', async () => {
		const editor = makeUser({ username: 'editor' });
		addBoardMember(A.board, editor, 'editor');
		const card = makeCard(A.cols['To Do']);
		makeSubBoard(card, { owner, name: 'HIDDENSUB', cards: { 'To Do': 3 } });
		const theirs = makeSubBoard(card, { owner, name: 'Theirs', cards: { 'To Do': 2 } });
		addBoardMember(theirs.board, editor, 'viewer');

		const res = await move(card, A.cols['Complete'], editor);

		expect(res.status).toBe(409);
		expect(res.body.message).toBe('Sub-board "Theirs" has 2 incomplete cards that must be completed first');
	});

	it("names the unfinished sub-board to its maker and to an administrator, who can open it", async () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const card = makeCard(A.cols['To Do']);
		makeSubBoard(card, { owner, name: 'HIDDENSUB', cards: { 'To Do': 3 } });

		for (const who of [owner, admin]) {
			const res = await move(card, A.cols['Complete'], who);
			expect(res.status, who.username).toBe(409);
			expect(res.body.message, who.username).toBe('Sub-board "HIDDENSUB" has 3 incomplete cards that must be completed first');
		}
	});

	it('completes a card once its subtasks are done and its sub-board is finished', async () => {
		const card = makeCard(A.cols['To Do']);
		makeSubtask(card, { completed: true });
		makeSubBoard(card, { owner, cards: { Complete: 2 } });

		const res = await move(card, A.cols['Complete'], owner);

		expect(res.status).toBe(200);
		expect(cardRow(card.id).completedAt).not.toBeNull();
		expect(xpOf(owner)).toBe(100);
	});

	it('moves a finished card to another finished column as a move: not completed again, not reopened', async () => {
		const B = makeBoard({ owner, columns: ['Backlog', 'Done', 'Complete'] });
		const card = makeCard(B.cols['Backlog']);
		await move(card, B.cols['Done'], owner);
		const done = cardRow(card.id);

		const res = await move(done, B.cols['Complete'], owner);

		expect(res.status).toBe(200);
		const row = cardRow(card.id);
		expect(row.columnId).toBe(B.cols['Complete'].id);
		expect(row.completedAt).toBe(done.completedAt);
		expect(row.firstCompletedAt).toBe(done.firstCompletedAt);
		expect(xpOf(owner)).toBe(100);
		expect(activityFor(card.id).map((e) => e.action.replace('api:', ''))).toEqual(['card_completed', 'card_moved']);
	});

	it('says that a move is an edit: updatedAt is the moment of the move', async () => {
		const card = makeCard(A.cols['To Do'], { updatedAt: '2020-01-01 00:00:00' });

		await move(card, A.cols['In Progress'], owner);

		expect(cardRow(card.id).updatedAt > '2026').toBe(true);
	});

	it('answers 404 for a column that is not there, changing nothing', async () => {
		const card = makeCard(A.cols['To Do']);
		const before = snapshotDb();

		const res = await move(card, { ...A.cols['Complete'], id: 99999 }, owner);

		expect(res.status).toBe(404);
		expectUnchanged(before);
	});

	it('answers 404 for a card that is not there, changing nothing', async () => {
		const card = makeCard(A.cols['To Do']);
		const before = snapshotDb();

		const res = await move({ ...card, id: 99999 }, A.cols['Complete'], owner);

		expect(res.status).toBe(404);
		expectUnchanged(before);
	});

	it('refuses a viewer, who may not complete a card, changing nothing', async () => {
		const viewer = makeUser({ username: 'viewer' });
		addBoardMember(A.board, viewer, 'viewer');
		const card = makeCard(A.cols['To Do']);
		const before = snapshotDb();

		const res = await move(card, A.cols['Complete'], viewer);

		expect(res.status).toBe(403);
		expectUnchanged(before);
	});
});

/** A recorded effect in a few words, so that a whole request reads as a list. */
function said(effect: RecordedEffect): string {
	if (effect.kind === 'webhook') return `webhook ${effect.event}`;
	if (effect.kind === 'email') return `email to ${effect.to}: ${effect.subject}`;
	return `event ${effect.event}${effect.data?.action ? ` (${effect.data.action})` : ''}`;
}

/** What a created card is given, and what the route answered. */
type Created = { status: number; cardId: number; body: any };

/**
 * The three ways to create a card (card 2134). `ready` makes whatever has to
 * be there first, which for an accept is the request, and returns the request
 * to make: so that `eachWriteInTurn` can build it with the fixture and count
 * only the writes of the request.
 */
const creatingRoutes: {
	name: string;
	source: 'ui' | 'api';
	/** The writes the route makes after the card's own, for a creation in a Complete column. */
	thenWrites: string[];
	ready: (to: Column, user: SessionUser, card: { title: string; priority: string }) => () => Promise<Created>;
}[] = [
	{
		name: 'the card window (POST /api/cards)',
		source: 'ui',
		thenWrites: [],
		ready: (to, user, card) => async () => {
			const res = await api('POST', '/api/cards', { user, body: { columnId: to.id, ...card } });
			return { status: res.status, cardId: res.body?.id, body: res.body };
		}
	},
	{
		name: 'the API (POST /api/v1/boards/:boardId/cards)',
		source: 'api',
		thenWrites: [],
		ready: (to, user, card) => async () => {
			const res = await api('POST', `/api/v1/boards/${to.boardId}/cards`, { user, body: { columnId: to.id, ...card } });
			return { status: res.status, cardId: res.body?.id, body: res.body };
		}
	},
	{
		name: 'accepting a request (PATCH /api/requests/:id)',
		source: 'ui',
		thenWrites: ['update "task_requests" set'],
		ready: (to, user, card) => {
			const request = db
				.insert(taskRequests)
				.values({
					targetType: 'user',
					targetId: user.id,
					requesterName: 'Rita',
					requesterEmail: 'rita@example.test',
					title: card.title,
					priority: card.priority,
					// One of its own, so that a test can accept several.
					accessToken: crypto.randomUUID().replace(/-/g, '').padEnd(64, 'b')
				})
				.returning()
				.get();
			return async () => {
				const res = await api('PATCH', `/api/requests/${request.id}`, {
					user,
					body: { action: 'accept', boardId: to.boardId, columnId: to.id }
				});
				return { status: res.status, cardId: res.body?.resolvedCardId, body: res.body };
			};
		}
	}
];

describe.each(creatingRoutes)('creating a card by $name', ({ source, ready, thenWrites }) => {
	const create = (to: Column, card: { title: string; priority: string }) => ready(to, owner, card)();
	const prefix = source === 'api' ? 'api:' : '';

	it('completes a card created in a Complete column as a move into it does: the dates, the XP and the entries', async () => {
		const res = await create(A.cols['Complete'], { title: 'Done already', priority: 'high' });

		expect(res.status).toBeLessThan(300);
		const row = cardRow(res.cardId);
		expect(row).toMatchObject({ columnId: A.cols['Complete'].id, createdBy: owner.id });
		expect(row.completedAt).not.toBeNull();
		expect(row.firstCompletedAt).toBe(row.completedAt);
		// A route that answers with the card answers it as written: the v1 API
		// in ISO 8601, the others in the stored form (card 2095, plan R1).
		if ('completedAt' in res.body) expect(res.body.completedAt).toBe(source === 'api' ? toIso(row.completedAt) : row.completedAt);
		expect(xpOf(owner)).toBe(150);

		const entries = activityFor(res.cardId);
		expect(entries.map((e) => e.action)).toEqual([`${prefix}card_created`, `${prefix}card_completed`]);
		for (const entry of entries) {
			expect(entry).toMatchObject({ source, userId: owner.id, userName: owner.username, boardId: A.board.id });
		}
		expect(entries.map((e) => e.detail)).toEqual(['Done already', '"Done already": created in Complete']);

		// What a move into Complete by the same way records, for a card of the same priority.
		const moved = makeCard(A.cols['To Do'], { priority: 'high' });
		await routes.find((r) => r.source === source)!.move(moved, A.cols['Complete'], owner);
		expect(xpOf(owner)).toBe(300);
		const pick = (e: (typeof entries)[number]) => ({
			action: e.action,
			source: e.source,
			userId: e.userId,
			userName: e.userName,
			userEmoji: e.userEmoji,
			boardId: e.boardId
		});
		expect(pick(entries[1])).toEqual(pick(activityFor(moved.id)[0]));
	});

	it('treats a column called Done exactly like one called Complete', async () => {
		const B = makeBoard({ owner, columns: ['Backlog', 'Done'] });

		const res = await create(B.cols['Done'], { title: 'Shipped', priority: 'medium' });

		expect(cardRow(res.cardId).completedAt).not.toBeNull();
		expect(xpOf(owner)).toBe(100);
		expect(activityFor(res.cardId).map((e) => [e.action.replace('api:', ''), e.detail])).toEqual([
			['card_created', 'Shipped'],
			['card_completed', '"Shipped": created in Done']
		]);
	});

	it('commits a card created outside an upstream column, at its creation and by its creator, so the start-up repair finds nothing (milestone 22)', async () => {
		const options = makeBoard({ owner, name: 'With Options', options: true, columns: ['To Do'] });
		const ideas = makeBoard({ owner, name: 'Ideas board', columns: ['New Ideas'] });
		db.update(boards).set({ kind: 'ideas' }).where(eq(boards.id, ideas.board.id)).run();
		const other = makeBoard({ owner, name: 'Another kind', columns: ['Doing'] });
		db.update(boards).set({ kind: 'portfolio' }).where(eq(boards.id, other.board.id)).run();
		const into = async (column: Column, title: string) => cardRow((await create(column, { title, priority: 'low' })).cardId);

		const toDo = await into(A.cols['To Do'], 'Committed work');
		const done = await into(A.cols['Complete'], 'Done already');
		const elsewhere = await into(other.cols['Doing'], 'On a board of another kind');
		const option = await into(options.cols['Options'], 'An option');
		const idea = await into(ideas.cols['New Ideas'], 'An idea');

		for (const row of [toDo, done, elsewhere]) {
			expect({ title: row.title, committedAt: row.committedAt, committedBy: row.committedBy }).toEqual({
				title: row.title,
				committedAt: row.createdAt,
				committedBy: owner.id
			});
		}
		expect([option, idea].map((row) => [row.committedAt, row.committedBy])).toEqual([
			[null, null],
			[null, null]
		]);
		expect(runBackfills(sqlite).committedFilled).toBe(0);
	});

	it('records a card created in any other column as created, and nothing more', async () => {
		const res = await create(A.cols['To Do'], { title: 'To be done', priority: 'high' });

		const row = cardRow(res.cardId);
		expect(row.completedAt).toBeNull();
		expect(row.firstCompletedAt).toBeNull();
		expect(xpOf(owner)).toBe(0);
		expect(activityFor(res.cardId).map((e) => e.action)).toEqual([`${prefix}card_created`]);
	});

	it('tells the webhook, the board and the creator of a completion, and only after the commit', async () => {
		makeWebhook(A.board);
		const sent = effects();
		try {
			await create(A.cols['Complete'], { title: 'Done already', priority: 'low' });
			await sent.settle();

			expect(sent.all.map(said)).toEqual([
				'webhook card.created',
				'webhook card.completed',
				'event update (created)',
				'event xp-update',
				'event celebrate'
			]);
			expect(sent.events.at(-1)).toMatchObject({
				boardId: A.board.id,
				data: { type: 'complete', cardTitle: 'Done already', userName: 'owner', xpGained: 50 }
			});
			expect(sent.duringTransaction).toEqual([]);
		} finally {
			sent.restore();
		}
	});

	it('saves the card, its completion, its XP and both entries, or none of them, whichever write fails', async () => {
		const run = await eachWriteInTurn({
			build: () => {
				const creator = makeUser({ username: 'owner' });
				const board = makeBoard({ owner: creator, name: 'A' });
				makeWebhook(board.board);
				return { creator, create: ready(board.cols['Complete'], creator, { title: 'Done already', priority: 'low' }) };
			},
			request: ({ create }) => create(),
			afterSuccess: ({ creator }, res) => {
				expect(res.status).toBeLessThan(300);
				expect(cardRow(res.cardId).completedAt).not.toBeNull();
				expect(xpOf(creator)).toBe(50);
			}
		});

		expect(run.writes.map((sql) => sql.split(/[ (]/).slice(0, 3).join(' '))).toEqual([
			'insert into "cards"',
			'insert into "activity_log"',
			'update "cards" set',
			'insert into "user_xp"',
			'insert into "activity_log"',
			...thenWrites
		]);
		expect(run.effects.map(said)).toEqual([
			'webhook card.created',
			'webhook card.completed',
			'event update (created)',
			'event xp-update',
			'event celebrate'
		]);
	});
});

describe('a request accepted into a Complete column', () => {
	it('mails the requester that it was accepted, and then that it is complete, with its report', async () => {
		makeSmtp();
		const accept = creatingRoutes.find((r) => r.name.startsWith('accepting'))!;
		const create = accept.ready(A.cols['Complete'], owner, { title: 'Please build this', priority: 'medium' });
		const sent = effects();
		try {
			expect((await create()).status).toBe(200);

			// The report takes a moment to build; the accept has long since been answered.
			await vi.waitFor(() => expect(sent.emails).toHaveLength(2), { timeout: 10_000 });
			expect(sent.emails.map((e) => `${e.to}: ${e.subject}`)).toEqual([
				'rita@example.test: Request accepted: Please build this',
				'rita@example.test: Your request is complete: Please build this ✅'
			]);
			expect(sent.emails[1].attachments).toHaveLength(1);
			expect(sent.emails[1].attachments[0]).toMatch(/^dumpfire-task-report-.*\.pdf$/);
			expect(sent.duringTransaction).toEqual([]);
		} finally {
			sent.restore();
		}
	});
});

/**
 * Duplicate, on a card's menu on the board page (card 2134, R1). A card created
 * in a Complete column is completed, so a copy made beside a finished card was
 * completed too: XP and fireworks for whoever clicked, for work nobody did. A
 * copy is new work, and the copy of a card in a Complete column goes to the
 * board's first column, by position, that is not one. `duplicateCard` is the
 * page's own code; its requests are answered by the routes themselves.
 */
describe('duplicating a card from the board page', () => {
	/** The body of each card the page asked to be created. */
	let created: { columnId: number }[];

	beforeEach(() => {
		created = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body));
			if (url === '/api/cards') created.push(body);
			const res = await api(init.method as 'POST', url, { user: owner, body });
			return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	/** The board's columns as the page holds them, each with its cards, in the order given. */
	const onThePage = (cols: Column[]) =>
		cols.map((col) => ({ ...col, cards: db.select().from(cards).where(eq(cards.columnId, col.id)).all() })) as unknown as ColumnType[];
	const copyOf = (card: Card) => db.select().from(cards).where(eq(cards.title, `${card.title} (Copy)`)).get()!;

	it('makes the copy of a finished card in the first column that is not a Complete column, open', async () => {
		const done = makeCard(A.cols['Complete'], { title: 'Shipped', priority: 'high', completedAt: '2026-10-01 00:00:00' });
		// In no particular order: the page's order is not what decides.
		const page = onThePage([A.cols['Complete'], A.cols['In Progress'], A.cols['To Do'], A.cols['On Hold']]);

		expect(await duplicateCard(page[0].cards[0] as unknown as CardType, page, A.board.id, [])).toEqual({
			title: 'Shipped',
			failure: null,
			into: 'To Do'
		});

		expect(created.map((body) => body.columnId)).toEqual([A.cols['To Do'].id]);
		const copy = copyOf(done);
		expect(copy.columnId).toBe(A.cols['To Do'].id);
		expect([copy.completedAt, copy.firstCompletedAt]).toEqual([null, null]);
		expect(xpOf(owner)).toBe(0);
		expect(activityFor(copy.id).map((e) => e.action)).toEqual(['card_created']);
	});

	it('makes the copy of a card in any other column beside it', async () => {
		const working = makeCard(A.cols['In Progress'], { title: 'Building' });
		const page = onThePage(Object.values(A.cols));

		await duplicateCard(working as unknown as CardType, page, A.board.id, []);

		expect(created.map((body) => body.columnId)).toEqual([A.cols['In Progress'].id]);
		expect(copyOf(working).columnId).toBe(A.cols['In Progress'].id);
	});

	it('commits the copy as it is created, by whoever copied it, not by the original’s creator (milestone 22)', async () => {
		const someoneElse = makeUser();
		const working = makeCard(A.cols['In Progress'], { title: 'Building', createdBy: someoneElse.id });
		const page = onThePage(Object.values(A.cols));

		await duplicateCard(working as unknown as CardType, page, A.board.id, []);

		const copy = copyOf(working);
		expect([copy.committedAt, copy.committedBy]).toEqual([copy.createdAt, owner.id]);
		expect(runBackfills(sqlite).committedFilled).toBe(0);
	});

	it('keeps the copy beside the original on a board with no other column, where it is completed', async () => {
		const B = makeBoard({ owner, name: 'B', columns: ['Done', 'Complete'] });
		const done = makeCard(B.cols['Complete'], { title: 'Finished', completedAt: '2026-10-01 00:00:00' });
		const page = onThePage(Object.values(B.cols));

		await duplicateCard(done as unknown as CardType, page, B.board.id, []);

		expect(created.map((body) => body.columnId)).toEqual([B.cols['Complete'].id]);
		expect(copyOf(done).completedAt).not.toBeNull();
	});

	it('names the column the copy went to when it is not beside the original, for the board page to say (O7)', async () => {
		const done = makeCard(A.cols['Complete'], { title: 'Shipped', completedAt: '2026-10-01 00:00:00' });
		const working = makeCard(A.cols['In Progress'], { title: 'Building' });
		const page = onThePage(Object.values(A.cols));

		// "Duplicated "Shipped (Copy)" into To Do" on the page: the copy is not where the original is.
		expect((await duplicateCard(done as unknown as CardType, page, A.board.id, [])).into).toBe('To Do');
		// Beside the original, as before: "Duplicated "Building"".
		expect(await duplicateCard(working as unknown as CardType, page, A.board.id, [])).not.toHaveProperty('into');
	});
});

/**
 * The dashboard's inline sub-board (card 2134, O9). With no parent card
 * chosen, it creates one named after the sub-board, and it put it in the
 * board's first column by position: a Complete column there completed it at
 * once, with XP and fireworks. It goes to the first column that is not a
 * Complete column now, as a copy of a finished card does, and to the first
 * only when every column is one.
 */
describe('the parent card the dashboard makes for a sub-board', () => {
	it('goes to the first column, by position, that is not a Complete column', () => {
		const cols = [
			{ id: 3, title: 'In Progress', position: 2, role: null },
			{ id: 1, title: 'Done', position: 0, role: null },
			{ id: 2, title: 'To Do', position: 1, role: null }
		];
		expect(firstOpenColumn(cols)?.id).toBe(2);
		expect(
			firstOpenColumn([
				{ id: 1, title: 'Complete', position: 0, role: null },
				{ id: 2, title: 'done', position: 1, role: null }
			])
		).toBeUndefined();
		expect(firstOpenColumn([])).toBeUndefined();
	});

	it('is where the dashboard puts it, and nowhere when no column is open: never the first column, which is the Options column (card 2527, K1)', () => {
		// The dashboard's context menu makes it (card 2281, slice C2: moved from src/routes/+page.svelte).
		const dashboard = readFileSync(join(process.cwd(), 'src/lib/components/dashboard/BoardContextMenu.svelte'), 'utf8');
		const create = dashboard.slice(dashboard.indexOf('async function createSubBoardInline()'));

		expect(create).toContain('const firstCol = firstOpenColumn(subBoardColumns);');
		expect(create).not.toContain('subBoardColumns[0]');
		// With none, it says so and makes no card.
		const refused = create.slice(create.indexOf('if (!firstCol) {'));
		expect(refused.slice(0, refused.indexOf('}'))).toContain("subBoardError = 'This board has no columns to hold a parent card';");
		expect(create.indexOf('if (!firstCol) {')).toBeLessThan(create.indexOf("fetch('/api/cards'"));
		expect(create).toContain('body: JSON.stringify({ columnId: firstCol.id, boardId: boardCtx.boardId, title: name })');
		// A board whose only other column is Complete has no open column.
		expect(
			firstOpenColumn([
				{ id: 1, title: 'Options', position: 0, role: 'options' },
				{ id: 2, title: 'Complete', position: 1, role: null }
			])
		).toBeUndefined();
	});
});

/**
 * Who is mailed "Card moved" (card 2134, decision 4 and R4). A completion is
 * mailed to the card's assignees whichever way it was made; a plain move only
 * when it was made on the page, since a script moves cards through the API all
 * day. Whoever made the move is never mailed about it.
 */
describe.each(routes)('the "Card moved" mail, for a move by $name', ({ move, source }) => {
	let sent: Effects;
	let assignee: SessionUser;
	beforeEach(() => {
		makeSmtp();
		db.insert(settings).values({ key: 'app_url', value: 'https://dumpfire.example.test' }).run();
		assignee = makeUser({ username: 'assignee' });
		addBoardMember(A.board, assignee, 'editor');
		sent = effects();
	});
	afterEach(() => sent.restore());

	const movedMail = () => sent.emails.filter((e) => e.subject.startsWith('Card moved: ')).map((e) => `${e.to}: ${e.subject}`);

	it('goes to an assignee when the card is completed', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Ship it' });
		assignCard(card, assignee);

		expect((await move(card, A.cols['Complete'], owner)).status).toBe(200);
		await sent.settle();

		expect(movedMail()).toEqual(['assignee@example.test: Card moved: Ship it → Complete']);
	});

	it(`goes to an assignee for a plain move ${source === 'ui' ? 'made on the page' : 'only if it was made on the page: not this one'}`, async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Ship it' });
		assignCard(card, assignee);

		expect((await move(card, A.cols['In Progress'], owner)).status).toBe(200);
		await sent.settle();

		expect(movedMail()).toEqual(source === 'ui' ? ['assignee@example.test: Card moved: Ship it → In Progress'] : []);
	});

	it('never goes to the assignee who made the move', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Ship it' });
		assignCard(card, assignee);
		assignCard(card, owner);

		expect((await move(card, A.cols['Complete'], assignee)).status).toBe(200);
		await sent.settle();

		// The other assignee is told. The one who moved it is not told that they did.
		expect(movedMail()).toEqual(['owner@example.test: Card moved: Ship it → Complete']);
	});

	it('never goes to an assignee who cannot open the board (card 2180)', async () => {
		// Assigned while on the board, then taken off it: still assigned.
		const outsider = makeUser({ username: 'outsider' });
		const card = makeCard(A.cols['To Do'], { title: 'Secret' });
		assignCard(card, assignee);
		assignCard(card, outsider);

		expect((await move(card, A.cols['Complete'], owner)).status).toBe(200);
		await sent.settle();

		expect(movedMail()).toEqual(['assignee@example.test: Card moved: Secret → Complete']);
		expect(sent.emails.filter((e) => e.to === 'outsider@example.test')).toEqual([]);
	});
});

/**
 * The two ways to tick a subtask: the card modal, and the documented API.
 *
 * A subtask has no date of completion and earns no XP, by either. What a tick
 * leaves behind is its flag, an entry in the activity log and a mail to
 * whoever asked for the card.
 */
const subtaskRoutes: {
	name: string;
	source: 'ui' | 'api';
	path: (subtaskId: number) => string;
}[] = [
	{ name: 'the page (PUT /api/subtasks/:id)', source: 'ui', path: (id) => `/api/subtasks/${id}` },
	// It wrote no entry and told no requester, until card 2108.
	{ name: 'the API (PUT /api/v1/subtasks/:id)', source: 'api', path: (id) => `/api/v1/subtasks/${id}` }
];

describe.each(subtaskRoutes)('ticking a subtask by $name', ({ path, source }) => {
	const subtaskRow = (id: number) => db.select().from(subtasks).where(eq(subtasks.id, id)).get()!;
	const tick = (id: number, completed = true) => api('PUT', path(id), { user: owner, body: { completed } });

	let sent: Effects;
	beforeEach(() => {
		sent = effects();
	});
	afterEach(() => sent.restore());

	it('marks it done, and leaves its card where it is with no date of completion and no XP', async () => {
		const card = makeCard(A.cols['To Do']);
		const only = makeSubtask(card, { completed: false });

		const res = await tick(only.id);

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ id: only.id, completed: true });
		expect(subtaskRow(only.id).completed).toBe(true);
		// The last subtask done does not complete the card: that is a move.
		expect(cardRow(card.id)).toMatchObject({ columnId: A.cols['To Do'].id, completedAt: null, firstCompletedAt: null });
		expect(xpOf(owner)).toBe(0);
	});

	it('writes one activity entry, which says who ticked it and by which way', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'The card' });
		const step = makeSubtask(card, { title: 'Write it', completed: false });

		await tick(step.id);

		const entries = activityFor(card.id);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			action: source === 'api' ? 'api:subtask_completed' : 'subtask_completed',
			source,
			userId: owner.id,
			userName: owner.username,
			boardId: A.board.id,
			detail: 'Write it (on The card)'
		});
	});

	it('tells whoever asked for the card', async () => {
		makeSmtp();
		const card = makeCard(A.cols['To Do']);
		const step = makeSubtask(card, { completed: false });
		db.insert(taskRequests)
			.values({
				targetType: 'user',
				targetId: owner.id,
				requesterName: 'Rita',
				requesterEmail: 'rita@example.test',
				title: 'Please build this',
				status: 'accepted',
				accessToken: 'a'.repeat(64),
				resolvedBy: owner.id,
				resolvedCardId: card.id
			})
			.run();

		await tick(step.id);
		await sent.settle();

		expect(sent.emails.map((e) => `${e.to}: ${e.subject}`)).toEqual([
			'rita@example.test: Subtask completed on your request: Please build this'
		]);
	});

	it('writes nothing more when a subtask already ticked is ticked again', async () => {
		const card = makeCard(A.cols['To Do']);
		const step = makeSubtask(card, { completed: false });
		await tick(step.id);
		const before = snapshotDb();

		const again = await tick(step.id);

		expect(again.status).toBe(200);
		expectUnchanged(before);
	});

	// It wrote no entry for the untick until card 2299; now one
	// `subtask_updated`, never a second `subtask_completed`.
	it('unticks it again, with one subtask_updated entry that says it was reopened', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'The card' });
		const step = makeSubtask(card, { title: 'Write it', completed: true });

		const res = await tick(step.id, false);

		expect(res.status).toBe(200);
		expect(subtaskRow(step.id).completed).toBe(false);
		expect(activityFor(card.id)).toMatchObject([
			{
				action: source === 'api' ? 'api:subtask_updated' : 'subtask_updated',
				source,
				userId: owner.id,
				detail: 'Reopened Write it (on The card)'
			}
		]);
	});

	it('is what lets the card be completed: refused before the tick, done after it', async () => {
		const card = makeCard(A.cols['To Do']);
		const step = makeSubtask(card, { completed: false });
		const complete = () =>
			api('PUT', `/api/v1/cards/${card.id}/move`, { user: owner, body: { columnId: A.cols['Complete'].id } });

		expect((await complete()).status).toBe(409);
		await tick(step.id);

		expect((await complete()).status).toBe(200);
		expect(cardRow(card.id).completedAt).not.toBeNull();
	});

	it('refuses a caller who cannot edit the board, a subtask that is not there and a body with nothing in it, alike', async () => {
		const card = makeCard(A.cols['To Do']);
		const step = makeSubtask(card, { completed: false });
		const viewer = makeUser({ username: 'viewer' });
		addBoardMember(A.board, viewer, 'viewer');
		const before = snapshotDb();

		const asViewer = await api('PUT', path(step.id), { user: viewer, body: { completed: true } });
		const asNobody = await api('PUT', path(step.id), { body: { completed: true } });
		const missing = await api('PUT', path(99999), { user: owner, body: { completed: true } });
		const empty = await api('PUT', path(step.id), { user: owner, body: { cardId: 99 } });

		expect([asViewer.status, asNobody.status, missing.status, empty.status]).toEqual([403, 401, 404, 400]);
		expectUnchanged(before);
		expect(sent.all).toEqual([]);
	});
});

describe('a drop of several cards', () => {
	it('completes every card in it and sums the XP', async () => {
		const low = makeCard(A.cols['To Do'], { priority: 'low' });
		const high = makeCard(A.cols['To Do'], { priority: 'high' });

		const res = await api('PUT', '/api/cards/reorder', {
			user: owner,
			body: {
				updates: [
					{ id: low.id, columnId: A.cols['Complete'].id, position: 0 },
					{ id: high.id, columnId: A.cols['Complete'].id, position: 1 }
				]
			}
		});

		expect(res.status).toBe(200);
		expect(cardRow(low.id).completedAt).not.toBeNull();
		expect(cardRow(high.id).completedAt).not.toBeNull();
		expect(xpOf(owner)).toBe(200);
	});

	it('moves none of them if one cannot be completed', async () => {
		const free = makeCard(A.cols['To Do']);
		const blocked = makeCard(A.cols['To Do']);
		makeSubtask(blocked, { completed: false });

		const res = await api('PUT', '/api/cards/reorder', {
			user: owner,
			body: {
				updates: [
					{ id: free.id, columnId: A.cols['Complete'].id, position: 0 },
					{ id: blocked.id, columnId: A.cols['Complete'].id, position: 1 }
				]
			}
		});

		expect(res.status).toBe(409);
		// The first card had already been written when the second was refused.
		expect(cardRow(free.id).columnId).toBe(A.cols['To Do'].id);
		expect(cardRow(free.id).completedAt).toBeNull();
		expect(xpOf(owner)).toBe(0);
		expect(db.select().from(activityLog).all()).toHaveLength(0);
	});

	it('treats a change of position alone as no edit at all', async () => {
		const card = makeCard(A.cols['To Do'], { position: 0 });
		const before = cardRow(card.id);

		await api('PUT', '/api/cards/reorder', {
			user: owner,
			body: { updates: [{ id: card.id, columnId: A.cols['To Do'].id, position: 5 }] }
		});

		const after = cardRow(card.id);
		expect(after.position).toBe(5);
		expect(after.updatedAt).toBe(before.updatedAt);
		expect(activityFor(card.id)).toHaveLength(0);
	});
});

describe('moving a card to another board', () => {
	it.each(routes.filter((r) => !r.name.startsWith('drag')))(
		'by $name: drops the old board labels and category, and records both ends',
		async ({ move }) => {
			const B = makeBoard({ owner, name: 'B' });
			const label = makeLabel(A.board);
			const category = db.insert(categories).values({ boardId: A.board.id, name: 'A only' }).returning().get();
			const card = makeCard(A.cols['To Do'], { categoryId: category.id });
			db.insert(cardLabels).values({ cardId: card.id, labelId: label.id }).run();

			const res = await move(card, B.cols['In Progress'], owner);

			expect(res.status).toBe(200);
			const row = cardRow(card.id);
			expect(row.columnId).toBe(B.cols['In Progress'].id);
			expect(row.categoryId).toBeNull();
			expect(db.select().from(cardLabels).all()).toHaveLength(0);

			const entries = activityFor(card.id).map((e) => [e.boardId, e.action.replace('api:', '')]);
			expect(entries).toEqual([
				[A.board.id, 'card_moved_away'],
				[B.board.id, 'card_moved_in']
			]);
		}
	);

	it('keeps a shared category, which belongs to no board', async () => {
		const B = makeBoard({ owner, name: 'B' });
		const shared = db.insert(categories).values({ boardId: null, name: 'Shared' }).returning().get();
		const card = makeCard(A.cols['To Do'], { categoryId: shared.id });

		await api('PUT', `/api/v1/cards/${card.id}/move`, { user: owner, body: { columnId: B.cols['To Do'].id } });

		expect(cardRow(card.id).categoryId).toBe(shared.id);
	});

	it('logs a completion as well when the card lands in a Complete column', async () => {
		const B = makeBoard({ owner, name: 'B' });
		const card = makeCard(A.cols['To Do']);

		await api('PUT', `/api/v1/cards/${card.id}/move`, { user: owner, body: { columnId: B.cols['Complete'].id } });

		expect(cardRow(card.id).completedAt).not.toBeNull();
		expect(activityFor(card.id).map((e) => e.action)).toEqual([
			'api:card_moved_away',
			'api:card_moved_in',
			'api:card_completed'
		]);
	});
});

describe('figures built from the activity log count API moves', () => {
	it('gives a card moved through the API a cycle time', async () => {
		const card = makeCard(A.cols['To Do']);
		await api('PUT', `/api/v1/cards/${card.id}/move`, { user: owner, body: { columnId: A.cols['In Progress'].id } });
		await api('PUT', `/api/v1/cards/${card.id}/move`, { user: owner, body: { columnId: A.cols['Complete'].id } });

		const res = await api('GET', `/api/boards/${A.board.id}/metrics`, { user: owner });

		expect(res.status).toBe(200);
		expect(res.body.completed).toBe(1);
		// The first move is stored as `api:card_moved`. Matching only the bare name
		// found no move at all, so cycle time was null for every API-moved card.
		expect(res.body.cycleTime).not.toBeNull();
		expect(res.body.cards[0].cycleTimeHours).not.toBeNull();
	});

	it('counts API completions in personal stats, alongside UI ones', async () => {
		const viaApi = makeCard(A.cols['To Do']);
		const viaUi = makeCard(A.cols['To Do']);
		await api('PUT', `/api/v1/cards/${viaApi.id}/move`, { user: owner, body: { columnId: A.cols['Complete'].id } });
		await api('PUT', '/api/cards/reorder', {
			user: owner,
			body: { updates: [{ id: viaUi.id, columnId: A.cols['Complete'].id, position: 0 }] }
		});

		const res = await api('GET', '/api/v1/me/stats', { user: owner });

		expect(res.body.cardsCompleted.total).toBe(2);
		expect(res.body.cardsCompleted.last7Days).toBe(2);
		expect(res.body.streak).toBe(1);
	});
});

/**
 * Everything that reads an action's name out of the activity log. An action
 * the page made is stored bare (`card_completed`) and the same action made
 * through the API with a prefix (`api:card_completed`), so a reader that
 * compares with the bare name counts half. Each test below makes the same
 * thing happen once by each way and expects the reader to see both.
 */
describe('every reader of the activity log counts what the page did and what the API did alike', () => {
	const byPage = (card: Card, to: Column) =>
		api('PUT', `/api/cards/${card.id}`, { user: owner, body: { columnId: to.id } });
	const byApi = (card: Card, to: Column) =>
		api('PUT', `/api/v1/cards/${card.id}/move`, { user: owner, body: { columnId: to.id } });

	/** One card started and finished from the page, and one through the API. */
	async function oneEach(): Promise<{ viaPage: Card; viaApi: Card }> {
		const viaPage = makeCard(A.cols['To Do'], { title: 'By the page' });
		const viaApi = makeCard(A.cols['To Do'], { title: 'By the API' });
		await byPage(viaPage, A.cols['In Progress']);
		await byApi(viaApi, A.cols['In Progress']);
		await byPage(cardRow(viaPage.id), A.cols['Complete']);
		await byApi(cardRow(viaApi.id), A.cols['Complete']);
		return { viaPage, viaApi };
	}

	it('board metrics: a cycle time for both cards', async () => {
		const { viaPage, viaApi } = await oneEach();

		const res = await api('GET', `/api/boards/${A.board.id}/metrics`, { user: owner });

		expect(res.body.completed).toBe(2);
		const cycle = Object.fromEntries(
			res.body.cards.map((c: { id: number; cycleTimeHours: number | null }) => [c.id, c.cycleTimeHours])
		);
		expect(cycle[viaPage.id]).not.toBeNull();
		expect(cycle[viaApi.id]).not.toBeNull();
	});

	it('personal stats: both completions, in every window', async () => {
		await oneEach();

		const res = await api('GET', '/api/v1/me/stats', { user: owner });

		expect(res.body.cardsCompleted).toEqual({ total: 2, last7Days: 2, last30Days: 2 });
		expect(res.body.streak).toBe(1);
	});

	it('the audit log of the API: a filter by action finds both, and a filter by source tells them apart', async () => {
		const admin = makeUser({ role: 'admin' });
		const { viaPage, viaApi } = await oneEach();
		const found = async (query: string) =>
			(await api('GET', `/api/v1/audit-log?${query}`, { user: admin })).body.data.map(
				(e: { cardId: number }) => e.cardId
			);

		expect((await found('action=card_completed')).sort()).toEqual([viaPage.id, viaApi.id].sort());
		// Asked for by the spelling it is stored with, it is the same question.
		expect((await found('action=api:card_completed')).sort()).toEqual([viaPage.id, viaApi.id].sort());
		expect((await found('action=card_*')).length).toBe(4);
		expect(await found('action=card_completed&source=api')).toEqual([viaApi.id]);
		expect(await found('action=card_completed&source=ui')).toEqual([viaPage.id]);
	});

	// Card 2127. `GET /api/audit`, which the Audit page's Action filter asks,
	// compared the action with what was typed and nothing else, so
	// "card_completed" found the completions made from the page and none made
	// through the API.
	it('the audit log of the Audit page: a filter by action finds both', async () => {
		const admin = makeUser({ role: 'admin' });
		const { viaPage, viaApi } = await oneEach();

		const res = await api('GET', '/api/audit?action=card_completed', { user: admin });

		expect(res.status).toBe(200);
		expect(res.body.data.map((e: { cardId: number }) => e.cardId).sort()).toEqual([viaPage.id, viaApi.id].sort());
	});

	it('the audit log of the Audit page: a filter by source tells them apart, and api: in front means through the API', async () => {
		const admin = makeUser({ role: 'admin' });
		const { viaPage, viaApi } = await oneEach();
		const found = async (query: string) =>
			(await api('GET', `/api/audit?${query}`, { user: admin })).body.data.map((e: { cardId: number }) => e.cardId);

		expect(await found('action=card_completed&source=api')).toEqual([viaApi.id]);
		expect(await found('action=card_completed&source=ui')).toEqual([viaPage.id]);
		// The spelling the API's entries are stored with asks for those alone,
		// as `api:*` has always listed only the API's.
		expect(await found('action=api:card_completed')).toEqual([viaApi.id]);
		expect((await found('source=api')).sort()).toEqual([viaApi.id, viaApi.id]);
	});

	it('the audit log of the Audit page: refuses a source that is neither ui nor api', async () => {
		const admin = makeUser({ role: 'admin' });

		const res = await api('GET', '/api/audit?source=web', { user: admin });

		expect(res.status).toBe(400);
		expect(res.body).toEqual({ message: 'source must be "ui" or "api"' });
	});

	// R8 of card 2127. `_` is LIKE's one-character wildcard, so `card_%`
	// matched `cards_purged` and `cards_cleared` on both audit logs.
	it.each(['/api/audit', '/api/v1/audit-log'])('%s: card_* finds the four card_ entries, and not cards_purged', async (route) => {
		const admin = makeUser({ role: 'admin' });
		await oneEach();
		db.insert(activityLog).values({ boardId: A.board.id, action: 'cards_purged', detail: '2 cards' }).run();

		const res = await api('GET', `${route}?action=card_*`, { user: admin });

		expect(res.status).toBe(200);
		expect(res.body.data.map((e: { action: string }) => e.action).sort()).toEqual(
			route === '/api/audit'
				? ['api:card_completed', 'api:card_moved', 'card_completed', 'card_moved']
				: ['card_completed', 'card_completed', 'card_moved', 'card_moved']
		);
		// And the entry is there to be found by its own name.
		expect((await api('GET', `${route}?action=cards_*`, { user: admin })).body.data).toHaveLength(1);
	});

	it('the audit log of the Audit page: with no filter, and with a wildcard, lists what each way stored', async () => {
		const admin = makeUser({ role: 'admin' });
		await oneEach();
		const actions = async (query: string) =>
			(await api('GET', `/api/audit${query}`, { user: admin })).body.data
				.map((e: { action: string }) => e.action)
				.sort();

		expect(await actions('')).toEqual(['api:card_completed', 'api:card_moved', 'card_completed', 'card_moved']);
		expect(await actions('?action=api:*')).toEqual(['api:card_completed', 'api:card_moved']);
	});

	it('the activity list of a board: both entries, each as it is stored', async () => {
		await oneEach();

		const res = await api('GET', `/api/activity?boardId=${A.board.id}`, { user: owner });

		expect(res.body.map((e: { action: string }) => e.action).sort()).toEqual([
			'api:card_completed',
			'api:card_moved',
			'card_completed',
			'card_moved'
		]);
	});

	it('the activity report: both cards, as completed by the one who moved them', async () => {
		const { viaPage, viaApi } = await oneEach();

		const res = await api('GET', `/api/v1/reports/activity?userId=${owner.id}`, { user: owner });

		expect(res.status).toBe(200);
		expect(res.body.totals).toMatchObject({ cards: 2, completed: 2 });
		const reported = res.body.boards.flatMap((b: { cards: { id: number }[] }) => b.cards.map((c) => c.id));
		expect(reported.sort()).toEqual([viaPage.id, viaApi.id].sort());
	});

	it("a card's board history: the same boards in the same order, whichever way it was made and moved across", async () => {
		const B = makeBoard({ owner, name: 'B' });
		// Made by each way too: the board a card began on is read from the entry
		// its creation wrote, `card_created` or `api:card_created`.
		const viaPage: Card = (
			await api('POST', '/api/cards', { user: owner, body: { columnId: A.cols['To Do'].id, title: 'By the page' } })
		).body;
		const viaApi: Card = (
			await api('POST', `/api/v1/boards/${A.board.id}/cards`, {
				user: owner,
				body: { columnId: A.cols['To Do'].id, title: 'By the API' }
			})
		).body;
		await byPage(viaPage, B.cols['To Do']);
		await byApi(viaApi, B.cols['To Do']);
		const history = async (card: Card) =>
			(await api('GET', `/api/v1/cards/${card.id}/board-history`, { user: owner })).body.history.map(
				(h: { boardId: number; current: boolean }) => [h.boardId, h.current]
			);

		expect(await history(viaPage)).toEqual([
			[A.board.id, false],
			[B.board.id, true]
		]);
		expect(await history(viaApi)).toEqual(await history(viaPage));
	});

	// Card 2199. A card with no `card_created` entry (made before entries were
	// written) was given its first board only when its first departure was
	// strictly earlier than its first arrival. A move writes the two in the same
	// second, so the board it started on was dropped. Every entry of the card is
	// put at one time after the moves, so that the tie does not hang on the clock.
	describe('the board a card started on, with no recorded creation (card 2199)', () => {
		const MOVED = '2026-10-15 09:00:00';
		const tie = (card: Card) =>
			db.update(activityLog).set({ createdAt: MOVED }).where(eq(activityLog.cardId, card.id)).run();
		const spans = async (card: Card) =>
			(await api('GET', `/api/v1/cards/${card.id}/board-history`, { user: owner })).body.history as {
				boardId: number;
				from: string;
				to: string | null;
				current: boolean;
			}[];

		it('begins with the board it was made on, moved by either way, from its creation to its departure', async () => {
			const B = makeBoard({ owner, name: 'B' });
			const viaApi = makeCard(A.cols['To Do'], { title: 'Moved by the API', createdAt: '2026-10-15 08:00:00' });
			const viaPage = makeCard(A.cols['To Do'], { title: 'Moved by the page', createdAt: '2026-10-15 08:00:00' });
			await byApi(viaApi, B.cols['To Do']);
			await byPage(viaPage, B.cols['To Do']);

			for (const card of [viaApi, viaPage]) {
				tie(card);
				const history = await spans(card);
				expect(history.map((h) => [h.boardId, h.current])).toEqual([
					[A.board.id, false],
					[B.board.id, true]
				]);
				expect(history[0]).toMatchObject({ from: toIso('2026-10-15 08:00:00'), to: toIso(MOVED) });
				expect(history[1]).toMatchObject({ from: toIso(MOVED), to: null });
			}
		});

		it('begins with the board it was made on after two moves in the same second', async () => {
			const B = makeBoard({ owner, name: 'B' });
			const C = makeBoard({ owner, name: 'C' });
			const card = makeCard(A.cols['To Do'], { title: 'Moved twice' });
			await byApi(card, B.cols['To Do']);
			await byApi(cardRow(card.id), C.cols['To Do']);
			tie(card);

			expect((await spans(card)).map((h) => h.boardId)).toEqual([A.board.id, B.board.id, C.board.id]);
		});

		it('lists a board once when the card has its creation entry and moved in the same second', async () => {
			const B = makeBoard({ owner, name: 'B' });
			const made: Card = (
				await api('POST', '/api/cards', { user: owner, body: { columnId: A.cols['To Do'].id, title: 'Made and moved' } })
			).body;
			await byApi(made, B.cols['To Do']);
			tie(made);

			expect((await spans(made)).map((h) => h.boardId)).toEqual([A.board.id, B.board.id]);
		});
	});

	it('the burndown: a card moved here from another board is counted, by either way', async () => {
		const B = makeBoard({ owner, name: 'B' });
		await byPage(makeCard(A.cols['To Do']), B.cols['To Do']);
		await byApi(makeCard(A.cols['To Do']), B.cols['To Do']);

		const res = await api('GET', `/api/v1/burndown?boardIds=${B.board.id}`, { user: owner });

		expect(res.status).toBe(200);
		expect(res.body.meta.notes).toContain('2 cards moved here from another board and count here for their whole life.');
	});
});

describe('the browser no longer writes activity entries', () => {
	it('has no route to write one through', async () => {
		await expect(
			api('POST', '/api/activity', { user: owner, body: { boardId: A.board.id, action: 'card_completed' } })
		).rejects.toThrow(/does not export POST/);
	});
});

/**
 * An archived card on a sub-board is not live work (card 2205). The completion
 * check counted it, so a card whose sub-board held one archived card in To Do
 * could not be completed by any route, and the board page counted it in the
 * sub-board's figures while the dashboard, the card context and the sub-board's
 * own page left it out. Now one helper, `subBoardProgress`, gives every one of
 * them the same figures: the cards that are not archived, and of them those in
 * a Complete column.
 */
describe('archived cards on a sub-board (card 2205)', () => {
	const ARCHIVED = '2026-10-01 00:00:00';
	let editor: SessionUser;
	let parent: Card;
	let S: ReturnType<typeof makeSubBoard>;
	let archivedOpen: Card;

	// The world of the plan's probe: Parent in To Do on A, and under it S, with
	// one card in Complete, one archived card in To Do and one archived card in
	// Complete. S was made by the owner, so an editor of A cannot open it.
	beforeEach(() => {
		editor = makeUser({ username: 'editor' });
		addBoardMember(A.board, editor, 'editor');
		parent = makeCard(A.cols['To Do'], { title: 'Parent' });
		S = makeSubBoard(parent, { owner, name: 'S', cards: { Complete: 1 } });
		archivedOpen = makeCard(S.cols['To Do'], { archivedAt: ARCHIVED });
		makeCard(S.cols['Complete'], { archivedAt: ARCHIVED });
	});

	type Figures = { done: number; total: number };
	const cardsOnA = async (user: SessionUser): Promise<any[]> => {
		const res = await pageLoad(`/board/${A.board.id}`, { user });
		expect(res.type).toBe('data');
		return ((res as { data: any }).data.columns as any[]).flatMap((col) => col.cards);
	};
	const parentOn = async (user: SessionUser) => (await cardsOnA(user)).find((card) => card.id === parent.id);
	const figuresOf = (sb: Figures) => ({ done: sb.done, total: sb.total });
	const ofS = (subBoards: { id: number }[]) => subBoards.find((sb) => sb.id === S.board.id) as Figures & { id: number };

	/** S's figures on the board page's card, in the card context and on the dashboard's tile. */
	async function figuresEverywhere(): Promise<Record<string, Figures>> {
		const context = await api('GET', `/api/cards/${parent.id}/context`, { user: owner });
		expect(context.status).toBe(200);
		const dashboard = await pageLoad('/', { user: owner });
		expect(dashboard.type).toBe('data');
		const tile = ((dashboard as { data: any }).data.boards as any[]).find((board) => board.id === A.board.id);
		return {
			'board page': figuresOf(ofS((await parentOn(owner)).subBoards)),
			'card context': figuresOf(ofS(context.body.card.subBoards)),
			'dashboard tile': figuresOf(ofS(tile.subBoards))
		};
	}
	const same = (figures: Figures) => ({ 'board page': figures, 'card context': figures, 'dashboard tile': figures });

	describe.each(routes)('by $name', ({ move }) => {
		it('completes a card held back only by an archived card', async () => {
			const res = await move(parent, A.cols['Complete'], owner);

			expect(res.status).toBe(200);
			const row = cardRow(parent.id);
			expect(row.columnId).toBe(A.cols['Complete'].id);
			expect(row.completedAt).not.toBeNull();
			expect(xpOf(owner)).toBe(100);
		});

		it('still refuses it for a live open card, counting that card alone', async () => {
			makeCard(S.cols['To Do']);
			const before = snapshotDb();

			const res = await move(parent, A.cols['Complete'], owner);

			expect(res.status).toBe(409);
			expect(res.body.message).toBe('Sub-board "S" has 1 incomplete card that must be completed first');
			expectUnchanged(before);
		});
	});

	it('gives the same figures in every place: the card in Complete, and neither archived card', async () => {
		expect(await figuresEverywhere()).toEqual(same({ done: 1, total: 1 }));
	});

	it('counts a live open card in every place, alike', async () => {
		makeCard(S.cols['To Do']);

		expect(await figuresEverywhere()).toEqual(same({ done: 1, total: 2 }));
	});

	it('leaves archived cards out of the count on a sub-board the caller cannot open, so the drop is taken', async () => {
		const drop = () => routes[0].move(parent, A.cols['Complete'], editor);
		const live = makeCard(S.cols['To Do']);

		// A live open card: counted, with no name, and the drop refused.
		const shown = await parentOn(editor);
		expect(shown.subBoards).toEqual([]);
		expect(shown.hiddenOpenCount).toBe(1);
		expect((await drop()).status).toBe(409);

		// Archived, it holds nothing back.
		db.update(cards).set({ archivedAt: ARCHIVED }).where(eq(cards.id, live.id)).run();
		expect((await parentOn(editor)).hiddenOpenCount).toBe(0);
		expect((await drop()).status).toBe(200);
		expect(cardRow(parent.id).completedAt).not.toBeNull();
	});

	it('holds nothing back with a sub-board of archived cards only, which reads 0 of 0', async () => {
		const other = makeCard(A.cols['To Do'], { title: 'Other' });
		const T = makeSubBoard(other, { owner, name: 'T', cards: {} });
		makeCard(T.cols['To Do'], { archivedAt: ARCHIVED });

		expect(getCompletionBlocker(other.id, owner)).toBeNull();
		const shown = (await cardsOnA(owner)).find((card) => card.id === other.id);
		expect(shown.subBoards.map(figuresOf)).toEqual([{ done: 0, total: 0 }]);
	});

	it('leaves a completed card complete when an archived card under it is restored', async () => {
		expect((await routes[2].move(parent, A.cols['Complete'], owner)).status).toBe(200);
		const completedAt = cardRow(parent.id).completedAt;
		expect(completedAt).not.toBeNull();

		const res = await api('POST', `/api/cards/${archivedOpen.id}/restore`, { user: owner });

		expect(res.status).toBe(200);
		expect(cardRow(archivedOpen.id).archivedAt).toBeNull();
		const row = cardRow(parent.id);
		expect(row.columnId).toBe(A.cols['Complete'].id);
		expect(row.completedAt).toBe(completedAt);
		expect(await figuresEverywhere()).toEqual(same({ done: 1, total: 2 }));
	});

	it('leaves the rename refusal counting archived cards, which a restore would put back', async () => {
		// S's Complete column with nothing in it but archived cards.
		db.update(cards).set({ archivedAt: ARCHIVED }).where(eq(cards.id, S.cards[0].id)).run();

		const res = await api('PUT', `/api/columns/${S.cols['Complete'].id}`, { user: owner, body: { title: 'Shipped' } });

		expect(res.status).toBe(409);
		expect(res.body.message).toMatch(/^This column holds 2 cards, all of them archived\./);
	});

	it('is counted by one helper, which every reader calls and none repeats', () => {
		const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
		// A function's source, from its declaration to the next export.
		const bodyOf = (source: string, name: string) => {
			const start = source.indexOf(`export function ${name}(`);
			expect(start, name).toBeGreaterThan(-1);
			const end = source.indexOf('\nexport ', start + 1);
			return source.slice(start, end === -1 ? undefined : end);
		};
		const completion = read('src/lib/server/card-completion.ts');
		const access = read('src/lib/server/list-access.ts');
		const readers: Record<string, string> = {
			getCompletionBlocker: bodyOf(completion, 'getCompletionBlocker'),
			hiddenOpenCountsFor: bodyOf(access, 'hiddenOpenCountsFor'),
			// The board page's load and its refresh, through their one reader (card 2280).
			'the board page': read('src/lib/server/board-contents.ts'),
			'the card context': read('src/routes/api/cards/[id]/context/+server.ts'),
			'the dashboard': read('src/routes/+page.server.ts')
		};

		expect(completion).toContain('export function subBoardProgress(');
		for (const [name, source] of Object.entries(readers)) {
			expect(source, name).toContain('subBoardProgress(');
			// None reads a sub-board's columns for itself.
			expect(source, name).not.toMatch(/eq\(columns\.boardId,\s*sb\.id\)/);
		}
		// The two server checks read no card or column at all: the helper does.
		for (const name of ['getCompletionBlocker', 'hiddenOpenCountsFor']) {
			expect(readers[name], name).not.toMatch(/\.from\((cards|columns)\)/);
		}
	});
});
