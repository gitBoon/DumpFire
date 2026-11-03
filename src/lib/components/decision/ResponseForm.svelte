<!--
  A consulted participant's response (card 2677, decisions 11, 21 and 22).

  The choices are large radio cards: in single mode one per option, then "I
  abstain" and "I have no concerns"; in score mode a row of six buttons, 0 to
  5, for each option, a radio group named by its option, with the same two
  choices beside them. Send is offered once the choice is whole: a score for
  every option, in score mode. A comment, and a comment on any option, below;
  each is shown back as text, never as markdown.

  Send posts `{ ...extra, versionNumber, kind, optionId | scores, comment,
  optionComments }` as JSON to `url`: the signed-in page's route, or the
  personal link's with the token in `extra`, so that no address holds it. The
  answer is the response as recorded, which the form shows. A refusal is said
  in the server's words and what was typed is kept; the 409 in
  `STALE_REVISION`'s words alone offers Reload.

  A recorded response given on an older version than `versionNumber` is
  labelled with its version (code review C1): sending it again binds it to
  this one.

  `disabled` draws the form and sends nothing, for card 2697's preview, which
  has no version and nowhere to send: `versionNumber` and `url` are then not
  needed (code review C9).
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { failureMessage } from '$lib/api';
	import type { OwnResponse, ViewOption } from '$lib/decision-view-types';
	import { STALE_REVISION, givenOnWords, responseLines, shownMoment } from '$lib/decision-words';

	type Kind = OwnResponse['kind'];
	type Common = {
		voteMode: 'single' | 'score';
		options: ViewOption[];
		/** Sent with the response, beside it: the personal link's token. */
		extra?: Record<string, unknown>;
		/** The participant's latest response in this round, which the form starts from. */
		initial?: OwnResponse | null;
		/** Reads the page again, after a 409 in STALE_REVISION's words. */
		onReload?: () => void;
	};
	type Props = Common &
		(
			| {
					/** The version the response is for: the one shown. */
					versionNumber: number;
					/** Where Send posts. */
					url: string;
					disabled?: false;
			  }
			| {
					versionNumber?: number;
					url?: string;
					/** Drawn, and never sent (D4). */
					disabled: true;
			  }
		);
	let { voteMode, options, versionNumber, url, extra = {}, disabled = false, initial = null, onReload = () => location.reload() }: Props = $props();

	const start = untrack(() => initial);
	let kind = $state<Kind | null>(start?.kind ?? null);
	let optionId = $state<number | null>(start?.optionId ?? null);
	let scores = $state<Record<string, number>>({ ...(start?.scores ?? {}) });
	let comment = $state(start?.comment ?? '');
	let optionComments = $state<Record<string, string>>({ ...(start?.optionComments ?? {}) });

	let recorded = $state<OwnResponse | null>(start);
	let sending = $state(false);
	let error = $state('');
	let stale = $state(false);

	/** Whether the choice is whole: one option, a score for every option, or a choice that needs neither. */
	const ready = $derived(
		kind === null ? false : kind !== 'vote' ? true : voteMode === 'single' ? optionId !== null : options.every((option) => scores[String(option.optionId)] !== undefined)
	);

	function choose(next: Kind, option: number | null = null) {
		kind = next;
		optionId = option;
	}

	function score(option: number, value: number) {
		scores = { ...scores, [String(option)]: value };
		kind = 'vote';
	}

	async function send() {
		if (disabled || url === undefined || versionNumber === undefined || sending || !ready || kind === null) return;
		const body: Record<string, unknown> = { ...extra, versionNumber, kind };
		if (kind === 'vote' && voteMode === 'single') body.optionId = optionId;
		if (kind === 'vote' && voteMode === 'score') body.scores = Object.fromEntries(options.map((option) => [String(option.optionId), scores[String(option.optionId)]]));
		body.comment = comment;
		body.optionComments = Object.fromEntries(
			options.map((option) => [String(option.optionId), optionComments[String(option.optionId)] ?? '']).filter(([, text]) => text.trim() !== '')
		);

		sending = true;
		error = '';
		stale = false;
		try {
			const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
			if (res.ok) {
				const answer = (await res.json()) as { response: OwnResponse; unchanged: boolean };
				recorded = answer.response;
			} else {
				error = await failureMessage(res, 'Your response was not recorded.');
				// Reload throws away what was chosen: offered only on the stale-version words (2676 C6).
				stale = res.status === 409 && error === STALE_REVISION;
			}
		} catch {
			error = 'No answer from the server. It is not known whether your response was recorded.';
		} finally {
			sending = false;
		}
	}

	/** One radio group per form, named the same on the server and in the browser. */
	const uid = $props.id();
	const name = `response-${uid}`;
</script>

<form
	class="response-form"
	data-disabled={disabled ? 'yes' : 'no'}
	onsubmit={(e) => {
		e.preventDefault();
		send();
	}}
