import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	// Reset auto-increment counters
	sqlite.exec('DELETE FROM sqlite_sequence');
	// VACUUM must run outside WAL mode on same connection
	// This reclaims space and optimises the database
	sqlite.exec('VACUUM');
	return json({ success: true });
};
