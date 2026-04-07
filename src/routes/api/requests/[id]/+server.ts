import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { taskRequests, requestMessages, cards, columns, boards, cardAssignees, cardComments, users } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { notifyUserAssigned, notifyRequesterAccepted, notifyRequesterRejected } from '$lib/server/notifications';
import { resolveBaseUrl } from '$lib/server/email';
import type { RequestHandler } from './$types';

/** PATCH — Accept or reject a task request. */
export const PATCH: RequestHandler = async ({ params, request, locals, url }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	const body = await request.json();
	const { action, boardId, columnId, rejectReason, assigneeId } = body;

	const existing = db.select().from(taskRequests).where(eq(taskRequests.id, id)).get();
	if (!existing) throw error(404, 'Request not found');
	if (existing.status !== 'pending') throw error(400, 'Request already resolved');

	if (action === 'accept') {
		if (!boardId || !columnId) throw error(400, 'Board and column are required to accept');

		// Verify board and column exist
		const board = db.select({ id: boards.id }).from(boards).where(eq(boards.id, boardId)).get();
		if (!board) throw error(404, 'Board not found');
		const column = db.select({ id: columns.id }).from(columns).where(eq(columns.id, columnId)).get();
		if (!column) throw error(404, 'Column not found');

		// Get max position in the target column
		const colCards = db.select({ position: cards.position })
			.from(cards)
			.where(eq(cards.columnId, columnId))
			.all();
		const maxPos = colCards.length > 0 ? Math.max(...colCards.map(c => c.position)) + 1 : 0;

		// Create the card
		const newCard = db.insert(cards).values({
			columnId,
			title: existing.title,
			description: existing.description || '',
			priority: existing.priority,
			position: maxPos,
			colorTag: '',
			pinned: false,
			onHoldNote: '',
			businessValue: existing.businessValue || ''
		}).returning().get();

		// Update request status
		db.update(taskRequests).set({
			status: 'accepted',
			resolvedBy: locals.user.id,
			resolvedCardId: newCard.id,
			resolvedAt: new Date().toISOString()
		}).where(eq(taskRequests.id, id)).run();

		// Copy discussion messages as card comments
		const msgs = db.select().from(requestMessages)
			.where(eq(requestMessages.requestId, id))
			.orderBy(asc(requestMessages.createdAt))
			.all();
		for (const m of msgs) {
			const who = m.senderType === 'admin' ? `🛡️ ${m.senderName}` : `👤 ${m.senderName}`;
			db.insert(cardComments).values({
				cardId: newCard.id,
				userId: locals.user.id,
				content: `**${who} (from request discussion):**\n${m.message}`
			}).run();
		}

		// Assign user if specified
		if (assigneeId) {
			db.insert(cardAssignees).values({
				cardId: newCard.id,
				userId: assigneeId
			}).run();

			// Send assignment email
			const assignee = db.select({ email: users.email, username: users.username })
				.from(users).where(eq(users.id, assigneeId)).get();
			if (assignee) {
				const baseUrl = resolveBaseUrl(request, url);
				notifyUserAssigned(boardId, newCard.id, existing.title, assignee.email, assignee.username, locals.user.username, baseUrl);
			}
		}

		// Notify requester via email
		if (existing.requesterEmail) {
			notifyRequesterAccepted(existing.requesterEmail, existing.title, locals.user.username);
		}

		return json({ ...existing, status: 'accepted', resolvedCardId: newCard.id });

	} else if (action === 'reject') {
		db.update(taskRequests).set({
			status: 'rejected',
			resolvedBy: locals.user.id,
			rejectReason: rejectReason || null,
			resolvedAt: new Date().toISOString()
		}).where(eq(taskRequests.id, id)).run();

		// Notify requester via email
		if (existing.requesterEmail) {
			notifyRequesterRejected(existing.requesterEmail, existing.title, locals.user.username, rejectReason || undefined);
		}

		return json({ ...existing, status: 'rejected' });

	} else {
		throw error(400, 'Invalid action — must be "accept" or "reject"');
	}
};

/** DELETE — Delete a request (admin only). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	if (locals.user.role !== 'admin' && locals.user.role !== 'superadmin') {
		throw error(403, 'Admin only');
	}

	const id = Number(params.id);
	db.delete(taskRequests).where(eq(taskRequests.id, id)).run();
	return json({ ok: true });
};
