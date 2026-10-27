/**
 * Archiving or deleting an option is a discard (milestone 22, card 2461,
 * slice S3).
 *
 * A card in an upstream column, the board's Options column or any column of
 * an ideas board, is an option. Archiving it discards it: `discarded_at` and
 * `discarded_by` are stamped with `archived_at`, and `card_discarded` is
 * written in place of `card_archived`, sending `card.discarded`. Deleting one
 * writes `card_discarded` before `card_deleted`, unless it was discarded
 * already. A restore clears the mark and says the card is back among the
 * options. Committed work archived before it was finished is abandoned,
 * `card_abandoned`, in the activity log alone (ruling f). Deleting a column or
 * a board, clearing a board and purging the archive discard nothing
 * (decision M22-9).
 *
 * Every archive, delete and restore goes through `archiveCard` and
 * `deleteCard` in `$lib/server/deletes` and `restoreCard` in
 * `$lib/server/card-restore`, so each route is held to the same, with the
 * stored mark read back after each and the start-up repair asked to find
 * nothing to clear after it (`discardedCleared`, ruling t): a non-zero count
 * there means a route left a live card marked. The routes: the page's and
 * v1's `DELETE /cards/:id`, each with `?permanent=true`; the board page's bulk
 * archive, which sends the page's one card at a time; and the three restores,
 * `POST /api/cards/:id/restore` (All Tasks, the Archived page),
 * `POST /api/boards/:id/archive` (the board's Archived Cards) and v1's
 * `PUT /cards/:cardId` with `archivedAt: null`.
 *
 * Then `upstreamFigures` in `$lib/server/upstream`: each card counted once in
 * a window, under its last act (ruling c), the discard rate, and the options
 * held now with their aging (ruling g, the S1b review's B2).
 *
 * The plan is `docs/planning/milestone-22-upstream-kanban.md`, section 3's
 * card C and section 7.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { runBackfills } from '$lib/server/db/migrate';
import { activityLog, boards, cards, columns, type Card, type Column } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { stamp } from '$lib/timestamps';
import { conversionSuffix, upstreamFigures } from '$lib/server/upstream';
import { bulkDelete } from '$lib/board/bulk-actions';
import { api, type ApiResult } from './helpers/api';
import { pageLoad } from './helpers/actions';
import { readBudget } from './helpers/reads';
import { effects, type Effects } from './helpers/effects';
import { addBoardMember, makeBoard, makeCard, makeUser, makeWebhook, resetDb, type BoardFixture } from './helpers/fixtures';

/** When every card here was made, long before anything is done to it. */
const OLD = '2026-01-05 09:00:00';

let owner: SessionUser;
let member: SessionUser;
/** Delivery board A, with its Options column (card 2527); ideas board I. Each has a webhook for every event. */
let A: BoardFixture;
let I: BoardFixture;
let sent: Effects;

beforeEach(() => {
	resetDb();
	owner = makeUser({ username: 'owner' });
	member = makeUser({ username: 'member' });
	A = makeBoard({ owner, name: 'A', options: true, columns: ['To Do', 'In Progress', 'Complete'] });
	I = makeBoard({ owner, name: 'I', columns: ['New Ideas', 'Shaping'] });
	db.update(boards).set({ kind: 'ideas' }).where(eq(boards.id, I.board.id)).run();
	for (const board of [A, I]) {
		addBoardMember(board.board, member, 'editor');
		makeWebhook(board.board, { url: `https://hooks.example.test/${board.board.name}` });
	}
	sent = effects();
});
afterEach(() => {
	sent.restore();
	vi.unstubAllGlobals();
});

const cardIn = (column: Column, title: string, opts: Partial<typeof cards.$inferInsert> = {}) =>
	makeCard(column, { title, createdAt: OLD, updatedAt: OLD, createdBy: owner.id, ...opts });

/** What the card holds of its archive and its discard. */
const markOf = (card: Card) => {
	const row = db.select().from(cards).where(eq(cards.id, card.id)).get()!;
	return { archivedAt: row.archivedAt, discardedAt: row.discardedAt, discardedBy: row.discardedBy };
};

