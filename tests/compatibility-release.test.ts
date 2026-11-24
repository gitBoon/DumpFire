/**
 * Card 3064: the compatibility release's first start, on a database as the
 * version live runs (106ea45, migrations 0000 to 0060) leaves it
 * (docs/planning/card-3064-compatibility-release.md, section 9, slice S1b:
 * T9, T14, T15, T69, T74).
 *
 * Each case builds that database apart, from the real files up to 0060, writes
 * rows into it as 106ea45 writes them, and runs the real runner over it: 0061
 * to 0084, 0084 being the release's own file. What the runner leaves is then
 * copied, table by table, into the application's own in-memory database, and
 * the start passes are run there in the order `src/hooks.server.ts` runs them,
 * with the schedulers on and every mail and webhook recorded by `effects()`
 * and sent nowhere. What a person, a key holder, a requester or a receiver
 * would notice is then asked of the application's own code.
 *
 * Whether a session kept by 0084 survives the start and signs its holder in,
 * by either cookie name, is asked by T14 and T69 too since slice S2 (R12 to
 * R14: the dormant session limits and the old cookie name; D7).
 *
 * Its code review's fix pass adds the one-shot leave to keep the seal key and
 * the scrub's marker, both written by 0084 (CS-M2, CS-L4), and a restore
 * keeping this server's leave, never the backup's (CS-M2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlite } from '$lib/server/db';
import { runMigrations } from '$lib/server/db/migrate';
import { restoreFromBackup } from '$lib/server/db/restore';
import { cleanExpiredSessions, findApiKey, generateApiKey, openSessionUser, readSessionCookie, sessionTokenHash, validateSession } from '$lib/server/auth';
import { sealCopy, sealKeyHere, sealOf, sealVerifies } from '$lib/server/backup-secrets';
import { recheckStoredImages } from '$lib/server/image-recheck';
import { usableInvite } from '$lib/server/invites';
import { resetKnownBrowserSecretCache } from '$lib/server/known-browsers';
import { linkCheck } from '$lib/server/request-access';
import { ensureFormSecret, resetFormSecretCache } from '$lib/server/request-tokens';
import {
	SCRUBBED_LINE,
	announceReportSchedules,
	announceWebhooksBeforeKeys,
	checkMfaKeyAtStart,
	endPlainInvites,
	endPlainRequestLinks,
	endPlainSessions,
	holdAlreadyOffWebhooksAtStart,
	holdReadableWebhooksAtStart,
	maskLiveLog,
	removeSettingsOfNonAdministrators,
	reportInstallation,
	sealStoredSecretsAtStart,
	switchOffHeldWebhooksAtStart,
	sweepEndedKeyReveals
} from '$lib/server/startup-checks';
import { BACKUP_SEAL_KEY_MADE_AT, PROCESS_STARTED_AT, SEAL_KEY_KEEP_ONCE } from '$lib/server/stored-secrets';
import { dispatchWebhook } from '$lib/server/webhooks';
import { stamp } from '$lib/timestamps';
import type { TaskRequest } from '$lib/server/db/schema';
import { effects, type Effects } from './helpers/effects';
import { resetDb } from './helpers/fixtures';
import { readOpened } from './helpers/reads';

const ROOT = process.cwd();
const REAL_MIGRATIONS = join(ROOT, 'drizzle');
const DAY = 86_400_000;
/** When 106ea45 wrote the rows: before the release, and before this process's runner recorded 0056. */
const STAMP = '2026-10-20 09:00:00';
const at = (fromNow: number) => stamp(new Date(Date.now() + fromNow));

/** What 106ea45 held, in plain: a session's code (a UUID), an invite's and a request's tokens, and its signing keys. */
const SESSION_CODE = randomUUID();
const INVITE_TOKEN = 'c3'.repeat(32);
const REQUEST_TOKEN = 'a1'.repeat(32);
const OLD_SEAL_KEY = '5e'.repeat(32);
const OLD_FORM_SECRET = 'f0'.repeat(32);
const OLD_BROWSER_SECRET = 'b0'.repeat(32);
/** The webhooks, by id: before setters were recorded (0056) on and off, and after it on and off. */
const HOOK = { onNoSetter: 1, offNoSetter: 2, on: 3, off: 4 } as const;
const SECRET_OF: Record<number, string> = { 1: 'secret of hook 1', 2: 'secret of hook 2', 3: 'secret of hook 3', 4: 'secret of hook 4' };

