import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { subtasks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';
import { requireSubtask, requireUser } from '$lib/server/route-guards';
import { notifyRequesterProgress } from '$lib/server/notifications';
import { linkBaseUrl } from '$lib/server/email';
import { announceUnblocked, recordUnblocked, removeWorkNodeEdges } from '$lib/server/planning';
import { logUiActivity, actorOf, ACTIONS } from '$lib/server/logActivity';
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
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * PUT /api/subtasks/:id — change a subtask, and tick it off or on.
 *
 * The subtask is looked for and the caller checked (404, then 403), then
 * every field is read (card 2117), as `PUT /api/v1/subtasks/:subtaskId` reads
 * them: `title` text, trimmed, of 1 to 500 characters; `description` at most
 * 50,000; `priority` one of the four; `colorTag` a colour written `#rrggbb`
 * or empty; `dueDate` a date written `YYYY-MM-DD`, or null; `completed` true
 * or false; `position` a number. A value the subtask already holds, sent back
 * unchanged, is accepted as it is (decision 8). Nothing else is written: the
 * whole body once was, so a caller could set `cardId` and move a subtask onto
 * a card on a board they could not open.
 *
 * `completed: "false"` was stored as true, with the completion's entry and
 * notices left out.
 */
export const PUT: RequestHandler = async ({ params, request, locals, url }) => {
	requireUser(locals.user);
	const id = pathId(params.id, 'subtask');

	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction: the update, the activity entry and the "Unblocked"
	// notices are saved together or not at all. The subtask is read in here and
	// not before the body was awaited, where two requests ticking the same
	// subtask both found it open and both wrote a notice. So is the caller: the
	// session is asked again, and who its account is now (card 2253).
	const updated = writeAs(locals, (caller) => {
		const user = requireUser(caller);
		// The board is the parent card's. A `boardId` in the body is ignored.
		const { subtask: existing, card: parentCard, boardId } = requireSubtask(user, id, 'edit');

		// Every field, read against its rule and the value the subtask holds.
		const updateData: Partial<typeof subtasks.$inferInsert> = {};
		const title = readText(body, 'title', {
			trim: true,
			min: 1,
			max: 500,
			keep: existing.title,
			says: { empty: 'title cannot be empty' }
		});
		if (title !== undefined) updateData.title = title;
		const description = readText(body, 'description', { max: 50000, keep: existing.description });
		if (description !== undefined) updateData.description = description;
		const priority = readChoice(body, 'priority', { from: PRIORITIES, anyCase: true, keep: existing.priority });
		if (priority !== undefined) updateData.priority = priority;
		const colorTag = readColour(body, 'colorTag', { allowEmpty: true, keep: existing.colorTag });
		if (colorTag !== undefined) updateData.colorTag = colorTag;
		const dueDate = readDate(body, 'dueDate', { nullable: true, keep: existing.dueDate });
		if (dueDate !== undefined) updateData.dueDate = dueDate;
		const completed = readBoolean(body, 'completed', { keep: existing.completed });
		if (completed !== undefined) updateData.completed = completed;
		const position = readNumber(body, 'position', { keep: existing.position });
		if (position !== undefined) updateData.position = position;

		if (Object.keys(updateData).length === 0) throw error(400, 'No valid fields to update');

		const row = db.update(subtasks).set(updateData).where(eq(subtasks.id, id)).returning().get();
		if (!row) throw error(404, 'Subtask not found');
		emit(boardId, 'update', { type: 'subtask' });

		// Guarded on the before-state so re-ticking an already-complete subtask does
		// not re-fire any of this.
		if (updateData.completed === true && !existing.completed) {
			// This used to insert into activity_log directly, which meant no webhook
			// dispatch and — worse — no userId, so the entry could not be filtered by
			// person. A per-user activity report simply did not see these.
			logUiActivity({
				boardId,
				cardId: row.cardId,
				action: ACTIONS.subtaskCompleted,
				detail: `${row.title} (on ${parentCard.title})`,
				...actorOf(user)
			});

			// A subtask can be the last thing blocking other work. The notices are
			// the last write; the mail and the refresh for them wait for the commit.
			announceUnblocked(recordUnblocked([{ kind: 'subtask', id }], user.id), user, baseUrl);

			// Notify the original requester about this subtask completion
			notifyRequesterProgress({
				cardId: row.cardId,
				action: 'subtask_completed',
				summary: row.title,
				actorName: user.username,
				baseUrl,
				actorUserId: user.id
			});
		}

		return row;
	});

	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const id = pathId(params.id, 'subtask');

	// One transaction: the subtask's dependency links, the subtask and the
	// activity entry go together or not at all. A failure after the first used
	// to leave the subtask in place with its links gone. It asks first whether
	// the session is still open, and who its account is now (card 2253).
	writeAs(locals, (caller) => {
		const user = requireUser(caller);
		const { subtask: doomed, boardId } = requireSubtask(user, id, 'edit');

		// Polymorphic ids do not cascade — clear this node's edges explicitly.
		removeWorkNodeEdges('subtask', id);
		db.delete(subtasks).where(eq(subtasks.id, id)).run();

		logUiActivity({
			boardId,
			cardId: doomed.cardId,
			action: ACTIONS.subtaskDeleted,
			detail: `"${doomed.title}"`,
			...actorOf(user)
		});
		emit(boardId, 'update', { type: 'subtask' });
	});
	return json({ success: true });
};
