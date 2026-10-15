import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	// Everybody's XP or nobody's.
	inTransaction(() => {
		sqlite.prepare('UPDATE user_xp SET xp = 0').run();
	});
	return json({ success: true });
};
