/**
 * planning.ts — every derived planning fact, in one place.
 *
 * DumpFire records exactly two planning facts by hand:
 *   1. which piece of work blocks which  (`work_dependencies`)
 *   2. which milestone a card belongs to (`cards.milestone_id`)
 *
 * Everything else the planning view shows — the dependency graph, the critical
 * path, what is actionable today, what is blocked and by what — is computed
 * from those two facts and the current state of the work. Nothing derived is
 * stored, so nothing derived can go stale. Deliberately no start/end dates and
 * no estimates: a chain of work is enough to say what cannot slip.
 *
 * A "piece of work" is a card or a subtask. Both are nodes in one graph, keyed
 * as `card:123` / `subtask:456`, because ordering genuinely exists at both
 * levels and two separate graphs would be two chances to disagree about the
 * critical path. A subtask belongs to its parent card's milestone; it is never
 * attached to one directly.
 *
 * Edge direction, stated once so the rest of the file can be terse:
 *   `work_dependencies.blocked*` = the work that is WAITING
 *   `work_dependencies.blocker*` = the work it is waiting ON
 * An edge therefore points blocker → blocked, which is also the left-to-right
 * reading order of the milestone graph.
 */

import { db, sqlite } from './db';
import { inTransaction } from './db/transaction';
import {
	cards,
	columns,
	boards,
	subtasks,
	workDependencies,
	cardComments,
	milestones
} from './db/schema';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import { getAccessibleBoardIds, type Actor } from './board-access';
import { isCompleteColumnTitle } from './card-completion';
import { notifyCardUnblocked } from './notifications';
import { emit } from './events';
import { createLogger } from './logger';
import { completionPercent } from '$lib/progress';

const log = createLogger('PLAN');

// ─── Node identity ───────────────────────────────────────────────────────────

export type WorkKind = 'card' | 'subtask';

export interface WorkRef {
	kind: WorkKind;
	id: number;
}

/** `card:123` / `subtask:456`. Used as map keys throughout. */
export type NodeKey = string;

export function nodeKey(kind: WorkKind, id: number): NodeKey {
	return `${kind}:${id}`;
}

export function refKey(ref: WorkRef): NodeKey {
	return nodeKey(ref.kind, ref.id);
}

export function parseNodeKey(key: NodeKey): WorkRef {
	const [kind, id] = key.split(':');
	return { kind: kind as WorkKind, id: Number(id) };
}

/** A bare number means a card — the shape every existing caller already uses. */
export function toRef(value: number | WorkRef): WorkRef {
	return typeof value === 'number' ? { kind: 'card', id: value } : value;
}

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A piece of work as it is stored: identity, place, done-ness. What the
 * working out reads, and what is never given to a caller as it is: the read
 * functions below give a `PlanNode`, made for the one who asked.
 */
interface WorkNode extends WorkRef {
	title: string;
	priority: string;
	columnId: number;
	columnTitle: string;
	boardId: number;
	boardName: string;
	isComplete: boolean;
	milestoneId: number | null;
	/** Set on subtasks: the card they belong to. */
	parentCardId?: number;
}

/**
 * A piece of work as the planning view needs it, for one viewer.
 *
 * Work on a board the viewer cannot open is still listed, because its being
 * there is what makes "blocked" and "startable" true; but only what it is,
 * its id and whether it is finished are told. Its title and its place are
 * replaced, `withheld` is true, and a subtask has no `parentCardId`, as a
 * card has none (card 2129).
 */
export interface PlanNode extends WorkRef {
	/** For withheld work, `WITHHELD_CARD_TITLE` or `WITHHELD_SUBTASK_TITLE`. */
	title: string;
	/** null when withheld. */
	priority: string | null;
	/** null when withheld. */
	columnId: number | null;
	/** "" when withheld. */
	columnTitle: string;
	/** null when withheld. */
	boardId: number | null;
	/** `WITHHELD_BOARD_NAME` when withheld. */
	boardName: string;
	isComplete: boolean;
	/** null when withheld. */
	milestoneId: number | null;
	/** Set on subtasks: the card they belong to. Not on a withheld subtask. */
	parentCardId?: number;
	/** True when the node is not in this milestone but blocks something that is. */
	external?: boolean;
	/** True when the work is on a board the viewer cannot open. */
	withheld: boolean;
}

/** In place of the title of a card on a board the viewer cannot open. */
export const WITHHELD_CARD_TITLE = 'A card on a board you cannot open';
/** In place of the title of a subtask on a board the viewer cannot open. */
export const WITHHELD_SUBTASK_TITLE = 'A subtask on a board you cannot open';
/** In place of the name of a board the viewer cannot open. */
export const WITHHELD_BOARD_NAME = 'A board you cannot open';

/** Retained name — a card is just a node whose `kind` is 'card'. */
export type PlanCard = PlanNode;

/** One end of a dependency, with the row id needed to remove it again. */
export interface DependencyRef extends PlanNode {
	dependencyId: number;
	createdByUserId: number | null;
	createdAt: string;
}

export interface WorkDependencyState {
	blockedBy: DependencyRef[];
	blocks: DependencyRef[];
	/** True when at least one blocker is not finished. */
	isBlocked: boolean;
	openBlockers: WorkRef[];
}

/** Retained name for the card-only callers that predate subtask support. */
export type CardDependencyState = WorkDependencyState;

export interface MilestoneNode extends PlanNode {
	/** Topological layer, 0-based, left to right in the drawn graph. */
	layer: number;
	blockedBy: WorkRef[];
	blocks: WorkRef[];
	openBlockers: WorkRef[];
	/** Open work reachable downstream — how much finishing this frees up. */
	downstreamCount: number;
	onCriticalPath: boolean;
}

