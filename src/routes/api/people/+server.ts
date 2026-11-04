import { json } from '@sveltejs/kit';
import { whilePasswordHolds } from '$lib/server/auth';
import { createPerson, personCreateGuard } from '$lib/server/people';
import { readBody } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * POST /api/people — add a person to the people directory (administrators
 * only, card 2674): `createPerson` in `$lib/server/people`. `201`, the person
 * with their `groupIds`. There is no GET: the admin page's load reads the
 * directory.
 *
 * It asks for the caller's own password again, in `currentPassword` (card
 * 2697's code review, part B, S1; step-up.ts): a person's address and
 * account decide where a decision's record mail and personal links go, and
 * `email` is required, so every body that can make a person sets one. Every
 * refusal of the add is made first (`personCreateGuard`), a body with no
 * address among them, with no password checked or counted.
 */
export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	requireAdmin(locals.user);
	const body = await readBody(request);

	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/people', (caller) => personCreateGuard(caller, {}, body));

	// Asked again of the account as it is now, in the transaction that writes
	// (card 2253), and run only while the caller's stored hash is the one their
	// password was checked against.
	const person = await whilePasswordHolds(userId, hash, () => writeAs(locals, (caller) => createPerson(caller, {}, body, { source: 'ui' })));
	return json(person, { status: 201 });
};
