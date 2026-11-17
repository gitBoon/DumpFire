<script lang="ts">
	/**
	 * ISO 27001:2022 Checklist — every Annex A control and clauses 4 to 10,
	 * read-only, for administrators (card 2670, plan D7).
	 *
	 * The items come from the page's load alone (`src/lib/server/iso-27001.ts`,
	 * server-only, plan D2): nothing here imports the checklist, so none of it
	 * is in a script anyone can fetch. The summary keeps the application's side
	 * apart from the organisation's. The three filters are the page's own
	 * state. Card numbers are text, never links: in another installation those
	 * ids mean another card or nothing. Evidence paths are text too.
	 */
	import type { PageData } from './$types';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';
	import { theme, themeIcon } from '$lib/stores/theme';

	type Item = PageData['items'][number];
	type Status = Item['status'];

	let { data }: { data: PageData } = $props();

	const STATUS_WORDS: Record<Status, string> = {
		met: 'Met',
		'partly-met': 'Partly met',
		'not-met': 'Not met',
		'not-applicable': 'Not applicable',
		organisational: 'Organisational'
	};
	const APPLICABILITY_WORDS: Record<Item['applicability'], string> = {
		app: 'DumpFire',
		supports: 'Supports',
		organisational: 'Organisational'
	};
	const THEME_WORDS: Record<string, string> = {
		organisational: 'A.5 Organisational',
		people: 'A.6 People',
		physical: 'A.7 Physical',
		technological: 'A.8 Technological',
		clauses: 'Clauses 4-10'
	};

	/**
	 * The statuses each side of the summary counts: the application never holds an organisational item,
	 * and only an organisational item is ever not applicable (the organisation's call, in its SoA).
	 */
	const APPLICATION_STATUSES: Status[] = ['met', 'partly-met', 'not-met'];
	const ORGANISATION_STATUSES: Status[] = ['organisational', 'not-applicable'];

	let status = $state<'all' | Status>('all');
	/** `application` is app and supports items together. */
	let applicability = $state<'all' | 'application' | Item['applicability']>('all');
	/** `clauses` is every clause 4 to 10, whose theme is null. */
	let themeChoice = $state<'all' | 'clauses' | NonNullable<Item['theme']>>('all');

	let listed = $derived(
		data.items.filter((item) => {
			if (status !== 'all' && item.status !== status) return false;
			if (applicability === 'application' ? item.applicability === 'organisational' : applicability !== 'all' && item.applicability !== applicability) return false;
			if (themeChoice === 'clauses' ? item.theme !== null : themeChoice !== 'all' && item.theme !== themeChoice) return false;
			return true;
		})
	);

	const total = (counts: Record<Status, number>) => Object.values(counts).reduce((sum, n) => sum + n, 0);
</script>

<svelte:head>
	<title>ISO 27001:2022 Checklist — DumpFire</title>
</svelte:head>

