/**
 * board-access.ts — Server-side board access control utilities.
 *
 * Centralises logic for determining whether a user can view/edit a board
 * based on direct membership, team membership, admin role, or public visibility.
 */

import { db } from './db';
import { boardMembers, boardTeams, teamMembers, boards, type Board } from './db/schema';
import { eq, and, inArray, or } from 'drizzle-orm';
import type { SessionUser } from './auth';

export type BoardRole = 'owner' | 'editor' | 'viewer';

/** The roles a member row can give. Any other text stored in one counts as `viewer`. */
const BOARD_ROLES: readonly BoardRole[] = ['owner', 'editor', 'viewer'];

/**
 * All an access decision needs to know about the caller. Narrower than
 * `SessionUser` so a plain user row can be checked too — when deciding whether
 * someone else may be assigned a card, say.
 */
export type Actor = Pick<SessionUser, 'id' | 'role'>;

/**
 * True for both administrator roles.
 *
 * Use this rather than comparing `role` to `'admin'`: a bare comparison locks
 * superadmin out of whatever it guards, which is how the most privileged
 * account ended up unable to read the audit log.
 */
export function isAdmin(user: Pick<SessionUser, 'role'> | null | undefined): boolean {
	return user?.role === 'admin' || user?.role === 'superadmin';
}

/**
 * Get the effective role a user has on a board.
 * Returns null if no access.
 * Priority: admin/superadmin → direct member → team member → public (viewer)
 */
export function getBoardRole(user: Actor, boardId: number): BoardRole | 'admin' | null {
	// Admins/superadmins always have full access
	if (user.role === 'admin' || user.role === 'superadmin') {
		return 'admin';
	}

	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) return null;

	return roleOnBoard(user, board);
}

/**
 * The same answer as `getBoardRole`, for a board whose row the caller has
 * already read: it does not read the row again. The board page's breadcrumb
 * walk reads each board above it, and asked `canViewBoard` of each, which read
 * it a second time (card 2172's note, folded in by card 2280).
 */
export function roleOnBoard(user: Actor, board: Pick<Board, 'id' | 'createdBy' | 'isPublic'>): BoardRole | 'admin' | null {
	if (user.role === 'admin' || user.role === 'superadmin') {
		return 'admin';
	}
	const boardId = board.id;

	// Check if user is the board creator
	if (board.createdBy === user.id) {
		return 'owner';
	}

	// Check direct board membership
	const directMember = db.select()
		.from(boardMembers)
		.where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, user.id)))
		.get();

	if (directMember) {
		// The share routes stored any text as a role until card 2117 read it:
		// `admin` among them, which a bare cast handed on as the administrator's
		// role. A role that is not one of the three is read as the least.
		return BOARD_ROLES.includes(directMember.role as BoardRole) ? (directMember.role as BoardRole) : 'viewer';
	}

	// Check team-based access
	const userTeams = db.select({ teamId: teamMembers.teamId })
		.from(teamMembers)
		.where(eq(teamMembers.userId, user.id))
		.all();

	if (userTeams.length > 0) {
		const teamIds = userTeams.map(t => t.teamId);
		const teamAccess = db.select()
			.from(boardTeams)
			.where(and(
				eq(boardTeams.boardId, boardId),
				inArray(boardTeams.teamId, teamIds)
			))
			.all();

		if (teamAccess.length > 0) {
			// Return highest role from team access
			const roles = teamAccess.map(t => t.role);
			if (roles.includes('editor')) return 'editor';
			return 'viewer';
		}
	}

	// Public boards grant viewer access to any authenticated user
	if (board.isPublic) {
		return 'viewer';
	}

	return null;
}

/**
 * Get all board IDs a user has access to.
 * For regular users: owned boards + direct member + team member boards + public boards.
 * For admins: all boards (returns null to indicate "no filter needed").
 */
export function getAccessibleBoardIds(user: Actor): number[] | null {
	if (user.role === 'admin' || user.role === 'superadmin') {
		return null; // No filter — sees everything
	}

	const ids = new Set<number>();

	// Boards created by this user
	const ownedBoards = db.select({ id: boards.id })
		.from(boards)
		.where(eq(boards.createdBy, user.id))
		.all();
	ownedBoards.forEach(b => ids.add(b.id));

	// Direct board memberships
	const directBoards = db.select({ boardId: boardMembers.boardId })
		.from(boardMembers)
		.where(eq(boardMembers.userId, user.id))
		.all();
	directBoards.forEach(b => ids.add(b.boardId));

	// Team-based board access
	const userTeams = db.select({ teamId: teamMembers.teamId })
		.from(teamMembers)
		.where(eq(teamMembers.userId, user.id))
		.all();

	if (userTeams.length > 0) {
		const teamIds = userTeams.map(t => t.teamId);
		const teamBoards = db.select({ boardId: boardTeams.boardId })
			.from(boardTeams)
			.where(inArray(boardTeams.teamId, teamIds))
			.all();
		teamBoards.forEach(b => ids.add(b.boardId));
	}

	// Public boards — visible to everyone
	const publicBoards = db.select({ id: boards.id })
		.from(boards)
		.where(eq(boards.isPublic, true))
		.all();
	publicBoards.forEach(b => ids.add(b.id));

	return Array.from(ids);
}

/**
 * Check if user can edit a board (owner, editor, or admin).
 */
export function canEditBoard(user: Actor, boardId: number): boolean {
	const role = getBoardRole(user, boardId);
	return role === 'admin' || role === 'owner' || role === 'editor';
}

/**
 * Check if user can view a board.
 */
export function canViewBoard(user: Actor, boardId: number): boolean {
	return getBoardRole(user, boardId) !== null;
}