const tempDirs: string[] = [];
const opened: Database.Database[] = [];
let sent: Effects;
const schedulers = process.env.SCHEDULERS;
const level = process.env.LOG_LEVEL;

beforeEach(() => {
	resetDb();
	sent = effects();
	// As live runs: the schedulers on (the start mails where it would mail), mail set up below.
	process.env.SCHEDULERS = 'on';
});

afterEach(() => {
	sent.restore();
	vi.restoreAllMocks();
	if (schedulers === undefined) delete process.env.SCHEDULERS;
	else process.env.SCHEDULERS = schedulers;
	if (level === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = level;
	for (const database of opened.splice(0)) database.close();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The keys 106ea45 made: one with no expiry, used, and one expiring in a year. */
type World = { database: Database.Database; keys: { noExpiry: string; aYear: string } };

/**
 * A database as 106ea45 leaves it: every real file up to 0060 applied, and rows written as that version writes them.
 * Ann the superadmin owns the one board, Bob is an editor of it, and Cat has an invite waiting. Ann's browser holds a
 * session (a UUID, expiring in 20 days); the request has its link; Ann's key has no expiry and Bob's ends in a year;
 * the four webhooks, each with its secret in plain; a report schedule that is on; an image attachment; mail set up;
 * and the three signing keys in plain, the seal key as 64 hex, unless `sealKey` is false.
 */
function live0060({ sealKey = true }: { sealKey?: boolean } = {}): World {
	const dir = mkdtempSync(join(tmpdir(), 'dumpfire-3064-'));
	tempDirs.push(dir);
	for (const file of readdirSync(REAL_MIGRATIONS).filter((f) => f.endsWith('.sql') && f < '0061_')) {
		writeFileSync(join(dir, file), readFileSync(join(REAL_MIGRATIONS, file)));
	}
	const database = new Database(':memory:');
	database.pragma('foreign_keys = ON');
	opened.push(database);
	quietly(() => runMigrations({ database, migrationsDir: dir, expectedSchema: [] }));

	const noExpiry = generateApiKey();
	const aYear = generateApiKey();
	database.exec(`
		INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES
			(1, 'ann', 'ann@example.test', 'x', 'superadmin', '${STAMP}'),
			(2, 'bob', 'bob@example.test', 'x', 'user', '${STAMP}'),
			(3, 'cat', 'cat@example.test', 'x', 'user', '${STAMP}');
		INSERT INTO boards (id, name, created_by, created_at, updated_at) VALUES (1, 'Live board', 1, '${STAMP}', '${STAMP}');
		INSERT INTO board_members (board_id, user_id, role) VALUES (1, 1, 'owner'), (1, 2, 'editor');
		INSERT INTO columns (id, board_id, title) VALUES (1, 1, 'To Do');
		INSERT INTO cards (id, column_id, title, created_by, created_at, updated_at) VALUES (1, 1, 'A card', 1, '${STAMP}', '${STAMP}');
		INSERT INTO card_attachments (card_id, filename, original_name, mime_type, size_bytes, uploaded_by, created_at) VALUES
			(1, '1-photo.png', 'photo.png', 'image/png', 10, 1, '${STAMP}');
		INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('${SESSION_CODE}', 1, '${at(20 * DAY)}', '${STAMP}');
		INSERT INTO invite_tokens (token, user_id, expires_at, used, created_at) VALUES ('${INVITE_TOKEN}', 3, '${at(5 * DAY)}', 0, '${STAMP}');
		INSERT INTO task_requests (id, target_type, target_id, title, requester_name, requester_email, status, access_token, created_at) VALUES
			(1, 'user', 1, 'Please add an export', 'Rita', 'rita@example.test', 'pending', '${REQUEST_TOKEN}', '${STAMP}');
		INSERT INTO api_keys (id, key_hash, key_prefix, name, user_id, expires_at, last_used_at, created_at) VALUES
			(1, '${noExpiry.keyHash}', '${noExpiry.keyPrefix}', 'No expiry', 1, NULL, '2026-11-01 00:00:00', '${STAMP}'),
			(2, '${aYear.keyHash}', '${aYear.keyPrefix}', 'A year', 2, '${at(365 * DAY)}', NULL, '${STAMP}');
		INSERT INTO webhooks (id, board_id, url, secret, events, active, created_at, set_by) VALUES
			(${HOOK.onNoSetter}, 1, 'https://hooks.example.test/on-no-setter', '${SECRET_OF[1]}', '[]', 1, '${STAMP}', NULL),
			(${HOOK.offNoSetter}, 1, 'https://hooks.example.test/off-no-setter', '${SECRET_OF[2]}', '[]', 0, '${STAMP}', NULL),
			(${HOOK.on}, 1, 'https://hooks.example.test/on', '${SECRET_OF[3]}', '[]', 1, '${STAMP}', 1),
			(${HOOK.off}, 1, 'https://hooks.example.test/off', '${SECRET_OF[4]}', '[]', 0, '${STAMP}', 2);
		INSERT INTO report_schedules (user_id, name, scope, enabled, recipients, created_at, updated_at) VALUES
			(1, 'Weekly', 'all', 1, 'ann@example.test', '${STAMP}', '${STAMP}');
		INSERT INTO settings (key, value) VALUES
			('smtp_host', 'smtp.example.test'),
			('smtp_from_address', 'dumpfire@example.test'),
			('request_form_secret', '${OLD_FORM_SECRET}'),
			('known_browser_secret', '${OLD_BROWSER_SECRET}');
	`);
	if (sealKey) database.prepare("INSERT INTO settings (key, value) VALUES ('backup_seal_key', ?)").run(OLD_SEAL_KEY);
	return { database, keys: { noExpiry: noExpiry.plaintextKey, aYear: aYear.plaintextKey } };
}

/** `act`, with what the runner and the start print kept off the console. */
function quietly<T>(act: () => T): T {
	const printed = ['log', 'warn', 'error'].map((method) => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
	try {
		return act();
	} finally {
		for (const spy of printed) spy.mockRestore();
	}
}

/** The columns of `table` in `database`. */
const columnsOf = (database: Database.Database, table: string) => (database.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);

/**
 * The release's runner over `world` (0061 to 0084, the model reconciled), and what it leaves copied into the
 * application's own database, emptied first: every table both have, by the columns both have. The runner's record,
 * the system log and the counters stay the application's own.
 */
function migrated(world: World): void {
	const { database } = world;
	quietly(() => runMigrations({ database, migrationsDir: REAL_MIGRATIONS }));
	resetDb();
	const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all() as string[]).filter(
		(name) => !['__drizzle_migrations', 'system_logs'].includes(name)
	);
	sqlite.pragma('foreign_keys = OFF');
	try {
		sqlite.transaction(() => {
			// Not even the form key `resetDb` makes, as a start makes it: the start below makes what it makes.
			sqlite.prepare('DELETE FROM settings').run();
			for (const table of tables) {
				const here = columnsOf(sqlite, table);
				if (here.length === 0) continue;
				const columns = columnsOf(database, table).filter((column) => here.includes(column));
				const quoted = columns.map((column) => `"${column}"`).join(', ');
				const insert = sqlite.prepare(`INSERT INTO "${table}" (${quoted}) VALUES (${columns.map(() => '?').join(', ')})`);
				for (const row of database.prepare(`SELECT ${quoted} FROM "${table}"`).raw().all() as unknown[][]) insert.run(...row);
			}
		})();
	} finally {
		sqlite.pragma('foreign_keys = ON');
	}
	// As a process that has just started knows them: nothing.
	resetFormSecretCache();
	resetKnownBrowserSecretCache();
}

/** What each start pass answered. */
type Started = {
	sessionsEnded: number | null;
	invitesEnded: number | null;
	linksEnded: number | null;
	schedulesAnnounced: number | null;
	webhooksAnnounced: number | null;
	images: Awaited<ReturnType<typeof recheckStoredImages>>;
	switchedOff: number | null;
	alreadyOffHeld: number | null;
	readableHeld: number | null;
	revealsHeld: number | null;
	lines: string[];
};

/**
 * The start, as src/hooks.server.ts makes it after the runner, every pass in its order and none of the timers: each
 * pass not awaited there is awaited here before the next, so that what it did is seen. Every line it wrote at INFO and
 * above, from the system log and the console.
 */
async function start(): Promise<Started> {
	process.env.LOG_LEVEL = 'INFO';
	const from = sqlite.prepare('SELECT COALESCE(MAX(id), 0) FROM system_logs').pluck().get() as number;
	const printed = ['log', 'warn', 'error'].map((method) => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
	try {
		checkMfaKeyAtStart();
		ensureFormSecret();
		// The scrub of a marker this start set runs now, before the server would listen; one left pending, never here.
		sealStoredSecretsAtStart(sqlite, () => {});
		const sessionsEnded = endPlainSessions();
		cleanExpiredSessions();
		maskLiveLog();
		removeSettingsOfNonAdministrators();
		const invitesEnded = endPlainInvites();
		const linksEnded = endPlainRequestLinks();
		const schedulesAnnounced = await announceReportSchedules();
		const webhooksAnnounced = await announceWebhooksBeforeKeys();
		const images = await recheckStoredImages();
		const switchedOff = switchOffHeldWebhooksAtStart();
		const alreadyOffHeld = holdAlreadyOffWebhooksAtStart();
		const readableHeld = holdReadableWebhooksAtStart();
		const revealsHeld = sweepEndedKeyReveals();
		reportInstallation();
		await sent.settle();
		const logged = (sqlite.prepare('SELECT level, context, message FROM system_logs WHERE id > ? ORDER BY id').all(from) as { level: string; context: string; message: string }[]).map(
			(row) => `[${row.level}] [${row.context}] ${row.message}`
		);
		return { sessionsEnded, invitesEnded, linksEnded, schedulesAnnounced, webhooksAnnounced, images, switchedOff, alreadyOffHeld, readableHeld, revealsHeld, lines: logged };
	} finally {
		for (const spy of printed) spy.mockRestore();
	}
}

/** Each webhook as it is after the start: on or off, its hold, and its secret opened. */
const hooksNow = () =>
	(sqlite.prepare('SELECT id, active, held_because AS heldBecause FROM webhooks ORDER BY id').all() as { id: number; active: number; heldBecause: string | null }[]).map(
		(hook) => ({ ...hook, secret: readOpened('webhooks', hook.id) })
	);

/** Every account, its role and whether it is disabled, and every board member's role: what an ending or a lowering changes. */
const accessNow = () => ({
	users: sqlite.prepare('SELECT id, role, disabled_at AS disabledAt, password_hash AS passwordHash FROM users ORDER BY id').all(),
	members: sqlite.prepare('SELECT board_id AS boardId, user_id AS userId, role FROM board_members ORDER BY board_id, user_id').all()
});

const settingNow = (key: string) => sqlite.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined;

/** The key-change record lines of the start, CRITICAL (card 2943). */
const recordLines = (lines: string[]) => lines.filter((line) => line.startsWith('[CRITICAL] [STARTUP] Key change recorded'));

/**
 * What T14 asks of everything but the backup seal key, which T69 asks the same of: nothing a person, a key holder, a
 * requester or a receiver would notice, but the two kinds of webhook 106ea45 already delivered nothing for.
 */
async function expectNothingNoticed(world: World, started: Started, before: ReturnType<typeof accessNow>): Promise<void> {
	// No session, invite or link held in plain: 0084 hashed them, and the passes that end an older image's ended none.
	expect(started.sessionsEnded).toBe(0);
	expect(started.invitesEnded).toBe(0);
	expect(started.linksEnded).toBe(0);
	// The kept session outlived the start's clean-up (F1) and opens (S2, D7); and by the cookie name 106ea45 set, over
	// HTTPS, it signs Ann in and is swapped to a new code under the secure name, the kept row given its last 60 seconds.
	const kept = sessionTokenHash(SESSION_CODE);
	expect(openSessionUser(kept)?.id).toBe(1);
	const https = new URL('https://dumpfire.example.test/');
	const sentCookie = readSessionCookie(new Request(https, { headers: { cookie: `dumpfire_session=${SESSION_CODE}` } }), https);
	expect(sentCookie).toEqual({ code: SESSION_CODE, oldName: true });
	const found = validateSession(sentCookie!.code, { oldName: true });
	expect(found?.user.id).toBe(1);
	expect(found?.reissue).not.toBeNull();
	expect(found?.hash).toEqual(sessionTokenHash(found!.reissue!.token));
	const sessionsNow = sqlite.prepare('SELECT id, user_id AS userId, created_at AS createdAt, two_step AS twoStep, kept_at_release AS kept FROM sessions ORDER BY rowid').all();
	const release = settingNow('compatibility_release_at');
	expect(sessionsNow).toEqual([
		{ id: kept, userId: 1, createdAt: release, twoStep: 0, kept: 2 },
		{ id: found!.hash, userId: 1, createdAt: release, twoStep: 0, kept: 0 }
	]);
	// The invite and the request's link open, by what was mailed.
	expect(usableInvite(INVITE_TOKEN)?.userId).toBe(3);
	const request = sqlite.prepare('SELECT * FROM task_requests WHERE id = 1').get() as Record<string, unknown>;
	const asRow = {
		id: request.id,
		status: request.status,
		createdAt: request.created_at,
		resolvedAt: request.resolved_at,
		resolvedCardId: request.resolved_card_id
	} as unknown as TaskRequest;
	expect(linkCheck(REQUEST_TOKEN)(asRow)).toBe(true);
	// Every key opens now and 61 days on: no deadline was given.
	expect(sqlite.prepare('SELECT COUNT(*) FROM api_keys WHERE deadline_at IS NOT NULL').pluck().get()).toBe(0);
	expect(findApiKey(world.keys.noExpiry)?.user.id).toBe(1);
	expect(findApiKey(world.keys.aYear)?.user.id).toBe(2);
	vi.useFakeTimers({ toFake: ['Date'] });
	try {
		vi.setSystemTime(Date.now() + 61 * DAY);
		expect(findApiKey(world.keys.noExpiry)?.user.id).toBe(1);
		expect(findApiKey(world.keys.aYear)?.user.id).toBe(2);
	} finally {
		vi.useRealTimers();
	}
	// Every webhook as it was, its secret opening to the one 106ea45 held, but the two 106ea45 delivered nothing for:
	// the one on with no setter switched off (decision 17), the one off with no setter held (2923's every start, A41).
	expect(hooksNow()).toEqual([
		{ id: HOOK.onNoSetter, active: 0, heldBecause: 'no setter', secret: SECRET_OF[1] },
		{ id: HOOK.offNoSetter, active: 0, heldBecause: 'setter access ended', secret: SECRET_OF[2] },
		{ id: HOOK.on, active: 1, heldBecause: null, secret: SECRET_OF[3] },
		{ id: HOOK.off, active: 0, heldBecause: null, secret: SECRET_OF[4] }
	]);
	expect(started.switchedOff).toBe(1);
	expect(started.alreadyOffHeld).toBe(1);
	expect(started.lines).toContain(
		`[WARN] [Webhooks] 1 webhook(s) already switched off, whose setter is disabled or not recorded, are now held (found when the server started): ` +
			`webhook ${HOOK.offNoSetter} on board 1 (no setter recorded). Each, switched on again by an owner of its board or an administrator, is given a new secret. ` +
			"Their boards' owners were not mailed."
	);
	// Nothing else held: by 2935's, 2947's or 2893's first-run passes, by the record of where this server sends, or any setting.
	expect(started.readableHeld).toBe(0);
	expect(started.revealsHeld).toBe(0);
	expect(started.webhooksAnnounced).toBe(0);
	expect(sqlite.prepare('SELECT COUNT(*) FROM setting_holds').pluck().get()).toBe(0);
	// No report schedule announced or paused, and no image checked.
	expect(started.schedulesAnnounced).toBe(0);
	expect(sqlite.prepare('SELECT enabled FROM report_schedules').pluck().all()).toEqual([1]);
	expect(started.images).toBeNull();
	// The only mail: the one truthful notice to the board's owner of the webhook switched off (decision 17).
	expect(sent.emails.map((mail) => [mail.to, mail.subject])).toEqual([['ann@example.test', 'A webhook on your board was switched off']]);
	expect(sent.emails[0].html).toContain(`webhook ${HOOK.onNoSetter} to <strong>hooks.example.test</strong>, switched off because`);
	expect(sent.emails[0].html).not.toContain(`webhook ${HOOK.offNoSetter} `);
	expect(sent.webhooks).toEqual([]);
	// Two-step sign-in dormant: no release moment, no switch.
	expect(settingNow('two_step_released_at')).toBeUndefined();
	expect(settingNow('two_step_required_at')).toBeUndefined();
	// Nothing lowered, no account ended; and the record of where this server sends started (card 3004).
	expect(accessNow()).toEqual(before);
	expect(sqlite.prepare("SELECT COUNT(*) FROM outbound_changes WHERE kind = 'seeded'").pluck().get()).toBe(1);
	expect(sqlite.prepare("SELECT COUNT(*) FROM outbound_changes WHERE origin = 'seed' AND kind = 'webhook'").pluck().get()).toBe(4);
	// The scrub said it was done (R21), and none of the release's stop lines (L6) was written.
	expect(started.lines).toContain(`[INFO] [STARTUP] ${SCRUBBED_LINE}`);
	expect(settingNow('secrets_scrub_pending')).toBeUndefined();
	for (const stop of [
		/Ended \d+ session\(s\)/,
		/Ended \d+ invite\(s\)/,
		/Ended the links/,
		/already switched off with no hold are now held, whoever set them up/,
		/set up before API keys/,
		/is on at this release/,
		/Checked the \d+ images/,
		/an API key that may have been given its secret/,
		/Two-step sign-in was required on this server and is not now/
	]) {
		expect(started.lines.filter((line) => stop.test(line)), String(stop)).toEqual([]);
	}
}

describe('the first start of the compatibility release, on a database as 106ea45 leaves it (card 3064)', () => {
	it('T14: keeps every session (open, and by the old cookie name swapped to the secure one), invite, requester link, API key, webhook secret and signing key; holds only what 106ea45 already delivered nothing for; nothing lowered, nothing mailed but that, the record of where it sends started, and the scrub says so', async () => {
		const world = live0060();
		migrated(world);
		const before = accessNow();

		const started = await start();

		await expectNothingNoticed(world, started, before);
		// The backup seal key kept: sealed in place, opening to the same 64 hex, with no record of being made (R20); the
		// one-shot leave 0084 wrote for it spent (the code review's CS-M2).
		expect(readOpened('settings', 'backup_seal_key')).toBe(`v2:${OLD_SEAL_KEY}`);
		expect(settingNow(BACKUP_SEAL_KEY_MADE_AT)).toBeUndefined();
		expect(settingNow(SEAL_KEY_KEEP_ONCE)).toBeUndefined();
		// One key-change record: the request-form key made anew, the seal key kept, and nothing else (L6, R-L2).
		const said = recordLines(started.lines);
		expect(said).toHaveLength(1);
		expect(said[0]).toContain('the request-form key (the one stored was in plain)');
		expect(said[0]).toContain('the backup seal key (kept, sealed in place:');
		expect(said[0]).not.toContain('remembered-browser');
		expect(said[0]).not.toContain("Backups sealed before now are taken as another server's");
	});

	it('T69: with no backup seal key stored, the start makes one, as none was stored, records when, and changes nothing else T14 asks', async () => {
		const world = live0060({ sealKey: false });
		migrated(world);
		const before = accessNow();

		const started = await start();

		await expectNothingNoticed(world, started, before);
		expect(readOpened('settings', 'backup_seal_key')).toMatch(/^v2:[0-9a-f]{64}$/);
		expect(settingNow(BACKUP_SEAL_KEY_MADE_AT)).toMatch(/^\d{4}-\d\d-\d\dT/);
		const said = recordLines(started.lines);
		expect(said).toHaveLength(1);
		expect(said[0]).toContain('the request-form key (the one stored was in plain)');
		expect(said[0]).toContain('the backup seal key (none was stored)');
		expect(said[0]).not.toContain('kept, sealed in place');
	});

	it('CS-M2, CS-L4: 0084 itself leaves the one-shot leave to keep the seal key and the scrub marker, an ISO time of this process, which a start takes as its own; the first start spends the leave and scrubs', async () => {
		const world = live0060();
		migrated(world);

		expect(settingNow(SEAL_KEY_KEEP_ONCE)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		const marker = settingNow('secrets_scrub_pending');
		expect(marker).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		// Written by this process's run of the file: the start scrubs it before the server listens, whatever else it seals (E4).
		expect(marker! >= PROCESS_STARTED_AT).toBe(true);

		const started = await start();

		expect(settingNow(SEAL_KEY_KEEP_ONCE)).toBeUndefined();
		expect(settingNow('secrets_scrub_pending')).toBeUndefined();
		expect(started.lines).toContain(`[INFO] [STARTUP] ${SCRUBBED_LINE}`);
	});

	it('CS-M2: a restore keeps this server’s leave to keep the seal key, never the backup’s', async () => {
		const world = live0060();
		migrated(world);
		await start();
		const backup = new Database(sqlite.serialize());
		opened.push(backup);
		backup.prepare("INSERT INTO settings (key, value) VALUES (?, '2026-11-24 09:00:00')").run(SEAL_KEY_KEEP_ONCE);

		quietly(() => restoreFromBackup(sqlite, backup));
		expect(settingNow(SEAL_KEY_KEEP_ONCE)).toBeUndefined();

		// This server's, where it holds one (a restore before its first start), whatever the backup holds.
		sqlite.prepare("INSERT INTO settings (key, value) VALUES (?, '2026-11-24 08:00:00')").run(SEAL_KEY_KEEP_ONCE);
		backup.prepare('DELETE FROM settings WHERE key = ?').run(SEAL_KEY_KEEP_ONCE);
		quietly(() => restoreFromBackup(sqlite, backup));
		expect(settingNow(SEAL_KEY_KEEP_ONCE)).toBe('2026-11-24 08:00:00');
	});

	it('T9: with the flag 0084 seeds, the readable pass (card 2935) holds nothing, though every webhook was made before 0056 was applied here', () => {
		const world = live0060();
		migrated(world);
		const flag = settingNow('webhooks_readable_by_disabled_held');
		expect(flag).toBeDefined();
		const made0056 = sqlite.prepare("SELECT created_at FROM __drizzle_migrations WHERE hash = '0056_add_webhook_set_by.sql'").pluck().get() as string | number;
		expect(new Date(Number(made0056) || String(made0056)).getTime()).toBeGreaterThan(Date.parse(`${STAMP.replace(' ', 'T')}Z`));

		const held = quietly(() => holdReadableWebhooksAtStart());

		expect(held).toBe(0);
		expect(sqlite.prepare('SELECT COUNT(*) FROM webhooks WHERE held_because IS NOT NULL').pluck().get()).toBe(0);
		expect(settingNow('webhooks_readable_by_disabled_held')).toBe(flag);
	});

	it('T15: a backup sealed by 106ea45, with its seal key, still verifies after the start, and its restore is taken as sealed', async () => {
		const world = live0060();
		// 106ea45's backup: the database as it was, its secrets and keys cleared, sealed by the rule 106ea45 seals with
		// (`sealOf`, unchanged since: A22) under its key as it used it, the 64 hex read as 32 bytes.
		const backup = new Database(world.database.serialize());
		opened.push(backup);
		backup.exec(`
			DELETE FROM sessions;
			DELETE FROM invite_tokens WHERE used = 0;
			UPDATE task_requests SET access_token = NULL;
			UPDATE webhooks SET secret = '';
			DELETE FROM settings WHERE key IN ('backup_seal_key', 'request_form_secret', 'known_browser_secret');
		`);
		sealCopy(backup, Buffer.from(OLD_SEAL_KEY, 'hex'));
		const carried = (backup.prepare("SELECT value FROM settings WHERE key = 'backup_seal'").pluck().get() as string).split(':').at(-1);
		migrated(world);
		await start();

		const kept = sealKeyHere(sqlite);
		expect(kept?.key).toBe(OLD_SEAL_KEY);
		expect(sealOf(backup, Buffer.from(kept!.key, 'hex'))).toBe(carried);
		expect(sealVerifies(backup, kept!.key)).toBe(true);
		const result = quietly(() => restoreFromBackup(sqlite, backup));
		expect(result.sealVerified).toBe(true);
		expect(result.unsealed).toBeNull();
	});

	it("T74: after the start, a webhook from before the release is delivered signed as 106ea45 signed it: sha256= and the HMAC-SHA256 of the body under its old secret", async () => {
		const world = live0060();
		migrated(world);
		await start();
		sent.clear();

		dispatchWebhook(1, 'card.updated', { cardId: 1 });
		await sent.settle();

		expect(sent.webhooks.map((delivery) => delivery.url)).toEqual(['https://hooks.example.test/on']);
		const [delivery] = sent.webhooks;
		const body = JSON.stringify(delivery.body);
		expect(delivery.headers['x-dumpfire-signature']).toBe(`sha256=${createHmac('sha256', SECRET_OF[HOOK.on]).update(body).digest('hex')}`);
	});
});
