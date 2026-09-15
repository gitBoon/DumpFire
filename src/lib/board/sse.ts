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
 */

export interface SSECallbacks {
	/** Called when the server pushes an 'update' event (data changed). */
	onUpdate: () => void;
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
	let eventSource: EventSource | null = null;
	let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	// Whether a stream has been established before. The first open is the page
	// loading its own data and needs no re-read; every later one follows a gap.
	let hasConnected = false;

	function connect() {
		eventSource = new EventSource(`/api/boards/${boardId}/events`);

		eventSource.onopen = () => {
			if (hasConnected) callbacks.onUpdate();
			hasConnected = true;
		};

		eventSource.addEventListener('update', () => {
			callbacks.onUpdate();
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

		eventSource.onerror = () => {
			if (eventSource) eventSource.close();
			// Auto-reconnect after 3 seconds
			reconnectTimeout = setTimeout(connect, 3000);
		};
	}

	/**
	 * The other moment the page can be behind. A backgrounded tab can have its
	 * stream torn down without an error this page ever sees, so coming back to
	 * the front is treated as its own reason to re-read — which is also what
	 * makes a figure recorded in a terminal current on alt-tab.
	 */
	function onVisibilityChange() {
		if (document.visibilityState === 'visible') callbacks.onUpdate();
	}
	document.addEventListener('visibilitychange', onVisibilityChange);

	connect();

	/** Cleanup: close the connection and cancel any pending reconnect. */
	return () => {
		document.removeEventListener('visibilitychange', onVisibilityChange);
		if (reconnectTimeout) clearTimeout(reconnectTimeout);
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
	};
}
