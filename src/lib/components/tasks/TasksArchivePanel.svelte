<!--
  TasksArchivePanel.svelte — All Tasks' Archived Cards: every archived card
  the viewer can see, each with Restore and Delete permanently (card 2281,
  slice C3a-2: moved from src/routes/all/+page.svelte).

  Whether it is open is the page's (`showArchivePanel`, bound here), which
  the More menu shows. `toggleArchivePanel` is exported: the page reaches it
  with `bind:this`. A delete for good asks first through the page's confirm
  dialog. Drawn always, so the list read is kept while the panel is shut,
  as before; drawn last in the page's panels area, where it was.
-->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toasts } from '$lib/stores/toast';
	import { cardDeleteWarning, deleteFailure, failureMessage } from '$lib/api';

	let {
		showConfirm,
		showArchivePanel = $bindable()
	}: {
		/** The page's confirm dialog, which asks before a card is deleted for good. */
		showConfirm: (title: string, message: string, confirmText: string, onConfirm: () => void) => void;
		/** The page's: whether Archived Cards is open. */
		showArchivePanel: boolean;
	} = $props();

	let archivedCards = $state<any[]>([]);
	let loadingArchive = $state(false);	/** Why the latest read failed, shown in the panel until a read is answered (card 2317); '' when it did not. */
	let archiveError = $state('');

	export async function toggleArchivePanel() {
		showArchivePanel = !showArchivePanel;
		if (showArchivePanel && archivedCards.length === 0) await loadAllArchived();
	}

	/**
	 * Read the archived cards. A refusal is said in the server's words, no
	 * answer as no answer, and an answer that is not the list (a proxy's page)
	 * as one that could not be read, in the panel in place of "No archived
	 * cards"; a list read before stays under it (card 2317: no answer was an
	 * unhandled rejection, and either said there were none).
	 */
	async function loadAllArchived() {
		loadingArchive = true;
		try {
			let res: Response;
			try {
				res = await fetch('/api/cards/archived');
			} catch {
				archiveError = 'No answer from the server. The archived cards could not be loaded.';				return;
			}
			if (!res.ok) {
				archiveError = await failureMessage(res, 'The archived cards could not be loaded.');
				return;
			}
			try {
				archivedCards = await res.json();
				archiveError = '';
			} catch {
				archiveError = "The server's answer could not be read. The archived cards could not be loaded.";
			}
		} finally {
			loadingArchive = false;
		}
	}

	async function restoreArchivedCard(cardId: number) {
		// The card leaves the list only when the server says it is restored.
		const started = toasts.navigation();
		const failure = await deleteFailure(() => fetch(`/api/cards/${cardId}/restore`, { method: 'POST' }), 'card', 'restored');
		if (failure) {
			toasts.add(failure, 'error', started);
			return;
		}
		archivedCards = archivedCards.filter(c => c.id !== cardId);
		toasts.add('Card restored');
		await invalidateAll();
	}

	function permanentlyDeleteArchivedCard(cardId: number, cardTitle: string) {
		showConfirm('Delete Permanently', cardDeleteWarning(cardTitle), 'Delete Forever', async () => {
			// The card leaves the list only when the server says it is gone.
			const started = toasts.navigation();
			const failure = await deleteFailure(
				() =>
					fetch(`/api/cards/${cardId}?permanent=true`, {
						method: 'DELETE',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({})
					}),
				'card'
			);
			if (failure) {
				toasts.add(failure, 'error', started);
				return;
			}
			archivedCards = archivedCards.filter(c => c.id !== cardId);
			toasts.add('Card permanently deleted', 'info');
		});
	}
</script>

{#if showArchivePanel}
<div class="activity-panel">
	<div class="activity-panel-header">
		<h3>🗄️ Archived Cards</h3>
		<div style="display:flex;gap:4px;">
			<button class="activity-refresh-btn" onclick={() => loadAllArchived()} title="Refresh">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 7a4.5 4.5 0 0 1 8.5-2M11.5 7a4.5 4.5 0 0 1-8.5 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M11 2v3h-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12V9h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
			</button>
			<button class="activity-refresh-btn" onclick={() => (showArchivePanel = false)} title="Close">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
			</button>
		</div>
	</div>
	<div class="activity-list" style="padding: var(--space-md);">
		{#if loadingArchive}
			<div class="activity-loading">Loading...</div>
		{:else}
			{#if archiveError}
				<div class="activity-error" role="alert">{archiveError}</div>
			{/if}
			{#if archivedCards.length === 0 && !archiveError}
				<div class="activity-empty">
					<span style="font-size:2rem;">📦</span>
					<p>No archived cards</p>
				</div>
			{/if}
			{#each archivedCards as card (card.id)}
				<div class="archive-card-item">
					<div class="archive-card-info">
						<span class="archive-card-title">{card.title}</span>
						{#if card.boardName}<span class="archive-card-board">{card.boardName}</span>{/if}
					</div>
					<div style="display:flex;gap:4px;">
						<button class="btn-ghost small" onclick={() => restoreArchivedCard(card.id)} title="Restore">↩️ Restore</button>
						<button class="btn-ghost small danger" onclick={() => permanentlyDeleteArchivedCard(card.id, card.title)} title="Delete permanently">🗑️</button>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>
{/if}

<style>
	/* Archive Card Items */
	.archive-card-item {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-sm); border-radius: var(--radius-sm);
		border: 1px solid var(--glass-border); margin-bottom: var(--space-xs);
		transition: border-color 0.15s;
	}
	.archive-card-item:hover { border-color: var(--accent-indigo); }
	.archive-card-info { flex: 1; min-width: 0; }
	.archive-card-title { font-size: 0.82rem; font-weight: 600; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.archive-card-board { font-size: 0.68rem; color: var(--text-tertiary); }
</style>
