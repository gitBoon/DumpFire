import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { deleteSession, clearSessionCookie, SESSION_COOKIE_NAME } from '$lib/server/auth';

export const load: PageServerLoad = async ({ cookies }) => {
	const token = cookies.get(SESSION_COOKIE_NAME);
	if (token) {
		deleteSession(token);
		clearSessionCookie(cookies);
	}
	throw redirect(303, '/login');
};
