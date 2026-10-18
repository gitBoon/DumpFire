/**
 * What a backup holds, what a restore brings in, and who may make either.
 *
 * Any administrator could once export the database, and the file held every
 * session id and every unused invite token as well as the password hashes: it
 * signed in whoever read it. Any administrator could also import one, and so
 * replace every account with accounts of their own. Both, with the reset, the
 * backup destinations and the mail settings, are the superadmin's now, which
 * tests/access-every-route.test.ts holds route by route. This file holds the
 * rest:
 *
 *   - A backup has no session in it and no unused invite, in the file an
 *     export downloads and in the copy a schedule uploads. It is looked for in
 *     the bytes of the file and not by counting rows: a row that is deleted is
 *     still on its page until the file is vacuumed, and a count of 0 was true
 *     of a file with every session id in it.
 *   - A restore brings in no session and no unused invite either, whatever
 *     the backup holds, so it signs everybody out.
 *   - A backup that has users and no superadmin among them is refused before
 *     anything is written: nobody could undo it.
 *   - The server says so in its log, when it starts, if that is already how
 *     things are.
 *
 * No destination is reached. `createDestination` is replaced, for this file,
 * by one that keeps what it is handed: see `uploaded`.
 *
 * The tests that call the import route point it at a temporary directory
 * first, because it writes its upload and a safety copy under the working
 * directory, and they empty the application's own database again afterwards.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBackupData, saveBackupConfig, withoutSignIns } from '$lib/server/backup';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { db, sqlite } from '$lib/server/db';
import { runMigrations } from '$lib/server/db/migrate';
import { NO_SUPERADMIN_IN_BACKUP, RestoreError, SIGNED_OUT, backupLacksSuperadmin, restoreFromBackup } from '$lib/server/db/restore';
import { inviteTokens } from '$lib/server/db/schema';
import { KNOWN_BROWSER_SECRET_KEY } from '$lib/server/known-browsers';
import { maskLiveLog, reportInstallation, reportNoSuperadmin } from '$lib/server/startup-checks';
import { api, routeMethods } from './helpers/api';
import { makeBoard, makeCard, makeSession, makeUser, resetDb } from './helpers/fixtures';
import { gate, gateApiRoutes } from './helpers/gate';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';
import { afterEachTimestampCheck } from './helpers/timestamps';

/** What the stand-in destination was handed: the bytes, under the name and for the destination they were for. */
const uploaded = vi.hoisted(() => [] as { destination: string; filename: string; bytes: Buffer }[]);

vi.mock('$lib/server/backup-destinations', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/backup-destinations')>();
	return {
		...real,
		// A destination that keeps what it is given and reaches nowhere.
		createDestination: (config: { type: string; name: string }) => ({
			type: config.type,
			name: config.name,
			test: async () => ({ success: true, message: 'ok' }),
			upload: async (data: Buffer, filename: string) => {
				uploaded.push({ destination: config.name, filename, bytes: Buffer.from(data) });
			},
			list: async () => [],
			delete: async () => {}
		})
	};
});

const REAL_MIGRATIONS = join(process.cwd(), 'drizzle');

const opened: Database.Database[] = [];
const tempDirs: string[] = [];

/** An invite nobody has used yet: whoever holds it sets its account's password. */
const UNUSED_INVITE = 'invite-not-yet-used-3f6c1d0a9b7e';
/** One that has been used, and sets nothing any more. */
const USED_INVITE = 'invite-already-used-8a2e5c4f1d6b';

/**
 * Failed sign-in lines as sign-in wrote them before card 2193, with the name
 * exactly as typed, and what each becomes. Only a name that was no account is
 * rewritten: a line ending ` (bad password)` was at an account, and is left.
 * One name holds a quote, ` from IP ` and a line break (the review's R7); one
 * is the 320 characters card 2177 cut a name to.
 */
const TYPED_PASSWORD = 'MyS3cret!Passw0rd-typed-as-a-name';
const TRICKY_NAME = 'tricky" from IP 1.2.3.4\nstill-the-name-6d2a';
const OLD_FAILED_LINES: { old: string; now: string }[] = [
	{
		old: `Failed login attempt for "${TYPED_PASSWORD}" from IP 203.0.113.9`,
		now: `Failed login attempt for a name that is no account (${TYPED_PASSWORD.length} characters) from IP 203.0.113.9`
	},
	{
		old: 'Failed login attempt for "alice@example.test" from IP 203.0.113.9 (bad password)',
		now: 'Failed login attempt for "alice@example.test" from IP 203.0.113.9 (bad password)'
	},
	{
		old: `Failed login attempt for "${TRICKY_NAME}" from IP 2001:db8::1`,
		now: `Failed login attempt for a name that is no account (${TRICKY_NAME.length} characters) from IP 2001:db8::1`
	},
	{
		old: `Failed login attempt for "${'q'.repeat(320)}" from IP 203.0.113.9`,
		now: 'Failed login attempt for a name that is no account (320 characters) from IP 203.0.113.9'
	},
	{ old: 'User "alice" logged in', now: 'User "alice" logged in' }
];

/** Write `OLD_FAILED_LINES` into the running database's log, as sign-in wrote them. */
function writeOldFailedLines(): void {
	const old = sqlite.prepare(
		"INSERT INTO system_logs (timestamp, level, context, message) VALUES ('2026-10-01 00:00:00', 'WARN', 'AUTH', ?)"
	);
	for (const line of OLD_FAILED_LINES) old.run(line.old);
}

