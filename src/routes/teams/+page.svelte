<script lang="ts">
	/**
	 * Teams Page — Team management for all users.
	 *
	 * Users can create teams, manage members of teams they own,
	 * and view teams they belong to.
	 */
	import type { PageData } from './$types';
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { theme } from '$lib/stores/theme';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import ThemePicker from '$lib/components/ThemePicker.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import { toasts } from '$lib/stores/toast';
	import { answerBody, deleteFailure, failureMessage } from '$lib/api';

	let { data }: { data: PageData } = $props();

	let currentTheme = $state('light');
	theme.subscribe((v) => (currentTheme = v));

	let isAdmin = $derived(data.currentUser?.role === 'admin' || data.currentUser?.role === 'superadmin');

	// Create team form
	let showCreateTeam = $state(false);
	let newTeamName = $state('');
	let newTeamEmoji = $state('🏢');

	/**
	 * The shared toast: a failure stays until it is closed, anything else goes
	 * after 3 s. `started` is `toasts.navigation()` as the request began, so
	 * that a failure arriving after the page was left is not shown.
	 */
	function showToast(msg: string, type: 'success' | 'error' = 'success', started?: number) {
		toasts.add(msg, type, started);
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

	// Each of the four says what the server said when it is refused: it used to
	// say a team was deleted or a member removed whatever the answer, and to
	// say nothing when a member was not added.

	async function createTeam() {
		if (!newTeamName.trim()) return;
		const started = toasts.navigation();
		let res: Response;
		try {
			res = await fetch('/api/teams', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newTeamName.trim(), emoji: newTeamEmoji })
			});
		} catch {
			showToast('No answer from the server. The team may not have been created.', 'error', started);
			return;
		}
		if (!res.ok) {
			showToast(await failureMessage(res, 'Failed to create team'), 'error', started);
			return;
		}
		showCreateTeam = false;
		newTeamName = '';
		newTeamEmoji = '🏢';
		await invalidateAll();
		showToast('Team created');
	}

	async function deleteTeam(teamId: number, teamName: string) {
		confirmAction = {
			show: true,
			title: 'Delete Team',
			message: `Delete team "${teamName}"? All members will lose team-based board access.`,
			onConfirm: async () => {
				confirmAction.show = false;
				const started = toasts.navigation();
				const failure = await deleteFailure(() => fetch(`/api/teams/${teamId}`, { method: 'DELETE' }), 'team');
				if (failure) {
					showToast(failure, 'error', started);
					return;
				}
				await invalidateAll();
				showToast('Team deleted');
			}
		};
	}

	// Add member state
	let addMemberTeamId = $state<number | null>(null);
	let addMemberUserId = $state<number | null>(null);
	/**
	 * The role the person is added with, chosen beside Add, as on the admin
	 * page's team panel (card 2355: this page added everyone as a member).
	 * Member each time a person is chosen, and after each add.
	 */
	let addMemberRole = $state<'member' | 'owner'>('member');
	/**
	 * The team whose add is out. A second Add meanwhile sends nothing (card
	 * 2374: a double click sent two, and said "Member added" twice). Add is
	 * marked busy rather than turned off: turning off the control that has the
	 * focus drops the keyboard's focus to the page.
	 */
	let addingTo = $state<number | null>(null);

	/** An account's name from the page's data, for what the toast says. */
	function addedName(userId: number): string {
		return data.users.find((u) => u.id === userId)?.username ?? 'This person';
	}

	async function addTeamMember(teamId: number) {
		if (!addMemberUserId || addingTo !== null) return;
		const started = toasts.navigation();
		const userId = addMemberUserId;
		const role = addMemberRole;
		addingTo = teamId;
		try {
			let res: Response;
			try {
				res = await fetch(`/api/teams/${teamId}/members/${userId}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ userId, role })
				});
			} catch {
				showToast('No answer from the server. The member may not have been added.', 'error', started);
				return;
			}
			if (!res.ok) {
				showToast(await failureMessage(res, 'Failed to add member'), 'error', started);
				return;
			}
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
	 * The members whose role change is out, as `team:user`, each with their
	 * name for the status line. Two changes out at once each keep their own
	 * (the card 2355 review: one slot, cleared by the first answer). A picker
	 * whose change is out is marked busy, and its Change too, rather than
	 * turned off: turning off the control that has the focus drops the
	 * keyboard's focus to the page.
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
	 * route sets the role of a member it already has, for an administrator or
	 * the team's owner. Refused or not answered, the picker shows the role the
	 * page's data gives them, read then (the card 2355 review: the role held
	 * from when it was sent could land on another row). A member removed
	 * meanwhile is added again by the route, and that is said rather than
	 * "Role changed". While one is out, a second Change for the member sends
	 * nothing.
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
		const started = toasts.navigation();
		markChanging(key, member.username);
		try {
			let res: Response;
			try {
				res = await fetch(`/api/teams/${teamId}/members/${member.userId}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ userId: member.userId, role })
				});
			} catch {
				putBack();
				showToast('No answer from the server. The role may not have been changed.', 'error', started);
				return;
			}
			if (!res.ok) {
				putBack();
				showToast(await failureMessage(res, 'Failed to change the role'), 'error', started);
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
		const started = toasts.navigation();
		const failure = await deleteFailure(() => fetch(`/api/teams/${teamId}/members/${userId}`, { method: 'DELETE' }), 'member', 'removed');
		if (failure) {
			showToast(failure, 'error', started);
			return;
		}
		// A role chosen for them and not saved goes with them (the card 2376 review).
		setChosen(`${teamId}:${userId}`, null);
		await invalidateAll();
		showToast('Member removed');
	}
