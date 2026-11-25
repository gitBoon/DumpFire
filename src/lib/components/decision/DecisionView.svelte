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

  Card 2683: the survey questions (`surveyQuestions`) follow the options.
  A consulted participant given the `response` snippet answers them there; to
  anyone else they are drawn here alone, with no input (`SurveyQuestions`),
  with `surveyWhoSees`' sentence to a participant. On a round that puts no
  options to a vote, who sees a response is said without its last sentence,
  the release one, as such a round releases nothing (R10).

  Card 2684 (R22): the `flags` snippet follows the response: a participant's
  objections and requests to talk, and the forms to raise them (`FlagForm`),
  drawn only when given.

  Its props are `DecisionViewProps` (src/lib/decision-view-types.ts): no
  version number, publication or inclusion moment, so that a preview builds
  them from the working content. The pages draw the banner and the form, which
  need those, in their snippets, through the components they share
  (`ParticipantBanner` and `ParticipantResponse`, card 2707). It fetches
  nothing and posts nothing.

  Card 3075: it fills the page's main column, beside the side column the
  pages draw; running text keeps a measure of about 80 characters, while the
  options and the forms take the full width. The status is the kit's Badge,
  and the response section is `#response`, where the side column links.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { DecisionViewProps } from '$lib/decision-view-types';
	import Badge from '$lib/components/ui/Badge.svelte';
	import { shownMoment, surveyWhoSees, whoSeesStatement } from '$lib/decision-words';
	import AgentLabel from './AgentLabel.svelte';
	import MarkdownBlock from './MarkdownBlock.svelte';
	import SurveyQuestions from './SurveyQuestions.svelte';

	let {
		decision,
		content,
		options,
		surveyQuestions = [],
		audiences,
		participant,
		mode,
		banner,
		response,
		results,
		concern,
		questions,
		linkedCards,
		flags
	}: DecisionViewProps & {
		banner?: Snippet;
		response?: Snippet;
		results?: Snippet;
		concern?: Snippet;
		questions?: Snippet;
		linkedCards?: Snippet;
		flags?: Snippet;
	} = $props();

	/** Whether the version flags this section as drafted by an agent and not yet reviewed. */
	const flagged = (key: string) => Object.hasOwn(content.agentDrafted, key);
	const consulted = $derived(participant?.role === 'consulted');
	const decider = $derived(decision.deciderName ?? 'the decider');
	/** Card 2683 (R10): a survey round releases nothing, so who sees a response is said without the release sentence. */
	const releases = $derived(!(options.length === 0 && surveyQuestions.length > 0));
</script>

