/**
 * Deleting a user: what is kept, what goes, and that it is all or nothing.
 *
 * Five columns name a user through a foreign key with no `ON DELETE` action:
 * who uploaded an attachment, who made a template or a milestone, and who
 * recorded a dependency, in the table used now and in the one it replaced.
 * While any of them named a user, `DELETE /api/users/:id` failed on the key,
 * every time. Each is now cleared in the transaction that deletes the user,
 * and the row that held it stays.
 *
 * There is one test for each of the five, with that reference alone, so that
 * a column left out of the list fails by name.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import {
	apiKeys,
	boards,
	cardAssignees,
	cardAttachments,
	cardComments,
	cardDependencies,
	cards,
	cardTemplates,
	milestones,
	reportSchedules,
	sessions,
	users,
	userXp,
	workDependencies,
	type Card
} from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { api, type ApiResult } from './helpers/api';
import { eachWriteInTurn } from './helpers/each-write';
import { failingWrite } from './helpers/failing-write';
import {
	assignCard,
	makeAttachment,
	makeBoard,
	makeCard,
	makeComment,
	makeDependency,
	makeMilestone,
	makeUser,
	resetDb,
	testUploadsDir,
	type BoardFixture
} from './helpers/fixtures';
import { diffSnapshots, snapshotDb } from './helpers/snapshot';

beforeEach(resetDb);
afterEach(() => {
	process.env.LOG_LEVEL = 'ERROR';
});

type Scene = {
	admin: SessionUser;
	/** Owns the board. Not the one who is deleted. */
	owner: SessionUser;
	/** The one who is deleted. An ordinary user. */
	leaver: SessionUser;
	A: BoardFixture;
	first: Card;
	second: Card;
};

/** A board that belongs to somebody else, with two cards for the leaver to have touched. */
function scene(): Scene {
	const admin = makeUser({ username: 'admin', role: 'admin' });
	const owner = makeUser({ username: 'owner' });
	const leaver = makeUser({ username: 'leaver' });
	const A = makeBoard({ owner, name: 'A' });
	const first = makeCard(A.cols['To Do'], { title: 'First' });
	const second = makeCard(A.cols['To Do'], { title: 'Second', position: 1 });
	return { admin, owner, leaver, A, first, second };
}

const remove = (s: Scene, by: SessionUser = s.admin) => api('DELETE', `/api/users/${s.leaver.id}`, { user: by });

const userRow = (id: number) => db.select().from(users).where(eq(users.id, id)).get();

/** The five references, each made alone and read back alone. */
const REFERENCES: {
	column: string;
	/** Make one row that names the leaver, and return its id. */
	make: (s: Scene) => number;
	/** That row now, or undefined if it has gone. */
	read: (id: number) => Record<string, unknown> | undefined;
	/** The property of the row that named the leaver. */
	property: string;
}[] = [
	{
		column: 'card_attachments.uploaded_by',
		make: (s) => makeAttachment(s.first, { uploadedBy: s.leaver }).id,
		read: (id) => db.select().from(cardAttachments).where(eq(cardAttachments.id, id)).get(),
		property: 'uploadedBy'
	},
	{
		column: 'card_templates.created_by',
		make: (s) =>
			db
				.insert(cardTemplates)
				.values({ boardId: s.A.board.id, name: 'Bug report', title: 'Bug: ', createdBy: s.leaver.id })
				.returning()
				.get().id,
		read: (id) => db.select().from(cardTemplates).where(eq(cardTemplates.id, id)).get(),
		property: 'createdBy'
	},
	{
		column: 'milestones.created_by',
		make: (s) => makeMilestone({ name: 'Across boards', createdBy: s.leaver, cards: [s.first] }).id,
		read: (id) => db.select().from(milestones).where(eq(milestones.id, id)).get(),
		property: 'createdBy'
	},
	{
		column: 'work_dependencies.created_by_user_id',
		make: (s) => makeDependency({ blocked: s.second, blocker: s.first, createdBy: s.leaver }).id,
		read: (id) => db.select().from(workDependencies).where(eq(workDependencies.id, id)).get(),
		property: 'createdByUserId'
	},
	{
		column: 'card_dependencies.created_by_user_id',
		make: (s) =>
			db
				.insert(cardDependencies)
				.values({ cardId: s.second.id, dependsOnCardId: s.first.id, createdByUserId: s.leaver.id })
				.returning()
				.get().id,
		read: (id) => db.select().from(cardDependencies).where(eq(cardDependencies.id, id)).get(),
		property: 'createdByUserId'
	}
];

