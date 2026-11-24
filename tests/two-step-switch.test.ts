/**
 * Two-step sign-in required by the superadmin, and the start that finds it
 * turned off (card 3064, slice S3b: T44 to T47, T67 and T68 of
 * `docs/planning/card-3064-compatibility-release.md`, section 9).
 *
 * `POST /api/admin/two-step/require` (event E3, R10): the superadmin's alone,
 * with the password and a code, from a session made with a code, and only
 * while the superadmin and every enabled administrator hold a factor (S-L7).
 * It writes the switch and `two_step_released_at`, marks the accounts with no
 * factor and no enrolment link, ends every session made on a password alone,
 * and says one CRITICAL line. A start that finds `two_step_released_at` and
 * no switch says one CRITICAL line (R11, decision 51).
 *
 * Who may call the route, and its step-up's registry rows (T48), are
 * tests/access-every-route.test.ts, tests/check-at-the-write.test.ts and
 * tests/step-up.test.ts; the Reset's writing the switch back (T49) is
 * tests/admin-reset.test.ts.
 *
 * Slice S4: two presses at once, and what the Admin page's load gives the
 * Two-step sign-in panel (U3, U5: the panel itself, mounted, is
 * tests/admin-panels.test.ts).
 *
 * Against the application's own in-memory database, emptied before each
 * test, with two-step sign-in dormant unless a case says otherwise.
 * `checkPassword` is stood in for, so that a case can hold compares in
 * flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => ({
	/** Compares finished and now waiting on `hold`. */
	parked: 0,
	/** While set, each compare, once made, waits for it to answer: a check held in flight. */
	hold: undefined as Promise<void> | undefined
}));

vi.mock('$lib/server/passwords', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/passwords')>();
	return {
		...real,
		checkPassword: async (...args: Parameters<typeof real.checkPassword>) => {
			const checked = await real.checkPassword(...args);
			stub.parked++;
			await stub.hold;
			return checked;
		}
	};
});

import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { sessions, settings, users } from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import { SESSION_COOKIE_NAME, createSession } from '$lib/server/auth';
import { subscribeToLogs, type LogEntry } from '$lib/server/logger';
import { issueEnrolmentLink } from '$lib/server/mfa-store';
import { reportInstallation } from '$lib/server/startup-checks';
import {
	ALREADY_REQUIRED,
	REQUIRER_HOLDS_NO_FACTOR,
	REQUIRER_SIGNED_IN_WITHOUT_CODE,
	TWO_STEP_TURNED_OFF,
	administratorsFirst,
	administratorsWithoutFactor,
	refuseRequiring,
	twoStepRequired
} from '$lib/server/two-step-switch';
import { load as loadAdminPage } from '../src/routes/admin/+page.server';
import { api } from './helpers/api';
import {
	FIXTURE_PASSWORD,
	makeApiKey,
	makeApiKeyRow,
	makeTwoStepDormant,
	makeUser,
	resetDb,
	sessionHashOf,
	sessionRow,
	stepUp,
	writeRequiredSettings
} from './helpers/fixtures';
import { diffSnapshots, snapshotDb } from './helpers/snapshot';
import { codeFor, giveAuthenticator, giveFactor } from './helpers/two-step';

const logLevel = process.env.LOG_LEVEL;

