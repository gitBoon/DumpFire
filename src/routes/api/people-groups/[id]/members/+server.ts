import { json } from '@sveltejs/kit';
import { setGroupMembers } from '$lib/server/people';
import { pathId, readBody } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/people-groups/:id/members — set who is in a group, `personIds`
 * replacing the set held (administrators only, card 2674): `setGroupMembers`.
 * The answer is the group with its `personIds`.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireAdmin(locals.user);
	const id = pathId(params.id, 'group');
	const body = await readBody(request);

	// The group and the people read, the caller asked again and the set replaced in one transaction (card 2253).
	const group = writeAs(locals, (caller) => setGroupMembers(caller, { groupId: id }, body, { source: 'ui' }));
	return json(group);
};
