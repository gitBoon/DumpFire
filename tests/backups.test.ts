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
 *     export downloads and in the copy a schedule uploads; nor a task
 *     request's link, nor the key the request form signs with (card 2158). It is looked for in
 *     the bytes of the file and not by counting rows: a row that is deleted is
 *     still on its page until the file is vacuumed, and a count of 0 was true
 *     of a file with every session id in it.
 *   - A restore brings in no session and no unused invite either, whatever
 *     the backup holds, so it signs everybody out. It gives every request a
 *     new link, and brings in no form key.
 *   - A backup holds no mail password, destination credential or webhook
 *     secret, and a webhook that had one is off in it (card 2169). A restore
 *     fills each gap from this server only where every field that is not
 *     secret is the same, says what it kept and what is to enter, and so do
 *     a backup run, which does not try a destination without its
 *     credentials, and the line at every start.
 *   - A backup that has users and no superadmin among them is refused before
 *     anything is written: nobody could undo it.
 *   - The server says so in its log, when it starts, if that is already how
 *     things are.
 *   - The backup settings show every secret masked, the Google Drive refresh
 *     token included, and a save or a test keeps a masked secret only for the
 *     one stored destination it was saved with, refusing anything else with
 *     what changed (cards 2187 and 2190).
 *   - Google Drive is asked for `drive.file` alone; Connect makes a folder of
 *     DumpFire's own or checks the one it is given, records the scope Google
 *     granted, and writes nothing over a save made while Google answers (card
 *     2188). Google is stood in for by spies on `OAuth2.prototype.getToken`
 *     and `google.drive`.
 *   - Connect is taken only from the session that started it: the consent
 *     address carries a random state, held in memory for ten minutes and
 *     bound to the session, the account and the destination, and a PKCE
 *     challenge whose verifier goes to Google with the code; a state is used
 *     once, whatever comes of it (card 2251).
 *
 * No destination is reached. `createDestination` is replaced, for this file,
 * by one that keeps what it is handed: see `uploaded` and `handed`.
 *
 * The tests that call the import route point it at a temporary directory
 * first, because it writes its upload and a safety copy under the working
 * directory, and they empty the application's own database again afterwards.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { google } from 'googleapis';
import { generateBackupData, saveBackupConfig, withoutSecrets } from '$lib/server/backup';
import { GDriveDestination, dumpfireFolderName, type DestinationConfig, type GDriveDestinationConfig } from '$lib/server/backup-destinations';
import {
	BACKUP_SEAL,
	BACKUP_SEAL_KEY,
	CREDENTIALS_NOT_ENTERED,
	GDRIVE_NOT_CONNECTED,
	NOT_SEALED_HERE,
	NO_SEAL_HERE,
	SECRET_FIELDS,
	SECRET_MASK,
	WEBHOOK_SECRETS_LEFT_OUT_KEY,
	backupSealKey,
	clearSecrets,
	failedCheckSentence,
	hostKeyChanges,
	sealCopy,
	sealKeyHere,
	sealOf,
	sealVerifies,
	secretsKeptSentence,
	secretsToEnterSentence,
	settingsChanges,
	strayInternalObjects,
	unsealedBecause
} from '$lib/server/backup-secrets';
import { DRIVE_FILE_SCOPE, driveScopeIsNarrow } from '$lib/drive-scope';
import { SESSION_COOKIE_NAME, type Credential, type SessionUser } from '$lib/server/auth';
import { db, sqlite } from '$lib/server/db';
import { runMigrations } from '$lib/server/db/migrate';
import { NO_SUPERADMIN_IN_BACKUP, RestoreError, SIGNED_OUT, backupLacksSuperadmin, restoreFromBackup, rowsToRestore } from '$lib/server/db/restore';
import { inviteTokens, taskRequests } from '$lib/server/db/schema';
import { KNOWN_BROWSER_SECRET_KEY } from '$lib/server/known-browsers';
import { REQUEST_FORM_SECRET_KEY, issueFormToken, resetFormSecretCache, verifyFormToken } from '$lib/server/request-tokens';
import { maskLiveLog, reportInstallation, reportNoSuperadmin } from '$lib/server/startup-checks';
import { api, routeMethods } from './helpers/api';
import { makeBoard, makeCard, makeSession, makeUser, resetDb } from './helpers/fixtures';
import { gate, gateApiRoutes } from './helpers/gate';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';
import { afterEachTimestampCheck } from './helpers/timestamps';

/** What the stand-in destination was handed: the bytes, under the name and for the destination they were for. */
const uploaded = vi.hoisted(() => [] as { destination: string; filename: string; bytes: Buffer }[]);

/** Each configuration the stand-in destination was made from, as `createDestination` was handed it (cards 2187 and 2190). */
const handed = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('$lib/server/backup-destinations', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/backup-destinations')>();
	return {
		...real,
		// A destination that keeps what it is given and reaches nowhere.
		createDestination: (config: { type: string; name: string }) => {
			handed.push({ ...config });
			return {
				type: config.type,
				name: config.name,
				test: async () => ({ success: true, message: 'ok' }),
				upload: async (data: Buffer, filename: string) => {
					uploaded.push({ destination: config.name, filename, bytes: Buffer.from(data) });
				},
				list: async () => [],
				delete: async () => {}
			};
		}
	};
});

const REAL_MIGRATIONS = join(process.cwd(), 'drizzle');

const opened: Database.Database[] = [];
const tempDirs: string[] = [];

/** An invite nobody has used yet: whoever holds it sets its account's password. */
const UNUSED_INVITE = 'invite-not-yet-used-3f6c1d0a9b7e';
/** One that has been used, and sets nothing any more. */
const USED_INVITE = 'invite-already-used-8a2e5c4f1d6b';
/** A request's link: whoever holds it reads the thread and replies as the requester (card 2158). */
const REQUEST_LINK = 'c0ffee'.repeat(10) + 'beef';
/** The key the public request form signs its tokens with. */
const FORM_KEY = 'form-key-of-the-running-database-5d1e7a';
/** An SFTP host key confirmed on this server, without which a backup run does not try an SFTP destination (card 2250). */
const HOST_KEY = 'ssh-ed25519 SHA256:s16t1ixxsjxOgoaXCXACvAIOEG1K5biSlM7GekmavrY';
/** Another, as a backup made elsewhere could hold. */
const OTHER_HOST_KEY = 'ssh-ed25519 SHA256:DNHUp/U/VMq906grWMCGTqWiExwwOEeWEdF4E+QSBns';

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
	handed.length = 0;
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
	db.insert(taskRequests)
		.values({
			targetType: 'user',
			targetId: member.id,
			title: 'A request',
			requesterName: 'Rita',
			requesterEmail: 'rita@example.test',
			status: 'pending',
			accessToken: REQUEST_LINK
		})
		.run();
	sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(REQUEST_FORM_SECRET_KEY, FORM_KEY);
	// The form's key as a process that has just started knows it: read from the settings.
	resetFormSecretCache();
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

