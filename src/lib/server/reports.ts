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
import { eq, inArray, isNull, and } from 'drizzle-orm';
import { getAccessibleBoardIds, canViewBoard } from './board-access';
import { sendEmailWithAttachment } from './email';
import type { SessionUser } from './auth';
import { createLogger } from './logger';

const log = createLogger('REPORTS');

// ─── Types ───────────────────────────────────────────────────────────────────

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

	summary: {
		totalTasks: number;
		completedInPeriod: number;
		createdInPeriod: number;
		outstanding: number;
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
		categoryName: string;
		categoryColor: string;
		totalCards: number;
		completedCards: number;
		completedInPeriod: number;
	}[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getDoneColumnIds(boardIds: number[]): Set<number> {
	if (boardIds.length === 0) return new Set();
	const allCols = db.select().from(columns)
		.where(inArray(columns.boardId, boardIds))
		.all();
	return new Set(
		allCols
			.filter(c => ['complete', 'done'].includes(c.title.toLowerCase().trim()))
			.map(c => c.id)
	);
}

function getColumnMap(boardIds: number[]): Map<number, { title: string; boardId: number }> {
	if (boardIds.length === 0) return new Map();
	const allCols = db.select().from(columns)
		.where(inArray(columns.boardId, boardIds))
		.all();
	const map = new Map<number, { title: string; boardId: number }>();
	for (const col of allCols) {
		map.set(col.id, { title: col.title, boardId: col.boardId });
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

// ─── Core Generator ──────────────────────────────────────────────────────────

function generateReportForBoards(
	boardIds: number[],
	periodStart: string,
	periodEnd: string,
	scopeName: string,
	scope: 'board' | 'category' | 'all'
): ReportData {
	if (boardIds.length === 0) {
		return {
			generatedAt: new Date().toISOString(),
			periodStart, periodEnd, scope, scopeName,
			summary: { totalTasks: 0, completedInPeriod: 0, createdInPeriod: 0, outstanding: 0, overdue: 0 },
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

	const priorityBreakdown = { critical: 0, high: 0, medium: 0, low: 0 };
	for (const c of activeCards) {
		const p = c.priority as keyof typeof priorityBreakdown;
		if (p in priorityBreakdown) priorityBreakdown[p]++;
	}

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

	// Outstanding tasks grouped by board
	const outstandingByBoard = new Map<number, typeof activeCards>();
	for (const card of activeCards) {
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

	// Completed tasks in period
	const completedTasksList = completedInPeriod
		.sort((a, b) => (b.completedAt || b.updatedAt).localeCompare(a.completedAt || a.updatedAt))
		.map(c => {
			const colInfo = columnMap.get(c.columnId);
			const b = colInfo ? boardMap.get(colInfo.boardId) : null;
			const cardAssigns = allAssignments.filter(a => a.cardId === c.id);
			return {
				id: c.id,
				title: c.title,
				priority: c.priority,
				completedAt: c.completedAt || c.updatedAt,
				boardName: b?.name || 'Unknown',
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
			...catInfo,
			totalCards: boardCards.length,
			completedCards: boardCompleted.length,
			completedInPeriod: boardCompletedInPeriod.length
		};
	}).filter(b => b.totalCards > 0);

	return {
		generatedAt: new Date().toISOString(),
		periodStart, periodEnd, scope, scopeName,
		summary: {
			totalTasks: allCards.length,
			completedInPeriod: completedInPeriod.length,
			createdInPeriod: createdInPeriod.length,
			outstanding: activeCards.length,
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
	boardId: number, periodStart: string, periodEnd: string, user: SessionUser
): ReportData | null {
	if (!canViewBoard(user, boardId)) return null;
	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) return null;
	return generateReportForBoards([boardId], periodStart, periodEnd, board.name, 'board');
}

export function generateCategoryReport(
	categoryId: number, periodStart: string, periodEnd: string, user: SessionUser
): ReportData | null {
	const cat = db.select().from(boardCategories).where(eq(boardCategories.id, categoryId)).get();
	if (!cat) return null;
	const accessibleIds = getAccessibleBoardIds(user);
	let catBoards = db.select().from(boards).where(eq(boards.categoryId, categoryId)).all();
	if (accessibleIds !== null) {
		catBoards = catBoards.filter(b => accessibleIds.includes(b.id));
	}
	if (catBoards.length === 0) return null;
	return generateReportForBoards(catBoards.map(b => b.id), periodStart, periodEnd, cat.name, 'category');
}

export function generateAllBoardsReport(
	periodStart: string, periodEnd: string, user: SessionUser
): ReportData | null {
	if (user.role !== 'admin' && user.role !== 'superadmin') return null;
	const allBoards = db.select().from(boards).all();
	return generateReportForBoards(allBoards.map(b => b.id), periodStart, periodEnd, 'All Boards', 'all');
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

		summary: {
			totalTasks: 1,
			completedInPeriod: card.completedAt ? 1 : 0,
			createdInPeriod: 1,
			outstanding: card.completedAt ? 0 : 1,
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
	return text
		.replace(/\[Antigravity\]\s*/gi, '')
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
 */
function drawTasksWithDetails(
	doc: PDFKit.PDFDocument,
	tasks: TaskDetail[],
	columns: { header: string; width: number; getter: (t: TaskDetail) => string }[],
	startX: number,
	startY: number,
	tableWidth: number
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
		const hasDetails = task.description || task.businessValue || task.subtasks.length > 0;

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
				const truncDesc = desc.length > 800 ? desc.slice(0, 800) + '...' : desc;
				detailH += doc.heightOfString(truncDesc, { width: detailW - 10 }) + 6;
			}
			if (task.businessValue) {
				const bv = stripTag(task.businessValue);
				const truncBv = bv.length > 500 ? bv.slice(0, 500) + '...' : bv;
				detailH += 12; // "BUSINESS VALUE" label
				detailH += doc.heightOfString(truncBv, { width: detailW - 10 }) + 6;
			}
			if (task.subtasks.length > 0) {
				detailH += 12; // "Subtasks" heading
				for (const st of task.subtasks) {
					detailH += doc.heightOfString(stripTag(st.title), { width: detailW - 30 }) + 3;
					const stDesc = stripTag(st.description);
					if (stDesc) {
						doc.font('Helvetica').fontSize(7);
						const truncStDesc = stDesc.length > 500 ? stDesc.slice(0, 500) + '...' : stDesc;
						detailH += doc.heightOfString(truncStDesc, { width: detailW - 30 }) + 3;
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
				const truncDesc = desc.length > 800 ? desc.slice(0, 800) + '...' : desc;
				doc.font('Helvetica').fontSize(7.5).fillColor(C.textMuted)
					.text(truncDesc, detailX, dy, { width: detailW - 10 });
				dy = (doc as any).y + 6;
			}

			// Business Value
			if (task.businessValue) {
				const bv = stripTag(task.businessValue);
				const truncBv = bv.length > 500 ? bv.slice(0, 500) + '...' : bv;
				doc.font('Helvetica-Bold').fontSize(6.5).fillColor(C.accent)
					.text('BUSINESS VALUE', detailX, dy, { width: detailW - 10 });
				dy = (doc as any).y + 2;
				doc.font('Helvetica').fontSize(7).fillColor('#4338ca')
					.text(truncBv, detailX, dy, { width: detailW - 10 });
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
						const truncStDesc = stDesc.length > 500 ? stDesc.slice(0, 500) + '...' : stDesc;
						doc.font('Helvetica-Oblique').fontSize(7).fillColor(C.textLight)
							.text(truncStDesc, detailX + 12, dy, { width: detailW - 30 });
						dy = (doc as any).y + 2;
					}
				}
			}

			y += detailH;
		}
	}

	return y;
}

export async function generateReportPdf(data: ReportData): Promise<Buffer> {
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
	doc.font('Helvetica-Bold').fontSize(18).fillColor(C.headerText)
		.text('DumpFire Report', mx, 14, { width: pw });
	doc.font('Helvetica-Bold').fontSize(11).fillColor(C.accentLight)
		.text(data.scopeName, mx, 34, { width: pw });
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
	const metrics = [
		{ label: 'Total Tasks', value: data.summary.totalTasks, bg: C.accentLight, fg: C.accent },
		{ label: 'Completed', value: data.summary.completedInPeriod, bg: C.emeraldLight, fg: C.emerald },
		{ label: 'Created', value: data.summary.createdInPeriod, bg: C.blueLight, fg: C.blue },
		{ label: 'Outstanding', value: data.summary.outstanding, bg: C.amberLight, fg: C.amber },
		{ label: 'Overdue', value: data.summary.overdue, bg: C.redLight, fg: C.red }
	];

	const cardW = (pw - 4 * 10) / 5;
	for (let i = 0; i < metrics.length; i++) {
		const m = metrics[i];
		const cx = mx + i * (cardW + 10);
		doc.roundedRect(cx, y, cardW, 44, 4).fill(m.bg);
		doc.font('Helvetica-Bold').fontSize(20).fillColor(m.fg)
			.text(String(m.value), cx, y + 6, { width: cardW, align: 'center' });
		doc.font('Helvetica').fontSize(6).fillColor(m.fg)
			.text(m.label.toUpperCase(), cx, y + 30, { width: cardW, align: 'center' });
	}
	y += 60;


	// ─── Priority Breakdown ──────────────────────────────────────────────
	if (data.summary.outstanding > 0) {
		y = drawSectionTitle(doc, 'Priority Distribution', mx, y);
		const total = data.summary.outstanding;
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
		const headers = ['Board', 'Total', 'Completed', 'In Period', 'Remaining'];
		const widths = [pw * 0.36, pw * 0.16, pw * 0.16, pw * 0.16, pw * 0.16];
		const rows = data.boardBreakdown.map(b => [
			b.boardName,
			String(b.totalCards),
			String(b.completedCards),
			String(b.completedInPeriod),
			String(b.totalCards - b.completedCards)
		]);
		y = drawTable(doc, headers, rows, widths, mx, y);
		y += 14;
	}

	// ─── Outstanding Tasks (grouped by category) ────────────────────────
	if (data.outstandingTasks.length > 0) {
		// Group boards by category for multi-board reports
		const byCategory = new Map<string, typeof data.outstandingTasks>();
		for (const group of data.outstandingTasks) {
			const key = group.categoryName || 'Uncategorised';
			if (!byCategory.has(key)) byCategory.set(key, []);
			byCategory.get(key)!.push(group);
		}

		const isMultiBoard = data.scope === 'all' || data.scope === 'category';

		for (const [catName, groups] of byCategory) {
			// Category header (only for multi-board reports)
			if (isMultiBoard && byCategory.size > 1) {
				y = ensureSpace(doc, 28, y);
				const catColor = groups[0]?.categoryColor || '#94a3b8';
				// Subtle category divider: thin left accent + muted label
				doc.rect(mx, y + 2, pw, 0.5).fill(C.borderLight);
				doc.rect(mx, y + 6, 3, 12).fill(catColor);
				doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.textMuted)
					.text(catName.toUpperCase(), mx + 10, y + 7, { width: pw - 20, lineBreak: false });
				y += 24;
			}

			for (let gi = 0; gi < groups.length; gi++) {
				const group = groups[gi];
				y = ensureSpace(doc, 60, y);
				y = drawSectionTitle(doc, `Outstanding - ${group.boardName}`, mx, y);
				y = drawTasksWithDetails(doc, group.tasks, [
					{ header: 'Title', width: pw * 0.32, getter: t => stripTag(t.title) },
					{ header: 'Column', width: pw * 0.15, getter: t => t.columnTitle },
					{ header: 'Priority', width: pw * 0.13, getter: t => t.priority.charAt(0).toUpperCase() + t.priority.slice(1) },
					{ header: 'Due Date', width: pw * 0.20, getter: t => t.dueDate ? formatDate(t.dueDate) : '—' },
					{ header: 'Assignees', width: pw * 0.20, getter: t => t.assignees.join(', ') || '—' }
				], mx, y, pw);
			}
		}
	}

	// ─── Completed Tasks (unified) ───────────────────────────────────────
	if (data.completedTasks.length > 0) {
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
		], mx, y, pw);
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

			let reportData: ReportData | null = null;
			if (schedule.scope === 'board' && schedule.scopeId) {
				reportData = generateBoardReport(schedule.scopeId, start, end, sessionUser);
			} else if (schedule.scope === 'category' && schedule.scopeId) {
				reportData = generateCategoryReport(schedule.scopeId, start, end, sessionUser);
			} else if (schedule.scope === 'all') {
				reportData = generateAllBoardsReport(start, end, sessionUser);
			}

			if (reportData) {
				const pdfBuffer = await generateReportPdf(reportData);
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
