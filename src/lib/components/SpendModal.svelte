<!--
  SpendModal.svelte — token spend broken down by person.

  Opens from the dashboard's Notional spend tile. Two things it has to be
  careful about, both stated on screen rather than buried:

  - The money is what the API *would* charge. On a fixed-price plan nobody is
    billed it; the figure exists so work can be compared in metered terms.
  - The ledger records who *reported* each entry — the owner of the key or
    session that made the call. That is usually the right attribution, but it
    is not the same claim as "who typed it", so the modal says so.
-->
<script lang="ts">
	import { formatTokens } from '$lib/tokens';
	import { formatUsd, BLEND_NOTE, SOURCE_NOTE, NOT_BILLED_NOTE } from '$lib/pricing';

	interface Row {
		userId: number | null;
		username: string;
		emoji: string;
		tokens: number;
		costUsd: number | null;
		entries: number;
	}

	let { rows, onclose }: { rows: Row[]; onclose: () => void } = $props();

	const totalTokens = $derived(rows.reduce((s, r) => s + r.tokens, 0));
	const totalCost = $derived(
		rows.some((r) => r.costUsd !== null)
			? rows.reduce((s, r) => s + (r.costUsd ?? 0), 0)
			: null
	);
	/** Share of the bar, guarded so a single-person board still fills it. */
	const maxTokens = $derived(Math.max(1, ...rows.map((r) => r.tokens)));
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" onclick={onclose}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal glass" onclick={(e) => e.stopPropagation()}>
		<div class="modal-head">
			<div>
				<h2>Notional spend by person</h2>
				<p class="sub">{NOT_BILLED_NOTE}.</p>
			</div>
			<button class="close" onclick={onclose} aria-label="Close">✕</button>
		</div>

		{#if rows.length === 0}
			<p class="empty">Nothing recorded yet. Spend appears here once token usage is reported against a card.</p>
		{:else}
			<div class="totals">
				<span class="totals-money">{formatUsd(totalCost)}</span>
				<span class="totals-tokens">{formatTokens(totalTokens)} tokens · {rows.length} {rows.length === 1 ? 'person' : 'people'}</span>
			</div>

			<ul class="rows">
				{#each rows as r (r.userId ?? 'none')}
					{@const share = Math.round((r.tokens / totalTokens) * 100)}
					<li class="row">
						<span class="avatar">{r.emoji}</span>
						<div class="who">
							<span class="name">{r.username}</span>
							<span class="meta">{r.entries} {r.entries === 1 ? 'entry' : 'entries'} · {share}%</span>
						</div>
						<div class="bar-wrap">
							<div class="bar" style="width: {(r.tokens / maxTokens) * 100}%"></div>
						</div>
						<span class="tokens">{formatTokens(r.tokens)}</span>
						<span class="money">{formatUsd(r.costUsd)}</span>
					</li>
				{/each}
			</ul>

			<p class="foot">
				Attributed to whoever <strong>reported</strong> each entry — the owner of the key or
				session that made the call, which is not always who did the typing.
				<br />{SOURCE_NOTE} — {BLEND_NOTE}.
			</p>
		{/if}
	</div>
</div>

<style>
	.modal-backdrop {
		position: fixed; inset: 0; z-index: 1000;
		display: flex; align-items: center; justify-content: center;
		background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(3px);
		padding: var(--space-lg);
	}
	.modal {
		width: 100%; max-width: 560px; max-height: 80vh; overflow-y: auto;
		border: 1px solid var(--glass-border); border-radius: var(--radius-lg);
		background: var(--bg-card); padding: var(--space-lg);
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
	}
	.modal-head { display: flex; align-items: flex-start; gap: var(--space-md); margin-bottom: var(--space-md); }
	.modal-head h2 { margin: 0; font-size: 1.05rem; font-weight: 700; color: var(--text-primary); }
	.sub { margin: 4px 0 0; font-size: 0.74rem; color: var(--text-secondary); max-width: 42ch; }
	.close {
		margin-left: auto; border: none; background: transparent; cursor: pointer;
		color: var(--text-tertiary); font-size: 0.9rem; padding: 4px 8px; border-radius: var(--radius-md);
	}
	.close:hover { background: var(--glass-hover); color: var(--text-primary); }

	.totals {
		display: flex; align-items: baseline; gap: var(--space-sm);
		padding: var(--space-sm) 0 var(--space-md); border-bottom: 1px solid var(--glass-border);
	}
	.totals-money { font-size: 1.6rem; font-weight: 700; color: var(--accent-violet, #8b5cf6); font-variant-numeric: tabular-nums; }
	.totals-tokens { font-size: 0.78rem; color: var(--text-secondary); }

	.rows { list-style: none; margin: 0; padding: 0; }
	.row {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: 9px 0; border-bottom: 1px solid var(--glass-border);
	}
	.avatar { font-size: 1rem; flex-shrink: 0; }
	.who { min-width: 130px; display: flex; flex-direction: column; gap: 1px; }
	.name { font-size: 0.82rem; font-weight: 600; color: var(--text-primary); }
	.meta { font-size: 0.68rem; color: var(--text-tertiary); }
	.bar-wrap { flex: 1; min-width: 40px; height: 6px; border-radius: var(--radius-full); background: var(--glass-hover); overflow: hidden; }
	.bar { height: 100%; border-radius: var(--radius-full); background: var(--accent-violet, #8b5cf6); }
	.tokens { min-width: 56px; text-align: right; font-size: 0.75rem; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
	.money { min-width: 62px; text-align: right; font-size: 0.82rem; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }

	.empty { font-size: 0.8rem; color: var(--text-secondary); margin: var(--space-md) 0; }
	.foot { margin: var(--space-md) 0 0; font-size: 0.68rem; color: var(--text-tertiary); line-height: 1.5; }
</style>
