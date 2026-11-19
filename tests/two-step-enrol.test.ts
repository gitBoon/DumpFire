/**
 * Setting up two-step sign-in (card 2769, slice 3, T48-T61): an account that
 * holds no second factor is taken from its right password, an invite or the
 * first-run set-up to `/login/enrol`, where it scans a QR code, types its
 * first code, is shown ten recovery codes and confirms; only then is a factor
 * written and a session made.
 *
 * The cases that take the password path seed what lets an account set up on
 * its password alone once the release-day rules are in place (slice 4,
 * decision 8): `mfa_password_enrol = 1`, the release window open and no mail
 * host set up (I3). The one case that mails sets the host up after the
 * password step, which is where mail is looked at.
 *
 * Slice 4 (T62-T77): the release-day rules of decision 8, the release mail
 * (decision 23), set-up links and their page (decisions 19, 20), and the
 * admin load's `passwordSetUpUntil` (decision 25).
 *
 * Against the application's own in-memory database, emptied before each test.
 * The form actions and the page's load are called directly; the link page,
 * whose answer is its cookie, through the gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ dev: false, building: false, browser: false, version: 'test' }));

/** No MFA key loaded, while `none` is set (T60). */
const keyStub = vi.hoisted(() => ({ none: false }));
vi.mock('$lib/server/mfa-key', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/mfa-key')>();
	return { ...real, currentMfaKey: () => (keyStub.none ? null : real.currentMfaKey()) };
});

/** How many password hashes were made (T60). */
const hashes = vi.hoisted(() => ({ made: 0 }));
vi.mock('$lib/server/passwords', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/passwords')>();
	return {
		...real,
		makePasswordHash: (...args: Parameters<typeof real.makePasswordHash>) => {
			hashes.made++;
			return real.makePasswordHash(...args);
		}
	};
});

import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { enrolmentLinks, inviteTokens, mfaFactors, mfaRecoveryCodes, sessions, settings, users, webhooks } from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import { SESSION_COOKIE_NAME } from '$lib/server/auth';
import { PLACEHOLDER_ORIGIN } from '$lib/server/email';
import { knownBrowserCookie } from '$lib/server/known-browsers';
import { issueEnrolmentLink, resetTwoStep, usableEnrolmentLink } from '$lib/server/mfa-store';
import { switchOffOutside } from '$lib/server/db/restore';
import { issueInvite } from '$lib/server/invites';
import { resetKnownBrowserSecretCache } from '$lib/server/known-browsers';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { subscribeToLogs, type LogEntry } from '$lib/server/logger';
import { stepAt } from '$lib/server/totp';
import { CHALLENGE_COOKIE, ENROL_LINK_COOKIE, tokenHashOf, type ChallengeRow } from '$lib/server/sign-in-challenges';
import {
	COULD_NOT_EMAIL,
	ENROL_CANNOT_FINISH,
	ENROL_NOT_READY,
	ENROL_WRONG_CODE,
	LINK_DEAD,
	FACTOR_UNUSABLE,
	LINK_EMAILED,
	NEEDS_LINK,
	NO_MFA_KEY,
	SET_UP_UNDER_WAY,
	SIGN_IN_EXPIRED,
	SIGN_OUT_FIRST,
	STEP_SPENT,
	TOO_MANY_WRONG_CODES,
	linkAlreadyEmailed
} from '$lib/server/second-step';
import { parseStamp, stamp } from '$lib/timestamps';
import { action, pageLoad, type ActionResult } from './helpers/actions';
import { api } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { FIXTURE_PASSWORD_HASH, makeApiKey, makeBoard, makeSession, makeSmtp, makeUser, resetDb, stepUp, sessionHashOf } from './helpers/fixtures';
import { gate } from './helpers/gate';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';
import { codeFor, giveFactor, openReleaseWindow, passwordStep, verify, wrongCodeFor } from './helpers/two-step';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The secret the set-up page shows, in groups of four, as bytes. */
function secretOf(groups: string): Buffer {
	let buffer = 0;
	let bits = 0;
	const out: number[] = [];
	for (const char of groups.replace(/ /g, '')) {
		buffer = (buffer << 5) | BASE32.indexOf(char);
		bits += 5;
		if (bits >= 8) {
			out.push((buffer >>> (bits - 8)) & 255);
			bits -= 8;
		}
		buffer &= (1 << bits) - 1;
	}
	return Buffer.from(out);
}

let user: ReturnType<typeof makeUser>;
let sent: Effects;

const userRow = (id = user.id) => db.select().from(users).where(eq(users.id, id)).get()!;
const challenges = () => sqlite.prepare('SELECT * FROM sign_in_challenges ORDER BY rowid').all() as ChallengeRow[];
const holding = (token: string) => ({ cookie: `${CHALLENGE_COOKIE}=${token}` });

/** The set-up page as the browser holding `token` sees it. */
const view = (token: string) => pageLoad('/login/enrol', { headers: holding(token) });

/** One of the set-up page's two actions, from the browser holding `token`. */
const enrol = (token: string, name: 'code' | 'confirm', form: Record<string, string> = {}): Promise<ActionResult> =>
	action('/login/enrol', { name, form, cookies: { [CHALLENGE_COOKIE]: token } });

/** Allowed to set up on its password alone: the flag, inside the window, and no mail host (I3). */
const mayEnrolOnPassword = (id: number) => db.update(users).set({ mfaPasswordEnrol: 1 }).where(eq(users.id, id)).run();

