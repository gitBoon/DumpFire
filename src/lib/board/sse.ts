/**
 * sse.ts — Server-Sent Events connection manager for live board updates.
 *
 * Manages the SSE connection lifecycle: connecting, handling events,
 * and auto-reconnecting on failure. Accepts callbacks so the board page
 * can react to server events without managing the EventSource directly.
 *
 * Reconnecting is not the same as catching up. A dropped stream misses every
 * event sent while it was down and nothing replays them, so the page has to
 * re-read its data on the way back up. Without that, a figure recorded during
 * the gap — `add-tokens` run from a terminal while the laptop was asleep, or
 * an idle proxy closing the stream — stays stale on screen indefinitely, and
 * looks exactly like work that cost nothing.
 *
 * Opening it again after a failure, and how long to wait first, is
 * $lib/live-stream.ts's: it backs off, and does not open again a stream that
 * was refused because the session has ended.
 */
import { keepStreamOpen } from '$lib/live-stream';

/**
 * What an `update` event said, as the server sent it: `{"type":"access"}`
 * when the caller may no longer open the board (card 2170), else what
 * changed. It carries nothing a reader may not read; the page reads the
 * board again to see what changed.
 */
export type BoardEvent = { type?: unknown; [key: string]: unknown };

/** An `update` event's data, read: its object, or null for anything else. */
export function boardEvent(data: unknown): BoardEvent | null {
	if (typeof data !== 'string') return null;
	try {
		const read = JSON.parse(data);
		return read && typeof read === 'object' && !Array.isArray(read) ? (read as BoardEvent) : null;
	} catch {
		return null;
	}
}

/**
 * Whether a card window open on `cardId` should read its comments again
 * (card 2282): for a comment added, edited or deleted on that card
 * (`{"type":"comment","cardId":…}`), and for `null`, a reconnect or a return
 * to the tab, after which one may have been missed (or no event at all,
 * which is read the same way rather than thrown on). Any other update, or a
 * comment on another card, is not about the window's comments.
 */
export function commentsChanged(event: BoardEvent | null | undefined, cardId: number | null | undefined): boolean {
	if (event == null) return true;
	return event.type === 'comment' && cardId != null && event.cardId === cardId;
}

export interface SSECallbacks {
	/**
	 * Called when the board may have changed: with what an 'update' event
	 * said, so the page can tell the access event from the rest (card 2280,
	 * slice B2a), and with null for a reconnect and a return to the tab.
	 */
	onUpdate: (event: BoardEvent | null) => void;
	/** Called when the server pushes a 'celebrate' event (card completed). */
	onCelebrate: (data: { cardTitle: string; userName: string; userEmoji: string; xpGained: number }) => void;
	/** Called when the server pushes an 'xp-update' event. */
	onXpUpdate: () => void;
}

/**
 * Creates and manages an SSE connection for a board.
 * Returns a cleanup function that closes the connection.
 *
 * @param boardId  — The board to subscribe to.
 * @param callbacks — Event handlers for each SSE event type.
 * @returns A cleanup function to close the connection.
 */
export function connectSSE(boardId: number, callbacks: SSECallbacks): () => void {
	function listen(eventSource: EventSource) {
		eventSource.addEventListener('update', (e) => {
			callbacks.onUpdate(boardEvent(e.data));
		});

		eventSource.addEventListener('celebrate', (e) => {
			try {
				const data = JSON.parse(e.data);
				callbacks.onCelebrate({
					cardTitle: data.cardTitle || '',
					userName: data.userName || 'Someone',
					userEmoji: data.userEmoji || '👤',
					xpGained: data.xpGained || 0
				});
			} catch {
				callbacks.onCelebrate({
					cardTitle: '',
					userName: 'Someone',
					userEmoji: '👤',
					xpGained: 0
				});
			}
		});

		eventSource.addEventListener('xp-update', () => {
			callbacks.onXpUpdate();
		});
	}

	/**
	 * The other moment the page can be behind. A backgrounded tab can have its
	 * stream torn down without an error this page ever sees, so coming back to
	 * the front is treated as its own reason to re-read — which is also what
	 * makes a figure recorded in a terminal current on alt-tab.
	 */
	function onVisibilityChange() {
		if (document.visibilityState === 'visible') callbacks.onUpdate(null);
	}
	document.addEventListener('visibilitychange', onVisibilityChange);

	// Every open after the first follows a gap, and the board is re-read.
	const close = keepStreamOpen(`/api/boards/${boardId}/events`, listen, () => callbacks.onUpdate(null));

	/** Cleanup: close the connection and cancel any pending reconnect. */
	return () => {
		document.removeEventListener('visibilitychange', onVisibilityChange);
		close();
	};
}