/** Every entry on the board, oldest first: the stored action, the card id and the detail. */
const entriesOn = (board: BoardFixture) =>
	db
		.select()
		.from(activityLog)
		.where(eq(activityLog.boardId, board.board.id))
		.orderBy(activityLog.id)
		.all()
		.map((e) => [e.action, e.cardId, e.detail]);

/** The deliveries made, once settled: the event, data.action, data.cardId and data.detail. */
async function heard() {
	await sent.settle();
	expect(sent.duringTransaction).toEqual([]);
	return sent.webhooks.map((d) => [d.event, d.body.data.action, d.body.data.cardId, d.body.data.detail]);
}

/** The start-up repair finds nothing to clear or fill: every route kept the rules. */
function nothingToRepair() {
	expect(runBackfills(sqlite)).toMatchObject({ discardedCleared: 0, committedFilled: 0, upstreamCleared: 0 });
}

type Route = {
	name: string;
	/** The prefix the route's entries are stored with. */
	prefix: '' | 'api:';
	archive: (card: Card) => Promise<ApiResult>;
	remove: (card: Card) => Promise<ApiResult>;
};

const ROUTES: Route[] = [
	{
		name: 'the page (DELETE /api/cards/:id), which the card window, the card menu and the bulk archive send',
		prefix: '',
		archive: (card) => api('DELETE', `/api/cards/${card.id}`, { user: member }),
		remove: (card) => api('DELETE', `/api/cards/${card.id}?permanent=true`, { user: member })
	},
	{
		name: 'v1 (DELETE /api/v1/cards/:cardId)',
		prefix: 'api:',
		archive: (card) => api('DELETE', `/api/v1/cards/${card.id}`, { user: member }),
		remove: (card) => api('DELETE', `/api/v1/cards/${card.id}?permanent=true`, { user: member })
	}
];

