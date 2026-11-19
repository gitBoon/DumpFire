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
import { tellSwitchedOff, type SwitchedOff } from '$lib/server/webhooks';
// The script's own copy of the server's Webhooks lines (card 2923's code review, E8): importing it runs nothing.
import { webhookLines } from '../scripts/mfa-reset.mjs';
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
 * `paused` and `held` only, each checked to be a stamp.
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
		expect(ran.stdout).toContain('They are recorded as having set the App URL; some may have changed since: review them on the admin page.');
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

		// Four lines more in the log (card 2923, S6): the server's three Webhooks lines, in its words, with no account,
		// before the CRITICAL line, the account's, with its counts and no token.
		const copy = new Database(file, { readonly: true, fileMustExist: true });
		const lines = copy.prepare('SELECT * FROM system_logs ORDER BY id').all() as Row[];
		copy.close();
		expect(lines).toHaveLength(logsBefore + 4);
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
		} finally {
			copied.close();
		}
		expect(ran.stdout).not.toContain('Held ');
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
		{ row: 'more than 20 of each', done: 22, held: 21 }
	])("T37: the script's webhookLines and the server's tellSwitchedOff, told not to mail, write the same lines ($row)", ({ done, held }) => {
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const hook = (id: number): SwitchedOff => ({ id, boardId: 100 + (id % 3), setBy: 7, setByKey: null, setWithKey: true, url: `https://x.example.test/${id}`, hold: 'setter access ended' });
			const doneHooks = Array.from({ length: done }, (_, i) => hook(i + 1));
			const heldHooks = Array.from({ length: held }, (_, i) => hook(i + 101));
			const cause = "holder's two-step sign-in was reset on the server's host";
			const before = (sqlite.prepare('SELECT COUNT(*) FROM system_logs').pluck().get() as number) ?? 0;

			tellSwitchedOff(doneHooks, cause, { mail: false, because: "this ran on the server's host, which sends no mail" }, heldHooks);

			const server = (sqlite.prepare("SELECT message FROM system_logs WHERE context = 'Webhooks' ORDER BY id").pluck().all() as string[]).slice(-3);
			expect(sqlite.prepare('SELECT COUNT(*) FROM system_logs').pluck().get()).toBe(before + 3);
			const asRows = (hooks: SwitchedOff[]) => hooks.map((each) => ({ id: each.id, board_id: each.boardId, set_by: each.setBy }));
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
		{ case: 'T23', refusal: 'no argument', args: [], database: 'seeded', status: 2, says: 'Usage: node scripts/mfa-reset.mjs [--keep-api-keys] [--] <username>' },
		// Card 2915 (case 7, S2): options read strictly, before the database is opened.
		{ case: 'T23', refusal: 'an unknown option', args: ['holder', '-k'], database: 'seeded', status: 2, says: 'Unknown option "-k".' },
		{
			case: 'T23',
			refusal: 'the flag padded with spaces, which leaves no username',
			args: [' --keep-api-keys'],
			database: 'seeded',
			status: 2,
			says: 'Usage: node scripts/mfa-reset.mjs [--keep-api-keys] [--] <username>'
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
		}
	])('$case: refuses $refusal with exit $status, saying so, and changes nothing', ({ args, database, status, says }) => {
		if (database === 'seeded' || database === 'no schedules' || database === 'disabled' || database === 'no holds') {
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
});
