<!--
  RequestToasts.svelte — The dashboard's notices of new requests: the inbox
  read as the page opens and every 30 seconds after, and a toast for each
  request that arrived since the last read (card 2281, slice C2: moved from
  src/routes/+page.svelte).

  The count of waiting requests is the page's (`inboxCount`, bound here),
  which the header shows. Drawn by the page where its toasts were, after
  every other window.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	/** The page's: how many requests wait in the inbox, which the header shows. */
	let { inboxCount = $bindable() }: { inboxCount: number } = $props();

	// Toast notifications
	type Toast = { id: number; title: string; requesterName: string; priority: string; timestamp: number };
	let toasts = $state<Toast[]>([]);
	let toastIdCounter = 0;
	let inboxPollTimer: ReturnType<typeof setInterval> | null = null;

	function addToast(title: string, requesterName: string, priority: string) {
		const id = ++toastIdCounter;
		toasts = [...toasts, { id, title, requesterName, priority, timestamp: Date.now() }];
		setTimeout(() => dismissToast(id), 6000);
	}

	function dismissToast(id: number) {
		toasts = toasts.filter(t => t.id !== id);
	}

	onMount(async () => {
		const res = await fetch('/api/requests');
		if (res.ok) {
			const requests = await res.json();
			inboxCount = requests.filter((r: any) => r.status === 'pending').length;
		}

		// Poll inbox every 30 seconds for live updates
		inboxPollTimer = setInterval(async () => {
			try {
				const res = await fetch('/api/requests');
				if (res.ok) {
					const requests = await res.json();
					const newCount = requests.filter((r: any) => r.status === 'pending').length;
					if (newCount > inboxCount) {
						// New requests arrived — find them and show toasts
						const pending = requests.filter((r: any) => r.status === 'pending');
						const newOnes = pending.slice(0, newCount - inboxCount);
						for (const req of newOnes) {
							addToast(req.title, req.requesterName, req.priority);
						}
					}
					inboxCount = newCount;
				}
			} catch { /* silent */ }
		}, 30_000);
	});

	onDestroy(() => {
		if (inboxPollTimer) clearInterval(inboxPollTimer);
	});
</script>

{#if toasts.length > 0}
	<div class="toast-container">
		{#each toasts as toast (toast.id)}
			<div class="toast toast-slide-in">
				<div class="toast-accent priority-{toast.priority}"></div>
				<div class="toast-body">
					<div class="toast-header">
						<span class="toast-icon">📥</span>
						<span class="toast-label">New Request</span>
						<button class="toast-close" onclick={() => dismissToast(toast.id)}>✕</button>
					</div>
					<p class="toast-title">{toast.title}</p>
					<p class="toast-from">From: {toast.requesterName}</p>
				</div>
			</div>
		{/each}
	</div>
{/if}

<style>
	/* ─── Toast Notifications ───────────────────────────────────── */
	.toast-container {
		position: fixed; top: var(--space-lg); right: var(--space-lg);
		z-index: 9999; display: flex; flex-direction: column;
		gap: var(--space-sm); max-width: 380px; width: 100%;
	}
	.toast {
		display: flex; overflow: hidden;
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
		backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
	}
	.toast-accent {
		width: 4px; flex-shrink: 0;
	}
	.toast-accent.priority-critical { background: var(--priority-critical, #dc2626); }
	.toast-accent.priority-high { background: var(--priority-high, #ea580c); }
	.toast-accent.priority-medium { background: var(--accent-indigo); }
	.toast-accent.priority-low { background: var(--accent-emerald); }
	.toast-body {
		flex: 1; padding: var(--space-sm) var(--space-md);
	}
	.toast-header {
		display: flex; align-items: center; gap: var(--space-xs);
		margin-bottom: 4px;
	}
	.toast-icon { font-size: 0.9rem; }
	.toast-label {
		font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.04em; color: var(--accent-indigo); flex: 1;
	}
	.toast-close {
		background: none; border: none; font-size: 0.8rem; cursor: pointer;
		color: var(--text-tertiary); padding: 2px; line-height: 1;
	}
	.toast-close:hover { color: var(--text-primary); }
	.toast-title {
		font-size: 0.85rem; font-weight: 600; color: var(--text-primary);
		margin: 0 0 2px; line-height: 1.3;
		display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2;
		-webkit-box-orient: vertical; overflow: hidden;
	}
	.toast-from {
		font-size: 0.72rem; color: var(--text-tertiary); margin: 0;
	}
	@keyframes toastSlideIn {
		from { opacity: 0; transform: translateX(100%); }
		to { opacity: 1; transform: translateX(0); }
	}
	.toast-slide-in { animation: toastSlideIn 0.35s ease-out both; }
</style>
