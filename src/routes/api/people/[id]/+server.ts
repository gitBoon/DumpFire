import { json } from '@sveltejs/kit';
import { deletePerson, updatePerson } from '$lib/server/people';
import { pathId, readBody } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/people/:id — change a person: any of `fullName`, `email`,
 * `jobTitle`, `userId`, `status` and `groupIds` (administrators only, card
 * 2674). `updatePerson` in `$lib/server/people`; the answer is the person.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	requireAdmin(locals.user);
	const id = pathId(params.id, 'person');
	const body = await readBody(request);

	// The person read, the caller asked again and the change written in one
	// transaction (card 2253).
	const person = writeAs(locals, (caller) => updatePerson(caller, { personId: id }, body, { source: 'ui' }));
	return json(person);
};

/**
 * DELETE /api/people/:id — delete a person (administrators only, card 2674,
 * decision 3): `deletePerson`. Their decision links are emptied first, and
 * the answer says how many.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireAdmin(locals.user);
	const id = pathId(params.id, 'person');

	const { linksCleared } = writeAs(locals, (caller) => deletePerson(caller, { personId: id }, null, { source: 'ui' }));
	return json({ success: true, linksCleared });
};
