<!--
  CardTokenCost.svelte — What a saved card cost, in the card window under its
  subtasks' progress (card 2280, slice B4: moved from CardModal.svelte).

  The ledger is read by the window, once per card (keyed by the card's id,
  so not again for every read of the board), and handed here; so is whether
  the entries are unfolded, which stays as it was while another tab of the
  window is shown. `recorded: false` reads as "Not recorded", never as zero.
-->
<script module lang="ts">
	// What this card actually cost, loaded on open. `recorded: false` means
	// nothing has ever been reported — every card predating the ledger is in
	// that state, and it must read as "not recorded" rather than as zero.
	export interface TokenLedger {
		recorded: boolean;
		total: number;
		costUsd: number | null;
		costExact: boolean;
		unpricedTokens: number;
		direct: number;
		fromSubtasks: number;
		entries: number;
		byModel: { model: string; tokens: number }[];
		entryList: {
			id: number;
			subtaskId: number | null;
			subtaskTitle: string | null;
			tokens: number;
			model: string | null;
			inputTokens: number | null;
			outputTokens: number | null;
			cacheReadTokens: number | null;
			cacheWrite5mTokens: number | null;
			cacheWrite1hTokens: number | null;
			note: string | null;
			createdAt: string;
		}[];
	}
</script>

<script lang="ts">
	import { formatTokens } from '$lib/tokens';
	import { costOf, costInputOf, formatUsd, unpricedReason, BLEND_NOTE, SOURCE_NOTE, NOT_BILLED_NOTE, UNPRICED_SUM_NOTE } from '$lib/pricing';

	let {
		tokenLedger,
		tokensExpanded = $bindable()
	}: {
		tokenLedger: TokenLedger;
		tokensExpanded: boolean;
	} = $props();
</script>

<!-- What this cost. Sits with the progress bar because "how much is
     done" and "what it took" are the same question asked twice. -->
<div class="token-cost">
	{#if tokenLedger.recorded}
		<button class="token-summary" onclick={() => (tokensExpanded = !tokensExpanded)} type="button">
			<span class="token-label">Cost</span>
			<span class="token-total">{formatTokens(tokenLedger.total)}</span>
			{#if tokenLedger.costUsd !== null}
				<span class="token-money" title="{NOT_BILLED_NOTE}. {SOURCE_NOTE}{tokenLedger.costExact ? ' — exact, from reported input/output splits' : ` — ${BLEND_NOTE}`}.">
					{formatUsd(tokenLedger.costUsd)}{#if !tokenLedger.costExact}<span class="token-est">est</span>{/if}
				</span>
			{/if}
			<span class="token-sub">
				tokens{#if tokenLedger.fromSubtasks !== 0} · incl. {formatTokens(tokenLedger.fromSubtasks)} from subtasks{/if}{#if tokenLedger.unpricedTokens > 0} · <span class="token-unpriced" title="Tokens {UNPRICED_SUM_NOTE}, so they cannot be priced.">{formatTokens(tokenLedger.unpricedTokens)} unpriced</span>{/if}
			</span>
			<span class="token-chevron" class:open={tokensExpanded}>▾</span>
		</button>
		{#if tokensExpanded}
			{#if tokenLedger.byModel.length > 1}
				<div class="token-models">
					{#each tokenLedger.byModel as m}
						<span class="token-model-chip">{m.model} · {formatTokens(m.tokens)}</span>
					{/each}
				</div>
			{/if}
			<ul class="token-entries">
				{#each tokenLedger.entryList as e}
					{@const eCost = costOf([costInputOf(e)]).usd}
					<!-- Priced as the card's total is, so the rows add up to it. -->
					<li class="token-entry" class:negative={e.tokens < 0}>
						<span class="te-amount">{e.tokens > 0 ? '+' : ''}{formatTokens(e.tokens)}</span>
						<span class="te-what">
							{#if e.subtaskTitle}<span class="te-scope">{e.subtaskTitle}</span>{/if}
							{#if e.note}<span class="te-note">{e.note}</span>{/if}
							{#if !e.subtaskTitle && !e.note}<span class="te-note te-plain">card</span>{/if}
						</span>
						{#if e.model}<span class="te-model">{e.model}</span>{/if}
						<span class="te-cost" title={eCost === null ? unpricedReason(e.model) : undefined}>{formatUsd(eCost)}</span>
					</li>
				{/each}
			</ul>
		{/if}
	{:else}
		<div class="token-summary token-none">
			<span class="token-label">Cost</span>
			<span class="token-sub">Not recorded</span>
		</div>
	{/if}
</div>

<style>
	/* === Token cost ==========================================================
	   Cost is context for the work, not a headline, so it reads quieter than
	   the title and the subtasks. The one thing it must never do is imply a
	   measurement where none exists: "Not recorded" is a different statement
	   from "0 tokens", and every card older than this feature is the former. */
	.token-cost { margin-top: var(--space-sm); }
	.token-summary {
		display: flex; align-items: baseline; gap: var(--space-sm);
		width: 100%; padding: 7px 10px;
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
		background: var(--bg-surface); color: inherit;
		font-family: var(--font-family); text-align: left; cursor: pointer;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.token-summary:hover { border-color: var(--text-tertiary); }
	.token-none { cursor: default; }
	.token-none:hover { border-color: var(--glass-border); }
	.token-label {
		font-size: 0.68rem; font-weight: 700; letter-spacing: 0.04em;
		text-transform: uppercase; color: var(--text-tertiary);
	}
	.token-total {
		font-size: 0.95rem; font-weight: 700; color: var(--text-primary);
		font-variant-numeric: tabular-nums;
	}
	.token-sub { font-size: 0.74rem; color: var(--text-secondary); flex: 1; }
	.token-chevron {
		font-size: 0.7rem; color: var(--text-tertiary);
		transition: transform var(--duration-fast) var(--ease-out);
	}
	.token-chevron.open { transform: rotate(180deg); }
	.token-money {
		font-size: 0.9rem; font-weight: 700; color: var(--accent-violet, #8b5cf6);
		font-variant-numeric: tabular-nums;
	}
	/* "est" is small but always present on a blended figure — the reader should
	   never have to hover to learn the number is an estimate. */
	.token-est {
		margin-left: 3px; font-size: 0.6rem; font-weight: 600;
		text-transform: uppercase; opacity: 0.7;
	}
	.token-unpriced { color: var(--accent-amber, #f59e0b); }
	.te-cost {
		min-width: 54px; text-align: right; color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}
	.token-models { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 0; }
	.token-model-chip {
		padding: 2px 8px; border-radius: var(--radius-full);
		background: var(--glass-hover); color: var(--text-secondary);
		font-size: 0.7rem; font-variant-numeric: tabular-nums;
	}
	.token-entries { list-style: none; margin: 8px 0 0; padding: 0; }
	.token-entry {
		display: flex; align-items: baseline; gap: var(--space-sm);
		padding: 5px 10px; font-size: 0.74rem;
		border-top: 1px solid var(--glass-border);
	}
	.te-amount {
		min-width: 62px; font-weight: 600; font-variant-numeric: tabular-nums;
		color: var(--text-primary);
	}
	/* A correction reads as a correction, not as more spend. */
	.token-entry.negative .te-amount { color: var(--accent-amber, #f59e0b); }
	.te-what { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 6px; }
	.te-scope { color: var(--text-secondary); font-weight: 600; }
	.te-note { color: var(--text-tertiary); }
	.te-plain { font-style: italic; }
	.te-model { color: var(--text-tertiary); font-size: 0.7rem; white-space: nowrap; }
</style>
