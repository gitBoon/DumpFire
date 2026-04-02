/**
 * board-access.ts — Server-side board access control utilities.
 *
 * Centralises logic for determining whether a user can view/edit a board
 * based on direct membership, team membership, admin role, or public visibility.
 */

import { db } from './db';
import { boardMembers, boardTeams, teamMembers, boards } from './db/schema';
import { eq, and, inArray, or } from 'drizzle-orm';
import type { SessionUser } from './auth';

export type BoardRole = 'owner' | 'editor' | 'viewer';

/**
 * Get the effective role a user has on a board.
 * Returns null if no access.
 * Priority: admin/superadmin → direct member → team member → public (viewer)
 */
export function getBoardRole(user: SessionUser, boardId: number): BoardRole | 'admin' | null {
	// Admins/superadmins always have full access
	if (user.role === 'admin' || user.role === 'superadmin') {
		return 'admin';
	}

	// Check if user is the board creator
	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) return null;

	if (board.createdBy === user.id) {
		return 'owner';
	}

	// Check direct board membership
	const directMember = db.select()
		.from(boardMembers)
		.where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, user.id)))
		.get();

	if (directMember) {
		return directMember.role as BoardRole;
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
export function getAccessibleBoardIds(user: SessionUser): number[] | null {
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
export function canEditBoard(user: SessionUser, boardId: number): boolean {
	const role = getBoardRole(user, boardId);
	return role === 'admin' || role === 'owner' || role === 'editor';
}

/**
 * Check if user can view a board.
 */
export function canViewBoard(user: SessionUser, boardId: number): boolean {
	return getBoardRole(user, boardId) !== null;
}
