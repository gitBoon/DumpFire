<!--
  CardDescription.svelte — The card window's description: written, or shown
  as it will read (card 2280, slice B4: moved from CardModal.svelte).

  It holds no state of its own. The description and whether it is being
  previewed are the window's, bound here: the window fills the description
  from its card once and sends it with a save, and both are kept while
  another tab of the window is shown.
-->
<script lang="ts">
	import { renderMarkdown } from '$lib/markdown';

	let {
		description = $bindable(),
		descPreview = $bindable()
	}: {
		description: string;
		descPreview: boolean;
	} = $props();
</script>

<div class="form-group">
	<div class="desc-header">
		<label for="card-desc">Description</label>
		<div class="desc-tabs">
			<button class="desc-tab" class:active={!descPreview} onclick={() => (descPreview = false)}>Write</button>
			<button class="desc-tab" class:active={descPreview} onclick={() => (descPreview = true)}>Preview</button>
		</div>
	</div>
	{#if descPreview}
		<div class="desc-preview markdown-body">
			{#if description.trim()}
				{@html renderMarkdown(description)}
			{:else}
				<p class="desc-empty">Nothing to preview</p>
			{/if}
		</div>
	{:else}
	<textarea id="card-desc" placeholder="Add a description…" maxlength="50000" bind:value={description} rows="3"></textarea>
	{/if}
	<div class="desc-hint">Supports markdown formatting</div>
</div>

<style>
	/* The window's own field style, on the box here (CardModal.svelte's `.card-modal-content textarea`). */
	:global(.card-modal-content) textarea {
		background: var(--bg-base); border: 1px solid var(--glass-border);
	}
	:global(.card-modal-content) textarea:focus {
		border-color: var(--accent-indigo); box-shadow: 0 0 0 2px var(--accent-purple-glow);
	}

	/* Description hint */
	.desc-hint { font-size: 0.65rem; color: var(--text-tertiary); margin-top: var(--space-xs); padding-left: 2px; }

	.form-group { margin-bottom: var(--space-lg); }
	.form-group label {
		display: flex; align-items: center; gap: var(--space-sm);
		font-size: 0.7rem; font-weight: 600; color: var(--text-secondary);
		text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm);
	}

	/* Description preview */
	.desc-header { display: flex; align-items: center; justify-content: space-between; }
	.desc-tabs { display: flex; gap: 2px; background: var(--glass-bg); border-radius: var(--radius-sm); padding: 2px; }
	.desc-tab {
		padding: 2px 10px; border: none; background: transparent; cursor: pointer;
		font-size: 0.65rem; font-weight: 700; border-radius: var(--radius-sm);
		color: var(--text-tertiary); transition: all 0.15s;
	}
	.desc-tab.active { background: var(--bg-surface); color: var(--text-primary); box-shadow: 0 1px 2px rgba(0,0,0,0.1); }
	.desc-preview {
		min-height: 90px; max-height: 200px; overflow-y: auto;
		padding: var(--space-sm); border-radius: var(--radius-sm);
		border: 1px solid var(--glass-border); background: var(--glass-bg);
		font-size: 0.82rem; line-height: 1.6;
	}
	.desc-preview :global(h1), .desc-preview :global(h2), .desc-preview :global(h3) { margin: 0.5em 0 0.25em; font-weight: 700; }
	.desc-preview :global(h1) { font-size: 1.1em; }
	.desc-preview :global(h2) { font-size: 0.95em; }
	.desc-preview :global(h3) { font-size: 0.85em; }
	.desc-preview :global(p) { margin: 0.3em 0; }
	.desc-preview :global(ul), .desc-preview :global(ol) { padding-left: 1.2em; margin: 0.3em 0; }
	.desc-preview :global(code) { background: var(--glass-bg); padding: 1px 4px; border-radius: 3px; font-size: 0.85em; }
	.desc-preview :global(pre) { background: var(--glass-bg); padding: var(--space-sm); border-radius: var(--radius-sm); overflow-x: auto; }
	.desc-preview :global(blockquote) { border-left: 3px solid var(--accent-indigo); padding-left: var(--space-sm); margin: 0.3em 0; opacity: 0.8; }
	.desc-preview :global(a) { color: var(--accent-indigo); }
	.desc-preview :global(strong) { font-weight: 700; }
	.desc-empty { color: var(--text-tertiary); font-style: italic; }
</style>
