import type { RequestHandler } from './$types';
import { subscribe } from '$lib/server/events';
import { error } from '@sveltejs/kit';
import { canViewBoard } from '$lib/server/board-access';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.id);

	// Verify user has access to this board before streaming events
	if (!canViewBoard(locals.user, boardId)) {
		throw error(403, 'No access to this board');
	}

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
					// Client disconnected — will be cleaned up by cancel
				}
			});

			// Heartbeat every 30s to keep connection alive
			const heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': heartbeat\n\n'));
				} catch {
					clearInterval(heartbeat);
					unsubscribe();
				}
			}, 30000);

			// Store cleanup references
			(controller as any)._cleanup = () => {
				unsubscribe();
				clearInterval(heartbeat);
			};
		},
		cancel(reason) {
			// Graceful cleanup on client disconnect
			if ((this as any)._cleanup) {
				(this as any)._cleanup();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
