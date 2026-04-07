import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardTemplates } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** DELETE — remove a template */
export const DELETE: RequestHandler = async ({ params }) => {
	const id = Number(params.id);
	const existing = db.select().from(cardTemplates).where(eq(cardTemplates.id, id)).get();
	if (!existing) throw error(404, 'Template not found');
	db.delete(cardTemplates).where(eq(cardTemplates.id, id)).run();
	return json({ success: true });
};
