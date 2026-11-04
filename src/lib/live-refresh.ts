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
 * drives toasts off the event payload. This is the plain case: refresh, and,
 * for a page with a card window (To Do), what each update said and each gap,
 * so the window can tell whether its comments changed (card 2282).
 *
 * A page may listen to other events of the stream instead (card 2680): the
 * register of decisions and a board's list of decisions re-read on a
 * `decision` event, the board's list on its own board's alone. Every event
 * goes through the one 250ms debounce.
 *
 * Opening it again after a failure, and how long to wait first, is
 * $lib/live-stream.ts's: it backs off, and does not open again a stream that
 * was refused because the session has ended.
 */
import { keepStreamOpen } from '$lib/live-stream';
import { boardEvent, type BoardEvent } from '$lib/board/sse';

/** The events of the global stream a page may listen to. */
export type LiveEventName = 'update' | 'xp-update' | 'decision';

/** What a page listens to by default: every caller from before card 2680. */
const DEFAULT_EVENTS: readonly LiveEventName[] = ['update', 'xp-update'];

/**
 * What a page listens to (card 2680, decision 26, D3).
 *
 *   events   replaces the default `['update', 'xp-update']`. The register
 *            passes `['decision']`: a lifecycle write's `decision` event, which
 *            `/api/events` forwards only to a caller who can open its board,
 *            and which a decision with no board never emits.
 *   boardId  a `decision` event re-reads only when its payload's `boardId` is
 *            this board: a board's own list of decisions.
 */
export type LiveRefreshOptions = { events?: readonly LiveEventName[]; boardId?: number };

/** The `boardId` a `decision` event's payload names, or null for one that names none or is not JSON. */
function boardIdOf(data: string): number | null {
	try {
		const parsed = JSON.parse(data) as { boardId?: unknown } | null;
		return typeof parsed?.boardId === 'number' ? parsed.boardId : null;
	} catch {
		return null;
	}
}

/**
 * Opens the connection and returns a cleanup function that closes it.
 *
 * @param onRefresh — called when the page's data should be re-read.
 * @param onEvent — called at once with what each `update` said, and with
 *   null on a reconnect and on a return to the tab, which may have missed
 *   some (card 2282). The re-read is scheduled as before.
 * @param options — which events re-read, and of which board (card 2680):
 *   left out, `update` and `xp-update`, as every caller before it.
 */
export function connectLiveRefresh(
	onRefresh: () => void,
	onEvent?: (event: BoardEvent | null) => void,
	options: LiveRefreshOptions = {}
): () => void {
	const events = options.events ?? DEFAULT_EVENTS;
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

	/** A gap in which events may have been missed: said, then re-read. */
	function caughtUp() {
		onEvent?.(null);
		scheduleRefresh();
	}

	function listen(eventSource: EventSource) {
		if (events.includes('update')) {
			eventSource.addEventListener('update', (e) => {
				const event = boardEvent(e.data);
				if (event) onEvent?.(event);
				scheduleRefresh();
			});
		}
		if (events.includes('xp-update')) eventSource.addEventListener('xp-update', () => scheduleRefresh());
		if (events.includes('decision')) {
			eventSource.addEventListener('decision', (e) => {
				if (options.boardId !== undefined && boardIdOf(e.data) !== options.boardId) return;
				scheduleRefresh();
			});
		}
	}

	/**
	 * The other moment a page can be behind. A backgrounded tab can have its
	 * stream torn down without an error the page ever sees, so returning to the
	 * front is its own reason to re-read — which is also what makes a figure
	 * recorded in a terminal current on alt-tab.
	 */
	function onVisibilityChange() {
		if (document.visibilityState === 'visible') caughtUp();
	}
	document.addEventListener('visibilitychange', onVisibilityChange);

	// Every open after the first follows a gap, and the page is re-read.
	const close = keepStreamOpen('/api/events', listen, caughtUp);

	return () => {
		document.removeEventListener('visibilitychange', onVisibilityChange);
		if (pending) clearTimeout(pending);
		close();
	};
}
