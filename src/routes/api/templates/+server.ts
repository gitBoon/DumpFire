import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardTemplates } from '$lib/server/db/schema';
import { eq, or, isNull } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** GET — list templates (global + board-specific) */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = url.searchParams.get('boardId');
	let templates;
	if (boardId) {
		templates = db.select().from(cardTemplates)
			.where(or(eq(cardTemplates.boardId, Number(boardId)), isNull(cardTemplates.boardId)))
			.all();
	} else {
		templates = db.select().from(cardTemplates).all();
	}
	return json(templates);
};

/** POST — create a template */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const data = await request.json();

	const template = db.insert(cardTemplates).values({
		boardId: data.boardId || null,
		name: data.name,
		title: data.title || '',
		description: data.description || '',
		priority: data.priority || 'medium',
		subtasksJson: JSON.stringify(data.subtasks || []),
		labelsJson: JSON.stringify(data.labels || []),
		createdBy: locals.user.id
	}).returning().get();

	return json(template);
};
