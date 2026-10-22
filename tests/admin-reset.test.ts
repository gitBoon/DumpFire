/**
 * Reset and Vacuum, the two admin actions that used to restart the id
 * counters.
 *
 * Reset cleared a fixed list of eighteen tables, each in a `try/catch` that
 * only warned. `DELETE FROM users` failed whenever a dependency, a template or
 * a milestone named a user, and then every user stayed, their sessions and the
 * settings were gone, and the answer was success. Six tables were never
 * cleared at all, and no attachment file was ever removed.
 *
 * It is one transaction now. These tests build a database with a row in every
 * table, the rows that used to stop it among them, and ask that a reset clears
 * all of it but the system log and the backup history, leaves the id counters
 * and the migration record alone, and, with any one of its writes failed,
 * clears nothing and says so.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, sqlite } from '$lib/server/db';
import {
	activityLog,
	apiKeys,
	backupLog,
	boardCategories,
	boardFavourites,
	cardAttachments,
	cardDependencies,
	cardLabels,
	cardTemplates,
	categories,
	dailySnapshots,
	inviteTokens,
	reportSchedules,
	requestMessages,
	sessions,
	taskRequests,
	tokenUsage,
	userXp,
	type Card
} from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { issueFormToken, resetFormSecretCache, verifyFormToken } from '$lib/server/request-tokens';
import { api, type ApiResult } from './helpers/api';
import { eachWriteInTurn } from './helpers/each-write';
import { failingWrite } from './helpers/failing-write';
import {
	addBoardMember,
	assignCard,
	makeAttachment,
	makeBoard,
	makeCard,
	makeComment,
	makeDependency,
	makeLabel,
	makeMilestone,
	makeSmtp,
	makeSubBoard,
	makeSubtask,
	makeTeam,
	makeUser,
	makeWebhook,
	resetDb,
	shareBoardWithTeam,
	testUploadsDir
} from './helpers/fixtures';
import { diffSnapshots, snapshotDb, type DbSnapshot } from './helpers/snapshot';

beforeEach(resetDb);
afterEach(() => {
	vi.restoreAllMocks();
});

/** What a reset keeps. */
const KEPT = ['system_logs', 'backup_log'];
/** The migration runner's record of the files it has applied. */
const MIGRATION_RECORD = '__drizzle_migrations';

/** Every table of the application, as the database lists them. */
const appTables = () =>
	(
		sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
			.all() as { name: string }[]
	)
		.map((t) => t.name)
		.filter((name) => name !== MIGRATION_RECORD);

const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;

const counter = (table: string) =>
	(sqlite.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table) as { seq: number } | undefined)?.seq;

const logLines = () =>
	sqlite
		.prepare("SELECT level, message, user_id AS userId FROM system_logs WHERE context = 'ADMIN' ORDER BY id")
		.all() as { level: string; message: string; userId: number | null }[];

const fileIn = (...parts: (string | number)[]) => existsSync(join(testUploadsDir(), ...parts.map(String)));

type Everything = {
	admin: SessionUser;
	owner: SessionUser;
	/** The cards that have an attachment with a real file. */
	withFiles: Card[];
	/** Every row of every table but `system_logs`, once all of this was built. */
	before: DbSnapshot;
	/** How many rows each table held. */
	rows: Record<string, number>;
};

/**
 * A row, at least, in every table the application has. The user `member` is
 * named by each of the five keys that have no `ON DELETE` action, which is
 * what `DELETE FROM users` used to fail on.
 */
