import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** GET /api/v1/me — Returns the authenticated user's profile info. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	return json({
		id: locals.user.id,
		username: locals.user.username,
		email: locals.user.email,
		emoji: locals.user.emoji,
		role: locals.user.role
	});
};
