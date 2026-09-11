/**
 * planning.ts — every derived planning fact, in one place.
 *
 * DumpFire records exactly two planning facts by hand:
 *   1. which card blocks which  (`card_dependencies`)
 *   2. which milestone a card belongs to  (`cards.milestone_id`)
 *
 * Everything else the planning view shows — the dependency graph, the critical
 * path, what is actionable today, what is blocked and by what — is computed
 * from those two facts and the card's current column. Nothing here is stored,
 * so nothing here can go stale. Deliberately no start/end dates and no per-card
 * estimates: a chain of cards is enough to say what cannot slip.
 *
 * Edge direction, stated once so the rest of the file can be terse:
 *   `card_dependencies.cardId`          = the card that is BLOCKED
 *   `card_dependencies.dependsOnCardId` = its BLOCKER
 * An edge therefore points blocker → blocked, which is also the left-to-right
 * reading order of the milestone graph.
 */

import { db } from './db';
import {
	cards,
	columns,
	boards,
	subtasks,
	cardDependencies,
	cardComments,
	milestones
} from './db/schema';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import { isCompleteColumnTitle } from './card-completion';
import { notifyCardUnblocked } from './notifications';
import { emit } from './events';
import { createLogger } from './logger';

const log = createLogger('PLAN');

// ─── Types ───────────────────────────────────────────────────────────────────

/** A card as the planning view needs it: identity, place, and done-ness. */
export interface PlanCard {
	id: number;
	title: string;
	priority: string;
	columnId: number;
	columnTitle: string;
	boardId: number;
	boardName: string;
	isComplete: boolean;
	milestoneId: number | null;
	/** True when the card is not in this milestone but blocks one that is. */
	external?: boolean;
}

/** One end of a dependency, with the row id needed to remove it again. */
export interface DependencyRef extends PlanCard {
	dependencyId: number;
	createdByUserId: number | null;
	createdAt: string;
}

export interface CardDependencyState {
	blockedBy: DependencyRef[];
	blocks: DependencyRef[];
	/** True when at least one blocker is not in a Complete column. */
	isBlocked: boolean;
	openBlockerIds: number[];
}

export interface MilestoneNode extends PlanCard {
	/** Topological layer, 0-based, left to right in the drawn graph. */
	layer: number;
	blockedByIds: number[];
	blocksIds: number[];
	openBlockerIds: number[];
	/** Open cards reachable downstream — how much finishing this frees up. */
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
		boards: { id: number; name: string; cardCount: number }[];
	};
	graph: {
		nodes: MilestoneNode[];
		edges: { from: number; to: number }[];
		/** Node ids per topological layer, left to right. */
		layers: number[][];
		/** Milestone cards with no dependencies recorded either way. */
		unordered: number[];
	};
	criticalPath: number[];
	nextActionable: MilestoneNode[];
	blocked: { card: MilestoneNode; blockers: PlanCard[] }[];
}

// ─── Card loading ────────────────────────────────────────────────────────────

/**
 * Load cards as PlanCards. One query for the cards and one each for columns and
 * boards, rather than a join per card — the milestone view asks for 20+ at once.
 * Archived cards are dropped: an archived blocker is not a live dependency.
 */