{#snippet agentLabel(key: string)}
	{#if flagged(key)}
		<AgentLabel tag="p" data-flag={key} />
	{/if}
{/snippet}

<article class="decision-view" data-mode={mode}>
	<header class="view-head">
		<h1>{decision.title}</h1>
		<Badge status={decision.shownStatus} />
	</header>

	{#if banner}
		<div class="view-banner" data-section="banner">{@render banner()}</div>
	{/if}

	{#if content.situation !== ''}
		<section class="prose" data-section="situation">
			<h2>Situation</h2>
			{@render agentLabel('situation')}
			<MarkdownBlock text={content.situation} />
		</section>
	{/if}

	<section class="prose" data-section="question">
		<h2>The question</h2>
		{@render agentLabel('question')}
		<p class="question">{content.question}</p>
	</section>

	<section class="prose" data-section="ask">
		<h2>What is asked of you, and by when</h2>
		{@render agentLabel('ask')}
		{#if content.ask !== ''}<MarkdownBlock text={content.ask} />{/if}
		{#if decision.closesAt !== null}<p class="by-when">By {shownMoment(decision.closesAt, '')}.</p>{/if}
	</section>

	{#if consulted}
		<section class="prose" data-section="who-sees">
			<h2>Who sees your response</h2>
			<!-- The words and their version are one bundle's, so the version a response sends is the one shown (card 2679, decisions 21 and 25). -->
			<p>{whoSeesStatement(decider, releases)}</p>
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

	{#if surveyQuestions.length > 0 && !(consulted && response)}
		<section data-section="survey">
			<h2>Survey questions</h2>
			<SurveyQuestions questions={surveyQuestions} whoSees={participant !== null ? surveyWhoSees(decider) : null} />
		</section>
	{/if}

	{#if audiences.length > 0}
		<section class="prose" data-section="audiences">
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
		<section class="prose" data-section="stories">
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
		<section class="prose" data-section="unknowns">
			<h2>What is not yet known</h2>
			{@render agentLabel('unknowns')}
			<MarkdownBlock text={content.unknowns} />
		</section>
	{/if}

	{#if content.alreadyRuled !== ''}
		<section class="prose" data-section="already-ruled">
			<h2>Already settled</h2>
			{@render agentLabel('alreadyRuled')}
			<MarkdownBlock text={content.alreadyRuled} />
		</section>
	{/if}

	{#if content.technicalDetail !== ''}
		<section class="prose" data-section="technical-detail">
			<details>
				<summary><h2>Technical detail</h2></summary>
				{@render agentLabel('technicalDetail')}
				<MarkdownBlock text={content.technicalDetail} />
			</details>
		</section>
	{/if}

	{#if consulted && response}
		<!-- The response is where the side column's Go to the form leads (card 3075). -->
		<section class="response-section" data-section="response" id="response" aria-labelledby="response-heading">
			<h2 id="response-heading">Your response</h2>
			{@render response()}
		</section>
	{/if}

	{#if flags}
		<section data-section="flags" aria-labelledby="flags-heading">
			<h2 id="flags-heading">Objections and requests to talk</h2>
			{@render flags()}
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
	/* It fills the page's main column (card 3075); running text keeps a readable measure, the options and forms the full width. */
	.decision-view { font-size: 1rem; display: flex; flex-direction: column; gap: var(--space-xl); min-width: 0; color: var(--ui-foreground); }
	.prose { max-width: 80ch; }
	/* Reached by the side column's Go to the form: its heading clear of the shell's fixed header. */
	.response-section { scroll-margin-top: calc(64px + var(--space-md)); }
	.view-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm) var(--space-md); }
	.view-head h1 { font-size: 1.625rem; font-weight: 600; line-height: 1.2; letter-spacing: -0.025em; margin: 0; flex: 0 1 auto; min-width: 0; overflow-wrap: anywhere; }
	/* The banner: a quiet panel; its parts stay its direct children (card 2707's tests compare them). */
	.view-banner {
		padding: 0.75rem 1rem;
		border: 1px solid var(--ui-border);
		border-radius: var(--ui-radius-lg);
		background: color-mix(in srgb, var(--ui-muted) 50%, transparent);
	}
	section h2 { font-size: 1.0625rem; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 var(--space-sm); }
	section h3 { font-size: 1rem; font-weight: 600; margin: var(--space-sm) 0 var(--space-xs); }
	section h4 { font-size: 0.8125rem; font-weight: 600; margin: var(--space-md) 0 var(--space-xs); color: var(--ui-muted-foreground); }
	.question { font-size: 1.125rem; font-weight: 600; margin: 0; overflow-wrap: anywhere; }
	.by-when { font-weight: 600; margin: var(--space-sm) 0 0; }
	/* Side by side where there is room, stacked on a phone (decision 22). */
	.option-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr)); gap: var(--space-md); }
	.option-card {
		min-width: 0;
		padding: 1rem 1.25rem;
		border: 1px solid var(--ui-border);
		border-radius: var(--ui-radius-lg);
		background: var(--ui-card);
		box-shadow: var(--ui-shadow-sm);
	}
	.option-label { margin: 0; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ui-muted-foreground); }
	.option-card h3 { margin-top: var(--space-xs); }
	.option-card ul { margin: 0; padding-left: 1.2rem; }
	details > summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; border-radius: var(--ui-radius-sm); }
	details > summary:focus-visible { outline: 2px solid var(--ui-ring); outline-offset: 2px; }
	details > summary h2 { margin: 0; }
	.audience { border-bottom: 1px solid var(--ui-border); }
	.audience > summary { font-weight: 600; }
</style>