export interface MilestoneSummary {
	milestone: typeof milestones.$inferSelect;
	progress: {
		total: number;
		done: number;
		percent: number;
		byColumn: { columnTitle: string; count: number }[];
		openSubtasks: number;
		/**
		 * The boards the cards are on. The cards on boards the viewer cannot
		 * open are counted in one entry, `id` null and `WITHHELD_BOARD_NAME`.
		 */
		boards: { id: number | null; name: string; cardCount: number }[];
	};
	graph: {
		nodes: MilestoneNode[];
		edges: { from: WorkRef; to: WorkRef }[];
		/** Node refs per topological layer, left to right. */
		layers: WorkRef[][];
		/** Milestone cards with no dependencies recorded either way. */
		unordered: number[];
	};
	/**
	 * Card ids on the critical path, in order.
	 *
	 * Kept as plain card ids so callers written before subtasks existed keep
	 * working. Where the real chain runs through a subtask, its parent card
	 * appears here instead; `criticalPathNodes` carries the exact chain.
	 */
	criticalPath: number[];
	criticalPathNodes: PlanNode[];
	nextActionable: MilestoneNode[];
	/** `card` is the blocked node — a card, or a subtask when `kind` says so. */
	blocked: { card: MilestoneNode; blockers: PlanNode[] }[];
}

// ─── Node loading ────────────────────────────────────────────────────────────

/** SQLite caps bound parameters; run a query in chunks well under the limit. */
function chunked<T>(ids: number[], run: (chunk: number[]) => T[]): T[] {
	const out: T[] = [];
	for (let i = 0; i < ids.length; i += 500) out.push(...run(ids.slice(i, i + 500)));
	return out;
}

/**
 * Load cards and subtasks as they are stored, for working out with. A caller
 * is given them through `withhold`.
 *
 * Batched by type rather than one query per node — the milestone view asks for
 * dozens at once. Archived cards are dropped, and so are subtasks whose parent
 * card is archived: neither is live work.
 */
function loadPlanNodes(keys: Iterable<NodeKey>): Map<NodeKey, WorkNode> {
	const out = new Map<NodeKey, WorkNode>();
	const refs = [...new Set(keys)].map(parseNodeKey);
	const cardIds = refs.filter((r) => r.kind === 'card').map((r) => r.id);
	const subtaskIds = refs.filter((r) => r.kind === 'subtask').map((r) => r.id);
	if (cardIds.length === 0 && subtaskIds.length === 0) return out;

	// Subtasks inherit board and column from the card they belong to, so resolve
	// the parents first and fold them into the card lookup.
	const subtaskRows =
		subtaskIds.length > 0
			? chunked(subtaskIds, (ids) =>
					db
						.select({
							id: subtasks.id,
							cardId: subtasks.cardId,
							title: subtasks.title,
							priority: subtasks.priority,
							completed: subtasks.completed
						})
						.from(subtasks)
						.where(inArray(subtasks.id, ids))
						.all()
				)
			: [];

	const allCardIds = [...new Set([...cardIds, ...subtaskRows.map((s) => s.cardId)])];
	const cardRows =
		allCardIds.length > 0
			? chunked(allCardIds, (ids) =>
					db
						.select({
							id: cards.id,
							title: cards.title,
							priority: cards.priority,
							columnId: cards.columnId,
							milestoneId: cards.milestoneId
						})
						.from(cards)
						.where(and(inArray(cards.id, ids), isNull(cards.archivedAt)))
						.all()
				)
			: [];

	const colIds = [...new Set(cardRows.map((r) => r.columnId))];
	const cols = colIds.length > 0 ? db.select().from(columns).where(inArray(columns.id, colIds)).all() : [];
	const colById = new Map(cols.map((c) => [c.id, c]));

	const boardIds = [...new Set(cols.map((c) => c.boardId))];
	const brds = boardIds.length
		? db.select({ id: boards.id, name: boards.name }).from(boards).where(inArray(boards.id, boardIds)).all()
		: [];
	const boardById = new Map(brds.map((b) => [b.id, b]));

	const cardById = new Map(cardRows.map((r) => [r.id, r]));

	const place = (columnId: number) => {
		const col = colById.get(columnId);
		const board = col ? boardById.get(col.boardId) : undefined;
		return {
			columnId,
			columnTitle: col?.title ?? 'Unknown',
			boardId: col?.boardId ?? 0,
			boardName: board?.name ?? 'Unknown board',
			cardComplete: col ? isCompleteColumnTitle(col.title) : false
		};
	};

	for (const id of cardIds) {
		const r = cardById.get(id);
		if (!r) continue; // archived or deleted
		const p = place(r.columnId);
		out.set(nodeKey('card', id), {
			kind: 'card',
			id,
			title: r.title,
			priority: r.priority,
			columnId: p.columnId,
			columnTitle: p.columnTitle,
			boardId: p.boardId,
			boardName: p.boardName,
			isComplete: p.cardComplete,
			milestoneId: r.milestoneId ?? null
		});
	}

	for (const st of subtaskRows) {
		const parent = cardById.get(st.cardId);
		if (!parent) continue; // parent archived — not live work
		const p = place(parent.columnId);
		out.set(nodeKey('subtask', st.id), {
			kind: 'subtask',
			id: st.id,
			title: st.title,
			priority: st.priority,
			columnId: p.columnId,
			columnTitle: p.columnTitle,
			boardId: p.boardId,
			boardName: p.boardName,
			// A subtask is done when it is ticked, not when its card moves.
			isComplete: !!st.completed,
			milestoneId: parent.milestoneId ?? null,
			parentCardId: st.cardId
		});
	}

	return out;
}

// ─── What a viewer is told ───────────────────────────────────────────────────

/**
 * The boards `viewer` can open, as a test: every board for an administrator.
 * Asked once for a whole answer, rather than per node, which on the board page
 * and All Tasks would be a query for every blocker.
 */