// The first request through the gate starts the server, which takes seconds
// while every other file is starting too: done here, with time to do it in.
beforeAll(async () => {
	await gateApiRoutes();
	await gate('GET', '/login', { headers: { accept: 'text/html' } });
}, 120_000);

let chief: SessionUser;
let admin: SessionUser;
let member: SessionUser;
/** The id of a live session of each: what its cookie carries. */
let chiefSession: string;
let memberSession: string;

beforeEach(() => {
	resetDb();
	uploaded.length = 0;
	chief = makeUser({ username: 'chief', role: 'superadmin' });
	admin = makeUser({ username: 'administrator', role: 'admin' });
	member = makeUser({ username: 'member' });
	chiefSession = makeSession(chief);
	memberSession = makeSession(member);
	db.insert(inviteTokens)
		.values([
			{ token: UNUSED_INVITE, userId: member.id, expiresAt: '2099-01-01 00:00:00', used: false },
			{ token: USED_INVITE, userId: admin.id, expiresAt: '2099-01-01 00:00:00', used: true }
		])
		.run();
	makeCard(makeBoard({ owner: member, name: 'A board' }).cols['To Do'], { title: 'A card' });
});

afterEach(() => {
	vi.restoreAllMocks();
	// The check after every test (tests/setup.ts) runs after this hook, on an
	// emptied database, so it is made here first, once nothing is mocked (card 2095).
	try {
		afterEachTimestampCheck(sqlite);
	} finally {
		for (const database of opened.splice(0)) database.close();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		sqlite.pragma('foreign_keys = ON');
		resetDb();
	}
});

/** A separate in-memory database with every migration applied, and no rows. */
function migratedDb(): Database.Database {
	const database = new Database(':memory:');
	database.pragma('foreign_keys = ON');
	opened.push(database);
	runMigrations({ database, migrationsDir: REAL_MIGRATIONS });
	return database;
}

/** The bytes of a backup, opened as a database to ask what is in it. */
function opening(bytes: Buffer): Database.Database {
	const database = new Database(bytes);
	opened.push(database);
	return database;
}

const column = <T>(database: Database.Database, sql: string) =>
	(database.prepare(sql).all() as Record<string, T>[]).map((row) => Object.values(row)[0]);

/** What signs somebody in, as the running database holds it. */
const signInsHere = () => ({
	sessions: column<string>(sqlite, 'SELECT id FROM sessions ORDER BY id'),
	invites: column<string>(sqlite, 'SELECT token FROM invite_tokens ORDER BY token')
});

/**
 * A backup holds nothing that signs anybody in, and everything else. Asked of
 * the bytes: a deleted row's text is still in a file that was not vacuumed.
 */
function expectNoSignIns(bytes: Buffer): void {
	const has = (text: string) => bytes.includes(Buffer.from(text));

	expect(has(chiefSession), 'the id of a live session').toBe(false);
	expect(has(memberSession), 'the id of a live session').toBe(false);
	expect(has(UNUSED_INVITE), 'an invite that has not been used').toBe(false);

	// It is the whole database otherwise: an invite that was used, and every
	// user, with the hash a restore needs to sign them in again.
	expect(has(USED_INVITE)).toBe(true);
	for (const user of [chief, admin, member]) expect(has(user.email), user.username).toBe(true);
	expect(has('not-a-real-hash')).toBe(true);
	expect(has('A card')).toBe(true);

	const backup = opening(bytes);
	expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
	expect(column(backup, 'SELECT id FROM sessions')).toEqual([]);
	expect(column(backup, 'SELECT token FROM invite_tokens')).toEqual([USED_INVITE]);
	expect(column(backup, 'SELECT username FROM users ORDER BY id')).toEqual(['chief', 'administrator', 'member']);
	// One file, to be read as it is, with nothing of it left in a `-wal`
	// beside it: bytes 18 and 19 of a database file are 2 for one that keeps a
	// write-ahead log and 1 for one that does not.
	expect([bytes[18], bytes[19]]).toEqual([1, 1]);
}

// ─── What a backup holds ─────────────────────────────────────────────────────

