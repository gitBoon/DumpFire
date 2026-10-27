<!--
  CfdChart.svelte — Cumulative Flow Diagram as a stacked area chart using SVG.

  Displays card counts per column over time. Each column is rendered as a
  stacked area layer using the column's colour. Includes X/Y axis labels
  and hover tooltips.

  Milestone 22 (card 2462, ruling h): a delivery board's Options column, sent
  only when the viewer asks for it, comes first, so its band is at the bottom
  of the stack. The top edge of the upstream band is drawn as a dashed line
  labelled "commitment point": what is above it is committed work. The chart
  stacks counts by day and is not cumulative, so the line is where the
  options end on each day, not a count of arrivals. An ideas board, all of
  whose columns are upstream, has no such line.
-->
<script lang="ts">
  import { drawnColour } from '$lib/colours';
  import { isOptionsTitle } from '$lib/column-role';

  /** `upstream`: an Options column, or a column of an ideas board (milestone 22). */
  type CfdColumn = { id: number; title: string; color: string; upstream?: boolean };
  type CfdDataPoint = { date: string; columns: { columnId: number; count: number }[] };

  let {
    columns = [],
    data = []
  }: {
    columns: CfdColumn[];
    data: CfdDataPoint[];
  } = $props();

  // Chart dimensions
  const W = 320;
  const H = 180;
  const PAD_L = 30;
  const PAD_R = 10;
  const PAD_T = 10;
  const PAD_B = 24;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  /** Calculate the maximum stacked total across all dates. */
  const maxTotal = $derived(() => {
    if (data.length === 0) return 1;
    return Math.max(1, ...data.map(d => d.columns.reduce((s, c) => s + c.count, 0)));
  });

  /** Build SVG path data for each column layer (bottom-up stacking). */
  const layers = $derived(() => {
    if (data.length === 0 || columns.length === 0) return [];
    const max = maxTotal();
    const n = data.length;
    const xStep = n > 1 ? chartW / (n - 1) : 0;

    // Build cumulative stacks (bottom = first column, top = last)
    const result: { color: string; title: string; path: string }[] = [];

    // Precompute cumulative values per date
    const cumulative: number[][] = data.map(d => {
      let cum = 0;
      return columns.map(col => {
        const entry = d.columns.find(c => c.columnId === col.id);
        cum += entry?.count || 0;
        return cum;
      });
    });

    // Render from top to bottom so the first column is on the bottom
    for (let colIdx = columns.length - 1; colIdx >= 0; colIdx--) {
      const topPoints: string[] = [];
      const bottomPoints: string[] = [];

      for (let i = 0; i < n; i++) {
        const x = PAD_L + i * xStep;
        const topY = PAD_T + chartH - (cumulative[i][colIdx] / max) * chartH;
        const bottomY = colIdx > 0
          ? PAD_T + chartH - (cumulative[i][colIdx - 1] / max) * chartH
          : PAD_T + chartH;

        topPoints.push(`${x},${topY}`);
        bottomPoints.unshift(`${x},${bottomY}`);
      }

      const path = `M${topPoints.join(' L')} L${bottomPoints.join(' L')} Z`;
      result.push({
        color: columns[colIdx].color,
        title: columns[colIdx].title,
        path
      });
    }

    return result;
  });

  /**
   * How many columns, from the bottom of the stack, are upstream: the band
   * below the commitment point. 0 with none shown; every column on an ideas
   * board, which then has no commitment point to draw.
   */
  const upstreamCount = $derived(columns.filter(col => col.upstream).length);

  /**
   * The commitment point: the top edge of the upstream band, as a line of
   * points, or null where there is no committed band above it. None with
   * fewer than two days: one day is a single point, a line of no length,
   * and its label would sit on the baseline (the S4b review's J10).
   */
  const commitmentEdge = $derived.by(() => {
    if (data.length < 2 || upstreamCount === 0 || upstreamCount === columns.length) return null;
    const max = maxTotal();
    const n = data.length;
    const xStep = n > 1 ? chartW / (n - 1) : 0;
    // The answer puts them first, at the bottom of the stack.
    const upstreamIds = new Set(columns.filter(col => col.upstream).map(col => col.id));
    const points = data.map((d, i) => {
      const below = d.columns.filter(c => upstreamIds.has(c.columnId)).reduce((s, c) => s + c.count, 0);
      return { x: PAD_L + i * xStep, y: PAD_T + chartH - (below / max) * chartH };
    });
    return { path: points.map(p => `${p.x},${p.y}`).join(' '), label: points[points.length - 1] };
  });

  /** Y-axis labels (0, mid, max). */
  const yLabels = $derived(() => {
    const max = maxTotal();
    return [
      { y: PAD_T + chartH, label: '0' },
      { y: PAD_T + chartH / 2, label: String(Math.round(max / 2)) },
      { y: PAD_T, label: String(max) }
    ];
  });

  /** X-axis date labels (first, mid, last). */
  const xLabels = $derived(() => {
    if (data.length === 0) return [];
    const n = data.length;
    const xStep = n > 1 ? chartW / (n - 1) : 0;
    const fmt = (d: string) => {
      const parts = d.split('-');
      return `${parts[2]}/${parts[1]}`;
    };

    const labels: { x: number; label: string }[] = [];
    labels.push({ x: PAD_L, label: fmt(data[0].date) });
    if (n > 2) {
      const mid = Math.floor(n / 2);
      labels.push({ x: PAD_L + mid * xStep, label: fmt(data[mid].date) });
    }
    if (n > 1) {
      labels.push({ x: PAD_L + (n - 1) * xStep, label: fmt(data[n - 1].date) });
    }
    return labels;
  });