</script>

<svelte:head>
	<title>Teams — DumpFire</title>
</svelte:head>

<div class="teams-page">
	<header class="teams-header glass">
		<div class="teams-header-inner">
			<a href="/" class="header-logo" title="Back to DumpFire">
				<span class="logo-fire">🔥</span>
				<span class="logo-text">DumpFire</span>
			</a>
			<h1 class="header-title">🏢 My Teams</h1>
			<div class="teams-header-right">
				<ThemePicker />
				<button class="btn-primary" onclick={() => (showCreateTeam = true)}>
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
					</svg>
					New Team
				</button>
			</div>
		</div>
	</header>

	<main class="teams-content">
		<!-- A role being saved, said politely to a screen reader (card 2376). -->
		<p class="saving-status" role="status">{savingSaid}</p>
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
							{#each team.members as member (member.userId)}
								<div class="team-member-item">
									<span class="member-avatar">{member.emoji}</span>
									<span class="member-name">{member.username}</span>
									{#if isTeamOwner(team) && member.userId !== data.currentUser?.id}
										{@const roleKey = `${team.id}:${member.userId}`}
										<!-- The role, changed in place where the member can be removed (card 2355). A role stored before roles were checked is shown as itself. Choosing sends nothing; Change saves it (card 2376). Busy, not off, while its change is out: off, it would drop the focus. -->
										<select
											class="member-role-pick"
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
										<button
											class="member-role-change"
											aria-disabled={chosenRole.has(roleKey) && !changingRole.has(roleKey) ? undefined : 'true'}
											onclick={() => changeRole(team.id, member)}
											aria-label="Change {member.username}'s team role"
										>Change</button>
										<button class="member-remove-btn" onclick={() => removeTeamMember(team.id, member.userId)} title="Remove from team">
											<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2L2 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
										</button>
									{:else}
										<span class="member-role-badge role-{member.role}">{member.role}</span>
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
										addMemberRole = 'member';
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
									<select class="form-input role-pick" bind:value={addMemberRole} title="Their role in this team">
										<option value="member">Member</option>
										<option value="owner">Owner</option>
									</select>
									<!-- Busy, not off, while the add is out (card 2374): off, it would drop the focus. -->
									<button class="btn-primary btn-sm" aria-busy={addingTo === team.id ? 'true' : undefined} onclick={() => addTeamMember(team.id)}>Add</button>
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

<Toast />

<style>
	.teams-page { min-height: 100vh; padding-top: 64px; }

	.teams-header {
		position: fixed; top: 0; left: 0; right: 0; z-index: 200;
		height: 64px; border-bottom: 1px solid var(--glass-border);
		backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
	}
	.teams-header-inner {
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
	.header-title {
		font-size: 1rem; font-weight: 700; color: var(--text-primary);
		letter-spacing: -0.01em;
	}
	.teams-header-right { display: flex; gap: var(--space-sm); align-items: center; }

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
	/* A member's role, changed in place (card 2355): as small as the badge it stands for. */
	.member-role-pick {
		font-size: 0.72rem; font-weight: 600; font-family: var(--font-family);
		padding: 2px var(--space-xs); border-radius: var(--radius-sm);
		border: 1px solid var(--glass-border); background: var(--bg-elevated); color: var(--text-primary);
	}
	.member-role-pick:focus { border-color: var(--accent-indigo); outline: none; }
	/* Change beside the picker (card 2376): dimmed, and sending nothing, until a role other than theirs is chosen. */
	.member-role-change {
		font-size: 0.7rem; font-weight: 600; font-family: var(--font-family);
		padding: 2px var(--space-sm); border-radius: var(--radius-sm); cursor: pointer;
		border: 1px solid var(--accent-indigo); background: transparent; color: var(--accent-indigo);
	}
	.member-role-change[aria-disabled='true'] { opacity: 0.35; cursor: default; border-color: var(--glass-border); color: var(--text-tertiary); }
	/* The status line is for screen readers alone. */
	.saving-status {
		position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
		overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
	}

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
	/* The role beside the person (card 2355, as the admin page's since card 2309): as wide as its words. */
	.add-member-section select.role-pick { flex: none; min-width: 0; width: auto; }

	/* Empty state */
	.empty-state {
		text-align: center; padding: var(--space-3xl); color: var(--text-secondary);
	}
	.empty-icon { font-size: 3rem; display: block; margin-bottom: var(--space-lg); }
	.empty-state h3 { margin-bottom: var(--space-sm); color: var(--text-primary); }
	.empty-state p { margin-bottom: var(--space-xl); }

	.btn-sm { font-size: 0.78rem !important; padding: var(--space-xs) var(--space-md) !important; }
	.danger-text { color: var(--accent-rose) !important; }
</style>
