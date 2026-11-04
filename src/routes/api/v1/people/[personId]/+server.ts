import { json } from '$lib/server/v1-json';
import { updatePerson } from '$lib/server/people';
import { pathId, readBody } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PATCH /api/v1/people/:personId — change a person's `jobTitle` and
 * `groupIds` (card 2681), administrators' keys only (403 `Admin access
 * required`, D19). A field left out is kept; a value sent back as stored
 * changes nothing (D10).
 *
 * `email`, `userId`, `status` and `fullName` are refused 403 whatever they
 * hold (plan D2, D3, D17): an address or an account decides where a
 * decision's mail and personal links go, and the People page asks a password
 * to change one, which a key cannot give; marking a person left ends every
 * link they hold; a name is how an author ticks a person. The service refuses
 * them by this route's word and by the key the write was let in with
 * (`writingWithKey()`, D18). Deleting a person is not offered here (D2).
 *
 * The answer is the person with no address and no account id, marked
 * `untrusted` (D4, D6). The change is logged with the values it replaced (D7).
 * The work is `updatePerson` in `$lib/server/people`.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	requireAdmin(locals.user, 'Admin access required');
	const id = pathId(params.personId, 'person');
	const body = await readBody(request);

	// The caller asked again, the person read and the change written in one transaction (card 2253).
	const person = writeAs(locals, (caller) => updatePerson(caller, { personId: id }, body, { source: 'api', says: 'Admin access required' }));
	return json(person);
};