function loadPlanCards(cardIds: number[]): Map<number, PlanCard> {
	const out = new Map<number, PlanCard>();
	if (cardIds.length === 0) return out;

	// SQLite caps bound parameters, so chunk well below the 999 default.
	const rows: {
		id: number;
		title: string;
		priority: string;
		columnId: number;
		milestoneId: number | null;
	}[] = [];
	for (let i = 0; i < cardIds.length; i += 500) {
		const chunk = cardIds.slice(i, i + 500);
		rows.push(
			...db
				.select({
					id: cards.id,
					title: cards.title,
					priority: cards.priority,
					columnId: cards.columnId,
					milestoneId: cards.milestoneId
				})
				.from(cards)
				.where(and(inArray(cards.id, chunk), isNull(cards.archivedAt)))
				.all()
		);
	}
	if (rows.length === 0) return out;

	const colIds = [...new Set(rows.map((r) => r.columnId))];
	const cols = db.select().from(columns).where(inArray(columns.id, colIds)).all();
	const colById = new Map(cols.map((c) => [c.id, c]));

	const boardIds = [...new Set(cols.map((c) => c.boardId))];
	const brds = boardIds.length
		? db
				.select({ id: boards.id, name: boards.name })
				.from(boards)
				.where(inArray(boards.id, boardIds))
				.all()
		: [];
	const boardById = new Map(brds.map((b) => [b.id, b]));

	for (const r of rows) {
		const col = colById.get(r.columnId);
		const board = col ? boardById.get(col.boardId) : undefined;
		out.set(r.id, {
			id: r.id,
			title: r.title,
			priority: r.priority,
			columnId: r.columnId,
			columnTitle: col?.title ?? 'Unknown',
			boardId: col?.boardId ?? 0,
			boardName: board?.name ?? 'Unknown board',
			isComplete: col ? isCompleteColumnTitle(col.title) : false,
			milestoneId: r.milestoneId ?? null
		});
	}
	return out;
}

// ─── Dependency graph ────────────────────────────────────────────────────────

interface DepEdge {
	id: number;
	blockedId: number;
	blockerId: number;
	createdByUserId: number | null;
	createdAt: string;
}

interface DependencyGraph {
	edges: DepEdge[];
	/** blocked card id → the edges that block it */
	blockedBy: Map<number, DepEdge[]>;
	/** blocker card id → the edges it blocks */
	blocks: Map<number, DepEdge[]>;
}

/**
 * Load every dependency edge into adjacency maps.
 *
 * The whole table is read in one go on purpose: it is small — one row per
 * ordering decision somebody actually made, not one per card — and cycle
 * detection, downstream counts and the critical path all walk it repeatedly.
 * Paging it would cost more queries than it saves rows.
 */
function loadDependencyGraph(): DependencyGraph {
	const edges = db
		.select({
			id: cardDependencies.id,
			blockedId: cardDependencies.cardId,
			blockerId: cardDependencies.dependsOnCardId,
			createdByUserId: cardDependencies.createdByUserId,
			createdAt: cardDependencies.createdAt
		})
		.from(cardDependencies)
		.all() as DepEdge[];

	const blockedBy = new Map<number, DepEdge[]>();
	const blocks = new Map<number, DepEdge[]>();

	for (const e of edges) {
		if (!blockedBy.has(e.blockedId)) blockedBy.set(e.blockedId, []);
		blockedBy.get(e.blockedId)!.push(e);
		if (!blocks.has(e.blockerId)) blocks.set(e.blockerId, []);
		blocks.get(e.blockerId)!.push(e);
	}

	return { edges, blockedBy, blocks };
}

/**
 * Would adding "blockerId blocks blockedId" close a loop?
 *
 * A cycle appears exactly when the proposed blocker is already reachable
 * downstream of the card it would block — i.e. blockedId already blocks
 * blockerId, directly or through a chain. Returns that chain as card ids
 * (blockedId … blockerId) so the API can name the cycle it rejected, or null
 * when the edge is safe.
 */
