<!--
  Popover.svelte — a pill that states a current choice and opens the controls
  for it. The page's settings stay readable at a glance and the detail is one
  click away: progressive disclosure rather than a wall of dropdowns.

  Click or Enter/Space opens it and moves focus inside. Escape or a click
  anywhere outside closes it and hands focus back to the pill.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { tick } from 'svelte';
  import FloatingPanel from './FloatingPanel.svelte';

  let {
    label,
    active = false,
    width = 300,
    align = 'start',
    onopen,
    trigger,
    children
  }: {
    /** Names the panel for assistive technology, e.g. "Choose what to chart". */
    label: string;
    /** Highlight the pill when its setting is not the default. */
    active?: boolean;
    width?: number;
    align?: 'start' | 'center';
    onopen?: () => void;
    trigger: Snippet;
    children: Snippet<[() => void]>;
  } = $props();

  let open = $state(false);
  let button = $state<HTMLButtonElement | null>(null);
  let panel = $state<HTMLDivElement | null>(null);
  const uid = $props.id();
  const id = `pop-${uid}`;

  async function show() {
    onopen?.();
    open = true;
    await tick();
    // Into the panel, at its first control.
    const first = panel?.querySelector<HTMLElement>('input, select, button, a[href], [tabindex]:not([tabindex="-1"])');
    (first ?? panel)?.focus();
  }

  function close(returnFocus = true) {
    if (!open) return;
    open = false;
    if (returnFocus) button?.focus();
  }

  $effect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel?.contains(t) || button?.contains(t)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  });
</script>

<button
  bind:this={button}
  type="button"
  class="pop-pill"
  class:open
  class:active
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-controls={open ? id : undefined}
  onclick={() => (open ? close() : show())}
>
  {@render trigger()}
  <svg class="caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</button>

{#if open}
  <FloatingPanel
    anchor={button}
    {id}
    {label}
    {width}
    {align}
    bind:panel
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    }}
  >
    {@render children(() => close())}
  </FloatingPanel>
{/if}

<style>
  .pop-pill {
    display: inline-flex; align-items: center; gap: 7px;
    height: 32px; padding: 0 11px 0 12px; max-width: 320px;
    background: var(--bg-surface); border: 1px solid var(--glass-border);
    border-radius: var(--radius-full); color: var(--text-secondary);
    font-family: var(--font-family); font-size: 0.78rem; font-weight: 600;
    cursor: pointer; white-space: nowrap;
    transition: all var(--duration-fast) var(--ease-out);
  }
  .pop-pill :global(svg:not(.caret)) { flex-shrink: 0; opacity: 0.8; }
  .pop-pill:hover { color: var(--text-primary); border-color: var(--text-tertiary); }
  .pop-pill:focus-visible { outline: 2px solid var(--accent-indigo); outline-offset: 2px; }
  .pop-pill.active { color: var(--text-primary); border-color: color-mix(in srgb, var(--accent-indigo) 55%, transparent); background: color-mix(in srgb, var(--accent-indigo) 9%, var(--bg-surface)); }
  .pop-pill.open { border-color: var(--accent-indigo); color: var(--text-primary); }
  .caret { flex-shrink: 0; transition: transform var(--duration-fast) var(--ease-out); }
  .pop-pill.open .caret { transform: rotate(180deg); }
</style>
