<!--
  DangerZonePanel.svelte — The admin page's Danger Zone: Purge Archived
  Cards, Vacuum Database, Reset All XP, and the superadmin's Reset Everything
  (card 2281, slice C1b: moved from src/routes/admin/+page.svelte).

  Shown to every administrator, Reset Everything to the superadmin alone.
  Each action asks first through the page's own confirm dialog. What a reset
  has to say is the page's (`resetNotice`, bound here): its notice is drawn
  by the page where it was, after the page's confirm dialog.
-->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { PURGE_DESCRIPTION, PURGE_WARNING, RESET_WARNING, failureMessage } from '$lib/api';
	import { sent, showToast } from '$lib/admin/send';

	let {
		isSuperadmin,
		confirm,
		resetNotice = $bindable()
	}: {
		isSuperadmin: boolean;
		/** The page's confirm dialog, which asks before each action. */
		confirm: (title: string, message: string, action: () => Promise<void>) => void;
		/** The page's: what a reset has to say that must be read, shown in its notice. */
		resetNotice: { title: string; message: string; problems: string[]; redirect: string | null } | null;
	} = $props();

	async function resetDatabase() {
		let res: Response;
		try {
			res = await fetch('/api/admin/reset', { method: 'POST' });
		} catch {
			resetNotice = {
				title: 'Reset not confirmed',
				message: 'No answer from the server, so it is not known whether the reset ran. Reload the page to find out.',
				problems: [],
				redirect: null
			};
			return;
		}
		if (!res.ok) {
			// 500 with "The reset failed and nothing was cleared: …", or a refusal.
			resetNotice = {
				title: 'Reset failed',
				message: await failureMessage(res, 'The reset failed.'),
				problems: [],
				redirect: null
			};
			return;
		}

		const result = await res.json().catch(() => null);
		const redirect = typeof result?.redirect === 'string' && result.redirect ? result.redirect : '/setup';
		const failed: string[] = Array.isArray(result?.trash?.failed) ? result.trash.failed.map(String) : [];
		if (failed.length > 0) {
			// Done, with something to read before leaving for set-up.
			resetNotice = {
				title: 'Reset done',
				message:
					'Everything was cleared, but some attachment files could not be moved to the trash and are where they were:',
				problems: failed,
				redirect
			};
			return;
		}
		window.location.href = redirect;
	}

	async function vacuumDatabase() {
		if (!(await sent(() => fetch('/api/admin/vacuum', { method: 'POST' }), 'Failed to vacuum the database'))) return;
		showToast('Database vacuumed. Unused space was reclaimed.');
	}

	async function resetAllXp() {
		if (!(await sent(() => fetch('/api/admin/reset-xp', { method: 'POST' }), 'Failed to reset XP'))) return;
		showToast('All XP has been reset to 0');
	}

	let purgingArchived = $state(false);

	async function purgeArchivedCards() {
		purgingArchived = true;
		try {
			const res = await sent(() => fetch('/api/admin/purge-archived', { method: 'POST' }), 'Failed to purge archived cards');
			if (!res) return;
			const result = await res.json().catch(() => null);
			showToast(
				typeof result?.purged === 'number'
					? `Purged ${result.purged} archived card${result.purged !== 1 ? 's' : ''} permanently`
					: 'Archived cards purged permanently'
			);
			await invalidateAll();
		} finally {
			purgingArchived = false;
		}
	}
</script>

<!-- Danger zone -->
<section class="admin-card glass danger-zone fade-in-up" style="animation-delay: 240ms">
	<h2>⚠️ Danger Zone</h2>
	<p class="section-desc">These actions affect the entire database. Use with caution.</p>

	<div class="danger-actions">
		<div class="danger-item">
			<div>
				<strong>Purge Archived Cards</strong>
				<p>{PURGE_DESCRIPTION}</p>
			</div>
			<button class="btn-outline" onclick={() => confirm('Purge Archived Cards', PURGE_WARNING, purgeArchivedCards)} disabled={purgingArchived}>
				{purgingArchived ? 'Purging...' : 'Purge All'}
			</button>
		</div>
		<div class="danger-item">
			<div>
				<strong>Vacuum Database</strong>
				<p>Rebuilds the database file to reclaim unused space. No data is changed, and ids are not reset.</p>
			</div>
			<button class="btn-outline" onclick={() => confirm('Vacuum Database', 'This rebuilds the database file to reclaim unused space. No data is changed, and ids are not reset.', vacuumDatabase)}>
				Vacuum
			</button>
		</div>
		<div class="danger-item">
			<div>
				<strong>Reset All XP</strong>
				<p>Resets everyone's XP back to 0. Leaderboard will be cleared. This cannot be undone.</p>
			</div>
			<button class="btn-outline" onclick={() => confirm('Reset All XP', 'This will set every user\'s XP to 0. The leaderboard will be completely cleared. Are you sure?', resetAllXp)}>
				Reset XP
			</button>
		</div>
		<!-- The superadmin's alone: whoever sets up after a reset is the superadmin. -->
		{#if isSuperadmin}
		<div class="danger-item">
			<div>
				<strong>Reset Everything</strong>
				<p>Deletes ALL data including boards, users, teams, and sessions. The system log and the backup history are kept. You will be redirected to initial setup.</p>
			</div>
			<button class="btn-danger-solid" onclick={() => confirm('Reset Everything', RESET_WARNING, resetDatabase)}>
				Reset Everything
			</button>
		</div>
		{/if}
	</div>
</section>

<style>
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
</style>
