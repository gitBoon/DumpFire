import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { subtasks, cards, columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { canEditBoard } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { announceUnblocked, recordUnblocked, removeWorkNodeEdges } from '$lib/server/planning';
import { notifyRequesterProgress } from '$lib/server/notifications';
import { linkBaseUrl } from '$lib/server/email';
import { ACTIONS, actorOf, logActivity } from '$lib/server/logActivity';
import { PRIORITIES } from '$lib/server/card-fields';
import {
	pathId,
	readBody,
	readBoolean,
	readChoice,
	readColour,
	readDate,
	readNumber,
	readText
} from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/** Resolve the board that a subtask belongs to (via card → column → board). */
function getSubtaskBoardId(subtaskId: number): { boardId: number; cardId: number } | null {
	const sub = db.select({ cardId: subtasks.cardId }).from(subtasks).where(eq(subtasks.id, subtaskId)).get();
	if (!sub) return null;
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, sub.cardId)).get();
	if (!card) return null;
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) return null;
	return { boardId: col.boardId, cardId: sub.cardId };
}

/**
 * PUT /api/v1/subtasks/:subtaskId — Update a subtask.
 *
 * The subtask is looked for and the caller checked (404, then 403), then
 * every field is read (400). A value the subtask already holds, sent back
 * unchanged, is accepted as it is (decision 8).
 *
 * A tick records what `PUT /api/subtasks/:id` records (card 2108): an
 * `api:subtask_completed` entry, `<subtask> (on <card>)`, and a mail to
 * whoever asked for the card. Through this route it wrote neither, so the
 * activity report and the audit log did not show it.
 */
export const PUT: RequestHandler = async ({ params, request, url, locals }) => {
	const user = requireUser(locals.user);
	const subtaskId = pathId(params.subtaskId, 'subtask');
	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction: the update and the "Unblocked" notices are saved
	// together or not at all. The subtask is read in here and not before the
	// body was awaited, where two requests ticking the same subtask both found
	// it open and both wrote a notice.
	const updated = inTransaction(() => {
		const ctx = getSubtaskBoardId(subtaskId);
		if (!ctx) throw error(404, 'Subtask not found');

		if (!canEditBoard(user, ctx.boardId)) {
			throw error(403, 'No edit access to this subtask\'s board');
		}

		// Snapshot before the write so "just completed" can be told from "was
		// already complete" — re-ticking must not re-fire the unblock notice.
		// It is the row the fields are read against, too.
		const before = db.select().from(subtasks).where(eq(subtasks.id, subtaskId)).get()!;

		const updateData: Partial<typeof subtasks.$inferInsert> = {};
		const title = readText(body, 'title', {
			trim: true,
			min: 1,
			max: 500,
			keep: before.title,
			says: { empty: 'title cannot be empty' }
		});
		if (title !== undefined) updateData.title = title;
		const description = readText(body, 'description', { max: 50000, keep: before.description });
		if (description !== undefined) updateData.description = description;
		const priority = readChoice(body, 'priority', { from: PRIORITIES, anyCase: true, keep: before.priority });
		if (priority !== undefined) updateData.priority = priority;
		const colorTag = readColour(body, 'colorTag', { allowEmpty: true, keep: before.colorTag });
		if (colorTag !== undefined) updateData.colorTag = colorTag;
		const dueDate = readDate(body, 'dueDate', { nullable: true, keep: before.dueDate });
		if (dueDate !== undefined) updateData.dueDate = dueDate;
		const completed = readBoolean(body, 'completed', { keep: before.completed });
		if (completed !== undefined) updateData.completed = completed;
		const position = readNumber(body, 'position', { keep: before.position });
		if (position !== undefined) updateData.position = position;

		if (Object.keys(updateData).length === 0) {
			throw error(400, 'No valid fields to update');
		}

		const row = db.update(subtasks)
			.set(updateData)
			.where(eq(subtasks.id, subtaskId))
			.returning()
			.get();

		if (!row) throw error(404, 'Subtask not found');

		// Guarded on the before-state, so re-ticking a subtask already complete
		// writes none of this again.
		if (updateData.completed === true && !before.completed) {
			const card = db.select({ title: cards.title }).from(cards).where(eq(cards.id, row.cardId)).get()!;
			logActivity({
				boardId: ctx.boardId,
				cardId: row.cardId,
				action: ACTIONS.subtaskCompleted,
				detail: `${row.title} (on ${card.title})`,
				source: 'api',
				...actorOf(user)
			});

			// A subtask can be the last thing blocking other work. The notices are
			// the last write; the mail and the refresh for them wait for the commit.
			announceUnblocked(recordUnblocked([{ kind: 'subtask', id: subtaskId }], user.id), user, baseUrl);

			// Whoever asked for the card is told, once the tick is committed.
			notifyRequesterProgress({
				cardId: row.cardId,
				action: 'subtask_completed',
				summary: row.title,
				actorName: user.username,
				baseUrl,
				actorUserId: user.id
			});
		}

		emit(ctx.boardId, 'update', { type: 'card' });

		return row;
	});

	return json(updated);
};

/**
 * DELETE /api/v1/subtasks/:subtaskId — Delete a subtask permanently.
 *
 * Writes `api:subtask_deleted` with the subtask's title, as
 * `DELETE /api/subtasks/:id` writes `subtask_deleted` (card 2108). It wrote
 * no entry.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const user = requireUser(locals.user);
	const subtaskId = pathId(params.subtaskId, 'subtask');

	// One transaction: the subtask's dependency links, the subtask and the
	// activity entry go together or not at all. A failure between the first
	// two used to leave the subtask in place with its links gone.
	inTransaction(() => {
		const ctx = getSubtaskBoardId(subtaskId);
		if (!ctx) throw error(404, 'Subtask not found');

		if (!canEditBoard(user, ctx.boardId)) {
			throw error(403, 'No edit access to this subtask\'s board');
		}

		// Its title, for the entry, read before it goes.
		const doomed = db.select({ title: subtasks.title }).from(subtasks).where(eq(subtasks.id, subtaskId)).get()!;

		// work_dependencies ids are polymorphic and carry no foreign key, so nothing
		// cascades — clear the edges explicitly or the graph keeps pointing at work
		// that no longer exists.
		removeWorkNodeEdges('subtask', subtaskId);
		db.delete(subtasks).where(eq(subtasks.id, subtaskId)).run();

		logActivity({
			boardId: ctx.boardId,
			cardId: ctx.cardId,
			action: ACTIONS.subtaskDeleted,
			detail: `"${doomed.title}"`,
			source: 'api',
			...actorOf(user)
		});
		emit(ctx.boardId, 'update', { type: 'card' });
	});

	return json({ success: true });
};
