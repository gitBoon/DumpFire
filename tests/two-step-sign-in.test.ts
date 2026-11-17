/**
 * Two-step sign-in (card 2769): a right password no longer signs anyone in
 * on its own.
 *
 * This file starts with what keeps an older image from minting access once
 * the release has run (decision 24, the S1 review): a session is open only
 * when it was made after a second factor (`sessions.two_step` 1, written by
 * `createSession`), and a remembered-browser cookie is good only when it was
 * signed under this image's MAC domain, `known-browser:2:`.
 *
 * Then the second step (slice 2, T8-T42): a right password at an account
 * that holds an authenticator opens a challenge and signs nobody in; the code
 * page checks a code or a recovery code against it, in the order of the
 * plan's section 4.5, counting wrong codes on the challenge, on the lane and
 * since the last sign-in, pausing and locking the lane, and mailing the owner
 * what they should know.
 *
 * Then what setting up an authenticator is built from (slice 3, T45-T47): who
 * may make a session, the secret's text and its QR code. The set-up page
 * itself is tests/two-step-enrol.test.ts.
 *
 * Against the application's own in-memory database, emptied before each test.
 * The form actions are called directly (`action()`), but for the gate's own
 * rules (T40, T41).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import ts from 'typescript';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { mfaFactors, sessions, settings, users, webhooks } from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import {
	SECURE_SESSION_COOKIE_NAME,
	SESSION_COOKIE_NAME,
	createSession,
	openSessionUser,
	sessionCookieName,
	validateSession
} from '$lib/server/auth';
import {
	KNOWN_BROWSER_SECRET_KEY,
	knownBrowserCookie,
	rememberBrowser,
	rememberedNonce,
	resetKnownBrowserSecretCache
} from '$lib/server/known-browsers';
import { resetAllRateLimits, signInWait } from '$lib/server/rate-limit';
import { subscribeToLogs, type LogEntry } from '$lib/server/logger';
import { resetTwoStep } from '$lib/server/mfa-store';
import { newRecoveryCodes } from '$lib/server/recovery-codes';
import { stepAt } from '$lib/server/totp';
import {
	CHALLENGE_COOKIE,
	CHALLENGE_SWEEP_EVERY_MS,
	SECURE_CHALLENGE_COOKIE,
	codePause,
	startChallengeSweep,
	stopChallengeSweep,
	sweepExpiredChallenges,
	tokenHashOf,
	type ChallengeRow
} from '$lib/server/sign-in-challenges';
import {
	CODES_LOCKED,
	ENROL_CANNOT_FINISH,
	FACTOR_UNUSABLE,
	MALFORMED_RECOVERY_CODE,
	NO_CODE,
	PASSWORD_CHANGED_DURING_SIGN_IN,
	SIGN_IN_EXPIRED,
	STEP_SPENT,
	TOO_MANY_WRONG_CODES,
	WRONG_CODE,
	WRONG_RECOVERY_CODE,
	codesPaused
} from '$lib/server/second-step';
import { base32, otpauthUri, qrDataUri, secretInGroups } from '$lib/server/otpauth';
import { parseStamp, stamp } from '$lib/timestamps';
import { action, pageLoad } from './helpers/actions';
import { effects, type Effects } from './helpers/effects';
import { gate } from './helpers/gate';
import { FIXTURE_PASSWORD, FIXTURE_PASSWORD_HASH, makeApiKey, makeBoard, makeSession, makeSmtp, makeUser, resetDb, sessionHashOf, sessionRow } from './helpers/fixtures';
import { VERIFY_AT, codeFor, giveFactor, openReleaseWindow, passwordStep, signInFully, verify, wrongCodeFor, type GivenFactor } from './helpers/two-step';

/** Run while the password is being checked (T42): a password set meanwhile. */
const duringCheck = vi.hoisted(() => ({ run: null as null | (() => void) }));

vi.mock('$lib/server/passwords', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/passwords')>();
	return {
		...real,
		checkPassword: async (...args: Parameters<typeof real.checkPassword>) => {
			const checked = await real.checkPassword(...args);
			duringCheck.run?.();
			return checked;
		}
	};
});

const logLevel = process.env.LOG_LEVEL;
const cookieSecure = process.env.COOKIE_SECURE;

beforeEach(() => {
	resetDb();
	// resetDb empties settings, and the secret is cached as a running process caches it.
	resetKnownBrowserSecretCache();
});

afterEach(() => {
	vi.restoreAllMocks();
	if (logLevel === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = logLevel;
	if (cookieSecure === undefined) delete process.env.COOKIE_SECURE;
	else process.env.COOKIE_SECURE = cookieSecure;
	resetKnownBrowserSecretCache();
});

/** Every WARN line written to the console while `fn` runs, with LOG_LEVEL at WARN so that one is written. */
function warnings<T>(fn: () => T): { result: T; warned: string[] } {
	process.env.LOG_LEVEL = 'WARN';
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		const result = fn();
		return { result, warned: warn.mock.calls.map((call) => String(call[0])) };
	} finally {
		warn.mockRestore();
	}
}

describe('sessions made without a second factor (decision 24)', () => {
	it('T6: a session row with two_step 0 is refused, deleted, and said once at WARN; createSession writes 1', () => {
		const user = makeUser();

		// What createSession makes: two_step 1, and open.
		const made = createSession(user.id).token;
		expect(sessionRow(made)?.twoStep).toBe(1);
		expect(validateSession(made)?.user.id).toBe(user.id);

		// A row with no value for the column, so its default, 0. An older image's
		// own rows are held in plain, which this image never finds and sweeps at
		// start (card 2775, decision 17); held as a hash, it reaches the
		// refusal, kept as defence in depth.
		const token = 'session-of-an-older-image';
		sqlite
			.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
			.run(sessionHashOf(token), user.id, stamp(new Date(Date.now() + 60 * 60 * 1000)), stamp());
		expect(sessionRow(token)?.twoStep).toBe(0);

		// Refused by every reader, which write nothing.
		expect(openSessionUser(sessionHashOf(token))).toBeNull();
		expect(sessionRow(token)).toBeDefined();

		// The gate's reader refuses it, deletes it, and says so once.
		const { result, warned } = warnings(() => validateSession(token));
		expect(result).toBeNull();
		expect(sessionRow(token)).toBeUndefined();
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain('[WARN] [AUTH]');
		expect(warned[0]).toContain('A hashed session row with two_step 0 — refused and deleted');
		expect(warned[0]).not.toContain(token);

		// The session made after a second factor is untouched.
		expect(sessionRow(made)?.twoStep).toBe(1);
	});
});

