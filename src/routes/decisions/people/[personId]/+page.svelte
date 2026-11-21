<script lang="ts">
	/**
	 * One person's record of what they were asked and what they said (card
	 * 2680, decisions 9 to 15), drawn from the audience the server gave it:
	 *
	 *   - an administrator's, or a decider's of their own decisions: each
	 *     participation with its decision, the name, job title and groups it
	 *     was given under, every response (replaced ones too) with how it was
	 *     given, the questions, the concerns, the events in `RecordEvents`, and
	 *     a Record link to the decision's record filtered to this participant,
	 *     which "More in the record" names where more events are kept;
	 *   - the person's own: their own responses, questions, concerns and their
	 *     own moments (invited, seen, responded…), with no one's name as who
	 *     did it and no link to a record they cannot read. A decision they were
	 *     removed from and may no longer view is "A decision you were removed
	 *     from", with nothing of the decision and no link (S2); a live
	 *     participation they may not open (two live rows on one account, say)
	 *     has the same shape and is "A decision you can no longer open" (code
	 *     review F4).
	 *
	 * 25 participations a page, newest first: Older carries `before`, and past
	 * the first page, Back to newest.
	 *
	 * Card 2683 (R10, R14): each response's answers to survey questions, by the
	 * prompt as the version answered under asked it, a written answer as
	 * plain text; only the person, the decider and administrators read this
	 * page. A survey answered is said as such, never as an option chosen.
	 */
	import type { PageData } from './$types';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';
	import RecordEvents from '$lib/components/decision/RecordEvents.svelte';
	import type { OwnRecordEvent, ParticipationDecision, RecordAnswer, RecordResponse } from '$lib/decision-register-types';
	import type { QuestionView } from '$lib/decision-view-types';
	import { answeredByWords, eventWords, PARTICIPATION_ROLE_WORDS, STATUS_WORDS, shownMoment, unansweredWords } from '$lib/decision-words';
	import { theme, themeIcon } from '$lib/stores/theme';

	let { data }: { data: PageData } = $props();

	const base = $derived(`/decisions/people/${data.personId}`);
	const own = $derived(data.audience === 'self');

	/** A response as a line: what was chosen, by option label. */
	function choiceWords(response: RecordResponse): string {
		if (response.kind === 'abstain') return 'Abstained';
		if (response.kind === 'no_concerns') return 'No concerns';
		if (response.kind === 'answered') return 'Answered the survey';
		if (response.scores !== null) return `Scores: ${Object.entries(response.scores).map(([label, score]) => `${label} ${score}`).join(', ')}`;
		return response.option === null ? 'Chose an option no longer offered' : `Chose option ${response.option}`;
	}

	/** Card 2683: an answer in words, the choice by its words, a number with its scale's top, a written answer as written. */
	const recordAnswerWords = (answer: RecordAnswer) =>
		answer.kind === 'choice' ? answer.choice : answer.kind === 'scale' ? `${answer.value} of ${answer.max}` : answer.text;

	const decisionWords = (decision: ParticipationDecision) => STATUS_WORDS[decision.shownStatus] ?? decision.shownStatus;
	const recordHref = (decisionId: number, participantId: number) => `/decisions/${decisionId}/record?participant=${participantId}`;
</script>

