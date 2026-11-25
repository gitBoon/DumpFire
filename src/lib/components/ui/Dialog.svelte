<!--
  Dialog.svelte — The UI kit's dialog frame (card 3078), in shadcn's anatomy:
  a backdrop, and on it a box with a header (the title and what describes
  it), a body and a row of buttons.

  Mounted means open: the caller draws it inside an `{#if}` and closes it by
  no longer drawing it. It draws no Cancel, Confirm or close cross of its
  own: the caller fills the `footer` snippet, Cancel (an outline Button)
  first and the action last.

  The box is the dialog: it carries the `role` (dialog, or alertdialog),
  `aria-modal="true"` and `tabindex="-1"` (it takes the focus only where
  nothing else in it can). It is named by its title unless given an
  `aria-label` or `aria-labelledby`, and described by a `description` string
  unless given an `aria-describedby`; a `description` snippet draws the
  caller's own element, which the caller names in `aria-describedby`.

  The keyboard is the app's existing focus hold (`$lib/dialog-focus`,
  `holdFocus`), unchanged: the first focus (`initialFocus`, a selector inside
  the box; by default the body's first enabled field, else the footer's first
  enabled button, else the box), Tab and Shift+Tab held inside, a Tab from
  outside brought back to the first focus, and the focus handed back as it
  closes (to `returnTo`'s element where given). Escape runs `onEscape`, and a
  press on the backdrop itself runs `onBackdrop`: one that went down and came
  up on the backdrop, never one that began in the box (a drag to select text
  in a field, let go over the backdrop); without them each does nothing.
  `paused` stands the hold aside, as `holdFocus` does, for a dialog opened
  over this one: its Escape then closes the top one alone.

  `size`: sm (28rem), md (32rem), lg (40rem). `class` is added to the box and
  `footerClass` to the button row: the hooks tests read.

  Drawn where it is placed, not moved to the end of the page: so never draw
  one inside a sticky rail or a transformed box, whose stacking context would
  hold the backdrop under the page's header. The board view never uses it
  (`docs/ui-kit.md`).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { holdFocus } from '$lib/dialog-focus';
	import './ui-field.css';

	/**
	 * The first focus when none is named: the body's first enabled field, else
	 * the footer's first enabled button. One selector list, which
	 * `querySelector` answers in page order, so a field in the body comes before
	 * any button in the footer; nothing matched, and `holdFocus` takes the box.
	 */
	const FIRST_FIELD_OR_BUTTON = [
		'.ui-dialog-body input:not([type="hidden"]):not(:disabled)',
		'.ui-dialog-body select:not(:disabled)',
		'.ui-dialog-body textarea:not(:disabled)',
		'.ui-dialog-footer button:not(:disabled)'
	].join(', ');

	let {
		title,
		titleLevel = 2,
		description,
		size = 'md',
		role = 'dialog',
		'aria-label': ariaLabel,
		'aria-labelledby': ariaLabelledby,
		'aria-describedby': ariaDescribedby,
		class: className = '',
		footerClass = '',
		initialFocus,
		onEscape,
		onBackdrop,
		returnTo,
		paused = false,
		children,
		footer,
		...rest
	}: {
		/** The heading. */
		title: string;
		titleLevel?: 2 | 3;
		/** Under the title, muted: words, or the caller's own element. */
		description?: string | Snippet;
		size?: 'sm' | 'md' | 'lg';
		role?: 'dialog' | 'alertdialog';
		'aria-label'?: string;
		'aria-labelledby'?: string;
		'aria-describedby'?: string;
		/** Added to the box. */
		class?: string;
		/** Added to the button row. */
		footerClass?: string;
		/** A selector inside the box for the first focus. */
		initialFocus?: string;
		/** Escape, pressed while the dialog is up. */
		onEscape?: () => void;
		/** A press on the backdrop itself. */
		onBackdrop?: () => void;
		/** Where the focus goes back to as it closes, asked then. */
		returnTo?: () => HTMLElement | null | undefined;
		/** A dialog is open over this one: Escape and Tab are left to it (`holdFocus`'s `paused`). */
		paused?: boolean;
		/** The body. */
		children: Snippet;
		/** The button row; not drawn without it. */
		footer?: Snippet;
		id?: string;
		[attribute: `data-${string}`]: unknown;
		[attribute: `aria-${string}`]: unknown;
	} = $props();

	const titleId = $props.id();
	const descriptionId = `${titleId}-description`;

	const labelledBy = $derived(ariaLabelledby ?? (ariaLabel ? undefined : titleId));
	const describedBy = $derived(ariaDescribedby ?? (typeof description === 'string' && description !== '' ? descriptionId : undefined));

	/**
	 * Whether the last press went down on the backdrop itself. A click's target
	 * is where the press went down and came up in common, so a drag from a field
	 * in the box to the backdrop is a click on the backdrop: it is not taken.
	 */
	let downOnBackdrop = false;

	function pressDown(e: PointerEvent) {
		downOnBackdrop = e.target === e.currentTarget;
	}

	/** A press on the backdrop itself: down and up on it, neither in the box. */
	function backdrop(e: MouseEvent) {
		const pressed = downOnBackdrop && e.target === e.currentTarget;
		downOnBackdrop = false;
		if (pressed) onBackdrop?.();
	}
</script>

<div class="ui-dialog-overlay" role="presentation" onpointerdown={pressDown} onclick={backdrop}>
	<div
		{...rest}
		class={['ui-dialog', `ui-dialog-${size}`, className]}
		{role}
		aria-modal="true"
		aria-label={ariaLabel}
		aria-labelledby={labelledBy}
		aria-describedby={describedBy}
		tabindex="-1"
		use:holdFocus={{ first: initialFocus ?? FIRST_FIELD_OR_BUTTON, onEscape, returnTo, paused }}
	>
		<div class="ui-dialog-header">
			{#if titleLevel === 3}
				<h3 class="ui-dialog-title" id={titleId}>{title}</h3>
			{:else}
				<h2 class="ui-dialog-title" id={titleId}>{title}</h2>
			{/if}
			{#if typeof description === 'string'}
				{#if description}<p class="ui-dialog-description" id={descriptionId}>{description}</p>{/if}
			{:else if description}
				{@render description()}
			{/if}
		</div>
		<div class="ui-dialog-body">
			{@render children()}
		</div>
		{#if footer}
			<div class={['ui-dialog-footer', footerClass]}>
				{@render footer()}
			</div>
		{/if}
	</div>
</div>

<style>
	.ui-dialog-overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		display: grid;
		place-items: center;
		padding: 1rem;
		/* Clear of the update bar at the foot of the screen while it shows (src/routes/+layout.svelte). */
		padding-bottom: calc(1rem + var(--update-bar-space, 0px));
		background: color-mix(in srgb, #000 50%, transparent);
		animation: ui-dialog-fade var(--duration-fast) var(--ease-out);
	}

	.ui-dialog {
		display: flex;
		flex-direction: column;
		width: 100%;
		max-height: calc(100dvh - 2rem - var(--update-bar-space, 0px));
		border: 1px solid var(--ui-border);
		border-radius: var(--ui-radius-lg);
		background: var(--ui-card);
		color: var(--ui-foreground);
		box-shadow: var(--ui-shadow);
		text-align: left;
		animation: ui-dialog-in var(--duration-fast) var(--ease-out);
	}
	/* Focused only where nothing in it can be: no ring for a box the reader cannot act on. */
	.ui-dialog:focus {
		outline: none;
	}
	.ui-dialog-sm {
		max-width: 28rem;
	}
	.ui-dialog-md {
		max-width: 32rem;
	}
	.ui-dialog-lg {
		max-width: 40rem;
	}

	.ui-dialog-header {
		padding: 1.5rem 1.5rem 0;
	}
	.ui-dialog-title {
		margin: 0;
		font-size: 1.125rem;
		font-weight: 600;
		line-height: 1.35;
		letter-spacing: -0.01em;
		color: var(--ui-foreground);
	}
	.ui-dialog-description,
	.ui-dialog-header > :global(p) {
		margin: 0.375rem 0 0;
		font-size: 0.875rem;
		line-height: 1.5;
		color: var(--ui-muted-foreground);
	}

	/* The middle scrolls while the title and the buttons stay put. */
	.ui-dialog-body {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.75rem;
		min-height: 0;
		overflow-y: auto;
		padding: 1rem 1.5rem;
		font-size: 0.875rem;
		line-height: 1.55;
	}
	.ui-dialog-body > :global(*) {
		margin: 0;
	}

	.ui-dialog-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 0 1.5rem 1.5rem;
	}

	/* A phone: the buttons full width, the action on top; their order in the page (Cancel first) is kept. */
	@media (max-width: 640px) {
		.ui-dialog-footer {
			flex-direction: column-reverse;
		}
		.ui-dialog-footer :global(.ui-btn) {
			width: 100%;
		}
	}

	@keyframes ui-dialog-fade {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes ui-dialog-in {
		from {
			opacity: 0;
			transform: scale(0.97);
		}
		to {
			opacity: 1;
			transform: scale(1);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ui-dialog-overlay,
		.ui-dialog {
			animation: none;
		}
	}
</style>
