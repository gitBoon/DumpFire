<!--
  CardCoverPicker.svelte — A saved card's cover, in the card window's More
  options: none, one of the presets, or a colour of its own (card 2280,
  slice B4: moved from CardModal.svelte).

  The cover is the window's, bound here, since its strip is drawn across
  the top of the window too. A change is shown at once and sent from here,
  its answer read: refused or unanswered, it is put back as it was and said
  in the window's message box (`windowError`, bound).
-->
<script lang="ts">
	import { COVER_PRESETS, coverPickerColour, isCoverValue } from '$lib/colours';
	import { failureMessage } from '$lib/api';
	import type { CardType } from '$lib/types';

	let {
		card,
		boardId,
		coverUrl = $bindable(),
		windowError = $bindable()
	}: {
		card: CardType | null;
		boardId: number;
		coverUrl: string;
		windowError: string;
	} = $props();

	/** What a change that got no answer says: it may or may not have been made. */
	const NO_ANSWER = 'No answer from the server. It is not known whether that was saved.';

	/** Shown at once, and put back as it was if the server does not save it. */
	async function setCover(value: string) {
		const was = coverUrl;
		coverUrl = value;
		if (!card) return;
		windowError = '';
		let res: Response;
		try {
			res = await fetch(`/api/cards/${card.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ coverUrl: value || null, boardId })
			});
		} catch {
			coverUrl = was;
			windowError = NO_ANSWER;
			return;
		}
		if (!res.ok) {
			coverUrl = was;
			windowError = await failureMessage(res, 'The cover was not changed.');
		}
	}

	/** No cover: sent as null, which is what an empty one is. */
	async function clearCover() {
		await setCover('');
	}
</script>

<div class="form-group">
	<label>Cover</label>
	<div class="cover-picker">
		<button class="cover-swatch cover-swatch-none" class:active={!coverUrl} onclick={clearCover} title="No cover" type="button"></button>
		{#each COVER_PRESETS as preset}
			<button class="cover-swatch" class:active={coverUrl === preset} style="background: {preset}" onclick={() => setCover(preset)} title="Set cover" type="button"></button>
		{/each}
		<label class="color-custom-wrapper">
			<input type="color" value={coverPickerColour(coverUrl)} onchange={(e) => setCover((e.target as HTMLInputElement).value)} class="color-native-input" />
			{#if isCoverValue(coverUrl)}
				<span class="cover-swatch custom" style="background: {coverUrl}">✎</span>
			{:else}
				<span class="cover-swatch custom" style="background: var(--bg-elevated)">✎</span>
			{/if}
		</label>
	</div>
</div>

<style>
	/* The window's own field style, on the colour box here (CardModal.svelte's `.card-modal-content input`). */
	:global(.card-modal-content) input {
		background: var(--bg-base); border: 1px solid var(--glass-border);
	}
	:global(.card-modal-content) input:focus {
		border-color: var(--accent-indigo); box-shadow: 0 0 0 2px var(--accent-purple-glow);
	}

	.form-group { margin-bottom: var(--space-lg); }
	.form-group label {
		display: flex; align-items: center; gap: var(--space-sm);
		font-size: 0.7rem; font-weight: 600; color: var(--text-secondary);
		text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm);
	}

	/* ─── Cover ──────────────────────────────────────────── */
	.cover-picker {
		display: flex; flex-wrap: wrap; gap: 4px;
	}
	.cover-swatch {
		width: 24px; height: 24px; border-radius: 6px; border: 2px solid transparent;
		cursor: pointer; transition: all 0.15s; flex-shrink: 0;
	}
	.cover-swatch:hover { transform: scale(1.15); }
	.cover-swatch.active { border-color: var(--text-primary); box-shadow: 0 0 0 1px var(--bg-card); }

	/* Cover swatches */
	.cover-picker { display: flex; gap: 6px; flex-wrap: wrap; }
	.cover-swatch {
		width: 26px; height: 26px; border-radius: var(--radius-sm);
		border: 2px solid transparent; cursor: pointer;
		transition: all 0.15s; display: flex; align-items: center; justify-content: center;
	}
	.cover-swatch:hover { transform: scale(1.15); }
	.cover-swatch.active { border-color: var(--text-primary); }
	.cover-swatch-none {
		background: var(--bg-elevated); position: relative;
	}
	.cover-swatch-none::after {
		content: ''; position: absolute; inset: 4px;
		border: 1.5px dashed var(--text-tertiary); border-radius: 3px;
	}
	.cover-swatch.custom {
		font-size: 0.6rem; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5);
	}

	/* Custom color picker (shared pattern) */
	.color-custom-wrapper { position: relative; cursor: pointer; display: inline-flex; }
	.color-native-input { position: absolute; width: 0; height: 0; opacity: 0; pointer-events: none; }
</style>
