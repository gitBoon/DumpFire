<!--
  GDriveConnectModal.svelte — Google Drive's Connect box on the admin page:
  Google's consent page opened, and the address it led to pasted back and
  exchanged for the destination's token (card 2281, slice C1a: moved from
  src/routes/admin/+page.svelte).

  Drawn by the Scheduled Backups panel, after its section. Each Drive
  destination's 🔗 Connect calls `connectGDriveOAuth` on it; once Google has
  given a token, the panel's backup settings are read again with
  `loadBackupConfig`, the panel's own.
-->
<script lang="ts">
	import { answerBody, failureMessage } from '$lib/api';
	import { sent, showToast } from '$lib/admin/send';
	import { toasts } from '$lib/stores/toast';

	/** The Scheduled Backups panel's: its settings read again, once a destination is connected. */
	let { loadBackupConfig }: { loadBackupConfig: () => Promise<boolean> } = $props();

	/** Open Google OAuth consent and manage code exchange in a modal. */
	let gdriveConnecting = $state('');
	let gdriveAuthCode = $state('');
	let gdriveExchanging = $state(false);
	/**
	 * Google's consent address once the Connect's GET has answered, shown in
	 * the box as a link in every state, and whether the browser blocked the
	 * window opened on it (card 2266): Safari, a strict blocker or a slow
	 * answer stop a window opened after the GET.
	 */
	let gdriveAuthUrl = $state('');
	let gdriveBlocked = $state(false);
	/** Each Connect's number, moved on whenever the box closes: an answer that comes back after a Cancel or a later Connect says and opens nothing (card 2266). */
	let gdriveAttempt = 0;

	/** Close the Connect box, and end the Connect it was for, with any exchange it had on its way. */
	function closeGDriveConnect() {
		gdriveAttempt++;
		gdriveConnecting = '';
		gdriveAuthCode = '';
		gdriveAuthUrl = '';
		gdriveBlocked = false;
		gdriveExchanging = false;
	}

	/**
	 * Whether the Connect's GET answered Google's own consent page over https
	 * (the card 2266 review): only that is opened, or shown as a link. Anything
	 * else, a `javascript:` address above all, is read as no address at all.
	 */
	function isGoogleConsent(authUrl: unknown): authUrl is string {
		if (typeof authUrl !== 'string' || !authUrl) return false;
		try {
			const address = new URL(authUrl);
			return address.protocol === 'https:' && address.host === 'accounts.google.com';
		} catch {
			return false;
		}
	}

	export async function connectGDriveOAuth(destName: string) {
		const attempt = ++gdriveAttempt;
		gdriveConnecting = destName;
		gdriveAuthCode = '';
		gdriveAuthUrl = '';
		gdriveBlocked = false;
		const started = toasts.navigation();
		// Still this Connect: not cancelled, and no later one started. The
		// server has replaced an older Connect's state with the newer one's, so
		// an older answer's address would only be refused when pasted.
		const current = () => attempt === gdriveAttempt && gdriveConnecting === destName;
		try {
			const res = await fetch(`/api/admin/backup/gdrive/auth?dest=${encodeURIComponent(destName)}`);
			if (!current()) return;
			if (!res.ok) {
				// The server's own reason (card 2265): no client secret saved, or the destination removed or renamed in another tab.
				const said = await failureMessage(res, 'Failed to generate auth URL');
				if (!current()) return;
				showToast(said, 'error', started);
				closeGDriveConnect();
				return;
			}
			const authUrl = (await answerBody(res))?.authUrl;
			if (!current()) return;
			if (!isGoogleConsent(authUrl)) {
				showToast('Failed to generate auth URL', 'error', started);
				closeGDriveConnect();
				return;
			}
			const opened = window.open(authUrl, '_blank', 'width=600,height=700');
			gdriveAuthUrl = authUrl;
			gdriveBlocked = opened === null;
		} catch {
			if (!current()) return;
			showToast('Failed to start OAuth flow', 'error', started);
			closeGDriveConnect();
		}
	}

	/** What the page says when the address pasted is not the whole one (card 2251, decision 5). */
	const PASTE_WHOLE_ADDRESS =
		"Paste the whole address from the browser's address bar: it holds the code and the check that this connection was started here.";

	async function exchangeGDriveCode() {
		if (!gdriveAuthCode.trim() || !gdriveConnecting) return;
		// The Connect this exchange is for: a Cancel, or a later Connect, moves
		// it on, and the box is then no longer this exchange's to close.
		const attempt = gdriveAttempt;
		const started = toasts.navigation();

		// The whole address Google's page leads to: its code, and the state that
		// shows this Connect was started here (card 2251). A bare code is not
		// sent: the server refuses a code without its state. An address Google
		// ended with an error, consent refused above all, is said and not sent.
		let address: URL | null = null;
		try {
			address = new URL(gdriveAuthCode.trim());
		} catch { /* not an address: a bare code, refused below */ }
		const googleError = address?.searchParams.get('error');
		if (googleError) {
			showToast(
				googleError === 'access_denied'
					? 'Google says access was not granted (access_denied). Press Connect again and allow access.'
					: `Google answered with an error (${googleError}). Press Connect again.`,
				'error',
				started
			);
			closeGDriveConnect();
			return;
		}
		const code = address?.searchParams.get('code');
		const state = address?.searchParams.get('state');
		if (!code || !state) {
			// The box stays open, for the whole address to be pasted.
			showToast(PASTE_WHOLE_ADDRESS, 'error', started);
			return;
		}

		gdriveExchanging = true;
		try {
			const res = await sent(
				() =>
					fetch('/api/admin/backup/gdrive/auth', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ code, state, destName: gdriveConnecting })
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
			// Its toast and reload above stand either way (it did or did not
			// connect the destination), but a box opened since is left alone,
			// with its GET and any exchange of its own (the card 2266 review).
			if (attempt === gdriveAttempt) closeGDriveConnect();
		}
	}
