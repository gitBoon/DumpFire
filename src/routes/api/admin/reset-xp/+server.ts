import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { requireAdmin } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	requireAdmin(locals.user);

	// Everybody's XP or nobody's, by an administrator as the account is now
	// (card 2253).
	writeAs(locals, (caller) => {
		requireAdmin(caller);
		sqlite.prepare('UPDATE user_xp SET xp = 0').run();
	});
	return json({ success: true });
};
