import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requestMessages, type TaskRequest } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { notifyRequesterMessage, notifyAdminMessage } from '$lib/server/notifications';
import { isSmtpConfigured, linkBaseUrl, mailCannotSend } from '$lib/server/email';
import { canHandleRequest, canReadRequest, linkCheck, requesterMailAddress, requireRequest } from '$lib/server/request-access';
import { issueRequestLink, requestReplyUrl } from '$lib/server/request-tokens';
import { checkRateLimit, resetRateLimit } from '$lib/server/rate-limit';
import { createLogger } from '$lib/server/logger';
import { pathId, readBody, readChoice, readText } from '$lib/server/request-body';
import type { SessionUser } from '$lib/server/auth';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

const log = createLogger('REQUESTS');

/**
 * How many replies the requester may send to one request in an hour (card
 * 2156). Each reply mails every member the request is addressed to, from the
 * server's own sender, and the link that lets someone reply can be forwarded
 * or read in a mailbox, so without a limit whoever holds it could fill the
 * team's inboxes. Twenty is well past a conversation: ten messages in an hour
 * is a long one. A reply from the team clears the count, so a requester who
 * is being answered is never held up; a flood nobody answers is. Counted only
 * for a reply that is saved, per request, in memory, as every other limit is.
 */
const REPLIES_PER_HOUR = 20;
const HOUR = 60 * 60 * 1000;
/** The key the requester's replies to one request are counted under. */
const replyCount = (requestId: number) => `request-reply:${requestId}`;

