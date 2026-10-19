import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { requireAdmin } from '$lib/server/route-guards';
import { stillCallerNow } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	// An administrator or the superadmin, asked first of the session as it is
	// now (card 2253): VACUUM cannot run inside writeAs's transaction, so it is
	// asked in one of its own, with nothing between it and the VACUUM.
	requireAdmin(stillCallerNow(locals));

	// The id counters (`sqlite_sequence`) are left alone. They used to be
	// deleted here, so the next card got an id a deleted card had had, and
	// whatever still named the old one by id was taken to name the new one.
	//
	// VACUUM cannot run inside a transaction, so this is not in one.
	// This reclaims space and optimises the database
	sqlite.exec('VACUUM');
	return json({ success: true });
};
