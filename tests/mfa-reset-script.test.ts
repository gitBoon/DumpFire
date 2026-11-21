/**
 * The host's reset of an account's two-step sign-in (card 2773, plan 4.5):
 * scripts/mfa-reset.mjs, run as the host runs it, with node, in a process of
 * its own.
 *
 * Each case seeds the in-memory database and writes it, with
 * `sqlite.serialize()`, to a scratch folder of its own under the temp folder,
 * removed after the case; the command is pointed at that file with `DB_PATH`
 * and run with the scratch folder as its working directory, so it never
 * reaches the repository's dumpfire.db. `APP_URL` and `ORIGIN` are only what
 * a case gives it. The image build runs the suite as root, so every run names
 * a uid through the command's test seam, `DUMPFIRE_TEST_UID` (read only when
 * `NODE_ENV` is `test` and `VITEST` is set): 1000, but in T26.
 *
 * T21 is the command's whole job: what it leaves is compared, every table and
 * column, with what `resetTwoStep` leaves of the same database in memory, so
 * a statement one makes and the other does not fails here.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	REVEALED_TO_ACCOUNT_SQL,
	SEED_REVEALS_SELECT,
	endingScope,
	mayHaveRead,
	readableBy,
	readableNowScope,
	tellSwitchedOff,
	type SwitchedOff
} from '$lib/server/webhooks';
// The script's own copy of the server's Webhooks lines (card 2923's code review, E8): importing it runs nothing.
// And of the readable rule and its scopes (card 2935; its code review, C7).
import {
	heldLines,
	holdReadableScope,
	mayHaveRead as scriptMayHaveRead,
	placeKey as scriptPlaceKey,
	readableBy as scriptReadableBy,
	REVEALED_TO_ACCOUNT_SQL as scriptRevealedToAccount,
	SEED_REVEALS_SELECT as scriptSeedReveals,
	// Card 2995: the record of an account's keys ended, and its word.
	RECORD_ACCOUNT_KEYS_ENDED_SQL as scriptRecordAccountKeysEnded,
	ACCESS_ENDED as scriptAccessEnded,
	// Card 3004 (R8): the settings hold and the record of where the server sends.
	HOLD_SETTINGS_SET_BY_SQL as scriptHoldSettingsSetBy,
	RECORD_WEBHOOKS_HELD_SQL as scriptRecordWebhooksHeld,
	RECORD_SCHEDULES_OFF_SQL as scriptRecordSchedulesOff,
	RECORD_SETTINGS_HELD_SQL as scriptRecordSettingsHeld,
	resetScope,
	webhookLines
} from '../scripts/mfa-reset.mjs';
import { RECORD_ACCOUNT_KEYS_ENDED_SQL, REVOKED_BECAUSE } from '$lib/server/key-revocations';
// Card 2922: the server's hold lines and places, which the script copies.
import { heldLines as serverHeldLines } from '$lib/server/setting-setters';
import { HOLD_SETTINGS_SET_BY_SQL, appUrlPlaceOf, mailPlaceOf } from '$lib/server/setting-holds';
import { RECORD_SCHEDULES_OFF_SQL, RECORD_SETTINGS_HELD_SQL, RECORD_WEBHOOKS_HELD_SQL } from '$lib/server/outbound-changes';
import { db, sqlite } from '$lib/server/db';
import { enrolmentLinks, inviteTokens, reportSchedules, settingSetters, settings, signInChallenges, users } from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import { sha256Hex } from '$lib/server/mfa-crypto';
import { ENROLMENT_LINK_LIFETIME_MS, addTotpFactor, resetTwoStep, storeRecoveryCodes, twoStepResetMeta } from '$lib/server/mfa-store';
import { newRecoveryCodes } from '$lib/server/recovery-codes';
import { newTotpSecret } from '$lib/server/totp';
import { isStamp, parseStamp, stamp } from '$lib/timestamps';
import { inviteHashOf, makeApiKey, makeApiKeyRow, makeBoard, makeSession, makeUser, makeWebhook, resetDb } from './helpers/fixtures';

const SCRIPT = join(process.cwd(), 'scripts', 'mfa-reset.mjs');

/** When a seeded report schedule was last changed: a day before the case runs (card 2894). */
const EARLIER = stamp(new Date(Date.now() - 24 * 60 * 60 * 1000));

let scratch: string;
/** The scratch copy of the database the command is run on. */
let file: string;