describe('a backup', () => {
	it('has no session and no unused invite in the file an export downloads, and the running database still has them', async () => {
		const before = signInsHere();
		expect(before.sessions).toHaveLength(2);

		const res = await gate('GET', '/api/admin/export', { headers: { cookie: `${SESSION_COOKIE_NAME}=${chiefSession}` } });

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/x-sqlite3');
		expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="dumpfire-backup-\d{4}-\d\d-\d\d\.db"$/);
		expectNoSignIns(Buffer.from(await res.arrayBuffer()));

		// The copy was cleared, and never the database it was made from.
		expect(signInsHere()).toEqual(before);
	});

	it('has neither in the copy a backup run hands to a destination', async () => {
		saveBackupConfig({
			schedule: 'daily',
			scheduleTime: '02:00',
			scheduleDay: 0,
			retention: 7,
			destinations: [{ type: 'sftp', name: 'Offsite', host: 'sftp.example.test', port: 22, username: 'backup', remotePath: '/backups' }],
			notifyOnFailure: false,
			notifyEmail: ''
		});
		const before = signInsHere();

		// "Run Backup Now", which is the function the schedule calls.
		const res = await api('POST', '/api/admin/backup', { user: chief, body: {} });

		expect(res.status).toBe(200);
		expect(res.body.results).toEqual([expect.objectContaining({ destination: 'Offsite', status: 'success' })]);
		expect(uploaded).toHaveLength(1);
		expect(uploaded[0].destination).toBe('Offsite');
		expect(uploaded[0].filename).toMatch(/^dumpfire-backup-.*\.db$/);
		expectNoSignIns(uploaded[0].bytes);
		expect(signInsHere()).toEqual(before);
	});

	it('is made by the one function, for both', () => {
		const before = signInsHere();

		expectNoSignIns(generateBackupData());

		expect(signInsHere()).toEqual(before);
	});

	it('is not cleared by deleting the rows alone: the file has to be written again', () => {
		// What the rule is for. A copy with the rows deleted and no vacuum counts
		// no session and still holds every id.
		const dir = mkdtempSync(join(tmpdir(), 'dumpfire-backups-test-'));
		tempDirs.push(dir);
		const deletedOnly = join(dir, 'deleted-only.db');
		const copied = join(dir, 'copied.db');
		const cleared = join(dir, 'cleared.db');
		for (const path of [deletedOnly, copied]) sqlite.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);

		const copy = new Database(deletedOnly);
		copy.exec('DELETE FROM sessions; DELETE FROM invite_tokens WHERE used = 0');
		expect(copy.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
		const pages = copy.serialize();
		copy.close();
		expect(pages.includes(Buffer.from(memberSession))).toBe(true);

		withoutSignIns(copied, cleared);
		const written = readFileSync(cleared);
		expect(written.includes(Buffer.from(memberSession))).toBe(false);
		expect(written.includes(Buffer.from(UNUSED_INVITE))).toBe(false);
		expect(written.includes(Buffer.from(USED_INVITE))).toBe(true);
		// The copy it was given is not what is read: its pages are as they were.
		// And nothing else beside them: no journal is left behind.
		expect(readdirSync(dir).sort()).toEqual(['cleared.db', 'copied.db', 'deleted-only.db']);
		const reopened = opening(written);
		expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
	});

	it('holds no name typed at a failed sign-in, from lines written before sign-in stopped writing it', () => {
		writeOldFailedLines();
		const live = JSON.stringify(sqlite.prepare('SELECT message FROM system_logs').all());
		expect(live).toContain(TYPED_PASSWORD);

		const bytes = generateBackupData();

		expect(bytes.includes(Buffer.from(TYPED_PASSWORD))).toBe(false);
		expect(bytes.includes(Buffer.from('still-the-name-6d2a'))).toBe(false);
		expect(bytes.includes(Buffer.from('q'.repeat(320)))).toBe(false);
		expect(column<string>(opening(bytes), "SELECT message FROM system_logs WHERE context = 'AUTH' ORDER BY id")).toEqual(
			OLD_FAILED_LINES.map((line) => line.now)
		);
		// And the running database's log is as it was.
		expect(JSON.stringify(sqlite.prepare('SELECT message FROM system_logs').all())).toBe(live);
	});

	// Card 2194. Whoever held the key could make a cookie that skips sign-in's
	// throttling for any account whose hash they also hold, and a backup holds
	// every hash. It is never in one, and a restore makes the server a new one.
	it('holds no key that remembered browsers are signed with, in an export or in the copy a schedule uploads', async () => {
		const key = 'b'.repeat(24) + '-known-browser-key-in-the-live-database';
		sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(KNOWN_BROWSER_SECRET_KEY, key);
		sqlite.prepare("INSERT INTO settings (key, value) VALUES ('app_url', 'https://kept.example.test')").run();

		const res = await gate('GET', '/api/admin/export', { headers: { cookie: `${SESSION_COOKIE_NAME}=${chiefSession}` } });
		expect(res.status).toBe(200);
		for (const bytes of [Buffer.from(await res.arrayBuffer()), generateBackupData()]) {
			expect(bytes.includes(Buffer.from(key))).toBe(false);
			expect(bytes.includes(Buffer.from(KNOWN_BROWSER_SECRET_KEY))).toBe(false);
			// The other settings are there.
			expect(column(opening(bytes), 'SELECT key FROM settings ORDER BY key')).toEqual(['app_url']);
		}
		// And the running database still has it.
		expect(column(sqlite, `SELECT value FROM settings WHERE key = '${KNOWN_BROWSER_SECRET_KEY}'`)).toEqual([key]);
	});

	it('holds no invite token the system log wrote down, even from before the gate masked it', async () => {
		// The gate writes an invite's address with its token masked now. Opened
		// through the gate, then, and written into the log as an older version
		// wrote it: in the line, in what is kept with it, and in another line
		// that names the token on its own.
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'INFO';
		vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			expect((await gate('GET', `/invite/${UNUSED_INVITE}`, { headers: { accept: 'text/html' } })).status).toBe(200);
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
		const old = sqlite.prepare(
			"INSERT INTO system_logs (timestamp, level, context, message, meta) VALUES ('2026-10-01 00:00:00', ?, 'HTTP', ?, ?)"
		);
		old.run('INFO', `GET /invite/${UNUSED_INVITE} → 200 (3ms)`, JSON.stringify({ method: 'GET', path: `/invite/${UNUSED_INVITE}`, status: 200 }));
		old.run('WARN', `An invite was looked for that is ${UNUSED_INVITE}`, null);
		old.run('INFO', `GET /invite/${USED_INVITE} → 200 (3ms)`, null);
		const invitesLogged = () => JSON.stringify(sqlite.prepare("SELECT message, meta FROM system_logs WHERE message LIKE '%invite%'").all());
		const live = invitesLogged();
		expect(live).toContain(UNUSED_INVITE);

		const res = await gate('GET', '/api/admin/export', { headers: { cookie: `${SESSION_COOKIE_NAME}=${chiefSession}` } });
		const bytes = Buffer.from(await res.arrayBuffer());

		expect(res.status).toBe(200);
		expectNoSignIns(bytes);
		// Every line is still there, with the token masked.
		const lines = column<string>(opening(bytes), "SELECT message FROM system_logs WHERE message LIKE '%invite%' ORDER BY id");
		expect(lines.map((line) => line.replace(/ \(\d+ms\)$/, ''))).toEqual([
			'GET /invite/[token] → 200',
			'GET /invite/[token] → 200',
			'An invite was looked for that is [token]',
			'GET /invite/[token] → 200'
		]);
		// And the running database's log is as it was.
		expect(invitesLogged()).toBe(live);
	});
});

