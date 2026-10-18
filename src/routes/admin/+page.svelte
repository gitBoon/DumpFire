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
		uploadFailure,
		uploadNoAnswer,
		uploadNotRead,
		userDeleteWarning
	} from '$lib/api';
	import { mayManageAccount } from '$lib/account-rule';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';
	import ThemePicker from '$lib/components/ThemePicker.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import { toasts } from '$lib/stores/toast';
	import { parseStamp } from '$lib/timestamps';
	import { driveScopeIsNarrow, dumpfireFolderName } from '$lib/drive-scope';

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

	let importing = $state(false);
	let exporting = $state(false);

	/**
	 * What an import could not do, or what a working copy had switched off,
	 * kept on the page until it is dismissed. A toast is a line in a corner,
	 * and one that is not a failure is gone in three seconds: neither a list of
	 * rows that were left out of the database nor an account of what no longer
	 * reaches outside is something to show in one.
	 *
	 * `trouble` is false when nothing went wrong and this is only here to say
	 * what a working copy switched off and removed.
	 *
	 * `reload` is true when the database was changed, or may have been. The
	 * page is not reloaded until this has been read: a restore signs everybody
	 * out, the reader included, so the reload ends at the login page.
	 */
	let importReport = $state<{
		headline: string;
		/** One line of the figures that matter: the size of the backup and what it held. */
		detail?: string;
		/** What a working copy switched off and removed. */
		workingCopy?: string;
		/** The secrets a backup does not hold that this server's were kept for (card 2169). */
		secretsKept?: string;
		/** The secrets a backup does not hold that are to be entered again, and where (card 2169). */
		secretsToEnter?: string;
		/** Attachment files the import had back from the uploads trash, when there were any. */
		putBack?: string;
		/** Request links the import replaced, when there were any (card 2158). */
		requestLinks?: string;
		/** Who the superadmin is now: who can sign in to export, import or reset again. */
		superadmin?: string;
		/** Every table restored, with its rows, for whoever wants all of it. */
		tables?: [string, number][];
		problems: string[];
		reload: boolean;
		trouble: boolean;
	} | null>(null);

	const count = (n: number) => n.toLocaleString('en-GB');

	/**
	 * What an import restored, said the way a person would: the size of the
	 * backup and the handful of figures that show it is the right one. The
	 * server's own message lists every table in one sentence, which is for the
	 * log; the full list is kept, folded away, for anyone who wants it.
	 */
	function accountOf(result: {
		sizeBytes?: number;
		restored?: Record<string, number>;
		workingCopy?: string;
		secretsKept?: string;
		secretsToEnter?: string;
		attachmentsPutBack?: number;
		requestLinksReplaced?: number;
		superadmins?: string[];
	}) {
		const restored = result.restored ?? {};
		const figures: [string, string, string][] = [
			['boards', 'board', 'boards'],
			['columns', 'column', 'columns'],
			['cards', 'card', 'cards'],
			['subtasks', 'subtask', 'subtasks'],
			['card_comments', 'comment', 'comments'],
			['comments', 'comment', 'comments'],
			['users', 'user', 'users']
		];
		const parts = figures
			.filter(([key]) => typeof restored[key] === 'number')
			.map(([key, one, many]) => `${count(restored[key])} ${restored[key] === 1 ? one : many}`);
		const bytes = result.sizeBytes;
		const size =
			bytes === undefined
				? null
				: bytes >= 1024 * 1024
					? `${(bytes / 1024 / 1024).toFixed(1)} MB`
					: `${Math.max(1, Math.round(bytes / 1024))} KB`;
		const from = size ? `From a ${size} backup` : 'From the backup';
		// Rows the import brought back can name files that a delete since the
		// backup had moved to the uploads trash. The import puts those back.
		const putBack = typeof result.attachmentsPutBack === 'number' ? result.attachmentsPutBack : 0;
		// Every request is given a new link by an import (card 2158), so a link
		// mailed before it no longer works: said beside the files put back.
		const links = typeof result.requestLinksReplaced === 'number' ? result.requestLinksReplaced : 0;
		return {
			detail: parts.length > 0 ? `${from}: ${parts.join(', ')}.` : `${from}. It held no rows.`,
			workingCopy: result.workingCopy,
			// A backup holds no mail password, destination credential or webhook
			// secret (card 2169). The server's two sentences say which of this
			// server's were kept and which are to enter again; each is absent when
			// there is nothing to say, as for a backup made before that card.
			secretsKept: result.secretsKept,
			secretsToEnter: result.secretsToEnter,
			// The import signed everybody out, and the backup's accounts are the
			// ones there are now: this is the one to sign in as to undo it.
			superadmin: !Array.isArray(result.superadmins)
				? undefined
				: result.superadmins.length === 0
					? 'There are no user accounts now: set-up is open, and whoever completes it is the superadmin.'
					: result.superadmins.length === 1
						? `The superadmin is now ${result.superadmins[0]}.`
						: `The superadmins are now ${result.superadmins.join(', ')}.`,
			putBack:
				putBack > 0
					? `${count(putBack)} attachment ${putBack === 1 ? 'file' : 'files'} put back from the trash.`
					: undefined,
			requestLinks:
				links > 0
					? `${count(links)} request ${links === 1 ? 'link' : 'links'} replaced: a link mailed before this restore no ` +
						'longer works, and its requester can have a new one sent from the page it opens.'
					: undefined,
			tables: Object.entries(restored)
				.filter(([, rows]) => rows > 0)
				.sort(([a], [b]) => a.localeCompare(b))
		};
	}

	/**
	 * The shared toast: a failure stays until it is closed, anything else goes
	 * after 3 s. `started` is `toasts.navigation()` as the request began, so
	 * that a failure arriving after the page was left is not shown.
	 */
	function showToast(msg: string, type: 'success' | 'error' = 'success', started?: number) {
		toasts.add(msg, type, started);
	}

	/** What a request that got no answer says: it is not known to have failed. */
	const NO_ANSWER = 'No answer from the server. It is not known whether this was done.';

	/** Opens the confirm modal for a destructive action. */
	function confirm(title: string, message: string, action: () => Promise<void>) {
		confirmAction = { show: true, title, message, action };
	}

	/**
	 * Send a request that changes something, and say so in a toast if it was
	 * not done. Returns the answer when the server said it was done and null
	 * when it did not, so that a caller changes the page only for an answer.
	 *
	 * The toast is the server's own message where it gave one, and `fallback`
	 * where it did not. A request that got no answer is not known to have
	 * failed, and the toast says that instead.
	 */
	async function sent(send: () => Promise<Response>, fallback: string): Promise<Response | null> {
		const started = toasts.navigation();
		try {
			const res = await send();
			if (res.ok) return res;
			showToast(await failureMessage(res, fallback), 'error', started);
		} catch {
			showToast(NO_ANSWER, 'error', started);
		}
		return null;
	}

	// ─── Scheduled Backups ────────────────────────────────────────────────

	type DestType = 'sftp' | 's3' | 'gdrive' | 'onedrive';

	interface DestinationUI {
		type: DestType;
		name: string;
		[key: string]: unknown;
	}

	interface BackupHistoryEntry {
		id: number;
		destinationType: string;
		destinationName: string;
		filename: string;
		sizeBytes: number | null;
		status: string;
		error: string | null;
		durationMs: number | null;
		createdAt: string;
	}

	let backupSchedule = $state('disabled');
	let backupScheduleTime = $state('02:00');
	let backupScheduleDay = $state(0);
	let backupRetention = $state(7);
	let backupNotifyOnFailure = $state(false);
	let backupNotifyEmail = $state('');
	let backupDestinations = $state<DestinationUI[]>([]);
	let backupHistory = $state<BackupHistoryEntry[]>([]);
	let showAllHistory = $state(false);
	let backupLoading = $state(true);
	let backupSaving = $state(false);
	let backupRunning = $state(false);
	let showAddDestination = $state(false);
	let newDestType = $state<DestType>('sftp');
	let testingDest = $state<string | null>(null);
	let editingDest = $state<string | null>(null);

	// Destination form fields (shared for add/edit)
	let destName = $state('');
	let destHost = $state('');
	let destPort = $state(22);
	let destUsername = $state('');
	let destPassword = $state('');
	let destPrivateKey = $state('');
	let destRemotePath = $state('/backups');
	let destRegion = $state('us-east-1');
	let destBucket = $state('');
	let destAccessKey = $state('');
	let destSecretKey = $state('');
	let destPrefix = $state('dumpfire/');
	let destEndpoint = $state('');
	let destServiceAccountJson = $state('');
	let destFolderId = $state('');
	let destGdriveAuthMethod = $state<'oauth' | 'service_account'>('oauth');
	let destGdriveClientId = $state('');
	let destGdriveClientSecret = $state('');
	let destGdriveRefreshToken = $state('');
	let destTenantId = $state('');
	let destClientId = $state('');
	let destClientSecret = $state('');
	let destFolderPath = $state('/DumpFire Backups');

	$effect(() => {
		// The backup settings and the App URL are the superadmin's, and an
		// administrator is refused them: they are not asked for.
		if (!isSuperadmin) return;
		loadBackupConfig();
		loadAppUrl();
	});

	// ─── Application Settings ────────────────────────────────────────────

	let appUrl = $state('');
	let appUrlSaving = $state(false);

	async function loadAppUrl() {
		try {
			const res = await fetch('/api/admin/smtp');
			if (res.ok) {
				const data = await res.json();
				appUrl = data.appUrl || '';
			}
		} catch {}
	}

	async function saveAppUrl() {
		appUrlSaving = true;
		try {
			const res = await sent(
				() =>
					fetch('/api/admin/smtp', {
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ appUrl })
					}),
				'Failed to save App URL'
			);
			if (!res) return;
			showToast('App URL saved');
		} finally {
			appUrlSaving = false;
		}
	}

	function resetDestForm() {
		destName = ''; destHost = ''; destPort = 22; destUsername = ''; destPassword = '';
		destPrivateKey = ''; destRemotePath = '/backups'; destRegion = 'us-east-1';
		destBucket = ''; destAccessKey = ''; destSecretKey = ''; destPrefix = 'dumpfire/';
		destEndpoint = ''; destServiceAccountJson = ''; destFolderId = '';
		destGdriveAuthMethod = 'oauth'; destGdriveClientId = ''; destGdriveClientSecret = ''; destGdriveRefreshToken = '';
		destTenantId = ''; destClientId = ''; destClientSecret = '';
		destFolderPath = '/DumpFire Backups';
	}

	function populateDestForm(dest: DestinationUI) {
		destName = dest.name || '';
		if (dest.type === 'sftp') {
			destHost = (dest.host as string) || ''; destPort = (dest.port as number) || 22;
			destUsername = (dest.username as string) || ''; destPassword = (dest.password as string) || '';
			destPrivateKey = (dest.privateKey as string) || ''; destRemotePath = (dest.remotePath as string) || '/backups';
		} else if (dest.type === 's3') {
			destRegion = (dest.region as string) || 'us-east-1'; destBucket = (dest.bucket as string) || '';
			destAccessKey = (dest.accessKeyId as string) || ''; destSecretKey = (dest.secretAccessKey as string) || '';
			destPrefix = (dest.prefix as string) || ''; destEndpoint = (dest.endpoint as string) || '';
		} else if (dest.type === 'gdrive') {
			destGdriveAuthMethod = (dest.authMethod as 'oauth' | 'service_account') || 'oauth';
			destServiceAccountJson = (dest.serviceAccountJson as string) || '';
			destFolderId = (dest.folderId as string) || '';
			destGdriveClientId = (dest.clientId as string) || '';
			destGdriveClientSecret = (dest.clientSecret as string) || '';
			destGdriveRefreshToken = (dest.refreshToken as string) || '';
		} else if (dest.type === 'onedrive') {
			destTenantId = (dest.tenantId as string) || ''; destClientId = (dest.clientId as string) || '';
			destClientSecret = (dest.clientSecret as string) || '';
			destFolderPath = (dest.folderPath as string) || '/DumpFire Backups';
		}
	}

	function buildDestConfig(): DestinationUI {
		if (newDestType === 'sftp') {
			return { type: 'sftp', name: destName, host: destHost, port: destPort, username: destUsername, password: destPassword, privateKey: destPrivateKey, remotePath: destRemotePath };
		} else if (newDestType === 's3') {
			return { type: 's3', name: destName, region: destRegion, bucket: destBucket, accessKeyId: destAccessKey, secretAccessKey: destSecretKey, prefix: destPrefix, endpoint: destEndpoint || undefined };
		} else if (newDestType === 'gdrive') {
			return {
				type: 'gdrive', name: destName, folderId: destFolderId,
				authMethod: destGdriveAuthMethod,
				serviceAccountJson: destGdriveAuthMethod === 'service_account' ? destServiceAccountJson : undefined,
				clientId: destGdriveAuthMethod === 'oauth' ? destGdriveClientId : undefined,
				clientSecret: destGdriveAuthMethod === 'oauth' ? destGdriveClientSecret : undefined,
				refreshToken: destGdriveAuthMethod === 'oauth' ? destGdriveRefreshToken : undefined
			};
		} else {
			return { type: 'onedrive', name: destName, tenantId: destTenantId, clientId: destClientId, clientSecret: destClientSecret, folderPath: destFolderPath };
		}
	}

	async function loadBackupConfig() {
		backupLoading = true;
		try {
			const res = await fetch('/api/admin/backup');
			if (res.ok) {
				const d = await res.json();
				backupSchedule = d.schedule || 'disabled';
				backupScheduleTime = d.scheduleTime || '02:00';
				backupScheduleDay = d.scheduleDay ?? 0;
				backupRetention = d.retention ?? 7;
				backupNotifyOnFailure = d.notifyOnFailure ?? false;
				backupNotifyEmail = d.notifyEmail || '';
				backupDestinations = d.destinations || [];
				backupHistory = d.history || [];
			}
		} catch {}
		backupLoading = false;
	}

	/**
	 * Save the backup settings and destinations as the page shows them. True
	 * when the server saved them; when it did not, the toast gives its reason,
	 * and a destination added, changed or removed just before is put back.
	 */
	async function saveBackupConfig(): Promise<boolean> {
		backupSaving = true;
		try {
			const res = await sent(
				() =>
					fetch('/api/admin/backup', {
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							schedule: backupSchedule,
							scheduleTime: backupScheduleTime,
							scheduleDay: backupScheduleDay,
							// A box cleared is no number, and is not sent: the retention
							// stored is kept. `null` is refused (card 2117).
							retention: backupRetention ?? undefined,
							notifyOnFailure: backupNotifyOnFailure,
							notifyEmail: backupNotifyEmail,
							destinations: backupDestinations
						})
					}),
				'Failed to save backup settings'
			);
			if (!res) return false;
			showToast('Backup settings saved');
			return true;
		} finally {
			backupSaving = false;
		}
	}

	async function addDestination() {
		if (!destName.trim()) { showToast('Destination name is required', 'error'); return; }
		if (backupDestinations.some(d => d.name === destName.trim())) { showToast('A destination with that name already exists', 'error'); return; }
		const was = backupDestinations;
		backupDestinations = [...backupDestinations, buildDestConfig()];
		if (!(await saveBackupConfig())) {
			// Not saved: off the list again, and still in the form as typed.
			backupDestinations = was;
			return;
		}
		resetDestForm();
		showAddDestination = false;
	}

	async function updateDestination() {
		if (!editingDest || !destName.trim()) return;
		const idx = backupDestinations.findIndex(d => d.name === editingDest);
		if (idx === -1) return;
		const was = backupDestinations;
		const updated = [...backupDestinations];
		updated[idx] = buildDestConfig();
		backupDestinations = updated;
		if (!(await saveBackupConfig())) {
			backupDestinations = was;
			return;
		}
		editingDest = null;
		resetDestForm();
	}

	async function removeDestination(name: string) {
		const was = backupDestinations;
		backupDestinations = backupDestinations.filter(d => d.name !== name);
		if (!(await saveBackupConfig())) backupDestinations = was;
	}

	function startEditDestination(dest: DestinationUI) {
		editingDest = dest.name;
		newDestType = dest.type;
		populateDestForm(dest);
	}

	async function testDestination(dest: DestinationUI) {
		testingDest = dest.name;
		const started = toasts.navigation();
		try {
			const res = await sent(
				() =>
					fetch('/api/admin/backup/test', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(dest)
					}),
				'Connection test failed'
			);
			if (!res) return;
			// Answered: whether the destination could be reached is in the answer.
			const result = await answerBody(res);
			const said = typeof result?.message === 'string' && result.message ? result.message : null;
			showToast(said || (result?.success ? 'Connection successful' : 'Connection failed'), result?.success ? 'success' : 'error', started);
		} finally {
			testingDest = null;
		}
	}

	async function runManualBackup() {
		backupRunning = true;
		const started = toasts.navigation();
		try {
			// A refusal used to be read as a backup to no destinations, and was
			// said to be "Backup completed to 0 destinations".
			const res = await sent(
				() =>
					fetch('/api/admin/backup', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({})
					}),
				'Backup failed'
			);
			if (!res) return;
			const result = await answerBody(res);
			const results = Array.isArray(result?.results) ? result.results : [];
			const failed = results.filter((r: any) => r.status === 'failed');
			if (failed.length === 0) {
				showToast(`Backup completed to ${results.length} destination${results.length !== 1 ? 's' : ''}`);
			} else {
				showToast(`${failed.length} of ${results.length} backup(s) failed`, 'error', started);
			}
			await loadBackupConfig();
		} finally {
			backupRunning = false;
		}
	}

	const destTypeLabels: Record<DestType, string> = {
		sftp: '🔐 SFTP / SCP',
		s3: '☁️ Amazon S3',
		gdrive: '📁 Google Drive',
		onedrive: '💙 OneDrive'
	};

	function formatBytes(bytes: number | null): string {
		if (!bytes) return '—';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatDuration(ms: number | null): string {
		if (!ms) return '—';
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function formatRelativeTime(dateStr: string): string {
		if (!dateStr) return '—';
		// The stored form, 'YYYY-MM-DD HH:MM:SS', is UTC with no zone: read as UTC.
		const d = parseStamp(dateStr);
		if (!d) return dateStr;
		const now = new Date();
		const diff = now.getTime() - d.getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.floor(hrs / 24);
		return `${days}d ago`;
	}

	/** Open Google OAuth consent and manage code exchange in a modal. */
	let gdriveConnecting = $state('');
	let gdriveAuthCode = $state('');
	let gdriveExchanging = $state(false);

	async function connectGDriveOAuth(destName: string) {
		gdriveConnecting = destName;
		gdriveAuthCode = '';
		const started = toasts.navigation();
		try {
			const res = await fetch(`/api/admin/backup/gdrive/auth?dest=${encodeURIComponent(destName)}`);
			if (!res.ok) { showToast('Failed to generate auth URL', 'error', started); gdriveConnecting = ''; return; }
			const { authUrl } = await res.json();
			window.open(authUrl, '_blank', 'width=600,height=700');
		} catch {
			showToast('Failed to start OAuth flow', 'error', started);
			gdriveConnecting = '';
		}
	}

	async function exchangeGDriveCode() {
		if (!gdriveAuthCode.trim() || !gdriveConnecting) return;
		gdriveExchanging = true;
		const started = toasts.navigation();

		// Extract the code from a full URL if the user pasted the entire redirect URL
		let code = gdriveAuthCode.trim();
		try {
			const urlObj = new URL(code);
			const codeParam = urlObj.searchParams.get('code');
			if (codeParam) code = codeParam;
		} catch { /* not a URL, use as-is */ }

		try {
			const res = await sent(
				() =>
					fetch('/api/admin/backup/gdrive/auth', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ code, destName: gdriveConnecting })
					}),
				'Failed to exchange authorization code'
			);
			if (!res) return;
			// Answered: whether Google gave a token to keep is in the answer.
			const result = await answerBody(res);
			const said = typeof result?.message === 'string' && result.message ? result.message : null;
			if (result?.success) {
				showToast(said || 'Google Drive connected!');
				await loadBackupConfig();
			} else {
				showToast(said || 'Failed to connect', 'error', started);
			}
		} finally {
			gdriveExchanging = false;
			gdriveConnecting = '';
			gdriveAuthCode = '';
		}
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

	async function exportDatabase() {
		exporting = true;
		const started = toasts.navigation();
		try {
			const res = await fetch('/api/admin/export');
			if (!res.ok) {
				// A refusal is an answer too, and was once saved as the backup: a
				// file of a few bytes of JSON, named .db, under "exported successfully".
				showToast(await failureMessage(res, 'Export failed: no file was saved'), 'error', started);
				return;
			}
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `dumpfire-backup-${new Date().toISOString().slice(0, 10)}.db`;
			document.body.append(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
			showToast('Database exported successfully');
		} catch {
			showToast('Export failed', 'error', started);
		} finally {
			exporting = false;
		}
	}

	// State, because it is bound to an element that is there for the superadmin only.
	let fileInput = $state<HTMLInputElement>();

	/**
	 * The import dialog, and which of its two ways to restore is chosen: `keep`
	 * restores everything as the backup has it, `off` restores a working copy.
	 * The choice outlives the dialog, because the file is picked after it closes.
	 */
	let showImportDialog = $state(false);
	let importOutside = $state<'keep' | 'off'>('keep');

	/** Opens the import dialog with this instance's default selected, whatever was chosen the last time. */
	function openImportDialog() {
		importOutside = data.importOutsideDefault;
		showImportDialog = true;
	}

	async function importDatabase() {
		fileInput?.click();
	}

	async function handleFileSelected(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;

		importing = true;
		const started = toasts.navigation();
		try {
			// In any case: a backup saved as BACKUP.DB is a .db backup.
			const named = file.name.toLowerCase();
			const isDbFile = named.endsWith('.db') || named.endsWith('.sqlite') || named.endsWith('.sqlite3');
			const what = `The backup "${file.name}"`;

			/**
			 * A failure that changed nothing, said in the report under the Import
			 * button. Not in a toast as well: a failure's toast stays until it is
			 * closed, so it was the same words twice, to be closed twice.
			 */
			const notImported = (headline: string) => {
				importReport = { headline, problems: [], reload: false, trouble: true };
			};

			// Only a .db backup is imported. Any other file is refused here, and
			// nothing is read or sent: the server would refuse it too. The old
			// JSON export is named, because it is the one file somebody may
			// still have that once was imported.
			if (!isDbFile) {
				notImported(
					`The file "${file.name}" is not a .db backup. Exports in the old JSON format, which DumpFire wrote only ` +
						'from 1 to 7 April 2026, are no longer imported. Nothing was sent.'
				);
				return;
			}

			// One of four things has gone wrong when an import is not accepted,
			// and each is said for what it is: see `uploadFailure` in $lib/api.
			// The first: the file could not be read here, so nothing was sent.
			let body: ArrayBuffer;
			try {
				body = await file.arrayBuffer();
			} catch {
				notImported(uploadNotRead(what));
				return;
			}

			// The second: no answer. It is not known whether the import ran.
			let res: Response;
			try {
				res = await fetch(`/api/admin/import?outside=${importOutside}`, {
					method: 'POST',
					// The file's bytes, as they are.
					headers: { 'Content-Type': 'application/octet-stream' },
					body
				});
			} catch {
				importReport = {
					headline: `${uploadNoAnswer(what)} Reload the page to see what the database holds.`,
					problems: [],
					reload: true,
					trouble: true
				};
				return;
			}

			// The third and the fourth: an answer that is not DumpFire's, which is
			// a proxy's refusal, and DumpFire's own 413. Nothing was changed by
			// either. Read from a copy, so that `uploadFailure` can read it too.
			const result: Record<string, any> | null = await answerBody(res.clone());
			if (result === null || res.status === 413) {
				notImported(await uploadFailure(res, what));
				return;
			}

			const problems: string[] = Array.isArray(result.errors) ? result.errors.map(String) : [];
			const restoredAs = result.outside ? 'Database restored as a working copy' : 'Database restored';
			if (res.ok && problems.length === 0) {
				// Restored, and nothing wrong with it. The toast says so in a few
				// words and is gone in three seconds; what was restored, and what a
				// working copy switched off, stays on the page until it is dismissed.
				// The page is not reloaded until then: a restore signs everybody
				// out, so the reload is a sign-in.
				importReport = { headline: restoredAs, ...accountOf(result), problems, reload: true, trouble: false };
				showToast(`${restoredAs}.`);
			} else if (res.ok) {
				// Restored, with something to read: a row that was left out, or one
				// that was copied and refers to a row that is not there. That is an
				// error to show, not a success with a footnote, and the report shows
				// it as one.
				importReport = {
					headline: `${restoredAs}, with ${problems.length} problem${problems.length === 1 ? '' : 's'}`,
					...accountOf(result),
					problems,
					reload: true,
					trouble: true
				};
			} else {
				// `committed` is the one failure after which the data has changed.
				importReport = { headline: result.message || 'Import failed', problems, reload: result.committed === true, trouble: true };
			}
		} catch {
			// None of the four, and not the file's doing: a fault in this page
			// once the answer was in. What the import did is not known from here,
			// and there is no report to say it in, so the toast does.
			showToast('The answer to the import could not be shown. Reload the page to see what the database holds.', 'error', started);
		} finally {
			importing = false;
			if (fileInput) fileInput.value = '';
		}
	}

	/**
	 * Puts the import report away and, if the database was changed, loads the
	 * page again from nothing. A full reload and not `invalidateAll`: the
	 * backup and mail panels are read once, when the page opens, and would go
	 * on showing what was there before the import. A restore brings in no
	 * session, so the reload is what asks for a sign-in.
	 */
	function dismissImportReport() {
		const reload = importReport?.reload === true;
		importReport = null;
		if (reload) window.location.reload();
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
			newUsername = ''; newEmail = ''; newPassword = ''; newUserRole = 'user'; newUserEmoji = '👤';
			await invalidateAll();
			showToast(result?.invited ? 'User created — invite email sent!' : 'User created');
		} finally {
			creatingUser = false;
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
				showToast(
					typeof sessionsEnded === 'number' && typeof apiKeysEnded === 'number'
						? `Password reset: ${counted(sessionsEnded, 'session')} and ${counted(apiKeysEnded, 'API key')} ended`
						: 'Password reset'
				);
				// The key counts are read again: the account now holds none.
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

	async function resendInvite(userId: number) {
		const res = await sent(() => fetch(`/api/users/${userId}/invite`, { method: 'POST' }), 'Failed to send invite');
		if (!res) return;
		const said = (await answerBody(res))?.message;
		showToast(typeof said === 'string' && said ? said : 'Invite sent!');
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

	async function loadSmtpConfig() {
		smtpLoading = true;
		try {
			const res = await fetch('/api/admin/smtp');
			if (res.ok) {
				const data = await res.json();
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
		<!-- Application Settings -->
		<section class="admin-card glass fade-in-up" style="animation-delay: 40ms">
			<h2>🌐 Application Settings</h2>
			<p class="section-desc">Configure the public URL for your DumpFire instance. Every link in a mail begins with it: an invite, a request's confirmation and reply links, and the links in notifications.</p>
			<div class="form-row" style="align-items: flex-end">
				<div style="flex: 2; display: flex; flex-direction: column; gap: 4px">
					<label style="font-size: 0.72rem; font-weight: 600; color: var(--text-secondary)">Application URL</label>
					<input type="url" placeholder="https://kanban.example.com" bind:value={appUrl} class="form-input" />
				</div>
				<button class="btn-primary btn-sm" onclick={saveAppUrl} disabled={appUrlSaving} style="flex: none">
					{appUrlSaving ? 'Saving...' : 'Save'}
				</button>
			</div>
			{#if !appUrl}
				<p style="font-size: 0.68rem; color: var(--accent-amber); margin-top: var(--space-xs)">
					⚠️ No App URL set. Links in mail begin with the address the server was started with (ORIGIN), and never with what a request says. If that is not the address people reach this server at, set it here.
				</p>
			{/if}
		</section>

		<!-- Backup & Restore -->
		<section class="admin-card glass fade-in-up" style="animation-delay: 80ms">
			<h2>💾 Backup & Restore</h2>
			<p class="section-desc">Export a complete backup of your entire database as a SQLite file, or restore from a previous backup. Captures everything automatically — users, teams, boards, cards, settings, and all other data.</p>

			<div class="backup-actions">
				<div class="backup-item">
					<div class="backup-icon export-icon">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
							<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
					</div>
					<div class="backup-info">
						<strong>Export Database</strong>
						<p>Download the complete database as a .db file — includes all data automatically.</p>
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
					<button class="btn-backup import" onclick={openImportDialog} disabled={importing}>
						{#if importing}
							<span class="spinner"></span> Importing...
						{:else}
							<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 12V4m0 0L4 7m3-3l3 3M2 2v1a1 1 0 001 1h8a1 1 0 001-1V2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
							Import Backup
						{/if}
					</button>
				</div>
			</div>

			{#if importReport}
				<div class="import-report" class:import-report-done={!importReport.trouble} role={importReport.trouble ? 'alert' : 'status'}>
					<strong>{importReport.headline}</strong>
					{#if importReport.detail}
						<p class="import-report-detail">{importReport.detail}</p>
					{/if}
					{#if importReport.putBack}
						<p class="import-report-detail">{importReport.putBack}</p>
					{/if}
					{#if importReport.requestLinks}
						<p class="import-report-detail">{importReport.requestLinks}</p>
					{/if}
					{#if importReport.workingCopy}
						<p class="import-report-detail">{importReport.workingCopy}</p>
					{/if}
					{#if importReport.secretsKept}
						<p class="import-report-detail">{importReport.secretsKept}</p>
					{/if}
					{#if importReport.secretsToEnter}
						<p class="import-report-detail">{importReport.secretsToEnter}</p>
					{/if}
					{#if importReport.superadmin}
						<p class="import-report-detail">{importReport.superadmin}</p>
					{/if}
					{#if importReport.tables && importReport.tables.length > 0}
						<details class="import-report-tables">
							<summary>All {importReport.tables.length} tables restored</summary>
							<dl>
								{#each importReport.tables as [table, rows]}
									<div><dt>{table}</dt><dd>{count(rows)}</dd></div>
								{/each}
							</dl>
						</details>
					{/if}
					{#if importReport.problems.length > 0}
						<ul>
							{#each importReport.problems.slice(0, 100) as problem}
								<li>{problem}</li>
							{/each}
						</ul>
						{#if importReport.problems.length > 100}
							<p>…and {importReport.problems.length - 100} more.</p>
						{/if}
					{/if}
					<button class="btn-ghost btn-sm" onclick={dismissImportReport}>
						{importReport.reload ? 'Dismiss and reload' : 'Dismiss'}
					</button>
				</div>
			{/if}

			<input type="file" accept=".db,.sqlite,.sqlite3" class="hidden-input" bind:this={fileInput} onchange={handleFileSelected} />
		</section>

		<!-- Scheduled Backups -->
		<section class="admin-card glass fade-in-up" style="animation-delay: 120ms">
			<div class="section-header">
				<h2>☁️ Scheduled Backups</h2>
				<div style="display: flex; gap: var(--space-sm); align-items: center">
					{#if backupDestinations.length > 0}
						<button class="btn-primary btn-sm" onclick={runManualBackup} disabled={backupRunning}>
							{backupRunning ? '⏳ Running...' : '▶ Run Now'}
						</button>
					{/if}
					<button class="btn-primary btn-sm" onclick={() => { resetDestForm(); newDestType = 'sftp'; showAddDestination = true; }}>+ Add Destination</button>
				</div>
			</div>

			{#if backupLoading}
				<p class="empty-msg">Loading backup config...</p>
			{:else}
				<!-- Schedule Settings -->
				<div class="sched-config">
					<div class="sched-row">
						<label class="sched-label">Schedule</label>
						<select bind:value={backupSchedule} class="form-input" style="flex: none; width: 160px" onchange={() => saveBackupConfig()}>
							<option value="disabled">Disabled</option>
							<option value="hourly">Every Hour</option>
							<option value="every6h">Every 6 Hours</option>
							<option value="every12h">Every 12 Hours</option>
							<option value="daily">Daily</option>
							<option value="weekly">Weekly</option>
						</select>

						{#if backupSchedule === 'weekly'}
							<label class="sched-label" style="margin-left: var(--space-md)">on</label>
							<select bind:value={backupScheduleDay} class="form-input" style="flex: none; width: 120px" onchange={() => saveBackupConfig()}>
								<option value={0}>Sunday</option>
								<option value={1}>Monday</option>
								<option value={2}>Tuesday</option>
								<option value={3}>Wednesday</option>
								<option value={4}>Thursday</option>
								<option value={5}>Friday</option>
								<option value={6}>Saturday</option>
							</select>
						{/if}

						{#if backupSchedule === 'daily' || backupSchedule === 'weekly'}
							<label class="sched-label" style="margin-left: var(--space-md)">at</label>
							<input type="time" bind:value={backupScheduleTime} class="form-input" style="flex: none; width: 110px" onchange={() => saveBackupConfig()} />
						{/if}

						<label class="sched-label" style="margin-left: var(--space-lg)">Keep Last</label>
						<input type="number" min="1" max="100" bind:value={backupRetention} class="form-input" style="flex: none; width: 60px" onchange={() => saveBackupConfig()} />
						<span style="font-size: 0.75rem; color: var(--text-tertiary)">backups</span>
					</div>

					<div class="sched-row">
						<label style="display: flex; align-items: center; gap: var(--space-xs); font-size: 0.78rem; color: var(--text-secondary); cursor: pointer">
							<input type="checkbox" bind:checked={backupNotifyOnFailure} onchange={() => saveBackupConfig()} /> Email on failure
						</label>
						{#if backupNotifyOnFailure}
							<input type="email" placeholder="Notification email" bind:value={backupNotifyEmail} class="form-input" style="flex: 1; max-width: 250px" onchange={() => saveBackupConfig()} />
						{/if}
					</div>
				</div>

				<!-- Destinations -->
				{#if backupDestinations.length === 0 && !showAddDestination}
					<p class="empty-msg">No backup destinations configured. Add one to get started.</p>
				{/if}

				{#each backupDestinations as dest (dest.name)}
					<div class="dest-card">
						<div class="dest-card-header">
							<span class="dest-type-badge dest-type-{dest.type}">{destTypeLabels[dest.type] || dest.type}</span>
							<span class="dest-name">{dest.name}</span>
							<div class="dest-actions">
								{#if dest.type === 'gdrive' && dest.authMethod === 'oauth'}
									<!-- By the scope Google granted, recorded at Connect: none recorded is a connection made before card 2188, with all of Drive. No button to connect it over again: narrowing starts in the Google account (the line under the row). -->
									{#if dest.refreshToken}
										{#if driveScopeIsNarrow(dest.grantedScope)}
											<span style="font-size: 0.68rem; color: var(--accent-emerald)">✅ Connected</span>
										{:else}
											<span style="font-size: 0.68rem; color: var(--accent-amber)">⚠️ Connected · all of Drive</span>
										{/if}
									{:else}
										<button class="btn-ghost btn-xs" style="color: var(--accent-indigo)" onclick={() => connectGDriveOAuth(dest.name)}>🔗 Connect</button>
									{/if}
								{/if}
								<button class="btn-ghost btn-xs" onclick={() => testDestination(dest)} disabled={testingDest === dest.name}>
									{testingDest === dest.name ? '⏳' : '🧪'} Test
								</button>
								<button class="btn-ghost btn-xs" onclick={() => startEditDestination(dest)}>✏️ Edit</button>
								<!-- Off while the destinations are being saved: a second removal sent before the first was answered was put back wrongly when the first was refused. -->
								<button class="btn-ghost btn-xs danger" disabled={backupSaving} onclick={() => confirm('Remove Destination', `Remove "${dest.name}" from backup destinations?`, async () => removeDestination(dest.name))}>🗑️</button>
							</div>
						</div>
						<div class="dest-card-detail">
							{#if dest.type === 'sftp'}
								<span>{dest.host}:{dest.port} → {dest.remotePath}</span>
							{:else if dest.type === 's3'}
								<span>{dest.bucket}{dest.prefix ? `/${dest.prefix}` : ''} ({dest.region})</span>
							{:else if dest.type === 'gdrive'}
								<span>{dest.authMethod === 'oauth' ? '🔑 OAuth' : '🏢 Service Account'} · Folder: {dest.folderId}</span>
							{:else if dest.type === 'onedrive'}
								<span>{dest.folderPath}</span>
							{/if}
						</div>
						{#if dest.type === 'gdrive' && dest.authMethod === 'oauth' && dest.refreshToken && !driveScopeIsNarrow(dest.grantedScope)}
							<p style="font-size: 0.68rem; color: var(--text-tertiary); margin: var(--space-xs) 0 0">
								Connected with access to all of this Google account's Drive. To narrow it: first remove DumpFire's access in the Google account (Google Account, Security, Your connections to third-party apps and services), then remove this destination, add it again with the Folder ID left empty, and connect it. See the admin guide, Configuring Backups.
							</p>
						{/if}

						<!-- Inline edit form -->
						{#if editingDest === dest.name}
							<div class="dest-edit-form">
								<div class="form-row">
									<input type="text" placeholder="Destination name" bind:value={destName} class="form-input" />
								</div>
								{#if newDestType === 'sftp'}
									<div class="form-row">
										<input type="text" placeholder="Host" bind:value={destHost} class="form-input" />
										<input type="number" placeholder="Port" bind:value={destPort} class="form-input" style="width: 70px; flex: none" />
										<input type="text" placeholder="Username" bind:value={destUsername} class="form-input" />
									</div>
									<div class="form-row">
										<input type="password" placeholder="Password" bind:value={destPassword} class="form-input" />
										<input type="text" placeholder="Remote path" bind:value={destRemotePath} class="form-input" />
									</div>
								{:else if newDestType === 's3'}
									<div class="form-row">
										<input type="text" placeholder="Bucket" bind:value={destBucket} class="form-input" />
										<input type="text" placeholder="Region" bind:value={destRegion} class="form-input" style="width: 120px; flex: none" />
									</div>
									<div class="form-row">
										<input type="text" placeholder="Access Key ID" bind:value={destAccessKey} class="form-input" />
										<input type="password" placeholder="Secret Access Key" bind:value={destSecretKey} class="form-input" />
									</div>
									<div class="form-row">
										<input type="text" placeholder="Path prefix (optional)" bind:value={destPrefix} class="form-input" />
										<input type="text" placeholder="Custom endpoint (optional)" bind:value={destEndpoint} class="form-input" />
									</div>
								{:else if newDestType === 'gdrive'}
									<div class="form-row">
										<select bind:value={destGdriveAuthMethod} class="form-input" style="flex: none; width: 180px">
											<option value="oauth">🔑 OAuth (Personal)</option>
											<option value="service_account">🏢 Service Account</option>
										</select>
										<input type="text" placeholder={destGdriveAuthMethod === 'oauth' ? 'Folder ID (leave empty: DumpFire makes one when you connect)' : 'Folder ID'} bind:value={destFolderId} class="form-input" />
									</div>
									{#if destGdriveAuthMethod === 'oauth'}
										<div class="form-row">
											<input type="text" placeholder="OAuth Client ID" bind:value={destGdriveClientId} class="form-input" />
											<input type="password" placeholder="OAuth Client Secret" bind:value={destGdriveClientSecret} class="form-input" />
										</div>
										{#if destGdriveRefreshToken}
											<p style="font-size: 0.72rem; color: var(--accent-emerald)">✅ Google account connected</p>
										{:else}
											<p style="font-size: 0.68rem; color: var(--text-tertiary); margin: var(--space-xs) 0 0">
												DumpFire asks Google only for the files it makes. Leave the Folder ID empty: when you connect, DumpFire makes a folder of its own, "{dumpfireFolderName()}". A folder you made yourself may not be reachable. To keep using a folder DumpFire made, give its Folder ID again (shown on the destination as Folder:); Connect checks it can reach it.
											</p>
											<p style="font-size: 0.68rem; color: var(--text-tertiary)">Save first, then use "Connect Google Account" on the destination card.</p>
										{/if}
									{:else}
										<div class="form-row">
											<textarea placeholder="Service Account JSON" bind:value={destServiceAccountJson} class="form-input" rows="4" style="font-family: monospace; font-size: 0.72rem"></textarea>
										</div>
									{/if}
								{:else if newDestType === 'onedrive'}
									<div class="form-row">
										<input type="text" placeholder="Tenant ID" bind:value={destTenantId} class="form-input" />
										<input type="text" placeholder="Client ID" bind:value={destClientId} class="form-input" />
									</div>
									<div class="form-row">
										<input type="password" placeholder="Client Secret" bind:value={destClientSecret} class="form-input" />
										<input type="text" placeholder="Folder path" bind:value={destFolderPath} class="form-input" />
									</div>
								{/if}
								<!-- A refused save leaves this form open as typed, with the server's reason in the toast (card 2190). -->
								<p style="font-size: 0.68rem; color: var(--text-tertiary); margin: var(--space-xs) 0 0">
									A saved password, key or secret is kept only while the destination's name and settings stay as they were saved: type it again when you change them. A connected Google Drive destination is removed, added again and connected.
								</p>
								<div class="form-row" style="justify-content: flex-end">
									<button class="btn-ghost btn-sm" onclick={() => { editingDest = null; resetDestForm(); }}>Cancel</button>
									<button class="btn-primary btn-sm" onclick={updateDestination} disabled={!destName.trim()}>Save</button>
								</div>
							</div>
						{/if}
					</div>
				{/each}

				<!-- Add Destination Form -->
				{#if showAddDestination}
					<div class="dest-add-form">
						<h3 style="font-size: 0.9rem; margin-bottom: var(--space-md)">Add Backup Destination</h3>
						<div class="form-row">
							<input type="text" placeholder="Destination name (e.g. Production NAS)" bind:value={destName} class="form-input" />
							<select bind:value={newDestType} class="form-input" style="flex: none; width: 160px">
								<option value="sftp">🔐 SFTP / SCP</option>
								<option value="s3">☁️ Amazon S3</option>
								<option value="gdrive">📁 Google Drive</option>
								<option value="onedrive">💙 OneDrive</option>
							</select>
						</div>

						{#if newDestType === 'sftp'}
							<div class="form-row">
								<input type="text" placeholder="Host" bind:value={destHost} class="form-input" />
								<input type="number" placeholder="Port" bind:value={destPort} class="form-input" style="width: 70px; flex: none" />
								<input type="text" placeholder="Username" bind:value={destUsername} class="form-input" />
							</div>
							<div class="form-row">
								<input type="password" placeholder="Password" bind:value={destPassword} class="form-input" />
								<input type="text" placeholder="Remote path (e.g. /backups)" bind:value={destRemotePath} class="form-input" />
							</div>
							<details style="margin-top: var(--space-xs)">
								<summary style="font-size: 0.72rem; color: var(--text-tertiary); cursor: pointer">Advanced: Private Key auth</summary>
								<textarea placeholder="Paste private key (PEM format)" bind:value={destPrivateKey} class="form-input" rows="3" style="margin-top: var(--space-xs); font-family: monospace; font-size: 0.7rem; width: 100%"></textarea>
							</details>
						{:else if newDestType === 's3'}
							<div class="form-row">
								<input type="text" placeholder="Bucket name" bind:value={destBucket} class="form-input" />
								<input type="text" placeholder="Region (e.g. us-east-1)" bind:value={destRegion} class="form-input" style="width: 140px; flex: none" />
							</div>
							<div class="form-row">
								<input type="text" placeholder="Access Key ID" bind:value={destAccessKey} class="form-input" />
								<input type="password" placeholder="Secret Access Key" bind:value={destSecretKey} class="form-input" />
							</div>
							<div class="form-row">
								<input type="text" placeholder="Path prefix (e.g. dumpfire/)" bind:value={destPrefix} class="form-input" />
								<input type="text" placeholder="Custom endpoint (MinIO, Backblaze, etc.)" bind:value={destEndpoint} class="form-input" />
							</div>
						{:else if newDestType === 'gdrive'}
						<div class="form-row">
							<select bind:value={destGdriveAuthMethod} class="form-input" style="flex: none; width: 180px">
								<option value="oauth">🔑 OAuth (Personal)</option>
								<option value="service_account">🏢 Service Account</option>
							</select>
							<input type="text" placeholder={destGdriveAuthMethod === 'oauth' ? 'Folder ID (leave empty: DumpFire makes one when you connect)' : 'Google Drive Folder ID'} bind:value={destFolderId} class="form-input" />
						</div>
						{#if destGdriveAuthMethod === 'oauth'}
							<div class="form-row">
								<input type="text" placeholder="OAuth Client ID" bind:value={destGdriveClientId} class="form-input" />
								<input type="password" placeholder="OAuth Client Secret" bind:value={destGdriveClientSecret} class="form-input" />
							</div>
							<p style="font-size: 0.68rem; color: var(--text-tertiary); margin: var(--space-xs) 0 0">
								DumpFire asks Google only for the files it makes. Leave the Folder ID empty: when you connect, DumpFire makes a folder of its own, "{dumpfireFolderName()}". A folder you made yourself may not be reachable. To keep using a folder DumpFire made, give its Folder ID again (shown on the destination as Folder:); Connect checks it can reach it.
							</p>
							<p style="font-size: 0.68rem; color: var(--text-tertiary); margin: var(--space-xs) 0 0">
								1. Go to <strong>Google Cloud Console → APIs &amp; Services → Credentials</strong><br/>
								2. Create an <strong>OAuth 2.0 Client ID</strong> — select <strong>"Desktop app"</strong> as type<br/>
								3. Enable the <strong>Google Drive API</strong> at <strong>APIs &amp; Services → Library</strong><br/>
								4. After adding the destination, click <strong>"🔗 Connect"</strong> to authorize your Google account
							</p>
						{:else}
							<div class="form-row">
								<textarea placeholder="Paste Service Account JSON credentials" bind:value={destServiceAccountJson} class="form-input" rows="5" style="font-family: monospace; font-size: 0.72rem"></textarea>
							</div>
							<p style="font-size: 0.68rem; color: var(--text-tertiary); margin: var(--space-xs) 0 0">
								Create a Service Account in Google Cloud Console → Enable Drive API → Share the folder with the service account email.
							</p>
						{/if}
						{:else if newDestType === 'onedrive'}
							<div class="form-row">
								<input type="text" placeholder="Azure Tenant ID" bind:value={destTenantId} class="form-input" />
								<input type="text" placeholder="App Client ID" bind:value={destClientId} class="form-input" />
							</div>
							<div class="form-row">
								<input type="password" placeholder="Client Secret" bind:value={destClientSecret} class="form-input" />
								<input type="text" placeholder="Folder path (e.g. /DumpFire Backups)" bind:value={destFolderPath} class="form-input" />
							</div>
							<p style="font-size: 0.68rem; color: var(--text-tertiary); margin: var(--space-xs) 0 0">
								Register an app in Azure AD → Add Files.ReadWrite.All permission → Create a client secret.
							</p>
						{/if}

						<div class="form-row" style="justify-content: flex-end; margin-top: var(--space-sm)">
							<button class="btn-ghost btn-sm" onclick={() => { showAddDestination = false; resetDestForm(); }}>Cancel</button>
							<button class="btn-primary btn-sm" onclick={addDestination} disabled={!destName.trim()}>Add Destination</button>
						</div>
					</div>
				{/if}

				<!-- Backup History -->
				{#if backupHistory.length > 0}
					<div class="backup-history">
						<div style="display: flex; align-items: center; justify-content: space-between; margin: var(--space-xl) 0 var(--space-md)">
							<h3 style="font-size: 0.85rem; margin: 0">📜 Backup History</h3>
							<div style="display: flex; gap: var(--space-sm); align-items: center">
								<span style="font-size: 0.7rem; color: var(--text-tertiary)">{backupHistory.length} entries</span>
							</div>
						</div>
						<div class="history-table-wrap">
							<table class="history-table">
								<thead>
									<tr>
										<th>When</th>
										<th>Destination</th>
										<th>Status</th>
										<th>Size</th>
										<th>Time</th>
									</tr>
								</thead>
								<tbody>
									{#each (showAllHistory ? backupHistory : backupHistory.slice(0, 5)) as entry (entry.id)}
										<tr class="history-row" class:history-failed={entry.status === 'failed'}>
											<td title={entry.createdAt}>{formatRelativeTime(entry.createdAt)}</td>
											<td>
												<span class="dest-type-badge-sm dest-type-{entry.destinationType}">{entry.destinationType}</span>
												{entry.destinationName}
											</td>
											<td>
												{#if entry.status === 'success'}
													<span class="status-success">✅</span>
												{:else}
													<span class="status-failed" title={entry.error || ''}>❌ {entry.error?.slice(0, 40)}{(entry.error?.length ?? 0) > 40 ? '...' : ''}</span>
												{/if}
											</td>
											<td>{formatBytes(entry.sizeBytes)}</td>
											<td>{formatDuration(entry.durationMs)}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
						{#if backupHistory.length > 5}
							<button class="btn-ghost btn-sm" style="margin-top: var(--space-sm); font-size: 0.72rem" onclick={() => showAllHistory = !showAllHistory}>
								{showAllHistory ? '▲ Show less' : `▼ Show all ${backupHistory.length} entries`}
							</button>
						{/if}
					</div>
				{/if}
			{/if}
		</section>
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
									<button class="btn-ghost btn-sm" onclick={() => resendInvite(u.id)} title="Resend invite email">📧</button>
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
						<p>Your API keys keep working. To end them too, change your password on the <a href="/account">Account page</a>.</p>
						<input type="password" placeholder="Current password" bind:value={resetPasswordCurrent} class="form-input" style="width: 100%; margin: var(--space-md) 0 0;" autocomplete="current-password" />
					{:else}
						<p>Enter a new password for {resetTarget?.username || 'user'}.</p>
						{#if resetTargetKeys !== null && resetTargetKeys > 0}
							<p class="warning-text">They have {counted(resetTargetKeys, 'API key')}, which {resetTargetKeys === 1 ? 'stops' : 'stop'} working.</p>
						{/if}
						<p>They are signed out everywhere, every API key they have stops working, and any invite not yet used stops working.</p>
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

<!-- Import dialog: the warning, and which of the two ways to restore -->
{#if showImportDialog}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-overlay" role="dialog" aria-modal="true">
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="modal-content confirm-modal" onclick={(e) => e.stopPropagation()} role="document" style="max-width: 520px">
			<h2>Import Database</h2>
			<p style="margin-bottom: var(--space-md)">This will REPLACE ALL existing data with the backup — users, teams, boards, cards, comments, labels, task requests, and settings will all be overwritten. Everybody is signed out, you included: no session is restored, whatever the backup holds, so you will sign in again with an account the backup has. Invites that have not been used yet stop working. A backup with users and no superadmin among them is refused.</p>
			<div class="import-choices" role="radiogroup" aria-label="How to restore the backup">
				<label class="import-choice" class:selected={importOutside === 'keep'}>
					<input type="radio" name="import-outside" value="keep" bind:group={importOutside} />
					<span>
						<strong>Restore everything as it is</strong>
						<span class="import-choice-desc">For putting this installation back. Backup destinations, report schedules, mail settings and webhooks come back as the backup has them. A backup holds no mail password, destination credential or webhook secret: the ones this server has for the same accounts are kept, and the result lists any to enter again; a webhook that had a secret stays off until it is set.</span>
					</span>
				</label>
				<label class="import-choice" class:selected={importOutside === 'off'}>
					<input type="radio" name="import-outside" value="off" bind:group={importOutside} />
					<span>
						<strong>Restore as a working copy</strong>
						<span class="import-choice-desc">For a copy that must not reach outside. Report schedules and webhooks are switched off, the backup schedule is switched off and its destinations removed, and the mail settings are removed. Everything else is restored.</span>
					</span>
				</label>
				{#if data.importOutsideDefault === 'off' && importOutside === 'off'}
					<span class="import-default-note">Working copy is selected because this instance's schedulers are off.</span>
				{/if}
			</div>
			<div class="modal-actions">
				<button class="btn-ghost" onclick={() => (showImportDialog = false)}>Cancel</button>
				<button class="btn-danger-solid" onclick={async () => { showImportDialog = false; await importDatabase(); }}>Confirm</button>
			</div>
		</div>
	</div>
{/if}

<!-- Google Drive OAuth code entry -->
{#if gdriveConnecting}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-overlay" role="dialog" aria-modal="true">
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="modal-content confirm-modal" onclick={(e) => e.stopPropagation()} role="document" style="max-width: 520px">
			<h2>🔗 Connect Google Drive</h2>
			<p style="margin-bottom: var(--space-md)">
				A Google sign-in window has opened. After granting access, Google will redirect to a page that may not load — <strong>that's expected</strong>.
			</p>
			<p style="font-size: 0.78rem; color: var(--text-secondary); margin-bottom: var(--space-md); line-height: 1.5">
				Copy the <strong>entire URL</strong> from your browser's address bar (it will contain <code style="background: var(--bg-elevated); padding: 1px 4px; border-radius: 3px; font-size: 0.72rem">code=</code>) and paste it below:
			</p>
			<input
				type="text"
				placeholder="Paste the full URL or authorization code here..."
				bind:value={gdriveAuthCode}
				class="form-input"
				style="width: 100%; font-family: monospace; font-size: 0.78rem; margin-bottom: var(--space-md)"
			/>
			<div class="modal-actions">
				<button class="btn-ghost" onclick={() => { gdriveConnecting = ''; gdriveAuthCode = ''; }}>Cancel</button>
				<button class="btn-primary" onclick={exchangeGDriveCode} disabled={!gdriveAuthCode.trim() || gdriveExchanging}>
					{gdriveExchanging ? '⏳ Connecting...' : '✅ Connect'}
				</button>
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

	/* What an import could not do: stays until dismissed */
	.import-report {
		margin-top: var(--space-md); padding: var(--space-lg);
		background: rgba(244, 63, 94, 0.08);
		border: 1px solid var(--accent-rose); border-radius: var(--radius-md);
		font-size: 0.85rem; line-height: 1.5;
		display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-sm);
	}
	.import-report strong { color: var(--accent-rose); }
	.import-report ul {
		margin: 0; padding-left: var(--space-lg);
		max-height: 240px; overflow-y: auto; align-self: stretch;
		color: var(--text-secondary); overflow-wrap: anywhere;
	}
	.import-report p { margin: 0; color: var(--text-tertiary); }
	/* Nothing wrong: what was restored, and what a working copy switched off */
	.import-report-done { background: rgba(52, 211, 153, 0.08); border-color: var(--accent-emerald); }
	.import-report-done strong { color: var(--accent-emerald); }
	.import-report strong { font-size: 0.95rem; }
	.import-report p.import-report-detail { color: var(--text-secondary); }
	.import-report-tables { align-self: stretch; color: var(--text-secondary); }
	.import-report-tables summary { cursor: pointer; color: var(--text-tertiary); font-size: 0.8rem; }
	.import-report-tables dl {
		margin: var(--space-sm) 0 0; display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 2px var(--space-lg);
	}
	.import-report-tables dl div { display: flex; justify-content: space-between; gap: var(--space-md); font-size: 0.8rem; }
	.import-report-tables dt { color: var(--text-tertiary); }
	.import-report-tables dd { margin: 0; font-variant-numeric: tabular-nums; }

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
	/* What a reset could not move to the trash */
	.reset-problems {
		margin: 0 0 var(--space-xl); padding-left: var(--space-lg);
		max-height: 240px; overflow-y: auto;
		font-size: 0.8rem; color: var(--text-secondary); line-height: 1.5; overflow-wrap: anywhere;
	}

	/* Import dialog: the two ways to restore */
	.import-choices { display: flex; flex-direction: column; gap: var(--space-sm); margin-bottom: var(--space-xl); }
	.import-choice {
		display: flex; align-items: flex-start; gap: var(--space-sm);
		padding: var(--space-md); background: var(--bg-base);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
		cursor: pointer; transition: border-color 0.2s ease;
	}
	.import-choice:hover, .import-choice.selected { border-color: var(--accent-indigo); }
	/* The global rule for inputs gives every one of them the full width and a
	   text field's padding. A radio button takes its own size here, and the
	   words beside it take the rest of the row. */
	.import-choice input {
		width: auto; padding: 0; margin: 3px 0 0; flex: none;
		border: none; background: none; cursor: pointer;
	}
	.import-choice > span { flex: 1; min-width: 0; }
	.import-choice strong { font-size: 0.9rem; display: block; margin-bottom: 4px; }
	.import-choice-desc { font-size: 0.78rem; color: var(--text-tertiary); line-height: 1.4; display: block; }
	.import-default-note { font-size: 0.78rem; color: var(--text-secondary); line-height: 1.4; }

	.empty-msg { font-size: 0.85rem; color: var(--text-tertiary); text-align: center; padding: var(--space-xl); }

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
	/* While the way out is ticked (card 2189) */
	.smtp-warning { background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); color: var(--accent-amber); }
	.smtp-hint { font-size: 0.68rem; color: var(--text-tertiary); margin: 0 0 var(--space-xs); }

	/* Scheduled Backups */
	.sched-config {
		padding: var(--space-md) var(--space-lg);
		background: var(--bg-base); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); margin-bottom: var(--space-lg);
		display: flex; flex-direction: column; gap: var(--space-sm);
	}
	.sched-row {
		display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap;
	}
	.sched-label {
		font-size: 0.78rem; font-weight: 600; color: var(--text-secondary); white-space: nowrap;
	}

	.dest-card {
		background: var(--bg-base); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); overflow: hidden;
		margin-bottom: var(--space-sm); transition: border-color 0.15s;
	}
	.dest-card:hover { border-color: var(--accent-indigo); }
	.dest-card-header {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-md) var(--space-lg);
	}
	.dest-name { font-weight: 600; font-size: 0.85rem; flex: 1; }
	.dest-actions { display: flex; gap: var(--space-xs); }
	.dest-card-detail {
		padding: 0 var(--space-lg) var(--space-md);
		font-size: 0.72rem; color: var(--text-tertiary);
	}

	.dest-type-badge {
		font-size: 0.65rem; font-weight: 700; padding: 2px 8px;
		border-radius: var(--radius-sm); white-space: nowrap;
	}
	.dest-type-badge-sm {
		font-size: 0.6rem; font-weight: 700; padding: 1px 5px;
		border-radius: 3px; white-space: nowrap;
	}
	.dest-type-sftp { background: rgba(34, 197, 94, 0.12); color: #22c55e; }
	.dest-type-s3 { background: rgba(249, 115, 22, 0.12); color: #f97316; }
	.dest-type-gdrive { background: rgba(59, 130, 246, 0.12); color: #3b82f6; }
	.dest-type-onedrive { background: rgba(99, 102, 241, 0.12); color: #6366f1; }

	.dest-edit-form, .dest-add-form {
		padding: var(--space-lg); background: var(--bg-base);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
		margin-bottom: var(--space-sm);
		display: flex; flex-direction: column; gap: var(--space-sm);
	}
	.dest-edit-form {
		border-top: 1px solid var(--glass-border);
		margin: 0; border-radius: 0 0 var(--radius-md) var(--radius-md);
	}
	.dest-add-form {
		border-color: var(--accent-indigo);
		background: var(--bg-elevated);
	}

	/* History table */
	.history-table-wrap {
		overflow-x: auto; border-radius: var(--radius-md);
		border: 1px solid var(--glass-border);
	}
	.history-table {
		width: 100%; border-collapse: collapse; font-size: 0.75rem;
	}
	.history-table th {
		text-align: left; padding: var(--space-sm) var(--space-md);
		font-weight: 600; font-size: 0.68rem; text-transform: uppercase;
		letter-spacing: 0.05em; color: var(--text-tertiary);
		background: var(--bg-base); border-bottom: 1px solid var(--glass-border);
	}
	.history-table td {
		padding: var(--space-xs) var(--space-md);
		border-bottom: 1px solid var(--glass-border);
		vertical-align: middle;
	}
	.history-row:last-child td { border-bottom: none; }
	.history-failed { opacity: 0.85; }
	.history-failed td:first-child { border-left: 3px solid var(--accent-rose); }

	.status-success { color: var(--accent-emerald); }
	.status-failed { color: var(--accent-rose); font-size: 0.68rem; }
</style>
