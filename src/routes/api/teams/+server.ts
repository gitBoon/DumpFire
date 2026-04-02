import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { teams, teamMembers, users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** GET — List all teams with their member counts. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const allTeams = db.select().from(teams).all();

	const teamsWithMembers = allTeams.map(team => {
		const members = db.select({
			userId: teamMembers.userId,
			role: teamMembers.role,
			username: users.username,
			emoji: users.emoji
		})
		.from(teamMembers)
		.innerJoin(users, eq(teamMembers.userId, users.id))
		.where(eq(teamMembers.teamId, team.id))
		.all();

		return { ...team, members };
	});

	return json(teamsWithMembers);
};

/** POST — Create a new team (any authenticated user). */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const { name, emoji } = await request.json();
	if (!name?.trim()) throw error(400, 'Team name is required');

	const team = db.insert(teams)
		.values({ name: name.trim(), emoji: emoji || '🏢' })
		.returning()
		.get();

	// Auto-add creator as team owner
	db.insert(teamMembers)
		.values({ teamId: team.id, userId: locals.user.id, role: 'owner' })
		.run();

	return json(team, { status: 201 });
};
