import { json } from '$lib/server/v1-json';
import { createGroup, listPeopleGroups } from '$lib/server/people';
import { readBody } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/people-groups — every group of the people directory, by name,
 * each with the ids of its people, left people included (card 2681).
 * Administrators' keys only (403 `Admin access required`, plan D5, D19). Every
 * item is marked `untrusted: true` (D6). The read is `listPeopleGroups`.
 */
export const GET: RequestHandler = async ({ locals }) => {
	return json(listPeopleGroups(locals.user, {}, { says: 'Admin access required' }));
};

/**
 * POST /api/v1/people-groups — make a group: `name`, 1 to 100 characters,
 * used by no other group in any case (409), and `description`, up to 1,000
 * (card 2681). A key names a group only as it makes it: renaming one is the
 * People page's (D17). The answer is the group with no people yet, marked
 * `untrusted`; the line logged says it came through the API (D7). The work is
 * `createGroup` in `$lib/server/people`.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireAdmin(locals.user, 'Admin access required');
	const body = await readBody(request);

	// The caller asked again and the group written in one transaction (card 2253).
	const group = writeAs(locals, (caller) => createGroup(caller, {}, body, { source: 'api', says: 'Admin access required' }));
	return json(group, { status: 201 });
};
