/**
 * burndown.ts — which cards a burndown covers, and who may see it.
 *
 * The maths lives in `$lib/burndown` and is pure. This module turns a request
 * into a set of cards — a board, several boards, a board category, a
 * milestone, or everything the user can see, narrowed by card category,
 * label, assignee and priority — and each card into the lifeline the maths
 * needs. Shared by the session API, the v1 API and the /burndown page so all
 * three answer the same question the same way.
 *
 * How a card's timestamps become a lifeline, and why:
 *
 *   start    the day of `created_at`.
 *   done     the day of `completed_at`, but only while the card sits in a
 *            Complete/Done column. `completed_at` is stamped on every move
 *            into Complete and never cleared on the way out, so a stamp on a
 *            card elsewhere is a reopened card, charted as open. A card in
 *            Complete with no stamp predates the stamping fixes; its last
 *            update stands in and is counted so the page can say so.
 *   removed  the day of `archived_at` for open work. Archive is the soft
 *            delete, so that is work dropped without being done. A finished
 *            card that is later archived stays done.
 *
 * Membership (milestone, category, label, assignee) is not historised, so it
 * is applied as it stands today across the whole window — the same assumption
 * the activity report makes, and stated in `meta.notes` whenever it applies.
 */

import { sqlite } from './db';
import { canViewBoard, getAccessibleBoardIds } from './board-access';
import { isCompleteColumnTitle } from './card-completion';
import { requireMilestone, MilestoneError } from './milestones';
import type { SessionUser } from './auth';
import {
	addDays,
	assessTarget,
	buildSeries,
	daysBetween,
	estimateDelivery,
	estimateDeliveryByParts,
	forecast,
	forecastBasis,
	isDay,
	summarise,
	toDay,
	todayUtc,
	PRIORITIES,
	type BurndownBoardRef,
	type DeliveryEstimate,
		type BurndownGroup,
	type BurndownGroupBy,
	type BurndownOption,
	type BurndownResult,
	type BurndownScopeKind,
	type CardLifeline,
	type Day
} from '$lib/burndown';

/** The longest window one request may cover. Two years of daily points. */
export const MAX_RANGE_DAYS = 730;
const DEFAULT_RANGE_DAYS = 30;

const GROUP_BYS: BurndownGroupBy[] = ['none', 'board', 'category', 'label', 'assignee', 'priority'];

/** The --priority-* tokens in app.css, as values an API consumer can use. */
const PRIORITY_COLORS: Record<string, string> = {
	critical: '#ef4444',
	high: '#f97316',
	medium: '#eab308',
	low: '#22c55e'
};

export class BurndownError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

export interface BurndownQuery {
	boardIds: number[];
	boardCategoryId: number | null;
	milestoneId: number | null;
	categoryIds: (number | 'none')[];
	labelIds: number[];
	assigneeIds: (number | 'none')[];
	priorities: string[];
	from: Day | null;
	to: Day | null;
	days: number | null;
	/** A day, `'none'` to suppress a milestone's own date, or null for the default. */
	target: Day | 'none' | null;
	groupBy: BurndownGroupBy;
	/** Include the filter values present in scope, for building a picker. */
	options: boolean;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/** `?x=1,2&x=3` and `?x=1&x=2,3` both mean [1, 2, 3]. */
function listParam(params: URLSearchParams, name: string): string[] {
	return params
		.getAll(name)
		.flatMap((v) => v.split(','))
		.map((v) => v.trim())
		.filter((v) => v.length > 0);
}

function idList(params: URLSearchParams, name: string, allow: string[] = []): (number | string)[] {
	return [
		...new Set(
			listParam(params, name).map((v) => {
				const lower = v.toLowerCase();
				if (allow.includes(lower)) return lower;
				const n = Number(v);
				if (!Number.isInteger(n) || n <= 0) {
					const extra = allow.length ? ` or ${allow.map((a) => `"${a}"`).join(', ')}` : '';
					throw new BurndownError(400, `${name} must be positive whole numbers${extra} — got "${v}"`);
				}
				return n;
			})
		)
	];
}

function singleId(params: URLSearchParams, name: string): number | null {
	const raw = params.get(name);
	if (raw === null || raw.trim() === '') return null;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) throw new BurndownError(400, `${name} must be a positive whole number — got "${raw}"`);
	return n;
}

