import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { subscribeGlobal } from '$lib/server/events';
import { canViewBoard, isAdmin } from '$lib/server/board-access';
import { SESSION_COOKIE_NAME, openSessionUser } from '$lib/server/auth';
import { createLogger } from '$lib/server/logger';

const log = createLogger('AUTH');

/**
 * Global SSE endpoint — streams events from ALL boards.
 * Used by the All Tasks page, the dashboard and Burndown to receive live
 * updates without needing to know which specific boards are being modified.
 * Requires authentication since it exposes activity across all boards.
 *
 * The gate lets a stream in once, and it then stays open. So at each
 * heartbeat it asks whether the session it was opened with is still open,
 * and ends if not: a sign-out, a password change or a reset stops what an
 * open tab receives within one heartbeat. The page then asks again, is
 * answered 401 by the gate, and goes to sign in. It ends too when the
 * account has become an administrator or stopped being one, since that
 * decides which boards' events it is sent: the page asks again, and the
 * stream it then opens follows the account's role as it is now.
 */
export const GET: RequestHandler = async ({ locals, cookies }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const user = locals.user;
	// Only a session reaches this route: a key is taken only under /api/v1/.
	const token = cookies.get(SESSION_COOKIE_NAME);
	// Decided once, here: every board's events for an administrator. The
	// heartbeat ends the stream when the account's role no longer gives this.
	const openedAsAdmin = isAdmin(user);

	// Every board's events arrive here, and they carry card titles and who did
	// what. A subscriber only gets the ones from boards they can open — this
	// used to forward all of them to any signed-in user.
	//
	// The answer is kept per board until the next heartbeat, which forgets
	// them all (card 2170): a busy board emits several events a second and
	// each check is a handful of queries. So a share taken away stops what
	// this stream sends of that board at the heartbeat, the moment at which it
	// decides everything else again too.
	const access = new Map<number, boolean>();
	const canSee = (boardId: unknown): boolean => {
		if (openedAsAdmin) return true;
		if (typeof boardId !== 'number') return false;
		const known = access.get(boardId);
		if (known !== undefined) return known;
		const allowed = canViewBoard(user, boardId);
		access.set(boardId, allowed);
		return allowed;
	};

	let cleanup: (() => void) | null = null;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			try {
				controller.enqueue(encoder.encode(': heartbeat\n\n'));
			} catch {
				return;
			}

			const unsubscribe = subscribeGlobal((event, data) => {
				if (!canSee((data as { boardId?: unknown } | null)?.boardId)) return;
				try {
					const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
					controller.enqueue(encoder.encode(payload));
				} catch {
					// Client disconnected — clean up
					end();
				}
			});

			const heartbeat = setInterval(() => {
				let checked = false;
				try {
					// The session first: a stream whose session has ended, or
					// whose account has gained or lost the administrator's
					// role, sends nothing more, the heartbeat included.
					const now = openSessionUser(token);
					if (!now || isAdmin(now) !== openedAsAdmin) return end();
					checked = true;
					// Each board is asked again at its next event.
					access.clear();
					controller.enqueue(encoder.encode(': heartbeat\n\n'));
				} catch (err) {
					// The client has gone, or the session could not be checked.
					// Either way the stream ends: the page asks again, and the
					// gate decides. A throw must not leave this timer, where
					// nothing would catch it and the process would end.
					end();
					if (!checked) log.warn('Live stream ended: its session could not be checked', { route: '/api/events', error: String(err) }, { userId: user.id });
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
