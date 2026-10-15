import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { webhooks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { inTransaction } from '$lib/server/db/transaction';
import { pathId, readBody, readChoices, readText, readUrl } from '$lib/server/request-body';
import { requireBoard, requireUser } from '$lib/server/route-guards';
import { canSeeWebhookSecret, presentWebhook, WEBHOOK_EVENTS } from '$lib/server/webhooks';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/boards/:boardId/webhooks — List all webhooks for a board.
 *
 * The signing secret and the address are included only for the board's owner
 * or an administrator. Everyone else gets `hasSecret`, and no `url`. Both used
 * to be returned to anyone who could view the board: the address until card
 * 2133.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const boardId = requireBoard(locals.user, pathId(params.boardId, 'board'), 'view').id;
	const reveal = canSeeWebhookSecret(locals.user!, boardId);

	const hooks = db.select().from(webhooks)
		.where(eq(webhooks.boardId, boardId))
		.all()
		.map((h) => presentWebhook(h, reveal));

	return json(hooks);
};

/**
 * POST /api/v1/boards/:boardId/webhooks — Create a webhook.
 *
 * The response carries the secret and the address back to the caller who has
 * just supplied them. After this they are only ever shown to the board's owner
 * or an administrator.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const boardId = pathId(params.boardId, 'board');
	const body = await readBody(request);

	// The board is looked for and the caller checked in the transaction that
	// saves the webhook, once the body has arrived.
	const hook = inTransaction(() => {
		requireBoard(user, boardId, 'edit');

		const url = readUrl(body, 'url', { required: true, says: { missing: 'URL is required' } });
		const secret = readText(body, 'secret', { max: 256 });
		// Each name trimmed: the wrapper sends "card.created, card.moved" split
		// on the commas. An empty list, or none, is every event.
		const events = readChoices(body, 'events', { from: WEBHOOK_EVENTS, trim: true });

		return db.insert(webhooks)
			.values({ boardId, url, secret: secret ?? '', events: JSON.stringify(events ?? []) })
			.returning()
			.get();
	});

	return json(presentWebhook(hook, true), { status: 201 });
};
