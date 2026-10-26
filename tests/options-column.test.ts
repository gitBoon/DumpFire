/**
 * The board's Options column (milestone 22, card 2459, slice S1b): its rules
 * on every column write in both trees, the conversion of a column that holds
 * cards, and what the board page's strip is given and keeps.
 *
 * A column whose `role` is 'options' is upstream of the commitment point: its
 * cards are options, not committed work. A board has one at most, at its far
 * left, with no WIP limit; an ideas board has none, every column of it being
 * upstream already. The role is given or taken away on an empty column with a
 * plain update, and a column holding cards becomes the Options column only by
 * the conversion, which asks first, counts the cards and is recorded (ruling
 * i). A column whose title already means To Do, On Hold or Complete is never
 * the Options column (ruling x, the S1a review's R5).
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
import { OPTION_AGING_DAYS, defaultListColumn, optionsAging, optionsOpenKey, readOptionsOpen, writeOptionsOpen } from '$lib/board/board-view';
import { api, type ApiResult } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { addBoardMember, makeBoard, makeCard, makeSmtp, makeUser, makeWebhook, resetDb, type BoardFixture } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

let owner: SessionUser;
let board: BoardFixture;
let sent: Effects;

/** Backlog 0, To Do 1, On Hold 2, In Progress 3, Complete 4. "Backlog" is a title with no role. */
const COLUMNS = ['Backlog', 'To Do', 'On Hold', 'In Progress', 'Complete'];

beforeEach(() => {
	resetDb();
	owner = makeUser();
	board = makeBoard({ owner, columns: COLUMNS });
	sent = effects();
});
afterEach(() => sent.restore());

type Tree = {
	name: string;
	create: (body: Record<string, unknown>, user?: SessionUser) => Promise<ApiResult>;
	update: (columnId: number, body: Record<string, unknown>, user?: SessionUser) => Promise<ApiResult>;
	remove: (columnId: number, user?: SessionUser) => Promise<ApiResult>;
	convert: (columnId: number, body: Record<string, unknown>, user?: SessionUser) => Promise<ApiResult>;
	/** Where a column sent with no position goes on a board whose Options column is at -1 and other columns at 0 to 4. */
	unplaced: number;
	action: string;
};

