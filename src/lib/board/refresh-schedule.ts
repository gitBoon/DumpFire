/**
 * refresh-schedule.ts — when the board page re-reads its board (card 2280,
 * slice B1 of card 2012's part B).
 *
 * Every change on a board is told to every page open on it, the page that
 * made it included, and a live event carries nothing a reader may not read,
 * so the page re-reads its board's contents (`GET /api/boards/[id]/contents`)
 * to see what changed. This decides when that read is sent:
 *
 *   - **A burst is one read.** A bulk archive of 20 cards is 20 events. Each
 *     call waits 250 ms for the next, as `$lib/live-refresh.ts` does, but never
 *     more than about a second after the first call not yet served: a stream
 *     of events still shows on screen.
 *   - **One read at a time.** A call while a read is out is served by one more
 *     read after it, never one beside it.
 *   - **Held while the page is busy.** A drag, from its first move to the
 *     move's answer, and every write of the page's own while it is out, hold
 *     the reads: an answer landing then would draw the board under the user's
 *     hand. A read already out when a hold is taken is answered too late in
 *     the same way, and is dropped as below. Holds are a count, each let go
 *     once, and the last let go sends the read that waited. A hold left open (a missed `finally`) is let go by a
 *     watchdog after about 30 s, so the board cannot stop following for good;
 *     all but one taken without it (`hold({ watchdog: false })`), whose end a
 *     window open on screen decides: the On Hold note's (B2a review).
 *   - **An access event is never held.** The board's stream says when the
 *     caller may no longer open it; that read is sent at once, whatever else
 *     is going on, so the page shows its refusal.
 *   - **A late answer is dropped.** Each read is sent with the generation of
 *     the page's own writes: a write that settles while the read is out
 *     changed the board after the read began, so its answer may be older than
 *     the screen. It is not applied, and the board is read again.
 *
 * `run` sends the read and returns how to apply its answer (or nothing, to
 * keep the screen); this module decides whether the answer is still current
 * and applies it. Plain TypeScript on the page's own timers, so the tests run
 * it with fake ones.
 */

/** How long a call waits for the next before the read is sent. */
export const REFRESH_DELAY_MS = 250;
/** The longest a call waits, under a stream of calls. */
export const REFRESH_MAX_WAIT_MS = 1000;
/** When a hold left open is let go. */
export const HOLD_WATCHDOG_MS = 30_000;

/** Puts a read's answer on the screen. */
export type ApplyAnswer = () => void;

/**
 * Lets a hold go; counts once however often it is called. `released` says
 * whether it is spent, by its own call or by the watchdog, so a page that
 * keeps one (a drag's) takes a fresh one rather than lean on a spent one.
 */
export type Release = (() => void) & { readonly released: boolean };

/**
 * `watchdog: false` keeps the hold out of the watchdog's reach, for a hold
 * whose end the person decides and a window shows, the On Hold note window's
 * (B2a review): it is let go only by its release, or when the schedule stops.
 */
export type HoldOptions = { watchdog?: boolean };

/**
 * Sends one read. Resolves to how to apply its answer, or to nothing when
 * there is nothing to apply (no answer, or one that keeps the screen as it
 * is). It should not throw; a throw is taken as nothing to apply.
 */
export type RefreshRun = () => Promise<ApplyAnswer | void>;

export type RefreshSchedule = {
	/** A read is wanted: sent after the burst, once nothing holds it. */
	schedule(): void;
	/**
	 * A read is wanted now, with no 250 ms wait (linking or deleting a
	 * sub-board, whose progress only the server works out). Still one at a
	 * time, and still held. Resolves once a read sent after the call has been
	 * answered, and its answer applied if it was current.
	 */
	now(): Promise<void>;
	/** An access event: read at once, held or not. */
	access(): void;
	/** Hold the reads. Returns the release, which counts once however often it is called. */
	hold(options?: HoldOptions): Release;
	/** A write of the page's own has settled: a read already out is answered too late to apply. */
	settled(): void;
	/** Holds open now. */
	readonly holds: number;
	/** Whether a read is out. */
	readonly inFlight: boolean;
	/** Stop: no more reads, every timer cleared, every `now()` resolved. */
	dispose(): void;
};

export type RefreshTiming = { delayMs?: number; maxWaitMs?: number; watchdogMs?: number };

