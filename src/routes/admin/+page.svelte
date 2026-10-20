<script lang="ts">
	/**
	 * Admin Page — Database management, user management, and team management.
	 *
	 * Provides board management (delete, clear cards/categories),
	 * user management (create, roles, delete), team management,
	 * database operations (reset, vacuum), and import/export.
	 */
	import type { PageData } from './$types';
	import { goto } from '$app/navigation';
	import { theme } from '$lib/stores/theme';
	import ThemePicker from '$lib/components/ThemePicker.svelte';
	import Toast from '$lib/components/Toast.svelte';
	// The superadmin's panels (card 2281, slice C1a; the mail panel slice C1b), each drawn in the markup's isSuperadmin blocks alone.
	import AppUrlPanel from '$lib/components/admin/AppUrlPanel.svelte';
	import BackupRestorePanel from '$lib/components/admin/BackupRestorePanel.svelte';
	import ScheduledBackupsPanel from '$lib/components/admin/ScheduledBackupsPanel.svelte';
	import SmtpPanel from '$lib/components/admin/SmtpPanel.svelte';
	// Every administrator's panels (card 2281, slice C1b), drawn outside that block.
	import AdminOverview from '$lib/components/admin/AdminOverview.svelte';
	import BoardManagementPanel from '$lib/components/admin/BoardManagementPanel.svelte';
	import UsersPanel from '$lib/components/admin/UsersPanel.svelte';
	import InviteLinkDialog from '$lib/components/admin/InviteLinkDialog.svelte';
	import TeamsPanel from '$lib/components/admin/TeamsPanel.svelte';
	import DangerZonePanel from '$lib/components/admin/DangerZonePanel.svelte';

	let { data }: { data: PageData } = $props();

	let currentTheme = $state('light');
	theme.subscribe((v) => (currentTheme = v));

	let isSuperadmin = $derived(data.currentUser?.role === 'superadmin');

	/**
	 * Who the superadmin is, for the line an administrator is shown in place
	 * of what is the superadmin's alone: the export, the import and the reset,
	 * the scheduled backups, and the mail and App URL settings. Null if no
	 * account is one, which the server says in its log when it starts.
	 */
	let superadminName = $derived(data.users.find((u) => u.role === 'superadmin')?.username ?? null);

	/** Confirm modal state for destructive admin actions. */
	let confirmAction = $state<{ show: boolean; title: string; message: string; action: () => Promise<void> }>({
		show: false, title: '', message: '', action: async () => {}
	});

	/** Opens the confirm modal for a destructive action. */
	function confirm(title: string, message: string, action: () => Promise<void>) {
		confirmAction = { show: true, title, message, action };
	}

	/**
	 * What a reset has to say that must be read: that it failed, or that it
	 * was done and some attachment files are where they were. A toast is a
	 * line in a corner, and after a reset that was done the page is about to
	 * leave for set-up, which takes every toast with it, so this stays up
	 * until it is answered.
	 *
	 * `redirect` is where to go from it, after a reset that was done. Null
	 * when nothing was cleared and the page stays.
	 *
	 * Set by the danger zone's Reset Everything (card 2281, slice C1b: bound
	 * there), and kept here with its notice, which is drawn where it was.
	 */
	let resetNotice = $state<{ title: string; message: string; problems: string[]; redirect: string | null } | null>(null);

	/**
	 * The link of an invite whose mail was not sent, shown once in its dialog
	 * to the administrator who issued it (card 2196, decision 9). A credential:
	 * whoever opens it sets the account's password. It lives here alone, never
	 * in a toast, the address, history or storage, and is cleared on Done.
	 */
	let inviteLink = $state<{ url: string; username: string; message: string } | null>(null);

	/** The mail panel, whose read of what mail has done the users panel asks for after an invite. */
	let smtpPanel = $state<ReturnType<typeof SmtpPanel>>();
</script>

<svelte:head>
	<title>Admin — DumpFire</title>
</svelte:head>

