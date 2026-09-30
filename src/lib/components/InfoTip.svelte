<!--
  InfoTip.svelte — a hover explanation on a floating, themed canvas.

  Wraps whatever it explains. Hover (with a short delay, and a grace period so
  the pointer can travel into the panel), keyboard focus, or a tap on a touch
  screen opens it; moving away, blurring, Escape or tapping elsewhere closes
  it. The panel is a FloatingPanel, so it follows every theme.

  `focusable={false}` when the wrapped content is already interactive (a
  button, a link): focus reaching that element still opens the explanation.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import FloatingPanel from './FloatingPanel.svelte';

  let {
    title,
    tip,
    children,
    block = false,
    dotted = !block,
    focusable = true,
    width = 300,
    prefer = 'bottom'
  }: {
    title?: string;
    tip: Snippet;
    children: Snippet;
    /** Lay the wrapper out as a column that fills its parent (for tiles). */
    block?: boolean;
    /** Dotted underline: the usual cue that a word has an explanation. */
    dotted?: boolean;
    focusable?: boolean;
    width?: number;
    prefer?: 'bottom' | 'top';
  } = $props();

  let open = $state(false);
  let el = $state<HTMLElement | null>(null);
  let panel = $state<HTMLDivElement | null>(null);
  const uid = $props.id();
  const id = `tip-${uid}`;

  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function show(delay = 140) {
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    showTimer = setTimeout(() => (open = true), delay);
  }
  function hide(delay = 140) {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => (open = false), delay);
  }

  // A tap elsewhere closes a tip opened by tapping.
  $effect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (el?.contains(t) || panel?.contains(t)) return;
      hide(0);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  });

  $effect(() => () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<span
  bind:this={el}
  class="it"
  class:block
  class:dotted
  class:open
  tabindex={focusable ? 0 : undefined}
  aria-describedby={open ? id : undefined}
  onpointerenter={(e) => e.pointerType !== 'touch' && show()}
  onpointerleave={(e) => e.pointerType !== 'touch' && hide()}
  onpointerdown={(e) => {
    if (e.pointerType === 'touch') open ? hide(0) : show(0);
  }}
  onfocusin={() => show(0)}
  onfocusout={() => hide(0)}
  onkeydown={(e) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      hide(0);
    }
  }}
>
  {@render children()}
</span>

{#if open}
  <FloatingPanel
    anchor={el}
    {id}
    role="tooltip"
    tone="tip"
    {width}
    {prefer}
    bind:panel
    onpointerenter={() => clearTimeout(hideTimer)}
    onpointerleave={() => hide()}
  >
    {#if title}<h4>{title}</h4>{/if}
    {@render tip()}
  </FloatingPanel>
{/if}

<style>
  .it { cursor: help; border-radius: 3px; }
  .it:focus-visible { outline: 2px solid var(--accent-indigo); outline-offset: 2px; }
  .it.dotted {
    text-decoration: underline dotted;
    text-decoration-color: var(--text-tertiary);
    text-underline-offset: 3px;
  }
  .it.dotted:hover, .it.dotted.open { text-decoration-color: var(--accent-indigo); }
  .it.block { display: flex; flex-direction: column; gap: 2px; height: 100%; }
</style>
