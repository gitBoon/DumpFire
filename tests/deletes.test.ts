/**
 * What a delete removes, and what it leaves.
 *
 * Archiving a card touches nothing but the card. Deleting a card, a column or
 * a board for good takes everything under it, at every depth of sub-board,
 * and three things no foreign key takes: the dependency links of what went,
 * the files of its attachments, and what named a deleted board by id.
 *
 * The permanent deletes are judged by what is left. A fixture is built with
 * work inside the tree to be deleted and outside it, and links crossing
 * between; the rows expected afterwards are worked out from the rows before,
 * in this file and not by the code under test; and the database must then
 * hold exactly those. Each delete is also made once for each of its writes
 * with that write failing, and must then have changed no row and moved no
 * file.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { clearBoardCards, deleteBoard, deleteCard, deleteColumn, purgeArchivedCards } from '$lib/server/deletes';
import {
	activityLog,
	boards,
	cardAttachments,
	cards,
	categories,
	milestones,
	reportSchedules,
	subtasks,
	workDependencies,
	type Card,
	type CardAttachment,
	type Subtask
} from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { api, type ApiResult } from './helpers/api';
import { eachWriteInTurn } from './helpers/each-write';
import { failingWrite } from './helpers/failing-write';
import { effects, type RecordedEffect } from './helpers/effects';
import {
	makeAttachment,
	makeBoard,
	makeCard,
	makeDependency,
	makeMilestone,
	makeSubBoard,
	makeSubtask,
	makeUser,
	makeWebhook,
	resetDb,
	testUploadsDir,
	type BoardFixture,
	type SubBoardFixture
} from './helpers/fixtures';
import { diffSnapshots, snapshotDb, type DbSnapshot } from './helpers/snapshot';

beforeEach(resetDb);
afterEach(() => {
	process.env.LOG_LEVEL = 'ERROR';
});

type Row = Record<string, any>;

const rowsOf = (snapshot: DbSnapshot, table: string): Row[] => Object.values(snapshot[table] ?? {});

/** A recorded effect in a few words. */
function name(effect: RecordedEffect): string {
	if (effect.kind === 'webhook') return `webhook ${effect.event}`;
	if (effect.kind === 'email') return `email to ${effect.to}: ${effect.subject}`;
	return `event ${effect.event}`;
}

/**
 * Each live event sent, with its payload whole and the board it was for named
 * as the world names it. The payload is compared whole, so a name added to
 * one, a board's, a card's or a user's, fails the test (card 2108, R6).
 */
function told(w: World, sent: RecordedEffect[]): string[] {
	const boardName = new Map([
		[w.A.board.id, 'A'],
		[w.B.board.id, 'B'],
		[w.S1.board.id, 'S1'],
		[w.S2.board.id, 'S2']
	]);
	return sent.flatMap((e) =>
		e.kind === 'event' ? [`${e.event} ${JSON.stringify(e.data)} on ${boardName.get(e.boardId) ?? e.boardId}`] : []
	);
}

const DELETED = 'update {"type":"board","action":"deleted"}';
/** To the board a deleted sub-board hung from, which is still there. */
const SUB_BOARD_DELETED = 'update {"type":"board","action":"sub_board_deleted"}';
const PURGED = 'update {"type":"card","action":"purged"}';
const CLEARED = 'update {"type":"card","action":"cleared"}';

/** The activity log, without the columns that are the same in every entry. */
const entries = () =>
	db
		.select({
			boardId: activityLog.boardId,
			cardId: activityLog.cardId,
			userId: activityLog.userId,
			action: activityLog.action,
			detail: activityLog.detail,
			source: activityLog.source
		})
		.from(activityLog)
		.all();

// ─── The fixture ────────────────────────────────────────────────────────────

type World = {
	owner: SessionUser;
	admin: SessionUser;
	A: BoardFixture;
	B: BoardFixture;
	/** On A, in To Do. Has a sub-board, which has a sub-board. */
	doomed: Card;
	/** On A, in To Do, beside it. */
	neighbour: Card;
	/** On A, in In Progress. */
	sibling: Card;
	/** On B. */
	outside: Card;
	/** On B. */
	other: Card;
	S1: SubBoardFixture;
	S2: SubBoardFixture;
	/** The card on `doomed`'s sub-board, and the card on that card's sub-board. */
	mid: Card;
	deep: Card;
	subs: Record<'outside' | 'other' | 'doomed' | 'neighbour' | 'sibling' | 'mid' | 'deep', Subtask>;
	/** Every row of every table, once all of this was built. */
	before: DbSnapshot;
};

/**
 * Two boards. On A: a card with a sub-board two levels deep, a card beside it
 * in the same column and a card in another column. On B: two cards. Every
 * card has an attachment with a real file, and a subtask. Dependency links
 * run inside the tree under `doomed`, across its edge in both directions,
 * between cards and between subtasks, and wholly outside it.
 */