function dayParam(params: URLSearchParams, name: string): Day | null {
	const raw = params.get(name);
	if (raw === null || raw.trim() === '') return null;
	const v = raw.trim();
	if (!isDay(v)) throw new BurndownError(400, `${name} must be a date as YYYY-MM-DD — got "${raw}"`);
	return v;
}

/**
 * Read a burndown request from a query string. Every problem is a 400 with a
 * message naming the parameter, because a silently ignored filter produces a
 * chart that looks right and answers a different question.
 */
export function parseBurndownQuery(params: URLSearchParams, user: SessionUser): BurndownQuery {
	const boardIds = idList(params, 'boardIds') as number[];
	const boardCategoryId = singleId(params, 'boardCategoryId');
	if (boardIds.length && boardCategoryId !== null) {
		throw new BurndownError(400, 'Use boardIds or boardCategoryId, not both');
	}

	const priorities = [...new Set(listParam(params, 'priorities').map((p) => p.toLowerCase()))];
	for (const p of priorities) {
		if (!(PRIORITIES as readonly string[]).includes(p)) {
			throw new BurndownError(400, `priorities must be ${PRIORITIES.join(', ')} — got "${p}"`);
		}
	}

	const from = dayParam(params, 'from');
	const to = dayParam(params, 'to');
	const daysRaw = params.get('days');
	let days: number | null = null;
	if (daysRaw !== null && daysRaw.trim() !== '') {
		days = Number(daysRaw);
		if (!Number.isInteger(days) || days < 1 || days > MAX_RANGE_DAYS) {
			throw new BurndownError(400, `days must be a whole number from 1 to ${MAX_RANGE_DAYS} — got "${daysRaw}"`);
		}
		if (from) throw new BurndownError(400, 'Use from or days, not both');
	}

	const targetRaw = params.get('target')?.trim().toLowerCase();
	const target = targetRaw === 'none' ? 'none' : dayParam(params, 'target');

	const groupByRaw = (params.get('groupBy') ?? 'none').trim() || 'none';
	if (!GROUP_BYS.includes(groupByRaw as BurndownGroupBy)) {
		throw new BurndownError(400, `groupBy must be one of ${GROUP_BYS.join(', ')} — got "${groupByRaw}"`);
	}

	return {
		boardIds,
		boardCategoryId,
		milestoneId: singleId(params, 'milestoneId'),
		categoryIds: idList(params, 'categoryIds', ['none']) as (number | 'none')[],
		labelIds: idList(params, 'labelIds') as number[],
		// "me" resolves here so the result echoes who it actually filtered on.
		assigneeIds: [
			...new Set(
				(idList(params, 'assigneeIds', ['none', 'me']) as (number | 'none' | 'me')[]).map((a) =>
					a === 'me' ? user.id : a
				)
			)
		],
		priorities,
		from,
		to,
		days,
		target,
		groupBy: groupByRaw as BurndownGroupBy,
		options: params.get('options') === 'true'
	};
}

// ─── Loading ────────────────────────────────────────────────────────────────

interface CardRow {
	id: number;
	boardId: number;
	categoryId: number | null;
	priority: string;
	createdAt: string;
	completedAt: string | null;
	updatedAt: string;
	archivedAt: string | null;
	columnTitle: string;
}

/** A card with what it needs for filtering, grouping and charting. */
interface ScopedCard {
	id: number;
	boardId: number;
	categoryId: number | null;
	priority: string;
	labelIds: number[];
	assigneeIds: number[];
	lifeline: CardLifeline;
	inferredDone: boolean;
	reopened: boolean;
	archivedDone: boolean;
}

/** Numbers only, so safe to inline — the approach activity-report.ts takes. */
function inList(ids: number[]): string {
	return ids.map((n) => Number(n)).join(',');
}

