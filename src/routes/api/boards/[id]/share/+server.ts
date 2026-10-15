import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, boardMembers, boardTeams, users, teams, teamMembers } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import { inTransaction } from '$lib/server/db/transaction';
import { notifyBoardShared } from '$lib/server/notifications';
import { linkBaseUrl } from '$lib/server/email';
import { pathId, readBody, readBoolean, readChoice, readId } from '$lib/server/request-body';
import { requireBoard, requireBoardOwner, requireUser } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

/** GET — List all members and teams with access to this board, plus public status. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = pathId(params.id, 'board');
	// The board is looked up before the caller's access is asked: asked first,
	// a board that is not there was 403 to everyone but an administrator, who
	// passes every check and was answered an empty list.
	const board = requireBoard(locals.user, boardId, 'view');
	const role = getBoardRole(locals.user, boardId);

	// Get individual members. Their addresses are for the board's owner and an
	// administrator, whom Share Board is offered to (card 2128, R1); anyone else
	// who can open the board, every signed-in account for a public one, is
	// given the list without them.
	const seesAddresses = role === 'owner' || role === 'admin';
	const members = db.select({
		userId: boardMembers.userId,
		role: boardMembers.role,
		username: users.username,
		email: users.email,
		emoji: users.emoji
	})
	.from(boardMembers)
	.innerJoin(users, eq(boardMembers.userId, users.id))
	.where(eq(boardMembers.boardId, boardId))
	.all()
	.map(({ email, ...member }) => (seesAddresses ? { ...member, email } : member));

	// Get team access
	const teamAccess = db.select({
		teamId: boardTeams.teamId,
		role: boardTeams.role,
		teamName: teams.name,
		teamEmoji: teams.emoji
	})
	.from(boardTeams)
	.innerJoin(teams, eq(boardTeams.teamId, teams.id))
	.where(eq(boardTeams.boardId, boardId))
	.all();

	return json({ members, teams: teamAccess, isPublic: board.isPublic });
};

/** Who a board is shared with: one person, or every member of a team. */
const SHARE_TYPES = ['user', 'team'] as const;
const SHARE_TYPE_SAYS = 'type must be "user" or "team"';

/**
 * The roles a new share may give, to a person or a team. Owner is not one: a
 * share that made somebody an owner handed them sharing, publishing and
 * deleting the board, and any text at all was stored. A person already
 * stored as owner, whose role the share window sends back unchanged, keeps it.
 */
const SHARE_ROLES = ['viewer', 'editor'] as const;

/** POST — Share board with a user or team. */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	const caller = requireUser(locals.user);
	const boardId = pathId(params.id, 'board');
	const body = await readBody(request);

	// The board, the caller's ownership of it, the share and its mail, in one
	// transaction entered once the body has arrived. The mail is queued until
	// the commit, and is not sent if the share is not saved.
	inTransaction(() => {
		requireBoardOwner(caller, boardId, 'Only board owners and admins can share boards');

		const type = readChoice(body, 'type', { from: SHARE_TYPES, required: true, says: SHARE_TYPE_SAYS });
		const targetId = readId(body, 'targetId', { required: true });
		const stored =
			type === 'user'
				? db.select({ role: boardMembers.role }).from(boardMembers)
					.where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, targetId)))
					.get()
				: db.select({ role: boardTeams.role }).from(boardTeams)
					.where(and(eq(boardTeams.boardId, boardId), eq(boardTeams.teamId, targetId)))
					.get();
		const shareRole: string = readChoice(body, 'role', { from: SHARE_ROLES, keep: stored?.role }) ?? 'viewer';

		if (type === 'user') {
			// Check user exists
			const user = db.select().from(users).where(eq(users.id, targetId)).get();
			if (!user) throw error(404, 'User not found');

			if (stored) {
				db.update(boardMembers)
					.set({ role: shareRole })
					.where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, targetId)))
					.run();
			} else {
				db.insert(boardMembers)
					.values({ boardId, userId: targetId, role: shareRole })
					.run();

				// Send notification email for new shares
				const board = db.select({ name: boards.name }).from(boards).where(eq(boards.id, boardId)).get();
				if (board) {
					const baseUrl = linkBaseUrl(url);
					notifyBoardShared(boardId, board.name, user.email, user.username, caller.username, shareRole, baseUrl);
				}
			}
		} else {
			// Check team exists
			const team = db.select().from(teams).where(eq(teams.id, targetId)).get();
			if (!team) throw error(404, 'Team not found');

			if (stored) {
				db.update(boardTeams)
					.set({ role: shareRole })
					.where(and(eq(boardTeams.boardId, boardId), eq(boardTeams.teamId, targetId)))
					.run();
			} else {
				db.insert(boardTeams)
					.values({ boardId, teamId: targetId, role: shareRole })
					.run();

				// Notify all team members about the new board share
				const board = db.select({ name: boards.name }).from(boards).where(eq(boards.id, boardId)).get();
				if (board) {
					const baseUrl = linkBaseUrl(url);
					const members = db.select({ userId: teamMembers.userId })
						.from(teamMembers).where(eq(teamMembers.teamId, targetId)).all();
					if (members.length > 0) {
						const allMemberUsers: { email: string; username: string }[] = [];
						for (const m of members) {
							const u = db.select({ email: users.email, username: users.username })
								.from(users).where(eq(users.id, m.userId)).get();
							if (u) allMemberUsers.push(u);
						}
						for (const u of allMemberUsers) {
							notifyBoardShared(boardId, board.name, u.email, u.username, caller.username, shareRole, baseUrl);
						}
					}
				}
			}
		}
	});

	return json({ success: true });
};

/** PATCH — Toggle public visibility of a board. */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const caller = requireUser(locals.user);
	const boardId = pathId(params.id, 'board');
	const body = await readBody(request);

	const isPublic = inTransaction(() => {
		const board = requireBoardOwner(caller, boardId, 'Only board owners and admins can change visibility');

		// `true` or `false`, and it must be sent: `{}` made the board private, and
		// `"false"` made it public.
		const isPublic = readBoolean(body, 'isPublic', { required: true, keep: board.isPublic });
		db.update(boards)
			.set({ isPublic })
			.where(eq(boards.id, boardId))
			.run();
		return isPublic;
	});

	return json({ success: true, isPublic });
};

/**
 * DELETE — Remove access from a user or team.
 *
 * Removing a share that is not there is `404`, after the owner's check, as
 * removing anything else that is not there is: it answered success, so a
 * second tab's remove of a share already gone was said to be done.
 */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	const caller = requireUser(locals.user);
	const boardId = pathId(params.id, 'board');
	const body = await readBody(request);

	inTransaction(() => {
		requireBoardOwner(caller, boardId, 'Only board owners and admins can manage sharing');

		const type = readChoice(body, 'type', { from: SHARE_TYPES, required: true, says: SHARE_TYPE_SAYS });
		const targetId = readId(body, 'targetId', { required: true });

		const removed = type === 'user'
			? db.delete(boardMembers)
				.where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, targetId)))
				.run()
			: db.delete(boardTeams)
				.where(and(eq(boardTeams.boardId, boardId), eq(boardTeams.teamId, targetId)))
				.run();
		if (removed.changes === 0) {
			throw error(404, type === 'user' ? 'This board is not shared with that user' : 'This board is not shared with that team');
		}
	});

	return json({ success: true });
};
