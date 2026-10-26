/**
 * How many reads the admin page's and the dashboard's loads make, and what
 * they answer (cards 2297 and 2298).
 *
 *   - The admin page read each board's column, card and category counts with
 *     three queries a board, and each team's members with one a team; every
 *     write on the page re-runs the load (`invalidateAll()`). It reads them
 *     with one grouped query each now, so the load is the same number of
 *     reads whatever the installation holds.
 *   - The dashboard read each top-level board's columns and cards with two
 *     queries a board, walked All Tasks with two a level of sub-boards, read
 *     the whole subtasks, task_requests, card_assignees and users tables to
 *     filter them in memory, and made two reads for each assignee row of the
 *     leaderboard. It reads its boards' columns and cards once now, walks in
 *     memory, and counts the rest in SQL, scoped to what the caller sees.
 *
 * Each load's reads are counted with `readBudget` (`tests/helpers/reads.ts`),
 * which counts every read statement run while it is installed. The counts are
 * compared between a small installation and a large one, so the test does not
 * pin a number that any later read would change, only that it does not grow.
 * Each load has a ceiling as well: the admin page's handful, and the
 * dashboard's for each caller in the pinned scene (`MOST_READS`), lowered by
 * one for the owner and the outsider when the dashboard stopped reading its
 * caller's cards' columns twice, and by 12 for every caller but the
 * administrator (15 for the mate) when it stopped reading the boards its
 * caller can open four times (card 2393), and by one for every caller when it
 * stopped reading their teams twice (card 2394).
 *
 * What each load answers is pinned as the old load answered it: the cases
 * below were run on the old code before the change and passed there, but for
 * the one leaderboard figure card 2391 changed on purpose (see `PINNED`). The
 * key order is pinned too (`JSON.stringify`), since the page is handed the
 * object as it is. The groupings and the caller's recent activity were added
 * to the scene and to all five pins on purpose in card 2393's review, so that
 * the access list the load hands to the helpers answering them is checked as
 * well; and a list handed to those helpers is shown taken as "every board"
 * only from an administrator.
 *
 * The plan is `docs/planning/cards-2297-2298-2389.md`; card 2391's is
 * `docs/planning/card-2391.md` and card 2393's `docs/planning/card-2393.md`.
 *
 * Milestone 22 (the S1b review's B7) added the board page's load with an
 * Options column holding a card: two reads more than a board without, as
 * many for ten options as for one, pinned at 34
 * (`docs/planning/milestone-22-upstream-kanban.md`, section 7.8).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { defaultOutside } from '$lib/server/db/restore';
import { activityLog, boardCategories, boards, cards, categories, columns, taskRequests, teamMembers, tokenUsage, users, type Card } from '$lib/server/db/schema';
import { boardCategoriesFor, boardCategoryRule, recentActivityFor, subBoardsFor } from '$lib/server/list-access';
import type { SessionUser } from '$lib/server/auth';
import { pageLoad } from './helpers/actions';
import { readBudget } from './helpers/reads';
import {
	addBoardMember,
	assignCard,
	makeBoard,
	makeCard,
	makeSubBoard,
	makeSubtask,
	makeTeam,
	makeUser,
	resetDb,
	shareBoardWithTeam
} from './helpers/fixtures';

beforeEach(() => resetDb());

function dataOf(page: Awaited<ReturnType<typeof pageLoad>>): any {
	expect(page.type).toBe('data');
	return (page as { data: unknown }).data;
}

/** The page's load for `user`, with how many reads it made. */
async function loadCounted(path: string, user: SessionUser) {
	const budget = readBudget(100_000);
	let page;
	try {
		page = await pageLoad(path, { user });
	} finally {
		budget.restore();
	}
	expect(budget.spent).toBe(false);
	return { data: dataOf(page), reads: budget.count };
}

// ─── Card 2297: the admin page ─────────────────────────────────────────────

