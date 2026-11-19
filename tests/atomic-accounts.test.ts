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
 * Wrong current passwords, and wrong codes, are counted on the session's own
 * row as each arrives, for the session's whole life, and the third ends the
 * session (`checkCurrentProof`, cards 2701 and 2771). Every route here that
 * asks for the current password asks for a code beside it, through the
 * step-up, the Account page's three among them since card 2771. The count, and
 * the code's step spent by a right password and code, are written apart from
 * the request's transaction, on purpose, and are compared on their own
 * (`STEP_UP_APART`, `STEP_UP_WRITES`). A refusal after the check leaves the
 * code spent (card 2771, S4).
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
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

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
import { apiKeys, enrolmentLinks, inviteTokens, reportSchedules, sessions, taskRequests, users } from '$lib/server/db/schema';
import { MASTER_PREF, NOTIFICATION_PREFS } from '$lib/notification-prefs';
import { shouldNotifyUser } from '$lib/server/notifications';
import { PASSWORD_CHANGED_MEANWHILE, openSessionUser, SESSION_COOKIE_NAME, STEP_UP_SIGNED_OUT, type SessionUser } from '$lib/server/auth';
import { LONGEST_PASSWORD, PASSWORD_TOO_LONG, PASSWORDS_BUSY, checkPassword, makePasswordHash } from '$lib/server/passwords';
import { ENROLMENT_LINK_LIFETIME_MS, holdsFactor, usableEnrolmentLink } from '$lib/server/mfa-store';
import { sha256Hex } from '$lib/server/mfa-crypto';
import { subscribeToLogs } from '$lib/server/logger';
import { STEP_UP_MISSING, STEP_UP_WRONG } from '$lib/step-up-words';
import { endUnusedInvites, issueInvite } from '$lib/server/invites';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { knownBrowserCookie, rememberBrowser, rememberedNonce } from '$lib/server/known-browsers';
import { CHALLENGE_COOKIE, tokenHashOf } from '$lib/server/sign-in-challenges';
import { ENDING_IN_MAIL, dispatchWebhook } from '$lib/server/webhooks';
import { PUT as changeOwnPassword } from '../src/routes/api/account/password/+server';
import { load as loadAdminPage } from '../src/routes/admin/+page.server';
import { load as loadInvitePage } from '../src/routes/invite/[token]/+page.server';
import { action, type ActionResult } from './helpers/actions';
import { api, type ApiResult } from './helpers/api';
import { eachWriteInTurn } from './helpers/each-write';
import { effects, type Effects, type RecordedEffect } from './helpers/effects';
import {
	FIXTURE_PASSWORD,
	FIXTURE_PASSWORD_HASH,
	STEP_UP_APART,
	STEP_UP_WRITES,
	addBoardMember,
	codeFor,
	makeApiKey,
	makeBoard,
	makeCard,
	makeSmtp,
	makeUser,
	makeWebhook,
	resetDb,
	sessionHashOf,
	sessionCredential,
	stepUpCode,
	stepUpFactor
} from './helpers/fixtures';
import { FROM_THE_PAGE, gate } from './helpers/gate';
import { sendAround } from './helpers/held-body';
import { watchReads } from './helpers/reads';
import { diffSnapshots, expectUnchanged, snapshotDb } from './helpers/snapshot';
import { parseStamp, stamp } from '$lib/timestamps';
import { inviteHashOf } from './helpers/fixtures';

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
	rememberBrowser({ set: () => {} } as unknown as Cookies, 0, '', null);
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
	rememberBrowser({ set: (name: string, value: string) => (made = { name, value }) } as unknown as Cookies, user.id, hashOf(user.id), null);
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
		.select({ hash: sessions.tokenHash })
		.from(sessions)
		.where(eq(sessions.userId, id))
		.all()
		.map((s) => s.hash);
/** The account's pending sign-ins (card 2769), each as its token's hash, its purpose and what let it set up a factor. */
const challengesOf = (id: number) =>
	(
		sqlite.prepare('SELECT token_hash, purpose, enrol_grant FROM sign_in_challenges WHERE user_id = ? ORDER BY rowid').all(id) as {
			token_hash: string;
			purpose: string;
			enrol_grant: string | null;
		}[]
	).map((row) => [row.token_hash, row.purpose, row.enrol_grant]);

/**
 * The session cookie of a request sent from the session `id`. The routes that
 * ask for a current password count wrong ones against it. `api()` gives the
 * handler its caller directly, so it is not looked up.
 */
const from = (id: string) => ({ cookie: `${SESSION_COOKIE_NAME}=${id}` });

/**
 * A session that is good for another hour, made after a second factor as createSession makes every one (card 2769),
 * and kept as its code's hash (card 2775). An hour is inside every role's idle limit: an expiry further out than
 * the role allows is refused.
 */
function makeSession(user: SessionUser, id: string): void {
	db.insert(sessions)
		.values({ tokenHash: sessionHashOf(id), userId: user.id, expiresAt: stamp(new Date(Date.now() + 60 * 60 * 1000)), twoStep: 1 })
		.run();
}

/**
 * The code `user` confirms a step-up with now (card 2771): the one their
 * factor shows, given where the scene is built (`stepUpFactor`), or none for
 * nobody and for an account that holds no factor, which no step-up of theirs
 * reaches (E5). Made with nothing written, so that it can be made inside
 * `eachWriteInTurn`'s request and after a snapshot. Its step is not cleared:
 * a second success in the same step clears it first (`stepUpCode`).
 */
function codeOf(user: SessionUser | null): { currentCode?: string } {
	if (user === null || !holdsFactor(user.id)) return {};
	return { currentCode: codeFor(stepUpFactor(user).secret) };
}

/** A body sent with `user`'s code beside the current password it carries (card 2771); one with no current password, as it was. */
const withCode = (user: SessionUser | null, body: unknown): unknown =>
	body !== null && typeof body === 'object' && 'currentPassword' in body && !('currentCode' in body) ? { ...body, ...codeOf(user) } : body;

/**
 * `before`, with the factors as they are now, once they are checked to differ
 * by the code's step spent and nothing else: a request refused after the
 * password and code were checked leaves the code spent (card 2771, S4). The
 * factor's step must have been unspent in `before`.
 */
