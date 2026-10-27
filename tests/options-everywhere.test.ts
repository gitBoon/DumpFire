/**
 * Every delivery board has its Options column (card 2527, slice S1).
 *
 * The board's Options column (milestone 22, card 2459) was opt-in: added by
 * hand, or converted from a column holding cards. It is now a fixed part of
 * every delivery board, sub-boards included:
 *
 *   - made with the board, first of its five columns, in both trees, under a
 *     card and by the empty switch from an ideas board (rulings O1 and O2);
 *   - given by the start-up step, `runBackfills`, to every delivery board that
 *     has none, renamed Options where it is called anything else, put back at
 *     the far left, and kept once where a board somehow has two, at every
 *     start and after every restore (O3, R1 and R2);
 *   - never renamed, given away or deleted (O4), never made a second time and
 *     no other column called Options (O5), with a value sent back as it is
 *     changing nothing, in the order R4 gives;
 *   - deleted with the To Do, On Hold and Complete columns when an empty
 *     board's column holds nothing and it becomes an ideas board (O7);
 *   - never where new work goes when nobody chose its column (R5);
 *   - and the column conversion routes gone (O6).
 *
 * The rules it shares with milestone 22 (its place at the far left, its WIP
 * limit, the strip) are in tests/options-column.test.ts. The plan is
 * `docs/planning/2527-options-on-every-board.md`.
 */
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { columns, type Column } from '$lib/server/db/schema';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { runBackfills, runMigrations, type Backfill } from '$lib/server/db/migrate';
import { restoreFromBackup } from '$lib/server/db/restore';
import { firstOpenColumn } from '$lib/column-role';
import { columnForCopy } from '$lib/board/card-actions';
import type { ColumnType } from '$lib/types';
import { api, type ApiResult } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { makeApiKey, makeBoard, makeCard, makeSession, makeUser, makeWebhook, resetDb, type BoardFixture } from './helpers/fixtures';
import { gate } from './helpers/gate';
import { compare, stateOf, type Findings } from './rehearsal/compare';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

const RENAMED = 'The Options column is always called Options.';
const KEEPS = 'Every delivery board keeps its Options column.';
const NOT_DELETED = 'Every delivery board keeps its Options column. Fold it away with the arrow on its strip instead.';
const HAS_ONE = 'This board already has its Options column.';
const HAS_NONE = "A delivery board's Options column is made with the board; it comes back at the next start.";
const TITLED = "Only the board's Options column is called Options. Choose another name.";

/** A new delivery board's columns as stored, left to right. */
const DEFAULTS = [
	{ title: 'Options', position: 0, color: '#8b5cf6', role: 'options', wipLimit: 0 },
	{ title: 'To Do', position: 1, color: '#6366f1', role: null, wipLimit: 0 },
	{ title: 'On Hold', position: 2, color: '#ef4444', role: null, wipLimit: 0 },
	{ title: 'In Progress', position: 3, color: '#f59e0b', role: null, wipLimit: 0 },
	{ title: 'Complete', position: 4, color: '#10b981', role: null, wipLimit: 0 }
];

/** Every count of the start-up step at 0: what a second run returns. */
const NOTHING_FILLED: Backfill = {
	firstCompletedAt: 0,
	accessTokens: 0,
	releasedFromMilestones: 0,
	released: [],
	unfiledBoards: 0,
	unfiled: [],
	committedFilled: 0,
	upstreamCleared: 0,
	discardedCleared: 0,
	optionsAdded: 0,
	optionsMoved: 0,
	optionsRenamed: 0,
	optionsDemoted: 0
};

let owner: SessionUser;
/** A delivery board with its Options column (-1), then To Do, In Progress and Complete. */
let board: BoardFixture;
let sent: Effects;

beforeEach(() => {
	resetDb();
	owner = makeUser({ username: 'owner' });
	board = makeBoard({ owner, name: 'Delivery', options: true, columns: ['To Do', 'In Progress', 'Complete'] });
	sent = effects();
});
afterEach(() => {
	sent.restore();
	vi.restoreAllMocks();
});

/** A board's columns as stored, in their order. */
const columnsOf = (boardId: number) =>
	sqlite
		.prepare('SELECT title, position, color, role, wip_limit AS wipLimit FROM columns WHERE board_id = ? ORDER BY position, id')
		.all(boardId) as { title: string; position: number; color: string; role: string | null; wipLimit: number }[];

/** A column as stored. */
const stored = (columnId: number) =>
	sqlite.prepare('SELECT title, position, role FROM columns WHERE id = ?').get(columnId) as { title: string; position: number; role: string | null } | undefined;

/** Put a column on a board directly, as a restored backup or an older build leaves one. */
function insertColumn(boardId: number, title: string, position: number, role: string | null = null): number {
	return Number(sqlite.prepare('INSERT INTO columns (board_id, title, position, role) VALUES (?, ?, ?, ?)').run(boardId, title, position, role).lastInsertRowid);
}

