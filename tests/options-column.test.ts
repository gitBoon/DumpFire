/**
 * The board's Options column (milestone 22, card 2459, slice S1b): its rules
 * on every column write in both trees, and what the board page's strip is
 * given and keeps.
 *
 * A column whose `role` is 'options' is upstream of the commitment point: its
 * cards are options, not committed work. A board has one at most, at its far
 * left, with no WIP limit; an ideas board has none, every column of it being
 * upstream already. Since card 2527 every delivery board is made with its
 * Options column, which keeps its title and its role and is never deleted, and
 * no write gives the role to another column: those rules, the defaults and the
 * start-up step are in tests/options-everywhere.test.ts. The conversion of a
 * column holding cards went before release with them.
 *
 * `/api/columns...` are the board page's routes and `/api/v1/...` the
 * documented ones. They share one service each (`$lib/server/columns`) and
 * are tested as two trees.
 *
 * The plan is `docs/planning/milestone-22-upstream-kanban.md`, section 7.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqlite } from '$lib/server/db';
import type { Column } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { readBoardContents } from '$lib/server/board-contents';
import { OPTION_AGING_DAYS, defaultListColumn, optionsAging, optionsOpenKey, readOptionsOpen, resolveListColumn, writeOptionsOpen } from '$lib/board/board-view';
import { api, type ApiResult } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { makeBoard, makeCard, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

let owner: SessionUser;
let board: BoardFixture;
let sent: Effects;

/** Options -1, then Backlog 0, To Do 1, On Hold 2, In Progress 3, Complete 4. "Backlog" is a title with no role. */
const COLUMNS = ['Backlog', 'To Do', 'On Hold', 'In Progress', 'Complete'];

beforeEach(() => {
	resetDb();
	owner = makeUser();
	board = makeBoard({ owner, options: true, columns: COLUMNS });
	sent = effects();
});
afterEach(() => sent.restore());

type Tree = {
	name: string;
	create: (body: Record<string, unknown>, user?: SessionUser) => Promise<ApiResult>;
	update: (columnId: number, body: Record<string, unknown>, user?: SessionUser) => Promise<ApiResult>;
	remove: (columnId: number, user?: SessionUser) => Promise<ApiResult>;
	/** Where a column sent with no position goes on a board whose Options column is at -1 and other columns at 0 to 4. */
	unplaced: number;
};

const TREES: Tree[] = [
	{
		name: 'the board page’s routes',
		create: (body, user = owner) => api('POST', '/api/columns', { user, body: { boardId: board.board.id, ...body } }),
		update: (columnId, body, user = owner) => api('PUT', `/api/columns/${columnId}`, { user, body }),
		remove: (columnId, user = owner) => api('DELETE', `/api/columns/${columnId}`, { user }),
		// Straight after the Options column, between it and the next (ruling s).
		unplaced: -0.5
	},
	{
		name: 'the documented routes',
		create: (body, user = owner) => api('POST', `/api/v1/boards/${board.board.id}/columns`, { user, body }),
		update: (columnId, body, user = owner) => api('PUT', `/api/v1/columns/${columnId}`, { user, body }),
		remove: (columnId, user = owner) => api('DELETE', `/api/v1/columns/${columnId}`, { user }),
		// After the last column, as before (ruling s).
		unplaced: 5
	}
];

/** A column as stored. */
const stored = (columnId: number) =>
	sqlite.prepare('SELECT title, position, role, wip_limit AS wipLimit FROM columns WHERE id = ?').get(columnId) as {
		title: string;
		position: number;
		role: string | null;
		wipLimit: number;
	};

/** The board's Options column, made with it at -1 (`makeBoard`'s `options`). */
const optionsColumn = (): Column => board.cols['Options'];

/** Expect a 409 with `message`, nothing written and nothing sent. */
async function expectRefused(request: () => Promise<ApiResult>, status: number, message: string): Promise<void> {
	const before = snapshotDb();
	const res = await request();
	await sent.settle();
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	expect(res.body).toEqual({ message });
	expectUnchanged(before);
	expect(sent.all).toEqual([]);
}

const IDEAS_BOARD = 'Every column of an ideas board is already upstream, so it has no Options column.';
const LEFTMOST = 'The Options column stays at the left of the board.';

