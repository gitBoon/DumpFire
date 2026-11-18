/**
 * The deadline of an API key made before two-step sign-in (card 2772,
 * docs/planning/card-2772-account-two-step.md, D5, section 5.1).
 *
 * Slice S2: migration 0069 gave every key made before that release a
 * deadline (its own test, T11, is in tests/migrations.test.ts). Here: the one
 * rule, `deadlinePassed`, at the gate and in the sign-in report (T12); Keep
 * this key, which clears it with the password and a code (T13), and its
 * refusals, in the guard and at the write (T14); and the restore, which gives
 * a backup made before 0069 this server's deadline (T15) and leaves one made
 * since as it is (T16).
 *
 * Against the application's own in-memory database, emptied before each
 * test, on a frozen clock that a test moves itself. `checkPassword` is stood
 * in for, so that a test can count the compares made and hold one in flight.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const stub = vi.hoisted(() => ({
	/** Passwords compared since the test began. */
	compared: 0,
	/** While set, each compare waits for it: a check held in flight. */
	hold: undefined as Promise<void> | undefined
}));

vi.mock('$lib/server/passwords', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/passwords')>();
	return {
		...real,
		checkPassword: async (...args: Parameters<typeof real.checkPassword>) => {
			stub.compared++;
			await stub.hold;
			return real.checkPassword(...args);
		}
	};
});

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { apiKeys, sessions, settings } from '$lib/server/db/schema';
import { restoreFromBackup } from '$lib/server/db/restore';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { resetKnownBrowserSecretCache } from '$lib/server/known-browsers';
import { subscribeToLogs, type LogEntry } from '$lib/server/logger';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { stamp } from '$lib/timestamps';
import { api, routeMethods, type ApiResult } from './helpers/api';
import { gate } from './helpers/gate';
import { FIXTURE_PASSWORD, importConfirmation, makeApiKey, makeSession, makeUser, resetDb, sessionHashOf, stepUp } from './helpers/fixtures';
import { codeFor, giveFactor, passwordStep, verify, wrongCodeFor } from './helpers/two-step';
import { diffSnapshots, snapshotDb } from './helpers/snapshot';
import { allowOtherTimestampForms } from './helpers/timestamps';

const DAY = 86_400_000;

/** The words of the refusals of Keep this key (D5). */
const NOT_FOUND = { message: 'API key not found' };
const NO_DEADLINE = { message: 'This key has no deadline to clear.' };
const PASSED = { message: 'This key has passed its deadline and no longer works. Generate a new key.' };

/** What a key past its deadline is answered at the gate, as an expired one is. */
const EXPIRED = { message: 'Invalid or expired API key' };

/** A write refused after the password and code were checked leaves the code's step spent, and nothing else (card 2771, S4). */
const SPENT_ALONE = [expect.stringMatching(/^mfa_factors: row \d+ changed \(last_step: null became \d+; last_used_at: null became /)];

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	// resetDb empties settings, and the secret is cached as a running process caches it.
	resetKnownBrowserSecretCache();
	stub.compared = 0;
	stub.hold = undefined;
	// A frozen clock, so that a code and its check fall in one step; timers run as ever.
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date());
});

