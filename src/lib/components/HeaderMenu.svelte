<!--
  HeaderMenu.svelte — A button that opens a menu, for the dashboard's and the
  board's header bars (card 2466): what is not used every minute moves one
  click deeper, and stays one key away.

  The items are the caller's, drawn in the panel: each a button or link with
  `role="menuitem"`, `"menuitemcheckbox"` or `"menuitemradio"` and
  `tabindex="-1"`, styled with the shared `hm-*` classes below.

    - Opens on a click, Enter, Space or ArrowDown (the focus on the first
      item), or ArrowUp (on the last). ArrowDown and ArrowUp then move between
      the items, wrapping; Home and End go to the first and last.
    - Escape closes it and gives the focus back to the button. Tab closes it,
      the focus put on the button just before the browser moves it on, so Tab
      and Shift+Tab leave to what is either side of the menu.
    - A click outside closes it. So does choosing a menuitem or a radio item,
      which first gives the focus to the button: a dialog the item opens takes
      the focus from there and gives it back there as it closes
      (`takeFocus`, src/lib/dialog-focus.ts). A checkbox item leaves it open,
      unless it carries `data-menu-close` (a panel's switch in the board's
      More, which closes as it did).

  Whether it is open can be bound (`bind:open`). The button's click goes on
  to the window, so a page's own closer (the board's column menus and card
  menu) shuts them as a menu opens; a click inside the panel does not.

  The panel lines up with the button's edge (`align`), and is moved back in
  as it opens where that would put it past either side of the window, 8 px
  in (a phone, a button near the edge).

  Space opens it on keydown; the keyup that follows is kept from pressing
  the item the focus has just moved to, as Firefox would.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { tick } from 'svelte';

	let {
		open = $bindable(false),
		label,
		triggerClass = '',
		triggerId,
		triggerTitle,
		triggerActive = false,
		align = 'end',
		onopen,
		trigger,
		children
	}: {
		open?: boolean;
		/** Names the menu for a screen reader, e.g. "Views". */
		label: string;
		/** The look of the button: the bar's own pill class. */
		triggerClass?: string;
		triggerId?: string;
		triggerTitle?: string;
		/** The button drawn as on: a setting in the menu is not its default. */
		triggerActive?: boolean;
		/** Which edge of the button the panel lines up with. */
		align?: 'start' | 'end';
		/** Called as it opens, before its items are drawn. */
		onopen?: () => void;
		/** What the button shows. */
		trigger: Snippet;
		/** The items. */
		children: Snippet;
	} = $props();

	const uid = $props.id();
	const panelId = `hm-${uid}`;
	let wrapper = $state<HTMLElement | null>(null);
	let button = $state<HTMLButtonElement | null>(null);
	let panel = $state<HTMLElement | null>(null);
	/** When a key last opened or closed it: the click a browser may still send for that Space is not a second press. */
	let keyAt = 0;

	const ITEM = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

	function items(): HTMLElement[] {
		if (!panel) return [];
		return [...panel.querySelectorAll<HTMLElement>(ITEM)].filter(
			(el) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true' && !el.closest('[hidden]')
		);
	}

	async function show(at: 'first' | 'last') {
		onopen?.();
		open = true;
		await tick();
		place();
		const list = items();
		(at === 'last' ? list.at(-1) : list[0])?.focus();
	}

	/** The gap kept between the panel and the window's edge. */
	const EDGE = 8;

	/**
	 * Moves the panel back inside the window where its edge would be past
	 * either side: its left set from the wrapper so that it starts EDGE in from
	 * the left, or ends EDGE in from the right, whichever it would cross.
	 */
	function place() {
		if (!panel || !wrapper) return;
		panel.style.left = '';
		panel.style.right = '';
		const box = panel.getBoundingClientRect();
		const width = window.innerWidth || document.documentElement.clientWidth;
		if (!width || !box.width) return;
		let left = box.left;
		if (box.right > width - EDGE) left = width - EDGE - box.width;
		if (left < EDGE) left = EDGE;
		if (left === box.left) return;
		panel.style.left = `${Math.round(left - wrapper.getBoundingClientRect().left)}px`;
		panel.style.right = 'auto';
	}

	/**
	 * After Space has opened it: the keyup that follows lands on the item the
	 * focus has moved to, and in Firefox it would press that item. That one
	 * keyup's default is taken; the listener goes at it, or after a second.
	 */
	function swallowSpaceUp() {
		let done = false;
		const up = (e: KeyboardEvent) => {
			if (e.key !== ' ' || done) return;
			e.preventDefault();
			stop();
		};
		const stop = () => {
			done = true;
			window.removeEventListener('keyup', up, true);
		};
		window.addEventListener('keyup', up, true);
		setTimeout(stop, 1000);
	}

	function hide(returnFocus: boolean) {
		if (!open) return;
		if (returnFocus) button?.focus();
		open = false;
	}

	function onButtonClick(e: MouseEvent) {
		if (e.detail === 0 && Date.now() - keyAt < 500) return;
		if (open) hide(false);
		else show('first');
	}

	function onButtonKey(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			keyAt = Date.now();
			if (open) hide(true);
			else {
				if (e.key === ' ') swallowSpaceUp();
				show('first');
			}
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (open) items()[0]?.focus();
			else show('first');
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (open) items().at(-1)?.focus();
			else show('last');
		}
	}

	function onPanelKey(e: KeyboardEvent) {
		const list = items();
		const at = list.indexOf(document.activeElement as HTMLElement);
		const go = (i: number) => {
			e.preventDefault();
			list[(i + list.length) % list.length]?.focus();
		};
		if (e.key === 'ArrowDown') go(at + 1);
		else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
		else if (e.key === 'Home') go(0);
		else if (e.key === 'End') go(-1);
		else if (e.key === 'Tab') hide(true);
		else if (e.key === ' ' && (document.activeElement as HTMLElement | null)?.tagName === 'A') {
			// Space presses a link item, as it does a button item.
			e.preventDefault();
			(document.activeElement as HTMLElement).click();
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) {
			e.preventDefault();
			e.stopPropagation();
			hide(true);
		}
	}

	/** Before the item's own click: the focus to the button, and the menu shut, for a menuitem or radio item. */
	function onPick(e: MouseEvent) {
		const item = (e.target as HTMLElement).closest<HTMLElement>(ITEM);
		if (!item || !panel?.contains(item)) return;
		if (item.getAttribute('role') === 'menuitemcheckbox' && !item.hasAttribute('data-menu-close')) return;
		hide(true);
	}

	$effect(() => {
		if (!open) return;
		const outside = (e: MouseEvent) => {
			if (wrapper && !wrapper.contains(e.target as Node)) hide(false);
		};
		document.addEventListener('click', outside, true);
		return () => document.removeEventListener('click', outside, true);
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="hm" bind:this={wrapper} onkeydown={onKey}>
	<button
		bind:this={button}
		type="button"
		class="hm-trigger {triggerClass}"
		class:hm-open={open}
		class:hm-on={triggerActive}
		id={triggerId}
		title={triggerTitle}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-controls={open ? panelId : undefined}
		onclick={onButtonClick}
		onkeydown={onButtonKey}
	>
		{@render trigger()}
		<svg class="hm-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
			<path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
		</svg>
	</button>
	{#if open}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			bind:this={panel}
			id={panelId}
			class="hm-panel"
			class:hm-start={align === 'start'}
			role="menu"
			tabindex="-1"
			aria-label={label}
			onkeydown={onPanelKey}
			onclickcapture={onPick}
			onclick={(e) => e.stopPropagation()}
		>
			{@render children()}
		</div>
	{/if}
</div>

<style>
	.hm { position: relative; display: inline-flex; }
	.hm-trigger { display: inline-flex; align-items: center; gap: 6px; }
	.hm-caret { flex-shrink: 0; opacity: 0.6; transition: transform var(--duration-fast) var(--ease-out); }
	.hm-open .hm-caret { transform: rotate(180deg); }
	.hm-trigger:focus-visible { outline: 2px solid var(--accent-indigo); outline-offset: 2px; }

	.hm-panel {
		position: absolute; top: calc(100% + 6px); right: 0;
		min-width: 200px; max-width: min(320px, calc(100vw - 24px));
		max-height: min(70vh, 560px); overflow-y: auto;
		background: var(--bg-card, var(--bg-surface)); border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg);
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(255, 255, 255, 0.04);
		z-index: 200; padding: var(--space-xs) 0;
		animation: hmIn 0.15s ease-out;
		text-align: left;
	}
	.hm-panel.hm-start { right: auto; left: 0; }
	.hm-panel:focus { outline: none; }
	@keyframes hmIn {
		from { opacity: 0; transform: translateY(-6px) scale(0.97); }
		to { opacity: 1; transform: translateY(0) scale(1); }
	}

	/* The items are the caller's; their look is shared here so every menu reads alike. */
	.hm-panel :global(.hm-label) {
		font-size: 0.62rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.08em; color: var(--text-tertiary);
		padding: var(--space-xs) var(--space-md) 4px;
	}
	.hm-panel :global(.hm-divider) {
		height: 1px; background: var(--glass-border);
		margin: var(--space-xs) var(--space-md);
	}
	.hm-panel :global(.hm-item) {
		display: flex; align-items: center; gap: var(--space-sm);
		width: 100%; padding: 7px var(--space-md);
		border: none; background: transparent; border-radius: 0;
		color: var(--text-secondary); font-size: 0.82rem; font-weight: 500;
		font-family: var(--font-family); cursor: pointer;
		text-decoration: none; text-align: left; white-space: nowrap;
		transition: background 0.1s ease, color 0.1s ease;
	}
	.hm-panel :global(.hm-item:hover),
	.hm-panel :global(.hm-item:focus) {
		background: rgba(99, 102, 241, 0.08); color: var(--text-primary); outline: none;
	}
	.hm-panel :global(.hm-item:focus-visible) { box-shadow: inset 2px 0 0 var(--accent-indigo); }
	.hm-panel :global(.hm-item svg) { flex-shrink: 0; opacity: 0.7; }
	.hm-panel :global(.hm-icon) { font-size: 0.9rem; width: 20px; text-align: center; flex-shrink: 0; }
	.hm-panel :global(.hm-check) {
		margin-left: auto; font-size: 0.75rem; font-weight: 700; color: var(--accent-indigo);
	}
	.hm-panel :global(.hm-item[aria-checked='true']) { color: var(--accent-indigo); font-weight: 600; }

	@media (max-width: 768px) {
		.hm-panel :global(.hm-item) { padding: var(--space-md) var(--space-lg); min-height: 40px; }
	}
</style>
