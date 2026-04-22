<script lang="ts">
	/**
	 * Graph Page — Full-screen Neo4j-style workspace visualization.
	 *
	 * Loads the workspace overview (all boards + users) on mount,
	 * then lazy-loads board internals when the user clicks a board node.
	 */
	import ForceGraph from '$lib/components/graph/ForceGraph.svelte';
	import type { GraphData, GraphNode, GraphEdge } from '$lib/types/graph-types';
	import { goto } from '$app/navigation';

	let nodes = $state<GraphNode[]>([]);
	let edges = $state<GraphEdge[]>([]);
	let loading = $state(true);
	let error = $state('');
	let graphComponent = $state<ForceGraph>();

	// Track which nodes have been expanded to prevent duplicate fetches
	let expandedNodes = $state<Set<string>>(new Set());

	/** Load the workspace overview graph on mount. */
	async function loadOverview() {
		loading = true;
		error = '';
		try {
			const res = await fetch('/api/graph');
			if (!res.ok) throw new Error(`Failed to load graph: ${res.status}`);
			const data: GraphData = await res.json();
			nodes = data.nodes;
			edges = data.edges;
		} catch (e: any) {
			error = e.message || 'Failed to load graph data';
		} finally {
			loading = false;
		}
	}

	/** Lazy-load node internals when clicked (boards → columns, columns → cards). */
	async function handleExpand(nodeId: string) {
		if (expandedNodes.has(nodeId)) return;

		let url: string;
		if (nodeId.startsWith('board:')) {
			const boardId = nodeId.replace('board:', '');
			url = `/api/graph?boardId=${boardId}`;
		} else if (nodeId.startsWith('column:')) {
			const columnId = nodeId.replace('column:', '');
			url = `/api/graph?columnId=${columnId}`;
		} else {
			return;
		}

		try {
			const res = await fetch(url);
			if (!res.ok) return;
			const data: GraphData = await res.json();

			// Mark as expanded before merge to prevent duplicate clicks
			expandedNodes = new Set([...expandedNodes, nodeId]);

			// Merge into existing graph via component method
			graphComponent.mergeGraph(data.nodes, data.edges, nodeId);
		} catch {
			// Silent fail — user can retry by clicking again
		}
	}

	let expanding = $state(false);

	/** Expand everything — boards first, then columns, with staggered delays. */
	async function expandAll() {
		if (!graphComponent || expanding) return;
		expanding = true;

		// Phase 1: expand all board nodes
		const boardNodes = nodes.filter(n => n.type === 'board');
		for (const board of boardNodes) {
			if (!expandedNodes.has(board.id)) {
				await handleExpand(board.id);
				await new Promise(r => setTimeout(r, 300));
			}
		}

		// Phase 2: expand all column nodes (now loaded from phase 1)
		// Need to read current simNodes from the component to find columns
		await new Promise(r => setTimeout(r, 500));
		const currentNodes = graphComponent.getNodes();
		const columnNodes = currentNodes.filter((n: any) => n.type === 'column' && !n.expanded);
		for (const col of columnNodes) {
			if (!expandedNodes.has(col.id)) {
				await handleExpand(col.id);
				await new Promise(r => setTimeout(r, 200));
			}
		}

		expanding = false;
	}

	// Auto-load on mount
	$effect(() => {
		loadOverview();
	});
</script>

<svelte:head>
	<title>Graph View — DumpFire</title>
</svelte:head>