beforeEach(() => {
	resetDb();
	makeTwoStepDormant();
	stub.parked = 0;
	stub.hold = undefined;
	process.env.LOG_LEVEL = 'INFO';
	for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
	stub.hold = undefined;
	vi.useRealTimers();
	vi.restoreAllMocks();
	if (logLevel === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = logLevel;
});

/** Every log entry written while `fn` runs. */
async function logged<T>(fn: () => Promise<T> | T): Promise<{ result: T; lines: LogEntry[] }> {
	const lines: LogEntry[] = [];
	const stop = subscribeToLogs((entry) => lines.push(entry));
	try {
		return { result: await fn(), lines };
	} finally {
		stop();
	}
}

/** The CRITICAL lines among `lines`, as context and message. */
const critical = (lines: LogEntry[]) => lines.filter((line) => line.level === 'CRITICAL').map(({ context, message }) => ({ context, message }));

/** The setting `key`'s value, or undefined for none. */
const setting = (key: string) => db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()?.value;

/** The session code a step-up request's cookie carries. */
const tokenOf = (req: { headers: Record<string, string> }) => req.headers.cookie.slice(`${SESSION_COOKIE_NAME}=`.length);

/** Two-step sign-in required, as the superadmin asks it with `req` (a step-up's). */
const requireIt = (req: ReturnType<typeof stepUp>) => api('POST', '/api/admin/two-step/require', req);

/** The superadmin and an administrator, each holding an authenticator. */
function administrators() {
	const chief = makeUser({ username: 'chief', role: 'superadmin' });
	giveFactor(chief);
	const admin = makeUser({ username: 'admin', role: 'admin' });
	giveFactor(admin);
	return { chief, admin };
}

/** What `fn` threw, as an HTTP error's status and body. */
function refusalOf(fn: () => void): { status: number; body: unknown } {
	try {
		fn();
	} catch (thrown) {
		if (isHttpError(thrown)) return { status: thrown.status, body: thrown.body };
		throw thrown;
	}
	throw new Error('Nothing was refused');
}

describe('requiring two-step sign-in (card 3064, R10: event E3)', () => {
	it('T44: the superadmin with a factor, on a session made with a code, every administrator holding one: the switch and the release moment now, the accounts with no factor and no link marked, every two_step 0 session ended and the caller’s kept, one CRITICAL line', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-12-01T09:00:00Z'));
		const { chief } = administrators();
		const plain = makeUser({ username: 'plain' });
		const linked = makeUser({ username: 'linked' });
		inTransaction(() => issueEnrolmentLink(linked.id, 'a test'));
		const holder = makeUser({ username: 'holder' });
		giveFactor(holder);
		// An earlier release moment, which E3 replaces (0066's line, now starting the 14 days at E3).
		db.insert(settings).values({ key: 'two_step_released_at', value: '2026-11-24 08:00:00' }).run();
		const passwordOnly = createSession(plain.id, { twoStep: 0 }).token;
		const keptAtRelease = createSession(linked.id, { twoStep: 0 }).token;
		db.update(sessions).set({ keptAtRelease: 1 }).where(eq(sessions.tokenHash, sessionHashOf(keptAtRelease))).run();
		const withCode = createSession(holder.id, { twoStep: 1 }).token;
		const req = stepUp(chief);

		const { result: res, lines } = await logged(() => requireIt(req));

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toEqual({ success: true, requiredAt: '2026-12-01 09:00:00', sessionsEnded: 2, accountsMarked: 1 });
		expect(twoStepRequired()).toBe(true);
		expect(setting('two_step_required_at')).toBe('2026-12-01 09:00:00');
		expect(setting('two_step_released_at')).toBe('2026-12-01 09:00:00');
		const marks = Object.fromEntries(db.select({ username: users.username, mark: users.mfaPasswordEnrol }).from(users).all().map((row) => [row.username, row.mark]));
		expect(marks).toEqual({ chief: 0, admin: 0, plain: 1, linked: 0, holder: 0 });
		expect(sessionRow(passwordOnly)).toBeUndefined();
		expect(sessionRow(keptAtRelease)).toBeUndefined();
		expect(sessionRow(withCode)).toMatchObject({ userId: holder.id, twoStep: 1 });
		expect(sessionRow(tokenOf(req))).toMatchObject({ userId: chief.id, twoStep: 1 });
		expect(critical(lines)).toEqual([
			{
				context: 'AUTH',
				message:
					`Two-step sign-in is now required on this server, by chief (ID: ${chief.id}): 2 session(s) made on a password alone ended ` +
					'(sessions kept at the release included); 1 account(s) with no second factor and no set-up link (disabled accounts included) ' +
					'may set up on the password alone for 14 days where mail was never set up'
			}
		]);
	});

	it('T45: refused 409 when the caller holds no factor, before the password, with nothing written', async () => {
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		const admin = makeUser({ username: 'admin', role: 'admin' });
		giveFactor(admin);
		// The password alone: an account with no factor is asked no code while dormant (R6).
		const req = stepUp(chief, {}, FIXTURE_PASSWORD, '');
		const before = snapshotDb();

		const { result: res, lines } = await logged(() => requireIt(req));

		expect({ status: res.status, body: res.body }).toEqual({ status: 409, body: { message: REQUIRER_HOLDS_NO_FACTOR } });
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		expect(twoStepRequired()).toBe(false);
		expect(critical(lines)).toEqual([]);
	});

	it('T46: from a session made on a password alone: refused, with nothing written; the gate’s own rule refuses it first (S-M1), and the route’s refusal is 409', async () => {
		const { chief } = administrators();
		const req = stepUp(chief);
		const token = tokenOf(req);
		db.update(sessions).set({ twoStep: 0 }).where(eq(sessions.tokenHash, sessionHashOf(token))).run();
		const before = snapshotDb();

		const { result: res, lines } = await logged(() => requireIt(req));

		// A session made on a password alone of an account that holds a factor is no session, whatever the switch.
		expect({ status: res.status, body: res.body }).toEqual({ status: 401, body: { message: 'Not authenticated' } });
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		expect(twoStepRequired()).toBe(false);
		expect(critical(lines)).toEqual([]);
		// And the route's own refusal of that session, asked before the password and in the write.
		expect(refusalOf(() => refuseRequiring(chief.id, sessionHashOf(token)))).toEqual({ status: 409, body: { message: REQUIRER_SIGNED_IN_WITHOUT_CODE } });
		expect(refusalOf(() => refuseRequiring(chief.id, undefined))).toEqual({ status: 409, body: { message: REQUIRER_SIGNED_IN_WITHOUT_CODE } });
	});

	it('T47: refused 409 when two-step sign-in is already required, with nothing changed', async () => {
		const { chief } = administrators();
		// Made while it was dormant: none is made on a password alone once it is required (the code review's CS-L3).
		const passwordOnly = createSession(makeUser().id, { twoStep: 0 }).token;
		writeRequiredSettings();
		const switched = setting('two_step_required_at');
		const req = stepUp(chief);
		const before = snapshotDb();

		const { result: res, lines } = await logged(() => requireIt(req));

		expect({ status: res.status, body: res.body }).toEqual({ status: 409, body: { message: ALREADY_REQUIRED } });
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		expect(setting('two_step_required_at')).toBe(switched);
		expect(setting('two_step_released_at')).toBeUndefined();
		expect(sessionRow(passwordOnly)).toBeDefined();
		expect(critical(lines)).toEqual([]);
	});

	it('T67: refused 409 while the superadmin or any enabled administrator holds no factor, naming each, with nothing written; a disabled one is not named', async () => {
		const { chief } = administrators();
		const second = makeUser({ username: 'second-admin', role: 'admin' });
		const third = makeUser({ username: 'third-admin', role: 'admin' });
		makeUser({ username: 'gone-admin', role: 'admin', disabled: true });
		const plain = makeUser();
		const passwordOnly = createSession(plain.id, { twoStep: 0 }).token;
		const req = stepUp(chief);
		const before = snapshotDb();

		const { result: res, lines } = await logged(() => requireIt(req));

		const words = administratorsFirst([second, third]);
		expect(words).toBe(
			`Every administrator must set up two-step sign-in before it can be required. Not yet set up: "second-admin" (user ${second.id}), ` +
				`"third-admin" (user ${third.id}).`
		);
		expect({ status: res.status, body: res.body }).toEqual({ status: 409, body: { message: words } });
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		expect(twoStepRequired()).toBe(false);
		expect(sessionRow(passwordOnly)).toBeDefined();
		expect(critical(lines)).toEqual([]);

		// The superadmin is named too, where it holds none.
		sqlite.prepare('DELETE FROM mfa_factors WHERE user_id = ?').run(chief.id);
		expect(administratorsWithoutFactor().map((account) => account.username)).toEqual(['chief', 'second-admin', 'third-admin']);
	});

	it('S4: two presses at once, from two sessions of the superadmin, each past its guard with its compare held: one turns it on, the other is refused, and it is turned on once', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-12-01T09:00:00Z'));
		const { chief } = administrators();
		// Each session sends the code of its own authenticator, so that neither code is spent by the other.
		const spare = giveAuthenticator(chief);
		const own = giveAuthenticator(chief, 'Third phone');
		const at = Date.now();
		const byA = stepUp(chief, {}, FIXTURE_PASSWORD, codeFor(spare.secret, at));
		const byB = stepUp(chief, {}, FIXTURE_PASSWORD, codeFor(own.secret, at));
		const passwordOnly = createSession(makeUser().id, { twoStep: 0 }).token;
		let release!: () => void;
		stub.hold = new Promise<void>((resolve) => (release = resolve));

		const { result, lines } = await logged(async () => {
			const pressA = requireIt(byA);
			const pressB = requireIt(byB);
			// Both compares made and held: neither can write before the other's check ends.
			await vi.waitFor(() => expect(stub.parked).toBe(2));
			stub.hold = undefined;
			release();
			return Promise.all([pressA, pressB]);
		});

		const statuses = result.map((res) => res.status).sort();
		const won = result.find((res) => res.status === 200)!;
		const lost = result.find((res) => res.status !== 200)!;
		expect(statuses, JSON.stringify(result.map((res) => res.body))).toEqual([200, 409]);
		expect(won.body).toEqual({ success: true, requiredAt: '2026-12-01 09:00:00', sessionsEnded: 1, accountsMarked: 1 });
		// The loser's session, made with a code, has the superadmin's limits whatever the switch (the code review's CS-L2),
		// so it is still open once it is required, and the route's own check in its write refuses it (D29 re-pinned).
		expect(lost.body).toEqual({ message: ALREADY_REQUIRED });
		expect(sqlite.prepare("SELECT key, value FROM settings WHERE key IN ('two_step_required_at', 'two_step_released_at') ORDER BY key").all()).toEqual([
			{ key: 'two_step_released_at', value: '2026-12-01 09:00:00' },
			{ key: 'two_step_required_at', value: '2026-12-01 09:00:00' }
		]);
		expect(sessionRow(passwordOnly)).toBeUndefined();
		expect(critical(lines)).toHaveLength(1);
		expect(critical(lines)[0].message).toMatch(/^Two-step sign-in is now required on this server, by chief /);
	});
});

