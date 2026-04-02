<script lang="ts">
	/**
	 * Admin Page — Database management, user management, and team management.
	 *
	 * Provides board management (delete, clear cards/categories),
	 * user management (create, roles, delete), team management,
	 * database operations (reset, vacuum), and import/export.
	 */
	import type { PageData } from './$types';
	import { invalidateAll, goto } from '$app/navigation';
	import { theme } from '$lib/stores/theme';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';

	let { data }: { data: PageData } = $props();

	let currentTheme = $state('light');
	theme.subscribe((v) => (currentTheme = v));

	let isSuperadmin = $derived(data.currentUser?.role === 'superadmin');

	/** Confirm modal state for destructive admin actions. */
	let confirmAction = $state<{ show: boolean; title: string; message: string; action: () => Promise<void> }>({
		show: false, title: '', message: '', action: async () => {}
	});

	let toast = $state('');
	let toastType = $state<'success' | 'error'>('success');
	let importing = $state(false);
	let exporting = $state(false);

	/** Shows a temporary toast notification that auto-dismisses after 4s. */
	function showToast(msg: string, type: 'success' | 'error' = 'success') {
		toast = msg;
		toastType = type;
		setTimeout(() => (toast = ''), 4000);
	}

	/** Opens the confirm modal for a destructive action. */
	function confirm(title: string, message: string, action: () => Promise<void>) {
		confirmAction = { show: true, title, message, action };
	}

	// ─── Board Management ─────────────────────────────────────────────────

	async function deleteBoard(id: number) {
		await fetch(`/api/boards/${id}`, { method: 'DELETE' });
		await invalidateAll();
		showToast('Board deleted');
	}

	async function clearBoardCards(id: number) {
		await fetch(`/api/admin/boards/${id}/clear-cards`, { method: 'POST' });
		await invalidateAll();
		showToast('All cards cleared from board');
	}

	async function clearBoardCategories(id: number) {
		await fetch(`/api/admin/boards/${id}/clear-categories`, { method: 'POST' });
		await invalidateAll();
		showToast('All categories cleared from board');
	}

	async function resetDatabase() {
		const res = await fetch('/api/admin/reset', { method: 'POST' });
		const data = await res.json();
		if (data.redirect) {
			window.location.href = data.redirect;
		}
	}

	async function vacuumDatabase() {
		await fetch('/api/admin/vacuum', { method: 'POST' });
		showToast('Database vacuumed — IDs will restart from 1 for new records');
	}

	async function exportDatabase() {
		exporting = true;
		try {
			const res = await fetch('/api/admin/export');
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `dumpfire-backup-${new Date().toISOString().slice(0, 10)}.json`;
			document.body.append(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
			showToast('Database exported successfully');
		} catch {
			showToast('Export failed', 'error');
		} finally {
			exporting = false;
		}
	}

	let fileInput: HTMLInputElement;

	async function importDatabase() {
		fileInput?.click();
	}

	async function handleFileSelected(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;

		importing = true;
		try {
			const text = await file.text();
			const data = JSON.parse(text);

			if (!data.version || !data.boards) {
				showToast('Invalid backup file format', 'error');
				return;
			}

			const res = await fetch('/api/admin/import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: text
			});

			const result = await res.json();
			if (res.ok) {
				await invalidateAll();
				showToast(result.message || 'Database imported successfully');
			} else {
				showToast(result.error || 'Import failed', 'error');
			}
		} catch {
			showToast('Invalid backup file', 'error');
		} finally {
			importing = false;
			if (fileInput) fileInput.value = '';
		}
	}

	// ─── User Management ──────────────────────────────────────────────────

	let showCreateUser = $state(false);
	let newUsername = $state('');
	let newEmail = $state('');
	let newPassword = $state('');
	let newUserRole = $state('user');
	let newUserEmoji = $state('👤');
	let creatingUser = $state(false);



	async function createUser() {
		if (!newUsername.trim() || !newEmail.trim()) return;
		// Password required if non-empty, must be 8+ chars
		if (newPassword && newPassword.length < 8) {
			showToast('Password must be at least 8 characters', 'error');
			return;
		}
		creatingUser = true;
		try {
			const body: Record<string, unknown> = {
				username: newUsername.trim(),
				email: newEmail.trim(),
				emoji: newUserEmoji,
				role: newUserRole
			};
			if (newPassword) body.password = newPassword;
			const res = await fetch('/api/users', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (res.ok) {
				const result = await res.json();
				showCreateUser = false;
				newUsername = ''; newEmail = ''; newPassword = ''; newUserRole = 'user'; newUserEmoji = '👤';
				await invalidateAll();
				showToast(result.invited ? 'User created — invite email sent!' : 'User created');
			} else {
				const err = await res.json();
				showToast(err.message || 'Failed to create user', 'error');
			}
		} catch {
			showToast('Failed to create user', 'error');
		}
		creatingUser = false;
	}

	async function changeUserRole(userId: number, newRole: string) {
		const res = await fetch(`/api/users/${userId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ role: newRole })
		});
		if (res.ok) {
			await invalidateAll();
			showToast('Role updated');
		} else {
			const err = await res.json();
			showToast(err.message || 'Failed to update role', 'error');
		}
	}

	let resetPasswordUserId = $state<number | null>(null);
	let resetPasswordValue = $state('');

	async function resetPassword() {
		if (!resetPasswordUserId || !resetPasswordValue || resetPasswordValue.length < 8) return;
		const res = await fetch(`/api/users/${resetPasswordUserId}/password`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password: resetPasswordValue })
		});
		if (res.ok) {
			resetPasswordUserId = null;
			resetPasswordValue = '';
			showToast('Password reset');
		} else {
			showToast('Failed to reset password', 'error');
		}
	}

	async function deleteUser(userId: number) {
		const res = await fetch(`/api/users/${userId}`, { method: 'DELETE' });
		if (res.ok) {
			await invalidateAll();
			showToast('User deleted');
		} else {
			const err = await res.json();
			showToast(err.message || 'Failed to delete user', 'error');
		}
	}

	async function resendInvite(userId: number) {
		const res = await fetch(`/api/users/${userId}/invite`, { method: 'POST' });
		if (res.ok) {
			const result = await res.json();
			showToast(result.message || 'Invite sent!');
		} else {
			const err = await res.json();
			showToast(err.message || 'Failed to send invite', 'error');
		}
	}

	// ─── Team Management ──────────────────────────────────────────────────

	let showCreateTeam = $state(false);
	let newTeamName = $state('');
	let newTeamEmoji = $state('🏢');

	async function createTeam() {
		if (!newTeamName.trim()) return;
		const res = await fetch('/api/teams', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: newTeamName.trim(), emoji: newTeamEmoji })
		});
		if (res.ok) {
			showCreateTeam = false;
			newTeamName = ''; newTeamEmoji = '🏢';
			await invalidateAll();
			showToast('Team created');
		} else {
			showToast('Failed to create team', 'error');
		}
	}

	async function deleteTeam(teamId: number) {
		await fetch(`/api/teams/${teamId}`, { method: 'DELETE' });
		await invalidateAll();
		showToast('Team deleted');
	}

	let addMemberTeamId = $state<number | null>(null);
	let addMemberUserId = $state<number | null>(null);
	let addMemberRole = $state('member');

	async function addTeamMember() {
		if (!addMemberTeamId || !addMemberUserId) return;
		const res = await fetch(`/api/teams/${addMemberTeamId}/members/${addMemberUserId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId: addMemberUserId, role: addMemberRole })
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

	// ─── SMTP Configuration ───────────────────────────────────────────────

	let smtpHost = $state('');
	let smtpPort = $state(587);
	let smtpSecure = $state(false);
	let smtpUser = $state('');
	let smtpPass = $state('');
	let smtpFromAddress = $state('');
	let smtpFromName = $state('DumpFire');
	let appUrl = $state('');
	let smtpLoading = $state(true);
	let smtpSaving = $state(false);
	let smtpTesting = $state(false);
	let smtpMessage = $state('');
	let smtpIsError = $state(false);

	$effect(() => {
		loadSmtpConfig();
	});

	async function loadSmtpConfig() {
		smtpLoading = true;
		try {
			const res = await fetch('/api/admin/smtp');
			if (res.ok) {
				const data = await res.json();
				if (data.configured) {
					smtpHost = data.host || '';
					smtpPort = data.port || 587;
					smtpSecure = data.secure || false;
					smtpUser = data.user || '';
					smtpPass = data.pass || '';
					smtpFromAddress = data.fromAddress || '';
				smtpFromName = data.fromName || 'DumpFire';
				appUrl = data.appUrl || '';
				}
			}
		} catch {}
		smtpLoading = false;
	}

	async function saveSmtp() {
		smtpSaving = true;
		smtpMessage = '';
		try {
			const res = await fetch('/api/admin/smtp', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					host: smtpHost, port: smtpPort, secure: smtpSecure,
					user: smtpUser, pass: smtpPass,
					fromAddress: smtpFromAddress, fromName: smtpFromName,
					appUrl
				})
			});
			if (res.ok) {
				smtpMessage = 'SMTP settings saved!';
				smtpIsError = false;
			} else {
				smtpMessage = 'Failed to save SMTP settings';
				smtpIsError = true;
			}
		} catch {
			smtpMessage = 'Failed to save SMTP settings';
			smtpIsError = true;
		}
		smtpSaving = false;
		setTimeout(() => (smtpMessage = ''), 5000);
	}

	async function testSmtp() {
		smtpTesting = true;
		smtpMessage = '';
		try {
			const res = await fetch('/api/admin/smtp', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ to: data.currentUser?.email })
			});
			const result = await res.json();
			if (res.ok) {
				smtpMessage = result.message || 'Test email sent!';
				smtpIsError = false;
			} else {
				smtpMessage = result.message || 'Test email failed';
				smtpIsError = true;
			}
		} catch {
			smtpMessage = 'Test email failed';
			smtpIsError = true;
		}
		smtpTesting = false;
		setTimeout(() => (smtpMessage = ''), 8000);
	}