function loadCardRows(boardIds: number[] | null, milestoneId: number | null): CardRow[] {
	const where: string[] = [];
	if (boardIds !== null) {
		if (boardIds.length === 0) return [];
		where.push(`col.board_id IN (${inList(boardIds)})`);
	}
	if (milestoneId !== null) where.push(`c.milestone_id = ${Number(milestoneId)}`);

	return sqlite
		.prepare(
			`SELECT c.id, col.board_id AS boardId, c.category_id AS categoryId, c.priority,
			        c.created_at AS createdAt, c.completed_at AS completedAt,
			        c.updated_at AS updatedAt, c.archived_at AS archivedAt,
			        col.title AS columnTitle
			   FROM cards c
			   JOIN columns col ON col.id = c.column_id
			  ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`
		)
		.all() as CardRow[];
}

function toScopedCard(r: CardRow): ScopedCard {
	const inComplete = isCompleteColumnTitle(r.columnTitle);
	const done = inComplete ? toDay(r.completedAt ?? r.updatedAt) : null;
	return {
		id: r.id,
		boardId: r.boardId,
		categoryId: r.categoryId,
		priority: r.priority,
		labelIds: [],
		assigneeIds: [],
		lifeline: {
			start: toDay(r.createdAt),
			done,
			removed: !inComplete && r.archivedAt ? toDay(r.archivedAt) : null
		},
		inferredDone: inComplete && !r.completedAt,
		reopened: !inComplete && !!r.completedAt,
		archivedDone: inComplete && !!r.archivedAt
	};
}

interface NamedRow {
	id: number;
	name: string;
	color: string | null;
	boardId: number | null;
}

/** Label and assignee rows for the given cards, attached in place. */
function attachMembership(cards: ScopedCard[], labels: boolean, assignees: boolean) {
	if (cards.length === 0 || (!labels && !assignees)) return;
	const byId = new Map(cards.map((c) => [c.id, c]));
	const ids = inList(cards.map((c) => c.id));

	if (labels) {
		const rows = sqlite
			.prepare(`SELECT card_id AS cardId, label_id AS labelId FROM card_labels WHERE card_id IN (${ids})`)
			.all() as { cardId: number; labelId: number }[];
		for (const r of rows) byId.get(r.cardId)?.labelIds.push(r.labelId);
	}
	if (assignees) {
		const rows = sqlite
			.prepare(`SELECT card_id AS cardId, user_id AS userId FROM card_assignees WHERE card_id IN (${ids})`)
			.all() as { cardId: number; userId: number }[];
		for (const r of rows) byId.get(r.cardId)?.assigneeIds.push(r.userId);
	}
}

function loadBoards(ids: number[] | null): BurndownBoardRef[] {
	if (ids !== null && ids.length === 0) return [];
	const rows = sqlite
		.prepare(
			`SELECT id, name, emoji FROM boards ${ids === null ? '' : `WHERE id IN (${inList(ids)})`} ORDER BY name COLLATE NOCASE`
		)
		.all() as { id: number; name: string; emoji: string | null }[];
	return rows.map((b) => ({ id: b.id, name: b.name, emoji: b.emoji ?? '📋' }));
}

// ─── Filtering ──────────────────────────────────────────────────────────────

type Facet = 'category' | 'label' | 'assignee' | 'priority';

/**
 * Does a card pass every filter except `skip`? Values within one filter are
 * alternatives (any label of these); separate filters must all hold.
 */
function passes(card: ScopedCard, q: BurndownQuery, skip?: Facet): boolean {
	if (skip !== 'category' && q.categoryIds.length) {
		const key = card.categoryId ?? 'none';
		if (!q.categoryIds.includes(key)) return false;
	}
	if (skip !== 'label' && q.labelIds.length) {
		if (!card.labelIds.some((l) => q.labelIds.includes(l))) return false;
	}
	if (skip !== 'assignee' && q.assigneeIds.length) {
		const ok = q.assigneeIds.some((a) =>
			a === 'none' ? card.assigneeIds.length === 0 : card.assigneeIds.includes(a)
		);
		if (!ok) return false;
	}
	if (skip !== 'priority' && q.priorities.length) {
		if (!q.priorities.includes(card.priority)) return false;
	}
	return true;
}

