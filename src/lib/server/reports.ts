/**
 * reports.ts — PDF report generation engine for DumpFire.
 *
 * Generates professional PDF reports for boards, board categories, or all boards.
 * Supports scheduled generation with email delivery.
 * PDFs are ephemeral — generated on demand, never stored in the DB.
 */

import PDFDocument from 'pdfkit';
import { error } from '@sveltejs/kit';
import { db } from './db';
import {
	boards, columns, cards, cardAssignees, users, subtasks,
	boardCategories, reportSchedules
} from './db/schema';
import { eq, inArray, isNull, isNotNull, and, or, lte } from 'drizzle-orm';
import { getAccessibleBoardIds, canViewBoard } from './board-access';
import { completeColumnIds, isCompleteColumnTitle } from '$lib/column-role';
import { escapeHtml } from '$lib/escape-html';
import { isSmtpConfigured, sendEmailWithAttachment } from './email';
import type { SessionUser } from './auth';
import { createLogger } from './logger';
import { takeAllowance } from './rate-limit';
import { readId, readQueryDate, readText, type RequestBody } from './request-body';
import { MAX_REPORT_RECIPIENTS, reportRecipients } from '$lib/report-recipients';
import { parseStamp, stamp, toStamp, type Stamp } from '$lib/timestamps';
import { canonicalTimeZone, nextRunAfter, sameTimeDaysBefore } from '$lib/report-schedule-time';

const log = createLogger('REPORTS');

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Which slice of the board a report lists.
 *  - all:         completed work first, then everything still open
 *  - completed:   only cards completed within the reporting period
 *  - in_progress: only open cards that have left To Do (incl. On Hold / Review / …)
 *  - todo:        only cards still sitting in a To Do / Backlog style column
 * Summary metrics always describe the whole scope; the filter controls which
 * task listings (and the priority breakdown) are drawn.
 */
export type ReportStatusFilter = 'all' | 'completed' | 'in_progress' | 'todo';
export const REPORT_STATUS_FILTERS: readonly ReportStatusFilter[] = ['all', 'completed', 'in_progress', 'todo'];
export const REPORT_STATUS_FILTER_LABELS: Record<ReportStatusFilter, string> = {
	all: 'All work',
	completed: 'Completed only',
	in_progress: 'In Progress only',
	todo: 'To Do only'
};

/** What a report or a schedule covers: one board, a grouping of boards, or every board. */
export const REPORT_SCOPES = ['board', 'category', 'all'] as const;
/** How much a report says of each task. */
export const REPORT_DETAIL_LEVELS = ['summary', 'detailed'] as const;

/**
 * One end of a report's period, from a request body: a date (`2026-10-01`) or
 * a timestamp, handed back in the stored form, `YYYY-MM-DD HH:MM:SS` in UTC,
 * as `readQueryDate` reads one (card 2095, decision 10). A date alone is the
 * whole of that day: its first second as `periodStart`, its last as
 * `periodEnd`, so a report to 14 October includes the 14th (A19). `missing`
 * is the route's text for a period not sent. Any value was taken, and one
 * that was not text was a 500 when the PDF was drawn (card 2117).
 */
export function readReportPeriod(body: RequestBody, name: 'periodStart' | 'periodEnd', missing: string): Stamp {
	const sent = readText(body, name, { required: true, min: 1, says: { missing, empty: missing } });
	return readQueryDate(sent, name, name === 'periodEnd' ? 'upper' : 'lower')!;
}

/**
 * A report's period, from a request body: each end as `readReportPeriod` reads
 * it, and `periodStart` not after `periodEnd`, or `400 periodStart is after
 * periodEnd`. Both are in the stored form, so they compare as text: one day's
 * report, from a date to the same date, is that day, from 00:00:00 to
 * 23:59:59. A period that ended before it began was drawn as a report of
 * nothing.
 */
export function readReportWindow(body: RequestBody, missing: string): { periodStart: Stamp; periodEnd: Stamp } {
	const periodStart = readReportPeriod(body, 'periodStart', missing);
	const periodEnd = readReportPeriod(body, 'periodEnd', missing);
	if (periodStart > periodEnd) error(400, 'periodStart is after periodEnd');
	return { periodStart, periodEnd };
}

/**
 * The person a report is narrowed to, from a request body: `assigneeUserId`,
 * or `userId` as it was also read, an id or null for everyone. Text that was
 * not a number, `"all"` and `""` were taken for everyone.
 */
export function readReportAssignee(body: RequestBody): number | null {
	const says = 'assigneeUserId must be a user id';
	return readId(body, 'assigneeUserId', { nullable: true, says }) ?? readId(body, 'userId', { nullable: true, says }) ?? null;
}

/** Coerce an untrusted value (DB column) to a valid filter, defaulting to 'all'. */
export function parseStatusFilter(raw: unknown): ReportStatusFilter {
	return typeof raw === 'string' && (REPORT_STATUS_FILTERS as readonly string[]).includes(raw)
		? (raw as ReportStatusFilter)
		: 'all';
}

type CardStatus = 'todo' | 'in_progress' | 'completed';

interface SubtaskInfo {
	title: string;
	completed: boolean;
	priority: string;
	description: string;
}

interface TaskDetail {
	id: number;
	title: string;
	priority: string;
	dueDate: string | null;
	createdAt: string;
	assignees: string[];
	columnTitle: string;
	description: string;
	businessValue: string;
	subtasks: SubtaskInfo[];
}

export interface ReportData {
	generatedAt: string;
	periodStart: string;
	periodEnd: string;
	scope: 'board' | 'category' | 'all';
	scopeName: string;
	statusFilter: ReportStatusFilter;
	/** Set when the report was narrowed to one person; null for everyone. */
	assigneeName: string | null;

	summary: {
		/** Non-archived cards in scope (every board and sub-board), regardless of period. */
		totalCards: number;
		/** Subtasks hanging off those cards. */
		totalSubtasks: number;
		/** Cards + subtasks — the "task" figure shown alongside the card count. */
		totalTasks: number;
		completedInPeriod: number;
		createdInPeriod: number;
		outstanding: number;
		/** Open cards still in a To Do style column. */
		todo: number;
		/** Open cards that have left To Do but are not complete (In Progress, On Hold, Review…). */
		inProgress: number;
		overdue: number;
	};

	priorityBreakdown: {
		critical: number;
		high: number;
		medium: number;
		low: number;
	};

	assigneeStats: {
		username: string;
		completedInPeriod: number;
		outstanding: number;
	}[];

	outstandingTasks: {
		boardName: string;
		parentBoardName: string | null;
		categoryName: string;
		categoryColor: string;
		tasks: TaskDetail[];
	}[];

	completedTasks: {
		id: number;
		title: string;
		priority: string;
		completedAt: string;
		boardName: string;
		assignees: string[];
		description: string;
		businessValue: string;
		subtasks: SubtaskInfo[];
	}[];

	boardBreakdown: {
		boardName: string;
		parentBoardName: string | null;
		categoryName: string;
		categoryColor: string;
		totalCards: number;
		completedCards: number;
		completedInPeriod: number;
	}[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TODO_COLUMN_TITLES = ['to do', 'todo', 'to-do', 'backlog', 'inbox', 'not started', 'new', 'planned', 'ideas', 'idea', 'later'];

/**
 * Classify a column by its title. Anything that is neither a Done nor a To Do
 * column counts as In Progress — On Hold, Review, Testing, Blocked… have all
 * left To Do, so for reporting purposes the work has started.
 */
function classifyColumnTitle(title: string): CardStatus {
	const t = title.toLowerCase().trim();
	if (isCompleteColumnTitle(title)) return 'completed';
	if (TODO_COLUMN_TITLES.includes(t)) return 'todo';
	return 'in_progress';
}

function getDoneColumnIds(boardIds: number[]): Set<number> {
	if (boardIds.length === 0) return new Set();
	const allCols = db.select().from(columns)
		.where(inArray(columns.boardId, boardIds))
		.all();
	return completeColumnIds(allCols);
}

interface ColumnInfo { title: string; boardId: number; status: CardStatus }

function getColumnMap(boardIds: number[]): Map<number, ColumnInfo> {
	if (boardIds.length === 0) return new Map();
	const allCols = db.select().from(columns)
		.where(inArray(columns.boardId, boardIds))
		.all();
	const map = new Map<number, ColumnInfo>();
	const byBoard = new Map<number, { position: number; info: ColumnInfo }[]>();
	for (const col of allCols) {
		const info: ColumnInfo = { title: col.title, boardId: col.boardId, status: classifyColumnTitle(col.title) };
		map.set(col.id, info);
		if (!byBoard.has(col.boardId)) byBoard.set(col.boardId, []);
		byBoard.get(col.boardId)!.push({ position: col.position, info });
	}
	// A board with no recognisable To Do column (e.g. "Backlog" renamed to
	// "Queue") still has one: its left-most column that isn't Done.
	for (const cols of byBoard.values()) {
		if (cols.some(c => c.info.status === 'todo')) continue;
		const first = cols
			.slice()
			.sort((a, b) => a.position - b.position)
			.find(c => c.info.status !== 'completed');
		if (first) first.info.status = 'todo';
	}
	return map;
}

/**
 * A day as the PDF and the mail show it, from a stored timestamp, an ISO one
 * or a date. Read as UTC (`parseStamp`): `new Date()` read the stored form as
 * the server's local time (card 2095, A5). `—` for nothing, or for a value
 * that is not a date.
 */
export function formatDate(iso: string, timeZone?: string): string {
	if (!iso) return '—';
	const d = parseStamp(iso);
	if (!d) return '—';
	// The day in `timeZone` where one is given, as a scheduled report's period
	// is written in its schedule's zone (card 2159); the server's otherwise.
	return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone });
}

function getSubtasksForCards(cardIds: number[]): Map<number, SubtaskInfo[]> {
	const result = new Map<number, SubtaskInfo[]>();
	if (cardIds.length === 0) return result;
	const allSubtasks = db.select().from(subtasks)
		.where(inArray(subtasks.cardId, cardIds))
		.all();
	for (const st of allSubtasks) {
		if (!result.has(st.cardId)) result.set(st.cardId, []);
		result.get(st.cardId)!.push({
			title: st.title,
			completed: st.completed,
			priority: st.priority,
			description: st.description || ''
		});
	}
	return result;
}

