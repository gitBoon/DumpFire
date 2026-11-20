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
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { google } from 'googleapis';
import { generateBackupData, getBackupConfig, runBackup, saveBackupConfig, withoutSecrets } from '$lib/server/backup';
import { DRIVE_REFUSAL, FOLDER_PATH_REFUSAL, ONEDRIVE_DRIVE_NOT_SET } from '$lib/server/onedrive-address';
import {
	DESTINATION_SECRET_FIELDS,
	TYPED_SECRET_LOOKS_SEALED,
	destinationSecretAad,
	isSealed,
	mailPasswordAad,
	openStored,
	replacedSigningKeysLine,
	sealPlainSecrets,
	sealValue,
	sealedForRestore,
	settingAad,
	webhookSecretAad,
	webhookUrlAad,
	BACKUP_SEAL_KEY_MADE_AT,
	SIGNING_KEY_SETTINGS,
	WEBHOOK_ADDRESS_MAC_KEY
} from '$lib/server/stored-secrets';
import { currentMfaKey, keyFromBytes } from '$lib/server/mfa-key';
import {
	GDriveDestination,
	ONEDRIVE_DRIVE_REQUIRED,
	SERVICE_ACCOUNT_REFUSALS,
	SERVICE_ACCOUNT_UNDER_OAUTH,
	dumpfireFolderName,
	type DestinationConfig,
	type GDriveDestinationConfig
} from '$lib/server/backup-destinations';
import {
	BACKUP_SEAL,
	BACKUP_SEAL_KEY,
	CREDENTIALS_NOT_ENTERED,
	GDRIVE_NOT_CONNECTED,
	INSTALLATION_ID,
	NOT_SEALED_HERE,
	NO_SEAL_HERE,
	SAVE_BEFORE_TEST,
	SEAL_KEY_NOT_TRUSTED,
	SECRET_FIELDS,
	SECRET_MASK,
	SERVICE_ACCOUNT_NOT_A_KEY,
	WEBHOOK_ADDRESSES_LEFT_OUT_KEY,
	WEBHOOK_SECRETS_LEFT_OUT_KEY,
	backupSealKey,
	webhookAddressMacKey,
	clearSecrets,
	credentialsMissing,
	ensureInstallationId,
	failedCheckSentence,
	hostKeyChanges,
	installationIdHere,
	installationOf,
	sealCopy,
	sealKeyHere,
	sealOf,
	sealVerifies,
	secretsKeptSentence,
	secretsToEnter,
	secretsToEnterSentence,
	settingsChanges,
	strayInternalObjects,
	unsealedBecause,
	withHeldApart
} from '$lib/server/backup-secrets';
import { DRIVE_FILE_SCOPE, driveScopeIsNarrow } from '$lib/drive-scope';
import { AccountDisabled, SESSION_COOKIE_NAME, createSession, generateApiKey, type Credential, type SessionUser } from '$lib/server/auth';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { stamp } from '$lib/timestamps';
import { db, sqlite } from '$lib/server/db';
// For the database file's path the import route asks for, stood in for in one case (card 2925).
import * as connection from '$lib/server/db';
import { runMigrations } from '$lib/server/db/migrate';
import { credentialOf, passwordReplacedHere, recordPasswordReplaced } from '$lib/server/account-endings';
import { endReplacedPasswordsPresent } from '$lib/server/account-ending-bodies';
import { hashSync } from 'bcryptjs';
import { DUMMY_HASH } from '$lib/server/dummy-hash';
import { carryFactors, mfaWithoutFactorSentence, readMfaHere, sameAccountHere, type GrantTrust } from '$lib/server/mfa-backup';
import { usableInvite } from '$lib/server/invites';
import { shouldNotifyUser } from '$lib/server/notifications';
import { NOTIFICATION_PREFS } from '$lib/notification-prefs';
import {
	NO_SUPERADMIN_IN_BACKUP,
	RestoreError,
	RestoreLeavesNoSuperadmin,
	SIGNED_OUT,
	backupLacksSuperadmin,
	restorableTables,
	restoreFromBackup,
	rowsToRestore,
	superadminsOf
} from '$lib/server/db/restore';
import { inviteTokens, taskRequests, users, type Board } from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import { disableAccount } from '$lib/server/account-disable';
import { removeSettingsOfFormerAdministrators } from '$lib/server/setting-setters';
import { issueInvite } from '$lib/server/invites';
import { KNOWN_BROWSER_SECRET_KEY } from '$lib/server/known-browsers';
import {
	REQUEST_FORM_SECRET_KEY,
	issueFormToken,
	issueRequestLink,
	requestLinkHash,
	resetFormSecretCache,
	verifyFormToken
} from '$lib/server/request-tokens';
import { maskLiveLog, reportInstallation, reportNoSuperadmin, sealStoredSecretsAtStart } from '$lib/server/startup-checks';
import { NEW_SECRET_REASONS, dispatchWebhook } from '$lib/server/webhooks';
import { api, routeMethods } from './helpers/api';
import { effects } from './helpers/effects';
import {
	FIXTURE_PASSWORD,
	addBoardMember,
	fixtureHashOf,
	importConfirmation,
	inviteHashOf,
	makeApiKeyRow,
	makeBoard,
	makeCard,
	makeDecision,
	makeParticipant,
	makeSession,
	makeSmtp,
	makeUser,
	makeWebhook,
	startedSinceAlreadyOffHeld,
	resetDb,
	stepUp,
	stepUpCode,
	stepUpFactor,
	sessionHashOf,
	sessionCredential,
	sessionRow
} from './helpers/fixtures';
import { FROM_THE_PAGE, gate, gateApiRoutes } from './helpers/gate';
import { diffSnapshots, expectUnchanged, snapshotDb } from './helpers/snapshot';
import { afterEachTimestampCheck, allowOtherTimestampForms } from './helpers/timestamps';
import { readOpened, readOpenedUrl } from './helpers/reads';
import { giveFactor, openReleaseWindow, passwordStep, signInFully } from './helpers/two-step';

/** What the stand-in destination was handed: the bytes, under the name and for the destination they were for. */
const uploaded = vi.hoisted(() => [] as { destination: string; filename: string; bytes: Buffer }[]);

/** Each configuration the stand-in destination was made from, as `createDestination` was handed it (cards 2187 and 2190). */
const handed = vi.hoisted(() => [] as Record<string, unknown>[]);

/** No MFA key loaded, for one case of card 2898 (case 33): `currentMfaKey` answers null while it is set. */
const keyStub = vi.hoisted(() => ({ none: false }));

/** No authenticator carried by card 3009's carry, for its words through the route: `carryFactors` answers 0 while it is set. */
const carryStub = vi.hoisted(() => ({ none: false }));

vi.mock('$lib/server/mfa-backup', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/mfa-backup')>();
	return { ...real, carryFactors: (...args: Parameters<typeof real.carryFactors>) => (carryStub.none ? 0 : real.carryFactors(...args)) };
});

vi.mock('$lib/server/mfa-key', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/mfa-key')>();
	return { ...real, currentMfaKey: () => (keyStub.none ? null : real.currentMfaKey()) };
});

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
/**
 * A request's link: whoever holds it reads the thread and replies as the
 * requester (card 2158). Issued as a mail issues one, before each test, and
 * kept only as its hash in `request_links` (card 2870).
 */
let REQUEST_LINK = '';
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

/**
 * The headers of an import the superadmin sends from their session, sent as
 * `contentType`, with their password confirmed first there (card 2701).
 */
const confirmedImport = (contentType = 'application/octet-stream') => ({
	'content-type': contentType,
	...importConfirmation(chief, chiefSession)
});

/**
 * `api()`'s options for the superadmin from their own session, with their
 * current password (card 2701) and a code (card 2771): what a request that
 * asks for them again sends. The session and the factor are the ones each
 * test begins with, so a refused request leaves every row as it was.
 */
const confirmedByChief = (body: Record<string, unknown> = {}) => ({
	user: chief,
	body: { ...body, currentPassword: FIXTURE_PASSWORD, currentCode: stepUpCode(chief) },
	headers: { cookie: `${SESSION_COOKIE_NAME}=${chiefSession}` }
});

/**
 * The export as the page asks for it, through the gate, from the superadmin's
 * session: a POST with their current password since card 2701.
 */
const exported = () =>
	gate('POST', '/api/admin/export', {
		headers: { cookie: `${SESSION_COOKIE_NAME}=${chiefSession}`, ...FROM_THE_PAGE, accept: '*/*' },
		body: { currentPassword: FIXTURE_PASSWORD, currentCode: stepUpCode(chief) }
	});

beforeEach(() => {
	resetDb();
	uploaded.length = 0;
	handed.length = 0;
	chief = makeUser({ username: 'chief', role: 'superadmin' });
	admin = makeUser({ username: 'administrator', role: 'admin' });
	member = makeUser({ username: 'member' });
	chiefSession = makeSession(chief);
	memberSession = makeSession(member);
	// The factor the superadmin's codes are made from, given before any snapshot (card 2771).
	stepUpFactor(chief);
	db.insert(inviteTokens)
		.values([
			// As this image keeps them: the hash of the token mailed (card 2849).
			{ tokenHash: inviteHashOf(UNUSED_INVITE), userId: member.id, expiresAt: '2099-01-01 00:00:00', used: false },
			{ tokenHash: inviteHashOf(USED_INVITE), userId: admin.id, expiresAt: '2099-01-01 00:00:00', used: true }
		])
		.run();
	makeCard(makeBoard({ owner: member, name: 'A board' }).cols['To Do'], { title: 'A card' });
	const request = db
		.insert(taskRequests)
		.values({
			targetType: 'user',
			targetId: member.id,
			title: 'A request',
			requesterName: 'Rita',
			requesterEmail: 'rita@example.test',
			status: 'pending'
		})
		.returning()
		.get();
	REQUEST_LINK = inTransaction(() => issueRequestLink(request.id, 'mail'));
	// In place of the one resetDb made, as a start makes one (card 2750).
	sqlite.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(REQUEST_FORM_SECRET_KEY, FORM_KEY);
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

/** What signs somebody in, as the running database holds it: an invite as its token's hash (card 2849). */
const signInsHere = () => ({
	sessions: column<string>(sqlite, 'SELECT id FROM sessions ORDER BY id'),
	invites: column<string>(sqlite, 'SELECT token FROM invite_tokens ORDER BY token')
});

/**
 * What opens a request's thread, and what the form signs with, as the running
 * database holds them: a link as its token's hash (card 2870), and the retired
 * column, NULL.
 */
const requestKeysHere = () => ({
	links: column<string>(sqlite, 'SELECT token_hash FROM request_links ORDER BY id'),
	retired: column<string | null>(sqlite, 'SELECT access_token FROM task_requests ORDER BY id'),
	formKey: column<string>(sqlite, `SELECT value FROM settings WHERE key = '${REQUEST_FORM_SECRET_KEY}'`)
});

/**
 * A backup holds nothing that signs anybody in, and everything else. Asked of
 * the bytes: a deleted row's text is still in a file that was not vacuumed.
 */
function expectNoSignIns(bytes: Buffer): void {
	const has = (text: string | Buffer) => bytes.includes(Buffer.from(text));

	expect(has(chiefSession), 'the id of a live session').toBe(false);
	expect(has(memberSession), 'the id of a live session').toBe(false);
	// Nor the row of one: a session is kept as its code's hash (card 2775).
	expect(has(sessionHashOf(chiefSession)), 'the row of a live session').toBe(false);
	expect(has(sessionHashOf(memberSession)), 'the row of a live session').toBe(false);
	expect(has(UNUSED_INVITE), 'an invite that has not been used').toBe(false);
	expect(has(inviteHashOf(UNUSED_INVITE)), 'the row of an invite that has not been used').toBe(false);
	// No invite's token at all: the database holds none (card 2849).
	expect(has(USED_INVITE), 'the token of an invite that was used').toBe(false);
	// Card 2158: no request's link, and not the key the form signs with, nor its name.
	expect(has(REQUEST_LINK), 'a request’s link').toBe(false);
	// Nor its hash (card 2870): the copy holds no request_links row, rewritten.
	expect(has(requestLinkHash(REQUEST_LINK)), 'the row of a request’s link').toBe(false);
	expect(has(FORM_KEY), 'the key the request form signs with').toBe(false);
	expect(has(REQUEST_FORM_SECRET_KEY), 'the name of the form key’s setting').toBe(false);

	// It is the whole database otherwise: an invite that was used, as its hash,
	// and every user, with the hash a restore needs to sign them in again.
	expect(has(inviteHashOf(USED_INVITE))).toBe(true);
	for (const user of [chief, admin, member]) {
		expect(has(user.email), user.username).toBe(true);
		expect(has(fixtureHashOf(user)), `${user.username}'s password hash`).toBe(true);
	}
	expect(has('A card')).toBe(true);

	const backup = opening(bytes);
	expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
	expect(column(backup, 'SELECT id FROM sessions')).toEqual([]);
	expect(column(backup, 'SELECT token FROM invite_tokens')).toEqual([inviteHashOf(USED_INVITE)]);
	expect(column(backup, 'SELECT username FROM users ORDER BY id')).toEqual(['chief', 'administrator', 'member']);
	// The request is there, with no link to it.
	expect(backup.prepare('SELECT title, access_token FROM task_requests').all()).toEqual([{ title: 'A request', access_token: null }]);
	expect(column(backup, 'SELECT COUNT(*) FROM request_links')).toEqual([0]);
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
		expect(keys).toEqual({ links: [requestLinkHash(REQUEST_LINK)], retired: [null], formKey: [FORM_KEY] });

		const res = await exported();

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
		const res = await api('POST', '/api/admin/backup', confirmedByChief());

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
		// A second request, with a link of its own, kept as its hash (card 2870).
		const another = sqlite
			.prepare("INSERT INTO task_requests (target_type, target_id, title, requester_name, status) VALUES ('user', ?, 'Another', 'Sam', 'pending')")
			.run(member.id).lastInsertRowid;
		const anotherLink = requestLinkHash(inTransaction(() => issueRequestLink(Number(another), 'mail')));
		// And a link in plain in the retired column, as an older image writes it
		// (card 2870): 64 hex characters, written by raw SQL.
		const plainLink = 'ab'.repeat(32);
		sqlite.prepare('UPDATE task_requests SET access_token = ? WHERE id = ?').run(plainLink, Number(another));
		for (const path of [deletedOnly, copied]) sqlite.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);

		const copy = new Database(deletedOnly);
		copy.exec('DELETE FROM sessions; DELETE FROM invite_tokens WHERE used = 0; DELETE FROM request_links');
		expect(copy.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
		expect(copy.prepare('SELECT COUNT(*) AS n FROM request_links').get()).toEqual({ n: 0 });
		const pages = copy.serialize();
		copy.close();
		// A session's row holds its code's hash (card 2775): deleted, still on its page.
		expect(pages.includes(sessionHashOf(memberSession))).toBe(true);
		// A request's link too (card 2870): deleted, and its hash still on its page.
		expect(pages.includes(Buffer.from(anotherLink))).toBe(true);
		// And the plain one is on a page of the copy withoutSecrets is given.
		expect(readFileSync(copied).includes(Buffer.from(plainLink))).toBe(true);

		withoutSecrets(copied, cleared);
		const written = readFileSync(cleared);
		expect(written.includes(Buffer.from(memberSession))).toBe(false);
		expect(written.includes(Buffer.from(inviteHashOf(UNUSED_INVITE)))).toBe(false);
		expect(written.includes(Buffer.from(requestLinkHash(REQUEST_LINK)))).toBe(false);
		expect(written.includes(Buffer.from(anotherLink))).toBe(false);
		expect(written.includes(Buffer.from(plainLink))).toBe(false);
		expect(written.includes(Buffer.from(FORM_KEY))).toBe(false);
		expect(written.includes(Buffer.from(inviteHashOf(USED_INVITE)))).toBe(true);
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

		const res = await exported();
		expect(res.status).toBe(200);
		for (const bytes of [Buffer.from(await res.arrayBuffer()), generateBackupData()]) {
			expect(bytes.includes(Buffer.from(key))).toBe(false);
			expect(bytes.includes(Buffer.from(KNOWN_BROWSER_SECRET_KEY))).toBe(false);
			// The other settings are there, and the backup's seal (card 2169's S1), which is no secret, and the
			// MFA key's check the superadmin's factor wrote (card 2771), which is none either.
			expect(column(opening(bytes), 'SELECT key FROM settings ORDER BY key')).toEqual(['app_url', BACKUP_SEAL, 'installation_id', 'mfa_key_check']);
		}
		// And the running database still has it.
		expect(column(sqlite, `SELECT value FROM settings WHERE key = '${KNOWN_BROWSER_SECRET_KEY}'`)).toEqual([key]);
	});

	it('holds no invite token the system log wrote down, even from before the gate masked it', async () => {
		// The gate writes an invite's address with its token masked now. Opened
		// through the gate, then, and written into the log as an older version
		// wrote it: in the line, and in what is kept with it. A token on its own
		// in a line is not looked for since card 2849 (see "the running
		// database's system log, at start").
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
		old.run('INFO', `GET /invite/${USED_INVITE} → 200 (3ms)`, null);
		const invitesLogged = () => JSON.stringify(sqlite.prepare("SELECT message, meta FROM system_logs WHERE message LIKE '%invite%'").all());
		const live = invitesLogged();
		expect(live).toContain(UNUSED_INVITE);

		const res = await exported();
		const bytes = Buffer.from(await res.arrayBuffer());

		expect(res.status).toBe(200);
		expectNoSignIns(bytes);
		// Every line is still there, with the token masked.
		const lines = column<string>(opening(bytes), "SELECT message FROM system_logs WHERE message LIKE '%invite%' ORDER BY id");
		expect(lines.map((line) => line.replace(/ \(\d+ms\)$/, ''))).toEqual([
			'GET /invite/[token] → 200',
			'GET /invite/[token] → 200',
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
	// Its invites are taken only from a backup whose seal verified (card 3009's code review, FP1): a case that restores
	// them seals the copy, with `sealedFor`, once it holds all it will.
	backup.exec(`
		INSERT INTO users (id, username, email, password_hash, role) VALUES
			(1, 'ann', 'ann@example.test', 'x', 'superadmin'),
			(2, 'bob', 'bob@example.test', 'x', 'user');
		-- In plain, on purpose: a backup made before card 2775 holds its sessions as the cookie held them.
		INSERT INTO sessions (id, user_id, expires_at) VALUES
			('session-of-ann-in-the-backup', 1, '2099-01-01T00:00:00.000Z'),
			('session-of-bob-in-the-backup', 2, '2099-01-01T00:00:00.000Z');
		-- In plain, on purpose: a backup made before card 2849 holds its invites as mailed.
		INSERT INTO invite_tokens (token, user_id, expires_at, used) VALUES
			('unused-invite-in-the-backup', 2, '2099-01-01T00:00:00.000Z', 0),
			('used-invite-in-the-backup', 2, '2099-01-01T00:00:00.000Z', 1);
		INSERT INTO boards (id, name, created_by) VALUES (1, 'From the backup', 1);
	`);
	return backup;
}

/** `backup` sealed under `live`'s seal key, as `live`'s own backup is (card 3009's code review, FP1). */
function sealedFor(live: Database.Database, backup: Database.Database): Database.Database {
	sealCopy(backup, backupSealKey(live));
	return backup;
}

describe('a restore', () => {
	it('brings in no session and no unused invite, whatever the backup holds, and clears the ones that were here', () => {
		const live = migratedDb();
		live.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES (9, 'here', 'here@example.test', 'x', 'superadmin');
			-- In plain, on purpose: a database from before card 2775; a restore clears its sessions whatever their form.
			INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-that-was-here', 9, '2099-01-01T00:00:00.000Z');
		`);
		live
			.prepare("INSERT INTO invite_tokens (token, user_id, expires_at, used) VALUES (?, 9, '2099-01-01T00:00:00.000Z', 0)")
			.run(inviteHashOf('invite-that-was-here'));
		const backup = sealedFor(live, backupWithSignIns());

		const result = restoreFromBackup(live, backup);

		expect(result.sealVerified).toBe(true);
		expect(result.errors).toEqual([]);
		expect(column(live, 'SELECT id FROM sessions')).toEqual([]);
		// The used one, with 0068's token in place of the one it was mailed with (card 2849).
		expect(column(live, 'SELECT used FROM invite_tokens')).toEqual([1]);
		expect(result.restored.sessions).toBeUndefined();
		expect(result.restored.invite_tokens).toBe(1);
		// Everything else is the backup's.
		expect(column(live, 'SELECT username FROM users ORDER BY id')).toEqual(['ann', 'bob']);
		expect(column(live, 'SELECT name FROM boards')).toEqual(['From the backup']);
		// And the backup was only read.
		expect(column(backup, 'SELECT id FROM sessions')).toHaveLength(2);
	});

	// Card 2899 (case 1). The system log is this server's record of what was
	// done to it, and by whom: a restore cleared it and copied the backup's in.
	it('keeps the running system log line for line, brings none of the backup’s in, and counts what the backup held', () => {
		const live = migratedDb();
		live.exec(`
			INSERT INTO users (id, username, email, password_hash, role) VALUES (9, 'here', 'here@example.test', 'x', 'superadmin');
			INSERT INTO system_logs (id, timestamp, level, context, message, meta, user_id, ip) VALUES
				(1, '2026-11-01 09:00:00', 'WARN', 'AUTH', 'Failed login attempt at "here" (user 9) from IP 203.0.113.7 (bad password)', NULL, 9, '203.0.113.7'),
				(2, '2026-11-02 10:00:00', 'INFO', 'ADMIN', 'Settings saved', '{"by":"here"}', 9, '198.51.100.4'),
				(3, '2026-11-03 11:00:00', 'CRITICAL', 'ADMIN', 'Something worth keeping', NULL, NULL, NULL),
				-- In the other form: the timestamp pass after a restore leaves the log it kept alone (the code review's F4).
				(4, '2026-11-04T12:00:00.000Z', 'INFO', 'HTTP', 'An older line', NULL, NULL, NULL);
		`);
		const lines = (database: Database.Database) =>
			database.prepare('SELECT id, timestamp, level, context, message, meta, user_id, ip FROM system_logs ORDER BY id').all();
		const before = lines(live);
		const backup = backupWithSignIns();
		// The backup's own log: one line with the id of a line here, in other words, and one more.
		backup.exec(`
			INSERT INTO system_logs (id, timestamp, level, context, message) VALUES
				(1, '2026-10-01 08:00:00', 'INFO', 'AUTH', 'Nothing happened'),
				(7, '2026-10-05 12:30:00', 'INFO', 'ADMIN', 'Nothing happened either');
		`);

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		// Every line as it was, all eight columns, and none of the backup's.
		expect(lines(live)).toEqual(before);
		expect(column(live, "SELECT COUNT(*) FROM system_logs WHERE message LIKE 'Nothing happened%'")).toEqual([0]);
		expect(result.restored.system_logs).toBeUndefined();
		expect(result.systemLogLeftOut).toEqual({ lines: 2, first: '2026-10-01 08:00:00', last: '2026-10-05 12:30:00' });
		// The rest is the backup's, as before.
		expect(column(live, 'SELECT username FROM users ORDER BY id')).toEqual(['ann', 'bob']);
		// One list, which the import's safety copy and Reset read as well.
		expect(restorableTables(live)).not.toContain('system_logs');
		expect(restorableTables(live)).not.toContain('__drizzle_migrations');
		// Nor the record of every API key ended here (card 2995), which the restore keeps and adds the backup's to.
		expect(restorableTables(live)).not.toContain('api_key_revocations');
		expect(restorableTables(live)).toContain('users');
	});

	// Card 2849. A backup made before it holds each used invite's token as it
	// was mailed; one made since holds hashes. 0068's replacement is repeated
	// on the rows held in plain, and a row in hash form is left.
	it('gives each used invite a backup held in plain 0068’s 32 random bytes as it is read, and leaves one in hash form', () => {
		const live = migratedDb();
		live.exec(`INSERT INTO users (id, username, email, password_hash, role) VALUES (9, 'here', 'here@example.test', 'x', 'superadmin')`);
		const backup = backupWithSignIns();
		const inHashForm = inviteHashOf('used-invite-made-since');
		backup.prepare("INSERT INTO invite_tokens (token, user_id, expires_at, used) VALUES (?, 1, '2099-01-01T00:00:00.000Z', 1)").run(inHashForm);
		sealedFor(live, backup);
		const isHashForm = (value: unknown) => Buffer.isBuffer(value) && value.length === 32;

		// Replaced as the rows are read (the code review, CR3): a plain token never
		// reaches the live file, not even to be written over.
		const read = rowsToRestore(backup, 'invite_tokens', undefined, { sealVerified: true });
		expect(read.map((row) => isHashForm(row.token))).toEqual([true, true]);
		expect(read.map((row) => row.token)).toContainEqual(inHashForm);

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		expect(result.restored.invite_tokens).toBe(2);
		const rows = live.prepare('SELECT token, user_id AS userId, used FROM invite_tokens ORDER BY user_id DESC').all() as {
			token: unknown;
		}[];
		expect(rows).toEqual([
			{ token: expect.anything(), userId: 2, used: 1 },
			{ token: inHashForm, userId: 1, used: 1 }
		]);
		expect(isHashForm(rows[0].token)).toBe(true);
		const everything = JSON.stringify(live.prepare('SELECT * FROM invite_tokens').all());
		expect(everything).not.toContain('used-invite-in-the-backup');
		expect(everything).not.toContain('unused-invite-in-the-backup');
		expect(live.serialize().includes(Buffer.from('used-invite-in-the-backup'))).toBe(false);
	});

	// Card 2194: a backup made before the key was left out of backups still
	// holds it, and is restored without it, so that every browser is forgotten.
	// Card 2893's code review (CS1): of migration 0071's two moments, this server's and the backup's, the earlier is
	// kept, so that no key made after the release on either server counts as one from before it.
	it.each([
		{ row: "the backup's 0071 moment earlier: the backup's kept", inBackup: '2026-01-01 00:00:00', kept: '2026-01-01 00:00:00' },
		{ row: "the backup's 0071 moment later: this server's kept", inBackup: '2026-12-01 00:00:00', kept: '2026-11-18 09:00:00' }
	])('brings in no key that remembered browsers are signed with, and clears the one that was here ($row)', ({ inBackup, kept }) => {
		const live = migratedDb();
		live.exec(`INSERT INTO settings (key, value) VALUES ('${KNOWN_BROWSER_SECRET_KEY}', 'the-key-that-was-here')`);
		const backup = backupWithSignIns();
		backup.exec(`
			INSERT INTO settings (key, value) VALUES ('${KNOWN_BROWSER_SECRET_KEY}', 'the-key-in-the-backup');
			INSERT INTO settings (key, value) VALUES ('app_url', 'https://from-the-backup.example.test');
		`);
		// Migration 0071's moment, this server's and the backup's told apart (card 2752).
		const keysRecordedHere = '2026-11-18 09:00:00';
		live.prepare("UPDATE settings SET value = ? WHERE key = 'webhook_keys_recorded_at'").run(keysRecordedHere);
		backup.prepare("UPDATE settings SET value = ? WHERE key = 'webhook_keys_recorded_at'").run(inBackup);

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		// And the form signing key the restore makes in its transaction (card
		// 2750), and the backup's two_step_released_at, which migration 0066
		// wrote to it and a restore brings in as any setting (card 2769), and
		// its api_key_deadline, which migration 0069 wrote to it (card 2772),
		// and this server's webhook_keys_recorded_at, which migration 0071 wrote
		// here and a restore keeps (card 2752). And the key check the sealed form
		// key records, and the scrub every restore marks pending (card 2898). And the moment the restore's own run of the
		// start pass covered, written by it for a backup that had none (card 2935, P12). And the once-only seed's flag,
		// written for a backup that had none before the keys ended here are left out (card 2995, R3).
		expect(column(live, 'SELECT key FROM settings ORDER BY key')).toEqual([
			'api_key_deadline',
			'app_url',
			'mfa_key_check',
			'request_form_secret',
			'secrets_scrub_pending',
			'two_step_released_at',
			'webhook_keys_recorded_at',
			'webhook_reveals_seeded',
			'webhooks_readable_by_disabled_held'
		]);
		// The backup's own webhook_keys_recorded_at among them, and the earlier of the two kept.
		expect(result.restored.settings).toBe(4);
		expect(column(live, "SELECT value FROM settings WHERE key = 'webhook_keys_recorded_at'")).toEqual([kept]);
	});

	// Card 2158. A backup made before it holds every request's link as it was
	// mailed, and the form's key; one made since holds neither. Either way
	// every request restored has its links ended, and no key comes in. Since
	// card 2870 the links are hashes in request_links, which no backup brings
	// in, and the retired access_token is read as NULL.
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
		// In plain, on purpose: a backup made before card 2158, or a database an older image wrote.
		const OLD_LINKS: [string, string] = ['1'.repeat(64), '2'.repeat(64)];
		const linksIn = (database: Database.Database) => column<string | null>(database, 'SELECT access_token FROM task_requests ORDER BY id');
		/** Two link rows, as hashes, for the two requests: what a backup of another installation could hold (card 2870). */
		const withLinkRows = (backup: Database.Database) => {
			const insert = backup.prepare("INSERT INTO request_links (token_hash, request_id, source) VALUES (?, ?, 'mail')");
			for (const id of column<number>(backup, 'SELECT id FROM task_requests ORDER BY id')) insert.run(requestLinkHash(`token-of-${id}`), id);
			return backup;
		};

		it.each([
			['made before card 2158, holding the links mailed and the form’s key', true],
			['made since, holding neither', false]
		])('ends every request’s links, from a backup %s', (_made, old) => {
			const live = migratedDb();
			live.exec(`INSERT INTO settings (key, value) VALUES ('${REQUEST_FORM_SECRET_KEY}', 'the-key-that-was-here')`);
			const backup = withLinkRows(withRequests(backupWithSignIns(), old ? OLD_LINKS : [null, null]));
			if (old) backup.exec(`INSERT INTO settings (key, value) VALUES ('${REQUEST_FORM_SECRET_KEY}', 'the-key-in-the-backup')`);
			expect(column(backup, 'SELECT COUNT(*) FROM request_links')).toEqual([2]);

			const result = restoreFromBackup(live, backup);

			expect(result.errors).toEqual([]);
			expect(result.restored.task_requests).toBe(2);
			// Every request's links ended: none brought in, and the old column read as NULL (card 2870).
			expect(result.requestLinksReplaced).toBe(result.restored.task_requests);
			expect(linksIn(live)).toEqual([null, null]);
			expect(column(live, 'SELECT COUNT(*) FROM request_links')).toEqual([0]);
			// No form key came in, and the one that was here went with the settings:
			// the one there is the restore made, in its transaction (card 2750).
			const formKey = column<string>(live, `SELECT value FROM settings WHERE key = '${REQUEST_FORM_SECRET_KEY}'`);
			expect(formKey).toHaveLength(1);
			// Sealed (card 2898), `v2:` and 32 random bytes as hex once opened (card 2943).
			expect(readOpened('settings', REQUEST_FORM_SECRET_KEY, live)).toMatch(/^v2:[0-9a-f]{64}$/);
		});

		it('counts none for a backup with no requests', () => {
			const result = restoreFromBackup(migratedDb(), backupWithSignIns());

			expect(result.requestLinksReplaced).toBe(0);
		});

		it('leaves every link as it was when the restore rolls back, the ones kept as hashes included', () => {
			const live = migratedDb();
			live.exec("INSERT INTO users (id, username, email, password_hash, role) VALUES (9, 'here', 'here@example.test', 'x', 'superadmin')");
			withLinkRows(withRequests(live, OLD_LINKS));
			const kept = column<string>(live, 'SELECT token_hash FROM request_links ORDER BY id');
			expect(kept).toHaveLength(2);

			expect(() => restoreFromBackup(live, backupWhoseSuperadminCannotBeCopied())).toThrow(RestoreError);

			expect(linksIn(live)).toEqual(OLD_LINKS);
			expect(column(live, 'SELECT token_hash FROM request_links ORDER BY id')).toEqual(kept);
		});

		it('is rolled back, every link left as it was, when request_links cannot be emptied (CS2)', () => {
			const live = migratedDb();
			live.exec("INSERT INTO users (id, username, email, password_hash, role) VALUES (9, 'here', 'here@example.test', 'x', 'superadmin')");
			withLinkRows(withRequests(live, [null, null]));
			const kept = column<string>(live, 'SELECT token_hash FROM request_links ORDER BY id');
			// Every delete from the table fails: the clear's, which is caught, and any other.
			live.exec("CREATE TRIGGER keep_request_links BEFORE DELETE ON request_links BEGIN SELECT RAISE(ABORT, 'request_links is not to be emptied'); END");

			expect(() => restoreFromBackup(live, withRequests(backupWithSignIns(), [null, null]))).toThrow(/request_links is not to be emptied/);

			expect(column(live, 'SELECT token_hash FROM request_links ORDER BY id')).toEqual(kept);
			expect(column(live, 'SELECT username FROM users ORDER BY id')).toEqual(['here']);
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
					headers: confirmedImport(),
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
			// No link is left, and none was brought in (card 2870): the requester asks for one.
			expect(requestKeysHere().links).toEqual([]);
			expect(requestKeysHere().retired).toEqual([null]);
			expect((await api('GET', `/api/requests/${id}?token=${before}`)).status).toBe(404);
			// The form's key is not the one the backup held: the restore made a new one (card 2750).
			expect(requestKeysHere().formKey).toHaveLength(1);
			expect(requestKeysHere().formKey).not.toContain(FORM_KEY);
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
					headers: confirmedImport(),
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

	// Card 2675, decision 13 (R8): a restore ends every personal decision link
	// and records it on each decision that is not a draft, and never commits a
	// decision's record in part. The cases are that plan's, section 6.
	describe('of decisions (card 2675)', () => {
		const eventsIn = (database: Database.Database) =>
			database
				.prepare('SELECT decision_id, participant_id, kind, detail, actor_user_id, actor_name, source FROM decision_events ORDER BY id')
				.all() as Record<string, unknown>[];

		it('empties every link, drafts’ included, and records link_revoked by DumpFire only on the decision that is not a draft (76)', () => {
			const open = makeDecision({ status: 'open', closesAt: '2099-01-01 00:00:00' });
			const holders = [makeParticipant(open, { token: 'first-token' }), makeParticipant(open, { token: 'second-token' })];
			const without = makeParticipant(open);
			const draft = makeDecision();
			const drafted = makeParticipant(draft, { linkTokenHash: 'hand-set-hash-on-a-draft', linkIssuedAt: '2026-11-01 09:00:00' });
			const live = migratedDb();

			const result = restoreFromBackup(live, opening(Buffer.from(sqlite.serialize())));

			expect(result.errors).toEqual([]);
			expect(result.restored.decision_participants).toBe(4);
			expect(result.decisionLinksCleared).toBe(3);
			expect(column(live, 'SELECT link_token_hash FROM decision_participants WHERE link_token_hash IS NOT NULL OR link_issued_at IS NOT NULL')).toEqual([]);
			const record = { kind: 'link_revoked', detail: '{"reason":"restore"}', actor_user_id: null, actor_name: 'DumpFire', source: 'system' };
			expect(eventsIn(live)).toEqual(holders.map((p) => ({ decision_id: open.id, participant_id: p.id, ...record })));
			// Comment 5599: no event names a draft's participant, nor one with no link.
			expect(eventsIn(live).map((event) => event.participant_id)).not.toContain(drafted.id);
			expect(eventsIn(live).map((event) => event.participant_id)).not.toContain(without.id);
			// The backup was only read: its hashes are as they were.
			expect(column(sqlite, 'SELECT COUNT(*) FROM decision_participants WHERE link_token_hash IS NOT NULL')).toEqual([3]);
		});

		it('is refused and rolled back, naming decision_events, when a row of the record cannot be copied, and the database is as it was (77)', () => {
			const live = migratedDb();
			live.exec(`
				INSERT INTO users (id, username, email, password_hash, role) VALUES (9, 'here', 'here@example.test', 'x', 'superadmin');
				INSERT INTO decisions (id, board_name, title, author_name, status) VALUES (5, 'A board', 'Here before', 'here', 'open');
				INSERT INTO decision_events (decision_id, kind, actor_name, source) VALUES (5, 'opened', 'here', 'ui');
			`);
			const asItIs = () => ({
				users: column<string>(live, 'SELECT username FROM users ORDER BY id'),
				decisions: live.prepare('SELECT * FROM decisions ORDER BY id').all(),
				events: eventsIn(live)
			});
			const before = asItIs();
			// A backup whose events table lets a row with no kind in: the running
			// database's own NOT NULL refuses it, and the copy leaves it out.
			const backup = backupWithSignIns();
			backup.exec(`
				INSERT INTO decisions (id, board_name, title, author_name, status) VALUES (1, 'From the backup', 'A decision', 'ann', 'open');
				DROP TABLE decision_events;
				CREATE TABLE decision_events (id INTEGER PRIMARY KEY, decision_id INTEGER, participant_id INTEGER, kind TEXT,
					version_number INTEGER, detail TEXT, actor_user_id INTEGER, actor_name TEXT, source TEXT, created_at TEXT);
				INSERT INTO decision_events (id, decision_id, kind, actor_name, source, created_at) VALUES
					(1, 1, 'opened', 'ann', 'ui', '2026-11-01 09:00:00'),
					(2, 1, NULL, 'ann', 'ui', '2026-11-01 09:00:01');
			`);

			const thrown = (() => {
				try {
					restoreFromBackup(live, backup);
					return null;
				} catch (caught) {
					return caught;
				}
			})();

			expect(thrown).toBeInstanceOf(RestoreError);
			expect((thrown as RestoreError).committed).toBe(false);
			expect((thrown as RestoreError).message).toMatch(
				/^The restore failed and nothing was changed: decision records could not be copied whole \(decision_events\): a partial record would be a false one \(decision_events row \(id 2\): NOT NULL constraint failed: decision_events\.kind\)$/
			);
			expect(asItIs()).toEqual(before);
			expect(column(live, 'SELECT title FROM decisions')).toEqual(['Here before']);
			expect(live.pragma('foreign_keys', { simple: true })).toBe(1);

			// F8: a NULL in a record column with a default is not given it, so that row is left out and refused the same way.
			backup.exec("UPDATE decision_events SET kind = 'opened', created_at = NULL WHERE id = 2");
			expect(() => restoreFromBackup(live, backup)).toThrow(/decision records could not be copied whole \(decision_events\).*NOT NULL constraint failed: decision_events\.created_at/);
			expect(asItIs()).toEqual(before);
		});

		// Card 2697 (Q15, case 46): the import's answers say how many personal
		// decision links the restore cancelled, and, above none, that their
		// holders are sent new ones by Resend.
		const SENTENCE =
			"personal decision link(s) cancelled: a link mailed before this restore no longer works, and the decision's " +
			'author, decider or an administrator can send its holder a new one with Resend.';
		/** This database, as a backup of it, with `links` live personal links on an open decision. */
		const withDecisionLinks = (links: number) => {
			const open = makeDecision({ status: 'open', closesAt: '2099-01-01 00:00:00' });
			for (let n = 0; n < links; n++) makeParticipant(open, { token: `a-decision-link-${n}` });
			makeParticipant(open);
			return opening(Buffer.from(sqlite.serialize()));
		};
		const importAnswer = (backup: Database.Database) =>
			importing(async () => {
				const res = await api('POST', '/api/admin/import?outside=keep', { user: chief, headers: confirmedImport(), body: backup.serialize() });
				return { status: res.status, message: res.body.message as string, body: res.body };
			});

		it.each([
			['two links cancelled, with its sentence', 2],
			['none cancelled, with the figure and no sentence', 0]
		])('says through the route %s (46)', async (_name, links) => {
			const res = await importAnswer(withDecisionLinks(links));

			expect(res.status, res.message).toBe(200);
			expect(res.body.decisionLinksCleared).toBe(links);
			if (links > 0) expect(res.message).toContain(`${links} ${SENTENCE}`);
			else expect(res.message).not.toContain('personal decision link');
		});

		it('says it too on a restore that committed and then failed (46)', async () => {
			const backup = withDecisionLinks(1);
			// The restore commits, and then the connection's foreign keys do not come back on: a RestoreError that committed.
			const real = sqlite.pragma.bind(sqlite) as Database.Database['pragma'];
			vi.spyOn(sqlite, 'pragma').mockImplementation(((source: string, options?: Database.PragmaOptions) =>
				/^foreign_keys\s*=\s*ON$/i.test(source) ? [] : real(source, options)) as typeof sqlite.pragma);

			const failed = await importAnswer(backup);
			vi.mocked(sqlite.pragma).mockRestore();

			expect(failed.status, failed.message).toBe(500);
			expect(failed.body.committed).toBe(true);
			expect(failed.body.decisionLinksCleared).toBe(1);
			expect(failed.message).toContain(`1 ${SENTENCE}`);
		});

		// Card 2995 (test 23): the import's answer and its CRITICAL line say how many API keys ended here were left out,
		// the line's details naming them by id, and neither naming an account.
		const LEFT_OUT =
			'1 API key(s) in the backup were left out, because each was revoked or ended on this server, was gone from it before ' +
			"endings were recorded, or is named by the record of ended keys of a backup imported here before, another server's among " +
			'them: none of them works, and their holders make new ones on the Account page.';
		const criticalSince = (from: number) =>
			sqlite.prepare("SELECT message, meta FROM system_logs WHERE context = 'IMPORT' AND level = 'CRITICAL' AND id > ? ORDER BY id").get(from) as {
				message: string;
				meta: string;
			};
		const newestLine = () => sqlite.prepare('SELECT COALESCE(MAX(id), 0) FROM system_logs').pluck().get() as number;

		it('test 23: a key revoked since the backup: the answer’s sentence and figures, and the CRITICAL line’s count and ids, naming no account', async () => {
			const ann = makeUser({ username: 'ann-of-2995' });
			const K = makeApiKeyRow(ann);
			const backup = opening(generateBackupData());
			expect((await api('DELETE', `/api/account/api-keys/${K.id}`, { user: ann })).status).toBe(200);
			const from = newestLine();

			const res = await importAnswer(backup);

			expect(res.status, res.message).toBe(200);
			expect(res.body.apiKeysLeftOut).toBe(1);
			expect(res.body.keysLeftOut).toBe(LEFT_OUT);
			expect(res.message).toContain(LEFT_OUT);
			const line = criticalSince(from);
			expect(line.message).toContain('restored as it is, leaving out 1 API key(s) ended on this server. The system log was kept as it was;');
			expect(JSON.parse(line.meta).apiKeysLeftOut).toEqual({ count: 1, keyIds: [K.id], workingCopy: 0, unsealed: 0 });
			expect(`${line.message} ${line.meta} ${res.body.keysLeftOut}`).not.toContain('ann-of-2995');
		});

		it('test 23: none left out: no sentence, a figure of 0, and the line as before', async () => {
			makeApiKeyRow(makeUser({ username: 'ann-of-2995' }));
			const backup = opening(generateBackupData());
			const from = newestLine();

			const res = await importAnswer(backup);

			expect(res.status, res.message).toBe(200);
			expect(res.body.apiKeysLeftOut).toBe(0);
			expect(res.body.keysLeftOut).toBeUndefined();
			expect(res.message).not.toContain('API key(s) in the backup were left out');
			const line = criticalSince(from);
			expect(line.message).toContain('restored as it is. The system log was kept as it was;');
			expect(JSON.parse(line.meta)).not.toHaveProperty('apiKeysLeftOut');
		});

		it('test 23: a restore that committed and then failed says it too', async () => {
			const ann = makeUser({ username: 'ann-of-2995' });
			const K = makeApiKeyRow(ann);
			const backup = opening(generateBackupData());
			expect((await api('DELETE', `/api/account/api-keys/${K.id}`, { user: ann })).status).toBe(200);
			const from = newestLine();
			const real = sqlite.pragma.bind(sqlite) as Database.Database['pragma'];
			vi.spyOn(sqlite, 'pragma').mockImplementation(((source: string, options?: Database.PragmaOptions) =>
				/^foreign_keys\s*=\s*ON$/i.test(source) ? [] : real(source, options)) as typeof sqlite.pragma);

			const failed = await importAnswer(backup);
			vi.mocked(sqlite.pragma).mockRestore();

			expect(failed.status, failed.message).toBe(500);
			expect(failed.body.committed).toBe(true);
			expect(failed.body.apiKeysLeftOut).toBe(1);
			expect(failed.body.keysLeftOut).toBe(LEFT_OUT);
			expect(failed.message).toContain(LEFT_OUT);
			expect(JSON.parse(criticalSince(from).meta).apiKeysLeftOut).toEqual({ count: 1, keyIds: [K.id], workingCopy: 0, unsealed: 0 });
		});

		// Card 3009 (R4, w5): the mail, App URL and destinations an unsealed backup brought in, held for review, counted in the
		// answer, in the sentence the panel shows (settingsHeld) and in the CRITICAL line, naming none.
		const HELD_UNSEALED =
			"The backup's seal did not verify, so the mail settings and the App URL it brought in, at places this server did not hold, were held " +
			"for the superadmin's review: nothing is sent through them, and no link begins with the App URL, until the superadmin checks each and " +
			'keeps or removes it under Settings held for review.';

		it('(w5) card 3009, R4: the settings an unsealed backup brought in, held, are counted in the answer, the panel’s sentence and the CRITICAL line, naming none', async () => {
			makeSmtp();
			const backup = opening(generateBackupData());
			backup.prepare("UPDATE settings SET value = 'relay.planted.test' WHERE key = 'smtp_host'").run();
			backup.prepare("INSERT INTO settings (key, value) VALUES ('app_url', 'https://planted.example.test')").run();
			const from = newestLine();

			const res = await importAnswer(backup);

			expect(res.status, res.message).toBe(200);
			expect(res.body.unsealedHeld).toEqual({ mail: 1, destinations: 0, appUrl: 1 });
			expect(res.body.settingsHeld).toBe(HELD_UNSEALED);
			expect(res.message).toContain(HELD_UNSEALED);
			const line = criticalSince(from);
			expect(line.message).toContain(", holding 2 setting(s) of a backup whose seal did not verify for the superadmin's review");
			expect(JSON.parse(line.meta).unsealedHeld).toEqual({ mail: 1, destinations: 0, appUrl: 1 });
			for (const said of [res.message, line.message, line.meta]) {
				expect(said).not.toContain('relay.planted.test');
				expect(said).not.toContain('planted.example.test');
			}
		});

		// Card 3009 (x): the words of an unsealed import, counts only: no username, id or key prefix (card 2997's FP14).
		const UNSEALED_PASSWORDS =
			"1 account(s) in the backup are not on this server as the same account, and the backup's seal did not verify, so the password each " +
			'holds in it was not taken: each needs its password set (🔑) or an invite (📧) before it can sign in, and its report schedules were ' +
			"paused. The backup's App URL and mail host, where they differ from this server's, are held for review. Before sending an invite, " +
			"check each one's email address and role, and the App URL and the mail host: in a backup whose seal did not verify they are only the " +
			"file's word. Or set its password with 🔑, which mails nothing.";
		const UNSEALED_KEYS =
			"1 API key(s) in the backup were left out, because the backup's seal did not verify and this server did not hold them for the same " +
			'account: none of them works, and their holders make new ones on the Account page.';
		const UNSEALED_WORDS =
			"restored as it is, keeping 1 of the backup's password(s) out of use, leaving out 1 API key(s) of a backup whose seal did not verify. The system log was kept as it was;";
		/** This server's own backup with an administrator it never held, and a key planted on the member, which is here. */
		const plantedBackup = () => {
			const backup = opening(generateBackupData());
			backup
				.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES (90, 'planted-of-3009', 'planted-of-3009@example.test', ?, 'admin')")
				.run(fixtureHashOf(member));
			const made = generateApiKey();
			backup.prepare('INSERT INTO api_keys (id, key_hash, key_prefix, name, user_id) VALUES (900, ?, ?, ?, ?)').run(made.keyHash, made.keyPrefix, 'Planted', member.id);
			return { backup, prefix: made.keyPrefix };
		};
		/** Whether `said` names the planted account or key in any form a line names one by. */
		const namesPlanted = (said: string, prefix: string) =>
			said.includes('planted-of-3009') || said.includes(prefix) || new RegExp(`(\\b(user|account|id|key)\\s*[#:=]?\\s*|#|"\\w*id"\\s*:\\s*"?)(90|900)\\b`, 'i').test(said);

		it('(x) card 3009: an unsealed import’s sentences, figures and CRITICAL words and details count the passwords and keys not taken, naming nobody; the details carry the verdict, never the id', async () => {
			const { backup, prefix } = plantedBackup();
			const id = sqlite.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(INSTALLATION_ID) as string;
			const from = newestLine();

			const res = await importAnswer(backup);

			expect(res.status, res.message).toBe(200);
			expect(res.body.passwordsKept).toEqual({ here: 0, reset: 0, superadmin: 0, unsealed: 1, superadminGivenYours: 0, givenYoursWithoutFactor: 0, givenYoursMayEnrol: 0, emailGivenUp: 0 });
			expect(res.body.accountsKeptLines).toEqual([UNSEALED_PASSWORDS]);
			expect(res.body.keysLeftOut).toBe(UNSEALED_KEYS);
			expect(res.message).toContain(UNSEALED_KEYS);
			expect(res.message).toContain(UNSEALED_PASSWORDS);
			const line = criticalSince(from);
			expect(line.message).toContain(UNSEALED_WORDS);
			const meta = JSON.parse(line.meta);
			expect(meta.installation).toBe('this');
			expect(meta.passwordsKept).toMatchObject({ unsealed: 1 });
			expect(meta.apiKeysLeftOut).toEqual({ count: 0, keyIds: [], workingCopy: 0, unsealed: 1 });
			const said = `${res.message} ${line.message} ${line.meta} ${res.body.accountsKeptLines.join(' ')}`;
			expect(namesPlanted(said, prefix)).toBe(false);
			expect(said).not.toContain(id);
		});

		it('(x) card 3009: a sealed import says none of it, and its CRITICAL line carries no verdict', async () => {
			const backup = opening(generateBackupData());
			const from = newestLine();

			const res = await importAnswer(backup);

			expect(res.status, res.message).toBe(200);
			expect(res.body.passwordsKept).toBeUndefined();
			expect(res.body.keysLeftOut).toBeUndefined();
			expect(res.message).not.toContain('seal did not verify');
			const line = criticalSince(from);
			expect(line.message).toContain('restored as it is. The system log was kept as it was;');
			expect(JSON.parse(line.meta)).not.toHaveProperty('installation');
		});

		it('(x) card 3009: a restore that committed and then failed says it too', async () => {
			const { backup, prefix } = plantedBackup();
			const from = newestLine();
			const real = sqlite.pragma.bind(sqlite) as Database.Database['pragma'];
			vi.spyOn(sqlite, 'pragma').mockImplementation(((source: string, options?: Database.PragmaOptions) =>
				/^foreign_keys\s*=\s*ON$/i.test(source) ? [] : real(source, options)) as typeof sqlite.pragma);

			const failed = await importAnswer(backup);
			vi.mocked(sqlite.pragma).mockRestore();

			expect(failed.status, failed.message).toBe(500);
			expect(failed.body.committed).toBe(true);
			expect(failed.body.accountsKeptLines).toEqual([UNSEALED_PASSWORDS]);
			expect(failed.body.keysLeftOut).toBe(UNSEALED_KEYS);
			expect(failed.message).toContain(UNSEALED_PASSWORDS);
			const line = criticalSince(from);
			expect(line.message).toContain(UNSEALED_WORDS);
			expect(JSON.parse(line.meta).installation).toBe('this');
			expect(namesPlanted(`${failed.message} ${line.message} ${line.meta}`, prefix)).toBe(false);
		});

		// Card 2996 (test 41): the answer, its figures and the CRITICAL line say how many accounts the record of account
		// endings kept ended or lowered, naming no account and no id.
		const DELETED_LINE =
			'1 account(s) in the backup are named as deleted by the record of account endings: each is kept disabled, with no password or second ' +
			'factor that works, and cannot be enabled again. Delete each on the Users page before making a new account for anyone who returns: its ' +
			'username and email address would otherwise block the new one.';
		const LOWERED_LINE = '1 account(s) in the backup were given back the lower role the record of account endings holds.';
		/** An account deleted and an administrator made a user since the backup, through the routes. */
		const endedSinceBackup = async () => {
			const xen = makeUser({ username: 'xen-of-2996' });
			const ada = makeUser({ username: 'ada-of-2996', role: 'admin' });
			const backup = opening(generateBackupData());
			expect((await api('POST', `/api/users/${xen.id}/disable`, stepUp(chief))).status).toBe(200);
			expect((await api('DELETE', `/api/users/${xen.id}`, stepUp(chief))).status).toBe(200);
			expect((await api('PUT', `/api/users/${ada.id}`, stepUp(chief, { role: 'user' }))).status).toBe(200);
			return { backup, xen, ada };
		};

		it('test 41: an account deleted and one demoted since the backup: the answer’s lines and figures, and the CRITICAL line’s words and counts, naming nobody', async () => {
			const { backup, xen, ada } = await endedSinceBackup();
			const from = newestLine();

			const res = await importAnswer(backup);

			expect(res.status, res.message).toBe(200);
			expect(res.body.accountsKept).toEqual({ deleted: 1, beforeRecord: 0, disabled: 0, lowered: 1 });
			expect(res.body.accountsKeptLines).toEqual([DELETED_LINE, LOWERED_LINE]);
			expect(res.message).toContain(`${DELETED_LINE} ${LOWERED_LINE}`);
			const line = criticalSince(from);
			expect(line.message).toContain('restored as it is, keeping 2 account(s) ended or lowered as the record of account endings says. The system log was kept as it was;');
			expect(JSON.parse(line.meta).accountsKept).toEqual({ deleted: 1, beforeRecord: 0, disabled: 0, lowered: 1 });
			const said = `${line.message} ${line.meta} ${res.body.accountsKeptLines.join(' ')}`;
			for (const name of ['xen-of-2996', 'ada-of-2996']) expect(said).not.toContain(name);
			expect(said).not.toMatch(new RegExp(`\\b(${xen.id}|${ada.id})\\b`));
		});

		it('test 41: none kept: no line, counts of 0, and the CRITICAL line as before', async () => {
			makeUser({ username: 'xen-of-2996' });
			const backup = opening(generateBackupData());
			const from = newestLine();

			const res = await importAnswer(backup);

			expect(res.status, res.message).toBe(200);
			expect(res.body.accountsKept).toEqual({ deleted: 0, beforeRecord: 0, disabled: 0, lowered: 0 });
			expect(res.body.accountsKeptLines).toBeUndefined();
			expect(res.message).not.toContain('record of account endings');
			const line = criticalSince(from);
			expect(line.message).toContain('restored as it is. The system log was kept as it was;');
			expect(JSON.parse(line.meta)).not.toHaveProperty('accountsKept');
		});

		it('test 41 (FP3): a backup whose record holds more than 100 rows for one account: the answer’s figure and the CRITICAL line count the rows left out, naming nobody', async () => {
			const xen = makeUser({ username: 'xen-of-2996' });
			const backup = opening(generateBackupData());
			backup.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 101) INSERT INTO account_endings (user_id, account_created, ending, ended_at) ` +
					`SELECT ${xen.id}, (SELECT created_at FROM users WHERE id = ${xen.id}), 'disabled', '2026-11-19 09:00:00' FROM n`
			);
			const from = newestLine();

			const res = await importAnswer(backup);

			expect(res.status, res.message).toBe(200);
			expect(res.body.accountRecordLeftOut).toBe(101);
			const line = criticalSince(from);
			expect(line.message).toContain("restored as it is, the backup's record of account endings (101 row(s)) left out for its size. The system log was kept as it was;");
			expect(JSON.parse(line.meta).accountRecordLeftOut).toBe(101);
			expect(`${line.message} ${line.meta}`).not.toContain('xen-of-2996');
		});

		it('test 41: a restore that committed and then failed says it too', async () => {
			const { backup } = await endedSinceBackup();
			const from = newestLine();
			const real = sqlite.pragma.bind(sqlite) as Database.Database['pragma'];
			vi.spyOn(sqlite, 'pragma').mockImplementation(((source: string, options?: Database.PragmaOptions) =>
				/^foreign_keys\s*=\s*ON$/i.test(source) ? [] : real(source, options)) as typeof sqlite.pragma);

			const failed = await importAnswer(backup);
			vi.mocked(sqlite.pragma).mockRestore();

			expect(failed.status, failed.message).toBe(500);
			expect(failed.body.committed).toBe(true);
			expect(failed.body.accountsKept).toEqual({ deleted: 1, beforeRecord: 0, disabled: 0, lowered: 1 });
			expect(failed.body.accountsKeptLines).toEqual([DELETED_LINE, LOWERED_LINE]);
			expect(failed.message).toContain(DELETED_LINE);
			expect(JSON.parse(criticalSince(from).meta).accountsKept).toEqual({ deleted: 1, beforeRecord: 0, disabled: 0, lowered: 1 });
		});

		// Card 2997 (bb): the answer, its figures and the CRITICAL line say how many of the backup's passwords were kept out
		// of use, and how many superadmins were left with one to change, naming no account and no id.
		const PASSWORD_HERE_LINE =
			"1 account(s) in the backup hold a password that was changed on this server after the backup was made, or, where the backup's seal did " +
			'not verify, any other than the one each has on this server: each keeps the password it has on this server, and the one in the backup ' +
			'does not work.';
		const PASSWORD_RESET_LINE =
			"1 account(s) in the backup hold a password that was replaced on this server, or, where the backup's seal did not verify, any other than " +
			'the one each has on this server, and have no password on this server that can be given back to them: none of those passwords works, and ' +
			'each account needs its password set (🔑) or an invite (📧; for a superadmin, 🔑 by another superadmin) before it can sign in.';
		const PASSWORD_SUPERADMIN_LINE =
			"1 superadmin account(s) were left with a password that was replaced on this server, or, where the backup's seal did not verify, one " +
			"other than this server's, so that a superadmin can still sign in: sign in and change it on the Account page at once.";
		const ALL_KEPT = { here: 1, reset: 1, superadmin: 1, unsealed: 0, superadminGivenYours: 0, givenYoursWithoutFactor: 0, givenYoursMayEnrol: 0, emailGivenUp: 0 };
		/**
		 * Since this server's sealed backup: Alma's password changed here; Bea's replaced here and Bea gone, with no row that
		 * names her deleted; and the superadmin's own password recorded as replaced, as a host file rollback leaves it.
		 */
		const passwordsSinceBackup = () => {
			const alma = makeUser({ username: 'alma-of-2997' });
			const bea = makeUser({ username: 'bea-of-2997' });
			const backup = opening(generateBackupData());
			inTransaction(() => {
				expect(recordPasswordReplaced(sqlite, alma.id)).toBe(true);
				sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSync('the new password of card 2997', 4), alma.id);
				expect(recordPasswordReplaced(sqlite, bea.id)).toBe(true);
				expect(recordPasswordReplaced(sqlite, chief.id)).toBe(true);
			});
			sqlite.pragma('foreign_keys = OFF');
			try {
				for (const table of ['mfa_factors', 'mfa_recovery_codes', 'api_keys', 'report_schedules']) sqlite.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(bea.id);
				sqlite.prepare('DELETE FROM users WHERE id = ?').run(bea.id);
			} finally {
				sqlite.pragma('foreign_keys = ON');
			}
			return { backup, alma, bea };
		};

		it('(bb) card 2997: a password changed here, one replaced on an account gone and the superadmin’s: the answer’s sentences and figures, and the CRITICAL line’s words and counts, naming nobody', async () => {
			const { backup, alma, bea } = passwordsSinceBackup();
			const from = newestLine();

			const res = await importAnswer(backup);

			expect(res.status, res.message).toBe(200);
			expect(res.body.passwordsKept).toEqual(ALL_KEPT);
			expect(res.body.accountsKeptLines).toEqual([PASSWORD_HERE_LINE, PASSWORD_RESET_LINE, PASSWORD_SUPERADMIN_LINE]);
			expect(res.message).toContain(`${PASSWORD_HERE_LINE} ${PASSWORD_RESET_LINE} ${PASSWORD_SUPERADMIN_LINE}`);
			const line = criticalSince(from);
			expect(line.message).toContain(
				"restored as it is, keeping 2 of the backup's password(s) out of use, leaving 1 superadmin account(s) with a password to change at once. The system log was kept as it was;"
			);
			expect(JSON.parse(line.meta).passwordsKept).toEqual(ALL_KEPT);
			const said = `${line.message} ${line.meta} ${res.body.accountsKeptLines.join(' ')}`;
			for (const name of ['alma-of-2997', 'bea-of-2997']) expect(said).not.toContain(name);
			// An id in any form a line names an account by ("user N", "account N", "id N", "#N", "userId":N), never a bare
			// number, which a count such as "1 account(s)" would match (the code review's FP14).
			expect(said).not.toMatch(new RegExp(`(\\b(user|account|id)\\s*[#:=]?\\s*|#|"\\w*id"\\s*:\\s*"?)(${alma.id}|${bea.id})\\b`, 'i'));
		});

		it('(bb) card 2997: none kept: no sentence, no figure, and the CRITICAL line as before', async () => {
			makeUser({ username: 'alma-of-2997' });
			const backup = opening(generateBackupData());
			const from = newestLine();

			const res = await importAnswer(backup);

			expect(res.status, res.message).toBe(200);
			expect(res.body).not.toHaveProperty('passwordsKept');
			expect(res.body.accountsKeptLines).toBeUndefined();
			expect(res.message).not.toContain('password that was');
			const line = criticalSince(from);
			expect(line.message).toContain('restored as it is. The system log was kept as it was;');
			expect(JSON.parse(line.meta)).not.toHaveProperty('passwordsKept');
		});

		it('(bb) card 2997: a restore that committed and then failed says it too', async () => {
			const { backup } = passwordsSinceBackup();
			const from = newestLine();
			const real = sqlite.pragma.bind(sqlite) as Database.Database['pragma'];
			vi.spyOn(sqlite, 'pragma').mockImplementation(((source: string, options?: Database.PragmaOptions) =>
				/^foreign_keys\s*=\s*ON$/i.test(source) ? [] : real(source, options)) as typeof sqlite.pragma);

			const failed = await importAnswer(backup);
			vi.mocked(sqlite.pragma).mockRestore();

			expect(failed.status, failed.message).toBe(500);
			expect(failed.body.committed).toBe(true);
			expect(failed.body.passwordsKept).toEqual(ALL_KEPT);
			expect(failed.body.accountsKeptLines).toEqual([PASSWORD_HERE_LINE, PASSWORD_RESET_LINE, PASSWORD_SUPERADMIN_LINE]);
			expect(failed.message).toContain(PASSWORD_RESET_LINE);
			const line = criticalSince(from);
			expect(line.message).toContain("keeping 2 of the backup's password(s) out of use, leaving 1 superadmin account(s) with a password to change at once");
			expect(JSON.parse(line.meta).passwordsKept).toEqual(ALL_KEPT);
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
				// The superadmin's confirmed first (card 2701); anybody else's is refused before it is looked for.
				headers: by === chief ? confirmedImport() : { 'content-type': 'application/octet-stream' },
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
		const backup = sealedFor(sqlite, backupWithSignIns());
		await routeMethods('/api/admin/import');
		const dir = mkdtempSync(join(tmpdir(), 'dumpfire-import-'));
		tempDirs.push(dir);
		vi.spyOn(process, 'cwd').mockReturnValue(dir);
		const cookie = `${SESSION_COOKIE_NAME}=${chiefSession}`;

		// Through the gate, as the page sends it, with the superadmin's session,
		// their password confirmed first there (card 2701).
		const res = await gate('POST', '/api/admin/import?outside=keep', {
			headers: { ...confirmedImport(), cookie, ...FROM_THE_PAGE, accept: '*/*' },
			body: new Uint8Array(backup.serialize())
		});
		const answer = await res.json();

		expect(res.status).toBe(200);
		expect(answer.message).toContain(SIGNED_OUT);
		// The used invite, with 0068's token in place of the one it was mailed with (card 2849).
		expect(signInsHere().sessions).toEqual([]);
		expect(sqlite.prepare('SELECT typeof(token) AS type, length(token) AS bytes FROM invite_tokens').all()).toEqual([{ type: 'blob', bytes: 32 }]);
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
				headers: confirmedImport('Application/Octet-Stream; charset=binary'),
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
	it('writes a safety copy that leaves out every signing key, and keeps every other setting', async () => {
		sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(KNOWN_BROWSER_SECRET_KEY, 'the-key-that-was-here');
		sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('app_url', 'https://here.example.test');
		// Nor the key webhook address matches are made with (card 2928, case 45, R14).
		sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(WEBHOOK_ADDRESS_MAC_KEY, 'the-address-key-that-was-here');
		// Nor the backup seal key, nor the request form's (card 2943, R8; card test 2): every signing key.
		backupSealKey(sqlite);
		const sealKey = sealKeyHere(sqlite)!;
		const formKey = column<string>(sqlite, `SELECT value FROM settings WHERE key = '${REQUEST_FORM_SECRET_KEY}'`)[0];

		const res = await importDb(migratedDb());

		expect(res.status).toBe(200);
		const safety = readFileSync(join(res.dir, '.pre-restore-safety.json'), 'utf8');
		const keys = (JSON.parse(safety) as { settings: { key: string }[] }).settings.map((row) => row.key);
		for (const setting of SIGNING_KEY_SETTINGS) expect(keys, setting).not.toContain(setting);
		expect(safety).not.toContain('the-key-that-was-here');
		expect(safety).not.toContain('the-address-key-that-was-here');
		expect(safety).not.toContain(sealKey.stored);
		expect(safety).not.toContain(sealKey.key);
		expect(safety).not.toContain(formKey);
		const settings = (JSON.parse(safety) as { settings: { key: string; value: string }[] }).settings;
		expect(settings).toContainEqual(expect.objectContaining({ key: 'app_url', value: 'https://here.example.test' }));
	});

	// Card 2925. A full-suite run found the temporary working directory a test
	// had made gone by the time the import wrote into it. For a database in
	// memory the import makes that folder; for a database file it never makes
	// the database's own folder. A write it cannot make is refused in words,
	// naming no path, and nothing is changed.
	describe('that cannot write one of its files (card 2925)', () => {
		/** A backup with one board, sent by the superadmin once `prepare` has had the working directory. */
		const importAfter = (prepare: (dir: string) => void) =>
			importing(async (dir) => {
				const backup = migratedDb();
				backup.exec("INSERT INTO boards (id, name) VALUES (1, 'From the backup')");
				prepare(dir);
				const res = await api('POST', '/api/admin/import?outside=keep', { user: chief, headers: confirmedImport(), body: backup.serialize() });
				return { status: res.status, message: res.body.message as string };
			});

		it('makes the working directory again when the database is in memory and it is gone', async () => {
			const res = await importAfter((dir) => rmSync(dir, { recursive: true }));

			expect([res.status, res.message]).toEqual([200, expect.stringContaining(SIGNED_OUT)]);
			expect(column(sqlite, 'SELECT name FROM boards')).toEqual(['From the backup']);
			// Made again, with the safety copy in it and the working copy gone.
			expect(readdirSync(res.dir)).toEqual(['.pre-restore-safety.json']);
		});

		it("never makes a database file's folder: one that is missing is refused in the ruled words", async () => {
			const before = snapshotDb();
			const from = lastLineId();
			let gone = '';

			const res = await importAfter((dir) => {
				gone = join(dir, 'gone');
				vi.spyOn(connection, 'getDbPath').mockReturnValue(join(gone, 'dumpfire.db'));
			});

			expect({ status: res.status, message: res.message }).toEqual({
				status: 500,
				message: 'The import could not write its working copy beside the database. Nothing was changed.'
			});
			expect(existsSync(gone)).toBe(false);
			expectNothingWritten(before, res.dir);
			// The CRITICAL line keeps the error, path and all.
			const critical = importLinesSince(from).filter((line) => line.level === 'CRITICAL');
			expect(critical).toHaveLength(1);
			expect(critical[0].message).toContain(join(gone, 'dumpfire.db.restore-temp'));
		});

		it('refuses a working copy it cannot write, naming no path, and changes nothing', async () => {
			const before = snapshotDb();

			const res = await importAfter((dir) => mkdirSync(join(dir, '.restore-temp.db')));

			expect(res.status).toBe(500);
			// A folder in the way is said in words (the code review's F5).
			expect(res.message).toBe(
				'The import could not write its working copy beside the database (something else is in the way). Nothing was changed.'
			);
			expect(res.message).not.toContain(res.dir);
			expectUnchanged(before);
			expect(readdirSync(res.dir)).toEqual(['.restore-temp.db']);
		});

		// The code review's F1 and F2: a file the write could not open is not
		// its own, and is never removed. Root opens a read-only file all the same.
		it.skipIf(process.getuid?.() === 0)('leaves a file it could not open as it was', async () => {
			const before = snapshotDb();
			let stale = '';

			const res = await importAfter((dir) => {
				stale = join(dir, '.restore-temp.db');
				writeFileSync(stale, 'left by an earlier import');
				chmodSync(stale, 0o444);
			});

			try {
				expect({ status: res.status, message: res.message }).toEqual({
					status: 500,
					message: 'The import could not write its working copy beside the database (the server may not write there). Nothing was changed.'
				});
				expectUnchanged(before);
				expect(readFileSync(stale, 'utf8')).toBe('left by an earlier import');
			} finally {
				if (existsSync(stale)) chmodSync(stale, 0o644);
			}
		});

		it('refuses a safety copy it cannot write, naming no path, before anything is replaced', async () => {
			const before = snapshotDb();
			const from = lastLineId();

			const res = await importAfter((dir) => mkdirSync(join(dir, '.pre-restore-safety.json')));

			expect(res.status).toBe(500);
			expect(res.message).toMatch(
				/^Restore failed: The import could not write the safety copy of this server's data beside the database \(.+\)\. Nothing was changed\.$/
			);
			expect(res.message).not.toContain(res.dir);
			expectUnchanged(before);
			// The working copy is gone again, and so is the safety copy's temporary
			// file, written and then refused its rename over the folder (the code
			// review's F3): the folder in the way is all there is.
			expect(readdirSync(res.dir)).toEqual(['.pre-restore-safety.json']);
			// Its CRITICAL line keeps the error, path and all, in its message and
			// as its details (the code review's F7).
			const critical = importLinesSince(from).filter((line) => line.level === 'CRITICAL');
			expect(critical).toHaveLength(1);
			expect(critical[0].message).toContain(res.dir);
			expect(critical[0].meta).toContain(JSON.stringify(res.dir).slice(1, -1));
		});

		// The code review's F3: the safety copy goes through a temporary name, so
		// one that cannot be written leaves an earlier import's copy as it was.
		it("keeps an earlier import's safety copy when the new one cannot be written", async () => {
			const before = snapshotDb();

			const res = await importAfter((dir) => {
				writeFileSync(join(dir, '.pre-restore-safety.json'), '{"earlier":true}');
				mkdirSync(join(dir, '.pre-restore-safety.json.tmp'));
			});

			expect(res.status).toBe(500);
			expect(res.message).toBe(
				"Restore failed: The import could not write the safety copy of this server's data beside the database (something else is in the way). Nothing was changed."
			);
			expectUnchanged(before);
			expect(readFileSync(join(res.dir, '.pre-restore-safety.json'), 'utf8')).toBe('{"earlier":true}');
			expect(readdirSync(res.dir).sort()).toEqual(['.pre-restore-safety.json', '.pre-restore-safety.json.tmp']);
		});
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
			-- In plain, on purpose: a database from before card 2775; a restore clears its sessions whatever their form.
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
		// Naming who tried, with their id, which is still theirs: nothing changed (card 2899, case 5).
		const refused = sqlite.prepare("SELECT message, user_id AS userId FROM system_logs WHERE context = 'IMPORT'").get() as {
			message: string;
			userId: number | null;
		};
		expect(refused.message).toMatch(new RegExp(` \\(import by chief, user ${chief.id}\\)$`));
		expect(refused.userId).toBe(chief.id);
		expectUnchanged(before);
		expect(signInsHere().sessions).toHaveLength(2);
	});

	// Card 2899 (case 2). An edited backup put its own words in the log, and
	// any import, edited or not, deleted every line written since the backup.
	it('changes no earlier line of the log when an edited backup is imported, and says at CRITICAL who imported which file', async () => {
		sqlite.exec(`
			INSERT INTO system_logs (timestamp, level, context, message, meta, user_id, ip) VALUES
				('2026-11-17 09:00:00', 'WARN', 'AUTH', 'Failed login attempt at "chief" (user ${chief.id}) from IP 203.0.113.7 (bad password)', NULL, ${chief.id}, '203.0.113.7'),
				('2026-11-17 09:05:00', 'INFO', 'ADMIN', 'Settings saved', '{"by":"chief"}', ${chief.id}, NULL),
				('2026-11-17 09:10:00', 'CRITICAL', 'ADMIN', 'Exported a backup', NULL, ${chief.id}, NULL);
		`);
		const everyLine = () => sqlite.prepare('SELECT * FROM system_logs ORDER BY id').all() as { id: number }[];
		const before = everyLine();
		// This server's own backup, then edited: a line rewritten, one deleted
		// and one added, which breaks its seal.
		const backup = opening(generateBackupData());
		backup.exec(`
			UPDATE system_logs SET message = 'Nothing happened' WHERE message = 'Exported a backup';
			DELETE FROM system_logs WHERE message = 'Settings saved';
			INSERT INTO system_logs (timestamp, level, context, message) VALUES ('2026-11-17 09:20:00', 'INFO', 'ADMIN', 'Nothing happened either');
		`);
		const held = column<number>(backup, 'SELECT COUNT(*) FROM system_logs')[0];
		const bytes = backup.serialize();

		const { status, body } = await importing(async () => {
			const res = await api('POST', '/api/admin/import?outside=keep', { user: chief, headers: confirmedImport(), body: bytes });
			return { status: res.status, message: res.body.message as string, body: res.body };
		});

		expect(status).toBe(200);
		// Every line written before the import, as it was, and none of the file's.
		const after = everyLine();
		expect(after.slice(0, before.length)).toEqual(before);
		expect(column<number>(sqlite, "SELECT COUNT(*) FROM system_logs WHERE message LIKE 'Nothing happened%'")).toEqual([0]);
		// And one line more: who imported which file, at CRITICAL, the user field empty.
		const added = after.slice(before.length) as unknown as { level: string; context: string; message: string; meta: string; user_id: number | null }[];
		expect(added).toHaveLength(1);
		expect(added[0]).toMatchObject({ level: 'CRITICAL', context: 'IMPORT', user_id: null });
		const sha256 = createHash('sha256').update(bytes).digest('hex');
		expect(added[0].message).toMatch(
			new RegExp(
				`^The database was replaced from an uploaded backup by chief \\(user ${chief.id} before the import\\): [0-9.]+ KB, ` +
					`SHA-256 ${sha256}, a backup whose seal does not check out: changed since, or sealed by another server, restored as it is\\. ` +
					`The system log was kept as it was; the backup's ${held} log line\\(s\\), \\S+ \\S+ to \\S+ \\S+, were not brought in and remain in the file\\.$`
			)
		);
		// With the address it came from, and the check the file failed, none here (the code review's F8).
		expect(JSON.parse(added[0].meta)).toMatchObject({ by: { id: chief.id, username: 'chief' }, ip: '127.0.0.1', sha256, seal: 'failed', check: null, outside: 'keep' });
		// The answer says the same of the log, last, and on its own for the page.
		const said = `The system log was kept as it was: the backup's ${held} log line(s) were not brought in, and remain in the backup file.`;
		expect(body.systemLog).toBe(said);
		expect(body.message.endsWith(said)).toBe(true);
	});

	/** The import's lines under IMPORT written since `from`, with their user and details. */
	const importLinesSince = (from: number) =>
		sqlite
			.prepare("SELECT level, message, meta, user_id AS userId, ip FROM system_logs WHERE context = 'IMPORT' AND id > ? ORDER BY id")
			.all(from) as { level: string; message: string; meta: string | null; userId: number | null; ip: string | null }[];
	const lastLineId = () => sqlite.prepare('SELECT COALESCE(MAX(id), 0) FROM system_logs').pluck().get() as number;

	/** `bytes` sent to the import route by the superadmin, as it is, with WARN lines kept. */
	const importBytesAtWarn = async (bytes: Buffer | Uint8Array) => {
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			return await importing(async () => {
				const res = await api('POST', '/api/admin/import?outside=keep', { user: chief, headers: confirmedImport(), body: bytes });
				return { status: res.status, message: res.body.message as string, body: res.body };
			});
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
	};

	// Card 2899's code review, F2: the backup's times are its own text, and an
	// edited backup can make them anything; they are described, never quoted.
	it('2899 F2. says of a backup log whose times are words that they are in no form this build reads, and quotes none of them', async () => {
		sqlite.prepare("INSERT INTO system_logs (timestamp, level, context, message) VALUES ('2026-11-17 09:00:00', 'INFO', 'ADMIN', 'A line')").run();
		const backup = opening(generateBackupData());
		backup.exec("UPDATE system_logs SET timestamp = 'last Tuesday [CRITICAL] [AUTH] forged'");
		const from = lastLineId();

		const { status } = await importBytesAtWarn(backup.serialize());

		expect(status).toBe(200);
		const [line] = importLinesSince(from).filter((l) => l.level === 'CRITICAL');
		expect(line.message).toContain("the backup's 1 log line(s), at times in no form this build reads, were not brought in and remain in the file.");
		expect(`${line.message} ${line.meta}`).not.toMatch(/Tuesday|forged/);
		expect(JSON.parse(line.meta as string).systemLogLeftOut).toEqual({ lines: 1, first: null, last: null });
	});

	// Card 2899's code review, F5: the backup's log is counted whatever its
	// shape, and one that cannot be counted does not stop the restore.
	it('2899 F5. restores a backup whose system log cannot be read, and says the log could not be counted', async () => {
		const backup = opening(generateBackupData());
		backup.exec('DROP TABLE system_logs; CREATE VIEW system_logs AS SELECT * FROM nowhere');
		const from = lastLineId();

		const { status, body } = await importBytesAtWarn(backup.serialize());

		expect(status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.errors).toEqual([expect.stringMatching(/^The backup's system log, which a restore does not bring in, could not be counted: /)]);
		const [line] = importLinesSince(from).filter((l) => l.level === 'CRITICAL');
		expect(line.message).toContain("the backup's log, which could not be counted, was not brought in and remains in the file.");
		expect(body.systemLog).toBe("The system log was kept as it was: the backup's log was not brought in, and remains in the backup file.");
	});

	// Card 2899's code review, F7: every import that changed nothing names who sent it.
	it('2899 F7. a file that is not a SQLite database is refused with a WARN naming who sent it', async () => {
		const from = lastLineId();

		const { status, message } = await importBytesAtWarn(Buffer.from('not a database at all'));

		expect({ status, message }).toEqual({ status: 400, message: 'Invalid file — not a SQLite database' });
		expect(importLinesSince(from)).toEqual([
			{
				level: 'WARN',
				message: `Import refused: the file is not a SQLite database (import by chief, user ${chief.id})`,
				meta: null,
				userId: chief.id,
				ip: '127.0.0.1'
			}
		]);
	});

	it('2899 F7. a backup with users and no superadmin is refused with a WARN naming who sent it', async () => {
		const backup = migratedDb();
		backup.exec(NOBODY_IN_CHARGE);
		const from = lastLineId();

		const { status } = await importBytesAtWarn(backup.serialize());

		expect(status).toBe(400);
		expect(importLinesSince(from)).toEqual([
			{
				level: 'WARN',
				message: `Import refused: ${NO_SUPERADMIN_IN_BACKUP} (import by chief, user ${chief.id})`,
				meta: null,
				userId: chief.id,
				ip: '127.0.0.1'
			}
		]);
	});

	it('2899 F7. a file that fails before the restore begins is a CRITICAL line naming who sent it, and nothing changes', async () => {
		const before = snapshotDb();
		const from = lastLineId();
		const bytes = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(4096, 7)]);

		const { status, message } = await importBytesAtWarn(bytes);

		expect(status).toBe(500);
		expect(message).toMatch(/^Restore failed: /);
		const lines = importLinesSince(from);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ level: 'CRITICAL', userId: chief.id, ip: '127.0.0.1' });
		expect(lines[0].message).toMatch(new RegExp(`^Database restore failed: .* \\(import by chief, user ${chief.id}\\)$`));
		expectUnchanged(before);
	});

	it('names, in its answer, the superadmin the restored data has', async () => {
		const res = await importing(async () => {
			const answer = await api('POST', '/api/admin/import?outside=keep', {
				user: chief,
				headers: confirmedImport(),
				body: backupWithSignIns().serialize()
			});
			return { status: answer.status, message: answer.body.message, superadmins: answer.body.superadmins };
		});

		expect(res.status).toBe(200);
		expect(res.message).toContain(`${SIGNED_OUT} The superadmin is now ann.`);
		expect(res.superadmins).toEqual(['ann']);

		// And with no users at all, that set-up is open. The restore ended every
		// session, so the superadmin signs in again first: the import checks the
		// session it is sent with (card 2775).
		const empty = migratedDb();
		empty.exec("INSERT INTO boards (id, name) VALUES (1, 'From the backup')");
		chiefSession = makeSession(chief);
		const none = await importing(async () => {
			const answer = await api('POST', '/api/admin/import?outside=keep', {
				user: chief,
				headers: confirmedImport(),
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
			// The restore ended every session: signed in again (card 2775).
			chiefSession = makeSession(chief);
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
		expect(lines()[0].message).toContain('There are 3 user account(s) and none of them is an enabled superadmin');
		expect(lines()[0].message).toContain('docs/deployment.md');
		expect(lines()[0].message).toContain('If nobody can sign in as the superadmin');
	});

	// Card 2671 (case 42, S13, E15): a disabled superadmin cannot sign in, so counts as none.
	it('is said for a database whose only superadmin is disabled, and superadminsOf names that one no more', () => {
		expect(superadminsOf(sqlite)).toHaveLength(1);
		sqlite.prepare("UPDATE users SET disabled_at = '2099-01-01 09:00:00' WHERE role = 'superadmin'").run();

		expect(reportNoSuperadmin()).toBe(true);

		expect(lines().map((line) => line.message)).toEqual([expect.stringContaining('none of them is an enabled superadmin')]);
		expect(superadminsOf(sqlite)).toEqual([]);
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
		// as written (the webhook review, O1), the SFTP destinations with no
		// confirmed host key (card 2250), the App URL saved and not used (card
		// 2847), and the App URL in use not saved by the superadmin (its code
		// review, CS2). The ORIGIN check reads none here.
		expect(said.mock.calls.map(([line]) => String(line))).toEqual([
			'[STARTUP] A check of the installation could not be made: the database is not to be had',
			'[STARTUP] A check of the installation could not be made: the database is not to be had',
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
		old.run('GET /boards → 200 (1ms)', meta('/boards'));
		expect(everyLine()).toContain(UNUSED_INVITE);
		expect(everyLine()).toContain(REQUEST_LINK_TOKEN);

		expect(maskLiveLog()).toBeGreaterThan(0);

		expect(sqlite.prepare('SELECT message, meta FROM system_logs ORDER BY id').all()).toEqual([
			{ message: 'GET /invite/[token] → 200 (3ms)', meta: meta('/invite/[token]') },
			{ message: 'GET /request/7/reply?token=[token] → 200 (2ms)', meta: meta('/request/7/reply?token=[token]&from=mail') },
			{ message: 'GET /boards → 200 (1ms)', meta: meta('/boards') }
		]);
		// Only the log: the invite itself is as it was.
		expect(signInsHere().invites).toEqual([inviteHashOf(USED_INVITE), inviteHashOf(UNUSED_INVITE)].sort(Buffer.compare));

		const masked = everyLine();
		expect(maskLiveLog()).toBe(0);
		expect(everyLine()).toBe(masked);
	});

	// Card 2849. An invite is kept only as its hash, so there is no token to
	// look for, and no code writes one into a line but in an address, which
	// the rule above masks. A bare token in a line is left, on purpose.
	it('leaves a line that holds an unused invite’s token on its own, not in an address, as it was', () => {
		const token = inTransaction(() => issueInvite(member.id));
		sqlite
			.prepare("INSERT INTO system_logs (timestamp, level, context, message) VALUES ('2026-10-01 00:00:00', 'WARN', 'AUTH', ?)")
			.run(`An invite was looked for that is ${token}`);
		const before = everyLine();

		expect(maskLiveLog()).toBe(0);

		expect(everyLine()).toBe(before);
		expect(column<string>(sqlite, "SELECT message FROM system_logs WHERE context = 'AUTH'")).toEqual([`An invite was looked for that is ${token}`]);
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
		const hooks = readFileSync(join(process.cwd(), 'src', 'hooks.server.ts'), 'utf8').replace(/\r\n/g, '\n');

		expect(hooks.indexOf('\nrunMigrations();')).toBeGreaterThan(-1);
		expect(hooks.indexOf('\nmaskLiveLog();')).toBeGreaterThan(hooks.indexOf('\nrunMigrations();'));
		// And the invites an older image kept in plain ended (card 2849).
		expect(hooks.indexOf('\nendPlainInvites();')).toBeGreaterThan(hooks.indexOf('\nrunMigrations();'));
		// And the requester links an older image wrote in plain ended next (card 2870, E3), before the
		// report schedules are announced (card 2751).
		expect(hooks.indexOf('\nendPlainRequestLinks();')).toBeGreaterThan(hooks.indexOf('\nendPlainInvites();'));
		expect(hooks.indexOf('\nvoid announceReportSchedules();')).toBeGreaterThan(hooks.indexOf('\nendPlainRequestLinks();'));
		// And the images stored before card 2761 checked once after that, before the schedulers start (D10).
		expect(hooks.indexOf('\nvoid recheckStoredImages();')).toBeGreaterThan(hooks.indexOf('\nvoid announceReportSchedules();'));
		// And the webhooks set up before keys were recorded announced straight after the report schedules (card 2893, E9).
		expect(hooks.indexOf('\nvoid announceWebhooksBeforeKeys();')).toBeGreaterThan(hooks.indexOf('\nvoid announceReportSchedules();'));
		expect(hooks.indexOf('\nvoid recheckStoredImages();')).toBeGreaterThan(hooks.indexOf('\nvoid announceWebhooksBeforeKeys();'));
		// And the webhooks held at start switched off for good after the settings of non-administrators are removed,
		// before the schedulers start (card 2752, E9).
		expect(hooks.indexOf('\nswitchOffHeldWebhooksAtStart();')).toBeGreaterThan(hooks.indexOf('\nremoveSettingsOfNonAdministrators();'));
		expect(hooks.indexOf('\nswitchOffHeldWebhooksAtStart();')).toBeGreaterThan(hooks.indexOf('\nvoid recheckStoredImages();'));
		expect(hooks.indexOf('\nstartSchedulers();')).toBeGreaterThan(hooks.indexOf('\nswitchOffHeldWebhooksAtStart();'));
		// And the already-off webhooks of disabled or missing setters held once, straight after, before the schedulers
		// start (card 2923, S3).
		expect(hooks.indexOf('\nholdAlreadyOffWebhooksAtStart();')).toBeGreaterThan(hooks.indexOf('\nswitchOffHeldWebhooksAtStart();'));
		expect(hooks.indexOf('\nstartSchedulers();')).toBeGreaterThan(hooks.indexOf('\nholdAlreadyOffWebhooksAtStart();'));
		// And those a disabled owner or administrator could read, after those, before the schedulers (card 2935).
		expect(hooks.indexOf('\nholdReadableWebhooksAtStart();')).toBeGreaterThan(hooks.indexOf('\nholdAlreadyOffWebhooksAtStart();'));
		expect(hooks.indexOf('\nstartSchedulers();')).toBeGreaterThan(hooks.indexOf('\nholdReadableWebhooksAtStart();'));
		// And what every ended API key was given, after those, its timer armed straight after, before the schedulers (card 2947).
		expect(hooks.indexOf('\nsweepEndedKeyReveals();')).toBeGreaterThan(hooks.indexOf('\nholdReadableWebhooksAtStart();'));
		expect(hooks.indexOf('\nstartEndedKeyRevealSweep();')).toBeGreaterThan(hooks.indexOf('\nsweepEndedKeyReveals();'));
		expect(hooks.indexOf('\nstartSchedulers();')).toBeGreaterThan(hooks.indexOf('\nstartEndedKeyRevealSweep();'));
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

/**
 * JSON of two other shapes put where a service account's goes (card 2938's
 * code review, R1), each with what it holds beside the allowlisted fields
 * (`type`, `client_id`) and what a copy and the GET make of it. Every value
 * outside the allowlist holds `r1-2938`.
 */
const OTHER_SHAPES = [
	{
		shape: 'an authorized_user’s',
		json: { type: 'authorized_user', client_id: 'user-client.apps.example.test', client_secret: 'user-secret-r1-2938', refresh_token: 'user-token-r1-2938', quota_project_id: 'quota-r1-2938' },
		kept: { type: 'authorized_user', client_id: 'user-client.apps.example.test' },
		others: ['client_secret', 'refresh_token', 'quota_project_id']
	},
	{
		shape: 'an impersonated_service_account’s',
		json: {
			type: 'impersonated_service_account',
			service_account_impersonation_url: 'https://iam.example.test/token-r1-2938',
			source_credentials: { type: 'authorized_user', client_secret: 'source-secret-r1-2938', refresh_token: 'source-token-r1-2938' },
			delegates: ['delegate-r1-2938']
		},
		kept: { type: 'impersonated_service_account' },
		others: ['service_account_impersonation_url', 'source_credentials', 'delegates']
	}
];

/** `shape`'s JSON with every field outside the allowlist set to `value`, in its order. */
const withOthers = ({ json, kept }: (typeof OTHER_SHAPES)[number], value: string) =>
	Object.fromEntries(Object.keys(json).map((field) => [field, field in kept ? kept[field as keyof typeof kept] : value]));

/** One destination of each type, every secret field set. */
const DESTINATIONS: Record<string, unknown>[] = [
	{ type: 'sftp', name: 'NAS', host: 'nas.example.test', port: 22, username: 'backup', password: SECRETS.sftpPassword, privateKey: SECRETS.sftpKey, remotePath: '/backups' },
	{ type: 's3', name: 'Bucket', region: 'eu-west-2', bucket: 'dumpfire-backups', accessKeyId: 'AKIA2169NOTSECRET', secretAccessKey: SECRETS.s3Secret, prefix: 'dumpfire/' },
	{ type: 'gdrive', name: 'Drive', authMethod: 'oauth', clientId: 'client-id.apps.example.test', clientSecret: SECRETS.gdriveClientSecret, refreshToken: SECRETS.gdriveRefreshToken, folderId: 'folder-1' },
	{ type: 'gdrive', name: 'Robot', authMethod: 'service_account', serviceAccountJson: serviceAccountJson(SECRETS.serviceAccountKey), folderId: 'folder-2' },
	// With whose OneDrive (card 2941): one without is not tried, and is saved only as it was stored.
	{ type: 'onedrive', name: 'OneDrive', tenantId: 'tenant-1', clientId: 'onedrive-client', clientSecret: SECRETS.onedriveSecret, folderPath: '/DumpFire Backups', drive: 'backups@example.test' }
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
function armSecrets(database: Database.Database): { on: number; off: number; unsigned: number; boardId: number; owner: number } {
	const owner = (database.prepare("SELECT id FROM users WHERE role = 'superadmin' ORDER BY id").get() as { id: number }).id;
	const boardId = Number(database.prepare("INSERT INTO boards (name, created_by) VALUES ('Hooks', ?)").run(owner).lastInsertRowid);
	const set = database.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
	for (const [key, value] of Object.entries(MAIL)) set.run(key, value);
	set.run('smtp_pass', SECRETS.mailPassword);
	set.run('backup_config', configWith(DESTINATIONS));
	// Set up by the board's owner, as a webhook made since setters were recorded is (card 2923's code review: one with
	// no setter that is off is held at a restore, and is given a new secret, which these cases are not about).
	const hook = database.prepare("INSERT INTO webhooks (board_id, url, secret, events, active, set_by) VALUES (?, ?, ?, '[]', ?, ?)");
	return {
		on: Number(hook.run(boardId, 'https://hooks.example.test/on', SECRETS.webhookOn, 1, owner).lastInsertRowid),
		off: Number(hook.run(boardId, 'https://hooks.example.test/off', SECRETS.webhookOff, 0, owner).lastInsertRowid),
		unsigned: Number(hook.run(boardId, 'https://hooks.example.test/unsigned', '', 1, owner).lastInsertRowid),
		boardId,
		owner
	};
}

/** The settings that are stored sealed (card 2898), read opened by the helpers below. */
const SEALED_SETTINGS = ['smtp_pass', 'backup_config', BACKUP_SEAL_KEY];

/**
 * `database`'s settings, each stored secret opened (card 2898): a value held
 * in plain, as a backup or a database made by hand holds it, is as it is.
 */
const settingsOf = (database: Database.Database): Record<string, string> =>
	Object.fromEntries(
		(database.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map((row) => [
			row.key,
			SEALED_SETTINGS.includes(row.key) ? readOpened('settings', row.key, database)! : row.value
		])
	);

/** `database`'s settings as they are stored, the sealed ones sealed. */
const settingsStored = (database: Database.Database): Record<string, string> =>
	Object.fromEntries((database.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map((row) => [row.key, row.value]));

/** Each webhook's secret opened (card 2898). */
const openedHooks = <T extends { id: number; secret: string }>(database: Database.Database, rows: T[]): T[] =>
	rows.map((row) => ({ ...row, secret: readOpened('webhooks', row.id, database)! }));

const hooksIn = (database: Database.Database) =>
	openedHooks(database, database.prepare('SELECT id, secret, active FROM webhooks ORDER BY id').all() as { id: number; secret: string; active: number }[]);

/** Everything a secret is in, or decides where one goes. */
const secretsOf = (database: Database.Database) => {
	const settings = settingsOf(database);
	return {
		mail: Object.entries(settings).filter(([key]) => key.startsWith('smtp_')).sort(),
		config: settings['backup_config'] ?? null,
		marker: settings[WEBHOOK_SECRETS_LEFT_OUT_KEY] ?? null,
		// Each address opened (card 2928): the backup's plain one is sealed as a restore reads it.
		hooks: openedHooks(
			database,
			database.prepare('SELECT id, board_id, url, secret, active FROM webhooks ORDER BY id').all() as { id: number; secret: string; active: number }[]
		).map((hook) => ({ ...hook, url: readOpenedUrl(hook.id, database) }))
	};
};

/**
 * `secretsOf(sqlite)` as a restore into the running database leaves it: every
 * secret as it was, and each webhook armSecrets makes that is on, which nobody
 * is recorded as having set up, switched off for good by the restore's sweep
 * (card 2752, S1).
 */
const withNoSetterSwitchedOff = (before: ReturnType<typeof secretsOf>) => ({
	...before,
	hooks: (before.hooks as { active: number }[]).map((hook) => ({ ...hook, active: 0 }))
});

/** What a test that says "this server's secret" means: a value only the server restored into has. */
const HERE = 'held-here-only-2169';

describe('the secrets a backup does not hold (card 2169)', () => {
	let hooks: ReturnType<typeof armSecrets>;

	beforeEach(() => {
		// A server started since card 2923's release, whose backups say so (its code review, S2).
		startedSinceAlreadyOffHeld();
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

	/** Every webhook's address, as the backup lists it, each with its match (card 2928). */
	const listedAddresses = () => [
		{ id: hooks.on, active: true, address: expect.stringMatching(/^[0-9a-f]{64}$/) },
		{ id: hooks.off, active: false, address: expect.stringMatching(/^[0-9a-f]{64}$/) },
		{ id: hooks.unsigned, active: true, address: expect.stringMatching(/^[0-9a-f]{64}$/) }
	];

	/** The three webhooks, as a restore that could not fill their addresses lists them (card 2928). */
	const addressesToEnter = () => [...hooksToEnter(), { id: hooks.unsigned, boardId: hooks.boardId, board: 'Hooks' }];

	/** The kept sentence's words for the three addresses filled (card 2928). */
	const addressesKept = () => `; the address(es) of webhook(s) ${hooks.on}, ${hooks.off}, ${hooks.unsigned}`;

	/** Decision 5's second sentence for a backup of this database restored where none of it is. */
	const everythingToEnter = () =>
		'To enter again, because a backup does not hold them: the mail password (Admin, 📧 Email / SMTP); backup ' +
		'destination(s) "NAS" (SFTP: its password or private key, then Test to confirm its host key), "Bucket" (S3: its secret access key), "Drive" ' +
		'(Google Drive: its client secret, then Connect), "Robot" (Google Drive: its service account JSON), "OneDrive" ' +
		'(OneDrive: its client secret) (Admin, Scheduled Backups); the signing secret(s) of webhook(s) ' +
		`${hooks.on} (board "Hooks"), ${hooks.off} (board "Hooks"), which stay switched off until the board's owner or ` +
		'an administrator sets each one and switches it on with PUT /api/v1/webhooks/{id}; ' +
		// And the three addresses (card 2928).
		`the address(es) of webhook(s) ${hooks.on} (board "Hooks"), ${hooks.off} (board "Hooks"), ${hooks.unsigned} (board "Hooks"), which stay ` +
		"switched off until the board's owner or an administrator sends each one its url (and its secret) with active true in PUT /api/v1/webhooks/{id}.";

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
		// Stored as a server stores it (card 2943, R2): sealed, of the form `v2:` and 64 hex. One in plain is no key.
		if (key !== null) set.run(BACKUP_SEAL_KEY, sealValue(`v2:${key}`, settingAad(BACKUP_SEAL_KEY), currentMfaKey()!));
		// This server's webhook address key too, where it is this server (card 2928, R14).
		if (given.key === undefined) set.run(WEBHOOK_ADDRESS_MAC_KEY, webhookAddressMacKey(sqlite).toString('hex'));
		for (const [key, value] of Object.entries(given.mail ?? {})) set.run(key, value);
		if (given.destinations) set.run('backup_config', configWith(given.destinations));
		const hook = live.prepare("INSERT INTO webhooks (id, board_id, url, secret, events, active, set_by) VALUES (?, ?, ?, ?, '[]', ?, ?)");
		const setter = live.prepare("INSERT OR IGNORE INTO users (id, username, email, password_hash) VALUES (?, 'setter' || ?, 'setter' || ? || '@example.test', 'x')");
		for (const w of given.webhooks ?? []) {
			// By default the backup's setter, the board's owner there (card 2923's code review: armSecrets records it).
			const setBy = w.setBy ?? hooks.owner;
			setter.run(setBy, setBy, setBy);
			hook.run(w.id, hooks.boardId, w.url, w.secret, w.active ?? 1, setBy);
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
			headers: confirmedImport(),
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
		// The two signed webhooks off with no secret, and listed; and every one with no address, off and listed with
		// its match (card 2928), the unsigned one among them.
		expect(hooksIn(backup)).toEqual([
			{ id: hooks.on, secret: '', active: 0 },
			{ id: hooks.off, secret: '', active: 0 },
			{ id: hooks.unsigned, secret: '', active: 0 }
		]);
		expect(JSON.parse(settings[WEBHOOK_SECRETS_LEFT_OUT_KEY])).toEqual(listed());
		expect(backup.prepare('SELECT url FROM webhooks').pluck().all()).toEqual(['', '', '']);
		expect(JSON.parse(settings[WEBHOOK_ADDRESSES_LEFT_OUT_KEY])).toEqual(listedAddresses());
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
		const res = await exported();
		expect(res.status).toBe(200);
		expectNoSecrets(Buffer.from(await res.arrayBuffer()));
		expectSecretsHere();

		// The SFTP destination's host key confirmed, without which a run does not
		// try it (card 2250). The key is no secret, and the copy keeps it.
		sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(configWith([{ ...NAS, hostKey: HOST_KEY }, BUCKET, DRIVE, ROBOT, ONEDRIVE]));
		const run = await api('POST', '/api/admin/backup', confirmedByChief());
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

		// Card 2938 and its code review (R1): the copy keeps a service account JSON's allowlist, each field only where it
		// is text (type, project_id, client_email, private_key_id, client_id), and sets every other field to '', a
		// camelCase `privateKey` and JSON of another shape among them.
		const ACCOUNT = { type: 'service_account', client_email: 'robot@project.iam.example.test', private_key_id: 'key-id-1' };
		const shapes: [string, Record<string, unknown>, Record<string, unknown>][] = [
			['only a privateKey', { ...ACCOUNT, privateKey: 'camel-key-2938-a' }, { ...ACCOUNT, privateKey: '' }],
			['both keys', { ...ACCOUNT, private_key: 'snake-key-2938-b', privateKey: 'camel-key-2938-b' }, { ...ACCOUNT, private_key: '', privateKey: '' }],
			[
				'a privateKey and a project_id that are not text, and a token_uri',
				{ ...ACCOUNT, project_id: { nested: 'nested-id-2938-c' }, privateKey: { pem: 'nested-key-2938-c' }, token_uri: 'https://token.example.test/2938-c' },
				{ ...ACCOUNT, project_id: '', privateKey: '', token_uri: '' }
			],
			...OTHER_SHAPES.map((other): [string, Record<string, unknown>, Record<string, unknown>] => [other.shape, other.json, withOthers(other, '')])
		];
		it.each(shapes)('keeps only the allowlisted fields of a service account JSON holding %s, every other one emptied and none added (card 2938)', (_shape, account, cleared) => {
			const copy = copyOf(SETTINGS);
			copy.prepare("INSERT INTO settings VALUES ('backup_config', ?)").run(configWith([{ ...ROBOT, serviceAccountJson: JSON.stringify(account) }]));

			clearSecrets(copy);

			const held = settingsOf(copy)['backup_config'];
			expect(held).not.toContain('2938');
			expect(JSON.parse(JSON.parse(held).destinations[0].serviceAccountJson)).toEqual(cleared);
		});

		it('clears the same fields the seal seals: DESTINATION_SECRET_FIELDS is every type’s SECRET_FIELDS (card 2938)', () => {
			expect([...DESTINATION_SECRET_FIELDS].sort()).toEqual([...new Set(Object.values(SECRET_FIELDS).flat())].sort());
		});

		// Card 2938's code review, R2: a service account JSON has its key only as an object of type service_account with
		// text in private_key; one entered otherwise says so, one as a copy leaves it says its credentials are not entered.
		it.each([
			['a service_account with a private_key', JSON.stringify({ ...ACCOUNT, private_key: 'snake-key-2938-d' }), null],
			// Card 2939, case 14: the run reads the one rule, which needs a client_email beside the key.
			['a private_key and no client_email', JSON.stringify({ type: 'service_account', private_key_id: 'key-id-1', private_key: 'no-email-key-2939' }), SERVICE_ACCOUNT_NOT_A_KEY],
			// Card 2939's code review, F3: a field the rule does not read is dropped, so this is the key-less shape: not entered.
			['only a privateKey', JSON.stringify({ ...ACCOUNT, privateKey: 'camel-key-2938-d' }), CREDENTIALS_NOT_ENTERED],
			// F3: the pre-sweep example, a key-less JSON holding a field outside the allowlist, is not entered either.
			['a key-less JSON with a token_uri', '{"type":"service_account","client_email":"e","private_key":"","token_uri":"x"}', CREDENTIALS_NOT_ENTERED],
			['a private_key and no type', JSON.stringify({ client_email: ACCOUNT.client_email, private_key: 'untyped-key-2938-d' }), SERVICE_ACCOUNT_NOT_A_KEY],
			['a private_key that is not text', JSON.stringify({ ...ACCOUNT, private_key: { pem: 'nested-key-2938-d' } }), SERVICE_ACCOUNT_NOT_A_KEY],
			['an authorized_user’s fields and a private_key', JSON.stringify({ ...OTHER_SHAPES[0].json, private_key: 'user-key-2938-d' }), SERVICE_ACCOUNT_NOT_A_KEY],
			['text that is not a JSON object', '"just-a-key-2938-d"', SERVICE_ACCOUNT_NOT_A_KEY],
			['what a copy leaves of a key', serviceAccountJson(''), CREDENTIALS_NOT_ENTERED],
			['nothing', '', CREDENTIALS_NOT_ENTERED]
		])('says of a service account JSON holding %s what runBackup says (card 2938’s code review, R2)', (_shape, json, says) => {
			expect(credentialsMissing({ ...ROBOT, serviceAccountJson: json })).toBe(says);
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
		expect(secretsOf(sqlite)).toEqual(withNoSetterSwitchedOff(before));
		expect(result.webhooksSwitchedOff).toBe(2);
		expect(result.secrets).toEqual({
			kept: {
				mailPassword: true,
				destinations: ['NAS', 'Bucket', 'Drive', 'Robot', 'OneDrive'],
				webhooks: [hooks.on, hooks.off],
				webhookAddresses: [hooks.on, hooks.off, hooks.unsigned]
			},
			toEnter: NOTHING_TO_ENTER
		});
		expect(secretsKeptSentence(result.secrets.kept)).toBe(
			'Kept from this server, because a backup does not hold them: the mail password; the credentials of backup ' +
				`destination(s) "NAS", "Bucket", "Drive", "Robot", "OneDrive"; the signing secret(s) of webhook(s) ${hooks.on}, ${hooks.off}${addressesKept()}.`
		);
	});

	// Card 2752, case 14 (S1).
	it("14. never switches on a webhook held off here: its secret filled from this server, it stays off with this server's hold, though the backup had it on", () => {
		const backup = backupNow();
		const heldAt = '2026-11-18 09:00:00';
		sqlite.prepare("UPDATE webhooks SET active = 0, held_because = 'no setter', held_at = ? WHERE id = ?").run(heldAt, hooks.on);
		// The backup had it on, and holds it with no secret.
		expect(JSON.parse(settingsOf(backup)[WEBHOOK_SECRETS_LEFT_OUT_KEY])).toContainEqual({ id: hooks.on, active: true });

		const result = restoreFromBackup(sqlite, backup);

		expect(result.secrets.kept.webhooks).toContain(hooks.on);
		expect(sqlite.prepare('SELECT secret, active, held_because AS heldBecause, held_at AS heldAt FROM webhooks WHERE id = ?').get(hooks.on)).toEqual({
			secret: SECRETS.webhookOn,
			active: 0,
			heldBecause: 'no setter',
			heldAt
		});
	});

	it('is restored into a server with none of them with nothing filled, the webhooks off, and each listed with what it needs', () => {
		const live = migratedDb();

		const result = restoreFromBackup(live, backupNow());

		expect(result.errors).toEqual([]);
		// A server with no key has made no backup, so this one's seal does not verify (S1).
		expect(result.sealVerified).toBe(false);
		expect(result.secrets).toEqual({
			kept: NOTHING_KEPT,
			toEnter: { mailPassword: true, destinations: NEEDS, webhooks: hooksToEnter(), webhookAddresses: addressesToEnter() }
		});
		expect(settingsOf(live)['smtp_pass']).toBeUndefined();
		expect(JSON.parse(settingsOf(live)['backup_config']).destinations).toEqual(DESTINATIONS_CLEARED);
		expect(hooksIn(live)).toEqual([
			{ id: hooks.on, secret: '', active: 0 },
			{ id: hooks.off, secret: '', active: 0 },
			{ id: hooks.unsigned, secret: '', active: 0 }
		]);
		// The list is written again, for every start to name them (R2); and the addresses' (card 2928).
		expect(JSON.parse(settingsOf(live)[WEBHOOK_SECRETS_LEFT_OUT_KEY])).toEqual(listed());
		expect(JSON.parse(settingsOf(live)[WEBHOOK_ADDRESSES_LEFT_OUT_KEY])).toEqual(listedAddresses());
		expect(secretsToEnterSentence(result.secrets.toEnter)).toBe(everythingToEnter());
	});

	it('says what is to enter through the route, word for word, in its answer and in a WARN line of its own', async () => {
		const backup = backupNow();
		// This server has none of them now, its webhooks' addresses included (card 2928).
		sqlite.exec("DELETE FROM settings WHERE key IN ('smtp_pass', 'backup_config'); UPDATE webhooks SET secret = '', url = ''");

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
				`destination(s) "NAS", "Bucket", "Drive", "Robot", "OneDrive"; the signing secret(s) of webhook(s) ${hooks.on}, ${hooks.off}${addressesKept()}.`
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
				toEnter: { mailPassword: true, destinations: NEEDS, webhooks: hooksToEnter(), webhookAddresses: addressesToEnter() }
			});
		};

		it('is in the copy, as a setting of its form’s number and 64 hex characters made again from the file it is in', async () => {
			const res = await exported();
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
			// `v2:` and 64 hex once opened (card 2943, R1).
			const opened = settingsOf(sqlite)[BACKUP_SEAL_KEY];
			expect(opened).toMatch(/^v2:[0-9a-f]{64}$/);
			const key = opened.slice('v2:'.length);
			for (const bytes of [generateBackupData(), Buffer.from(backup.serialize())]) {
				expect(bytes.includes(Buffer.from(key)), 'the key').toBe(false);
				expect(bytes.includes(Buffer.from(BACKUP_SEAL_KEY)), 'its setting').toBe(false);
				// Nor its record (card 2943, R3), though the running database has it.
				expect(bytes.includes(Buffer.from(BACKUP_SEAL_KEY_MADE_AT)), 'its record').toBe(false);
			}
			expect(settingsOf(sqlite)[BACKUP_SEAL_KEY_MADE_AT]).toMatch(/^\d{4}-/);

			// A backup that brings a key of its own, sealed with this server's
			// (the worst there could be): the key here is the one kept.
			const bringing = resealed(backupNow(), (made) => {
				made.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(BACKUP_SEAL_KEY, 'f'.repeat(64));
				// And a record of its own (card 2943, R7(c)).
				made.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(BACKUP_SEAL_KEY_MADE_AT, '2020-01-01T00:00:00.000Z');
			});
			const result = restoreFromBackup(sqlite, bringing);

			expect(result.sealVerified).toBe(true);
			expect(settingsOf(sqlite)[BACKUP_SEAL_KEY]).toBe(opened);
			expect(settingsOf(sqlite)[BACKUP_SEAL]).toBeUndefined();
			// And a backup made before the restore still verifies after it.
			expect(restoreFromBackup(sqlite, backup).sealVerified).toBe(true);
			// A server with no key yet is given none by the backup either, nor a record (card 2943, R7(c)): a
			// restore makes no key, whatever a start does (R5).
			const fresh = migratedDb();
			restoreFromBackup(fresh, bringing);
			expect(settingsOf(fresh)[BACKUP_SEAL_KEY]).toBeUndefined();
			expect(settingsOf(fresh)[BACKUP_SEAL_KEY_MADE_AT]).toBeUndefined();
			// And the seal is written into a copy only, never into the running database.
			expect(() => sealCopy(sqlite, Buffer.from(key, 'hex'))).toThrow('never the running database');
			// The record kept beside the key is this server's, not the backup's.
			expect(settingsOf(sqlite)[BACKUP_SEAL_KEY_MADE_AT]).not.toBe('2020-01-01T00:00:00.000Z');
		});

		it('fills every secret into an unchanged backup on the server that made it', () => {
			const before = secretsOf(sqlite);

			const result = restoreFromBackup(sqlite, backupNow());

			expect(result.sealVerified).toBe(true);
			expect(result.secrets.kept.destinations).toHaveLength(5);
			expect(secretsOf(sqlite)).toEqual(withNoSetterSwitchedOff(before));
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
			// The key opened (card 2898: `sealKeyHere` gives it as stored, sealed, and as the seal is checked with).
			const key = sealKeyHere(sqlite)?.key ?? null;
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

		// Card 2941 (T24): a drive appended to the place makes another place.
		it('fills no OneDrive destination of a backup made without a drive from the one here with a drive, and lists it', () => {
			const backup = resealed(backupNow(), (made) => {
				const config = JSON.parse(made.prepare("SELECT value FROM settings WHERE key = 'backup_config'").pluck().get() as string);
				config.destinations = config.destinations.map(({ drive: _drive, ...entry }: Record<string, unknown>) => entry);
				made.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(JSON.stringify(config));
			});
			const live = serverWith({ destinations: [{ ...ONEDRIVE, clientSecret: `${HERE}-onedrive` }] });

			const result = restoreFromBackup(live, backup);

			expect(result.errors).toEqual([]);
			expect(result.secrets.kept.destinations).not.toContain('OneDrive');
			expect(result.secrets.toEnter.destinations).toContainEqual(NEEDS[4]);
			expect(JSON.parse(settingsOf(live)['backup_config']).destinations[4]).toEqual({ ...ONEDRIVE, clientSecret: '', drive: undefined });
		});

		it.each([
			['only a privateKey', { type: 'service_account', privateKey: `${HERE}-camel` }],
			['an authorized_user’s fields and a private_key', { type: 'authorized_user', private_key: `${HERE}-user`, client_secret: `${HERE}-secret` }],
			['a private_key and no type', { private_key: `${HERE}-untyped` }]
		])(
			'fills no service account from the same account here whose JSON holds %s, not a service account key, and lists it (card 2938’s code review, R2, R3)',
			(_shape, json) => {
				const live = serverWith({
					destinations: [{ ...ROBOT, serviceAccountJson: JSON.stringify({ client_email: 'robot@project.iam.example.test', private_key_id: 'key-id-1', ...json }) }]
				});

				const result = restoreFromBackup(live, backupNow());

				expect(result.errors).toEqual([]);
				expect(result.secrets.kept.destinations).not.toContain('Robot');
				expect(result.secrets.toEnter.destinations).toContainEqual(NEEDS[3]);
				expect(JSON.parse(settingsOf(live)['backup_config']).destinations[3]).toEqual(DESTINATIONS_CLEARED[3]);
				expect(holdsOwn(live)).toBe(false);
			}
		);

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
			// The unsigned one off: its address, left out of the backup, is nowhere here to fill it from (card 2928).
			expect(hooksIn(live)).toEqual([
				{ id: hooks.on, secret: `${HERE}-hook-on`, active: 1 },
				{ id: hooks.off, secret: '', active: 0 },
				{ id: hooks.unsigned, secret: '', active: 0 }
			]);
		});

		it('leaves out a secret a backup holds in plain beside the address it left out, and fills it from here as one it listed (card 2928, R5)', () => {
			// Before card 2928 the backup's own value was kept here as it was. A backup made since holds no address, and
			// a secret is never sealed against none: it is left out as the restore reads it, and listed with its own.
			const { live, result } = restoringWithList(JSON.stringify([{ id: hooks.on, active: false }]), (backup) => {
				backup.prepare("UPDATE webhooks SET secret = 'the-backups-own-secret', active = 1 WHERE id = ?").run(hooks.on);
			});

			expect(result.errors).toEqual([]);
			expect(hooksIn(live)[0]).toEqual({ id: hooks.on, secret: `${HERE}-hook-on`, active: 1 });
			expect(result.secrets.kept.webhooks).toEqual([hooks.on]);
			expect(result.secrets.toEnter.webhooks).toEqual([]);
			expect(JSON.stringify(live.serialize().toString('latin1'))).not.toContain('the-backups-own-secret');
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
			(await api('POST', '/api/admin/backup', confirmedByChief())).body.results as { destination: string; status: string; message: string }[];
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
		expect(settingsOf(sqlite)[WEBHOOK_ADDRESSES_LEFT_OUT_KEY]).toBeUndefined();

		const working = migratedDb();
		const result = restoreFromBackup(working, backup, { outside: 'off' });
		expect(settingsOf(working)[WEBHOOK_SECRETS_LEFT_OUT_KEY]).toBeUndefined();
		expect(settingsOf(working)[WEBHOOK_ADDRESSES_LEFT_OUT_KEY]).toBeUndefined();
		expect(result.secrets.toEnter).toEqual({ mailPassword: false, destinations: [], webhooks: hooksToEnter(), webhookAddresses: addressesToEnter() });
	});

	// Card 2923's code review (E1): a webhook held for good is switched on with no secret, never "set its secret".
	it('2923 R5: sets a webhook held for good apart from those to enter, and tells to switch it on with no secret, in the answer and at start', () => {
		// A backup from before card 2923's release, restored as a working copy: every webhook the backup had off is held.
		const backup = backupNow();
		backup.prepare("DELETE FROM settings WHERE key = 'webhooks_already_off_held'").run();
		const working = migratedDb();
		const result = restoreFromBackup(working, backup, { outside: 'off' });

		// Their addresses are still to enter, and every one of them is held, the unsigned one too (card 2928's code
		// review, C1): each is told one thing, its url with active true and no secret.
		expect(result.secrets.toEnter).toEqual({ mailPassword: false, destinations: [], webhooks: [], heldWebhooks: addressesToEnter(), webhookAddresses: addressesToEnter() });
		const named = `${hooks.on} (board "Hooks"), ${hooks.off} (board "Hooks"), ${hooks.unsigned} (board "Hooks")`;
		const said = secretsToEnterSentence(result.secrets.toEnter);
		expect(said).toBe(
			`To enter again, because a backup does not hold them: the address(es) of webhook(s) ${named}, switched off for good: to keep one, ` +
				"the board's owner or an administrator switches it on with its url and active true, and no secret, in PUT /api/v1/webhooks/{id} " +
				'(it is given a new secret, returned once in that answer).'
		);
		expect(said).not.toContain('(and its secret)');
		expect(said).not.toContain('sets each one');
		// The held words alone, for a webhook held whose address is here (card 2923's code review, E1).
		expect(secretsToEnterSentence({ mailPassword: false, destinations: [], webhooks: [], heldWebhooks: hooksToEnter() })).toBe(
			`Nothing to enter for webhook(s) ${hooks.on} (board "Hooks"), ${hooks.off} (board "Hooks"), switched off for good: to keep one, ` +
				"the board's owner or an administrator should switch it on with no secret; it is given a new one, returned once in that answer " +
				'(PUT /api/v1/webhooks/{id} with active true alone).'
		);
		// The start-up line's words, from the database as the restore left it.
		expect(withHeldApart(working, { mailPassword: false, destinations: [], webhooks: hooksToEnter(), webhookAddresses: addressesToEnter() })).toEqual(
			result.secrets.toEnter
		);
		// At start, as a server whose restore left the lists of webhooks without their secrets and addresses reads them.
		working.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(WEBHOOK_SECRETS_LEFT_OUT_KEY, JSON.stringify(listed()));
		working.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(WEBHOOK_ADDRESSES_LEFT_OUT_KEY, settingsOf(backup)[WEBHOOK_ADDRESSES_LEFT_OUT_KEY]);
		const atStart = secretsToEnter(working).toEnter;
		expect(atStart.webhooks).toEqual([]);
		expect(secretsToEnterSentence({ ...atStart, mailPassword: false, destinations: [] }, true)).toBe(`${said?.slice(0, -1)}, or deletes it if it is no longer wanted.`);
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

// ─── A webhook held off is not brought back on by a restore (card 2752) ─────

describe('a restore switches off a restored webhook whose setter cannot open its board (card 2752, S1)', () => {
	/**
	 * A backup of the running database made before migration 0071: the
	 * webhooks table as 0070 left it, with none of the four columns, and
	 * neither the setting nor the file recorded. Its addresses plain, as a
	 * backup from then holds them (card 2928).
	 */
	function before0071(backup: Database.Database): Database.Database {
		const opened = (backup.prepare('SELECT id FROM webhooks').pluck().all() as number[]).map((id) => [readOpenedUrl(id, backup)!, id]);
		for (const [url, id] of opened) backup.prepare('UPDATE webhooks SET url = ? WHERE id = ?').run(url, id);
		backup.exec(`
			CREATE TABLE webhooks_0070 (
				id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
				board_id integer NOT NULL REFERENCES boards(id) ON DELETE cascade,
				url text NOT NULL,
				secret text DEFAULT '' NOT NULL,
				events text DEFAULT '[]' NOT NULL,
				active integer DEFAULT true NOT NULL,
				created_at text DEFAULT (datetime('now')) NOT NULL,
				set_by integer REFERENCES users(id) ON DELETE SET NULL
			);
			INSERT INTO webhooks_0070 SELECT id, board_id, url, secret, events, active, created_at, set_by FROM webhooks;
			DROP TABLE webhooks;
			ALTER TABLE webhooks_0070 RENAME TO webhooks;
			DELETE FROM settings WHERE key = 'webhook_keys_recorded_at';
			DELETE FROM __drizzle_migrations WHERE hash = '0071_add_webhook_holds.sql';
		`);
		return backup;
	}

	// The code review's CS5 and CR2: a hold here is carried onto the same webhook restored, whatever its secret, and
	// whether or not its setter can open the board in the backup.
	it("CS5. this server's hold is carried onto the same webhook restored, a signed one and one with no secret, though the backup had them on and their setter can open the board there and here; a webhook re-pointed since is not the same", () => {
		const owner = makeUser();
		const { board } = makeBoard({ owner });
		const signed = makeWebhook(board, { url: 'https://hooks.example.test/signed', secret: 'kept-secret' });
		const bare = makeWebhook(board, { url: 'https://hooks.example.test/bare' });
		const moved = makeWebhook(board, { url: 'https://hooks.example.test/before' });
		// The backup: all three on, their setter the board's owner.
		const backup = opening(Buffer.from(sqlite.serialize()));
		// Here, since: the three held off, the third re-pointed first.
		const heldAt = '2026-11-18 09:00:00';
		sqlite.prepare("UPDATE webhooks SET url = 'https://hooks.example.test/after' WHERE id = ?").run(moved.id);
		sqlite.prepare("UPDATE webhooks SET active = 0, held_because = 'setter access ended', held_at = ? WHERE board_id = ?").run(heldAt, board.id);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.webhooksSwitchedOff).toBe(0);
		// Each secret opened (card 2898): the backup held it in plain, and the restore sealed it as it read it. Each address opened (card 2928).
		const rows = sqlite.prepare('SELECT id, secret, active, held_because AS heldBecause, held_at AS heldAt FROM webhooks ORDER BY id').all() as { id: number; secret: string }[];
		expect(openedHooks(sqlite, rows).map((row) => ({ ...row, url: readOpenedUrl(row.id) }))).toEqual([
			{ id: signed.id, url: signed.address, secret: 'kept-secret', active: 0, heldBecause: 'setter access ended', heldAt },
			{ id: bare.id, url: bare.address, secret: '', active: 0, heldBecause: 'setter access ended', heldAt },
			{ id: moved.id, url: 'https://hooks.example.test/before', secret: '', active: 1, heldBecause: null, heldAt: null }
		]);
	});

	it("13. a backup from before 0071 holding a webhook on whose setter cannot open the board: off after the commit, one WARN naming who restored; given the board back, nothing is sent", async () => {
		// The suite's superadmin, chief, restores.
		const owner = makeUser();
		const editor = makeUser();
		const { board } = makeBoard({ owner });
		addBoardMember(board, editor, 'editor');
		const theirs = makeWebhook(board, { url: 'https://hooks.example.test/theirs', setBy: editor });
		const owners = makeWebhook(board, { url: 'https://hooks.example.test/owners' });
		// The owner holds a key from before keys were recorded here, which keeps their webhook from before 0071, which
		// records no key, sent (card 2893, S9); a restore keeps this server's moment.
		sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('webhook_keys_recorded_at', '2026-06-01 00:00:00')").run();
		sqlite.prepare("UPDATE api_keys SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(makeApiKeyRow(owner).id);
		// The backup: the editor off the board, their webhook on, and no hold columns.
		const backup = opening(Buffer.from(sqlite.serialize()));
		backup.prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?').run(board.id, editor.id);
		before0071(backup);
		expect(backup.prepare('SELECT active FROM webhooks WHERE id = ?').pluck().get(theirs.id)).toBe(1);
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const result = restoreFromBackup(sqlite, backup, { by: 'chief' });

			expect(result.webhooksSwitchedOff).toBe(1);
			expect(sqlite.prepare('SELECT id, active, held_because AS heldBecause FROM webhooks ORDER BY id').all()).toEqual([
				{ id: theirs.id, active: 0, heldBecause: 'setter cannot open' },
				{ id: owners.id, active: 1, heldBecause: null }
			]);
			const warned = column<string>(sqlite, "SELECT message FROM system_logs WHERE context = 'Webhooks' AND level = 'WARN' ORDER BY id");
			expect(warned.filter((line) => line.startsWith(`Webhook ${theirs.id} `))).toEqual([
				`Webhook ${theirs.id} on board ${board.id} switched off: the account that set it up (user ${editor.id}) can no longer open the board ` +
					'(found after a restore by chief). It stays off until an owner of the board or an administrator switches it on.'
			]);
		} finally {
			quiet.mockRestore();
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		// The board given back: an event sends nothing to theirs.
		addBoardMember(board, editor, 'editor');
		const sent = effects();
		try {
			dispatchWebhook(board.id, 'card.created', { cardId: 1 });
			await sent.settle();
			expect(sent.webhooks.map((w) => w.url)).toEqual([owners.address]);
		} finally {
			sent.restore();
		}
	});

	// Card 2899's code review, F1: a line for each webhook let a backup with many
	// flood the log, which keeps a count of lines; one WARN names the first 20.
	it('2899 F1. a restore that switches off more than 20 webhooks writes one WARN naming the first 20 and counting the rest', () => {
		const owner = makeUser();
		const editor = makeUser();
		const boards = [makeBoard({ owner }).board, makeBoard({ owner }).board, makeBoard({ owner }).board];
		const hooks = boards.flatMap((board, b) => {
			addBoardMember(board, editor, 'editor');
			return Array.from({ length: [8, 8, 6][b] }, (_, i) => makeWebhook(board, { url: `https://hooks.example.test/${b}-${i}`, setBy: editor }));
		});
		expect(hooks).toHaveLength(22);
		// The backup: the editor off every board, their webhooks on, and no hold columns.
		const backup = opening(Buffer.from(sqlite.serialize()));
		backup.prepare('DELETE FROM board_members WHERE user_id = ?').run(editor.id);
		before0071(backup);
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const result = restoreFromBackup(sqlite, backup, { by: 'chief' });

			expect(result.webhooksSwitchedOff).toBe(22);
			const warned = column<string>(sqlite, "SELECT message FROM system_logs WHERE context = 'Webhooks' AND level = 'WARN' ORDER BY id");
			const switchedOff = warned.filter((line) => / switched off[ :(]/.test(line) && !line.startsWith('The owners'));
			expect(switchedOff).toHaveLength(1);
			expect(switchedOff[0]).toMatch(/^22 webhooks switched off \(found after a restore by chief\): webhook \d+ on board \d+: the account that set it up/);
			expect(switchedOff[0].match(/webhook \d+ on board \d+: /g)).toHaveLength(20);
			expect(switchedOff[0].endsWith('; and 2 more. Each stays off until an owner of its board or an administrator switches it on.')).toBe(true);
		} finally {
			quiet.mockRestore();
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
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
	const put = (destinations: unknown[]) => api('PUT', '/api/admin/backup', confirmedByChief({ destinations }));
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

			// Tested as the page sends a saved destination, every secret masked: a Test of a
			// secret typed is refused (card 2939, P3).
			handed.length = 0;
			const test = await tested(page[at]);
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

	it('shows a service account JSON’s allowlisted fields alone and masks every other, JSON of another shape included (card 2938’s code review, R1)', async () => {
		store(OTHER_SHAPES.map((other, i) => ({ ...ROBOT, name: `Shape ${i}`, serviceAccountJson: JSON.stringify(other.json) })));

		const res = await api('GET', '/api/admin/backup', { user: chief });

		expect(JSON.stringify(res.body)).not.toContain('r1-2938');
		expect((res.body.destinations as { serviceAccountJson: string }[]).map((d) => JSON.parse(d.serviceAccountJson))).toEqual(
			OTHER_SHAPES.map((other) => withOthers(other, MASK))
		);
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

	// ── Card 2939: a Google Drive destination takes only a service account's key file ──

	describe('a service account JSON, read by the one rule at the save (card 2939)', () => {
		/** In every JSON a case sends: no answer may hold it (case 17). */
		const MARKER = 'zz-2939-marker';
		const EMAIL = 'robot@project.iam.example.test';
		/** A new service account destination holding `json`. */
		const added = (json: string) => ({ type: 'gdrive', name: 'New', authMethod: 'service_account', folderId: 'folder-2939', serviceAccountJson: json });
		const EXTERNAL = JSON.stringify({
			type: 'external_account',
			audience: `aud-${MARKER}`,
			subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
			token_url: `https://${MARKER}.invalid/token`,
			credential_source: { file: '/etc/hostname' }
		});
		/** Google's whole key file, as it downloads. */
		const GOOGLE_FILE = {
			type: 'service_account',
			project_id: 'project-2939',
			private_key_id: 'key-id-2939',
			private_key: `-----BEGIN PRIVATE KEY-----\n${MARKER}\n-----END PRIVATE KEY-----\n`,
			client_email: EMAIL,
			client_id: '1029384756',
			auth_uri: 'https://accounts.google.com/o/oauth2/auth',
			token_uri: 'https://oauth2.googleapis.com/token',
			auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
			client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/robot',
			universe_domain: 'googleapis.com'
		};
		/** A 400 naming the field and saying `words`, nothing written, and none of the JSON in the answer. */
		const refusedWith = async (send: () => Promise<{ status: number; body: Record<string, unknown> }>, words: string) => {
			const before = snapshotDb();
			handed.length = 0;
			const res = await send();
			expect(res.status, JSON.stringify(res.body)).toBe(400);
			expect(res.body.message).toBe(words);
			expect(JSON.stringify(res.body)).not.toContain(MARKER);
			expect(handed).toEqual([]);
			expectUnchanged(before);
		};
		const saveRefusal = (refusal: keyof typeof SERVICE_ACCOUNT_REFUSALS) => `destinations[0].serviceAccountJson ${SERVICE_ACCOUNT_REFUSALS[refusal]}`;

		it('refuses an external_account JSON, which would read a file and post it anywhere (case 1)', async () => {
			await refusedWith(() => put([added(EXTERNAL)]), saveRefusal('not-key'));
		});

		it('refuses text that is not JSON in words that quote none of it (cases 2, 17)', async () => {
			await refusedWith(() => put([added(`{"type":"service_account","private_key":"${MARKER}`)]), saveRefusal('not-json'));
		});

		it.each([['null'], ['0'], ['""'], ['[]'], [`"${MARKER}"`]])('refuses JSON that reads as %s, which is no object (case 15)', async (json) => {
			await refusedWith(() => put([added(json)]), saveRefusal('not-key'));
		});

		it('refuses a key whose private_key_id, a field the rule reads, is not text (case 3)', async () => {
			await refusedWith(() => put([added(JSON.stringify({ ...GOOGLE_FILE, private_key_id: 2939 }))]), saveRefusal('not-key'));
		});

		it('refuses a key with no client_email (case 4)', async () => {
			const { client_email: _email, ...noEmail } = GOOGLE_FILE;
			await refusedWith(() => put([added(JSON.stringify(noEmail))]), saveRefusal('not-key'));
		});

		it('refuses a key naming a universe_domain other than googleapis.com (case 5)', async () => {
			await refusedWith(() => put([added(JSON.stringify({ ...GOOGLE_FILE, universe_domain: `${MARKER}.invalid` }))]), saveRefusal('other-universe'));
		});

		it('accepts the key-less shape with no private_key at all, stores it as it is, and lists it to enter (the code review, F6)', async () => {
			const keyless = JSON.stringify({ type: 'service_account', client_email: EMAIL, private_key_id: 'key-id-2939' });

			const saved = await put([added(keyless)]);

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(storedDestinations()[0].serviceAccountJson).toBe(keyless);
			expect(credentialsMissing(storedDestinations()[0])).toBe(CREDENTIALS_NOT_ENTERED);
		});

		it("accepts a key whose universe_domain is '', the default (case 16)", async () => {
			const saved = await put([added(JSON.stringify({ ...GOOGLE_FILE, universe_domain: '' }))]);
			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
		});

		it("stores Google's whole key file rebuilt to the fields DumpFire uses, in its order, the key sealed; a field the rule does not read is dropped whatever it holds (cases 6, 3)", async () => {
			const pasted = { ...GOOGLE_FILE, privateKey: { pem: `camel-${MARKER}` }, quota_project_id: { nested: true } };

			const saved = await put([added(JSON.stringify(pasted, null, 2))]);

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			const { type, project_id, private_key_id, private_key, client_email, client_id } = GOOGLE_FILE;
			const stored = JSON.parse(settingsStored(sqlite)['backup_config']).destinations[0].serviceAccountJson as string;
			expect(Object.keys(JSON.parse(stored))).toEqual(['type', 'project_id', 'private_key_id', 'private_key', 'client_email', 'client_id']);
			expect(isSealed(JSON.parse(stored).private_key)).toBe(true);
			expect(stored).not.toContain(MARKER);
			expect(getBackupConfig().destinations[0]).toEqual(
				added(JSON.stringify({ type, project_id, private_key_id, private_key, client_email, client_id }))
			);
		});

		it.each([
			['a valid key', JSON.stringify(GOOGLE_FILE)],
			['an external_account JSON', EXTERNAL],
			// The code review's F6: masked JSON is refused under OAuth before the mask skip.
			['a JSON sent masked', serviceAccountJson(MASK)]
		])('refuses %s with a destination that signs in with OAuth (case 8)', async (_json, json) => {
			await refusedWith(
				() => put([{ ...DRIVE, serviceAccountJson: json }]),
				`destinations[0].serviceAccountJson ${SERVICE_ACCOUNT_UNDER_OAUTH}`
			);
		});

		it('keeps the stored JSON whole for a JSON sent masked, whatever else it holds; one holding part of the mask is checked as typed (case 9)', async () => {
			const crafted = (privateKey: string) =>
				JSON.stringify({ type: 'external_account', client_email: EMAIL, private_key_id: 'key-id-1', token_url: `https://${MARKER}.invalid`, credential_source: { file: '/etc/hostname' }, private_key: privateKey });
			const page = await shown();

			await refusedWith(() => put(page.map((d, i) => (i === 3 ? { ...d, serviceAccountJson: crafted('•') } : d))), `destinations[3].serviceAccountJson ${SERVICE_ACCOUNT_REFUSALS['not-key']}`);

			const saved = await put(page.map((d, i) => (i === 3 ? { ...d, serviceAccountJson: crafted(MASK) } : d)));
			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(storedDestinations()[3].serviceAccountJson).toBe(STORED[3].serviceAccountJson);
		});

		it('saves back, unchanged and with no change line, what the GET shows of a restored copy of Google’s whole key file (case 7: whatever the GET shows, the save accepts)', async () => {
			const shownFields = ['type', 'project_id', 'client_email', 'private_key_id', 'client_id'];
			// As a backup's copy leaves it: every field but the allowlist '', the key among them.
			const copy = Object.fromEntries(Object.entries(GOOGLE_FILE).map(([field, value]) => [field, shownFields.includes(field) ? value : '']));
			const restored = sealedForRestore('settings', [{ key: 'backup_config', value: configWith([{ ...ROBOT, serviceAccountJson: JSON.stringify(copy) }]) }]);
			sqlite.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('backup_config', restored.rows[0].value);
			const before = storedDestinations();
			const from = (sqlite.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM system_logs').get() as { n: number }).n;

			const saved = await put(await shown());

			expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			expect(storedDestinations()).toEqual(before);
			expect(credentialsMissing(before[0])).toBe(CREDENTIALS_NOT_ENTERED);
			const changeLines = sqlite.prepare("SELECT message FROM system_logs WHERE id > ? AND message LIKE 'Backup settings changed%'").all(from);
			expect(changeLines).toEqual([]);
		});

		it('refuses an external_account JSON at a Test too, before anything is made (case 10)', async () => {
			await refusedWith(() => tested(added(EXTERNAL)), `serviceAccountJson ${SERVICE_ACCOUNT_REFUSALS['not-key']}`);
		});

		it.each([
			['a saved S3 destination with its endpoint typed', () => ({ ...BUCKET, secretAccessKey: '', endpoint: `https://${MARKER}.invalid` })],
			[
				'the saved service account with a key typed, the same account',
				() => ({ ...ROBOT, serviceAccountJson: JSON.stringify({ type: 'service_account', client_email: EMAIL, private_key_id: 'key-id-1', private_key: `typed-${MARKER}` }) })
			],
			['a destination never saved, with no secret', () => ({ type: 'sftp', name: 'Elsewhere', host: `${MARKER}.invalid`, port: 22, username: 'u', remotePath: '/' })]
		])('runs no Test of %s: save it first (case 18, ruling P3)', async (_case, sent) => {
			await refusedWith(() => tested(sent()), SAVE_BEFORE_TEST);
		});

		it('tests a masked secret beside an emptied one, at the same place, with the stored secrets (the code review, F6)', async () => {
			const nas = (await shown())[0];
			handed.length = 0;

			const res = await tested({ ...nas, privateKey: '' });

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(handed.map((config) => [config.password, config.privateKey])).toEqual([[SECRETS.sftpPassword, SECRETS.sftpKey]]);
		});

		it('answers a Test the same as two saved destinations with the save’s own words, not "save it first" (the code review, F4)', async () => {
			store([
				{ ...NAS, password: 'the-first-password' },
				{ ...NAS, password: 'the-second-password' }
			]);

			await refusedWith(
				() => tested({ ...NAS, password: '', privateKey: '' }),
				'Backup destination "NAS": more than one saved destination matches it, so its saved secret cannot be told apart. ' +
					'Remove the destinations named "NAS" (the page\'s Remove removes every one of that name, and removing a destination is the ' +
					"superadmin's) and add it once with its secret typed."
			);
		});

		it('tests the stored entry of a saved destination sent as the GET shows it, never what was sent (case 18, ruling P3)', async () => {
			const nas = (await shown())[0];
			handed.length = 0;

			const res = await tested({ ...nas, host: 'NAS.Example.Test' });

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(handed).toEqual([NAS]);
		});
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

	/** Google's code exchange, stood in for: it answers `tokens`, after `meanwhile` has run. */
	const exchange = (tokens: Record<string, unknown>, meanwhile?: () => Promise<unknown>) =>
		vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockImplementation((async () => {
			await meanwhile?.();
			return { tokens, res: null };
		}) as never);
	/**
	 * Connect's first half, as the page asks it: the consent address, read. The
	 * superadmin's from the session each test begins with, which the second
	 * half is sent from too (card 2775: the second half's password is counted
	 * on the session the gate names), unless a test names another caller.
	 */
	const begin = async (opts: { user?: SessionUser; credential?: Credential | null; dest?: string } = {}) => {
		const res = await api('GET', `/api/admin/backup/gdrive/auth?dest=${opts.dest ?? 'G'}`, {
			user: opts.user ?? chief,
			...('credential' in opts ? { credential: opts.credential } : opts.user ? {} : { credential: sessionCredential(chiefSession) })
		});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		return { res, address: new URL(res.body.authUrl), state: new URL(res.body.authUrl).searchParams.get('state') };
	};
	/**
	 * Its second half: the code and the state from the address Google's page
	 * leads to (card 2251), with the caller's current password (card 2701).
	 */
	const finish = (state: unknown, opts: { user?: SessionUser; credential?: Credential | null; destName?: string } = {}) => {
		const body = { code: 'the-code', ...(state === undefined ? {} : { state }), destName: opts.destName ?? 'G' };
		return api('POST', '/api/admin/backup/gdrive/auth', {
			...(opts.user ? stepUp(opts.user, body) : confirmedByChief(body)),
			...('credential' in opts ? { credential: opts.credential } : {})
		});
	};
	/** Both halves, as one superadmin in one session. */
	const connect = async () => finish((await begin()).state);
	/**
	 * `before`, with the factors as they are now, once they are checked to
	 * differ by the code's step spent and nothing else: a Connect refused after
	 * the password and code were checked leaves the code spent (card 2771, S4).
	 */
	const withCodeSpent = (before: ReturnType<typeof snapshotDb>) => {
		const factors = snapshotDb().mfa_factors;
		expect(diffSnapshots({ mfa_factors: before.mfa_factors }, { mfa_factors: factors })).toEqual([
			expect.stringMatching(/^mfa_factors: row \d+ changed \(last_step: null became \d+; last_used_at: null became /)
		]);
		return { ...before, mfa_factors: factors };
	};

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

		// The clock pinned a tenth of a second before midnight, on purpose (card
		// 2410): the date in the folder's name was read again after the Connect,
		// so a run that crossed midnight in between expected the next day's.
		vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-22T23:59:59.900Z') });
		let res: Awaited<ReturnType<typeof connect>>;
		try {
			// Signed in on that clock: a session whose start is ahead of it has
			// passed (card 2775).
			chiefSession = makeSession(chief);
			res = await connect();
		} finally {
			vi.useRealTimers();
		}

		expect(res.body).toEqual({
			success: true,
			message: 'Google Drive connected. DumpFire made the folder "DumpFire backups (made 2026-10-22)" in this account\'s My Drive, and backs up there.'
		});
		expect(files.create).toHaveBeenCalledTimes(1);
		expect(files.create.mock.calls[0][0]).toMatchObject({ requestBody: { name: 'DumpFire backups (made 2026-10-22)', mimeType: FOLDER_TYPE } });
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
		expectUnchanged(withCodeSpent(before));
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
		expectUnchanged(withCodeSpent(before));
	});

	it('tells a destination connected before card 2188 to remove DumpFire’s access in the Google account first (test 12, R2)', async () => {
		store({ ...G, folderId: 'hand-made', refreshToken: 'rt-old' });
		files.get.mockRejectedValue(notFound());
		exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE });
		const before = snapshotDb();

		const res = await connect();

		expect(res.body).toEqual({ success: false, message: cannotReach(true) });
		expectUnchanged(withCodeSpent(before));
	});

	it('saves nothing when the destination is changed while Google answers, and removes the folder it made (test 13, R5)', async () => {
		store(G);
		// A save of the settings lands while Google is answering.
		exchange({ refresh_token: 'rt-new', scope: DRIVE_FILE_SCOPE }, () =>
			api('PUT', '/api/admin/backup', confirmedByChief({ destinations: [{ ...G, folderId: 'chosen-meanwhile' }] }))
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

	describe('a service account signs in with a JWT built from its key alone (card 2939)', () => {
		const MARKER = 'zz-2939-drive';
		const KEY = {
			type: 'service_account',
			project_id: 'project-2939',
			private_key_id: 'key-id-2939',
			private_key: 'private-key-2939',
			client_email: 'robot-2939@project.iam.example.test',
			client_id: '2939'
		};
		const robot = (json: string): GDriveDestinationConfig => ({ type: 'gdrive', name: 'R', authMethod: 'service_account', serviceAccountJson: json, folderId: 'folder-2939' });
		const driveCalls = () => vi.mocked(google.drive).mock.calls as unknown as [{ auth: unknown }][];

		it('hands Drive a JWT of the email, key, key ID and drive.file alone; no GoogleAuth, no fromJSON, and token_uri and quota_project_id reach nothing (cases 11, 22)', async () => {
			const spies = [
				vi.spyOn(google.auth.GoogleAuth.prototype, 'getClient'),
				vi.spyOn(google.auth.GoogleAuth.prototype, 'fromJSON'),
				vi.spyOn(google.auth.JWT.prototype, 'fromJSON')
			];
			onTestFinished(() => spies.forEach((spy) => spy.mockRestore()));
			files.get.mockResolvedValue(found('folder-2939'));
			vi.mocked(google.drive).mockClear();

			const result = await new GDriveDestination(
				robot(JSON.stringify({ ...KEY, token_uri: `https://${MARKER}.invalid/token`, quota_project_id: `quota-${MARKER}`, universe_domain: 'googleapis.com' }))
			).test();

			expect(result.success, result.message).toBe(true);
			const auth = driveCalls()[0][0].auth as InstanceType<typeof google.auth.JWT>;
			expect(auth).toBeInstanceOf(google.auth.JWT);
			expect({
				email: auth.email,
				key: auth.key,
				keyId: auth.keyId,
				scopes: auth.scopes,
				keyFile: auth.keyFile,
				subject: auth.subject,
				additionalClaims: auth.additionalClaims,
				quotaProjectId: auth.quotaProjectId,
				apiKey: auth.apiKey,
				universeDomain: auth.universeDomain
			}).toEqual({
				email: KEY.client_email,
				key: KEY.private_key,
				keyId: KEY.private_key_id,
				scopes: [DRIVE_FILE_SCOPE],
				keyFile: undefined,
				subject: undefined,
				additionalClaims: undefined,
				quotaProjectId: undefined,
				apiKey: undefined,
				universeDomain: 'googleapis.com'
			});
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		});

		it.each([
			['an external_account JSON (case 12)', JSON.stringify({ type: 'external_account', token_url: `https://${MARKER}.invalid`, credential_source: { file: '/etc/hostname' } }), SERVICE_ACCOUNT_NOT_A_KEY],
			['null (case 19)', 'null', SERVICE_ACCOUNT_NOT_A_KEY],
			['0 (case 19)', '0', SERVICE_ACCOUNT_NOT_A_KEY],
			['"" (case 19)', '""', SERVICE_ACCOUNT_NOT_A_KEY],
			['[] (case 19)', '[]', SERVICE_ACCOUNT_NOT_A_KEY],
			['a quoted string (case 19)', `"${MARKER}"`, SERVICE_ACCOUNT_NOT_A_KEY],
			['text that is not JSON, never quoted (case 20)', `{"private_key": "${MARKER}`, SERVICE_ACCOUNT_NOT_A_KEY],
			['a key naming another universe (case 21)', JSON.stringify({ ...KEY, universe_domain: `${MARKER}.invalid` }), SERVICE_ACCOUNT_NOT_A_KEY],
			['what a copy leaves of a key (case 13)', JSON.stringify({ ...KEY, private_key: '' }), CREDENTIALS_NOT_ENTERED]
		])('answers a Test of a stored JSON holding %s in the run’s own words, and reaches nothing', async (_shape, json, says) => {
			vi.mocked(google.drive).mockClear();

			const result = await new GDriveDestination(robot(json)).test();

			expect(result).toEqual({ success: false, message: says });
			expect(JSON.stringify(result)).not.toContain(MARKER);
			expect(google.drive).not.toHaveBeenCalled();
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
			LAPTOP = sessionCredential(makeSession(chief));
			PHONE = sessionCredential(makeSession(chief));
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
			expectUnchanged(withCodeSpent(before));
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
			const session = (n: number): Credential => sessionCredential(tokens[n]);
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
						api('PUT', '/api/admin/backup', confirmedByChief({ destinations: [{ ...G, folderId: 'chosen-meanwhile' }] }))
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
					api('PUT', '/api/admin/backup', confirmedByChief({ destinations: [{ ...G, name: NAME, folderId: 'chosen-meanwhile' }] }))
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
		expect(scriptOf(panel)).toContain("import { NO_ANSWER, sent, sentAsking, showToast } from '$lib/admin/send';");
		expect(scriptOf(panel)).toContain("refused = await failureMessage(res, 'Failed to save backup settings');");
		expect(scriptOf(connectBox)).toContain("showToast(said || 'Failed to connect', 'error', started);");
	});
});

// ─── Card 2671: a restore keeps this server's disabled accounts disabled ─────

describe('a restore and the accounts disabled here (card 2671, S6)', () => {
	const DISABLED_AT = '2099-01-02 09:00:00';
	let chief: SessionUser;
	let admin: SessionUser;
	let bob: SessionUser;
	let hook: number;

	beforeEach(() => {
		resetDb();
		chief = makeUser({ username: 'chief', role: 'superadmin' });
		admin = makeUser({ username: 'admin', role: 'admin' });
		bob = makeUser({ username: 'bob' });
		makeApiKeyRow(bob);
		sqlite.prepare("INSERT INTO report_schedules (user_id, name, scope, enabled) VALUES (?, 'Weekly', 'all', 1)").run(bob.id);
		const board = makeBoard({ owner: bob, name: 'Bob board' }).board;
		hook = makeWebhook(board, { setBy: bob, secret: 's3cret' }).id;
	});

	/** The running database as it is now, as a backup of it. */
	const backupNow = () => opening(Buffer.from(sqlite.serialize()));
	/** Bob disabled here, by `by`, as `disableAccount` writes it. */
	const disableBob = (by: number | null = admin.id) =>
		sqlite.prepare('UPDATE users SET disabled_at = ?, disabled_by = ? WHERE id = ?').run(DISABLED_AT, by, bob.id);
	const bobNow = () => sqlite.prepare('SELECT disabled_at AS disabledAt, disabled_by AS disabledBy FROM users WHERE id = ?').get(bob.id);
	const keysOfBob = () => (sqlite.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?').get(bob.id) as { n: number }).n;
	const schedulesOfBob = () => sqlite.prepare('SELECT enabled FROM report_schedules WHERE user_id = ?').pluck().all(bob.id);

	it('case 39: keeps an account disabled here disabled, though the backup was made before, its restored keys ended and its schedules paused', () => {
		const backup = backupNow();
		disableBob();

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(bobNow()).toEqual({ disabledAt: DISABLED_AT, disabledBy: admin.id });
		expect(keysOfBob()).toBe(0);
		expect(schedulesOfBob()).toEqual([0]);
	});

	it('case 39: does the same from a backup made before migration 0072, which has neither column', () => {
		const backup = backupNow();
		backup.pragma('foreign_keys = OFF');
		backup.exec(`
			CREATE TABLE users_before_0072 AS SELECT id, username, email, password_hash, emoji, role, notification_prefs, created_at,
				mfa_known_wrong, mfa_other_wrong, mfa_known_resumes_at, mfa_other_resumes_at, mfa_recovery_wrong, mfa_recovery_resumes_at,
				last_sign_in_at, last_sign_in_from, failed_codes_since_sign_in, security_banner, security_banner_at, mfa_password_enrol,
				security_signal_last_at FROM users;
			DROP TABLE users;
			ALTER TABLE users_before_0072 RENAME TO users;
		`);
		expect((backup.pragma('table_info(users)') as { name: string }[]).map((c) => c.name)).not.toContain('disabled_at');
		disableBob();

		restoreFromBackup(sqlite, backup);

		expect(bobNow()).toEqual({ disabledAt: DISABLED_AT, disabledBy: admin.id });
		expect(keysOfBob()).toBe(0);
	});

	it('case 39: empties disabled_by where the account that disabled it is not among those restored', () => {
		const backup = backupNow();
		// Made after the backup, so the backup has no account of its id.
		const later = makeUser({ username: 'later', role: 'admin' });
		disableBob(later.id);

		restoreFromBackup(sqlite, backup);

		expect(bobNow()).toEqual({ disabledAt: DISABLED_AT, disabledBy: null });
	});

	// The code review's CS3: an id alone may name another account in the backup.
	it('CS3: empties disabled_by where the backup holds an account of that id that is not the one that disabled it', () => {
		const backup = backupNow();
		backup.prepare("UPDATE users SET created_at = '2099-03-04 05:06:07' WHERE id = ?").run(admin.id);
		disableBob(admin.id);

		restoreFromBackup(sqlite, backup);

		expect(bobNow()).toEqual({ disabledAt: DISABLED_AT, disabledBy: null });
	});

	it('CS3: names the restored superadmin where the superadmin here disabled it and is not restored as itself', () => {
		const backup = backupNow();
		// In the backup, the superadmin is the account of admin's id, and chief's id is another account, an administrator.
		backup.prepare("UPDATE users SET role = 'admin', created_at = '2099-03-04 05:06:07' WHERE id = ?").run(chief.id);
		backup.prepare("UPDATE users SET role = 'superadmin' WHERE id = ?").run(admin.id);
		disableBob(chief.id);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(bobNow()).toEqual({ disabledAt: DISABLED_AT, disabledBy: admin.id });
	});

	it('CS3: keeps disabled_by where the account that disabled it is restored as itself', () => {
		const backup = backupNow();
		disableBob(chief.id);

		restoreFromBackup(sqlite, backup);

		expect(bobNow()).toEqual({ disabledAt: DISABLED_AT, disabledBy: chief.id });
	});

	// The code review's CS4: only a database without the columns is read as having no disabled accounts.
	it('CS4: a failure reading the disabled accounts here is not taken for none: the restore throws and changes nothing', () => {
		const backup = backupNow();
		disableBob();
		const before = snapshotDb();
		const prepare = sqlite.prepare.bind(sqlite);
		vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
			if (source.includes('AS disablerRole')) throw new Error('disk I/O error');
			return prepare(source);
		}) as typeof sqlite.prepare);

		expect(() => restoreFromBackup(sqlite, backup)).toThrow();

		vi.restoreAllMocks();
		expectUnchanged(before);
		expect(bobNow()).toEqual({ disabledAt: DISABLED_AT, disabledBy: admin.id });
	});

	it("case 40: never carries onto a restored superadmin, and the restore is accepted", () => {
		const backup = backupNow();
		backup.prepare("UPDATE users SET role = 'superadmin' WHERE id = ?").run(bob.id);
		disableBob();

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(bobNow()).toEqual({ disabledAt: null, disabledBy: null });
		expect(superadminsOf(sqlite)).toEqual(['chief', 'bob']);
	});

	it('case 40: refuses a backup whose only superadmin is disabled, and changes nothing', () => {
		const backup = backupNow();
		backup.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(DISABLED_AT, chief.id);
		// Sealed with this server's key, as its own backup of a database that held it so: a copy whose seal did not verify
		// would keep this server's superadmin enabled (card 3009, R2).
		sealCopy(backup, backupSealKey(sqlite));
		const before = snapshotDb();

		expect(backupLacksSuperadmin(backup)).toBe(true);
		expect(() => restoreFromBackup(sqlite, backup)).toThrow(RestoreError);

		expectUnchanged(before);
	});

	// The code review's CS2: the disable took bob's address out of the failure address; a backup from before puts it
	// back, and the restore's sweep, which Import Backup runs once the restore is committed, takes it out again.
	it('CS2: export, disable, import: the account stays disabled and its address stays out of the backup failure address', () => {
		const failureTo = (notifyEmail: string) =>
			sqlite.prepare("INSERT INTO settings (key, value) VALUES ('backup_config', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
				JSON.stringify({ schedule: 'daily', retention: 7, notifyOnFailure: true, notifyEmail })
			);
		const failureAddressNow = () =>
			JSON.parse((sqlite.prepare("SELECT value FROM settings WHERE key = 'backup_config'").get() as { value: string }).value).notifyEmail;
		failureTo(`ops@example.test, ${bob.email}`);
		const backup = backupNow();
		inTransaction(() => disableAccount(db.select().from(users).all().find((u) => u.id === bob.id)!, { id: admin.id, username: 'admin', role: 'admin' }));
		expect(failureAddressNow()).toBe('ops@example.test');

		restoreFromBackup(sqlite, backup);
		expect(failureAddressNow()).toBe(`ops@example.test, ${bob.email}`);
		removeSettingsOfFormerAdministrators('restore');

		expect((bobNow() as { disabledAt: string | null }).disabledAt).not.toBeNull();
		expect(failureAddressNow()).toBe('ops@example.test');
	});

	it("case 41: the carried account's webhook is switched off by the same restore's sweep, which runs after the carry", () => {
		const backup = backupNow();
		disableBob();

		const result = restoreFromBackup(sqlite, backup);

		expect(result.webhooksSwitchedOff).toBe(1);
		expect(sqlite.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(hook)).toEqual({
			active: 0,
			heldBecause: 'setter cannot open'
		});
	});

	// Card 2923 (case 17, S3), as its code review ruled (S2, S3, E2, S4): the restore holds already-off webhooks, after its
	// carries, on the server's own database and on a working copy alike; only the server's own is told.
	describe('the webhooks already off a restore holds (card 2923)', () => {
		let eve: SessionUser;
		let eves: number;
		let board: number;
		const rowOf = (id: number) => sqlite.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(id);
		const warned = () => column<string>(sqlite, "SELECT message FROM system_logs WHERE context = 'Webhooks' AND level = 'WARN' ORDER BY id");
		const schedulers = process.env.SCHEDULERS;
		const level = process.env.LOG_LEVEL;

		beforeEach(() => {
			eve = makeUser({ username: 'eve' });
			board = sqlite.prepare('SELECT board_id FROM webhooks WHERE id = ?').pluck().get(hook) as number;
			// Bob's switched off by a PUT, and one an enabled account set, switched off the same way.
			eves = sqlite
				.prepare("INSERT INTO webhooks (board_id, url, events, secret, active, set_by) VALUES (?, 'https://eve.example.test/x', '[]', '', 0, ?) RETURNING id")
				.pluck()
				.get(board, eve.id) as number;
			sqlite.prepare('UPDATE webhooks SET active = 0 WHERE id = ?').run(hook);
			process.env.LOG_LEVEL = 'WARN';
			vi.spyOn(console, 'warn').mockImplementation(() => {});
		});
		afterEach(() => {
			vi.restoreAllMocks();
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
			if (schedulers === undefined) delete process.env.SCHEDULERS;
			else process.env.SCHEDULERS = schedulers;
		});

		it("2923 case 17: from a backup made since the release, the server's restore holds the one of an account disabled here, not an enabled account's, and tells the owners with its sweep", async () => {
			startedSinceAlreadyOffHeld();
			makeSmtp();
			const backup = backupNow();
			disableBob();
			process.env.SCHEDULERS = 'on';
			const sent = effects();
			try {
				const result = restoreFromBackup(sqlite, backup, { by: 'chief' });
				await sent.settle();

				expect(result.errors).toEqual([]);
				expect(result.webhooksSwitchedOff).toBe(0);
				expect(rowOf(hook)).toEqual({ active: 0, heldBecause: 'setter access ended' });
				expect(rowOf(eves)).toEqual({ active: 0, heldBecause: null });
				// Told after the commit with the sweep, which switched nothing off: the held line alone, and the owners
				// mailed, the schedulers running: bob, the board's only owner, is disabled, so its administrators.
				expect(warned()).toEqual([
					`Webhook ${hook} on board ${board}, already switched off, is now held: it was found switched off with no hold, as it may have been ` +
						`when the access of the account that set it up (user ${bob.id}) ended (found after a restore by chief). ` +
						'Switched on again by an owner of the board or an administrator, it is given a new secret.'
				]);
				expect(sent.emails.map((mail) => [mail.to, mail.subject]).sort()).toEqual(
					[
						[admin.email, 'A notice about webhooks on your boards'],
						[chief.email, 'A notice about webhooks on your boards']
					].sort()
				);
				for (const mail of sent.emails) expect(mail.html).toContain(`webhook ${hook} to <strong>hooks.example.test</strong>: already switched off; now held because`);
			} finally {
				sent.restore();
			}
		});

		it('2923 R2: from a backup made before the release, the restore holds every webhook already off with no hold, whoever set it, and writes no flag', () => {
			const backup = backupNow();
			expect(backup.prepare("SELECT 1 FROM settings WHERE key = 'webhooks_already_off_held'").get()).toBeUndefined();
			process.env.SCHEDULERS = 'off';

			const result = restoreFromBackup(sqlite, backup, { by: 'chief' });

			expect(result.errors).toEqual([]);
			expect(rowOf(hook)).toEqual({ active: 0, heldBecause: 'setter access ended' });
			expect(rowOf(eves)).toEqual({ active: 0, heldBecause: 'setter access ended' });
			expect(sqlite.prepare("SELECT 1 FROM settings WHERE key = 'webhooks_already_off_held'").get()).toBeUndefined();
			expect(warned()).toEqual([
				`2 webhooks already switched off are now held (found after a restore by chief): webhook ${hook} on board ${board}: it was found switched off ` +
					`with no hold, as it may have been when the access of the account that set it up (user ${bob.id}) ended; webhook ${eves} on board ${board}: ` +
					`it was found switched off with no hold, as it may have been when the access of the account that set it up (user ${eve.id}) ended. ` +
					'Each, switched on again by an owner of its board or an administrator, is given a new secret.',
				'The owners of the boards of the 2 webhook(s) switched off or held above were not mailed, as the schedulers are off (SCHEDULERS=off). The line above names them.'
			]);
		});

		it("2923 R4, R8: a working copy, restored over the server's own database, holds the same way before it switches every webhook off, and tells nobody", async () => {
			startedSinceAlreadyOffHeld();
			makeSmtp();
			const backup = backupNow();
			disableBob();
			process.env.SCHEDULERS = 'on';
			const sent = effects();
			try {
				const result = restoreFromBackup(sqlite, backup, { outside: 'off', by: 'chief' });
				await sent.settle();

				expect(result.errors).toEqual([]);
				expect(result.webhooksSwitchedOff).toBe(0);
				expect(rowOf(hook)).toEqual({ active: 0, heldBecause: 'setter access ended' });
				expect(rowOf(eves)).toEqual({ active: 0, heldBecause: null });
				// The `!working` guard: no sweep, no telling, no mail.
				expect(warned()).toEqual([]);
				expect(sent.emails).toEqual([]);
			} finally {
				sent.restore();
			}
		});

		it('2923 R8: a hold that fails rolls the restore back, and nothing is changed', () => {
			startedSinceAlreadyOffHeld();
			const backup = backupNow();
			disableBob();
			const before = snapshotDb();
			const prepare = sqlite.prepare.bind(sqlite);
			vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
				if (source.includes("held_because = 'setter access ended'") && source.includes('? = 1')) throw new Error('disk I/O error');
				return prepare(source);
			}) as typeof sqlite.prepare);

			expect(() => restoreFromBackup(sqlite, backup, { by: 'chief' })).toThrow(/The restore failed and nothing was changed: disk I\/O error/);

			vi.restoreAllMocks();
			expectUnchanged(before);
			expect(rowOf(hook)).toEqual({ active: 0, heldBecause: null });
		});
	});
});

// ─── Card 2898: the secrets the server keeps, sealed at rest ────────────────

describe('the secrets the server keeps, sealed at rest (card 2898)', () => {
	const put = (destinations: unknown[]) => api('PUT', '/api/admin/backup', confirmedByChief({ destinations }));
	const tested = (destination: unknown) => api('POST', '/api/admin/backup/test', { user: chief, body: destination });
	const runNow = async () =>
		(await api('POST', '/api/admin/backup', confirmedByChief())).body.results as { destination: string; status: string; message: string }[];
	const storedConfig = () => JSON.parse(settingsStored(sqlite)['backup_config']) as { destinations: Record<string, unknown>[] };
	const LOOKS_SEALED = 'dfsealed:1:0123456789abcdef:AAAAAAAAAAAAAAAA:AAAA';
	const otherKey = () => keyFromBytes(randomBytes(32));
	const secretOf = (database: Database.Database, id: number) =>
		(database.prepare('SELECT secret, active FROM webhooks WHERE id = ?').get(id) as { secret: string; active: number });

	afterEach(() => {
		keyStub.none = false;
	});

	it('28: a typed destination secret, or a service account JSON key, that begins dfsealed: is refused by the save and by the Test, and nothing is written', async () => {
		const before = settingsStored(sqlite);
		for (const res of [
			await put([{ ...BUCKET, secretAccessKey: LOOKS_SEALED }]),
			await put([{ ...ROBOT, serviceAccountJson: serviceAccountJson(LOOKS_SEALED) }]),
			await tested({ ...BUCKET, secretAccessKey: LOOKS_SEALED })
		]) {
			expect(res.status, JSON.stringify(res.body)).toBe(400);
			expect(res.body.message).toBe(TYPED_SECRET_LOOKS_SEALED);
		}
		expect(handed).toEqual([]);
		expect(settingsStored(sqlite)).toEqual(before);
	});

	it('29: the admin save stores each destination secret sealed, getBackupConfig gives them in plain, the GET masks them, and one kept masked is sealed again and opens', async () => {
		const saved = await put(DESTINATIONS);
		expect(saved.status, JSON.stringify(saved.body)).toBe(200);

		const stored = JSON.stringify(settingsStored(sqlite));
		for (const [name, value] of Object.entries(SECRETS)) expect(stored.includes(value), name).toBe(false);
		const first = storedConfig().destinations;
		expect(isSealed(first[1].secretAccessKey)).toBe(true);
		expect(isSealed(JSON.parse(first[3].serviceAccountJson as string).private_key)).toBe(true);
		expect(getBackupConfig().destinations).toEqual(DESTINATIONS);

		const shown = (await api('GET', '/api/admin/backup', { user: chief })).body.destinations as Record<string, unknown>[];
		expect(shown[1].secretAccessKey).toBe(SECRET_MASK);
		expect(JSON.stringify(shown)).not.toContain('dfsealed');

		const again = await put(shown);
		expect(again.status, JSON.stringify(again.body)).toBe(200);
		const second = storedConfig().destinations;
		expect(isSealed(second[1].secretAccessKey)).toBe(true);
		expect(second[1].secretAccessKey).not.toBe(first[1].secretAccessKey);
		expect(getBackupConfig().destinations).toEqual(DESTINATIONS);
	});

	it('30: a destination whose stored secret does not open is not tried, S3 and SFTP alike, Backup History saying its credentials are not entered', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const theirs = otherKey();
		const sftp = { ...NAS, privateKey: '', hostKey: HOST_KEY };
		sqlite
			.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
			.run(
				'backup_config',
				configWith([
					{ ...BUCKET, secretAccessKey: sealValue(SECRETS.s3Secret, destinationSecretAad(BUCKET, 'secretAccessKey'), theirs) },
					{ ...sftp, password: sealValue(SECRETS.sftpPassword, destinationSecretAad(sftp, 'password'), theirs) }
				])
			);

		const results = await runNow();

		expect(results.map((r) => [r.destination, r.status, r.message])).toEqual([
			['Bucket', 'failed', CREDENTIALS_NOT_ENTERED],
			['NAS', 'failed', CREDENTIALS_NOT_ENTERED]
		]);
		expect(handed).toEqual([]);
		expect(sqlite.prepare("SELECT destination_name AS name, error FROM backup_log WHERE status = 'failed' ORDER BY id").all()).toEqual([
			{ name: 'Bucket', error: CREDENTIALS_NOT_ENTERED },
			{ name: 'NAS', error: CREDENTIALS_NOT_ENTERED }
		]);
	});

	it('30b: a save that does not type again a secret whose stored value does not open keeps it as stored: never tried, the Test refused, still listed to enter (the code review E2, S3)', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const sftp = { ...NAS, privateKey: '', hostKey: HOST_KEY };
		const envelope = sealValue(SECRETS.sftpPassword, destinationSecretAad(sftp, 'password'), otherKey());
		sqlite.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('backup_config', configWith([{ ...sftp, password: envelope }]));
		const lines = () => sqlite.prepare("SELECT message FROM system_logs WHERE context = 'BACKUP' ORDER BY id").pluck().all() as string[];

		// An unrelated save: Keep Last alone.
		expect((await api('PUT', '/api/admin/backup', confirmedByChief({ retention: 9 }))).status).toBe(200);
		expect(storedConfig().destinations[0].password).toBe(envelope);

		// The list sent back as the GET shows it: the secret masked, as one stored.
		const shown = (await api('GET', '/api/admin/backup', { user: chief })).body.destinations as Record<string, unknown>[];
		expect(shown[0].password).toBe(SECRET_MASK);
		expect(JSON.stringify(shown)).not.toMatch(/unopenable|dfsealed/);
		const saved = await put(shown);
		expect(saved.status, JSON.stringify(saved.body)).toBe(200);
		expect(storedConfig().destinations[0]).toEqual({ ...sftp, password: envelope });
		// Compared without the carriers (E5): no line says the destination changed.
		expect(lines().filter((line) => /unopenable|NAS/.test(line))).toEqual([]);

		expect((await runNow()).map((r) => [r.destination, r.status, r.message])).toEqual([['NAS', 'failed', CREDENTIALS_NOT_ENTERED]]);
		expect((await tested({ ...sftp, password: SECRET_MASK })).status).toBe(400);
		expect(handed).toEqual([]);
		expect(secretsToEnter(sqlite).toEnter.destinations.map((d) => d.name)).toEqual(['NAS']);

		// Typed again: the line names the password changed, never the carriers or the envelope (E5).
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'INFO';
		vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const retyped = await put([{ ...shown[0], password: 'typed-again-2898' }]);
			expect(retyped.status, JSON.stringify(retyped.body)).toBe(200);
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
		const changedLines = sqlite.prepare("SELECT message || ' ' || COALESCE(meta, '') FROM system_logs WHERE message LIKE 'Backup settings changed:%' ORDER BY id").pluck().all() as string[];
		expect(changedLines).toHaveLength(1);
		expect(changedLines[0]).toMatch(/^Backup settings changed: destination "NAS" changed: password /);
		expect(changedLines.filter((line) => /unopenable|dfsealed/i.test(line))).toEqual([]);
		expect(secretsToEnter(sqlite).toEnter.destinations).toEqual([]);
	});

	it("30c: a restore's destination matched with one here whose credential does not open is listed to enter, never given the host key as one with no credentials (the code review E2, S3)", () => {
		const sftp = { ...NAS, privateKey: '', hostKey: HOST_KEY };
		const envelope = sealValue(SECRETS.sftpPassword, destinationSecretAad(sftp, 'password'), otherKey());
		sqlite.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('backup_config', configWith([{ ...sftp, password: envelope }]));
		const backup = opening(generateBackupData());

		const result = restoreFromBackup(sqlite, backup);

		expect(result.sealVerified).toBe(true);
		expect(result.secrets.toEnter.destinations.map((d) => d.name)).toEqual(['NAS']);
		const restored = storedConfig().destinations[0];
		expect(restored.hostKey).toBeUndefined();
		expect(restored.password).toBe('');
	});

	it("33c: a restore of a backup whose secrets were sealed under another key leaves them unopenable: never filled, never used, listed to enter (the code review's tests)", () => {
		armSecrets(sqlite);
		const theirs = otherKey();
		sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'smtp_pass'").run(sealValue('their password', mailPasswordAad(MAIL), theirs));
		const backup = opening(Buffer.from(sqlite.serialize()));
		const live = migratedDb();

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		expect(result.secrets.kept.mailPassword).toBe(false);
		const stored = settingsStored(live)['smtp_pass'];
		expect(stored).toMatch(/^dfsealed:1:/);
		expect(openStored(stored, mailPasswordAad(MAIL)).kind).toBe('unopenable');
		expect(secretsToEnter(live).toEnter.mailPassword).toBe(true);
	});

	it('33d: every restore marks the scrub pending, at its own time, and never brings in a backup\'s marker (the code review S1)', () => {
		const backup = opening(generateBackupData());
		backup.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('secrets_scrub_pending', 'THE-BACKUP-MARKER');
		sqlite.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('secrets_scrub_pending', '2026-01-01T00:00:00.000Z');

		restoreFromBackup(sqlite, backup);

		const marker = settingsStored(sqlite)['secrets_scrub_pending'];
		expect(marker).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(marker).not.toBe('THE-BACKUP-MARKER');
		// A working copy too.
		sqlite.prepare("DELETE FROM settings WHERE key = 'secrets_scrub_pending'").run();
		restoreFromBackup(sqlite, opening(generateBackupData()), { outside: 'off' });
		expect(settingsStored(sqlite)['secrets_scrub_pending']).toMatch(/^\d{4}-\d\d-\d\dT/);
	});

	it('31: no value in any table of the copy a backup makes is sealed, though the live file holds them sealed', () => {
		armSecrets(sqlite);
		sealPlainSecrets(sqlite);
		backupSealKey(sqlite);
		expect(JSON.stringify(settingsStored(sqlite))).toContain('dfsealed:1:');

		const bytes = generateBackupData();

		expect(bytes.includes(Buffer.from('dfsealed:'))).toBe(false);
	});

	it('31b: a service account JSON whose key is a camelCase privateKey, sealed in the live file, goes into no copy, sealed or plain (card 2938)', () => {
		const camel = 'camel-service-account-key-2938-e';
		armSecrets(sqlite);
		const camelRobot = {
			...ROBOT,
			name: 'Camel',
			serviceAccountJson: JSON.stringify({ type: 'service_account', client_email: 'camel@project.iam.example.test', private_key_id: 'key-id-2', privateKey: camel })
		};
		sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(configWith([...DESTINATIONS, camelRobot]));
		sealPlainSecrets(sqlite);
		const named = (text: string) => (JSON.parse(text).destinations as { name: string; serviceAccountJson: string }[]).find((d) => d.name === 'Camel')!;
		expect(isSealed(JSON.parse(named(settingsStored(sqlite)['backup_config']).serviceAccountJson).privateKey)).toBe(true);

		const bytes = generateBackupData();

		expect(bytes.includes(Buffer.from('dfsealed:'))).toBe(false);
		expect(bytes.includes(Buffer.from(camel))).toBe(false);
		expect(JSON.parse(named(settingsStored(opening(bytes))['backup_config']).serviceAccountJson)).toEqual({ type: 'service_account', client_email: 'camel@project.iam.example.test', private_key_id: 'key-id-2', privateKey: '' });
	});

	it("32: a restore of this server's own sealed backup keeps the mail password, a destination's secret and a webhook's secret, each sealed and opening", () => {
		startedSinceAlreadyOffHeld();
		const hooks = armSecrets(sqlite);
		sealPlainSecrets(sqlite);
		const backup = opening(generateBackupData());

		const result = restoreFromBackup(sqlite, backup);

		expect(result.sealVerified).toBe(true);
		expect(result.secrets.kept).toMatchObject({ mailPassword: true, webhooks: expect.arrayContaining([hooks.off]) });
		const stored = settingsStored(sqlite);
		expect(isSealed(stored['smtp_pass'])).toBe(true);
		expect(readOpened('settings', 'smtp_pass')).toBe(SECRETS.mailPassword);
		expect(isSealed(storedConfig().destinations[1].secretAccessKey)).toBe(true);
		expect(JSON.parse(readOpened('settings', 'backup_config')!).destinations[1].secretAccessKey).toBe(SECRETS.s3Secret);
		expect(isSealed(secretOf(sqlite, hooks.off).secret)).toBe(true);
		expect(readOpened('webhooks', hooks.off)).toBe(SECRETS.webhookOff);
	});

	it('33: a restore of a backup holding its secrets in plain leaves only sealed values in the live file, its log emptied', () => {
		const hooks = armSecrets(sqlite);
		// As an older build made it: the running database, secrets and all, in plain.
		const backup = opening(Buffer.from(sqlite.serialize()));
		const folder = mkdtempSync(join(tmpdir(), 'dumpfire-sealed-restore-'));
		tempDirs.push(folder);
		const path = join(folder, 'live.db');
		writeFileSync(path, migratedDb().serialize());
		const live = new Database(path);
		opened.push(live);
		live.pragma('journal_mode = WAL');

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		const stored = settingsStored(live);
		expect(isSealed(stored['smtp_pass'])).toBe(true);
		expect(readOpened('settings', 'smtp_pass', live)).toBe(SECRETS.mailPassword);
		expect(isSealed(JSON.parse(stored['backup_config']).destinations[0].password)).toBe(true);
		expect(isSealed(secretOf(live, hooks.on).secret)).toBe(true);
		expect(readOpened('webhooks', hooks.on, live)).toBe(SECRETS.webhookOn);
		expect(readFileSync(`${path}-wal`).length).toBe(0);
		const bytes = readFileSync(path);
		for (const [name, value] of Object.entries(SECRETS)) expect(bytes.includes(Buffer.from(value)), name).toBe(false);
	});

	it('33b: with no MFA key loaded, a restore of a backup holding its secrets in plain throws, and nothing is changed', () => {
		armSecrets(sqlite);
		const backup = opening(Buffer.from(sqlite.serialize()));
		const live = migratedDb();
		const before = JSON.stringify([live.prepare('SELECT * FROM settings').all(), live.prepare('SELECT * FROM users').all()]);
		keyStub.none = true;

		expect(() => restoreFromBackup(live, backup)).toThrow(/No MFA key is loaded, so the secrets this backup holds in plain cannot be sealed/);

		keyStub.none = false;
		expect(JSON.stringify([live.prepare('SELECT * FROM settings').all(), live.prepare('SELECT * FROM users').all()])).toBe(before);
	});

	it('34: a secret here that does not open is absent to the restore: the webhook is left with none, off and listed, and secretsToEnter lists it', () => {
		startedSinceAlreadyOffHeld();
		const hooks = armSecrets(sqlite);
		const backup = opening(generateBackupData());
		// Here, its secret sealed under another key since: it does not open.
		sqlite
			.prepare('UPDATE webhooks SET secret = ? WHERE id = ?')
			.run(sealValue(SECRETS.webhookOff, webhookSecretAad(hooks.off, hooks.boardId, 'https://hooks.example.test/off'), otherKey()), hooks.off);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.sealVerified).toBe(true);
		expect(result.secrets.kept.webhooks).not.toContain(hooks.off);
		expect(secretOf(sqlite, hooks.off)).toEqual({ secret: '', active: 0 });
		expect(result.secrets.toEnter.webhooks.map((hook) => hook.id)).toContain(hooks.off);
		expect(secretsToEnter(sqlite).toEnter.webhooks.map((hook) => hook.id)).toContain(hooks.off);
	});

	it('35: the backup seal key is stored sealed; a backup sealed here verifies before a restore and after it, and the row kept is the envelope as it was', () => {
		const backup = opening(generateBackupData());
		const stored = settingsStored(sqlite)[BACKUP_SEAL_KEY];
		expect(isSealed(stored)).toBe(true);
		expect(unsealedBecause(backup, sealKeyHere(sqlite)!.key)).toBeNull();

		expect(restoreFromBackup(sqlite, opening(generateBackupData())).sealVerified).toBe(true);

		expect(settingsStored(sqlite)[BACKUP_SEAL_KEY]).toBe(stored);
		expect(unsealedBecause(backup, sealKeyHere(sqlite)!.key)).toBeNull();
	});
});

// ─── Card 2943: the backup seal key's form and its record ───────────────────

describe("the backup seal key's form and its record (card 2943)", () => {
	const CURRENT_FORM = /^v2:[0-9a-f]{64}$/;
	const AN_ISO_TIME = /^\d{4}-\d\d-\d\dT/;
	const EARLIER = '2020-01-01T00:00:00.000Z';
	const otherKey = () => keyFromBytes(randomBytes(32));
	const storedKey = () => settingsStored(sqlite)[BACKUP_SEAL_KEY];
	const record = () => settingsStored(sqlite)[BACKUP_SEAL_KEY_MADE_AT];
	const put = (database: Database.Database, key: string, value: string) =>
		database.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
	/** The key as card 2898's release left it: sealed in place as plain hex, with no record. */
	const asCard2898LeftIt = (hex: string) => {
		put(sqlite, BACKUP_SEAL_KEY, sealValue(hex, settingAad(BACKUP_SEAL_KEY), currentMfaKey()!));
		sqlite.prepare('DELETE FROM settings WHERE key = ?').run(BACKUP_SEAL_KEY_MADE_AT);
	};
	/** A start, its lines kept off the console. */
	const start = () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		sealStoredSecretsAtStart(sqlite, () => {});
	};
	/** The BACKUP CRITICAL key-change records written while `fn` runs (the fix pass's C4), each at its level. */
	const notTrusted = (fn: () => void): string[] => {
		const from = (sqlite.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM system_logs').get() as { n: number }).n;
		vi.spyOn(console, 'error').mockImplementation(() => {});
		fn();
		return column<string>(sqlite, `SELECT level || ' ' || message FROM system_logs WHERE id > ${from} AND context = 'BACKUP' AND message LIKE 'Key change recorded%'`);
	};

	it.each([
		{ row: 'none stored: one is made, with its record, and nothing is said', stored: 'none' },
		{ row: 'one that does not open: replaced, with a new record and one CRITICAL key-change record (F3, C4)', stored: 'unopenable' }
	])('4: backupSealKey writes the current form and its record: $row (R4)', ({ stored }) => {
		sqlite.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(BACKUP_SEAL_KEY, BACKUP_SEAL_KEY_MADE_AT);
		if (stored === 'unopenable') {
			put(sqlite, BACKUP_SEAL_KEY, sealValue(`v2:${'ab'.repeat(32)}`, settingAad(BACKUP_SEAL_KEY), otherKey()));
			put(sqlite, BACKUP_SEAL_KEY_MADE_AT, EARLIER);
		}

		const said = notTrusted(() => backupSealKey(sqlite));

		expect(readOpened('settings', BACKUP_SEAL_KEY, sqlite)).toMatch(CURRENT_FORM);
		expect(record()).toMatch(AN_ISO_TIME);
		expect(record()).not.toBe(EARLIER);
		expect(said).toEqual(stored === 'none' ? [] : [`CRITICAL ${SEAL_KEY_NOT_TRUSTED}`]);
		// A second call uses the key as it is, and writes nothing.
		const now = [storedKey(), record()];
		expect(notTrusted(() => backupSealKey(sqlite))).toEqual([]);
		expect([storedKey(), record()]).toEqual(now);
	});

	it("4b: a seal key written in plain while the server runs is no key: nothing is checked with it, a restore keeps neither it nor its record, and the next backup replaces it with one CRITICAL key-change record (R2, R3, C4)", () => {
		const backup = opening(generateBackupData());
		const hex = sealKeyHere(sqlite)!.key;
		// The same key's bytes, written in plain, as a row written by hand would be, with a record beside it.
		put(sqlite, BACKUP_SEAL_KEY, hex);
		put(sqlite, BACKUP_SEAL_KEY_MADE_AT, EARLIER);
		expect(sealKeyHere(sqlite)).toBeNull();

		const result = restoreFromBackup(sqlite, backup);

		expect(result.sealVerified).toBe(false);
		expect(result.unsealed).toEqual({ seal: 'none', check: null });
		expect(storedKey()).toBeUndefined();
		expect(record()).toBeUndefined();

		put(sqlite, BACKUP_SEAL_KEY, hex);
		const said = notTrusted(() => backupSealKey(sqlite));
		expect(said).toEqual([`CRITICAL ${SEAL_KEY_NOT_TRUSTED}`]);
		expect(SEAL_KEY_NOT_TRUSTED).toContain('the backup seal key (the one stored was not trusted at run time');
		expect(SEAL_KEY_NOT_TRUSTED).not.toContain(hex);
		expect(readOpened('settings', BACKUP_SEAL_KEY, sqlite)).toMatch(CURRENT_FORM);
		expect(sealKeyHere(sqlite)!.key).not.toBe(hex);
	});

	it("5: a backup sealed under a key of the older form, which a start then makes anew, is another server's: nothing filled, the new key and its record kept, and a start after the restore makes nothing (card test 1)", () => {
		const old = 'cd'.repeat(32);
		const backup = opening(generateBackupData());
		sealCopy(backup, Buffer.from(old, 'hex'));
		asCard2898LeftIt(old);
		expect(sealVerifies(backup, old)).toBe(true);

		start();
		const made = sealKeyHere(sqlite)!;
		const madeAt = record();
		expect(made.key).not.toBe(old);
		expect(madeAt).toMatch(AN_ISO_TIME);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.sealVerified).toBe(false);
		expect(result.unsealed).toEqual({ seal: 'failed', check: null });
		expect(result.secrets.kept).toEqual(NOTHING_KEPT);
		expect(storedKey()).toBe(made.stored);
		expect(record()).toBe(madeAt);
		start();
		expect(storedKey()).toBe(made.stored);
		expect(record()).toBe(madeAt);
	});

	it('5b: after the start makes the key anew, a backup this server makes verifies and fills (R7(b))', () => {
		startedSinceAlreadyOffHeld();
		armSecrets(sqlite);
		asCard2898LeftIt('cd'.repeat(32));
		start();

		const result = restoreFromBackup(sqlite, opening(generateBackupData()));

		expect(result.sealVerified).toBe(true);
		expect(result.secrets.kept.mailPassword).toBe(true);
	});

	it("6: a whole database copy holding an older key in plain and a record of its own, with no seal: neither is brought in, this server's key and record are kept, and nothing is filled", () => {
		backupSealKey(sqlite);
		const here = sealKeyHere(sqlite)!;
		const madeAt = record();
		const copy = opening(Buffer.from(sqlite.serialize()));
		put(copy, BACKUP_SEAL_KEY, 'ef'.repeat(32));
		put(copy, BACKUP_SEAL_KEY_MADE_AT, EARLIER);

		const result = restoreFromBackup(sqlite, copy);

		expect(result.unsealed).toEqual({ seal: 'none', check: null });
		expect(result.secrets.kept).toEqual(NOTHING_KEPT);
		expect(storedKey()).toBe(here.stored);
		expect(record()).toBe(madeAt);
	});
});

// ─── Card 2928: a webhook's address, sealed at rest ─────────────────────────

describe("a webhook's address, sealed at rest (card 2928)", () => {
	const SLACK = 'https://hooks.slack.com/services/T000/B000/xyz-2928';
	const rowOf = (id: number) =>
		sqlite.prepare('SELECT active, held_because AS heldBecause, url, receiver FROM webhooks WHERE id = ?').get(id) as {
			active: number;
			heldBecause: string | null;
			url: string;
			receiver: string;
		};
	/** The same address sealed again: another envelope for the same text. */
	const resealed = (id: number) => {
		const row = sqlite.prepare('SELECT id, board_id AS boardId, url, receiver FROM webhooks WHERE id = ?').get(id) as { id: number; boardId: number; url: string; receiver: string };
		const again = sealValue(readOpenedUrl(id)!, webhookUrlAad(row.id, row.boardId, row.receiver), currentMfaKey()!);
		expect(again).not.toBe(row.url);
		sqlite.prepare('UPDATE webhooks SET url = ? WHERE id = ?').run(again, id);
	};

	it("12: a restore fills a webhook's secret from this server's own where the two addresses are the same text sealed twice", () => {
		startedSinceAlreadyOffHeld();
		const owner = makeUser();
		const hook = makeWebhook(makeBoard({ owner }).board, { url: SLACK, secret: 'whsec-2928-12' });
		sealPlainSecrets(sqlite);
		const backup = opening(generateBackupData());
		resealed(hook.id);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.sealVerified).toBe(true);
		expect(result.secrets.kept.webhooks).toEqual([hook.id]);
		expect(readOpened('webhooks', hook.id)).toBe('whsec-2928-12');
		expect(readOpenedUrl(hook.id)).toBe(SLACK);
	});

	it.each([
		{ row: 'the same address sealed twice', change: 'reseal' },
		{ row: 'an address here that does not open: carried on its id, board and setter (R17)', change: 'spoil' }
	])("13: this server's hold is carried onto the restored webhook: $row", ({ change }) => {
		const owner = makeUser();
		const hook = makeWebhook(makeBoard({ owner }).board, { url: SLACK });
		// The backup: on, its setter the board's owner.
		const backup = opening(Buffer.from(sqlite.serialize()));
		if (change === 'reseal') resealed(hook.id);
		else {
			const { url } = rowOf(hook.id);
			sqlite.prepare('UPDATE webhooks SET url = ? WHERE id = ?').run(url.slice(0, -3) + (url.slice(-3, -2) === 'A' ? 'B' : 'A') + url.slice(-2), hook.id);
		}
		sqlite.prepare("UPDATE webhooks SET active = 0, held_because = 'setter access ended', held_at = '2026-11-18 09:00:00' WHERE id = ?").run(hook.id);

		restoreFromBackup(sqlite, backup);

		expect(rowOf(hook.id)).toMatchObject({ active: 0, heldBecause: 'setter access ended' });
	});

	// Slice 2: a restore seals what a backup holds in plain.
	it.each([
		{ row: 'with no receiver, as a backup from before 0073 holds it', receiver: '' },
		{ row: 'with a stale receiver, which is never taken (R6)', receiver: 'https://stale.example.test' }
	])('34: a backup holding an address in plain $row: sealed as it is read, its receiver worked out from it, its plain secret bound to it', ({ receiver }) => {
		const owner = makeUser();
		const hook = makeWebhook(makeBoard({ owner }).board, { url: SLACK, secret: 'whsec-2928-34' });
		sqlite.prepare('UPDATE webhooks SET url = ?, receiver = ? WHERE id = ?').run(SLACK, receiver, hook.id);
		const backup = opening(Buffer.from(sqlite.serialize()));

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		const row = rowOf(hook.id);
		expect(row.url).toMatch(/^dfsealed:1:/);
		expect(row.receiver).toBe('https://hooks.slack.com');
		expect(readOpenedUrl(hook.id)).toBe(SLACK);
		expect(readOpened('webhooks', hook.id)).toBe('whsec-2928-34');
		expect((sqlite.prepare('SELECT url FROM webhooks').pluck().all() as string[]).filter((url) => url !== '' && !url.startsWith('dfsealed:1:'))).toEqual([]);
	});

	it('35: a restored webhook whose address does not open here, beside a plain secret: the secret left out, the webhook off and listed (R5, R6)', () => {
		// A server started since card 2923's release, so that the restore holds none of what is off (its own rule).
		startedSinceAlreadyOffHeld();
		const owner = makeUser();
		const hook = makeWebhook(makeBoard({ owner }).board, { url: SLACK, secret: 'whsec-2928-35' });
		sqlite.prepare('UPDATE webhooks SET url = ? WHERE id = ?').run(sealValue(SLACK, webhookUrlAad(hook.id, hook.boardId, hook.receiver), keyFromBytes(randomBytes(32))), hook.id);
		const backup = opening(Buffer.from(sqlite.serialize()));

		const result = restoreFromBackup(sqlite, backup);

		expect(rowOf(hook.id)).toMatchObject({ active: 0 });
		expect(sqlite.prepare('SELECT secret FROM webhooks WHERE id = ?').pluck().get(hook.id)).toBe('');
		expect(result.secrets.toEnter.webhooks.map((each) => each.id)).toEqual([hook.id]);
		expect(JSON.stringify(sqlite.serialize().toString('latin1'))).not.toContain('whsec-2928-35');
	});

	// ─── Slice 3: the backup blanks the address, and a restore fills it back ───

	const TEAMS = 'https://example.webhook.office.com/webhookb2/abc-2928/IncomingWebhook/def';
	const marker = (database: Database.Database) => JSON.parse(settingsStored(database)[WEBHOOK_ADDRESSES_LEFT_OUT_KEY] ?? 'null');
	/** Two webhooks on one board, their addresses and secrets sealed as the server stores them: one signed and on, one unsigned and on. */
	function twoHooks() {
		startedSinceAlreadyOffHeld();
		const owner = makeUser();
		const board = makeBoard({ owner }).board;
		const signed = makeWebhook(board, { url: SLACK, secret: 'whsec-2928-slice-3' });
		const unsigned = makeWebhook(board, { url: TEAMS });
		sealPlainSecrets(sqlite);
		return { owner, board, signed, unsigned };
	}

	it('37: a backup holds every address as empty, its receiver, the webhook off and listed with its match, and nothing of the address or its key', () => {
		const { signed, unsigned } = twoHooks();
		const key = settingsStored(sqlite)[WEBHOOK_ADDRESS_MAC_KEY];

		const bytes = generateBackupData();

		const backup = opening(bytes);
		expect(backup.prepare('SELECT id, url, receiver, active FROM webhooks ORDER BY id').all()).toEqual([
			{ id: signed.id, url: '', receiver: 'https://hooks.slack.com', active: 0 },
			{ id: unsigned.id, url: '', receiver: 'https://example.webhook.office.com', active: 0 }
		]);
		expect(marker(backup)).toEqual([
			{ id: signed.id, active: true, address: expect.stringMatching(/^[0-9a-f]{64}$/) },
			{ id: unsigned.id, active: true, address: expect.stringMatching(/^[0-9a-f]{64}$/) }
		]);
		// The key's sealed form, and the key itself as it opens, 64 hex (the code review, C11), in either case.
		const opened = readOpened('settings', WEBHOOK_ADDRESS_MAC_KEY, sqlite)!;
		expect(opened).toMatch(/^[0-9a-f]{64}$/);
		for (const text of ['dfsealed:', 'xyz-2928', 'abc-2928', WEBHOOK_ADDRESS_MAC_KEY, settingsStored(sqlite)[WEBHOOK_ADDRESS_MAC_KEY], opened, opened.toUpperCase()]) {
			expect(bytes.includes(Buffer.from(text)), text).toBe(false);
		}
		expect(bytes.includes(Buffer.from(opened, 'hex')), 'the key as bytes').toBe(false);
		// The key made by that backup, at first need, stored sealed (R14).
		expect(key).toBeUndefined();
		expect(isSealed(settingsStored(sqlite)[WEBHOOK_ADDRESS_MAC_KEY])).toBe(true);
	});

	it.each([
		{ row: 'one stored that does not open is replaced with the WARN the start writes for it', stored: 'spoiled', warned: true },
		{ row: 'none stored is made at first need, and nothing is said', stored: 'none', warned: false }
	])("37b: a backup's webhook address key: $row (the code review, C14)", ({ stored, warned }) => {
		twoHooks();
		const spoiled = sealValue('ab'.repeat(32), settingAad(WEBHOOK_ADDRESS_MAC_KEY), keyFromBytes(randomBytes(32)));
		if (stored === 'spoiled') sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(WEBHOOK_ADDRESS_MAC_KEY, spoiled);

		// At WARN, which the tests' ERROR level would not write.
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			generateBackupData();
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		const said = sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'BACKUP' AND message LIKE 'Replaced %'").all();
		expect(said).toEqual(warned ? [{ level: 'WARN', message: replacedSigningKeysLine(['the webhook address key']) }] : []);
		expect(readOpened('settings', WEBHOOK_ADDRESS_MAC_KEY, sqlite)).toMatch(/^[0-9a-f]{64}$/);
		expect(settingsStored(sqlite)[WEBHOOK_ADDRESS_MAC_KEY]).not.toBe(spoiled);
		// The line names the key, never a value.
		expect(JSON.stringify(said)).not.toContain('abab');
	});

	it.each([
		{ row: 'an address that does not open in the copy is listed with no match', setup: 'spoil' },
		{ row: 'the live marker’s entry for a webhook still without an address is carried (R8)', setup: 'carry' }
	])('38: $row', ({ setup }) => {
		const { signed, unsigned } = twoHooks();
		if (setup === 'spoil') {
			const { url } = rowOf(signed.id);
			sqlite.prepare('UPDATE webhooks SET url = ? WHERE id = ?').run(url.slice(0, -3) + (url.slice(-3, -2) === 'A' ? 'B' : 'A') + url.slice(-2), signed.id);
		} else {
			sqlite.prepare("UPDATE webhooks SET url = '', active = 0 WHERE id = ?").run(signed.id);
			sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(WEBHOOK_ADDRESSES_LEFT_OUT_KEY, JSON.stringify([{ id: signed.id, active: true, address: 'a'.repeat(64) }]));
		}

		const backup = opening(generateBackupData());

		const entries = marker(backup) as { id: number; active: boolean; address?: string }[];
		expect(entries.map((entry) => entry.id)).toEqual([signed.id, unsigned.id]);
		if (setup === 'spoil') expect(entries[0]).toEqual({ id: signed.id, active: true });
		else expect(entries[0]).toEqual({ id: signed.id, active: true, address: 'a'.repeat(64) });
	});

	it("39: a restore of this server's own backup fills each address back byte for byte, and the secret, switched on as it was", () => {
		const { signed, unsigned } = twoHooks();
		const before = [rowOf(signed.id).url, rowOf(unsigned.id).url];

		const result = restoreFromBackup(sqlite, opening(generateBackupData()));

		expect(result.sealVerified).toBe(true);
		expect(result.secrets.kept.webhookAddresses).toEqual([signed.id, unsigned.id]);
		expect(result.secrets.toEnter.webhookAddresses).toBeUndefined();
		expect([rowOf(signed.id).url, rowOf(unsigned.id).url]).toEqual(before);
		expect(readOpened('webhooks', signed.id)).toBe('whsec-2928-slice-3');
		expect([rowOf(signed.id).active, rowOf(unsigned.id).active]).toEqual([1, 1]);
		expect(marker(sqlite)).toBeNull();
	});

	it('40: an address changed here since the backup is not filled: empty, off, and listed to enter', () => {
		const { signed } = twoHooks();
		const backup = opening(generateBackupData());
		const changed = sealValue('https://hooks.slack.com/services/T000/B000/another', webhookUrlAad(signed.id, signed.boardId, 'https://hooks.slack.com'), currentMfaKey()!);
		sqlite.prepare('UPDATE webhooks SET url = ? WHERE id = ?').run(changed, signed.id);

		const result = restoreFromBackup(sqlite, backup);

		expect(rowOf(signed.id)).toMatchObject({ url: '', active: 0 });
		expect(result.secrets.toEnter.webhookAddresses?.map((each) => each.id)).toEqual([signed.id]);
		expect(marker(sqlite)).toEqual([{ id: signed.id, active: true, address: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
	});

	it.each([
		{ row: 'filled and switched on', held: false },
		{ row: 'held here: filled, and off with its hold (R19)', held: true }
	])("41: an unsigned webhook's address is $row", ({ held }) => {
		const { unsigned } = twoHooks();
		const backup = opening(generateBackupData());
		if (held) sqlite.prepare("UPDATE webhooks SET active = 0, held_because = 'setter access ended', held_at = '2026-11-18 09:00:00' WHERE id = ?").run(unsigned.id);

		restoreFromBackup(sqlite, backup);

		expect(readOpenedUrl(unsigned.id)).toBe(TEAMS);
		expect(rowOf(unsigned.id)).toMatchObject(held ? { active: 0, heldBecause: 'setter access ended' } : { active: 1, heldBecause: null });
	});

	it.each([
		{ row: 'a backup whose seal does not verify', change: 'seal' },
		{ row: "this server's webhook address key lost (R14)", change: 'key' }
	])('42: nothing is filled for $row, every address listed to enter', ({ change }) => {
		const { signed, unsigned } = twoHooks();
		const backup = opening(generateBackupData());
		if (change === 'seal') backup.prepare("UPDATE boards SET name = 'changed' WHERE id = ?").run(signed.boardId);
		else sqlite.prepare('DELETE FROM settings WHERE key = ?').run(WEBHOOK_ADDRESS_MAC_KEY);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.secrets.kept.webhookAddresses).toBeUndefined();
		expect(result.secrets.toEnter.webhookAddresses?.map((each) => each.id)).toEqual([signed.id, unsigned.id]);
		expect([rowOf(signed.id), rowOf(unsigned.id)].map((row) => [row.url, row.active])).toEqual([
			['', 0],
			['', 0]
		]);
	});

	it('43: a working copy fills nothing where nothing is here, keeps everything off, and counts each listed as on once, from either list', () => {
		const { signed, unsigned } = twoHooks();
		const backup = opening(generateBackupData());

		const result = restoreFromBackup(migratedDb(), backup, { outside: 'off' });

		// The signed one listed in both lists, the unsigned in the addresses' alone: two, each once.
		expect(result.outside?.webhooks).toBe(2);
		expect(result.secrets.toEnter.webhookAddresses?.map((each) => each.id)).toEqual([signed.id, unsigned.id]);
		// Here, where both are, the addresses are filled and both stay off.
		const here = restoreFromBackup(sqlite, opening(generateBackupData()), { outside: 'off' });
		expect(here.secrets.kept.webhookAddresses).toEqual([signed.id, unsigned.id]);
		expect([rowOf(signed.id).active, rowOf(unsigned.id).active]).toEqual([0, 0]);
		expect(readOpenedUrl(unsigned.id)).toBe(TEAMS);
	});

	it('44: the start line names each webhook whose address is to enter, held or not', () => {
		const { signed, unsigned } = twoHooks();
		const backup = opening(generateBackupData());
		const live = migratedDb();
		restoreFromBackup(live, backup);
		live.prepare("UPDATE webhooks SET held_because = 'setter access ended', held_at = '2026-11-18 09:00:00' WHERE id = ?").run(unsigned.id);

		const { toEnter } = secretsToEnter(live);

		expect(toEnter.webhookAddresses?.map((each) => each.id)).toEqual([signed.id, unsigned.id]);
		const said = secretsToEnterSentence(toEnter, true)!;
		expect(said).toMatch(new RegExp(`the address\\(es\\) of webhook\\(s\\) ${signed.id} \\(board "[^"]+"\\), which stay switched off`));
		expect(said).toContain('sends each one its url (and its secret) with active true in PUT /api/v1/webhooks/{id}, or deletes it if it is no longer wanted');
		// The held one is told one thing (card 2928's code review, C1): its url with active true, and no secret.
		expect(said).toMatch(
			new RegExp(
				`the address\\(es\\) of webhook\\(s\\) ${unsigned.id} \\(board "[^"]+"\\), switched off for good: to keep one, the board's owner or an ` +
					'administrator switches it on with its url and active true, and no secret, in PUT /api/v1/webhooks/\\{id\\} \\(it is given a new secret, ' +
					'returned once in that answer\\), or deletes it if it is no longer wanted'
			)
		);
		expect(said.match(new RegExp(`webhook\\(s\\)[^;]*\\b${unsigned.id} \\(board`, 'g'))).toHaveLength(1);
	});

	it("45: the webhook address key is made once, sealed, and kept as it was across a restore", () => {
		twoHooks();
		const made = webhookAddressMacKey(sqlite);
		const stored = settingsStored(sqlite)[WEBHOOK_ADDRESS_MAC_KEY];
		expect(isSealed(stored)).toBe(true);
		expect(webhookAddressMacKey(sqlite).equals(made)).toBe(true);

		restoreFromBackup(sqlite, opening(generateBackupData()));

		expect(settingsStored(sqlite)[WEBHOOK_ADDRESS_MAC_KEY]).toBe(stored);
	});
});

// ─── Card 2935 (P12): the restore runs the start pass itself ─────────────────

describe("the restore's own run of the readable pass (card 2935, P12)", () => {
	const FLAG = 'webhooks_readable_by_disabled_held';
	const rowOf = (id: number) => sqlite.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(id);
	const flagOf = () => sqlite.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(FLAG) as string | undefined;
	let hook: number;
	let gone: SessionUser;

	beforeEach(() => {
		resetDb();
		makeUser({ username: 'chief', role: 'superadmin' });
		const olga = makeUser({ username: 'olga' });
		const eve = makeUser({ username: 'eve' });
		gone = makeUser({ username: 'gone', role: 'admin' });
		const board = makeBoard({ owner: olga }).board;
		// Its setter can open the board, so that no sweep of card 2752 holds it.
		addBoardMember(board, eve, 'editor');
		hook = makeWebhook(board, { setBy: eve, secret: 's3cret' }).id;
		// An administrator of the backup disabled after the webhook was made.
		sqlite.prepare("UPDATE users SET disabled_at = '2099-01-02 09:00:00' WHERE id = ?").run(gone.id);
	});

	it('a backup with no moment: the webhook its disabled administrator could read is held, before any secret is filled, and the moment written', () => {
		const backup = opening(Buffer.from(sqlite.serialize()));

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(rowOf(hook)).toEqual({ active: 0, heldBecause: 'setter access ended' });
		expect(flagOf()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	// Card 2935's code review (C3): always run, from the backup's own moment, whatever this server's says.
	it.each([
		{ row: 'a moment before its disable, this server’s later: run from it', backupMoment: '2099-01-01 00:00:00', here: '2099-06-01 00:00:00', held: true },
		{ row: 'a moment before its disable, this server with none: run from it', backupMoment: '2099-01-01 00:00:00', here: null, held: true },
		{ row: 'a moment after its disable: nothing to hold', backupMoment: '2099-06-01 00:00:00', here: '2099-06-01 00:00:00', held: false }
	])('a backup with $row', ({ backupMoment, here, held }) => {
		sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(FLAG, backupMoment);
		const backup = opening(Buffer.from(sqlite.serialize()));
		if (here === null) sqlite.prepare('DELETE FROM settings WHERE key = ?').run(FLAG);
		else sqlite.prepare('UPDATE settings SET value = ? WHERE key = ?').run(here, FLAG);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(rowOf(hook)).toEqual(held ? { active: 0, heldBecause: 'setter access ended' } : { active: 1, heldBecause: null });
	});
});

describe('a restore never fails open on which key was given which secret (card 2947, R1, R2)', () => {
	const HELD = { active: 0, heldBecause: 'setter access ended' };
	const ON = { active: 1, heldBecause: null };
	const rowOf = (id: number) => sqlite.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(id);
	const reveals = () =>
		(sqlite.prepare('SELECT webhook_id AS w, key_id AS k FROM webhook_reveals ORDER BY webhook_id, key_id').all() as { w: number; k: number }[]).map((row) => [row.w, row.k]);
	const reveal = (hookId: number, keyId: number) =>
		sqlite.prepare('INSERT INTO webhook_reveals (webhook_id, key_id, revealed_at) VALUES (?, ?, ?)').run(hookId, keyId, '2026-11-19 09:00:00');
	let owner: SessionUser;
	let hook: number;

	beforeEach(() => {
		resetDb();
		startedSinceAlreadyOffHeld();
		makeUser({ username: 'chief', role: 'superadmin' });
		owner = makeUser({ username: 'olga' });
		const eve = makeUser({ username: 'eve' });
		const board = makeBoard({ owner }).board;
		addBoardMember(board, eve, 'editor');
		hook = makeWebhook(board, { setBy: eve, secret: 'whsec-2947' }).id;
		sealPlainSecrets(sqlite);
	});

	it('R1a: the backup made before the read: this server’s row carried where the same key came back, and the webhook stays on', () => {
		const k = makeApiKeyRow(owner);
		const backup = opening(generateBackupData());
		reveal(hook, k.id);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.secrets.kept.webhooks).toEqual([hook]);
		expect(reveals()).toEqual([[hook, k.id]]);
		expect(rowOf(hook)).toEqual(ON);
	});

	it.each([
		{ row: 'a key made after the backup, which the restore does not bring back', change: 'later' },
		{ row: 'the same id with another hash: another key', change: 'hash' }
	])('R1b: a row of $row: the webhook whose secret was filled from here is held, inside the restore', ({ change }) => {
		const early = change === 'hash' ? makeApiKeyRow(owner) : null;
		const backup = opening(generateBackupData());
		const k = early ?? makeApiKeyRow(owner);
		if (change === 'hash') sqlite.prepare("UPDATE api_keys SET key_hash = 'another-hash' WHERE id = ?").run(k.id);
		reveal(hook, k.id);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.secrets.kept.webhooks).toEqual([hook]);
		expect(rowOf(hook)).toEqual(HELD);
		expect(reveals()).toEqual([]);
	});

	it('R1c: a key of the backup that has ended, with its row: what it was given held inside the restore, not at the next sweep', () => {
		const k = makeApiKeyRow(owner, { expiresAt: '2026-01-01 00:00:00' });
		reveal(hook, k.id);
		const backup = opening(generateBackupData());

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(rowOf(hook)).toEqual(HELD);
		expect(reveals()).toEqual([]);
	});

	it('R1d: a working copy holds what a lost key was given too, before switching every webhook off, telling nobody (FP1)', () => {
		const backup = opening(generateBackupData());
		const k = makeApiKeyRow(owner);
		reveal(hook, k.id);

		const result = restoreFromBackup(sqlite, backup, { outside: 'off' });

		expect(result.errors).toEqual([]);
		// Held, a reason whose switch-on gives a new secret, not merely switched off.
		expect(rowOf(hook)).toEqual(HELD);
		expect(NEW_SECRET_REASONS).toContain('setter access ended');
		expect(reveals()).toEqual([]);
	});

	it('FP6: a backup that still carries its secrets (a whole database copy): a key it did not bring back holds the webhook; one it did is carried', () => {
		const kept = makeApiKeyRow(owner);
		// The backup holds the secret itself, as a serialized database does, and the kept key.
		const backup = opening(Buffer.from(sqlite.serialize()));
		const later = makeApiKeyRow(owner);
		reveal(hook, later.id);
		reveal(hook, kept.id);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.secrets.kept.webhooks).toEqual([]);
		expect(rowOf(hook)).toEqual(HELD);
		expect(reveals()).toEqual([[hook, kept.id]]);
	});

	it('R2: an account disabled here since the backup: its restored keys’ rows deleted with them, and what they were given held; no row left naming a key that is gone', () => {
		const eveKey = makeApiKeyRow(makeUser({ username: 'kim' }));
		reveal(hook, eveKey.id);
		const backup = opening(generateBackupData());
		const kim = sqlite.prepare("SELECT id FROM users WHERE username = 'kim'").pluck().get() as number;
		const chief = sqlite.prepare("SELECT id, username, role FROM users WHERE username = 'chief'").get() as SessionUser;
		inTransaction(() => disableAccount(db.select().from(users).all().find((u) => u.id === kim)!, chief));

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?').get(kim)).toEqual({ n: 0 });
		expect(reveals()).toEqual([]);
		expect(rowOf(hook)).toEqual(HELD);
	});

	it('R7: a backup without the seed’s flag is seeded inside the restore, after the secrets are filled, and the flag written', () => {
		const k = makeApiKeyRow(owner);
		sqlite.prepare("UPDATE webhooks SET created_at = '2026-10-01 09:00:00' WHERE id = ?").run(hook);
		sqlite.prepare("UPDATE api_keys SET last_used_at = '2026-11-01 09:00:00' WHERE id = ?").run(k.id);
		const backup = opening(generateBackupData());

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(sqlite.prepare('SELECT webhook_id AS w, key_id AS k, revealed_at AS at FROM webhook_reveals').all()).toEqual([{ w: hook, k: k.id, at: null }]);
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'webhook_reveals_seeded'").get()).toEqual({ n: 1 });
		expect(rowOf(hook)).toEqual(ON);
	});
});

describe('a OneDrive destination says whose OneDrive, and its folder path is one OneDrive takes (card 2941)', () => {
	const store = (destinations: unknown[]) =>
		sqlite.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('backup_config', configWith(destinations));
	const storedDestinations = () => JSON.parse(settingsOf(sqlite)['backup_config']).destinations as Record<string, unknown>[];
	const shown = async () => (await api('GET', '/api/admin/backup', { user: chief })).body.destinations as Record<string, unknown>[];
	const put = (destinations: unknown[]) => api('PUT', '/api/admin/backup', confirmedByChief({ destinations }));
	/** A OneDrive destination as saved before card 2941: no drive. */
	const { drive: _drive, ...LEGACY } = ONEDRIVE;

	it.each([
		{ sent: 'alice@contoso.example', saved: 'alice@contoso.example' },
		{ sent: '  3F2504E0-4F89-11D3-9A0C-0305E82C3301 ', saved: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' },
		{ sent: 'b!AbC_123-x', saved: 'b!AbC_123-x' },
		{ sent: 'alice', saved: null },
		{ sent: 'a/b@x.example', saved: null },
		{ sent: 'd!AbC_123-x', saved: null }
	])('T19: a drive of $sent is saved as $saved (null: refused 400)', async ({ sent, saved }) => {
		const res = await put([{ ...ONEDRIVE, name: 'New', drive: sent }]);

		if (saved === null) {
			expect({ status: res.status, message: res.body.message }).toEqual({ status: 400, message: `destinations[0].drive ${DRIVE_REFUSAL}` });
		} else {
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(storedDestinations()[0].drive).toBe(saved);
		}
	});

	it.each(['a/../b', 'Backups\u0001', 'https://x'])('T20: a folder path of %j is refused 400, and nothing is saved', async (folderPath) => {
		const before = snapshotDb();

		const res = await put([{ ...ONEDRIVE, name: 'New', folderPath }]);

		expect({ status: res.status, message: res.body.message }).toEqual({ status: 400, message: `destinations[0].folderPath ${FOLDER_PATH_REFUSAL}` });
		expectUnchanged(before);
	});

	it('T21: a new one with no drive is refused; one stored without, sent back as shown, saves; the same pointed elsewhere is refused', async () => {
		const fresh = await put([{ ...LEGACY, name: 'New' }]);
		expect({ status: fresh.status, message: fresh.body.message }).toEqual({ status: 400, message: `destinations[0].drive ${ONEDRIVE_DRIVE_REQUIRED}` });

		store([LEGACY]);
		const page = await shown();
		const unchanged = await put(page);
		expect(unchanged.status, JSON.stringify(unchanged.body)).toBe(200);
		expect(storedDestinations()).toEqual([LEGACY]);

		const moved = await put([{ ...page[0], clientSecret: 'typed-again-2941', folderPath: '/Elsewhere' }]);
		expect({ status: moved.status, message: moved.body.message }).toEqual({ status: 400, message: `destinations[0].drive ${ONEDRIVE_DRIVE_REQUIRED}` });
		expect(storedDestinations()).toEqual([LEGACY]);
	});

	it('C5: a drive a restore stored as an upper-case object ID, sent back as shown, is kept byte for byte', async () => {
		const upper = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
		store([{ ...ONEDRIVE, drive: upper }]);

		const res = await put(await shown());

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(storedDestinations()[0].drive).toBe(upper);
	});

	it('T22: another drive with the client secret masked is refused, saved and tested alike', async () => {
		store([ONEDRIVE]);
		const page = await shown();
		const elsewhere = { ...page[0], drive: 'someone-else@example.test' };

		const saved = await put([elsewhere]);
		const tested = await api('POST', '/api/admin/backup/test', { user: chief, body: elsewhere });

		expect({ status: saved.status, message: saved.body.message }).toEqual({
			status: 400,
			message:
				'Backup destination "OneDrive": type its client secret again. A saved secret is used only with the settings it was saved with, and this changes its user or drive ID.'
		});
		expect(tested.status).toBe(400);
		expect(handed).toEqual([]);
		expect(storedDestinations()).toEqual([ONEDRIVE]);
	});

	it('T23: a run does not try one with no drive: its row says why, and nothing is made for it', async () => {
		store([LEGACY]);
		handed.length = 0;

		const results = await runBackup();

		expect(results).toEqual([expect.objectContaining({ destination: 'OneDrive', status: 'failed', message: ONEDRIVE_DRIVE_NOT_SET })]);
		expect(handed).toEqual([]);
		expect(sqlite.prepare('SELECT status, error FROM backup_log').all()).toEqual([{ status: 'failed', error: ONEDRIVE_DRIVE_NOT_SET }]);
	});
});

// ─── Card 2995: a restore never brings back an API key ended here ──────────

describe('a restore never brings back an API key ended on this server (card 2995)', () => {
	const HELD = { active: 0, heldBecause: 'setter access ended' };
	const KEY_ENDED = { active: 0, heldBecause: 'key ended' };
	const rowOf = (id: number) => sqlite.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(id);
	/** A row of the record, by hand: slice 2 has no writer (R11). */
	const record = (id: number | string, hash: string, because = 'revoked', database: Database.Database = sqlite) =>
		database
			.prepare("INSERT INTO api_key_revocations (key_id, key_hash, revoked_at, revoked_because) VALUES (?, ?, '2026-11-19 09:00:00', ?)")
			.run(id, hash, because);
	const watermark = (w: number) => record(w, 'watermark', 'before record');
	const recordOf = () =>
		sqlite.prepare('SELECT key_id AS id, key_hash AS hash, revoked_because AS because FROM api_key_revocations ORDER BY key_hash, key_id').all() as {
			id: number;
			hash: string;
			because: string;
		}[];
	const hashOf = (id: number) => sqlite.prepare('SELECT key_hash FROM api_keys WHERE id = ?').pluck().get(id) as string;
	const keyIds = () => sqlite.prepare('SELECT id FROM api_keys ORDER BY id').pluck().all() as number[];
	/** A key revoked here, as slice 2 stands in for the revoke: its row deleted and its hash recorded. */
	const revokedHere = (id: number) => {
		const hash = hashOf(id);
		sqlite.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
		record(id, hash);
	};
	/** A key of `user` at the row id `id`, as the generator makes one. */
	const keyAt = (id: number, user: SessionUser) => {
		const made = generateApiKey();
		sqlite.prepare('INSERT INTO api_keys (id, key_hash, key_prefix, name, user_id) VALUES (?, ?, ?, ?, ?)').run(id, made.keyHash, made.keyPrefix, `Key ${id}`, user.id);
		return { id, key: made.plaintextKey, hash: made.keyHash };
	};
	const v1 = async (key: string) => (await gate('GET', '/api/v1/me', { headers: { authorization: `Bearer ${key}` } })).status;
	const reveals = () =>
		(sqlite.prepare('SELECT webhook_id AS w, key_id AS k FROM webhook_reveals ORDER BY webhook_id, key_id').all() as { w: number; k: number }[]).map((row) => [row.w, row.k]);
	const reveal = (hookId: number, keyId: number) =>
		sqlite.prepare("INSERT INTO webhook_reveals (webhook_id, key_id, revealed_at) VALUES (?, ?, '2026-11-19 09:00:00')").run(hookId, keyId);
	const warnLines = () => sqlite.prepare("SELECT message FROM system_logs WHERE context = 'Webhooks' AND level = 'WARN' ORDER BY id").pluck().all() as string[];
	/** `run` with WARN lines kept, which the tests' LOG_LEVEL drops. */
	const withWarnings = <T>(run: () => T): T => {
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		try {
			return run();
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
	};
	const counter = () => sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'api_keys'").pluck().get() as number | undefined;
	const NOTHING_LEFT_OUT = { count: 0, keyIds: [], workingCopy: 0, unsealed: 0 };
	let owner: SessionUser;
	let eve: SessionUser;
	let board: Board;

	beforeEach(() => {
		resetDb();
		resetAllRateLimits();
		startedSinceAlreadyOffHeld();
		makeUser({ username: 'chief', role: 'superadmin' });
		owner = makeUser({ username: 'olga' });
		eve = makeUser({ username: 'eve' });
		board = makeBoard({ owner }).board;
		addBoardMember(board, eve, 'editor');
	});

	it.each([
		{ made: 'this server’s, its seal verifying', sealed: true },
		{ made: 'one whose seal does not verify', sealed: false }
	])('test 5 (card tests 1 and 2): a key revoked here since the backup is left out of $made, and refused; the other key works', async ({ sealed }) => {
		const K = makeApiKeyRow(owner);
		const L = makeApiKeyRow(owner);
		const backup = opening(sealed ? generateBackupData() : Buffer.from(sqlite.serialize()));
		revokedHere(K.id);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.sealVerified).toBe(sealed);
		expect(result.apiKeysLeftOut).toEqual({ count: 1, keyIds: [K.id], workingCopy: 0, unsealed: 0 });
		expect(keyIds()).toEqual([L.id]);
		expect(await v1(K.key)).toBe(401);
		expect(await v1(L.key)).toBe(200);
	});

	it('test 7: a working copy leaves out the key revoked here, by id, and the other, counted only (R4)', () => {
		const K = makeApiKeyRow(owner);
		makeApiKeyRow(owner);
		const backup = opening(generateBackupData());
		revokedHere(K.id);

		const result = restoreFromBackup(sqlite, backup, { outside: 'off' });

		expect(result.errors).toEqual([]);
		expect(result.apiKeysLeftOut).toEqual({ count: 1, keyIds: [K.id], workingCopy: 1, unsealed: 0 });
		expect(keyIds()).toEqual([]);
	});

	it('(j): a working copy leaves out every key, with no record, and counts them (R4); none is recorded', async () => {
		const K = makeApiKeyRow(owner);
		makeApiKeyRow(eve);
		const backup = opening(generateBackupData());
		const before = recordOf();

		const result = restoreFromBackup(sqlite, backup, { outside: 'off' });

		expect(result.errors).toEqual([]);
		expect(result.apiKeysLeftOut).toEqual({ count: 0, keyIds: [], workingCopy: 2, unsealed: 0 });
		expect(keyIds()).toEqual([]);
		expect(await v1(K.key)).toBe(401);
		// Left out as a copy, not ended: the record is as it was, so the same backup restored as it is brings them back.
		expect(recordOf()).toEqual(before);
		const again = restoreFromBackup(sqlite, opening(generateBackupData()));
		expect(again.apiKeysLeftOut).toEqual(NOTHING_LEFT_OUT);
	});

	it('test 8: the union: the backup’s row is added to this server’s, which are kept, and survives to leave its key out of the next restore', () => {
		const X = makeApiKeyRow(owner);
		const xHash = hashOf(X.id);
		const older = opening(generateBackupData());
		record(1, 'c'.repeat(64));
		const newer = opening(Buffer.from(sqlite.serialize()));
		newer.prepare('DELETE FROM api_keys WHERE id = ?').run(X.id);
		record(X.id, xHash, 'access ended', newer);
		const here = recordOf();

		const first = restoreFromBackup(sqlite, newer);

		expect(first.errors).toEqual([]);
		// This server's rows, row for row, and the backup's one more.
		expect(recordOf()).toEqual([...here, { id: X.id, hash: xHash, because: 'access ended' }].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : a.id - b.id)));
		const second = restoreFromBackup(sqlite, older);
		expect(second.errors).toEqual([]);
		expect(second.apiKeysLeftOut).toEqual({ count: 1, keyIds: [X.id], workingCopy: 0, unsealed: 0 });
		expect(keyIds()).toEqual([]);
	});

	it('test 9: a backup made before 0076, without the record: restored with no error, and this server’s record kept and applied', () => {
		const K = makeApiKeyRow(owner);
		const backup = opening(Buffer.from(sqlite.serialize()));
		backup.exec('DROP TABLE api_key_revocations');
		revokedHere(K.id);
		const here = recordOf();

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.apiKeysLeftOut).toEqual({ count: 1, keyIds: [K.id], workingCopy: 0, unsealed: 0 });
		expect(recordOf()).toEqual(here);
	});

	it('test 10: a seed row at or below the watermark leaves its id out, and records that key’s hash (R2); the next id is kept', () => {
		const seven = keyAt(7, owner);
		const eight = keyAt(8, owner);
		const backup = opening(generateBackupData());
		sqlite.prepare('DELETE FROM api_keys WHERE id = 7').run();
		watermark(8);
		record(7, '', 'before record');

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.apiKeysLeftOut).toEqual({ count: 1, keyIds: [7], workingCopy: 0, unsealed: 0 });
		expect(keyIds()).toEqual([8]);
		// The hash belt: the key is caught under any id in any later backup.
		expect(recordOf()).toContainEqual({ id: 7, hash: seven.hash, because: 'before record' });
		const elsewhere = opening(generateBackupData());
		elsewhere.prepare('UPDATE api_keys SET key_hash = ? WHERE id = 8').run(seven.hash);
		expect(restoreFromBackup(sqlite, elsewhere).apiKeysLeftOut.keyIds).toEqual([8]);
		expect(eight.hash).not.toBe(seven.hash);
	});

	it('test 11: a backup’s seed row within its bounds raises the key counter, and so does a hashed row (FP1); the next key takes the id after the largest', () => {
		makeApiKeyRow(owner);
		const backup = opening(Buffer.from(sqlite.serialize()));
		backup.prepare("UPDATE sqlite_sequence SET seq = 950 WHERE name = 'api_keys'").run();
		record(900, '', 'before record', backup);
		record(940, 'd'.repeat(64), 'revoked', backup);
		expect(counter()).toBeLessThan(900);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(counter()).toBe(940);
		expect(makeApiKeyRow(owner).id).toBe(941);
	});

	it('FP1: a backup whose counter row was deleted keeps its hashed row above its bound, and its watermark, on a fresh host; an older backup holding that key restored after leaves it out', () => {
		// Keys 1 to 3 live, W 3, then key 3 revoked, then the counter row deleted (as Admin › Vacuum did before c6ed310).
		const one = keyAt(1, owner);
		keyAt(2, owner);
		const three = keyAt(3, owner);
		watermark(3);
		const older = generateBackupData();
		revokedHere(three.id);
		sqlite.prepare("DELETE FROM sqlite_sequence WHERE name = 'api_keys'").run();
		const newer = Buffer.from(sqlite.serialize());
		// Its own bound: no counter row, and 2 the largest key it holds.
		expect(opening(newer).prepare("SELECT seq FROM sqlite_sequence WHERE name = 'api_keys'").get()).toBeUndefined();

		// A fresh host: nothing of this server's left. Both backups sealed under its key, as its own are, so that the record
		// alone decides here (card 3009's code review, FP11): card 3009's leave-out of an unsealed one is its own case below.
		resetDb();
		const sealedHere = (bytes: Buffer) => {
			const backup = opening(bytes);
			sealCopy(backup, backupSealKey(sqlite));
			return backup;
		};
		const first = restoreFromBackup(sqlite, sealedHere(newer));

		expect(first.errors).toEqual([]);
		expect(recordOf()).toEqual(
			expect.arrayContaining([
				{ id: 3, hash: three.hash, because: 'revoked' },
				{ id: 3, hash: 'watermark', because: 'before record' }
			])
		);
		// The counter never sits below an id the record names (FP1 b): the next key is 4, never 3.
		expect(counter()).toBe(3);
		const second = restoreFromBackup(sqlite, sealedHere(older));

		expect(second.sealVerified).toBe(true);
		expect(second.errors).toEqual([]);
		expect(second.apiKeysLeftOut).toEqual({ count: 1, keyIds: [3], workingCopy: 0, unsealed: 0 });
		expect(keyIds()).toEqual([one.id, 2]);
	});

	it('FP1, card 3009: the same older backup, its seal not verifying on the fresh host, also leaves out keys 1 and 2, which that host never held, counted apart', () => {
		keyAt(1, owner);
		keyAt(2, owner);
		const three = keyAt(3, owner);
		watermark(3);
		const older = generateBackupData();
		revokedHere(three.id);
		const newer = Buffer.from(sqlite.serialize());
		resetDb();
		const newerHere = opening(newer);
		sealCopy(newerHere, backupSealKey(sqlite));
		expect(restoreFromBackup(sqlite, newerHere).errors).toEqual([]);

		const second = restoreFromBackup(sqlite, opening(older));

		// None of its accounts is the same here (this host has no installation id): its keys this host never held go too.
		expect(second.sealVerified).toBe(false);
		expect(second.errors).toEqual([]);
		expect(second.apiKeysLeftOut).toEqual({ count: 1, keyIds: [3], workingCopy: 0, unsealed: 2 });
		expect(keyIds()).toEqual([]);
	});

	it('test 11: with no key counter row here, one is written', () => {
		const backup = opening(Buffer.from(sqlite.serialize()));
		backup.exec("INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('api_keys', 950)");
		record(900, '', 'before record', backup);
		sqlite.prepare("DELETE FROM sqlite_sequence WHERE name = 'api_keys'").run();
		expect(counter()).toBeUndefined();

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(counter()).toBe(900);
	});

	it('test 12: rows of the backup’s record that can name no key are left out with one line of a count and reasons, quoting nothing of the backup; an unreadable moment and an unknown word are kept', () => {
		makeApiKeyRow(owner);
		const backup = opening(Buffer.from(sqlite.serialize()));
		record(1, 'not-a-hash-2995', 'revoked', backup);
		record('a', 'e'.repeat(64), 'revoked', backup);
		record(0, 'e'.repeat(64), 'revoked', backup);
		backup
			.prepare("INSERT INTO api_key_revocations (key_id, key_hash, revoked_at, revoked_because) VALUES (1, ?, 'yesterday-ish', 'stolen-2995')")
			.run('f'.repeat(64));
		const at = stamp();

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([
			"3 row(s) of the backup's record of ended API keys were left out, as they can name no key: 1 with a hash that is neither empty nor a SHA-256, " +
				"2 with an id that is not a whole number from 1 to 2^53 - 1. The rest of the record was added to this server's."
		]);
		for (const quoted of ['not-a-hash-2995', 'stolen-2995', 'yesterday-ish']) expect(result.errors.join(' ')).not.toContain(quoted);
		const kept = sqlite.prepare('SELECT key_id AS id, revoked_at AS at, revoked_because AS because FROM api_key_revocations WHERE key_hash = ?').get('f'.repeat(64)) as {
			id: number;
			at: string;
			because: string;
		};
		expect(kept.id).toBe(1);
		expect(kept.because).toBe('recorded in a backup');
		expect(kept.at >= at).toBe(true);
		expect(recordOf().filter((row) => row.hash === 'e'.repeat(64) || row.hash === 'not-a-hash-2995')).toEqual([]);
	});

	it('(c): rows with key_id 2^53, and above the backup’s own counter, are left out with one line; this server’s counter is unchanged, and the next key takes the one after it', () => {
		makeApiKeyRow(owner);
		const backup = opening(Buffer.from(sqlite.serialize()));
		const bound = backup.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'api_keys'").pluck().get() as number;
		record(2 ** 53, '', 'before record', backup);
		record(bound + 5, '', 'before record', backup);
		const before = counter() as number;

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([
			"2 row(s) of the backup's record of ended API keys were left out, as they can name no key: 1 with an id that is not a whole number from 1 to 2^53 - 1, " +
				"1 with an id above the backup's own key counter. The rest of the record was added to this server's."
		]);
		expect(counter()).toBe(before);
		expect(makeApiKeyRow(owner).id).toBe(before + 1);
	});

	describe('card 2947’s carry for a key left out (R3, R8)', () => {
		let K: { key: string; id: number };
		let W: number;
		let U: number;
		let V: number;

		beforeEach(() => {
			K = makeApiKeyRow(owner);
			W = makeWebhook(board, { setBy: eve, secret: 'whsec-w-2995' }).id;
			U = makeWebhook(board, { setBy: eve, secret: 'whsec-u-2995' }).id;
			V = makeWebhook(board, { setBy: owner, secret: 'whsec-v-2995', setWithKey: true, setByKey: K.id }).id;
			sealPlainSecrets(sqlite);
			reveal(W, K.id);
		});

		it('test 13: the own restore deletes the key’s row and holds W, and U its account could read with no row (no last use asked); V it set is held key ended, naming no key (R8); told with the sweep', () => {
			const backup = opening(generateBackupData());
			revokedHere(K.id);

			const result = withWarnings(() => restoreFromBackup(sqlite, backup, { by: 'chief' }));

			expect(result.errors).toEqual([]);
			expect(result.apiKeysLeftOut).toEqual({ count: 1, keyIds: [K.id], workingCopy: 0, unsealed: 0 });
			expect(reveals()).toEqual([]);
			expect(rowOf(W)).toEqual(HELD);
			expect(rowOf(U)).toEqual(HELD);
			expect(rowOf(V)).toEqual(KEY_ENDED);
			expect(sqlite.prepare('SELECT set_by_key FROM webhooks WHERE id = ?').pluck().get(V)).toBeNull();
			const told = warnLines().join('\n');
			expect(told).toContain('found after a restore by chief');
			for (const id of [W, U, V]) expect(told).toMatch(new RegExp(`[Ww]ebhook ${id} on board ${board.id}\\b`));
		});

		it('test 13: as a working copy, W and U are held before every webhook is switched off', () => {
			const backup = opening(generateBackupData());
			revokedHere(K.id);

			const result = restoreFromBackup(sqlite, backup, { outside: 'off' });

			expect(result.errors).toEqual([]);
			expect(rowOf(W)).toEqual(HELD);
			expect(rowOf(U)).toEqual(HELD);
			expect(reveals()).toEqual([]);
		});

		it('test 14: this server’s row of a key the backup holds and the record names: the carry puts it back, and the leave-out reads it and holds W', () => {
			const backup = opening(generateBackupData());
			// Recorded by hand, the key kept live here: the carry finds the same key restored.
			record(K.id, hashOf(K.id));

			const result = restoreFromBackup(sqlite, backup);

			expect(result.errors).toEqual([]);
			expect(result.secrets.kept.webhooks).toEqual(expect.arrayContaining([W]));
			expect(keyIds()).toEqual([]);
			expect(reveals()).toEqual([]);
			expect(rowOf(W)).toEqual(HELD);
		});

		it('(l1, l2): carryDisabled names no key on the webhooks a disabled account’s key set (R8), through endApiKeys, and counts that key with those left out (R13)', () => {
			const kim = makeUser({ username: 'kim' });
			addBoardMember(board, kim, 'editor');
			const kimKey = makeApiKeyRow(kim);
			const X = makeWebhook(board, { setBy: kim, setWithKey: true, setByKey: kimKey.id }).id;
			const backup = opening(generateBackupData());
			const chief = sqlite.prepare("SELECT id, username, role FROM users WHERE username = 'chief'").get() as SessionUser;
			inTransaction(() => disableAccount(db.select().from(users).all().find((u) => u.id === kim.id)!, chief));

			const result = restoreFromBackup(sqlite, backup);

			expect(result.errors).toEqual([]);
			expect(result.apiKeysLeftOut.keyIds).toContain(kimKey.id);
			expect(sqlite.prepare('SELECT set_by_key FROM webhooks WHERE id = ?').pluck().get(X)).toBeNull();
		});
	});

	it('FP2: the backup’s own reveal row of a key left out holds the webhook, though its account can no longer read or set it', () => {
		const adam = makeUser({ username: 'adam', role: 'admin' });
		const K = makeApiKeyRow(adam);
		const W = makeWebhook(board, { setBy: eve, secret: 'whsec-fp2' }).id;
		sealPlainSecrets(sqlite);
		reveal(W, K.id);
		// Demoted since it was given the secret, before the backup: it neither sets W nor can read it now.
		sqlite.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(adam.id);
		const backup = opening(generateBackupData());
		revokedHere(K.id);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.apiKeysLeftOut.keyIds).toEqual([K.id]);
		expect(rowOf(W)).toEqual(HELD);
		expect(reveals()).toEqual([]);
	});

	it('test 16: carryDisabled records the keys it deletes, access ended; the account enabled again, a second restore of the same backup still leaves them out', () => {
		const kim = makeUser({ username: 'kim' });
		const K = makeApiKeyRow(kim);
		const hash = hashOf(K.id);
		const backup = generateBackupData();
		// Gone here before the disable, unrecorded, as a key a restore carried in before card 2671's carry: the disable
		// records nothing of it, so only the restore's carry can.
		sqlite.prepare('DELETE FROM api_keys WHERE id = ?').run(K.id);
		const chief = sqlite.prepare("SELECT id, username, role FROM users WHERE username = 'chief'").get() as SessionUser;
		inTransaction(() => disableAccount(db.select().from(users).all().find((u) => u.id === kim.id)!, chief));
		expect(recordOf()).toEqual([]);

		const first = restoreFromBackup(sqlite, opening(backup));

		expect(first.errors).toEqual([]);
		expect(first.apiKeysLeftOut).toEqual({ count: 1, keyIds: [K.id], workingCopy: 0, unsealed: 0 });
		expect(recordOf()).toEqual([{ id: K.id, hash, because: 'access ended' }]);
		sqlite.prepare('UPDATE users SET disabled_at = NULL, disabled_by = NULL WHERE id = ?').run(kim.id);

		const second = restoreFromBackup(sqlite, opening(backup));

		expect(second.apiKeysLeftOut).toEqual({ count: 1, keyIds: [K.id], workingCopy: 0, unsealed: 0 });
		expect(keyIds()).toEqual([]);
	});

	it('test 25: a backup made after revokes holds the record row for row as this server does, and no value of it is a key', async () => {
		const K = makeApiKeyRow(owner);
		makeApiKeyRow(owner);
		expect((await api('DELETE', `/api/account/api-keys/${K.id}`, { user: owner })).status).toBe(200);
		const all = (database: Database.Database) => database.prepare('SELECT * FROM api_key_revocations ORDER BY rowid').all() as Record<string, unknown>[];

		const backup = opening(generateBackupData());

		expect(all(backup)).toEqual(all(sqlite));
		expect(all(backup).some((row) => row.key_id === K.id && row.revoked_because === 'revoked')).toBe(true);
		for (const row of all(backup)) for (const value of Object.values(row)) expect(String(value).startsWith('df_')).toBe(false);
	});

	it('test 26: end to end, a key revoked through DELETE /api/account/api-keys/{id} stays out of this server’s backup from before it, and is refused', async () => {
		const K = makeApiKeyRow(owner);
		const L = makeApiKeyRow(owner);
		const backup = opening(generateBackupData());
		expect((await api('DELETE', `/api/account/api-keys/${K.id}`, { user: owner })).status).toBe(200);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.apiKeysLeftOut).toEqual({ count: 1, keyIds: [K.id], workingCopy: 0, unsealed: 0 });
		expect(await v1(K.key)).toBe(401);
		expect(await v1(L.key)).toBe(200);
	});

	it('test 15: a restore whose leave-out, or whose union, cannot be written is rolled back, and nothing is changed', () => {
		const K = makeApiKeyRow(owner);
		const backup = opening(Buffer.from(sqlite.serialize()));
		record(K.id + 50, 'a'.repeat(64), 'revoked', backup);
		backup.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'api_keys'").run(K.id + 60);
		revokedHere(K.id);
		const before = snapshotDb();
		for (const trigger of [
			`CREATE TEMP TRIGGER refuse_2995 BEFORE DELETE ON api_keys WHEN OLD.id = ${K.id} BEGIN SELECT RAISE(ABORT, 'refused by test 15'); END`,
			"CREATE TEMP TRIGGER refuse_2995 BEFORE INSERT ON api_key_revocations BEGIN SELECT RAISE(ABORT, 'refused by test 15'); END"
		]) {
			sqlite.exec(trigger);
			try {
				let thrown: unknown = null;
				try {
					restoreFromBackup(sqlite, backup);
				} catch (e) {
					thrown = e;
				}
				expect(thrown).toBeInstanceOf(RestoreError);
				expect((thrown as RestoreError).committed).toBe(false);
				expect((thrown as RestoreError).message).toContain('refused by test 15');
				expectUnchanged(before);
			} finally {
				sqlite.exec('DROP TRIGGER IF EXISTS temp.refuse_2995');
			}
		}
	});

	it('(b): an id this server held with another hash just before the restore: the backup’s key at that id is left out, counted, and its hash recorded (R1)', async () => {
		const old = keyAt(5, owner);
		const backup = opening(generateBackupData());
		sqlite.prepare('DELETE FROM api_keys WHERE id = 5').run();
		const held = keyAt(5, owner);
		watermark(5);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.apiKeysLeftOut).toEqual({ count: 1, keyIds: [5], workingCopy: 0, unsealed: 0 });
		expect(keyIds()).toEqual([]);
		expect(recordOf()).toContainEqual({ id: 5, hash: old.hash, because: 'before record' });
		expect(await v1(old.key)).toBe(401);
		expect(held.hash).not.toBe(old.hash);
	});

	it('(d): a backup shaped as before 0075, its key recorded here and used: the own restore leaves it out and holds W, told with the sweep; a working copy holds W before switching every webhook off', () => {
		for (const outside of ['keep', 'off'] as const) {
			resetDb();
			startedSinceAlreadyOffHeld();
			makeUser({ username: 'chief', role: 'superadmin' });
			const olga = makeUser({ username: 'olga' });
			const ann = makeUser({ username: 'ann' });
			const theBoard = makeBoard({ owner: olga }).board;
			addBoardMember(theBoard, ann, 'editor');
			const K = makeApiKeyRow(olga);
			const W = makeWebhook(theBoard, { setBy: ann, secret: 'whsec-d-2995' }).id;
			sqlite.prepare("UPDATE webhooks SET created_at = '2026-10-01 09:00:00' WHERE id = ?").run(W);
			sqlite.prepare("UPDATE api_keys SET last_used_at = '2026-11-01 09:00:00' WHERE id = ?").run(K.id);
			const backup = opening(Buffer.from(sqlite.serialize()));
			backup.exec("DROP TABLE webhook_reveals; DELETE FROM settings WHERE key = 'webhook_reveals_seeded'");
			revokedHere(K.id);

			const result = withWarnings(() => restoreFromBackup(sqlite, backup, { outside, by: 'chief' }));

			expect(result.errors, outside).toEqual([]);
			expect(result.apiKeysLeftOut.keyIds, outside).toEqual([K.id]);
			expect(rowOf(W), outside).toEqual(HELD);
			if (outside === 'keep') {
				expect(warnLines().join('\n')).toContain('found after a restore by chief');
				expect(warnLines().join('\n')).toMatch(new RegExp(`[Ww]ebhook ${W} on board ${theBoard.id}\\b`));
			}
		}
	});
});

describe('a restore never brings back an account deleted, disabled or demoted on this server (card 2996)', () => {
	const HELD = { active: 0, heldBecause: 'setter access ended' };
	const NONE_KEPT = { deleted: 0, beforeRecord: 0, disabled: 0, lowered: 0 };
	/** A bcrypt-shaped string of its own for each `n`, for a hash a test writes by hand. */
	const hashLike = (n: number) => `$2b$04$${String(n).padStart(53, 'A')}`;
	/** A row of the record, by hand: slice 2 has no writer (R8). */
	const row = (
		userId: number | string,
		created: string,
		ending: string,
		opts: { role?: string; credential?: string; at?: string; origin?: 'here' | 'backup' } = {},
		database: Database.Database = sqlite
	) =>
		database
			.prepare('INSERT INTO account_endings (user_id, account_created, ending, role, credential, ended_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?)')
			.run(userId, created, ending, opts.role ?? '', opts.credential ?? '', opts.at ?? '2026-11-19 09:00:00', opts.origin ?? 'here');
	const createdOf = (id: number) => sqlite.prepare('SELECT created_at FROM users WHERE id = ?').pluck().get(id) as string;
	const userOf = (id: number) =>
		sqlite
			.prepare('SELECT role, disabled_at AS disabledAt, disabled_by AS disabledBy, password_hash AS passwordHash, mfa_password_enrol AS enrol FROM users WHERE id = ?')
			.get(id) as { role: string; disabledAt: string | null; disabledBy: number | null; passwordHash: string; enrol: number } | undefined;
	const recordOf = () =>
		sqlite.prepare('SELECT user_id AS id, account_created AS created, ending, role, credential, origin FROM account_endings ORDER BY seq').all() as {
			id: number;
			created: string;
			ending: string;
			role: string;
			credential: string;
			origin: string;
		}[];
	const secondStepsOf = (id: number) => ({
		factors: sqlite.prepare('SELECT COUNT(*) FROM mfa_factors WHERE user_id = ?').pluck().get(id),
		codes: sqlite.prepare('SELECT COUNT(*) FROM mfa_recovery_codes WHERE user_id = ?').pluck().get(id)
	});
	const keysOf = (id: number) => sqlite.prepare('SELECT id FROM api_keys WHERE user_id = ? ORDER BY id').pluck().all(id) as number[];
	const rowOf = (id: number) => sqlite.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(id);
	const warnLines = () => sqlite.prepare("SELECT message FROM system_logs WHERE context = 'Webhooks' AND level = 'WARN' ORDER BY id").pluck().all() as string[];
	const withWarnings = <T>(run: () => T): T => {
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		try {
			return run();
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
	};
	/** An account with a second factor, a recovery code, an API key and a report schedule that is on. */
	const holding = (username: string, role: 'user' | 'admin' = 'user') => {
		const account = makeUser({ username, role });
		stepUpFactor(account);
		sqlite.prepare('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?, ?)').run(account.id, `code-of-${username}`);
		const key = makeApiKeyRow(account);
		sqlite.prepare("INSERT INTO report_schedules (user_id, name, scope, enabled) VALUES (?, 'Weekly', 'all', 1)").run(account.id);
		return { ...account, key };
	};
	/** The account gone from this server, by hand, with no row of the record: as a restore of a backup without it leaves it. */
	const goneHere = (id: number) => {
		sqlite.pragma('foreign_keys = OFF');
		try {
			for (const table of ['mfa_factors', 'mfa_recovery_codes', 'api_keys', 'report_schedules']) sqlite.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(id);
			sqlite.prepare('DELETE FROM users WHERE id = ?').run(id);
		} finally {
			sqlite.pragma('foreign_keys = ON');
		}
	};
	/** Deleted here since the backup, as slice 2 stands in for `deleteUser`: gone, with an exact `deleted` row. */
	const deletedHere = (id: number, credential = '') => {
		const created = createdOf(id);
		goneHere(id);
		row(id, created, 'deleted', { credential });
	};
	let chief: SessionUser;
	let owner: SessionUser;
	let board: Board;

	beforeEach(() => {
		resetDb();
		resetAllRateLimits();
		startedSinceAlreadyOffHeld();
		chief = makeUser({ username: 'chief', role: 'superadmin' });
		owner = makeUser({ username: 'olga' });
		board = makeBoard({ owner }).board;
	});

	it.each([
		{ made: 'this server’s sealed backup', sealed: true, outside: 'keep' as const },
		{ made: 'a copy whose seal does not verify', sealed: false, outside: 'keep' as const },
		// Test 18, folded (R23): a working copy gives the same ruling and counts.
		{ made: 'this server’s sealed backup, as a working copy', sealed: true, outside: 'off' as const }
	])('test 7 (card test F2): an account deleted here since $made comes back disabled and inert, with no factor, code or key', ({ sealed, outside }) => {
		const x = holding('xavier');
		const backup = opening(sealed ? generateBackupData() : Buffer.from(sqlite.serialize()));
		deletedHere(x.id);
		const recorded = recordOf().length;

		const result = restoreFromBackup(sqlite, backup, { outside });

		expect(result.errors).toEqual([]);
		expect(result.accountsKept).toEqual({ ...NONE_KEPT, deleted: 1 });
		expect(userOf(x.id)).toEqual({ role: 'user', disabledAt: expect.any(String), disabledBy: chief.id, passwordHash: DUMMY_HASH, enrol: 0 });
		// Its factor and code were in the sealed backup: neither is restored, and it is named nowhere.
		expect(secondStepsOf(x.id)).toEqual({ factors: 0, codes: 0 });
		expect(JSON.stringify(result.mfa)).not.toContain('xavier');
		expect(keysOf(x.id)).toEqual([]);
		expect(result.apiKeysLeftOut.keyIds).toContain(x.key.id);
		expect(sqlite.prepare('SELECT enabled FROM report_schedules WHERE user_id = ?').pluck().all(x.id)).toEqual([0]);
		expect(() => createSession(x.id)).toThrow(AccountDisabled);
		// An exact deleted row named it already: none is added (R3). The one row added is the hash DUMMY_HASH replaced,
		// recorded as replaced (card 2997, N1).
		expect(recordOf().slice(recorded)).toEqual([
			{ id: x.id, created: createdOf(x.id), ending: 'password', role: '', credential: credentialOf(fixtureHashOf(x)), origin: 'belt' }
		]);
	});

	it.each([{ outside: 'keep' as const }, { outside: 'off' as const }])(
		'test 8 (card test F3, and test 18 as $outside): an administrator made a user here since the backup is restored a user, and a webhook it could read held',
		({ outside }) => {
			const x = makeUser({ username: 'xavier', role: 'admin' });
			const W = makeWebhook(board, { setBy: owner, secret: 'whsec-f3-2996' }).id;
			sealPlainSecrets(sqlite);
			const backup = opening(generateBackupData());
			sqlite.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(x.id);
			row(x.id, createdOf(x.id), 'role', { role: 'user' });

			const result = restoreFromBackup(sqlite, backup, { outside });

			expect(result.errors).toEqual([]);
			expect(result.accountsKept).toEqual({ ...NONE_KEPT, lowered: 1 });
			expect(userOf(x.id)).toMatchObject({ role: 'user', disabledAt: null });
			expect(rowOf(W)).toEqual(HELD);
		}
	);

	it('test 10: an account the record disabled and absent here comes back disabled at the row’s moment by the superadmin, its password kept, its keys ended and no factor of the backup’s; disabled then enabled here, not', () => {
		const x = holding('xavier');
		const y = holding('yolanda');
		const backup = generateBackupData();
		const xCreated = createdOf(x.id);
		const yCreated = createdOf(y.id);
		goneHere(x.id);
		goneHere(y.id);
		row(x.id, xCreated, 'disabled', { at: '2026-11-19 08:00:00' });
		row(y.id, yCreated, 'disabled', { at: '2026-11-19 08:00:00' });
		row(y.id, yCreated, 'enabled', { at: '2026-11-19 08:30:00' });

		const result = restoreFromBackup(sqlite, opening(backup));

		expect(result.errors).toEqual([]);
		expect(result.accountsKept).toEqual({ ...NONE_KEPT, disabled: 1 });
		expect(userOf(x.id)).toEqual({ role: 'user', disabledAt: '2026-11-19 08:00:00', disabledBy: chief.id, passwordHash: fixtureHashOf(x), enrol: 0 });
		expect(keysOf(x.id)).toEqual([]);
		expect(sqlite.prepare('SELECT revoked_because FROM api_key_revocations WHERE key_id = ?').pluck().get(x.key.id)).toBe('access ended');
		expect(secondStepsOf(x.id)).toEqual({ factors: 0, codes: 0 });
		expect(JSON.stringify(result.mfa)).not.toContain('xavier');
		// Y's latest is an enable here: restored as the backup had it, its factor taken from this server's own sealed backup.
		expect(userOf(y.id)).toMatchObject({ disabledAt: null, passwordHash: fixtureHashOf(y) });
		expect(secondStepsOf(y.id)).toEqual({ factors: 1, codes: 1 });
	});

	it('test 11: a backup’s later enable never lifts this server’s disable of the same account', () => {
		const x = holding('xavier');
		const backup = opening(generateBackupData());
		row(x.id, createdOf(x.id), 'disabled', { at: '2026-11-19 08:00:00' });
		row(x.id, createdOf(x.id), 'enabled', { at: '2026-11-19 08:30:00', origin: 'backup' }, backup);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(userOf(x.id)).toMatchObject({ disabledAt: '2026-11-19 08:00:00', disabledBy: chief.id });
	});

	it('test 12: a seed row at or below W names a backup account made before it: disabled with no password that works, no factor, an exact disabled row written here; enabled by the superadmin, the next restore of the same backup leaves it enabled', () => {
		const y = holding('yolanda');
		const backup = generateBackupData();
		goneHere(y.id);
		const seeded = stamp();
		row(y.id + 5, '', 'watermark', { at: seeded });
		row(y.id, '', 'deleted', { at: seeded });

		const first = restoreFromBackup(sqlite, opening(backup));

		expect(first.errors).toEqual([]);
		expect(first.accountsKept).toEqual({ ...NONE_KEPT, beforeRecord: 1 });
		expect(userOf(y.id)).toMatchObject({ disabledAt: expect.any(String), disabledBy: chief.id, passwordHash: DUMMY_HASH });
		expect(secondStepsOf(y.id)).toEqual({ factors: 0, codes: 0 });
		expect(recordOf().filter((entry) => entry.id === y.id && entry.ending === 'disabled')).toEqual([
			{ id: y.id, created: createdOf(y.id), ending: 'disabled', role: '', credential: '', origin: 'belt' }
		]);

		// The superadmin enables it (as slice 2 stands in for the enable): the row it writes, and the account enabled.
		sqlite.prepare('UPDATE users SET disabled_at = NULL, disabled_by = NULL, password_hash = ? WHERE id = ?').run(hashLike(5), y.id);
		row(y.id, createdOf(y.id), 'enabled', { at: stamp() });
		const second = restoreFromBackup(sqlite, opening(backup));

		expect(second.errors).toEqual([]);
		expect(second.accountsKept).toEqual(NONE_KEPT);
		// The password it was given here, not the backup's, which the first restore recorded as replaced (card 2997, N1).
		expect(userOf(y.id)).toMatchObject({ disabledAt: null, passwordHash: hashLike(5) });
	});

	it('test 14: an id this server held with a later creation time just before the restore: the backup’s earlier account is before record and belted; one held with an earlier time is not', () => {
		const z = makeUser({ username: 'zed' });
		const zed = { id: z.id, created: '2026-01-01 09:00:00' };
		sqlite.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(zed.created, zed.id);
		const backup = generateBackupData();
		goneHere(zed.id);
		sqlite
			.prepare("INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES (?, 'later', 'later@example.test', ?, 'user', '2026-06-01 09:00:00')")
			.run(zed.id, hashLike(6));
		row(zed.id + 1, '', 'watermark');

		const result = restoreFromBackup(sqlite, opening(backup));

		expect(result.errors).toEqual([]);
		expect(result.accountsKept).toEqual({ ...NONE_KEPT, beforeRecord: 1 });
		expect(userOf(zed.id)).toMatchObject({ passwordHash: DUMMY_HASH, disabledBy: chief.id });
		expect(recordOf()).toContainEqual({ id: zed.id, created: zed.created, ending: 'disabled', role: '', credential: '', origin: 'belt' });

		// Held here with an earlier creation time: not the case (the backup's account is the later one).
		resetDb();
		startedSinceAlreadyOffHeld();
		makeUser({ username: 'chief', role: 'superadmin' });
		const w = makeUser({ username: 'wanda' });
		sqlite.prepare("UPDATE users SET created_at = '2026-06-01 09:00:00' WHERE id = ?").run(w.id);
		const later = generateBackupData();
		sqlite.prepare("UPDATE users SET created_at = '2026-01-01 09:00:00' WHERE id = ?").run(w.id);
		row(w.id + 1, '', 'watermark');
		expect(restoreFromBackup(sqlite, opening(later)).accountsKept).toEqual(NONE_KEPT);
	});

	it('test 15: the credential belt: an account under another id and time with the password hash of a deleted row is inert; the superadmin never', () => {
		const x = holding('xavier');
		const backup = opening(generateBackupData());
		row(900, '2025-01-01 09:00:00', 'deleted', { credential: credentialOf(fixtureHashOf(x)) });
		row(901, '2025-01-01 09:00:00', 'deleted', { credential: credentialOf(fixtureHashOf(chief)) });

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.accountsKept).toEqual({ ...NONE_KEPT, deleted: 1 });
		expect(userOf(x.id)).toMatchObject({ passwordHash: DUMMY_HASH });
		expect(userOf(chief.id)).toMatchObject({ passwordHash: fixtureHashOf(chief), disabledAt: null });
		// R3: the fingerprint it was matched on, under its own id and time, so that it stays inert.
		expect(recordOf()).toContainEqual({ id: x.id, created: createdOf(x.id), ending: 'deleted', role: '', credential: credentialOf(fixtureHashOf(x)), origin: 'belt' });
	});

	it('test 17: a row of this server’s naming the backup’s only superadmin refuses the restore, with its own sentence, nothing changed; with a second superadmin, it is applied', () => {
		const backup = opening(generateBackupData());
		row(chief.id, createdOf(chief.id), 'deleted');
		const before = snapshotDb();

		let thrown: unknown = null;
		try {
			restoreFromBackup(sqlite, backup);
		} catch (e) {
			thrown = e;
		}

		expect(thrown).toBeInstanceOf(RestoreLeavesNoSuperadmin);
		expect((thrown as RestoreError).committed).toBe(false);
		expect((thrown as RestoreError).message).toContain("this server's record of account endings names as deleted, disabled or given a lower role here");
		expectUnchanged(before);

		const second = makeUser({ username: 'deputy', role: 'superadmin' });
		const withTwo = opening(generateBackupData());
		const result = restoreFromBackup(sqlite, withTwo);
		// The backup's own copy of this server's row names the superadmin: held here already, it is no news and is not
		// counted as left out (the code review's FP1); this server's own row applies.
		expect(result.errors).toEqual([]);
		expect(result.accountsKept).toEqual({ ...NONE_KEPT, deleted: 1 });
		expect(userOf(chief.id)).toMatchObject({ passwordHash: DUMMY_HASH, disabledBy: second.id });
	});

	it('test 19: the union: the backup’s row is added as a backup’s, this server’s kept; and it survives to end its account in the next restore', () => {
		const x = holding('xavier');
		const older = generateBackupData();
		const xCreated = createdOf(x.id);
		goneHere(x.id);
		row(owner.id, createdOf(owner.id), 'role', { role: 'user' });
		const newer = opening(Buffer.from(sqlite.serialize()));
		row(x.id, xCreated, 'deleted', {}, newer);
		const here = recordOf();

		const first = restoreFromBackup(sqlite, newer);

		expect(first.errors).toEqual([]);
		expect(recordOf()).toEqual([...here, { id: x.id, created: xCreated, ending: 'deleted', role: '', credential: '', origin: 'backup' }]);
		const second = restoreFromBackup(sqlite, opening(older));
		expect(second.errors).toEqual([]);
		expect(second.accountsKept).toEqual({ ...NONE_KEPT, deleted: 1 });
		expect(userOf(x.id)).toMatchObject({ passwordHash: DUMMY_HASH });
	});

	it('test 20, (h), (k): rows of the backup’s record that can name no account here are left out with one line of a count and reasons, quoting nothing of it; an unreadable or a future moment is the backup’s own latest', () => {
		const backup = opening(Buffer.from(sqlite.serialize()));
		const bound = Math.max(owner.id, (backup.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").pluck().get() as number | undefined) ?? 0);
		const ownerCreated = createdOf(owner.id);
		const rows: [number | string, string, string, { role?: string; credential?: string; at?: string }][] = [
			[0, ownerCreated, 'deleted', {}],
			['a', ownerCreated, 'deleted', {}],
			[2 ** 53, ownerCreated, 'deleted', {}],
			[owner.id, ownerCreated, 'zapped-2996', {}],
			[owner.id, ownerCreated, 'role', { role: 'superadmin' }],
			[owner.id, ownerCreated, 'deleted', { credential: 'not-hex-2996' }],
			[owner.id, 'yesterday-2996', 'disabled', {}],
			[bound + 5, '', 'deleted', {}],
			[bound + 5, '', 'watermark', {}],
			// (h): an exact row made after the restore's moment.
			[owner.id, '2099-01-01 09:00:00', 'deleted', {}],
			// (k): a row ending the superadmin.
			[chief.id, createdOf(chief.id), 'deleted', {}],
			// Kept: an unreadable moment, and a future one.
			[owner.id, ownerCreated, 'disabled', { at: 'soon-ish-2996' }],
			[owner.id, ownerCreated, 'enabled', { at: '2099-01-01 09:00:00' }]
		];
		for (const [id, created, ending, opts] of rows) row(id, created, ending, opts, backup);
		const at = stamp();

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([
			"11 row(s) of the backup's record of account endings were left out, as they can name no account here: 3 with an id that is not a whole number from 1 to 2^53 - 1, " +
				'1 with an ending this build does not know, 1 with a role that is neither user nor admin, 1 with a fingerprint that is not one the ending can have, ' +
				"1 with a creation time that is not one the ending can have, 2 with an id above the backup's own account counter, 1 with a creation time later than the restore, " +
				"1 with a row naming the superadmin. The rest of the record was added to this server's."
		]);
		for (const quoted of ['zapped-2996', 'not-hex-2996', 'yesterday-2996', 'soon-ish-2996']) expect(result.errors.join(' ')).not.toContain(quoted);
		// A genuine backup's superadmin restores (k).
		expect(userOf(chief.id)).toMatchObject({ disabledAt: null, passwordHash: fixtureHashOf(chief) });
		const kept = sqlite.prepare("SELECT ending, ended_at AS at FROM account_endings WHERE origin = 'backup' ORDER BY seq").all() as { ending: string; at: string }[];
		expect(kept.map((entry) => entry.ending)).toEqual(['disabled', 'enabled']);
		// Both at the backup's own latest moment no later than the restore's (R15).
		expect(kept[0].at).toBe(kept[1].at);
		// No later than the moment taken before the restore began (FP9): the backup's own accounts were made before it.
		expect(kept[0].at <= at).toBe(true);
		const own = backup.prepare('SELECT created_at FROM users').pluck().all() as string[];
		expect(own).toContain(kept[0].at);
	});

	it('test 20 (R14, FP7): more than 1,000,000 seed rows, or more than 1,000,000 other rows, leave the record out whole, with one line and the count', () => {
		const ownerCreated = createdOf(owner.id);
		for (const { rows, says } of [
			{
				rows: "SELECT i, '', 'deleted', '2026-11-19 09:00:00' FROM n",
				says: 'more than 1,000,000 rows naming accounts by number alone'
			},
			{
				rows: `SELECT i, '${ownerCreated}', 'disabled', '2026-11-19 09:00:00' FROM n`,
				says: 'more than 1,000,000 rows naming accounts by number and creation time'
			}
		]) {
			const backup = opening(Buffer.from(sqlite.serialize()));
			backup.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000001) INSERT INTO account_endings (user_id, account_created, ending, ended_at) ${rows}`);

			const result = restoreFromBackup(sqlite, backup);

			expect(result.errors).toEqual([
				`The backup's record of account endings holds ${says}, more than any server writes, and none of its 1000001 row(s) was added to this server's.`
			]);
			expect(result.accountRecordLeftOut).toBe(1000001);
			expect(recordOf()).toEqual([]);
		}
	}, 120_000);

	it('test 20 (FP3): more than 100 rows for one account leave the record out whole, counted, naming nobody', () => {
		const backup = opening(Buffer.from(sqlite.serialize()));
		backup.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 101) INSERT INTO account_endings (user_id, account_created, ending, ended_at) ` +
				`SELECT ${owner.id}, '${createdOf(owner.id)}', 'disabled', '2026-11-19 09:00:00' FROM n`
		);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([
			"The backup's record of account endings holds more than 100 rows for one account, more than any server writes, and none of its 101 row(s) was added to this server's."
		]);
		expect(result.accountRecordLeftOut).toBe(101);
		expect(recordOf()).toEqual([]);
		expect(userOf(owner.id)).toMatchObject({ disabledAt: null });
		// One row fewer is taken whole.
		backup.exec(`DELETE FROM account_endings WHERE seq = (SELECT max(seq) FROM account_endings)`);
		expect(restoreFromBackup(sqlite, backup).accountRecordLeftOut).toBe(0);
	});

	it('FP7: a server at exactly the guard, 1,000,000 seed rows, restores its own backup and keeps every row', () => {
		sqlite.exec(
			"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000000) INSERT INTO account_endings (user_id, account_created, ending, ended_at, stated_ended) SELECT i + 100, '', 'deleted', '2026-11-19 09:00:00', '2026-11-19 09:00:00' FROM n"
		);
		const backup = opening(Buffer.from(sqlite.serialize()));
		backup.prepare("UPDATE sqlite_sequence SET seq = 1000100 WHERE name = 'users'").run();

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.accountRecordLeftOut).toBe(0);
		expect(sqlite.prepare('SELECT COUNT(*) FROM account_endings').pluck().get()).toBe(1000000);
	}, 180_000);

	it('test 21: a backup’s seed row within its bound raises the users counter, and the next account takes the id after it; with no counter row, one is written; an exact row raises nothing', () => {
		const counter = () => sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").pluck().get() as number | undefined;
		const backup = opening(Buffer.from(sqlite.serialize()));
		backup.prepare("UPDATE sqlite_sequence SET seq = 950 WHERE name = 'users'").run();
		row(900, '', 'deleted', {}, backup);
		row(940, '2026-01-01 09:00:00', 'deleted', {}, backup);
		expect(counter()).toBeLessThan(900);

		expect(restoreFromBackup(sqlite, backup).errors).toEqual([]);
		expect(counter()).toBe(900);
		expect(makeUser({ username: 'next' }).id).toBe(901);

		sqlite.prepare("DELETE FROM sqlite_sequence WHERE name = 'users'").run();
		const again = opening(Buffer.from(sqlite.serialize()));
		again.exec('DELETE FROM account_endings');
		row(905, '', 'deleted', {}, again);
		again.prepare("INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('users', 950)").run();
		sqlite.exec('DELETE FROM account_endings');
		sqlite.prepare("DELETE FROM sqlite_sequence WHERE name = 'users'").run();
		expect(restoreFromBackup(sqlite, again).errors).toEqual([]);
		expect(counter()).toBe(905);
	});

	it('test 22: a backup made before 0077, without the record: restored with no error, and this server’s record kept and applied', () => {
		const x = holding('xavier');
		const backup = opening(generateBackupData());
		backup.exec('DROP TABLE account_endings');
		deletedHere(x.id);
		const here = recordOf();

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.accountsKept).toEqual({ ...NONE_KEPT, deleted: 1 });
		// This server's record kept, with the hash DUMMY_HASH replaced recorded as replaced (card 2997, N1).
		expect(recordOf()).toEqual([
			...here,
			{ id: x.id, created: createdOf(x.id), ending: 'password', role: '', credential: credentialOf(fixtureHashOf(x)), origin: 'belt' }
		]);
	});

	it('test 23: on this server’s sealed backup, an account the record keeps disabled keeps this server’s own factors where it is the same here, and gets none of the backup’s where it is not; neither named', () => {
		const x = holding('xavier');
		const y = holding('yolanda');
		const backup = opening(generateBackupData());
		// X: a second factor here since the backup, and a disable of the record's.
		sqlite.prepare("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?, 'code-of-xavier-2')").run(x.id);
		row(x.id, createdOf(x.id), 'disabled');
		const yCreated = createdOf(y.id);
		goneHere(y.id);
		row(y.id, yCreated, 'disabled');

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(secondStepsOf(x.id)).toEqual({ factors: 1, codes: 2 });
		expect(secondStepsOf(y.id)).toEqual({ factors: 0, codes: 0 });
		expect(JSON.stringify(result.mfa)).not.toMatch(/xavier|yolanda/);
	});

	it('test 24 (R13): a restore whose union, or whose applying, cannot be written is rolled back, and nothing is changed', () => {
		const x = holding('xavier');
		const backup = opening(generateBackupData());
		row(owner.id, createdOf(owner.id), 'role', { role: 'user' }, backup);
		deletedHere(x.id);
		const before = snapshotDb();
		for (const trigger of [
			"CREATE TEMP TRIGGER refuse_2996 BEFORE INSERT ON account_endings BEGIN SELECT RAISE(ABORT, 'refused by test 24'); END",
			"CREATE TEMP TRIGGER refuse_2996 BEFORE UPDATE ON users WHEN NEW.password_hash IS NOT OLD.password_hash BEGIN SELECT RAISE(ABORT, 'refused by test 24'); END"
		]) {
			sqlite.exec(trigger);
			try {
				let thrown: unknown = null;
				try {
					restoreFromBackup(sqlite, backup);
				} catch (e) {
					thrown = e;
				}
				expect(thrown).toBeInstanceOf(RestoreError);
				expect((thrown as RestoreError).committed).toBe(false);
				expect((thrown as RestoreError).message).toContain('refused by test 24');
				expectUnchanged(before);
			} finally {
				sqlite.exec('DROP TRIGGER IF EXISTS temp.refuse_2996');
			}
		}
	});

	it('test 25: an inert administrator: a webhook it could read, one it set and one its key was given are all held, and told with the sweep', () => {
		const x = holding('xavier', 'admin');
		const readable = makeWebhook(board, { setBy: owner, secret: 'whsec-r-2996' }).id;
		const set = makeWebhook(board, { setBy: x, secret: 'whsec-s-2996' }).id;
		const given = makeWebhook(board, { setBy: owner, secret: 'whsec-g-2996' }).id;
		sealPlainSecrets(sqlite);
		sqlite.prepare("INSERT INTO webhook_reveals (webhook_id, key_id, revealed_at) VALUES (?, ?, '2026-11-20 09:00:00')").run(given, x.key.id);
		const backup = opening(generateBackupData());
		deletedHere(x.id);

		const result = withWarnings(() => restoreFromBackup(sqlite, backup, { by: 'chief' }));

		expect(result.errors).toEqual([]);
		expect(result.accountsKept).toEqual({ ...NONE_KEPT, deleted: 1 });
		for (const id of [readable, set, given]) expect(rowOf(id), `webhook ${id}`).toMatchObject({ active: 0, heldBecause: expect.any(String) });
		expect(rowOf(readable)).toEqual(HELD);
		expect(rowOf(given)).toEqual(HELD);
		const told = warnLines().join('\n');
		expect(told).toContain('found after a restore by chief');
		for (const id of [readable, set, given]) expect(told).toMatch(new RegExp(`[Ww]ebhook ${id} on board ${board.id}\\b`));
	});

	it('FP2: a forged backup that makes this server’s superadmin an administrator with a deleted account’s hash writes no belt on it, and a later genuine restore succeeds with the superadmin untouched', () => {
		const genuine = opening(Buffer.from(sqlite.serialize()));
		const forged = opening(Buffer.from(sqlite.serialize()));
		forged.prepare("UPDATE users SET role = 'admin', password_hash = ? WHERE id = ?").run(hashLike(77), chief.id);
		forged.prepare("INSERT INTO users (username, email, password_hash, role) VALUES ('mallory', 'm@example.test', ?, 'superadmin')").run(hashLike(88));
		row(owner.id, '2020-01-01 00:00:00', 'deleted', { credential: credentialOf(hashLike(77)), at: '2020-01-01 00:00:00' }, forged);

		const first = restoreFromBackup(sqlite, forged);

		expect(first.accountsKept.deleted).toBe(0);
		expect(recordOf().filter((entry) => entry.id === chief.id)).toEqual([]);
		const second = restoreFromBackup(sqlite, genuine);
		expect(second.errors).toEqual([]);
		expect(userOf(chief.id)).toMatchObject({ role: 'superadmin', disabledAt: null, passwordHash: fixtureHashOf(chief) });
	});

	it('FP2: the seed and held-here halves never rule this server’s superadmin, made an administrator by a backup, and write no belt on it', () => {
		// The backup's account at the superadmin's id is another, older one, an administrator; a seed row names the id too.
		const older = opening(Buffer.from(sqlite.serialize()));
		older.prepare("UPDATE users SET role = 'admin', created_at = '2020-01-01 09:00:00' WHERE id = ?").run(chief.id);
		older.prepare("INSERT INTO users (username, email, password_hash, role) VALUES ('mallory', 'm@example.test', ?, 'superadmin')").run(hashLike(88));
		row(chief.id + 10, '', 'watermark');
		row(chief.id, '', 'deleted', { at: '2026-11-19 09:00:00' });

		const result = restoreFromBackup(sqlite, older);

		expect(result.accountsKept).toEqual(NONE_KEPT);
		expect(recordOf().filter((entry) => entry.id === chief.id && entry.origin === 'belt')).toEqual([]);
		expect(userOf(chief.id)).toMatchObject({ disabledAt: null });
	});

	it('test 39: a backup made after a delete, a disable and a demotion holds the record row for row as this server does, and no value of it is a password hash', async () => {
		const x = holding('xavier');
		const bob = makeUser({ username: 'bob' });
		const ada = makeUser({ username: 'ada', role: 'admin' });
		expect((await api('POST', `/api/users/${x.id}/disable`, stepUp(chief))).status).toBe(200);
		expect((await api('DELETE', `/api/users/${x.id}`, stepUp(chief))).status).toBe(200);
		expect((await api('POST', `/api/users/${bob.id}/disable`, stepUp(chief))).status).toBe(200);
		expect((await api('PUT', `/api/users/${ada.id}`, stepUp(chief, { role: 'user' }))).status).toBe(200);
		const all = (database: Database.Database) => database.prepare('SELECT * FROM account_endings ORDER BY seq').all() as Record<string, unknown>[];

		const backup = opening(generateBackupData());

		expect(all(sqlite).map((entry) => entry.ending)).toEqual(['disabled', 'deleted', 'disabled', 'role']);
		expect(all(backup)).toEqual(all(sqlite));
		const hashes = sqlite.prepare('SELECT password_hash FROM users').pluck().all() as string[];
		for (const entry of all(backup)) for (const value of Object.values(entry)) expect([...hashes, fixtureHashOf(x)]).not.toContain(value);
	});

	it('(o) (R15): importing the same backup again, with a row dated in the future, adds no row', () => {
		const backup = generateBackupData();
		const copy = opening(backup);
		row(owner.id, createdOf(owner.id), 'disabled', { at: '2099-01-01 09:00:00' }, copy);
		const bytes = Buffer.from(copy.serialize());

		expect(restoreFromBackup(sqlite, opening(bytes)).errors).toEqual([]);
		const once = recordOf();
		expect(once).toHaveLength(1);
		expect(restoreFromBackup(sqlite, opening(bytes)).errors).toEqual([]);
		expect(recordOf()).toEqual(once);
	});

	it('(p) (R21): no mail goes to the address of an account the record kept disabled: its notifications are off, and its address leaves the backup failure address', () => {
		const x = holding('xavier');
		sqlite
			.prepare("INSERT INTO settings (key, value) VALUES ('backup_config', ?)")
			.run(JSON.stringify({ schedule: 'disabled', destinations: [], notifyEmail: 'xavier@example.test, olga@example.test' }));
		const backup = opening(generateBackupData());
		deletedHere(x.id);

		expect(restoreFromBackup(sqlite, backup).errors).toEqual([]);
		// As the import does once the restore is committed.
		removeSettingsOfFormerAdministrators('restore');

		for (const pref of NOTIFICATION_PREFS) expect(shouldNotifyUser(x.id, pref.key), pref.key).toBe(false);
		expect(JSON.parse(sqlite.prepare("SELECT value FROM settings WHERE key = 'backup_config'").pluck().get() as string).notifyEmail).toBe('olga@example.test');
	});
});

describe('a restore never brings back a password replaced on this server (card 2997)', () => {
	const NONE = { here: 0, reset: 0, superadmin: 0, unsealed: 0, superadminGivenYours: 0, givenYoursWithoutFactor: 0, givenYoursMayEnrol: 0, emailGivenUp: 0 };
	/** The password an account changed to here since the backup, and a hash of it at bcrypt's lowest cost. */
	const NEW_PASSWORD = 'the new password of card 2997';
	const newHash = () => hashSync(NEW_PASSWORD, 4);
	/** A bcrypt-shaped string of its own for each `n`, for a hash a test writes by hand. */
	const hashLike = (n: number) => `$2b$04$${String(n).padStart(53, 'B')}`;
	const createdOf = (id: number) => sqlite.prepare('SELECT created_at FROM users WHERE id = ?').pluck().get(id) as string;
	const userOf = (id: number) =>
		sqlite.prepare('SELECT disabled_at AS disabledAt, password_hash AS passwordHash, mfa_password_enrol AS enrol FROM users WHERE id = ?').get(id) as
			| { disabledAt: string | null; passwordHash: string; enrol: number }
			| undefined;
	const recordOf = () =>
		sqlite.prepare('SELECT user_id AS id, account_created AS created, ending, role, credential, origin FROM account_endings ORDER BY seq').all() as {
			id: number;
			created: string;
			ending: string;
			role: string;
			credential: string;
			origin: string;
		}[];
	const keysOf = (id: number) => sqlite.prepare('SELECT id FROM api_keys WHERE user_id = ? ORDER BY id').pluck().all(id) as number[];
	/** A `password` row by hand, naming `hash` as replaced: slice S2 has no writer yet. */
	const passwordRow = (database: Database.Database, id: number, created: string, hash: string, opts: { origin?: string; at?: string } = {}) =>
		database
			.prepare("INSERT INTO account_endings (user_id, account_created, ending, role, credential, ended_at, stated_ended, origin) VALUES (?, ?, 'password', '', ?, ?, ?, ?)")
			.run(id, created, credentialOf(hash), opts.at ?? '2026-11-20 09:00:00', opts.at ?? '2026-11-20 09:00:00', opts.origin ?? 'here');
	/** The account's password changed here, as slice S2's own change will: the hash it held recorded as replaced, then the new one. */
	const changedHere = (id: number, hash: string) => {
		expect(inTransaction(() => recordPasswordReplaced(sqlite, id))).toBe(true);
		sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
	};
	/** The account gone from this server, by hand, with no row of the record: as a restore of a backup without it leaves it. */
	const goneHere = (id: number) => {
		sqlite.pragma('foreign_keys = OFF');
		try {
			for (const table of ['mfa_factors', 'mfa_recovery_codes', 'api_keys', 'report_schedules']) sqlite.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(id);
			sqlite.prepare('DELETE FROM users WHERE id = ?').run(id);
		} finally {
			sqlite.pragma('foreign_keys = ON');
		}
	};
	/** The start's password pass (R12), in its own transaction: what it counted, and the database left exactly as it was. */
	const startPassChangesNothing = (superadmins = 0) => {
		const before = snapshotDb();
		expect(inTransaction(() => endReplacedPasswordsPresent({ mail: false, because: 'a test of card 2997' }))).toEqual({ reset: 0, superadmin: superadmins });
		expectUnchanged(before, 'the start pass after the restore');
	};
	const refused = { type: 'failure', status: 400, error: 'Invalid username/email or password' };
	const answerOf = (res: Awaited<ReturnType<typeof passwordStep>>['res']) => ({ type: res.type, status: res.status, error: res.type === 'failure' ? res.data.error : null });
	let chief: SessionUser;

	beforeEach(() => {
		resetDb();
		resetAllRateLimits();
		startedSinceAlreadyOffHeld();
		chief = makeUser({ username: 'chief', role: 'superadmin' });
	});

	it.each([
		{ made: 'this server’s sealed backup', outside: 'keep' as const },
		{ made: 'this server’s sealed backup, as a working copy', outside: 'off' as const }
	])('(g) card 2997, the card’s test, on $made: the same account, its password changed here since, keeps this server’s; the old one is refused at sign-in, with leave to enrol on its password and no factor', async ({ outside }) => {
		const a = makeUser({ username: 'alma' });
		sqlite.prepare('UPDATE users SET mfa_password_enrol = 1 WHERE id = ?').run(a.id);
		openReleaseWindow();
		const backup = opening(generateBackupData());
		const mine = newHash();
		changedHere(a.id, mine);

		const result = restoreFromBackup(sqlite, backup, { outside });

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual({ ...NONE, here: 1 });
		// The same account keeps this server's leave to enrol; a working copy takes every account's (card 2769, CS5).
		expect(userOf(a.id)).toEqual({ disabledAt: null, passwordHash: mine, enrol: outside === 'keep' ? 1 : 0 });
		expect(sqlite.prepare('SELECT COUNT(*) FROM mfa_factors WHERE user_id = ?').pluck().get(a.id)).toBe(0);
		startPassChangesNothing();
		// The old password is refused as a wrong one, the leave to enrol on its password alone given again where a working
		// copy took it; the one set here goes on to the next step.
		sqlite.prepare('UPDATE users SET mfa_password_enrol = 1 WHERE id = ?').run(a.id);
		expect(answerOf((await passwordStep(a)).res)).toEqual(refused);
		expect((await passwordStep(a, { password: NEW_PASSWORD })).res.type).toBe('redirect');
	});

	it('(h) card 2997: an account not here and another holding its replaced hash both get a password nothing matches, stay enabled, and their keys are ended and counted', () => {
		const a = makeUser({ username: 'alma' });
		const b = makeUser({ username: 'bea' });
		const keys = [makeApiKeyRow(a).id, makeApiKeyRow(b).id];
		sqlite.prepare('UPDATE users SET mfa_password_enrol = 1, password_hash = ? WHERE id = ?').run(fixtureHashOf(a), b.id);
		sqlite.prepare('UPDATE users SET mfa_password_enrol = 1 WHERE id = ?').run(a.id);
		const backup = opening(generateBackupData());
		// A's password replaced here, then A and B gone, with no row of card 2996's that names either.
		changedHere(a.id, newHash());
		goneHere(a.id);
		goneHere(b.id);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.accountsKept).toEqual({ deleted: 0, beforeRecord: 0, disabled: 0, lowered: 0 });
		expect(result.passwordsKept).toEqual({ ...NONE, reset: 2 });
		for (const id of [a.id, b.id]) {
			expect(userOf(id), `user ${id}`).toEqual({ disabledAt: null, passwordHash: DUMMY_HASH, enrol: 0 });
			expect(keysOf(id)).toEqual([]);
		}
		expect(result.apiKeysLeftOut).toMatchObject({ count: 2, keyIds: keys });
		for (const key of keys) expect(sqlite.prepare('SELECT revoked_because FROM api_key_revocations WHERE key_id = ?').pluck().get(key)).toBe('access ended');
		startPassChangesNothing();
	});

	it('(i) card 2997: the same account here whose hash here is recorded replaced too gets a password nothing matches, not this server’s', () => {
		const a = makeUser({ username: 'alma' });
		const backup = opening(generateBackupData());
		const mine = newHash();
		changedHere(a.id, mine);
		passwordRow(sqlite, a.id, createdOf(a.id), mine);
		// Its leave to enrol on its password here, which the same account would keep.
		sqlite.prepare('UPDATE users SET mfa_password_enrol = 1 WHERE id = ?').run(a.id);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual({ ...NONE, reset: 1 });
		expect(userOf(a.id)).toEqual({ disabledAt: null, passwordHash: DUMMY_HASH, enrol: 0 });
	});

	it('(j) card 2997, contract: a backup hash the record does not name is restored as the backup has it, and nothing is counted', () => {
		const a = makeUser({ username: 'alma' });
		const backup = opening(generateBackupData());
		// Changed here with no row: as before this card, or an account whose newer backup is being restored.
		sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash(), a.id);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual(NONE);
		expect(userOf(a.id)).toMatchObject({ passwordHash: fixtureHashOf(a) });
	});

	it('(k) card 2997: a superadmin not the same here, its backup hash named by its exact row here, is left as the backup has it and counted; a backup’s password rows naming superadmins are carried and change nothing', () => {
		const sam = makeUser({ username: 'sam', role: 'superadmin' });
		const backup = opening(generateBackupData());
		const samCreated = createdOf(sam.id);
		// R7: the backup's own rows on Sam's old hash and on the chief's current one.
		passwordRow(backup, sam.id, samCreated, hashLike(1));
		passwordRow(backup, chief.id, createdOf(chief.id), fixtureHashOf(chief));
		// Sealed again, as this server's own backup of a database holding them: card 3009 gives a superadmin not here of a
		// backup whose seal did not verify a password nothing matches.
		sealCopy(backup, backupSealKey(sqlite));
		// This server's own exact row on Sam's hash, then Sam gone.
		expect(inTransaction(() => recordPasswordReplaced(sqlite, sam.id))).toBe(true);
		goneHere(sam.id);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual({ ...NONE, superadmin: 1 });
		expect(userOf(sam.id)).toEqual({ disabledAt: null, passwordHash: fixtureHashOf(sam), enrol: 0 });
		expect(userOf(chief.id)).toMatchObject({ disabledAt: null, passwordHash: fixtureHashOf(chief) });
		expect(recordOf().filter((entry) => entry.origin === 'backup')).toEqual([
			{ id: sam.id, created: samCreated, ending: 'password', role: '', credential: credentialOf(hashLike(1)), origin: 'backup' },
			{ id: chief.id, created: createdOf(chief.id), ending: 'password', role: '', credential: credentialOf(fixtureHashOf(chief)), origin: 'backup' }
		]);
		// Sam is named by its own row at every run, and never touched.
		startPassChangesNothing(1);
	});

	it('(l) card 2997, N1: an account card 2996 rules before record gets a belt of the hash it held; given a new password here, the same backup gives it that one; gone from here, a password nothing matches', () => {
		const y = makeUser({ username: 'yolanda' });
		const backup = generateBackupData();
		const yCreated = createdOf(y.id);
		goneHere(y.id);
		const seeded = stamp();
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (?, '', 'watermark', ?), (?, '', 'deleted', ?)").run(y.id + 5, seeded, y.id, seeded);

		const first = restoreFromBackup(sqlite, opening(backup));

		expect(first.errors).toEqual([]);
		expect(first.accountsKept).toMatchObject({ beforeRecord: 1 });
		expect(first.passwordsKept).toEqual(NONE);
		expect(userOf(y.id)).toMatchObject({ passwordHash: DUMMY_HASH, disabledAt: expect.any(String) });
		expect(recordOf().filter((entry) => entry.id === y.id && entry.ending === 'password')).toEqual([
			{ id: y.id, created: yCreated, ending: 'password', role: '', credential: credentialOf(fixtureHashOf(y)), origin: 'belt' }
		]);

		// The superadmin enables it and sets a new password (as slice 2 of card 2996 stands in for the enable).
		const mine = newHash();
		sqlite.prepare('UPDATE users SET disabled_at = NULL, disabled_by = NULL, password_hash = ? WHERE id = ?').run(mine, y.id);
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (?, ?, 'enabled', ?)").run(y.id, yCreated, stamp());
		const second = restoreFromBackup(sqlite, opening(backup));

		expect(second.errors).toEqual([]);
		expect(second.passwordsKept).toEqual({ ...NONE, here: 1 });
		expect(userOf(y.id)).toMatchObject({ disabledAt: null, passwordHash: mine });

		// Not here at all: the backup's hash is still caught by the belt.
		goneHere(y.id);
		const third = restoreFromBackup(sqlite, opening(backup));

		expect(third.errors).toEqual([]);
		expect(third.passwordsKept).toEqual({ ...NONE, reset: 1 });
		expect(userOf(y.id)).toMatchObject({ disabledAt: null, passwordHash: DUMMY_HASH, enrol: 0 });
	});

	it('(l2) card 2997, code review FP5: N1’s belt is written once, at the restore’s moment: the same backup imported again adds no belt row', () => {
		const x = makeUser({ username: 'xavier' });
		const y = makeUser({ username: 'yolanda' });
		const backup = generateBackupData();
		const [xCreated, yCreated] = [createdOf(x.id), createdOf(y.id)];
		// X deleted here since (an exact deleted row, ruled deleted at every import); Y named by a seed row (before record).
		goneHere(x.id);
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, credential, ended_at) VALUES (?, ?, 'deleted', ?, ?)").run(x.id, xCreated, credentialOf(fixtureHashOf(x)), stamp());
		goneHere(y.id);
		const seeded = stamp();
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (?, '', 'watermark', ?), (?, '', 'deleted', ?)").run(y.id + 5, seeded, y.id, seeded);
		// The clock moves an hour on as Y's disable belt is written: N1's belt after it is stamped with the restore's moment,
		// as that belt is, not with the time it is written (NF3).
		vi.useFakeTimers({ toFake: ['Date'] });
		onTestFinished(() => {
			sqlite.exec('DROP TRIGGER IF EXISTS temp.clock_2997');
			vi.useRealTimers();
		});
		sqlite.function('advance_clock_2997', () => {
			vi.setSystemTime(Date.now() + 3_600_000);
			return null;
		});
		sqlite.exec("CREATE TEMP TRIGGER clock_2997 AFTER INSERT ON account_endings WHEN NEW.ending = 'disabled' BEGIN SELECT advance_clock_2997(); END");
		const beltsOf = (id: number) =>
			sqlite.prepare("SELECT ending, ended_at AS endedAt FROM account_endings WHERE user_id = ? AND origin = 'belt' ORDER BY seq").all(id) as { ending: string; endedAt: string }[];

		const first = restoreFromBackup(sqlite, opening(backup));

		expect(first.errors).toEqual([]);
		expect(first.accountsKept).toMatchObject({ deleted: 1, beforeRecord: 1 });
		const yBelts = beltsOf(y.id);
		expect(yBelts.map((belt) => belt.ending)).toEqual(['disabled', 'password']);
		expect(yBelts[1].endedAt).toBe(yBelts[0].endedAt);
		const once = recordOf().filter((entry) => entry.ending === 'password');
		expect(once).toEqual([
			{ id: x.id, created: xCreated, ending: 'password', role: '', credential: credentialOf(fixtureHashOf(x)), origin: 'belt' },
			{ id: y.id, created: yCreated, ending: 'password', role: '', credential: credentialOf(fixtureHashOf(y)), origin: 'belt' }
		]);

		const again = restoreFromBackup(sqlite, opening(backup));

		expect(again.errors).toEqual([]);
		expect(again.accountsKept).toMatchObject({ deleted: 1 });
		expect(recordOf().filter((entry) => entry.ending === 'password')).toEqual(once);
		expect(userOf(x.id)).toMatchObject({ passwordHash: DUMMY_HASH });
	});

	it('(m) card 2997: the backup’s password rows are taken as a backup’s, and the same backup again adds none; a newer backup’s row catches an older backup’s hash', () => {
		const a = makeUser({ username: 'alma' });
		const copy = opening(generateBackupData());
		passwordRow(copy, a.id, createdOf(a.id), hashLike(2));
		const bytes = Buffer.from(copy.serialize());

		expect(restoreFromBackup(sqlite, opening(bytes)).errors).toEqual([]);
		const once = recordOf();
		expect(once).toEqual([{ id: a.id, created: createdOf(a.id), ending: 'password', role: '', credential: credentialOf(hashLike(2)), origin: 'backup' }]);
		expect(restoreFromBackup(sqlite, opening(bytes)).errors).toEqual([]);
		expect(recordOf()).toEqual(once);

		// The chain: B0 holds A's first hash; A changes its password; B2 holds the row; a server without the row takes B2,
		// then B0.
		sqlite.exec('DELETE FROM account_endings');
		const b0 = generateBackupData();
		const mine = newHash();
		changedHere(a.id, mine);
		const b2 = generateBackupData();
		sqlite.exec('DELETE FROM account_endings');

		const fromB2 = restoreFromBackup(sqlite, opening(b2));
		expect(fromB2.errors).toEqual([]);
		expect(fromB2.passwordsKept).toEqual(NONE);
		expect(recordOf()).toEqual([{ id: a.id, created: createdOf(a.id), ending: 'password', role: '', credential: credentialOf(fixtureHashOf(a)), origin: 'backup' }]);
		const fromB0 = restoreFromBackup(sqlite, opening(b0));

		expect(fromB0.errors).toEqual([]);
		expect(fromB0.passwordsKept).toEqual({ ...NONE, here: 1 });
		expect(userOf(a.id)).toMatchObject({ passwordHash: mine });
	});

	it('(n) card 2997: a password row with no fingerprint, one that is not hex, no creation time, or a role is left out and counted in the one line, quoting nothing; password rows are not among the 100 for one account', () => {
		const a = makeUser({ username: 'alma' });
		const aCreated = createdOf(a.id);
		const backup = opening(generateBackupData());
		const put = backup.prepare('INSERT INTO account_endings (user_id, account_created, ending, role, credential, ended_at) VALUES (?, ?, ?, ?, ?, ?)');
		put.run(a.id, aCreated, 'password', '', '', '2026-11-20 09:00:00');
		put.run(a.id, aCreated, 'password', '', 'not-hex-2997', '2026-11-20 09:00:00');
		put.run(a.id, '', 'password', '', credentialOf(hashLike(3)), '2026-11-20 09:00:00');
		put.run(a.id, aCreated, 'password', 'boss-2997', credentialOf(hashLike(4)), '2026-11-20 09:00:00');

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([
			"4 row(s) of the backup's record of account endings were left out, as they can name no account here: 2 with a fingerprint that is not one the ending can have, " +
				"1 with a creation time that is not one the ending can have, 1 with a role that is neither user nor admin. The rest of the record was added to this server's."
		]);
		for (const quoted of ['not-hex-2997', 'boss-2997']) expect(result.errors.join(' ')).not.toContain(quoted);
		expect(recordOf()).toEqual([]);

		// 101 password rows for one account, beside a disable of it: the record is taken whole.
		const many = opening(generateBackupData());
		many.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 101) INSERT INTO account_endings (user_id, account_created, ending, credential, ended_at) ` +
				`SELECT ${a.id}, '${aCreated}', 'password', printf('%064x', i), '2026-11-20 09:00:00' FROM n`
		);
		many.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (?, ?, 'disabled', '2026-11-20 09:00:00')").run(a.id, aCreated);

		const taken = restoreFromBackup(sqlite, many);

		expect(taken.errors).toEqual([]);
		expect(taken.accountRecordLeftOut).toBe(0);
		expect(recordOf().filter((entry) => entry.ending === 'password')).toHaveLength(101);
		expect(taken.accountsKept).toMatchObject({ disabled: 1 });
	});

	it('(o) card 2997: a password step that cannot write is rolled back, and nothing is changed', () => {
		const a = makeUser({ username: 'alma' });
		const backup = opening(generateBackupData());
		changedHere(a.id, newHash());
		const before = snapshotDb();
		sqlite.exec(
			"CREATE TEMP TRIGGER refuse_2997 BEFORE UPDATE ON users WHEN NEW.password_hash IS NOT OLD.password_hash BEGIN SELECT RAISE(ABORT, 'refused by case o'); END"
		);
		try {
			let thrown: unknown = null;
			try {
				restoreFromBackup(sqlite, backup);
			} catch (e) {
				thrown = e;
			}
			expect(thrown).toBeInstanceOf(RestoreError);
			expect((thrown as RestoreError).committed).toBe(false);
			expect((thrown as RestoreError).message).toContain('refused by case o');
			expectUnchanged(before);
		} finally {
			sqlite.exec('DROP TRIGGER IF EXISTS temp.refuse_2997');
		}
	});

	it('(ee) card 2997, R2: a backup whose seal does not verify, holding a fresh hash of the same account’s old password, does not replace this server’s', async () => {
		const a = makeUser({ username: 'alma' });
		const copy = opening(Buffer.from(sqlite.serialize()));
		// Not the hash the record names: a new one of the same old password.
		copy.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSync(FIXTURE_PASSWORD, 4), a.id);
		const mine = newHash();
		changedHere(a.id, mine);

		const result = restoreFromBackup(sqlite, copy);

		expect(result.sealVerified).toBe(false);
		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual({ ...NONE, here: 1 });
		expect(userOf(a.id)).toMatchObject({ passwordHash: mine });
		expect(userOf(chief.id)).toMatchObject({ passwordHash: fixtureHashOf(chief) });
		expect(answerOf((await passwordStep(a)).res)).toEqual(refused);
	});

	it.each([
		{ importer: true, kept: { ...NONE, reset: 1 }, hash: () => DUMMY_HASH },
		{ importer: false, kept: { ...NONE, superadmin: 1 }, hash: (sam: SessionUser) => fixtureHashOf(sam) }
	])('(hh) card 2997, R9: a backup superadmin not the same here, with a replaced hash, where the importer given is $importer', ({ importer, kept, hash }) => {
		const sam = makeUser({ username: 'sam', role: 'superadmin' });
		const key = makeApiKeyRow(sam).id;
		const backup = opening(generateBackupData());
		expect(inTransaction(() => recordPasswordReplaced(sqlite, sam.id))).toBe(true);
		goneHere(sam.id);

		const result = restoreFromBackup(sqlite, backup, importer ? { importer: chief.id } : {});

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual(kept);
		expect(userOf(sam.id)).toMatchObject({ disabledAt: null, passwordHash: hash(sam) });
		// The importer holds this server's own password either way, and can sign in as the superadmin.
		expect(userOf(chief.id)).toMatchObject({ disabledAt: null, passwordHash: fixtureHashOf(chief) });
		expect(keysOf(sam.id)).toEqual(importer ? [] : [key]);
	});

	it.each([
		{ importer: true, kept: { ...NONE, here: 1, reset: 1 }, dummy: true },
		{ importer: false, kept: { ...NONE, here: 1 }, dummy: false }
	])('(hh2) card 2997, code review FP7: a backup superadmin not here, holding under its own id a hash replaced here on another account, where the importer given is $importer', ({ importer, kept, dummy }) => {
		const ann = makeUser({ username: 'ann' });
		const sam = makeUser({ username: 'sam', role: 'superadmin' });
		const annOld = fixtureHashOf(ann);
		sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(annOld, sam.id);
		const backup = opening(generateBackupData());
		goneHere(sam.id);
		// Ann's password changed here: a `here` row of Ann's, which names that hash for anyone but a superadmin.
		changedHere(ann.id, newHash());
		expect(passwordReplacedHere(sqlite, { id: sam.id, createdAt: '2020-01-01 00:00:00', role: 'superadmin', passwordHash: annOld })).toBe(false);

		const result = restoreFromBackup(sqlite, backup, importer ? { importer: chief.id } : {});

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual(kept);
		// With the importer able to sign in as the superadmin, Sam is asked about as anyone else is, and the row names it.
		expect(userOf(sam.id)).toMatchObject({ disabledAt: null, passwordHash: dummy ? DUMMY_HASH : annOld });
		expect(userOf(chief.id)).toMatchObject({ disabledAt: null, passwordHash: fixtureHashOf(chief) });
	});

	it.each([
		{
			importer: 'not the same account here (made at another moment than the backup’s)',
			// This server's chief made at another moment than the backup's: the restored chief is another account.
			setUp: () => sqlite.prepare("UPDATE users SET created_at = '2020-01-01 00:00:00' WHERE id = ?").run(chief.id),
			kept: { ...NONE, superadmin: 1 }
		},
		{
			importer: 'the same account, with no usable password here (its hash recorded as replaced)',
			// As a host file rollback leaves it: the chief holds a hash this server's own exact row names, here and in the
			// backup, so that the chief is counted too (rule 4: kept, and counted superadmin).
			setUp: () => expect(inTransaction(() => recordPasswordReplaced(sqlite, chief.id))).toBe(true),
			kept: { ...NONE, superadmin: 2 }
		}
	])('(hh3) card 2997, code review FP4: a backup superadmin not here, with a replaced hash, is left as the backup has it where the importer given is $importer', ({ setUp, kept }) => {
		const sam = makeUser({ username: 'sam', role: 'superadmin' });
		const key = makeApiKeyRow(sam).id;
		const backup = opening(generateBackupData());
		expect(inTransaction(() => recordPasswordReplaced(sqlite, sam.id))).toBe(true);
		goneHere(sam.id);
		setUp();

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual(kept);
		// Nobody could sign in as the superadmin with this server's password: Sam keeps the backup's, and its key.
		expect(userOf(sam.id)).toEqual({ disabledAt: null, passwordHash: fixtureHashOf(sam), enrol: 0 });
		expect(keysOf(sam.id)).toEqual([key]);
		expect(userOf(chief.id)).toMatchObject({ disabledAt: null, passwordHash: fixtureHashOf(chief) });
	});

	it('(ee2) card 2997, code review FP6: the hash an unsealed backup gives the same account here, which R2 discards, is recorded; with the account gone, the same backup does not give it back', () => {
		const a = makeUser({ username: 'alma' });
		const copy = opening(Buffer.from(sqlite.serialize()));
		// A hash of A's in the backup that this server never recorded: a fresh one.
		const fresh = hashSync('a password of the forged copy', 4);
		copy.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(fresh, a.id);
		const bytes = Buffer.from(copy.serialize());

		const first = restoreFromBackup(sqlite, opening(bytes));

		expect(first.sealVerified).toBe(false);
		expect(first.errors).toEqual([]);
		expect(first.passwordsKept).toEqual({ ...NONE, here: 1 });
		expect(userOf(a.id)).toMatchObject({ passwordHash: fixtureHashOf(a) });
		expect(recordOf().filter((entry) => entry.ending === 'password')).toEqual([
			{ id: a.id, created: createdOf(a.id), ending: 'password', role: '', credential: credentialOf(fresh), origin: 'belt' }
		]);

		// A gone from this server, then the same backup again, sealed here so that the belt alone decides (card 3009's
		// code review, FP11): its hash is caught by the belt. Card 3009's own rule for it unsealed is the next case.
		goneHere(a.id);
		const sealedAgain = opening(bytes);
		sealCopy(sealedAgain, backupSealKey(sqlite));
		const again = restoreFromBackup(sqlite, sealedAgain);

		expect(again.sealVerified).toBe(true);
		expect(again.errors).toEqual([]);
		expect(again.passwordsKept).toEqual({ ...NONE, reset: 1 });
		expect(userOf(a.id)).toMatchObject({ disabledAt: null, passwordHash: DUMMY_HASH, enrol: 0 });
		expect(recordOf().filter((entry) => entry.ending === 'password')).toHaveLength(1);
	});

	it('(ee2b) card 3009 (FP11): the same unsealed backup again, A gone from this server: not the same account here, so its hash is not taken, counted unsealed, before the belt is asked', () => {
		const a = makeUser({ username: 'alma' });
		const copy = opening(Buffer.from(sqlite.serialize()));
		const fresh = hashSync('a password of the forged copy', 4);
		copy.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(fresh, a.id);
		const bytes = Buffer.from(copy.serialize());
		expect(restoreFromBackup(sqlite, opening(bytes)).passwordsKept).toEqual({ ...NONE, here: 1 });
		goneHere(a.id);

		const again = restoreFromBackup(sqlite, opening(bytes));

		expect(again.sealVerified).toBe(false);
		expect(again.errors).toEqual([]);
		expect(again.passwordsKept).toEqual({ ...NONE, unsealed: 1 });
		expect(userOf(a.id)).toMatchObject({ disabledAt: null, passwordHash: DUMMY_HASH, enrol: 0 });
	});

	it('(ii) card 2997, R10: this server’s superadmin’s replaced hash, held in the backup by an administrator under another id, is kept out of use; the start pass and the matcher agree', async () => {
		const ada = makeUser({ username: 'ada', role: 'admin' });
		sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(fixtureHashOf(chief), ada.id);
		const backup = opening(generateBackupData());
		const adaCreated = createdOf(ada.id);
		goneHere(ada.id);
		const mine = newHash();
		changedHere(chief.id, mine);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual({ ...NONE, here: 1, reset: 1 });
		expect(userOf(ada.id)).toEqual({ disabledAt: null, passwordHash: DUMMY_HASH, enrol: 0 });
		expect(userOf(chief.id)).toMatchObject({ disabledAt: null, passwordHash: mine });
		startPassChangesNothing();
		// By its role: an administrator holding that hash is named by the superadmin's row; a superadmin would not be.
		const held = { id: ada.id, createdAt: adaCreated, passwordHash: fixtureHashOf(chief) };
		expect(passwordReplacedHere(sqlite, { ...held, role: 'admin' })).toBe(true);
		expect(passwordReplacedHere(sqlite, { ...held, role: 'superadmin' })).toBe(false);
		expect(answerOf((await passwordStep(ada)).res)).toEqual(refused);
	});

	it.each([
		{ held: 'the hash its exact here row names: this server’s usable hash', recorded: true, replacedToo: false, kept: { ...NONE, here: 1 } },
		// Card 2996's FP2 (part 1's departure 2): a forged copy that lowers this server's superadmin, with a hash this
		// server never recorded, which R2 discards: still no belt on it.
		{ held: 'a hash this server never recorded: this server’s usable hash', recorded: false, replacedToo: false, kept: { ...NONE, here: 1 } },
		// Where this server's hash is replaced too, rule 4 keeps it for a superadmin, which card 3009's R2 keeps it.
		{ held: 'the hash its exact here row names, this server’s replaced too: this server’s hash, as a superadmin’s', recorded: true, replacedToo: true, kept: { ...NONE, superadmin: 1 } }
	])('(ii2) card 2997, R10 (code review, FP12): a backup that makes this server’s superadmin an administrator, holding $held, and no belt is written on it', ({ recorded, replacedToo, kept }) => {
		const sam = makeUser({ username: 'sam' });
		const copy = opening(Buffer.from(sqlite.serialize()));
		// The same account, its id and creation time, an administrator in the copy (which is no sealed backup), and Sam
		// its superadmin: a restore leaves a superadmin.
		copy.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(chief.id);
		copy.prepare("UPDATE users SET role = 'superadmin' WHERE id = ?").run(sam.id);
		let mine = fixtureHashOf(chief);
		if (recorded) changedHere(chief.id, (mine = newHash()));
		else copy.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSync('a password of the forged copy', 4), chief.id);
		if (replacedToo) expect(inTransaction(() => recordPasswordReplaced(sqlite, chief.id))).toBe(true);
		const record = recordOf();

		const result = restoreFromBackup(sqlite, copy);

		expect(result.sealVerified).toBe(false);
		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual(kept);
		expect(userOf(chief.id)).toMatchObject({ disabledAt: null, passwordHash: mine });
		// Card 2996 keeps no role for this server's superadmin (it records none), but the backup's seal did not verify, so
		// card 3009's R2 keeps it the superadmin, as the same account here.
		expect(sqlite.prepare('SELECT role FROM users WHERE id = ?').pluck().get(chief.id)).toBe('superadmin');
		// No row on this server's superadmin (card 2996's FP2): the record is as it was before the restore.
		expect(recordOf()).toEqual(record);
	});

	it('(ee3) card 2997, R2 and R6 (code review, FP12): a backup whose seal does not verify, holding another hash for the same-account superadmin: this server’s hash is kept, counted here, and no belt is written for it', () => {
		const copy = opening(Buffer.from(sqlite.serialize()));
		const fresh = hashSync('a password of the forged copy', 4);
		copy.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(fresh, chief.id);

		const result = restoreFromBackup(sqlite, copy);

		expect(result.sealVerified).toBe(false);
		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual({ ...NONE, here: 1 });
		expect(userOf(chief.id)).toMatchObject({ disabledAt: null, passwordHash: fixtureHashOf(chief) });
		expect(recordOf()).toEqual([]);
	});

	it.each([
		{ also: 'usable', replacedToo: false, kept: { ...NONE, here: 1 } },
		{ also: 'replaced too', replacedToo: true, kept: { ...NONE, superadmin: 1 } }
	])('(jj) card 2997, R12: the same-account superadmin, its password changed here since and this server’s hash $also, keeps this server’s hash', ({ replacedToo, kept }) => {
		const backup = opening(generateBackupData());
		const mine = newHash();
		changedHere(chief.id, mine);
		if (replacedToo) expect(inTransaction(() => recordPasswordReplaced(sqlite, chief.id))).toBe(true);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual(kept);
		expect(userOf(chief.id)).toMatchObject({ disabledAt: null, passwordHash: mine });
	});

	it('(kk) card 2997, R11: the same account here holding a password nothing matches, its backup hash replaced, gets that one and is counted reset', () => {
		const a = makeUser({ username: 'alma' });
		const backup = opening(generateBackupData());
		changedHere(a.id, DUMMY_HASH);
		sqlite.prepare('UPDATE users SET mfa_password_enrol = 1 WHERE id = ?').run(a.id);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual({ ...NONE, reset: 1 });
		expect(userOf(a.id)).toEqual({ disabledAt: null, passwordHash: DUMMY_HASH, enrol: 0 });
	});
});

// ─── Card 3009: the fixtures its describe blocks share (its code review, FP15) ───

/** Another installation's id, as a backup made elsewhere carries it. */
const OTHER_ID = 'ab'.repeat(16);
/** This server's own backup, opened to be edited: any edit leaves a seal that does not verify, and `edited` makes one. */
const ownBackup = (opts: { edited?: boolean } = {}) => {
	const backup = opening(generateBackupData());
	if (opts.edited === true) backup.prepare("UPDATE boards SET name = 'edited since' WHERE id = (SELECT min(id) FROM boards)").run();
	return backup;
};
/** `backup` carrying another installation's id: none of its accounts is the same account here. */
const fromElsewhere = (backup: Database.Database) => {
	backup.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(INSTALLATION_ID, OTHER_ID);
	return backup;
};

// ─── Card 3009: the installation id, and the same account here ──────────────

describe('the installation id, and the same account here (card 3009, slice 1)', () => {
	const ID_FORM = /^[0-9a-f]{32}$/;
	const installationIn = (database: Database.Database) => column<string>(database, `SELECT value FROM settings WHERE key = '${INSTALLATION_ID}'`);

	it('(a) ensureInstallationId makes one 32-hex id once and answers it again; a backup carries it under its seal, and editing it makes the seal fail (R6)', () => {
		expect(installationIdHere(sqlite)).toBeNull();

		// A first backup before any start made one: withoutSecrets' default makes it here, and writes it into the copy,
		// which was taken from the running database before it was made.
		const backup = opening(generateBackupData());

		const made = installationIdHere(sqlite)!;
		expect(made).toMatch(ID_FORM);
		expect(installationIn(backup)).toEqual([made]);
		// Made once: answered again, and never replaced.
		expect(ensureInstallationId(sqlite)).toBe(made);
		expect(ensureInstallationId(sqlite)).toBe(made);
		expect(installationIn(sqlite)).toEqual([made]);
		const key = sealKeyHere(sqlite)!.key;
		expect(sealVerifies(backup, key)).toBe(true);
		backup.prepare('UPDATE settings SET value = ? WHERE key = ?').run(OTHER_ID, INSTALLATION_ID);
		expect(sealVerifies(backup, key)).toBe(false);
		expect(installationIn(sqlite)).toEqual([made]);
	});

	it("(b) a restore of a file carrying another installation's id leaves this server's id as it was (R6)", () => {
		const live = migratedDb();
		live.exec(`INSERT INTO users (id, username, email, password_hash, role) VALUES (9, 'here', 'here@example.test', 'x', 'superadmin')`);
		const mine = ensureInstallationId(live);
		const backup = fromElsewhere(backupWithSignIns());

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		expect(result.installation).toBe('other');
		expect(installationIn(live)).toEqual([mine]);
		expect(installationIdHere(live)).toBe(mine);
	});

	it('(c) a server with no id, restoring a file that carries one: no id is made and none kept, and the verdict is other (R6)', () => {
		const live = migratedDb();
		live.exec(`INSERT INTO users (id, username, email, password_hash, role) VALUES (9, 'here', 'here@example.test', 'x', 'superadmin')`);
		expect(installationIdHere(live)).toBeNull();
		const backup = fromElsewhere(backupWithSignIns());

		const result = restoreFromBackup(live, backup);

		expect(result.errors).toEqual([]);
		expect(result.installation).toBe('other');
		expect(installationIn(live)).toEqual([]);
	});

	/** An account here, and the trusts a restore can hold. */
	const HERE = { createdAt: '2026-11-01 10:00:00', username: 'nina' };
	const trust = (sealVerified: boolean, installation: GrantTrust['installation']): GrantTrust => ({ sealVerified, installation });
	/** A backup's settings table with no key on it, so that it can hold any rows a file can. */
	const settingsOnly = (...values: string[]) => {
		const backup = new Database(':memory:');
		opened.push(backup);
		backup.exec('CREATE TABLE settings (key TEXT, value TEXT)');
		for (const value of values) backup.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(INSTALLATION_ID, value);
		return backup;
	};

	it.each([
		{
			row: 'sealed, the same moment, renamed and carrying another id: the same account',
			got: () => sameAccountHere(HERE, { createdAt: HERE.createdAt, username: 'renamed' }, trust(true, 'other')),
			expected: true
		},
		{
			row: "unsealed, this installation's id, renamed, the moment in another form: the same account",
			got: () => sameAccountHere(HERE, { createdAt: '2026-11-01T10:00:00.000Z', username: 'renamed' }, trust(false, 'this')),
			expected: true
		},
		{
			row: "unsealed, another installation's id, every field the same: not the same account",
			got: () => sameAccountHere(HERE, { ...HERE }, trust(false, 'other')),
			expected: false
		},
		{
			row: 'unsealed, no id, the same username: the same account',
			got: () => sameAccountHere(HERE, { ...HERE }, trust(false, 'none')),
			expected: true
		},
		{
			row: 'unsealed, no id, renamed: not the same account',
			got: () => sameAccountHere(HERE, { createdAt: HERE.createdAt, username: 'Nina' }, trust(false, 'none')),
			expected: false
		},
		{
			row: 'the creation time a second apart, or no account of that id here, sealed: not the same account',
			got: () => [
				sameAccountHere(HERE, { createdAt: '2026-11-01 10:00:01', username: HERE.username }, trust(true, 'this')),
				sameAccountHere(undefined, { ...HERE }, trust(true, 'this'))
			],
			expected: [false, false]
		},
		{
			row: "installationOf: a malformed id, or this server's id in two rows, read as other",
			got: () => {
				const here = 'cd'.repeat(16);
				return [installationOf(settingsOnly(here.toUpperCase()), here), installationOf(settingsOnly(here, here), here), installationOf(settingsOnly(here), here)];
			},
			expected: ['other', 'other', 'this']
		}
	])('(d) $row', ({ got, expected }) => {
		expect(got()).toEqual(expected);
	});

	it("(e2) an unsealed import's second-factor sentence counts the accounts not the same here and names none; a sealed one names them as before (R10)", () => {
		const bytes = generateBackupData();

		// Sealed: the accounts with no factor named, as before card 3009.
		const sealed = restoreFromBackup(sqlite, opening(bytes));
		expect(sealed.sealVerified).toBe(true);
		const sealedSaid = mfaWithoutFactorSentence(sealed.mfa)!;
		expect(sealedSaid).toContain(': administrator, member.');
		expect(sealed.mfa.notSameHere).toBe(0);

		// Unsealed, from another installation: no account is the same here, so none is named.
		const unsealed = restoreFromBackup(sqlite, fromElsewhere(opening(bytes)));
		expect(unsealed.sealVerified).toBe(false);
		expect(unsealed.installation).toBe('other');
		expect(unsealed.mfa).toMatchObject({ withoutFactor: [], leftOut: [], leftOutBecause: 'unsealed', notSameHere: 3 });
		const said = mfaWithoutFactorSentence(unsealed.mfa)!;
		expect(said).toContain('3 account(s) in the backup are not on this server as the same account and have no second factor');
		expect(said).toContain('Their second factors in the backup were left out because the backup was not made by this server, or was changed after it was made.');
		for (const name of ['chief', 'administrator', 'member']) expect(said).not.toContain(name);
	});
});

// ─── Card 3009: passwords from a backup whose seal did not verify ───────────

describe('an unsealed backup gives no account a password this server did not hold (card 3009, slice 2)', () => {
	const NONE = { here: 0, reset: 0, superadmin: 0, unsealed: 0, superadminGivenYours: 0, givenYoursWithoutFactor: 0, givenYoursMayEnrol: 0, emailGivenUp: 0 };
	/** A password whoever edited the file knows, and a hash of it at bcrypt's lowest cost. */
	const FILE_PASSWORD = 'a password the forger knows, card 3009';
	const fileHash = () => hashSync(FILE_PASSWORD, 4);
	const EARLIER = '2020-01-01 00:00:00';
	/** An account the file holds and this server never did, with an enabled report schedule. */
	const planted = (backup: Database.Database, id: number, role: string, opts: { hash?: string; disabled?: boolean } = {}) => {
		backup
			.prepare('INSERT INTO users (id, username, email, password_hash, role, disabled_at) VALUES (?, ?, ?, ?, ?, ?)')
			.run(id, `planted-${id}`, `planted-${id}@example.test`, opts.hash ?? fileHash(), role, opts.disabled ? '2026-11-01 09:00:00' : null);
		backup.prepare("INSERT INTO report_schedules (user_id, name, scope, enabled) VALUES (?, 'Weekly', 'all', 1)").run(id);
		return { id, username: `planted-${id}`, email: `planted-${id}@example.test` };
	};
	const userOf = (id: number) =>
		sqlite.prepare('SELECT disabled_at AS disabledAt, password_hash AS passwordHash, mfa_password_enrol AS enrol FROM users WHERE id = ?').get(id) as
			| { disabledAt: string | null; passwordHash: string; enrol: number }
			| undefined;
	const accountOf = (id: number) =>
		sqlite.prepare('SELECT role, email, disabled_at AS disabledAt, disabled_by AS disabledBy, password_hash AS passwordHash FROM users WHERE id = ?').get(id) as {
			role: string;
			email: string;
			disabledAt: string | null;
			disabledBy: number | null;
			passwordHash: string;
		};
	const schedulesOn = (id: number) => sqlite.prepare('SELECT enabled FROM report_schedules WHERE user_id = ? ORDER BY id').pluck().all(id) as number[];
	const refused = { type: 'failure', status: 400, error: 'Invalid username/email or password' };
	const answerOf = (res: Awaited<ReturnType<typeof passwordStep>>['res']) => ({ type: res.type, status: res.status, error: res.type === 'failure' ? res.data.error : null });

	beforeEach(() => {
		resetAllRateLimits();
	});

	it.each([
		{ made: 'as it is', outside: 'keep' as const },
		{ made: 'as a working copy', outside: 'off' as const }
	])('(g) the card’s test, $made: an administrator not here holding a hash of a known password gets one nothing matches, stays enabled, and that password is refused', async ({ outside }) => {
		const backup = ownBackup();
		const x = planted(backup, 90, 'admin');
		backup.prepare('UPDATE users SET mfa_password_enrol = 1 WHERE id = ?').run(x.id);

		const result = restoreFromBackup(sqlite, backup, { outside });

		expect(result.sealVerified).toBe(false);
		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual({ ...NONE, unsealed: 1 });
		expect(userOf(x.id)).toEqual({ disabledAt: null, passwordHash: DUMMY_HASH, enrol: 0 });
		// Its schedule paused where what reaches outside is kept; a working copy's switch-off finds it on, and counts it (R7).
		if (outside === 'keep') {
			expect(schedulesOn(x.id)).toEqual([0]);
		} else {
			expect(result.outside?.reportSchedules).toBe(1);
			expect(schedulesOn(x.id)).toEqual([0]);
		}
		expect(answerOf((await passwordStep(x, { password: FILE_PASSWORD })).res)).toEqual(refused);
	});

	it('(i) a collision: an unsealed backup from another installation whose account has this server’s account’s id and creation time, and its very hash, gets one nothing matches', () => {
		const backup = fromElsewhere(ownBackup());
		// The file holds this server's own hash for the member: the same id and creation time are not the same account.
		expect(column(backup, `SELECT password_hash FROM users WHERE id = ${member.id}`)).toEqual([fixtureHashOf(member)]);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.installation).toBe('other');
		expect(result.errors).toEqual([]);
		expect(userOf(member.id)).toMatchObject({ passwordHash: DUMMY_HASH, enrol: 0 });
		// The member and the administrator, and the superadmin with no importer (R3).
		expect(result.passwordsKept).toEqual({ ...NONE, unsealed: 3 });
	});

	it('(j) an unsealed backup with no installation id: an account with this server’s account’s id and creation time, renamed, gets one nothing matches', () => {
		const backup = ownBackup();
		backup.prepare('DELETE FROM settings WHERE key = ?').run(INSTALLATION_ID);
		backup.prepare("UPDATE users SET username = 'member-renamed' WHERE id = ?").run(member.id);

		const result = restoreFromBackup(sqlite, backup);

		expect(result.installation).toBe('none');
		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual({ ...NONE, unsealed: 1 });
		expect(userOf(member.id)).toMatchObject({ passwordHash: DUMMY_HASH });
		// The others, their usernames the same, are the same accounts, and keep this server's.
		expect(userOf(admin.id)).toMatchObject({ passwordHash: fixtureHashOf(admin) });
	});

	it.each([
		{ held: 'a value that is not bcrypt', value: 'not a bcrypt hash at all', unsealed: 1 },
		{ held: 'DUMMY_HASH already', value: DUMMY_HASH, unsealed: 0 }
	])('(k) an account not the same here holding $held: given DUMMY_HASH, counted only where it did not hold it', ({ value, unsealed }) => {
		const backup = ownBackup();
		const x = planted(backup, 90, 'user', { hash: value });

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual({ ...NONE, unsealed });
		expect(userOf(x.id)).toMatchObject({ disabledAt: null, passwordHash: DUMMY_HASH });
	});

	it('(l) the importer, the same account here and able to sign in: a superadmin of the file not here gets one nothing matches, counted; the importer signs in', async () => {
		const factor = stepUpFactor(chief);
		const backup = ownBackup();
		const sam = planted(backup, 90, 'superadmin');

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual({ ...NONE, unsealed: 1 });
		expect(userOf(sam.id)).toMatchObject({ disabledAt: null, passwordHash: DUMMY_HASH });
		expect(answerOf((await passwordStep(sam, { password: FILE_PASSWORD })).res)).toEqual(refused);
		expect((await signInFully(chief, factor)).session).toEqual(expect.any(String));
	});

	it('(m) a new host, through the route: the backup’s superadmin is given the importer’s password and authenticator, signs in with them, and the file’s password is refused', async () => {
		// The backup, from another installation: its superadmin, user 1, made earlier, holding a password the file knows.
		const backup = fromElsewhere(ownBackup());
		backup.prepare('UPDATE users SET created_at = ?, password_hash = ? WHERE id = ?').run(EARLIER, fileHash(), chief.id);
		// This server's importer, a superadmin with an authenticator, not in the backup.
		const newboss = makeUser({ username: 'newboss', role: 'superadmin' });
		const factor = giveFactor(newboss);
		await routeMethods('/api/admin/import');
		const dir = mkdtempSync(join(tmpdir(), 'dumpfire-import-'));
		tempDirs.push(dir);
		vi.spyOn(process, 'cwd').mockReturnValue(dir);
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await api('POST', '/api/admin/import?outside=keep', {
			user: newboss,
			headers: { 'content-type': 'application/octet-stream', ...importConfirmation(newboss) },
			body: backup.serialize()
		});

		expect(res.status, res.body.message).toBe(200);
		expect(res.body.passwordsKept).toMatchObject({ superadminGivenYours: 1 });
		const backupsSuperadmin = { username: 'chief' };
		expect(accountOf(chief.id)).toMatchObject({ role: 'superadmin', disabledAt: null, passwordHash: fixtureHashOf(newboss) });
		expect(answerOf((await passwordStep(backupsSuperadmin, { password: FILE_PASSWORD })).res)).toEqual(refused);
		// The importer's password, then a code from the importer's authenticator: signed in as the backup's superadmin.
		const { session } = await signInFully(backupsSuperadmin, factor);
		expect(sessionRow(session)?.userId).toBe(chief.id);
	});

	it.each([
		{ row: 'the lower-numbered one disabled: the enabled one is given the importer’s password', laterDisabled: false },
		{ row: 'every one disabled: none is given it, each gets one nothing matches (R3)', laterDisabled: true }
	])('(n) two superadmins of the file not here, the importer unable to sign in, $row', ({ laterDisabled }) => {
		stepUpFactor(chief);
		// Where every one is disabled, a superadmin of this server that is the same account in the file is what lets the
		// restore commit (an enabled superadmin must remain).
		const boss = laterDisabled ? makeUser({ username: 'boss', role: 'superadmin' }) : null;
		const backup = ownBackup();
		// The file's user 1, made earlier, is not this server's chief: the importer is not in the file. Disabled.
		backup.prepare('UPDATE users SET created_at = ?, password_hash = ?, disabled_at = ? WHERE id = ?').run(EARLIER, fileHash(), '2026-11-01 09:00:00', chief.id);
		const sam = planted(backup, 90, 'superadmin', { disabled: laterDisabled });

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.errors).toEqual([]);
		expect(userOf(chief.id)).toMatchObject({ passwordHash: DUMMY_HASH });
		if (laterDisabled) {
			expect(result.passwordsKept).toEqual({ ...NONE, unsealed: 2 });
			expect(userOf(sam.id)).toMatchObject({ passwordHash: DUMMY_HASH });
			expect(accountOf(boss!.id)).toMatchObject({ role: 'superadmin', disabledAt: null, passwordHash: fixtureHashOf(boss!) });
		} else {
			// The file's user 1 holds the importer's address, which the carried superadmin takes (the code review's FP5).
			expect(result.passwordsKept).toEqual({ ...NONE, unsealed: 1, superadminGivenYours: 1, emailGivenUp: 1 });
			expect(userOf(sam.id)).toMatchObject({ disabledAt: null, passwordHash: fixtureHashOf(chief) });
			// With the importer's authenticator, sealed again for it (R1).
			expect(sqlite.prepare('SELECT COUNT(*) FROM mfa_factors WHERE user_id = ?').pluck().get(sam.id)).toBe(1);
		}
	});

	it('(o) no importer given: a superadmin of an unsealed file not here gets one nothing matches (R3)', () => {
		const backup = ownBackup();
		const sam = planted(backup, 90, 'superadmin');

		const result = restoreFromBackup(sqlite, backup);

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual({ ...NONE, unsealed: 1 });
		expect(userOf(sam.id)).toMatchObject({ disabledAt: null, passwordHash: DUMMY_HASH });
	});

	it('(r) an account not the same here that card 2996 rules deleted is counted by card 2996 alone, not unsealed', () => {
		const x = makeUser({ username: 'xavier' });
		const xCreated = sqlite.prepare('SELECT created_at FROM users WHERE id = ?').pluck().get(x.id) as string;
		const backup = ownBackup();
		// Any edit: the seal does not verify.
		backup.prepare("UPDATE boards SET name = 'edited since' WHERE id = (SELECT min(id) FROM boards)").run();
		// X deleted here since, with the exact row card 2996 writes.
		sqlite.pragma('foreign_keys = OFF');
		try {
			sqlite.prepare('DELETE FROM users WHERE id = ?').run(x.id);
		} finally {
			sqlite.pragma('foreign_keys = ON');
		}
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, credential, ended_at) VALUES (?, ?, 'deleted', ?, ?)").run(x.id, xCreated, credentialOf(fixtureHashOf(x)), stamp());

		const result = restoreFromBackup(sqlite, backup);

		expect(result.sealVerified).toBe(false);
		expect(result.errors).toEqual([]);
		expect(result.accountsKept).toMatchObject({ deleted: 1 });
		expect(result.passwordsKept).toEqual(NONE);
		expect(userOf(x.id)).toMatchObject({ passwordHash: DUMMY_HASH, disabledAt: expect.any(String) });
	});

	it('(l2) an unsealed file that makes this server’s superadmin a disabled administrator: it is an enabled superadmin after, and nothing is carried (R2)', () => {
		const backup = ownBackup();
		backup.prepare("UPDATE users SET role = 'admin', disabled_at = ?, disabled_by = ? WHERE id = ?").run('2026-11-01 09:00:00', admin.id, chief.id);
		const sam = planted(backup, 90, 'superadmin');

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.errors).toEqual([]);
		expect(accountOf(chief.id)).toMatchObject({ role: 'superadmin', disabledAt: null, disabledBy: null, passwordHash: fixtureHashOf(chief) });
		expect(result.passwordsKept).toEqual({ ...NONE, unsealed: 1 });
		expect(userOf(sam.id)).toMatchObject({ passwordHash: DUMMY_HASH });
	});

	it.each([
		{ row: 'free: the carried superadmin takes it', holder: null },
		{ row: 'held by another restored account: the carried superadmin takes it all the same, and the holder gives it up (FP5)', holder: 'member' as const }
	])('(m2) the importer’s email, $row (R2)', ({ holder }) => {
		const backup = ownBackup();
		// The file's user 1, made earlier, is not this server's chief, and has an address of its own.
		backup.prepare("UPDATE users SET created_at = ?, email = 'file-boss@example.test' WHERE id = ?").run(EARLIER, chief.id);
		if (holder !== null) backup.prepare('UPDATE users SET email = ? WHERE id = ?').run(chief.email.toUpperCase(), member.id);

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toMatchObject({ superadminGivenYours: 1, emailGivenUp: holder === null ? 0 : 1 });
		// The code review's FP5: always the importer's, so the answer can point at it by that address.
		expect(accountOf(chief.id).email).toBe(chief.email);
		if (holder !== null) expect(accountOf(member.id).email).toBe(`email-given-up-${member.id}@restore.invalid`);
	});

	it('(p2) the importer in the file as the same account, unable to sign in: nothing is carried, and a superadmin of the file not here gets one nothing matches (R2)', () => {
		const backup = ownBackup();
		const sam = planted(backup, 90, 'superadmin');
		// The importer's password here recorded as replaced, as a host file rollback leaves it: it cannot sign in.
		expect(inTransaction(() => recordPasswordReplaced(sqlite, chief.id))).toBe(true);

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.errors).toEqual([]);
		// The importer kept as card 2997's rule 4 keeps a superadmin's, and counted so.
		expect(result.passwordsKept).toEqual({ ...NONE, superadmin: 1, unsealed: 1 });
		expect(userOf(sam.id)).toMatchObject({ passwordHash: DUMMY_HASH });
		expect(userOf(chief.id)).toMatchObject({ passwordHash: fixtureHashOf(chief) });
	});

	it.each([
		{
			row: 'with the importer’s authenticator carried',
			stubbed: false,
			said:
				"The backup's superadmin is not the account you imported with, and the backup's seal did not verify, so its password in the backup was " +
				'not taken: it was given the password you confirmed this import with, and your authenticators. Sign in as it, the superadmin that now ' +
				'holds your email address, with that password and a code from your authenticator, and change the password on the Account page if you wish.',
			words: ", giving the backup's superadmin the importing account's password. The system log",
			enrol: false
		},
		{
			row: 'with no authenticator carried, the host’s reset named',
			stubbed: true,
			said:
				"The backup's superadmin is not the account you imported with, and the backup's seal did not verify, so its password in the backup was " +
				'not taken: it was given the password you confirmed this import with, but none of your authenticators, as no MFA key is loaded or none ' +
				"of yours could be moved: it cannot sign in until the server's host resets its two-step sign-in with scripts/mfa-reset.mjs. Then sign " +
				'in as it, the superadmin that now holds your email address, with that password.',
			words: ", giving the backup's superadmin the importing account's password but no authenticator. The system log",
			enrol: false
		},
		{
			row: 'with no authenticator carried and your leave to set up on your password alone, its 14 days running (the code review’s FP6)',
			stubbed: true,
			said:
				"The backup's superadmin is not the account you imported with, and the backup's seal did not verify, so its password in the backup was " +
				'not taken: it was given the password you confirmed this import with, but none of your authenticators, as no MFA key is loaded or none ' +
				'of yours could be moved, and your leave to set up two-step sign-in on that password alone. Sign in as it, the superadmin that now holds ' +
				"your email address, with that password and set up an authenticator when asked, while that leave's 14 days run; if it is asked for a " +
				"link instead, the server's host resets its two-step sign-in with scripts/mfa-reset.mjs.",
			words: ", giving the backup's superadmin the importing account's password but no authenticator. The system log",
			enrol: true
		}
	])('(x) card 3009, through the route: the superadmin given your password, $row, is pointed at by your email address and named by no username', async ({ stubbed, said, words, enrol }) => {
		// The 14 days running, in the file as here (FP6).
		if (enrol) openReleaseWindow();
		const backup = fromElsewhere(ownBackup());
		backup.prepare('UPDATE users SET created_at = ?, password_hash = ? WHERE id = ?').run(EARLIER, fileHash(), chief.id);
		const newboss = makeUser({ username: 'newboss-of-3009', role: 'superadmin' });
		giveFactor(newboss);
		if (enrol) sqlite.prepare('UPDATE users SET mfa_password_enrol = 1 WHERE id = ?').run(newboss.id);
		await routeMethods('/api/admin/import');
		const dir = mkdtempSync(join(tmpdir(), 'dumpfire-import-'));
		tempDirs.push(dir);
		vi.spyOn(process, 'cwd').mockReturnValue(dir);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const from = sqlite.prepare('SELECT COALESCE(MAX(id), 0) FROM system_logs').pluck().get() as number;
		carryStub.none = stubbed;
		let res: Awaited<ReturnType<typeof api>>;
		try {
			res = await api('POST', '/api/admin/import?outside=keep', {
				user: newboss,
				headers: { 'content-type': 'application/octet-stream', ...importConfirmation(newboss) },
				body: backup.serialize()
			});
		} finally {
			carryStub.none = false;
		}

		expect(res.status, res.body.message).toBe(200);
		expect(res.body.passwordsKept).toMatchObject({ superadminGivenYours: 1, givenYoursWithoutFactor: stubbed ? 1 : 0, givenYoursMayEnrol: enrol ? 1 : 0 });
		expect(res.body.accountsKeptLines).toContain(said);
		// The superadmin the sentence points at holds the importer's address (FP7), and the importer's leave (FP6).
		expect(accountOf(chief.id).email).toBe(newboss.email);
		expect(userOf(chief.id)?.enrol).toBe(enrol ? 1 : 0);
		expect(res.body.message).toContain(said);
		const line = sqlite
			.prepare("SELECT message, meta FROM system_logs WHERE context = 'IMPORT' AND level = 'CRITICAL' AND id > ? ORDER BY id")
			.get(from) as { message: string; meta: string };
		expect(line.message).toContain(words);
		expect(JSON.parse(line.meta).installation).toBe('other');
		// The sentence names no account: the superadmins are listed by the answer's own sentence, after it.
		for (const name of ['chief', 'newboss-of-3009']) expect(said).not.toContain(name);
	});

	it('(n3) the carry with no MFA key loaded: the password and no authenticator, so it needs the host’s reset; the accounts with no factor counted, none named', async () => {
		// The importer holds an authenticator, which the file holds too: the file's is left out as unsealed.
		stepUpFactor(chief);
		const backup = ownBackup();
		// The file's user 1, made earlier, is not this server's chief: the importer is not in the file.
		backup.prepare('UPDATE users SET created_at = ?, password_hash = ? WHERE id = ?').run(EARLIER, fileHash(), chief.id);

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id, key: null });

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual({ ...NONE, superadminGivenYours: 1, givenYoursWithoutFactor: 1 });
		expect(accountOf(chief.id)).toMatchObject({ role: 'superadmin', disabledAt: null, passwordHash: fixtureHashOf(chief) });
		expect(sqlite.prepare('SELECT COUNT(*) FROM mfa_factors WHERE user_id = ?').pluck().get(chief.id)).toBe(0);
		// The carried superadmin is among the accounts with no factor, counted and not named; the same accounts here are
		// counted too, and named by none, their usernames as restored being the file's (the code review's FP7).
		expect(result.mfa).toMatchObject({ withoutFactor: [], withoutFactorUnnamed: 2, leftOut: [], leftOutBecause: 'unsealed', notSameHere: 1 });
		const said = mfaWithoutFactorSentence(result.mfa)!;
		expect(said).toContain('1 account(s) in the backup are not on this server as the same account and have no second factor');
		expect(said).toContain("2 account(s) on this server have no second factor after this restore and each needs its two-step sign-in reset before it can sign in; the backup's seal did not verify, so none is named here.");
		for (const name of ['chief', 'administrator', 'member']) expect(said).not.toContain(name);
		// The password alone opens no second step: it needs a set-up link, which only the host makes for a superadmin.
		expect(answerOf((await passwordStep({ username: 'chief' })).res)).toMatchObject({ type: 'failure', status: 403 });
	});

	it('(l3) card 2996’s role ceiling does not undo R2: a superadmin the host promoted after a recorded lowering, made an administrator by an unsealed file, stays a superadmin', () => {
		const rex = makeUser({ username: 'rex', role: 'admin' });
		const rexCreated = sqlite.prepare('SELECT created_at FROM users WHERE id = ?').pluck().get(rex.id) as string;
		// Lowered to a user here, recorded, then promoted by the host, which writes no row.
		sqlite.prepare("INSERT INTO account_endings (user_id, account_created, ending, role, ended_at) VALUES (?, ?, 'role', 'user', '2026-11-19 09:00:00')").run(rex.id, rexCreated);
		sqlite.prepare("UPDATE users SET role = 'superadmin' WHERE id = ?").run(rex.id);
		const backup = ownBackup();
		backup.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(rex.id);

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.sealVerified).toBe(false);
		expect(result.installation).toBe('this');
		expect(result.errors).toEqual([]);
		expect(result.accountsKept).toMatchObject({ lowered: 0 });
		expect(accountOf(rex.id)).toMatchObject({ role: 'superadmin', disabledAt: null, passwordHash: fixtureHashOf(rex) });
	});
});

// ─── Card 3009: API keys from a backup whose seal did not verify ────────────

describe('an unsealed backup brings back no API key this server did not hold for the same account (card 3009, slice 3)', () => {
	const v1 = async (key: string) => (await gate('GET', '/api/v1/me', { headers: { authorization: `Bearer ${key}` } })).status;
	const keyIds = () => sqlite.prepare('SELECT id FROM api_keys ORDER BY id').pluck().all() as number[];
	const endsOf = (id: number) =>
		sqlite.prepare('SELECT expires_at AS expiresAt, deadline_at AS deadlineAt FROM api_keys WHERE id = ?').get(id) as
			| { expiresAt: string | null; deadlineAt: string | null }
			| undefined;
	const recorded = () => sqlite.prepare('SELECT COUNT(*) FROM api_key_revocations').pluck().get() as number;
	/** A key of `user` the file holds and this server never did, at row `id`. */
	const plantedKey = (backup: Database.Database, id: number, userId: number) => {
		const made = generateApiKey();
		backup.prepare('INSERT INTO api_keys (id, key_hash, key_prefix, name, user_id) VALUES (?, ?, ?, ?, ?)').run(id, made.keyHash, made.keyPrefix, `Planted ${id}`, userId);
		return { id, key: made.plaintextKey };
	};

	beforeEach(() => {
		resetAllRateLimits();
	});

	it('(s) an unsealed backup of this server’s own: a key this server holds, the same id, hash and owner, for the same account, is kept and works', async () => {
		const K = makeApiKeyRow(member);
		const backup = ownBackup({ edited: true });

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.sealVerified).toBe(false);
		expect(result.errors).toEqual([]);
		expect(result.apiKeysLeftOut).toEqual({ count: 0, keyIds: [], workingCopy: 0, unsealed: 0 });
		expect(keyIds()).toEqual([K.id]);
		expect(await v1(K.key)).toBe(200);
	});

	it('(t) a key planted on an account that is the same here, never held here: left out with its reveals, set_by_key emptied, counted unsealed, not recorded', async () => {
		const K = makeApiKeyRow(member);
		const board = makeBoard({ owner: member, name: 'Hooks' }).board;
		const hook = makeWebhook(board, { url: 'https://hooks.example.test/planted', secret: 'a-secret' });
		const backup = ownBackup({ edited: true });
		const P = plantedKey(backup, 900, member.id);
		backup.prepare('UPDATE webhooks SET set_by_key = ? WHERE id = ?').run(P.id, hook.id);
		backup.prepare("INSERT INTO webhook_reveals (webhook_id, key_id, revealed_at) VALUES (?, ?, '2026-11-19 09:00:00')").run(hook.id, P.id);
		const before = recorded();

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.errors).toEqual([]);
		expect(result.apiKeysLeftOut).toEqual({ count: 0, keyIds: [], workingCopy: 0, unsealed: 1 });
		expect(keyIds()).toEqual([K.id]);
		expect(sqlite.prepare('SELECT COUNT(*) FROM webhook_reveals WHERE key_id = ?').pluck().get(P.id)).toBe(0);
		expect(sqlite.prepare('SELECT set_by_key FROM webhooks WHERE id = ?').pluck().get(hook.id)).toBeNull();
		expect(recorded()).toBe(before);
		expect(await v1(P.key)).toBe(401);
		expect(await v1(K.key)).toBe(200);
	});

	it('(u) an unsealed backup from another installation: a key with this server’s id and hash under the same user id is left out, its owner not the same account', async () => {
		const K = makeApiKeyRow(member);
		const backup = fromElsewhere(ownBackup({ edited: true }));

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.installation).toBe('other');
		expect(result.errors).toEqual([]);
		expect(result.apiKeysLeftOut).toMatchObject({ count: 0, workingCopy: 0, unsealed: 1 });
		expect(keyIds()).toEqual([]);
		expect(await v1(K.key)).toBe(401);
	});

	it('(v) an unsealed working copy: every key counted workingCopy, none unsealed', () => {
		makeApiKeyRow(member);
		const backup = ownBackup({ edited: true });
		plantedKey(backup, 900, member.id);

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id, outside: 'off' });

		expect(result.errors).toEqual([]);
		expect(result.apiKeysLeftOut).toEqual({ count: 0, keyIds: [], workingCopy: 2, unsealed: 0 });
		expect(keyIds()).toEqual([]);
	});

	it.each([
		{ row: 'expired here, no expiry in the file: kept with this server’s', column: 'expires_at' as const, here: '2026-01-01 00:00:00', file: null, kept: '2026-01-01 00:00:00' },
		{ row: 'no expiry here, an expiry passed in the file: kept with the file’s', column: 'expires_at' as const, here: null, file: '2026-02-01 00:00:00', kept: '2026-02-01 00:00:00' },
		{ row: 'both set: the earlier', column: 'expires_at' as const, here: '2026-03-01 00:00:00', file: '2099-01-01 00:00:00', kept: '2026-03-01 00:00:00' },
		{ row: 'past its deadline here, none in the file: kept with this server’s', column: 'deadline_at' as const, here: '2026-01-01 00:00:00', file: null, kept: '2026-01-01 00:00:00' }
	])('(s2) a kept key takes the earlier end, $row, and is refused at the gate (R5)', async ({ column, here, file, kept }) => {
		const K = makeApiKeyRow(member);
		sqlite.prepare(`UPDATE api_keys SET ${column} = ? WHERE id = ?`).run(here, K.id);
		const backup = ownBackup({ edited: true });
		backup.prepare(`UPDATE api_keys SET ${column} = ? WHERE id = ?`).run(file, K.id);

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.errors).toEqual([]);
		expect(result.apiKeysLeftOut).toMatchObject({ count: 0, unsealed: 0 });
		expect(endsOf(K.id)).toEqual(column === 'expires_at' ? { expiresAt: kept, deadlineAt: null } : { expiresAt: null, deadlineAt: kept });
		expect(await v1(K.key)).toBe(401);
	});

	it('(s2b) the code review’s FP9: an expiry in the file that names no moment, a later one here: kept with the file’s, which the gate reads as passed (earlierEnd)', async () => {
		allowOtherTimestampForms();
		const K = makeApiKeyRow(member);
		sqlite.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run('2099-01-01 00:00:00', K.id);
		const backup = ownBackup({ edited: true });
		backup.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run('not a moment', K.id);

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.apiKeysLeftOut).toMatchObject({ count: 0, unsealed: 0 });
		expect(endsOf(K.id)).toEqual({ expiresAt: 'not a moment', deadlineAt: null });
		expect(await v1(K.key)).toBe(401);
	});

	it('(t2) the unsealed key leave-out cannot be written: rolled back, and the hashes, schedules, keys, holds and installation id are unchanged (R8)', () => {
		makeApiKeyRow(member);
		const backup = ownBackup({ edited: true });
		// An account not here, with a password and a schedule, so that the password step has written before the refusal.
		backup
			.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES (90, 'planted-90', 'planted-90@example.test', ?, 'user')")
			.run(fixtureHashOf(member));
		backup.prepare("INSERT INTO report_schedules (user_id, name, scope, enabled) VALUES (90, 'Weekly', 'all', 1)").run();
		const P = plantedKey(backup, 900, member.id);
		const idHere = sqlite.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(INSTALLATION_ID);
		const before = snapshotDb();
		sqlite.exec(`CREATE TEMP TRIGGER refuse_3009 BEFORE DELETE ON api_keys WHEN OLD.id = ${P.id} BEGIN SELECT RAISE(ABORT, 'refused by (t2)'); END`);
		let thrown: unknown = null;
		try {
			restoreFromBackup(sqlite, backup, { importer: chief.id });
		} catch (e) {
			thrown = e;
		} finally {
			sqlite.exec('DROP TRIGGER IF EXISTS temp.refuse_3009');
		}

		expect(thrown).toBeInstanceOf(RestoreError);
		expect((thrown as RestoreError).committed).toBe(false);
		expect((thrown as RestoreError).message).toContain('refused by (t2)');
		expectUnchanged(before);
		expect(sqlite.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(INSTALLATION_ID)).toBe(idHere);
		expect(sqlite.prepare('SELECT COUNT(*) FROM users WHERE id = 90').pluck().get()).toBe(0);
	});
});

// ─── Card 3009's code review: the fix pass ──────────────────────────────────

describe('card 3009’s code review: the fix pass (FP1, FP2, FP5, FP6, FP9, FP12)', () => {
	const NONE = { here: 0, reset: 0, superadmin: 0, unsealed: 0, superadminGivenYours: 0, givenYoursWithoutFactor: 0, givenYoursMayEnrol: 0, emailGivenUp: 0 };
	const EARLIER = '2020-01-01 00:00:00';
	/** `backup`'s user 1, the superadmin, made earlier than this server's chief: not the same account here, the importer not in it. */
	const importerNotIn = (backup: Database.Database) => {
		backup.prepare('UPDATE users SET created_at = ?, password_hash = ? WHERE id = ?').run(EARLIER, hashSync('a password the forger knows', 4), chief.id);
		return backup;
	};
	const schedulesOf = (id: number) => sqlite.prepare('SELECT enabled FROM report_schedules WHERE user_id = ? ORDER BY id').pluck().all(id) as number[];
	const userRow = (id: number) =>
		sqlite.prepare('SELECT email, password_hash AS passwordHash, mfa_password_enrol AS enrol FROM users WHERE id = ?').get(id) as { email: string; passwordHash: string; enrol: number };
	const scheduleFor = (backup: Database.Database, id: number) =>
		backup.prepare("INSERT INTO report_schedules (user_id, name, scope, enabled) VALUES (?, 'Weekly', 'all', 1)").run(id);
	/** `backup`'s `invite_tokens` made again with `used` of no declared type, holding `rows` (token, user, used as stored). */
	const untypedInvites = (backup: Database.Database, rows: [string, number, unknown][]) => {
		backup.exec('DROP TABLE invite_tokens');
		backup.exec('CREATE TABLE invite_tokens (token, user_id, expires_at, used, created_at)');
		const put = backup.prepare("INSERT INTO invite_tokens VALUES (?, ?, '2099-01-01 00:00:00', ?, '2026-11-01 00:00:00')");
		for (const [token, userId, used] of rows) put.run(inviteHashOf(token), userId, used);
		return backup;
	};

	beforeEach(() => {
		resetAllRateLimits();
	});

	it.each([
		{ made: 'sealed', sealed: true },
		{ made: 'unsealed', sealed: false }
	])('(fp1a) FP1: a backup, $made, whose invites’ used column has no type and holds the text 0: no unused invite comes back usable', ({ sealed }) => {
		const backup = untypedInvites(ownBackup(), [
			['planted-unused', member.id, '0'],
			['planted-text-one', member.id, '1'],
			// Bound as a whole number, so stored as one, as a used invite of a backup's own is.
			['really-used', admin.id, 1n]
		]);
		if (sealed) sealCopy(backup, backupSealKey(sqlite));

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.sealVerified).toBe(sealed);
		expect(result.errors).toEqual([]);
		expect(usableInvite('planted-unused')).toBeUndefined();
		expect(usableInvite('planted-text-one')).toBeUndefined();
		// Sealed: the one used, stored as an integer, comes back as history, used; unsealed: none at all.
		expect(sqlite.prepare('SELECT user_id AS userId, used, typeof(used) AS type FROM invite_tokens').all()).toEqual(
			sealed ? [{ userId: admin.id, used: 1, type: 'integer' }] : []
		);
	});

	it('(fp1b) FP1: an unsealed backup of this server’s own restores no invite, the used one included', () => {
		const backup = ownBackup({ edited: true });
		// A backup holds the used one alone (card 2849).
		expect(column(backup, 'SELECT used FROM invite_tokens ORDER BY used')).toEqual([1]);

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.sealVerified).toBe(false);
		expect(result.errors).toEqual([]);
		expect(result.restored.invite_tokens ?? 0).toBe(0);
		expect(sqlite.prepare('SELECT COUNT(*) FROM invite_tokens').pluck().get()).toBe(0);
		expect(usableInvite(UNUSED_INVITE)).toBeUndefined();
	});

	it('(fp2a) FP2: an account not the same here that the file gives DUMMY_HASH itself still has its schedules paused, and is not counted', () => {
		const backup = ownBackup();
		backup
			.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES (90, 'planted-90', 'planted-90@example.test', ?, 'admin')")
			.run(DUMMY_HASH);
		scheduleFor(backup, 90);

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toEqual(NONE);
		expect(userRow(90).passwordHash).toBe(DUMMY_HASH);
		expect(schedulesOf(90)).toEqual([0]);
	});

	it.each([
		{ made: 'as it is: paused', outside: 'keep' as const },
		{ made: 'as a working copy: switched off with every other, and counted there (R7)', outside: 'off' as const }
	])('(fp2b) FP2: the carried superadmin’s schedules, the file’s, $made', ({ outside }) => {
		const backup = importerNotIn(ownBackup());
		scheduleFor(backup, chief.id);

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id, outside });

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toMatchObject({ superadminGivenYours: 1 });
		expect(schedulesOf(chief.id)).toEqual([0]);
		if (outside === 'off') expect(result.outside?.reportSchedules).toBeGreaterThanOrEqual(1);
	});

	it('(fp5a) FP5: another superadmin of this server, restored as the same account, enabled, with its usable hash: nothing is carried', () => {
		const boss = makeUser({ username: 'boss', role: 'superadmin' });
		const backup = importerNotIn(ownBackup());

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.errors).toEqual([]);
		// The file's user 1 is not the same here and is given a password nothing matches; boss can sign in as the superadmin.
		expect(result.passwordsKept).toEqual({ ...NONE, unsealed: 1 });
		expect(userRow(chief.id).passwordHash).toBe(DUMMY_HASH);
		expect(userRow(boss.id).passwordHash).toBe(fixtureHashOf(boss));
	});

	it('(fp5b) FP5: an account not the same here holding the importer’s address gives it up for one that receives no mail; the carried superadmin holds it', () => {
		const backup = importerNotIn(ownBackup());
		backup.prepare("UPDATE users SET email = 'file-boss@example.test' WHERE id = ?").run(chief.id);
		backup
			.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES (90, 'planted-90', ?, 'x', 'user')")
			.run(chief.email);

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toMatchObject({ superadminGivenYours: 1, emailGivenUp: 1, unsealed: 1 });
		expect(userRow(chief.id).email).toBe(chief.email);
		expect(userRow(90).email).toBe('email-given-up-90@restore.invalid');
	});

	it.each([
		{ row: 'the importer’s leave given and its 14 days running: it may set up on its password', importer: 1, file: 0, mayEnrol: 1 },
		{ row: 'the importer holding none, the file’s leave overridden', importer: 0, file: 1, mayEnrol: 0 }
	])('(fp6) FP6: the carried superadmin, no authenticator carried, takes the importer’s leave to set up on its password alone: $row', async ({ importer, file, mayEnrol }) => {
		openReleaseWindow();
		sqlite.prepare('UPDATE users SET mfa_password_enrol = ? WHERE id = ?').run(importer, chief.id);
		const backup = importerNotIn(ownBackup());
		backup.prepare('UPDATE users SET mfa_password_enrol = ? WHERE id = ?').run(file, chief.id);

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id, key: null });

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toMatchObject({ superadminGivenYours: 1, givenYoursWithoutFactor: 1, givenYoursMayEnrol: mayEnrol });
		expect(userRow(chief.id).enrol).toBe(importer);
		// With the leave, the password leads to a set-up; without it, a link is needed (403).
		const { res } = await passwordStep({ username: 'chief' });
		if (mayEnrol === 1) expect(res).toMatchObject({ type: 'redirect' });
		else expect(res).toMatchObject({ type: 'failure', status: 403 });
	});

	it('(fp9a) FP9, R3: an importer given but not held here: every superadmin of the file not the same here gets a password nothing matches', () => {
		const backup = importerNotIn(ownBackup());

		const result = restoreFromBackup(sqlite, backup, { importer: 9999 });

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toMatchObject({ superadminGivenYours: 0, unsealed: 1 });
		expect(userRow(chief.id).passwordHash).toBe(DUMMY_HASH);
	});

	it('(fp9b) FP9: carryFactors carries the importer’s factor and skips one of another key and one that does not open', () => {
		const here = readMfaHere(sqlite);
		const mine = here.factors.find((factor) => Number(factor.user_id) === chief.id)!;
		// As a restore leaves it: the importer's own rows cleared, read before.
		sqlite.prepare('DELETE FROM mfa_factors WHERE user_id = ?').run(chief.id);
		const factors = [
			mine,
			{ ...mine, factor_uid: 'of-another-key', key_id: 'another-key' },
			{ ...mine, factor_uid: 'does-not-open', secret_ciphertext: Buffer.alloc(32, 7).toString('base64') }
		];

		const carried = inTransaction(() => carryFactors(sqlite, { ...here, factors }, currentMfaKey()!, chief.id, member.id));

		expect(carried).toBe(1);
		expect(sqlite.prepare('SELECT factor_uid FROM mfa_factors WHERE user_id = ?').pluck().all(member.id)).toEqual([mine.factor_uid]);
	});

	it('(fp12) FP12: on a server where nobody had a second factor, the carry adds the first; the others are counted as needing a reset, and named by none', () => {
		// A backup from elsewhere made before two-step sign-in (card 2768): no MFA tables, so no factor is restored.
		const backup = importerNotIn(fromElsewhere(ownBackup()));
		backup.exec('DROP TABLE mfa_factors; DROP TABLE mfa_recovery_codes; DROP TABLE sign_in_challenges; DROP TABLE enrolment_links;');

		const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

		expect(result.errors).toEqual([]);
		expect(result.passwordsKept).toMatchObject({ superadminGivenYours: 1, givenYoursWithoutFactor: 0 });
		expect(sqlite.prepare('SELECT COUNT(*) FROM mfa_factors').pluck().get()).toBe(1);
		expect(result.mfa).toMatchObject({ firstFactorsCarried: true, withoutFactor: [], withoutFactorUnnamed: 0, notSameHere: 2 });
		const said = mfaWithoutFactorSentence(result.mfa)!;
		expect(said).toContain("Your authenticators, given to the backup's superadmin, are the first second factors on this server, so two-step sign-in is in use from this restore");
		expect(said).toContain('2 account(s) in the backup are not on this server as the same account and have no second factor');
		for (const name of ['chief', 'administrator', 'member']) expect(said).not.toContain(name);
	});
});