/** Is this card in scope at any point in the window? */
function inWindow(l: CardLifeline, from: Day, to: Day): boolean {
	const start = l.done !== null && l.done < l.start ? l.done : l.start;
	if (start > to) return false;
	if (l.done === null && l.removed !== null && l.removed < from) return false;
	return true;
}

// ─── The result ─────────────────────────────────────────────────────────────

interface ResolvedScope {
	kind: BurndownScopeKind;
	/** Boards whose cards are loaded; null means every board. */
	boardIds: number[] | null;
	boardCategory: BurndownResult['scope']['boardCategory'];
	milestone: BurndownResult['scope']['milestone'];
	notes: string[];
}

function resolveScope(user: SessionUser, q: BurndownQuery): ResolvedScope {
	const notes: string[] = [];
	let boardIds: number[] | null = null;
	let boardCategory: ResolvedScope['boardCategory'] = null;
	let milestone: ResolvedScope['milestone'] = null;

	if (q.boardIds.length) {
		const found = new Set(
			(sqlite.prepare(`SELECT id FROM boards WHERE id IN (${inList(q.boardIds)})`).all() as { id: number }[]).map(
				(b) => b.id
			)
		);
		for (const id of q.boardIds) {
			if (!found.has(id)) throw new BurndownError(404, `Board ${id} not found`);
			if (!canViewBoard(user, id)) throw new BurndownError(403, `No access to board ${id}`);
		}
		boardIds = q.boardIds;
	} else if (q.boardCategoryId !== null) {
		const cat = sqlite
			.prepare('SELECT id, name, color FROM board_categories WHERE id = ?')
			.get(q.boardCategoryId) as { id: number; name: string; color: string } | undefined;
		if (!cat) throw new BurndownError(404, `Board category ${q.boardCategoryId} not found`);
		boardCategory = cat;

		const inCategory = (
			sqlite.prepare('SELECT id FROM boards WHERE category_id = ?').all(cat.id) as { id: number }[]
		).map((b) => b.id);
		const accessible = getAccessibleBoardIds(user);
		// A group of boards is charted as far as this user can see it — never
		// widened to boards they have no access to.
		boardIds = accessible === null ? inCategory : inCategory.filter((id) => accessible.includes(id));
		if (boardIds.length < inCategory.length) {
			const hidden = inCategory.length - boardIds.length;
			notes.push(
				`${hidden} board${hidden === 1 ? '' : 's'} in this category ${hidden === 1 ? 'is' : 'are'} not visible to you and ${hidden === 1 ? 'is' : 'are'} left out.`
			);
		}
	} else if (q.milestoneId === null) {
		boardIds = getAccessibleBoardIds(user);
	}

	if (q.milestoneId !== null) {
		try {
			// View access to a cross-board goal already requires access to every
			// board its cards touch, so its cards can be loaded without a board list.
			const m = requireMilestone(user, q.milestoneId);
			milestone = {
				id: m.id,
				name: m.name,
				targetDate: m.targetDate ? toDay(m.targetDate) : null,
				status: m.status,
				boardId: m.boardId,
				createdAt: m.createdAt
			};
		} catch (e) {
			if (e instanceof MilestoneError) throw new BurndownError(e.status, e.message);
			throw e;
		}
	}

	const kind: BurndownScopeKind = milestone
		? 'milestone'
		: boardCategory
			? 'boardCategory'
			: q.boardIds.length
				? 'boards'
				: 'workspace';

	return { kind, boardIds, boardCategory, milestone, notes };
}

function resolveRange(q: BurndownQuery, milestone: ResolvedScope['milestone'], notes: string[]) {
	const today = todayUtc();
	let to = q.to ?? today;
	// There is no data after today, and a future end would draw a flat line
	// that looks like a forecast.
	if (to > today) to = today;

	let from: Day;
	if (q.from) {
		from = q.from;
	} else if (q.days !== null) {
		from = addDays(to, -(q.days - 1));
	} else if (milestone) {
		// A goal's burndown starts when the goal did.
		from = toDay(milestone.createdAt);
		if (from > to) from = to;
		if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) {
			from = addDays(to, -(MAX_RANGE_DAYS - 1));
			notes.push(`This milestone is more than two years old; the chart starts on ${from}.`);
		}
	} else {
		from = addDays(to, -(DEFAULT_RANGE_DAYS - 1));
	}

	if (from > to) throw new BurndownError(400, `from (${from}) is after to (${to})`);
	const days = daysBetween(from, to) + 1;
	if (days > MAX_RANGE_DAYS) {
		throw new BurndownError(400, `The window can be at most ${MAX_RANGE_DAYS} days — this one is ${days}`);
	}
	return { from, to, days };
}

