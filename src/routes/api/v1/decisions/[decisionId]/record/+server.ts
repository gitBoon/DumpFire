import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { readRecord, RECORD_PAGE_SIZE, RECORD_READ_MAX } from '$lib/server/decision-register';
import { pathId, readQueryId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/decisions/:decisionId/record — a decision's permanent record
 * (card 2682, D15): its decider's and administrators' (404, then 403). Every
 * event, oldest first, a page at a time: `limit` (a whole number from 1 to
 * 5,000; 500 when not sent), `after` (the `next` of the page before) and
 * `participant` (one of its participant rows). Each is read and bounded here,
 * before anything is read, and a malformed one is a 400 naming it.
 *
 * Through a key the record shows no administrator-only detail (an address
 * change's addresses, a signed-in account) to anyone, administrators
 * included (D9); the four question events are left out of every page,
 * filtered or not, so that nothing says who asked a question (D31, code
 * review S1): `GET …/questions` reads the questions with no asker; and each
 * entry and the page are marked `untrusted` (D10). `readRecord` in
 * `$lib/server/decision-register`.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const user = requireUser(locals.user);
	const id = pathId(params.decisionId, 'decision');

	const asked = url.searchParams.get('limit');
	const limit = asked === null || asked === '' ? RECORD_PAGE_SIZE : /^\d+$/.test(asked) ? Number(asked) : NaN;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > RECORD_READ_MAX) error(400, `limit must be a whole number from 1 to ${RECORD_READ_MAX}`);
	const participant = readQueryId(url.searchParams.get('participant'), 'participant') ?? null;
	const after = readQueryId(url.searchParams.get('after'), 'after', 'after must be a whole number of 1 or more') ?? null;

	return json(readRecord(user, id, { participant, after }, { source: 'api', limit }));
};
