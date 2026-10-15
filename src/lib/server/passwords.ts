/**
 * passwords.ts — every bcrypt hash and check, kept off the server's thread
 * (card 2191).
 *
 * A bcrypt check at cost 12 takes about a fifth of a second, and bcryptjs
 * does it in JavaScript: `compareSync` held the server's one thread for all of
 * it, so each sign-in held every other request up, and a burst of them held
 * the server for as long as the burst lasted. bcryptjs's own async `compare`
 * gives the thread back only now and then (measured: five at once held it for
 * half a second at a stretch). So each hash and check is sent to a worker
 * thread, at most two of them, and the server's thread only waits for the
 * answer.
 *
 * A thread is started from the code in `THREAD_CODE`, a string, because a
 * worker file of its own would not be carried into the build: Vite follows
 * `new URL('./x.js', import.meta.url)` only for the browser. It loads bcryptjs
 * by the absolute path this module resolves, which in the built server is
 * `/app/node_modules/bcryptjs`, kept outside the bundle as every dependency is.
 *
 * Checks wait in one line in memory, in two lanes, in order of arrival:
 *
 *   - `known`: a caller the server already knows: a request made with a
 *     session (the current-password routes, an administrator's reset, a new
 *     user), or a browser remembered for the account at sign-in. A free
 *     thread takes these first, but never more than three in a row while a
 *     check of the second lane waits (the review's L1), so that a stream of
 *     them cannot keep the second lane from ever being served. A session's
 *     current password and a remembered browser's sign-in are also held to
 *     five in flight for each account (`known:user:<id>`, in auth.ts and the
 *     sign-in route), so one account cannot fill this lane.
 *   - `other`: everyone else: a sign-in, an invite link, set-up. Taken when
 *     the first lane is empty or has had its three, and refused at once
 *     (`CheckNotMade`, `full`) when 150 for each thread are already waiting,
 *     about thirty seconds of checks: the caller is told the server is busy
 *     rather than kept until a proxy gives up on them.
 *
 * A check whose caller has gone (`gone()`, asked when a thread is free for
 * it) is not made, and rejects with `CheckNotMade`, `gone`. A thread that
 * stops during a check is replaced and the check sent once more; if no
 * thread can be started at all, every check runs on the server's thread, as
 * before, for the life of the process. This is the only module that imports
 * bcryptjs (tests/password-checks.test.ts holds it).
 *
 * `PASSWORD_THREADS`, read once at the first check: unset, two threads, or one
 * on a machine with one or two CPUs; a whole number from 0 to 8 as it is; 0
 * checks on the server's thread a turn later (`setImmediate`), which is what
 * the tests run on (vitest.config.ts), so that a test's mock of bcryptjs sees
 * every call.
 */
import { compareSync, hashSync } from 'bcryptjs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import { Worker } from 'node:worker_threads';
import { createLogger } from './logger';

const log = createLogger('AUTH');

/** The cost every password is hashed at. Every stored hash is cost 12. */
export const BCRYPT_ROUNDS = 12;

/**
 * What a sign-in at a name that is no account checks its password against
 * (card 2192), so that it costs the one check a wrong password at an account
 * costs, and the time it takes does not tell which names are accounts. The
 * cost-12 hash of 32 random bytes, made once when the card was built
 * (`hashSync(randomBytes(32).toString('hex'), 12)`) and nothing else kept of
 * them: nothing is meant to match it. It must be at `BCRYPT_ROUNDS`, as every
 * stored hash is, or it would take another time (tests/password-checks.test.ts
 * holds it).
 */
export const DUMMY_HASH = '$2b$12$ZJoqPz9NkEAIQhAx09PXiOnu2GMT2hwKv5wcOhyNK5p9Kdx9GJ1He';

/**
 * The characters of a password that are kept. bcrypt reads only the first 72
 * bytes, which the first 72 characters always hold, so no hash and no answer
 * changes, and a long form never sits in the line.
 */
const KEPT_CHARACTERS = 256;

/** Checks of the second lane that may wait, for each thread: about thirty seconds of them. */
const WAITING_PER_THREAD = 150;

/** The second lane's length past which the line says it is long. */
const LONG_LINE = 20;

/** How often, at most, each of the line's WARN lines is written while it holds. */
const WARN_EVERY_MS = 5 * 60 * 1000;

