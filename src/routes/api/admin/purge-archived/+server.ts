/**
 * Purge Archived Cards — permanently delete all archived cards from the database.
 *
 * POST /api/admin/purge-archived
 * Admin/superadmin only.
 */

import { json } from '@sveltejs/kit';
import { purgeArchivedCards } from '$lib/server/deletes';
import { requireAdmin } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	requireAdmin(locals.user);

	// One transaction, in which the archived cards are found and deleted with
	// their dependency links, their sub-boards and everything on those. It asks
	// first whether the session is still open and who its account is now (card
	// 2253); `purgeArchivedCards`'s own transaction is a part of it. The files
	// of their attachments go to the trash once it is committed. See
	// $lib/server/deletes.ts.
	const { purged } = writeAs(locals, (caller) => purgeArchivedCards(requireAdmin(caller)));

	return json({ success: true, purged });
};