/**
 * The boards one reader of a report can open, as a question asked of each id:
 * `getAccessibleBoardIds`, where null (an administrator) opens everything.
 * Built once for a report, and handed to the walk and the generator.
 */
function openerFor(reader: SessionUser): (boardId: number) => boolean {
	const open = getAccessibleBoardIds(reader);
	if (open === null) return () => true;
	const ids = new Set(open);
	return (boardId) => ids.has(boardId);
}

/**
 * Recursively collect all sub-board IDs reachable from the given board IDs.
 * Walks the board → cards → sub-boards chain to any depth, following only
 * the sub-boards the report's reader can open (card 2150). Access is not
 * inherited from a parent board, so a sub-board they were not given is left
 * out, and the walk does not go through it: a board beneath it that they can
 * open is not reached either, as the dashboard's All Tasks walk stops there
 * too. Nothing says that something was left out.
 */
function collectSubBoardIds(boardIds: number[], canOpen: (boardId: number) => boolean): number[] {
	const allIds = new Set(boardIds);
	let frontier = boardIds;
	while (frontier.length > 0) {
		// Get all columns on frontier boards
		const cols = db.select({ id: columns.id })
			.from(columns)
			.where(inArray(columns.boardId, frontier))
			.all();
		if (cols.length === 0) break;
		// Get all card IDs on those columns
		const colCardIds = db.select({ id: cards.id })
			.from(cards)
			.where(inArray(cards.columnId, cols.map(c => c.id)))
			.all()
			.map(c => c.id);
		if (colCardIds.length === 0) break;
		// Find sub-boards linked to these cards
		const subBoardIds = db.select({ id: boards.id })
			.from(boards)
			.where(inArray(boards.parentCardId, colCardIds))
			.all()
			.map(b => b.id)
			.filter(id => !allIds.has(id) && canOpen(id));
		if (subBoardIds.length === 0) break;
		for (const id of subBoardIds) allIds.add(id);
		frontier = subBoardIds;
	}
	return Array.from(allIds);
}

// ─── Core Generator ──────────────────────────────────────────────────────────

function generateReportForBoards(
	boardIds: number[],
	periodStart: string,
	periodEnd: string,
	scopeName: string,
	scope: 'board' | 'category' | 'all',
	/**
	 * Whether the report's reader can open a board (`openerFor`). Asked of a
	 * board's parent before the parent is named (card 2150).
	 */
	canOpen: (boardId: number) => boolean,
	statusFilter: ReportStatusFilter = 'all',
	/**
	 * Narrow the report to one person's work. Filters on assignment, so a card
	 * with several assignees appears in each of their reports — the work was
	 * genuinely theirs too, and dropping it would understate everyone but the
	 * first name on the card.
	 */
	assigneeUserId: number | null = null,
	assigneeName: string | null = null
): ReportData {
	if (boardIds.length === 0) {
		return {
			generatedAt: new Date().toISOString(),
			periodStart, periodEnd, scope, scopeName, statusFilter,
			assigneeName,
			summary: { totalCards: 0, totalSubtasks: 0, totalTasks: 0, completedInPeriod: 0, createdInPeriod: 0, outstanding: 0, todo: 0, inProgress: 0, overdue: 0 },
			priorityBreakdown: { critical: 0, high: 0, medium: 0, low: 0 },
			assigneeStats: [], outstandingTasks: [],
			completedTasks: [], boardBreakdown: []
		};
	}

	const doneColIds = getDoneColumnIds(boardIds);
	const columnMap = getColumnMap(boardIds);
	const allColIds = Array.from(columnMap.keys());

	const allCards = allColIds.length > 0
		? db.select().from(cards)
			.where(and(inArray(cards.columnId, allColIds), isNull(cards.archivedAt)))
			.all()
		: [];

	const cardIds = allCards.map(c => c.id);
	const subtaskMap = getSubtasksForCards(cardIds);

	const allAssignments = cardIds.length > 0
		? db.select().from(cardAssignees).where(inArray(cardAssignees.cardId, cardIds)).all()
		: [];
	const allUsers = db.select({ id: users.id, username: users.username }).from(users).all();
	const userMap = new Map(allUsers.map(u => [u.id, u]));

	// Narrow to one person's cards, if asked. Everything downstream — counts,
	// breakdowns, outstanding and completed lists — derives from `allCards`, so
	// filtering here keeps every figure internally consistent rather than
	// leaving a total that disagrees with the list beneath it.
	let scopedCards = allCards;
	if (assigneeUserId !== null) {
		const mine = new Set(
			allAssignments.filter((a) => a.userId === assigneeUserId).map((a) => a.cardId)
		);
		scopedCards = allCards.filter((c) => mine.has(c.id));
	}

	const boardsInfo = db.select().from(boards).where(inArray(boards.id, boardIds)).all();
	const boardMap = new Map(boardsInfo.map(b => [b.id, b]));

	// Build parent board name prefix for sub-boards. A parent is named only
	// when the reader can open it (card 2150): a board in the report whose
	// parent they cannot open is shown under its own name, as a board of its
	// own, with nothing to say what it hangs from. The report may go to any
	// address, so it holds no placeholder for the parent either.
	const parentNameMap = new Map<number, string>();
	for (const b of boardsInfo) {
		if (b.parentCardId) {
			const parentCard = db.select().from(cards).where(eq(cards.id, b.parentCardId)).get();
			if (parentCard) {
				const parentCol = db.select().from(columns).where(eq(columns.id, parentCard.columnId)).get();
				if (parentCol && canOpen(parentCol.boardId)) {
					const parentBoard = boardMap.get(parentCol.boardId);
					if (parentBoard) {
						parentNameMap.set(b.id, parentBoard.name);
					} else {
						// Parent board not in report scope — look it up directly
						const pb = db.select().from(boards).where(eq(boards.id, parentCol.boardId)).get();
						if (pb) parentNameMap.set(b.id, pb.name);
					}
				}
			}
		}
	}
	function getDisplayName(boardId: number): string {
		const b = boardMap.get(boardId);
		const name = b?.name || 'Unknown';
		const parent = parentNameMap.get(boardId);
		return parent ? `${parent} → ${name}` : name;
	}

	// Category lookup
	const catIds = [...new Set(boardsInfo.map(b => b.categoryId).filter((id): id is number => id != null))];
	const catMap = new Map<number, { name: string; color: string }>();
	if (catIds.length > 0) {
		const cats = db.select().from(boardCategories).where(inArray(boardCategories.id, catIds)).all();
		for (const c of cats) catMap.set(c.id, { name: c.name, color: c.color });
	}
	function getCatInfo(boardId: number) {
		const b = boardMap.get(boardId);
		if (b?.categoryId && catMap.has(b.categoryId)) {
			const cat = catMap.get(b.categoryId)!;
			return { categoryName: cat.name, categoryColor: cat.color };
		}
		// For sub-boards, inherit category from parent board if available
		if (b?.parentCardId) {
			const parentCard = db.select().from(cards).where(eq(cards.id, b.parentCardId)).get();
			if (parentCard) {
				const parentCol = db.select().from(columns).where(eq(columns.id, parentCard.columnId)).get();
				if (parentCol) {
					const parentBoard = boardMap.get(parentCol.boardId);
					if (parentBoard?.categoryId && catMap.has(parentBoard.categoryId)) {
						const cat = catMap.get(parentBoard.categoryId)!;
						return { categoryName: cat.name, categoryColor: cat.color };
					}
				}
			}
		}
		return { categoryName: 'Uncategorised', categoryColor: '#94a3b8' };
	}

	const now = new Date().toISOString().split('T')[0];
	const completedCards = scopedCards.filter(c => doneColIds.has(c.columnId));
	const activeCards = scopedCards.filter(c => !doneColIds.has(c.columnId));

	// The period's ends in the stored form, which is the form of the columns
	// they are compared with as text (card 2095, A2 and A3). A bound in ISO
	// left out a card created on the first day and counted one created on the
	// last whatever its time; a bare date as the end is the whole of that day.
	// One that cannot be read is compared as it was sent, as it always was.
	const from = toStamp(periodStart, 'lower') ?? periodStart;
	const to = toStamp(periodEnd, 'upper') ?? periodEnd;
	const inPeriod = (moment: string) => moment >= from && moment <= to;

	const completedInPeriod = completedCards.filter(c => inPeriod(c.completedAt || c.updatedAt));

	const createdInPeriod = scopedCards.filter(c => inPeriod(c.createdAt));
	const overdueCards = activeCards.filter(c => c.dueDate && c.dueDate < now);

	// Split the open cards by where they sit on the board
	const statusOf = (c: typeof scopedCards[number]): CardStatus => columnMap.get(c.columnId)?.status ?? 'in_progress';
	const todoCards = activeCards.filter(c => statusOf(c) === 'todo');
	const inProgressCards = activeCards.filter(c => statusOf(c) === 'in_progress');

	// The open cards that get listed, according to the filter
	const listedActiveCards =
		statusFilter === 'todo' ? todoCards :
		statusFilter === 'in_progress' ? inProgressCards :
		statusFilter === 'completed' ? [] :
		activeCards;

	// Priority breakdown follows the filter: the outstanding slice by default,
	// the completed-in-period set when only completed work is being reported
	const priorityBreakdown = { critical: 0, high: 0, medium: 0, low: 0 };
	for (const c of (statusFilter === 'completed' ? completedInPeriod : listedActiveCards)) {
		const p = c.priority as keyof typeof priorityBreakdown;
		if (p in priorityBreakdown) priorityBreakdown[p]++;
	}

	let totalSubtasks = 0;
	for (const c of scopedCards) totalSubtasks += (subtaskMap.get(c.id) ?? []).length;

	// Per-assignee stats
	const assigneeMap = new Map<number, { completedInPeriod: number; outstanding: number }>();
	for (const assignment of allAssignments) {
		if (!assigneeMap.has(assignment.userId)) {
			assigneeMap.set(assignment.userId, { completedInPeriod: 0, outstanding: 0 });
		}
		const card = scopedCards.find(c => c.id === assignment.cardId);
		if (!card) continue;
		const stats = assigneeMap.get(assignment.userId)!;
		if (doneColIds.has(card.columnId)) {
			if (inPeriod(card.completedAt || card.updatedAt)) {
				stats.completedInPeriod++;
			}
		} else {
			stats.outstanding++;
		}
	}

	const assigneeStats = Array.from(assigneeMap.entries())
		.map(([userId, stats]) => {
			const u = userMap.get(userId);
			return {
				username: u?.username || 'Unknown',
				completedInPeriod: stats.completedInPeriod,
				outstanding: stats.outstanding
			};
		})
		.sort((a, b) => b.completedInPeriod - a.completedInPeriod);

	// Outstanding tasks grouped by board (only the slice the filter asks for)
	const outstandingByBoard = new Map<number, typeof activeCards>();
	for (const card of listedActiveCards) {
		const colInfo = columnMap.get(card.columnId);
		if (!colInfo) continue;
		if (!outstandingByBoard.has(colInfo.boardId)) outstandingByBoard.set(colInfo.boardId, []);
		outstandingByBoard.get(colInfo.boardId)!.push(card);
	}

	const outstandingTasks = Array.from(outstandingByBoard.entries()).map(([boardId, boardCards]) => {
		const b = boardMap.get(boardId);
		const catInfo = getCatInfo(boardId);
		return {
			boardName: b?.name || 'Unknown',
			parentBoardName: parentNameMap.get(boardId) || null,
			...catInfo,
			tasks: boardCards
				.sort((a, b) => {
					const pOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
					return (pOrder[a.priority] ?? 2) - (pOrder[b.priority] ?? 2);
				})
				.map(c => {
					const colInfo = columnMap.get(c.columnId);
					const cardAssigns = allAssignments.filter(a => a.cardId === c.id);
					return {
						id: c.id,
						title: c.title,
						priority: c.priority,
						dueDate: c.dueDate,
						createdAt: c.createdAt,
						assignees: cardAssigns.map(a => userMap.get(a.userId)?.username || 'Unknown'),
						columnTitle: colInfo?.title || 'Unknown',
						description: c.description || '',
						businessValue: c.businessValue || '',
						subtasks: subtaskMap.get(c.id) || []
					};
				})
		};
	}).sort((a, b) => a.categoryName.localeCompare(b.categoryName));

	// Completed tasks in period (not listed when the report is limited to open work)
	const completedTasksList = (statusFilter === 'todo' || statusFilter === 'in_progress' ? [] : completedInPeriod)
		// Newest first, and the newer card first within one second (card 2095,
		// A4 and decision 12): with one form the text orders the moments.
		.sort((a, b) => (b.completedAt || b.updatedAt).localeCompare(a.completedAt || a.updatedAt) || b.id - a.id)
		.map(c => {
			const colInfo = columnMap.get(c.columnId);
			const cardAssigns = allAssignments.filter(a => a.cardId === c.id);
			return {
				id: c.id,
				title: c.title,
				priority: c.priority,
				completedAt: c.completedAt || c.updatedAt,
				boardName: colInfo ? getDisplayName(colInfo.boardId) : 'Unknown',
				assignees: cardAssigns.map(a => userMap.get(a.userId)?.username || 'Unknown'),
				description: c.description || '',
				businessValue: c.businessValue || '',
				subtasks: subtaskMap.get(c.id) || []
			};
		});

	// Board breakdown
	const boardBreakdown = boardIds.map(boardId => {
		const b = boardMap.get(boardId);
		const catInfo = getCatInfo(boardId);
		const boardCards = scopedCards.filter(c => {
			const colInfo = columnMap.get(c.columnId);
			return colInfo?.boardId === boardId;
		});
		const boardCompleted = boardCards.filter(c => doneColIds.has(c.columnId));
		const boardCompletedInPeriod = boardCompleted.filter(c => inPeriod(c.completedAt || c.updatedAt));
		return {
			boardName: b?.name || 'Unknown',
			parentBoardName: parentNameMap.get(boardId) || null,
			...catInfo,
			totalCards: boardCards.length,
			completedCards: boardCompleted.length,
			completedInPeriod: boardCompletedInPeriod.length
		};
	}).filter(b => b.totalCards > 0);

	return {
		generatedAt: new Date().toISOString(),
		periodStart, periodEnd, scope, scopeName, statusFilter,
		assigneeName,
		summary: {
			totalCards: scopedCards.length,
			totalSubtasks,
			totalTasks: scopedCards.length + totalSubtasks,
			completedInPeriod: completedInPeriod.length,
			createdInPeriod: createdInPeriod.length,
			outstanding: activeCards.length,
			todo: todoCards.length,
			inProgress: inProgressCards.length,
			overdue: overdueCards.length
		},
		priorityBreakdown,
		assigneeStats,
		outstandingTasks,
		completedTasks: completedTasksList,
		boardBreakdown
	};
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Resolve a user id to a name for the report header, or null when unfiltered. */
function assigneeNameFor(userId: number | null): string | null {
	if (userId === null) return null;
	const u = db.select({ username: users.username }).from(users).where(eq(users.id, userId)).get();
	return u?.username ?? `User #${userId}`;
}

export function generateBoardReport(
	boardId: number, periodStart: string, periodEnd: string, user: SessionUser,
	statusFilter: ReportStatusFilter = 'all',
	assigneeUserId: number | null = null
): ReportData | null {
	if (!canViewBoard(user, boardId)) return null;
	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) return null;
	// Include the sub-boards the reader can open, recursively (card 2150)
	const canOpen = openerFor(user);
	const allBoardIds = collectSubBoardIds([boardId], canOpen);
	return generateReportForBoards(allBoardIds, periodStart, periodEnd, board.name, 'board', canOpen, statusFilter, assigneeUserId, assigneeNameFor(assigneeUserId));
}

