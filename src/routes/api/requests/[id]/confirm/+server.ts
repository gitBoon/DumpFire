import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { taskRequests } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { notifyTaskRequest } from '$lib/server/notifications';
import { linkBaseUrl } from '$lib/server/email';
import { checkRateLimit } from '$lib/server/rate-limit';
import { requestReplyUrl, requestTokenMatches } from '$lib/server/request-tokens';
import { addressToCount } from '$lib/server/client-address';
import { pathId, readBody } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/**
 * POST — Confirm a request submitted without an account.
 *
 * Body: `{ token }`, the token from the link in the confirmation email.
 *
 * This is the moment the team first hears about the request: it becomes
 * 'pending', appears in the inbox, and the notification email goes out. Until
 * now the only message sent was the one to the requester.
 *
 * A POST, not a GET, on purpose. Mail scanners follow the links in a message
 * before the recipient sees it; a link that confirmed on sight would let a
 * request made with somebody else's address confirm itself.
 */
export const POST: RequestHandler = async ({ params, request, url, getClientAddress }) => {
	const { limited, retryAfterSecs } = checkRateLimit(
		`request-confirm:${addressToCount({ getClientAddress })}`,
		20,
		15 * 60 * 1000
	);
	if (limited) {
		throw error(429, `Too many attempts. Try again in ${Math.ceil(retryAfterSecs / 60)} minute(s).`);
	}

	const id = pathId(params.id, 'request');
	// A body that is missing, is not JSON or is not an object is a 400, and one
	// over the limit a 413 (`guardBody`), before any request is looked up. A
	// failed read used to be swallowed, and answered as a link that is not
	// valid (card 2117, decision 19).
	const body = await readBody(request);
	// A token that is not text is no request's token, and gets the answer a
	// wrong one gets, below. It was handed to the comparison as it came, which
	// threw for a request that exists and not for one that does not: a 500
	// told the ids of real requests from the rest.
	const token = typeof body.token === 'string' ? body.token : null;

	const existing = db.select().from(taskRequests).where(eq(taskRequests.id, id)).get();
	// One answer for "no such request" and "wrong token", so the ids of real
	// requests cannot be picked out by trying numbers.
	if (!existing || !requestTokenMatches(existing, token)) {
		throw error(404, 'This confirmation link is not valid.');
	}

	// The page is sent the path of the thread, and adds it to wherever it is.
	const replyUrl = requestReplyUrl('', existing);
	// For the link in the mail to the team: see linkBaseUrl.
	const baseUrl = linkBaseUrl(url);

	// Following the link twice is not an error, and must not email the team twice.
	if (existing.status !== 'unverified') {
		return json({ confirmed: true, alreadyConfirmed: true, title: existing.title, replyUrl });
	}

	// The status is in the WHERE so two confirmations racing each other cannot
	// both believe they were first.
	const updated = db
		.update(taskRequests)
		.set({ status: 'pending' })
		.where(and(eq(taskRequests.id, id), eq(taskRequests.status, 'unverified')))
		.returning({ id: taskRequests.id })
		.get();

	if (updated) {
		notifyTaskRequest(
			existing.targetType,
			existing.targetId,
			existing.title,
			existing.requesterName,
			existing.priority,
			baseUrl
		);
	}

	return json({ confirmed: true, alreadyConfirmed: !updated, title: existing.title, replyUrl });
};
