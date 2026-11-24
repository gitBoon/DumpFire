import { error, json } from '@sveltejs/kit';
import { sessionHashIn, whilePasswordHolds } from '$lib/server/auth';
import { readBody } from '$lib/server/request-body';
import { requireSuperadmin } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { refuseRequiring, requireTwoStep, twoStepRequiredLine } from '$lib/server/two-step-switch';
import { writeAs } from '$lib/server/write-as';
import { createLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = createLogger('AUTH');

/**
 * POST — Require two-step sign-in on this server (card 3064, R10: event E3).
 *
 * The superadmin's alone, with the current password and a code
 * (`currentPassword`, `currentCode`) through the step-up. Refused 409 first,
 * with nothing counted or written (`refuseRequiring`): two-step sign-in is
 * already required; the caller holds no factor; the session asked from was
 * not made with a code; the superadmin or an enabled administrator holds no
 * factor, each named (S-L7). The write asks them all again, held to the
 * password checked, and then, in one transaction (`requireTwoStep`): the
 * switch and `two_step_released_at` now, the accounts with no factor and no
 * enrolment link marked to set up on their password for 14 days where mail
 * was never set up, and every session made on a password alone ended (the
 * caller's, made with a code, is kept). After the commit, one CRITICAL line,
 * kept for good. One way: no route turns it off (R11).
 */
export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	requireSuperadmin(locals.user);

	const body = await readBody(request);

	// The session the step-up counts on: the one that must have been made with a code.
	const session = sessionHashIn(locals.credential);
	if (!session) error(401, 'Not authenticated');

	const { actor, userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/admin/two-step/require', (caller) => {
		const me = requireSuperadmin(caller);
		refuseRequiring(me.id, session);
		return me;
	});

	const done = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => requireTwoStep(requireSuperadmin(caller).id, session)));

	log.critical(twoStepRequiredLine(actor, done), { sessionsEnded: done.sessionsEnded, accountsMarked: done.accountsMarked }, { userId: actor.id });

	return json({ success: true, requiredAt: done.at, sessionsEnded: done.sessionsEnded, accountsMarked: done.accountsMarked });
};
