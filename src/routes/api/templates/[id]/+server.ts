import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardTemplates } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canEditBoard } from '$lib/server/board-access';
import { pathId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** DELETE — remove a template (only creator or admin) */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	const id = pathId(params.id, 'template');

	// One transaction: the template is read and the caller checked in the one
	// that deletes it, which asks first whether the session is still open, and
	// who its account is now (card 2253).
	writeAs(locals, (caller) => {
		const user = requireUser(caller);
		const existing = db.select().from(cardTemplates).where(eq(cardTemplates.id, id)).get();
		if (!existing) throw error(404, 'Template not found');

		// A template saved on a board is part of that board. Having made it is
		// not access to the board: someone taken off a board could go on
		// deleting the templates they had saved there. Edit access, which is
		// what saving one on the board asks for: someone made a viewer could
		// otherwise delete what they may no longer save. One saved on no board
		// is shared with everyone, and has no board to ask about. An
		// administrator can edit every board.
		if (existing.boardId !== null && !canEditBoard(user, existing.boardId)) {
			throw error(403, 'No edit access to this board');
		}

		// Only the creator or admins can delete templates
		const isAdmin = user.role === 'admin' || user.role === 'superadmin';
		if (existing.createdBy !== user.id && !isAdmin) {
			throw error(403, 'You can only delete your own templates');
		}

		db.delete(cardTemplates).where(eq(cardTemplates.id, id)).run();
	});
	return json({ success: true });
};
