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
	 * their account holds a person of the directory (code review F1).
	 *
	 * The page re-reads on a `decision` event (`connectLiveRefresh`, decision
	 * 26), which reaches a caller only for a board they can open: a decision
	 * with no board, or a participant's on a board they cannot open, is
	 * current on navigation, a return to the tab, or a reconnect.
	 */
	import { onMount } from 'svelte';
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';
	import { REGISTER_TABS, SHOWN_STATUSES, type RegisterTab } from '$lib/decision-register-types';
	import { PARTICIPATION_ROLE_WORDS, STATUS_WORDS, shownMoment } from '$lib/decision-words';
	import { connectLiveRefresh } from '$lib/live-refresh';
	import { theme, themeIcon } from '$lib/stores/theme';

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

<div class="register-page">
	<header class="register-header glass">
		<div class="register-header-inner">
			<a href="/" class="header-logo" title="Back to DumpFire">
				<span class="logo-fire">🔥</span>
				<span class="logo-text">DumpFire</span>
			</a>
			<p class="crumb">Decisions</p>
			{#if data.myPersonId !== null}
				<a class="target my-record" href="/decisions/people/{data.myPersonId}" data-action="my-record">My record</a>
			{/if}
			<HeaderMenu label="Theme" triggerClass="btn-ghost" triggerTitle="Change theme">
				{#snippet trigger()}<span aria-hidden="true">{themeIcon($theme)}</span>{/snippet}
				<ThemeMenuItems heading={false} />
			</HeaderMenu>
		</div>
	</header>

	<main class="register-content">
		<h1>Decisions</h1>

		<nav class="tabs" aria-label="Decision lists">
			{#each TABS as tab (tab.id)}
				{@const count = countOf(tab.id)}
				<a class="tab" href={tabHref(tab.id)} aria-current={data.tab === tab.id ? 'page' : undefined} data-tab={tab.id}>
					{tab.label}{#if count !== null}<span class="tab-count">{` (${count})`}</span>{/if}
				</a>
			{/each}
		</nav>

		<form class="filters glass" method="GET" action="/decisions" data-form="filters">
			<input type="hidden" name="tab" value={data.tab} />
			<div class="filter">
				<label for="filter-board">Board</label>
				<select id="filter-board" name="board" class="field" value={data.query.board === null ? '' : String(data.query.board)}>
					<option value="">Any board</option>
					{#each data.boards as board (board.id)}
						<option value={String(board.id)}>{board.name}</option>
					{/each}
				</select>
			</div>
			<div class="filter">
				<label for="filter-who">Find a person</label>
				<input id="filter-who" name="who" class="field" type="search" maxlength="100" value={data.query.who ?? ''} />
			</div>
			<div class="filter">
				<label for="filter-person">Person</label>
				<select id="filter-person" name="person" class="field" value={data.query.person === null ? '' : String(data.query.person)}>
					<option value="">Anyone</option>
					{#if chosenMissing}<option value={String(data.query.person)}>The person chosen</option>{/if}
					{#each data.people as person (person.id)}
						<option value={String(person.id)}>{person.name}</option>
					{/each}
				</select>
			</div>
			{#if data.tab === 'all'}
				<div class="filter">
					<label for="filter-status">Status</label>
					<select id="filter-status" name="status" class="field" value={data.query.status ?? ''}>
						<option value="">Any status</option>
						{#each SHOWN_STATUSES as status (status)}
							<option value={status}>{STATUS_WORDS[status]}</option>
						{/each}
					</select>
				</div>
			{/if}
			<div class="filter">
				<label for="filter-q">Title contains</label>
				<input id="filter-q" name="q" class="field" type="search" maxlength="200" value={data.query.q ?? ''} />
			</div>
			<div class="filter-actions">
				<button type="submit" class="btn-primary target">Apply filters</button>
			</div>
		</form>

		<p class="result-count" role="status" aria-live="polite" data-said="count">{countWords}</p>

		{#if data.rows.length === 0}
			{#if filtered}
				<p class="empty" data-empty="filtered">No matches. <a class="target" href={hrefWith({ tab: data.tab })}>Clear filters</a></p>
			{:else}
				<p class="empty" data-empty={data.tab}>{current.empty}</p>
			{/if}
		{:else}
			<table class="register-table">
				<caption>{current.label}</caption>
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
							<td data-label="Title" class="title"><a class="target" href="/decisions/{row.id}">{row.title}</a></td>
							<td data-label="Status"><span class="status-chip" data-status={row.shownStatus}>{STATUS_WORDS[row.shownStatus] ?? row.shownStatus}</span></td>
							<td data-label="Board">
								{#if row.board.id !== null}
									<a class="target" href="/board/{row.board.id}">{row.board.name}</a>
								{:else}
									<span>{row.board.name}{row.board.gone ? ' (deleted)' : ''}</span>
								{/if}
							</td>
							<td data-label="Decider">{row.deciderName ?? '—'}</td>
							<td data-label="Closes">{shownMoment(row.closesAt, '—')}</td>
							<td data-label="Your part">
								{#if row.waiting === 'response'}<span class="waiting">Your response is awaited</span>
								{:else if row.waiting === 'ruling'}<span class="waiting">Your ruling is awaited</span>
								{:else if row.role !== null}{PARTICIPATION_ROLE_WORDS[row.role]}
								{:else}—{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}

		{#if data.next !== null || data.query.before !== null}
			<nav class="pages" aria-label="Pages of decisions">
				{#if data.query.before !== null}<a class="target" href={hrefWith(kept)} data-page="newest">Back to newest</a>{/if}
				{#if data.next !== null}<a class="target" href={hrefWith({ ...kept, before: data.next })} data-page="next">Older decisions</a>{/if}
			</nav>
		{/if}
	</main>
</div>

<style>
	.register-page { min-height: 100vh; padding-top: 64px; }
	.register-header {
		position: fixed; top: 0; left: 0; right: 0; z-index: 200;
		height: 64px; border-bottom: 1px solid var(--glass-border);
		backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
	}
	.register-header-inner {
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
	.crumb { flex: 1; font-size: 0.85rem; min-width: 0; margin: 0; color: var(--text-secondary); }
	.my-record { font-size: 0.9rem; color: var(--accent-indigo); text-decoration: none; white-space: nowrap; }

	/* The page's last line stops above the user badge (card 2239). */
	.register-content { max-width: 1100px; margin: 0 auto; padding: var(--space-xl) var(--space-xl) var(--user-badge-space); }
	h1 { font-size: 1.2rem; margin: 0 0 var(--space-md); }

	.tabs { display: flex; flex-wrap: wrap; gap: var(--space-xs); margin-bottom: var(--space-md); }
	.tab {
		min-height: 44px; display: inline-flex; align-items: center; padding: 0 var(--space-md);
		border-radius: var(--radius-sm); text-decoration: none; color: var(--text-secondary); border: 1px solid var(--glass-border);
	}
	.tab[aria-current='page'] { color: var(--text-primary); font-weight: 600; border-color: var(--accent-indigo); background: rgba(99, 102, 241, 0.12); }
	.tab:focus-visible, .target:focus-visible, .field:focus-visible { outline: 2px solid var(--accent-indigo); outline-offset: 2px; }

	.filters { display: flex; flex-wrap: wrap; gap: var(--space-md); align-items: flex-end; padding: var(--space-md); border-radius: var(--radius-md); margin-bottom: var(--space-md); }
	.filter { display: flex; flex-direction: column; gap: var(--space-xs); min-width: 10rem; flex: 1; }
	.filter label { font-size: 0.85rem; color: var(--text-secondary); }
	.field {
		min-height: 44px; box-sizing: border-box; font-size: 16px; font-family: var(--font-family); padding: 0 var(--space-sm);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm); background: var(--bg-elevated); color: var(--text-primary);
	}
	.filter-actions { display: flex; }
	.target { min-height: 44px; display: inline-flex; align-items: center; }
	button.target { padding: 0 var(--space-lg); }

	.result-count { font-size: 0.9rem; color: var(--text-secondary); margin: 0 0 var(--space-sm); }
	.empty { font-size: 0.95rem; color: var(--text-tertiary); padding: var(--space-lg) 0; margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm); }

	.register-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
	.register-table caption { text-align: left; font-weight: 600; padding: var(--space-xs) 0; }
	.register-table th {
		text-align: left; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
		color: var(--text-tertiary); padding: var(--space-xs) var(--space-sm); border-bottom: 1px solid var(--glass-border);
	}
	.register-table td { padding: var(--space-xs) var(--space-sm); border-bottom: 1px solid var(--glass-border); vertical-align: middle; overflow-wrap: anywhere; }
	.register-table td.title { font-weight: 600; }
	.register-table a { color: var(--accent-indigo); text-decoration: none; }
	.status-chip { display: inline-block; padding: 1px var(--space-sm); border-radius: 999px; font-size: 0.75rem; background: rgba(99, 102, 241, 0.12); color: var(--accent-indigo); }
	.waiting { font-weight: 600; }

	.pages { display: flex; flex-wrap: wrap; gap: var(--space-lg); margin-top: var(--space-md); }
	.pages a { color: var(--accent-indigo); text-decoration: none; }

	@media (max-width: 640px) {
		.register-header-inner { padding: 0 var(--space-md); }
		.logo-text { display: none; }
		.register-content { padding: var(--space-md) var(--space-md) var(--user-badge-space); }
		/* Each row a block, each cell with its label (D5). */
		.register-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
		.register-table, .register-table tbody, .register-table tr, .register-table td { display: block; width: 100%; box-sizing: border-box; }
		.register-table tr { border-bottom: 1px solid var(--glass-border); padding: var(--space-sm) 0; }
		.register-table td { border-bottom: none; display: flex; gap: var(--space-sm); align-items: center; min-height: 44px; }
		.register-table td::before { content: attr(data-label); flex: 0 0 6.5rem; font-size: 0.75rem; font-weight: 600; color: var(--text-tertiary); }
	}
</style>