export function boardsOpenTo(viewer: Actor): (boardId: number) => boolean {
	const ids = getAccessibleBoardIds(viewer);
	if (ids === null) return () => true;
	const open = new Set(ids);
	return (boardId) => open.has(boardId);
}

/**
 * A node as the viewer is given it. On a board they can open, as it is. On
 * one they cannot, it keeps what it is, its id and whether it is finished, and
 * nothing else of it: its title and board name are replaced by text, so that a
 * client that prints or sorts them still works, and its column, board,
 * priority, milestone and parent card are left blank. What the working out
 * found (its place in a plan, whether it blocks) is added by the caller from
 * the real node, never from this one.
 */
function withhold(node: WorkNode, opens: (boardId: number) => boolean): PlanNode {
	if (opens(node.boardId)) return { ...node, withheld: false };
	return {
		kind: node.kind,
		id: node.id,
		title: node.kind === 'card' ? WITHHELD_CARD_TITLE : WITHHELD_SUBTASK_TITLE,
		priority: null,
		columnId: null,
		columnTitle: '',
		boardId: null,
		boardName: WITHHELD_BOARD_NAME,
		isComplete: node.isComplete,
		milestoneId: null,
		withheld: true
	};
}

// ─── Dependency graph ────────────────────────────────────────────────────────

interface DepEdge {
	id: number;
	blocked: NodeKey;
	blocker: NodeKey;
	createdByUserId: number | null;
	createdAt: string;
}

interface DependencyGraph {
	edges: DepEdge[];
	/** blocked key → the edges that block it */
	blockedBy: Map<NodeKey, DepEdge[]>;
	/** blocker key → the edges it blocks */
	blocks: Map<NodeKey, DepEdge[]>;
}

/**
 * Load every dependency edge into adjacency maps.
 *
 * The whole table is read in one go on purpose: it is small — one row per
 * ordering decision somebody actually made, not one per piece of work — and
 * cycle detection, downstream counts and the critical path all walk it
 * repeatedly. Paging it would cost more queries than it saves rows.
 */
function loadDependencyGraph(): DependencyGraph {
	const rows = db
		.select({
			id: workDependencies.id,
			blockedType: workDependencies.blockedType,
			blockedId: workDependencies.blockedId,
			blockerType: workDependencies.blockerType,
			blockerId: workDependencies.blockerId,
			createdByUserId: workDependencies.createdByUserId,
			createdAt: workDependencies.createdAt
		})
		.from(workDependencies)
		.all();

	const edges: DepEdge[] = rows.map((r) => ({
		id: r.id,
		blocked: nodeKey(r.blockedType as WorkKind, r.blockedId),
		blocker: nodeKey(r.blockerType as WorkKind, r.blockerId),
		createdByUserId: r.createdByUserId,
		createdAt: r.createdAt
	}));

	const blockedBy = new Map<NodeKey, DepEdge[]>();
	const blocks = new Map<NodeKey, DepEdge[]>();
	for (const e of edges) {
		if (!blockedBy.has(e.blocked)) blockedBy.set(e.blocked, []);
		blockedBy.get(e.blocked)!.push(e);
		if (!blocks.has(e.blocker)) blocks.set(e.blocker, []);
		blocks.get(e.blocker)!.push(e);
	}

	return { edges, blockedBy, blocks };
}

/**
 * Blocked-by and blocks for one piece of work, each end resolved, as `viewer`
 * is given them: an end on a board they cannot open is there, withheld (see
 * `withhold`). Whether the work is blocked is worked out from every end.
 */
export function getWorkDependencies(ref: number | WorkRef, viewer: Actor): WorkDependencyState {
	const key = refKey(toRef(ref));
	const { blockedBy, blocks } = loadDependencyGraph();
	const inEdges = blockedBy.get(key) ?? [];
	const outEdges = blocks.get(key) ?? [];

	const byKey = loadPlanNodes([...inEdges.map((e) => e.blocker), ...outEdges.map((e) => e.blocked)]);
	const opens = boardsOpenTo(viewer);

	const toDepRef = (edge: DepEdge, otherKey: NodeKey): DependencyRef | null => {
		const node = byKey.get(otherKey);
		if (!node) return null; // archived or deleted — not a live dependency
		return {
			...withhold(node, opens),
			dependencyId: edge.id,
			createdByUserId: edge.createdByUserId,
			createdAt: edge.createdAt
		};
	};

	const blockedByRefs = inEdges
		.map((e) => toDepRef(e, e.blocker))
		.filter((r): r is DependencyRef => !!r);
	const blocksRefs = outEdges
		.map((e) => toDepRef(e, e.blocked))
		.filter((r): r is DependencyRef => !!r);
	const openBlockers = blockedByRefs
		.filter((r) => !r.isComplete)
		.map((r) => ({ kind: r.kind, id: r.id }));

	return {
		blockedBy: blockedByRefs,
		blocks: blocksRefs,
		isBlocked: openBlockers.length > 0,
		openBlockers
	};
}

/** Card-shaped alias, for callers that predate subtask support. */
export function getCardDependencies(cardId: number, viewer: Actor): WorkDependencyState {
	return getWorkDependencies({ kind: 'card', id: cardId }, viewer);
}

/**
 * Open blockers for a set of cards, in one pass, as `viewer` is given them: a
 * blocker on a board they cannot open is there, withheld.
 *
 * A view renders hundreds of card faces — the board a board's worth, All Tasks
 * every board at once — and asking per card would be hundreds of round trips.
 * A loader calls this once with the ids it already has. Cards with nothing open
 * blocking them are absent, keeping the payload proportional to what is
 * actually blocked rather than to how many cards exist.
 *
 * A card can be blocked by a subtask, so blockers come back as full nodes with
 * their `kind`.
 */
