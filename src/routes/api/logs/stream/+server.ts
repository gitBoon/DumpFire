import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createLogger, getRecentLogs, subscribeToLogs, type LogEntry } from '$lib/server/logger';
import { openSession, sessionEndTimer, sessionHashIn } from '$lib/server/auth';
import { isAdmin } from '$lib/server/board-access';

const log = createLogger('AUTH');

/**
 * GET /api/logs/stream — Live system log feed over Server-Sent Events.
 *
 * Backfills the logger's in-memory ring buffer (last ~100 entries), then
 * pushes every new log entry as it is emitted. A comment heartbeat every
 * 25s keeps proxies from closing the idle connection.
 *
 * At each heartbeat it asks whether the session it was opened with is still
 * open, and whether its account is still an administrator, and ends if not:
 * a sign-out, a password change, a reset or a change of role stops the feed
 * within one heartbeat, where it once ran until the tab was closed.
 *
 * Requires admin or superadmin role.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user || !isAdmin(locals.user)) {
		// Returned, not thrown: the caller is an EventSource, which asks for an
		// event stream, and a thrown error is answered to that as an HTML page.
		return json({ message: 'Forbidden' }, { status: 403 });
	}
	const userId = locals.user.id;
	// Only a session reaches this route: a key is taken only under /api/v1/.
	// Its hash, as the gate found it (card 2775), is asked at each heartbeat.
	const session = sessionHashIn(locals.credential);

	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let untilDeadline: ReturnType<typeof sessionEndTimer> | null = null;
	let closed = false;

	const stream = new ReadableStream({
		start(controller) {
			const cleanup = () => {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				if (heartbeat) clearInterval(heartbeat);
				untilDeadline?.clear();
				try { controller.close(); } catch { /* already closed */ }
			};

			// Ended at the session's deadline, not at the heartbeat after it
			// (card 2775, the code review's CS4).
			untilDeadline = sessionEndTimer(cleanup);
			untilDeadline.arm(openSession(session)?.deadline);
			if (closed) return;

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
				let checked = false;
				try {
					// The session first: a stream whose session has ended, or
					// whose account is no longer an administrator, sends nothing
					// more, the heartbeat included.
					const open = openSession(session);
					if (!open || !isAdmin(open.user)) return cleanup();
					checked = true;
					// The deadline as it is now: a request of the holder's may
					// have moved it on (card 2775).
					untilDeadline?.arm(open.deadline);
					controller.enqueue(encoder.encode(': ping\n\n'));
				} catch (err) {
					// The client has gone, or the session could not be checked.
					// Either way the stream ends: the console asks again, and the
					// gate decides. A throw must not leave this timer, where
					// nothing would catch it and the process would end. The
					// line is written once this stream has stopped listening.
					cleanup();
					if (!checked) log.warn('Live stream ended: its session could not be checked', { route: '/api/logs/stream', error: String(err) }, { userId });
				}
			}, 25_000);
		},
		cancel() {
			closed = true;
			unsubscribe?.();
			if (heartbeat) clearInterval(heartbeat);
			untilDeadline?.clear();
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
