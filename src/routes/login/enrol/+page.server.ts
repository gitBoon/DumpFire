import { error, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { addressOf, addressToCount } from '$lib/server/client-address';
import { deleteChallengeCookie, readChallengeToken } from '$lib/server/sign-in-challenges';
import { NO_MFA_KEY, enrolCode, enrolConfirm, enrolView } from '$lib/server/second-step';

/**
 * Setting up two-step sign-in (card 2769): the QR code and the secret, the
 * first code, then the ten recovery codes and a confirm, against the enrol
 * challenge a right password, an invite or the first-run set-up opened. The
 * challenge is named by its cookie alone, read from the raw header; with no
 * live one, the browser is sent to sign in.
 *
 * But not after a form was posted without JavaScript (the review's CR1):
 * SvelteKit then draws the page with the action's answer, and runs this
 * first, when the challenge may already be taken (signed in, with the report
 * of decision 16) or ended (the restart words). A POST is answered with the
 * stage `ended`, or `unavailable`, and the page shows the action's answer.
 */
export const load: PageServerLoad = async ({ locals, request, url, cookies }) => {
	if (locals.user) redirect(303, '/');
	const view = enrolView(readChallengeToken(request, url));
	const posted = request.method === 'POST';
	if (view === null) {
		if (posted) return { stage: 'ended' as const };
		deleteChallengeCookie(cookies, url);
		redirect(303, '/login');
	}
	// What the challenge keeps cannot be opened without the MFA key (decision 28).
	if (view.stage === 'unavailable' && !posted) error(503, NO_MFA_KEY);
	return view;
};

export const actions: Actions = {
	// The form is the one thing awaited in each: everything from reading the
	// challenge to moving or taking it is synchronous (decision 6).
	code: async ({ request, url, cookies, getClientAddress }) => {
		const form = await request.formData();
		return enrolCode(
			{
				token: readChallengeToken(request, url),
				code: form.get('code'),
				address: addressOf({ getClientAddress })?.slice(0, 100) ?? null,
				countedAs: addressToCount({ getClientAddress })
			},
			cookies,
			url
		);
	},
	confirm: async ({ request, url, cookies, getClientAddress }) => {
		// No field is read, but the body is: one that is not a form is refused.
		await request.formData();
		return enrolConfirm(
			{
				token: readChallengeToken(request, url),
				address: addressOf({ getClientAddress })?.slice(0, 100) ?? null,
				countedAs: addressToCount({ getClientAddress })
			},
			cookies,
			url
		);
	}
};