</script>

{#if data.length > 0 && columns.length > 0}
  <div class="cfd-chart">
    <svg viewBox="0 0 {W} {H}" class="cfd-svg">
      <!-- Grid lines -->
      {#each yLabels() as yl}
        <line x1={PAD_L} y1={yl.y} x2={W - PAD_R} y2={yl.y} class="grid-line" />
        <text x={PAD_L - 4} y={yl.y + 3} class="y-label">{yl.label}</text>
      {/each}

      <!-- Stacked areas -->
      {#each layers() as layer}
        <path d={layer.path} fill="{drawnColour(layer.color)}40" stroke={drawnColour(layer.color)} stroke-width="1.5" />
      {/each}

      <!-- The commitment point: the top edge of the Options band (ruling h). -->
      {#if commitmentEdge}
        <polyline points={commitmentEdge.path} class="commitment-line" fill="none" />
        <text x={commitmentEdge.label.x} y={commitmentEdge.label.y - 3} class="commitment-label">commitment point</text>
      {/if}

      <!-- X-axis labels -->
      {#each xLabels() as xl}
        <text x={xl.x} y={H - 4} class="x-label">{xl.label}</text>
      {/each}
    </svg>

    <!-- Legend -->
    <div class="cfd-legend">
      {#each columns as col}
        <span class="cfd-legend-item">
          <span class="cfd-legend-dot" style="background: {drawnColour(col.color)}"></span>
          <!-- No "Options (Options)": the Options column is called Options (card 2527). -->
          {col.title}{col.upstream && upstreamCount < columns.length && !isOptionsTitle(col.title) ? ' (Options)' : ''}
        </span>
      {/each}
    </div>
  </div>
{:else}
  <div class="cfd-empty">No snapshot data yet. Data accumulates daily.</div>
{/if}

<style>
  .cfd-chart { margin-bottom: var(--space-md); }
  .cfd-svg { width: 100%; height: auto; display: block; }
  .grid-line { stroke: var(--glass-border); stroke-width: 0.5; stroke-dasharray: 2,2; }
  .y-label { font-size: 0.5rem; fill: var(--text-tertiary); text-anchor: end; }
  .x-label { font-size: 0.5rem; fill: var(--text-tertiary); text-anchor: middle; }
  .commitment-line { stroke: var(--text-primary); stroke-width: 1.2; stroke-dasharray: 4,2; }
  .commitment-label { font-size: 0.5rem; font-weight: 700; fill: var(--text-secondary); text-anchor: end; }

  .cfd-legend {
    display: flex; flex-wrap: wrap; gap: var(--space-xs);
    padding-top: var(--space-xs);
  }
  .cfd-legend-item {
    display: flex; align-items: center; gap: 4px;
    font-size: 0.65rem; color: var(--text-secondary); font-weight: 600;
  }
  .cfd-legend-dot {
    width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0;
  }
  .cfd-empty {
    text-align: center; padding: var(--space-md);
    color: var(--text-tertiary); font-size: 0.8rem;
  }
</style>
