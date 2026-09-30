<!--
  BurndownChart.svelte — remaining work over time, with work in play, target and forecast.

  Inline SVG, no charting library, drawn at the container's real pixel width so
  labels stay legible from the 340px stats panel to a full page.

  Burndown mode draws remaining work (line + wash) under "work in play": what
  was open when the window began plus everything added since. The gap between
  the two is what got finished, and a rise in remaining can be read as "work
  was added" rather than "nothing got done". Burn-up mode draws finished-since-
  start rising towards work in play. All-time scope is deliberately not plotted
  — on a board with history it dwarfs the open work and flattens the chart —
  and appears only in the tooltip. Either way the ideal line appears only when there is a target date —
  a line to zero on the last day of an arbitrary window means nothing — and
  the forecast continues from today at the pace of the last 28 days.

  Colours are the chart's own tokens rather than the theme accent: they were
  run through the dataviz palette validator against the light and dark
  surfaces. Scope and done sit in the colour-blind floor band, so they are never
  told apart by hue alone — done carries a wash, both carry end labels, and the
  legend names every line.
-->
<script lang="ts">
  import {
    addDays,
    daysBetween,
    finishedSinceStart,
    idealRemaining,
    summarise,
    todayUtc,
    workInPlay,
    type BurndownForecast,
    type BurndownPoint,
    type BurndownTarget,
    type Day
  } from '$lib/burndown';
  import InfoTip from '$lib/components/InfoTip.svelte';

  let {
    series = [],
    forecast = null,
    target = null,
    mode = 'burndown',
    compact = false,
    height,
    loading = false,
    label = 'Burndown',
    today = todayUtc()
  }: {
    series: BurndownPoint[];
    forecast?: BurndownForecast | null;
    target?: BurndownTarget | null;
    mode?: 'burndown' | 'burnup';
    compact?: boolean;
    height?: number;
    /** Hold the previous render, dimmed, while new data loads. */
    loading?: boolean;
    /** Names the chart for screen readers, e.g. "Burndown for DumpFire". */
    label?: string;
    today?: Day;
  } = $props();

  // ─── Geometry ────────────────────────────────────────────────────────────

  let measured = $state(0);
  // Before the first measurement (and during SSR) draw at a plausible width
  // into a viewBox, so the page never flashes an empty box.
  const W = $derived(measured || (compact ? 320 : 720));
  const H = $derived(height ?? (compact ? 170 : 300));

  const n = $derived(series.length);
  const last = $derived(n ? series[n - 1] : null);
  const first = $derived(n ? series[0] : null);

  // The window's own lines. Work in play replaces all-time scope, which on a
  // board with any history dwarfs the open work and flattens the chart.
  const remainingValues = $derived(series.map((p) => p.remaining));
  const inPlayValues = $derived(workInPlay(series));
  const finishedValues = $derived(finishedSinceStart(series));
  const lastInPlay = $derived(inPlayValues[n - 1] ?? 0);
  const lastFinished = $derived(finishedValues[n - 1] ?? 0);

  /** A forecast is drawn only when it starts from the chart's last day. */
  const projecting = $derived(
    !!forecast && !!last &&
    (forecast.status === 'converging' || forecast.status === 'not-converging') &&
    forecast.asOf === last.date
  );

  /**
   * How far past the data the x axis runs: far enough to show the target and
   * the forecast, but never so far that the history is squashed into a sliver.
   * Anything beyond that limit is pointed at from the right edge instead.
   */
  const domainEnd = $derived.by<Day>(() => {
    if (!last) return today;
    const limit = addDays(last.date, Math.max(14, Math.round(n * 1.5)));
    let end = last.date;
    const extend = (d: Day) => { const c = d > limit ? limit : d; if (c > end) end = c; };
    if (projecting) extend(addDays(last.date, Math.max(7, Math.round(n * 0.25))));
    if (projecting && forecast?.projectedDate) extend(forecast.projectedDate);
    if (target && target.date > last.date) extend(target.date);
    return end;
  });

  const span = $derived(first ? Math.max(1, daysBetween(first.date, domainEnd)) : 1);

  /** Projection of remaining from the last point, `t` days on. */
  function projectRemaining(t: number): number {
    return Math.max(0, (last?.remaining ?? 0) - (forecast?.netBurnRate ?? 0) * t);
  }
  /** Days from the last point until the projection reaches zero, if it does. */
  const zeroAt = $derived(
    projecting && forecast && forecast.netBurnRate > 0 && last
      ? last.remaining / forecast.netBurnRate
      : null
  );
  const futureDays = $derived(last ? daysBetween(last.date, domainEnd) : 0);
  const projectionDays = $derived(zeroAt !== null ? Math.min(zeroAt, futureDays) : futureDays);

  const yMax = $derived.by(() => {
    // Work in play is remaining + finished, so it tops both lines.
    let max = Math.max(1, ...inPlayValues);
    if (target && mode === 'burndown') max = Math.max(max, target.idealStart.remaining);
    if (projecting && last && forecast) {
      const end = projectionDays;
      if (mode === 'burndown') max = Math.max(max, projectRemaining(end));
      else max = Math.max(max, lastInPlay + forecast.scopeRate * end);
    }
    return niceMax(max);
  });

  const yTicks = $derived.by(() => {
    const step = niceStep(yMax, compact ? 3 : 4);
    const out: number[] = [];
    for (let v = 0; v <= yMax + 1e-9; v += step) out.push(v);
    return out;
  });

  const yLabelWidth = $derived(Math.max(...yTicks.map((v) => formatCount(v).length)) * 6.5 + 10);
  const padL = $derived(Math.max(compact ? 24 : 32, yLabelWidth));
  // End labels need room to the right of the last point unless the axis
  // already runs on into the future.
  const padR = $derived(compact ? 10 : futureDays > 0 ? 16 : 44);
  const padT = $derived(compact ? 14 : 22);
  const padB = 24;
  const plotW = $derived(Math.max(10, W - padL - padR));
  const plotH = $derived(Math.max(10, H - padT - padB));

  const x = (day: Day) => padL + (first ? daysBetween(first.date, day) / span : 0) * plotW;
  const xOffset = (fromDay: Day, t: number) => x(fromDay) + (t / span) * plotW;
  const y = (v: number) => padT + plotH - (v / yMax) * plotH;

  // ─── Paths ───────────────────────────────────────────────────────────────

  function linePath(values: number[]): string {
    if (!first) return '';
    return values.map((v, i) => `${i ? 'L' : 'M'}${x(addDays(first.date, i)).toFixed(1)},${y(v).toFixed(1)}`).join('');
  }
  function areaPath(values: number[]): string {
    if (!first || !last) return '';
    return `${linePath(values)}L${x(last.date).toFixed(1)},${y(0).toFixed(1)}L${x(first.date).toFixed(1)},${y(0).toFixed(1)}Z`;
  }

  /** Primary series for the mode: remaining for a burndown, finished for a burn-up. */
  const primaryValues = $derived(mode === 'burnup' ? finishedValues : remainingValues);

  const idealLine = $derived.by(() => {
    if (!target || mode !== 'burndown') return null;
    if (target.date <= target.idealStart.date) return null;
    return {
      x1: x(target.idealStart.date), y1: y(target.idealStart.remaining),
      x2: x(target.date), y2: y(0)
    };
  });

  /** The dashed continuation(s) from today at the recent pace. */
  const projections = $derived.by(() => {
    if (!projecting || !last || !forecast || projectionDays <= 0) return [];
    const t = projectionDays;
    const x1 = x(last.date);
    const x2 = xOffset(last.date, t);
    if (mode === 'burndown') {
      return [{ key: 'remaining', x1, y1: y(last.remaining), x2, y2: y(projectRemaining(t)) }];
    }
    return [
      { key: 'done', x1, y1: y(lastFinished), x2, y2: y(lastFinished + forecast.completionRate * t) },
      { key: 'inplay', x1, y1: y(lastInPlay), x2, y2: y(lastInPlay + forecast.scopeRate * t) }
    ];
  });

  // ─── Axes ────────────────────────────────────────────────────────────────

  const xTicks = $derived.by(() => {
    if (!first) return [] as { day: Day; label: string }[];
    return dateTicks(first.date, domainEnd, Math.max(2, Math.floor(plotW / (compact ? 58 : 72))));
  });

  const showToday = $derived(!!last && last.date === today && domainEnd > today);
  /** "Today" reads right of its line and "Target" left of its own: drop the first if they would meet. */
  const todayLabelFits = $derived(
    !target || !showToday || x(target.date) - x(today) > 130 || x(target.date) < x(today)
  );
  const targetInView = $derived(!!target && !!first && target.date >= first.date && target.date <= domainEnd);
  const targetBeyond = $derived(!!target && target.date > domainEnd);

  /**
   * The forecast's label sits beside where its line ends — at zero for a
   * converging burndown — on whichever side has room, and never on the line.
   */
  const forecastLabel = $derived.by(() => {
    if (!projecting || !forecast || !last || compact) return null;
    const t = projectionDays;
    const px = xOffset(last.date, t);
    const py = mode === 'burndown'
      ? y(projectRemaining(t))
      : y(lastFinished + forecast.completionRate * t);
    const text = forecast.status === 'converging' && forecast.projectedDate
      ? `Forecast ${formatDay(forecast.projectedDate)}${forecast.projectedDate > domainEnd ? ' →' : ''}`
      : 'Not converging';
    const room = padL + plotW - px;
    const anchor: 'start' | 'end' = room > text.length * 6 + 10 ? 'start' : 'end';
    return {
      x: anchor === 'start' ? px + 6 : px - 6,
      y: py - padT < 22 ? py + 16 : py - 8,
      text,
      anchor
    };
  });

  /** End-of-data labels: the primary series always, the secondary if it has room. */
  const endLabels = $derived.by(() => {
    if (compact || !last) return [];
    const px = x(last.date) + 7;
    const primary = mode === 'burnup'
      ? { key: 'done', value: lastFinished, y: y(lastFinished) }
      : { key: 'remaining', value: last.remaining, y: y(last.remaining) };
    const secondary = { key: 'inplay', value: lastInPlay, y: y(lastInPlay) };
    const out = [primary];
    if (Math.abs(primary.y - secondary.y) >= 14) out.push(secondary);
    // Above the point, unless that would run into the marker labels on top.
    return out.map((l) => ({ ...l, x: px, y: l.y - padT < 14 ? l.y + 16 : l.y - 7 }));
  });

  // ─── Hover & keyboard ────────────────────────────────────────────────────

  let hoverIndex = $state<number | null>(null);
  const hovered = $derived(hoverIndex !== null && hoverIndex < n ? series[hoverIndex] : null);

  function onPointerMove(e: PointerEvent) {
    if (!first || !n) return;
    const rect = (e.currentTarget as SVGRectElement).ownerSVGElement!.getBoundingClientRect();
    const scale = W / rect.width;
    const px = (e.clientX - rect.left) * scale;
    const day = Math.round(((px - padL) / plotW) * span);
    hoverIndex = Math.max(0, Math.min(n - 1, day));
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!n) return;
    const i = hoverIndex ?? n - 1;
    const step = e.shiftKey ? 7 : 1;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = Math.max(0, i - step);
    else if (e.key === 'ArrowRight') next = Math.min(n - 1, i + step);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') { hoverIndex = null; return; }
    if (next !== null) { e.preventDefault(); hoverIndex = next; }
  }

  const tooltip = $derived.by(() => {
    if (!hovered || hoverIndex === null) return null;
    const px = x(hovered.date);
    const ideal = target && mode === 'burndown' ? idealRemaining(target, hovered.date) : null;
    const changes = [
      hovered.added ? `+${hovered.added} added` : '',
      hovered.completed ? `${hovered.completed} completed` : '',
      hovered.removed ? `${hovered.removed} dropped` : ''
    ].filter(Boolean);
    const i = hoverIndex;
    const remaining = { key: 'remaining', label: 'Remaining', value: formatCount(hovered.remaining) };
    const inPlay = { key: 'inplay', label: 'Work in play', value: formatCount(inPlayValues[i]) };
    const finished = { key: 'done', label: 'Finished since start', value: formatCount(finishedValues[i]) };
    const rows = mode === 'burnup' ? [finished, inPlay, remaining] : [remaining, inPlay, finished];
    if (ideal !== null) rows.push({ key: 'ideal', label: 'Ideal', value: ideal.toFixed(1).replace(/\.0$/, '') });
    // Context, not a plotted line: every card that exists, finished or not.
    rows.push({ key: '', label: 'All cards ever', value: formatCount(hovered.scope) });
    return {
      x: px,
      flip: px > W * 0.62,
      title: formatDay(hovered.date, true, true),
      rows,
      changes: changes.length ? changes.join(' · ') : 'No changes that day'
    };
  });

  /** One-sentence summary for screen readers and the keyboard readout. */
  const summary = $derived.by(() => {
    if (!first || !last) return `${label}: no data.`;
    const s = summarise(series);
    const parts = [
      `${label}, ${formatDay(first.date, true)} to ${formatDay(last.date, true)}.`,
      `${formatCount(s.remainingNow)} remaining, from ${formatCount(s.remainingStart)} at the start; ${formatCount(s.completed)} finished and ${formatCount(s.added)} added in the period.`
    ];
    if (forecast?.status === 'converging' && forecast.projectedDate) parts.push(`Forecast to finish ${formatDay(forecast.projectedDate, true)}.`);
    else if (forecast?.status === 'not-converging') parts.push('Not converging at the current pace.');
    else if (forecast?.status === 'done') parts.push('All work is done.');
    if (target) parts.push(`Target ${formatDay(target.date, true)}.`);
    return parts.join(' ');
  });

  const readout = $derived(
    tooltip ? `${tooltip.title}: ${tooltip.rows.map((r) => `${r.label} ${r.value}`).join(', ')}. ${tooltip.changes}.` : ''
  );

  const noCards = $derived(series.every((p) => p.scope === 0));
  // Cards that were all finished before the window, with nothing added since,
  // would draw two flat lines along zero.
  const empty = $derived(n < 2 || noCards || inPlayValues.every((v) => v === 0));
  // Hydration-safe: the same id on the server and in the browser.
  const uid = $props.id();
  const clipId = `bd-clip-${uid}`;

  // ─── Formatting & scales ─────────────────────────────────────────────────

  function formatCount(v: number): string {
    return Math.round(v).toLocaleString('en-GB');
  }

  function formatDay(day: Day, withMonth = true, long = false): string {
    const d = new Date(`${day}T00:00:00Z`);
    const opts: Intl.DateTimeFormatOptions = long
      ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }
      : withMonth
        ? { day: 'numeric', month: 'short', timeZone: 'UTC' }
        : { day: 'numeric', timeZone: 'UTC' };
    return d.toLocaleDateString('en-GB', opts);
  }

  function niceStep(max: number, count: number): number {
    const raw = Math.max(1, max / count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return Math.max(1, m * mag);
    return 10 * mag;
  }

  function niceMax(max: number): number {
    const step = niceStep(max, compact ? 3 : 4);
    return Math.max(step, Math.ceil(max / step) * step);
  }

  /**
   * Ticks on calendar boundaries people recognise — days, Mondays, the first
   * of a month, quarters — at the finest step that still fits.
   */
  function dateTicks(start: Day, end: Day, maxTicks: number): { day: Day; label: string }[] {
    const total = daysBetween(start, end);
    for (const k of [1, 2, 3]) {
      if (total / k <= maxTicks) {
        const out = [];
        for (let i = 0; i <= total; i += k) {
          const day = addDays(start, i);
          out.push({ day, label: formatDay(day) });
        }
        return out;
      }
    }
    for (const weeks of [1, 2, 4]) {
      if (total / (7 * weeks) <= maxTicks) {
        const out = [];
        let d = start;
        while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
        for (; d <= end; d = addDays(d, 7 * weeks)) out.push({ day: d, label: formatDay(d) });
        return out;
      }
    }
    for (const months of [1, 2, 3, 6, 12]) {
      if (total / (30.4 * months) <= maxTicks) {
        const out = [];
        const s = new Date(`${start}T00:00:00Z`);
        let yr = s.getUTCFullYear();
        let mo = s.getUTCMonth() + (s.getUTCDate() === 1 ? 0 : 1);
        mo = Math.ceil(mo / months) * months;
        for (;;) {
          yr += Math.floor(mo / 12);
          mo %= 12;
          const day = `${yr}-${String(mo + 1).padStart(2, '0')}-01`;
          if (day > end) break;
          const dt = new Date(`${day}T00:00:00Z`);
          const monthName = dt.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
          out.push({ day, label: mo === 0 || out.length === 0 ? `${monthName} ${yr}` : monthName });
          mo += months;
        }
        return out;
      }
    }
    return [{ day: start, label: formatDay(start) }, { day: end, label: formatDay(end) }];
  }
</script>

<div class="bd-chart" class:compact class:loading bind:clientWidth={measured}>
  {#if empty}
    <div class="bd-empty" style="height: {H}px">
      {n < 2
        ? 'Not enough history to draw a burndown yet.'
        : noCards
          ? 'No cards in this scope for this period.'
          : 'Nothing was open or added in this period — everything here was already finished.'}
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="bd-frame"
      role="group"
      aria-roledescription="chart"
      aria-label="{summary} Use the arrow keys to read each day."
      tabindex="0"
      onkeydown={onKeyDown}
      onfocus={() => { if (hoverIndex === null) hoverIndex = n - 1; }}
      onblur={() => (hoverIndex = null)}
    >
      <svg viewBox="0 0 {W} {H}" width="100%" height={H} aria-hidden="true">
        <defs>
          <clipPath id={clipId}>
            <rect x={padL} y={padT - 2} width={plotW + 1} height={plotH + 4} />
          </clipPath>
        </defs>

        <!-- Grid: solid hairlines, one step off the surface -->
        {#each yTicks as v}
          <line class="grid" x1={padL} x2={padL + plotW} y1={y(v)} y2={y(v)} />
          <text class="y-label" x={padL - 6} y={y(v) + 3.5}>{formatCount(v)}</text>
        {/each}
        {#each xTicks as t}
          <text class="x-label" x={x(t.day)} y={H - 7}>{t.label}</text>
        {/each}

        <!-- Reference markers -->
        {#if showToday}
          <line class="marker" x1={x(today)} x2={x(today)} y1={padT} y2={padT + plotH} />
          {#if !compact && todayLabelFits}<text class="marker-label" x={x(today) + 4} y={padT - 8}>Today</text>{/if}
        {/if}
        {#if targetInView && target}
          <line class="marker target" x1={x(target.date)} x2={x(target.date)} y1={padT} y2={padT + plotH} />
          <text class="marker-label" text-anchor="end" x={x(target.date) - 4} y={padT - 8}>
            Target {formatDay(target.date)}
          </text>
        {:else if targetBeyond && target && !compact}
          <text class="marker-label" text-anchor="end" x={padL + plotW} y={padT - 8}>Target {formatDay(target.date, true)} →</text>
        {/if}

        <g clip-path="url(#{clipId})">
          {#if idealLine}
            <line class="ideal" x1={idealLine.x1} y1={idealLine.y1} x2={idealLine.x2} y2={idealLine.y2} />
          {/if}

          <!-- Primary: remaining (burndown) or done (burn-up), with its wash -->
          <path class="area {mode === 'burnup' ? 'done' : 'remaining'}" d={areaPath(primaryValues)} />
          <path class="line inplay" d={linePath(inPlayValues)} />
          <path class="line {mode === 'burnup' ? 'done' : 'remaining'}" d={linePath(primaryValues)} />

          {#each projections as p}
            <line class="projection {p.key}" x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} />
          {/each}
        </g>

        <!-- End markers and selective labels -->
        {#if last}
          <circle class="dot inplay" cx={x(last.date)} cy={y(lastInPlay)} r="4" />
          <circle class="dot {mode === 'burnup' ? 'done' : 'remaining'}" cx={x(last.date)} cy={y(mode === 'burnup' ? lastFinished : last.remaining)} r="4" />
        {/if}
        {#each endLabels as l}
          <text class="end-label" x={l.x} y={l.y}>{formatCount(l.value)}</text>
        {/each}
        {#if forecastLabel}
          <text class="forecast-label" text-anchor={forecastLabel.anchor} x={forecastLabel.x} y={forecastLabel.y}>
            {forecastLabel.text}
          </text>
        {/if}

        <!-- Crosshair -->
        {#if tooltip && hovered}
          <line class="crosshair" x1={tooltip.x} x2={tooltip.x} y1={padT} y2={padT + plotH} />
          <circle class="dot inplay" cx={tooltip.x} cy={y(inPlayValues[hoverIndex ?? 0])} r="4" />
          <circle class="dot {mode === 'burnup' ? 'done' : 'remaining'}" cx={tooltip.x} cy={y(mode === 'burnup' ? finishedValues[hoverIndex ?? 0] : hovered.remaining)} r="4" />
        {/if}

        <!-- Hit area: the whole plot, so the pointer only has to find the day -->
        <rect
          class="hit"
          x={padL}
          y={padT}
          width={plotW}
          height={plotH}
          role="presentation"
          onpointermove={onPointerMove}
          onpointerleave={() => (hoverIndex = null)}
        />
      </svg>

      {#if tooltip}
        <div class="bd-tooltip" class:flip={tooltip.flip} style="left: {(tooltip.x / W) * 100}%; top: {padT}px" aria-hidden="true">
          <div class="tt-title">{tooltip.title}</div>
          {#each tooltip.rows as r}
            <div class="tt-row">
              <span class="tt-key {r.key || 'none'}"></span>
              <span class="tt-value">{r.value}</span>
              <span class="tt-label">{r.label}</span>
            </div>
          {/each}
          <div class="tt-changes">{tooltip.changes}</div>
        </div>
      {/if}
      <div class="sr-only" aria-live="polite">{readout}</div>
    </div>

    <!-- Keys drawn as SVG, the same marks as the chart. Their classes are
         prefixed (k- kind, s- series) because sharing the chart's own .area
         class gave the Remaining key the area wash's 10% opacity. -->
    {#snippet lgKey(kind: 'area' | 'line' | 'dash' | 'dot', cls: string)}
      <svg class="lg-svg" width="18" height="10" viewBox="0 0 18 10" aria-hidden="true">
        {#if kind === 'area'}<rect class="lg-wash s-{cls}" x="0" y="2" width="18" height="8" rx="1.5" />{/if}
        <line class="lg-line k-{kind} s-{cls}" x1="1.5" x2="16.5" y1={kind === 'area' ? 2 : 5} y2={kind === 'area' ? 2 : 5} />
      </svg>
    {/snippet}
    <div class="bd-legend">
      {#if mode === 'burnup'}
        <span class="lg">{@render lgKey('area', 'done')}<InfoTip width={260}>Finished{#snippet tip()}<p>Cards finished since the start of the period, added up day by day.</p>{/snippet}</InfoTip></span>
      {:else}
        <span class="lg">{@render lgKey('area', 'remaining')}<InfoTip width={260}>Remaining{#snippet tip()}<p>Cards open at the end of each day: not in a Complete column and not archived.</p>{/snippet}</InfoTip></span>
      {/if}
      <span class="lg">{@render lgKey('line', 'inplay')}<InfoTip width={280}>Work in play{#snippet tip()}<p>What was open at the start of the period, plus everything added since, less anything dropped.</p><p>{mode === 'burnup' ? 'When Finished meets it, everything is done.' : 'The gap down to Remaining is what got finished.'}</p>{/snippet}</InfoTip></span>
      {#if idealLine}<span class="lg">{@render lgKey('dash', 'ref')}<InfoTip width={260}>Ideal{#snippet tip()}<p>A straight line from the work open at the start down to zero on the target date: the steady pace that would land exactly on time.</p>{/snippet}</InfoTip></span>{/if}
      {#if projections.length}<span class="lg">{@render lgKey('dot', mode === 'burnup' ? 'done' : 'remaining')}<InfoTip width={260}>Forecast{#snippet tip()}<p>Where the {mode === 'burnup' ? 'lines head' : 'line heads'} if work keeps arriving and being finished at the pace of the last {forecast?.basisDays ?? 28} days.</p>{/snippet}</InfoTip></span>{/if}
    </div>
  {/if}
</div>

<style>
  .bd-chart {
    /* Validated with the dataviz palette checks on light and dark surfaces. */
    --bd-remaining: #6366f1;
    --bd-scope: #d97706;
    --bd-done: #059669;
    --bd-ref: var(--text-tertiary);
    --bd-ring: var(--bd-surface, var(--bg-base));
    position: relative;
    width: 100%;
    transition: opacity var(--duration-normal) ease;
  }
  .bd-chart.loading { opacity: 0.5; }

  .bd-frame { position: relative; border-radius: var(--radius-sm); outline: none; }
  .bd-frame:focus-visible { box-shadow: 0 0 0 2px var(--accent-indigo); }
  svg { display: block; overflow: visible; }

  .grid { stroke: var(--glass-border); stroke-width: 1; shape-rendering: crispEdges; }
  .y-label, .x-label {
    font-size: 10px; fill: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
  }
  .y-label { text-anchor: end; }
  .x-label { text-anchor: middle; }
  .compact .y-label, .compact .x-label { font-size: 9px; }

  .line { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .line.remaining { stroke: var(--bd-remaining); }
  .line.inplay { stroke: var(--bd-scope); }
  .line.done { stroke: var(--bd-done); }
  .area { stroke: none; }
  .area.remaining { fill: var(--bd-remaining); opacity: 0.1; }
  .area.done { fill: var(--bd-done); opacity: 0.12; }

  /* Dashes are reserved for what is not measured: the ideal and the forecast. */
  .ideal { stroke: var(--bd-ref); stroke-width: 1.5; stroke-dasharray: 5 4; }
  .projection { stroke-width: 2; stroke-dasharray: 2 4; stroke-linecap: round; }
  .projection.remaining { stroke: var(--bd-remaining); }
  .projection.done { stroke: var(--bd-done); }
  .projection.inplay { stroke: var(--bd-scope); }

  .marker { stroke: var(--bd-ref); stroke-width: 1; opacity: 0.6; shape-rendering: crispEdges; }
  .marker.target { opacity: 0.9; }
  .marker-label, .forecast-label {
    font-size: 10px; font-weight: 600; fill: var(--text-secondary);
  }

  .dot { stroke: var(--bd-ring); stroke-width: 2; }
  .dot.remaining { fill: var(--bd-remaining); }
  .dot.inplay { fill: var(--bd-scope); }
  .dot.done { fill: var(--bd-done); }
  .end-label {
    font-size: 11px; font-weight: 700; fill: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }

  .crosshair { stroke: var(--text-tertiary); stroke-width: 1; shape-rendering: crispEdges; }
  .hit { fill: transparent; cursor: crosshair; }

  .bd-tooltip {
    position: absolute; transform: translateX(12px);
    min-width: 132px; padding: 8px 10px;
    background: var(--bg-card); color: var(--text-primary);
    border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
    box-shadow: var(--shadow-md);
    font-size: 0.72rem; pointer-events: none; z-index: 5;
    white-space: nowrap;
  }
  .bd-tooltip.flip { transform: translateX(calc(-100% - 12px)); }
  .tt-title { font-weight: 600; color: var(--text-secondary); margin-bottom: 4px; }
  .tt-row { display: flex; align-items: center; gap: 6px; line-height: 1.6; }
  .tt-key { width: 12px; height: 0; border-top: 2px solid; flex-shrink: 0; }
  .tt-key.remaining { border-color: var(--bd-remaining); }
  .tt-key.inplay { border-color: var(--bd-scope); }
  .tt-key.done { border-color: var(--bd-done); }
  .tt-key.ideal { border-color: var(--bd-ref); border-top-style: dashed; }
  .tt-key.none { border-color: transparent; }
  .tt-value { font-weight: 700; min-width: 28px; font-variant-numeric: tabular-nums; }
  .tt-label { color: var(--text-secondary); }
  .tt-changes { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--glass-border); color: var(--text-tertiary); }

  .bd-legend {
    display: flex; flex-wrap: wrap; gap: 4px 14px; padding-top: 6px;
    font-size: 0.7rem; color: var(--text-secondary); font-weight: 600;
  }
  .compact .bd-legend { justify-content: center; font-size: 0.65rem; gap: 4px 10px; }
  .lg { display: inline-flex; align-items: center; gap: 5px; }
  .lg-svg { display: block; flex-shrink: 0; overflow: visible; }
  .lg-line { stroke-width: 2; stroke-linecap: round; }
  .lg-line.s-remaining { stroke: var(--bd-remaining); }
  .lg-line.s-inplay { stroke: var(--bd-scope); }
  .lg-line.s-done { stroke: var(--bd-done); }
  .lg-line.s-ref { stroke: var(--bd-ref); }
  .lg-line.k-dash { stroke-dasharray: 4 3; stroke-linecap: butt; }
  .lg-line.k-dot { stroke-dasharray: 0.1 4; }
  .lg-wash.s-remaining { fill: var(--bd-remaining); opacity: 0.16; }
  .lg-wash.s-done { fill: var(--bd-done); opacity: 0.18; }

  .bd-empty {
    display: flex; align-items: center; justify-content: center; text-align: center;
    color: var(--text-tertiary); font-size: 0.8rem; padding: var(--space-md);
    border: 1px dashed var(--glass-border); border-radius: var(--radius-md);
  }
  .compact .bd-empty { height: auto !important; min-height: 80px; }

  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
</style>
