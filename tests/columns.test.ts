/**
 * A column's WIP limit, and a rename that would change what its cards mean,
 * through the two routes that update a column.
 *
 * `columns.wip_limit` is NOT NULL: a limit of 0 means no limit, and there is no
 * such thing as a column without one. Both routes used to hand whatever the
 * request carried straight to the database, so a `null`, which the API
 * document said the field could be, was refused by the database and answered
 * 500. The board page was not how one got sent: it turns an emptied box into
 * 0 before it sends.
 *
 * `/api/columns/[id]` is the route the board page uses, and
 * `/api/v1/columns/[columnId]` is the documented one. They are two handlers
 * and are tested as two.
 *
 * And what a column means once it can be the board's Options column, or be on
 * an ideas board (milestone 22): the helpers in `$lib/column-role` and
 * `$lib/server/upstream` that every rule about upstream asks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sqlite } from '$lib/server/db';
import type { Column } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { api } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { makeBoard, makeCard, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';
import {
	BOARD_KINDS,
	COLUMN_ROLES,
	columnRoleOf,
	completeColumnIds,
	firstOpenColumn,
	holdColumnIds,
	isOptionsColumn,
	isUpstreamColumn,
	todoColumnIds
} from '$lib/column-role';
import { UPSTREAM, boardKinds, isUpstreamColumnId, upstreamColumnIds, upstreamCondition } from '$lib/server/upstream';

let owner: SessionUser;
let board: BoardFixture;

beforeEach(() => {
	resetDb();
	owner = makeUser();
	board = makeBoard({ owner });
});

/** What the database holds for a column's limit, and what kind of value it is. */
const stored = (columnId: number) =>
	sqlite.prepare('SELECT wip_limit AS wipLimit, typeof(wip_limit) AS kind FROM columns WHERE id = ?').get(columnId);

const ROUTES: [string, (columnId: number) => string][] = [
	['the board page’s route', (columnId) => `/api/columns/${columnId}`],
	['the documented route', (columnId) => `/api/v1/columns/${columnId}`]
];

describe.each(ROUTES)('a WIP limit sent to %s', (_name, pathOf) => {
	it.each<[string, unknown, number]>([
		['null, which is how a limit is cleared', null, 0],
		['a negative number', -3, 0],
		['a fraction', 2.9, 2],
		['text that is not a number', 'abc', 0],
		['a whole number', 5, 5]
	])('is stored as a whole number of 0 or more: %s', async (_what, sent, kept) => {
		const column = board.cols['In Progress'];
		// Something other than the answer, so that a request which changed nothing does not pass.
		sqlite.prepare('UPDATE columns SET wip_limit = 9 WHERE id = ?').run(column.id);

		const res = await api('PUT', pathOf(column.id), { user: owner, body: { wipLimit: sent } });

		// Never a 500, whatever was sent: the database is not asked to take a NULL.
		expect(res.status).toBe(200);
		expect(res.body.wipLimit).toBe(kept);
		expect(stored(column.id)).toEqual({ wipLimit: kept, kind: 'integer' });
	});

	it('clears a limit that was set, and can set it again', async () => {
		const column = board.cols['In Progress'];
		const put = (wipLimit: unknown) => api('PUT', pathOf(column.id), { user: owner, body: { wipLimit } });

		expect((await put(4)).body.wipLimit).toBe(4);
		// What the board page sends when the number input has been emptied.
		const cleared = await put(null);
		expect(cleared.status).toBe(200);
		expect(cleared.body.wipLimit).toBe(0);
		expect(stored(column.id)).toEqual({ wipLimit: 0, kind: 'integer' });
		expect((await put(2)).body.wipLimit).toBe(2);
	});

	it('reads a number sent as text as that number', async () => {
		// A form sends "5". Before the limit was tidied the column's INTEGER
		// affinity turned that into 5, and it must not become "no limit" now.
		const column = board.cols['In Progress'];

		const res = await api('PUT', pathOf(column.id), { user: owner, body: { wipLimit: '5' } });

		expect(res.status).toBe(200);
		expect(stored(column.id)).toEqual({ wipLimit: 5, kind: 'integer' });
	});

	it('leaves the limit alone when the request does not mention it', async () => {
		const column = board.cols['In Progress'];
		sqlite.prepare('UPDATE columns SET wip_limit = 6 WHERE id = ?').run(column.id);

		const res = await api('PUT', pathOf(column.id), { user: owner, body: { title: 'Doing' } });

		expect(res.status).toBe(200);
		expect(res.body.title).toBe('Doing');
		expect(stored(column.id)).toEqual({ wipLimit: 6, kind: 'integer' });
	});
});