function world(): World {
	const owner = makeUser({ username: 'owner' });
	const admin = makeUser({ username: 'admin', role: 'admin' });
	const A = makeBoard({ owner, name: 'A' });
	const B = makeBoard({ owner, name: 'B' });
	makeWebhook(A.board);
	makeWebhook(B.board);

	const doomed = makeCard(A.cols['To Do'], { title: 'Doomed' });
	const neighbour = makeCard(A.cols['To Do'], { title: 'Neighbour', position: 1 });
	const sibling = makeCard(A.cols['In Progress'], { title: 'Sibling' });
	const outside = makeCard(B.cols['To Do'], { title: 'Outside' });
	const other = makeCard(B.cols['To Do'], { title: 'Other', position: 1 });
	const S1 = makeSubBoard(doomed, { owner, name: 'S1' });
	const mid = S1.cards[0];
	const S2 = makeSubBoard(mid, { owner, name: 'S2' });
	const deep = S2.cards[0];

	// The first subtask is outside the tree and has the id the doomed card has:
	// a link is to a kind of work and an id, and deleting card 1 must not take
	// the links of subtask 1.
	const subs = {
		outside: makeSubtask(outside),
		other: makeSubtask(other),
		doomed: makeSubtask(doomed),
		neighbour: makeSubtask(neighbour),
		sibling: makeSubtask(sibling),
		mid: makeSubtask(mid),
		deep: makeSubtask(deep)
	};
	expect(subs.outside.id).toBe(doomed.id);

	for (const card of [doomed, neighbour, sibling, outside, other, mid, deep]) {
		makeAttachment(card, { name: `${card.title}.txt` });
	}
	makeAttachment(deep, { name: 'second.txt' });

	// Across the edge of the tree, both ways, cards and subtasks.
	makeDependency({ blocked: doomed, blocker: outside });
	makeDependency({ blocked: outside, blocker: deep });
	makeDependency({ blocked: subs.doomed, blocker: subs.outside });
	makeDependency({ blocked: subs.other, blocker: subs.deep });
	makeDependency({ blocked: sibling, blocker: doomed });
	// Inside it.
	makeDependency({ blocked: subs.mid, blocker: mid });
	makeDependency({ blocked: deep, blocker: subs.doomed });
	// Outside it, on board A and from A to B.
	makeDependency({ blocked: neighbour, blocker: sibling });
	makeDependency({ blocked: outside, blocker: sibling });
	// Wholly on board B. One end of the second is subtask 1.
	makeDependency({ blocked: other, blocker: outside });
	makeDependency({ blocked: subs.other, blocker: subs.outside });

	return {
		owner, admin, A, B, doomed, neighbour, sibling, outside, other, S1, S2, mid, deep, subs,
		before: snapshotDb()
	};
}

// ─── What should be left ────────────────────────────────────────────────────

type Tree = { boards: Set<number>; columns: Set<number>; cards: Set<number>; subtasks: Set<number> };

/**
 * Everything under what was asked for, worked out from the rows as they were:
 * the columns of a board, the cards of a column, and the sub-boards of a
 * card, round and round until nothing more is found.
 */
function treeUnder(
	before: DbSnapshot,
	asked: { boards?: number[]; columns?: number[]; cards?: number[] }
): Tree {
	const tree: Tree = {
		boards: new Set(asked.boards),
		columns: new Set(asked.columns),
		cards: new Set(asked.cards),
		subtasks: new Set()
	};
	for (let size = -1; size !== tree.boards.size + tree.columns.size + tree.cards.size; ) {
		size = tree.boards.size + tree.columns.size + tree.cards.size;
		for (const column of rowsOf(before, 'columns')) if (tree.boards.has(column.board_id)) tree.columns.add(column.id);
		for (const card of rowsOf(before, 'cards')) if (tree.columns.has(card.column_id)) tree.cards.add(card.id);
		for (const board of rowsOf(before, 'boards')) if (tree.cards.has(board.parent_card_id)) tree.boards.add(board.id);
	}
	for (const subtask of rowsOf(before, 'subtasks')) if (tree.cards.has(subtask.card_id)) tree.subtasks.add(subtask.id);
	return tree;
}

/** Whether a dependency link has something of the tree at either end. */
const touches = (tree: Tree, link: Row): boolean =>
	(link.blocked_type === 'card' ? tree.cards : tree.subtasks).has(link.blocked_id) ||
	(link.blocker_type === 'card' ? tree.cards : tree.subtasks).has(link.blocker_id);

/**
 * The database as it should be once `tree` is deleted: the rows before,
 * without the rows of the tree, and with what named a deleted board cleared.
 * The activity log and its id counter are left out and are asserted apart.
 */
function withoutTree(before: DbSnapshot, tree: Tree): DbSnapshot {
	const goneMilestones = new Set(
		rowsOf(before, 'milestones')
			.filter((m) => tree.boards.has(m.board_id))
			.map((m) => m.id)
	);
	const goneCategories = new Set(
		rowsOf(before, 'categories')
			.filter((c) => tree.boards.has(c.board_id))
			.map((c) => c.id)
	);
	const gone: Record<string, (row: Row) => boolean> = {
		boards: (row) => tree.boards.has(row.id),
		columns: (row) => tree.columns.has(row.id),
		cards: (row) => tree.cards.has(row.id),
		subtasks: (row) => tree.subtasks.has(row.id),
		card_attachments: (row) => tree.cards.has(row.card_id),
		work_dependencies: (row) => touches(tree, row),
		webhooks: (row) => tree.boards.has(row.board_id),
		milestones: (row) => goneMilestones.has(row.id),
		report_schedules: (row) => row.scope === 'board' && tree.boards.has(row.scope_id),
		// A board's card categories go with it: kept, they were categories of no board, listed to everyone.
		categories: (row) => goneCategories.has(row.id)
	};
	const altered: Record<string, (row: Row) => Row> = {
		// A card that is left, in a milestone of a board that went, or carrying
		// a category of one.
		cards: (row) => ({
			...row,
			...(goneMilestones.has(row.milestone_id) ? { milestone_id: null } : {}),
			...(goneCategories.has(row.category_id) ? { category_id: null } : {})
		})
	};

	const expected: DbSnapshot = {};
	for (const [table, rows] of Object.entries(before)) {
		expected[table] = {};
		for (const [key, row] of Object.entries(rows)) {
			if (gone[table]?.(row)) continue;
			expected[table][key] = altered[table]?.(row) ?? row;
		}
	}
	return withoutActivity(expected);
}