export function getBlockedStateForCards(cardIds: number[], viewer: Actor): Record<number, PlanNode[]> {
	if (cardIds.length === 0) return {};

	const { blockedBy } = loadDependencyGraph();
	const wanted = new Set(cardIds.map((id) => nodeKey('card', id)));

	const blockerKeys = new Set<NodeKey>();
	for (const [blocked, edges] of blockedBy) {
		if (!wanted.has(blocked)) continue;
		for (const e of edges) blockerKeys.add(e.blocker);
	}
	if (blockerKeys.size === 0) return {};

	const blockerNodes = loadPlanNodes(blockerKeys);
	const opens = boardsOpenTo(viewer);

	const out: Record<number, PlanNode[]> = {};
	for (const cardId of cardIds) {
		const open = (blockedBy.get(nodeKey('card', cardId)) ?? [])
			.map((e) => blockerNodes.get(e.blocker))
			.filter((n): n is WorkNode => !!n && !n.isComplete)
			.map((n) => withhold(n, opens));
		if (open.length > 0) out[cardId] = open;
	}
	return out;
}

/** Open blockers for every live card on one board, as `viewer` is given them. */
export function getBoardBlockedState(boardId: number, viewer: Actor): Record<number, PlanNode[]> {
	const boardColumns = db
		.select({ id: columns.id })
		.from(columns)
		.where(eq(columns.boardId, boardId))
		.all()
		.map((c) => c.id);
	if (boardColumns.length === 0) return {};

	const boardCardIds = db
		.select({ id: cards.id })
		.from(cards)
		.where(and(inArray(cards.columnId, boardColumns), isNull(cards.archivedAt)))
		.all()
		.map((c) => c.id);

	return getBlockedStateForCards(boardCardIds, viewer);
}

// ─── Batch validation ────────────────────────────────────────────────────────

export interface DependencyLink {
	/** The work that will be waiting. */
	blocked: number;
	/** The work it will be waiting on. */
	blocker: number;
	/** Defaults to 'card', so every card-only caller keeps working unchanged. */
	blockedType?: WorkKind;
	blockerType?: WorkKind;
}

export type BatchRejectionReason =
	| 'self'
	| 'missing-blocked'
	| 'missing-blocker'
	| 'cycle'
	| 'duplicate-in-batch';

export interface BatchRejection {
	link: DependencyLink;
	reason: BatchRejectionReason;
	/** For `cycle`, the chain the link would close. */
	cycle?: WorkRef[];
	message: string;
}

export interface DependencyBatchValidation {
	valid: DependencyLink[];
	/** Links already recorded — skipped, not errors, so re-running a list is safe. */
	duplicates: DependencyLink[];
	rejected: BatchRejection[];
	/** Every card id referenced by the batch, for the caller's access checks. */
	referencedCardIds: number[];
	/** Every node the batch touches, cards and subtasks alike. */
	referencedNodes: WorkRef[];
}

const linkBlocked = (l: DependencyLink): WorkRef => ({ kind: l.blockedType ?? 'card', id: l.blocked });
const linkBlocker = (l: DependencyLink): WorkRef => ({ kind: l.blockerType ?? 'card', id: l.blocker });

const describe = (r: WorkRef) => (r.kind === 'subtask' ? `subtask #${r.id}` : `#${r.id}`);

/**
 * Validate a whole batch of proposed dependencies before any of it is written.
 *
 * Cycle detection is the reason links are checked as a batch here, and never
 * one at a time. Two links can each be perfectly safe against the
 * *stored* graph and still close a loop between themselves — check them
 * independently and both get written, leaving the milestone view with the
 * stranded nodes its own layering code warns about. So the proposed edges are
 * layered on top of the stored graph and added one at a time, each checked
 * against everything accepted so far.
 *
 * Reports every problem in one pass. Fixing a fifty-line list one error per
 * round trip is what makes bulk import not worth using.
 */
export function validateDependencyBatch(links: DependencyLink[]): DependencyBatchValidation {
	const { blocks } = loadDependencyGraph();

	const adjacency = new Map<NodeKey, Set<NodeKey>>();
	for (const [blocker, edges] of blocks) {
		adjacency.set(blocker, new Set(edges.map((e) => e.blocked)));
	}

	const referencedKeys = [
		...new Set(links.flatMap((l) => [refKey(linkBlocked(l)), refKey(linkBlocker(l))]))
	];
	const live = loadPlanNodes(referencedKeys);

	const existingPairs = new Set<string>();
	for (const [blocker, targets] of adjacency) {
		for (const blocked of targets) existingPairs.add(`${blocked}|${blocker}`);
	}

	/** Is `to` reachable from `from` following blocker → blocked edges? */
	const reaches = (from: NodeKey, to: NodeKey): NodeKey[] | null => {
		const seen = new Set<NodeKey>([from]);
		const path: NodeKey[] = [from];
		const walk = (current: NodeKey): boolean => {
			for (const next of adjacency.get(current) ?? []) {
				if (next === to) {
					path.push(next);
					return true;
				}
				if (seen.has(next)) continue;
				seen.add(next);
				path.push(next);
				if (walk(next)) return true;
				path.pop();
			}
			return false;
		};
		return walk(from) ? path : null;
	};

	const valid: DependencyLink[] = [];
	const duplicates: DependencyLink[] = [];
	const rejected: BatchRejection[] = [];
	const seenInBatch = new Set<string>();

	for (const link of links) {
		const blocked = linkBlocked(link);
		const blocker = linkBlocker(link);
		const bk = refKey(blocked);
		const rk = refKey(blocker);
		const key = `${bk}|${rk}`;

		if (bk === rk) {
			rejected.push({ link, reason: 'self', message: `${describe(blocked)} cannot depend on itself` });
			continue;
		}
		if (!live.has(bk)) {
			rejected.push({
				link,
				reason: 'missing-blocked',
				message: `${describe(blocked)} does not exist or is archived`
			});
			continue;
		}
		if (!live.has(rk)) {
			rejected.push({
				link,
				reason: 'missing-blocker',
				message: `${describe(blocker)} does not exist or is archived`
			});
			continue;
		}
		if (existingPairs.has(key)) {
			duplicates.push(link);
			continue;
		}
		if (seenInBatch.has(key)) {
			rejected.push({
				link,
				reason: 'duplicate-in-batch',
				message: `${describe(blocked)} waits on ${describe(blocker)} appears more than once in this batch`
			});
			continue;
		}

		const chain = reaches(bk, rk);
		if (chain) {
			const refs = chain.map(parseNodeKey);
			rejected.push({
				link,
				reason: 'cycle',
				cycle: refs,
				message: `${describe(blocked)} waiting on ${describe(blocker)} would create a cycle: ${refs.map(describe).join(' → ')} → ${describe(refs[0])}`
			});
			continue;
		}

		if (!adjacency.has(rk)) adjacency.set(rk, new Set());
		adjacency.get(rk)!.add(bk);
		seenInBatch.add(key);
		valid.push(link);
	}

	const refs = referencedKeys.map(parseNodeKey);
	return {
		valid,
		duplicates,
		rejected,
		referencedCardIds: refs.filter((r) => r.kind === 'card').map((r) => r.id),
		referencedNodes: refs
	};
}