function everything(): Everything {
	// The superadmin, whose username is `admin`: a reset is the superadmin's
	// alone, and a vacuum is any administrator's, which the superadmin is too.
	const admin = makeUser({ username: 'admin', role: 'superadmin' });
	const owner = makeUser({ username: 'owner' });
	const member = makeUser({ username: 'member' });

	const team = makeTeam([member], 'Team');
	const A = makeBoard({ owner, name: 'A' });
	addBoardMember(A.board, member, 'editor');
	shareBoardWithTeam(A.board, team, 'viewer');
	makeWebhook(A.board);
	makeSmtp();
	// Who set the mail (card 2397, migration 0059): cleared with the rest.
	sqlite.prepare("INSERT INTO setting_setters (setting, place, user_id) VALUES ('mail', 'p', ?)").run(admin.id);

	const category = db.insert(categories).values({ boardId: A.board.id, name: 'Bug' }).returning().get();
	db.insert(boardCategories).values({ name: 'Projects' }).run();
	const first = makeCard(A.cols['To Do'], { title: 'First', categoryId: category.id, createdBy: owner.id });
	const second = makeCard(A.cols['In Progress'], { title: 'Second' });
	const sub = makeSubBoard(first, { owner });
	const subtask = makeSubtask(first);
	const label = makeLabel(A.board);
	db.insert(cardLabels).values({ cardId: first.id, labelId: label.id }).run();
	assignCard(first, member);
	makeComment(first, member);

	const withFiles = [first, second, sub.cards[0]];
	for (const card of withFiles) makeAttachment(card, { name: `${card.title}.txt`, uploadedBy: member });

	makeMilestone({ name: 'Across boards', createdBy: member, cards: [first, second] });
	db.insert(cardTemplates).values({ boardId: A.board.id, name: 'Bug report', createdBy: member.id }).run();
	makeDependency({ blocked: second, blocker: first, createdBy: member });
	makeDependency({ blocked: sub.cards[0], blocker: subtask, createdBy: member });
	db.insert(cardDependencies)
		.values({ cardId: second.id, dependsOnCardId: first.id, createdByUserId: member.id })
		.run();

	db.insert(userXp).values({ name: owner.username, xp: 100 }).run();
	db.insert(sessions).values({ id: 'session-of-admin', userId: admin.id, expiresAt: '2099-01-01 00:00:00' }).run();
	db.insert(inviteTokens).values({ token: 'invite', userId: member.id, expiresAt: '2099-01-01 00:00:00' }).run();
	db.insert(apiKeys).values({ keyHash: 'hash', keyPrefix: 'df_', name: 'Key', userId: owner.id }).run();
	db.insert(boardFavourites).values({ userId: owner.id, boardId: A.board.id }).run();
	db.insert(reportSchedules).values({ userId: owner.id, name: 'Weekly', scope: 'board', scopeId: A.board.id }).run();
	db.insert(tokenUsage).values({ cardId: first.id, tokens: 1200, reportedByUserId: owner.id }).run();
	db.insert(activityLog)
		.values({ boardId: A.board.id, cardId: first.id, userId: owner.id, action: 'card_created' })
		.run();
	db.insert(dailySnapshots)
		.values({ boardId: A.board.id, columnId: A.cols['To Do'].id, date: '2026-10-01', cardCount: 1 })
		.run();

	const request = db
		.insert(taskRequests)
		.values({ targetType: 'user', targetId: owner.id, title: 'Please', requesterUserId: member.id, resolvedBy: owner.id })
		.returning()
		.get();
	db.insert(requestMessages).values({ requestId: request.id, senderName: 'member', message: 'Hello' }).run();

	// The two tables a reset keeps.
	db.insert(backupLog)
		.values({ destinationType: 'sftp', destinationName: 'Offsite', filename: 'backup-1.db', status: 'success' })
		.run();
	sqlite
		.prepare('INSERT INTO system_logs (timestamp, level, context, message) VALUES (?, ?, ?, ?)')
		.run('2026-10-01 09:00:00', 'INFO', 'TEST', 'A line from before the reset');

	const rows = Object.fromEntries(appTables().map((table) => [table, count(table)]));
	return { admin, owner, withFiles, before: snapshotDb(), rows };
}

const cleared = () => appTables().filter((table) => !KEPT.includes(table));

/** Whether every attachment file is still in its card's folder, and nothing is in the trash. */
function expectFilesInPlace(e: Everything): void {
	for (const row of Object.values(e.before.card_attachments)) {
		expect(fileIn(row.card_id as number, row.filename as string), `the file of card ${row.card_id}`).toBe(true);
	}
	expect(fileIn('.trash')).toBe(false);
}