/** The right password, with any cookies the browser holds (a set-up link's), and the challenge it opened. */
async function startEnrolment(account = user, cookies?: Record<string, string>): Promise<string> {
	const { res, challenge } = await passwordStep(account, { cookies });
	expect(res, JSON.stringify(res)).toMatchObject({ type: 'redirect', status: 303, location: '/login/enrol' });
	return challenge!;
}

/** Through the first code: the challenge, and the secret its page showed. */
async function pastFirstCode(account = user, cookies?: Record<string, string>): Promise<{ token: string; secret: Buffer }> {
	const token = await startEnrolment(account, cookies);
	const page = await view(token);
	const secret = secretOf(page.type === 'data' ? page.data.secret : '');
	expect(await enrol(token, 'code', { code: codeFor(secret) })).toMatchObject({ type: 'redirect', status: 303, location: '/login/enrol' });
	return { token, secret };
}

/** Through to the recovery codes: the challenge, the secret, and the ten codes. */
async function atCodesShown(account = user, cookies?: Record<string, string>): Promise<{ token: string; secret: Buffer; codes: string[] }> {
	const { token, secret } = await pastFirstCode(account, cookies);
	const page = await view(token);
	expect(page).toMatchObject({ type: 'data', data: { stage: 'codes_shown' } });
	return { token, secret, codes: page.type === 'data' ? page.data.codes : [] };
}