function withoutActivity(snapshot: DbSnapshot): DbSnapshot {
	const { activity_log: _entries, sqlite_sequence: counters, ...rest } = snapshot;
	const { activity_log: _counter, ...otherCounters } = counters ?? {};
	return { ...rest, sqlite_sequence: otherCounters };
}

const fileIn = (...parts: (string | number)[]) => existsSync(join(testUploadsDir(), ...parts.map(String)));

/**
 * Every file of the tree is in the trash and none of them is in a card's
 * folder, and every other file is where it was.
 */
function expectFiles(before: DbSnapshot, tree: Tree): void {
	const attachments = rowsOf(before, 'card_attachments');
	expect(attachments.length).toBeGreaterThan(0);
	for (const { card_id: cardId, filename } of attachments) {
		const where = { folder: fileIn(cardId, filename), trash: fileIn('.trash', cardId, filename) };
		if (tree.cards.has(cardId)) {
			expect(where, `the file of deleted card ${cardId}`).toEqual({ folder: false, trash: true });
			expect(fileIn(cardId), `the folder of deleted card ${cardId}`).toBe(false);
			expect(fileIn('.trash', cardId, '.trashed-at')).toBe(true);
		} else {
			expect(where, `the file of card ${cardId}, which was not deleted`).toEqual({ folder: true, trash: false });
		}
	}
	// Nothing is in the trash but the folders of the cards that went.
	const trashed = fileIn('.trash') ? readdirSync(join(testUploadsDir(), '.trash')).map(Number) : [];
	expect(trashed.sort()).toEqual(
		[...new Set(attachments.filter((a) => tree.cards.has(a.card_id)).map((a) => a.card_id as number))].sort()
	);
}

const NOTHING: Tree = { boards: new Set(), columns: new Set(), cards: new Set(), subtasks: new Set() };

/** Everything a permanent delete should have left, and nothing it should not. */
function expectLeft(w: World, tree: Tree): void {
	const after = snapshotDb();

	// Said on its own, because it is the fault this replaced: no link is left
	// with anything deleted at either end, and links between what is left are.
	const links = rowsOf(after, 'work_dependencies');
	expect(links.filter((link) => touches(tree, link))).toEqual([]);
	expect(links).toEqual(rowsOf(w.before, 'work_dependencies').filter((link) => !touches(tree, link)));
	expect(links.length).toBeGreaterThan(0);
	expect(links.length).toBeLessThan(rowsOf(w.before, 'work_dependencies').length);

	expect(diffSnapshots(withoutTree(w.before, tree), withoutActivity(after))).toEqual([]);
	expectFiles(w.before, tree);
}

/**
 * Make `call`, and if it fails check that no file moved. `eachWriteInTurn`
 * checks the rows.
 */
const filesStayOnFailure = <W extends World>(call: (w: W) => Promise<ApiResult>) => async (w: W) => {
	let res: ApiResult;
	try {
		res = await call(w);
	} catch (thrown) {
		expectFiles(w.before, NOTHING);
		throw thrown;
	}
	if (res.status >= 500) expectFiles(w.before, NOTHING);
	return res;
};

/**
 * The first words of each write, to read a request's writes as a list. A
 * write of `deletes.ts` starts with a long WITH clause, and says what it is
 * in a comment in front of that.
 */
