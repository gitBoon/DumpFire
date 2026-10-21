<script lang="ts">
	/**
	 * ShareModal — Board sharing & access management modal.
	 *
	 * Allows board owners/admins to share boards with individual users
	 * or teams, set permission levels, manage existing access,
	 * and toggle public visibility.
	 *
	 * A write that is refused, or gets no answer, is said on one line in the
	 * window, above its Close button, in the server's words (card 2148): each
	 * used to look saved whatever the answer was.
	 *
	 * A webhook is sent only while the account that set it up can open the
	 * board (card 2325), and no screen showed one that had stopped (card 2329).
	 * So ✕ on a person or a team whose removal would stop webhooks asks first,
	 * saying how many, and the window says how many of the board's webhooks
	 * send nothing now, whatever stopped them. Both counts come with the list,
	 * to the board's owner and an administrator only.
	 */
	import { deleteFailure, failureMessage } from '$lib/api';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { tick } from 'svelte';

	// An address and a role come to the board's owner and an administrator only
	// (card 2128): the lists name everyone else without them. So does
	// `stopsWebhooks`, how many webhooks sent now the share's removal would stop.
	type ShareMember = { userId: number; username: string; email?: string; emoji: string; role: string; stopsWebhooks?: number };
	type ShareTeam = { teamId: number; teamName: string; teamEmoji: string; role: string; stopsWebhooks?: number };
	type AvailableUser = { id: number; username: string; email?: string; emoji: string; role?: string };
	type AvailableTeam = { id: number; name: string; emoji: string };

	let {
		boardId,
		boardName,
		canManage = true,
		onClose
	}: {
		boardId: number;
		boardName: string;
		canManage?: boolean;
		onClose: () => void;
	} = $props();

	let members = $state<ShareMember[]>([]);
	let teamAccess = $state<ShareTeam[]>([]);
	let allUsers = $state<AvailableUser[]>([]);
	let allTeams = $state<AvailableTeam[]>([]);
	let isPublic = $state(false);
	/** How many of the board's webhooks are on and send nothing now (card 2329); 0 for anyone not told. */
	let heldWebhooks = $state(0);
	/** The share whose removal stops webhooks, while its confirm is open. */
	let asking = $state<{ type: 'user' | 'team'; targetId: number; name: string; stops: number } | null>(null);
	let loading = $state(true);
	/** Why the last load or write failed, shown above the Close button; '' when nothing failed. */
	let error = $state('');
	let togglingPublic = $state(false);

	// Add user/team state
	let addTab = $state<'user' | 'team'>('user');
	let selectedUserId = $state<number | null>(null);
	let selectedTeamId = $state<number | null>(null);
	let selectedRole = $state('editor');

	// Load data on mount
	$effect(() => {
		loadData();
	});

	/** The window's Close button, where the focus goes when a read after a change takes away the control that had it. */
	let closeButton: HTMLButtonElement;

	/**
	 * Read the list, as the window opens and after each share added, changed
	 * or removed. Only the first read says "Loading..." (`loading` starts
	 * true); a read after a change refreshes the lists in place. It used to
	 * swap the whole list for "Loading...", which took away the ✕ the confirm
	 * hands the focus back to, and the focus fell to the page behind (the
	 * review of card 2329). A read that takes away the control with the focus
	 * (the removed row's ✕) moves the focus to Close.
	 */
	async function loadData() {
		const refresh = !loading;
		try {
			const [shareRes, usersRes, teamsRes] = await Promise.all([
				fetch(`/api/boards/${boardId}/share`),
				fetch('/api/users'),
				fetch('/api/teams')
			]);

			if (shareRes.ok) {
				const data = await shareRes.json();
				members = data.members;
				teamAccess = data.teams;
				isPublic = data.isPublic ?? false;
				heldWebhooks = typeof data.heldWebhooks === 'number' ? data.heldWebhooks : 0;
			} else {
				// A board deleted in another tab is 404 here, and the lists would be empty with no word why.
				error = await failureMessage(shareRes, 'The sharing settings could not be loaded.');
			}

			if (usersRes.ok) {
				allUsers = await usersRes.json();
			}

			if (teamsRes.ok) {
				allTeams = await teamsRes.json();
			}
		} catch {
			error = 'No answer from the server. The sharing settings could not be loaded.';
		}
		loading = false;
		if (!refresh) return;
		await tick();
		const at = document.activeElement;
		if (!at || at === document.body || !at.isConnected) closeButton?.focus();
	}

	/** Users not already shared with */
	let availableUsers = $derived(
		allUsers.filter(u => !members.some(m => m.userId === u.id))
	);

	/** Teams not already shared with */
	let availableTeams = $derived(
		allTeams.filter(t => !teamAccess.some(ta => ta.teamId === t.id))
	);

	async function togglePublic() {
		togglingPublic = true;
		error = '';
		try {
			const res = await fetch(`/api/boards/${boardId}/share`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ isPublic: !isPublic })
			});
			if (res.ok) {
				isPublic = !isPublic;
			} else {
				error = await failureMessage(res, 'The board’s visibility was not changed.');
			}
		} catch {
			error = 'No answer from the server. The board’s visibility may not have been changed.';
		} finally {
			togglingPublic = false;
		}
	}

	async function shareWithUser() {
		if (!selectedUserId) return;
		error = '';
		try {
			const res = await fetch(`/api/boards/${boardId}/share`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ type: 'user', targetId: selectedUserId, role: selectedRole })
			});
			if (res.ok) {
				selectedUserId = null;
				await loadData();
			} else {
				error = await failureMessage(res, 'The board was not shared.');
			}
		} catch {
			error = 'No answer from the server. The board may not have been shared.';
		}
	}

	async function shareWithTeam() {
		if (!selectedTeamId) return;
		error = '';
		try {
			const res = await fetch(`/api/boards/${boardId}/share`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ type: 'team', targetId: selectedTeamId, role: selectedRole })
			});
			if (res.ok) {
				selectedTeamId = null;
				await loadData();
			} else {
				error = await failureMessage(res, 'The board was not shared.');
			}
		} catch {
			error = 'No answer from the server. The board may not have been shared.';
		}
	}

	/**
	 * Change the role of a person or a team the board is shared with, to what
	 * `select` now shows. A refusal is said in the server's words, on the
	 * window's line, and the select is put back to the role that is stored:
	 * reading the list again would not redraw a select whose value has not
	 * changed, so it would go on showing the role that was refused.
	 */
	async function updateRole(type: 'user' | 'team', targetId: number, select: HTMLSelectElement) {
		const stored =
			type === 'user'
				? members.find(m => m.userId === targetId)?.role
				: teamAccess.find(t => t.teamId === targetId)?.role;
		const putBack = () => {
			if (stored !== undefined) select.value = stored;
		};
		error = '';
		let res: Response;
		try {
			res = await fetch(`/api/boards/${boardId}/share`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ type, targetId, role: select.value })
			});
		} catch {
			putBack();
			error = 'No answer from the server. The role may not have been changed.';
			return;
		}
		if (res.ok) {
			await loadData();
		} else {
			putBack();
			error = await failureMessage(res, 'The role was not changed.');
		}
	}

	async function removeAccess(type: 'user' | 'team', targetId: number) {
		error = '';
		const failure = await deleteFailure(
			() =>
				fetch(`/api/boards/${boardId}/share`, {
					method: 'DELETE',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ type, targetId })
				}),
			type === 'user' ? 'person' : 'team',
			'removed'
		);
		if (failure) {
			error = failure;
			return;
		}
		await loadData();
	}

	/**
	 * ✕ on a person or a team: asks first when their removal stops webhooks
	 * (card 2329), and removes at once otherwise, as it always did.
	 */
	function askToRemove(type: 'user' | 'team', targetId: number) {
		const share =
			type === 'user'
				? members.find(m => m.userId === targetId)
				: teamAccess.find(t => t.teamId === targetId);
		const stops = share?.stopsWebhooks ?? 0;
		if (!share || stops === 0) {
			removeAccess(type, targetId);
			return;
		}
		const name = 'username' in share ? share.username : share.teamName;
		asking = { type, targetId, name, stops };
	}

	/** What the confirm says: who, how many, and what brings a stopped webhook back. */
	function stopsMessage(ask: NonNullable<typeof asking>): string {
		const one = ask.stops === 1;
		const hooks = one ? '1 webhook' : `${ask.stops} webhooks`;
		const it = one ? 'it' : 'them';
		return ask.type === 'user'
			? `Removing ${ask.name} stops ${hooks} they set up on this board: nothing is sent to ${it} until they can open the board again, or someone takes ${it} over.`
			: `Removing ${ask.name} stops ${hooks} set up by its members on this board: nothing is sent to ${it} until those members can open the board again, or someone takes ${it} over.`;
	}

	function confirmRemove() {
		if (!asking) return;
		const { type, targetId } = asking;
		asking = null;
		removeAccess(type, targetId);
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Share board">
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-content share-modal" onclick={(e) => e.stopPropagation()} role="document">
		<div class="share-header">
			<h2>🔗 Share Board</h2>
			<p class="share-board-name">{boardName}</p>
		</div>

		{#if loading}
			<div class="share-loading">
				<span class="spinner"></span>
				Loading...
			</div>
		{:else}
			<!-- Webhooks that send nothing now, whatever stopped them (card 2329). The count comes to the board's owner and an administrator alone. -->
			{#if heldWebhooks > 0}
				<p class="share-held">
					⚠️ {heldWebhooks === 1 ? '1 webhook on this board sends' : `${heldWebhooks} webhooks on this board send`} nothing: the account that set each up can no longer open the board, or nobody is recorded as setting it up.
					Read the board's webhooks with your API key (GET /api/v1/boards/{boardId}/webhooks) to see why each is held, and delete it or take it over.
				</p>
			{/if}

			<!-- Public visibility toggle -->
			{#if canManage}
				<div class="public-toggle-section">
					<div class="public-toggle-info">
						<span class="public-toggle-icon">{isPublic ? '🌐' : '🔒'}</span>
						<div class="public-toggle-text">
							<strong>{isPublic ? 'Public Board' : 'Private Board'}</strong>
							<p>{isPublic ? 'Anyone with an account can view this board' : 'Only shared users and teams can access this board'}</p>
						</div>
					</div>
					<button
						class="toggle-switch"
						class:active={isPublic}
						onclick={togglePublic}
						disabled={togglingPublic}
						title={isPublic ? 'Make private' : 'Make public'}
					>
						<span class="toggle-knob"></span>
					</button>
				</div>
			{:else if isPublic}
				<div class="public-badge-row">
					<span class="public-badge">🌐 Public Board</span>
					<span class="public-badge-desc">Everyone can view this board</span>
				</div>
			{/if}

			<!-- Add new access -->
			{#if canManage}
				<div class="share-add-section">
					<div class="share-tabs">
						<button class="share-tab" class:active={addTab === 'user'} onclick={() => (addTab = 'user')}>
							👤 User
						</button>
						<button class="share-tab" class:active={addTab === 'team'} onclick={() => (addTab = 'team')}>
							🏢 Team
						</button>
					</div>

					<div class="share-add-form">
						{#if addTab === 'user'}
							<select bind:value={selectedUserId} class="share-select">
								<option value={null}>Select a user...</option>
								{#each availableUsers as u}
									<option value={u.id}>{u.emoji} {u.username}{u.email ? ` (${u.email})` : ''}</option>
								{/each}
							</select>
						{:else}
							<select bind:value={selectedTeamId} class="share-select">
								<option value={null}>Select a team...</option>
								{#each availableTeams as t}
									<option value={t.id}>{t.emoji} {t.name}</option>
								{/each}
							</select>
						{/if}

						<select bind:value={selectedRole} class="share-role-select">
							<option value="viewer">👁️ Viewer</option>
							<option value="editor">✏️ Editor</option>
						</select>

						<button
							class="btn-primary share-add-btn"
							onclick={addTab === 'user' ? shareWithUser : shareWithTeam}
							disabled={addTab === 'user' ? !selectedUserId : !selectedTeamId}
						>
							Share
						</button>
					</div>
				</div>
			{/if}

			<!-- Current members -->
			{#if members.length > 0}
				<div class="share-section">
					<h3>👥 People</h3>
					<div class="share-list">
						{#each members as member}
							<div class="share-item">
								<span class="share-item-emoji">{member.emoji}</span>
								<div class="share-item-info">
									<span class="share-item-name">{member.username}</span>
									{#if member.email}<span class="share-item-email">{member.email}</span>{/if}
								</div>
								{#if canManage}
									<!-- No share makes anyone an owner. Owner is shown only on a row stored as one, so that it reads true. -->
									<select
										value={member.role}
										onchange={(e) => updateRole('user', member.userId, e.currentTarget)}
										class="share-role-badge"
									>
										<option value="viewer">Viewer</option>
										<option value="editor">Editor</option>
										{#if member.role === 'owner'}
											<option value="owner">Owner</option>
										{/if}
									</select>
									<button class="share-remove-btn" onclick={() => askToRemove('user', member.userId)} title="Remove access">
										<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2L2 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
									</button>
								{:else}
									<span class="share-role-text">{member.role}</span>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Team access -->
			{#if teamAccess.length > 0}
				<div class="share-section">
					<h3>🏢 Teams</h3>
					<div class="share-list">
						{#each teamAccess as team}
							<div class="share-item">
								<span class="share-item-emoji">{team.teamEmoji}</span>
								<div class="share-item-info">
									<span class="share-item-name">{team.teamName}</span>
								</div>
								{#if canManage}
									<select
										value={team.role}
										onchange={(e) => updateRole('team', team.teamId, e.currentTarget)}
										class="share-role-badge"
									>
										<option value="viewer">Viewer</option>
										<option value="editor">Editor</option>
									</select>
									<button class="share-remove-btn" onclick={() => askToRemove('team', team.teamId)} title="Remove access">
										<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2L2 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
									</button>
								{:else}
									<span class="share-role-text">{team.role}</span>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}

			{#if members.length === 0 && teamAccess.length === 0 && !isPublic}
				<div class="share-empty">
					<span>🔒</span>
					<p>Only you and admins have access to this board.</p>
				</div>
			{/if}
		{/if}

		<!-- A load or a write that failed, in the server's words, until it is closed or the next write. -->
		{#if error}
			<div class="share-error" role="alert">
				<span>{error}</span>
				<button class="share-error-close" onclick={() => (error = '')} aria-label="Close this message" type="button">✕</button>
			</div>
		{/if}

		<div class="share-footer">
			<button class="btn-ghost" onclick={onClose} bind:this={closeButton}>Close</button>
		</div>
	</div>
</div>

{#if asking}
	<ConfirmModal
		title="Remove Access"
		message={stopsMessage(asking)}
		confirmText="Remove"
		onConfirm={confirmRemove}
		onCancel={() => (asking = null)}
	/>
{/if}

<style>
	.share-modal {
		max-width: 640px;
		width: 100%;
	}

	.share-header {
		margin-bottom: var(--space-xl);
	}

	.share-header h2 {
		font-size: 1.1rem;
		margin-bottom: var(--space-xs);
	}

	.share-board-name {
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	/* Webhooks held now (card 2329): a warning, in the amber the app warns in */
	.share-held {
		margin: 0 0 var(--space-xl);
		padding: var(--space-sm) var(--space-md);
		font-size: 0.78rem;
		line-height: 1.45;
		color: var(--text-secondary);
		background: rgba(245, 158, 11, 0.08);
		border: 1px solid rgba(245, 158, 11, 0.3);
		border-radius: var(--radius-sm);
	}

	.share-loading {
		text-align: center;
		padding: var(--space-2xl);
		color: var(--text-tertiary);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-sm);
		font-size: 0.85rem;
	}

	.spinner {
		width: 16px;
		height: 16px;
		border: 2px solid var(--glass-border);
		border-top-color: var(--accent-indigo);
		border-radius: 50%;
		animation: spin 0.6s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	/* Public toggle */
	.public-toggle-section {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
		padding: var(--space-lg);
		margin-bottom: var(--space-xl);
		background: var(--bg-base);
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-md);
		transition: border-color 0.2s ease;
	}
	.public-toggle-section:hover { border-color: var(--accent-indigo); }

	.public-toggle-info {
		display: flex;
		align-items: center;
		gap: var(--space-md);
	}

	.public-toggle-icon {
		font-size: 1.5rem;
		flex-shrink: 0;
	}

	.public-toggle-text strong {
		display: block;
		font-size: 0.85rem;
		margin-bottom: 2px;
	}

	.public-toggle-text p {
		font-size: 0.72rem;
		color: var(--text-tertiary);
		margin: 0;
		line-height: 1.4;
	}

	/* Toggle switch */
	.toggle-switch {
		position: relative;
		width: 44px;
		height: 24px;
		border-radius: 12px;
		border: none;
		background: var(--glass-border);
		cursor: pointer;
		transition: all 0.25s ease;
		flex-shrink: 0;
		padding: 0;
	}

	.toggle-switch.active {
		background: var(--accent-indigo);
	}

	.toggle-switch:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.toggle-knob {
		position: absolute;
		top: 3px;
		left: 3px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: white;
		box-shadow: 0 1px 3px rgba(0,0,0,0.2);
		transition: transform 0.25s ease;
	}

	.toggle-switch.active .toggle-knob {
		transform: translateX(20px);
	}

	/* Public badge for non-owners */
	.public-badge-row {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: var(--space-md) var(--space-lg);
		margin-bottom: var(--space-xl);
		background: rgba(99, 102, 241, 0.06);
		border: 1px solid rgba(99, 102, 241, 0.2);
		border-radius: var(--radius-md);
	}

	.public-badge {
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--accent-indigo);
	}

	.public-badge-desc {
		font-size: 0.72rem;
		color: var(--text-tertiary);
	}

	/* Tabs */
	.share-add-section {
		margin-bottom: var(--space-xl);
		padding-bottom: var(--space-xl);
		border-bottom: 1px solid var(--glass-border);
	}

	.share-tabs {
		display: flex;
		gap: var(--space-xs);
		margin-bottom: var(--space-md);
	}

	.share-tab {
		padding: var(--space-xs) var(--space-md);
		border-radius: var(--radius-sm);
		font-size: 0.8rem;
		font-weight: 600;
		background: var(--bg-base);
		border: 1px solid var(--glass-border);
		color: var(--text-secondary);
		cursor: pointer;
		transition: all 0.15s ease;
		font-family: var(--font-family);
	}

	.share-tab:hover {
		border-color: var(--accent-indigo);
	}

	.share-tab.active {
		background: var(--accent-indigo);
		border-color: var(--accent-indigo);
		color: white;
	}

	.share-add-form {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
	}

	.share-select {
		flex: 1;
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm);
		border: 1px solid var(--glass-border);
		background: var(--bg-base);
		color: var(--text-primary);
		font-size: 0.82rem;
		font-family: var(--font-family);
	}

	.share-role-select {
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm);
		border: 1px solid var(--glass-border);
		background: var(--bg-base);
		color: var(--text-primary);
		font-size: 0.82rem;
		font-family: var(--font-family);
		width: 120px;
	}

	.share-add-btn {
		white-space: nowrap;
	}

	/* Sections */
	.share-section {
		margin-bottom: var(--space-lg);
	}

	.share-section h3 {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-tertiary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: var(--space-sm);
	}

	.share-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}

	.share-item {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md);
		background: var(--bg-base);
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-md);
		transition: border-color 0.15s ease;
	}

	.share-item:hover {
		border-color: var(--accent-indigo);
	}

	.share-item-emoji {
		font-size: 1.2rem;
		flex-shrink: 0;
	}

	.share-item-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.share-item-name {
		font-weight: 600;
		font-size: 0.85rem;
	}

	.share-item-email {
		font-size: 0.72rem;
		color: var(--text-tertiary);
	}

	.share-role-badge {
		padding: 2px var(--space-sm);
		border-radius: var(--radius-sm);
		border: 1px solid var(--glass-border);
		background: var(--bg-base);
		color: var(--text-secondary);
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
		font-family: var(--font-family);
	}

	.share-role-text {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--text-tertiary);
		text-transform: capitalize;
		padding: 2px var(--space-sm);
	}

	.share-remove-btn {
		width: 24px;
		height: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-sm);
		background: transparent;
		border: none;
		color: var(--text-tertiary);
		cursor: pointer;
		opacity: 0.5;
		transition: all 0.15s;
	}

	.share-remove-btn:hover {
		opacity: 1;
		color: var(--accent-rose);
		background: rgba(244, 63, 94, 0.15);
	}

	.share-empty {
		text-align: center;
		padding: var(--space-xl);
		color: var(--text-tertiary);
		font-size: 0.85rem;
	}

	.share-empty span {
		display: block;
		font-size: 2rem;
		margin-bottom: var(--space-sm);
	}

	/* A failure, as the card window shows one */
	.share-error {
		display: flex;
		align-items: flex-start;
		gap: var(--space-sm);
		margin-top: var(--space-lg);
		padding: 7px 10px;
		font-size: 0.78rem;
		line-height: 1.4;
		background: rgba(244, 63, 94, 0.1);
		color: var(--accent-rose);
		border: 1px solid rgba(244, 63, 94, 0.25);
		border-radius: var(--radius-sm);
	}

	.share-error span { flex: 1; }

	.share-error-close {
		background: none;
		border: none;
		cursor: pointer;
		padding: 0 2px;
		color: inherit;
		font-size: 0.7rem;
		opacity: 0.7;
	}

	.share-error-close:hover { opacity: 1; }

	.share-footer {
		margin-top: var(--space-xl);
		display: flex;
		justify-content: flex-end;
	}
</style>
