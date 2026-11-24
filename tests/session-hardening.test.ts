/**
 * Session hardening (card 2775, with card 2869 folded in).
 *
 * A session's code was kept in `sessions.id` as the cookie held it, so whoever
 * could read the database file could sign in as anybody signed in, past both
 * factors, and a session slid 30 days at every request, a background poll's
 * included. Now `createSession` keeps only the code's SHA-256, as its 32 bytes
 * (a BLOB), and every reader looks the session up by the hash
 * (src/lib/server/auth.ts). A session ends at one deadline: the earlier of its
 * expiry, slid by each use to the idle limit of the account's role, and its
 * start plus the total limit of that role (12 and 24 hours for any role but
 * `user`, 3 and 7 days for `user`), judged on the role at every check. A start
 * that cannot be read or lies more than 60 seconds ahead, or an expiry further
 * out than the role's idle limit allows, has passed.
 *
 * The cookie is `__Host-dumpfire_session` where cookies are HTTPS-only or the
 * request came over HTTPS, read by the gate alone as exactly one value in a
 * code's shape; a plain-named one sent there is deleted on every answer. A
 * request a page makes on a timer (`X-DumpFire-Background: 1`) is checked and
 * does not slide its session. A change of role ends the account's sessions;
 * the holder's own password change keeps the start of the session it
 * replaces. Each start ends the sessions an older image kept in plain
 * (`endPlainSessions`, in src/lib/server/startup-checks.ts).
 *
 * The cases are the plan's T1 to T19
 * (`docs/planning/card-2775-session-hardening.md`, section 6.1). T34 of
 * tests/two-step-sign-in.test.ts holds the cookie a full sign-in sets.
 *
 * Card 3064 (the compatibility release, slice S2: T23 to T33, T56 to T58,
 * T61, T64, T65, T70 and T71 of `docs/planning/card-3064-compatibility-release.md`,
 * section 9): two-step sign-in may be dormant, while `two_step_required_at` is
 * absent. Every case above runs with it present (`resetDb`, R23), as two-step
 * sign-in required; the last block deletes it. Dormant, every role has 30
 * days idle and 90 in all, a session made on a password alone opens while its
 * account holds no factor, and a session migration 0084 kept is read once by
 * the old cookie name, for 30 days after the release, and swapped to a new
 * code under the secure name.
 *
 * Slice S3a adds F22 (a sign-out by the old name ends the swapped row too)
 * and the case that a swapped row's code is not slid under the secure name;
 * T30 and T61 meet the real step-up, the current password alone (R6).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { sessions, users } from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import { recordPasswordReplaced } from '$lib/server/account-endings';
import {
	AccountDisabled,
	SECURE_SESSION_COOKIE_NAME,
	SESSION_COOKIE_NAME,
	SESSION_SWEEP_EVERY_MS,
	cleanExpiredSessions,
	createSession,
	openSessionUser,
	startSessionSweep,
	stopSessionSweep,
	validateSession,
	type SessionUser
} from '$lib/server/auth';
import { endPlainSessions } from '$lib/server/startup-checks';
import { twoStepRequired } from '$lib/server/two-step-switch';
import { stamp } from '$lib/timestamps';
import { api } from './helpers/api';
import { FROM_THE_PAGE, gate } from './helpers/gate';
import {
	FIXTURE_PASSWORD,
	makeSession,
	makeTwoStepDormant,
	makeUser,
	resetDb,
	sessionHashOf,
	sessionRow,
	stepUp,
	stepUpCode,
	writeRequiredSettings
} from './helpers/fixtures';
import { allowOtherTimestampForms } from './helpers/timestamps';
import { giveFactor, signInFully } from './helpers/two-step';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** The moment each frozen clock starts at. */
const T0 = new Date('2026-11-16T09:00:00.000Z').getTime();

/** What a log line names a session by: the first 8 hex characters of its hash. */
const refOf = (code: string) => sessionHashOf(code).subarray(0, 4).toString('hex');

/** Freeze the clock at `at`. */
function clockAt(at: number): void {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(at);
}

/** Every row of `sessions`, as the database holds it. */
const sessionRows = () => sqlite.prepare('SELECT * FROM sessions ORDER BY rowid').all() as Record<string, unknown>[];

/** The lines `system_logs` holds under `context`, from `after` on. */
const linesUnder = (context: string, after = 0) =>
	sqlite
		.prepare('SELECT level, message, meta FROM system_logs WHERE context = ? AND id > ? ORDER BY id')
		.all(context, after) as { level: string; message: string; meta: string | null }[];

const lastLogId = () => (sqlite.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM system_logs').get() as { id: number }).id;

/** The meta of the last AUTH line whose message starts with `start`, from `after` on. */
function lastMeta(start: string, after = 0): Record<string, unknown> | undefined {
	const line = linesUnder('AUTH', after).filter((row) => row.message.startsWith(start)).at(-1);
	return line?.meta ? (JSON.parse(line.meta) as Record<string, unknown>) : undefined;
}

/** POST /logout through the gate, as the page's form sends it, with the `Cookie` header `cookie`. */
const signOut = (cookie: string) =>
	gate('POST', '/logout', {
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			...FROM_THE_PAGE,
			// SvelteKit's own check of a form sent to an action.
			origin: 'http://localhost',
			accept: 'text/html',
			cookie
		},
		body: ''
	});

/** Give the account `role` by a write on the host, which runs no code. */
const setRole = (user: SessionUser, role: string) => db.update(users).set({ role }).where(eq(users.id, user.id)).run();

/** Set a session's columns, by the hash of its code. */
const setSession = (code: string, values: Partial<typeof sessions.$inferInsert>) =>
	db.update(sessions).set(values).where(eq(sessions.tokenHash, sessionHashOf(code))).run();

const level = process.env.LOG_LEVEL;
const cookieSecure = process.env.COOKIE_SECURE;
const origin = process.env.ORIGIN;