const reset = (e: Everything) => api('POST', '/api/admin/reset', { user: e.admin });

// ─── Reset ──────────────────────────────────────────────────────────────────

describe('POST /api/admin/reset', () => {
	it('is tested on a database with a row in every table', () => {
		const e = everything();

		// A table added later has to be given a row in `everything`, and so has
		// to be thought about here: is it cleared, or is it kept?
		expect(Object.entries(e.rows).filter(([, n]) => n === 0)).toEqual([]);
		expect(Object.keys(e.rows)).toEqual(expect.arrayContaining(KEPT));
		expect(e.withFiles).toHaveLength(3);
		expectFilesInPlace(e);
	});

	it('clears every table but the system log and the backup history, or clears nothing', async () => {
		// A failed reset is logged at ERROR, once for each write that is failed below.
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const run = await eachWriteInTurn({
			build: everything,
			request: async (e) => {
				const res = await reset(e);
				// With a write failed: not a file has moved. The rows are checked by
				// `eachWriteInTurn`.
				if (res.status >= 500) expectFilesInPlace(e);
				return res;
			},
			afterSuccess: (e, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({
					success: true,
					redirect: '/setup',
					trash: { moved: 3, missing: 0, failed: [] }
				});

				// Everything is cleared, the users among them: they used to stay.
				for (const table of cleared()) expect(count(table), table).toBe(0);

				// The backup history is as it was, and so is the line that was in
				// the system log.
				const after = snapshotDb();
				expect(after.backup_log).toEqual(e.before.backup_log);
				expect(
					sqlite.prepare("SELECT message FROM system_logs WHERE context = 'TEST'").all()
				).toEqual([{ message: 'A line from before the reset' }]);

				// The migration record is as it was. Cleared, every migration would
				// run again at the next start, against tables that are already there.
				expect(Object.keys(e.before[MIGRATION_RECORD]).length).toBeGreaterThan(50);
				expect(after[MIGRATION_RECORD]).toEqual(e.before[MIGRATION_RECORD]);

				// The id counters are as they were, every one.
				expect(after.sqlite_sequence).toEqual(e.before.sqlite_sequence);
				expect(Object.keys(after.sqlite_sequence)).toEqual(expect.arrayContaining(['users', 'boards', 'cards']));

				// The line that says who did it is in the log, written after the commit.
				const total = cleared().reduce((sum, table) => sum + e.rows[table], 0);
				expect(logLines()).toEqual([
					{
						level: 'CRITICAL',
						userId: e.admin.id,
						message:
							`The database was reset by admin (ID: ${e.admin.id}): ${total} row(s) cleared from ` +
							`${cleared().length} table(s), the system log and the backup history kept; ` +
							'3 attachment file(s) moved to the trash'
					}
				]);

				// The files are in the trash, and no card folder is left.
				for (const row of Object.values(e.before.card_attachments)) {
					expect(fileIn('.trash', row.card_id as number, row.filename as string)).toBe(true);
					expect(fileIn(row.card_id as number)).toBe(false);
				}
				expect(readdirSync(join(testUploadsDir(), '.trash')).sort()).toEqual(
					e.withFiles.map((card) => String(card.id)).sort()
				);

				// And what is made next carries on from the old ids, not from 1.
				const lastUser = counter('users')!;
				const lastBoard = counter('boards')!;
				const lastCard = counter('cards')!;
				expect(lastCard).toBe(Math.max(...Object.values(e.before.cards).map((card) => card.id as number)));
				const user = makeUser({ username: 'first-after-reset' });
				const board = makeBoard({ owner: user });
				const card = makeCard(board.cols['To Do']);
				expect({ user: user.id, board: board.board.id, card: card.id }).toEqual({
					user: lastUser + 1,
					board: lastBoard + 1,
					card: lastCard + 1
				});
			}
		});

		// One statement for each table, and nothing else: no id counter is
		// deleted, and neither kept table is written to.
		expect(run.writes.slice().sort()).toEqual(
			cleared()
				.map((table) => `DELETE FROM "${table}"`)
				.sort()
		);
		expect(run.writes.length).toBeGreaterThanOrEqual(30);
		expect(run.effects).toEqual([]);
		// Everything is built, and reset, once for each of some forty writes: two
		// seconds alone, and past vitest's five with every other file running.
	}, 30_000);

	it('answers a failed reset 500, says nothing was cleared, and logs the failure and not a reset', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const e = everything();
		const writes = failingWrite();

		let res: ApiResult;
		try {
			// The last table of all: everything before it had been cleared.
			writes.failNth(cleared().length);
			res = await reset(e);
			expect(writes.fired).toBe(true);
		} finally {
			writes.restore();
		}

		expect(res.status).toBe(500);
		expect(res.body.message).toMatch(/^The reset failed and nothing was cleared: .*made to fail/);
		expect(diffSnapshots(e.before, snapshotDb())).toEqual([]);
		expectFilesInPlace(e);
		expect(sqlite.inTransaction).toBe(false);

		expect(logLines()).toEqual([
			{
				level: 'ERROR',
				userId: e.admin.id,
				message: expect.stringMatching(/^A reset by admin \(ID: \d+\) failed, and nothing was cleared: /)
			}
		]);
	});

	it('clears nothing when the commit is refused, for a row left pointing at a row that went', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const e = everything();
		// A row that is still there at the commit and names a user who is not.
		// The reset empties this table with the rest, and the trigger puts the
		// row back as it goes, so the foreign key check, held until the commit,
		// fails there. Nothing real does this: it is a way to refuse the commit.
		sqlite.exec('CREATE TABLE "__new_leftover" (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id))');
		sqlite.exec(
			'CREATE TRIGGER leftover_comes_back AFTER DELETE ON "__new_leftover" ' +
				'BEGIN INSERT INTO "__new_leftover" (user_id) VALUES (old.user_id); END'
		);

		try {
			sqlite.prepare('INSERT INTO "__new_leftover" (user_id) VALUES (?)').run(e.owner.id);
			const before = snapshotDb();

			const res = await reset(e);

			expect(res.status).toBe(500);
			expect(res.body.message).toMatch(/nothing was cleared: FOREIGN KEY constraint failed/);
			expect(sqlite.inTransaction).toBe(false);
			expect(diffSnapshots(before, snapshotDb())).toEqual([]);
			expectFilesInPlace(e);
			// The checks are held for that one transaction only.
			expect(sqlite.pragma('defer_foreign_keys', { simple: true })).toBe(0);
			expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
		} finally {
			sqlite.exec('DROP TABLE "__new_leftover"');
		}
	});

	it('is not refused by a table left half way through a rebuild whose row names a user, and empties it', async () => {
		const e = everything();
		// What the migration runner reports and leaves alone: `__new_...`. Its
		// row names a user with no `ON DELETE` action. Left as it was, it would
		// refuse the commit of every reset on this database.
		sqlite.exec('CREATE TABLE "__new_leftover" (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id))');

		try {
			sqlite.prepare('INSERT INTO "__new_leftover" (user_id) VALUES (?)').run(e.owner.id);

			const res = await reset(e);

			expect(res.status).toBe(200);
			expect(sqlite.prepare('SELECT COUNT(*) AS n FROM "__new_leftover"').get()).toEqual({ n: 0 });
			expect(sqlite.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
			expect(sqlite.pragma('foreign_key_check')).toEqual([]);
		} finally {
			sqlite.exec('DROP TABLE "__new_leftover"');
		}
	});

	it('leaves foreign keys on, and no check held over, after a reset that succeeds', async () => {
		const e = everything();

		expect((await reset(e)).status).toBe(200);

		expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
		expect(sqlite.pragma('defer_foreign_keys', { simple: true })).toBe(0);
		expect(sqlite.pragma('foreign_key_check')).toEqual([]);
	});

	it('forgets the key the public request form signs with, so a form token made before it is refused after it', async () => {
		const e = everything();
		// As a process that has just started: nothing cached by an earlier test.
		resetFormSecretCache();
		const before = issueFormToken();
		expect(verifyFormToken(before)).toBe(true);
		expect(count('settings')).toBeGreaterThan(0);

		expect((await reset(e)).status).toBe(200);

		// The key was a setting and went with the rest. The copy of it in memory
		// used to stay, and went on accepting this token.
		expect(count('settings')).toBe(0);
		expect(verifyFormToken(before)).toBe(false);

		// A token made now is good, and is signed with a key that is in the
		// settings: a process starting now agrees with this one.
		const after = issueFormToken();
		expect(verifyFormToken(after)).toBe(true);
		expect(sqlite.prepare('SELECT key FROM settings').all()).toEqual([{ key: 'request_form_secret' }]);
		resetFormSecretCache();
		expect(verifyFormToken(after)).toBe(true);
		expect(verifyFormToken(before)).toBe(false);
	});

	it('says in its answer which files could not be moved, and is a success all the same', async () => {
		const e = everything();
		// A file name that climbs out of its card's folder, as a restored backup
		// could hold. It is refused, and so it is not moved.
		db.insert(cardAttachments)
			.values({ cardId: e.withFiles[0].id, filename: '../outside.txt', originalName: 'outside.txt' })
			.run();

		const res = await reset(e);

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ success: true, redirect: '/setup', trash: { moved: 3, missing: 0 } });
		expect(res.body.trash.failed).toEqual([expect.stringMatching(/^card \d+, "\.\.\/outside\.txt": /)]);
		for (const table of cleared()) expect(count(table), table).toBe(0);
		expect(logLines().at(-1)?.message).toMatch(
			/3 attachment file\(s\) moved to the trash, and 1 could not be moved and are where they were: card \d+, "\.\.\/outside\.txt"/
		);
	});

	it('moves no file that is not there, and counts it as missing', async () => {
		const e = everything();
		makeAttachment(e.withFiles[0], { name: 'row-only.txt', file: false });

		const res = await reset(e);

		expect(res.body.trash).toEqual({ moved: 3, missing: 1, failed: [] });
	});

	it('refuses everybody but the superadmin, an administrator included, with nothing cleared', async () => {
		const e = everything();
		// Whoever sets up after a reset is the superadmin, so an administrator
		// who could reset could make themselves that.
		const administrator = makeUser({ username: 'administrator', role: 'admin' });
		const before = snapshotDb();

		expect((await api('POST', '/api/admin/reset')).status).toBe(401);
		for (const user of [e.owner, administrator]) {
			const res = await api('POST', '/api/admin/reset', { user });
			expect(res.status).toBe(403);
			expect(res.body.message).toContain('belongs to the superadmin');
		}

		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		expectFilesInPlace(e);
		expect(logLines()).toEqual([]);
	});
});

// ─── Vacuum ─────────────────────────────────────────────────────────────────

describe('POST /api/admin/vacuum', () => {
	it('leaves the id counters as they were, so the next card does not get a deleted card\'s id', async () => {
		const e = everything();
		// The card with the highest id is deleted. Without its counter, the next
		// card made would be given that id again.
		const last = counter('cards')!;
		sqlite.prepare('DELETE FROM cards WHERE id = ?').run(last);
		const before = snapshotDb();
		expect(Object.keys(before.sqlite_sequence).length).toBeGreaterThan(10);

		const res = await api('POST', '/api/admin/vacuum', { user: e.admin });

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true });
		// Not a row and not a counter is different.
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);

		const board = makeBoard({ owner: e.owner });
		expect(makeCard(board.cols['To Do']).id).toBe(last + 1);
	});

	it('refuses a caller who is not an administrator', async () => {
		const e = everything();

		expect((await api('POST', '/api/admin/vacuum')).status).toBe(403);
		expect((await api('POST', '/api/admin/vacuum', { user: e.owner })).status).toBe(403);
		expect(diffSnapshots(e.before, snapshotDb())).toEqual([]);
	});
});
