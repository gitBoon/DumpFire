<!--
  FloatingPanel.svelte — the themed floating surface behind popovers and hover
  explanations.

  Rendered at the end of <body> (see `portal`), positioned against its anchor
  with `placeFloating`, and re-placed when the page scrolls, the window
  resizes or its own content changes size. It is hidden until the first
  placement so it never flashes in the wrong spot.

  Built from theme tokens only — the card surface, border, shadow and accent —
  so it follows every theme. Content styles for explanations (headings,
  paragraphs, the worked-out figures) live here as :global rules scoped under
  the panel, so any snippet rendered into it looks the same.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { placeFloating, portal, type Placement } from '$lib/floating';

  let {
    anchor,
    id,
    role = 'dialog',
    label,
    width = 300,
    prefer = 'bottom',
    align = 'start',
    tone = 'panel',
    panel = $bindable(null),
    onkeydown,
    onpointerenter,
    onpointerleave,
    children
  }: {
    anchor: HTMLElement | null;
    id: string;
    role?: 'dialog' | 'tooltip';
    label?: string;
    width?: number;
    prefer?: 'bottom' | 'top';
    align?: 'start' | 'center';
    /** 'tip' is the lighter-weight hover explanation; 'panel' holds controls. */
    tone?: 'panel' | 'tip';
    panel?: HTMLDivElement | null;
    onkeydown?: (e: KeyboardEvent) => void;
    onpointerenter?: (e: PointerEvent) => void;
    onpointerleave?: (e: PointerEvent) => void;
    children: Snippet;
  } = $props();

  let pos = $state<Placement | null>(null);

  function place() {
    if (!anchor || !panel) return;
    const r = anchor.getBoundingClientRect();
    pos = placeFloating(
      { left: r.left, top: r.top, width: r.width, height: r.height },
      { width: panel.offsetWidth, height: panel.offsetHeight },
      { width: window.innerWidth, height: document.documentElement.clientHeight },
      { prefer, align }
    );
  }

  $effect(() => {
    if (!anchor || !panel) return;
    place();
    const onMove = () => place();
    window.addEventListener('resize', onMove);
    // Capture: any scrolling ancestor, not just the window, moves the anchor.
    window.addEventListener('scroll', onMove, true);
    const ro = new ResizeObserver(onMove);
    ro.observe(panel);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
      ro.disconnect();
    };
  });
</script>

<div
  use:portal
  bind:this={panel}
  class="fl {tone}"
  class:placed={!!pos}
  data-side={pos?.side ?? 'bottom'}
  {id}
  {role}
  aria-label={label}
  tabindex="-1"
  style="width: {width}px; left: {pos?.left ?? 0}px; top: {pos?.top ?? 0}px"
  {onkeydown}
  {onpointerenter}
  {onpointerleave}
>
  <span class="fl-arrow" style="left: {pos?.arrow ?? 16}px" aria-hidden="true"></span>
  <div class="fl-body">
    {@render children()}
  </div>
</div>

<style>
  .fl {
    position: fixed;
    z-index: 1000;
    max-width: calc(100vw - 16px);
    visibility: hidden;
    background: var(--bg-card);
    color: var(--text-primary);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    font-family: var(--font-family);
    font-size: 0.8rem;
    line-height: 1.5;
    text-align: left;
    outline: none;
  }
  .fl.placed { visibility: visible; animation: fl-in 140ms var(--ease-out); }
  .fl[data-side='top'].placed { animation-name: fl-in-up; }
  @keyframes fl-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
  @keyframes fl-in-up { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .fl.placed { animation: none; } }

  /* The theme's accent along the top edge: the "canvas" is recognisably DumpFire's in every theme. */
  .fl::before {
    content: ''; position: absolute; left: 0; right: 0; top: 0; height: 3px;
    border-radius: var(--radius-md) var(--radius-md) 0 0;
    background: linear-gradient(90deg, var(--accent-indigo), var(--accent-purple));
    opacity: 0.85;
  }
  .fl.tip::before { height: 2px; opacity: 0.7; }

  .fl-arrow {
    position: absolute; width: 10px; height: 10px; margin-left: -5px;
    background: var(--bg-card); border: 1px solid var(--glass-border);
    transform: rotate(45deg); pointer-events: none;
  }
  .fl[data-side='bottom'] .fl-arrow { top: -6px; border-right: none; border-bottom: none; }
  .fl[data-side='top'] .fl-arrow { bottom: -6px; border-left: none; border-top: none; }

  .fl-body { position: relative; padding: 14px 16px 12px; max-height: min(70vh, 560px); overflow-y: auto; }
  .fl.tip .fl-body { padding: 12px 14px 10px; }

  /* ─── Content that any explanation or panel can use ─────────────────── */
  .fl-body :global(h4) {
    margin: 0 0 6px; font-size: 0.8rem; font-weight: 700; color: var(--text-primary);
  }
  .fl-body :global(p) { margin: 0 0 8px; color: var(--text-secondary); }
  .fl-body :global(p:last-child) { margin-bottom: 0; }
  .fl-body :global(strong) { color: var(--text-primary); }
  .fl-body :global(.calc) {
    margin: 8px 0; padding: 8px 10px; border-radius: var(--radius-sm);
    background: var(--bg-surface); border: 1px solid var(--glass-border);
    font-family: var(--font-mono); font-size: 0.72rem; line-height: 1.6;
    color: var(--text-secondary); font-variant-numeric: tabular-nums;
  }
  .fl-body :global(.calc b) { color: var(--text-primary); font-weight: 700; }
  .fl-body :global(.muted) { font-size: 0.72rem; color: var(--text-tertiary); }
  .fl-body :global(.section-label) {
    display: block; margin: 10px 0 4px; font-size: 0.66rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-tertiary);
  }
  .fl-body :global(.section-label:first-child) { margin-top: 0; }
</style>