/** The most threads `PASSWORD_THREADS` may ask for. */
const MOST_THREADS = 8;

/**
 * The most checks of the first lane taken one after another while one of the
 * second waits (the review's L1): the second lane is always served.
 */
const KNOWN_IN_A_ROW = 3;

/** Which lane a check waits in: see the header. */
export type Lane = 'known' | 'other';

/** What a check or a hash may be told, besides its password. */
export type CheckOptions = {
	/**
	 * Whether the caller has gone. Asked when a thread is free for the check:
	 * true, and it is not made. A route passes `callerHasGone(event.platform)`.
	 */
	gone?: () => boolean;
};

/**
 * A check or a hash that was not made: the second lane was full (`full`), or
 * the caller had gone by the time a thread was free (`gone`). The route
 * answers 503: the server is busy. Nothing was checked, so nothing is counted.
 */
export class CheckNotMade extends Error {
	constructor(readonly reason: 'full' | 'gone') {
		super(
			reason === 'full'
				? 'The password was not checked: too many checks are already waiting'
				: 'The password was not checked: the caller had gone'
		);
		this.name = 'CheckNotMade';
	}
}

/** What an invite's form and set-up answer when their hash is not made. */
export const PASSWORDS_BUSY = 'The server is very busy checking passwords right now. Wait a minute and try again.';

/**
 * Whether the caller of a request has gone, for `CheckOptions.gone`. The node
 * adapter hands each request its `req`, whose socket is destroyed once the
 * connection has closed (the browser gave up, or the proxy's own timeout
 * passed). Under `vite dev` and in the tests there is no `req`, and nobody is
 * ever taken for gone.
 */
export function callerHasGone(platform: App.Platform | undefined): () => boolean {
	return () => platform?.req?.socket?.destroyed === true;
}

// ─── The thread ─────────────────────────────────────────────────────────────

/**
 * What each thread runs. It loads bcryptjs from `workerData.bcryptPath`, says
 * it is ready, and answers each message with the hash or the check. A check
 * that throws (a stored value that is 60 characters long and not a bcrypt
 * hash does) is answered as an error and the thread goes on: only that one
 * check fails.
 */