/** Every log entry written while `fn` runs, with LOG_LEVEL at INFO, and none printed. */
async function logged<T>(fn: () => Promise<T>): Promise<{ result: T; lines: LogEntry[] }> {
	const level = process.env.LOG_LEVEL;
	process.env.LOG_LEVEL = 'INFO';
	const quiet = (['log', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
	const lines: LogEntry[] = [];
	const stop = subscribeToLogs((entry) => lines.push(entry));
	try {
		return { result: await fn(), lines };
	} finally {
		stop();
		for (const spy of quiet) spy.mockRestore();
		if (level === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = level;
	}
}

beforeEach(() => {
	resetDb();
	resetKnownBrowserSecretCache();
	resetAllRateLimits();
	// A frozen clock, so that a code and its check fall in one step; timers run as ever.
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date());
	openReleaseWindow();
	user = makeUser();
	mayEnrolOnPassword(user.id);
	keyStub.none = false;
	hashes.made = 0;
	sent = effects();
});

afterEach(() => {
	sent.restore();
	vi.useRealTimers();
	vi.restoreAllMocks();
	keyStub.none = false;
	resetAllRateLimits();
	resetKnownBrowserSecretCache();
});

describe('setting up on the password (slice 3)', () => {
	it('T48: the right password at an account with no factor opens a set-up challenge; the page shows the QR code, the secret and the account; no session', async () => {
		const token = await startEnrolment();

		const rows = challenges();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			token_hash: tokenHashOf(token),
			user_id: user.id,
			purpose: 'enrol',
			stage: 'secret_shown',
			enrol_grant: 'password',
			enrolment_link_hash: null,
			password_hash: FIXTURE_PASSWORD_HASH
		});
		expect(rows[0].key_id).toBeTruthy();
		expect(rows[0].enrol_ciphertext).toBeTruthy();

		const page = await view(token);
		expect(page).toMatchObject({
			type: 'data',
			data: { stage: 'secret_shown', username: user.username, issuer: 'DumpFire', qr: expect.stringMatching(/^data:image\/svg\+xml;base64,/) }
		});
		const shown = page.type === 'data' ? page.data.secret : '';
		expect(shown).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
		// The secret is not in the row as it is shown.
		expect(JSON.stringify(rows)).not.toContain(shown.replace(/ /g, ''));

		expect(db.select().from(sessions).all()).toEqual([]);
	});

	it('T49: the right first code moves to the codes; the page then shows ten, and a reload the same ten', async () => {
		const { token } = await pastFirstCode();
		expect(challenges()[0].stage).toBe('code_verified');

		const first = await view(token);
		expect(challenges()[0].stage).toBe('codes_shown');
		const codes = first.type === 'data' ? first.data.codes : [];
		expect(codes).toHaveLength(10);
		for (const code of codes) expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

		expect(await view(token)).toEqual(first);
	});

	it.each([
		['confirm', 'secret_shown'],
		['confirm', 'code_verified'],
		['code', 'codes_shown']
	] as const)('T50: %s at %s is 409, and nothing is written', async (name, stage) => {
		let token: string;
		let secret: Buffer | null = null;
		if (stage === 'secret_shown') token = await startEnrolment();
		else if (stage === 'code_verified') ({ token, secret } = await pastFirstCode());
		else ({ token, secret } = await atCodesShown());
		expect(challenges()[0].stage).toBe(stage);
		vi.setSystemTime(Date.now() + 30_000);
		const before = snapshotDb();

		const res = await enrol(token, name, secret === null ? {} : { code: codeFor(secret) });

		expect(res).toMatchObject({ type: 'failure', status: 409, data: { error: ENROL_NOT_READY, restart: false } });
		expectUnchanged(before);
	});

	it('T51: a wrong first code is 400, counted on the challenge alone', async () => {
		const token = await startEnrolment();
		const page = await view(token);
		const secret = secretOf(page.type === 'data' ? page.data.secret : '');

		const res = await enrol(token, 'code', { code: wrongCodeFor(secret) });

		expect(res).toMatchObject({ type: 'failure', status: 400, data: { error: ENROL_WRONG_CODE, restart: false } });
		expect(challenges()[0]).toMatchObject({ stage: 'secret_shown', wrong_count: 1 });
		expect(userRow()).toMatchObject({ mfaOtherWrong: 0, mfaKnownWrong: 0, failedCodesSinceSignIn: 0 });
	});

	it('T52: the fifth wrong first code ends the challenge', async () => {
		const token = await startEnrolment();
		const page = await view(token);
		const secret = secretOf(page.type === 'data' ? page.data.secret : '');

		const answers: ActionResult[] = [];
		for (let i = 0; i < 5; i++) answers.push(await enrol(token, 'code', { code: wrongCodeFor(secret) }));

		expect(answers.slice(0, 4).map((res) => res.type === 'failure' && res.data.error)).toEqual(Array(4).fill(ENROL_WRONG_CODE));
		expect(answers[4]).toMatchObject({ type: 'failure', status: 400, data: { error: TOO_MANY_WRONG_CODES, restart: true } });
		expect(answers[4].deletedCookies).toContain(CHALLENGE_COOKIE);
		expect(challenges()).toEqual([]);
	});

	it('T53: confirm writes the factor with its first step spent and ten codes, clears the flag, ends the rest, and signs in', async () => {
		const { token, secret } = await atCodesShown();
		// Another browser's pending sign-in, a set-up link and an invite, each of which the set-up ends.
		// The link is the release mail's: any other closes setting up on the password (CS4).
		sqlite
			.prepare(
				'INSERT INTO sign_in_challenges (token_hash, short_id, user_id, purpose, stage, lane, password_hash, created_at, expires_at) ' +
					"VALUES (?, 'other001', ?, 'verify', NULL, 'other', ?, datetime('now'), datetime('now', '+10 minutes'))"
			)
			.run('f'.repeat(64), user.id, FIXTURE_PASSWORD_HASH);
		inTransaction(() => {
			issueEnrolmentLink(user.id, 'release-mail');
			issueInvite(user.id);
		});

		const { result: res, lines } = await logged(() => enrol(token, 'confirm'));

		expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/' });
		const factors = db.select().from(mfaFactors).where(eq(mfaFactors.userId, user.id)).all();
		expect(factors).toHaveLength(1);
		expect(factors[0]).toMatchObject({ label: 'Authenticator', kind: 'totp', lastStep: stepAt(Date.now()) });
		expect(db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, user.id)).all()).toHaveLength(10);
		expect(userRow().mfaPasswordEnrol).toBe(0);
		expect(challenges()).toEqual([]);
		expect(db.select().from(enrolmentLinks).all()).toEqual([]);
		expect(db.select().from(inviteTokens).all()).toEqual([]);

		const session = res.cookies[SESSION_COOKIE_NAME].value;
		expect(db.select().from(sessions).where(eq(sessions.tokenHash, sessionHashOf(session))).get()).toMatchObject({ userId: user.id, twoStep: 1 });
		expect(res.cookies[knownBrowserCookie(user.id)]).toBeDefined();
		expect(res.deletedCookies).toContain(CHALLENGE_COOKIE);
		// The two lines of the set-up itself (beside the session's own).
		const said = lines.filter((line) => line.level === 'INFO' && !line.message.startsWith('Session created')).map((line) => line.message);
		expect(said).toEqual([
			`Two-step sign-in set up for "${user.username}" (user ${user.id}) (password)`,
			`User "${user.username}" logged in`
		]);

		// The first code's step is spent: the same code at the code page, within its step, is refused.
		const again = await passwordStep(user);
		expect(again.res).toMatchObject({ type: 'redirect', location: '/login/verify' });
		expect(await verify(again.challenge, { code: codeFor(secret) })).toMatchObject({ type: 'failure', status: 400, data: { error: STEP_SPENT } });
	});

	it('T54: a factor added before confirm: 409, the set-up can no longer be finished, and nothing is written', async () => {
		const { token } = await atCodesShown();
		db.insert(mfaFactors)
			.values({ factorUid: 'a'.repeat(32), userId: user.id, kind: 'totp', label: 'Elsewhere', keyId: 'k', secretCiphertext: 'c', secretNonce: 'n' })
			.run();
		const before = snapshotDb();

		const res = await enrol(token, 'confirm');

		expect(res).toMatchObject({ type: 'failure', status: 409, data: { error: ENROL_CANNOT_FINISH, restart: true } });
		expect(res.cookies[SESSION_COOKIE_NAME]).toBeUndefined();
		expectUnchanged(before);
	});

	it('T55: the password changed during the set-up: confirm is 409, and nothing is written', async () => {
		const { token } = await atCodesShown();
		db.update(users).set({ passwordHash: '$2b$04$another.hash.set.while.the.set.up.was.open.xxxxxxxxxxxx' }).where(eq(users.id, user.id)).run();
		const before = snapshotDb();

		const res = await enrol(token, 'confirm');

		expect(res).toMatchObject({ type: 'failure', status: 409, data: { error: ENROL_CANNOT_FINISH, restart: true } });
		expect(res.deletedCookies).toContain(CHALLENGE_COOKIE);
		expectUnchanged(before);
	});

	it('T56: a second set-up challenge replaces the first', async () => {
		await startEnrolment();
		const second = await startEnrolment();

		expect(challenges().map((row) => row.token_hash)).toEqual([tokenHashOf(second)]);
	});
});

