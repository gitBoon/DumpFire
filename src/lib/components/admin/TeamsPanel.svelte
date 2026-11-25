<!--
  TeamsPanel.svelte — The admin page's Team Management: Add Team, and each
  team with its members, Add member and 🗑️ (card 2281, slice C1b: moved from
  src/routes/admin/+page.svelte).

  Shown to every administrator. Delete asks first through the page's own
  confirm dialog, and the page's data is read again after each change.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/admin/$types';
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { answerBody } from '$lib/api';
	import { sent, showToast } from '$lib/admin/send';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import CardContent from '$lib/components/ui/CardContent.svelte';
	import CardHeader from '$lib/components/ui/CardHeader.svelte';
	import CardTitle from '$lib/components/ui/CardTitle.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';

	let {
		data,
		confirm
	}: {
		/** What the admin page's load gave it, passed on as it is: the teams, and the accounts to add. */
		data: PageData;
		/** The page's confirm dialog, which asks before a team is deleted. */
		confirm: (title: string, message: string, action: () => Promise<void>) => void;
	} = $props();

	// ─── Team Management ──────────────────────────────────────────────────

	let showCreateTeam = $state(false);
	let newTeamName = $state('');
	let newTeamEmoji = $state('🏢');

	async function createTeam() {
		if (!newTeamName.trim()) return;
		const res = await sent(
			() =>
				fetch('/api/teams', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ name: newTeamName.trim(), emoji: newTeamEmoji })
				}),
			'Failed to create team'
		);
		if (!res) return;
		showCreateTeam = false;
		newTeamName = ''; newTeamEmoji = '🏢';
		await invalidateAll();
		showToast('Team created');
	}

	async function deleteTeam(teamId: number) {
		if (!(await sent(() => fetch(`/api/teams/${teamId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }), 'Failed to delete team'))) return;
		await invalidateAll();
		showToast('Team deleted');
	}

	let addMemberTeamId = $state<number | null>(null);
	let addMemberUserId = $state<number | null>(null);
	/**
	 * The role the person is added with, chosen beside the member picker (card
	 * 2309): a team's owner may rename and delete it and add and remove its
	 * members without being an administrator; a member may not. Member each
	 * time a person is chosen, and after each add (the card 2309 review: a
	 * role chosen for one person was kept for the next).
	 */
	let addMemberRole = $state<'member' | 'owner'>('member');
	/**
	 * The team whose add is out. A second Add meanwhile sends nothing (card
	 * 2374: a double click sent two, as on the Teams page). Add is marked busy
	 * rather than turned off: turning off the control that has the focus drops
	 * the keyboard's focus to the page.
	 */
	let addingTo = $state<number | null>(null);

	/** An account's name from the page's data, for what the toast says. */
	function addedName(userId: number): string {
		return data.users.find((u) => u.id === userId)?.username ?? 'This person';
	}

	async function addTeamMember() {
		if (!addMemberTeamId || !addMemberUserId || addingTo !== null) return;
		const teamId = addMemberTeamId;
		const userId = addMemberUserId;
		const role = addMemberRole;
		addingTo = teamId;
		try {
			// A member not added used to be said nowhere.
			const res = await sent(
				() =>
					fetch(`/api/teams/${teamId}/members/${userId}`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ userId, role })
					}),
				'Failed to add member'
			);
			if (!res) return;
			const result = await answerBody(res);
			addMemberTeamId = null;
			addMemberUserId = null;
			addMemberRole = 'member';
			await invalidateAll();
			// Someone already in the team (added meanwhile elsewhere) has their role set, and that is
			// said rather than "Member added" (the card 2374 review).
			showToast(result?.action === 'updated' ? `${addedName(userId)} was already in the team; role set to ${ROLE_NAMES[role] ?? role}` : 'Member added');
		} finally {
			addingTo = null;
		}
	}

	/**
	 * The role chosen in each member's picker and not yet saved, as
	 * `team:user` (card 2376). Choosing sends nothing: on Windows, Up and Down
	 * on a closed picker change it at once, and the picker saved every role
	 * arrowed past. Change sends the one chosen. The picker shows it until it
	 * is saved or put back, the member is removed, or a re-read drops it.
	 */
	let chosenRole = $state(new Map<string, string>());

	function setChosen(key: string, role: string | null) {
		const next = new Map(chosenRole);
		if (role === null) next.delete(key);
		else next.set(key, role);
		chosenRole = next;
	}

	/**
	 * The members whose role change is out, as `team:user` (one person can be
	 * in two teams), each with their name for the status line. Two changes out
	 * at once each keep their own (the card 2355 review: one slot, cleared by
	 * the first answer). A picker whose change is out is marked busy, and its
	 * Change too, rather than turned off: turning off the control that has the
	 * focus drops the keyboard's focus to the page.
	 */
	let changingRole = $state(new Map<string, string>());

	function markChanging(key: string, username: string | null) {
		const next = new Map(changingRole);
		if (username === null) next.delete(key);
		else next.set(key, username);
		changingRole = next;
	}

	/** What a screen reader is told while a change is out (card 2376), politely; the toast says how it ended. */
	let savingSaid = $derived([...changingRole.values()].map((name) => `Saving ${name}'s role…`).join(' '));

	/** The role the page's data gives this member now: the data can have been read again since a change was sent. */
	function storedRole(teamId: number, userId: number): string | undefined {
		return data.teams.find((t) => t.id === teamId)?.members.find((m) => m.userId === userId)?.role;
	}

	const ROLE_NAMES: Record<string, string> = { member: 'Member', owner: 'Owner' };

	/**
	 * A role chosen and not saved is dropped when the page's data is read
	 * again and the member is gone or already has it (the card 2376 review:
	 * with Owner chosen for bob and not saved, bob removed and added back as
	 * Member, his picker read Owner and Change was live). A choice whose
	 * change is out is left to that change, which clears it as it ends.
	 */
	$effect.pre(() => {
		const teams = data.teams;
		untrack(() => {
			const stale = [...chosenRole].filter(([key, role]) => {
				if (changingRole.has(key)) return false;
				const [teamId, userId] = key.split(':').map(Number);
				const stored = teams.find((t) => t.id === teamId)?.members.find((m) => m.userId === userId)?.role;
				return stored === undefined || stored === role;
			});
			if (stale.length === 0) return;
			const next = new Map(chosenRole);
			for (const [key] of stale) next.delete(key);
			chosenRole = next;
		});
	});

	/**
	 * A role chosen in a member's picker, kept for Change (card 2376). While
	 * the member's change is out, another choice goes back to the role being
	 * saved (card 2355).
	 */
	function chooseRole(teamId: number, member: { userId: number }, picker: HTMLSelectElement) {
		const key = `${teamId}:${member.userId}`;
		if (changingRole.has(key)) {
			picker.value = chosenRole.get(key) ?? picker.value;
			return;
		}
		setChosen(key, picker.value === storedRole(teamId, member.userId) ? null : picker.value);
	}

	/**
	 * Change: saves the role chosen for someone already in the team, in place
	 * (card 2355: no page could; it took a remove and an add). The members
	 * route sets the role of a member it already has. Refused or not answered,
	 * the picker shows the role the page's data gives them, read then (the
	 * card 2355 review: the role held from when it was sent could land on
	 * another row). A member removed meanwhile is added again by the route,
	 * and that is said rather than "Role changed". While one is out, a second
	 * Change for the member sends nothing.
	 */
	async function changeRole(teamId: number, member: { userId: number; username: string }) {
		const key = `${teamId}:${member.userId}`;
		const role = chosenRole.get(key);
		if (changingRole.has(key) || role === undefined) return;
		if (role === storedRole(teamId, member.userId)) {
			setChosen(key, null);
			return;
		}
		const putBack = () => setChosen(key, null);
		markChanging(key, member.username);
		try {
			const res = await sent(
				() =>
					fetch(`/api/teams/${teamId}/members/${member.userId}`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ userId: member.userId, role })
					}),
				'Failed to change the role'
			);
			if (!res) {
				putBack();
				return;
			}
			const result = await answerBody(res);
			await invalidateAll();
			setChosen(key, null);
			showToast(
				result?.action === 'added'
					? `${member.username} was no longer in the team and has been added again as ${ROLE_NAMES[role] ?? role}`
					: 'Role changed'
			);
		} finally {
			markChanging(key, null);
		}
	}

	async function removeTeamMember(teamId: number, userId: number) {
		// It used to say "Member removed" whatever the answer.
		if (!(await sent(() => fetch(`/api/teams/${teamId}/members/${userId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }), 'Failed to remove member'))) return;
		// A role chosen for them and not saved goes with them (the card 2376 review).
		setChosen(`${teamId}:${userId}`, null);
		await invalidateAll();
		showToast('Member removed');
	}
</script>

<!-- Team Management -->
<Card as="section" id="teams" class="admin-section" aria-labelledby="teams-title">
	<CardHeader>
		{#snippet actions()}
			<Button size="sm" onclick={() => (showCreateTeam = true)}>+ Add Team</Button>
		{/snippet}
		<CardTitle level={2} id="teams-title">Team Management</CardTitle>
	</CardHeader>
	<CardContent>
		<!-- A role being saved, said politely to a screen reader (card 2376). -->
		<p class="saving-status" role="status">{savingSaid}</p>

		{#if showCreateTeam}
			<div class="admin-subform">
				<div class="admin-field-row">
					<input type="text" placeholder="Team name" bind:value={newTeamName} class="ui-input" />
					<EmojiPicker value={newTeamEmoji} onSelect={(e) => (newTeamEmoji = e)} />
					<Button size="sm" onclick={createTeam} disabled={!newTeamName.trim()}>Create</Button>
					<Button variant="outline" size="sm" onclick={() => (showCreateTeam = false)}>Cancel</Button>
				</div>
			</div>
		{/if}

		{#if data.teams.length === 0}
			<EmptyState level={3} title="No teams yet." />
		{:else}
			<div class="team-list">
				{#each data.teams as team (team.id)}
					<div class="team-card">
						<div class="team-card-header">
							<span class="team-emoji">{team.emoji}</span>
							<span class="team-name">{team.name}</span>
							<span class="team-count">{team.members.length} member{team.members.length !== 1 ? 's' : ''}</span>
							<Button variant="ghost" size="sm" class="danger" onclick={() => confirm('Delete Team', `Delete team "${team.name}"?`, () => deleteTeam(team.id))} title="Delete team">🗑️</Button>
						</div>
						<div class="team-members">
							{#each team.members as member (member.userId)}
								{@const roleKey = `${team.id}:${member.userId}`}
								<div class="team-member">
									<span class="team-member-name">{member.emoji} {member.username}</span>
									<!-- The role, changed in place (card 2355). A role stored before roles were checked is shown as itself. Choosing sends nothing; Change saves it (card 2376). Busy, not off, while its change is out: off, it would drop the focus. -->
									<select
										class="ui-select member-role"
										value={chosenRole.get(roleKey) ?? member.role}
										aria-busy={changingRole.has(roleKey) ? 'true' : undefined}
										onchange={(e) => chooseRole(team.id, member, e.currentTarget)}
										aria-label="{member.username}'s role in this team"
									>
										{#if member.role !== 'member' && member.role !== 'owner'}
											<option value={member.role}>{member.role}</option>
										{/if}
										<option value="member">Member</option>
										<option value="owner">Owner</option>
									</select>
									<Button
										variant="ghost"
										size="sm"
										class="member-role-change"
										aria-disabled={chosenRole.has(roleKey) && !changingRole.has(roleKey) ? undefined : 'true'}
										onclick={() => changeRole(team.id, member)}
										aria-label="Change {member.username}'s team role"
									>Change</Button>
									<Button variant="ghost" size="sm" onclick={() => removeTeamMember(team.id, member.userId)} title="Remove from team">✕</Button>
								</div>
							{:else}
								<p class="admin-note">No members</p>
							{/each}
						</div>
						<div class="add-member-row">
							<select class="ui-select" onchange={(e) => { addMemberRole = 'member'; addMemberTeamId = team.id; addMemberUserId = Number((e.target as HTMLSelectElement).value); }}>
								<option value="">Add member...</option>
								<!-- A disabled account is named on the panel, and cannot be added (card 2671). -->
								{#each data.users.filter(u => !u.disabledAt && !team.members.some(m => m.userId === u.id)) as u}
									<option value={u.id}>{u.emoji} {u.username}</option>
								{/each}
							</select>
							{#if addMemberTeamId === team.id && addMemberUserId}
								<select class="ui-select role-pick" bind:value={addMemberRole} title="Their role in this team">
									<option value="member">Member</option>
									<option value="owner">Owner</option>
								</select>
								<!-- Busy, not off, while the add is out (card 2374): off, it would drop the focus. -->
								<Button size="sm" aria-busy={addingTo === team.id ? 'true' : undefined} onclick={addTeamMember}>Add</Button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</CardContent>
</Card>

<style>
	/* Team management: each team a box of its own, with its members and its add row. */
	.team-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}
	.team-card {
		min-width: 0;
		border: 1px solid var(--ui-border);
		border-radius: var(--ui-radius);
		overflow: hidden;
	}
	.team-card-header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md);
		border-bottom: 1px solid var(--ui-border);
		background: color-mix(in srgb, var(--ui-muted) 45%, transparent);
	}
	.team-emoji {
		font-size: 1.2rem;
	}
	.team-name {
		flex: 1;
		min-width: 0;
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.team-count {
		font-size: 0.75rem;
		color: var(--ui-muted-foreground);
	}

	.team-members {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: var(--space-sm) var(--space-md);
	}
	.team-member {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs) var(--space-sm);
		padding: var(--space-xs) 0;
	}
	.team-member-name {
		flex: 1 1 10rem;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	/* The role, a picker since card 2355: the kit's field, as low as the row's buttons. */
	.member-role {
		width: auto;
		height: 2rem;
		padding-left: 0.5rem;
		font-size: 0.8125rem;
	}
	/* The status line is for screen readers alone. */
	.saving-status {
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

	.add-member-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md);
		border-top: 1px solid var(--ui-border);
	}
	.add-member-row select {
		flex: 1 1 12rem;
		width: auto;
		max-width: 24rem;
	}
	/* The role beside the person (card 2309): as wide as its words. */
	.add-member-row select.role-pick {
		flex: none;
		min-width: 0;
	}
</style>