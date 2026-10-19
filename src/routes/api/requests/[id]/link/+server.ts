import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { taskRequests } from '$lib/server/db/schema';
import { NO_LINK_ADDRESS, isSmtpConfigured, linkBaseUrl, smtpPasswordMissing } from '$lib/server/email';
import { notifyRequesterNewLink } from '$lib/server/notifications';
import { checkRateLimit } from '$lib/server/rate-limit';
import { addressToCount } from '$lib/server/client-address';
import { hasLapsed, requesterAddress } from '$lib/server/request-access';
import { requestConfirmUrl, requestReplyUrl } from '$lib/server/request-tokens';
import { readBody, readText } from '$lib/server/request-body';
import { createLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = createLogger('REQUESTS');

const MINUTE = 60 * 1000;
/** Asks from one address in 15 minutes, whatever they ask. */
const ASKS_PER_ADDRESS = 5;
/** New-link mails to one address in an hour, whichever requests they are for (R3). */
const MAILS_PER_ADDRESS = 3;
/**
 * Confirmation mails to one address in an hour: the public form's own figure
 * and key (`POST /api/requests`). A new link to a request not yet confirmed is
 * one, and is counted with them (the review's S2).
 */
const CONFIRMATIONS_PER_ADDRESS = 3;
/**
 * New-link mails in an hour from the whole server, whatever the addresses: the
 * public form's figure for its anonymous requests in all (S2).
 */
const MAILS_IN_ALL = 30;

/** The one answer to every ask that is read: the same whether or not anything was sent. */
const ANSWER = 'If that is the address the request was made with, a new link has been sent to it.';

/**
 * What a requester is told when this server cannot send a link (the review's
 * O7): plain words for somebody who has no account. Why is the superadmin's,
 * and is said in the log line alone.
 */
const CANNOT_SEND = 'New links cannot be sent just now. Please contact the team that sent you the link.';

/** Why, when this server sends no mail. */
const NO_MAIL = 'mail is not set up on this server (Admin, 📧 Email / SMTP)';

/** Why, when the mail settings name a user and hold no password, as a restore leaves them (O6). */
const NO_MAIL_PASSWORD =
	'the mail settings name a user and hold no password, so every mail would fail; a backup does not hold it, and it ' +
	'is entered again in Admin, 📧 Email / SMTP';

/** An address as it is compared and counted: no surrounding spaces, in lower case. */
const comparable = (address: string) => address.trim().toLowerCase();

/**
 * POST — Mail a requester the current link to their request (card 2158).
 *
 * Body: `{ email }`, the address the request was made with, or, for one made
 * signed in, the account's email as it is now. Asked for from the
 * page a link that no longer works opens: every request's link was replaced
 * once by migration 0055, and is replaced again by every restore.
 *
 * When the request is there and `email` is the address its mail goes to
 * (case and surrounding spaces ignored), its current link is mailed to that
 * address: the confirmation link for a request not yet confirmed, the
 * thread's link otherwise. The link goes nowhere else, so asking for it with
 * the right address gives nobody anything the mailbox's owner does not
 * already have. That address is `requesterAddress` (card 2171): for a
 * request made signed in, the account's email as it is now, and not the one
 * stored when the request was made, which may be somebody else's by now;
 * whoever gives that one is answered as for any wrong address.
 *
 * The answer tells nobody whether a request exists or whose it is. It is 202
 * with the same sentence for a wrong address, a request that is not there, an
 * id that is not a number, an unconfirmed request older than the form lets
 * one live, and a mail past a limit, as for a link that is sent. Everything a
 * match leads to, the limits counted, the mail settings read, the mail made
 * and handed on and the INFO line, is done after the answer (`setImmediate`,
 * the review's S3), so the answer does the same work either way, and is
 * given at about the same time. The only other answers come before any
 * request is looked up: 429 past five asks in 15 minutes from one address
 * (counted first, whatever is asked), 400 for a body with no `email` text,
 * and 503 when the server cannot send the link: no mail set up, a mail user
 * with no password (O6), or no address to make a link from. The 503 says so
 * in plain words for a requester, and its reason is a WARN line (O7).
 *
 * At most three new-link mails an hour go to one address, whichever requests
 * they are for (the plan review's R3), counted against the address the mail
 * goes to: anyone can make requests with somebody else's address, and a limit
 * per request would let them have the server mail that person three times an
 * hour for each. Counted only when a mail is about to be sent, after the
 * match, so wrong addresses, an account's old one among them, use up nobody's
 * three. A new link to a request not yet confirmed is a confirmation mail
 * too, and also counts against the public form's three an hour to that
 * address (`request-email:`), so that the two together send no more than
 * either; and at most 30 new-link mails an hour go out in all (S2), the
 * form's own figure for anonymous requests.
 *
 * Nothing is written. One INFO line when a link is mailed, naming the request
 * and not the address, and one WARN line for a 503, naming why. Public by its route id (`PUBLIC_ROUTES` in
 * hooks.server.ts).
 */
export const POST: RequestHandler = async ({ params, request, url, getClientAddress }) => {
	const asks = checkRateLimit(`request-link:${addressToCount({ getClientAddress })}`, ASKS_PER_ADDRESS, 15 * MINUTE);
	if (asks.limited) {
		throw error(429, `Too many requests. Try again in ${Math.ceil(asks.retryAfterSecs / 60)} minute(s).`);
	}

	const body = await readBody(request);
	const given = readText(body, 'email', { required: true, says: 'Enter the email address you made the request with' });

	// Before anything is looked up, so that these answers say nothing of any
	// request. The requester is told in plain words, and why is the
	// superadmin's to read in the log (O7).
	const cannotSend: (why: string) => never = (why) => {
		log.warn(`A new link to a request was asked for, and none can be sent: ${why}.`);
		throw error(503, CANNOT_SEND);
	};
	if (!isSmtpConfigured()) cannotSend(NO_MAIL);
	// A link said to be sent that every mail fails to carry is worse than none (O6).
	if (smtpPasswordMissing()) cannotSend(NO_MAIL_PASSWORD);
	// The address a mailed link begins with is this server's configuration,
	// never what the request says: see linkBaseUrl.
	const baseUrl = linkBaseUrl(url);
	if (baseUrl === null) cannotSend(NO_LINK_ADDRESS);

	// An id that is not a number is no request, and is answered as one that is not there.
	const id = /^[1-9]\d{0,15}$/.test(params.id) ? Number(params.id) : null;
	const found = id === null ? undefined : db.select().from(taskRequests).where(eq(taskRequests.id, id)).get();

	// The address the request's mail goes to, which is the one the link goes
	// to and the one compared: the account's email as it is now for a request
	// made signed in (card 2171), the address given for one made without.
	const address = found ? requesterAddress(found) : null;
	const unconfirmed = found?.status === 'unverified';
	// One the form would have cleared by now is not there (R3).
	const tooOld = !!found && hasLapsed(found);

	if (found && address !== null && found.accessToken && !tooOld && comparable(given) === comparable(address)) {
		// After the answer (S3): see the comment above.
		const request = found;
		setImmediate(() => mailNewLink(request, address, unconfirmed, baseUrl));
	}

	return json({ message: ANSWER }, { status: 202 });
};

/**
 * Whether one more new-link mail may go to `address` (R3, S2): three an hour
 * to it; for a request not yet confirmed, within the form's three confirmation
 * mails an hour to it; and 30 an hour in all. Each is counted as it is asked,
 * and the first that is past its limit ends it. The count in all has a key
 * that no client address or mail address can make (the second review's N6):
 * not under `request-link:`, where the asks from each address are counted.
 */
function mayMail(address: string, unconfirmed: boolean): boolean {
	const to = comparable(address);
	if (checkRateLimit(`request-link-mail:${to}`, MAILS_PER_ADDRESS, 60 * MINUTE).limited) return false;
	if (unconfirmed && checkRateLimit(`request-email:${to}`, CONFIRMATIONS_PER_ADDRESS, 60 * MINUTE).limited) return false;
	return !checkRateLimit('request-link-mails-in-all', MAILS_IN_ALL, 60 * MINUTE).limited;
}

/**
 * Mail `request`'s current link to `address`, after the answer has gone: the
 * limits, the link, the mail and the INFO line. It never throws: nothing is
 * waiting for it, and a throw here would end the server.
 */
function mailNewLink(request: typeof taskRequests.$inferSelect, address: string, unconfirmed: boolean, baseUrl: string): void {
	try {
		if (!mayMail(address, unconfirmed)) return;
		const link = unconfirmed ? requestConfirmUrl(baseUrl, request) : requestReplyUrl(baseUrl, request);
		// Not awaited, as every notification is not.
		notifyRequesterNewLink(address, request.title, link, unconfirmed);
		log.info(`A new link to request ${request.id} was mailed to its requester's address`);
	} catch (err) {
		log.error(`A new link to request ${request.id} could not be mailed`, err);
	}
}
