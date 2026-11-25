<script lang="ts">
	/**
	 * A decision's record (card 2680, decision 16): every event of the
	 * decision, oldest first, for its decider and administrators, in
	 * `RecordEvents`. The participant select is a GET form with its label,
	 * listing the decision's participants by the name they were included
	 * under; choosing one starts again at the first event. 500 events a page:
	 * Next carries `after`, and past the first page, Back to the start.
	 *
	 * "People's records" links each participant who is a person of the
	 * directory to their person record (code review F1), which this reader,
	 * the decider or an administrator, may open; a draft's participants, and
	 * one included by address alone, have no link.
	 *
	 * Card 3075: on the kit's shell, full width, the participant filter and
	 * People's records in a rail on the left from 1024px (above the record
	 * beneath that).
	 */
	import type { PageData } from './$types';
	import RecordEvents from '$lib/components/decision/RecordEvents.svelte';
	import PageShell from '$lib/components/ui/PageShell.svelte';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import CardContent from '$lib/components/ui/CardContent.svelte';

	let { data }: { data: PageData } = $props();

	const base = $derived(`/decisions/${data.decision.id}/record`);
	const withParticipant = (extra: string) => {
		const search = new URLSearchParams();
		if (data.participant !== null) search.set('participant', String(data.participant));
		if (extra !== '') search.set('after', extra);
		const text = search.toString();
		return text === '' ? base : `${base}?${text}`;
	};
	const countWords = $derived(data.entries.length === 1 ? 'Showing 1 event.' : `Showing ${data.entries.length} events.`);
	/** A later page: Back to the start is offered. */
	const later = $derived(data.after !== null);
	/** The participants with a person record this reader may open (code review F1): the server gives `personId` for those alone. */
	const withRecords = $derived(data.participants.filter((participant): participant is { id: number; name: string; personId: number } => participant.personId !== undefined));
</script>

<svelte:head>
	<title>Record of {data.decision.title} — DumpFire</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#snippet crumbs()}
	<nav class="crumb" aria-label="Where this is">
		<a href="/decisions">Decisions</a>
		<span aria-hidden="true">/</span>
		<a href="/decisions/{data.decision.id}">{data.decision.title}</a>
	</nav>
{/snippet}

{#snippet side()}
	<div class="rail-stack">
		<Card>
			<CardContent>
				<form class="filters" method="GET" action={base} data-form="participant">
					<div class="filter">
						<label class="ui-label" for="record-participant">Participant</label>
						<select id="record-participant" name="participant" class="ui-select" value={data.participant === null ? '' : String(data.participant)}>
							<option value="">Every participant and event</option>
							{#each data.participants as participant (participant.id)}
								<option value={String(participant.id)}>{participant.name}</option>
							{/each}
						</select>
					</div>
					<div class="filter-actions"><Button type="submit">Show</Button></div>
				</form>
			</CardContent>
		</Card>

		{#if withRecords.length > 0}
			<Card>
				<CardContent>
					<details class="people">
						<summary>People's records</summary>
						<ul class="people-list">
							{#each withRecords as participant (participant.id)}
								<li><a class="person-link" href="/decisions/people/{participant.personId}" data-action="person-record">{participant.name}</a></li>
							{/each}
						</ul>
					</details>
				</CardContent>
			</Card>
		{/if}
	</div>
{/snippet}

<PageShell width="full" {crumbs} rail={side} railLabel="Filter the record" railPosition="start">
	<PageHeader title="Record of {data.decision.title}">
		<p class="status-line"><Badge status={data.decision.shownStatus} /></p>
	</PageHeader>

	<p class="result-count" role="status" aria-live="polite" data-said="count">{countWords}</p>

	<RecordEvents entries={data.entries} empty={data.participant === null ? 'Nothing has been recorded on this decision yet.' : 'No event names this participant.'} />

	{#if data.next !== null || later}
		<nav class="pages" aria-label="Pages of the record">
			{#if later}<Button variant="outline" size="sm" href={withParticipant('')} data-page="start">Back to the start</Button>{/if}
			{#if data.next !== null}<Button variant="outline" size="sm" href={withParticipant(String(data.next))} data-page="next">Later events</Button>{/if}
		</nav>
	{/if}
</PageShell>

<style>
	.crumb {
		display: flex;
		gap: var(--space-xs);
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
	}
	.crumb a {
		overflow: hidden;
		text-overflow: ellipsis;
		border-radius: var(--ui-radius-sm);
		color: var(--ui-muted-foreground);
		text-decoration: none;
	}
	.crumb a:hover {
		color: var(--ui-foreground);
	}
	.crumb a:focus-visible,
	.person-link:focus-visible,
	.people summary:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}

	.status-line {
		margin: calc(-1 * var(--space-sm)) 0 0;
	}

	.rail-stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}
	.filters {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}
	.filter {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.filter-actions {
		display: grid;
	}

	.people summary {
		cursor: pointer;
		border-radius: var(--ui-radius-sm);
		font-size: 0.875rem;
		font-weight: 500;
	}
	.people-list {
		list-style: none;
		margin: var(--space-sm) 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}
	.person-link {
		border-radius: var(--ui-radius-sm);
		color: var(--ui-foreground);
		text-decoration: underline;
		text-decoration-color: var(--ui-border);
		text-underline-offset: 3px;
	}
	.person-link:hover {
		color: var(--ui-foreground);
		text-decoration-color: currentColor;
	}

	.result-count {
		margin: 0 0 var(--space-sm);
		font-size: 0.875rem;
		color: var(--ui-muted-foreground);
	}
	.pages {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		margin-top: var(--space-lg);
	}

	@media (pointer: coarse) {
		.people summary {
			padding-block: 0.75rem;
		}
		.person-link {
			display: inline-flex;
			align-items: center;
			min-height: 2.75rem;
		}
	}
</style>
