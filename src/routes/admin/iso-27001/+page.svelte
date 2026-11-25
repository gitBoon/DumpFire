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
	 *
	 * Card 3076: on the kit's shell, full width, with "Admin" in the header's
	 * crumbs; the two summaries side by side as cards of figures; the filters
	 * and the count above the table, whose statuses are coloured badges and
	 * whose rows are labelled blocks on a phone.
	 */
	import type { PageData } from './$types';
	import PageShell from '$lib/components/ui/PageShell.svelte';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import CardContent from '$lib/components/ui/CardContent.svelte';
	import CardDescription from '$lib/components/ui/CardDescription.svelte';
	import CardHeader from '$lib/components/ui/CardHeader.svelte';
	import CardTitle from '$lib/components/ui/CardTitle.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Stat from '$lib/components/ui/Stat.svelte';
	import Table from '$lib/components/ui/Table.svelte';
	import '$lib/components/admin/admin.css';
	// Card 2922 (R7): the superadmin's banner while a setting is held for review.
	import SettingsHeldBanner from '$lib/components/SettingsHeldBanner.svelte';

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
	/** Each status's badge (card 3076): its tone, the words in the text colour. */
	const STATUS_BADGES: Record<Status, 'success' | 'warning' | 'destructive' | 'outline' | 'secondary'> = {
		met: 'success',
		'partly-met': 'warning',
		'not-met': 'destructive',
		'not-applicable': 'outline',
		organisational: 'secondary'
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

{#snippet crumbs()}
	<nav class="admin-crumb" aria-label="Where this is">
		<a href="/admin">Admin</a>
		<span aria-hidden="true">/</span>
		<span>ISO 27001:2022 Checklist</span>
	</nav>
{/snippet}

<PageShell width="full" {crumbs}>
	<SettingsHeldBanner held={data.settingsHeld} superadmin={data.user?.role === 'superadmin'} />
	<PageHeader
		title="ISO 27001:2022 Checklist"
		description="Every Annex A control of ISO/IEC 27001:2022 and clauses 4 to 10, with how far DumpFire meets each, the evidence in its code, and the cards that close what is still open. ISO 27001 certifies an organisation, not software: this is an input to the Statement of Applicability, not the statement itself and not a certificate."
	>
		<p class="checked">Checked against the code on <strong class="checked-on">{data.checkedOn}</strong>.</p>
	</PageHeader>

	<div class="page-sections">
		<div class="summary">
			<Card as="section" aria-labelledby="iso-application">
				<CardHeader>
					<CardTitle level={2} id="iso-application">In the application</CardTitle>
					<CardDescription>What DumpFire implements, alone or in part ({total(data.summary.application)} items)</CardDescription>
				</CardHeader>
				<CardContent>
					<div class="summary-stats">
						{#each APPLICATION_STATUSES as s (s)}
							<Stat label={STATUS_WORDS[s]} value={data.summary.application[s]} />
						{/each}
					</div>
				</CardContent>
			</Card>
			<Card as="section" aria-labelledby="iso-organisation">
				<CardHeader>
					<CardTitle level={2} id="iso-organisation">The organisation's</CardTitle>
					<CardDescription>People, places, policy and the management system ({total(data.summary.organisation)} items)</CardDescription>
				</CardHeader>
				<CardContent>
					<div class="summary-stats">
						{#each ORGANISATION_STATUSES as s (s)}
							<Stat label={STATUS_WORDS[s]} value={data.summary.organisation[s]} />
						{/each}
					</div>
				</CardContent>
			</Card>
		</div>

		<Card>
			<CardContent>
				<div class="filters">
					<label class="ui-label">
						Status
						<select class="ui-select" bind:value={status}>
							<option value="all">All</option>
							{#each Object.entries(STATUS_WORDS) as [value, label] (value)}
								<option {value}>{label}</option>
							{/each}
						</select>
					</label>
					<label class="ui-label">
						Applicability
						<select class="ui-select" bind:value={applicability}>
							<option value="all">All</option>
							<option value="application">Application (DumpFire and Supports)</option>
							{#each Object.entries(APPLICABILITY_WORDS) as [value, label] (value)}
								<option {value}>{label}</option>
							{/each}
						</select>
					</label>
					<label class="ui-label">
						Theme
						<select class="ui-select" bind:value={themeChoice}>
							<option value="all">All</option>
							{#each Object.entries(THEME_WORDS) as [value, label] (value)}
								<option {value}>{label}</option>
							{/each}
						</select>
					</label>
					<span class="shown" aria-live="polite">{listed.length} of {data.items.length} shown</span>
				</div>

				{#if listed.length === 0}
					<EmptyState title="Nothing matches." />
				{:else}
					<Table caption="Controls and clauses" captionHidden stack>
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
									<td class="ref" data-label="Ref">{item.kind === 'clause' ? `Clause ${item.ref}` : item.ref}</td>
									<td class="title" data-label="Title">{item.title}</td>
									<td data-label="Applicability">{APPLICABILITY_WORDS[item.applicability]}</td>
									<td data-label="Status"><Badge variant={STATUS_BADGES[item.status]}>{STATUS_WORDS[item.status]}</Badge></td>
									<td class="how" data-label="How">
										<span>
											{item.how}
											{#if item.reason}<br /><em>Not applicable: {item.reason}</em>{/if}
										</span>
									</td>
									<td class="evidence" data-label="Evidence">
										<span>
											{#each item.evidence as e, i (i)}
												<span class="evidence-line"><code>{e.path}{e.anchor ? `#${e.anchor}` : ''}</code>{#if e.symbol} <code>{e.symbol}</code>{/if}</span>
											{/each}
										</span>
									</td>
									<td data-label="Organisation">{item.organisationalPart ?? '—'}</td>
									<td class="owner" data-label="Owner">{item.owner}</td>
									<td class="gaps" data-label="Gap cards">
										<span>
											{#each item.gapCards as card (card)}
												<span class="card-no">#{card}</span>
											{/each}
											{#each item.accepted ?? [] as risk (risk.risk)}
												<span class="accepted">Accepted: {risk.risk} (<code>{risk.path}#{risk.anchor}</code>)</span>
											{/each}
											{#if item.gapCards.length === 0 && !item.accepted?.length}—{/if}
										</span>
									</td>
								</tr>
							{/each}
						</tbody>
					</Table>
				{/if}
			</CardContent>
		</Card>
	</div>
</PageShell>

<style>
	.page-sections {
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
	}
	.checked {
		margin: calc(-1 * var(--space-sm)) 0 0;
		font-size: 0.8125rem;
		color: var(--ui-muted-foreground);
	}
	.checked strong {
		font-weight: 500;
		color: var(--ui-foreground);
	}

	/* The two summaries side by side, each a row of figures. */
	.summary {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(20rem, 100%), 1fr));
		gap: var(--space-lg);
	}
	.summary-stats {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
		gap: var(--space-md);
	}

	/* The three filters and the count, in a bar above the table. */
	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-md);
		margin-bottom: var(--space-md);
	}
	.filters label {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		flex: 1 1 12rem;
		max-width: 20rem;
	}
	.shown {
		margin-left: auto;
		font-size: 0.8125rem;
		color: var(--ui-muted-foreground);
	}

	td {
		vertical-align: top;
		line-height: 1.45;
	}
	td.ref {
		font-weight: 600;
		white-space: nowrap;
	}
	td.title {
		font-weight: 500;
	}
	td.owner {
		white-space: nowrap;
	}
	.evidence-line {
		display: block;
		margin-bottom: 2px;
	}
	.evidence code,
	.accepted code {
		font-size: 0.75rem;
		overflow-wrap: anywhere;
	}
	.card-no {
		display: inline-block;
		margin-right: var(--space-xs);
		font-weight: 600;
		white-space: nowrap;
	}
	.accepted {
		display: block;
		margin-top: 2px;
		font-size: 0.75rem;
		color: var(--ui-muted-foreground);
	}

	/* From 641px the columns keep their widths, and the table's frame scrolls sideways; the page never does. */
	@media (min-width: 641px) {
		td.title {
			min-width: 140px;
		}
		td.how {
			min-width: 260px;
		}
	}
	@media (max-width: 640px) {
		.filters label {
			max-width: none;
		}
		.shown {
			margin-left: 0;
		}
		td.ref,
		td.owner {
			white-space: normal;
		}
	}
</style>