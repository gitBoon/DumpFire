import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { eq } from 'drizzle-orm';
import { deleteSession, clearSessionCookie, SESSION_COOKIE_NAME } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { rememberBrowser } from '$lib/server/known-browsers';
import { createLogger } from '$lib/server/logger';

const log = createLogger('AUTH');

// GET must stay side-effect free: link preloading (data-sveltekit-preload-data),
// browser URL-bar prediction, and tab restore all hit this route with the
// session cookie attached. Only the POST action below may end the session.
export const load: PageServerLoad = async ({ request, locals, getClientAddress }) => {
	let ip: string | null = null;
	try { ip = getClientAddress(); } catch { /* unavailable */ }
	// Recorded to expose preloaders/prefetchers when investigating logout reports
	log.info('GET /logout hit — no-op (preload/prefetch or direct visit)', {
		userAgent: request.headers.get('user-agent') || 'unknown'
	}, { userId: locals.user?.id ?? null, ip });

	throw redirect(303, '/');
};

export const actions: Actions = {
	default: async ({ cookies, request, locals, getClientAddress }) => {
		let ip: string | null = null;
		try { ip = getClientAddress(); } catch { /* unavailable */ }

		const token = cookies.get(SESSION_COOKIE_NAME);
		if (token) {
			// A browser that signs out is a browser that signed in, and is
			// remembered for the account (card 2194, the review's R5), with
			// the account's hash read before the session ends: so that a browser
			// signed in since before remembered browsers were, and signed out
			// before its next sign-in, is not then a stranger. Only for an
			// open session, which is what `locals.user` is here.
			if (locals.user) {
				const account = db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, locals.user.id)).get();
				if (account) rememberBrowser(cookies, locals.user.id, account.passwordHash);
			}
			deleteSession(token, 'user logout');
			clearSessionCookie(cookies);
		}

		log.info('User logged out', {
			userAgent: request.headers.get('user-agent') || 'unknown'
		}, { userId: locals.user?.id ?? null, ip });

		throw redirect(303, '/login');
	}
};
