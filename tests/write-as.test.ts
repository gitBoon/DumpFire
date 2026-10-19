/**
 * Who the caller is, asked again at the write (card 2253, slice 1).
 *
 * The gate decides who is calling before the request's body is read, and a
 * body can take as long as the caller likes to arrive. A password reset, a
 * key deleted, a sign-out or a role lowered, committed meanwhile, was met by
 * nothing: the write went through as the caller the gate had read. Now a
 * handler writes through `writeAs(locals, (caller) => …)`, which asks in the
 * transaction that writes whether the key or session is still open and who
 * its account is now, and hands that account to the write; and what cannot
 * run in a transaction asks `stillCallerNow(locals)` last before it. Both are
 * in `src/lib/server/write-as.ts`, and both ask `stillAuthenticated` in
 * `src/lib/server/auth.ts`. The plan is
 * `docs/planning/cards-2250-2251-2253-security.md`.
 *
 * Here:
 *
 *   - what `stillAuthenticated` reads and answers (decisions 2 and 3);
 *   - `writeAs` and `stillCallerNow` themselves;
 *   - the four handlers that asked before this card (the report schedules and
 *     the webhooks) deciding with the account as it is now, and refusing an
 *     ended session on the delete that did not ask at all;
 *   - no credential at all (R10): refused outside the tests, and never
 *     handed on by the gate;
 *   - the report mail's second check, after its PDF is made (R1), pinned
 *     with `it.fails` until slice 2253-4 moves that route.
 *
 * The rule that every write handler goes through them is read from the source
 * in `tests/check-at-the-write.test.ts`. The window itself, a body held while
 * a reset ends the key or session, is walked through the gate in
 * `tests/atomic-accounts.test.ts` ("a create or a change whose body arrives
 * after the reset").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError, json, type RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { apiKeys, reportSchedules, sessions, users, webhooks } from '$lib/server/db/schema';
import { stillAuthenticated, SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { inTransaction } from '$lib/server/db/transaction';
import { stillCallerNow, writeAs } from '$lib/server/write-as';
import { stamp } from '$lib/timestamps';
import { handle } from '../src/hooks.server';
import { api } from './helpers/api';
import { effects } from './helpers/effects';
import { makeApiKey, makeBoard, makeSession, makeSmtp, makeUser, makeWebhook, resetDb } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

/**
 * What SvelteKit's `getRequestEvent` answers: the request a test names, or,
 * as for a handler called with no request around it (`api()`), its refusal.
 * `stillAuthenticated` asks it only to name the request in R10's log line.
 */
const sveltekit = vi.hoisted(() => ({
	event: null as null | { request: { method: string }; url: URL; route: { id: string | null } }
}));
vi.mock('$app/server', async (importOriginal) => ({
	...(await importOriginal<object>()),
	getRequestEvent: () => {
		if (!sveltekit.event) throw new Error('Can only read the current request event inside functions invoked during `handle`');
		return sveltekit.event;
	}
}));

/** Something to do once a report's PDF is made and before it is mailed: what a reset committed then would do. */
const pdf = vi.hoisted(() => ({ afterMade: null as null | (() => void) }));
vi.mock('$lib/server/reports', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/reports')>();
	return {
		...real,
		generateReportPdf: async (...args: Parameters<typeof real.generateReportPdf>) => {
			const made = await real.generateReportPdf(...args);
			pdf.afterMade?.();
			return made;
		}
	};
});

beforeEach(() => {
	resetDb();
	sveltekit.event = null;
	pdf.afterMade = null;
});

afterEach(() => {
	vi.unstubAllEnvs();
});

/** `fn`'s refusal, as the status and the message, or what it answered. */
function outcome<T>(fn: () => T): { status: number; message: string } | { answered: T } {
	try {
		return { answered: fn() };
	} catch (thrown) {
		if (isHttpError(thrown)) return { status: thrown.status, message: thrown.body.message };
		throw thrown;
	}
}

