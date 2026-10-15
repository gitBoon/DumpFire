import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { teams } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { inTransaction } from '$lib/server/db/transaction';
import { pathId, readBody, readText } from '$lib/server/request-body';
import { requireTeamManager, requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/** PUT — Update team details (admin or team owner). */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const user = requireUser(locals.user);
	const teamId = pathId(params.id, 'team');
	const body = await readBody(request);

	// The team is read and the caller checked in the transaction that renames
	// it, after the body has arrived: a check made before could be overtaken
	// by the caller's ownership being taken away while the body was arriving.
	const updated = inTransaction(() => {
		const team = requireTeamManager(user, teamId);

		const updates: Partial<typeof teams.$inferInsert> = {};
		const name = readText(body, 'name', { trim: true, min: 1, max: 200, keep: team.name });
		if (name !== undefined) updates.name = name;
		const emoji = readText(body, 'emoji', { min: 1, max: 32, keep: team.emoji });
		if (emoji !== undefined) updates.emoji = emoji;
		// Nothing to change was a 500, from an update with nothing to set.
		if (Object.keys(updates).length === 0) throw error(400, 'No valid fields to update');

		return db.update(teams).set(updates).where(eq(teams.id, teamId)).returning().get();
	});
	return json(updated);
};

/** DELETE — Delete a team (admin or team owner). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const teamId = pathId(params.id, 'team');
	requireTeamManager(locals.user, teamId);

	db.delete(teams).where(eq(teams.id, teamId)).run();
	return json({ success: true });
};
