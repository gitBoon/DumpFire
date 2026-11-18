import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { webhooks } from '$lib/server/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { pathId, readBody, readChoices, readText } from '$lib/server/request-body';
import { requireBoard, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import { canSeeWebhookSecret, hostOf, keyOfWrite, presentWebhook, receiverOf, refuseWebhookOverCap, WEBHOOK_EVENTS } from '$lib/server/webhooks';
import { readWebhookUrl } from '$lib/server/webhook-address';
import { notifyWebhookCreated } from '$lib/server/notifications';
import type { RequestHandler } from './$types';

/** Said to a create at a receiver held off on the board, by anyone but its owners and administrators (card 2752, D6; the code review's CS2). */
const HELD_OFF_RECEIVER =
	"A webhook to this receiver (the same scheme, host and port) on this board was switched off. Only the board's owner or an administrator can switch it on again, or add another webhook to it.";

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
 *
 * Card 2752 (D6, S3): a caller who is neither the board's owner nor an
 * administrator is refused 409, with nothing written, a receiver (scheme,
 * host and port, `receiverOf`; the code review's CS2) that a webhook on the
 * board was switched off at for good (`held_because` set), asked last of all
 * (CS3); and when such a caller makes one, the board's owners are mailed who
 * made it, its id and its host (`notifyWebhookCreated`).
 *
 * The API key the caller came in with is recorded beside them (`set_by_key`,
 * `set_with_key`, card 2893, `keyOfWrite`), so that the webhook is switched
 * off when that key ends; never in an answer.
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

		const url = readWebhookUrl(body, { required: true, says: { missing: 'URL is required' } })!;		const secret = readText(body, 'secret', { max: 256 });
		// Each name trimmed: the wrapper sends "card.created, card.moved" split
		// on the commas. An empty list, or none, is every event.
		const events = readChoices(body, 'events', { from: WEBHOOK_EVENTS, trim: true });

		refuseWebhookOverCap(boardId);
		// A receiver a webhook on this board was switched off at for good (card
		// 2752, D6, S3) is the owners' and administrators' to send to again: to
		// anyone else, a new webhook there would be the held one back on. The
		// receiver, not the address as typed (the code review's CS2): the same
		// scheme, host and port, whatever the path, query, case or default port.
		// Asked last, immediately before the insert (CS3), so a request that
		// fails any other check is told that, and nothing says whether the
		// receiver is held off.
		const owns = canSeeWebhookSecret(user, boardId);
		if (!owns) {
			const receiver = receiverOf(url);
			const heldOff = db.select({ url: webhooks.url }).from(webhooks)
				.where(and(eq(webhooks.boardId, boardId), eq(webhooks.active, false), isNotNull(webhooks.heldBecause)))
				.all()
				.some((hook) => receiver !== null && receiverOf(hook.url) === receiver);
			if (heldOff) throw error(409, HELD_OFF_RECEIVER);
		}
		const hook = db.insert(webhooks)
			.values({ boardId, url, secret: secret ?? '', events: JSON.stringify(events ?? []), setBy: user.id, ...keyOfWrite(locals.credential) })
			.returning()
			.get();
		// The board's owners are told of a webhook someone else made (card 2752, S3), once it is committed.
		if (!owns) notifyWebhookCreated(boardId, user.username, { id: hook.id, host: hostOf(hook.url) });
		// Made here, in the transaction that saved it: `pausedBecause` (card
		// 2325) reads whether its setter, the caller, can open the board.
		return presentWebhook(hook, true);
	});

	return json(answer, { status: 201 });
};
