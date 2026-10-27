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
	import ColourSwatches from '$lib/components/ColourSwatches.svelte';

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

	/** A cover is drawn only when it is one (`isCoverValue`): a gradient as it is, and a value stored before the rule as no cover. */
	function coverDrawn(cover: string): string {
		return isCoverValue(cover) ? cover : 'var(--bg-elevated)';
	}

	/** A cover's name: "Colour #6366f1", or "Gradient #667eea to #764ba2" for one of the gradients. */
	function coverName(cover: string): string {
		const ends = cover.match(/#[0-9a-fA-F]{6}/g) ?? [];
		return ends.length === 2 ? `Gradient ${ends[0]} to ${ends[1]}` : `Colour ${cover}`;
	}
</script>

<div class="form-group">
	<label>Cover</label>
	<!-- The shared picker (card 2546): each pick saved as it is made, the custom colour's as its picker is closed. -->
	<ColourSwatches colours={COVER_PRESETS} value={coverUrl} onpick={setCover} customValue={coverPickerColour(coverUrl)} draw={coverDrawn} nameOf={coverName} size="large" label="Cover">
		{#snippet lead()}
			<button class="cover-swatch cover-swatch-none" class:active={!coverUrl} aria-pressed={!coverUrl} onclick={clearCover} title="No cover" type="button"></button>
		{/snippet}
	</ColourSwatches>
</div>

<style>
	.form-group { margin-bottom: var(--space-lg); }
	.form-group label {
		display: flex; align-items: center; gap: var(--space-sm);
		font-size: 0.7rem; font-weight: 600; color: var(--text-secondary);
		text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm);
	}

	/* ─── Cover: No cover, drawn first in the shared picker's row ─── */
	.cover-swatch {
		width: 24px; height: 24px; border-radius: 6px; border: 2px solid transparent;
		cursor: pointer; transition: all 0.15s; flex-shrink: 0;
	}
	.cover-swatch:hover { transform: scale(1.15); }
	.cover-swatch.active { border-color: var(--text-primary); box-shadow: 0 0 0 1px var(--bg-card); }

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
	.cover-swatch:focus-visible { outline: 2px solid var(--accent-indigo); outline-offset: 2px; }
</style>
