/**
 * sse.ts — Server-Sent Events connection manager for live board updates.
 *
 * Manages the SSE connection lifecycle: connecting, handling events,
 * and auto-reconnecting on failure. Accepts callbacks so the board page
 * can react to server events without managing the EventSource directly.
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

	function connect() {
		eventSource = new EventSource(`/api/boards/${boardId}/events`);

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

	connect();

	/** Cleanup: close the connection and cancel any pending reconnect. */
	return () => {
		if (reconnectTimeout) clearTimeout(reconnectTimeout);
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
	};
}