const THREAD_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const bcrypt = require(workerData.bcryptPath);
parentPort.on('message', (job) => {
	try {
		const result = job.op === 'hash' ? bcrypt.hashSync(job.password, job.rounds) : bcrypt.compareSync(job.password, job.hash);
		parentPort.postMessage({ id: job.id, result });
	} catch (err) {
		parentPort.postMessage({ id: job.id, error: String((err && err.message) || err) });
	}
});
parentPort.postMessage({ ready: true });
`;

/** One hash or check, waiting or being made. */
type Job = {
	id: number;
	op: 'hash' | 'compare';
	password: string;
	hash?: string;
	lane: Lane;
	gone?: () => boolean;
	queuedAt: number;
	/** How many times a thread has stopped while making it. */
	stops: number;
	resolve: (result: string | boolean) => void;
	reject: (reason: unknown) => void;
};

/** A thread, or the server's own thread (`worker` null) when checks run there. */
type Slot = {
	worker: Worker | null;
	/** Whether the thread has said it is ready. The server's thread always is. */
	ready: boolean;
	job: Job | null;
	/** Why the thread stopped, if it said. */
	failure?: string;
};

type Pool = {
	/** The threads asked for; 0 is the server's thread. */
	threads: number;
	/** Whether checks run on the server's thread: asked for, or the fallback. */
	onServerThread: boolean;
	slots: Slot[];
	lanes: Record<Lane, Job[]>;
	/** How many checks of the second lane may wait. */
	bound: number;
	/** The bcryptjs a thread loads. */
	bcryptPath?: string;
	nextId: number;
	/** Hashes and checks made, whatever their answer. */
	checked: number;
	/** Checks sent again after their thread stopped. */
	retried: number;
	/** Threads started. */
	started: number;
	announced: boolean;
	lastLongWarn: number | null;
	lastFullWarn: number | null;
	closed: boolean;
	/** Jobs of the first lane taken one after another while one of the second waited. */
	knownInARow: number;
};

/** What a test may set besides the number of threads. */
export type PasswordThreadOptions = {
	/** The bcryptjs a thread loads, in place of the one installed. */
	bcryptPath?: string;
	/** How many checks of the second lane may wait, in place of 150 for each thread. */
	secondLaneBound?: number;
};

/**
 * The pool is kept on `globalThis`, so that a module evaluated again (an edit
 * under `vite dev`) ends the threads of the one before it rather than leaving
 * them running beside its own.
 */
const POOL = Symbol.for('dumpfire.passwordChecks');
const shared = globalThis as unknown as Record<symbol, Pool | undefined>;
if (shared[POOL]) closePool(shared[POOL]);
shared[POOL] = undefined;

/** The threads `PASSWORD_THREADS` asks for, or the default. Said once if it is not a number we take. */
function threadsAsked(): number {
	const parallelism = os.availableParallelism?.() ?? os.cpus().length;
	// One fewer than the CPUs, so that one is left for the server's own thread,
	// and never more than two: the threads keep the server's thread free, they
	// are not there to check faster for whoever is guessing.
	const fallback = Math.min(2, Math.max(1, parallelism - 1));
	const raw = process.env.PASSWORD_THREADS;
	if (raw === undefined || raw.trim() === '') return fallback;
	if (/^\d+$/.test(raw.trim()) && Number(raw.trim()) <= MOST_THREADS) return Number(raw.trim());
	log.warn(
		`PASSWORD_THREADS="${raw.slice(0, 20)}" is not a whole number from 0 to ${MOST_THREADS}: ` +
			`password checks run on ${fallback} worker thread(s)`
	);
	return fallback;
}

function makePool(threads: number, options: PasswordThreadOptions = {}): Pool {
	const onServerThread = threads === 0;
	return {
		threads,
		onServerThread,
		slots: onServerThread
			? [{ worker: null, ready: true, job: null }]
			: Array.from({ length: threads }, () => ({ worker: null, ready: false, job: null })),
		lanes: { known: [], other: [] },
		bound: options.secondLaneBound ?? WAITING_PER_THREAD * Math.max(1, threads),
		bcryptPath: options.bcryptPath,
		nextId: 1,
		checked: 0,
		retried: 0,
		started: 0,
		announced: false,
		lastLongWarn: null,
		lastFullWarn: null,
		closed: false,
		knownInARow: 0
	};
}

/** The pool, made at the first check. */
function pool(): Pool {
	let current = shared[POOL];
	if (!current) {
		current = makePool(threadsAsked());
		shared[POOL] = current;
	}
	if (!current.announced) {
		current.announced = true;
		log.info(
			current.onServerThread
				? "Password checks run on the server's thread (PASSWORD_THREADS=0)"
				: `Password checks run on ${current.threads} worker thread(s)`
		);
	}
	return current;
}

/** End a pool's threads, and reject whatever waits in it. Used when a test or a reload replaces it. */
function closePool(old: Pool): void {
	old.closed = true;
	for (const slot of old.slots) {
		const worker = slot.worker;
		slot.worker = null;
		if (slot.job) slot.job.reject(new Error('The password checks were restarted'));
		slot.job = null;
		void worker?.terminate();
	}
	for (const job of [...old.lanes.known, ...old.lanes.other]) job.reject(new Error('The password checks were restarted'));
	old.lanes.known.length = 0;
	old.lanes.other.length = 0;
}

/** Start the thread of a slot that has none. It is given checks once it says it is ready. */
function startThread(p: Pool, slot: Slot): void {
	let bcryptPath: string;
	try {
		bcryptPath = p.bcryptPath ?? createRequire(import.meta.url).resolve('bcryptjs');
	} catch (err) {
		fallBack(p, `bcryptjs could not be found (${(err as Error).message})`);
		return;
	}

	let worker: Worker;
	try {
		worker = new Worker(THREAD_CODE, { eval: true, workerData: { bcryptPath } });
	} catch (err) {
		fallBack(p, `a worker thread could not be started (${(err as Error).message})`);
		return;
	}
	// Never what keeps a process running.
	worker.unref();
	slot.worker = worker;
	slot.ready = false;
	slot.failure = undefined;
	p.started++;

	worker.on('message', (message: { ready?: true; id?: number; result?: string | boolean; error?: string }) => {
		if (slot.worker !== worker) return;
		if (message.ready) {
			slot.ready = true;
			dispatch(p);
			return;
		}
		finish(p, slot, message);
	});
	worker.on('error', (err) => {
		if (slot.worker === worker) slot.failure = err instanceof Error ? err.message : String(err);
	});
	worker.on('exit', () => {
		if (slot.worker !== worker || p.closed) return;
		slot.worker = null;
		if (!slot.ready) {
			// It never said it was ready: bcryptjs could not be loaded in it, and
			// no other thread would do better.
			fallBack(p, slot.failure ?? 'a worker thread stopped before it was ready');
			return;
		}
		slot.ready = false;
		const job = slot.job;
		slot.job = null;
		if (job) {
			job.stops++;
			if (job.stops >= 2) {
				job.reject(new Error(`The password check failed: its worker thread stopped twice (${slot.failure ?? 'no reason given'})`));
			} else {
				// Sent once more, to the thread that replaces this one, ahead of
				// everything that arrived after it.
				p.retried++;
				p.lanes[job.lane].unshift(job);
			}
		}
		dispatch(p);
	});
}

/**
 * No thread can be started: say so once, and make every check on the
 * server's thread from now on, as before card 2191. Nobody is kept from
 * signing in by it.
 */
function fallBack(p: Pool, reason: string): void {
	if (p.onServerThread) return;
	log.error(
		`Password checks cannot run on worker threads (${reason}). Every password is checked on the server's ` +
			'thread until it restarts, which holds every other request for about a fifth of a second each time.'
	);
	p.onServerThread = true;
	for (const slot of p.slots) {
		const worker = slot.worker;
		slot.worker = null;
		if (slot.job) p.lanes[slot.job.lane].unshift(slot.job);
		slot.job = null;
		void worker?.terminate();
	}
	p.slots = [{ worker: null, ready: true, job: null }];
	p.bound = Math.min(p.bound, WAITING_PER_THREAD);
	dispatch(p);
}

