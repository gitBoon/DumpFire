/**
 * live-stream.ts — keep one of a page's live-update streams open, and when it
 * fails, open it again: but not every three seconds for ever.
 *
 * The board, every page that refreshes itself and All Tasks each listen to a
 * stream of events (`/api/boards/[id]/events` and `/api/events`). Each used
 * to close its `EventSource` on any error and open another three seconds
 * later, for as long as the page was open. An `EventSource` cannot see why it
 * failed, so a stream refused because the session had ended was asked for
 * again every three seconds, and every refusal was two lines in the system
 * log: the gate's 401 and the session lookup's "token not in DB". After a
 * restore that signs everybody out, each open board wrote about 57,000 lines
 * a day, against a log that keeps 50,000.
 *
 * Now, after a failure:
 *
 *   1. It waits: 3 seconds after the first failure, then twice as long after
 *      each failure that follows, up to five minutes. A stream that opens
 *      starts the count again.
 *   2. It asks the stream's own address with `fetch`, which, unlike an
 *      `EventSource`, sees the status, and lets go of the answer as soon as
 *      the status is known.
 *   3. It opens the stream again only if that was a success. A 401 means the
 *      session has ended, a 403 that the board is no longer the caller's to
 *      see, and a 404 that it is gone: none of those is mended by asking
 *      again, and the stream stays closed. The 401 is also what sends a
 *      signed-in page to the login page: the ask goes through `fetch`, which
 *      `src/hooks.client.ts` watches ($lib/signed-out.ts). Anything else, no
 *      answer at all included, is a server that is restarting or a network
 *      that is down, and it waits again.
 *
 * A stream that drops and opens again has missed every event sent while it
 * was down, and nothing replays them, so `onReopen` is called each time it
 * opens after the first: the page re-reads its data.
 *
 * It is given what it reaches for in the browser, with the browser's own as
 * the default, so that the tests, which have no browser, can call it.
 */
import type { Fetch } from '$lib/signed-out';

/** What a stream does in the browser, and what the tests put in its place. */
export type StreamEnvironment = {
	open: (url: string) => EventSource;
	fetch: Fetch;
	setTimeout: (run: () => void, ms: number) => unknown;
	clearTimeout: (timer: unknown) => void;
};

const theBrowser = (): StreamEnvironment => ({
	open: (url) => new EventSource(url),
	fetch: (input, init) => fetch(input, init),
	setTimeout: (run, ms) => setTimeout(run, ms),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
});

/** The first wait after a failure, and the longest. */
const FIRST_WAIT_MS = 3000;
const LONGEST_WAIT_MS = 5 * 60 * 1000;

/** How long to wait before asking again, after `failures` failures in a row (1 or more). */
export function reconnectDelay(failures: number): number {
	return Math.min(FIRST_WAIT_MS * 2 ** Math.max(0, failures - 1), LONGEST_WAIT_MS);
}

/**
 * Whether the stream at `url` should be opened again: 'open' if asking for
 * it now succeeds, 'never' if it is refused for a reason asking again cannot
 * mend, and 'later' if there was no answer or a failure that may pass.
 */
export async function streamVerdict(url: string, fetch: Fetch): Promise<'open' | 'later' | 'never'> {
	const done = new AbortController();
	try {
		const res = await fetch(url, { signal: done.signal, headers: { accept: 'text/event-stream' }, cache: 'no-store' });
		if (res.ok) return 'open';
		if (res.status === 401 || res.status === 403 || res.status === 404) return 'never';
		return 'later';
	} catch {
		return 'later';
	} finally {
		// The answer is a stream with no end: once its status is read it is
		// let go, and the server's end of it closes.
		done.abort();
	}
}

/**
 * Open the stream at `url` and keep it open as described above.
 *
 * @param listen   — puts the page's listeners on each `EventSource` as it is
 *                   made. The `open` and `error` handlers are this file's.
 * @param onReopen — called when the stream opens again after a gap.
 * @returns A function that closes the stream and stops every wait and ask.
 */
export function keepStreamOpen(
	url: string,
	listen: (source: EventSource) => void,
	onReopen: () => void,
	env: StreamEnvironment = theBrowser()
): () => void {
	let source: EventSource | null = null;
	let timer: unknown = null;
	let failures = 0;
	// The first open is the page loading its own data and needs no re-read;
	// every later one follows a gap in which events were missed.
	let hasConnected = false;
	let closed = false;

	function connect() {
		if (closed) return;
		const opened = env.open(url);
		source = opened;

		opened.onopen = () => {
			failures = 0;
			if (hasConnected) onReopen();
			hasConnected = true;
		};

		listen(opened);

		opened.onerror = () => {
			opened.close();
			if (source !== opened || closed) return;
			source = null;
			wait();
		};
	}

	function wait() {
		failures++;
		timer = env.setTimeout(() => void ask(), reconnectDelay(failures));
	}

	async function ask() {
		timer = null;
		if (closed) return;
		const verdict = await streamVerdict(url, env.fetch);
		if (closed) return;
		if (verdict === 'open') connect();
		else if (verdict === 'later') wait();
		// 'never': the stream stays closed until the page is opened again.
	}

	connect();

	return () => {
		closed = true;
		if (timer !== null) env.clearTimeout(timer);
		timer = null;
		if (source) {
			source.close();
			source = null;
		}
	};
}
