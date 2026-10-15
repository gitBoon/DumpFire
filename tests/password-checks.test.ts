/**
 * Passwords are hashed and checked on worker threads, never on the server's
 * own thread (card 2191).
 *
 * bcryptjs's `compareSync` at cost 12 takes about a fifth of a second, and
 * held the server's one thread for all of it: each sign-in held every other
 * request up, and a burst of them held the server for as long as the burst
 * lasted. `src/lib/server/passwords.ts` sends each hash and check to one of at
 * most two threads, in one line with two lanes: a caller with a session goes
 * first, everyone else waits in order, and the second lane is refused at once
 * ("busy") when about thirty seconds of checks already wait in it.
 *
 * The rest of the suite checks on its own thread, a turn later
 * (`PASSWORD_THREADS=0` in vitest.config.ts), so that a mock of bcryptjs sees
 * every call. This file starts real threads with `setPasswordThreads()`, a
 * fresh pool for each test, and puts the suite's back at the end.
 *
 * A test of time measures the longest gap between ticks of a 10 ms timer,
 * not how many ticks there were: Windows fires timers every 15.6 ms at best,
 * so a count would fail on a workstation and pass in the image.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { compareSync, getRounds, hashSync } from 'bcryptjs';
import { sqlite } from '$lib/server/db';
import type { SessionUser } from '$lib/server/auth';
import {
	BCRYPT_ROUNDS,
	CheckNotMade,
	DUMMY_HASH,
	checkPassword,
	endBusyPasswordThread,
	makePasswordHash,
	passwordChecks,
	setPasswordThreads
} from '$lib/server/passwords';
import { countWrongSignIn, resetAllRateLimits, signInWait } from '$lib/server/rate-limit';
import { makeApiKey, makeUser, resetDb } from './helpers/fixtures';
import { gate } from './helpers/gate';

/**
 * The CPUs this process may use. Tests 1 and 2 time two real threads against
 * the test's own, three threads in all: on a builder with fewer than three
 * CPUs (the image build runs the suite) they share them, a thread's check
 * holds the test's thread for part of it, and a bound that is right for every
 * real host could fail the build there. They are skipped below three CPUs,
 * and say so; the rest of the file runs everywhere.
 */
const CPUS = os.availableParallelism?.() ?? os.cpus().length;

/** The right password, hashed at the application's cost, and at bcrypt's lowest for checks that should be quick. */
const RIGHT = 'right';
let REAL: string;
const CHEAP = hashSync(RIGHT, 4);

let user: SessionUser;
let key: string;

beforeAll(async () => {
	REAL = hashSync(RIGHT, BCRYPT_ROUNDS);
	// The sign-in page's modules and the API's, loaded through Vite before any
	// test, so that no timed request waits for them: under the whole suite
	// the first request through the gate can take seconds.
	await signIn('', '', '198.51.100.250');
	await gate('GET', '/api/v1/me', { ip: '198.51.100.250' });
}, 60_000);

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	user = makeUser({ username: 'pat' });
	sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(REAL, user.id);
	key = makeApiKey(user, 'a script');
	// A new pool of two threads for each test, started at its first check.
	setPasswordThreads(2);
});

afterAll(() => {
	// The suite's way: on the test's own thread.
	setPasswordThreads(0);
});

/** Start the pool's threads and wait for them, with one quick check for each. */
async function warm(threads = 2): Promise<void> {
	await Promise.all(Array.from({ length: threads }, () => checkPassword(RIGHT, CHEAP, 'known')));
}

/** The longest gap, in milliseconds, between ticks of a 10 ms timer while `work` runs, to its end. */
async function longestGap(work: () => Promise<unknown>): Promise<number> {
	let last = performance.now();
	let longest = 0;
	const tick = () => {
		const now = performance.now();
		longest = Math.max(longest, now - last);
		last = now;
	};
	const timer = setInterval(tick, 10);
	try {
		await work();
	} finally {
		clearInterval(timer);
	}
	tick();
	return longest;
}

