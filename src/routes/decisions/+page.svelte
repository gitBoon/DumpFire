<script lang="ts">
	/**
	 * The register of decisions (card 2680, decisions 1 to 8 and 31, D5):
	 * every decision the caller may view, across boards.
	 *
	 * The tabs are a labelled navigation of links, the current one
	 * `aria-current="page"`, each waiting tab with its count; switching tab
	 * keeps the board, person and title filters and drops `status`, which is
	 * All's alone. The filters are a GET form, each with a visible label; it
	 * carries no `before`, so a new filter starts at the newest. The person
	 * select is a search (`who`), never a list cut short: the server answers
	 * the matches in the caller's scope, or the person already chosen.
	 *
	 * The rows are a table with a caption and column headers; at phone width
	 * each row stacks as a block, each cell with its label, and every link and
	 * control is at least 44 px high. A polite status line says how many rows
	 * are shown, after a filter and after a live re-read alike. Each tab has
	 * its own empty-state words; with a filter set, "No matches" and Clear
	 * filters. Past the first page, Back to newest.
	 *
	 * The header links to the caller's own person record, "My record", where
	 * their account holds a person of the directory (code review F1), and to
	 * the guided tour, "How it works" (card 3070), which the empty state
	 * offers too.
	 *
	 * The page re-reads on a `decision` event (`connectLiveRefresh`, decision
	 * 26), which reaches a caller only for a board they can open: a decision
	 * with no board, or a participant's on a board they cannot open, is
	 * current on navigation, a return to the tab, or a reconnect.
	 *
	 * Card 3075: on the kit's shell, full width, the filters in a rail on the
	 * left from 1024px (above the list beneath that); the tabs, the table, the
	 * empty states and the status badges are the kit's.
	 */
	import { onMount } from 'svelte';
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import PageShell from '$lib/components/ui/PageShell.svelte';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import Tabs from '$lib/components/ui/Tabs.svelte';
	import Table from '$lib/components/ui/Table.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import CardHeader from '$lib/components/ui/CardHeader.svelte';
	import CardTitle from '$lib/components/ui/CardTitle.svelte';
	import CardContent from '$lib/components/ui/CardContent.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import { REGISTER_TABS, SHOWN_STATUSES, type RegisterTab } from '$lib/decision-register-types';
	import { PARTICIPATION_ROLE_WORDS, STATUS_WORDS, shownMoment } from '$lib/decision-words';
	import { connectLiveRefresh } from '$lib/live-refresh';

	let { data }: { data: PageData } = $props();

	/** Each tab's words; the tabs themselves, and their order, are `REGISTER_TABS`, which the server reads `tab` by (code review F6). */
	const TAB_WORDS: Record<RegisterTab, { label: string; empty: string }> = {
		'waiting-response': { label: 'Waiting for my response', empty: 'Nothing is waiting for your response.' },
		'waiting-ruling': { label: 'Waiting on me', empty: 'No decision is waiting on your ruling.' },
		open: { label: 'Open', empty: 'No decision you can see is open.' },
		ruled: { label: 'Ruled', empty: 'No decision you can see has been ruled.' },
		all: { label: 'All', empty: 'There is no decision you can see yet.' }
	};
	const TABS = REGISTER_TABS.map((id) => ({ id, ...TAB_WORDS[id] }));

	const current = $derived(TABS.find((tab) => tab.id === data.tab) ?? TABS[2]);
	const countOf = (tab: RegisterTab) =>
		tab === 'waiting-response' ? data.counts.waitingResponse : tab === 'waiting-ruling' ? data.counts.waitingRuling : null;

	/** An address of the register with these filters, each left out where it is not set. */
	function hrefWith(params: Record<string, string | number | null>): string {
		const search = new URLSearchParams();
		for (const [name, value] of Object.entries(params)) if (value !== null && value !== '') search.set(name, String(value));
		const text = search.toString();
		return text === '' ? '/decisions' : `/decisions?${text}`;
	}

	/** The filters a tab link carries: the board, the person and the title, never `status` (All's alone) or `before`. */
	const tabHref = (tab: RegisterTab) => hrefWith({ tab, board: data.query.board, person: data.query.person, q: data.query.q });

	/** The tabs as the kit draws them, a count on the waiting tabs alone. */
	const tabLinks = $derived(TABS.map((tab) => ({ id: tab.id, label: tab.label, href: tabHref(tab.id), count: countOf(tab.id) })));

	/** The filters this list was read with, for Next and Back to newest. */
	const kept = $derived({
		tab: data.tab,
		status: data.tab === 'all' ? data.query.status : null,
		board: data.query.board,
		person: data.query.person,
		q: data.query.q
	});

	const filtered = $derived(data.query.board !== null || data.query.person !== null || data.query.q !== null || (data.tab === 'all' && data.query.status !== null));

	const countWords = $derived(
		data.capped
			? `Showing the first ${data.rows.length} decisions.`
			: data.rows.length === 1
				? 'Showing 1 decision.'
				: `Showing ${data.rows.length} decisions${data.next !== null ? ', with more after them' : ''}.`
	);

	/** The person chosen, where the search's matches do not hold them, so that the form keeps the filter. */
	const chosenMissing = $derived(data.query.person !== null && !data.people.some((person) => person.id === data.query.person));

	onMount(() => connectLiveRefresh(() => invalidateAll(), undefined, { events: ['decision'] }));
