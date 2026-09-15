/**
 * activity-report — everything a management activity report needs, in one call.
 *
 * The report this replaces was built by hand: 229 API calls, roughly 18 minutes
 * of extraction, and 196 hand-written plain-English summaries because card
 * titles are written for engineers. Worse than the time, it was unverifiable —
 * nobody reading the finished document could check a single figure in it without
 * repeating the whole exercise.
 *
 * Three decisions shape what follows.
 *
 * **Completion is decided by `completedAt`, never by audit events.** The audit
 * log was not a complete record when this was written — everything done in the
 * web UI went unrecorded, and 42 of 145 completions in one 30-day window had no
 * event at all. That is fixed now, but a report that depends on the fix would
 * silently under-count for every window that predates it. The card's own
 * completion date is the fact; the log is corroboration.
 *
 * **"Completed" and "delivered" are not the same thing.** Delivered, not needed,
 * superseded and parked all land in a Complete column and are indistinguishable
 * once there, so a raw completion count overstates what was built. `closeReason`
 * separates them, and cards that never recorded one are counted as delivered but
 * flagged, so the overstatement is visible rather than assumed away.
 *
 * **Nothing is inferred to fill a gap.** A card with no `summary` reports with a
 * null summary and its technical title, not a generated paraphrase. This text
 * goes to senior management under someone's name; a plausible invention is worse
 * than an obvious blank.
 */

import { sqlite } from './db';
import { canViewBoard } from './board-access';
import { isCompleteColumnTitle, isHoldColumnTitle } from './card-completion';
import { readSource } from './logActivity';
import type { SessionUser } from './auth';

/**
 * Which bucket a card falls into for the window.
 *
 * `closed` exists to keep work that was investigated and dropped out of the
 * headline delivery figure without hiding that the effort happened.
 */
export type ActivityBucket = 'completed' | 'closed' | 'progressed' | 'on hold' | 'created';

export interface ReportCard {
	id: number;
	title: string;
	/** Plain English, written for the report. Null when not recorded. */
	summary: string | null;
	businessValue: string | null;
	theme: string | null;
	customerImpact: string | null;
	closeReason: string | null;
	releaseState: string | null;
	bucket: ActivityBucket;
	priority: string;
	columnTitle: string;
	boardId: number;
	createdAt: string;
	createdBy: number | null;
	createdByName: string | null;
	completedAt: string | null;
	milestoneId: number | null;
	milestoneName: string | null;
	subtasks: { total: number; completed: number; items?: { id: number; title: string; completed: boolean }[] };
	comments?: { id: number; content: string; createdAt: string; username: string }[];
	/**
	 * True when the card completed in the window without a `closeReason`, so it
	 * is counted as delivered on an assumption rather than a record.
	 */
	closeReasonAssumed: boolean;
}

export interface ReportBoard {
	boardId: number;
	name: string;
	emoji: string | null;
	parentCardId: number | null;
	totals: Record<ActivityBucket, number>;
	cards: ReportCard[];
}

export interface ReportMilestone {
	id: number;
	name: string;
	boardId: number | null;
	targetDate: string | null;
	status: string;
	totalCards: number;
	completedAtStart: number;
	completedAtEnd: number;
	percentAtStart: number;
	percentAtEnd: number;
	/**
	 * Whether a schedule judgement is even possible. Every milestone had a null
	 * target date when this was written, so a report could show progress but
	 * never "on track" or "at risk" — saying so is more use than omitting it.
	 */
	hasTargetDate: boolean;
}

export interface ActivityReport {
	period: { from: string; to: string; days: number };
	user: { id: number; username: string; emoji: string | null } | null;
	totals: Record<ActivityBucket, number> & { boards: number; cards: number };
	boards: ReportBoard[];
	milestones: ReportMilestone[];
	meta: {
		generatedAt: string;
		/** What decided the completed bucket. Stated so a reader can check it. */
		completionBasis: 'completedAt';
		/** How a card was attributed to a person, in words, because it is an approximation. */
		attribution: string;
		/** Cards counted as delivered with no recorded closeReason. */
		closeReasonAssumedCount: number;
		/** Cards in the report with no recorded summary, so the appendix uses their title. */
		missingSummaryCount: number;
		/**
		 * Cards sitting in a Complete column that did not complete in this window
		 * — finished earlier, or never dated. They appear as `progressed` because
		 * the window touched them, and are counted here so the gap between "is
		 * complete" and "completed in this period" is stated rather than inferred.
		 */
		completedOutsideWindow: number;
		boardsExcludedForAccess: number;
	};
}