describe.each(TREES)('the Options role, through %s', (tree) => {
	describe('on a new column', () => {
		it('makes an ordinary column for a role of null, and one with no role sent', async () => {
			const none = await tree.create({ title: 'Review', role: null });
			const left = await tree.create({ title: 'Testing' });

			expect([none.status, left.status]).toEqual([201, 201]);
			expect([stored(none.body.id).role, stored(left.body.id).role]).toEqual([null, null]);
		});

		it('refuses a role that is not one, 400, quoting what was sent (ruling r)', async () => {
			await expectRefused(() => tree.create({ title: 'Ideas', role: 'backlog' }), 400, 'role must be "options" or null, not "backlog"');
			await expectRefused(() => tree.create({ title: 'Ideas', role: true }), 400, 'role must be "options" or null, not true');
		});

		it('refuses an Options column on an ideas board, after its own title rule (card 2527, R4)', async () => {
			sqlite.prepare("UPDATE boards SET kind = 'ideas' WHERE id = ?").run(board.board.id);

			await expectRefused(() => tree.create({ title: 'Later', role: 'options' }), 409, IDEAS_BOARD);
			// A title an ideas board cannot have is refused first.
			await expectRefused(
				() => tree.create({ title: 'Done', role: 'options' }),
				409,
				'An ideas board has no Complete column: "Done" would make one. Choose another name.'
			);
		});

		it('refuses a second Options column, whatever its title', async () => {
			await expectRefused(() => tree.create({ title: 'Done', role: 'options' }), 409, 'This board already has its Options column.');
		});

		it('refuses a column at or left of the Options column, and places one sent with no position after it', async () => {
			await expectRefused(() => tree.create({ title: 'Review', position: -1 }), 409, LEFTMOST);
			await expectRefused(() => tree.create({ title: 'Review', position: -4 }), 409, LEFTMOST);

			const between = await tree.create({ title: 'Shaping', position: -0.25 });
			const unplaced = await tree.create({ title: 'Review' });
			expect([between.status, unplaced.status]).toEqual([201, 201]);
			expect(stored(between.body.id).position).toBe(-0.25);
			expect(stored(unplaced.body.id).position).toBe(tree.unplaced === -0.5 ? (-1 + -0.25) / 2 : tree.unplaced);
		});

		it('keeps every column sent with no position right of the Options column, however many are made (B1)', async () => {
			const made: number[] = [];
			for (let i = 0; i < 60; i++) {
				const res = await tree.create({ title: `Column ${i}` });
				expect(res.status).toBe(201);
				made.push(res.body.id);
			}

			const rows = sqlite.prepare('SELECT id, position, role FROM columns WHERE board_id = ? ORDER BY position, id').all(board.board.id) as {
				id: number;
				position: number;
				role: string | null;
			}[];
			// The Options column first, alone at its position; every position different.
			expect(rows[0]).toMatchObject({ id: optionsColumn().id, role: 'options' });
			expect(rows.slice(1).every((r) => r.position > rows[0].position)).toBe(true);
			expect(new Set(rows.map((r) => r.position)).size).toBe(rows.length);
			// From the page each goes straight after the Options column, so the newest is first after it.
			if (tree.unplaced === -0.5) expect(rows[1].id).toBe(made[made.length - 1]);
			else expect(rows[rows.length - 1].id).toBe(made[made.length - 1]);
		});
	});

	describe('on an existing column', () => {
		it('keeps the role when an update leaves it out (ruling r)', async () => {
			const res = await tree.update(optionsColumn().id, { title: 'Options', color: '#123456' });

			expect(res.status).toBe(200);
			expect(stored(optionsColumn().id)).toMatchObject({ title: 'Options', role: 'options' });
		});

		it('refuses a role that is not one, quoting what was sent', async () => {
			await expectRefused(() => tree.update(board.cols['Backlog'].id, { role: 7 }), 400, 'role must be "options" or null, not 7');
		});

		it('refuses a second Options column', async () => {
			await expectRefused(() => tree.update(board.cols['In Progress'].id, { role: 'options' }), 409, 'This board already has its Options column.');
		});

		it('refuses the role on an ideas board', async () => {
			sqlite.prepare("UPDATE boards SET kind = 'ideas' WHERE id = ?").run(board.board.id);

			await expectRefused(() => tree.update(board.cols['Backlog'].id, { role: 'options' }), 409, IDEAS_BOARD);
		});

		it('refuses a WIP limit on the Options column, and takes 0, which it has', async () => {
			await expectRefused(() => tree.update(optionsColumn().id, { wipLimit: 3 }), 409, 'An Options column has no WIP limit.');

			const none = await tree.update(optionsColumn().id, { wipLimit: 0 });
			expect(none.status).toBe(200);
		});

		it('makes an ordinary column as before: a limit sent with it is not stored', async () => {
			const ordinary = await tree.create({ title: 'Review', wipLimit: 3 });
			expect(ordinary.status).toBe(201);
			expect(stored(ordinary.body.id)).toMatchObject({ role: null, wipLimit: 0 });
		});

		it('keeps the Options column the leftmost: no column moved to or past it, and it moved to no other column', async () => {
			await expectRefused(() => tree.update(board.cols['To Do'].id, { position: -1 }), 409, LEFTMOST);
			await expectRefused(() => tree.update(board.cols['Complete'].id, { position: -2 }), 409, LEFTMOST);
			await expectRefused(() => tree.update(optionsColumn().id, { position: 3 }), 409, LEFTMOST);

			const further = await tree.update(optionsColumn().id, { position: -3 });
			const moved = await tree.update(board.cols['Complete'].id, { position: 0.5 });
			expect([further.status, moved.status]).toEqual([200, 200]);
		});
	});

	describe('deleting the Options column (ruling m; card 2527, O4)', () => {
		it('is refused, empty or holding options, live or archived: every delivery board keeps it', async () => {
			const refusal = 'Every delivery board keeps its Options column. Fold it away with the arrow on its strip instead.';
			await expectRefused(() => tree.remove(optionsColumn().id), 409, refusal);
			makeCard(optionsColumn(), { archivedAt: '2026-10-01 00:00:00' });
			await expectRefused(() => tree.remove(optionsColumn().id), 409, refusal);
			makeCard(optionsColumn());
			await expectRefused(() => tree.remove(optionsColumn().id), 409, refusal);
		});

		it('leaves every other column to be deleted with its cards, as before', async () => {
			makeCard(board.cols['In Progress']);

			expect((await tree.remove(board.cols['In Progress'].id)).status).toBe(200);
		});
	});

});