/** What opens a request's thread, and what the form signs with, as the running database holds them. */
const requestKeysHere = () => ({
	links: column<string>(sqlite, 'SELECT access_token FROM task_requests ORDER BY id'),
	formKey: column<string>(sqlite, `SELECT value FROM settings WHERE key = '${REQUEST_FORM_SECRET_KEY}'`)
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
	// Card 2158: no request's link, and not the key the form signs with, nor its name.
	expect(has(REQUEST_LINK), 'a request’s link').toBe(false);
	expect(has(FORM_KEY), 'the key the request form signs with').toBe(false);
	expect(has(REQUEST_FORM_SECRET_KEY), 'the name of the form key’s setting').toBe(false);

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
	// The request is there, with no link to it.
	expect(backup.prepare('SELECT title, access_token FROM task_requests').all()).toEqual([{ title: 'A request', access_token: null }]);
	// One file, to be read as it is, with nothing of it left in a `-wal`
	// beside it: bytes 18 and 19 of a database file are 2 for one that keeps a
	// write-ahead log and 1 for one that does not.
	expect([bytes[18], bytes[19]]).toEqual([1, 1]);
}

// ─── What a backup holds ─────────────────────────────────────────────────────

describe('a backup', () => {
	it('has no session, no unused invite and no request link in the file an export downloads, and the running database still has them', async () => {
		const before = signInsHere();
		const keys = requestKeysHere();
		expect(before.sessions).toHaveLength(2);
		expect(keys).toEqual({ links: [REQUEST_LINK], formKey: [FORM_KEY] });

		const res = await gate('GET', '/api/admin/export', { headers: { cookie: `${SESSION_COOKIE_NAME}=${chiefSession}` } });

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/x-sqlite3');
		expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="dumpfire-backup-\d{4}-\d\d-\d\d\.db"$/);
		expectNoSignIns(Buffer.from(await res.arrayBuffer()));

		// The copy was cleared, and never the database it was made from.
		expect(signInsHere()).toEqual(before);
		expect(requestKeysHere()).toEqual(keys);
	});

	it('has neither in the copy a backup run hands to a destination', async () => {
		saveBackupConfig({
			schedule: 'daily',
			scheduleTime: '02:00',
			scheduleDay: 0,
			retention: 7,
			destinations: [{ type: 'sftp', name: 'Offsite', host: 'sftp.example.test', port: 22, username: 'backup', remotePath: '/backups', hostKey: HOST_KEY }],
			notifyOnFailure: false,
			notifyEmail: ''
		});
		const before = signInsHere();
		const keys = requestKeysHere();

		// "Run Backup Now", which is the function the schedule calls.
		const res = await api('POST', '/api/admin/backup', { user: chief, body: {} });

		expect(res.status).toBe(200);
		expect(res.body.results).toEqual([expect.objectContaining({ destination: 'Offsite', status: 'success' })]);
		expect(uploaded).toHaveLength(1);
		expect(uploaded[0].destination).toBe('Offsite');
		expect(uploaded[0].filename).toMatch(/^dumpfire-backup-.*\.db$/);
		expectNoSignIns(uploaded[0].bytes);
		expect(signInsHere()).toEqual(before);
		expect(requestKeysHere()).toEqual(keys);
	});

	it('is made by the one function, for both', () => {
		const before = signInsHere();
		const keys = requestKeysHere();

		expectNoSignIns(generateBackupData());

		expect(signInsHere()).toEqual(before);
		expect(requestKeysHere()).toEqual(keys);
	});

	it('is not cleared by deleting the rows alone: the file has to be written again', () => {
		// What the rule is for. A copy with the rows deleted and no vacuum counts
		// no session and still holds every id.
		const dir = mkdtempSync(join(tmpdir(), 'dumpfire-backups-test-'));
		tempDirs.push(dir);
		const deletedOnly = join(dir, 'deleted-only.db');
		const copied = join(dir, 'copied.db');
		const cleared = join(dir, 'cleared.db');
		// A second request: set to NULL, the first row of a page was written
		// over in place, and the ones after it were not.
		sqlite
			.prepare(
				"INSERT INTO task_requests (target_type, target_id, title, requester_name, status, access_token) VALUES ('user', ?, 'Another', 'Sam', 'pending', ?)"
			)
			.run(member.id, 'd'.repeat(64));
		for (const path of [deletedOnly, copied]) sqlite.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);

		const copy = new Database(deletedOnly);
		copy.exec('DELETE FROM sessions; DELETE FROM invite_tokens WHERE used = 0; UPDATE task_requests SET access_token = NULL');
		expect(copy.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
		expect(copy.prepare('SELECT COUNT(*) AS n FROM task_requests WHERE access_token IS NOT NULL').get()).toEqual({ n: 0 });
		const pages = copy.serialize();
		copy.close();
		expect(pages.includes(Buffer.from(memberSession))).toBe(true);
		// A request's link too (card 2158): set to NULL, and still on its page.
		expect(pages.includes(Buffer.from('d'.repeat(64)))).toBe(true);

		withoutSecrets(copied, cleared);
		const written = readFileSync(cleared);
		expect(written.includes(Buffer.from(memberSession))).toBe(false);
		expect(written.includes(Buffer.from(UNUSED_INVITE))).toBe(false);
		expect(written.includes(Buffer.from(REQUEST_LINK))).toBe(false);
		expect(written.includes(Buffer.from('d'.repeat(64)))).toBe(false);
		expect(written.includes(Buffer.from(FORM_KEY))).toBe(false);
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
			// The other settings are there, and the backup's seal (card 2169's S1), which is no secret.
			expect(column(opening(bytes), 'SELECT key FROM settings ORDER BY key')).toEqual(['app_url', BACKUP_SEAL]);
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

	// Card 2158. A backup made before it holds every request's link as it was
	// mailed, and the form's key; one made since holds neither. Either way
	// every request restored is given a new link, and no key comes in.
	describe('of task requests (card 2158)', () => {
		/** Two requests, as a backup holds them: with the links mailed, or, made since, with none. */
		const withRequests = (backup: Database.Database, links: [string | null, string | null]) => {
			const insert = backup.prepare(
				"INSERT INTO task_requests (target_type, target_id, title, requester_name, requester_email, status, access_token) VALUES ('user', 1, ?, 'Rita', 'rita@example.test', ?, ?)"
			);
			insert.run('Open one', 'pending', links[0]);
			insert.run('Settled one', 'rejected', links[1]);
			return backup;
		};
		const OLD_LINKS: [string, string] = ['1'.repeat(64), '2'.repeat(64)];
		const linksIn = (database: Database.Database) => column<string | null>(database, 'SELECT access_token FROM task_requests ORDER BY id');

		const expectNewLinks = (database: Database.Database, count: number) => {
			const links = linksIn(database);
			expect(links).toHaveLength(count);
			for (const link of links) expect(link).toMatch(/^[0-9a-f]{64}$/);
			expect(new Set(links).size).toBe(count);
			for (const old of OLD_LINKS) expect(links).not.toContain(old);
		};

		it.each([
			['made before card 2158, holding the links mailed and the form’s key', true],
			['made since, holding neither', false]
		])('gives every request a new link, from a backup %s', (_made, old) => {
			const live = migratedDb();
			live.exec(`INSERT INTO settings (key, value) VALUES ('${REQUEST_FORM_SECRET_KEY}', 'the-key-that-was-here')`);
			const backup = withRequests(backupWithSignIns(), old ? OLD_LINKS : [null, null]);
			if (old) backup.exec(`INSERT INTO settings (key, value) VALUES ('${REQUEST_FORM_SECRET_KEY}', 'the-key-in-the-backup')`);

			const result = restoreFromBackup(live, backup);

			expect(result.errors).toEqual([]);
			expect(result.restored.task_requests).toBe(2);
			expect(result.requestLinksReplaced).toBe(2);
			expectNewLinks(live, 2);
			// Given inside the restore, so the backfill after it had none to give.
			expect(result.backfilled.accessTokens).toBe(0);
			// No form key came in, and the one that was here went with the settings.
			expect(column(live, `SELECT value FROM settings WHERE key = '${REQUEST_FORM_SECRET_KEY}'`)).toEqual([]);
		});

		it('counts none for a backup with no requests', () => {
			const result = restoreFromBackup(migratedDb(), backupWithSignIns());

			expect(result.requestLinksReplaced).toBe(0);
		});

		it('leaves every link as it was when the restore rolls back', () => {
			const live = migratedDb();
			live.exec("INSERT INTO users (id, username, email, password_hash, role) VALUES (9, 'here', 'here@example.test', 'x', 'superadmin')");
			withRequests(live, OLD_LINKS);

			expect(() => restoreFromBackup(live, backupWhoseSuperadminCannotBeCopied())).toThrow(RestoreError);

			expect(linksIn(live)).toEqual(OLD_LINKS);
		});

		it('says so through the route, and a link from before the import opens nothing after it', async () => {
			const before = REQUEST_LINK;
			const id = (sqlite.prepare('SELECT id FROM task_requests').get() as { id: number }).id;
			expect((await api('GET', `/api/requests/${id}?token=${before}`)).status).toBe(200);
			// A backup of this database as an older build made it, with the link in it.
			const backup = opening(Buffer.from(sqlite.serialize()));

			const res = await importing(async () => {
				const answer = await api('POST', '/api/admin/import?outside=keep', {
					user: chief,
					headers: { 'content-type': 'application/octet-stream' },
					body: backup.serialize()
				});
				return { status: answer.status, message: answer.body.message, replaced: answer.body.requestLinksReplaced };
			});

			expect(res.status).toBe(200);
			expect(res.replaced).toBe(1);
			expect(res.message).toContain(
				'1 request link(s) replaced: a link mailed before this restore no longer works, and its requester can have a ' +
					'new one sent from the page it opens.'
			);
			const now = column<string>(sqlite, 'SELECT access_token FROM task_requests');
			expect(now).toHaveLength(1);
			expect(now[0]).toMatch(/^[0-9a-f]{64}$/);
			expect(now[0]).not.toBe(before);
			expect((await api('GET', `/api/requests/${id}?token=${before}`)).status).toBe(404);
			expect((await api('GET', `/api/requests/${id}?token=${now[0]}`)).status).toBe(200);
			expect(requestKeysHere().formKey).toEqual([]);
		});

		it('refuses after an import a form token signed before it, and takes one signed after', async () => {
			// The form's key is in this database, and in a backup of it as an
			// older build made it. Brought back by the restore, it went on
			// accepting the tokens it had signed.
			const signedBefore = issueFormToken();
			expect(verifyFormToken(signedBefore)).toBe(true);
			const backup = opening(Buffer.from(sqlite.serialize()));

			const res = await importing(async () => {
				const answer = await api('POST', '/api/admin/import?outside=keep', {
					user: chief,
					headers: { 'content-type': 'application/octet-stream' },
					body: backup.serialize()
				});
				return { status: answer.status, message: answer.body.message };
			});

			expect(res.status).toBe(200);
			expect(verifyFormToken(signedBefore)).toBe(false);
			const signedAfter = issueFormToken();
			expect(verifyFormToken(signedAfter)).toBe(true);
			// A new key, made at first use, and kept for a process that starts now.
			const made = requestKeysHere().formKey;
			expect(made).toHaveLength(1);
			expect(made[0]).not.toBe(FORM_KEY);
			resetFormSecretCache();
			expect(verifyFormToken(signedAfter)).toBe(true);
		});
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

		// Once for each check that reads the database: the superadmin's, the
		// boards in a loop (card 2142), the secrets still to enter (card 2169),
		// the boards over the webhook cap (card 2201), the webhooks refused
		// as written (the webhook review, O1), and the SFTP destinations with no
		// confirmed host key (card 2250). The ORIGIN check reads none here.
		expect(said.mock.calls.map(([line]) => String(line))).toEqual([
			'[STARTUP] A check of the installation could not be made: the database is not to be had',
			'[STARTUP] A check of the installation could not be made: the database is not to be had',
			'[STARTUP] A check of the installation could not be made: the database is not to be had',
			'[STARTUP] A check of the installation could not be made: the database is not to be had',
			'[STARTUP] A check of the installation could not be made: the database is not to be had',
			'[STARTUP] A check of the installation could not be made: the database is not to be had'
		]);
	});
});

describe('the line at start naming each SFTP destination with no confirmed host key (card 2250, decision 7)', () => {
	const sftpTo = (name: string, more: Record<string, unknown> = {}) => ({
		type: 'sftp',
		name,
		host: 'nas.example.test',
		port: 22,
		username: 'backup',
		password: 'nas-password',
		remotePath: '/backups',
		...more
	});
	const lines = () =>
		sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'STARTUP' AND message LIKE '%host key%' ORDER BY id").all() as {
			level: string;
			message: string;
		}[];
	const configure = (destinations: unknown[]) =>
		sqlite
			.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
			.run('backup_config', JSON.stringify({ schedule: 'daily', retention: 7, destinations }));
	const startWith = (destinations: unknown[] | null) => {
		if (destinations !== null) configure(destinations);
		sqlite.exec('DELETE FROM system_logs');
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			reportInstallation();
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
		return lines();
	};
	const saying = (count: number, named: string) =>
		`${count} SFTP backup destination(s) have no confirmed host key, and nothing is sent to them until one is confirmed: ` +
		`${named}. In Admin, Scheduled Backups, press Test on each and confirm the key it shows.`;

	it('is one WARN line naming each, a destination with neither password nor key among them, and changes nothing else', () => {
		configure([
			sftpTo('NAS'),
			sftpTo('Confirmed', { hostKey: HOST_KEY }),
			sftpTo('Open NAS', { password: '' }),
			{ type: 's3', name: 'Bucket', region: 'eu-west-2', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', prefix: '' }
		]);
		const before = snapshotDb();

		const said = startWith(null);

		expect(said).toEqual([{ level: 'WARN', message: saying(2, '"NAS", "Open NAS"') }]);
		expectUnchanged(before);
	});

	it('is not said when every SFTP destination has its key, or there is none', () => {
		expect(startWith([sftpTo('NAS', { hostKey: HOST_KEY })])).toEqual([]);
		expect(startWith([])).toEqual([]);
	});

	it('names the first 20 and counts the rest', () => {
		const said = startWith(Array.from({ length: 23 }, (_, i) => sftpTo(`NAS ${i + 1}`)));

		const named = Array.from({ length: 20 }, (_, i) => `"NAS ${i + 1}"`).join(', ');
		expect(said).toEqual([{ level: 'WARN', message: saying(23, `${named}; and 3 more`) }]);
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

// ─── The secrets a backup does not hold (card 2169) ──────────────────────────

/**
 * Every secret the fixture below puts in a database, each a value found
 * nowhere else: the mail password, every secret field of one destination of
 * each type, and two webhooks' signing secrets.
 */
const SECRETS = {
	mailPassword: 'mail-password-2169-a1f9',
	sftpPassword: 'sftp-password-2169-b2e8',
	sftpKey: 'sftp-private-key-2169-c3d7',
	s3Secret: 's3-secret-access-key-2169-d4c6',
	gdriveClientSecret: 'gdrive-client-secret-2169-e5b5',
	gdriveRefreshToken: 'gdrive-refresh-token-2169-f6a4',
	serviceAccountKey: 'service-account-private-key-2169-a793',
	onedriveSecret: 'onedrive-client-secret-2169-b882',
	webhookOn: 'webhook-secret-on-2169-c971',
	webhookOff: 'webhook-secret-off-2169-d060'
};

/**
 * The mail settings but the password. "Use SSL/TLS" (`smtp_secure`) is a row
 * left from before card 2189, no longer read.
 */
const MAIL: Record<string, string> = {
	smtp_host: 'mail.example.test',
	smtp_port: '465',
	smtp_secure: 'true',
	smtp_allow_insecure: 'false',
	smtp_user: 'dumpfire',
	smtp_from_address: 'dumpfire@example.test'
};

const serviceAccountJson = (key: string, keyId = 'key-id-1') =>
	JSON.stringify({ type: 'service_account', client_email: 'robot@project.iam.example.test', private_key_id: keyId, private_key: key });

/** One destination of each type, every secret field set. */
const DESTINATIONS: Record<string, unknown>[] = [
	{ type: 'sftp', name: 'NAS', host: 'nas.example.test', port: 22, username: 'backup', password: SECRETS.sftpPassword, privateKey: SECRETS.sftpKey, remotePath: '/backups' },
	{ type: 's3', name: 'Bucket', region: 'eu-west-2', bucket: 'dumpfire-backups', accessKeyId: 'AKIA2169NOTSECRET', secretAccessKey: SECRETS.s3Secret, prefix: 'dumpfire/' },
	{ type: 'gdrive', name: 'Drive', authMethod: 'oauth', clientId: 'client-id.apps.example.test', clientSecret: SECRETS.gdriveClientSecret, refreshToken: SECRETS.gdriveRefreshToken, folderId: 'folder-1' },
	{ type: 'gdrive', name: 'Robot', authMethod: 'service_account', serviceAccountJson: serviceAccountJson(SECRETS.serviceAccountKey), folderId: 'folder-2' },
	{ type: 'onedrive', name: 'OneDrive', tenantId: 'tenant-1', clientId: 'onedrive-client', clientSecret: SECRETS.onedriveSecret, folderPath: '/DumpFire Backups' }
];
const [NAS, BUCKET, DRIVE, ROBOT, ONEDRIVE] = DESTINATIONS;

/** The same, as a backup holds them: every secret field '', the rest as it was. */
const DESTINATIONS_CLEARED = [
	{ ...NAS, password: '', privateKey: '' },
	{ ...BUCKET, secretAccessKey: '' },
	{ ...DRIVE, clientSecret: '', refreshToken: '' },
	{ ...ROBOT, serviceAccountJson: serviceAccountJson('') },
	{ ...ONEDRIVE, clientSecret: '' }
];

/** What each destination is listed as needing. */
const NEEDS = [
	// A restore never takes a host key from a backup, so the Test confirms it again (card 2250, decision 9).
	{ name: 'NAS', type: 'sftp', needs: 'SFTP: its password or private key, then Test to confirm its host key' },
	{ name: 'Bucket', type: 's3', needs: 'S3: its secret access key' },
	{ name: 'Drive', type: 'gdrive', needs: 'Google Drive: its client secret, then Connect' },
	{ name: 'Robot', type: 'gdrive', needs: 'Google Drive: its service account JSON' },
	{ name: 'OneDrive', type: 'onedrive', needs: 'OneDrive: its client secret' }
];

const NOTHING_KEPT = { mailPassword: false, destinations: [], webhooks: [] };
const NOTHING_TO_ENTER = { mailPassword: false, destinations: [], webhooks: [] };

/** A backup configuration with `destinations`, as the settings hold it. */
const configWith = (destinations: unknown[]) =>
	JSON.stringify({ schedule: 'disabled', scheduleTime: '02:00', scheduleDay: 0, retention: 7, destinations, notifyOnFailure: false, notifyEmail: '' });

/**
 * Into `database`: the mail settings with their password, the destinations
 * above, and on a board "Hooks" three webhooks: signed and on, signed and off,
 * and on with no secret. The board belongs to its first superadmin.
 */
function armSecrets(database: Database.Database): { on: number; off: number; unsigned: number; boardId: number } {
	const owner = (database.prepare("SELECT id FROM users WHERE role = 'superadmin' ORDER BY id").get() as { id: number }).id;
	const boardId = Number(database.prepare("INSERT INTO boards (name, created_by) VALUES ('Hooks', ?)").run(owner).lastInsertRowid);
	const set = database.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
	for (const [key, value] of Object.entries(MAIL)) set.run(key, value);
	set.run('smtp_pass', SECRETS.mailPassword);
	set.run('backup_config', configWith(DESTINATIONS));
	const hook = database.prepare("INSERT INTO webhooks (board_id, url, secret, events, active) VALUES (?, ?, ?, '[]', ?)");
	return {
		on: Number(hook.run(boardId, 'https://hooks.example.test/on', SECRETS.webhookOn, 1).lastInsertRowid),
		off: Number(hook.run(boardId, 'https://hooks.example.test/off', SECRETS.webhookOff, 0).lastInsertRowid),
		unsigned: Number(hook.run(boardId, 'https://hooks.example.test/unsigned', '', 1).lastInsertRowid),
		boardId
	};
}

const settingsOf = (database: Database.Database): Record<string, string> =>
	Object.fromEntries((database.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map((row) => [row.key, row.value]));

const hooksIn = (database: Database.Database) => database.prepare('SELECT id, secret, active FROM webhooks ORDER BY id').all();

/** Everything a secret is in, or decides where one goes. */
const secretsOf = (database: Database.Database) => {
	const settings = settingsOf(database);
	return {
		mail: Object.entries(settings).filter(([key]) => key.startsWith('smtp_')).sort(),
		config: settings['backup_config'] ?? null,
		marker: settings[WEBHOOK_SECRETS_LEFT_OUT_KEY] ?? null,
		hooks: database.prepare('SELECT id, board_id, url, secret, active FROM webhooks ORDER BY id').all()
	};
};

/** What a test that says "this server's secret" means: a value only the server restored into has. */
const HERE = 'held-here-only-2169';

describe('the secrets a backup does not hold (card 2169)', () => {
	let hooks: ReturnType<typeof armSecrets>;

	beforeEach(() => {
		hooks = armSecrets(sqlite);
	});

	/** The webhooks' signing secrets as the backup lists them. */
	const listed = () => [
		{ id: hooks.on, active: true },
		{ id: hooks.off, active: false }
	];

	/** The two signed webhooks, as a restore that could not fill them lists them. */
	const hooksToEnter = () => [
		{ id: hooks.on, boardId: hooks.boardId, board: 'Hooks' },
		{ id: hooks.off, boardId: hooks.boardId, board: 'Hooks' }
	];

	/** Decision 5's second sentence for a backup of this database restored where none of it is. */
	const everythingToEnter = () =>
		'To enter again, because a backup does not hold them: the mail password (Admin, 📧 Email / SMTP); backup ' +
		'destination(s) "NAS" (SFTP: its password or private key, then Test to confirm its host key), "Bucket" (S3: its secret access key), "Drive" ' +
		'(Google Drive: its client secret, then Connect), "Robot" (Google Drive: its service account JSON), "OneDrive" ' +
		'(OneDrive: its client secret) (Admin, Scheduled Backups); the signing secret(s) of webhook(s) ' +
		`${hooks.on} (board "Hooks"), ${hooks.off} (board "Hooks"), which stay switched off until the board's owner or ` +
		'an administrator sets each one and switches it on with PUT /api/v1/webhooks/{id}.';

	/** A backup of this database, made now. */
	const backupNow = () => opening(generateBackupData());

	/**
	 * `backup`, changed by `change` and sealed again with this server's key: a
	 * backup this server made of a database that held it so (card 2169's S1).
	 * Without the second seal, any change at all fills nothing.
	 */
	const resealed = (backup: Database.Database, change: (backup: Database.Database) => void = () => {}) => {
		change(backup);
		sealCopy(backup, backupSealKey(sqlite));
		return backup;
	};

	/**
	 * This server in another state: a database of its own, holding this
	 * server's key to seal backups with (unless `key` gives another, or `null`
	 * none), a superadmin, the board the webhooks are on under the same id, and
	 * what it is given.
	 */
	const serverWith = (given: {
		mail?: Record<string, string>;
		destinations?: unknown[];
		webhooks?: { id: number; url: string; secret: string; active?: number; setBy?: number }[];
		key?: string | null;
	}) => {
		const live = migratedDb();
		live.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES (90, 'other', 'other@example.test', 'x', 'superadmin')").run();
		live.prepare("INSERT INTO boards (id, name, created_by) VALUES (?, 'Hooks here', 90)").run(hooks.boardId);
		const set = live.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
		const key = given.key === undefined ? backupSealKey(sqlite).toString('hex') : given.key;
		if (key !== null) set.run(BACKUP_SEAL_KEY, key);
		for (const [key, value] of Object.entries(given.mail ?? {})) set.run(key, value);
		if (given.destinations) set.run('backup_config', configWith(given.destinations));
		const hook = live.prepare("INSERT INTO webhooks (id, board_id, url, secret, events, active, set_by) VALUES (?, ?, ?, ?, '[]', ?, ?)");
		const setter = live.prepare("INSERT OR IGNORE INTO users (id, username, email, password_hash) VALUES (?, 'setter' || ?, 'setter' || ? || '@example.test', 'x')");
		for (const w of given.webhooks ?? []) {
			if (w.setBy !== undefined) setter.run(w.setBy, w.setBy, w.setBy);
			hook.run(w.id, hooks.boardId, w.url, w.secret, w.active ?? 1, w.setBy ?? null);
		}
		return live;
	};

	/** This server as it is, but with its own value for every secret: this server's key unless `key` says otherwise. */
	const sameButOwnSecrets = (key?: string | null) =>
		serverWith({
			key,
			mail: { ...MAIL, smtp_pass: `${HERE}-mail` },
			destinations: [
				{ ...NAS, password: `${HERE}-sftp`, privateKey: '' },
				{ ...BUCKET, secretAccessKey: `${HERE}-s3` },
				{ ...DRIVE, clientSecret: `${HERE}-gdrive-secret`, refreshToken: `${HERE}-gdrive-token` },
				{ ...ROBOT, serviceAccountJson: serviceAccountJson(`${HERE}-robot`) },
				{ ...ONEDRIVE, clientSecret: `${HERE}-onedrive` }
			],
			webhooks: [
				{ id: hooks.on, url: 'https://hooks.example.test/on', secret: `${HERE}-hook-on`, active: 0 },
				{ id: hooks.off, url: 'https://hooks.example.test/off', secret: `${HERE}-hook-off`, active: 1 }
			]
		});

	/** Whether any row of `database`'s settings or webhooks holds a value of the server's own. */
	const holdsOwn = (database: Database.Database) =>
		JSON.stringify([database.prepare('SELECT * FROM settings').all(), database.prepare('SELECT * FROM webhooks').all()]).includes(HERE);

	/** Send `backup` to the import route as the superadmin, under a temporary working directory. */
	const importing = async (backup: Database.Database, query = '?outside=keep') => {
		await routeMethods('/api/admin/import');
		const dir = mkdtempSync(join(tmpdir(), 'dumpfire-import-'));
		tempDirs.push(dir);
		vi.spyOn(process, 'cwd').mockReturnValue(dir);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		return api('POST', `/api/admin/import${query}`, {
			user: chief,
			headers: { 'content-type': 'application/octet-stream' },
			body: backup.serialize()
		});
	};

	/** Run `act` keeping WARN lines in the system log, which the tests otherwise drop. */
	const atWarn = async <T>(act: () => T | Promise<T>): Promise<T> => {
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			return await act();
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
	};

	/** The lines in the system log, under `context`, that list secrets to enter. */
	const toEnterLines = (context: string) =>
		sqlite
			.prepare("SELECT level, message FROM system_logs WHERE context = ? AND message LIKE 'To enter again%' ORDER BY id")
			.all(context) as { level: string; message: string }[];

	// ── What the copy holds ─────────────────────────────────────────────────

	/** A backup holds none of the secrets, and everything else: its destinations as `cleared`. */
	function expectNoSecrets(bytes: Buffer, cleared: unknown[] = DESTINATIONS_CLEARED): void {
		for (const [name, value] of Object.entries(SECRETS)) expect(bytes.includes(Buffer.from(value)), name).toBe(false);
		const backup = opening(bytes);
		expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
		const settings = settingsOf(backup);
		expect(settings['smtp_pass']).toBeUndefined();
		for (const [key, value] of Object.entries(MAIL)) expect(settings[key], key).toBe(value);
		// Every destination, with its other fields as they were.
		expect(JSON.parse(settings['backup_config']).destinations).toEqual(cleared);
		// The two signed webhooks off with no secret, and listed; the unsigned one as it was.
		expect(hooksIn(backup)).toEqual([
			{ id: hooks.on, secret: '', active: 0 },
			{ id: hooks.off, secret: '', active: 0 },
			{ id: hooks.unsigned, secret: '', active: 1 }
		]);
		expect(JSON.parse(settings[WEBHOOK_SECRETS_LEFT_OUT_KEY])).toEqual(listed());
	}

	/** The running database still holds every secret, and its webhooks as they were. */
	function expectSecretsHere(): void {
		const here = JSON.stringify([sqlite.prepare('SELECT * FROM settings').all(), sqlite.prepare('SELECT * FROM webhooks').all()]);
		for (const [name, value] of Object.entries(SECRETS)) expect(here.includes(value), name).toBe(true);
		expect(hooksIn(sqlite)).toEqual([
			{ id: hooks.on, secret: SECRETS.webhookOn, active: 1 },
			{ id: hooks.off, secret: SECRETS.webhookOff, active: 0 },
			{ id: hooks.unsigned, secret: '', active: 1 }
		]);
		expect(settingsOf(sqlite)[WEBHOOK_SECRETS_LEFT_OUT_KEY]).toBeUndefined();
	}

	it('are in none of the file an export downloads, the copy Run Now hands a destination, or generateBackupData()', async () => {
		const res = await gate('GET', '/api/admin/export', { headers: { cookie: `${SESSION_COOKIE_NAME}=${chiefSession}` } });
		expect(res.status).toBe(200);
		expectNoSecrets(Buffer.from(await res.arrayBuffer()));
		expectSecretsHere();

		// The SFTP destination's host key confirmed, without which a run does not
		// try it (card 2250). The key is no secret, and the copy keeps it.
		sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(configWith([{ ...NAS, hostKey: HOST_KEY }, BUCKET, DRIVE, ROBOT, ONEDRIVE]));
		const run = await api('POST', '/api/admin/backup', { user: chief, body: {} });
		expect(run.status).toBe(200);
		expect(uploaded.map((u) => u.destination)).toEqual(['NAS', 'Bucket', 'Drive', 'Robot', 'OneDrive']);
		const clearedWithKey = [{ ...DESTINATIONS_CLEARED[0], hostKey: HOST_KEY }, ...DESTINATIONS_CLEARED.slice(1)];
		expectNoSecrets(uploaded[0].bytes, clearedWithKey);
		expectSecretsHere();

		expectNoSecrets(generateBackupData(), clearedWithKey);
		expectSecretsHere();
	});

	it('are taken out of the copy withoutSecrets is given, before it is written out again', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dumpfire-backups-test-'));
		tempDirs.push(dir);
		const copied = join(dir, 'copied.db');
		const cleared = join(dir, 'cleared.db');
		sqlite.exec(`VACUUM INTO '${copied.replace(/'/g, "''")}'`);

		withoutSecrets(copied, cleared);

		// Written out again from the rows the copy still had, as for sessions
		// above, so that nothing of a row it changed is left on a page.
		const written = readFileSync(cleared);
		for (const [name, value] of Object.entries(SECRETS)) expect(written.includes(Buffer.from(value)), name).toBe(false);
	});

	it('refuses to clear the running database, before it changes anything (N1)', () => {
		const before = snapshotDb();

		expect(() => clearSecrets(sqlite)).toThrow('never from the running database');

		expectUnchanged(before);
	});

	describe('clearSecrets, on what a copy can hold', () => {
		/** A copy: a separate database holding `sql`, and nothing it was not given. */
		const copyOf = (sql: string) => {
			const database = new Database(':memory:');
			opened.push(database);
			database.exec(sql);
			return database;
		};
		const SETTINGS = 'CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);';
		const WEBHOOKS =
			"CREATE TABLE webhooks (id INTEGER PRIMARY KEY, board_id INTEGER, url TEXT, secret TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1);";

		it.each([['not json {'], ['[1, 2]'], ['{"destinations": "all of them"}']])(
			'leaves out a backup configuration it cannot read for what is secret: %j',
			(value) => {
				const copy = copyOf(SETTINGS);
				copy.prepare("INSERT INTO settings VALUES ('backup_config', ?), ('theme', 'dark')").run(value);

				clearSecrets(copy);

				expect(settingsOf(copy)).toEqual({ theme: 'dark' });
			}
		);

		it('leaves out a destination of a type it does not know, and an entry that is not one, and keeps a configuration with no destinations as it is', () => {
			const copy = copyOf(SETTINGS);
			copy
				.prepare("INSERT INTO settings VALUES ('backup_config', ?)")
				.run(configWith([{ type: 'ftp', name: 'Old', password: 'ftp-password-2169' }, 'NAS', null, NAS]));

			clearSecrets(copy);

			expect(JSON.parse(settingsOf(copy)['backup_config']).destinations).toEqual([DESTINATIONS_CLEARED[0]]);
			expect(JSON.stringify(settingsOf(copy))).not.toContain('ftp-password-2169');

			const bare = copyOf(`${SETTINGS} INSERT INTO settings VALUES ('backup_config', '{"schedule":"daily"}');`);
			clearSecrets(bare);
			expect(settingsOf(bare)['backup_config']).toBe('{"schedule":"daily"}');
		});

		it('sets to empty a service account JSON it cannot read, and takes the key alone out of one it can', () => {
			const copy = copyOf(SETTINGS);
			copy
				.prepare("INSERT INTO settings VALUES ('backup_config', ?)")
				.run(configWith([{ ...ROBOT, serviceAccountJson: `{"private_key": "${SECRETS.serviceAccountKey}"` }, ROBOT]));

			clearSecrets(copy);

			const destinations = JSON.parse(settingsOf(copy)['backup_config']).destinations;
			expect(destinations.map((d: { serviceAccountJson: string }) => d.serviceAccountJson)).toEqual(['', serviceAccountJson('')]);
			expect(JSON.parse(destinations[1].serviceAccountJson)).toEqual({
				type: 'service_account',
				client_email: 'robot@project.iam.example.test',
				private_key_id: 'key-id-1',
				private_key: ''
			});
		});

		it('clears every type’s secret fields, and a service account’s key, from a destination of any type (S4)', () => {
			const copy = copyOf(SETTINGS);
			const strays = {
				password: 'stray-password-2169',
				privateKey: 'stray-private-key-2169',
				secretAccessKey: 'stray-s3-secret-2169',
				clientSecret: 'stray-client-secret-2169',
				refreshToken: 'stray-refresh-token-2169',
				serviceAccountJson: serviceAccountJson('stray-service-account-key-2169')
			};
			copy
				.prepare("INSERT INTO settings VALUES ('backup_config', ?)")
				.run(configWith(DESTINATIONS.map((destination) => ({ ...strays, ...destination }))));

			clearSecrets(copy);

			const held = settingsOf(copy)['backup_config'];
			for (const [field, value] of Object.entries(strays)) {
				expect(held.includes(field === 'serviceAccountJson' ? 'stray-service-account-key-2169' : value), field).toBe(false);
			}
			for (const destination of JSON.parse(held).destinations) {
				for (const field of ['password', 'privateKey', 'secretAccessKey', 'clientSecret', 'refreshToken']) expect(destination[field], field).toBe('');
				expect(JSON.parse(destination.serviceAccountJson).private_key).toBe('');
			}
		});

		it('clears a copy that has no settings table, or no webhooks table, all the same', () => {
			const noSettings = copyOf(`${WEBHOOKS} INSERT INTO webhooks VALUES (1, 1, 'https://a.example.test', '${SECRETS.webhookOn}', 1);`);
			clearSecrets(noSettings);
			expect(hooksIn(noSettings)).toEqual([{ id: 1, secret: '', active: 0 }]);

			const noWebhooks = copyOf(SETTINGS);
			noWebhooks
				.prepare('INSERT INTO settings VALUES (?, ?), (?, ?)')
				.run('smtp_pass', SECRETS.mailPassword, WEBHOOK_SECRETS_LEFT_OUT_KEY, '[{"id":1,"active":true}]');
			clearSecrets(noWebhooks);
			expect(settingsOf(noWebhooks)).toEqual({});

			// And through withoutSecrets, a file with neither is written out.
			const dir = mkdtempSync(join(tmpdir(), 'dumpfire-backups-test-'));
			tempDirs.push(dir);
			writeFileSync(join(dir, 'from.db'), copyOf('CREATE TABLE boards (id INTEGER PRIMARY KEY);').serialize());
			withoutSecrets(join(dir, 'from.db'), join(dir, 'to.db'));
			expect(existsSync(join(dir, 'to.db'))).toBe(true);
		});

		it('replaces a list the copy holds, keeping each entry whose webhook is still there with no secret, with the on or off it recorded (R2)', () => {
			const copy = copyOf(`${SETTINGS} ${WEBHOOKS}
				INSERT INTO webhooks VALUES
					(1, 1, 'https://a.example.test', '', 0),
					(2, 1, 'https://b.example.test', 'given-since', 0),
					(4, 1, 'https://d.example.test', '${SECRETS.webhookOn}', 1);`);
			copy
				.prepare('INSERT INTO settings VALUES (?, ?)')
				.run(WEBHOOK_SECRETS_LEFT_OUT_KEY, '[{"id":1,"active":true},{"id":2,"active":true},{"id":3,"active":false}]');

			clearSecrets(copy);

			// 1 still has none, and was on; 2 was given a secret since, so it is
			// listed afresh, as it is now; 3 is not there; 4 is signed.
			expect(JSON.parse(settingsOf(copy)[WEBHOOK_SECRETS_LEFT_OUT_KEY])).toEqual([
				{ id: 1, active: true },
				{ id: 2, active: false },
				{ id: 4, active: true }
			]);
			expect(hooksIn(copy)).toEqual([
				{ id: 1, secret: '', active: 0 },
				{ id: 2, secret: '', active: 0 },
				{ id: 4, secret: '', active: 0 }
			]);

			// One it cannot read is replaced all the same, and none is written where none is listed.
			const unread = copyOf(`${SETTINGS} ${WEBHOOKS}`);
			unread.prepare('INSERT INTO settings VALUES (?, ?)').run(WEBHOOK_SECRETS_LEFT_OUT_KEY, 'not json {');
			clearSecrets(unread);
			expect(settingsOf(unread)).toEqual({});
		});
	});

	// ── What a restore brings back ──────────────────────────────────────────

	it('is restored into the server it came from with every secret as it was, and says what it kept', () => {
		const before = secretsOf(sqlite);

		const result = restoreFromBackup(sqlite, backupNow());

		expect(result.errors).toEqual([]);
		expect(result.sealVerified).toBe(true);
		expect(secretsOf(sqlite)).toEqual(before);
		expect(result.secrets).toEqual({
			kept: { mailPassword: true, destinations: ['NAS', 'Bucket', 'Drive', 'Robot', 'OneDrive'], webhooks: [hooks.on, hooks.off] },
			toEnter: NOTHING_TO_ENTER
		});
		expect(secretsKeptSentence(result.secrets.kept)).toBe(
			'Kept from this server, because a backup does not hold them: the mail password; the credentials of backup ' +
				`destination(s) "NAS", "Bucket", "Drive", "Robot", "OneDrive"; the signing secret(s) of webhook(s) ${hooks.on}, ${hooks.off}.`
		);
	});

	it('is restored into a server with none of them with nothing filled, the webhooks off, and each listed with what it needs', () => {
		const live = migratedDb();

		const result = restoreFromBackup(live, backupNow());

		expect(result.errors).toEqual([]);
		// A server with no key has made no backup, so this one's seal does not verify (S1).
		expect(result.sealVerified).toBe(false);
		expect(result.secrets).toEqual({
			kept: NOTHING_KEPT,
			toEnter: { mailPassword: true, destinations: NEEDS, webhooks: hooksToEnter() }
		});
		expect(settingsOf(live)['smtp_pass']).toBeUndefined();
		expect(JSON.parse(settingsOf(live)['backup_config']).destinations).toEqual(DESTINATIONS_CLEARED);
		expect(hooksIn(live)).toEqual([
			{ id: hooks.on, secret: '', active: 0 },
			{ id: hooks.off, secret: '', active: 0 },
			{ id: hooks.unsigned, secret: '', active: 1 }
		]);
		// The list is written again, for every start to name them (R2).
		expect(JSON.parse(settingsOf(live)[WEBHOOK_SECRETS_LEFT_OUT_KEY])).toEqual(listed());
		expect(secretsToEnterSentence(result.secrets.toEnter)).toBe(everythingToEnter());
	});

	it('says what is to enter through the route, word for word, in its answer and in a WARN line of its own', async () => {
		const backup = backupNow();
		// This server has none of them now.
		sqlite.exec("DELETE FROM settings WHERE key IN ('smtp_pass', 'backup_config'); UPDATE webhooks SET secret = ''");

		const res = await atWarn(() => importing(backup));

		expect(res.status).toBe(200);
		expect(res.body.message).toContain(` ${everythingToEnter()}`);
		expect(res.body.message).not.toContain('Kept from this server');
		expect(res.body.secretsToEnter).toBe(everythingToEnter());
		expect(res.body).not.toHaveProperty('secretsKept');
		expect(toEnterLines('IMPORT')).toEqual([{ level: 'WARN', message: everythingToEnter() }]);
	});

	it('says what it kept through the route, and nothing to enter, on the server the backup came from', async () => {
		const res = await atWarn(() => importing(backupNow()));

		expect(res.status).toBe(200);
		expect(res.body.secretsKept).toBe(
			'Kept from this server, because a backup does not hold them: the mail password; the credentials of backup ' +
				`destination(s) "NAS", "Bucket", "Drive", "Robot", "OneDrive"; the signing secret(s) of webhook(s) ${hooks.on}, ${hooks.off}.`
		);
		expect(res.body.message).toContain(` ${res.body.secretsKept}`);
		expect(res.body).not.toHaveProperty('secretsToEnter');
		expect(toEnterLines('IMPORT')).toEqual([]);
	});

	// ── The seal (the review's S1) ─────────────────────────────────────────

	describe('the seal: only a backup this server made, unchanged since, has anything filled (S1)', () => {
		/** What a restore that kept nothing lists: every gap, as for a server that has none of the secrets. */
		const keptNothing = (result: ReturnType<typeof restoreFromBackup>) => {
			expect(result.sealVerified).toBe(false);
			expect(result.secrets).toEqual({
				kept: NOTHING_KEPT,
				toEnter: { mailPassword: true, destinations: NEEDS, webhooks: hooksToEnter() }
			});
		};

		it('is in the copy, as a setting of its form’s number and 64 hex characters made again from the file it is in', async () => {
			const res = await gate('GET', '/api/admin/export', { headers: { cookie: `${SESSION_COOKIE_NAME}=${chiefSession}` } });
			expect(res.status).toBe(200);
			for (const bytes of [generateBackupData(), Buffer.from(await res.arrayBuffer())]) {
				const backup = opening(bytes);
				const seal = settingsOf(backup)[BACKUP_SEAL];
				expect(seal).toMatch(/^2:[0-9a-f]{64}$/);
				// Written before the copy was written out again, and the same over the file that was.
				expect(seal).toBe(`2:${sealOf(backup, backupSealKey(sqlite))}`);
			}
		});

		it('is made with a key this server keeps, which is in no backup, and which a restore keeps', () => {
			const backup = backupNow();
			const key = settingsOf(sqlite)[BACKUP_SEAL_KEY];
			expect(key).toMatch(/^[0-9a-f]{64}$/);
			for (const bytes of [generateBackupData(), Buffer.from(backup.serialize())]) {
				expect(bytes.includes(Buffer.from(key)), 'the key').toBe(false);
				expect(bytes.includes(Buffer.from(BACKUP_SEAL_KEY)), 'its setting').toBe(false);
			}

			// A backup that brings a key of its own, sealed with this server's
			// (the worst there could be): the key here is the one kept.
			const bringing = resealed(backupNow(), (made) =>
				made.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(BACKUP_SEAL_KEY, 'f'.repeat(64))
			);
			const result = restoreFromBackup(sqlite, bringing);

			expect(result.sealVerified).toBe(true);
			expect(settingsOf(sqlite)[BACKUP_SEAL_KEY]).toBe(key);
			expect(settingsOf(sqlite)[BACKUP_SEAL]).toBeUndefined();
			// And a backup made before the restore still verifies after it.
			expect(restoreFromBackup(sqlite, backup).sealVerified).toBe(true);
			// A server with no key yet is given none by the backup either.
			const fresh = migratedDb();
			restoreFromBackup(fresh, bringing);
			expect(settingsOf(fresh)[BACKUP_SEAL_KEY]).toBeUndefined();
			// And the seal is written into a copy only, never into the running database.
			expect(() => sealCopy(sqlite, Buffer.from(key, 'hex'))).toThrow('never the running database');
		});

		it('fills every secret into an unchanged backup on the server that made it', () => {
			const before = secretsOf(sqlite);

			const result = restoreFromBackup(sqlite, backupNow());

			expect(result.sealVerified).toBe(true);
			expect(result.secrets.kept.destinations).toHaveLength(5);
			expect(secretsOf(sqlite)).toEqual(before);
		});

		it.each<[string, (backup: Database.Database) => void]>([
			// The review's probe: a backup this server's own in every field, with one superadmin added.
			[
				'one superadmin added',
				(backup) =>
					backup
						.prepare("INSERT INTO users (username, email, password_hash, role) VALUES ('intruder', 'intruder@example.test', 'x', 'superadmin')")
						.run()
			],
			['one card changed', (backup) => backup.prepare("UPDATE cards SET title = 'A card, changed'").run()],
			['its seal taken out', (backup) => backup.prepare('DELETE FROM settings WHERE key = ?').run(BACKUP_SEAL)],
			['a seal that is not hex', (backup) => backup.prepare('UPDATE settings SET value = ? WHERE key = ?').run('z'.repeat(64), BACKUP_SEAL)],
			['a table added', (backup) => backup.exec('CREATE TABLE extra (id INTEGER PRIMARY KEY)')],
			['an index added', (backup) => backup.exec('CREATE INDEX extra_titles ON cards (title)')],
			// The second review's B1: what ANALYZE writes steers how a query reads,
			// so sqlite_stat1, its rows and its structure, is in the seal.
			['ANALYZE run on it', (backup) => backup.exec('ANALYZE')]
		])('fills nothing, and lists every gap, for a backup with %s', (_case, change) => {
			const backup = backupNow();
			change(backup);
			const before = secretsOf(sqlite);

			const result = restoreFromBackup(sqlite, backup);

			keptNothing(result);
			expect(settingsOf(sqlite)['smtp_pass']).toBeUndefined();
			expect(JSON.stringify(secretsOf(sqlite))).not.toContain(SECRETS.s3Secret);
			expect(secretsOf(sqlite)).not.toEqual(before);
		});

		it('fills nothing for a backup made by another server, with a key of its own', () => {
			const live = sameButOwnSecrets('0'.repeat(64));

			const result = restoreFromBackup(live, backupNow());

			keptNothing(result);
			expect(holdsOwn(live)).toBe(false);
			// Nor for one with no key at all, which has made no backup.
			keptNothing(restoreFromBackup(sameButOwnSecrets(null), backupNow()));
		});

		it('leaves out SQLite’s own sqlite_sequence, which a backup may hold otherwise', () => {
			const backup = backupNow();
			backup.prepare("UPDATE sqlite_sequence SET seq = seq + 100 WHERE name = 'cards'").run();

			expect(restoreFromBackup(sqlite, backup).sealVerified).toBe(true);
		});

		/**
		 * `backup` with its `sqlite_master` changed by `sql` (with
		 * `writable_schema`, as the second review's probe did), opened again so
		 * that SQLite reads the structure as it now is.
		 */
		const schemaWritten = (backup: Database.Database, sql: string) => {
			backup.unsafeMode(true);
			backup.pragma('writable_schema = ON');
			backup.exec(sql);
			backup.pragma('writable_schema = OFF');
			backup.unsafeMode(false);
			return opening(backup.serialize());
		};

		it('says which of two reasons kept nothing: no seal this server can check, or one that does not verify (N7)', () => {
			const unsealedSentence = (result: ReturnType<typeof restoreFromBackup>) =>
				secretsToEnterSentence(result.secrets.toEnter, false, result.unsealed);

			const noSeal = backupNow();
			noSeal.prepare('DELETE FROM settings WHERE key = ?').run(BACKUP_SEAL);
			const withoutOne = restoreFromBackup(sameButOwnSecrets(), noSeal);
			expect(withoutOne.unsealed).toEqual({ seal: 'none', check: null });
			expect(unsealedSentence(withoutOne)).toBe(`${everythingToEnter()} None was kept from this server, because ${NO_SEAL_HERE}.`);
			// A server with no key has no seal of its own to check either.
			expect(restoreFromBackup(sameButOwnSecrets(null), backupNow()).unsealed).toEqual({ seal: 'none', check: null });

			const anotherKey = restoreFromBackup(sameButOwnSecrets('0'.repeat(64)), backupNow());
			expect(anotherKey.unsealed).toEqual({ seal: 'failed', check: null });
			expect(unsealedSentence(anotherKey)).toBe(`${everythingToEnter()} None was kept from this server, because ${NOT_SEALED_HERE}.`);
			expect(restoreFromBackup(sqlite, backupNow()).unsealed).toBeNull();
		});

		it('takes a seal of any other form as no seal this server can check, the right MAC without its number included', () => {
			const made = backupNow();
			const key = sealKeyHere(sqlite);
			const mac = sealOf(made, backupSealKey(sqlite));
			expect(unsealedBecause(made, key)).toBeNull();

			for (const stored of [mac, `1:${mac}`, `3:${mac}`, `02:${mac}`, `2:${mac.toUpperCase()}`, `2:${mac}\n`, `2:${mac}:${mac}`]) {
				const backup = backupNow();
				backup.prepare('UPDATE settings SET value = ? WHERE key = ?').run(stored, BACKUP_SEAL);
				expect(sealVerifies(backup, key), stored).toBe(false);
				expect(unsealedBecause(backup, key), stored).toEqual({ seal: 'none', check: null });
			}

			// And the restore says so, in N7's first words.
			const bare = backupNow();
			bare.prepare('UPDATE settings SET value = ? WHERE key = ?').run(mac, BACKUP_SEAL);
			const result = restoreFromBackup(sameButOwnSecrets(), bare);
			expect(result.sealVerified).toBe(false);
			expect(secretsToEnterSentence(result.secrets.toEnter, false, result.unsealed)).toBe(
				`${everythingToEnter()} None was kept from this server, because this backup carries no seal this server can check.`
			);
		});

		it('reads the backup in one read transaction, ended whether the restore returns or throws', () => {
			/** `backup`, with whether it was in a transaction noted at every statement the restore prepares on it. */
			const watched = (backup: Database.Database) => {
				const seen: boolean[] = [];
				const proxy = new Proxy(backup, {
					get(target, property) {
						if (property === 'prepare') {
							return (sql: string) => {
								seen.push(target.inTransaction);
								return target.prepare(sql);
							};
						}
						const value = Reflect.get(target, property, target);
						return typeof value === 'function' ? value.bind(target) : value;
					}
				});
				return { proxy, seen };
			};

			const returning = watched(backupNow());
			expect(restoreFromBackup(sqlite, returning.proxy).sealVerified).toBe(true);
			expect(returning.seen.length).toBeGreaterThan(20);
			expect(returning.seen.every(Boolean)).toBe(true);
			expect(returning.proxy.inTransaction).toBe(false);

			// A restore that throws: here the first thing it asks, a transaction open on the running database.
			const throwing = backupNow();
			sqlite.exec('BEGIN');
			try {
				expect(() => restoreFromBackup(sqlite, throwing)).toThrow(RestoreError);
			} finally {
				sqlite.exec('ROLLBACK');
			}
			expect(throwing.inTransaction).toBe(false);

			// One the caller has open is left to the caller.
			const callers = backupNow();
			callers.exec('BEGIN');
			restoreFromBackup(sqlite, callers);
			expect(callers.inTransaction).toBe(true);
			callers.exec('ROLLBACK');
		});

		it('keeps its seal through VACUUM INTO for a database ANALYZE has run on, sqlite_stat1 and all', () => {
			const dir = mkdtempSync(join(tmpdir(), 'dumpfire-seal-stat-'));
			tempDirs.push(dir);
			const from = new Database(join(dir, 'from.db'));
			from.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
				CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT); CREATE INDEX notes_title ON notes (title);
				INSERT INTO notes (title) VALUES ('c'), ('b'), ('a'); ANALYZE;`);
			from.close();
			const key = backupSealKey(sqlite);

			withoutSecrets(join(dir, 'from.db'), join(dir, 'to.db'), key);

			const copy = new Database(join(dir, 'to.db'), { readonly: true });
			opened.push(copy);
			expect(copy.prepare("SELECT count(*) FROM sqlite_stat1 WHERE idx = 'notes_title'").pluck().get()).toBe(1);
			expect(unsealedBecause(copy, key.toString('hex'))).toBeNull();
		});

		it('fills nothing for a sealed backup whose index fails the integrity check, and names the check (B1)', () => {
			// This server's backup, with an index that no longer holds its
			// table's rows, sealed as it stands: the seal verifies, the file does not.
			const damaged = resealed(
				schemaWritten(
					backupNow(),
					"UPDATE sqlite_master SET sql = 'CREATE INDEX idx_webhooks_board_id ON webhooks (url)' WHERE name = 'idx_webhooks_board_id'"
				)
			);
			expect(damaged.pragma('integrity_check', { simple: true })).not.toBe('ok');

			const result = restoreFromBackup(sqlite, damaged);

			keptNothing(result);
			expect(result.unsealed?.seal).toBe('failed');
			expect(result.unsealed?.check).toMatch(/^PRAGMA integrity_check on it did not answer "ok" \(.*idx_webhooks_board_id/);
			// The restore itself went ahead, as for any unsealed backup.
			expect(result.errors).toEqual([]);
			expect(hooksIn(sqlite)).toHaveLength(3);
		});

		it('fills nothing for a sealed backup holding an index named as SQLite’s own, and names it (B1)', () => {
			const backup = backupNow();
			backup.exec('CREATE INDEX cover ON users (username, email, role)');
			const hidden = resealed(
				schemaWritten(backup, "UPDATE sqlite_master SET name = 'sqlite_cover', sql = 'CREATE INDEX sqlite_cover ON users (username, email, role)' WHERE name = 'cover'")
			);
			expect(hidden.pragma('integrity_check', { simple: true })).toBe('ok');

			const result = restoreFromBackup(sqlite, hidden);

			keptNothing(result);
			expect(result.unsealed).toEqual({
				seal: 'failed',
				check: 'it holds "sqlite_cover", named as SQLite\'s own, which no backup made by this server holds'
			});
		});

		it('tells SQLite’s own objects a backup of this server’s may hold from any other named as one (B1)', () => {
			const table = (name: string, sql: string | null = `CREATE TABLE ${name} (a)`) => ({ type: 'table', name, tbl_name: name, sql });
			const index = (name: string, on: string, sql: string | null = null) => ({ type: 'index', name, tbl_name: on, sql });
			const schema = [
				table('settings'),
				table('task_requests'),
				table('sqlite_sequence'),
				table('sqlite_stat1'),
				table('sqlite_stat2'),
				table('sqlite_stat3'),
				table('sqlite_stat4'),
				index('sqlite_autoindex_settings_1', 'settings'),
				index('sqlite_autoindex_task_requests_2', 'task_requests'),
				index('idx_settings', 'settings', 'CREATE INDEX idx_settings ON settings (a)'),
				// Not so:
				index('sqlite_cover', 'settings', 'CREATE INDEX sqlite_cover ON settings (a)'),
				index('SQLITE_Cover2', 'settings', 'CREATE INDEX SQLITE_Cover2 ON settings (a)'),
				table('sqlite_stat5'),
				index('sqlite_stat1', 'settings'),
				index('sqlite_autoindex_settings_2', 'settings', 'CREATE INDEX sqlite_autoindex_settings_2 ON settings (a)'),
				index('sqlite_autoindex_cards_1', 'cards'),
				index('sqlite_autoindex_settings_3', 'task_requests'),
				index('sqlite_autoindex_settings_x', 'settings'),
				index('sqlite_autoindex_settings_0', 'settings'),
				index('sqlite_autoindex_sqlite_stat1_1', 'sqlite_stat1'),
				{ type: 'view', name: 'sqlite_sequence', tbl_name: 'sqlite_sequence', sql: 'CREATE VIEW sqlite_sequence AS SELECT 1' },
				{ type: 'trigger', name: 'sqlite_t', tbl_name: 'settings', sql: 'CREATE TRIGGER sqlite_t AFTER INSERT ON settings BEGIN SELECT 1; END' }
			];

			expect(strayInternalObjects(schema)).toEqual([
				'sqlite_cover',
				'SQLITE_Cover2',
				'sqlite_stat5',
				'sqlite_stat1',
				'sqlite_autoindex_settings_2',
				'sqlite_autoindex_cards_1',
				'sqlite_autoindex_settings_3',
				'sqlite_autoindex_settings_x',
				'sqlite_autoindex_settings_0',
				'sqlite_autoindex_sqlite_stat1_1',
				'sqlite_sequence',
				'sqlite_t'
			]);
			// And a backup this server makes now holds none.
			const made = backupNow();
			expect(strayInternalObjects(made.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all() as never[])).toEqual([]);
		});

		it('copies each table’s rows from the table itself, in rowid order, whatever an index or sqlite_stat1 says (B1)', () => {
			const backup = new Database(':memory:');
			opened.push(backup);
			backup.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT); CREATE INDEX notes_title ON notes (title);
				CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE INDEX settings_cover ON settings (value, key);`);
			for (const [id, title] of [[1, 'e'], [2, 'd'], [3, 'c'], [4, 'b'], [5, 'a']] as const) {
				backup.prepare('INSERT INTO notes VALUES (?, ?)').run(id, title);
				backup.prepare('INSERT INTO settings VALUES (?, ?)').run(`k${id}`, title);
			}
			// The hint the second review's probe used: each index said to be
			// smaller than its table, so a bare SELECT * reads it instead.
			backup.exec("ANALYZE; UPDATE sqlite_stat1 SET stat = stat || ' sz=1' WHERE idx IN ('notes_title', 'settings_cover'); ANALYZE sqlite_master;");
			expect(backup.prepare('SELECT id FROM notes').pluck().all()).toEqual([5, 4, 3, 2, 1]);

			expect(rowsToRestore(backup, 'notes').map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
			expect(rowsToRestore(backup, 'settings').map((row) => row.key)).toEqual(['k1', 'k2', 'k3', 'k4', 'k5']);
		});

		it('reads, in the restore, the seal and the backup’s settings from each table’s own rows, never through an index (B1)', () => {
			const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
			const between = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));
			const secrets = source('src/lib/server/backup-secrets.ts');
			const restore = between(source('src/lib/server/db/restore.ts'), 'export function rowsToRestore', '\n}\n');

			expect(between(secrets, 'export function fromTableStorage', '\n}\n')).toContain('NOT INDEXED');
			expect(between(secrets, 'function settingOf', '\n}\n')).toContain('FROM settings NOT INDEXED WHERE');
			expect(between(secrets, 'export function sealOf', '\n}\n')).toContain('fromTableStorage(database, table');
			expect(restore.match(/fromTableStorage\(backup, table/g)).toHaveLength(3);
			expect(restore).not.toMatch(/SELECT \* FROM/);
			// And both of lacksSuperadmin's counts, which ask the backup before the import starts.
			const counts = between(source('src/lib/server/db/restore.ts'), 'export function lacksSuperadmin', 'export function superadminsOf').match(/FROM users[^'"]*/g);
			expect(counts).toEqual(['FROM users NOT INDEXED', 'FROM users NOT INDEXED WHERE role = ']);
		});

		it('tells a text from a number, and one value from two that join into it', () => {
			const sealOfRows = (sql: string) => {
				const database = new Database(':memory:');
				opened.push(database);
				database.exec(sql);
				return sealOf(database, Buffer.alloc(32, 7));
			};

			const seals = [
				sealOfRows("CREATE TABLE t (a, b); INSERT INTO t VALUES ('1', NULL);"),
				sealOfRows('CREATE TABLE t (a, b); INSERT INTO t VALUES (1, NULL);'),
				sealOfRows('CREATE TABLE t (a, b); INSERT INTO t VALUES (1.0, NULL);'),
				sealOfRows("CREATE TABLE t (a, b); INSERT INTO t VALUES ('ab', 'c');"),
				sealOfRows("CREATE TABLE t (a, b); INSERT INTO t VALUES ('a', 'bc');"),
				sealOfRows("CREATE TABLE t (a, b); INSERT INTO t VALUES (x'6162', 'c');"),
				sealOfRows("CREATE TABLE t (a, b); INSERT INTO t VALUES ('a', 'b'), ('c', NULL);"),
				sealOfRows("CREATE TABLE t (a, b); INSERT INTO t VALUES ('c', NULL), ('a', 'b');")
			];

			expect(new Set(seals).size).toBe(seals.length);
			// And the same rows, written in another order, are the same seal.
			expect(sealOfRows("CREATE TABLE t (id INTEGER PRIMARY KEY, a); INSERT INTO t VALUES (2, 'b'); INSERT INTO t VALUES (1, 'a');")).toBe(
				sealOfRows("CREATE TABLE t (id INTEGER PRIMARY KEY, a); INSERT INTO t VALUES (1, 'a'); INSERT INTO t VALUES (2, 'b');")
			);
		});

		it('says through the route why nothing was kept, in its answer and in its one WARN line', async () => {
			const backup = backupNow();
			backup.prepare("INSERT INTO users (username, email, password_hash, role) VALUES ('intruder', 'intruder@example.test', 'x', 'superadmin')").run();
			const said = `${everythingToEnter()} None was kept from this server, because ${NOT_SEALED_HERE}.`;

			const res = await atWarn(() => importing(backup));

			expect(res.status).toBe(200);
			expect(res.body.secretsToEnter).toBe(said);
			expect(res.body.message).toContain(` ${said}`);
			expect(res.body).not.toHaveProperty('secretsKept');
			expect(toEnterLines('IMPORT')).toEqual([{ level: 'WARN', message: said }]);
		});

		it('says through the route, in one WARN line of its own, which check a backup failed before its seal (B1)', async () => {
			const backup = backupNow();
			backup.exec('CREATE INDEX cover ON users (username, email, role)');
			const hidden = resealed(
				schemaWritten(backup, "UPDATE sqlite_master SET name = 'sqlite_cover', sql = 'CREATE INDEX sqlite_cover ON users (username, email, role)' WHERE name = 'cover'")
			);
			const said = `${everythingToEnter()} None was kept from this server, because ${NOT_SEALED_HERE}.`;

			const res = await atWarn(() => importing(hidden));

			expect(res.status).toBe(200);
			expect(res.body.secretsToEnter).toBe(said);
			expect(toEnterLines('IMPORT')).toEqual([{ level: 'WARN', message: said }]);
			expect(
				sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'IMPORT' AND message LIKE 'Nothing was kept%'").all()
			).toEqual([
				{
					level: 'WARN',
					message: failedCheckSentence('it holds "sqlite_cover", named as SQLite\'s own, which no backup made by this server holds')
				}
			]);
			// Spelt out once, so that the words are held as well as the function.
			expect(failedCheckSentence('X')).toBe(
				'Nothing was kept from this server, because the backup failed a check made before its seal is checked: X. The restore itself went ahead.'
			);
		});
	});

	describe('near misses: what is not the same account is never filled (R1)', () => {
		it.each([
			['another user', { smtp_user: 'someone-else' }],
			['another port', { smtp_port: '587' }],
			['the way out (mail without a checked, encrypted connection) on here, where the backup has it off', { smtp_allow_insecure: 'true' }],
			['another host', { smtp_host: 'mail.elsewhere.test' }]
		])('does not fill the mail password for mail on %s, and lists it', (_case, change) => {
			const live = serverWith({ mail: { ...MAIL, ...change, smtp_pass: `${HERE}-mail` } });

			const result = restoreFromBackup(live, backupNow());

			expect(settingsOf(live)['smtp_pass']).toBeUndefined();
			expect(result.secrets.kept.mailPassword).toBe(false);
			expect(result.secrets.toEnter.mailPassword).toBe(true);
			expect(holdsOwn(live)).toBe(false);
		});

		it('does not fill it for a backup with the way out on, where this server has it off (card 2189)', () => {
			const live = serverWith({ mail: { ...MAIL, smtp_pass: `${HERE}-mail` } });
			const backup = resealed(backupNow(), (made) =>
				made.prepare("UPDATE settings SET value = 'true' WHERE key = 'smtp_allow_insecure'").run()
			);

			const result = restoreFromBackup(live, backup);

			expect(settingsOf(live)['smtp_pass']).toBeUndefined();
			expect(result.secrets.toEnter.mailPassword).toBe(true);
		});

		it('names the way-out box in what is to enter where the backup brought in a way out other than this server’s, and only then (S5)', () => {
			const box = '"Allow mail without a checked, encrypted connection"';
			const said = (result: ReturnType<typeof restoreFromBackup>) => secretsToEnterSentence(result.secrets.toEnter) ?? '';

			// The backup off, this server on.
			const offHere = restoreFromBackup(serverWith({ mail: { ...MAIL, smtp_allow_insecure: 'true', smtp_pass: `${HERE}-mail` } }), backupNow());
			expect(offHere.secrets.toEnter.mailWayOut).toBe(false);
			expect(said(offHere)).toContain(`the mail password (Admin, 📧 Email / SMTP, where the backup brought in ${box} unticked and this server had it ticked);`);

			// The backup on, this server off.
			const onBackup = resealed(backupNow(), (made) => made.prepare("UPDATE settings SET value = 'true' WHERE key = 'smtp_allow_insecure'").run());
			const onHere = restoreFromBackup(serverWith({ mail: { ...MAIL, smtp_pass: `${HERE}-mail` } }), onBackup);
			expect(onHere.secrets.toEnter.mailWayOut).toBe(true);
			expect(said(onHere)).toContain(`the mail password (Admin, 📧 Email / SMTP, where the backup brought in ${box} ticked and this server had it unticked);`);

			// Another host, the way out the same: the box is not named.
			const elsewhere = restoreFromBackup(serverWith({ mail: { ...MAIL, smtp_host: 'mail.elsewhere.test', smtp_pass: `${HERE}-mail` } }), backupNow());
			expect(elsewhere.secrets.toEnter).not.toHaveProperty('mailWayOut');
			expect(said(elsewhere)).toContain('the mail password (Admin, 📧 Email / SMTP);');

			// No seal this server can check is the reason, not the box.
			const wayOutOn = resealed(backupNow(), (made) => made.prepare("UPDATE settings SET value = 'true' WHERE key = 'smtp_allow_insecure'").run());
			const unsealed = restoreFromBackup(serverWith({ mail: { ...MAIL, smtp_pass: `${HERE}-mail` }, key: null }), wayOutOn);
			expect(unsealed.unsealed).not.toBeNull();
			expect(unsealed.secrets.toEnter.mailPassword).toBe(true);
			expect(unsealed.secrets.toEnter).not.toHaveProperty('mailWayOut');
		});

		it('fills it for a backup made before card 2189, with no row for the way out, where this server has it off, whatever “Use SSL/TLS” says', () => {
			const live = serverWith({ mail: { ...MAIL, smtp_secure: 'false', smtp_pass: `${HERE}-mail` } });
			const backup = resealed(backupNow(), (made) => made.prepare("DELETE FROM settings WHERE key = 'smtp_allow_insecure'").run());

			const result = restoreFromBackup(live, backup);

			expect(settingsOf(live)['smtp_pass']).toBe(`${HERE}-mail`);
			expect(result.secrets.kept.mailPassword).toBe(true);
		});

		it('fills it where host (in another case, with spaces), port, the way out and user are this server’s', () => {
			const live = serverWith({ mail: { ...MAIL, smtp_host: '  MAIL.Example.TEST ', smtp_from_name: 'Another name', smtp_pass: `${HERE}-mail` } });

			const result = restoreFromBackup(live, backupNow());

			expect(settingsOf(live)['smtp_pass']).toBe(`${HERE}-mail`);
			expect(result.secrets.kept.mailPassword).toBe(true);
		});

		it('fills no destination that differs from every one here in a field that is not secret, nor a webhook at another address, and lists each', () => {
			const own = { password: `${HERE}-sftp` };
			const live = serverWith({
				destinations: [
					{ ...NAS, ...own, host: 'other.example.test' },
					{ ...NAS, ...own, port: 2222 },
					{ ...NAS, ...own, remotePath: '/elsewhere' },
					{ ...NAS, ...own, name: 'NAS 2' },
					{ ...BUCKET, secretAccessKey: `${HERE}-s3`, bucket: 'somebody-elses-bucket' },
					{ ...BUCKET, secretAccessKey: `${HERE}-s3`, prefix: 'other/' },
					{ ...BUCKET, secretAccessKey: `${HERE}-s3`, endpoint: 'https://minio.example.test' },
					{ ...DRIVE, clientSecret: `${HERE}-gdrive`, refreshToken: `${HERE}-token`, folderId: 'shared-with-somebody' },
					{ ...ROBOT, serviceAccountJson: serviceAccountJson(`${HERE}-robot`, 'another-key-id') },
					{ ...ONEDRIVE, clientSecret: `${HERE}-onedrive`, folderPath: '/Elsewhere' }
				],
				webhooks: [{ id: hooks.on, url: 'https://hooks.example.test/elsewhere', secret: `${HERE}-hook` }]
			});

			const result = restoreFromBackup(live, backupNow());

			expect(result.errors).toEqual([]);
			expect(JSON.parse(settingsOf(live)['backup_config']).destinations).toEqual(DESTINATIONS_CLEARED);
			expect(result.secrets.kept).toEqual(NOTHING_KEPT);
			expect(result.secrets.toEnter.destinations).toEqual(NEEDS);
			expect(result.secrets.toEnter.webhooks).toEqual(hooksToEnter());
			expect(holdsOwn(live)).toBe(false);
		});

		it('fills no webhook whose secret here was set by another account than the backup\'s row names, and one whose setter is the same (card 2168)', () => {
			const here = { id: hooks.on, url: 'https://hooks.example.test/on', secret: `${HERE}-hook-on` };

			// Set again here since the backup, by account 90: the secret is 90's, and the backup's row names nobody.
			const reset = serverWith({ webhooks: [{ ...here, setBy: 90 }] });
			const refused = restoreFromBackup(reset, backupNow());
			expect(refused.errors).toEqual([]);
			expect(refused.secrets.kept.webhooks).toEqual([]);
			expect(refused.secrets.toEnter.webhooks).toEqual(hooksToEnter());
			expect(holdsOwn(reset)).toBe(false);

			// The same account on both sides.
			sqlite.prepare('UPDATE webhooks SET set_by = ? WHERE id = ?').run(chief.id, hooks.on);
			const same = serverWith({ webhooks: [{ ...here, setBy: chief.id }] });
			const filled = restoreFromBackup(same, backupNow());
			expect(filled.secrets.kept.webhooks).toEqual([hooks.on]);
			expect(same.prepare('SELECT secret, set_by FROM webhooks WHERE id = ?').get(hooks.on)).toEqual({ secret: `${HERE}-hook-on`, set_by: chief.id });
		});

		it('fills a destination the same in every field that is not secret, a missing S3 endpoint and an empty one alike', () => {
			const live = serverWith({
				destinations: [
					{ ...BUCKET, endpoint: '', secretAccessKey: `${HERE}-s3` },
					{ ...NAS, host: ' NAS.example.test', password: `${HERE}-sftp`, privateKey: '' }
				]
			});

			const result = restoreFromBackup(live, backupNow());

			const destinations = JSON.parse(settingsOf(live)['backup_config']).destinations;
			expect(destinations[0]).toEqual({ ...NAS, password: `${HERE}-sftp`, privateKey: '' });
			// Its own fields are the backup's: the endpoint it did not have is not added.
			expect(destinations[1]).toEqual({ ...BUCKET, secretAccessKey: `${HERE}-s3` });
			expect(result.secrets.kept.destinations).toEqual(['NAS', 'Bucket']);
		});

		it('does not complete a Google Drive OAuth destination that has its client secret and lacks only its refresh token', () => {
			const backup = backupNow();
			const config = JSON.parse(settingsOf(backup)['backup_config']);
			config.destinations[2] = { ...DRIVE, clientSecret: 'the-backups-own-client-secret', refreshToken: '' };
			resealed(backup, () => backup.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(JSON.stringify(config)));
			const live = sameButOwnSecrets();

			const result = restoreFromBackup(live, backup);

			expect(JSON.parse(settingsOf(live)['backup_config']).destinations[2]).toEqual(config.destinations[2]);
			expect(result.secrets.kept.destinations).not.toContain('Drive');
			expect(result.secrets.toEnter.destinations).toEqual([NEEDS[2]]);
		});

		it('fills a Google Drive destination from the one here it is, of two made with one OAuth client, and from neither when it is not one of them, or both are it', () => {
			const driveA = { ...DRIVE, name: 'Drive A', folderId: 'folder-a', clientSecret: `${HERE}-secret`, refreshToken: `${HERE}-token-a` };
			const driveB = { ...DRIVE, name: 'Drive B', folderId: 'folder-b', clientSecret: `${HERE}-secret`, refreshToken: `${HERE}-token-b` };
			const restoring = (backupDrive: Record<string, unknown>, here: unknown[]) => {
				sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(configWith([backupDrive]));
				const live = serverWith({ destinations: here });
				const result = restoreFromBackup(live, backupNow());
				return { destination: JSON.parse(settingsOf(live)['backup_config']).destinations[0], result };
			};

			const exact = restoring(driveB, [driveA, driveB]);
			expect(exact.destination.refreshToken).toBe(`${HERE}-token-b`);

			const elsewhere = restoring({ ...driveB, folderId: 'folder-c' }, [driveA, driveB]);
			expect(elsewhere.destination).toEqual({ ...driveB, folderId: 'folder-c', clientSecret: '', refreshToken: '' });
			expect(elsewhere.result.secrets.toEnter.destinations).toEqual([{ name: 'Drive B', type: 'gdrive', needs: NEEDS[2].needs }]);

			// Two here the same in every field that is not secret: which is meant is not known.
			const twice = restoring(driveB, [driveB, { ...driveB, refreshToken: `${HERE}-token-c` }]);
			expect(twice.destination).toEqual({ ...driveB, clientSecret: '', refreshToken: '' });
			expect(twice.result.secrets.kept.destinations).toEqual([]);
		});
	});

	it('restores a backup made before card 2169, which holds its secrets, as it has them, and says nothing of secrets', () => {
		// As an older build made it: the running database, secrets and all.
		const backup = opening(Buffer.from(sqlite.serialize()));
		const live = sameButOwnSecrets();

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		expect(secretsOf(live)).toEqual(secretsOf(backup));
		expect(result.secrets).toEqual({ kept: NOTHING_KEPT, toEnter: NOTHING_TO_ENTER });
		expect(secretsKeptSentence(result.secrets.kept)).toBeNull();
		expect(secretsToEnterSentence(result.secrets.toEnter)).toBeNull();
	});

	it('leaves this server’s secrets and webhooks as they were when the restore rolls back', () => {
		const live = sameButOwnSecrets();
		const before = secretsOf(live);
		const real = live.transaction.bind(live) as (fn: (...args: unknown[]) => unknown) => unknown;
		let filledInside: unknown = null;
		vi.spyOn(live, 'transaction').mockImplementation(((fn: (...args: unknown[]) => unknown) =>
			real((...args: unknown[]) => {
				fn(...args);
				filledInside = settingsOf(live)['smtp_pass'];
				throw new Error('disk I/O error');
			})) as unknown as typeof live.transaction);

		expect(() => restoreFromBackup(live, backupNow())).toThrow('The restore failed and nothing was changed: disk I/O error');

		// It had filled the gaps inside the transaction, and they went with the rest.
		expect(filledInside).toBe(`${HERE}-mail`);
		expect(secretsOf(live)).toEqual(before);
	});

	describe('the list of left-out webhooks a backup holds is its word (N4)', () => {
		/** A backup made now, with its list replaced by `text` and sealed again, restored into a server with this one's webhooks. */
		const restoringWithList = (text: string, change: (backup: Database.Database) => void = () => {}) => {
			const backup = resealed(backupNow(), (made) => {
				made.prepare('UPDATE settings SET value = ? WHERE key = ?').run(text, WEBHOOK_SECRETS_LEFT_OUT_KEY);
				change(made);
			});
			const live = sameButOwnSecrets();
			return { live, result: restoreFromBackup(live, backup) };
		};

		it.each([['not json {'], ['{"id": 1}']])('reads %j as listing none, says so, and commits', (text) => {
			const { live, result } = restoringWithList(text);

			expect(result.errors).toEqual([
				`The list of webhooks a backup left without their secrets (${WEBHOOK_SECRETS_LEFT_OUT_KEY}) is not a JSON list, so none was read from it`
			]);
			expect(result.secrets.kept.webhooks).toEqual([]);
			expect(hooksIn(live).map((hook) => (hook as { secret: string }).secret)).toEqual(['', '', '']);
		});

		it('ignores an entry whose id is not a whole number or whose active is not true or false, and reads the rest', () => {
			const { live, result } = restoringWithList(
				JSON.stringify([
					{ id: String(hooks.on), active: true },
					{ id: 1.5, active: true },
					{ id: hooks.off, active: 'yes' },
					{ id: hooks.on, active: true }
				])
			);

			expect(result.errors).toEqual([
				`3 entry(ies) of the list of webhooks a backup left without their secrets (${WEBHOOK_SECRETS_LEFT_OUT_KEY}) had no ` +
					'whole-number id or no true-or-false active, and were ignored'
			]);
			expect(result.secrets.kept.webhooks).toEqual([hooks.on]);
			expect(hooksIn(live)).toEqual([
				{ id: hooks.on, secret: `${HERE}-hook-on`, active: 1 },
				{ id: hooks.off, secret: '', active: 0 },
				{ id: hooks.unsigned, secret: '', active: 1 }
			]);
		});

		it('changes nothing for a listed webhook that has a secret in the backup', () => {
			const { live, result } = restoringWithList(JSON.stringify([{ id: hooks.on, active: false }]), (backup) => {
				backup.prepare("UPDATE webhooks SET secret = 'the-backups-own-secret', active = 1 WHERE id = ?").run(hooks.on);
			});

			expect(result.errors).toEqual([]);
			expect(hooksIn(live)[0]).toEqual({ id: hooks.on, secret: 'the-backups-own-secret', active: 1 });
			expect(result.secrets.kept.webhooks).toEqual([]);
			expect(result.secrets.toEnter.webhooks).toEqual([]);
		});
	});

	it('shows a service account’s key masked where there is one, and empty where a restore left none (O2)', async () => {
		const robotOf = async () =>
			JSON.parse(
				((await api('GET', '/api/admin/backup', { user: chief })).body.destinations as { name: string; serviceAccountJson: string }[]).find(
					(destination) => destination.name === 'Robot'
				)!.serviceAccountJson
			);

		expect((await robotOf()).private_key).toBe('••••••••');

		sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(configWith(DESTINATIONS_CLEARED));
		expect(await robotOf()).toEqual(JSON.parse(serviceAccountJson('')));
	});

	// ── A backup run ────────────────────────────────────────────────────────

	describe('a backup run (decision 8)', () => {
		beforeEach(() => {
			// A failed destination is an ERROR line, which the logger prints.
			vi.spyOn(console, 'error').mockImplementation(() => {});
		});

		const runNow = async () =>
			(await api('POST', '/api/admin/backup', { user: chief, body: {} })).body.results as { destination: string; status: string; message: string }[];
		const failedRuns = () =>
			sqlite.prepare("SELECT destination_name AS name, status, error FROM backup_log WHERE status = 'failed' ORDER BY id").all();
		const configOf = (destinations: unknown[]) =>
			({ ...JSON.parse(configWith([])), destinations }) as Parameters<typeof saveBackupConfig>[0];

		it('does not try a destination whose credentials are not entered, and says why in its result and in Backup History', async () => {
			// An SFTP destination with neither password nor key is tried, as before
			// (section 9), once its host key is confirmed (card 2250).
			saveBackupConfig(
				configOf([{ ...BUCKET, secretAccessKey: '' }, { ...NAS, hostKey: HOST_KEY }, { ...NAS, name: 'Open NAS', password: '', privateKey: '', hostKey: HOST_KEY }])
			);

			const results = await runNow();

			expect(results.map((r) => [r.destination, r.status])).toEqual([
				['Bucket', 'failed'],
				['NAS', 'success'],
				['Open NAS', 'success']
			]);
			expect(results[0].message).toBe(CREDENTIALS_NOT_ENTERED);
			expect(uploaded.map((u) => u.destination)).toEqual(['NAS', 'Open NAS']);
			expect(failedRuns()).toEqual([{ name: 'Bucket', status: 'failed', error: CREDENTIALS_NOT_ENTERED }]);
		});

		it('makes no copy when no destination can take one (N2)', async () => {
			saveBackupConfig(configOf([{ ...BUCKET, secretAccessKey: '' }, { ...DRIVE, refreshToken: '' }]));
			const exec = vi.spyOn(sqlite, 'exec');

			const results = await runNow();

			expect(results.map((r) => [r.destination, r.status, r.message])).toEqual([
				['Bucket', 'failed', CREDENTIALS_NOT_ENTERED],
				['Drive', 'failed', GDRIVE_NOT_CONNECTED]
			]);
			expect(exec.mock.calls.filter(([sql]) => String(sql).includes('VACUUM INTO'))).toEqual([]);
			expect(uploaded).toEqual([]);
			expect(failedRuns()).toHaveLength(2);
		});
	});

	// ── What the server says when it starts ─────────────────────────────────

	describe('the line at start while anything is to enter (decision 7)', () => {
		it('is one WARN line naming the mail password, the destination and the webhook still without a secret, and none for a complete installation', async () => {
			await atWarn(() => reportInstallation());
			expect(toEnterLines('STARTUP')).toEqual([]);

			// As a database put in place by hand from a backup, with one webhook given its secret since.
			sqlite.exec("DELETE FROM settings WHERE key = 'smtp_pass'");
			sqlite
				.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'")
				.run(configWith([{ ...BUCKET, secretAccessKey: '' }, { ...NAS, password: '', privateKey: '' }, ONEDRIVE]));
			sqlite.prepare("UPDATE webhooks SET secret = '', active = 0 WHERE id = ?").run(hooks.on);
			sqlite.prepare("UPDATE webhooks SET secret = 'given-since', active = 0 WHERE id = ?").run(hooks.off);
			sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(WEBHOOK_SECRETS_LEFT_OUT_KEY, JSON.stringify(listed()));
			const before = snapshotDb();

			await atWarn(() => reportInstallation());

			expect(toEnterLines('STARTUP')).toEqual([
				{
					level: 'WARN',
					message:
						'To enter again, because a backup does not hold them: the mail password (Admin, 📧 Email / SMTP); backup ' +
						'destination(s) "Bucket" (S3: its secret access key) (Admin, Scheduled Backups); the signing secret(s) of ' +
						`webhook(s) ${hooks.on} (board "Hooks"), which stay switched off until the board's owner or an administrator ` +
						"sets each one's secret and switches it on with PUT /api/v1/webhooks/{id}, or deletes it if it is no longer " +
						'wanted. A database put in place by hand from a backup has none of them: see docs/admin-guide.md, Restoring ' +
						'from Backup.'
				}
			]);
			// It reads and logs, and writes nothing else.
			expectUnchanged(before);
		});

		it('says a list it cannot read on the console alone, and throws nothing', async () => {
			sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(WEBHOOK_SECRETS_LEFT_OUT_KEY, 'not json {');
			const said = vi.spyOn(console, 'error').mockImplementation(() => {});

			await atWarn(() => expect(() => reportInstallation()).not.toThrow());

			expect(said.mock.calls.map(([line]) => String(line))).toEqual([
				`[STARTUP] The list of webhooks a backup left without their secrets (${WEBHOOK_SECRETS_LEFT_OUT_KEY}) is not a JSON list, so none was read from it.`
			]);
			expect(toEnterLines('STARTUP')).toEqual([]);
		});
	});

	// ── After an import onto another server (R2) ────────────────────────────

	it('names, at every start after an import, the webhooks it could not fill, until each is set, and a backup made since still lists them', async () => {
		const backup = backupNow();
		// The mail and the destinations are this server's; its webhooks have no secret.
		sqlite.exec("UPDATE webhooks SET secret = ''");
		const saying = (named: string, atStart: boolean) =>
			`To enter again, because a backup does not hold them: the signing secret(s) of webhook(s) ${named}, which stay ` +
			"switched off until the board's owner or an administrator " +
			(atStart
				? "sets each one's secret and switches it on with PUT /api/v1/webhooks/{id}, or deletes it if it is no longer wanted. " +
					'A database put in place by hand from a backup has none of them: see docs/admin-guide.md, Restoring from Backup.'
				: 'sets each one and switches it on with PUT /api/v1/webhooks/{id}.');
		const both = `${hooks.on} (board "Hooks"), ${hooks.off} (board "Hooks")`;

		const res = await atWarn(() => importing(backup));

		expect(res.status).toBe(200);
		expect(toEnterLines('IMPORT')).toEqual([{ level: 'WARN', message: saying(both, false) }]);
		await atWarn(() => reportInstallation());
		expect(toEnterLines('STARTUP')).toEqual([{ level: 'WARN', message: saying(both, true) }]);

		// One is given its secret: the next start names the other alone.
		sqlite.prepare("UPDATE webhooks SET secret = 'given-since' WHERE id = ?").run(hooks.off);
		sqlite.exec("DELETE FROM system_logs WHERE context = 'STARTUP'");
		await atWarn(() => reportInstallation());
		expect(toEnterLines('STARTUP')).toEqual([{ level: 'WARN', message: saying(`${hooks.on} (board "Hooks")`, true) }]);

		// A backup of this database still lists the one not set as on, which it
		// was when the first backup was made, though it is off now; the other
		// is listed as it is now.
		expect(JSON.parse(settingsOf(backupNow())[WEBHOOK_SECRETS_LEFT_OUT_KEY])).toEqual([
			{ id: hooks.on, active: true },
			{ id: hooks.off, active: false }
		]);
	});

	it('writes no list for a restore that fills every webhook, nor for a working copy, which lists only its webhooks to enter', () => {
		const backup = backupNow();
		restoreFromBackup(sqlite, backup);
		expect(settingsOf(sqlite)[WEBHOOK_SECRETS_LEFT_OUT_KEY]).toBeUndefined();

		const working = migratedDb();
		const result = restoreFromBackup(working, backup, { outside: 'off' });
		expect(settingsOf(working)[WEBHOOK_SECRETS_LEFT_OUT_KEY]).toBeUndefined();
		expect(result.secrets.toEnter).toEqual({ mailPassword: false, destinations: [], webhooks: hooksToEnter() });
	});

	it('fills a Google Drive refresh token with the scope this server recorded for it, never the backup’s (card 2188, test 15)', () => {
		const WIDE = 'https://www.googleapis.com/auth/drive';
		// The backup says its connection reaches only DumpFire's files.
		const claimingNarrow = () =>
			resealed(backupNow(), (made) => {
				const config = JSON.parse(settingsOf(made)['backup_config']);
				config.destinations[2] = { ...config.destinations[2], grantedScope: DRIVE_FILE_SCOPE };
				made.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(JSON.stringify(config));
			});
		const own = { clientSecret: `${HERE}-gdrive-secret`, refreshToken: `${HERE}-gdrive-token` };
		const restoredDrive = (here: Record<string, unknown>) => {
			const live = serverWith({ destinations: [here] });
			const result = restoreFromBackup(live, claimingNarrow());
			expect(result.secrets.kept.destinations).toEqual(['Drive']);
			return JSON.parse(settingsOf(live)['backup_config']).destinations[2];
		};

		expect(restoredDrive({ ...DRIVE, ...own, grantedScope: WIDE })).toEqual({ ...DRIVE, ...own, grantedScope: WIDE });
		// Recorded for none here (a connection made before card 2188): none.
		expect(restoredDrive({ ...DRIVE, ...own })).toEqual({ ...DRIVE, ...own });
	});

	describe('an SFTP host key is never taken from a backup (card 2250, decision 9 and R4)', () => {
		/** A backup made now, its SFTP destination replaced by `nas` and sealed again with this server's key. */
		const backupWithNas = (nas: Record<string, unknown>) =>
			resealed(backupNow(), (made) => {
				const config = JSON.parse(settingsOf(made)['backup_config']);
				config.destinations[0] = nas;
				made.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(JSON.stringify(config));
			});
		const restoredNas = (live: Database.Database) => JSON.parse(settingsOf(live)['backup_config']).destinations[0];
		const own = { password: `${HERE}-sftp`, privateKey: '' };

		it('fills an SFTP destination with this server’s key, never the backup’s, and none where this server has none', () => {
			const claiming = () => backupWithNas({ ...DESTINATIONS_CLEARED[0], hostKey: OTHER_HOST_KEY });

			const keyed = serverWith({ destinations: [{ ...NAS, ...own, hostKey: HOST_KEY }] });
			expect(restoreFromBackup(keyed, claiming()).secrets.kept.destinations).toEqual(['NAS']);
			expect(restoredNas(keyed)).toEqual({ ...NAS, ...own, hostKey: HOST_KEY });

			const keyless = serverWith({ destinations: [{ ...NAS, ...own }] });
			expect(restoreFromBackup(keyless, claiming()).secrets.kept.destinations).toEqual(['NAS']);
			expect(restoredNas(keyless)).toEqual({ ...NAS, ...own });

			// A backup made before card 2250, with no key, still fills, and takes this server's.
			const before2250 = serverWith({ destinations: [{ ...NAS, ...own, hostKey: HOST_KEY }] });
			expect(restoreFromBackup(before2250, backupNow()).secrets.kept.destinations).toEqual(['NAS']);
			expect(restoredNas(before2250)).toEqual({ ...NAS, ...own, hostKey: HOST_KEY });
		});

		it('takes the key out of an SFTP destination it does not fill, and lists it', () => {
			const live = serverWith({});

			const result = restoreFromBackup(live, backupWithNas({ ...DESTINATIONS_CLEARED[0], hostKey: OTHER_HOST_KEY }));

			expect(restoredNas(live)).toEqual(DESTINATIONS_CLEARED[0]);
			expect(result.secrets.toEnter.destinations).toContainEqual(NEEDS[0]);
		});

		it('takes the key out of every SFTP destination of a backup whose seal does not verify, though one here has a key', () => {
			const live = serverWith({ key: null, destinations: [{ ...NAS, ...own, hostKey: HOST_KEY }] });

			const result = restoreFromBackup(live, backupWithNas({ ...DESTINATIONS_CLEARED[0], hostKey: OTHER_HOST_KEY }));

			expect(result.unsealed).not.toBeNull();
			expect(restoredNas(live)).toEqual(DESTINATIONS_CLEARED[0]);
			expect(result.secrets.toEnter.destinations).toContainEqual(NEEDS[0]);
		});

		it('takes the key out of an SFTP destination the backup holds with its password, and leaves the rest as the backup has it', () => {
			const live = serverWith({ destinations: [{ ...NAS, ...own, hostKey: HOST_KEY }] });

			const result = restoreFromBackup(live, backupWithNas({ ...DESTINATIONS_CLEARED[0], password: 'the-backups-own-password', hostKey: OTHER_HOST_KEY }));

			expect(restoredNas(live)).toEqual({ ...DESTINATIONS_CLEARED[0], password: 'the-backups-own-password' });
			// Not filled: the password is the backup's own.
			expect(result.secrets.kept.destinations).toEqual([]);
		});

		it('gives an SFTP destination with neither password nor key, here as in the backup, this server’s key or none', () => {
			const open = { password: '', privateKey: '' };

			const keyed = serverWith({ destinations: [{ ...NAS, ...open, hostKey: HOST_KEY }] });
			restoreFromBackup(keyed, backupWithNas({ ...DESTINATIONS_CLEARED[0], hostKey: OTHER_HOST_KEY }));
			expect(restoredNas(keyed)).toEqual({ ...DESTINATIONS_CLEARED[0], hostKey: HOST_KEY });

			// The backup with no key at all, and this server's added.
			const added = serverWith({ destinations: [{ ...NAS, ...open, hostKey: HOST_KEY }] });
			restoreFromBackup(added, backupNow());
			expect(restoredNas(added)).toEqual({ ...DESTINATIONS_CLEARED[0], hostKey: HOST_KEY });

			const keyless = serverWith({ destinations: [{ ...NAS, ...open }] });
			restoreFromBackup(keyless, backupWithNas({ ...DESTINATIONS_CLEARED[0], hostKey: OTHER_HOST_KEY }));
			expect(restoredNas(keyless)).toEqual(DESTINATIONS_CLEARED[0]);
		});
	});
});

// ─── The backup settings' secrets (cards 2187 and 2190) ──────────────────────

describe('the backup settings’ secrets: masked in every answer, kept only for the destination they were saved with (cards 2187 and 2190)', () => {
	const MASK = '••••••••';
	/** One destination of each type and sign-in method, every secret field set; the Drive OAuth one connected with `drive.file`. */
	const STORED: Record<string, unknown>[] = DESTINATIONS.map((d) => (d.name === 'Drive' ? { ...d, grantedScope: DRIVE_FILE_SCOPE } : d));

	const store = (destinations: unknown[]) =>
		sqlite.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('backup_config', configWith(destinations));
	const storedDestinations = () => JSON.parse(settingsOf(sqlite)['backup_config']).destinations as Record<string, unknown>[];
	const shown = async () => (await api('GET', '/api/admin/backup', { user: chief })).body.destinations as Record<string, unknown>[];
	const put = (destinations: unknown[]) => api('PUT', '/api/admin/backup', { user: chief, body: { destinations } });
	const tested = (destination: unknown) => api('POST', '/api/admin/backup/test', { user: chief, body: destination });

	/** Decision 3's words for a destination with a secret typed again, as R8 names every field still masked. */
	const typeAgain = (name: string, secrets: string, because: string) =>
		`Backup destination "${name}": type its ${secrets} again. A saved secret is used only with the settings it was saved with, and ${because}.`;
	/** The same for a connected Google Drive destination, by the scope it was connected with (R2, R5). */
	const driveRefusal = (name: string, because: string, narrow: boolean) =>
		`Backup destination "${name}": a connected Google Drive destination keeps its connection only while its name, sign-in method, ` +
		`folder ID and client ID are as they were when it was connected, and ${because}. ` +
		(narrow
			? "To change them, remove the destination (removing a destination is the superadmin's), add it again, and connect it. To keep using a folder DumpFire made, give its " +
				'Folder ID again (shown on the destination as Folder:); Connect checks it can reach it.'
			: "To change them, first remove DumpFire's access in the Google account (Google Account, Security, Your connections to " +
				"third-party apps and services), then remove this destination (removing a destination is the superadmin's), add it again with the Folder ID left empty, and connect it.");

	beforeEach(() => {
		store(STORED);
	});

	it('shows every secret masked, the Google Drive refresh token included, and every other field as stored (test 1)', async () => {
		const res = await api('GET', '/api/admin/backup', { user: chief });

		expect(res.status).toBe(200);
		const text = JSON.stringify(res.body);
		for (const [name, value] of Object.entries(SECRETS)) expect(text.includes(value), name).toBe(false);
		expect(res.body.destinations).toEqual([
			{ ...NAS, password: MASK, privateKey: MASK },
			{ ...BUCKET, secretAccessKey: MASK },
			{ ...DRIVE, clientSecret: MASK, refreshToken: MASK, grantedScope: DRIVE_FILE_SCOPE },
			{ ...ROBOT, serviceAccountJson: serviceAccountJson(MASK) },
			{ ...ONEDRIVE, clientSecret: MASK }
		]);
		expect(SECRET_MASK).toBe(MASK);
	});

	it('masks, keeps on a save and hands a test the stored value of every field in the one list, so that a field added to it needs no new test (test 2)', async () => {
		const fields: [string, string][] = Object.entries(SECRET_FIELDS).flatMap(([type, names]) => names.map((name): [string, string] => [type, name]));
		expect(fields).toEqual([
			['sftp', 'password'],
			['sftp', 'privateKey'],
			['s3', 'secretAccessKey'],
			['gdrive', 'clientSecret'],
			['gdrive', 'refreshToken'],
			['onedrive', 'clientSecret']
		]);
		// And a service account's key, inside its JSON.
		const cases = [...fields.map(([type, field]) => ({ type, field })), { type: 'gdrive', field: 'serviceAccountJson' }];

		for (const { type, field } of cases) {
			store(STORED);
			const at = STORED.findIndex((d) => d.type === type && field in d);
			const page = await shown();
			const masked = field === 'serviceAccountJson' ? serviceAccountJson(MASK) : MASK;
			expect(page[at][field], `${type}.${field} as the GET shows it`).toBe(masked);

			// This destination's other fields typed as stored, this one as the GET
			// showed it, and the rest of the list as the GET gave it.
			const sentBack = { ...STORED[at], [field]: masked };
			const saved = await put(page.map((d, i) => (i === at ? sentBack : d)));
			expect(saved.status, `${type}.${field} saved: ${JSON.stringify(saved.body)}`).toBe(200);
			// A refresh token typed (here, as stored) has no recorded scope: the
			// scope is kept only with a kept token (test 8).
			const { grantedScope: _scope, ...typedToken } = STORED[at];
			const expected = type === 'gdrive' && field !== 'refreshToken' && 'refreshToken' in STORED[at] ? typedToken : STORED[at];
			expect(storedDestinations(), `${type}.${field} kept`).toEqual(STORED.map((d, i) => (i === at ? expected : d)));

			handed.length = 0;
			const test = await tested(sentBack);
			expect(test.status, `${type}.${field} tested: ${JSON.stringify(test.body)}`).toBe(200);
			expect(handed.map((config) => config[field]), `${type}.${field} handed`).toEqual([STORED[at][field]]);
		}
	});

	it('masks a secret left in a field of another type, and a service account JSON that is not an object, whole (test 3, R7)', async () => {
		store([
			{ ...BUCKET, password: 'left-from-sftp-r7-1' },
			{ ...ROBOT, name: 'Unreadable', serviceAccountJson: '{"private_key": "unreadable-r7-2"' },
			{ ...ROBOT, name: 'Quoted', serviceAccountJson: JSON.stringify('quoted-key-r7-3') },
			{ ...ROBOT, name: 'Listed', serviceAccountJson: JSON.stringify(['listed-key-r7-4']) }
		]);

		const res = await api('GET', '/api/admin/backup', { user: chief });

		expect(JSON.stringify(res.body)).not.toMatch(/-r7-/);
		expect((res.body.destinations as Record<string, unknown>[]).map((d) => [d.name, d.password ?? null, d.serviceAccountJson ?? null])).toEqual([
			['Bucket', MASK, null],
			['Unreadable', null, MASK],
			['Quoted', null, MASK],
			['Listed', null, MASK]
		]);
	});

	it('writes a service account JSON out again from what it reads, so a key named twice or as privateKey is masked (S3)', async () => {
		const email = 'robot@project.iam.example.test';
		store([
			// JSON.parse keeps the last of two keys alike: an empty last one used
			// to leave the stored text, the first key in it, in the answer.
			{ ...ROBOT, name: 'Twice', serviceAccountJson: `{"client_email":"${email}","private_key":"dup-key-s3-1","private_key":""}` },
			{ ...ROBOT, name: 'Camel', serviceAccountJson: JSON.stringify({ client_email: email, privateKey: 'camel-key-s3-2' }) },
			{ ...ROBOT, name: 'Keyless', serviceAccountJson: `{ "client_email" : "${email}" }` }
		]);

		const res = await api('GET', '/api/admin/backup', { user: chief });

		expect(JSON.stringify(res.body)).not.toMatch(/-s3-/);
		expect((res.body.destinations as { serviceAccountJson: string }[]).map((d) => d.serviceAccountJson)).toEqual([
			JSON.stringify({ client_email: email, private_key: '' }),
			JSON.stringify({ client_email: email, privateKey: MASK }),
			JSON.stringify({ client_email: email })
		]);
	});

	describe('a save with a masked secret and anything else changed is refused, naming what changed (test 4)', () => {
		const changed = (at: number, change: Record<string, unknown>) => async () => {
			const page = await shown();
			return put(page.map((d, i) => (i === at ? { ...d, ...change } : d)));
		};

		it.each([
			['SFTP host', changed(0, { host: 'backup.invalid' }), typeAgain('NAS', 'password and private key', 'this changes its host')],
			['SFTP port', changed(0, { port: 2222 }), typeAgain('NAS', 'password and private key', 'this changes its port')],
			['SFTP remote path', changed(0, { remotePath: '/elsewhere' }), typeAgain('NAS', 'password and private key', 'this changes its remote path')],
			['S3 bucket', changed(1, { bucket: 'somebody-elses' }), typeAgain('Bucket', 'secret access key', 'this changes its bucket')],
			['S3 prefix', changed(1, { prefix: 'other/' }), typeAgain('Bucket', 'secret access key', 'this changes its prefix')],
			['S3 endpoint', changed(1, { endpoint: 'https://minio.invalid' }), typeAgain('Bucket', 'secret access key', 'this changes its endpoint')],
			['Drive folder ID', changed(2, { folderId: 'shared-with-somebody' }), driveRefusal('Drive', 'this changes its folder ID', true)],
			['Drive client ID', changed(2, { clientId: 'another-client' }), driveRefusal('Drive', 'this changes its client ID', true)],
			['service account JSON', changed(3, { serviceAccountJson: JSON.stringify({ ...JSON.parse(serviceAccountJson(MASK)), client_email: 'other@iam.invalid' }) }), typeAgain('Robot', 'service account JSON', 'this changes its service account')],
			['OneDrive tenant', changed(4, { tenantId: 'tenant-2' }), typeAgain('OneDrive', 'client secret', 'this changes its tenant ID')],
			['SFTP host and port together', changed(0, { host: 'backup.invalid', port: 2222 }), typeAgain('NAS', 'password and private key', 'this changes its host and port')],
			// S1: trimmed of ASCII spaces and tabs alone, so a Unicode space is a change.
			['SFTP host with a no-break space', changed(0, { host: 'nas.example.test ' }), typeAgain('NAS', 'password and private key', 'this changes its host')],
			['SFTP host with a byte-order mark', changed(0, { host: '﻿nas.example.test' }), typeAgain('NAS', 'password and private key', 'this changes its host')],
			['SFTP host with an ideographic space', changed(0, { host: 'nas.example.test　' }), typeAgain('NAS', 'password and private key', 'this changes its host')],
			// The probe's: renamed at the same place, and pointed elsewhere.
			['rename at the same place', changed(0, { name: 'Other', host: 'backup.invalid' }), typeAgain('Other', 'password and private key', 'no destination of this name was saved')],
			// The probe's: a destination of another type at the same place takes nothing of the one there.
			[
				'another type at the same place',
				changed(4, { type: 'gdrive', authMethod: 'oauth', clientId: 'another-client', folderId: '', tenantId: undefined, folderPath: undefined }),
				typeAgain('OneDrive', 'client secret', 'this changes its type')
			],
			[
				'a name never saved',
				async () => put([...(await shown()), { ...NAS, name: 'New', password: MASK, privateKey: '' }]),
				typeAgain('New', 'password', 'no destination of this name was saved')
			],
			// R8: one secret typed again, the other still masked.
			['the password typed and the private key not', changed(0, { host: 'backup.invalid', password: 'typed-again' }), typeAgain('NAS', 'private key', 'this changes its host')]
		])('%s', async (_case, request, words) => {
			const before = snapshotDb();

			const res = await request();

			expect(res.status, JSON.stringify(res.body)).toBe(400);
			expect(res.body.message).toBe(words);
			expectUnchanged(before);
		});

		it('tells a Google Drive destination connected before card 2188 to remove DumpFire’s access in the Google account first (R2)', async () => {
			store(STORED.map((d) => (d.name === 'Drive' ? { ...DRIVE } : d)));
			const before = snapshotDb();

			const res = await changed(2, { folderId: 'shared-with-somebody' })();

			expect(res.status).toBe(400);
			expect(res.body.message).toBe(driveRefusal('Drive', 'this changes its folder ID', false));
			expectUnchanged(before);
		});
	});

	it('saves the list the GET gave, and what is the same in use, with every secret kept; and a typed secret as typed (test 5, R8)', async () => {
		// Sent back unchanged.
		expect((await put(await shown())).status).toBe(200);
		expect(storedDestinations()).toEqual(STORED);

		// Stored with an empty endpoint, no region, no prefix, no folder path and
		// no port; sent back as the edit form fills them in.
		const sparse = [
			{ ...BUCKET, endpoint: '', region: undefined, prefix: undefined },
			{ ...ONEDRIVE, folderPath: undefined },
			{ ...NAS, port: null }
		];
		store(sparse);
		const page = await shown();
		const asTheFormSends = [
			{ ...page[0], endpoint: undefined, region: 'us-east-1', prefix: '' },
			{ ...page[1], folderPath: '/DumpFire Backups' },
			{ ...page[2], port: 22, host: ' \tNAS.EXAMPLE.test ' }
		];
		const saved = await put(asTheFormSends);
		expect(saved.status, JSON.stringify(saved.body)).toBe(200);
		// The host as stored, not as sent (S1): the secret goes to the host it
		// was saved with, byte for byte.
		expect(storedDestinations()).toEqual([
			{ ...BUCKET, region: 'us-east-1', prefix: '' },
			{ ...ONEDRIVE, folderPath: '/DumpFire Backups' },
			{ ...NAS, port: 22 }
		]);

		// The host changed, with both secrets typed again (one emptied), saved
		// trimmed of ASCII spaces and tabs alone (S1).
		const moved = await put([{ ...NAS, host: ' nas2.example.test\t', password: 'a-new-password', privateKey: '' }]);
		expect(moved.status, JSON.stringify(moved.body)).toBe(200);
		expect(storedDestinations()).toEqual([{ ...NAS, host: 'nas2.example.test', password: 'a-new-password', privateKey: '' }]);
		const spaced = await put([{ ...NAS, host: 'nas2.example.test　', password: 'a-new-password', privateKey: '' }]);
		expect(spaced.status, JSON.stringify(spaced.body)).toBe(200);
		expect(storedDestinations()[0].host).toBe('nas2.example.test　');
	});

	it('refuses a masked secret where two saved destinations are the same in everything but their secrets, saying how to put it right (test 6, O1)', async () => {
		store([
			{ ...NAS, password: 'the-first-password' },
			{ ...NAS, password: 'the-second-password' }
		]);
		const before = snapshotDb();
		const words =
			'Backup destination "NAS": more than one saved destination matches it, so its saved secret cannot be told apart. ' +
			'Remove the destinations named "NAS" (the page\'s Remove removes every one of that name, and removing a destination is the ' +
			"superadmin's) and add it once with its secret typed.";

		const one = (await shown())[0];
		const saved = await put([one]);
		expect(saved.status).toBe(400);
		expect(saved.body.message).toBe(words);

		handed.length = 0;
		const test = await tested(one);
		expect(test.status).toBe(400);
		expect(test.body.message).toBe(words);
		expect(handed).toEqual([]);
		expectUnchanged(before);

		// The way out works: Remove sends the list without either, and the one
		// added again with its secret typed is saved.
		expect((await put([])).status).toBe(200);
		expect((await put([{ ...NAS, password: 'typed-once' }])).status).toBe(200);
		expect(storedDestinations()).toEqual([{ ...NAS, password: 'typed-once' }]);
	});

	it('refuses a list that names two destinations alike, naming it, and writes nothing (S4)', async () => {
		const before = snapshotDb();

		// A second destination given a name already used.
		const page = await shown();
		const renamed = await put(page.map((d, i) => (i === 1 ? { ...d, name: 'NAS' } : d)));
		expect(renamed.status).toBe(400);
		expect(renamed.body.message).toBe('Two backup destinations are named "NAS". Each destination needs a name of its own: give one of them another name.');
		expectUnchanged(before);

		// Two saved before this: the list the page sends back as it is.
		store([
			{ ...NAS, password: 'the-first-password' },
			{ ...NAS, host: 'nas2.example.test', password: 'the-second-password' }
		]);
		const stillTwo = snapshotDb();
		const resent = await put(await shown());
		expect(resent.status).toBe(400);
		expect(resent.body.message).toBe(
			'Two backup destinations are named "NAS". Remove the destinations named "NAS" (the page\'s Remove removes every one of that ' +
				"name, and removing a destination is the superadmin's) and add it once with its secret typed."
		);
		expectUnchanged(stillTwo);
	});

	it('refuses a test of a saved destination pointed elsewhere with its secret masked, and hands it nothing (test 7)', async () => {
		const nas = (await shown())[0];

		const res = await tested({ ...nas, host: 'backup.invalid', port: 2222 });

		expect(res.status).toBe(400);
		expect(res.body.message).toBe(typeAgain('NAS', 'password and private key', 'this changes its host and port'));
		expect(handed).toEqual([]);
	});

	describe('an SFTP host key, which narrows where a saved secret may go (card 2250, decision 8)', () => {
		/** The list the GET gave, with NAS (first) changed by `change`. */
		const withNas = async (change: Record<string, unknown>) => (await shown()).map((d, i) => (i === 0 ? { ...d, ...change } : d));
		const hostKeyRefusal = typeAgain('NAS', 'password and private key', 'this changes its host key');

		it('keeps the masked secrets when a key is confirmed where none was, and shows the key as stored, unmasked', async () => {
			const saved = await put(await withNas({ hostKey: HOST_KEY }));

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(storedDestinations()[0]).toEqual({ ...NAS, hostKey: HOST_KEY });
			expect((await shown())[0]).toEqual({ ...NAS, password: MASK, privateKey: MASK, hostKey: HOST_KEY });
		});

		it('keeps them when the confirmed key is sent back as ssh-keygen prints it', async () => {
			store([{ ...NAS, hostKey: HOST_KEY }]);

			const saved = await put(await withNas({ hostKey: `256 ${HOST_KEY.split(' ')[1]} root@nas (ED25519)` }));

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(storedDestinations()).toEqual([{ ...NAS, hostKey: HOST_KEY }]);
		});

		it.each([
			['changed', { hostKey: OTHER_HOST_KEY }],
			['emptied', { hostKey: '' }],
			['not sent', { hostKey: undefined }]
		])('refuses them, naming the host key, when a confirmed key is %s, on a save and a test', async (_case, change) => {
			store([{ ...NAS, hostKey: HOST_KEY }]);
			const before = snapshotDb();
			const [nas] = await withNas(change);

			const saved = await put([nas]);
			expect(saved.status).toBe(400);
			expect(saved.body.message).toBe(hostKeyRefusal);

			handed.length = 0;
			const test = await tested(nas);
			expect(test.status).toBe(400);
			expect(test.body.message).toBe(hostKeyRefusal);
			expect(handed).toEqual([]);
			expectUnchanged(before);
		});

		it('saves a changed key with the password and private key typed again', async () => {
			store([{ ...NAS, hostKey: HOST_KEY }]);

			const saved = await put(await withNas({ hostKey: OTHER_HOST_KEY, password: 'typed-again', privateKey: '' }));

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(storedDestinations()).toEqual([{ ...NAS, hostKey: OTHER_HOST_KEY, password: 'typed-again', privateKey: '' }]);
		});

		describe('the line a save writes for each host key it adds, changes or removes (card 2267)', () => {
			// The tests keep ERROR and above; these lines are WARN.
			let level: string | undefined;
			beforeEach(() => {
				level = process.env.LOG_LEVEL;
				process.env.LOG_LEVEL = 'WARN';
				vi.spyOn(console, 'warn').mockImplementation(() => {});
			});
			afterEach(() => {
				if (level === undefined) delete process.env.LOG_LEVEL;
				else process.env.LOG_LEVEL = level;
			});

			/** The lines a save of a host key writes (card 2267), oldest first. */
			const keyLines = () =>
				(
					sqlite
						.prepare("SELECT level, context, message, meta, user_id FROM system_logs WHERE message LIKE 'SFTP host key of destination%' ORDER BY id")
						.all() as { level: string; context: string; message: string; meta: string | null; user_id: number | null }[]
				).map((row) => ({ ...row, meta: row.meta === null ? null : JSON.parse(row.meta) }));
			const at = 'SFTP host key of destination "NAS" at nas.example.test:22';
			const line = (message: string, from: string, to: string) => ({
				level: 'WARN',
				context: 'BACKUP',
				message,
				meta: { destination: 'NAS', from, to },
				user_id: chief.id
			});

			it('writes one WARN line under BACKUP, filed under the account, when a key is confirmed where none was (card 2267)', async () => {
				const saved = await put(await withNas({ hostKey: HOST_KEY }));

				expect(saved.status, JSON.stringify(saved.body)).toBe(200);
				expect(keyLines()).toEqual([line(`${at} added: ${HOST_KEY}`, '', HOST_KEY)]);
			});

			it('writes one line naming both keys when a confirmed key is changed with the password typed again (card 2267)', async () => {
				store([{ ...NAS, hostKey: HOST_KEY }]);

				const saved = await put(await withNas({ hostKey: OTHER_HOST_KEY, password: 'typed-again', privateKey: '' }));

				expect(saved.status, JSON.stringify(saved.body)).toBe(200);
				expect(keyLines()).toEqual([line(`${at} changed from ${HOST_KEY} to ${OTHER_HOST_KEY}`, HOST_KEY, OTHER_HOST_KEY)]);
			});

			it('writes one line naming the key cleared when a confirmed key is emptied with the password typed again (card 2267)', async () => {
				store([{ ...NAS, hostKey: HOST_KEY }]);

				const saved = await put(await withNas({ hostKey: '', password: 'typed-again', privateKey: '' }));

				expect(saved.status, JSON.stringify(saved.body)).toBe(200);
				expect(keyLines()).toEqual([line(`${at} cleared: was ${HOST_KEY}`, HOST_KEY, '')]);
			});

			it.each([
				['changed', OTHER_HOST_KEY, `changed from ${HOST_KEY} (at nas.example.test:22) to ${OTHER_HOST_KEY}`],
				['cleared', '', `cleared: was ${HOST_KEY} (at nas.example.test:22)`]
			])('names the old host and port too when a key is %s by a save that also moves the destination (the card 2267 review)', async (_case, hostKey, words) => {
				store([{ ...NAS, hostKey: HOST_KEY }]);

				const saved = await put(await withNas({ host: 'moved.example.test', port: 2222, hostKey, password: 'typed-again', privateKey: '' }));

				expect(saved.status, JSON.stringify(saved.body)).toBe(200);
				expect(keyLines()).toEqual([
					{
						...line(`SFTP host key of destination "NAS" at moved.example.test:2222 ${words}`, HOST_KEY, hostKey),
						meta: { destination: 'NAS', from: HOST_KEY, to: hostKey, fromAt: 'nas.example.test:22' }
					}
				]);
			});

			it('leaves the old place out where the port is left empty, which is 22, and names it where only the port changed (the card 2267 review)', async () => {
				store([{ ...NAS, hostKey: HOST_KEY }]);

				const samePlace = await put(await withNas({ port: null, hostKey: OTHER_HOST_KEY, password: 'typed-again', privateKey: '' }));
				const newPort = await put(await withNas({ port: 2200, hostKey: HOST_KEY, password: 'typed-again', privateKey: '' }));

				expect([samePlace.status, newPort.status], JSON.stringify([samePlace.body, newPort.body])).toEqual([200, 200]);
				expect(keyLines()).toEqual([
					line(`${at} changed from ${HOST_KEY} to ${OTHER_HOST_KEY}`, HOST_KEY, OTHER_HOST_KEY),
					{
						...line(`SFTP host key of destination "NAS" at nas.example.test:2200 changed from ${OTHER_HOST_KEY} (at nas.example.test:22) to ${HOST_KEY}`, OTHER_HOST_KEY, HOST_KEY),
						meta: { destination: 'NAS', from: OTHER_HOST_KEY, to: HOST_KEY, fromAt: 'nas.example.test:22' }
					}
				]);
			});

			it.each([
				['left out of the list', (list: Record<string, unknown>[]) => list.slice(1)],
				['saved as another type under its name', (list: Record<string, unknown>[]) => [{ ...BUCKET, name: 'NAS', secretAccessKey: 'typed' }, ...list.slice(1)]]
			])('writes one line when a destination with a key is %s (card 2267, decision 2)', async (_case, change) => {
				store([{ ...NAS, hostKey: HOST_KEY }, ...STORED.slice(1)]);

				const saved = await put(change(await shown()));

				expect(saved.status, JSON.stringify(saved.body)).toBe(200);
				expect(keyLines()).toEqual([line(`${at} removed with the destination: was ${HOST_KEY}`, HOST_KEY, '')]);
			});

			it('writes no line for the confirmed key sent back as ssh-keygen prints it, nor for a save of the schedule alone (card 2267)', async () => {
				store([{ ...NAS, hostKey: HOST_KEY }]);

				const again = await put(await withNas({ hostKey: `256 ${HOST_KEY.split(' ')[1]} root@nas (ED25519)` }));
				const schedule = await api('PUT', '/api/admin/backup', { user: chief, body: { schedule: 'daily' } });

				expect([again.status, schedule.status]).toEqual([200, 200]);
				expect(keyLines()).toEqual([]);
			});

			it.each([
				['changed', { hostKey: OTHER_HOST_KEY }],
				['emptied', { hostKey: '' }],
				['not sent', { hostKey: undefined }]
			])('writes no line when a confirmed key %s with the password masked is refused (card 2267)', async (_case, change) => {
				store([{ ...NAS, hostKey: HOST_KEY }]);
				const before = snapshotDb();

				const saved = await put([(await withNas(change))[0]]);

				expect(saved.status).toBe(400);
				expect(keyLines()).toEqual([]);
				expectUnchanged(before);
			});

			it('writes no line for a key change whose save fails after the line was due: the line waits for the commit (card 2267)', async () => {
				sqlite.exec(
					"CREATE TEMP TRIGGER backup_config_frozen BEFORE UPDATE ON settings WHEN NEW.key = 'backup_config' BEGIN SELECT RAISE(ABORT, 'frozen'); END;" +
						"CREATE TEMP TRIGGER backup_config_frozen_insert BEFORE INSERT ON settings WHEN NEW.key = 'backup_config' BEGIN SELECT RAISE(ABORT, 'frozen'); END;"
				);
				try {
					await expect(put(await withNas({ hostKey: HOST_KEY }))).rejects.toThrow('frozen');
				} finally {
					sqlite.exec('DROP TRIGGER backup_config_frozen; DROP TRIGGER backup_config_frozen_insert;');
				}

				expect(storedDestinations()[0]).toEqual(NAS);
				expect(keyLines()).toEqual([]);
			});

			it('writes the name of a destination holding a line break on one line (card 2267)', async () => {
				const named = { ...NAS, name: 'N\nAS', password: 'typed', privateKey: '', hostKey: HOST_KEY };

				const saved = await put([named]);

				expect(saved.status, JSON.stringify(saved.body)).toBe(200);
				const [only, ...rest] = keyLines();
				expect(rest).toEqual([]);
				expect(only.message).toBe(`SFTP host key of destination "N AS" at nas.example.test:22 added: ${HOST_KEY}`);
				expect(only.message).not.toMatch(/[\r\n]/);
			});
		});
	});

	describe('hostKeyChanges, the SFTP host keys a save adds, changes or removes (card 2267)', () => {
		const sftp = (name: string, hostKey: unknown, more: Record<string, unknown> = {}) => ({ ...NAS, name, hostKey, ...more });
		const RSA_SAME = `ssh-rsa ${HOST_KEY.split(' ')[1]}`;

		it('reads a stored key that does not read as none', () => {
			expect(hostKeyChanges([sftp('NAS', 'not a key')], [sftp('NAS', HOST_KEY)])).toEqual([
				{ name: 'NAS', host: 'nas.example.test', port: 22, from: '', to: HOST_KEY, removed: false }
			]);
			expect(hostKeyChanges([sftp('NAS', 'not a key')], [sftp('NAS', '')])).toEqual([]);
		});

		it('never names an S3, Google Drive or OneDrive destination', () => {
			const others = STORED.slice(1);
			expect(hostKeyChanges(others, [])).toEqual([]);
			expect(hostKeyChanges([], others)).toEqual([]);
			expect(hostKeyChanges(others, others.map((d) => ({ ...d, hostKey: HOST_KEY })))).toEqual([]);
		});

		it('matches stored and saved destinations one to one: a key on one of two stored under a name, left out, is removed (the card 2270 review)', () => {
			const other = { host: 'other.example.test' };

			expect(hostKeyChanges([sftp('NAS', HOST_KEY), sftp('NAS', OTHER_HOST_KEY, other)], [sftp('NAS', HOST_KEY)])).toEqual([
				{ name: 'NAS', host: 'other.example.test', port: 22, from: OTHER_HOST_KEY, to: '', removed: true }
			]);
			expect(hostKeyChanges([sftp('NAS', HOST_KEY)], [sftp('NAS', HOST_KEY), sftp('NAS', OTHER_HOST_KEY, other)])).toEqual([
				{ name: 'NAS', host: 'other.example.test', port: 22, from: '', to: OTHER_HOST_KEY, removed: false }
			]);
		});

		it('counts a change of type with the same fingerprint as a change (decision 3)', () => {
			expect(hostKeyChanges([sftp('NAS', HOST_KEY)], [sftp('NAS', RSA_SAME)])).toEqual([
				{ name: 'NAS', host: 'nas.example.test', port: 22, from: HOST_KEY, to: RSA_SAME, removed: false }
			]);
		});

		it('gives one entry per destination changed, with the host and port it is saved with, or was stored with when it is gone', () => {
			const before = [sftp('NAS', HOST_KEY), sftp('Old', OTHER_HOST_KEY, { host: 'old.example.test', port: 2222 }), sftp('Same', HOST_KEY)];
			const after = [sftp('NAS', OTHER_HOST_KEY, { host: 'moved.example.test', port: 0 }), sftp('Same', HOST_KEY), sftp('New', HOST_KEY)];

			expect(hostKeyChanges(before, after)).toEqual([
				{ name: 'NAS', host: 'moved.example.test', port: 22, from: HOST_KEY, to: OTHER_HOST_KEY, removed: false, fromAt: 'nas.example.test:22' },
				{ name: 'New', host: 'nas.example.test', port: 22, from: '', to: HOST_KEY, removed: false },
				{ name: 'Old', host: 'old.example.test', port: 2222, from: OTHER_HOST_KEY, to: '', removed: true }
			]);
		});

		it('names where a changed or cleared key was only when the destination moved, and never for a key added (the card 2267 review)', () => {
			const moved = { host: 'moved.example.test', port: 2222 };
			const changes = hostKeyChanges(
				[sftp('Changed', HOST_KEY), sftp('Cleared', HOST_KEY), sftp('Added', ''), sftp('Stayed', HOST_KEY, { port: 22 })],
				[sftp('Changed', OTHER_HOST_KEY, moved), sftp('Cleared', '', moved), sftp('Added', HOST_KEY, moved), sftp('Stayed', OTHER_HOST_KEY, { port: '22' })]
			);

			expect(changes.map((change) => [change.name, change.fromAt])).toEqual([
				['Changed', 'nas.example.test:22'],
				['Cleared', 'nas.example.test:22'],
				['Added', undefined],
				['Stayed', undefined]
			]);
			expect(changes.filter((change) => 'fromAt' in change).map((change) => change.name)).toEqual(['Changed', 'Cleared']);
		});

		it('ignores what is not a destination, and a destination with no key either side', () => {
			expect(hostKeyChanges([null, 'NAS', sftp('A', '')], [7, [], sftp('A', undefined), sftp('B', '')])).toEqual([]);
		});
	});

	describe('the line a save writes naming what it changed in the backup settings (card 2270)', () => {
		// The tests keep ERROR and above; most of these lines are INFO.
		let level: string | undefined;
		beforeEach(() => {
			level = process.env.LOG_LEVEL;
			process.env.LOG_LEVEL = 'INFO';
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'warn').mockImplementation(() => {});
		});
		afterEach(() => {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		});

		/** The lines a save of the backup settings writes (card 2270), oldest first. */
		const settingsLines = () =>
			(
				sqlite
					.prepare("SELECT level, context, message, meta, user_id FROM system_logs WHERE message LIKE 'Backup settings changed:%' ORDER BY id")
					.all() as { level: string; context: string; message: string; meta: string | null; user_id: number | null }[]
			).map((row) => ({ ...row, meta: row.meta === null ? null : JSON.parse(row.meta) }));
		const NONE = { settings: [], added: [], removed: [], changed: [] };
		const line = (level: 'INFO' | 'WARN', words: string, meta: Record<string, unknown>) => ({
			level,
			context: 'BACKUP',
			message: `Backup settings changed: ${words}`,
			meta: { ...NONE, ...meta },
			user_id: chief.id
		});
		const putSettings = (body: Record<string, unknown>) => api('PUT', '/api/admin/backup', { user: chief, body });
		/** STORED, with the settings beside the destinations changed by `more`. */
		const storeWith = (more: Record<string, unknown>) =>
			sqlite
				.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
				.run('backup_config', JSON.stringify({ ...JSON.parse(configWith(STORED)), ...more }));
		const OFFSITE = { type: 'sftp', name: 'Offsite', host: 'offsite.example.test', port: 2222, username: 'copy', password: 'offsite-password', privateKey: '', remotePath: '/copies' };

		it('writes one INFO line under BACKUP, filed under the account, naming a destination added (card 2270)', async () => {
			const saved = await put([...(await shown()), OFFSITE]);

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(settingsLines()).toEqual([line('INFO', 'destination "Offsite" added (sftp)', { added: [{ name: 'Offsite', type: 'sftp' }] })]);
			expect(JSON.stringify(settingsLines())).not.toContain('offsite-password');
		});

		it('names the fields of a destination changed, a secret typed again among them, and never a value (card 2270, decision 4)', async () => {
			const saved = await put(
				(await shown()).map((d, i) => (i === 0 ? { ...d, host: 'moved.example.test', port: 2222, password: 'typed-again', privateKey: '' } : d))
			);

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			// The host and port say where the copies go (SAME_IN): they now go elsewhere, a WARN (the review's ruling 2).
			expect(settingsLines()).toEqual([
				line('WARN', 'destination "NAS" changed: host, port, password, privateKey', {
					changed: [{ name: 'NAS', fields: ['host', 'port', 'password', 'privateKey'], elsewhere: true }]
				})
			]);
			const text = JSON.stringify(settingsLines());
			for (const value of ['moved.example.test', '2222', 'typed-again', SECRETS.sftpPassword, SECRETS.sftpKey]) expect(text.includes(value), value).toBe(false);
		});

		it('writes a WARN line for a destination left out of the list (card 2270, decision 1)', async () => {
			const saved = await put((await shown()).filter((d) => d.name !== 'Bucket'));

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(settingsLines()).toEqual([line('WARN', 'destination "Bucket" removed (s3)', { removed: [{ name: 'Bucket', type: 's3' }] })]);
		});

		it('writes a destination saved as another type under its name as removed and added, at WARN (card 2270, decision 4)', async () => {
			const saved = await put((await shown()).map((d) => (d.name === 'Bucket' ? { ...NAS, name: 'Bucket', password: 'typed', privateKey: '' } : d)));

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(settingsLines()).toEqual([
				line('WARN', 'destination "Bucket" added (sftp); destination "Bucket" removed (s3)', {
					added: [{ name: 'Bucket', type: 'sftp' }],
					removed: [{ name: 'Bucket', type: 's3' }]
				})
			]);
		});

		it('writes a WARN line for the schedule switched off (card 2270, decision 1)', async () => {
			storeWith({ schedule: 'daily' });

			const saved = await putSettings({ schedule: 'disabled' });

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(settingsLines()).toEqual([line('WARN', 'schedule from daily to disabled', { settings: [{ field: 'schedule', from: 'daily', to: 'disabled' }] })]);
		});

		it('writes one INFO line naming each setting changed with its values, and the failure mail address by name alone (card 2270, decision 4)', async () => {
			const saved = await putSettings({ schedule: 'weekly', scheduleTime: '03:30', scheduleDay: 5, retention: 10, notifyOnFailure: true, notifyEmail: 'ops@example.test' });

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(settingsLines()).toEqual([
				line('INFO', 'schedule from disabled to weekly; scheduleTime from 02:00 to 03:30; scheduleDay from 0 to 5; retention from 7 to 10; notifyOnFailure from false to true; notifyEmail', {
					settings: [
						{ field: 'schedule', from: 'disabled', to: 'weekly' },
						{ field: 'scheduleTime', from: '02:00', to: '03:30' },
						{ field: 'scheduleDay', from: 0, to: 5 },
						{ field: 'retention', from: 7, to: 10 },
						{ field: 'notifyOnFailure', from: false, to: true },
						{ field: 'notifyEmail' }
					]
				})
			]);
			expect(JSON.stringify(settingsLines())).not.toContain('ops@example.test');
		});

		it('writes a WARN line for the retention lowered: the next run deletes the older copies (card 2270, decision 1)', async () => {
			// The schedule stored is disabled, so the time the copies cover is none either way; a Run Now still keeps to the retention.
			const saved = await putSettings({ retention: 3 });

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(settingsLines()).toEqual([line('WARN', 'retention from 7 to 3', { settings: [{ field: 'retention', from: 7, to: 3 }] })]);
		});

		it('writes a WARN line for a schedule more frequent with the retention kept: the copies kept cover less time (the review, ruling 2)', async () => {
			storeWith({ schedule: 'weekly' });

			const saved = await putSettings({ schedule: 'hourly' });

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(settingsLines()).toEqual([line('WARN', 'schedule from weekly to hourly', { settings: [{ field: 'schedule', from: 'weekly', to: 'hourly' }] })]);
		});

		it('writes an INFO line for a schedule less frequent: the copies kept cover more time (the review, ruling 2)', async () => {
			storeWith({ schedule: 'hourly' });

			const saved = await putSettings({ schedule: 'daily' });

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(settingsLines()).toEqual([line('INFO', 'schedule from hourly to daily', { settings: [{ field: 'schedule', from: 'hourly', to: 'daily' }] })]);
		});

		it("writes a WARN line for a kept destination's port changed, which says where the copies go, and an INFO one for its password alone (the review, ruling 2)", async () => {
			const moved = await put((await shown()).map((d, i) => (i === 0 ? { ...d, port: 2200, password: 'typed-again', privateKey: '' } : d)));
			const retyped = await put((await shown()).map((d, i) => (i === 0 ? { ...d, password: 'typed-once-more' } : d)));

			expect([moved.status, retyped.status], JSON.stringify([moved.body, retyped.body])).toEqual([200, 200]);
			expect(settingsLines()).toEqual([
				line('WARN', 'destination "NAS" changed: port, password, privateKey', {
					changed: [{ name: 'NAS', fields: ['port', 'password', 'privateKey'], elsewhere: true }]
				}),
				line('INFO', 'destination "NAS" changed: password', { changed: [{ name: 'NAS', fields: ['password'] }] })
			]);
		});

		it('writes a WARN line naming a destination removed where two were stored under its name and the save keeps one (the review, ruling 1)', async () => {
			storeWith({ destinations: [NAS, { ...NAS, host: 'other.example.test' }] });

			const saved = await put([NAS]);

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(settingsLines()).toEqual([line('WARN', 'destination "NAS" removed (sftp)', { removed: [{ name: 'NAS', type: 'sftp' }] })]);
		});

		it("writes card 2267's key line for the host key of one of two stored under a name that the save leaves out (the card 2270 review)", async () => {
			storeWith({ destinations: [{ ...NAS, hostKey: HOST_KEY }, { ...NAS, host: 'other.example.test', hostKey: OTHER_HOST_KEY }] });

			const saved = await put([{ ...NAS, hostKey: HOST_KEY }]);

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'BACKUP' ORDER BY id").all()).toEqual([
				{ level: 'WARN', message: 'Backup settings changed: destination "NAS" removed (sftp)' },
				{ level: 'WARN', message: `SFTP host key of destination "NAS" at other.example.test:22 removed with the destination: was ${OTHER_HOST_KEY}` }
			]);
		});

		it('writes no line for a retention and day stored as text and sent as the same numbers (the review, ruling 5)', async () => {
			storeWith({ retention: '7', scheduleDay: '3' });

			const saved = await putSettings({ retention: 7, scheduleDay: 3 });

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(settingsLines()).toEqual([]);
		});

		it("escapes a quotation mark in a destination's name in this line and in card 2267's, so the name cannot end early (the review, ruling 3)", async () => {
			const saved = await put([...(await shown()), { ...OFFSITE, name: 'Off"site\\', hostKey: HOST_KEY }]);

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'BACKUP' ORDER BY id").all()).toEqual([
				{ level: 'INFO', message: 'Backup settings changed: destination "Off\\"site\\\\" added (sftp)' },
				{ level: 'WARN', message: `SFTP host key of destination "Off\\"site\\\\" at offsite.example.test:2222 added: ${HOST_KEY}` }
			]);
		});

		it("names a host key confirmed as a field changed, with no key in it, before card 2267's line that holds the key (card 2270, decision 3)", async () => {
			const saved = await put((await shown()).map((d, i) => (i === 0 ? { ...d, hostKey: HOST_KEY } : d)));

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'BACKUP' ORDER BY id").all()).toEqual([
				{ level: 'INFO', message: 'Backup settings changed: destination "NAS" changed: hostKey' },
				{ level: 'WARN', message: `SFTP host key of destination "NAS" at nas.example.test:22 added: ${HOST_KEY}` }
			]);
			expect(JSON.stringify(settingsLines())).not.toContain('SHA256');
		});

		it('writes no line for a save that changes nothing: the list sent back as shown, and settings sent as they are (card 2270, decision 5)', async () => {
			const again = await put(await shown());
			const same = await putSettings({ schedule: 'disabled', retention: 7, notifyEmail: '' });

			expect([again.status, same.status], JSON.stringify([again.body, same.body])).toEqual([200, 200]);
			expect(settingsLines()).toEqual([]);
		});

		it('writes no line for a save refused: a masked secret sent with its host changed (card 2270)', async () => {
			const before = snapshotDb();

			const saved = await put((await shown()).map((d, i) => (i === 0 ? { ...d, host: 'moved.example.test' } : d)));

			expect(saved.status).toBe(400);
			expect(settingsLines()).toEqual([]);
			expectUnchanged(before);
		});

		it('writes no line for a change whose save fails after the line was due: the line waits for the commit (card 2270)', async () => {
			sqlite.exec(
				"CREATE TEMP TRIGGER backup_config_frozen BEFORE UPDATE ON settings WHEN NEW.key = 'backup_config' BEGIN SELECT RAISE(ABORT, 'frozen'); END;" +
					"CREATE TEMP TRIGGER backup_config_frozen_insert BEFORE INSERT ON settings WHEN NEW.key = 'backup_config' BEGIN SELECT RAISE(ABORT, 'frozen'); END;"
			);
			try {
				await expect(putSettings({ retention: 3 })).rejects.toThrow('frozen');
			} finally {
				sqlite.exec('DROP TRIGGER backup_config_frozen; DROP TRIGGER backup_config_frozen_insert;');
			}

			expect(JSON.parse(settingsOf(sqlite)['backup_config']).retention).toBe(7);
			expect(settingsLines()).toEqual([]);
		});
	});

	describe('settingsChanges, what a save of the backup settings changes (card 2270)', () => {
		const settings = (destinations: unknown[], more: Record<string, unknown> = {}) => ({ ...JSON.parse(configWith(destinations)), ...more });
		const RSA_SAME = `ssh-rsa ${HOST_KEY.split(' ')[1]}`;

		it('is null for the same settings, for the destinations in another order, and for each default as it is used (decision 4)', () => {
			expect(settingsChanges(settings(STORED), settings(STORED))).toBeNull();
			expect(settingsChanges(settings(STORED), settings([...STORED].reverse()))).toBeNull();
			expect(
				settingsChanges(
					settings([{ ...NAS, port: null, hostKey: '' }, BUCKET, { ...ONEDRIVE, folderPath: 'DumpFire Backups' }]),
					settings([
						{ ...NAS, port: 22, host: ' NAS.Example.TEST\t', hostKey: undefined },
						{ ...BUCKET, endpoint: '', prefix: 'dumpfire/' },
						{ ...ONEDRIVE, folderPath: '/DumpFire Backups/' }
					])
				)
			).toBeNull();
			expect(settingsChanges(settings([{ ...BUCKET, region: '' }]), settings([{ ...BUCKET, region: 'us-east-1' }]))).toBeNull();
		});

		it('names each field changed, a secret by name alone, and a host key whose type changed (decision 3)', () => {
			const changes = settingsChanges(
				settings([{ ...NAS, hostKey: HOST_KEY }, BUCKET, STORED[2]]),
				settings([
					{ ...NAS, password: 'new-password', hostKey: RSA_SAME },
					{ ...BUCKET, prefix: 'other/', secretAccessKey: 'new-secret' },
					{ ...DRIVE, refreshToken: '' }
				])
			);

			expect(changes).toEqual({
				settings: [],
				added: [],
				removed: [],
				changed: [
					{ name: 'NAS', fields: ['password', 'hostKey'] },
					{ name: 'Bucket', fields: ['secretAccessKey', 'prefix'], elsewhere: true },
					{ name: 'Drive', fields: ['refreshToken', 'grantedScope'] }
				]
			});
			const text = JSON.stringify(changes);
			for (const value of ['new-password', 'new-secret', 'other/', 'SHA256']) expect(text.includes(value), value).toBe(false);
		});

		it('gives a destination added, removed, or saved as another type under its name, with its type', () => {
			expect(settingsChanges(settings([NAS, BUCKET]), settings([{ ...ROBOT, name: 'NAS' }, ONEDRIVE]))).toEqual({
				settings: [],
				added: [
					{ name: 'NAS', type: 'gdrive' },
					{ name: 'OneDrive', type: 'onedrive' }
				],
				removed: [
					{ name: 'NAS', type: 'sftp' },
					{ name: 'Bucket', type: 's3' }
				],
				changed: []
			});
		});

		it('gives each setting changed with its values, but the failure mail address without them', () => {
			expect(settingsChanges(settings([]), settings([], { schedule: 'hourly', notifyEmail: 'ops@example.test', notifyOnFailure: true }))).toEqual({
				settings: [
					{ field: 'schedule', from: 'disabled', to: 'hourly' },
					{ field: 'notifyOnFailure', from: false, to: true },
					{ field: 'notifyEmail' }
				],
				added: [],
				removed: [],
				changed: []
			});
		});

		it('matches stored and saved destinations one to one: each stored entry left over is removed (the review, ruling 1)', () => {
			const other = { ...NAS, host: 'other.example.test' };

			expect(settingsChanges(settings([NAS, other]), settings([NAS]))).toEqual({
				settings: [],
				added: [],
				removed: [{ name: 'NAS', type: 'sftp' }],
				changed: []
			});
			expect(settingsChanges(settings([NAS]), settings([NAS, other]))).toEqual({
				settings: [],
				added: [{ name: 'NAS', type: 'sftp' }],
				removed: [],
				changed: []
			});
		});

		it('compares the retention and the day as numbers: text stored is the same number sent (the review, ruling 5)', () => {
			expect(settingsChanges(settings([], { retention: '7', scheduleDay: '3' }), settings([], { retention: 7, scheduleDay: 3 }))).toBeNull();
			expect(settingsChanges(settings([], { retention: '7' }), settings([], { retention: 8 }))?.settings).toEqual([{ field: 'retention', from: '7', to: 8 }]);
		});

		it('marks a destination changed in a field that says where its copies go, its account included, and no other (the review, ruling 2)', () => {
			const otherAccount = { ...ROBOT, serviceAccountJson: serviceAccountJson(SECRETS.serviceAccountKey).replace('robot@', 'someone@') };

			expect(
				settingsChanges(
					settings([NAS, ROBOT, ONEDRIVE]),
					settings([{ ...NAS, username: 'other' }, otherAccount, { ...ONEDRIVE, clientSecret: 'new' }])
				)?.changed
			).toEqual([
				{ name: 'NAS', fields: ['username'], elsewhere: true },
				{ name: 'Robot', fields: ['serviceAccountJson'], elsewhere: true },
				{ name: 'OneDrive', fields: ['clientSecret'] }
			]);
		});

		it('ignores what is not a destination, or has no name', () => {
			expect(settingsChanges(settings([null, 'NAS', 7]), settings([[], { type: 'sftp', name: 5 }]))).toBeNull();
		});
	});

	it('keeps the recorded scope with a kept refresh token whatever is sent, and drops it with a token sent empty (test 8)', async () => {
		const drive = (await shown())[2];

		const kept = await put([{ ...drive, grantedScope: 'anything' }]);
		expect(kept.status, JSON.stringify(kept.body)).toBe(200);
		expect(storedDestinations()).toEqual([STORED[2]]);

		const emptied = await put([{ ...drive, refreshToken: '', grantedScope: DRIVE_FILE_SCOPE }]);
		expect(emptied.status, JSON.stringify(emptied.body)).toBe(200);
		expect(storedDestinations()).toEqual([{ ...DRIVE, refreshToken: '' }]);
	});
});