/**
 * Write a validated batch in one transaction.
 *
 * Takes only links that `validateDependencyBatch` accepted — it does not
 * re-check, because the caller has to do the access checks between validation
 * and writing anyway, and re-deriving the graph here would just be a second
 * chance to disagree with the answer already reported.
 */
export function createDependencyBatch(links: DependencyLink[], userId: number): number {
	if (links.length === 0) return 0;

	const insert = sqlite.prepare(
		`INSERT OR IGNORE INTO work_dependencies
		 (blocked_type, blocked_id, blocker_type, blocker_id, created_by_user_id)
		 VALUES (?, ?, ?, ?, ?)`
	);
	return inTransaction(() => {
		let n = 0;
		for (const l of links) {
			n += insert.run(l.blockedType ?? 'card', l.blocked, l.blockerType ?? 'card', l.blocker, userId)
				.changes;
		}
		return n;
	});
}

/** Turn an ordered list of work into the links of a linear chain. */
export function chainToLinks(chain: (number | WorkRef)[]): DependencyLink[] {
	const refs = chain.map(toRef);
	const links: DependencyLink[] = [];
	for (let i = 1; i < refs.length; i++) {
		links.push({
			blocked: refs[i].id,
			blockedType: refs[i].kind,
			blocker: refs[i - 1].id,
			blockerType: refs[i - 1].kind
		});
	}
	return links;
}

/**
 * Remove every edge touching a node.
 *
 * The polymorphic ids carry no foreign key, so nothing cascades — deleting a
 * card or subtask has to clear its edges explicitly, or the graph keeps
 * references to work that no longer exists.
 */
export function removeWorkNodeEdges(kind: WorkKind, id: number): number {
	return sqlite
		.prepare(
			`DELETE FROM work_dependencies
			 WHERE (blocked_type = ? AND blocked_id = ?) OR (blocker_type = ? AND blocker_id = ?)`
		)
		.run(kind, id, kind, id).changes;
}

// ─── Milestone planning ──────────────────────────────────────────────────────

const PRIORITY_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

function weightOf(priority: string): number {
	return PRIORITY_WEIGHT[priority] ?? 2;
}

/**
 * Build the whole planning picture for one milestone.
 *
 * Node set is:
 *   - the milestone's cards
 *   - subtasks of those cards **that take part in a dependency** — only those,
 *     because every subtask of every card would swamp the graph and most carry
 *     no ordering at all
 *   - any work outside the milestone that directly blocks something inside it,
 *     marked `external`. Those have to be here: work whose only blocker sits on
 *     another board is not actionable, and a view that hid the blocker would
 *     quietly claim that it was.
 *
 * Made for `viewer`. The layers, the reach, the critical path, its card ids
 * and the order of what is startable are worked out from the work as it is,
 * so that they are the same for everyone. Then each node is withheld once, if
 * its board is one the viewer cannot open, and everything given is built from
 * those: the nodes, the chain, the blockers and the progress. A member card can
 * be on such a board too: a card moved to another board keeps a board's
 * milestone (card 2129, R4).
 */
