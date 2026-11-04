import { json } from '$lib/server/v1-json';
import { updateGroup } from '$lib/server/people';
import { pathId, readBody } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PATCH /api/v1/people-groups/:groupId — change a group's `description`
 * (card 2681), administrators' keys only (403 `Admin access required`, D19).
 *
 * `name` is refused 403 whatever it holds (plan D17): a group's name is how
 * an author ticks it on a decision, and renaming one is the People page's.
 * The service refuses it by this route's word and by the key the write was
 * let in with (`writingWithKey()`, D18). Deleting a group is not offered here
 * (D11): its memberships could not be rebuilt.
 *
 * The answer is the group with the ids of its people, marked `untrusted`
 * (D6); the change is logged with the description it replaced (D7). The work
 * is `updateGroup` in `$lib/server/people`.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	requireAdmin(locals.user, 'Admin access required');
	const id = pathId(params.groupId, 'group');
	const body = await readBody(request);

	// The caller asked again, the group read and the change written in one transaction (card 2253).
	const group = writeAs(locals, (caller) => updateGroup(caller, { groupId: id }, body, { source: 'api', says: 'Admin access required' }));
	return json(group);
};
