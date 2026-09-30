<!--
  Sparkline.svelte — a word-sized trend line for a table row.

  Scaled from zero, not from the row's own minimum: for remaining work the
  distance to zero IS the story, and a min-max scale would draw 40 → 38 as a
  cliff. Decorative (aria-hidden) — the row it sits in carries the numbers.
-->
<script lang="ts">
  let {
    values = [],
    width = 96,
    height = 24,
    color = '#6366f1'
  }: {
    values: number[];
    width?: number;
    height?: number;
    color?: string;
  } = $props();

  const PAD = 4;
  const max = $derived(Math.max(1, ...values));
  const points = $derived(
    values.map((v, i) => {
      const x = PAD + (values.length > 1 ? (i / (values.length - 1)) * (width - PAD * 2) : 0);
      const y = PAD + (height - PAD * 2) * (1 - v / max);
      return [x, y] as const;
    })
  );
  const path = $derived(points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(''));
  const end = $derived(points[points.length - 1]);
</script>

{#if values.length > 1}
  <svg class="sparkline" {width} {height} viewBox="0 0 {width} {height}" aria-hidden="true">
    <line class="base" x1={PAD} x2={width - PAD} y1={height - PAD} y2={height - PAD} />
    <path d={path} stroke={color} />
    {#if end}<circle cx={end[0]} cy={end[1]} r="3" fill={color} />{/if}
  </svg>
{/if}

<style>
  .sparkline { display: block; overflow: visible; }
  path { fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .base { stroke: var(--glass-border); stroke-width: 1; shape-rendering: crispEdges; }
  circle { stroke: var(--bg-base); stroke-width: 1.5; }
</style>
