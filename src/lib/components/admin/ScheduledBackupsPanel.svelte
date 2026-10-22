<!--
  ScheduledBackupsPanel.svelte — The admin page's Scheduled Backups: the
  schedule, the destinations with their Test, Edit, Confirm and Remove, the
  add and edit forms, the history, and Google Drive's Connect (card 2281,
  slice C1a: moved from src/routes/admin/+page.svelte).

  Every administrator's since card 2395 (the superadmin's alone before): the
  page draws it for each of them, and it reads the backup settings itself as
  it opens. The add form and every
  edit form share one set of fields, kept here, as they were on the page, so
  only one of them is open at a time: opening one closes the other (card
  2305). Remove asks first through the page's confirm, the app's
  ConfirmModal (card 2362).

  Lowering Keep Last, removing a destination and switching the schedule off
  are the superadmin's alone (card 2398): the server refuses them to anyone
  else. For an administrator who is not the superadmin, 🗑️ and the schedule's
  Disabled are aria-disabled (not disabled, which would drop the focus) and
  say why when pressed, Keep Last takes a higher number and puts a lower one
  back, and one line under the schedule says the rule. Nothing of it is sent.
-->
<script lang="ts">
	import { answerBody, failureMessage } from '$lib/api';
	import { NO_ANSWER, sent, showToast } from '$lib/admin/send';
	import { destTypeLabels, type BackupHistoryEntry, type DestType } from '$lib/admin/format';
	import { toasts } from '$lib/stores/toast';
	import { driveScopeIsNarrow } from '$lib/drive-scope';
	import BackupHistory from './BackupHistory.svelte';
	import DestinationForm from './DestinationForm.svelte';
	import GDriveConnectModal from './GDriveConnectModal.svelte';

	/**
	 * The page's confirm dialog, which asks before a destination is removed;
	 * and whether the reader is the superadmin, who alone lowers Keep Last,
	 * removes a destination or switches the schedule off (card 2398). Not
	 * given, the reader is taken to be an administrator: the server decides
	 * either way.
	 */
	let {
		confirm,
		isSuperadmin = false
	}: { confirm: (title: string, message: string, action: () => Promise<void>) => void; isSuperadmin?: boolean } = $props();

	/** What an administrator is told of what is the superadmin's (card 2398), the server's own words. */
	const SUPERADMIN_RULE = 'Lowering Keep Last, removing a destination or switching the schedule off needs the superadmin.';

	// ─── Scheduled Backups ────────────────────────────────────────────────

	interface DestinationUI {
		type: DestType;
		name: string;
		[key: string]: unknown;
	}

	let backupSchedule = $state('disabled');
	let backupScheduleTime = $state('02:00');
	let backupScheduleDay = $state(0);
	let backupRetention = $state(7);
	let backupNotifyOnFailure = $state(false);
	let backupNotifyEmail = $state('');
	let backupDestinations = $state<DestinationUI[]>([]);
	/**
	 * Keep Last and the schedule as the server holds them, as last read or
	 * saved: an administrator's lower Keep Last, or Disabled, is put back to
	 * these (card 2398).
	 */
	let storedRetention = $state(7);
	let storedSchedule = $state('disabled');
	let backupHistory = $state<BackupHistoryEntry[]>([]);
	let showAllHistory = $state(false);
	let backupLoading = $state(true);
	let backupSaving = $state(false);
	let backupRunning = $state(false);
	let showAddDestination = $state(false);
	let newDestType = $state<DestType>('sftp');
	/**
	 * The ticket of each destination's Test still waiting for its answer, by
	 * name (card 2268). Each Test clears only its own, so a destination's
	 * button waits for its own Test whatever else is tested or saved meanwhile.
	 */
	let testsInFlight = $state<Record<string, number>>({});
	let editingDest = $state<string | null>(null);

	/**
	 * What an SFTP Test said of the server's host key (card 2250): the key the
	 * server presented, where none is confirmed or it did not match, and the
	 * confirmed one, where a key was refused. Shown in a box under the
	 * destination until its next Test, by the destination's name.
	 */
	interface HostKeyCheck {
		message: string;
		presented: string | null;
		confirmed: string | null;
	}
	let hostKeyChecks = $state<Record<string, HostKeyCheck | null>>({});
	/**
	 * Each destination's latest Test, by name (the card 2250 review's S3): a
	 * number moved on by every Test and by every save or removal of the
	 * destination, so that an answer that comes back after either says nothing.
	 */
	const hostKeyTests: Record<string, number> = Object.create(null);
	/**
	 * What a record kept by destination name holds for `name` itself, or
	 * undefined: never what every object inherits, so that a destination named
	 * `constructor` or `__proto__` reads as having nothing (the card 2268
	 * review). testsInFlight, hostKeyChecks and hostKeyTests are read only
	 * through this; hostKeyTests has no prototype either, so a number written
	 * under `__proto__` is kept.
	 */
	function byName<T>(record: Record<string, T>, name: string): T | undefined {
		return Object.hasOwn(record, name) ? record[name] : undefined;
	}

	// Destination form fields (shared for add/edit)
	let destName = $state('');
	let destHost = $state('');
	let destPort = $state(22);
	let destUsername = $state('');
	let destPassword = $state('');
	let destPrivateKey = $state('');
	// An SFTP destination's confirmed host key, `<type> SHA256:…`, sent with every save of one (card 2250).
	let destHostKey = $state('');
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

	/** Google Drive's Connect box, whose Connect each Drive destination's button starts. */
	let gdriveConnect = $state<ReturnType<typeof GDriveConnectModal>>();

	$effect(() => {
		// The backup settings are every administrator's (card 2395): this panel
		// is drawn on the admin page alone, so they are asked for here.
		loadBackupConfig();
	});

	function resetDestForm() {
		destName = ''; destHost = ''; destPort = 22; destUsername = ''; destPassword = '';
		destPrivateKey = ''; destHostKey = ''; destRemotePath = '/backups'; destRegion = 'us-east-1';
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
			destHostKey = (dest.hostKey as string) || '';
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
			// The host key goes with every save: a field not sent is not kept, and a
			// key removed with the password masked is refused (card 2250).
			return { type: 'sftp', name: destName, host: destHost, port: destPort, username: destUsername, password: destPassword, privateKey: destPrivateKey, remotePath: destRemotePath, hostKey: destHostKey };
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

	/**
	 * Read the backup settings from the server. `quiet` leaves the section as
	 * it is while it reads, for the read after a destination is saved (the card
	 * 2250 review's M3), so that the list holds the secrets masked as the server
	 * shows them and never one typed, which a later save would send as typed.
	 * True when the settings were read and put on the page.
	 */
	async function loadBackupConfig(quiet = false): Promise<boolean> {
		if (!quiet) backupLoading = true;
		let read = false;
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
				storedRetention = backupRetention;
				storedSchedule = backupSchedule;
				read = true;
			}
		} catch {}
		if (!quiet) backupLoading = false;
		return read;
	}

	/** A destination saved whose settings could not be read back: the list may still hold a secret as typed (M3). */
	const SETTINGS_UNREAD = 'Saved, but the page could not read the settings back: reload the page before editing again.';

	/** What a refused save adds to the server's reason, by whether the settings could be read back. */
	const SHOWN_AS_HELD = 'The settings shown are the ones the server holds.';
	const NOT_READ_BACK = 'The page could not read the settings back: reload it before changing them again.';

	/**
	 * Save the backup settings and destinations as the page shows them. True
	 * when the server saved them. When it did not, or did not answer, the
	 * destinations are put back to `putBack` (the list before a destination
	 * was added, changed or removed) and the settings are read again quietly,
	 * so that Keep Last, the schedule and the rest show what the server holds
	 * rather than what was refused (the card 2398 review); the toast gives the
	 * server's reason and says so.
	 */
	async function saveBackupConfig(putBack?: DestinationUI[]): Promise<boolean> {
		backupSaving = true;
		try {
			const started = toasts.navigation();
			let refused: string;
			try {
				const res = await fetch('/api/admin/backup', {
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
				});
				if (!res.ok) {
					refused = await failureMessage(res, 'Failed to save backup settings');
				} else {
					showToast('Backup settings saved');
					storedRetention = backupRetention ?? storedRetention;
					storedSchedule = backupSchedule;
					return true;
				}
			} catch {
				refused = NO_ANSWER;
			}
			// Put back, then read as the server holds them: the read replaces the list too.
			if (putBack) backupDestinations = putBack;
			const read = await loadBackupConfig(true);
			showToast(`${refused}${/[.!?]$/.test(refused) ? '' : '.'} ${read ? SHOWN_AS_HELD : NOT_READ_BACK}`, 'error', started);
			return false;
		} finally {
			backupSaving = false;
		}
	}

	/** Say the superadmin's rule (card 2398), in a toast that stays until closed. */
	function sayRule() {
		showToast(SUPERADMIN_RULE, 'error');
	}

	/** Keep Last changed: a lower number from an administrator is put back and not sent (card 2398). */
	function changeRetention() {
		if (!isSuperadmin && typeof backupRetention === 'number' && backupRetention < storedRetention) {
			backupRetention = storedRetention;
			sayRule();
			return;
		}
		saveBackupConfig();
	}

	/** The schedule changed: Disabled from an administrator, where it ran, is put back and not sent (card 2398). */
	function changeSchedule() {
		if (!isSuperadmin && backupSchedule === 'disabled' && storedSchedule !== 'disabled') {
			backupSchedule = storedSchedule;
			sayRule();
			return;
		}
		saveBackupConfig();
	}

	async function addDestination() {
		if (!destName.trim()) { showToast('Destination name is required', 'error'); return; }
		if (backupDestinations.some(d => d.name === destName.trim())) { showToast('A destination with that name already exists', 'error'); return; }
		const started = toasts.navigation();
		const was = backupDestinations;
		const added = buildDestConfig();
		backupDestinations = [...backupDestinations, added];
		// Not saved: off the list again (put back to `was`), and still in the form as typed.
		if (!(await saveBackupConfig(was))) return;
		// A box left by a destination of this name removed before is not this one's.
		forgetHostKeyCheck(added.name);
		// Emptied and closed only if the add form is still the one open: the
		// fields are every form's, and another form opened while the save was
		// on its way would be emptied (the card 2305 review).
		if (showAddDestination && editingDest === null) {
			resetDestForm();
			showAddDestination = false;
		}
		// The list as the server holds it, the secret typed masked again (M3).
		if (!(await loadBackupConfig(true))) showToast(SETTINGS_UNREAD, 'error', started);
	}

	async function updateDestination() {
		if (!editingDest || !destName.trim()) return;
		// The destination this form edits, as it was before the save went: the
		// form open when the answer comes may be another (the card 2305 review).
		const editing = editingDest;
		const idx = backupDestinations.findIndex(d => d.name === editing);
		if (idx === -1) return;
		const started = toasts.navigation();
		const was = backupDestinations;
		const updated = [...backupDestinations];
		updated[idx] = buildDestConfig();
		backupDestinations = updated;
		if (!(await saveBackupConfig(was))) return;
		// What its last Test said of its host key may no longer hold, under its
		// old name or its new one.
		forgetHostKeyCheck(editing);
		if (updated[idx].name !== editing) forgetHostKeyCheck(updated[idx].name);
		// Closed and emptied only if this destination's form is still the one open.
		if (editingDest === editing && !showAddDestination) {
			editingDest = null;
			resetDestForm();
		}
		// The list as the server holds it, the secret typed masked again (M3).
		if (!(await loadBackupConfig(true))) showToast(SETTINGS_UNREAD, 'error', started);
	}

	async function removeDestination(name: string) {
		const was = backupDestinations;
		backupDestinations = backupDestinations.filter(d => d.name !== name);
		if (!(await saveBackupConfig(was))) return;
		forgetHostKeyCheck(name);
	}

	/** Forget what the last Test of `name` said of its host key, and silence any Test of it still on its way (S3). */
	function forgetHostKeyCheck(name: string) {
		hostKeyTests[name] = (byName(hostKeyTests, name) ?? 0) + 1;
		hostKeyChecks = { ...hostKeyChecks, [name]: null };
	}

	function startEditDestination(dest: DestinationUI) {
		// One form open at a time: the add form, which shares these fields, is closed (card 2305).
		showAddDestination = false;
		editingDest = dest.name;
		newDestType = dest.type;
		populateDestForm(dest);
	}

	async function testDestination(dest: DestinationUI) {
		const started = toasts.navigation();
		// This Test's number: an answer that comes back after a later Test, or
		// after the destination was saved or removed, says nothing (S3).
		const ticket = (byName(hostKeyTests, dest.name) ?? 0) + 1;
		hostKeyTests[dest.name] = ticket;
		// Its button waits for this Test's own answer (card 2268). A save moves
		// hostKeyTests on and never this, so a dropped answer still clears it.
		testsInFlight = { ...testsInFlight, [dest.name]: ticket };
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
			if (byName(hostKeyTests, dest.name) !== ticket) return;
			// An SFTP Test that speaks of the host key is shown in the box under
			// the destination, with Confirm where the key is not confirmed yet, and
			// not in a toast as well (card 2250). Any other answer clears the box.
			const check = dest.type === 'sftp' ? hostKeyCheckOf(result) : null;
			hostKeyChecks = { ...hostKeyChecks, [dest.name]: check };
			if (check !== null) return;
			const said = typeof result?.message === 'string' && result.message ? result.message : null;
			showToast(said || (result?.success ? 'Connection successful' : 'Connection failed'), result?.success ? 'success' : 'error', started);
		} finally {
			if (byName(testsInFlight, dest.name) === ticket) {
				const { [dest.name]: _, ...rest } = testsInFlight;
				testsInFlight = rest;
			}
		}
	}

	/**
	 * What an SFTP Test's answer says of the host key (card 2250, decision 10
	 * and R3), or null where it says nothing of it: `hostKey` alone is a key
	 * not confirmed yet, both a key that did not match, `confirmedHostKey`
	 * alone a server that no longer offers a key of the confirmed type, or
	 * one that showed the confirmed key and could not sign with it (S4).
	 */
	function hostKeyCheckOf(result: any): HostKeyCheck | null {
		const presented = typeof result?.hostKey === 'string' && result.hostKey ? result.hostKey : null;
		const confirmed = typeof result?.confirmedHostKey === 'string' && result.confirmedHostKey ? result.confirmedHostKey : null;
		if (presented === null && confirmed === null) return null;
		return { message: typeof result?.message === 'string' ? result.message : '', presented, confirmed };
	}

	/**
	 * Confirm the host key a Test showed (card 2250, decision 3): the
	 * destination is saved with exactly that key, as the ordinary save of the
	 * whole list, and only once it is saved is it tested again, now with its
	 * password or private key. A key added where none was keeps the masked
	 * password; a refused save puts the list back, with the server's reason.
	 */
	async function confirmHostKey(name: string, key: string | null) {
		if (!key) return;
		const idx = backupDestinations.findIndex(d => d.name === name);
		if (idx === -1) return;
		const started = toasts.navigation();
		const was = backupDestinations;
		const updated = [...backupDestinations];
		updated[idx] = { ...updated[idx], hostKey: key };
		backupDestinations = updated;
		if (!(await saveBackupConfig(was))) return;
		// Tested as the server now holds it, read again: its secret masked and its
		// key as stored, which is all a Test keeps a masked secret for (M1, M3).
		// Where it could not be read back, it is tested as it was sent.
		if (!(await loadBackupConfig(true))) showToast(SETTINGS_UNREAD, 'error', started);
		await testDestination(backupDestinations.find(d => d.name === name) ?? updated[idx]);
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

</script>

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
			<!-- Closes an edit form left open: the two share one set of fields (card 2305). Off while a save is on its way, which empties the form that sent it once answered (its review). -->
			<button class="btn-primary btn-sm" disabled={backupSaving} onclick={() => { editingDest = null; resetDestForm(); newDestType = 'sftp'; showAddDestination = true; }}>+ Add Destination</button>
		</div>
	</div>

	{#if backupLoading}
		<p class="empty-msg">Loading backup config...</p>
	{:else}
		<!-- Schedule Settings -->
		<div class="sched-config">
			<div class="sched-row">
				<label class="sched-label">Schedule</label>
				<select bind:value={backupSchedule} class="form-input" style="flex: none; width: 160px" onchange={changeSchedule}>
					<!-- Switching the schedule off is the superadmin's (card 2398): for an administrator, marked and put back when chosen. -->
					{#if !isSuperadmin && storedSchedule !== 'disabled'}
						<option value="disabled" aria-disabled="true">Disabled (superadmin only)</option>
					{:else}
						<option value="disabled">Disabled</option>
					{/if}
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
				<!-- An administrator may raise it, and not lower it (card 2398): the least is the number stored. -->
				<input type="number" min={isSuperadmin ? 1 : storedRetention} max="100" bind:value={backupRetention} class="form-input" style="flex: none; width: 60px" onchange={changeRetention} />
				<span style="font-size: 0.75rem; color: var(--text-tertiary)">backups</span>
			</div>

			{#if !isSuperadmin}
				<p class="sched-note">🔒 {SUPERADMIN_RULE}</p>
			{/if}

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
								<button class="btn-ghost btn-xs" style="color: var(--accent-indigo)" onclick={() => gdriveConnect?.connectGDriveOAuth(dest.name)}>🔗 Connect</button>
							{/if}
						{/if}
						<!-- An SFTP destination with no confirmed host key is not backed up to until one is confirmed (card 2250 review, S1). -->
						{#if dest.type === 'sftp' && !dest.hostKey}
							<span style="font-size: 0.68rem; color: var(--accent-amber)">⚠️ Host key not confirmed — press Test</span>
						{/if}
						<button class="btn-ghost btn-xs" onclick={() => testDestination(dest)} disabled={byName(testsInFlight, dest.name) !== undefined}>
							{byName(testsInFlight, dest.name) !== undefined ? '⏳' : '🧪'} Test
						</button>
						<!-- Off while a save is on its way, as + Add Destination is (the card 2305 review). -->
						<button class="btn-ghost btn-xs" disabled={backupSaving} onclick={() => startEditDestination(dest)}>✏️ Edit</button>
						<!-- Off while the destinations are being saved: a second removal sent before the first was answered was put back wrongly when the first was refused. The superadmin's alone (card 2398): aria-disabled for an administrator, saying why when pressed. -->
						<button class="btn-ghost btn-xs danger" disabled={backupSaving} aria-disabled={isSuperadmin ? undefined : 'true'} title={isSuperadmin ? undefined : 'Removing a destination needs the superadmin'} onclick={() => (isSuperadmin ? confirm('Remove Destination', `Remove "${dest.name}" from backup destinations?`, async () => removeDestination(dest.name)) : sayRule())}>🗑️</button>
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
						Connected with access to all of this Google account's Drive. To narrow it: first remove DumpFire's access in the Google account (Google Account, Security, Your connections to third-party apps and services), then have the superadmin remove this destination, add it again with the Folder ID left empty, and connect it. See the admin guide, Configuring Backups.
					</p>
				{/if}
				<!-- What the last Test said of an SFTP server's host key (card 2250): the server's words, then Confirm for a key not confirmed yet, both keys for one that did not match, and no Confirm where the confirmed type is no longer offered (there is no key to confirm). -->
				{#if dest.type === 'sftp' && byName(hostKeyChecks, dest.name)}
					{@const check = byName(hostKeyChecks, dest.name)!}
					<div class="host-key-box">
						<p>{check.message}</p>
						{#if check.presented && !check.confirmed}
							<p>Presented: <code>{check.presented}</code></p>
							<p>Confirm saves this key on the destination and runs the Test again, which then uses its password or private key with this server and no other.</p>
							<div class="form-row" style="justify-content: flex-end">
								<button class="btn-primary btn-xs" disabled={backupSaving} onclick={() => confirmHostKey(dest.name, check.presented)}>✅ Confirm this key</button>
							</div>
						{:else if check.presented}
							<p>Presented: <code>{check.presented}</code></p>
							<p>Confirmed: <code>{check.confirmed}</code></p>
							<p>To accept the new key, check it on the server, then Edit the destination, paste it in the Host key box and type the password or private key again.</p>
						{:else}
							<p>Confirmed: <code>{check.confirmed}</code></p>
						{/if}
					</div>
				{/if}

				<!-- Inline edit form -->
				{#if editingDest === dest.name}
					<DestinationForm
						mode="edit"
						bind:destName bind:destHost bind:destPort bind:destUsername bind:destPassword bind:destPrivateKey bind:destHostKey bind:destRemotePath
						bind:destRegion bind:destBucket bind:destAccessKey bind:destSecretKey bind:destPrefix bind:destEndpoint
						bind:destServiceAccountJson bind:destFolderId bind:destGdriveAuthMethod bind:destGdriveClientId bind:destGdriveClientSecret {destGdriveRefreshToken}
						bind:destTenantId bind:destClientId bind:destClientSecret bind:destFolderPath bind:newDestType
						{isSuperadmin}
						onSave={updateDestination}
						onCancel={() => { editingDest = null; resetDestForm(); }}
					/>
				{/if}
			</div>
		{/each}

		<!-- Add Destination Form -->
		{#if showAddDestination}
			<DestinationForm
				mode="add"
				bind:destName bind:destHost bind:destPort bind:destUsername bind:destPassword bind:destPrivateKey bind:destHostKey bind:destRemotePath
				bind:destRegion bind:destBucket bind:destAccessKey bind:destSecretKey bind:destPrefix bind:destEndpoint
				bind:destServiceAccountJson bind:destFolderId bind:destGdriveAuthMethod bind:destGdriveClientId bind:destGdriveClientSecret {destGdriveRefreshToken}
				bind:destTenantId bind:destClientId bind:destClientSecret bind:destFolderPath bind:newDestType
				onSave={addDestination}
				onCancel={() => { showAddDestination = false; resetDestForm(); }}
			/>
		{/if}

		<!-- Backup History -->
		<BackupHistory {backupHistory} bind:showAllHistory />
	{/if}
</section>

<!-- Google Drive's Connect box: after the section, not in it, so that it is fixed to the window and not to a card that moves on hover. -->
<GDriveConnectModal bind:this={gdriveConnect} {loadBackupConfig} />

<style>
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
	.sched-note {
		margin: 0; font-size: 0.72rem; color: var(--text-tertiary);
	}
	.dest-actions button[aria-disabled='true'] { opacity: 0.4; cursor: default; }

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
	.host-key-box {
		margin: 0 var(--space-lg) var(--space-md); padding: var(--space-sm) var(--space-md);
		border: 1px solid var(--accent-amber); border-radius: var(--radius-sm);
		font-size: 0.72rem; color: var(--text-secondary);
		display: flex; flex-direction: column; gap: var(--space-xs);
	}
	.host-key-box p { margin: 0; }
	.host-key-box code { font-size: 0.7rem; word-break: break-all; }

	.dest-type-badge {
		font-size: 0.65rem; font-weight: 700; padding: 2px 8px;
		border-radius: var(--radius-sm); white-space: nowrap;
	}
</style>