function withCodeSpent(before: ReturnType<typeof snapshotDb>): ReturnType<typeof snapshotDb> {
	const factors = snapshotDb().mfa_factors;
	expect(diffSnapshots({ mfa_factors: before.mfa_factors }, { mfa_factors: factors })).toEqual([
		expect.stringMatching(/^mfa_factors: row \d+ changed \(last_step: null became \d+; last_used_at: null became /)
	]);
	return { ...before, mfa_factors: factors };
}

/** Give a user a password that can be checked: `OLD`. */
function withPassword(user: SessionUser): SessionUser {
	db.update(users).set({ passwordHash: OLD_HASH }).where(eq(users.id, user.id)).run();
	return user;
}

const HOUR = 60 * 60 * 1000;

/**
 * An invite, written as it is stored, as the hash of `token` (card 2849): good
 * for another hour unless told otherwise. Written directly, as production may
 * hold more than one waiting invite for an account from before an account had
 * one.
 */
function makeInvite(user: SessionUser, token: string, opts: { expiresIn?: number; used?: boolean } = {}): void {
	db.insert(inviteTokens)
		.values({
			tokenHash: inviteHashOf(token),
			userId: user.id,
			expiresAt: stamp(new Date(Date.now() + (opts.expiresIn ?? HOUR))),
			used: opts.used ?? false
		})
		.run();
}

/** A user's invites, as `[the token's hash, used]`, oldest first. */
const invitesOf = (id: number) =>
	db
		.select()
		.from(inviteTokens)
		.where(eq(inviteTokens.userId, id))
		.all()
		.map((i) => [i.tokenHash, i.used] as const);

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

/** A session's count of wrong current passwords (card 2701), or undefined once the session has gone. */
const countOf = (session: string) =>
	db.select({ count: sessions.wrongPasswordCount }).from(sessions).where(eq(sessions.tokenHash, sessionHashOf(session))).get()?.count;

/**
 * Make `request`, a wrong current password from `session`, and check that it
 * was answered `status` with nothing written and nothing sent but the
 * session's count, which reads one more: counted as it arrives, on purpose,
 * apart from the request's transaction (card 2701). Returns what it returned.
 */
async function expectRefusedAndCounted(request: () => Promise<ApiResult>, status: number, session: string): Promise<ApiResult> {
	const count = countOf(session)!;
	const before = snapshotDb();
	const sent = effects();
	try {
		const res = await request();
		await sent.settle();
		expect(res.status).toBe(status);
		expect(countOf(session)).toBe(count + 1);
		const now = snapshotDb();
		expectUnchanged({ ...before, sessions: now.sessions });
		expect(diffSnapshots({ sessions: before.sessions }, { sessions: now.sessions })).toEqual([
			`sessions: row ${rowOf(session)} changed (wrong_password_count: ${count} became ${count + 1})`
		]);
		expect(sent.all).toEqual([]);
		return res;
	} finally {
		sent.restore();
	}
}

/** The rowid a session's row has, as a snapshot names it. */
const rowOf = (session: string) => (sqlite.prepare('SELECT rowid AS n FROM sessions WHERE id = ?').get(sessionHashOf(session)) as { n: number }).n;

// ─── Changing your own password ─────────────────────────────────────────────

type OwnResult = ApiResult & {
	/** The session cookie it set, and whether a transaction was open when it did. */
	cookie?: { value: string; inTransaction: boolean };
	/** The cookie that remembers the browser (card 2194), with its options. */
	known?: { name: string; value: string; options: Record<string, unknown> };
	/** Whether the session cookie was cleared: the session was signed out (card 2701). */
	cleared?: true;
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
			body: JSON.stringify(withCode(user, body))
		}),
		// The session as the gate records it, by its hash (card 2775), which the route reads.
		locals: user ? { user, credential: sessionCredential(session) } : { user },
		cookies: {
			get: (cookie: string) => (cookie === SESSION_COOKIE_NAME ? session : undefined),
			set: (cookie: string, value: string, options: Record<string, unknown>) => {
				if (cookie === SESSION_COOKIE_NAME) result.cookie = { value, inTransaction: sqlite.inTransaction };
				if (user && cookie === knownBrowserCookie(user.id)) result.known = { name: cookie, value, options };
			},
			// A session ended by its third wrong password is told so with its cookie cleared (card 2701).
			delete: (cookie: string) => {
				if (cookie === SESSION_COOKIE_NAME) result.cleared = true;
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
	 * Signed in on two devices, with two API keys, an invite not yet used and
	 * a report schedule that is on, and somebody else signed in on one, with a
	 * key, an invite and a schedule of their own. A failed write leaves the
	 * schedule on: `eachWriteInTurn` checks every row (card 2894).
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
		for (const owner of [me, other]) db.insert(reportSchedules).values({ userId: owner.id, name: 'Weekly', scope: 'all' }).run();
		// The factor the code is made from (card 2771).
		stepUpFactor(me);
		// The remembered-browser key a running server has once any browser was remembered: made here, so that the
		// request's own writes are the ones failed in turn. Its first making is after the commit and never fails the
		// request (rememberBrowser); a cache kept across tests hid it until resetDb forgot it (card 2943's fix pass, C11).
		rememberBrowser({ set: () => {} } as unknown as Cookies, other.id, 'any hash', null);
		return { me, other };
	};

	/** Whether each of the account's report schedules is on, in the order they were made. */
	const schedulesOnOf = (userId: number) =>
		db.select({ enabled: reportSchedules.enabled }).from(reportSchedules).where(eq(reportSchedules.userId, userId)).orderBy(reportSchedules.id).all().map((row) => row.enabled);

	it('changes the password, ends every session and invite, pauses the schedules and starts a new session, keeping the keys, or does none of it', async () => {
		const run = await eachWriteInTurn({
			build: signedInTwice,
			request: ({ me }) => changeOwn(me, { currentPassword: OLD, newPassword: NEW }),
			apart: [...STEP_UP_APART],
			afterSuccess: async ({ me, other }, res: OwnResult) => {
				expect(res.status).toBe(200);
				// Card 2935 (P9): webhooksSwitchedOff stays the ones it set; those of others it could read are counted apart.
				expect(res.body).toEqual({ success: true, apiKeysEnded: 0, webhooksSwitchedOff: 0, readableWebhooksHeld: 0, reportSchedulesPaused: 1, settingsHeld: null });
				// Card 2894 (D1): the holder's schedule paused, with the keys kept; nobody else's.
				expect(schedulesOnOf(me.id)).toEqual([false]);
				expect(schedulesOnOf(other.id)).toEqual([true]);

				expect(await matches(NEW, hashOf(me.id))).toBe(true);
				expect(await matches(OLD, hashOf(me.id))).toBe(false);

				// Both devices are signed out, and this one is signed in again by the
				// cookie, which names the one session there now is.
				const mine = sessionsOf(me.id);
				expect(mine).toHaveLength(1);
				expect(mine).not.toContainEqual(sessionHashOf('my-laptop'));
				expect(mine).not.toContainEqual(sessionHashOf('my-phone'));
				expect(res.cookie).toEqual({ value: expect.any(String), inTransaction: false });
				expect(sessionHashOf(res.cookie!.value)).toEqual(mine[0]);
				expect(sessionsOf(other.id)).toEqual([sessionHashOf('theirs')]);

				// The invite would set the password again; the keys were not asked about.
				expect(invitesOf(me.id)).toEqual([]);
				expect(keysOf(me.id)).toEqual(['my script', 'my other script']);
				expect(invitesOf(other.id)).toEqual([[inviteHashOf('their-invite'), false]]);
				expect(keysOf(other.id)).toEqual(['their script']);
			}
		});

		// A failure at the second of these used to leave the new password with
		// both old sessions still good; at the fourth, with nobody signed in.
		// The first three count the password as it arrives, spend the code and
		// clear the count for the right one, apart from the transaction (cards
		// 2701 and 2771).
		expect(shape(run.writes)).toEqual([
			...STEP_UP_WRITES,
			'update users set',
			'delete from sessions',
			'delete from invite_tokens',
			// The pending sign-ins and enrolment links (card 2768), whether or not a row matches.
			'delete from sign_in_challenges',
			'delete from enrolment_links',
			// The report schedules that are on (card 2894), always.
			'update report_schedules set',
			'insert into sessions'
		]);
		expect(run.effects).toEqual([]);
		expectHashedOutsideTransaction();
	});

	it('ends every API key of the account too when asked, or does none of it', async () => {
		const run = await eachWriteInTurn({
			build: signedInTwice,
			request: ({ me }) => changeOwn(me, { currentPassword: OLD, newPassword: NEW, endApiKeys: true }),
			apart: [...STEP_UP_APART],
			afterSuccess: async ({ me, other }, res: OwnResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true, apiKeysEnded: 2, webhooksSwitchedOff: 0, readableWebhooksHeld: 0, reportSchedulesPaused: 1, settingsHeld: null });
				expect(await matches(NEW, hashOf(me.id))).toBe(true);
				expect(sessionsOf(me.id)).toEqual([sessionHashOf(res.cookie!.value)]);
				expect(invitesOf(me.id)).toEqual([]);
				expect(keysOf(me.id)).toEqual([]);

				// Nobody else's.
				expect(sessionsOf(other.id)).toEqual([sessionHashOf('theirs')]);
				expect(invitesOf(other.id)).toEqual([[inviteHashOf('their-invite'), false]]);
				expect(keysOf(other.id)).toEqual(['their script']);
			}
		});

		expect(shape(run.writes)).toEqual([
			...STEP_UP_WRITES,
			'update users set',
			// The once-only seed of the reads made before they were recorded, before the keys go (card 2947's code
			// review, FP2): written here because no sweep has run on this database.
			'insert or ignore',
			'insert into settings',
			'delete from sessions',
			'delete from invite_tokens',
			// The pending sign-ins and enrolment links (card 2768), whether or not a row matches.
			'delete from sign_in_challenges',
			'delete from enrolment_links',
			'delete from api_keys',
			// The webhooks the account set (card 2168): written whether or not one
			// matches, and only when the keys end.
			'update webhooks set',
			// The links of the requests it made (card 2922), with its keys.
			'delete from request_links',
			'update report_schedules set',
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
		makeSession(chief, 'my-laptop');
		stepUpFactor(chief);

		const kept = await changeOwn(chief, { currentPassword: OLD, newPassword: NEW, endApiKeys: false });
		expect(kept.status).toBe(200);
		expect(kept.body).toEqual({ success: true, apiKeysEnded: 0, webhooksSwitchedOff: 0, readableWebhooksHeld: 0, reportSchedulesPaused: 0, settingsHeld: null });
		expect((await meWithKey(key)).status).toBe(200);

		// From the session the change started: it ended the one it was asked from.
		// The code made again: the first spent its step (card 2771).
		stepUpCode(chief);
		const ended = await changeOwn(chief, { currentPassword: NEW, newPassword: 'a third password', endApiKeys: true }, kept.cookie!.value);
		expect(ended.body).toEqual({ success: true, apiKeysEnded: 1, webhooksSwitchedOff: 0, readableWebhooksHeld: 0, reportSchedulesPaused: 0, settingsHeld: null });
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
		// Asked through the step-up since card 2771, in its words.
		expect(await refused(me, { newPassword: NEW }, 400)).toBe(STEP_UP_MISSING);
		expect(await refused(me, { currentPassword: OLD, newPassword: 'short' }, 400)).toBe(
			'New password must be at least 8 characters'
		);
		// A short new password is refused before the current one is checked.
		expect(await refused(me, { currentPassword: 'not it', newPassword: 'short' }, 400)).toBe(
			'New password must be at least 8 characters'
		);
		// Nothing written but the session's count, which a wrong one adds to (card 2701).
		const wrong = await expectRefusedAndCounted(() => changeOwn(me, { currentPassword: 'not it', newPassword: NEW }), 403, 'my-laptop');
		expect(wrong.body).toEqual({ message: STEP_UP_WRONG, stepUp: 'wrong' });
		expect((wrong as OwnResult).cookie).toBeUndefined();
		expect(sessionsOf(me.id)).toEqual([sessionHashOf('my-laptop'), sessionHashOf('my-phone')]);
	});

	it('refuses a new password over 1,024 characters before the current one is checked; one of 1,024 then confirms the next change (card 2888)', async () => {
		const { me } = signedInTwice();
		const tooLong = 'x'.repeat(LONGEST_PASSWORD + 1);
		const longest = 'y'.repeat(LONGEST_PASSWORD);

		const refused = await expectNothingWritten(() => changeOwn(me, { currentPassword: OLD, newPassword: tooLong }));
		expect(refused.status).toBe(400);
		expect(refused.body.message).toBe(PASSWORD_TOO_LONG);
		expect(refused.cookie).toBeUndefined();
		// Refused in the step-up's guard: nothing hashed, compared or counted.
		expect(bcrypt.inTransaction).toEqual([]);
		expect(countOf('my-laptop')).toBe(0);

		const set = await changeOwn(me, { currentPassword: OLD, newPassword: longest });
		expect(set.status).toBe(200);
		expect(await matches(longest, hashOf(me.id))).toBe(true);

		// The step-up reads all of it: the password just set confirms the next change, from the session it made.
		stepUpCode(me);
		const back = await changeOwn(me, { currentPassword: longest, newPassword: NEW }, set.cookie!.value);
		expect(back.status).toBe(200);
		expect(await matches(NEW, hashOf(me.id))).toBe(true);
	});

	it('refuses 409 when the password was changed elsewhere after it was checked, and leaves that change alone', async () => {
		const { me } = signedInTwice();
		const elsewhere = await makePasswordHash('changed elsewhere', 'known');
		const before = snapshotDb();
		// The second read is the one the current password is checked against: the first is the session's account, read as writeAs checks the session (card 2775).
		const reads = watchReads('users', (nth) => {
			if (nth === 2) db.update(users).set({ passwordHash: elsewhere }).where(eq(users.id, me.id)).run();
		});

		try {
			const res = await changeOwn(me, { currentPassword: OLD, newPassword: NEW });

			// The proof no longer holds, and the password is not compared again (card 2701's code review, S2).
			expect(res.status).toBe(409);
			expect(res.body).toEqual({ message: PASSWORD_CHANGED_MEANWHILE, stepUp: 'changed' });
			expect(res.cookie).toBeUndefined();
		} finally {
			reads.restore();
		}

		// Looked at before the transaction, and read again inside it.
		expect(reads.inTransaction).toEqual([true, false, true]);
		expect(hashOf(me.id)).toBe(elsewhere);
		expect(sessionsOf(me.id)).toEqual([sessionHashOf('my-laptop'), sessionHashOf('my-phone')]);
		// And the code, spent by the check (card 2771, S4).
		expectUnchanged({ ...withCodeSpent(before), users: snapshotDb().users });
	});

	it('refuses 409 when the stored hash changed, even to a hash of the same password, and leaves the change alone', async () => {
		const { me } = signedInTwice();
		const rehashed = await makePasswordHash(OLD, 'known');
		const reads = watchReads('users', (nth) => {
			if (nth === 2) db.update(users).set({ passwordHash: rehashed }).where(eq(users.id, me.id)).run();
		});

		try {
			// A second compare would have matched; none is made (card 2701's code review, S2).
			expect((await changeOwn(me, { currentPassword: OLD, newPassword: NEW })).status).toBe(409);
		} finally {
			reads.restore();
		}

		expect(hashOf(me.id)).toBe(rehashed);
	});

	// The check is made outside the transaction (card 2191, D8): a check is
	// awaited, which a transaction cannot do. The transaction writes only while
	// the stored hash is the one the password was checked against; changed, it
	// is answered 409 with nothing written. It used to compare the password
	// again against the new hash, a guess the session's count never saw (card
	// 2701's code review, S2).
	it('answers 409 with nothing written when the stored hash changes while it is being saved, comparing once and counting one attempt', async () => {
		const { me } = signedInTwice();
		const first = await makePasswordHash(OLD, 'known');
		const before = snapshotDb();
		// After the check: the hash of the same password, as another request
		// setting it again would leave it.
		bcrypt.inTransaction.length = 0;
		bcrypt.afterCompare = (nth) => {
			if (nth === 1) db.update(users).set({ passwordHash: first }).where(eq(users.id, me.id)).run();
		};

		const res = await changeOwn(me, { currentPassword: OLD, newPassword: NEW });
		bcrypt.afterCompare = undefined;

		expect(res.status).toBe(409);
		expect(res.body).toEqual({ message: PASSWORD_CHANGED_MEANWHILE, stepUp: 'changed' });
		expect(res.cookie).toBeUndefined();
		// The check and the new password's hash, neither inside a transaction,
		// and no second compare.
		expect(bcrypt.inTransaction).toEqual([false, false]);
		expect(bcrypt.compared).toBe(1);
		// The change stands, and nothing else changed but the code, spent by
		// the check (card 2771, S4).
		expect(hashOf(me.id)).toBe(first);
		expect(sessionsOf(me.id)).toEqual([sessionHashOf('my-laptop'), sessionHashOf('my-phone')]);
		expectUnchanged({ ...withCodeSpent(before), users: snapshotDb().users });

		// The session's count is what one right password leaves, none: two
		// wrong ones are answered 403, and the third ends the session (card
		// 2701). Each with a code of a step not yet spent (card 2771).
		expect(countOf('my-laptop')).toBe(0);
		stepUpCode(me);
		for (let n = 1; n <= 2; n++) {
			expect((await changeOwn(me, { currentPassword: 'not it', newPassword: NEW })).status).toBe(403);
		}
		const third = await changeOwn(me, { currentPassword: 'not it', newPassword: NEW });
		expect({ status: third.status, body: third.body, cleared: third.cleared }).toEqual({
			status: 403,
			body: { message: STEP_UP_SIGNED_OUT, signedOut: true, stepUp: 'signed-out' },
			cleared: true
		});
		expect(sessionsOf(me.id)).toEqual([sessionHashOf('my-phone')]);
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
		makeSession(chief, 'the-chief');
		// The factors the callers' codes are made from (card 2771).
		stepUpFactor(admin);
		stepUpFactor(chief);
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

	/**
	 * The new password set by `by`, with their own current password (card
	 * 2701), sent from `session`, the administrator's unless told otherwise.
	 */
	const reset = (by: SessionUser | null, id: number, password: unknown = NEW, session = 'the-admin') =>
		api('PUT', `/api/users/${id}/password`, { user: by, body: { password, currentPassword: FIXTURE_PASSWORD, ...codeOf(by) }, headers: from(session) });

	it('by an administrator, sets the password and ends that user\'s sessions, invites and API keys, or does none of it', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ admin, target }) => reset(admin, target.id),
			apart: [...STEP_UP_APART],
			afterSuccess: async ({ admin, target, bystander }, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({
					success: true,
					sessionsEnded: 2,
					apiKeysEnded: 1,
					webhooksSwitchedOff: 0,
					readableWebhooksHeld: 0,
					reportSchedulesPaused: 0,
					settingsHeld: null
				});
				expect(await matches(NEW, hashOf(target.id))).toBe(true);
				expect(sessionsOf(target.id)).toEqual([]);
				expect(invitesOf(target.id)).toEqual([]);
				expect(keysOf(target.id)).toEqual([]);

				// The administrator's and the bystander's are theirs, and stay.
				expect(sessionsOf(admin.id)).toEqual([sessionHashOf('the-admin')]);
				expect(keysOf(admin.id)).toEqual(['admin key']);
				expect(keysOf(bystander.id)).toEqual(['bystander key']);
			}
		});

		// A failure at the second used to leave the password reset and whoever
		// held the old one still signed in, which a reset is meant to end. The
		// invite and the keys used to outlive the reset whatever happened. The
		// first three count the administrator's own password as it arrives,
		// spend their code and clear the count for the right one, apart from the
		// transaction (cards 2701 and 2771).
		expect(shape(run.writes)).toEqual([
			...STEP_UP_WRITES,
			'update users set',
			// The once-only seed of the reads made before they were recorded, before the keys go (card 2947's code
			// review, FP2): written here because no sweep has run on this database.
			'insert or ignore',
			'insert into settings',
			'delete from sessions',
			'delete from invite_tokens',
			// The pending sign-ins and enrolment links (card 2768), whether or not a row matches.
			'delete from sign_in_challenges',
			'delete from enrolment_links',
			'delete from api_keys',
			// What the account set going (card 2168), written whether or not a row matches.
			'update webhooks set',
			// The links of the requests it made (card 2922), written whether or not a row matches.
			'delete from request_links',
			'update report_schedules set'
		]);
		expect(run.effects).toEqual([]);
		expectHashedOutsideTransaction();
	});

	it('by the superadmin, of an administrator, ends that administrator\'s sessions and keys as well', async () => {
		const s = scene();

		const res = await reset(s.chief, s.admin.id, NEW, 'the-chief');

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true, sessionsEnded: 1, apiKeysEnded: 1, webhooksSwitchedOff: 0, readableWebhooksHeld: 0, reportSchedulesPaused: 0, settingsHeld: null });
		expect(sessionsOf(s.admin.id)).toEqual([]);
		expect(keysOf(s.admin.id)).toEqual([]);
		// The target's are not the administrator's.
		expect(sessionsOf(s.target.id)).toEqual([sessionHashOf('target-laptop'), sessionHashOf('target-phone')]);
		expect(keysOf(s.target.id)).toEqual(['target key']);
		expect(invitesOf(s.target.id)).toEqual([[inviteHashOf('target-invite'), false]]);
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
		// None of those was hashed for, and the administrator's own password,
		// sent with each, was checked for none (card 2701): each is refused
		// before it, and nothing is counted.
		expect(bcrypt.inTransaction).toEqual([]);
		expect(countOf('the-admin')).toBe(0);
	});

	it('refuses a password over 1,024 characters before the step-up, and sets one of 1,024 (card 2888)', async () => {
		const s = scene();
		const longest = 'y'.repeat(LONGEST_PASSWORD);

		const refused = await expectRefused(() => reset(s.admin, s.target.id, 'x'.repeat(LONGEST_PASSWORD + 1)), 400);
		expect(refused.body.message).toBe(PASSWORD_TOO_LONG);
		expect(bcrypt.inTransaction).toEqual([]);
		expect(countOf('the-admin')).toBe(0);

		expect((await reset(s.admin, s.target.id, longest)).status).toBe(200);
		expect(await matches(longest, hashOf(s.target.id))).toBe(true);
	});

	it('refuses when the user became a superadmin after they were looked at', async () => {
		const s = scene();
		// The fifth read is the administrator's own hash, read for their password
		// once the user has been looked at twice (card 2701), and the session's
		// account read as writeAs checks the session (card 2775): the change lands
		// after both looks, and before the transaction that sets the password.
		const reads = watchReads('users', (nth) => {
			if (nth === 5) db.update(users).set({ role: 'superadmin' }).where(eq(users.id, s.target.id)).run();
		});

		try {
			const res = await reset(s.admin, s.target.id);

			expect(res.status).toBe(403);
			expect(res.body.message).toBe('Only superadmin can reset superadmin password');
		} finally {
			reads.restore();
		}

		// Looked at before the password (outside, then read only in a transaction
		// of its own), the hash read, and read again in the transaction that would
		// set it: the stored hash held, then the user.
		expect(reads.inTransaction).toEqual([true, false, true, true, false, true, true, true]);
		expect(hashOf(s.target.id)).toBe(OLD_HASH);
		expect(sessionsOf(s.target.id)).toEqual([sessionHashOf('target-laptop'), sessionHashOf('target-phone')]);
	});
});