/**
 * GET — Fetch all messages for a request. Requires auth or the request's own
 * token. A caller with no session and without the link is answered 404,
 * whether the request is there or not (card 2132), and so is the link of a
 * request nobody confirmed within seven days (card 2243), and a signed-in
 * caller who cannot read it (card 2914), in the same words.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const requestId = pathId(params.id, 'request');
	const token = url.searchParams.get('token');

	// Access control: a signed-in user the request is addressed to (or who
	// raised it), OR a live token of the request's. Being signed in is not
	// enough. The token is resolved before the request is read (card 2870, S2).
	const opens = linkCheck(token);
	requireRequest(
		locals.user,
		requestId,
		(row) => (!!locals.user && canReadRequest(locals.user, row)) || opens(row),
		'Access denied'
	);

	// In the order they were sent: by id within one second (card 2367), as the
	// copy onto the card orders them. By the time alone, two of one second came
	// in whatever order SQLite read them.
	const messages = db.select().from(requestMessages)
		.where(eq(requestMessages.requestId, requestId))
		.orderBy(asc(requestMessages.createdAt), asc(requestMessages.id))
		.all();

	return json(messages);
};

/**
 * POST — Add a message to the conversation.
 *
 * The request is looked for, and who is sending checked, before the message
 * is read (card 2117, R1): it was read first, so an empty message about a
 * request that is not there was a 400 and not a 404.
 *
 * Nothing tells a caller with no session which requests exist, or what state
 * one is in (card 2132). A reply from the team without a session is 401 before
 * the request is looked for. A reply as the requester without the link's token
 * is 404, as for a request that is not there; it was 403, and 400 for one
 * resolved or unconfirmed. The state is told only to a caller let in.
 *
 * A signed-in caller who cannot read the request is answered 404 too, as for
 * one that is not there, whichever they send as (card 2914). Only one who can
 * read it is refused 403: its requester replying as the team, or a reader
 * replying as the requester without the link.
 */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	const requestId = pathId(params.id, 'request');
	const body = await readBody(request);

	// The requester, by the link's token, or whoever the request is addressed
	// to, signed in: anything else was taken for the second. Read before the
	// request is looked for, because it says which of the two rules lets the
	// caller in; a value that is neither is 400 for every id alike.
	const senderType = readChoice(body, 'senderType', { from: ['requester', 'admin'] }) ?? 'admin';

	// The request looked for, the sender checked and the message saved in one
	// transaction that asks first who is calling, as their account is now
	// (card 2253): null for a requester with no session, and a 401 for a
	// caller whose session ended while the body arrived, who is never taken
	// for anonymous. The check and the save had no transaction around them.
	const { taskReq, sType, sName, message, newMsg, requester, replyUrl } = writeAs(locals, (caller) => {
		let taskReq: TaskRequest;
		let sender: SessionUser | null = null;
		if (senderType === 'requester') {
			// Their email address used to be enough, so anyone who knew it could
			// post as them. A token that is not text is no token: it was a 500. The
			// link of a lapsed request opens nothing (card 2243).
			// The token is resolved before the request is read (card 2870, S2).
			const token = typeof body.token === 'string' ? body.token : null;
			const opens = linkCheck(token);
			taskReq = requireRequest(caller, requestId, opens, 'Invalid or missing link token');
		} else {
			// Admin/user reply — must be signed in, and the request must be theirs
			// to answer.
			const user = requireUser(caller);
			sender = user;
			taskReq = requireRequest(user, requestId, (row) => canHandleRequest(user, row), 'This request is not addressed to you');
		}
		if (taskReq.status !== 'pending') throw error(400, 'Request is already resolved');

		const readMessage = () =>
			readText(body, 'message', {
				required: true,
				trim: true,
				min: 1,
				max: 5000,
				says: { missing: 'Message is required', empty: 'Message is required' }
			});

		let sType: string;
		let sName: string;
		let message: string;

		if (sender === null) {
			// Public requester reply, let in by the token from their link above.
			message = readMessage();
			// Counted here, after the link and the state are checked and just
			// before the save: a wrong link, a resolved request or an empty or
			// overlong message uses nothing of the twenty. The 21st is refused
			// with nothing saved and nothing mailed.
			const { limited, retryAfterSecs, attempts } = checkRateLimit(replyCount(requestId), REPLIES_PER_HOUR, HOUR);
			if (limited) {
				// Said once a window, at the first refusal: an administrator then
				// sees an abused link on the Audit page. The message is not logged.
				if (attempts === REPLIES_PER_HOUR + 1) {
					log.warn(
						`Request ${requestId} reached its limit of ${REPLIES_PER_HOUR} replies from the requester in an hour: ` +
							'further replies are refused until the hour is up or the team replies',
						{ requestId, retryAfterSecs }
					);
				}
				throw error(
					429,
					`Too many replies to this request in the last hour. Try again in ${Math.ceil(retryAfterSecs / 60)} minute(s).`
				);
			}
			sType = 'requester';
			sName = taskReq.requesterName;
		} else {
			// Admin/user reply, let in above. The reply is emailed to the requester
			// under their name.
			message = readMessage();
			sType = 'admin';
			sName = sender.username;
		}

		const newMsg = db.insert(requestMessages).values({
			requestId,
			senderType: sType,
			senderName: sName,
			message
		}).returning().get();

		// The team's reply carries a link of its own to the requester (card
		// 2870, decision 1), issued here, with the reply, and only when the mail
		// is about to be handed on: an address to send to, mail set up with its
		// password (S5), and an address to make the link from. Earlier links go
		// on working. The requester's address as it is now: the account's, for a
		// request made signed in (card 2171).
		let requester: string | null = null;
		let replyUrl: string | null = null;
		if (sType === 'admin') {
			// None for a requester whose account is disabled (card 2671): no link, no mail.
			requester = requesterMailAddress(taskReq);
			const baseUrl = linkBaseUrl(url);
			// Not while the mail settings are held for review either (card 2922, R12): `mailCannotSend`.
			if (requester !== null && baseUrl !== null && isSmtpConfigured() && !mailCannotSend()) {
				replyUrl = requestReplyUrl(baseUrl, requestId, issueRequestLink(requestId, 'mail'));
			}
		}
		return { taskReq, sType, sName, message, newMsg, requester, replyUrl };
	});

	// The team has answered: the requester's count starts again, so a
	// conversation is never held to twenty messages an hour.
	if (sType === 'admin') resetRateLimit(replyCount(requestId));

	const baseUrl = linkBaseUrl(url);

	// Send email notifications.
	if (sType === 'admin' && requester !== null) {
		// Admin replied → email the requester with a reply link. No address to
		// make the link from, no mail, with the WARN that says so: the message
		// is saved. With the mail password missing every mail would fail, and
		// no link was issued for one (S5).
		if (replyUrl !== null || baseUrl === null) {
			notifyRequesterMessage(taskReq.id, requester, taskReq.title, sName, message, replyUrl);
		}
	} else if (sType === 'requester') {
		// Requester replied → notify inbox targets
		notifyAdminMessage(
			taskReq.targetType,
			taskReq.targetId,
			taskReq.title,
			taskReq.requesterName,
			message,
			baseUrl
		);
	}

	return json(newMsg);
};