/**
 * The next job to make: the oldest of the first lane, else of the second; but
 * after `KNOWN_IN_A_ROW` of the first lane taken while one of the second
 * waited, the oldest of the second. A caller who has gone is not checked for:
 * nobody would be told.
 */
function nextJob(p: Pool): Job | undefined {
	for (;;) {
		const otherWaits = p.lanes.other.length > 0;
		const takeKnown = p.lanes.known.length > 0 && (!otherWaits || p.knownInARow < KNOWN_IN_A_ROW);
		const job = takeKnown ? p.lanes.known.shift() : p.lanes.other.shift();
		if (!job) return undefined;
		if (job.gone?.()) {
			job.reject(new CheckNotMade('gone'));
			continue;
		}
		p.knownInARow = takeKnown && otherWaits ? p.knownInARow + 1 : 0;
		return job;
	}
}

/** Give each free thread the next check, and start a thread where one is needed. */
function dispatch(p: Pool): void {
	if (p.closed) return;
	for (const slot of p.slots) {
		if (slot.job) continue;
		if (p.lanes.known.length === 0 && p.lanes.other.length === 0) return;
		if (!p.onServerThread && !slot.worker) {
			startThread(p, slot);
			// A fallback replaces the slots; begin again over the new ones.
			if (p.onServerThread) return dispatch(p);
			continue;
		}
		if (!slot.ready) continue;

		const job = nextJob(p);
		if (!job) return;
		run(p, slot, job);
	}
}

/** Make `job` on `slot`: post it to the thread, or on the server's thread a turn later. */
function run(p: Pool, slot: Slot, job: Job): void {
	slot.job = job;
	if (slot.worker) {
		slot.worker.postMessage({ id: job.id, op: job.op, password: job.password, hash: job.hash, rounds: BCRYPT_ROUNDS });
		return;
	}
	// A turn later, as a thread's answer would be, so a check is never
	// answered in the turn that asked for it.
	setImmediate(() => {
		if (slot.job !== job) return;
		try {
			const result = job.op === 'hash' ? hashSync(job.password, BCRYPT_ROUNDS) : compareSync(job.password, job.hash!);
			finish(p, slot, { id: job.id, result });
		} catch (err) {
			finish(p, slot, { id: job.id, error: (err as Error).message ?? String(err) });
		}
	});
}

/** A thread's answer: settle its job, and give the thread the next. */
function finish(p: Pool, slot: Slot, message: { id?: number; result?: string | boolean; error?: string }): void {
	const job = slot.job;
	if (!job || job.id !== message.id) return;
	slot.job = null;
	p.checked++;
	if (message.error !== undefined) job.reject(new Error(`The password check failed: ${message.error}`));
	else job.resolve(message.result!);
	dispatch(p);
}