<svelte:head>
	<title>{data.person.name} — Decisions — DumpFire</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#snippet responsesOf(responses: RecordResponse[])}
	{#if responses.length > 0}
		<h3>{own ? 'Your responses' : 'Responses'}</h3>
		<ul class="plain">
			{#each responses as response, i (i)}
				<li data-response={response.current ? 'current' : 'replaced'}>
					<p class="line">
						<strong>{choiceWords(response)}</strong>
						<span class="meta">version {response.versionNumber}, round {response.round}, {shownMoment(response.createdAt, '')}{response.via ? `, ${response.via}` : ''}{response.current ? '' : ', replaced'}</span>
					</p>
					{#if response.comment}<p class="text">{response.comment}</p>{/if}
					{#each Object.entries(response.optionComments) as [label, text] (label)}<p class="text">On option {label}: {text}</p>{/each}
					{#each response.answers as answer, a (a)}<p class="text" data-answer>{answer.prompt}: {recordAnswerWords(answer)}</p>{/each}
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

{#snippet questionsOf(questions: QuestionView[])}
	{#if questions.length > 0}
		<h3>{own ? 'Your questions' : 'Questions'}</h3>
		<ul class="plain">
			{#each questions as question, i (i)}
				<li>
					<p class="text">{question.question}</p>
					{#if question.answer !== null}
						<p class="text answer">{question.answer.text}</p>
						<p class="meta">{answeredByWords(question.answer.answererName, question.answer.answererRole)}, {shownMoment(question.answer.answeredAt, '')}</p>
					{:else if question.draft !== undefined}
						<p class="meta">An agent's draft answer waits for review: {question.draft.text}</p>
					{:else}
						<p class="meta">{unansweredWords(question.closedUnanswered)}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

{#snippet concernsOf(concerns: { comment: string; createdAt: string }[])}
	{#if concerns.length > 0}
		<h3>{own ? 'Your concerns' : 'Concerns'}</h3>
		<ul class="plain">
			{#each concerns as concern, i (i)}
				<li><p class="text">{concern.comment}</p><p class="meta">{shownMoment(concern.createdAt, '')}</p></li>
			{/each}
		</ul>
	{/if}
{/snippet}

{#snippet ownEvents(events: OwnRecordEvent[])}
	{#if events.length > 0}
		<h3>What happened</h3>
		<ol class="plain">
			{#each events as event, i (i)}
				<li class="own-event" data-kind={event.kind}>
					{eventWords(event.kind)}{event.stage ? ` (${event.stage})` : ''}: {shownMoment(event.at, '')}{event.versionNumber !== null ? `, version ${event.versionNumber}` : ''}
				</li>
			{/each}
		</ol>
	{/if}
{/snippet}

{#snippet decisionLine(decision: ParticipationDecision)}
	<p class="meta">
		<span class="status-chip" data-status={decision.shownStatus}>{decisionWords(decision)}</span>
		{#if decision.board.id !== null}<a class="target" href="/board/{decision.board.id}">{decision.board.name}</a>{:else}{decision.board.name}{decision.board.gone ? ' (deleted)' : ''}{/if}
		{#if decision.closesAt !== null}<span>closes {shownMoment(decision.closesAt, '')}</span>{/if}
	</p>
{/snippet}

<div class="person-page">
	<header class="person-header glass">
		<div class="person-header-inner">
			<a href="/" class="header-logo" title="Back to DumpFire">
				<span class="logo-fire">🔥</span>
				<span class="logo-text">DumpFire</span>
			</a>
			<nav class="crumb" aria-label="Where this is"><a href="/decisions">Decisions</a></nav>
			<HeaderMenu label="Theme" triggerClass="btn-ghost" triggerTitle="Change theme">
				{#snippet trigger()}<span aria-hidden="true">{themeIcon($theme)}</span>{/snippet}
				<ThemeMenuItems heading={false} />
			</HeaderMenu>
		</div>
	</header>

	<main class="person-content">
		<section class="person-card glass" aria-labelledby="person-name">
			<h1 id="person-name">{own ? 'Your record' : data.person.name}</h1>
			{#if own}<p class="meta">{data.person.name}{data.person.jobTitle ? `, ${data.person.jobTitle}` : ''}</p>
			{:else}
				{#if data.person.jobTitle}<p class="meta">{data.person.jobTitle}</p>{/if}
				{#if data.person.groups && data.person.groups.length > 0}<p class="meta">Groups: {data.person.groups.join(', ')}</p>{/if}
				{#if data.person.email}<p class="meta" data-field="email">{data.person.email}</p>{/if}
				{#if data.person.status === 'left'}<p class="meta" data-field="left">Has left</p>{/if}
			{/if}
		</section>

		{#if data.participations.length === 0}
			<p class="empty">{own ? 'You have not been included in a decision yet.' : 'No participations to show.'}</p>
		{:else if data.audience === 'self'}
			{#each data.participations as participation, i (i)}
				<article
					class="participation glass"
					data-participation={participation.kind === 'removed' && participation.removedAt === null ? 'unviewable' : participation.kind}
				>
					{#if participation.kind === 'removed'}
						<!-- F4: "removed" only where the row was removed; a live row the person may not open has its own words. -->
						<h2>{participation.removedAt !== null ? 'A decision you were removed from' : 'A decision you can no longer open'}</h2>
						<p class="meta">Included {shownMoment(participation.includedAt, '')}{participation.removedAt !== null ? `, removed ${shownMoment(participation.removedAt, '')}` : ''}</p>
						{@render responsesOf(participation.responses)}
						{@render questionsOf(participation.questions)}
						{@render concernsOf(participation.concerns)}
						{@render ownEvents(participation.events)}
					{:else}
						<h2><a class="target" href="/decisions/{participation.decision.id}">{participation.decision.title}</a></h2>
						{@render decisionLine(participation.decision)}
						<p class="meta">
							{PARTICIPATION_ROLE_WORDS[participation.role]}, included {shownMoment(participation.includedAt, '')}{participation.removedAt !== null
								? `, removed ${shownMoment(participation.removedAt, '')}`
								: ''}
						</p>
						{@render responsesOf(participation.responses)}
						{@render questionsOf(participation.questions)}
						{@render concernsOf(participation.concerns)}
						{@render ownEvents(participation.events)}
					{/if}
				</article>
			{/each}
		{:else}
			{#each data.participations as participation, i (i)}
				<article class="participation glass" data-participation="full">
					<h2><a class="target" href="/decisions/{participation.decision.id}">{participation.decision.title}</a></h2>
					{@render decisionLine(participation.decision)}
					<p class="meta">
						{PARTICIPATION_ROLE_WORDS[participation.role]} as {participation.name}{participation.jobTitle ? `, ${participation.jobTitle}` : ''}{participation.groups.length > 0
							? ` (${participation.groups.join(', ')})`
							: ''}; included {shownMoment(participation.includedAt, '')}{participation.removedAt !== null ? `, removed ${shownMoment(participation.removedAt, '')}` : ''}
					</p>
					{#if participation.id !== undefined}
						<p><a class="target" href={recordHref(participation.decision.id, participation.id)} data-action="record">Record</a></p>
					{/if}
					{@render responsesOf(participation.responses)}
					{@render questionsOf(participation.questions)}
					{@render concernsOf(participation.concerns)}
					<h3>Events</h3>
					<RecordEvents entries={participation.events} />
					{#if participation.moreEvents && participation.id !== undefined}
						<p><a class="target" href={recordHref(participation.decision.id, participation.id)} data-action="more">More in the record</a></p>
					{/if}
				</article>
			{/each}
		{/if}

		{#if data.next !== null || data.before !== null}
			<nav class="pages" aria-label="Pages of the record">
				{#if data.before !== null}<a class="target" href={base} data-page="newest">Back to newest</a>{/if}
				{#if data.next !== null}<a class="target" href="{base}?before={data.next}" data-page="next">Older participations</a>{/if}
			</nav>
		{/if}
	</main>
</div>

<style>
	.person-page { min-height: 100vh; padding-top: 64px; }
	.person-header {
		position: fixed; top: 0; left: 0; right: 0; z-index: 200;
		height: 64px; border-bottom: 1px solid var(--glass-border);
		backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
	}
	.person-header-inner {
		max-width: 1400px; margin: 0 auto; height: 100%;
		display: flex; align-items: center; gap: var(--space-lg);
		padding: 0 var(--space-xl);
	}
	.header-logo {
		display: flex; align-items: center; gap: var(--space-sm);
		text-decoration: none; color: var(--text-primary);
		font-weight: 700; font-size: 1.1rem;
	}
	.logo-fire { font-size: 1.4rem; }
	.crumb { flex: 1; font-size: 0.85rem; min-width: 0; }
	.crumb a { color: var(--text-secondary); text-decoration: none; }

	.person-content { max-width: 52rem; margin: 0 auto; padding: var(--space-xl) var(--space-md) var(--user-badge-space); display: flex; flex-direction: column; gap: var(--space-md); }
	.person-card, .participation { padding: var(--space-md) var(--space-lg); border-radius: var(--radius-md); overflow-wrap: anywhere; }
	h1 { font-size: 1.2rem; margin: 0 0 var(--space-xs); }
	h2 { font-size: 1.05rem; margin: 0 0 var(--space-xs); }
	h3 { font-size: 0.9rem; margin: var(--space-md) 0 var(--space-xs); }
	h2 a, .participation a, .pages a { color: var(--accent-indigo); text-decoration: none; }
	.meta { margin: 0 0 var(--space-xs); font-size: 0.85rem; color: var(--text-secondary); display: flex; flex-wrap: wrap; gap: var(--space-sm); align-items: center; }
	.line { margin: 0; display: flex; flex-wrap: wrap; gap: var(--space-sm); align-items: baseline; }
	.text { margin: var(--space-xs) 0 0; white-space: pre-wrap; }
	.answer { padding-left: var(--space-md); border-left: 2px solid var(--glass-border); }
	.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-sm); }
	.own-event { font-size: 0.9rem; }
	.status-chip { display: inline-block; padding: 1px var(--space-sm); border-radius: 999px; font-size: 0.75rem; background: rgba(99, 102, 241, 0.12); color: var(--accent-indigo); }
	.empty { font-size: 0.95rem; color: var(--text-tertiary); }
	.target { min-height: 44px; display: inline-flex; align-items: center; }
	.target:focus-visible { outline: 2px solid var(--accent-indigo); outline-offset: 2px; }
	.pages { display: flex; flex-wrap: wrap; gap: var(--space-lg); }
	@media (max-width: 640px) {
		.person-header-inner { padding: 0 var(--space-md); }
		.logo-text { display: none; }
	}
</style>