describe.each(ROUTES)('through $name', ({ prefix, archive, remove }) => {
	it('archiving an option in the Options column discards it: archived and discarded at once, by the archiver, with card_discarded in place of card_archived, and card.discarded', async () => {
		const option = cardIn(A.cols['Options'], 'An option');
		const before = stamp();

		expect((await archive(option)).status).toBe(200);

		const mark = markOf(option);
		expect(mark.archivedAt! >= before).toBe(true);
		expect(mark).toEqual({ archivedAt: mark.archivedAt, discardedAt: mark.archivedAt, discardedBy: member.id });
		expect(entriesOn(A)).toEqual([[`${prefix}card_discarded`, option.id, '"An option": discarded from Options']]);
		expect(await heard()).toEqual([['card.discarded', 'card_discarded', option.id, '"An option": discarded from Options']]);
		// Still an option: a discard is not a commitment.
		expect(db.select().from(cards).where(eq(cards.id, option.id)).get()!.committedAt).toBeNull();
		nothingToRepair();
	});

	it('archiving a card on an ideas board discards it too: every column there is upstream', async () => {
		const idea = cardIn(I.cols['Shaping'], 'An idea');

		expect((await archive(idea)).status).toBe(200);

		expect(markOf(idea)).toMatchObject({ discardedBy: member.id });
		expect(markOf(idea).discardedAt).toBe(markOf(idea).archivedAt);
		expect(entriesOn(I)).toEqual([[`${prefix}card_discarded`, idea.id, '"An idea": discarded from Shaping']]);
		expect(await heard()).toEqual([['card.discarded', 'card_discarded', idea.id, '"An idea": discarded from Shaping']]);
		nothingToRepair();
	});

	it('archiving committed work that is not finished abandons it: card_abandoned, no mark on the card, and no webhook (ruling f)', async () => {
		const todo = cardIn(A.cols['To Do'], 'Not started');
		const doing = cardIn(A.cols['In Progress'], 'Half done');

		expect((await archive(todo)).status).toBe(200);
		expect((await archive(doing)).status).toBe(200);

		for (const card of [todo, doing]) expect(markOf(card)).toMatchObject({ discardedAt: null, discardedBy: null });
		expect(markOf(todo).archivedAt).not.toBeNull();
		expect(entriesOn(A)).toEqual([
			[`${prefix}card_abandoned`, todo.id, '"Not started": archived unfinished, from To Do'],
			[`${prefix}card_abandoned`, doing.id, '"Half done": archived unfinished, from In Progress']
		]);
		expect(await heard()).toEqual([]);
		nothingToRepair();
	});

	it('archiving finished work is card_archived, as before, with no mark and no webhook', async () => {
		const done = cardIn(A.cols['Complete'], 'Shipped', { completedAt: OLD, firstCompletedAt: OLD });

		expect((await archive(done)).status).toBe(200);

		expect(markOf(done)).toMatchObject({ discardedAt: null, discardedBy: null });
		expect(entriesOn(A)).toEqual([[`${prefix}card_archived`, done.id, '"Shipped"']]);
		expect(await heard()).toEqual([]);
		nothingToRepair();
	});

	it('archiving a discarded card again writes nothing: the first discard and its time are kept (card 2285)', async () => {
		const option = cardIn(A.cols['Options'], 'An option');
		expect((await archive(option)).status).toBe(200);
		const first = markOf(option);
		sent.clear();

		expect((await archive(option)).status).toBe(200);

		expect(markOf(option)).toEqual(first);
		expect(entriesOn(A)).toHaveLength(1);
		expect(await heard()).toEqual([]);
		nothingToRepair();
	});

	it('deleting an option writes card_discarded and then card_deleted, both with no card id, and sends card.discarded then card.deleted naming the card', async () => {
		const option = cardIn(A.cols['Options'], 'An option');

		expect((await remove(option)).status).toBe(200);

		expect(db.select().from(cards).where(eq(cards.id, option.id)).get()).toBeUndefined();
		expect(entriesOn(A)).toEqual([
			[`${prefix}card_discarded`, null, '"An option": deleted from Options'],
			[`${prefix}card_deleted`, null, '"An option"']
		]);
		expect(await heard()).toEqual([
			['card.discarded', 'card_discarded', option.id, '"An option": deleted from Options'],
			['card.deleted', 'card_deleted', option.id, '"An option"']
		]);
		nothingToRepair();
	});

	it('deleting a card discarded already, archived from upstream, writes only card_deleted: it was discarded once', async () => {
		const option = cardIn(A.cols['Options'], 'An option');
		expect((await archive(option)).status).toBe(200);
		sent.clear();

		expect((await remove(option)).status).toBe(200);

		expect(entriesOn(A)).toEqual([
			// The discard's entry lost its card id with the card, as every entry of a deleted card does.
			[`${prefix}card_discarded`, null, '"An option": discarded from Options'],
			[`${prefix}card_deleted`, null, '"An option"']
		]);
		expect(await heard()).toEqual([['card.deleted', 'card_deleted', option.id, '"An option"']]);
		nothingToRepair();
	});

	it('deleting committed work writes only card_deleted, as before', async () => {
		const work = cardIn(A.cols['To Do'], 'Work');

		expect((await remove(work)).status).toBe(200);

		expect(entriesOn(A)).toEqual([[`${prefix}card_deleted`, null, '"Work"']]);
		expect(await heard()).toEqual([['card.deleted', 'card_deleted', work.id, '"Work"']]);
		nothingToRepair();
	});

	it('deleting a card archived as committed work, in a column that is the Options column since, is no discard: it had left play (the S3 review’s E2)', async () => {
		// The conversion that did this went before release (card 2527); a column
		// given the role in the database, as a backup or dev data can hold, is
		// the one way left, and the rule is the delete's all the same.
		const B = makeBoard({ owner, name: 'B', columns: ['Options', 'To Do', 'Complete'] });
		addBoardMember(B.board, member, 'editor');
		makeWebhook(B.board, { url: 'https://hooks.example.test/B' });
		const first = cardIn(B.cols['Options'], 'First');
		const second = cardIn(B.cols['Options'], 'Second');
		for (const card of [first, second]) expect((await archive(card)).status).toBe(200);
		db.update(columns).set({ role: 'options', position: -1 }).where(eq(columns.id, B.cols['Options'].id)).run();
		// Its cards are options now, as the conversion left them.
		db.update(cards).set({ committedAt: null, committedBy: null }).where(eq(cards.columnId, B.cols['Options'].id)).run();
		sent.clear();

		expect((await remove(first)).status).toBe(200);

		expect(entriesOn(B).filter(([action]) => String(action).endsWith('card_discarded') || String(action).endsWith('card_deleted'))).toEqual([
			[`${prefix}card_deleted`, null, '"First"']
		]);
		expect(await heard()).toEqual([['card.deleted', 'card_deleted', first.id, '"First"']]);
		expect(upstreamFigures([B.board.id], '2026-01-01', '2099-12-31')).toMatchObject({ discarded: 0, abandoned: 2 });
		nothingToRepair();
	});

	it('on a board with no Options column: To Do archived is card_abandoned, Done card_archived, and no webhook either way (the S3 review’s E9)', async () => {
		const plain = makeBoard({ owner, name: 'Plain', columns: ['To Do', 'Doing', 'Done'] });
		addBoardMember(plain.board, member, 'editor');
		makeWebhook(plain.board, { url: 'https://hooks.example.test/Plain' });
		const todo = cardIn(plain.cols['To Do'], 'Waiting');
		const done = cardIn(plain.cols['Done'], 'Finished', { completedAt: OLD, firstCompletedAt: OLD });

		expect((await archive(todo)).status).toBe(200);
		expect((await archive(done)).status).toBe(200);

		expect(entriesOn(plain)).toEqual([
			[`${prefix}card_abandoned`, todo.id, '"Waiting": archived unfinished, from To Do'],
			[`${prefix}card_archived`, done.id, '"Finished"']
		]);
		for (const card of [todo, done]) expect(markOf(card)).toMatchObject({ discardedAt: null, discardedBy: null });
		expect(await heard()).toEqual([]);
		nothingToRepair();
	});
});