export function findDependencyCycle(blockedId: number, blockerId: number): number[] | null {
	if (blockedId === blockerId) return [blockedId, blockerId];

	const { blocks } = loadDependencyGraph();
	const seen = new Set<number>([blockedId]);
	const path: number[] = [blockedId];

	function walk(current: number): boolean {
		for (const edge of blocks.get(current) ?? []) {
			const next = edge.blockedId;
			if (next === blockerId) {
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
	}

	return walk(blockedId) ? path : null;
}

/** Blocked-by and blocks for a single card, each end resolved to a live card. */
export function getCardDependencies(cardId: number): CardDependencyState {
	const { blockedBy, blocks } = loadDependencyGraph();
	const inEdges = blockedBy.get(cardId) ?? [];
	const outEdges = blocks.get(cardId) ?? [];

	const needed = [...inEdges.map((e) => e.blockerId), ...outEdges.map((e) => e.blockedId)];
	const byId = loadPlanCards([...new Set(needed)]);

	const toRef = (edge: DepEdge, otherId: number): DependencyRef | null => {
		const card = byId.get(otherId);
		if (!card) return null; // archived or deleted — not a live dependency
		return {
			...card,
			dependencyId: edge.id,
			createdByUserId: edge.createdByUserId,
			createdAt: edge.createdAt
		};
	};

	const blockedByRefs = inEdges
		.map((e) => toRef(e, e.blockerId))
		.filter((r): r is DependencyRef => !!r);
	const blocksRefs = outEdges
		.map((e) => toRef(e, e.blockedId))
		.filter((r): r is DependencyRef => !!r);
	const openBlockerIds = blockedByRefs.filter((r) => !r.isComplete).map((r) => r.id);

	return {
		blockedBy: blockedByRefs,
		blocks: blocksRefs,
		isBlocked: openBlockerIds.length > 0,
		openBlockerIds
	};
}

/**
 * Open blockers for a set of cards, in one pass.
 *
 * A view renders hundreds of card faces — the board a board's worth, All Tasks
 * every board at once — and asking per card would be hundreds of round trips.
 * So a loader calls this once with the ids it already has and hands each card
 * its entry. Cards with nothing open blocking them are absent from the map,
 * which keeps the payload proportional to what is actually blocked rather than
 * to how many cards exist.
 *
 * Cross-board by construction: a blocker is resolved wherever it lives, so the
 * same call serves one board or all of them.
 */
export function getBlockedStateForCards(cardIds: number[]): Record<number, PlanCard[]> {
	if (cardIds.length === 0) return {};

	const { blockedBy } = loadDependencyGraph();
	const wanted = new Set(cardIds);

	// Resolve only the blockers actually referenced by these cards, not every
	// card in the workspace.
	const blockerIds = new Set<number>();
	for (const [blockedId, edges] of blockedBy) {
		if (!wanted.has(blockedId)) continue;
		for (const e of edges) blockerIds.add(e.blockerId);
	}
	if (blockerIds.size === 0) return {};

	const blockerCards = loadPlanCards([...blockerIds]);

	const out: Record<number, PlanCard[]> = {};
	for (const cardId of cardIds) {
		const open = (blockedBy.get(cardId) ?? [])
			.map((e) => blockerCards.get(e.blockerId))
			.filter((c): c is PlanCard => !!c && !c.isComplete);
		if (open.length > 0) out[cardId] = open;
	}
	return out;
}

/** Open blockers for every live card on one board. */
export function getBoardBlockedState(boardId: number): Record<number, PlanCard[]> {
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

	return getBlockedStateForCards(boardCardIds);
}

// ─── Milestone planning ──────────────────────────────────────────────────────

const PRIORITY_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

function weightOf(priority: string): number {
	return PRIORITY_WEIGHT[priority] ?? 2;
}

/**
 * Build the whole planning picture for one milestone.
 *
 * Node set = the milestone's cards, plus any card outside the milestone that
 * directly blocks one of them (marked `external`). Those have to be in the
 * graph: a card whose only blocker sits on another board is not actionable, and
 * a view that hid the blocker would quietly claim that it was.
 */
export function getMilestoneSummary(milestoneId: number): MilestoneSummary | null {
	const milestone = db.select().from(milestones).where(eq(milestones.id, milestoneId)).get();
	if (!milestone) return null;

	const memberIds = db
		.select({ id: cards.id })
		.from(cards)
		.where(and(eq(cards.milestoneId, milestoneId), isNull(cards.archivedAt)))
		.all()
		.map((c) => c.id);

	const { blockedBy } = loadDependencyGraph();
	const memberSet = new Set(memberIds);

	// Pull in direct external blockers so "actionable" tells the truth.
	const externalIds = new Set<number>();
	for (const id of memberIds) {
		for (const e of blockedBy.get(id) ?? []) {
			if (!memberSet.has(e.blockerId)) externalIds.add(e.blockerId);
		}
	}

	const byId = loadPlanCards([...memberIds, ...externalIds]);
	const nodeIds = [...memberIds, ...externalIds].filter((id) => byId.has(id));
	const nodeSet = new Set(nodeIds);

	// Keep only edges with both ends in the node set.
	const edges: { from: number; to: number }[] = [];
	const blockedByIds = new Map<number, number[]>();
	const blocksIds = new Map<number, number[]>();
	for (const id of nodeIds) {
		blockedByIds.set(id, []);
		blocksIds.set(id, []);
	}
	for (const id of nodeIds) {
		for (const e of blockedBy.get(id) ?? []) {
			if (!nodeSet.has(e.blockerId)) continue;
			edges.push({ from: e.blockerId, to: id });
			blocksIds.get(e.blockerId)!.push(id);
			blockedByIds.get(id)!.push(e.blockerId);
		}
	}

	// ── Topological layering (Kahn). Each frontier is sorted so the drawn graph
	//    is stable between reloads, which matters more here than raw speed.
	const indegree = new Map<number, number>(
		nodeIds.map((id) => [id, blockedByIds.get(id)!.length])
	);
	const layers: number[][] = [];
	const layerOf = new Map<number, number>();
	const placed = new Set<number>();
	let frontier = nodeIds.filter((id) => indegree.get(id) === 0).sort((a, b) => a - b);

	while (frontier.length > 0) {
		layers.push(frontier);
		for (const id of frontier) {
			layerOf.set(id, layers.length - 1);
			placed.add(id);
		}
		const next: number[] = [];
		for (const id of frontier) {
			for (const child of blocksIds.get(id)!) {
				const left = (indegree.get(child) ?? 0) - 1;
				indegree.set(child, left);
				if (left === 0) next.push(child);
			}
		}
		frontier = next.sort((a, b) => a - b);
	}

	// A cycle would strand nodes here. The API rejects cycles on insert, so this
	// only fires on rows that predate the check — park the stragglers in a final
	// layer rather than dropping them off the view entirely.
	const stranded = nodeIds.filter((id) => !placed.has(id));
	if (stranded.length > 0) {
		log.warn(`Milestone ${milestoneId}: ${stranded.length} card(s) caught in a dependency cycle`);
		const tailLayer = stranded.sort((a, b) => a - b);
		layers.push(tailLayer);
		for (const id of tailLayer) layerOf.set(id, layers.length - 1);
	}

	const topoOrder = layers.flat();

	// ── Downstream reach: how many open cards finishing this one frees up.
	//    Walked in reverse topological order so each node reuses its children's
	//    sets instead of re-walking the graph from every node.
	const reach = new Map<number, Set<number>>();
	for (let i = topoOrder.length - 1; i >= 0; i--) {
		const id = topoOrder[i];
		const set = new Set<number>();
		for (const child of blocksIds.get(id) ?? []) {
			if (!byId.get(child)?.isComplete) set.add(child);
			for (const d of reach.get(child) ?? []) set.add(d);
		}
		reach.set(id, set);
	}

	// ── Critical path: the longest chain of OPEN dependencies, by card count.
	//    Complete cards are excluded — the chain that cannot slip is made of
	//    work still to do, and a finished prerequisite adds no risk.
	const openIds = topoOrder.filter((id) => !byId.get(id)!.isComplete);
	const openSet = new Set(openIds);
	const best = new Map<number, { length: number; weight: number; prev: number | null }>();

	for (const id of openIds) {
		const own = weightOf(byId.get(id)!.priority);
		let chosen: { length: number; weight: number; prev: number | null } = {
			length: 1,
			weight: own,
			prev: null
		};
		for (const parent of blockedByIds.get(id) ?? []) {
			if (!openSet.has(parent)) continue;
			const p = best.get(parent);
			if (!p) continue; // parent stranded by a cycle — skip rather than guess
			const cand = { length: p.length + 1, weight: p.weight + own, prev: parent };
			// Longest wins; ties break on accumulated priority, then on the lower
			// card id so the highlighted chain does not jitter between reloads.
			const better =
				cand.length > chosen.length ||
				(cand.length === chosen.length && cand.weight > chosen.weight) ||
				(cand.length === chosen.length &&
					cand.weight === chosen.weight &&
					chosen.prev !== null &&
					parent < chosen.prev);
			if (better) chosen = cand;
		}
		best.set(id, chosen);
	}

	let tail: number | null = null;
	for (const id of openIds) {
		const b = best.get(id)!;
		if (tail === null) {
			tail = id;
			continue;
		}
		const t = best.get(tail)!;
		if (b.length > t.length || (b.length === t.length && b.weight > t.weight)) tail = id;
	}

	const criticalPath: number[] = [];
	let cursor: number | null = tail;
	while (cursor !== null) {
		criticalPath.unshift(cursor);
		cursor = best.get(cursor)?.prev ?? null;
	}
	// A single card with nothing open on either side is not a path worth
	// highlighting — it is just the next thing to do, and it shows up there.
	const criticalSet = new Set(criticalPath.length > 1 ? criticalPath : []);

	// ── Assemble nodes.
	const nodes: MilestoneNode[] = nodeIds.map((id) => {
		const card = byId.get(id)!;
		const openBlockers = (blockedByIds.get(id) ?? []).filter((b) => !byId.get(b)!.isComplete);
		return {
			...card,
			external: !memberSet.has(id),
			layer: layerOf.get(id) ?? 0,
			blockedByIds: blockedByIds.get(id) ?? [],
			blocksIds: blocksIds.get(id) ?? [],
			openBlockerIds: openBlockers,
			downstreamCount: reach.get(id)?.size ?? 0,
			onCriticalPath: criticalSet.has(id)
		};
	});
	const nodeById = new Map(nodes.map((n) => [n.id, n]));

	// ── Next actionable: in the milestone, not done, nothing open blocking it.
	//    Sorted by how much it unblocks, because on a one- or two-person team the
	//    card that frees the most downstream work is the one worth starting.
	const nextActionable = nodes
		.filter((n) => !n.external && !n.isComplete && n.openBlockerIds.length === 0)
		.sort(
			(a, b) =>
				b.downstreamCount - a.downstreamCount ||
				weightOf(b.priority) - weightOf(a.priority) ||
				a.id - b.id
		);

	const blocked = nodes
		.filter((n) => !n.external && !n.isComplete && n.openBlockerIds.length > 0)
		.sort((a, b) => a.openBlockerIds.length - b.openBlockerIds.length || a.id - b.id)
		.map((n) => ({ card: n, blockers: n.openBlockerIds.map((id) => byId.get(id)!) }));

	// Milestone cards with no ordering recorded at all — surfaced as a parallel
	// group so a card can never be invisible just because nobody sequenced it.
	const unordered = nodes
		.filter((n) => !n.external && n.blockedByIds.length === 0 && n.blocksIds.length === 0)
		.map((n) => n.id);

	// ── Progress. Counts cover the milestone's own cards only; external blockers
	//    are context, not scope.
	const memberNodes = nodes.filter((n) => !n.external);
	const byColumnMap = new Map<string, number>();
	for (const n of memberNodes) {
		byColumnMap.set(n.columnTitle, (byColumnMap.get(n.columnTitle) ?? 0) + 1);
	}

	const boardMap = new Map<number, { id: number; name: string; cardCount: number }>();
	for (const n of memberNodes) {
		const entry = boardMap.get(n.boardId) ?? { id: n.boardId, name: n.boardName, cardCount: 0 };
		entry.cardCount++;
		boardMap.set(n.boardId, entry);
	}

	const liveMemberIds = memberNodes.map((n) => n.id);
	const openSubtasks = liveMemberIds.length
		? db
				.select({ id: subtasks.id })
				.from(subtasks)
				.where(and(inArray(subtasks.cardId, liveMemberIds), eq(subtasks.completed, false)))
				.all().length
		: 0;

	const done = memberNodes.filter((n) => n.isComplete).length;

	return {
		milestone,
		progress: {
			total: memberNodes.length,
			done,
			percent: memberNodes.length === 0 ? 0 : Math.round((done / memberNodes.length) * 100),
			byColumn: [...byColumnMap.entries()].map(([columnTitle, count]) => ({ columnTitle, count })),
			openSubtasks,
			boards: [...boardMap.values()].sort((a, b) => b.cardCount - a.cardCount)
		},
		graph: { nodes, edges, layers, unordered },
		criticalPath: criticalPath.length > 1 ? criticalPath : [],
		nextActionable,
		blocked: blocked.map((b) => ({ card: nodeById.get(b.card.id)!, blockers: b.blockers }))
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

export interface UnblockedCard {
	cardId: number;
	title: string;
	boardId: number;
}

/**
 * Called after a card lands in a Complete column.
 *
 * Finds the cards that were waiting on it and now have nothing open blocking
 * them, drops a system comment on each ("Unblocked: #123 completed") and hands
 * the list back so the caller can notify their assignees. Never throws into the
 * move handler — a failed comment must not fail the move.
 */
export function onCardCompleted(completedCardId: number, actorUserId: number): UnblockedCard[] {
	try {
		const { blockedBy, blocks } = loadDependencyGraph();
		const dependents = (blocks.get(completedCardId) ?? []).map((e) => e.blockedId);
		if (dependents.length === 0) return [];

		const completed = loadPlanCards([completedCardId]).get(completedCardId);
		if (!completed) return [];

		// One load covering the dependents and all of their blockers.
		const needed = new Set<number>(dependents);
		for (const id of dependents) {
			for (const e of blockedBy.get(id) ?? []) needed.add(e.blockerId);
		}
		const byId = loadPlanCards([...needed]);

		const unblocked: UnblockedCard[] = [];

		for (const id of dependents) {
			const card = byId.get(id);
			if (!card || card.isComplete) continue;

			const stillOpen = (blockedBy.get(id) ?? []).filter((e) => {
				const blocker = byId.get(e.blockerId);
				return blocker && !blocker.isComplete;
			});
			if (stillOpen.length > 0) continue;

			db.insert(cardComments)
				.values({
					cardId: id,
					userId: actorUserId,
					content: `Unblocked: #${completedCardId} "${completed.title}" completed — nothing is blocking this card now.`
				})
				.run();

			unblocked.push({ cardId: id, title: card.title, boardId: card.boardId });
		}

		return unblocked;
	} catch (err) {
		log.error(`Unblock hook failed for card ${completedCardId}`, err);
		return [];
	}
}

/**
 * The full unblock reaction: system comment, assignee email, board refresh.
 *
 * Three code paths complete a card — drag-and-drop (`/api/cards/reorder`), the
 * card PUT (`/api/cards/:id`) and the API move (`/api/v1/cards/:id/move`) — so
 * the reaction lives here and each of them calls it in one line. Swallows its
 * own errors: a card that has genuinely been completed must not fail to move
 * because an email bounced.
 */
export function applyUnblockEffects(
	completedCardId: number,
	actor: { id: number; username: string },
	baseUrl: string
): UnblockedCard[] {
	try {
		const unblocked = onCardCompleted(completedCardId, actor.id);
		if (unblocked.length === 0) return [];

		const completed = db
			.select({ title: cards.title })
			.from(cards)
			.where(eq(cards.id, completedCardId))
			.get();

		for (const u of unblocked) {
			notifyCardUnblocked(
				u.boardId,
				u.cardId,
				u.title,
				completedCardId,
				completed?.title ?? '',
				actor.username,
				baseUrl
			);
			// The unblocked card may well be on another board; refresh that one too
			// so its "Blocked" chip clears without a reload.
			emit(u.boardId, 'update', { type: 'card' });
		}

		return unblocked;
	} catch (err) {
		log.error(`Unblock effects failed for card ${completedCardId}`, err);
		return [];
	}
}
