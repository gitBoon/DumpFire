import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	// The id counters (`sqlite_sequence`) are left alone. They used to be
	// deleted here, so the next card got an id a deleted card had had, and
	// whatever still named the old one by id was taken to name the new one.
	//
	// VACUUM cannot run inside a transaction, so this is not in one.
	// This reclaims space and optimises the database
	sqlite.exec('VACUUM');
	return json({ success: true });
};
