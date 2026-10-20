/**
 * Accounts, passwords and sessions change all or nothing, and what can be
 * done once is done once.
 *
 * A password change is the password, the sessions that end and the session
 * that replaces them. Using an invite is the password, the invite marked used
 * and a session. Setting an instance up is its superadmin and their session.
 * Each was written one statement after another with nothing around them, so a
 * failure part of the way left a new password with the old sessions still
 * good, or an invite that had set a password and could be used again.
 *
 * Two of them also checked before they read the form, so two submissions at
 * the same moment both passed the check: one invite set two passwords, and an
 * instance got two superadmins.
 *
 * What setting a password ends is part of the same transaction
 * (`endAccountAccess`): every session and every invite not yet used, and the
 * API keys on a reset and an invite, or on your own change when you ask. An
 * account has one invite that works, the newest (`issueInvite`), and none
 * for the superadmin's account. A key is made with the current password.
 * A change of an account's email address or role ends its invites not yet
 * used as well, in the transaction that writes it (`endUnusedInvites`).
 *
 * Wrong current passwords are counted, ten in 15 minutes for one session, as
 * sign-in counts wrong passwords (`checkCurrentPassword`). The count is in
 * memory and outlives `resetDb()`, which numbers the users from 1 again, so
 * it is cleared before each test.
 *
 * Tests of a success use `eachWriteInTurn`, which makes the request once to
 * count its writes and then once more for each of them, with that write
 * failing, and checks every time that not one row changed and nothing was
 * sent. Tests of "once" use `watchReads`, which lets another request's write
 * land between this request's first look at a row and the transaction that
 * reads it again.
 *
 * A password is hashed here at the lowest cost bcrypt takes, not at the
 * application's, which takes about a quarter of a second each time. The
 * stand-in notes whether a transaction was open when it was called, because
 * hashing inside one would hold every other write up for that long.
 *
 * The suite hashes and checks on the test's own thread, a turn later
 * (`PASSWORD_THREADS=0`, card 2191), with the bcryptjs that passwords.ts
 * imports, so this mock sees every call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bcrypt = vi.hoisted(() => ({
	/** For each password hashed, and each one checked: whether a transaction was open. */
	inTransaction: [] as boolean[],
	/** Whether one is open now. Set below, once the connection is imported. */
	open: (): boolean => false,
	/** Called after each check, with which check it was, counting from 1; for a test to act between two. */
	afterCompare: undefined as ((nth: number) => void) | undefined,
	/** Checks made since the hook was set. */
	compared: 0
}));