export function getMilestoneSummary(milestoneId: number, viewer: Actor): MilestoneSummary | null {
	const milestone = db.select().from(milestones).where(eq(milestones.id, milestoneId)).get();
	if (!milestone) return null;

	const memberCardIds = db
		.select({ id: cards.id })
		.from(cards)
		.where(and(eq(cards.milestoneId, milestoneId), isNull(cards.archivedAt)))
		.all()
		.map((c) => c.id);

	const { blockedBy, blocks } = loadDependencyGraph();

	// Subtasks of member cards, but only those that actually carry an edge.
	const memberSubtaskIds =
		memberCardIds.length > 0
			? chunked(memberCardIds, (ids) =>
					db.select({ id: subtasks.id }).from(subtasks).where(inArray(subtasks.cardId, ids)).all()
				).map((r) => r.id)
			: [];
	const participating = new Set<NodeKey>();
	for (const id of memberSubtaskIds) {
		const k = nodeKey('subtask', id);
		if (blockedBy.has(k) || blocks.has(k)) participating.add(k);
	}

	const memberKeys = new Set<NodeKey>([
		...memberCardIds.map((id) => nodeKey('card', id)),
		...participating
	]);

	// Direct external blockers, so "actionable" tells the truth.
	const externalKeys = new Set<NodeKey>();
	for (const k of memberKeys) {
		for (const e of blockedBy.get(k) ?? []) {
			if (!memberKeys.has(e.blocker)) externalKeys.add(e.blocker);
		}
	}

	const byKey = loadPlanNodes([...memberKeys, ...externalKeys]);
	const nodeKeys = [...memberKeys, ...externalKeys].filter((k) => byKey.has(k));
	const nodeSet = new Set(nodeKeys);

	// Keep only edges with both ends in the node set.
	const edgeList: { from: NodeKey; to: NodeKey }[] = [];
	const blockedByKeys = new Map<NodeKey, NodeKey[]>();
	const blocksKeys = new Map<NodeKey, NodeKey[]>();
	for (const k of nodeKeys) {
		blockedByKeys.set(k, []);
		blocksKeys.set(k, []);
	}
	for (const k of nodeKeys) {
		for (const e of blockedBy.get(k) ?? []) {
			if (!nodeSet.has(e.blocker)) continue;
			edgeList.push({ from: e.blocker, to: k });
			blocksKeys.get(e.blocker)!.push(k);
			blockedByKeys.get(k)!.push(e.blocker);
		}
	}

	// ── Topological layering (Kahn). Each frontier is sorted so the drawn graph
	//    is stable between reloads, which matters more here than raw speed.
	const indegree = new Map<NodeKey, number>(nodeKeys.map((k) => [k, blockedByKeys.get(k)!.length]));
	const layerKeys: NodeKey[][] = [];
	const layerOf = new Map<NodeKey, number>();
	const placed = new Set<NodeKey>();
	const sortKeys = (a: NodeKey, b: NodeKey) => a.localeCompare(b);
	let frontier = nodeKeys.filter((k) => indegree.get(k) === 0).sort(sortKeys);

	while (frontier.length > 0) {
		layerKeys.push(frontier);
		for (const k of frontier) {
			layerOf.set(k, layerKeys.length - 1);
			placed.add(k);
		}
		const next: NodeKey[] = [];
		for (const k of frontier) {
			for (const child of blocksKeys.get(k)!) {
				const left = (indegree.get(child) ?? 0) - 1;
				indegree.set(child, left);
				if (left === 0) next.push(child);
			}
		}
		frontier = next.sort(sortKeys);
	}

	// A cycle would strand nodes here. The API rejects cycles on insert, so this
	// only fires on rows that predate the check — park the stragglers in a final
	// layer rather than dropping them off the view entirely.
	const stranded = nodeKeys.filter((k) => !placed.has(k));
	if (stranded.length > 0) {
		log.warn(`Milestone ${milestoneId}: ${stranded.length} node(s) caught in a dependency cycle`);
		const tailLayer = stranded.sort(sortKeys);
		layerKeys.push(tailLayer);
		for (const k of tailLayer) layerOf.set(k, layerKeys.length - 1);
	}

	const topoOrder = layerKeys.flat();

	// ── Downstream reach: how much open work finishing this frees up. Walked in
	//    reverse topological order so each node reuses its children's sets
	//    instead of re-walking the graph from every node.
	const reach = new Map<NodeKey, Set<NodeKey>>();
	for (let i = topoOrder.length - 1; i >= 0; i--) {
		const k = topoOrder[i];
		const set = new Set<NodeKey>();
		for (const child of blocksKeys.get(k) ?? []) {
			if (!byKey.get(child)?.isComplete) set.add(child);
			for (const d of reach.get(child) ?? []) set.add(d);
		}
		reach.set(k, set);
	}

	// ── Critical path: the longest chain of OPEN dependencies, by node count.
	//    Complete work is excluded — the chain that cannot slip is made of work
	//    still to do, and a finished prerequisite adds no risk. Computed over the
	//    full graph including subtasks, so collapsing them in the view is purely
	//    a display choice and never changes the answer.
	const openKeys = topoOrder.filter((k) => !byKey.get(k)!.isComplete);
	const openSet = new Set(openKeys);
	const best = new Map<NodeKey, { length: number; weight: number; prev: NodeKey | null }>();

	for (const k of openKeys) {
		const own = weightOf(byKey.get(k)!.priority);
		let chosen: { length: number; weight: number; prev: NodeKey | null } = {
			length: 1,
			weight: own,
			prev: null
		};
		for (const parent of blockedByKeys.get(k) ?? []) {
			if (!openSet.has(parent)) continue;
			const p = best.get(parent);
			if (!p) continue; // stranded by a cycle — skip rather than guess
			const cand = { length: p.length + 1, weight: p.weight + own, prev: parent };
			const better =
				cand.length > chosen.length ||
				(cand.length === chosen.length && cand.weight > chosen.weight) ||
				(cand.length === chosen.length &&
					cand.weight === chosen.weight &&
					chosen.prev !== null &&
					parent.localeCompare(chosen.prev) < 0);
			if (better) chosen = cand;
		}
		best.set(k, chosen);
	}

	let tail: NodeKey | null = null;
	for (const k of openKeys) {
		const b = best.get(k)!;
		if (tail === null) {
			tail = k;
			continue;
		}
		const t = best.get(tail)!;
		if (b.length > t.length || (b.length === t.length && b.weight > t.weight)) tail = k;
	}

	const criticalKeys: NodeKey[] = [];
	let cursor: NodeKey | null = tail;
	while (cursor !== null) {
		criticalKeys.unshift(cursor);
		cursor = best.get(cursor)?.prev ?? null;
	}
	// A single node with nothing open on either side is not a path worth
	// highlighting — it is just the next thing to do, and it shows up there.
	const criticalSet = new Set(criticalKeys.length > 1 ? criticalKeys : []);

	// Card ids on the path, in order, with a subtask standing in for its parent
	// card so the long-standing `number[]` shape still means something. From the
	// real nodes: a withheld subtask has no parent card to stand in for it.
	const pathKeys = criticalKeys.length > 1 ? criticalKeys : [];
	const criticalPath: number[] = [];
	for (const k of pathKeys) {
		const n = byKey.get(k)!;
		const cardId = n.kind === 'card' ? n.id : (n.parentCardId ?? n.id);
		if (criticalPath[criticalPath.length - 1] !== cardId) criticalPath.push(cardId);
	}

	// ── What the viewer is given. Everything above was worked out from the
	//    work as it is; each node is withheld here, once, and everything below
	//    is built from these, so no title or board name is given by another way.
	const opens = boardsOpenTo(viewer);
	const shown = new Map<NodeKey, PlanNode>(nodeKeys.map((k) => [k, withhold(byKey.get(k)!, opens)]));

	// ── Assemble nodes.
	const nodes: MilestoneNode[] = nodeKeys.map((k) => {
		const openBlockers = (blockedByKeys.get(k) ?? []).filter((b) => !byKey.get(b)!.isComplete);
		return {
			...shown.get(k)!,
			external: !memberKeys.has(k),
			layer: layerOf.get(k) ?? 0,
			blockedBy: (blockedByKeys.get(k) ?? []).map(parseNodeKey),
			blocks: (blocksKeys.get(k) ?? []).map(parseNodeKey),
			openBlockers: openBlockers.map(parseNodeKey),
			downstreamCount: reach.get(k)?.size ?? 0,
			onCriticalPath: criticalSet.has(k)
		};
	});
	const nodeByKeyMap = new Map(nodes.map((n) => [refKey(n), n]));

	// ── Next actionable: in the milestone, not done, nothing open blocking it.
	//    Sorted by how much it unblocks, because on a one- or two-person team the
	//    work that frees the most downstream work is worth starting first. By the
	//    real priority, so that the order is the same whoever asks.
	const realWeight = (n: WorkRef) => weightOf(byKey.get(refKey(n))!.priority);
	const nextActionable = nodes
		.filter((n) => !n.external && !n.isComplete && n.openBlockers.length === 0)
		.sort(
			(a, b) =>
				b.downstreamCount - a.downstreamCount ||
				realWeight(b) - realWeight(a) ||
				a.id - b.id
		);

	const blocked = nodes
		.filter((n) => !n.external && !n.isComplete && n.openBlockers.length > 0)
		.sort((a, b) => a.openBlockers.length - b.openBlockers.length || a.id - b.id)
		.map((n) => ({
			card: n,
			blockers: n.openBlockers.map((r) => shown.get(refKey(r))!).filter(Boolean)
		}));

	// Milestone cards with no ordering recorded at all — surfaced as a parallel
	// group so nothing can be invisible just because nobody sequenced it.
	const unordered = nodes
		.filter(
			(n) => !n.external && n.kind === 'card' && n.blockedBy.length === 0 && n.blocks.length === 0
		)
		.map((n) => n.id);

	// ── Progress. Counts cover the milestone's own CARDS; subtasks are counted
	//    separately as open subtasks, exactly as they were before they could
	//    carry dependencies — otherwise recording an ordering on a subtask would
	//    silently change how big the goal looks. From the withheld nodes: a card
	//    on a board the viewer cannot open is counted under "" in `byColumn`, and
	//    in one entry of `boards` with no id, whichever board it is on.
	const memberCardNodes = nodes.filter((n) => !n.external && n.kind === 'card');
	const byColumnMap = new Map<string, number>();
	for (const n of memberCardNodes) {
		byColumnMap.set(n.columnTitle, (byColumnMap.get(n.columnTitle) ?? 0) + 1);
	}

	const boardMap = new Map<number | null, { id: number | null; name: string; cardCount: number }>();
	for (const n of memberCardNodes) {
		const entry = boardMap.get(n.boardId) ?? { id: n.boardId, name: n.boardName, cardCount: 0 };
		entry.cardCount++;
		boardMap.set(n.boardId, entry);
	}

	const liveMemberIds = memberCardNodes.map((n) => n.id);
	const openSubtasks = liveMemberIds.length
		? chunked(liveMemberIds, (ids) =>
				db
					.select({ id: subtasks.id })
					.from(subtasks)
					.where(and(inArray(subtasks.cardId, ids), eq(subtasks.completed, false)))
					.all()
			).length
		: 0;

	const done = memberCardNodes.filter((n) => n.isComplete).length;

	const criticalPathNodes = pathKeys.map((k) => shown.get(k)!);

	return {
		milestone,
		progress: {
			total: memberCardNodes.length,
			done,
			percent: completionPercent(done, memberCardNodes.length),
			byColumn: [...byColumnMap.entries()].map(([columnTitle, count]) => ({ columnTitle, count })),
			openSubtasks,
			boards: [...boardMap.values()].sort((a, b) => b.cardCount - a.cardCount)
		},
		graph: {
			nodes,
			edges: edgeList.map((e) => ({ from: parseNodeKey(e.from), to: parseNodeKey(e.to) })),
			layers: layerKeys.map((l) => l.map(parseNodeKey)),
			unordered
		},
		criticalPath,
		criticalPathNodes,
		nextActionable,
		blocked: blocked.map((b) => ({ card: nodeByKeyMap.get(refKey(b.card))!, blockers: b.blockers }))
	};
}