/** The locals a gate would hand on, for a session's token or an API key's row. */
const sessionLocals = (user: SessionUser, token: string): App.Locals => ({ user, credential: { kind: 'session', token } });
const keyRow = (key: string) => db.select().from(apiKeys).all().find((row) => key.startsWith(row.keyPrefix))!;
const keyLocals = (user: SessionUser, key: string): App.Locals => ({ user, credential: { kind: 'api key', id: keyRow(key).id } });

/** The ERROR lines under AUTH. */
const authErrors = () =>
	(sqlite.prepare("SELECT message FROM system_logs WHERE context = 'AUTH' AND level = 'ERROR' ORDER BY id").all() as { message: string }[]).map(
		(row) => row.message
	);

/** Gone from under the row that names it, as a deleted account leaves a session or key only with the foreign keys off. */
function deleteAccountLeavingItsRows(id: number) {
	sqlite.pragma('foreign_keys = OFF');
	try {
		db.delete(users).where(eq(users.id, id)).run();
	} finally {
		sqlite.pragma('foreign_keys = ON');
	}
}

// ─── stillAuthenticated (decisions 2 and 3) ─────────────────────────────────

describe('stillAuthenticated', () => {
	it('answers the account as it is now, read through the session, and sets locals.user to it', () => {
		const user = makeUser({ username: 'ada', role: 'admin' });
		const locals = sessionLocals(user, makeSession(user));
		db.update(users).set({ role: 'user', username: 'ada-now', emoji: '🦊' }).where(eq(users.id, user.id)).run();

		const now = inTransaction(() => stillAuthenticated(locals));

		expect(now).toEqual({ id: user.id, username: 'ada-now', email: user.email, emoji: '🦊', role: 'user' });
		expect(locals.user).toEqual(now);
	});

	it('answers the account as it is now, read through the API key, and sets locals.user to it', () => {
		const user = makeUser({ username: 'kim', role: 'admin' });
		const locals = keyLocals(user, makeApiKey(user));
		db.update(users).set({ role: 'user' }).where(eq(users.id, user.id)).run();

		const now = inTransaction(() => stillAuthenticated(locals));

		expect(now).toMatchObject({ id: user.id, username: 'kim', role: 'user' });
		expect(locals.user).toEqual(now);
	});

	it('answers locals.user unchanged when no gate ran (credential undefined), under the tests', () => {
		const user = makeUser();
		const locals: App.Locals = { user };

		expect(inTransaction(() => stillAuthenticated(locals))).toBe(user);
		expect(locals.user).toBe(user);
	});

	it('answers null when the gate let the request in with no key or session (credential null)', () => {
		const locals: App.Locals = { user: null, credential: null };

		expect(inTransaction(() => stillAuthenticated(locals))).toBeNull();
	});

	it("refuses 401, in the gate's words, a key deleted, expired, or whose account is gone", () => {
		const user = makeUser();
		const KEY = { status: 401, message: 'Invalid or expired API key' };

		const deleted = keyLocals(user, makeApiKey(user));
		db.delete(apiKeys).run();
		expect(outcome(() => inTransaction(() => stillAuthenticated(deleted)))).toEqual(KEY);

		const key = makeApiKey(user);
		const expired = keyLocals(user, key);
		db.update(apiKeys).set({ expiresAt: stamp(new Date(Date.now() - 60_000)) }).where(eq(apiKeys.id, keyRow(key).id)).run();
		expect(outcome(() => inTransaction(() => stillAuthenticated(expired)))).toEqual(KEY);

		const other = makeUser();
		const orphaned = keyLocals(other, makeApiKey(other));
		deleteAccountLeavingItsRows(other.id);
		expect(outcome(() => inTransaction(() => stillAuthenticated(orphaned)))).toEqual(KEY);
	});

	it("refuses 401, in the gate's words, a session deleted, expired, or whose account is gone", () => {
		const user = makeUser();
		const NOT = { status: 401, message: 'Not authenticated' };

		const token = makeSession(user);
		const deleted = sessionLocals(user, token);
		db.delete(sessions).where(eq(sessions.id, token)).run();
		expect(outcome(() => inTransaction(() => stillAuthenticated(deleted)))).toEqual(NOT);

		const old = makeSession(user);
		db.update(sessions).set({ expiresAt: stamp(new Date(Date.now() - 60_000)) }).where(eq(sessions.id, old)).run();
		expect(outcome(() => inTransaction(() => stillAuthenticated(sessionLocals(user, old))))).toEqual(NOT);

		const other = makeUser();
		const orphaned = sessionLocals(other, makeSession(other));
		deleteAccountLeavingItsRows(other.id);
		expect(outcome(() => inTransaction(() => stillAuthenticated(orphaned)))).toEqual(NOT);
	});

	it('leaves locals.user as the gate set it when it refuses', () => {
		const user = makeUser();
		const token = makeSession(user);
		const locals = sessionLocals(user, token);
		db.delete(sessions).run();

		expect(outcome(() => inTransaction(() => stillAuthenticated(locals)))).toMatchObject({ status: 401 });
		expect(locals.user).toBe(user);
	});

	it('throws outside a transaction, before it reads anything', () => {
		const user = makeUser();

		expect(() => stillAuthenticated(sessionLocals(user, makeSession(user)))).toThrow(
			'stillAuthenticated must be called inside the transaction that writes'
		);
	});
});