// ─── Card 3064, S4: what the Admin page's load gives the panel (U3, U5) ──────

describe('the Two-step sign-in panel’s data, from the Admin page’s load (card 3064, S4)', () => {
	/** The panel's data, as the admin page's load gives it to `caller`. */
	const viewOf = async (caller: { id: number }) =>
		(
			(await loadAdminPage({ locals: { user: caller } } as unknown as Parameters<typeof loadAdminPage>[0])) as unknown as {
				twoStepSwitch: Record<string, unknown> & { keysWithoutFactorListed: unknown[] | null };
			}
		).twoStepSwitch;

	/**
	 * The superadmin with an authenticator; an administrator and a user with none, the user holding a working key,
	 * an ended one and a session made on its password alone; a user with an authenticator, a key and a session made
	 * with a code; a disabled administrator with none, holding a key and a session made on its password alone.
	 */
	function server() {
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		giveFactor(chief);
		const ada = makeUser({ username: 'ada', role: 'admin' });
		const plain = makeUser({ username: 'plain' });
		makeApiKey(plain, 'CI pipeline');
		makeApiKeyRow(plain, { expiresAt: '2020-01-01 00:00:00' });
		createSession(plain.id, { twoStep: 0 });
		const holder = makeUser({ username: 'holder' });
		giveFactor(holder);
		makeApiKey(holder, 'Holder key');
		createSession(holder.id, { twoStep: 1 });
		const gone = makeUser({ username: 'gone', role: 'admin', disabled: true });
		makeApiKey(gone, 'Gone key');
		return { chief, ada, plain };
	}

	it('U3. "not required", the counts (enabled accounts with no factor; every session made on a password alone), and the button the superadmin’s alone; once required, said with its moment', async () => {
		const { chief, ada } = server();

		expect(await viewOf(chief)).toMatchObject({ required: false, requiredAt: null, accountsWithoutFactor: 2, passwordOnlySessions: 1, mayRequire: true });
		expect(await viewOf(ada)).toMatchObject({ required: false, requiredAt: null, accountsWithoutFactor: 2, passwordOnlySessions: 1, mayRequire: false });

		writeRequiredSettings();
		const required = sqlite.prepare("SELECT value FROM settings WHERE key = 'two_step_required_at'").pluck().get();
		expect(await viewOf(chief)).toMatchObject({ required: true, requiredAt: required, mayRequire: true });
	});

	it('U5. every administrator without a factor, as the route refuses them; every working key of an enabled account with no factor, by holder to the superadmin alone and never by name, counted for any other', async () => {
		const { chief, ada, plain } = server();

		const asChief = await viewOf(chief);
		// Not the disabled administrator, nor its key; nor the ended key, nor the key of the account with a factor. Never a prefix.
		expect(asChief.administratorsWithoutFactor).toEqual([{ id: ada.id, username: 'ada' }]);
		expect(asChief.administratorsWithoutFactor).toEqual(administratorsWithoutFactor());
		expect(asChief.keysWithoutFactor).toBe(1);
		expect(asChief.keysWithoutFactorListed).toEqual([
			{ id: expect.any(Number), createdAt: expect.any(String), lastUsedAt: null, holder: 'plain', holderId: plain.id }
		]);

		expect(JSON.stringify(asChief)).not.toContain('CI pipeline');
		expect(await viewOf(ada)).toMatchObject({ administratorsWithoutFactor: [{ id: ada.id, username: 'ada' }], keysWithoutFactor: 1, keysWithoutFactorListed: null });

		// The superadmin without one is listed first, as the route names it.
		sqlite.prepare('DELETE FROM mfa_factors WHERE user_id = ?').run(chief.id);
		giveFactor(ada);
		expect((await viewOf(chief)).administratorsWithoutFactor).toEqual([{ id: chief.id, username: 'chief' }]);
	});
});

describe('the start that finds two-step sign-in turned off (card 3064, R11)', () => {
	it('T68: two_step_released_at held with no switch: one CRITICAL line; with both, or with neither, none', async () => {
		const turnedOff = async () => critical((await logged(() => reportInstallation())).lines).filter((line) => line.message === TWO_STEP_TURNED_OFF);

		db.insert(settings).values({ key: 'two_step_released_at', value: '2026-12-01 09:00:00' }).run();
		expect(await turnedOff()).toEqual([{ context: 'STARTUP', message: TWO_STEP_TURNED_OFF }]);
		expect(TWO_STEP_TURNED_OFF).toBe('Two-step sign-in was required on this server and is not now: a host edit or a restore turned it off');

		writeRequiredSettings();
		expect(await turnedOff()).toEqual([]);

		sqlite.prepare("DELETE FROM settings WHERE key IN ('two_step_required_at', 'two_step_released_at')").run();
		expect(await turnedOff()).toEqual([]);
	});
});
