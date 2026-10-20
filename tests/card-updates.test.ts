/**
 * A card update records and announces only what it changed (card 2183).
 *
 * Both card update handlers, `PUT /api/cards/:id` and `PUT /api/v1/cards/:cardId`,
 * wrote every field the body named. The card window sends a card's whole
 * state back on every save, so a save that changed nothing wrote the row,
 * moved `updated_at`, recorded "Updated fields: title, description, priority,
 * colorTag, categoryId, dueDate, summary, theme, customerImpact, closeReason,
 * releaseState", sent `card.updated` to the board's webhooks and an `update`
 * event to its pages, and put the card in the activity report as touched by
 * whoever pressed Save. Each handler now compares the fields, as they will
 * be written, with the card as it stands (`src/lib/server/card-changes.ts`),
 * and writes, names and announces only those that differ; a request that
 * changes nothing does none of it and is answered with the card.
 *
 * Also here, because they are the same route: the body All Tasks sends with
 * the reporting fields (card 2186), a subtask saved from its window without a
 * colour (card 2185), and what the update takes as a clear of a business value
 * and an on-hold note, which the card window relies on (card 2200, test B3).
 *
 * The plan is `docs/planning/cards-2183-2184-2185-2186-pages-2.md` (decisions
 * 1 to 4, section 6, and B.6).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { activityLog, cards, categories, subtasks, type Card } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { onTheWire } from '$lib/server/v1-json';
import { api, type ApiResult } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import {
	addBoardMember,
	makeBoard,
	makeCard,
	makeMilestone,
	makeSubtask,
	makeUser,
	makeWebhook,
	resetDb,
	type BoardFixture
} from './helpers/fixtures';
import { diffSnapshots, expectUnchanged, snapshotDb } from './helpers/snapshot';

const STAMP = '2020-01-01 00:00:00';

let owner: SessionUser;
let viewer: SessionUser;
let A: BoardFixture;
let B: BoardFixture;
let sent: Effects;

beforeEach(() => {
	resetDb();
	owner = makeUser({ username: 'owner' });
	viewer = makeUser({ username: 'viewer' });
	A = makeBoard({ owner, name: 'A' });
	B = makeBoard({ owner, name: 'B' });
	addBoardMember(A.board, viewer, 'viewer');
	makeWebhook(A.board);
	sent = effects();
});
afterEach(() => sent.restore());

const cardRow = (id: number) => db.select().from(cards).where(eq(cards.id, id)).get()!;
const entries = () => db.select().from(activityLog).all();
/** The row as a route answers it: through JSON. */
/**
 * A row as `path` answers it: as stored from the internal tree, and with each
 * stored timestamp in ISO 8601 from the v1 API (card 2095, plan R1). The
 * internal tree adds `leftMilestone`, null for an update that moves the card
 * to no other board (card 2155, the review's O3).
 */
const asAnswered = (row: Card, path: string) => {
	const copy = JSON.parse(JSON.stringify(row));
	return path.startsWith('/api/v1/') ? onTheWire(copy) : { ...copy, leftMilestone: null };
};

const category = (board: BoardFixture, name: string) =>
	db.insert(categories).values({ boardId: board.board.id, name }).returning().get();

/** A card on A holding a value in every field an update takes, last changed long ago, in a milestone of A. */
function fullCard(): Card {
	const filed = category(A, 'Filed');
	const card = makeCard(A.cols['To Do'], {
		title: 'Full',
		description: 'What it is',
		priority: 'high',
		colorTag: '#ef4444',
		categoryId: filed.id,
		dueDate: '2026-11-01',
		onHoldNote: 'waiting on X',
		businessValue: 'Saves an hour a day',
		pinned: true,
		position: 2,
		coverUrl: '#3b82f6',
		summary: 'Plain words for the report',
		theme: 'maintenance',
		customerImpact: 'live customers: Quickline',
		closeReason: 'delivered',
		releaseState: 'live',
		updatedAt: STAMP
	});
	makeMilestone({ board: A.board, name: 'Current', createdBy: owner, cards: [card] });
	return cardRow(card.id);
}

