/**
 * Card 3002: the record of every change of who may open a board, who is in a team and which account a person is
 * linked to, and the one rule that reads it (src/lib/server/access-changes.ts).
 *
 * Slice 2, the readers: (f), the rule as a table, on hand-inserted record rows (plan section 6), and (v), the plan of
 * each read SQLite makes with 1,000 rows. The restore's steps are in tests/backups.test.ts.
 *
 * Slice 3, the writers and the start pass: (x) to (dd), each writer's rows through its route or service, and (gg) to
 * (hh), the start's pass of `sweepEndedKeyReveals`. The inventory and the append-only pins, (ee) and (ff), are in
 * tests/check-at-the-write.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { sqlite } from '$lib/server/db';
import { runMigrations } from '$lib/server/db/migrate';
import { restoreFromBackup } from '$lib/server/db/restore';
import { generateBackupData } from '$lib/server/backup';
import { backupSealKey, sealCopy } from '$lib/server/backup-secrets';
import { ACCESS_READS, accessCeiling, accessRank, recordAccessChange, type AccessItem, type AccessKind } from '$lib/server/access-changes';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { boards } from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import type { SessionUser } from '$lib/server/auth';
import { writeAs, type ServiceOptions } from '$lib/server/write-as';
import { addFromAccounts, createPerson, updatePerson } from '$lib/server/people';
import { sweepEndedKeyReveals } from '$lib/server/startup-checks';
import { stamp } from '$lib/timestamps';
import { api } from './helpers/api';
import { effects } from './helpers/effects';
import { allowOtherTimestampForms } from './helpers/timestamps';
import { makeApiKeyRow, makeBoard, makeSmtp, makeTeam, makeUser, makeWebhook, resetDb } from './helpers/fixtures';

const REAL_MIGRATIONS = join(process.cwd(), 'drizzle');

const opened: Database.Database[] = [];

/** A separate in-memory database with every migration applied, and no rows: an empty record. */
function migratedDb(): Database.Database {
	const database = new Database(':memory:');
	opened.push(database);
	runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
	return database;
}

afterEach(() => {
	for (const database of opened.splice(0)) database.close();
});

/** A row of the record, as a writer or a restore would have put it. */
type Row = { kind: AccessKind; subject: number; subjectCreated?: string; holder?: number; holderCreated?: string; access: string; at: string; origin?: 'here' | 'backup' };

const B = '2026-01-01 09:00:00';
const U = '2026-01-02 09:00:00';
const T = '2026-01-03 09:00:00';

/** Rows put into `database`'s record, in order: `seq` is the order of writing. */
function record(database: Database.Database, rows: readonly Row[]): void {
	const put = database.prepare(
		'INSERT INTO access_changes (kind, subject_id, subject_created, holder_id, holder_created, access, changed_at, stated_changed, origin) ' +
			'VALUES (@kind, @subject, @subjectCreated, @holder, @holderCreated, @access, @at, @at, @origin)'
	);
	for (const row of rows) {
		put.run({ subjectCreated: B, holder: 0, holderCreated: '', origin: 'here', ...row });
	}
}

/** Board 1 tracked: its marker row. */
const BOARD_TRACKED: Row = { kind: 'board', subject: 1, access: 'tracked', at: '0001-01-01 00:00:00' };
/** Bob, account 2, as a member of board 1. */
const bob = (access: string, at: string, origin: 'here' | 'backup' = 'here', holderCreated = U): Row => ({
	kind: 'board_member',
	subject: 1,
	holder: 2,
	holderCreated,
	access,
	at,
	origin
});
const BOB_ON_B: AccessItem = { kind: 'board_member', subject: { id: 1, created: B }, holder: { id: 2, created: U } };