export function refreshSchedule(run: RefreshRun, timing: RefreshTiming = {}): RefreshSchedule {
	const delayMs = timing.delayMs ?? REFRESH_DELAY_MS;
	const maxWaitMs = timing.maxWaitMs ?? REFRESH_MAX_WAIT_MS;
	const watchdogMs = timing.watchdogMs ?? HOLD_WATCHDOG_MS;

	/** A read is wanted and not yet sent. */
	let pending = false;
	/** When the first call not yet served was made. */
	let firstAskedAt = 0;
	/** The wanted read goes with no wait (`now()`). */
	let urgent = false;
	/** The wanted read is not held (an access event). */
	let forced = false;
	/** Who waits on `now()` for the next read to be answered. */
	let waiters: (() => void)[] = [];

	let timer: ReturnType<typeof setTimeout> | null = null;
	let inFlight = false;
	let holds = 0;
	const watchdogs = new Set<ReturnType<typeof setTimeout>>();
	let generation = 0;
	let disposed = false;

	function ask() {
		if (!pending) {
			pending = true;
			firstAskedAt = Date.now();
		}
	}

	function clearTimer() {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	}

	/**
	 * Send the wanted read when it is due: at once for `now()` and an access
	 * event, else 250 ms after the latest call and no later than the maximum
	 * wait after the first. Nothing while a read is out (its end calls this
	 * again) or while held (the last release sends it).
	 */
	function arm() {
		if (disposed || !pending || inFlight) return;
		if (holds > 0 && !forced) return;
		clearTimer();
		const wait = urgent || forced ? 0 : Math.max(0, Math.min(delayMs, firstAskedAt + maxWaitMs - Date.now()));
		if (wait === 0) {
			void send();
			return;
		}
		timer = setTimeout(() => {
			timer = null;
			void send();
		}, wait);
	}

	async function send() {
		const served = waiters;
		const wasUrgent = urgent;
		const wasForced = forced;
		waiters = [];
		pending = false;
		urgent = false;
		forced = false;
		const sentAt = generation;
		inFlight = true;
		let dropped = false;
		try {
			const apply = await run();
			if (disposed) return;
			if (generation !== sentAt) {
				// A hold was taken or a write settled while the read was out: read
				// again, as urgently as this one was, for whoever waited on it. An
				// access read's answer is drawn all the same, as it would have been
				// under the hold: dropped, a run of drags and writes could keep the
				// refusal back for as long as it lasted (B1 re-check). The read
				// again is an ordinary one, which the last release sends.
				if (wasForced && apply) apply();
				dropped = true;
				ask();
				urgent ||= wasUrgent;
				waiters = served.concat(waiters);
			} else if (apply) {
				apply();
			}
		} catch {
			// Nothing to apply: the screen is kept.
		} finally {
			inFlight = false;
			if (!dropped) for (const done of served) done();
			arm();
		}
	}

	return {
		schedule() {
			if (disposed) return;
			ask();
			arm();
		},
		now() {
			if (disposed) return Promise.resolve();
			return new Promise<void>((resolve) => {
				waiters.push(resolve);
				ask();
				urgent = true;
				arm();
			});
		},
		access() {
			if (disposed) return;
			ask();
			forced = true;
			arm();
		},
		hold(options: HoldOptions = {}) {
			let released = false;
			const spent = () => released;
			// Stopped: nothing to hold, and no watchdog left behind.
			if (disposed) {
				released = true;
				return Object.defineProperty(() => {}, 'released', { get: spent }) as Release;
			}
			holds += 1;
			// A read already out was sent before what this holds for began (a drag,
			// a write shown at once): its answer would draw the board as it was,
			// under it. It is dropped as a late answer is, and the board read again
			// once the last hold is let go (B1 review).
			generation += 1;
			clearTimer();
			let watchdog: ReturnType<typeof setTimeout> | null = null;
			const release = () => {
				if (released) return;
				released = true;
				if (watchdog !== null) {
					clearTimeout(watchdog);
					watchdogs.delete(watchdog);
				}
				holds -= 1;
				// The last let go sends the read that waited, at once.
				if (holds === 0 && pending && !inFlight && !disposed) void send();
			};
			if (options.watchdog !== false) {
				watchdog = setTimeout(release, watchdogMs);
				watchdogs.add(watchdog);
			}
			return Object.defineProperty(release, 'released', { get: spent }) as Release;
		},
		settled() {
			generation += 1;
		},
		get holds() {
			return holds;
		},
		get inFlight() {
			return inFlight;
		},
		dispose() {
			disposed = true;
			pending = false;
			clearTimer();
			for (const watchdog of watchdogs) clearTimeout(watchdog);
			watchdogs.clear();
			for (const done of waiters) done();
			waiters = [];
		}
	};
}