// ─── What a restore brings in ────────────────────────────────────────────────

/** A backup of another installation: its own superadmin, sessions and invites, and one board. */
function backupWithSignIns(): Database.Database {
	const backup = migratedDb();
	backup.exec(`
		INSERT INTO users (id, username, email, password_hash, role) VALUES
			(1, 'ann', 'ann@example.test', 'x', 'superadmin'),
			(2, 'bob', 'bob@example.test', 'x', 'user');
		INSERT INTO sessions (id, user_id, expires_at) VALUES
			('session-of-ann-in-the-backup', 1, '2099-01-01T00:00:00.000Z'),
			('session-of-bob-in-the-backup', 2, '2099-01-01T00:00:00.000Z');
		INSERT INTO invite_tokens (token, user_id, expires_at, used) VALUES
			('unused-invite-in-the-backup', 2, '2099-01-01T00:00:00.000Z', 0),
			('used-invite-in-the-backup', 2, '2099-01-01T00:00:00.000Z', 1);
		INSERT INTO boards (id, name, created_by) VALUES (1, 'From the backup', 1);
	`);
	return backup;
}

describe('a restore', () => {
	it('brings in no session and no unused invite, whatever the backup holds, and clears the ones that were here', () => {
		const live = migratedDb();
		live.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES (9, 'here', 'here@example.test', 'x', 'superadmin');
			INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-that-was-here', 9, '2099-01-01T00:00:00.000Z');
			INSERT INTO invite_tokens (token, user_id, expires_at, used) VALUES ('invite-that-was-here', 9, '2099-01-01T00:00:00.000Z', 0);
		`);
		const backup = backupWithSignIns();

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		expect(column(live, 'SELECT id FROM sessions')).toEqual([]);
		expect(column(live, 'SELECT token FROM invite_tokens')).toEqual(['used-invite-in-the-backup']);
		expect(result.restored.sessions).toBeUndefined();
		expect(result.restored.invite_tokens).toBe(1);
		// Everything else is the backup's.
		expect(column(live, 'SELECT username FROM users ORDER BY id')).toEqual(['ann', 'bob']);
		expect(column(live, 'SELECT name FROM boards')).toEqual(['From the backup']);
		// And the backup was only read.
		expect(column(backup, 'SELECT id FROM sessions')).toHaveLength(2);
	});

	// Card 2194: a backup made before the key was left out of backups still
	// holds it, and is restored without it, so that every browser is forgotten.
	it('brings in no key that remembered browsers are signed with, and clears the one that was here', () => {
		const live = migratedDb();
		live.exec(`INSERT INTO settings (key, value) VALUES ('${KNOWN_BROWSER_SECRET_KEY}', 'the-key-that-was-here')`);
		const backup = backupWithSignIns();
		backup.exec(`
			INSERT INTO settings (key, value) VALUES ('${KNOWN_BROWSER_SECRET_KEY}', 'the-key-in-the-backup');
			INSERT INTO settings (key, value) VALUES ('app_url', 'https://from-the-backup.example.test');
		`);

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		expect(column(live, 'SELECT key FROM settings ORDER BY key')).toEqual(['app_url']);
		expect(result.restored.settings).toBe(1);
	});

	/** Send `body` to the import route, which writes under a temporary working directory. */
	const importing = async <T extends { status: number; message: string }>(send: (dir: string) => Promise<T>) => {
		await routeMethods('/api/admin/import');
		const dir = mkdtempSync(join(tmpdir(), 'dumpfire-import-'));
		tempDirs.push(dir);
		vi.spyOn(process, 'cwd').mockReturnValue(dir);
		// The import logs what it did, and the logger prints it.
		vi.spyOn(console, 'error').mockImplementation(() => {});
		return { ...(await send(dir)), dir };
	};

	const importDb = (backup: Database.Database, by: SessionUser = chief) =>
		importing(async () => {
			const res = await api('POST', '/api/admin/import?outside=keep', {
				user: by,
				headers: { 'content-type': 'application/octet-stream' },
				body: backup.serialize()
			});
			return { status: res.status, message: res.body.message };
		});

	/** Send `body` as JSON, as the import of the old JSON export was sent. */
	const importJson = (query: string, body: Record<string, unknown>, by: SessionUser = chief) =>
		importing(async () => {
			const res = await api('POST', `/api/admin/import${query}`, { user: by, body });
			return { status: res.status, message: res.body.message };
		});

	it('signs everybody out through the route, whoever sent it included, and says so', async () => {
		const backup = backupWithSignIns();
		await routeMethods('/api/admin/import');
		const dir = mkdtempSync(join(tmpdir(), 'dumpfire-import-'));
		tempDirs.push(dir);
		vi.spyOn(process, 'cwd').mockReturnValue(dir);
		const cookie = `${SESSION_COOKIE_NAME}=${chiefSession}`;

		// Through the gate, as the page sends it, with the superadmin's session.
		const res = await gate('POST', '/api/admin/import?outside=keep', {
			headers: { cookie, 'content-type': 'application/octet-stream', accept: '*/*' },
			body: new Uint8Array(backup.serialize())
		});
		const answer = await res.json();

		expect(res.status).toBe(200);
		expect(answer.message).toContain(SIGNED_OUT);
		expect(signInsHere()).toEqual({ sessions: [], invites: ['used-invite-in-the-backup'] });
		// The cookie it was sent with names nothing now, and is taken away.
		expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=;`));
		// And the same cookie is no longer a way in.
		const next = await gate('GET', '/api/boards', { headers: { cookie, accept: '*/*' } });
		expect({ status: next.status, location: next.headers.get('location') }).toEqual({ status: 401, location: null });
	});

	// ── A backup that would leave nobody able to undo it ──────────────────

	/** The users of a backup, none of them the superadmin. */
	const NOBODY_IN_CHARGE = `
		INSERT INTO users (id, username, email, password_hash, role) VALUES
			(1, 'ann', 'ann@example.test', 'x', 'admin'),
			(2, 'bob', 'bob@example.test', 'x', 'user');
		INSERT INTO boards (id, name, created_by) VALUES (1, 'From the backup', 1);
	`;

	/** Nothing was written: not a row, not the safety copy, and the upload is gone again. */
	const expectNothingWritten = (before: ReturnType<typeof snapshotDb>, dir: string) => {
		expectUnchanged(before);
		expect(existsSync(join(dir, '.pre-restore-safety.json'))).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
	};

	it('refuses a .db backup that has users and no superadmin among them, before anything is written', async () => {
		const backup = migratedDb();
		backup.exec(NOBODY_IN_CHARGE);
		expect(backupLacksSuperadmin(backup)).toBe(true);
		const before = snapshotDb();

		const res = await importDb(backup);

		expect({ status: res.status, message: res.message }).toEqual({ status: 400, message: NO_SUPERADMIN_IN_BACKUP });
		expect(res.message).toContain('none of them is the superadmin');
		expectNothingWritten(before, res.dir);
		expect(signInsHere().sessions).toHaveLength(2);
	});

	// The import of the JSON export DumpFire wrote from 1 to 7 April 2026 was
	// removed (card 2157). It left twelve tables of the data it replaced in
	// place, so that a live API key could answer as an imported account. An
	// export in that format, with a superadmin in it, which it used to take:
	for (const query of ['?outside=keep', '?outside=off', '']) {
		it(`refuses an export in the old JSON format (${query || 'no outside'}) before reading it, and changes nothing`, async () => {
			const read = (['json', 'formData', 'arrayBuffer', 'text'] as const).map((reader) => vi.spyOn(Request.prototype, reader));
			const before = snapshotDb();

			const res = await importJson(query, {
				version: 1,
				users: [{ id: 1, username: 'ann', email: 'ann@example.test', password_hash: 'x', emoji: '👤', role: 'superadmin', created_at: '2026-01-01 00:00:00' }],
				boards: [{ id: 7, name: 'A', emoji: '📋', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' }],
				columns: [{ id: 1, board_id: 7, title: 'To Do', position: 0, color: '#6366f1' }],
				categories: [],
				cards: []
			});

			expect({ status: res.status, message: res.message }).toEqual({
				status: 400,
				message:
					'Import takes a .db backup, sent as application/octet-stream. Exports in the old JSON format, which ' +
					'DumpFire wrote only from 1 to 7 April 2026, are no longer imported. Nothing was changed.'
			});
			expect(read.map((reader) => reader.mock.calls.length), 'json, formData, arrayBuffer, text').toEqual([0, 0, 0, 0]);
			expectNothingWritten(before, res.dir);
			// Nobody was signed out.
			expect(signInsHere().sessions).toHaveLength(2);
		});
	}

	// The type is its media type, without its parameters: one that names a
	// .db backup's type in a parameter is still JSON.
	it('refuses a body sent as JSON with a parameter naming application/octet-stream, before reading it', async () => {
		const read = (['json', 'formData', 'arrayBuffer', 'text'] as const).map((reader) => vi.spyOn(Request.prototype, reader));
		const before = snapshotDb();

		const res = await importing(async () => {
			const sent = await api('POST', '/api/admin/import?outside=keep', {
				user: chief,
				headers: { 'content-type': 'application/json; x=application/octet-stream' },
				body: { version: 1, users: [], boards: [] }
			});
			return { status: sent.status, message: sent.body.message };
		});

		expect({ status: res.status, message: res.message }).toEqual({
			status: 400,
			message:
				'Import takes a .db backup, sent as application/octet-stream. Exports in the old JSON format, which ' +
				'DumpFire wrote only from 1 to 7 April 2026, are no longer imported. Nothing was changed.'
		});
		expect(read.map((reader) => reader.mock.calls.length), 'json, formData, arrayBuffer, text').toEqual([0, 0, 0, 0]);
		expectNothingWritten(before, res.dir);
		expect(signInsHere().sessions).toHaveLength(2);
	});

	it('takes a .db backup whose type is written in capitals and carries a parameter', async () => {
		const backup = backupWithSignIns();

		const res = await importing(async () => {
			const sent = await api('POST', '/api/admin/import?outside=keep', {
				user: chief,
				headers: { 'content-type': 'Application/Octet-Stream; charset=binary' },
				body: backup.serialize()
			});
			return { status: sent.status, message: sent.body.message };
		});

		expect(res.status).toBe(200);
		expect(res.message).toContain(SIGNED_OUT);
	});

	it('takes a backup with no users at all: set-up follows, and whoever completes it is the superadmin', async () => {
		const backup = migratedDb();
		backup.exec("INSERT INTO boards (id, name) VALUES (1, 'From the backup')");
		expect(backupLacksSuperadmin(backup)).toBe(false);

		const res = await importDb(backup);

		expect(res.status).toBe(200);
		expect(column(sqlite, 'SELECT username FROM users')).toEqual([]);
		expect(column(sqlite, 'SELECT name FROM boards')).toEqual(['From the backup']);
		expect(existsSync(join(res.dir, '.pre-restore-safety.json'))).toBe(true);
	});

	// The review's I3. The safety copy the import writes beside the database
	// held every setting, and so the key remembered browsers are signed with,
	// which no backup holds (card 2194).
	it('writes a safety copy that leaves out the key remembered browsers are signed with, and keeps every other setting', async () => {
		sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(KNOWN_BROWSER_SECRET_KEY, 'the-key-that-was-here');
		sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('app_url', 'https://here.example.test');

		const res = await importDb(migratedDb());

		expect(res.status).toBe(200);
		const safety = readFileSync(join(res.dir, '.pre-restore-safety.json'), 'utf8');
		expect(safety).not.toContain(KNOWN_BROWSER_SECRET_KEY);
		expect(safety).not.toContain('the-key-that-was-here');
		const settings = (JSON.parse(safety) as { settings: { key: string; value: string }[] }).settings;
		expect(settings).toContainEqual(expect.objectContaining({ key: 'app_url', value: 'https://here.example.test' }));
	});

	it('knows a backup with no superadmin by its users, and one whose users have no role at all', () => {
		const bare = (sql: string) => {
			const database = new Database(':memory:');
			opened.push(database);
			database.exec(sql);
			return database;
		};

		// No users table, and one with nobody in it: set-up follows either.
		expect(backupLacksSuperadmin(bare('CREATE TABLE boards (id INTEGER PRIMARY KEY)'))).toBe(false);
		expect(backupLacksSuperadmin(bare('CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT)'))).toBe(false);
		// Somebody, and nobody in charge.
		expect(backupLacksSuperadmin(bare("CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT); INSERT INTO users VALUES (1, 'admin'), (2, 'user')"))).toBe(true);
		expect(backupLacksSuperadmin(bare('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1)'))).toBe(true);
		// A role that is not exactly the one is not it.
		expect(backupLacksSuperadmin(bare("CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT); INSERT INTO users VALUES (1, 'SuperAdmin')"))).toBe(true);
		expect(backupLacksSuperadmin(bare("CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT); INSERT INTO users VALUES (1, 'user'), (2, 'superadmin')"))).toBe(false);
	});

	/**
	 * A backup that has a superadmin whose row cannot be copied: two users
	 * with one username, in a table that does not hold them to it. The second,
	 * the superadmin, is refused by the running database's own rule, and a
	 * restore that left it out and went on would commit users and no
	 * superadmin. The import's check before the restore asks the backup, which
	 * has one, and lets it through.
	 */
	function backupWhoseSuperadminCannotBeCopied(): Database.Database {
		const backup = new Database(':memory:');
		opened.push(backup);
		backup.exec(`
			CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, password_hash TEXT, role TEXT);
			INSERT INTO users VALUES
				(1, 'bob', 'bob@example.test', 'x', 'user'),
				(2, 'bob', 'ann@example.test', 'x', 'superadmin');
		`);
		expect(backupLacksSuperadmin(backup)).toBe(false);
		return backup;
	}

	it('is rolled back, and nothing is changed, when the rows it restored would have users and no superadmin', () => {
		const live = migratedDb();
		live.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES (9, 'here', 'here@example.test', 'x', 'superadmin');
			INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-that-was-here', 9, '2099-01-01T00:00:00.000Z');
		`);

		const thrown = (() => {
			try {
				restoreFromBackup(live, backupWhoseSuperadminCannotBeCopied());
				return null;
			} catch (caught) {
				return caught;
			}
		})();

		expect(thrown).toBeInstanceOf(RestoreError);
		expect((thrown as RestoreError).committed).toBe(false);
		expect((thrown as RestoreError).message).toMatch(
			/^The restore failed and nothing was changed: the restored data would have user accounts and none of them the superadmin, because a row of users could not be copied \(users row \(id 2\): UNIQUE constraint failed: users\.username\)$/
		);
		// As it was: the superadmin who was here, and their session.
		expect(column(live, 'SELECT username FROM users')).toEqual(['here']);
		expect(column(live, 'SELECT id FROM sessions')).toEqual(['session-that-was-here']);
		expect(live.pragma('foreign_keys', { simple: true })).toBe(1);
	});

	it('is refused through the route when the superadmin’s row cannot be copied, 422 and at WARN, and changes nothing', async () => {
		const before = snapshotDb();
		// The tests keep ERROR and above; a WARN is wanted here.
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		let res: Awaited<ReturnType<typeof importDb>>;
		try {
			res = await importDb(backupWhoseSuperadminCannotBeCopied());
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		// What the backup holds, and not a fault: it was a 500, logged CRITICAL.
		expect(res.status).toBe(422);
		expect(res.message).toContain('The restore failed and nothing was changed: the restored data would have user accounts and none of them the superadmin');
		expect(column<string>(sqlite, "SELECT level FROM system_logs WHERE context = 'IMPORT' ORDER BY id")).toEqual(['WARN']);
		expectUnchanged(before);
		expect(signInsHere().sessions).toHaveLength(2);
	});

	it('names, in its answer, the superadmin the restored data has', async () => {
		const res = await importing(async () => {
			const answer = await api('POST', '/api/admin/import?outside=keep', {
				user: chief,
				headers: { 'content-type': 'application/octet-stream' },
				body: backupWithSignIns().serialize()
			});
			return { status: answer.status, message: answer.body.message, superadmins: answer.body.superadmins };
		});

		expect(res.status).toBe(200);
		expect(res.message).toContain(`${SIGNED_OUT} The superadmin is now ann.`);
		expect(res.superadmins).toEqual(['ann']);

		// And with no users at all, that set-up is open.
		const empty = migratedDb();
		empty.exec("INSERT INTO boards (id, name) VALUES (1, 'From the backup')");
		const none = await importing(async () => {
			const answer = await api('POST', '/api/admin/import?outside=keep', {
				user: chief,
				headers: { 'content-type': 'application/octet-stream' },
				body: empty.serialize()
			});
			return { status: answer.status, message: answer.body.message, superadmins: answer.body.superadmins };
		});
		expect(none.superadmins).toEqual([]);
		expect(none.message).toContain('There are no user accounts now: set-up is open, and whoever completes it is the superadmin.');
	});

	it('says at once, in the system log, that the restored data holds a board beneath one of its own cards', async () => {
		// A backup taken before card 2141 can hold one. It was said only at the
		// next start, and until then the board was on no dashboard unexplained.
		const loopLines = () =>
			sqlite
				.prepare("SELECT level, context, message FROM system_logs WHERE message LIKE '%hang beneath one of their own cards%'")
				.all() as { level: string; context: string; message: string }[];
		const withLoop = migratedDb();
		withLoop.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES (1, 'ann', 'ann@example.test', 'x', 'superadmin');
			INSERT INTO boards (id, name, created_by) VALUES (1, 'Top', 1);
			INSERT INTO columns (id, board_id, title) VALUES (1, 1, 'To Do');
			INSERT INTO cards (id, column_id, title) VALUES (1, 1, 'Holds the loop');
			INSERT INTO boards (id, name, created_by, parent_card_id) VALUES (2, 'Loop', 1, 1);
			INSERT INTO columns (id, board_id, title) VALUES (2, 2, 'To Do');
			UPDATE cards SET column_id = 2 WHERE id = 1;
		`);
		// The tests keep ERROR and above; the line is a WARN.
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		let clean: Awaited<ReturnType<typeof importDb>>;
		let looped: Awaited<ReturnType<typeof importDb>>;
		let afterClean: ReturnType<typeof loopLines>;
		try {
			clean = await importDb(backupWithSignIns());
			afterClean = loopLines();
			looped = await importDb(withLoop);
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		expect(clean.status).toBe(200);
		expect(afterClean).toEqual([]);
		expect(looped.status).toBe(200);
		expect(loopLines()).toEqual([
			{
				level: 'WARN',
				context: 'IMPORT',
				message: expect.stringContaining(
					'1 board(s) hang beneath one of their own cards, so they are on no dashboard and the card each hangs ' +
						'from cannot be completed: board 2 "Loop", under card 1 "Holds the loop" on board 2.'
				)
			}
		]);
	});

	it('is refused to an administrator before the upload is read', async () => {
		const read = vi.spyOn(Request.prototype, 'arrayBuffer');
		const before = snapshotDb();

		const res = await importDb(backupWithSignIns(), admin);

		expect(res.status).toBe(403);
		expect(res.message).toContain('belongs to the superadmin');
		expect(read).not.toHaveBeenCalled();
		expectNothingWritten(before, res.dir);
	});
});

