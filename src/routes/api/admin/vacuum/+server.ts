import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
	// Reset auto-increment counters
	sqlite.exec('DELETE FROM sqlite_sequence');
	// VACUUM must run outside WAL mode on same connection
	// This reclaims space and optimises the database
	sqlite.exec('VACUUM');
	return json({ success: true });
};