/**
 * A card is finished because the column it is in is called Complete or Done
 * (card 2134). A rename into either, or out of them, would change what every
 * card in the column means without one of them being moved: "Complete" renamed
 * "Completed" turned finished work into open work on every screen, and a
 * column renamed "Done" made its cards finished with no date, no XP and no
 * entry. So it is refused while the column holds a card, archived ones
 * included, and every completion and reopening goes through a move.
 */
describe.each(ROUTES)('renaming a column through %s', (_name, pathOf) => {
	let sent: Effects;
	beforeEach(() => {
		sent = effects();
	});
	afterEach(() => sent.restore());

	const rename = (column: Column, title: string) => api('PUT', pathOf(column.id), { user: owner, body: { title } });
	const titleOf = (columnId: number) =>
		(sqlite.prepare('SELECT title FROM columns WHERE id = ?').get(columnId) as { title: string }).title;

	/** Rename it, and expect 409 with `message`, nothing written and nothing sent. */
	async function expectRefused(column: Column, title: string, message: string): Promise<void> {
		const before = snapshotDb();

		const res = await rename(column, title);
		await sent.settle();

		expect(res.status).toBe(409);
		expect(res.body).toEqual({ message });
		expectUnchanged(before);
		expect(sent.all).toEqual([]);
	}

	it('refuses to make a column that holds a card a Complete column', async () => {
		makeCard(board.cols['In Progress']);

		await expectRefused(
			board.cols['In Progress'],
			'Done',
			'This column holds 1 card. Renaming it to "Done" would mark it finished without anyone finishing it. ' +
				'Move each finished card to a Complete column and the rest out of this one first, or choose another name.'
		);
	});

	it('refuses to rename Complete to Completed, which is not a Complete column, while it holds cards', async () => {
		makeCard(board.cols['Complete']);
		makeCard(board.cols['Complete']);

		await expectRefused(
			board.cols['Complete'],
			'Completed',
			'This column holds 2 cards. They count as finished because the column is called Complete or Done, and renaming it to ' +
				'"Completed" would turn them back into open work. Keep it called Complete or Done.'
		);
	});

	it('counts an archived card, which a restore would put back in the column', async () => {
		makeCard(board.cols['Complete'], { archivedAt: '2026-10-01 00:00:00' });

		await expectRefused(
			board.cols['Complete'],
			'Shipped',
			'This column holds 1 card, which is archived. It counts as finished because the column is called Complete or Done, and ' +
				'renaming it to "Shipped" would turn it back into open work. Keep it called Complete or Done.'
		);
	});

	it('says how many of the cards it holds are archived', async () => {
		makeCard(board.cols['On Hold']);
		makeCard(board.cols['On Hold']);
		makeCard(board.cols['On Hold'], { archivedAt: '2026-10-01 00:00:00' });
		makeCard(board.cols['To Do'], { archivedAt: '2026-10-01 00:00:00' });
		makeCard(board.cols['To Do'], { archivedAt: '2026-10-01 00:00:00' });

		const onHold = await rename(board.cols['On Hold'], 'complete');
		const toDo = await rename(board.cols['To Do'], 'Done');

		expect(onHold.body.message).toMatch(/^This column holds 3 cards, 1 of them archived\. Renaming it to "complete" would/);
		expect(toDo.body.message).toMatch(/^This column holds 2 cards, all of them archived\. Renaming it to "Done" would/);
	});

	it('renames an empty column into a Complete column and out again', async () => {
		const empty = board.cols['On Hold'];

		const into = await rename(empty, 'Done');
		const outOf = await rename(empty, 'Staging');
		await sent.settle();

		expect([into.status, outOf.status]).toEqual([200, 200]);
		expect(titleOf(empty.id)).toBe('Staging');
		expect(sent.events.map((e) => `${e.event} (${e.data.type})`)).toEqual(['update (column)', 'update (column)']);
	});

	it('renames a column holding cards when the new title keeps what it means', async () => {
		makeCard(board.cols['Complete']);
		makeCard(board.cols['To Do']);

		const complete = await rename(board.cols['Complete'], '  DONE ');
		const toDo = await rename(board.cols['To Do'], 'Backlog');

		expect([complete.status, toDo.status]).toEqual([200, 200]);
		expect(titleOf(board.cols['Complete'].id)).toBe('DONE');
		expect(titleOf(board.cols['To Do'].id)).toBe('Backlog');
	});
});

