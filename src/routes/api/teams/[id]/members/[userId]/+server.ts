import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { teamMembers, users } from '$lib/server/db/schema';
import { eq, and, ne } from 'drizzle-orm';
import { pathId, readBody, readChoice, readId } from '$lib/server/request-body';
import { requireTeamManager, requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** The roles a member of a team may have. */
const TEAM_ROLES = ['member', 'owner'] as const;

/** Said when a change would take away a team's last owner (card 2373). */
const LAST_OWNER = 'A team needs at least one owner. Make someone else an owner first, or delete the team.';

/**
 * Refuses, 409, a change that takes the team's last owner away: `member`, an
 * owner made something else or removed, when no other member is an owner.
 * Administrators too: a team nobody owns could be run by them alone (card
 * 2373). Read in the transaction of the change, so two owners demoting each
 * other at once cannot both pass. A team that already has no owner is not
 * made worse by a change to a member, so that is allowed.
 */
function keepAnOwner(teamId: number, member: { userId: number; role: string } | undefined, nextRole: string | null): void {
	if (member?.role !== 'owner' || nextRole === 'owner') return;
	const another = db.select({ userId: teamMembers.userId })
		.from(teamMembers)
		.where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, 'owner'), ne(teamMembers.userId, member.userId)))
		.get();
	if (!another) throw error(409, LAST_OWNER);
}

/**
 * POST — Add a member to a team, or change a member's role (admin or team owner).
 * A change that would leave the team with no owner is refused, 409 (card 2373).
 * A `role` left out keeps an existing member's role (card 2378).
 *
 * The member is the user in the path. The body's `userId` used to be the one
 * added, whatever the path said; the pages send both, the same. Sent and
 * different, it is refused.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);
	const teamId = pathId(params.id, 'team');
	const userId = pathId(params.userId, 'user');
	const body = await readBody(request);

	// The team and the caller's ownership of it are read in the transaction
	// that adds the member, after the body has arrived, which asks first
	// whether the session is still open, and who its account is now (card
	// 2253). The answer is made once it has committed.
	const action = writeAs(locals, (caller) => {
		requireTeamManager(caller, teamId);

		const named = readId(body, 'userId', {});
		if (named !== undefined && named !== userId) {
			throw error(400, 'userId must be the user in the path, or be left out');
		}
		const existing = db.select()
			.from(teamMembers)
			.where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
			.get();
		// A role stored before roles were checked is kept when it is sent back,
		// and a role left out keeps the member's own (card 2378: it made an
		// owner a member). Someone not yet in the team is added as a member.
		const role = readChoice(body, 'role', { from: TEAM_ROLES, keep: existing?.role }) ?? existing?.role ?? 'member';

		const member = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
		if (!member) throw error(404, 'User not found');
		keepAnOwner(teamId, existing, role);

		if (existing) {
			// Card 2183's rule: the role they hold, sent again or left out,
			// writes nothing, and is answered as a change is (the pages read
			// `updated` as "already in the team").
			if (existing.role !== role) {
				db.update(teamMembers)
					.set({ role })
					.where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
					.run();
			}
			return 'updated' as const;
		}

		db.insert(teamMembers).values({ teamId, userId, role }).run();
		return 'added' as const;
	});
	return action === 'updated'
		? json({ success: true, action: 'updated' })
		: json({ success: true, action: 'added' }, { status: 201 });
};

/** DELETE — Remove a member from a team (admin or team owner), never its last owner. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);
	const teamId = pathId(params.id, 'team');
	const userId = pathId(params.userId, 'user');

	// The team read, the caller checked and the member taken off in one
	// transaction that asks first whether the session is still open, and who
	// its account is now (card 2253). The check and the delete were two steps
	// with no transaction around them.
	writeAs(locals, (caller) => {
		requireTeamManager(caller, teamId);

		const existing = db.select()
			.from(teamMembers)
			.where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
			.get();
		keepAnOwner(teamId, existing, null);

		db.delete(teamMembers)
			.where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
			.run();
	});

	return json({ success: true });
};
