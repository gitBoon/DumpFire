/**
 * The gate: what `handle` in `src/hooks.server.ts` answers, and what it makes
 * of SvelteKit's own answers, for a request as it arrives on the wire.
 *
 * Every other suite calls a handler directly, beneath the gate. These go
 * through `gate()` in ./helpers/gate.ts, which is SvelteKit's own server over
 * the real route tree with the real `handle` in front, so that each answer
 * below is the status, the content type and the body a caller is sent.
 *
 * What is held here:
 *
 *   - Under `/api/v1/` every failure is JSON with a `message`, whatever the
 *     request's `Accept` header says: the gate's own 401s and 429, an
 *     `error()` from a handler, a path that is no route, a method the route
 *     does not have. The last two SvelteKit would answer as an HTML page and
 *     as plain text.
 *   - Under all of `/api/`, a body that is missing, is not JSON, or is JSON
 *     and not an object, is a 400 and not a 500. A body over the size limit
 *     is a 413, however it is read: as JSON, as an upload or as bytes.
 *   - Every rule is decided on the path as the router sees it. An address
 *     with a letter percent-encoded is answered exactly as the plain one is.
 *   - The v1 rate limit is counted against a key once the key is checked,
 *     and a request with no key the gate accepts against its address.
 *   - Every answer the gate gives carries the security headers, and the gate
 *     sends its redirects as answers of its own, in the form SvelteKit would
 *     have given them.
 *   - Who is let through without a session is decided by route id, exactly.
 *   - An internal route asked by a script with no session is answered 401; a
 *     browser that goes to its address is still sent to sign in.
 *   - A fault is written to the system log once, with its reason, and the
 *     caller is told nothing of it.
 *   - Everything else is left as it was: a page is HTML and is sent to sign
 *     in, and outside `/api/v1/` SvelteKit still chooses between JSON and a
 *     page by the `Accept` header.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isHttpError, isRedirect, type RequestEvent } from '@sveltejs/kit';
import { hashSync } from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqlite } from '$lib/server/db';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { failureAsJson, guardBody, isJsonAnswer, jsonInPlaceOf } from '$lib/server/api-errors';
import { FRAMEABLE_ROUTES, SECURITY_HEADERS, preferredType, secured } from '$lib/server/gate-answers';
import { subscribeToLogs, type LogEntry } from '$lib/server/logger';
import {
	countSignInAttempt,
	countWrongSignIn,
	keepSignInAttemptCounted,
	refundSignInAttempts,
	resetAllRateLimits,
	signInWait,
	wrongSignInsAt,
	WRONG_SIGN_IN_KEYS
} from '$lib/server/rate-limit';
import {
	KNOWN_BROWSER_SECRET_KEY,
	knownBrowserCookie,
	rereadSignInsOneAtATime,
	resetKnownBrowserSecretCache
} from '$lib/server/known-browsers';
import { reportSignInsNotOneAtATime } from '$lib/server/startup-checks';
import { addressKey } from '$lib/server/client-address';
import { passwordChecks } from '$lib/server/passwords';
import { handleError } from '../src/hooks.server';
import { api, routeMethods, routePatterns } from './helpers/api';
import { failingWrite, type FailingWrite } from './helpers/failing-write';
import { makeApiKey, makeAttachment, makeBoard, makeCard, makeSession, makeUser, resetDb } from './helpers/fixtures';
import { bodyOverTheLimit, gate, gateApiRoutes, gateRoutes, type GateOptions } from './helpers/gate';

/** SvelteKit's source, as a path Vite resolves from the repository root, as ./helpers/gate.ts loads it. */
const KIT = '/node_modules/@sveltejs/kit/src';

/** The two refusals of the body guard, word for word. */
const NOT_JSON = { message: 'The request body is missing or is not valid JSON' };
const NOT_AN_OBJECT = { message: 'The request body must be a JSON object' };

const JSON_BODY = { 'content-type': 'application/json' };

/**
 * The length a body that runs past it declares: `bodyOverTheLimit()` is sent
 * with this. A length every route accepts, so that the gate lets the request
 * through to be read, and the read is what fails.
 */
const DECLARED = { 'content-length': '100' };

type Answer = {
	status: number;
	/** The `content-type` header, or null if the answer has none. */
	type: string | null;
	/** The body, as it was sent. */
	text: string;
	headers: Headers;
};

async function send(method: string, path: string, opts: GateOptions = {}): Promise<Answer> {
	const res = await gate(method, path, opts);
	return { status: res.status, type: res.headers.get('content-type'), text: await res.text(), headers: res.headers };
}

/** The answer has this status, says it is JSON, and its body is exactly `body` and nothing more. */
function expectJson(res: Answer, status: number, body: unknown): void {
	expect({ status: res.status, type: res.type, text: res.text }).toEqual({
		status,
		type: 'application/json',
		text: JSON.stringify(body)
	});
}

const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;

let user: SessionUser;
let admin: SessionUser;
/** The superadmin, whose alone the import is. */
let chief: SessionUser;
/** The header an API caller sends: `user`'s key. */
let withKey: Record<string, string>;
/** The header a signed-in browser sends, for `user`, for `admin` and for `chief`. */
let asUser: Record<string, string>;
let asAdmin: Record<string, string>;
let asChief: Record<string, string>;

beforeEach(() => {
	resetDb();
	// The v1 limit is 60 requests a minute for a key, counted in memory.
	resetAllRateLimits();
	user = makeUser();
	admin = makeUser({ role: 'admin' });
	chief = makeUser({ role: 'superadmin' });
	withKey = { authorization: `Bearer ${makeApiKey(user)}` };
	asUser = { cookie: `${SESSION_COOKIE_NAME}=${makeSession(user)}` };
	asAdmin = { cookie: `${SESSION_COOKIE_NAME}=${makeSession(admin)}` };
	asChief = { cookie: `${SESSION_COOKIE_NAME}=${makeSession(chief)}` };
});

afterEach(() => {
	resetAllRateLimits();
	vi.restoreAllMocks();
});

describe('the harness', () => {
	// First, and about ./helpers/gate.ts, not the gate. The harness builds
	// SvelteKit's server from its internal modules, which an upgrade may move
	// or reshape. If that happens this is the test that fails, by name: either
	// the import throws here, or the harness no longer sees the routes that
	// `routePatterns()` finds by reading `src/routes/api` for itself.
	it(
		'serves every API route in the tree, and exactly those',
		async () => {
			const served = await gateApiRoutes();

			expect(served.length).toBe(routePatterns().length);
			expect(served).toEqual(routePatterns());
			expect(served.length).toBeGreaterThan(100);
		},
		30_000
	);

	it('reaches a handler through the real gate, on the database the test wrote to', async () => {
		const res = await send('GET', '/api/v1/me', { headers: withKey });

		expectJson(res, 200, { id: user.id, username: user.username, email: user.email, emoji: user.emoji, role: 'user' });
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	});
});

describe('a request to /api/v1/ with no key the gate accepts', () => {
	const NO_HEADER = { message: 'Missing or invalid Authorization header. Use: Bearer <api_key>' };

	it('is answered 401 when it sends no Authorization header', async () => {
		expectJson(await send('GET', '/api/v1/me'), 401, NO_HEADER);
	});

	it('is answered 401 when the header is not a Bearer one', async () => {
		expectJson(await send('GET', '/api/v1/me', { headers: { authorization: 'Basic dXNlcjE6eA==' } }), 401, NO_HEADER);
	});

	it('is answered 401 when the key is empty', async () => {
		// "Bearer " with nothing after it. A header's value loses the spaces at
		// its end before the gate sees it, so this arrives as "Bearer", which
		// is not a Bearer header at all: the answer is the one above.
		expectJson(await send('GET', '/api/v1/me', { headers: { authorization: 'Bearer ' } }), 401, NO_HEADER);
		expectJson(await send('GET', '/api/v1/me', { headers: { authorization: 'Bearer    ' } }), 401, NO_HEADER);
	});

	it('is answered 401 when the key is not one', async () => {
		const res = await send('GET', '/api/v1/me', { headers: { authorization: 'Bearer df_0000000000000000' } });

		expectJson(res, 401, { message: 'Invalid or expired API key' });
	});

	it('is answered in JSON whatever it asked for', async () => {
		expectJson(await send('GET', '/api/v1/me', { headers: { accept: 'text/html' } }), 401, NO_HEADER);
	});
});

describe('a key that has made its 60 requests in a minute', () => {
	it('is answered 429, with how long to wait in the body and in Retry-After', async () => {
		for (let i = 0; i < 60; i++) {
			expect((await gate('GET', '/api/v1/me', { headers: withKey })).status).toBe(200);
		}

		const res = await send('GET', '/api/v1/me', { headers: withKey });

		expect(res.status).toBe(429);
		expect(res.type).toBe('application/json');
		const body = JSON.parse(res.text);
		expect(body).toEqual({ message: 'Rate limit exceeded', retryAfterSecs: expect.any(Number) });
		// `message` first, as in every failure.
		expect(Object.keys(body)).toEqual(['message', 'retryAfterSecs']);
		expect(body.retryAfterSecs).toBeGreaterThanOrEqual(1);
		expect(body.retryAfterSecs).toBeLessThanOrEqual(60);
		expect(res.headers.get('retry-after')).toBe(String(body.retryAfterSecs));
	});

	it('does not count against another key', async () => {
		for (let i = 0; i < 61; i++) await gate('GET', '/api/v1/me', { headers: withKey });
		const other = { authorization: `Bearer ${makeApiKey(admin)}` };

		expect((await send('GET', '/api/v1/me', { headers: other })).status).toBe(200);
	});

	/** The 61st answer: 429, in JSON, with how long to wait in the body and in Retry-After. */
	function expectLimited(res: Answer): void {
		expect(res.status).toBe(429);
		expect(res.type).toBe('application/json');
		const body = JSON.parse(res.text);
		expect(body).toEqual({ message: 'Rate limit exceeded', retryAfterSecs: expect.any(Number) });
		expect(body.retryAfterSecs).toBeGreaterThanOrEqual(1);
		expect(res.headers.get('retry-after')).toBe(String(body.retryAfterSecs));
	}

	// The count was taken before the key was looked up, against the first 11
	// characters of whatever was sent, which is the prefix stored for a real
	// key. Anybody who had seen a key's prefix could spend its allowance. The
	// key is looked up first now, and its requests are counted against its own
	// row, which a wrong key never reaches.
	it('is not spent by a wrong key that begins as it does: the key keeps all sixty', async () => {
		const real = makeApiKey(user);
		// The first 11 characters of the real key, and nobody's after them.
		const lookalike = `${real.slice(0, 11)}${real.slice(11).replace(/./g, (c) => (c === '0' ? '1' : '0'))}`;
		expect(lookalike.slice(0, 11)).toBe(real.slice(0, 11));
		expect(lookalike).not.toBe(real);

		for (let i = 0; i < 61; i++) await gate('GET', '/api/v1/me', { headers: { authorization: `Bearer ${lookalike}` } });

		for (let i = 0; i < 60; i++) {
			expect((await gate('GET', '/api/v1/me', { headers: { authorization: `Bearer ${real}` } })).status).toBe(200);
		}
		expectLimited(await send('GET', '/api/v1/me', { headers: { authorization: `Bearer ${real}` } }));
	});

	it('counts each key apart, two keys of one user among them', async () => {
		const first = { authorization: `Bearer ${makeApiKey(user)}` };
		const second = { authorization: `Bearer ${makeApiKey(user)}` };
		for (let i = 0; i < 60; i++) await gate('GET', '/api/v1/me', { headers: first });

		expectLimited(await send('GET', '/api/v1/me', { headers: first }));
		expect((await send('GET', '/api/v1/me', { headers: second })).status).toBe(200);
	});

	it('marks a key as used when it is let in, and not when it is refused for being over its limit', async () => {
		const key = makeApiKey(user, 'Watched');
		const lastUsed = () =>
			(sqlite.prepare(`SELECT last_used_at AS at FROM api_keys WHERE name = 'Watched'`).get() as { at: string | null }).at;
		expect(lastUsed()).toBeNull();

		for (let i = 0; i < 60; i++) await gate('GET', '/api/v1/me', { headers: { authorization: `Bearer ${key}` } });
		expect(lastUsed()).not.toBeNull();

		sqlite.prepare(`UPDATE api_keys SET last_used_at = NULL WHERE name = 'Watched'`).run();
		expectLimited(await send('GET', '/api/v1/me', { headers: { authorization: `Bearer ${key}` } }));
		expect(lastUsed()).toBeNull();
	});

	// And before the route is looked for: a path that is no route is a request
	// like any other.
	it('counts a request to a path that is no route: sixty are answered 404, and the next 429', async () => {
		for (let i = 0; i < 60; i++) {
			expect((await gate('GET', '/api/v1/no-such-thing', { headers: withKey })).status).toBe(404);
		}

		expectLimited(await send('GET', '/api/v1/no-such-thing', { headers: withKey }));
		// The limit is the key's, not the path's: a route that is there is limited with it.
		expectLimited(await send('GET', '/api/v1/me', { headers: withKey }));
	});
});

/**
 * A request to /api/v1/ with no key the gate accepts is counted against the
 * address it came from, in a bucket of its own, so that guessing at keys is
 * slowed and never spends a real key's allowance.
 */
describe('requests to /api/v1/ with no key the gate accepts, from one address', () => {
	const ME = '/api/v1/me';

	/** 429, in JSON, with how long to wait. */
	async function expectLimited(opts: GateOptions): Promise<void> {
		const res = await send('GET', ME, opts);
		expect(res.status).toBe(429);
		expect(res.type).toBe('application/json');
		expect(JSON.parse(res.text)).toEqual({ message: 'Rate limit exceeded', retryAfterSecs: expect.any(Number) });
		expect(res.headers.get('retry-after')).toBe(JSON.parse(res.text).retryAfterSecs.toString());
	}

	it('are sixty answered 401, and the next 429, whether the key was wrong or there was none at all', async () => {
		const ip = '203.0.113.7';
		const tries: Record<string, string>[] = [
			{},
			{ authorization: 'Basic dXNlcjE6eA==' },
			{ authorization: `Bearer df_${'0'.repeat(64)}` }
		];
		for (let i = 0; i < 60; i++) {
			expect((await gate('GET', ME, { headers: tries[i % 3], ip })).status).toBe(401);
		}

		for (const headers of tries) await expectLimited({ headers, ip });
	});

	it('are counted apart from another address’s, and hold up no real key from the same address', async () => {
		const ip = '203.0.113.8';
		for (let i = 0; i < 61; i++) await gate('GET', ME, { ip });
		await expectLimited({ ip });

		expect((await send('GET', ME, { ip: '203.0.113.9' })).status).toBe(401);
		expect((await send('GET', ME, { headers: withKey, ip })).status).toBe(200);
	});

	// Behind a proxy that sends no ADDRESS_HEADER the adapter cannot say who
	// a caller is, and its lookup throws. The gate asks it guarded: a caller
	// whose address is not known is answered, not failed, and is counted with
	// every other caller whose address is not known.
	it('are answered and counted when the address cannot be read, and a real key still works', async () => {
		for (let i = 0; i < 60; i++) expect((await gate('GET', ME, { ip: null })).status).toBe(401);
		await expectLimited({ ip: null });

		expect((await send('GET', ME, { headers: withKey, ip: null })).status).toBe(200);
		// A page, which logs the address the gate could not read, is answered too.
		expect((await send('GET', '/login', { headers: { accept: 'text/html' }, ip: null })).status).toBe(200);
	});
});