<div class="admin-page">
	<header class="admin-header glass">
		<div class="admin-header-inner">
			<a href="/" class="header-logo" title="Back to DumpFire">
				<span class="logo-fire">🔥</span>
				<span class="logo-text">DumpFire</span>
			</a>
			<h1 class="header-title">⚙️ Admin Panel</h1>
			<div class="admin-header-right">
				<ThemePicker />
			</div>
		</div>
	</header>

	<main class="admin-content">
		<AdminOverview {data} />

		<!-- The superadmin's alone: the App URL, export and import, and the scheduled backups.
		     An administrator is refused each of them by its route, and is shown one line in their place. -->
		{#if isSuperadmin}
		<AppUrlPanel />
		<BackupRestorePanel importOutsideDefault={data.importOutsideDefault} />
		<ScheduledBackupsPanel {confirm} />
		{:else}
		<section class="admin-card glass fade-in-up" style="animation-delay: 40ms">
			<h2>🔒 The superadmin's</h2>
			<p class="section-desc" style="margin-bottom: 0">
				{#if superadminName}
					Exporting, importing and resetting the database, the scheduled backups and their destinations, and the mail and App URL settings belong to the superadmin, <strong>{superadminName}</strong>, and are on this page for that account only.
				{:else}
					Exporting, importing and resetting the database, the scheduled backups and their destinations, and the mail and App URL settings belong to the superadmin, and no account is the superadmin. Whoever runs the server can make one: see "If nobody can sign in as the superadmin" in the deployment guide.
				{/if}
			</p>
		</section>
		{/if}

		<BoardManagementPanel {data} {confirm} />

		<UsersPanel {data} {isSuperadmin} {confirm} loadMailStatus={() => smtpPanel?.loadMailStatus()} bind:inviteLink />

		<TeamsPanel {data} {confirm} />

		<!-- SMTP Configuration: the superadmin's alone, as above -->
		{#if isSuperadmin}
		<SmtpPanel bind:this={smtpPanel} currentUser={data.currentUser} />
		{/if}

		<DangerZonePanel {isSuperadmin} {confirm} bind:resetNotice />
	</main>
</div>

<!-- Confirm dialog -->
{#if confirmAction.show}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-overlay" role="dialog" aria-modal="true">
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

<!-- What a reset has to say: that it failed, or what it could not move. No way out of it but its one button. -->
{#if resetNotice}
	<div class="modal-overlay" role="alertdialog" aria-modal="true" aria-label={resetNotice.title}>
		<div class="modal-content confirm-modal" role="document" style="max-width: 520px">
			<h2>{resetNotice.title}</h2>
			<p style={resetNotice.problems.length > 0 ? 'margin-bottom: var(--space-sm)' : undefined}>{resetNotice.message}</p>
			{#if resetNotice.problems.length > 0}
				<ul class="reset-problems">
					{#each resetNotice.problems.slice(0, 100) as problem}
						<li>{problem}</li>
					{/each}
					{#if resetNotice.problems.length > 100}
						<li>…and {resetNotice.problems.length - 100} more.</li>
					{/if}
				</ul>
			{/if}
			<div class="modal-actions">
				{#if resetNotice.redirect}
					<button class="btn-primary" onclick={() => { window.location.href = resetNotice?.redirect ?? '/setup'; }}>Continue to set-up</button>
				{:else}
					<button class="btn-ghost" onclick={() => (resetNotice = null)}>Close</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- The link of an invite whose mail was not sent: its dialog, set by the users panel, drawn here after the page's own dialogs as it always was. -->
<InviteLinkDialog bind:inviteLink {isSuperadmin} />

<!-- Toast -->
<Toast />

<style>
	.admin-page { min-height: 100vh; padding-top: 64px; }

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
	.header-title {
		font-size: 1rem; font-weight: 700; color: var(--text-primary);
		letter-spacing: -0.01em;
	}
	.admin-header-right { display: flex; gap: var(--space-sm); }

	/* The page's last line stops above the user badge (card 2239). */
	.admin-content {
		max-width: 800px; margin: 0 auto; padding: var(--space-2xl) var(--space-2xl) var(--user-badge-space);
		display: flex; flex-direction: column; gap: var(--space-xl);
	}

	/*
	 * A rule written `.admin-page :global(...)` styles the superadmin's panels
	 * as well as the page (card 2281, slice C1a): each panel is a component of
	 * its own, out of reach of the page's scoped rules. One that also has a
	 * plain selector styles the page's own dialogs, which are after
	 * `.admin-page` and not in it, as it did before.
	 */

	/* Fade-in animation */
	.admin-page :global(.fade-in-up) {
		animation: fadeInUp 0.5s ease-out both;
	}
	@keyframes fadeInUp {
		from { opacity: 0; transform: translateY(16px); }
		to { opacity: 1; transform: translateY(0); }
	}

	.admin-page :global(.admin-card) {
		padding: var(--space-xl); border-radius: var(--radius-lg);
		transition: transform 0.2s ease, box-shadow 0.2s ease;
	}
	.admin-page :global(.admin-card:hover) {
		transform: translateY(-1px);
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
	}
	.admin-page :global(.admin-card h2) { font-size: 1.05rem; margin-bottom: var(--space-sm); }
	.admin-page :global(.section-desc) { font-size: 0.85rem; color: var(--text-secondary); margin-bottom: var(--space-lg); }

	/* Backup & Restore's warning, and the reset dialog's */
	.admin-page :global(.warning-text) { color: var(--accent-amber); font-weight: 600; }

	.btn-danger-solid, .admin-page :global(.btn-danger-solid) {
		padding: var(--space-sm) var(--space-lg); border-radius: var(--radius-sm);
		background: var(--accent-rose); color: white; font-weight: 600;
		font-size: 0.82rem; border: none; white-space: nowrap; cursor: pointer;
		font-family: var(--font-family);
		transition: all 0.2s ease;
	}
	.btn-danger-solid:hover, .admin-page :global(.btn-danger-solid:hover) { background: #e11d48; transform: scale(1.02); }

	.confirm-modal, .admin-page :global(.confirm-modal) { max-width: 420px; }
	.confirm-modal h2, .admin-page :global(.confirm-modal h2) { font-size: 1.1rem; margin-bottom: var(--space-sm); }
	.confirm-modal p, .admin-page :global(.confirm-modal p) { font-size: 0.85rem; color: var(--text-secondary); margin-bottom: var(--space-xl); line-height: 1.5; }
	.modal-actions, .admin-page :global(.modal-actions) { display: flex; justify-content: flex-end; gap: var(--space-md); }
	/* What a reset could not move to the trash */
	.reset-problems {
		margin: 0 0 var(--space-xl); padding-left: var(--space-lg);
		max-height: 240px; overflow-y: auto;
		font-size: 0.8rem; color: var(--text-secondary); line-height: 1.5; overflow-wrap: anywhere;
	}

	.admin-page :global(.empty-msg) { font-size: 0.85rem; color: var(--text-tertiary); text-align: center; padding: var(--space-xl); }

	/* Section header with title + action */
	.admin-page :global(.section-header) {
		display: flex; align-items: center; justify-content: space-between;
		margin-bottom: var(--space-lg);
	}
	.admin-page :global(.section-header h2) { margin-bottom: 0; }

	/* Inline form: the users', the teams' and the mail panel's (card 2281, slice C1b) */
	.admin-page :global(.inline-form) {
		padding: var(--space-lg); background: var(--bg-base);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
		margin-bottom: var(--space-lg);
		display: flex; flex-direction: column; gap: var(--space-sm);
	}
	.admin-page :global(.form-row) {
		display: flex; gap: var(--space-sm); align-items: center; flex-wrap: wrap;
	}
	.admin-page :global(.form-input) {
		padding: var(--space-sm) var(--space-md);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-elevated); color: var(--text-primary);
		font-size: 0.82rem; font-family: var(--font-family);
		flex: 1; min-width: 120px;
	}
	.admin-page :global(.form-input:focus) { border-color: var(--accent-indigo); outline: none; }

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

	/* The invite link's dialog, which is after .admin-page, has a copy of its own (card 2281, slice C1b) */
	.admin-page :global(.btn-sm) { font-size: 0.78rem !important; padding: var(--space-xs) var(--space-md) !important; }
	.admin-page :global(.btn-xs) { font-size: 0.7rem !important; padding: 2px var(--space-sm) !important; }

	.admin-page :global(.danger) { color: var(--accent-rose) !important; }

	/* A backup destination's type, on its card and in the backup history */
	.admin-page :global(.dest-type-sftp) { background: rgba(34, 197, 94, 0.12); color: #22c55e; }
	.admin-page :global(.dest-type-s3) { background: rgba(249, 115, 22, 0.12); color: #f97316; }
	.admin-page :global(.dest-type-gdrive) { background: rgba(59, 130, 246, 0.12); color: #3b82f6; }
	.admin-page :global(.dest-type-onedrive) { background: rgba(99, 102, 241, 0.12); color: #6366f1; }
</style>