</script>

<!-- Google Drive OAuth code entry -->
{#if gdriveConnecting}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-overlay" role="dialog" aria-modal="true">
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="modal-content confirm-modal" onclick={(e) => e.stopPropagation()} role="document" style="max-width: 520px">
			<h2>🔗 Connect Google Drive</h2>
			<p style="margin-bottom: var(--space-md)">
				{#if !gdriveAuthUrl}
					Opening Google's sign-in page…
				{:else if gdriveBlocked}
					Your browser blocked Google's sign-in window. <a href={gdriveAuthUrl} target="_blank" rel="noopener noreferrer">Open Google's sign-in page</a>. After granting access, Google will redirect to a page that may not load — <strong>that's expected</strong>.
				{:else}
					A Google sign-in window has opened. If you cannot see it, <a href={gdriveAuthUrl} target="_blank" rel="noopener noreferrer">open Google's sign-in page</a>. After granting access, Google will redirect to a page that may not load — <strong>that's expected</strong>.
				{/if}
			</p>
			<p style="font-size: 0.78rem; color: var(--text-secondary); margin-bottom: var(--space-md); line-height: 1.5">
				Copy the <strong>whole address</strong> from your browser's address bar, not only the code: it holds the code and the check that this connection was started here. Paste it below:
			</p>
			<input
				type="text"
				placeholder="Paste the whole address, starting http://localhost/?state=…"
				bind:value={gdriveAuthCode}
				disabled={!gdriveAuthUrl}
				class="form-input"
				style="width: 100%; font-family: monospace; font-size: 0.78rem; margin-bottom: var(--space-md)"
			/>
			<div class="modal-actions">
				<button class="btn-ghost" onclick={closeGDriveConnect}>Cancel</button>
				<button class="btn-primary" onclick={exchangeGDriveCode} disabled={!gdriveAuthUrl || !gdriveAuthCode.trim() || gdriveExchanging}>
					{gdriveExchanging ? '⏳ Connecting...' : '✅ Connect'}
				</button>
			</div>
		</div>
	</div>
{/if}
