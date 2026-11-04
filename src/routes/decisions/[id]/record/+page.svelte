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
	 */
	import type { PageData } from './$types';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';
	import RecordEvents from '$lib/components/decision/RecordEvents.svelte';
	import { STATUS_WORDS } from '$lib/decision-words';
	import { theme, themeIcon } from '$lib/stores/theme';

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

<div class="record-page">
	<header class="record-header glass">
		<div class="record-header-inner">
			<a href="/" class="header-logo" title="Back to DumpFire">
				<span class="logo-fire">🔥</span>
				<span class="logo-text">DumpFire</span>
			</a>
			<nav class="crumb" aria-label="Where this is">
				<a href="/decisions">Decisions</a>
				<span aria-hidden="true">/</span>
				<a href="/decisions/{data.decision.id}">{data.decision.title}</a>
			</nav>
			<HeaderMenu label="Theme" triggerClass="btn-ghost" triggerTitle="Change theme">
				{#snippet trigger()}<span aria-hidden="true">{themeIcon($theme)}</span>{/snippet}
				<ThemeMenuItems heading={false} />
			</HeaderMenu>
		</div>
	</header>

	<main class="record-content">
		<h1>Record of {data.decision.title}</h1>
		<p class="status-line"><span class="status-chip" data-status={data.decision.shownStatus}>{STATUS_WORDS[data.decision.shownStatus] ?? data.decision.shownStatus}</span></p>

		<form class="filters glass" method="GET" action={base} data-form="participant">
			<div class="filter">
				<label for="record-participant">Participant</label>
				<select id="record-participant" name="participant" class="field" value={data.participant === null ? '' : String(data.participant)}>
					<option value="">Every participant and event</option>
					{#each data.participants as participant (participant.id)}
						<option value={String(participant.id)}>{participant.name}</option>
					{/each}
				</select>
			</div>
			<button type="submit" class="btn-primary target">Show</button>
		</form>

		{#if withRecords.length > 0}
			<details class="people glass">
				<summary class="target">People's records</summary>
				<ul class="people-list">
					{#each withRecords as participant (participant.id)}
						<li><a class="target" href="/decisions/people/{participant.personId}" data-action="person-record">{participant.name}</a></li>
					{/each}
				</ul>
			</details>
		{/if}

		<p class="result-count" role="status" aria-live="polite" data-said="count">{countWords}</p>

		<RecordEvents entries={data.entries} empty={data.participant === null ? 'Nothing has been recorded on this decision yet.' : 'No event names this participant.'} />

		{#if data.next !== null || later}
			<nav class="pages" aria-label="Pages of the record">
				{#if later}<a class="target" href={withParticipant('')} data-page="start">Back to the start</a>{/if}
				{#if data.next !== null}<a class="target" href={withParticipant(String(data.next))} data-page="next">Later events</a>{/if}
			</nav>
		{/if}
	</main>
</div>

<style>
	.record-page { min-height: 100vh; padding-top: 64px; }
	.record-header {
		position: fixed; top: 0; left: 0; right: 0; z-index: 200;
		height: 64px; border-bottom: 1px solid var(--glass-border);
		backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
	}
	.record-header-inner {
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
	.crumb { flex: 1; font-size: 0.85rem; min-width: 0; display: flex; gap: var(--space-xs); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
	.crumb a { color: var(--text-secondary); text-decoration: none; overflow: hidden; text-overflow: ellipsis; }

	.record-content { max-width: 52rem; margin: 0 auto; padding: var(--space-xl) var(--space-md) var(--user-badge-space); }
	h1 { font-size: 1.2rem; margin: 0 0 var(--space-xs); overflow-wrap: anywhere; }
	.status-line { margin: 0 0 var(--space-md); }
	.status-chip { display: inline-block; padding: 1px var(--space-sm); border-radius: 999px; font-size: 0.75rem; background: rgba(99, 102, 241, 0.12); color: var(--accent-indigo); }
	.filters { display: flex; flex-wrap: wrap; gap: var(--space-md); align-items: flex-end; padding: var(--space-md); border-radius: var(--radius-md); margin-bottom: var(--space-md); }
	.filter { display: flex; flex-direction: column; gap: var(--space-xs); flex: 1; min-width: 12rem; }
	.filter label { font-size: 0.85rem; color: var(--text-secondary); }
	.field {
		min-height: 44px; box-sizing: border-box; font-size: 16px; font-family: var(--font-family); padding: 0 var(--space-sm);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm); background: var(--bg-elevated); color: var(--text-primary);
	}
	.target { min-height: 44px; display: inline-flex; align-items: center; }
	button.target { padding: 0 var(--space-lg); }
	.target:focus-visible, .field:focus-visible { outline: 2px solid var(--accent-indigo); outline-offset: 2px; }
	.result-count { font-size: 0.9rem; color: var(--text-secondary); margin: 0 0 var(--space-sm); }
	.people { padding: 0 var(--space-md); border-radius: var(--radius-md); margin-bottom: var(--space-md); }
	.people summary { cursor: pointer; font-size: 0.9rem; }
	.people summary:focus-visible { outline: 2px solid var(--accent-indigo); outline-offset: 2px; }
	.people-list { list-style: none; margin: 0; padding: 0 0 var(--space-sm); display: flex; flex-wrap: wrap; gap: 0 var(--space-lg); }
	.people-list a { color: var(--accent-indigo); text-decoration: none; }
	.pages { display: flex; flex-wrap: wrap; gap: var(--space-lg); margin-top: var(--space-md); }
	.pages a { color: var(--accent-indigo); text-decoration: none; }
	@media (max-width: 640px) {
		.record-header-inner { padding: 0 var(--space-md); }
		.logo-text { display: none; }
	}
</style>
