<!--
  SmtpPanel.svelte — The admin page's Email / SMTP: the mail settings, Save
  and Send Test, and what mail has done since the server started (card 2281,
  slice C1b: moved from src/routes/admin/+page.svelte).

  The superadmin's alone: the page draws it inside its isSuperadmin block,
  and it reads the mail settings itself as it opens. `loadMailStatus` is
  exported: the page reaches it with `bind:this` for the users panel, which
  has it read again once an invite is answered.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/admin/$types';
	import { answerBody, failureMessage } from '$lib/api';
	import { NO_ANSWER } from '$lib/admin/send';

	/** Who is signed in: Send Test goes to their address when no other is typed. */
	let { currentUser }: { currentUser: PageData['currentUser'] } = $props();

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
		// The superadmin's too, and not asked for by anybody else: this panel is
		// drawn for the superadmin alone, so it is asked for here.
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
	export async function loadMailStatus() {
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
		const recipient = smtpTestTo.trim() || currentUser?.email;
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

<style>
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
</style>