</script>

<svelte:head>
	<title>Admin — DumpFire</title>
</svelte:head>

<div class="admin-page">
	<header class="admin-header">
		<div class="admin-header-left">
			<a href="/" class="back-btn btn-ghost">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</a>
			<h1>⚙️ Admin Panel</h1>
		</div>
		<div class="admin-header-right">
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
		</div>
	</header>

	<main class="admin-content">
		<!-- Database stats -->
		<section class="admin-card glass fade-in-up" style="animation-delay: 0ms">
			<h2>📊 Database Overview</h2>
			<div class="stats-row">
				<div class="stat-item">
					<span class="stat-value">{data.boards.length}</span>
					<span class="stat-label">Boards</span>
				</div>
				<div class="stat-item">
					<span class="stat-value">{data.boards.reduce((s, b) => s + b.columnCount, 0)}</span>
					<span class="stat-label">Columns</span>
				</div>
				<div class="stat-item">
					<span class="stat-value">{data.boards.reduce((s, b) => s + b.cardCount, 0)}</span>
					<span class="stat-label">Cards</span>
				</div>
				<div class="stat-item">
					<span class="stat-value">{data.boards.reduce((s, b) => s + b.categoryCount, 0)}</span>
					<span class="stat-label">Categories</span>
				</div>
				<div class="stat-item">
					<span class="stat-value">{data.users.length}</span>
					<span class="stat-label">Users</span>
				</div>
				<div class="stat-item">
					<span class="stat-value">{data.teams.length}</span>
					<span class="stat-label">Teams</span>
				</div>
			</div>
		</section>

		<!-- Backup & Restore -->
		<section class="admin-card glass fade-in-up" style="animation-delay: 80ms">
			<h2>💾 Backup & Restore</h2>
			<p class="section-desc">Export a full backup of your database as JSON, or restore from a previous backup.</p>

			<div class="backup-actions">
				<div class="backup-item">
					<div class="backup-icon export-icon">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
							<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
					</div>
					<div class="backup-info">
						<strong>Export Database</strong>
						<p>Download a full JSON backup of all boards, cards, categories, subtasks, and user data.</p>
					</div>
					<button class="btn-backup export" onclick={exportDatabase} disabled={exporting}>
						{#if exporting}
							<span class="spinner"></span> Exporting...
						{:else}
							<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v8m0 0l-3-3m3 3l3-3M2 11v1a1 1 0 001 1h8a1 1 0 001-1v-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
							Export Backup
						{/if}
					</button>
				</div>

				<div class="backup-item">
					<div class="backup-icon import-icon">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
							<path d="M12 15V3m0 0l-4 4m4-4l4 4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
					</div>
					<div class="backup-info">
						<strong>Import Database</strong>
						<p>Restore from a backup file. <span class="warning-text">This will replace ALL current data.</span></p>
					</div>
					<button class="btn-backup import" onclick={() => confirm('Import Database', 'This will REPLACE all existing data with the backup. Current boards, cards, and user data will be overwritten. Continue?', importDatabase)} disabled={importing}>
						{#if importing}
							<span class="spinner"></span> Importing...
						{:else}
							<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 12V4m0 0L4 7m3-3l3 3M2 2v1a1 1 0 001 1h8a1 1 0 001-1V2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
							Import Backup
						{/if}
					</button>
				</div>
			</div>

			<input type="file" accept=".json" class="hidden-input" bind:this={fileInput} onchange={handleFileSelected} />
		</section>

		<!-- Board management -->
		<section class="admin-card glass fade-in-up" style="animation-delay: 160ms">
			<h2>📋 Board Management</h2>
			<p class="section-desc">Selectively manage or clear data from individual boards.</p>

			{#if data.boards.length === 0}
				<p class="empty-msg">No boards in the database.</p>
			{:else}
				<div class="board-list">
					{#each data.boards as board, i (board.id)}
						<div class="board-row fade-in-up" style="animation-delay: {200 + i * 60}ms">
							<div class="board-info">
								<span class="board-emoji">{board.emoji}</span>
								<div>
									<span class="board-name">{board.name}</span>
									<span class="board-meta">
										ID: {board.id} · {board.columnCount} cols · {board.cardCount} cards · {board.categoryCount} cats
									</span>
								</div>
							</div>
							<div class="board-actions">
								<button class="btn-ghost action-btn" onclick={() => confirm('Clear Cards', `Remove all cards from "${board.name}"? Columns and categories will be kept.`, () => clearBoardCards(board.id))}>
									<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 3h10M3 3V2a1 1 0 011-1h4a1 1 0 011 1v1m-6 0v7a1 1 0 001 1h4a1 1 0 001-1V3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>
									Clear Cards
								</button>
								<button class="btn-ghost action-btn" onclick={() => confirm('Clear Categories', `Remove all categories from "${board.name}"?`, () => clearBoardCategories(board.id))}>
									Clear Cats
								</button>
								<button class="btn-ghost action-btn danger" onclick={() => confirm('Delete Board', `Permanently delete "${board.name}" and ALL its data? This cannot be undone.`, () => deleteBoard(board.id))}>
									Delete
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<!-- User Management -->
		<section class="admin-card glass fade-in-up" style="animation-delay: 200ms">
			<div class="section-header">
				<h2>👥 User Management</h2>
				<button class="btn-primary btn-sm" onclick={() => (showCreateUser = true)}>+ Add User</button>
			</div>

			{#if showCreateUser}
				<div class="inline-form">
					<div class="form-row">
						<input type="text" placeholder="Username" bind:value={newUsername} class="form-input" />
						<input type="email" placeholder="Email" bind:value={newEmail} class="form-input" />
						<input type="password" placeholder="Password (blank = send invite)" bind:value={newPassword} class="form-input" />
					</div>
					<div class="form-row">
						<EmojiPicker value={newUserEmoji} onSelect={(e) => (newUserEmoji = e)} />
						<select bind:value={newUserRole} class="form-input">
							<option value="user">User</option>
							{#if isSuperadmin}<option value="admin">Admin</option>{/if}
						</select>
						<button class="btn-primary btn-sm" onclick={createUser} disabled={creatingUser || !newUsername || !newEmail}>
							{creatingUser ? 'Creating...' : 'Create'}
						</button>
						<button class="btn-ghost btn-sm" onclick={() => (showCreateUser = false)}>Cancel</button>
					</div>
				</div>
			{/if}

			{#if data.users.length === 0}
				<p class="empty-msg">No users yet.</p>
			{:else}
				<div class="user-list">
					{#each data.users as u (u.id)}
						<div class="user-row">
							<span class="user-row-emoji">{u.emoji}</span>
							<div class="user-row-info">
								<span class="user-row-name">{u.username}</span>
								<span class="user-row-email">{u.email}</span>
							</div>
							<span class="role-badge role-{u.role}">{u.role}</span>
							{#if u.role !== 'superadmin'}
								<select
									value={u.role}
									onchange={(e) => changeUserRole(u.id, (e.target as HTMLSelectElement).value)}
									class="role-select"
								>
									<option value="user">User</option>
									{#if isSuperadmin}<option value="admin">Admin</option>{/if}
								</select>
								<button class="btn-ghost btn-sm" onclick={() => { resetPasswordUserId = u.id; resetPasswordValue = ''; }} title="Reset password">🔑</button>
								<button class="btn-ghost btn-sm" onclick={() => resendInvite(u.id)} title="Resend invite email">📧</button>
								<button class="btn-ghost btn-sm danger" onclick={() => confirm('Delete User', `Delete user "${u.username}"? This removes them from all teams and boards.`, () => deleteUser(u.id))} title="Delete user">🗑️</button>
							{:else}
								<span class="superadmin-lock" title="Superadmin cannot be modified">🔒</span>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<!-- Password Reset Modal (inline) -->
		{#if resetPasswordUserId}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div class="modal-overlay" onclick={() => (resetPasswordUserId = null)} role="dialog" aria-modal="true">
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<div class="modal-content" onclick={(e) => e.stopPropagation()} role="document">
					<h2>🔑 Reset Password</h2>
					<p>Enter a new password for {data.users.find(u => u.id === resetPasswordUserId)?.username || 'user'}.</p>
					<input type="password" placeholder="New password (min 8 chars)" bind:value={resetPasswordValue} class="form-input" style="width: 100%; margin: var(--space-md) 0;" />
					<div class="modal-actions">
						<button class="btn-ghost" onclick={() => (resetPasswordUserId = null)}>Cancel</button>
						<button class="btn-primary" onclick={resetPassword} disabled={resetPasswordValue.length < 8}>Reset Password</button>
					</div>
				</div>
			</div>
		{/if}

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
								<select class="form-input" onchange={(e) => { addMemberTeamId = team.id; addMemberUserId = Number((e.target as HTMLSelectElement).value); }}>
									<option value="">Add member...</option>
									{#each data.users.filter(u => !team.members.some(m => m.userId === u.id)) as u}
										<option value={u.id}>{u.emoji} {u.username}</option>
									{/each}
								</select>
								{#if addMemberTeamId === team.id && addMemberUserId}
									<button class="btn-primary btn-xs" onclick={addTeamMember}>Add</button>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<!-- SMTP Configuration -->
		<section class="admin-card glass fade-in-up" style="animation-delay: 220ms">
			<h2>📧 Email / SMTP</h2>
			<p class="section-desc">Configure SMTP to enable email notifications, user invites, and task alerts.</p>

			{#if smtpLoading}
				<p class="empty-msg">Loading SMTP config...</p>
			{:else}
				<div class="inline-form">
					<div class="form-row">
						<input type="text" placeholder="SMTP Host" bind:value={smtpHost} class="form-input" />
						<input type="number" placeholder="Port" bind:value={smtpPort} class="form-input" style="width: 80px; flex: none" />
					</div>
					<div class="form-row">
						<input type="text" placeholder="Username" bind:value={smtpUser} class="form-input" />
						<input type="password" placeholder="Password" bind:value={smtpPass} class="form-input" />
					</div>
					<div class="form-row">
						<input type="email" placeholder="From Email" bind:value={smtpFromAddress} class="form-input" />
						<input type="text" placeholder="From Name" bind:value={smtpFromName} class="form-input" />
					</div>
					<div class="form-row">
						<input type="url" placeholder="App URL (e.g. https://kanban.example.com)" bind:value={appUrl} class="form-input" style="flex: 2" />
						<span style="font-size: 0.68rem; color: var(--text-tertiary); white-space: nowrap">Used in invite links</span>
					</div>
					<div class="form-row">
						<label style="display: flex; align-items: center; gap: var(--space-xs); font-size: 0.78rem; color: var(--text-secondary); cursor: pointer">
							<input type="checkbox" bind:checked={smtpSecure} /> Use SSL/TLS
						</label>
						<div style="flex: 1"></div>
						<button class="btn-ghost btn-sm" onclick={testSmtp} disabled={!smtpHost || smtpTesting}>🧪 {smtpTesting ? 'Sending...' : 'Send Test'}</button>
						<button class="btn-primary btn-sm" onclick={saveSmtp} disabled={!smtpHost || smtpSaving}>{smtpSaving ? 'Saving...' : 'Save SMTP'}</button>
					</div>
					{#if smtpMessage}
						<p class="smtp-msg" class:smtp-error={smtpIsError} class:smtp-success={!smtpIsError}>{smtpMessage}</p>
					{/if}
				</div>
			{/if}
		</section>

		<!-- Danger zone -->
		<section class="admin-card glass danger-zone fade-in-up" style="animation-delay: 240ms">
			<h2>⚠️ Danger Zone</h2>
			<p class="section-desc">These actions affect the entire database. Use with caution.</p>

			<div class="danger-actions">
				<div class="danger-item">
					<div>
						<strong>Vacuum Database</strong>
						<p>Reclaims unused space and resets auto-increment IDs for deleted records. New boards/cards will get lower IDs.</p>
					</div>
					<button class="btn-outline" onclick={() => confirm('Vacuum Database', 'This will optimise the database and reset auto-increment counters. Existing data is not affected.', vacuumDatabase)}>
						Vacuum
					</button>
				</div>
				<div class="danger-item">
					<div>
						<strong>Reset Everything</strong>
						<p>Deletes ALL data including boards, users, teams, and sessions. You will be redirected to initial setup.</p>
					</div>
					<button class="btn-danger-solid" onclick={() => confirm('Reset Everything', 'This will DELETE EVERYTHING — all boards, users, teams, and settings. You will need to set up DumpFire from scratch. Are you absolutely sure?', resetDatabase)}>
						Reset Everything
					</button>
				</div>
			</div>
		</section>
	</main>
</div>

<!-- Confirm dialog -->
{#if confirmAction.show}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-overlay" onclick={() => (confirmAction.show = false)} role="dialog" aria-modal="true">
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="modal-content confirm-modal" onclick={(e) => e.stopPropagation()} role="document">
			<h2>{confirmAction.title}</h2>
			<p>{confirmAction.message}</p>
			<div class="modal-actions">
				<button class="btn-ghost" onclick={() => (confirmAction.show = false)}>Cancel</button>
				<button class="btn-danger-solid" onclick={async () => { confirmAction.show = false; await confirmAction.action(); }}>Confirm</button>
			</div>
		</div>
	</div>
{/if}

<!-- Toast -->
{#if toast}
	<div class="toast-notification" class:toast-error={toastType === 'error'}>{toast}</div>
{/if}

<style>
	.admin-page { min-height: 100vh; }

	.admin-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-md) var(--space-xl); border-bottom: 1px solid var(--glass-border);
	}
	.admin-header-left { display: flex; align-items: center; gap: var(--space-md); }
	.admin-header-left h1 { font-size: 1.25rem; }
	.admin-header-right { display: flex; gap: var(--space-sm); }
	.back-btn { padding: var(--space-sm); }

	.admin-content {
		max-width: 800px; margin: 0 auto; padding: var(--space-2xl);
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

	.admin-card {
		padding: var(--space-xl); border-radius: var(--radius-lg);
		transition: transform 0.2s ease, box-shadow 0.2s ease;
	}
	.admin-card:hover {
		transform: translateY(-1px);
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
	}
	.admin-card h2 { font-size: 1.05rem; margin-bottom: var(--space-sm); }
	.section-desc { font-size: 0.85rem; color: var(--text-secondary); margin-bottom: var(--space-lg); }

	.stats-row {
		display: flex; gap: var(--space-lg); flex-wrap: wrap;
	}
	.stat-item {
		display: flex; flex-direction: column; align-items: center; gap: 2px;
		padding: var(--space-md) var(--space-xl);
		background: var(--bg-base); border-radius: var(--radius-md);
		border: 1px solid var(--glass-border); flex: 1; min-width: 100px;
		transition: transform 0.2s ease, border-color 0.2s ease;
	}
	.stat-item:hover {
		transform: scale(1.03);
		border-color: var(--accent-indigo);
	}
	.stat-value { font-size: 1.8rem; font-weight: 800; color: var(--accent-indigo); }
	.stat-label { font-size: 0.72rem; text-transform: uppercase; font-weight: 600; color: var(--text-tertiary); letter-spacing: 0.05em; }

	/* Backup & Restore */
	.backup-actions { display: flex; flex-direction: column; gap: var(--space-md); }
	.backup-item {
		display: flex; align-items: center; gap: var(--space-lg);
		padding: var(--space-lg); background: var(--bg-base);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
		transition: border-color 0.2s ease, transform 0.2s ease;
	}
	.backup-item:hover { border-color: var(--accent-indigo); transform: translateX(2px); }
	.backup-icon {
		width: 48px; height: 48px; border-radius: var(--radius-md);
		display: flex; align-items: center; justify-content: center;
		flex-shrink: 0;
	}
	.export-icon { background: rgba(52, 211, 153, 0.1); color: var(--accent-emerald); }
	.import-icon { background: rgba(99, 102, 241, 0.1); color: var(--accent-indigo); }
	.backup-info { flex: 1; }
	.backup-info strong { font-size: 0.9rem; display: block; margin-bottom: 4px; }
	.backup-info p { font-size: 0.78rem; color: var(--text-tertiary); margin: 0; line-height: 1.4; }
	.warning-text { color: var(--accent-amber); font-weight: 600; }

	.btn-backup {
		padding: var(--space-sm) var(--space-lg); border-radius: var(--radius-sm);
		font-weight: 600; font-size: 0.82rem; border: none; cursor: pointer;
		font-family: var(--font-family); white-space: nowrap;
		display: flex; align-items: center; gap: 6px;
		transition: all 0.2s ease;
	}
	.btn-backup.export {
		background: var(--accent-emerald); color: white;
	}
	.btn-backup.export:hover { background: #059669; transform: scale(1.02); }
	.btn-backup.import {
		background: var(--accent-indigo); color: white;
	}
	.btn-backup.import:hover { background: #4f46e5; transform: scale(1.02); }
	.btn-backup:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }

	.spinner {
		width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.3);
		border-top-color: white; border-radius: 50%;
		animation: spin 0.6s linear infinite;
	}
	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.hidden-input { display: none; }

	/* Board management */
	.board-list { display: flex; flex-direction: column; gap: var(--space-sm); }
	.board-row {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-md) var(--space-lg); background: var(--bg-base);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
		gap: var(--space-md); flex-wrap: wrap;
		transition: border-color 0.2s ease, transform 0.2s ease;
	}
	.board-row:hover { border-color: var(--accent-indigo); transform: translateX(2px); }
	.board-info { display: flex; align-items: center; gap: var(--space-md); }
	.board-emoji { font-size: 1.3rem; }
	.board-name { font-weight: 600; font-size: 0.9rem; display: block; }
	.board-meta { font-size: 0.72rem; color: var(--text-tertiary); }
	.board-actions { display: flex; gap: var(--space-xs); flex-wrap: wrap; }
	.action-btn {
		font-size: 0.72rem !important; padding: var(--space-xs) var(--space-sm) !important;
		display: flex; align-items: center; gap: 4px;
		transition: transform 0.15s ease;
	}
	.action-btn:hover { transform: scale(1.05); }
	.action-btn.danger { color: var(--accent-rose) !important; }

	.danger-zone { border-color: rgba(244, 63, 94, 0.2); }
	.danger-zone h2 { color: var(--accent-rose); }
	.danger-actions { display: flex; flex-direction: column; gap: var(--space-lg); }
	.danger-item {
		display: flex; justify-content: space-between; align-items: center;
		gap: var(--space-xl); padding: var(--space-md); background: var(--bg-base);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
		transition: border-color 0.2s ease;
	}
	.danger-item:hover { border-color: rgba(244, 63, 94, 0.3); }
	.danger-item strong { font-size: 0.9rem; display: block; margin-bottom: 4px; }
	.danger-item p { font-size: 0.78rem; color: var(--text-tertiary); margin: 0; max-width: 400px; }

	.btn-outline {
		padding: var(--space-sm) var(--space-lg); border-radius: var(--radius-sm);
		border: 1px solid var(--glass-border); background: transparent;
		font-weight: 500; font-size: 0.82rem; color: var(--text-secondary);
		white-space: nowrap; cursor: pointer; font-family: var(--font-family);
		transition: all 0.2s ease;
	}
	.btn-outline:hover { background: var(--glass-hover); transform: scale(1.02); }

	.btn-danger-solid {
		padding: var(--space-sm) var(--space-lg); border-radius: var(--radius-sm);
		background: var(--accent-rose); color: white; font-weight: 600;
		font-size: 0.82rem; border: none; white-space: nowrap; cursor: pointer;
		font-family: var(--font-family);
		transition: all 0.2s ease;
	}
	.btn-danger-solid:hover { background: #e11d48; transform: scale(1.02); }

	.confirm-modal { max-width: 420px; }
	.confirm-modal h2 { font-size: 1.1rem; margin-bottom: var(--space-sm); }
	.confirm-modal p { font-size: 0.85rem; color: var(--text-secondary); margin-bottom: var(--space-xl); line-height: 1.5; }
	.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-md); }

	.empty-msg { font-size: 0.85rem; color: var(--text-tertiary); text-align: center; padding: var(--space-xl); }

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

	/* Section header with title + action */
	.section-header {
		display: flex; align-items: center; justify-content: space-between;
		margin-bottom: var(--space-lg);
	}
	.section-header h2 { margin-bottom: 0; }

	/* Inline form */
	.inline-form {
		padding: var(--space-lg); background: var(--bg-base);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
		margin-bottom: var(--space-lg);
		display: flex; flex-direction: column; gap: var(--space-sm);
	}
	.form-row {
		display: flex; gap: var(--space-sm); align-items: center; flex-wrap: wrap;
	}
	.form-input {
		padding: var(--space-sm) var(--space-md);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-elevated); color: var(--text-primary);
		font-size: 0.82rem; font-family: var(--font-family);
		flex: 1; min-width: 120px;
	}
	.form-input:focus { border-color: var(--accent-indigo); outline: none; }

	.emoji-row { display: flex; gap: 4px; flex-wrap: wrap; }
	.emoji-pick {
		width: 30px; height: 30px; font-size: 1rem;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-base); cursor: pointer; transition: all 0.15s;
		display: flex; align-items: center; justify-content: center;
	}
	.emoji-pick:hover { border-color: var(--accent-purple); transform: scale(1.1); }
	.emoji-pick.active {
		border-color: var(--accent-purple); background: var(--accent-purple-glow);
		box-shadow: var(--shadow-glow-purple); transform: scale(1.1);
	}

	.btn-sm { font-size: 0.78rem !important; padding: var(--space-xs) var(--space-md) !important; }
	.btn-xs { font-size: 0.7rem !important; padding: 2px var(--space-sm) !important; }

	/* User list */
	.user-list { display: flex; flex-direction: column; gap: var(--space-xs); }
	.user-row {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md);
		background: var(--bg-base); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); transition: border-color 0.15s;
	}
	.user-row:hover { border-color: var(--accent-indigo); }
	.user-row-emoji { font-size: 1.2rem; flex-shrink: 0; }
	.user-row-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
	.user-row-name { font-weight: 600; font-size: 0.85rem; }
	.user-row-email { font-size: 0.72rem; color: var(--text-tertiary); }

	.role-badge {
		font-size: 0.65rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.05em; padding: 2px 8px; border-radius: var(--radius-sm);
	}
	.role-superadmin { background: rgba(245, 158, 11, 0.15); color: var(--accent-amber); }
	.role-admin { background: rgba(99, 102, 241, 0.15); color: var(--accent-indigo); }
	.role-user { background: rgba(100, 116, 139, 0.15); color: var(--text-secondary); }

	.role-select {
		padding: 2px var(--space-sm); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); background: var(--bg-base);
		color: var(--text-secondary); font-size: 0.72rem; font-weight: 600;
		cursor: pointer; font-family: var(--font-family);
	}

	.superadmin-lock { font-size: 0.9rem; opacity: 0.5; }

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

	.danger { color: var(--accent-rose) !important; }

	/* SMTP */
	.smtp-msg {
		font-size: 0.78rem; font-weight: 500; padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm); margin-top: var(--space-sm);
	}
	.smtp-success { background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); color: var(--accent-emerald); }
	.smtp-error { background: rgba(244, 63, 94, 0.1); border: 1px solid rgba(244, 63, 94, 0.3); color: var(--accent-rose); }
</style>
