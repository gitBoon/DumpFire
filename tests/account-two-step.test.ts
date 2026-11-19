/**
 * Two-step sign-in on the Account page (card 2772,
 * docs/planning/card-2772-account-two-step.md, section 5.1).
 *
 * Slice S1, every authenticator tried (D4, T1 to T3): `matchFactors`, the one
 * matcher of sign-in and the step-up, which tries a code against every
 * authenticator of the account with no early exit, one secret at a time,
 * prefers an unspent match and calls a code spent only when every match is;
 * and `pauseCrossed`, the pause a lane's count crosses when one wrong code
 * moves it by the number of authenticators tried. What sign-in and the
 * step-up do with them is tests/two-step-sign-in.test.ts (T4 to T6) and
 * tests/step-up.test.ts (T7 to T9).
 *
 * Slice S3, the section (D1-D3, D6, D10, T17 to T29): adding an
 * authenticator, a step-up and then the new phone's code, held in memory one
 * per account between the two; removing one, never the last nor the last
 * that opens, which ends the account's other sessions; a new set of recovery
 * codes; That was me, which clears only the warning shown; and what the
 * Account page loads.
 *
 * Against the application's own in-memory database, emptied before each
 * test, and the test process's own MFA key, written nowhere, which a test
 * may take away (`keyStub`). `checkPassword` is stood in for, so that a test
 * can count the compares made and hold one in flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => ({
	/** Password compares begun since the test began. */
	compared: 0,
	/**
	 * Compares finished and now waiting on `hold`: what a test waits for before
	 * it lets held checks go together (card 2916). `compared` counts a compare
	 * when it begins, so it can reach 2 while the second is still to be made.
	 */
	parked: 0,
	/**
	 * While set, each compare, once made, waits for it to answer: a check held
	 * in flight. Made first, so that checks released together once all are
	 * parked answer in one turn, as two requests whose compares end together
	 * do (T26).
	 */
	hold: undefined as Promise<void> | undefined
}));

vi.mock('$lib/server/passwords', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/passwords')>();
	return {
		...real,
		checkPassword: async (...args: Parameters<typeof real.checkPassword>) => {
			stub.compared++;
			const checked = await real.checkPassword(...args);
			stub.parked++;
			await stub.hold;
			return checked;
		}
	};
});

/** No MFA key loaded, while `none` is set (T18). */
const keyStub = vi.hoisted(() => ({ none: false }));
vi.mock('$lib/server/mfa-key', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/mfa-key')>();
	return { ...real, currentMfaKey: () => (keyStub.none ? null : real.currentMfaKey()) };
});

import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { mfaFactors, mfaRecoveryCodes, reportSchedules, sessions, signInChallenges, users } from '$lib/server/db/schema';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import {
	ADD_ENDED,
	ADD_REPLACED,
	ADD_TOO_MANY,
	AUTHENTICATOR_NOT_FOUND,
	MOST_AUTHENTICATORS_WORDS,
	NEWER_BANNER,
	NEW_CODE_MALFORMED,
	NONE_OTHER_OPENS,
	ONLY_AUTHENTICATOR
} from '$lib/server/account-two-step';
import { subscribeToLogs, type LogEntry } from '$lib/server/logger';
import { addTotpFactor, matchFactors, resetTwoStep, spendStep } from '$lib/server/mfa-store';
import { pendingAddOf } from '$lib/server/pending-authenticators';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { ENROL_WRONG_CODE, NO_MFA_KEY, WRONG_RECOVERY_CODE } from '$lib/server/second-step';
import { pauseCrossed } from '$lib/server/sign-in-challenges';
import * as totp from '$lib/server/totp';
import { newTotpSecret, stepAt } from '$lib/server/totp';
import { PASSWORD_CHANGED_MEANWHILE } from '$lib/step-up-words';
import { stamp } from '$lib/timestamps';
import { action, pageLoad } from './helpers/actions';
import { api, type ApiResult } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import {
	FIXTURE_PASSWORD,
	makeApiKey,
	makeBoard,
	makeSession,
	makeSmtp,
	makeUser,
	makeWebhook,
	resetDb,
	sessionHashOf,
	stepUp
} from './helpers/fixtures';
import { diffSnapshots, snapshotDb } from './helpers/snapshot';
import { codeFor, giveAuthenticator, giveFactor, passwordStep, verify, wrongCodeFor } from './helpers/two-step';

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	stub.compared = 0;
	stub.parked = 0;
	stub.hold = undefined;
	keyStub.none = false;
});

afterEach(() => {
	stub.hold = undefined;
	keyStub.none = false;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** The console's ERROR lines that say a factor could not be opened, while `fn` runs. */
function unopened<T>(fn: () => T): { result: T; lines: string[] } {
	const error = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		const result = fn();
		return { result, lines: error.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('A second factor could not be opened')) };
	} finally {
		error.mockRestore();
	}
}

