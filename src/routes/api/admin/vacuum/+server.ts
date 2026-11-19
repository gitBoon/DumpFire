import { error, json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/route-guards';
import { stillCallerNow } from '$lib/server/write-as';
import { vacuumAndScrub } from '$lib/server/stored-secrets';
import { createLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = createLogger('STARTUP');

/** What Admin › Vacuum answers, with 503, when the scrub could not finish (card 2898's code review, E7, S5). */
const SCRUB_HELD_UP =
	'The database was compacted, but its write-ahead log is held by a reader, so the old text of the stored secrets is not ' +
	'yet scrubbed from it. The scrub stays pending and is tried again; run Vacuum again once nothing else is reading the database.';

export const POST: RequestHandler = async ({ locals }) => {
	// An administrator or the superadmin, asked first of the session as it is
	// now (card 2253): VACUUM cannot run inside writeAs's transaction, so it is
	// asked in one of its own, with nothing between it and the VACUUM.
	const caller = requireAdmin(stillCallerNow(locals));

	// The id counters (`sqlite_sequence`) are left alone. They used to be
	// deleted here, so the next card got an id a deleted card had had, and
	// whatever still named the old one by id was taken to name the new one.
	//
	// VACUUM cannot run inside a transaction, so this is not in one.
	// This reclaims space and optimises the database, and empties the
	// write-ahead log after it, which held the pages as they were (card 2898,
	// decision 14, S6): the scrub a start could not finish is done here.
	if (!vacuumAndScrub()) {
		log.error(`Admin › Vacuum could not scrub the stored secrets' old text: ${SCRUB_HELD_UP}`, undefined, { userId: caller.id });
		throw error(503, SCRUB_HELD_UP);
	}
	return json({ success: true });
};