// ─── writeAs and stillCallerNow ─────────────────────────────────────────────

describe('writeAs', () => {
	it('hands the write the account as it is now, inside one transaction, and answers what the write answers', () => {
		const user = makeUser({ role: 'admin' });
		const locals = sessionLocals(user, makeSession(user));
		db.update(users).set({ role: 'user' }).where(eq(users.id, user.id)).run();

		const seen: { role: string | undefined; inTransaction: boolean }[] = [];
		const answered = writeAs(locals, (caller) => {
			seen.push({ role: caller?.role, inTransaction: sqlite.inTransaction });
			return 'written';
		});

		expect(answered).toBe('written');
		expect(seen).toEqual([{ role: 'user', inTransaction: true }]);
		expect(sqlite.inTransaction).toBe(false);
	});

	it('runs nothing of the write when the session has ended, and refuses 401', () => {
		const user = makeUser();
		const token = makeSession(user);
		const locals = sessionLocals(user, token);
		db.delete(sessions).where(eq(sessions.id, token)).run();

		const write = vi.fn(() => 'written');
		expect(outcome(() => writeAs(locals, write))).toEqual({ status: 401, message: 'Not authenticated' });
		expect(write).not.toHaveBeenCalled();
	});

	it('rolls back what the write wrote when it refuses after writing', () => {
		const user = makeUser();
		const locals = sessionLocals(user, makeSession(user));
		const before = snapshotDb();

		expect(() =>
			writeAs(locals, (caller) => {
				db.insert(reportSchedules).values({ userId: caller!.id, name: 'Rolled back', scope: 'all', frequency: 'weekly' }).run();
				throw new Error('refused after the write');
			})
		).toThrow('refused after the write');
		expectUnchanged(before);
	});

	it('refuses a write that is async, as inTransaction does', () => {
		const user = makeUser();
		const locals = sessionLocals(user, makeSession(user));

		// @ts-expect-error A transaction cannot await: the type refuses an async write.
		expect(() => writeAs(locals, async () => 'later')).toThrow('inTransaction was given a function that returns a promise');
	});

	it('is a savepoint inside another transaction, so the check commits or rolls back with what is around it', () => {
		const user = makeUser();
		const locals = sessionLocals(user, makeSession(user));

		const caller = inTransaction(() => writeAs(locals, (now) => now));

		expect(caller).toMatchObject({ id: user.id });
	});
});

describe('stillCallerNow', () => {
	it('answers the account as it is now, sets locals.user, and leaves no transaction open', () => {
		const user = makeUser({ role: 'superadmin' });
		const locals = keyLocals(user, makeApiKey(user));
		db.update(users).set({ role: 'admin' }).where(eq(users.id, user.id)).run();

		const now = stillCallerNow(locals);

		expect(now).toMatchObject({ id: user.id, role: 'admin' });
		expect(locals.user).toEqual(now);
		expect(sqlite.inTransaction).toBe(false);
	});

	it('refuses 401 a key deleted meanwhile', () => {
		const user = makeUser();
		const locals = keyLocals(user, makeApiKey(user));
		db.delete(apiKeys).run();

		expect(outcome(() => stillCallerNow(locals))).toEqual({ status: 401, message: 'Invalid or expired API key' });
	});
});