export function generateCategoryReport(
	categoryId: number, periodStart: string, periodEnd: string, user: SessionUser,
	statusFilter: ReportStatusFilter = 'all',
	assigneeUserId: number | null = null
): ReportData | null {
	const cat = db.select().from(boardCategories).where(eq(boardCategories.id, categoryId)).get();
	if (!cat) return null;
	const canOpen = openerFor(user);
	const catBoards = db.select().from(boards).where(eq(boards.categoryId, categoryId)).all()
		.filter(b => canOpen(b.id));
	if (catBoards.length === 0) return null;
	// Include the sub-boards the reader can open, recursively (card 2150)
	const allBoardIds = collectSubBoardIds(catBoards.map(b => b.id), canOpen);
	return generateReportForBoards(allBoardIds, periodStart, periodEnd, cat.name, 'category', canOpen, statusFilter, assigneeUserId, assigneeNameFor(assigneeUserId));
}

export function generateAllBoardsReport(
	periodStart: string, periodEnd: string, user: SessionUser,
	statusFilter: ReportStatusFilter = 'all',
	assigneeUserId: number | null = null
): ReportData | null {
	if (user.role !== 'admin' && user.role !== 'superadmin') return null;
	// Start from top-level boards only, then expand to include sub-boards
	// An administrator opens every board, so nothing is left out; asked all
	// the same, so that the three reports walk by one rule.
	const canOpen = openerFor(user);
	const topLevelBoards = db.select().from(boards).where(isNull(boards.parentCardId)).all();
	const allBoardIds = collectSubBoardIds(topLevelBoards.map(b => b.id), canOpen);
	return generateReportForBoards(allBoardIds, periodStart, periodEnd, 'All Boards', 'all', canOpen, statusFilter, assigneeUserId, assigneeNameFor(assigneeUserId));
}

/**
 * Generate a single-card report — used for requester completion emails.
 * Does NOT require a SessionUser, since it's triggered by the system.
 * Returns the report data scoped to the card's board, with only the target card.
 */
export function generateCardReport(cardId: number): ReportData | null {
	const card = db.select().from(cards).where(eq(cards.id, cardId)).get();
	if (!card) return null;

	const col = db.select().from(columns).where(eq(columns.id, card.columnId)).get();
	if (!col) return null;

	const board = db.select().from(boards).where(eq(boards.id, col.boardId)).get();
	if (!board) return null;

	// Get subtasks
	const cardSubtasks = db.select().from(subtasks).where(eq(subtasks.cardId, cardId)).all();
	const subtaskInfos: SubtaskInfo[] = cardSubtasks.map(st => ({
		title: st.title,
		completed: st.completed,
		priority: st.priority,
		description: st.description || ''
	}));

	// Get assignees
	const assigns = db.select().from(cardAssignees).where(eq(cardAssignees.cardId, cardId)).all();
	const allUsers = db.select({ id: users.id, username: users.username }).from(users).all();
	const userMap = new Map(allUsers.map(u => [u.id, u.username]));
	const assigneeNames = assigns.map(a => userMap.get(a.userId) || 'Unknown');

	const now = new Date().toISOString();
	const createdAt = card.createdAt || now;

	return {
		generatedAt: now,
		periodStart: createdAt,
		periodEnd: now,
		scope: 'board',
		scopeName: `Task Report: ${card.title}`,
		statusFilter: 'all',
		// A single-card report is never scoped to one person.
		assigneeName: null,

		summary: {
			totalCards: 1,
			totalSubtasks: subtaskInfos.length,
			totalTasks: 1 + subtaskInfos.length,
			completedInPeriod: card.completedAt ? 1 : 0,
			createdInPeriod: 1,
			outstanding: card.completedAt ? 0 : 1,
			todo: !card.completedAt && classifyColumnTitle(col.title) === 'todo' ? 1 : 0,
			inProgress: !card.completedAt && classifyColumnTitle(col.title) !== 'todo' ? 1 : 0,
			overdue: 0
		},

		priorityBreakdown: {
			critical: card.priority === 'critical' ? 1 : 0,
			high: card.priority === 'high' ? 1 : 0,
			medium: card.priority === 'medium' ? 1 : 0,
			low: card.priority === 'low' ? 1 : 0
		},

		assigneeStats: assigneeNames.map(name => ({
			username: name,
			completedInPeriod: card.completedAt ? 1 : 0,
			outstanding: card.completedAt ? 0 : 1
		})),

		outstandingTasks: card.completedAt ? [] : [{
			boardName: board.name,
			parentBoardName: null,
			categoryName: '',
			categoryColor: '',
			tasks: [{
				id: card.id,
				title: card.title,
				priority: card.priority,
				dueDate: card.dueDate,
				createdAt: card.createdAt,
				assignees: assigneeNames,
				columnTitle: col.title,
				description: card.description || '',
				businessValue: card.businessValue || '',
				subtasks: subtaskInfos
			}]
		}],

		completedTasks: card.completedAt ? [{
			id: card.id,
			title: card.title,
			priority: card.priority,
			completedAt: card.completedAt,
			boardName: board.name,
			assignees: assigneeNames,
			description: card.description || '',
			businessValue: card.businessValue || '',
			subtasks: subtaskInfos
		}] : [],

		boardBreakdown: [{
			boardName: board.name,
			parentBoardName: null,
			categoryName: '',
			categoryColor: '',
			totalCards: 1,
			completedCards: card.completedAt ? 1 : 0,
			completedInPeriod: card.completedAt ? 1 : 0
		}]
	};
}

