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
  share one set, as they did on the page. Save and Cancel are the panel's.
-->
<script lang="ts">
	import type { DestType } from '$lib/admin/format';
	import { dumpfireFolderName } from '$lib/drive-scope';

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
		newDestType = $bindable(),
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
		newDestType: DestType;
		/** The panel's `updateDestination` or `addDestination`. */
		onSave: () => void;
		/** The panel's: the form closed, and its fields emptied. */
		onCancel: () => void;
	} = $props();
</script>

{#if mode === 'edit'}
	<!-- Inline edit form -->
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
			<!-- The server's host key (card 2250): changing or clearing a confirmed one needs the password or private key typed again. -->
			<div class="form-row">
				<input type="text" placeholder="Paste the line ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub prints, or leave it empty and press Test" bind:value={destHostKey} class="form-input" style="font-family: monospace; font-size: 0.72rem" />
			</div>
			<!-- As the add form has (card 2250 review, M2): a stored key shows masked, as the password does, and is kept while it stays so; pasted again, it is what the save sends. -->
			<details style="margin-top: var(--space-xs)">
				<summary style="font-size: 0.72rem; color: var(--text-tertiary); cursor: pointer">Advanced: Private Key auth</summary>
				<textarea placeholder="Paste private key (PEM format)" bind:value={destPrivateKey} class="form-input" rows="3" style="margin-top: var(--space-xs); font-family: monospace; font-size: 0.7rem; width: 100%"></textarea>
			</details>
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
			<button class="btn-ghost btn-sm" onclick={onCancel}>Cancel</button>
			<button class="btn-primary btn-sm" onclick={onSave} disabled={!destName.trim()}>Save</button>
		</div>
	</div>
{:else}
	<!-- Add Destination Form -->
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
			<!-- The server's host key (card 2250): left empty, the first Test shows the key the server presents, to confirm. -->
			<div class="form-row">
				<input type="text" placeholder="Paste the line ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub prints, or leave it empty and press Test" bind:value={destHostKey} class="form-input" style="font-family: monospace; font-size: 0.72rem" />
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
			<button class="btn-ghost btn-sm" onclick={onCancel}>Cancel</button>
			<button class="btn-primary btn-sm" onclick={onSave} disabled={!destName.trim()}>Add Destination</button>
		</div>
	</div>
{/if}

<style>
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
</style>
