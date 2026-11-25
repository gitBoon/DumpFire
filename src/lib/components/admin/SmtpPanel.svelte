<!--
  SmtpPanel.svelte — The admin page's Email / SMTP: the mail settings, Save
  and Send Test, and what mail has done since the server started (card 2281,
  slice C1b: moved from src/routes/admin/+page.svelte).

  Every administrator's since card 2395 (the superadmin's alone before): the
  page draws it for each of them, and it reads the mail settings itself as it
  opens. `loadMailStatus` is
  exported: the page reaches it with `bind:this` for the users panel, which
  has it read again once an invite is answered.

  Card 2701: Save asks for the caller's own password, in the app's confirm
  dialog: it chooses the mail server invites and password resets go through.
  Send Test asks for none.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/admin/$types';
	import { onDestroy } from 'svelte';
	import { answerBody, failureMessage } from '$lib/api';
	import { NO_ANSWER } from '$lib/admin/send';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import CardContent from '$lib/components/ui/CardContent.svelte';
	import CardDescription from '$lib/components/ui/CardDescription.svelte';
	import CardHeader from '$lib/components/ui/CardHeader.svelte';
	import CardTitle from '$lib/components/ui/CardTitle.svelte';
	import { codeAskedHere } from '$lib/code-asked';
	import { asksForPassword, stepUpRefusal, type StepUpProof } from '$lib/step-up-words';

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
	let smtpLoading = $state(true);
	let smtpSaving = $state(false);
	let smtpTesting = $state(false);
	let smtpTestTo = $state('');
	let smtpMessage = $state('');
	let smtpIsError = $state(false);

	/**
	 * The timer that clears a success line (card 2308): kept, so that the next
	 * Save or Send Test clears it before its own line is shown, and the panel
	 * going clears it. An earlier one cleared a later line early.
	 */
	let messageTimer: ReturnType<typeof setTimeout> | null = null;
	/** Set as the panel goes: an answer that comes after that starts no timer (the card 2308 review). */
	let destroyed = false;

	function stopMessageTimer() {
		if (messageTimer !== null) clearTimeout(messageTimer);
		messageTimer = null;
	}

	/** A success line cleared after `ms`; a failure stays until the next save or test, as a failure toast does. */
	function clearMessageLater(ms: number) {
		stopMessageTimer();
		if (destroyed) return;
		messageTimer = setTimeout(() => {
			messageTimer = null;
			if (!smtpIsError) smtpMessage = '';
		}, ms);
	}

	onDestroy(() => {
		destroyed = true;
		stopMessageTimer();
	});

	$effect(() => {
		// Every administrator's, and not asked for by anybody else: this panel is
		// drawn on the admin page alone, so it is asked for here.
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
				}
			}
		} catch {}
		smtpLoading = false;
	}

	/** Save pressed: the confirm dialog asks for the caller's own password, and its Confirm saves (card 2701). */
	let askingToSave = $state(false);

	/**
	 * Save, confirmed: the mail settings with the caller's own password. A
	 * refusal of the password is given back for the dialog to show; anything
	 * else closes it, and is said below the panel as before.
	 */
	async function saveSmtp(proof: StepUpProof): Promise<string | void> {
		smtpSaving = true;
		stopMessageTimer();
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
					fromAddress: smtpFromAddress, fromName: smtpFromName,
					currentPassword: proof.currentPassword,
					currentCode: proof.currentCode
				})
			});
			if (res.ok) {
				smtpMessage = 'SMTP settings saved!';
				smtpIsError = false;
			} else {
				// The caller's own password refused: said in the dialog, which stays open.
				const refusal = await stepUpRefusal(res);
				if (refusal !== null) {
					smtpSaving = false;
					return refusal;
				}
				// The server's reason, which used to be "Failed to save" for all of them.
				smtpMessage = await failureMessage(res, 'Failed to save SMTP settings');
				smtpIsError = true;
			}
		} catch {
			smtpMessage = NO_ANSWER;
			smtpIsError = true;
		}
		askingToSave = false;
		smtpSaving = false;
		await loadMailStatus();
		if (!smtpIsError) clearMessageLater(5000);
	}

	async function testSmtp() {
		smtpTesting = true;
		stopMessageTimer();
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
		if (!smtpIsError) clearMessageLater(8000);
	}
</script>