describe('setting up after an invite or the first-run set-up (slice 3)', () => {
	const PASSWORD = 'a new password';

	it('T57: an invite sets the password and opens a set-up challenge, signing nobody in; confirm signs in', async () => {
		const invite = inTransaction(() => issueInvite(user.id));

		const res = await action(`/invite/${invite}`, { form: { password: PASSWORD, confirmPassword: PASSWORD } });

		expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/login/enrol' });
		expect(userRow().passwordHash).not.toBe(FIXTURE_PASSWORD_HASH);
		expect(res.cookies[SESSION_COOKIE_NAME]).toBeUndefined();
		expect(res.cookies[knownBrowserCookie(user.id)]).toBeUndefined();
		expect(db.select().from(sessions).all()).toEqual([]);
		const token = res.cookies[CHALLENGE_COOKIE].value;
		expect(challenges()).toEqual([
			expect.objectContaining({ token_hash: tokenHashOf(token), user_id: user.id, purpose: 'enrol', stage: 'secret_shown', enrol_grant: 'invite' })
		]);

		const page = await view(token);
		const secret = secretOf(page.type === 'data' ? page.data.secret : '');
		await enrol(token, 'code', { code: codeFor(secret) });
		await view(token);
		const done = await enrol(token, 'confirm');
		expect(done).toMatchObject({ type: 'redirect', location: '/' });
		expect(db.select().from(sessions).where(eq(sessions.tokenHash, sessionHashOf(done.cookies[SESSION_COOKIE_NAME].value))).get()).toMatchObject({
			userId: user.id,
			twoStep: 1
		});
	});

	it('T58: the first-run set-up makes the superadmin, without leave to set up on the password, and opens a set-up challenge; no session', async () => {
		resetDb();

		const res = await action('/setup', { form: { username: 'first', email: 'first@example.test', password: PASSWORD, confirmPassword: PASSWORD } });

		expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/login/enrol' });
		const made = db.select().from(users).all();
		expect(made).toEqual([expect.objectContaining({ username: 'first', role: 'superadmin', mfaPasswordEnrol: 0 })]);
		expect(challenges()).toEqual([expect.objectContaining({ user_id: made[0].id, purpose: 'enrol', stage: 'secret_shown', enrol_grant: 'setup' })]);
		expect(res.cookies[CHALLENGE_COOKIE]).toBeDefined();
		expect(res.cookies[SESSION_COOKIE_NAME]).toBeUndefined();
		expect(db.select().from(sessions).all()).toEqual([]);
	});

	it('the first-run set-up logs the superadmin it makes once, and no address (card 2905)', async () => {
		resetDb();

		const { result: res } = await logged(() =>
			action('/setup', { form: { username: 'first', email: 'first@example.test', password: PASSWORD, confirmPassword: PASSWORD } })
		);

		expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/login/enrol' });
		const made = db.select().from(users).get()!;
		expect(sqlite.prepare("SELECT level, context, message, meta, user_id AS userId FROM system_logs WHERE message LIKE 'Account %'").all()).toEqual([
			{
				level: 'INFO',
				context: 'AUTH',
				message: `Account ${made.id} ("first") made by the first-run set-up as the superadmin; two-step sign-in is set up next`,
				meta: JSON.stringify({ accountId: made.id, role: 'superadmin', firstSignIn: 'setup' }),
				userId: made.id
			}
		]);
		expect(JSON.stringify(sqlite.prepare('SELECT message, meta FROM system_logs').all())).not.toContain('first@example.test');
	});

	it('T59: with mail set up, a set-up mails one notice naming the time, the address, the keys and the webhooks, and no secret, code or link', async () => {
		// The reset first: it ends the keys and webhooks the account had (card 2915), and the set-up's notice
		// names those it has when it is set up.
		const link = resetByAdmin();
		makeApiKey(user, 'Deploy key');
		const { board } = makeBoard({ owner: user, name: 'Ops' });
		db.insert(webhooks).values({ boardId: board.id, url: 'https://hooks.example.test/in/its-own-secret', setBy: user.id }).run();
		// On a set-up link, which a mail host set up meanwhile does not end (a
		// set-up on the password alone it does: CS6).
		const token = await startEnrolment(user, { [ENROL_LINK_COOKIE]: link });
		makeSmtp();
		const page = await view(token);
		const shown = page.type === 'data' ? page.data.secret : '';
		const code = codeFor(secretOf(shown));
		await enrol(token, 'code', { code });
		const codesPage = await view(token);
		const codes: string[] = codesPage.type === 'data' ? codesPage.data.codes : [];

		await enrol(token, 'confirm');
		await sent.settle();

		expect(sent.emails.map((mail) => ({ to: mail.to, subject: mail.subject }))).toEqual([
			{ to: user.email, subject: 'Two-step sign-in was set up for your DumpFire account' }
		]);
		const html = sent.emails[0].html;
		expect(html).toContain(new Date().toUTCString());
		expect(html).toContain('127.0.0.1');
		expect(html).toContain('Deploy key');
		expect(html).toContain('Ops');
		expect(html).toContain('hooks.example.test');
		expect(html).not.toContain('its-own-secret');
		for (const secret of [shown, shown.replace(/ /g, ''), code, ...codes]) expect(html).not.toContain(secret);
		expect(html).not.toContain('href');
		expect(html).not.toContain(token);
	});

	it('T60: with no MFA key, an invite is refused 503 before any password hash is made, and nothing is written', async () => {
		const invite = inTransaction(() => issueInvite(user.id));
		keyStub.none = true;
		const before = snapshotDb();

		const res = await action(`/invite/${invite}`, { form: { password: PASSWORD, confirmPassword: PASSWORD } });

		expect(res).toMatchObject({ type: 'failure', status: 503, data: { error: NO_MFA_KEY } });
		expect(hashes.made).toBe(0);
		expectUnchanged(before);
	});

	it('T61: a set-up secret that will not open at the first code: 503 with the same words, and nothing counted', async () => {
		const token = await startEnrolment();
		const page = await view(token);
		const secret = secretOf(page.type === 'data' ? page.data.secret : '');
		sqlite.prepare('UPDATE sign_in_challenges SET enrol_nonce = ?').run(Buffer.alloc(12, 7).toString('base64'));

		const res = await enrol(token, 'code', { code: codeFor(secret) });

		expect(res).toMatchObject({ type: 'failure', status: 503, data: { error: NO_MFA_KEY } });
		expect(challenges()[0]).toMatchObject({ stage: 'secret_shown', wrong_count: 0 });
	});
});

