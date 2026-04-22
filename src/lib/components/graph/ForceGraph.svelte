<script lang="ts">
	/**
	 * ForceGraph.svelte — Neo4j-style force-directed graph renderer.
	 *
	 * Uses d3-force for physics simulation and pure SVG for rendering.
	 * Supports pan, zoom, drag, hover tooltips, and lazy-load expansion.
	 *
	 * Architecture:
	 * - d3-force calculates (x, y) positions each tick
	 * - Svelte reactively renders nodes/edges as SVG elements
	 * - User interactions (drag, zoom, click) update simulation or viewport
	 */
	import { onMount, onDestroy } from 'svelte';
	import {
		forceSimulation,
		forceLink,
		forceManyBody,
		forceCenter,
		forceCollide
	} from 'd3-force';
	import type { GraphNode, GraphEdge, SimNode, SimEdge } from '$lib/types/graph-types';

	// ─── Props ────────────────────────────────────────────────────────────────

	let {
		nodes: initialNodes = [],
		edges: initialEdges = [],
		onexpand
	}: {
		nodes: GraphNode[];
		edges: GraphEdge[];
		onexpand?: (nodeId: string) => void;
	} = $props();

	// ─── Reactive State ──────────────────────────────────────────────────────

	let simNodes = $state<SimNode[]>([]);
	let simEdges = $state<SimEdge[]>([]);
	let tick = $state(0); // Incremented each simulation tick to trigger re-render

	// Viewport (pan & zoom)
	let viewBox = $state({ x: -600, y: -400, w: 1200, h: 800 });
	let isPanning = $state(false);
	let panStart = { x: 0, y: 0, vx: 0, vy: 0 };

	// Drag
	let dragNode = $state<SimNode | null>(null);

	// Hover tooltip
	let hoveredNode = $state<SimNode | null>(null);
	let tooltipPos = $state({ x: 0, y: 0 });

	// SVG element ref
	let svgEl: SVGSVGElement;

	// ─── Simulation ──────────────────────────────────────────────────────────

	let simulation: any = null;

	function initSimulation() {
		// Assign initial positions (wider scatter for breathing room)
		simNodes = initialNodes.map((n, i) => ({
			...n,
			x: (Math.random() - 0.5) * 1000,
			y: (Math.random() - 0.5) * 700,
			expanded: false
		}));

		simEdges = initialEdges
			.filter(e => {
				// Only include edges where both source and target exist
				return simNodes.some(n => n.id === e.source) &&
					simNodes.some(n => n.id === e.target);
			})
			.map(e => ({ ...e }));

		simulation = forceSimulation<SimNode>(simNodes)
			.force('link', forceLink<SimNode, any>(simEdges as any)
				.id((d: any) => (d as SimNode).id)
				.distance(180)
				.strength(0.3)
			)
			.force('charge', forceManyBody<SimNode>().strength(-600).distanceMax(800))
			.force('center', forceCenter<SimNode>(0, 0).strength(0.03))
			.force('collide', forceCollide<SimNode>().radius(60).strength(0.8))
			.alphaDecay(0.015)
			.on('tick', () => {
				// Trigger Svelte re-render by incrementing tick counter
				tick++;
			});
	}

	/** Merge new nodes/edges into the existing simulation (for lazy-load expansion). */
	export function mergeGraph(newNodes: GraphNode[], newEdges: GraphEdge[], expandedNodeId: string) {
		const existingIds = new Set(simNodes.map(n => n.id));

		// Find the expanded node's position for spawning new nodes nearby
		const parent = simNodes.find(n => n.id === expandedNodeId);
		const px = parent?.x ?? 0;
		const py = parent?.y ?? 0;

		// Mark the parent as expanded
		if (parent) parent.expanded = true;

		// Add new nodes (skip duplicates)
		const addedNodes: SimNode[] = [];
		for (const n of newNodes) {
			if (!existingIds.has(n.id)) {
				const sn: SimNode = {
					...n,
					x: px + (Math.random() - 0.5) * 200,
					y: py + (Math.random() - 0.5) * 200,
					expanded: false
				};
				simNodes.push(sn);
				addedNodes.push(sn);
				existingIds.add(n.id);
			}
		}

		// Add new edges (skip duplicates)
		const edgeKey = (e: { source: string | SimNode; target: string | SimNode }) => {
			const s = typeof e.source === 'string' ? e.source : e.source.id;
			const t = typeof e.target === 'string' ? e.target : e.target.id;
			return `${s}->${t}`;
		};
		const existingEdgeKeys = new Set(simEdges.map(edgeKey));

		for (const e of newEdges) {
			const key = `${e.source}->${e.target}`;
			if (!existingEdgeKeys.has(key) && existingIds.has(e.source) && existingIds.has(e.target)) {
				simEdges.push({ ...e });
				existingEdgeKeys.add(key);
			}
		}

		// Restart simulation with merged data — scale forces as graph grows
		if (simulation) {
			const count = simNodes.length;
			// Increase spacing dynamically: more nodes = more space needed
			const linkDist = Math.min(300, 180 + count * 2);
			const collideR = Math.min(100, 60 + count * 0.5);

			simulation.nodes(simNodes);
			simulation.force('link')
				?.links(simEdges)
				?.id((d: SimNode) => d.id)
				?.distance(linkDist);
			simulation.force('collide')?.radius(collideR);
			simulation.force('charge')?.strength(-600 - count * 3);
			simulation.alpha(0.6).restart();
		}
	}

	/** Expose current simulation nodes for external iteration (e.g. Expand All). */
	export function getNodes(): SimNode[] {
		return simNodes;
	}

	// ─── Node Styling ────────────────────────────────────────────────────────

	function nodeColor(type: string): string {
		switch (type) {
			case 'board': return 'var(--accent-purple)';
			case 'card': return 'var(--accent-cyan)';
			case 'column': return 'var(--accent-amber)';
			case 'user': return 'var(--accent-emerald)';
			default: return 'var(--text-tertiary)';
		}
	}

	function nodeRadius(type: string): number {
		switch (type) {
			case 'board': return 28;
			case 'card': return 18;
			case 'column': return 20;
			case 'user': return 22;
			default: return 16;
		}
	}

	/** Returns true if this node type supports expand-on-click. */
	function isExpandable(node: SimNode): boolean {
		return (node.type === 'board' || node.type === 'column') && !node.expanded;
	}

	function nodeIcon(node: SimNode): string {
		if (node.emoji) return node.emoji;
		switch (node.type) {
			case 'board': return '📋';
			case 'card': return '📝';
			case 'column': return '📊';
			case 'user': return '👤';
			default: return '•';
		}
	}

	// ─── Edge Helpers ────────────────────────────────────────────────────────

	function edgeX1(e: SimEdge): number {
		return typeof e.source === 'string' ? 0 : (e.source as SimNode).x;
	}
	function edgeY1(e: SimEdge): number {
		return typeof e.source === 'string' ? 0 : (e.source as SimNode).y;
	}
	function edgeX2(e: SimEdge): number {
		return typeof e.target === 'string' ? 0 : (e.target as SimNode).x;
	}
	function edgeY2(e: SimEdge): number {
		return typeof e.target === 'string' ? 0 : (e.target as SimNode).y;
	}

	// ─── Interaction: Drag ───────────────────────────────────────────────────

	function onNodeMouseDown(e: MouseEvent, node: SimNode) {
		e.stopPropagation();
		e.preventDefault();
		dragNode = node;
		// Pin the node
		node.fx = node.x;
		node.fy = node.y;
		simulation?.alphaTarget(0.3).restart();
	}

	function onMouseMove(e: MouseEvent) {
		if (dragNode) {
			// Convert screen coords to SVG coords
			const pt = svgToPoint(e);
			dragNode.fx = pt.x;
			dragNode.fy = pt.y;
		} else if (isPanning) {
			const dx = (e.clientX - panStart.x) * (viewBox.w / svgEl.clientWidth);
			const dy = (e.clientY - panStart.y) * (viewBox.h / svgEl.clientHeight);
			viewBox = { ...viewBox, x: panStart.vx - dx, y: panStart.vy - dy };
		}
	}

	function onMouseUp() {
		if (dragNode) {
			// Unpin after drag
			dragNode.fx = null;
			dragNode.fy = null;
			dragNode = null;
			simulation?.alphaTarget(0);
		}
		isPanning = false;
	}

	// ─── Interaction: Pan ────────────────────────────────────────────────────

	function onSvgMouseDown(e: MouseEvent) {
		// Only pan if clicking the background (not a node)
		if (e.target === svgEl || (e.target as Element).classList.contains('graph-bg')) {
			isPanning = true;
			panStart = { x: e.clientX, y: e.clientY, vx: viewBox.x, vy: viewBox.y };
		}
	}

	// ─── Interaction: Zoom ───────────────────────────────────────────────────

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		const factor = e.deltaY > 0 ? 1.1 : 0.9;
		const newW = viewBox.w * factor;
		const newH = viewBox.h * factor;
		// Zoom toward center
		const dx = (newW - viewBox.w) / 2;
		const dy = (newH - viewBox.h) / 2;
		viewBox = { x: viewBox.x - dx, y: viewBox.y - dy, w: newW, h: newH };
	}

	// ─── Interaction: Click to Expand ────────────────────────────────────────

	function onNodeClick(e: MouseEvent, node: SimNode) {
		if (isExpandable(node) && onexpand) {
			onexpand(node.id);
		}
	}

	// ─── Interaction: Hover ──────────────────────────────────────────────────

	function onNodeEnter(e: MouseEvent, node: SimNode) {
		hoveredNode = node;
		tooltipPos = { x: e.clientX, y: e.clientY };
	}

	function onNodeLeave() {
		hoveredNode = null;
	}

	// ─── SVG Coordinate Conversion ───────────────────────────────────────────

	function svgToPoint(e: MouseEvent): { x: number; y: number } {
		const rect = svgEl.getBoundingClientRect();
		const scaleX = viewBox.w / rect.width;
		const scaleY = viewBox.h / rect.height;
		return {
			x: viewBox.x + (e.clientX - rect.left) * scaleX,
			y: viewBox.y + (e.clientY - rect.top) * scaleY
		};
	}

	// ─── Lifecycle ───────────────────────────────────────────────────────────

	onMount(() => {
		if (initialNodes.length > 0) {
			initSimulation();
		}
	});

	onDestroy(() => {
		simulation?.stop();
	});

	// Watch for external data changes (initial load)
	$effect(() => {
		if (initialNodes.length > 0 && simNodes.length === 0) {
			initSimulation();
		}
	});

	// Force re-read on tick (this is the reactive bridge)
	let _ = $derived(tick);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<svg
	bind:this={svgEl}
	class="force-graph"
	viewBox="{viewBox.x} {viewBox.y} {viewBox.w} {viewBox.h}"
	onmousedown={onSvgMouseDown}
	onmousemove={onMouseMove}
	onmouseup={onMouseUp}
	onmouseleave={onMouseUp}
	onwheel={onWheel}