describe('remembered browsers (decision 24)', () => {
	it('T7: a cookie signed under known-browser:1: is not remembered; one under known-browser:2: is', () => {
		const user = { id: makeUser().id, passwordHash: FIXTURE_PASSWORD_HASH };

		// This image's cookie, which also makes the secret.
		let value = '';
		rememberBrowser({ set: (_name: string, v: string) => (value = v) } as never, user.id, user.passwordHash, null);
		const sending = (cookie: string) => ({ get: (name: string) => (name === knownBrowserCookie(user.id) ? cookie : undefined) });
		const [issuedAt, nonce] = value.split('.');
		expect(rememberedNonce(sending(value), user)).toBe(nonce);

		// The same browser, time and nonce under the same secret, signed as an older image signs.
		const secret = db.select().from(settings).where(eq(settings.key, KNOWN_BROWSER_SECRET_KEY)).get()!.value;
		const olderMac = createHmac('sha256', secret)
			.update(`known-browser:1:${user.id}:${issuedAt}:${nonce}:${user.passwordHash}`)
			.digest('hex');
		expect(rememberedNonce(sending(`${issuedAt}.${nonce}.${olderMac}`), user)).toBeNull();

		// And under :2:, as this image signs, it is the one remembered.
		const mac = createHmac('sha256', secret)
			.update(`known-browser:2:${user.id}:${issuedAt}:${nonce}:${user.passwordHash}`)
			.digest('hex');
		expect(`${issuedAt}.${nonce}.${mac}`).toBe(value);
	});
});

// ─── Slice 2: challenges and the code page ───────────────────────────────────

/** Three callers' addresses. */
const A = '203.0.113.10';
const B = '203.0.113.20';
const C = '203.0.113.30';

/** The subjects of the security notices (4.9). */
const NOTICE = {
	wrongCode: 'Your DumpFire password was used with a wrong code',
	paused: 'Code entry for your DumpFire account is paused',
	locked: 'Authenticator codes for your DumpFire account are locked',
	recoveryUsed: 'A recovery code was used to sign in to DumpFire',
	guessed: 'Wrong recovery codes were entered for your DumpFire account',
	unfinished: 'A sign-in to your DumpFire account was not finished'
};

