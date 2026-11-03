import { json } from '@sveltejs/kit';
import { createGroup } from '$lib/server/people';
import { readBody } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/people-groups — add a group to the people directory
 * (administrators only, card 2674): `createGroup` in `$lib/server/people`.
 * `201`, the group.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireAdmin(locals.user);
	const body = await readBody(request);

	// Asked again of the account as it is now, in the transaction that writes (card 2253).
	const group = writeAs(locals, (caller) => createGroup(caller, {}, body, { source: 'ui' }));
	return json(group, { status: 201 });
};