describe('the rule as a table (card 3002, (f))', () => {
	it('(f)[1] a tracked board, no row for the member, absent here before the clear: none; held before: left; an untracked board: left', () => {
		const database = migratedDb();
		record(database, [BOARD_TRACKED]);
		expect(accessCeiling(database, BOB_ON_B, { guess: true, heldBefore: false })).toBe(0);
		// R4: what this server held before the clear is never taken on a guess.
		expect(accessCeiling(database, BOB_ON_B, { guess: true, heldBefore: true })).toBeNull();
		// The start pass never guesses (R2).
		expect(accessCeiling(database, BOB_ON_B)).toBeNull();
		// Board 2 has no marker: untracked, left as it is.
		expect(accessCeiling(database, { ...BOB_ON_B, subject: { id: 2, created: B } }, { guess: true })).toBeNull();
	});

	it('(f)[2] the clock step (R1): two rows of this server, the later in seq dated earlier: the later in seq decides', () => {
		const database = migratedDb();
		record(database, [BOARD_TRACKED, bob('owner', '2026-05-01 09:00:00'), bob('viewer', '2026-04-01 09:00:00')]);
		expect(accessCeiling(database, BOB_ON_B, { guess: true })).toBe(accessRank('board_member', 'viewer'));
	});

	it("(f)[3] a backup's raise beside a row of this server's is not let raise it", () => {
		const database = migratedDb();
		record(database, [BOARD_TRACKED, bob('viewer', '2026-05-01 09:00:00'), bob('owner', '2026-06-01 09:00:00', 'backup')]);
		expect(accessCeiling(database, BOB_ON_B, { guess: true })).toBe(1);
	});

	it("(f)[4] a backup's narrowing dated after this server's latest row counts; one dated before it does not", () => {
		const database = migratedDb();
		record(database, [BOARD_TRACKED, bob('none', '2026-04-01 09:00:00', 'backup'), bob('owner', '2026-05-01 09:00:00'), bob('viewer', '2026-06-01 09:00:00', 'backup')]);
		expect(accessCeiling(database, BOB_ON_B, { guess: true })).toBe(1);
	});

	it("(f)[5] a backup's rows alone: the latest by (changed_at, seq), not by seq alone", () => {
		const database = migratedDb();
		record(database, [BOARD_TRACKED, bob('viewer', '2026-06-01 09:00:00', 'backup'), bob('owner', '2026-05-01 09:00:00', 'backup')]);
		expect(accessCeiling(database, BOB_ON_B, { guess: true })).toBe(1);
		// Two of one moment: the later in seq.
		record(database, [bob('editor', '2026-06-01 09:00:00', 'backup')]);
		expect(accessCeiling(database, BOB_ON_B, { guess: true })).toBe(2);
	});

	it("(f)[6] the account's creation time differs from the record's: no row names it; none on a tracked board, left on an untracked one", () => {
		const database = migratedDb();
		record(database, [BOARD_TRACKED, bob('owner', '2026-05-01 09:00:00')]);
		const another = { ...BOB_ON_B, holder: { id: 2, created: '2026-03-03 09:00:00' } };
		expect(accessCeiling(database, BOB_ON_B, { guess: true })).toBe(3);
		expect(accessCeiling(database, another, { guess: true })).toBe(0);
		record(database, [{ ...bob('owner', '2026-05-01 09:00:00'), subject: 2 }]);
		expect(accessCeiling(database, { ...another, subject: { id: 2, created: B } }, { guess: true })).toBeNull();
	});

	it('(f)[7] an identity kind with a restored creation time that names no moment: never matched, cleared (R8), with no guess', () => {
		const database = migratedDb();
		record(database, [BOARD_TRACKED, { kind: 'product_owner', subject: 1, holder: 2, holderCreated: U, access: 'yes', at: '2026-05-01 09:00:00' }]);
		const owner: AccessItem = { kind: 'product_owner', subject: { id: 1, created: B }, holder: { id: 2, created: U } };
		expect(accessCeiling(database, owner)).toBe(1);
		expect(accessCeiling(database, { ...owner, holder: { id: 2, created: null } })).toBe(0);
		expect(accessCeiling(database, { ...owner, subject: { id: 1, created: null } })).toBe(0);
		// A board the record holds no Product Owner row of, its time no moment: left.
		expect(accessCeiling(database, { ...owner, subject: { id: 9, created: null } })).toBeNull();
	});

	it('(f)[8] an ordinal kind with a restored creation time that names no moment: matched by id alone, the lowest ceiling', () => {
		const database = migratedDb();
		record(database, [BOARD_TRACKED, bob('editor', '2026-05-01 09:00:00'), bob('viewer', '2026-05-01 09:00:00', 'here', '2026-03-03 09:00:00')]);
		expect(accessCeiling(database, { ...BOB_ON_B, holder: { id: 2, created: null } }, { guess: true })).toBe(1);
		expect(accessCeiling(database, { ...BOB_ON_B, subject: { id: 1, created: null }, holder: { id: 2, created: null } }, { guess: true })).toBe(1);
		// An id no row names: left, not guessed.
		expect(accessCeiling(database, { ...BOB_ON_B, holder: { id: 7, created: null } })).toBeNull();
	});

	it("(f)[9] a team deleted here, then a member added (R2): the member added after counts; one from before, and a share from before, are none", () => {
		const database = migratedDb();
		const team = (access: string, at: string): Row => ({ kind: 'team', subject: 5, subjectCreated: T, access, at });
		const member = (holder: number, access: string, at: string): Row => ({ kind: 'team_member', subject: 5, subjectCreated: T, holder, holderCreated: U, access, at });
		record(database, [
			BOARD_TRACKED,
			team('tracked', '2026-04-01 09:00:00'),
			member(2, 'owner', '2026-04-01 09:00:00'),
			{ kind: 'board_team', subject: 1, holder: 5, holderCreated: T, access: 'editor', at: '2026-04-01 09:00:00' },
			team('deleted', '2026-05-01 09:00:00'),
			// Dated earlier than the deletion: written later here, so it ranks later (R1).
			member(3, 'member', '2026-03-01 09:00:00')
		]);
		const of = (holder: number): AccessItem => ({ kind: 'team_member', subject: { id: 5, created: T }, holder: { id: holder, created: U } });
		expect(accessCeiling(database, of(2), { guess: true })).toBe(0);
		expect(accessCeiling(database, of(3), { guess: true })).toBe(1);
		expect(accessCeiling(database, { kind: 'board_team', subject: { id: 1, created: B }, holder: { id: 5, created: T } }, { guess: true })).toBe(0);
	});

	describe('on this server', () => {
		beforeEach(() => resetDb());

		it('(f)[10] a role that is not one of the kind\'s words, not lowered: its text kept (R15); lowered: the word', () => {
			const chief = makeUser({ username: 'chief', role: 'superadmin' });
			const ann = makeUser({ username: 'ann' });
			const cat = makeUser({ username: 'cat' });
			const board = makeBoard({ owner: chief, name: 'Plans' });
			const createdOf = (table: string, id: number) => sqlite.prepare(`SELECT created_at FROM ${table} WHERE id = ?`).pluck().get(id) as string;
			sqlite.prepare("INSERT INTO board_members (board_id, user_id, role) VALUES (?, ?, 'admin'), (?, ?, 'admin')").run(board.board.id, ann.id, board.board.id, cat.id);
			const put = sqlite.prepare(
				"INSERT INTO access_changes (kind, subject_id, subject_created, holder_id, holder_created, access, changed_at, stated_changed) VALUES (?, ?, ?, ?, ?, ?, '2026-05-01 09:00:00', '2026-05-01 09:00:00')"
			);
			put.run('board', board.board.id, createdOf('boards', board.board.id), chief.id, createdOf('users', chief.id), 'tracked');
			put.run('board_member', board.board.id, createdOf('boards', board.board.id), ann.id, createdOf('users', ann.id), 'editor');
			put.run('board_member', board.board.id, createdOf('boards', board.board.id), cat.id, createdOf('users', cat.id), 'none');
			const backup = new Database(generateBackupData());
			opened.push(backup);
			// Cat is an `admin` in the backup too, and the record has her as none: removed. Ann's `admin` reads as viewer,
			// under her editor ceiling: kept as its text.
			sealCopy(backup, backupSealKey(sqlite));

			const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

			expect(result.sealVerified).toBe(true);
			expect(sqlite.prepare('SELECT user_id, role FROM board_members WHERE board_id = ? AND user_id IN (?, ?) ORDER BY user_id').raw().all(board.board.id, ann.id, cat.id)).toEqual([
				[ann.id, 'admin']
			]);
			expect(result.accessKept).toMatchObject({ removed: 1, lowered: 0 });
		});
	});
});

