/**
 * How many times the other pages' loads read the boards their caller can open,
 * and what they answer (card 2394).
 *
 * The dashboard reads `getAccessibleBoardIds` once a load since card 2393 and
 * hands it to the helpers that read it again. All Tasks and All To Do read it
 * three times a load, more when a card is blocked; Reports twice; `GET
 * /api/v1/me/stats` twice; the board page three to five times; the burndown,
 * by grouping, twice, and its page once more besides, and again for its list
 * of milestones. Each read is four statements for an ordinary user (the boards
 * they made, their member rows, their teams, the public boards) and a fifth
 * for a caller in a team; an administrator's is none. Each of these reads it
 * once now, and hands it on.
 *
 * Each page and endpoint is asked by the five kinds of caller of one scene:
 * the owner of boards A and B, a member of A, a member of a team A is shared
 * with, an administrator, and an outsider who opens only the public board P.
 * For each, the test pins:
 *
 *   - the whole answer, byte for byte: the SHA-256 of `JSON.stringify` of it
 *     (the burndown's `generatedAt`, the moment it ran, put to one value
 *     first). A hash, since the answers run to thousands of characters each.
 *     Taken on the old code before the change; then, in the review
 *     (2026-10-21), B joined A's grouping and a card on B was put in A's goal,
 *     and the 38 hashes that moved (each marked "re-pinned") were taken again
 *     on the code as it is, not the old code. What the grouping charts for
 *     each caller is held by name in its own test below: a member of A is
 *     charted A alone. The scene is built so that the callers are told
 *     different things: a test asks every case again with the caller's own
 *     user object left out (the burndown page hands it back) and finds every
 *     two kinds answered differently by at least one, `GET /api/v1/me/stats`
 *     aside, whose entries are the caller's own rows;
 *   - how many reads the load makes, at most, set on purpose as it makes them
 *     now (`reads`), with the count before the change beside it in a comment;
 *   - how many times it reads the caller's boards (`access`): how many reads
 *     of the public boards it makes, the one statement of
 *     `getAccessibleBoardIds` that no other part of these pages runs.
 *
 * The plan is `docs/planning/card-2394.md`.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { activityLog, boardCategories, boards, cardLabels, categories } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { cardCategoriesFor, categoryRule, hiddenOpenCountsFor } from '$lib/server/list-access';
import { boardsOpenTo, getBlockedStateForCards, getBoardBlockedState } from '$lib/server/planning';
import { listMilestones, milestonesForBoard } from '$lib/server/milestones';
import { getBurndown, parseBurndownQuery } from '$lib/server/burndown';
import type { BurndownResult } from '$lib/burndown';
import { pageLoad } from './helpers/actions';
import { api } from './helpers/api';
import { readBudget } from './helpers/reads';
import {
	addBoardMember,
	assignCard,
	makeBoard,
	makeCard,
	makeDependency,
	makeLabel,
	makeMilestone,
	makeSubBoard,
	makeSubtask,
	makeTeam,
	makeUser,
	resetDb,
	shareBoardWithTeam
} from './helpers/fixtures';

beforeEach(() => resetDb());

const KINDS = ['owner', 'member', 'mate', 'admin', 'outsider'] as const;
type Kind = (typeof KINDS)[number];

/**
 * The scene. Board A (the owner's) is shared with the member, as an editor,
 * and with the mate's team; B is the owner's alone; P is a stranger's, public.
 * On A, the card to do carries B's card category (carried, for whoever cannot
 * open B), is labelled, waits on B's card to do and on A's card doing, sits in
 * the goal across A and B, and has a sub-board given to the member; the card
 * doing has a sub-board of the owner's alone, with two cards open on it, and is
 * in A's own goal, with a card on B that kept it when moved off A. P's card
 * waits on A's card doing. Groupings hold A and B, the owner's sub-board, and
 * nothing. Each caller has an entry on A, B, P and the member's sub-board, and
 * a completion on A and on B. Every moment is fixed.
 */
