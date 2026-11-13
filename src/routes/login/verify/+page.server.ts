import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { addressOf, addressToCount } from '$lib/server/client-address';
import { deleteChallengeCookie, readChallengeToken } from '$lib/server/sign-in-challenges';
import { verifyStep, verifyView } from '$lib/server/second-step';

/**
 * The second step of signing in (card 2769): the code of the authenticator
 * an account holds, or one of its recovery codes, against the challenge its
 * right password opened. The challenge is named by its cookie alone, read
 * from the raw header; with no live one, the browser is sent to sign in.
 *
 * But not after the form was posted without JavaScript (the review's CR1):
 * SvelteKit then draws the page with the action's answer, and runs this
 * first, when the challenge may already be taken (signed in, with the report
 * of decision 16) or ended (the restart words). Sent away, the answer would
 * be lost; so a POST is answered with no account named, and the page shows
 * the action's answer alone. The session the action made is in the response
 * only, so the hooks did not see it on the way in.
 */
export const load: PageServerLoad = async ({ locals, request, url, cookies }) => {
	if (locals.user) redirect(303, '/');
	const view = verifyView(readChallengeToken(request, url));
	if (view !== null) return view;
	if (request.method === 'POST') return { username: null, codesNotice: null, codesLocked: false };
	deleteChallengeCookie(cookies, url);
	redirect(303, '/login');
};

export const actions: Actions = {
	// The form is the one thing awaited: everything from reading the
	// challenge to taking it is `verifyStep`, synchronous (decision 6).
	default: async ({ request, url, cookies, getClientAddress }) => {
		const form = await request.formData();
		return verifyStep(
			{
				token: readChallengeToken(request, url),
				code: form.get('code'),
				recoveryCode: form.get('recoveryCode'),
				address: addressOf({ getClientAddress })?.slice(0, 100) ?? null,
				countedAs: addressToCount({ getClientAddress })
			},
			cookies,
			url
		);
	}
};
