import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { webhooks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { pathId, readBody, readChoices, readText } from '$lib/server/request-body';
import { requireBoard, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import { canSeeWebhookSecret, presentWebhook, refuseWebhookOverCap, WEBHOOK_EVENTS } from '$lib/server/webhooks';
import { readWebhookUrl } from '$lib/server/webhook-address';
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
 *
 * The address may not point inside the network as written, nor carry a user
 * name or password (card 2161): a 400 that says why, with no name looked up;
 * delivery judges what the name resolves to. The caller is recorded as the
 * webhook's setter (`set_by`, card 2168), whose password reset switches it
 * off. A board holds at most 10 webhooks (card 2201): the 11th is a 409, the
 * last check, made immediately before the insert in the same transaction.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const boardId = pathId(params.boardId, 'board');
	const body = await readBody(request);

	// The key is asked again, and who its account is now, the board looked
	// for and the caller checked in the transaction that saves the webhook,
	// once the body has arrived: a reset that ended the key while the body
	// was arriving is a 401 here, and an account that lost its access
	// meanwhile is refused as it now is (card 2253).
	const answer = writeAs(locals, (caller) => {
		const user = requireUser(caller);
		requireBoard(user, boardId, 'edit');

		const url = readWebhookUrl(body, { required: true, says: { missing: 'URL is required' } })!;
		const secret = readText(body, 'secret', { max: 256 });
		// Each name trimmed: the wrapper sends "card.created, card.moved" split
		// on the commas. An empty list, or none, is every event.
		const events = readChoices(body, 'events', { from: WEBHOOK_EVENTS, trim: true });

		refuseWebhookOverCap(boardId);
		const hook = db.insert(webhooks)
			.values({ boardId, url, secret: secret ?? '', events: JSON.stringify(events ?? []), setBy: user.id })
			.returning()
			.get();
		// Made here, in the transaction that saved it: `pausedBecause` (card
		// 2325) reads whether its setter, the caller, can open the board.
		return presentWebhook(hook, true);
	});

	return json(answer, { status: 201 });
};