describe('every authenticator tried (card 2772, S1)', () => {
	it('T1. matchFactors finds a later authenticator and skips one that does not open: every one looked at, each opened secret zeroed, no early exit', () => {
		const user = makeUser();
		const first = giveFactor(user);
		const second = giveAuthenticator(user, 'Spare phone');
		const third = giveAuthenticator(user, 'New phone');
		db.update(mfaFactors).set({ keyId: 'another-key' }).where(eq(mfaFactors.id, first.factorId)).run();
		const at = Date.now();
		// Each secret compared, and whether the one before it was zeroed by the time it was opened.
		const opened: Buffer[] = [];
		const zeroedBefore: boolean[] = [];
		const compared = vi.spyOn(totp, 'matchingStep').mockImplementation((secret, code, nowMs) => {
			zeroedBefore.push(opened.every((earlier) => earlier.every((byte) => byte === 0)));
			opened.push(secret);
			return totp.hotp(secret, stepAt(nowMs)) === code ? stepAt(nowMs) : null;
		});

		const { result, lines } = unopened(() => matchFactors(user.id, codeFor(third.secret, at), at));

		expect(result).toEqual({ tried: 2, unusable: 1, matched: { factorId: third.factorId, step: stepAt(at) }, spent: false });
		// The first said once at ERROR, as factorSecret says it; the other two opened and compared.
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`factor ${first.factorId} of user ${user.id}`);
		expect(compared).toHaveBeenCalledTimes(2);
		// One plaintext secret at a time: each zeroed before the next was opened, and the last after.
		expect(zeroedBefore).toEqual([true, true]);
		expect(opened.map((secret) => secret.every((byte) => byte === 0))).toEqual([true, true]);
		compared.mockRestore();

		// The second's code: matched, and the third is still tried after it.
		const tried = vi.spyOn(totp, 'matchingStep');
		const { result: bySecond } = unopened(() => matchFactors(user.id, codeFor(second.secret, at), at));
		expect(bySecond).toEqual({ tried: 2, unusable: 1, matched: { factorId: second.factorId, step: stepAt(at) }, spent: false });
		expect(tried).toHaveBeenCalledTimes(2);

		// Nothing is spent by a look.
		expect(db.select({ lastStep: mfaFactors.lastStep }).from(mfaFactors).all()).toEqual([{ lastStep: null }, { lastStep: null }, { lastStep: null }]);
	});

	it('T2. matchFactors prefers an unspent match, and calls a code spent only when every match is spent (S6)', () => {
		const user = makeUser();
		// A seam: two factors of one secret, so that one code matches both.
		const secret = newTotpSecret();
		const first = addTotpFactor(user.id, 'Phone', secret).id;
		const second = addTotpFactor(user.id, 'The same phone', secret).id;
		const at = Date.now();
		const code = codeFor(secret, at);

		// Neither spent: the lowest id.
		expect(matchFactors(user.id, code, at)).toEqual({ tried: 2, unusable: 0, matched: { factorId: first, step: stepAt(at) }, spent: false });

		// The first's step spent: the second's match, unspent.
		expect(spendStep(first, stepAt(at))).toBe('spent');
		expect(matchFactors(user.id, code, at)).toEqual({ tried: 2, unusable: 0, matched: { factorId: second, step: stepAt(at) }, spent: false });

		// Both spent: no match to spend, and spent.
		expect(spendStep(second, stepAt(at))).toBe('spent');
		expect(matchFactors(user.id, code, at)).toEqual({ tried: 2, unusable: 0, matched: null, spent: true });

		// A wrong code is not spent.
		expect(matchFactors(user.id, wrongCodeFor(secret, at), at)).toEqual({ tried: 2, unusable: 0, matched: null, spent: false });
	});

	it.each([
		[4, 6, 15],
		[9, 11, 60],
		[14, 16, 240],
		[19, 21, 1440],
		[24, 26, 1440],
		[27, 30, 'locked'],
		[28, 31, 'locked'],
		[5, 7, null],
		[0, 1, null]
	] as const)('T3. pauseCrossed(%s, %s) is %s', (before, after, pause) => {
		expect(pauseCrossed(before, after)).toBe(pause);
	});
});

// ─── S3: the section ────────────────────────────────────────────────────────

/** A write refused after the password and code were checked leaves the code's step spent, and nothing else (card 2771, S4). */
const SPENT_ALONE = [expect.stringMatching(/^mfa_factors: row \d+ changed \(last_step: null became \d+; last_used_at: null became /)];

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The secret the start answered in groups of four, as the new phone's app reads it. */
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

/** The status and body of an answer, to compare in one. */
const answer = (res: ApiResult) => ({ status: res.status, body: res.body });

/** The session code a request's cookie carries. */
const tokenOf = (req: { headers: Record<string, string> }) => req.headers.cookie.slice(`${SESSION_COOKIE_NAME}=`.length);

/** The session's count of wrong current passwords, or undefined once it has gone. */
const countOf = (token: string) =>
	db.select({ count: sessions.wrongPasswordCount }).from(sessions).where(eq(sessions.tokenHash, sessionHashOf(token))).get()?.count;

/** The account's authenticators, by id. */
const factorsOf = (user: { id: number }) => db.select().from(mfaFactors).where(eq(mfaFactors.userId, user.id)).orderBy(mfaFactors.id).all();

/** The account's recovery codes not yet used. */
const unusedCodes = (user: { id: number }) =>
	db.select({ usedAt: mfaRecoveryCodes.usedAt }).from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, user.id)).all().filter((code) => code.usedAt === null).length;

