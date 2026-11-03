import { json } from '@sveltejs/kit';
import { createPerson } from '$lib/server/people';
import { readBody } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/people — add a person to the people directory (administrators
 * only, card 2674): `createPerson` in `$lib/server/people`. `201`, the person
 * with their `groupIds`. There is no GET: the admin page's load reads the
 * directory.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireAdmin(locals.user);
	const body = await readBody(request);

	// Asked again of the account as it is now, in the transaction that writes
	// (card 2253): an administrator whose role was lowered meanwhile is refused.
	const person = writeAs(locals, (caller) => createPerson(caller, {}, body, { source: 'ui' }));
	return json(person, { status: 201 });
};