beforeEach(() => {
	resetDb();
	// Every line kept, INFO and up, and the console quiet.
	process.env.LOG_LEVEL = 'INFO';
	for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	if (level === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = level;
	if (cookieSecure === undefined) delete process.env.COOKIE_SECURE;
	else process.env.COOKIE_SECURE = cookieSecure;
	if (origin === undefined) delete process.env.ORIGIN;
	else process.env.ORIGIN = origin;
});

describe('a session, kept as the hash of its code', () => {
	it('T1: is written as the SHA-256 of the code it returns, found by it, and the stored value is no code', () => {
		const user = makeUser();
		const { token } = createSession(user.id, { twoStep: 1 });

		expect(sqlite.prepare('SELECT typeof(id) AS t, length(id) AS n FROM sessions').all()).toEqual([{ t: 'blob', n: 32 }]);
		expect(sessionRow(token)?.tokenHash).toEqual(sessionHashOf(token));
		expect(validateSession(token)?.user.id).toBe(user.id);
		// The stored hash, sent as a code, finds nothing.
		const from = lastLogId();
		expect(validateSession(sessionHashOf(token).toString('hex'))).toBeNull();
		expect(linesUnder('AUTH', from).map((line) => line.message)).toEqual([
			'Session validation failed — token not in DB (deleted or never issued)'
		]);
	});
});

describe('the limits of a session, by the role of its account', () => {
	it("T2: are set at creation by the role: 3 days for a user, 12 hours for the superadmin, from a start of now", () => {
		clockAt(T0);
		const user = makeUser();
		const chief = makeUser({ role: 'superadmin' });

		const ofUser = createSession(user.id, { twoStep: 1 });
		const ofChief = createSession(chief.id, { twoStep: 1 });

		expect(ofUser).toMatchObject({ createdAt: stamp(new Date(T0)), role: 'user' });
		expect(ofChief).toMatchObject({ createdAt: stamp(new Date(T0)), role: 'superadmin' });
		expect(sessionRow(ofUser.token)).toMatchObject({ createdAt: stamp(new Date(T0)), expiresAt: stamp(new Date(T0 + 3 * DAY)) });
		expect(sessionRow(ofChief.token)).toMatchObject({ createdAt: stamp(new Date(T0)), expiresAt: stamp(new Date(T0 + 12 * HOUR)) });
	});

	it('T3: an administrator used at 11 hours slides to 11 hours on; unused for 12 hours and a second after that, it has ended and is left', () => {
		clockAt(T0);
		const admin = makeUser({ role: 'admin' });
		const { token } = createSession(admin.id, { twoStep: 1 });

		vi.setSystemTime(T0 + 11 * HOUR);
		expect(validateSession(token)?.user.id).toBe(admin.id);
		expect(sessionRow(token)?.expiresAt).toBe(stamp(new Date(T0 + 23 * HOUR)));

		vi.setSystemTime(T0 + 23 * HOUR + 1000);
		const from = lastLogId();
		expect(validateSession(token)).toBeNull();
		expect(linesUnder('AUTH', from)).toEqual([
			{ level: 'INFO', message: 'Session validation failed — session expired', meta: expect.any(String) }
		]);
		expect(sessionRow(token)).toBeDefined();
	});

	it('T4: a user used inside each idle window slides no further than 7 days from the start', () => {
		clockAt(T0);
		const user = makeUser();
		const { token } = createSession(user.id, { twoStep: 1 });

		for (const at of [2 * DAY, 4 * DAY, 6 * DAY, 6 * DAY + 12 * HOUR]) {
			vi.setSystemTime(T0 + at);
			expect(validateSession(token)?.user.id, `used at ${at / HOUR} hours`).toBe(user.id);
		}
		expect(sessionRow(token)?.expiresAt).toBe(stamp(new Date(T0 + 7 * DAY)));
	});

	it('T5: an administrator used every 11 hours has ended at 24 hours and a second, for every reader', () => {
		clockAt(T0);
		const admin = makeUser({ role: 'admin' });
		const { token, createdAt } = createSession(admin.id, { twoStep: 1 });
		for (const at of [11 * HOUR, 22 * HOUR]) {
			vi.setSystemTime(T0 + at);
			expect(validateSession(token)?.user.id).toBe(admin.id);
		}

		vi.setSystemTime(T0 + 24 * HOUR + 1000);
		expect(openSessionUser(sessionHashOf(token))).toBeNull();
		const from = lastLogId();
		expect(validateSession(token)).toBeNull();
		expect(lastMeta('Session validation failed — session expired', from)).toMatchObject({ createdAt, sessionRef: refOf(token) });
	});

	it.each([
		['made an administrator on the host: ended', 'admin', false],
		['left a user: open', 'user', true]
	])('T6: a user session 30 hours old, with an expiry an hour on, %s', (_what, role, open) => {
		clockAt(T0);
		const user = makeUser();
		const { token } = createSession(user.id, { twoStep: 1 });
		vi.setSystemTime(T0 + 30 * HOUR);
		setSession(token, { expiresAt: stamp(new Date(T0 + 31 * HOUR)) });
		setRole(user, role);

		expect(validateSession(token) !== null).toBe(open);
	});

	it('T7: a user session made now and its account made an administrator on the host: ended at once, its expiry beyond the new idle limit', () => {
		const user = makeUser();
		const { token } = createSession(user.id, { twoStep: 1 });
		setRole(user, 'admin');

		const from = lastLogId();
		expect(validateSession(token)).toBeNull();
		expect(linesUnder('AUTH', from).map((line) => line.message)).toEqual(['Session validation failed — session expired']);
	});

	it.each([
		['names no moment', () => 'zzz'],
		['is 61 seconds ahead', () => stamp(new Date(Date.now() + 61 * 1000))]
	])('T8: a session whose start %s has ended', (_what, startOf) => {
		allowOtherTimestampForms();
		const user = makeUser();
		const { token } = createSession(user.id, { twoStep: 1 });
		setSession(token, { createdAt: startOf() });

		const from = lastLogId();
		expect(validateSession(token)).toBeNull();
		expect(linesUnder('AUTH', from).map((line) => line.message)).toEqual(['Session validation failed — session expired']);
	});
});

describe('what changes a session', () => {
	it.each([
		['the role, user to admin: ends both its sessions, and says so', { role: 'admin' }, 0, ' and 2 session(s)'],
		['the email address alone: ends none, and says nothing of sessions', { email: 'moved@example.test' }, 2, '']
	])('T9: a change of %s', async (_what, body, left, said) => {
		const chief = makeUser({ role: 'superadmin' });
		const target = makeUser();
		const codes = [makeSession(target), makeSession(target)];

		const from = lastLogId();
		const res = await api('PUT', `/api/users/${target.id}`, stepUp(chief, body));

		expect(res.status).toBe(200);
		expect(codes.filter((code) => sessionRow(code) !== undefined)).toHaveLength(left);
		const line = linesUnder('AUTH', from).find((row) => row.message.startsWith(`User ${chief.id} changed`))!;
		expect(line.message.endsWith(`unused invite(s)${said}`)).toBe(true);
		if (said === '') expect(line.message).not.toContain('session(s)');
	});

	it('T10: the holder’s own password change gives a session that keeps the start of the one it replaces', async () => {
		clockAt(T0);
		const user = makeUser();
		const code = makeSession(user);
		for (const at of [2 * DAY, 4 * DAY]) {
			vi.setSystemTime(T0 + at);
			expect(validateSession(code)?.user.id).toBe(user.id);
		}

		vi.setSystemTime(T0 + 6 * DAY);
		// The current password and the code the authenticator shows at the faked time (card 2771).
		const res = await gate('PUT', '/api/account/password', {
			headers: { cookie: `${SESSION_COOKIE_NAME}=${code}`, ...FROM_THE_PAGE, accept: 'application/json' },
			body: { currentPassword: FIXTURE_PASSWORD, currentCode: stepUpCode(user), newPassword: 'another password for the account' }
		});
		expect(res.status).toBe(200);
		const set = res.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`))!;
		const replacement = set.slice(`${SESSION_COOKIE_NAME}=`.length).split(';')[0];
		expect(replacement).not.toBe(code);
		expect(sessionRow(code)).toBeUndefined();
		expect(sessionRow(replacement)?.createdAt).toBe(stamp(new Date(T0)));

		vi.setSystemTime(T0 + 6 * DAY + 12 * HOUR);
		expect(validateSession(replacement)?.user.id).toBe(user.id);
		vi.setSystemTime(T0 + 7 * DAY + 1000);
		expect(validateSession(replacement)).toBeNull();
	});

	it('T10b: the holder’s own password change with less than a minute left of the total limit is refused 401, and nothing changes', async () => {
		clockAt(T0);
		const admin = makeUser({ role: 'admin' });
		const code = makeSession(admin);
		for (const at of [11 * HOUR, 22 * HOUR]) {
			vi.setSystemTime(T0 + at);
			expect(validateSession(code)?.user.id).toBe(admin.id);
		}
		const before = db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, admin.id)).get();

		vi.setSystemTime(T0 + 24 * HOUR - 30 * 1000);
		const res = await gate('PUT', '/api/account/password', {
			headers: { cookie: `${SESSION_COOKIE_NAME}=${code}`, ...FROM_THE_PAGE, accept: 'application/json' },
			body: { currentPassword: FIXTURE_PASSWORD, currentCode: stepUpCode(admin), newPassword: 'another password for the account' }
		});

		expect({ status: res.status, body: await res.json() }).toEqual({ status: 401, body: { message: 'Not authenticated' } });
		expect(db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, admin.id)).get()).toEqual(before);
		expect(sessionRow(code)).toBeDefined();
		expect(res.headers.getSetCookie().filter((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`))).toEqual([]);
	});

	it('T11: a start that names no moment makes no session: createSession throws and writes nothing', () => {
		const user = makeUser();

		expect(() => createSession(user.id, { twoStep: 1, startedAt: 'zzz' })).toThrow();
		expect(sessionRows()).toEqual([]);
	});
});