// ─── PDF Generation ──────────────────────────────────────────────────────────

// Professional colour palette — clean, print-friendly
/**
 * The report palette. Exported because the milestone plan export draws with it
 * too — these PDFs land in the same stakeholder packs, and a second look would
 * read as coming from somewhere else.
 */
export const REPORT_COLORS = {
	white: '#ffffff',
	bg: '#f8f9fc',
	headerBg: '#1e293b',
	headerText: '#f1f5f9',
	heading: '#0f172a',
	text: '#334155',
	textMuted: '#64748b',
	textLight: '#94a3b8',
	border: '#e2e8f0',
	borderLight: '#f1f5f9',
	accent: '#4f46e5',
	accentLight: '#e0e7ff',
	emerald: '#059669',
	emeraldLight: '#d1fae5',
	amber: '#d97706',
	amberLight: '#fef3c7',
	red: '#dc2626',
	redLight: '#fee2e2',
	blue: '#2563eb',
	blueLight: '#dbeafe',
	rowAlt: '#f8fafc',
	critical: '#dc2626',
	high: '#ea580c',
	medium: '#2563eb',
	low: '#64748b'
};

const C = REPORT_COLORS;

export function stripTag(text: string): string {
	if (!text) return '';
	// AI bookkeeping tags never belong on a stakeholder document
	return text
		.replace(/\[Antigravity\]\s*/gi, '')
		.replace(/\[Claude\]\s*/gi, '')
		.replace(/\[AI\]\s*/gi, '')
		.trim();
}

export function drawSectionTitle(doc: PDFKit.PDFDocument, title: string, x: number, y: number): number {
	doc.font('Helvetica-Bold').fontSize(12).fillColor(C.heading)
		.text(title, x, y);
	y += 18;
	doc.rect(x, y, 40, 2).fill(C.accent);
	return y + 10;
}

export function ensureSpace(doc: PDFKit.PDFDocument, needed: number, y: number): number {
	if (y + needed > doc.page.height - 50) {
		doc.addPage();
		return 40;
	}
	return y;
}

function drawTable(
	doc: PDFKit.PDFDocument,
	headers: string[],
	rows: string[][],
	colWidths: number[],
	startX: number,
	startY: number
): number {
	const fontSize = 7.5;
	const headerHeight = 20;
	const rowPadding = 5;
	const cellPadding = 5;
	const tableWidth = colWidths.reduce((a, b) => a + b, 0);

	let y = startY;

	doc.rect(startX, y, tableWidth, headerHeight).fill(C.headerBg);
	let x = startX;
	doc.font('Helvetica-Bold').fontSize(fontSize).fillColor(C.headerText);
	for (let i = 0; i < headers.length; i++) {
		doc.text(headers[i], x + cellPadding, y + 5, {
			width: colWidths[i] - cellPadding * 2,
			height: headerHeight - 4,
			lineBreak: false
		});
		x += colWidths[i];
	}
	y += headerHeight;

	for (let r = 0; r < rows.length; r++) {
		const row = rows[r];
		let rowH = 16;
		doc.font('Helvetica').fontSize(fontSize);
		for (let i = 0; i < row.length; i++) {
			const h = doc.heightOfString(row[i] || '', { width: colWidths[i] - cellPadding * 2 });
			rowH = Math.max(rowH, h + rowPadding * 2);
		}
		y = ensureSpace(doc, rowH, y);

		const bg = r % 2 === 0 ? C.white : C.rowAlt;
		doc.rect(startX, y, tableWidth, rowH).fill(bg);
		doc.rect(startX, y + rowH - 0.5, tableWidth, 0.5).fill(C.borderLight);

		x = startX;
		doc.fillColor(C.text);
		for (let i = 0; i < row.length; i++) {
			doc.text(row[i] || '—', x + cellPadding, y + rowPadding, {
				width: colWidths[i] - cellPadding * 2,
				height: rowH - rowPadding
			});
			x += colWidths[i];
		}
		y += rowH;
	}

	doc.rect(startX, y, tableWidth, 0.5).fill(C.border);
	return y + 2;
}

/**
 * Draw tasks with nested details — each task is a header row followed by
 * indented description + subtask rows within the same table structure.
 * Summary vs detailed differ in what the sub-row carries, not in whether there
 * is one. A summary keeps the **business justification** — why the work is
 * being done is the one thing a reader skimming a summary actually needs, and a
 * list of titles without it says nothing about whether the work was worth
 * doing. Description and subtasks are the implementation detail that a summary
 * drops.
 */
function drawTasksWithDetails(
	doc: PDFKit.PDFDocument,
	tasks: TaskDetail[],
	columns: { header: string; width: number; getter: (t: TaskDetail) => string }[],
	startX: number,
	startY: number,
	tableWidth: number,
	detailLevel: 'summary' | 'detailed' = 'detailed'
): number {
	const fontSize = 7.5;
	const headerHeight = 20;
	const cellPadding = 5;
	const rowPadding = 5;
	const priorityColors: Record<string, string> = { critical: C.critical, high: C.high, medium: C.medium, low: C.low };

	let y = startY;

	// Header
	doc.rect(startX, y, tableWidth, headerHeight).fill(C.headerBg);
	let x = startX;
	doc.font('Helvetica-Bold').fontSize(fontSize).fillColor(C.headerText);
	for (const col of columns) {
		doc.text(col.header, x + cellPadding, y + 5, {
			width: col.width - cellPadding * 2,
			height: headerHeight - 4,
			lineBreak: false
		});
		x += col.width;
	}
	y += headerHeight;

	for (let r = 0; r < tasks.length; r++) {
		const task = tasks[r];
		const pColor = priorityColors[task.priority] || C.medium;
		// Summary shows business value alone; detailed adds description and subtasks.
		const showDescription = detailLevel === 'detailed' && !!task.description;
		const showSubtasks = detailLevel === 'detailed' && task.subtasks.length > 0;
		const showBusinessValue = !!task.businessValue;
		const hasDetails = showDescription || showSubtasks || showBusinessValue;

		// ─── Main Row ────────────────────────────────────────────────
		let rowH = 16;
		doc.font('Helvetica').fontSize(fontSize);
		for (const col of columns) {
			const val = col.getter(task);
			const h = doc.heightOfString(val || '', { width: col.width - cellPadding * 2 });
			rowH = Math.max(rowH, h + rowPadding * 2);
		}
		y = ensureSpace(doc, rowH + (hasDetails ? 30 : 0), y);

		const bg = r % 2 === 0 ? C.white : C.rowAlt;
		doc.rect(startX, y, tableWidth, rowH).fill(bg);

		// Priority accent left edge
		doc.rect(startX, y, 3, rowH).fill(pColor);

		// Bottom border (lighter if details follow)
		if (hasDetails) {
			doc.rect(startX, y + rowH - 0.5, tableWidth, 0.5).fill(C.borderLight);
		} else {
			doc.rect(startX, y + rowH - 0.5, tableWidth, 0.5).fill(C.border);
		}

		x = startX;
		doc.font('Helvetica').fontSize(fontSize).fillColor(C.text);
		// First column bold
		let first = true;
		for (const col of columns) {
			const val = col.getter(task);
			if (first) {
				doc.font('Helvetica-Bold').fontSize(fontSize).fillColor(C.heading);
				first = false;
			} else {
				doc.font('Helvetica').fontSize(fontSize).fillColor(C.text);
			}
			doc.text(val || '—', x + cellPadding, y + rowPadding, {
				width: col.width - cellPadding * 2,
				height: rowH - rowPadding
			});
			x += col.width;
		}
		y += rowH;

		// ─── Detail Sub-Row (description + subtasks) ─────────────────
		if (hasDetails) {
			const detailX = startX + 12;
			const detailW = tableWidth - 16;
			const detailBg = r % 2 === 0 ? '#fefefe' : '#f6f8fb';

			// Measure detail height
			let detailH = 6; // top padding
			doc.font('Helvetica').fontSize(7.5);
			if (showDescription) {
				const desc = stripTag(task.description);
				detailH += doc.heightOfString(desc, { width: detailW - 10 }) + 6;
			}
			if (showBusinessValue) {
				const bv = stripTag(task.businessValue);
				detailH += 12; // "BUSINESS VALUE" label
				detailH += doc.heightOfString(bv, { width: detailW - 10 }) + 6;
			}
			if (showSubtasks) {
				detailH += 12; // "Subtasks" heading
				for (const st of task.subtasks) {
					detailH += doc.heightOfString(stripTag(st.title), { width: detailW - 30 }) + 3;
					const stDesc = stripTag(st.description);
					if (stDesc) {
						doc.font('Helvetica').fontSize(7);
						detailH += doc.heightOfString(stDesc, { width: detailW - 30 }) + 3;
					}
				}
			}
			detailH += 4; // bottom padding

			y = ensureSpace(doc, detailH, y);

			// Detail background
			doc.rect(startX, y, tableWidth, detailH).fill(detailBg);
			doc.rect(startX, y + detailH - 0.5, tableWidth, 0.5).fill(C.border);
			// Indent marker
			doc.rect(detailX - 4, y + 4, 2, detailH - 8).fill(C.borderLight);

			let dy = y + 6;

			// Description
			if (showDescription) {
				const desc = stripTag(task.description);
				doc.font('Helvetica').fontSize(7.5).fillColor(C.textMuted)
					.text(desc, detailX, dy, { width: detailW - 10 });
				dy = (doc as any).y + 6;
			}

			// Business Value
			if (showBusinessValue) {
				const bv = stripTag(task.businessValue);
				doc.font('Helvetica-Bold').fontSize(6.5).fillColor(C.accent)
					.text('BUSINESS VALUE', detailX, dy, { width: detailW - 10 });
				dy = (doc as any).y + 2;
				doc.font('Helvetica').fontSize(7).fillColor('#4338ca')
					.text(bv, detailX, dy, { width: detailW - 10 });
				dy = (doc as any).y + 6;
			}

			// Subtasks
			if (showSubtasks) {
				const done = task.subtasks.filter(s => s.completed).length;
				doc.font('Helvetica-Bold').fontSize(7).fillColor(C.textMuted)
					.text(`Subtasks (${done}/${task.subtasks.length})`, detailX, dy, { width: detailW - 10 });
				dy = (doc as any).y + 3;

				for (const st of task.subtasks) {
					const marker = st.completed ? 'DONE' : 'TODO';
					const markerColor = st.completed ? C.emerald : C.textMuted;
					const titleColor = st.completed ? C.textLight : C.text;

					doc.font('Helvetica-Bold').fontSize(6).fillColor(markerColor)
						.text(marker, detailX + 4, dy, { continued: true, width: detailW - 20 });
					doc.font('Helvetica').fontSize(7.5).fillColor(titleColor)
						.text('  ' + stripTag(st.title), { continued: false });
					dy = (doc as any).y + 1;

					// Subtask description
					const stDesc = stripTag(st.description);
					if (stDesc) {
						doc.font('Helvetica-Oblique').fontSize(7).fillColor(C.textLight)
							.text(stDesc, detailX + 12, dy, { width: detailW - 30 });
						dy = (doc as any).y + 2;
					}
				}
			}

			y += detailH;
		}
	}

	return y;
}

