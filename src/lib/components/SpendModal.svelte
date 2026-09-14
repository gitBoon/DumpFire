<!--
  SpendModal.svelte — token spend by person, by period, by model.

  Opens from the dashboard's Notional spend tile. Three things it has to be
  careful about, all stated on screen rather than buried:

  - The money is what the API *would* charge. On a fixed-price plan nobody is
    billed it; the figure exists so work can be compared in metered terms.
  - The ledger records who *reported* each entry — the owner of the key or
    session that made the call. Usually the right attribution, but it is not the
    same claim as "who typed it".
  - Periods are calendar windows, not rolling ones, because a fixed-price plan
    renews on a calendar month.
-->
<script lang="ts">
	import { formatTokens } from '$lib/tokens';
	import { formatUsd, BLEND_NOTE, SOURCE_NOTE, NOT_BILLED_NOTE } from '$lib/pricing';

	interface ModelRow {
		model: string;
		tokens: number;
		costUsd: number | null;
	}
	interface Row {
		userId: number | null;
		username: string;
		emoji: string;
		tokens: number;
		costUsd: number | null;
		entries: number;
		byModel: ModelRow[];
	}
	type Period = 'today' | 'week' | 'month' | 'year' | 'all';

	let {
		spend,
		onclose
	}: { spend: Record<Period, Row[]>; onclose: () => void } = $props();

	const PERIODS: { key: Period; label: string; hint: string }[] = [
		{ key: 'today', label: 'Today', hint: 'since midnight' },
		{ key: 'week', label: 'This week', hint: 'since Monday' },
		{ key: 'month', label: 'This month', hint: 'since the 1st' },
		{ key: 'year', label: 'This year', hint: 'since 1 January' },
		{ key: 'all', label: 'All time', hint: 'everything recorded' }
	];

	// Month is the useful default on a monthly plan — it is the window the
	// fixed price actually covers.
	let period = $state<Period>('month');
	let expanded = $state<Set<string>>(new Set());

	const rows = $derived(spend[period] ?? []);
	const totalTokens = $derived(rows.reduce((s, r) => s + r.tokens, 0));
	const totalCost = $derived(
		rows.some((r) => r.costUsd !== null) ? rows.reduce((s, r) => s + (r.costUsd ?? 0), 0) : null
	);
	const maxTokens = $derived(Math.max(1, ...rows.map((r) => r.tokens)));

	function toggle(key: string) {
		const next = new Set(expanded);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		expanded = next;
	}

	/** Trim the vendor prefix so the column stays readable. */
	function shortModel(m: string): string {
		return m === 'unspecified' ? 'no model recorded' : m.replace(/^claude-/, '');
	}
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

		<div class="periods">
			{#each PERIODS as p}
				<button
					class="period"
					class:on={period === p.key}
					title={p.hint}
					onclick={() => (period = p.key)}
				>{p.label}</button>
			{/each}
		</div>

		{#if rows.length === 0}
			<p class="empty">
				Nothing recorded {period === 'all' ? 'yet' : `in this period`}.
				{#if period !== 'all'}Try a wider window.{/if}
			</p>
		{:else}
			<div class="totals">
				<span class="totals-money">{formatUsd(totalCost)}</span>
				<span class="totals-tokens">
					{formatTokens(totalTokens)} tokens · {rows.length} {rows.length === 1 ? 'person' : 'people'}
				</span>
			</div>

			<ul class="rows">
				{#each rows as r (r.userId ?? 'none')}
					{@const key = String(r.userId ?? 'none')}
					{@const isOpen = expanded.has(key)}
					{@const share = Math.round((r.tokens / totalTokens) * 100)}
					<li class="row-group">
						<button class="row" onclick={() => toggle(key)} aria-expanded={isOpen}>
							<span class="chev" class:open={isOpen}>▸</span>
							<span class="avatar">{r.emoji}</span>
							<div class="who">
								<span class="name">{r.username}</span>
								<span class="meta">
									{r.entries} {r.entries === 1 ? 'entry' : 'entries'} · {share}% ·
									{r.byModel.length} {r.byModel.length === 1 ? 'model' : 'models'}
								</span>
							</div>
							<div class="bar-wrap">
								<div class="bar" style="width: {(r.tokens / maxTokens) * 100}%"></div>
							</div>
							<span class="tokens">{formatTokens(r.tokens)}</span>
							<span class="money">{formatUsd(r.costUsd)}</span>
						</button>

						{#if isOpen}
							<ul class="models">
								{#each r.byModel as m}
									<li class="model-row" class:unpriced={m.costUsd === null}>
										<span class="model-name">{shortModel(m.model)}</span>
										<div class="bar-wrap thin">
											<div class="bar model-bar" style="width: {(m.tokens / r.tokens) * 100}%"></div>
										</div>
										<span class="tokens">{formatTokens(m.tokens)}</span>
										<span class="money">
											{#if m.costUsd === null}
												<span class="unpriced-tag" title="No model recorded, so this cannot be priced.">unpriced</span>
											{:else}{formatUsd(m.costUsd)}{/if}
										</span>
									</li>
								{/each}
							</ul>
						{/if}
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
		width: 100%; max-width: 600px; max-height: 82vh; overflow-y: auto;
		border: 1px solid var(--glass-border); border-radius: var(--radius-lg);
		background: var(--bg-card); padding: var(--space-lg);
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
	}
	.modal-head { display: flex; align-items: flex-start; gap: var(--space-md); margin-bottom: var(--space-md); }
	.modal-head h2 { margin: 0; font-size: 1.05rem; font-weight: 700; color: var(--text-primary); }
	.sub { margin: 4px 0 0; font-size: 0.74rem; color: var(--text-secondary); max-width: 44ch; }
	.close {
		margin-left: auto; border: none; background: transparent; cursor: pointer;
		color: var(--text-tertiary); font-size: 0.9rem; padding: 4px 8px; border-radius: var(--radius-md);
	}
	.close:hover { background: var(--glass-hover); color: var(--text-primary); }

	.periods { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: var(--space-md); }
	.period {
		padding: 4px 11px; border-radius: var(--radius-full);
		border: 1px solid var(--glass-border); background: var(--bg-surface);
		color: var(--text-secondary); font-family: var(--font-family);
		font-size: 0.72rem; font-weight: 600; cursor: pointer;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.period:hover { color: var(--text-primary); border-color: var(--text-tertiary); }
	.period.on {
		background: var(--accent-violet, #8b5cf6); border-color: var(--accent-violet, #8b5cf6);
		color: #fff;
	}

	.totals {
		display: flex; align-items: baseline; gap: var(--space-sm);
		padding: var(--space-sm) 0 var(--space-md); border-bottom: 1px solid var(--glass-border);
	}
	.totals-money { font-size: 1.6rem; font-weight: 700; color: var(--accent-violet, #8b5cf6); font-variant-numeric: tabular-nums; }
	.totals-tokens { font-size: 0.78rem; color: var(--text-secondary); }

	.rows { list-style: none; margin: 0; padding: 0; }
	.row-group { border-bottom: 1px solid var(--glass-border); }
	.row {
		display: flex; align-items: center; gap: var(--space-sm);
		width: 100%; padding: 9px 0; border: none; background: transparent;
		font-family: var(--font-family); text-align: left; cursor: pointer;
	}
	.row:hover { background: var(--glass-hover); }
	.chev {
		font-size: 0.6rem; color: var(--text-tertiary); flex-shrink: 0; width: 10px;
		transition: transform var(--duration-fast) var(--ease-out);
	}
	.chev.open { transform: rotate(90deg); }
	.avatar { font-size: 1rem; flex-shrink: 0; }
	.who { min-width: 150px; display: flex; flex-direction: column; gap: 1px; }
	.name { font-size: 0.82rem; font-weight: 600; color: var(--text-primary); }
	.meta { font-size: 0.68rem; color: var(--text-tertiary); }
	.bar-wrap { flex: 1; min-width: 30px; height: 6px; border-radius: var(--radius-full); background: var(--glass-hover); overflow: hidden; }
	.bar-wrap.thin { height: 4px; }
	.bar { height: 100%; border-radius: var(--radius-full); background: var(--accent-violet, #8b5cf6); }
	/* Per-model bars sit quieter so the person's row stays the primary read. */
	.model-bar { background: var(--accent-violet, #8b5cf6); opacity: 0.45; }
	.tokens { min-width: 56px; text-align: right; font-size: 0.75rem; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
	.money { min-width: 64px; text-align: right; font-size: 0.82rem; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }

	.models { list-style: none; margin: 0 0 8px; padding: 0 0 0 26px; }
	.model-row { display: flex; align-items: center; gap: var(--space-sm); padding: 4px 0; }
	.model-name { min-width: 150px; font-size: 0.72rem; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
	.model-row .money { font-size: 0.74rem; font-weight: 600; color: var(--text-secondary); }
	.unpriced-tag { color: var(--accent-amber, #f59e0b); font-weight: 600; font-size: 0.68rem; }

	.empty { font-size: 0.8rem; color: var(--text-secondary); margin: var(--space-md) 0; }
	.foot { margin: var(--space-md) 0 0; font-size: 0.68rem; color: var(--text-tertiary); line-height: 1.5; }
</style>
