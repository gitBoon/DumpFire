<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { afterNavigate, onNavigate } from '$app/navigation';
	import { toasts } from '$lib/stores/toast';

	let items = $state<{ id: number; message: string; type: string; stays?: true }[]>([]);
	toasts.subscribe(v => (items = v));

	// A warning that stays is said politely (card 2397's reviews): it tells of
	// something done, not of a failure. Through a region that is always on the
	// page, as one added with its words already in it is not reliably read; a
	// toast that goes by itself, the board's warnings included, is an alert,
	// which is read as it is added. Each staying warning added, the same words
	// again included (it comes back as a new toast), empties the region and
	// fills it a moment later, as a region whose text does not change is not
	// read again (the third code review).
	const SAY_AFTER_MS = 100;
	let stayingId = $derived(items.filter(t => t.stays).at(-1)?.id ?? null);
	let saidPolitely = $state('');
	$effect(() => {
		const id = stayingId;
		const message = untrack(() => items.find(t => t.id === id)?.message ?? '');
		saidPolitely = '';
		if (message === '') return;
		const timer = setTimeout(() => (saidPolitely = message), SAY_AFTER_MS);
		return () => clearTimeout(timer);
	});

	// A failure stays until it is closed, and never follows the reader to
	// another page: it is cleared when the page goes, and when the page is
	// navigated without going. SvelteKit keeps a page when only its route's
	// parameter changes, as from a board to its sub-board, and nothing is
	// destroyed then.
	onDestroy(() => toasts.clearErrors());
	afterNavigate(() => toasts.clearErrors());
	// Nor is a failure that arrives after that, from a request the page started
	// before it was left: each navigation is counted as it begins, and a page
	// gives a failure the count its request started under (`toasts.navigation()`).
	onNavigate(() => toasts.navigated());
</script>

<p class="toast-said" role="status">{saidPolitely}</p>
{#if items.length > 0}
	<div class="toast-container">
		{#each items as toast (toast.id)}
			<!-- A warning that stays is said by the region above, so it is not said twice. -->
			<div class="toast toast-{toast.type}" role={toast.stays ? undefined : 'alert'}>
				<span class="toast-icon">
					{#if toast.type === 'success'}✓{:else if toast.type === 'error'}✕{:else if toast.type === 'warning'}⚠️{:else}ℹ{/if}
				</span>
				<span class="toast-msg">{toast.message}</span>
				<button class="toast-close" onclick={() => toasts.dismiss(toast.id)}>✕</button>
			</div>
		{/each}
	</div>
{/if}

<style>
	.toast-container {
		/* Above every dialog: a refusal is shown while the dialog that asked stays open.
		   Raised clear of the update bar while it shows (src/routes/+layout.svelte). */
		position: fixed; bottom: calc(24px + var(--update-bar-space, 0px)); right: 24px; z-index: 10000;
		display: flex; flex-direction: column-reverse; gap: 8px;
		pointer-events: none;
	}
	.toast {
		pointer-events: auto;
		display: flex; align-items: center; gap: 8px;
		padding: 10px 16px; border-radius: 10px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		box-shadow: 0 8px 24px rgba(0,0,0,0.25);
		font-size: 0.82rem; font-weight: 600;
		animation: toastIn 0.25s ease-out;
		min-width: 200px; max-width: 360px;
	}
	@keyframes toastIn {
		from { transform: translateX(40px); opacity: 0; }
		to { transform: translateX(0); opacity: 1; }
	}
	.toast-icon { font-size: 1rem; flex-shrink: 0; }
	.toast-success .toast-icon { color: #22c55e; }
	.toast-error .toast-icon { color: #ef4444; }
	.toast-info .toast-icon { color: #6366f1; }
	.toast-warning .toast-icon { color: #f59e0b; }
	.toast-warning { border-color: rgba(245, 158, 11, 0.3); }
	.toast-msg { flex: 1; }
	.toast-close {
		background: none; border: none; cursor: pointer; padding: 2px;
		color: var(--text-tertiary); font-size: 0.7rem;
		opacity: 0.5; transition: opacity 0.15s;
	}
	.toast-close:hover { opacity: 1; }
	/* For screen readers alone. */
	.toast-said {
		position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
		overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
	}
</style>