const RESTORES: { name: string; prefix: '' | 'api:'; restore: (card: Card) => Promise<ApiResult> }[] = [
	{
		name: 'POST /api/cards/:id/restore (All Tasks, the Archived page)',
		prefix: '',
		restore: (card) => api('POST', `/api/cards/${card.id}/restore`, { user: member })
	},
	{
		name: "POST /api/boards/:id/archive (the board's Archived Cards)",
		prefix: '',
		restore: (card) => api('POST', `/api/boards/${A.board.id}/archive`, { user: member, body: { cardId: card.id } })
	},
	{
		name: 'v1 PUT /api/v1/cards/:cardId with archivedAt: null',
		prefix: 'api:',
		restore: (card) => api('PUT', `/api/v1/cards/${card.id}`, { user: member, body: { archivedAt: null } })
	}
];

describe.each(RESTORES)('a restore through $name', ({ prefix, restore }) => {
	it('clears the discard mark with the archive, leaves the card an option in its column, and says it is back there', async () => {
		const option = cardIn(A.cols['Options'], 'An option');
		expect((await api('DELETE', `/api/cards/${option.id}`, { user: owner })).status).toBe(200);
		sent.clear();

		const res = await restore(option);

		expect(res.status).toBe(200);
		expect(markOf(option)).toEqual({ archivedAt: null, discardedAt: null, discardedBy: null });
		const row = db.select().from(cards).where(eq(cards.id, option.id)).get()!;
		expect([row.columnId, row.committedAt, row.committedBy]).toEqual([A.cols['Options'].id, null, null]);
		expect(entriesOn(A)).toEqual([
			['card_discarded', option.id, '"An option": discarded from Options'],
			[`${prefix}card_restored`, option.id, '"An option": back in Options']
		]);
		// A restore sends nothing, as before.
		expect(await heard()).toEqual([]);
		nothingToRepair();
	});

	it('restores abandoned work with a plain card_restored', async () => {
		const work = cardIn(A.cols['To Do'], 'Work');
		expect((await api('DELETE', `/api/cards/${work.id}`, { user: owner })).status).toBe(200);

		expect((await restore(work)).status).toBe(200);

		expect(markOf(work)).toEqual({ archivedAt: null, discardedAt: null, discardedBy: null });
		expect(entriesOn(A).at(-1)).toEqual([`${prefix}card_restored`, work.id, '"Work"']);
		nothingToRepair();
	});
});