const shape = (writes: string[]) =>
	writes.map((sql) =>
		(/^\/\* (.*?) \*\//.exec(sql)?.[1] ?? sql)
			.split(/\s+/)
			.slice(0, 3)
			.join(' ')
			.replace(/"/g, '')
			.toLowerCase()
	);

// ─── Archive ────────────────────────────────────────────────────────────────

describe.each([
	{ tree: 'the internal API', path: '/api/cards', action: 'card_archived', source: 'ui' },
	{ tree: 'the v1 API', path: '/api/v1/cards', action: 'api:card_archived', source: 'api' }
])('archiving a card through $tree', ({ path, action, source }) => {
	it('stamps the card, writes the entry, and touches nothing else, or does neither', async () => {
		const run = await eachWriteInTurn({
			build: world,
			request: filesStayOnFailure((w) => api('DELETE', `${path}/${w.doomed.id}`, { user: w.owner })),
			afterSuccess: (w, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true });

				const card = db.select().from(cards).where(eq(cards.id, w.doomed.id)).get()!;
				expect(card.archivedAt).not.toBeNull();
				expect(entries()).toEqual([
					{ boardId: w.A.board.id, cardId: w.doomed.id, userId: w.owner.id, action, detail: '"Doomed"', source }
				]);

				// The card's own row and nothing else: not a link, not an attachment
				// row, not a subtask, not the sub-board or anything on it.
				expect(diffSnapshots(withoutActivity(w.before), withoutActivity(snapshotDb()))).toEqual([
					expect.stringMatching(/^cards: row 1 changed \(updated_at: [^;]+; archived_at: null became [^;]+\)$/)
				]);
				expectFiles(w.before, NOTHING);
			}
		});

		expect(shape(run.writes)).toEqual(['update cards set', 'insert into activity_log']);
		// An archive is not a `card.deleted`.
		expect(run.effects.map(name)).toEqual(['event update']);
	});

	it('and restoring it brings it back whole', async () => {
		const w = world();

		expect((await api('DELETE', `${path}/${w.doomed.id}`, { user: w.owner })).status).toBe(200);
		const restored = await api('POST', `/api/cards/${w.doomed.id}/restore`, { user: w.owner });
		expect(restored.status).toBe(200);
		expect(restored.body.archivedAt).toBeNull();

		// Its attachment rows, its files, its dependency links and its subtask's.
		expect(db.select().from(cardAttachments).where(eq(cardAttachments.cardId, w.doomed.id)).all()).toHaveLength(1);
		expectFiles(w.before, NOTHING);
		expect(db.select().from(workDependencies).all()).toHaveLength(rowsOf(w.before, 'work_dependencies').length);
		expect(diffSnapshots(withoutActivity(w.before), withoutActivity(snapshotDb()))).toEqual([
			expect.stringMatching(/^cards: row 1 changed \(updated_at: [^;]+\)$/)
		]);

		// And the application reads it so: the card still waits on what it waited on.
		const seen = await api('GET', `/api/v1/cards/${w.doomed.id}`, { user: w.owner });
		expect(seen.body.blockedBy.map((b: { cardId: number }) => b.cardId)).toEqual([w.outside.id]);
		expect(seen.body.blocks.map((b: { cardId: number }) => b.cardId)).toEqual([w.sibling.id]);
		const files = await api('GET', `/api/cards/${w.doomed.id}/attachments`, { user: w.owner });
		const [file] = files.body as CardAttachment[];
		expect((await api('GET', `/api/cards/${w.doomed.id}/attachments/${file.id}`, { user: w.owner })).body).toBe(
			'The contents of Doomed.txt'
		);
	});
});

// ─── Permanent deletes ──────────────────────────────────────────────────────

