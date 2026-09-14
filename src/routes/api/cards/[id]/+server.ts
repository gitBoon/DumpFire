import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { canEditBoard } from '$lib/server/board-access';
import { getCompletionBlocker, isCompleteColumnTitle } from '$lib/server/card-completion';
import { applyUnblockEffects, removeWorkNodeEdges } from '$lib/server/planning';
import { resolveBaseUrl } from '$lib/server/email';
import { logUiActivity, actorOf, ACTIONS } from '$lib/server/logActivity';
import { normaliseReportingFields, ReportingFieldError } from '$lib/server/reporting-fields';
import type { RequestHandler } from './$types';

/** Resolve the board that a card belongs to. */
function getCardBoardId(cardId: number): number | null {
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) return null;
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	return col?.boardId ?? null;
}

export const PUT: RequestHandler = async ({ params, request, url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	const data = await request.json();
	const { boardId: clientBoardId, ...rawData } = data;

	// Resolve and verify board access
	const resolvedBoardId = clientBoardId || getCardBoardId(id);
	if (!resolvedBoardId) throw error(404, 'Card not found');
	if (!canEditBoard(locals.user, resolvedBoardId)) {
		throw error(403, 'No edit access to this board');
	}

	// Whitelist allowed fields to prevent mass assignment
	const updateData: Record<string, unknown> = {};
	const allowed = ['title', 'description', 'priority', 'colorTag', 'categoryId', 'dueDate',
		'onHoldNote', 'businessValue', 'pinned', 'position', 'columnId', 'completedAt',
		'archivedAt', 'coverUrl', 'recurrenceRule'];
	for (const key of allowed) {
		if (key in rawData) updateData[key] = rawData[key];
	}

	// Reporting fields carry fixed vocabularies, so they are validated rather
	// than whitelisted through. A bad value is a 400: dropped silently it would
	// read as "not recorded", which is a different and misleading answer.
	try {
		Object.assign(updateData, normaliseReportingFields(rawData));
	} catch (e) {
		if (e instanceof ReportingFieldError) throw error(400, e.message);
		throw e;
	}

	// Block completion if columnId is being changed to a Complete column
	let justCompleted = false;
	if (updateData.columnId) {
		const existingCard = db.select().from(cards).where(eq(cards.id, id)).get();
		if (existingCard && existingCard.columnId !== updateData.columnId) {
			const targetCol = db.select().from(columns).where(eq(columns.id, updateData.columnId as number)).get();
			if (targetCol && isCompleteColumnTitle(targetCol.title)) {
				const blocker = getCompletionBlocker(id);
				if (blocker) {
					throw error(409, blocker);
				}
				justCompleted = true;
			}
		}
	}

	updateData.updatedAt = new Date().toISOString();

	// Completing a card through this route stamped no completion date unless the
	// client happened to send one, so a card completed from the modal rather than
	// by dragging was invisible to every report that buckets by completedAt.
	if (justCompleted && !('completedAt' in updateData)) {
		updateData.completedAt = new Date().toISOString();
	}

	const updated = db
		.update(cards)
		.set(updateData)
		.where(eq(cards.id, id))
		.returning()
		.get();
	if (!updated) throw error(404, 'Card not found');

	// Anything that was waiting on this card may now be startable.
	if (justCompleted) {
		applyUnblockEffects(id, locals.user, resolveBaseUrl(request, url));
	}

	if (resolvedBoardId) {
		const changed = Object.keys(updateData).filter((k) => k !== 'updatedAt');
		logUiActivity({
			boardId: resolvedBoardId,
			cardId: id,
			action: justCompleted ? ACTIONS.cardCompleted : ACTIONS.cardUpdated,
			detail: justCompleted
				? `"${updated.title}"`
				: `Updated fields: ${changed.join(', ')} on "${updated.title}"`,
			...actorOf(locals.user)
		});
		emit(resolvedBoardId, 'update', { type: 'card' });
	}
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, request, url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	const permanent = url.searchParams.get('permanent') === 'true';

	let clientBoardId: number | undefined;
	try {
		const data = await request.json();
		clientBoardId = data.boardId;
	} catch {}

	// Resolve and verify board access
	const resolvedBoardId = clientBoardId || getCardBoardId(id);
	if (resolvedBoardId && !canEditBoard(locals.user, resolvedBoardId)) {
		throw error(403, 'No edit access to this board');
	}

	// Read the title before the row goes, or the log entry says "Unknown".
	const cardTitle =
		db.select({ title: cards.title }).from(cards).where(eq(cards.id, id)).get()?.title ?? 'Unknown';

	if (permanent) {
		// Polymorphic dependency ids do not cascade — clear this card's edges.
		removeWorkNodeEdges('card', id);
		db.delete(cards).where(eq(cards.id, id)).run();
	} else {
		// Soft-delete: move to archive
		db.update(cards)
			.set({ archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
			.where(eq(cards.id, id))
			.run();
	}
	if (resolvedBoardId) {
		logUiActivity({
			boardId: resolvedBoardId,
			cardId: permanent ? null : id,
			action: permanent ? ACTIONS.cardDeleted : 'card_archived',
			detail: `"${cardTitle}"`,
			...actorOf(locals.user)
		});
		emit(resolvedBoardId, 'update', { type: 'card' });
	}
	return json({ success: true });
};
