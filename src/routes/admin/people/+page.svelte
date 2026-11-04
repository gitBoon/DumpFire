<script lang="ts">
	/**
	 * People Directory — the admin page that keeps who can be consulted on or
	 * told of a decision, with an account or without one, and their groups
	 * (card 2674, plan 4.3).
	 *
	 * Every change is sent to the admin-only routes under `/api/people` and
	 * `/api/people-groups`, a refusal is said in the server's words (`sent`),
	 * and the page's data is read again after each one.
	 */
	import type { PageData } from './$types';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';
	import { theme, themeIcon } from '$lib/stores/theme';
	import Toast from '$lib/components/Toast.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import PersonDialog from '$lib/components/admin/people/PersonDialog.svelte';
	import GroupDialog from '$lib/components/admin/people/GroupDialog.svelte';
	import FromAccountsDialog from '$lib/components/admin/people/FromAccountsDialog.svelte';
	import { invalidateAll } from '$app/navigation';
	import { answerBody } from '$lib/api';
	import { sent, showToast } from '$lib/admin/send';

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

	/** The confirm open, for a delete. */
	let confirmAction = $state<{ title: string; message: string; confirmText: string; action: () => Promise<void> } | null>(null);

	/** The person whose Mark left or Mark active is out: a second press meanwhile sends nothing. */
	let marking = $state<number | null>(null);

	async function setStatus(person: Person, status: 'active' | 'left') {
		if (marking !== null) return;
		marking = person.id;
		try {
			const res = await sent(
				() => fetch(`/api/people/${person.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }),
				status === 'left' ? 'The person was not marked left' : 'The person was not marked active'
			);
			if (!res) return;
			await invalidateAll();
			showToast(status === 'left' ? `${person.fullName} marked left` : `${person.fullName} marked active`);
		} finally {
			marking = null;
		}
	}

	/**
	 * What Delete says before it is done (plan decision 3 and review R9): what
	 * it removes, what it does not erase, and that Mark left can be undone.
	 */
	function deletePersonMessage(person: Person): string {
		return (
			`Delete ${person.fullName} from the directory? This cannot be undone. ` +
			'Their group memberships go with them and their personal decision links stop working. ' +
			'Decision records keep what they recorded of them (name, address, job title and groups), and the system log and backups still hold their name. ' +
			'Mark left keeps them in the directory and can be undone.'
		);
	}

	function askDeletePerson(person: Person) {
		confirmAction = {
			title: 'Delete Person',
			message: deletePersonMessage(person),
			confirmText: 'Delete',
			action: async () => {
				const res = await sent(() => fetch(`/api/people/${person.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }), 'The person was not deleted');
				if (!res) return;
				const answer = await answerBody(res);
				const cleared = typeof answer?.linksCleared === 'number' ? answer.linksCleared : 0;
				await invalidateAll();
				showToast(cleared > 0 ? `${person.fullName} deleted; ${cleared} decision link${cleared === 1 ? '' : 's'} cleared` : `${person.fullName} deleted`);
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

<div class="people-page">
	<header class="admin-header glass">
		<div class="admin-header-inner">
			<a href="/" class="header-logo" title="Back to DumpFire">
				<span class="logo-fire">🔥</span>
				<span class="logo-text">DumpFire</span>
			</a>
			<h1 class="header-title">👥 People Directory</h1>
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
		<!-- People -->
		<section class="admin-card glass">
			<div class="section-header">
				<h2>People</h2>
				<div class="section-actions">
					<button class="btn-ghost btn-sm" onclick={() => (addingFromAccounts = true)}>Add from accounts</button>
					<button class="btn-primary btn-sm" onclick={() => (editingPerson = { person: null })}>+ Add person</button>
				</div>
			</div>

			<div class="filters">
				<input type="search" class="form-input" placeholder="Search name, email, job title or group" aria-label="Search people" bind:value={search} />
				<div class="status-filter" role="group" aria-label="Show">
					{#each [['active', 'Active'], ['left', 'Left'], ['all', 'All']] as [value, label] (value)}
						<button class="filter-btn" class:active={show === value} aria-pressed={show === value} onclick={() => (show = value as typeof show)}>{label}</button>
					{/each}
				</div>
			</div>

			{#if listed.length === 0}
				<p class="empty-msg">{data.people.length === 0 ? 'No people yet.' : 'No one matches.'}</p>
			{:else}
				<div class="table-wrap">
					<table class="people-table">
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
									<td class="name">{person.fullName}</td>
									<td>{person.email}</td>
									<td>{person.jobTitle}</td>
									<td>
										{#each person.groupIds as id (id)}
											<span class="chip">{groupName.get(id)}</span>
										{/each}
									</td>
									<td>{person.account ? person.account.username : '—'}</td>
									<td>{person.status === 'left' ? `Left${person.leftAt ? ` ${person.leftAt.slice(0, 10)}` : ''}` : 'Active'}</td>
									<td class="row-actions">
										<button class="btn-ghost btn-xs" onclick={() => (editingPerson = { person })} aria-label="Edit {person.fullName}">Edit</button>
										{#if person.status === 'active'}
											<button class="btn-ghost btn-xs" aria-busy={marking === person.id ? 'true' : undefined} onclick={() => setStatus(person, 'left')} aria-label="Mark {person.fullName} left">Mark left</button>
										{:else}
											<button class="btn-ghost btn-xs" aria-busy={marking === person.id ? 'true' : undefined} onclick={() => setStatus(person, 'active')} aria-label="Mark {person.fullName} active">Mark active</button>
										{/if}
										<button class="btn-ghost btn-xs danger" onclick={() => askDeletePerson(person)} aria-label="Delete {person.fullName}">Delete</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<!-- Groups -->
		<section class="admin-card glass">
			<div class="section-header">
				<h2>Groups</h2>
				<button class="btn-primary btn-sm" onclick={() => (editingGroup = { group: null })}>+ Add group</button>
			</div>
			{#if data.groups.length === 0}
				<p class="empty-msg">No groups yet.</p>
			{:else}
				<div class="group-list">
					{#each data.groups as group (group.id)}
						{@const active = group.personIds.filter((id) => activeIds.has(id)).length}
						<div class="group-row">
							<div class="group-info">
								<span class="group-name">{group.name}</span>
								{#if group.description}<span class="group-desc">{group.description}</span>{/if}
							</div>
							<span class="group-count">{active} active member{active === 1 ? '' : 's'}</span>
							<button class="btn-ghost btn-xs" onclick={() => (editingGroup = { group })} aria-label="Edit group {group.name}">Edit</button>
							<button class="btn-ghost btn-xs danger" onclick={() => askDeleteGroup(group)} aria-label="Delete group {group.name}">Delete</button>
						</div>
					{/each}
				</div>
			{/if}
		</section>
	</main>

	{#if editingPerson}
		<PersonDialog {data} person={editingPerson.person} onClose={() => (editingPerson = null)} />
	{/if}
	{#if editingGroup}
		<GroupDialog {data} group={editingGroup.group} onClose={() => (editingGroup = null)} />
	{/if}
	{#if addingFromAccounts}
		<FromAccountsDialog {data} onClose={() => (addingFromAccounts = false)} />
	{/if}
</div>

{#if confirmAction}
	<ConfirmModal
		title={confirmAction.title}
		message={confirmAction.message}
		confirmText={confirmAction.confirmText}
		onConfirm={async () => {
			const action = confirmAction?.action;
			confirmAction = null;
			await action?.();
		}}
		onCancel={() => (confirmAction = null)}
	/>
{/if}

<Toast />

<style>
	.people-page { min-height: 100vh; padding-top: 64px; }

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
		max-width: 1100px; margin: 0 auto; padding: var(--space-2xl) var(--space-2xl) var(--user-badge-space);
		display: flex; flex-direction: column; gap: var(--space-xl);
	}
	.admin-card { padding: var(--space-xl); border-radius: var(--radius-lg); }
	.admin-card h2 { font-size: 1.05rem; margin-bottom: 0; }
	.section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-lg); }
	.section-actions { display: flex; gap: var(--space-sm); }
	.empty-msg { font-size: 0.85rem; color: var(--text-tertiary); text-align: center; padding: var(--space-xl); }

	.filters { display: flex; gap: var(--space-md); align-items: center; flex-wrap: wrap; margin-bottom: var(--space-lg); }
	.filters .form-input { flex: 1; }
	.status-filter { display: flex; gap: var(--space-xs); }
	.filter-btn {
		padding: var(--space-xs) var(--space-md); border-radius: var(--radius-sm);
		font-size: 0.8rem; font-weight: 600; font-family: var(--font-family);
		background: var(--bg-base); border: 1px solid var(--glass-border); color: var(--text-secondary); cursor: pointer;
	}
	.filter-btn.active { background: var(--accent-indigo); border-color: var(--accent-indigo); color: white; }

	.table-wrap { overflow-x: auto; }
	.people-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
	.people-table th {
		text-align: left; font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
		color: var(--text-tertiary); padding: var(--space-xs) var(--space-sm); border-bottom: 1px solid var(--glass-border);
	}
	.people-table td { padding: var(--space-sm); border-bottom: 1px solid var(--glass-border); vertical-align: middle; }
	.people-table tr.left td { color: var(--text-tertiary); }
	.people-table td.name { font-weight: 600; }
	.row-actions { white-space: nowrap; text-align: right; }
	.chip {
		display: inline-block; margin: 1px 2px; padding: 1px var(--space-sm); border-radius: 999px;
		font-size: 0.7rem; background: rgba(99, 102, 241, 0.12); color: var(--accent-indigo);
	}
	.visually-hidden {
		position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
		overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
	}

	.group-list { display: flex; flex-direction: column; gap: var(--space-xs); }
	.group-row {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md); background: var(--bg-base);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
	}
	.group-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
	.group-name { font-weight: 600; font-size: 0.85rem; }
	.group-desc { font-size: 0.75rem; color: var(--text-tertiary); }
	.group-count { font-size: 0.72rem; color: var(--text-tertiary); white-space: nowrap; }

	/* The dialogs' fields, which are drawn inside the page */
	.people-page :global(.form-input) {
		padding: var(--space-sm) var(--space-md);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-elevated); color: var(--text-primary);
		font-size: 0.82rem; font-family: var(--font-family);
		min-width: 120px;
	}
	.people-page :global(.form-input:focus) { border-color: var(--accent-indigo); outline: none; }
	.people-page :global(.btn-sm) { font-size: 0.78rem !important; padding: var(--space-xs) var(--space-md) !important; }
	.people-page :global(.btn-xs) { font-size: 0.7rem !important; padding: 2px var(--space-sm) !important; }
	.people-page :global(.danger) { color: var(--accent-rose) !important; }
</style>