describe('the other paths', () => {
	it("the board page's bulk archive, which sends each card in turn, discards each option and abandons the rest", async () => {
		const one = cardIn(A.cols['Options'], 'One');
		const two = cardIn(A.cols['Options'], 'Two');
		const work = cardIn(A.cols['To Do'], 'Work');
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			const res = await api(init.method as 'DELETE', url, { user: member, body: JSON.parse(String(init.body)) });
			return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
		});

		expect(await bulkDelete(new Set([one.id, work.id, two.id]), A.board.id)).toEqual({ archived: 3, failed: [] });

		for (const option of [one, two]) expect(markOf(option)).toMatchObject({ discardedBy: member.id });
		expect(markOf(work)).toMatchObject({ discardedAt: null });
		expect(entriesOn(A).map(([action, cardId]) => [action, cardId])).toEqual([
			['card_discarded', one.id],
			['card_abandoned', work.id],
			['card_discarded', two.id]
		]);
		expect((await heard()).map(([event, , cardId]) => [event, cardId])).toEqual([
			['card.discarded', one.id],
			['card.discarded', two.id]
		]);
		nothingToRepair();
	});

	it('deleting a column or a board, clearing a board and purging the archive discard nothing (decision M22-9)', async () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		// A delivery board's Options column is never deleted (card 2527); its
		// archived options go with its board, deleted below.
		cardIn(A.cols['Options'], 'Archived option', { archivedAt: OLD });
		// A column of an ideas board may go once it holds archived cards alone (card 2463, the S5a review's L2).
		cardIn(I.cols['New Ideas'], 'An archived idea', { archivedAt: OLD });
		const archivedIdea = cardIn(I.cols['Shaping'], 'Archived idea', { archivedAt: OLD });
		const other = makeBoard({ owner, name: 'Other', options: true, columns: ['To Do'] });
		cardIn(other.cols['Options'], 'Another option');

		expect((await api('DELETE', `/api/v1/columns/${I.cols['New Ideas'].id}`, { user: owner })).status).toBe(200);
		expect((await api('POST', '/api/admin/purge-archived', { user: admin })).status).toBe(200);
		expect(db.select().from(cards).where(eq(cards.id, archivedIdea.id)).get()).toBeUndefined();
		expect((await api('POST', `/api/admin/boards/${other.board.id}/clear-cards`, { user: admin })).status).toBe(200);
		cardIn(I.cols['Shaping'], 'Last idea');
		expect((await api('DELETE', `/api/boards/${I.board.id}`, { user: owner })).status).toBe(200);
		expect((await api('DELETE', `/api/v1/boards/${A.board.id}`, { user: owner })).status).toBe(200);

		expect(db.select().from(activityLog).all().filter((e) => e.action.endsWith('card_discarded'))).toEqual([]);
		expect((await heard()).filter(([event]) => event === 'card.discarded')).toEqual([]);
		nothingToRepair();
	});

	it("the three archive reads carry discardedAt: the board's Archived Cards, All Tasks' and the Archived page", async () => {
		const option = cardIn(A.cols['Options'], 'An option');
		const work = cardIn(A.cols['To Do'], 'Work');
		for (const card of [option, work]) expect((await api('DELETE', `/api/cards/${card.id}`, { user: owner })).status).toBe(200);
		const discardedAt = markOf(option).discardedAt;
		expect(discardedAt).not.toBeNull();
		const byTitle = (list: { title: string; discardedAt: string | null }[]) =>
			Object.fromEntries(list.map((card) => [card.title, card.discardedAt]));

		const board = await api('GET', `/api/boards/${A.board.id}/archive`, { user: member });
		const all = await api('GET', '/api/cards/archived', { user: member });
		const page = await pageLoad('/archived', { user: member });

		expect(byTitle(board.body)).toEqual({ 'An option': discardedAt, Work: null });
		expect(byTitle(all.body)).toEqual({ 'An option': discardedAt, Work: null });
		expect(page.type).toBe('data');
		expect(byTitle(page.type === 'data' ? page.data.archivedCards : [])).toEqual({ 'An option': discardedAt, Work: null });
	});
});