/** Every field `PUT /api/cards/:id` writes, at the value `card` holds. */
const internalBody = (card: Card) => ({
	title: card.title,
	description: card.description,
	priority: card.priority,
	colorTag: card.colorTag,
	categoryId: card.categoryId,
	dueDate: card.dueDate,
	onHoldNote: card.onHoldNote,
	businessValue: card.businessValue,
	pinned: card.pinned,
	position: card.position,
	coverUrl: card.coverUrl,
	summary: card.summary,
	theme: card.theme,
	customerImpact: card.customerImpact,
	closeReason: card.closeReason,
	releaseState: card.releaseState,
	columnId: card.columnId,
	boardId: A.board.id
});

/** Every field `PUT /api/v1/cards/:cardId` writes, at the value `card` holds; `archivedAt: null` on a card that is not archived. */
const v1Body = (card: Card) => {
	const { position: _position, columnId: _columnId, boardId: _boardId, ...rest } = internalBody(card);
	return { ...rest, milestoneId: card.milestoneId, archivedAt: null };
};

/**
 * What the card window sends for a saved card, through `saveCard` of
 * `src/lib/board/card-actions.ts`, as Q-F left it: no colour tag (card 2147),
 * the note and the business value because the card holds them, and the
 * reporting fields as text or null.
 */
const windowBody = (card: Card) => ({
	title: card.title,
	description: card.description,
	priority: card.priority,
	categoryId: card.categoryId,
	dueDate: card.dueDate || null,
	onHoldNote: card.onHoldNote || undefined,
	businessValue: card.businessValue || undefined,
	summary: card.summary || null,
	theme: card.theme || null,
	customerImpact: card.customerImpact || null,
	closeReason: card.closeReason || null,
	releaseState: card.releaseState || null,
	boardId: A.board.id
});

/**
 * The body All Tasks' own `saveCard` sent, with the five reporting fields of
 * card 2186: every field, changed or not. Since card 2281's slice C3a-1 the
 * page sends only the fields changed in the window, through the card
 * window's controller; the route is still held to a body of every field
 * here, which other callers of the API may send.
 */
const allTasksBody = (card: Card, over: Record<string, unknown> = {}) => ({
	title: card.title,
	description: card.description,
	priority: card.priority,
	categoryId: card.categoryId,
	dueDate: card.dueDate,
	onHoldNote: card.onHoldNote || '',
	businessValue: card.businessValue || '',
	boardId: A.board.id,
	summary: card.summary,
	theme: card.theme,
	customerImpact: card.customerImpact,
	closeReason: card.closeReason,
	releaseState: card.releaseState,
	...over
});

const TREES = [
	{ tree: 'PUT /api/cards/:id', path: (id: number) => `/api/cards/${id}`, body: internalBody, updated: 'card_updated' },
	{ tree: 'PUT /api/v1/cards/:cardId', path: (id: number) => `/api/v1/cards/${id}`, body: v1Body, updated: 'api:card_updated' }
] as const;

/** Sends `body`, and waits for whatever it set off. */
async function put(path: string, body: unknown, user: SessionUser = owner): Promise<ApiResult & { path: string }> {
	const res = await api('PUT', path, { user, body });
	await sent.settle();
	return Object.assign(res, { path });
}

/** 200 with the card as stored, nothing in the database changed, and nothing sent. */
function expectNothingDone(res: ApiResult & { path: string }, card: Card, before: ReturnType<typeof snapshotDb>) {
	expect(res.status).toBe(200);
	expect(res.body).toEqual(asAnswered(card, res.path));
	expectUnchanged(before);
	expect(sent.all).toEqual([]);
}