// ─── Google Drive asks for its own files (card 2188) ─────────────────────────

describe('Google Drive asks only for the files DumpFire makes (card 2188)', () => {
	const WIDE = 'https://www.googleapis.com/auth/drive';
	const FOLDER_TYPE = 'application/vnd.google-apps.folder';
	const G = { type: 'gdrive', name: 'G', authMethod: 'oauth', clientId: 'g-client.apps.example.test', clientSecret: 'g-client-secret-2188', folderId: '' };

	/** Decision 8's words, as R2 has them begin for a connection made before card 2188. */
	const cannotReach = (wide: boolean) =>
		'Google gave DumpFire access only to the files it makes, and it cannot reach the folder this destination names, so no backup ' +
		'could be written there. Nothing was changed: the destination keeps the connection it had. ' +
		(wide
			? "To use a folder DumpFire makes itself, first remove DumpFire's access in the Google account (Google Account, Security, " +
				'Your connections to third-party apps and services), then have the superadmin remove this destination, add it again with ' +
				'the Folder ID left empty, and connect it.'
			: 'To use a folder DumpFire makes itself, have the superadmin remove this destination, then add it again with the Folder ID ' +
				'left empty, and connect it.');
	const CHANGED_MEANWHILE = 'The destination was changed or removed while it was being connected, so the connection was not saved. Connect it again.';

	/** Drive, stood in for: what `files.get`, `files.create`, `files.delete` and `files.list` were asked, and answer. */
	const files = { get: vi.fn(), create: vi.fn(), delete: vi.fn(), list: vi.fn() };

	const store = (...destinations: unknown[]) =>
		sqlite.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('backup_config', configWith(destinations));
	const storedG = () => JSON.parse(settingsOf(sqlite)['backup_config']).destinations[0];
	const today = () => new Date().toISOString().slice(0, 10);

	/** Google's code exchange, stood in for: it answers `tokens`, after `meanwhile` has run. */
	const exchange = (tokens: Record<string, unknown>, meanwhile?: () => Promise<unknown>) =>
		vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockImplementation((async () => {
			await meanwhile?.();
			return { tokens, res: null };
		}) as never);
	/** Connect's first half, as the page asks it: the consent address, read. */
	const begin = async (opts: { user?: SessionUser; credential?: Credential | null; dest?: string } = {}) => {
		const res = await api('GET', `/api/admin/backup/gdrive/auth?dest=${opts.dest ?? 'G'}`, {
			user: opts.user ?? chief,
			...('credential' in opts ? { credential: opts.credential } : {})
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		return { res, address: new URL(res.body.authUrl), state: new URL(res.body.authUrl).searchParams.get('state') };
	};
	/** Its second half: the code and the state from the address Google's page leads to (card 2251). */
	const finish = (state: unknown, opts: { user?: SessionUser; credential?: Credential | null; destName?: string } = {}) =>
		api('POST', '/api/admin/backup/gdrive/auth', {
			user: opts.user ?? chief,
			...('credential' in opts ? { credential: opts.credential } : {}),
			body: { code: 'the-code', ...(state === undefined ? {} : { state }), destName: opts.destName ?? 'G' }
		});
	/** Both halves, as one superadmin in one session. */
	const connect = async () => finish((await begin()).state);

	/** A folder `files.get` finds, and one it does not. */
	const found = (id: string, more: Record<string, unknown> = {}) => ({ data: { id, name: 'Backups', mimeType: FOLDER_TYPE, trashed: false, ...more } });
	const notFound = () => Object.assign(new Error('File not found: gone.'), { code: 404 });

	beforeEach(() => {
		for (const fn of Object.values(files)) fn.mockReset();
		files.create.mockResolvedValue({ data: { id: 'made-folder-1' } });
		files.delete.mockResolvedValue({ data: {} });
		files.list.mockResolvedValue({ data: { files: [] } });
		vi.spyOn(google, 'drive').mockReturnValue({ files } as never);
	});

	it('asks Google for drive.file alone, and not for what was granted before (test 9)', async () => {
		store(G);

		const res = await api('GET', '/api/admin/backup/gdrive/auth?dest=G', { user: chief });

		expect(res.status).toBe(200);
		const address = new URL(res.body.authUrl);
		expect(address.searchParams.get('scope')).toBe(DRIVE_FILE_SCOPE);
		expect(address.searchParams.get('include_granted_scopes')).not.toBe('true');
	});

	it.each([
		[DRIVE_FILE_SCOPE, true],
		[`  ${DRIVE_FILE_SCOPE}  `, true],
		[WIDE, false],
		[`${WIDE} ${DRIVE_FILE_SCOPE}`, false],
		[`${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive.readonly`, false],
		['', false],
		[undefined, false],
		[null, false]
	])('reads a recorded scope of %j as reaching only DumpFire’s files: %s (test 9b, R6)', (scope, narrow) => {
		expect(driveScopeIsNarrow(scope)).toBe(narrow);
	});

	it('makes a folder of its own when the Folder ID is empty, and saves it with the token and the scope granted (test 10)', async () => {
		store(G);
		exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });

		const res = await connect();

		expect(res.body).toEqual({
			success: true,
			message: `Google Drive connected. DumpFire made the folder "DumpFire backups (made ${today()})" in this account's My Drive, and backs up there.`
		});
		expect(files.create).toHaveBeenCalledTimes(1);
		expect(files.create.mock.calls[0][0]).toMatchObject({ requestBody: { name: `DumpFire backups (made ${today()})`, mimeType: FOLDER_TYPE } });
		expect(files.get).not.toHaveBeenCalled();
		expect(storedG()).toEqual({ ...G, refreshToken: 'rt-new', grantedScope: DRIVE_FILE_SCOPE, folderId: 'made-folder-1' });
	});

	it('makes no folder and writes nothing when Google gives no refresh token (test 10b, R5)', async () => {
		store(G);
		exchange({ access_token: 'only-this' });
		const before = snapshotDb();

		const res = await connect();

		expect(res.body.success).toBe(false);
		expect(res.body.message).toMatch(/^No refresh token received/);
		expect(files.create).not.toHaveBeenCalled();
		expect(files.get).not.toHaveBeenCalled();
		expectUnchanged(before);
	});

	it('checks a Folder ID it is given, and saves the token and its scope, or no scope when Google names none (test 11, R6)', async () => {
		store({ ...G, folderId: 'hand-made', refreshToken: 'rt-old', grantedScope: WIDE });
		files.get.mockResolvedValue(found('hand-made'));
		exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });

		const res = await connect();

		expect(res.body).toEqual({ success: true, message: 'Google Drive connected successfully!' });
		expect(files.get.mock.calls[0][0]).toMatchObject({ fileId: 'hand-made' });
		expect(files.create).not.toHaveBeenCalled();
		expect(storedG()).toEqual({ ...G, folderId: 'hand-made', refreshToken: 'rt-new', grantedScope: DRIVE_FILE_SCOPE });

		// Google names no scope: none is recorded, not the one asked for.
		exchange({ refresh_token: 'rt-newer' });
		expect((await connect()).body.success).toBe(true);
		expect(storedG()).toEqual({ ...G, folderId: 'hand-made', refreshToken: 'rt-newer' });
	});

	it.each([
		['Google does not find it', () => files.get.mockRejectedValue(notFound())],
		['it is not a folder', () => files.get.mockResolvedValue(found('gone', { mimeType: 'application/x-sqlite3' }))],
		['it is in the trash', () => files.get.mockResolvedValue(found('gone', { trashed: true }))]
	])('refuses a Folder ID it cannot reach, %s, and keeps the connection it had (test 12, N4)', async (_case, answer) => {
		store({ ...G, folderId: 'gone', refreshToken: 'rt-old', grantedScope: DRIVE_FILE_SCOPE });
		answer();
		exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });
		const before = snapshotDb();

		const res = await connect();

		expect(res.body).toEqual({ success: false, message: cannotReach(false) });
		expect(files.create).not.toHaveBeenCalled();
		expectUnchanged(before);
	});

	it('tells a destination connected before card 2188 to remove DumpFire’s access in the Google account first (test 12, R2)', async () => {
		store({ ...G, folderId: 'hand-made', refreshToken: 'rt-old' });
		files.get.mockRejectedValue(notFound());
		exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });
		const before = snapshotDb();

		const res = await connect();

		expect(res.body).toEqual({ success: false, message: cannotReach(true) });
		expectUnchanged(before);
	});

	it('saves nothing when the destination is changed while Google answers, and removes the folder it made (test 13, R5)', async () => {
		store(G);
		// A save of the settings lands while Google is answering.
		exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE }, () =>
			api('PUT', '/api/admin/backup', { user: chief, body: { destinations: [{ ...G, folderId: 'chosen-meanwhile' }] } })
		);

		const res = await connect();

		expect(res.body).toEqual({ success: false, message: CHANGED_MEANWHILE });
		expect(storedG()).toEqual({ ...G, folderId: 'chosen-meanwhile' });
		expect(files.delete).toHaveBeenCalledTimes(1);
		expect(files.delete.mock.calls[0][0]).toMatchObject({ fileId: 'made-folder-1' });
	});

	it.each([
		['OAuth', { ...G, folderId: 'gone', refreshToken: 'rt' }],
		['a service account', { type: 'gdrive', name: 'G', authMethod: 'service_account', serviceAccountJson: serviceAccountJson('k'), folderId: 'gone' }]
	])('Test says when it cannot reach the folder, signed in with %s, and lists one it can (test 14)', async (_case, config) => {
		files.get.mockRejectedValue(notFound());

		const unreachable = await new GDriveDestination(config as GDriveDestinationConfig).test();

		expect(unreachable.success).toBe(false);
		expect(unreachable.message).toContain('"gone"');
		expect(files.list).not.toHaveBeenCalled();

		files.get.mockReset().mockResolvedValue(found('gone'));
		expect(await new GDriveDestination(config as GDriveDestinationConfig).test()).toEqual({
			success: true,
			message: 'Connected to Google Drive folder (0 existing files)'
		});
	});

	describe('Connect is taken only from the session that started it: a state used once, and PKCE (card 2251)', () => {
		/** Decision 7's one sentence, for every failed state check. */
		const NOT_STARTED_HERE =
			'This connection was not started from this session, or has expired or been used. ' +
			"Press Connect again, and paste the whole address Google's page leads to.";
		const WARNED = 'WARN GDRIVE Google Drive Connect refused for destination "G": its state was not one this session started, or had expired or been used';
		const H = { ...G, name: 'H', clientId: 'h-client.apps.example.test' };
		/**
		 * Two sessions of the one superadmin, as the gate keeps each (decision 2).
		 * Open ones: the Connect asks again, once its body is in, whether the
		 * session is still open (card 2253).
		 */
		let LAPTOP: Credential;
		let PHONE: Credential;
		const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
		/** A second superadmin, made before anything is snapshotted. */
		let deputy: SessionUser;
		beforeEach(() => {
			deputy = makeUser({ username: 'deputy', role: 'superadmin' });
			LAPTOP = { kind: 'session', token: makeSession(chief) };
			PHONE = { kind: 'session', token: makeSession(chief) };
		});

		/** What `run` answers, and the lines at WARN and above written meanwhile: the tests keep ERROR and above otherwise. */
		const warnedIn = async <T>(run: () => Promise<T>) => {
			const level = process.env.LOG_LEVEL;
			process.env.LOG_LEVEL = 'WARN';
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const from = (sqlite.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM system_logs').get() as { id: number }).id;
			try {
				const result = await run();
				const lines = column<string>(sqlite, `SELECT level || ' ' || context || ' ' || message FROM system_logs WHERE id > ${from} ORDER BY id`);
				/** The account each line is filed under, and its meta. */
				const filed = (sqlite.prepare(`SELECT user_id AS userId, meta FROM system_logs WHERE id > ${from} ORDER BY id`).all() as {
					userId: number | null;
					meta: string | null;
				}[]).map((line) => ({ userId: line.userId, meta: line.meta === null ? null : JSON.parse(line.meta) }));
				return { result, lines, filed };
			} finally {
				if (level === undefined) delete process.env.LOG_LEVEL;
				else process.env.LOG_LEVEL = level;
			}
		};

		it('answers a new random state at every GET, never the destination’s name, with an S256 challenge, not to be kept (decisions 1, 3, 8)', async () => {
			store(G);

			const first = await begin();
			const second = await begin();

			for (const { address, state } of [first, second]) {
				expect(state).toMatch(BASE64URL_32_BYTES);
				expect(state).not.toBe('G');
				expect(address.searchParams.get('code_challenge')).toMatch(BASE64URL_32_BYTES);
				expect(address.searchParams.get('code_challenge_method')).toBe('S256');
			}
			expect(first.state).not.toBe(second.state);
			expect(first.address.searchParams.get('code_challenge')).not.toBe(second.address.searchParams.get('code_challenge'));
			expect(first.res.headers.get('cache-control')).toBe('no-store');
		});

		it('hands Google the code with the verifier whose SHA-256 is the address’s challenge (decision 3)', async () => {
			store(G);
			const exchanged = exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });
			const { address, state } = await begin();

			const res = await finish(state);

			expect(res.body.success, JSON.stringify(res.body)).toBe(true);
			expect(exchanged).toHaveBeenCalledTimes(1);
			const handed = (exchanged.mock.calls[0] as unknown[])[0] as { code: string; codeVerifier: string };
			expect(Object.keys(handed).sort()).toEqual(['code', 'codeVerifier']);
			expect(handed.code).toBe('the-code');
			expect(handed.codeVerifier).toMatch(BASE64URL_32_BYTES);
			expect(createHash('sha256').update(handed.codeVerifier).digest('base64url')).toBe(address.searchParams.get('code_challenge'));
		});

		it.each([
			['no state', false, async () => (await begin(), finish(undefined))],
			['an empty state', false, async () => (await begin(), finish(''))],
			['a state it never gave', true, async () => (await begin(), finish('A'.repeat(43)))],
			['the destination’s name, the state it once gave', true, async () => (await begin(), finish('G'))],
			['a state another session of the same superadmin started', true, async () => finish((await begin({ credential: LAPTOP })).state, { credential: PHONE })],
			['a state another superadmin started', true, async () => finish((await begin({ user: deputy })).state)],
			['a state started for another destination', true, async () => finish((await begin({ dest: 'H' })).state)]
		])('refuses %s: 400 in one sentence, nothing exchanged or written, one WARN line under the account (decisions 2, 7)', async (_case, stateSent, present) => {
			store(G, H);
			const exchanged = exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });
			const before = snapshotDb();

			const { result: res, lines, filed } = await warnedIn(present);

			expect(res.status, JSON.stringify(res.body)).toBe(400);
			expect(res.body).toEqual({ message: NOT_STARTED_HERE });
			expect(exchanged).not.toHaveBeenCalled();
			expect(files.create).not.toHaveBeenCalled();
			expectUnchanged(before);
			expect(lines).toEqual([WARNED]);
			// Filed under the superadmin who pasted, telling no state from a failed one (review O3).
			expect(filed).toEqual([{ userId: chief.id, meta: { stateSent } }]);
		});

		it('refuses a state presented a second time, whether the first time was refused or taken (decision 4)', async () => {
			store(G, H);
			exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });

			// Refused the first time, for another destination: spent all the same.
			const refused = await begin();
			expect((await finish(refused.state, { destName: 'H' })).status).toBe(400);
			const again = await finish(refused.state);
			expect(again.status).toBe(400);
			expect(again.body).toEqual({ message: NOT_STARTED_HERE });

			// Taken the first time.
			const taken = await begin();
			expect((await finish(taken.state)).body.success).toBe(true);
			const twice = await finish(taken.state);
			expect(twice.status).toBe(400);
			expect(twice.body).toEqual({ message: NOT_STARTED_HERE });
		});

		it('takes a state inside its ten minutes and refuses one past them (decision 4)', async () => {
			store(G);
			exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });
			vi.useFakeTimers({ toFake: ['Date'] });
			try {
				const started = Date.now();
				const late = await begin({ credential: LAPTOP });
				const inTime = await begin({ credential: PHONE });

				vi.setSystemTime(started + 10 * 60 * 1000 - 1000);
				expect((await finish(inTime.state, { credential: PHONE })).body.success).toBe(true);

				vi.setSystemTime(started + 10 * 60 * 1000 + 1);
				const res = await finish(late.state, { credential: LAPTOP });
				expect(res.status).toBe(400);
				expect(res.body).toEqual({ message: NOT_STARTED_HERE });
			} finally {
				vi.useRealTimers();
			}
		});

		it('forgets the older state when the same session asks again for the same destination (decision 4)', async () => {
			store(G);
			exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });

			const first = await begin();
			const second = await begin();

			expect((await finish(first.state)).status).toBe(400);
			expect((await finish(second.state)).body.success).toBe(true);
		});

		it('holds at most twenty Connects at once, dropping the oldest (decision 4)', async () => {
			store(G);
			exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });
			const tokens = Array.from({ length: 21 }, () => makeSession(chief));
			const session = (n: number): Credential => ({ kind: 'session', token: tokens[n] });
			const states: (string | null)[] = [];
			for (let n = 0; n <= 20; n++) states.push((await begin({ credential: session(n) })).state);

			expect((await finish(states[0], { credential: session(0) })).status).toBe(400);
			expect((await finish(states[1], { credential: session(1) })).body.success).toBe(true);
		});
	});

	describe('a successful Connect leaves one line under BACKUP, filed under the account (card 2273)', () => {
		// The tests keep ERROR and above; a first Connect's line is INFO.
		let level: string | undefined;
		beforeEach(() => {
			level = process.env.LOG_LEVEL;
			process.env.LOG_LEVEL = 'INFO';
			vi.spyOn(console, 'log').mockImplementation(() => {});
			vi.spyOn(console, 'warn').mockImplementation(() => {});
		});
		afterEach(() => {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		});

		/** The lines a Connect writes (card 2273), oldest first, with the account each is filed under and its meta. */
		const connectLines = () =>
			(
				sqlite
					.prepare("SELECT level, context, message, meta, user_id FROM system_logs WHERE message LIKE 'Google Drive destination %' ORDER BY id")
					.all() as { level: string; context: string; message: string; meta: string | null; user_id: number | null }[]
			).map((row) => ({ ...row, meta: row.meta === null ? null : JSON.parse(row.meta) }));
		const line = (level: 'INFO' | 'WARN', words: string, meta: Record<string, unknown>) => ({
			level,
			context: 'BACKUP',
			message: `Google Drive destination ${words}`,
			meta,
			user_id: chief.id
		});

		it('writes one INFO line for a first Connect: the destination, the narrow scope and a folder made, and nothing secret (decisions 1 and 3)', async () => {
			store(G);
			const exchanged = exchange({ refresh_token: 'rt-new', access_token: 'at-new', scope: DRIVE_FILE_SCOPE });
			const { state } = await begin();

			const res = await finish(state);

			expect(res.body.success, JSON.stringify(res.body)).toBe(true);
			expect(connectLines()).toEqual([
				line('INFO', '"G" connected: scope narrow (drive.file); a folder made', { destination: 'G', scope: 'narrow', folder: 'made', replaced: false })
			]);
			const verifier = ((exchanged.mock.calls[0] as unknown[])[0] as { codeVerifier: string }).codeVerifier;
			const written = JSON.stringify(connectLines());
			for (const secret of ['rt-new', 'at-new', 'the-code', state, verifier, 'made-folder-1', 'DumpFire backups', G.clientId, G.clientSecret]) {
				expect(written).not.toContain(secret);
			}
		});

		it('writes an INFO line for a first Connect to a Folder ID given, with a wide scope: its folder reached (decision 3)', async () => {
			store({ ...G, folderId: 'hand-made' });
			files.get.mockResolvedValue(found('hand-made'));
			exchange({ refresh_token: 'rt-new', scope: WIDE });

			expect((await connect()).body.success).toBe(true);

			expect(connectLines()).toEqual([
				line('INFO', '"G" connected: scope wide; its folder reached', { destination: 'G', scope: 'wide', folder: 'reached', replaced: false })
			]);
			expect(JSON.stringify(connectLines())).not.toContain('hand-made');
		});

		it('writes a WARN line for a Connect that replaces the connection a destination had, and says when Google named no scope (decision 1)', async () => {
			store({ ...G, folderId: 'hand-made', refreshToken: 'rt-old', grantedScope: WIDE });
			files.get.mockResolvedValue(found('hand-made'));
			exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });
			expect((await connect()).body.success).toBe(true);

			exchange({ refresh_token: 'rt-newer' });
			expect((await connect()).body.success).toBe(true);

			const AGAIN = '"G" connected again, replacing the connection it had';
			expect(connectLines()).toEqual([
				line('WARN', `${AGAIN}: scope narrow (drive.file); its folder reached`, { destination: 'G', scope: 'narrow', folder: 'reached', replaced: true }),
				line('WARN', `${AGAIN}: scope none named (read as wide); its folder reached`, { destination: 'G', scope: 'none', folder: 'reached', replaced: true })
			]);
			const written = JSON.stringify(connectLines());
			for (const secret of ['rt-old', 'rt-new', 'rt-newer']) expect(written).not.toContain(secret);
		});

		it('writes a WARN line for a connection made before card 2188, its Folder ID empty, connected again: a folder made (decision 1)', async () => {
			store({ ...G, refreshToken: 'rt-old' });
			exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });

			expect((await connect()).body.success).toBe(true);

			expect(connectLines()).toEqual([
				line('WARN', '"G" connected again, replacing the connection it had: scope narrow (drive.file); a folder made', {
					destination: 'G',
					scope: 'narrow',
					folder: 'made',
					replaced: true
				})
			]);
		});

		it('quotes the destination’s name as the backup settings’ lines do, a " and a \\ escaped (decision 5)', async () => {
			const NAME = 'Off"site\\';
			store({ ...G, name: NAME });
			exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });
			const { state } = await begin({ dest: encodeURIComponent(NAME) });

			expect((await finish(state, { destName: NAME })).body.success).toBe(true);

			expect(connectLines()).toEqual([
				line('INFO', '"Off\\"site\\\\" connected: scope narrow (drive.file); a folder made', { destination: NAME, scope: 'narrow', folder: 'made', replaced: false })
			]);
		});

		it.each([
			['Google gives no refresh token', () => (store(G), exchange({ access_token: 'only-this' }), connect())],
			[
				'the folder cannot be reached',
				() => (
					store({ ...G, folderId: 'gone', refreshToken: 'rt-old', grantedScope: DRIVE_FILE_SCOPE }),
					files.get.mockRejectedValue(notFound()),
					exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE }),
					connect()
				)
			],
			[
				'the destination is changed meanwhile',
				() => (
					store(G),
					exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE }, () =>
						api('PUT', '/api/admin/backup', { user: chief, body: { destinations: [{ ...G, folderId: 'chosen-meanwhile' }] } })
					),
					connect()
				)
			],
			['its state is refused', async () => (store(G), exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE }), await begin(), finish('A'.repeat(43)))]
		])('writes no line where the Connect saves nothing: %s (decision 4)', async (_case, attempt) => {
			const res = await attempt();

			expect(res.body.success).not.toBe(true);
			expect(connectLines()).toEqual([]);
		});

		it('writes no line for a Connect whose write fails, and deletes the folder it made: the line waits for the commit (decision 4)', async () => {
			store(G);
			exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });
			const { state } = await begin();
			vi.spyOn(console, 'error').mockImplementation(() => {});
			sqlite.exec(
				"CREATE TEMP TRIGGER backup_config_frozen BEFORE UPDATE ON settings WHEN NEW.key = 'backup_config' BEGIN SELECT RAISE(ABORT, 'frozen'); END;" +
					"CREATE TEMP TRIGGER backup_config_frozen_insert BEFORE INSERT ON settings WHEN NEW.key = 'backup_config' BEGIN SELECT RAISE(ABORT, 'frozen'); END;"
			);
			let res;
			try {
				res = await finish(state);
			} finally {
				sqlite.exec('DROP TRIGGER backup_config_frozen; DROP TRIGGER backup_config_frozen_insert;');
			}

			expect(res.body).toEqual({ success: false, message: 'frozen' });
			expect(storedG()).toEqual(G);
			expect(files.delete.mock.calls[0][0]).toMatchObject({ fileId: 'made-folder-1' });
			expect(connectLines()).toEqual([]);
		});

		it('reads whether a Connect replaced a connection from the settings as read again: one finished meanwhile counts (the card 2273 review)', async () => {
			store({ ...G, folderId: 'hand-made' });
			files.get.mockResolvedValue(found('hand-made'));
			// While Google answers the first Connect, a second is started and finished in full.
			let inner = false;
			exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE }, async () => {
				if (inner) return;
				inner = true;
				expect((await connect()).body.success).toBe(true);
			});

			expect((await connect()).body.success).toBe(true);

			expect(connectLines()).toEqual([
				line('INFO', '"G" connected: scope narrow (drive.file); its folder reached', { destination: 'G', scope: 'narrow', folder: 'reached', replaced: false }),
				line('WARN', '"G" connected again, replacing the connection it had: scope narrow (drive.file); its folder reached', {
					destination: 'G',
					scope: 'narrow',
					folder: 'reached',
					replaced: true
				})
			]);
		});

		describe('the Connect’s other lines: filed under the account, the name quoted (the card 2273 review)', () => {
			const NAME = 'Off"site';
			const QUOTED = '"Off\\"site"';
			/** Both halves of a Connect of the destination called NAME. */
			const connectNamed = async () => finish((await begin({ dest: encodeURIComponent(NAME) })).state, { destName: NAME });
			/** The lines under GDRIVE, oldest first, with the account each is filed under. */
			const gdriveLines = () =>
				sqlite.prepare("SELECT level, message, user_id AS userId FROM system_logs WHERE context = 'GDRIVE' ORDER BY id").all() as {
					level: string;
					message: string;
					userId: number | null;
				}[];
			beforeEach(() => {
				vi.spyOn(console, 'error').mockImplementation(() => {});
			});

			it('files a refused state under the account, the name quoted (card 2251’s line)', async () => {
				store({ ...G, name: NAME });
				exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });
				await begin({ dest: encodeURIComponent(NAME) });

				expect((await finish('A'.repeat(43), { destName: NAME })).status).toBe(400);

				expect(gdriveLines()).toEqual([
					{
						level: 'WARN',
						message: `Google Drive Connect refused for destination ${QUOTED}: its state was not one this session started, or had expired or been used`,
						userId: chief.id
					}
				]);
			});

			it('files a folder that cannot be reached under the account, the name quoted', async () => {
				store({ ...G, name: NAME, folderId: 'gone' });
				files.get.mockRejectedValue(notFound());
				exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });

				expect((await connectNamed()).body.success).toBe(false);

				expect(gdriveLines()).toEqual([
					{
						level: 'WARN',
						message: `Connect of destination ${QUOTED} refused: Google Drive cannot reach its folder gone: File not found: gone.`,
						userId: chief.id
					}
				]);
			});

			it('files a made folder it could not delete under the account, the name quoted', async () => {
				store({ ...G, name: NAME });
				files.delete.mockRejectedValue(new Error('nope'));
				exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE }, () =>
					api('PUT', '/api/admin/backup', { user: chief, body: { destinations: [{ ...G, name: NAME, folderId: 'chosen-meanwhile' }] } })
				);

				expect((await connectNamed()).body).toEqual({ success: false, message: CHANGED_MEANWHILE });

				expect(gdriveLines()).toEqual([
					{
						level: 'WARN',
						message: `Could not delete the folder made-folder-1 made for destination ${QUOTED} by a Connect that was not saved: nope`,
						userId: chief.id
					}
				]);
			});

			it('files a failed Connect under the account, the name quoted', async () => {
				store({ ...G, name: NAME });
				vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockRejectedValue(new Error('invalid_grant') as never);

				expect((await connectNamed()).body).toEqual({ success: false, message: 'invalid_grant' });

				expect(gdriveLines()).toEqual([{ level: 'ERROR', message: `Google Drive Connect failed for destination ${QUOTED}: invalid_grant`, userId: chief.id }]);
			});
		});
	});
});

