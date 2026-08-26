/**
 * reports.ts — PDF report generation engine for DumpFire.
 *
 * Generates professional PDF reports for boards, board categories, or all boards.
 * Supports scheduled generation with email delivery.
 * PDFs are ephemeral — generated on demand, never stored in the DB.
 */

import PDFDocument from 'pdfkit';
import { db } from './db';
import {
	boards, columns, cards, cardAssignees, users, subtasks,
	boardCategories, reportSchedules
} from './db/schema';
import { eq, inArray, isNull, isNotNull, and } from 'drizzle-orm';
import { getAccessibleBoardIds, canViewBoard } from './board-access';
import { sendEmailWithAttachment } from './email';
import type { SessionUser } from './auth';
import { createLogger } from './logger';

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

/** Coerce an untrusted value (request body, DB column) to a valid filter, defaulting to 'all'. */
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

const DONE_COLUMN_TITLES = ['complete', 'done'];
const TODO_COLUMN_TITLES = ['to do', 'todo', 'to-do', 'backlog', 'inbox', 'not started', 'new', 'planned', 'ideas', 'idea', 'later'];

/**
 * Classify a column by its title. Anything that is neither a Done nor a To Do
 * column counts as In Progress — On Hold, Review, Testing, Blocked… have all
 * left To Do, so for reporting purposes the work has started.
 */
function classifyColumnTitle(title: string): CardStatus {
	const t = title.toLowerCase().trim();
	if (DONE_COLUMN_TITLES.includes(t)) return 'completed';
	if (TODO_COLUMN_TITLES.includes(t)) return 'todo';
	return 'in_progress';
}