describe('the column order, on the board page’s reorder', () => {
	const reorder = (updates: { id: number; position: number }[]) => api('PUT', '/api/columns/reorder', { user: owner, body: { updates } });

	it('refuses, whole, an order that puts any column at or left of the Options column', async () => {
		// The Options column first, then Backlog, To Do, On Hold, In Progress and Complete.
		const ids = ['Options', ...COLUMNS].map((title) => board.cols[title].id);

		await expectRefused(() => reorder([{ id: ids[1], position: 0 }, { id: ids[0], position: 1 }, { id: ids[2], position: 2 }]), 409, LEFTMOST);
		await expectRefused(() => reorder([{ id: ids[4], position: -1 }]), 409, LEFTMOST);
		// The Options column moved to the right of another (B9).
		await expectRefused(() => reorder([{ id: ids[0], position: 2.5 }]), 409, LEFTMOST);
		await expectRefused(() => reorder([{ id: ids[0], position: 9 }, { id: ids[1], position: -2 }]), 409, LEFTMOST);

		// The page sends every column at its index, the Options column first.
		const res = await reorder(ids.map((id, position) => ({ id, position })));
		expect(res.status).toBe(200);
		expect(ids.map((id) => stored(id).position)).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it('reorders a board with no Options column as before, as one made before card 2527 is until the next start', async () => {
		const older = makeBoard({ owner, columns: COLUMNS });
		const res = await reorder([{ id: older.cols['Complete'].id, position: -5 }]);
		expect(res.status).toBe(200);
	});
});

describe('the Options strip on the board page (ruling g)', () => {
	it('gives each card in the Options column when it became an option: its latest return to options, else its creation', () => {
		const fresh = makeCard(optionsColumn(), { createdAt: '2026-09-01 08:00:00' });
		const returned = makeCard(optionsColumn(), { createdAt: '2026-06-01 08:00:00' });
		const committed = makeCard(board.cols['To Do'], { createdAt: '2026-05-01 08:00:00' });
		const entry = sqlite.prepare('INSERT INTO activity_log (board_id, card_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)');
		entry.run(board.board.id, returned.id, 'card_returned_to_options', '', '2026-07-01 08:00:00');
		entry.run(board.board.id, returned.id, 'api:card_returned_to_options', '', '2026-08-15 08:00:00');
		entry.run(board.board.id, returned.id, 'card_moved', '', '2026-10-01 08:00:00');

		const contents = readBoardContents(owner, board.board.id);
		const card = (id: number) => contents.columns.flatMap((c) => c.cards).find((c) => c.id === id) as Record<string, unknown>;

		expect(card(fresh.id).optionSince).toBe('2026-09-01 08:00:00');
		expect(card(returned.id).optionSince).toBe('2026-08-15 08:00:00');
		// A committed card is given none: the answer for a board with no options is as it was.
		expect('optionSince' in card(committed.id)).toBe(false);
	});

	it('counts a card as an option from a conversion entry, not from its creation (B2), and no other column’s conversion', async () => {
		// Nothing writes the entry since card 2527, which took the conversion out
		// before release; a test server's history can hold one, and is read as before.
		const backlog = optionsColumn();
		const old = makeCard(backlog, { createdAt: '2025-01-01 08:00:00' });
		const entry = sqlite.prepare('INSERT INTO activity_log (board_id, action, detail, created_at) VALUES (?, ?, ?, ?)');
		entry.run(board.board.id, 'column_converted_to_options', `"Backlog": 1 card became an option (column ${backlog.id})`, '2026-10-20 08:00:00');
		const later = makeCard(backlog, { createdAt: '2026-10-22 08:00:00' });
		// Another column's conversion on the same board, later still, names another id and is not this column's.
		entry.run(board.board.id, 'column_converted_to_options', `"Elsewhere": 2 cards became options (column ${backlog.id}1)`, '2026-10-23 08:00:00');
		entry.run(board.board.id, 'api:column_converted_to_options', `"Shaping": 1 card became an option (column 9${backlog.id})`, '2026-10-24 08:00:00');

		const cards = readBoardContents(owner, board.board.id).columns.flatMap((c) => c.cards) as Record<string, unknown>[];
		const since = (id: number) => cards.find((c) => c.id === id)!.optionSince;

		expect(since(old.id)).toBe('2026-10-20 08:00:00');
		expect(since(later.id)).toBe('2026-10-22 08:00:00');
	});

	it('says how old the oldest option is, and how many are older than 30 days', () => {
		const now = Date.parse('2026-10-26T12:00:00Z');
		const at = (days: number) => ({ createdAt: '2020-01-01 00:00:00', optionSince: new Date(now - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ') });

		expect(optionsAging([], now)).toEqual({ oldestDays: null, over: 0 });
		expect(optionsAging([at(2), at(OPTION_AGING_DAYS), at(31), at(90)], now)).toEqual({ oldestDays: 90, over: 2 });
		// A card dropped into the column since the board was read has no optionSince: its creation counts.
		expect(optionsAging([{ createdAt: '2026-10-16 12:00:00' }], now)).toEqual({ oldestDays: 10, over: 0 });
	});

	describe('remembers whether each viewer left it open, per board, and never fails for storage', () => {
		afterEach(() => vi.unstubAllGlobals());

		it('opens collapsed, and keeps the choice under the viewer’s and the board’s key', () => {
			const store = new Map<string, string>();
			vi.stubGlobal('localStorage', {
				getItem: (k: string) => store.get(k) ?? null,
				setItem: (k: string, v: string) => void store.set(k, v),
				removeItem: (k: string) => void store.delete(k)
			});

			expect(readOptionsOpen(4, 9)).toBe(false);
			writeOptionsOpen(4, 9, true);
			expect([...store]).toEqual([[optionsOpenKey(4, 9), 'open']]);
			expect(optionsOpenKey(4, 9)).toBe('dumpfire-options-open:4:9');
			expect([readOptionsOpen(4, 9), readOptionsOpen(4, 10), readOptionsOpen(5, 9)]).toEqual([true, false, false]);
			writeOptionsOpen(4, 9, false);
			expect(readOptionsOpen(4, 9)).toBe(false);
		});

		it('reads collapsed and writes nothing, without throwing, when storage throws', () => {
			const refuse = () => {
				throw new Error('blocked');
			};
			vi.stubGlobal('localStorage', { getItem: refuse, setItem: refuse, removeItem: refuse });

			expect(readOptionsOpen(4, 9)).toBe(false);
			expect(() => writeOptionsOpen(4, 9, true)).not.toThrow();
			expect(() => writeOptionsOpen(4, 9, false)).not.toThrow();
		});
	});

	it('opens the list view on To Do, else on the first column that is not the Options column, and never on the Options column (card 2527, K1)', () => {
		const options = { id: 1, title: 'Options', role: 'options' };
		expect(defaultListColumn([options, { id: 2, title: 'Doing', role: null }, { id: 3, title: 'To Do', role: null }])).toBe(3);
		expect(defaultListColumn([options, { id: 2, title: 'Doing', role: null }])).toBe(2);
		// An Options column called To Do is still the Options column.
		expect(defaultListColumn([{ ...options, title: 'To Do' }, { id: 2, title: 'Doing', role: null }])).toBe(2);
		// A board with no other column opens on none: the list asks for one.
		expect(defaultListColumn([options])).toBeNull();
		expect(resolveListColumn([options], null)).toBeNull();
		// Chosen in the strip, the Options column is shown.
		expect(resolveListColumn([options], 1)).toBe(1);
	});
});