const TREES: Tree[] = [
	{
		name: 'the board page’s routes',
		create: (body, user = owner) => api('POST', '/api/columns', { user, body: { boardId: board.board.id, ...body } }),
		update: (columnId, body, user = owner) => api('PUT', `/api/columns/${columnId}`, { user, body }),
		remove: (columnId, user = owner) => api('DELETE', `/api/columns/${columnId}`, { user }),
		convert: (columnId, body, user = owner) => api('POST', `/api/columns/${columnId}/convert`, { user, body }),
		// Straight after the Options column, between it and the next (ruling s).
		unplaced: -0.5,
		action: 'column_converted_to_options'
	},
	{
		name: 'the documented routes',
		create: (body, user = owner) => api('POST', `/api/v1/boards/${board.board.id}/columns`, { user, body }),
		update: (columnId, body, user = owner) => api('PUT', `/api/v1/columns/${columnId}`, { user, body }),
		remove: (columnId, user = owner) => api('DELETE', `/api/v1/columns/${columnId}`, { user }),
		convert: (columnId, body, user = owner) => api('POST', `/api/v1/columns/${columnId}/convert`, { user, body }),
		// After the last column, as before (ruling s).
		unplaced: 5,
		action: 'api:column_converted_to_options'
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

/** A card's commitment as stored. */
const commitment = (cardId: number) =>
	sqlite.prepare('SELECT committed_at AS committedAt, committed_by AS committedBy FROM cards WHERE id = ?').get(cardId);

/** Make `column` the board's Options column in the database, at -1 with no limit, as the rules leave one. */
function asOptions(column: Column): void {
	sqlite.prepare("UPDATE columns SET role = 'options', position = -1, wip_limit = 0 WHERE id = ?").run(column.id);
}

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
		it('places the Options column left of every other column, whatever position is sent, with no WIP limit', async () => {
			const res = await tree.create({ title: 'Ideas', role: 'options', position: 10 });

			expect(res.status).toBe(201);
			expect(res.body).toMatchObject({ title: 'Ideas', role: 'options', position: -1, wipLimit: 0 });
			expect(stored(res.body.id)).toEqual({ title: 'Ideas', position: -1, role: 'options', wipLimit: 0 });
		});

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

		it('refuses an Options column on an ideas board, before anything else', async () => {
			sqlite.prepare("UPDATE boards SET kind = 'ideas' WHERE id = ?").run(board.board.id);

			await expectRefused(() => tree.create({ title: 'Done', role: 'options' }), 409, IDEAS_BOARD);
		});

		it('refuses a second Options column, before the title is looked at', async () => {
			asOptions(board.cols['Backlog']);

			await expectRefused(() => tree.create({ title: 'Done', role: 'options' }), 409, 'This board already has an Options column, "Backlog".');
		});

		it('refuses an Options column called To Do, On Hold or Complete (ruling x)', async () => {
			for (const [title, what] of [
				['To Do', 'a To Do column'],
				['on hold', 'an On Hold column'],
				['Waiting', 'an On Hold column'],
				['Done', 'a Complete column']
			]) {
				await expectRefused(
					() => tree.create({ title, role: 'options' }),
					409,
					`An Options column cannot be called "${title}", which makes a column ${what}. Choose another name.`
				);
			}
		});

		it('refuses a column at or left of the Options column, and places one sent with no position after it', async () => {
			asOptions(board.cols['Backlog']);

			await expectRefused(() => tree.create({ title: 'Review', position: -1 }), 409, LEFTMOST);
			await expectRefused(() => tree.create({ title: 'Review', position: -4 }), 409, LEFTMOST);

			const between = await tree.create({ title: 'Shaping', position: -0.25 });
			const unplaced = await tree.create({ title: 'Review' });
			expect([between.status, unplaced.status]).toEqual([201, 201]);
			expect(stored(between.body.id).position).toBe(-0.25);
			expect(stored(unplaced.body.id).position).toBe(tree.unplaced === -0.5 ? (-1 + -0.25) / 2 : tree.unplaced);
		});

		it('keeps every column sent with no position right of the Options column, however many are made (B1)', async () => {
			asOptions(board.cols['Backlog']);
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
			expect(rows[0]).toMatchObject({ id: board.cols['Backlog'].id, role: 'options' });
			expect(rows.slice(1).every((r) => r.position > rows[0].position)).toBe(true);
			expect(new Set(rows.map((r) => r.position)).size).toBe(rows.length);
			// From the page each goes straight after the Options column, so the newest is first after it.
			if (tree.unplaced === -0.5) expect(rows[1].id).toBe(made[made.length - 1]);
			else expect(rows[rows.length - 1].id).toBe(made[made.length - 1]);
		});
	});

	describe('on an existing column', () => {
		it('gives an empty column the role, moving it to the far left and its WIP limit to 0, and takes it away again', async () => {
			const column = board.cols['In Progress'];
			sqlite.prepare('UPDATE columns SET wip_limit = 4 WHERE id = ?').run(column.id);

			const given = await tree.update(column.id, { role: 'options' });
			expect(given.status).toBe(200);
			expect(stored(column.id)).toEqual({ title: 'In Progress', position: -1, role: 'options', wipLimit: 0 });

			const taken = await tree.update(column.id, { role: null });
			expect(taken.status).toBe(200);
			expect(stored(column.id)).toEqual({ title: 'In Progress', position: -1, role: null, wipLimit: 0 });
		});

		it('takes a new title with the role in one request, and holds the title as stored to ruling x (B9)', async () => {
			const complete = board.cols['Complete'];

			const res = await tree.update(complete.id, { title: 'Ideas', role: 'options' });
			expect(res.status).toBe(200);
			expect(stored(complete.id)).toEqual({ title: 'Ideas', position: -1, role: 'options', wipLimit: 0 });

			sqlite.prepare("UPDATE columns SET role = NULL, title = 'Spare' WHERE id = ?").run(complete.id);
			await sent.settle();
			sent.clear();
			await expectRefused(
				() => tree.update(board.cols['Backlog'].id, { title: '  ON HOLD ', role: 'options' }),
				409,
				'An Options column cannot be called "ON HOLD", which makes a column an On Hold column. Choose another name.'
			);
		});

		it('keeps the role when an update leaves it out (ruling r)', async () => {
			asOptions(board.cols['Backlog']);

			const res = await tree.update(board.cols['Backlog'].id, { title: 'Ideas', color: '#123456' });

			expect(res.status).toBe(200);
			expect(stored(board.cols['Backlog'].id)).toMatchObject({ title: 'Ideas', role: 'options' });
		});

		it('refuses a role that is not one, quoting what was sent', async () => {
			await expectRefused(() => tree.update(board.cols['Backlog'].id, { role: 7 }), 400, 'role must be "options" or null, not 7');
		});

		it('refuses the role on a column holding a card, archived ones included, and names the conversion: the menu item to the page, the operation to the API (ruling i, B5)', async () => {
			const column = board.cols['Backlog'];
			makeCard(column, { archivedAt: '2026-10-01 00:00:00' });
			const instead = tree.action.startsWith('api:') ? `POST /api/v1/columns/${column.id}/convert` : '"Make this the Options column…" in its menu';

			await expectRefused(
				() => tree.update(column.id, { role: 'options' }),
				409,
				`This column holds 1 card. Giving it the Options role would make it an option without anyone deciding it: convert it to the Options column instead (${instead}), which counts the cards first and records it.`
			);
			makeCard(column);
			await expectRefused(
				() => tree.update(column.id, { role: 'options' }),
				409,
				`This column holds 2 cards. Giving it the Options role would make them options without anyone deciding it: convert it to the Options column instead (${instead}), which counts the cards first and records it.`
			);
		});

		it('refuses to take the role away while the column holds cards, and says what to do with archived ones (U6)', async () => {
			const column = board.cols['Backlog'];
			asOptions(column);
			makeCard(column, { archivedAt: '2026-10-01 00:00:00' });
			await expectRefused(
				() => tree.update(column.id, { role: null }),
				409,
				'This Options column holds 1 archived card. Taking the role away would commit it without anyone committing it: restore and move it, or delete it, first.'
			);

			makeCard(column, { archivedAt: '2026-10-02 00:00:00' });
			await expectRefused(
				() => tree.update(column.id, { role: null }),
				409,
				'This Options column holds 2 archived cards. Taking the role away would commit them without anyone committing them: restore and move them, or delete them, first.'
			);

			makeCard(column);
			await expectRefused(
				() => tree.update(column.id, { role: null }),
				409,
				'This Options column holds 3 cards, 2 of them archived. Taking the role away would commit them without anyone committing them: move the others out of the column first, and restore and move, or delete, the archived ones.'
			);
		});

		it('refuses to take the role away while the column holds live cards, one or more', async () => {
			const column = board.cols['Backlog'];
			asOptions(column);
			makeCard(column);
			await expectRefused(
				() => tree.update(column.id, { role: null }),
				409,
				'This Options column holds 1 card. Taking the role away would commit it without anyone committing it: move it out of the column first.'
			);
			makeCard(column);
			await expectRefused(
				() => tree.update(column.id, { role: null }),
				409,
				'This Options column holds 2 cards. Taking the role away would commit them without anyone committing them: move them out of the column first.'
			);
		});

		it('refuses a second Options column', async () => {
			asOptions(board.cols['Backlog']);

			await expectRefused(() => tree.update(board.cols['In Progress'].id, { role: 'options' }), 409, 'This board already has an Options column, "Backlog".');
		});

		it('refuses the role on an ideas board', async () => {
			sqlite.prepare("UPDATE boards SET kind = 'ideas' WHERE id = ?").run(board.board.id);

			await expectRefused(() => tree.update(board.cols['Backlog'].id, { role: 'options' }), 409, IDEAS_BOARD);
		});

		it('refuses the role on a column called To Do, On Hold or Complete, and the Options column renamed so (ruling x)', async () => {
			await expectRefused(
				() => tree.update(board.cols['On Hold'].id, { role: 'options' }),
				409,
				'An Options column cannot be called "On Hold", which makes a column an On Hold column. Choose another name.'
			);
			asOptions(board.cols['Backlog']);
			await expectRefused(
				() => tree.update(board.cols['Backlog'].id, { title: 'Todo' }),
				409,
				'An Options column cannot be called "Todo", which makes a column a To Do column. Choose another name.'
			);
			await expectRefused(
				() => tree.update(board.cols['Backlog'].id, { title: 'Done' }),
				409,
				'An Options column cannot be called "Done", which makes a column a Complete column. Choose another name.'
			);
		});

		it('refuses a WIP limit on the Options column, set on it or sent with the role', async () => {
			await expectRefused(() => tree.update(board.cols['Backlog'].id, { role: 'options', wipLimit: 2 }), 409, 'An Options column has no WIP limit.');
			asOptions(board.cols['Backlog']);
			await expectRefused(() => tree.update(board.cols['Backlog'].id, { wipLimit: 3 }), 409, 'An Options column has no WIP limit.');

			const none = await tree.update(board.cols['Backlog'].id, { wipLimit: 0 });
			expect(none.status).toBe(200);
		});

		it('refuses a WIP limit above 0 on an Options column being created, as the update does, where it was made with 0 (the S6 review\'s Q8)', async () => {
			await expectRefused(() => tree.create({ title: 'Ideas', role: 'options', wipLimit: 3 }), 409, 'An Options column has no WIP limit.');
			await expectRefused(() => tree.create({ title: 'Ideas', role: 'options', wipLimit: '2' }), 409, 'An Options column has no WIP limit.');

			// A limit of 0, or none, is what an Options column has: made, at the far left, with 0.
			const zero = await tree.create({ title: 'Ideas', role: 'options', wipLimit: 0 });
			expect(zero.status).toBe(201);
			expect(stored(zero.body.id)).toMatchObject({ role: 'options', wipLimit: 0 });
			// An ordinary column is made as before: a limit sent with it is not stored.
			const ordinary = await tree.create({ title: 'Review', wipLimit: 3 });
			expect(ordinary.status).toBe(201);
			expect(stored(ordinary.body.id)).toMatchObject({ role: null, wipLimit: 0 });
		});

		it('keeps the Options column the leftmost: no column moved to or past it, and it moved to no other column', async () => {
			asOptions(board.cols['Backlog']);

			await expectRefused(() => tree.update(board.cols['To Do'].id, { position: -1 }), 409, LEFTMOST);
			await expectRefused(() => tree.update(board.cols['Complete'].id, { position: -2 }), 409, LEFTMOST);
			await expectRefused(() => tree.update(board.cols['Backlog'].id, { position: 3 }), 409, LEFTMOST);

			const further = await tree.update(board.cols['Backlog'].id, { position: -3 });
			const moved = await tree.update(board.cols['Complete'].id, { position: 0.5 });
			expect([further.status, moved.status]).toEqual([200, 200]);
		});
	});

	describe('deleting the Options column (ruling m)', () => {
		it('is refused while it holds an option that is not archived', async () => {
			asOptions(board.cols['Backlog']);
			makeCard(board.cols['Backlog']);
			await expectRefused(() => tree.remove(board.cols['Backlog'].id), 409, 'This Options column still holds 1 option: move it out, or archive it to discard it, first.');

			makeCard(board.cols['Backlog']);
			await expectRefused(() => tree.remove(board.cols['Backlog'].id), 409, 'This Options column still holds 2 options: move them out, or archive them to discard them, first.');
		});

		it('deletes it with its archived cards, and an empty one, as any column', async () => {
			asOptions(board.cols['Backlog']);
			const archived = makeCard(board.cols['Backlog'], { archivedAt: '2026-10-01 00:00:00' });

			const res = await tree.remove(board.cols['Backlog'].id);

			expect(res.status).toBe(200);
			expect(sqlite.prepare('SELECT id FROM cards WHERE id = ?').get(archived.id)).toBeUndefined();
			expect(sqlite.prepare('SELECT id FROM columns WHERE id = ?').get(board.cols['Backlog'].id)).toBeUndefined();
		});

		it('leaves every other column to be deleted with its cards, as before', async () => {
			makeCard(board.cols['In Progress']);

			expect((await tree.remove(board.cols['In Progress'].id)).status).toBe(200);
		});
	});

	describe('converting a column to the Options column, cards and all (ruling i)', () => {
		it('makes every card in it an option, places it at the far left with no limit, and writes one entry and nothing else', async () => {
			makeSmtp();
			makeWebhook(board.board);
			const member = makeUser();
			addBoardMember(board.board, member, 'editor');
			const column = board.cols['In Progress'];
			sqlite.prepare('UPDATE columns SET wip_limit = 3 WHERE id = ?').run(column.id);
			const live = [makeCard(column, { createdBy: member.id }), makeCard(column, { createdBy: owner.id })];
			const archived = makeCard(column, { createdBy: member.id, archivedAt: '2026-10-01 00:00:00' });
			const elsewhere = makeCard(board.cols['To Do'], { createdBy: member.id });
			expect(commitment(live[0].id)).toMatchObject({ committedBy: member.id });

			const res = await tree.convert(column.id, { role: 'options', cards: 3 });
			await sent.settle();

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(res.body).toMatchObject({ id: column.id, role: 'options', position: -1, wipLimit: 0 });
			expect(stored(column.id)).toEqual({ title: 'In Progress', position: -1, role: 'options', wipLimit: 0 });
			for (const card of [...live, archived]) expect(commitment(card.id)).toEqual({ committedAt: null, committedBy: null });
			expect(commitment(elsewhere.id)).toMatchObject({ committedBy: member.id });

			const entries = sqlite.prepare('SELECT action, detail, source, card_id AS cardId, user_id AS userId FROM activity_log WHERE board_id = ?').all(board.board.id);
			expect(entries).toEqual([
				{ action: tree.action, detail: `"In Progress": 3 cards became options (column ${column.id})`, source: tree.action.startsWith('api:') ? 'api' : 'ui', cardId: null, userId: owner.id }
			]);
			// No webhook, no mail, and the board told once.
			expect(sent.webhooks).toEqual([]);
			expect(sent.emails).toEqual([]);
			expect(sent.events.map((e) => `${e.event} (${e.data.type})`)).toEqual(['update (column)']);
			expect(sent.duringTransaction).toEqual([]);
		});

		it('converts a column of one card, and says "1 card became an option", naming the column at the end (B2)', async () => {
			makeCard(board.cols['Backlog']);

			const res = await tree.convert(board.cols['Backlog'].id, { role: 'options', cards: 1 });

			expect(res.status).toBe(200);
			expect(sqlite.prepare('SELECT detail FROM activity_log').all()).toEqual([
				{ detail: `"Backlog": 1 card became an option (column ${board.cols['Backlog'].id})` }
			]);
		});

		it('refuses a count that no longer matches, so a card moved in since is not made an option unseen', async () => {
			makeCard(board.cols['Backlog']);
			makeCard(board.cols['Backlog'], { archivedAt: '2026-10-01 00:00:00' });

			await expectRefused(() => tree.convert(board.cols['Backlog'].id, { role: 'options', cards: 1 }), 409, 'The column now holds 2 cards; look again.');
		});

		it('is the owner’s or an administrator’s, not an editor’s', async () => {
			const editor = makeUser();
			addBoardMember(board.board, editor, 'editor');
			const admin = makeUser({ role: 'admin' });

			await expectRefused(
				() => tree.convert(board.cols['Backlog'].id, { role: 'options', cards: 0 }, editor),
				403,
				"Only the board's owner or an administrator can convert a column to the Options column"
			);
			expect((await tree.convert(board.cols['Backlog'].id, { role: 'options', cards: 0 }, admin)).status).toBe(200);
		});

		it('reads role, which must be "options", and cards, a whole number', async () => {
			await expectRefused(() => tree.convert(board.cols['Backlog'].id, { role: null, cards: 0 }), 400, 'role must be "options", not null');
			await expectRefused(() => tree.convert(board.cols['Backlog'].id, { role: 'options' }), 400, 'cards is required');
			// Left out, it is required, in the same shape as `cards` (the S1b review's B3).
			await expectRefused(() => tree.convert(board.cols['Backlog'].id, { cards: 0 }), 400, 'role is required');
			await expectRefused(() => tree.convert(board.cols['Backlog'].id, { role: 'backlog', cards: 0 }), 400, 'role must be "options", not "backlog"');
		});

		it('refuses, in order: an ideas board, a board with an Options column, a column so titled, a card with a sub-board', async () => {
			// A card with a sub-board, in a column called Complete, on a board that has an Options column.
			const parent = makeCard(board.cols['Complete'], { title: 'Parent' });
			makeBoard({ owner, parentCardId: parent.id });
			asOptions(board.cols['Backlog']);
			sqlite.prepare("UPDATE boards SET kind = 'ideas' WHERE id = ?").run(board.board.id);
			const complete = board.cols['Complete'].id;

			await expectRefused(() => tree.convert(complete, { role: 'options', cards: 1 }), 409, IDEAS_BOARD);
			sqlite.prepare("UPDATE boards SET kind = 'delivery' WHERE id = ?").run(board.board.id);
			await expectRefused(() => tree.convert(complete, { role: 'options', cards: 1 }), 409, 'This board already has an Options column, "Backlog".');
			await expectRefused(() => tree.convert(board.cols['Backlog'].id, { role: 'options', cards: 0 }), 409, 'This board already has an Options column, "Backlog".');
			sqlite.prepare('UPDATE columns SET role = NULL WHERE id = ?').run(board.cols['Backlog'].id);
			await expectRefused(
				() => tree.convert(complete, { role: 'options', cards: 1 }),
				409,
				'An Options column cannot be called "Complete", which makes a column a Complete column. Choose another name.'
			);
			sqlite.prepare("UPDATE columns SET title = 'Shipped' WHERE id = ?").run(complete);
			await expectRefused(
				() => tree.convert(complete, { role: 'options', cards: 1 }),
				409,
				'Card "Parent" has a sub-board, and a card with sub-boards is never an option: move it out of this column first.'
			);
		});
	});
});