// ─── The four handlers that asked before this card ──────────────────────────

describe('the report schedules and the webhooks decide with the account as it is now', () => {
	/**
	 * `api()` hands the handler the caller the test gives it, as the gate read
	 * it, with the session it came by. The account is changed after that and
	 * before the handler runs: what a role change committed while the body
	 * arrived does. Before this card each of them decided on the role the gate
	 * had read, and wrote.
	 */
	const lowered = (role: 'admin' | 'superadmin', to: string) => {
		const user = makeUser({ username: `was-${role}`, role });
		const token = makeSession(user);
		db.update(users).set({ role: to }).where(eq(users.id, user.id)).run();
		return { user, credential: { kind: 'session' as const, token } };
	};

	it('POST /api/report-schedules: an all-boards schedule by an administrator lowered to user is refused 403, and nothing written', async () => {
		const { user, credential } = lowered('admin', 'user');
		const before = snapshotDb();

		const res = await api('POST', '/api/report-schedules', {
			user,
			credential,
			body: { name: 'Everything', scope: 'all', frequency: 'weekly' }
		});

		expect(res.status).toBe(403);
		expect(res.body).toEqual({ message: 'Only admins can schedule all-boards reports' });
		expectUnchanged(before);
	});

	it('POST /api/v1/boards/:boardId/webhooks and PUT and DELETE /api/v1/webhooks/:webhookId: an administrator lowered to user is refused 403, and nothing written', async () => {
		const owner = makeUser({ username: 'owner' });
		const { board } = makeBoard({ owner, name: 'Owned' });
		const hook = makeWebhook(board);
		const { user, credential } = lowered('admin', 'user');
		const before = snapshotDb();
		const NO_EDIT = { message: 'No edit access to this board' };

		const made = await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user, credential, body: { url: 'https://hooks.example.test/new' } });
		expect(made.status).toBe(403);
		expect(made.body).toEqual(NO_EDIT);

		const changed = await api('PUT', `/api/v1/webhooks/${hook.id}`, { user, credential, body: { active: false } });
		expect(changed.status).toBe(403);
		expect(changed.body).toEqual(NO_EDIT);

		const removed = await api('DELETE', `/api/v1/webhooks/${hook.id}`, { user, credential });
		expect(removed.status).toBe(403);
		expect(removed.body).toEqual(NO_EDIT);

		expectUnchanged(before);
	});

	it('DELETE /api/report-schedules/:id and DELETE /api/v1/webhooks/:webhookId refuse 401 a session or key that has ended, and delete nothing', async () => {
		const owner = makeUser({ username: 'owner' });
		const { board } = makeBoard({ owner, name: 'Owned' });
		const hook = makeWebhook(board);
		const scheduleId = db
			.insert(reportSchedules)
			.values({ userId: owner.id, name: 'Weekly', scope: 'board', scopeId: board.id, frequency: 'weekly' })
			.returning()
			.get().id;
		const token = makeSession(owner);
		const key = makeApiKey(owner);
		const keyCredential = { kind: 'api key' as const, id: keyRow(key).id };
		db.delete(sessions).run();
		db.delete(apiKeys).run();
		const before = snapshotDb();

		const schedule = await api('DELETE', `/api/report-schedules/${scheduleId}`, { user: owner, credential: { kind: 'session', token } });
		expect(schedule.status).toBe(401);
		expect(schedule.body).toEqual({ message: 'Not authenticated' });

		const webhook = await api('DELETE', `/api/v1/webhooks/${hook.id}`, { user: owner, credential: keyCredential });
		expect(webhook.status).toBe(401);
		expect(webhook.body).toEqual({ message: 'Invalid or expired API key' });

		expectUnchanged(before);
		expect(db.select().from(webhooks).all()).toHaveLength(1);
	});

	it('lets each through, by the account as it is now, when nothing has changed', async () => {
		const owner = makeUser({ username: 'owner' });
		const { board } = makeBoard({ owner, name: 'Owned' });
		const credential = { kind: 'session' as const, token: makeSession(owner) };

		const made = await api('POST', '/api/report-schedules', {
			user: owner,
			credential,
			body: { name: 'Weekly', scope: 'board', scopeId: board.id, frequency: 'weekly' }
		});
		expect(made.status).toBe(201);
		expect((await api('PUT', `/api/report-schedules/${made.body.id}`, { user: owner, credential, body: { enabled: false } })).status).toBe(200);
		expect((await api('DELETE', `/api/report-schedules/${made.body.id}`, { user: owner, credential })).status).toBe(200);

		const hook = await api('POST', `/api/v1/boards/${board.id}/webhooks`, { user: owner, credential, body: { url: 'https://hooks.example.test/new' } });
		expect(hook.status).toBe(201);
		expect((await api('PUT', `/api/v1/webhooks/${hook.body.id}`, { user: owner, credential, body: { active: false } })).status).toBe(200);
		expect((await api('DELETE', `/api/v1/webhooks/${hook.body.id}`, { user: owner, credential })).status).toBe(200);
	});
});