describe.each([
	{ tree: 'the internal API', api: '/api', prefix: '', source: 'ui' },
	{ tree: 'the v1 API', api: '/api/v1', prefix: 'api:', source: 'api' }
])('deleting for good through $tree', ({ api: root, prefix, source }) => {
	it('a card: with its subtasks, its sub-boards at every depth, their links and their files', async () => {
		const run = await eachWriteInTurn({
			build: world,
			request: filesStayOnFailure((w) =>
				api('DELETE', `${root}/cards/${w.doomed.id}?permanent=true`, { user: w.owner })
			),
			afterSuccess: (w, res: ApiResult, sent) => {
				// The v1 route answered 500 here: it gave the activity log the id of
				// the card it had just deleted.
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true });

				const tree = treeUnder(w.before, { cards: [w.doomed.id] });
				expect([...tree.cards]).toEqual([w.doomed.id, w.mid.id, w.deep.id]);
				expect([...tree.boards]).toEqual([w.S1.board.id, w.S2.board.id]);
				expectLeft(w, tree);

				// One entry, with no card id: the card it would refer to is gone.
				expect(entries()).toEqual([
					{
						boardId: w.A.board.id,
						cardId: null,
						userId: w.owner.id,
						action: `${prefix}card_deleted`,
						detail: '"Doomed"',
						source
					}
				]);
				// The webhook says which card it was.
				const [hook] = sent.filter((e) => e.kind === 'webhook');
				expect(hook).toMatchObject({ event: 'card.deleted', body: { boardId: w.A.board.id } });
				expect(hook.kind === 'webhook' && hook.body.data).toMatchObject({
					cardId: w.doomed.id,
					action: 'card_deleted',
					source
				});
				// The two sub-boards that went with it are told (R7); the route tells A.
				expect(told(w, sent)).toEqual([`${DELETED} on S1`, `${DELETED} on S2`, 'update {"type":"card"} on A']);
			}
		});

		// The links; what names the two sub-boards, and their categories; the
		// sub-boards, each by its own statement; the card; the entry.
		expect(shape(run.writes)).toEqual([
			'delete from work_dependencies',
			'update cards set',
			'delete from report_schedules',
			'delete from categories',
			'delete from boards',
			'delete from boards',
			'delete from cards',
			'insert into activity_log'
		]);
		expect(run.effects.map(name)).toEqual(['webhook card.deleted', 'event update', 'event update', 'event update']);
	});

	it('a column: with every card in it, and one entry for the column', async () => {
		const run = await eachWriteInTurn({
			build: world,
			request: filesStayOnFailure((w) =>
				api('DELETE', `${root}/columns/${w.A.cols['To Do'].id}`, { user: w.owner })
			),
			afterSuccess: (w, res: ApiResult, sent) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true });

				const tree = treeUnder(w.before, { columns: [w.A.cols['To Do'].id] });
				expect([...tree.cards]).toEqual([w.doomed.id, w.neighbour.id, w.mid.id, w.deep.id]);
				expectLeft(w, tree);

				expect(entries()).toEqual([
					{
						boardId: w.A.board.id,
						cardId: null,
						userId: w.owner.id,
						action: `${prefix}column_deleted`,
						detail: '"To Do" with 2 card(s), and 2 sub-board(s) holding 2 more',
						source
					}
				]);
				// The two sub-boards that went with its cards are told (R7); the route tells A.
				expect(told(w, sent)).toEqual([`${DELETED} on S1`, `${DELETED} on S2`, 'update {"type":"column"} on A']);
			}
		});

		expect(shape(run.writes).at(-2)).toBe('delete from columns');
		// No webhook for each card, and none for the column.
		expect(run.effects.map(name)).toEqual(['event update', 'event update', 'event update']);
	});

	it('a board: with everything on it, and no activity entry', async () => {
		const run = await eachWriteInTurn({
			build: world,
			request: filesStayOnFailure((w) => api('DELETE', `${root}/boards/${w.A.board.id}`, { user: w.owner })),
			afterSuccess: (w, res: ApiResult, sent) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true });

				const tree = treeUnder(w.before, { boards: [w.A.board.id] });
				expect([...tree.boards]).toEqual([w.A.board.id, w.S1.board.id, w.S2.board.id]);
				expect([...tree.cards]).toEqual([w.doomed.id, w.neighbour.id, w.sibling.id, w.mid.id, w.deep.id]);
				expectLeft(w, tree);

				// An entry on the board would have been deleted with it.
				expect(entries()).toEqual([]);
				// A page open on any of them re-reads and finds it gone. Nothing was sent.
				expect(told(w, sent)).toEqual([`${DELETED} on A`, `${DELETED} on S1`, `${DELETED} on S2`]);
			}
		});

		expect(shape(run.writes)).toEqual([
			'delete from work_dependencies',
			'update cards set',
			'delete from report_schedules',
			'delete from categories',
			'delete from boards',
			'delete from boards',
			'delete from boards'
		]);
		expect(run.effects.map(name)).toEqual(['event update', 'event update', 'event update']);
	});

	it('a sub-board: and the board of the card it hung from is told as well', async () => {
		const run = await eachWriteInTurn({
			build: world,
			request: filesStayOnFailure((w) => api('DELETE', `${root}/boards/${w.S1.board.id}`, { user: w.owner })),
			afterSuccess: (w, res: ApiResult, sent) => {
				expect(res.status).toBe(200);
				expectLeft(w, treeUnder(w.before, { boards: [w.S1.board.id] }));
				// A shows the card the sub-board hung from, and re-reads it. A is
				// still there, so it is not told that it was deleted.
				expect(told(w, sent)).toEqual([`${DELETED} on S1`, `${DELETED} on S2`, `${SUB_BOARD_DELETED} on A`]);
			}
		});

		expect(run.effects.map(name)).toEqual(['event update', 'event update', 'event update']);
	});

	it('refuses a caller who cannot, from inside the transaction, with nothing deleted and no file moved', async () => {
		const w = world();
		const outsider = makeUser({ username: 'outsider' });
		const before = snapshotDb();

		for (const path of [
			`${root}/cards/${w.doomed.id}?permanent=true`,
			`${root}/cards/${w.doomed.id}`,
			`${root}/columns/${w.A.cols['To Do'].id}`,
			`${root}/boards/${w.A.board.id}`
		]) {
			expect((await api('DELETE', path, { user: outsider })).status, path).toBe(403);
		}

		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		expectFiles(w.before, NOTHING);
	});

	it('does not hang on a card that was moved into its own sub-board', async () => {
		const owner = makeUser();
		const A = makeBoard({ owner });
		const stays = makeCard(A.cols['To Do']);
		const card = makeCard(A.cols['To Do'], { title: 'Inside itself' });
		const own = makeSubBoard(card, { owner });
		const deeper = makeSubBoard(own.cards[0], { owner });
		makeAttachment(card);
		makeAttachment(deeper.cards[0]);
		makeDependency({ blocked: stays, blocker: deeper.cards[0] });
		// The card now sits on the board that hangs from it.
		db.update(cards).set({ columnId: own.cols['To Do'].id }).where(eq(cards.id, card.id)).run();

		const res = await api('DELETE', `${root}/cards/${card.id}?permanent=true`, { user: owner });

		expect(res.status).toBe(200);
		expect(db.select({ id: boards.id }).from(boards).all()).toEqual([{ id: A.board.id }]);
		expect(db.select({ id: cards.id }).from(cards).all()).toEqual([{ id: stays.id }]);
		expect(db.select().from(workDependencies).all()).toEqual([]);
		expect(fileIn(card.id)).toBe(false);
		expect(readdirSync(join(testUploadsDir(), '.trash')).sort()).toEqual(
			[String(card.id), String(deeper.cards[0].id)].sort()
		);
		// The board the card was on went with it, so there is none to write on.
		expect(entries()).toEqual([]);
	});

	it('a column whose board goes with it, being the sub-board of a card in it, says so in the system log', async () => {
		process.env.LOG_LEVEL = 'INFO';
		const owner = makeUser({ username: 'owner' });
		const A = makeBoard({ owner });
		const stays = makeCard(A.cols['To Do']);
		const card = makeCard(A.cols['To Do'], { title: 'Inside itself' });
		const own = makeSubBoard(card, { owner });
		makeAttachment(card);
		// The card now sits on the board that hangs from it, in the column deleted.
		db.update(cards).set({ columnId: own.cols['To Do'].id }).where(eq(cards.id, card.id)).run();

		const res = await api('DELETE', `${root}/columns/${own.cols['To Do'].id}`, { user: owner });

		expect(res.status).toBe(200);
		expect(db.select({ id: boards.id }).from(boards).all()).toEqual([{ id: A.board.id }]);
		expect(db.select({ id: cards.id }).from(cards).all()).toEqual([{ id: stays.id }]);
		// The board the column was on went with it, so there is none to write
		// on. Nothing at all used to say that this delete had been made.
		expect(entries()).toEqual([]);
		expect(
			sqlite.prepare("SELECT level, message, user_id AS userId FROM system_logs WHERE context = 'DELETE'").all()
		).toEqual([
			{
				level: 'INFO',
				userId: owner.id,
				message:
					`Column ${own.cols['To Do'].id} "To Do" was deleted by owner, and board ${own.board.id}, which it was on, ` +
					'was a sub-board under one of its own cards and went with it: 2 card(s), 0 subtask(s), 1 sub-board(s), ' +
					'0 dependency link(s), 0 report schedule(s); 1 attachment file(s) to the trash; ' +
					'0 card(s) elsewhere released from its milestones'
			}
		]);
	});

	it('does not hang on two cards that are each on the other one\'s sub-board', async () => {
		const owner = makeUser();
		const A = makeBoard({ owner });
		const one = makeCard(A.cols['To Do']);
		const two = makeCard(A.cols['To Do']);
		const ofOne = makeSubBoard(one, { owner, cards: {} });
		const ofTwo = makeSubBoard(two, { owner, cards: {} });
		db.update(cards).set({ columnId: ofTwo.cols['To Do'].id }).where(eq(cards.id, one.id)).run();
		db.update(cards).set({ columnId: ofOne.cols['To Do'].id }).where(eq(cards.id, two.id)).run();

		const res = await api('DELETE', `${root}/boards/${ofOne.board.id}`, { user: owner });

		expect(res.status).toBe(200);
		expect(db.select({ id: boards.id }).from(boards).all()).toEqual([{ id: A.board.id }]);
		expect(db.select().from(cards).all()).toEqual([]);
	});
});