describe('the column order, on the board page’s reorder', () => {
	const reorder = (updates: { id: number; position: number }[]) => api('PUT', '/api/columns/reorder', { user: owner, body: { updates } });

	it('refuses, whole, an order that puts any column at or left of the Options column', async () => {
		asOptions(board.cols['Backlog']);
		const ids = COLUMNS.map((title) => board.cols[title].id);

		await expectRefused(() => reorder([{ id: ids[1], position: 0 }, { id: ids[0], position: 1 }, { id: ids[2], position: 2 }]), 409, LEFTMOST);
		await expectRefused(() => reorder([{ id: ids[4], position: -1 }]), 409, LEFTMOST);
		// The Options column moved to the right of another (B9).
		await expectRefused(() => reorder([{ id: ids[0], position: 2.5 }]), 409, LEFTMOST);
		await expectRefused(() => reorder([{ id: ids[0], position: 9 }, { id: ids[1], position: -2 }]), 409, LEFTMOST);

		// The page sends every column at its index, the Options column first.
		const res = await reorder(ids.map((id, position) => ({ id, position })));
		expect(res.status).toBe(200);
		expect(ids.map((id) => stored(id).position)).toEqual([0, 1, 2, 3, 4]);
	});

	it('reorders a board with no Options column as before', async () => {
		const res = await reorder([{ id: board.cols['Complete'].id, position: -5 }]);
		expect(res.status).toBe(200);
	});
});

