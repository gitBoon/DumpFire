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
	import {
		PURGE_DESCRIPTION,
		PURGE_WARNING,
		RESET_WARNING,
		answerBody,
		boardDeleteWarning,
		clearCardsWarning,
		failureMessage,
		userDeleteWarning
	} from '$lib/api';
	import { mayManageAccount } from '$lib/account-rule';
	import { NO_ANSWER, sent, showToast } from '$lib/admin/send';
	import { formatBytes } from '$lib/admin/format';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';
	import ThemePicker from '$lib/components/ThemePicker.svelte';
	import Toast from '$lib/components/Toast.svelte';
	// The superadmin's panels (card 2281, slice C1a), each drawn in the markup's isSuperadmin block alone.
	import AppUrlPanel from '$lib/components/admin/AppUrlPanel.svelte';
	import BackupRestorePanel from '$lib/components/admin/BackupRestorePanel.svelte';
	import ScheduledBackupsPanel from '$lib/components/admin/ScheduledBackupsPanel.svelte';
	import { toasts } from '$lib/stores/toast';

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

	// ─── Board Management ─────────────────────────────────────────────────

	async function deleteBoard(id: number) {
		if (!(await sent(() => fetch(`/api/boards/${id}`, { method: 'DELETE' }), 'Failed to delete board'))) return;
		await invalidateAll();
		showToast('Board deleted');
	}

	async function clearBoardCards(id: number) {
		if (!(await sent(() => fetch(`/api/admin/boards/${id}/clear-cards`, { method: 'POST' }), 'Failed to clear cards'))) return;
		await invalidateAll();
		showToast('All cards cleared from board');
	}

	async function clearBoardCategories(id: number) {
		if (!(await sent(() => fetch(`/api/admin/boards/${id}/clear-categories`, { method: 'POST' }), 'Failed to clear categories'))) return;
		await invalidateAll();
		showToast('All categories cleared from board');
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
	 */
	let resetNotice = $state<{ title: string; message: string; problems: string[]; redirect: string | null } | null>(null);

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

	// ─── User Management ──────────────────────────────────────────────────

	let showCreateUser = $state(false);
	let newUsername = $state('');
	let newEmail = $state('');
	let newPassword = $state('');
	let newUserRole = $state('user');
	let newUserEmoji = $state('👤');
	let creatingUser = $state(false);

	/**
	 * The one invite out at a time (card 2196, R-S5): the account a 📧 was
	 * pressed for, or 'new' for Create User with no password. While it is set
	 * every 📧 and Create User are disabled, and the pressed 📧 reads "…". An
	 * invite now waits for its mail, a second or two, and a second press used
	 * to issue a second invite, which ends the first one's link.
	 */
	let inviteInFlight = $state<number | 'new' | null>(null);

	/**
	 * The link of an invite whose mail was not sent, shown once in its dialog
	 * to the administrator who issued it (card 2196, decision 9). A credential:
	 * whoever opens it sets the account's password. It lives here alone, never
	 * in a toast, the address, history or storage, and is cleared on Done.
	 */
	let inviteLink = $state<{ url: string; username: string; message: string } | null>(null);
	/** What 📋 Copy did: said on the button, so the link is never put in a toast. */
	let inviteLinkCopy = $state<'idle' | 'copied' | 'failed'>('idle');

	function closeInviteLink() {
		inviteLink = null;
		inviteLinkCopy = 'idle';
	}

	async function copyInviteLink() {
		if (!inviteLink) return;
		try {
			await navigator.clipboard.writeText(inviteLink.url);
			inviteLinkCopy = 'copied';
		} catch {
			inviteLinkCopy = 'failed';
		}
	}

	async function createUser() {
		if (!newUsername.trim() || !newEmail.trim()) return;
		// Password required if non-empty, must be 8+ chars
		if (newPassword && newPassword.length < 8) {
			showToast('Password must be at least 8 characters', 'error');
			return;
		}
		if (inviteInFlight !== null || inviteLink !== null) return;
		const started = toasts.navigation();
		creatingUser = true;
		// With no password an invite is issued, and its mail waited for.
		if (!newPassword) inviteInFlight = 'new';
		try {
			const body: Record<string, unknown> = {
				username: newUsername.trim(),
				email: newEmail.trim(),
				emoji: newUserEmoji,
				role: newUserRole
			};
			if (newPassword) body.password = newPassword;
			// A refusal is read with failureMessage: a proxy's page in place of
			// one used to make the page's own reading of it throw.
			const res = await sent(
				() =>
					fetch('/api/users', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(body)
					}),
				'Failed to create user'
			);
			if (!res) return;
			const result = await answerBody(res);
			showCreateUser = false;
			const made = typeof result?.username === 'string' ? result.username : newUsername.trim();
			newUsername = ''; newEmail = ''; newPassword = ''; newUserRole = 'user'; newUserEmoji = '👤';
			await invalidateAll();
			// The user was made either way. Its invite mail not sent: the link,
			// for the caller to pass on (card 2196), and never "invite email sent!".
			if (result?.mailSent === false) {
				const said = `User ${made} was made, but the invite mail could not be sent: ${result.mailProblem}.`;
				if (typeof result.inviteUrl === 'string') {
					inviteLink = { url: result.inviteUrl, username: made, message: said };
				} else {
					showToast(`${said} Send a new invite with 📧 once mail works.`, 'error', started);
				}
				return;
			}
			showToast(result?.invited ? 'User created — invite email sent!' : 'User created');
		} finally {
			creatingUser = false;
			inviteInFlight = null;
			// The panel the dialog points to, read again so it shows this mail.
			if (isSuperadmin) loadMailStatus();
		}
	}

	/**
	 * The role chosen in a row's select. The select shows it before the
	 * answer comes, so it is put back to the role the account has when the
	 * change is not made.
	 */
	async function changeUserRole(userId: number, select: HTMLSelectElement) {
		const newRole = select.value;
		const putBack = () => {
			select.value = data.users.find((u) => u.id === userId)?.role ?? select.value;
		};
		const started = toasts.navigation();
		let res: Response;
		try {
			res = await fetch(`/api/users/${userId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ role: newRole })
			});
		} catch {
			putBack();
			showToast(NO_ANSWER, 'error', started);
			return;
		}
		if (res.ok) {
			// A change of role ends any invite to the account not yet used: it
			// was sent to the account as it was. The answer says how many.
			const result = await answerBody(res);
			const invitesEnded = result?.invitesEnded;
			await invalidateAll();
			showToast(
				typeof invitesEnded === 'number' && invitesEnded > 0
					? 'Role updated. The invite sent to this account earlier no longer works: send a new one with 📧.'
					: 'Role updated'
			);
		} else {
			putBack();
			showToast(await failureMessage(res, 'Failed to update role'), 'error', started);
		}
	}

	let resetPasswordUserId = $state<number | null>(null);
	let resetPasswordValue = $state('');
	/** The password the administrator has now. Asked for only when the account in the dialog is their own. */
	let resetPasswordCurrent = $state('');
	/**
	 * The dialog is open on the signed-in administrator's own row. The reset
	 * route refuses the caller's own account: their password is changed where
	 * everyone's is, with the one they have, and their other sessions end.
	 */
	let resettingOwnPassword = $derived(resetPasswordUserId !== null && resetPasswordUserId === data.currentUser?.id);
	/** The account in the dialog, from the page's list of users as last read. */
	let resetTarget = $derived(data.users.find((u) => u.id === resetPasswordUserId));
	/**
	 * The page's data has been read again since the dialog opened. The list
	 * the page was loaded with may be older than a key made since, so until
	 * then no count is shown.
	 */
	let resetKeysRead = $state(false);
	/** Which opening of the dialog the latest read belongs to. */
	let resetOpenings = 0;
	/**
	 * How many API keys that account holds. A reset ends every one of them, and
	 * the dialog says how many before it is confirmed: one of them may be the
	 * key a script or an integration runs on. Null until the count has been
	 * read again, and for an account the caller may not reset, which the page
	 * is given no count for.
	 */
	let resetTargetKeys = $derived(resetKeysRead ? (resetTarget?.apiKeys ?? null) : null);
	/**
	 * How many webhooks that account set that are on, and how many of its
	 * report schedules are on. A reset switches off the first and pauses the
	 * second (card 2168), and the dialog says how many, by the same rule as the
	 * keys: null until read again, and for an account the caller may not reset.
	 */
	let resetTargetWebhooks = $derived(resetKeysRead ? (resetTarget?.webhooks ?? null) : null);
	let resetTargetSchedules = $derived(resetKeysRead ? (resetTarget?.reportSchedules ?? null) : null);

	/** Open the dialog on an account, and read the key counts again for it. */
	async function openResetDialog(userId: number) {
		resetPasswordUserId = userId;
		resetPasswordValue = '';
		resetPasswordCurrent = '';
		resetKeysRead = false;
		const opening = ++resetOpenings;
		try {
			await invalidateAll();
		} catch {
			// Not read: the dialog shows no count rather than an old one.
			return;
		}
		// Only if the dialog is still open on the same account, and was not
		// opened again meanwhile.
		if (opening === resetOpenings && resetPasswordUserId === userId) resetKeysRead = true;
	}

	/** `1 session`, `2 API keys`: a count with its noun. */
	const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

	async function resetPassword() {
		if (!resetPasswordUserId || !resetPasswordValue || resetPasswordValue.length < 8) return;
		if (resettingOwnPassword && !resetPasswordCurrent) return;
		const started = toasts.navigation();
		let res: Response;
		try {
			res = resettingOwnPassword
				? await fetch('/api/account/password', {
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ currentPassword: resetPasswordCurrent, newPassword: resetPasswordValue })
					})
				: await fetch(`/api/users/${resetPasswordUserId}/password`, {
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ password: resetPasswordValue })
					});
		} catch {
			// The dialog stays open: whether the password was set is not known.
			showToast(NO_ANSWER, 'error', started);
			return;
		}
		if (res.ok) {
			const own = resettingOwnPassword;
			resetPasswordUserId = null;
			resetPasswordValue = '';
			resetPasswordCurrent = '';
			if (own) {
				showToast('Password changed');
			} else {
				// What the reset ended, in the answer's own counts.
				const result = await answerBody(res);
				const sessionsEnded = result?.sessionsEnded;
				const apiKeysEnded = result?.apiKeysEnded;
				const webhooksSwitchedOff = result?.webhooksSwitchedOff;
				const reportSchedulesPaused = result?.reportSchedulesPaused;
				showToast(
					typeof sessionsEnded === 'number' &&
						typeof apiKeysEnded === 'number' &&
						typeof webhooksSwitchedOff === 'number' &&
						typeof reportSchedulesPaused === 'number'
						? `Password reset: ${counted(sessionsEnded, 'session')} and ${counted(apiKeysEnded, 'API key')} ended, ` +
								`${counted(webhooksSwitchedOff, 'webhook')} switched off and ${counted(reportSchedulesPaused, 'report schedule')} paused`
						: 'Password reset'
				);
				// The counts are read again: the account now holds no key, and has no
				// webhook or report schedule on.
				await invalidateAll();
			}
		} else {
			// The server's own words: a refusal says whose password this is not to set.
			showToast(await failureMessage(res, 'Failed to reset password'), 'error', started);
		}
	}

	async function deleteUser(userId: number) {
		if (!(await sent(() => fetch(`/api/users/${userId}`, { method: 'DELETE' }), 'Failed to delete user'))) return;
		await invalidateAll();
		showToast('User deleted');
	}

	/**
	 * 📧: a new invite, which ends the account's earlier one. The server waits
	 * for its mail and says whether it went (card 2196): sent, the toast; not
	 * sent, the dialog with the link to pass on, or, where the server could no
	 * longer show it, the server's words in a toast that stays. "Invite sent"
	 * only for an answer that says `mailSent: true`. Either way the mail panel
	 * is read again, for the superadmin, so it shows this mail.
	 */
	async function resendInvite(userId: number) {
		if (inviteInFlight !== null || inviteLink !== null) return;
		const started = toasts.navigation();
		inviteInFlight = userId;
		try {
			const res = await sent(() => fetch(`/api/users/${userId}/invite`, { method: 'POST' }), 'Failed to send invite');
			if (!res) return;
			const result = await answerBody(res);
			const said = typeof result?.message === 'string' ? result.message : '';
			if (result?.mailSent === false) {
				if (typeof result.inviteUrl === 'string') {
					const username = data.users.find((u) => u.id === userId)?.username ?? 'this user';
					inviteLink = { url: result.inviteUrl, username, message: said };
				} else {
					showToast(said || 'The invite was made, but its mail could not be sent.', 'error', started);
				}
				return;
			}
			if (result?.mailSent === true) {
				showToast(said || 'Invite sent!');
				return;
			}
			// An answer that says neither is not taken as a mail that went.
			showToast('The invite was made, but the answer did not say whether its mail was sent.', 'error', started);
		} finally {
			inviteInFlight = null;
			// The panel the dialog points to, read again so it shows this mail.
			if (isSuperadmin) loadMailStatus();
		}
	}

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
	let addMemberRole = $state('member');

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
		await invalidateAll();
		showToast('Member added');
	}

	async function removeTeamMember(teamId: number, userId: number) {
		// It used to say "Member removed" whatever the answer.
		if (!(await sent(() => fetch(`/api/teams/${teamId}/members/${userId}`, { method: 'DELETE' }), 'Failed to remove member'))) return;
		await invalidateAll();
		showToast('Member removed');
	}

	// ─── SMTP Configuration ───────────────────────────────────────────────

	let smtpHost = $state('');
	let smtpPort = $state(587);
	// The way out of card 2189: mail without a checked, encrypted connection. It replaces the old SSL/TLS box,
	// which only switched the certificate check on, and that is now always on.
	let smtpAllowInsecure = $state(false);
	let smtpUser = $state('');
	let smtpPass = $state('');
	let smtpFromAddress = $state('');
	let smtpFromName = $state('DumpFire');
	// appUrl is now in Application Settings section above
	let smtpLoading = $state(true);
	let smtpSaving = $state(false);
	let smtpTesting = $state(false);
	let smtpTestTo = $state('');
	let smtpMessage = $state('');
	let smtpIsError = $state(false);

	$effect(() => {
		// The superadmin's too, and not asked for by anybody else.
		if (!isSuperadmin) return;
		loadSmtpConfig();
	});

	/** What mail has done since the server started, as `GET /api/admin/smtp` answers it (card 2196). */
	type MailStatus = {
		since: string;
		sent: number;
		failed: number;
		lastSentAt: string | null;
		lastFailure: { at: string; subject: string; problem: string; detail: string } | null;
	};
	let mailStatus = $state<MailStatus | null>(null);

	/** The record as answered, or null for an answer without one (a server from before card 2196). */
	function readMailStatus(value: unknown): MailStatus | null {
		if (value === null || typeof value !== 'object') return null;
		const record = value as MailStatus;
		return typeof record.since === 'string' && typeof record.sent === 'number' && typeof record.failed === 'number' ? record : null;
	}

	/** A moment of the record, in the reader's own time. */
	function when(stamp: string | null): string {
		return stamp ? new Date(stamp).toLocaleString() : '';
	}

	/** The record read again: after Save and Send Test, each of which may have changed it. */
	async function loadMailStatus() {
		try {
			const res = await fetch('/api/admin/smtp');
			if (res.ok) {
				const data = await res.json();
				mailStatus = readMailStatus(data.mailStatus);
			}
		} catch {}
	}

	async function loadSmtpConfig() {
		smtpLoading = true;
		try {
			const res = await fetch('/api/admin/smtp');
			if (res.ok) {
				const data = await res.json();
				mailStatus = readMailStatus(data.mailStatus);
				if (data.configured) {
					smtpHost = data.host || '';
					smtpPort = data.port || 587;
					smtpAllowInsecure = data.allowInsecure === true;
					smtpUser = data.user || '';
					smtpPass = data.pass || '';
					smtpFromAddress = data.fromAddress || '';
				smtpFromName = data.fromName || 'DumpFire';
				// appUrl loaded separately in loadAppUrl()
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
					// A change of host, port, user name or the way out needs the password typed:
					// the server's 400 says so, and is shown below the panel.
					host: smtpHost, port: smtpPort, allowInsecure: smtpAllowInsecure,
					user: smtpUser, pass: smtpPass,
					fromAddress: smtpFromAddress, fromName: smtpFromName
				})
			});
			if (res.ok) {
				smtpMessage = 'SMTP settings saved!';
				smtpIsError = false;
			} else {
				// The server's reason, which used to be "Failed to save" for all of them.
				smtpMessage = await failureMessage(res, 'Failed to save SMTP settings');
				smtpIsError = true;
			}
		} catch {
			smtpMessage = NO_ANSWER;
			smtpIsError = true;
		}
		smtpSaving = false;
		await loadMailStatus();
		// A failure stays until the next save or test, as a failure toast does.
		if (!smtpIsError) setTimeout(() => { if (!smtpIsError) smtpMessage = ''; }, 5000);
	}

	async function testSmtp() {
		smtpTesting = true;
		smtpMessage = '';
		const recipient = smtpTestTo.trim() || data.currentUser?.email;
		try {
			const res = await fetch('/api/admin/smtp', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ to: recipient })
			});
			if (res.ok) {
				const said = (await answerBody(res))?.message;
				smtpMessage = typeof said === 'string' && said ? said : 'Test email sent!';
				smtpIsError = false;
			} else {
				smtpMessage = await failureMessage(res, 'Test email failed');
				smtpIsError = true;
			}
		} catch {
			smtpMessage = NO_ANSWER;
			smtpIsError = true;
		}
		smtpTesting = false;
		await loadMailStatus();
		if (!smtpIsError) setTimeout(() => { if (!smtpIsError) smtpMessage = ''; }, 8000);
	}
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
				<div class="stat-item">
					<span class="stat-value">{formatBytes(data.dbSizeBytes)}</span>
					<span class="stat-label">DB Size</span>
				</div>
			</div>
		</section>

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
								<button class="btn-ghost action-btn" onclick={() => confirm('Clear Cards', clearCardsWarning(board.name), () => clearBoardCards(board.id))}>
									<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 3h10M3 3V2a1 1 0 011-1h4a1 1 0 011 1v1m-6 0v7a1 1 0 001 1h4a1 1 0 001-1V3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>
									Clear Cards
								</button>
								<button class="btn-ghost action-btn" onclick={() => confirm('Clear Categories', `Remove all categories from "${board.name}"?`, () => clearBoardCategories(board.id))}>
									Clear Cats
								</button>
								<button class="btn-ghost action-btn danger" onclick={() => confirm('Delete Board', boardDeleteWarning(board.name), () => deleteBoard(board.id))}>
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
			<p class="section-desc">Each row shows only what you may do to that account. Only the superadmin changes an administrator's account, and nobody else changes the superadmin's: those rows show 🔒. On your own row there is only 🔑, to change your password.</p>

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
						<button class="btn-primary btn-sm" onclick={createUser} disabled={creatingUser || inviteInFlight !== null || inviteLink !== null || !newUsername || !newEmail}>
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
							<!-- Only what the server would let you do to this account (the rule in $lib/account-rule.ts). On your own row, only the password. -->
							{#if mayManageAccount(data.currentUser, u)}
								{#if u.id !== data.currentUser.id}
									<select
										value={u.role}
										onchange={(e) => changeUserRole(u.id, e.currentTarget)}
										class="role-select"
									>
										<option value="user">User</option>
										{#if isSuperadmin}<option value="admin">Admin</option>{/if}
									</select>
								{/if}
								<button class="btn-ghost btn-sm" onclick={() => openResetDialog(u.id)} title="Reset password">🔑</button>
								{#if u.id !== data.currentUser.id}
									<button class="btn-ghost btn-sm" onclick={() => resendInvite(u.id)} disabled={inviteInFlight !== null || inviteLink !== null} title="Resend invite email">{inviteInFlight === u.id ? '…' : '📧'}</button>
									<button class="btn-ghost btn-sm danger" onclick={() => confirm('Delete User', userDeleteWarning(u.username), () => deleteUser(u.id))} title="Delete user">🗑️</button>
								{/if}
							{:else}
								<span class="superadmin-lock" title={u.role === 'superadmin' ? "The superadmin's account is theirs alone" : "Only the superadmin can change an administrator's account"}>🔒</span>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<!-- Password Reset Modal (inline) -->
		{#if resetPasswordUserId}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div class="modal-overlay" role="dialog" aria-modal="true">
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<div class="modal-content" onclick={(e) => e.stopPropagation()} role="document">
					<h2>🔑 {resettingOwnPassword ? 'Change Your Password' : 'Reset Password'}</h2>
					{#if resettingOwnPassword}
						<!-- Their own account: the password they have is asked for, as on the Account page. -->
						<p>This is your own account. Enter your current password and a new one. Your other sessions will be signed out.</p>
						<!-- Sent with no endApiKeys, so the keys are kept. The Account page offers the choice. -->
						<p>Your API keys and the webhooks you set up keep working. To end the keys and switch off those webhooks too, change your password on the <a href="/account">Account page</a>.</p>
						<input type="password" placeholder="Current password" bind:value={resetPasswordCurrent} class="form-input" style="width: 100%; margin: var(--space-md) 0 0;" autocomplete="current-password" />
					{:else}
						<p>Enter a new password for {resetTarget?.username || 'user'}.</p>
						{#if resetTargetKeys !== null && resetTargetKeys > 0}
							<p class="warning-text">They have {counted(resetTargetKeys, 'API key')}, which {resetTargetKeys === 1 ? 'stops' : 'stop'} working.</p>
						{/if}
						{#if resetTargetWebhooks !== null && resetTargetWebhooks > 0}
							<p class="warning-text">They set up {counted(resetTargetWebhooks, 'webhook')}, which {resetTargetWebhooks === 1 ? 'is' : 'are'} switched off.</p>
						{/if}
						{#if resetTargetSchedules !== null && resetTargetSchedules > 0}
							<p class="warning-text">They have {counted(resetTargetSchedules, 'report schedule')}, which {resetTargetSchedules === 1 ? 'is' : 'are'} paused.</p>
						{/if}
						<p>They are signed out everywhere, every API key they have stops working, any invite not yet used stops working, the webhooks they set up are switched off and their report schedules are paused.</p>
					{/if}
					<input type="password" placeholder="New password (min 8 chars)" bind:value={resetPasswordValue} class="form-input" style="width: 100%; margin: var(--space-md) 0;" autocomplete="new-password" />
					<div class="modal-actions">
						<button class="btn-ghost" onclick={() => (resetPasswordUserId = null)}>Cancel</button>
						<button class="btn-primary" onclick={resetPassword} disabled={resetPasswordValue.length < 8 || (resettingOwnPassword && !resetPasswordCurrent)}>{resettingOwnPassword ? 'Change Password' : 'Reset Password'}</button>
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

		<!-- SMTP Configuration: the superadmin's alone, as above -->
		{#if isSuperadmin}
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
					<p class="smtp-hint">Port 465 is encrypted from the start; any other port must offer STARTTLS. The mail server's certificate is checked either way.</p>
					<div class="form-row">
						<input type="text" placeholder="Username" bind:value={smtpUser} class="form-input" />
						<input type="password" placeholder="Password" bind:value={smtpPass} class="form-input" />
					</div>
					<p class="smtp-hint">The saved password is kept only while the host, port, user name and the box below stay as they are: type it again when you change them.</p>
					<div class="form-row">
						<input type="email" placeholder="From Email" bind:value={smtpFromAddress} class="form-input" />
						<input type="text" placeholder="From Name" bind:value={smtpFromName} class="form-input" />
					</div>
					<div class="form-row">
						<label style="display: flex; align-items: center; gap: var(--space-xs); font-size: 0.78rem; color: var(--text-secondary); cursor: pointer">
							<input type="checkbox" bind:checked={smtpAllowInsecure} /> Allow mail without a checked, encrypted connection
						</label>
						<div style="flex: 1"></div>
						<button class="btn-primary btn-sm" onclick={saveSmtp} disabled={!smtpHost || smtpSaving}>{smtpSaving ? 'Saving...' : 'Save SMTP'}</button>
					</div>
					{#if smtpAllowInsecure}
						<p class="smtp-msg smtp-warning">⚠️ Mail, and the mail password, can then be read and changed by anyone on the network between this server and the mail server. Use it only for a relay on this server's own network that cannot use TLS. For a mail server whose certificate comes from a private authority, set NODE_EXTRA_CA_CERTS instead: see docs/deployment.md, Mail Server Certificates.</p>
					{/if}
					<div class="form-row" style="margin-top: var(--space-sm)">
						<input type="email" placeholder="Test recipient (defaults to your email)" bind:value={smtpTestTo} class="form-input" />
						<button class="btn-ghost btn-sm" onclick={testSmtp} disabled={!smtpHost || smtpTesting} style="flex: none">🧪 {smtpTesting ? 'Sending...' : 'Send Test'}</button>
					</div>
					{#if smtpMessage}
						<p class="smtp-msg" class:smtp-error={smtpIsError} class:smtp-success={!smtpIsError}>{smtpMessage}</p>
					{/if}
					<!-- What mail has done since the server started (card 2196): kept in memory, so a restart starts it again -->
					{#if mailStatus}
						<div class="mail-status">
							<p class="smtp-hint">Since the server started ({when(mailStatus.since)}): {mailStatus.sent} sent, {mailStatus.failed} failed.</p>
							{#if mailStatus.lastFailure}
								<p class="smtp-msg smtp-warning">⚠️ Last failure, {when(mailStatus.lastFailure.at)}: "{mailStatus.lastFailure.subject}": {mailStatus.lastFailure.problem}. The mail error was: {mailStatus.lastFailure.detail}.
									{#if mailStatus.lastSentAt && mailStatus.lastSentAt > mailStatus.lastFailure.at}Mail has been sent since then, last at {when(mailStatus.lastSentAt)}.{:else}No mail has been sent since then.{/if}
									Every failure is also in the system log, on the Audit page, with its recipient.</p>
							{:else}
								<p class="smtp-hint">✅ No mail has failed since then.</p>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</section>
		{/if}

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

<!-- The link of an invite whose mail was not sent (card 2196, decision 9): shown once, to the administrator who issued it, and gone on Done. No way out of it but Done. -->
{#if inviteLink}
	<div class="modal-overlay" role="alertdialog" aria-modal="true" aria-label="The invite mail was not sent" aria-describedby="invite-link-said invite-link-warning">
		<div class="modal-content confirm-modal" role="document" style="max-width: 560px">
			<h2>📧 The invite mail was not sent</h2>
			<p id="invite-link-said" style="margin-bottom: var(--space-sm)">{inviteLink.message}</p>
			<p id="invite-link-warning" style="margin-bottom: var(--space-sm)">Give this link to {inviteLink.username} yourself, by a way only they read. Whoever opens it can set the password of {inviteLink.username}'s account and is then signed in as them. It works once, for seven days, and stops working if another invite is sent to this account. Do not open it yourself.</p>
			<div class="invite-link-row">
				<code>{inviteLink.url}</code>
				<!-- Focused as the dialog opens: what the reader is there to do, and away from the page behind it -->
				<!-- svelte-ignore a11y_autofocus -->
				<button class="btn-ghost btn-sm" onclick={copyInviteLink} autofocus>{inviteLinkCopy === 'copied' ? '✅ Copied!' : inviteLinkCopy === 'failed' ? 'Select it and copy it yourself' : '📋 Copy'}</button>
			</div>
			<p>It is not shown again. If it is lost, send a new invite with 📧. {#if isSuperadmin}Why it failed is under Email / SMTP below.{:else}The superadmin can see why under Email / SMTP.{/if}</p>
			<div class="modal-actions">
				<button class="btn-primary" onclick={closeInviteLink}>Done</button>
			</div>
		</div>
	</div>
{/if}

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

	/* Backup & Restore's warning, and the reset dialog's */
	.admin-page :global(.warning-text) { color: var(--accent-amber); font-weight: 600; }

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

	/* Inline form */
	.inline-form {
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

	.btn-sm, .admin-page :global(.btn-sm) { font-size: 0.78rem !important; padding: var(--space-xs) var(--space-md) !important; }
	.admin-page :global(.btn-xs) { font-size: 0.7rem !important; padding: 2px var(--space-sm) !important; }

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

	.admin-page :global(.danger) { color: var(--accent-rose) !important; }

	/* SMTP */
	.smtp-msg {
		font-size: 0.78rem; font-weight: 500; padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm); margin-top: var(--space-sm);
	}
	.smtp-success { background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); color: var(--accent-emerald); }
	.smtp-error { background: rgba(244, 63, 94, 0.1); border: 1px solid rgba(244, 63, 94, 0.3); color: var(--accent-rose); }
	/* While the way out is ticked (card 2189) */
	.smtp-warning { background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); color: var(--accent-amber); }
	.smtp-hint { font-size: 0.68rem; color: var(--text-tertiary); margin: 0 0 var(--space-xs); }
	/* What mail has done since the server started (card 2196) */
	.mail-status { margin-top: var(--space-md); }
	.mail-status .smtp-msg { overflow-wrap: anywhere; }

	/* The link of an invite whose mail was not sent (card 2196) */
	.invite-link-row {
		display: flex; align-items: center; gap: var(--space-sm);
		margin: 0 0 var(--space-md); padding: var(--space-sm) var(--space-md);
		background: var(--bg-base); border: 1px solid var(--glass-border); border-radius: var(--radius-md);
	}
	.invite-link-row code { flex: 1; font-size: 0.78rem; overflow-wrap: anywhere; user-select: all; }
	.invite-link-row button { flex: none; }

	/* A backup destination's type, on its card and in the backup history */
	.admin-page :global(.dest-type-sftp) { background: rgba(34, 197, 94, 0.12); color: #22c55e; }
	.admin-page :global(.dest-type-s3) { background: rgba(249, 115, 22, 0.12); color: #f97316; }
	.admin-page :global(.dest-type-gdrive) { background: rgba(59, 130, 246, 0.12); color: #3b82f6; }
	.admin-page :global(.dest-type-onedrive) { background: rgba(99, 102, 241, 0.12); color: #6366f1; }
</style>
