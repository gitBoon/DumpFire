import { json } from '@sveltejs/kit';
import { whilePasswordHolds } from '$lib/server/auth';
import { deletePerson, personDeleteGuard, personUpdateGuard, updatePerson } from '$lib/server/people';
import { pathId, readBody } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/people/:id — change a person: any of `fullName`, `email`,
 * `jobTitle`, `userId`, `status` and `groupIds` (administrators only, card
 * 2674). `updatePerson` in `$lib/server/people`; the answer is the person.
 *
 * A body that carries `email` or `userId`, whatever its value (`null`, an
 * unlink, among them), asks for the caller's own password again, in
 * `currentPassword` (card 2697, Q21; step-up.ts): opening a decision takes
 * every participant's address and account from the directory, and a personal
 * link is mailed only while the participant's address is the directory's, so
 * these decide where a decision's record mail and links go. So does a body
 * that carries `status` with any value but the exact string `'left'` (card
 * 3020, R6): marking a person active lets them be mailed again, at an address
 * a backup whose seal did not verify may have chosen. It fails closed: only an
 * absent `status`, or a literal `'left'`, asks nothing extra. Every refusal of
 * the change is made first (`personUpdateGuard`), with no password checked or
 * counted, and only this branch passes `steppedUp`, without which the service
 * refuses Mark active itself. Any other body (a rename, a job title, groups,
 * Mark left) asks for none, as `PUT /api/users/[id]` decides by its keys.
 */
export const PUT: RequestHandler = async ({ params, request, locals, cookies }) => {
	requireAdmin(locals.user);
	const id = pathId(params.id, 'person');
	const body = await readBody(request);

	const asks = Object.hasOwn(body, 'email') || Object.hasOwn(body, 'userId') || (Object.hasOwn(body, 'status') && body.status !== 'left');
	if (!asks) {
		// The person read, the caller asked again and the change written in one
		// transaction (card 2253).
		const person = writeAs(locals, (caller) => updatePerson(caller, { personId: id }, body, { source: 'ui' }));
		return json(person);
	}

	// An address, an account or Mark active: the caller's password, once every
	// refusal that needs none has been made.
	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'PUT /api/people/[id]', (caller) =>
		personUpdateGuard(caller, { personId: id }, body, { steppedUp: true })
	);

	// One transaction, as above, run only while the caller's stored hash is the
	// one their password was checked against.
	const person = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => updatePerson(caller, { personId: id }, body, { source: 'ui', steppedUp: true })));
	return json(person);
};

/**
 * DELETE /api/people/:id — delete a person (administrators only, card 2674,
 * decision 3): `deletePerson`. Their decision links are emptied first, and
 * the answer says how many.
 *
 * It asks for the caller's own password again, in `currentPassword` (card
 * 2697's code review, part B, S1): the delete ends every personal link the
 * person holds and frees their address for another person. Every refusal is
 * made first (`personDeleteGuard`), with no password checked or counted.
 */
export const DELETE: RequestHandler = async ({ params, request, locals, cookies }) => {
	requireAdmin(locals.user);
	const id = pathId(params.id, 'person');
	const body = await readBody(request);

	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'DELETE /api/people/[id]', (caller) => personDeleteGuard(caller, { personId: id }));

	const { linksCleared } = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => deletePerson(caller, { personId: id }, null, { source: 'ui' })));
	return json({ success: true, linksCleared });
};