/** Run `fn` with the system log keeping WARN and above, and the console quiet. */
async function loggingWarnings<T>(fn: () => Promise<T>): Promise<T> {
	const level = process.env.LOG_LEVEL;
	process.env.LOG_LEVEL = 'WARN';
	const quiet = [vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
	try {
		return await fn();
	} finally {
		for (const spy of quiet) spy.mockRestore();
		if (level === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = level;
	}
}

/** The system log's lines whose message begins `start`. */
const linesStarting = (start: string) =>
	sqlite
		.prepare('SELECT level, context, message FROM system_logs WHERE message LIKE ? ORDER BY id')
		.all(`${start}%`) as { level: string; context: string; message: string }[];

/** A sign-in as a browser posts the form, answered as SvelteKit answers it. */
async function signIn(identity: string, password: string, ip: string, platform?: unknown) {
	const res = await gate('POST', '/login', {
		headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', accept: 'text/html' },
		body: `identity=${encodeURIComponent(identity)}&password=${encodeURIComponent(password)}`,
		ip,
		platform
	});
	return { status: res.status, text: await res.text() };
}

const BUSY =
	'Sign-in is very busy right now. Wait a minute and try again, or sign in from a browser you have used here before.';

describe('the server’s thread', () => {
	// Probe: two threads, ten checks, the longest gap 21 ms (the timer's own
	// granularity on Windows); on the server's thread, 214 ms. 60 ms leaves
	// room for a loaded machine and stays well under one check.
	it.skipIf(CPUS < 3)('stays free while six checks are made at once', async () => {
		await warm();
		const gap = await longestGap(() =>
			Promise.all(Array.from({ length: 6 }, (_, n) => checkPassword(n % 2 ? RIGHT : 'wrong', REAL, 'other')))
		);
		expect(gap).toBeLessThan(60);
	});

	// Four sign-ins at a cost-12 account are about two fifths of a second of
	// checks on two threads. The key's answer needs none of it: sent 20 ms
	// after them, it is answered within 100 ms of their start, half of one
	// check.
	//
	// It is sent from a timer. A request made in this process runs in
	// microtasks, so once sent it is never caught behind a check; what a held
	// thread delays is a timer, as it delays a request arriving on a socket.
	// Checked on the server's thread, as before card 2191, the timer fires
	// only once a sign-in's check has held the thread for a fifth of a second.
	it.skipIf(CPUS < 3)('answers an unrelated request while sign-ins are being checked, before any of them', async () => {
		await warm();

		const order: string[] = [];
		const started = performance.now();
		// Each answer is taken as it arrives, before its body is read, as the
		// key's is.
		const signIns = [1, 2, 3, 4].map((n) =>
			gate('POST', '/login', {
				headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', accept: 'text/html' },
				body: `identity=pat&password=wrong${n}`,
				ip: `203.0.113.${40 + n}`
			}).then((res) => {
				order.push('sign-in');
				return res;
			})
		);
		let keyAnsweredIn = Infinity;
		const me = new Promise((resolve) => setTimeout(resolve, 20))
			.then(() => gate('GET', '/api/v1/me', { headers: { authorization: `Bearer ${key}` }, ip: '203.0.113.50' }))
			.then((res) => {
				keyAnsweredIn = performance.now() - started;
				order.push('key');
				return res;
			});

		const [meRes, ...answers] = await Promise.all([me, ...signIns]);
		expect(meRes.status).toBe(200);
		expect(answers.map((res) => res.status)).toEqual([400, 400, 400, 400]);
		expect(order[0]).toBe('key');
		expect(keyAnsweredIn).toBeLessThan(100);
		expect(passwordChecks().checked).toBe(6);
	});
});

describe('a check on a thread', () => {
	it('answers right and wrong, and makes a cost-12 hash the server’s thread can check', async () => {
		expect(await checkPassword(RIGHT, REAL, 'other')).toEqual({ matches: true });
		expect(await checkPassword('wrong', REAL, 'known')).toEqual({ matches: false });

		const made = await makePasswordHash('a new password', 'known');
		expect(made).toMatch(/^\$2b\$12\$/);
		expect(getRounds(made)).toBe(BCRYPT_ROUNDS);
		expect(compareSync('a new password', made)).toBe(true);

		expect(passwordChecks()).toMatchObject({ threads: 2, onServerThread: false, checked: 3 });
	});

	// Card 2192: a sign-in at a name that is no account is checked against it,
	// so it must take the time a stored hash takes.
	it('checks against DUMMY_HASH, a hash at BCRYPT_ROUNDS, and answers false without throwing', async () => {
		expect(DUMMY_HASH).toMatch(/^\$2b\$/);
		expect(getRounds(DUMMY_HASH)).toBe(BCRYPT_ROUNDS);
		expect(await checkPassword('anything at all', DUMMY_HASH, 'other')).toEqual({ matches: false });
		expect(await checkPassword('', DUMMY_HASH, 'other')).toEqual({ matches: false });
	});

	it('takes the first lane first: a caller with a session goes ahead of sign-ins already waiting', async () => {
		setPasswordThreads(1);
		await warm(1);

		const order: string[] = [];
		const track = (name: string, check: Promise<unknown>) => check.then(() => order.push(name));
		// The one thread is busy with this one while the rest are queued.
		const busy = track('busy', checkPassword(RIGHT, REAL, 'other'));
		const others = [1, 2, 3].map((n) => track(`sign-in ${n}`, checkPassword(RIGHT, CHEAP, 'other')));
		const known = track('session', checkPassword(RIGHT, CHEAP, 'known'));
		expect(passwordChecks().waiting).toEqual({ known: 1, other: 3 });

		await Promise.all([busy, ...others, known]);
		expect(order).toEqual(['busy', 'session', 'sign-in 1', 'sign-in 2', 'sign-in 3']);
	});

	// The review's L1. Sessions' checks sent one as each before is answered
	// kept the first lane from ever being empty, and a sign-in behind them was
	// never checked: a signed-in user with three email changes in flight held
	// every sign-in, invite and set-up until the second lane was full. No more
	// than three of the first lane are taken in a row while one of the second
	// waits.
	it('takes a sign-in after at most three of a session’s checks in a row, however many keep coming', async () => {
		setPasswordThreads(1);
		await warm(1);

		const order: string[] = [];
		let sent = 0;
		/** A session's check that sends the next when it is answered, twenty in all. */
		const stream = (): Promise<unknown> => {
			const n = ++sent;
			return checkPassword(RIGHT, CHEAP, 'known').then(() => {
				order.push(`session ${n}`);
				return sent < 20 ? stream() : undefined;
			});
		};
		// The one thread is busy with this one while the rest are queued.
		const busy = checkPassword(RIGHT, REAL, 'known').then(() => order.push('busy'));
		const signIn = checkPassword(RIGHT, CHEAP, 'other').then(() => order.push('sign-in'));
		const streams = [stream(), stream(), stream()];

		await Promise.all([busy, signIn, ...streams]);
		expect(order.slice(0, 5)).toEqual(['busy', 'session 1', 'session 2', 'session 3', 'sign-in']);
		// And the sessions' checks went on after it.
		expect(order.filter((name) => name.startsWith('session'))).toHaveLength(20);
	});

	it('sends a check once more when its thread stops, and fails it when the replacement stops too', async () => {
		setPasswordThreads(1);
		await warm(1);
		expect(passwordChecks()).toMatchObject({ started: 1, retried: 0 });

		// Ended during the check: the replacement answers it.
		const answered = checkPassword(RIGHT, REAL, 'other');
		expect(passwordChecks().running).toBe(1);
		expect(endBusyPasswordThread()).toBe(true);
		expect(await answered).toEqual({ matches: true });
		expect(passwordChecks()).toMatchObject({ started: 2, retried: 1 });

		// Ended, and its replacement ended during the same check: a rejection,
		// which the route answers 500.
		const doomed = checkPassword(RIGHT, REAL, 'other');
		const failed = expect(doomed).rejects.toThrow('its worker thread stopped twice');
		expect(endBusyPasswordThread()).toBe(true);
		await vi.waitFor(
			() => expect(passwordChecks()).toMatchObject({ retried: 2, running: 1 }),
			{ timeout: 5000, interval: 2 }
		);
		expect(endBusyPasswordThread()).toBe(true);
		await failed;

		// And the next check is made, on a thread started for it.
		expect(await checkPassword(RIGHT, CHEAP, 'other')).toEqual({ matches: true });
		expect(passwordChecks()).toMatchObject({ started: 4, onServerThread: false });
	});

	// A stored value 60 characters long that is not a bcrypt hash makes
	// compareSync throw (the plan's check B). Only that one check fails; the
	// thread was not ended by it, and two threads were not spent on it.
	it('fails a check that throws, and goes on with the same thread', async () => {
		setPasswordThreads(1);
		await warm(1);

		await expect(checkPassword(RIGHT, 'x'.repeat(60), 'other')).rejects.toThrow(/^The password check failed: (?!its worker)/);
		expect(await checkPassword(RIGHT, CHEAP, 'other')).toEqual({ matches: true });
		expect(passwordChecks()).toMatchObject({ started: 1, retried: 0 });
	});

	it('checks on the server’s thread, and says so once, when no thread can start', async () => {
		// A thread that cannot load bcryptjs never says it is ready.
		setPasswordThreads(1, { bcryptPath: join(os.tmpdir(), 'dumpfire-no-such-folder', 'bcryptjs.js') });

		await loggingWarnings(async () => {
			expect(await checkPassword(RIGHT, CHEAP, 'other')).toEqual({ matches: true });
			expect(await checkPassword('wrong', CHEAP, 'known')).toEqual({ matches: false });
			expect(await makePasswordHash('another', 'other')).toMatch(/^\$2b\$12\$/);
		});

		expect(passwordChecks()).toMatchObject({ onServerThread: true, started: 1, checked: 3 });
		const lines = linesStarting('Password checks cannot run on worker threads');
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ level: 'ERROR', context: 'AUTH' });
	});
});

