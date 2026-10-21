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
 *
 * What each load answers is pinned as the old load answered it: the cases
 * below were run on the old code before the change and passed there. The key
 * order is pinned too (`JSON.stringify`), since the page is handed the object
 * as it is.
 *
 * The plan is `docs/planning/cards-2297-2298-2389.md`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { defaultOutside } from '$lib/server/db/restore';
import { boards, cards, categories, taskRequests, teamMembers, tokenUsage, users, type Card } from '$lib/server/db/schema';
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
		// A fixed handful: the boards, three counts, the users, the teams and their members.
		expect(small).toBeLessThanOrEqual(7);
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
				reportSchedules: user.id === admin.id ? null : 0
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
		const { data } = await loadCounted('/', callers[kind]);
		expect(shown(data)).toEqual(PINNED[kind]);
	});
});

/** The keys of the answer, of each board in it and of its analytics, in order, the same for every caller. */
const KEYED = {
	keys: 'boards,analytics,allCategories,favouriteBoardIds,allTasksTotals,spendByUser',
	boardKeys: [
		'id,name,emoji,parentCardId,categoryId,isPublic,createdBy,createdAt,updatedAt,totalCards,completedCards,tokenTotal,costUsd,lastActivity,subBoards,categoryName,categoryColor'
	],
	analyticsKeys:
		'totalAssigned,active,completed,completionRate,completedThisWeek,completedThisMonth,priorityCounts,pendingRequests,recentActivity,weeklyActivity,totalSubBoards,boardHealth,totalBoards,categoryDistribution,agingBuckets,teamLeaderboard,dueCards,longOverdue,asOf,weeklyTrend,onHoldCount'
};

/**
 * What the old load answered each caller in `pinnedScene`, run on the old
 * code. A's sub-boards are listed by their cards' columns (To Do first), not
 * by the cards' ids; Bob comes before Ann on a tie, his row having been made
 * first; Ann's archived card counts as active on the leaderboard, as it
 * always has (a fault noted in the plan, not changed here).
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
		pendingRequests: 1,
		teamLeaderboard: ['👤 bob: 1 done, 1 active', '👤 ann: 1 done, 1 active', '👤 owner: 0 done, 1 active', '👤 outsider: 0 done, 1 active'],
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
		pendingRequests: 0,
		teamLeaderboard: ['👤 ann: 1 done, 1 active', '👤 bob: 0 done, 1 active', '👤 owner: 0 done, 1 active', '👤 outsider: 0 done, 1 active'],
		totalSubBoards: 1,
		totalBoards: 2,
		boardHealth: ['A 1/3', 'P 0/1'],
		spendAll: ['owner 500']
	},
	mate: {
		...KEYED,
		boards: [['P: 1 cards, 0 done, last 2026-01-03 00:00:00, tokens null'], ['A: 3 cards, 1 done, last 2026-01-09 00:00:00, tokens 500']],
		allTasksTotals: { cards: 4, completedCards: 1, subtasks: 3, tasks: 7, tokenTotal: 500, costUsd: 0.010499999999999999, unpricedTokens: 0 },
		pendingRequests: 1,
		teamLeaderboard: ['👤 ann: 1 done, 1 active', '👤 bob: 0 done, 1 active', '👤 owner: 0 done, 1 active', '👤 outsider: 0 done, 1 active'],
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
		pendingRequests: 3,
		teamLeaderboard: ['👤 bob: 1 done, 1 active', '👤 ann: 1 done, 1 active', '👤 owner: 0 done, 1 active', '👤 outsider: 0 done, 1 active'],
		totalSubBoards: 3,
		totalBoards: 3,
		boardHealth: ['B 1/2', 'A 1/3', 'P 0/1'],
		spendAll: ['owner 1500']
	},
	outsider: {
		...KEYED,
		boards: [['P: 1 cards, 0 done, last 2026-01-03 00:00:00, tokens null']],
		allTasksTotals: { cards: 1, completedCards: 0, subtasks: 0, tasks: 1, tokenTotal: null, costUsd: null, unpricedTokens: 0 },
		pendingRequests: 0,
		teamLeaderboard: ['👤 outsider: 0 done, 1 active'],
		totalSubBoards: 0,
		totalBoards: 1,
		boardHealth: ['P 0/1'],
		spendAll: []
	}
};