describe('DELETE /api/users/:id, for a user named by a key that has no ON DELETE action', () => {
	it.each(REFERENCES)('$column: the user goes, and the row stays with nobody named', async ({ make, read, property }) => {
		const s = scene();
		const id = make(s);
		const before = read(id)!;
		expect(before[property]).toBe(s.leaver.id);

		const res = await remove(s);

		// This was a 500 on the foreign key, and the user stayed.
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true });
		expect(userRow(s.leaver.id)).toBeUndefined();
		// The row is the row it was, but for the one column.
		expect(read(id)).toEqual({ ...before, [property]: null });
	});

	it('the list of five is every such key in the database', () => {
		// Asked of the database the migrations built, not of the model: a new
		// column that names a user and says nothing about a delete has to be
		// added to `USER_REFERENCES` in deletes.ts, and to the list above.
		const tables = (
			sqlite
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
				.all() as { name: string }[]
		).map((t) => t.name);

		const found: string[] = [];
		for (const table of tables) {
			for (const key of sqlite.prepare(`PRAGMA foreign_key_list("${table}")`).all() as {
				table: string;
				from: string;
				on_delete: string;
			}[]) {
				if (key.table === 'users' && !['CASCADE', 'SET NULL'].includes(key.on_delete)) {
					found.push(`${table}.${key.from}`);
				}
			}
		}
		expect(found.sort()).toEqual(REFERENCES.map((r) => r.column).sort());
	});

	it('an uploaded file stays where it was: only who uploaded it is forgotten', async () => {
		const s = scene();
		const attachment = makeAttachment(s.first, { uploadedBy: s.leaver });

		await remove(s);

		expect(existsSync(join(testUploadsDir(), String(s.first.id), attachment.filename))).toBe(true);
		expect(existsSync(join(testUploadsDir(), '.trash'))).toBe(false);
	});
});

// ─── Everything at once ─────────────────────────────────────────────────────

type Full = Scene & { ids: number[]; ownersKey: number; ownersSchedule: number };

/**
 * The leaver with all five references, and with everything else a user has:
 * XP, a session, an API key, a report schedule, a comment, an assignment, a
 * board of their own. Beside the key and the schedule, one each of somebody
 * else's.
 */
function full(): Full {
	const s = scene();
	const ids = REFERENCES.map((r) => r.make(s));

	db.insert(userXp)
		.values([
			{ name: s.leaver.username, xp: 250 },
			{ name: s.owner.username, xp: 100 }
		])
		.run();
	db.insert(sessions).values({ id: 'session-of-leaver', userId: s.leaver.id, expiresAt: '2099-01-01T00:00:00.000Z' }).run();

	const key = (user: SessionUser, n: number) =>
		db
			.insert(apiKeys)
			.values({ keyHash: `hash-${n}`, keyPrefix: `df_${n}`, name: `Key ${n}`, userId: user.id })
			.returning()
			.get().id;
	key(s.leaver, 1);
	key(s.leaver, 2);
	const ownersKey = key(s.owner, 3);

	const schedule = (user: SessionUser, name: string) =>
		db.insert(reportSchedules).values({ userId: user.id, name, scope: 'all' }).returning().get().id;
	schedule(s.leaver, 'Weekly, for the leaver');
	const ownersSchedule = schedule(s.owner, 'Weekly, for the owner');

	makeComment(s.first, s.leaver, 'Mine');
	makeComment(s.first, s.owner, 'Not mine');
	assignCard(s.first, s.leaver);
	assignCard(s.first, s.owner);
	makeBoard({ owner: s.leaver, name: 'Made by the leaver' });

	return { ...s, ids, ownersKey, ownersSchedule };
}

