<!--
  InviteLinkDialog.svelte — The admin page's dialog for the link of an invite
  whose mail was not sent (card 2196, decision 9), with its 📋 Copy and Done
  (card 2281, slice C1b: moved from src/routes/admin/+page.svelte).

  The link is the page's (`inviteLink`, bound here and in the users panel,
  which sets it): the page draws this dialog where it was, after its own
  dialogs and outside `.admin-page`, so the page's rules for a dialog do not
  reach it, and it has its own copy of the ones it uses.
-->
<script lang="ts">
	import { holdFocus } from '$lib/dialog-focus';

	let {
		inviteLink = $bindable()
	}: {
		/** The page's: set by the users panel, cleared here with Done. `returnTo` is the control the focus goes back to after Done. */
		inviteLink: { url: string; username: string; message: string; returnTo?: HTMLElement } | null;
	} = $props();

	/** What 📋 Copy did: said on the button, so the link is never put in a toast. */
	let inviteLinkCopy = $state<'idle' | 'copied' | 'failed'>('idle');

	function closeInviteLink() {
		inviteLink = null;
		inviteLinkCopy = 'idle';
	}

	/**
	 * Where the focus goes back to after Done, kept as the dialog opens: the
	 * link is gone by the time it closes. What had the focus as it opened is
	 * no use (card 2365's review): the pressed Create or 📧 is off by then, or
	 * gone, and the focus on nothing.
	 */
	function backTo(link: { returnTo?: HTMLElement }) {
		const control = link.returnTo;
		return () => control;
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
</script>

<!-- The link of an invite whose mail was not sent (card 2196, decision 9): shown once, to the administrator who issued it, and gone on Done. No way out of it but Done, so no Escape: the link would be lost.
     It holds the keyboard as the page's other dialogs do (card 2365: Tab walked the page behind it): Copy has the focus as it opens, Tab stays in it, and the focus goes back as it closes to the control the users panel names (+ Add User, or the row's 📧). -->
{#if inviteLink}
	<div class="modal-overlay" role="alertdialog" aria-modal="true" aria-label="The invite mail was not sent" aria-describedby="invite-link-said invite-link-warning">
		<div class="modal-content confirm-modal" role="document" style="max-width: 560px" use:holdFocus={{ first: '.invite-link-row button', returnTo: backTo(inviteLink) }}>
			<h2>📧 The invite mail was not sent</h2>
			<p id="invite-link-said" style="margin-bottom: var(--space-sm)">{inviteLink.message}</p>
			<p id="invite-link-warning" style="margin-bottom: var(--space-sm)">Give this link to {inviteLink.username} yourself, by a way only they read. Whoever opens it can set the password of {inviteLink.username}'s account and is then signed in as them. It works once, for seven days, and stops working if another invite is sent to this account. Do not open it yourself.</p>
			<div class="invite-link-row">
				<code>{inviteLink.url}</code>
				<!-- Focused as the dialog opens (holdFocus, above): what the reader is there to do, and away from the page behind it -->
				<button class="btn-ghost btn-sm" onclick={copyInviteLink}>{inviteLinkCopy === 'copied' ? '✅ Copied!' : inviteLinkCopy === 'failed' ? 'Select it and copy it yourself' : '📋 Copy'}</button>
			</div>
			<!-- The mail panel is every administrator's since card 2395, so it is below for whoever sees this. -->
			<p>It is not shown again. If it is lost, send a new invite with 📧. Why it failed is under Email / SMTP below.</p>
			<div class="modal-actions">
				<button class="btn-primary" onclick={closeInviteLink}>Done</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* The admin page's rules for a dialog, which do not reach past its .admin-page: copied as they are there */
	.confirm-modal { max-width: 420px; }
	.confirm-modal h2 { font-size: 1.1rem; margin-bottom: var(--space-sm); }
	.confirm-modal p { font-size: 0.85rem; color: var(--text-secondary); margin-bottom: var(--space-xl); line-height: 1.5; }
	.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-md); }
	.btn-sm { font-size: 0.78rem !important; padding: var(--space-xs) var(--space-md) !important; }

	/* The link of an invite whose mail was not sent (card 2196) */
	.invite-link-row {
		display: flex; align-items: center; gap: var(--space-sm);
		margin: 0 0 var(--space-md); padding: var(--space-sm) var(--space-md);
		background: var(--bg-base); border: 1px solid var(--glass-border); border-radius: var(--radius-md);
	}
	.invite-link-row code { flex: 1; font-size: 0.78rem; overflow-wrap: anywhere; user-select: all; }
	.invite-link-row button { flex: none; }
</style>