/** Every board a milestone's cards live on — used for access checks. */
export function getMilestoneBoardIds(milestoneId: number): number[] {
	const rows = db
		.select({ boardId: columns.boardId })
		.from(cards)
		.innerJoin(columns, eq(cards.columnId, columns.id))
		.where(eq(cards.milestoneId, milestoneId))
		.all();
	return [...new Set(rows.map((r) => r.boardId))];
}

// ─── Unblock hook ────────────────────────────────────────────────────────────

export interface UnblockedWork {
	kind: WorkKind;
	id: number;
	/** The card the notice belongs on — the work itself, or a subtask's parent. */
	cardId: number;
	title: string;
	boardId: number;
	/**
	 * The work whose completion left this with nothing open blocking it. Where
	 * one request completed several of its blockers, the last of them.
	 */
	completed: { kind: WorkKind; id: number; title: string };
}

/** Retained name for callers that only ever dealt in cards. */
export type UnblockedCard = UnblockedWork;

/**
 * The notices for one piece of finished work.
 *
 * Finds whatever was waiting on it and now has nothing open blocking it, and
 * drops a system comment on each affected card. `unblockedByThis` is asked
 * about each thing that was waiting on it, and what it refuses is passed
 * over: the same request completed another of that work's blockers after this
 * one, and the notice is that one's to write. Not caught: see
 * `recordUnblocked`.
 */