describe('deleting for good from the admin panel', () => {
	const ARCHIVED = '2026-10-01T09:00:00.000Z';

	/** `doomed`, with its sub-boards, and `other` on board B are archived. */
	const withArchived = () => {
		const w = world();
		for (const card of [w.doomed, w.other]) {
			db.update(cards).set({ archivedAt: ARCHIVED }).where(eq(cards.id, card.id)).run();
		}
		return { ...w, before: snapshotDb() };
	};

	it('purge-archived: every archived card, with one entry for each board that had any', async () => {
		const run = await eachWriteInTurn({
			build: withArchived,
			request: filesStayOnFailure((w) => api('POST', '/api/admin/purge-archived', { user: w.admin })),
			afterSuccess: (w, res: ApiResult, sent) => {
				expect(res.status).toBe(200);
				// How many were archived. What was on their sub-boards went too.
				expect(res.body).toEqual({ success: true, purged: 2 });

				const tree = treeUnder(w.before, { cards: [w.doomed.id, w.other.id] });
				expect([...tree.cards]).toEqual([w.doomed.id, w.other.id, w.mid.id, w.deep.id]);
				expectLeft(w, tree);

				const entry = { cardId: null, userId: w.admin.id, action: 'cards_purged', source: 'ui' };
				expect(entries()).toEqual([
					{ ...entry, boardId: w.A.board.id, detail: 'Purged 1 archived card(s)' },
					{ ...entry, boardId: w.B.board.id, detail: 'Purged 1 archived card(s)' }
				]);
				// The two boards that had archived cards, and the sub-boards that went
				// with the one on A. Nothing was sent.
				expect(told(w, sent)).toEqual([`${PURGED} on A`, `${PURGED} on B`, `${PURGED} on S1`, `${PURGED} on S2`]);
			}
		});

		expect(shape(run.writes).slice(-3)).toEqual([
			'delete from cards',
			'insert into activity_log',
			'insert into activity_log'
		]);
		// No webhook for each card.
		expect(run.effects.map(name)).toEqual(['event update', 'event update', 'event update', 'event update']);
	});

	it('purge-archived with nothing archived deletes nothing, writes no entry and tells nobody', async () => {
		const w = world();
		const sent = effects();

		try {
			const res = await api('POST', '/api/admin/purge-archived', { user: w.admin });
			await sent.settle();

			expect(res.body).toEqual({ success: true, purged: 0 });
			expect(sent.all).toEqual([]);
		} finally {
			sent.restore();
		}
		expect(diffSnapshots(w.before, snapshotDb())).toEqual([]);
		expectFiles(w.before, NOTHING);
	});

	it('clear-cards: every card on the board, the board and its columns kept, and one entry', async () => {
		const run = await eachWriteInTurn({
			build: world,
			request: filesStayOnFailure((w) =>
				api('POST', `/api/admin/boards/${w.A.board.id}/clear-cards`, { user: w.admin })
			),
			afterSuccess: (w, res: ApiResult, sent) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true });

				const tree = treeUnder(w.before, { cards: [w.doomed.id, w.neighbour.id, w.sibling.id] });
				expect([...tree.boards]).toEqual([w.S1.board.id, w.S2.board.id]);
				expectLeft(w, tree);

				expect(entries()).toEqual([
					{
						boardId: w.A.board.id,
						cardId: null,
						userId: w.admin.id,
						action: 'cards_cleared',
						detail: 'Cleared all 3 card(s) from the board',
						source: 'ui'
					}
				]);
				// A page open on the board empties without a reload. Nothing was sent.
				expect(told(w, sent)).toEqual([`${CLEARED} on A`, `${CLEARED} on S1`, `${CLEARED} on S2`]);
			}
		});

		expect(shape(run.writes).slice(-2)).toEqual(['delete from cards', 'insert into activity_log']);
		expect(run.effects.map(name)).toEqual(['event update', 'event update', 'event update']);
	});

	it('both refuse a caller who is not an administrator', async () => {
		const w = withArchived();

		expect((await api('POST', '/api/admin/purge-archived', { user: w.owner })).status).toBe(403);
		expect((await api('POST', `/api/admin/boards/${w.A.board.id}/clear-cards`, { user: w.owner })).status).toBe(403);

		expect(diffSnapshots(w.before, snapshotDb())).toEqual([]);
		expectFiles(w.before, NOTHING);
	});
});

