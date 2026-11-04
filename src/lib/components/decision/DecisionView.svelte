<!--
  A decision as its participant reads it (card 2677, decision 21, plan 4.2),
  for both of its pages and for card 2697's preview. Mobile first: one column,
  the options side by side only where there is room (decision 22).

  In design 4.7's order: the title and status, the `banner` snippet, the
  situation, the question, what is asked and by when, who sees a response
  (consulted only), the options, how it affects you (the participant's own
  group first and open), the user stories (closed), what is not yet known,
  what is already settled, the technical detail (closed), the `response`
  snippet (consulted only), the `results` and `concern` snippets (card 2679,
  decision 24: the released results and a participant's concern about the
  ruling, each drawn only when given), the `questions` snippet (card 2678: the
  questions and answers, and the form to ask one, under the `questions` id the
  mails link to, drawn only when given) and the `linkedCards` snippet (card
  2680: the signed-in page's `LinkedCards`, drawn only when given). Who sees a response
  is `whoSeesStatement`'s words, beside the version `ResponseForm` sends (card
  2679, decisions 21 and 25). What an agent drafted and no person has
  reviewed carries `AgentLabel` (card 2712).

  Its props are `DecisionViewProps` (src/lib/decision-view-types.ts): no
  version number, publication or inclusion moment, so that a preview builds
  them from the working content. The pages draw the banner and the form, which
  need those, in their snippets, through the components they share
  (`ParticipantBanner` and `ParticipantResponse`, card 2707). It fetches
  nothing and posts nothing.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { DecisionViewProps } from '$lib/decision-view-types';
	import { STATUS_WORDS, shownMoment, whoSeesStatement } from '$lib/decision-words';
	import AgentLabel from './AgentLabel.svelte';
	import MarkdownBlock from './MarkdownBlock.svelte';

	let {
		decision,
		content,
		options,
		audiences,
		participant,
		mode,
		banner,
		response,
		results,
		concern,
		questions,
		linkedCards
	}: DecisionViewProps & { banner?: Snippet; response?: Snippet; results?: Snippet; concern?: Snippet; questions?: Snippet; linkedCards?: Snippet } = $props();

	/** Whether the version flags this section as drafted by an agent and not yet reviewed. */
	const flagged = (key: string) => Object.hasOwn(content.agentDrafted, key);
	const consulted = $derived(participant?.role === 'consulted');
	const decider = $derived(decision.deciderName ?? 'the decider');
</script>