>
	{#if voteMode === 'single'}
		<fieldset class="choices">
			<legend>Your choice</legend>
			{#each options as option (option.optionId)}
				<label class="choice-card" class:chosen={kind === 'vote' && optionId === option.optionId}>
					<input
						type="radio"
						name={name}
						value="option-{option.optionId}"
						checked={kind === 'vote' && optionId === option.optionId}
						{disabled}
						onchange={() => choose('vote', option.optionId)}
					/>
					<span><strong>Option {option.label}</strong>{option.title ? `: ${option.title}` : ''}</span>
				</label>
			{/each}
			{@render otherChoices()}
		</fieldset>
	{:else}
		<fieldset class="choices">
			<legend>Score each option from 0 to 5</legend>
			{#each options as option (option.optionId)}
				<div class="score-row" role="radiogroup" aria-label="Score for option {option.label}">
					<span class="score-name"><strong>Option {option.label}</strong>{option.title ? `: ${option.title}` : ''}</span>
					<div class="score-buttons">
						{#each [0, 1, 2, 3, 4, 5] as value (value)}
							<button
								type="button"
								role="radio"
								class="score"
								aria-checked={kind === 'vote' && scores[String(option.optionId)] === value ? 'true' : 'false'}
								aria-label="{value} for option {option.label}"
								{disabled}
								onclick={() => score(option.optionId, value)}>{value}</button
							>
						{/each}
					</div>
				</div>
			{/each}
			{@render otherChoices()}
		</fieldset>
	{/if}

	<label class="comment">
		<span>Your comment (optional)</span>
		<textarea maxlength="4000" rows="4" bind:value={comment} {disabled}></textarea>
	</label>
	<details class="option-comments">
		<summary>Comment on an option (optional)</summary>
		{#each options as option (option.optionId)}
			<label class="comment">
				<span>Comment on option {option.label}</span>
				<textarea maxlength="2000" rows="3" bind:value={optionComments[String(option.optionId)]} {disabled}></textarea>
			</label>
		{/each}
	</details>

	{#if error}
		<p class="form-error" role="alert">{error}</p>
		{#if stale}<button type="button" class="btn-ghost reload" onclick={() => onReload()}>Reload</button>{/if}
	{/if}

	<button type="submit" class="btn-primary send" disabled={disabled || sending || !ready} aria-busy={sending ? 'true' : undefined}>Send my response</button>

	{#if recorded !== null}
		{@const givenOn = givenOnWords(recorded, versionNumber)}
		<div class="recorded" role="status">
			<p>Your response was recorded on {shownMoment(recorded.createdAt, '')}:</p>
			{#each responseLines(recorded, options) as line, i (i)}<p class="response-line">{line}</p>{/each}
			{#if givenOn !== null}<p class="given-on">{givenOn} Send it again to give it on version {versionNumber}.</p>{/if}
		</div>
	{/if}
</form>

{#snippet otherChoices()}
	<label class="choice-card" class:chosen={kind === 'abstain'}>
		<input type="radio" name={name} value="abstain" checked={kind === 'abstain'} {disabled} onchange={() => choose('abstain')} />
		<span>I abstain</span>
	</label>
	<label class="choice-card" class:chosen={kind === 'no_concerns'}>
		<input type="radio" name={name} value="no_concerns" checked={kind === 'no_concerns'} {disabled} onchange={() => choose('no_concerns')} />
		<span>I have no concerns</span>
	</label>
{/snippet}

<style>
	.response-form { display: flex; flex-direction: column; gap: var(--space-md); font-size: 1rem; }
	.choices { border: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-sm); min-width: 0; }
	.choices legend { font-weight: 600; margin-bottom: var(--space-sm); }
	/* Every tap target 44px tall at least, every input 16px, so a phone does not zoom (decision 22). */
	.choice-card {
		display: flex; align-items: center; gap: var(--space-md); min-height: 44px; padding: var(--space-sm) var(--space-md);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md); background: var(--bg-elevated); cursor: pointer;
	}
	.choice-card.chosen { border-color: var(--accent-indigo); box-shadow: 0 0 0 1px var(--accent-indigo); }
	.choice-card input { width: 1.25rem; height: 1.25rem; flex-shrink: 0; }
	.score-row { display: flex; flex-direction: column; gap: var(--space-xs); padding: var(--space-sm) 0; border-bottom: 1px solid var(--glass-border); }
	.score-buttons { display: grid; grid-template-columns: repeat(6, minmax(44px, 1fr)); gap: var(--space-xs); }
	.score {
		min-height: 44px; font-size: 1rem; font-family: var(--font-family); cursor: pointer;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm); background: var(--bg-elevated); color: var(--text-primary);
	}
	.score[aria-checked='true'] { background: var(--accent-indigo); border-color: var(--accent-indigo); color: white; }
	.comment { display: flex; flex-direction: column; gap: var(--space-xs); }
	.comment span { font-size: 0.9rem; color: var(--text-secondary); }
	textarea {
		font-size: 16px; font-family: var(--font-family); padding: var(--space-sm); width: 100%; box-sizing: border-box;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm); background: var(--bg-elevated); color: var(--text-primary);
	}
	.option-comments > summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; }
	.option-comments .comment { margin-top: var(--space-sm); }
	.send, .reload { min-height: 44px; font-size: 1rem; }
	.form-error { color: var(--accent-rose); margin: 0; }
	.recorded { padding: var(--space-md); border-radius: var(--radius-md); background: rgba(16, 185, 129, 0.1); }
	.recorded p { margin: 0 0 var(--space-xs); }
	.given-on { font-weight: 600; }
	.response-line { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