describe('the clean-up of ended sessions', () => {
	it('T12: deletes by the deadline of each role, and by a start that cannot be believed or an expiry beyond the idle limit', () => {
		allowOtherTimestampForms();
		clockAt(T0);
		const admin = makeUser({ role: 'admin' });
		const chief = makeUser({ role: 'superadmin' });
		const user = makeUser();
		const at = (ms: number) => stamp(new Date(T0 + ms));
		const write = sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at, two_step) VALUES (?, ?, ?, ?, 1)');
		const rows: [string, SessionUser, string, string][] = [
			['admin 25 hours old', admin, at(HOUR), at(-25 * HOUR)],
			['user 8 days old', user, at(HOUR), at(-8 * DAY)],
			['a start that names no moment', user, at(HOUR), 'zzz'],
			['a start 61 seconds ahead', user, at(HOUR), at(61 * 1000)],
			['admin 23 hours old', admin, at(HOUR), at(-23 * HOUR)],
			['user 2 days old', user, at(HOUR), at(-2 * DAY)],
			['admin an hour old, its expiry 13 hours on', admin, at(13 * HOUR), at(-HOUR)],
			['user an hour old, its expiry passed a second ago', user, at(-1000), at(-HOUR)],
			['user an hour old, an expiry that names no moment', user, 'zzz', at(-HOUR)],
			['superadmin 25 hours old, as an administrator', chief, at(HOUR), at(-25 * HOUR)]
		];
		for (const [name, holder, expiresAt, createdAt] of rows) write.run(sessionHashOf(name), holder.id, expiresAt, createdAt);

		cleanExpiredSessions();

		const left = sessionRows().map((row) => row.id);
		expect(left).toEqual([sessionHashOf('admin 23 hours old'), sessionHashOf('user 2 days old')]);
	});

	it('2883-T1: a tick deletes a session past its deadline and keeps a live one, and says so once', () => {
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: T0 });
		const user = makeUser();
		const at = (ms: number) => stamp(new Date(T0 + ms));
		const write = sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at, two_step) VALUES (?, ?, ?, ?, 1)');
		write.run(sessionHashOf('ends in a minute'), user.id, at(60 * 1000), at(-HOUR));
		write.run(sessionHashOf('ends in an hour'), user.id, at(HOUR), at(-HOUR));
		const from = lastLogId();

		// The timer the gate's start-up began, if a case before this one loaded it, is replaced by one on the fake clock.
		stopSessionSweep();
		startSessionSweep();
		try {
			vi.advanceTimersByTime(SESSION_SWEEP_EVERY_MS);
			expect(sessionRows().map((row) => row.id)).toEqual([sessionHashOf('ends in an hour')]);
			expect(linesUnder('AUTH', from)).toEqual([{ level: 'INFO', message: 'Cleaned up 1 expired session(s)', meta: null }]);

			const again = lastLogId();
			vi.advanceTimersByTime(SESSION_SWEEP_EVERY_MS);
			expect(sessionRows().map((row) => row.id)).toEqual([sessionHashOf('ends in an hour')]);
			expect(linesUnder('AUTH', again)).toEqual([]);
		} finally {
			stopSessionSweep();
		}
	});

	it('2883-T2: a tick whose clean-up fails says so and the timer keeps running', () => {
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: T0 });
		const user = makeUser();
		sqlite
			.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at, two_step) VALUES (?, ?, ?, ?, 1)')
			.run(sessionHashOf('ended'), user.id, stamp(new Date(T0 - 1000)), stamp(new Date(T0 - HOUR)));
		const prepare = sqlite.prepare.bind(sqlite);
		let failed = false;
		vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
			if (!failed && source.startsWith('DELETE FROM sessions')) {
				failed = true;
				throw new Error('the disk is full');
			}
			return prepare(source);
		}) as typeof sqlite.prepare);
		const from = lastLogId();

		stopSessionSweep();
		startSessionSweep();
		try {
			expect(() => vi.advanceTimersByTime(SESSION_SWEEP_EVERY_MS)).not.toThrow();
			expect(linesUnder('AUTH', from).map(({ level, message }) => ({ level, message }))).toEqual([
				{ level: 'ERROR', message: 'Ended sessions could not be cleared' }
			]);
			expect(sessionRows().map((row) => row.id)).toEqual([sessionHashOf('ended')]);

			vi.advanceTimersByTime(SESSION_SWEEP_EVERY_MS);
			expect(sessionRows()).toEqual([]);
		} finally {
			stopSessionSweep();
		}
	});
});

describe('endPlainSessions, at every start', () => {
	it('T13: ends the sessions an older image wrote in plain, leaves those in hash form, says so once, and the next start does nothing', () => {
		const user = makeUser();
		const { token } = createSession(user.id, { twoStep: 1 });
		sqlite
			.prepare('INSERT INTO sessions (id, user_id, expires_at, two_step) VALUES (?, ?, ?, 0)')
			.run('session-of-an-older-image', user.id, stamp(new Date(Date.now() + HOUR)));
		const from = lastLogId();

		expect(endPlainSessions()).toBe(1);
		expect(sessionRows().map((row) => row.id)).toEqual([sessionHashOf(token)]);
		expect(linesUnder('AUTH', from)).toEqual([
			{
				level: 'WARN',
				message: 'Ended 1 session(s) held in plain, written by an older image: those browsers sign in again.',
				meta: null
			}
		]);

		const again = lastLogId();
		expect(endPlainSessions()).toBe(0);
		expect(sessionRows().map((row) => row.id)).toEqual([sessionHashOf(token)]);
		expect(linesUnder('AUTH', again)).toEqual([]);
	});

	it('T14: cannot keep the server from starting: a failure is said at WARN, null is returned, and nothing is thrown', () => {
		process.env.LOG_LEVEL = 'WARN';
		const said = vi.mocked(console.warn);
		said.mockClear();
		const prepare = vi.spyOn(sqlite, 'prepare').mockImplementation(() => {
			throw new Error('the database is not to be had');
		});

		let lines: string[];
		try {
			expect(endPlainSessions()).toBeNull();
			lines = said.mock.calls.map(([line]) => String(line));
		} finally {
			// Before the check after every test, which reads the database.
			prepare.mockRestore();
		}

		expect(lines).toEqual([
			expect.stringMatching(/\[WARN\] \[AUTH\] Sessions held in plain by an older image could not be ended: the database is not to be had\./)
		]);
	});
});