/** A column's row, for `makeCard`. */
const columnRow = (columnId: number): Column => db.select().from(columns).where(eq(columns.id, columnId)).get()!;

/** Expect `status` with `message`, nothing written and nothing sent. */
async function expectRefused(request: () => Promise<ApiResult>, status: number, message: string): Promise<void> {
	const before = snapshotDb();
	const res = await request();
	await sent.settle();
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	expect(res.body).toEqual({ message });
	expectUnchanged(before);
	expect(sent.all).toEqual([]);
}

/** Expect 200, and nothing written or told: a value sent back as it is. */
async function expectNoChange(request: () => Promise<ApiResult>): Promise<void> {
	const before = snapshotDb();
	const res = await request();
	await sent.settle();
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	expectUnchanged(before);
	expect(sent.all).toEqual([]);
}

type Tree = {
	name: string;
	createBoard: (body: Record<string, unknown>) => Promise<ApiResult>;
	updateBoard: (boardId: number, body: Record<string, unknown>) => Promise<ApiResult>;
	convertBoard: (boardId: number, body: Record<string, unknown>) => Promise<ApiResult>;
	/** A sub-board under `cardId`, by the tree's own way of making one. */
	subBoard: (cardId: number, columnId: number) => Promise<ApiResult>;
	create: (boardId: number, body: Record<string, unknown>) => Promise<ApiResult>;
	update: (columnId: number, body: Record<string, unknown>) => Promise<ApiResult>;
	remove: (columnId: number) => Promise<ApiResult>;
	createCard: (boardId: number, columnId: number, title: string) => Promise<ApiResult>;
	move: (cardId: number, columnId: number) => Promise<ApiResult>;
	send: (cardId: number, body: Record<string, unknown>) => Promise<ApiResult>;
	deleteBoard: (boardId: number) => Promise<ApiResult>;
	prefix: '' | 'api:';
};

const TREES: Tree[] = [
	{
		name: 'the board page’s routes',
		createBoard: (body) => api('POST', '/api/boards', { user: owner, body }),
		updateBoard: (boardId, body) => api('PUT', `/api/boards/${boardId}`, { user: owner, body }),
		convertBoard: (boardId, body) => api('POST', `/api/boards/${boardId}/convert`, { user: owner, body }),
		// A new card with a sub-board, as the card window makes one (card 2296).
		subBoard: (_cardId, columnId) => api('POST', '/api/cards', { user: owner, body: { columnId, title: 'With a plan', subBoards: [{ name: 'Its plan' }] } }),
		create: (boardId, body) => api('POST', '/api/columns', { user: owner, body: { boardId, ...body } }),
		update: (columnId, body) => api('PUT', `/api/columns/${columnId}`, { user: owner, body }),
		remove: (columnId) => api('DELETE', `/api/columns/${columnId}`, { user: owner }),
		createCard: (boardId, columnId, title) => api('POST', '/api/cards', { user: owner, body: { boardId, columnId, title } }),
		move: (cardId, columnId) => api('PUT', `/api/cards/${cardId}`, { user: owner, body: { columnId } }),
		send: (cardId, body) => api('POST', `/api/cards/${cardId}/send`, { user: owner, body }),
		deleteBoard: (boardId) => api('DELETE', `/api/boards/${boardId}`, { user: owner }),
		prefix: ''
	},
	{
		name: 'the documented routes',
		createBoard: (body) => api('POST', '/api/v1/boards', { user: owner, body }),
		updateBoard: (boardId, body) => api('PUT', `/api/v1/boards/${boardId}`, { user: owner, body }),
		convertBoard: (boardId, body) => api('POST', `/api/v1/boards/${boardId}/convert`, { user: owner, body }),
		subBoard: (cardId) => api('POST', '/api/v1/boards', { user: owner, body: { name: 'Its plan', parentCardId: cardId } }),
		create: (boardId, body) => api('POST', `/api/v1/boards/${boardId}/columns`, { user: owner, body }),
		update: (columnId, body) => api('PUT', `/api/v1/columns/${columnId}`, { user: owner, body }),
		remove: (columnId) => api('DELETE', `/api/v1/columns/${columnId}`, { user: owner }),
		createCard: (boardId, columnId, title) => api('POST', `/api/v1/boards/${boardId}/cards`, { user: owner, body: { columnId, title } }),
		move: (cardId, columnId) => api('PUT', `/api/v1/cards/${cardId}/move`, { user: owner, body: { columnId } }),
		send: (cardId, body) => api('POST', `/api/v1/cards/${cardId}/send`, { user: owner, body }),
		deleteBoard: (boardId) => api('DELETE', `/api/v1/boards/${boardId}`, { user: owner }),
		prefix: 'api:'
	}
];

