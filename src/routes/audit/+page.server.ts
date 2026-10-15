import { redirect } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/board-access';
import { db } from '$lib/server/db';
import { boards, users } from '$lib/server/db/schema';
import type { PageServerLoad } from './$types';

// Admin-only. ADMIN_ROUTES in hooks.server.ts turns everyone else away before
// this runs, with the same two redirects, and it is asked again here: this
// load hands back every board's and every user's name, and the gate was once
// the only thing in front of it and was got round.
// Supplies the filter dropdowns and username resolution for the page.
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	if (!isAdmin(locals.user)) throw redirect(303, '/');

	const allBoards = db.select({ id: boards.id, name: boards.name, emoji: boards.emoji }).from(boards).all();
	const allUsers = db.select({ id: users.id, username: users.username, emoji: users.emoji }).from(users).all();
	return { allBoards, allUsers };
};