vi.mock('bcryptjs', async (importOriginal) => {
	const real = await importOriginal<typeof import('bcryptjs')>();
	return {
		...real,
		hashSync: (password: string) => {
			bcrypt.inTransaction.push(bcrypt.open());
			return real.hashSync(password, 4);
		},
		compareSync: (password: string, hash: string) => {
			bcrypt.inTransaction.push(bcrypt.open());
			const result = real.compareSync(password, hash);
			bcrypt.afterCompare?.(++bcrypt.compared);
			return result;
		}
	};
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { isHttpError, type Cookies, type RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { apiKeys, inviteTokens, reportSchedules, sessions, taskRequests, users } from '$lib/server/db/schema';
import { MASTER_PREF, NOTIFICATION_PREFS } from '$lib/notification-prefs';
import { PASSWORD_CHANGED_MEANWHILE, sessionStillOpen, SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { PASSWORDS_BUSY, checkPassword, makePasswordHash } from '$lib/server/passwords';
import { endUnusedInvites, issueInvite } from '$lib/server/invites';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { knownBrowserCookie, rememberBrowser, rememberedNonce } from '$lib/server/known-browsers';
import { dispatchWebhook } from '$lib/server/webhooks';
import { PUT as changeOwnPassword } from '../src/routes/api/account/password/+server';
import { load as loadAdminPage } from '../src/routes/admin/+page.server';
import { load as loadInvitePage } from '../src/routes/invite/[token]/+page.server';
import { action, type ActionResult } from './helpers/actions';
import { api, type ApiResult } from './helpers/api';
import { eachWriteInTurn } from './helpers/each-write';
import { effects, type Effects, type RecordedEffect } from './helpers/effects';
import { addBoardMember, makeApiKey, makeBoard, makeCard, makeSmtp, makeUser, makeWebhook, resetDb } from './helpers/fixtures';
import { gate } from './helpers/gate';
import { sendAround } from './helpers/held-body';
import { watchReads } from './helpers/reads';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';
import { parseStamp, stamp } from '$lib/timestamps';

bcrypt.open = () => sqlite.inTransaction;

const OLD = 'the old password';
const NEW = 'a new password';
/** `OLD`, hashed once for every fixture that needs a password that can be checked. */
const OLD_HASH = await makePasswordHash(OLD, 'known');

/** Whether `password` is the one `hash` was made from, checked as the routes check one. */
const matches = async (password: string, hash: string) => (await checkPassword(password, hash, 'known')).matches;

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	// The key remembered browsers are signed with is made the first time a
	// browser is remembered, a write of its own after the request's
	// transaction, and then kept in memory (card 2194). Made here, so that
	// each request's writes are its own whichever test runs first.
	rememberBrowser({ set: () => {} } as unknown as Cookies, 0, '');
	bcrypt.inTransaction.length = 0;
	bcrypt.afterCompare = undefined;
	bcrypt.compared = 0;
});

/** What a request's `cookies.get` reads, from the one cookie `name=value`. */
const sending = (cookie: { name: string; value: string }) => ({
	get: (name: string) => (name === cookie.name ? cookie.value : undefined)
});

/** Whether the cookie remembers its browser for the account `id` as the account is now. */
const remembers = (cookie: { name: string; value: string }, id: number) =>
	rememberedNonce(sending(cookie), { id, passwordHash: hashOf(id) }) !== null;

/** A cookie that remembers a browser for `user`'s account as it is now. */
function rememberedFor(user: SessionUser): { name: string; value: string } {
	let made: { name: string; value: string } | undefined;
	rememberBrowser({ set: (name: string, value: string) => (made = { name, value }) } as unknown as Cookies, user.id, hashOf(user.id));
	return made!;
}

/** The options a remembered browser's cookie is set with (card 2194, decision 17). */
const KNOWN_OPTIONS = { path: '/login', httpOnly: true, sameSite: 'strict', secure: false, maxAge: 365 * 24 * 60 * 60 };

/** A recorded effect in a few words, so that a whole request reads as a list. */
function name(effect: RecordedEffect): string {
	if (effect.kind === 'webhook') return `webhook ${effect.event}`;
	if (effect.kind === 'email') return `email to ${effect.to}: ${effect.subject}`;
	return `event ${effect.event} (${effect.data?.type}) on board ${effect.boardId}`;
}

/** The first words of each write, to read a request's writes as a list. */
const shape = (writes: string[]) =>
	writes.map((sql) => sql.split(/[ (]/).slice(0, 3).join(' ').replace(/"/g, '').toLowerCase());

const userRow = (id: number) => db.select().from(users).where(eq(users.id, id)).get()!;
const hashOf = (id: number) => userRow(id).passwordHash;
const sessionsOf = (id: number) =>
	db
		.select({ id: sessions.id })
		.from(sessions)
		.where(eq(sessions.userId, id))
		.all()
		.map((s) => s.id);

/**
 * The session cookie of a request sent from the session `id`. The routes that
 * ask for a current password count wrong ones against it. `api()` gives the
 * handler its caller directly, so it is not looked up.
 */
const from = (id: string) => ({ cookie: `${SESSION_COOKIE_NAME}=${id}` });

/** A session that is good for another day. */
function makeSession(user: SessionUser, id: string): void {
	db.insert(sessions)
		.values({ id, userId: user.id, expiresAt: stamp(new Date(Date.now() + 24 * 60 * 60 * 1000)) })
		.run();
}

/** Give a user a password that can be checked: `OLD`. */
function withPassword(user: SessionUser): SessionUser {
	db.update(users).set({ passwordHash: OLD_HASH }).where(eq(users.id, user.id)).run();
	return user;
}

const HOUR = 60 * 60 * 1000;

/**
 * An invite, written as it is stored: good for another hour unless told
 * otherwise. Written directly, as production may hold more than one waiting
 * invite for an account from before an account had one.
 */
function makeInvite(user: SessionUser, token: string, opts: { expiresIn?: number; used?: boolean } = {}): void {
	db.insert(inviteTokens)
		.values({
			token,
			userId: user.id,
			expiresAt: stamp(new Date(Date.now() + (opts.expiresIn ?? HOUR))),
			used: opts.used ?? false
		})
		.run();
}

/** A user's invites, as `[token, used]`, oldest first. */
const invitesOf = (id: number) =>
	db
		.select()
		.from(inviteTokens)
		.where(eq(inviteTokens.userId, id))
		.all()
		.map((i) => [i.token, i.used] as const);

/** The names of a user's API keys. */
const keysOf = (id: number) =>
	db
		.select({ name: apiKeys.name })
		.from(apiKeys)
		.where(eq(apiKeys.userId, id))
		.all()
		.map((k) => k.name);

/** `GET /api/v1/me` through the gate with this key: the status it is answered. */
const meWithKey = (key: string) => gate('GET', '/api/v1/me', { headers: { authorization: `Bearer ${key}` } });

/**
 * What the invite page and its form answer for a link that does not work,
 * whatever the reason: expired, used, replaced by a newer invite, ended by a
 * change of the account's password, email address or role, or for the
 * superadmin's account.
 */
const DEAD_LINK =
	'This invite link no longer works. It has expired, it has already been used, or it was cancelled when a ' +
	"newer invite was sent or the account's password, email address or role was changed. Ask an administrator " +
	'to send you a new one.';
const INVALID = { type: 'failure', status: 400, data: { error: DEAD_LINK } };

/** The invite page's load, for the link with this token. */
const loadInvite = async (token: string) =>
	(await loadInvitePage({ params: { token } } as unknown as Parameters<typeof loadInvitePage>[0])) as Record<
		string,
		unknown
	>;

/**
 * Nothing was hashed or checked while a transaction was open, and something was.
 *
 * Since card 2191 a hash or a check is awaited, and runs a turn later, so none
 * can be made inside a transaction and this always holds. The guards that
 * matter are `inTransaction`'s type, which refuses a function that returns a
 * promise, and tests/password-checks.test.ts, which holds that every check is
 * awaited. Kept so that a hash made some other way would be seen here.
 */
function expectHashedOutsideTransaction(): void {
	expect(bcrypt.inTransaction.length).toBeGreaterThan(0);
	expect(bcrypt.inTransaction).not.toContain(true);
}

/**
 * Make `request` with nothing failed, and check that not a row changed and
 * nothing was sent. Returns what it returned.
 */
async function expectNothingWritten<R>(request: () => Promise<R>): Promise<R> {
	const before = snapshotDb();
	const sent = effects();
	try {
		const result = await request();
		await sent.settle();
		expectUnchanged(before);
		expect(sent.all).toEqual([]);
		return result;
	} finally {
		sent.restore();
	}
}

/** The same, for a route, with the status it must answer. */
async function expectRefused(request: () => Promise<ApiResult>, status: number): Promise<ApiResult> {
	const res = await expectNothingWritten(request);
	expect(res.status).toBe(status);
	return res;
}

// ─── Changing your own password ─────────────────────────────────────────────

type OwnResult = ApiResult & {
	/** The session cookie it set, and whether a transaction was open when it did. */
	cookie?: { value: string; inTransaction: boolean };
	/** The cookie that remembers the browser (card 2194), with its options. */
	known?: { name: string; value: string; options: Record<string, unknown> };
};

/**
 * `PUT /api/account/password`, called as `api()` calls a route, but keeping
 * the cookie it sets: `api()` has nowhere to return one. Sent from the session
 * `session`, which is the session cookie the route reads.
 */
async function changeOwn(user: SessionUser | null, body: unknown, session = 'my-laptop'): Promise<OwnResult> {
	const result: OwnResult = { status: 0, body: null, headers: new Headers() };
	const event = {
		request: new Request('http://localhost/api/account/password', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		locals: { user },
		cookies: {
			get: (cookie: string) => (cookie === SESSION_COOKIE_NAME ? session : undefined),
			set: (cookie: string, value: string, options: Record<string, unknown>) => {
				if (cookie === SESSION_COOKIE_NAME) result.cookie = { value, inTransaction: sqlite.inTransaction };
				if (user && cookie === knownBrowserCookie(user.id)) result.known = { name: cookie, value, options };
			}
		}
	} as unknown as RequestEvent;

	try {
		const response = await (changeOwnPassword as unknown as (event: RequestEvent) => Promise<Response>)(event);
		result.status = response.status;
		result.body = await response.json();
	} catch (thrown) {
		if (!isHttpError(thrown)) throw thrown;
		result.status = thrown.status;
		result.body = thrown.body;
	}
	return result;
}

describe('PUT /api/account/password', () => {
	/**
	 * Signed in on two devices, with two API keys and an invite not yet used,
	 * and somebody else signed in on one, with a key and an invite of their own.
	 */
	const signedInTwice = () => {
		const me = withPassword(makeUser({ username: 'me' }));
		const other = makeUser({ username: 'other' });
		makeSession(me, 'my-laptop');
		makeSession(me, 'my-phone');
		makeSession(other, 'theirs');
		makeApiKey(me, 'my script');
		makeApiKey(me, 'my other script');
		makeApiKey(other, 'their script');
		makeInvite(me, 'my-invite');
		makeInvite(other, 'their-invite');
		return { me, other };
	};

	it('changes the password, ends every session and invite and starts a new session, keeping the keys, or does none of it', async () => {
		const run = await eachWriteInTurn({
			build: signedInTwice,
			request: ({ me }) => changeOwn(me, { currentPassword: OLD, newPassword: NEW }),
			afterSuccess: async ({ me, other }, res: OwnResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true, apiKeysEnded: 0, webhooksSwitchedOff: 0 });

				expect(await matches(NEW, hashOf(me.id))).toBe(true);
				expect(await matches(OLD, hashOf(me.id))).toBe(false);

				// Both devices are signed out, and this one is signed in again by the
				// cookie, which names the one session there now is.
				const mine = sessionsOf(me.id);
				expect(mine).toHaveLength(1);
				expect(mine).not.toContain('my-laptop');
				expect(mine).not.toContain('my-phone');
				expect(res.cookie).toEqual({ value: mine[0], inTransaction: false });
				expect(sessionsOf(other.id)).toEqual(['theirs']);

				// The invite would set the password again; the keys were not asked about.
				expect(invitesOf(me.id)).toEqual([]);
				expect(keysOf(me.id)).toEqual(['my script', 'my other script']);
				expect(invitesOf(other.id)).toEqual([['their-invite', false]]);
				expect(keysOf(other.id)).toEqual(['their script']);
			}
		});

		// A failure at the second of these used to leave the new password with
		// both old sessions still good; at the fourth, with nobody signed in.
		expect(shape(run.writes)).toEqual([
			'update users set',
			'delete from sessions',
			'delete from invite_tokens',
			'insert into sessions'
		]);
		expect(run.effects).toEqual([]);
		expectHashedOutsideTransaction();
	});

	it('ends every API key of the account too when asked, or does none of it', async () => {
		const run = await eachWriteInTurn({
			build: signedInTwice,
			request: ({ me }) => changeOwn(me, { currentPassword: OLD, newPassword: NEW, endApiKeys: true }),
			afterSuccess: async ({ me, other }, res: OwnResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true, apiKeysEnded: 2, webhooksSwitchedOff: 0 });
				expect(await matches(NEW, hashOf(me.id))).toBe(true);
				expect(sessionsOf(me.id)).toEqual([res.cookie!.value]);
				expect(invitesOf(me.id)).toEqual([]);
				expect(keysOf(me.id)).toEqual([]);

				// Nobody else's.
				expect(sessionsOf(other.id)).toEqual(['theirs']);
				expect(invitesOf(other.id)).toEqual([['their-invite', false]]);
				expect(keysOf(other.id)).toEqual(['their script']);
			}
		});

		expect(shape(run.writes)).toEqual([
			'update users set',
			'delete from sessions',
			'delete from invite_tokens',
			'delete from api_keys',
			// The webhooks the account set (card 2168): written whether or not one
			// matches, and only when the keys end.
			'update webhooks set',
			'insert into sessions'
		]);
		expect(run.effects).toEqual([]);
		expectHashedOutsideTransaction();
	});

	// It runs the change several times over, each with its own failing write, so it
	// takes over a second alone and can pass five under the whole suite's load.
	it("keeps the superadmin's keys on their own change unless they ask, and nothing else ends them", { timeout: 20_000 }, async () => {
		const chief = withPassword(makeUser({ username: 'chief', role: 'superadmin' }));
		const key = makeApiKey(chief, 'the automation');

		const kept = await changeOwn(chief, { currentPassword: OLD, newPassword: NEW, endApiKeys: false });
		expect(kept.status).toBe(200);
		expect(kept.body).toEqual({ success: true, apiKeysEnded: 0, webhooksSwitchedOff: 0 });
		expect((await meWithKey(key)).status).toBe(200);

		const ended = await changeOwn(chief, { currentPassword: NEW, newPassword: 'a third password', endApiKeys: true });
		expect(ended.body).toEqual({ success: true, apiKeysEnded: 1, webhooksSwitchedOff: 0 });
		expect(keysOf(chief.id)).toEqual([]);
		const refused = await meWithKey(key);
		expect(refused.status).toBe(401);
		expect(await refused.json()).toEqual({ message: 'Invalid or expired API key' });
	});

	it('refuses endApiKeys that is not true or false before a password is checked or hashed', async () => {
		const { me } = signedInTwice();

		for (const endApiKeys of ['yes', 1, null, 'true']) {
			const res = await expectNothingWritten(() =>
				changeOwn(me, { currentPassword: OLD, newPassword: NEW, endApiKeys })
			);
			expect(res.status).toBe(400);
			expect(res.body.message).toBe('endApiKeys must be true or false');
			expect(res.cookie).toBeUndefined();
		}
		expect(bcrypt.inTransaction).toEqual([]);
	});

	it('answers as it did for each refusal, with nothing written and no cookie', async () => {
		const { me } = signedInTwice();
		const refused = async (user: SessionUser | null, body: unknown, status: number) => {
			const res = await expectNothingWritten(() => changeOwn(user, body));
			expect(res.status).toBe(status);
			expect(res.cookie).toBeUndefined();
			return res.body.message;
		};

		await refused(null, { currentPassword: OLD, newPassword: NEW }, 401);
		expect(await refused(me, { newPassword: NEW }, 400)).toBe('Current password is required');
		expect(await refused(me, { currentPassword: OLD, newPassword: 'short' }, 400)).toBe(
			'New password must be at least 8 characters'
		);
		// A short new password is refused before the current one is checked.
		expect(await refused(me, { currentPassword: 'not it', newPassword: 'short' }, 400)).toBe(
			'New password must be at least 8 characters'
		);
		expect(await refused(me, { currentPassword: 'not it', newPassword: NEW }, 403)).toBe(
			'Current password is incorrect'
		);
		expect(sessionsOf(me.id)).toEqual(['my-laptop', 'my-phone']);
	});

	it('refuses when the password was changed elsewhere after it was checked, and leaves that change alone', async () => {
		const { me } = signedInTwice();
		const elsewhere = await makePasswordHash('changed elsewhere', 'known');
		const before = snapshotDb();
		// The first read is the one the current password is checked against.
		const reads = watchReads('users', (nth) => {
			if (nth === 1) db.update(users).set({ passwordHash: elsewhere }).where(eq(users.id, me.id)).run();
		});

		try {
			const res = await changeOwn(me, { currentPassword: OLD, newPassword: NEW });

			expect(res.status).toBe(403);
			expect(res.body.message).toBe('Current password is incorrect');
			expect(res.cookie).toBeUndefined();
		} finally {
			reads.restore();
		}

		// Looked at before the transaction, and read again inside it.
		expect(reads.inTransaction).toEqual([false, true]);
		expect(hashOf(me.id)).toBe(elsewhere);
		expect(sessionsOf(me.id)).toEqual(['my-laptop', 'my-phone']);
		expectUnchanged({ ...before, users: snapshotDb().users });
	});

	it('goes ahead when the stored hash changed and the password it is a hash of did not', async () => {
		const { me } = signedInTwice();
		const rehashed = await makePasswordHash(OLD, 'known');
		const reads = watchReads('users', (nth) => {
			if (nth === 1) db.update(users).set({ passwordHash: rehashed }).where(eq(users.id, me.id)).run();
		});

		try {
			expect((await changeOwn(me, { currentPassword: OLD, newPassword: NEW })).status).toBe(200);
		} finally {
			reads.restore();
		}

		expect(await matches(NEW, hashOf(me.id))).toBe(true);
	});

	// The re-check is made outside the transaction now (card 2191, D8): a
	// check is awaited, which a transaction cannot do. The transaction writes
	// only while the stored hash is the one the password was checked against;
	// changed, the password is checked again against the new one and the
	// transaction run once more. A second change is answered 409.
	it('answers 409 with nothing written when the stored hash changes twice while it is being saved, counting one attempt', async () => {
		const { me } = signedInTwice();
		const first = await makePasswordHash(OLD, 'known');
		const second = await makePasswordHash(OLD, 'known');
		const before = snapshotDb();
		// After the first check, and after the re-check: each time the hash of
		// the same password, as another request setting it again would leave it.
		bcrypt.inTransaction.length = 0;
		bcrypt.afterCompare = (nth) => {
			const next = nth === 1 ? first : nth === 2 ? second : null;
			if (next) db.update(users).set({ passwordHash: next }).where(eq(users.id, me.id)).run();
		};

		const res = await changeOwn(me, { currentPassword: OLD, newPassword: NEW });
		bcrypt.afterCompare = undefined;

		expect(res.status).toBe(409);
		expect(res.body.message).toBe(PASSWORD_CHANGED_MEANWHILE);
		expect(res.cookie).toBeUndefined();
		// The check, the new password's hash and one re-check, none inside a
		// transaction: the second change is answered without a third.
		expect(bcrypt.inTransaction).toEqual([false, false, false]);
		expect(bcrypt.compared).toBe(2);
		// The second change stands, and nothing else changed.
		expect(hashOf(me.id)).toBe(second);
		expect(sessionsOf(me.id)).toEqual(['my-laptop', 'my-phone']);
		expectUnchanged({ ...before, users: snapshotDb().users });

		// The session's count is what one right password leaves, none: ten
		// wrong ones are answered 403, and the eleventh 429.
		for (let n = 1; n <= 10; n++) {
			expect((await changeOwn(me, { currentPassword: 'not it', newPassword: NEW })).status).toBe(403);
		}
		expect((await changeOwn(me, { currentPassword: 'not it', newPassword: NEW })).status).toBe(429);
	});
});

// ─── Setting somebody's password ────────────────────────────────────────────

describe('PUT /api/users/:id/password', () => {
	/**
	 * The target is signed in on two devices and has an API key and an invite
	 * not yet used. The administrator and a bystander each have a key, and the
	 * administrator a session. The keys are returned as their holders hold them.
	 */
	const scene = () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		const target = withPassword(makeUser({ username: 'target' }));
		const bystander = makeUser({ username: 'bystander' });
		makeSession(admin, 'the-admin');
		makeSession(target, 'target-laptop');
		makeSession(target, 'target-phone');
		makeInvite(target, 'target-invite');
		const keys = {
			target: makeApiKey(target, 'target key'),
			admin: makeApiKey(admin, 'admin key'),
			bystander: makeApiKey(bystander, 'bystander key')
		};
		return { admin, chief, target, bystander, keys };
	};

	const reset = (by: SessionUser | null, id: number, password: unknown = NEW) =>
		api('PUT', `/api/users/${id}/password`, { user: by, body: { password } });

	it('by an administrator, sets the password and ends that user\'s sessions, invites and API keys, or does none of it', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ admin, target }) => reset(admin, target.id),
			afterSuccess: async ({ admin, target, bystander }, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({
					success: true,
					sessionsEnded: 2,
					apiKeysEnded: 1,
					webhooksSwitchedOff: 0,
					reportSchedulesPaused: 0
				});
				expect(await matches(NEW, hashOf(target.id))).toBe(true);
				expect(sessionsOf(target.id)).toEqual([]);
				expect(invitesOf(target.id)).toEqual([]);
				expect(keysOf(target.id)).toEqual([]);

				// The administrator's and the bystander's are theirs, and stay.
				expect(sessionsOf(admin.id)).toEqual(['the-admin']);
				expect(keysOf(admin.id)).toEqual(['admin key']);
				expect(keysOf(bystander.id)).toEqual(['bystander key']);
			}
		});

		// A failure at the second used to leave the password reset and whoever
		// held the old one still signed in, which a reset is meant to end. The
		// invite and the keys used to outlive the reset whatever happened.
		expect(shape(run.writes)).toEqual([
			'update users set',
			'delete from sessions',
			'delete from invite_tokens',
			'delete from api_keys',
			// What the account set going (card 2168), written whether or not a row matches.
			'update webhooks set',
			'update report_schedules set'
		]);
		expect(run.effects).toEqual([]);
		expectHashedOutsideTransaction();
	});

	it('by the superadmin, of an administrator, ends that administrator\'s sessions and keys as well', async () => {
		const s = scene();

		const res = await reset(s.chief, s.admin.id);

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true, sessionsEnded: 1, apiKeysEnded: 1, webhooksSwitchedOff: 0, reportSchedulesPaused: 0 });
		expect(sessionsOf(s.admin.id)).toEqual([]);
		expect(keysOf(s.admin.id)).toEqual([]);
		// The target's are not the administrator's.
		expect(sessionsOf(s.target.id)).toEqual(['target-laptop', 'target-phone']);
		expect(keysOf(s.target.id)).toEqual(['target key']);
		expect(invitesOf(s.target.id)).toEqual([['target-invite', false]]);
	});

	it('leaves the user\'s ended key refused at the gate, and everyone else\'s working', async () => {
		const s = scene();
		expect((await meWithKey(s.keys.target)).status).toBe(200);

		expect((await reset(s.admin, s.target.id)).status).toBe(200);

		const refused = await meWithKey(s.keys.target);
		expect(refused.status).toBe(401);
		expect(await refused.json()).toEqual({ message: 'Invalid or expired API key' });
		expect((await meWithKey(s.keys.bystander)).status).toBe(200);
		expect((await meWithKey(s.keys.admin)).status).toBe(200);
	});

	// A user used to set their own password here, and was not asked for the one
	// they have: whoever held a session of theirs, or one of their API keys,
	// could change it. `PUT /api/account/password` is where a user changes their
	// own, and it asks. An administrator is a user in this, and so is the
	// superadmin.
	it('by the user themselves, with no current password, is refused with nothing written', async () => {
		const { target, admin, chief } = scene();

		for (const self of [target, admin, chief]) {
			const res = await expectNothingWritten(() => reset(self, self.id));

			expect(res.status).toBe(403);
			expect(res.body.message).toBe('Change your own password on the Account page, which asks for your current password');
		}
		// Refused before anything was hashed for.
		expect(bcrypt.inTransaction).toEqual([]);
		expect(await matches(OLD, hashOf(target.id))).toBe(true);
	});

	it('answers as it did for each refusal, with nothing written', async () => {
		const s = scene();
		const message = async (request: () => Promise<ApiResult>, status: number) =>
			(await expectRefused(request, status)).body.message;

		await expectRefused(() => reset(null, s.target.id), 401);
		expect(await message(() => reset(s.bystander, s.target.id), 403)).toBe('Forbidden');
		// The user is looked for, and the caller checked, before the password is
		// read (card 2117, R1): too short was refused first, and a user who is
		// not there was a 400.
		expect(await message(() => reset(s.admin, 99999, 'short'), 404)).toBe('User not found');
		expect(await message(() => reset(s.admin, s.target.id, 'short'), 400)).toBe('Password must be at least 8 characters');
		expect(await message(() => reset(s.admin, 99999), 404)).toBe('User not found');
		expect(await message(() => reset(s.admin, s.chief.id), 403)).toBe('Only superadmin can reset superadmin password');
		// None of those was hashed for.
		expect(bcrypt.inTransaction).toEqual([]);
	});

	it('refuses when the user became a superadmin after they were looked at', async () => {
		const s = scene();
		const reads = watchReads('users', (nth) => {
			if (nth === 1) db.update(users).set({ role: 'superadmin' }).where(eq(users.id, s.target.id)).run();
		});

		try {
			const res = await reset(s.admin, s.target.id);

			expect(res.status).toBe(403);
			expect(res.body.message).toBe('Only superadmin can reset superadmin password');
		} finally {
			reads.restore();
		}

		// Looked at before the transaction, and read again inside it.
		expect(reads.inTransaction).toEqual([false, true]);
		expect(hashOf(s.target.id)).toBe(OLD_HASH);
		expect(sessionsOf(s.target.id)).toEqual(['target-laptop', 'target-phone']);
	});
});