// ─── A board ────────────────────────────────────────────────────────────────

describe('deleting a board', () => {
	/**
	 * The world, with what names board A by id and has no foreign key to say
	 * so, and beside each of those something that names another board or only
	 * looks as if it names A.
	 */
	const withNamed = () => {
		const w = world();
		const schedule = (name: string, scope: string, scopeId: number | null) =>
			db.insert(reportSchedules).values({ userId: w.owner.id, name, scope, scopeId }).returning().get();

		const named = {
			scheduleA: schedule('Board A, weekly', 'board', w.A.board.id),
			scheduleSub: schedule('The sub-board', 'board', w.S1.board.id),
			scheduleB: schedule('Board B', 'board', w.B.board.id),
			// A category of boards, whose id happens to be board A's.
			scheduleCategory: schedule('A category with the same number', 'category', w.A.board.id),
			scheduleAll: schedule('Everything', 'all', null),
			// A's own milestone holds a card of A, and a card that has since moved to B.
			milestoneA: makeMilestone({ board: w.A.board, name: 'Goal of A', cards: [w.neighbour, w.outside] }),
			milestoneB: makeMilestone({ board: w.B.board, name: 'Goal of B', cards: [w.other] }),
			crossBoard: makeMilestone({ name: 'Across boards', cards: [w.sibling] }),
			categoryA: db.insert(categories).values({ boardId: w.A.board.id, name: 'Of A' }).returning().get(),
			categoryB: db.insert(categories).values({ boardId: w.B.board.id, name: 'Of B' }).returning().get(),
			categoryOfSub: db.insert(categories).values({ boardId: w.S1.board.id, name: 'Of the sub-board' }).returning().get()
		};
		// The card that has moved to B still carries a category of A.
		db.update(cards).set({ categoryId: named.categoryA.id }).where(eq(cards.id, w.outside.id)).run();
		return { ...w, ...named, before: snapshotDb() };
	};

	it.each([
		{ tree: 'the internal API', path: '/api/boards' },
		{ tree: 'the v1 API', path: '/api/v1/boards' }
	])(
		'through $tree: its report schedules go, cards elsewhere leave its milestones and its categories, and its categories go',
		async ({ path }) => {
			const run = await eachWriteInTurn({
				build: withNamed,
				request: filesStayOnFailure((w) => api('DELETE', `${path}/${w.A.board.id}`, { user: w.owner })),
				afterSuccess: (w, res: ApiResult, sent) => {
					expect(res.status).toBe(200);

					// The schedules that named it, and the one that named its sub-board.
					expect(db.select({ name: reportSchedules.name }).from(reportSchedules).all()).toEqual([
						{ name: 'Board B' },
						{ name: 'A category with the same number' },
						{ name: 'Everything' }
					]);

					// The card on B that was in A's milestone is in none, and has no
					// category of A. The others are as they were.
					expect(db.select({ name: milestones.name }).from(milestones).all()).toEqual([
						{ name: 'Goal of B' },
						{ name: 'Across boards' }
					]);
					expect(db.select({ id: cards.id, milestoneId: cards.milestoneId, categoryId: cards.categoryId }).from(cards).all()).toEqual([
						{ id: w.outside.id, milestoneId: null, categoryId: null },
						{ id: w.other.id, milestoneId: w.milestoneB.id, categoryId: null }
					]);

					// Its categories, and its sub-board's, go with them (card 2128's
					// review): kept, as categories of no board, they were listed to everyone.
					expect(db.select().from(categories).all()).toEqual([w.categoryB]);

					// And, as for every permanent delete, nothing else outside it changed.
					expectLeft(w, treeUnder(w.before, { boards: [w.A.board.id] }));

					// The board and its sub-boards are told. B, where a card left A's
					// milestone and lost A's category, is not: the plan leaves that.
					expect(told(w, sent)).toEqual([`${DELETED} on A`, `${DELETED} on S1`, `${DELETED} on S2`]);
				}
			});

			expect(run.effects.map(name)).toEqual(['event update', 'event update', 'event update']);
		}
	);

	it('writes one line to the system log once it is committed, naming the board, who and what went', async () => {
		process.env.LOG_LEVEL = 'INFO';
		const w = withNamed();

		await api('DELETE', `/api/boards/${w.A.board.id}`, { user: w.owner });

		const lines = sqlite
			.prepare("SELECT level, message, user_id AS userId FROM system_logs WHERE context = 'DELETE'")
			.all();
		expect(lines).toEqual([
			{
				level: 'INFO',
				userId: w.owner.id,
				message:
					`Board ${w.A.board.id} "A" was deleted by owner: 5 card(s), 5 subtask(s), 2 sub-board(s), ` +
					'9 dependency link(s), 2 report schedule(s); 6 attachment file(s) to the trash; ' +
					'1 card(s) elsewhere released from its milestones'
			}
		]);
	});

	it('writes no such line when the delete fails', async () => {
		process.env.LOG_LEVEL = 'INFO';
		const w = withNamed();
		const writes = failingWrite();

		try {
			// The last write of all: the board itself.
			writes.failNth(7);
			await expect(api('DELETE', `/api/boards/${w.A.board.id}`, { user: w.owner })).rejects.toThrow(/made to fail/);
			expect(writes.fired).toBe(true);
		} finally {
			writes.restore();
		}

		expect(sqlite.prepare("SELECT message FROM system_logs WHERE context = 'DELETE'").all()).toEqual([]);
		expect(diffSnapshots(w.before, snapshotDb())).toEqual([]);
	});

	it('answers as each tree always did for a board that is not there', async () => {
		const admin = makeUser({ role: 'admin' });

		expect((await api('DELETE', '/api/v1/boards/99999', { user: admin })).status).toBe(404);
		expect((await api('DELETE', '/api/boards/99999', { user: admin })).body).toEqual({ success: true });
	});
});

