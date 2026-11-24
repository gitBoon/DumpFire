import { error, json } from '@sveltejs/kit';
import { clearSessionCookie, sessionHashIn, whilePasswordHolds } from '$lib/server/auth';
import { readBody } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { refuseOwnSetUp, startOwnSetUp } from '$lib/server/second-step';
import { readChallengeToken, setChallengeCookie } from '$lib/server/sign-in-challenges';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import { createLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = createLogger('AUTH');

/**
 * POST — Set up two-step sign-in for the caller's own account, while two-step
 * sign-in is dormant (card 3064, R8, F2).
 *
 * Asks for the current password through the step-up (`currentPassword`; a
 * code is not asked of an account that holds no factor while dormant, R6).
 * Refused first, with nothing counted: the account already holds a factor
 * (409), two-step sign-in is required (409: it is set up at sign-in then), or
 * no MFA key is loaded (503). The write asks all three again, held to the
 * password checked, and then, together: a set-up challenge of grant `account`
 * on that password, and the caller's session ended, so that `/login/enrol`
 * serves the browser. After the commit: the challenge's cookie set and the
 * session's cleared, and `{ next: '/login/enrol' }`. The set-up pages then run
 * as for any set-up: the QR code, the first code, the ten recovery codes, and
 * a confirm that makes a session with a code. Set up, the account is asked for
 * a code at every sign-in and step-up, and its sessions made on a password
 * alone are refused (R5). Abandoned, the person is signed out with their
 * password working as before.
 */
export const POST: RequestHandler = async ({ request, locals, cookies, url }) => {
	requireUser(locals.user);

	const body = await readBody(request);

	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/account/two-step/set-up', (caller) => {
		refuseOwnSetUp(requireUser(caller).id);
	});

	// The session the step-up counted on: the one this set-up ends.
	const session = sessionHashIn(locals.credential);
	if (!session) error(401, 'Not authenticated');
	const previousToken = readChallengeToken(request, url);

	const issued = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => startOwnSetUp(requireUser(caller).id, hash, previousToken, session)));

	setChallengeCookie(cookies, url, issued.token);
	clearSessionCookie(cookies, url);
	log.info(`Second step issued (enrol) for user ${issued.userId} from the Account page, challenge ${issued.shortId}: the session was ended`, undefined, {
		userId: issued.userId
	});

	return json({ next: '/login/enrol' }, { headers: { 'Cache-Control': 'no-store' } });
};