describe('the session cookie', () => {
	const HTML = { accept: 'text/html' };
	type Row = {
		/** Cookies HTTPS-only (`COOKIE_SECURE=true`), or plain HTTP with it unset. */
		secure: boolean;
		/** The `Cookie` header, given a live code. */
		cookie: (live: string) => string;
		signedIn: boolean;
		/** Whether the answer deletes a cookie of the plain name. */
		deletes: boolean;
	};
	const NOT_A_CODE = 'not-a-uuid';

	it.each<[string, Row]>([
		[
			'HTTPS-only, a cookie of the plain name alone: sent to sign in by the gate’s own answer, which deletes it',
			{ secure: true, cookie: (live) => `${SESSION_COOKIE_NAME}=${live}`, signedIn: false, deletes: true }
		],
		[
			'HTTPS-only, two of the name in force, the live one first: not signed in, and neither is looked up',
			{
				secure: true,
				cookie: (live) => `${SECURE_SESSION_COOKIE_NAME}=${live}; ${SECURE_SESSION_COOKIE_NAME}=${crypto.randomUUID()}`,
				signedIn: false,
				deletes: false
			}
		],
		[
			'HTTPS-only, one not in a code’s shape whose hash is a session: not signed in, and not looked up',
			{ secure: true, cookie: () => `${SECURE_SESSION_COOKIE_NAME}=${NOT_A_CODE}`, signedIn: false, deletes: false }
		],
		[
			'HTTPS-only, one live one of the name in force: signed in',
			{ secure: true, cookie: (live) => `${SECURE_SESSION_COOKIE_NAME}=${live}`, signedIn: true, deletes: false }
		],
		[
			'HTTPS-only, the live one of the name in force beside one of the plain name: signed in, and the plain one deleted',
			{
				secure: true,
				cookie: (live) => `${SESSION_COOKIE_NAME}=${crypto.randomUUID()}; ${SECURE_SESSION_COOKIE_NAME}=${live}`,
				signedIn: true,
				deletes: true
			}
		],
		[
			'plain HTTP, a live one of the plain name: signed in, and nothing deleted',
			{ secure: false, cookie: (live) => `${SESSION_COOKIE_NAME}=${live}`, signedIn: true, deletes: false }
		]
	])('T15: %s', async (_what, row) => {
		if (row.secure) process.env.COOKIE_SECURE = 'true';
		else delete process.env.COOKIE_SECURE;
		const user = makeUser();
		const live = makeSession(user);
		// A session whose code is not one: a value in no code's shape is never looked up.
		sqlite
			.prepare('INSERT INTO sessions (id, user_id, expires_at, two_step) VALUES (?, ?, ?, 1)')
			.run(sessionHashOf(NOT_A_CODE), user.id, stamp(new Date(Date.now() + HOUR)));
		const from = lastLogId();

		const res = await gate('GET', '/', { headers: { ...HTML, cookie: row.cookie(live) } });

		if (row.signedIn) {
			expect(res.status).toBe(200);
		} else {
			expect({ status: res.status, location: res.headers.get('location') }).toEqual({ status: 303, location: '/login' });
		}
		const deletion = res.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
		if (row.deletes) expect(deletion).toMatch(/^dumpfire_session=;.*Max-Age=0.*Secure/);
		else expect(deletion).toBeUndefined();
		expect(linesUnder('AUTH', from).map((line) => line.message).filter((message) => message.includes('token not in DB'))).toEqual([]);
	});

	it('T16: sign-out through the gate ends the session by its hash, and deletes the __Host- cookie with Secure and Path=/', async () => {
		process.env.COOKIE_SECURE = 'true';
		const user = makeUser();
		const live = makeSession(user);

		const res = await signOut(`${SECURE_SESSION_COOKIE_NAME}=${live}`);

		expect(res.headers.get('location')).toBe('/login');
		const deletion = res.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SECURE_SESSION_COOKIE_NAME}=`));
		expect(deletion).toMatch(/Max-Age=0/i);
		expect(deletion).toMatch(/; Secure/i);
		expect(deletion).toMatch(/; Path=\//i);
		expect(sessionRow(live)).toBeUndefined();
	});

	it('T16b: sign-out with two cookies of the name in force, a planted one beside the real one, ends both sessions, says so once by reference, and clears the cookie', async () => {
		process.env.COOKIE_SECURE = 'true';
		const real = makeSession(makeUser());
		const planted = makeSession(makeUser());
		const from = lastLogId();

		const res = await signOut(`${SECURE_SESSION_COOKIE_NAME}=${planted}; ${SECURE_SESSION_COOKIE_NAME}=${real}`);

		expect(res.headers.get('location')).toBe('/login');
		expect(res.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SECURE_SESSION_COOKIE_NAME}=;`))).toMatch(/Max-Age=0/i);
		expect(sessionRow(real)).toBeUndefined();
		expect(sessionRow(planted)).toBeUndefined();
		const lines = linesUnder('AUTH', from);
		const warned = lines.filter((line) => line.message === 'Session cookie sent 2 times — no session read from it');
		expect(warned.map((line) => ({ level: line.level, meta: JSON.parse(line.meta!) }))).toEqual([
			{ level: 'WARN', meta: { sessionRefs: [refOf(planted), refOf(real)] } }
		]);
		expect(JSON.stringify(lines)).not.toContain(real);
		expect(JSON.stringify(lines)).not.toContain(planted);
	});
});

