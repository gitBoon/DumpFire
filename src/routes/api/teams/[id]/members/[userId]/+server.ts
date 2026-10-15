import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { teamMembers, users } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { inTransaction } from '$lib/server/db/transaction';
import { pathId, readBody, readChoice, readId } from '$lib/server/request-body';
import { requireTeamManager, requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/** The roles a member of a team may have. */
const TEAM_ROLES = ['member', 'owner'] as const;

/**
 * POST — Add a member to a team, or change a member's role (admin or team owner).
 *
 * The member is the user in the path. The body's `userId` used to be the one
 * added, whatever the path said; the pages send both, the same. Sent and
 * different, it is refused.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const caller = requireUser(locals.user);
	const teamId = pathId(params.id, 'team');
	const userId = pathId(params.userId, 'user');
	const body = await readBody(request);

	// The team and the caller's ownership of it are read in the transaction
	// that adds the member, after the body has arrived.
	return inTransaction(() => {
		requireTeamManager(caller, teamId);

		const named = readId(body, 'userId', {});
		if (named !== undefined && named !== userId) {
			throw error(400, 'userId must be the user in the path, or be left out');
		}
		const existing = db.select()
			.from(teamMembers)
			.where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
			.get();
		// A role stored before roles were checked is kept when it is sent back.
		const role = readChoice(body, 'role', { from: TEAM_ROLES, keep: existing?.role }) ?? 'member';

		const user = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
		if (!user) throw error(404, 'User not found');

		if (existing) {
			db.update(teamMembers)
				.set({ role })
				.where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
				.run();
			return json({ success: true, action: 'updated' });
		}

		db.insert(teamMembers).values({ teamId, userId, role }).run();
		return json({ success: true, action: 'added' }, { status: 201 });
	});
};

/** DELETE — Remove a member from a team (admin or team owner). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const teamId = pathId(params.id, 'team');
	const userId = pathId(params.userId, 'user');
	requireTeamManager(locals.user, teamId);

	db.delete(teamMembers)
		.where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
		.run();

	return json({ success: true });
};
