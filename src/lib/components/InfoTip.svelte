<!--
  InfoTip.svelte — a hover explanation on a floating, themed canvas.

  Wraps whatever it explains. Hover (with a short delay, and a grace period so
  the pointer can travel into the panel), keyboard focus, or a tap on a touch
  screen opens it; moving away, blurring, Escape or tapping elsewhere closes
  it. The panel is a FloatingPanel, so it follows every theme.

  `focusable={false}` when the wrapped content is already interactive (a
  button, a link): focus reaching that element still opens the explanation.
  Its limit: the inner control must be there as the tip mounts (one drawn
  later is not described), and its own `aria-describedby` must not be a
  reactive binding (a change to it would drop this tip's id from it).

  A screen reader is told the explanation as the focus arrives (card 2516):
  the tip's text is always in the page, `hidden` at the end of <body>, and the
  control that takes the focus names it in `aria-describedby` from the start
  (a hidden element named that way is still read as the description). That
  is the wrapper, or with `focusable={false}` the first focusable element
  inside, whose own `aria-describedby` is kept and given back without this
  tip's id when the tip goes. The panel drawn on hover is for the eye, under
  an id of its own.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import FloatingPanel from './FloatingPanel.svelte';
  import { portal } from '$lib/floating';

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

  const FOCUSABLE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

  // With focusable={false}, the inner control is what has the focus: the
  // tip's hidden text is added to its description, beside any it has.
  $effect(() => {
    if (focusable || !el) return;
    const target = el.querySelector<HTMLElement>(FOCUSABLE);
    if (!target) return;
    const ids = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    if (ids.includes(id)) return;
    target.setAttribute('aria-describedby', [...ids, id].join(' '));
    return () => {
      const left = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((t) => t && t !== id);
      if (left.length) target.setAttribute('aria-describedby', left.join(' '));
      else target.removeAttribute('aria-describedby');
    };
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
  aria-describedby={focusable ? id : undefined}
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
<!--
  What the focused control's aria-describedby names: always in the page,
  hidden, so read only as that description. Not a tooltip; the panel is. At
  the end of <body>, so that it is never part of the text around the words
  it explains (a table heading's name, the page read in order).
-->
<span hidden {id} use:portal>{@render tip()}</span>

{#if open}
  <FloatingPanel
    anchor={el}
    id="{id}-panel"
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