function scene() {
	const callers: Record<Kind, SessionUser> = {
		owner: makeUser({ username: 'owner' }),
		member: makeUser({ username: 'member' }),
		mate: makeUser({ username: 'mate' }),
		admin: makeUser({ role: 'admin', username: 'admin' }),
		outsider: makeUser({ username: 'outsider' })
	};
	const stranger = makeUser({ username: 'stranger' });
	const team = makeTeam([callers.mate], 'Team');

	const A = makeBoard({ owner: callers.owner, name: 'A' });
	addBoardMember(A.board, callers.member, 'editor');
	shareBoardWithTeam(A.board, team, 'viewer');
	const B = makeBoard({ owner: callers.owner, name: 'B' });
	const P = makeBoard({ owner: stranger, name: 'P', isPublic: true });

	const [shared, onA, onB] = db
		.insert(categories)
		.values([{ name: 'Shared' }, { boardId: A.board.id, name: 'On A' }, { boardId: B.board.id, name: 'On B' }])
		.returning()
		.all();

	const aTodo = makeCard(A.cols['To Do'], { title: 'A to do', categoryId: onB.id, dueDate: '2999-01-01' });
	const aDoing = makeCard(A.cols['In Progress'], { title: 'A doing', categoryId: onA.id, priority: 'high' });
	const aDone = makeCard(A.cols['Complete'], { title: 'A done', categoryId: shared.id, completedAt: '2026-01-10 00:00:00' });
	makeCard(A.cols['To Do'], { title: 'A archived', archivedAt: '2026-01-04 00:00:00' });
	const bTodo = makeCard(B.cols['To Do'], { title: 'B to do', categoryId: onB.id });
	const bDone = makeCard(B.cols['Complete'], { title: 'B done', completedAt: '2026-01-12 00:00:00' });
	const pTodo = makeCard(P.cols['To Do'], { title: 'P to do' });
	makeSubtask(aTodo, { title: 'A to do, step' });
	makeSubtask(bTodo, { title: 'B to do, step' });

	const underTodo = makeSubBoard(aTodo, { owner: callers.owner, name: 'Under to do', cards: { 'To Do': 1 } });
	addBoardMember(underTodo.board, callers.member, 'viewer');
	const underDoing = makeSubBoard(aDoing, { owner: callers.owner, name: 'Under doing', cards: { 'To Do': 2 } });

	const label = makeLabel(A.board, 'Urgent');
	db.insert(cardLabels).values({ cardId: aTodo.id, labelId: label.id }).run();

	makeDependency({ blocked: aTodo, blocker: bTodo });
	makeDependency({ blocked: aTodo, blocker: aDoing });
	makeDependency({ blocked: pTodo, blocker: aDoing });

	const onAGoal = makeMilestone({ board: A.board, name: 'Goal on A', createdBy: callers.owner, cards: [aDoing] });
	const across = makeMilestone({ name: 'Goal across', createdBy: callers.owner, cards: [aTodo, bTodo] });
	makeMilestone({ board: B.board, name: 'Goal on B', createdBy: callers.owner, cards: [bDone] });
	// On B, in A's own goal: a card moved off A kept its goal before card 2155.
	makeCard(B.cols['To Do'], { title: 'B to do, in A’s goal', milestoneId: onAGoal.id });

	const groupings = db
		.insert(boardCategories)
		.values([{ name: 'Holds A and B' }, { name: 'Holds Under doing' }, { name: 'Holds nothing' }])
		.returning()
		.all();
	db.update(boards).set({ categoryId: groupings[0].id }).where(inArray(boards.id, [A.board.id, B.board.id])).run();
	db.update(boards).set({ categoryId: groupings[1].id }).where(eq(boards.id, underDoing.board.id)).run();

	assignCard(aDone, callers.owner);
	assignCard(bDone, callers.owner);
	assignCard(bTodo, callers.owner);
	assignCard(aTodo, callers.member);
	assignCard(aDoing, callers.mate);
	assignCard(pTodo, callers.outsider);

	// Every moment fixed, so nothing below depends on when it runs.
	for (const { name } of sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
		.all() as { name: string }[]) {
		const columns = (sqlite.pragma(`table_info("${name}")`) as { name: string }[]).map((c) => c.name);
		for (const column of ['created_at', 'updated_at']) {
			if (columns.includes(column)) sqlite.prepare(`UPDATE "${name}" SET "${column}" = '2026-01-02 00:00:00'`).run();
		}
	}

	for (const caller of Object.values(callers)) {
		db.insert(activityLog)
			.values([
				...[underTodo, A, B, P].map((made, i) => ({
					boardId: made.board.id,
					userId: caller.id,
					action: 'card_moved',
					detail: `on ${made.board.name}`,
					createdAt: `2026-01-0${i + 5} 00:00:00`
				})),
				{ boardId: A.board.id, userId: caller.id, action: 'card_completed', detail: 'done on A', createdAt: '2026-01-10 00:00:00' },
				{ boardId: B.board.id, userId: caller.id, action: 'api:card_completed', detail: 'done on B', createdAt: '2026-01-12 00:00:00' }
			])
			.run();
	}

	return { callers, A, B, P, groupings, onAGoal, across, aDoing, pTodo, onB };
}