export async function generateReportPdf(data: ReportData, detailLevel: 'summary' | 'detailed' = 'detailed'): Promise<Buffer> {
	return new Promise((resolve, reject) => {
	const doc = new PDFDocument({
		size: 'A4',
		margins: { top: 36, bottom: 36, left: 40, right: 40 },
		info: {
			Title: `DumpFire Report - ${data.assigneeName ? `${data.scopeName} - ${data.assigneeName}` : data.scopeName}`,
			Author: 'DumpFire',
			Subject: `Report for ${data.scopeName} (${formatDate(data.periodStart)} - ${formatDate(data.periodEnd)})`
		}
	});

	const chunks: Buffer[] = [];
	doc.on('data', (chunk: Buffer) => chunks.push(chunk));
	doc.on('end', () => resolve(Buffer.concat(chunks)));
	doc.on('error', (err) => reject(err));

	const pw = doc.page.width - 80;
	const mx = 40;

	// ─── Header Banner ───────────────────────────────────────────────────
	doc.rect(0, 0, doc.page.width, 80).fill(C.headerBg);
	const modeLabel = detailLevel === 'summary' ? 'Summary Report' : 'Detailed Report';
	// A filtered report must say so on its face — the figures are that person's
	// work only, and a reader who misses that will read them as the whole team's.
	const scopeLabel = data.assigneeName ? `${data.scopeName} — ${data.assigneeName}` : data.scopeName;
	const filterLabel = data.statusFilter !== 'all' ? `  ·  ${REPORT_STATUS_FILTER_LABELS[data.statusFilter]}` : '';
	doc.font('Helvetica-Bold').fontSize(18).fillColor(C.headerText)
		.text('DumpFire Report', mx, 14, { width: pw });
	doc.font('Helvetica-Bold').fontSize(11).fillColor(C.accentLight)
		.text(`${scopeLabel}  ·  ${modeLabel}${filterLabel}`, mx, 34, { width: pw });
	doc.font('Helvetica-Bold').fontSize(10).fillColor(C.headerText)
		.text(`${formatDate(data.periodStart)}  -  ${formatDate(data.periodEnd)}`, mx, 52, { width: pw });
	doc.font('Helvetica').fontSize(7.5).fillColor(C.textLight)
		.text(`Generated ${formatDate(data.generatedAt)}`, mx, 66, { width: pw });

	let y = 94;

	// ─── Reporting Period Banner ─────────────────────────────────────────
	doc.roundedRect(mx, y, pw, 28, 4).fill(C.accentLight);
	doc.font('Helvetica-Bold').fontSize(7).fillColor(C.accent)
		.text('REPORTING PERIOD', mx + 12, y + 5);
	doc.font('Helvetica-Bold').fontSize(10).fillColor(C.heading)
		.text(`${formatDate(data.periodStart)}  to  ${formatDate(data.periodEnd)}`, mx + 12, y + 14, { width: pw - 24 });
	y += 40;

	// ─── Summary Metrics ─────────────────────────────────────────────────
	// Cards and tasks sit side by side so the two figures are never mistaken
	// for each other: cards are the kanban cards in scope, tasks add every
	// subtask on top. Both are scope-wide regardless of the status filter.
	const metrics = [
		{ label: 'Cards', value: data.summary.totalCards, bg: C.accentLight, fg: C.accent },
		{ label: 'Tasks incl. subtasks', value: data.summary.totalTasks, bg: C.accentLight, fg: C.accent },
		{ label: 'Completed', value: data.summary.completedInPeriod, bg: C.emeraldLight, fg: C.emerald },
		{ label: 'Created', value: data.summary.createdInPeriod, bg: C.blueLight, fg: C.blue },
		{ label: 'Outstanding', value: data.summary.outstanding, bg: C.amberLight, fg: C.amber },
		{ label: 'Overdue', value: data.summary.overdue, bg: C.redLight, fg: C.red }
	];

	const metricGap = 8;
	const cardW = (pw - (metrics.length - 1) * metricGap) / metrics.length;
	for (let i = 0; i < metrics.length; i++) {
		const m = metrics[i];
		const cx = mx + i * (cardW + metricGap);
		doc.roundedRect(cx, y, cardW, 44, 4).fill(m.bg);
		doc.font('Helvetica-Bold').fontSize(20).fillColor(m.fg)
			.text(String(m.value), cx, y + 6, { width: cardW, align: 'center' });
		doc.font('Helvetica').fontSize(6).fillColor(m.fg)
			.text(m.label.toUpperCase(), cx, y + 30, { width: cardW, align: 'center' });
	}
	y += 50;
	doc.font('Helvetica').fontSize(6.5).fillColor(C.textLight)
		.text(
			`Cards = ${data.summary.totalCards} kanban cards across every board and sub-board in scope (archived excluded). ` +
			`Tasks = those cards plus their ${data.summary.totalSubtasks} subtasks. ` +
			`Completed and Created count cards within the reporting period; Outstanding = ${data.summary.todo} To Do + ${data.summary.inProgress} In Progress.`,
			mx, y, { width: pw }
		);
	y = (doc as any).y + 12;

	// ─── Status Filter Banner ────────────────────────────────────────────
	if (data.statusFilter !== 'all') {
		const focusCount =
			data.statusFilter === 'completed' ? data.summary.completedInPeriod :
			data.statusFilter === 'todo' ? data.summary.todo :
			data.summary.inProgress;
		const plural = focusCount === 1 ? '' : 's';
		const focusText =
			data.statusFilter === 'completed' ? `Completed in period only — ${focusCount} card${plural}` :
			data.statusFilter === 'todo' ? `To Do only — ${focusCount} card${plural} not yet started` :
			`In Progress only — ${focusCount} card${plural} started but not complete (includes On Hold, Review and similar columns)`;
		doc.roundedRect(mx, y, pw, 28, 4).fill(C.amberLight);
		doc.font('Helvetica-Bold').fontSize(7).fillColor(C.amber)
			.text('SHOWING', mx + 12, y + 5);
		doc.font('Helvetica-Bold').fontSize(9).fillColor(C.heading)
			.text(focusText, mx + 12, y + 14, { width: pw - 24, lineBreak: false });
		y += 40;
	}


	// ─── Priority Breakdown (of whichever slice the filter reports) ──────
	const priorityTotal = data.priorityBreakdown.critical + data.priorityBreakdown.high
		+ data.priorityBreakdown.medium + data.priorityBreakdown.low;
	if (priorityTotal > 0) {
		const prioritySubject =
			data.statusFilter === 'completed' ? 'Completed in Period' :
			data.statusFilter === 'todo' ? 'To Do' :
			data.statusFilter === 'in_progress' ? 'In Progress' :
			'Outstanding';
		y = drawSectionTitle(doc, `Priority Distribution — ${prioritySubject}`, mx, y);
		const total = priorityTotal;
		const barH = 14;
		const priorities = [
			{ label: 'Critical', count: data.priorityBreakdown.critical, color: C.critical },
			{ label: 'High', count: data.priorityBreakdown.high, color: C.high },
			{ label: 'Medium', count: data.priorityBreakdown.medium, color: C.medium },
			{ label: 'Low', count: data.priorityBreakdown.low, color: C.low }
		];
		let barX = mx;
		doc.roundedRect(mx, y, pw, barH, 3).fill(C.borderLight);
		for (const p of priorities) {
			if (p.count > 0) {
				const segW = (p.count / total) * pw;
				doc.rect(barX, y, segW, barH).fill(p.color);
				barX += segW;
			}
		}
		y += barH + 8;
		let legendX = mx;
		for (const p of priorities) {
			if (p.count > 0) {
				doc.roundedRect(legendX, y, 8, 8, 1).fill(p.color);
				doc.font('Helvetica').fontSize(7).fillColor(C.text)
					.text(`${p.label}: ${p.count}`, legendX + 12, y, { continued: false });
				legendX += 90;
			}
		}
		y += 18;
	}

	// ─── Team Performance ────────────────────────────────────────────────
	if (data.assigneeStats.length > 0) {
		y = drawSectionTitle(doc, 'Team Performance', mx, y);
		const headers = ['Assignee', 'Completed', 'Outstanding', 'Total'];
		const widths = [pw * 0.40, pw * 0.20, pw * 0.20, pw * 0.20];
		const rows = data.assigneeStats.map(m => [
			m.username,
			String(m.completedInPeriod),
			String(m.outstanding),
			String(m.completedInPeriod + m.outstanding)
		]);
		y = drawTable(doc, headers, rows, widths, mx, y);
		y += 14;
	}

	// ─── Board Breakdown ─────────────────────────────────────────────────
	if (data.boardBreakdown.length > 1) {
		y = ensureSpace(doc, 100, y);
		y = drawSectionTitle(doc, 'Board Breakdown', mx, y);

		// Group sub-boards under their parent boards
		const parentBoards = data.boardBreakdown.filter(b => !b.parentBoardName);
		const subBoardsByParent = new Map<string, typeof data.boardBreakdown>();
		for (const b of data.boardBreakdown) {
			if (b.parentBoardName) {
				if (!subBoardsByParent.has(b.parentBoardName)) subBoardsByParent.set(b.parentBoardName, []);
				subBoardsByParent.get(b.parentBoardName)!.push(b);
			}
		}

		// Build flat rows with indentation for sub-boards
		const headers = ['Board', 'Total', 'Completed', 'In Period', 'Remaining'];
		const widths = [pw * 0.36, pw * 0.16, pw * 0.16, pw * 0.16, pw * 0.16];
		const rows: string[][] = [];
		for (const b of parentBoards) {
			rows.push([
				b.boardName,
				String(b.totalCards),
				String(b.completedCards),
				String(b.completedInPeriod),
				String(b.totalCards - b.completedCards)
			]);
			// Add sub-boards indented beneath
			const subs = subBoardsByParent.get(b.boardName) || [];
			for (const sb of subs) {
				rows.push([
					`  └ ${sb.boardName}`,
					String(sb.totalCards),
					String(sb.completedCards),
					String(sb.completedInPeriod),
					String(sb.totalCards - sb.completedCards)
				]);
			}
		}
		// Add any orphaned sub-boards (parent not in breakdown)
		const parentNames = new Set(parentBoards.map(b => b.boardName));
		for (const [parentName, subs] of subBoardsByParent) {
			if (!parentNames.has(parentName)) {
				for (const sb of subs) {
					rows.push([
						`${parentName} └ ${sb.boardName}`,
						String(sb.totalCards),
						String(sb.completedCards),
						String(sb.completedInPeriod),
						String(sb.totalCards - sb.completedCards)
					]);
				}
			}
		}
		y = drawTable(doc, headers, rows, widths, mx, y);
		y += 14;
	}

	// ─── Outstanding Tasks (grouped by category, sub-boards nested under parent) ──
	// Drawn as a function so the status filter can decide whether — and in what
	// order relative to the completed work — this block appears.
	const openLabel =
		data.statusFilter === 'todo' ? 'To Do' :
		data.statusFilter === 'in_progress' ? 'In Progress' :
		'Outstanding';
	function drawOpenWork() {
		if (data.outstandingTasks.length === 0) return;
		// Group boards by category for multi-board reports
		const byCategory = new Map<string, typeof data.outstandingTasks>();
		for (const group of data.outstandingTasks) {
			const key = group.categoryName || 'Uncategorised';
			if (!byCategory.has(key)) byCategory.set(key, []);
			byCategory.get(key)!.push(group);
		}

		const isMultiBoard = data.scope === 'all' || data.scope === 'category';

		// Build parent→sub-board grouping
		const subBoardsByParent = new Map<string, typeof data.outstandingTasks>();
		const parentGroups = new Set<typeof data.outstandingTasks[0]>();
		for (const group of data.outstandingTasks) {
			if (group.parentBoardName) {
				if (!subBoardsByParent.has(group.parentBoardName)) subBoardsByParent.set(group.parentBoardName, []);
				subBoardsByParent.get(group.parentBoardName)!.push(group);
			} else {
				parentGroups.add(group);
			}
		}

		for (const [catName, groups] of byCategory) {
			// Category header (only for multi-board reports)
			if (isMultiBoard && byCategory.size > 1) {
				y = ensureSpace(doc, 28, y);
				const catColor = groups[0]?.categoryColor || '#94a3b8';
				doc.rect(mx, y + 2, pw, 0.5).fill(C.borderLight);
				doc.rect(mx, y + 6, 3, 12).fill(catColor);
				doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.textMuted)
					.text(catName.toUpperCase(), mx + 10, y + 7, { width: pw - 20, lineBreak: false });
				y += 24;
			}

			// Render parent boards, with sub-boards nested underneath
			const rendered = new Set<string>(); // track rendered board names to avoid duplicates
			for (const group of groups) {
				if (group.parentBoardName) continue; // sub-boards rendered with their parent
				if (rendered.has(group.boardName)) continue;
				rendered.add(group.boardName);

				y = ensureSpace(doc, 60, y);
				y = drawSectionTitle(doc, `${openLabel} — ${group.boardName}`, mx, y);
				y = drawTasksWithDetails(doc, group.tasks, [
					{ header: 'Title', width: pw * 0.32, getter: t => stripTag(t.title) },
					{ header: 'Column', width: pw * 0.15, getter: t => t.columnTitle },
					{ header: 'Priority', width: pw * 0.13, getter: t => t.priority.charAt(0).toUpperCase() + t.priority.slice(1) },
					{ header: 'Due Date', width: pw * 0.20, getter: t => t.dueDate ? formatDate(t.dueDate) : '—' },
					{ header: 'Assignees', width: pw * 0.20, getter: t => t.assignees.join(', ') || '—' }
				], mx, y, pw, detailLevel);

				// Render sub-boards nested under this parent
				const subs = subBoardsByParent.get(group.boardName) || [];
				for (const sub of subs) {
					y = ensureSpace(doc, 60, y);
					y += 14; // breathing room before sub-board section
					// Sub-board section — proper heading with parent context
					doc.font('Helvetica').fontSize(7).fillColor(C.textMuted)
						.text(`SUB-BOARD OF ${group.boardName.toUpperCase()}`, mx + 2, y, { width: pw - 4 });
					y += 12;
					y = drawSectionTitle(doc, `${openLabel} — ${sub.boardName}`, mx, y);
					y = drawTasksWithDetails(doc, sub.tasks, [
						{ header: 'Title', width: pw * 0.32, getter: t => stripTag(t.title) },
						{ header: 'Column', width: pw * 0.15, getter: t => t.columnTitle },
						{ header: 'Priority', width: pw * 0.13, getter: t => t.priority.charAt(0).toUpperCase() + t.priority.slice(1) },
						{ header: 'Due Date', width: pw * 0.20, getter: t => t.dueDate ? formatDate(t.dueDate) : '—' },
						{ header: 'Assignees', width: pw * 0.20, getter: t => t.assignees.join(', ') || '—' }
					], mx, y, pw, detailLevel);
				}
			}

			// Render any orphaned sub-boards (parent not in this category group)
			for (const group of groups) {
				if (!group.parentBoardName) continue;
				if (rendered.has(`${group.parentBoardName}→${group.boardName}`)) continue;
				// Check if parent was already rendered in this category
				if (rendered.has(group.parentBoardName)) {
					rendered.add(`${group.parentBoardName}→${group.boardName}`);
					continue; // already rendered as nested
				}
				rendered.add(`${group.parentBoardName}→${group.boardName}`);
				y = ensureSpace(doc, 60, y);
				y = drawSectionTitle(doc, `${openLabel} — ${group.parentBoardName} └ ${group.boardName}`, mx, y);
				y = drawTasksWithDetails(doc, group.tasks, [
					{ header: 'Title', width: pw * 0.32, getter: t => stripTag(t.title) },
					{ header: 'Column', width: pw * 0.15, getter: t => t.columnTitle },
					{ header: 'Priority', width: pw * 0.13, getter: t => t.priority.charAt(0).toUpperCase() + t.priority.slice(1) },
					{ header: 'Due Date', width: pw * 0.20, getter: t => t.dueDate ? formatDate(t.dueDate) : '—' },
					{ header: 'Assignees', width: pw * 0.20, getter: t => t.assignees.join(', ') || '—' }
				], mx, y, pw, detailLevel);
			}
		}
	}

	// ─── Completed Tasks (unified) ───────────────────────────────────────
	function drawCompletedWork() {
		if (data.completedTasks.length === 0) return;
		y = ensureSpace(doc, 60, y);
		y = drawSectionTitle(doc, `Completed in Period (${data.completedTasks.length})`, mx, y);
		const completedAsTaskDetails: TaskDetail[] = data.completedTasks.map(t => ({
			...t,
			columnTitle: 'Complete',
			createdAt: '',
			dueDate: null
		}));
		y = drawTasksWithDetails(doc, completedAsTaskDetails, [
			{ header: 'Title', width: pw * 0.30, getter: t => stripTag(t.title) },
			{ header: 'Board', width: pw * 0.18, getter: t => (t as any).boardName || '—' },
			{ header: 'Priority', width: pw * 0.13, getter: t => t.priority.charAt(0).toUpperCase() + t.priority.slice(1) },
			{ header: 'Completed', width: pw * 0.19, getter: t => (t as any).completedAt ? formatDate((t as any).completedAt) : '—' },
			{ header: 'Assignees', width: pw * 0.20, getter: t => t.assignees.join(', ') || '—' }
		], mx, y, pw, detailLevel);
		y += 16;
	}




	// ─── Section order ───────────────────────────────────────────────────
	// The full report leads with what got finished, then lists what is still
	// open; the filtered variants draw only their own slice.
	if (data.statusFilter === 'completed') {
		drawCompletedWork();
	} else if (data.statusFilter === 'all') {
		drawCompletedWork();
		drawOpenWork();
	} else {
		drawOpenWork();
	}

	doc.end();
	});
}

