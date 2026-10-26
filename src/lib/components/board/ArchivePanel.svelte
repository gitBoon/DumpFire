<!--
  ArchivePanel.svelte — The board page's Archived Cards panel (card 2280,
  slice B3: moved from the board page).

  The board's archived cards as the page read them when the panel was
  opened, each with Restore and Delete Permanently. It sends nothing itself:
  the page restores, asks before deleting for good, and takes a card off the
  list only once the server has done it.
-->
<script lang="ts">
	import { parseStamp } from '$lib/timestamps';
	import SidePanel from './SidePanel.svelte';

	/**
	 * An archived card, as `GET /api/boards/[id]/archive` answers it.
	 * `discardedAt` is set on an option archived from upstream, which is marked
	 * "Discarded" (milestone 22, card 2461).
	 */
	type ArchivedCard = { id: number; title: string; archivedAt?: string | null; discardedAt?: string | null };

	let {
		cards,
		loading,
		onClose,
		onRestore,
		onDeleteForever
	}: {
		cards: ArchivedCard[];
		loading: boolean;
		onClose: () => void;
		onRestore: (cardId: number) => void;
		/** Asks first: the page's confirmation, then the delete. */
		onDeleteForever: (card: ArchivedCard) => void;
	} = $props();
</script>

<SidePanel title="🗄️ Archived Cards" {onClose}>
	{#if loading}
		<div class="archive-loading">Loading...</div>
	{:else if cards.length === 0}
		<div class="archive-empty">
			<span class="archive-empty-icon">📦</span>
			<p>No archived cards</p>
			<p class="archive-empty-hint">Archived cards appear here and can be restored</p>
		</div>
	{:else}
		<div class="archive-list">
			{#each cards as card (card.id)}
				<div class="archive-card">
					<div class="archive-card-info">
						<span class="archive-card-title">{card.title}</span>
						{#if card.discardedAt}
							<span class="archive-card-discarded" title="Discarded from the Options column. Restoring it makes it an idea again.">Discarded</span>
						{/if}
						{#if card.archivedAt}
							<span class="archive-card-date">Archived {parseStamp(card.archivedAt)?.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) ?? ''}</span>
						{/if}
					</div>
					<div class="archive-card-actions">
						<button class="btn-ghost small" onclick={() => onRestore(card.id)} title="Restore">
							↩️ Restore
						</button>
						<button class="btn-ghost small danger" onclick={() => onDeleteForever(card)} title="Delete permanently">
							🗑️
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</SidePanel>

<style>
	.archive-loading { text-align: center; padding: var(--space-xl); color: var(--text-tertiary); font-size: 0.85rem; }

	.archive-empty { text-align: center; padding: var(--space-xl) var(--space-md); }
	.archive-empty-icon { font-size: 2rem; display: block; margin-bottom: var(--space-sm); }
	.archive-empty p { color: var(--text-secondary); font-size: 0.85rem; margin: 2px 0; }
	.archive-empty-hint { color: var(--text-tertiary); font-size: 0.75rem; }

	.archive-list { display: flex; flex-direction: column; gap: var(--space-sm); }
	.archive-card {
		display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md); border-radius: var(--radius-md);
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.archive-card:hover { border-color: var(--accent-indigo); }
	.archive-card-info { flex: 1; min-width: 0; }
	.archive-card-title { font-size: 0.82rem; font-weight: 600; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.archive-card-date { font-size: 0.68rem; color: var(--text-tertiary); }
	.archive-card-discarded {
		font-size: 0.62rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
		padding: 1px 6px; margin-right: 4px; border-radius: var(--radius-sm);
		color: var(--accent-amber); border: 1px solid currentColor;
	}
	.archive-card-actions { display: flex; gap: 4px; flex-shrink: 0; }
	.archive-card-actions .danger { color: var(--accent-rose); }
	.archive-card-actions .danger:hover { background: rgba(239, 68, 68, 0.1); }

	/* ─── Mobile Responsive ──────────────────────────────────────────────── */

	@media (max-width: 768px) {
		/* Touch-friendly buttons */
		.btn-ghost {
			min-height: 36px;
			min-width: 36px;
		}
	}
</style>