describe('where the code goes', () => {
	it('T17: no file under src but auth.ts names the cookie, none but the gate reads it or checks a code, and none reads it some other way', () => {
		const root = join(process.cwd(), 'src');
		const files = (readdirSync(root, { recursive: true }) as string[])
			.filter((file) => file.endsWith('.ts'))
			.map((file) => relative(process.cwd(), join(root, file)).split(sep).join('/'));
		const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
		const matching = (pattern: RegExp) => files.filter((file) => pattern.test(source(file)));
		const AUTH = 'src/lib/server/auth.ts';

		expect(matching(/SESSION_COOKIE_NAME|dumpfire_session/)).toEqual([AUTH]);
		expect(matching(/(?<!function )\breadSessionCookie\(/)).toEqual(['src/hooks.server.ts']);
		expect(matching(/(?<!function )\bvalidateSession\(/).filter((file) => file !== AUTH)).toEqual(['src/hooks.server.ts']);
		expect(matching(/cookies\.get\(\s*sessionCookieName/)).toEqual([]);
		expect(matching(/\b(onlyCookieValue|cookieValues)\([^)]*sessionCookieName/).filter((file) => file !== AUTH)).toEqual([]);
	});

	it('T18: the log names each session by a reference from its hash, and never by its code or any 8 characters of it', async () => {
		clockAt(T0);
		const user = makeUser();
		const factor = giveFactor(user);
		const from = lastLogId();
		const page = (code: string) => gate('GET', '/', { headers: { accept: 'text/html', cookie: `${SESSION_COOKIE_NAME}=${code}` } });

		// A sign-in, and a second session; the first signed out before its end.
		const { session: signedOut } = await signInFully(user, factor);
		const expired = makeSession(user);
		vi.setSystemTime(T0 + HOUR);
		expect((await signOut(`${SESSION_COOKIE_NAME}=${signedOut}`)).headers.get('location')).toBe('/login');
		// A code that names no session.
		const unknown = crypto.randomUUID();
		expect((await page(unknown)).headers.get('location')).toBe('/login');
		// The second, used after its idle limit of three days.
		vi.setSystemTime(T0 + 3 * DAY + 1000);
		expect((await page(expired)).headers.get('location')).toBe('/login');

		const lines = linesUnder('AUTH', from);
		for (const secret of [signedOut, expired, unknown]) {
			expect(JSON.stringify(lines)).not.toContain(secret);
			expect(JSON.stringify(lines)).not.toContain(secret.slice(0, 8));
		}
		const refsOf = (start: string) =>
			lines.filter((line) => line.message.startsWith(start)).map((line) => (JSON.parse(line.meta!) as { sessionRef: string }).sessionRef);
		expect(refsOf('Session created for user')).toEqual([refOf(signedOut), refOf(expired)]);
		expect(refsOf('Session deleted (user logout)')).toEqual([refOf(signedOut)]);
		expect(refsOf('Session validation failed — token not in DB')).toEqual([refOf(unknown)]);
		expect(refsOf('Session validation failed — session expired')).toEqual([refOf(expired)]);
		expect(JSON.stringify(lines)).not.toContain('tokenPrefix');
	});
});

describe('what keeps a session alive', () => {
	it.each<[string, (code: string) => Promise<void>, boolean]>([
		[
			'a GET without Sec-Fetch-Mode: navigate, a poll or a stream opening, does not move the expiry',
			async (code) => {
				const cookie = `${SESSION_COOKIE_NAME}=${code}`;
				expect((await gate('GET', '/api/requests', { headers: { cookie, accept: 'application/json' } })).status).toBe(200);
				const stream = await gate('GET', '/api/events', { headers: { cookie, accept: 'text/event-stream' } });
				expect(stream.status).toBe(200);
				await stream.body!.cancel();
			},
			false
		],
		[
			'a navigation moves it',
			async (code) => {
				const headers = { cookie: `${SESSION_COOKIE_NAME}=${code}`, accept: 'text/html', 'sec-fetch-mode': 'navigate' };
				expect((await gate('GET', '/', { headers })).status).toBe(200);
			},
			true
		],
		[
			'a write from the page, past the same-origin check, moves it',
			async (code) => {
				const headers = { cookie: `${SESSION_COOKIE_NAME}=${code}`, ...FROM_THE_PAGE, accept: 'application/json' };
				// Refused by the route for what it carries: the gate let it in, as its holder's.
				expect((await gate('POST', '/api/cards', { headers, body: {} })).status).toBe(400);
			},
			true
		]
	])('T19: %s', async (_what, request, moves) => {
		const user = makeUser({ role: 'admin' });
		const code = makeSession(user);
		const held = stamp(new Date(Date.now() + HOUR));
		setSession(code, { expiresAt: held });

		await request(code);

		expect(sessionRow(code)?.expiresAt !== held).toBe(moves);
	});
});

describe('a password the record of account endings says was replaced here (card 2997)', () => {
	it('(r) card 2997: createSession refuses an account but the superadmin whose hash is recorded replaced with AccountDisabled, writing nothing; a superadmin with its exact here row is let in', () => {
		const ann = makeUser({ username: 'ann' });
		const bob = makeUser({ username: 'bob' });
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		inTransaction(() => {
			recordPasswordReplaced(sqlite, ann.id);
			recordPasswordReplaced(sqlite, chief.id);
		});

		expect(() => createSession(ann.id, { twoStep: 1 })).toThrow(AccountDisabled);
		expect(sessionRows()).toEqual([]);
		// Another account, whose hash is not recorded, is let in; and so is the superadmin.
		expect(() => createSession(bob.id, { twoStep: 1 })).not.toThrow();
		expect(() => createSession(chief.id, { twoStep: 1 })).not.toThrow();
		expect(sessionRows().map((row) => row.user_id)).toEqual([bob.id, chief.id]);
	});
});

// ─── Card 3064, slice S2: two-step sign-in's switch, and the sessions of the compatibility release ───

describe('two-step sign-in dormant, and the sessions the compatibility release kept (card 3064, S2)', () => {
	/** The moment of the compatibility release in these cases. */
	const RELEASE = T0;
	/** The moment of the compatibility release, as migration 0084 writes it. */
	const released = (at: number) =>
		sqlite
			.prepare("INSERT INTO settings (key, value) VALUES ('compatibility_release_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
			.run(stamp(new Date(at)));
	/**
	 * A session 0084 kept for `user`, as it leaves one: its code a UUID as live made it, held as its hash, made at the
	 * release, its expiry capped at 30 days on, `two_step` 0 and marked 1. Answers its code.
	 */
	const kept = (user: SessionUser, { expiresAt = stamp(new Date(RELEASE + 30 * DAY)), mark = 1 }: { expiresAt?: string; mark?: number } = {}) => {
		const code = crypto.randomUUID();
		sqlite
			.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at, two_step, kept_at_release) VALUES (?, ?, ?, ?, 0, ?)')
			.run(sessionHashOf(code), user.id, expiresAt, stamp(new Date(RELEASE)), mark);
		return code;
	};
	/** A `Cookie` header with `code` under the session cookie's name from before card 2775. */
	const oldName = (code: string) => `${SESSION_COOKIE_NAME}=${code}`;
	/** GET / through the gate, as a browser's page, with the `Cookie` header `cookie`. */
	const page = (cookie: string, headers: Record<string, string> = {}) => gate('GET', '/', { headers: { accept: 'text/html', cookie, ...headers } });
	/** The cookies of the secure name an answer sets. */
	const secureSet = (res: Response) => res.headers.getSetCookie().filter((cookie) => cookie.startsWith(`${SECURE_SESSION_COOKIE_NAME}=`));
	/** The cookies of the old name an answer sets: deletions. */
	const oldSet = (res: Response) => res.headers.getSetCookie().filter((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
	/** Where an answer sends its caller. */
	const sentTo = (res: Response) => ({ status: res.status, location: res.headers.get('location') });
	/** The code a cookie of the secure name sets. */
	const codeIn = (cookie: string) => cookie.slice(`${SECURE_SESSION_COOKIE_NAME}=`.length).split(';')[0];
	/** The account the gate's own line for its last answer names. */
	const lastAnswerBy = () => sqlite.prepare("SELECT user_id FROM system_logs WHERE context = 'HTTP' ORDER BY id DESC LIMIT 1").pluck().get();
	/** The holder's own password change through the gate, over plain HTTP, the cookie of the name in force there being the plain one. */
	const ownPasswordChange = (code: string) =>
		gate('PUT', '/api/account/password', {
			headers: { cookie: `${SESSION_COOKIE_NAME}=${code}`, ...FROM_THE_PAGE, accept: 'application/json' },
			body: { currentPassword: FIXTURE_PASSWORD, newPassword: 'another password for the account' }
		});
	/** The code of the session a password change's answer sets, under the plain name. */
	const replacementIn = (res: Response) =>
		res.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`))!.slice(`${SESSION_COOKIE_NAME}=`.length).split(';')[0];

	beforeEach(() => {
		makeTwoStepDormant();
	});

	describe('the switch', () => {
		it('T23: twoStepRequired is false with no row, and true with one, whether it names a moment or not', () => {
			expect(twoStepRequired()).toBe(false);
			for (const value of ['2026-11-25 10:00:00', 'not a moment', '']) {
				sqlite
					.prepare("INSERT INTO settings (key, value) VALUES ('two_step_required_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
					.run(value);
				expect(twoStepRequired(), JSON.stringify(value)).toBe(true);
			}
		});
	});

	describe('a session made on a password alone', () => {
		it('T24: dormant, of an account with no factor, opens and slides', () => {
			clockAt(T0);
			const user = makeUser();
			const { token } = createSession(user.id, { twoStep: 0 });

			vi.setSystemTime(T0 + 10 * DAY);
			expect(validateSession(token)?.user.id).toBe(user.id);
			expect(sessionRow(token)).toMatchObject({ twoStep: 0, expiresAt: stamp(new Date(T0 + 40 * DAY)) });
		});

		it('T25: required, is refused and deleted, and said once at WARN', () => {
			const user = makeUser();
			const { token } = createSession(user.id, { twoStep: 0 });
			writeRequiredSettings();
			const from = lastLogId();

			expect(validateSession(token)).toBeNull();
			expect(sessionRow(token)).toBeUndefined();
			expect(linesUnder('AUTH', from).map(({ level, message }) => ({ level, message }))).toEqual([
				{ level: 'WARN', message: 'A hashed session row with two_step 0 — refused and deleted' }
			]);
			expect(lastMeta('A hashed session row with two_step 0', from)).toEqual({ sessionRef: refOf(token), because: 'two-step sign-in is required' });
		});

		it('T56: dormant, of an account that now holds a factor, is refused and deleted; its two-step session is not', () => {
			const user = makeUser();
			const { token } = createSession(user.id, { twoStep: 0 });
			const twoStep = createSession(user.id, { twoStep: 1 }).token;
			giveFactor(user);
			const from = lastLogId();

			expect(validateSession(token)).toBeNull();
			expect(sessionRow(token)).toBeUndefined();
			expect(lastMeta('A hashed session row with two_step 0', from)).toEqual({ sessionRef: refOf(token), because: 'the account holds a second factor' });
			expect(validateSession(twoStep)?.user.id).toBe(user.id);
		});
	});

	describe('the dormant limits: 30 days idle and 90 in all, for every role, for a session made on a password alone', () => {
		it('T26: an administrator’s password-only session idle 29 days opens; one idle 31 days has ended', () => {
			clockAt(T0);
			const admin = makeUser({ role: 'admin' });
			const idle29 = createSession(admin.id, { twoStep: 0 }).token;
			const idle31 = createSession(admin.id, { twoStep: 0 }).token;

			vi.setSystemTime(T0 + 29 * DAY);
			expect(validateSession(idle29, { slide: false })?.user.id).toBe(admin.id);
			vi.setSystemTime(T0 + 31 * DAY);
			const from = lastLogId();
			expect(validateSession(idle31)).toBeNull();
			expect(linesUnder('AUTH', from).map((line) => line.message)).toEqual(['Session validation failed — session expired']);
		});

		it('T27: a password-only session used every 25 days slides no further than 90 days from its start, and has ended a second after', () => {
			clockAt(T0);
			const admin = makeUser({ role: 'admin' });
			const { token } = createSession(admin.id, { twoStep: 0 });
			for (const at of [25 * DAY, 50 * DAY, 75 * DAY, 89 * DAY]) {
				vi.setSystemTime(T0 + at);
				expect(validateSession(token)?.user.id, `used at ${at / DAY} days`).toBe(admin.id);
			}
			expect(sessionRow(token)?.expiresAt).toBe(stamp(new Date(T0 + 90 * DAY)));

			vi.setSystemTime(T0 + 90 * DAY + 1000);
			expect(validateSession(token)).toBeNull();
		});

		it('T28: the clean-up keeps a kept session with its expiry 30 days on while dormant, and deletes it once required', () => {
			clockAt(RELEASE);
			const admin = makeUser({ role: 'admin' });
			const code = kept(admin, { expiresAt: stamp(new Date(RELEASE + 30 * DAY)) });

			cleanExpiredSessions();
			expect(sessionRow(code)).toBeDefined();

			writeRequiredSettings();
			cleanExpiredSessions();
			expect(sessionRow(code)).toBeUndefined();
		});

		it('T29: createSession writes the two_step it is given; dormant, it gives an administrator a password-only session started 3 days ago, and refuses one made with a code, whose limits are the administrator’s whatever the switch', () => {
			clockAt(T0);
			const admin = makeUser({ role: 'admin' });
			const threeDaysAgo = stamp(new Date(T0 - 3 * DAY));

			const passwordOnly = createSession(admin.id, { twoStep: 0 });
			const twoStep = createSession(admin.id, { twoStep: 1 });
			const started = createSession(admin.id, { twoStep: 0, startedAt: threeDaysAgo });

			expect(sessionRow(passwordOnly.token)?.twoStep).toBe(0);
			expect(sessionRow(twoStep.token)).toMatchObject({ twoStep: 1, expiresAt: stamp(new Date(T0 + 12 * HOUR)) });
			expect(sessionRow(started.token)).toMatchObject({ createdAt: threeDaysAgo, expiresAt: stamp(new Date(T0 + 30 * DAY)), twoStep: 0 });
			expect(() => createSession(admin.id, { twoStep: 1, startedAt: threeDaysAgo })).toThrow('past its total limit');
		});

		it('CS-L2: dormant, a session made with a code keeps card 2775’s limits: an administrator’s has ended after 12 hours idle and 24 in all, a user’s after 3 days idle; the clean-up deletes each by them', () => {
			clockAt(T0);
			const admin = makeUser({ role: 'admin' });
			const user = makeUser();
			const adminIdle = createSession(admin.id, { twoStep: 1 }).token;
			const adminUsed = createSession(admin.id, { twoStep: 1 }).token;
			const userIdle = createSession(user.id, { twoStep: 1 }).token;
			const passwordOnly = createSession(admin.id, { twoStep: 0 }).token;
			expect(twoStepRequired()).toBe(false);

			vi.setSystemTime(T0 + 11 * HOUR);
			expect(validateSession(adminUsed)?.user.id).toBe(admin.id);
			vi.setSystemTime(T0 + 12 * HOUR + 1000);
			expect(validateSession(adminIdle, { slide: false })).toBeNull();
			expect(validateSession(adminUsed)?.user.id).toBe(admin.id);
			vi.setSystemTime(T0 + 24 * HOUR + 1000);
			expect(validateSession(adminUsed)).toBeNull();
			vi.setSystemTime(T0 + 3 * DAY + 1000);
			// Two administrator sessions started 25 hours ago and used an hour ago: the one made with a code is past its 24 hours
			// in all, the password-only one is not.
			const now = T0 + 3 * DAY + 1000;
			const started25h = (twoStep: number) => {
				const code = crypto.randomUUID();
				sqlite
					.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at, two_step) VALUES (?, ?, ?, ?, ?)')
					.run(sessionHashOf(code), admin.id, stamp(new Date(now + 11 * HOUR)), stamp(new Date(now - 25 * HOUR)), twoStep);
				return code;
			};
			const withCode25h = started25h(1);
			const passwordOnly25h = started25h(0);
			cleanExpiredSessions();
			expect(sessionRow(userIdle)).toBeUndefined();
			expect(sessionRow(withCode25h)).toBeUndefined();
			expect(sessionRow(passwordOnly25h)).toBeDefined();
			// The password-only session, idle all the while, has the dormant limits.
			expect(validateSession(passwordOnly)?.user.id).toBe(admin.id);
		});

		it('CS-L3: createSession makes no session on a password alone once two-step sign-in is required, or for an account holding a factor, and writes nothing', () => {
			const user = makeUser();
			const holder = makeUser();
			giveFactor(holder);
			const before = sessionRows();

			expect(() => createSession(holder.id, { twoStep: 0 })).toThrow('only while two-step sign-in is dormant, for an account with no second factor');
			writeRequiredSettings();
			expect(() => createSession(user.id, { twoStep: 0 })).toThrow('only while two-step sign-in is dormant, for an account with no second factor');
			expect(sessionRows()).toEqual(before);
			// A session made with a code is made, whatever the switch.
			expect(() => createSession(holder.id, { twoStep: 1 })).not.toThrow();
		});
	});

	describe('the holder’s own password change', () => {
		// Through the real step-up, the current password alone: an account with no factor while dormant (R6, S3a).
		it('T30: from a session made on a password alone, gives a session made on a password alone', async () => {
			delete process.env.COOKIE_SECURE;
			const user = makeUser();
			const { token } = createSession(user.id, { twoStep: 0 });

			const res = await ownPasswordChange(token);

			expect(res.status).toBe(200);
			const replacement = replacementIn(res);
			expect(sessionRow(token)).toBeUndefined();
			expect(sessionRow(replacement)).toMatchObject({ userId: user.id, twoStep: 0 });
		});

		it('T61: from an administrator’s session kept at the release, three days after it, succeeds, keeping the release as its start', async () => {
			delete process.env.COOKIE_SECURE;
			clockAt(RELEASE + 3 * DAY);
			released(RELEASE);
			const admin = makeUser({ role: 'admin' });
			const code = kept(admin);

			const res = await ownPasswordChange(code);

			expect(res.status).toBe(200);
			const replacement = replacementIn(res);
			expect(sessionRow(code)).toBeUndefined();
			expect(sessionRow(replacement)).toMatchObject({ userId: admin.id, createdAt: stamp(new Date(RELEASE)), twoStep: 0, keptAtRelease: 0 });
		});
	});

	describe('the session cookie’s name from before card 2775, for a kept session', () => {
		beforeEach(() => {
			process.env.COOKIE_SECURE = 'true';
		});

		it('T31: over HTTPS with no cookie of the secure name, a kept session’s code signs in and is swapped: the old row marked 2 for 60 seconds, a new one with a new code, its start and two_step 0; the answer sets the new code under the secure name and deletes the old', async () => {
			clockAt(RELEASE + 2 * DAY);
			released(RELEASE);
			const user = makeUser();
			const code = kept(user);
			const from = lastLogId();

			const res = await page(oldName(code));

			expect(res.status).toBe(200);
			expect(lastAnswerBy()).toBe(user.id);
			const issued = secureSet(res);
			expect(issued).toHaveLength(1);
			const shape = /^__Host-dumpfire_session=([0-9a-f-]{36}); Path=\/; Max-Age=(\d+); HttpOnly; Secure; SameSite=Lax$/.exec(issued[0]);
			expect(shape, issued[0]).not.toBeNull();
			const [, fresh, maxAge] = shape!;
			expect(fresh).not.toBe(code);
			// To the session's total limit: 90 days from the release.
			expect(Number(maxAge)).toBe((88 * DAY) / 1000);
			expect(oldSet(res)[0]).toMatch(/^dumpfire_session=; Path=\/; Max-Age=0; Secure/);
			expect(sessionRow(code)).toMatchObject({ twoStep: 0, keptAtRelease: 2, expiresAt: stamp(new Date(RELEASE + 2 * DAY + 60 * 1000)) });
			expect(sessionRow(fresh)).toMatchObject({
				userId: user.id,
				createdAt: stamp(new Date(RELEASE)),
				twoStep: 0,
				keptAtRelease: 0,
				expiresAt: stamp(new Date(RELEASE + 32 * DAY))
			});
			expect(lastMeta('Session of the old cookie name swapped to a new code under the secure name', from)).toEqual({
				sessionRef: refOf(code),
				newSessionRef: refOf(fresh)
			});
			// The new code signs in under the secure name.
			expect((await page(`${SECURE_SESSION_COOKIE_NAME}=${fresh}`)).status).toBe(200);
		});

		it('T32: refused for a session not marked kept, even one started at the release moment itself: not signed in, nothing written', async () => {
			clockAt(RELEASE + DAY);
			released(RELEASE);
			const user = makeUser();
			const { token } = createSession(user.id, { twoStep: 0, startedAt: stamp(new Date(RELEASE)) });
			const before = sessionRow(token);
			expect(before).toMatchObject({ createdAt: stamp(new Date(RELEASE)), twoStep: 0, keptAtRelease: 0 });
			const from = lastLogId();

			const res = await page(oldName(token));

			expect(sentTo(res)).toEqual({ status: 303, location: '/login' });
			expect(secureSet(res)).toEqual([]);
			expect(sessionRows()).toHaveLength(1);
			expect(sessionRow(token)).toEqual(before);
			expect(linesUnder('AUTH', from).map((line) => line.message)).toContain(
				'Session cookie of the old name names a session not kept at the release — refused'
			);
		});

		it('T33: refused once two-step sign-in is required, before the session is looked up', async () => {
			clockAt(RELEASE + DAY);
			released(RELEASE);
			const code = kept(makeUser());
			writeRequiredSettings();
			const before = sessionRow(code);
			const from = lastLogId();

			const res = await page(oldName(code));

			expect(sentTo(res)).toEqual({ status: 303, location: '/login' });
			expect(secureSet(res)).toEqual([]);
			expect(sessionRow(code)).toEqual(before);
			expect(linesUnder('AUTH', from).map((line) => line.message)).toContain(
				'Session cookie of the old name refused: two-step sign-in is required on this server'
			);
		});

		it('T57: within its 60 seconds, the swapped row by the old name is accepted as it is, with no second swap, no slide and no new cookie; after them, refused', async () => {
			clockAt(RELEASE + DAY);
			released(RELEASE);
			const user = makeUser();
			const code = kept(user);
			expect(secureSet(await page(oldName(code)))).toHaveLength(1);
			const swapped = sessionRow(code);
			expect(swapped?.keptAtRelease).toBe(2);

			// A navigation, which slides an ordinary session, from a tab that sent it before the new cookie arrived.
			vi.setSystemTime(RELEASE + DAY + 59 * 1000);
			const again = await page(oldName(code), { 'sec-fetch-mode': 'navigate' });
			expect(again.status).toBe(200);
			expect(lastAnswerBy()).toBe(user.id);
			expect(secureSet(again)).toEqual([]);
			expect(sessionRow(code)).toEqual(swapped);
			expect(sessionRows()).toHaveLength(2);

			vi.setSystemTime(RELEASE + DAY + 60 * 1000);
			const after = await page(oldName(code));
			expect(sentTo(after)).toEqual({ status: 303, location: '/login' });
			expect(secureSet(after)).toEqual([]);
			expect(sessionRows()).toHaveLength(2);
		});

		it('T58: a sign-out by the old name is answered with its own clearing of the session cookie, and no new code under it', async () => {
			clockAt(RELEASE + DAY);
			released(RELEASE);
			const code = kept(makeUser());

			const res = await signOut(oldName(code));

			expect(res.headers.get('location')).toBe('/login');
			const secure = secureSet(res);
			expect(secure).toHaveLength(1);
			expect(secure[0]).toMatch(/^__Host-dumpfire_session=;.*Max-Age=0/i);
			expect(oldSet(res)).not.toEqual([]);
			// The session the swap made is signed out, and the kept row the old name still names with it (F22).
			expect(sessionRows()).toEqual([]);
		});

		it('F22: a sign-out by the old name ends the kept session its code names as well: within the 60 seconds the code signs nobody in again', async () => {
			clockAt(RELEASE + DAY);
			released(RELEASE);
			const user = makeUser();
			const other = makeSession(makeUser());
			const code = kept(user);
			const from = lastLogId();

			expect((await signOut(oldName(code))).headers.get('location')).toBe('/login');

			// Both the session the swap made and the swapped row are gone, each said once; another account's is untouched.
			expect(sessionRow(code)).toBeUndefined();
			expect(sessionRows().map((row) => row.user_id)).toEqual([sessionRow(other)!.userId]);
			expect(linesUnder('AUTH', from).filter((line) => line.message.startsWith('Session deleted'))).toHaveLength(2);
			vi.setSystemTime(RELEASE + DAY + 30 * 1000);
			const again = await page(oldName(code));
			expect(sentTo(again)).toEqual({ status: 303, location: '/login' });
			expect(secureSet(again)).toEqual([]);
		});

		it('a swapped row’s code (kept_at_release 2) sent under the secure name is not slid: its 60 seconds stay its last', async () => {
			clockAt(RELEASE + DAY);
			released(RELEASE);
			const user = makeUser();
			const code = kept(user);
			expect(secureSet(await page(oldName(code)))).toHaveLength(1);
			const swapped = sessionRow(code);
			expect(swapped).toMatchObject({ keptAtRelease: 2, expiresAt: stamp(new Date(RELEASE + DAY + 60 * 1000)) });

			// A navigation, which slides an ordinary session, by the secure name.
			vi.setSystemTime(RELEASE + DAY + 30 * 1000);
			const res = await page(`${SECURE_SESSION_COOKIE_NAME}=${code}`, { 'sec-fetch-mode': 'navigate' });
			expect(res.status).toBe(200);
			expect(lastAnswerBy()).toBe(user.id);
			expect(sessionRow(code)).toEqual(swapped);

			vi.setSystemTime(RELEASE + DAY + 60 * 1000);
			expect(sentTo(await page(`${SECURE_SESSION_COOKIE_NAME}=${code}`))).toEqual({ status: 303, location: '/login' });
		});

		it('CS-M1: a kept session’s code (mark 1) sent under the secure name is swapped as by the old name, never slid; past the 30 days it is refused, nothing written', async () => {
			clockAt(RELEASE + DAY);
			released(RELEASE);
			const user = makeUser();
			const code = kept(user);
			const from = lastLogId();

			// A navigation, which slides an ordinary session.
			const res = await page(`${SECURE_SESSION_COOKIE_NAME}=${code}`, { 'sec-fetch-mode': 'navigate' });

			expect(res.status).toBe(200);
			expect(lastAnswerBy()).toBe(user.id);
			const issued = secureSet(res);
			expect(issued).toHaveLength(1);
			const fresh = codeIn(issued[0]);
			expect(fresh).not.toBe(code);
			expect(sessionRow(code)).toMatchObject({ keptAtRelease: 2, expiresAt: stamp(new Date(RELEASE + DAY + 60 * 1000)) });
			expect(sessionRow(fresh)).toMatchObject({ userId: user.id, createdAt: stamp(new Date(RELEASE)), twoStep: 0, keptAtRelease: 0 });
			expect(lastMeta('Session kept at the release, sent under the secure name, swapped to a new code', from)).toEqual({
				sessionRef: refOf(code),
				newSessionRef: refOf(fresh)
			});

			// Another kept session, first sent under the secure name 30 days and a second after the release.
			vi.setSystemTime(RELEASE + 30 * DAY + 1000);
			const late = kept(user, { expiresAt: stamp(new Date(RELEASE + 40 * DAY)) });
			const before = sessionRow(late);
			const lateFrom = lastLogId();
			const refused = await page(`${SECURE_SESSION_COOKIE_NAME}=${late}`, { 'sec-fetch-mode': 'navigate' });
			expect(sentTo(refused)).toEqual({ status: 303, location: '/login' });
			expect(secureSet(refused)).toEqual([]);
			expect(sessionRow(late)).toEqual(before);
			expect(linesUnder('AUTH', lateFrom).map((line) => line.message)).toContain(
				'Session kept at the release refused: more than 30 days have passed since the compatibility release'
			);
		});

		it('CR-L5: the old name is deleted on the answer that swaps it and on one that refuses it, never on an answer that accepted it in its last 60 seconds', async () => {
			clockAt(RELEASE + DAY);
			released(RELEASE);
			const code = kept(makeUser());

			const swap = await page(oldName(code));
			expect(secureSet(swap)).toHaveLength(1);
			expect(oldSet(swap)).not.toEqual([]);

			vi.setSystemTime(RELEASE + DAY + 30 * 1000);
			const within = await page(oldName(code));
			expect(within.status).toBe(200);
			expect(secureSet(within)).toEqual([]);
			expect(oldSet(within)).toEqual([]);

			vi.setSystemTime(RELEASE + DAY + 60 * 1000);
			const after = await page(oldName(code));
			expect(sentTo(after)).toEqual({ status: 303, location: '/login' });
			expect(oldSet(after)).not.toEqual([]);
		});

		it('T64: refused 30 days and a second after the release, for a kept session still open; 30 days less a second after it, swapped', async () => {
			released(RELEASE);
			const user = makeUser();
			clockAt(RELEASE + 30 * DAY - 1000);
			const early = kept(user, { expiresAt: stamp(new Date(RELEASE + 40 * DAY)) });
			expect(secureSet(await page(oldName(early)))).toHaveLength(1);

			vi.setSystemTime(RELEASE + 30 * DAY + 1000);
			const late = kept(user, { expiresAt: stamp(new Date(RELEASE + 40 * DAY)) });
			expect(openSessionUser(sessionHashOf(late))?.id).toBe(user.id);
			const before = sessionRow(late);
			const from = lastLogId();

			const res = await page(oldName(late));

			expect(sentTo(res)).toEqual({ status: 303, location: '/login' });
			expect(secureSet(res)).toEqual([]);
			expect(sessionRow(late)).toEqual(before);
			expect(linesUnder('AUTH', from).map((line) => line.message)).toContain(
				'Session cookie of the old name refused: more than 30 days have passed since the compatibility release'
			);
		});

		it.each([
			[
				'https://dumpfire.elecfron.com',
				[
					'dumpfire_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
					'dumpfire_session=; Domain=elecfron.com; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax'
				]
			],
			['https://elecfron.com', ['dumpfire_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax']]
		])('T65: with ORIGIN %s, the old name is deleted with no Domain, and with the host’s parent domain where it has one', async (at, deletions) => {
			process.env.ORIGIN = at;

			const res = await page(oldName(crypto.randomUUID()));

			expect(oldSet(res)).toEqual(deletions);
		});

		it('T70: a request sending both names is signed in by the secure one and the kept session is not swapped; with a secure one that is no code, nobody is', async () => {
			clockAt(RELEASE + DAY);
			released(RELEASE);
			const ann = makeUser();
			const bob = makeUser();
			const code = kept(ann);
			const before = sessionRow(code);
			const live = makeSession(bob);

			const both = await page(`${oldName(code)}; ${SECURE_SESSION_COOKIE_NAME}=${live}`);
			expect(both.status).toBe(200);
			expect(lastAnswerBy()).toBe(bob.id);
			expect(secureSet(both)).toEqual([]);
			expect(sessionRow(code)).toEqual(before);

			const notACode = await page(`${oldName(code)}; ${SECURE_SESSION_COOKIE_NAME}=not-a-code`);
			expect(sentTo(notACode)).toEqual({ status: 303, location: '/login' });
			expect(secureSet(notACode)).toEqual([]);
			expect(sessionRow(code)).toEqual(before);
		});

		it('T71: the new code is given on a page’s data and on a live stream’s reconnect', async () => {
			clockAt(RELEASE + DAY);
			released(RELEASE);
			const user = makeUser();
			const forData = kept(user);
			const forStream = kept(user);

			const data = await gate('GET', '/__data.json', { headers: { cookie: oldName(forData) } });
			const stream = await gate('GET', '/api/events', { headers: { cookie: oldName(forStream), accept: 'text/event-stream' } });
			await stream.body!.cancel();

			for (const [res, code] of [
				[data, forData],
				[stream, forStream]
			] as const) {
				expect(res.status).toBe(200);
				const issued = secureSet(res);
				expect(issued, res.url).toHaveLength(1);
				expect(sessionRow(codeIn(issued[0]))).toMatchObject({ userId: user.id, keptAtRelease: 0 });
				expect(sessionRow(code)?.keptAtRelease).toBe(2);
			}
		});
	});
});