// ─── Creating a user ────────────────────────────────────────────────────────

describe('POST /api/users', () => {
	/** Mail is switched on, so a user made with no password is sent an invite. */
	const scene = () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		const plain = makeUser({ username: 'plain' });
		makeSmtp();
		return { admin, chief, plain };
	};

	const create = (by: SessionUser | null, body: Record<string, unknown>) => api('POST', '/api/users', { user: by, body });

	it('with no password, makes the user and their invite, or neither, and mails it once they are saved', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ admin }) => create(admin, { username: '  newbie ', email: ' Newbie@Example.test ' }),
			afterSuccess: (_s, res: ApiResult, sent) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({
					username: 'newbie',
					email: 'newbie@example.test',
					role: 'user',
					invited: true,
					// Card 2196: the mail was waited for, and went.
					mailSent: true
				});
				expect(res.body).not.toHaveProperty('passwordHash');
				expect(res.body).not.toHaveProperty('inviteUrl');

				const invites = db.select().from(inviteTokens).all();
				expect(invites).toHaveLength(1);
				expect(invites[0]).toMatchObject({ userId: res.body.id, used: false });
				expect(parseStamp(invites[0].expiresAt)!.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);

				// The link mailed is the invite that was saved.
				expect(sent).toHaveLength(1);
				expect(sent[0]).toMatchObject({
					kind: 'email',
					to: 'newbie@example.test',
					html: expect.stringContaining(`/invite/${invites[0].token}`)
				});
			}
		});

		// A failure at the invite used to leave a user whose password nobody
		// knew and no invite with which to set one. The delete finds nothing:
		// an invite is issued one way, which ends any earlier one first.
		expect(shape(run.writes)).toEqual(['insert into users', 'delete from invite_tokens', 'insert into invite_tokens']);
		expect(run.effects.map(name)).toEqual(["email to newbie@example.test: You're invited to DumpFire!"]);
		expectHashedOutsideTransaction();
	});

	it('with a password, makes the user alone and mails nobody', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ chief }) =>
				create(chief, { username: 'deputy', email: 'deputy@example.test', password: NEW, role: 'admin' }),
			afterSuccess: async (_s, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({ username: 'deputy', role: 'admin', invited: false });
				expect(await matches(NEW, hashOf(res.body.id))).toBe(true);
				expect(db.select().from(inviteTokens).all()).toEqual([]);
			}
		});

		expect(shape(run.writes)).toEqual(['insert into users']);
		expect(run.effects).toEqual([]);
	});

	it('answers as it did for each refusal, with nothing written', async () => {
		const s = scene();
		const good = { username: 'newbie', email: 'newbie@example.test' };
		const message = async (by: SessionUser | null, body: Record<string, unknown>, status: number) =>
			(await expectRefused(() => create(by, body), status)).body.message;

		expect(await message(null, good, 403)).toBe('Forbidden');
		expect(await message(s.plain, good, 403)).toBe('Forbidden');
		expect(await message(s.admin, { ...good, username: ' a ' }, 400)).toBe('Username must be at least 2 characters');
		expect(await message(s.admin, { ...good, email: 'no at sign' }, 400)).toBe('Valid email required');
		expect(await message(s.admin, { ...good, password: 'short' }, 400)).toBe('Password must be at least 8 characters');
		expect(await message(s.admin, { ...good, role: 'admin' }, 403)).toBe('Only superadmin can create admin users');
		expect(await message(s.chief, { ...good, role: 'superadmin' }, 400)).toBe(
			'Cannot create additional superadmin accounts'
		);
		expect(await message(s.admin, { ...good, username: 'plain' }, 409)).toBe('Username already taken');
		expect(await message(s.admin, { ...good, email: 'plain@example.test' }, 409)).toBe('Email already in use');
		// None of those was hashed for.
		expect(bcrypt.inTransaction).toEqual([]);
	});

	it('with no mail set up, refuses a user with no password before anything else about them', async () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });

		const res = await expectRefused(
			() => create(admin, { username: 'newbie', email: 'newbie@example.test', role: 'superadmin' }),
			400
		);

		expect(res.body.message).toBe('Password must be at least 8 characters (SMTP not configured for invite emails)');
	});

	it('refuses a name that was taken after it was looked for', async () => {
		const s = scene();
		// The second read is the one that finds the address unused: the name
		// was looked for by the first.
		const reads = watchReads('users', (nth) => {
			if (nth === 2) makeUser({ username: 'newbie' });
		});

		let res: ApiResult;
		try {
			res = await create(s.admin, { username: 'newbie', email: 'another@example.test' });
		} finally {
			reads.restore();
		}

		expect(res.status).toBe(409);
		expect(res.body.message).toBe('Username already taken');
		// Looked for twice before the transaction, and found by the first read inside it.
		expect(reads.inTransaction).toEqual([false, false, true]);
		expect(db.select().from(users).all().filter((u) => u.username === 'newbie')).toHaveLength(1);
		expect(db.select().from(inviteTokens).all()).toEqual([]);
	});
});

// ─── Sending an invite again ────────────────────────────────────────────────

describe('POST /api/users/:id/invite', () => {
	/**
	 * The invitee has an invite waiting, one that expired unused and one that
	 * was used. A bystander has one waiting. Mail is switched on.
	 */
	const scene = () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const invitee = makeUser({ username: 'invitee' });
		const bystander = makeUser({ username: 'bystander' });
		makeInvite(invitee, 'waiting');
		makeInvite(invitee, 'expired', { expiresIn: -1000 });
		makeInvite(invitee, 'spent', { used: true });
		makeInvite(bystander, 'theirs');
		makeSmtp();
		return { admin, invitee, bystander };
	};

	const resend = (by: SessionUser, id: number) => api('POST', `/api/users/${id}/invite`, { user: by });

	/** The token in an invite mail's link. */
	const tokenIn = (html: string) => html.match(/\/invite\/([\w-]+)/)![1];

	it('ends every earlier invite of the account not yet used and writes the one it mails, or does neither', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ admin, invitee }) => resend(admin, invitee.id),
			afterSuccess: ({ invitee, bystander }, res: ApiResult, sent) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({
					success: true,
					// Card 2196: the mail was waited for, and went.
					mailSent: true,
					message: 'Invite sent to invitee@example.test. Any earlier invite to this account no longer works.'
				});

				// The one that was used stays, marked used. The one waiting and the
				// one expired are gone, and the one there is now is the one mailed.
				expect(sent).toHaveLength(1);
				expect(sent[0]).toMatchObject({ kind: 'email', to: 'invitee@example.test' });
				const mailed = tokenIn((sent[0] as { html: string }).html);
				expect(invitesOf(invitee.id)).toEqual([
					['spent', true],
					[mailed, false]
				]);
				const issued = db.select().from(inviteTokens).where(eq(inviteTokens.token, mailed)).get()!;
				expect(parseStamp(issued.expiresAt)!.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * HOUR);

				expect(invitesOf(bystander.id)).toEqual([['theirs', false]]);
			}
		});

		expect(shape(run.writes)).toEqual(['delete from invite_tokens', 'insert into invite_tokens']);
		expect(run.effects.map(name)).toEqual(["email to invitee@example.test: You're invited to DumpFire!"]);
	});

	it('leaves only the newest invite working: the earlier link is refused and the newer one sets the password', async () => {
		const { admin, invitee } = scene();
		const sent = effects();
		let first = '';
		let second = '';
		try {
			expect((await resend(admin, invitee.id)).status).toBe(200);
			expect((await resend(admin, invitee.id)).status).toBe(200);
			await sent.settle();
			[first, second] = sent.emails.map((mail) => tokenIn(mail.html));
		} finally {
			sent.restore();
		}
		expect(first).not.toBe(second);

		const form = { password: NEW, confirmPassword: NEW };
		const refused = await expectNothingWritten(() => action(`/invite/${first}`, { form }));
		expect(refused).toMatchObject(INVALID);
		expect(refused.cookies).toEqual({});
		expect(await loadInvite(first)).toEqual({ valid: false, username: '' });

		const used = await action(`/invite/${second}`, { form });
		expect(used).toMatchObject({ type: 'redirect', status: 303, location: '/' });
		expect(await matches(NEW, hashOf(invitee.id))).toBe(true);
	});
});

// ─── Using an invite ────────────────────────────────────────────────────────

