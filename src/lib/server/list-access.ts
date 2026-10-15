/**
 * list-access.ts — what a list answers a caller, decided in one place.
 *
 * A list gives rows of many boards at once, so no guard of one board covers it.
 * Each function here takes the caller and gives only what they may be told,
 * filtered in the query and before any limit: a filter applied after a limit
 * hands back fewer rows than were asked for.
 */
import { and, asc, desc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import { db } from './db';
import {
	activityLog,
	boardCategories,
	boards,
	cards,
	categories,
	columns,
	teamMembers,
	teams,
	users,
	type ActivityLog,
	type Board,
	type BoardCategory,
	type Category,
	type Team
} from './db/schema';
import { getAccessibleBoardIds, isAdmin, type Actor } from './board-access';
import { completeColumnIds } from '$lib/column-role';

/**
 * The caller's own entries in the activity log, newest first, on the boards
 * they can open (card 2126). `GET /api/v1/me/stats` lists 20 and the dashboard
 * 10.
 *
 * Both listed every entry of the caller's, so someone taken off a board went
 * on reading what was done there, card titles included. The counts beside them
 * (completed, streak, cycle time) are not filtered: they name nothing, and are
 * the caller's own record. An administrator opens every board and is given
 * every entry. Entries made in the same second are listed newest first by id.
 *
 * The board is asked as `+board_id`, which SQLite cannot answer from an
 * index: so it reads the log newest first by `idx_activity_log_created_at`
 * and stops at the limit. Asked plainly, it took the index of board and time
 * for the boards, then sorted every entry of the caller's on them (55 ms
 * against 2.9 ms, on 200,000 entries).
 */
export function recentActivityFor(user: Actor, limit: number): ActivityLog[] {
	const boardIds = getAccessibleBoardIds(user);
	if (boardIds !== null && boardIds.length === 0) return [];

	return db
		.select()
		.from(activityLog)
		.where(
			and(
				eq(activityLog.userId, user.id),
				boardIds === null ? undefined : inArray(sql`+${activityLog.boardId}`, boardIds)
			)
		)
		.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
		.limit(limit)
		.all();
}

/** A user as the user list gives one: to an administrator, with the three fields after `emoji`. */
export type ListedUser = {
	id: number;
	username: string;
	emoji: string | null;
	email?: string;
	role?: string;
	createdAt?: string;
};

/**
 * Every user, for the share dialog's and the teams page's pickers (card 2128,
 * decision 1): `id`, `username` and `emoji` to anyone signed in, and `email`,
 * `role` and `createdAt` to an administrator as well.
 *
 * Everybody is listed: a board's owner may share it with anyone, and the
 * public request form already names every user. An address and a role are
 * not needed to pick someone, and every signed-in account read every
 * colleague's.
 */
export function listUsersFor(user: Actor): ListedUser[] {
	if (isAdmin(user)) {
		return db
			.select({ id: users.id, username: users.username, email: users.email, emoji: users.emoji, role: users.role, createdAt: users.createdAt })
			.from(users)
			.all();
	}
	return db.select({ id: users.id, username: users.username, emoji: users.emoji }).from(users).all();
}

/** A member of a team, as the team list gives one. */
export type ListedTeamMember = { userId: number; role: string; username: string; emoji: string | null };

/**
 * Every team, with its members on the teams the caller is in, and on every
 * team for an administrator (card 2128, decision 2). Any other team is listed
 * with no `members` key.
 *
 * A team's name is for everyone, as a username is: the share dialog shares a
 * board with any team and the public request form names every one. Who is in
 * it is not: it was given to every signed-in caller, for every team.
 */
export function listTeamsFor(user: Actor): (Team & { members?: ListedTeamMember[] })[] {
	const mine = isAdmin(user)
		? null
		: new Set(
				db
					.select({ teamId: teamMembers.teamId })
					.from(teamMembers)
					.where(eq(teamMembers.userId, user.id))
					.all()
					.map((m) => m.teamId)
			);

	return db
		.select()
		.from(teams)
		.all()
		.map((team) => {
			if (mine && !mine.has(team.id)) return team;
			const members = db
				.select({ userId: teamMembers.userId, role: teamMembers.role, username: users.username, emoji: users.emoji })
				.from(teamMembers)
				.innerJoin(users, eq(teamMembers.userId, users.id))
				.where(eq(teamMembers.teamId, team.id))
				.all();
			return { ...team, members };
		});
}

/**
 * Which dashboard groupings the caller is listed (card 2128, decision 4): one
 * that holds at least one board they can open, or holds no board at all.
 * Every grouping, for an administrator.
 *
 * An empty grouping is listed because one made in Manage Categories holds
 * nothing until a board is filed under it, and anybody may already rename or
 * delete it. A grouping all of whose boards the caller cannot open is
 * another team's, and its name was given to everyone.
 *
 * The one rule for the list routes, the dashboard, All Tasks and Reports, the
 * read of one grouping, the burndown by grouping and filing a board under
 * one: a grouping a caller could file a board under would be one more name
 * they can make listed to themselves.
 */
export function boardCategoryRule(user: Actor): (groupingId: number) => boolean {
	const open = getAccessibleBoardIds(user);
	if (open === null) return () => true;

	const opens = new Set(open);
	const holding = new Set<number>();
	const holdingOpen = new Set<number>();
	for (const b of db
		.select({ id: boards.id, categoryId: boards.categoryId })
		.from(boards)
		.where(isNotNull(boards.categoryId))
		.all()) {
		holding.add(b.categoryId!);
		if (opens.has(b.id)) holdingOpen.add(b.categoryId!);
	}
	return (groupingId) => !holding.has(groupingId) || holdingOpen.has(groupingId);
}

/** The groupings `boardCategoryRule` lists to the caller, by name, as both list routes answer them. */
export function boardCategoriesFor(user: Actor): BoardCategory[] {
	const listed = boardCategoryRule(user);
	return db
		.select()
		.from(boardCategories)
		.orderBy(asc(boardCategories.name))
		.all()
		.filter((grouping) => listed(grouping.id));
}

/** A card category as a page or a list gives one. `carried`: see `cardCategoriesFor`. */
export type ListedCategory = Category & { carried?: true };

/**
 * Whether a card category is the caller's to read and to pick (card 2128,
 * decision 5): one that belongs to no board, or one of a board they can
 * open. Every one, for an administrator.
 *
 * Each category belongs to the board it was made on: a card moved to another
 * board drops it, and a card is filed only under its own board's or a shared
 * one. Every board's was listed to every signed-in caller, as a "shared
 * vocabulary", which described the picker, not a need.
 */
export function categoryRule(user: Actor): (category: Pick<Category, 'boardId'>) => boolean {
	const open = getAccessibleBoardIds(user);
	if (open === null) return () => true;
	const opens = new Set(open);
	return (category) => category.boardId === null || opens.has(category.boardId);
}

/**
 * The card categories `categoryRule` lists to the caller, by name, and any
 * other that one of `shown` carries, marked `carried: true`.
 *
 * `shown` is the cards a page or an answer shows. A card may still carry a
 * category of another board, given it before a card was held to its own
 * board's and the shared ones, and its chip is named from the page's own
 * list: left out, the chip would lose its name. A carried category is that
 * card's and no other's: the card dialog offers only the card's board's and
 * the shared ones, and a copy takes no other (`categoryToCopy`).
 */
export function cardCategoriesFor(user: Actor, shown: { categoryId: number | null }[] = []): ListedCategory[] {
	const listed = categoryRule(user);
	const carried = new Set(shown.map((card) => card.categoryId).filter((id) => id !== null));
	const all = db.select().from(categories).orderBy(asc(categories.name)).all();
	return all.flatMap((category) => {
		if (listed(category)) return [category];
		return carried.has(category.id) ? [{ ...category, carried: true as const }] : [];
	});
}

/**
 * The sub-boards the caller can open (card 2130, decision 9): those under one
 * of the cards `parentCardIds`, or under any card when it is left out. Every
 * one, for an administrator.
 *
 * A sub-board is a board of its own and inherits nothing from the board its
 * card is on: only whoever made it is given it. The board page, the card
 * context and the dashboard listed every sub-board of a card, so a member of
 * the parent board read the name, progress and cost of one they were never
 * given. One they cannot open is left out, as the graph leaves it out (cards
 * 2101 to 2131).
 */
export function subBoardsFor(user: Actor, parentCardIds?: number[]): Board[] {
	if (parentCardIds !== undefined && parentCardIds.length === 0) return [];
	const open = getAccessibleBoardIds(user);
	if (open !== null && open.length === 0) return [];

	return db
		.select()
		.from(boards)
		.where(
			and(
				parentCardIds === undefined ? isNotNull(boards.parentCardId) : inArray(boards.parentCardId, parentCardIds),
				open === null ? undefined : inArray(boards.id, open)
			)
		)
		.all();
}

/**
 * How many cards that are not complete each of `parentCardIds` has on the
 * sub-boards under it that the caller cannot open, by card: a number, with
 * no name (card 2130's review). A card is absent when it has none, and every
 * card is absent for an administrator, who opens every sub-board.
 *
 * `subBoardsFor` leaves such a sub-board off its card, but the server still
 * refuses to complete the card while it has open cards
 * (`getCompletionBlocker`, which counts them as this does: every card on the
 * sub-board's own columns that is not in a complete one). The board page
 * asks this before a drop onto Complete, so that it does not show the card
 * as done and then have it refused.
 */
export function hiddenOpenCountsFor(user: Actor, parentCardIds: number[]): Map<number, number> {
	const counts = new Map<number, number>();
	if (parentCardIds.length === 0) return counts;
	const open = getAccessibleBoardIds(user);
	if (open === null) return counts;

	const hidden = db
		.select({ id: boards.id, parentCardId: boards.parentCardId })
		.from(boards)
		.where(and(inArray(boards.parentCardId, parentCardIds), open.length > 0 ? notInArray(boards.id, open) : undefined))
		.all();
	for (const sb of hidden) {
		const cols = db.select({ id: columns.id, title: columns.title }).from(columns).where(eq(columns.boardId, sb.id)).all();
		if (cols.length === 0) continue;
		const complete = completeColumnIds(cols);
		const notDone = db
			.select({ columnId: cards.columnId })
			.from(cards)
			.where(inArray(cards.columnId, cols.map((c) => c.id)))
			.all()
			.filter((card) => !complete.has(card.columnId)).length;
		if (notDone > 0) counts.set(sb.parentCardId!, (counts.get(sb.parentCardId!) ?? 0) + notDone);
	}
	return counts;
}