describe.each(TREES)('$tree: a save that changes nothing (card 2183)', ({ path, body }) => {
	it('writes nothing, records nothing and sends nothing when every field is sent at its stored value', async () => {
		const card = fullCard();
		const before = snapshotDb();

		expectNothingDone(await put(path(card.id), body(card)), card, before);
	});

	it('takes null and empty text as the same value, either way round', async () => {
		// Stored empty as null, sent as empty text.
		const bare = makeCard(A.cols['To Do'], { title: 'Bare', description: null, onHoldNote: null, businessValue: null, colorTag: null, updatedAt: STAMP });
		// Stored empty as empty text, sent as null: the fields that take null.
		const blank = makeCard(A.cols['To Do'], {
			title: 'Blank',
			dueDate: '',
			coverUrl: '',
			summary: '',
			theme: '',
			customerImpact: '',
			closeReason: '',
			releaseState: '',
			updatedAt: STAMP
		});
		const before = snapshotDb();

		expectNothingDone(await put(path(bare.id), { description: '', onHoldNote: '', businessValue: '', colorTag: '' }), cardRow(bare.id), before);
		const nulls = { dueDate: null, coverUrl: null, summary: null, theme: null, customerImpact: null, closeReason: null, releaseState: null };
		expectNothingDone(await put(path(blank.id), nulls), cardRow(blank.id), before);
	});

	it('takes a reporting value in another spelling as the value stored', async () => {
		const card = fullCard();
		const before = snapshotDb();

		const res = await put(path(card.id), { theme: 'Maintenance', releaseState: 'LIVE', closeReason: ' Delivered ', customerImpact: 'Live Customers: Quickline' });

		expectNothingDone(res, card, before);
	});

	it('refuses an unchanged body from a viewer, 403, with nothing written', async () => {
		const card = fullCard();
		const before = snapshotDb();

		const res = await put(path(card.id), body(card), viewer);

		expect(res.status).toBe(403);
		expectUnchanged(before);
		expect(sent.all).toEqual([]);
	});
});

describe.each(TREES)('$tree: a save that changes one field among many (card 2183)', ({ path, body, updated }) => {
	it('writes, names and announces that field alone', async () => {
		const card = fullCard();
		const before = snapshotDb();

		const res = await put(path(card.id), { ...body(card), theme: 'new capability' });

		expect(res.status).toBe(200);
		const after = cardRow(card.id);
		expect(after.updatedAt).not.toBe(STAMP);
		expect(after).toEqual({ ...card, theme: 'new capability', updatedAt: after.updatedAt });
		expect(res.body).toEqual(asAnswered(after, path(card.id)));
		// The card and its one entry: nothing else in the database moved.
		const changed = diffSnapshots(before, snapshotDb());
		expect(changed.filter((line) => line.startsWith('cards:'))).toEqual([
			expect.stringMatching(/^cards: row \d+ changed \(updated_at: "2020-01-01 00:00:00" became "\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"; theme: "maintenance" became "new capability"\)$/)
		]);
		expect(changed.filter((line) => !/^(cards|activity_log|sqlite_sequence):/.test(line))).toEqual([]);

		const detail = 'Updated fields: theme on "Full"';
		expect(entries().map((e) => [e.action, e.detail])).toEqual([[updated, detail]]);
		expect(sent.webhooks.map((w) => [w.event, w.body.data.detail])).toEqual([['card.updated', detail]]);
		expect(sent.events.map((e) => e.event)).toEqual(['update']);
	});
});