function getDoneColumnIds(boardIds: number[]): Set<number> {
	if (boardIds.length === 0) return new Set();
	const allCols = db.select().from(columns)
		.where(inArray(columns.boardId, boardIds))
		.all();
	return new Set(
		allCols
			.filter(c => DONE_COLUMN_TITLES.includes(c.title.toLowerCase().trim()))
			.map(c => c.id)
	);
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

function formatDate(iso: string): string {
	if (!iso) return '—';
	const d = new Date(iso);
	return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
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
 * Recursively collect all sub-board IDs reachable from the given board IDs.
 * Walks the board → cards → sub-boards chain to any depth.
 */
function collectSubBoardIds(boardIds: number[]): number[] {
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
			.filter(id => !allIds.has(id));
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
	statusFilter: ReportStatusFilter = 'all'
): ReportData {
	if (boardIds.length === 0) {
		return {
			generatedAt: new Date().toISOString(),
			periodStart, periodEnd, scope, scopeName, statusFilter,
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

	const boardsInfo = db.select().from(boards).where(inArray(boards.id, boardIds)).all();
	const boardMap = new Map(boardsInfo.map(b => [b.id, b]));

	// Build parent board name prefix for sub-boards
	const parentNameMap = new Map<number, string>();
	for (const b of boardsInfo) {
		if (b.parentCardId) {
			const parentCard = db.select().from(cards).where(eq(cards.id, b.parentCardId)).get();
			if (parentCard) {
				const parentCol = db.select().from(columns).where(eq(columns.id, parentCard.columnId)).get();
				if (parentCol) {
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
	const completedCards = allCards.filter(c => doneColIds.has(c.columnId));
	const activeCards = allCards.filter(c => !doneColIds.has(c.columnId));

	const completedInPeriod = completedCards.filter(c => {
		const completedDate = c.completedAt || c.updatedAt;
		return completedDate >= periodStart && completedDate <= periodEnd;
	});

	const createdInPeriod = allCards.filter(c => c.createdAt >= periodStart && c.createdAt <= periodEnd);
	const overdueCards = activeCards.filter(c => c.dueDate && c.dueDate < now);

	// Split the open cards by where they sit on the board
	const statusOf = (c: typeof allCards[number]): CardStatus => columnMap.get(c.columnId)?.status ?? 'in_progress';
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
	for (const list of subtaskMap.values()) totalSubtasks += list.length;

	// Per-assignee stats
	const assigneeMap = new Map<number, { completedInPeriod: number; outstanding: number }>();
	for (const assignment of allAssignments) {
		if (!assigneeMap.has(assignment.userId)) {
			assigneeMap.set(assignment.userId, { completedInPeriod: 0, outstanding: 0 });
		}
		const card = allCards.find(c => c.id === assignment.cardId);
		if (!card) continue;
		const stats = assigneeMap.get(assignment.userId)!;
		if (doneColIds.has(card.columnId)) {
			const completedDate = card.completedAt || card.updatedAt;
			if (completedDate >= periodStart && completedDate <= periodEnd) {
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
		.sort((a, b) => (b.completedAt || b.updatedAt).localeCompare(a.completedAt || a.updatedAt))
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
		const boardCards = allCards.filter(c => {
			const colInfo = columnMap.get(c.columnId);
			return colInfo?.boardId === boardId;
		});
		const boardCompleted = boardCards.filter(c => doneColIds.has(c.columnId));
		const boardCompletedInPeriod = boardCompleted.filter(c => {
			const cd = c.completedAt || c.updatedAt;
			return cd >= periodStart && cd <= periodEnd;
		});
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
		summary: {
			totalCards: allCards.length,
			totalSubtasks,
			totalTasks: allCards.length + totalSubtasks,
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

export function generateBoardReport(
	boardId: number, periodStart: string, periodEnd: string, user: SessionUser,
	statusFilter: ReportStatusFilter = 'all'
): ReportData | null {
	if (!canViewBoard(user, boardId)) return null;
	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) return null;
	// Include all sub-boards recursively
	const allBoardIds = collectSubBoardIds([boardId]);
	return generateReportForBoards(allBoardIds, periodStart, periodEnd, board.name, 'board', statusFilter);
}

export function generateCategoryReport(
	categoryId: number, periodStart: string, periodEnd: string, user: SessionUser,
	statusFilter: ReportStatusFilter = 'all'
): ReportData | null {
	const cat = db.select().from(boardCategories).where(eq(boardCategories.id, categoryId)).get();
	if (!cat) return null;
	const accessibleIds = getAccessibleBoardIds(user);
	let catBoards = db.select().from(boards).where(eq(boards.categoryId, categoryId)).all();
	if (accessibleIds !== null) {
		catBoards = catBoards.filter(b => accessibleIds.includes(b.id));
	}
	if (catBoards.length === 0) return null;
	// Include all sub-boards recursively
	const allBoardIds = collectSubBoardIds(catBoards.map(b => b.id));
	return generateReportForBoards(allBoardIds, periodStart, periodEnd, cat.name, 'category', statusFilter);
}

export function generateAllBoardsReport(
	periodStart: string, periodEnd: string, user: SessionUser,
	statusFilter: ReportStatusFilter = 'all'
): ReportData | null {
	if (user.role !== 'admin' && user.role !== 'superadmin') return null;
	// Start from top-level boards only, then expand to include sub-boards
	const topLevelBoards = db.select().from(boards).where(isNull(boards.parentCardId)).all();
	const allBoardIds = collectSubBoardIds(topLevelBoards.map(b => b.id));
	return generateReportForBoards(allBoardIds, periodStart, periodEnd, 'All Boards', 'all', statusFilter);
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
const C = {
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

function stripTag(text: string): string {
	if (!text) return '';
	// AI bookkeeping tags never belong on a stakeholder document
	return text
		.replace(/\[Antigravity\]\s*/gi, '')
		.replace(/\[Claude\]\s*/gi, '')
		.replace(/\[AI\]\s*/gi, '')
		.trim();
}

function drawSectionTitle(doc: PDFKit.PDFDocument, title: string, x: number, y: number): number {
	doc.font('Helvetica-Bold').fontSize(12).fillColor(C.heading)
		.text(title, x, y);
	y += 18;
	doc.rect(x, y, 40, 2).fill(C.accent);
	return y + 10;
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number, y: number): number {
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
 * When detailLevel is 'summary', only the main table rows are drawn (no detail sub-rows).
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
		const hasDetails = detailLevel === 'detailed' && (task.description || task.businessValue || task.subtasks.length > 0);

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
			if (task.description) {
				const desc = stripTag(task.description);
				detailH += doc.heightOfString(desc, { width: detailW - 10 }) + 6;
			}
			if (task.businessValue) {
				const bv = stripTag(task.businessValue);
				detailH += 12; // "BUSINESS VALUE" label
				detailH += doc.heightOfString(bv, { width: detailW - 10 }) + 6;
			}
			if (task.subtasks.length > 0) {
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
			if (task.description) {
				const desc = stripTag(task.description);
				doc.font('Helvetica').fontSize(7.5).fillColor(C.textMuted)
					.text(desc, detailX, dy, { width: detailW - 10 });
				dy = (doc as any).y + 6;
			}

			// Business Value
			if (task.businessValue) {
				const bv = stripTag(task.businessValue);
				doc.font('Helvetica-Bold').fontSize(6.5).fillColor(C.accent)
					.text('BUSINESS VALUE', detailX, dy, { width: detailW - 10 });
				dy = (doc as any).y + 2;
				doc.font('Helvetica').fontSize(7).fillColor('#4338ca')
					.text(bv, detailX, dy, { width: detailW - 10 });
				dy = (doc as any).y + 6;
			}

			// Subtasks
			if (task.subtasks.length > 0) {
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
			Title: `DumpFire Report - ${data.scopeName}`,
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
	const filterLabel = data.statusFilter !== 'all' ? `  ·  ${REPORT_STATUS_FILTER_LABELS[data.statusFilter]}` : '';
	doc.font('Helvetica-Bold').fontSize(18).fillColor(C.headerText)
		.text('DumpFire Report', mx, 14, { width: pw });
	doc.font('Helvetica-Bold').fontSize(11).fillColor(C.accentLight)
		.text(`${data.scopeName}  ·  ${modeLabel}${filterLabel}`, mx, 34, { width: pw });
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

// ─── Report Scheduler ────────────────────────────────────────────────────────

let reportTimer: ReturnType<typeof setInterval> | null = null;

function computeNextRunAt(schedule: typeof reportSchedules.$inferSelect): string {
	const now = new Date();
	const [h, m] = (schedule.timeOfDay || '09:00').split(':').map(Number);

	if (schedule.frequency === 'weekly') {
		const target = new Date(now);
		target.setHours(h, m, 0, 0);
		const dayDiff = (schedule.dayOfWeek - target.getDay() + 7) % 7;
		target.setDate(target.getDate() + (dayDiff === 0 && target <= now ? 7 : dayDiff));
		return target.toISOString();
	}

	const target = new Date(now);
	target.setHours(h, m, 0, 0);
	target.setDate(Math.min(schedule.dayOfMonth, 28));
	if (target <= now) {
		target.setMonth(target.getMonth() + 1);
	}
	return target.toISOString();
}

function getPeriodForSchedule(schedule: typeof reportSchedules.$inferSelect, now: Date): { start: string; end: string } {
	const end = now.toISOString();
	const start = new Date(now);
	start.setDate(start.getDate() - (schedule.periodDays || 7));
	return { start: start.toISOString(), end };
}

async function checkAndRunScheduledReports(): Promise<void> {
	const now = new Date();
	const nowStr = now.toISOString();

	const activeSchedules = db.select().from(reportSchedules)
		.where(eq(reportSchedules.enabled, true))
		.all();

	for (const schedule of activeSchedules) {
		if (schedule.nextRunAt && schedule.nextRunAt > nowStr) continue;

		try {
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
				const periodLabel = `${formatDate(start)} - ${formatDate(end)}`;

				const recipients = (schedule.recipients || '')
					.split(',')
					.map(e => e.trim())
					.filter(e => e.length > 0);

				if (recipients.length > 0) {
					for (const email of recipients) {
						try {
							await sendEmailWithAttachment(
								email,
								`DumpFire Report: ${reportName}`,
								`<h2>DumpFire Report</h2>
								<p><strong>${reportName}</strong></p>
								<p>Period: ${periodLabel}</p>
								<p>Please find the attached PDF report.</p>
								<p style="color: #8b8fa3; font-size: 12px;">— DumpFire Automated Reports</p>`,
								{
									filename: `dumpfire-report-${reportData.scopeName.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().split('T')[0]}.pdf`,
									content: pdfBuffer,
									contentType: 'application/pdf'
								}
							);
						} catch (emailErr) {
							log.error(`Failed to email report to ${email}`, emailErr);
						}
					}
					log.warn(`Scheduled report emailed: "${schedule.name}" to ${recipients.length} recipient(s)`);
				} else {
					log.warn(`Scheduled report generated but no recipients configured: "${schedule.name}"`);
				}
			}

			const nextRun = computeNextRunAt(schedule);
			db.update(reportSchedules)
				.set({ lastRunAt: nowStr, nextRunAt: nextRun, updatedAt: nowStr })
				.where(eq(reportSchedules.id, schedule.id))
				.run();

		} catch (err) {
			log.error(`Failed to run scheduled report "${schedule.name}"`, err);
		}
	}
}

export function initReportScheduler(): void {
	if (reportTimer) {
		clearInterval(reportTimer);
	}

	const uninitialised = db.select().from(reportSchedules)
		.where(isNull(reportSchedules.nextRunAt))
		.all();
	for (const schedule of uninitialised) {
		const nextRun = computeNextRunAt(schedule);
		db.update(reportSchedules)
			.set({ nextRunAt: nextRun })
			.where(eq(reportSchedules.id, schedule.id))
			.run();
	}

	reportTimer = setInterval(async () => {
		try {
			await checkAndRunScheduledReports();
		} catch (err) {
			log.error('Report scheduler error', err);
		}
	}, 60_000);

	log.warn('Report scheduler initialized');
}