describe('the line', () => {
	it('says when more than 20 password checks wait, once, and again five minutes later if they still do', async () => {
		setPasswordThreads(1);
		await warm(1);

		await loggingWarnings(async () => {
			const checks = [checkPassword(RIGHT, REAL, 'known')];
			for (let n = 1; n <= 20; n++) checks.push(checkPassword(RIGHT, CHEAP, 'other'));
			expect(linesStarting('Password checks are queuing')).toEqual([]);

			checks.push(checkPassword(RIGHT, CHEAP, 'other'));
			expect(linesStarting('Password checks are queuing')).toEqual([
				{ level: 'WARN', context: 'AUTH', message: 'Password checks are queuing: 21 password checks waiting (sign-ins, invites, set-up), the oldest for 0 s' }
			]);

			// Thirty more within five minutes: still the one line.
			for (let n = 1; n <= 30; n++) checks.push(checkPassword(RIGHT, CHEAP, 'other'));
			expect(linesStarting('Password checks are queuing')).toHaveLength(1);

			// Five minutes on, with the line still long, it is said again.
			vi.useFakeTimers({ toFake: ['Date'] });
			try {
				vi.setSystemTime(Date.now() + 5 * 60 * 1000);
				checks.push(checkPassword(RIGHT, CHEAP, 'other'));
			} finally {
				vi.useRealTimers();
			}
			expect(linesStarting('Password checks are queuing')).toHaveLength(2);

			await Promise.all(checks);
		});
	});

	it('answers a sign-in busy at once when the second lane is full, counting nothing at the account, and still takes a session’s check', async () => {
		setPasswordThreads(1, { secondLaneBound: 3 });
		await warm(1);
		// Four wrong at the account: a fifth counted would begin its waits.
		for (let n = 1; n <= 4; n++) countWrongSignIn(`user:${user.id}`);

		await loggingWarnings(async () => {
			// The thread is held by a session's checks, about three fifths of a
			// second of them; three sign-ins fill the second lane.
			const held = [1, 2, 3].map(() => checkPassword(RIGHT, REAL, 'known'));
			const waiting = [1, 2, 3].map(() => checkPassword(RIGHT, CHEAP, 'other'));

			const refused = await signIn('pat', RIGHT, '203.0.113.60');
			expect(refused.status).toBe(503);
			expect(refused.text).toContain(BUSY);
			// Answered while the line was still full, not after it.
			expect(passwordChecks().waiting.other).toBe(3);
			expect(signInWait(`user:${user.id}`)).toBe(0);

			// A session's check queued after it is still taken, and answered.
			const after = checkPassword(RIGHT, CHEAP, 'known');
			expect(await Promise.all([...held, ...waiting, after])).toHaveLength(7);
			expect(await after).toEqual({ matches: true });
		});

		expect(linesStarting('Password checks are full')).toEqual([
			{
				level: 'WARN',
				context: 'AUTH',
				message:
					'Password checks are full: 3 password checks waiting (sign-ins, invites, set-up); ' +
					"sign-ins from browsers not remembered, invites and set-up are being answered 'busy'"
			}
		]);
	});

	it('does not check for a caller who has gone, and answers busy', async () => {
		await warm();
		for (let n = 1; n <= 4; n++) countWrongSignIn(`user:${user.id}`);
		const checked = passwordChecks().checked;

		// What the node adapter hands a request whose connection has closed.
		const gone = { req: { socket: { destroyed: true } } };
		const res = await signIn('pat', RIGHT, '203.0.113.61', gone);
		expect(res.status).toBe(503);
		expect(res.text).toContain(BUSY);
		expect(passwordChecks().checked).toBe(checked);
		expect(signInWait(`user:${user.id}`)).toBe(0);

		// Directly: refused with the reason, and never made.
		await expect(checkPassword(RIGHT, CHEAP, 'other', { gone: () => true })).rejects.toEqual(new CheckNotMade('gone'));
		expect(passwordChecks().checked).toBe(checked);

		// A caller still there is checked.
		expect((await signIn('pat', RIGHT, '203.0.113.61', { req: { socket: { destroyed: false } } })).status).toBe(303);
	});

	// Card 2177 keeps the name cut to 320 characters for the answer (its R6);
	// held here as well, since the line holds the request while it waits.
	it('answers a sign-in with a name of 500,000 characters with 320 of them', async () => {
		const res = await signIn('x'.repeat(500_000), 'wrong', '203.0.113.62');
		expect(res.status).toBe(400);
		expect(res.text).toContain('x'.repeat(320));
		expect(res.text).not.toContain('x'.repeat(321));
	});
});

