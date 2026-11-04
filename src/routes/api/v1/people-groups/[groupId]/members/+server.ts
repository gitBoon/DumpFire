import { json } from '$lib/server/v1-json';
import { setGroupMembers } from '$lib/server/people';
import { pathId, readBody } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/v1/people-groups/:groupId/members — set who is in a group:
 * `personIds`, 0 to 5,000 people who all exist, replacing the set held (card
 * 2681). Administrators' keys only (403 `Admin access required`, D19).
 *
 * The set replaced is logged, so that an administrator can put it back from
 * the system log (plan D7). The answer is the group with its new set, marked
 * `untrusted` (D6), and no person's address or account id (D4). The work is
 * `setGroupMembers` in `$lib/server/people`, which also refuses, by the key
 * the write was let in with, what a key may never do (D18).
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireAdmin(locals.user, 'Admin access required');
	const id = pathId(params.groupId, 'group');
	const body = await readBody(request);

	// The caller asked again, the group read and the set replaced in one transaction (card 2253).
	const group = writeAs(locals, (caller) => setGroupMembers(caller, { groupId: id }, body, { source: 'api', says: 'Admin access required' }));
	return json(group);
};