describe.each(TREES)('a new delivery board, through $name (rulings O1 and O2)', (tree) => {
	it('is made with its Options column first, then To Do, On Hold, In Progress and Complete', async () => {
		const res = await tree.createBoard({ name: 'New work' });

		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(columnsOf(res.body.id)).toEqual(DEFAULTS);
		// Where new work goes when nobody chose a column is still To Do (R5).
		const rows = sqlite.prepare('SELECT id, title, position, role FROM columns WHERE board_id = ?').all(res.body.id) as {
			id: number;
			title: string;
			position: number;
			role: string | null;
		}[];
		expect(firstOpenColumn(rows)?.title).toBe('To Do');
	});

	it('and an ideas board has none', async () => {
		const res = await tree.createBoard({ name: 'New ideas', kind: 'ideas' });

		expect(columnsOf(res.body.id).map((c) => [c.title, c.role])).toEqual([
			['New Ideas', null],
			['Shaping', null],
			['Ready for Replenishment', null]
		]);
	});

	it('a sub-board is made with its Options column too', async () => {
		const parent = makeCard(board.cols['To Do'], { title: 'The parent' });

		const res = await tree.subBoard(parent.id, board.cols['To Do'].id);

		expect([200, 201]).toContain(res.status);
		const sub = sqlite.prepare('SELECT id FROM boards WHERE parent_card_id IS NOT NULL').get() as { id: number };
		expect(columnsOf(sub.id)).toEqual(DEFAULTS);
	});

	it('an empty ideas board switched to delivery is given the five, and the entry names them', async () => {
		const made = await tree.createBoard({ name: 'Switched', kind: 'ideas' });

		const back = await tree.updateBoard(made.body.id, { kind: 'delivery' });

		expect(back.status, JSON.stringify(back.body)).toBe(200);
		expect(columnsOf(made.body.id)).toEqual(DEFAULTS);
		const detail = (sqlite.prepare('SELECT detail FROM activity_log WHERE board_id = ? ORDER BY id DESC LIMIT 1').get(made.body.id) as { detail: string }).detail;
		expect(detail).toBe(
			'Updated board "Switched" (fields: kind): now a delivery board; its columns New Ideas, Shaping, Ready for Replenishment were replaced with Options, To Do, On Hold, In Progress, Complete'
		);
		// And nothing for the start-up step to add.
		expect(runBackfills(sqlite)).toEqual(NOTHING_FILLED);
	});
});

