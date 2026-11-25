<!--
  DestinationForm.svelte — The admin page's backup destination form: the
  inline edit form under a destination (`mode="edit"`) and the Add
  Destination form (`mode="add"`) (card 2281, slice C1a: moved from
  src/routes/admin/+page.svelte).

  Each mode's markup is as it was on the page, not merged into one: the two
  differ in more than their labels (the add form picks the type and gives
  each type's set-up steps; the edit form says what a connected Drive
  destination has and when a saved secret is kept). The fields are the
  Scheduled Backups panel's, bound here: the add form and every edit form
  share one set, as they did on the page, and the panel opens one form at a
  time (card 2305). Save and Cancel are the panel's.
-->
<script lang="ts">
	import type { DestType } from '$lib/admin/format';
	import { dumpfireFolderName } from '$lib/drive-scope';
	import Button from '$lib/components/ui/Button.svelte';

	let {
		mode,
		destName = $bindable(),
		destHost = $bindable(),
		destPort = $bindable(),
		destUsername = $bindable(),
		destPassword = $bindable(),
		destPrivateKey = $bindable(),
		destHostKey = $bindable(),
		destRemotePath = $bindable(),
		destRegion = $bindable(),
		destBucket = $bindable(),
		destAccessKey = $bindable(),
		destSecretKey = $bindable(),
		destPrefix = $bindable(),
		destEndpoint = $bindable(),
		destServiceAccountJson = $bindable(),
		destFolderId = $bindable(),
		destGdriveAuthMethod = $bindable(),
		destGdriveClientId = $bindable(),
		destGdriveClientSecret = $bindable(),
		destGdriveRefreshToken,
		destTenantId = $bindable(),
		destClientId = $bindable(),
		destClientSecret = $bindable(),
		destFolderPath = $bindable(),
		destDrive = $bindable(),
		newDestType = $bindable(),
		isSuperadmin = false,
		onSave,
		onCancel
	}: {
		mode: 'edit' | 'add';
		destName: string;
		destHost: string;
		destPort: number;
		destUsername: string;
		destPassword: string;
		destPrivateKey: string;
		destHostKey: string;
		destRemotePath: string;
		destRegion: string;
		destBucket: string;
		destAccessKey: string;
		destSecretKey: string;
		destPrefix: string;
		destEndpoint: string;
		destServiceAccountJson: string;
		destFolderId: string;
		destGdriveAuthMethod: 'oauth' | 'service_account';
		destGdriveClientId: string;
		destGdriveClientSecret: string;
		destGdriveRefreshToken: string;
		destTenantId: string;
		destClientId: string;
		destClientSecret: string;
		destFolderPath: string;
		/** Whose OneDrive (card 2941): a user's sign-in name or object ID, or a drive ID (`b!…`). */
		destDrive: string;
		newDestType: DestType;
		/**
		 * The panel's: whether the reader is the superadmin, who alone removes a
		 * destination, a rename included (card 2398). Not given, the reader is
		 * taken to be an administrator and the edit form says so under the name.
		 */
		isSuperadmin?: boolean;
		/** The panel's `updateDestination` or `addDestination`. */
		onSave: () => void;
		/** The panel's: the form closed, and its fields emptied. */
		onCancel: () => void;
	} = $props();

	/** A OneDrive destination needs whose OneDrive (card 2941): Save waits for it, and the server refuses one without. */
	const lacksDrive = $derived(newDestType === 'onedrive' && !(destDrive ?? '').trim());
</script>