<div class="graph-page">
	<!-- Top bar -->
	<header class="graph-header">
		<div class="graph-header-left">
			<a href="/" class="back-btn" title="Back to Dashboard">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</a>
			<span class="graph-title-icon">🔗</span>
			<h1>Graph View</h1>
			<span class="graph-subtitle">Workspace relationships</span>
		</div>
		<div class="graph-header-right">
			<!-- Legend -->
			<div class="graph-legend">
				<span class="legend-item"><span class="legend-dot" style="background: var(--accent-purple)"></span>Board</span>
				<span class="legend-item"><span class="legend-dot" style="background: var(--accent-cyan)"></span>Card</span>
				<span class="legend-item"><span class="legend-dot" style="background: var(--accent-amber)"></span>Column</span>
				<span class="legend-item"><span class="legend-dot" style="background: var(--accent-emerald)"></span>User</span>
			</div>
			<button class="btn-ghost" onclick={loadOverview} title="Reset graph">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 7a4.5 4.5 0 0 1 8.5-2M11.5 7a4.5 4.5 0 0 1-8.5 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M11 2v3h-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12V9h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
				Reset
			</button>
			<button class="btn-ghost" onclick={expandAll} disabled={expanding} title="Expand all boards and columns">
				{#if expanding}
					<div class="btn-spinner"></div>
					Expanding…
				{:else}
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 5l5 5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
					Expand All
				{/if}
			</button>
		</div>
	</header>

	<!-- Graph viewport -->
	<div class="graph-viewport">
		{#if loading && nodes.length === 0}
			<div class="graph-loading">
				<div class="loading-spinner"></div>
				<p>Loading workspace graph…</p>
			</div>
		{:else if error}
			<div class="graph-error">
				<span>⚠️</span>
				<p>{error}</p>
				<button class="btn-primary" onclick={loadOverview}>Retry</button>
			</div>
		{:else if nodes.length === 0}
			<div class="graph-empty">
				<span class="empty-icon">🕸️</span>
				<h3>No graph data</h3>
				<p>Create boards and cards to see the workspace graph</p>
				<a href="/" class="btn-primary">Go to Dashboard</a>
			</div>
		{:else}
			<ForceGraph bind:this={graphComponent} {nodes} {edges} onexpand={handleExpand} />
		{/if}
	</div>

	<!-- Hint overlay -->
	{#if nodes.length > 0 && !loading}
		<div class="graph-hints">
			<span>🖱️ Drag nodes</span>
			<span>🔍 Scroll to zoom</span>
			<span>✋ Drag background to pan</span>
			<span>👆 Click boards/columns to expand</span>
		</div>
	{/if}
</div>

<style>
	.graph-page {
		display: flex;
		flex-direction: column;
		height: 100vh;
		background: var(--bg-deep);
		overflow: hidden;
	}

	/* ─── Header ─────────────────────────────────────── */
	.graph-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-md) var(--space-xl);
		background: var(--bg-surface);
		border-bottom: 1px solid var(--glass-border);
		z-index: 10;
		flex-shrink: 0;
	}

	.graph-header-left {
		display: flex;
		align-items: center;
		gap: var(--space-md);
	}

	.back-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-sm);
		color: var(--text-secondary);
		transition: all 0.15s;
	}

	.back-btn:hover {
		background: var(--glass-hover);
		color: var(--text-primary);
	}

	.graph-title-icon {
		font-size: 1.3rem;
	}

	.graph-header h1 {
		font-size: 1.1rem;
		font-weight: 700;
		color: var(--text-primary);
		letter-spacing: -0.02em;
	}

	.graph-subtitle {
		font-size: 0.75rem;
		color: var(--text-tertiary);
		padding-left: var(--space-sm);
		border-left: 1px solid var(--glass-border);
	}

	.graph-header-right {
		display: flex;
		align-items: center;
		gap: var(--space-lg);
	}

	/* ─── Legend ──────────────────────────────────────── */
	.graph-legend {
		display: flex;
		gap: var(--space-md);
		font-size: 0.72rem;
		color: var(--text-secondary);
	}

	.legend-item {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.legend-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	/* ─── Viewport ───────────────────────────────────── */
	.graph-viewport {
		flex: 1;
		position: relative;
		overflow: hidden;
	}

	/* ─── States ─────────────────────────────────────── */
	.graph-loading,
	.graph-error,
	.graph-empty {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-md);
		color: var(--text-secondary);
	}

	.loading-spinner {
		width: 36px;
		height: 36px;
		border: 3px solid var(--glass-border);
		border-top-color: var(--accent-purple);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.graph-empty .empty-icon {
		font-size: 3rem;
	}

	.graph-empty h3 {
		font-size: 1.2rem;
		color: var(--text-primary);
	}

	.graph-empty p {
		font-size: 0.85rem;
	}

	/* ─── Hints ──────────────────────────────────────── */
	.graph-hints {
		position: absolute;
		bottom: var(--space-xl);
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		gap: var(--space-lg);
		padding: var(--space-sm) var(--space-lg);
		background: var(--bg-surface);
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-full);
		font-size: 0.7rem;
		color: var(--text-tertiary);
		box-shadow: var(--shadow-md);
		z-index: 10;
		animation: fadeIn 0.5s ease-out 1s both;
		pointer-events: none;
	}

	.btn-spinner {
		width: 12px;
		height: 12px;
		border: 2px solid var(--glass-border);
		border-top-color: var(--accent-purple);
		border-radius: 50%;
		animation: spin 0.6s linear infinite;
	}
</style>
