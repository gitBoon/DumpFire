import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** POST — restore a card from archive by ID */
export const POST: RequestHandler = async ({ params }) => {
	const cardId = Number(params.id);

	const updated = db.update(cards)
		.set({ archivedAt: null, updatedAt: new Date().toISOString() })
		.where(eq(cards.id, cardId))
		.returning()
		.get();

	if (!updated) throw error(404, 'Card not found');
	return json(updated);
};
