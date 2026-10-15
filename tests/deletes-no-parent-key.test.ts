/**
 * A permanent delete on a database whose `boards.parent_card_id` has no
 * foreign key.
 *
 * On a new database a sub-board goes with its card by cascade. A database
 * where the migration runner left `boards` in the shape it had has no such
 * key, and there nothing removes a sub-board but the delete itself. So the
 * shared delete names every sub-board it finds, at every depth, and does not
 * lean on the cascade.
 *
 * This file is on its own because it rebuilds `boards` without the key, and
 * every test in a file shares one database.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { boards, cardAttachments, cards, subtasks, workDependencies } from '$lib/server/db/schema';
import { api, type ApiResult } from './helpers/api';
import {
	makeAttachment,
	makeBoard,
	makeCard,
	makeDependency,
	makeSubBoard,
	makeSubtask,
	makeUser,
	resetDb,
	testUploadsDir
} from './helpers/fixtures';

type Key = { from: string; table: string };
const keysOfBoards = () => sqlite.pragma('foreign_key_list(boards)') as Key[];

beforeAll(() => {
	expect(keysOfBoards().map((k) => k.from)).toContain('parent_card_id');

	const ddl = (
		sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'boards'").get() as { sql: string }
	).sql;
	const withoutKey = ddl
		// The key as a constraint of the table, which is how the model writes it.
		.replace(/,\s*FOREIGN KEY \(`?parent_card_id`?\)[^\n]*?cascade/i, '')
		// And as part of the column, which is how the migration that added it did.
		.replace(/(parent_card_id`?\s+integer)\s+REFERENCES[^,\n]*/i, '$1')
		.replace(/CREATE TABLE\s+[`"]?boards[`"]?/i, 'CREATE TABLE `boards_without_key`');

	// SQLite's own way to change a table: build the new one, copy, swap.
	sqlite.pragma('foreign_keys = OFF');
	try {
		sqlite.transaction(() => {
			sqlite.exec(withoutKey);
			sqlite.exec('INSERT INTO boards_without_key SELECT * FROM boards');
			sqlite.exec('DROP TABLE boards');
			sqlite.exec('ALTER TABLE boards_without_key RENAME TO boards');
		})();
	} finally {
		sqlite.pragma('foreign_keys = ON');
	}

	// The key is gone, and the others are as they were.
	expect(keysOfBoards().map((k) => k.from)).toEqual(['created_by']);
	expect(sqlite.pragma('foreign_key_check')).toEqual([]);
});

beforeEach(resetDb);

/** A card on board A with a sub-board two levels deep, and a card on board B. */
function scene() {
	const owner = makeUser({ username: 'owner' });
	const admin = makeUser({ username: 'admin', role: 'admin' });
	const A = makeBoard({ owner, name: 'A' });
	const B = makeBoard({ owner, name: 'B' });
	const top = makeCard(A.cols['To Do'], { title: 'Top' });
	const stays = makeCard(B.cols['To Do'], { title: 'Stays' });
	const S1 = makeSubBoard(top, { owner });
	const S2 = makeSubBoard(S1.cards[0], { owner });
	const deep = S2.cards[0];
	const files = [top, S1.cards[0], deep].map((card) => makeAttachment(card));
	makeDependency({ blocked: stays, blocker: deep });
	makeDependency({ blocked: makeSubtask(deep), blocker: makeSubtask(stays) });
	return { owner, admin, A, B, top, stays, S1, S2, deep, files };
}
type Scene = ReturnType<typeof scene>;

describe('with no foreign key from a sub-board to its card', () => {
	it('deleting the card with a statement alone leaves its sub-boards, which is why they are named', () => {
		const s = scene();
		db.delete(cards).where(eq(cards.id, s.top.id)).run();
		expect(db.select({ id: boards.id }).from(boards).all().map((b) => b.id)).toContain(s.S1.board.id);
	});

	it.each<{ what: string; call: (s: Scene) => Promise<ApiResult>; left: (s: Scene) => number[] }>([
		{
			what: 'a card, through the internal API',
			call: (s) => api('DELETE', `/api/cards/${s.top.id}?permanent=true`, { user: s.owner }),
			left: (s) => [s.A.board.id, s.B.board.id]
		},
		{
			what: 'a card, through the v1 API',
			call: (s) => api('DELETE', `/api/v1/cards/${s.top.id}?permanent=true`, { user: s.owner }),
			left: (s) => [s.A.board.id, s.B.board.id]
		},
		{
			what: 'a column',
			call: (s) => api('DELETE', `/api/columns/${s.A.cols['To Do'].id}`, { user: s.owner }),
			left: (s) => [s.A.board.id, s.B.board.id]
		},
		{
			what: 'a board, through the internal API',
			call: (s) => api('DELETE', `/api/boards/${s.A.board.id}`, { user: s.owner }),
			left: (s) => [s.B.board.id]
		},
		{
			what: 'a board, through the v1 API',
			call: (s) => api('DELETE', `/api/v1/boards/${s.A.board.id}`, { user: s.owner }),
			left: (s) => [s.B.board.id]
		},
		{
			what: 'the archived cards',
			call: (s) => {
				db.update(cards).set({ archivedAt: '2026-10-01T09:00:00.000Z' }).where(eq(cards.id, s.top.id)).run();
				return api('POST', '/api/admin/purge-archived', { user: s.admin });
			},
			left: (s) => [s.A.board.id, s.B.board.id]
		},
		{
			what: 'the cards of a board',
			call: (s) => api('POST', `/api/admin/boards/${s.A.board.id}/clear-cards`, { user: s.admin }),
			left: (s) => [s.A.board.id, s.B.board.id]
		}
	])('deleting $what takes every sub-board, at every depth, and what was on it', async ({ call, left }) => {
		const s = scene();

		expect((await call(s)).status).toBe(200);

		expect(db.select({ id: boards.id }).from(boards).all().map((b) => b.id)).toEqual(left(s));
		expect(db.select({ id: cards.id }).from(cards).all()).toEqual([{ id: s.stays.id }]);
		expect(db.select({ cardId: subtasks.cardId }).from(subtasks).all()).toEqual([{ cardId: s.stays.id }]);
		expect(db.select().from(workDependencies).all()).toEqual([]);
		expect(db.select().from(cardAttachments).all()).toEqual([]);
		for (const file of s.files) {
			expect(existsSync(join(testUploadsDir(), '.trash', String(file.cardId), file.filename))).toBe(true);
			expect(existsSync(join(testUploadsDir(), String(file.cardId)))).toBe(false);
		}
		// Nothing is left pointing at a row that went.
		expect(sqlite.pragma('foreign_key_check')).toEqual([]);
	});
});