{#snippet agentLabel(key: string)}
	{#if flagged(key)}
		<AgentLabel tag="p" data-flag={key} />
	{/if}
{/snippet}

<article class="decision-view" data-mode={mode}>
	<header class="view-head">
		<h1>{decision.title}</h1>
		<span class="status-chip" data-status={decision.shownStatus}>{STATUS_WORDS[decision.shownStatus] ?? decision.shownStatus}</span>
	</header>

	{#if banner}
		<div class="view-banner" data-section="banner">{@render banner()}</div>
	{/if}

	{#if content.situation !== ''}
		<section data-section="situation">
			<h2>Situation</h2>
			{@render agentLabel('situation')}
			<MarkdownBlock text={content.situation} />
		</section>
	{/if}

	<section data-section="question">
		<h2>The question</h2>
		{@render agentLabel('question')}
		<p class="question">{content.question}</p>
	</section>

	<section data-section="ask">
		<h2>What is asked of you, and by when</h2>
		{@render agentLabel('ask')}
		{#if content.ask !== ''}<MarkdownBlock text={content.ask} />{/if}
		{#if decision.closesAt !== null}<p class="by-when">By {shownMoment(decision.closesAt, '')}.</p>{/if}
	</section>

	{#if consulted}
		<section data-section="who-sees">
			<h2>Who sees your response</h2>
			<!-- The words and their version are one bundle's, so the version a response sends is the one shown (card 2679, decisions 21 and 25). -->
			<p>{whoSeesStatement(decider)}</p>
		</section>
	{/if}

	{#if options.length > 0}
		<section data-section="options">
			<h2>The options</h2>
			<div class="option-grid">
				{#each options as option (option.optionId)}
					<div class="option-card" data-option={option.optionId}>
						<p class="option-label">Option {option.label}</p>
						{#if option.agentDrafted}<AgentLabel tag="p" data-flag="options.{option.optionId}" />{/if}
						<h3>{option.title}</h3>
						{#if option.summary !== ''}<MarkdownBlock text={option.summary} />{/if}
						{#if option.pros.length > 0}
							<h4>For</h4>
							<ul class="pros">{#each option.pros as pro, i (i)}<li>{pro}</li>{/each}</ul>
						{/if}
						{#if option.cons.length > 0}
							<h4>Against</h4>
							<ul class="cons">{#each option.cons as con, i (i)}<li>{con}</li>{/each}</ul>
						{/if}
						{#if option.commercial !== ''}
							<h4>Cost and commercial</h4>
							<MarkdownBlock text={option.commercial} />
						{/if}
					</div>
				{/each}
			</div>
		</section>
	{/if}

	{#if audiences.length > 0}
		<section data-section="audiences">
			<h2>How it affects you</h2>
			{@render agentLabel('audiences')}
			{#each audiences as audience, i (i)}
				<details class="audience" open={audience.open} data-own={audience.own ? 'yes' : 'no'}>
					<summary>{audience.heading}</summary>
					<MarkdownBlock text={audience.body} />
				</details>
			{/each}
		</section>
	{/if}

	{#if content.stories.length > 0}
		<section data-section="stories">
			<details>
				<summary><h2>User stories</h2></summary>
				{@render agentLabel('stories')}
				{#each content.stories as story, i (i)}
					<h3>{story.title}</h3>
					<MarkdownBlock text={story.body} />
				{/each}
			</details>
		</section>
	{/if}

	{#if content.unknowns !== ''}
		<section data-section="unknowns">
			<h2>What is not yet known</h2>
			{@render agentLabel('unknowns')}
			<MarkdownBlock text={content.unknowns} />
		</section>
	{/if}

	{#if content.alreadyRuled !== ''}
		<section data-section="already-ruled">
			<h2>Already settled</h2>
			{@render agentLabel('alreadyRuled')}
			<MarkdownBlock text={content.alreadyRuled} />
		</section>
	{/if}

	{#if content.technicalDetail !== ''}
		<section data-section="technical-detail">
			<details>
				<summary><h2>Technical detail</h2></summary>
				{@render agentLabel('technicalDetail')}
				<MarkdownBlock text={content.technicalDetail} />
			</details>
		</section>
	{/if}

	{#if consulted && response}
		<section data-section="response">
			<h2>Your response</h2>
			{@render response()}
		</section>
	{/if}

	{#if results}
		<section data-section="results">
			<h2>The results</h2>
			{@render results()}
		</section>
	{/if}

	{#if concern}
		<section data-section="concern">
			<h2>A concern about the ruling</h2>
			{@render concern()}
		</section>
	{/if}

	{#if questions}
		<!-- `questions` is the id the question mails link to (card 2678, decision 5); the heading takes the focus after a question is sent (decision 21). -->
		<section data-section="questions" id="questions" aria-labelledby="questions-heading">
			<h2 id="questions-heading" tabindex="-1">Questions and answers</h2>
			{@render questions()}
		</section>
	{/if}

	{#if linkedCards}
		<section data-section="linked-cards" aria-labelledby="linked-cards-heading">
			<h2 id="linked-cards-heading">Linked cards</h2>
			{@render linkedCards()}
		</section>
	{/if}
</article>

<style>
	.decision-view { max-width: 46rem; margin: 0 auto; font-size: 1rem; display: flex; flex-direction: column; gap: var(--space-lg); }
	.view-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm) var(--space-md); }
	.view-head h1 { font-size: 1.4rem; line-height: 1.3; margin: 0; flex: 1 1 16rem; overflow-wrap: anywhere; }
	.status-chip {
		display: inline-block; padding: 2px var(--space-sm); border-radius: 999px;
		font-size: 0.8rem; background: rgba(99, 102, 241, 0.12); color: var(--accent-indigo);
	}
	section h2 { font-size: 1.05rem; margin: 0 0 var(--space-sm); }
	section h3 { font-size: 1rem; margin: var(--space-sm) 0 var(--space-xs); }
	section h4 { font-size: 0.85rem; margin: var(--space-sm) 0 var(--space-xs); color: var(--text-secondary); }
	.question { font-size: 1.1rem; font-weight: 600; margin: 0; overflow-wrap: anywhere; }
	.by-when { font-weight: 600; margin: var(--space-sm) 0 0; }
	/* Side by side where there is room, stacked on a phone (decision 22). */
	.option-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: var(--space-md); }
	.option-card { padding: var(--space-md); border: 1px solid var(--glass-border); border-radius: var(--radius-md); background: var(--bg-elevated); min-width: 0; }
	.option-label { margin: 0; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent-indigo); }
	.option-card ul { margin: 0; padding-left: 1.2rem; }
	details > summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; }
	details > summary h2 { margin: 0; }
	.audience { border-bottom: 1px solid var(--glass-border); }
	.audience > summary { font-weight: 600; }
</style>
