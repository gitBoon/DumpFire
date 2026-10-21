<!--
  CardDependencies.svelte — A saved card's milestone and dependencies, in the
  card window's More options (card 2280, slice B4: moved from CardModal.svelte).

  The two planning facts that are recorded by hand. Everything derived from
  them (critical path, what is startable) lives in the planning view at
  /plan — this section only edits the raw facts.

  What it shows is the window's, bound here: the window reads the links
  when it opens (`loadDependencies`), keeps them, the picker's search and
  the milestone while More options is shut or another tab is shown, and
  runs the picker's search (`onPickerInput`, debounced). Adding and removing
  a link and attaching the card to a milestone are sent from here, each
  answer read and a refusal said above the lists (`depError`).
-->
<script lang="ts">
	import { dependencyEndBody, dependencyRow, failureMessage } from '$lib/api';
	import type { CardType, DependencyRefType, MilestoneType } from '$lib/types';

	let {
		card,
		boardId,
		milestones,
		blockedBy = $bindable(),
		blocks = $bindable(),
		depsLoading,
		depError = $bindable(),
		pickerMode = $bindable(),
		pickerQuery = $bindable(),
		pickerResults = $bindable(),
		pickerSearching,
		pickerError = '',
		milestoneId = $bindable(),
		milestoneSaving = $bindable(),
		loadDependencies,
		onPickerInput,
		onClosePicker,
		onListsWritten,
		onWrote
	}: {
		card: CardType | null;
		boardId: number;
		milestones: MilestoneType[];
		blockedBy: DependencyRefType[];
		blocks: DependencyRefType[];
		depsLoading: boolean;
		depError: string;
		/** Which list the picker is adding to: this card waits on X, or X waits on this card. */
		pickerMode: null | 'blocked-by' | 'blocks';
		pickerQuery: string;
		pickerResults: { id: number; title: string; boardId: number; boardName: string; boardEmoji: string; columnName: string; priority: string }[];
		pickerSearching: boolean;
		/** The window's: why the latest search found nothing to show, said in place of "No cards match" (card 2384). */
		pickerError?: string;
		milestoneId: number | null;
		milestoneSaving: boolean;
		/** The window's: reads the card's links again. */
		loadDependencies: () => Promise<void>;
		/** The window's: searches for what the picker has typed, debounced. */
		onPickerInput: () => void;
		/**
		 * The window's: closes the picker, emptied, and drops any search still
		 * waiting or out (card 2388). Every close here goes through it.
		 */
		onClosePicker: () => void;
		/**
		 * The window's, called when a link added or removed has set the lists
		 * from its answer, so that a read of them sent before is not taken
		 * over it (card 2384).
		 */
		onListsWritten?: () => void;
		/**
		 * The window's `onWrote`, called once a link or the milestone is saved
		 * (card 2324), and where the plan may be out of date though it was not
		 * (card 2379): a change that got no answer, which may have been made,
		 * and any refusal, which can mean it was already done elsewhere (a
		 * link someone else removed, a card already out of its goal).
		 */
		onWrote?: () => void;
	} = $props();

	/** What a change that got no answer says: it may or may not have been made. */
	const NO_ANSWER = 'No answer from the server. It is not known whether that was saved.';

	async function addDependency(otherCardId: number) {
		if (!card || !pickerMode) return;
		depError = '';
		// The picker finds cards only.
		const body = dependencyEndBody(pickerMode, { kind: 'card', cardId: otherCardId });
		let res: Response;
		try {
			res = await fetch(`/api/cards/${card.id}/dependencies`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
		} catch {
			depError = NO_ANSWER;
			onWrote?.();
			return;
		}
		if (res.ok) {
			// The link is saved whatever the answer's body says: one that is not
			// the two lists still tells the plan, and the lists are read again.
			const data = await readLists(res);
			onClosePicker();
			onWrote?.();
			if (data) {
				onListsWritten?.();
				blockedBy = data.blockedBy;
				blocks = data.blocks;
			} else {
				await loadDependencies();
			}
		} else {
			// A rejected cycle names the loop it found, which is the whole value of
			// the check — surface the server's message rather than a generic error.
			depError = await failureMessage(res, 'Could not add that dependency');
			// Any refusal reads the plan again as the window closes (card 2379's review).
			onWrote?.();
		}
	}

	/** A success's two lists, or null when its body is not them (a proxy's page, which is not JSON). */
	async function readLists(res: Response): Promise<{ blockedBy: DependencyRefType[]; blocks: DependencyRefType[] } | null> {
		try {
			const data = await res.json();
			return Array.isArray(data?.blockedBy) && Array.isArray(data?.blocks) ? data : null;
		} catch {
			return null;
		}
	}

	/** Remove the link the row `d` shows. A subtask row's id is the subtask's, and is sent as one. */
	async function removeDependency(d: DependencyRefType, mode: 'blocked-by' | 'blocks') {
		if (!card) return;
		depError = '';
		const body = dependencyEndBody(mode, d);
		let res: Response;
		try {
			res = await fetch(`/api/cards/${card.id}/dependencies`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
		} catch {
			depError = NO_ANSWER;
			onWrote?.();
			return;
		}
		if (res.ok) {
			// Removed whatever the answer's body says, as for an added link.
			const data = await readLists(res);
			onWrote?.();
			if (data) {
				onListsWritten?.();
				blockedBy = data.blockedBy;
				blocks = data.blocks;
			} else {
				await loadDependencies();
			}
		} else {
			// A link somebody else already removed is answered 404. Say so, where
			// this used to do nothing and leave the row looking removable.
			depError = await failureMessage(res, 'Could not remove that dependency');
			// The plan behind the window may still draw it: any refusal reads
			// the plan again as the window closes (card 2379 and its review).
			onWrote?.();
			// And read the links again, as when the card was opened: the row
			// that was refused is the one that is out of date, and left in the
			// list it still looks removable beside a message saying it is gone.
			await loadDependencies();
		}
	}

	/**
	 * `select` shows the choice before the answer comes, and is put back to the
	 * milestone the card is in when the change is not made.
	 */
	async function saveMilestone(next: number | null, select?: HTMLSelectElement) {
		if (!card) return;
		milestoneSaving = true;
		depError = '';
		const putBack = () => {
			if (select) select.value = String(milestoneId ?? '');
		};
		try {
			const target = next ?? milestoneId;
			if (target === null) return;
			const res = await fetch(`/api/milestones/${target}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cardId: card.id, attach: next !== null })
			});
			if (res.ok) {
				milestoneId = next;
				onWrote?.();
			} else {
				putBack();
				depError = await failureMessage(res, 'Could not change the milestone');
				// A card already out of the goal is answered 404: any refusal
				// reads the plan again as the window closes (card 2379's review).
				onWrote?.();
			}
		} catch {
			putBack();
			depError = NO_ANSWER;
			onWrote?.();
		} finally {
			milestoneSaving = false;
		}
	}

	/** How many blockers are still open — what the "Blocked" state actually means. */
	const openBlockerCount = $derived(blockedBy.filter((d) => !d.resolved).length);
</script>

<!--
	The dependency picker, shared by both directions. Searches by "#id" or title
	across every board the user can see, because dependencies are deliberately
	cross-board — a migration touches several projects and the picker has to
	reach those cards. Foreign cards show as "Board / column".

	Escape in its search box closes the picker and goes no further: the key
	went on to the window's handler, which closed the whole window and what
	was typed in it (card 2280, slice B5c). Escape and ✕ close it through the
	window's `onClosePicker`, which drops a search still waiting (card 2388).
-->
{#snippet depPicker(placeholder: string)}
	<div class="dep-picker">
		<!-- svelte-ignore a11y_autofocus -->
		<input
			class="dep-picker-input"
			type="text"
			{placeholder}
			bind:value={pickerQuery}
			oninput={onPickerInput}
			onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClosePicker(); } }}
			autofocus
		/>
		<button class="dep-picker-cancel" title="Cancel" onclick={onClosePicker}>✕</button>
	</div>
	<!-- A search that failed is said in place of "No cards match" (card 2384). A box emptied by closing is never "Searching…". -->
	{#if pickerSearching && pickerQuery.trim()}
		<p class="dep-empty">Searching…</p>
	{:else if pickerQuery.trim() && pickerError}
		<p class="dep-search-error" role="alert">{pickerError}</p>
	{:else if pickerQuery.trim() && pickerResults.length === 0}
		<p class="dep-empty">No cards match “{pickerQuery.trim()}”.</p>
	{:else if pickerResults.length > 0}
		<div class="dep-results">
			{#each pickerResults as r}
				<button class="dep-result" onclick={() => addDependency(r.id)}>
					<span class="dep-id">#{r.id}</span>
					<span class="dep-title">{r.title}</span>
					<span class="dep-where">{r.boardEmoji} {r.boardName} / {r.columnName}</span>
				</button>
			{/each}
		</div>
	{/if}
{/snippet}

<!--
	Planning: the two facts recorded by hand — what blocks this card,
	and which goal it belongs to. Everything derived from them lives in
	the planning view at /plan.
-->
{#if card}
<div class="form-group">
	<label for="dep-milestone">Milestone</label>
	<div class="milestone-row">
		<select
			id="dep-milestone"
			class="milestone-select"
			value={milestoneId ?? ''}
			disabled={milestoneSaving}
			onchange={(e) => {
				const v = e.currentTarget.value;
				saveMilestone(v === '' ? null : Number(v), e.currentTarget);
			}}
		>
			<option value="">No milestone</option>
			{#each milestones as m}
				<option value={m.id}>{m.name}{m.boardId === null ? ' (cross-board)' : ''}</option>
			{/each}
		</select>
		{#if milestoneId}
			<a class="milestone-plan-link" href="/plan/{milestoneId}" target="_blank" rel="noopener">Open plan ↗</a>
		{/if}
	</div>
</div>

<div class="form-group">
	<label id="deps-label">Dependencies</label>
	{#if depError}
		<div class="dep-error">{depError}</div>
	{/if}

	<div class="dep-block" aria-labelledby="deps-label">
		<div class="dep-heading">
			<span class="dep-heading-label">Blocked by</span>
			{#if openBlockerCount > 0}
				<span class="dep-open-count">{openBlockerCount} still open</span>
			{/if}
		</div>
		{#if depsLoading}
			<p class="dep-empty">Loading…</p>
		{:else if blockedBy.length === 0}
			<p class="dep-empty">Nothing is blocking this card.</p>
		{:else}
			<div class="dep-list">
				{#each blockedBy as d}
					{@const row = dependencyRow(d)}
					<div class="dep-row" class:is-resolved={d.resolved}>
						<a class="dep-link" href={row.href} title={d.title}>
							<span class="dep-id">{row.label}</span>
							<span class="dep-title">{d.title}</span>
							<!-- A withheld row, on a board the caller cannot open, has no link and no board or column (card 2129). -->
							{#if !d.withheld}<span class="dep-where">{#if d.boardId !== boardId}{d.boardName} / {/if}{d.columnName}</span>{/if}
						</a>
						<button class="dep-remove" title="Remove this dependency" onclick={() => removeDependency(d, 'blocked-by')}>✕</button>
					</div>
				{/each}
			</div>
		{/if}
		{#if pickerMode === 'blocked-by'}
			{@render depPicker('Search the card this one waits on…')}
		{:else}
			<!-- The other list's picker, if open, is closed first, and its search with it (card 2388). -->
			<button class="btn-ghost dep-add-btn" onclick={() => { onClosePicker(); pickerMode = 'blocked-by'; depError = ''; }}>+ Add a blocker</button>
		{/if}
	</div>

	<div class="dep-block">
		<div class="dep-heading">
			<span class="dep-heading-label">Blocks</span>
		</div>
		{#if blocks.length === 0}
			<p class="dep-empty">This card is not holding anything up.</p>
		{:else}
			<div class="dep-list">
				{#each blocks as d}
					{@const row = dependencyRow(d)}
					<div class="dep-row" class:is-resolved={d.resolved}>
						<a class="dep-link" href={row.href} title={d.title}>
							<span class="dep-id">{row.label}</span>
							<span class="dep-title">{d.title}</span>
							{#if !d.withheld}<span class="dep-where">{#if d.boardId !== boardId}{d.boardName} / {/if}{d.columnName}</span>{/if}
						</a>
						<button class="dep-remove" title="Remove this dependency" onclick={() => removeDependency(d, 'blocks')}>✕</button>
					</div>
				{/each}
			</div>
		{/if}
		{#if pickerMode === 'blocks'}
			{@render depPicker('Search the card that waits on this one…')}
		{:else}
			<button class="btn-ghost dep-add-btn" onclick={() => { onClosePicker(); pickerMode = 'blocks'; depError = ''; }}>+ Add a card this blocks</button>
		{/if}
	</div>
</div>
{/if}

<style>
	/* The window's own field style, on the boxes here (CardModal.svelte's `.card-modal-content input` and `select`). */
	:global(.card-modal-content) input,
	:global(.card-modal-content) select {
		background: var(--bg-base); border: 1px solid var(--glass-border);
	}
	:global(.card-modal-content) input:focus,
	:global(.card-modal-content) select:focus {
		border-color: var(--accent-indigo); box-shadow: 0 0 0 2px var(--accent-purple-glow);
	}

	.form-group { margin-bottom: var(--space-lg); }
	.form-group label {
		display: flex; align-items: center; gap: var(--space-sm);
		font-size: 0.7rem; font-weight: 600; color: var(--text-secondary);
		text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm);
	}

	/* ─── Dependencies & milestone ─────────────────────────────────────── */

	.milestone-row { display: flex; gap: var(--space-sm); align-items: center; }

	.milestone-select {
		flex: 1; min-width: 0;
		padding: 7px 10px; background: var(--bg-surface);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		color: var(--text-primary); font-family: var(--font-family); font-size: 0.8rem;
		cursor: pointer;
	}
	.milestone-select:focus { outline: none; border-color: var(--accent-indigo); }
	.milestone-select:disabled { opacity: 0.6; cursor: wait; }

	.milestone-plan-link {
		font-size: 0.72rem; font-weight: 600; white-space: nowrap;
		color: #a78bfa; text-decoration: none;
	}
	.milestone-plan-link:hover { text-decoration: underline; }

	.dep-block { margin-bottom: var(--space-md); }
	.dep-block:last-child { margin-bottom: 0; }

	.dep-heading {
		display: flex; align-items: baseline; gap: var(--space-sm);
		margin-bottom: 6px;
	}
	.dep-heading-label {
		font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.05em; color: var(--text-tertiary);
	}
	.dep-open-count {
		font-size: 0.66rem; font-weight: 700; padding: 1px 7px;
		border-radius: var(--radius-full);
		background: rgba(245, 158, 11, 0.14); color: #f59e0b;
		border: 1px solid rgba(245, 158, 11, 0.3);
	}

	.dep-empty { margin: 0 0 6px; font-size: 0.75rem; color: var(--text-tertiary); }

	.dep-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px; }

	.dep-row {
		display: flex; align-items: center; gap: 4px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); padding: 5px 6px 5px 9px;
	}
	/* A resolved end still shows — it is a record of the ordering decision, not
	   noise — but it steps back so the open ones read first. */
	.dep-row.is-resolved { opacity: 0.5; }
	.dep-row.is-resolved .dep-title { text-decoration: line-through; }

	.dep-link {
		display: flex; align-items: baseline; gap: 6px;
		flex: 1; min-width: 0; text-decoration: none; color: inherit;
	}
	.dep-link:hover .dep-title { color: var(--accent-indigo); }

	.dep-id {
		font-size: 0.68rem; font-weight: 700; color: var(--text-tertiary);
		font-variant-numeric: tabular-nums; flex-shrink: 0;
	}
	.dep-title {
		font-size: 0.78rem; color: var(--text-primary);
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		transition: color var(--duration-fast) var(--ease-out);
	}
	.dep-where {
		margin-left: auto; flex-shrink: 0;
		font-size: 0.66rem; color: var(--text-tertiary); white-space: nowrap;
	}

	.dep-remove {
		flex-shrink: 0; width: 20px; height: 20px; padding: 0;
		display: flex; align-items: center; justify-content: center;
		background: none; border: none; cursor: pointer; font: inherit;
		font-size: 0.7rem; color: var(--text-tertiary);
		border-radius: var(--radius-sm);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.dep-remove:hover { background: rgba(244, 63, 94, 0.15); color: var(--accent-rose); }

	.dep-add-btn { font-size: 0.72rem; padding: 4px 10px; }

	.dep-picker { display: flex; gap: 4px; align-items: center; margin-bottom: 6px; }

	.dep-picker-input {
		flex: 1; min-width: 0;
		padding: 6px 10px; background: var(--bg-surface);
		border: 1px solid var(--accent-indigo); border-radius: var(--radius-sm);
		color: var(--text-primary); font-family: var(--font-family); font-size: 0.78rem;
	}
	.dep-picker-input:focus { outline: none; }

	.dep-picker-cancel {
		flex-shrink: 0; width: 24px; height: 24px; padding: 0;
		display: flex; align-items: center; justify-content: center;
		background: none; border: none; cursor: pointer; font: inherit;
		font-size: 0.75rem; color: var(--text-tertiary); border-radius: var(--radius-sm);
	}
	.dep-picker-cancel:hover { background: var(--bg-elevated); color: var(--text-primary); }

	.dep-results {
		display: flex; flex-direction: column; gap: 2px;
		max-height: 220px; overflow-y: auto; margin-bottom: 6px;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		padding: 3px;
	}

	.dep-result {
		display: flex; align-items: baseline; gap: 6px;
		width: 100%; text-align: left; padding: 5px 8px;
		background: none; border: none; cursor: pointer; font: inherit;
		border-radius: var(--radius-sm);
		transition: background var(--duration-fast) var(--ease-out);
	}
	.dep-result:hover { background: var(--bg-elevated); }

	.dep-error {
		margin-bottom: 8px; padding: 7px 10px;
		font-size: 0.74rem; line-height: 1.4;
		background: rgba(244, 63, 94, 0.1); color: var(--accent-rose);
		border: 1px solid rgba(244, 63, 94, 0.25); border-radius: var(--radius-sm);
	}

	/* A search that failed, under the picker's box, in the rose of the section's other messages (card 2384). */
	.dep-search-error { margin: 0 0 6px; font-size: 0.75rem; line-height: 1.4; color: var(--accent-rose); }
</style>
