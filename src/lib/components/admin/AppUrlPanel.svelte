<!--
  AppUrlPanel.svelte — The admin page's Application Settings: the App URL
  every link in a mail begins with (card 2281, slice C1a: moved from
  src/routes/admin/+page.svelte).

  Every administrator's since card 2395, with the mail settings it is saved
  with: the page draws it for each of them, and it reads the App URL itself
  as it opens.
-->
<script lang="ts">
	import { sent, showToast } from '$lib/admin/send';

	// ─── Application Settings ────────────────────────────────────────────

	let appUrl = $state('');
	let appUrlSaving = $state(false);

	$effect(() => {
		// The App URL is every administrator's (card 2395): this panel is drawn
		// on the admin page alone, so it is asked for here.
		loadAppUrl();
	});

	async function loadAppUrl() {
		try {
			const res = await fetch('/api/admin/smtp');
			if (res.ok) {
				// Not `data`, which was the page's own name for what its load gave it.
				const settings = await res.json();
				appUrl = settings.appUrl || '';
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
