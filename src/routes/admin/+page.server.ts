import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { getDbPath } from '$lib/server/db';
import { boards, columns, cards, subtasks, categories, users, teams, teamMembers } from '$lib/server/db/schema';
import { count, eq } from 'drizzle-orm';
import { statSync } from 'node:fs';

export const load: PageServerLoad = async ({ locals }) => {
	// Board stats
	const allBoards = db.select().from(boards).all();
	const stats = allBoards.map((board) => {
		const colCount = db.select({ count: count() }).from(columns).where(eq(columns.boardId, board.id)).get();
		const cardCount = db
			.select({ count: count() })
			.from(cards)
			.innerJoin(columns, eq(cards.columnId, columns.id))
			.where(eq(columns.boardId, board.id))
			.get();
		const catCount = db.select({ count: count() }).from(categories).where(eq(categories.boardId, board.id)).get();
		return {
			...board,
			columnCount: colCount?.count || 0,
			cardCount: cardCount?.count || 0,
			categoryCount: catCount?.count || 0
		};
	});

	// All users
	const allUsers = db.select({
		id: users.id,
		username: users.username,
		email: users.email,
		emoji: users.emoji,
		role: users.role,
		createdAt: users.createdAt
	}).from(users).all();

	// All teams with member counts
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

	// Database size (main file + WAL + SHM — SQLite WAL mode splits data across all three)
	let dbSizeBytes = 0;
	try {
		const dbPath = getDbPath();
		for (const suffix of ['', '-wal', '-shm']) {
			try { dbSizeBytes += statSync(dbPath + suffix).size; } catch {}
		}
	} catch {}

	return {
		boards: stats,
		users: allUsers,
		teams: teamsWithMembers,
		currentUser: locals.user,
		dbSizeBytes
	};
};