describe.each(TREES)('a new delivery board’s Options column at work, through $name', (tree) => {
	/** A board made through the tree, and its columns' ids by title. */
	async function newBoard(name = 'New work'): Promise<{ id: number; col: Record<string, number> }> {
		const res = await tree.createBoard({ name });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const rows = sqlite.prepare('SELECT id, title FROM columns WHERE board_id = ?').all(res.body.id) as { id: number; title: string }[];
		return { id: res.body.id, col: Object.fromEntries(rows.map((r) => [r.title, r.id])) };
	}
	const commitmentOf = (cardId: number) =>
		sqlite.prepare('SELECT committed_at AS committedAt, committed_by AS committedBy FROM cards WHERE id = ?').get(cardId) as {
			committedAt: string | null;
			committedBy: number | null;
		};

	it('holds options: a card made in it is one, and moved out into To Do it is committed', async () => {
		const made = await newBoard();

		const created = await tree.createCard(made.id, made.col['Options'], 'An option');
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const cardId = created.body.id;
		expect(commitmentOf(cardId)).toEqual({ committedAt: null, committedBy: null });

		const moved = await tree.move(cardId, made.col['To Do']);
		expect(moved.status, JSON.stringify(moved.body)).toBe(200);
		expect(commitmentOf(cardId).committedBy).toBe(owner.id);
		expect(commitmentOf(cardId).committedAt).not.toBeNull();
	});

	it('places a column sent with no position right of it: after it from the page, after the last through v1', async () => {
		const made = await newBoard();

		const res = await tree.create(made.id, { title: 'Review' });

		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(stored(res.body.id)!.position).toBe(tree.prefix ? 5 : 0.5);
		expect(columnsOf(made.id)[0]).toMatchObject({ title: 'Options', role: 'options' });
	});

	it('is where an option sent to the board with to "options" arrives', async () => {
		const made = await newBoard();
		const ideas = makeBoard({ owner, name: 'Ideas', columns: ['New Ideas'] });
		sqlite.prepare("UPDATE boards SET kind = 'ideas' WHERE id = ?").run(ideas.board.id);
		const idea = makeCard(columnRow(ideas.cols['New Ideas'].id), { title: 'An idea' });

		const res = await tree.send(idea.id, { boardId: made.id, to: 'options' });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(sqlite.prepare('SELECT column_id AS columnId FROM cards WHERE id = ?').get(idea.id)).toEqual({ columnId: made.col['Options'] });
		expect(commitmentOf(idea.id)).toEqual({ committedAt: null, committedBy: null });
	});

	it('holds no card with sub-boards: none is made under a card in it (ruling o)', async () => {
		const made = await newBoard();
		const option = makeCard(columnRow(made.col['Options']), { title: 'An option' });
		const before = snapshotDb();

		const res = await tree.subBoard(option.id, made.col['Options']);

		expect(res.status, JSON.stringify(res.body)).toBe(409);
		// The page's new card names the sub-board it was refusing.
		const refusal = 'An option has no sub-boards; commit it first, by moving it out of the Options column.';
		expect(res.body).toEqual({ message: tree.prefix ? refusal : `subBoards[0]: ${refusal}` });
		expectUnchanged(before);
	});

	it('goes with its board, and an empty board made an ideas board has its Options column replaced with the rest', async () => {
		const gone = await newBoard('Gone');
		const switched = await newBoard('Switched');

		expect((await tree.deleteBoard(gone.id)).status).toBe(200);
		expect(stored(gone.col['Options'])).toBeUndefined();

		const res = await tree.updateBoard(switched.id, { kind: 'ideas' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(columnsOf(switched.id).map((c) => c.title)).toEqual(['New Ideas', 'Shaping', 'Ready for Replenishment']);
		const detail = (sqlite.prepare('SELECT detail FROM activity_log WHERE board_id = ? ORDER BY id DESC LIMIT 1').get(switched.id) as { detail: string }).detail;
		expect(detail).toBe(
			'Updated board "Switched" (fields: kind): now an ideas board; its columns Options, To Do, On Hold, In Progress, Complete were replaced with New Ideas, Shaping, Ready for Replenishment'
		);
	});
});

describe.each(TREES)('the Options column cannot be renamed, given away or deleted, through $name (ruling O4)', (tree) => {
	const options = () => board.cols['Options'];

	it('refuses a new title, in any case, and takes the one it has sent back, trimmed, as no change', async () => {
		await expectRefused(() => tree.update(options().id, { title: 'Ideas' }), 409, RENAMED);
		await expectRefused(() => tree.update(options().id, { title: 'options' }), 409, RENAMED);
		await expectNoChange(() => tree.update(options().id, { title: '  Options ' }));
	});

	it('refuses role null, and takes "options" sent back as no change', async () => {
		await expectRefused(() => tree.update(options().id, { role: null }), 409, KEEPS);
		await expectNoChange(() => tree.update(options().id, { role: 'options' }));
		await expectNoChange(() => tree.update(options().id, { title: 'Options', role: 'options', wipLimit: 0, color: board.cols['Options'].color }));
	});

	it('refuses a delete, empty or holding options, live or archived, and deletes nothing', async () => {
		await expectRefused(() => tree.remove(options().id), 409, NOT_DELETED);
		makeCard(options(), { archivedAt: '2026-10-01 00:00:00' });
		makeCard(options());
		await expectRefused(() => tree.remove(options().id), 409, NOT_DELETED);
	});

	it('asks before the completion rule (R4): the Options column holding a card renamed Done is refused as a rename', async () => {
		makeCard(options());

		await expectRefused(() => tree.update(options().id, { title: 'Done' }), 409, RENAMED);
	});

	it('refuses a WIP limit above 0 on it, and takes 0, the limit it has, sent back as no change', async () => {
		await expectRefused(() => tree.update(options().id, { wipLimit: 2 }), 409, 'An Options column has no WIP limit.');
		await expectNoChange(() => tree.update(options().id, { wipLimit: 0 }));
	});

	it('changes its colour, which is no rename', async () => {
		const res = await tree.update(options().id, { color: '#123456' });

		expect(res.status).toBe(200);
		expect(stored(options().id)).toEqual({ title: 'Options', position: -1, role: 'options' });
	});

	it('lets an Options column of another title, as an older backup holds one, take its title before the start-up step does', async () => {
		const older = makeBoard({ owner, name: 'Older' });
		const ideas = insertColumn(older.board.id, 'Ideas', -1, 'options');

		await expectNoChange(() => tree.update(ideas, { title: 'Ideas' }));
		await expectRefused(() => tree.update(ideas, { title: 'Later' }), 409, RENAMED);
		const res = await tree.update(ideas, { title: 'Options' });
		expect(res.status).toBe(200);
		expect(stored(ideas)).toMatchObject({ title: 'Options', role: 'options' });
	});
});

describe.each(TREES)('no second Options column, and no other column called Options, through $name (ruling O5)', (tree) => {
	it('refuses the role on a new column and on another column', async () => {
		await expectRefused(() => tree.create(board.board.id, { title: 'Later', role: 'options' }), 409, HAS_ONE);
		await expectRefused(() => tree.update(board.cols['In Progress'].id, { role: 'options' }), 409, HAS_ONE);
	});

	it('says, on a board with none, that it comes back at the next start', async () => {
		const older = makeBoard({ owner, name: 'Older', columns: ['To Do', 'Complete'] });

		await expectRefused(() => tree.create(older.board.id, { title: 'Later', role: 'options' }), 409, HAS_NONE);
		await expectRefused(() => tree.update(older.cols['To Do'].id, { role: 'options' }), 409, HAS_NONE);
	});

	it('refuses a new column called Options, trimmed and in any case, and another column renamed so', async () => {
		await expectRefused(() => tree.create(board.board.id, { title: 'Options' }), 409, TITLED);
		await expectRefused(() => tree.create(board.board.id, { title: '  oPtIoNs ' }), 409, TITLED);
		await expectRefused(() => tree.update(board.cols['In Progress'].id, { title: 'OPTIONS' }), 409, TITLED);
	});

	it('leaves a column already called Options as it is, and refuses it only a new title that still is', async () => {
		const plain = insertColumn(board.board.id, 'Options', 9);

		await expectNoChange(() => tree.update(plain, { title: 'Options' }));
		await expectRefused(() => tree.update(plain, { title: 'OPTIONS' }), 409, TITLED);
		const res = await tree.update(plain, { title: 'Choices' });
		expect(res.status).toBe(200);
		expect(stored(plain)).toEqual({ title: 'Choices', position: 9, role: null });
	});

	it('asks the completion rule first (R4): a Complete column holding a card renamed Options is refused by it', async () => {
		makeCard(board.cols['Complete'], { completedAt: '2026-10-01 00:00:00', firstCompletedAt: '2026-10-01 00:00:00' });

		await expectRefused(
			() => tree.update(board.cols['Complete'].id, { title: 'Options' }),
			409,
			'This column holds 1 card. It counts as finished because the column is called Complete or Done, and renaming it to "Options" would turn it back into open work. Keep it called Complete or Done.'
		);
	});

	it('lets a column of an ideas board be called Options: an ideas board has no Options column', async () => {
		const ideas = await tree.createBoard({ name: 'Ideas', kind: 'ideas' });

		const res = await tree.create(ideas.body.id, { title: 'Options' });

		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body).toMatchObject({ title: 'Options', role: null });
	});
});

describe.each(TREES)('a board made an ideas board, through $name (ruling O7)', (tree) => {
	it('deletes an empty Options column with the empty To Do and Complete columns, and names it with them', async () => {
		makeCard(board.cols['In Progress'], { title: 'Doing' });

		const res = await tree.convertBoard(board.board.id, { kind: 'ideas', cards: 1 });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(columnsOf(board.board.id).map((c) => [c.title, c.role])).toEqual([['In Progress', null]]);
		expect(stored(board.cols['Options'].id)).toBeUndefined();
		const detail = (sqlite.prepare('SELECT detail FROM activity_log WHERE board_id = ?').get(board.board.id) as { detail: string }).detail;
		expect(detail).toBe(`"Delivery": 1 card became an idea; its columns Options, To Do, Complete were removed (board ${board.board.id})`);
	});

	it('keeps an Options column that holds a card, archived ones included, as an ordinary column', async () => {
		makeCard(board.cols['Options'], { title: 'Put away', archivedAt: '2026-10-01 00:00:00' });

		const res = await tree.convertBoard(board.board.id, { kind: 'ideas', cards: 1 });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(stored(board.cols['Options'].id)).toEqual({ title: 'Options', position: -1, role: null });
		const detail = (sqlite.prepare('SELECT detail FROM activity_log WHERE board_id = ?').get(board.board.id) as { detail: string }).detail;
		expect(detail).toBe(`"Delivery": 1 card became an idea; its columns To Do, Complete were removed (board ${board.board.id})`);
	});
});

describe('the start-up step gives every delivery board its one Options column (rulings O3, R1 and R2)', () => {
	/** Every column of every board, as stored, by board and then in order. */
	const everyColumn = () =>
		sqlite.prepare('SELECT board_id AS boardId, title, position, color, role FROM columns ORDER BY board_id, position, id').all();

	it('adds one, empty, at the far left of each delivery board that has none, or at 0 on a board with no column; none on an ideas board', () => {
		const old = makeBoard({ owner, name: 'Old' });
		const bare = makeBoard({ owner, name: 'Bare', columns: [] });
		const ideas = makeBoard({ owner, name: 'Ideas', columns: ['New Ideas'] });
		const other = makeBoard({ owner, name: 'Another kind', columns: ['Doing'] });
		sqlite.prepare("UPDATE boards SET kind = 'ideas' WHERE id = ?").run(ideas.board.id);
		// A kind it does not know is a delivery board, as in every other backfill.
		sqlite.prepare("UPDATE boards SET kind = 'portfolio' WHERE id = ?").run(other.board.id);
		makeWebhook(old.board);
		const entries = () => (sqlite.prepare('SELECT COUNT(*) AS n FROM activity_log').get() as { n: number }).n;
		const before = entries();

		expect(runBackfills(sqlite)).toEqual({ ...NOTHING_FILLED, optionsAdded: 3 });

		const optionsOf = (boardId: number) =>
			sqlite.prepare("SELECT title, position, color, wip_limit AS wipLimit FROM columns WHERE board_id = ? AND role IS 'options'").all(boardId);
		expect(optionsOf(old.board.id)).toEqual([{ title: 'Options', position: -1, color: '#8b5cf6', wipLimit: 0 }]);
		expect(optionsOf(bare.board.id)).toEqual([{ title: 'Options', position: 0, color: '#8b5cf6', wipLimit: 0 }]);
		expect(optionsOf(other.board.id)).toEqual([{ title: 'Options', position: -1, color: '#8b5cf6', wipLimit: 0 }]);
		expect(optionsOf(ideas.board.id)).toEqual([]);
		// The board that had one is as it was.
		expect(optionsOf(board.board.id)).toEqual([{ title: 'Options', position: -1, color: '#8b5cf6', wipLimit: 0 }]);
		// No entry, no webhook, no mail.
		expect(entries()).toBe(before);
		expect(sent.all).toEqual([]);
		// And once only: a second run finds nothing (R1).
		const after = everyColumn();
		expect(runBackfills(sqlite)).toEqual(NOTHING_FILLED);
		expect(everyColumn()).toEqual(after);
	});

	it('renames an Options column of another title, and moves one that is not leftmost left of every other column', () => {
		const named = makeBoard({ owner, name: 'Named', columns: ['To Do'] });
		insertColumn(named.board.id, 'Ideas', -1, 'options');
		const placed = makeBoard({ owner, name: 'Placed', columns: ['To Do', 'Doing'] });
		const late = insertColumn(placed.board.id, 'Options', 1.5, 'options');
		// At the same position as another column made before it: not leftmost either.
		const tied = makeBoard({ owner, name: 'Tied', columns: ['To Do'] });
		const level = insertColumn(tied.board.id, 'Options', 0, 'options');

		expect(runBackfills(sqlite)).toEqual({ ...NOTHING_FILLED, optionsRenamed: 1, optionsMoved: 2 });

		expect(columnsOf(named.board.id).map((c) => [c.title, c.role])).toEqual([
			['Options', 'options'],
			['To Do', null]
		]);
		expect(stored(late)).toEqual({ title: 'Options', position: -1, role: 'options' });
		expect(stored(level)).toEqual({ title: 'Options', position: -1, role: 'options' });
		expect(runBackfills(sqlite)).toEqual(NOTHING_FILLED);
	});

	it('keeps the leftmost of two, by position and then id; the other loses the role and keeps its cards, committed in the same run and discarded no more (K2)', () => {
		const twice = makeBoard({ owner, name: 'Twice', columns: ['To Do'] });
		const first = insertColumn(twice.board.id, 'Ideas', -2, 'options');
		const second = insertColumn(twice.board.id, 'Later', -2, 'options');
		const card = makeCard(columnRow(second), { title: 'Was an option' });
		const dropped = makeCard(columnRow(second), { title: 'Discarded', archivedAt: '2026-10-01 09:00:00', discardedAt: '2026-10-01 09:00:00', discardedBy: owner.id });
		// An option discarded in the column kept stays discarded.
		const kept = makeCard(columnRow(first), { title: 'Discarded too', archivedAt: '2026-10-01 09:00:00', discardedAt: '2026-10-01 09:00:00', discardedBy: owner.id });
		const markOf = (id: number) =>
			sqlite.prepare('SELECT committed_at IS NOT NULL AS committed, discarded_at AS discardedAt, discarded_by AS discardedBy FROM cards WHERE id = ?').get(id);
		expect(markOf(card.id)).toEqual({ committed: 0, discardedAt: null, discardedBy: null });

		// The one kept is renamed, and moved left of the other, which stays where it was.
		expect(runBackfills(sqlite)).toEqual({ ...NOTHING_FILLED, optionsDemoted: 1, optionsRenamed: 1, optionsMoved: 1, committedFilled: 2 });

		expect(stored(first)).toEqual({ title: 'Options', position: -3, role: 'options' });
		expect(stored(second)).toEqual({ title: 'Later', position: -2, role: null });
		expect(markOf(card.id)).toEqual({ committed: 1, discardedAt: null, discardedBy: null });
		// Archived committed work is abandoned, never discarded.
		expect(markOf(dropped.id)).toEqual({ committed: 1, discardedAt: null, discardedBy: null });
		expect(markOf(kept.id)).toEqual({ committed: 0, discardedAt: '2026-10-01 09:00:00', discardedBy: owner.id });
		expect(runBackfills(sqlite)).toEqual(NOTHING_FILLED);
	});

	it('runs after a restore, so a backup made before card 2527 comes back with its Options columns', () => {
		const opened: Database.Database[] = [];
		const migrated = () => {
			const database = new Database(':memory:');
			database.pragma('foreign_keys = ON');
			opened.push(database);
			runMigrations({ database, migrationsDir: join(process.cwd(), 'drizzle') });
			return database;
		};
		try {
			const live = migrated();
			const backup = migrated();
			backup.exec(`
				INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'chief', 'chief@example.test', 'x', 'superadmin');
				INSERT INTO boards (id, name) VALUES (1, 'From the backup');
				INSERT INTO columns (id, board_id, title, position) VALUES (1, 1, 'To Do', 0), (2, 1, 'Complete', 1);
			`);

			const result = restoreFromBackup(live, backup);

			expect(result.errors).toEqual([]);
			expect(result.backfilled).toMatchObject({ optionsAdded: 1, optionsMoved: 0, optionsRenamed: 0 });
			expect(live.prepare('SELECT title, position, role FROM columns WHERE board_id = 1 ORDER BY position').all()).toEqual([
				{ title: 'Options', position: -1, role: 'options' },
				{ title: 'To Do', position: 0, role: null },
				{ title: 'Complete', position: 1, role: null }
			]);
		} finally {
			for (const database of opened) database.close();
		}
	});

	it('says what it did at a start, in WARN lines, none beginning "Took"', () => {
		const database = new Database(':memory:');
		database.pragma('foreign_keys = ON');
		try {
			runMigrations({ database, migrationsDir: join(process.cwd(), 'drizzle') });
			// Board 2's Options column is called Ideas and stands right of To Do;
			// board 3 has two, the second made an ordinary column; board 1 has none.
			database.exec(`
				INSERT INTO boards (id, name) VALUES (1, 'A'), (2, 'B'), (3, 'C');
				INSERT INTO columns (id, board_id, title, position, role) VALUES
					(1, 2, 'To Do', 0, NULL), (2, 2, 'Ideas', 3, 'options'), (3, 3, 'Options', -1, 'options'), (4, 3, 'Later', 0, 'options');
			`);
			process.env.LOG_LEVEL = 'WARN';
			const lines: string[] = [];
			vi.spyOn(console, 'warn').mockImplementation((line) => void lines.push(String(line).replace(/^\[[^\]]+\] /, '')));

			const report = runMigrations({ database, migrationsDir: join(process.cwd(), 'drizzle') });

			expect(report.backfilled).toMatchObject({ optionsAdded: 1, optionsMoved: 1, optionsRenamed: 1, optionsDemoted: 1 });
			expect(lines).toEqual([
				'[WARN] [DB] Added an Options column at the far left of 1 delivery board(s) that had none',
				'[WARN] [DB] Renamed 1 Options column(s) to Options, the title every one has',
				'[WARN] [DB] Moved 1 Options column(s) to the far left of their board, where every one is',
				'[WARN] [DB] Made 1 second Options column(s) ordinary columns, each board keeping its leftmost: their cards are committed work now, and no discard mark is left on them'
			]);
		} finally {
			delete process.env.LOG_LEVEL;
			database.close();
		}
	});

	it('is noted by the rehearsal as the start’s own step, a demotion in the same run included (K3)', () => {
		const database = new Database(':memory:');
		database.pragma('foreign_keys = ON');
		try {
			runMigrations({ database, migrationsDir: join(process.cwd(), 'drizzle') });
			// Board 1 has none; board 2 has two, the second made ordinary.
			database.exec(`
				INSERT INTO boards (id, name) VALUES (1, 'A'), (2, 'B');
				INSERT INTO columns (id, board_id, title, position, role) VALUES (1, 2, 'Options', -1, 'options'), (2, 2, 'Later', 0, 'options');
			`);
			const before = stateOf(database);
			vi.spyOn(console, 'warn').mockImplementation(() => {});

			const report = runMigrations({ database, migrationsDir: join(process.cwd(), 'drizzle') });
			const found: Findings = { problems: [], notes: [] };
			compare(before, stateOf(database), report.applied, found);

			expect(report.backfilled).toMatchObject({ optionsAdded: 1, optionsDemoted: 1 });
			expect(found).toEqual({
				problems: [],
				notes: ['columns had 2 row(s) and has 3: each delivery board that had none was given its Options column at the start (card 2527)']
			});
		} finally {
			database.close();
		}
	});

	it('names itself in the halt when it fails, and start-up stops', () => {
		const database = new Database(':memory:');
		database.pragma('foreign_keys = ON');
		try {
			runMigrations({ database, migrationsDir: join(process.cwd(), 'drizzle') });
			// An Options column to rename, and a trigger that refuses the rename.
			database.exec(`
				INSERT INTO boards (id, name) VALUES (1, 'A');
				INSERT INTO columns (id, board_id, title, position, role) VALUES (1, 1, 'Ideas', 0, 'options');
				CREATE TRIGGER no_renames BEFORE UPDATE OF title ON columns BEGIN SELECT RAISE(ABORT, 'titles are frozen'); END;
			`);
			vi.spyOn(console, 'error').mockImplementation(() => {});

			expect(() => runMigrations({ database, migrationsDir: join(process.cwd(), 'drizzle') })).toThrow(
				"Migrations halted (backfilling each delivery board's Options column (columns.role), cards.first_completed_at, " +
					'task_requests.access_token, cards.milestone_id, boards.category_id, cards.committed_at and cards.discarded_at): titles are frozen.'
			);
			// The whole step was rolled back: the column is as it was.
			expect(database.prepare('SELECT title, role FROM columns WHERE id = 1').get()).toEqual({ title: 'Ideas', role: 'options' });
		} finally {
			database.close();
		}
	});
});

