<!--
  AppUrlPanel.svelte — The admin page's Application Settings: the App URL
  every link in a mail begins with (card 2281, slice C1a: moved from
  src/routes/admin/+page.svelte).

  Every administrator's since card 2395, with the mail settings it is saved
  with: the page draws it for each of them, and it reads the App URL itself
  as it opens.

  Card 2401: the GET says where the App URL comes from, and the line under
  the field says it: an App URL from APP_URL was shown as if saved, and Save
  stored it, so a later change of APP_URL no longer applied. The server now
  stores one only when it differs from the one in effect.

  Its review: Save waits for the GET's answer, since an empty field saved
  before it would clear a stored App URL; a GET that fails is said under the
  field. The line says what clearing a saved App URL goes back to (APP_URL, or
  ORIGIN where it is not set), and is shown only while the field holds what
  was read.
-->
<script lang="ts">
	import { sent, showToast } from '$lib/admin/send';

	// ─── Application Settings ────────────────────────────────────────────

	let appUrl = $state('');
	/** The App URL as the GET last answered it: the line under the field speaks of it, not of one being typed. */
	let appUrlRead = $state('');
	/**
	 * Where the App URL in effect comes from, as the GET says (card 2401); null
	 * until it has, and after a GET that failed. Save waits for it: an empty
	 * field saved before the answer would clear a stored App URL.
	 */
	let appUrlFrom = $state<'setting' | 'environment' | 'none' | null>(null);
	/** Whether APP_URL is set, as the GET says: what clearing a saved App URL goes back to. */
	let appUrlEnvSet = $state(false);
	/** The last GET failed, or answered without saying where the App URL comes from. */
	let appUrlUnread = $state(false);
	let appUrlSaving = $state(false);

	$effect(() => {
		// The App URL is every administrator's (card 2395): this panel is drawn
		// on the admin page alone, so it is asked for here.
		loadAppUrl();
	});

	async function loadAppUrl() {
		let from: typeof appUrlFrom = null;
		try {
			const res = await fetch('/api/admin/smtp');
			if (res.ok) {
				// Not `data`, which was the page's own name for what its load gave it.
				const settings = await res.json();
				appUrl = appUrlRead = settings.appUrl || '';
				appUrlEnvSet = settings.appUrlEnvSet === true;
				from = settings.appUrlFrom ?? null;
			}
		} catch {}
		appUrlFrom = from;
		appUrlUnread = from === null;
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
			// Read again, so that the field and the line under it show the App URL
			// now in effect and where it comes from: one cleared is `APP_URL`'s again.
			await loadAppUrl();
		} finally {
			appUrlSaving = false;
		}
	}
</script>

<!-- Application Settings -->
<section class="admin-card glass fade-in-up" style="animation-delay: 40ms">
	<h2>🌐 Application Settings</h2>
	<p class="section-desc">Configure the public URL for your DumpFire instance. Every link in a mail begins with it: an invite, a request's confirmation and reply links, and the links in notifications.</p>
	<div class="form-row" style="align-items: flex-end">
		<div style="flex: 2; display: flex; flex-direction: column; gap: 4px">
			<label style="font-size: 0.72rem; font-weight: 600; color: var(--text-secondary)">Application URL</label>
			<input type="url" placeholder="https://kanban.example.com" bind:value={appUrl} class="form-input" />
		</div>
		<button class="btn-primary btn-sm" onclick={saveAppUrl} disabled={appUrlSaving || appUrlFrom === null} style="flex: none">
			{appUrlSaving ? 'Saving...' : 'Save'}
		</button>
	</div>
	{#if appUrlUnread}
		<p class="app-url-unread" style="font-size: 0.68rem; color: var(--accent-amber); margin-top: var(--space-xs)">
			⚠️ The page could not read the App URL settings: reload the page before saving.
		</p>
	{/if}
	<!-- Where the App URL that was read comes from: not said of one being typed. -->
	{#if appUrl === appUrlRead}
		{#if appUrlFrom === 'environment'}
			<p class="app-url-from" style="font-size: 0.68rem; color: var(--text-secondary); margin-top: var(--space-xs)">
				From the server's configuration (APP_URL). Saving it unchanged leaves it there, so a later change of APP_URL still applies.
			</p>
		{:else if appUrlFrom === 'setting' && appUrlEnvSet}
			<p class="app-url-from" style="font-size: 0.68rem; color: var(--text-secondary); margin-top: var(--space-xs)">
				Saved here, ahead of the server's configuration (APP_URL). Clear it and save to use the server's configuration (APP_URL) again.
			</p>
		{:else if appUrlFrom === 'setting'}
			<p class="app-url-from" style="font-size: 0.68rem; color: var(--text-secondary); margin-top: var(--space-xs)">
				Saved here; the server's configuration sets no APP_URL. Clear it and save to use ORIGIN, the server's own address.
			</p>
		{/if}
	{/if}
	{#if appUrlFrom !== null && !appUrl}
		<p style="font-size: 0.68rem; color: var(--accent-amber); margin-top: var(--space-xs)">
			⚠️ No App URL set. Links in mail begin with the address the server was started with (ORIGIN), and never with what a request says. If that is not the address people reach this server at, set it here.
		</p>
	{/if}
</section>
