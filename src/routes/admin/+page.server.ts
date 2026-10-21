import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/board-access';
import { mayManageAccount } from '$lib/account-rule';
import { db } from '$lib/server/db';
import { getDbPath } from '$lib/server/db';
import { defaultOutside } from '$lib/server/db/restore';
import { boards, columns, cards, categories, users, teams, teamMembers } from '$lib/server/db/schema';
import { count, eq, sql } from 'drizzle-orm';
import { statSync } from 'node:fs';

export const load: PageServerLoad = async ({ locals }) => {
	// Administrators only. ADMIN_ROUTES in hooks.server.ts turns everyone else
	// away before this runs, with the same two redirects. It is asked again
	// here because this load hands back every user's name, email and role, and
	// the gate was once the only thing in front of it and was got round.
	if (!locals.user) throw redirect(303, '/login');
	if (!isAdmin(locals.user)) throw redirect(303, '/');

	// Board stats: each board's columns, cards (archived ones too) and
	// categories, counted for every board at once (card 2297). They were three
	// queries a board, and every write on this page reads it all again. A
	// board with none is in no group, and counts 0; the shared categories'
	// group, with no board, matches none.
	const allBoards = db.select().from(boards).all();
	const byBoard = (rows: { boardId: number | null; count: number }[]) => new Map(rows.map((row) => [row.boardId, row.count]));
	const columnCounts = byBoard(db.select({ boardId: columns.boardId, count: count() }).from(columns).groupBy(columns.boardId).all());
	const cardCounts = byBoard(
		db
			.select({ boardId: columns.boardId, count: count() })
			.from(cards)
			.innerJoin(columns, eq(cards.columnId, columns.id))
			.groupBy(columns.boardId)
			.all()
	);
	const categoryCounts = byBoard(db.select({ boardId: categories.boardId, count: count() }).from(categories).groupBy(categories.boardId).all());
	const stats = allBoards.map((board) => ({
		...board,
		columnCount: columnCounts.get(board.id) || 0,
		cardCount: cardCounts.get(board.id) || 0,
		categoryCount: categoryCounts.get(board.id) || 0
	}));

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

	// All teams with their members, every team's in one query (card 2297: it
	// was one a team). Each team's are in the order of their ids, as the read
	// of one team gave them (by the key on team and user).
	const allTeams = db.select().from(teams).all();
	const allMembers = db.select({
		teamId: teamMembers.teamId,
		userId: teamMembers.userId,
		role: teamMembers.role,
		username: users.username,
		emoji: users.emoji
	})
	.from(teamMembers)
	.innerJoin(users, eq(teamMembers.userId, users.id))
	.orderBy(teamMembers.teamId, teamMembers.userId)
	.all();
	const membersByTeam = new Map<number, Omit<(typeof allMembers)[number], 'teamId'>[]>();
	for (const { teamId, ...member } of allMembers) {
		const list = membersByTeam.get(teamId) ?? [];
		list.push(member);
		membersByTeam.set(teamId, list);
	}
	const teamsWithMembers = allTeams.map(team => ({ ...team, members: membersByTeam.get(team.id) ?? [] }));

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
