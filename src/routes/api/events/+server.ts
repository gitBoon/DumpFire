import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { subscribeGlobal } from '$lib/server/events';

/**
 * Global SSE endpoint — streams events from ALL boards.
 * Used by the All Tasks page to receive live updates without
 * needing to know which specific boards are being modified.
 * Requires authentication since it exposes activity across all boards.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

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
				try {
					const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
					controller.enqueue(encoder.encode(payload));
				} catch {
					// Client disconnected — clean up
					unsubscribe();
					clearInterval(heartbeat);
				}
			});

			const heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': heartbeat\n\n'));
				} catch {
					clearInterval(heartbeat);
					unsubscribe();
				}
			}, 30000);

			// Store cleanup for cancel()
			cleanup = () => {
				unsubscribe();
				clearInterval(heartbeat);
			};
		},
		cancel() {
			if (cleanup) cleanup();
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
