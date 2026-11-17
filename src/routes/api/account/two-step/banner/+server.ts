import { json } from '@sveltejs/kit';
import { whilePasswordHolds } from '$lib/server/auth';
import { dismissable, dismissBanner } from '$lib/server/account-two-step';
import { readBody, readText } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * DELETE — That was me: clear the warning at the top of the Account page that
 * someone entered the caller's password and then a wrong code, or did not
 * finish signing in (card 2772, D6).
 *
 * Asks for the current password and a code (`currentPassword`,
 * `currentCode`), through the step-up: whoever holds a session alone must not
 * hide the warning from its owner. `bannerAt` is the moment of the latest
 * signal the page showed (`banner.latestAt`: `security_signal_last_at`, which
 * every signal sets, even one inside the hour that raises no new banner; card
 * 2772's code review, CS1). Refused first, with nothing counted: no warning
 * (409), or a later signal than the page showed (409 "A newer warning
 * arrived…", S3). The write clears the banner, its time and the latest
 * signal's only if that is still the one shown, compared and cleared in one
 * statement.
 */
export const DELETE: RequestHandler = async ({ request, locals, cookies }) => {
	requireUser(locals.user);

	const body = await readBody(request);
	const bannerAt = readText(body, 'bannerAt', { required: true });

	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'DELETE /api/account/two-step/banner', (caller) => {
		dismissable(requireUser(caller).id, bannerAt);
	});

	await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => {
			dismissBanner(requireUser(caller).id, bannerAt);
		}));

	return json({ success: true });
};