// ─── Who Report Mail May Reach (card 2182) ──────────────────────────────────

/**
 * The most addresses one account's report mail may reach in a day: the
 * reports it emails by hand, and the schedules it makes, turns on or re-times.
 */
export const REPORT_MAILS_PER_DAY = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What a request that would spend report mail is: the refusal's words follow it. */
export type ReportMailSpend = 'email' | 'new schedule' | 'changed schedule' | 'new recipients';

/**
 * Take `n` addresses from `user`'s report mail for the day, or refuse the
 * request whole with a 429 that takes nothing. A day is a fixed window from
 * the account's first take, in memory: a restart starts it again.
 *
 * A scheduled run takes nothing: it would be dropped with nobody told on a
 * day its owner had also mailed by hand. A schedule pays when it is made,
 * turned on or re-timed instead (the plan's R1), since each of those can
 * bring a send forward: a schedule made for the next minute, run, deleted and
 * made again would otherwise mail without bound. A change of its list pays
 * for the addresses it adds (`'new recipients'`, the review's B1), or a
 * schedule made with none and given ten would do the same. Called after every other
 * check of the request and, for a schedule, immediately before the write in
 * the same transaction, with nothing awaited between, so two requests cannot
 * both fit in the last of the allowance. Nothing is given back when a mail
 * server refuses a send, or a schedule is deleted.
 *
 * The first refusal in each window is one WARN line naming the account.
 */
