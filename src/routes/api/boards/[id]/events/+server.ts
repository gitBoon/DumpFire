import { pathId } from '$lib/server/request-body';
import type { RequestHandler } from './$types';
import { subscribe } from '$lib/server/events';
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { canViewBoard } from '$lib/server/board-access';
import { SESSION_COOKIE_NAME, openSessionUser } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { boards } from '$lib/server/db/schema';
import { requireBoard } from '$lib/server/route-guards';
import { createLogger } from '$lib/server/logger';

const log = createLogger('AUTH');

/**
 * A board's live events, over Server-Sent Events.
 *
 * The gate lets a stream in once, and it then stays open. So at each
 * heartbeat it asks whether the session it was opened with is still open,
 * and ends if not: a sign-out, a password change or a reset stops what an
 * open tab receives within one heartbeat. The page then asks again, is
 * answered 401 by the gate, and goes to sign in.
 *
 * It asks at the same heartbeat whether the board is still there and the
 * account, as it is now, can open it (card 2170): a share or a team share
 * taken away, the board made private, or an administrator made an ordinary
 * user who is not on it. If not, it sends one last `update` of its own,
 * `{"type":"access"}`, and ends, so that the page re-reads and shows its
 * load's refusal. A deleted board's page is still told by the board's own
 * event first: that is delivered as the delete commits, in the same run,
 * and a heartbeat is a timer, which cannot come between the two. Board ids
 * are never used again, so a stream on a deleted board can receive nothing
 * more, and ending it loses nothing.
 */
export const GET: RequestHandler = async ({ params, locals, cookies }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const userId = locals.user.id;
	// Only a session reaches this route: a key is taken only under /api/v1/.
	const token = cookies.get(SESSION_COOKIE_NAME);

	const boardId = pathId(params.id, 'board');

	// The board must be there and the caller able to open it, as the heartbeat
	// asks below: 404 for a board that is not there, administrators included,
	// who were once let in on any id; 403 for one the caller cannot open.
	requireBoard(locals.user, boardId, 'view');

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
					const now = openSessionUser(token);
					if (!now) return end();
					// Then the board, and whether the account as it is now can
					// open it. If not, the page is told to re-read, on this
					// stream alone, and the stream ends.
					const there = db.select({ id: boards.id }).from(boards).where(eq(boards.id, boardId)).get();
					if (!there || !canViewBoard(now, boardId)) {
						checked = true;
						controller.enqueue(encoder.encode(`event: update\ndata: ${JSON.stringify({ type: 'access' })}\n\n`));
						return end();
					}
					checked = true;
					controller.enqueue(encoder.encode(': heartbeat\n\n'));
				} catch (err) {
					// The client has gone, or the session or the access could not
					// be checked. Either way the stream ends: the page asks again,
					// and the gate and this route decide. A throw must not leave
					// this timer, where nothing would catch it and the process
					// would end.
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