<Card as="section" id="mail" class="admin-section" aria-labelledby="mail-title">
	<CardHeader>
		<CardTitle level={2} id="mail-title">Email / SMTP</CardTitle>
		<CardDescription>Configure SMTP to enable email notifications, user invites, and task alerts.</CardDescription>
	</CardHeader>
	<CardContent>
		{#if smtpLoading}
			<p class="admin-note">Loading SMTP config...</p>
		{:else}
			<div class="admin-subform">
				<div class="admin-field-row">
					<input type="text" placeholder="SMTP Host" bind:value={smtpHost} class="ui-input" />
					<input type="number" placeholder="Port" bind:value={smtpPort} class="ui-input" style="width: 80px; flex: none" />
				</div>
				<p class="smtp-hint">Port 465 is encrypted from the start; any other port must offer STARTTLS. The mail server's certificate is checked either way.</p>
				<div class="admin-field-row">
					<input type="text" placeholder="Username" bind:value={smtpUser} class="ui-input" />
					<input type="password" placeholder="Password" bind:value={smtpPass} class="ui-input" />
				</div>
				<p class="smtp-hint">The saved password is kept only while the host, port, user name and the box below stay as they are: type it again when you change them.</p>
				<div class="admin-field-row">
					<input type="email" placeholder="From Email" bind:value={smtpFromAddress} class="ui-input" />
					<input type="text" placeholder="From Name" bind:value={smtpFromName} class="ui-input" />
				</div>
				<div class="admin-field-row">
					<label class="smtp-insecure">
						<input type="checkbox" bind:checked={smtpAllowInsecure} /> Allow mail without a checked, encrypted connection
					</label>
					<div class="smtp-spacer"></div>
					<Button size="sm" onclick={() => (askingToSave = true)} disabled={!smtpHost || smtpSaving}>{smtpSaving ? 'Saving...' : 'Save SMTP'}</Button>
				</div>
				{#if smtpAllowInsecure}
					<p class="smtp-msg smtp-warning admin-notice admin-notice-warning">⚠️ Mail, and the mail password, can then be read and changed by anyone on the network between this server and the mail server. Use it only for a relay on this server's own network that cannot use TLS. For a mail server whose certificate comes from a private authority, set NODE_EXTRA_CA_CERTS instead: see docs/deployment.md, Mail Server Certificates.</p>
				{/if}
				<div class="admin-field-row smtp-test-row">
					<input type="email" placeholder="Test recipient (defaults to your email)" bind:value={smtpTestTo} class="ui-input" />
					<Button variant="outline" size="sm" onclick={testSmtp} disabled={!smtpHost || smtpTesting}>🧪 {smtpTesting ? 'Sending...' : 'Send Test'}</Button>
				</div>
				{#if smtpMessage}
					<p class="smtp-msg admin-notice" class:smtp-error={smtpIsError} class:smtp-success={!smtpIsError} class:admin-notice-destructive={smtpIsError} class:admin-notice-success={!smtpIsError}>{smtpMessage}</p>
				{/if}
				<!-- What mail has done since the server started (card 2196): kept in memory, so a restart starts it again -->
				{#if mailStatus}
					<div class="mail-status">
						<p class="smtp-hint">Since the server started ({when(mailStatus.since)}): {mailStatus.sent} sent, {mailStatus.failed} failed.</p>
						{#if mailStatus.lastFailure}
							<p class="smtp-msg smtp-warning admin-notice admin-notice-warning">⚠️ Last failure, {when(mailStatus.lastFailure.at)}: "{mailStatus.lastFailure.subject}": {mailStatus.lastFailure.problem}. The mail error was: {mailStatus.lastFailure.detail}.
								{#if mailStatus.lastSentAt && mailStatus.lastSentAt > mailStatus.lastFailure.at}Mail has been sent since then, last at {when(mailStatus.lastSentAt)}.{:else}No mail has been sent since then.{/if}
								Every failure is also in the system log, on the Audit page, with its recipient.</p>
						{:else}
							<p class="smtp-hint">✅ No mail has failed since then.</p>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	</CardContent>
</Card>
<!-- Save asks for the caller's own password (card 2701). After the card: fixed to the window. -->
{#if askingToSave}
	<ConfirmModal
		kit
		title="Save SMTP Settings"
		message={`Invites and password resets are sent through this mail server. ${asksForPassword(codeAskedHere())}`}
		confirmText="Save"
		confirmDanger={false}
		askPassword
		onConfirm={saveSmtp}
		onCancel={() => (askingToSave = false)}
	/>
{/if}

<style>
	/* SMTP: the notices are admin.css's (the kit's alert look); these place them. */
	.smtp-msg {
		margin-top: var(--space-xs);
	}
	.smtp-hint {
		margin: 0;
		font-size: 0.75rem;
		color: var(--ui-muted-foreground);
	}
	/* The way out (card 2189): a box and its words. */
	.smtp-insecure {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		font-size: 0.8125rem;
		color: var(--ui-foreground);
		cursor: pointer;
	}
	.smtp-spacer {
		flex: 1;
	}
	.smtp-test-row {
		margin-top: var(--space-sm);
	}
	/* What mail has done since the server started (card 2196) */
	.mail-status {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		margin-top: var(--space-sm);
	}
</style>