describe('PUT /api/cards/:id: the card window and a move (card 2183)', () => {
	it('writes nothing for the card window’s own body when nothing in it was changed', async () => {
		const card = fullCard();
		const before = snapshotDb();

		expectNothingDone(await put(`/api/cards/${card.id}`, windowBody(card)), card, before);
	});

	it('records a move with nothing else changed as the move, with no card_updated', async () => {
		const card = fullCard();

		const res = await put(`/api/cards/${card.id}`, { ...windowBody(card), columnId: A.cols['In Progress'].id });

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ id: card.id, columnId: A.cols['In Progress'].id });
		expect(entries().map((e) => e.action)).toEqual(['card_moved']);
		expect(sent.webhooks.map((w) => w.event)).toEqual(['card.moved']);
		expect(sent.events.map((e) => e.event)).toEqual(['update']);
	});

	it('on a move to another board, lets the move clear the category sent back, and writes one of the new board sent with it', async () => {
		// The category sent back is not written over the move's clearing (card
		// 2117's rule, "the move decides"), and is not named: compared with the
		// moved row, nothing else was changed.
		const card = fullCard();
		const res = await put(`/api/cards/${card.id}`, { ...windowBody(card), columnId: B.cols['To Do'].id });

		expect(res.status).toBe(200);
		expect(cardRow(card.id)).toMatchObject({ columnId: B.cols['To Do'].id, categoryId: null });
		expect(entries().map((e) => e.action)).toEqual(['card_moved_away', 'card_moved_in']);

		// Another card, sent a category of B with the move: written and named.
		const other = makeCard(A.cols['To Do'], { title: 'Other', categoryId: category(A, 'Of A').id });
		const ofB = category(B, 'Of B');
		const moved = await put(`/api/cards/${other.id}`, { columnId: B.cols['To Do'].id, categoryId: ofB.id });

		expect(moved.status).toBe(200);
		expect(cardRow(other.id).categoryId).toBe(ofB.id);
		expect(entries().at(-1)).toMatchObject({ action: 'card_updated', detail: 'Updated fields: categoryId on "Other"' });
	});

	// Card 2288: a change of position within the column is not an edit to the
	// card, as a drag and the v1 move already hold. It was written with a new
	// `updatedAt`, recorded as "Updated fields: position" and sent
	// `card.updated` to the board's webhook (made in `beforeEach`). Now it goes
	// through the drag's path: the position alone, and the drag's live update.
	it('writes a change of position within the column alone, as a drag does: no entry, no card.updated', async () => {
		const card = fullCard();

		const res = await put(`/api/cards/${card.id}`, { position: 9 });

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ id: card.id, position: 9, updatedAt: STAMP });
		expect(cardRow(card.id)).toEqual({ ...card, position: 9 });
		expect(entries()).toEqual([]);
		expect(sent.webhooks).toEqual([]);
		expect(sent.events.map((e) => ({ event: e.event, data: e.data }))).toEqual([
			{ event: 'update', data: { type: 'card', action: 'reorder', userName: 'owner', userEmoji: '👤' } }
		]);
	});

	it('writes a change of position with another field, and names and announces the other field alone', async () => {
		const card = fullCard();

		const res = await put(`/api/cards/${card.id}`, { position: 9, title: 'Renamed' });

		expect(res.status).toBe(200);
		expect(cardRow(card.id)).toMatchObject({ position: 9, title: 'Renamed' });
		const detail = 'Updated fields: title on "Renamed"';
		expect(entries().map((e) => [e.action, e.detail])).toEqual([['card_updated', detail]]);
		expect(sent.webhooks.map((w) => [w.event, w.body.data.detail])).toEqual([['card.updated', detail]]);
	});
});

describe('PUT /api/v1/cards/:cardId: the milestone and an empty body (card 2183)', () => {
	it('writes nothing for the milestone the card is in, sent back, even one the caller could not now put a card in', async () => {
		const card = fullCard();
		// A milestone of a board the owner of A cannot open; the card was put in it by someone who could.
		const stranger = makeUser({ username: 'stranger' });
		const hidden = makeMilestone({ board: makeBoard({ owner: stranger, name: 'Hidden' }).board, name: 'Hidden', createdBy: stranger });
		const held = makeCard(A.cols['To Do'], { title: 'Held', milestoneId: hidden.id, updatedAt: STAMP });
		const before = snapshotDb();

		expectNothingDone(await put(`/api/v1/cards/${card.id}`, { milestoneId: card.milestoneId }), card, before);
		expectNothingDone(await put(`/api/v1/cards/${held.id}`, { milestoneId: hidden.id, title: 'Held' }), cardRow(held.id), before);
	});

	// Card 2289, decision 9: a card put in a milestone, or taken out, through
	// the card update writes the goal's own entry, as every other route does,
	// in place of naming `milestoneId` in `card_updated`; so `card.updated` is
	// no longer sent (the board's webhook, made in `beforeEach`, takes every
	// event) when the milestone is the only change.
	it('records a milestone alone as api:milestone_card_added, with no api:card_updated and no card.updated', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Loose', updatedAt: STAMP });
		const goal = makeMilestone({ board: A.board, name: 'Launch', createdBy: owner });

		const res = await put(`/api/v1/cards/${card.id}`, { milestoneId: goal.id });

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ id: card.id, milestoneId: goal.id });
		expect(cardRow(card.id).milestoneId).toBe(goal.id);
		expect(entries().map((e) => [e.action, e.cardId, e.detail])).toEqual([['api:milestone_card_added', card.id, 'Added "Loose" to milestone "Launch"']]);
		expect(sent.webhooks).toEqual([]);
		expect(sent.events.map((e) => ({ event: e.event, data: e.data }))).toEqual([{ event: 'update', data: { type: 'card' } }]);
	});

	it('records a milestone taken out with a title as api:milestone_card_removed and api:card_updated naming the title alone', async () => {
		const card = fullCard();

		const res = await put(`/api/v1/cards/${card.id}`, { milestoneId: null, title: 'Renamed' });

		expect(res.status).toBe(200);
		expect(cardRow(card.id)).toMatchObject({ milestoneId: null, title: 'Renamed' });
		const detail = 'Updated fields: title on "Renamed"';
		expect(entries().map((e) => [e.action, e.detail])).toEqual([
			['api:milestone_card_removed', 'Removed "Renamed" from milestone "Current"'],
			['api:card_updated', detail]
		]);
		expect(sent.webhooks.map((w) => [w.event, w.body.data.detail])).toEqual([['card.updated', detail]]);
		expect(sent.events.map((e) => e.event)).toEqual(['update']);
	});

	it('still answers 400 No valid fields to update for {}', async () => {
		const card = fullCard();
		const before = snapshotDb();

		const res = await put(`/api/v1/cards/${card.id}`, {});

		expect(res.status).toBe(400);
		expect(res.body.message).toBe('No valid fields to update');
		expectUnchanged(before);
	});
});

