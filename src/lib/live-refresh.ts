/**
 * live-refresh.ts — keep a page's data current without a manual reload.
 *
 * Subscribes to the global event stream at /api/events, which carries the
 * 'update' and 'xp-update' events from every board (see subscribeGlobal in
 * $lib/server/events), and calls back whenever the page should re-read.
 *
 * Reconnecting is not the same as catching up. A dropped stream misses every
 * event sent while it was down and nothing replays them, so the page has to
 * re-read on the way back up. Without that, anything recorded during the gap —
 * `add-tokens` run from a terminal, a connection closed by sleep or an idle
 * proxy — stays stale on screen indefinitely, and a stale cost figure looks
 * exactly like work that cost nothing.
 *
 * The board has its own richer handler in $lib/board/sse.ts (it needs the
 * per-board stream plus celebrations), and All Tasks keeps its own because it
 * drives toasts off the event payload. This is the plain case: refresh only.
 */

/**
 * Opens the connection and returns a cleanup function that closes it.
 *
 * @param onRefresh — called when the page's data should be re-read.
 */
export function connectLiveRefresh(onRefresh: () => void): () => void {
	let eventSource: EventSource | null = null;
	let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	// The first open is the page loading its own data and needs no re-read;
	// every later one follows a gap in which events were missed.
	let hasConnected = false;
	let pending: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Coalesce a burst into one read. This stream carries every board, so a
	 * page using it sees far more traffic than a single board does — someone
	 * else reordering a column would otherwise cost one full re-read per card
	 * moved. 250ms matches the delay All Tasks already uses.
	 */
	function scheduleRefresh() {
		if (pending) clearTimeout(pending);
		pending = setTimeout(() => {
			pending = null;
			onRefresh();
		}, 250);
	}

	function connect() {
		eventSource = new EventSource('/api/events');

		eventSource.onopen = () => {
			if (hasConnected) scheduleRefresh();
			hasConnected = true;
		};

		eventSource.addEventListener('update', () => scheduleRefresh());
		eventSource.addEventListener('xp-update', () => scheduleRefresh());

		eventSource.onerror = () => {
			if (eventSource) eventSource.close();
			reconnectTimeout = setTimeout(connect, 3000);
		};
	}

	/**
	 * The other moment a page can be behind. A backgrounded tab can have its
	 * stream torn down without an error the page ever sees, so returning to the
	 * front is its own reason to re-read — which is also what makes a figure
	 * recorded in a terminal current on alt-tab.
	 */
	function onVisibilityChange() {
		if (document.visibilityState === 'visible') scheduleRefresh();
	}
	document.addEventListener('visibilitychange', onVisibilityChange);

	connect();

	return () => {
		document.removeEventListener('visibilitychange', onVisibilityChange);
		if (pending) clearTimeout(pending);
		if (reconnectTimeout) clearTimeout(reconnectTimeout);
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
	};
}
