import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { teamMembers, users } from '$lib/server/db/schema';
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

/** POST — Add a member to a team (admin or team owner). */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const teamId = Number(params.id);
	if (!canManageTeam(locals.user, teamId)) throw error(403, 'Forbidden');

	const { userId, role } = await request.json();

	if (!userId) throw error(400, 'userId is required');

	// Check user exists
	const user = db.select().from(users).where(eq(users.id, userId)).get();
	if (!user) throw error(404, 'User not found');

	// Check if already a member
	const existing = db.select()
		.from(teamMembers)
		.where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
		.get();

	if (existing) {
		// Update role instead
		db.update(teamMembers)
			.set({ role: role || 'member' })
			.where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
			.run();
		return json({ success: true, action: 'updated' });
	}

	db.insert(teamMembers)
		.values({ teamId, userId, role: role || 'member' })
		.run();

	return json({ success: true, action: 'added' }, { status: 201 });
};

/** DELETE — Remove a member from a team (admin or team owner). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const teamId = Number(params.id);
	if (!canManageTeam(locals.user, teamId)) throw error(403, 'Forbidden');

	const userId = Number(params.userId);

	db.delete(teamMembers)
		.where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
		.run();

	return json({ success: true });
};