export interface ActivityReportOptions {
	/** Who is asking. Boards they cannot view are excluded from the report. */
	actor: SessionUser;
	/** Whose activity to report on. Null reports on everyone. */
	userId?: number | null;
	from: string;
	to: string;
	boardIds?: number[] | null;
	includeSubtasks?: boolean;
	includeComments?: boolean;
	commentLimit?: number;
}

/**
 * Timestamps in this database come in two shapes and are compared as strings.
 *
 * SQLite's `datetime('now')` default writes `2026-04-09 13:53:46`, while
 * anything set from JavaScript writes `2026-04-09T13:54:01.210Z`. Both are UTC,
 * but they do not sort against each other: a space (0x20) sorts before `T`
 * (0x54), so `'2026-09-14 09:00:00' < '2026-09-14T00:00:00.000Z'` is *true* and
 * a window boundary silently includes or excludes the wrong day's work.
 *
 * `cards.created_at`, `activity_log.created_at` and `card_comments.created_at`
 * are the space form; `cards.completed_at` and `cards.updated_at` are the ISO
 * form — so a single report query hits both. Everything is therefore trimmed to
 * `YYYY-MM-DD HH:MM:SS` on both sides before any comparison. Sub-second
 * precision is dropped, which is immaterial for a report bucketed by day.
 */
const TS = (col: string) => `replace(substr(${col}, 1, 19), 'T', ' ')`;

/** The same normalisation in JavaScript, for comparisons done after the query. */
function tsKey(ts: string): string {
	return ts.slice(0, 19).replace('T', ' ');
}

/**
 * A window bound as a comparable key.
 *
 * A bare date as the upper bound means the whole of that day: a report for
 * "15 August to 14 September" that stopped at midnight on the 14th would drop a
 * full day of work, which is exactly the sort of quiet omission this replaces.
 */