describe('the invite page', () => {
	const TOKEN = 'the-invite-token';
	const form = { password: NEW, confirmPassword: NEW };

	const invited = () => {
		const invitee = makeUser({ username: 'invitee' });
		db.insert(inviteTokens)
			.values({ token: TOKEN, userId: invitee.id, expiresAt: stamp(new Date(Date.now() + 60 * 60 * 1000)) })
			.run();
		return { invitee };
	};

	const invite = () => db.select().from(inviteTokens).where(eq(inviteTokens.token, TOKEN)).get()!;
	const use = (fields: Record<string, string> = form, token = TOKEN) => action(`/invite/${token}`, { form: fields });

	/**
	 * The invitee also has a second invite waiting, two sessions and a key. A
	 * bystander has a session, an invite and a key.
	 */
	const invitedWithAccess = () => {
		const { invitee } = invited();
		const bystander = makeUser({ username: 'bystander' });
		makeInvite(invitee, 'another-invite');
		makeSession(invitee, 'invitee-laptop');
		makeSession(invitee, 'invitee-phone');
		makeApiKey(invitee, 'invitee key');
		makeSession(bystander, 'theirs');
		makeInvite(bystander, 'their-invite');
		makeApiKey(bystander, 'their key');
		return { invitee, bystander };
	};

	it('sets the password, uses the invite up, ends the account\'s other access and signs the user in, or does none of it', async () => {
		const run = await eachWriteInTurn({
			build: invitedWithAccess,
			request: () => use(),
			afterSuccess: async ({ invitee, bystander }, res: ActionResult) => {
				expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/' });
				expect(await matches(NEW, hashOf(invitee.id))).toBe(true);

				// This invite is kept, marked used; the other is gone, and so are
				// the sessions and the key. The one session is the cookie's.
				expect(invitesOf(invitee.id)).toEqual([[TOKEN, true]]);
				expect(keysOf(invitee.id)).toEqual([]);
				const mine = sessionsOf(invitee.id);
				expect(mine).toHaveLength(1);
				expect(mine).not.toContain('invitee-laptop');
				expect(mine).not.toContain('invitee-phone');
				expect(res.cookies[SESSION_COOKIE_NAME].value).toBe(mine[0]);

				expect(sessionsOf(bystander.id)).toEqual(['theirs']);
				expect(invitesOf(bystander.id)).toEqual([['their-invite', false]]);
				expect(keysOf(bystander.id)).toEqual(['their key']);
			}
		});

		// A failure at the second of these used to leave the password set and
		// the invite still good, for whoever had the link to set it again. The
		// sessions, the other invite and the key used to outlive it whatever
		// happened. This invite is marked used before the waiting ones are
		// deleted, so it is not among them.
		expect(shape(run.writes)).toEqual([
			'update users set',
			'update invite_tokens set',
			'delete from sessions',
			'delete from invite_tokens',
			'delete from api_keys',
			'update webhooks set',
			'update report_schedules set',
			'insert into sessions'
		]);
		expect(run.effects).toEqual([]);
		expectHashedOutsideTransaction();
	});

	it('refuses every other invite of the account once one is used, as two written before this rule would be', async () => {
		const { invitee } = invited();
		makeInvite(invitee, 'the-other-invite');

		expect(await use()).toMatchObject({ type: 'redirect', status: 303, location: '/' });

		const refused = await expectNothingWritten(() =>
			use({ password: 'a second password', confirmPassword: 'a second password' }, 'the-other-invite')
		);
		expect(refused).toMatchObject(INVALID);
		expect(refused.cookies).toEqual({});
		expect(await matches(NEW, hashOf(invitee.id))).toBe(true);
	});

	it('says on the page which links work, and how many API keys setting a password ends', async () => {
		const { invitee } = invited();
		makeApiKey(invitee);
		makeApiKey(invitee);

		expect(await loadInvite(TOKEN)).toEqual({
			valid: true,
			username: 'invitee',
			emoji: '👤',
			apiKeys: 2,
			webhooks: 0,
			reportSchedules: 0
		});

		// Replaced by a newer invite, issued the one way an invite is.
		const newer = inTransaction(() => issueInvite(invitee.id));
		expect(await loadInvite(TOKEN)).toEqual({ valid: false, username: '' });
		expect(await loadInvite(newer)).toMatchObject({ valid: true, apiKeys: 2 });
		expect(await loadInvite('no-such-token')).toEqual({ valid: false, username: '' });
	});

	it("refuses an invite for the superadmin's account, as one written before that was refused would be", async () => {
		const chief = withPassword(makeUser({ username: 'chief', role: 'superadmin' }));
		makeSession(chief, 'chief-laptop');
		const key = makeApiKey(chief, 'the automation');
		makeInvite(chief, 'for-the-superadmin');
		// An administrator's invite is the superadmin's to send, and works.
		const admin = makeUser({ username: 'admin', role: 'admin' });
		makeInvite(admin, 'for-an-administrator');

		expect(await loadInvite('for-the-superadmin')).toEqual({ valid: false, username: '' });
		expect(await loadInvite('for-an-administrator')).toMatchObject({ valid: true, username: 'admin' });

		const res = await expectNothingWritten(() => use(form, 'for-the-superadmin'));
		expect(res).toMatchObject(INVALID);
		expect(res.cookies).toEqual({});
		// Not hashed for, and the superadmin's password, session and key are as they were.
		expect(bcrypt.inTransaction).toEqual([]);
		expect(hashOf(chief.id)).toBe(OLD_HASH);
		expect(sessionsOf(chief.id)).toEqual(['chief-laptop']);
		expect((await meWithKey(key)).status).toBe(200);
	});

	it('cannot be used twice at the same moment', async () => {
		const { invitee } = invited();

		// Both are started before either is awaited. Each used to find the invite
		// unused before it read its form, and both went on to use it.
		const both = await Promise.all([
			use({ password: 'the first password', confirmPassword: 'the first password' }),
			use({ password: 'the second password', confirmPassword: 'the second password' })
		]);

		expect(both.map((res) => res.type).sort()).toEqual(['failure', 'redirect']);
		expect(both.find((res) => res.type === 'failure')).toMatchObject(INVALID);

		// One session, and its cookie went to the one that was let in.
		const mine = sessionsOf(invitee.id);
		expect(mine).toHaveLength(1);
		expect(both.find((res) => res.type === 'redirect')!.cookies[SESSION_COOKIE_NAME].value).toBe(mine[0]);
		expect(both.find((res) => res.type === 'failure')!.cookies).toEqual({});
		// The password is the one that was let in's. Each submission hashed its
		// own, since a hash is awaited and the second looks at the invite before
		// the first commits (card 2191, D10); the transaction let one in.
		expect(bcrypt.inTransaction).toEqual([false, false]);
	});

	it('refuses an invite that was used after it was looked at, having changed nothing else', async () => {
		const { invitee } = invited();
		// What the other submission would have committed by then.
		const reads = watchReads('invite_tokens', (nth) => {
			if (nth === 1) db.update(inviteTokens).set({ used: true }).where(eq(inviteTokens.token, TOKEN)).run();
		});

		let res: ActionResult;
		try {
			res = await use();
		} finally {
			reads.restore();
		}

		expect(res).toMatchObject(INVALID);
		expect(res.cookies).toEqual({});
		// Looked at before the transaction, and read again inside it.
		expect(reads.inTransaction).toEqual([false, true]);
		expect(hashOf(invitee.id)).toBe('not-a-real-hash');
		expect(sessionsOf(invitee.id)).toEqual([]);
	});

	it('answers as it did for each refusal, with nothing written and no cookie', async () => {
		const { invitee } = invited();
		const other = makeUser({ username: 'other' });
		db.insert(inviteTokens)
			.values([
				{ token: 'expired', userId: other.id, expiresAt: stamp(new Date(Date.now() - 1000)) },
				{ token: 'used', userId: other.id, expiresAt: stamp(new Date(Date.now() + 60 * 60 * 1000)), used: true }
			])
			.run();
		const refused = async (fields: Record<string, string>, token?: string) => {
			const res = await expectNothingWritten(() => use(fields, token));
			expect(res.cookies).toEqual({});
			return res;
		};

		// A dead link is answered as one whatever the form holds.
		expect(await refused({ password: 'short', confirmPassword: 'other' }, 'no-such-token')).toMatchObject(INVALID);
		expect(await refused(form, 'expired')).toMatchObject(INVALID);
		expect(await refused(form, 'used')).toMatchObject(INVALID);
		expect(await refused({ password: 'short', confirmPassword: 'short' })).toMatchObject({
			type: 'failure',
			status: 400,
			data: { error: 'Password must be at least 8 characters.' }
		});
		expect(await refused({ password: NEW, confirmPassword: 'something else' })).toMatchObject({
			type: 'failure',
			status: 400,
			data: { error: 'Passwords do not match.' }
		});

		// None of those was hashed for, and the invite is still good.
		expect(bcrypt.inTransaction).toEqual([]);
		expect(invite().used).toBe(false);
		expect(hashOf(invitee.id)).toBe('not-a-real-hash');
	});
});

// ─── What taking an account back switches off (card 2168) ───────────────────
//
// A webhook names the account that last set its address or secret
// (`webhooks.set_by`, migration 0056). An administrator's reset and an invite
// used switch off every webhook the account set and pause its report
// schedules; the holder's own change switches off the webhooks only when they
// end their keys, and pauses no schedule. A webhook nobody is recorded as
// having set, and one somebody else set, are left alone.