// ─── Disabling an account (card 2671) ───────────────────────────────────────

describe('POST /api/users/:id/disable', () => {
	/**
	 * The target is signed in on two devices, has an invite not yet used, an API
	 * key, a webhook they set that is on, a report schedule that is on and a
	 * request they made with a link. The administrator has a session and a key,
	 * which stay theirs.
	 */
	const scene = () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const target = makeUser({ username: 'target' });
		makeSession(admin, 'the-admin');
		stepUpFactor(admin);
		makeSession(target, 'target-laptop');
		makeSession(target, 'target-phone');
		makeInvite(target, 'target-invite');
		makeApiKey(target, 'target key');
		makeApiKey(admin, 'admin key');
		makeWebhook(makeBoard({ owner: target }).board, { setBy: target });
		db.insert(reportSchedules).values({ userId: target.id, name: 'Weekly', scope: 'all', enabled: true }).run();
		const request = db
			.insert(taskRequests)
			.values({ targetType: 'user', targetId: admin.id, requesterName: 'target', requesterUserId: target.id, title: 'Help' })
			.returning()
			.get();
		sqlite.prepare("INSERT INTO request_links (token_hash, request_id, source) VALUES (?, ?, 'mail')").run('a'.repeat(64), request.id);
		return { admin, target };
	};

	it('case 6: disables the account and ends everything it ends, or does none of it', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ admin, target }) =>
				api('POST', `/api/users/${target.id}/disable`, { user: admin, body: { currentPassword: FIXTURE_PASSWORD, ...codeOf(admin) }, headers: from('the-admin') }),
			apart: [...STEP_UP_APART],
			afterSuccess: async ({ admin, target }, res: ApiResult) => {
				expect(res.status, JSON.stringify(res.body)).toBe(200);
				expect(res.body).toMatchObject({
					disabled: true,
					sessionsEnded: 2,
					invitesEnded: 1,
					apiKeysEnded: 1,
					webhooksSwitchedOff: 1,
					reportSchedulesPaused: 1,
					requestLinksEnded: 1,
					noticeSent: false
				});
				expect(userRow(target.id)).toMatchObject({ disabledAt: expect.any(String), disabledBy: admin.id });
				expect(sessionsOf(target.id)).toEqual([]);
				expect(invitesOf(target.id)).toEqual([]);
				expect(keysOf(target.id)).toEqual([]);
				// The administrator's are theirs, and stay.
				expect(sessionsOf(admin.id)).toEqual([sessionHashOf('the-admin')]);
				expect(keysOf(admin.id)).toEqual(['admin key']);
			}
		});

		expect(shape(run.writes)).toEqual([
			...STEP_UP_WRITES,
			'update users set',
			// The once-only seed, before the keys go (card 2947's code review, FP2).
			'insert or ignore',
			'insert into settings',
			'delete from sessions',
			'delete from invite_tokens',
			'delete from sign_in_challenges',
			'delete from enrolment_links',
			'delete from api_keys',
			'update webhooks set',
			// The links of the requests it made, by the ending itself since card 2922.
			'delete from request_links',
			'update report_schedules set',
			// Card 2935 (P4): the start pass's moment moved past this disable.
			'update settings set'
		]);
		expect(run.effects).toEqual([]);
	});
});

// ─── Creating a user ────────────────────────────────────────────────────────