</script>

<svelte:head>
	<title>Decisions — DumpFire</title>
	<meta name="robots" content="noindex" />
</svelte:head>


{#snippet crumbs()}
	<p class="crumb">Decisions</p>
{/snippet}

{#snippet actions()}
	<Button variant="ghost" size="sm" href="/decisions/tour" data-action="tour">How it works</Button>
	{#if data.myPersonId !== null}
		<Button variant="ghost" size="sm" href="/decisions/people/{data.myPersonId}" data-action="my-record">My record</Button>
	{/if}
{/snippet}

{#snippet filters()}
	<Card>
		<CardHeader><CardTitle level={2}>Filters</CardTitle></CardHeader>
		<CardContent>
			<form class="filters" method="GET" action="/decisions" data-form="filters">
				<input type="hidden" name="tab" value={data.tab} />
				<div class="filter">
					<label class="ui-label" for="filter-board">Board</label>
					<select id="filter-board" name="board" class="ui-select" value={data.query.board === null ? '' : String(data.query.board)}>
						<option value="">Any board</option>
						{#each data.boards as board (board.id)}
							<option value={String(board.id)}>{board.name}</option>
						{/each}
					</select>
				</div>
				<div class="filter">
					<label class="ui-label" for="filter-who">Find a person</label>
					<input id="filter-who" name="who" class="ui-input" type="search" maxlength="100" value={data.query.who ?? ''} />
				</div>
				<div class="filter">
					<label class="ui-label" for="filter-person">Person</label>
					<select id="filter-person" name="person" class="ui-select" value={data.query.person === null ? '' : String(data.query.person)}>
						<option value="">Anyone</option>
						{#if chosenMissing}<option value={String(data.query.person)}>The person chosen</option>{/if}
						{#each data.people as person (person.id)}
							<option value={String(person.id)}>{person.name}</option>
						{/each}
					</select>
				</div>
				{#if data.tab === 'all'}
					<div class="filter">
						<label class="ui-label" for="filter-status">Status</label>
						<select id="filter-status" name="status" class="ui-select" value={data.query.status ?? ''}>
							<option value="">Any status</option>
							{#each SHOWN_STATUSES as status (status)}
								<option value={status}>{STATUS_WORDS[status]}</option>
							{/each}
						</select>
					</div>
				{/if}
				<div class="filter">
					<label class="ui-label" for="filter-q">Title contains</label>
					<input id="filter-q" name="q" class="ui-input" type="search" maxlength="200" value={data.query.q ?? ''} />
				</div>
				<div class="filter-actions"><Button type="submit">Apply filters</Button></div>
			</form>
		</CardContent>
	</Card>
{/snippet}

<PageShell width="full" {crumbs} {actions} rail={filters} railLabel="Filters" railPosition="start">
	<PageHeader title="Decisions" description="Every decision you can see, across boards.">
		<Tabs label="Decision lists" items={tabLinks} current={data.tab} />
	</PageHeader>

	<p class="result-count" role="status" aria-live="polite" data-said="count">{countWords}</p>

	{#if data.rows.length === 0}
		{#if filtered}
			<EmptyState data-empty="filtered" title="No matches.">
				{#snippet action()}
					<Button variant="outline" size="sm" href={hrefWith({ tab: data.tab })}>Clear filters</Button>
				{/snippet}
			</EmptyState>
		{:else}
			<!-- Card 3070 (ruling 3): with nothing to list, the guided tour, which needs no decision of its own. -->
			<EmptyState data-empty={data.tab} title={current.empty}>
				New to decisions?
				{#snippet action()}
					<Button variant="link" size="sm" href="/decisions/tour" data-action="tour-empty">See how they work</Button>
				{/snippet}
			</EmptyState>
		{/if}
	{:else}
		<Table caption={current.label} stack>
			<thead>
				<tr>
					<th scope="col">Title</th>
					<th scope="col">Status</th>
					<th scope="col">Board</th>
					<th scope="col">Decider</th>
					<th scope="col">Closes</th>
					<th scope="col">Your part</th>
				</tr>
			</thead>
			<tbody>
				{#each data.rows as row (row.id)}
					<tr data-decision={row.id}>
						<td data-label="Title" class="title"><a class="row-link" href="/decisions/{row.id}">{row.title}</a></td>
						<td data-label="Status"><Badge status={row.shownStatus} /></td>
						<td data-label="Board">
							{#if row.board.id !== null}
								<a class="row-link quiet" href="/board/{row.board.id}">{row.board.name}</a>
							{:else}
								<span>{row.board.name}{row.board.gone ? ' (deleted)' : ''}</span>
							{/if}
						</td>
						<td data-label="Decider">{row.deciderName ?? '—'}</td>
						<td data-label="Closes" class="when">{shownMoment(row.closesAt, '—')}</td>
						<td data-label="Your part">
							{#if row.waiting === 'response'}<span class="waiting">Your response is awaited</span>
							{:else if row.waiting === 'ruling'}<span class="waiting">Your ruling is awaited</span>
							{:else if row.role !== null}{PARTICIPATION_ROLE_WORDS[row.role]}
							{:else}—{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</Table>
	{/if}

	{#if data.next !== null || data.query.before !== null}
		<nav class="pages" aria-label="Pages of decisions">
			{#if data.query.before !== null}<Button variant="outline" size="sm" href={hrefWith(kept)} data-page="newest">Back to newest</Button>{/if}
			{#if data.next !== null}<Button variant="outline" size="sm" href={hrefWith({ ...kept, before: data.next })} data-page="next">Older decisions</Button>{/if}
		</nav>
	{/if}
</PageShell>

<style>
	.crumb {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		font-weight: 500;
		color: var(--ui-foreground);
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

	.result-count {
		margin: 0 0 var(--space-sm);
		font-size: 0.875rem;
		color: var(--ui-muted-foreground);
	}

	.row-link {
		color: var(--ui-foreground);
		font-weight: 500;
		text-decoration: none;
		text-underline-offset: 3px;
		border-radius: var(--ui-radius-sm);
	}
	.row-link.quiet {
		font-weight: 400;
		color: var(--ui-muted-foreground);
	}
	.row-link:hover {
		color: var(--ui-foreground);
		text-decoration: underline;
	}
	.row-link:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}
	.when {
		white-space: nowrap;
		color: var(--ui-muted-foreground);
	}
	.waiting {
		font-weight: 600;
	}

	.pages {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		margin-top: var(--space-lg);
	}

	/* A finger needs 44px (D5). */
	@media (pointer: coarse) {
		.row-link {
			display: inline-flex;
			align-items: center;
			min-height: 2.75rem;
		}
	}
</style>
