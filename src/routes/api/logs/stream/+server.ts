import type { RequestHandler } from './$types';
import { getRecentLogs, subscribeToLogs, type LogEntry } from '$lib/server/logger';

/**
 * GET /api/logs/stream — Live system log feed over Server-Sent Events.
 *
 * Backfills the logger's in-memory ring buffer (last ~100 entries), then
 * pushes every new log entry as it is emitted. A comment heartbeat every
 * 25s keeps proxies from closing the idle connection.
 *
 * Requires admin or superadmin role.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		return new Response('Forbidden', { status: 403 });
	}

	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let closed = false;

	const stream = new ReadableStream({
		start(controller) {
			const cleanup = () => {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				if (heartbeat) clearInterval(heartbeat);
				try { controller.close(); } catch { /* already closed */ }
			};

			const send = (entry: LogEntry) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`));
				} catch {
					cleanup();
				}
			};

			// Backfill recent history, then go live
			for (const entry of getRecentLogs(100)) send(entry);
			unsubscribe = subscribeToLogs(send);

			heartbeat = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(': ping\n\n'));
				} catch {
					cleanup();
				}
			}, 25_000);
		},
		cancel() {
			closed = true;
			unsubscribe?.();
			if (heartbeat) clearInterval(heartbeat);
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			'Connection': 'keep-alive',
			// Tell nginx-style proxies not to buffer the stream
			'X-Accel-Buffering': 'no'
		}
	});
};
