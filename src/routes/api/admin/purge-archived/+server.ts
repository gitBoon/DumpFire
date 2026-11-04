/**
 * Purge Archived Cards — permanently delete all archived cards from the database.
 *
 * POST /api/admin/purge-archived
 * Admin/superadmin only, with their current password (card 2701):
 * `{ currentPassword }`.
 */

import { json } from '@sveltejs/kit';
import { whilePasswordHolds } from '$lib/server/auth';
import { purgeArchivedCards } from '$lib/server/deletes';
import { readBody } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	requireAdmin(locals.user);
	const body = await readBody(request);

	// The caller's password, asked for again: deleted cards cannot be brought
	// back. Asked after every refusal that needs none, before the transaction
	// (step-up.ts).
	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/admin/purge-archived', requireAdmin);

	// One transaction, in which the archived cards are found and deleted with
	// their dependency links, their sub-boards and everything on those. It asks
	// first whether the session is still open and who its account is now (card
	// 2253); `purgeArchivedCards`'s own transaction is a part of it. It runs
	// only while the stored hash is the one the password was checked against.
	// The files of their attachments go to the trash once it is committed. See
	// $lib/server/deletes.ts.
	const { purged } = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => purgeArchivedCards(requireAdmin(caller))));

	return json({ success: true, purged });
};
