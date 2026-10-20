<!--
  TeamsPanel.svelte — The admin page's Team Management: Add Team, and each
  team with its members, Add member and 🗑️ (card 2281, slice C1b: moved from
  src/routes/admin/+page.svelte).

  Shown to every administrator. Delete asks first through the page's own
  confirm dialog, and the page's data is read again after each change.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/admin/$types';
	import { invalidateAll } from '$app/navigation';
	import { sent, showToast } from '$lib/admin/send';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';

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
		if (!(await sent(() => fetch(`/api/teams/${teamId}`, { method: 'DELETE' }), 'Failed to delete team'))) return;
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

	async function addTeamMember() {
		if (!addMemberTeamId || !addMemberUserId) return;
		const teamId = addMemberTeamId;
		const userId = addMemberUserId;
		// A member not added used to be said nowhere.
		const res = await sent(
			() =>
				fetch(`/api/teams/${teamId}/members/${userId}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ userId, role: addMemberRole })
				}),
			'Failed to add member'
		);
		if (!res) return;
		addMemberTeamId = null;
		addMemberUserId = null;
		addMemberRole = 'member';
		await invalidateAll();
		showToast('Member added');
	}

	async function removeTeamMember(teamId: number, userId: number) {
		// It used to say "Member removed" whatever the answer.
		if (!(await sent(() => fetch(`/api/teams/${teamId}/members/${userId}`, { method: 'DELETE' }), 'Failed to remove member'))) return;
		await invalidateAll();
		showToast('Member removed');
	}
</script>

<!-- Team Management -->
<section class="admin-card glass fade-in-up" style="animation-delay: 280ms">
	<div class="section-header">
		<h2>🏢 Team Management</h2>
		<button class="btn-primary btn-sm" onclick={() => (showCreateTeam = true)}>+ Add Team</button>
	</div>

	{#if showCreateTeam}
		<div class="inline-form">
			<div class="form-row">
				<input type="text" placeholder="Team name" bind:value={newTeamName} class="form-input" />
				<EmojiPicker value={newTeamEmoji} onSelect={(e) => (newTeamEmoji = e)} />
				<button class="btn-primary btn-sm" onclick={createTeam} disabled={!newTeamName.trim()}>Create</button>
				<button class="btn-ghost btn-sm" onclick={() => (showCreateTeam = false)}>Cancel</button>
			</div>
		</div>
	{/if}

	{#if data.teams.length === 0}
		<p class="empty-msg">No teams yet.</p>
	{:else}
		<div class="team-list">
			{#each data.teams as team (team.id)}
				<div class="team-card">
					<div class="team-card-header">
						<span class="team-emoji">{team.emoji}</span>
						<span class="team-name">{team.name}</span>
						<span class="team-count">{team.members.length} member{team.members.length !== 1 ? 's' : ''}</span>
						<button class="btn-ghost btn-sm danger" onclick={() => confirm('Delete Team', `Delete team "${team.name}"?`, () => deleteTeam(team.id))} title="Delete team">🗑️</button>
					</div>
					<div class="team-members">
						{#each team.members as member}
							<div class="team-member">
								<span>{member.emoji} {member.username}</span>
								<span class="member-role">{member.role}</span>
								<button class="btn-ghost btn-xs" onclick={() => removeTeamMember(team.id, member.userId)} title="Remove from team">✕</button>
							</div>
						{:else}
							<span class="empty-msg" style="padding: var(--space-sm)">No members</span>
						{/each}
					</div>
					<div class="add-member-row">
						<select class="form-input" onchange={(e) => { addMemberRole = 'member'; addMemberTeamId = team.id; addMemberUserId = Number((e.target as HTMLSelectElement).value); }}>
							<option value="">Add member...</option>
							{#each data.users.filter(u => !team.members.some(m => m.userId === u.id)) as u}
								<option value={u.id}>{u.emoji} {u.username}</option>
							{/each}
						</select>
						{#if addMemberTeamId === team.id && addMemberUserId}
							<select class="form-input role-pick" bind:value={addMemberRole} title="Their role in this team">
								<option value="member">Member</option>
								<option value="owner">Owner</option>
							</select>
							<button class="btn-primary btn-xs" onclick={addTeamMember}>Add</button>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</section>

<style>
	/* Team management */
	.team-list { display: flex; flex-direction: column; gap: var(--space-md); }
	.team-card {
		background: var(--bg-base); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); overflow: hidden;
		transition: border-color 0.15s;
	}
	.team-card:hover { border-color: var(--accent-indigo); }
	.team-card-header {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-md) var(--space-lg);
		border-bottom: 1px solid var(--glass-border);
	}
	.team-emoji { font-size: 1.2rem; }
	.team-name { font-weight: 600; font-size: 0.9rem; flex: 1; }
	.team-count { font-size: 0.72rem; color: var(--text-tertiary); }

	.team-members {
		padding: var(--space-sm) var(--space-lg);
		display: flex; flex-direction: column; gap: 2px;
	}
	.team-member {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-xs) 0; font-size: 0.82rem;
	}
	.team-member span:first-child { flex: 1; }
	.member-role { font-size: 0.65rem; color: var(--text-tertiary); font-weight: 600; text-transform: uppercase; }

	.add-member-row {
		display: flex; gap: var(--space-sm); align-items: center;
		padding: var(--space-sm) var(--space-lg);
		border-top: 1px solid var(--glass-border);
	}
	.add-member-row select { flex: 1; }
	/* The role beside the person (card 2309): as wide as its words. */
	.add-member-row select.role-pick { flex: none; min-width: 0; width: auto; }
</style>
