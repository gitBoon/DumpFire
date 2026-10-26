/**
 * Options are left out of every delivery measure (milestone 22, card 2462,
 * slice S4a: the server side).
 *
 * One rule: a delivery measure counts committed cards on delivery boards
 * only. A card in a board's Options column, or on an ideas board, is an
 * option, upstream of the commitment point, and is in none of them; where a
 * figure describes upstream it comes from `upstreamFigures`.
 *
 * The first two tests are the guard: one scene of ordinary boards, with no
 * Options column, whose every delivery figure is pinned as the code gave it
 * before this slice (the pins were taken on the old code, and passed there);
 * and the same scene with options added everywhere a figure could pick them
 * up, an Options column on the board, options in it live, returned and
 * discarded, an ideas board, an option on a sub-board and in a goal, Options
 * snapshots for the flow diagram, which must give exactly the same figures.
 *
 * Then each measure on its own: lead time from the commitment, cycle time
 * bounded by it (ruling a, each case also after a return and a second
 * commitment, and the clamp), "Committed (all)" (ruling d), time in options
 * (ruling e), aging (ruling g), the flow diagram's upstream band (ruling h),
 * the reports' stored role (the S1b review's B6), and the upstream figures
 * on the answers that carry them. The scenes pass `committedAt` explicitly,
 * different from `createdAt` (the S1a review's R6).
 *
 * The plan is `docs/planning/milestone-22-upstream-kanban.md`, section 3's
 * card D and section 7.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { activityLog, boards, cards, columns, dailySnapshots, subtasks, type Card, type Column } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { generateBoardReport, generateCardReport, generateReportPdf } from '$lib/server/reports';
import { buildActivityReport } from '$lib/server/activity-report';
import { listMilestones } from '$lib/server/milestones';
import { getMilestoneSummary } from '$lib/server/planning';
import { getCompletionBlocker, subBoardProgress } from '$lib/server/card-completion';
import {
	commitmentColumns,
	commitmentSuffix,
	committedAll,
	conversionSuffix,
	cycleStarts,
	flowTimes,
	timeInOptions,
	upstreamFigures
} from '$lib/server/upstream';
import { boardStats } from '$lib/board/board-stats';
import { stamp } from '$lib/timestamps';
import { api } from './helpers/api';
import { pageLoad } from './helpers/actions';
import { pdfText } from './helpers/pdf';
import { readBudget } from './helpers/reads';
import {
	assignCard,
	makeBoard,
	makeCard,
	makeDependency,
	makeMilestone,
	makeSubBoard,
	makeSubtask,
	makeUser,
	resetDb,
	type BoardFixture,
	type SubBoardFixture
} from './helpers/fixtures';

/** The moment every test runs at: the clock is fixed, so every window is. */
const NOW = new Date('2026-06-30T12:00:00Z');

beforeEach(() => {
	resetDb();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.useRealTimers();
});

/** An activity entry, at a moment of the test's choosing. */
function entry(board: BoardFixture | { board: { id: number } }, card: Card | null, action: string, createdAt: string, detail = '') {
	db.insert(activityLog).values({ boardId: board.board.id, cardId: card?.id ?? null, action, detail, createdAt }).run();
}

/** An Options column titled "Ideas", at the left of the board. */
function optionsColumnOn(board: BoardFixture | SubBoardFixture): Column {
	return db.insert(columns).values({ boardId: board.board.id, title: 'Ideas', position: -1, role: 'options', wipLimit: 0 }).returning().get();
}

type Scene = {
	owner: SessionUser;
	ann: SessionUser;
	O: BoardFixture;
	N: BoardFixture;
	sub: SubBoardFixture;
	goal: { id: number };
	c: Record<string, Card>;
};

/**
 * Two ordinary boards. O has the four standard columns: two cards completed
 * in the last 30 days (each moved once, so each has a cycle time), one in
 * progress and overdue, one waiting in To Do, one on hold, one archived, a
 * sub-board under the card in progress, and a goal of three of them. N has an
 * ordinary column titled "Ideas", which reports have always counted as To Do
 * (it is no Options column), with a card in it.
 */