describe('the second step (slice 2)', () => {
	let user: ReturnType<typeof makeUser>;
	let factor: GivenFactor;
	let sent: Effects;

	const userRow = () => db.select().from(users).where(eq(users.id, user.id)).get()!;
	const challenges = () => sqlite.prepare('SELECT * FROM sign_in_challenges ORDER BY rowid').all() as ChallengeRow[];
	const sessionsOf = (userId: number) => db.select().from(sessions).where(eq(sessions.userId, userId)).all();
	/** Move the frozen clock on. */
	const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

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

	/** The subjects of the mail sent, once every send has started. */
	async function subjects(): Promise<string[]> {
		await sent.settle();
		return sent.emails.map((mail) => mail.subject);
	}

	/** The words of a failure, or null for any other answer. */
	const errorOf = (res: Awaited<ReturnType<typeof verify>>): string | null => (res.type === 'failure' ? res.data.error : null);

	/** Signed in: a session cookie, and home, or the report of decision 16. */
	function expectSignedIn(res: Awaited<ReturnType<typeof verify>>): void {
		// Named for the address the second step was sent to (VERIFY_AT, card 2775).
		expect(res.cookies[sessionCookieName(VERIFY_AT)]?.value, JSON.stringify(res)).toBeDefined();
		if (res.type === 'redirect') expect(res.location).toBe('/');
		else expect(res).toMatchObject({ type: 'success', data: { signedIn: true } });
	}

	/** An account with no factor that may set up on its password alone: the flag, the release window open, and no mail host (I3). */
	function enrollable(): ReturnType<typeof makeUser> {
		const plain = makeUser();
		db.update(users).set({ mfaPasswordEnrol: 1 }).where(eq(users.id, plain.id)).run();
		openReleaseWindow();
		return plain;
	}

	/** Five wrong codes on one challenge from `ip`: the lane's fifth too, so it is paused. */
	async function fiveWrong(ip?: string): Promise<void> {
		const { challenge } = await passwordStep(user, { ip });
		for (let i = 0; i < 5; i++) await verify(challenge, { code: wrongCodeFor(factor.secret) }, { ip });
	}

	beforeEach(() => {
		resetAllRateLimits();
		// A frozen clock, so that a code and its check fall in one step; timers run as ever.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date());
		user = makeUser();
		factor = giveFactor(user);
		sent = effects();
	});

	afterEach(() => {
		sent.restore();
		vi.useRealTimers();
		duringCheck.run = null;
		resetAllRateLimits();
	});

	it('T8: the right password at an enrolled account opens one hashed challenge and signs nobody in', async () => {
		const { result, lines } = await logged(() => passwordStep(user));
		const { res, challenge } = result;

		expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/login/verify' });
		expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(res.cookies[CHALLENGE_COOKIE].options).toEqual({ path: '/', httpOnly: true, sameSite: 'strict', secure: false, maxAge: 600 });
		const rows = challenges();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			token_hash: tokenHashOf(challenge!),
			user_id: user.id,
			purpose: 'verify',
			lane: 'other',
			password_hash: FIXTURE_PASSWORD_HASH,
			wrong_count: 0
		});
		expect(JSON.stringify(rows)).not.toContain(challenge);

		const accepted = lines.filter((line) => line.message.startsWith('Password accepted'));
		expect(accepted.map(({ level, message }) => ({ level, message }))).toEqual([
			{
				level: 'INFO',
				message: `Password accepted for "${user.username}" (user ${user.id}) from IP 127.0.0.1, second step issued (verify), challenge ${rows[0].short_id}`
			}
		]);
		expect(JSON.stringify(lines)).not.toContain(challenge);
		expect(lines.some((line) => line.message.includes('logged in'))).toBe(false);

		expect(res.cookies[SESSION_COOKIE_NAME]).toBeUndefined();
		expect(res.cookies[knownBrowserCookie(user.id)]).toBeUndefined();
		expect(sessionsOf(user.id)).toEqual([]);
	});

	it('T9: a wrong password is answered alike at an enrolled and an unenrolled account, and issues nothing', async () => {
		const plain = makeUser();

		const enrolled = (await passwordStep(user, { password: 'not the password' })).res;
		const unenrolled = (await passwordStep(plain, { password: 'not the password' })).res;

		const shape = (res: typeof enrolled) => ({ type: res.type, status: res.status, error: res.type === 'failure' ? res.data.error : null, cookies: res.cookies });
		expect(shape(enrolled)).toEqual({ type: 'failure', status: 400, error: 'Invalid username/email or password', cookies: {} });
		expect(shape(unenrolled)).toEqual(shape(enrolled));
		expect(challenges()).toEqual([]);
	});

	it('T10: five wrong passwords, then the right one alone: the account’s wait and the address’s attempts stand', async () => {
		for (let i = 0; i < 5; i++) await passwordStep(user, { password: 'not the password', ip: A });

		const { res } = await passwordStep(user, { ip: A });
		expect(res).toMatchObject({ type: 'redirect', location: '/login/verify' });

		expect(signInWait(`user:${user.id}`)).toBe(1000);
		// Six attempts counted at A: four more are let in, and the fifth is refused.
		const answers: number[] = [];
		for (let i = 0; i < 5; i++) answers.push((await action('/login', { form: { identity: `nobody-${i}`, password: 'x' }, ip: A })).status);
		expect(answers).toEqual([400, 400, 400, 400, 429]);
	});

	it('T11: five wrong passwords, the right one, then the right code: the wait forgotten and the address given back', async () => {
		for (let i = 0; i < 5; i++) await passwordStep(user, { password: 'not the password', ip: A });
		const { challenge } = await passwordStep(user, { ip: A });

		expectSignedIn(await verify(challenge, { code: codeFor(factor.secret) }, { ip: A }));

		expect(signInWait(`user:${user.id}`)).toBe(0);
		const answers: number[] = [];
		for (let i = 0; i < 5; i++) answers.push((await action('/login', { form: { identity: `nobody-${i}`, password: 'x' }, ip: A })).status);
		expect(answers).toEqual([400, 400, 400, 400, 400]);
	});

	it('T12: the right code signs in: a two-step session, a remembered browser, the challenge and its cookie gone, the step spent', async () => {
		const { challenge } = await passwordStep(user);

		const { result: res, lines } = await logged(() => verify(challenge, { code: codeFor(factor.secret) }));

		expect(res).toMatchObject({ type: 'redirect', status: 303, location: '/' });
		const token = res.cookies[SESSION_COOKIE_NAME].value;
		expect(db.select().from(sessions).where(eq(sessions.tokenHash, sessionHashOf(token))).get()).toMatchObject({ userId: user.id, twoStep: 1 });
		const known = res.cookies[knownBrowserCookie(user.id)];
		expect(known.options).toMatchObject({ path: '/login', httpOnly: true, sameSite: 'strict' });
		const sending = { get: (name: string) => (name === knownBrowserCookie(user.id) ? known.value : undefined) };
		expect(rememberedNonce(sending, { id: user.id, passwordHash: FIXTURE_PASSWORD_HASH })).not.toBeNull();

		expect(challenges()).toEqual([]);
		expect(res.deletedCookies).toContain(CHALLENGE_COOKIE);
		expect(db.select().from(mfaFactors).where(eq(mfaFactors.id, factor.factorId)).get()!.lastStep).toBe(stepAt(Date.now()));
		expect(userRow()).toMatchObject({ mfaOtherWrong: 0, failedCodesSinceSignIn: 0, lastSignInAt: stamp(), lastSignInFrom: '127.0.0.1' });
		expect(lines).toContainEqual(expect.objectContaining({ level: 'INFO', message: `User "${user.username}" logged in`, userId: user.id }));
	});

	it('T13: a wrong code is 400, counted on the challenge, the lane and since the last sign-in, said at WARN, and keeps the cookie', async () => {
		const { challenge } = await passwordStep(user);

		const { result: res, lines } = await logged(() => verify(challenge, { code: wrongCodeFor(factor.secret) }));

		expect(res).toMatchObject({ type: 'failure', status: 400, data: { error: WRONG_CODE, restart: false } });
		expect(challenges()[0].wrong_count).toBe(1);
		expect(userRow()).toMatchObject({ mfaOtherWrong: 1, failedCodesSinceSignIn: 1 });
		expect(lines.filter((line) => line.level === 'WARN').map((line) => line.message)).toContainEqual(
			expect.stringContaining(`Wrong two-step sign-in code for "${user.username}" (user ${user.id})`)
		);
		expect(res.deletedCookies).toEqual([]);
		expect(res.cookies).toEqual({});
	});

	it('T14: neither a code nor a recovery code is 400, and nothing is counted', async () => {
		const { challenge } = await passwordStep(user);

		const res = await verify(challenge, { code: ' ', recoveryCode: '' });

		expect(res).toMatchObject({ type: 'failure', status: 400, data: { error: NO_CODE } });
		expect(challenges()[0].wrong_count).toBe(0);
		expect(userRow()).toMatchObject({ mfaOtherWrong: 0, failedCodesSinceSignIn: 0 });
	});

	it('T15: the fifth wrong code on a challenge, the lane’s fifth too, ends it, pauses the lane 15 minutes, and mails the pause', async () => {
		makeSmtp();
		const { challenge } = await passwordStep(user);

		const answers = [];
		for (let i = 0; i < 5; i++) answers.push(await verify(challenge, { code: wrongCodeFor(factor.secret) }));

		expect(answers.slice(0, 4).map(errorOf)).toEqual(Array(4).fill(WRONG_CODE));
		expect(answers[4]).toMatchObject({ type: 'failure', status: 400, data: { error: TOO_MANY_WRONG_CODES, restart: true } });
		expect(answers[4].deletedCookies).toContain(CHALLENGE_COOKIE);
		expect(challenges()).toEqual([]);
		expect(userRow().mfaOtherWrong).toBe(5);
		expect(parseStamp(userRow().mfaOtherResumesAt)!.getTime()).toBe(parseStamp(stamp())!.getTime() + 15 * 60_000);
		expect(await subjects()).toEqual([NOTICE.wrongCode, NOTICE.paused]);
	});

	it.each([
		[5, 15],
		[10, 60],
		[15, 240],
		[20, 1440],
		[25, 1440],
		[29, null],
		[30, 'locked']
	] as const)('T16: codePause(%s) is %s', (count, pause) => {
		expect(codePause(count)).toBe(pause);
	});

	it('T17: a paused lane refuses a code 429, uncounted; 15 minutes on, the right code signs in', async () => {
		await fiveWrong();

		const { challenge } = await passwordStep(user);
		const refused = await verify(challenge, { code: codeFor(factor.secret) });
		expect(refused).toMatchObject({ type: 'failure', status: 429, data: { error: codesPaused(15) } });
		expect(challenges()[0].wrong_count).toBe(0);
		expect(userRow()).toMatchObject({ mfaOtherWrong: 5, failedCodesSinceSignIn: 5 });

		later(15 * 60_000);
		const again = await passwordStep(user);
		expectSignedIn(await verify(again.challenge, { code: codeFor(factor.secret) }));
	});

	it('T18: at 30 wrong codes the lane is locked: a right code is refused 403, and the lock is mailed', async () => {
		makeSmtp();
		db.update(users).set({ mfaOtherWrong: 29 }).where(eq(users.id, user.id)).run();
		const { challenge } = await passwordStep(user);

		expect(await verify(challenge, { code: wrongCodeFor(factor.secret) })).toMatchObject({ status: 400, data: { error: WRONG_CODE } });
		expect(userRow().mfaOtherWrong).toBe(30);
		const refused = await verify(challenge, { code: codeFor(factor.secret) });

		expect(refused).toMatchObject({ type: 'failure', status: 403, data: { error: CODES_LOCKED } });
		expect(refused.cookies[SESSION_COOKIE_NAME]).toBeUndefined();
		expect(await subjects()).toEqual([NOTICE.wrongCode, NOTICE.locked]);
	});

	it('T19: a recovery code signs in past the lock, clears both lanes and the recovery count, is said at WARN and mailed with the codes left', async () => {
		makeSmtp();
		db.update(users)
			.set({ mfaOtherWrong: 30, mfaKnownWrong: 7, mfaKnownResumesAt: stamp(new Date(Date.now() + 60 * 60_000)), mfaRecoveryWrong: 3 })
			.where(eq(users.id, user.id))
			.run();
		const { challenge } = await passwordStep(user);

		const { result: res, lines } = await logged(() => verify(challenge, { recoveryCode: factor.recoveryCodes[0] }));

		expectSignedIn(res);
		expect(userRow()).toMatchObject({
			mfaOtherWrong: 0,
			mfaKnownWrong: 0,
			mfaOtherResumesAt: null,
			mfaKnownResumesAt: null,
			mfaRecoveryWrong: 0
		});
		expect(lines).toContainEqual(
			expect.objectContaining({ level: 'WARN', message: `A recovery code signed in "${user.username}" (user ${user.id}) from IP 127.0.0.1: 9 left` })
		);
		expect(await subjects()).toEqual([NOTICE.recoveryUsed]);
		expect(sent.emails[0].html).toContain('You have 9 recovery codes left.');
	});

	it('T20: a recovery code signs in past a pause', async () => {
		db.update(users)
			.set({ mfaOtherWrong: 5, mfaOtherResumesAt: stamp(new Date(Date.now() + 15 * 60_000)) })
			.where(eq(users.id, user.id))
			.run();
		const { challenge } = await passwordStep(user);

		expectSignedIn(await verify(challenge, { recoveryCode: factor.recoveryCodes[1] }));
	});

	it('T21: ten wrong recovery codes in a row, over two challenges, are mailed once; a right one then signs in; no recovery pause', async () => {
		makeSmtp();
		const guesses = newRecoveryCodes();

		for (const [ip, five] of [
			[A, guesses.slice(0, 5)],
			[B, guesses.slice(5)]
		] as const) {
			const { challenge } = await passwordStep(user, { ip });
			const answers: (string | null)[] = [];
			for (const code of five) answers.push(errorOf(await verify(challenge, { recoveryCode: code }, { ip })));
			expect(answers).toEqual([...Array(4).fill(WRONG_RECOVERY_CODE), TOO_MANY_WRONG_CODES]);
		}
		expect(userRow()).toMatchObject({ mfaRecoveryWrong: 10, mfaRecoveryResumesAt: null });
		expect((await subjects()).filter((subject) => subject === NOTICE.guessed)).toHaveLength(1);

		const { challenge } = await passwordStep(user, { ip: C });
		expectSignedIn(await verify(challenge, { recoveryCode: factor.recoveryCodes[0] }, { ip: C }));
		expect(userRow()).toMatchObject({ mfaRecoveryWrong: 0, mfaRecoveryResumesAt: null });
	});

	it('T22: a malformed recovery code is answered with the format, and nothing is counted', async () => {
		const { challenge } = await passwordStep(user);

		const res = await verify(challenge, { recoveryCode: 'not-a-code' });

		expect(res).toMatchObject({ type: 'failure', status: 400, data: { error: MALFORMED_RECOVERY_CODE } });
		expect(challenges()[0].wrong_count).toBe(0);
		expect(userRow()).toMatchObject({ mfaRecoveryWrong: 0, failedCodesSinceSignIn: 0 });
	});

	it('T23: a code whose step is already spent asks for the next code, and the counts are as they were', async () => {
		await signInFully(user, factor);
		const { challenge } = await passwordStep(user);

		const res = await verify(challenge, { code: codeFor(factor.secret) });

		expect(res).toMatchObject({ type: 'failure', status: 400, data: { error: STEP_SPENT } });
		expect(challenges()[0].wrong_count).toBe(0);
		expect(userRow()).toMatchObject({ mfaOtherWrong: 0, failedCodesSinceSignIn: 0 });
	});

	it('T24: a factor that does not open is 503, uncounted, one ERROR line; a recovery code still signs in', async () => {
		db.update(mfaFactors).set({ keyId: 'another-key' }).where(eq(mfaFactors.id, factor.factorId)).run();
		const { challenge } = await passwordStep(user);

		const { result: res, lines } = await logged(() => verify(challenge, { code: codeFor(factor.secret) }));

		expect(res).toMatchObject({ type: 'failure', status: 503, data: { error: FACTOR_UNUSABLE } });
		expect(challenges()[0].wrong_count).toBe(0);
		expect(userRow()).toMatchObject({ mfaOtherWrong: 0, failedCodesSinceSignIn: 0 });
		expect(lines.filter((line) => line.level === 'ERROR')).toHaveLength(1);
		expectSignedIn(await verify(challenge, { recoveryCode: factor.recoveryCodes[0] }));
	});

	it('T25: wrong codes from other browsers do not pause a remembered browser, whose wrong codes count in its own lane', async () => {
		const first = await signInFully(user, factor, { ip: A });
		const known = { [knownBrowserCookie(user.id)]: first.res.cookies[knownBrowserCookie(user.id)].value };
		later(30_000);

		await fiveWrong(B);
		expect(userRow()).toMatchObject({ mfaOtherWrong: 5, mfaKnownWrong: 0 });

		const { challenge } = await passwordStep(user, { ip: A, cookies: known });
		expect(challenges().find((row) => row.token_hash === tokenHashOf(challenge!))?.lane).toBe('known');
		expect(await verify(challenge, { code: wrongCodeFor(factor.secret) }, { ip: A })).toMatchObject({ status: 400, data: { error: WRONG_CODE } });
		expect(userRow()).toMatchObject({ mfaOtherWrong: 5, mfaKnownWrong: 1 });

		expectSignedIn(await verify(challenge, { code: codeFor(factor.secret) }, { ip: A }));
	});

	it('T26: a pause outlasts everything kept in memory', async () => {
		await fiveWrong();
		resetAllRateLimits();

		const { challenge } = await passwordStep(user);

		expect(await verify(challenge, { code: codeFor(factor.secret) })).toMatchObject({ status: 429, data: { error: codesPaused(15) } });
	});

	it('T27: the password changed under a live challenge: 409, the challenge deleted, said at WARN', async () => {
		const { challenge } = await passwordStep(user);
		db.update(users).set({ passwordHash: '$2b$04$another.hash.set.while.the.code.was.awaited.xxxxxxxxx' }).where(eq(users.id, user.id)).run();

		const { result: res, lines } = await logged(() => verify(challenge, { code: codeFor(factor.secret) }));

		expect(res).toMatchObject({ type: 'failure', status: 409, data: { error: PASSWORD_CHANGED_DURING_SIGN_IN, restart: true } });
		expect(res.deletedCookies).toContain(CHALLENGE_COOKIE);
		expect(challenges()).toEqual([]);
		expect(sessionsOf(user.id)).toEqual([]);
		expect(lines).toContainEqual(expect.objectContaining({ level: 'WARN', message: expect.stringContaining('was changed under a pending sign-in') }));
	});

	it('T28: past ten minutes, a code gets the expired words and the cookie is deleted; the page sends the browser to sign in', async () => {
		const { challenge } = await passwordStep(user);
		const holding = { cookie: `${CHALLENGE_COOKIE}=${challenge}` };
		expect(await pageLoad('/login/verify', { headers: holding })).toEqual({
			type: 'data',
			data: { username: user.username, codesNotice: null, codesLocked: false }
		});
		// Slice 3: the set-up page, for an account that may set up on its password (I3).
		const plain = enrollable();
		const enrolling = (await passwordStep(plain)).challenge!;
		const holdingEnrol = { cookie: `${CHALLENGE_COOKIE}=${enrolling}` };
		expect(await pageLoad('/login/enrol', { headers: holdingEnrol })).toMatchObject({ type: 'data', data: { stage: 'secret_shown' } });

		later(10 * 60_000);
		const res = await verify(challenge, { code: codeFor(factor.secret) });
		const enrolRes = await action('/login/enrol', { name: 'code', form: { code: '123456' }, cookies: { [CHALLENGE_COOKIE]: enrolling } });

		for (const answer of [res, enrolRes]) {
			expect(answer).toMatchObject({ type: 'failure', status: 400, data: { error: SIGN_IN_EXPIRED, restart: true } });
			expect(answer.deletedCookies).toContain(CHALLENGE_COOKIE);
		}
		// Confirm with no live set-up has the one confirm wording (CR5).
		const confirmRes = await action('/login/enrol', { name: 'confirm', form: {}, cookies: { [CHALLENGE_COOKIE]: enrolling } });
		expect(confirmRes).toMatchObject({ type: 'failure', status: 409, data: { error: ENROL_CANNOT_FINISH, restart: true } });
		expect(confirmRes.deletedCookies).toContain(CHALLENGE_COOKIE);
		expect(sessionsOf(user.id)).toEqual([]);
		expect(await pageLoad('/login/verify', { headers: holding })).toEqual({ type: 'redirect', status: 303, location: '/login' });
		expect(await pageLoad('/login/enrol', { headers: holdingEnrol })).toEqual({ type: 'redirect', status: 303, location: '/login' });
	});

	it('T29: from reading the challenge to taking it nothing is awaited: verifyStep is synchronous, and its action awaits only the form', () => {
		const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
		/** The text of every `await` under `node`, and of every function under it (itself included) that is async. */
		const awaited = (node: ts.Node) => {
			const awaits: string[] = [];
			const asyncs: string[] = [];
			const walk = (at: ts.Node) => {
				if (ts.isAwaitExpression(at)) awaits.push(at.getText());
				if (ts.isFunctionLike(at) && ts.canHaveModifiers(at) && ts.getModifiers(at)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
					asyncs.push(at.getText().slice(0, 40));
				}
				ts.forEachChild(at, walk);
			};
			walk(node);
			return { awaits, asyncs };
		};

		const secondStep = parse('src/lib/server/second-step.ts');
		const declared = (name: string) =>
			secondStep.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
		// Slice 3: the set-up page's two steps as well; and the helpers they call (the review's CR9).
		for (const name of [
			'verifyStep',
			'enrolCode',
			'enrolConfirm',
			'openChallenge',
			'finishSignIn',
			'signedInAnswer',
			'refuse',
			'laneOf',
			'mayStillEnrolOnPassword',
			'issueSetUpChallenge'
		]) {
			const step = declared(name);
			expect(step, name).toBeDefined();
			expect(awaited(step!), name).toEqual({ awaits: [], asyncs: [] });
		}

		// The password step (CR12): from reading the factor and the link to
		// issuing the challenge nothing is awaited. Async only for the release
		// mail it hands on to, its last statement, which awaits the send.
		const afterPassword = declared('afterPassword')!;
		expect(awaited(afterPassword)).toEqual({ awaits: [], asyncs: [afterPassword.getText().slice(0, 40)] });
		const last = afterPassword.body!.statements.at(-1)!.getText();
		expect(last.startsWith('return releaseMail(')).toBe(true);

		for (const [file, name, first, call] of [
			['src/routes/login/verify/+page.server.ts', 'default', 'const form = await request.formData();', 'return verifyStep'],
			['src/routes/login/enrol/+page.server.ts', 'code', 'const form = await request.formData();', 'return enrolCode'],
			// Confirm takes no field: the form is read all the same, so that a body that is not one is refused (gate.test.ts).
			['src/routes/login/enrol/+page.server.ts', 'confirm', 'await request.formData();', 'return enrolConfirm']
		] as const) {
			let handler: ts.ArrowFunction | undefined;
			const find = (at: ts.Node) => {
				if (ts.isPropertyAssignment(at) && at.name.getText() === name && ts.isArrowFunction(at.initializer)) handler = at.initializer;
				ts.forEachChild(at, find);
			};
			find(parse(file));
			expect(handler, `${file} ${name}`).toBeDefined();
			const statements = (handler!.body as ts.Block).statements;
			expect(statements[0].getText()).toBe(first);
			expect(awaited(handler!.body).awaits).toEqual(['await request.formData()']);
			// And then the call, and nothing else.
			expect(statements.slice(1).map((s) => s.getText().split('(')[0])).toEqual([call]);
		}
	});

	it('T30: a reset of two-step sign-in committed between the password and the code: no session', async () => {
		const { challenge } = await passwordStep(user);
		inTransaction(() => resetTwoStep(user.id));

		const res = await verify(challenge, { code: codeFor(factor.secret) });

		expect(res).toMatchObject({ type: 'failure', status: 400, data: { error: SIGN_IN_EXPIRED } });
		expect(sessionsOf(user.id)).toEqual([]);
	});

	it('T31: a fourth challenge at an account deletes its oldest', async () => {
		const tokens: string[] = [];
		for (let i = 0; i < 4; i++) tokens.push((await passwordStep(user)).challenge!);

		expect(challenges().map((row) => row.token_hash)).toEqual(tokens.slice(1).map(tokenHashOf));
	});

	it('T32: a second right password from the browser holding a challenge replaces it', async () => {
		const first = (await passwordStep(user)).challenge!;
		const second = (await passwordStep(user, { cookies: { [CHALLENGE_COOKIE]: first } })).challenge!;

		expect(challenges().map((row) => row.token_hash)).toEqual([tokenHashOf(second)]);
	});

	it('T33: two challenge cookies of the name in force are read as none, and nothing is counted', async () => {
		const { challenge } = await passwordStep(user);

		const res = await action('/login/verify', {
			form: { code: wrongCodeFor(factor.secret) },
			headers: { cookie: `${CHALLENGE_COOKIE}=${challenge}; ${CHALLENGE_COOKIE}=${challenge}` }
		});

		expect(res).toMatchObject({ type: 'failure', status: 400, data: { error: SIGN_IN_EXPIRED } });
		expect(challenges()[0].wrong_count).toBe(0);
		expect(userRow()).toMatchObject({ mfaOtherWrong: 0, failedCodesSinceSignIn: 0 });
	});

	it('T34: under COOKIE_SECURE=true, and over https: without it, the cookie is __Host-, Secure, Path=/; a plain one is then ignored', async () => {
		process.env.COOKIE_SECURE = 'true';
		const { res } = await passwordStep(user);
		const set = res.cookies[SECURE_CHALLENGE_COOKIE];
		expect(set.options).toEqual({ path: '/', httpOnly: true, sameSite: 'strict', secure: true, maxAge: 600 });
		expect(res.cookies[CHALLENGE_COOKIE]).toBeUndefined();

		// The same token under the plain name is not read.
		expect(await verify(set.value, { code: codeFor(factor.secret) })).toMatchObject({ status: 400, data: { error: SIGN_IN_EXPIRED } });
		const signedIn = await action(VERIFY_AT.href, { form: { code: codeFor(factor.secret) }, cookies: { [SECURE_CHALLENGE_COOKIE]: set.value } });
		expectSignedIn(signedIn);
		expect(signedIn.deletedCookies).toContain(SECURE_CHALLENGE_COOKIE);

		// The session cookie follows the same rule (card 2775): an
		// administrator's full sign-in, on a frozen clock, sets one
		// `__Host-dumpfire_session`, Secure, HttpOnly, SameSite=Lax, Path=/, no
		// Domain, kept for the administrator's total limit of 24 hours, and no
		// cookie of the plain name.
		const admin = makeUser({ role: 'admin' });
		const adminFactor = giveFactor(admin);
		const SESSION_SET = { path: '/', httpOnly: true, sameSite: 'lax', secure: true, maxAge: 86400 };
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(new Date('2026-11-16T09:00:00.000Z'));
			const secure = await passwordStep(admin);
			const adminIn = await action('/login/verify', {
				form: { code: codeFor(adminFactor.secret) },
				cookies: { [SECURE_CHALLENGE_COOKIE]: secure.res.cookies[SECURE_CHALLENGE_COOKIE].value }
			});
			expect(adminIn.cookies[SECURE_SESSION_COOKIE_NAME]?.options).toEqual(SESSION_SET);
			expect(adminIn.cookies[SESSION_COOKIE_NAME]).toBeUndefined();

			delete process.env.COOKIE_SECURE;
			const overHttps = await action('https://localhost/login', { form: { identity: user.username, password: FIXTURE_PASSWORD } });
			expect(overHttps.cookies[SECURE_CHALLENGE_COOKIE].options).toEqual({ path: '/', httpOnly: true, sameSite: 'strict', secure: true, maxAge: 600 });
			expect(overHttps.cookies[CHALLENGE_COOKIE]).toBeUndefined();

			vi.setSystemTime(new Date('2026-11-16T09:01:00.000Z'));
			const adminOverHttps = await action('https://localhost/login', { form: { identity: admin.username, password: FIXTURE_PASSWORD } });
			const httpsIn = await action('https://localhost/login/verify', {
				form: { code: codeFor(adminFactor.secret) },
				cookies: { [SECURE_CHALLENGE_COOKIE]: adminOverHttps.cookies[SECURE_CHALLENGE_COOKIE].value }
			});
			expect(httpsIn.cookies[SECURE_SESSION_COOKIE_NAME]?.options).toEqual(SESSION_SET);
			expect(httpsIn.cookies[SESSION_COOKIE_NAME]).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('T35: the first wrong code after the right password mails a notice and raises the banner; on a second challenge within the hour, none', async () => {
		makeSmtp();
		const first = await passwordStep(user);
		await verify(first.challenge, { code: wrongCodeFor(factor.secret) });

		expect(await subjects()).toEqual([NOTICE.wrongCode]);
		expect(sent.emails[0].to).toBe(user.email);
		expect(sent.emails[0].html).toContain('127.0.0.1');
		expect(userRow()).toMatchObject({ securityBanner: 'wrong-code', securityBannerAt: stamp() });

		later(10 * 60_000);
		const second = await passwordStep(user);
		await verify(second.challenge, { code: wrongCodeFor(factor.secret) });
		expect(await subjects()).toEqual([NOTICE.wrongCode]);
	});

	it('T36: an unused verify challenge swept as expired mails a notice and raises the banner; an expired enrol challenge, none', async () => {
		makeSmtp();
		const other = makeUser();
		const left = (await passwordStep(user)).challenge!;
		sqlite
			.prepare(
				'INSERT INTO sign_in_challenges (token_hash, short_id, user_id, purpose, stage, lane, password_hash, created_at, expires_at) ' +
					"VALUES (?, 'enrol001', ?, 'enrol', 'secret_shown', 'other', ?, ?, ?)"
			)
			.run('e'.repeat(64), other.id, FIXTURE_PASSWORD_HASH, stamp(), stamp(new Date(Date.now() + 600_000)));

		later(10 * 60_000);
		await passwordStep(user);

		expect(challenges().map((row) => row.token_hash)).not.toContain(tokenHashOf(left));
		expect(challenges()).toHaveLength(1);
		expect(await subjects()).toEqual([NOTICE.unfinished]);
		expect(sent.emails[0].to).toBe(user.email);
		expect(userRow().securityBanner).toBe('unfinished-sign-in');
		expect(db.select().from(users).where(eq(users.id, other.id)).get()!.securityBanner).toBeNull();
	});

	it('T37: a right code after wrong ones: 200 with the count, the last sign-in, and the account’s keys and webhooks; the count then 0', async () => {
		await signInFully(user, factor, { ip: A });
		const lastSignInAt = userRow().lastSignInAt;
		makeApiKey(user, 'Deploy key');
		const { board } = makeBoard({ owner: user, name: 'Ops' });
		db.insert(webhooks).values({ boardId: board.id, url: 'https://hooks.example.test/in/its-own-secret?k=1', setBy: user.id }).run();
		later(30_000);

		const { challenge } = await passwordStep(user);
		await verify(challenge, { code: wrongCodeFor(factor.secret) });
		const res = await verify(challenge, { code: codeFor(factor.secret) });

		expect(res).toMatchObject({
			type: 'success',
			status: 200,
			data: {
				signedIn: true,
				report: {
					wrongCodes: 1,
					lastSignInAt,
					lastSignInFrom: A,
					apiKeys: [{ name: 'Deploy key', lastUsedAt: null }],
					webhooks: [{ board: 'Ops', host: 'hooks.example.test' }]
				}
			}
		});
		expect(JSON.stringify(res)).not.toContain('its-own-secret');
		expect(res.cookies[SESSION_COOKIE_NAME]).toBeDefined();
		expect(userRow().failedCodesSinceSignIn).toBe(0);
	});

	it('T38: a right code with the banner raised and no wrong codes: the same page, naming the banner’s reason', async () => {
		db.update(users).set({ securityBanner: 'unfinished-sign-in', securityBannerAt: stamp() }).where(eq(users.id, user.id)).run();

		const { res } = await signInFully(user, factor);

		expect(res).toMatchObject({
			type: 'success',
			data: {
				signedIn: true,
				report: { wrongCodes: 0, banner: { words: 'Someone entered your password and did not finish signing in.', at: stamp() } }
			}
		});
		// It stays, for card 2772.
		expect(userRow().securityBanner).toBe('unfinished-sign-in');
	});

	it('T39: with mail not set up, a wrong code sends nothing', async () => {
		const { challenge } = await passwordStep(user);

		await verify(challenge, { code: wrongCodeFor(factor.secret) });

		expect(await subjects()).toEqual([]);
		expect(userRow().securityBanner).toBe('wrong-code');
	});

	it('T40: signed in, the code page and the set-up page send the browser home', async () => {
		const signedIn = `${SESSION_COOKIE_NAME}=${makeSession(user)}`;
		for (const path of ['/login/verify', '/login/enrol']) {
			const res = await gate('GET', path, { headers: { cookie: signedIn, accept: 'text/html' } });

			expect({ path, status: res.status, location: res.headers.get('location') }).toEqual({ path, status: 303, location: '/' });
		}
	}, 60_000);

	it('T41: the code page, the set-up page and their data are kept from every cache and index, and name only the origin; the set-up link’s page names none', async () => {
		const { challenge } = await passwordStep(user);
		const holding = { cookie: `${CHALLENGE_COOKIE}=${challenge}` };
		const enrolling = { cookie: `${CHALLENGE_COOKIE}=${(await passwordStep(enrollable())).challenge}` };

		for (const [path, headers] of [
			['/login/verify', { ...holding, accept: 'text/html' }],
			['/login/verify/__data.json', holding],
			['/login/enrol', { ...enrolling, accept: 'text/html' }],
			['/login/enrol/__data.json', enrolling]
		] as const) {
			const res = await gate('GET', path, { headers });
			await res.text();
			expect({
				path,
				status: res.status,
				referrer: res.headers.get('referrer-policy'),
				robots: res.headers.get('x-robots-tag'),
				cache: res.headers.get('cache-control')
			}).toEqual({ path, status: 200, referrer: 'strict-origin', robots: 'noindex, nofollow', cache: 'no-store' });
		}

		// Slice 4: the set-up link's page, whose address holds the link and which posts nothing, names no address at all.
		const link = inTransaction(() => resetTwoStep(enrollable().id)).token;
		for (const [path, headers] of [
			[`/enrol/${link}`, { accept: 'text/html' }],
			[`/enrol/${link}/__data.json`, {}]
		] as const) {
			const res = await gate('GET', path, { headers });
			await res.text();
			expect({
				status: res.status,
				referrer: res.headers.get('referrer-policy'),
				robots: res.headers.get('x-robots-tag'),
				cache: res.headers.get('cache-control')
			}).toEqual({ status: 200, referrer: 'no-referrer', robots: 'noindex, nofollow', cache: 'no-store' });
		}
	}, 60_000);

	it('T42: a password set while the right one was being checked: no challenge, and 409', async () => {
		duringCheck.run = () =>
			db.update(users).set({ passwordHash: '$2b$04$another.hash.set.while.the.password.was.checked.xxx' }).where(eq(users.id, user.id)).run();

		const { res } = await passwordStep(user);

		expect(res).toMatchObject({ type: 'failure', status: 409, data: { error: PASSWORD_CHANGED_DURING_SIGN_IN } });
		expect(res.cookies).toEqual({});
		expect(challenges()).toEqual([]);
	});

	// ─── The fix pass of the card's two reviews (T78 on) ────────────────────

	/** A form as a browser without JavaScript posts it. */
	const NATIVE_FORM = { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', accept: 'text/html' };

	it('T78: posted without JavaScript, the code page shows the restart words and no form, and after a right code the report, whose Continue reloads', async () => {
		const ended = await gate('POST', '/login/verify', { headers: NATIVE_FORM, body: 'code=123456' });
		const endedHtml = await ended.text();
		expect(ended.status).toBe(400);
		expect(endedHtml).toContain(SIGN_IN_EXPIRED);
		expect(endedHtml).toMatch(/<a href="\/login"[^>]*>Sign in again<\/a>/);
		expect(endedHtml).not.toContain('<form');

		const { challenge } = await passwordStep(user);
		await verify(challenge, { code: wrongCodeFor(factor.secret) });
		const signedIn = await gate('POST', '/login/verify', {
			headers: { ...NATIVE_FORM, cookie: `${CHALLENGE_COOKIE}=${challenge}` },
			body: `code=${codeFor(factor.secret)}`
		});
		const html = await signedIn.text();
		expect(signedIn.status).toBe(200);
		expect(signedIn.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
		expect(html).toContain('You are signed in');
		expect(html).toContain('1 wrong code was entered for your account');
		// A full load, so that the layout reads the new session (CR2).
		expect(html).toMatch(/<a [^>]*href="\/"[^>]*data-sveltekit-reload[^>]*>Continue<\/a>/);
	}, 60_000);

	it('T80: a recovery code’s sign-in that is rolled back says nothing at WARN, and leaves the challenge', async () => {
		const { challenge } = await passwordStep(user);
		sqlite.exec("CREATE TEMP TRIGGER refuse_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'no session'); END");
		try {
			const { result, lines } = await logged(() =>
				verify(challenge, { recoveryCode: factor.recoveryCodes[0] }).then(
					() => null,
					(err: Error) => err
				)
			);
			expect(result?.message).toContain('no session');
			expect(lines.filter((line) => line.message.includes('A recovery code signed in'))).toEqual([]);
		} finally {
			sqlite.exec('DROP TRIGGER IF EXISTS refuse_session');
		}
		expect(challenges()).toHaveLength(1);
		expect(sessionsOf(user.id)).toEqual([]);
	});

	it('T81: an account deleted while its password was checked: the expired words, not the password-changed ones, and no challenge', async () => {
		duringCheck.run = () => sqlite.prepare('DELETE FROM users WHERE id = ?').run(user.id);

		const { res } = await passwordStep(user);

		expect(res).toMatchObject({ type: 'failure', status: 400, data: { error: SIGN_IN_EXPIRED } });
		expect(challenges()).toEqual([]);
	});

	it('T82: the report for a raised banner is shown once: the next sign-in goes home, and the banner stays', async () => {
		db.update(users)
			.set({ securityBanner: 'unfinished-sign-in', securityBannerAt: stamp(new Date(Date.now() - 60_000)) })
			.where(eq(users.id, user.id))
			.run();

		const first = await signInFully(user, factor);
		expect(first.res).toMatchObject({ type: 'success', data: { signedIn: true } });
		later(60_000);
		const second = await signInFully(user, factor);

		expect(second.res).toMatchObject({ type: 'redirect', status: 303, location: '/' });
		expect(userRow().securityBanner).toBe('unfinished-sign-in');
	});

	it('T83: the sweep at start-up, and then on its timer, raises the unfinished-sign-in signal with no other sign-in', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: Date.now() });
		makeSmtp();
		const other = makeUser();
		giveFactor(other);
		await passwordStep(user);
		later(10 * 60_000);

		// The timer the gate's start-up began, if a case before this one loaded it, is replaced by one on the fake clock.
		stopChallengeSweep();
		startChallengeSweep();
		try {
			expect(challenges()).toEqual([]);
			expect(userRow().securityBanner).toBe('unfinished-sign-in');
			expect(await subjects()).toEqual([NOTICE.unfinished]);

			await passwordStep(other);
			later(10 * 60_000);
			vi.advanceTimersByTime(CHALLENGE_SWEEP_EVERY_MS);
			expect(challenges()).toEqual([]);
			expect(db.select().from(users).where(eq(users.id, other.id)).get()!.securityBanner).toBe('unfinished-sign-in');
		} finally {
			stopChallengeSweep();
		}
	});

	it('T84: one account’s password and then another’s in one browser: the first’s challenge goes, and raises no signal', async () => {
		makeSmtp();
		const other = makeUser();
		giveFactor(other);
		const first = (await passwordStep(user)).challenge!;
		await passwordStep(other, { cookies: { [CHALLENGE_COOKIE]: first } });
		expect(challenges().map((row) => row.user_id)).toEqual([other.id]);

		later(10 * 60_000);
		sweepExpiredChallenges();
		await sent.settle();

		expect(userRow().securityBanner).toBeNull();
		expect(sent.emails.map((mail) => mail.to)).toEqual([other.email]);
	});

	it('T85: the code fields are focused and take 6 digits, or 3 and 3; locked, the page opens on the recovery code, marked with its error', async () => {
		const field = (html: string, id: string) => new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';
		const { challenge } = await passwordStep(user);
		const cookie = `${CHALLENGE_COOKIE}=${challenge}`;
		const page = await (await gate('GET', '/login/verify', { headers: { cookie, accept: 'text/html' } })).text();
		const enrolling = (await passwordStep(enrollable())).challenge;
		const enrolPage = await (await gate('GET', '/login/enrol', { headers: { cookie: `${CHALLENGE_COOKIE}=${enrolling}`, accept: 'text/html' } })).text();
		for (const input of [field(page, 'verify-code'), field(enrolPage, 'enrol-code')]) {
			expect(input).toContain('autofocus');
			expect(input).toContain('maxlength="7"');
			expect(input).toContain('pattern="\\d{3} ?\\d{3}"');
			expect(input).not.toContain('aria-invalid');
		}

		db.update(users).set({ mfaOtherWrong: 30 }).where(eq(users.id, user.id)).run();
		const posted = await (await gate('POST', '/login/verify', { headers: { ...NATIVE_FORM, cookie }, body: 'recoveryCode=not-a-code' })).text();

		expect(posted).toContain(MALFORMED_RECOVERY_CODE);
		expect(posted).toContain('id="verify-error"');
		expect(field(posted, 'verify-code')).toBe('');
		const recovery = field(posted, 'verify-recovery');
		for (const attribute of [
			'autocapitalize="characters"',
			'autocorrect="off"',
			'spellcheck="false"',
			'aria-invalid="true"',
			'aria-describedby="verify-error"',
			'autofocus'
		]) {
			expect(recovery).toContain(attribute);
		}
	}, 60_000);

	it('T86: a pending sign-in whose account no longer holds a factor: a code is 503, uncounted, and said at ERROR', async () => {
		const { challenge } = await passwordStep(user);
		sqlite.prepare('DELETE FROM mfa_factors WHERE user_id = ?').run(user.id);

		const { result: res, lines } = await logged(() => verify(challenge, { code: codeFor(factor.secret) }));

		expect(res).toMatchObject({ type: 'failure', status: 503, data: { error: FACTOR_UNUSABLE } });
		expect(challenges()[0].wrong_count).toBe(0);
		expect(userRow()).toMatchObject({ mfaOtherWrong: 0, failedCodesSinceSignIn: 0 });
		expect(lines.filter((line) => line.level === 'ERROR').map((line) => line.message)).toEqual([
			expect.stringContaining('has a pending sign-in and no second factor')
		]);
	});
});

