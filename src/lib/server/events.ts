// Simple event emitter for SSE-based live updates
type Listener = (event: string, data: unknown) => void;

const boardListeners = new Map<number, Set<Listener>>();

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

export function emit(boardId: number, event: string, data?: unknown) {
	const listeners = boardListeners.get(boardId);
	if (listeners) {
		for (const listener of listeners) {
			listener(event, data);
		}
	}
}