/** The answer, with the burndown's moment of running put to one value, by its SHA-256. */
function hashOf(answer: unknown): string {
	const text = JSON.stringify(answer, (key, value) => (key === 'generatedAt' ? 'at run time' : value));
	return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * The answer without the caller's own user object, which the burndown page
 * hands back as `user`: the one field of these answers that says who asked.
 * (The lists of users, assignees and board members name every user alike,
 * whoever asks; the board page's `userBoardRole` is what the caller may do.)
 */
function withoutCaller(answer: unknown): unknown {
	const { data } = answer as { data?: Record<string, unknown> };
	return data && 'user' in data ? { ...(answer as object), data: { ...data, user: undefined } } : answer;
}

/** How many reads `run` made, how many of them read the public boards, and its answer's hash. */
async function counted(run: () => Promise<unknown>) {
	const budget = readBudget(100_000);
	let answer;
	try {
		answer = await run();
	} finally {
		budget.restore();
	}
	expect(budget.spent).toBe(false);
	const access = budget.sources.filter((s) => /"boards"\."is_public" = \?/.test(s)).length;
	return { reads: budget.count, access, hash: hashOf(answer) };
}

/** A page's load, as the page is handed it: its data, or its refusal. */
async function load(path: string, user: SessionUser) {
	return pageLoad(path, { user });
}

/** An endpoint's status and body. */
async function get(path: string, user: SessionUser) {
	const res = await api('GET', path, { user });
	return { status: res.status, body: res.body };
}

const RANGE = 'from=2026-01-01&to=2026-01-31';

/** Each page or endpoint asked, by its path in the scene. */
const CASES: Record<string, (s: ReturnType<typeof scene>) => { path: string; ask: (path: string, user: SessionUser) => Promise<unknown> }> = {
	'All Tasks': () => ({ path: '/all', ask: load }),
	'All To Do': () => ({ path: '/todo', ask: load }),
	Reports: () => ({ path: '/reports', ask: load }),
	'GET /api/v1/me/stats': () => ({ path: '/api/v1/me/stats', ask: get }),
	'the board page, A': (s) => ({ path: `/board/${s.A.board.id}`, ask: load }),
	'the board page, P': (s) => ({ path: `/board/${s.P.board.id}`, ask: load }),
	'GET /api/boards/A/contents': (s) => ({ path: `/api/boards/${s.A.board.id}/contents`, ask: get }),
	'the burndown page, every board': () => ({ path: `/burndown?${RANGE}`, ask: load }),
	'the burndown page, by grouping': (s) => ({ path: `/burndown?boardCategoryId=${s.groupings[0].id}&${RANGE}`, ask: load }),
	'the burndown page, a goal across boards': (s) => ({ path: `/burndown?milestoneId=${s.across.id}&${RANGE}`, ask: load }),
	'the burndown page, a goal and a grouping': (s) => ({
		path: `/burndown?milestoneId=${s.onAGoal.id}&boardCategoryId=${s.groupings[0].id}&${RANGE}`,
		ask: load
	}),
	'the burndown page, board A': (s) => ({ path: `/burndown?boardIds=${s.A.board.id}&${RANGE}`, ask: load }),
	'GET /api/v1/burndown, every board': () => ({ path: `/api/v1/burndown?${RANGE}`, ask: get }),
	'GET /api/v1/burndown, by grouping': (s) => ({ path: `/api/v1/burndown?boardCategoryId=${s.groupings[0].id}&${RANGE}`, ask: get }),
	'GET /api/v1/burndown, a goal across boards': (s) => ({ path: `/api/v1/burndown?milestoneId=${s.across.id}&${RANGE}`, ask: get }),
	'GET /api/v1/burndown, board A': (s) => ({ path: `/api/v1/burndown?boardIds=${s.A.board.id}&${RANGE}`, ask: get })
};

type Pin = { reads: number; access: number; hash: string };

/**
 * For each case and caller: `reads`, the most reads the load makes, as it
 * makes them now; `access`, how many times it reads the caller's boards; and
 * `hash`, its whole answer, taken on the old code, or on the code as it is
 * where "re-pinned" (the file's header says why). The comment on each line is
 * what the old code read, in the scene before the review: `reads` before →
 * after, `access` before → after.
 */
const PINS: Record<string, Record<Kind, Pin>> = {
	'All Tasks': {
		owner: { reads: 30, access: 1, hash: '178b6f6f36cbe091' }, // 42 → 30, 4 → 1; re-pinned
		member: { reads: 33, access: 1, hash: 'a3045380deccb41f' }, // 45 → 33, 4 → 1; re-pinned
		mate: { reads: 39, access: 1, hash: '0a5b0e94f8e29024' }, // 54 → 39, 4 → 1; re-pinned
		admin: { reads: 20, access: 0, hash: '178b6f6f36cbe091' }, // 20 → 20, 0 → 0; re-pinned
		outsider: { reads: 24, access: 1, hash: '637e189ab5942b84' } // 36 → 24, 4 → 1
	},
	'All To Do': {
		owner: { reads: 27, access: 1, hash: '36f706500bb64b30' }, // 38 → 26, 4 → 1; re-pinned, 27 with B's card in A's goal
		member: { reads: 29, access: 1, hash: '5a9cc817475ba3a1' }, // 41 → 29, 4 → 1; re-pinned
		mate: { reads: 33, access: 1, hash: '9d0265bf38972861' }, // 48 → 33, 4 → 1; re-pinned
		admin: { reads: 18, access: 0, hash: '36f706500bb64b30' }, // 18 → 18, 0 → 0; re-pinned
		outsider: { reads: 22, access: 1, hash: '26d10535915f23f3' } // 34 → 22, 4 → 1
	},
	Reports: {
		owner: { reads: 13, access: 1, hash: 'f30944d9a51498be' }, // 17 → 13, 2 → 1; re-pinned
		member: { reads: 13, access: 1, hash: '7bcb64bf2a89c223' }, // 17 → 13, 2 → 1; re-pinned
		mate: { reads: 13, access: 1, hash: '7bcb64bf2a89c223' }, // 18 → 13, 2 → 1; re-pinned
		admin: { reads: 8, access: 0, hash: '1e372c6fac936525' }, // 8 → 8, 0 → 0; re-pinned
		outsider: { reads: 12, access: 1, hash: 'd02051ab7fbbbe3a' } // 16 → 12, 2 → 1
	},
	'GET /api/v1/me/stats': {
		owner: { reads: 11, access: 1, hash: '9aa573a47033195c' }, // 15 → 11, 2 → 1
		member: { reads: 11, access: 1, hash: 'edc3d758646f96a2' }, // 15 → 11, 2 → 1
		mate: { reads: 12, access: 1, hash: 'b2d6ff8e33d818e8' }, // 17 → 12, 2 → 1
		admin: { reads: 7, access: 0, hash: '755f43e24e7d3549' }, // 7 → 7, 0 → 0
		outsider: { reads: 11, access: 1, hash: '953480566ec10ee5' } // 15 → 11, 2 → 1
	},
	'the board page, A': {
		owner: { reads: 41, access: 1, hash: '6e2c6b94862710ba' }, // 57 → 41, 5 → 1
		member: { reads: 48, access: 1, hash: '3bb4ada1f3bf1636' }, // 64 → 48, 5 → 1
		mate: { reads: 53, access: 1, hash: '21f7abfe356d85db' }, // 73 → 53, 5 → 1
		admin: { reads: 30, access: 0, hash: '611439da66886fc0' }, // 30 → 30, 0 → 0
		outsider: { reads: 3, access: 0, hash: '586b0bf8447edc8a' } // 3 → 3, 0 → 0 (refused)
	},
	'the board page, P': {
		owner: { reads: 38, access: 1, hash: '37911a01434d731b' }, // 54 → 38, 5 → 1
		member: { reads: 41, access: 1, hash: 'cb7f9902bc0d5674' }, // 57 → 41, 5 → 1
		mate: { reads: 47, access: 1, hash: 'cb7f9902bc0d5674' }, // 67 → 47, 5 → 1
		admin: { reads: 28, access: 0, hash: 'a3a4b6f18c16b122' }, // 28 → 28, 0 → 0
		outsider: { reads: 39, access: 1, hash: 'ca4c328d66bbdac3' } // 55 → 39, 5 → 1
	},
	'GET /api/boards/A/contents': {
		owner: { reads: 41, access: 1, hash: 'ce5a00e1deba5a9a' }, // 57 → 41, 5 → 1
		member: { reads: 48, access: 1, hash: 'a628abfa9e18a832' }, // 64 → 48, 5 → 1
		mate: { reads: 53, access: 1, hash: '65ff7c8aafd7c532' }, // 73 → 53, 5 → 1
		admin: { reads: 30, access: 0, hash: '65ef0d7c48f5fa2a' }, // 30 → 30, 0 → 0
		outsider: { reads: 3, access: 0, hash: '98f0381065d0fdf3' } // 3 → 3, 0 → 0 (refused)
	},
	'the burndown page, every board': {
		owner: { reads: 21, access: 1, hash: '86821bd5625857d5' }, // 29 → 21, 3 → 1; re-pinned
		member: { reads: 27, access: 1, hash: 'a472007cbd031b96' }, // 35 → 27, 3 → 1; re-pinned
		mate: { reads: 34, access: 1, hash: 'c0fdc2ea2ed27155' }, // 44 → 34, 3 → 1; re-pinned
		admin: { reads: 12, access: 0, hash: 'b726d35818142127' }, // 12 → 12, 0 → 0; re-pinned
		outsider: { reads: 22, access: 1, hash: '49e0fd550eed6152' } // 26 → 22, 2 → 1
	},
	'the burndown page, by grouping': {
		owner: { reads: 25, access: 1, hash: 'c1759475d05220b0' }, // 37 → 25, 4 → 1; re-pinned
		member: { reads: 31, access: 1, hash: '063393c21438c551' }, // 43 → 31, 4 → 1; re-pinned
		mate: { reads: 38, access: 1, hash: '4ca7a2a62594b200' }, // 53 → 38, 4 → 1; re-pinned
		admin: { reads: 15, access: 0, hash: '0b60451ce1609ee8' }, // 15 → 15, 0 → 0; re-pinned
		outsider: { reads: 19, access: 1, hash: 'a67e228271d95c0a' } // 23 → 19, 2 → 1 (refused in the page)
	},
	'the burndown page, a goal across boards': {
		owner: { reads: 26, access: 1, hash: '88738a2ff1c93e27' }, // 34 → 26, 3 → 1; re-pinned
		member: { reads: 27, access: 1, hash: 'e244bd069fc1bce6' }, // 31 → 27, 2 → 1 (refused in the page); re-pinned
		mate: { reads: 37, access: 1, hash: '49d71ada95f45d18' }, // 42 → 37, 2 → 1 (refused in the page); re-pinned
		admin: { reads: 13, access: 0, hash: '6610a45dab3fb08e' }, // 13 → 13, 0 → 0; re-pinned
		outsider: { reads: 22, access: 1, hash: 'f86a5cc151b8126e' } // 22 → 22, 1 → 1 (refused in the page)
	},
	'the burndown page, a goal and a grouping': {
		owner: { reads: 25, access: 1, hash: '6603660dd9f2af3f' }, // 37 → 25, 4 → 1; re-pinned
		member: { reads: 32, access: 1, hash: '6cf605b316f87b87' }, // 44 → 32, 4 → 1; re-pinned
		mate: { reads: 41, access: 1, hash: '6cb09d6acd3673a1' }, // 56 → 41, 4 → 1; re-pinned
		admin: { reads: 14, access: 0, hash: '774710e566173182' }, // 14 → 14, 0 → 0; re-pinned
		outsider: { reads: 19, access: 1, hash: 'a67e228271d95c0a' } // 23 → 19, 2 → 1 (refused in the page)
	},
	'the burndown page, board A': {
		owner: { reads: 24, access: 1, hash: '6cd8a1b3d771d616' }, // 28 → 24, 2 → 1; re-pinned
		member: { reads: 31, access: 1, hash: '1e435f82025c184d' }, // 35 → 31, 2 → 1; re-pinned
		mate: { reads: 40, access: 1, hash: '29d40b7088105674' }, // 45 → 40, 2 → 1; re-pinned
		admin: { reads: 14, access: 0, hash: '3c5bae1a9671b3ff' }, // 14 → 14, 0 → 0; re-pinned
		outsider: { reads: 21, access: 1, hash: 'e3abe29e283cbb9f' } // 21 → 21, 1 → 1 (refused in the page)
	},
	'GET /api/v1/burndown, every board': {
		owner: { reads: 6, access: 1, hash: '39527b9bb6d60a51' }, // 6 → 6, 1 → 1; re-pinned
		member: { reads: 6, access: 1, hash: '764e4893e928e4a9' }, // 6 → 6, 1 → 1
		mate: { reads: 7, access: 1, hash: '970f86089acd6166' }, // 7 → 7, 1 → 1
		admin: { reads: 2, access: 0, hash: '39527b9bb6d60a51' }, // 2 → 2, 0 → 0; re-pinned
		outsider: { reads: 6, access: 1, hash: '7e56d71491d06fde' } // 6 → 6, 1 → 1
	},
	'GET /api/v1/burndown, by grouping': {
		owner: { reads: 10, access: 1, hash: '1c0ee8ec8d9772b3' }, // 14 → 10, 2 → 1; re-pinned
		member: { reads: 10, access: 1, hash: 'ad057de8690d188d' }, // 14 → 10, 2 → 1; re-pinned
		mate: { reads: 11, access: 1, hash: 'ad057de8690d188d' }, // 16 → 11, 2 → 1; re-pinned
		admin: { reads: 5, access: 0, hash: '1c0ee8ec8d9772b3' }, // 5 → 5, 0 → 0; re-pinned
		outsider: { reads: 6, access: 1, hash: '5db1572772a64190' } // 6 → 6, 1 → 1 (refused)
	},
	'GET /api/v1/burndown, a goal across boards': {
		owner: { reads: 11, access: 1, hash: '8f66c22e835bc6ca' }, // 11 → 11, 1 → 1
		member: { reads: 7, access: 0, hash: 'ea9084c69a11a14b' }, // 7 → 7, 0 → 0 (refused)
		mate: { reads: 10, access: 0, hash: 'ea9084c69a11a14b' }, // 10 → 10, 0 → 0 (refused)
		admin: { reads: 3, access: 0, hash: '8f66c22e835bc6ca' }, // 3 → 3, 0 → 0
		outsider: { reads: 5, access: 0, hash: 'ea9084c69a11a14b' } // 5 → 5, 0 → 0 (refused)
	},
	'GET /api/v1/burndown, board A': {
		owner: { reads: 5, access: 0, hash: '1035ef7d1a78f56f' }, // 5 → 5, 0 → 0
		member: { reads: 6, access: 0, hash: '1035ef7d1a78f56f' }, // 6 → 6, 0 → 0
		mate: { reads: 8, access: 0, hash: '1035ef7d1a78f56f' }, // 8 → 8, 0 → 0
		admin: { reads: 4, access: 0, hash: '1035ef7d1a78f56f' }, // 4 → 4, 0 → 0
		outsider: { reads: 4, access: 0, hash: '52302279c87a3572' } // 4 → 4, 0 → 0 (refused)
	}
};

describe('each page reads the caller’s boards once, and answers what it did (card 2394)', () => {
	for (const [name, which] of Object.entries(CASES)) {
		it.each(KINDS)(`${name}, for the %s`, async (kind) => {
			const s = scene();
			const { path, ask } = which(s);
			const got = await counted(() => ask(path, s.callers[kind]));
			const pin = PINS[name][kind];
			expect(got.hash).toBe(pin.hash);
			expect(got.access).toBe(pin.access);
			expect(got.reads).toBeLessThanOrEqual(pin.reads);
		});
	}

	// The pinned hashes cannot show this: the burndown page hands back `user`,
	// the caller as signed in, so its five hashes differ whatever else the
	// callers are told. Each case is asked again here and hashed without it;
	// `GET /api/v1/me/stats` is left out, as its entries are the caller's own
	// rows of the log, told apart by their ids whoever can open what.
	it('tells the callers apart by what they are told, not only by who they are', async () => {
		const told: Record<string, Partial<Record<Kind, string>>> = {};
		for (const [name, which] of Object.entries(CASES)) {
			if (name === 'GET /api/v1/me/stats') continue;
			for (const kind of KINDS) {
				resetDb();
				const s = scene();
				const { path, ask } = which(s);
				(told[name] ??= {})[kind] = hashOf(withoutCaller(await ask(path, s.callers[kind])));
			}
		}
		for (const kind of KINDS) {
			for (const other of KINDS) {
				if (other === kind) continue;
				const differ = Object.keys(told).filter((name) => told[name][kind] !== told[name][other]);
				expect(differ.length, `${kind} and ${other}`).toBeGreaterThan(0);
			}
		}
	});
});

/**
 * B is in A's grouping, and only the owner (and an administrator) can open it.
 * The hashes above of the burndown by grouping were pinned on the code as it
 * is, B in the grouping; here what each caller is charted is held by name: a
 * member of A, or of A's team, is charted A alone, and told one board is left
 * out, whether by the grouping or by the goal in it that holds a card on B.
 */
describe('the grouping of A and B, charted for each caller', () => {
	const charted = { owner: ['A', 'B'], member: ['A'], mate: ['A'], admin: ['A', 'B'] } as const;
	const leftOut = (kind: keyof typeof charted) =>
		charted[kind].length === 1 ? ['1 board in this category is not visible to you and is left out.'] : [];

	it.each(Object.keys(charted) as (keyof typeof charted)[])('charts the %s the boards they can open, and no other', async (kind) => {
		const s = scene();
		const user = s.callers[kind];
		const grouping = s.groupings[0].id;

		const page = await load(`/burndown?boardCategoryId=${grouping}&${RANGE}`, user);
		if (page.type !== 'data') throw new Error(`refused: ${page.type}`);
		const { result, boards: picked, boardCategories } = page.data;
		expect(result.scope.boards.map((b: { name: string }) => b.name)).toEqual(charted[kind]);
		const ids = charted[kind].map((name) => (name === 'A' ? s.A : s.B).board.id);
		expect(result.groups.map((g: { id: number }) => g.id).sort((x: number, y: number) => x - y)).toEqual(ids);
		expect(result.meta.notes).toEqual(leftOut(kind));
		expect(picked.some((b: { name: string }) => b.name === 'B')).toBe(charted[kind].length === 2);
		expect(boardCategories.map((c: { name: string }) => c.name)).toEqual(
			charted[kind].length === 2 ? ['Holds A and B', 'Holds Under doing'] : ['Holds A and B']
		);

		const goal = await load(`/burndown?milestoneId=${s.onAGoal.id}&boardCategoryId=${grouping}&${RANGE}`, user);
		if (goal.type !== 'data') throw new Error(`refused: ${goal.type}`);
		expect(goal.data.result.scope.boards.map((b: { name: string }) => b.name)).toEqual(charted[kind]);
		expect(goal.data.result.meta.notes.filter((n: string) => n.includes('not visible'))).toEqual(leftOut(kind));
		expect(goal.data.result.meta.cardCount).toBe(charted[kind].length);

		const api = await get(`/api/v1/burndown?boardCategoryId=${grouping}&${RANGE}`, user);
		expect(api.status).toBe(200);
		expect((api.body as BurndownResult).scope.boards.map((b) => b.name)).toEqual(charted[kind]);
		expect((api.body as BurndownResult).meta.notes).toEqual(leftOut(kind));
	});
});

/**
 * The helpers card 2394 gave `accessible` go through `resolveAccessible`, as
 * card 2393's four do: a `null`, an administrator's "every board", handed for
 * anyone else is read afresh, and answers what the argument left out answers.
 * Trusted, it would have told the outsider of A's sub-board, B's category, the
 * blocker on A and the burndown of every board, and a member of A that A's
 * goal has a card on B.
 */
describe('a null list of boards, handed to the helpers card 2394 gave it', () => {
	it('answers a caller who is not an administrator for their own boards alone', () => {
		const s = scene();
		const outsider = s.callers.outsider;
		const query = () => parseBurndownQuery(new URLSearchParams(RANGE), outsider);

		expect(categoryRule(outsider, null)(s.onB)).toBe(false);
		expect(cardCategoriesFor(outsider, [], null).map((c) => c.name)).toEqual(['Shared']);
		expect([...hiddenOpenCountsFor(outsider, [s.aDoing.id], null)]).toEqual([[s.aDoing.id, 2]]);
		expect(boardsOpenTo(outsider, null)(s.A.board.id)).toBe(false);
		expect(getBlockedStateForCards([s.pTodo.id], outsider, null)[s.pTodo.id].map((n) => n.withheld)).toEqual([true]);
		expect(getBoardBlockedState(s.P.board.id, outsider, null)[s.pTodo.id].map((n) => n.withheld)).toEqual([true]);
		expect(getBurndown(outsider, query(), null).scope.boards.map((b) => b.id)).toEqual([s.P.board.id]);
		// A member of A opens A's goal, and is told the boards of its cards they
		// can open: A, not B, where its card moved off A is.
		const goals = listMilestones(s.callers.member, undefined, undefined, undefined, null);
		expect(goals.find((m) => m.id === s.onAGoal.id)?.boardIds).toEqual([s.A.board.id]);

		// The same as each answers with the list left out. (`milestonesForBoard`
		// asks `canViewMilestone` of each goal too, which hides a trusted `null`
		// in this scene: it is held to the left-out answer only.)
		expect(cardCategoriesFor(outsider, [], null)).toEqual(cardCategoriesFor(outsider));
		expect(hiddenOpenCountsFor(outsider, [s.aDoing.id], null)).toEqual(hiddenOpenCountsFor(outsider, [s.aDoing.id]));
		expect(getBlockedStateForCards([s.pTodo.id], outsider, null)).toEqual(getBlockedStateForCards([s.pTodo.id], outsider));
		expect(milestonesForBoard(outsider, s.A.board.id, null)).toEqual(milestonesForBoard(outsider, s.A.board.id));
		expect(goals).toEqual(listMilestones(s.callers.member));
		expect(hashOf(getBurndown(outsider, query(), null))).toBe(hashOf(getBurndown(outsider, query())));
	});

	it('takes it as every board from an administrator, reading nothing to tell them apart', () => {
		const s = scene();
		const admin = s.callers.admin;

		const budget = readBudget(100);
		let rule, opens;
		try {
			rule = categoryRule(admin, null);
			opens = boardsOpenTo(admin, null);
		} finally {
			budget.restore();
		}
		expect(budget.count).toBe(0);
		expect(rule(s.onB)).toBe(true);
		expect(opens(s.A.board.id)).toBe(true);
		expect(getBlockedStateForCards([s.pTodo.id], admin, null)[s.pTodo.id].map((n) => n.withheld)).toEqual([false]);
	});
});
