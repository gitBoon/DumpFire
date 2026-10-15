/**
 * Purge Archived Cards — permanently delete all archived cards from the database.
 *
 * POST /api/admin/purge-archived
 * Admin/superadmin only.
 */

import { json, error } from '@sveltejs/kit';
import { purgeArchivedCards } from '$lib/server/deletes';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	// One transaction, in which the archived cards are found and deleted with
	// their dependency links, their sub-boards and everything on those. The
	// files of their attachments go to the trash once it is committed. See
	// $lib/server/deletes.ts.
	const { purged } = purgeArchivedCards(locals.user);

	return json({ success: true, purged });
};
