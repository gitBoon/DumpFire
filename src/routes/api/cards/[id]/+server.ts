import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request }) => {
	const id = Number(params.id);
	const data = await request.json();
	const { boardId, ...updateData } = data;
	const updated = db
		.update(cards)
		.set({ ...updateData, updatedAt: new Date().toISOString() })
		.where(eq(cards.id, id))
		.returning()
		.get();
	if (!updated) throw error(404, 'Card not found');
	if (boardId) emit(boardId, 'update', { type: 'card' });
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, request, url }) => {
	const id = Number(params.id);
	const permanent = url.searchParams.get('permanent') === 'true';
	let boardId: number | undefined;
	try {
		const data = await request.json();
		boardId = data.boardId;
	} catch {}

	if (permanent) {
		db.delete(cards).where(eq(cards.id, id)).run();
	} else {
		// Soft-delete: move to archive
		db.update(cards)
			.set({ archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
			.where(eq(cards.id, id))
			.run();
	}
	if (boardId) emit(boardId, 'update', { type: 'card' });
	return json({ success: true });
};
