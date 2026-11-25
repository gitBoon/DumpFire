<script lang="ts">
	/**
	 * People Directory — the admin page that keeps who can be consulted on or
	 * told of a decision, with an account or without one, and their groups
	 * (card 2674, plan 4.3).
	 *
	 * Every change is sent to the admin-only routes under `/api/people` and
	 * `/api/people-groups`, a refusal is said in the server's words (`sent`),
	 * and the page's data is read again after each one.
	 *
	 * Deleting a person asks for the caller's own password in its confirmation
	 * (card 2697's code review, part B, S1): it ends their personal decision
	 * links and frees their address. A refusal of the password keeps the dialog
	 * open, its words in it and the field cleared (`sentAsking`).
	 *
	 * Mark active asks for the password and a code too (card 3020, R6): it
	 * lets the person be mailed about decisions again, at an address a backup
	 * whose seal did not verify may have chosen. Its confirmation, a danger
	 * button, names them through `printable` and shows the address through
	 * `asciiShown`, and sends that address back as `reviewedEmail`, so that the
	 * server refuses it if the address has changed since (its code review,
	 * FP5). Mark left sends `{ status: 'left' }` alone and asks nothing.
	 *
	 * A person who is not active is shown with their name through `printable`
	 * and their address through `asciiShown` (R3), and the status as stored:
	 * one neither active nor left is shown as it is, through `asciiShown`, and
	 * never as Active (R8).
	 *
	 * Card 3076: on the kit's shell, full width, with "Admin" in the
	 * header's crumbs; Add from accounts and + Add person beside the title;
	 * the people and the groups each a table in a card, labelled rows on a
	 * phone; the Active / Left / All filter the kit's segmented control.
	 */
	import type { PageData } from './$types';
	import PageShell from '$lib/components/ui/PageShell.svelte';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import CardContent from '$lib/components/ui/CardContent.svelte';
	import CardHeader from '$lib/components/ui/CardHeader.svelte';
	import CardTitle from '$lib/components/ui/CardTitle.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import Table from '$lib/components/ui/Table.svelte';
	import '$lib/components/admin/admin.css';
	import Toast from '$lib/components/Toast.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import PersonDialog from '$lib/components/admin/people/PersonDialog.svelte';
	import GroupDialog from '$lib/components/admin/people/GroupDialog.svelte';
	import FromAccountsDialog from '$lib/components/admin/people/FromAccountsDialog.svelte';
	import { invalidateAll } from '$app/navigation';
	import { answerBody } from '$lib/api';
	import { sent, sentAsking, showToast } from '$lib/admin/send';
	import { asksForPassword, type StepUpProof } from '$lib/step-up-words';
	import { asciiShown, printable } from '$lib/printable';
	// Card 2922 (R7): the superadmin's banner while a setting is held for review.
	import SettingsHeldBanner from '$lib/components/SettingsHeldBanner.svelte';

	type Person = PageData['people'][number];
	type Group = PageData['groups'][number];

	let { data }: { data: PageData } = $props();

	let search = $state('');
	let show = $state<'active' | 'left' | 'all'>('active');

	let groupName = $derived(new Map(data.groups.map((g) => [g.id, g.name])));

	/** The people the search and the filter leave: over name, email, job title and group names. */
	let listed = $derived.by(() => {
		const needle = search.trim().toLowerCase();
		return data.people.filter((p) => {
			if (show !== 'all' && p.status !== show) return false;
			if (needle === '') return true;
			const groups = p.groupIds.map((id) => groupName.get(id) ?? '');
			return [p.fullName, p.email, p.jobTitle, ...groups].some((text) => text.toLowerCase().includes(needle));
		});
	});

	let activeIds = $derived(new Set(data.people.filter((p) => p.status === 'active').map((p) => p.id)));

	/** The dialog open: a person's (null to add one), a group's (null to add one), or Add from accounts. */
	let editingPerson = $state<{ person: Person | null } | null>(null);
	let editingGroup = $state<{ group: Group | null } | null>(null);
	let addingFromAccounts = $state(false);

	/**
	 * The confirm open, for a delete: `askPassword` where the server asks for
	 * the caller's password, and the action handed what was typed. Words given
	 * back are a refusal of the password, which the dialog shows and stays open
	 * for.
	 */
	let confirmAction = $state<{
		title: string;
		message: string;
		confirmText: string;
		confirmDanger?: boolean;
		askPassword?: boolean;
		action: (proof: StepUpProof) => Promise<string | void>;
	} | null>(null);

	/** The person whose Mark left is out: a second press meanwhile sends nothing. Mark active is its confirmation's, which holds its own. */
	let marking = $state<number | null>(null);

	/** A person's name as the page shows it: through `printable` for one who is not active (card 3020, R3). */
	const nameOf = (person: Person) => (person.status === 'active' ? person.fullName : printable(person.fullName));
	/** Their address as the page shows it: through `asciiShown` for one who is not active (R3). */
	const addressOf = (person: Person) => (person.status === 'active' ? person.email : asciiShown(person.email));
	/** Their status as stored (R8): Left with its day, Active, or any other value shown as it is. */
	const statusOf = (person: Person) =>
		person.status === 'left' ? `Left${person.leftAt ? ` ${person.leftAt.slice(0, 10)}` : ''}` : person.status === 'active' ? 'Active' : asciiShown(person.status);

	/** Mark left: `{ status: 'left' }` alone, which asks nothing. */
	async function markLeft(person: Person) {
		if (marking !== null) return;
		marking = person.id;
		try {
			const res = await sent(
				() => fetch(`/api/people/${person.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'left' }) }),
				'The person was not marked left'
			);
			if (!res) return;
			await invalidateAll();
			showToast(`${nameOf(person)} marked left`);
		} finally {
			marking = null;
		}
	}

	/**
	 * Mark active (card 3020, R6): a confirmation that names the person and
	 * shows the address their mail goes to again, and asks for the password
	 * and a code, sent with `{ status: 'active' }` and the address shown as
	 * `reviewedEmail` (FP5).
	 */
	function askMarkActive(person: Person) {
		const name = printable(person.fullName);
		confirmAction = {
			title: 'Mark Active',
			message:
				`Mark ${name} active? Their decision mail and personal links go to ${asciiShown(person.email)} again. ` +
				'Check it is their address before you do. ' +
				asksForPassword(data.codeAsked),
			confirmText: 'Mark active',
			confirmDanger: true,
			askPassword: true,
			action: async (proof: StepUpProof) => {
				const res = await sentAsking(
					() =>
						fetch(`/api/people/${person.id}`, {
							method: 'PUT',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								status: 'active',
								reviewedEmail: person.email,
								currentPassword: proof.currentPassword,
								currentCode: proof.currentCode
							})
						}),
					'The person was not marked active'
				);
				// A refusal of the password itself: the dialog stays, its words shown.
				if (typeof res === 'string') return res;
				confirmAction = null;
				if (!res) return;
				await invalidateAll();
				showToast(`${name} marked active`);
			}
		};
	}

	/**
	 * What Delete says before it is done (plan decision 3 and review R9): what
	 * it removes, what it does not erase, and that Mark left can be undone.
	 */
	function deletePersonMessage(person: Person): string {
		return (
			`Delete ${nameOf(person)} from the directory? This cannot be undone. ` +
			'Their group memberships go with them and their personal decision links stop working. ' +
			'Decision records keep what they recorded of them (name, address, job title and groups), and the system log and backups still hold their name. ' +
			'Mark left keeps them in the directory and can be undone. ' +
			asksForPassword(data.codeAsked)
		);
	}

	function askDeletePerson(person: Person) {
		confirmAction = {
			title: 'Delete Person',
			message: deletePersonMessage(person),
			confirmText: 'Delete',
			askPassword: true,
			action: async (proof: StepUpProof) => {
				const res = await sentAsking(
					() =>
						fetch(`/api/people/${person.id}`, {
							method: 'DELETE',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ currentPassword: proof.currentPassword, currentCode: proof.currentCode })
						}),
					'The person was not deleted'
				);
				// A refusal of the password itself: the dialog stays, its words shown.
				if (typeof res === 'string') return res;
				confirmAction = null;
				if (!res) return;
				const answer = await answerBody(res);
				const cleared = typeof answer?.linksCleared === 'number' ? answer.linksCleared : 0;
				await invalidateAll();
				showToast(cleared > 0 ? `${nameOf(person)} deleted; ${cleared} decision link${cleared === 1 ? '' : 's'} cleared` : `${nameOf(person)} deleted`);
			}
		};
	}

	function askDeleteGroup(group: Group) {
		confirmAction = {
			title: 'Delete Group',
			message:
				`Delete the group "${group.name}"? This cannot be undone. Its ${group.personIds.length} ${group.personIds.length === 1 ? 'person stays' : 'people stay'} in the directory; only the group and its memberships go. ` +
				'Decision records keep the group names they recorded.',
			confirmText: 'Delete',
			action: async () => {
				confirmAction = null;
				if (!(await sent(() => fetch(`/api/people-groups/${group.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }), 'The group was not deleted'))) return;
				await invalidateAll();
				showToast(`Group "${group.name}" deleted`);
			}
		};
	}