// ─── The other deletes that are one transaction now ─────────────────────────

describe('deleting a subtask', () => {
	it.each([
		{ tree: 'the internal API', path: '/api/subtasks', action: 'subtask_deleted', source: 'ui' },
		// It wrote no entry (card 2108).
		{ tree: 'the v1 API', path: '/api/v1/subtasks', action: 'api:subtask_deleted', source: 'api' }
	])('through $tree: the subtask, its links and its entry, or none of them', async ({ path, action, source }) => {
		const run = await eachWriteInTurn({
			build: world,
			request: (w) => api('DELETE', `${path}/${w.subs.doomed.id}`, { user: w.owner }),
			afterSuccess: (w, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true });
				expect(db.select().from(subtasks).where(eq(subtasks.id, w.subs.doomed.id)).get()).toBeUndefined();

				// Its two links, and no link of the card that has the same id as it.
				const tree: Tree = { ...NOTHING, subtasks: new Set([w.subs.doomed.id]) };
				const left = db.select().from(workDependencies).all();
				expect(left).toHaveLength(rowsOf(w.before, 'work_dependencies').length - 2);
				expect(
					left.filter((l) => touches(tree, { blocked_type: l.blockedType, blocked_id: l.blockedId, blocker_type: l.blockerType, blocker_id: l.blockerId }))
				).toEqual([]);
				expect(entries()).toEqual([
					{
						boardId: w.A.board.id,
						cardId: w.doomed.id,
						userId: w.owner.id,
						action,
						detail: `"${w.subs.doomed.title}"`,
						source
					}
				]);
			}
		});

		expect(shape(run.writes)).toEqual(['delete from work_dependencies', 'delete from subtasks', 'insert into activity_log']);
		expect(run.effects.map(name)).toEqual(['event update']);
	});
});

describe('deleting a milestone', () => {
	it.each([
		{ tree: 'the internal API', path: '/api/milestones' },
		{ tree: 'the v1 API', path: '/api/v1/milestones' }
	])('through $tree: its cards are released and it is deleted, or neither', async ({ path }) => {
		const run = await eachWriteInTurn({
			build: () => {
				const w = world();
				const goal = makeMilestone({ board: w.A.board, cards: [w.doomed, w.sibling] });
				return { ...w, goal };
			},
			request: (w) => api('DELETE', `${path}/${w.goal.id}`, { user: w.owner }),
			afterSuccess: (w, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true, cardsReleased: 2 });
				expect(db.select().from(milestones).all()).toEqual([]);
				// Released, never deleted.
				expect(db.select().from(cards).all()).toHaveLength(rowsOf(w.before, 'cards').length);
				expect(db.select().from(cards).all().filter((c) => c.milestoneId !== null)).toEqual([]);
			}
		});

		expect(shape(run.writes)).toEqual(['update cards set', 'delete from milestones']);
	});
});

describe('a delete inside a transaction that then rolls back', () => {
	// Every write of a delete comes before its files are queued, so failing
	// each write in turn cannot tell a file moved after the commit from one
	// moved where it was queued. This can: the delete has finished, and the
	// transaction around it fails afterwards.
	const deletes: [string, (w: World) => unknown][] = [
		['a card', (w) => deleteCard(w.doomed.id, w.owner, 'ui')],
		['a column', (w) => deleteColumn(w.A.cols['To Do'].id, w.owner, 'ui')],
		['a board', (w) => deleteBoard(w.A.board.id, w.owner)],
		['every card of a board', (w) => clearBoardCards(w.A.board.id, w.admin)],
		[
			'every archived card',
			(w) => {
				sqlite.prepare('UPDATE cards SET archived_at = ? WHERE id = ?').run('2026-10-01T09:00:00.000Z', w.doomed.id);
				return purgeArchivedCards(w.admin);
			}
		]
	];

	for (const [what, remove] of deletes) {
		it(`moves no file and leaves every row, deleting ${what}`, () => {
			const w = world();

			expect(() =>
				inTransaction(() => {
					expect(remove(w)).not.toBeNull();
					throw new Error('after the delete');
				})
			).toThrow('after the delete');

			expect(diffSnapshots(w.before, snapshotDb())).toEqual([]);
			expectFiles(w.before, NOTHING);
		});
	}
});
