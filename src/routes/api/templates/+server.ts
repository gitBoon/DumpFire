import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardTemplates } from '$lib/server/db/schema';
import { eq, or, isNull } from 'drizzle-orm';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import { inTransaction } from '$lib/server/db/transaction';
import { PRIORITIES } from '$lib/server/card-fields';
import { readBody, readChoice, readId, readIds, readObjects, readQueryId, readText } from '$lib/server/request-body';
import { requireBoard, requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/** GET — list templates (global + board-specific) */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	// An id, as an id in the path is read (card 2117).
	const boardIdParam = readQueryId(url.searchParams.get('boardId'), 'board');
	if (boardIdParam !== undefined) {
		const boardId = requireBoard(locals.user, boardIdParam, 'view').id;
		return json(
			db.select().from(cardTemplates)
				.where(or(eq(cardTemplates.boardId, boardId), isNull(cardTemplates.boardId)))
				.all()
		);
	}

	// No board named: the shared templates, plus those of boards the caller can
	// open. A template carries a card's title, description and subtasks, so one
	// saved on a private board is as private as the board.
	const accessible = getAccessibleBoardIds(locals.user);
	const all = db.select().from(cardTemplates).all();
	return json(
		accessible === null
			? all
			: all.filter((t) => t.boardId === null || accessible.includes(t.boardId))
	);
};

/**
 * POST — create a template.
 *
 * `boardId` is read first, because it says whose template this is: an id, or
 * null or left out for one shared with everyone. The board is looked for and
 * the caller checked (404, then 403), and then the other fields are read
 * (card 2117, R1): `name` text, trimmed, of 1 to 200 characters; the card it
 * holds, `title` text of at most 500 and `description` of at most 50,000;
 * `priority` one of the four, in any case; `subtasks` a list of objects, each
 * a subtask's `title`, `description` and `priority`, read by the same rules;
 * `labels` a list of label ids. A template with no name was a 500, and the
 * rest was stored as sent: the card window's `applyTemplate` read it back.
 *
 * A create is checked as new (R6): a template saved from a card whose stored
 * priority no rule allows is refused, and the card window says so.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireUser(locals.user);
	const body = await readBody(request);

	const template = inTransaction(() => {
		// A template saved on a board is part of that board. One saved with no
		// board is shared with everyone and anyone may add to that pool.
		const boardIdSent = readId(body, 'boardId', { nullable: true, says: 'Invalid board ID' });
		const boardId = boardIdSent != null ? requireBoard(user, boardIdSent, 'edit').id : null;

		const name = readText(body, 'name', {
			required: true,
			trim: true,
			min: 1,
			max: 200,
			says: { missing: 'name is required', empty: 'name is required' }
		});
		const title = readText(body, 'title', { max: 500 });
		const description = readText(body, 'description', { max: 50000 });
		const priority = readChoice(body, 'priority', { from: PRIORITIES, anyCase: true });
		// Each subtask the template holds, by the subtask's own rules, named by its place.
		const steps = (readObjects(body, 'subtasks', {}) ?? []).map((step, i) => {
			const at = `subtasks[${i}]`;
			return {
				title: readText(step, 'title', { max: 500, says: { type: `${at}.title must be text`, invalid: `${at}.title must be at most 500 characters` } }) ?? '',
				description:
					readText(step, 'description', {
						max: 50000,
						says: { type: `${at}.description must be text`, invalid: `${at}.description must be at most 50000 characters` }
					}) ?? '',
				priority: readChoice(step, 'priority', { from: PRIORITIES, anyCase: true, says: `${at}.priority must be one of: ${PRIORITIES.join(', ')}` }) ?? 'medium'
			};
		});
		const labelIds = readIds(body, 'labels', {}) ?? [];

		return db.insert(cardTemplates).values({
			boardId,
			name,
			title: title ?? '',
			description: description ?? '',
			priority: priority ?? 'medium',
			subtasksJson: JSON.stringify(steps),
			labelsJson: JSON.stringify(labelIds),
			createdBy: user.id
		}).returning().get();
	});

	return json(template);
};