/** A sign-in as a browser posts the form. */
const LOGIN_FORM = { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', accept: 'text/html' };

/**
 * POST /login with `identity` and `password`, from `ip` (null: an address
 * that cannot be read), sending `cookie` (`name=value`) if there is one: a
 * browser's remembered cookie (card 2194).
 */
function signIn(identity: string, password: string, ip: string | null = '203.0.113.30', cookie?: string): Promise<Answer> {
	return send('POST', '/login', {
		headers: cookie === undefined ? LOGIN_FORM : { ...LOGIN_FORM, cookie },
		body: `identity=${encodeURIComponent(identity)}&password=${encodeURIComponent(password)}`,
		ip
	});
}

/**
 * Put `setTimeout` and `Date` on a fake clock, after one sign-in that loads
 * the login page's modules on the real one, and spends nothing: an empty name
 * is answered before any count. `setImmediate` stays real, so `heldFor` can
 * let a request run. The caller puts the real clock back.
 */
async function onTheFakeClock(): Promise<void> {
	await signIn('', '');
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
}

/** Let the requests in flight run, on the real `setImmediate`, until each is answered or waits on a timer. */
async function letRun(): Promise<void> {
	for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * How long each of `requests` was held on the fake clock, and its answer.
 * The requests are let run; while any is unanswered and a timer is set, the
 * clock is moved 250 ms and they are let run again. A request answered with
 * no timer set was held 0 ms.
 */
async function heldFor(...requests: Promise<Answer>[]): Promise<{ ms: number; res: Answer }[]> {
	const held: ({ ms: number; res: Answer } | undefined)[] = requests.map(() => undefined);
	let failed: { reason: unknown } | undefined;
	let moved = 0;
	requests.forEach((request, index) =>
		request.then(
			(res) => (held[index] = { ms: moved, res }),
			(reason) => (failed = { reason })
		)
	);
	for (let rounds = 0; ; rounds++) {
		await letRun();
		if (failed) throw failed.reason;
		if (held.every((answer) => answer !== undefined)) return held as { ms: number; res: Answer }[];
		if (vi.getTimerCount() === 0) {
			if (rounds > 200) throw new Error('a sign-in was neither answered nor waiting on a timer');
			continue;
		}
		moved += 250;
		await vi.advanceTimersByTimeAsync(250);
	}
}

/** The milliseconds each sign-in in turn was held, each answered `status`. */
async function heldInTurn(attempts: (() => Promise<Answer>)[], status = 400): Promise<number[]> {
	const waited: number[] = [];
	for (const [index, attempt] of attempts.entries()) {
		const [{ ms, res }] = await heldFor(attempt());
		expect(res.status, `attempt ${index + 1}`).toBe(status);
		waited.push(ms);
	}
	return waited;
}

const WRONG = 'Invalid username/email or password';

/** What a browser not remembered is told when the account's places are taken (card 2194). */
const ALREADY_UNDER_WAY =
	'A sign-in with this name is already under way from another browser. Wait a few seconds and try again, or sign in ' +
	'from a browser you have used here before.';

/**
 * Wrong passwords at one account (card 2177). Sign-in counted attempts per
 * address only, so a guesser with N addresses had 10 × N tries at an account
 * every 15 minutes. Now, after five wrong passwords at one account within 15
 * minutes of each other, every sign-in at it waits 1, 2, then 4 seconds
 * before its password is checked, from whatever address, the right password
 * included, and is then answered as it would have been. One sent while
 * another from a browser not remembered is in flight there is refused (card
 * 2194, below). Each runs on the fake clock, and says how long a sign-in was
 * held by how far the clock had to be moved before it was answered.
 */
describe('wrong passwords at one account, from any number of addresses', () => {
	const A = '203.0.113.31';
	const B = '203.0.113.32';
	const C = '203.0.113.33';
	const D = '203.0.113.34';
	const wrongAt = (identity: string, ip: string) => () => signIn(identity, 'wrong', ip);

	beforeEach(async () => {
		sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSync('right', 4), user.id);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await onTheFakeClock();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('slows every sign-in at the account after five wrong, whichever address they come from, and keeps the words', async () => {
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		try {
			expect(await heldInTurn([A, A, B, B, C].map((ip) => wrongAt(user.username, ip)))).toEqual([0, 0, 0, 0, 0]);
			const [sixth] = await heldFor(signIn(user.username, 'wrong', D));
			expect(sixth.ms).toBe(1000);
			expect(sixth.res.status).toBe(400);
			expect(sixth.res.text).toContain(WRONG);
			expect(await heldInTurn([D, D, D].map((ip) => wrongAt(user.username, ip)))).toEqual([2000, 4000, 4000]);
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
		// One line when the waits begin, and not one for each wait.
		const lines = sqlite.prepare("SELECT level, message, user_id AS userId FROM system_logs WHERE message LIKE 'Sign-ins at %'").all();
		// Naming the account, and with it as the line's user (review O2).
		expect(lines).toEqual([
			{
				level: 'WARN',
				message: `Sign-ins at "${user.username}" (user ${user.id}) are being slowed: 5 wrong passwords within 15 minutes of each other`,
				userId: user.id
			}
		]);
	});

	it('still lets the right password in, after the wait, and forgets the count', async () => {
		const ips = [...Array(7).fill(A), ...Array(7).fill(B), ...Array(6).fill(C)];
		await heldInTurn(ips.map((ip) => wrongAt(user.username, ip)));

		const [right] = await heldFor(signIn(user.username, 'right', C));
		expect(right.ms).toBe(4000);
		expect(right.res.status).toBe(303);
		expect(right.res.headers.get('location')).toBe('/');
		expect(right.res.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=`);

		expect(await heldInTurn([wrongAt(user.username, D)])).toEqual([0]);
	});

	it('counts a username and its email as one account', async () => {
		const tries = [A, A, A].map((ip) => wrongAt(user.username, ip)).concat([B, B].map((ip) => wrongAt(user.email, ip)));
		expect(await heldInTurn(tries)).toEqual([0, 0, 0, 0, 0]);
		expect(await heldInTurn([wrongAt(user.email.toUpperCase(), C)])).toEqual([1000]);
	});

	it('makes a name that is no account wait exactly as a real one would', async () => {
		const [real] = await (async () => {
			await heldInTurn([A, A, B, B, C].map((ip) => wrongAt(user.username, ip)));
			return heldFor(signIn(user.username, 'wrong', C));
		})();
		await heldInTurn([A, A, B, B, D].map((ip) => wrongAt('nobody-here', ip)));
		const [none] = await heldFor(signIn('nobody-here', 'wrong', D));

		expect(none.ms).toBe(1000);
		expect(none.ms).toBe(real.ms);
		expect(none.res.status).toBe(real.res.status);
		expect(none.res.text).toContain(WRONG);
	});

	// A name that is no account was counted lower-cased, while the lookup reads
	// a username exactly: five at `USER1` then one at `user1` waited 1 s only
	// when `user1` was no account (review M1, 11 ms against 1,004 ms).
	it('counts a name that is no account as the lookup reads it, so another case waits alike for a real account and none', async () => {
		const ghost = 'ghost-name';
		expect(await heldInTurn([A, A, A, A, A].map((ip) => wrongAt(user.username.toUpperCase(), ip)))).toEqual([0, 0, 0, 0, 0]);
		const [real] = await heldFor(signIn(user.username, 'wrong', B));
		expect(await heldInTurn([C, C, C, C, C].map((ip) => wrongAt(ghost.toUpperCase(), ip)))).toEqual([0, 0, 0, 0, 0]);
		const [none] = await heldFor(signIn(ghost, 'wrong', D));

		expect(real.ms).toBe(0);
		expect(none.ms).toBe(real.ms);
		expect(none.res.status).toBe(real.res.status);
	});

	// Each name that is no account is a count, so the map is held to
	// WRONG_SIGN_IN_KEYS, the one counted longest ago forgotten first (review N7).
	it('keeps at most 10,000 counts, forgetting the one counted longest ago', () => {
		for (let i = 0; i < 5; i++) countWrongSignIn('name:first');
		for (let i = 0; i < 5; i++) countWrongSignIn('name:kept');
		for (let n = 0; n < WRONG_SIGN_IN_KEYS - 2; n++) countWrongSignIn(`name:${n}`);
		// Counted again, so now the newest.
		countWrongSignIn('name:kept');
		expect(signInWait('name:first')).toBe(1000);

		countWrongSignIn('name:one-more');
		expect(signInWait('name:first')).toBe(0);
		expect(signInWait('name:kept')).toBe(2000);
		countWrongSignIn('name:and-another');
		expect(signInWait('name:kept')).toBe(2000);
		expect(WRONG_SIGN_IN_KEYS).toBe(10_000);
	});

	it('does not slow another account', async () => {
		const other = makeUser();
		await heldInTurn([A, A, A, B, B, B, C].map((ip) => wrongAt(user.username, ip)));
		expect(await heldInTurn([wrongAt(user.username, C)])).toEqual([4000]);

		expect(await heldInTurn([wrongAt(other.username, D)])).toEqual([0]);
	});

	it('answers the address’s own limit first and at once, and does not count that attempt at the account', async () => {
		// Ten from A: five at the account, five at a name that is no account.
		await heldInTurn([...Array(5).fill(user.username), ...Array(5).fill('nobody-else')].map((name) => wrongAt(name, A)));

		const [limited] = await heldFor(signIn(user.username, 'wrong', A));
		expect(limited.ms).toBe(0);
		expect(limited.res.status).toBe(429);
		expect(limited.res.text).toContain('Too many login attempts');
		// The account's five set a wait of 1 s; counted, the refusal would have made it 2 s.
		expect(await heldInTurn([wrongAt(user.username, B)])).toEqual([1000]);
	});

	// Card 2226. A sign-in that succeeded cleared its address's whole count,
	// so anyone with an account could send nine guesses at another account,
	// sign in to their own, and send nine more (probe: 36 in one window, every
	// one answered 400). Now it gives back only its own account's attempts.
	it('gives back, when a sign-in succeeds, only the attempts its address made at that account', async () => {
		const other = makeUser();
		await heldInTurn(Array.from({ length: 9 }, () => wrongAt(other.username, A)));

		const [right] = await heldFor(signIn(user.username, 'right', A));
		expect(right.res.status).toBe(303);

		// The tenth attempt from A in the window, and then the limit.
		await heldInTurn([wrongAt(other.username, A)]);
		const [limited] = await heldFor(signIn(other.username, 'wrong', A));
		expect(limited.ms).toBe(0);
		expect(limited.res.status).toBe(429);
		expect(limited.res.text).toContain('Too many login attempts');
	});

	it('keeps a name that is no account counted when the address then signs in to an account', async () => {
		await heldInTurn([wrongAt('nobody-here', A), wrongAt('nobody-here', A)]);
		await heldInTurn([A, A, A].map((ip) => wrongAt(user.username, ip)));
		const [right] = await heldFor(signIn(user.username, 'right', A));
		expect(right.res.status).toBe(303);

		// The two at `nobody-here` stay: eight more, and the ninth is refused.
		await heldInTurn(Array.from({ length: 8 }, () => wrongAt('nobody-else', A)));
		const [limited] = await heldFor(signIn('nobody-else', 'wrong', A));
		expect(limited.ms).toBe(0);
		expect(limited.res.status).toBe(429);
	});

	// What clearing the count was for: someone who mistypes and then signs in
	// has those attempts back, so an office's mistypes do not add up.
	it('gives back the mistypes of someone who then signs in', async () => {
		await heldInTurn([A, A, A].map((ip) => wrongAt(user.username, ip)));
		const [right] = await heldFor(signIn(user.username, 'right', A));
		expect(right.res.status).toBe(303);

		await heldInTurn(Array.from({ length: 10 }, () => wrongAt('nobody-else', A)));
		const [limited] = await heldFor(signIn('nobody-else', 'wrong', A));
		expect(limited.res.status).toBe(429);
	});

	it('gives back only in the window the attempts were made in, never what was refused, and forgets with every count', () => {
		const at = '198.51.100.40';
		const next = () => countSignInAttempt(at, 'user:2').attempts;

		// Three at one account, given back; given back again, nothing more.
		for (let n = 0; n < 3; n++) countSignInAttempt(at, 'user:1');
		refundSignInAttempts(at, 'user:1');
		refundSignInAttempts(at, 'user:1');
		expect(next()).toBe(1);

		// A refusal stays counted: nine more let in at user:1, which makes ten
		// in the window, the eleventh refused, and only the nine given back.
		for (let n = 0; n < 9; n++) countSignInAttempt(at, 'user:1');
		expect(countSignInAttempt(at, 'user:1')).toMatchObject({ limited: true, attempts: 11 });
		refundSignInAttempts(at, 'user:1');
		expect(next()).toBe(3);

		// An attempt let in and then not checked (the server busy) stays counted too.
		countSignInAttempt(at, 'user:1');
		countSignInAttempt(at, 'user:1');
		keepSignInAttemptCounted(at, 'user:1');
		refundSignInAttempts(at, 'user:1');
		expect(next()).toBe(5);

		// The record ends with its window.
		countSignInAttempt(at, 'user:1');
		vi.advanceTimersByTime(15 * 60 * 1000 + 1);
		refundSignInAttempts(at, 'user:1');
		expect(next()).toBe(1);
		refundSignInAttempts(at, 'user:1');
		expect(next()).toBe(2);

		// And with every other count.
		countSignInAttempt(at, 'user:1');
		resetAllRateLimits();
		expect(next()).toBe(1);
		refundSignInAttempts(at, 'user:1');
		expect(next()).toBe(2);
	});

	it('holds nothing else up while a sign-in waits', async () => {
		await heldInTurn([A, A, A, B, B, B, C].map((ip) => wrongAt(user.username, ip)));

		const waiting = signIn(user.username, 'wrong', D);
		await letRun();
		expect(vi.getTimerCount()).toBe(1);
		// Answered with the clock where it is: neither waits on the sign-in.
		expect((await send('GET', '/login', { headers: { accept: 'text/html' } })).status).toBe(200);
		expect((await send('GET', '/api/v1/me', { headers: withKey })).status).toBe(200);

		const [held] = await heldFor(waiting);
		expect(held.ms).toBe(4000);
		expect(held.res.status).toBe(400);
	});

	// Card 2194 (decision 21). Sign-ins sent together each waited its own
	// second side by side, so a guesser who sent many at once was slowed by
	// nothing but the per-address limit. Now browsers not remembered are let in
	// one at a time while the waits last, and the rest are refused at once.
	it('lets sign-ins sent together in one at a time once the waits have begun, and refuses the rest at once', async () => {
		await heldInTurn([A, A, B, B, C].map((ip) => wrongAt(user.username, ip)));
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		try {
			const together = await heldFor(signIn(user.username, 'wrong', B), signIn(user.username, 'wrong', C), signIn(user.username, 'wrong', D));
			expect(together.map(({ ms, res }) => [ms, res.status])).toEqual([
				[1000, 400],
				[0, 429],
				[0, 429]
			]);
			expect(together[1].res.text).toContain(ALREADY_UNDER_WAY);
			// Counted at the account once: only the one that was checked.
			expect(wrongSignInsAt(`user:${user.id}`)).toBe(6);

			// And again, which the log does not say a second time.
			const again = await heldFor(signIn(user.username, 'wrong', B), signIn(user.username, 'wrong', C));
			expect(again.map(({ ms, res }) => [ms, res.status])).toEqual([
				[2000, 400],
				[0, 429]
			]);
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
		expect(sqlite.prepare("SELECT message, user_id AS userId FROM system_logs WHERE message LIKE '%not known here%'").all()).toEqual([
			{
				message: `Sign-ins at "${user.username}" (user ${user.id}) from browsers not known here are being let in one at a time`,
				userId: user.id
			}
		]);
	});

	// The review's W9: the account's username is cut to 100 characters, as in
	// the failed sign-in's line.
	it('names an account in that line by the first 100 characters of its username', async () => {
		const long = makeUser({ username: 'u'.repeat(150) });
		await heldInTurn([A, A, B, B, C].map((ip) => wrongAt(long.username, ip)));
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		try {
			const together = await heldFor(signIn(long.username, 'wrong', B), signIn(long.username, 'wrong', C));
			expect(together.map(({ res }) => res.status)).toEqual([400, 429]);
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}
		expect(sqlite.prepare("SELECT message FROM system_logs WHERE message LIKE '%not known here%'").all()).toEqual([
			{ message: `Sign-ins at "${'u'.repeat(100)}" (user ${long.id}) from browsers not known here are being let in one at a time` }
		]);
	});

	// The way back for an owner an attack keeps out (the review's R3, decision 29).
	it('lets sign-ins sent together in side by side, each after its wait, while SIGN_IN_ONE_AT_A_TIME is off', async () => {
		await heldInTurn([A, A, B, B, C].map((ip) => wrongAt(user.username, ip)));
		process.env.SIGN_IN_ONE_AT_A_TIME = 'off';
		rereadSignInsOneAtATime();
		try {
			const together = await heldFor(signIn(user.username, 'wrong', B), signIn(user.username, 'wrong', C), signIn(user.username, 'wrong', D));
			expect(together.map(({ ms, res }) => [ms, res.status])).toEqual([
				[1000, 400],
				[1000, 400],
				[1000, 400]
			]);
		} finally {
			delete process.env.SIGN_IN_ONE_AT_A_TIME;
			rereadSignInsOneAtATime();
		}
	});

	it('forgets the count 15 minutes after the last wrong password', async () => {
		await heldInTurn([A, A, A, B, B, B, C].map((ip) => wrongAt(user.username, ip)));

		vi.advanceTimersByTime(15 * 60 * 1000 + 1);

		expect(await heldInTurn([wrongAt(user.username, D)])).toEqual([0]);
	});

	it('checks a long password whole after a wait: what is kept through it holds every character bcrypt reads', async () => {
		const long = Array.from({ length: 100 }, (_, i) => String.fromCharCode(65 + (i % 26))).join('');
		sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSync(long, 4), user.id);
		await heldInTurn([A, A, B, B, C].map((ip) => wrongAt(user.username, ip)));

		const [right] = await heldFor(signIn(user.username, long, D));
		expect(right.ms).toBe(1000);
		expect(right.res.status).toBe(303);
	});
});

/**
 * Browsers that have signed in here before (card 2194). The account's waits
 * slowed a guesser who waits for each answer, and not one who sends many at
 * once. Now browsers not remembered for an account are let in no more at once
 * than the free guesses left, and one at a time while the waits last (in the
 * describe above); and a browser that has signed in to the account is
 * remembered for it, by a cookie, and is never made to wait, refused or
 * counted at sign-in, so that its owner is never kept out on it. A copied
 * cookie is held to five guesses at once and five a quarter of an hour.
 */
describe('a browser that has signed in here before', () => {
	const A = '203.0.113.51';
	const B = '203.0.113.52';
	const C = '203.0.113.53';
	const D = '203.0.113.54';
	const wrongAt = (identity: string, ip: string, cookie?: string) => () => signIn(identity, 'wrong', ip, cookie);
	const ONE_AT_A_TIME = [
		[1000, 400],
		[0, 429],
		[0, 429]
	];
	const EACH_AT_ONCE = [
		[0, 400],
		[0, 400],
		[0, 400]
	];

	beforeEach(async () => {
		sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSync('right', 4), user.id);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await onTheFakeClock();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** The `Set-Cookie` an answer sent for the cookie `name`, whole. */
	const setCookie = (res: Answer, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

	/** A `Set-Cookie`'s attributes, in lower case and in order. */
	const attributesOf = (cookie: string) =>
		cookie
			.split(';')
			.slice(1)
			.map((attribute) => attribute.trim().toLowerCase())
			.sort();

	/** Sign in to `account` with the right password from `ip`: the cookie that remembers the browser, as `name=value`. */
	async function rememberedAt(account: SessionUser = user, ip = A): Promise<string> {
		const [{ res }] = await heldFor(signIn(account.username, 'right', ip));
		expect(res.status).toBe(303);
		return setCookie(res, knownBrowserCookie(account.id))!.split(';')[0];
	}

	/** The nonce of a cookie given as `name=value`. */
	const nonceOf = (cookie: string) => cookie.split('=')[1].split('.')[1];

	/** Five wrong at `identity` from browsers not remembered, one at a time: its waits begin at the next. */
	const fiveWrong = (identity = user.username) => heldInTurn([A, A, B, B, C].map((ip) => wrongAt(identity, ip)));

	/** Three wrong at `identity` sent together, each with `cookie` if there is one: how long each was held, and its status. */
	const threeTogether = async (identity: string, cookie?: string) =>
		(await heldFor(signIn(identity, 'wrong', B, cookie), signIn(identity, 'wrong', C, cookie), signIn(identity, 'wrong', D, cookie))).map(
			({ ms, res }) => [ms, res.status]
		);

	/** The attempts `ip`'s sign-in count holds, this question of it included. */
	const countedAt = (ip: string) => countSignInAttempt(ip, 'asked-by-the-test').attempts;

	it('is remembered by signing in, for a year, with a cookie sent to the sign-in page alone', async () => {
		const [{ res }] = await heldFor(signIn(user.username, 'right', A));

		expect(res.status).toBe(303);
		const cookie = setCookie(res, knownBrowserCookie(user.id));
		expect(cookie).toMatch(new RegExp(`^dumpfire_known_${user.id}=\\d+\\.[0-9a-f]{32}\\.[0-9a-f]{64};`));
		expect(attributesOf(cookie!)).toEqual(['httponly', `max-age=${365 * 24 * 60 * 60}`, 'path=/login', 'samesite=strict']);
	});

	it('is let in at once while the account waits, and leaves the account’s count as it was', async () => {
		const cookie = await rememberedAt();
		await heldInTurn([A, A, B, B, C, C, D].map((ip) => wrongAt(user.username, ip)));
		expect(signInWait(`user:${user.id}`)).toBe(4000);

		const [right] = await heldFor(signIn(user.username, 'right', D, cookie));
		expect([right.ms, right.res.status]).toEqual([0, 303]);

		// The attack is not over because the owner signed in.
		expect(await heldInTurn([wrongAt(user.username, D)])).toEqual([4000]);
	});

	it('is not needed for five sent together at an account with none wrong; the rest are refused at once', async () => {
		const before = passwordChecks().checked;

		const seven = await heldFor(...[A, A, B, B, C, C, D].map((ip) => signIn(user.username, 'wrong', ip)));

		expect(seven.map(({ ms, res }) => [ms, res.status])).toEqual([...Array(5).fill([0, 400]), [0, 429], [0, 429]]);
		expect(seven[6].res.text).toContain(ALREADY_UNDER_WAY);
		expect(passwordChecks().checked).toBe(before + 5);
		expect(wrongSignInsAt(`user:${user.id}`)).toBe(5);
	});

	it('holds a name that is no account the same way, in the same words', async () => {
		await fiveWrong('nobody-here');
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		let together: { ms: number; res: Answer }[];
		try {
			together = await heldFor(signIn('nobody-here', 'wrong', B), signIn('nobody-here', 'wrong', C), signIn('nobody-here', 'wrong', D));
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		expect(together.map(({ ms, res }) => [ms, res.status])).toEqual(ONE_AT_A_TIME);
		expect(together[1].res.text).toContain(ALREADY_UNDER_WAY);
		expect(together[2].res.text).toContain(ALREADY_UNDER_WAY);
		expect(sqlite.prepare("SELECT message, user_id AS userId FROM system_logs WHERE message LIKE '%not known here%'").all()).toEqual([
			{ message: 'Sign-ins at a name that is no account from browsers not known here are being let in one at a time', userId: null }
		]);
	});

	// A refusal was let past the address's count and so noted against the
	// account; a success there would otherwise give it back (card 2226).
	it('keeps a refusal counted at its address when the account then signs in from it', async () => {
		await heldInTurn([B, B, C, C, D].map((ip) => wrongAt(user.username, ip)));
		const together = await heldFor(signIn(user.username, 'wrong', A), signIn(user.username, 'wrong', A), signIn(user.username, 'wrong', A));
		expect(together.map(({ ms, res }) => [ms, res.status])).toEqual(ONE_AT_A_TIME);

		const [right] = await heldFor(signIn(user.username, 'right', A));
		expect(right.res.status).toBe(303);

		// The one checked and the right one are given back; the two refused are not.
		expect(countedAt(A)).toBe(3);
	});

	it('answers a cookie that does not hold as no cookie at all', async () => {
		const other = makeUser();
		sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSync('right', 4), other.id);
		const good = await rememberedAt();
		const [name, value] = good.split('=');
		const [issued, nonce, mac] = value.split('.');
		const theirs = (await rememberedAt(other, B)).split('=')[1];

		/** At an account with five wrong, three sent together with `cookie`. */
		const sentWith = async (cookie: string) => {
			resetAllRateLimits();
			await fiveWrong();
			return threeTogether(user.username, cookie);
		};

		expect(await sentWith(good), 'the cookie as it was set').toEqual(EACH_AT_ONCE);
		expect(await sentWith(`${name}=${issued}.${nonce}.${mac.slice(0, -1)}${mac.endsWith('0') ? '1' : '0'}`), 'its MAC changed').toEqual(
			ONE_AT_A_TIME
		);
		expect(await sentWith(`${name}=${theirs}`), 'another account’s, under this account’s name').toEqual(ONE_AT_A_TIME);

		// The password set again (a new hash of the same password, as a reset makes).
		sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSync('right', 4), user.id);
		expect(await sentWith(good), 'issued before the password was set').toEqual(ONE_AT_A_TIME);

		const old = await rememberedAt();
		vi.setSystemTime(Date.now() + 366 * 24 * 60 * 60 * 1000);
		expect(await sentWith(old), 'issued 366 days ago').toEqual(ONE_AT_A_TIME);
	});

	it('is not remembered after five wrong from it, until 15 minutes pass without one', async () => {
		const cookie = await rememberedAt();
		const nonce = nonceOf(cookie);

		expect(await heldInTurn(Array.from({ length: 5 }, () => wrongAt(user.username, A, cookie)))).toEqual([0, 0, 0, 0, 0]);
		// Counted at its cookie, and neither at the account nor at the address.
		expect(wrongSignInsAt(`nonce:${nonce}`)).toBe(5);
		expect(wrongSignInsAt(`user:${user.id}`)).toBe(0);

		// The sixth is a browser not remembered: counted at its address and at the account.
		await heldInTurn([wrongAt(user.username, A, cookie)]);
		expect(wrongSignInsAt(`nonce:${nonce}`)).toBe(5);
		expect(wrongSignInsAt(`user:${user.id}`)).toBe(1);
		expect(countedAt(A)).toBe(2);

		// Remembered again 15 minutes after its last wrong one.
		vi.advanceTimersByTime(15 * 60 * 1000 + 1);
		await heldInTurn([wrongAt(user.username, A, cookie)]);
		expect(wrongSignInsAt(`nonce:${nonce}`)).toBe(1);
		expect(wrongSignInsAt(`user:${user.id}`)).toBe(0);
	});

	// The review's R2. Attempts sent together all read the cookie's count
	// before any is checked, so a copied cookie was a volley of guesses.
	it('is let in five at a time; past that it is a browser not remembered, held one at a time', async () => {
		const cookie = await rememberedAt();
		await fiveWrong();

		const eight = await heldFor(...Array.from({ length: 8 }, () => signIn(user.username, 'wrong', D, cookie)));

		expect(eight.map(({ ms, res }) => [ms, res.status])).toEqual([...Array(5).fill([0, 400]), ...ONE_AT_A_TIME]);
		expect(wrongSignInsAt(`nonce:${nonceOf(cookie)}`)).toBe(5);
		expect(wrongSignInsAt(`user:${user.id}`)).toBe(6);
		// The three past it were counted at the address; the five were not.
		expect(countedAt(D)).toBe(4);
	});

	// The review's L1. Each right password makes a new cookie, so five in
	// flight for each cookie did not hold whoever has the password: three
	// hundred cookies were fifteen hundred checks in the first lane, ahead of
	// every sign-in from a browser not remembered. A remembered browser also
	// takes a place at the account's first-lane checks, five in flight, shared
	// with its sessions' current passwords.
	it('is refused past five in flight at the account, however many cookies there are, counting nothing', async () => {
		const cookies: string[] = [];
		for (const ip of [A, A, B, B, C, C]) cookies.push(await rememberedAt(user, ip));
		const before = passwordChecks().checked;

		const six = await heldFor(...cookies.map((cookie) => signIn(user.username, 'wrong', D, cookie)));

		expect(six.map(({ ms, res }) => [ms, res.status])).toEqual([...Array(5).fill([0, 400]), [0, 429]]);
		expect(six[5].res.text).toContain(ALREADY_UNDER_WAY);
		expect(passwordChecks().checked).toBe(before + 5);
		// Nothing was checked for it, so nothing is counted: not at its
		// cookie, not at the account, and not at the address.
		expect(wrongSignInsAt(`nonce:${nonceOf(cookies[5])}`)).toBe(0);
		expect(wrongSignInsAt(`user:${user.id}`)).toBe(0);
		expect(countedAt(D)).toBe(1);

		// And the places are given back: the same six one after another are each checked.
		expect(await heldInTurn(cookies.map((cookie) => () => signIn(user.username, 'wrong', D, cookie)))).toEqual([0, 0, 0, 0, 0, 0]);
	});

	it('is not held by its address’s limit, and gives the address nothing back', async () => {
		const cookie = await rememberedAt();
		// Ten from A without the cookie: three at the account, and seven at
		// accounts of their own, so that no account's waits begin.
		await heldInTurn([A, A, A].map((ip) => wrongAt(user.username, ip)));
		for (const name of Array.from({ length: 7 }, () => makeUser().username)) {
			expect((await heldFor(signIn(name, 'wrong', A)))[0].res.status).toBe(400);
		}

		const [right] = await heldFor(signIn(user.username, 'right', A, cookie));
		expect([right.ms, right.res.status]).toEqual([0, 303]);

		// Card 2226: its success gave back nothing, not even the three at its
		// own account, since it was not counted at the address.
		const [limited] = await heldFor(signIn(user.username, 'wrong', A));
		expect([limited.ms, limited.res.status]).toEqual([0, 429]);
		expect(limited.res.text).toContain('Too many login attempts');
	});

	// The review's R5: nobody signs in at the deploy, so a browser signed in
	// since before it is remembered when it signs out.
	it('stays remembered when it signs out, and is remembered by signing out', async () => {
		const [{ res }] = await heldFor(signIn(user.username, 'right', A));
		const known = setCookie(res, knownBrowserCookie(user.id))!.split(';')[0];
		const session = setCookie(res, SESSION_COOKIE_NAME)!.split(';')[0];
		const logOut = (cookie?: string) =>
			heldFor(send('POST', '/logout', { headers: cookie ? { ...LOGIN_FORM, cookie } : LOGIN_FORM, body: '', ip: A }));

		const [out] = await logOut(session);
		expect(out.res.status).toBe(303);
		const again = setCookie(out.res, knownBrowserCookie(user.id));
		expect(attributesOf(again!)).toEqual(['httponly', `max-age=${365 * 24 * 60 * 60}`, 'path=/login', 'samesite=strict']);
		const [none] = await logOut();
		expect(none.res.headers.getSetCookie()).toEqual([]);

		await fiveWrong();
		expect(await threeTogether(user.username, known), 'the cookie it had').toEqual(EACH_AT_ONCE);
		expect(await threeTogether(user.username, again!.split(';')[0]), 'the one signing out gave it').toEqual(EACH_AT_ONCE);
	});

	it('is signed for with a key kept in the settings, made once; without the key no cookie holds, and a Reset forgets it', async () => {
		const keys = () => sqlite.prepare('SELECT value FROM settings WHERE key = ?').all(KNOWN_BROWSER_SECRET_KEY) as { value: string }[];
		resetKnownBrowserSecretCache();
		sqlite.prepare('DELETE FROM settings WHERE key = ?').run(KNOWN_BROWSER_SECRET_KEY);

		const cookie = await rememberedAt();
		const [made] = keys();
		expect(made.value).toMatch(/^[0-9a-f]{64}$/);
		await rememberedAt(user, B);
		expect(keys()).toEqual([made]);

		// Its row deleted on the host and the server restarted: no cookie of it holds, and asking makes none.
		sqlite.prepare('DELETE FROM settings WHERE key = ?').run(KNOWN_BROWSER_SECRET_KEY);
		resetKnownBrowserSecretCache();
		await fiveWrong();
		expect(await threeTogether(user.username, cookie)).toEqual(ONE_AT_A_TIME);
		expect(keys()).toEqual([]);

		// A Reset clears the settings, and the key kept in memory goes with them.
		resetAllRateLimits();
		await rememberedAt();
		const [before] = keys();
		expect(before.value).not.toBe(made.value);
		expect((await api('POST', '/api/admin/reset', { user: chief })).status).toBe(200);
		expect(keys()).toEqual([]);
		const owner = makeUser({ role: 'superadmin' });
		sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSync('right', 4), owner.id);
		await rememberedAt(owner);
		const [after] = keys();
		expect(after.value).not.toBe(before.value);
	});

	it('says at every start, whatever LOG_LEVEL is, while the one-at-a-time rule is off, and takes nothing else for off', () => {
		const level = process.env.LOG_LEVEL;
		const warned = vi.mocked(console.warn);
		try {
			process.env.LOG_LEVEL = 'ERROR';
			process.env.SIGN_IN_ONE_AT_A_TIME = 'off';
			rereadSignInsOneAtATime();
			expect(reportSignInsNotOneAtATime()).toBe(true);
			expect(warned.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('SIGN_IN_ONE_AT_A_TIME=off'))).toHaveLength(1);

			process.env.LOG_LEVEL = 'WARN';
			for (const value of ['on', '', 'maybe']) {
				process.env.SIGN_IN_ONE_AT_A_TIME = value;
				rereadSignInsOneAtATime();
				expect(reportSignInsNotOneAtATime(), value).toBe(false);
			}
			delete process.env.SIGN_IN_ONE_AT_A_TIME;
			rereadSignInsOneAtATime();
			expect(reportSignInsNotOneAtATime()).toBe(false);
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
			delete process.env.SIGN_IN_ONE_AT_A_TIME;
			rereadSignInsOneAtATime();
		}
		// A value that is neither is said once, and taken as on.
		expect(sqlite.prepare("SELECT level, message FROM system_logs WHERE message LIKE 'SIGN_IN_ONE_AT_A_TIME%'").all()).toEqual([
			{
				level: 'WARN',
				message:
					'SIGN_IN_ONE_AT_A_TIME is "maybe", which is neither on nor off: sign-ins from browsers not remembered are held to one at a time'
			}
		]);
	});
});

/**
 * The handlers that count a request against its address asked for it
 * unguarded: with `ADDRESS_HEADER` set and the header absent, the lookup
 * throws, and signing in was a 500. Each asks it guarded now
 * ($lib/server/client-address.ts), and a request whose address cannot be read
 * is counted, with every other such request, as `unknown`: never let past the
 * limit uncounted.
 */
describe('a request whose address cannot be read, to a handler that counts by address', () => {
	const FORM = { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', accept: 'text/html' };

	// Ten wrong passwords at one account: from the sixth, each waits before it
	// is answered (card 2177), so this runs on the fake clock.
	it('is answered, and not 500, on the login form, and counted: ten wrong passwords, and the eleventh is 429', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await onTheFakeClock();
		try {
			const waited: number[] = [];
			for (let i = 0; i < 10; i++) {
				const [{ ms, res }] = await heldFor(signIn(user.username, 'wrong', null));
				expect(res.status, `attempt ${i + 1}`).toBe(400);
				waited.push(ms);
			}
			expect(waited).toEqual([0, 0, 0, 0, 0, 1000, 2000, 4000, 4000, 4000]);

			// Refused at once, by the address's limit, before any wait.
			const [limited] = await heldFor(signIn(user.username, 'wrong', null));
			expect(limited.ms).toBe(0);
			expect(limited.res.status).toBe(429);
			expect(limited.res.text).toContain('Too many login attempts');
			// A caller whose address is known is counted apart: answered, after the account's wait.
			const [known] = await heldFor(signIn(user.username, 'wrong', '203.0.113.20'));
			expect(known.res.status).toBe(400);
			expect(known.ms).toBe(4000);
		} finally {
			vi.useRealTimers();
		}
	});

	it('is answered, and not 500, by the public request form’s routes', async () => {
		const { issueFormToken } = await import('$lib/server/request-tokens');
		const formToken = { 'x-form-token': issueFormToken(), accept: '*/*' };

		const targets = await send('GET', '/api/requests/targets', { headers: formToken, ip: null });
		expect(targets.status).toBe(200);

		// Refused for what it holds, which is the handler's own answer.
		const submitted = await send('POST', '/api/requests', { headers: { ...formToken, ...JSON_BODY }, body: { title: '' }, ip: null });
		expect(submitted).toMatchObject({ status: 400 });
		expect(JSON.parse(submitted.text)).toEqual({ message: 'Title is required' });

		const confirmed = await send('POST', '/api/requests/999999/confirm', { headers: { ...JSON_BODY, accept: '*/*' }, body: { token: 'x' }, ip: null });
		expect(confirmed.status).toBe(404);
	});
});

/**
 * Counting an address (card 2195). Every count by address keyed on the
 * address exactly as it was received: an IPv6 caller had a count for each of
 * the 2^64 addresses of its /64 (probe: eleven wrong sign-ins from one /64,
 * never refused), an IPv4 address written as IPv6 was counted apart from
 * itself, and each port would have been an allowance of its own. Each limit
 * counts by `addressKey` now, and the log keeps the address as received.
 */
describe('counting an address', () => {
	it.each([
		['2001:db8:1:2::1', '2001:db8:1:2::/64'],
		['2001:0DB8:0001:0002:ffff::9', '2001:db8:1:2::/64'],
		['2001:db8:1:3::1', '2001:db8:1:3::/64'],
		['::ffff:198.51.100.7', '198.51.100.7'],
		['::FFFF:c633:6407', '198.51.100.7'],
		['198.51.100.7', '198.51.100.7'],
		['198.51.100.7:51234', '198.51.100.7'],
		['[2001:db8:1:2::1]:443', '2001:db8:1:2::/64'],
		['fe80::1%eth0', 'fe80:0:0:0::/64'],
		['2001:db8:1:2::198.51.100.7', '2001:db8:1:2::/64'],
		['64:ff9b::198.51.100.7', '64:ff9b:0:0::/64'],
		['unknown', 'unknown'],
		['not an address', 'not an address']
	])('counts %s as %s', (address, key) => {
		expect(addressKey(address)).toBe(key);
	});

	it('keeps 100 characters of something that is no address', () => {
		expect(addressKey('x'.repeat(500))).toBe('x'.repeat(100));
	});

	it('holds one IPv6 network to ten sign-ins, and logs the address as it was received', async () => {
		// Each at an account of its own, so that no account's waits begin.
		const names = Array.from({ length: 11 }, () => makeUser().username);
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			for (let n = 1; n <= 10; n++) {
				expect((await signIn(names[n - 1], 'wrong', `2001:db8:1:2::${n}`)).status, `attempt ${n}`).toBe(400);
			}
			const limited = await signIn(names[10], 'wrong', '2001:db8:1:2::ab');
			expect(limited.status).toBe(429);
			expect(limited.text).toContain('Too many login attempts');

			// Another network is counted apart.
			expect((await signIn(names[10], 'wrong', '2001:db8:1:3::1')).status).toBe(400);
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		// The refusal's line says what it was counted as, and the line and the
		// gate's own keep the address that was sent.
		expect(sqlite.prepare("SELECT message, ip FROM system_logs WHERE message LIKE 'Rate limit hit%'").all()).toEqual([
			{ message: 'Rate limit hit for IP 2001:db8:1:2::ab, counted as 2001:db8:1:2::/64 (login attempts)', ip: '2001:db8:1:2::ab' }
		]);
		expect(sqlite.prepare("SELECT ip FROM system_logs WHERE context = 'HTTP' AND message LIKE 'POST /login → 429%'").all()).toEqual([
			{ ip: '2001:db8:1:2::ab' }
		]);
	});

	it('counts an IPv4 address written as IPv6 as the IPv4 address', async () => {
		const names = Array.from({ length: 11 }, () => makeUser().username);
		for (let n = 1; n <= 10; n++) {
			expect((await signIn(names[n - 1], 'wrong', '198.51.100.7')).status, `attempt ${n}`).toBe(400);
		}
		expect((await signIn(names[10], 'wrong', '::ffff:198.51.100.7')).status).toBe(429);
	});

	it('holds one IPv6 network to sixty requests with no key a minute', async () => {
		for (let n = 1; n <= 60; n++) {
			expect((await gate('GET', '/api/v1/me', { ip: `2001:db8:5:6::${n.toString(16)}` })).status, `request ${n}`).toBe(401);
		}
		expect((await gate('GET', '/api/v1/me', { ip: '2001:db8:5:6:ffff::1' })).status).toBe(429);
		expect((await gate('GET', '/api/v1/me', { ip: '2001:db8:5:7::1' })).status).toBe(401);
	});

	it('holds one IPv6 network to the public request form’s five', async () => {
		const { issueFormToken } = await import('$lib/server/request-tokens');
		const headers = { 'x-form-token': issueFormToken(), accept: '*/*', ...JSON_BODY };
		const submit = (ip: string) => send('POST', '/api/requests', { headers, body: { title: '' }, ip });

		for (let n = 1; n <= 5; n++) expect((await submit(`2001:db8:7:8::${n}`)).status, `request ${n}`).toBe(400);
		expect((await submit('2001:db8:7:8::99')).status).toBe(429);
	});
});

/**
 * The failed sign-in line, and what a name that is no account costs (cards
 * 2192 and 2193). A name that is no account was answered at once, where a
 * wrong password at an account took a bcrypt check (probe: 1 ms against 206
 * ms), so the clock told which names were accounts. And each failed line
 * wrote the name as typed: a password typed into the name box in clear, and
 * an email where an account was meant.
 */
describe('a failed sign-in', () => {
	/** Every line sign-in failed with, as the system log holds it. */
	const failedLines = () =>
		sqlite.prepare("SELECT message, ip, user_id AS userId FROM system_logs WHERE message LIKE 'Failed login attempt%' ORDER BY id").all();

	beforeEach(() => {
		sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSync('right', 4), user.id);
	});

	it('at a name that is no account costs the one check a wrong password at an account costs, and is answered alike', async () => {
		const before = passwordChecks().checked;
		const real = await signIn(user.username, 'wrong', '203.0.113.40');
		expect(passwordChecks().checked).toBe(before + 1);

		const none = await signIn('nobody-here', 'wrong', '203.0.113.40');
		expect(passwordChecks().checked).toBe(before + 2);
		expect(none.status).toBe(real.status);
		expect(none.status).toBe(400);
		expect(none.text).toContain(WRONG);
	});

	it('writes nothing that was typed: a name that is no account by its length, an account by its own name', async () => {
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect((await signIn('n'.repeat(10_000), 'wrong', '203.0.113.41')).status).toBe(400);
			expect((await signIn('MyS3cret!Passw0rd', 'anything', '203.0.113.42')).status).toBe(400);
			expect((await signIn(user.email, 'wrong', '203.0.113.43')).status).toBe(400);
			expect((await signIn('nobody-here', 'wrong', null)).status).toBe(400);
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		const lines = failedLines() as { message: string }[];
		expect(lines).toEqual([
			{ message: 'Failed login attempt for a name that is no account (10000 characters) from IP 203.0.113.41', ip: '203.0.113.41', userId: null },
			{ message: 'Failed login attempt for a name that is no account (17 characters) from IP 203.0.113.42', ip: '203.0.113.42', userId: null },
			{
				message: `Failed login attempt at "${user.username}" (user ${user.id}) from IP 203.0.113.43 (bad password)`,
				ip: '203.0.113.43',
				userId: user.id
			},
			{ message: 'Failed login attempt for a name that is no account (11 characters) from IP unknown', ip: null, userId: null }
		]);
		for (const { message } of lines) expect(message.length).toBeLessThan(300);

		// Nowhere in the log: not in a line, nor in what is kept with one.
		const everything = JSON.stringify(sqlite.prepare('SELECT message, meta FROM system_logs').all());
		expect(everything).not.toContain('MyS3cret!Passw0rd');
		expect(everything).not.toContain(user.email);
		expect(everything).not.toContain('n'.repeat(100));
	});

	// Card 2177 reads both fields as text, or as nothing: a file was a 500.
	it.each([
		['identity', 'Please enter your username or email'],
		['password', 'Please enter your password']
	])('is answered 400 with the empty field’s words when the %s is a file', async (field, words) => {
		const form = new FormData();
		form.append('identity', user.username);
		form.append('password', 'wrong');
		form.set(field, new Blob(['what was in the file']), 'typed.txt');

		const res = await send('POST', '/login', { headers: { origin: 'http://localhost', accept: 'text/html' }, body: form });
		expect(res.status).toBe(400);
		expect(res.text).toContain(words);
	});
});

/**
 * SvelteKit decodes an address before it looks for a route, so `/%61dmin` is
 * served by the route `/admin`. The gate compared the address as it was sent,
 * and so each rule below did not apply to the encoded form of the address it
 * was written for. Now every rule is decided on the path as the router sees
 * it (`routedPath` in src/hooks.server.ts), and each encoded form is answered
 * exactly as the plain one is.
 */
describe('an address with a letter percent-encoded', () => {
	/** What a caller is sent: the status, where it is sent on to, the type and the body. */
	async function answered(method: string, path: string, opts: GateOptions = {}) {
		const res = await send(method, path, opts);
		return { status: res.status, location: res.headers.get('location'), type: res.type, text: res.text };
	}

	const HTML = { accept: 'text/html' };

	it.each([
		{ plain: '/admin', encoded: '/%61dmin' },
		{ plain: '/admin', encoded: '/admi%6E' },
		{ plain: '/audit', encoded: '/%61udit' },
		{ plain: '/audit', encoded: '/%61%75%64%69%74' }
	])('$encoded sends a plain user home, as $plain does, and shows nothing', async ({ plain, encoded }) => {
		const asPlain = await answered('GET', plain, { headers: { ...asUser, ...HTML } });
		const asEncoded = await answered('GET', encoded, { headers: { ...asUser, ...HTML } });

		expect(asPlain).toEqual({ status: 303, location: '/', type: null, text: '' });
		expect(asEncoded).toEqual(asPlain);
	});

	it.each([
		{ plain: '/admin/__data.json', encoded: '/%61dmin/__data.json' },
		{ plain: '/audit/__data.json', encoded: '/%61udit/__data.json' }
	])('$encoded hands a plain user no data, as $plain does', async ({ plain, encoded }) => {
		const asPlain = await answered('GET', plain, { headers: asUser });
		const asEncoded = await answered('GET', encoded, { headers: asUser });

		// A page's data is asked for by the page's own script, which is told to
		// go elsewhere in JSON and not with a 303.
		expect(asPlain).toEqual({
			status: 200,
			location: null,
			type: 'application/json',
			text: JSON.stringify({ type: 'redirect', location: '/' })
		});
		expect(asEncoded).toEqual(asPlain);
		// What the admin page's data holds: every user's name, email and role.
		expect(asEncoded.text).not.toContain(admin.email);
		expect(asEncoded.text).not.toContain(admin.username);
	});

	it('sends somebody who is not signed in to the login page, encoded or not', async () => {
		for (const path of ['/admin', '/%61dmin', '/audit', '/%61udit']) {
			expect(await answered('GET', path, { headers: HTML })).toEqual({ status: 303, location: '/login', type: null, text: '' });
		}
	});

	it(
		'still shows an administrator the page, encoded or not',
		async () => {
			for (const path of ['/admin', '/%61dmin', '/audit', '/%61udit']) {
				const res = await answered('GET', path, { headers: { ...asAdmin, ...HTML } });

				expect({ path, status: res.status, type: res.type }).toEqual({ path, status: 200, type: 'text/html' });
				expect(res.text).toMatch(/^<!doctype html>/i);
			}
			// The admin page lists the users, and the plain user is one of them.
			expect((await answered('GET', '/%61dmin', { headers: { ...asAdmin, ...HTML } })).text).toContain(user.email);
			expect((await answered('GET', '/%61dmin/__data.json', { headers: asAdmin })).text).toContain(user.email);
		},
		60_000
	);

	it('/%61pi/v1/me asks for a key, as /api/v1/me does: a session is not one', async () => {
		const asPlain = await answered('GET', '/api/v1/me', { headers: { ...asUser, ...HTML } });
		const asEncoded = await answered('GET', '/%61pi/v1/me', { headers: { ...asUser, ...HTML } });

		expect(asPlain).toEqual({
			status: 401,
			location: null,
			type: 'application/json',
			text: JSON.stringify({ message: 'Missing or invalid Authorization header. Use: Bearer <api_key>' })
		});
		expect(asEncoded).toEqual(asPlain);
		expect(await answered('GET', '/api/v1/%6De', { headers: asUser })).toEqual(asPlain);
	});

	it('/%61pi/v1/ is under the v1 rules: answered in JSON, counted against the key, and limited', async () => {
		// A failure is JSON whatever the request asked for.
		expectJson(await send('GET', '/%61pi/v1/cards/999999', { headers: { ...withKey, ...HTML } }), 404, { message: 'Card not found' });
		expectJson(await send('GET', '/%61pi/v1/no-such-thing', { headers: { ...withKey, ...HTML } }), 404, { message: 'Not found' });

		// Those were two of the key's sixty.
		for (let i = 0; i < 58; i++) {
			expect((await gate('GET', '/%61pi/v1/me', { headers: withKey })).status).toBe(200);
		}
		expect((await gate('GET', '/%61pi/v1/me', { headers: withKey })).status).toBe(429);
		expect((await gate('GET', '/api/v1/me', { headers: withKey })).status).toBe(429);
	});

	it('POST /%61pi/cards has its body guarded, as POST /api/cards does', async () => {
		const caller = { ...asUser, ...JSON_BODY, accept: '*/*' };

		for (const path of ['/api/cards', '/%61pi/cards', '/api/%63ards']) {
			expectJson(await send('POST', path, { headers: caller, body: '{not json' }), 400, NOT_JSON);
			expectJson(await send('POST', path, { headers: caller, body: 'null' }), 400, NOT_AN_OBJECT);
			expectJson(await send('POST', path, { headers: { ...caller, ...DECLARED }, body: bodyOverTheLimit() }), 413, { message: 'Payload Too Large' });
		}
		expect(count('cards')).toBe(0);
	});

	it(
		'is decoded once, as the router decodes it: /%2561dmin is not the admin path',
		async () => {
			// `%25` is a percent sign and is left as one, so this is the address
			// `/%61dmin` spelt out and no route. A plain user is shown the page
			// for a path that is nothing, and is not sent home as from /admin.
			const plain = await answered('GET', '/%2561dmin', { headers: { ...asUser, ...HTML } });
			expect({ status: plain.status, location: plain.location, type: plain.type }).toEqual({
				status: 404,
				location: null,
				type: 'text/html'
			});

			// An administrator is not shown the admin page by it either.
			const administrator = await answered('GET', '/%2561dmin', { headers: { ...asAdmin, ...HTML } });
			expect(administrator.status).toBe(404);
			expect(administrator.text).not.toContain(user.email);

			expect(await answered('GET', '/%2561dmin', { headers: HTML })).toEqual({ status: 303, location: '/login', type: null, text: '' });
			// Nor is /%2561pi/ under /api/: a key is not asked for, a session is.
			expect((await answered('GET', '/%2561pi/v1/me', { headers: withKey })).location).toBe('/login');
		},
		60_000
	);

	it(
		'leaves %2F as it is, as the router does: it is no slash',
		async () => {
			// No route, so the page for a path that is nothing, and not a v1
			// answer: /api%2Fv1%2Fme is not under /api/v1/.
			const res = await answered('GET', '/api%2Fv1%2Fme', { headers: { ...asUser, ...HTML } });
			expect({ status: res.status, type: res.type }).toEqual({ status: 404, type: 'text/html' });
			expect((await answered('GET', '/api%2Fv1%2Fme', { headers: withKey })).location).toBe('/login');

			// It does begin with /admin, and so a plain user is sent home from
			// it before the router is asked and finds nothing.
			expect(await answered('GET', '/admin%2Fusers', { headers: { ...asUser, ...HTML } })).toEqual({
				status: 303,
				location: '/',
				type: null,
				text: ''
			});
			expect((await answered('GET', '/admin%2Fusers', { headers: { ...asAdmin, ...HTML } })).status).toBe(404);
		},
		60_000
	);

	// Which is why the gate can decode an address without a catch. That it is
	// SvelteKit's answer and not the gate's is shown with the log, below.
	it('is answered 400 by SvelteKit when it cannot be decoded, to anybody', async () => {
		for (const path of ['/%zz', '/admin%E0%A4%A', '/api/v1/%E0%A4%A']) {
			for (const headers of [{}, asUser, { ...asAdmin, ...withKey }]) {
				const res = await answered('GET', path, { headers });

				expect({ path, ...res }).toEqual({ path, status: 400, location: null, type: null, text: 'Malformed URI' });
			}
		}
	});

	// `routedPath` reads a route's id as it is written, and a `(group)` is in
	// the id and not in the address: `/(app)/admin` does not begin with
	// `/admin`. There is none. One that is added has to be allowed for there.
	it('is decided on route ids that have no (group) in them', () => {
		const inGroups = (readdirSync(join(process.cwd(), 'src/routes'), { recursive: true }) as string[])
			.map((path) => path.split('\\').join('/'))
			.filter((path) => path.split('/').some((segment) => /^\(.+\)$/.test(segment)));

		expect(inGroups).toEqual([]);
	});
});

/**
 * The two page loads the gate was the only guard for. Each is called here as
 * a function, with nothing in front of it: what it does for itself.
 */
describe.each([
	{ name: '/admin', file: 'admin' },
	{ name: '/audit', file: 'audit' }
])('the page load of $name, asked with no gate in front of it', ({ file }) => {
	type Load = (event: { locals: { user: SessionUser | null } }) => Promise<Record<string, unknown>>;
	const loads = import.meta.glob<{ load: Load }>('/src/routes/{admin,audit}/+page.server.ts');
	const load = async (as: SessionUser | null) => {
		const page = await loads[`/src/routes/${file}/+page.server.ts`]();
		return page.load({ locals: { user: as } });
	};
	/** What a load threw, if it threw a redirect: its status and where to. */
	const sentTo = async (as: SessionUser | null) => {
		const thrown = await load(as).then(
			() => null,
			(error: unknown) => error
		);
		return isRedirect(thrown) ? { status: thrown.status, location: thrown.location } : thrown;
	};

	it('sends a plain user home, as the gate does, and hands back nothing', async () => {
		expect(await sentTo(user)).toEqual({ status: 303, location: '/' });
	});

	it('sends somebody who is not signed in to the login page', async () => {
		expect(await sentTo(null)).toEqual({ status: 303, location: '/login' });
	});

	it('hands an administrator and a superadmin the page’s data', async () => {
		const superadmin = makeUser({ role: 'superadmin' });

		for (const as of [admin, superadmin]) {
			const data = await load(as);

			expect(JSON.stringify(data)).toContain(user.username);
		}
	});
});

/**
 * The same bodies, sent to a route of each kind. Each route read its body
 * with a bare `await request.json()` when these were written, and none of
 * them was changed to give these answers: the gate gives them. Each reads it
 * with `readBody` now (card 2117), which the gate stands in front of.
 */
describe.each([
	{
		name: 'a v1 route, POST /api/v1/boards',
		path: '/api/v1/boards',
		caller: () => withKey
	},
	{
		name: 'an internal route, POST /api/cards',
		path: '/api/cards',
		// A page's fetch asks for anything, which SvelteKit answers in JSON.
		caller: () => ({ ...asUser, accept: '*/*' })
	},
	{
		// Every field of a board has a default, so `[]` used to make one,
		// "Untitled Board", with its four columns and its owner.
		name: 'an internal route that needs no field, POST /api/boards',
		path: '/api/boards',
		caller: () => ({ ...asUser, accept: '*/*' })
	}
])('a body that is not a JSON object, sent to $name', ({ path, caller }) => {
	const post = (body?: string) => send('POST', path, { headers: { ...caller(), ...JSON_BODY }, body });

	it('is answered 400 when there is no body', async () => {
		expectJson(await post(), 400, NOT_JSON);
		expectJson(await post(''), 400, NOT_JSON);
	});

	it('is answered 400 when the body is not JSON', async () => {
		expectJson(await post('{not json'), 400, NOT_JSON);
		expectJson(await post('name=x'), 400, NOT_JSON);
	});

	it('is answered 400 when the body is null, a number, a string or a boolean', async () => {
		expectJson(await post('null'), 400, NOT_AN_OBJECT);
		expectJson(await post('5'), 400, NOT_AN_OBJECT);
		expectJson(await post('"x"'), 400, NOT_AN_OBJECT);
		expectJson(await post('true'), 400, NOT_AN_OBJECT);
	});

	it('is answered 400 when the body is an array, which no handler takes', async () => {
		expectJson(await post('[]'), 400, NOT_AN_OBJECT);
		expectJson(await post('[{"name":"x","title":"x","columnId":1}]'), 400, NOT_AN_OBJECT);
	});

	it('is answered 400 whatever Content-Type it is sent with', async () => {
		// The guard is on the read, not on what the request says its body is.
		const xml = await send('POST', path, { headers: { ...caller(), 'content-type': 'application/xml' }, body: '<a/>' });
		const none = await send('POST', path, { headers: { ...caller(), 'content-type': 'application/xml' }, body: 'null' });

		expectJson(xml, 400, NOT_JSON);
		expectJson(none, 400, NOT_AN_OBJECT);
	});

	it('changes nothing', async () => {
		for (const body of [undefined, '{not json', 'null', '[]']) await post(body);

		expect(count('boards')).toBe(0);
		expect(count('cards')).toBe(0);
	});
});

/**
 * The import reads no JSON: the legacy import of the old JSON export was
 * removed (card 2157), and a body that is not sent as a .db backup is refused
 * by its type before any of it is read. So the body guard never meets these,
 * and none of them is a 413, however long it runs: none is read.
 */
describe('POST /api/admin/import, sent anything but a .db backup', () => {
	const NOT_A_DB_BACKUP = {
		message:
			'Import takes a .db backup, sent as application/octet-stream. Exports in the old JSON format, which ' +
			'DumpFire wrote only from 1 to 7 April 2026, are no longer imported. Nothing was changed.'
	};

	it.each([
		{ name: 'no body', body: undefined, headers: {} },
		{ name: 'text that is not JSON', body: '{not json', headers: {} },
		{ name: 'a JSON object', body: '{"version":1,"boards":[],"columns":[]}', headers: {} },
		{ name: 'a body that runs past its limit', body: bodyOverTheLimit(), headers: DECLARED }
	])('is answered 400 as the superadmin, for $name sent as application/json, and changes nothing', async ({ body, headers }) => {
		const read = (['json', 'formData', 'arrayBuffer', 'text'] as const).map((reader) => vi.spyOn(Request.prototype, reader));
		const reported = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await send('POST', '/api/admin/import', { headers: { ...asChief, ...JSON_BODY, ...headers, accept: '*/*' }, body });

		expectJson(res, 400, NOT_A_DB_BACKUP);
		expect(read.map((reader) => reader.mock.calls.length), 'json, formData, arrayBuffer, text').toEqual([0, 0, 0, 0]);
		expect(reported).not.toHaveBeenCalled();
		// Nobody was signed out, and the accounts are the ones there were.
		expect({ users: count('users'), sessions: count('sessions'), boards: count('boards') }).toEqual({ users: 3, sessions: 3, boards: 0 });
	});
});

/**
 * A body read as a form that does not say it is one: the attachment upload,
 * and the three form actions, which SvelteKit hands a body sent as text. The
 * read threw a TypeError, which was a 500.
 */
describe('a body that is not a form, sent where a form is read', () => {
	const NOT_A_FORM = { message: 'The request body is not a form' };

	it('is answered 400 by the attachment upload, with nothing attached', async () => {
		const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
		const card = makeCard(makeBoard({ owner: user }).cols['To Do']);

		for (const [type, body] of [
			['application/json', '{}'],
			['text/plain', 'file=x'],
			// A form up to its first `;`, and not to undici, which reads the whole header.
			['application/x-www-form-urlencoded;a=b, text/plain', 'file=x']
		]) {
			const res = await send('POST', `/api/cards/${card.id}/attachments`, { headers: { ...asUser, accept: '*/*', 'content-type': type }, body });

			expectJson(res, 400, NOT_A_FORM);
		}
		expect(reported).not.toHaveBeenCalled();
		expect(count('card_attachments')).toBe(0);
	});

	it.each(['/login', '/invite/no-such-invite', '/setup'])('is answered 400 and not 500 by the form action of %s', async (path) => {
		// Set-up is open only while there are no users.
		if (path === '/setup') resetDb();
		const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
		const sent = { 'content-type': 'text/plain' };

		const asPage = await send('POST', path, { headers: { ...sent, accept: 'text/html' }, body: 'password=x' });
		const asScript = await send('POST', path, { headers: { ...sent, accept: 'application/json' }, body: 'password=x' });

		expect(asPage.status).toBe(400);
		expect({ status: asScript.status, body: JSON.parse(asScript.text) }).toEqual({ status: 400, body: { type: 'error', error: NOT_A_FORM } });
		expect(reported).not.toHaveBeenCalled();
	});
});

/**
 * The real servers pass no body on when a request has no Content-Type, and
 * `gate()` does as they do. So a body sent without one is a body that is
 * missing, however good it was.
 */
describe('a body sent with no Content-Type', () => {
	it.each([
		{ name: 'a v1 route', path: '/api/v1/boards', caller: () => withKey },
		{ name: 'an internal route', path: '/api/boards', caller: () => ({ ...asUser, accept: '*/*' }) }
	])('is answered 400 as a body that is missing, on $name, though it was valid JSON', async ({ path, caller }) => {
		const good = '{"name":"A board"}';

		expectJson(await send('POST', path, { headers: caller(), body: good }), 400, NOT_JSON);
		expect(count('boards')).toBe(0);

		// The same body with the header is the request it was meant to be.
		expect((await send('POST', path, { headers: { ...caller(), ...JSON_BODY }, body: good })).status).toBeLessThan(300);
		expect(count('boards')).toBe(1);
	});
});

/**
 * The limit is the node adapter's, which fails the body's stream with a 413
 * of its own class when the body is read: see `bodyOverTheLimit()`. SvelteKit
 * does not know that class for a 413 and answered 500. The gate guards the
 * three ways a handler reads a body, so each is a 413 with a `message`.
 */
describe('a body over the size limit', () => {
	it.each([
		{ name: 'a v1 route, read as JSON', path: () => '/api/v1/boards', caller: () => withKey, type: 'application/json' },
		{
			name: 'an internal route, read as JSON',
			path: () => '/api/cards',
			caller: () => ({ ...asUser, accept: '*/*' }),
			type: 'application/json'
		},
		{
			name: 'the attachment upload, read as a form',
			path: () => `/api/cards/${makeCard(makeBoard({ owner: user }).cols['To Do']).id}/attachments`,
			caller: () => ({ ...asUser, accept: '*/*' }),
			type: 'multipart/form-data; boundary=----dumpfire'
		},
		{
			name: 'the import of a .db backup, read as bytes',
			path: () => '/api/admin/import',
			caller: () => ({ ...asChief, accept: '*/*' }),
			type: 'application/octet-stream'
		}
	])('is answered 413 on $name', async ({ path, caller, type }) => {
		// A refusal and not a fault: nothing is reported as an error. As the
		// 500 it used to be, SvelteKit reported it on the console, and the
		// import logged it as a failed import.
		const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
		const to = path();
		const before = { users: count('users'), cards: count('cards'), attachments: count('card_attachments') };

		const res = await send('POST', to, { headers: { ...caller(), ...DECLARED, 'content-type': type }, body: bodyOverTheLimit() });

		expectJson(res, 413, { message: 'Payload Too Large' });
		expect(reported).not.toHaveBeenCalled();
		expect({ users: count('users'), cards: count('cards'), attachments: count('card_attachments') }).toEqual(before);
	});

	it('is answered as a page to a browser that asked for one, outside /api/v1/, with the same status', async () => {
		const res = await send('POST', '/api/cards', {
			headers: { ...asUser, ...JSON_BODY, ...DECLARED, accept: 'text/html' },
			body: bodyOverTheLimit()
		});

		expect(res.status).toBe(413);
		expect(res.type).toBe('text/html; charset=utf-8');
		expect(res.text).toContain('Payload Too Large');
	});
});

describe('an error() from a v1 handler', () => {
	// SvelteKit answers an error as JSON or as an HTML page by the Accept
	// header, and left alone it picks the page for each of these.
	it.each([
		['no Accept header', {}],
		['Accept: text/html', { accept: 'text/html' }],
		['Accept: text/html, */*;q=0.8', { accept: 'text/html, */*;q=0.8' }],
		['Accept: application/xml', { accept: 'application/xml' }]
	])('is answered as JSON to a request with %s', async (_name, accept) => {
		const res = await send('GET', '/api/v1/cards/999999', { headers: { ...withKey, ...accept } });

		expectJson(res, 404, { message: 'Card not found' });
	});

	it('leaves a success as the handler made it, whatever the request asked for', async () => {
		const res = await send('GET', '/api/v1/boards', { headers: { ...withKey, accept: 'text/html' } });

		expectJson(res, 200, []);
	});
});

describe('a path under /api/v1/ that is no route', () => {
	it('is answered 404 as JSON, with no page rendered and nothing about the key’s owner', async () => {
		const res = await send('GET', '/api/v1/no-such-thing', { headers: withKey });

		expectJson(res, 404, { message: 'Not found' });
		// SvelteKit's 404 page is HTML with the signed-in user's name, email
		// and role in it. None of that is here.
		expect(res.text).not.toContain('<');
		expect(res.text).not.toContain(user.username);
		expect(res.text).not.toContain(user.email);
		expect(res.text).not.toContain('role');
		expect(res.headers.get('x-sveltekit-page')).toBeNull();
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(res.text)));
	});

	it('is answered the same for any method, and for /api/v1/ itself', async () => {
		expectJson(await send('POST', '/api/v1/no-such-thing', { headers: withKey, body: { a: 1 } }), 404, { message: 'Not found' });
		expectJson(await send('DELETE', '/api/v1/boards/1/no-such-thing', { headers: withKey }), 404, { message: 'Not found' });
		expectJson(await send('GET', '/api/v1/', { headers: withKey }), 404, { message: 'Not found' });
	});

	it('is answered 401 without a key, as every path under /api/v1/ is', async () => {
		expectJson(await send('GET', '/api/v1/no-such-thing'), 401, {
			message: 'Missing or invalid Authorization header. Use: Bearer <api_key>'
		});
	});
});

describe('a method a v1 route does not have', () => {
	it('is answered 405 as JSON, with the Allow header and a Content-Length that is the body’s', async () => {
		const res = await send('PATCH', '/api/v1/me', { headers: withKey });

		expectJson(res, 405, { message: 'PATCH method not allowed' });
		expect(res.headers.get('allow')).toBe('GET, HEAD');
		// SvelteKit's own answer is 24 bytes of text. Sent on with a JSON body
		// and that length, the body would be cut short.
		expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(res.text)));
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('names the methods the route has', async () => {
		const res = await send('PATCH', '/api/v1/boards', { headers: withKey, body: {} });

		expectJson(res, 405, { message: 'PATCH method not allowed' });
		expect(res.headers.get('allow')).toBe('GET, POST, HEAD');
	});

	it('is answered 401 without a key', async () => {
		expect((await send('PATCH', '/api/v1/me')).status).toBe(401);
	});
});

describe('/api/v1/openapi.json, the one v1 path that needs no key', () => {
	it('is still answered 200 to a GET with no key', async () => {
		const res = await send('GET', '/api/v1/openapi.json');

		expect(res.status).toBe(200);
		expect(res.type).toBe('application/json');
		expect(JSON.parse(res.text).openapi).toMatch(/^3\./);
	});

	it('is not counted against any rate limit', async () => {
		for (let i = 0; i < 61; i++) await gate('GET', '/api/v1/openapi.json');

		expect((await gate('GET', '/api/v1/openapi.json')).status).toBe(200);
	});

	it('answers a POST 405 as JSON, with the Allow header, and asks for no key to say so', async () => {
		const res = await send('POST', '/api/v1/openapi.json', { body: {} });

		expectJson(res, 405, { message: 'POST method not allowed' });
		expect(res.headers.get('allow')).toBe('GET, HEAD');
		expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(res.text)));
	});
});

describe('what the gate leaves as it was', () => {
	it('an internal route refused by error() for a signed-in user is still { message }', async () => {
		const res = await send('PUT', '/api/cards/999999', {
			headers: { ...asUser, accept: '*/*' },
			body: { title: 'x' }
		});

		expectJson(res, 404, { message: 'Card not found' });
	});

	it('outside /api/v1/ the request is not made to ask for JSON, and a wrong method is still text', async () => {
		// A browser that opens an internal route's address still gets
		// SvelteKit's error page.
		const page = await send('PUT', '/api/cards/999999', {
			headers: { ...asUser, ...JSON_BODY, accept: 'text/html' },
			body: '{"title":"x"}'
		});
		expect(page.status).toBe(404);
		expect(page.type).toBe('text/html; charset=utf-8');
		expect(page.text).toContain('Card not found');

		const wrong = await send('PATCH', '/api/boards', { headers: asUser });
		expect(wrong.status).toBe(405);
		expect(wrong.type).toBeNull();
		expect(wrong.text).toBe('PATCH method not allowed');
		expect(wrong.headers.get('allow')).toBe('GET, POST, HEAD');
	});

	it(
		'a page is HTML: the login page, and the page for a path that is nothing',
		async () => {
			const login = await send('GET', '/login', { headers: { accept: 'text/html' } });
			expect(login.status).toBe(200);
			expect(login.type).toBe('text/html');
			expect(login.text).toMatch(/^<!doctype html>/i);

			// Not under /api/v1/, so SvelteKit renders its 404 page as before.
			const nothing = await send('GET', '/no-such-page', { headers: { ...asUser, accept: 'text/html' } });
			expect(nothing.status).toBe(404);
			expect(nothing.type).toBe('text/html');
			expect(nothing.text).toMatch(/^<!doctype html>/i);
		},
		60_000
	);
});

/**
 * Every answer the gate gives carries the five headers, unless the answer
 * has the header already. They were on the answers to a signed-in caller
 * only, and under /api/v1/ there was `nosniff` alone.
 */
describe('the security headers', () => {
	// Written out here, and not taken from the gate's own list: this is what
	// is to be sent.
	const FIVE: Record<string, string | null> = {
		'x-content-type-options': 'nosniff',
		'x-frame-options': 'DENY',
		'referrer-policy': 'strict-origin-when-cross-origin',
		'permissions-policy': 'camera=(), microphone=(), geolocation=()',
		'x-xss-protection': '0'
	};
	/** What a page another site may frame carries: all but the refusal to be framed. */
	const FRAMEABLE = { ...FIVE, 'x-frame-options': null };

	/** The five, as an answer carries them: null for one it does not. */
	const headersOf = (res: { headers: Headers }) => Object.fromEntries(Object.keys(FIVE).map((name) => [name, res.headers.get(name)]));
	const HTML = { accept: 'text/html' };

	it('are the five the gate sets', () => {
		expect(Object.fromEntries(SECURITY_HEADERS.map(([name, value]) => [name.toLowerCase(), value]))).toEqual(FIVE);
	});

	it(
		'are on a page for somebody who is not signed in: the login page, an invite and the API’s documents',
		async () => {
			for (const path of ['/login', '/invite/no-such-token', '/docs']) {
				const res = await send('GET', path, { headers: HTML });
				expect({ path, status: res.status }).toEqual({ path, status: 200 });
				expect(headersOf(res), path).toEqual(FIVE);
			}
		},
		60_000
	);

	it('are on every redirect the gate gives, and on the JSON a page’s script is sent on with', async () => {
		const answers = [
			['nobody, from /', await send('GET', '/', { headers: HTML })],
			['a plain user, from /admin', await send('GET', '/admin', { headers: { ...asUser, ...HTML } })],
			['somebody signed in, from /login', await send('GET', '/login', { headers: { ...asUser, ...HTML } })],
			['anybody, from /setup once there are users', await send('GET', '/setup', { headers: HTML })],
			['a plain user, from the admin page’s data', await send('GET', '/admin/__data.json', { headers: asUser })]
		] as const;

		for (const [who, res] of answers) {
			expect({ who, status: res.status }).toEqual({ who, status: who.includes('data') ? 200 : 303 });
			expect(headersOf(res), who).toEqual(FIVE);
		}
	});

	it('are on the gate’s own refusals: its 401s, its 404 for a remote call, its 413s and its 429', async () => {
		const answers: [string, Answer][] = [
			['401, /api/v1/ with no key', await send('GET', '/api/v1/me')],
			['401, an internal route with no session', await send('GET', '/api/boards', { headers: { accept: '*/*' } })],
			[
				'413, a form posted to /login',
				await send('POST', '/login', {
					headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(10 * 1024 * 1024) },
					body: 'identity=x'
				})
			],
			['413, at /favicon.ico, which passes the gate', await send('POST', '/favicon.ico', { headers: { ...JSON_BODY, 'content-length': String(10 * 1024 * 1024) }, body: '{}' })],
			[
				'413, a body with no length that ran past the limit as it was read',
				await send('POST', '/api/cards', {
					headers: { ...asUser, ...JSON_BODY, accept: '*/*' },
					body: new ReadableStream<Uint8Array>({
						start: (controller) => {
							controller.enqueue(new Uint8Array(600 * 1024).fill(0x20));
							controller.close();
						}
					})
				})
			],
			['404, a call to a remote function', await send('GET', '/_app/remote/abc123', { headers: { 'x-sveltekit-pathname': '/login' } })]
		];
		for (let i = 0; i < 60; i++) await gate('GET', '/api/v1/me', { headers: withKey });
		answers.push(['429, a key over its limit', await send('GET', '/api/v1/me', { headers: withKey })]);

		for (const [what, res] of answers) {
			expect({ what, status: res.status }).toEqual({ what, status: Number(what.slice(0, 3)) });
			expect(headersOf(res), what).toEqual(FIVE);
		}
	});

	it(
		'are on a v1 answer, on a handler’s refusal and on a page for somebody signed in',
		async () => {
			const answers = [
				['a v1 answer', await send('GET', '/api/v1/me', { headers: withKey })],
				['a v1 handler’s 404', await send('GET', '/api/v1/cards/999999', { headers: withKey })],
				['a v1 method the route has not got', await send('PATCH', '/api/v1/me', { headers: withKey })],
				['an internal handler’s 404', await send('PUT', '/api/cards/999999', { headers: { ...asUser, accept: '*/*' }, body: { title: 'x' } })],
				['the board list, signed in', await send('GET', '/', { headers: { ...asUser, ...HTML } })]
			] as const;

			for (const [what, res] of answers) expect(headersOf(res), what).toEqual(FIVE);
		},
		60_000
	);

	it('leave an attachment’s own as it set them, and add the rest', async () => {
		const card = makeCard(makeBoard({ owner: user }).cols['To Do']);
		const attachment = makeAttachment(card, { name: 'notes.html', mimeType: 'text/html', content: '<script>1</script>' });

		const res = await send('GET', `/api/cards/${card.id}/attachments/${attachment.id}`, { headers: asUser });

		expect(res.status).toBe(200);
		expect(res.headers.get('content-security-policy')).toBe('sandbox');
		expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
		expect(headersOf(res)).toEqual(FIVE);
	});

	// No route sets one of the five to another value today, so this is shown
	// on the function that sets them, which is what `handle` calls last.
	it('never replace a header the answer already has', () => {
		const own = new Response('x', {
			headers: { 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': 'sandbox' }
		});

		const res = secured(own, '/api/cards/[id]/attachments/[attachmentId]');

		expect(res).toBe(own);
		expect(headersOf(res)).toEqual({ ...FIVE, 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'no-referrer' });
		expect(res.headers.get('content-security-policy')).toBe('sandbox');
	});

	it(
		'are on the request form’s three pages but the refusal to be framed, for anybody',
		async () => {
			expect([...FRAMEABLE_ROUTES].sort()).toEqual(['/request', '/request/[id]/confirm', '/request/[id]/reply']);

			for (const path of ['/request', '/request/1/confirm', '/request/1/reply']) {
				for (const [who, headers] of [['nobody', HTML], ['a user', { ...asUser, ...HTML }]] as const) {
					const res = await send('GET', path, { headers });
					expect({ path, who, status: res.status }).toEqual({ path, who, status: 200 });
					expect(headersOf(res), `${path} for ${who}`).toEqual(FRAMEABLE);
				}
			}
			// The form's own data, which its script asks for, likewise.
			expect(headersOf(await send('GET', '/request/__data.json'))).toEqual(FRAMEABLE);
			// A path named like one of them is no route, and is not one of them.
			expect(headersOf(await send('GET', '/requestX', { headers: HTML }))).toEqual(FIVE);
		},
		60_000
	);
});

/**
 * Who is let through without a session is decided by route id, exactly. It
 * was decided by how the path began, which let `/requestX`, `/loginX` and
 * `/faviconX` past the sign-in redirect, to a 404.
 */
describe('the routes a caller who is not signed in is let through to', () => {
	/** What is meant to be public, written out here: the list the gate keeps is held to it. */
	const PUBLIC = [
		'/login',
		'/docs',
		'/invite/[token]',
		'/request',
		'/request/[id]/confirm',
		'/request/[id]/reply',
		'/api/requests',
		'/api/requests/[id]',
		'/api/requests/[id]/confirm',
		'/api/requests/[id]/messages',
		'/api/requests/targets',
		'/api/v1/openapi.json'
	];

	// Each route is sent a method it does not have. SvelteKit answers that
	// 405 itself, and only if the gate let the request through to it; the gate
	// answers nobody 401 or sends them to sign in, whatever the method. So the
	// 405s are the routes nobody is let through to.
	//
	// OPTIONS is the last one tried: an endpoint with no OPTIONS handler is
	// answered 405 by SvelteKit as for any other method, where a page answers
	// it 204. Only an endpoint that has all four of the others is sent it:
	// `/api/labels`, since the card window's label picker renames a label with
	// PATCH (card 2010).
	it(
		'are exactly the public routes, of every route in the tree',
		async () => {
			const letThrough: string[] = [];
			const routes = await gateRoutes();
			for (const route of routes) {
				const path = route.id.replace(/\[[^\]]+\]/g, '1');
				const has = route.endpoint ? await routeMethods(route.id) : [];
				const method = ['PATCH', 'PUT', 'DELETE', 'POST', ...(route.endpoint ? ['OPTIONS'] : [])].find((m) => !has.includes(m as never));
				if (!method) throw new Error(`${route.id} has every method: choose another way to tell`);

				const res = await gate(method, path);
				if (res.status === 405) letThrough.push(route.id);
				await res.body?.cancel();
			}

			expect(routes.length).toBeGreaterThan(100);
			expect(letThrough.sort()).toEqual([...PUBLIC].sort());
		},
		120_000
	);

	it.each(['/requestX', '/request/1', '/loginX', '/docsX', '/inviteX', '/invite', '/setupX', '/faviconX', '/favicon.png'])(
		'is not %s, which is named like a public route and is no route: a browser is sent to sign in',
		async (path) => {
			const res = await send('GET', path, { headers: { accept: 'text/html' } });

			expect({ status: res.status, location: res.headers.get('location') }).toEqual({ status: 303, location: '/login' });
		}
	);

	it('is not a path under a public API route that is no route: a script is answered 401', async () => {
		for (const path of ['/api/requestsX', '/api/requests/1/no-such-thing', '/api/requests/targets/x']) {
			expectJson(await send('GET', path, { headers: { accept: '*/*' } }), 401, { message: 'Not authenticated' });
		}
	});

	it('passes /favicon.ico through without asking who is calling', async () => {
		// There is no such file, so SvelteKit's 404, and not the login page.
		const res = await send('GET', '/favicon.ico', { headers: { accept: '*/*' } });
		expect({ status: res.status, location: res.headers.get('location') }).toEqual({ status: 404, location: null });
	});

	// SvelteKit answers every path that begins /_app itself, before it calls
	// the gate, but a call to a remote function: the gate's own line for
	// /_app/ is for a SvelteKit that does not. Here so that one that does not
	// is noticed.
	it('never meets a path that begins /_app but a remote call: SvelteKit has answered it 404 first, to anybody', async () => {
		for (const path of ['/_app/no-such-file.js', '/_appX/x', '/_app', '/_app/remote/']) {
			const res = await send('GET', path, { headers: { accept: 'text/html' } });
			expect({ path, status: res.status, text: res.text }).toEqual({ path, status: 404, text: 'Not found' });
		}
	});

	// A call to a remote function reaches the gate with `event.url` and the
	// route taken from the `x-sveltekit-pathname` header, which the caller
	// writes. Decided on that, a call that named `/login` was let through as
	// the public page, and one that named `/_app/x` passed through unasked
	// and unlogged. There are no remote functions here, and every such call is
	// answered 404 by the gate.
	it.each(['/_app/x', '/login', '/api/requests', '/admin'])(
		'answers a call to a remote function 404, whatever path it names: %s',
		async (named) => {
			for (const [who, headers] of [
				['nobody', {}],
				['an administrator', asAdmin]
			] as const) {
				for (const method of ['GET', 'POST']) {
					const res = await send(method, '/_app/remote/abc123', {
						headers: { ...headers, 'x-sveltekit-pathname': named, origin: 'http://localhost', ...JSON_BODY },
						body: method === 'POST' ? '{}' : undefined
					});
					expect({ who, method, status: res.status, location: res.headers.get('location') }).toEqual({
						who,
						method,
						status: 404,
						location: null
					});
					expect(res.text).toBe(JSON.stringify({ message: 'Not found' }));
				}
			}
		}
	);

	it('has /setup alone as the set-up page, which sends everybody home once there are users', async () => {
		expect((await send('GET', '/setup', { headers: { accept: 'text/html' } })).headers.get('location')).toBe('/');
		expect((await send('GET', '/setup', { headers: { ...asUser, accept: 'text/html' } })).headers.get('location')).toBe('/');
	});
});

/**
 * An internal route asked for something with no session is answered 401 when
 * a script asks, and a browser that goes to its address is still sent to
 * sign in. It was always sent to sign in: `fetch` followed the redirect and
 * handed the page the login page's HTML with a 200, and a page whose session
 * had ended went on as if its request had worked.
 */
describe('an internal route asked with no session', () => {
	const NOT_SIGNED_IN = { message: 'Not authenticated' };

	it('is answered 401 to a script, whatever it asks for and however it asks', async () => {
		expectJson(await send('GET', '/api/boards', { headers: { accept: '*/*' } }), 401, NOT_SIGNED_IN);
		expectJson(await send('GET', '/api/boards'), 401, NOT_SIGNED_IN);
		expectJson(await send('GET', '/api/boards', { headers: { accept: 'application/json' } }), 401, NOT_SIGNED_IN);
		// An EventSource, which asks for an event stream.
		expectJson(await send('GET', '/api/events', { headers: { accept: 'text/event-stream' } }), 401, NOT_SIGNED_IN);
		// A cookie that names no session is no session.
		expectJson(await send('GET', '/api/boards', { headers: { cookie: `${SESSION_COOKIE_NAME}=gone`, accept: '*/*' } }), 401, NOT_SIGNED_IN);
		// A write is answered before its body is looked at.
		expectJson(await send('POST', '/api/cards', { headers: JSON_BODY, body: '{not json' }), 401, NOT_SIGNED_IN);
		expect(count('cards')).toBe(0);
		// `/api/v1` with nothing after it is under /api/ and not under /api/v1/:
		// no route, and an internal path to the gate, key or no key.
		expectJson(await send('GET', '/api/v1', { headers: withKey }), 401, NOT_SIGNED_IN);
		expect((await send('GET', '/api/v1', { headers: { accept: 'text/html' } })).headers.get('location')).toBe('/login');
	});

	it('still sends a browser that goes to its address to sign in: an attachment opened in a tab, the milestone PDF', async () => {
		const asked: Record<string, string>[] = [
			{ 'sec-fetch-mode': 'navigate', accept: '*/*' },
			{ accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
			{ accept: 'text/html' }
		];
		for (const headers of asked) {
			for (const path of ['/api/cards/1/attachments/1', '/api/milestones/1/pdf', '/api/admin/export']) {
				const res = await send('GET', path, { headers });
				expect({ path, headers, status: res.status, location: res.headers.get('location') }).toEqual({
					path,
					headers,
					status: 303,
					location: '/login'
				});
			}
		}
	});

	it('leaves a page as it was: a browser and a script alike are sent to sign in', async () => {
		for (const headers of [{ accept: 'text/html' }, { accept: '*/*' }, {}] as Record<string, string>[]) {
			for (const path of ['/', '/admin', '/board/1']) {
				const res = await send('GET', path, { headers });
				expect({ path, status: res.status, location: res.headers.get('location') }).toEqual({ path, status: 303, location: '/login' });
			}
		}
	});

	it('leaves the public request routes and the documented API as they were: each answers for itself', async () => {
		// The handler's own refusal, in its own words, and not the gate's.
		expectJson(await send('GET', '/api/requests/targets', { headers: { accept: '*/*' } }), 401, {
			message: 'Open the request form to choose who to send a request to.'
		});
		expectJson(await send('GET', '/api/v1/boards', { headers: { accept: '*/*' } }), 401, {
			message: 'Missing or invalid Authorization header. Use: Bearer <api_key>'
		});
	});

	it('with no users at all, sends a browser to set-up, answers a script 401 and serves set-up', async () => {
		resetDb();

		expect((await send('GET', '/', { headers: { accept: 'text/html' } })).headers.get('location')).toBe('/setup');
		expect((await send('GET', '/api/boards', { headers: { 'sec-fetch-mode': 'navigate' } })).headers.get('location')).toBe('/setup');
		expectJson(await send('GET', '/api/boards', { headers: { accept: '*/*' } }), 401, NOT_SIGNED_IN);
		// The public request routes are sent to set-up, as they were.
		expect((await send('GET', '/api/requests/targets', { headers: { accept: '*/*' } })).headers.get('location')).toBe('/setup');
		expect((await send('GET', '/setup', { headers: { accept: 'text/html' } })).status).toBe(200);
	});
});

/**
 * The gate's redirects were thrown, and SvelteKit made each into an answer
 * after the gate had returned. The gate makes them itself now, and must make
 * the one SvelteKit would have: a 303 for a browser, and JSON that says where
 * to go for a page's script asking for the page's data or posting one of its
 * forms. Each is held here against SvelteKit's own function for it, so that
 * an upgrade that changes one fails here, by name.
 */
describe('a redirect the gate gives', () => {
	/** SvelteKit's own, from its source, as ./helpers/gate.ts loads its server. */
	const kit = async () => ({
		...((await import(/* @vite-ignore */ `${KIT}/runtime/server/data/index.js`)) as {
			redirect_json_response: (redirect: { status: number; location: string }) => Response;
		}),
		...((await import(/* @vite-ignore */ `${KIT}/runtime/server/page/actions.js`)) as {
			action_json_redirect: (redirect: { status: number; location: string }) => Response;
		}),
		...((await import(/* @vite-ignore */ `${KIT}/utils/http.js`)) as {
			negotiate: (accept: string, types: string[]) => string | undefined;
		})
	});

	/** What a caller is sent, to compare: the status, the type, the cache rule and the body. */
	const shown = async (res: Response) => ({
		status: res.status,
		type: res.headers.get('content-type'),
		cache: res.headers.get('cache-control'),
		location: res.headers.get('location'),
		text: await res.text()
	});

	it('is, for a page’s data, the JSON SvelteKit sends', async () => {
		const { redirect_json_response } = await kit();

		expect(await shown(await gate('GET', '/admin/__data.json', { headers: asUser }))).toEqual(
			await shown(redirect_json_response({ status: 303, location: '/' }))
		);
		expect(await shown(await gate('GET', '/board/1/__data.json'))).toEqual(
			await shown(redirect_json_response({ status: 303, location: '/login' }))
		);
	});

	it('is, for a form a page’s script posts, the JSON SvelteKit sends; and for a browser’s, a 303', async () => {
		const { action_json_redirect } = await kit();
		const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
		const byScript = { ...FORM, accept: 'application/json', 'x-sveltekit-action': 'true' };

		// Signed in, posting the login form; and posting set-up once there are users.
		expect(await shown(await gate('POST', '/login', { headers: { ...asUser, ...byScript }, body: 'identity=x&password=y' }))).toEqual(
			await shown(action_json_redirect({ status: 303, location: '/' }))
		);
		expect(await shown(await gate('POST', '/setup', { headers: byScript, body: 'username=x' }))).toEqual(
			await shown(action_json_redirect({ status: 303, location: '/' }))
		);
		// A browser's own post of a form is a 303 with nothing in it.
		const browser = await gate('POST', '/login', { headers: { ...asUser, ...FORM, accept: 'text/html' }, body: 'identity=x' });
		expect(await shown(browser)).toEqual({ status: 303, type: null, cache: null, location: '/', text: '' });
		expect(count('users')).toBe(3);
	});

	it('reads the Accept header as SvelteKit reads it', async () => {
		const { negotiate } = await kit();
		const TYPES = ['application/json', 'text/html'];
		const accepts = [
			'*/*',
			'',
			'text/html',
			'application/json',
			'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'application/json, text/html;q=0.1',
			'text/html;q=0.5, application/json;q=0.5',
			'image/avif,image/webp,*/*',
			'text/event-stream',
			'text/*',
			'application/*;q=0.2, text/html;q=0.1',
			'nonsense',
			'text/html;q=0'
		];

		for (const accept of accepts) {
			expect({ accept, ours: preferredType(accept, TYPES) }).toEqual({ accept, ours: negotiate(accept, TYPES) });
		}
	});
});

/**
 * A fault is written to the system log once, at ERROR, with what the
 * exception said, the route and the user, and the caller is told nothing of
 * it. Before `handleError`, SvelteKit wrote the stack to the console, and the
 * system log had only "→ 500".
 */
describe('a fault, written down by handleError', () => {
	let writes: FailingWrite | undefined;

	afterEach(() => {
		writes?.restore();
		writes = undefined;
	});

	/** The rows of the system log at ERROR that say `text`. */
	const errorsSaying = (text: string) =>
		(
			sqlite.prepare(`SELECT message, meta, user_id AS userId FROM system_logs WHERE level = 'ERROR' AND message LIKE ?`).all(`%${text}%`) as {
				message: string;
				meta: string;
				userId: number | null;
			}[]
		).map((row) => ({ ...row, meta: JSON.parse(row.meta) }));

	it('in a handler: the reason, the route and the user are written down, and the caller is answered 500 and nothing more', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		writes = failingWrite();
		// The first write is the key being marked as used; the second is the handler's.
		writes.failNth(2);

		const res = await send('POST', '/api/v1/boards', { headers: withKey, body: { name: 'Never made' } });

		expect(writes.fired).toBe(true);
		expectJson(res, 500, { message: 'Internal Error' });
		expect(res.text).not.toContain('failingWrite');
		expect(res.text).not.toContain('at ');

		const [line, ...more] = errorsSaying('failingWrite: write 2');
		expect(more).toEqual([]);
		expect(line.message).toMatch(/^POST \/api\/v1\/boards → 500: failingWrite: write 2 was made to fail/);
		expect(line.userId).toBe(user.id);
		expect(line.meta).toMatchObject({ method: 'POST', path: '/api/v1/boards', route: '/api/v1/boards', status: 500 });
		expect(line.meta.stack).toContain('InjectedWriteFailure');
		expect(count('boards')).toBe(0);
	});

	it('in the gate itself: written down once, not twice, and answered 500', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		writes = failingWrite();
		// The first write is the session's expiry, slid forward as it is looked up.
		writes.failNth(1);

		const res = await send('GET', '/api/boards', { headers: { ...asUser, accept: '*/*' } });

		expect(writes.fired).toBe(true);
		expectJson(res, 500, { message: 'Internal Error' });
		const lines = errorsSaying('failingWrite: write 1');
		expect(lines).toHaveLength(1);
		expect(lines[0].message).toMatch(/^GET \/api\/boards → unhandled error: failingWrite: write 1 was made to fail/);
		expect(lines[0].meta).toMatchObject({ method: 'GET', path: '/api/boards', route: '/api/boards' });
		expect(lines[0].meta.stack).toContain('InjectedWriteFailure');
	});

	it(
		'is not a path that is no route: SvelteKit’s 404 is answered with its own message, and nothing is written at ERROR',
		async () => {
			const before = (sqlite.prepare(`SELECT COUNT(*) AS n FROM system_logs WHERE level = 'ERROR'`).get() as { n: number }).n;

			const res = await send('GET', '/no-such-page', { headers: { ...asUser, accept: 'text/html' } });

			// SvelteKit's 404 page, with the message this hook gave it: in the page and in its data.
			expect(res.status).toBe(404);
			expect(res.text).toContain('<p>Not Found</p>');
			expect(res.text).toContain('error: {message:"Not Found"}');
			expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM system_logs WHERE level = 'ERROR'`).get() as { n: number }).n).toBe(before);
		},
		60_000
	);

	it('answers SvelteKit’s message, and cannot throw, whatever it is given', async () => {
		// An event whose every part throws when it is read.
		const broken = new Proxy({} as RequestEvent, {
			get() {
				throw new Error('not readable');
			}
		});

		for (const status of [500, 503, 404]) {
			const answer = await handleError({ error: new Error('x'), event: broken, status, message: 'Internal Error' });
			expect(answer).toEqual({ message: 'Internal Error' });
		}
		expect(await handleError({ error: undefined, event: broken, status: 404, message: 'Not Found' })).toEqual({ message: 'Not Found' });
	});
});

describe('what the gate writes to the system log', () => {
	/** Every line the gate logs while `requests` runs, at the level a deployment logs at. */
	async function logged(requests: () => Promise<unknown>): Promise<{ level: string; message: string; status: number }[]> {
		const lines: LogEntry[] = [];
		const level = process.env.LOG_LEVEL;
		const unsubscribe = subscribeToLogs((entry) => {
			if (entry.context === 'HTTP') lines.push(entry);
		});
		// The logger prints each line too.
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		process.env.LOG_LEVEL = 'INFO';
		try {
			await requests();
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
			unsubscribe();
		}
		return lines.map((line) => ({
			level: line.level,
			message: line.message.replace(/ \(\d+ms\)$/, ''),
			status: JSON.parse(line.meta ?? '{}').status
		}));
	}

	it('is the status that was sent, for each answer the gate makes or remakes', async () => {
		const lines = await logged(async () => {
			await gate('GET', '/api/v1/me', { headers: withKey });
			await gate('GET', '/api/v1/me');
			await gate('GET', '/api/v1/no-such-thing', { headers: withKey });
			await gate('PATCH', '/api/v1/me', { headers: withKey });
			await gate('POST', '/api/v1/openapi.json');
		});

		expect(lines).toEqual([
			{ level: 'INFO', message: 'GET /api/v1/me → 200', status: 200 },
			{ level: 'WARN', message: 'GET /api/v1/me → 401', status: 401 },
			{ level: 'WARN', message: 'GET /api/v1/no-such-thing → 404', status: 404 },
			{ level: 'WARN', message: 'PATCH /api/v1/me → 405', status: 405 },
			{ level: 'WARN', message: 'POST /api/v1/openapi.json → 405', status: 405 }
		]);
	});

	it('is a warning with 400 for a body that is not JSON, where it was an error with 500', async () => {
		const lines = await logged(async () => {
			await gate('POST', '/api/v1/boards', { headers: { ...withKey, ...JSON_BODY }, body: '{not json' });
			await gate('POST', '/api/cards', { headers: { ...asUser, ...JSON_BODY, accept: '*/*' }, body: 'null' });
		});

		expect(lines).toEqual([
			{ level: 'WARN', message: 'POST /api/v1/boards → 400', status: 400 },
			{ level: 'WARN', message: 'POST /api/cards → 400', status: 400 }
		]);
	});

	it('is the address as it was sent, where the rule was decided on the path it is routed to', async () => {
		const lines = await logged(async () => {
			await gate('GET', '/%61dmin', { headers: asUser });
			await gate('GET', '/%61pi/v1/me', { headers: asUser });
		});

		expect(lines).toEqual([
			{ level: 'INFO', message: 'GET /%61dmin → 303 redirect to /', status: 303 },
			{ level: 'WARN', message: 'GET /%61pi/v1/me → 401', status: 401 }
		]);
	});

	it('is the 401 a script is answered, where a browser or a page’s script is sent, and a refused body at a path that passes', async () => {
		const lines = await logged(async () => {
			await gate('GET', '/api/boards', { headers: { accept: '*/*' } });
			await gate('GET', '/api/boards', { headers: { accept: 'text/html' } });
			await gate('GET', '/board/1/__data.json');
			await gate('POST', '/favicon.ico', { headers: { ...JSON_BODY, 'content-length': String(10 * 1024 * 1024) }, body: '{}' });
			// What passes the gate unasked is not written down.
			await gate('GET', '/favicon.ico');
		});

		expect(lines).toEqual([
			{ level: 'WARN', message: 'GET /api/boards → 401', status: 401 },
			{ level: 'INFO', message: 'GET /api/boards → 303 redirect to /login', status: 303 },
			// A page's data is asked for at the page's address, and sent on with a 200 that says where.
			{ level: 'INFO', message: 'GET /board/1 → 200 redirect to /login', status: 200 },
			{ level: 'WARN', message: 'POST /favicon.ico → 413', status: 413 }
		]);
	});

	it('is an invite’s address with its token masked, in the line and in what is kept with it', async () => {
		const token = 'invite-token-that-sets-a-password-7c41e9';
		sqlite
			.prepare('INSERT INTO invite_tokens (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)')
			.run(token, user.id, '2099-01-01 00:00:00');
		const kept: LogEntry[] = [];
		const unsubscribe = subscribeToLogs((entry) => kept.push(entry));

		let lines: { level: string; message: string; status: number }[];
		try {
			lines = await logged(async () => {
				await gate('GET', `/invite/${token}`, { headers: { accept: 'text/html' } });
				await gate('GET', `/invite/${token}/__data.json`);
				// Encoded, and under /invite/ with no route: masked as well.
				await gate('GET', `/%69nvite/${token}`, { headers: { accept: 'text/html' } });
				await gate('GET', `/invite/${token}/more`, { headers: { accept: 'text/html' } });
			});
		} finally {
			unsubscribe();
		}

		expect(lines.map((line) => line.message)).toEqual([
			'GET /invite/[token] → 200',
			'GET /invite/[token] → 200',
			'GET /invite/[token] → 200',
			'GET /invite/[token] → 303 redirect to /login'
		]);
		// Nowhere in what the log kept: the line, its fields, the rows written.
		expect(kept.length).toBeGreaterThan(0);
		expect(JSON.stringify(kept)).not.toContain(token);
		expect(JSON.stringify(sqlite.prepare('SELECT message, meta FROM system_logs').all())).not.toContain(token);
	});

	it('is never a query, so a token sent as ?token= is not written down', async () => {
		const secret = 'request-link-token-0b8d2f';
		const lines = await logged(async () => {
			await gate('GET', `/api/requests/1?token=${secret}`, { headers: { accept: '*/*' } });
			await gate('GET', `/api/requests/1/messages?token=${secret}`, { headers: { accept: '*/*' } });
			await gate('GET', `/request/1/reply?token=${secret}`, { headers: { accept: 'text/html' } });
			await gate('GET', `/request/1/confirm?token=${secret}`, { headers: { accept: 'text/html' } });
		});

		expect(lines.map((line) => line.message.replace(/ → .*$/, ''))).toEqual([
			'GET /api/requests/1',
			'GET /api/requests/1/messages',
			'GET /request/1/reply',
			'GET /request/1/confirm'
		]);
		expect(JSON.stringify(sqlite.prepare('SELECT message, meta FROM system_logs').all())).not.toContain(secret);
	});

	it('is a remote call at the address it was sent to, and not at the path its header names', async () => {
		const lines = await logged(async () => {
			await gate('GET', '/_app/remote/abc123', { headers: { 'x-sveltekit-pathname': '/login' } });
		});

		expect(lines).toEqual([{ level: 'WARN', message: 'GET /_app/remote/abc123 → 404', status: 404 }]);
	});

	it('is nothing for an address that cannot be decoded: SvelteKit answers it before the gate is called', async () => {
		const lines = await logged(async () => {
			expect((await gate('GET', '/admin%E0%A4%A', { headers: asUser })).status).toBe(400);
			expect((await gate('GET', '/api/v1/%zz', { headers: withKey })).status).toBe(400);
		});

		expect(lines).toEqual([]);
	});
});

/**
 * The functions the gate is made of, given a request or an answer directly.
 * What is here cannot be shown through the server, or is quicker shown
 * without it.
 */
describe('guardBody, on one request', () => {
	const request = (body?: BodyInit) => {
		const made = new Request('http://localhost/api/x', { method: 'POST', headers: JSON_BODY, body });
		guardBody(made);
		return made;
	};

	const READERS = ['json', 'formData', 'arrayBuffer'] as const;

	/**
	 * A guarded request whose body fails with `fault` when it is read, as a
	 * body over the limit does. It says it is what `reader` reads: a form for
	 * `formData()`, which reads nothing that does not say so.
	 */
	const failingWith = (fault: unknown, reader: (typeof READERS)[number]) => {
		const made = new Request('http://localhost/api/x', {
			method: 'POST',
			headers: reader === 'formData' ? { 'content-type': 'multipart/form-data; boundary=x' } : JSON_BODY,
			body: new ReadableStream<Uint8Array>({ start: (controller) => controller.error(fault) }),
			duplex: 'half'
		} as RequestInit);
		guardBody(made);
		return made;
	};

	it.each(READERS)('throws SvelteKit’s 413 when %s() meets a body over the limit, whatever class the fault is', async (reader) => {
		// The adapter's own class, a bare object, and a SyntaxError that says
		// 413: the last would be a 400 if the status were looked at second.
		const faults = [
			Object.assign(new Error('request body size exceeded BODY_SIZE_LIMIT of 524288'), { status: 413, text: 'Payload Too Large' }),
			{ status: 413 },
			Object.assign(new SyntaxError('Unexpected end of JSON input'), { status: 413 })
		];

		for (const fault of faults) {
			const thrown = await failingWith(fault, reader)[reader]().catch((caught: unknown) => caught);

			expect(isHttpError(thrown)).toBe(true);
			expect(thrown).toMatchObject({ status: 413, body: { message: 'Payload Too Large' } });
		}
	});

	it.each(READERS)('throws on any other fault %s() meets as it was, and makes no 413 of it', async (reader) => {
		// A body cut off as it arrives is a TypeError('terminated'), from the
		// form reader as from the others: not the caller's mistake, and not a 400.
		const faults = [new TypeError('terminated'), Object.assign(new Error('gone'), { status: 500 }), { status: '413' }];

		for (const fault of faults) {
			const thrown = await failingWith(fault, reader)[reader]().catch((caught: unknown) => caught);

			expect(thrown).toBe(fault);
		}
	});

	it('passes on an object as it was sent', async () => {
		expect(await request('{"a":1}').json()).toEqual({ a: 1 });
		expect(await request('{}').json()).toEqual({});
	});

	it('throws SvelteKit’s 400 for an array, which no handler takes', async () => {
		await expect(request('[1,2]').json()).rejects.toMatchObject({ status: 400, body: NOT_AN_OBJECT });
		await expect(request('[]').json()).rejects.toMatchObject({ status: 400, body: NOT_AN_OBJECT });
		await expect(request('[{"a":1}]').json()).rejects.toMatchObject({ status: 400, body: NOT_AN_OBJECT });
	});

	describe('formData()', () => {
		const NOT_A_FORM = { message: 'The request body is not a form' };
		const sentAs = (type: string | null, body: BodyInit = 'a=1') => {
			const made = new Request('http://localhost/api/x', { method: 'POST', headers: type === null ? {} : { 'content-type': type }, body });
			guardBody(made);
			return made;
		};

		it('throws SvelteKit’s 400 for a body that does not say it is a form, and reads none of it', async () => {
			for (const type of ['application/json', 'text/plain', 'application/octet-stream', 'multipart/mixed; boundary=x', null]) {
				const made = sentAs(type, '{"a":1}');

				await expect(made.formData(), String(type)).rejects.toMatchObject({ status: 400, body: NOT_A_FORM });
				expect(made.bodyUsed, String(type)).toBe(false);
			}
		});

		it('throws the same 400 for a type that is a form up to its first `;` and not to undici, which reads the whole header', async () => {
			// undici reads it, and throws a TypeError that was passed on as a 500.
			for (const type of ['application/x-www-form-urlencoded;a=b, text/plain', 'multipart/form-data; boundary=x, text/plain']) {
				const thrown = await sentAs(type).formData().catch((caught: unknown) => caught);

				expect(isHttpError(thrown), type).toBe(true);
				expect(thrown, type).toMatchObject({ status: 400, body: NOT_A_FORM });
			}
		});

		it('reads a form sent as either kind, whatever the case of its type and with its parameters', async () => {
			const encoded = sentAs('Application/X-WWW-Form-Urlencoded; charset=UTF-8', 'a=1&b=2');
			expect([...(await encoded.formData()).entries()]).toEqual([
				['a', '1'],
				['b', '2']
			]);

			const form = new FormData();
			form.set('a', '1');
			const multipart = new Request('http://localhost/api/x', { method: 'POST', body: form });
			const type = multipart.headers.get('content-type') as string;
			const shouted = new Request('http://localhost/api/x', {
				method: 'POST',
				headers: { 'content-type': type.replace('multipart/form-data', 'MULTIPART/Form-Data') },
				body: await multipart.arrayBuffer()
			});
			guardBody(shouted);
			expect([...(await shouted.formData()).entries()]).toEqual([['a', '1']]);
		});

		it('passes on, as it was, the fault of a body that says it is a form and is not one', async () => {
			// Only a hand-made request sends one. It stays a fault, as a body cut off does.
			const thrown = await sentAs('multipart/form-data; boundary=x', 'not a form').formData().catch((caught: unknown) => caught);

			expect(thrown).toBeInstanceOf(TypeError);
			expect(isHttpError(thrown)).toBe(false);
		});
	});

	it('throws SvelteKit’s 400, which a handler does not catch and SvelteKit answers', async () => {
		await expect(request('{bad').json()).rejects.toMatchObject({ status: 400, body: NOT_JSON });
		await expect(request().json()).rejects.toMatchObject({ status: 400, body: NOT_JSON });
		await expect(request('null').json()).rejects.toMatchObject({ status: 400, body: NOT_AN_OBJECT });
		await expect(request('0').json()).rejects.toMatchObject({ status: 400, body: NOT_AN_OBJECT });
		await expect(request('false').json()).rejects.toMatchObject({ status: 400, body: NOT_AN_OBJECT });
		await expect(request('""').json()).rejects.toMatchObject({ status: 400, body: NOT_AN_OBJECT });
	});

	it('leaves a body that is read twice a fault, not a 400', async () => {
		const made = request('{"a":1}');
		await made.json();

		const second = await made.json().catch((thrown: unknown) => thrown);

		expect(second).toBeInstanceOf(TypeError);
		expect(second).not.toHaveProperty('status');
	});

	it('passes on what every other way of reading the body reads, as it was sent', async () => {
		expect(await request('{bad').text()).toBe('{bad');
		expect((await request('abc').arrayBuffer()).byteLength).toBe(3);
		// Not JSON, and not asked to be: only json() makes a 400 of it.
		expect(Buffer.from(await request('null').arrayBuffer()).toString()).toBe('null');

		const form = new FormData();
		form.set('a', '1');
		const multipart = new Request('http://localhost/api/x', { method: 'POST', body: form });
		guardBody(multipart);
		expect([...(await multipart.formData()).entries()]).toEqual([['a', '1']]);
	});

	it('is on the request it was given and not on a copy of it', async () => {
		const made = request('null');

		// No route reads its body from a clone. One that did would be unguarded.
		expect(await made.clone().json()).toBeNull();
	});
});

describe('failureAsJson, on one answer', () => {
	it('hands back a success, and a failure that is JSON already, as the same object', async () => {
		const pdf = new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/pdf' } });
		const created = new Response('ok', { status: 201 });
		const refused = Response.json({ message: 'No', cycle: [] }, { status: 409 });

		expect(await failureAsJson(pdf, 'GET')).toBe(pdf);
		expect(await failureAsJson(created, 'POST')).toBe(created);
		expect(await failureAsJson(refused, 'POST')).toBe(refused);
		expect(isJsonAnswer(refused)).toBe(true);
		expect(isJsonAnswer(pdf)).toBe(false);
		expect(isJsonAnswer(new Response(null, { status: 404 }))).toBe(false);
		expect(isJsonAnswer(new Response('{}', { status: 400, headers: { 'content-type': 'application/problem+json' } }))).toBe(true);
	});

	const remade = async (response: Response, method = 'GET') => {
		const res = await failureAsJson(response, method);
		return { status: res.status, type: res.headers.get('content-type'), body: await res.json(), headers: res.headers };
	};

	/** A text answer that says how long it is, as SvelteKit's own `text()` does. */
	const textOf = (said: string, status: number, headers: Record<string, string> = {}) =>
		new Response(said, { status, headers: { 'content-length': String(Buffer.byteLength(said)), ...headers } });

	it('keeps what a short plain text said, and the status', async () => {
		const res = await remade(textOf('Malformed thing', 400));

		expect(res).toMatchObject({ status: 400, type: 'application/json', body: { message: 'Malformed thing' } });
		// With no content type at all, as SvelteKit sends its own, and at the longest kept.
		const bare = new Response(new TextEncoder().encode('Malformed thing'), { status: 400, headers: { 'content-length': '15' } });
		expect(bare.headers.get('content-type')).toBeNull();
		expect((await remade(bare)).body).toEqual({ message: 'Malformed thing' });
		expect((await remade(textOf('x'.repeat(200), 400))).body).toEqual({ message: 'x'.repeat(200) });
	});

	it('says the standard phrase for the status in place of a page, a long text or nothing', async () => {
		const page = new Response('<!doctype html><title>Card not found</title>', {
			status: 404,
			headers: { 'content-type': 'text/html; charset=utf-8' }
		});

		expect((await remade(page)).body).toEqual({ message: 'Not Found' });
		expect((await remade(textOf('x'.repeat(201), 500))).body).toEqual({ message: 'Internal Server Error' });
		expect((await remade(new Response(null, { status: 403 }))).body).toEqual({ message: 'Forbidden' });
		// A status with no phrase of its own.
		expect((await remade(new Response(null, { status: 499 }))).body).toEqual({ message: 'Error' });
	});

	it('does not read a body that does not say it is short', async () => {
		// No length given: it could be any length, so it is not read to find out.
		const unsized = new Response('Short, and not said to be', { status: 502 });
		expect(unsized.headers.get('content-length')).toBeNull();
		// A length over the longest text kept, on a body that never ends.
		const endless = new Response(
			new ReadableStream<Uint8Array>({ pull: (controller) => controller.enqueue(new Uint8Array(1024)) }),
			{ status: 502, headers: { 'content-type': 'text/plain', 'content-length': '201' } }
		);
		// A length that is not a number of bytes.
		const unreadable = new Response('Short', { status: 502, headers: { 'content-length': 'five' } });

		for (const response of [unsized, endless, unreadable]) {
			const res = await failureAsJson(response, 'GET');

			expect(await res.json()).toEqual({ message: 'Bad Gateway' });
			expect(response.bodyUsed).toBe(false);
		}
	});

	it('copies Allow and no other header, so that the length is the new body’s', async () => {
		const old = new Response('PUT method not allowed', {
			status: 405,
			headers: { allow: 'GET, HEAD', 'content-length': '22', 'content-type': 'text/plain', etag: '"abc"', 'x-other': '1' }
		});

		const res = await jsonInPlaceOf(old, 'PUT');
		const text = await res.text();

		expect(text).toBe('{"message":"PUT method not allowed"}');
		expect(Object.fromEntries(res.headers)).toEqual({
			allow: 'GET, HEAD',
			'content-length': String(Buffer.byteLength(text)),
			'content-type': 'application/json'
		});
	});
});