<div class="iso-page">
	<header class="admin-header glass">
		<div class="admin-header-inner">
			<a href="/" class="header-logo" title="Back to DumpFire">
				<span class="logo-fire">🔥</span>
				<span class="logo-text">DumpFire</span>
			</a>
			<h1 class="header-title">📋 ISO 27001:2022 Checklist</h1>
			<div class="admin-header-right">
				<a href="/admin" class="btn-ghost back-link">← Admin</a>
				<HeaderMenu label="Theme" triggerClass="btn-ghost" triggerTitle="Change theme">
					{#snippet trigger()}<span aria-hidden="true">{themeIcon($theme)}</span>{/snippet}
					<ThemeMenuItems heading={false} />
				</HeaderMenu>
			</div>
		</div>
	</header>

	<main class="admin-content">
		<section class="admin-card glass">
			<p class="intro">
				Every Annex A control of ISO/IEC 27001:2022 and clauses 4 to 10, with how far DumpFire meets each, the evidence in its code, and the cards that close
				what is still open. ISO 27001 certifies an organisation, not software: this is an input to the Statement of Applicability, not the statement itself and
				not a certificate. Checked against the code on <strong class="checked-on">{data.checkedOn}</strong>.
			</p>
			<div class="summary">
				<section class="summary-block" aria-labelledby="iso-application">
					<h2 id="iso-application">In the application</h2>
					<p class="summary-note">What DumpFire implements, alone or in part ({total(data.summary.application)} items)</p>
					<ul>
						{#each APPLICATION_STATUSES as s (s)}
							<li><span class="chip status-{s}">{STATUS_WORDS[s]}</span> <strong>{data.summary.application[s]}</strong></li>
						{/each}
					</ul>
				</section>
				<section class="summary-block" aria-labelledby="iso-organisation">
					<h2 id="iso-organisation">The organisation's</h2>
					<p class="summary-note">People, places, policy and the management system ({total(data.summary.organisation)} items)</p>
					<ul>
						{#each ORGANISATION_STATUSES as s (s)}
							<li><span class="chip status-{s}">{STATUS_WORDS[s]}</span> <strong>{data.summary.organisation[s]}</strong></li>
						{/each}
					</ul>
				</section>
			</div>
		</section>

		<section class="admin-card glass">
			<div class="filters">
				<label>
					Status
					<select class="form-input" bind:value={status}>
						<option value="all">All</option>
						{#each Object.entries(STATUS_WORDS) as [value, label] (value)}
							<option {value}>{label}</option>
						{/each}
					</select>
				</label>
				<label>
					Applicability
					<select class="form-input" bind:value={applicability}>
						<option value="all">All</option>
						<option value="application">Application (DumpFire and Supports)</option>
						{#each Object.entries(APPLICABILITY_WORDS) as [value, label] (value)}
							<option {value}>{label}</option>
						{/each}
					</select>
				</label>
				<label>
					Theme
					<select class="form-input" bind:value={themeChoice}>
						<option value="all">All</option>
						{#each Object.entries(THEME_WORDS) as [value, label] (value)}
							<option {value}>{label}</option>
						{/each}
					</select>
				</label>
				<span class="shown" aria-live="polite">{listed.length} of {data.items.length} shown</span>
			</div>

			{#if listed.length === 0}
				<p class="empty-msg">Nothing matches.</p>
			{:else}
				<div class="table-wrap">
					<table class="iso-table">
						<thead>
							<tr>
								<th>Ref</th>
								<th>Title</th>
								<th>Applicability</th>
								<th>Status</th>
								<th>How DumpFire meets it</th>
								<th>Evidence</th>
								<th>The organisation's part</th>
								<th>Owner</th>
								<th>Gap cards</th>
							</tr>
						</thead>
						<tbody>
							{#each listed as item (item.kind + item.ref)}
								<tr>
									<td class="ref">{item.kind === 'clause' ? `Clause ${item.ref}` : item.ref}</td>
									<td class="title">{item.title}</td>
									<td>{APPLICABILITY_WORDS[item.applicability]}</td>
									<td><span class="chip status-{item.status}">{STATUS_WORDS[item.status]}</span></td>
									<td class="how">
										{item.how}
										{#if item.reason}<br /><em>Not applicable: {item.reason}</em>{/if}
									</td>
									<td class="evidence">
										{#each item.evidence as e, i (i)}
											<div><code>{e.path}{e.anchor ? `#${e.anchor}` : ''}</code>{#if e.symbol} <code>{e.symbol}</code>{/if}</div>
										{/each}
									</td>
									<td>{item.organisationalPart ?? '—'}</td>
									<td class="owner">{item.owner}</td>
									<td class="gaps">
										{#each item.gapCards as card (card)}
											<span class="card-no">#{card}</span>
										{/each}
										{#each item.accepted ?? [] as risk (risk.risk)}
											<div class="accepted">Accepted: {risk.risk} (<code>{risk.path}#{risk.anchor}</code>)</div>
										{/each}
										{#if item.gapCards.length === 0 && !item.accepted?.length}—{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	</main>
</div>

<style>
	.iso-page { min-height: 100vh; padding-top: 64px; }

	.admin-header {
		position: fixed; top: 0; left: 0; right: 0; z-index: 200;
		height: 64px; border-bottom: 1px solid var(--glass-border);
		backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
	}
	.admin-header-inner {
		max-width: 1400px; margin: 0 auto; height: 100%;
		display: flex; align-items: center; justify-content: space-between;
		padding: 0 var(--space-xl);
	}
	.header-logo {
		display: flex; align-items: center; gap: var(--space-sm);
		text-decoration: none; color: var(--text-primary);
		font-weight: 700; font-size: 1.1rem;
	}
	.logo-fire { font-size: 1.4rem; }
	.header-title { font-size: 1rem; font-weight: 700; color: var(--text-primary); letter-spacing: -0.01em; }
	.admin-header-right { display: flex; align-items: center; gap: var(--space-sm); }
	.back-link { text-decoration: none; font-size: 0.82rem; }

	/* The page's last line stops above the user badge (card 2239). */
	.admin-content {
		max-width: 1400px; margin: 0 auto; padding: var(--space-2xl) var(--space-2xl) var(--user-badge-space);
		display: flex; flex-direction: column; gap: var(--space-xl);
	}
	.admin-card { padding: var(--space-xl); border-radius: var(--radius-lg); min-width: 0; }
	.intro { font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5; margin-bottom: var(--space-lg); }
	.empty-msg { font-size: 0.85rem; color: var(--text-tertiary); text-align: center; padding: var(--space-xl); }

	.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-lg); }
	.summary-block {
		padding: var(--space-lg); background: var(--bg-base);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
	}
	.summary-block h2 { font-size: 1rem; margin-bottom: var(--space-xs); }
	.summary-note { font-size: 0.75rem; color: var(--text-tertiary); margin-bottom: var(--space-sm); }
	.summary-block ul { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: var(--space-sm) var(--space-lg); }
	.summary-block li { display: flex; align-items: center; gap: var(--space-xs); font-size: 0.85rem; }

	.filters { display: flex; gap: var(--space-md); align-items: flex-end; flex-wrap: wrap; margin-bottom: var(--space-lg); }
	.filters label { display: flex; flex-direction: column; gap: var(--space-xs); font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); }
	.form-input {
		padding: var(--space-sm) var(--space-md);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-elevated); color: var(--text-primary);
		font-size: 0.82rem; font-family: var(--font-family);
	}
	.form-input:focus { border-color: var(--accent-indigo); outline: none; }
	.shown { font-size: 0.75rem; color: var(--text-tertiary); margin-left: auto; }

	/* The table scrolls inside its own box; the page never scrolls sideways. */
	.table-wrap { overflow-x: auto; max-width: 100%; }
	.iso-table { width: 100%; min-width: 1100px; border-collapse: collapse; font-size: 0.8rem; }
	.iso-table th {
		text-align: left; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
		color: var(--text-tertiary); padding: var(--space-xs) var(--space-sm); border-bottom: 1px solid var(--glass-border);
	}
	.iso-table td { padding: var(--space-sm); border-bottom: 1px solid var(--glass-border); vertical-align: top; line-height: 1.4; }
	.iso-table td.ref { font-weight: 600; white-space: nowrap; }
	.iso-table td.title { font-weight: 600; min-width: 140px; }
	.iso-table td.how { min-width: 260px; }
	.iso-table td.owner { white-space: nowrap; }
	.evidence div { margin-bottom: 2px; }
	.evidence code, .accepted code { font-size: 0.72rem; overflow-wrap: anywhere; }
	.card-no { display: inline-block; margin-right: var(--space-xs); font-weight: 600; white-space: nowrap; }
	.accepted { font-size: 0.72rem; color: var(--text-secondary); margin-top: 2px; }

	.chip {
		display: inline-block; padding: 1px var(--space-sm); border-radius: 999px;
		font-size: 0.7rem; font-weight: 600; white-space: nowrap;
	}
	.status-met { background: rgba(34, 197, 94, 0.14); color: var(--accent-emerald, #22c55e); }
	.status-partly-met { background: rgba(245, 158, 11, 0.14); color: var(--accent-amber); }
	.status-not-met { background: rgba(244, 63, 94, 0.14); color: var(--accent-rose); }
	.status-not-applicable { background: var(--bg-elevated); color: var(--text-tertiary); }
	.status-organisational { background: rgba(99, 102, 241, 0.12); color: var(--accent-indigo); }

	@media (max-width: 640px) {
		.admin-content { padding-left: var(--space-md); padding-right: var(--space-md); }
		.admin-card { padding: var(--space-md); }
		.shown { margin-left: 0; }
	}
</style>