describe('PUT /api/cards/:id with All Tasks’ body (card 2186)', () => {
	it('stores and names an edited summary alone, clears a theme sent as null, and writes nothing when nothing was edited', async () => {
		const card = fullCard();
		const before = snapshotDb();

		expectNothingDone(await put(`/api/cards/${card.id}`, allTasksBody(card)), card, before);

		await put(`/api/cards/${card.id}`, allTasksBody(card, { summary: 'Better words' }));
		expect(cardRow(card.id).summary).toBe('Better words');
		expect(entries().map((e) => e.detail)).toEqual(['Updated fields: summary on "Full"']);

		await put(`/api/cards/${card.id}`, allTasksBody(cardRow(card.id), { theme: null }));
		expect(cardRow(card.id).theme).toBeNull();
		expect(entries().map((e) => e.detail).at(-1)).toBe('Updated fields: theme on "Full"');
	});
});

describe('PUT /api/subtasks/:id with the subtask window’s payload (card 2185)', () => {
	it('keeps the colour a subtask holds when the window sends none', async () => {
		const card = fullCard();
		const step = makeSubtask(card, { title: 'Step', colorTag: '#ef4444' });

		const res = await put(`/api/subtasks/${step.id}`, {
			title: 'Step, renamed',
			description: '',
			priority: 'medium',
			dueDate: null,
			completed: false,
			boardId: A.board.id
		});

		expect(res.status).toBe(200);
		expect(db.select().from(subtasks).where(eq(subtasks.id, step.id)).get()).toMatchObject({ title: 'Step, renamed', colorTag: '#ef4444' });
	});
});

describe('PUT /api/cards/:id clears a business value and an on-hold note sent as empty text (card 2200, B3)', () => {
	it('stores empty text for both and names the two, and refuses null for the business value', async () => {
		const card = fullCard();

		const cleared = await put(`/api/cards/${card.id}`, { businessValue: '', onHoldNote: '' });

		expect(cleared.status).toBe(200);
		expect(cardRow(card.id)).toMatchObject({ businessValue: '', onHoldNote: '' });
		expect(entries().map((e) => e.detail)).toEqual(['Updated fields: onHoldNote, businessValue on "Full"']);

		// The card window sends empty text to clear, never null: the route refuses null for these.
		const other = makeCard(A.cols['To Do'], { title: 'Valued', businessValue: 'Worth it' });
		const before = snapshotDb();
		const refused = await put(`/api/cards/${other.id}`, { businessValue: null });

		expect(refused.status).toBe(400);
		expect(refused.body.message).toBe('businessValue must be text');
		expectUnchanged(before);
	});
});
