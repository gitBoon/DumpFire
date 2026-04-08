// Simple event emitter for SSE-based live updates
type Listener = (event: string, data: unknown) => void;

const boardListeners = new Map<number, Set<Listener>>();
const globalListeners = new Set<Listener>();

export function subscribe(boardId: number, listener: Listener) {
	if (!boardListeners.has(boardId)) {
		boardListeners.set(boardId, new Set());
	}
	boardListeners.get(boardId)!.add(listener);

	return () => {
		const listeners = boardListeners.get(boardId);
		if (listeners) {
			listeners.delete(listener);
			if (listeners.size === 0) boardListeners.delete(boardId);
		}
	};
}

/**
 * Subscribe to events from ALL boards — used by the All Tasks page.
 * The listener receives the same events as board-specific subscribers.
 */
export function subscribeGlobal(listener: Listener) {
	globalListeners.add(listener);
	return () => {
		globalListeners.delete(listener);
	};
}

export function emit(boardId: number, event: string, data?: unknown) {
	const listeners = boardListeners.get(boardId);
	if (listeners) {
		for (const listener of listeners) {
			listener(event, data);
		}
	}
	// Also notify global listeners (e.g. All Tasks page)
	for (const listener of globalListeners) {
		listener(event, { ...(data as any), boardId });
	}
}