describe('POST /api/users', () => {
	/** Mail is switched on, so a user made with no password is sent an invite. */
	const scene = () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		const plain = makeUser({ username: 'plain' });
		makeSession(admin, 'the-admin');
		makeSession(chief, 'the-chief');
		// The factors the callers' codes are made from (card 2771).
		stepUpFactor(admin);
		stepUpFactor(chief);
		makeSmtp();
		return { admin, chief, plain };
	};

	/** An account's enrolment links (card 2851), each as its token's hash and who issued it. */
	const enrolmentLinksOf = (id: number) =>
		db
			.select()
			.from(enrolmentLinks)
			.where(eq(enrolmentLinks.userId, id))
			.all()
			.map((link) => [link.tokenHash, link.issuedBy]);

	/** The user made by `by`, with their own current password (card 2701), from their session. */
	const create = (by: SessionUser | null, body: Record<string, unknown>) =>
		api('POST', '/api/users', {
			user: by,
			body: { ...body, currentPassword: FIXTURE_PASSWORD, ...codeOf(by) },
			headers: from(by?.role === 'superadmin' ? 'the-chief' : 'the-admin')
		});

	it('with no password, makes the user and their invite, or neither, and mails it once they are saved', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ admin }) => create(admin, { username: '  newbie ', email: ' Newbie@Example.test ' }),
			apart: [...STEP_UP_APART],
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
					html: expect.stringContaining('/invite/')
				});
				// Kept as its hash (card 2849).
				const mailed = (sent[0] as { html: string }).html.match(/\/invite\/([\w-]+)/)![1];
				expect(inviteHashOf(mailed)).toEqual(invites[0].tokenHash);
			}
		});

		// A failure at the invite used to leave a user whose password nobody
		// knew and no invite with which to set one. The delete finds nothing:
		// an invite is issued one way, which ends any earlier one first. Before
		// them, the administrator's own password counted, their code spent and
		// the count cleared, apart from the transaction (cards 2701 and 2771).
		expect(shape(run.writes)).toEqual([
			...STEP_UP_WRITES,
			'insert into users',
			'delete from invite_tokens',
			'insert into invite_tokens'
		]);
		expect(run.effects.map(name)).toEqual(["email to newbie@example.test: You're invited to DumpFire!"]);
		expectHashedOutsideTransaction();
	});

	it('logs an invited account once, with its role and who made it, and nothing secret (card 2905)', async () => {
		const { chief } = scene();
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'INFO';
		const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
		const sent = effects();
		let res: ApiResult;
		let mailed: string;
		try {
			res = await create(chief, { username: 'deputy', email: 'deputy@example.test', role: 'admin' });
			await sent.settle();
			expect(sent.emails).toHaveLength(1);
			mailed = sent.emails[0].html.match(/\/invite\/([\w-]+)/)![1];
		} finally {
			sent.restore();
			quiet.mockRestore();
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body).toMatchObject({ role: 'admin', invited: true, mailSent: true });

		const lines = sqlite.prepare("SELECT level, context, message, meta, user_id AS userId FROM system_logs WHERE message LIKE 'Account %'").all();
		expect(lines).toEqual([
			{
				level: 'INFO',
				context: 'AUTH',
				message: `Account ${res.body.id} ("deputy") made by "chief" as an administrator, with an invite to set their password`,
				meta: JSON.stringify({ accountId: res.body.id, role: 'admin', firstSignIn: 'invite' }),
				userId: chief.id
			}
		]);
		// No line holds the address or the invite's token.
		const everything = JSON.stringify(sqlite.prepare('SELECT message, meta FROM system_logs').all());
		expect(everything).not.toContain('deputy@example.test');
		expect(everything).not.toContain(mailed);
	});

	it('with a password, makes the user and their set-up link together, or neither, answers the link once and mails nobody (card 2851)', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ chief }) =>
				create(chief, { username: 'deputy', email: 'deputy@example.test', password: NEW, role: 'admin' }),
			apart: [...STEP_UP_APART],
			afterSuccess: async (_s, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({ username: 'deputy', role: 'admin', invited: false, message: expect.stringContaining('set-up link') });
				expect(await matches(NEW, hashOf(res.body.id))).toBe(true);
				expect(db.select().from(inviteTokens).all()).toEqual([]);

				// The link, once, kept by nothing on the way; stored as its hash alone, for seven days.
				expect(res.headers.get('cache-control')).toBe('no-store');
				const token = (res.body.enrolmentUrl as string).match(/^http:\/\/localhost\/enrol\/([A-Za-z0-9_-]{43})$/)![1];
				expect(enrolmentLinksOf(res.body.id)).toEqual([[sha256Hex(token), 'admin-create']]);
				const expires = parseStamp(db.select().from(enrolmentLinks).get()!.expiresAt)!.getTime();
				expect(Math.abs(expires - Date.now() - ENROLMENT_LINK_LIFETIME_MS)).toBeLessThan(60_000);
				expect(usableEnrolmentLink(token)).toMatchObject({ userId: res.body.id, username: 'deputy' });
			}
		});

		// The superadmin's own password counted, their code spent and the count cleared (cards 2701 and 2771), then
		// the user and its link: the delete finds nothing, as a link is issued one way, which ends any earlier one.
		expect(shape(run.writes)).toEqual([...STEP_UP_WRITES, 'insert into users', 'delete from enrolment_links', 'insert into enrolment_links']);
		expect(run.effects).toEqual([]);

		// Said once at INFO, naming the account and who made it, and never the link or its token.
		resetDb();
		resetAllRateLimits();
		const { chief } = scene();
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'INFO';
		const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
		let res: ApiResult;
		try {
			res = await create(chief, { username: 'deputy', email: 'deputy@example.test', password: NEW });
		} finally {
			quiet.mockRestore();
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
		expect(res.status).toBe(201);
		const lines = sqlite.prepare("SELECT message, meta, user_id AS userId FROM system_logs WHERE message LIKE 'Account %'").all();
		expect(lines).toEqual([
			{
				message: `Account ${res.body.id} ("deputy") made by "chief" as a user, with a password they chose; an enrolment link was issued`,
				meta: JSON.stringify({ accountId: res.body.id, role: 'user', firstSignIn: 'set-up-link', issuedBy: 'admin-create' }),
				userId: chief.id
			}
		]);
		const token = (res.body.enrolmentUrl as string).split('/enrol/')[1];
		expect(JSON.stringify(sqlite.prepare('SELECT message, meta FROM system_logs').all())).not.toContain(token);
	});

	it('withholds the set-up link when the caller can no longer manage the account by the time it is answered (card 2851)', async () => {
		const s = scene();
		// The caller's session ends just after the commit: as the INFO line is said, before the link is answered.
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'INFO';
		const quiet = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
		const stop = subscribeToLogs((entry) => {
			if (entry.message.includes('with a password they chose')) db.delete(sessions).where(eq(sessions.tokenHash, sessionHashOf('the-admin'))).run();
		});
		let res: ApiResult;
		try {
			res = await create(s.admin, { username: 'newbie', email: 'newbie@example.test', password: NEW });
		} finally {
			stop();
			for (const spy of quiet) spy.mockRestore();
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		// The account and its link stand; the link is not in the answer, which says to press 🛡️.
		expect(res.status).toBe(201);
		expect(res.body).toMatchObject({ username: 'newbie', invited: false, enrolmentUrl: null });
		expect(res.body.message).toContain('🛡️');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(enrolmentLinksOf(res.body.id)).toEqual([[expect.any(String), 'admin-create']]);

		const warned = sqlite.prepare("SELECT message, meta, user_id AS userId FROM system_logs WHERE level = 'WARN'").all() as {
			message: string;
			meta: string;
			userId: number;
		}[];
		expect(warned).toEqual([
			{
				message:
					`The enrolment link of user ${res.body.id}, issued when user ${s.admin.id} made the account, was not given to them: ` +
					"the caller's session has ended, or is no longer an administrator's",
				meta: JSON.stringify({ accountId: res.body.id, check: 'session' }),
				userId: s.admin.id
			}
		]);
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
		// None of those was hashed for, and the caller's own password, sent with
		// each, was checked for none (card 2701): nothing is counted.
		expect(bcrypt.inTransaction).toEqual([]);
		expect([countOf('the-admin'), countOf('the-chief')]).toEqual([0, 0]);
	});

	it('refuses a password over 1,024 characters before the step-up, and makes the user with one of 1,024 (card 2888)', async () => {
		const s = scene();
		const good = { username: 'newbie', email: 'newbie@example.test' };
		const longest = 'y'.repeat(LONGEST_PASSWORD);

		const refused = await expectRefused(() => create(s.admin, { ...good, password: 'x'.repeat(LONGEST_PASSWORD + 1) }), 400);
		expect(refused.body.message).toBe(PASSWORD_TOO_LONG);
		expect(bcrypt.inTransaction).toEqual([]);
		expect(countOf('the-admin')).toBe(0);

		const made = await create(s.admin, { ...good, password: longest });
		expect(made.status).toBe(201);
		expect(made.body).toMatchObject({ username: 'newbie', invited: false });
		expect(await matches(longest, hashOf(made.body.id))).toBe(true);
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
		// The name and the address are looked for before the administrator's
		// own password is asked for (card 2701), read only in a transaction of
		// their own, by the first reads, each with the session's account (card
		// 2775). The fourth is the administrator's
		// hash, read for their password: the name is taken then, once it has
		// been looked for and found unused.
		const reads = watchReads('users', (nth) => {
			if (nth === 4) makeUser({ username: 'newbie' });
		});

		let res: ApiResult;
		try {
			res = await create(s.admin, { username: 'newbie', email: 'another@example.test' });
		} finally {
			reads.restore();
		}

		expect(res.status).toBe(409);
		expect(res.body.message).toBe('Username already taken');
		// Looked for twice, the hash read, and in the transaction that creates the
		// user, once the stored hash has held, found by the first read of the name.
		expect(reads.inTransaction).toEqual([true, true, true, false, true, true, true]);
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
		makeSession(admin, 'the-admin');
		// The factor the administrator's code is made from (card 2771).
		stepUpFactor(admin);
		makeSmtp();
		return { admin, invitee, bystander };
	};

	/** The invite sent again by `by`, with their own current password (card 2701), from the administrator's session. */
	const resend = (by: SessionUser, id: number) =>
		api('POST', `/api/users/${id}/invite`, { user: by, body: { currentPassword: FIXTURE_PASSWORD, ...codeOf(by) }, headers: from('the-admin') });

	/** The token in an invite mail's link. */
	const tokenIn = (html: string) => html.match(/\/invite\/([\w-]+)/)![1];

	it('ends every earlier invite of the account not yet used and writes the one it mails, or does neither', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ admin, invitee }) => resend(admin, invitee.id),
			apart: [...STEP_UP_APART],
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
					[inviteHashOf('spent'), true],
					[inviteHashOf(mailed), false]
				]);
				const issued = db.select().from(inviteTokens).where(eq(inviteTokens.tokenHash, inviteHashOf(mailed))).get()!;
				expect(parseStamp(issued.expiresAt)!.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * HOUR);

				expect(invitesOf(bystander.id)).toEqual([[inviteHashOf('theirs'), false]]);
			}
		});

		// The administrator's own password counted, their code spent and the
		// count cleared, apart from the transaction (cards 2701 and 2771); then
		// the invites.
		expect(shape(run.writes)).toEqual([...STEP_UP_WRITES, 'delete from invite_tokens', 'insert into invite_tokens']);
		expect(run.effects.map(name)).toEqual(["email to invitee@example.test: You're invited to DumpFire!"]);
	});

	it('leaves only the newest invite working: the earlier link is refused and the newer one sets the password', async () => {
		const { admin, invitee } = scene();
		const sent = effects();
		let first = '';
		let second = '';
		try {
			expect((await resend(admin, invitee.id)).status).toBe(200);
			// The code made again: the first spent its step (card 2771).
			stepUpCode(admin);
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
		// On to setting up two-step sign-in (card 2769).
		expect(used).toMatchObject({ type: 'redirect', status: 303, location: '/login/enrol' });
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
			.values({ tokenHash: inviteHashOf(TOKEN), userId: invitee.id, expiresAt: stamp(new Date(Date.now() + 60 * 60 * 1000)) })
			.run();
		return { invitee };
	};

	const invite = () => db.select().from(inviteTokens).where(eq(inviteTokens.tokenHash, inviteHashOf(TOKEN))).get()!;
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

	it('sets the password, uses the invite up, ends the account\'s other access and opens its set-up, or does none of it', async () => {
		const run = await eachWriteInTurn({
			build: invitedWithAccess,
			request: () => use(),
			afterSuccess: async ({ invitee, bystander }, res: ActionResult) => {
				// On to setting up two-step sign-in, which alone signs in (card 2769).
				expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/login/enrol' });
				expect(await matches(NEW, hashOf(invitee.id))).toBe(true);

				// This invite is kept, marked used; the other is gone, and so are
				// the sessions and the key. No session is made: the cookie is the
				// set-up challenge's.
				expect(invitesOf(invitee.id)).toEqual([[inviteHashOf(TOKEN), true]]);
				expect(keysOf(invitee.id)).toEqual([]);
				expect(sessionsOf(invitee.id)).toEqual([]);
				expect(res.cookies[SESSION_COOKIE_NAME]).toBeUndefined();
				expect(challengesOf(invitee.id)).toEqual([[tokenHashOf(res.cookies[CHALLENGE_COOKIE].value), 'enrol', 'invite']]);

				expect(sessionsOf(bystander.id)).toEqual([sessionHashOf('theirs')]);
				expect(invitesOf(bystander.id)).toEqual([[inviteHashOf('their-invite'), false]]);
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
			// The once-only seed of the reads made before they were recorded, before the keys go (card 2947's code
			// review, FP2): written here because no sweep has run on this database.
			'insert or ignore',
			'insert into settings',
			'delete from sessions',
			'delete from invite_tokens',
			// The pending sign-ins and enrolment links (card 2768), whether or not a row matches.
			'delete from sign_in_challenges',
			'delete from enrolment_links',
			'delete from api_keys',
			'update webhooks set',
			// The links of the requests it made (card 2922).
			'delete from request_links',
			'update report_schedules set',
			// The set-up challenge, in place of a session (card 2769): the expired
			// ones swept, this browser's and the account's older ones, and the new one.
			'delete from sign_in_challenges',
			'delete from sign_in_challenges',
			'insert into sign_in_challenges'
		]);
		expect(run.effects).toEqual([]);
		expectHashedOutsideTransaction();
	});

	it('refuses every other invite of the account once one is used, as two written before this rule would be', async () => {
		const { invitee } = invited();
		makeInvite(invitee, 'the-other-invite');

		expect(await use()).toMatchObject({ type: 'redirect', status: 303, location: '/login/enrol' });

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
			// Card 2935 (P8): no webhook of others whose secret it could read.
			holdsReadable: false,
			// Card 2922: nothing the account set to hold, said as a yes or no alone (its code review's C10).
			holdsSettings: false,
			username: 'invitee',
			emoji: '👤',
			apiKeys: 2,
			webhooks: 0,
			webhooksAlreadyOff: 0,
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
		expect(sessionsOf(chief.id)).toEqual([sessionHashOf('chief-laptop')]);
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

		// One set-up challenge, and its cookie went to the one that was let in;
		// no session, which only setting up makes (card 2769).
		const mine = challengesOf(invitee.id);
		expect(mine).toHaveLength(1);
		expect(tokenHashOf(both.find((res) => res.type === 'redirect')!.cookies[CHALLENGE_COOKIE].value)).toBe(mine[0][0]);
		expect(sessionsOf(invitee.id)).toEqual([]);
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
			if (nth === 1) db.update(inviteTokens).set({ used: true }).where(eq(inviteTokens.tokenHash, inviteHashOf(TOKEN))).run();
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
		expect(hashOf(invitee.id)).toBe(FIXTURE_PASSWORD_HASH);
		expect(sessionsOf(invitee.id)).toEqual([]);
	});

	it('answers as it did for each refusal, with nothing written and no cookie', async () => {
		const { invitee } = invited();
		const other = makeUser({ username: 'other' });
		db.insert(inviteTokens)
			.values([
				{ tokenHash: inviteHashOf('expired'), userId: other.id, expiresAt: stamp(new Date(Date.now() - 1000)) },
				{ tokenHash: inviteHashOf('used'), userId: other.id, expiresAt: stamp(new Date(Date.now() + 60 * 60 * 1000)), used: true }
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
		expect(hashOf(invitee.id)).toBe(FIXTURE_PASSWORD_HASH);
	});

	it('refuses a password over 1,024 characters with the invite still good, and sets one of 1,024 (card 2888)', async () => {
		const { invitee } = invited();
		const tooLong = 'x'.repeat(LONGEST_PASSWORD + 1);
		const longest = 'y'.repeat(LONGEST_PASSWORD);

		const refused = await expectNothingWritten(() => use({ password: tooLong, confirmPassword: tooLong }));
		expect(refused).toMatchObject({ type: 'failure', status: 400, data: { error: `${PASSWORD_TOO_LONG}.` } });
		expect(refused.cookies).toEqual({});
		expect(bcrypt.inTransaction).toEqual([]);
		expect(invite().used).toBe(false);

		const res = await use({ password: longest, confirmPassword: longest });
		expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/login/enrol' });
		expect(challengesOf(invitee.id)).toEqual([[tokenHashOf(res.cookies[CHALLENGE_COOKIE].value), 'enrol', 'invite']]);
		expect(await matches(longest, hashOf(invitee.id))).toBe(true);
	});
});

// ─── What taking an account back switches off (card 2168) ───────────────────
//
// A webhook names the account that last set its address or secret
// (`webhooks.set_by`, migration 0056). An administrator's reset and an invite
// used switch off every webhook the account set and pause its report
// schedules; the holder's own change switches off the webhooks only when they
// end their keys, and pauses every schedule of theirs that is on, always
// (card 2894). A webhook nobody is recorded as having set, and one somebody
// else set, are left alone.

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
		makeSession(admin, 'the-admin');
		// The factor the administrator's code is made from (card 2771).
		stepUpFactor(admin);
		return { admin, target, editor, board, hooks, schedules };
	};
	type Scene = ReturnType<typeof scene>;

	/** The scene with mail set up (card 2923): the board's owners are mailed once access ends. */
	const withMail = () => {
		const s = scene();
		makeSmtp();
		return s;
	};
	const OWNERS_NOTICE = 'A notice about webhooks on your boards';
	/** A webhook's hold, as stored (card 2923). */
	const heldOf = (id: number) => sqlite.prepare('SELECT held_because FROM webhooks WHERE id = ?').pluck().get(id) as string | null;

	/**
	 * Card 2923: the board's owners' mail among what a successful write sent, once its commit is done: one, naming
	 * `cause`; the webhook switched off listed, and apart the one already off, now held; host only. The one already
	 * off is held as stored. Since card 2935's code review (C11d) the target, the board's only owner, is never mailed
	 * of its own ending: the board is told through its administrator.
	 */
	function expectOwnersMail(s: Scene, sent: RecordedEffect[], cause: string) {
		const mails = sent.flatMap((effect) => (effect.kind === 'email' && effect.subject === OWNERS_NOTICE ? [effect] : []));
		expect(mails.map((mail) => mail.to)).toEqual([s.admin.email]);
		const [mail] = mails;
		expect(mail.inTransaction).toBe(false);
		// The kind of action, naming no account (card 2923's code review, S5): the target is not named, nor who acted.
		expect(mail.html).toContain(`What caused it: ${cause}.`);
		expect(mail.html).not.toContain('target');
		expect(mail.html).not.toMatch(/\badmin\b/);
		expect(mail.html).toContain(
			`webhook ${s.hooks.theirs} to <strong>hooks.example.test</strong>, switched off because the account that set it up had its access ended.`
		);
		expect(mail.html).toContain(
			`webhook ${s.hooks.alreadyOff} to <strong>hooks.example.test</strong>: already switched off; now held because the account that set it up had its access ended; ` +
				'switched on, it is given a new secret.'
		);
		expect(mail.html).not.toContain('/theirs');
		expect(heldOf(s.hooks.alreadyOff)).toBe('setter access ended');
	}

	/** The password set by `by`, with their own current password (card 2701), from `session`. */
	const reset = (by: SessionUser, id: number, session = 'the-admin') =>
		api('PUT', `/api/users/${id}/password`, { user: by, body: { password: NEW, currentPassword: FIXTURE_PASSWORD, ...codeOf(by) }, headers: from(session) });

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
			// With mail set up (card 2923, case 5): the board's owners are mailed once the reset is committed.
			build: withMail,
			request: ({ admin, target }) => reset(admin, target.id),
			apart: [...STEP_UP_APART],
			afterSuccess: (s, res: ApiResult, sent) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({
					success: true,
					sessionsEnded: 0,
					apiKeysEnded: 0,
					webhooksSwitchedOff: 1,
					readableWebhooksHeld: 0,
					reportSchedulesPaused: 1,
					settingsHeld: null
				});
				expectTakenBack(s, { schedules: true });
				expectOwnersMail(s, sent, ENDING_IN_MAIL.passwordReset);
			}
		});

		// Each failure in turn left the webhook on and the schedule enabled,
		// with nothing sent: `eachWriteInTurn` checks every row each time. The
		// first three count the administrator's own password, spend their code
		// and clear the count, apart from the transaction (cards 2701 and 2771).
		expect(shape(run.writes)).toEqual([
			...STEP_UP_WRITES,
			'update users set',
			// The once-only seed of the reads made before they were recorded, before the keys go (card 2947's code
			// review, FP2): written here because no sweep has run on this database.
			'insert or ignore',
			'insert into settings',
			'delete from sessions',
			'delete from invite_tokens',
			// The pending sign-ins and enrolment links (card 2768), whether or not a row matches.
			'delete from sign_in_challenges',
			'delete from enrolment_links',
			'delete from api_keys',
			'update webhooks set',
			// The links of the requests it made (card 2922).
			'delete from request_links',
			'update report_schedules set'
		]);
		// Card 2923 (case 5): the successful run mailed the board's owner, the target, once, with both lists, and sent
		// nothing else; every failed write sent nothing (`eachWriteInTurn`).
		expect(run.effects.map((effect) => (effect.kind === 'email' ? effect.subject : effect.kind))).toEqual([OWNERS_NOTICE]);
	});

	// Card 2915 (case 10, E11): the two-step reset takes the account back as the password set does, and the
	// statements it makes are pinned whole, the App URL set for its link.
	it("on an administrator's two-step reset, ends the account's keys, switches off the webhooks it set and pauses its report schedules, or does none of it", async () => {
		const withKey = () => {
			// With mail set up (card 2923, case 7): the owners' mail goes beside the holder's notice.
			const s = withMail();
			makeApiKey(s.target, 'Deploy');
			sqlite.prepare("INSERT INTO settings (key, value) VALUES ('app_url', 'https://dumpfire.example.test')").run();
			return s;
		};
		const run = await eachWriteInTurn({
			build: withKey,
			request: ({ admin, target }) =>
				api('POST', `/api/users/${target.id}/mfa/reset`, {
					user: admin,
					body: { currentPassword: FIXTURE_PASSWORD, ...codeOf(admin) },
					headers: from('the-admin')
				}),
			apart: [...STEP_UP_APART],
			afterSuccess: (s, res: ApiResult, sent) => {
				expect(res.status, JSON.stringify(res.body)).toBe(200);
				expect(res.body).toMatchObject({ success: true, apiKeysEnded: 1, webhooksSwitchedOff: 1, reportSchedulesPaused: 1 });
				expect(db.select().from(apiKeys).where(eq(apiKeys.userId, s.target.id)).all()).toEqual([]);
				expectTakenBack(s, { schedules: true });
				expectOwnersMail(s, sent, ENDING_IN_MAIL.twoStepReset);
			}
		});

		// Each failure in turn left the key, the webhook on and the schedule enabled, with nothing sent.
		expect(shape(run.writes)).toEqual([
			...STEP_UP_WRITES,
			'delete from mfa_factors',
			'delete from mfa_recovery_codes',
			'update users set',
			// The once-only seed, before the keys go (card 2947's code review, FP2).
			'insert or ignore',
			'insert into settings',
			'delete from sessions',
			'delete from invite_tokens',
			'delete from sign_in_challenges',
			'delete from enrolment_links',
			'delete from api_keys',
			'update webhooks set',
			// The links of the requests it made (card 2922).
			'delete from request_links',
			'update report_schedules set',
			// The link (issueEnrolmentLink), issued last.
			'delete from enrolment_links',
			'insert into enrolment_links'
		]);
		// Card 2923 (case 7): the owners' mail beside the holder's notice, and nothing else; nothing from a failed write.
		expect(run.effects.map((effect) => (effect.kind === 'email' ? [effect.to, effect.subject] : effect.kind)).sort()).toEqual(
			[
				// Card 2935's code review (C11d): not the target, its only owner, but its administrator.
				['admin@example.test', OWNERS_NOTICE],
				['target@example.test', 'Your DumpFire two-step sign-in was reset']
			].sort()
		);
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
				// reset, and switched off for good at delivery since card 2752.
				expect(hookRow(s.hooks.nobodys)).toEqual({ active: 0, setBy: null });
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
			// With mail set up (card 2923, case 6): the board's owners are mailed once the invite's use is committed.
			const s = withMail();
			makeInvite(s.target, 'the-token');
			return s;
		};
		const use = () => action('/invite/the-token', { form: { password: NEW, confirmPassword: NEW } });

		const run = await eachWriteInTurn({
			build: withInvite,
			request: use,
			afterSuccess: (s, res: ActionResult, sent) => {
				expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/login/enrol' });
				expectTakenBack(s, { schedules: true });
				expectOwnersMail(s, sent, ENDING_IN_MAIL.invite);
			}
		});
		// Card 2923 (case 6): that mail and nothing else; nothing from a failed write.
		expect(run.effects.map((effect) => (effect.kind === 'email' ? effect.subject : effect.kind))).toEqual([OWNERS_NOTICE]);
		expect(shape(run.writes)).toEqual([
			'update users set',
			'update invite_tokens set',
			// The once-only seed of the reads made before they were recorded, before the keys go (card 2947's code
			// review, FP2): written here because no sweep has run on this database.
			'insert or ignore',
			'insert into settings',
			'delete from sessions',
			'delete from invite_tokens',
			// The pending sign-ins and enrolment links (card 2768), whether or not a row matches.
			'delete from sign_in_challenges',
			'delete from enrolment_links',
			'delete from api_keys',
			'update webhooks set',
			// The links of the requests it made (card 2922).
			'delete from request_links',
			'update report_schedules set',
			// The set-up challenge, in place of a session (card 2769).
			'delete from sign_in_challenges',
			'delete from sign_in_challenges',
			'insert into sign_in_challenges'
		]);

		await atInfo(async () => {
			resetDb();
			const s = withInvite();
			// The owners' mail recorded, not sent (card 2923).
			const sent = effects();
			try {
				await use();
				await sent.settle();
			} finally {
				sent.restore();
			}
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

	// Card 2894 (case 1, E20): reworked from "… and pauses no schedule".
	it("on the holder's own change, pauses every report schedule of theirs that is on and says how many, and switches off the webhooks they set only when they end their keys", async () => {
		await atInfo(async () => {
			const s = scene();
			// Two of theirs on (the scene's and this one) and one off; the editor's on.
			const second = makeSchedule(s.target);
			// The session the change is asked from, which counts its current
			// password (card 2701), and which the change ends; and the factor of
			// their code (card 2771).
			makeSession(s.target, 'my-laptop');
			stepUpFactor(s.target);

			// With mail set up (card 2923, case 2): the owners are mailed only of a change that ends the keys.
			makeSmtp();
			const sent = effects();
			// Put back however the case ends, so that a failure here leaves no recorder for the cases after it.
			onTestFinished(() => sent.restore());

			// A change that keeps the keys keeps their webhooks, and pauses both
			// schedules all the same: the flag does not split the pause.
			const kept = await changeOwn(s.target, { currentPassword: OLD, newPassword: NEW, endApiKeys: false });
			expect(kept.body).toEqual({ success: true, apiKeysEnded: 0, webhooksSwitchedOff: 0, readableWebhooksHeld: 0, reportSchedulesPaused: 2, settingsHeld: null });
			expect(hookRow(s.hooks.theirs)).toEqual({ active: 1, setBy: s.target.id });
			// Card 2923 (decision 3): nor is the one already off held, and nobody is mailed of webhooks.
			expect(heldOf(s.hooks.alreadyOff)).toBeNull();
			await sent.settle();
			expect(sent.emails.filter((mail) => mail.subject === OWNERS_NOTICE)).toEqual([]);
			for (const id of [s.schedules.theirs, second]) {
				const paused = scheduleRow(id);
				expect(paused.enabled).toBe(0);
				expect(paused.updatedAt).not.toBe(LONG_AGO);
				expect(parseStamp(paused.updatedAt)).not.toBeNull();
			}
			expect(scheduleRow(s.schedules.alreadyPaused)).toEqual({ enabled: 0, updatedAt: LONG_AGO });
			expect(scheduleRow(s.schedules.editors)).toEqual({ enabled: 1, updatedAt: LONG_AGO });

			// Asked to end the keys, with none to end: the webhook they set is
			// switched off all the same (R-S5), and no schedule is left on to
			// pause. The code made again: the first spent its step (card 2771).
			stepUpCode(s.target);
			const ended = await changeOwn(s.target, { currentPassword: NEW, newPassword: 'a third password', endApiKeys: true }, kept.cookie!.value);
			expect(ended.body).toEqual({ success: true, apiKeysEnded: 0, webhooksSwitchedOff: 1, readableWebhooksHeld: 0, reportSchedulesPaused: 0, settingsHeld: null });
			expectTakenBack(s, { schedules: true });
			// Card 2923 (case 2): the change that ends the keys holds the one already off, and mails the owner, the
			// holder, naming it.
			await sent.settle();
			expectOwnersMail(s, sent.all, ENDING_IN_MAIL.ownChange);

			const lines = authLines('Password changed by user%');
			expect(lines.map((line) => line.message)).toEqual([
				'Password changed by user — ended 1 session(s), 0 invite(s) and 0 API key(s), switched off 0 webhook(s) they set up ' +
					`and paused 2 report schedule(s) (ids ${s.schedules.theirs}, ${second})`,
				// The session the first change started is among those the second ends.
				`Password changed by user — ended 1 session(s), 0 invite(s) and 0 API key(s), switched off 1 webhook(s) they set up (id ${s.hooks.theirs}) ` +
					'and paused 0 report schedule(s)'
			]);
			expect(lines.map((line) => line.meta)).toEqual([
				{
					sessionsEnded: 1,
					invitesEnded: 0,
					apiKeysEnded: 0,
					webhooksSwitchedOff: 0,
					webhookIds: [],
					reportSchedulesPaused: 2,
					reportScheduleIds: [s.schedules.theirs, second]
				},
				{
					sessionsEnded: 1,
					invitesEnded: 0,
					apiKeysEnded: 0,
					webhooksSwitchedOff: 1,
					webhookIds: [s.hooks.theirs],
					reportSchedulesPaused: 0,
					reportScheduleIds: []
				}
			]);
		});
	});

	it("makes an administrator who re-points somebody else's webhook its setter, so the administrator's reset switches it off", async () => {
		const s = scene();
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		makeSession(chief, 'the-chief');
		stepUpFactor(chief);

		const repointed = await api('PUT', `/api/v1/webhooks/${s.hooks.editors}`, {
			user: s.admin,
			body: { url: 'https://admins.example.test/x' }
		});
		expect(repointed.status).toBe(200);

		const res = await reset(chief, s.admin.id, 'the-chief');
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
			// Card 2935 (P8): the board's other webhooks are not its to read (an editor).
			holdsReadable: false,
			// Card 2922: nothing the account set to hold, said as a yes or no alone (its code review's C10).
			holdsSettings: false,
			username: 'target',
			emoji: '👤',
			apiKeys: 0,
			webhooks: 1,
			// Card 2923's code review (E9): the one it set that is already off, which setting a password holds.
			webhooksAlreadyOff: 1,
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
			// Twice in the test: the code made again for each, as each spends its step (card 2771).
			const resetTarget = () => {
				stepUpCode(s.admin);
				return reset(s.admin, s.target.id);
			};

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
			// Sent through the gate, which reads only a code in a UUID's shape (card 2775).
			const LAPTOP = '00000000-0000-4000-8000-000000000001';
			const PHONE = '00000000-0000-4000-8000-000000000002';
			const s = scene();
			// Twice in the test: the code made again for each, as each spends its step (card 2771).
			const resetTarget = () => {
				stepUpCode(s.admin);
				return reset(s.admin, s.target.id);
			};

			makeSession(s.target, LAPTOP);
			const made = await sendAround('POST', '/api/report-schedules', { session: LAPTOP }, SCHEDULE(s.board.id), resetTarget);
			expect(made).toEqual({ status: 401, body: { message: 'Not authenticated' } });
			const after = schedulesOf(s.target.id);
			expect(after).toHaveLength(2);

			// Signed in again after the first reset, for the change.
			makeSession(s.target, PHONE);
			const changed = await sendAround(
				'PUT',
				`/api/report-schedules/${s.schedules.theirs}`,
				{ session: PHONE },
				{ enabled: true },
				resetTarget
			);
			expect(changed).toEqual({ status: 401, body: { message: 'Not authenticated' } });
			expect(schedulesOf(s.target.id)).toEqual(after);
			expect(scheduleRow(s.schedules.theirs).enabled).toBe(0);
		});

		it('lets each through, sent the same way, when nothing ended meanwhile', async () => {
			// Sent through the gate, which reads only a code in a UUID's shape (card 2775).
			const LAPTOP = '00000000-0000-4000-8000-000000000001';
			const s = scene();
			const key = makeApiKey(s.target);
			const session = LAPTOP;
			makeSession(s.target, session);
			const nothing = async () => {};

			const made = await sendAround('POST', `/api/v1/boards/${s.board.id}/webhooks`, { key }, { url: 'https://hooks.example.test/new' }, nothing);
			expect(made.status).toBe(201);
			const changed = await sendAround('PUT', `/api/v1/webhooks/${s.hooks.alreadyOff}`, { key }, { active: true }, nothing);
			expect(changed.status).toBe(200);
			// Each with the password and a code (card 2751), the code made just before each is sent.
			const scheduled = await sendAround(
				'POST',
				'/api/report-schedules',
				{ session },
				{ ...SCHEDULE(s.board.id), currentPassword: OLD, currentCode: stepUpCode(s.target) },
				nothing
			);
			expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201);
			const resumed = await sendAround(
				'PUT',
				`/api/report-schedules/${s.schedules.alreadyPaused}`,
				{ session },
				{ enabled: true, currentPassword: OLD, currentCode: stepUpCode(s.target) },
				nothing
			);
			expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
		});
	});
});

