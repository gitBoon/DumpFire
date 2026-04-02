import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { teams, teamMembers, users } from '$lib/server/db/schema';
import { eq, inArray } from 'drizzle-orm';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	const isAdmin = user.role === 'admin' || user.role === 'superadmin';

	// Get teams the user belongs to (or all teams if admin)
	let relevantTeams: (typeof teams.$inferSelect)[];
	if (isAdmin) {
		relevantTeams = db.select().from(teams).all();
	} else {
		const memberships = db.select({ teamId: teamMembers.teamId })
			.from(teamMembers)
			.where(eq(teamMembers.userId, user.id))
			.all();
		const teamIds = memberships.map(m => m.teamId);
		relevantTeams = teamIds.length > 0
			? db.select().from(teams).where(inArray(teams.id, teamIds)).all()
			: [];
	}

	// Enrich with members
	const teamsWithMembers = relevantTeams.map(team => {
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

	// All users for the "add member" dropdown (available to team owners / admins)
	const allUsers = db.select({
		id: users.id,
		username: users.username,
		email: users.email,
		emoji: users.emoji,
		role: users.role
	}).from(users).all();

	return {
		teams: teamsWithMembers,
		users: allUsers,
		currentUser: user
	};
};