/** The account's row. */
const userRow = (user: { id: number }) => db.select().from(users).where(eq(users.id, user.id)).get()!;

/** The clock moved on by `ms`. */
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

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
		process.env.LOG_LEVEL = 'ERROR';
	}
}

/** The AUTH lines among `lines` whose message starts with `start`, as level and message. */
const authLines = (lines: LogEntry[], start: string) =>
	lines.filter((line) => line.context === 'AUTH' && line.message.startsWith(start)).map((line) => ({ level: line.level, message: line.message }));

/** Begin adding, with the password and the account's code, from a session made for it. */
const start = (user: SessionUser, label: unknown = 'Spare phone', req = stepUp(user, { label })) =>
	api('POST', '/api/account/two-step/authenticators', req);

/** The new phone's code, sent with the pending id from the session whose code is `token`. */
const confirm = (user: SessionUser, token: string, pendingId: string, code: string) =>
	api('POST', '/api/account/two-step/authenticators/confirm', {
		user,
		body: { pendingId, code },
		headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` }
	});

/** Remove the authenticator `id`, with `req` (a step-up's). */
const remove = (id: number, req: ReturnType<typeof stepUp>) => api('DELETE', `/api/account/two-step/authenticators/${id}`, req);

/** A start that went through: its answer, the session it came from, and the new phone's secret. */
async function started(user: SessionUser, label = 'Spare phone') {
	const req = stepUp(user, { label });
	const res = await start(user, label, req);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return { res, token: tokenOf(req), pendingId: res.body.pendingId as string, secret: secretOf(res.body.secret) };
}

describe('the Two-step sign-in section (card 2772, S3)', () => {
	let sent: Effects;

	beforeEach(() => {
		// A frozen clock, so that a code and its check fall in one step; timers run as ever.
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date());
		makeSmtp();
		sent = effects();
	});

	afterEach(() => {
		sent.restore();
	});

	/** The mail sent, once every send has started. */
	async function mails() {
		await sent.settle();
		return sent.emails;
	}

	it('T17. start adding: 200 with the pending id, account, issuer, the secret in groups of four, its QR code and an end ten minutes on, no-store; nothing written to the factors; the name kept collapsed; an INFO line', async () => {
		const user = makeUser();
		giveFactor(user);
		const req = stepUp(user, { label: '  Work \t phone ' });

		const { result: res, lines } = await logged(() => start(user, undefined, req));

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toEqual({
			pendingId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			account: user.username,
			issuer: 'DumpFire',
			secret: expect.stringMatching(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/),
			qr: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
			expiresAt: stamp(new Date(Date.now() + 10 * 60_000))
		});
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(factorsOf(user)).toHaveLength(1);
		expect(pendingAddOf(user.id)).toMatchObject({ userId: user.id, label: 'Work phone', wrong: 0 });
		expect(authLines(lines, 'Authenticator')).toEqual([{ level: 'INFO', message: `Authenticator set-up begun by user ${user.id}` }]);
		// Nothing of the secret, the pending id or the name in any line.
		const said = JSON.stringify(lines);
		expect(said).not.toContain(res.body.pendingId);
		expect(said).not.toContain(res.body.secret);
		expect(said).not.toContain('Work phone');
	});

	it('T18. start refused in the guard: at three authenticators 409, with no MFA key 503 NO_MFA_KEY; no compare and the count 0 for both', async () => {
		const full = makeUser();
		giveFactor(full);
		giveAuthenticator(full, 'Spare phone');
		giveAuthenticator(full, 'New phone');
		const keyless = makeUser();
		giveFactor(keyless);

		for (const [user, refused, keyGone] of [
			[full, { status: 409, body: { message: MOST_AUTHENTICATORS_WORDS } }, false],
			[keyless, { status: 503, body: { message: NO_MFA_KEY } }, true]
		] as const) {
			const req = stepUp(user, { label: 'Another' });
			keyStub.none = keyGone;
			const before = snapshotDb();

			const res = await start(user, 'Another', req);

			expect(answer(res), user.username).toEqual(refused);
			expect(stub.compared).toBe(0);
			expect(countOf(tokenOf(req))).toBe(0);
			expect(diffSnapshots(before, snapshotDb())).toEqual([]);
			expect(pendingAddOf(user.id)).toBeUndefined();
		}
	});

	it('T19. start proven by a recovery code: 200, that code spent, nine left', async () => {
		const user = makeUser();
		const factor = giveFactor(user);

		const res = await start(user, 'Spare phone', stepUp(user, { label: 'Spare phone' }, FIXTURE_PASSWORD, factor.recoveryCodes[0]));

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(unusedCodes(user)).toBe(9);
		expect(pendingAddOf(user.id)).toBeDefined();
	});

	it('T20. confirm with the new phone’s code: 201; a factor with the name, its step spent; the set-up forgotten, so a second confirm is 409 ADD_ENDED; an INFO line; one factor-added notice naming the name and the date', async () => {
		const user = makeUser();
		giveFactor(user);
		const { token, pendingId, secret } = await started(user, 'Spare <b>phone</b>');
		sent.clear();

		// The step spent is the code's own: compared with the moment it was made, not the end of the test (card 2916).
		const at = Date.now();

		const { result: res, lines } = await logged(() => confirm(user, token, pendingId, codeFor(secret, at)));

		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const added = factorsOf(user)[1];
		expect(res.body).toEqual({ id: added.id, label: 'Spare <b>phone</b>', createdAt: added.createdAt });
		expect(added).toMatchObject({ label: 'Spare <b>phone</b>', kind: 'totp', lastStep: stepAt(at) });
		expect(pendingAddOf(user.id)).toBeUndefined();
		expect(authLines(lines, 'Authenticator')).toEqual([{ level: 'INFO', message: `Authenticator ${added.id} added by user ${user.id}` }]);
		const notices = await mails();
		expect(notices.map((mail) => mail.subject)).toEqual(['An authenticator was added to your DumpFire account']);
		expect(notices[0].html).toContain(`Spare &lt;b&gt;phone&lt;/b&gt; (added ${added.createdAt} UTC)`);

		expect(answer(await confirm(user, token, pendingId, codeFor(secret)))).toEqual({ status: 409, body: { message: ADD_ENDED } });
		expect(factorsOf(user)).toHaveLength(2);
	});

	it('T21. confirm with a wrong or a malformed code: a wrong one 400 ENROL_WRONG_CODE, nothing written, counted once; a malformed one 400, not counted; the fifth wrong 409 ADD_TOO_MANY, the set-up forgotten', async () => {
		const user = makeUser();
		giveFactor(user);
		const { token, pendingId, secret } = await started(user);
		const wrong = wrongCodeFor(secret);
		const before = snapshotDb();

		expect(answer(await confirm(user, token, pendingId, wrong))).toEqual({ status: 400, body: { message: ENROL_WRONG_CODE } });
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		expect(pendingAddOf(user.id)?.wrong).toBe(1);

		expect(answer(await confirm(user, token, pendingId, '12a456'))).toEqual({ status: 400, body: { message: NEW_CODE_MALFORMED } });
		expect(pendingAddOf(user.id)?.wrong).toBe(1);

		for (let n = 2; n <= 4; n++) expect((await confirm(user, token, pendingId, wrong)).status).toBe(400);
		expect(answer(await confirm(user, token, pendingId, wrong))).toEqual({ status: 409, body: { message: ADD_TOO_MANY } });
		expect(pendingAddOf(user.id)).toBeUndefined();
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		// The right code is too late now.
		expect(answer(await confirm(user, token, pendingId, codeFor(secret)))).toEqual({ status: 409, body: { message: ADD_ENDED } });
	});

	it('T22. confirm refused, nothing written: replaced by a start from another session, ADD_REPLACED, for the last two replaced; from another session, a made-up id or an older one, ADD_ENDED; ten minutes on, ADD_ENDED; the password changed meanwhile; three reached meanwhile', async () => {
		const user = makeUser();
		giveFactor(user);

		// Replaced: the first page's pending id, after a start from another session.
		const first = await started(user);
		const second = await started(user);
		const another = makeSession(user);
		let before = snapshotDb();
		expect(answer(await confirm(user, first.token, first.pendingId, codeFor(first.secret)))).toEqual({ status: 409, body: { message: ADD_REPLACED } });
		// From another session of the account, with the live one's id and code.
		expect(answer(await confirm(user, another, second.pendingId, codeFor(second.secret)))).toEqual({ status: 409, body: { message: ADD_ENDED } });
		// A made-up id while an add is live, from another session or the add's own: ADD_ENDED, as with none live,
		// so that a session learns nothing of an add under way (code review CS2).
		const madeUp = 'A'.repeat(43);
		expect(answer(await confirm(user, another, madeUp, codeFor(second.secret)))).toEqual({ status: 409, body: { message: ADD_ENDED } });
		expect(answer(await confirm(user, second.token, madeUp, codeFor(second.secret)))).toEqual({ status: 409, body: { message: ADD_ENDED } });
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		expect(pendingAddOf(user.id)).toBeDefined();

		// The last two replaced ids alone are remembered: two more starts, and the first is told ADD_ENDED.
		const third = await started(user);
		const fourth = await started(user);
		before = snapshotDb();
		expect(answer(await confirm(user, first.token, first.pendingId, codeFor(first.secret)))).toEqual({ status: 409, body: { message: ADD_ENDED } });
		for (const replaced of [second, third]) {
			expect(answer(await confirm(user, replaced.token, replaced.pendingId, codeFor(replaced.secret)))).toEqual({ status: 409, body: { message: ADD_REPLACED } });
		}
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);

		// Ten minutes on.
		later(10 * 60_000);
		before = snapshotDb();
		expect(answer(await confirm(user, fourth.token, fourth.pendingId, codeFor(fourth.secret)))).toEqual({ status: 409, body: { message: ADD_ENDED } });
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		// An add that had ended when the next began was not replaced by it: still ADD_ENDED.
		const lapsed = await started(user);
		later(10 * 60_000);
		await started(user);
		expect(answer(await confirm(user, lapsed.token, lapsed.pendingId, codeFor(lapsed.secret)))).toEqual({ status: 409, body: { message: ADD_ENDED } });

		// The password changed meanwhile, as another way of setting it would.
		const changed = await started(user);
		db.update(users).set({ passwordHash: '$2b$04$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }).where(eq(users.id, user.id)).run();
		before = snapshotDb();
		expect(answer(await confirm(user, changed.token, changed.pendingId, codeFor(changed.secret)))).toEqual({
			status: 409,
			body: { message: PASSWORD_CHANGED_MEANWHILE }
		});
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		expect(pendingAddOf(user.id)).toBeUndefined();

		// Three reached meanwhile.
		const other = makeUser();
		giveFactor(other);
		const late = await started(other);
		giveAuthenticator(other, 'Second');
		giveAuthenticator(other, 'Third');
		before = snapshotDb();
		expect(answer(await confirm(other, late.token, late.pendingId, codeFor(late.secret)))).toEqual({ status: 409, body: { message: MOST_AUTHENTICATORS_WORDS } });
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		expect(pendingAddOf(other.id)).toBeUndefined();
	});

	it('T23. the set-up is forgotten on any sign-out of the account, its own password change and a reset of its two-step sign-in: the old pending id is then 409 ADD_ENDED, or 401 where its session went', async () => {
		const user = makeUser();
		giveFactor(user);

		// Another browser of the account signs out.
		const kept = await started(user);
		const elsewhere = makeSession(user);
		const out = await action('/logout', { user, cookies: { [SESSION_COOKIE_NAME]: elsewhere } });
		expect(out).toMatchObject({ type: 'redirect', location: '/login' });
		expect(pendingAddOf(user.id)).toBeUndefined();
		expect(answer(await confirm(user, kept.token, kept.pendingId, codeFor(kept.secret)))).toEqual({ status: 409, body: { message: ADD_ENDED } });

		// The account's own password change, from another session: every session but the new one ends.
		const before = await started(user);
		const changed = await api('PUT', '/api/account/password', stepUp(user, { newPassword: 'a long new password' }));
		expect(changed.status, JSON.stringify(changed.body)).toBe(200);
		expect(pendingAddOf(user.id)).toBeUndefined();
		expect((await confirm(user, before.token, before.pendingId, codeFor(before.secret))).status).toBe(401);

		// A reset of its two-step sign-in.
		const other = makeUser();
		giveFactor(other);
		const reset = await started(other);
		inTransaction(() => resetTwoStep(other.id, 'admin-reset', { cause: { log: 'a test', mail: 'a test' } }));
		expect(pendingAddOf(other.id)).toBeUndefined();
		expect((await confirm(other, reset.token, reset.pendingId, codeFor(reset.secret))).status).toBe(401);
	});

	it('T24. remove: 200; the factor gone; the account’s other sessions ended and this one kept; pending sign-ins ended; another session’s set-up forgotten; a WARN line; one factor-removed notice with the live key and webhook, the report schedule that is on (left on, card 2894), what to revoke, and the lost device', async () => {
		const user = makeUser();
		giveFactor(user);
		const spare = giveAuthenticator(user, 'Old phone');
		makeApiKey(user, 'Deploy script');
		const { board: ops } = makeBoard({ owner: user, name: 'Ops' });
		makeWebhook(ops, { url: 'https://hooks.example.test/x?secret=s', setBy: user });
		// Card 2894 (case 6, D4): a report schedule that is on, listed in the notice and left on.
		const schedule = db
			.insert(reportSchedules)
			.values({ userId: user.id, name: 'Weekly ops', scope: 'board', scopeId: ops.id, recipients: 'a@example.test, b@example.test' })
			.returning()
			.get();
		// Another browser, a sign-in waiting for its code, and a set-up begun in another session.
		const other = makeSession(user);
		await passwordStep(user);
		const elsewhere = await started(user);
		const req = stepUp(user);
		sent.clear();

		const { result: res, lines } = await logged(() => remove(spare.factorId, req));

		expect(answer(res)).toEqual({ status: 200, body: { success: true, sessionsEnded: 2 } });
		expect(factorsOf(user).map((factor) => factor.label)).toEqual(['Authenticator']);
		expect(countOf(tokenOf(req))).toBe(0);
		expect(countOf(other)).toBeUndefined();
		expect(countOf(elsewhere.token)).toBeUndefined();
		expect(db.select().from(signInChallenges).where(eq(signInChallenges.userId, user.id)).all()).toEqual([]);
		expect(pendingAddOf(user.id)).toBeUndefined();
		expect(authLines(lines, 'Authenticator')).toEqual([
			{ level: 'WARN', message: `Authenticator ${spare.factorId} removed by its owner, user ${user.id}: 2 other session(s) ended` }
		]);
		const notices = await mails();
		expect(notices.map((mail) => mail.subject)).toEqual(['An authenticator was removed from your DumpFire account']);
		expect(notices[0].html).toContain('Old phone (added ');
		expect(notices[0].html).toContain('Deploy script');
		expect(notices[0].html).toContain('Ops, to hooks.example.test');
		expect(notices[0].html).not.toContain('secret=s');
		expect(notices[0].html).toContain('Your report schedules that are on:');
		expect(notices[0].html).toContain('<li>Weekly ops, a report of the board &quot;Ops&quot;, emailed to: a@example.test, b@example.test</li>');
		expect(notices[0].html).toMatch(/revoke or delete any you do not recognise/i);
		expect(notices[0].html).toContain('If the device was lost, also change your password');
		// Listed, and not paused.
		expect(db.select().from(reportSchedules).where(eq(reportSchedules.id, schedule.id)).get()).toEqual(schedule);
	});

	it('T25. remove refused in the guard: the only authenticator 409, two with the other not opening 409, another account’s or an unknown id 404; no compare and the count 0 for each', async () => {
		const alone = makeUser();
		const only = giveFactor(alone);
		const pair = makeUser();
		const first = giveFactor(pair);
		const unopenable = giveAuthenticator(pair, 'Old phone');
		db.update(mfaFactors).set({ keyId: 'another-key' }).where(eq(mfaFactors.id, unopenable.factorId)).run();
		const stranger = makeUser();
		const theirs = giveFactor(stranger);
		giveAuthenticator(stranger, 'Their spare');

		for (const [user, id, refused] of [
			[alone, only.factorId, { status: 409, body: { message: ONLY_AUTHENTICATOR } }],
			[pair, first.factorId, { status: 409, body: { message: NONE_OTHER_OPENS } }],
			[alone, theirs.factorId, { status: 404, body: { message: AUTHENTICATOR_NOT_FOUND } }],
			[alone, 99_999, { status: 404, body: { message: AUTHENTICATOR_NOT_FOUND } }]
		] as const) {
			const req = stepUp(user);
			stub.compared = 0;
			const before = snapshotDb();

			const res = await remove(id, req);

			expect(answer(res), `${user.username} ${id}`).toEqual(refused);
			expect(stub.compared).toBe(0);
			expect(countOf(tokenOf(req))).toBe(0);
			expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		}
	});

	it('T26. two removals at once, from two sessions of one account, each past its guard with its compare held: one 200, and the other signed out by the first’s write, its only change its code’s spend; one factor left', async () => {
		const user = makeUser();
		const a = giveFactor(user);
		const b = giveAuthenticator(user, 'Spare phone');
		// Each session sends the code of the authenticator it removes, both made at one moment (card 2916).
		const at = Date.now();
		const byA = stepUp(user, {}, FIXTURE_PASSWORD, codeFor(a.secret, at));
		const byB = stepUp(user, {}, FIXTURE_PASSWORD, codeFor(b.secret, at));
		const release = holdChecks();

		const removingA = remove(a.factorId, byA);
		const removingB = remove(b.factorId, byB);
		// Both compares made and held, not merely begun: neither can then write before the other's check ends (card 2916).
		await vi.waitFor(() => expect(stub.parked).toBe(2));
		const before = snapshotDb();
		release();
		const [resA, resB] = await Promise.all([removingA, removingB]);

		// The first to write wins; the other's session was ended by it.
		const [winner, loser, kept, gone] = resA.status === 200 ? [byA, byB, b, a] : [byB, byA, a, b];
		const won = resA.status === 200 ? resA : resB;
		const lost = resA.status === 200 ? resB : resA;
		expect(answer(won)).toEqual({ status: 200, body: { success: true, sessionsEnded: 1 } });
		// Its code proven and spent before the first's write ended its session: the write finds it signed out.
		expect(answer(lost)).toEqual({ status: 401, body: { message: 'Not authenticated' } });
		expect(countOf(tokenOf(winner))).toBe(0);
		expect(countOf(tokenOf(loser))).toBeUndefined();
		expect(factorsOf(user).map((factor) => factor.id)).toEqual([kept.factorId]);
		// The whole of what changed since both compares were counted (code review CR3): the winner's writes (its
		// factor removed, its count of 2 cleared, the loser's session ended) and the loser's one change, its code's
		// step spent on the factor left. Each table's lines in row order: a's factor and byA's session were made first.
		const removed = expect.stringMatching(new RegExp(`^mfa_factors: row ${gone.factorId} was removed \\(`));
		const cleared = expect.stringMatching(/^sessions: row \d+ changed \(wrong_password_count: 2 became 0\)$/);
		const ended = expect.stringMatching(/^sessions: row \d+ was removed \(/);
		expect(diffSnapshots(before, snapshotDb())).toEqual([
			...(gone === a ? [removed, ...SPENT_ALONE] : [...SPENT_ALONE, removed]),
			...(winner === byA ? [cleared, ended] : [ended, cleared])
		]);
		expect(factorsOf(user)[0].lastStep).toBe(stepAt(at));
	});

	it('T27. a new set of recovery codes: 200, ten in XXXX-XXXX-XXXX-XXXX, no-store; an old one refused at sign-in; ten unused rows; an INFO line; one codes-regenerated notice', async () => {
		const user = makeUser();
		const factor = giveFactor(user);
		sent.clear();

		const { result: res, lines } = await logged(() => api('POST', '/api/account/two-step/recovery-codes', stepUp(user)));

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.codes).toHaveLength(10);
		for (const code of res.body.codes) expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(unusedCodes(user)).toBe(10);
		expect(db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, user.id)).all()).toHaveLength(10);
		expect(authLines(lines, 'Recovery codes')).toEqual([{ level: 'INFO', message: `Recovery codes regenerated by user ${user.id}` }]);
		expect(JSON.stringify(lines)).not.toContain(res.body.codes[0]);
		expect((await mails()).map((mail) => mail.subject)).toEqual(['New recovery codes were made for your DumpFire account']);

		const { challenge } = await passwordStep(user);
		const old = await verify(challenge, { recoveryCode: factor.recoveryCodes[0] });
		expect(old).toMatchObject({ type: 'failure', data: { error: WRONG_RECOVERY_CODE } });
		const fresh = await verify(challenge, { recoveryCode: res.body.codes[0] });
		expect(fresh.type).not.toBe('failure');
	});

	it('T28. the warning is cleared only as shown: That was me with the shown time clears both columns and logs it, and a wrong code at sign-in straight after raises it again with a notice; an older time after a newer warning is 409, nothing cleared, no compare; the own password change clears it', async () => {
		const user = makeUser();
		const factor = giveFactor(user);
		const shown = stamp(new Date(Date.now() - 60_000));
		db.update(users).set({ securityBanner: 'wrong-code', securityBannerAt: shown }).where(eq(users.id, user.id)).run();

		const { result: res, lines } = await logged(() => api('DELETE', '/api/account/two-step/banner', stepUp(user, { bannerAt: shown })));

		expect(answer(res)).toEqual({ status: 200, body: { success: true } });
		expect(userRow(user)).toMatchObject({ securityBanner: null, securityBannerAt: null, securitySignalLastAt: null });
		expect(authLines(lines, 'Security banner')).toEqual([{ level: 'INFO', message: `Security banner dismissed by user ${user.id}` }]);

		// Straight after, within the hour, a wrong code at sign-in raises it again, and says so.
		sent.clear();
		const { challenge } = await passwordStep(user);
		await verify(challenge, { code: wrongCodeFor(factor.secret) });
		expect(userRow(user)).toMatchObject({ securityBanner: 'wrong-code', securityBannerAt: stamp(), securitySignalLastAt: stamp() });
		expect((await mails()).map((mail) => mail.subject)).toContain('Your DumpFire password was used with a wrong code');

		// A newer warning than the page showed: refused before the password, nothing cleared.
		const newer = stamp();
		const req = stepUp(user, { bannerAt: shown });
		stub.compared = 0;
		const before = snapshotDb();
		expect(answer(await api('DELETE', '/api/account/two-step/banner', req))).toEqual({ status: 409, body: { message: NEWER_BANNER } });
		expect(stub.compared).toBe(0);
		expect(countOf(tokenOf(req))).toBe(0);
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		expect(userRow(user).securityBannerAt).toBe(newer);

		// The holder's own password change clears it.
		const changed = await api('PUT', '/api/account/password', stepUp(user, { newPassword: 'a long new password' }));
		expect(changed.status, JSON.stringify(changed.body)).toBe(200);
		expect(userRow(user)).toMatchObject({ securityBanner: null, securityBannerAt: null, securitySignalLastAt: null });
	});

	it('T28b. a signal inside the hour, which raises no new banner and mails nothing, still makes That was me sent with the older moment 409, no compare, nothing cleared; the page then shows the latest, and That was me with it clears all three columns (code review CS1)', async () => {
		const user = makeUser();
		const factor = giveFactor(user);
		const wrongCodeAtSignIn = async () => {
			const { challenge } = await passwordStep(user);
			await verify(challenge, { code: wrongCodeFor(factor.secret) });
		};
		const bannerShown = async () => {
			const res = await pageLoad('/account', { user });
			if (res.type !== 'data') throw new Error(JSON.stringify(res));
			return res.data.twoStep.banner;
		};

		// The first signal raises the banner; the page shows it and its moment.
		await wrongCodeAtSignIn();
		const raised = stamp();
		expect(await bannerShown()).toEqual({ words: expect.any(String), at: raised, latestAt: raised });

		// Five minutes on, a second: absorbed by the hour, so the banner and its time stay, and no mail goes.
		later(5 * 60_000);
		sent.clear();
		await wrongCodeAtSignIn();
		const latest = stamp();
		expect(userRow(user)).toMatchObject({ securityBanner: 'wrong-code', securityBannerAt: raised, securitySignalLastAt: latest });
		expect(await mails()).toEqual([]);

		// That was me sent with what the page showed before it: refused before the password, nothing cleared.
		const req = stepUp(user, { bannerAt: raised });
		stub.compared = 0;
		const before = snapshotDb();
		expect(answer(await api('DELETE', '/api/account/two-step/banner', req))).toEqual({ status: 409, body: { message: NEWER_BANNER } });
		expect(stub.compared).toBe(0);
		expect(countOf(tokenOf(req))).toBe(0);
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);

		// The page read again shows the latest, and That was me with it clears the banner, its time and the latest.
		expect(await bannerShown()).toEqual({ words: expect.any(String), at: raised, latestAt: latest });
		expect(answer(await api('DELETE', '/api/account/two-step/banner', stepUp(user, { bannerAt: latest })))).toEqual({ status: 200, body: { success: true } });
		expect(userRow(user)).toMatchObject({ securityBanner: null, securityBannerAt: null, securitySignalLastAt: null });
	});

	it('T29. what the pages load: each authenticator’s id, name, kind, added and last used and nothing else; no recovery code or pending id; the codes left in the words of D3; the warning; the last sign-in, and the wrong codes only when there were any; the layout’s authenticators', async () => {
		const user = makeUser();
		const factor = giveFactor(user);
		giveAuthenticator(user, 'Spare phone');
		const pending = await started(user, 'Third phone');
		db.update(users)
			.set({ lastSignInAt: '2026-11-17 09:12:30', lastSignInFrom: '203.0.113.9', failedCodesSinceSignIn: 0, securityBanner: 'unfinished-sign-in', securityBannerAt: '2026-11-17 10:00:00' })
			.where(eq(users.id, user.id))
			.run();
		const load = async () => {
			const res = await pageLoad('/account', { user });
			if (res.type !== 'data') throw new Error(JSON.stringify(res));
			return res.data.twoStep;
		};

		const view = await load();

		expect(view.factors.map((row: Record<string, unknown>) => Object.keys(row).sort())).toEqual([
			['createdAt', 'id', 'kind', 'label', 'lastUsedAt'],
			['createdAt', 'id', 'kind', 'label', 'lastUsedAt']
		]);
		expect(view.factors.map((row: { label: string }) => row.label)).toEqual(['Authenticator', 'Spare phone']);
		const everything = JSON.stringify(view);
		for (const code of factor.recoveryCodes) expect(everything).not.toContain(code);
		expect(everything).not.toContain(pending.pendingId);
		expect(everything).not.toContain(pending.res.body.secret);
		// Raised before migration 0069 kept the latest signal: the latest is read as the banner's own moment (CS1).
		expect(view.banner).toEqual({ words: 'Someone entered your password and did not finish signing in.', at: '2026-11-17 10:00:00', latestAt: '2026-11-17 10:00:00' });
		expect(view.words.lastSignIn).toBe('Last sign-in to your account: 2026-11-17 09:12 UTC from 203.0.113.9.');
		expect(view.words.wrongCodes).toBeNull();
		expect(view.most).toBe(3);

		// The codes left, at 4, 3, 1 and 0.
		const useAllBut = (left: number) => {
			const ids = db.select({ id: mfaRecoveryCodes.id }).from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, user.id)).all().map((row) => row.id);
			for (const id of ids.slice(left)) sqlite.prepare("UPDATE mfa_recovery_codes SET used_at = '2026-11-17 09:00:00' WHERE id = ?").run(id);
		};
		const said: Record<number, string> = {
			4: '4 recovery codes left.',
			3: '3 recovery codes left. Make a new set.',
			1: '1 recovery code left. Make a new set.',
			0: 'You have no recovery codes left. Make a new set now: without them, a lost phone means asking an administrator.'
		};
		for (const left of [4, 3, 1, 0]) {
			useAllBut(left);
			const now = await load();
			expect({ left: now.codesLeft, words: now.words.codesLeft }).toEqual({ left, words: said[left] });
		}

		// Wrong codes since the last sign-in, said only when there were any.
		db.update(users).set({ failedCodesSinceSignIn: 2 }).where(eq(users.id, user.id)).run();
		expect((await load()).words.wrongCodes).toBe('Wrong codes entered since: 2.');

		// The layout's count, for the confirm dialog's line.
		const layout = await pageLoad('/', { user, layout: true });
		expect(layout).toMatchObject({ type: 'data', data: { authenticators: 2 } });
	});
});
