/**
 * Purge Archived Cards — permanently delete all archived cards from the database.
 *
 * POST /api/admin/purge-archived
 * Admin/superadmin only.
 */

import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, subtasks, cardLabels, cardAssignees } from '$lib/server/db/schema';
import { isNotNull, inArray } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	// Find all archived cards
	const archivedCards = db.select({ id: cards.id })
		.from(cards)
		.where(isNotNull(cards.archivedAt))
		.all();

	const archivedIds = archivedCards.map(c => c.id);

	if (archivedIds.length === 0) {
		return json({ success: true, purged: 0 });
	}

	// Clean up related records first, then delete the cards
	db.delete(subtasks).where(inArray(subtasks.cardId, archivedIds)).run();
	db.delete(cardLabels).where(inArray(cardLabels.cardId, archivedIds)).run();
	db.delete(cardAssignees).where(inArray(cardAssignees.cardId, archivedIds)).run();
	db.delete(cards).where(isNotNull(cards.archivedAt)).run();

	return json({ success: true, purged: archivedIds.length });
};
