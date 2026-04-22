/**
 * graph-types.ts — Shared type definitions for the Contextual Graph View.
 *
 * These types are used by both the /api/graph endpoint and the
 * ForceGraph.svelte component. Nodes use composite string IDs
 * (e.g. "board:5", "card:221") to avoid collisions across entity types.
 */

// ─── Graph Data Types ─────────────────────────────────────────────────────────

/** A node in the workspace graph. */
export type GraphNode = {
	/** Composite ID: "type:numericId", e.g. "board:5", "card:221", "user:2" */
	id: string;
	/** Entity type — determines shape, colour, and behaviour */
	type: 'board' | 'card' | 'column' | 'user';
	/** Human-readable label displayed on the node */
	label: string;
	/** Optional emoji icon (boards, users) */
	emoji?: string;
	/** Optional metadata bag for priority, status, etc. */
	meta?: Record<string, unknown>;
};

/** A directed edge connecting two nodes. */
export type GraphEdge = {
	/** Source node composite ID */
	source: string;
	/** Target node composite ID */
	target: string;
	/** Relationship label displayed on hover */
	relation: string;
};

/** The full response shape from /api/graph */
export type GraphData = {
	nodes: GraphNode[];
	edges: GraphEdge[];
};

// ─── Simulation Node (extends GraphNode with d3-force position fields) ───────

/** GraphNode with mutable position fields injected by d3-force simulation. */
export type SimNode = GraphNode & {
	x: number;
	y: number;
	vx?: number;
	vy?: number;
	fx?: number | null;
	fy?: number | null;
	/** Tracks whether this board node has been expanded (lazy-loaded). */
	expanded?: boolean;
};

/** SimEdge with resolved source/target references for d3-force. */
export type SimEdge = {
	source: SimNode | string;
	target: SimNode | string;
	relation: string;
};