describe('the reads use their indexes (card 3002, (v))', () => {
	it('(v) with 1,000 rows: the pair, subject and union reads use their indexes, and the latest-row reads, those of the start pass included, need no sort', () => {
		const database = migratedDb();
		const rows: Row[] = [];
		for (let i = 0; i < 1000; i++) {
			rows.push({ ...bob(i % 2 === 0 ? 'viewer' : 'editor', '2026-05-01 09:00:00', i % 3 === 0 ? 'backup' : 'here'), subject: 1 + (i % 50), holder: 2 + (i % 7) });
		}
		record(database, rows);
		database.exec('ANALYZE');
		const planOf = (sql: string) =>
			(database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ subject: 1, kind: 'board_member', subjectCreated: B, holder: 2, holderCreated: U, deleted: 0, after: '', at: '', asOf: '' }) as { detail: string }[])
				.map((step) => step.detail)
				.join('; ');
		// Slice 3 adds the start pass's reads (R1): this server's latest row dated no later than its moment.
		const pair = [ACCESS_READS.pairHere, ACCESS_READS.pairHereAsOf, ACCESS_READS.pairBackupAfter, ACCESS_READS.pairBackupLatestAt, ACCESS_READS.pairBackupLatest, ACCESS_READS.createdOfHolder];
		const subject = [ACCESS_READS.subjectHere, ACCESS_READS.subjectHereAsOf, ACCESS_READS.subjectBackupAfter, ACCESS_READS.subjectBackupLatestAt, ACCESS_READS.subjectBackupLatest];
		for (const sql of pair) expect(planOf(sql), sql).toMatch(/USING (COVERING )?INDEX access_changes_(pair|union)/);
		for (const sql of subject) expect(planOf(sql), sql).toMatch(/USING (COVERING )?INDEX access_changes_(subject|pair|union)/);
		for (const sql of [ACCESS_READS.tracked, ACCESS_READS.trackedById, ACCESS_READS.createdOfSubject]) expect(planOf(sql), sql).toMatch(/USING (COVERING )?INDEX access_changes_/);
		// The latest-row reads: in seq order straight off the index, no sort.
		for (const sql of [ACCESS_READS.pairHere, ACCESS_READS.subjectHere, ACCESS_READS.pairHereAsOf, ACCESS_READS.subjectHereAsOf, ACCESS_READS.pairBackupLatest, ACCESS_READS.subjectBackupLatest]) {
			expect(planOf(sql), sql).not.toContain('TEMP B-TREE');
		}
		// The restore's union (R10): its NOT EXISTS on its own index.
		const union =
			'SELECT 1 FROM access_changes WHERE subject_id = @subject AND kind = @kind AND subject_created = @subjectCreated AND holder_id = @holder ' +
			"AND holder_created = @holderCreated AND stated_changed = @at AND access = 'viewer' AND seq <= 5";
		expect(planOf(union)).toMatch(/USING (COVERING )?INDEX access_changes_union/);
	});
});