describe('the WIP limit in the API document', () => {
	it('is an integer that is never null in a column, and may be sent as null to clear it', async () => {
		const res = await api('GET', '/api/v1/openapi.json');
		expect(res.status).toBe(200);

		// What comes back. It used to say `['integer', 'null']`, and a null is
		// something the column cannot hold.
		const returned = res.body.components.schemas.Column.properties.wipLimit;
		expect(returned.type).toBe('integer');
		expect(returned.minimum).toBe(0);
		expect(returned.description).toContain('0 means no limit');

		// What may be sent. A null is accepted, and the document says what becomes of it.
		const sent =
			res.body.paths['/api/v1/columns/{columnId}'].put.requestBody.content['application/json'].schema.properties.wipLimit;
		expect(sent.type).toEqual(['integer', 'null']);
		expect(sent.description).toContain('0 meaning no limit');
		expect(sent.description).toContain('null is accepted and stored as 0');
		// `nullable` is not a keyword of OpenAPI 3.1, which this document is.
		expect(sent).not.toHaveProperty('nullable');
		expect(res.body.openapi).toBe('3.1.0');
	});
});

describe('what a column means, with the Options role and the ideas board (milestone 22)', () => {
	/** A column as the helpers read one: a title, a place, and a role or none. */
	const col = (id: number, title: string, position: number, role: string | null = null) => ({ id, title, position, role });

	it('knows one stored role and two kinds of board', () => {
		expect(COLUMN_ROLES).toEqual(['options']);
		expect(BOARD_KINDS).toEqual(['delivery', 'ideas']);
	});

	it('takes a card as upstream in the Options column or on an ideas board, and nowhere else', () => {
		expect(isOptionsColumn({ role: 'options' })).toBe(true);
		for (const role of [null, 'backlog', 'Options']) expect(isOptionsColumn({ role }), String(role)).toBe(false);
		expect(isUpstreamColumn({ role: 'options' }, 'delivery')).toBe(true);
		expect(isUpstreamColumn({ role: null }, 'ideas')).toBe(true);
		expect(isUpstreamColumn({ role: null }, 'delivery')).toBe(false);
		// A board of another kind is a delivery board, and one whose kind is not there is not an ideas board.
		expect(isUpstreamColumn({ role: null }, 'portfolio')).toBe(false);
		expect(isUpstreamColumn({ role: null }, null)).toBe(false);
	});

	it('reads the Options role before the title, so an Options column is never To Do, On Hold or Complete', () => {
		expect(columnRoleOf({ title: 'To Do', role: 'options' })).toBe('options');
		expect(columnRoleOf({ title: 'On Hold', role: 'options' })).toBe('options');
		expect(columnRoleOf({ title: 'Ideas', role: 'options' })).toBe('options');
		expect(columnRoleOf({ title: 'To Do', role: null })).toBe('todo');
		expect(columnRoleOf({ title: 'Done', role: null })).toBe('complete');
		expect(columnRoleOf({ title: 'Doing', role: null })).toBeNull();

		const columns = [col(1, 'To Do', 0, 'options'), col(2, 'To Do', 1), col(3, 'On Hold', 2), col(4, 'Done', 3)];
		expect([...todoColumnIds(columns)]).toEqual([2]);
		expect([...holdColumnIds([col(5, 'Waiting', 0, 'options'), col(3, 'On Hold', 1)])]).toEqual([3]);
		expect([...completeColumnIds([col(6, 'Done', 0, 'options'), col(4, 'Done', 1)])]).toEqual([4]);
		// Columns with no role are read as before, by title alone.
		expect([...todoColumnIds([{ id: 7, title: 'todo', role: null }])]).toEqual([7]);
	});

	it('puts new work in the first open column that is not Options, and never in Options, even with nothing else open (card 2527, R5)', () => {
		const options = col(1, 'Options', -1, 'options');
		expect(firstOpenColumn([col(3, 'Complete', 2), col(2, 'To Do', 0), options])?.id).toBe(2);
		// Every delivery board has its Options column: a board whose only other
		// column is Complete has no open column, and each caller does what it
		// does for none, rather than hide new work in the folded strip.
		expect(firstOpenColumn([options, col(3, 'Complete', 2)])).toBeUndefined();
		expect(firstOpenColumn([options])).toBeUndefined();
		expect(firstOpenColumn([col(3, 'Complete', 2)])).toBeUndefined();
		// As before, for a board with no Options column.
		expect(firstOpenColumn([col(4, 'Done', 0), col(5, 'Doing', 1)])?.id).toBe(5);
		// The role is read first: an Options column called Done is still never taken.
		expect(firstOpenColumn([col(6, 'Done', 0, 'options'), col(7, 'Complete', 1)])).toBeUndefined();
	});

	it('reads the boards’ kinds and the columns that are upstream from the database', () => {
		const options = board.cols['To Do'];
		sqlite.prepare("UPDATE columns SET role = 'options' WHERE id = ?").run(options.id);
		const ideas = makeBoard({ owner, columns: ['New Ideas', 'Shaping'] });
		sqlite.prepare("UPDATE boards SET kind = 'ideas' WHERE id = ?").run(ideas.board.id);
		const read = (id: number) => sqlite.prepare('SELECT id, board_id AS boardId, role FROM columns WHERE id = ?').get(id) as {
			id: number;
			boardId: number;
			role: string | null;
		};

		expect(boardKinds([board.board.id, ideas.board.id, board.board.id, 999])).toEqual(
			new Map([
				[board.board.id, 'delivery'],
				[ideas.board.id, 'ideas']
			])
		);
		expect(boardKinds([])).toEqual(new Map());
		const all = [options.id, board.cols['In Progress'].id, ideas.cols['New Ideas'].id, ideas.cols['Shaping'].id].map(read);
		expect([...upstreamColumnIds(all)].sort((a, b) => a - b)).toEqual([options.id, ideas.cols['New Ideas'].id, ideas.cols['Shaping'].id]);
		expect(isUpstreamColumnId(options.id)).toBe(true);
		expect(isUpstreamColumnId(ideas.cols['Shaping'].id)).toBe(true);
		expect(isUpstreamColumnId(board.cols['Complete'].id)).toBe(false);
		expect(isUpstreamColumnId(999)).toBe(false);
		// The same rule as SQL, for the readers that write their own.
		const upstreamIds = sqlite
			.prepare(`SELECT col.id FROM columns col JOIN boards b ON b.id = col.board_id WHERE ${UPSTREAM} ORDER BY col.id`)
			.all()
			.map((row) => (row as { id: number }).id);
		expect(upstreamIds).toEqual([options.id, ideas.cols['New Ideas'].id, ideas.cols['Shaping'].id]);
		expect(upstreamCondition('c', 'bd')).toBe("(c.role IS 'options' OR bd.kind IS 'ideas')");
	});

	it('is false, never NULL, as SQL for an ordinary column, so that NOT the rule finds every committed card (the S1a review, R1)', () => {
		// A delivery board with one card in To Do, the role NULL: `role = 'options'`
		// was NULL there, and NOT of it found no card at all.
		const card = makeCard(board.cols['To Do']);
		const ideas = makeBoard({ owner, columns: ['New Ideas'] });
		sqlite.prepare("UPDATE boards SET kind = 'ideas' WHERE id = ?").run(ideas.board.id);
		const idea = makeCard(ideas.cols['New Ideas']);
		const ids = (where: string, join = 'JOIN') =>
			(
				sqlite
					.prepare(
						`SELECT c.id FROM cards c ${join} columns col ON col.id = c.column_id ${join} boards b ON b.id = col.board_id WHERE ${where} ORDER BY c.id`
					)
					.all() as { id: number }[]
			).map((row) => row.id);

		expect(ids(`NOT ${UPSTREAM}`)).toEqual([card.id]);
		expect(ids(UPSTREAM)).toEqual([idea.id]);
		// A card whose column is not there, under a LEFT JOIN: not upstream, so committed.
		sqlite.pragma('foreign_keys = OFF');
		try {
			sqlite.prepare("INSERT INTO cards (id, column_id, title) VALUES (9999, 9999, 'On no column')").run();
		} finally {
			sqlite.pragma('foreign_keys = ON');
		}
		expect(ids(`NOT ${UPSTREAM}`, 'LEFT JOIN')).toEqual([card.id, 9999]);
		expect(ids(UPSTREAM, 'LEFT JOIN')).toEqual([idea.id]);
		sqlite.prepare('DELETE FROM cards WHERE id = 9999').run();
	});
});
