import { error } from '@sveltejs/kit';
import { addressToCount } from '$lib/server/client-address';
import { readLinkPage, refuseWrongLink } from '$lib/server/decision-view';
import { DEAD_DECISION_LINK, tooManyWrongLinks } from '$lib/decision-words';
import type { PageServerLoad } from './$types';

/**
 * A decision's page for the holder of a personal link (card 2677, decisions
 * 3 to 9): a public route, where the token decides and nobody is signed in.
 * A browser that is signed in stays signed in as itself, and its account's
 * name is given to be shown, never acted on (decision 9).
 *
 * Any link that opens no decision (unknown, expired, revoked, or no longer
 * reaching its holder) is the one 404, `DEAD_DECISION_LINK`, counted against
 * the caller's address; past the limit it is a 429, whose wait is given in
 * words, as an error page carries no header of the load's (decision 8). A
 * link that works is never counted. The load writes nothing: having seen it
 * is posted by the page, after the person's first action (decision 14).
 */
export const load: PageServerLoad = async ({ params, locals, getClientAddress }) => {
	const page = readLinkPage(params.token, locals.user?.username ?? null);
	if (page !== null) return page;
	const { limited, retryAfterSecs } = refuseWrongLink(addressToCount({ getClientAddress }));
	if (limited) error(429, tooManyWrongLinks(retryAfterSecs));
	error(404, DEAD_DECISION_LINK);
};