function boundKey(value: string, end: boolean): string {
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value} ${end ? '23:59:59' : '00:00:00'}`;
	return tsKey(value);
}

const EMPTY_TOTALS = (): Record<ActivityBucket, number> => ({
	completed: 0,
	closed: 0,
	progressed: 0,
	'on hold': 0,
	created: 0
});

/** Close reasons that mean nothing was built. Kept out of the delivery figure. */
const NOT_BUILT = new Set(['not needed', 'superseded']);

interface CardRow {
	id: number;
	title: string;
	summary: string | null;
	businessValue: string | null;
	theme: string | null;
	customerImpact: string | null;
	closeReason: string | null;
	releaseState: string | null;
	priority: string;
	columnTitle: string;
	/** Where this column sits on its board, and where the board's first column sits. */
	columnPosition: number;
	firstColumnPosition: number;
	boardId: number;
	boardName: string;
	boardEmoji: string | null;
	parentCardId: number | null;
	createdAt: string;
	createdBy: number | null;
	createdByName: string | null;
	completedAt: string | null;
	updatedAt: string;
	milestoneId: number | null;
	milestoneName: string | null;
	onHoldNote: string | null;
	subtaskTotal: number;
	subtaskDone: number;
	/** Any signal at all that this card moved in the window. */
	touchedInWindow: number;
}

/**
 * Build the report.
 *
 * One query gathers every candidate card with its board, column, author,
 * milestone and subtask counts; the buckets are then decided in TypeScript,
 * where the rules can be read. Pushing the bucketing into SQL would save
 * nothing measurable and hide the part most likely to need arguing about.
 */
export function buildActivityReport(opts: ActivityReportOptions): ActivityReport {
	const {
		actor,
		userId = null,
		from,
		to,
		boardIds = null,
		includeSubtasks = false,
		includeComments = false,
		commentLimit = 3
	} = opts;

	const fromBound = boundKey(from, false);
	const toBound = boundKey(to, true);

	// A card is in the window if anything about it moved: it completed, it was
	// raised, it was edited, someone logged an action against it, or someone
	// commented. The union matters — relying on the audit log alone is what made
	// the hand-built report miss 30% of completions.
	const touched = `(
		   (c.completed_at IS NOT NULL AND ${TS('c.completed_at')} BETWEEN @from AND @to)
		OR (${TS('c.created_at')} BETWEEN @from AND @to)
		OR (${TS('c.updated_at')} BETWEEN @from AND @to)
		OR EXISTS (SELECT 1 FROM activity_log al
		            WHERE al.card_id = c.id AND ${TS('al.created_at')} BETWEEN @from AND @to)
		OR EXISTS (SELECT 1 FROM card_comments cc
		            WHERE cc.card_id = c.id AND ${TS('cc.created_at')} BETWEEN @from AND @to)
	)`;

	// Attribution to a person. Deliberately broad and deliberately documented:
	// an audit entry by them, a comment by them, they raised it, or they are
	// assigned to it. Assignment is a *current* fact used as a proxy for a
	// historic one — that approximation is reported in `meta.attribution`
	// rather than left for a reader to discover.
	const byUser = userId
		? `AND (
			   EXISTS (SELECT 1 FROM activity_log al2
			            WHERE al2.card_id = c.id AND al2.user_id = @userId
			              AND ${TS('al2.created_at')} BETWEEN @from AND @to)
			OR EXISTS (SELECT 1 FROM card_comments cc2
			            WHERE cc2.card_id = c.id AND cc2.user_id = @userId
			              AND ${TS('cc2.created_at')} BETWEEN @from AND @to)
			OR EXISTS (SELECT 1 FROM card_assignees ca
			            WHERE ca.card_id = c.id AND ca.user_id = @userId)
			OR c.created_by = @userId
		)`
		: '';

	const boardFilter =
		boardIds && boardIds.length > 0
			? `AND col.board_id IN (${boardIds.map((b) => Number(b)).join(',')})`
			: '';

	const rows = sqlite
		.prepare(
			`
		SELECT
			c.id                AS id,
			c.title             AS title,
			c.summary           AS summary,
			c.business_value    AS businessValue,
			c.theme             AS theme,
			c.customer_impact   AS customerImpact,
			c.close_reason      AS closeReason,
			c.release_state     AS releaseState,
			c.priority          AS priority,
			c.on_hold_note      AS onHoldNote,
			col.title           AS columnTitle,
			col.position        AS columnPosition,
			(SELECT MIN(c2.position) FROM columns c2 WHERE c2.board_id = col.board_id) AS firstColumnPosition,
			col.board_id        AS boardId,
			b.name              AS boardName,
			b.emoji             AS boardEmoji,
			b.parent_card_id    AS parentCardId,
			c.created_at        AS createdAt,
			c.created_by        AS createdBy,
			u.username          AS createdByName,
			c.completed_at      AS completedAt,
			c.updated_at        AS updatedAt,
			c.milestone_id      AS milestoneId,
			m.name              AS milestoneName,
			(SELECT COUNT(*) FROM subtasks s WHERE s.card_id = c.id)                    AS subtaskTotal,
			(SELECT COUNT(*) FROM subtasks s WHERE s.card_id = c.id AND s.completed = 1) AS subtaskDone,
			1 AS touchedInWindow
		FROM cards c
		JOIN columns col ON col.id = c.column_id
		JOIN boards  b   ON b.id  = col.board_id
		LEFT JOIN users      u ON u.id = c.created_by
		LEFT JOIN milestones m ON m.id = c.milestone_id
		WHERE c.archived_at IS NULL
		  AND ${touched}
		  ${byUser}
		  ${boardFilter}
		ORDER BY col.board_id, c.id
	`
		)
		.all({ from: fromBound, to: toBound, userId }) as CardRow[];

	// Access is filtered after the query rather than inside it: board visibility
	// is a function, not a SQL predicate, and a report that silently included a
	// board the reader cannot open would leak card titles.
	const excludedBoards = new Set<number>();
	const visible = rows.filter((r) => {
		if (canViewBoard(actor, r.boardId)) return true;
		excludedBoards.add(r.boardId);
		return false;
	});

	const boardMap = new Map<number, ReportBoard>();
	const totals = { ...EMPTY_TOTALS(), boards: 0, cards: 0 };
	let closeReasonAssumedCount = 0;
	let missingSummaryCount = 0;
	let completedOutsideWindow = 0;

	for (const r of visible) {
		const bucket = bucketOf(r, fromBound, toBound);

		const completedInWindow =
			!!r.completedAt && tsKey(r.completedAt) >= fromBound && tsKey(r.completedAt) <= toBound;
		const closeReasonAssumed = completedInWindow && !r.closeReason;
		if (closeReasonAssumed) closeReasonAssumedCount++;
		if (!r.summary) missingSummaryCount++;
		if (!completedInWindow && isCompleteColumnTitle(r.columnTitle)) completedOutsideWindow++;

		const card: ReportCard = {
			id: r.id,
			title: r.title,
			summary: r.summary,
			businessValue: r.businessValue || null,
			theme: r.theme,
			customerImpact: r.customerImpact,
			closeReason: r.closeReason,
			releaseState: r.releaseState,
			bucket,
			priority: r.priority,
			columnTitle: r.columnTitle,
			boardId: r.boardId,
			createdAt: r.createdAt,
			createdBy: r.createdBy,
			createdByName: r.createdByName,
			completedAt: r.completedAt,
			milestoneId: r.milestoneId,
			milestoneName: r.milestoneName,
			subtasks: { total: Number(r.subtaskTotal), completed: Number(r.subtaskDone) },
			closeReasonAssumed
		};

		if (includeSubtasks && Number(r.subtaskTotal) > 0) {
			card.subtasks.items = sqlite
				.prepare(
					'SELECT id, title, completed FROM subtasks WHERE card_id = ? ORDER BY position, id'
				)
				.all(r.id)
				.map((s: any) => ({ id: s.id, title: s.title, completed: !!s.completed }));
		}

		if (includeComments && commentLimit > 0) {
			card.comments = sqlite
				.prepare(
					`SELECT cc.id, cc.content, cc.created_at AS createdAt, u.username
					 FROM card_comments cc JOIN users u ON u.id = cc.user_id
					 WHERE cc.card_id = ? ORDER BY cc.created_at DESC LIMIT ?`
				)
				.all(r.id, commentLimit) as ReportCard['comments'];
		}

		let board = boardMap.get(r.boardId);
		if (!board) {
			board = {
				boardId: r.boardId,
				name: r.boardName,
				emoji: r.boardEmoji,
				parentCardId: r.parentCardId,
				totals: EMPTY_TOTALS(),
				cards: []
			};
			boardMap.set(r.boardId, board);
		}
		board.cards.push(card);
		board.totals[bucket]++;
		totals[bucket]++;
		totals.cards++;
	}

	// Largest boards first: a report opens with where the effort actually went,
	// not with whichever board has the lowest id.
	const boardList = [...boardMap.values()].sort(
		(a, b) =>
			b.totals.completed + b.totals.closed - (a.totals.completed + a.totals.closed) ||
			b.cards.length - a.cards.length
	);
	totals.boards = boardList.length;

	const cardIds = visible.map((r) => r.id);

	return {
		period: { from: fromBound, to: toBound, days: daysBetween(fromBound, toBound) },
		user: userId ? lookupUser(userId) : null,
		totals,
		boards: boardList,
		milestones: milestonesInWindow(cardIds, fromBound, toBound),
		meta: {
			generatedAt: new Date().toISOString(),
			completionBasis: 'completedAt',
			attribution: userId
				? 'Cards where this user logged an action or commented in the window, raised the card, or is currently assigned to it. Current assignment stands in for historic assignment, which is not recorded.'
				: 'All users.',
			closeReasonAssumedCount,
			missingSummaryCount,
			completedOutsideWindow,
			boardsExcludedForAccess: excludedBoards.size
		}
	};
}

/**
 * Which bucket a card belongs in.
 *
 * Order matters. Completion wins over everything — a card that was worked on and
 * then finished in the same window is a completion, not progress. On hold is
 * checked before progress so paused work is never counted as moving.
 */
function bucketOf(r: CardRow, from: string, to: string): ActivityBucket {
	const completedInWindow =
		!!r.completedAt && tsKey(r.completedAt) >= from && tsKey(r.completedAt) <= to;

	if (completedInWindow) {
		// Closed after investigation with nothing built. Kept visible, kept out
		// of the delivery figure.
		if (r.closeReason && NOT_BUILT.has(r.closeReason.toLowerCase())) return 'closed';
		return 'completed';
	}

	if (isHoldColumnTitle(r.columnTitle) || (r.onHoldNote ?? '').trim() !== '') return 'on hold';

	// Raised in the window and nothing has happened to it since.
	//
	// Two signals have to agree, because neither is sufficient on its own:
	//
	// `updatedAt` alone is not enough. Dragging a card between columns did not
	// stamp it (fixed, but every card moved before that fix still carries the
	// creation timestamp), so a card actively being worked on can still look
	// untouched. Checked against a hand-built report, that put 20 in-flight cards
	// in the "to do" bucket and reported one finished card as not started.
	//
	// The column alone is not enough either, because a card genuinely raised and
	// left alone sits in the first column exactly as a card moved back there does.
	//
	// So: untouched *and* still where it was raised. `columnPosition` is the
	// board's first column, which is where new cards land; anything further along
	// has been moved by somebody, whatever the timestamps say.
	const raisedInWindow = tsKey(r.createdAt) >= from && tsKey(r.createdAt) <= to;
	const neverMoved = r.columnPosition === r.firstColumnPosition;
	if (raisedInWindow && tsKey(r.updatedAt) === tsKey(r.createdAt) && neverMoved) return 'created';

	// Sitting in a Complete column is deliberately NOT enough to count as a
	// completion. A card finished in May that picked up one comment in September
	// would otherwise be counted among September's deliveries — the precise way a
	// completion figure gets overstated, which is what this report exists to
	// stop. It had activity in the window, so it is reported; the window just did
	// not complete it. `meta.completedOutsideWindow` counts these so the
	// difference between "in Complete" and "completed here" stays visible.
	return 'progressed';
}

/**
 * Milestones whose progress changed during the window.
 *
 * Progress at a point in time is counted from `completedAt`, the same basis as
 * everything else, so the two figures in a report cannot disagree. Membership
 * is current membership — a card's milestone history is not recorded, so a card
 * moved into a goal mid-window counts for the whole of it. Stated here rather
 * than quietly assumed.
 */
function milestonesInWindow(cardIds: number[], from: string, to: string): ReportMilestone[] {
	if (cardIds.length === 0) return [];
	const ids = cardIds.map((n) => Number(n)).join(',');

	const rows = sqlite
		.prepare(
			`
		SELECT
			m.id, m.name, m.board_id AS boardId, m.target_date AS targetDate, m.status,
			COUNT(c.id) AS totalCards,
			SUM(CASE WHEN c.completed_at IS NOT NULL AND ${TS('c.completed_at')} <  @from THEN 1 ELSE 0 END) AS completedAtStart,
			SUM(CASE WHEN c.completed_at IS NOT NULL AND ${TS('c.completed_at')} <= @to   THEN 1 ELSE 0 END) AS completedAtEnd
		FROM milestones m
		JOIN cards c ON c.milestone_id = m.id AND c.archived_at IS NULL
		WHERE m.id IN (SELECT DISTINCT milestone_id FROM cards
		                WHERE id IN (${ids}) AND milestone_id IS NOT NULL)
		GROUP BY m.id
		ORDER BY m.id
	`
		)
		.all({ from, to }) as any[];

	return rows
		.map((r) => ({
			id: r.id,
			name: r.name,
			boardId: r.boardId,
			targetDate: r.targetDate,
			status: r.status,
			totalCards: Number(r.totalCards),
			completedAtStart: Number(r.completedAtStart),
			completedAtEnd: Number(r.completedAtEnd),
			percentAtStart: pct(Number(r.completedAtStart), Number(r.totalCards)),
			percentAtEnd: pct(Number(r.completedAtEnd), Number(r.totalCards)),
			hasTargetDate: !!r.targetDate
		}))
		// A milestone that did not move tells a reader nothing they need.
		.filter((m) => m.completedAtEnd > m.completedAtStart);
}

function pct(done: number, total: number): number {
	return total === 0 ? 0 : Math.round((done / total) * 100);
}

/** Window length in days. Both bounds are `YYYY-MM-DD HH:MM:SS` keys in UTC. */
function daysBetween(from: string, to: string): number {
	const ms = Date.parse(`${to.replace(' ', 'T')}Z`) - Date.parse(`${from.replace(' ', 'T')}Z`);
	return Number.isFinite(ms) ? Math.max(1, Math.round(ms / 86_400_000)) : 0;
}

function lookupUser(userId: number) {
	const u = sqlite
		.prepare('SELECT id, username, emoji FROM users WHERE id = ?')
		.get(userId) as { id: number; username: string; emoji: string | null } | undefined;
	return u ?? null;
}

/**
 * A card's board history, oldest first.
 *
 * Per-board activity totals were unreliable because a card that moved boards
 * mid-window appears under two `boardId`s in the log — 13 cards did in one
 * 30-day window — and nothing let a reader tell which board it was on when.
 * The events always recorded the board correctly; what was missing was any way
 * to read the sequence back.
 */
export function getCardBoardHistory(cardId: number): {
	boardId: number;
	boardName: string;
	from: string;
	to: string | null;
	current: boolean;
}[] {
	const moves = sqlite
		.prepare(
			`SELECT al.board_id AS boardId, b.name AS boardName, al.action, al.created_at AS createdAt
			 FROM activity_log al JOIN boards b ON b.id = al.board_id
			 WHERE al.card_id = ?
			   AND (al.action LIKE '%card_moved_in' OR al.action LIKE '%card_moved_away'
			        OR al.action LIKE '%card_created')
			 ORDER BY al.created_at ASC`
		)
		.all(cardId) as { boardId: number; boardName: string; action: string; createdAt: string }[];

	const current = sqlite
		.prepare(
			`SELECT col.board_id AS boardId, b.name AS boardName, c.created_at AS createdAt
			 FROM cards c JOIN columns col ON col.id = c.column_id
			 JOIN boards b ON b.id = col.board_id WHERE c.id = ?`
		)
		.get(cardId) as { boardId: number; boardName: string; createdAt: string } | undefined;
	if (!current) return [];

	// Arrivals only: a departure from A and an arrival at B describe the same
	// move, and counting both would double every hop.
	const arrivals = moves.filter(
		(m) => m.action.endsWith('card_moved_in') || m.action.endsWith('card_created')
	);

	const spans: { boardId: number; boardName: string; from: string; to: string | null; current: boolean }[] = [];

	// Where it started. The earliest departure names the board it left, which is
	// the only evidence of the original board once it has moved on.
	const firstAway = moves.find((m) => m.action.endsWith('card_moved_away'));
	if (arrivals.length === 0 || (firstAway && firstAway.createdAt < arrivals[0].createdAt)) {
		if (firstAway) {
			spans.push({
				boardId: firstAway.boardId,
				boardName: firstAway.boardName,
				from: current.createdAt,
				to: firstAway.createdAt,
				current: false
			});
		}
	}

	for (const a of arrivals) {
		spans.push({ boardId: a.boardId, boardName: a.boardName, from: a.createdAt, to: null, current: false });
	}

	// Close each span at the next one's start.
	for (let i = 0; i < spans.length - 1; i++) {
		if (spans[i].to === null) spans[i].to = spans[i + 1].from;
	}

	if (spans.length === 0) {
		spans.push({
			boardId: current.boardId,
			boardName: current.boardName,
			from: current.createdAt,
			to: null,
			current: true
		});
	} else {
		const last = spans[spans.length - 1];
		// The log and the card disagree only when a move was never recorded —
		// say so by appending the card's own board rather than trusting the log.
		if (last.boardId === current.boardId) {
			last.current = true;
			last.to = null;
		} else {
			last.to = last.to ?? new Date().toISOString();
			spans.push({
				boardId: current.boardId,
				boardName: current.boardName,
				from: last.to,
				to: null,
				current: true
			});
		}
	}

	return spans;
}

/** Re-exported so audit readers resolve a row's origin the one agreed way. */
export { readSource };