// ─── Slice 3: the writers and the start pass ─────────────

describe('every change of access here is recorded, and the start lowers what is above the record (card 3002, slice 3)', () => {
	const UI: ServiceOptions = { source: 'ui' };
	const as = <T>(user: SessionUser, write: (caller: SessionUser | null) => T): T => writeAs({ user } as App.Locals, write as never) as T;
	type Recorded = { kind: string; subject: number; holder: number; access: string };
	/** The rows this server's record holds, past `after`, as kind, subject, holder and word. */
	const rowsAfter = (after: number): Recorded[] =>
		sqlite.prepare('SELECT kind, subject_id AS subject, holder_id AS holder, access FROM access_changes WHERE seq > ? ORDER BY seq').all(after) as Recorded[];
	const lastSeq = () => Number(sqlite.prepare('SELECT coalesce(max(seq), 0) FROM access_changes').pluck().get());
	/** The rows a call writes to the record. */
	const recordedBy = async (call: () => unknown): Promise<Recorded[]> => {
		const before = lastSeq();
		await call();
		return rowsAfter(before);
	};
	const createdOf = (table: string, id: number) => sqlite.prepare(`SELECT created_at FROM ${table} WHERE id = ?`).pluck().get(id) as string;
	const membersOf = (boardId: number) => sqlite.prepare('SELECT user_id, role FROM board_members WHERE board_id = ? ORDER BY user_id').raw().all(boardId);
	const authWarnings = () => sqlite.prepare("SELECT message FROM system_logs WHERE context = 'AUTH' AND level = 'WARN' ORDER BY id").pluck().all() as string[];
	const accessWarnings = () => authWarnings().filter((line) => line.includes("record of access changes"));
	/** A board made through the page by `owner`, as every board here now is: tracked, with its three rows. */
	const madeBoard = async (owner: SessionUser, name = 'Plans'): Promise<number> => {
		const res = await api('POST', '/api/boards', { user: owner, body: { name } });
		expect(res.status).toBe(201);
		return (res.body as { id: number }).id;
	};
	const share = (owner: SessionUser, boardId: number, body: Record<string, unknown>) => api('POST', `/api/boards/${boardId}/share`, { user: owner, body });

	let chief: SessionUser;
	let olga: SessionUser;
	let bob: SessionUser;
	let carol: SessionUser;
	const logLevel = process.env.LOG_LEVEL;
	beforeEach(() => {
		// The start's WARNs are kept in system_logs at INFO.
		process.env.LOG_LEVEL = 'INFO';
		resetDb();
		chief = makeUser({ username: 'chief', role: 'superadmin' });
		olga = makeUser({ username: 'olga' });
		bob = makeUser({ username: 'bob' });
		carol = makeUser({ username: 'carol' });
	});

	afterEach(() => {
		if (logLevel === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = logLevel;
	});

	it('(x) recordAccessChange outside a transaction throws and writes nothing; inside, the creation columns are stamp_of of the rows, and a subject whose time names no moment is not recorded', () => {
		allowOtherTimestampForms();
		const { board } = makeBoard({ owner: olga });
		sqlite.prepare("UPDATE boards SET created_at = '2026-03-04T05:06:07.000Z' WHERE id = ?").run(board.id);
		const before = lastSeq();
		const change = { kind: 'board_member' as const, subject: board.id, holder: bob.id, access: 'editor' };

		expect(() => recordAccessChange(sqlite, change)).toThrow(/inside the transaction of the change/);
		expect(rowsAfter(before)).toEqual([]);

		expect(inTransaction(() => recordAccessChange(sqlite, change))).toBe(true);
		expect(sqlite.prepare('SELECT subject_created, holder_created, origin, changed_at = stated_changed AS same FROM access_changes WHERE seq > ?').raw().all(before)).toEqual([
			['2026-03-04 05:06:07', createdOf('users', bob.id), 'here', 1]
		]);
		// A Product Owner of none: holder 0 and '', the word none.
		inTransaction(() => recordAccessChange(sqlite, { kind: 'product_owner', subject: board.id, holder: null, access: 'yes' }));
		expect(rowsAfter(before).at(-1)).toEqual({ kind: 'product_owner', subject: board.id, holder: 0, access: 'none' });
		// Untracked: a creation time that names no moment.
		sqlite.prepare("UPDATE boards SET created_at = 'zzz' WHERE id = ?").run(board.id);
		const at = lastSeq();
		expect(inTransaction(() => recordAccessChange(sqlite, change))).toBe(false);
		expect(rowsAfter(at)).toEqual([]);
	});

	it("(y) a board made from the page, through v1 and as a card's sub-board writes its marker with its creator, private, and its owner", async () => {
		const three = (id: number, by: SessionUser): Recorded[] => [
			{ kind: 'board', subject: id, holder: by.id, access: 'tracked' },
			{ kind: 'board_public', subject: id, holder: 0, access: 'private' },
			{ kind: 'board_member', subject: id, holder: by.id, access: 'owner' }
		];
		let id = 0;
		expect(await recordedBy(async () => (id = await madeBoard(olga)))).toEqual(three(id, olga));
		expect(
			await recordedBy(async () => {
				const res = await api('POST', '/api/v1/boards', { user: bob, body: { name: 'Through v1' } });
				expect(res.status).toBe(201);
				id = (res.body as { id: number }).id;
			})
		).toEqual(three(id, bob));
		const column = sqlite.prepare("SELECT id FROM columns WHERE board_id = ? AND title = 'In Progress'").pluck().get(id) as number;
		const rows = await recordedBy(async () => {
			const res = await api('POST', '/api/cards', { user: bob, body: { columnId: column, title: 'With a sub-board', subBoards: [{ name: 'Under it' }] } });
			expect(res.status).toBe(201);
		});
		const sub = sqlite.prepare("SELECT id FROM boards WHERE name = 'Under it'").pluck().get() as number;
		expect(rows).toEqual(three(sub, bob));
	});

	it('(z) the share writes its rows for a person and a team, none for a role or visibility the live row and the record both hold, and one (R12) for a grant the record does not hold', async () => {
		const board = await madeBoard(olga);
		const team = makeTeam([carol]);
		const member = (holder: number, access: string): Recorded => ({ kind: 'board_member', subject: board, holder, access });
		const shared = (access: string): Recorded => ({ kind: 'board_team', subject: board, holder: team.id, access });
		const visible = (access: string): Recorded => ({ kind: 'board_public', subject: board, holder: 0, access });

		expect(await recordedBy(() => share(olga, board, { type: 'user', targetId: bob.id, role: 'viewer' }))).toEqual([member(bob.id, 'viewer')]);
		expect(await recordedBy(() => share(olga, board, { type: 'user', targetId: bob.id, role: 'editor' }))).toEqual([member(bob.id, 'editor')]);
		expect(await recordedBy(() => share(olga, board, { type: 'user', targetId: bob.id, role: 'editor' }))).toEqual([]);
		expect(await recordedBy(() => share(olga, board, { type: 'team', targetId: team.id, role: 'viewer' }))).toEqual([shared('viewer')]);
		expect(await recordedBy(() => share(olga, board, { type: 'team', targetId: team.id, role: 'viewer' }))).toEqual([]);
		// R12: an older image's grant, with no row: sent again as it is, recorded.
		sqlite.prepare("INSERT INTO board_members (board_id, user_id, role) VALUES (?, ?, 'editor')").run(board, carol.id);
		expect(await recordedBy(() => share(olga, board, { type: 'user', targetId: carol.id, role: 'editor' }))).toEqual([member(carol.id, 'editor')]);
		expect(await recordedBy(() => share(olga, board, { type: 'user', targetId: carol.id, role: 'editor' }))).toEqual([]);

		const patch = (isPublic: boolean) => api('PATCH', `/api/boards/${board}/share`, { user: olga, body: { isPublic } });
		expect(await recordedBy(() => patch(true))).toEqual([visible('public')]);
		// The visibility the board has, sent again: the route writes it, and records nothing.
		expect(await recordedBy(() => patch(true))).toEqual([]);
		expect(await recordedBy(() => patch(false))).toEqual([visible('private')]);
		// R12: made public by a host edit, with no row: sent again as it is, recorded.
		sqlite.prepare('UPDATE boards SET is_public = 1 WHERE id = ?').run(board);
		expect(await recordedBy(() => patch(true))).toEqual([visible('public')]);

		const remove = (body: Record<string, unknown>) => api('DELETE', `/api/boards/${board}/share`, { user: olga, body });
		expect(await recordedBy(() => remove({ type: 'user', targetId: bob.id }))).toEqual([member(bob.id, 'none')]);
		expect(await recordedBy(() => remove({ type: 'team', targetId: team.id }))).toEqual([shared('none')]);
		// Nothing there: 404, nothing recorded.
		expect(await recordedBy(async () => expect((await remove({ type: 'user', targetId: bob.id })).status).toBe(404))).toEqual([]);
	});

	it('(aa) a board change from the page and through v1 records its visibility and Product Owner only when they change; a name change writes none', async () => {
		const board = await madeBoard(olga);
		await share(olga, board, { type: 'user', targetId: bob.id, role: 'editor' });
		const put = (path: string, body: Record<string, unknown>) => api('PUT', path, { user: olga, body });
		const page = `/api/boards/${board}`;
		const v1 = `/api/v1/boards/${board}`;

		expect(await recordedBy(() => put(page, { name: 'Renamed' }))).toEqual([]);
		expect(await recordedBy(() => put(page, { isPublic: true }))).toEqual([{ kind: 'board_public', subject: board, holder: 0, access: 'public' }]);
		expect(await recordedBy(() => put(page, { isPublic: true }))).toEqual([]);
		expect(await recordedBy(() => put(page, { productOwnerUserId: bob.id }))).toEqual([{ kind: 'product_owner', subject: board, holder: bob.id, access: 'yes' }]);
		expect(await recordedBy(() => put(v1, { isPublic: false }))).toEqual([{ kind: 'board_public', subject: board, holder: 0, access: 'private' }]);
		expect(await recordedBy(() => put(v1, { name: 'Again' }))).toEqual([]);
		expect(await recordedBy(() => put(v1, { productOwnerUserId: null }))).toEqual([{ kind: 'product_owner', subject: board, holder: 0, access: 'none' }]);
	});

	it('(bb) a team made, a member added, a role changed (R12 as (z)), a member removed and the team deleted each write their rows', async () => {
		let team = 0;
		const made = await recordedBy(async () => {
			const res = await api('POST', '/api/teams', { user: olga, body: { name: 'Platform' } });
			expect(res.status).toBe(201);
			team = (res.body as { id: number }).id;
		});
		const member = (holder: number, access: string): Recorded => ({ kind: 'team_member', subject: team, holder, access });
		expect(made).toEqual([{ kind: 'team', subject: team, holder: 0, access: 'tracked' }, member(olga.id, 'owner')]);
		const add = (user: SessionUser, body: Record<string, unknown> = {}) => api('POST', `/api/teams/${team}/members/${user.id}`, { user: olga, body });

		expect(await recordedBy(() => add(bob))).toEqual([member(bob.id, 'member')]);
		expect(await recordedBy(() => add(bob, { role: 'owner' }))).toEqual([member(bob.id, 'owner')]);
		expect(await recordedBy(() => add(bob, { role: 'owner' }))).toEqual([]);
		// R12: a membership a host edit gave, with no row: sent again as it is, recorded.
		sqlite.prepare("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'member')").run(team, carol.id);
		expect(await recordedBy(() => add(carol, { role: 'member' }))).toEqual([member(carol.id, 'member')]);
		expect(await recordedBy(() => add(carol, { role: 'member' }))).toEqual([]);

		expect(await recordedBy(() => api('DELETE', `/api/teams/${team}/members/${carol.id}`, { user: olga }))).toEqual([member(carol.id, 'none')]);
		// Nobody there to remove (N3): answered as done, nothing recorded.
		expect(await recordedBy(() => api('DELETE', `/api/teams/${team}/members/${carol.id}`, { user: olga }))).toEqual([]);
		expect(await recordedBy(() => api('DELETE', `/api/teams/${team}`, { user: olga }))).toEqual([{ kind: 'team', subject: team, holder: 0, access: 'deleted' }]);
	});

	it('(cc) a person made, linked, made from accounts and renamed: person_link for each link, and none for the rename', async () => {
		const admin = makeUser({ username: 'ada', role: 'admin' });
		let id = 0;
		const link = (holder: number, access: string): Recorded => ({ kind: 'person_link', subject: id, holder, access });
		expect(
			await recordedBy(() => (id = as(admin, (caller) => createPerson(caller, {}, { fullName: 'Bob Hart', email: 'bob.hart@example.test', userId: bob.id }, UI)).id))
		).toEqual([link(bob.id, 'linked')]);
		expect(await recordedBy(() => (id = as(admin, (caller) => createPerson(caller, {}, { fullName: 'Nobody', email: 'nobody@example.test' }, UI)).id))).toEqual([link(0, 'none')]);
		const update = (body: Record<string, unknown>) => () => as(admin, (caller) => updatePerson(caller, { personId: id }, body, { ...UI, steppedUp: true }));
		expect(await recordedBy(update({ fullName: 'Somebody' }))).toEqual([]);
		expect(await recordedBy(update({ userId: carol.id }))).toEqual([link(carol.id, 'linked')]);
		expect(await recordedBy(update({ userId: null }))).toEqual([link(0, 'none')]);
		const before = lastSeq();
		as(admin, (caller) => addFromAccounts(caller, {}, { userIds: [olga.id] }, UI));
		id = sqlite.prepare('SELECT id FROM people WHERE user_id = ?').pluck().get(olga.id) as number;
		expect(rowsAfter(before)).toEqual([link(olga.id, 'linked')]);
	});

	it("(dd) end to end: Bob taken off a board through the share window, this server's sealed backup from before restored: Bob is not a member", async () => {
		const board = await madeBoard(olga);
		await share(olga, board, { type: 'user', targetId: bob.id, role: 'editor' });
		const backup = new Database(generateBackupData());
		opened.push(backup);
		sealCopy(backup, backupSealKey(sqlite));
		expect((await api('DELETE', `/api/boards/${board}/share`, { user: olga, body: { type: 'user', targetId: bob.id } })).status).toBe(200);

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.sealVerified).toBe(true);
		expect(membersOf(board)).toEqual([[olga.id, 'owner']]);
		expect(result.accessKept).toMatchObject({ removed: 1 });
	});

	/**
	 * The start's scene: board B made by Olga; Bob shared as a viewer and then raised to owner by a host edit; Carol
	 * shared and taken off, then put back by a host edit with her webhook; Dan put on B by a host edit with no row at all.
	 */
	const startScene = async () => {
		const dan = makeUser({ username: 'dan' });
		const board = await madeBoard(olga);
		await share(olga, board, { type: 'user', targetId: bob.id, role: 'viewer' });
		await share(olga, board, { type: 'user', targetId: carol.id, role: 'editor' });
		await api('DELETE', `/api/boards/${board}/share`, { user: olga, body: { type: 'user', targetId: carol.id } });
		sqlite.prepare("UPDATE board_members SET role = 'owner' WHERE board_id = ? AND user_id = ?").run(board, bob.id);
		sqlite.prepare("INSERT INTO board_members (board_id, user_id, role) VALUES (?, ?, 'editor'), (?, ?, 'editor')").run(board, carol.id, board, dan.id);
		sqlite.prepare("UPDATE users SET last_sign_in_at = '2026-11-01 09:00:00' WHERE id = ?").run(bob.id);
		const row = db.select().from(boards).where(eq(boards.id, board)).get()!;
		const olgas = makeWebhook(row, { setBy: olga, secret: 'whsec-3002-gg-o' });
		const carols = makeWebhook(row, { setBy: carol, secret: 'whsec-3002-gg-c' });
		return { board, dan, olgas, carols };
	};
	const hookOf = (id: number) => sqlite.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(id);

	it.each([
		{ schedulers: 'off', mailed: false },
		{ schedulers: 'on', mailed: true }
	])(
		'(gg) the start, SCHEDULERS=$schedulers (R3): a member above the record lowered, one the record removed taken off, one with no row left; the owner’s readable webhook held, the setter’s switched off; one WARN; its count in the answer; a second run does nothing',
		async ({ schedulers, mailed }) => {
			const { board, dan, olgas, carols } = await startScene();
			makeSmtp();
			const sent = effects();
			try {
				expect(sweepEndedKeyReveals(schedulers, false)).toBe(2);
				await sent.settle();
				expect(membersOf(board)).toEqual([
					[olga.id, 'owner'],
					[bob.id, 'viewer'],
					[dan.id, 'editor']
				]);
				expect(hookOf(olgas.id)).toEqual({ active: 0, heldBecause: 'setter access ended' });
				expect(hookOf(carols.id)).toMatchObject({ active: 0 });
				expect(sent.emails.length > 0).toBe(mailed);
			} finally {
				sent.restore();
			}
			const said = accessWarnings();
			expect(said).toEqual(["2 board, team or person access(es) above this server's record of access changes were found (an older image’s import or a host edit) and lowered as the record says."]);
			expect(said.join('\n')).not.toMatch(/bob|carol|olga/);

			const record = sqlite.prepare('SELECT * FROM access_changes ORDER BY seq').all();
			expect(sweepEndedKeyReveals(schedulers, false)).toBe(0);
			expect(accessWarnings()).toHaveLength(1);
			expect(sqlite.prepare('SELECT * FROM access_changes ORDER BY seq').all()).toEqual(record);
		}
	);

	it('(gg2) R1: a row of this server dated after now naming owner over a recorded viewer: the live owner lowered to viewer, and the row counted in its own WARN', async () => {
		const board = await madeBoard(olga);
		await share(olga, board, { type: 'user', targetId: bob.id, role: 'viewer' });
		sqlite
			.prepare(
				"INSERT INTO access_changes (kind, subject_id, subject_created, holder_id, holder_created, access, changed_at, stated_changed) VALUES ('board_member', ?, ?, ?, ?, 'owner', '2099-01-01 00:00:00', '2099-01-01 00:00:00')"
			)
			.run(board, createdOf('boards', board), bob.id, createdOf('users', bob.id));
		sqlite.prepare("UPDATE board_members SET role = 'owner' WHERE board_id = ? AND user_id = ?").run(board, bob.id);

		expect(sweepEndedKeyReveals('off', false)).toBe(1);

		expect(membersOf(board)).toEqual([
			[olga.id, 'owner'],
			[bob.id, 'viewer']
		]);
		expect(accessWarnings()).toContain("1 row(s) of this server's record of access changes are dated after now and were not let raise any access.");
	});

	it('(gg3) R2: the start applies no team deletion, so a member added after it and one from before both stay; a Product Owner with no row is left alone', async () => {
		const res = await api('POST', '/api/teams', { user: olga, body: { name: 'Platform' } });
		const team = (res.body as { id: number }).id;
		await api('POST', `/api/teams/${team}/members/${bob.id}`, { user: olga, body: {} });
		// Deleted here, and back by an older image's import: the deletion row, then Carol added after it.
		sqlite.prepare("INSERT INTO access_changes (kind, subject_id, subject_created, access, changed_at, stated_changed) VALUES ('team', ?, ?, 'deleted', ?, ?)").run(team, createdOf('teams', team), stamp(), stamp());
		await api('POST', `/api/teams/${team}/members/${carol.id}`, { user: olga, body: {} });
		const board = await madeBoard(olga);
		sqlite.prepare('UPDATE boards SET product_owner_user_id = ? WHERE id = ?').run(olga.id, board);

		expect(sweepEndedKeyReveals('off', false)).toBe(0);

		expect(sqlite.prepare('SELECT user_id FROM team_members WHERE team_id = ? ORDER BY user_id').pluck().all(team)).toEqual([olga.id, bob.id, carol.id]);
		expect(sqlite.prepare('SELECT product_owner_user_id FROM boards WHERE id = ?').pluck().get(board)).toBe(olga.id);
		expect(accessWarnings()).toEqual([]);
	});

	it('(FP1) an untracked board whose record names the pair: a grant a host edit made is recorded when it is sent again, and the start pass then leaves it', async () => {
		const { board } = makeBoard({ owner: olga });
		await share(olga, board.id, { type: 'user', targetId: bob.id, role: 'viewer' });
		sqlite.prepare("UPDATE board_members SET role = 'editor' WHERE board_id = ? AND user_id = ?").run(board.id, bob.id);

		const rows = await recordedBy(async () => expect((await share(olga, board.id, { type: 'user', targetId: bob.id, role: 'editor' })).status).toBe(200));
		expect(rows).toEqual([{ kind: 'board_member', subject: board.id, holder: bob.id, access: 'editor' }]);

		sweepEndedKeyReveals('off', false);
		expect(membersOf(board.id)).toContainEqual([bob.id, 'editor']);
	});

	it('(hh) the start pass that cannot be written (R3, R5): its own WARN with the cause, nothing of it committed, the answer null, and the key pass still commits', async () => {
		const { board } = await startScene();
		const key = makeApiKeyRow(olga);
		const hash = sqlite.prepare('SELECT key_hash FROM api_keys WHERE id = ?').pluck().get(key.id) as string;
		sqlite.prepare("INSERT INTO api_key_revocations (key_id, key_hash, revoked_at, revoked_because) VALUES (?, ?, '2026-11-19 09:00:00', 'revoked')").run(key.id, hash);
		const members = membersOf(board);
		sqlite.exec(`CREATE TEMP TRIGGER card_3002_hh BEFORE DELETE ON board_members WHEN old.user_id = ${carol.id} BEGIN SELECT RAISE(ABORT, 'card 3002 hh refused'); END;`);
		try {
			expect(sweepEndedKeyReveals('off', false)).toBeNull();
		} finally {
			sqlite.exec('DROP TRIGGER IF EXISTS temp.card_3002_hh');
		}

		expect(membersOf(board)).toEqual(members);
		const said = accessWarnings();
		expect(said).toHaveLength(1);
		expect(said[0]).toMatch(/^The board, team and person access above this server's record of access changes could not be lowered: .*card 3002 hh refused/);
		// The key pass committed: the recorded key is gone.
		expect(sqlite.prepare('SELECT COUNT(*) FROM api_keys WHERE id = ?').pluck().get(key.id)).toBe(0);
	});
});
