import { json } from '@sveltejs/kit';
import { deleteGroup, updateGroup } from '$lib/server/people';
import { pathId, readBody } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/people-groups/:id — rename a group or change its description
 * (administrators only, card 2674): `updateGroup`. The answer is the group.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireAdmin(locals.user);
	const id = pathId(params.id, 'group');
	const body = await readBody(request);

	// The group read, the caller asked again and the change written in one transaction (card 2253).
	const group = writeAs(locals, (caller) => updateGroup(caller, { groupId: id }, body, { source: 'ui' }));
	return json(group);
};

/**
 * DELETE /api/people-groups/:id — delete a group (administrators only, card
 * 2674, decision 4): `deleteGroup`. Its memberships go with it; the people stay.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireAdmin(locals.user);
	const id = pathId(params.id, 'group');

	writeAs(locals, (caller) => deleteGroup(caller, { groupId: id }, null, { source: 'ui' }));
	return json({ success: true });
};
