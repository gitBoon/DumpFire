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
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sqlite } from '$lib/server/db';
import type { Column } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { api } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { makeBoard, makeCard, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

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
