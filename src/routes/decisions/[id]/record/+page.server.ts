import { error } from '@sveltejs/kit';
import { readRecord, RECORD_PAGE_SIZE } from '$lib/server/decision-register';
import { readQueryIdOrNone } from '$lib/server/request-body';
import type { PageServerLoad } from './$types';

/**
 * A decision's record view (card 2680, decision 16): every event of the
 * decision, oldest first, 500 a page by `after`, filtered to one of its
 * participants by `participant`. `readRecord` guards itself with
 * `requireDecision(…, 'record')`: administrators and the decider, with board
 * edit while the board exists; 403 for anyone else who may view it, 404 for
 * anyone else. A path that is not a whole number above 0 is 404 before
 * anything is read (decision 34); a malformed `participant` or `after` is
 * dropped. The load writes nothing.
 */
export const load: PageServerLoad = async ({ params, url, locals }) => {
	const id = readQueryIdOrNone(params.id);
	if (id === undefined) error(404, 'Decision not found');
	const participant = readQueryIdOrNone(url.searchParams.get('participant')) ?? null;
	const after = readQueryIdOrNone(url.searchParams.get('after')) ?? null;
	// `after` as read, for the page's Back to the start.
	return { ...readRecord(locals.user!, id, { participant, after }, { source: 'ui', limit: RECORD_PAGE_SIZE }), after };
};