describe('DELETE /api/users/:id, for a user with everything', () => {
	it('clears the five references and deletes the user, or does neither', async () => {
		const run = await eachWriteInTurn({
			build: full,
			request: (s) => remove(s),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true });
				expect(userRow(s.leaver.id)).toBeUndefined();

				// Each of the five rows is still there, and names nobody.
				REFERENCES.forEach((reference, i) => {
					const row = reference.read(s.ids[i]);
					expect(row, reference.column).toBeDefined();
					expect(row![reference.property], reference.column).toBeNull();
				});

				// Their XP is kept. It is keyed by name, and has no key to a user.
				expect(db.select().from(userXp).all()).toEqual([
					{ name: 'leaver', xp: 250, emoji: '👤' },
					{ name: 'owner', xp: 100, emoji: '👤' }
				]);

				// Their API keys and report schedules go with them. Nobody else's do.
				expect(db.select({ id: apiKeys.id }).from(apiKeys).all()).toEqual([{ id: s.ownersKey }]);
				expect(db.select({ id: reportSchedules.id }).from(reportSchedules).all()).toEqual([
					{ id: s.ownersSchedule }
				]);

				// So do their session, their comments and their assignments.
				expect(db.select().from(sessions).all()).toEqual([]);
				expect(db.select({ content: cardComments.content }).from(cardComments).all()).toEqual([
					{ content: 'Not mine' }
				]);
				expect(db.select({ userId: cardAssignees.userId }).from(cardAssignees).all()).toEqual([
					{ userId: s.owner.id }
				]);

				// A board they made stays, with nobody named as having made it, and
				// so does every card.
				expect(
					db.select({ name: boards.name, createdBy: boards.createdBy }).from(boards).all()
				).toEqual([
					{ name: 'A', createdBy: s.owner.id },
					{ name: 'Made by the leaver', createdBy: null }
				]);
				expect(db.select().from(cards).all()).toHaveLength(2);
			}
		});

		// The five, in the order of the list, and then the user. Nothing else is
		// written: the rest is the keys' doing.
		expect(run.writes).toEqual([
			'UPDATE card_attachments SET uploaded_by = NULL WHERE uploaded_by = ?',
			'UPDATE card_templates SET created_by = NULL WHERE created_by = ?',
			'UPDATE milestones SET created_by = NULL WHERE created_by = ?',
			'UPDATE work_dependencies SET created_by_user_id = NULL WHERE created_by_user_id = ?',
			'UPDATE card_dependencies SET created_by_user_id = NULL WHERE created_by_user_id = ?',
			'DELETE FROM users WHERE id = ?'
		]);
		expect(run.effects).toEqual([]);
	});

	it('writes one line to the system log once it is committed, saying who deleted whom', async () => {
		process.env.LOG_LEVEL = 'INFO';
		const s = full();

		await remove(s);

		expect(
			sqlite.prepare("SELECT level, message, user_id AS userId FROM system_logs WHERE context = 'DELETE'").all()
		).toEqual([
			{
				level: 'INFO',
				userId: s.admin.id,
				message:
					`User ${s.leaver.id} "leaver" was deleted by admin: 2 API key(s), 1 report schedule(s) and ` +
					'1 comment(s) went with them; 5 row(s) they had uploaded, created or recorded were kept and name nobody now'
			}
		]);
	});

	it('writes no such line when the delete fails', async () => {
		process.env.LOG_LEVEL = 'INFO';
		const s = full();
		const before = snapshotDb();
		const writes = failingWrite();

		try {
			// The last write of all: the user.
			writes.failNth(6);
			await expect(remove(s)).rejects.toThrow(/made to fail/);
			expect(writes.fired).toBe(true);
		} finally {
			writes.restore();
		}

		expect(sqlite.prepare("SELECT message FROM system_logs WHERE context = 'DELETE'").all()).toEqual([]);
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
	});
});

describe('DELETE /api/users/:id, refused', () => {
	it('answers as it always did, from inside the transaction, with nobody deleted', async () => {
		const s = full();
		const superadmin = makeUser({ username: 'root', role: 'superadmin' });
		const otherAdmin = makeUser({ username: 'admin2', role: 'admin' });
		const before = snapshotDb();

		const refusals: [string, () => Promise<ApiResult>, number, string][] = [
			['nobody signed in', () => api('DELETE', `/api/users/${s.leaver.id}`), 403, 'Forbidden'],
			['an ordinary user', () => remove(s, s.owner), 403, 'Forbidden'],
			[
				'yourself',
				() => api('DELETE', `/api/users/${s.admin.id}`, { user: s.admin }),
				400,
				'Cannot delete your own account'
			],
			['a user who is not there', () => api('DELETE', '/api/users/99999', { user: s.admin }), 404, 'User not found'],
			[
				'the superadmin',
				() => api('DELETE', `/api/users/${superadmin.id}`, { user: s.admin }),
				403,
				'Cannot delete superadmin account'
			],
			[
				'an admin, by an admin',
				() => api('DELETE', `/api/users/${otherAdmin.id}`, { user: s.admin }),
				403,
				'Only superadmin can delete admin users'
			]
		];
		for (const [what, request, status, message] of refusals) {
			const res = await request();
			expect(res.status, what).toBe(status);
			expect(res.body.message, what).toBe(message);
		}

		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
	});

	it('lets the superadmin delete an admin', async () => {
		const s = scene();
		const superadmin = makeUser({ username: 'root', role: 'superadmin' });

		const res = await api('DELETE', `/api/users/${s.admin.id}`, { user: superadmin });

		expect(res.status).toBe(200);
		expect(userRow(s.admin.id)).toBeUndefined();
	});
});
