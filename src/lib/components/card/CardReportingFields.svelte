<!--
  CardReportingFields.svelte — The card window's Reporting section: the five
  facts a management report needs that the technical card text cannot supply
  (card 2280, slice B4: moved from CardModal.svelte).

  It holds no state of its own. The five fields are the window's, bound
  here: the window fills them from its card once and sends them with a
  save. Whether the section is open is the window's too (it opens on a card
  with anything recorded), so it stays as it was while another tab of the
  window is shown.
-->
<script lang="ts">
	import {
		THEMES,
		RELEASE_STATES,
		CLOSE_REASONS,
		CUSTOMER_IMPACTS,
		SUMMARY_MAX,
		FIELD_HINTS
	} from '$lib/reporting';

	let {
		summary = $bindable(),
		theme = $bindable(),
		customerImpact = $bindable(),
		closeReason = $bindable(),
		releaseState = $bindable(),
		showReporting = $bindable()
	}: {
		summary: string;
		theme: string;
		customerImpact: string;
		closeReason: string;
		releaseState: string;
		showReporting: boolean;
	} = $props();

	/** How much is filled in, shown on the collapsed header so it is not forgotten. */
	let reportingFilledCount = $derived(
		[summary, theme, customerImpact, closeReason, releaseState].filter((v) => !!v && v.trim() !== '')
			.length
	);
</script>

<div class="form-group reporting-group">
	<button type="button" class="reporting-toggle" onclick={() => (showReporting = !showReporting)}>
		<span class="reporting-caret" class:open={showReporting}>▸</span>
		Reporting
		{#if !showReporting && reportingFilledCount > 0}
			<span class="reporting-count">{reportingFilledCount} of 5 recorded</span>
		{/if}
	</button>

	{#if showReporting}
		<div class="reporting-fields">
			<div class="reporting-row">
				<label for="card-summary">Summary</label>
				<input
					id="card-summary"
					type="text"
					maxlength={SUMMARY_MAX}
					placeholder="Plain English, about 12 words"
					bind:value={summary}
				/>
				<small>{FIELD_HINTS.summary}</small>
			</div>

			<div class="reporting-grid">
				<div class="reporting-row">
					<label for="card-theme">Theme</label>
					<select id="card-theme" bind:value={theme}>
						<option value="">Not recorded</option>
						{#each THEMES as t}<option value={t}>{t}</option>{/each}
					</select>
				</div>

				<div class="reporting-row">
					<label for="card-release">Release state</label>
					<select id="card-release" bind:value={releaseState}>
						<option value="">Not recorded</option>
						{#each RELEASE_STATES as r}<option value={r}>{r}</option>{/each}
					</select>
				</div>

				<div class="reporting-row">
					<label for="card-close">Close reason</label>
					<select id="card-close" bind:value={closeReason}>
						<option value="">Not recorded</option>
						{#each CLOSE_REASONS as r}<option value={r}>{r}</option>{/each}
					</select>
				</div>

				<div class="reporting-row">
					<label for="card-impact">Customer impact</label>
					<input
						id="card-impact"
						type="text"
						list="customer-impact-options"
						placeholder="none / internal / live customers: Who"
						bind:value={customerImpact}
					/>
					<datalist id="customer-impact-options">
						{#each CUSTOMER_IMPACTS as c}<option value={c}></option>{/each}
					</datalist>
				</div>
			</div>
			<small class="reporting-note">{FIELD_HINTS.closeReason}</small>
		</div>
	{/if}
</div>

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

	/* Reporting fields — collapsed by default, so writing a card is unchanged. */
	.reporting-group { border-top: 1px solid var(--border-subtle, rgba(128,128,128,0.18)); padding-top: var(--space-md); }
	.reporting-toggle {
		display: flex; align-items: center; gap: var(--space-sm);
		background: none; border: none; padding: 0; cursor: pointer;
		font-size: 0.7rem; font-weight: 600; color: var(--text-secondary);
		text-transform: uppercase; letter-spacing: 0.05em;
	}
	.reporting-toggle:hover { color: var(--text-primary); }
	.reporting-caret { display: inline-block; transition: transform 0.15s ease; }
	.reporting-caret.open { transform: rotate(90deg); }
	.reporting-count {
		text-transform: none; letter-spacing: 0; font-weight: 500;
		font-size: 0.68rem; color: var(--text-tertiary, var(--text-secondary)); opacity: 0.8;
	}
	.reporting-fields { margin-top: var(--space-md); display: flex; flex-direction: column; gap: var(--space-md); }
	.reporting-grid {
		display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: var(--space-md);
	}
	.reporting-row { display: flex; flex-direction: column; }
	.reporting-row small {
		margin-top: 4px; font-size: 0.68rem; line-height: 1.35;
		color: var(--text-tertiary, var(--text-secondary)); opacity: 0.8;
	}
	.reporting-note {
		font-size: 0.68rem; line-height: 1.35;
		color: var(--text-tertiary, var(--text-secondary)); opacity: 0.8;
	}
</style>
