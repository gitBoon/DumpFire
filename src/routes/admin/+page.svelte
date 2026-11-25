<script lang="ts">
	/**
	 * Admin Page — Database management, user management, and team management.
	 *
	 * Provides board management (delete, clear cards/categories),
	 * user management (create, roles, delete), team management,
	 * database operations (reset, vacuum), and import/export.
	 *
	 * Card 3076: on the kit's shell, full width, with a list of its sections
	 * in a rail on the left (`AdminSectionNav`, one row above the page below
	 * 1024px). Each section is a card with an address (`/admin#users`), in
	 * groups: the overview and the held list; Access; Data; Settings; the
	 * Danger Zone last. The held list stays at the top and the mail panel
	 * below the users panel, as the page's words say.
	 */
	import type { PageData } from './$types';
	import PageShell from '$lib/components/ui/PageShell.svelte';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import CardDescription from '$lib/components/ui/CardDescription.svelte';
	import CardHeader from '$lib/components/ui/CardHeader.svelte';
	import CardTitle from '$lib/components/ui/CardTitle.svelte';
	import AdminSectionNav from '$lib/components/admin/AdminSectionNav.svelte';
	import '$lib/components/admin/admin.css';
	import Toast from '$lib/components/Toast.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	// The superadmin's panel (card 2281, slice C1a): the export and the import, drawn in the markup's isSuperadmin block alone.
	import BackupRestorePanel from '$lib/components/admin/BackupRestorePanel.svelte';
	// Every administrator's panels (card 2281, slice C1b), drawn outside that block; the App URL, the
	// scheduled backups and the mail settings among them since card 2395.
	import AppUrlPanel from '$lib/components/admin/AppUrlPanel.svelte';
	import ScheduledBackupsPanel from '$lib/components/admin/ScheduledBackupsPanel.svelte';
	import SmtpPanel from '$lib/components/admin/SmtpPanel.svelte';
	import AdminOverview from '$lib/components/admin/AdminOverview.svelte';
	import BoardManagementPanel from '$lib/components/admin/BoardManagementPanel.svelte';
	import UsersPanel from '$lib/components/admin/UsersPanel.svelte';
	import InviteLinkDialog from '$lib/components/admin/InviteLinkDialog.svelte';
	import TeamsPanel from '$lib/components/admin/TeamsPanel.svelte';
	import DangerZonePanel from '$lib/components/admin/DangerZonePanel.svelte';
	// Card 2922: the one list of the settings held for the superadmin's review.
	import SettingsHeldPanel from '$lib/components/admin/SettingsHeldPanel.svelte';
	// Card 3064 (R10): whether two-step sign-in is required, and the superadmin's switch to require it.
	import TwoStepSwitchPanel from '$lib/components/admin/TwoStepSwitchPanel.svelte';
	import { HELD_POINTER, type HeldSetting } from '$lib/settings-held';
	import SettingsHeldBanner from '$lib/components/SettingsHeldBanner.svelte';
	import Dialog from '$lib/components/ui/Dialog.svelte';
	import type { StepUpProof } from '$lib/step-up-words';

	let { data }: { data: PageData } = $props();

	let isSuperadmin = $derived(data.currentUser?.role === 'superadmin');

	/**
	 * Who the superadmin is, for the line an administrator is shown in place
	 * of what is the superadmin's alone: the export, the import and the reset.
	 * Null if no account is one, which the server says in its log when it
	 * starts.
	 */
	let superadminName = $derived(data.users.find((u) => u.role === 'superadmin')?.username ?? null);

	/**
	 * What Confirm runs, handed the proof typed (`NO_PROOF` where none was asked):
	 * text it gives back is the server's refusal of the password, which the
	 * dialog shows, staying open (card 2701, D6).
	 */
	type ConfirmedAction = (proof: StepUpProof) => Promise<string | null | void>;

	/** Confirm modal state for destructive admin actions. */
	let confirmAction = $state<{ show: boolean; title: string; message: string; action: ConfirmedAction; askPassword: boolean }>({
		show: false, title: '', message: '', action: async () => {}, askPassword: false
	});

	/**
	 * Opens the confirm modal for a destructive action. `askPassword` asks for
	 * the caller's own password in it, for an action that asks for it again
	 * (card 2701, decision 13), and hands it to `action`.
	 */
	function confirm(title: string, message: string, action: ConfirmedAction, options: { askPassword?: boolean } = {}) {
		confirmAction = { show: true, title, message, action, askPassword: options.askPassword === true };
	}

	/** Confirm pressed: the action runs with the dialog open, which closes once it gives back no refusal. */
	async function confirmed(proof: StepUpProof): Promise<string | void> {
		const refusal = await confirmAction.action(proof);
		if (typeof refusal === 'string') return refusal;
		confirmAction.show = false;
	}

	/**
	 * What a reset has to say that must be read: that it failed, or that it
	 * was done and some attachment files are where they were. A toast is a
	 * line in a corner, and after a reset that was done the page is about to
	 * leave for set-up, which takes every toast with it, so this stays up
	 * until it is answered.
	 *
	 * `redirect` is where to go from it, after a reset that was done. Null
	 * when nothing was cleared and the page stays.
	 *
	 * Set by the danger zone's Reset Everything (card 2281, slice C1b: bound
	 * there), and kept here with its notice, which is drawn where it was.
	 */
	let resetNotice = $state<{ title: string; message: string; problems: string[]; redirect: string | null } | null>(null);

	/**
	 * The link of an invite whose mail was not sent, shown once in its dialog
	 * to the administrator who issued it (card 2196, decision 9). A credential:
	 * whoever opens it sets the account's password. It lives here alone, never
	 * in a toast, the address, history or storage, and is cleared on Done.
	 * The link of a two-step sign-in reset is held here too, with `kind:
	 * 'mfa-reset'` (card 2773): the same dialog, its own words.
	 */
	let inviteLink = $state<{ url: string; username: string; message: string; returnTo?: HTMLElement; kind?: 'invite' | 'mfa-reset' | 'new-account' } | null>(null);

	/** The mail panel, whose read of what mail has done the users panel asks for after an invite. */
	let smtpPanel = $state<ReturnType<typeof SmtpPanel>>();

	/**
	 * Moved on when a role change or a delete removed settings the account had
	 * set (card 2397), each for what went alone (its review): `mailRead` for
	 * the mail settings or the App URL, which draws the App URL and mail panels
	 * again, `destinationsRead` for backup destinations, which draws Scheduled
	 * Backups again. Each panel drawn again reads its settings as it opens; one
	 * whose settings did not change keeps what is open in it.
	 */
	let mailRead = $state(0);
	let destinationsRead = $state(0);

	/**
	 * The settings held for the superadmin's review, as the list last read them (card 2922): each settings panel shows
	 * a one-line pointer to the list while one of its settings is among them (its plan's R7).
	 */
	let settingsHeld = $state<HeldSetting[]>([]);
	let mailHeldHere = $derived(settingsHeld.some((held) => held.kind === 'mail'));
	let appUrlHeldHere = $derived(settingsHeld.some((held) => held.kind === 'app_url'));
	let destinationsHeldHere = $derived(settingsHeld.some((held) => held.kind === 'destination'));

	/** What the users panel says a role change or a delete removed: the panels that show it are drawn again. */
	function settingsRemoved(removed: { mail: boolean; appUrl: boolean; destinations: string[] }) {
		if (removed.mail || removed.appUrl) mailRead++;
		if (removed.destinations.length > 0) destinationsRead++;
	}
