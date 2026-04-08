import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, boardMembers, boardTeams, users, teams, teamMembers } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import { notifyBoardShared } from '$lib/server/notifications';
import { resolveBaseUrl } from '$lib/server/email';
import type { RequestHandler } from './$types';

/** GET — List all members and teams with access to this board, plus public status. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.id);
	const role = getBoardRole(locals.user, boardId);
	if (!role) throw error(403, 'No access to this board');

	// Get board for public status
	const board = db.select({ isPublic: boards.isPublic }).from(boards).where(eq(boards.id, boardId)).get();

	// Get individual members
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
	.all();

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

	return json({ members, teams: teamAccess, isPublic: board?.isPublic ?? false });
};

/** POST — Share board with a user or team. */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.id);
	const userRole = getBoardRole(locals.user, boardId);

	// Only owners and admins can share
	if (userRole !== 'owner' && userRole !== 'admin') {
		throw error(403, 'Only board owners and admins can share boards');
	}

	const { type, targetId, role } = await request.json();
	const shareRole = role || 'viewer';

	if (type === 'user') {
		// Check user exists
		const user = db.select().from(users).where(eq(users.id, targetId)).get();
		if (!user) throw error(404, 'User not found');

		// Upsert board member
		const existing = db.select()
			.from(boardMembers)
			.where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, targetId)))
			.get();

		if (existing) {
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
				const baseUrl = resolveBaseUrl(request, url);
				notifyBoardShared(boardId, board.name, user.email, user.username, locals.user.username, shareRole, baseUrl);
			}
		}
	} else if (type === 'team') {
		// Check team exists
		const team = db.select().from(teams).where(eq(teams.id, targetId)).get();
		if (!team) throw error(404, 'Team not found');

		// Upsert board team
		const existing = db.select()
			.from(boardTeams)
			.where(and(eq(boardTeams.boardId, boardId), eq(boardTeams.teamId, targetId)))
			.get();

		if (existing) {
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
				const baseUrl = resolveBaseUrl(request, url);
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
						notifyBoardShared(boardId, board.name, u.email, u.username, locals.user.username, shareRole, baseUrl);
					}
				}
			}
		}
	} else {
		throw error(400, 'type must be "user" or "team"');
	}

	return json({ success: true });
};

/** PATCH — Toggle public visibility of a board. */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.id);
	const userRole = getBoardRole(locals.user, boardId);

	if (userRole !== 'owner' && userRole !== 'admin') {
		throw error(403, 'Only board owners and admins can change visibility');
	}

	const { isPublic } = await request.json();

	db.update(boards)
		.set({ isPublic: !!isPublic })
		.where(eq(boards.id, boardId))
		.run();

	return json({ success: true, isPublic: !!isPublic });
};

/** DELETE — Remove access from a user or team. */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const boardId = Number(params.id);
	const userRole = getBoardRole(locals.user, boardId);

	if (userRole !== 'owner' && userRole !== 'admin') {
		throw error(403, 'Only board owners and admins can manage sharing');
	}

	const { type, targetId } = await request.json();

	if (type === 'user') {
		db.delete(boardMembers)
			.where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, targetId)))
			.run();
	} else if (type === 'team') {
		db.delete(boardTeams)
			.where(and(eq(boardTeams.boardId, boardId), eq(boardTeams.teamId, targetId)))
			.run();
	}

	return json({ success: true });
};