/** Put a job in its lane, or refuse it when the second lane is full. */
function enqueue(op: 'hash' | 'compare', password: unknown, hash: unknown, lane: Lane, options: CheckOptions): Promise<string | boolean> {
	// Text, or refused before it is queued: anything else would reach bcrypt
	// and throw there, in a thread.
	if (typeof password !== 'string') throw new TypeError('A password must be text');
	if (op === 'compare' && typeof hash !== 'string') throw new TypeError('A password hash must be text');

	const p = pool();
	const now = Date.now();

	if (lane === 'other' && p.lanes.other.length >= p.bound) {
		if (p.lastFullWarn === null || now - p.lastFullWarn >= WARN_EVERY_MS) {
			p.lastFullWarn = now;
			log.warn(
				`Password checks are full: ${p.lanes.other.length} password checks waiting (sign-ins, invites, set-up); ` +
					"sign-ins from browsers not remembered, invites and set-up are being answered 'busy'"
			);
		}
		return Promise.reject(new CheckNotMade('full'));
	}

	return new Promise<string | boolean>((resolve, reject) => {
		p.lanes[lane].push({
			id: p.nextId++,
			op,
			password: (password as string).slice(0, KEPT_CHARACTERS),
			hash: hash as string | undefined,
			lane,
			gone: options.gone,
			queuedAt: now,
			stops: 0,
			resolve,
			reject
		});

		const waiting = p.lanes.other.length;
		if (lane === 'other' && waiting > LONG_LINE && (p.lastLongWarn === null || now - p.lastLongWarn >= WARN_EVERY_MS)) {
			p.lastLongWarn = now;
			const oldest = Math.round((now - p.lanes.other[0].queuedAt) / 1000);
			log.warn(`Password checks are queuing: ${waiting} password checks waiting (sign-ins, invites, set-up), the oldest for ${oldest} s`);
		}

		dispatch(p);
	});
}

// ─── What the routes call ───────────────────────────────────────────────────

/**
 * Whether `password` is the one `hash` was made from. Resolves to an object,
 * not a boolean, so that a missed `await` (`.matches` of a promise) does not
 * compile: `!checkPassword(…)` would be false, a wrong password read as right.
 * A stored value that is not a bcrypt hash answers false, or, at 60
 * characters, rejects.
 */
export async function checkPassword(
	password: string,
	hash: string,
	lane: Lane,
	options: CheckOptions = {}
): Promise<{ matches: boolean }> {
	return { matches: (await enqueue('compare', password, hash, lane, options)) === true };
}

/** A bcrypt hash of `password` at `BCRYPT_ROUNDS`. */
export async function makePasswordHash(password: string, lane: Lane, options: CheckOptions = {}): Promise<string> {
	return (await enqueue('hash', password, undefined, lane, options)) as string;
}

/** How the checks stand: for the line's WARN and for the tests. */
export function passwordChecks(): {
	threads: number;
	onServerThread: boolean;
	running: number;
	waiting: Record<Lane, number>;
	checked: number;
	retried: number;
	started: number;
} {
	const p = shared[POOL] ?? makePool(0);
	return {
		threads: p.threads,
		onServerThread: p.onServerThread,
		running: p.slots.filter((slot) => slot.job).length,
		waiting: { known: p.lanes.known.length, other: p.lanes.other.length },
		checked: p.checked,
		retried: p.retried,
		started: p.started
	};
}

// ─── For tests ──────────────────────────────────────────────────────────────

/**
 * For tests: replace the pool with one of `threads` threads (0, the server's
 * thread), ending the one there was. Its threads start at its first check.
 */
export function setPasswordThreads(threads: number, options: PasswordThreadOptions = {}): void {
	const old = shared[POOL];
	if (old) closePool(old);
	shared[POOL] = makePool(threads, options);
	shared[POOL].announced = true;
}

/** For tests: end the thread of a check being made, as a thread that fails would. Whether there was one. */
export function endBusyPasswordThread(): boolean {
	const slot = shared[POOL]?.slots.find((s) => s.job && s.worker);
	if (!slot?.worker) return false;
	void slot.worker.terminate();
	return true;
}