beforeEach(() => {
	resetDb();
	scratch = mkdtempSync(join(tmpdir(), 'dumpfire-mfa-reset-'));
	file = join(scratch, 'dumpfire.db');
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

/**
 * Run the command with `args`, on `DB_PATH` (the scratch copy unless a case
 * names another), with nothing of this process's `APP_URL`, `ORIGIN` or
 * `DB_PATH`, and `env` on top.
 */
function run(args: string[], env: Record<string, string> = {}) {
	const inherited: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined && !['APP_URL', 'ORIGIN', 'DB_PATH'].includes(name)) inherited[name] = value;
	}
	const result = spawnSync(process.execPath, [SCRIPT, ...args], {
		cwd: scratch,
		// VITEST named here, not left to what is inherited: the seam is read only with it and NODE_ENV both (card 2773's review).
		env: { ...inherited, NODE_ENV: 'test', VITEST: 'true', DUMPFIRE_TEST_UID: '1000', DB_PATH: file, ...env },
		encoding: 'utf8',
		timeout: 30_000
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Write the in-memory database, as it is now, to the scratch copy. */
const writeCopy = () => writeFileSync(file, sqlite.serialize());

type Row = Record<string, unknown>;

/**
 * Every row of every table of `database`, in rowid order, the id counters
 * included. Left out unless `logs` is set: `system_logs` and its counter. An
 * enrolment link's hash and its two times are made fresh by each reset, so
 * they are masked; the link itself, its account and `issued_by` are not. So
 * is the moment each reset stamps on the report schedules it paused (card
 * 2894, E23), and on the webhooks it switched off (card 2915): of the ids in
 * `paused` and `held` only, each checked to be a stamp. And the moment of the
 * once-only seed's flag (card 2947's code review, FP2), which each reset writes.
 */
function dumpOf(database: Database.Database, { logs = false, paused = [] as number[], held = [] as number[] } = {}): Record<string, Row[]> {
	const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
		.map((table) => table.name)
		.filter((name) => logs || name !== 'system_logs');
	const dump: Record<string, Row[]> = {};
	for (const table of tables) {
		let rows = database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Row[];
		if (table === 'sqlite_sequence' && !logs) rows = rows.filter((row) => row.name !== 'system_logs');
		if (table === 'enrolment_links') rows = rows.map((row) => ({ ...row, token_hash: '(masked)', created_at: '(masked)', expires_at: '(masked)' }));
		if (table === 'report_schedules') {
			rows = rows.map((row) => {
				if (!paused.includes(row.id as number)) return row;
				expect(isStamp(row.updated_at), `report schedule ${row.id}`).toBe(true);
				return { ...row, updated_at: '(masked)' };
			});
		}
		if (table === 'webhooks') {
			rows = rows.map((row) => {
				if (!held.includes(row.id as number)) return row;
				expect(isStamp(row.held_at), `webhook ${row.id}`).toBe(true);
				return { ...row, held_at: '(masked)' };
			});
		}
		// When the once-only seed ran (card 2947's code review, FP2): the moment of the reset, in the stored form.
		if (table === 'settings') {
			rows = rows.map((row) => {
				if (row.key !== 'webhook_reveals_seeded') return row;
				expect(isStamp(row.value), 'the seed’s flag').toBe(true);
				return { ...row, value: '(masked)' };
			});
		}
		// When each key was recorded as ended (card 2995): the moment of the reset, in the stored form.
		if (table === 'api_key_revocations') {
			rows = rows.map((row) => {
				expect(isStamp(row.revoked_at), `the record of key ${row.key_id}`).toBe(true);
				return { ...row, revoked_at: '(masked)' };
			});
		}
		// When each change of where the server sends was recorded (card 3004, O17): the moment of the reset, in the stored form.
		if (table === 'outbound_changes') {
			rows = rows.map((row) => {
				expect(isStamp(row.changed_at), `the record's row ${row.seq}`).toBe(true);
				expect(row.stated_changed, `the record's row ${row.seq}`).toBe(row.changed_at);
				return { ...row, changed_at: '(masked)', stated_changed: '(masked)' };
			});
		}
		// When each setting was held for review (card 2922): the moment of the reset, in the stored form.
		if (table === 'setting_holds') {
			rows = rows.map((row) => {
				expect(isStamp(row.held_at), `the hold of ${row.setting}`).toBe(true);
				return { ...row, held_at: '(masked)' };
			});
		}
		dump[table] = rows;
	}
	return dump;
}

/** The scratch copy's dump, opened read-only and closed again. */
function fileDump(options: { logs?: boolean; paused?: number[]; held?: number[] } = {}): Record<string, Row[]> {
	const copy = new Database(file, { readonly: true, fileMustExist: true });
	try {
		return dumpOf(copy, options);
	} finally {
		copy.close();
	}
}

/**
 * An account with everything a reset ends or keeps, as T1 of
 * tests/mfa-reset.test.ts seeds one: a factor, ten recovery codes, two
 * sessions, a pending sign-in, an enrolment link, an unused invite and a used
 * one, an API key, wrong-code counts with their pauses, and the banner; and a
 * report schedule that is on, last changed `EARLIER` (card 2894).
 */
function seedAccount(username: string) {
	const user = makeUser({ username });
	addTotpFactor(user.id, 'Phone', newTotpSecret());
	storeRecoveryCodes(user.id, newRecoveryCodes());
	makeSession(user);
	makeSession(user);
	db.insert(signInChallenges)
		.values({
			tokenHash: sha256Hex(`challenge-${username}`),
			shortId: `c-${username}`,
			userId: user.id,
			purpose: 'sign-in',
			lane: 'other',
			passwordHash: '$2b$04$notareal.hash',
			expiresAt: stamp(new Date(Date.now() + 10 * 60 * 1000))
		})
		.run();
	db.insert(enrolmentLinks)
		.values({ tokenHash: sha256Hex(`older link of ${username}`), userId: user.id, issuedBy: 'admin-reset', expiresAt: stamp(new Date(Date.now() + 60_000)) })
		.run();
	const week = stamp(new Date(Date.now() + ENROLMENT_LINK_LIFETIME_MS));
	db.insert(inviteTokens).values({ tokenHash: inviteHashOf(`unused-${username}-${randomBytes(4).toString('hex')}`), userId: user.id, expiresAt: week }).run();
	db.insert(inviteTokens).values({ tokenHash: inviteHashOf(`used-${username}-${randomBytes(4).toString('hex')}`), userId: user.id, expiresAt: week, used: true }).run();
	makeApiKey(user);
	db.insert(reportSchedules).values({ userId: user.id, name: 'Weekly', scope: 'all', enabled: true, updatedAt: EARLIER }).run();
	const later = stamp(new Date(Date.now() + 60 * 60 * 1000));
	db.update(users)
		.set({
			mfaKnownWrong: 2,
			mfaOtherWrong: 3,
			mfaRecoveryWrong: 4,
			mfaKnownResumesAt: later,
			mfaOtherResumesAt: later,
			mfaRecoveryResumesAt: later,
			failedCodesSinceSignIn: 5,
			securityBanner: 'codes-failed',
			securityBannerAt: stamp(),
			// May set up on its password alone (card 2769): the reset clears it,
			// so the whole-table comparison fails unless the script does too.
			mfaPasswordEnrol: 1
		})
		.where(eq(users.id, user.id))
		.run();
	return user;
}

/** The account's report schedules, id, switch and when last changed, read from `database`. */
const schedulesIn = (database: Database.Database, userId: number) =>
	database.prepare('SELECT id, enabled, updated_at AS updatedAt FROM report_schedules WHERE user_id = ? ORDER BY id').all(userId) as {
		id: number;
		enabled: number;
		updatedAt: string;
	}[];

/** The token of the link the command printed, from its line of stdout, and that line. */
function printedLink(stdout: string): { line: string; token: string } {
	const line = stdout.split(/\r?\n/).find((text) => /\/enrol\/[A-Za-z0-9_-]{43}$/.test(text));
	expect(line, stdout).toBeDefined();
	return { line: line!, token: line!.slice(-43) };
}

const linksIn = (database: Database.Database) =>
	database.prepare('SELECT token_hash AS tokenHash, user_id AS userId, issued_by AS issuedBy, created_at AS createdAt, expires_at AS expiresAt FROM enrolment_links').all() as {
		tokenHash: string;
		userId: number;
		issuedBy: string;
		createdAt: string;
		expiresAt: string;
	}[];

/** The scratch copy's enrolment links, read and closed again. */
function fileLinks() {
	const copy = new Database(file, { readonly: true, fileMustExist: true });
	try {
		return linksIn(copy);
	} finally {
		copy.close();
	}
}

describe('scripts/mfa-reset.mjs', () => {
	it("T21: leaves every table and column as resetTwoStep leaves them, issues a 'host-reset' link whose printed token is the one stored, logs one CRITICAL line, and exits 0", () => {
		// Two accounts alike: the one reset, and one beside it that nothing may touch.
		const holder = seedAccount('holder');
		const twin = seedAccount('twin');
		// Card 2894's code review (CS1): a webhook the holder set, its address holding a secret, and a key
		// that has ended beside the live one the seed gave.
		const hook = makeWebhook(makeBoard({ owner: holder, name: 'Ops board' }).board, { url: 'https://hooks.example.test/x?secret=s', setBy: holder });
		const ended = makeApiKeyRow(holder, { expiresAt: stamp(new Date(Date.now() - 24 * 60 * 60 * 1000)) });
		// Card 2915 (E8, S1): a webhook the twin set, which nothing may touch, and the holder recorded as setter of the App URL.
		const twinsHook = makeWebhook(makeBoard({ owner: twin, name: 'Twin board' }).board, { url: 'https://twin.example.test/in', setBy: twin });
		db.insert(settingSetters).values({ setting: 'app_url', place: 'a recorded place', userId: holder.id }).run();
		// Card 2922 (case 30): a request each of them made signed in, with a mailed link: the holder's ends, the twin's stays.
		for (const account of [holder, twin]) {
			const request = Number(
				sqlite
					.prepare("INSERT INTO task_requests (target_type, target_id, title, requester_user_id) VALUES ('user', ?, 'Please', ?)")
					.run(account.id, account.id).lastInsertRowid
			);
			sqlite.prepare("INSERT INTO request_links (token_hash, request_id, source) VALUES (?, ?, 'mail')").run(sha256Hex(`link of ${account.username}`), request);
		}
		// The code review's CR3: a webhook the holder set that is already off with another hold, which neither switch-off touches.
		const alreadyOff = makeWebhook(makeBoard({ owner: holder, name: 'Old board' }).board, {
			url: 'https://old.example.test/in',
			setBy: holder,
			active: false,
			heldBecause: 'key ended'
		});
		const alreadyOffRow = sqlite.prepare('SELECT * FROM webhooks WHERE id = ?').get(alreadyOff.id);
		// Card 2923 (case 11): a webhook the holder set that was switched off with no hold, as by a PUT, which both hold.
		const pausedHook = makeWebhook(makeBoard({ owner: holder, name: 'Paused board' }).board, {
			url: 'https://paused.example.test/in?token=t',
			setBy: holder,
			active: false
		});
		const keysOfHolder = sqlite.prepare('SELECT id, name, created_at AS createdAt FROM api_keys WHERE user_id = ? ORDER BY id').all(holder.id) as {
			id: number;
			name: string;
			createdAt: string;
		}[];
		const live = keysOfHolder.filter((key) => key.id !== ended.id);
		const endedName = keysOfHolder.find((key) => key.id === ended.id)!.name;
		expect(live).toHaveLength(1);
		// Card 2996 (test 38): a row of the record of account endings, which the host's reset leaves row for row as it was.
		sqlite
			.prepare("INSERT INTO account_endings (user_id, account_created, ending, role, ended_at) VALUES (?, ?, 'role', 'user', '2026-11-19 09:00:00')")
			.run(holder.id, sqlite.prepare('SELECT created_at FROM users WHERE id = ?').pluck().get(holder.id));
		const endingsBefore = sqlite.prepare('SELECT * FROM account_endings ORDER BY seq').all();
		writeCopy();
		const logsBefore = (sqlite.prepare('SELECT COUNT(*) AS n FROM system_logs').get() as { n: number }).n;
		const [schedule] = schedulesIn(sqlite, holder.id);
		const twinsSchedules = schedulesIn(sqlite, twin.id);

		const twinsKeys = sqlite.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY id').all(twin.id);
		const twinsHookRow = sqlite.prepare('SELECT * FROM webhooks WHERE id = ?').get(twinsHook.id);

		// What the server's own reset leaves of the same database.
		const reset = inTransaction(() => resetTwoStep(holder.id, 'host-reset', { cause: { log: 'a test', mail: 'a test' } }));
		// Card 2894 (case 3, E23): the holder's schedule paused by each, its stamp masked; the twin's as it was.
		expect(reset.reportScheduleIds).toEqual([schedule.id]);
		// Card 2915: both keys ended, the one already ended among them, and the webhook switched off, its stamp masked.
		expect([reset.apiKeys, reset.webhookIds]).toEqual([2, [hook.id]]);
		// Card 2923: the one already off held by both, its stamp masked; counted in neither.
		const expected = dumpOf(sqlite, { paused: [schedule.id], held: [hook.id, pausedHook.id] });

		// The username as typed, with spaces round it: trimmed, as sign-in trims it (decision 12).
		const ran = run(['  holder  ']);

		expect(ran.status, ran.stderr).toBe(0);
		expect(ran.stderr).toBe('');
		expect(fileDump({ paused: [schedule.id], held: [hook.id, pausedHook.id] })).toEqual(expected);
		const copied = new Database(file, { readonly: true, fileMustExist: true });
		try {
			// Card 2996 (test 38): the record of account endings as it was.
			expect(copied.prepare('SELECT * FROM account_endings ORDER BY seq').all()).toEqual(endingsBefore);
			const [paused] = schedulesIn(copied, holder.id);
			expect(paused.enabled).toBe(0);
			expect(paused.updatedAt).not.toBe(EARLIER);
			expect(schedulesIn(copied, twin.id)).toEqual(twinsSchedules);
			// Card 2915: the holder's keys gone and webhook held; the twin's key and webhook as they were (E8).
			expect(copied.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?').get(holder.id)).toEqual({ n: 0 });
			expect(copied.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(hook.id)).toEqual({
				active: 0,
				heldBecause: 'setter access ended'
			});
			expect(copied.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY id').all(twin.id)).toEqual(twinsKeys);
			expect(copied.prepare('SELECT * FROM webhooks WHERE id = ?').get(twinsHook.id)).toEqual(twinsHookRow);
			expect(copied.prepare('SELECT * FROM webhooks WHERE id = ?').get(alreadyOff.id)).toEqual(alreadyOffRow);
			// Card 2995 (test 20): both of the holder's keys recorded as ended, the one already ended among them, by id
			// and hash, `access ended`, before they went; the twin's not.
			expect(copied.prepare('SELECT key_id AS id, revoked_because AS because FROM api_key_revocations ORDER BY key_id').all()).toEqual(
				keysOfHolder.map((key) => ({ id: key.id, because: 'access ended' }))
			);
			expect(copied.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(pausedHook.id)).toEqual({
				active: 0,
				heldBecause: 'setter access ended'
			});
		} finally {
			copied.close();
		}
		expect(ran.stdout).toContain(
			'Two-step sign-in was reset for "holder" (user ' +
				`${holder.id}): removed 1 factor(s) and 10 recovery code(s), ended 2 session(s), 1 pending sign-in(s) and 1 invite(s), ` +
				"and paused 1 report schedule(s). The account's owner turns back on the ones they recognise on the Reports page."
		);
		// What the reset ended, on stdout (card 2915, E5, E6): every key counted, the live one by its name and day,
		// the webhook by its board and host and day, never the ended key, the webhook's path or its query (card
		// 2894's code review, CS1); and the settings the holder is recorded as having set (S1).
		expect(ran.stdout).toContain(`Ended 2 API key(s); the 1 still working: ${live[0].name} (made ${live[0].createdAt.slice(0, 10)}).`);
		expect(ran.stdout).toContain(`Switched off 1 webhook(s) they set up: Ops board, to hooks.example.test (made ${hook.createdAt.slice(0, 10)}).`);
		// Card 2928, case 11: each address is stored sealed; the host is its stored receiver's, never the envelope's.
		expect(sqlite.prepare('SELECT url FROM webhooks WHERE id = ?').pluck().get(hook.id)).toMatch(/^dfsealed:1:/);
		expect(ran.stdout).not.toContain('dfsealed');
		// Card 2923 (S2): the one held listed apart, by board, host and day; and the owners are the operator's to tell.
		expect(ran.stdout).toContain(
			`Held 1 webhook(s) they set up that were already switched off: Paused board, to paused.example.test (made ${pausedHook.createdAt.slice(0, 10)}); ` +
				'switched on, each is given a new secret.'
		);
		expect(ran.stdout).toContain("Their boards' owners were not mailed: tell them.");
		expect(ran.stdout).not.toContain('token=t');
		expect(ran.stdout).toContain(
			"Give them the names: they make new keys once signed in, and the board's owner or an administrator switches back on " +
				'any webhook they recognise, which gives it a new secret.'
		);
		// Card 2922: held for review now, each named; the request links, the holder's alone, ended by both.
		expect(ran.stdout).toContain(
			"Held for the superadmin's review: the App URL, as they set them. Nothing is sent to them until the superadmin keeps or removes each under " +
				'Settings held for review on the admin page.'
		);
		expect(ran.stdout).not.toContain('Mail is held');
		expect(fileDump().request_links).toHaveLength(1);
		expect(fileDump().setting_holds).toEqual([
			{ setting: 'app_url', place: 'a recorded place', held_because: 'setter access ended', held_at: '(masked)', set_by: holder.id, set_by_name: 'holder' }
		]);
		expect(ran.stdout).not.toContain('They keep');
		expect(ran.stdout).not.toContain(endedName);
		expect(ran.stdout).not.toContain('secret=s');
		expect(ran.stdout).not.toContain('Twin board');

		// One link, the holder's, issued by the host, for seven days, stored as the hash of the token printed.
		const { token } = printedLink(ran.stdout);
		const links = fileLinks().filter((link) => link.userId === holder.id);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({ tokenHash: sha256Hex(token), issuedBy: 'host-reset' });
		expect(isStamp(links[0].createdAt)).toBe(true);
		expect(Math.abs(parseStamp(links[0].expiresAt)!.getTime() - (Date.now() + ENROLMENT_LINK_LIFETIME_MS))).toBeLessThan(60_000);

		// Five lines more in the log (card 2923, S6): the server's three Webhooks lines, in its words, with no account,
		// and its SMTP line for the App URL held (card 2922, R13), before the CRITICAL line, the account's, with its
		// counts and no token.
		const copy = new Database(file, { readonly: true, fileMustExist: true });
		const lines = copy.prepare('SELECT * FROM system_logs ORDER BY id').all() as Row[];
		copy.close();
		expect(lines).toHaveLength(logsBefore + 5);
		const cause = "holder's two-step sign-in was reset on the server's host";
		expect(lines.slice(logsBefore).map((row) => [row.level, row.context, row.user_id, row.ip, row.meta, row.message])).toEqual([
			[
				'WARN',
				'Webhooks',
				null,
				null,
				null,
				`Webhook ${hook.id} on board ${hook.boardId} switched off: the account that set it up (user ${holder.id}) had its access ended (${cause}). ` +
					'It stays off until an owner of the board or an administrator switches it on.'
			],
			[
				'WARN',
				'Webhooks',
				null,
				null,
				null,
				`Webhook ${pausedHook.id} on board ${pausedHook.boardId}, already switched off, is now held: the account that set it up (user ${holder.id}) ` +
					`had its access ended (${cause}). Switched on again by an owner of the board or an administrator, it is given a new secret.`
			],
			[
				'WARN',
				'Webhooks',
				null,
				null,
				null,
				"The owners of the boards of the 2 webhook(s) switched off or held above were not mailed, as this ran on the server's host, " +
					'which sends no mail. The lines above name them.'
			],
			[
				'WARN',
				'SMTP',
				null,
				null,
				JSON.stringify({ setter: holder.id, held: ['app_url'] }),
				`Held for the superadmin's review: the App URL, set by "holder" (user ${holder.id}), as ${cause}. No mail is sent through held mail ` +
					'settings, and no link begins with a held App URL, until the superadmin keeps or removes each under Settings held for review.'
			],
			['CRITICAL', 'AUTH', holder.id, null, expect.any(String), expect.any(String)]
		]);
		const line = lines.find((row) => row.level === 'CRITICAL')!;
		expect(line).toMatchObject({ level: 'CRITICAL', context: 'AUTH', user_id: holder.id, ip: null });
		expect(isStamp(line.timestamp)).toBe(true);
		expect(line.message).toBe(
			`Two-step sign-in reset for user ${holder.id} ("holder") on the server's host, with scripts/mfa-reset.mjs: removed ` +
				'1 factor(s) and 10 recovery code(s), ended 2 session(s), 1 pending sign-in(s), 1 invite(s) and 2 API key(s), ' +
				`switched off 1 webhook(s) they set up (id ${hook.id}), and paused 1 report schedule(s) (id ${schedule.id}); an enrolment link was issued`
		);
		// The route's meta for the same reset, field for field, the host as who reset it (card 2894, S15, E23; card 2915).
		expect(JSON.parse(line.meta as string)).toEqual(twoStepResetMeta(holder.id, 'host', reset));
		expect(JSON.parse(line.meta as string)).toEqual({
			targetUserId: holder.id,
			resetBy: 'host',
			factorsRemoved: 1,
			recoveryCodesRemoved: 10,
			sessionsEnded: 2,
			challengesEnded: 1,
			invitesEnded: 1,
			apiKeysEnded: 2,
			// The code review's CS2: the keys ended by their ids alone, the one already ended among them.
			apiKeyIds: keysOfHolder.map((key) => key.id),
			webhooksSwitchedOff: 1,
			webhookIds: [hook.id],
			apiKeysKept: false,
			liveApiKeysKept: 0,
			webhooksKept: 0,
			keptWebhookIds: [],
			reportSchedulesPaused: 1,
			reportScheduleIds: [schedule.id]
		});
		expect(JSON.stringify(lines)).not.toContain(token);
		// The keys and webhooks ended are on stdout only, never in the log (CS1); the one held too (card 2923).
		for (const text of [live[0].name, 'Ops board', 'hooks.example.test', 'Paused board', 'paused.example.test']) expect(JSON.stringify(lines)).not.toContain(text);
	});

	// Card 2915 (case 6, S3): the host keeps the keys and webhooks only when told, and the line says what it kept.
	it("T34: with --keep-api-keys, leaves every table as resetTwoStep's { apiKeys: false } leaves it, keeps the keys and webhook, and says so", () => {
		const holder = seedAccount('holder');
		const hook = makeWebhook(makeBoard({ owner: holder, name: 'Ops board' }).board, { url: 'https://hooks.example.test/x?secret=s', setBy: holder });
		const [key] = sqlite.prepare('SELECT name, created_at AS createdAt FROM api_keys WHERE user_id = ?').all(holder.id) as { name: string; createdAt: string }[];
		// The code review's CR4: a key that has ended beside the live one, kept as a row, and neither counted nor named.
		const ended = makeApiKeyRow(holder, { expiresAt: stamp(new Date(Date.now() - 24 * 60 * 60 * 1000)) });
		const endedName = (sqlite.prepare('SELECT name FROM api_keys WHERE id = ?').get(ended.id) as { name: string }).name;
		// Card 2923 (case 13): one already switched off with no hold, which a keep leaves unheld.
		const pausedHook = makeWebhook(makeBoard({ owner: holder, name: 'Paused board' }).board, { url: 'https://paused.example.test/in', setBy: holder, active: false });
		// Card 2922 (case 31): a setting the holder set and a link of a request the holder made, which a keep leaves.
		db.insert(settingSetters).values({ setting: 'mail', place: 'a recorded place', userId: holder.id }).run();
		const request = Number(
			sqlite.prepare("INSERT INTO task_requests (target_type, target_id, title, requester_user_id) VALUES ('user', ?, 'Please', ?)").run(holder.id, holder.id).lastInsertRowid
		);
		sqlite.prepare("INSERT INTO request_links (token_hash, request_id, source) VALUES (?, ?, 'mail')").run(sha256Hex('link of holder'), request);
		writeCopy();
		const [schedule] = schedulesIn(sqlite, holder.id);
		const keysBefore = sqlite.prepare('SELECT * FROM api_keys ORDER BY id').all();
		const hookBefore = sqlite.prepare('SELECT * FROM webhooks WHERE id = ?').get(hook.id);
		const pausedBefore = sqlite.prepare('SELECT * FROM webhooks WHERE id = ?').get(pausedHook.id);

		const reset = inTransaction(() => resetTwoStep(holder.id, 'host-reset', { apiKeys: false, cause: { log: 'a test', mail: 'a test' } }));
		expect(reset).toMatchObject({ apiKeys: 0, webhooks: 0, apiKeysKept: true, liveApiKeysKept: 1, webhooksKept: 1, keptWebhookIds: [hook.id] });
		const expected = dumpOf(sqlite, { paused: [schedule.id] });

		const ran = run(['--keep-api-keys', 'holder']);

		expect(ran.status, ran.stderr).toBe(0);
		expect(ran.stderr).toBe('');
		expect(fileDump({ paused: [schedule.id] })).toEqual(expected);
		const copied = new Database(file, { readonly: true, fileMustExist: true });
		try {
			expect(copied.prepare('SELECT * FROM api_keys ORDER BY id').all()).toEqual(keysBefore);
			expect(copied.prepare('SELECT * FROM webhooks WHERE id = ?').get(hook.id)).toEqual(hookBefore);
			expect(copied.prepare('SELECT * FROM webhooks WHERE id = ?').get(pausedHook.id)).toEqual(pausedBefore);
			// No Webhooks line: nothing was switched off or held.
			expect(copied.prepare("SELECT COUNT(*) AS n FROM system_logs WHERE context = 'Webhooks'").get()).toEqual({ n: 0 });
			// Card 2922: nothing held for review, no hold's line, and the request link kept.
			expect(copied.prepare('SELECT COUNT(*) AS n FROM setting_holds').get()).toEqual({ n: 0 });
			expect(copied.prepare("SELECT COUNT(*) AS n FROM system_logs WHERE context IN ('SMTP', 'BACKUP')").get()).toEqual({ n: 0 });
			expect(copied.prepare('SELECT COUNT(*) AS n FROM request_links').get()).toEqual({ n: 1 });
			// Card 2995 (test 20): a key kept is not ended, and nothing is recorded.
			expect(copied.prepare('SELECT COUNT(*) AS n FROM api_key_revocations').get()).toEqual({ n: 0 });
		} finally {
			copied.close();
		}
		expect(ran.stdout).not.toContain('Held ');
		expect(ran.stdout).toContain('They are recorded as having set the mail settings; some may have changed since: review them on the admin page.');
		expect(ran.stdout).toContain(`They keep 1 API key(s): ${key.name} (made ${key.createdAt.slice(0, 10)}).`);
		expect(ran.stdout).toContain(`They keep 1 webhook(s) they set up: Ops board, to hooks.example.test (made ${hook.createdAt.slice(0, 10)}).`);
		expect(ran.stdout).toContain('Kept, as --keep-api-keys asked: a password reset ends them.');
		expect(ran.stdout).not.toContain('Ended ');
		expect(ran.stdout).not.toContain(endedName);

		const line = fileDump({ logs: true, paused: [schedule.id] }).system_logs.find((row) => row.level === 'CRITICAL')!;
		expect(line.message).toBe(
			`Two-step sign-in reset for user ${holder.id} ("holder") on the server's host, with scripts/mfa-reset.mjs: removed ` +
				'1 factor(s) and 10 recovery code(s), ended 2 session(s), 1 pending sign-in(s) and 1 invite(s), kept 1 live API key(s) ' +
				`and 1 webhook(s) they set up (id ${hook.id}), as --keep-api-keys asked, and paused 1 report schedule(s) (id ${schedule.id}); ` +
				'an enrolment link was issued'
		);
		const meta = JSON.parse(line.meta as string);
		expect(meta).toEqual(twoStepResetMeta(holder.id, 'host', reset));
		expect(meta).toMatchObject({ apiKeysEnded: 0, apiKeyIds: [], webhooksSwitchedOff: 0, apiKeysKept: true, liveApiKeysKept: 1, webhooksKept: 1, keptWebhookIds: [hook.id] });
	});

	// Card 2923's code review (E8): the script's copy of the server's Webhooks lines, fed the same webhooks, says the same
	// words: one of each group, and more than 20 of each, the not-mailed line after them.
	it.each([
		{ row: 'one of each', done: 1, held: 1 },
		{ row: 'more than 20 of each', done: 22, held: 21 },
		// Card 2935: webhooks of others whose secret the account could read, in the reader's words.
		{ row: 'one of each, of others', done: 1, held: 1, reader: 9 }
	])("T37: the script's webhookLines and the server's tellSwitchedOff, told not to mail, write the same lines ($row)", ({ done, held, reader }) => {
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const hook = (id: number): SwitchedOff => ({
				id,
				boardId: 100 + (id % 3),
				setBy: 7,
				setByKey: null,
				setWithKey: true,
				receiver: 'https://x.example.test',
				hold: 'setter access ended',
				...(reader === undefined ? {} : { reader })
			});
			const doneHooks = Array.from({ length: done }, (_, i) => hook(i + 1));
			const heldHooks = Array.from({ length: held }, (_, i) => hook(i + 101));
			const cause = "holder's two-step sign-in was reset on the server's host";
			const before = (sqlite.prepare('SELECT COUNT(*) FROM system_logs').pluck().get() as number) ?? 0;

			tellSwitchedOff(doneHooks, cause, { mail: false, because: "this ran on the server's host, which sends no mail" }, heldHooks);

			const server = (sqlite.prepare("SELECT message FROM system_logs WHERE context = 'Webhooks' ORDER BY id").pluck().all() as string[]).slice(-3);
			expect(sqlite.prepare('SELECT COUNT(*) FROM system_logs').pluck().get()).toBe(before + 3);
			const asRows = (hooks: SwitchedOff[]) =>
				hooks.map((each) => ({ id: each.id, board_id: each.boardId, set_by: each.setBy, ...(typeof each.reader === 'number' ? { reader: each.reader } : {}) }));
			expect(webhookLines(asRows(doneHooks), asRows(heldHooks), cause)).toEqual(server);
		} finally {
			quiet.mockRestore();
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
	});

	// Card 2923 (case 12, S2): a holder whose only webhook was already off is told it was held, not that they had none.
	it('T36: a holder whose only webhook was already switched off: stdout lists it as held, never that they had no webhook, and the not-mailed line is written', () => {
		const holder = seedAccount('holder');
		const paused = makeWebhook(makeBoard({ owner: holder, name: 'Paused board' }).board, { url: 'https://paused.example.test/in', setBy: holder, active: false });
		writeCopy();

		const ran = run(['holder']);

		expect(ran.status, ran.stderr).toBe(0);
		expect(ran.stdout).toContain(
			`Held 1 webhook(s) they set up that were already switched off: Paused board, to paused.example.test (made ${paused.createdAt.slice(0, 10)}); ` +
				'switched on, each is given a new secret.'
		);
		expect(ran.stdout).toContain("Their boards' owners were not mailed: tell them.");
		expect(ran.stdout).not.toMatch(/They had no [^.]*webhook/);
		const copy = new Database(file, { readonly: true, fileMustExist: true });
		try {
			expect(copy.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(paused.id)).toEqual({ active: 0, heldBecause: 'setter access ended' });
			expect(copy.prepare("SELECT message FROM system_logs WHERE context = 'Webhooks' ORDER BY id").pluck().all()).toEqual([
				`Webhook ${paused.id} on board ${paused.boardId}, already switched off, is now held: the account that set it up (user ${holder.id}) ` +
					"had its access ended (holder's two-step sign-in was reset on the server's host). Switched on again by an owner of the board or an " +
					'administrator, it is given a new secret.',
				"The owners of the boards of the 1 webhook(s) switched off or held above were not mailed, as this ran on the server's host, which " +
					'sends no mail. The line above names it.'
			]);
		} finally {
			copy.close();
		}
	});

	// Card 2915 (case 8, S2): a lone -- ends the options, so a username starting with "-" can be named.
	it('T33: resets the account named after a lone --, a username that starts with "-", and exits 0', () => {
		const odd = seedAccount('--odd-name');
		writeCopy();

		const ran = run(['--', '--odd-name']);

		expect(ran.status, ran.stderr).toBe(0);
		expect(ran.stdout).toContain(`Two-step sign-in was reset for "--odd-name" (user ${odd.id})`);
		const { token } = printedLink(ran.stdout);
		expect(fileLinks().find((link) => link.userId === odd.id)?.tokenHash).toBe(sha256Hex(token));
	});

	it.each([
		{ case: 'T22', refusal: 'an unknown username', args: ['nobody'], database: 'seeded', status: 1, says: 'there is no account with the username "nobody". Nothing was changed.' },
		{ case: 'T23', refusal: 'no argument', args: [], database: 'seeded', status: 2, says: 'Usage: node scripts/mfa-reset.mjs [--keep-api-keys | --hold-readable] [--] <username>' },
		// Card 2915 (case 7, S2): options read strictly, before the database is opened.
		{ case: 'T23', refusal: 'an unknown option', args: ['holder', '-k'], database: 'seeded', status: 2, says: 'Unknown option "-k".' },
		{
			case: 'T23',
			refusal: 'the flag padded with spaces, which leaves no username',
			args: [' --keep-api-keys'],
			database: 'seeded',
			status: 2,
			says: 'Usage: node scripts/mfa-reset.mjs [--keep-api-keys | --hold-readable] [--] <username>'
		},
		{
			case: 'T23',
			refusal: 'the flag given twice',
			args: ['--keep-api-keys', '--keep-api-keys', 'holder'],
			database: 'seeded',
			status: 2,
			says: '--keep-api-keys was given twice.'
		},
		{ case: 'T24', refusal: 'no database', args: ['holder'], database: 'missing', status: 1, says: 'there is no database at' },
		{
			case: 'T25',
			refusal: 'a database without the 0065 tables',
			args: ['holder'],
			database: 'unmigrated',
			status: 1,
			says: 'this database has no two-step sign-in tables; start the server once to migrate it'
		},
		// Card 2894 (case 4, S15): the schedules it pauses, or nothing at all.
		{
			case: 'T31',
			refusal: 'a database without report_schedules',
			args: ['holder'],
			database: 'no schedules',
			status: 1,
			says: 'this database has no report schedules table; start the server once to migrate it'
		},
		// Card 2671 (case 9, S15): a disabled account is enabled on the admin page first.
		{
			case: 'T32',
			refusal: 'a disabled account',
			args: ['holder'],
			database: 'disabled',
			status: 1,
			says: 'the account "holder" is disabled. An administrator enables it on the admin page first. Nothing was changed.'
		},
		// Card 2915 (case 9, E16): the webhook holds the switch-off records, or nothing at all.
		{
			case: 'T35',
			refusal: 'a database whose webhooks have no holds',
			args: ['holder'],
			database: 'no holds',
			status: 1,
			says: 'this database has no webhook holds; start the server once to migrate it'
		},
		// Card 2922 (case 34, R14): the settings held for review, or nothing at all.
		{
			case: 'T40',
			refusal: 'a database without setting_holds',
			args: ['holder'],
			database: 'no setting holds',
			status: 1,
			says: 'this database has no table of the settings held for review; start the server once to migrate it'
		},
		// Card 2947 (R10): the record of which keys were given which secret, read before the keys go, or nothing at all.
		{
			case: 'T41',
			refusal: 'a database without webhook_reveals',
			args: ['holder'],
			database: 'no reveals',
			status: 1,
			says: 'this database has no table of the API keys given webhook secrets; start the server once to migrate it'
		},
		// Card 2995 (h, R15): the record of every API key ended on the server, written before the keys go, or nothing at
		// all, refused in its own words.
		{
			case: 'T44',
			refusal: 'a database without api_key_revocations',
			args: ['holder'],
			database: 'no record',
			status: 1,
			says: 'this database has no record of the API keys ended on this server; start the server once to migrate it'
		}
	])('$case: refuses $refusal with exit $status, saying so, and changes nothing', ({ args, database, status, says }) => {
		if (
			database === 'seeded' ||
			database === 'no schedules' ||
			database === 'disabled' ||
			database === 'no holds' ||
			database === 'no setting holds' ||
			database === 'no reveals' ||
			database === 'no record'
		) {
			const holder = seedAccount('holder');
			if (database === 'disabled') db.update(users).set({ disabledAt: stamp(), disabledBy: null }).where(eq(users.id, holder.id)).run();
			if (database === 'no holds') makeWebhook(makeBoard({ owner: holder, name: 'Ops board' }).board, { setBy: holder });
			writeCopy();
			if (database === 'no schedules') {
				const old = new Database(file);
				old.pragma('foreign_keys = OFF');
				old.exec('DROP TABLE report_schedules');
				old.close();
			}
			if (database === 'no holds') {
				// As a database from between migrations 0065 and 0071.
				const old = new Database(file);
				old.exec('ALTER TABLE webhooks DROP COLUMN held_because');
				old.close();
			}
			if (database === 'no setting holds') {
				// As a database from before migration 0074.
				const old = new Database(file);
				old.exec('DROP TABLE setting_holds');
				old.close();
			}
			if (database === 'no reveals') {
				// As a database from before migration 0075.
				const old = new Database(file);
				old.exec('DROP TABLE webhook_reveals');
				old.close();
			}
			if (database === 'no record') {
				// As a database from before migration 0076.
				const old = new Database(file);
				old.exec('DROP TABLE api_key_revocations');
				old.close();
			}
		} else if (database === 'unmigrated') {
			const old = new Database(file);
			old.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL); INSERT INTO users (username) VALUES ('holder');");
			old.close();
		}
		const before = database === 'missing' ? null : fileDump({ logs: true });

		const ran = run(args);

		expect(ran.status, ran.stderr).toBe(status);
		expect(ran.stderr).toContain(says);
		expect(ran.stdout).toBe('');
		if (before === null) expect(existsSync(file)).toBe(false);
		else expect(fileDump({ logs: true })).toEqual(before);
	});

	// The guard is POSIX's: Windows has no uid 0. Faked through the seam, so it is run whoever runs the suite.
	it.skipIf(process.platform === 'win32')('T26: refuses to run as uid 0 with exit 1, and changes nothing', () => {
		seedAccount('holder');
		writeCopy();
		const before = fileDump({ logs: true });

		const ran = run(['holder'], { DUMPFIRE_TEST_UID: '0' });

		expect(ran.status, ran.stderr).toBe(1);
		expect(ran.stderr).toContain('this is running as root');
		expect(fileDump({ logs: true })).toEqual(before);
	});

	it.each<{ case: string; from: string; env: Record<string, string>; setting: boolean; base: string; says: string }>([
		{
			case: 'T27',
			from: 'APP_URL, over ORIGIN and the setting',
			env: { APP_URL: ' https://app.example.test/ ', ORIGIN: 'https://origin.example.test' },
			setting: true,
			base: 'https://app.example.test',
			says: "The link's address is from APP_URL."
		},
		{
			case: 'T28',
			from: 'ORIGIN, over the setting, with no APP_URL',
			env: { ORIGIN: 'https://ORIGIN.example.test/' },
			setting: true,
			base: 'https://origin.example.test',
			says: "The link's address is from ORIGIN."
		},
		{
			case: 'T29',
			from: "the setting, with a warning, when ORIGIN is the image's placeholder",
			env: { ORIGIN: 'http://localhost:3000' },
			setting: true,
			base: 'https://setting.example.test',
			says: "The link's address is from the App URL setting. Warning: an administrator set it"
		},
		{
			case: 'T30',
			from: 'nowhere: the path alone, with the instruction',
			env: {},
			setting: false,
			base: '',
			says: "put your server's address in front of this path"
		}
	])('$case: takes the address from $from', ({ env, setting, base, says }) => {
		const holder = seedAccount('holder');
		if (setting) db.insert(settings).values({ key: 'app_url', value: 'https://setting.example.test/' }).run();
		writeCopy();

		const ran = run(['holder'], env);

		expect(ran.status, ran.stderr).toBe(0);
		expect(ran.stdout).toContain(says);
		const { line, token } = printedLink(ran.stdout);
		expect(line).toBe(`${base}/enrol/${token}`);
		expect(fileLinks().find((link) => link.userId === holder.id)?.tokenHash).toBe(sha256Hex(token));
	});

	// Card 2847's code review (CS1): the setting is read as the server reads it, and one that is no plain web address is not used.
	it.each([
		['a backslash before @', 'https://setting.example.test\\@evil.example'],
		['a user name with an encoded slash', 'https://evil%2f@setting.example.test']
	])('takes no address from an App URL setting with %s: the path alone, with the instruction (card 2847)', (_name, value) => {
		seedAccount('holder');
		db.insert(settings).values({ key: 'app_url', value }).run();
		writeCopy();

		const ran = run(['holder'], { ORIGIN: 'http://localhost:3000' });

		expect(ran.status, ran.stderr).toBe(0);
		expect(ran.stdout).not.toContain('evil');
		expect(ran.stdout).not.toContain("The link's address is from the App URL setting");
		expect(ran.stdout).toContain("put your server's address in front of this path");
		const { line, token } = printedLink(ran.stdout);
		expect(line).toBe(`/enrol/${token}`);
	});

	// Card 2769, its security review's CS1: a sign-in left at its second step,
	// which the reset ends, is said; no notice is mailed from the host.
	it('T100 (card 2769): a reset that ends a sign-in left at its second step writes one WARN line saying so', () => {
		const holder = seedAccount('holder');
		db.insert(signInChallenges)
			.values({
				tokenHash: sha256Hex('a verify challenge'),
				shortId: 'v-holder',
				userId: holder.id,
				purpose: 'verify',
				lane: 'other',
				passwordHash: '$2b$04$notareal.hash',
				expiresAt: stamp(new Date(Date.now() + 10 * 60 * 1000))
			})
			.run();
		writeCopy();

		const ran = run(['holder']);

		expect(ran.status, ran.stderr).toBe(0);
		const warned = (fileDump({ logs: true }).system_logs as Row[]).filter((line) => line.level === 'WARN');
		expect(warned).toEqual([
			expect.objectContaining({
				context: 'AUTH',
				user_id: holder.id,
				message: `The reset ended 1 sign-in(s) of user ${holder.id} ("holder") left at their second step; no notice was mailed`
			})
		]);
	});

	// ─── Card 2935: the webhooks whose secret the account could read ───

	it('T38a (card 2935): the script copies readableBy and mayHaveRead word for word, and its two composed scopes (its code review, C7)', () => {
		expect(scriptReadableBy('@id', '(r)')).toBe(readableBy('@id', '(r)'));
		expect(scriptMayHaveRead('@id', '@except')).toBe(mayHaveRead('@id', '@except'));
		expect(resetScope()).toBe(endingScope());
		expect(holdReadableScope()).toBe(readableNowScope());
		// Card 2947's code review (FP2, FP11): the seed's rows and the webhooks an account's keys were given.
		expect(scriptSeedReveals).toBe(SEED_REVEALS_SELECT);
		expect(scriptRevealedToAccount).toBe(REVEALED_TO_ACCOUNT_SQL);
	});

	it('T45 (card 2995, h, R15): the script records an account’s keys by the server’s statement word for word, under the server’s own word', () => {
		expect(scriptRecordAccountKeysEnded).toBe(RECORD_ACCOUNT_KEYS_ENDED_SQL);
		expect(scriptAccessEnded).toBe(REVOKED_BECAUSE.accessEnded);
	});

	// ─── Card 3004: this server's record of where it sends ───

	it('(ee2) card 3004, R8: the script holds settings, and records holds and pauses, by the server’s four statements word for word', () => {
		expect(scriptHoldSettingsSetBy).toBe(HOLD_SETTINGS_SET_BY_SQL);
		expect(scriptRecordWebhooksHeld).toBe(RECORD_WEBHOOKS_HELD_SQL);
		expect(scriptRecordSchedulesOff).toBe(RECORD_SCHEDULES_OFF_SQL);
		expect(scriptRecordSettingsHeld).toBe(RECORD_SETTINGS_HELD_SQL);
	});

	it('(ee) card 3004, O17: the script records the webhooks it holds, the schedules it pauses and the settings it holds where the record is there, and resets as before where it is not', () => {
		const holder = seedAccount('holder');
		const hook = makeWebhook(makeBoard({ owner: holder, name: 'Ops board' }).board, { url: 'https://hooks.example.test/in', setBy: holder });
		const mail = mailPlaceOf({ host: 'smtp.example.test', port: 587, user: 'mailer', allowInsecure: false });
		db.insert(settingSetters).values({ setting: 'mail', place: mail, userId: holder.id }).run();
		const schedule = sqlite.prepare('SELECT id FROM report_schedules WHERE user_id = ?').pluck().get(holder.id) as number;
		writeCopy();
		const before = (fileDump().outbound_changes as Row[]).length;

		const ran = run(['holder']);

		expect(ran.status, ran.stderr).toBe(0);
		const rows = (fileDump().outbound_changes as Row[]).slice(before).map(({ kind, item_id, place, state, origin }) => ({ kind, item_id, place, state, origin }));
		expect(rows).toEqual([
			{ kind: 'webhook', item_id: hook.id, place: '', state: 'held', origin: 'here' },
			{ kind: 'mail', item_id: 0, place: mail, state: 'held', origin: 'here' },
			{ kind: 'schedule', item_id: schedule, place: '', state: 'off', origin: 'here' }
		]);

		// A database from before migration 0081: reset as before, nothing recorded.
		writeCopy();
		const old = new Database(file);
		old.exec('DROP TABLE outbound_changes');
		old.close();
		const again = run(['holder']);
		expect(again.status, again.stderr).toBe(0);
		const copied = new Database(file, { readonly: true, fileMustExist: true });
		try {
			expect(copied.prepare("SELECT 1 FROM sqlite_master WHERE name = 'outbound_changes'").get()).toBeUndefined();
			expect(copied.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(hook.id)).toEqual({ active: 0, heldBecause: 'setter access ended' });
			expect(copied.prepare('SELECT enabled FROM report_schedules WHERE id = ?').pluck().get(schedule)).toBe(0);
		} finally {
			copied.close();
		}
	});

	it('(ee3) card 3004’s code review, F9: a record whose table lacks a column the server writes is left as it is, and the reset runs as before', () => {
		const holder = seedAccount('holder');
		const hook = makeWebhook(makeBoard({ owner: holder, name: 'Ops board' }).board, { url: 'https://hooks.example.test/in', setBy: holder });
		const schedule = sqlite.prepare('SELECT id FROM report_schedules WHERE user_id = ?').pluck().get(holder.id) as number;
		writeCopy();
		// The table as 0081 makes it but for stated_changed, which every statement the script records by names.
		const odd = new Database(file);
		odd.exec(
			'DROP TABLE outbound_changes; ' +
				"CREATE TABLE outbound_changes (seq integer PRIMARY KEY NOT NULL, kind text NOT NULL, item_id integer DEFAULT 0 NOT NULL, item_created text DEFAULT '' NOT NULL, " +
				"place text DEFAULT '' NOT NULL, address text DEFAULT '' NOT NULL, state text NOT NULL, changed_at text NOT NULL, origin text DEFAULT 'here' NOT NULL)"
		);
		odd.close();

		const ran = run(['holder']);

		expect(ran.status, ran.stderr).toBe(0);
		const copied = new Database(file, { readonly: true, fileMustExist: true });
		try {
			expect(copied.prepare('SELECT count(*) FROM outbound_changes').pluck().get()).toBe(0);
			expect(copied.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(hook.id)).toEqual({ active: 0, heldBecause: 'setter access ended' });
			expect(copied.prepare('SELECT enabled FROM report_schedules WHERE id = ?').pluck().get(schedule)).toBe(0);
		} finally {
			copied.close();
		}
	});

	it('T43 (card 2947’s code review, FP2): on a database no sweep has seeded, the host reset seeds first, as resetTwoStep does, and holds what the used key may have read', () => {
		const holder = makeUser({ username: 'keyed' });
		const { board } = makeBoard({ owner: holder, name: 'Own board' });
		const other = makeUser({ username: 'other' });
		const hook = makeWebhook(board, { url: 'https://seeded.example.test/in', secret: 's1', setBy: other });
		sqlite.prepare("UPDATE webhooks SET created_at = '2026-10-01 09:00:00' WHERE id = ?").run(hook.id);
		const key = makeApiKeyRow(holder);
		sqlite.prepare("UPDATE api_keys SET last_used_at = '2026-11-01 09:00:00' WHERE id = ?").run(key.id);
		writeCopy();
		inTransaction(() => resetTwoStep(holder.id, 'host-reset', { cause: { log: 'a test', mail: 'a test' } }));
		const expected = dumpOf(sqlite, { held: [hook.id] });

		const ran = run(['keyed']);

		expect(ran.status, ran.stderr).toBe(0);
		expect(fileDump({ held: [hook.id] })).toEqual(expected);
		const copied = new Database(file, { readonly: true, fileMustExist: true });
		try {
			expect(copied.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(hook.id)).toEqual({ active: 0, heldBecause: 'setter access ended' });
			expect(copied.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'webhook_reveals_seeded'").get()).toEqual({ n: 1 });
		} finally {
			copied.close();
		}
	});

	it('T38 (card 2935): the superadmin reset on the host holds every webhook with a secret, whoever set it, as resetTwoStep does; one with no secret and one held stay; the others are listed on stdout', () => {
		const boss = makeUser({ username: 'boss', role: 'superadmin' });
		const other = makeUser({ username: 'other' });
		const { board } = makeBoard({ owner: other, name: 'Their board' });
		const on = makeWebhook(board, { url: 'https://on.example.test/in', secret: 's1', setBy: other });
		const off = makeWebhook(board, { url: 'https://off.example.test/in', secret: 's2', setBy: other, active: false });
		const bare = makeWebhook(board, { url: 'https://bare.example.test/in', setBy: other });
		const keyEnded = makeWebhook(board, { url: 'https://ended.example.test/in', secret: 's3', setBy: other, heldBecause: 'key ended' });
		writeCopy();
		const reset = inTransaction(() => resetTwoStep(boss.id, 'host-reset', { cause: { log: 'a test', mail: 'a test' } }));
		// Its own counts are its own (P9): none it set.
		expect([reset.webhooks, reset.webhookIds]).toEqual([0, []]);
		const expected = dumpOf(sqlite, { held: [on.id, off.id] });

		const ran = run(['boss']);

		expect(ran.status, ran.stderr).toBe(0);
		expect(fileDump({ held: [on.id, off.id] })).toEqual(expected);
		const copied = new Database(file, { readonly: true, fileMustExist: true });
		try {
			const row = (id: number) => copied.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(id);
			expect([row(on.id), row(off.id), row(bare.id), row(keyEnded.id)]).toEqual([
				{ active: 0, heldBecause: 'setter access ended' },
				{ active: 0, heldBecause: 'setter access ended' },
				{ active: 1, heldBecause: null },
				{ active: 0, heldBecause: 'key ended' }
			]);
		} finally {
			copied.close();
		}
		expect(ran.stdout).toContain('Switched off or held 2 webhook(s) set up by others whose secret they could read');
		expect(ran.stdout).toContain('Their board, to on.example.test');
		expect(ran.stdout).toContain("Those boards' owners were not mailed: tell them.");
		const logged = (fileDump({ logs: true }).system_logs as Row[]).filter((line) => line.context === 'Webhooks').map((line) => line.message);
		expect(logged[0]).toContain(`an account that could read its secret as an owner of the board or an administrator (user ${boss.id}) lost that access`);
	});

	it.each([
		{ row: 'a reset: the webhook its key was given held, as resetTwoStep holds it, and the key’s rows gone; another key’s kept', keep: false },
		{ row: 'with --keep-api-keys: nothing held, every row kept', keep: true }
	])('T42 (card 2947, R10): $row', ({ keep }) => {
		const holder = makeUser({ username: 'keyed' });
		const other = makeUser({ username: 'other' });
		const { board } = makeBoard({ owner: other, name: 'Their board' });
		// Not one it can read: an ordinary account given the secret by its key, as the record says.
		const given = makeWebhook(board, { url: 'https://given.example.test/in', secret: 's1', setBy: other });
		const notGiven = makeWebhook(board, { url: 'https://kept.example.test/in', secret: 's2', setBy: other });
		const key = makeApiKeyRow(holder);
		const theirs = makeApiKeyRow(other);
		sqlite
			.prepare('INSERT INTO webhook_reveals (webhook_id, key_id, revealed_at) VALUES (?, ?, ?), (?, ?, ?)')
			.run(given.id, key.id, stamp(), notGiven.id, theirs.id, stamp());
		writeCopy();
		if (!keep) inTransaction(() => resetTwoStep(holder.id, 'host-reset', { cause: { log: 'a test', mail: 'a test' } }));
		const expected = keep ? null : dumpOf(sqlite, { held: [given.id] });

		const ran = run(keep ? ['--keep-api-keys', 'keyed'] : ['keyed']);

		expect(ran.status, ran.stderr).toBe(0);
		if (expected !== null) expect(fileDump({ held: [given.id] })).toEqual(expected);
		const copied = new Database(file, { readonly: true, fileMustExist: true });
		try {
			const row = (id: number) => copied.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(id);
			expect([row(given.id), row(notGiven.id)]).toEqual([
				keep ? { active: 1, heldBecause: null } : { active: 0, heldBecause: 'setter access ended' },
				{ active: 1, heldBecause: null }
			]);
			expect(copied.prepare('SELECT webhook_id AS w, key_id AS k FROM webhook_reveals ORDER BY webhook_id').all()).toEqual(
				keep
					? [
							{ w: given.id, k: key.id },
							{ w: notGiven.id, k: theirs.id }
						]
					: [{ w: notGiven.id, k: theirs.id }]
			);
		} finally {
			copied.close();
		}
	});

	it('T38b (card 2935, P1): a superadmin who provably read nothing (made after the release, never signed in, no key, no invite) holds nothing of others', () => {
		db.insert(settings).values({ key: 'two_step_released_at', value: stamp(new Date(Date.now() - 24 * 60 * 60 * 1000)) }).run();
		makeUser({ username: 'fresh', role: 'superadmin' });
		const other = makeUser({ username: 'other' });
		const hook = makeWebhook(makeBoard({ owner: other }).board, { url: 'https://on.example.test/in', secret: 's1', setBy: other });
		writeCopy();

		const ran = run(['fresh']);

		expect(ran.status, ran.stderr).toBe(0);
		const copied = new Database(file, { readonly: true, fileMustExist: true });
		try {
			expect(copied.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(hook.id)).toEqual({ active: 1, heldBecause: null });
		} finally {
			copied.close();
		}
		expect(ran.stdout).not.toContain('set up by others');
	});

	it('T39 (card 2935, P7): --hold-readable holds only what the account can read, changes nothing else of it, logs and lists them', () => {
		const owner = makeUser({ username: 'owner' });
		const keyOf = makeApiKeyRow(owner);
		const other = makeUser({ username: 'other' });
		const { board } = makeBoard({ owner, name: 'Owned board' });
		const theirs = makeWebhook(board, { url: 'https://theirs.example.test/in', secret: 's1', setBy: other });
		const own = makeWebhook(board, { url: 'https://own.example.test/in', secret: 's2', setBy: owner });
		const elsewhere = makeWebhook(makeBoard({ owner: other }).board, { url: 'https://elsewhere.example.test/in', secret: 's3', setBy: other });
		writeCopy();
		const before = fileDump();

		const ran = run(['--hold-readable', 'owner']);

		expect(ran.status, ran.stderr).toBe(0);
		const after = fileDump({ held: [theirs.id] });
		// Only the one webhook changed: the account's keys, sessions and everything else as they were; and its hold recorded
		// in this server's record of where it sends (card 3004, O17), with nothing else.
		expect({ ...after, webhooks: [], outbound_changes: [] }).toEqual({ ...before, webhooks: [], outbound_changes: [] });
		expect(after.outbound_changes.slice(before.outbound_changes.length).map(({ kind, item_id, state, origin }) => ({ kind, item_id, state, origin }))).toEqual([
			{ kind: 'webhook', item_id: theirs.id, state: 'held', origin: 'here' }
		]);
		const copied = new Database(file, { readonly: true, fileMustExist: true });
		try {
			const row = (id: number) => copied.prepare('SELECT active, held_because AS heldBecause FROM webhooks WHERE id = ?').get(id);
			expect([row(theirs.id), row(own.id), row(elsewhere.id)]).toEqual([
				{ active: 0, heldBecause: 'setter access ended' },
				{ active: 1, heldBecause: null },
				{ active: 1, heldBecause: null }
			]);
			expect(copied.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE id = ?').get(keyOf.id)).toEqual({ n: 1 });
		} finally {
			copied.close();
		}
		expect(ran.stdout).toContain('Held 1 webhook(s) whose secret "owner"');
		expect(ran.stdout).toContain('Owned board, to theirs.example.test');
		const logs = fileDump({ logs: true }).system_logs as Row[];
		expect(logs.some((line) => line.context === 'AUTH' && String(line.message).includes('--hold-readable: 1 webhook(s)'))).toBe(true);
	});

	it('T39b (card 2935, P7): --hold-readable with --keep-api-keys is a usage error, exit 2, nothing changed', () => {
		makeUser({ username: 'owner' });
		writeCopy();
		const before = fileDump({ logs: true });

		const ran = run(['--hold-readable', '--keep-api-keys', 'owner']);

		expect(ran.status).toBe(2);
		expect(ran.stderr).toContain('--keep-api-keys and --hold-readable cannot be given together.');
		expect(fileDump({ logs: true })).toEqual(before);
	});

	it('T41 (card 2922, case 32): the superadmin’s own reset holds their mail, App URL and destination; stdout names each and says how to keep the mail; the link does not begin with the held App URL', () => {
		const chief = seedAccount('chief');
		db.update(users).set({ role: 'superadmin' }).where(eq(users.id, chief.id)).run();
		db.insert(settings)
			.values([
				{ key: 'smtp_host', value: 'smtp.example.test' },
				{ key: 'app_url', value: 'https://chief.example.test' }
			])
			.run();
		for (const [setting, place] of [
			['mail', mailPlaceOf({ host: 'smtp.example.test', port: 587, user: '', allowInsecure: false })],
			['app_url', appUrlPlaceOf('https://chief.example.test')!],
			['backup_destination:Offsite', 'a recorded place']
		]) {
			db.insert(settingSetters).values({ setting, place, userId: chief.id }).run();
		}
		writeCopy();

		const ran = run(['chief']);

		expect(ran.status, ran.stderr).toBe(0);
		expect(ran.stdout).toContain(
			`Held for the superadmin's review: the App URL, backup destination "Offsite" and the mail settings, as they set them. Nothing is sent to ` +
				'them until the superadmin keeps or removes each under Settings held for review on the admin page.'
		);
		expect(ran.stdout).toContain(
			'Mail is held: no mail is sent until you sign in with the new authenticator and keep the mail settings under Settings held for review. ' +
				'Run with --keep-api-keys only where the authenticator was lost, not taken.'
		);
		// No APP_URL or ORIGIN, and the App URL held: the path alone, never https://chief.example.test.
		expect(ran.stdout).toContain('No address for the link was found');
		expect(ran.stdout).not.toContain('https://chief.example.test/enrol/');
		expect(fileDump().setting_holds.map((row) => row.setting as string).sort()).toEqual(['app_url', 'backup_destination:Offsite', 'mail']);
	});

	it('T42 (card 2922, case 33): the script’s hold lines and place digest are the server’s, word for word', () => {
		const setter = { id: 7, username: 'a "quoted" name' };
		const settingsHeld = ['app_url', 'backup_destination:Off "site"', 'backup_destination:Second', 'mail'];
		const because = "a's two-step sign-in was reset on the server's host";

		const server = serverHeldLines(setter, settingsHeld, because).map(([logger, line]) => ({
			context: logger === serverHeldLines(setter, ['mail'], because)[0][0] ? 'SMTP' : 'BACKUP',
			message: line.message,
			meta: line.meta
		}));

		expect(heldLines(setter, settingsHeld, because)).toEqual(server);
		for (const url of ['https://dumpfire.example.test', 'http://a.example.test/sub']) expect(scriptPlaceKey([url])).toBe(appUrlPlaceOf(url));
		expect(scriptPlaceKey(['h', 587, '', false])).toBe(mailPlaceOf({ host: 'h', port: 587, user: '', allowInsecure: false }));
	});
});