export function takeReportMail(user: Pick<SessionUser, 'id' | 'username'>, n: number, spend: ReportMailSpend): void {
	const took = takeAllowance(`report-mail:${user.id}`, n, REPORT_MAILS_PER_DAY, DAY_MS);
	if (took.taken) return;
	if (took.firstRefusal) {
		// The account as the line's user, so the Audit page finds it by user.
		log.warn(
			`Account "${user.username}" (user ${user.id}) reached its limit of ${REPORT_MAILS_PER_DAY} report mail addresses a day: ` +
				'report mail, and schedules made, turned on, re-timed or given new addresses, are refused until the day is up',
			{ used: took.used, asked: n, retryAfterSecs: took.retryAfterSecs },
			{ userId: user.id }
		);
	}
	const wouldMake = (took.used + n).toLocaleString('en-GB');
	const retry = took.retryAfterSecs >= 3600
		? `${Math.ceil(took.retryAfterSecs / 3600)} hour(s)`
		: `${Math.max(1, Math.ceil(took.retryAfterSecs / 60))} minute(s)`;
	if (spend === 'email') {
		throw error(429, `Reports can be emailed to at most ${REPORT_MAILS_PER_DAY} addresses a day from one account, and this would make ${wouldMake}. Try again in ${retry}.`);
	}
	throw error(
		429,
		`Report mail can reach at most ${REPORT_MAILS_PER_DAY} addresses a day from one account, and this schedule's ${n}${spend === 'new recipients' ? ' new addresses' : ''} would make ${wouldMake}. ` +
			`The schedule was not ${spend === 'new schedule' ? 'saved' : 'changed'}. Try again in ${retry}.`
	);
}

/** Why a schedule whose list is over the cap cannot be turned on, or was switched off (decision 6). */
export function overCapScheduleWords(count: number): string {
	return `it is sent to ${count} addresses, and the most is ${MAX_REPORT_RECIPIENTS}`;
}

// ─── Report Scheduler ────────────────────────────────────────────────────────

let reportTimer: ReturnType<typeof setInterval> | null = null;

type ReportScheduleRow = typeof reportSchedules.$inferSelect;

/** A schedule's owner as a log line names them, so an administrator knows whom to tell. */
function ownerWords(schedule: ReportScheduleRow): string {
	const ownedBy = db.select({ username: users.username }).from(users).where(eq(users.id, schedule.userId)).get();
	return ownedBy ? `owner "${ownedBy.username}" (user ${schedule.userId})` : `owner user ${schedule.userId}`;
}

/**
 * Switch off a schedule whose next run cannot be worked out, and say so once
 * (card 2144, decision 5). Nothing is sent and `last_run_at` is left. The
 * write is conditional on the schedule being on, and the ERROR line written
 * only when it changed the row (the review's R4): of two runs that meet it,
 * or of every start that meets it switched off with no next run, only the one
 * that switched it off says so. It used to be sent at every minute's tick, as
 * its next run was worked out after the sends, and threw there.
 *
 * A next run it cannot read is cleared as well, on or off, while it still
 * holds that value (the review's O-S1): the start-up conversion of timestamps
 * named `NaN-NaN-NaN NaN:NaN:NaN`, the value the image before card 2144 wrote
 * for a time it could not read, at every start.
 */
function switchOffUndatable(schedule: ReportScheduleRow, fault: string, nowStr: Stamp): void {
	if (schedule.nextRunAt && !hasReadableNextRun(schedule)) {
		db.update(reportSchedules)
			.set({ nextRunAt: null })
			.where(and(eq(reportSchedules.id, schedule.id), eq(reportSchedules.nextRunAt, schedule.nextRunAt)))
			.run();
	}
	const switched = db.update(reportSchedules)
		.set({ enabled: false, updatedAt: nowStr })
		.where(and(eq(reportSchedules.id, schedule.id), eq(reportSchedules.enabled, true)))
		.run();
	if (switched.changes !== 1) return;
	// Its owner is the line's user, so the Audit page finds it by user. Its
	// owner can turn it on again with a timing that can be read in the same
	// `PUT` (the review's S-N3); the page cannot change a timing.
	log.error(
		`Report schedule ${schedule.id} "${schedule.name}", ${ownerWords(schedule)}, was switched off: ${fault}, so its next run cannot be worked out. ` +
			'Nothing was sent. Its owner can turn it on again with a time, day and zone that can be read, or delete it and make it again.',
		undefined,
		{ userId: schedule.userId }
	);
}

/**
 * Whether a schedule has a next run that can be read as a moment. None, an
 * empty one, and one that cannot be read (`NaN-NaN-NaN NaN:NaN:NaN`) count as
 * no next run (the review's O-S1). Compared as text, that value was after
 * every moment, so the schedule was never due: neither sent nor switched off.
 */
function hasReadableNextRun(schedule: ReportScheduleRow): boolean {
	return toStamp(schedule.nextRunAt) !== null;
}

/**
 * Give a schedule with no next run its first one, and send nothing (decision
 * 7): a restored or hand-made row is not mailed the moment it arrives. Or
 * switch it off, if its next run cannot be worked out. Written only while it
 * still has none, or still holds the one that could not be read, so that two
 * runs give it one once.
 */
function giveFirstRun(schedule: ReportScheduleRow, now: Date, nowStr: Stamp): void {
	const next = nextRunAfter(schedule, now);
	if ('fault' in next) {
		switchOffUndatable(schedule, next.fault, nowStr);
		return;
	}
	db.update(reportSchedules)
		.set({ nextRunAt: stamp(next.at) })
		.where(and(
			eq(reportSchedules.id, schedule.id),
			or(isNull(reportSchedules.nextRunAt), eq(reportSchedules.nextRunAt, schedule.nextRunAt ?? ''))
		))
		.run();
}

/**
 * Claim a schedule's run that is due at `now`, moving its last and next run,
 * before anything is built or sent (card 2144, decision 4). One conditional
 * write: it changes the row only while the schedule is on and still due, so
 * of two runs that met the schedule due, whether two ticks or two processes
 * on the one database, only one has the claim; SQLite takes the write lock,
 * so both cannot. Hands back the row as claimed, or undefined when another
 * run has it. Exported for the tests.
 *
 * The run is then sent at most once: a failure after the claim, or a restart
 * during the sends, is not sent again (the review's R13). It used to be
 * written after the sends, so a run that took over a minute was sent again by
 * the next tick, and a restart sent it again to everyone.
 */
export function claimScheduleRun(id: number, now: Date, next: Date): ReportScheduleRow | undefined {
	const nowStr = stamp(now);
	return db.update(reportSchedules)
		.set({ lastRunAt: nowStr, nextRunAt: stamp(next), updatedAt: nowStr })
		.where(and(
			eq(reportSchedules.id, id),
			eq(reportSchedules.enabled, true),
			isNotNull(reportSchedules.nextRunAt),
			lte(reportSchedules.nextRunAt, nowStr)
		))
		.returning()
		.get();
}

/**
 * Switch off a schedule whose list is over the cap (card 2182), made before
 * there was one, and say so once; true when it is over. Read as every route
 * and the page read it. Nothing is sent. The write is conditional, so that of
 * two runs that meet it only the one that switched it off says so.
 */
function switchOffOverCap(schedule: ReportScheduleRow, nowStr: Stamp): boolean {
	const count = reportRecipients(schedule.recipients).addresses.length;
	if (count <= MAX_REPORT_RECIPIENTS) return false;
	const switched = db.update(reportSchedules)
		.set({ enabled: false, updatedAt: nowStr })
		.where(and(eq(reportSchedules.id, schedule.id), eq(reportSchedules.enabled, true)))
		.run();
	if (switched.changes === 1) {
		// Naming its owner, who is the line's user, so the Audit page finds it
		// by user and an administrator knows whom to tell.
		log.error(
			`Report schedule ${schedule.id} "${schedule.name}", ${ownerWords(schedule)}, was switched off: ${overCapScheduleWords(count)}. ` +
				`Nothing was sent. Its owner can delete it and make it again with at most ${MAX_REPORT_RECIPIENTS}.`,
			undefined,
			{ userId: schedule.userId }
		);
	}
	return true;
}

/**
 * The days a scheduled report run at `now` covers: up to `now`, from the same
 * time by the schedule's clock `periodDays` dates earlier, in the stored form
 * (card 2159, the review's O-S4). Seven days from Monday 09:00 in London,
 * across the autumn change, is from the Monday before at 09:00 BST. It used
 * to be `setDate` on the server's clock, so on a server on UTC the window
 * began an hour off the schedule's time in any week with a clock change.
 * Exported for the tests.
 */
export function getPeriodForSchedule(
	schedule: Pick<ReportScheduleRow, 'periodDays' | 'timeZone'>,
	now: Date
): { start: string; end: string } {
	const start = sameTimeDaysBefore(now, schedule.periodDays || 7, schedule.timeZone);	return { start: stamp(start), end: stamp(now) };
}

