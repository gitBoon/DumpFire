<!--
  InviteLinkDialog.svelte — The admin page's dialog for the link of an invite
  whose mail was not sent (card 2196, decision 9), with its Copy and Done
  (card 2281, slice C1b: moved from src/routes/admin/+page.svelte). Card
  3078: drawn in the kit's dialog frame (`ui/Dialog.svelte`), its titles and
  buttons without emoji.

  The link is the page's (`inviteLink`, bound here and in the users panel,
  which sets it): the page draws this dialog where it was, after its own
  dialogs.

  It also shows the link of a reset of another account's two-step sign-in
  (card 2773, decision 8), with `kind: 'mfa-reset'` on the link: the same
  Copy and Done, with its own label, heading, warning and footer. With no
  `kind`, or `'invite'`, every word is the invite's, as before.

  And the set-up link of an account an administrator has just made with a
  password they chose (card 2851), with `kind: 'new-account'`: given with
  that password, its own words again.
-->
<script lang="ts">
	import Button from '$lib/components/ui/Button.svelte';
	import Dialog from '$lib/components/ui/Dialog.svelte';

	let {
		inviteLink = $bindable()
	}: {
		/**
		 * The page's: set by the users panel, cleared here with Done. `returnTo` is the control the focus goes back to after Done.
		 * `kind` says whose link it is: an invite's (the default), a two-step sign-in reset's (card 2773), or the set-up link of an
		 * account just made with a password (card 2851).
		 */
		inviteLink: { url: string; username: string; message: string; returnTo?: HTMLElement; kind?: 'invite' | 'mfa-reset' | 'new-account' } | null;
	} = $props();

	/** A two-step sign-in reset's link (card 2773), whose words are its own; anything else is an invite's or a new account's. */
	let isReset = $derived(inviteLink?.kind === 'mfa-reset');
	/** A new account's set-up link (card 2851), given with the password the administrator chose. */
	let isNewAccount = $derived(inviteLink?.kind === 'new-account');

	/** What Copy did: said on the button, so the link is never put in a toast. */
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
	{#snippet inviteActions()}
		<Button onclick={closeInviteLink}>Done</Button>
	{/snippet}
	<!-- Card 3078: the kit's frame, on the same focus rules: Copy first, no Escape, the focus back to the control named. -->
	<Dialog
		role="alertdialog"
		aria-label={isReset ? "The two-step sign-in reset's link" : isNewAccount ? "The new account's set-up link" : 'The invite mail was not sent'}
		aria-describedby="invite-link-said invite-link-warning"
		title={isReset ? 'Two-step sign-in was reset' : isNewAccount ? 'Their set-up link' : 'The invite mail was not sent'}
		size="lg"
		class="confirm-modal"
		footerClass="modal-actions"
		initialFocus=".invite-link-row button"
		returnTo={backTo(inviteLink)}
		footer={inviteActions}
	>
		<!-- Card 2773, decision 6: a reset's link is never mailed, so this is the one place it is given, to the administrator who reset the account.
		     Card 2851: nor is a new account's set-up link, given here once with the password the administrator chose. -->
		<p id="invite-link-said">{inviteLink.message}</p>
		{#if isReset}
			<p id="invite-link-warning">Give {inviteLink.username} this link yourself, by a way only they read: it is shown once, here. It works for seven days, and stops working if their two-step sign-in is reset again. Whoever opens it sets up the authenticator of {inviteLink.username}'s account, and the account still needs its password. Do not open it yourself.</p>
		{:else if isNewAccount}
			<p id="invite-link-warning">Give {inviteLink.username} this link yourself, with the password you chose, by a way only they read: it is shown once, here. It works for seven days, and stops working if their password is set again or their two-step sign-in is reset. Whoever opens it and knows the password sets up the authenticator of {inviteLink.username}'s account. Do not open it yourself.</p>
		{:else}
			<p id="invite-link-warning">Give this link to {inviteLink.username} yourself, by a way only they read. Whoever opens it can set the password of {inviteLink.username}'s account, then sets up its two-step sign-in and is signed in as them. It works once, for seven days, and stops working if another invite is sent to this account. Do not open it yourself.</p>
		{/if}
		<div class="invite-link-row">
			<code>{inviteLink.url}</code>
			<!-- Focused as the dialog opens (initialFocus, above): what the reader is there to do, and away from the page behind it -->
			<Button variant="outline" size="sm" onclick={copyInviteLink}>{inviteLinkCopy === 'copied' ? 'Copied' : inviteLinkCopy === 'failed' ? 'Select it and copy it yourself' : 'Copy'}</Button>
		</div>
		{#if isReset}
			<p>It is not shown again. If it is lost, reset {inviteLink.username}'s two-step sign-in again with 🛡️, which issues a new link and ends this one.</p>
		{:else if isNewAccount}
			<p>It is not shown again. If it is lost, give a new one with 🛡️ on their row.</p>
		{:else}
			<!-- The mail panel is every administrator's since card 2395, so it is below for whoever sees this. -->
			<p>It is not shown again. If it is lost, send a new invite with 📧. Why it failed is under Email / SMTP below.</p>
		{/if}
	</Dialog>
{/if}

<style>
	/* Card 3078: its frame is the kit's dialog. The link in a quiet box, Copy beside it. */
	.invite-link-row {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: var(--space-sm) var(--space-sm) var(--space-sm) var(--space-md);
		border: 1px solid var(--ui-border);
		border-radius: var(--ui-radius);
		background: var(--ui-muted);
	}
	.invite-link-row code {
		flex: 1;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		color: var(--ui-foreground);
		overflow-wrap: anywhere;
		user-select: all;
	}
</style>