</script>

<svelte:head>
	<title>People Directory — DumpFire</title>
</svelte:head>

{#snippet crumbs()}
	<nav class="admin-crumb" aria-label="Where this is">
		<a href="/admin">Admin</a>
		<span aria-hidden="true">/</span>
		<span>People Directory</span>
	</nav>
{/snippet}

<PageShell width="full" {crumbs}>
	<SettingsHeldBanner held={data.settingsHeld} superadmin={data.user?.role === 'superadmin'} />
	<PageHeader title="People Directory" description="Who can be consulted on or told of a decision, with an account or without one, and their groups.">
		{#snippet actions()}
			<Button variant="outline" onclick={() => (addingFromAccounts = true)}>Add from accounts</Button>
			<Button onclick={() => (editingPerson = { person: null })}>+ Add person</Button>
		{/snippet}
	</PageHeader>

	<div class="page-sections">
		<!-- People -->
		<Card as="section" aria-labelledby="people-title">
			<CardHeader>
				<CardTitle level={2} id="people-title">People</CardTitle>
			</CardHeader>
			<CardContent>
				<div class="people-toolbar">
					<input type="search" class="ui-input people-search" placeholder="Search name, email, job title or group" aria-label="Search people" bind:value={search} />
					<SegmentedControl
						label="Show"
						options={[
							{ value: 'active', label: 'Active' },
							{ value: 'left', label: 'Left' },
							{ value: 'all', label: 'All' }
						]}
						bind:value={show}
						size="sm"
					/>
				</div>

				{#if listed.length === 0}
					<EmptyState level={3} title={data.people.length === 0 ? 'No people yet.' : 'No one matches.'} />
				{:else}
					<Table caption="People" captionHidden stack>
						<thead>
							<tr>
								<th>Name</th>
								<th>Email</th>
								<th>Job title</th>
								<th>Groups</th>
								<th>Account</th>
								<th>Status</th>
								<th><span class="visually-hidden">Actions</span></th>
							</tr>
						</thead>
						<tbody>
							{#each listed as person (person.id)}
								<tr class:left={person.status === 'left'}>
									<td class="name" data-label="Name">{nameOf(person)}</td>
									<td data-label="Email">{addressOf(person)}</td>
									<td data-label="Job title">{person.jobTitle}</td>
									<td data-label="Groups">
										<span class="chips">
											{#each person.groupIds as id (id)}
												<Badge variant="secondary">{groupName.get(id)}</Badge>
											{/each}
										</span>
									</td>
									<td data-label="Account">{person.account ? person.account.username : '—'}</td>
									<td data-label="Status">{statusOf(person)}</td>
									<td class="row-actions">
										<Button variant="ghost" size="sm" onclick={() => (editingPerson = { person })} aria-label="Edit {nameOf(person)}">Edit</Button>
										{#if person.status === 'active'}
											<Button variant="ghost" size="sm" aria-busy={marking === person.id ? 'true' : undefined} onclick={() => markLeft(person)} aria-label="Mark {nameOf(person)} left">Mark left</Button>
										{:else}
											<Button variant="ghost" size="sm" onclick={() => askMarkActive(person)} aria-label="Mark {nameOf(person)} active">Mark active</Button>
										{/if}
										<Button variant="ghost" size="sm" class="danger" onclick={() => askDeletePerson(person)} aria-label="Delete {nameOf(person)}">Delete</Button>
									</td>
								</tr>
							{/each}
						</tbody>
					</Table>
				{/if}
			</CardContent>
		</Card>

		<!-- Groups -->
		<Card as="section" aria-labelledby="groups-title">
			<CardHeader>
				{#snippet actions()}
					<Button size="sm" onclick={() => (editingGroup = { group: null })}>+ Add group</Button>
				{/snippet}
				<CardTitle level={2} id="groups-title">Groups</CardTitle>
			</CardHeader>
			<CardContent>
				{#if data.groups.length === 0}
					<EmptyState level={3} title="No groups yet." />
				{:else}
					<Table caption="Groups" captionHidden stack>
						<thead>
							<tr>
								<th>Name and description</th>
								<th>Active members</th>
								<th><span class="visually-hidden">Actions</span></th>
							</tr>
						</thead>
						<tbody>
							{#each data.groups as group (group.id)}
								{@const active = group.personIds.filter((id) => activeIds.has(id)).length}
								<tr>
									<td data-label="Name and description">
										<span class="group-info">
											<span class="group-name">{group.name}</span>
											{#if group.description}<span class="group-desc">{group.description}</span>{/if}
										</span>
									</td>
									<td data-label="Active members">{active} active member{active === 1 ? '' : 's'}</td>
									<td class="row-actions">
										<Button variant="ghost" size="sm" onclick={() => (editingGroup = { group })} aria-label="Edit group {group.name}">Edit</Button>
										<Button variant="ghost" size="sm" class="danger" onclick={() => askDeleteGroup(group)} aria-label="Delete group {group.name}">Delete</Button>
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

{#if editingPerson}
	<PersonDialog {data} person={editingPerson.person} onClose={() => (editingPerson = null)} />
{/if}
{#if editingGroup}
	<GroupDialog {data} group={editingGroup.group} onClose={() => (editingGroup = null)} />
{/if}
{#if addingFromAccounts}
	<FromAccountsDialog {data} onClose={() => (addingFromAccounts = false)} />
{/if}

{#if confirmAction}
	<ConfirmModal
		kit
		title={confirmAction.title}
		message={confirmAction.message}
		confirmText={confirmAction.confirmText}
		confirmDanger={confirmAction.confirmDanger ?? true}
		askPassword={confirmAction.askPassword ?? false}
		onConfirm={async (proof: StepUpProof) => confirmAction?.action(proof)}
		onCancel={() => (confirmAction = null)}
	/>
{/if}

<Toast />

<style>
	.page-sections {
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
	}

	/* The search and the Active / Left / All filter, above the table. */
	.people-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-sm) var(--space-md);
		margin-bottom: var(--space-md);
	}
	.people-search {
		flex: 1 1 16rem;
		width: auto;
		max-width: 32rem;
	}

	td.name {
		font-weight: 500;
	}
	/* Someone who has left: their row quieter. */
	tr.left td {
		color: var(--ui-muted-foreground);
	}
	.chips {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}
	.row-actions {
		text-align: right;
		white-space: nowrap;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.group-info {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.group-name {
		font-weight: 500;
	}
	.group-desc {
		font-size: 0.8125rem;
		color: var(--ui-muted-foreground);
	}

	/* A phone: the row's buttons wrap under its labelled cells. */
	@media (max-width: 640px) {
		.row-actions {
			flex-wrap: wrap;
			justify-content: flex-start;
			white-space: normal;
		}
	}
</style>