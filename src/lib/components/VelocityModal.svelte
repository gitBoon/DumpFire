<!--
  VelocityModal.svelte — Full personal velocity graph with time-range filters.

  Opened from the dashboard's Velocity stat card. Fetches bucketed completion
  counts from /api/velocity and renders them as an SVG bar chart following the
  CfdChart conventions (fixed viewBox, CSS-var themed grid and labels).
-->
<script lang="ts">
	type VelocityBucket = { start: string; label: string; count: number };
	type VelocityData = {
		days: number;
		bucketDays: number;
		buckets: VelocityBucket[];
		summary: {
			total: number;
			prevTotal: number;
			trendPct: number | null;
			avgPerWeek: number;
			best: { label: string; count: number };
		};
	};

	let { onclose }: { onclose: () => void } = $props();

	const RANGES = [
		{ label: '2W', days: 14 },
		{ label: '4W', days: 28 },
		{ label: '3M', days: 91 },
		{ label: '6M', days: 182 },
		{ label: '1Y', days: 365 }
	];

	let range = $state(28);
	let loading = $state(true);
	let data = $state<VelocityData | null>(null);

	async function load(days: number) {
		loading = true;
		try {
			const res = await fetch(`/api/velocity?days=${days}`);
			if (res.ok) data = await res.json();
		} catch { /* silent */ }
		loading = false;
	}

	$effect(() => {
		load(range);
	});

	// Chart dimensions
	const W = 640;
	const H = 240;
	const PAD_L = 36;
	const PAD_R = 12;
	const PAD_T = 14;
	const PAD_B = 28;
	const chartW = W - PAD_L - PAD_R;
	const chartH = H - PAD_T - PAD_B;

	const maxCount = $derived(data ? Math.max(1, ...data.buckets.map(b => b.count)) : 1);

	const bars = $derived(() => {
		if (!data) return [];
		const n = data.buckets.length;
		const slot = chartW / n;
		const barW = Math.max(2, Math.min(28, slot * 0.7));
		return data.buckets.map((b, i) => ({
			x: PAD_L + i * slot + (slot - barW) / 2,
			y: PAD_T + chartH - (b.count / maxCount) * chartH,
			w: barW,
			h: (b.count / maxCount) * chartH,
			bucket: b
		}));
	});

	/** Average line height (per-bucket average across the range). */
	const avgY = $derived(() => {
		if (!data || data.summary.total === 0) return null;
		const avgPerBucket = data.summary.total / data.buckets.length;
		return PAD_T + chartH - (avgPerBucket / maxCount) * chartH;
	});

	const yLabels = $derived([
		{ y: PAD_T + chartH, label: '0' },
		{ y: PAD_T + chartH / 2, label: String(Math.ceil(maxCount / 2)) },
		{ y: PAD_T, label: String(maxCount) }
	]);

	/** Label every nth bucket so long ranges stay legible. */
	const xLabels = $derived(() => {
		if (!data) return [];
		const n = data.buckets.length;
		const slot = chartW / n;
		const every = Math.max(1, Math.ceil(n / 8));
		return data.buckets
			.map((b, i) => ({ x: PAD_L + i * slot + slot / 2, label: b.label, idx: i }))
			.filter(l => l.idx % every === 0);
	});

	function bucketTitle(b: VelocityBucket): string {
		if (!data) return '';
		const unit = data.bucketDays === 1 ? '' : ' (week)';
		return `${b.label}${unit}: ${b.count} completed`;
	}
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onclose(); }} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={onclose}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal-content velocity-modal" onclick={(e) => e.stopPropagation()} role="document">
		<div class="vm-header">
			<div class="vm-header-left">
				<span class="vm-icon">🚀</span>
				<div>
					<h2>Velocity</h2>
					<p class="vm-subtitle">Tasks you completed over time</p>
				</div>
			</div>
			<button class="vm-close" onclick={onclose}>✕</button>
		</div>

		<div class="vm-ranges">
			{#each RANGES as r}
				<button class="vm-range-pill" class:active={range === r.days} onclick={() => (range = r.days)}>
					{r.label}
				</button>
			{/each}
		</div>

		{#if loading}
			<div class="vm-loading">
				<span class="spinner vm-spinner"></span>
				<span>Loading velocity…</span>
			</div>
		{:else if data}
			<div class="vm-stats">
				<div class="vm-stat">
					<span class="vm-stat-value">{data.summary.total}</span>
					<span class="vm-stat-label">completed</span>
				</div>
				<div class="vm-stat">
					<span class="vm-stat-value">{data.summary.avgPerWeek}</span>
					<span class="vm-stat-label">avg / week</span>
				</div>
				<div class="vm-stat">
					<span class="vm-stat-value">{data.summary.best.count}</span>
					<span class="vm-stat-label">best {data.bucketDays === 1 ? 'day' : 'week'} ({data.summary.best.label})</span>
				</div>
				{#if data.summary.trendPct !== null}
					<div class="vm-stat">
						<span class="vm-stat-value" class:trend-up={data.summary.trendPct >= 0} class:trend-down={data.summary.trendPct < 0}>
							{data.summary.trendPct >= 0 ? '↑' : '↓'} {Math.abs(data.summary.trendPct)}%
						</span>
						<span class="vm-stat-label">vs previous {range} days</span>
					</div>
				{/if}
			</div>

			{#if data.summary.total === 0}
				<div class="vm-empty">
					<span class="vm-empty-icon">🌱</span>
					<p>No completions in this period.</p>
					<p class="vm-empty-sub">Completed tasks assigned to you will show up here.</p>
				</div>
			{:else}
				<svg viewBox="0 0 {W} {H}" class="vm-svg">
					{#each yLabels as yl}
						<line x1={PAD_L} y1={yl.y} x2={W - PAD_R} y2={yl.y} class="vm-grid-line" />
						<text x={PAD_L - 6} y={yl.y + 3} class="vm-y-label">{yl.label}</text>
					{/each}

					{#each bars() as bar}
						<rect
							x={bar.x} y={bar.y} width={bar.w} height={bar.h}
							rx="2" class="vm-bar" class:vm-bar-empty={bar.bucket.count === 0}
						>
							<title>{bucketTitle(bar.bucket)}</title>
						</rect>
					{/each}

					{#if avgY() !== null}
						<line x1={PAD_L} y1={avgY()} x2={W - PAD_R} y2={avgY()} class="vm-avg-line" />
					{/if}

					{#each xLabels() as xl}
						<text x={xl.x} y={H - 8} class="vm-x-label">{xl.label}</text>
					{/each}
				</svg>
				<div class="vm-legend">
					<span class="vm-legend-item"><span class="vm-legend-swatch"></span> completed per {data.bucketDays === 1 ? 'day' : 'week'}</span>
					<span class="vm-legend-item"><span class="vm-legend-avg"></span> period average</span>
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.velocity-modal {
		width: min(720px, 92vw);
		max-height: 86vh;
		overflow-y: auto;
	}

	.vm-header {
		display: flex; align-items: flex-start; justify-content: space-between;
		margin-bottom: var(--space-md);
	}
	.vm-header-left { display: flex; align-items: center; gap: var(--space-md); }
	.vm-icon { font-size: 1.6rem; }
	.vm-header h2 { margin: 0; font-size: 1.1rem; }
	.vm-subtitle { margin: 0; font-size: 0.75rem; color: var(--text-tertiary); }
	.vm-close {
		background: none; border: none; cursor: pointer;
		color: var(--text-tertiary); font-size: 1rem;
		padding: 4px 8px; border-radius: var(--radius-sm);
		transition: all 0.15s ease;
	}
	.vm-close:hover { background: rgba(244, 63, 94, 0.15); color: var(--accent-rose); }

	.vm-ranges { display: flex; gap: var(--space-xs); margin-bottom: var(--space-md); }
	.vm-range-pill {
		background: none;
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-full);
		color: var(--text-secondary);
		font-size: 0.72rem; font-weight: 700;
		padding: 4px 12px; cursor: pointer;
		transition: all 0.15s ease;
	}
	.vm-range-pill:hover { border-color: var(--accent-cyan); color: var(--text-primary); }
	.vm-range-pill.active {
		background: var(--accent-cyan);
		border-color: var(--accent-cyan);
		color: #fff;
	}

	.vm-stats {
		display: flex; flex-wrap: wrap; gap: var(--space-lg);
		margin-bottom: var(--space-md);
	}
	.vm-stat { display: flex; flex-direction: column; }
	.vm-stat-value { font-size: 1.25rem; font-weight: 800; color: var(--text-primary); }
	.vm-stat-value.trend-up { color: var(--accent-emerald); }
	.vm-stat-value.trend-down { color: var(--accent-rose); }
	.vm-stat-label { font-size: 0.65rem; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }

	.vm-svg { width: 100%; height: auto; display: block; }
	.vm-grid-line { stroke: var(--glass-border); stroke-width: 0.5; stroke-dasharray: 2,2; }
	.vm-y-label { font-size: 0.55rem; fill: var(--text-tertiary); text-anchor: end; }
	.vm-x-label { font-size: 0.55rem; fill: var(--text-tertiary); text-anchor: middle; }
	.vm-bar { fill: var(--accent-cyan); opacity: 0.85; }
	.vm-bar:hover { opacity: 1; }
	.vm-bar-empty { opacity: 0.25; }
	.vm-avg-line { stroke: var(--accent-amber); stroke-width: 1.2; stroke-dasharray: 5,4; }

	.vm-legend { display: flex; gap: var(--space-lg); padding-top: var(--space-sm); }
	.vm-legend-item {
		display: flex; align-items: center; gap: 6px;
		font-size: 0.65rem; color: var(--text-secondary); font-weight: 600;
	}
	.vm-legend-swatch { width: 10px; height: 10px; border-radius: 2px; background: var(--accent-cyan); }
	.vm-legend-avg { width: 14px; height: 0; border-top: 2px dashed var(--accent-amber); }

	.vm-loading {
		display: flex; align-items: center; justify-content: center; gap: var(--space-sm);
		padding: var(--space-2xl); color: var(--text-tertiary); font-size: 0.85rem;
		min-height: 200px;
	}

	.vm-empty { text-align: center; padding: var(--space-2xl); }
	.vm-empty-icon { font-size: 2rem; display: block; margin-bottom: var(--space-sm); }
	.vm-empty p { margin: 0; color: var(--text-secondary); }
	.vm-empty-sub { font-size: 0.75rem; color: var(--text-tertiary); }
</style>
