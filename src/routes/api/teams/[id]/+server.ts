import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { teams, teamMembers } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** Check if a user is an admin or the owner of a specific team. */
function canManageTeam(user: { id: number; role: string }, teamId: number): boolean {
	if (user.role === 'admin' || user.role === 'superadmin') return true;
	const membership = db.select()
		.from(teamMembers)
		.where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, user.id)))
		.get();
	return membership?.role === 'owner';
}

/** PUT — Update team details (admin or team owner). */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const teamId = Number(params.id);
	if (!canManageTeam(locals.user, teamId)) throw error(403, 'Forbidden');

	const data = await request.json();
	const updates: Record<string, unknown> = {};
	if (data.name) updates.name = data.name.trim();
	if (data.emoji) updates.emoji = data.emoji;

	const updated = db.update(teams)
		.set(updates)
		.where(eq(teams.id, teamId))
		.returning()
		.get();

	if (!updated) throw error(404, 'Team not found');
	return json(updated);
};

/** DELETE — Delete a team (admin or team owner). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const teamId = Number(params.id);
	if (!canManageTeam(locals.user, teamId)) throw error(403, 'Forbidden');

	db.delete(teams).where(eq(teams.id, teamId)).run();
	return json({ success: true });
};
