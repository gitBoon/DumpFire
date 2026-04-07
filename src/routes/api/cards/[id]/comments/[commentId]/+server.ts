import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardComments } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** PUT — Edit own comment. */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const commentId = Number(params.commentId);
	const { content } = await request.json();
	if (!content?.trim()) throw error(400, 'Comment cannot be empty');

	const comment = db.select().from(cardComments).where(eq(cardComments.id, commentId)).get();
	if (!comment) throw error(404, 'Comment not found');

	// Only the author or admins can edit
	const isAdmin = locals.user.role === 'admin' || locals.user.role === 'superadmin';
	if (comment.userId !== locals.user.id && !isAdmin) {
		throw error(403, 'You can only edit your own comments');
	}

	const updated = db
		.update(cardComments)
		.set({ content: content.trim(), updatedAt: sql`(datetime('now'))` })
		.where(eq(cardComments.id, commentId))
		.returning()
		.get();

	return json(updated);
};

/** DELETE — Delete own comment (or admin). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const commentId = Number(params.commentId);
	const comment = db.select().from(cardComments).where(eq(cardComments.id, commentId)).get();
	if (!comment) throw error(404, 'Comment not found');

	const isAdmin = locals.user.role === 'admin' || locals.user.role === 'superadmin';
	if (comment.userId !== locals.user.id && !isAdmin) {
		throw error(403, 'You can only delete your own comments');
	}

	db.delete(cardComments).where(eq(cardComments.id, commentId)).run();
	return json({ success: true });
};