/**
 * The burndown for one request.
 *
 * Throws BurndownError with an HTTP status for anything the caller should be
 * told about: an unknown board, a board or milestone this user cannot see.
 */
export function getBurndown(user: SessionUser, q: BurndownQuery): BurndownResult {
	const scope = resolveScope(user, q);
	const notes = scope.notes;
	const { from, to, days } = resolveRange(q, scope.milestone, notes);

	const needLabels = q.labelIds.length > 0 || q.groupBy === 'label' || q.options;
	const needAssignees = q.assigneeIds.length > 0 || q.groupBy === 'assignee' || q.options;

	const all = loadCardRows(scope.boardIds, scope.milestone?.id ?? null).map(toScopedCard);
	// Only cards that exist in the window at all: they are what the chart,
	// the counts, the notes and the filter options are about.
	const windowed = all.filter((c) => inWindow(c.lifeline, from, to));
	attachMembership(windowed, needLabels, needAssignees);

	const cards = windowed.filter((c) => passes(c, q));
	const lifelines = cards.map((c) => c.lifeline);

	const series = buildSeries(lifelines, from, to);
	const summary = summarise(series);
	// One basis for both, so the forecast and the delivery estimate agree on
	// what "the recent pace" was.
	const basis = forecastBasis(lifelines, to);
	const fc = forecast(basis);
	const targetDate = q.target === 'none' ? null : (q.target ?? scope.milestone?.targetDate ?? null);

	// Lookups for naming boards, categories, labels and people.
	const boardsInPlay =
		scope.boardIds !== null ? loadBoards(scope.boardIds) : loadBoards([...new Set(windowed.map((c) => c.boardId))]);
	const boardName = new Map(boardsInPlay.map((b) => [b.id, b]));
	const multiBoard = new Set(windowed.map((c) => c.boardId)).size > 1;
	const nameOf = (id: number) => boardName.get(id)?.name ?? `Board ${id}`;

	const delivery = deliveryFor(cards, to, { target: targetDate, nameOf });

	let target: BurndownResult['target'] = null;
	if (targetDate) target = assessTarget(targetDate, q.target ? 'query' : 'milestone', series, fc);

	const lookups = loadLookups(windowed, needLabels, needAssignees, q.groupBy === 'category' || q.options);
	const describe = describer(lookups, boardName, multiBoard);

	const groups = q.groupBy === 'none' ? [] : buildGroups(cards, q.groupBy, from, to, describe, nameOf);

	// Honest footnotes: only the ones that bear on this particular chart.
	const inferred = cards.filter((c) => c.inferredDone).length;
	const reopened = cards.filter((c) => c.reopened).length;
	const archivedDone = cards.filter((c) => c.archivedDone).length;
	// The stand-in date only distorts this chart if it falls inside the window —
	// that is when a card finished long ago can be counted as finished here.
	const inferredInWindow = cards.filter(
		(c) => c.inferredDone && c.lifeline.done !== null && c.lifeline.done >= from && c.lifeline.done <= to
	).length;
	if (inferred) {
		const lead = `${inferred} card${inferred === 1 ? ' sits' : 's sit'} in Complete with no completion date; the date of ${inferred === 1 ? 'its' : 'their'} last update is used instead.`;
		const falls =
			inferredInWindow === inferred
				? inferred === 1 ? 'It falls' : 'All of them fall'
				: `${inferredInWindow} of them fall`;
		const effect =
			inferredInWindow >= summary.completed
				? 'so every completion counted here rests on an estimated date'
				: `so up to ${inferredInWindow} of the ${summary.completed.toLocaleString('en-GB')} completions here may have happened earlier`;
		notes.push(
			inferredInWindow
				? `${lead} ${falls} in this period, ${effect}.`
				: `${lead} None of those dates fall in this period, so the completions here are unaffected.`
		);
	}
	if (reopened) {
		notes.push(
			`${reopened} card${reopened === 1 ? ' was' : 's were'} completed and later reopened; ${reopened === 1 ? 'it is' : 'they are'} charted as open throughout, because the date of reopening is not recorded.`
		);
	}
	if (archivedDone) {
		notes.push(
			`${archivedDone} completed card${archivedDone === 1 ? ' has' : 's have'} since been archived and still ${archivedDone === 1 ? 'counts' : 'count'} as done, so scope can read higher than the board shows.`
		);
	}
	const membership = [
		scope.milestone ? 'milestone' : null,
		q.categoryIds.length || q.groupBy === 'category' ? 'category' : null,
		q.labelIds.length || q.groupBy === 'label' ? 'label' : null,
		q.assigneeIds.length || q.groupBy === 'assignee' ? 'assignee' : null
	].filter((m): m is string => m !== null);
	if (membership.length) {
		notes.push(`${sentenceList(membership, true)} membership is as it stands today, applied to the whole window.`);
	}
	if ((scope.kind === 'boards' || scope.kind === 'boardCategory') && cards.length) {
		const moved = countMovedIn(cards.map((c) => c.id));
		if (moved) {
			notes.push(
				`${moved} card${moved === 1 ? '' : 's'} moved here from another board and ${moved === 1 ? 'counts' : 'count'} here for ${moved === 1 ? 'its' : 'their'} whole life.`
			);
		}
	}

	const result: BurndownResult = {
		scope: {
			kind: scope.kind,
			label: scopeLabel(scope, boardsInPlay),
			boards: boardsInPlay,
			boardCategory: scope.boardCategory,
			milestone: scope.milestone
		},
		filters: {
			categoryIds: q.categoryIds,
			labelIds: q.labelIds,
			assigneeIds: q.assigneeIds,
			priorities: q.priorities
		},
		range: { from, to, days },
		series,
		summary,
		forecast: fc,
		delivery,
		target,
		groupBy: q.groupBy,
		groups,
		meta: {
			basis: 'card-timestamps',
			timezone: 'UTC',
			cardCount: cards.length,
			inferredCompletionDates: inferred,
			inferredInWindow,
			reopenedCards: reopened,
			archivedDoneCards: archivedDone,
			notes,
			generatedAt: new Date().toISOString()
		}
	};

	if (q.options) result.options = buildOptions(windowed, q, describe);
	return result;
}

