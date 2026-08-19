import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { deleteSession, clearSessionCookie, SESSION_COOKIE_NAME } from '$lib/server/auth';
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
			deleteSession(token, 'user logout');
			clearSessionCookie(cookies);
		}

		log.info('User logged out', {
			userAgent: request.headers.get('user-agent') || 'unknown'
		}, { userId: locals.user?.id ?? null, ip });

		throw redirect(303, '/login');
	}
};