{#if mode === 'edit'}
	<!-- Inline edit form -->
	<div class="dest-edit-form">
		<div class="admin-field-row">
			<input type="text" placeholder="Destination name" bind:value={destName} class="ui-input" />
		</div>
		<!-- A rename is the old destination removed, which is the superadmin's (card 2398): said before it is tried. -->
		{#if !isSuperadmin}
			<p class="dest-name-hint dest-hint">Renaming needs the superadmin: a destination renamed is the old one removed.</p>
		{/if}
		{#if newDestType === 'sftp'}
			<div class="admin-field-row">
				<input type="text" placeholder="Host" bind:value={destHost} class="ui-input" />
				<input type="number" placeholder="Port" bind:value={destPort} class="ui-input" style="width: 70px; flex: none" />
				<input type="text" placeholder="Username" bind:value={destUsername} class="ui-input" />
			</div>
			<div class="admin-field-row">
				<input type="password" placeholder="Password" bind:value={destPassword} class="ui-input" />
				<input type="text" placeholder="Remote path" bind:value={destRemotePath} class="ui-input" />
			</div>
			<!-- The server's host key (card 2250): changing or clearing a confirmed one needs the password or private key typed again. -->
			<div class="admin-field-row">
				<input type="text" placeholder="Paste the line ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub prints, or leave it empty and press Test" bind:value={destHostKey} class="ui-input" style="font-family: monospace; font-size: 0.72rem" />
			</div>
			<!-- As the add form has (card 2250 review, M2): a stored key shows masked, as the password does, and is kept while it stays so; pasted again, it is what the save sends. -->
			<details class="dest-advanced">
				<summary class="dest-summary">Advanced: Private Key auth</summary>
				<textarea placeholder="Paste private key (PEM format)" bind:value={destPrivateKey} class="ui-textarea" rows="3" style="margin-top: var(--space-xs); font-family: monospace; font-size: 0.7rem"></textarea>
			</details>
		{:else if newDestType === 's3'}
			<div class="admin-field-row">
				<input type="text" placeholder="Bucket" bind:value={destBucket} class="ui-input" />
				<input type="text" placeholder="Region" bind:value={destRegion} class="ui-input" style="width: 120px; flex: none" />
			</div>
			<div class="admin-field-row">
				<input type="text" placeholder="Access Key ID" bind:value={destAccessKey} class="ui-input" />
				<input type="password" placeholder="Secret Access Key" bind:value={destSecretKey} class="ui-input" />
			</div>
			<div class="admin-field-row">
				<input type="text" placeholder="Path prefix (optional)" bind:value={destPrefix} class="ui-input" />
				<input type="text" placeholder="Custom endpoint (optional)" bind:value={destEndpoint} class="ui-input" />
			</div>
		{:else if newDestType === 'gdrive'}
			<div class="admin-field-row">
				<select bind:value={destGdriveAuthMethod} class="ui-select" style="flex: none; width: 180px">
					<option value="oauth">🔑 OAuth (Personal)</option>
					<option value="service_account">🏢 Service Account</option>
				</select>
				<input type="text" placeholder={destGdriveAuthMethod === 'oauth' ? 'Folder ID (leave empty: DumpFire makes one when you connect)' : 'Folder ID'} bind:value={destFolderId} class="ui-input" />
			</div>
			{#if destGdriveAuthMethod === 'oauth'}
				<div class="admin-field-row">
					<input type="text" placeholder="OAuth Client ID" bind:value={destGdriveClientId} class="ui-input" />
					<input type="password" placeholder="OAuth Client Secret" bind:value={destGdriveClientSecret} class="ui-input" />
				</div>
				{#if destGdriveRefreshToken}
					<p class="dest-hint dest-ok">✅ Google account connected</p>
				{:else}
					<p class="dest-hint">
						DumpFire asks Google only for the files it makes. Leave the Folder ID empty: when you connect, DumpFire makes a folder of its own, "{dumpfireFolderName()}". A folder you made yourself may not be reachable. To keep using a folder DumpFire made, give its Folder ID again (shown on the destination as Folder:); Connect checks it can reach it.
					</p>
					<!-- The row's button by its label (card 2306). -->
					<p class="dest-hint">Save first, then use "🔗 Connect" on the destination.</p>
				{/if}
			{:else}
				<div class="admin-field-row">
					<textarea placeholder="Paste the service account's JSON key file" bind:value={destServiceAccountJson} class="ui-textarea" rows="4" style="font-family: monospace; font-size: 0.72rem"></textarea>
				</div>
			{/if}
		{:else if newDestType === 'onedrive'}
			<div class="admin-field-row">
				<input type="text" placeholder="Tenant ID" bind:value={destTenantId} class="ui-input" />
				<input type="text" placeholder="Client ID" bind:value={destClientId} class="ui-input" />
			</div>
			<div class="admin-field-row">
				<input type="password" placeholder="Client Secret" bind:value={destClientSecret} class="ui-input" />
				<input type="text" placeholder="Folder path" bind:value={destFolderPath} class="ui-input" />
			</div>
			<div class="admin-field-row">
				<input type="text" placeholder="User (sign-in name or object ID) or drive ID (b!…)" bind:value={destDrive} class="ui-input" />
			</div>
			{#if lacksDrive}
				<p class="dest-hint dest-warn">Give whose OneDrive to use: the user's sign-in name or object ID, or a drive ID. Until then this destination is not backed up to.</p>
			{/if}
		{/if}
		<!-- A refused save leaves this form open as typed, with the server's reason in the toast (card 2190). -->
		<p class="dest-hint">
			A saved password, key or secret is kept only while the destination's name and settings stay as they were saved: type it again when you change them. A connected Google Drive destination is removed by the superadmin, added again and connected.
		</p>
		<div class="dest-form-actions">
			<Button variant="outline" size="sm" onclick={onCancel}>Cancel</Button>
			<Button size="sm" onclick={onSave} disabled={!destName.trim() || lacksDrive}>Save</Button>
		</div>
	</div>
{:else}
	<!-- Add Destination Form -->
	<div class="dest-add-form">
		<h3 class="dest-form-title">Add Backup Destination</h3>
		<div class="admin-field-row">
			<input type="text" placeholder="Destination name (e.g. Production NAS)" bind:value={destName} class="ui-input" />
			<select bind:value={newDestType} class="ui-select" style="flex: none; width: 160px">
				<option value="sftp">🔐 SFTP / SCP</option>
				<option value="s3">☁️ Amazon S3</option>
				<option value="gdrive">📁 Google Drive</option>
				<option value="onedrive">💙 OneDrive</option>
			</select>
		</div>

		{#if newDestType === 'sftp'}
			<div class="admin-field-row">
				<input type="text" placeholder="Host" bind:value={destHost} class="ui-input" />
				<input type="number" placeholder="Port" bind:value={destPort} class="ui-input" style="width: 70px; flex: none" />
				<input type="text" placeholder="Username" bind:value={destUsername} class="ui-input" />
			</div>
			<div class="admin-field-row">
				<input type="password" placeholder="Password" bind:value={destPassword} class="ui-input" />
				<input type="text" placeholder="Remote path (e.g. /backups)" bind:value={destRemotePath} class="ui-input" />
			</div>
			<!-- The server's host key (card 2250): left empty, the first Test shows the key the server presents, to confirm. -->
			<div class="admin-field-row">
				<input type="text" placeholder="Paste the line ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub prints, or leave it empty and press Test" bind:value={destHostKey} class="ui-input" style="font-family: monospace; font-size: 0.72rem" />
			</div>
			<details class="dest-advanced">
				<summary class="dest-summary">Advanced: Private Key auth</summary>
				<textarea placeholder="Paste private key (PEM format)" bind:value={destPrivateKey} class="ui-textarea" rows="3" style="margin-top: var(--space-xs); font-family: monospace; font-size: 0.7rem"></textarea>
			</details>
		{:else if newDestType === 's3'}
			<div class="admin-field-row">
				<input type="text" placeholder="Bucket name" bind:value={destBucket} class="ui-input" />
				<input type="text" placeholder="Region (e.g. us-east-1)" bind:value={destRegion} class="ui-input" style="width: 140px; flex: none" />
			</div>
			<div class="admin-field-row">
				<input type="text" placeholder="Access Key ID" bind:value={destAccessKey} class="ui-input" />
				<input type="password" placeholder="Secret Access Key" bind:value={destSecretKey} class="ui-input" />
			</div>
			<div class="admin-field-row">
				<input type="text" placeholder="Path prefix (e.g. dumpfire/)" bind:value={destPrefix} class="ui-input" />
				<input type="text" placeholder="Custom endpoint (MinIO, Backblaze, etc.)" bind:value={destEndpoint} class="ui-input" />
			</div>
		{:else if newDestType === 'gdrive'}
		<div class="admin-field-row">
			<select bind:value={destGdriveAuthMethod} class="ui-select" style="flex: none; width: 180px">
				<option value="oauth">🔑 OAuth (Personal)</option>
				<option value="service_account">🏢 Service Account</option>
			</select>
			<input type="text" placeholder={destGdriveAuthMethod === 'oauth' ? 'Folder ID (leave empty: DumpFire makes one when you connect)' : 'Google Drive Folder ID'} bind:value={destFolderId} class="ui-input" />
		</div>
		{#if destGdriveAuthMethod === 'oauth'}
			<div class="admin-field-row">
				<input type="text" placeholder="OAuth Client ID" bind:value={destGdriveClientId} class="ui-input" />
				<input type="password" placeholder="OAuth Client Secret" bind:value={destGdriveClientSecret} class="ui-input" />
			</div>
			<p class="dest-hint">
				DumpFire asks Google only for the files it makes. Leave the Folder ID empty: when you connect, DumpFire makes a folder of its own, "{dumpfireFolderName()}". A folder you made yourself may not be reachable. To keep using a folder DumpFire made, give its Folder ID again (shown on the destination as Folder:); Connect checks it can reach it.
			</p>
			<p class="dest-hint">
				1. Go to <strong>Google Cloud Console → APIs &amp; Services → Credentials</strong><br/>
				2. Create an <strong>OAuth 2.0 Client ID</strong> — select <strong>"Desktop app"</strong> as type<br/>
				3. Enable the <strong>Google Drive API</strong> at <strong>APIs &amp; Services → Library</strong><br/>
				4. After adding the destination, click <strong>"🔗 Connect"</strong> to authorize your Google account
			</p>
		{:else}
			<div class="admin-field-row">
				<textarea placeholder="Paste the service account's JSON key file" bind:value={destServiceAccountJson} class="ui-textarea" rows="5" style="font-family: monospace; font-size: 0.72rem"></textarea>
			</div>
			<p class="dest-hint">
				Create a Service Account in Google Cloud Console → Enable Drive API → on the service account's <strong>Keys</strong>, Add key → Create new key → JSON, and paste the whole file here. Only a service account's key file from Google is accepted. Share the folder with the service account email.
			</p>
		{/if}
		{:else if newDestType === 'onedrive'}
			<div class="admin-field-row">
				<input type="text" placeholder="Azure Tenant ID" bind:value={destTenantId} class="ui-input" />
				<input type="text" placeholder="App Client ID" bind:value={destClientId} class="ui-input" />
			</div>
			<div class="admin-field-row">
				<input type="password" placeholder="Client Secret" bind:value={destClientSecret} class="ui-input" />
				<input type="text" placeholder="Folder path (e.g. /DumpFire Backups)" bind:value={destFolderPath} class="ui-input" />
			</div>
			<div class="admin-field-row">
				<input type="text" placeholder="User (sign-in name or object ID) or drive ID (b!…)" bind:value={destDrive} class="ui-input" />
			</div>
			<!-- DumpFire signs in as the app itself, with no user (card 2941): least privilege first (ruling R8). -->
			<p class="dest-hint">
				<strong>Best:</strong> in Microsoft Entra ID, register an app with Microsoft Graph <strong>Application</strong> permission <strong>Sites.Selected</strong>, which needs admin consent like any Application permission, and create a client secret. An administrator then also grants the app write on the one site that holds the drive (a separate step, for example with Microsoft Graph PowerShell), and you give that drive's ID (b!…). Use a SharePoint document library kept for backups rather than a person's OneDrive.<br/>
				<strong>Broader:</strong> Application permission <strong>Files.ReadWrite.All</strong> with admin consent lets the app read and write every user's files in the tenant; then give the user's sign-in name or object ID (the object ID stays the same if they are renamed).<br/>
				Personal Microsoft accounts are not supported. Test checks the drive and the folder; the first backup makes the folder.
			</p>
		{/if}

		<div class="dest-form-actions">
			<Button variant="outline" size="sm" onclick={onCancel}>Cancel</Button>
			<Button size="sm" onclick={onSave} disabled={!destName.trim() || lacksDrive}>Add Destination</Button>
		</div>
	</div>
{/if}

<style>
	/* Card 3076: the forms in the kit's quiet box; their fields the kit's (ui-field.css), in admin.css's rows. */
	.dest-edit-form,
	.dest-add-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		margin-bottom: var(--space-sm);
		padding: var(--space-md);
		border: 1px solid var(--ui-border);
		border-radius: var(--ui-radius);
		background: color-mix(in srgb, var(--ui-muted) 45%, transparent);
	}
	/* Under its destination's row, inside the destination's box. */
	.dest-edit-form {
		margin: 0;
		border-width: 1px 0 0;
		border-radius: 0;
	}
	/* Both forms stop at a readable width, as the admin pages' field groups do. */
	.dest-edit-form,
	.dest-add-form {
		max-width: 48rem;
	}
	.dest-form-title {
		margin: 0 0 var(--space-xs);
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--ui-foreground);
	}
	.dest-hint {
		margin: 0;
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--ui-muted-foreground);
	}
	/* The tone in the ✅, or an edge; the words in the text colour (card 3076, F3). */
	.dest-ok {
		color: var(--ui-foreground);
	}
	.dest-warn {
		padding-left: 0.5rem;
		border-left: 2px solid var(--ui-warning);
		color: var(--ui-foreground);
	}
	.dest-advanced {
		margin-top: var(--space-xs);
	}
	.dest-summary {
		border-radius: var(--ui-radius-sm);
		font-size: 0.75rem;
		color: var(--ui-muted-foreground);
		cursor: pointer;
	}
	.dest-summary:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}
	.dest-form-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-sm);
		margin-top: var(--space-xs);
	}
</style>