// ─── Naming ─────────────────────────────────────────────────────────────────

interface Lookups {
	categories: Map<number, NamedRow>;
	labels: Map<number, NamedRow>;
	users: Map<number, { id: number; name: string; emoji: string }>;
}

function loadLookups(cards: ScopedCard[], labels: boolean, assignees: boolean, categories: boolean): Lookups {
	const out: Lookups = { categories: new Map(), labels: new Map(), users: new Map() };

	const catIds = [...new Set(cards.map((c) => c.categoryId).filter((id): id is number => id !== null))];
	if (categories && catIds.length) {
		for (const r of sqlite
			.prepare(`SELECT id, name, color, board_id AS boardId FROM categories WHERE id IN (${inList(catIds)})`)
			.all() as NamedRow[]) {
			out.categories.set(r.id, r);
		}
	}
	const labelIds = [...new Set(cards.flatMap((c) => c.labelIds))];
	if (labels && labelIds.length) {
		for (const r of sqlite
			.prepare(`SELECT id, name, color, board_id AS boardId FROM labels WHERE id IN (${inList(labelIds)})`)
			.all() as NamedRow[]) {
			out.labels.set(r.id, r);
		}
	}
	const userIds = [...new Set(cards.flatMap((c) => c.assigneeIds))];
	if (assignees && userIds.length) {
		for (const r of sqlite
			.prepare(`SELECT id, username AS name, emoji FROM users WHERE id IN (${inList(userIds)})`)
			.all() as { id: number; name: string; emoji: string | null }[]) {
			out.users.set(r.id, { id: r.id, name: r.name, emoji: r.emoji ?? '👤' });
		}
	}
	return out;
}