describe('the admin page’s load (card 2297)', () => {
	/** An installation of `size` boards, each with columns, cards and categories, and `size` teams of two. */
	function installation(size: number) {
		const admin = makeUser({ role: 'admin' });
		const people = [makeUser(), makeUser()];
		for (let i = 0; i < size; i++) {
			const { board, cols } = makeBoard({ owner: admin });
			makeCard(cols['To Do']);
			makeCard(cols['Complete']);
			db.insert(categories).values({ boardId: board.id, name: `Category ${i}` }).run();
			makeTeam(people);
		}
		return admin;
	}

	it('makes the same number of reads for 1 board and 1 team as for 50 of each', async () => {
		const small = (await loadCounted('/admin', installation(1))).reads;
		resetDb();
		const large = (await loadCounted('/admin', installation(50))).reads;

		expect(large).toBe(small);
		// A fixed handful: the boards, three counts, the users, the teams and their members, and
		// who set which setting (card 2397's review: one read of every setter row, and where there
		// are any, one each of the mail settings, the App URL and the destinations, for all accounts).
		expect(small).toBeLessThanOrEqual(8);
	});

	it('answers what it did: each board’s three counts, and each team’s members in the order of their ids', async () => {
		const admin = makeUser({ role: 'admin', username: 'admin' });
		const ann = makeUser({ username: 'ann' });
		const bob = makeUser({ username: 'bob' });
		const full = makeBoard({ owner: admin, name: 'Full' });
		makeCard(full.cols['To Do']);
		makeCard(full.cols['Complete']);
		// Archived cards are counted, as they always were.
		makeCard(full.cols['To Do'], { archivedAt: '2026-01-01 00:00:00' });
		db.insert(categories).values([{ boardId: full.board.id, name: 'One' }, { boardId: full.board.id, name: 'Two' }]).run();
		const bare = makeBoard({ owner: admin, name: 'Bare', columns: ['Only'] });
		const empty = makeBoard({ owner: admin, name: 'Empty', columns: [] });
		// A shared category is no board's.
		db.insert(categories).values({ boardId: null, name: 'Shared' }).run();
		// Bob joins before Ann; each team lists its members by id.
		const both = makeTeam([bob, ann], 'Both');
		const none = makeTeam([], 'None');
		db.update(teamMembers).set({ role: 'owner' }).where(eq(teamMembers.userId, bob.id)).run();

		const { data } = await loadCounted('/admin', admin);

		const counts: Record<number, [number, number, number]> = {
			[full.board.id]: [4, 3, 2],
			[bare.board.id]: [1, 0, 0],
			[empty.board.id]: [0, 0, 0]
		};
		const expected = {
			boards: db.select().from(boards).all().map((board) => ({
				...board,
				columnCount: counts[board.id][0],
				cardCount: counts[board.id][1],
				categoryCount: counts[board.id][2]
			})),
			users: db.select().from(users).all().map((user) => ({
				id: user.id,
				username: user.username,
				email: user.email,
				emoji: user.emoji,
				role: user.role,
				createdAt: user.createdAt,
				// The caller's own counts are not given; an ordinary user's are.
				apiKeys: user.id === admin.id ? null : 0,
				webhooks: user.id === admin.id ? null : 0,
				reportSchedules: user.id === admin.id ? null : 0,
				// Nobody set a mail setting, the App URL or a destination (card 2397's review).
				settingsSet: null
			})),
			teams: [
				{
					...both,
					members: [
						{ userId: ann.id, role: 'member', username: 'ann', emoji: ann.emoji },
						{ userId: bob.id, role: 'owner', username: 'bob', emoji: bob.emoji }
					]
				},
				{ ...none, members: [] }
			],
			currentUser: admin,
			dbSizeBytes: 0,
			importOutsideDefault: defaultOutside()
		};
		expect(JSON.stringify(data)).toBe(JSON.stringify(expected));
	});
});

// ─── Card 2298: the dashboard ──────────────────────────────────────────────

/** The five kinds of caller the dashboard answers differently. */
type Callers = { owner: SessionUser; member: SessionUser; mate: SessionUser; admin: SessionUser; outsider: SessionUser };