// ─── Slice 4: the release-day rules, the release mail and set-up links ──────

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** The App URL a release mail's link is made from. */
const BASE = 'https://dumpfire.example.test';

/** A mail host set up, and a real address to make a link from. */
function mailReady(): void {
	makeSmtp();
	db.insert(settings).values({ key: 'app_url', value: BASE }).run();
}

const links = () => db.select().from(enrolmentLinks).all();

/** An administrator's reset of the account's two-step sign-in, and the token of the link it issued. */
const resetByAdmin = (account = user): string =>
	inTransaction(() => resetTwoStep(account.id, 'admin-reset', { cause: { log: 'a test', mail: 'a test' } })).token;

/** The link cookie a gate answer set, as its `Set-Cookie` line, if any. */
const linkCookieSet = (res: Response) => res.headers.getSetCookie().find((cookie) => cookie.startsWith(`${ENROL_LINK_COOKIE}=`));

describe('the release-day rules and the release mail (slice 4)', () => {
	it('T62: flag 1 and mail set up: one release-mail link, mailed to the account with the time and address of the sign-in; a notice, and no challenge', async () => {
		mailReady();

		const { res } = await passwordStep(user);
		await sent.settle();

		expect(res).toMatchObject({ type: 'success', status: 200, data: { notice: LINK_EMAILED, identity: user.username } });
		expect(res.cookies[CHALLENGE_COOKIE]).toBeUndefined();
		expect(challenges()).toEqual([]);
		expect(db.select().from(sessions).all()).toEqual([]);
		const issued = links();
		expect(issued).toEqual([expect.objectContaining({ userId: user.id, issuedBy: 'release-mail' })]);

		expect(sent.emails.map((mail) => mail.to)).toEqual([user.email]);
		const html = sent.emails[0].html;
		const token = /href="https:\/\/dumpfire\.example\.test\/enrol\/([A-Za-z0-9_-]+)"/.exec(html)?.[1];
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(tokenHashOf(token!)).toBe(issued[0].tokenHash);
		expect(html).toContain(new Date().toUTCString());
		expect(html).toContain('127.0.0.1');
		expect(html).toContain('If this was not you, your password is known to someone else');
	});

	it('T63: a second right password while that link is under a day old: no new link, no mail, and the words say when it went', async () => {
		mailReady();
		await passwordStep(user);
		await sent.settle();
		const first = links();
		vi.setSystemTime(Date.now() + 3 * HOUR);

		const { res } = await passwordStep(user);
		await sent.settle();

		const next = new Date(parseStamp(first[0].createdAt)!.getTime() + DAY);
		expect(res).toMatchObject({ type: 'success', status: 200, data: { notice: linkAlreadyEmailed(3, next), identity: user.username } });
		expect(links()).toEqual(first);
		expect(sent.emails).toHaveLength(1);
		expect(challenges()).toEqual([]);
	});

	it('T64: the release mail is refused: 503, a WARN, and no link is left', async () => {
		mailReady();
		sent.restore();
		sent = effects({ refuseMailTo: [user.email] });

		const { result, lines } = await logged(() => passwordStep(user));

		expect(result.res).toMatchObject({ type: 'failure', status: 503, data: { error: COULD_NOT_EMAIL } });
		expect(lines.filter((line) => line.level === 'WARN' && line.message.includes('no second step: could not email'))).toHaveLength(1);
		expect(links()).toEqual([]);
		expect(challenges()).toEqual([]);
	});

	it('T65: a mail host whose password is missing: 503, and no link', async () => {
		mailReady();
		db.insert(settings).values({ key: 'smtp_user', value: 'dumpfire' }).run();

		const { res } = await passwordStep(user);
		await sent.settle();

		expect(res).toMatchObject({ type: 'failure', status: 503, data: { error: COULD_NOT_EMAIL } });
		expect(links()).toEqual([]);
		expect(challenges()).toEqual([]);
		expect(sent.emails).toEqual([]);
	});

	it('T66: a link address that is the image’s placeholder: 503, and no link', async () => {
		makeSmtp();
		db.insert(settings).values({ key: 'app_url', value: PLACEHOLDER_ORIGIN }).run();

		const { res } = await passwordStep(user);
		await sent.settle();

		expect(res).toMatchObject({ type: 'failure', status: 503, data: { error: COULD_NOT_EMAIL } });
		expect(links()).toEqual([]);
		expect(challenges()).toEqual([]);
		expect(sent.emails).toEqual([]);
	});

	it('T67: flag 0, with mail set up: 403 needs a set-up link, and nothing is issued or mailed', async () => {
		db.update(users).set({ mfaPasswordEnrol: 0 }).where(eq(users.id, user.id)).run();
		mailReady();
		const before = snapshotDb();

		const { res } = await passwordStep(user);
		await sent.settle();

		expect(res).toMatchObject({ type: 'failure', status: 403, data: { error: NEEDS_LINK } });
		expect(res.cookies).toEqual({});
		expectUnchanged(before);
		expect(sent.emails).toEqual([]);
	});

	it.each([
		[13, 'sets up on its password'],
		[15, 'needs a set-up link']
	] as const)('T68: flag 1 and no mail host, day %i after the release: %s', async (days, _said) => {
		openReleaseWindow(new Date(Date.now() - days * DAY));

		const { res } = await passwordStep(user);

		if (days === 13) {
			expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/login/enrol' });
			expect(challenges()).toEqual([expect.objectContaining({ user_id: user.id, purpose: 'enrol', enrol_grant: 'password' })]);
		} else {
			expect(res).toMatchObject({ type: 'failure', status: 403, data: { error: NEEDS_LINK } });
			expect(challenges()).toEqual([]);
		}
	});

	it('T73: an administrator’s two-step reset and then password reset, no mail: still needs a set-up link', async () => {
		const admin = makeUser({ role: 'admin' });
		resetByAdmin();
		const PASSWORD = 'a password the administrator set';
		expect((await api('PUT', `/api/users/${user.id}/password`, stepUp(admin, { password: PASSWORD }))).status).toBe(200);

		const { res } = await passwordStep(user, { password: PASSWORD });

		expect(res).toMatchObject({ type: 'failure', status: 403, data: { error: NEEDS_LINK } });
		expect(challenges()).toEqual([]);
	});
});