type Describer = (kind: Exclude<BurndownGroupBy, 'none'>, id: number | string | null) => { name: string; color: string | null };

/**
 * Names for group and option values. Labels are per board, so across several
 * boards two "Bug" labels are two different things and are told apart by
 * board. Categories are usually global and keep their plain name unless a
 * board-scoped one would collide.
 */
function describer(l: Lookups, boards: Map<number, BurndownBoardRef>, multiBoard: boolean): Describer {
	const withBoard = (row: NamedRow, all: Map<number, NamedRow>) => {
		if (!multiBoard || row.boardId === null) return row.name;
		const clash = [...all.values()].some((o) => o.id !== row.id && o.name.toLowerCase() === row.name.toLowerCase());
		return clash ? `${row.name} · ${boards.get(row.boardId)?.name ?? `board ${row.boardId}`}` : row.name;
	};
	return (kind, id) => {
		switch (kind) {
			case 'board': {
				const b = boards.get(Number(id));
				return { name: b ? `${b.emoji} ${b.name}` : `Board ${id}`, color: null };
			}
			case 'category': {
				if (id === null) return { name: 'Uncategorised', color: null };
				const c = l.categories.get(Number(id));
				return c ? { name: withBoard(c, l.categories), color: c.color } : { name: `Category ${id}`, color: null };
			}
			case 'label': {
				if (id === null) return { name: 'No label', color: null };
				const c = l.labels.get(Number(id));
				return c ? { name: withBoard(c, l.labels), color: c.color } : { name: `Label ${id}`, color: null };
			}
			case 'assignee': {
				if (id === null) return { name: 'Unassigned', color: null };
				const u = l.users.get(Number(id));
				return { name: u ? `${u.emoji} ${u.name}` : `User ${id}`, color: null };
			}
			case 'priority': {
				const p = String(id);
				return { name: p.charAt(0).toUpperCase() + p.slice(1), color: PRIORITY_COLORS[p] ?? null };
			}
		}
	};
}

/** The values a card carries for one grouping; empty means the "none" bucket. */
function keysFor(card: ScopedCard, kind: Exclude<BurndownGroupBy, 'none'>): (number | string)[] {
	switch (kind) {
		case 'board':
			return [card.boardId];
		case 'category':
			return card.categoryId === null ? [] : [card.categoryId];
		case 'label':
			return card.labelIds;
		case 'assignee':
			return card.assigneeIds;
		case 'priority':
			return [card.priority];
	}
}

/**
 * The delivery estimate for a set of cards. One board: one pile, because a
 * team shares its effort within a board. Several boards: each at its own pace,
 * done when the slowest is — see estimateDeliveryByParts. The pooled figure is
 * kept alongside as "if effort could move freely between boards".
 */
function deliveryFor(
	cards: ScopedCard[],
	to: Day,
	opts: { trials?: number; target?: Day | null; nameOf: (boardId: number) => string }
): DeliveryEstimate {
	const pooled = estimateDelivery(forecastBasis(cards.map((c) => c.lifeline), to), opts);
	const byBoard = new Map<number, CardLifeline[]>();
	for (const c of cards) {
		const list = byBoard.get(c.boardId);
		if (list) list.push(c.lifeline);
		else byBoard.set(c.boardId, [c.lifeline]);
	}
	if (byBoard.size <= 1) return pooled;
	const parts = [...byBoard].map(([boardId, lifelines]) => ({
		key: `board:${boardId}`,
		name: opts.nameOf(boardId),
		basis: forecastBasis(lifelines, to)
	}));
	return estimateDeliveryByParts(parts, pooled, opts);
}