describe('the board page’s reorder of a new board', () => {
	it('keeps its Options column first: the order the page sends, every column at its index, and none that puts another at or left of it', async () => {
		const made = await api('POST', '/api/boards', { user: owner, body: { name: 'Reordered' } });
		const ids = (sqlite.prepare('SELECT id FROM columns WHERE board_id = ? ORDER BY position, id').all(made.body.id) as { id: number }[]).map((c) => c.id);
		const reorder = (updates: { id: number; position: number }[]) => api('PUT', '/api/columns/reorder', { user: owner, body: { updates } });

		await expectRefused(() => reorder([{ id: ids[1], position: 0 }, { id: ids[0], position: 1 }]), 409, 'The Options column stays at the left of the board.');
		// Complete moved before To Do, the Options column still first.
		const res = await reorder([ids[0], ids[4], ids[1], ids[2], ids[3]].map((id, position) => ({ id, position })));
		expect(res.status).toBe(200);
		expect(columnsOf(made.body.id).map((c) => c.title)).toEqual(['Options', 'Complete', 'To Do', 'On Hold', 'In Progress']);
	});
});

describe('new work never goes into the Options column (R5)', () => {
	it('the copy of a finished card on a new board goes to To Do, past the Options column', async () => {
		const made = await api('POST', '/api/boards', { user: owner, body: { name: 'Copies' } });
		const cols = sqlite.prepare('SELECT id, board_id AS boardId, title, position, role FROM columns WHERE board_id = ?').all(made.body.id) as unknown as ColumnType[];
		const complete = cols.find((c) => c.title === 'Complete')!;

		expect(columnForCopy(complete, cols).title).toBe('To Do');
	});

	it('a copy of finished work stays beside it on a board whose only other column is the Options column', () => {
		const cols = [
			{ id: 1, title: 'Options', position: -1, role: 'options' },
			{ id: 2, title: 'Complete', position: 0, role: null }
		] as unknown as ColumnType[];

		expect(firstOpenColumn(cols)).toBeUndefined();
		expect(columnForCopy(cols[1], cols).id).toBe(2);
	});
});

