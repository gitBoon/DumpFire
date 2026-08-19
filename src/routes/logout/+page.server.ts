import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { deleteSession, clearSessionCookie, SESSION_COOKIE_NAME } from '$lib/server/auth';

// GET must stay side-effect free: link preloading (data-sveltekit-preload-data),
// browser URL-bar prediction, and tab restore all hit this route with the
// session cookie attached. Only the POST action below may end the session.
export const load: PageServerLoad = async () => {
	throw redirect(303, '/');
};

export const actions: Actions = {
	default: async ({ cookies }) => {
		const token = cookies.get(SESSION_COOKIE_NAME);
		if (token) {
			deleteSession(token);
			clearSessionCookie(cookies);
		}
		throw redirect(303, '/login');
	}
};