describe('set-up links and their page (slice 4)', () => {
	it('T69: the link page names the account and leaves the link cookie; the right password then opens a link set-up, the link kept and the cookie deleted', async () => {
		const token = resetByAdmin();

		const page = await gate('GET', `/enrol/${token}`, { headers: { accept: 'text/html' } });
		const html = await page.text();

		expect(page.status).toBe(200);
		expect(html).toContain('This link sets up two-step sign-in for');
		expect(html).toContain(user.username);
		const set = linkCookieSet(page);
		expect(set).toBeDefined();
		const parts = set!.split(';').map((part) => part.trim().toLowerCase());
		expect(set!.split(';')[0]).toBe(`${ENROL_LINK_COOKIE}=${token}`);
		expect(parts).toEqual(expect.arrayContaining(['httponly', 'samesite=strict', 'path=/login', 'max-age=3600']));

		const { res, challenge } = await passwordStep(user, { cookies: { [ENROL_LINK_COOKIE]: token } });

		expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/login/enrol' });
		expect(challenges()).toEqual([
			expect.objectContaining({ token_hash: tokenHashOf(challenge!), purpose: 'enrol', enrol_grant: 'link', enrolment_link_hash: tokenHashOf(token) })
		]);
		expect(links()).toEqual([expect.objectContaining({ tokenHash: tokenHashOf(token) })]);
		expect(res.deletedCookies).toContain(ENROL_LINK_COOKIE);
	}, 60_000);

	it.each(['unknown', 'expired'] as const)('T70: an %s link: the dead-link words, and no cookie', async (kind) => {
		let token = 'x'.repeat(43);
		if (kind === 'expired') {
			token = resetByAdmin();
			db.update(enrolmentLinks).set({ expiresAt: stamp(new Date(Date.now() - 1000)) }).run();
		}

		const page = await gate('GET', `/enrol/${token}`, { headers: { accept: 'text/html' } });

		expect(page.status).toBe(200);
		expect(await page.text()).toContain(LINK_DEAD);
		expect(linkCookieSet(page)).toBeUndefined();
	}, 60_000);

	it('T71: a link cookie of another account is ignored: 403 needs a set-up link', async () => {
		db.update(users).set({ mfaPasswordEnrol: 0 }).where(eq(users.id, user.id)).run();
		const other = makeUser();
		const token = resetByAdmin(other);

		const { res } = await passwordStep(user, { cookies: { [ENROL_LINK_COOKIE]: token } });

		expect(res).toMatchObject({ type: 'failure', status: 403, data: { error: NEEDS_LINK } });
		expect(challenges()).toEqual([]);
		expect(links()).toEqual([expect.objectContaining({ userId: other.id })]);
	});

	it('T72: the link expires between the challenge and confirm: 409, and nothing is written', async () => {
		const link = resetByAdmin();
		const { token } = await atCodesShown(user, { [ENROL_LINK_COOKIE]: link });
		db.update(enrolmentLinks).set({ expiresAt: stamp(new Date(Date.now() - 1000)) }).run();
		const before = snapshotDb();

		const res = await enrol(token, 'confirm');

		expect(res).toMatchObject({ type: 'failure', status: 409, data: { error: ENROL_CANNOT_FINISH, restart: true } });
		expect(res.cookies[SESSION_COOKIE_NAME]).toBeUndefined();
		expectUnchanged(before);
	});

	it('T74: signed in, the link page says to sign out first, and leaves no cookie', async () => {
		const token = resetByAdmin(makeUser());

		const page = await gate('GET', `/enrol/${token}`, {
			headers: { accept: 'text/html', cookie: `${SESSION_COOKIE_NAME}=${makeSession(user)}` }
		});

		expect(page.status).toBe(200);
		expect(await page.text()).toContain(SIGN_OUT_FIRST);
		expect(linkCookieSet(page)).toBeUndefined();
	}, 60_000);

	it('T77: an account reset by an administrator with wrong codes since its last sign-in sets up through a link and is shown the report', async () => {
		giveFactor(user);
		db.update(users).set({ failedCodesSinceSignIn: 3 }).where(eq(users.id, user.id)).run();
		const link = resetByAdmin();
		const { token } = await atCodesShown(user, { [ENROL_LINK_COOKIE]: link });

		const res = await enrol(token, 'confirm');

		expect(res).toMatchObject({ type: 'success', status: 200, data: { signedIn: true, report: { wrongCodes: 3, banner: null } } });
		expect(db.select().from(sessions).where(eq(sessions.tokenHash, sessionHashOf(res.cookies[SESSION_COOKIE_NAME].value))).get()).toMatchObject({
			userId: user.id,
			twoStep: 1
		});
		expect(userRow().failedCodesSinceSignIn).toBe(0);
		expect(links()).toEqual([]);
	});
});

