<!--
  TwoStepSwitchPanel.svelte — the Admin page's Two-step sign-in panel (card
  3064, R10, S-L7, S-M6: event E3).

  The compatibility release ships two-step sign-in dormant: an account that has
  set up an authenticator is asked for its code, every other signs in on its
  password alone. The panel says which it is, and while it is dormant, what
  requiring it would meet: the enabled accounts with no authenticator, the
  sessions signed in on a password alone (which requiring it ends), every
  administrator, the superadmin among them, who has not set it up, and the API
  keys made by accounts with no authenticator, which keep working after it
  until the API key deadline is applied (E4). The keys are listed by holder
  and dates for the superadmin alone, and counted for any other
  administrator, as the page's load gives them: never a key's name or
  prefix, as nowhere else on the page.

  Require two-step sign-in is the superadmin's alone, through the page's
  confirm dialog with the password and a code (`POST
  /api/admin/two-step/require`, a listed step-up action). It is off, saying
  why under it (`aria-describedby`), while any administrator is listed: the
  route refuses it then too, naming each. A refusal of the password or the
  code stays in the dialog; any other is said in a toast, in the server's
  words (`sentAsking`), and the page is read again so that the panel shows
  the server as it now is (card 3064's code review, CR-L8). Once it is required, the page is read again
  (`invalidateAll`): every session made while it was dormant ends at its next
  use, the superadmin's own among them, so the page read again goes to sign
  in. There is no way to turn it off here (R11).
-->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { sentAsking, showToast } from '$lib/admin/send';
	import { codeAskedHere } from '$lib/code-asked';
	import { asksForPassword, type StepUpProof } from '$lib/step-up-words';
	import { parseStamp } from '$lib/timestamps';

	/** What the page's load gives the panel (`twoStepSwitchView` in admin/+page.server.ts). */
	type TwoStepSwitch = {
		required: boolean;
		requiredAt: string | null;
		accountsWithoutFactor: number;
		passwordOnlySessions: number;
		administratorsWithoutFactor: { id: number; username: string }[];
		keysWithoutFactor: number;
		keysWithoutFactorListed: { id: number; createdAt: string; lastUsedAt: string | null; holder: string; holderId: number }[] | null;
		mayRequire: boolean;
	};

	let {
		twoStepSwitch,
		confirm
	}: {
		twoStepSwitch: TwoStepSwitch;
		/** The page's confirm dialog, asking for the password and a code (card 2701). */
		confirm: (title: string, message: string, action: (proof: StepUpProof) => Promise<string | null | void>, options?: { askPassword?: boolean }) => void;
	} = $props();

	const id = $props.id();
	const reasonId = `${id}-require-reason`;

	/** A moment in the stored form with its time and zone, `2026-11-24 09:12 UTC`. */
	function moment(at: string): string {
		const d = parseStamp(at);
		return d === null ? at : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
	}

	/** `1 account`, `2 accounts`. */
	const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

	/** While any administrator holds no factor, two-step sign-in cannot be required (S-L7). */
	let blocked = $derived(twoStepSwitch.administratorsWithoutFactor.length > 0);

	/** Require two-step sign-in, asked first in the page's confirm with the password and a code. */
	function ask() {
		const ended = counted(twoStepSwitch.passwordOnlySessions, 'session', 'sessions');
		confirm(
			'Require two-step sign-in',
			`Require two-step sign-in on this server? From now on every account signs in with its password and a code from an authenticator app. ` +
				`The ${ended} signed in on a password alone ${twoStepSwitch.passwordOnlySessions === 1 ? 'is' : 'are'} ended now, and everyone else, you included, signs in again at their next visit. ` +
				`Accounts that have not set it up are taken through setting it up when they next sign in. This cannot be turned off here. ${asksForPassword(codeAskedHere())}`,
			requireTwoStep,
			{ askPassword: true }
		);
	}

	async function requireTwoStep(proof: StepUpProof): Promise<string | void> {
		const res = await sentAsking(
			() =>
				fetch('/api/admin/two-step/require', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ currentPassword: proof.currentPassword, currentCode: proof.currentCode })
				}),
			'Two-step sign-in was not required.'
		);
		// A refusal of the password or the code goes back to the dialog, whose field reads the page again where the server
		// asks a code the page did not know of (CS-L5).
		if (typeof res === 'string') return res;
		if (!res) {
			// Any other refusal, said in a toast (an administrator without a factor now, or two-step sign-in already
			// required): the panel is read again so that it shows the server as it now is (card 3064's code review, CR-L8).
			await invalidateAll();
			return;
		}
		const done = await res.json().catch(() => null);
		const ended = typeof done?.sessionsEnded === 'number' ? done.sessionsEnded : 0;
		showToast(`Two-step sign-in is now required. ${counted(ended, 'session', 'sessions')} signed in on a password alone ${ended === 1 ? 'was' : 'were'} ended.`);
		// Read again: every session made while it was dormant, this one among them, now ends at its next use.
		await invalidateAll();
	}
