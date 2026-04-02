<script lang="ts">
	/**
	 * Teams Page — Team management for all users.
	 *
	 * Users can create teams, manage members of teams they own,
	 * and view teams they belong to.
	 */
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import { theme } from '$lib/stores/theme';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';

	let { data }: { data: PageData } = $props();

	let currentTheme = $state('light');
	theme.subscribe((v) => (currentTheme = v));

	let isAdmin = $derived(data.currentUser?.role === 'admin' || data.currentUser?.role === 'superadmin');

	// Create team form
	let showCreateTeam = $state(false);
	let newTeamName = $state('');
	let newTeamEmoji = $state('🏢');

	// Toast
	let toast = $state('');
	let toastType = $state<'success' | 'error'>('success');

	function showToast(msg: string, type: 'success' | 'error' = 'success') {
		toast = msg;
		toastType = type;
		setTimeout(() => (toast = ''), 4000);
	}

	// Confirm modal
	let confirmAction = $state<{ show: boolean; title: string; message: string; onConfirm: () => void }>({
		show: false, title: '', message: '', onConfirm: () => {}
	});

	/** Check if the current user is an owner of a given team. */
	function isTeamOwner(team: (typeof data.teams)[number]): boolean {
		if (isAdmin) return true;
		return team.members.some(m => m.userId === data.currentUser?.id && m.role === 'owner');
	}

	async function createTeam() {
		if (!newTeamName.trim()) return;
		const res = await fetch('/api/teams', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: newTeamName.trim(), emoji: newTeamEmoji })
		});
		if (res.ok) {
			showCreateTeam = false;
			newTeamName = '';
			newTeamEmoji = '🏢';
			await invalidateAll();
			showToast('Team created');
		} else {
			showToast('Failed to create team', 'error');
		}
	}

	async function deleteTeam(teamId: number, teamName: string) {
		confirmAction = {
			show: true,
			title: 'Delete Team',
			message: `Delete team "${teamName}"? All members will lose team-based board access.`,
			onConfirm: async () => {
				confirmAction.show = false;
				await fetch(`/api/teams/${teamId}`, { method: 'DELETE' });
				await invalidateAll();
				showToast('Team deleted');
			}
		};
	}

	// Add member state
	let addMemberTeamId = $state<number | null>(null);
	let addMemberUserId = $state<number | null>(null);

	async function addTeamMember(teamId: number) {
		if (!addMemberUserId) return;
		const res = await fetch(`/api/teams/${teamId}/members/${addMemberUserId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId: addMemberUserId, role: 'member' })
		});
		if (res.ok) {
			addMemberTeamId = null;
			addMemberUserId = null;
			await invalidateAll();
			showToast('Member added');
		}
	}

	async function removeTeamMember(teamId: number, userId: number) {
		await fetch(`/api/teams/${teamId}/members/${userId}`, { method: 'DELETE' });
		await invalidateAll();
		showToast('Member removed');
	}
</script>

<svelte:head>
	<title>Teams — DumpFire</title>
</svelte:head>

<div class="teams-page">
	<header class="teams-header">
		<div class="teams-header-left">
			<a href="/" class="back-btn btn-ghost">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</a>
			<h1>🏢 My Teams</h1>
		</div>
		<div class="teams-header-right">
			<button class="theme-toggle btn-ghost" onclick={() => theme.toggle()}>
				{#if currentTheme === 'dark'}
					<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
						<circle cx="9" cy="9" r="4" stroke="currentColor" stroke-width="1.5"/>
						<path d="M9 1v2M9 15v2M1 9h2M15 9h2M3.3 3.3l1.4 1.4M13.3 13.3l1.4 1.4M3.3 14.7l1.4-1.4M13.3 4.7l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
					</svg>
				{:else}
					<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
						<path d="M15.5 10.1A6.5 6.5 0 017.9 2.5 7 7 0 1015.5 10.1z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				{/if}
			</button>
			<button class="btn-primary" onclick={() => (showCreateTeam = true)}>
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
				</svg>
				New Team
			</button>
		</div>
	</header>

	<main class="teams-content">
		{#if showCreateTeam}
			<section class="teams-card glass fade-in-up">
				<h2>✨ Create New Team</h2>
				<div class="create-form">
					<div class="create-form-row">
						<EmojiPicker value={newTeamEmoji} onSelect={(e) => (newTeamEmoji = e)} />
						<input
							type="text"
							placeholder="Team name"
							bind:value={newTeamName}
							class="form-input"
							onkeydown={(e) => e.key === 'Enter' && createTeam()}
							autofocus
						/>
					</div>
					<div class="create-form-actions">
						<button class="btn-ghost" onclick={() => (showCreateTeam = false)}>Cancel</button>
						<button class="btn-primary" onclick={createTeam} disabled={!newTeamName.trim()}>Create Team</button>
					</div>
				</div>
			</section>
		{/if}

		{#if data.teams.length === 0 && !showCreateTeam}
			<div class="empty-state">
				<span class="empty-icon">🏢</span>
				<h3>No teams yet</h3>
				<p>Create a team to collaborate with others on boards</p>
				<button class="btn-primary" onclick={() => (showCreateTeam = true)}>Create Your First Team</button>
			</div>
		{:else}
			<div class="teams-grid">
				{#each data.teams as team, i (team.id)}
					<section class="teams-card glass fade-in-up" style="animation-delay: {i * 60}ms">
						<div class="team-header">
							<span class="team-emoji">{team.emoji}</span>
							<div class="team-info">
								<h3>{team.name}</h3>
								<span class="team-meta">{team.members.length} member{team.members.length !== 1 ? 's' : ''}</span>
							</div>
							{#if isTeamOwner(team)}
								<button class="btn-ghost btn-sm danger-text" onclick={() => deleteTeam(team.id, team.name)} title="Delete team">
									<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
										<path d="M2 4h10M5 4V2.5A.5.5 0 015.5 2h3a.5.5 0 01.5.5V4m1.5 0l-.5 8a1 1 0 01-1 1h-5a1 1 0 01-1-1l-.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
									</svg>
								</button>
							{/if}
						</div>

						<div class="team-members-list">
							{#each team.members as member}
								<div class="team-member-item">
									<span class="member-avatar">{member.emoji}</span>
									<span class="member-name">{member.username}</span>
									<span class="member-role-badge role-{member.role}">{member.role}</span>
									{#if isTeamOwner(team) && member.userId !== data.currentUser?.id}
										<button class="member-remove-btn" onclick={() => removeTeamMember(team.id, member.userId)} title="Remove from team">
											<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2L2 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
										</button>
									{/if}
								</div>
							{:else}
								<p class="empty-members">No members yet</p>
							{/each}
						</div>

						{#if isTeamOwner(team)}
							<div class="add-member-section">
								<select
									class="form-input"
									onchange={(e) => {
										addMemberTeamId = team.id;
										addMemberUserId = Number((e.target as HTMLSelectElement).value);
									}}
								>
									<option value="">Add member...</option>
									{#each data.users.filter(u => !team.members.some(m => m.userId === u.id)) as u}
										<option value={u.id}>{u.emoji} {u.username}</option>
									{/each}
								</select>
								{#if addMemberTeamId === team.id && addMemberUserId}
									<button class="btn-primary btn-sm" onclick={() => addTeamMember(team.id)}>Add</button>
								{/if}
							</div>
						{/if}
					</section>
				{/each}
			</div>
		{/if}
	</main>
</div>

{#if confirmAction.show}
	<ConfirmModal
		title={confirmAction.title}
		message={confirmAction.message}
		confirmText="Delete"
		onConfirm={confirmAction.onConfirm}
		onCancel={() => (confirmAction.show = false)}
	/>
{/if}

{#if toast}
	<div class="toast-notification" class:toast-error={toastType === 'error'}>{toast}</div>
{/if}

<style>
	.teams-page { min-height: 100vh; }

	.teams-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-md) var(--space-xl); border-bottom: 1px solid var(--glass-border);
	}
	.teams-header-left { display: flex; align-items: center; gap: var(--space-md); }
	.teams-header-left h1 { font-size: 1.25rem; }
	.teams-header-right { display: flex; gap: var(--space-sm); align-items: center; }
	.back-btn { padding: var(--space-sm); }

	.teams-content {
		max-width: 800px; margin: 0 auto; padding: var(--space-2xl);
	}

	.teams-grid {
		display: flex; flex-direction: column; gap: var(--space-xl);
	}

	/* Fade-in animation */
	.fade-in-up {
		animation: fadeInUp 0.5s ease-out both;
	}
	@keyframes fadeInUp {
		from { opacity: 0; transform: translateY(16px); }
		to { opacity: 1; transform: translateY(0); }
	}

	.teams-card {
		padding: var(--space-xl); border-radius: var(--radius-lg);
		transition: transform 0.2s ease, box-shadow 0.2s ease;
	}
	.teams-card:hover {
		transform: translateY(-1px);
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
	}
	.teams-card h2 { font-size: 1.05rem; margin-bottom: var(--space-lg); }

	/* Create form */
	.create-form {
		display: flex; flex-direction: column; gap: var(--space-lg);
	}
	.create-form-row {
		display: flex; gap: var(--space-md); align-items: center;
	}
	.create-form-actions {
		display: flex; justify-content: flex-end; gap: var(--space-md);
	}

	.form-input {
		padding: var(--space-sm) var(--space-md);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-elevated); color: var(--text-primary);
		font-size: 0.85rem; font-family: var(--font-family);
		flex: 1; min-width: 120px;
	}
	.form-input:focus { border-color: var(--accent-indigo); outline: none; }

	/* Team card */
	.team-header {
		display: flex; align-items: center; gap: var(--space-md);
		margin-bottom: var(--space-lg);
		padding-bottom: var(--space-md);
		border-bottom: 1px solid var(--glass-border);
	}
	.team-emoji { font-size: 2rem; flex-shrink: 0; }
	.team-info { flex: 1; }
	.team-info h3 { font-size: 1.05rem; font-weight: 700; }
	.team-meta { font-size: 0.72rem; color: var(--text-tertiary); }

	/* Members list */
	.team-members-list {
		display: flex; flex-direction: column; gap: var(--space-xs);
	}

	.team-member-item {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md);
		background: var(--bg-base); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md);
		transition: border-color 0.15s ease;
	}
	.team-member-item:hover { border-color: var(--accent-indigo); }

	.member-avatar { font-size: 1.2rem; flex-shrink: 0; }
	.member-name { flex: 1; font-weight: 600; font-size: 0.85rem; }

	.member-role-badge {
		font-size: 0.6rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.05em; padding: 2px 8px; border-radius: var(--radius-sm);
	}
	.role-owner { background: rgba(245, 158, 11, 0.15); color: var(--accent-amber); }
	.role-member { background: rgba(100, 116, 139, 0.15); color: var(--text-secondary); }

	.member-remove-btn {
		width: 24px; height: 24px;
		display: flex; align-items: center; justify-content: center;
		border-radius: var(--radius-sm); background: transparent; border: none;
		color: var(--text-tertiary); cursor: pointer; opacity: 0.4;
		transition: all 0.15s;
	}
	.member-remove-btn:hover { opacity: 1; color: var(--accent-rose); background: rgba(244, 63, 94, 0.15); }

	.empty-members {
		font-size: 0.82rem; color: var(--text-tertiary);
		text-align: center; padding: var(--space-md);
	}

	/* Add member */
	.add-member-section {
		display: flex; gap: var(--space-sm); align-items: center;
		margin-top: var(--space-md); padding-top: var(--space-md);
		border-top: 1px solid var(--glass-border);
	}
	.add-member-section select { flex: 1; }

	/* Empty state */
	.empty-state {
		text-align: center; padding: var(--space-3xl); color: var(--text-secondary);
	}
	.empty-icon { font-size: 3rem; display: block; margin-bottom: var(--space-lg); }
	.empty-state h3 { margin-bottom: var(--space-sm); color: var(--text-primary); }
	.empty-state p { margin-bottom: var(--space-xl); }

	.btn-sm { font-size: 0.78rem !important; padding: var(--space-xs) var(--space-md) !important; }
	.danger-text { color: var(--accent-rose) !important; }

	/* Toast */
	.toast-notification {
		position: fixed; bottom: var(--space-xl); left: 50%; transform: translateX(-50%);
		background: var(--accent-emerald); color: white; padding: var(--space-sm) var(--space-xl);
		border-radius: var(--radius-full); font-size: 0.85rem; font-weight: 600;
		box-shadow: var(--shadow-lg); z-index: 9999;
		animation: toastIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
	}
	.toast-error { background: var(--accent-rose); }
	@keyframes toastIn {
		from { opacity: 0; transform: translateX(-50%) translateY(30px) scale(0.9); }
		to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
	}
</style>