describe('the dashboard’s load (card 2298)', () => {
	/**
	 * An installation: a public board of someone else's, and `boards` boards of
	 * the owner's, each shared with the member and the mate's team, each with
	 * a card done and one to do, a subtask, and a chain of sub-boards `depth`
	 * deep under the card to do; `assignees` people each assigned a card, and
	 * two pending requests.
	 */
	function installation(size: { boards: number; assignees: number; depth: number }): Callers {
		const callers = {
			owner: makeUser(),
			member: makeUser(),
			mate: makeUser(),
			admin: makeUser({ role: 'admin' }),
			outsider: makeUser()
		};
		const team = makeTeam([callers.mate]);
		const shown = makeBoard({ owner: makeUser(), isPublic: true });
		const onBoards: Card[] = [makeCard(shown.cols['To Do'])];
		for (let i = 0; i < size.boards; i++) {
			const { board, cols } = makeBoard({ owner: callers.owner });
			addBoardMember(board, callers.member, 'editor');
			shareBoardWithTeam(board, team, 'viewer');
			const todo = makeCard(cols['To Do']);
			onBoards.push(makeCard(cols['Complete']), todo);
			makeSubtask(todo);
			let parent = todo;
			for (let level = 0; level < size.depth; level++) {
				const sub = makeSubBoard(parent, { owner: callers.owner });
				addBoardMember(sub.board, callers.member, 'viewer');
				parent = sub.cards[0];
			}
		}
		assignCard(onBoards[1], callers.owner);
		for (let i = 0; i < size.assignees; i++) assignCard(onBoards[i % onBoards.length], makeUser());
		db.insert(taskRequests).values([
			{ targetType: 'user', targetId: callers.owner.id, title: 'For the owner' },
			{ targetType: 'team', targetId: team.id, title: 'For the team' }
		]).run();
		return callers;
	}

	/** Each caller's reads, in the installation `size` describes, on a fresh database. */
	async function readsIn(size: { boards: number; assignees: number; depth: number }) {
		resetDb();
		const callers = installation(size);
		const reads: Record<string, number> = {};
		for (const [kind, user] of Object.entries(callers)) reads[kind] = (await loadCounted('/', user)).reads;
		return reads;
	}

	it('makes the same number of reads for 1 top-level board as for 10, for every kind of caller', async () => {
		expect(await readsIn({ boards: 10, assignees: 1, depth: 1 })).toEqual(await readsIn({ boards: 1, assignees: 1, depth: 1 }));
	});

	it('makes the same number of reads for 1 assignee row as for 30', async () => {
		expect(await readsIn({ boards: 2, assignees: 30, depth: 1 })).toEqual(await readsIn({ boards: 2, assignees: 1, depth: 1 }));
	});

	it('makes the same number of reads for sub-boards 1 level deep as for 3', async () => {
		expect(await readsIn({ boards: 2, assignees: 1, depth: 3 })).toEqual(await readsIn({ boards: 2, assignees: 1, depth: 1 }));
	});

	/**
	 * The scene the data is pinned on. Board A (the owner's) is shared with the
	 * member and with the mate's team; board B is the owner's alone; board P is
	 * a stranger's, public. On A, a card done (made first) and a card to do
	 * each carry a sub-board, so the order A lists them in is the order of
	 * their columns, then their ids; the one under the card done goes a level
	 * deeper, and the member is given the one under the card to do alone.
	 * Bob's first assignment is made before Ann's, on a card with a higher id,
	 * so a tie on the leaderboard is broken by the order the rows were made in.
	 */
	function pinnedScene(): Callers {
		const callers = {
			owner: makeUser({ username: 'owner' }),
			member: makeUser({ username: 'member' }),
			mate: makeUser({ username: 'mate' }),
			admin: makeUser({ role: 'admin', username: 'admin' }),
			outsider: makeUser({ username: 'outsider' })
		};
		const stranger = makeUser({ username: 'stranger' });
		const ann = makeUser({ username: 'ann' });
		const bob = makeUser({ username: 'bob' });
		const team = makeTeam([callers.mate]);

		const A = makeBoard({ owner: callers.owner, name: 'A' });
		addBoardMember(A.board, callers.member, 'editor');
		shareBoardWithTeam(A.board, team, 'viewer');
		const aDone = makeCard(A.cols['Complete'], { title: 'A done' });
		const aTodo = makeCard(A.cols['To Do'], { title: 'A to do', dueDate: '2999-01-01' });
		const aArchived = makeCard(A.cols['To Do'], { title: 'A archived', archivedAt: '2026-01-04 00:00:00' });
		const aDoing = makeCard(A.cols['In Progress'], { title: 'A doing' });
		makeSubtask(aDone);
		makeSubtask(aDone);
		makeSubtask(aTodo);
		makeSubtask(aArchived);

		const underDone = makeSubBoard(aDone, { owner: callers.owner, name: 'Under done', cards: { 'To Do': 1, Complete: 1 } });
		const deeper = makeSubBoard(underDone.cards[0], { owner: callers.owner, name: 'Deeper', cards: { 'To Do': 2 } });
		const underTodo = makeSubBoard(aTodo, { owner: callers.owner, name: 'Under to do', cards: { Complete: 1 } });
		addBoardMember(underTodo.board, callers.member, 'viewer');
		makeSubtask(deeper.cards[0]);

		const B = makeBoard({ owner: callers.owner, name: 'B' });
		const bDone = makeCard(B.cols['Complete'], { title: 'B done' });
		makeCard(B.cols['To Do'], { title: 'B to do' });

		const P = makeBoard({ owner: stranger, name: 'P', isPublic: true });
		const pTodo = makeCard(P.cols['To Do'], { title: 'P to do' });

		assignCard(bDone, bob);
		assignCard(aDone, ann);
		assignCard(aDoing, bob);
		assignCard(aTodo, callers.owner);
		assignCard(aArchived, ann);
		assignCard(pTodo, callers.outsider);

		db.insert(taskRequests).values([
			{ targetType: 'user', targetId: callers.owner.id, title: 'For the owner' },
			{ targetType: 'team', targetId: team.id, title: 'For the team' },
			{ targetType: 'user', targetId: callers.owner.id, title: 'Rejected', status: 'rejected' },
			{ targetType: 'user', targetId: callers.owner.id, title: 'Unverified', status: 'unverified' },
			{ targetType: 'user', targetId: stranger.id, title: 'For the stranger' }
		]).run();

		db.insert(tokenUsage).values([
			{ cardId: aDone.id, tokens: 500, model: 'claude-opus-4-1', reportedByUserId: callers.owner.id, createdAt: '2026-01-05 00:00:00' },
			{ cardId: deeper.cards[0].id, tokens: 1000, model: 'claude-opus-4-1', reportedByUserId: callers.owner.id, createdAt: '2026-01-05 00:00:00' }
		]).run();

		// Groupings holding A, B and the sub-board under the card to do, and one
		// holding nothing; and an entry of each caller's in the activity log on
		// each of A, B, P and that sub-board, newest last. Each caller is listed
		// the groupings and entries of the boards they can open (card 2393's
		// review): handed the wrong boards, either list would show it.
		const groupings = db
			.insert(boardCategories)
			.values([{ name: 'Holds A' }, { name: 'Holds B' }, { name: 'Holds under to do' }, { name: 'Holds nothing' }])
			.returning()
			.all();
		[A, B, underTodo].forEach((made, i) => {
			db.update(boards).set({ categoryId: groupings[i].id }).where(eq(boards.id, made.board.id)).run();
		});
		for (const caller of Object.values(callers)) {
			db.insert(activityLog).values(
				[underTodo, A, B, P].map((made, i) => ({
					boardId: made.board.id,
					userId: caller.id,
					action: 'card_moved',
					detail: `on ${made.board.name}`,
					createdAt: `2026-01-0${i + 5} 00:00:00`
				}))
			).run();
		}

		// Every moment fixed, so nothing below depends on when it runs.
		[A, B, P, underDone, deeper, underTodo].forEach((made, i) => {
			db.update(boards).set({ createdAt: `2026-01-0${i + 1} 00:00:00`, updatedAt: `2026-01-0${i + 1} 00:00:00` }).where(eq(boards.id, made.board.id)).run();
		});
		db.update(cards).set({ createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-02 00:00:00' }).run();
		db.update(cards).set({ updatedAt: '2026-01-09 00:00:00' }).where(eq(cards.id, aDoing.id)).run();
		db.update(cards).set({ completedAt: '2026-01-03 00:00:00' }).where(eq(cards.id, bDone.id)).run();
		return callers;
	}

	/** What each caller is shown that the change touches, each in a line, and the keys of every object, in order. */
	function shown(data: any) {
		return {
			keys: Object.keys(data).join(),
			boardKeys: [...new Set(data.boards.map((b: object) => Object.keys(b).join()))],
			analyticsKeys: Object.keys(data.analytics).join(),
			boards: data.boards.map((b: any) => [
				`${b.name}: ${b.totalCards} cards, ${b.completedCards} done, last ${b.lastActivity}, tokens ${b.tokenTotal}`,
				...b.subBoards.map((s: any) => `${s.name} under ${s.parentCardTitle}: ${s.done}/${s.total} done, tokens ${s.tokenTotal}`)
			]),
			allTasksTotals: data.allTasksTotals,
			allCategories: data.allCategories.map((g: any) => g.name),
			recentActivity: data.analytics.recentActivity.map((e: any) => e.detail),
			pendingRequests: data.analytics.pendingRequests,
			teamLeaderboard: data.analytics.teamLeaderboard.map((u: any) => `${u.emoji} ${u.username}: ${u.completed} done, ${u.active} active`),
			totalSubBoards: data.analytics.totalSubBoards,
			totalBoards: data.analytics.totalBoards,
			boardHealth: data.analytics.boardHealth.map((b: any) => `${b.name} ${b.completedCards}/${b.totalCards}`),
			spendAll: data.spendByUser.all.map((s: any) => `${s.username} ${s.tokens}`)
		};
	}

	it.each(['owner', 'member', 'mate', 'admin', 'outsider'] as const)('answers the %s what it did', async (kind) => {
		const callers = pinnedScene();
		const { data, reads } = await loadCounted('/', callers[kind]);
		expect(shown(data)).toEqual(PINNED[kind]);
		expect(reads).toBeLessThanOrEqual(MOST_READS[kind]);
	});

	/**
	 * The leaderboard leaves archived cards out, as every other figure on the
	 * page does (card 2391). Cy's one card is archived in Complete, so she is
	 * not on the board at all; Dee's are one archived in Complete and one open
	 * in To Do, so she has none done. The old load counted both archived
	 * cards, and answered the two scenes alike: `cy: 1 done, 0 active` and
	 * `dee: 1 done, 1 active`. Archiving them reads nothing more.
	 */
	it('leaves archived cards off the leaderboard, with the same number of reads (card 2391)', async () => {
		function scene(archivedAt: string | null): SessionUser {
			resetDb();
			const owner = makeUser({ username: 'owner' });
			const cy = makeUser({ username: 'cy' });
			const dee = makeUser({ username: 'dee' });
			const { cols } = makeBoard({ owner, name: 'L' });
			assignCard(makeCard(cols['Complete'], { archivedAt }), cy);
			assignCard(makeCard(cols['Complete'], { archivedAt }), dee);
			assignCard(makeCard(cols['To Do']), dee);
			return owner;
		}
		const board = (data: any) => data.analytics.teamLeaderboard.map((u: any) => `${u.emoji} ${u.username}: ${u.completed} done, ${u.active} active`);

		const open = await loadCounted('/', scene(null));
		expect(board(open.data)).toEqual(['👤 cy: 1 done, 0 active', '👤 dee: 1 done, 1 active']);

		const archived = await loadCounted('/', scene('2026-01-04 00:00:00'));
		expect(board(archived.data)).toEqual(['👤 dee: 0 done, 1 active']);
		expect(archived.reads).toBe(open.reads);
	});
});

/**
 * The most reads the dashboard makes for each caller in `pinnedScene`, set
 * on purpose as the load makes them now: a read added to the load is a change
 * made here as well, and a read saved leaves the test passing. The owner and
 * the outsider are each one fewer than they were: the columns their assigned
 * cards are in were read twice with the same query, once for which are done
 * and once for which are on hold, and are read once now (card 2392). They
 * were 37 and 36. The member, the mate and the
 * administrator are assigned no card, so neither read was made for them.
 *
 * Each caller but the administrator is 12 fewer again, and the mate 15
 * (card 2393): the boards the caller can open (`getAccessibleBoardIds`) were
 * read four times a load, by the load and again by `subBoardsFor`,
 * `boardCategoriesFor` and `recentActivityFor`, four reads each time (the
 * boards they made, their member rows, their teams, the public boards) and a
 * fifth for the mate's team's boards. The load reads them once now and hands
 * them on. They were 36, 34, 37 and 35; the administrator, for whom nothing is
 * read, stays at 17.
 *
 * Every caller, the administrator too, is one fewer again (card 2394): the
 * teams the caller is in were read for the pending requests with the query
 * `getAccessibleBoardIds` had just run, and come from that read now
 * (`getAccessibleBoardsAndTeams`). The administrator's were read and not used.
 * They were 24, 22, 22, 17 and 23.
 */
const MOST_READS: Record<string, number> = { owner: 23, member: 21, mate: 21, admin: 16, outsider: 22 };

/**
 * The keys of the answer, of each board in it and of its analytics, in order, the same for every caller.
 * A board's row gained `kind` with migration 0060 (milestone 22), in the model's place for it.
 */
const KEYED = {
	keys: 'boards,analytics,allCategories,favouriteBoardIds,allTasksTotals,spendByUser',
	boardKeys: [
		'id,name,emoji,parentCardId,categoryId,isPublic,kind,createdBy,createdAt,updatedAt,totalCards,completedCards,tokenTotal,costUsd,lastActivity,subBoards,categoryName,categoryColor'
	],
	analyticsKeys:
		'totalAssigned,active,completed,completionRate,completedThisWeek,completedThisMonth,priorityCounts,pendingRequests,recentActivity,weeklyActivity,totalSubBoards,boardHealth,totalBoards,categoryDistribution,agingBuckets,teamLeaderboard,dueCards,longOverdue,asOf,weeklyTrend,onHoldCount'
};

/**
 * What the old load answered each caller in `pinnedScene`, run on the old
 * code. A's sub-boards are listed by their cards' columns (To Do first), not
 * by the cards' ids; Bob comes before Ann on a tie, his row having been made
 * first. One figure is changed on purpose since: Ann's archived card counted
 * as active on the leaderboard (`ann: 1 done, 1 active`), and is left out now
 * that the leaderboard counts open cards only (card 2391), so the owner, the
 * member, the mate and the administrator are each shown `ann: 1 done, 0
 * active`, in the same place.
 *
 * `allCategories` and `recentActivity` were added to the scene and to the pins
 * in card 2393's review, since the load hands its list of the caller's boards
 * to the helpers that answer both, and nothing pinned would have caught the
 * wrong list handed there. Each caller is listed the groupings holding a board
 * they can open and the empty one, and their own entries on the boards they
 * can open, newest first. They were pinned with the load's three helpers left
 * to read access for themselves, as before card 2393 (a temporary edit), and
 * passed there; the scene's additions change no other figure pinned.
 */
const PINNED: Record<string, unknown> = {
	owner: {
		...KEYED,
		boards: [
			['P: 1 cards, 0 done, last 2026-01-03 00:00:00, tokens null'],
			['B: 2 cards, 1 done, last 2026-01-02 00:00:00, tokens null'],
			[
				'A: 3 cards, 1 done, last 2026-01-09 00:00:00, tokens 500',
				'Under to do under A to do: 1/1 done, tokens null',
				'Under done under A done: 1/2 done, tokens null'
			]
		],
		allTasksTotals: { cards: 11, completedCards: 4, subtasks: 4, tasks: 15, tokenTotal: 1500, costUsd: 0.0315, unpricedTokens: 0 },
		allCategories: ['Holds A', 'Holds B', 'Holds nothing', 'Holds under to do'],
		recentActivity: ['on P', 'on B', 'on A', 'on Under to do'],
		pendingRequests: 1,
		teamLeaderboard: ['👤 bob: 1 done, 1 active', '👤 ann: 1 done, 0 active', '👤 owner: 0 done, 1 active', '👤 outsider: 0 done, 1 active'],
		totalSubBoards: 3,
		totalBoards: 3,
		boardHealth: ['B 1/2', 'A 1/3', 'P 0/1'],
		spendAll: ['owner 1500']
	},
	member: {
		...KEYED,
		boards: [
			['P: 1 cards, 0 done, last 2026-01-03 00:00:00, tokens null'],
			['A: 3 cards, 1 done, last 2026-01-09 00:00:00, tokens 500', 'Under to do under A to do: 1/1 done, tokens null']
		],
		allTasksTotals: { cards: 5, completedCards: 2, subtasks: 3, tasks: 8, tokenTotal: 500, costUsd: 0.010499999999999999, unpricedTokens: 0 },
		allCategories: ['Holds A', 'Holds nothing', 'Holds under to do'],
		recentActivity: ['on P', 'on A', 'on Under to do'],
		pendingRequests: 0,
		teamLeaderboard: ['👤 ann: 1 done, 0 active', '👤 bob: 0 done, 1 active', '👤 owner: 0 done, 1 active', '👤 outsider: 0 done, 1 active'],
		totalSubBoards: 1,
		totalBoards: 2,
		boardHealth: ['A 1/3', 'P 0/1'],
		spendAll: ['owner 500']
	},
	mate: {
		...KEYED,
		boards: [['P: 1 cards, 0 done, last 2026-01-03 00:00:00, tokens null'], ['A: 3 cards, 1 done, last 2026-01-09 00:00:00, tokens 500']],
		allTasksTotals: { cards: 4, completedCards: 1, subtasks: 3, tasks: 7, tokenTotal: 500, costUsd: 0.010499999999999999, unpricedTokens: 0 },
		allCategories: ['Holds A', 'Holds nothing'],
		recentActivity: ['on P', 'on A'],
		pendingRequests: 1,
		teamLeaderboard: ['👤 ann: 1 done, 0 active', '👤 bob: 0 done, 1 active', '👤 owner: 0 done, 1 active', '👤 outsider: 0 done, 1 active'],
		totalSubBoards: 0,
		totalBoards: 2,
		boardHealth: ['A 1/3', 'P 0/1'],
		spendAll: ['owner 500']
	},
	admin: {
		...KEYED,
		boards: [
			['P: 1 cards, 0 done, last 2026-01-03 00:00:00, tokens null'],
			['B: 2 cards, 1 done, last 2026-01-02 00:00:00, tokens null'],
			[
				'A: 3 cards, 1 done, last 2026-01-09 00:00:00, tokens 500',
				'Under to do under A to do: 1/1 done, tokens null',
				'Under done under A done: 1/2 done, tokens null'
			]
		],
		allTasksTotals: { cards: 11, completedCards: 4, subtasks: 4, tasks: 15, tokenTotal: 1500, costUsd: 0.0315, unpricedTokens: 0 },
		allCategories: ['Holds A', 'Holds B', 'Holds nothing', 'Holds under to do'],
		recentActivity: ['on P', 'on B', 'on A', 'on Under to do'],
		pendingRequests: 3,
		teamLeaderboard: ['👤 bob: 1 done, 1 active', '👤 ann: 1 done, 0 active', '👤 owner: 0 done, 1 active', '👤 outsider: 0 done, 1 active'],
		totalSubBoards: 3,
		totalBoards: 3,
		boardHealth: ['B 1/2', 'A 1/3', 'P 0/1'],
		spendAll: ['owner 1500']
	},
	outsider: {
		...KEYED,
		boards: [['P: 1 cards, 0 done, last 2026-01-03 00:00:00, tokens null']],
		allTasksTotals: { cards: 1, completedCards: 0, subtasks: 0, tasks: 1, tokenTotal: null, costUsd: null, unpricedTokens: 0 },
		allCategories: ['Holds nothing'],
		recentActivity: ['on P'],
		pendingRequests: 0,
		teamLeaderboard: ['👤 outsider: 0 done, 1 active'],
		totalSubBoards: 0,
		totalBoards: 1,
		boardHealth: ['P 0/1'],
		spendAll: []
	}
};

// ─── Card 2393's review: a list of boards handed to the helpers ───────────

/**
 * `accessible`, handed to `recentActivityFor`, `boardCategoryRule`,
 * `boardCategoriesFor` and `subBoardsFor` (card 2393). `null` is an
 * administrator's answer, "every board", and each helper took it as that from
 * anyone: a caller who passed it by mistake listed an outsider another's
 * secret sub-board, grouping and activity. It is taken as every board only from
 * an administrator now, with nothing read; from anyone else each helper reads
 * the caller's boards for itself, as when it is left out.
 */
describe('a null list of boards, handed to the list helpers (card 2393’s review)', () => {
	/** A secret board of the owner's, with a sub-board, filed under a grouping, and the outsider's own board. */
	function scene() {
		const owner = makeUser();
		const outsider = makeUser();
		const admin = makeUser({ role: 'admin' });
		const secret = makeBoard({ owner, name: 'Secret' });
		const card = makeCard(secret.cols['To Do']);
		const under = makeSubBoard(card, { owner, name: 'Secret under' });
		const own = makeBoard({ owner: outsider, name: 'Own' });
		const grouping = db.insert(boardCategories).values({ name: 'Secret grouping' }).returning().get();
		db.update(boards).set({ categoryId: grouping.id }).where(eq(boards.id, secret.board.id)).run();
		// The outsider's entries, one on a board they were taken off; the administrator's, on the secret board.
		db.insert(activityLog).values([
			{ boardId: secret.board.id, userId: outsider.id, action: 'card_moved', detail: 'on Secret' },
			{ boardId: own.board.id, userId: outsider.id, action: 'card_moved', detail: 'on Own' },
			{ boardId: secret.board.id, userId: admin.id, action: 'card_moved', detail: 'on Secret' }
		]).run();
		return { outsider, admin, card, under, grouping };
	}

	it('answers a caller who is not an administrator for their own boards alone, from all four helpers', () => {
		const { outsider, card, grouping } = scene();

		expect(recentActivityFor(outsider, 10, null).map((e) => e.detail)).toEqual(['on Own']);
		expect(boardCategoryRule(outsider, null)(grouping.id)).toBe(false);
		expect(boardCategoriesFor(outsider, null)).toEqual([]);
		expect(subBoardsFor(outsider, undefined, null)).toEqual([]);
		expect(subBoardsFor(outsider, [card.id], null)).toEqual([]);
		// The same as each answers with the list left out.
		expect(recentActivityFor(outsider, 10, null)).toEqual(recentActivityFor(outsider, 10));
		expect(boardCategoriesFor(outsider, null)).toEqual(boardCategoriesFor(outsider));
		expect(subBoardsFor(outsider, undefined, null)).toEqual(subBoardsFor(outsider));
	});

	it('takes it as every board from an administrator, reading nothing to tell them apart', () => {
		const { admin, card, under, grouping } = scene();

		const budget = readBudget(100);
		let rule;
		try {
			rule = boardCategoryRule(admin, null);
		} finally {
			budget.restore();
		}
		expect(budget.count).toBe(0);
		expect(rule(grouping.id)).toBe(true);
		expect(recentActivityFor(admin, 10, null).map((e) => e.detail)).toEqual(['on Secret']);
		expect(boardCategoriesFor(admin, null).map((g) => g.name)).toEqual(['Secret grouping']);
		expect(subBoardsFor(admin, [card.id], null).map((b) => b.id)).toEqual([under.board.id]);
	});
});

// ─── Milestone 22: the board page with an Options column ────────────────────

/**
 * The board page's load reads when each option became one, for the Options
 * strip's aging (ruling g, the S1b review's B2 and B7): two reads, the
 * options' latest returns to options and the column's latest conversion,
 * made only when the Options column holds a card, and as many for ten options
 * as for one. A board with no options reads exactly what it did.
 */
describe('the board page’s load with an Options column (milestone 22)', () => {
	/** A board of the owner's whose first column holds `options` cards and one more in To Do; the first column the Options column when `asOptions`. */
	function boardWith(options: number, asOptions: boolean) {
		resetDb();
		const owner = makeUser({ username: 'owner' });
		const { board, cols } = makeBoard({ owner, columns: ['Ideas', 'To Do', 'In Progress', 'Complete'] });
		if (asOptions) db.update(columns).set({ role: 'options', position: -1 }).where(eq(columns.id, cols['Ideas'].id)).run();
		for (let i = 0; i < options; i++) makeCard(cols['Ideas'], { title: `Idea ${i}` });
		makeCard(cols['To Do'], { title: 'Work' });
		return { owner, board };
	}

	async function readsOf(options: number, asOptions: boolean) {
		const { owner, board } = boardWith(options, asOptions);
		return (await loadCounted(`/board/${board.id}`, owner)).reads;
	}

	it('reads two more for an Options column holding a card, as many for ten as for one, and nothing more for an empty one', async () => {
		const ordinary = await readsOf(1, false);
		const one = await readsOf(1, true);
		const ten = await readsOf(10, true);
		const empty = await readsOf(0, true);

		expect(one).toBe(ordinary + 2);
		expect(ten).toBe(one);
		expect(empty).toBe(await readsOf(0, false));
		// The pin, as it reads now: 32 for the board with no options.
		expect(one).toBeLessThanOrEqual(BOARD_WITH_OPTIONS_READS);
	});
});

/** The most reads the board page's load makes for its owner, on a board whose Options column holds a card (B7). */
const BOARD_WITH_OPTIONS_READS = 34;