// ─── No credential at all (R10) ─────────────────────────────────────────────

describe('a write that reaches its handler with no credential recorded by the gate', () => {
	const SCHEDULE = { name: 'Weekly', scope: 'all', frequency: 'weekly' };

	it('is let through under the tests, as a handler called directly is (the control)', async () => {
		const admin = makeUser({ role: 'admin' });

		expect((await api('POST', '/api/report-schedules', { user: admin, body: SCHEDULE })).status).toBe(201);
	});

	it('is refused 401 outside the tests, with exactly one ERROR line naming the request, and nothing written', async () => {
		vi.stubEnv('VITEST', '');
		const admin = makeUser({ role: 'admin' });
		sveltekit.event = { request: { method: 'POST' }, url: new URL('http://localhost/api/report-schedules'), route: { id: '/api/report-schedules' } };
		const before = snapshotDb();

		const res = await api('POST', '/api/report-schedules', { user: admin, body: SCHEDULE });

		expect(res.status).toBe(401);
		expect(res.body).toEqual({ message: 'Not authenticated' });
		expect(authErrors()).toEqual([
			'A write reached its handler with no credential recorded by the gate: POST /api/report-schedules; refused 401; ' +
				'this is a fault in DumpFire, not in the request: report this line'
		]);
		// Filed under the account the handler was given, with where it was asked from.
		const row = sqlite.prepare("SELECT user_id AS userId, meta FROM system_logs WHERE context = 'AUTH' AND level = 'ERROR'").get() as {
			userId: number | null;
			meta: string;
		};
		expect(row.userId).toBe(admin.id);
		const stack = JSON.parse(row.meta).stack as string;
		expect(stack).toContain('write-as');
		expect(stack.split('\n').length).toBeLessThanOrEqual(6);
		expectUnchanged(before);
	});

	it('says so when SvelteKit cannot name the request', async () => {
		vi.stubEnv('VITEST', '');
		const admin = makeUser({ role: 'admin' });

		const res = await api('POST', '/api/report-schedules', { user: admin, body: SCHEDULE });

		expect(res.status).toBe(401);
		expect(authErrors()).toEqual([
			'A write reached its handler with no credential recorded by the gate: a request SvelteKit could not name; refused 401; ' +
				'this is a fault in DumpFire, not in the request: report this line'
		]);
	});
});

