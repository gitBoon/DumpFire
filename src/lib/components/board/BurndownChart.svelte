<!--
  BurndownChart.svelte — Line chart showing remaining cards over time.

  Displays actual remaining count vs. an ideal straight-line burndown.
  Uses inline SVG — no external charting library.
-->
<script lang="ts">
  type DataPoint = { date: string; total: number; completed: number; remaining: number };

  let {
    data = []
  }: {
    data: DataPoint[];
  } = $props();

  const W = 320;
  const H = 160;
  const PAD_L = 30;
  const PAD_R = 10;
  const PAD_T = 10;
  const PAD_B = 24;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  /** Max value for Y axis (total cards on day 1). */
  const maxY = $derived(() => {
    if (data.length === 0) return 1;
    return Math.max(1, ...data.map(d => d.total));
  });

  /** Actual remaining line points. */
  const actualPath = $derived(() => {
    if (data.length < 2) return '';
    const max = maxY();
    const n = data.length;
    const xStep = chartW / (n - 1);
    const points = data.map((d, i) => {
      const x = PAD_L + i * xStep;
      const y = PAD_T + chartH - (d.remaining / max) * chartH;
      return `${x},${y}`;
    });
    return `M${points.join(' L')}`;
  });

  /** Ideal burndown line (straight from start remaining to 0). */
  const idealPath = $derived(() => {
    if (data.length < 2) return '';
    const max = maxY();
    const startRemaining = data[0].remaining;
    const x1 = PAD_L;
    const y1 = PAD_T + chartH - (startRemaining / max) * chartH;
    const x2 = PAD_L + chartW;
    const y2 = PAD_T + chartH;
    return `M${x1},${y1} L${x2},${y2}`;
  });

  /** Area fill under actual line. */
  const areaPath = $derived(() => {
    if (data.length < 2) return '';
    const max = maxY();
    const n = data.length;
    const xStep = chartW / (n - 1);
    const points = data.map((d, i) => {
      const x = PAD_L + i * xStep;
      const y = PAD_T + chartH - (d.remaining / max) * chartH;
      return `${x},${y}`;
    });
    return `M${points.join(' L')} L${PAD_L + chartW},${PAD_T + chartH} L${PAD_L},${PAD_T + chartH} Z`;
  });

  /** Y-axis labels. */
  const yLabels = $derived(() => {
    const max = maxY();
    return [
      { y: PAD_T + chartH, label: '0' },
      { y: PAD_T + chartH / 2, label: String(Math.round(max / 2)) },
      { y: PAD_T, label: String(max) }
    ];
  });

  /** X-axis labels. */
  const xLabels = $derived(() => {
    if (data.length === 0) return [];
    const n = data.length;
    const xStep = n > 1 ? chartW / (n - 1) : 0;
    const fmt = (d: string) => { const p = d.split('-'); return `${p[2]}/${p[1]}`; };
    const labels: { x: number; label: string }[] = [];
    labels.push({ x: PAD_L, label: fmt(data[0].date) });
    if (n > 2) { const m = Math.floor(n/2); labels.push({ x: PAD_L + m * xStep, label: fmt(data[m].date) }); }
    if (n > 1) labels.push({ x: PAD_L + (n-1) * xStep, label: fmt(data[n-1].date) });
    return labels;
  });
</script>

{#if data.length >= 2}
  <div class="burndown-chart">
    <svg viewBox="0 0 {W} {H}" class="burndown-svg">
      <!-- Grid -->
      {#each yLabels() as yl}
        <line x1={PAD_L} y1={yl.y} x2={W - PAD_R} y2={yl.y} class="grid-line" />
        <text x={PAD_L - 4} y={yl.y + 3} class="y-label">{yl.label}</text>
      {/each}

      <!-- Ideal line -->
      <path d={idealPath()} class="ideal-line" />

      <!-- Area fill -->
      <path d={areaPath()} class="actual-area" />

      <!-- Actual line -->
      <path d={actualPath()} class="actual-line" />

      <!-- X-axis labels -->
      {#each xLabels() as xl}
        <text x={xl.x} y={H - 4} class="x-label">{xl.label}</text>
      {/each}
    </svg>
    <div class="burndown-legend">
      <span class="legend-item"><span class="legend-line actual"></span>Remaining</span>
      <span class="legend-item"><span class="legend-line ideal"></span>Ideal</span>
    </div>
  </div>
{:else}
  <div class="burndown-empty">Not enough snapshot data yet. Chart needs ≥2 days.</div>
{/if}

<style>
  .burndown-chart { margin-bottom: var(--space-md); }
  .burndown-svg { width: 100%; height: auto; display: block; }
  .grid-line { stroke: var(--glass-border); stroke-width: 0.5; stroke-dasharray: 2,2; }
  .y-label { font-size: 0.5rem; fill: var(--text-tertiary); text-anchor: end; }
  .x-label { font-size: 0.5rem; fill: var(--text-tertiary); text-anchor: middle; }
  .ideal-line { fill: none; stroke: var(--text-tertiary); stroke-width: 1; stroke-dasharray: 4,3; }
  .actual-line { fill: none; stroke: var(--accent-indigo); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .actual-area { fill: var(--accent-indigo); opacity: 0.08; }

  .burndown-legend {
    display: flex; gap: var(--space-md); padding-top: var(--space-xs);
    justify-content: center;
  }
  .legend-item {
    display: flex; align-items: center; gap: 4px;
    font-size: 0.65rem; color: var(--text-secondary); font-weight: 600;
  }
  .legend-line { width: 16px; height: 2px; border-radius: 1px; }
  .legend-line.actual { background: var(--accent-indigo); }
  .legend-line.ideal { background: var(--text-tertiary); border-top: 1px dashed var(--text-tertiary); height: 0; }
  .burndown-empty { text-align: center; padding: var(--space-md); color: var(--text-tertiary); font-size: 0.8rem; }
</style>