</script>

<section class="admin-card glass fade-in-up two-step-switch" style="animation-delay: 30ms" aria-labelledby="{id}-heading">
	<h2 id="{id}-heading">🛡️ Two-step sign-in</h2>
	{#if twoStepSwitch.required}
		<p class="section-desc switch-state">
			Two-step sign-in is required on this server{#if twoStepSwitch.requiredAt}, since {moment(twoStepSwitch.requiredAt)}{/if}. Every account signs in with its password and a code from an authenticator app. It cannot be turned off here.
		</p>
	{:else}
		<p class="section-desc switch-state">
			Two-step sign-in is not required on this server. Accounts that have set up an authenticator app are asked for its code; the others sign in with their password alone. Each can set it up on their Account page.
		</p>
		<ul class="switch-counts">
			<li>{counted(twoStepSwitch.accountsWithoutFactor, 'enabled account has', 'enabled accounts have')} not set up two-step sign-in.</li>
			<li>{counted(twoStepSwitch.passwordOnlySessions, 'session is', 'sessions are')} signed in on a password alone: requiring two-step sign-in ends them.</li>
		</ul>

		<h3 class="switch-sub">Administrators</h3>
		{#if blocked}
			<p class="switch-line">Not yet set up, so two-step sign-in cannot be required until each has set it up on their Account page:</p>
			<ul class="switch-list switch-admins">
				{#each twoStepSwitch.administratorsWithoutFactor as admin (admin.id)}
					<li>{admin.username} (user {admin.id})</li>
				{/each}
			</ul>
		{:else}
			<p class="switch-line">Every administrator has set up two-step sign-in.</p>
		{/if}

		<h3 class="switch-sub">API keys of accounts without two-step sign-in</h3>
		{#if twoStepSwitch.keysWithoutFactor === 0}
			<p class="switch-line">None.</p>
		{:else}
			<p class="switch-line">
				{counted(twoStepSwitch.keysWithoutFactor, 'API key was', 'API keys were')} made by accounts that have not set up two-step sign-in. Each keeps working after two-step sign-in is required, until the API key deadline is applied: check each with its holder.
			</p>
			{#if twoStepSwitch.keysWithoutFactorListed}
				<ul class="switch-list switch-keys">
					{#each twoStepSwitch.keysWithoutFactorListed as key (key.id)}
						<li>
							A key of <strong>{key.holder}</strong> (user {key.holderId}): made {moment(key.createdAt)}, {key.lastUsedAt === null ? 'never used' : `last used ${moment(key.lastUsedAt)}`}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}

		{#if twoStepSwitch.mayRequire}
			<div class="switch-actions">
				<button class="btn-danger-solid" onclick={ask} disabled={blocked} aria-describedby={blocked ? reasonId : undefined}>Require two-step sign-in</button>
				{#if blocked}
					<p class="switch-reason" id={reasonId}>Each administrator listed above must set up two-step sign-in first.</p>
				{/if}
			</div>
		{:else}
			<p class="switch-line">Requiring two-step sign-in is the superadmin's.</p>
		{/if}
	{/if}
</section>

<style>
	.switch-state { margin-bottom: var(--space-md); }
	.switch-counts, .switch-list {
		margin: 0 0 var(--space-md);
		padding-left: var(--space-lg);
		font-size: 0.82rem;
		color: var(--text-secondary);
		line-height: 1.5;
		overflow-wrap: anywhere;
	}
	.switch-sub {
		font-size: 0.78rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
		color: var(--text-tertiary); margin: var(--space-md) 0 var(--space-xs);
	}
	.switch-line { font-size: 0.82rem; color: var(--text-secondary); margin: 0 0 var(--space-sm); }
	.switch-actions { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-xs); margin-top: var(--space-md); }
	.switch-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
	.switch-reason { font-size: 0.72rem; color: var(--text-tertiary); margin: 0; }
</style>
