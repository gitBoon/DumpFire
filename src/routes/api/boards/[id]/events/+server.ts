import { pathId } from '$lib/server/request-body';
import type { RequestHandler } from './$types';
import { subscribe } from '$lib/server/events';
import { error } from '@sveltejs/kit';
import { canViewBoard } from '$lib/server/board-access';
import { SESSION_COOKIE_NAME, sessionStillOpen } from '$lib/server/auth';
import { createLogger } from '$lib/server/logger';

const log = createLogger('AUTH');

/**
 * A board's live events, over Server-Sent Events.
 *
 * The gate lets a stream in once, and it then stays open. So at each
 * heartbeat it asks whether the session it was opened with is still open,
 * and ends if not: a sign-out, a password change or a reset stops what an
 * open tab receives within one heartbeat. The page then asks again, is
 * answered 401 by the gate, and goes to sign in. Access to the board is not
 * asked again, so that a deleted board's page is told by its event.
 */
export const GET: RequestHandler = async ({ params, locals, cookies }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const userId = locals.user.id;
	// Only a session reaches this route: a key is taken only under /api/v1/.
	const token = cookies.get(SESSION_COOKIE_NAME);

	const boardId = pathId(params.id, 'board');

	// Verify user has access to this board before streaming events
	if (!canViewBoard(locals.user, boardId)) {
		throw error(403, 'No access to this board');
	}

	let cleanup: (() => void) | null = null;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			// Send initial heartbeat
			try {
				controller.enqueue(encoder.encode(': heartbeat\n\n'));
			} catch {
				return;
			}

			const unsubscribe = subscribe(boardId, (event, data) => {
				try {
					const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
					controller.enqueue(encoder.encode(payload));
				} catch {
					// Client disconnected — clean up
					end();
				}
			});

			// Heartbeat every 30s to keep connection alive
			const heartbeat = setInterval(() => {
				let checked = false;
				try {
					// The session first: a stream whose session has ended sends
					// nothing more, the heartbeat included.
					if (!sessionStillOpen(token)) return end();
					checked = true;
					controller.enqueue(encoder.encode(': heartbeat\n\n'));
				} catch (err) {
					// The client has gone, or the session could not be checked.
					// Either way the stream ends: the page asks again, and the
					// gate decides. A throw must not leave this timer, where
					// nothing would catch it and the process would end.
					end();
					if (!checked) log.warn('Live stream ended: its session could not be checked', { route: '/api/boards/[id]/events', boardId, error: String(err) }, { userId });
				}
			}, 30000);

			// Stop listening, stop the heartbeat, and close the stream if it
			// is still open.
			let ended = false;
			const end = () => {
				if (ended) return;
				ended = true;
				unsubscribe();
				clearInterval(heartbeat);
				try { controller.close(); } catch { /* already closed or cancelled */ }
			};

			// Store cleanup for cancel()
			cleanup = end;
		},
		cancel() {
			if (cleanup) cleanup();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