describe('the Options strip on the board page (ruling g)', () => {
	it('gives each card in the Options column when it became an option: its latest return to options, else its creation', () => {
		asOptions(board.cols['Backlog']);
		const fresh = makeCard(board.cols['Backlog'], { createdAt: '2026-09-01 08:00:00' });
		const returned = makeCard(board.cols['Backlog'], { createdAt: '2026-06-01 08:00:00' });
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

	it('counts a converted card as an option from the conversion, not from its creation (B2), and no other column’s conversion', async () => {
		const backlog = board.cols['Backlog'];
		const old = makeCard(backlog, { createdAt: '2025-01-01 08:00:00' });
		const res = await api('POST', `/api/columns/${backlog.id}/convert`, { user: owner, body: { role: 'options', cards: 1 } });
		expect(res.status).toBe(200);
		const convertedAt = (sqlite.prepare("SELECT created_at AS at FROM activity_log WHERE action = 'column_converted_to_options'").get() as { at: string }).at;
		// Moved back a day, so the conversion is plainly not the card's creation or now.
		sqlite.prepare("UPDATE activity_log SET created_at = '2026-10-20 08:00:00' WHERE action = 'column_converted_to_options'").run();
		expect(convertedAt > '2025-01-01 08:00:00').toBe(true);
		const later = makeCard(backlog, { createdAt: '2026-10-22 08:00:00' });
		// Another column's conversion on the same board, later still, names another id and is not this column's.
		const entry = sqlite.prepare('INSERT INTO activity_log (board_id, action, detail, created_at) VALUES (?, ?, ?, ?)');
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

	it('opens the list view on To Do, else on the first column that is not the Options column', () => {
		const options = { id: 1, title: 'Ideas', role: 'options' };
		expect(defaultListColumn([options, { id: 2, title: 'Doing', role: null }, { id: 3, title: 'To Do', role: null }])).toBe(3);
		expect(defaultListColumn([options, { id: 2, title: 'Doing', role: null }])).toBe(2);
		expect(defaultListColumn([options])).toBe(1);
	});
});