function ordinaryScene(): Scene {
	const owner = makeUser({ username: 'owner' });
	const ann = makeUser({ username: 'ann' });
	const O = makeBoard({ owner, name: 'O' });
	const N = makeBoard({ owner, name: 'N', columns: ['Ideas', 'Doing', 'Done'] });
	const at = (createdAt: string, more: Partial<typeof cards.$inferInsert> = {}) => ({ createdAt, updatedAt: createdAt, createdBy: owner.id, ...more });
	const c = {
		fast: makeCard(O.cols['Complete'], { title: 'Done fast', ...at('2026-06-01 09:00:00', { completedAt: '2026-06-03 09:00:00', priority: 'high' }) }),
		slow: makeCard(O.cols['Complete'], { title: 'Done slow', ...at('2026-05-20 09:00:00', { completedAt: '2026-06-20 09:00:00' }) }),
		doing: makeCard(O.cols['In Progress'], { title: 'Doing', ...at('2026-06-10 09:00:00', { dueDate: '2026-06-01', priority: 'critical' }) }),
		waiting: makeCard(O.cols['To Do'], { title: 'Waiting', ...at('2026-06-25 09:00:00') }),
		held: makeCard(O.cols['On Hold'], { title: 'Held', ...at('2026-04-01 09:00:00') }),
		gone: makeCard(O.cols['To Do'], { title: 'Gone', ...at('2026-05-01 09:00:00', { archivedAt: '2026-06-05 09:00:00' }) }),
		idea: makeCard(N.cols['Ideas'], { title: 'Ordinary idea', ...at('2026-06-12 09:00:00') })
	};
	makeSubtask(c.doing);
	makeSubtask(c.waiting, { completed: true });
	assignCard(c.fast, ann);
	assignCard(c.slow, owner);
	assignCard(c.doing, owner);
	assignCard(c.held, ann);
	entry(O, c.fast, 'card_moved', '2026-06-02 09:00:00');
	entry(O, c.slow, 'card_moved', '2026-05-25 09:00:00');
	entry(O, c.slow, 'api:card_moved', '2026-05-26 09:00:00');
	entry(O, c.fast, 'card_completed', '2026-06-03 09:00:00');
	entry(O, c.slow, 'card_completed', '2026-06-20 09:00:00');
	entry(O, c.doing, 'card_moved', '2026-06-11 09:00:00');
	const sub = makeSubBoard(c.doing, { owner, name: 'Under doing', cards: { 'To Do': 1, Complete: 1 } });
	const goal = makeMilestone({ board: O.board, cards: [c.fast, c.doing, c.waiting] });
	for (const [date, counts] of [['2026-06-20', [1, 1, 1, 1]], ['2026-06-21', [1, 1, 2, 1]]] as const) {
		['To Do', 'On Hold', 'In Progress', 'Complete'].forEach((title, i) => {
			db.insert(dailySnapshots).values({ boardId: O.board.id, columnId: O.cols[title].id, date, cardCount: counts[i] }).run();
		});
	}
	db.update(boards).set({ createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00' }).run();
	return { owner, ann, O, N, sub, goal, c };
}

/**
 * The ordinary scene with options wherever a figure could pick them up: O's
 * Options column, titled "Ideas" (a title reports took for To Do), holding a
 * live option that is overdue, critical, assigned to the owner, with a
 * subtask and in the goal; one returned to options in the window; one
 * discarded in it; snapshots of the Options column; an ideas board of the
 * owner's with an idea assigned to them; and an Options column on the
 * sub-board with an option in it.
 */
function withUpstream(s: Scene) {
	const options = optionsColumnOn(s.O);
	const ideas = makeCard(options, { title: 'An option', createdAt: '2026-06-05 09:00:00', updatedAt: '2026-06-05 09:00:00', dueDate: '2026-06-01', priority: 'critical' });
	makeSubtask(ideas);
	assignCard(ideas, s.owner);
	db.update(cards).set({ milestoneId: s.goal.id }).where(eq(cards.id, ideas.id)).run();
	const returned = makeCard(options, { title: 'Returned', createdAt: '2026-03-01 09:00:00', updatedAt: '2026-06-15 09:00:00' });
	entry(s.O, returned, 'card_returned_to_options', '2026-06-15 09:00:00');
	const discarded = makeCard(options, {
		title: 'Discarded',
		createdAt: '2026-06-02 09:00:00',
		updatedAt: '2026-06-12 09:00:00',
		archivedAt: '2026-06-12 09:00:00',
		discardedAt: '2026-06-12 09:00:00'
	});
	entry(s.O, discarded, 'card_discarded', '2026-06-12 09:00:00');
	for (const date of ['2026-06-20', '2026-06-21']) {
		db.insert(dailySnapshots).values({ boardId: s.O.board.id, columnId: options.id, date, cardCount: 3 }).run();
	}
	const I = makeBoard({ owner: s.owner, name: 'I', columns: ['New Ideas', 'Shaping'] });
	db.update(boards).set({ kind: 'ideas' }).where(eq(boards.id, I.board.id)).run();
	assignCard(makeCard(I.cols['New Ideas'], { title: 'An idea' }), s.owner);
	makeCard(optionsColumnOn(s.sub), { title: 'Sub option' });
	db.update(boards).set({ createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00' }).run();
	return { options, I };
}

function dataOf(page: Awaited<ReturnType<typeof pageLoad>>): any {
	expect(page.type).toBe('data');
	return (page as { data: unknown }).data;
}

/** Every delivery figure of the scene, as its pages, routes and reports give it. */
async function figures(s: Scene) {
	const user = s.owner;
	const O = s.O.board.id;
	const metrics = (await api('GET', `/api/boards/${O}/metrics?days=30`, { user })).body;
	const burndown = (await api('GET', `/api/burndown?boardIds=${O}&days=30`, { user })).body;
	const cfd = (await api('GET', `/api/boards/${O}/cfd?days=30`, { user })).body;
	const dashboard = dataOf(await pageLoad('/', { user }));
	const myTasks = (await api('GET', '/api/my-tasks', { user })).body;
	const meStats = (await api('GET', '/api/v1/me/stats', { user })).body;
	const report = generateBoardReport(O, '2026-06-01', '2026-06-30', user)!;
	const activity = buildActivityReport({ actor: user, from: '2026-06-01', to: '2026-06-30', boardIds: [O, s.N.board.id] });
	const summary = getMilestoneSummary(s.goal.id, user)!;
	const all = dataOf(await pageLoad('/all', { user }));
	const oRow = dashboard.boards.find((b: any) => b.id === O);
	const a = dashboard.analytics;
	const { totalCards, totalSubtasks, totalTasks, completedInPeriod, createdInPeriod, outstanding, todo, inProgress, overdue } = report.summary;
	return {
		metrics: {
			completed: metrics.completed,
			leadTime: metrics.leadTime,
			cycleTime: metrics.cycleTime,
			cards: metrics.cards.map((c: any) => [c.title, c.leadTimeHours, c.cycleTimeHours])
		},
		burndown: {
			summary: burndown.summary,
			series: burndown.series.map((p: any) => `${p.date.slice(5)} ${p.scope}/${p.done}/${p.removed}`),
			delivery: [burndown.delivery.remaining, burndown.delivery.basisFinished, burndown.delivery.throughputPerWeek, burndown.delivery.arrivalPerWeek],
			cardCount: burndown.meta.cardCount
		},
		cfd: { columns: cfd.columns.map((c: any) => c.title), data: cfd.data.map((d: any) => [d.date, ...d.columns.map((c: any) => c.count)]) },
		dashboard: {
			O: `${oRow.totalCards} cards, ${oRow.completedCards} done; ${oRow.subBoards.map((b: any) => `${b.name} ${b.done}/${b.total}`).join()}`,
			allTasks: [dashboard.allTasksTotals.cards, dashboard.allTasksTotals.completedCards, dashboard.allTasksTotals.subtasks, dashboard.allTasksTotals.tasks],
			mine: [a.totalAssigned, a.active, a.completed, a.completionRate, a.longOverdue, a.onHoldCount],
			priorityCounts: a.priorityCounts,
			dueCards: a.dueCards.map((c: any) => c.title),
			agingBuckets: a.agingBuckets,
			teamLeaderboard: a.teamLeaderboard.map((u: any) => `${u.username}: ${u.completed} done, ${u.active} active`),
			boardHealth: a.boardHealth.map((b: any) => `${b.name} ${b.completedCards}/${b.totalCards} ${b.pct}%`),
			categoryDistribution: a.categoryDistribution.map((c: any) => `${c.name} ${c.count}`)
		},
		myTasks: myTasks.map((g: any) => [g.boardName, ...g.cards.map((c: any) => c.title)]),
		meStats: [meStats.avgCycleTimeDays, meStats.activeCards],
		report: {
			summary: { totalCards, totalSubtasks, totalTasks, completedInPeriod, createdInPeriod, outstanding, todo, inProgress, overdue },
			priorityBreakdown: report.priorityBreakdown,
			assigneeStats: report.assigneeStats.map((u) => `${u.username}: ${u.completedInPeriod} done, ${u.outstanding} outstanding`),
			outstanding: report.outstandingTasks.flatMap((b) => b.tasks.map((t) => `${t.title} (${t.columnTitle})`)),
			boardBreakdown: report.boardBreakdown.map((b) => `${b.boardName}: ${b.completedCards}/${b.totalCards}, ${b.completedInPeriod} in period`)
		},
		activity: {
			totals: activity.totals,
			cards: activity.boards.flatMap((b) => b.cards.map((c) => `${c.title}: ${c.bucket}`)),
			milestones: activity.milestones.map((m) => `${m.totalCards} cards, ${m.completedAtStart} → ${m.completedAtEnd}`)
		},
		goals: listMilestones(user, O).map((m) => `${m.cardCount} cards, ${m.doneCount} done`),
		plan: {
			total: summary.progress.total,
			done: summary.progress.done,
			percent: summary.progress.percent,
			byColumn: summary.progress.byColumn,
			subtasks: [summary.progress.openSubtasks, summary.progress.totalSubtasks],
			boards: summary.progress.boards.map((b) => `${b.name} ${b.cardCount}`),
			nextActionable: summary.nextActionable.map((n) => n.title)
		},
		subBoard: subBoardProgress([s.sub.board.id]).get(s.sub.board.id),
		all: {
			totalCards: all.totalCards,
			completedCards: all.completedCards,
			buckets: all.buckets.filter((b: any) => b.title !== 'Options').map((b: any) => `${b.title}: ${b.cards.map((c: any) => c.title).join(', ')}`)
		}
	};
}

/** Each day of the burndown, `MM-DD scope/done/removed`, from `first` to `last` inclusive. */
function days(first: number, last: number, figures: string): string[] {
	return Array.from({ length: last - first + 1 }, (_, i) => `06-${String(first + i).padStart(2, '0')} ${figures}`);
}

/** What the old code gave the ordinary scene, figure by figure: taken on it, and passed there. */
const PINNED = {
	metrics: {
		completed: 2,
		leadTime: { avgHours: 396, medianHours: 396, avgFormatted: '16d 12h', medianFormatted: '16d 12h' },
		cycleTime: { avgHours: 324, medianHours: 324, avgFormatted: '13d 12h', medianFormatted: '13d 12h' },
		cards: [
			['Done fast', 48, 24],
			['Done slow', 744, 624]
		]
	},
	burndown: {
		summary: { scopeStart: 3, scopeNow: 5, doneStart: 0, doneNow: 2, remainingStart: 3, remainingNow: 3, added: 3, completed: 2, removed: 1 },
		series: [
			...days(1, 2, '4/0/0'),
			...days(3, 4, '4/1/0'),
			...days(5, 5, '3/1/1'),
			...days(6, 9, '3/1/0'),
			...days(10, 19, '4/1/0'),
			...days(20, 24, '4/2/0'),
			...days(25, 30, '5/2/0')
		],
		delivery: [3, 2, 0.5, 0.25],
		cardCount: 6
	},
	cfd: {
		columns: ['To Do', 'On Hold', 'In Progress', 'Complete'],
		data: [
			['2026-06-20', 1, 1, 1, 1],
			['2026-06-21', 1, 1, 2, 1]
		]
	},
	dashboard: {
		O: '5 cards, 2 done; Under doing 1/2',
		allTasks: [8, 3, 2, 10],
		mine: [2, 1, 1, 50, 1, 0],
		priorityCounts: { critical: 1, high: 0, medium: 0, low: 0 },
		dueCards: [],
		agingBuckets: { fresh: 0, week: 0, fortnight: 0, month: 1, stale: 0 },
		teamLeaderboard: ['ann: 1 done, 1 active', 'owner: 1 done, 1 active'],
		boardHealth: ['O 2/5 40%', 'N 0/1 0%'],
		categoryDistribution: ['Uncategorised 6']
	},
	myTasks: [['O', 'Doing']],
	meStats: [31, 1],
	report: {
		summary: { totalCards: 7, totalSubtasks: 2, totalTasks: 9, completedInPeriod: 2, createdInPeriod: 3, outstanding: 4, todo: 2, inProgress: 2, overdue: 1 },
		priorityBreakdown: { critical: 1, high: 0, medium: 3, low: 0 },
		assigneeStats: ['ann: 1 done, 1 outstanding', 'owner: 1 done, 1 outstanding'],
		outstanding: ['Doing (In Progress)', 'Waiting (To Do)', 'Held (On Hold)', 'Card 12 (To Do)'],
		boardBreakdown: ['O: 2/5, 2 in period', 'Under doing: 1/2, 0 in period']
	},
	activity: {
		totals: { completed: 2, closed: 0, progressed: 1, 'on hold': 0, created: 2, boards: 2, cards: 5 },
		cards: ['Done fast: completed', 'Done slow: completed', 'Doing: progressed', 'Waiting: created', 'Ordinary idea: created'],
		milestones: ['3 cards, 0 → 1']
	},
	goals: ['3 cards, 1 done'],
	plan: {
		total: 3,
		done: 1,
		percent: 33,
		byColumn: [
			{ columnTitle: 'Complete', count: 1 },
			{ columnTitle: 'In Progress', count: 1 },
			{ columnTitle: 'To Do', count: 1 }
		],
		subtasks: [1, 2],
		boards: ['O 3'],
		nextActionable: ['Doing', 'Waiting']
	},
	subBoard: { done: 1, total: 2 },
	all: {
		totalCards: 8,
		completedCards: 3,
		buckets: ['To Do: Waiting, Card 12', 'Ideas: Ordinary idea', 'On Hold: Held', 'In Progress: Doing', 'Complete: Card 13, Done slow, Done fast']
	}
};

describe('the guard: options change no delivery figure', () => {
	it('gives every delivery figure of a board with no Options column as before this slice', async () => {
		expect(await figures(ordinaryScene())).toEqual(PINNED);
	});

	it('gives the same figures with options added everywhere a figure could count them', async () => {
		const s = ordinaryScene();
		withUpstream(s);
		expect(await figures(s)).toEqual(PINNED);
	});
});

/** A delivery board A, To Do, In Progress and Complete, with an Options column "Ideas" at its left. */
function flowBoard() {
	const owner = makeUser({ username: 'owner' });
	const A = makeBoard({ owner, name: 'A', columns: ['To Do', 'In Progress', 'Complete'] });
	const options = optionsColumnOn(A);
	return { owner, A, options };
}

/**
 * A `card_committed` entry into `column`, its detail ending with the column's
 * id and, given `from`, the id of the column it left, as a move writes it
 * (`commitmentSuffix`); without `from`, as an entry written before the S4a
 * review, naming only the column it went into.
 */
function committedInto(board: BoardFixture, card: Card, column: Column, at: string, from: Column | null = null) {
	const suffix = from === null ? conversionSuffix(column.id) : commitmentSuffix(column.id, from.id);
	entry(board, card, 'card_committed', at, `"${card.title}": Ideas → ${column.title}${suffix}`);
}

/** A card completed in `board`'s Complete column, made at `createdAt` and committed at `committedAt`. */
function completedCard(board: BoardFixture, title: string, createdAt: string, committedAt: string, completedAt: string) {
	return makeCard(board.cols['Complete'], { title, createdAt, updatedAt: completedAt, committedAt, completedAt });
}

describe('lead time and cycle time (rulings a and e)', () => {
	/**
	 * Four cards, each made long before it was committed (R6), each committed
	 * on 10 June at 09:00 and completed on 12 June at 09:00: committed into To
	 * Do and moved on the 11th; committed straight into In Progress; and each
	 * of the two again after an earlier round of work, a move in May and a
	 * return to options.
	 */
	function scene() {
		const { owner, A } = flowBoard();
		const card = (title: string, createdAt: string) => completedCard(A, title, createdAt, '2026-06-10 09:00:00', '2026-06-12 09:00:00');
		const intoTodo = card('Into To Do', '2026-06-01 09:00:00');
		const intoProgress = card('Into In Progress', '2026-06-01 09:00:00');
		const againTodo = card('Again into To Do', '2026-05-01 09:00:00');
		const againProgress = card('Again into In Progress', '2026-05-01 09:00:00');
		for (const again of [againTodo, againProgress]) {
			entry(A, again, 'card_moved', '2026-05-05 09:00:00');
			entry(A, again, 'card_returned_to_options', '2026-05-10 09:00:00');
		}
		for (const todo of [intoTodo, againTodo]) {
			committedInto(A, todo, A.cols['To Do'], '2026-06-10 09:00:00');
			entry(A, todo, 'api:card_moved', '2026-06-11 09:00:00');
		}
		for (const progress of [intoProgress, againProgress]) committedInto(A, progress, A.cols['In Progress'], '2026-06-10 09:00:00');
		return { owner, A };
	}

	it('runs lead time from the commitment, and cycle time from the start of work after it', async () => {
		const { owner, A } = scene();
		const res = await api('GET', `/api/boards/${A.board.id}/metrics?days=30`, { user: owner });
		expect(res.status).toBe(200);
		expect(res.body.cards.map((c: any) => [c.title, c.leadTimeHours, c.cycleTimeHours])).toEqual([
			['Into To Do', 48, 24],
			['Into In Progress', 48, 48],
			['Again into To Do', 48, 24],
			['Again into In Progress', 48, 48]
		]);
		expect(res.body.cards[0].committedAt).toBe('2026-06-10 09:00:00');
		expect(res.body.leadTime).toEqual({ avgHours: 48, medianHours: 48, avgFormatted: '2d', medianFormatted: '2d' });
		expect(res.body.cycleTime).toEqual({ avgHours: 36, medianHours: 36, avgFormatted: '1d 12h', medianFormatted: '1d 12h' });
	});

	it('finds no start for a card committed into To Do and completed without a move, nor for a commitment into a column since deleted', () => {
		const { A } = scene();
		const unmoved = completedCard(A, 'Unmoved', '2026-06-01 09:00:00', '2026-06-10 09:00:00', '2026-06-12 09:00:00');
		committedInto(A, unmoved, A.cols['To Do'], '2026-06-10 09:00:00');
		const gone = completedCard(A, 'Gone column', '2026-06-01 09:00:00', '2026-06-10 09:00:00', '2026-06-12 09:00:00');
		entry(A, gone, 'card_committed', '2026-06-10 09:00:00', `"Gone column": Ideas → Review${conversionSuffix(9999)}`);
		const starts = cycleStarts([unmoved, gone]);
		expect(starts.has(unmoved.id)).toBe(false);
		expect(starts.has(gone.id)).toBe(false);
	});

	it('gives a card made before milestone 22 its first move as the start, as before', () => {
		const { A } = flowBoard();
		const old = makeCard(A.cols['Complete'], { createdAt: '2026-04-01 09:00:00', completedAt: '2026-04-09 09:00:00' });
		expect(old.committedAt).toBe(old.createdAt);
		entry(A, old, 'card_moved', '2026-04-03 09:00:00');
		entry(A, old, 'card_moved', '2026-04-05 09:00:00');
		expect(cycleStarts([old]).get(old.id)).toBe('2026-04-03 09:00:00');
	});

	it('never gives a cycle time longer than the lead time', () => {
		const card = { createdAt: '2026-06-01 09:00:00', committedAt: '2026-06-10 09:00:00', completedAt: '2026-06-12 09:00:00' };
		expect(flowTimes(card, '2026-06-11 09:00:00')).toEqual({ leadTimeHours: 48, cycleTimeHours: 24 });
		// A start before the commitment, which `cycleStarts` never gives: clamped to the lead time.
		expect(flowTimes(card, '2026-06-02 09:00:00')).toEqual({ leadTimeHours: 48, cycleTimeHours: 48 });
		expect(flowTimes(card, undefined)).toEqual({ leadTimeHours: 48, cycleTimeHours: null });
		expect(flowTimes({ ...card, committedAt: null }, undefined).leadTimeHours).toBe(264);
	});

	it('gives the time the cards committed from options waited there, from the latest of creation, return and conversion', async () => {
		const { owner, A, options } = flowBoard();
		// Made in Options on 1 June, committed on the 10th: 216 hours.
		const fresh = makeCard(A.cols['To Do'], { title: 'Fresh', createdAt: '2026-06-01 09:00:00', committedAt: '2026-06-10 09:00:00' });
		committedInto(A, fresh, A.cols['To Do'], '2026-06-10 09:00:00');
		// Returned to options on 10 May, committed again on 10 June: 744 hours.
		const back = makeCard(A.cols['To Do'], { title: 'Back', createdAt: '2026-04-01 09:00:00', committedAt: '2026-06-10 09:00:00' });
		entry(A, back, 'card_returned_to_options', '2026-05-10 09:00:00');
		committedInto(A, back, A.cols['To Do'], '2026-06-10 09:00:00');
		// On board B, made in April in a column converted to Options on 1 June,
		// committed on the 5th: 96 hours, from the conversion.
		const B = makeBoard({ owner, name: 'B', columns: ['To Do'] });
		const bOptions = optionsColumnOn(B);
		const converted = makeCard(B.cols['To Do'], { title: 'Converted', createdAt: '2026-04-01 09:00:00', committedAt: '2026-06-05 09:00:00' });
		entry(B, null, 'column_converted_to_options', '2026-06-01 09:00:00', `1 card became options${conversionSuffix(bOptions.id)}`);
		committedInto(B, converted, B.cols['To Do'], '2026-06-05 09:00:00', bOptions);
		// Committed and returned again in the window: its last act is a return, so it is not measured.
		const undecided = makeCard(options, { title: 'Undecided', createdAt: '2026-06-01 09:00:00' });
		committedInto(A, undecided, A.cols['To Do'], '2026-06-03 09:00:00');
		entry(A, undecided, 'card_returned_to_options', '2026-06-04 09:00:00');
		// Committed before the window: not measured.
		const earlier = makeCard(A.cols['To Do'], { title: 'Earlier', createdAt: '2026-04-01 09:00:00', committedAt: '2026-05-01 09:00:00' });
		committedInto(A, earlier, A.cols['To Do'], '2026-05-01 09:00:00');

		const res = await api('GET', `/api/boards/${A.board.id}/metrics?days=30`, { user: owner });
		expect(res.body.timeInOptions).toEqual({ avgHours: 480, medianHours: 480, avgFormatted: '20d', medianFormatted: '20d' });
		expect(timeInOptions([A.board.id, B.board.id], '2026-05-31', '2026-06-30').map((t) => [t.cardId, t.optionSince, t.committedAt])).toEqual([
			[converted.id, '2026-06-01 09:00:00', '2026-06-05 09:00:00'],
			[fresh.id, '2026-06-01 09:00:00', '2026-06-10 09:00:00'],
			[back.id, '2026-05-10 09:00:00', '2026-06-10 09:00:00']
		]);
		// No card completed: the lead and cycle times are null, the window's figures are there.
		expect(res.body).toMatchObject({ completed: 0, leadTime: null, cycleTime: null, days: 30 });
	});

	it('counts a conversion of the column a card left, on another board, only if the card was there when it happened (H3)', () => {
		const owner = makeUser();
		const A = makeBoard({ owner, name: 'A', columns: ['Backlog', 'To Do'] });
		const B = makeBoard({ owner, name: 'B', columns: ['To Do'] });
		const C = makeBoard({ owner, name: 'C', columns: ['To Do'] });
		db.update(columns).set({ role: 'options', position: -1 }).where(eq(columns.id, A.cols['Backlog'].id)).run();
		entry(A, null, 'column_converted_to_options', '2026-06-01 09:00:00', `1 card became an option${conversionSuffix(A.cols['Backlog'].id)}`);
		const committedOnB = (title: string, at: string) => {
			const card = makeCard(B.cols['To Do'], { title, createdAt: '2026-01-01 09:00:00', committedAt: at });
			entry(A, card, 'card_moved_away', at);
			entry(B, card, 'card_moved_in', at);
			committedInto(B, card, B.cols['To Do'], at, A.cols['Backlog']);
			return card;
		};
		// On A since January, its column converted on 1 June, sent to B's To Do on the 5th: an option from the conversion.
		const stayed = committedOnB('Stayed', '2026-06-05 09:00:00');
		// Made on C in January, moved into A's Options on 3 June, after the conversion, then to B's To Do on the 6th:
		// the conversion is not its, so its creation stands.
		const arrived = makeCard(B.cols['To Do'], { title: 'Arrived', createdAt: '2026-01-01 09:00:00', committedAt: '2026-06-06 09:00:00' });
		entry(C, arrived, 'card_moved_away', '2026-06-03 09:00:00');
		entry(A, arrived, 'card_moved_in', '2026-06-03 09:00:00');
		entry(A, arrived, 'card_moved_away', '2026-06-06 09:00:00');
		entry(B, arrived, 'card_moved_in', '2026-06-06 09:00:00');
		committedInto(B, arrived, B.cols['To Do'], '2026-06-06 09:00:00', A.cols['Backlog']);
		expect(timeInOptions([B.board.id], '2026-06-01', '2026-06-30').map((t) => [t.cardId, t.optionSince])).toEqual([
			[stayed.id, '2026-06-01 09:00:00'],
			[arrived.id, '2026-01-01 09:00:00']
		]);
	});

	it('reads both columns of a commitment’s detail back, and an older detail’s one', () => {
		expect(commitmentColumns(`"T": Ideas → To Do${commitmentSuffix(4, 9)}`)).toEqual({ to: 4, from: 9 });
		expect(commitmentColumns(`"T": Ideas → To Do${conversionSuffix(4)}`)).toEqual({ to: 4, from: null });
		expect(commitmentColumns('"T (column 7)": Ideas → To Do')).toEqual({ to: null, from: null });
		expect(commitmentSuffix(4, 9)).toBe(' (column 4, from column 9)');
	});
});

describe('the start of work after a commitment into a queue (H1) and after completion (H5)', () => {
	/** A board Ideas (Options) | `titles` …, each card committed into `into` on 1 June, moved on the 10th and completed on the 12th. */
	function startOf(titles: string[], into: string, moved = true) {
		resetDb();
		const owner = makeUser();
		const board = makeBoard({ owner, columns: titles });
		const options = optionsColumnOn(board);
		const card = makeCard(board.cols['Complete'], { createdAt: '2026-05-01 09:00:00', committedAt: '2026-06-01 09:00:00', completedAt: '2026-06-12 09:00:00' });
		committedInto(board, card, board.cols[into], '2026-06-01 09:00:00', options);
		if (moved) entry(board, card, 'card_moved', '2026-06-10 09:00:00');
		const started = cycleStarts([card]).get(card.id);
		return flowTimes({ ...card, completedAt: card.completedAt! }, started).cycleTimeHours;
	}

	it('starts work at the next move after a commitment into Backlog, Ready, On Hold or the board’s first committed column', () => {
		expect(startOf(['Backlog', 'In Progress', 'Complete'], 'Backlog')).toBe(48);
		expect(startOf(['To Do', 'Ready', 'In Progress', 'Complete'], 'Ready')).toBe(48);
		expect(startOf(['To Do', 'On Hold', 'In Progress', 'Complete'], 'On Hold')).toBe(48);
		expect(startOf(['Intake', 'In Progress', 'Complete'], 'Intake')).toBe(48);
		// And none at all where the card was never moved after it.
		expect(startOf(['Intake', 'In Progress', 'Complete'], 'Intake', false)).toBeNull();
	});

	it('starts work at a commitment into a working column that is not the first', () => {
		expect(startOf(['Intake', 'In Progress', 'Complete'], 'In Progress')).toBe(264);
		expect(startOf(['To Do', 'Review', 'Complete'], 'Review')).toBe(264);
	});

	it('takes no move after the completion as the start, and never gives a cycle time below 0', () => {
		const { A } = flowBoard();
		const done = completedCard(A, 'Done', '2026-06-01 09:00:00', '2026-06-01 09:00:00', '2026-06-12 09:00:00');
		// Moved from one Complete column to another two days after it was done.
		entry(A, done, 'card_moved', '2026-06-14 09:00:00');
		expect(cycleStarts([done]).has(done.id)).toBe(false);
		const card = { createdAt: '2026-06-01 09:00:00', committedAt: '2026-06-10 09:00:00', completedAt: '2026-06-12 09:00:00' };
		expect(flowTimes(card, '2026-06-14 09:00:00')).toEqual({ leadTimeHours: 48, cycleTimeHours: 0 });
	});
});

describe('Committed (all) and the upstream figures on the metrics (rulings d, f and g)', () => {
	it('counts each card that arrived as committed work in the window once, whichever way it arrived', async () => {
		const { owner, A, options } = flowBoard();
		const committed = makeCard(A.cols['To Do'], { title: 'From options', createdAt: '2026-05-01 09:00:00', committedAt: '2026-06-10 09:00:00' });
		committedInto(A, committed, A.cols['To Do'], '2026-06-10 09:00:00');
		// Committed twice in the window: once.
		committedInto(A, committed, A.cols['To Do'], '2026-06-08 09:00:00');
		// Made straight into To Do in the window, and made there and committed again: once each.
		const direct = makeCard(A.cols['To Do'], { title: 'Direct', createdAt: '2026-06-15 09:00:00' });
		committedInto(A, direct, A.cols['To Do'], '2026-06-16 09:00:00');
		makeCard(A.cols['Complete'], { title: 'Direct and done', createdAt: '2026-06-16 09:00:00', completedAt: '2026-06-17 09:00:00' });
		// A deleted card's commitment: once, as it cannot be told apart.
		entry(A, null, 'api:card_committed', '2026-06-20 09:00:00');
		// Not arrivals in the window: an option, a card made before it, a commitment before it.
		makeCard(options, { title: 'An option', createdAt: '2026-06-15 09:00:00' });
		makeCard(A.cols['To Do'], { title: 'Old', createdAt: '2026-05-01 09:00:00' });
		const before = makeCard(A.cols['To Do'], { title: 'Before', createdAt: '2026-04-01 09:00:00', committedAt: '2026-05-20 09:00:00' });
		committedInto(A, before, A.cols['To Do'], '2026-05-20 09:00:00');

		expect(committedAll([A.board.id], '2026-05-31', '2026-06-30')).toBe(4);
		const res = await api('GET', `/api/boards/${A.board.id}/metrics?days=30`, { user: owner });
		expect(res.body.committed).toBe(4);
		expect(res.body.completed).toBe(1);
	});

	it('answers the board’s upstream figures for the window, abandoned work and the aging of its options among them', async () => {
		const { owner, A, options } = flowBoard();
		makeCard(options, { title: 'Stale', createdAt: '2026-04-01 09:00:00' });
		makeCard(options, { title: 'New', createdAt: '2026-06-25 09:00:00' });
		const discarded = makeCard(options, { title: 'Dropped', createdAt: '2026-06-01 09:00:00', archivedAt: '2026-06-05 09:00:00', discardedAt: '2026-06-05 09:00:00' });
		entry(A, discarded, 'card_discarded', '2026-06-05 09:00:00');
		const committed = makeCard(A.cols['To Do'], { title: 'Taken on', createdAt: '2026-06-01 09:00:00', committedAt: '2026-06-06 09:00:00' });
		committedInto(A, committed, A.cols['To Do'], '2026-06-06 09:00:00');
		const abandoned = makeCard(A.cols['In Progress'], { title: 'Abandoned', archivedAt: '2026-06-07 09:00:00' });
		entry(A, abandoned, 'card_abandoned', '2026-06-07 09:00:00');

		const res = await api('GET', `/api/boards/${A.board.id}/metrics?days=30`, { user: owner });
		expect(res.body.upstream).toEqual({
			options: 2,
			committedFromOptions: 1,
			returnedToOptions: 0,
			discarded: 1,
			sentOn: 0,
			abandoned: 1,
			discardRate: 0.5,
			oldestOptionDays: 90,
			agingOptions: 1
		});
		expect(res.body.upstream).toEqual(upstreamFigures([A.board.id], stamp(new Date(NOW.getTime() - 30 * 86400000)), stamp(NOW)));
	});

	it('gives an ideas board, with no Complete column, no lead or cycle time and its upstream figures', async () => {
		const owner = makeUser();
		const I = makeBoard({ owner, columns: ['New Ideas', 'Shaping'] });
		db.update(boards).set({ kind: 'ideas' }).where(eq(boards.id, I.board.id)).run();
		makeCard(I.cols['Shaping'], { createdAt: '2026-06-01 09:00:00' });
		const res = await api('GET', `/api/boards/${I.board.id}/metrics`, { user: owner });
		expect(res.body).toMatchObject({ completed: 0, leadTime: null, cycleTime: null, committed: 0, timeInOptions: null });
		expect(res.body.upstream.options).toBe(1);
	});

	it('gives an ordinary board the same lead time from the commitment as from creation, which every card made there shares', async () => {
		const s = ordinaryScene();
		const res = await api('GET', `/api/boards/${s.O.board.id}/metrics?days=30`, { user: s.owner });
		for (const c of res.body.cards) expect(c.committedAt).toBe(c.createdAt);
		expect(res.body.upstream).toEqual({
			options: 0,
			committedFromOptions: 0,
			returnedToOptions: 0,
			discarded: 0,
			sentOn: 0,
			abandoned: 0,
			discardRate: null,
			oldestOptionDays: null,
			agingOptions: 0
		});
		// Made in the window, each straight into a committed column: Done fast, Doing and Waiting.
		expect(res.body.committed).toBe(3);
		expect(res.body.timeInOptions).toBeNull();
	});
});

describe('how many reads the board’s metrics make', () => {
	/** The metrics' reads for a board with `n` cards completed, each committed from options into a column of its own. */
	async function readsFor(n: number) {
		resetDb();
		const { owner, A, options } = flowBoard();
		for (let i = 0; i < n; i++) {
			const column = db.insert(columns).values({ boardId: A.board.id, title: `Review ${i}`, position: 10 + i }).returning().get();
			const card = completedCard(A, `Done ${i}`, '2026-06-01 09:00:00', '2026-06-10 09:00:00', '2026-06-12 09:00:00');
			committedInto(A, card, column, '2026-06-10 09:00:00');
			entry(A, card, 'card_returned_to_options', '2026-06-05 09:00:00');
			makeCard(options, { title: `Idea ${i}` });
		}
		const budget = readBudget(10_000);
		try {
			expect((await api('GET', `/api/boards/${A.board.id}/metrics`, { user: owner })).status).toBe(200);
		} finally {
			budget.restore();
		}
		return budget.count;
	}

	it('makes as many for ten cards completed, committed and waiting as for one', async () => {
		expect(await readsFor(10)).toBe(await readsFor(1));
	});
});

describe('the burndown starts each card’s scope at its commitment', () => {
	it('adds a card made in May and committed on 10 June to the scope on the 10th, and leaves options out', async () => {
		const { owner, A, options } = flowBoard();
		makeCard(A.cols['To Do'], { title: 'Later', createdAt: '2026-05-01 09:00:00', committedAt: '2026-06-10 09:00:00' });
		makeCard(options, { title: 'An option', createdAt: '2026-06-01 09:00:00' });
		const res = await api('GET', `/api/burndown?boardIds=${A.board.id}&days=30`, { user: owner });
		const scope = Object.fromEntries(res.body.series.map((p: any) => [p.date, p.scope]));
		expect([scope['2026-06-09'], scope['2026-06-10'], scope['2026-06-30']]).toEqual([0, 1, 1]);
		expect(res.body.meta.cardCount).toBe(1);
	});
});

describe('the flow diagram’s upstream band (ruling h)', () => {
	function snapshots(board: BoardFixture, columnsInOrder: Column[]) {
		columnsInOrder.forEach((column, i) => {
			db.insert(dailySnapshots).values({ boardId: board.board.id, columnId: column.id, date: '2026-06-20', cardCount: i + 1 }).run();
		});
	}

	it('leaves the Options column out of a delivery board’s flow unless asked, and draws it first when asked', async () => {
		const { owner, A, options } = flowBoard();
		snapshots(A, [options, A.cols['To Do'], A.cols['In Progress'], A.cols['Complete']]);
		const off = (await api('GET', `/api/boards/${A.board.id}/cfd`, { user: owner })).body;
		expect(off.columns.map((c: any) => [c.title, c.upstream])).toEqual([['To Do', false], ['In Progress', false], ['Complete', false]]);
		expect(off.data).toEqual([{ date: '2026-06-20', columns: [2, 3, 4].map((count, i) => ({ columnId: [A.cols['To Do'], A.cols['In Progress'], A.cols['Complete']][i].id, count })) }]);
		expect(off).toMatchObject({ kind: 'delivery', hasUpstream: true, upstreamShown: false });

		const on = (await api('GET', `/api/boards/${A.board.id}/cfd?upstream=true`, { user: owner })).body;
		expect(on.columns.map((c: any) => [c.title, c.upstream])).toEqual([['Ideas', true], ['To Do', false], ['In Progress', false], ['Complete', false]]);
		expect(on.data[0].columns.map((c: any) => c.count)).toEqual([1, 2, 3, 4]);
		expect(on).toMatchObject({ hasUpstream: true, upstreamShown: true });
	});

	it('draws an ideas board’s own columns, and gives a board with no Options column what it gave', async () => {
		const owner = makeUser();
		const I = makeBoard({ owner, columns: ['New Ideas', 'Shaping'] });
		db.update(boards).set({ kind: 'ideas' }).where(eq(boards.id, I.board.id)).run();
		snapshots(I, [I.cols['New Ideas'], I.cols['Shaping']]);
		const ideas = (await api('GET', `/api/boards/${I.board.id}/cfd`, { user: owner })).body;
		expect(ideas.columns.map((c: any) => [c.title, c.upstream])).toEqual([['New Ideas', true], ['Shaping', true]]);
		expect(ideas).toMatchObject({ kind: 'ideas', hasUpstream: true, upstreamShown: true });

		const O = makeBoard({ owner });
		snapshots(O, [O.cols['To Do']]);
		const plain = (await api('GET', `/api/boards/${O.board.id}/cfd?upstream=true`, { user: owner })).body;
		expect(plain.columns.map((c: any) => c.title)).toEqual(['To Do', 'On Hold', 'In Progress', 'Complete']);
		expect(plain).toMatchObject({ kind: 'delivery', hasUpstream: false, upstreamShown: false });
	});
});

describe('reports ask the stored role (the S1b review’s B6)', () => {
	it('never takes the Options column for the To Do column a board without one falls back to, and counts no option', () => {
		const owner = makeUser();
		const F = makeBoard({ owner, columns: ['Queue', 'Done'] });
		const someday = db.insert(columns).values({ boardId: F.board.id, title: 'Someday', position: -1, role: 'options' }).returning().get();
		makeCard(someday, { title: 'An option', createdAt: '2026-06-02 09:00:00', dueDate: '2026-06-01' });
		makeCard(F.cols['Queue'], { title: 'Queued', createdAt: '2026-06-02 09:00:00' });
		const report = generateBoardReport(F.board.id, '2026-06-01', '2026-06-30', owner)!;
		expect(report.summary).toMatchObject({ totalCards: 1, outstanding: 1, todo: 1, inProgress: 0, overdue: 0, createdInPeriod: 1 });
		expect(report.outstandingTasks.flatMap((b) => b.tasks.map((t) => `${t.title} (${t.columnTitle})`))).toEqual(['Queued (Queue)']);
		expect(report.summary.upstream).toMatchObject({ options: 1 });
	});

	it('gives the upstream figures of the boards for the period, none for one person’s report, and draws them in the PDF', async () => {
		const { owner, A, options } = flowBoard();
		makeCard(options, { title: 'Waiting idea', createdAt: '2026-06-02 09:00:00' });
		const discarded = makeCard(options, { title: 'Dropped', archivedAt: '2026-06-03 09:00:00', discardedAt: '2026-06-03 09:00:00' });
		entry(A, discarded, 'card_discarded', '2026-06-03 09:00:00');
		const report = generateBoardReport(A.board.id, '2026-06-01', '2026-06-30', owner)!;
		expect(report.summary.upstream).toEqual(upstreamFigures([A.board.id], '2026-06-01', '2026-06-30'));
		expect(report.summary.upstream).toMatchObject({ options: 1, discarded: 1, discardRate: 1 });
		expect(generateBoardReport(A.board.id, '2026-06-01', '2026-06-30', owner, 'all', owner.id)!.summary.upstream).toBeNull();

		const text = pdfText(await generateReportPdf(report, 'summary'));
		expect(text).toContain('Upstream: 1 options now, oldest 28 days, 0 over 30 days');
		expect(text).toContain('1 discarded');
		expect(text).toContain('discard rate 100%');
		expect(text).not.toContain('Abandoned');
	});

	it('draws no upstream line for a board where nothing happened upstream', async () => {
		const s = ordinaryScene();
		const report = generateBoardReport(s.O.board.id, '2026-06-01', '2026-06-30', s.owner)!;
		const text = pdfText(await generateReportPdf(report, 'summary'));
		expect(text).not.toContain('Upstream');
		expect(text).not.toContain('Abandoned');
	});

	it('draws abandoned work on a line of its own, and no upstream line, for a board with no Options column (H8)', async () => {
		const s = ordinaryScene();
		const abandoned = makeCard(s.O.cols['In Progress'], { title: 'Dropped work', archivedAt: '2026-06-07 09:00:00' });
		entry(s.O, abandoned, 'card_abandoned', '2026-06-07 09:00:00');
		const report = generateBoardReport(s.O.board.id, '2026-06-01', '2026-06-30', s.owner)!;
		const text = pdfText(await generateReportPdf(report, 'summary'));
		expect(text).toContain('Abandoned (committed work archived before Complete): 1');
		expect(text).not.toContain('Upstream');
	});

	it('says in a report about one person that the upstream line is left out, because the figures describe boards (S4b)', async () => {
		const { owner, A, options } = flowBoard();
		makeCard(options, { title: 'Waiting idea', createdAt: '2026-06-02 09:00:00' });
		const mine = generateBoardReport(A.board.id, '2026-06-01', '2026-06-30', owner, 'all', owner.id)!;
		const text = pdfText(await generateReportPdf(mine, 'summary'));
		expect(text).toContain('The upstream line (options, commitments from options, discards and abandoned work) is left out of a report about one person');
		expect(text).not.toContain('Upstream:');

		// A report about the boards says nothing of it.
		const boards = pdfText(await generateReportPdf(generateBoardReport(A.board.id, '2026-06-01', '2026-06-30', owner)!, 'summary'));
		expect(boards).toContain('Upstream: 1 options now');
		expect(boards).not.toContain('left out of a report about one person');
	});

	it('says nothing of an upstream line in a report about the boards that have no Options column (S4b)', async () => {
		const s = ordinaryScene();
		const ordinary = pdfText(await generateReportPdf(generateBoardReport(s.O.board.id, '2026-06-01', '2026-06-30', s.owner)!, 'summary'));
		expect(ordinary).not.toContain('left out of a report about one person');
	});

	it('says it in a report about one person only where the boards have an upstream column or abandoned work in the period (J9)', async () => {
		const s = ordinaryScene();
		const mine = () => generateBoardReport(s.O.board.id, '2026-06-01', '2026-06-30', s.owner, 'all', s.owner.id)!;
		expect(mine().summary.upstreamLeftOut).toBe(false);
		expect(pdfText(await generateReportPdf(mine(), 'summary'))).not.toContain('left out of a report about one person');

		const abandoned = makeCard(s.O.cols['In Progress'], { title: 'Dropped work', archivedAt: '2026-06-07 09:00:00' });
		entry(s.O, abandoned, 'card_abandoned', '2026-06-07 09:00:00');
		expect(mine().summary.upstreamLeftOut).toBe(true);
		expect(pdfText(await generateReportPdf(mine(), 'summary'))).toContain('The upstream line (options, commitments from options, discards and abandoned work) is left out of a report about one person');
		// Abandoned before the period: nothing to leave out of it.
		expect(generateBoardReport(s.O.board.id, '2026-06-10', '2026-06-30', s.owner, 'all', s.owner.id)!.summary.upstreamLeftOut).toBe(false);
		// A report about the boards never says it.
		expect(generateBoardReport(s.O.board.id, '2026-06-01', '2026-06-30', s.owner)!.summary.upstreamLeftOut).toBe(false);
	});

	it('leaves an option out of a single card’s report’s outstanding work and tasks (H7)', () => {
		const { options } = flowBoard();
		const option = makeCard(options, { title: 'An idea' });
		const report = generateCardReport(option.id)!;
		expect(report.summary).toMatchObject({ outstanding: 0, todo: 0, inProgress: 0 });
		expect(report.outstandingTasks).toEqual([]);
		expect(report.assigneeStats.every((a) => a.outstanding === 0)).toBe(true);
	});
});

describe('the activity report', () => {
	it('gives the upstream figures of the boards it covers, and none for one person', () => {
		const { owner, A, options } = flowBoard();
		makeCard(options, { title: 'Idea', createdAt: '2026-06-02 09:00:00' });
		const report = buildActivityReport({ actor: owner, from: '2026-06-01', to: '2026-06-30', boardIds: [A.board.id] });
		expect(report.upstream).toEqual(upstreamFigures([A.board.id], '2026-06-01', '2026-06-30'));
		expect(report.upstream?.options).toBe(1);
		expect(report.totals.cards).toBe(0);
		expect(buildActivityReport({ actor: owner, userId: owner.id, from: '2026-06-01', to: '2026-06-30' }).upstream).toBeNull();
	});

	it('gives an administrator who names no board every board’s figures, with no list of every board bound (H9)', () => {
		const admin = makeUser({ role: 'admin' });
		const { A, options } = flowBoard();
		const other = makeBoard({ name: 'Other', columns: ['To Do'] });
		const otherOptions = optionsColumnOn(other);
		makeCard(options, { title: 'Idea on A', createdAt: '2026-04-01 09:00:00' });
		makeCard(otherOptions, { title: 'Idea elsewhere', createdAt: '2026-06-20 09:00:00' });
		entry(other, null, 'column_converted_to_options', '2026-06-25 09:00:00', `1 card became an option${conversionSuffix(otherOptions.id)}`);
		const every = upstreamFigures(null, '2026-06-01', '2026-06-30', NOW.getTime());
		expect(every).toEqual(upstreamFigures([A.board.id, other.board.id], '2026-06-01', '2026-06-30', NOW.getTime()));
		expect(every).toMatchObject({ options: 2, oldestOptionDays: 90, agingOptions: 1 });

		const budget = readBudget(1_000);
		let report;
		try {
			report = buildActivityReport({ actor: admin, from: '2026-06-01', to: '2026-06-30' });
		} finally {
			budget.restore();
		}
		expect(report.upstream).toEqual(every);
		// No read of every board for the figures, nor a list of them bound; the conversions read only on the boards holding options.
		expect(budget.sources.some((s) => /^SELECT id FROM boards$/.test(s.trim()))).toBe(false);
		expect(budget.sources.filter((s) => /AND board_id IN \(SELECT DISTINCT col\.board_id/.test(s))).toHaveLength(1);
	});
});

describe('goals and the plan', () => {
	it('lists a goal’s options apart, marks them in the plan, counts them in no progress and never offers one to start', () => {
		const s = ordinaryScene();
		const { options } = withUpstream(s);
		const option = db.select().from(cards).where(eq(cards.title, 'An option')).get()!;
		expect(option.columnId).toBe(options.id);
		expect(listMilestones(s.owner, s.O.board.id).map((m) => [m.cardCount, m.doneCount, m.optionsCount])).toEqual([[3, 1, 1]]);
		const summary = getMilestoneSummary(s.goal.id, s.owner)!;
		expect(summary.progress).toMatchObject({ total: 3, done: 1, percent: 33, options: 1 });
		const node = summary.graph.nodes.find((n) => n.id === option.id && n.kind === 'card')!;
		expect(node).toMatchObject({ isOption: true, isComplete: false });
		expect(summary.graph.nodes.filter((n) => n.isOption)).toHaveLength(1);
		expect(summary.nextActionable.map((n) => n.title)).toEqual(['Doing', 'Waiting']);
	});

	it('keeps an option in the graph as an open blocker', () => {
		const s = ordinaryScene();
		withUpstream(s);
		const option = db.select().from(cards).where(eq(cards.title, 'An option')).get()!;
		makeDependency({ blocked: s.c.waiting, blocker: option });
		const summary = getMilestoneSummary(s.goal.id, s.owner)!;
		expect(summary.nextActionable.map((n) => n.title)).toEqual(['Doing']);
		expect(summary.blocked.map((b) => [b.card.title, b.blockers.map((x) => x.title)])).toEqual([['Waiting', ['An option']]]);
		// A dependency answer is a PlanNode, which has no `isOption`.
		expect(summary.blocked[0].blockers[0]).not.toHaveProperty('isOption');
	});

	it('lists no option among the goal’s waiting work, though it waits on something (H4)', () => {
		const s = ordinaryScene();
		withUpstream(s);
		const option = db.select().from(cards).where(eq(cards.title, 'An option')).get()!;
		makeDependency({ blocked: option, blocker: s.c.doing });
		const summary = getMilestoneSummary(s.goal.id, s.owner)!;
		expect(summary.blocked).toEqual([]);
		expect(summary.graph.nodes.find((n) => n.id === option.id && n.kind === 'card')?.openBlockers).toHaveLength(1);
	});
});

describe('sub-boards', () => {
	it('lets an option on a sub-board hold nothing back (decision M22-11)', () => {
		const s = ordinaryScene();
		db.delete(cards).where(eq(cards.columnId, s.sub.cols['To Do'].id)).run();
		db.update(subtasks).set({ completed: true }).where(eq(subtasks.cardId, s.c.doing.id)).run();
		makeCard(optionsColumnOn(s.sub), { title: 'Sub option' });
		expect(subBoardProgress([s.sub.board.id]).get(s.sub.board.id)).toEqual({ done: 1, total: 1 });
		expect(getCompletionBlocker(s.c.doing.id, s.owner)).toBeNull();
	});
});

describe('the dashboard', () => {
	it('gives each board its options apart, and an ideas board its ideas and no delivery figures', async () => {
		const s = ordinaryScene();
		const { I } = withUpstream(s);
		const data = dataOf(await pageLoad('/', { user: s.owner }));
		const row = (id: number) => data.boards.find((b: any) => b.id === id);
		expect([row(s.O.board.id).totalCards, row(s.O.board.id).completedCards, row(s.O.board.id).optionsCount]).toEqual([5, 2, 2]);
		expect([row(I.board.id).kind, row(I.board.id).totalCards, row(I.board.id).completedCards, row(I.board.id).optionsCount]).toEqual(['ideas', 0, 0, 1]);
		expect(row(s.N.board.id).optionsCount).toBe(0);
	});

	it('ages the caller’s work from its commitment, not from when it was raised as an option (H2)', async () => {
		const s = ordinaryScene();
		const before = dataOf(await pageLoad('/', { user: s.owner })).analytics.agingBuckets;
		// Raised as an option in March, committed yesterday: fresh work, not stale.
		assignCard(makeCard(s.O.cols['To Do'], { title: 'Taken on', createdAt: '2026-03-01 09:00:00', committedAt: '2026-06-29 09:00:00' }), s.owner);
		const after = dataOf(await pageLoad('/', { user: s.owner })).analytics.agingBuckets;
		expect(after).toEqual({ ...before, fresh: before.fresh + 1 });
	});
});

describe('All Tasks', () => {
	it('puts options in an Options bucket, first, and out of the header’s total', async () => {
		const s = ordinaryScene();
		withUpstream(s);
		const data = dataOf(await pageLoad('/all', { user: s.owner }));
		expect(data.buckets[0]).toMatchObject({ title: 'Options' });
		expect(data.buckets[0].cards.map((c: any) => c.title).sort()).toEqual(['An idea', 'An option', 'Returned', 'Sub option']);
		expect(data.totalCards).toBe(8);
	});

	it('gives no Options bucket where no board has an upstream column', async () => {
		const s = ordinaryScene();
		const data = dataOf(await pageLoad('/all', { user: s.owner }));
		expect(data.buckets.map((b: any) => b.title)).not.toContain('Options');
	});

	it('keeps an ordinary column called Options a bucket of its own, counted in the header (H11)', async () => {
		const s = ordinaryScene();
		const ordinaryOptions = db.insert(columns).values({ boardId: s.N.board.id, title: 'Options', position: 5 }).returning().get();
		makeCard(ordinaryOptions, { title: 'Ordinary card' });
		const plain = dataOf(await pageLoad('/all', { user: s.owner }));
		const plainBucket = plain.buckets.find((b: any) => b.title === 'Options');
		expect(plainBucket.cards.map((c: any) => c.title)).toEqual(['Ordinary card']);
		expect(plainBucket).not.toHaveProperty('upstream');
		expect(plain.totalCards).toBe(9);

		withUpstream(s);
		const data = dataOf(await pageLoad('/all', { user: s.owner }));
		const titled = data.buckets.filter((b: any) => b.title === 'Options');
		expect(titled.map((b: any) => [b.upstream ?? false, b.cards.map((c: any) => c.title).sort()])).toEqual([
			[true, ['An idea', 'An option', 'Returned', 'Sub option']],
			[false, ['Ordinary card']]
		]);
		expect(data.buckets[0].upstream).toBe(true);
		expect(data.totalCards).toBe(9);
	});
});

describe('the exports', () => {
	it('add each card’s stage and commitment at the end of the board’s rows, every other column where it was', async () => {
		const s = ordinaryScene();
		withUpstream(s);
		const csv = String((await api('GET', `/api/boards/${s.O.board.id}/export/csv`, { user: s.owner })).body).trimEnd().split('\n');
		expect(csv[0]).toBe('Title,Description,Priority,Column,Assignees,Due Date,Created,Completed,Labels,Category,Subtasks,Stage,Committed');
		const byTitle = Object.fromEntries(csv.slice(1).map((line) => [line.split(',')[0], line.split(',').slice(-2).join(',')]));
		expect(byTitle).toMatchObject({
			'An option': 'Option,',
			Returned: 'Option,',
			Waiting: 'Committed,2026-06-25 09:00:00',
			'Done fast': 'Committed,2026-06-01 09:00:00'
		});
		expect(csv.find((line) => line.startsWith('Waiting,'))).toMatch(/^Waiting,,medium,To Do,,,2026-06-25 09:00:00,,,,✓ Subtask \d+,Committed,2026-06-25 09:00:00$/);
	});

	it('add them to the rows of every board as well', async () => {
		const s = ordinaryScene();
		withUpstream(s);
		const csv = String((await api('GET', '/api/cards/export/csv', { user: s.owner })).body).trimEnd().split('\n');
		expect(csv[0]).toBe('Board,Title,Description,Priority,Column,Assignees,Due Date,Created,Completed,Labels,Category,Subtasks,Stage,Committed');
		expect(csv.filter((line) => line.includes(',Option,')).map((line) => line.split(',')[1]).sort()).toEqual(['An idea', 'An option', 'Returned', 'Sub option']);
		expect(csv.filter((line) => line.includes(',Committed,'))).toHaveLength(8);
	});
});

describe('the board’s Stats panel figures (`boardStats`)', () => {
	const now = NOW.getTime();
	const card = (createdAt: string, more: Partial<{ dueDate: string | null; categoryId: number | null }> = {}) => ({ createdAt, dueDate: null, categoryId: null, ...more });
	const ordinary = [
		{ id: 1, title: 'To Do', color: '#1', role: null, cards: [card('2026-06-20 12:00:00', { categoryId: 7 }), card('2026-06-10 12:00:00', { dueDate: '2026-06-01' })] },
		{ id: 2, title: 'In Progress', color: '#2', role: null, cards: [card('2026-06-29 12:00:00', { categoryId: 7 })] },
		{ id: 3, title: 'Complete', color: '#3', role: null, cards: [card('2026-05-31 12:00:00', { dueDate: '2026-06-02' })] }
	];

	it('gives a board with no Options column the figures the panel worked out', () => {
		const stats = boardStats(ordinary, 'delivery', now);
		// Ages 10, 20, 1 and 30 days: 15.25, shown as 15d.
		expect(stats).toMatchObject({ totalCards: 4, completedCards: 1, overdueCards: 2, avgAgeDays: 15, avgAge: '15d', optionsCount: 0 });
		expect(stats.columns.map((c) => [c.title, c.count])).toEqual([['To Do', 2], ['In Progress', 1], ['Complete', 1]]);
		expect([...stats.byCategory]).toEqual([[7, 2]]);
	});

	it('leaves the Options column out of every figure and every bar, and counts its cards apart', () => {
		const options = { id: 9, title: 'Ideas', color: '#9', role: 'options', cards: [card('2026-01-01 12:00:00', { dueDate: '2026-01-02', categoryId: 7 })] };
		const stats = boardStats([options, ...ordinary], 'delivery', now);
		expect(stats).toMatchObject({ totalCards: 4, completedCards: 1, overdueCards: 2, avgAge: '15d', optionsCount: 1 });
		expect(stats.columns.map((c) => c.title)).toEqual(['To Do', 'In Progress', 'Complete']);
		expect([...stats.byCategory]).toEqual([[7, 2]]);
		expect(boardStats(ordinary, 'ideas', now)).toMatchObject({ totalCards: 0, completedCards: 0, overdueCards: 0, avgAge: '0d', columns: [], optionsCount: 4 });
	});

	it('ages each card from its commitment where it has one (H2)', () => {
		const taken = { ...card('2026-01-01 12:00:00'), committedAt: '2026-06-29 12:00:00' };
		const stats = boardStats([{ id: 1, title: 'To Do', color: '#1', role: null, cards: [taken, card('2026-06-20 12:00:00')] }], 'delivery', now);
		// 1 day and 10 days: 5.5, shown as 6d.
		expect(stats.avgAge).toBe('6d');
	});
});

describe('the board’s contents carry each card’s commitment, which the Stats panel ages from (S4b)', () => {
	it('gives every card its committedAt: a committed card its commitment, an option none', async () => {
		const { owner, A, options } = flowBoard();
		const taken = makeCard(A.cols['To Do'], { title: 'Taken on', createdAt: '2026-03-01 09:00:00', committedAt: '2026-06-29 09:00:00' });
		const option = makeCard(options, { title: 'An idea' });
		const res = await api('GET', `/api/boards/${A.board.id}/contents`, { user: owner });
		expect(res.status).toBe(200);
		const cardsIn = (res.body.columns as { cards: { id: number; committedAt: string | null }[] }[]).flatMap((c) => c.cards);
		expect(cardsIn.find((c) => c.id === taken.id)?.committedAt).toBe('2026-06-29 09:00:00');
		expect(cardsIn.find((c) => c.id === option.id)).toHaveProperty('committedAt', null);
	});
});

describe('personal figures', () => {
	it('measure the average from the commitment in GET /api/v1/me/stats, and count no option as active', async () => {
		const { owner, A, options } = flowBoard();
		assignCard(completedCard(A, 'Mine', '2026-06-01 09:00:00', '2026-06-10 09:00:00', '2026-06-12 09:00:00'), owner);
		assignCard(makeCard(options, { title: 'My idea' }), owner);
		assignCard(makeCard(A.cols['To Do'], { title: 'My task' }), owner);
		const res = await api('GET', '/api/v1/me/stats', { user: owner });
		expect([res.body.avgCycleTimeDays, res.body.activeCards]).toEqual([2, 1]);
		const mine = (await api('GET', '/api/my-tasks', { user: owner })).body;
		expect(mine.flatMap((g: any) => g.cards.map((c: any) => c.title))).toEqual(['My task']);
	});
});