</script>

<svelte:head>
	<title>Admin — DumpFire</title>
</svelte:head>

<!-- Card 3076: the list of the page's sections, in the rail; every administrator's, so in no {#if}. -->
{#snippet sections()}
	<AdminSectionNav held={settingsHeld.length > 0} />
{/snippet}

<PageShell width="full" title="Admin" rail={sections} railLabel="Admin sections" railPosition="start">
	<!-- Card 2922 (R7): the superadmin's banner while a setting is held for review, on every admin page. -->
	<SettingsHeldBanner held={settingsHeld} superadmin={isSuperadmin} />
	<PageHeader title="Admin" description="Settings, people, backups and upkeep for this DumpFire server." />
	<div class="page-sections">
		<AdminOverview {data} />

		<!-- Card 2922: the settings held for review, every administrator's to read, the superadmin's to keep or remove.
		     A Keep or a Remove draws the panels that show the setting again. -->
		<SettingsHeldPanel {confirm} bind:held={settingsHeld} onChanged={(setting) => (setting.startsWith('backup_destination:') ? destinationsRead++ : mailRead++)} />

		<!-- Access -->
		<!-- Card 3064 (R10): two-step sign-in, every administrator's to read, the superadmin's to require. -->
		<TwoStepSwitchPanel twoStepSwitch={data.twoStepSwitch} {confirm} />

		<UsersPanel {data} {isSuperadmin} {confirm} loadMailStatus={() => smtpPanel?.loadMailStatus()} {settingsRemoved} bind:inviteLink />

		<TeamsPanel {data} {confirm} />

		<!-- The people directory (card 2674): its own page, every administrator's. -->
		<Card as="section" id="people-directory" class="admin-section" aria-labelledby="people-directory-title">
			<CardHeader>
				{#snippet actions()}
					<Button variant="outline" size="sm" href="/admin/people">Open the people directory</Button>
				{/snippet}
				<CardTitle level={2} id="people-directory-title">People Directory</CardTitle>
				<CardDescription>Who can be consulted on or told of a decision, with an account or without one, and their groups.</CardDescription>
			</CardHeader>
		</Card>

		<!-- The ISO 27001:2022 checklist (card 2670): its own page, every administrator's, read-only. -->
		<Card as="section" id="iso" class="admin-section" aria-labelledby="iso-title">
			<CardHeader>
				{#snippet actions()}
					<Button variant="outline" size="sm" href="/admin/iso-27001">Open the checklist</Button>
				{/snippet}
				<CardTitle level={2} id="iso-title">ISO 27001:2022 Checklist</CardTitle>
				<CardDescription>Every Annex A control and clauses 4 to 10, with how far DumpFire meets each, its evidence and the cards that close what is open.</CardDescription>
			</CardHeader>
		</Card>

		<!-- Data -->
		<BoardManagementPanel {data} {confirm} />

		<!-- The superadmin's alone: export and import (and Reset Everything, in the danger zone).
		     An administrator is refused each of them by its route, and is shown one line in their place. -->
		{#if isSuperadmin}
		<BackupRestorePanel importOutsideDefault={data.importOutsideDefault} />
		{:else}
		<Card as="section" id="backup" class="admin-section" aria-labelledby="backup-title">
			<CardHeader>
				<CardTitle level={2} id="backup-title">The superadmin's</CardTitle>
				<CardDescription>
					{#if superadminName}
						Exporting, importing and resetting the database belong to the superadmin, <strong>{superadminName}</strong>, and are on this page for that account only.
					{:else}
						Exporting, importing and resetting the database belong to the superadmin, and no account is the superadmin. Whoever runs the server can make one: see "If nobody can sign in as the superadmin" in the deployment guide.
					{/if}
				</CardDescription>
			</CardHeader>
		</Card>
		{/if}

		<!-- Every administrator's since card 2395: the scheduled backups and their destinations. Lowering Keep Last,
		     removing a destination and switching the schedule off are the superadmin's (card 2398). Drawn again once
		     destinations an account had set are removed with it (card 2397). -->
		<!-- Card 2922 (R7): a pointer to the list while a destination is held. -->
		{#if destinationsHeldHere}<p class="held-pointer admin-notice admin-notice-warning"><a href="#settings-held">⏸️ A backup destination is held for review: {HELD_POINTER}</a></p>{/if}
		{#key destinationsRead}
		<ScheduledBackupsPanel {confirm} {isSuperadmin} />
		{/key}

		<!-- Settings -->
		<!-- The App URL: shown to every administrator since card 2395, set by the superadmin alone since card 2847. Drawn again once the mail settings or the App URL an account had set are removed with it (card 2397). -->
		<!-- Card 2922 (R7): a pointer to the list while the App URL is held. -->
		{#if appUrlHeldHere}<p class="held-pointer admin-notice admin-notice-warning"><a href="#settings-held">⏸️ The App URL is held for review: {HELD_POINTER}</a></p>{/if}
		{#key mailRead}
		<AppUrlPanel {isSuperadmin} {superadminName} />
		{/key}

		<!-- SMTP Configuration: every administrator's since card 2395. Drawn again with the App URL panel (card 2397). -->
		<!-- Card 2922 (R7): a pointer to the list while the mail settings are held. -->
		{#if mailHeldHere}<p class="held-pointer admin-notice admin-notice-warning"><a href="#settings-held">⏸️ The mail settings are held for review: {HELD_POINTER}</a></p>{/if}
		{#key mailRead}
		<SmtpPanel bind:this={smtpPanel} currentUser={data.currentUser} />
		{/key}

		<DangerZonePanel {isSuperadmin} {confirm} bind:resetNotice />
	</div>
</PageShell>
<!-- Confirm dialog: the app's, which takes the focus and answers Escape (card 2362: it was the page's own, with neither) -->
{#if confirmAction.show}
	<ConfirmModal
		kit
		title={confirmAction.title}
		message={confirmAction.message}
		confirmText="Confirm"
		askPassword={confirmAction.askPassword}
		onConfirm={confirmed}
		onCancel={() => (confirmAction.show = false)}
	/>
{/if}

<!-- What a reset has to say: that it failed, or what it could not move. No way out of it but its one button.
     Its button has the focus as it opens and Tab stays in it (card 2365: it took no focus). Escape is Close, after a refused reset;
     after one that was done the way out is Continue to set-up alone, and Escape does nothing. -->
{#if resetNotice}
	{#snippet resetNoticeActions()}
		{#if resetNotice?.redirect}
			<Button onclick={() => { window.location.href = resetNotice?.redirect ?? '/setup'; }}>Continue to set-up</Button>
		{:else}
			<Button variant="outline" onclick={() => (resetNotice = null)}>Close</Button>
		{/if}
	{/snippet}
	<!-- Card 3078: the kit's frame, on the same focus rules. -->
	<Dialog
		role="alertdialog"
		aria-label={resetNotice.title}
		title={resetNotice.title}
		size="md"
		class="confirm-modal"
		footerClass="modal-actions"
		initialFocus=".modal-actions button"
		onEscape={resetNotice.redirect ? undefined : () => (resetNotice = null)}
		footer={resetNoticeActions}
	>
		<p>{resetNotice.message}</p>
		{#if resetNotice.problems.length > 0}
			<ul class="reset-problems">
				{#each resetNotice.problems.slice(0, 100) as problem}
					<li>{problem}</li>
				{/each}
				{#if resetNotice.problems.length > 100}
					<li>…and {resetNotice.problems.length - 100} more.</li>
				{/if}
			</ul>
		{/if}
	</Dialog>
{/if}

<!-- The link of an invite whose mail was not sent: its dialog, set by the users panel, drawn here after the page's own dialogs as it always was. -->
<InviteLinkDialog bind:inviteLink />

<!-- Toast -->
<Toast />

<style>
	/*
	 * Card 3076: the page's cards one under another; its foot stops above the
	 * user badge in PageShell's main (card 2239). The panels are styled by the
	 * kit and admin.css, no longer by `.admin-page :global(...)` rules here.
	 */
	.page-sections {
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
	}

	/* What a reset could not move to the trash */
	.reset-problems {
		margin: 0;
		padding-left: var(--space-lg);
		max-height: 240px;
		overflow-y: auto;
		font-size: 0.8rem;
		line-height: 1.5;
		color: var(--ui-muted-foreground);
		overflow-wrap: anywhere;
	}

	/* Card 2922: the line above a settings panel while one of its settings is held for review, close above its card. */
	.held-pointer {
		margin-bottom: calc(var(--space-sm) - var(--space-lg));
	}
</style>