>
	<!-- Background for pan detection -->
	<rect class="graph-bg" x={viewBox.x} y={viewBox.y} width={viewBox.w} height={viewBox.h} fill="transparent" />

	<!-- Edge arrow marker -->
	<defs>
		<marker id="arrowhead" viewBox="0 0 10 10" refX="28" refY="5"
			markerWidth="6" markerHeight="6" orient="auto-start-reverse">
			<path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-tertiary)" opacity="0.4" />
		</marker>
		<!-- Glow filter for nodes -->
		<filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
			<feGaussianBlur stdDeviation="3" result="blur" />
			<feMerge>
				<feMergeNode in="blur" />
				<feMergeNode in="SourceGraphic" />
			</feMerge>
		</filter>
	</defs>

	<!-- Edges -->
	{#each simEdges as edge}
		<line
			class="graph-edge"
			x1={edgeX1(edge)}
			y1={edgeY1(edge)}
			x2={edgeX2(edge)}
			y2={edgeY2(edge)}
			marker-end="url(#arrowhead)"
		/>
	{/each}

	<!-- Nodes -->
	{#each simNodes as node (node.id)}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<g
			class="graph-node node-{node.type}"
			class:expandable={isExpandable(node)}
			transform="translate({node.x}, {node.y})"
			onmousedown={(e) => onNodeMouseDown(e, node)}
			onclick={(e) => onNodeClick(e, node)}
			onmouseenter={(e) => onNodeEnter(e, node)}
			onmouseleave={onNodeLeave}
			role="button"
			tabindex="-1"
		>
			<!-- Glow ring for boards -->
			{#if node.type === 'board'}
				<circle r={nodeRadius(node.type) + 4} fill="none"
					stroke={nodeColor(node.type)} stroke-width="2" opacity="0.3"
					filter="url(#glow)" />
			{/if}

			<!-- Node shape -->
			<circle
				r={nodeRadius(node.type)}
				fill={nodeColor(node.type)}
				opacity="0.15"
				stroke={nodeColor(node.type)}
				stroke-width="2"
			/>

			<!-- Icon -->
			<text
				class="node-icon"
				text-anchor="middle"
				dominant-baseline="central"
				font-size={node.type === 'board' ? '18' : '13'}
			>{nodeIcon(node)}</text>

			<!-- Label -->
			<text
				class="node-label"
				text-anchor="middle"
				y={nodeRadius(node.type) + 14}
				font-size="10"
			>{node.label.length > 20 ? node.label.slice(0, 18) + '…' : node.label}</text>

			<!-- Expand indicator for unexpanded boards/columns -->
			{#if isExpandable(node)}
				<text
					class="expand-hint"
					text-anchor="middle"
					y={nodeRadius(node.type) + 26}
					font-size="8"
				>click to expand{node.meta?.cardCount ? ` (${node.meta.cardCount})` : ''}</text>
			{/if}
		</g>
	{/each}
</svg>

<!-- Hover Tooltip -->
{#if hoveredNode}
	<div class="graph-tooltip" style="left: {tooltipPos.x + 12}px; top: {tooltipPos.y - 8}px">
		<div class="tooltip-header">
			<span class="tooltip-icon">{nodeIcon(hoveredNode)}</span>
			<span class="tooltip-type">{hoveredNode.type}</span>
		</div>
		<div class="tooltip-label">{hoveredNode.label}</div>
		{#if hoveredNode.meta?.priority}
			<div class="tooltip-meta">Priority: {hoveredNode.meta.priority}</div>
		{/if}
		{#if hoveredNode.meta?.role}
			<div class="tooltip-meta">Role: {hoveredNode.meta.role}</div>
		{/if}
		{#if hoveredNode.meta?.cardCount}
			<div class="tooltip-meta">{hoveredNode.meta.cardCount} cards</div>
		{/if}
		{#if isExpandable(hoveredNode)}
			<div class="tooltip-meta tooltip-action">Click to expand</div>
		{/if}
	</div>
{/if}

<style>
	.force-graph {
		width: 100%;
		height: 100%;
		cursor: grab;
		user-select: none;
	}

	.force-graph:active {
		cursor: grabbing;
	}

	/* ─── Edges ─────────────────────────────────────────── */
	.graph-edge {
		stroke: var(--text-tertiary);
		stroke-width: 1;
		opacity: 0.25;
		transition: opacity 0.2s;
	}

	/* ─── Nodes ─────────────────────────────────────────── */
	.graph-node {
		cursor: pointer;
		transition: filter 0.2s;
	}

	.graph-node:hover {
		filter: url(#glow);
	}

	.graph-node.expandable {
		cursor: pointer;
	}

	.graph-node.expandable:hover circle {
		stroke-width: 3;
	}

	.node-icon {
		pointer-events: none;
		fill: var(--text-primary);
	}

	.node-label {
		fill: var(--text-secondary);
		font-family: var(--font-family);
		font-weight: 500;
		pointer-events: none;
	}

	.expand-hint {
		fill: var(--text-tertiary);
		font-family: var(--font-family);
		font-style: italic;
		pointer-events: none;
		opacity: 0;
		transition: opacity 0.2s;
	}

	.graph-node.expandable:hover .expand-hint {
		opacity: 1;
	}

	/* ─── Tooltip ───────────────────────────────────────── */
	.graph-tooltip {
		position: fixed;
		z-index: 2000;
		background: var(--bg-surface);
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-md);
		padding: 8px 12px;
		box-shadow: var(--shadow-lg);
		pointer-events: none;
		max-width: 260px;
		animation: fadeIn 0.15s ease-out;
	}

	.tooltip-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 4px;
	}

	.tooltip-icon {
		font-size: 1rem;
	}

	.tooltip-type {
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-tertiary);
		font-weight: 600;
	}

	.tooltip-label {
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: 2px;
	}

	.tooltip-meta {
		font-size: 0.72rem;
		color: var(--text-tertiary);
	}

	.tooltip-action {
		color: var(--accent-purple);
		font-style: italic;
		margin-top: 4px;
	}
</style>