// ─── Making an API key ──────────────────────────────────────────────────────

describe('POST /api/account/api-keys', () => {
	const scene = () => {
		const me = withPassword(makeUser({ username: 'me' }));
		makeSession(me, 'my-laptop');
		// The factor the code is made from (card 2771).
		stepUpFactor(me);
		return { me };
	};

	/** A key made by `by`, with the current password and, beside it, their code (card 2771). */
	const create = (by: SessionUser | null, body: Record<string, unknown>) =>
		api('POST', '/api/account/api-keys', { user: by, body: withCode(by, body), headers: from('my-laptop') });

	it('makes a key for the right password, writing nothing but the key', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ me }) => create(me, { name: 'my script', currentPassword: OLD }),
			apart: [...STEP_UP_APART],
			afterSuccess: ({ me }, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({ name: 'my script', key: expect.stringMatching(/^df_[0-9a-f]{64}$/) });
				expect(res.body.keyPrefix).toBe(res.body.key.slice(0, 11));
				expect(keysOf(me.id)).toEqual(['my script']);
			}
		});

		// The password counted as it arrives, the code spent and the count
		// cleared for the right one, apart from the transaction (cards 2701 and
		// 2771); then the key.
		expect(shape(run.writes)).toEqual([...STEP_UP_WRITES, 'insert into api_keys']);
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
			res = await create(me, { name: 'a name for nobody else', currentPassword: OLD });
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

		await expectRefused(() => create(null, { name: 'my script', currentPassword: OLD }), 401);
		// Asked through the step-up since card 2771, in its words.
		expect(await message({ name: 'my script' }, 400)).toBe(STEP_UP_MISSING);
		expect(await message({ name: 'my script', currentPassword: '' }, 400)).toBe(STEP_UP_MISSING);
		expect(await message({ name: 'my script', currentPassword: 12345 }, 400)).toBe(STEP_UP_MISSING);
		// The name is looked at first, as it always was.
		expect(await message({ currentPassword: OLD }, 400)).toBe('Key name is required');
		expect(bcrypt.inTransaction).toEqual([]);

		// Nothing written but the session's count (card 2701).
		expect((await expectRefusedAndCounted(() => create(me, { name: 'my script', currentPassword: 'not it' }), 403, 'my-laptop')).body).toEqual({
			message: STEP_UP_WRONG,
			stepUp: 'wrong'
		});
		expect(keysOf(me.id)).toEqual([]);
	});

	it('refuses 409 when the password was changed elsewhere after it was checked, and makes no key', async () => {
		const { me } = scene();
		const elsewhere = await makePasswordHash('changed elsewhere', 'known');
		// The second read is the one the password is checked against: the first is the session's account, read as writeAs checks the session (card 2775).
		const reads = watchReads('users', (nth) => {
			if (nth === 2) db.update(users).set({ passwordHash: elsewhere }).where(eq(users.id, me.id)).run();
		});

		let res: ApiResult;
		try {
			res = await create(me, { name: 'my script', currentPassword: OLD });
		} finally {
			reads.restore();
		}

		// No second compare against the new hash (card 2701's code review, S2).
		expect(res.status).toBe(409);
		expect(res.body).toEqual({ message: PASSWORD_CHANGED_MEANWHILE, stepUp: 'changed' });
		// Looked at before the transaction, and read again inside it.
		expect(reads.inTransaction).toEqual([true, false, true]);
		expect(keysOf(me.id)).toEqual([]);
	});

	it('refuses an eleventh key, counted again in the transaction that adds one', async () => {
		const { me } = scene();
		for (let n = 1; n <= 9; n++) makeApiKey(me, `key ${n}`);

		// The tenth lands between the first count and the transaction: after
		// the password is compared, as the first count is now the step-up's
		// guard's, in a transaction of its own (card 2771, D7).
		bcrypt.afterCompare = () => {
			bcrypt.afterCompare = undefined;
			makeApiKey(me, 'key 10');
		};
		const reads = watchReads('api_keys');
		let res: ApiResult;
		try {
			res = await create(me, { name: 'one too many', currentPassword: OLD });
		} finally {
			reads.restore();
		}
		expect(res.status).toBe(400);
		expect(res.body.message).toBe('Maximum of 10 API keys per user');
		// The first look is the step-up's guard's, read only in a transaction of
		// its own (card 2771, D7); the second the transaction's that adds the key.
		expect(reads.inTransaction).toEqual([true, true]);
		expect(keysOf(me.id)).toHaveLength(10);

		// And with ten there already, refused before the password is checked.
		bcrypt.inTransaction.length = 0;
		expect(await expectRefused(() => create(me, { name: 'one too many', currentPassword: OLD }), 400)).toMatchObject({
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
	// Theirs, which an account change confirms its caller's password from (card 2701).
	makeSession(chief, 'the-chief');
	makeSession(admin, 'the-admin');
	// The factors their codes are made from (card 2771).
	stepUpFactor(chief);
	stepUpFactor(admin);
	return { chief, admin, otherAdmin, target, bystander };
};

/** The invite page and its form both answer the link of `token` as a dead one. */
async function expectDeadLink(token: string): Promise<void> {
	expect(await loadInvite(token)).toEqual({ valid: false, username: '' });
	expect(await action(`/invite/${token}`, { form: { password: NEW, confirmPassword: NEW } })).toMatchObject(INVALID);
}

describe('PUT /api/users/:id', () => {
	/** The change by `by`, with their own current password (card 2701), from their session. */
	const change = (by: SessionUser, id: number, body: Record<string, unknown>) =>
		api('PUT', `/api/users/${id}`, {
			user: by,
			body: { ...body, currentPassword: FIXTURE_PASSWORD, ...codeOf(by) },
			headers: from(by.role === 'superadmin' ? 'the-chief' : 'the-admin')
		});

	it('ends every invite of the account not yet used when the superadmin changes its email, or does neither', async () => {
		const run = await eachWriteInTurn({
			build: withInvites,
			request: ({ chief, target }) => change(chief, target.id, { email: 'Moved@Example.test' }),
			apart: [...STEP_UP_APART],
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
				expect(invitesOf(target.id)).toEqual([[inviteHashOf('spent'), true]]);
				expect(invitesOf(bystander.id)).toEqual([[inviteHashOf('theirs'), false]]);
				// Whoever has the mail, at the address the account had, is told it no longer works.
				await expectDeadLink('waiting');

				// An email change is not a password change: nobody is signed out.
				expect(sessionsOf(target.id)).toEqual([sessionHashOf('my-laptop')]);
				expect(hashOf(target.id)).toBe(OLD_HASH);
			}
		});

		// The invites end before the account is written, in its transaction.
		// Before it, the superadmin's own password counted, their code spent and
		// the count cleared, apart from the transaction (cards 2701 and 2771).
		expect(shape(run.writes)).toEqual([...STEP_UP_WRITES, 'delete from invite_tokens', 'delete from sign_in_challenges', 'delete from enrolment_links', 'update users set']);
		expect(run.effects).toEqual([]);
	});

	it('ends them when the superadmin makes the account an administrator, and again when it is made a user', async () => {
		const { chief, target } = withInvites();

		const promoted = await change(chief, target.id, { role: 'admin' });
		expect(promoted.status).toBe(200);
		expect(promoted.body).toMatchObject({ role: 'admin', invitesEnded: 2 });
		expect(invitesOf(target.id)).toEqual([[inviteHashOf('spent'), true]]);
		await expectDeadLink('waiting');

		// One sent while the account is an administrator's ends when it is a user's again.
		const sentToAnAdmin = inTransaction(() => issueInvite(target.id));
		// The code made again: the first spent its step (card 2771).
		stepUpCode(chief);
		const demoted = await change(chief, target.id, { role: 'user' });
		expect(demoted.status).toBe(200);
		expect(demoted.body).toMatchObject({ role: 'user', invitesEnded: 1 });
		expect(invitesOf(target.id)).toEqual([[inviteHashOf('spent'), true]]);
		await expectDeadLink(sentToAnAdmin);
	});

	it("ends them when an administrator changes an ordinary user's email", async () => {
		const { admin, target, bystander } = withInvites();

		const res = await change(admin, target.id, { email: 'elsewhere@example.test' });

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ email: 'elsewhere@example.test', invitesEnded: 2 });
		expect(invitesOf(target.id)).toEqual([[inviteHashOf('spent'), true]]);
		expect(invitesOf(bystander.id)).toEqual([[inviteHashOf('theirs'), false]]);
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
			// Each with a code of a step not yet spent (card 2771).
			stepUpCode(by);
			const res = await change(by, target.id, body);
			expect(res.status, JSON.stringify(body)).toBe(200);
			expect(res.body.invitesEnded, JSON.stringify(body)).toBe(0);
		}

		expect(invitesOf(target.id)).toEqual([
			[inviteHashOf('waiting'), false],
			[inviteHashOf('expired'), false],
			[inviteHashOf('spent'), true]
		]);
		// And the invite still sets the password, and leads on to setting up two-step sign-in (card 2769).
		expect(await action('/invite/waiting', { form: { password: NEW, confirmPassword: NEW } })).toMatchObject({
			type: 'redirect',
			status: 303,
			location: '/login/enrol'
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
	/** `withInvites`, with the target's factor, which their code is made from (card 2771). */
	const withFactor = () => {
		const s = withInvites();
		stepUpFactor(s.target);
		return s;
	};
	/** The address changed by `me`, with their current password and code (`currentPassword`, `currentCode`: card 2771). */
	const moveTo = (me: SessionUser, newEmail: string, password: string = OLD) =>
		api('PUT', '/api/account/email', { user: me, body: { newEmail, currentPassword: password, ...codeOf(me) }, headers: from('my-laptop') });

	it('changes the address and ends every invite of the account not yet used, or does neither, and keeps the session that asked', async () => {
		const run = await eachWriteInTurn({
			build: withFactor,
			request: ({ target }) => moveTo(target, ' Moved@Example.test '),
			apart: [...STEP_UP_APART],
			afterSuccess: async ({ target, bystander }, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true, email: 'moved@example.test' });
				expect(userRow(target.id).email).toBe('moved@example.test');

				expect(invitesOf(target.id)).toEqual([[inviteHashOf('spent'), true]]);
				expect(invitesOf(bystander.id)).toEqual([[inviteHashOf('theirs'), false]]);
				await expectDeadLink('waiting');

				// The session that asked is still good.
				expect(openSessionUser(sessionHashOf('my-laptop'))).not.toBeNull();
			}
		});

		// The address used to be written on its own, with no transaction and nothing else.
		// Before it, the password counted as it arrives, the code spent and the
		// count cleared for the right one, apart from the transaction (cards
		// 2701 and 2771).
		expect(shape(run.writes)).toEqual([...STEP_UP_WRITES, 'delete from invite_tokens', 'delete from sign_in_challenges', 'delete from enrolment_links', 'update users set']);
		expect(run.effects).toEqual([]);
		// Checked before the transaction, where a quarter of a second holds nobody up.
		expectHashedOutsideTransaction();
	});

	it('ends none for the address it has, in other case', async () => {
		const { target } = withFactor();

		const res = await moveTo(target, 'TARGET@example.test');

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true, email: 'target@example.test' });
		expect(invitesOf(target.id)).toHaveLength(3);
		// The invite waiting is still there, unused. Its page no longer offers it
		// to an account that holds a second factor (card 2773), as the target
		// does to confirm with a code (card 2771), so its row is read.
		expect(invitesOf(target.id)).toContainEqual([inviteHashOf('waiting'), false]);
	});

	it('ends nothing when it refuses: a wrong password, an address in use', async () => {
		const { target } = withFactor();

		// The right password and code, and an address another account holds:
		// refused by the write's own look, the only one, after the check (card
		// 2771's code review, CS1). The code is left spent (S4) and nothing else
		// written: the count the check took, the right answer cleared. A wrong
		// one writes nothing but that count (card 2701), which a right one would
		// then clear: so in this order.
		const before = snapshotDb();
		const sent = effects();
		try {
			const taken = await moveTo(target, 'Bystander@example.test');
			await sent.settle();
			expect(taken.status).toBe(409);
			expect(taken.body.message).toBe('Email is already in use');
			expectUnchanged(withCodeSpent(before));
			expect(sent.all).toEqual([]);
		} finally {
			sent.restore();
		}
		// A step not yet spent for the next, so that it reaches the password.
		stepUpCode(target);
		expect((await expectRefusedAndCounted(() => moveTo(target, 'moved@example.test', 'not it'), 403, 'my-laptop')).body).toEqual({
			message: STEP_UP_WRONG,
			stepUp: 'wrong'
		});

		// The invite waiting is still there, unused: read from its row, as the
		// target holds a factor (cards 2771 and 2773).
		expect(invitesOf(target.id)).toContainEqual([inviteHashOf('waiting'), false]);
	});

	it('refuses an address taken after the password was checked, inside the transaction that writes it', async () => {
		const { target, bystander } = withFactor();
		// The second read is the one the password is checked against: the first is the session's account, read as writeAs
		// checks the session (card 2775). The guard does not look for the address (card 2771's code review, CS1).
		const reads = watchReads('users', (nth) => {
			if (nth === 2) db.update(users).set({ email: 'moved@example.test' }).where(eq(users.id, bystander.id)).run();
		});

		let res: ApiResult;
		try {
			res = await moveTo(target, 'moved@example.test');
		} finally {
			reads.restore();
		}

		expect(res.status).toBe(409);
		expect(res.body.message).toBe('Email is already in use');
		// Read again inside it, and the address looked for there, the only look.
		expect(reads.inTransaction).toEqual([true, false, true, true, true]);
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
			// With the superadmin's own password, from their session (card 2701).
			// With a code made for each, as each spends its step (card 2771).
			const confirmed = (body: Record<string, unknown>) => ({
				user: chief,
				body: { ...body, currentPassword: FIXTURE_PASSWORD, currentCode: stepUpCode(chief) },
				headers: from('the-chief')
			});
			expect((await api('PUT', `/api/users/${target.id}`, confirmed({ email: 'moved@example.test', role: 'admin' }))).status).toBe(200);
			// Nothing changes, so nothing is said.
			expect((await api('PUT', `/api/users/${target.id}`, confirmed({ role: 'admin' }))).status).toBe(200);
			inTransaction(() => issueInvite(target.id));
			// The role change ended the target's session (card 2775): they sign in again.
			makeSession({ ...target, role: 'admin' }, 'signed-in-again');
			// With their current password and code, through the step-up (card 2771).
			const moved = await api('PUT', '/api/account/email', {
				user: { ...target, role: 'admin' },
				body: { newEmail: 'again@example.test', currentPassword: OLD, currentCode: stepUpCode(target) },
				headers: from('signed-in-again')
			});
			expect(moved.status).toBe(200);
		} finally {
			quiet.mockRestore();
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		const lines = sqlite
			.prepare("SELECT level, context, message, meta, user_id AS userId FROM system_logs WHERE message LIKE '%unused invite(s)%'")
			.all() as { level: string; context: string; message: string; meta: string; userId: number }[];
		expect(lines.map((line) => [line.level, line.context, line.message, line.userId, JSON.parse(line.meta)])).toEqual([
			[
				'INFO',
				'AUTH',
				`User ${chief.id} changed the email address and role of user ${target.id} — ended 2 unused invite(s) and 1 session(s)`,
				chief.id,
				{ targetUserId: target.id, changed: ['email address', 'role'], role: 'admin', invitesEnded: 2, sessionsEnded: 1 }
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
		expect(invitesOf(target.id)).toEqual([[inviteHashOf('spent'), true]]);
	});
});

// ─── Wrong current passwords ────────────────────────────────────────────────

describe('wrong current passwords', () => {
	/**
	 * A route that asks for the current password, and what it says when it is
	 * wrong and when it is not text: the step-up's words, since the three ask
	 * through it (card 2771).
	 */
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
			body: (currentPassword) => ({ newEmail: 'moved@example.test', currentPassword }),
			wrong: STEP_UP_WRONG,
			notText: STEP_UP_MISSING
		},
		{
			method: 'PUT',
			path: '/api/account/password',
			body: (currentPassword) => ({ currentPassword, newPassword: NEW }),
			wrong: STEP_UP_WRONG,
			notText: STEP_UP_MISSING
		},
		{
			method: 'POST',
			path: '/api/account/api-keys',
			body: (currentPassword) => ({ name: 'my script', currentPassword }),
			wrong: STEP_UP_WRONG,
			notText: STEP_UP_MISSING
		}
	];
	const [EMAIL, PASSWORD, KEY] = ASKING;
	const named = ASKING.map((route) => [`${route.method} ${route.path}`, route] as const);

	/** What the third wrong password, and anything after it from that session, is answered (card 2701). */
	const SIGNED_OUT = { message: STEP_UP_SIGNED_OUT, signedOut: true, stepUp: 'signed-out' };

	/** Signed in on two devices, with `OLD` as the password. */
	const signedIn = () => {
		const me = withPassword(makeUser({ username: 'me' }));
		makeSession(me, 'my-laptop');
		makeSession(me, 'my-phone');
		// The factor the code is made from (card 2771).
		stepUpFactor(me);
		return { me };
	};

	/** The route, with this password and the code beside it (card 2771), from the session `session`, or with no session cookie for `null`. */
	const send = (route: Asking, me: SessionUser, password: unknown, session: string | null = 'my-laptop') =>
		api(route.method, route.path, {
			user: me,
			body: { ...route.body(password), ...codeOf(me) },
			headers: session === null ? undefined : from(session)
		});

	/** `times` wrong passwords from `session`, each answered as wrong with nothing written but the session's count. */
	async function wrong(route: Asking, me: SessionUser, times: number, session = 'my-laptop'): Promise<void> {
		for (let n = 1; n <= times; n++) {
			const res = await expectRefusedAndCounted(() => send(route, me, 'not it', session), 403, session);
			expect(res.body.message).toBe(route.wrong);
		}
	}

	it.each(named)('%s: ends the session at the third wrong password, and answers the right one after it signed out, without checking it', async (_name, route) => {
		const { me } = signedIn();
		await wrong(route, me, 2);
		expect(countOf('my-laptop')).toBe(2);

		const third = await send(route, me, 'not it');
		expect({ status: third.status, body: third.body }).toEqual({ status: 403, body: SIGNED_OUT });
		expect(sessionsOf(me.id)).toEqual([sessionHashOf('my-phone')]);
		bcrypt.inTransaction.length = 0;

		// The right one after it: the session is gone, so the request is refused
		// 401 as the gate refuses it, by the session's hash (card 2775), and
		// nothing is checked.
		const after = await expectRefused(() => send(route, me, OLD), 401);
		expect(after.body).toEqual({ message: 'Not authenticated' });
		expect(bcrypt.inTransaction).toEqual([]);
		expect(hashOf(me.id)).toBe(OLD_HASH);
	});

	// The review's L1. A current password is checked in the first lane, ahead
	// of every sign-in, and the right one clears the session's count, so a
	// signed-in user could keep checks in flight without end and hold the
	// second lane. Each check takes a place at the account's first-lane
	// checks, five in flight, shared with its remembered browsers' sign-ins.
	// One session has one check in flight at a time (card 2701), so the six
	// come from six sessions.
	it.each(named)('%s: refuses a sixth check in flight at the account, from any session, without checking it', async (_name, route) => {
		const { me } = signedIn();
		const browsers = Array.from({ length: 6 }, (_, n) => `browser-${n + 1}`);
		for (const browser of browsers) makeSession(me, browser);

		const six = await Promise.all(browsers.map((browser) => send(route, me, 'not it', browser)));

		expect(six.map((res) => res.status)).toEqual([403, 403, 403, 403, 403, 429]);
		expect(six[5].body.message).toBe(PASSWORDS_BUSY);
		expect(bcrypt.inTransaction).toHaveLength(5);
		expect(hashOf(me.id)).toBe(OLD_HASH);

		// The places are given back once each is answered.
		expect((await send(route, me, 'not it')).status).toBe(403);
	});

	it('keeps one count for the three routes, for the session: the third wrong one on any of them ends it', async () => {
		const { me } = signedIn();
		await wrong(EMAIL, me, 1);
		await wrong(PASSWORD, me, 1);

		const third = await send(KEY, me, 'not it');
		expect({ status: third.status, body: third.body }).toEqual({ status: 403, body: SIGNED_OUT });
		// Ended: refused 401 on every route, as the gate refuses an ended session (card 2775).
		for (const route of ASKING) {
			expect((await expectRefused(() => send(route, me, OLD), 401)).body).toEqual({ message: 'Not authenticated' });
		}
		expect(sessionsOf(me.id)).toEqual([sessionHashOf('my-phone')]);
	});

	it("keeps a count for each session: the account's other browser is not held up, and changes the password with the right one", async () => {
		// Sent through the gate, which reads only a code in a UUID's shape (card 2775).
		const FIRST = '00000000-0000-4000-8000-000000000001';
		const SECOND = '00000000-0000-4000-8000-000000000002';
		const THEIRS = '00000000-0000-4000-8000-000000000003';
		const me = withPassword(makeUser({ username: 'me' }));
		const other = withPassword(makeUser({ username: 'other' }));
		makeSession(me, FIRST);
		makeSession(me, SECOND);
		makeSession(other, THEIRS);
		stepUpFactor(me);
		stepUpFactor(other);
		// Through the gate, which finds the account from the session cookie; with the code of `who`, the session's account (card 2771).
		const change = (session: string, currentPassword: string, who: SessionUser = me) =>
			gate('PUT', '/api/account/password', {
				headers: { ...from(session), ...FROM_THE_PAGE, accept: 'application/json' },
				body: { currentPassword, ...codeOf(who), newPassword: NEW }
			});

		// Another account's wrong guesses are counted for their session alone.
		for (let n = 1; n <= 2; n++) expect((await change(THEIRS, 'not it', other)).status).toBe(403);

		for (let n = 1; n <= 2; n++) expect((await change(FIRST, 'not it')).status).toBe(403);
		const third = await change(FIRST, 'not it');
		expect(third.status).toBe(403);
		expect(await third.json()).toEqual(SIGNED_OUT);
		// Ended: the gate refuses the next request from it, whatever it carries.
		expect((await change(FIRST, OLD)).status).toBe(401);
		expect(hashOf(me.id)).toBe(OLD_HASH);

		// The account's other browser is not held up. Changing the password
		// there signs every other one out, which is how the owner of an account
		// takes it back.
		expect((await change(SECOND, OLD)).status).toBe(200);
		expect(await matches(NEW, hashOf(me.id))).toBe(true);
		expect(openSessionUser(sessionHashOf(FIRST))).toBeNull();
		expect(openSessionUser(sessionHashOf(THEIRS))).not.toBeNull();
		expect(countOf(THEIRS)).toBe(2);
	});

	it('clears the count on the right password', async () => {
		const { me } = signedIn();

		await wrong(KEY, me, 2);
		expect((await send(KEY, me, OLD)).status).toBe(201);
		expect(countOf('my-laptop')).toBe(0);
		// The code made again: the right one spent its step (card 2771).
		stepUpCode(me);
		await wrong(KEY, me, 2);
		// Two since the right one, and so not yet three.
		expect((await send(KEY, me, OLD)).status).toBe(201);
		expect(keysOf(me.id)).toEqual(['my script', 'my script']);
	});

	it('compares a request once when the stored hash moved before its transaction, refusing it 409 (card 2701’s code review, S2)', async () => {
		const { me } = signedIn();
		await wrong(EMAIL, me, 1);
		const elsewhere = await makePasswordHash('changed elsewhere', 'known');
		// The second read is the one the password is checked against: the first is the session's account, read as writeAs
		// checks the session (card 2775).
		const reads = watchReads('users', (nth) => {
			if (nth === 2) db.update(users).set({ passwordHash: elsewhere }).where(eq(users.id, me.id)).run();
		});

		const bcryptBefore = bcrypt.inTransaction.length;
		let res: ApiResult;
		try {
			res = await send(EMAIL, me, OLD);
		} finally {
			reads.restore();
		}

		// Refused inside the transaction, with no second compare: a compare the
		// session's count never saw would be a free guess.
		expect(res.status).toBe(409);
		expect(res.body).toEqual({ message: PASSWORD_CHANGED_MEANWHILE, stepUp: 'changed' });
		expect(reads.inTransaction).toEqual([true, false, true]);
		// One bcrypt call in this request, the check, outside a transaction.
		expect(bcrypt.inTransaction.slice(bcryptBefore)).toEqual([false]);
		expect(userRow(me.id).email).toBe('me@example.test');

		// The one check was right, and cleared the count. So two wrong ones are
		// let through again before the third ends the session, each with a code
		// of a step not yet spent: the right one spent its own (card 2771, S4).
		expect(countOf('my-laptop')).toBe(0);
		stepUpCode(me);
		await wrong(EMAIL, me, 2);
		expect((await send(EMAIL, me, 'not it')).body).toEqual(SIGNED_OUT);
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

	it('writes a WARN line for each wrong password and one for the session it ends, naming the route and the user, and never the session', async () => {
		const { me } = signedIn();
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			await wrong(EMAIL, me, 2);
			expect((await send(EMAIL, me, 'not it')).body).toEqual(SIGNED_OUT);
			// Ended: one more, from the same session, is refused as the gate
			// refuses it (card 2775), and says nothing more.
			expect((await send(EMAIL, me, 'not it')).body).toEqual({ message: 'Not authenticated' });
		} finally {
			quiet.mockRestore();
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		const lines = sqlite
			.prepare('SELECT level, context, message, meta, user_id AS userId FROM system_logs ORDER BY id')
			.all() as { level: string; context: string; message: string; meta: string; userId: number }[];
		const where = 'PUT /api/account/email';
		expect(lines.map((line) => [line.level, line.context, line.message, line.userId])).toEqual([
			...Array.from({ length: 3 }, () => ['WARN', 'AUTH', `Wrong current password for user ${me.id} on ${where}`, me.id]),
			['WARN', 'AUTH', `Session ended after three wrong current passwords for user ${me.id} on ${where}`, me.id]
		]);
		for (const line of lines) expect(JSON.parse(line.meta)).toEqual({ where });
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

	it('makes the superadmin and opens their set-up of two-step sign-in, or does neither', async () => {
		const run = await eachWriteInTurn({
			build: () => ({}),
			request: () => setUp(),
			afterSuccess: async (_s, res: ActionResult) => {
				// On to setting up two-step sign-in, which alone signs in (card 2769).
				expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/login/enrol' });

				const made = db.select().from(users).all();
				expect(made).toHaveLength(1);
				expect(made[0]).toMatchObject({ username: 'first', email: 'first@example.test', role: 'superadmin' });
				expect(await matches(NEW, made[0].passwordHash)).toBe(true);

				expect(sessionsOf(made[0].id)).toEqual([]);
				expect(challengesOf(made[0].id)).toEqual([[tokenHashOf(res.cookies[CHALLENGE_COOKIE].value), 'enrol', 'setup']]);
			}
		});

		// A failure at the second used to leave a superadmin and nobody signed
		// in as them: the page could not be reached again, only the sign-in one.
		// Now the second is the set-up challenge (card 2769): the expired ones
		// swept, this browser's and the account's older ones, and the new one.
		expect(shape(run.writes)).toEqual([
			'insert into users',
			'delete from sign_in_challenges',
			'delete from sign_in_challenges',
			'insert into sign_in_challenges'
		]);
		expect(run.effects).toEqual([]);
		expectHashedOutsideTransaction();
	});

	it('cannot make two superadmins at the same moment', async () => {
		// Both are started before either is awaited. Each used to find no user
		// before it read its form, and both went on to make one.
		const both = await Promise.all([setUp(form('first')), setUp(form('second'))]);

		// The one let in is sent on to set up two-step sign-in (card 2769); the
		// other to the front page, as anyone is once a user exists.
		expect(both.map((res) => [res.type, res.type === 'redirect' && res.location]).sort()).toEqual([
			['redirect', '/'],
			['redirect', '/login/enrol']
		]);

		const made = db.select().from(users).all();
		expect(made).toHaveLength(1);
		expect(made[0].role).toBe('superadmin');

		// One of them goes on to set up the superadmin's two-step sign-in, and
		// neither is signed in (card 2769).
		const settingUp = both.filter((res) => CHALLENGE_COOKIE in res.cookies);
		expect(settingUp).toHaveLength(1);
		expect(challengesOf(made[0].id)).toEqual([[tokenHashOf(settingUp[0].cookies[CHALLENGE_COOKIE].value), 'enrol', 'setup']]);
		expect(db.select().from(sessions).all()).toEqual([]);
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

	it('refuses a password over 1,024 characters with the name and email kept, and makes the superadmin with one of 1,024 (card 2888)', async () => {
		const tooLong = 'x'.repeat(LONGEST_PASSWORD + 1);
		const longest = 'y'.repeat(LONGEST_PASSWORD);

		const refused = await expectNothingWritten(() => setUp({ ...form(), password: tooLong, confirmPassword: tooLong }));
		expect(refused).toMatchObject({
			type: 'failure',
			status: 400,
			data: { error: PASSWORD_TOO_LONG, username: 'first', email: 'first@Example.test' }
		});
		expect(bcrypt.inTransaction).toEqual([]);

		const res = await setUp({ ...form(), password: longest, confirmPassword: longest });
		expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/login/enrol' });
		const made = db.select().from(users).all();
		expect(made).toHaveLength(1);
		expect(made[0].role).toBe('superadmin');
		expect(await matches(longest, made[0].passwordHash)).toBe(true);
	});
});

// ─── Remembered browsers, when a password is set ────────────────────────────

/**
 * Card 2194. A browser that signs in is remembered for the account by a
 * cookie whose MAC is over the account's password hash, so setting the
 * password, by any way there is, forgets every browser of the account at
 * once. The way that also signs the browser in remembers that browser again,
 * with the new hash: the holder's own change. An invite's use and set-up sign
 * nobody in until two-step sign-in is set up (card 2769), which remembers the
 * browser then, so they remember nobody; nor does an administrator's reset,
 * which signs nobody in.
 */
describe('remembered browsers, when a password is set', () => {
	it('are forgotten by the holder’s own change, all but the browser that made it, which is remembered anew', async () => {
		const me = withPassword(makeUser({ username: 'me' }));
		makeSession(me, 'my-laptop');
		stepUpFactor(me);
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
		stepUpFactor(me);
		const laptop = rememberedFor(me);

		const res = await changeOwn(me, { currentPassword: 'not it', newPassword: NEW });

		expect(res.status).toBe(403);
		expect(res.known).toBeUndefined();
		expect(remembers(laptop, me.id)).toBe(true);
	});

	it('are forgotten by an invite’s use, which remembers no browser before two-step sign-in is set up', async () => {
		const invitee = withPassword(makeUser({ username: 'invitee' }));
		const before = rememberedFor(invitee);
		makeInvite(invitee, 'the-invite');

		const res = await action('/invite/the-invite', { form: { password: NEW, confirmPassword: NEW } });

		expect(res).toMatchObject({ type: 'redirect', location: '/login/enrol' });
		expect(res.cookies[knownBrowserCookie(invitee.id)]).toBeUndefined();
		expect(remembers(before, invitee.id)).toBe(false);
	});

	it('do not include the browser that set the instance up before the superadmin sets up two-step sign-in', async () => {
		const res = await action('/setup', {
			form: { username: 'first', email: 'first@example.test', password: NEW, confirmPassword: NEW }
		});

		expect(res).toMatchObject({ type: 'redirect', location: '/login/enrol' });
		const [chief] = db.select().from(users).all();
		expect(res.cookies[knownBrowserCookie(chief.id)]).toBeUndefined();
	});

	it('are every one forgotten by an administrator’s reset, which remembers none', async () => {
		const admin = makeUser({ username: 'admin', role: 'admin' });
		const target = withPassword(makeUser({ username: 'target' }));
		const theirs = rememberedFor(target);
		// The administrator's own password and code, from their session (cards 2701 and 2771).
		makeSession(admin, 'the-admin');
		stepUpFactor(admin);

		const res = await api('PUT', `/api/users/${target.id}/password`, {
			user: admin,
			body: { password: NEW, currentPassword: FIXTURE_PASSWORD, ...codeOf(admin) },
			headers: from('the-admin')
		});

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
		email_planning: true,
		// Card 2679 (decision 19): the concern notice to a decision's decider.
		email_decisions: true
	};
	const storedFor = (user: SessionUser) =>
		db.select({ prefs: users.notificationPrefs }).from(users).where(eq(users.id, user.id)).get()!.prefs;

	it.each([
		['text that is not JSON', 'not json'],
		['JSON that is not an object', '"off"']
	])('answers every switch off, said to be unreadable, and saves over them, for a user whose stored preferences are %s', async (_what, stored) => {
		const user = makeUser({ username: 'ann' });
		db.update(users).set({ notificationPrefs: stored }).where(eq(users.id, user.id)).run();
		const ALL_OFF = Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, false]));

		// Text that is not JSON used to throw, on the read and on the save, so
		// the user could neither see their preferences nor repair them. A JSON
		// string was spread into the answer a character at a time. Then they
		// were answered as the defaults, every switch on, and sent every mail;
		// now as they are applied, every switch off (card 2724).
		const read = await api('GET', '/api/account/notifications', { user });
		expect(read.status).toBe(200);
		expect(read.body).toEqual({ ...ALL_OFF, unreadable: true });
		expect(storedFor(user)).toBe(stored);

		// A preference that is not true or false is refused (card 2117), and
		// tests/request-body.test.ts holds it; one it does not know is left alone.
		const saved = await api('PUT', '/api/account/notifications', {
			user,
			body: { email_all: true, email_comments: true, not_a_preference: false }
		});
		expect(saved.status).toBe(200);
		expect(saved.body).toEqual({ ...ALL_OFF, email_all: true, email_comments: true });
		// What is stored now can be read: every switch, as the page showed them, with the two turned on.
		expect(JSON.parse(storedFor(user)!)).toEqual({ ...ALL_OFF, email_all: true, email_comments: true });
		expect((await api('GET', '/api/account/notifications', { user })).body).toEqual({ ...ALL_OFF, email_all: true, email_comments: true });
	});

	it('answers and saves as it did for preferences that can be read', async () => {
		const user = makeUser({ username: 'ann' });
		db.update(users).set({ notificationPrefs: '{"email_all":false}' }).where(eq(users.id, user.id)).run();

		expect((await api('GET', '/api/account/notifications', { user })).body).toEqual({ ...DEFAULTS, email_all: false });
		const saved = await api('PUT', '/api/account/notifications', { user, body: { email_planning: false } });
		expect(saved.body).toEqual({ ...DEFAULTS, email_all: false, email_planning: false });
		expect(JSON.parse(storedFor(user)!)).toEqual({ email_all: false, email_planning: false });
	});

	// Card 2724: every kind of mail a person can switch off is off for preferences
	// that cannot be read. Each mail asks through shouldNotifyUser, directly or
	// through filterRecipientsByPref, which the test below holds of the source.
	it('sends no kind of mail that can be switched off to a user whose preferences cannot be read', () => {
		const user = makeUser({ username: 'ann' });
		const control = makeUser({ username: 'bob' });
		db.update(users).set({ notificationPrefs: '{not json' }).where(eq(users.id, user.id)).run();

		for (const { key } of NOTIFICATION_PREFS) {
			expect(shouldNotifyUser(user.id, key), key).toBe(false);
			expect(shouldNotifyUser(control.id, key), key).toBe(true);
		}
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
