import { db } from '$lib/server/db';
import { boards, users } from '$lib/server/db/schema';
import type { PageServerLoad } from './$types';

// Admin-only — enforced by ADMIN_ROUTES in hooks.server.ts.
// Supplies the filter dropdowns and username resolution for the page.
export const load: PageServerLoad = async () => {
	const allBoards = db.select({ id: boards.id, name: boards.name, emoji: boards.emoji }).from(boards).all();
	const allUsers = db.select({ id: users.id, username: users.username, emoji: users.emoji }).from(users).all();
	return { allBoards, allUsers };
};