describe('the column conversion routes are gone (ruling O6)', () => {
	it('answers 404 to POST /api/v1/columns/:columnId/convert, as JSON, and to the page’s POST /api/columns/:id/convert', async () => {
		const withKey = { authorization: `Bearer ${makeApiKey(owner)}`, 'content-type': 'application/json' };
		const asOwner = { cookie: `${SESSION_COOKIE_NAME}=${makeSession(owner)}`, 'content-type': 'application/json' };
		const column = board.cols['In Progress'].id;

		const v1 = await gate('POST', `/api/v1/columns/${column}/convert`, { headers: withKey, body: { role: 'options', cards: 0 } });
		const page = await gate('POST', `/api/columns/${column}/convert`, { headers: asOwner, body: { role: 'options', cards: 0 } });

		expect(v1.status).toBe(404);
		expect(await v1.json()).toEqual({ message: 'Not found' });
		expect(page.status).toBe(404);
		// Nothing became the Options column.
		expect(stored(column)).toMatchObject({ role: null });
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM columns WHERE board_id = ? AND role IS 'options'").get(board.board.id)).toEqual({ n: 1 });
		await expect(api('POST', `/api/columns/${column}/convert`, { user: owner, body: { role: 'options', cards: 0 } })).rejects.toThrow(/No route matches/);
	});
});