// ─── The figures ─────────────────────────────────────────────────────────────

/** An entry written at `at`, as the routes write them, without going through one. */
function entry(board: BoardFixture, action: string, at: string, cardId: number | null, detail = '') {
	db.insert(activityLog).values({ boardId: board.board.id, cardId, action, detail, createdAt: at, userName: '', userEmoji: '', source: 'ui' }).run();
}

/** Noon on 26 October 2026, for the options' ages. */
const NOW = Date.parse('2026-10-26T12:00:00Z');
const WINDOW = ['2026-10-01', '2026-10-31'] as const;
const figuresOf = (boardIds: number[]) => upstreamFigures(boardIds, ...WINDOW, NOW);

describe('upstreamFigures (rulings b, c, f and g)', () => {
	it('counts each card once, under its last upstream act in the window, both spellings alike; a return is a figure of its own; abandonment apart', () => {
		const once = cardIn(A.cols['To Do'], 'Committed once');
		const twice = cardIn(A.cols['To Do'], 'Committed, returned, committed');
		const back = cardIn(A.cols['Options'], 'Committed then returned');
		const dropped = cardIn(A.cols['Options'], 'Discarded', { archivedAt: '2026-10-09 09:00:00', discardedAt: '2026-10-09 09:00:00' });
		const left = cardIn(A.cols['To Do'], 'Committed then abandoned', { archivedAt: '2026-10-12 09:00:00' });
		const earlier = cardIn(A.cols['To Do'], 'Committed before the window');
		entry(A, 'card_committed', '2026-10-02 09:00:00', once.id);
		entry(A, 'card_committed', '2026-10-03 09:00:00', twice.id);
		entry(A, 'api:card_returned_to_options', '2026-10-04 09:00:00', twice.id);
		entry(A, 'api:card_committed', '2026-10-05 09:00:00', twice.id);
		entry(A, 'card_committed', '2026-10-06 09:00:00', back.id);
		entry(A, 'card_returned_to_options', '2026-10-07 09:00:00', back.id);
		entry(A, 'card_discarded', '2026-10-09 09:00:00', dropped.id);
		entry(A, 'card_committed', '2026-10-10 09:00:00', left.id);
		entry(A, 'card_abandoned', '2026-10-12 09:00:00', left.id);
		entry(A, 'card_committed', '2026-09-30 23:59:59', earlier.id);
		// Not an upstream act.
		entry(A, 'card_moved', '2026-10-11 09:00:00', once.id);

		expect(figuresOf([A.board.id])).toMatchObject({
			// Once, twice and left: left was committed and then abandoned, and counts as both (the S3 review's E1).
			committedFromOptions: 3,
			returnedToOptions: 1,
			discarded: 1,
			sentOn: 0,
			abandoned: 1,
			// 1 / (1 + 3 + 0): abandoned work is not in the rate.
			discardRate: 1 / 4
		});
	});

	it('counts a card committed and then abandoned as committed and as abandoned, and leaves the rate to commitments and discards (the S3 review’s E1)', () => {
		const left = cardIn(A.cols['To Do'], 'Committed then abandoned', { archivedAt: '2026-10-03 09:00:00' });
		const dropped = cardIn(A.cols['Options'], 'Discarded', { archivedAt: '2026-10-04 09:00:00', discardedAt: '2026-10-04 09:00:00' });
		entry(A, 'card_committed', '2026-10-02 09:00:00', left.id);
		entry(A, 'card_abandoned', '2026-10-03 09:00:00', left.id);
		entry(A, 'card_discarded', '2026-10-04 09:00:00', dropped.id);
		// Abandoned twice over (archived, restored, archived again) is one card.
		entry(A, 'api:card_abandoned', '2026-10-05 09:00:00', left.id);

		expect(figuresOf([A.board.id])).toMatchObject({ committedFromOptions: 1, abandoned: 1, discarded: 1, discardRate: 0.5 });
	});

	it('includes both ends of the window, as reports do: a bare date to the end of its day, a moment to the second (E4)', () => {
		const card = cardIn(A.cols['To Do'], 'Committed');
		const at = (moment: string) => entry(A, 'card_committed', moment, cardIn(A.cols['To Do'], moment).id);
		at('2026-09-30 23:59:59');
		at('2026-10-01 00:00:00');
		at('2026-10-31 23:59:59');
		at('2026-11-01 00:00:00');
		entry(A, 'card_committed', '2026-10-31 12:00:00', card.id);

		expect(figuresOf([A.board.id]).committedFromOptions).toBe(3);
		expect(upstreamFigures([A.board.id], '2026-10-01 00:00:00', '2026-10-31 23:59:59', NOW).committedFromOptions).toBe(3);
		// An end at noon leaves the evening out; a caller means the end of its day.
		expect(upstreamFigures([A.board.id], '2026-10-01', '2026-10-31 12:00:00', NOW).committedFromOptions).toBe(2);
	});

	it('reads the same four statements for one board as for twenty with options and an ideas board (the S3 review’s E3)', () => {
		const boardWithOptions = (name: string) => {
			const board = makeBoard({ owner, name, options: true, columns: ['To Do'] });
			cardIn(board.cols['Options'], `${name} idea`, { createdAt: '2026-09-01 12:00:00' });
			// A conversion entry from before card 2527, which the aging still reads.
			entry(board, 'column_converted_to_options', '2026-10-21 12:00:00', null, `1 card became an option${conversionSuffix(board.cols['Options'].id)}`);
			return board.board.id;
		};
		const reads = (boardIds: number[]) => {
			const budget = readBudget(1000);
			try {
				upstreamFigures(boardIds, ...WINDOW, NOW);
			} finally {
				budget.restore();
			}
			return budget.count;
		};
		const one = [boardWithOptions('One')];
		const many = [...Array.from({ length: 20 }, (_, i) => boardWithOptions(`Board ${i}`)), I.board.id];
		for (const column of ['New Ideas', 'Shaping']) cardIn(I.cols[column], `${column} idea`, { createdAt: '2026-10-26 12:00:00' });

		expect(reads(one)).toBe(4);
		expect(reads(many)).toBe(4);
		// And the ages are still each column's own: every card converted 5 days ago, the ideas board's made now.
		expect(upstreamFigures(many, ...WINDOW, NOW)).toMatchObject({ options: 22, oldestOptionDays: 5, agingOptions: 0 });
	});

	it('counts a discard later restored, as it happened; entries with no card id, a deleted card’s, each once', async () => {
		const restored = cardIn(A.cols['Options'], 'Discarded then restored');
		const deleted = cardIn(A.cols['Options'], 'Returned then deleted');
		const archive = (card: Card) => api('DELETE', `/api/cards/${card.id}`, { user: owner });
		expect((await archive(restored)).status).toBe(200);
		expect((await api('POST', `/api/cards/${restored.id}/restore`, { user: owner })).status).toBe(200);
		entry(A, 'card_returned_to_options', stamp(), deleted.id);
		expect((await api('DELETE', `/api/cards/${deleted.id}?permanent=true`, { user: owner })).status).toBe(200);

		// The deleted card's return and its discard lost their card id: two acts, each counted.
		expect(upstreamFigures([A.board.id], '2026-01-01', '2099-12-31', NOW)).toMatchObject({
			discarded: 2,
			returnedToOptions: 1,
			committedFromOptions: 0,
			discardRate: 1
		});
	});

	it('drops a Send into a board in scope, counts one out of it, and counts a deleted card’s, which cannot be paired (ruling b)', () => {
		const B = makeBoard({ owner, name: 'B', columns: ['Ideas', 'To Do'] });
		const kept = cardIn(B.cols['Ideas'], 'Sent to B');
		const away = cardIn(B.cols['Ideas'], 'Sent elsewhere');
		const at = '2026-10-15 09:00:00';
		entry(I, 'card_sent', at, kept.id);
		entry(B, 'card_moved_in', at, kept.id);
		entry(I, 'card_sent', at, away.id);
		entry(I, 'card_sent', at, null);

		expect(figuresOf([I.board.id])).toMatchObject({ sentOn: 3, discardRate: 0 });
		expect(figuresOf([I.board.id, B.board.id])).toMatchObject({ sentOn: 2 });
		// A move into B at another moment is not the Send's.
		entry(B, 'card_moved_in', '2026-10-15 09:00:01', away.id);
		expect(figuresOf([I.board.id, B.board.id])).toMatchObject({ sentOn: 2 });
	});

	it('answers no rate when nothing left upstream, and zeros for no boards; a window that cannot be read is thrown', () => {
		const left = cardIn(A.cols['To Do'], 'Abandoned', { archivedAt: '2026-10-12 09:00:00' });
		entry(A, 'card_abandoned', '2026-10-12 09:00:00', left.id);

		expect(figuresOf([A.board.id])).toMatchObject({ abandoned: 1, discardRate: null });
		expect(figuresOf([])).toEqual({
			options: 0,
			committedFromOptions: 0,
			returnedToOptions: 0,
			discarded: 0,
			sentOn: 0,
			abandoned: 0,
			discardRate: null,
			oldestOptionDays: null,
			agingOptions: 0
		});
		expect(() => upstreamFigures([A.board.id], 'last week', '2026-10-31')).toThrow('Not a window');
	});

	it('holds the options now, live ones in upstream columns alone, aged from the latest of creation, return and conversion (B2)', () => {
		// 55 days old, from its creation.
		cardIn(A.cols['Options'], 'Old', { createdAt: '2026-09-01 12:00:00' });
		// Made long ago, returned 10 days ago.
		const returned = cardIn(A.cols['Options'], 'Returned', { createdAt: '2026-01-01 12:00:00' });
		entry(A, 'card_returned_to_options', '2026-10-16 12:00:00', returned.id);
		// On the ideas board, 31 days old.
		cardIn(I.cols['New Ideas'], 'Idea', { createdAt: '2026-09-25 11:00:00' });
		// Not options now: archived, and committed work.
		cardIn(A.cols['Options'], 'Discarded', { createdAt: '2025-01-01 12:00:00', archivedAt: OLD, discardedAt: OLD });
		cardIn(A.cols['To Do'], 'Work', { createdAt: '2025-01-01 12:00:00' });

		expect(figuresOf([A.board.id, I.board.id])).toMatchObject({ options: 3, oldestOptionDays: 55, agingOptions: 2 });
		expect(figuresOf([I.board.id])).toMatchObject({ options: 1, oldestOptionDays: 31, agingOptions: 1 });

		// The column converted 5 days ago: every card in it is an option from then.
		entry(A, 'column_converted_to_options', '2026-10-21 12:00:00', null, `2 cards became options${conversionSuffix(A.cols['Options'].id)}`);
		expect(figuresOf([A.board.id])).toMatchObject({ options: 2, oldestOptionDays: 5, agingOptions: 0 });
	});

	it('agrees with the routes: an option committed, one returned, one discarded and work abandoned', async () => {
		const chosen = cardIn(A.cols['Options'], 'Chosen');
		const back = cardIn(A.cols['To Do'], 'Back');
		const dropped = cardIn(A.cols['Options'], 'Dropped');
		const left = cardIn(A.cols['In Progress'], 'Left');
		expect((await api('PUT', `/api/v1/cards/${chosen.id}/move`, { user: member, body: { columnId: A.cols['To Do'].id } })).status).toBe(200);
		expect((await api('PUT', `/api/v1/cards/${back.id}/move`, { user: member, body: { columnId: A.cols['Options'].id } })).status).toBe(200);
		expect((await api('DELETE', `/api/v1/cards/${dropped.id}`, { user: member })).status).toBe(200);
		expect((await api('DELETE', `/api/cards/${left.id}`, { user: member })).status).toBe(200);

		// A wide window, so that midnight passing during the test changes nothing.
		expect(upstreamFigures([A.board.id], '2026-01-01', '2099-12-31')).toMatchObject({
			options: 1,
			committedFromOptions: 1,
			returnedToOptions: 1,
			discarded: 1,
			abandoned: 1,
			discardRate: 0.5,
			oldestOptionDays: 0,
			agingOptions: 0
		});
	});
});
