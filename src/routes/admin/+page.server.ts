import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/board-access';
import { mayManageAccount } from '$lib/account-rule';
import { db } from '$lib/server/db';
import { getDbPath } from '$lib/server/db';
import { defaultOutside } from '$lib/server/db/restore';
import { boards, columns, cards, subtasks, categories, users, teams, teamMembers } from '$lib/server/db/schema';
import { count, eq, sql } from 'drizzle-orm';
import { statSync } from 'node:fs';

export const load: PageServerLoad = async ({ locals }) => {
	// Administrators only. ADMIN_ROUTES in hooks.server.ts turns everyone else
	// away before this runs, with the same two redirects. It is asked again
	// here because this load hands back every user's name, email and role, and
	// the gate was once the only thing in front of it and was got round.
	if (!locals.user) throw redirect(303, '/login');
	if (!isAdmin(locals.user)) throw redirect(303, '/');

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

	// All users, each with how many API keys they hold, how many webhooks they
	// set that are on, and how many of their report schedules are on. A reset
	// of a user's password ends every key, switches off every such webhook and
	// pauses every such schedule (card 2168), and the reset dialog says how
	// many before it is confirmed. The counts only: never a key's name or
	// prefix, nor a webhook's address.
	// Written out with the table names: Drizzle writes a column of a query on
	// one table without its table's name, and inside the sub-select a bare
	// "id" is the key's.
	//
	// The counts go only with an account whose password the caller may
	// reset, and are null for any other: the caller's own, which the reset
	// route refuses, and the superadmin's or another administrator's, which
	// requireManagedAccount refuses an ordinary administrator. There is no
	// reset there to warn of, and nobody else's keys, webhooks or schedules
	// are the caller's to count.
	// The rule is the one the route asks, from $lib/account-rule.ts.
	const caller = locals.user;
	const mayReset = (target: { id: number; role: string }) => target.id !== caller.id && mayManageAccount(caller, target);
	const allUsers = db.select({
		id: users.id,
		username: users.username,
		email: users.email,
		emoji: users.emoji,
		role: users.role,
		createdAt: users.createdAt,
		apiKeys: sql<number>`(SELECT COUNT(*) FROM "api_keys" WHERE "api_keys"."user_id" = "users"."id")`,
		webhooks: sql<number>`(SELECT COUNT(*) FROM "webhooks" WHERE "webhooks"."set_by" = "users"."id" AND "webhooks"."active" = 1)`,
		reportSchedules: sql<number>`(SELECT COUNT(*) FROM "report_schedules" WHERE "report_schedules"."user_id" = "users"."id" AND "report_schedules"."enabled" = 1)`
	}).from(users).all()
		.map((user) => {
			const counted = mayReset(user);
			return {
				...user,
				apiKeys: counted ? user.apiKeys : null,
				webhooks: counted ? user.webhooks : null,
				reportSchedules: counted ? user.reportSchedules : null
			};
		});

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
		dbSizeBytes,
		// Which way the import dialog opens: the choice the import route makes
		// when it is given none.
		importOutsideDefault: defaultOutside()
	};
};