describe('what taking an account back switches off (card 2168)', () => {
	/** A webhook's switch and its setter, as stored. */
	const hookRow = (id: number) =>
		sqlite.prepare('SELECT active, set_by AS setBy FROM webhooks WHERE id = ?').get(id) as { active: number; setBy: number | null };
	/** A report schedule's switch and when it was last changed, as stored. */
	const scheduleRow = (id: number) =>
		sqlite.prepare('SELECT enabled, updated_at AS updatedAt FROM report_schedules WHERE id = ?').get(id) as {
			enabled: number;
			updatedAt: string;
		};
	const LONG_AGO = '2020-01-01 00:00:00';
	const makeSchedule = (user: SessionUser, opts: { enabled?: boolean } = {}) =>
		db
			.insert(reportSchedules)
			.values({ userId: user.id, name: 'Weekly', scope: 'all', enabled: opts.enabled ?? true, updatedAt: LONG_AGO })
			.returning()
			.get().id;

	/**
	 * The target owns a board with four webhooks: one they set, one an editor
	 * set, one nobody is recorded as having set (as one made before 0056), and
	 * one they set that is already off. The target has a report schedule that
	 * is on and one that is paused; the editor has one that is on.
	 */
	const scene = () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const target = withPassword(makeUser({ username: 'target' }));
		const editor = makeUser({ username: 'editor' });
		const { board } = makeBoard({ owner: target, name: 'Theirs' });
		addBoardMember(board, editor, 'editor');
		const hooks = {
			theirs: makeWebhook(board, { url: 'https://hooks.example.test/theirs', setBy: target }).id,
			editors: makeWebhook(board, { url: 'https://hooks.example.test/editors', setBy: editor }).id,
			nobodys: makeWebhook(board, { url: 'https://hooks.example.test/nobodys', setBy: null }).id,
			alreadyOff: makeWebhook(board, { url: 'https://hooks.example.test/off', setBy: target, active: false }).id
		};
		const schedules = {
			theirs: makeSchedule(target),
			alreadyPaused: makeSchedule(target, { enabled: false }),
			editors: makeSchedule(editor)
		};
		return { admin, target, editor, board, hooks, schedules };
	};
	type Scene = ReturnType<typeof scene>;

	const reset = (by: SessionUser, id: number) => api('PUT', `/api/users/${id}/password`, { user: by, body: { password: NEW } });

	/** Only the target's webhook that was on, and their schedule that was on, changed. */
	function expectTakenBack(s: Scene, opts: { schedules: boolean }) {
		// Switched off, and still naming who set it.
		expect(hookRow(s.hooks.theirs)).toEqual({ active: 0, setBy: s.target.id });
		expect(hookRow(s.hooks.editors)).toEqual({ active: 1, setBy: s.editor.id });
		expect(hookRow(s.hooks.nobodys)).toEqual({ active: 1, setBy: null });
		expect(hookRow(s.hooks.alreadyOff)).toEqual({ active: 0, setBy: s.target.id });

		const paused = scheduleRow(s.schedules.theirs);
		if (opts.schedules) {
			expect(paused.enabled).toBe(0);
			expect(paused.updatedAt).not.toBe(LONG_AGO);
			expect(parseStamp(paused.updatedAt)).not.toBeNull();
		} else {
			expect(paused).toEqual({ enabled: 1, updatedAt: LONG_AGO });
		}
		// One already paused is not counted or touched; nobody else's is.
		expect(scheduleRow(s.schedules.alreadyPaused)).toEqual({ enabled: 0, updatedAt: LONG_AGO });
		expect(scheduleRow(s.schedules.editors)).toEqual({ enabled: 1, updatedAt: LONG_AGO });
	}

	/** The system log's lines from the AUTH context, with their meta read. */
	const authLines = (like: string) =>
		(sqlite.prepare('SELECT message, meta FROM system_logs WHERE message LIKE ? ORDER BY id').all(like) as {
			message: string;
			meta: string;
		}[]).map((line) => ({ message: line.message, meta: JSON.parse(line.meta) }));

	/** Run `test` with INFO lines written, and the level put back. */
	async function atInfo(test: () => Promise<void>) {
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'INFO';
		try {
			await test();
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
	}

	it("on an administrator's reset, switches off the webhooks the account set and pauses its report schedules, or does neither", async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ admin, target }) => reset(admin, target.id),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({
					success: true,
					sessionsEnded: 0,
					apiKeysEnded: 0,
					webhooksSwitchedOff: 1,
					reportSchedulesPaused: 1
				});
				expectTakenBack(s, { schedules: true });
			}
		});

		// Each failure in turn left the webhook on and the schedule enabled,
		// with nothing sent: `eachWriteInTurn` checks every row each time.
		expect(shape(run.writes)).toEqual([
			'update users set',
			'delete from sessions',
			'delete from invite_tokens',
			'delete from api_keys',
			'update webhooks set',
			'update report_schedules set'
		]);
		expect(run.effects).toEqual([]);
	});

	it('sends the next event to every webhook of the board but those switched off, and names what went in the log', async () => {
		await atInfo(async () => {
			const s = scene();
			// Registered with one of the target's keys, so its setter is theirs.
			const made = await api('POST', `/api/v1/boards/${s.board.id}/webhooks`, {
				user: s.target,
				body: { url: 'https://hooks.example.test/registered' }
			});
			expect(made.status).toBe(201);

			const sent = effects();
			try {
				const res = await reset(s.admin, s.target.id);
				expect(res.body).toMatchObject({ webhooksSwitchedOff: 2, reportSchedulesPaused: 1 });
				expect(hookRow(made.body.id)).toEqual({ active: 0, setBy: s.target.id });

				dispatchWebhook(s.board.id, 'card.moved', { cardId: 1 });
				await sent.settle();
				// The one nobody is recorded as having set is left on by the
				// reset, and held at delivery since card 2325.
				expect(hookRow(s.hooks.nobodys)).toEqual({ active: 1, setBy: null });
				expect(sent.webhooks.map((hook) => hook.url)).toEqual(['https://hooks.example.test/editors']);
			} finally {
				sent.restore();
			}

			expect(authLines('Password reset for user%')).toEqual([
				{
					message:
						`Password reset for user ${s.target.id} ("target") by "admin" — ended 0 session(s), 0 invite(s) and ` +
						`0 API key(s), switched off 2 webhook(s) they set up (ids ${s.hooks.theirs}, ${made.body.id}) and ` +
						`paused 1 report schedule(s) (id ${s.schedules.theirs})`,
					meta: {
						targetUserId: s.target.id,
						resetBy: s.admin.id,
						sessionsEnded: 0,
						invitesEnded: 0,
						apiKeysEnded: 0,
						webhooksSwitchedOff: 2,
						webhookIds: [s.hooks.theirs, made.body.id],
						reportSchedulesPaused: 1,
						reportScheduleIds: [s.schedules.theirs]
					}
				}
			]);
		});
	});

	it('when an invite is used, switches off the webhooks the account set and pauses its report schedules, or does neither', async () => {
		const withInvite = () => {
			const s = scene();
			makeInvite(s.target, 'the-token');
			return s;
		};
		const use = () => action('/invite/the-token', { form: { password: NEW, confirmPassword: NEW } });

		const run = await eachWriteInTurn({
			build: withInvite,
			request: use,
			afterSuccess: (s, res: ActionResult) => {
				expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/' });
				expectTakenBack(s, { schedules: true });
			}
		});
		expect(shape(run.writes)).toEqual([
			'update users set',
			'update invite_tokens set',
			'delete from sessions',
			'delete from invite_tokens',
			'delete from api_keys',
			'update webhooks set',
			'update report_schedules set',
			'insert into sessions'
		]);

		await atInfo(async () => {
			resetDb();
			const s = withInvite();
			await use();
			expect(authLines('Password set with an invite%')).toEqual([
				{
					message:
						`Password set with an invite for user ${s.target.id} — ended 0 session(s), 0 other invite(s) and ` +
						`0 API key(s), switched off 1 webhook(s) they set up (id ${s.hooks.theirs}) and paused 1 report ` +
						`schedule(s) (id ${s.schedules.theirs})`,
					meta: {
						sessionsEnded: 0,
						invitesEnded: 0,
						apiKeysEnded: 0,
						webhooksSwitchedOff: 1,
						webhookIds: [s.hooks.theirs],
						reportSchedulesPaused: 1,
						reportScheduleIds: [s.schedules.theirs]
					}
				}
			]);
		});
	});

	it("on the holder's own change, switches off the webhooks they set only when they end their keys, and pauses no schedule", async () => {
		await atInfo(async () => {
			const s = scene();

			// A change that keeps the keys keeps their webhooks.
			const kept = await changeOwn(s.target, { currentPassword: OLD, newPassword: NEW });
			expect(kept.body).toEqual({ success: true, apiKeysEnded: 0, webhooksSwitchedOff: 0 });
			expect(hookRow(s.hooks.theirs)).toEqual({ active: 1, setBy: s.target.id });
			expect(scheduleRow(s.schedules.theirs)).toEqual({ enabled: 1, updatedAt: LONG_AGO });

			// Asked to end the keys, with none to end: the webhook they set is
			// switched off all the same (R-S5), and the schedule stays on.
			const ended = await changeOwn(s.target, { currentPassword: NEW, newPassword: 'a third password', endApiKeys: true });
			expect(ended.body).toEqual({ success: true, apiKeysEnded: 0, webhooksSwitchedOff: 1 });
			expectTakenBack(s, { schedules: false });

			expect(authLines('Password changed by user%').map((line) => line.message)).toEqual([
				'Password changed by user — ended 0 session(s), 0 invite(s) and 0 API key(s), and switched off 0 webhook(s) they set up',
				// The session the first change started is among those the second ends.
				`Password changed by user — ended 1 session(s), 0 invite(s) and 0 API key(s), and switched off 1 webhook(s) they set up (id ${s.hooks.theirs})`
			]);
			expect(authLines('Password changed by user%')[1].meta).toEqual({
				sessionsEnded: 1,
				invitesEnded: 0,
				apiKeysEnded: 0,
				webhooksSwitchedOff: 1,
				webhookIds: [s.hooks.theirs]
			});
		});
	});

	it("makes an administrator who re-points somebody else's webhook its setter, so the administrator's reset switches it off", async () => {
		const s = scene();
		const chief = makeUser({ username: 'chief', role: 'superadmin' });

		const repointed = await api('PUT', `/api/v1/webhooks/${s.hooks.editors}`, {
			user: s.admin,
			body: { url: 'https://admins.example.test/x' }
		});
		expect(repointed.status).toBe(200);

		const res = await reset(chief, s.admin.id);
		expect(res.body).toMatchObject({ webhooksSwitchedOff: 1, reportSchedulesPaused: 0 });
		expect(hookRow(s.hooks.editors)).toEqual({ active: 0, setBy: s.admin.id });
		expect(hookRow(s.hooks.theirs)).toEqual({ active: 1, setBy: s.target.id });
	});

	it("leaves a webhook a reset switched off for the board's owner or an administrator to switch on, not an editor", async () => {
		const s = scene();
		expect((await reset(s.admin, s.target.id)).status).toBe(200);
		const switchOn = (user: SessionUser) => api('PUT', `/api/v1/webhooks/${s.hooks.theirs}`, { user, body: { active: true } });

		const refused = await switchOn(s.editor);
		expect(refused.status).toBe(403);
		expect(refused.body.message).toBe("Only the board's owner or an administrator can switch a webhook on. Ask the board's owner.");
		expect(hookRow(s.hooks.theirs).active).toBe(0);

		// The board's owner, signed in again with the new password.
		expect((await switchOn(s.target)).status).toBe(200);
		expect(hookRow(s.hooks.theirs).active).toBe(1);
	});

	it('says on the invite page how many webhooks and report schedules setting a password switches off and pauses', async () => {
		const s = scene();
		makeInvite(s.target, 'the-token');

		expect(await loadInvite('the-token')).toEqual({
			valid: true,
			username: 'target',
			emoji: '👤',
			apiKeys: 0,
			webhooks: 1,
			reportSchedules: 1
		});
	});

	describe('a create or a change whose body arrives after the reset (the review, S1)', () => {
		// The request is sent through the gate with its body held back, the
		// reset (or nothing) made once the gate has let it in, and then the body:
		// `sendAround` in ./helpers/held-body.ts.
		const hooksOn = (boardId: number) =>
			sqlite.prepare('SELECT id, url, active, set_by AS setBy FROM webhooks WHERE board_id = ? ORDER BY id').all(boardId);
		const schedulesOf = (userId: number) =>
			sqlite.prepare('SELECT id, name, enabled FROM report_schedules WHERE user_id = ? ORDER BY id').all(userId);
		const SCHEDULE = (boardId: number) => ({ name: 'Late', scope: 'board', scopeId: boardId, frequency: 'weekly' });

		it('refuses 401 a webhook made or re-pointed with a key the reset ended, and writes nothing', async () => {
			const s = scene();
			const key = makeApiKey(s.target);
			const resetTarget = () => reset(s.admin, s.target.id);

			const made = await sendAround('POST', `/api/v1/boards/${s.board.id}/webhooks`, { key }, { url: 'https://intruder.example.test/new' }, resetTarget);
			expect(made).toEqual({ status: 401, body: { message: 'Invalid or expired API key' } });
			const after = hooksOn(s.board.id);
			expect(after).toHaveLength(4);

			// A second key, made again after the first reset, for the change.
			const again = makeApiKey(s.target);
			const changed = await sendAround(
				'PUT',
				`/api/v1/webhooks/${s.hooks.theirs}`,
				{ key: again },
				{ url: 'https://intruder.example.test/back', active: true },
				resetTarget
			);
			expect(changed).toEqual({ status: 401, body: { message: 'Invalid or expired API key' } });
			expect(hooksOn(s.board.id)).toEqual(after);
			expect(hookRow(s.hooks.theirs)).toEqual({ active: 0, setBy: s.target.id });
		});

		it('refuses 401 a report schedule made or switched on with a session the reset ended, and writes nothing', async () => {
			const s = scene();
			const resetTarget = () => reset(s.admin, s.target.id);

			makeSession(s.target, 'target-laptop');
			const made = await sendAround('POST', '/api/report-schedules', { session: 'target-laptop' }, SCHEDULE(s.board.id), resetTarget);
			expect(made).toEqual({ status: 401, body: { message: 'Not authenticated' } });
			const after = schedulesOf(s.target.id);
			expect(after).toHaveLength(2);

			// Signed in again after the first reset, for the change.
			makeSession(s.target, 'target-phone');
			const changed = await sendAround(
				'PUT',
				`/api/report-schedules/${s.schedules.theirs}`,
				{ session: 'target-phone' },
				{ enabled: true },
				resetTarget
			);
			expect(changed).toEqual({ status: 401, body: { message: 'Not authenticated' } });
			expect(schedulesOf(s.target.id)).toEqual(after);
			expect(scheduleRow(s.schedules.theirs).enabled).toBe(0);
		});

		it('lets each through, sent the same way, when nothing ended meanwhile', async () => {
			const s = scene();
			const key = makeApiKey(s.target);
			const session = 'target-laptop';
			makeSession(s.target, session);
			const nothing = async () => {};

			const made = await sendAround('POST', `/api/v1/boards/${s.board.id}/webhooks`, { key }, { url: 'https://hooks.example.test/new' }, nothing);
			expect(made.status).toBe(201);
			const changed = await sendAround('PUT', `/api/v1/webhooks/${s.hooks.alreadyOff}`, { key }, { active: true }, nothing);
			expect(changed.status).toBe(200);
			const scheduled = await sendAround('POST', '/api/report-schedules', { session }, SCHEDULE(s.board.id), nothing);
			expect(scheduled.status).toBe(201);
			const resumed = await sendAround('PUT', `/api/report-schedules/${s.schedules.alreadyPaused}`, { session }, { enabled: true }, nothing);
			expect(resumed.status).toBe(200);
		});
	});
});

// ─── Making an API key ──────────────────────────────────────────────────────

describe('POST /api/account/api-keys', () => {
	const scene = () => {
		const me = withPassword(makeUser({ username: 'me' }));
		makeSession(me, 'my-laptop');
		return { me };
	};

	const create = (by: SessionUser | null, body: Record<string, unknown>) =>
		api('POST', '/api/account/api-keys', { user: by, body, headers: from('my-laptop') });

	it('makes a key for the right password, writing nothing but the key', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ me }) => create(me, { name: 'my script', password: OLD }),
			afterSuccess: ({ me }, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({ name: 'my script', key: expect.stringMatching(/^df_[0-9a-f]{64}$/) });
				expect(res.body.keyPrefix).toBe(res.body.key.slice(0, 11));
				expect(keysOf(me.id)).toEqual(['my script']);
			}
		});

		expect(shape(run.writes)).toEqual(['insert into api_keys']);
		expect(run.effects).toEqual([]);
		// Checked outside a transaction, where a quarter of a second holds nobody up.
		expectHashedOutsideTransaction();
	});

	it('writes the key’s id and its user to the system log, and not its name or prefix', async () => {
		const { me } = scene();
		// The suite logs errors only; this line is an INFO one.
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'INFO';
		const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
		let res: ApiResult;
		try {
			res = await create(me, { name: 'a name for nobody else', password: OLD });
		} finally {
			quiet.mockRestore();
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		expect(res.status).toBe(201);
		const logged = sqlite
			.prepare(`SELECT message, meta, user_id AS userId FROM system_logs WHERE message LIKE 'API key %created by user%'`)
			.all() as { message: string; meta: string; userId: number }[];
		expect(logged).toHaveLength(1);
		expect(logged[0].message).toBe(`API key ${res.body.id} created by user ${me.id}`);
		expect(JSON.parse(logged[0].meta)).toEqual({ keyId: res.body.id });
		expect(logged[0].userId).toBe(me.id);
		// Every administrator reads this log, and every backup holds it.
		const everything = JSON.stringify(sqlite.prepare('SELECT message, meta FROM system_logs').all());
		expect(everything).not.toContain('a name for nobody else');
		expect(everything).not.toContain(res.body.keyPrefix);
	});

	it('refuses with no password, one that is not text, or the wrong one, with nothing written', async () => {
		const { me } = scene();
		const message = async (body: Record<string, unknown>, status: number) =>
			(await expectRefused(() => create(me, body), status)).body.message;

		await expectRefused(() => create(null, { name: 'my script', password: OLD }), 401);
		expect(await message({ name: 'my script' }, 400)).toBe('Password is required');
		expect(await message({ name: 'my script', password: '' }, 400)).toBe('Password is required');
		expect(await message({ name: 'my script', password: 12345 }, 400)).toBe('Password is required');
		// The name is looked at first, as it always was.
		expect(await message({ password: OLD }, 400)).toBe('Key name is required');
		expect(bcrypt.inTransaction).toEqual([]);

		expect(await message({ name: 'my script', password: 'not it' }, 403)).toBe('Password is incorrect');
		expect(keysOf(me.id)).toEqual([]);
	});

	it('refuses when the password was changed elsewhere after it was checked, and makes no key', async () => {
		const { me } = scene();
		const elsewhere = await makePasswordHash('changed elsewhere', 'known');
		// The first read is the one the password is checked against.
		const reads = watchReads('users', (nth) => {
			if (nth === 1) db.update(users).set({ passwordHash: elsewhere }).where(eq(users.id, me.id)).run();
		});

		let res: ApiResult;
		try {
			res = await create(me, { name: 'my script', password: OLD });
		} finally {
			reads.restore();
		}

		expect(res.status).toBe(403);
		expect(res.body.message).toBe('Password is incorrect');
		// Looked at before the transaction, and read again inside it.
		expect(reads.inTransaction).toEqual([false, true]);
		expect(keysOf(me.id)).toEqual([]);
	});

	it('refuses an eleventh key, counted again in the transaction that adds one', async () => {
		const { me } = scene();
		for (let n = 1; n <= 9; n++) makeApiKey(me, `key ${n}`);

		// The tenth lands between the first count and the transaction.
		const reads = watchReads('api_keys', (nth) => {
			if (nth === 1) makeApiKey(me, 'key 10');
		});
		let res: ApiResult;
		try {
			res = await create(me, { name: 'one too many', password: OLD });
		} finally {
			reads.restore();
		}
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('Maximum of 10 API keys per user');
		expect(reads.inTransaction).toEqual([false, true]);
		expect(keysOf(me.id)).toHaveLength(10);

		// And with ten there already, refused before the password is checked.
		bcrypt.inTransaction.length = 0;
		expect(await expectRefused(() => create(me, { name: 'one too many', password: OLD }), 400)).toMatchObject({
			body: { message: 'Maximum of 10 API keys per user' }
		});
		expect(bcrypt.inTransaction).toEqual([]);
	});
});

