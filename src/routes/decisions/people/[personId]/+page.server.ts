import { error } from '@sveltejs/kit';
import { readPersonRecord } from '$lib/server/decision-register';
import { readQueryIdOrNone } from '$lib/server/request-body';
import type { PageServerLoad } from './$types';

/**
 * One person's record of what they were asked and what they said (card 2680,
 * decisions 9 to 15), as the caller's audience is given it: an
 * administrator's of anyone, a decider's of their own decisions, and the
 * person's own. A path that is not a whole number above 0 is 404 before
 * anything is read (decision 34); a person who is not there, a deleted one
 * and one outside the caller's scope are the same 404, with the same words
 * (S5). `before` pages by participation, newest first; a malformed one is
 * dropped. The load writes nothing.
 */
export const load: PageServerLoad = async ({ params, url, locals }) => {
	const personId = readQueryIdOrNone(params.personId);
	if (personId === undefined) error(404, 'Person not found');
	const before = readQueryIdOrNone(url.searchParams.get('before')) ?? null;
	// `before` as read, for the page's Back to newest.
	return { ...readPersonRecord(locals.user!, personId, { before }, { source: 'ui' }), personId, before };
};
