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
	 *
	 * Card 2684 (R11): each participation's objections and requests to talk,
	 * oldest first, with the replies as plain text: to the person their own,
	 * with no one named as who replied ("the decider"), a removed person's
	 * with only the replies given up to their removal (the server's rule); to
	 * an administrator and the decider also how each was raised and who
	 * replied, by name. Their events are named in the record's words.
	 *
	 * Card 3075: on the kit's shell, full width; each participation a card,
	 * as many across as fit, newest first.
	 */
	import type { PageData } from './$types';
	import RecordEvents from '$lib/components/decision/RecordEvents.svelte';
	import PageShell from '$lib/components/ui/PageShell.svelte';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import CardHeader from '$lib/components/ui/CardHeader.svelte';
	import CardTitle from '$lib/components/ui/CardTitle.svelte';
	import CardContent from '$lib/components/ui/CardContent.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import type { OwnRecordEvent, ParticipationDecision, RecordAnswer, RecordFlag, RecordResponse } from '$lib/decision-register-types';
	import type { QuestionView } from '$lib/decision-view-types';
	import {
		answeredByWords,
		eventWords,
		FLAG_KIND_WORDS,
		flagRepliedWords,
		flagUnrepliedWords,
		PARTICIPATION_ROLE_WORDS,
		shownMoment,
		unansweredWords
	} from '$lib/decision-words';

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

{#snippet flagsOf(flags: RecordFlag[])}
	{#if flags.length > 0}
		<h3>{own ? 'Your objections and requests to talk' : 'Objections and requests to talk'}</h3>
		<ul class="plain" data-list="flags">
			{#each flags as flag, i (i)}
				<li data-flag-kind={flag.kind}>
					<p class="line">
						<strong>{FLAG_KIND_WORDS[flag.kind]}</strong>
						<span class="meta">version {flag.versionNumber}, {shownMoment(flag.raisedAt, '')}{flag.via === 'link' ? ', by link' : ''}</span>
					</p>
					{#if flag.reason !== ''}<p class="text" data-text="reason">{flag.reason}</p>{/if}
					{#if flag.reply !== null}
						<p class="text answer" data-text="reply">{flag.reply}</p>
						<p class="meta" data-note="replied">{flagRepliedWords(flag.kind, flag.repliedByName)}, {shownMoment(flag.repliedAt, '')}</p>
					{:else}
						<p class="meta" data-note="no-reply">{flagUnrepliedWords(flag.kind)}</p>
					{/if}
				</li>
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
		<Badge status={decision.shownStatus} />
		{#if decision.board.id !== null}<a class="target" href="/board/{decision.board.id}">{decision.board.name}</a>{:else}{decision.board.name}{decision.board.gone ? ' (deleted)' : ''}{/if}
		{#if decision.closesAt !== null}<span>closes {shownMoment(decision.closesAt, '')}</span>{/if}
	</p>
{/snippet}

{#snippet crumbs()}
	<nav class="crumb" aria-label="Where this is"><a href="/decisions">Decisions</a></nav>
{/snippet}

<PageShell width="full" {crumbs}>
	<PageHeader title={own ? 'Your record' : data.person.name}>
		<div class="person-lines">
			{#if own}<p class="meta">{data.person.name}{data.person.jobTitle ? `, ${data.person.jobTitle}` : ''}</p>
			{:else}
				{#if data.person.jobTitle}<p class="meta">{data.person.jobTitle}</p>{/if}
				{#if data.person.groups && data.person.groups.length > 0}<p class="meta">Groups: {data.person.groups.join(', ')}</p>{/if}
				{#if data.person.email}<p class="meta" data-field="email">{data.person.email}</p>{/if}
				{#if data.person.status === 'left'}<p class="meta" data-field="left">Has left</p>{/if}
			{/if}
		</div>
	</PageHeader>

	{#if data.participations.length === 0}
		<EmptyState title={own ? 'You have not been included in a decision yet.' : 'No participations to show.'} />
	{:else if data.audience === 'self'}
		<div class="participations">
			{#each data.participations as participation, i (i)}
				<Card as="article" data-participation={participation.kind === 'removed' && participation.removedAt === null ? 'unviewable' : participation.kind}>
					{#if participation.kind === 'removed'}
						<!-- F4: "removed" only where the row was removed; a live row the person may not open has its own words. -->
						<CardHeader>
							<CardTitle level={2}>{participation.removedAt !== null ? 'A decision you were removed from' : 'A decision you can no longer open'}</CardTitle>
						</CardHeader>
						<CardContent>
							<p class="meta">Included {shownMoment(participation.includedAt, '')}{participation.removedAt !== null ? `, removed ${shownMoment(participation.removedAt, '')}` : ''}</p>
							{@render responsesOf(participation.responses)}
							{@render questionsOf(participation.questions)}
							{@render concernsOf(participation.concerns)}
							{@render flagsOf(participation.flags)}
							{@render ownEvents(participation.events)}
						</CardContent>
					{:else}
						<CardHeader>
							<CardTitle level={2}><a class="title-link" href="/decisions/{participation.decision.id}">{participation.decision.title}</a></CardTitle>
						</CardHeader>
						<CardContent>
							{@render decisionLine(participation.decision)}
							<p class="meta">
								{PARTICIPATION_ROLE_WORDS[participation.role]}, included {shownMoment(participation.includedAt, '')}{participation.removedAt !== null
									? `, removed ${shownMoment(participation.removedAt, '')}`
									: ''}
							</p>
							{@render responsesOf(participation.responses)}
							{@render questionsOf(participation.questions)}
							{@render concernsOf(participation.concerns)}
							{@render flagsOf(participation.flags)}
							{@render ownEvents(participation.events)}
						</CardContent>
					{/if}
				</Card>
			{/each}
		</div>
	{:else}
		<div class="participations">
			{#each data.participations as participation, i (i)}
				<Card as="article" data-participation="full">
					<CardHeader>
						<CardTitle level={2}><a class="title-link" href="/decisions/{participation.decision.id}">{participation.decision.title}</a></CardTitle>
					</CardHeader>
					<CardContent>
						{@render decisionLine(participation.decision)}
						<p class="meta">
							{PARTICIPATION_ROLE_WORDS[participation.role]} as {participation.name}{participation.jobTitle ? `, ${participation.jobTitle}` : ''}{participation.groups.length > 0
								? ` (${participation.groups.join(', ')})`
								: ''}; included {shownMoment(participation.includedAt, '')}{participation.removedAt !== null ? `, removed ${shownMoment(participation.removedAt, '')}` : ''}
						</p>
						{#if participation.id !== undefined}
							<p><Button variant="outline" size="sm" href={recordHref(participation.decision.id, participation.id)} data-action="record">Record</Button></p>
						{/if}
						{@render responsesOf(participation.responses)}
						{@render questionsOf(participation.questions)}
						{@render concernsOf(participation.concerns)}
						{@render flagsOf(participation.flags)}
						<h3>Events</h3>
						<RecordEvents entries={participation.events} />
						{#if participation.moreEvents && participation.id !== undefined}
							<p><a class="target" href={recordHref(participation.decision.id, participation.id)} data-action="more">More in the record</a></p>
						{/if}
					</CardContent>
				</Card>
			{/each}
		</div>
	{/if}

	{#if data.next !== null || data.before !== null}
		<nav class="pages" aria-label="Pages of the record">
			{#if data.before !== null}<Button variant="outline" size="sm" href={base} data-page="newest">Back to newest</Button>{/if}
			{#if data.next !== null}<Button variant="outline" size="sm" href="{base}?before={data.next}" data-page="next">Older participations</Button>{/if}
		</nav>
	{/if}
</PageShell>

<style>
	.crumb {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.crumb a {
		border-radius: var(--ui-radius-sm);
		color: var(--ui-muted-foreground);
		text-decoration: none;
	}
	.crumb a:hover {
		color: var(--ui-foreground);
	}

	.person-lines {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		margin-top: calc(-1 * var(--space-sm));
	}

	/* Newest first, as many across as fit at 32rem each. */
	.participations {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 32rem), 1fr));
		gap: var(--space-lg);
		align-items: start;
	}

	h3 {
		margin: var(--space-lg) 0 var(--space-xs);
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--ui-foreground);
	}
	.title-link {
		border-radius: var(--ui-radius-sm);
		color: var(--ui-foreground);
		text-decoration: none;
		text-underline-offset: 3px;
		overflow-wrap: anywhere;
	}
	.title-link:hover {
		color: var(--ui-foreground);
		text-decoration: underline;
	}
	.target {
		border-radius: var(--ui-radius-sm);
		color: var(--ui-foreground);
		text-decoration: underline;
		text-decoration-color: var(--ui-border);
		text-underline-offset: 3px;
	}
	.target:hover {
		color: var(--ui-foreground);
		text-decoration-color: currentColor;
	}
	.title-link:focus-visible,
	.target:focus-visible,
	.crumb a:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}

	.meta {
		margin: 0 0 var(--space-xs);
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		align-items: center;
		font-size: 0.8125rem;
		color: var(--ui-muted-foreground);
		overflow-wrap: anywhere;
	}
	.line {
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		align-items: baseline;
	}
	.text {
		margin: var(--space-xs) 0 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.answer {
		padding-left: var(--space-md);
		border-left: 2px solid var(--ui-border);
	}
	.plain {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}
	.own-event {
		font-size: 0.875rem;
	}
	.pages {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		margin-top: var(--space-lg);
	}

	@media (pointer: coarse) {
		.target {
			display: inline-flex;
			align-items: center;
			min-height: 2.75rem;
		}
	}
</style>