// ─── Changing an account's email address or role ────────────────────────────

/**
 * The target has a password, a session, an invite waiting, one that expired
 * unused and one that was used. A bystander has one waiting, and so does the
 * second administrator.
 */
const withInvites = () => {
	const chief = makeUser({ username: 'chief', role: 'superadmin' });
	const admin = makeUser({ username: 'admin', role: 'admin' });
	const otherAdmin = makeUser({ username: 'other-admin', role: 'admin' });
	const target = withPassword(makeUser({ username: 'target' }));
	const bystander = makeUser({ username: 'bystander' });
	makeSession(target, 'my-laptop');
	makeInvite(target, 'waiting');
	makeInvite(target, 'expired', { expiresIn: -1000 });
	makeInvite(target, 'spent', { used: true });
	makeInvite(bystander, 'theirs');
	makeInvite(otherAdmin, 'for-the-other-admin');
	return { chief, admin, otherAdmin, target, bystander };
};

/** The invite page and its form both answer the link of `token` as a dead one. */
async function expectDeadLink(token: string): Promise<void> {
	expect(await loadInvite(token)).toEqual({ valid: false, username: '' });
	expect(await action(`/invite/${token}`, { form: { password: NEW, confirmPassword: NEW } })).toMatchObject(INVALID);
}

describe('PUT /api/users/:id', () => {
	const change = (by: SessionUser, id: number, body: Record<string, unknown>) =>
		api('PUT', `/api/users/${id}`, { user: by, body });

	it('ends every invite of the account not yet used when the superadmin changes its email, or does neither', async () => {
		const run = await eachWriteInTurn({
			build: withInvites,
			request: ({ chief, target }) => change(chief, target.id, { email: 'Moved@Example.test' }),
			afterSuccess: async ({ target, bystander }, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({
					id: target.id,
					username: 'target',
					email: 'moved@example.test',
					emoji: '👤',
					role: 'user',
					createdAt: expect.any(String),
					invitesEnded: 2
				});

				// The one that was used stays, marked used. The one waiting and the
				// one expired are gone, and nobody else's.
				expect(invitesOf(target.id)).toEqual([['spent', true]]);
				expect(invitesOf(bystander.id)).toEqual([['theirs', false]]);
				// Whoever has the mail, at the address the account had, is told it no longer works.
				await expectDeadLink('waiting');

				// An email change is not a password change: nobody is signed out.
				expect(sessionsOf(target.id)).toEqual(['my-laptop']);
				expect(hashOf(target.id)).toBe(OLD_HASH);
			}
		});

		// The invites end before the account is written, in its transaction.
		expect(shape(run.writes)).toEqual(['delete from invite_tokens', 'update users set']);
		expect(run.effects).toEqual([]);
	});

	it('ends them when the superadmin makes the account an administrator, and again when it is made a user', async () => {
		const { chief, target } = withInvites();

		const promoted = await change(chief, target.id, { role: 'admin' });
		expect(promoted.status).toBe(200);
		expect(promoted.body).toMatchObject({ role: 'admin', invitesEnded: 2 });
		expect(invitesOf(target.id)).toEqual([['spent', true]]);
		await expectDeadLink('waiting');

		// One sent while the account is an administrator's ends when it is a user's again.
		const sentToAnAdmin = inTransaction(() => issueInvite(target.id));
		const demoted = await change(chief, target.id, { role: 'user' });
		expect(demoted.status).toBe(200);
		expect(demoted.body).toMatchObject({ role: 'user', invitesEnded: 1 });
		expect(invitesOf(target.id)).toEqual([['spent', true]]);
		await expectDeadLink(sentToAnAdmin);
	});

	it("ends them when an administrator changes an ordinary user's email", async () => {
		const { admin, target, bystander } = withInvites();

		const res = await change(admin, target.id, { email: 'elsewhere@example.test' });

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ email: 'elsewhere@example.test', invitesEnded: 2 });
		expect(invitesOf(target.id)).toEqual([['spent', true]]);
		expect(invitesOf(bystander.id)).toEqual([['theirs', false]]);
		await expectDeadLink('waiting');
	});

	it('ends none for a change of neither: the same email in other case, an emoji, a username, the role it has', async () => {
		const { chief, admin, target } = withInvites();
		const changes: [SessionUser, Record<string, unknown>][] = [
			[chief, { email: 'TARGET@Example.Test' }],
			[admin, { emoji: '🦊' }],
			[admin, { username: 'renamed' }],
			[chief, { role: 'user' }],
			[admin, { role: 'user', emoji: '🐙' }],
			[admin, {}]
		];

		for (const [by, body] of changes) {
			const res = await change(by, target.id, body);
			expect(res.status, JSON.stringify(body)).toBe(200);
			expect(res.body.invitesEnded, JSON.stringify(body)).toBe(0);
		}

		expect(invitesOf(target.id)).toEqual([
			['waiting', false],
			['expired', false],
			['spent', true]
		]);
		// And the invite still sets the password.
		expect(await action('/invite/waiting', { form: { password: NEW, confirmPassword: NEW } })).toMatchObject({
			type: 'redirect',
			status: 303,
			location: '/'
		});
		expect(await matches(NEW, hashOf(target.id))).toBe(true);
	});

	it('ends nothing when it refuses: an administrator naming another administrator, or their own email', async () => {
		const { admin, otherAdmin } = withInvites();

		for (const body of [{ email: 'moved@example.test' }, { role: 'user' }]) {
			const res = await expectRefused(() => change(admin, otherAdmin.id, body), 403);
			expect(res.body.message).toBe('Only superadmin can modify admin users');
		}
		expect((await expectRefused(() => change(admin, admin.id, { email: 'moved@example.test' }), 403)).body.message).toBe(
			'Change your own email on the Account page, which asks for your current password'
		);

		expect(await loadInvite('for-the-other-admin')).toMatchObject({ valid: true, username: 'other-admin' });
	});
});

describe('PUT /api/account/email', () => {
	const moveTo = (me: SessionUser, newEmail: string, password: string = OLD) =>
		api('PUT', '/api/account/email', { user: me, body: { newEmail, password }, headers: from('my-laptop') });

	it('changes the address and ends every invite of the account not yet used, or does neither, and keeps the session that asked', async () => {
		const run = await eachWriteInTurn({
			build: withInvites,
			request: ({ target }) => moveTo(target, ' Moved@Example.test '),
			afterSuccess: async ({ target, bystander }, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true, email: 'moved@example.test' });
				expect(userRow(target.id).email).toBe('moved@example.test');

				expect(invitesOf(target.id)).toEqual([['spent', true]]);
				expect(invitesOf(bystander.id)).toEqual([['theirs', false]]);
				await expectDeadLink('waiting');

				// The session that asked is still good.
				expect(sessionStillOpen('my-laptop')).toBe(true);
			}
		});

		// The address used to be written on its own, with no transaction and nothing else.
		expect(shape(run.writes)).toEqual(['delete from invite_tokens', 'update users set']);
		expect(run.effects).toEqual([]);
		// Checked before the transaction, where a quarter of a second holds nobody up.
		expectHashedOutsideTransaction();
	});

	it('ends none for the address it has, in other case', async () => {
		const { target } = withInvites();

		const res = await moveTo(target, 'TARGET@example.test');

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true, email: 'target@example.test' });
		expect(invitesOf(target.id)).toHaveLength(3);
		expect(await loadInvite('waiting')).toMatchObject({ valid: true, username: 'target' });
	});

	it('ends nothing when it refuses: a wrong password, an address in use', async () => {
		const { target } = withInvites();

		expect((await expectRefused(() => moveTo(target, 'moved@example.test', 'not it'), 403)).body.message).toBe(
			'Password is incorrect'
		);
		expect((await expectRefused(() => moveTo(target, 'Bystander@example.test'), 409)).body.message).toBe(
			'Email is already in use'
		);

		expect(await loadInvite('waiting')).toMatchObject({ valid: true, username: 'target' });
	});

	it('refuses an address taken after the password was checked, inside the transaction that writes it', async () => {
		const { target, bystander } = withInvites();
		// The first read is the one the password is checked against.
		const reads = watchReads('users', (nth) => {
			if (nth === 1) db.update(users).set({ email: 'moved@example.test' }).where(eq(users.id, bystander.id)).run();
		});

		let res: ApiResult;
		try {
			res = await moveTo(target, 'moved@example.test');
		} finally {
			reads.restore();
		}

		expect(res.status).toBe(409);
		expect(res.body.message).toBe('Email is already in use');
		// Read again inside it, and the address looked for there.
		expect(reads.inTransaction).toEqual([false, true, true]);
		expect(userRow(target.id).email).toBe('target@example.test');
		expect(invitesOf(target.id)).toHaveLength(3);
	});
});

describe('the system log, when an email or a role changes', () => {
	it('has one INFO line after the commit for each route, naming who changed whose account and how many invites ended, and no address', async () => {
		const { chief, target } = withInvites();
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'INFO';
		const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			expect((await api('PUT', `/api/users/${target.id}`, { user: chief, body: { email: 'moved@example.test', role: 'admin' } })).status).toBe(200);
			// Nothing changes, so nothing is said.
			expect((await api('PUT', `/api/users/${target.id}`, { user: chief, body: { role: 'admin' } })).status).toBe(200);
			inTransaction(() => issueInvite(target.id));
			const moved = await api('PUT', '/api/account/email', {
				user: { ...target, role: 'admin' },
				body: { newEmail: 'again@example.test', password: OLD },
				headers: from('my-laptop')
			});
			expect(moved.status).toBe(200);
		} finally {
			quiet.mockRestore();
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		const lines = sqlite
			.prepare("SELECT level, context, message, meta, user_id AS userId FROM system_logs WHERE message LIKE '%unused invite(s)'")
			.all() as { level: string; context: string; message: string; meta: string; userId: number }[];
		expect(lines.map((line) => [line.level, line.context, line.message, line.userId, JSON.parse(line.meta)])).toEqual([
			[
				'INFO',
				'AUTH',
				`User ${chief.id} changed the email address and role of user ${target.id} — ended 2 unused invite(s)`,
				chief.id,
				{ targetUserId: target.id, changed: ['email address', 'role'], role: 'admin', invitesEnded: 2 }
			],
			['INFO', 'AUTH', `User ${target.id} changed their email address — ended 1 unused invite(s)`, target.id, { invitesEnded: 1 }]
		]);
		expect(JSON.stringify(lines)).not.toContain('example.test');
	});
});

describe('endUnusedInvites', () => {
	it('ends invites only inside a transaction, as an invite is issued only inside one', () => {
		const { target } = withInvites();

		expect(() => endUnusedInvites(target.id)).toThrow(/^endUnusedInvites must be called inside the transaction/);
		expect(invitesOf(target.id)).toHaveLength(3);

		expect(inTransaction(() => endUnusedInvites(target.id))).toBe(2);
		expect(invitesOf(target.id)).toEqual([['spent', true]]);
	});
});

// ─── Wrong current passwords ────────────────────────────────────────────────