function buildGroups(
	cards: ScopedCard[],
	kind: Exclude<BurndownGroupBy, 'none'>,
	from: Day,
	to: Day,
	describe: Describer,
	nameOf: (boardId: number) => string
): BurndownGroup[] {
	// A card with two labels belongs to both groups, so label and assignee
	// groups can sum to more than the whole. That is the honest reading of
	// "work carrying this label", and the page says so.
	const buckets = new Map<string, { id: number | string | null; cards: ScopedCard[] }>();
	for (const card of cards) {
		const keys = keysFor(card, kind);
		const list = keys.length ? keys : [null];
		for (const id of list) {
			const key = `${kind}:${id ?? 'none'}`;
			let b = buckets.get(key);
			if (!b) buckets.set(key, (b = { id, cards: [] }));
			b.cards.push(card);
		}
	}

	const groups: BurndownGroup[] = [];
	for (const [key, b] of buckets) {
		const lifelines = b.cards.map((c) => c.lifeline);
		const series = buildSeries(lifelines, from, to);
		if (series.every((p) => p.scope === 0)) continue;
		const { name, color } = describe(kind, b.id);
		const basis = forecastBasis(lifelines, to);
		groups.push({
			key,
			kind,
			id: b.id === null ? 'none' : b.id,
			name,
			color,
			cardCount: b.cards.length,
			remaining: series.map((p) => p.remaining),
			scope: series.map((p) => p.scope),
			summary: summarise(series),
			forecast: forecast(basis),
			// Fewer trials per row: a breakdown can have dozens of groups. A row
			// that spans several boards (a category, a label) is done when its
			// slowest board is, exactly like the scope as a whole.
			delivery: deliveryFor(b.cards, to, { trials: 500, nameOf })
		});
	}

	return groups.sort(
		(a, b) =>
			b.summary.remainingNow - a.summary.remainingNow ||
			b.summary.scopeNow - a.summary.scopeNow ||
			a.name.localeCompare(b.name)
	);
}

/**
 * Filter values present in scope, each counted with every OTHER filter
 * applied — the usual faceted-search rule, so picking a label narrows the
 * category counts but never hides the other labels you could switch to.
 */
function buildOptions(windowed: ScopedCard[], q: BurndownQuery, describe: Describer): NonNullable<BurndownResult['options']> {
	const facet = (skip: Facet, kind: Exclude<BurndownGroupBy, 'none'>, noneLabel: boolean): BurndownOption[] => {
		const counts = new Map<number | string, number>();
		for (const card of windowed) {
			if (!passes(card, q, skip)) continue;
			const keys = keysFor(card, kind);
			if (!keys.length && noneLabel) counts.set('none', (counts.get('none') ?? 0) + 1);
			for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
		}
		return [...counts.entries()]
			.map(([id, count]) => {
				const d = describe(kind, id === 'none' ? null : id);
				return { id, name: d.name, color: d.color, count };
			})
			.sort((a, b) => {
				// "None" buckets last; priorities in their own order; the rest by name.
				if (a.id === 'none') return 1;
				if (b.id === 'none') return -1;
				if (kind === 'priority') {
					return PRIORITIES.indexOf(a.id as (typeof PRIORITIES)[number]) - PRIORITIES.indexOf(b.id as (typeof PRIORITIES)[number]);
				}
				return a.name.localeCompare(b.name);
			});
	};
	return {
		categories: facet('category', 'category', true),
		labels: facet('label', 'label', false),
		assignees: facet('assignee', 'assignee', true),
		priorities: facet('priority', 'priority', false)
	};
}

function countMovedIn(cardIds: number[]): number {
	if (cardIds.length === 0) return 0;
	const row = sqlite
		.prepare(
			`SELECT COUNT(DISTINCT card_id) AS n FROM activity_log
			  WHERE action LIKE '%card_moved_in' AND card_id IN (${inList(cardIds)})`
		)
		.get() as { n: number };
	return Number(row.n);
}

function scopeLabel(scope: ResolvedScope, boards: BurndownBoardRef[]): string {
	if (scope.milestone) {
		return scope.boardIds && scope.boardIds.length
			? `${scope.milestone.name} · ${sentenceList(boards.map((b) => b.name))}`
			: scope.milestone.name;
	}
	if (scope.boardCategory) return scope.boardCategory.name;
	if (scope.kind === 'boards') {
		return boards.length <= 3 ? sentenceList(boards.map((b) => b.name)) : `${boards.length} boards`;
	}
	return 'All boards';
}

function sentenceList(items: string[], capitalise = false): string {
	const list =
		items.length <= 1
			? items.join('')
			: `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
	return capitalise ? list.charAt(0).toUpperCase() + list.slice(1) : list;
}