describe('the Scheduled Backups panel on the admin page (cards 2188 and 2190, slice 4)', () => {
	// Read as text: the page is CRLF in the working copy, so lines are joined with \n first.
	const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
	// Card 2281, slice C1a: the panel, its add and edit forms and Google Drive's
	// Connect box are components of the page, each read for what it holds; the
	// page and all of them together for what is held to be nowhere.
	const ADMIN = 'src/lib/components/admin';
	const admin = [
		'src/routes/admin/+page.svelte',
		...readdirSync(join(process.cwd(), ADMIN)).filter((name) => name.endsWith('.svelte')).map((name) => `${ADMIN}/${name}`),
		// The modules they share: `sent` and the formatters.
		...readdirSync(join(process.cwd(), 'src/lib/admin')).filter((name) => name.endsWith('.ts')).map((name) => `src/lib/admin/${name}`)
	];
	const panel = read(`${ADMIN}/ScheduledBackupsPanel.svelte`);
	const form = read(`${ADMIN}/DestinationForm.svelte`);
	const connectBox = read(`${ADMIN}/GDriveConnectModal.svelte`);
	// A module is script alone, with no markup.
	const scriptOf = (source: string) => (source.includes('</script>') ? source.slice(0, source.indexOf('</script>')) : source);
	const markupOf = (source: string) => (source.includes('</script>') ? source.slice(source.indexOf('</script>')) : '');
	/** The page, every component of it and their modules, whole. */
	const page = admin.map(read).join('\n');
	/** Their markup, all of it. */
	const markup = admin.map((file) => markupOf(read(file))).join('\n');
	const row = markupOf(panel).slice(markupOf(panel).indexOf('{#each backupDestinations as dest'), markupOf(panel).indexOf('<!-- Inline edit form -->'));
	const editForm = markupOf(form).slice(markupOf(form).indexOf('<!-- Inline edit form -->'), markupOf(form).indexOf('<!-- Add Destination Form -->'));
	const addForm = markupOf(form).slice(markupOf(form).indexOf('<!-- Add Destination Form -->'));

	/** R2's line under a connection that reaches all of Drive. */
	const NARROW_IT =
		"Connected with access to all of this Google account's Drive. To narrow it: first remove DumpFire's access in the " +
		'Google account (Google Account, Security, Your connections to third-party apps and services), then have the superadmin ' +
		'remove this destination, add it again with the Folder ID left empty, and connect it. See the admin guide, Configuring Backups.';
	/** The OAuth hint in both forms (slice 4 as R5 has it), the folder's name from the server's own function. */
	const OAUTH_HINT =
		'DumpFire asks Google only for the files it makes. Leave the Folder ID empty: when you connect, DumpFire makes a ' +
		'folder of its own, "{dumpfireFolderName()}". A folder you made yourself may not be reachable. To keep using a folder ' +
		'DumpFire made, give its Folder ID again (shown on the destination as Folder:); Connect checks it can reach it.';
	const OAUTH_PLACEHOLDER = 'Folder ID (leave empty: DumpFire makes one when you connect)';
	/** Decision 3's line in the inline edit form. */
	const KEPT_ONLY =
		"A saved password, key or secret is kept only while the destination's name and settings stay as they were saved: " +
		'type it again when you change them. A connected Google Drive destination is removed by the superadmin, added again and connected.';

	it('reads a connection’s recorded scope and the folder’s name with the server’s own functions, and imports nothing of the server’s', () => {
		// The scope in the panel's rows, the folder's name in the forms.
		expect(panel).toContain("import { driveScopeIsNarrow } from '$lib/drive-scope';");
		expect(form).toContain("import { dumpfireFolderName } from '$lib/drive-scope';");
		expect(page).not.toMatch(/from '\$lib\/server/);
		// The folder named on the page is the one Connect makes.
		expect(dumpfireFolderName(new Date('2026-10-18T12:00:00Z'))).toBe('DumpFire backups (made 2026-10-18)');
	});

	it('shows a connection narrowed to DumpFire’s files as Connected, any other as all of Drive, and Connect only where there is no connection (decision 7, R2, R6)', () => {
		expect(row).toMatch(
			/\{#if dest\.refreshToken\}\s*\{#if driveScopeIsNarrow\(dest\.grantedScope\)\}\s*<span[^>]*>✅ Connected<\/span>\s*\{:else\}\s*<span[^>]*>⚠️ Connected · all of Drive<\/span>\s*\{\/if\}\s*\{:else\}\s*<button[^>]*onclick=\{\(\) => gdriveConnect\?\.connectGDriveOAuth\(dest\.name\)\}>🔗 Connect<\/button>\s*\{\/if\}/
		);
		// The Connect box the button calls is the one the panel draws.
		expect(markupOf(panel)).toContain('<GDriveConnectModal bind:this={gdriveConnect} {loadBackupConfig} />');
		// No "Connect again" as an action on a destination: the page would lead
		// into the wrong order (R2). The phrase is only in the two toasts of card
		// 2251's paste box, for a Connect Google ended with an error, which leaves
		// the destination unconnected and its Connect button showing.
		expect(markup).not.toContain('Connect again');
		const scripts = admin.map((file) => scriptOf(read(file))).join('\n');
		const fn = scriptOf(connectBox).slice(scriptOf(connectBox).indexOf('async function exchangeGDriveCode()'));
		expect(scripts.match(/Connect again/g)).toHaveLength(2);
		expect(fn.match(/Press Connect again/g)).toHaveLength(2);
		expect(markup.match(/connectGDriveOAuth\(/g)).toHaveLength(1);
	});

	it('says under a connection that reaches all of Drive how to narrow it, removing access first (R2)', () => {
		const condition = "{#if dest.type === 'gdrive' && dest.authMethod === 'oauth' && dest.refreshToken && !driveScopeIsNarrow(dest.grantedScope)}";
		const at = row.indexOf(condition);
		expect(at).toBeGreaterThan(-1);
		expect(row.slice(at, row.indexOf('{/if}', at))).toContain(NARROW_IT);
		expect(page.split(NARROW_IT)).toHaveLength(2);
	});

	it.each([
		['the add form', () => addForm],
		['the inline edit form', () => editForm]
	])('tells, in %s, that Google is asked only for DumpFire’s files and that it makes its own folder (decision 8, R5)', (_form, form) => {
		const text = form();
		const oauth = text.indexOf("{#if destGdriveAuthMethod === 'oauth'}");
		expect(oauth).toBeGreaterThan(-1);
		// Within the OAuth branch: before the service account's box.
		expect(text.slice(oauth, text.indexOf('<textarea placeholder="', oauth))).toContain(OAUTH_HINT);
		expect(text.split(OAUTH_HINT)).toHaveLength(2);
		expect(text).toContain(`placeholder={destGdriveAuthMethod === 'oauth' ? '${OAUTH_PLACEHOLDER}' :`);
	});

	it('gives the folder hint in the inline edit form only for a destination not yet connected (the review-fix pass)', () => {
		// A connected destination keeps its folder: telling it to leave the
		// Folder ID empty would lead to a refusal.
		const connected = editForm.indexOf('{#if destGdriveRefreshToken}');
		expect(connected).toBeGreaterThan(-1);
		const notYet = editForm.indexOf('{:else}', connected);
		const end = editForm.indexOf('{/if}', notYet);
		expect(editForm.slice(connected, notYet)).toContain('✅ Google account connected');
		expect(editForm.slice(connected, notYet)).not.toContain(OAUTH_HINT);
		expect(editForm.slice(notYet, end)).toContain(OAUTH_HINT);
	});

	it('names the destination’s Connect button in the forms as the row labels it (card 2306)', () => {
		// The row's button, word for word, and the one button there is to name.
		const label = '🔗 Connect';
		expect(row).toContain(`>${label}</button>`);
		const connected = editForm.indexOf('{#if destGdriveRefreshToken}');
		const notYet = editForm.slice(editForm.indexOf('{:else}', connected), editForm.indexOf('{/if}', connected));
		expect(notYet).toContain(`Save first, then use "${label}" on the destination.`);
		expect(addForm).toContain(`click <strong>"${label}"</strong> to authorize your Google account`);
		expect(markup).not.toContain('Connect Google Account');
	});

	it('says in the inline edit form when a saved secret is kept, and not in the add form (decision 3)', () => {
		expect(editForm).toContain(KEPT_ONLY);
		expect(addForm).not.toContain(KEPT_ONLY);
	});

	it('shows a refused save or Connect in the server’s own words (decisions 3, 8 and 9)', () => {
		// The Test through `sent`, which the page and its panels share (card 2281, slice C1a); the save
		// reads the server's words itself, to add that the settings were read again (the card 2398 review).
		expect(read('src/lib/admin/send.ts')).toContain('showToast(await failureMessage(res, fallback), \'error\', started);');
		expect(scriptOf(panel)).toContain("import { NO_ANSWER, sent, showToast } from '$lib/admin/send';");
		expect(scriptOf(panel)).toContain("refused = await failureMessage(res, 'Failed to save backup settings');");
		expect(scriptOf(connectBox)).toContain("showToast(said || 'Failed to connect', 'error', started);");
	});
});