// ─── Slice 3: the set-up page's pieces ───────────────────────────────────────

describe('what setting up is built from (slice 3)', () => {
	it('T45: createSession is called only by the second step and by a password change that holds the code', () => {
		const callers: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const path = `${dir}/${name}`;
				if (statSync(path).isDirectory()) walk(path);
				else if (path.endsWith('.ts')) {
					const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
					const visit = (node: ts.Node) => {
						if (ts.isCallExpression(node) && /(^|\.)createSession$/.test(node.expression.getText())) callers.push(path);
						ts.forEachChild(node, visit);
					};
					visit(source);
				}
			}
		};
		walk('src');

		expect([...new Set(callers)].sort()).toEqual(['src/lib/server/second-step.ts', 'src/routes/api/account/password/+server.ts']);
	});

	it('T46: base32 meets RFC 4648; the otpauth text keeps a space and a colon in a name; the secret is shown in groups of four', () => {
		for (const [plain, encoded] of [
			['', ''],
			['f', 'MY======'],
			['fo', 'MZXQ===='],
			['foo', 'MZXW6==='],
			['foob', 'MZXW6YQ='],
			['fooba', 'MZXW6YTB'],
			['foobar', 'MZXW6YTBOI======']
		]) {
			expect(base32(Buffer.from(plain, 'ascii')), plain).toBe(encoded);
		}

		// RFC 6238's own secret.
		const secret = Buffer.from('12345678901234567890', 'ascii');
		expect(otpauthUri('pat smith:ops', secret)).toBe(
			'otpauth://totp/DumpFire:pat%20smith%3Aops?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=DumpFire&algorithm=SHA1&digits=6&period=30'
		);
		expect(secretInGroups(secret)).toBe('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ');
	});

	it('T47: uqr is pinned at exactly 0.1.3, and the lock agrees; the QR code is an SVG image with its namespace, as a data: address', () => {
		const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
		const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
		expect(pkg.dependencies.uqr).toBe('0.1.3');
		expect(lock.packages[''].dependencies.uqr).toBe('0.1.3');
		expect(lock.packages['node_modules/uqr'].version).toBe('0.1.3');

		const uri = qrDataUri('otpauth://totp/DumpFire:pat?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=DumpFire');
		expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
		const svg = Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
		expect(svg.startsWith('<svg')).toBe(true);
		expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
	});
});
