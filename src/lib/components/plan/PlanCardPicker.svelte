<!--
  PlanCardPicker.svelte — The plan page's card picker: a search across every
  board the viewer can see, by #id or title, each result added to this goal
  with a click, one already in it shown and not offered (card 2281, slice
  C3a-3: moved from src/routes/plan/[id]/+page.svelte).

  Whether it is open is the page's (`picking`, bound here), which the
  header's Add cards opens; Done here closes it. Adding goes through the
  page's one PATCH path (`mutate`); `busy` is the page's while one is out.
  Drawn always, so what was typed is kept while the picker is shut by Add
  cards, as before.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/plan/[id]/$types';

	let {
		milestone,
		busy,
		mutate,
		picking = $bindable()
	}: {
		/** The page's: the goal itself. */
		milestone: PageData['summary']['milestone'];
		/** The page's: true while a change to the goal is being saved. */
		busy: boolean;
		/** The page's one PATCH path for every change to the goal. */
		mutate: (body: Record<string, unknown>) => Promise<void>;
		/** The page's: whether the card picker is open. */
		picking: boolean;
	} = $props();

	// ─── Card picker: attach existing cards to this goal ─────────────────────

	let pickQuery = $state('');
	let pickResults = $state<{ id: number; title: string; boardName: string; boardEmoji: string; columnName: string; milestoneId: number | null }[]>([]);
	let pickSearching = $state(false);
	let pickTimer: ReturnType<typeof setTimeout> | null = null;

	function onPickInput() {
		if (pickTimer) clearTimeout(pickTimer);
		const q = pickQuery.trim();
		if (!q) {
			pickResults = [];
			return;
		}
		pickSearching = true;
		pickTimer = setTimeout(async () => {
			try {
				const res = await fetch(`/api/cards/search?q=${encodeURIComponent(q)}`);
				pickResults = res.ok ? await res.json() : [];
			} finally {
				pickSearching = false;
			}
		}, 250);
	}

	async function attachCard(cardId: number) {
		await mutate({ cardId, attach: true });
		pickQuery = '';
		pickResults = [];
	}
</script>

{#if picking}
	<section class="panel picker-panel">
		<div class="picker-row">
			<input
				class="picker-input"
				type="text"
				placeholder="Search by #id or title, across every board you can see…"
				bind:value={pickQuery}
				oninput={onPickInput}
			/>
			<button class="btn-ghost" onclick={() => { picking = false; pickQuery = ''; pickResults = []; }}>Done</button>
		</div>
		{#if pickSearching}
			<p class="muted">Searching…</p>
		{:else if pickQuery.trim() && pickResults.length === 0}
			<p class="muted">No cards match “{pickQuery.trim()}”.</p>
		{:else if pickResults.length > 0}
			<div class="picker-results">
				{#each pickResults as r}
					<button
						class="picker-result"
						disabled={r.milestoneId === milestone.id || busy}
						onclick={() => attachCard(r.id)}
					>
						<span class="card-id">#{r.id}</span>
						<span class="card-title">{r.title}</span>
						<span class="card-where">{r.boardEmoji} {r.boardName} / {r.columnName}</span>
						{#if r.milestoneId === milestone.id}
							<span class="already">already in</span>
						{:else if r.milestoneId}
							<span class="already">moves from another goal</span>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</section>
{/if}

<style>
	/*
	 * The panel's frame, copied into each block of the plan page (card 2281,
	 * slice C3a-3): a rule in the page over every block would outrank the card
	 * picker's own border colour. The same is in PlanProgress, PlanBurndown,
	 * CriticalPathPanel, WorkTable and DependencyGraph.
	 */
	.panel {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-lg);
	}

	/* ─── Picker ───────────────────────────────────────────────────────── */

	.picker-panel { border-color: rgba(99, 102, 241, 0.35); }
	.picker-row { display: flex; gap: var(--space-sm); margin-bottom: var(--space-sm); }
	.picker-input {
		flex: 1; min-width: 0; padding: 8px 12px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.85rem;
	}
	.picker-input:focus { outline: none; border-color: var(--accent-indigo); }

	.picker-results {
		display: flex; flex-direction: column; gap: 2px;
		max-height: 300px; overflow-y: auto;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm); padding: 3px;
	}
	.picker-result {
		display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left;
		padding: 6px 10px; background: none; border: none; cursor: pointer; font: inherit;
		border-radius: var(--radius-sm); transition: background var(--duration-fast) var(--ease-out);
	}
	.picker-result:hover:not(:disabled) { background: var(--bg-elevated); }
	.picker-result:disabled { opacity: 0.5; cursor: default; }
	.already { font-size: 0.66rem; color: var(--text-tertiary); font-style: italic; }
</style>
