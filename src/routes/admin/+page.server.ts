import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/board-access';
import { mayManageAccount } from '$lib/account-rule';
import { db, sqlite } from '$lib/server/db';
import { getDbPath } from '$lib/server/db';
import { defaultOutside } from '$lib/server/db/restore';
import { isFailureAddress, settingsSetBy } from '$lib/server/setting-setters';
import { TWO_STEP_RELEASED_AT, passwordSetUpEnds } from '$lib/server/mfa-store';
import { stamp } from '$lib/timestamps';
import { readableCountSql, readyReadableCounts } from '$lib/server/webhooks';
import { uploadSpace } from '$lib/server/upload-space';
import { keyEnded } from '$lib/server/auth';
import { TWO_STEP_REQUIRED_AT, administratorsWithoutFactor } from '$lib/server/two-step-switch';
import { apiKeys, boards, columns, cards, categories, users, teams, teamMembers } from '$lib/server/db/schema';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { statSync } from 'node:fs';

/** An account that holds no second factor, as a condition on `users` (card 3064). */
const holdsNoFactor = sql`NOT EXISTS (SELECT 1 FROM "mfa_factors" WHERE "mfa_factors"."user_id" = "users"."id")`;

/**
 * What the Admin page's Two-step sign-in panel shows (card 3064, R10, S-L7,
 * S-M6, D24), read at `now` for `caller`: whether two-step sign-in is
 * required (the switch's row there, as `twoStepRequired` reads it) and since
 * when; the enabled accounts that have set up no second factor; the sessions
 * made on a password alone, which requiring it ends; the superadmin and every
 * enabled administrator holding no factor, by name, for while any is listed
 * it cannot be required (`administratorsWithoutFactor`, the route's own
 * rule); and the API keys of enabled accounts holding no factor that still
 * work (`keyEnded`, the gate's rule), which outlive requiring it until the key
 * deadline (E4). Those keys are listed by holder and dates for the superadmin
 * alone, whose action this is, and only counted for any other administrator:
 * never a key's name or prefix, as nowhere else in this load. `mayRequire`
 * says whether the caller is offered the button. The state and both counts
 * in one read.
 */