function writeUnblockNotices(
	completedNode: WorkNode,
	actorUserId: number,
	{ blockedBy, blocks }: DependencyGraph,
	unblockedByThis: (waiting: NodeKey) => boolean
): UnblockedWork[] {
	const key = refKey(completedNode);
	const dependents = (blocks.get(key) ?? []).map((e) => e.blocked).filter(unblockedByThis);
	if (dependents.length === 0) return [];

	// One load covering the dependents and all of their blockers.
	const needed = new Set<NodeKey>(dependents);
	for (const k of dependents) {
		for (const e of blockedBy.get(k) ?? []) needed.add(e.blocker);
	}
	const byKey = loadPlanNodes(needed);

	const unblocked: UnblockedWork[] = [];

	for (const k of dependents) {
		const node = byKey.get(k);
		if (!node || node.isComplete) continue;

		const stillOpen = (blockedBy.get(k) ?? []).filter((e) => {
			const blocker = byKey.get(e.blocker);
			return blocker && !blocker.isComplete;
		});
		if (stillOpen.length > 0) continue;

		// Comments live on cards, so a subtask's notice goes on its parent card
		// and names the subtask.
		const cardId = node.kind === 'card' ? node.id : (node.parentCardId ?? node.id);
		const what = node.kind === 'card' ? 'this card' : `subtask "${node.title}"`;
		const by =
			completedNode.kind === 'card'
				? `#${completedNode.id} "${completedNode.title}"`
				: `subtask "${completedNode.title}"`;

		db.insert(cardComments)
			.values({
				cardId,
				userId: actorUserId,
				content: `Unblocked: ${by} completed — nothing is blocking ${what} now.`
			})
			.run();

		unblocked.push({
			kind: node.kind,
			id: node.id,
			cardId,
			title: node.title,
			boardId: node.boardId,
			completed: { kind: completedNode.kind, id: completedNode.id, title: completedNode.title }
		});
	}

	return unblocked;
}

/**
 * The first half of the unblock reaction: the rows.
 *
 * Writes an "Unblocked" notice on every card that was waiting on one of the
 * pieces of work in `completed` and now has nothing open blocking it, and
 * returns what it wrote, for `announceUnblocked`.
 *
 * Call it once per request, inside the request's transaction and as the last
 * thing its body does, with everything the request completed, in the order it
 * completed them. It reads the state the transaction has made, so a card that
 * one move of a drop unblocked and a later move of the same drop completed
 * gets no notice: by now it is complete. Called per completion, as this used
 * to be, it would get one.
 *
 * Work gets one notice from one call, however many of its blockers the
 * request completed. Each of them is judged against the same final state, so
 * each used to find the work unblocked and write a notice of its own, and its
 * assignees were mailed once for each. The notice names the last of them in
 * `completed`: until that one was done the work was still blocked, so that is
 * the completion that unblocked it. The dependencies are read once, for all of
 * them.
 *
 * It throws if no transaction is open, and a failure to write a notice is not
 * caught. The notice is part of the completion and fails with it; the rule
 * here used to be the opposite, that a failed comment must not fail a
 * completion, and a completion could then be saved without the notice that
 * tells the next person it is their turn.
 */
export function recordUnblocked(completed: (number | WorkRef)[], actorUserId: number): UnblockedWork[] {
	if (!sqlite.inTransaction) {
		throw new Error(
			'recordUnblocked must be called inside the transaction that completes the work: wrap the completion ' +
				'and this call in inTransaction.'
		);
	}
	const graph = loadDependencyGraph();
	const keys = completed.map((work) => refKey(toRef(work)));
	const waitedOn = keys.filter((key) => graph.blocks.has(key));
	if (waitedOn.length === 0) return [];

	// Archived work is not among these, and writes no notice.
	const finished = loadPlanNodes(waitedOn);

	// For each thing that was waiting, where in `completed` the last of its
	// blockers is. A later one replaces an earlier one.
	const lastBlocker = new Map<NodeKey, number>();
	keys.forEach((key, i) => {
		if (!finished.has(key)) return;
		for (const e of graph.blocks.get(key) ?? []) lastBlocker.set(e.blocked, i);
	});

	return keys.flatMap((key, i) => {
		const node = finished.get(key);
		if (!node) return [];
		return writeUnblockNotices(node, actorUserId, graph, (waiting) => lastBlocker.get(waiting) === i);
	});
}

/**
 * The second half of the unblock reaction: the assignee email and the board
 * refresh, for the notices `recordUnblocked` wrote.
 *
 * Nothing is sent until the transaction that wrote them has committed, and
 * nothing at all if it rolls back: both go through `afterCommit`. So it can be
 * called inside that transaction or after it. A mail that fails is logged and
 * fails nothing.
 */
export function announceUnblocked(
	unblocked: UnblockedWork[],
	actor: { username: string },
	baseUrl: string | null
): void {
	for (const u of unblocked) {
		notifyCardUnblocked(
			u.boardId,
			u.cardId,
			u.kind === 'card' ? u.title : `${u.title} (subtask)`,
			u.completed.id,
			u.completed.title,
			actor.username,
			baseUrl
		);
		// The unblocked work may well be on another board; refresh that one too
		// so its "Blocked" chip clears without a reload.
		emit(u.boardId, 'update', { type: 'card' });
	}
}