afterEach(() => {
	stub.hold = undefined;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** The clock moved on by `ms`. */
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

/** The moment `ms` from now, in the stored form. */
const from = (ms: number) => stamp(new Date(Date.now() + ms));

/** A v1 request with the key, through the gate. */
const meWithKey = (key: string) => gate('GET', '/api/v1/me', { headers: { authorization: `Bearer ${key}` } });

/** A key's row by its name. */
const keyNamed = (name: string) => db.select().from(apiKeys).where(eq(apiKeys.name, name)).get()!;

/** Give the key named `name` the deadline `deadlineAt`; its id. */
function deadline(name: string, deadlineAt: string | null): number {
	const { id } = keyNamed(name);
	db.update(apiKeys).set({ deadlineAt }).where(eq(apiKeys.id, id)).run();
	return id;
}

/** The session code a request's cookie carries. */
const tokenOf = (req: { headers: Record<string, string> }) => req.headers.cookie.split('=')[1];

/** The session's count of wrong current passwords. */
const countOf = (token: string) =>
	db.select({ count: sessions.wrongPasswordCount }).from(sessions).where(eq(sessions.tokenHash, sessionHashOf(token))).get()!.count;

/** Hold every check in flight until the returned function is called. */
function holdChecks(): () => void {
	let release!: () => void;
	stub.hold = new Promise<void>((resolve) => (release = resolve));
	return () => {
		stub.hold = undefined;
		release();
	};
}

/** Every log entry written while `fn` runs, with LOG_LEVEL at INFO, and none printed. */
async function logged<T>(fn: () => Promise<T>): Promise<{ result: T; lines: LogEntry[] }> {
	process.env.LOG_LEVEL = 'INFO';
	for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
	const lines: LogEntry[] = [];
	const stop = subscribeToLogs((entry) => lines.push(entry));
	try {
		return { result: await fn(), lines };
	} finally {
		stop();
	}
}

/** Keep this key, asked of the key `id` with `req`. */
const keep = (id: number, req: Parameters<typeof api>[2]) => api('POST', `/api/account/api-keys/${id}/keep`, req);

/** The status and body of an answer, to compare in one. */
const answer = (res: ApiResult) => ({ status: res.status, body: res.body });

describe('the deadline of a key made before two-step sign-in (card 2772, S2)', () => {
	it('T12. deadlinePassed, at the gate and in the report: a key works until its deadline, is refused 401 as an expired key from it on, and with one that names no moment; the sign-in report lists a kept key and not the passed one', async () => {
		const user = makeUser();
		const key = makeApiKey(user, 'Made before');
		const id = deadline('Made before', from(60_000));

		expect((await meWithKey(key)).status).toBe(200);

		// At the deadline it has passed: refused in the gate's own words for an expired key.
		later(60_000);
		const passed = await meWithKey(key);
		expect({ status: passed.status, body: await passed.json() }).toEqual({ status: 401, body: EXPIRED });

		// A deadline that names no moment has passed, as an unreadable expiry has.
		allowOtherTimestampForms();
		db.update(apiKeys).set({ deadlineAt: 'not a moment' }).where(eq(apiKeys.id, id)).run();
		const unreadable = await meWithKey(key);
		expect({ status: unreadable.status, body: await unreadable.json() }).toEqual({ status: 401, body: EXPIRED });

		// The page after a right code that followed a wrong one lists the live keys: the kept one, not the passed one.
		const holder = makeUser();
		const factor = giveFactor(holder);
		makeApiKey(holder, 'Kept');
		makeApiKey(holder, 'Passed');
		deadline('Passed', from(-60_000));
		const { challenge } = await passwordStep(holder);
		await verify(challenge, { code: wrongCodeFor(factor.secret) });
		const res = await verify(challenge, { code: codeFor(factor.secret) });

		expect(res).toMatchObject({ type: 'success', data: { signedIn: true, report: { wrongCodes: 1, apiKeys: [{ name: 'Kept', lastUsedAt: null }] } } });
	});

	it('T13. Keep this key: 200; only the deadline cleared, the expiry, hash and prefix as they were; the same key works after the old deadline; the list answers deadlineAt null for it and the deadline for another; an INFO line', async () => {
		const user = makeUser();
		const key = makeApiKey(user, 'Kept');
		makeApiKey(user, 'Not yet');
		const old = from(DAY);
		db.update(apiKeys).set({ deadlineAt: old, expiresAt: from(365 * DAY) }).run();
		const kept = keyNamed('Kept');
		const req = stepUp(user);

		const { result: res, lines } = await logged(() => keep(kept.id, req));

		expect(answer(res)).toEqual({ status: 200, body: { success: true } });
		expect(keyNamed('Kept')).toEqual({ ...kept, deadlineAt: null });
		expect(lines.filter((line) => line.context === 'AUTH' && line.message.startsWith('API key'))).toEqual([
			expect.objectContaining({ level: 'INFO', message: `API key ${kept.id} kept past its deadline by user ${user.id}`, userId: user.id })
		]);

		// Past the old deadline the same key still works.
		later(2 * DAY);
		expect((await meWithKey(key)).status).toBe(200);

		const list = await api('GET', '/api/account/api-keys', { user });
		expect(list.status).toBe(200);
		expect((list.body as { name: string; deadlineAt: string | null }[]).map(({ name, deadlineAt }) => ({ name, deadlineAt }))).toEqual([
			{ name: 'Kept', deadlineAt: null },
			{ name: 'Not yet', deadlineAt: old }
		]);
	});

	it('T14. Keep refused: in the guard, no deadline 409, another account’s key 404, a passed or unreadable deadline 409, each with no compare and the count 0; a deadline that passes while the compare is held is refused at the write, the code’s spend the only change', async () => {
		const user = makeUser();
		const other = makeUser();
		makeApiKey(user, 'None');
		makeApiKey(other, 'Theirs');
		makeApiKey(user, 'Passed');
		makeApiKey(user, 'Unreadable');
		makeApiKey(user, 'Live');
		// One deadline that names no moment, on purpose.
		allowOtherTimestampForms();
		const refusals: [number, { status: number; body: unknown }][] = [
			[keyNamed('None').id, { status: 409, body: NO_DEADLINE }],
			[deadline('Theirs', from(DAY)), { status: 404, body: NOT_FOUND }],
			[deadline('Passed', from(-60_000)), { status: 409, body: PASSED }],
			[deadline('Unreadable', 'banana'), { status: 409, body: PASSED }]
		];

		for (const [id, refused] of refusals) {
			// Built by hand, with no code: refused before the password is read.
			const token = makeSession(user);
			const before = snapshotDb();

			const res = await keep(id, { user, body: { currentPassword: FIXTURE_PASSWORD }, headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } });

			expect(answer(res), String(id)).toEqual(refused);
			expect(stub.compared).toBe(0);
			expect(countOf(token)).toBe(0);
			expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		}

		// Past the guard with a minute to go; the deadline passes while the password is compared.
		const live = deadline('Live', from(60_000));
		const req = stepUp(user);
		const before = snapshotDb();
		const release = holdChecks();

		const held = keep(live, req);
		await vi.waitFor(() => expect(stub.compared).toBe(1));
		later(120_000);
		release();

		expect(answer(await held)).toEqual({ status: 409, body: PASSED });
		expect(diffSnapshots(before, snapshotDb())).toEqual(SPENT_ALONE);
		expect(countOf(tokenOf(req))).toBe(0);
	});
});

describe('a restore and the deadline (card 2772, S11, E12)', () => {
	/**
	 * A backup of the database as it is now, in the form a backup made before
	 * migration 0069 has: no `api_keys.deadline_at`, no `api_key_deadline`,
	 * and 0069 not recorded.
	 */
	function backupBefore0069(): Database.Database {
		const backup = new Database(sqlite.serialize());
		onTestFinished(() => {
			backup.close();
		});
		backup.exec(`
			ALTER TABLE api_keys DROP COLUMN deadline_at;
			DELETE FROM settings WHERE key = 'api_key_deadline';
			DELETE FROM __drizzle_migrations WHERE hash = '0069_add_api_key_deadline.sql';
		`);
		return backup;
	}

	/** A backup of the database as it is now: made since 0069. */
	function backupSince0069(): Database.Database {
		const backup = new Database(sqlite.serialize());
		onTestFinished(() => {
			backup.close();
		});
		return backup;
	}

	/** `backup` imported through the route by the superadmin `chief`, as it is (not a working copy), in a working directory of the test's own. */
	async function imported(backup: Database.Database, chief: SessionUser): Promise<ApiResult> {
		await routeMethods('/api/admin/import');
		const confirmed = importConfirmation(chief);
		const dir = mkdtempSync(join(tmpdir(), 'dumpfire-2772-'));
		onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
		vi.spyOn(process, 'cwd').mockReturnValue(dir);
		for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
		return api('POST', '/api/admin/import?outside=keep', {
			user: chief,
			headers: { 'content-type': 'application/octet-stream', ...confirmed },
			body: backup.serialize()
		});
	}

	/** Every key's name, expiry and deadline, by name. */
	const keysNow = () =>
		sqlite.prepare('SELECT name, expires_at AS expiresAt, deadline_at AS deadlineAt FROM api_keys ORDER BY name').all() as {
			name: string;
			expiresAt: string | null;
			deadlineAt: string | null;
		}[];

	/** This server's API key deadline, as the settings hold it now. */
	const deadlineSetting = () => db.select().from(settings).where(eq(settings.key, 'api_key_deadline')).get()?.value ?? null;

	it('T15. a backup made before 0069: its key with no expiry and its key whose expiry is later than the deadline, in another form, get this server’s deadline, compared as moments; the setting is this server’s; 2 in the answer and its sentence; with no setting here, the keys end at once', async () => {
		const chief = makeUser({ role: 'superadmin' });
		const here = '2030-06-15 12:00:00';
		db.insert(settings).values({ key: 'api_key_deadline', value: here }).run();
		const none = makeApiKey(chief, 'No expiry');
		makeApiKey(chief, 'Years away');
		makeApiKey(chief, 'Same day, earlier');
		const backup = backupBefore0069();
		// In ISO form with a zone, as a backup made before card 2095 can hold one: later than the deadline; and, on
		// the deadline's own day, later as text but an hour earlier as the moment it names (two hours ahead of UTC).
		backup.prepare("UPDATE api_keys SET expires_at = '2099-01-01T00:00:00Z' WHERE name = 'Years away'").run();
		backup.prepare("UPDATE api_keys SET expires_at = '2030-06-15T13:00:00+02:00' WHERE name = 'Same day, earlier'").run();

		const res = await imported(backup, chief);

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(keysNow()).toEqual([
			{ name: 'No expiry', expiresAt: null, deadlineAt: here },
			{ name: 'Same day, earlier', expiresAt: '2030-06-15 11:00:00', deadlineAt: null },
			{ name: 'Years away', expiresAt: '2099-01-01 00:00:00', deadlineAt: here }
		]);
		expect(deadlineSetting()).toBe(here);
		expect(res.body).toMatchObject({ apiKeyDeadlines: 2, apiKeyDeadline: `${here.slice(0, 16)} UTC` });
		expect(res.body.message).toContain(`2 API key(s) from before two-step sign-in were given this server's deadline, ${here.slice(0, 16)} UTC.`);

		// With no deadline here, the restore's own moment: such keys, each of which ends after it, end at once.
		db.delete(settings).where(eq(settings.key, 'api_key_deadline')).run();
		const result = restoreFromBackup(sqlite, backup);

		expect(result.apiKeyDeadlines).toBe(3);
		const now = stamp();
		expect(keysNow().map(({ name, deadlineAt }) => ({ name, deadlineAt }))).toEqual([
			{ name: 'No expiry', deadlineAt: now },
			{ name: 'Same day, earlier', deadlineAt: now },
			{ name: 'Years away', deadlineAt: now }
		]);
		expect(deadlineSetting()).toBe(now);
		const ended = await meWithKey(none);
		expect({ status: ended.status, body: await ended.json() }).toEqual({ status: 401, body: EXPIRED });
	});

	it('T16. a backup made since 0069 is restored as it is: a kept key stays kept, 0 in the answer, and no sentence', async () => {
		const chief = makeUser({ role: 'superadmin' });
		db.insert(settings).values({ key: 'api_key_deadline', value: from(60 * DAY) }).run();
		makeApiKey(chief, 'Kept');
		const backup = backupSince0069();

		const res = await imported(backup, chief);

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(keysNow()).toEqual([{ name: 'Kept', expiresAt: null, deadlineAt: null }]);
		expect(res.body.apiKeyDeadlines).toBe(0);
		expect(res.body).not.toHaveProperty('apiKeyDeadline');
		expect(res.body.message).not.toContain('API key(s) from before two-step sign-in');
	});

	// Card 2899's code review, F3: the CRITICAL line of who imported is the
	// first thing after the commit, and a failure after it is said as one of a
	// restore that committed. Reading this server's deadline for the answer is
	// the one step after the commit that is not caught, so it is made to fail.
	it('2899 F3. a failure after the commit: the line of who imported is already written, and the failure is said as one after a commit, with no user', async () => {
		const chief = makeUser({ role: 'superadmin' });
		db.insert(settings).values({ key: 'api_key_deadline', value: '2030-06-15 12:00:00' }).run();
		makeApiKey(chief, 'No expiry');
		const backup = backupBefore0069();
		const real = sqlite.prepare.bind(sqlite);
		vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
			if (source === "SELECT value FROM settings WHERE key = 'api_key_deadline'") throw new Error('disk I/O error');
			return real(source);
		}) as typeof sqlite.prepare);

		const res = await imported(backup, chief);
		vi.mocked(sqlite.prepare).mockRestore();

		expect(res.status).toBe(500);
		expect(res.body.committed).toBe(true);
		expect(res.body.message).toBe('The backup was restored and committed, and then something failed: disk I/O error. Reload the page.');
		const lines = sqlite
			.prepare("SELECT message, user_id AS userId FROM system_logs WHERE context = 'IMPORT' AND level = 'CRITICAL' ORDER BY id")
			.all() as { message: string; userId: number | null }[];
		expect(lines).toHaveLength(2);
		expect(lines[0].message).toMatch(new RegExp(`^The database was replaced from an uploaded backup by ${chief.username} \\(user ${chief.id} before the import\\)`));
		expect(lines[1]).toEqual({
			message:
				'Database restore committed, and then failed: disk I/O error. The backup is in; nothing was rolled back ' +
				`(import by ${chief.username}, user ${chief.id} before the import)`,
			userId: null
		});
	});
});