describe('what is queued', () => {
	it('is text: anything else is refused before it is queued, and a long password is checked by its first 256 characters', async () => {
		await warm();
		const before = passwordChecks();

		await expect(checkPassword(42 as unknown as string, CHEAP, 'other')).rejects.toBeInstanceOf(TypeError);
		await expect(checkPassword(RIGHT, null as unknown as string, 'other')).rejects.toBeInstanceOf(TypeError);
		await expect(makePasswordHash({} as unknown as string, 'known')).rejects.toBeInstanceOf(TypeError);
		expect(passwordChecks()).toMatchObject({ checked: before.checked, waiting: { known: 0, other: 0 } });

		const long = 'p'.repeat(600);
		expect(await checkPassword(long, hashSync(long.slice(0, 256), 4), 'other')).toEqual({ matches: true });
	});
});

describe('the source', () => {
	/** Every file under `src`, by its path from the repository root with forward slashes. */
	const sources = (readdirSync(join(process.cwd(), 'src'), { recursive: true }) as string[])
		.map((file) => join('src', file))
		.filter((file) => /\.(ts|js|svelte)$/.test(file))
		.map((file) => file.split(sep).join('/'));

	it('imports bcryptjs in passwords.ts alone', () => {
		const importers = sources.filter((file) => /['"]bcryptjs['"]/.test(readFileSync(join(process.cwd(), file), 'utf8')));
		expect(importers).toEqual(['src/lib/server/passwords.ts']);
	});

	// A check resolves to `{ matches }`, so `.matches` of a promise does not
	// compile; this holds what the type cannot: a promise kept in a variable,
	// or a hash not awaited where its value is not used.
	it('awaits every check and every hash where it is asked for', () => {
		const NAMES = new Set(['checkPassword', 'checkCurrentPassword', 'makePasswordHash']);
		const calls: string[] = [];
		const unawaited: string[] = [];
		for (const file of sources.filter((f) => f.endsWith('.ts'))) {
			const text = readFileSync(join(process.cwd(), file), 'utf8');
			if (![...NAMES].some((name) => text.includes(name))) continue;
			const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
			const visit = (node: ts.Node): void => {
				if (ts.isCallExpression(node)) {
					const callee = node.expression;
					const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
					if (NAMES.has(name)) {
						const where = `${relative('', file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
						calls.push(where);
						let parent = node.parent;
						while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
						if (!ts.isAwaitExpression(parent)) unawaited.push(`${where} ${name}`);
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
		}

		expect(unawaited).toEqual([]);
		// Sign-in; the current password and its re-check; the three routes
		// that ask for it; and the six hashes (two in the new-user route).
		expect(calls.length).toBeGreaterThanOrEqual(12);
	});
});