describe('the gate records a credential, or null, on every request it hands on', () => {
	/**
	 * `handle` itself, given a request as SvelteKit gives it one and a stub
	 * for what it hands on to, which records `locals.credential`. Every branch
	 * that hands a request on, for each method: none may leave it undefined,
	 * which `stillAuthenticated` refuses outside the tests.
	 */
	const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

	function eventFor(method: string, path: string, routeId: string | null, headers: Record<string, string> = {}): RequestEvent {
		const url = new URL(path, 'http://localhost');
		const jar = new Map<string, string>();
		for (const pair of (headers.cookie ?? '').split(';')) {
			const at = pair.indexOf('=');
			if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
		}
		return {
			request: new Request(url, { method, headers }),
			url,
			params: {},
			route: { id: routeId },
			locals: {},
			cookies: {
				get: (name: string) => jar.get(name),
				getAll: () => [...jar].map(([name, value]) => ({ name, value })),
				set: () => {},
				delete: () => {},
				serialize: () => ''
			},
			getClientAddress: () => '127.0.0.1',
			setHeaders: () => {},
			platform: undefined,
			isDataRequest: false,
			isSubRequest: false,
			isRemoteRequest: false
		} as unknown as RequestEvent;
	}

	/** What each request handed on carried, as `[method, credential]`, or `'not handed on'`. */
	async function handedOn(path: string, routeId: string | null, headers: Record<string, string> = {}) {
		const seen: unknown[] = [];
		for (const method of METHODS) {
			let carried: unknown = 'not handed on';
			await handle({
				event: eventFor(method, path, routeId, { accept: 'application/json', ...headers }),
				resolve: async (event) => {
					carried = 'credential' in event.locals ? event.locals.credential : 'undefined';
					return json({});
				}
			});
			seen.push([method, carried]);
		}
		return seen;
	}
	const each = (credential: unknown) => METHODS.map((method) => [method, credential]);

	it('the set-up route, before there is a user', async () => {
		expect(await handedOn('/setup', '/setup')).toEqual(each(null));
	});

	it('a file under /_app/, which passes through unasked', async () => {
		makeUser();
		expect(await handedOn('/_app/immutable/start.js', null)).toEqual(each(null));
	});

	it('the OpenAPI document', async () => {
		makeUser();
		expect(await handedOn('/api/v1/openapi.json', '/api/v1/openapi.json')).toEqual(each(null));
	});

	it('a valid API key', async () => {
		const user = makeUser();
		const key = makeApiKey(user);
		expect(await handedOn('/api/v1/me', '/api/v1/me', { authorization: `Bearer ${key}` })).toEqual(
			each({ kind: 'api key', id: keyRow(key).id })
		);
	});

	it('a public route, with no session and with one', async () => {
		const user = makeUser();
		const token = makeSession(user);
		expect(await handedOn('/api/requests', '/api/requests')).toEqual(each(null));
		expect(await handedOn('/api/requests', '/api/requests', { cookie: `${SESSION_COOKIE_NAME}=${token}` })).toEqual(
			each({ kind: 'session', token })
		);
	});

	it('a signed-in session', async () => {
		const user = makeUser();
		const token = makeSession(user);
		expect(await handedOn('/api/cards', '/api/cards', { cookie: `${SESSION_COOKIE_NAME}=${token}` })).toEqual(
			each({ kind: 'session', token })
		);
	});
});

// ─── The report mail's second check (R1) ────────────────────────────────────

describe("the report mail asks again after its PDF is made, before it sends (R1)", () => {
	/**
	 * `POST /api/reports/email` builds its PDF with an await, and only then
	 * sends: a session ended while the PDF was made must send no mail. Slice
	 * 2253-4 moves the route to `stillCallerNow` with a second check before
	 * the send; until then this is pinned as a known fault, and fails the
	 * suite the day that slice puts it right, when the `.fails` comes off.
	 */
	it.fails('sends no mail, and answers 401, when the session ends after the PDF is made', { timeout: 30_000 }, async () => {
		const owner = makeUser({ username: 'owner' });
		const { board } = makeBoard({ owner, name: 'Reported' });
		const token = makeSession(owner);
		makeSmtp();
		const sent = effects();
		pdf.afterMade = () => void db.delete(sessions).where(eq(sessions.id, token)).run();

		let res;
		try {
			res = await api('POST', '/api/reports/email', {
				user: owner,
				credential: { kind: 'session', token },
				body: { scope: 'board', scopeId: board.id, periodStart: '2026-10-01', periodEnd: '2026-10-08', recipients: ['a@example.test'] }
			});
		} finally {
			sent.restore();
		}

		expect(res.status).toBe(401);
		expect(res.body).toEqual({ message: 'Not authenticated' });
		expect(sent.emails).toEqual([]);
	});
});