/**
 * Run each enabled schedule that is due at `now`. The timer of
 * `initReportScheduler` calls it every minute, through
 * `runDueReportSchedulesOnce`, which skips a tick while the last run is still
 * going; it is exported for the tests, where that timer is off
 * (`SCHEDULERS=off`).
 *
 * For each schedule due (cards 2144 and 2159), in this order:
 *   1. its next run is worked out from now, in its own zone (`nextRunAfter`).
 *      One that cannot be worked out is switched off, with one ERROR line,
 *      and nothing is sent (`switchOffUndatable`);
 *   2. one with no next run, or one that cannot be read, is given one, and
 *      nothing is sent (`giveFirstRun`);
 *   3. the run is claimed (`claimScheduleRun`), which moves its last and next
 *      run; a claim another run has is skipped;
 *   4. the report is built from the row as claimed, and sent.
 *
 * The system log says what happened (card 2113). Each send's result is
 * counted: one WARN line when every recipient was sent the report, or one
 * ERROR line naming each address it did not reach. It used to say "emailed
 * to N recipient(s)" whatever the mail server answered. A schedule that
 * produces no report, because what it covers is gone or its owner can no
 * longer read it, says so in a WARN line, where it used to say nothing. Either
 * way the schedule moves on to its next run: a retry would mail the report a
 * second time to everyone it did reach.
 */
export async function runDueReportSchedules(now: Date): Promise<void> {
	// The stored form, as `next_run_at` is: a schedule due at 09:00 compared
	// with an ISO "now" ran at any time after midnight that day (card 2095).
	const nowStr = stamp(now);

	const activeSchedules = db.select().from(reportSchedules)
		.where(eq(reportSchedules.enabled, true))
		.all();

	for (const selected of activeSchedules) {
		// A next run that cannot be read is none (the review's O-S1).
		const dueAt = toStamp(selected.nextRunAt);
		if (dueAt && dueAt > nowStr) continue;

		// Once claimed, a failure does not send the run again before the next.
		let claimed = false;
		try {
			const next = nextRunAfter(selected, now);
			if ('fault' in next) {
				switchOffUndatable(selected, next.fault, nowStr);
				continue;
			}
			if (!dueAt) {
				giveFirstRun(selected, now, nowStr);
				continue;
			}

			// Over the cap (card 2182): switched off before the claim, and
			// nothing sent.
			if (switchOffOverCap(selected, nowStr)) continue;

			// From here the row as claimed, not as selected when the run began: a
			// change made between the two is honoured (the review's R12). A
			// claim that meets another connection's write lock throws, is logged
			// below, and leaves the schedule due for the next tick.
			const schedule = claimScheduleRun(selected.id, now, next.at);
			if (!schedule) continue;
			claimed = true;
			if (switchOffOverCap(schedule, nowStr)) continue;
			const { addresses: recipients, notAddresses } = reportRecipients(schedule.recipients);
			// A part that is not an address is never sent to, and is named in
			// the run's line; the schedule still reaches the addresses it holds.
			const leftOut = notAddresses.length === 0
				? ''
				: ` Left out, as not email addresses: ${notAddresses.map((part) => `"${part}"`).join(', ')}.`;

			const owner = db.select().from(users).where(eq(users.id, schedule.userId)).get();
			if (!owner) continue;

			const sessionUser: SessionUser = {
				id: owner.id,
				username: owner.username,
				email: owner.email,
				emoji: owner.emoji || '',
				role: owner.role
			};

			const { start, end } = getPeriodForSchedule(schedule, now);

			const statusFilter = parseStatusFilter(schedule.statusFilter);

			let reportData: ReportData | null = null;
			if (schedule.scope === 'board' && schedule.scopeId) {
				reportData = generateBoardReport(schedule.scopeId, start, end, sessionUser, statusFilter);
			} else if (schedule.scope === 'category' && schedule.scopeId) {
				reportData = generateCategoryReport(schedule.scopeId, start, end, sessionUser, statusFilter);
			} else if (schedule.scope === 'all') {
				reportData = generateAllBoardsReport(start, end, sessionUser, statusFilter);
			}

			if (reportData) {
				const schedDetailLevel = schedule.detailLevel === 'summary' ? 'summary' : 'detailed';
				const pdfBuffer = await generateReportPdf(reportData, schedDetailLevel as 'summary' | 'detailed');
				const reportName = `${schedule.name} - ${schedule.frequency === 'weekly' ? 'Weekly' : 'Monthly'} Report`;
				// The days by the schedule's clock, as its time is read (card 2159).
				const zone = canonicalTimeZone(schedule.timeZone) ?? undefined;
				const periodLabel = `${formatDate(start, zone)} - ${formatDate(end, zone)}`;

				if (recipients.length > 0) {
					const notReached: string[] = [];
					for (const email of recipients) {
						let sent = false;
						try {
							// The schedule's name and its owner's username are typing,
							// mailed to the addresses they listed: escaped where they
							// are put (card 2149). The subject is plain text and keeps
							// the name as typed. The mail names the account behind
							// it, as the one sent by hand does (card 2182): any
							// address may be a recipient.
							sent = await sendEmailWithAttachment(
								email,
								`DumpFire Report: ${reportName}`,
								`<h2>DumpFire Report</h2>
								<p><strong>${escapeHtml(reportName)}</strong></p>
								<p>Period: ${escapeHtml(periodLabel)}</p>
								<p>Please find the attached PDF report.</p>
								<p style="color: #8b8fa3; font-size: 12px;">Set up by ${escapeHtml(owner.username)}<br>— DumpFire Automated Reports</p>`,
								{
									filename: `dumpfire-report-${reportData.scopeName.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().split('T')[0]}.pdf`,
									content: pdfBuffer,
									contentType: 'application/pdf'
								}
							);
						} catch (emailErr) {
							log.error(`Failed to email report to ${email}`, emailErr);
						}
						if (!sent) notReached.push(email);
					}
					const reached = recipients.length - notReached.length;
					if (notReached.length === 0) {
						log.warn(`Scheduled report emailed: "${schedule.name}" to ${reached} of ${recipients.length} recipient(s)${leftOut ? `.${leftOut}` : ''}`);
					} else {
						// With no mail set up, `email.ts` returns false and logs nothing.
						const why = isSmtpConfigured()
							? 'The mail server did not accept it: its reason is in the EMAIL line logged for each address'
							: 'Mail is not set up on this server';
						log.error(
							`Scheduled report "${schedule.name}" was not emailed to ${notReached.join(', ')} (${reached} of ${recipients.length} recipient(s) reached). ${why}. It is not sent again before its next run.${leftOut}`
						);
					}
				} else {
					log.warn(`Scheduled report generated but no recipients configured: "${schedule.name}"${leftOut ? `.${leftOut}` : ''}`);
				}
			} else {
				// This used to pass without a word, and the schedule moved on.
				// `generateCategoryReport` is null for a grouping that is there
				// too, when it holds no board or none its owner can read.
				const what = schedule.scope === 'category' ? 'grouping' : 'board';
				const why = schedule.scope === 'all'
					? "a report on every board is for an administrator, and the schedule's owner is not one"
					: !schedule.scopeId
						? `the schedule has no ${what}`
						: schedule.scope === 'category'
							? `the grouping it covers (id ${schedule.scopeId}) is gone, holds no board, or holds none the schedule's owner can read`
							: `the board it covers (id ${schedule.scopeId}) is gone, or the schedule's owner can no longer read it`;
				log.warn(`Scheduled report "${schedule.name}" produced no report, so nothing was sent: ${why}`);
			}
		} catch (err) {
			// After the claim, the run has moved on (the review's O-N4).
			const after = claimed ? '. It is not sent again before its next run.' : '';
			log.error(`Failed to run scheduled report "${selected.name}"${after}`, err);
		}
	}
}

/** True while a run of `runDueReportSchedulesOnce` is going. */
let scheduleRunInFlight = false;

/**
 * One tick of the scheduler's timer: `runDueReportSchedules(now)`, unless the
 * last tick's run is still going. Returns false when it skipped the tick.
 *
 * A run can take longer than the minute between ticks: about 35 s for each
 * address a slow mail server holds up, and the PDF before that. A schedule's
 * next run used to be written only once its mail had gone, so a tick that
 * started while the last run was still sending found the same schedule due
 * and sent its report a second time. The claim (`claimScheduleRun`) now
 * closes that on its own, across processes too; the skip keeps one process
 * from running two ticks' work at once. A schedule that came due while the
 * run was going is still due at the next tick that runs. The `finally` clears
 * the flag when a run throws, so one failure does not stop the scheduler.
 */
export async function runDueReportSchedulesOnce(now: Date): Promise<boolean> {
	if (scheduleRunInFlight) return false;
	scheduleRunInFlight = true;
	try {
		await runDueReportSchedules(now);
		return true;
	} finally {
		scheduleRunInFlight = false;
	}
}

/**
 * Give every schedule with no next run its first one, enabled or not, or
 * switch it off if its next run cannot be worked out (decision 7). A next run
 * that cannot be read is none (the review's O-S1), so the rows are read in
 * full and picked out here: one read at start, of at most 20 an account.
 * Each in its own `try`, so
 * one row cannot stop the rest.
 */
function dateSchedulesWithNoNextRun(now: Date): void {
	const nowStr = stamp(now);
	const undated = db.select().from(reportSchedules).all().filter((schedule) => !hasReadableNextRun(schedule));
	for (const schedule of undated) {
		try {
			giveFirstRun(schedule, now, nowStr);
		} catch (err) {
			log.error(`Report schedule ${schedule.id} "${schedule.name}" could not be given its next run`, err);
		}
	}
}

/**
 * Date the schedules with no next run, then start the timer. Called as the
 * server starts (`startSchedulers`, from src/hooks.server.ts), outside any
 * `try`, so it never throws: one schedule whose time could not be read used
 * to stop the server starting with a `RangeError` (card 2144, decision 7).
 */
export function initReportScheduler(): void {
	if (reportTimer) {
		clearInterval(reportTimer);
	}

	try {
		dateSchedulesWithNoNextRun(new Date());
	} catch (err) {
		log.error('Report schedules with no next run could not be dated at start; the scheduler starts all the same', err);
	}

	reportTimer = setInterval(async () => {
		try {
			await runDueReportSchedulesOnce(new Date());
		} catch (err) {
			log.error('Report scheduler error', err);
		}
	}, 60_000);

	log.warn('Report scheduler initialized');
}