// ─── What the server says when it starts ─────────────────────────────────────

describe('the line in the system log when there are users and no superadmin', () => {
	const lines = () =>
		sqlite.prepare("SELECT level, context, message FROM system_logs WHERE context = 'STARTUP' ORDER BY id").all() as {
			level: string;
			context: string;
			message: string;
		}[];

	beforeEach(() => {
		// The logger prints a CRITICAL line as well as keeping it.
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('is one CRITICAL line, which says where the way back is written down', () => {
		sqlite.prepare("UPDATE users SET role = 'admin' WHERE role = 'superadmin'").run();

		expect(reportNoSuperadmin()).toBe(true);

		expect(lines()).toHaveLength(1);
		expect(lines()[0].level).toBe('CRITICAL');
		expect(lines()[0].message).toContain('There are 3 user account(s) and none of them is the superadmin');
		expect(lines()[0].message).toContain('docs/deployment.md');
		expect(lines()[0].message).toContain('If nobody can sign in as the superadmin');
	});

	it('is not said when there is a superadmin', () => {
		expect(reportNoSuperadmin()).toBe(false);
		expect(lines()).toEqual([]);
	});

	it('is not said when there are no users: set-up is open', () => {
		resetDb();

		expect(reportNoSuperadmin()).toBe(false);
		expect(lines()).toEqual([]);
	});

	it('is said by what the server calls as it starts, which changes nothing else', () => {
		sqlite.prepare("UPDATE users SET role = 'admin' WHERE role = 'superadmin'").run();
		const before = snapshotDb();

		reportInstallation();

		expect(lines().map((line) => line.level)).toEqual(['CRITICAL']);
		expectUnchanged(before);
	});

	it('cannot keep the server from starting, whatever goes wrong in looking', () => {
		const said = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(sqlite, 'prepare').mockImplementation(() => {
			throw new Error('the database is not to be had');
		});

		expect(() => reportInstallation()).not.toThrow();

		// Once for each check that reads the database: the superadmin's, and
		// the boards in a loop (card 2142). The ORIGIN check reads none here.
		expect(said.mock.calls.map(([line]) => String(line))).toEqual([
			'[STARTUP] A check of the installation could not be made: the database is not to be had',
			'[STARTUP] A check of the installation could not be made: the database is not to be had'
		]);
	});
});

// ─── The running database's own log, masked at start ─────────────────────────

describe('the running database’s system log, at start', () => {
	/** The token of a public request's link: whoever holds it reads and answers the thread. */
	const REQUEST_LINK_TOKEN = 'request-link-token-5e1f0c7a2b9d';

	/** Every line the log holds, as one text. */
	const everyLine = () => JSON.stringify(sqlite.prepare('SELECT id, level, context, message, meta FROM system_logs ORDER BY id').all());

	it('has the invite tokens an older gate wrote into it masked, and a request link’s token, and a second start changes nothing', () => {
		// Invites as the gate wrote them before 2026-10-14, where any
		// administrator reads them through GET /api/logs; a request's link with
		// its token, which no gate wrote but a line may hold; and one line that
		// is no secret.
		const old = sqlite.prepare(
			"INSERT INTO system_logs (timestamp, level, context, message, meta) VALUES ('2026-10-01 00:00:00', 'INFO', 'HTTP', ?, ?)"
		);
		const meta = (path: string) => JSON.stringify({ method: 'GET', path, status: 200 });
		old.run(`GET /invite/${UNUSED_INVITE} → 200 (3ms)`, meta(`/invite/${UNUSED_INVITE}`));
		old.run(`GET /request/7/reply?token=${REQUEST_LINK_TOKEN} → 200 (2ms)`, meta(`/request/7/reply?token=${REQUEST_LINK_TOKEN}&from=mail`));
		old.run(`An invite was looked for that is ${UNUSED_INVITE}`, null);
		old.run('GET /boards → 200 (1ms)', meta('/boards'));
		expect(everyLine()).toContain(UNUSED_INVITE);
		expect(everyLine()).toContain(REQUEST_LINK_TOKEN);

		expect(maskLiveLog()).toBeGreaterThan(0);

		expect(sqlite.prepare('SELECT message, meta FROM system_logs ORDER BY id').all()).toEqual([
			{ message: 'GET /invite/[token] → 200 (3ms)', meta: meta('/invite/[token]') },
			{ message: 'GET /request/7/reply?token=[token] → 200 (2ms)', meta: meta('/request/7/reply?token=[token]&from=mail') },
			{ message: 'An invite was looked for that is [token]', meta: null },
			{ message: 'GET /boards → 200 (1ms)', meta: meta('/boards') }
		]);
		// Only the log: the invite itself is as it was.
		expect(signInsHere().invites).toEqual([USED_INVITE, UNUSED_INVITE]);

		const masked = everyLine();
		expect(maskLiveLog()).toBe(0);
		expect(everyLine()).toBe(masked);
	});

	it('has the names typed at failed sign-ins taken out, the whole of each, and a second start changes nothing', () => {
		writeOldFailedLines();

		expect(maskLiveLog()).toBe(3);

		expect(column<string>(sqlite, "SELECT message FROM system_logs WHERE context = 'AUTH' ORDER BY id")).toEqual(
			OLD_FAILED_LINES.map((line) => line.now)
		);
		const masked = everyLine();
		expect(masked).not.toContain(TYPED_PASSWORD);
		expect(masked).not.toContain('still-the-name-6d2a');
		expect(maskLiveLog()).toBe(0);
		expect(everyLine()).toBe(masked);
	});

	it('is masked by what the server calls as it starts, after the migrations', () => {
		const hooks = readFileSync(join(process.cwd(), 'src', 'hooks.server.ts'), 'utf8');

		expect(hooks.indexOf('\nrunMigrations();')).toBeGreaterThan(-1);
		expect(hooks.indexOf('\nmaskLiveLog();')).toBeGreaterThan(hooks.indexOf('\nrunMigrations();'));
	});

	it('cannot keep the server from starting: a failure is said at WARN, and nothing is thrown', () => {
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		const said = vi.spyOn(console, 'warn').mockImplementation(() => {});
		// The logger cannot keep the line either, and says so on the console.
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(sqlite, 'prepare').mockImplementation(() => {
			throw new Error('the database is not to be had');
		});

		try {
			expect(maskLiveLog()).toBeNull();
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		expect(said.mock.calls.map(([line]) => String(line))).toEqual([
			expect.stringMatching(/\[WARN\] \[STARTUP\] The system log could not be masked .*: the database is not to be had\./)
		]);
	});
});