describe('the admin load’s password set-up date (slice 4)', () => {
	it('T75: gives passwordSetUpUntil, 14 days after the release, for a flag-1 account with no factor; null after the window, for flag 0 and for an enrolled account', async () => {
		const released = new Date(Date.now() - DAY);
		openReleaseWindow(released);
		const admin = makeUser({ role: 'admin' });
		const flagZero = makeUser();
		const enrolled = makeUser();
		mayEnrolOnPassword(enrolled.id);
		giveFactor(enrolled);
		const until = async () => {
			const page = await pageLoad('/admin', { user: admin });
			const listed = (page as { data: { users: { id: number; passwordSetUpUntil: string | null }[] } }).data.users;
			return Object.fromEntries([user, flagZero, enrolled].map((account) => [account.id, listed.find((row) => row.id === account.id)!.passwordSetUpUntil]));
		};

		expect(await until()).toEqual({ [user.id]: stamp(new Date(released.getTime() + 14 * DAY)), [flagZero.id]: null, [enrolled.id]: null });

		vi.setSystemTime(released.getTime() + 14 * DAY + 1000);
		expect(await until()).toEqual({ [user.id]: null, [flagZero.id]: null, [enrolled.id]: null });
	});
});

// ─── The fix pass of the card's two reviews (T87 on) ────────────────────────

