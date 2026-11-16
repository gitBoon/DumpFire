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
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { sessions, users } from '$lib/server/db/schema';
import {
	SECURE_SESSION_COOKIE_NAME,
	SESSION_COOKIE_NAME,
	cleanExpiredSessions,
	createSession,
	openSessionUser,
	sessionStillOpen,
	validateSession,
	type SessionUser
} from '$lib/server/auth';
import { endPlainSessions } from '$lib/server/startup-checks';
import { stamp } from '$lib/timestamps';
import { api } from './helpers/api';
import { FROM_THE_PAGE, gate } from './helpers/gate';
import { FIXTURE_PASSWORD, makeSession, makeUser, resetDb, sessionHashOf, sessionRow, stepUp } from './helpers/fixtures';
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
});

describe('a session, kept as the hash of its code', () => {
	it('T1: is written as the SHA-256 of the code it returns, found by it, and the stored value is no code', () => {
		const user = makeUser();
		const { token } = createSession(user.id);

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

		const ofUser = createSession(user.id);
		const ofChief = createSession(chief.id);

		expect(ofUser).toMatchObject({ createdAt: stamp(new Date(T0)), role: 'user' });
		expect(ofChief).toMatchObject({ createdAt: stamp(new Date(T0)), role: 'superadmin' });
		expect(sessionRow(ofUser.token)).toMatchObject({ createdAt: stamp(new Date(T0)), expiresAt: stamp(new Date(T0 + 3 * DAY)) });
		expect(sessionRow(ofChief.token)).toMatchObject({ createdAt: stamp(new Date(T0)), expiresAt: stamp(new Date(T0 + 12 * HOUR)) });
	});

	it('T3: an administrator used at 11 hours slides to 11 hours on; unused for 12 hours and a second after that, it has ended and is left', () => {
		clockAt(T0);
		const admin = makeUser({ role: 'admin' });
		const { token } = createSession(admin.id);

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
		const { token } = createSession(user.id);

		for (const at of [2 * DAY, 4 * DAY, 6 * DAY, 6 * DAY + 12 * HOUR]) {
			vi.setSystemTime(T0 + at);
			expect(validateSession(token)?.user.id, `used at ${at / HOUR} hours`).toBe(user.id);
		}
		expect(sessionRow(token)?.expiresAt).toBe(stamp(new Date(T0 + 7 * DAY)));
	});

	it('T5: an administrator used every 11 hours has ended at 24 hours and a second, for every reader', () => {
		clockAt(T0);
		const admin = makeUser({ role: 'admin' });
		const { token, createdAt } = createSession(admin.id);
		for (const at of [11 * HOUR, 22 * HOUR]) {
			vi.setSystemTime(T0 + at);
			expect(validateSession(token)?.user.id).toBe(admin.id);
		}

		vi.setSystemTime(T0 + 24 * HOUR + 1000);
		expect(sessionStillOpen(sessionHashOf(token))).toBe(false);
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
		const { token } = createSession(user.id);
		vi.setSystemTime(T0 + 30 * HOUR);
		setSession(token, { expiresAt: stamp(new Date(T0 + 31 * HOUR)) });
		setRole(user, role);

		expect(validateSession(token) !== null).toBe(open);
	});

	it('T7: a user session made now and its account made an administrator on the host: ended at once, its expiry beyond the new idle limit', () => {
		const user = makeUser();
		const { token } = createSession(user.id);
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
		const { token } = createSession(user.id);
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
		const res = await gate('PUT', '/api/account/password', {
			headers: { cookie: `${SESSION_COOKIE_NAME}=${code}`, ...FROM_THE_PAGE, accept: 'application/json' },
			body: { currentPassword: FIXTURE_PASSWORD, newPassword: 'another password for the account' }
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
			body: { currentPassword: FIXTURE_PASSWORD, newPassword: 'another password for the account' }
		});

		expect({ status: res.status, body: await res.json() }).toEqual({ status: 401, body: { message: 'Not authenticated' } });
		expect(db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, admin.id)).get()).toEqual(before);
		expect(sessionRow(code)).toBeDefined();
		expect(res.headers.getSetCookie().filter((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`))).toEqual([]);
	});

	it('T11: a start that names no moment makes no session: createSession throws and writes nothing', () => {
		const user = makeUser();

		expect(() => createSession(user.id, { startedAt: 'zzz' })).toThrow();
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
});

describe('endPlainSessions, at every start', () => {
	it('T13: ends the sessions an older image wrote in plain, leaves those in hash form, says so once, and the next start does nothing', () => {
		const user = makeUser();
		const { token } = createSession(user.id);
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