describe('wrong current passwords', () => {
	/** A route that asks for the current password, and what it says when it is wrong and when it is not text. */
	type Asking = {
		method: 'PUT' | 'POST';
		path: string;
		body: (password: unknown) => Record<string, unknown>;
		wrong: string;
		notText: string;
	};

	const ASKING: Asking[] = [
		{
			method: 'PUT',
			path: '/api/account/email',
			body: (password) => ({ newEmail: 'moved@example.test', password }),
			wrong: 'Password is incorrect',
			notText: 'Password is required'
		},
		{
			method: 'PUT',
			path: '/api/account/password',
			body: (currentPassword) => ({ currentPassword, newPassword: NEW }),
			wrong: 'Current password is incorrect',
			notText: 'Current password is required'
		},
		{
			method: 'POST',
			path: '/api/account/api-keys',
			body: (password) => ({ name: 'my script', password }),
			wrong: 'Password is incorrect',
			notText: 'Password is required'
		}
	];
	const [EMAIL, PASSWORD, KEY] = ASKING;
	const named = ASKING.map((route) => [`${route.method} ${route.path}`, route] as const);

	const TOO_MANY = 'Too many wrong passwords. Try again in 15 minute(s).';

	/** Signed in on two devices, with `OLD` as the password. */
	const signedIn = () => {
		const me = withPassword(makeUser({ username: 'me' }));
		makeSession(me, 'my-laptop');
		makeSession(me, 'my-phone');
		return { me };
	};

	/** The route, with this password, from the session `session`, or with no session cookie for `null`. */
	const send = (route: Asking, me: SessionUser, password: unknown, session: string | null = 'my-laptop') =>
		api(route.method, route.path, {
			user: me,
			body: route.body(password),
			headers: session === null ? undefined : from(session)
		});

	/** `times` wrong passwords, each answered as wrong with nothing written. */
	async function wrong(route: Asking, me: SessionUser, times: number): Promise<void> {
		for (let n = 1; n <= times; n++) {
			const res = await expectRefused(() => send(route, me, 'not it'), 403);
			expect(res.body.message).toBe(route.wrong);
		}
	}

	it.each(named)('%s: refuses the eleventh attempt in 15 minutes, the right password included, without checking it', async (_name, route) => {
		const { me } = signedIn();
		await wrong(route, me, 10);
		bcrypt.inTransaction.length = 0;

		for (const password of ['not it', OLD]) {
			const res = await expectRefused(() => send(route, me, password), 429);
			expect(res.body.message).toBe(TOO_MANY);
		}

		// Neither was checked, and the password is the one it was.
		expect(bcrypt.inTransaction).toEqual([]);
		expect(hashOf(me.id)).toBe(OLD_HASH);
	});

	// The review's L1. A current password is checked in the first lane, ahead
	// of every sign-in, and the right one clears the session's count, so a
	// signed-in user could keep checks in flight without end and hold the
	// second lane. Each check takes a place at the account's first-lane
	// checks, five in flight, shared with its remembered browsers' sign-ins.
	it.each(named)('%s: refuses a sixth check in flight at the account, from any session, without checking it', async (_name, route) => {
		const { me } = signedIn();

		const six = await Promise.all(
			Array.from({ length: 6 }, (_, n) => send(route, me, 'not it', n % 2 === 0 ? 'my-laptop' : 'my-phone'))
		);

		expect(six.map((res) => res.status)).toEqual([403, 403, 403, 403, 403, 429]);
		expect(six[5].body.message).toBe(PASSWORDS_BUSY);
		expect(bcrypt.inTransaction).toHaveLength(5);
		expect(hashOf(me.id)).toBe(OLD_HASH);

		// The places are given back once each is answered.
		expect((await send(route, me, 'not it')).status).toBe(403);
	});

	it('keeps one count for the three routes, for the session', async () => {
		const { me } = signedIn();
		await wrong(EMAIL, me, 4);
		await wrong(PASSWORD, me, 4);
		await wrong(KEY, me, 2);

		for (const route of ASKING) {
			expect((await expectRefused(() => send(route, me, OLD), 429)).body.message).toBe(TOO_MANY);
		}
	});

	it("keeps a count for each session: the account's other browser is not held up, and changes the password with the right one", async () => {
		const me = withPassword(makeUser({ username: 'me' }));
		const other = withPassword(makeUser({ username: 'other' }));
		makeSession(me, 'first-browser');
		makeSession(me, 'second-browser');
		makeSession(other, 'their-browser');
		// Through the gate, which finds the account from the session cookie.
		const change = (session: string, currentPassword: string) =>
			gate('PUT', '/api/account/password', {
				headers: { ...from(session), accept: 'application/json' },
				body: { currentPassword, newPassword: NEW }
			});

		// Another account's wrong guesses are counted for their session alone.
		for (let n = 1; n <= 10; n++) expect((await change('their-browser', 'not it')).status).toBe(403);
		expect((await change('their-browser', OLD)).status).toBe(429);

		for (let n = 1; n <= 10; n++) expect((await change('first-browser', 'not it')).status).toBe(403);
		const refused = await change('first-browser', OLD);
		expect(refused.status).toBe(429);
		expect(await refused.json()).toMatchObject({ message: TOO_MANY });
		expect(hashOf(me.id)).toBe(OLD_HASH);

		// The account's other browser is not held up. Changing the password
		// there signs the first one out, which is how the owner of an account
		// takes it back.
		expect((await change('second-browser', OLD)).status).toBe(200);
		expect(await matches(NEW, hashOf(me.id))).toBe(true);
		expect(sessionStillOpen('first-browser')).toBe(false);
		expect(sessionStillOpen('their-browser')).toBe(true);
	});

	it('clears the count on the right password', async () => {
		const { me } = signedIn();

		await wrong(KEY, me, 9);
		expect((await send(KEY, me, OLD)).status).toBe(201);
		await wrong(KEY, me, 9);
		// Nine since the right one, and so not yet ten.
		expect((await send(KEY, me, OLD)).status).toBe(201);
		expect(keysOf(me.id)).toEqual(['my script', 'my script']);
	});

	it('lets the session try again once the 15 minutes are over', async () => {
		const { me } = signedIn();
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			await wrong(EMAIL, me, 10);
			expect((await send(EMAIL, me, OLD)).status).toBe(429);

			vi.setSystemTime(Date.now() + 14 * 60 * 1000);
			const still = await send(EMAIL, me, OLD);
			expect(still.status).toBe(429);
			expect(still.body.message).toBe('Too many wrong passwords. Try again in 1 minute(s).');

			vi.setSystemTime(Date.now() + 60 * 1000 + 1);
			expect((await send(EMAIL, me, OLD)).status).toBe(200);
		} finally {
			vi.useRealTimers();
		}
	});

	it('counts a request once when its transaction checks the password again', async () => {
		const { me } = signedIn();
		await wrong(EMAIL, me, 9);
		const elsewhere = await makePasswordHash('changed elsewhere', 'known');
		// The first read is the one the password is checked against.
		const reads = watchReads('users', (nth) => {
			if (nth === 1) db.update(users).set({ passwordHash: elsewhere }).where(eq(users.id, me.id)).run();
		});

		let res: ApiResult;
		try {
			res = await send(EMAIL, me, OLD);
		} finally {
			reads.restore();
		}

		// Refused by the second check, inside the transaction.
		expect(res.status).toBe(403);
		expect(res.body.message).toBe('Password is incorrect');
		expect(reads.inTransaction).toEqual([false, true]);
		expect(userRow(me.id).email).toBe('me@example.test');

		// The first check was right, and cleared the count; the second is the
		// same guess and added nothing to it. So ten wrong ones are let through
		// again before the eleventh is refused.
		await wrong(EMAIL, me, 10);
		expect((await send(EMAIL, me, 'not it')).status).toBe(429);
	});

	it.each(named)('%s: refuses a password that is not text with 400, before anything is checked or counted', async (_name, route) => {
		const { me } = signedIn();

		// Twelve: past the limit, had any of them been counted.
		for (let n = 1; n <= 3; n++) {
			for (const password of [12345, true, [OLD], { password: OLD }]) {
				const res = await expectRefused(() => send(route, me, password), 400);
				expect(res.body.message).toBe(route.notText);
			}
		}
		expect(bcrypt.inTransaction).toEqual([]);

		expect((await send(route, me, OLD)).status).toBeLessThan(300);
	});

	it.each(named)('%s: refuses a caller whose request carries no session cookie, before anything is read', async (_name, route) => {
		const { me } = signedIn();

		const res = await expectRefused(() => send(route, me, OLD, null), 401);

		expect(res.body.message).toBe('Not authenticated');
		expect(bcrypt.inTransaction).toEqual([]);
	});

	it('writes a WARN line for each wrong password and for the first refusal of each window, naming the route and the user, and never the session', async () => {
		const { me } = signedIn();
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			// Three refusals in the window, and one line for them.
			await wrong(EMAIL, me, 10);
			for (let n = 1; n <= 3; n++) expect((await send(EMAIL, me, 'not it')).status).toBe(429);
			// The next window's first refusal is said again.
			vi.setSystemTime(Date.now() + 15 * 60 * 1000 + 1);
			await wrong(EMAIL, me, 10);
			for (let n = 1; n <= 2; n++) expect((await send(EMAIL, me, 'not it')).status).toBe(429);
		} finally {
			vi.useRealTimers();
			quiet.mockRestore();
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		const lines = sqlite
			.prepare('SELECT level, context, message, meta, user_id AS userId FROM system_logs ORDER BY id')
			.all() as { level: string; context: string; message: string; meta: string; userId: number }[];
		const where = 'PUT /api/account/email';
		const window = [
			...Array.from({ length: 10 }, () => ['WARN', 'AUTH', `Wrong current password for user ${me.id} on ${where}`, me.id]),
			[
				'WARN',
				'AUTH',
				`Current password not checked for user ${me.id} on ${where}: too many wrong ones from this session`,
				me.id
			]
		];
		expect(lines.map((line) => [line.level, line.context, line.message, line.userId])).toEqual([...window, ...window]);
		expect(JSON.parse(lines[0].meta)).toEqual({ where });
		expect(JSON.parse(lines[10].meta)).toEqual({ where, retryAfterSecs: expect.any(Number) });
		// The session signs its holder in, and every administrator reads this log.
		expect(JSON.stringify(lines)).not.toContain('my-laptop');
	});
});

// ─── The admin page ─────────────────────────────────────────────────────────

describe('the admin page', () => {
	/** Every account on the page, with the key count it was given. */
	const keyCounts = async (caller: SessionUser) => {
		const data = (await loadAdminPage({ locals: { user: caller } } as unknown as Parameters<typeof loadAdminPage>[0])) as {
			users: { username: string; apiKeys: number | null }[];
		};
		expect(JSON.stringify(data)).not.toContain('the key');
		return data.users.map((u) => [u.username, u.apiKeys]);
	};

	/** The superadmin, two administrators and two users, every one of them but `none` holding a key. */
	const scene = () => {
		const accounts = {
			owner: makeUser({ username: 'owner', role: 'superadmin' }),
			admin: makeUser({ username: 'admin', role: 'admin' }),
			other: makeUser({ username: 'other-admin', role: 'admin' }),
			holder: makeUser({ username: 'holder' }),
			none: makeUser({ username: 'none' })
		};
		makeApiKey(accounts.owner, 'the key of the owner');
		makeApiKey(accounts.admin, 'the key of the admin');
		makeApiKey(accounts.other, 'the key of the other admin');
		makeApiKey(accounts.holder, 'the key');
		return accounts;
	};

	it('gives an administrator the count of API keys of each account they may reset, and of no other', async () => {
		const { admin } = scene();

		// Their own, the superadmin's and another administrator's: the reset
		// route refuses each, so there is no count to warn with.
		expect(await keyCounts(admin)).toEqual([
			['owner', null],
			['admin', null],
			['other-admin', null],
			['holder', 1],
			['none', 0]
		]);
	});

	it('gives the superadmin the count of every account but their own', async () => {
		const { owner } = scene();

		expect(await keyCounts(owner)).toEqual([
			['owner', null],
			['admin', 1],
			['other-admin', 1],
			['holder', 1],
			['none', 0]
		]);
	});

	it('gives the webhooks each account set that are on, and its report schedules that are on, by the same rule (card 2168)', async () => {
		const accounts = scene();
		const { board } = makeBoard({ owner: accounts.holder });
		makeWebhook(board, { setBy: accounts.holder });
		makeWebhook(board, { setBy: accounts.holder });
		makeWebhook(board, { setBy: accounts.holder, active: false });
		makeWebhook(board, { setBy: accounts.other });
		makeWebhook(board, { setBy: null });
		const schedule = (user: SessionUser, enabled: boolean) =>
			db.insert(reportSchedules).values({ userId: user.id, name: 'Weekly', scope: 'all', enabled }).run();
		schedule(accounts.holder, true);
		schedule(accounts.holder, false);
		schedule(accounts.admin, true);

		const counts = async (caller: SessionUser) => {
			const data = (await loadAdminPage({ locals: { user: caller } } as unknown as Parameters<typeof loadAdminPage>[0])) as {
				users: { username: string; webhooks: number | null; reportSchedules: number | null }[];
			};
			return data.users.map((u) => [u.username, u.webhooks, u.reportSchedules]);
		};

		expect(await counts(accounts.admin)).toEqual([
			['owner', null, null],
			['admin', null, null],
			['other-admin', null, null],
			['holder', 2, 1],
			['none', 0, 0]
		]);
		expect(await counts(accounts.owner)).toEqual([
			['owner', null, null],
			['admin', 0, 1],
			['other-admin', 1, 0],
			['holder', 2, 1],
			['none', 0, 0]
		]);
	});
});

// ─── Setting an instance up ─────────────────────────────────────────────────