function twoStepSwitchView(caller: { id: number; role: string }, now: number) {
	const state = sqlite
		.prepare(
			'SELECT EXISTS (SELECT 1 FROM settings WHERE key = @key) AS required, (SELECT value FROM settings WHERE key = @key) AS requiredAt, ' +
				'(SELECT COUNT(*) FROM users WHERE disabled_at IS NULL AND NOT EXISTS (SELECT 1 FROM mfa_factors WHERE mfa_factors.user_id = users.id)) AS accounts, ' +
				'(SELECT COUNT(*) FROM sessions WHERE two_step = 0) AS passwordOnly'
		)
		.get({ key: TWO_STEP_REQUIRED_AT }) as { required: number; requiredAt: string | null; accounts: number; passwordOnly: number };
	const nowStamp = stamp(new Date(now));
	const keys = db
		.select({
			id: apiKeys.id,
			keyHash: apiKeys.keyHash,
			expiresAt: apiKeys.expiresAt,
			deadlineAt: apiKeys.deadlineAt,
			createdAt: apiKeys.createdAt,
			lastUsedAt: apiKeys.lastUsedAt,
			holder: users.username,
			holderId: users.id
		})
		.from(apiKeys)
		.innerJoin(users, eq(users.id, apiKeys.userId))
		.where(and(isNull(users.disabledAt), holdsNoFactor))
		.orderBy(apiKeys.id)
		.all()
		.filter((key) => !keyEnded(key, nowStamp))
		.map(({ id, createdAt, lastUsedAt, holder, holderId }) => ({ id, createdAt, lastUsedAt, holder, holderId }));
	const superadmin = caller.role === 'superadmin';
	return {
		required: state.required === 1,
		requiredAt: state.requiredAt,
		accountsWithoutFactor: state.accounts,
		passwordOnlySessions: state.passwordOnly,
		administratorsWithoutFactor: administratorsWithoutFactor(),
		keysWithoutFactor: keys.length,
		keysWithoutFactorListed: superadmin ? keys : null,
		mayRequire: superadmin
	};
}

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
	//
	// `settingsSet`, by the same rule: the mail settings, the App URL and the
	// backup destinations a role change to user or a delete of the account
	// would remove (card 2397's review), or null where it would remove none.
	// The users panel names them in its confirmation before anything is sent.
	const caller = locals.user;
	const held = settingsSetBy();
	const now = Date.now();
	const mayReset = (target: { id: number; role: string }) => target.id !== caller.id && mayManageAccount(caller, target);
	// `stamp_of`, which the readable count below reads (card 2935, P1).
	readyReadableCounts();
	const allUsers = db.select({
		id: users.id,
		username: users.username,
		email: users.email,
		emoji: users.emoji,
		role: users.role,
		createdAt: users.createdAt,
		// Card 2671: when the account was disabled, by whom by name, and whether
		// by the superadmin, whose disable only the superadmin undoes (S14). Null
		// for an account that is enabled, and the name for a disabler since deleted.
		disabledAt: users.disabledAt,
		disabledByName: sql<string | null>`(SELECT "d"."username" FROM "users" AS "d" WHERE "d"."id" = "users"."disabled_by")`,
		disabledBySuperadmin: sql<number>`EXISTS (SELECT 1 FROM "users" AS "d" WHERE "d"."id" = "users"."disabled_by" AND "d"."role" = 'superadmin')`,
		// The backup settings as stored, read in this one query, for whether the
		// account's address is among the backup failure address (card 2671, S7),
		// which disabling takes it out of whatever the role (the code review's
		// CS2): the users panel names it in the disable's confirmation. Read by
		// `isFailureAddress`, the rule the removal asks (CR9), and never answered.
		backupConfig: sql<string | null>`(SELECT "value" FROM "settings" WHERE "settings"."key" = 'backup_config')`,
		apiKeys: sql<number>`(SELECT COUNT(*) FROM "api_keys" WHERE "api_keys"."user_id" = "users"."id")`,
		webhooks: sql<number>`(SELECT COUNT(*) FROM "webhooks" WHERE "webhooks"."set_by" = "users"."id" AND "webhooks"."active" = 1)`,
		// And those it set that are already off with no hold, which an ending holds too (card 2923; card 2935, F6).
		webhooksAlreadyOff: sql<number>`(SELECT COUNT(*) FROM "webhooks" WHERE "webhooks"."set_by" = "users"."id" AND "webhooks"."active" = 0 AND "webhooks"."held_because" IS NULL)`,
		// The webhooks of others whose secret the account could read, as an ending of its access would hold them
		// (card 2935, P11): the hold's own predicate, one correlated subquery in this one query.
		webhooksReadable: sql<number>`${sql.raw(readableCountSql('"users"."id"', '"users"."role"'))}`,
		reportSchedules: sql<number>`(SELECT COUNT(*) FROM "report_schedules" WHERE "report_schedules"."user_id" = "users"."id" AND "report_schedules"."enabled" = 1)`,
		// Whether the account holds a second factor (card 2773): the panel offers
		// its reset, and refuses its invite, which would not work. By the same
		// rule as the counts: null for an account the caller may not reset.
		twoStep: sql<number>`EXISTS (SELECT 1 FROM "mfa_factors" WHERE "mfa_factors"."user_id" = "users"."id")`,
		// When the release of two-step sign-in was, for an account that may
		// still set one up on its password alone: marked, holding no factor and
		// no link but the release mail's (card 2769, decision 25 and CS4), while
		// no mail host is set up, since a sign-in is then mailed a link instead
		// (CR10; `isSmtpConfigured`'s rule, read in this one query), and never
		// once mail has been set up here (card 2922, R9: `mailEverConfigured`).
		// Null for any other. The 14 days are added below.
		releasedAt: sql<string | null>`CASE WHEN "users"."mfa_password_enrol" = 1 AND NOT EXISTS (SELECT 1 FROM "mfa_factors" WHERE "mfa_factors"."user_id" = "users"."id") AND NOT EXISTS (SELECT 1 FROM "enrolment_links" WHERE "enrolment_links"."user_id" = "users"."id" AND "enrolment_links"."issued_by" <> 'release-mail') AND NOT EXISTS (SELECT 1 FROM "settings" WHERE "settings"."key" = 'smtp_host' AND coalesce("settings"."value", '') <> '') AND NOT EXISTS (SELECT 1 FROM "settings" WHERE "settings"."key" = 'mail_ever_configured_at') THEN (SELECT "value" FROM "settings" WHERE "settings"."key" = ${TWO_STEP_RELEASED_AT}) END`
	}).from(users).all()
		.map(({ releasedAt, backupConfig, ...user }) => {
			const counted = mayReset(user);
			// Until when it may, while the 14 days are running; null once they
			// are over. Shown on the caller's own row too, which offers no
			// reset: it is the caller's own leave (CR10).
			const until = passwordSetUpEnds(releasedAt);
			const shown = counted || user.id === caller.id;
			return {
				...user,
				disabledBySuperadmin: user.disabledBySuperadmin === 1,
				// For every row (the code review's CS2): a disable takes any account's address out.
				failureAddress: isFailureAddress(backupConfig, user.email),
				apiKeys: counted ? user.apiKeys : null,
				webhooks: counted ? user.webhooks : null,
				webhooksAlreadyOff: counted ? user.webhooksAlreadyOff : null,
				webhooksReadable: counted ? user.webhooksReadable : null,
				reportSchedules: counted ? user.reportSchedules : null,
				twoStep: counted ? user.twoStep === 1 : null,
				passwordSetUpUntil: shown && until !== null && until.getTime() > now ? stamp(until) : null,
				settingsSet: counted ? (held.get(user.id) ?? null) : null
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
		// The uploads volume's free space, the line below which uploads are
		// refused, and whether they are (card 2920). A look like an upload's:
		// a change of state is said once in the log.
		uploadsSpace: await uploadSpace(),
		// Which way the import dialog opens: the choice the import route makes
		// when it is given none.
		importOutsideDefault: defaultOutside(),
		// The Two-step sign-in panel (card 3064, R10): its state, its counts, who
		// holds no factor, and the keys that outlive requiring it.
		twoStepSwitch: twoStepSwitchView(caller, now)
	};
};