/** A form as a browser without JavaScript posts it. */
const NATIVE_FORM = { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', accept: 'text/html' };

/** The link a release mail held, by its token. */
const mailedToken = (mail: { html: string }) => /href="https:\/\/dumpfire\.example\.test\/enrol\/([A-Za-z0-9_-]+)"/.exec(mail.html)![1];

describe('the review fixes: the set-up page and the password step', () => {
	it('T87: posted without JavaScript, confirm shows the report, and a code posted after it the restart words and no form', async () => {
		db.update(users).set({ failedCodesSinceSignIn: 2 }).where(eq(users.id, user.id)).run();
		const { token } = await atCodesShown();
		const cookie = `${CHALLENGE_COOKIE}=${token}`;

		const done = await gate('POST', '/login/enrol?/confirm', { headers: { ...NATIVE_FORM, cookie }, body: '' });
		const html = await done.text();
		expect(done.status).toBe(200);
		expect(done.headers.getSetCookie().some((set) => set.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
		expect(html).toContain('You are signed in');
		expect(html).toContain('2 wrong codes were entered for your account');

		const again = await gate('POST', '/login/enrol?/code', { headers: { ...NATIVE_FORM, cookie }, body: 'code=123456' });
		const againHtml = await again.text();
		expect(again.status).toBe(400);
		expect(againHtml).toContain(SIGN_IN_EXPIRED);
		expect(againHtml).toMatch(/<a href="\/login"[^>]*>Sign in again<\/a>/);
		expect(againHtml).not.toContain('<form');
	}, 60_000);

	it('T88: with no MFA key, an enrolled account is still sent to its second step: a code is 503, and a recovery code signs in', async () => {
		const factor = giveFactor(user);
		keyStub.none = true;

		const { res, challenge } = await passwordStep(user);

		expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/login/verify' });
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await verify(challenge, { code: codeFor(factor.secret) })).toMatchObject({ type: 'failure', status: 503, data: { error: FACTOR_UNUSABLE } });
		quiet.mockRestore();
		const signedIn = await verify(challenge, { recoveryCode: factor.recoveryCodes[0] });
		expect(signedIn.cookies[SESSION_COOKIE_NAME]).toBeDefined();
	});

	it('T89: with no MFA key, a right password at an account that would set up is 503, and nothing is written', async () => {
		keyStub.none = true;
		const before = snapshotDb();

		const { res } = await passwordStep(user);

		expect(res).toMatchObject({ type: 'failure', status: 503, data: { error: NO_MFA_KEY } });
		expectUnchanged(before);
	});

	it('T90: with no MFA key, the first-run set-up is 503 before any password hash is made, and makes nobody', async () => {
		resetDb();
		keyStub.none = true;

		const res = await action('/setup', { form: { username: 'first', email: 'first@example.test', password: 'a new password', confirmPassword: 'a new password' } });

		expect(res).toMatchObject({ type: 'failure', status: 503, data: { error: NO_MFA_KEY } });
		expect(hashes.made).toBe(0);
		expect(db.select().from(users).all()).toEqual([]);
	});

	it('T91: a mail host and no address to make a link from: 503, and no link (decision 8(d))', async () => {
		const env = { APP_URL: process.env.APP_URL, ORIGIN: process.env.ORIGIN };
		delete process.env.APP_URL;
		delete process.env.ORIGIN;
		try {
			makeSmtp();

			const { res } = await passwordStep(user);
			await sent.settle();

			expect(res).toMatchObject({ type: 'failure', status: 503, data: { error: COULD_NOT_EMAIL } });
			expect(links()).toEqual([]);
			expect(sent.emails).toEqual([]);
		} finally {
			for (const [name, value] of Object.entries(env)) if (value !== undefined) process.env[name] = value;
		}
	});

	it('T92: a right password once the release-mail link is over a day old: a new link is mailed, and the old one goes', async () => {
		mailReady();
		await passwordStep(user);
		await sent.settle();
		const first = links();
		vi.setSystemTime(Date.now() + 25 * HOUR);

		const { res } = await passwordStep(user);
		await sent.settle();

		expect(res).toMatchObject({ type: 'success', data: { notice: LINK_EMAILED } });
		expect(sent.emails).toHaveLength(2);
		const now = links();
		expect(now).toEqual([expect.objectContaining({ issuedBy: 'release-mail', tokenHash: tokenHashOf(mailedToken(sent.emails[1])) })]);
		expect(now[0].tokenHash).not.toBe(first[0].tokenHash);
	});

	it('T93: confirm with no MFA key is 503 with the set-up words, and nothing is written', async () => {
		const { token } = await atCodesShown();
		keyStub.none = true;
		const before = snapshotDb();

		const res = await enrol(token, 'confirm');

		expect(res).toMatchObject({ type: 'failure', status: 503, data: { error: NO_MFA_KEY, restart: false } });
		expectUnchanged(before);
	});

	it('T94: a new release mail that fails leaves the link already mailed working', async () => {
		mailReady();
		await passwordStep(user);
		await sent.settle();
		const held = mailedToken(sent.emails[0]);
		const first = links();
		vi.setSystemTime(Date.now() + 25 * HOUR);
		sent.restore();
		sent = effects({ refuseMailTo: [user.email] });

		const { res } = await passwordStep(user);

		expect(res).toMatchObject({ type: 'failure', status: 503, data: { error: COULD_NOT_EMAIL } });
		expect(links()).toEqual(first);
		expect(usableEnrolmentLink(held)).toMatchObject({ userId: user.id });
	});

	it('T95: while the owner sets up on the mailed link, a right password from elsewhere issues no new link and does not end the set-up', async () => {
		mailReady();
		await passwordStep(user);
		await sent.settle();
		const held = mailedToken(sent.emails[0]);
		vi.setSystemTime(Date.now() + 25 * HOUR);
		const { token } = await atCodesShown(user, { [ENROL_LINK_COOKIE]: held });
		const before = links();

		const { res } = await passwordStep(user);
		await sent.settle();

		expect(res).toMatchObject({ type: 'success', data: { notice: SET_UP_UNDER_WAY } });
		expect(sent.emails).toHaveLength(1);
		expect(links()).toEqual(before);
		expect(await enrol(token, 'confirm')).toMatchObject({ type: 'redirect', status: 303, location: '/' });
	});

	it('T96: a set-up link issued by an older image, which leaves the mark: the account needs a link, and cannot set up on its password', async () => {
		db.insert(enrolmentLinks)
			.values({ tokenHash: 'a'.repeat(64), userId: user.id, issuedBy: 'admin-reset', expiresAt: stamp(new Date(Date.now() + DAY)) })
			.run();

		const { res } = await passwordStep(user);

		expect(res).toMatchObject({ type: 'failure', status: 403, data: { error: NEEDS_LINK } });
		expect(challenges()).toEqual([]);
	});

	it('T97: making a working copy takes every account’s leave to set up on its password alone', () => {
		const other = makeUser();
		mayEnrolOnPassword(other.id);

		switchOffOutside(sqlite);

		expect([userRow().mfaPasswordEnrol, userRow(other.id).mfaPasswordEnrol]).toEqual([0, 0]);
	});

	it('T98: a mail host set up during a set-up on the password: confirm is 409, and nothing is written', async () => {
		const { token } = await atCodesShown();
		makeSmtp();
		const before = snapshotDb();

		const res = await enrol(token, 'confirm');

		expect(res).toMatchObject({ type: 'failure', status: 409, data: { error: ENROL_CANNOT_FINISH, restart: true } });
		expectUnchanged(before);
	});

	it('T99: the admin load gives the caller’s own password set-up date, and none while a mail host is set up', async () => {
		const admin = makeUser({ role: 'admin' });
		mayEnrolOnPassword(admin.id);
		const until = async () => {
			const page = await pageLoad('/admin', { user: admin });
			const listed = (page as { data: { users: { id: number; passwordSetUpUntil: string | null }[] } }).data.users;
			return [admin, user].map((account) => listed.find((row) => row.id === account.id)!.passwordSetUpUntil);
		};
		const ends = stamp(new Date(parseStamp(stamp())!.getTime() + 14 * DAY));

		expect(await until()).toEqual([ends, ends]);
		makeSmtp();
		expect(await until()).toEqual([null, null]);
	});
});