describe('the setup page', () => {
	const form = (username = 'first') => ({
		username,
		email: `${username}@Example.test`,
		password: NEW,
		confirmPassword: NEW
	});
	const setUp = (fields: Record<string, string> = form()) => action('/setup', { form: fields });

	it('makes the superadmin and signs them in, or does neither', async () => {
		const run = await eachWriteInTurn({
			build: () => ({}),
			request: () => setUp(),
			afterSuccess: async (_s, res: ActionResult) => {
				expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/' });

				const made = db.select().from(users).all();
				expect(made).toHaveLength(1);
				expect(made[0]).toMatchObject({ username: 'first', email: 'first@example.test', role: 'superadmin' });
				expect(await matches(NEW, made[0].passwordHash)).toBe(true);

				const theirs = sessionsOf(made[0].id);
				expect(theirs).toHaveLength(1);
				expect(res.cookies[SESSION_COOKIE_NAME].value).toBe(theirs[0]);
			}
		});

		// A failure at the second used to leave a superadmin and nobody signed
		// in as them: the page could not be reached again, only the sign-in one.
		expect(shape(run.writes)).toEqual(['insert into users', 'insert into sessions']);
		expect(run.effects).toEqual([]);
		expectHashedOutsideTransaction();
	});

	it('cannot make two superadmins at the same moment', async () => {
		// Both are started before either is awaited. Each used to find no user
		// before it read its form, and both went on to make one.
		const both = await Promise.all([setUp(form('first')), setUp(form('second'))]);

		// Both are sent to the front page, as anyone is once a user exists.
		expect(both.map((res) => [res.type, res.type === 'redirect' && res.location])).toEqual([
			['redirect', '/'],
			['redirect', '/']
		]);

		const made = db.select().from(users).all();
		expect(made).toHaveLength(1);
		expect(made[0].role).toBe('superadmin');

		// One of them is signed in, as the superadmin there is.
		const signedIn = both.filter((res) => SESSION_COOKIE_NAME in res.cookies);
		expect(signedIn).toHaveLength(1);
		expect(sessionsOf(made[0].id)).toEqual([signedIn[0].cookies[SESSION_COOKIE_NAME].value]);
		expect(db.select().from(sessions).all()).toHaveLength(1);
		// Each hashed its own, outside the transaction (card 2191, D10); one was made.
		expect(bcrypt.inTransaction).toEqual([false, false]);
	});

	it('makes nobody when a user was created after it looked for one', async () => {
		// What the other submission would have committed by then.
		const reads = watchReads('users', (nth) => {
			if (nth === 1) makeUser({ username: 'got-there-first', role: 'superadmin' });
		});

		let res: ActionResult;
		try {
			res = await setUp();
		} finally {
			reads.restore();
		}

		expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/' });
		expect(res.cookies).toEqual({});
		// Looked for before the transaction, and again inside it.
		expect(reads.inTransaction).toEqual([false, true]);
		expect(db.select({ username: users.username }).from(users).all()).toEqual([{ username: 'got-there-first' }]);
		expect(db.select().from(sessions).all()).toEqual([]);
	});

	it('answers as it did once a user exists, and for a form that is wrong, with nothing written', async () => {
		const wrong = await expectNothingWritten(() => setUp({ ...form(), confirmPassword: 'something else' }));
		expect(wrong).toMatchObject({ type: 'failure', status: 400, data: { error: 'Passwords do not match' } });

		makeUser({ username: 'already-here', role: 'superadmin' });

		// Sent to the front page whatever the form holds, and not hashed for.
		const late = await expectNothingWritten(() => setUp({ ...form(), username: 'a' }));
		expect(late).toMatchObject({ type: 'redirect', status: 303, location: '/' });
		expect(late.cookies).toEqual({});
		expect(bcrypt.inTransaction).toEqual([]);
	});
});

// ─── Remembered browsers, when a password is set ────────────────────────────

/**
 * Card 2194. A browser that signs in is remembered for the account by a
 * cookie whose MAC is over the account's password hash, so setting the
 * password, by any way there is, forgets every browser of the account at
 * once. The way that also signs the browser in remembers that browser again,
 * with the new hash: the holder's own change, an invite's use, set-up. An
 * administrator's reset signs nobody in, and remembers nobody.
 */
describe('remembered browsers, when a password is set', () => {
	it('are forgotten by the holder’s own change, all but the browser that made it, which is remembered anew', async () => {
		const me = withPassword(makeUser({ username: 'me' }));
		makeSession(me, 'my-laptop');
		const laptop = rememberedFor(me);
		const phone = rememberedFor(me);
		expect(remembers(laptop, me.id) && remembers(phone, me.id)).toBe(true);

		const res = await changeOwn(me, { currentPassword: OLD, newPassword: NEW });

		expect(res.status).toBe(200);
		expect(res.known).toMatchObject({ name: knownBrowserCookie(me.id), options: KNOWN_OPTIONS });
		expect(res.known!.value).not.toBe(laptop.value);
		expect(remembers(res.known!, me.id)).toBe(true);
		expect(remembers(laptop, me.id)).toBe(false);
		expect(remembers(phone, me.id)).toBe(false);
	});

	it('are forgotten by a refused change no more than by none', async () => {
		const me = withPassword(makeUser({ username: 'me' }));
		makeSession(me, 'my-laptop');
		const laptop = rememberedFor(me);

		const res = await changeOwn(me, { currentPassword: 'not it', newPassword: NEW });

		expect(res.status).toBe(403);
		expect(res.known).toBeUndefined();
		expect(remembers(laptop, me.id)).toBe(true);
	});

	it('are forgotten by an invite’s use, which remembers the browser that used it', async () => {
		const invitee = withPassword(makeUser({ username: 'invitee' }));
		const before = rememberedFor(invitee);
		makeInvite(invitee, 'the-invite');

		const res = await action('/invite/the-invite', { form: { password: NEW, confirmPassword: NEW } });

		expect(res).toMatchObject({ type: 'redirect', location: '/' });
		const known = res.cookies[knownBrowserCookie(invitee.id)];
		expect(known.options).toEqual(KNOWN_OPTIONS);
		expect(remembers({ name: knownBrowserCookie(invitee.id), value: known.value }, invitee.id)).toBe(true);
		expect(remembers(before, invitee.id)).toBe(false);
	});

	it('include the browser that set the instance up, for the superadmin', async () => {
		const res = await action('/setup', {
			form: { username: 'first', email: 'first@example.test', password: NEW, confirmPassword: NEW }
		});

		expect(res).toMatchObject({ type: 'redirect', location: '/' });
		const [chief] = db.select().from(users).all();
		const known = res.cookies[knownBrowserCookie(chief.id)];
		expect(known.options).toEqual(KNOWN_OPTIONS);
		expect(remembers({ name: knownBrowserCookie(chief.id), value: known.value }, chief.id)).toBe(true);
	});

	it('are every one forgotten by an administrator’s reset, which remembers none', async () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const target = withPassword(makeUser({ username: 'target' }));
		const theirs = rememberedFor(target);

		const res = await api('PUT', `/api/users/${target.id}/password`, { user: admin, body: { password: NEW } });

		expect(res.status).toBe(200);
		expect(res.headers.get('set-cookie')).toBeNull();
		expect(remembers(theirs, target.id)).toBe(false);
	});
});

// ─── Notification preferences ────────────────────────────────────────────────

describe('/api/account/notifications', () => {
	// `email_request_progress` and `email_mentions` were neither answered nor
	// saved, though the mail reads both (card 2146).
	const DEFAULTS = {
		email_all: true,
		email_assigned: true,
		email_comments: true,
		email_mentions: true,
		email_moved: true,
		email_requests: true,
		email_request_progress: true,
		email_board_shared: true,
		email_planning: true
	};
	const storedFor = (user: SessionUser) =>
		db.select({ prefs: users.notificationPrefs }).from(users).where(eq(users.id, user.id)).get()!.prefs;

	it.each([
		['text that is not JSON', 'not json'],
		['JSON that is not an object', '"off"']
	])('answers the defaults, and saves over them, for a user whose stored preferences are %s', async (_what, stored) => {
		const user = makeUser({ username: 'ann' });
		db.update(users).set({ notificationPrefs: stored }).where(eq(users.id, user.id)).run();

		// Text that is not JSON used to throw, on the read and on the save, so
		// the user could neither see their preferences nor repair them. A JSON
		// string was spread into the answer a character at a time.
		const read = await api('GET', '/api/account/notifications', { user });
		expect(read.status).toBe(200);
		expect(read.body).toEqual(DEFAULTS);
		expect(storedFor(user)).toBe(stored);

		// A preference that is not true or false is refused (card 2117), and
		// tests/request-body.test.ts holds it; one it does not know is left alone.
		const saved = await api('PUT', '/api/account/notifications', {
			user,
			body: { email_comments: false, not_a_preference: false }
		});
		expect(saved.status).toBe(200);
		expect(saved.body).toEqual({ ...DEFAULTS, email_comments: false });
		// What is stored now can be read: the one preference that was set.
		expect(JSON.parse(storedFor(user)!)).toEqual({ email_comments: false });
		expect((await api('GET', '/api/account/notifications', { user })).body).toEqual({ ...DEFAULTS, email_comments: false });
	});

	it('answers and saves as it did for preferences that can be read', async () => {
		const user = makeUser({ username: 'ann' });
		db.update(users).set({ notificationPrefs: '{"email_all":false}' }).where(eq(users.id, user.id)).run();

		expect((await api('GET', '/api/account/notifications', { user })).body).toEqual({ ...DEFAULTS, email_all: false });
		const saved = await api('PUT', '/api/account/notifications', { user, body: { email_planning: false } });
		expect(saved.body).toEqual({ ...DEFAULTS, email_all: false, email_planning: false });
		expect(JSON.parse(storedFor(user)!)).toEqual({ email_all: false, email_planning: false });
	});

	/**
	 * The key each mail in `notifications.ts` reads, as written there: the last
	 * argument of every call to `shouldNotifyUser` and `filterRecipientsByPref`,
	 * but the one inside the second that passes its own on. One that is not a
	 * string literal is kept as its source text, so that it fails the test
	 * below rather than being passed over.
	 */
	function keysTheMailReads(): string[] {
		const file = join(process.cwd(), 'src', 'lib', 'server', 'notifications.ts');
		const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
		const keys: string[] = [];
		const visit = (node: ts.Node) => {
			if (ts.isFunctionDeclaration(node) && node.name?.text === 'filterRecipientsByPref') return;
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				['shouldNotifyUser', 'filterRecipientsByPref'].includes(node.expression.text)
			) {
				const last = node.arguments[node.arguments.length - 1];
				keys.push(last && ts.isStringLiteral(last) ? last.text : `not a key: ${last?.getText(source)}`);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		return keys;
	}

	it('saves and answers every preference a mail reads, each of the one list', async () => {
		const read = keysTheMailReads();
		// Every mail that can be switched off: assigned, moved, unblocked,
		// shared, requests twice, comments, request progress, planning, mentions.
		expect(read.length).toBeGreaterThanOrEqual(10);
		const listed: string[] = NOTIFICATION_PREFS.map((kind) => kind.key);
		for (const key of new Set(read)) expect(listed, `notifications.ts reads ${key}`).toContain(key);
		// And the list is what the route answers: the master key and every kind.
		expect(Object.keys(DEFAULTS).sort()).toEqual([MASTER_PREF, ...listed].sort());

		// Each, switched off, is stored and answered off. Request progress and
		// mentions were dropped, so they read as on whatever was sent.
		const user = makeUser({ username: 'ann' });
		const allOff = Object.fromEntries(listed.map((key) => [key, false]));
		const saved = await api('PUT', '/api/account/notifications', { user, body: allOff });
		expect(saved.status).toBe(200);
		expect(saved.body).toEqual({ ...DEFAULTS, ...allOff });
		expect(JSON.parse(storedFor(user)!)).toEqual(allOff);
		expect((await api('GET', '/api/account/notifications', { user })).body).toEqual({ ...DEFAULTS, ...allOff });
	});

	/** Board A of `owner`, a card on it, and the request `rita` raised with her account, accepted onto it. */
	const raisedByAnAccount = () => {
		const owner = makeUser({ username: 'owner' });
		const rita = makeUser({ username: 'rita' });
		const A = makeBoard({ owner, name: 'A' });
		const card = makeCard(A.cols['To Do'], { title: 'Please build this' });
		db.insert(taskRequests)
			.values({
				targetType: 'user',
				targetId: owner.id,
				requesterName: 'rita',
				requesterEmail: rita.email,
				requesterUserId: rita.id,
				title: 'Please build this',
				status: 'accepted',
				accessToken: 'a'.repeat(64),
				resolvedBy: owner.id,
				resolvedCardId: card.id
			})
			.run();
		makeSmtp();
		return { owner, rita, A, card };
	};

	it('sends the requester no progress mail while Request Progress is off, and the next once it is on', async () => {
		const { owner, rita, A, card } = raisedByAnAccount();
		const move = (column: string) =>
			api('PUT', `/api/v1/cards/${card.id}/move`, { user: owner, body: { columnId: A.cols[column].id } });
		const switchTo = async (on: boolean) => {
			const res = await api('PUT', '/api/account/notifications', { user: rita, body: { email_request_progress: on } });
			expect(res.status).toBe(200);
		};

		const sent = effects();
		try {
			await switchTo(false);
			expect((await move('In Progress')).status).toBe(200);
			await sent.settle();
			// It was mailed: the switch was not saved.
			expect(sent.emails).toEqual([]);

			await switchTo(true);
			expect((await move('On Hold')).status).toBe(200);
			await sent.settle();
			expect(sent.emails.map((e) => `${e.to}: ${e.subject}`)).toEqual([
				'rita@example.test: Your request moved: Please build this → On Hold'
			]);
			expect(sent.duringTransaction).toEqual([]);
		} finally {
			sent.restore();
		}
	});

	it('sends no mention mail to someone who has Mentions off', async () => {
		const owner = makeUser({ username: 'owner' });
		const ann = makeUser({ username: 'ann' });
		const A = makeBoard({ owner, name: 'A' });
		addBoardMember(A.board, ann, 'editor');
		const card = makeCard(A.cols['To Do'], { title: 'Launch' });
		makeSmtp();
		const comment = () => api('POST', `/api/cards/${card.id}/comments`, { user: owner, body: { content: '@ann hello' } });
		const mentions = (sent: Effects) => sent.emails.filter((e) => e.subject === 'owner mentioned you: Launch');

		const sent = effects();
		try {
			expect((await api('PUT', '/api/account/notifications', { user: ann, body: { email_mentions: false } })).status).toBe(200);
			expect((await comment()).status).toBe(201);
			await sent.settle();
			// It was mailed: the switch was not saved.
			expect(mentions(sent)).toEqual([]);

			expect((await api('PUT', '/api/account/notifications', { user: ann, body: { email_mentions: true } })).status).toBe(200);
			expect((await comment()).status).toBe(201);
			await sent.settle();
			expect(mentions(sent).map((e) => e.to)).toEqual(['ann@example.test']);
		} finally {
			sent.restore();
		}
	});
});
