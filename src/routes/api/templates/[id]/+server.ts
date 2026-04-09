import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardTemplates } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** DELETE — remove a template (only creator or admin) */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	const existing = db.select().from(cardTemplates).where(eq(cardTemplates.id, id)).get();
	if (!existing) throw error(404, 'Template not found');

	// Only the creator or admins can delete templates
	const isAdmin = locals.user.role === 'admin' || locals.user.role === 'superadmin';
	if (existing.createdBy !== locals.user.id && !isAdmin) {
		throw error(403, 'You can only delete your own templates');
	}

	db.delete(cardTemplates).where(eq(cardTemplates.id, id)).run();
	return json({ success: true });
};
