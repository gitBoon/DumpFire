<!--
  DangerZonePanel.svelte — The admin page's Danger Zone: Purge Archived
  Cards, Vacuum Database, Reset All XP, and the superadmin's Reset Everything
  (card 2281, slice C1b: moved from src/routes/admin/+page.svelte).

  Shown to every administrator, Reset Everything to the superadmin alone.
  Each action asks first through the page's own confirm dialog, and Purge,
  Reset XP and Reset Everything ask in it for the caller's own password, which
  they send (card 2701). What a reset has to say is the page's (`resetNotice`,
  bound here): its notice is drawn by the page where it was, after the page's
  confirm dialog.

  Card 3076: a kit card at the page's #danger-zone with a faint red edge,
  its actions rows divided by a line, each an outline button: the red is the
  confirmation's alone, Reset Everything's too.
-->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { failureMessage, purgeDescription, purgeWarning, resetWarning } from '$lib/api';
	import { sent, sentAsking, showToast } from '$lib/admin/send';
	import { codeAskedHere } from '$lib/code-asked';
	import { asksForPassword, stepUpRefusal, type StepUpProof } from '$lib/step-up-words';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import CardContent from '$lib/components/ui/CardContent.svelte';
	import CardDescription from '$lib/components/ui/CardDescription.svelte';
	import CardHeader from '$lib/components/ui/CardHeader.svelte';
	import CardTitle from '$lib/components/ui/CardTitle.svelte';

	let {
		isSuperadmin,
		confirm,
		resetNotice = $bindable()
	}: {
		isSuperadmin: boolean;
		/**
		 * The page's confirm dialog, which asks before each action, and with
		 * `askPassword` for the caller's own password, handed to the action. Text
		 * the action gives back is a refusal of the password, shown in the dialog.
		 */
		confirm: (
			title: string,
			message: string,
			action: (proof: StepUpProof) => Promise<string | null | void>,
			options?: { askPassword?: boolean }
		) => void;
		/** The page's: what a reset has to say that must be read, shown in its notice. */
		resetNotice: { title: string; message: string; problems: string[]; redirect: string | null } | null;
	} = $props();

	async function resetDatabase(proof: StepUpProof): Promise<string | void> {
		let res: Response;
		try {
			res = await fetch('/api/admin/reset', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ currentPassword: proof.currentPassword, currentCode: proof.currentCode })
			});
		} catch {
			resetNotice = {
				title: 'Reset not confirmed',
				message: 'No answer from the server, so it is not known whether the reset ran. Reload the page to find out.',
				problems: [],
				redirect: null
			};
			return;
		}
		if (!res.ok) {
			// The password refused: said in the confirm dialog, which stays open to type it again.
			const refusal = await stepUpRefusal(res);
			if (refusal !== null) return refusal;
			// 500 with "The reset failed and nothing was cleared: …", or a refusal.
			resetNotice = {
				title: 'Reset failed',
				message: await failureMessage(res, 'The reset failed.'),
				problems: [],
				redirect: null
			};
			return;
		}

		const result = await res.json().catch(() => null);
		const redirect = typeof result?.redirect === 'string' && result.redirect ? result.redirect : '/setup';
		const failed: string[] = Array.isArray(result?.trash?.failed) ? result.trash.failed.map(String) : [];
		if (failed.length > 0) {
			// Done, with something to read before leaving for set-up.
			resetNotice = {
				title: 'Reset done',
				message:
					'Everything was cleared, but some attachment files could not be moved to the trash and are where they were:',
				problems: failed,
				redirect
			};
			return;
		}
		window.location.href = redirect;
	}

	async function vacuumDatabase() {
		if (!(await sent(() => fetch('/api/admin/vacuum', { method: 'POST', headers: { 'Content-Type': 'application/json' } }), 'Failed to vacuum the database'))) return;
		showToast('Database vacuumed. Unused space was reclaimed.');
	}

	async function resetAllXp(proof: StepUpProof): Promise<string | void> {
		const res = await sentAsking(
			() => fetch('/api/admin/reset-xp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: proof.currentPassword, currentCode: proof.currentCode }) }),
			'Failed to reset XP'
		);
		if (typeof res === 'string') return res;
		if (!res) return;
		showToast('All XP has been reset to 0');
	}

	let purgingArchived = $state(false);

	async function purgeArchivedCards(proof: StepUpProof): Promise<string | void> {
		purgingArchived = true;
		try {
			const res = await sentAsking(
				() => fetch('/api/admin/purge-archived', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: proof.currentPassword, currentCode: proof.currentCode }) }),
				'Failed to purge archived cards'
			);
			if (typeof res === 'string') return res;
			if (!res) return;
			const result = await res.json().catch(() => null);
			showToast(
				typeof result?.purged === 'number'
					? `Purged ${result.purged} archived card${result.purged !== 1 ? 's' : ''} permanently`
					: 'Archived cards purged permanently'
			);
			await invalidateAll();
		} finally {
			purgingArchived = false;
		}
	}
</script>

<!-- Danger zone -->
<Card as="section" id="danger-zone" class="admin-section admin-danger-zone" aria-labelledby="danger-zone-title">
	<CardHeader>
		<CardTitle level={2} id="danger-zone-title">Danger Zone</CardTitle>
		<CardDescription>These actions affect the entire database. Use with caution.</CardDescription>
	</CardHeader>
	<CardContent>
		<div class="danger-actions admin-rows">
			<div class="danger-item">
				<div class="danger-text">
					<strong>Purge Archived Cards</strong>
					<p>{purgeDescription(codeAskedHere())}</p>
				</div>
				<Button variant="outline" onclick={() => confirm('Purge Archived Cards', purgeWarning(codeAskedHere()), purgeArchivedCards, { askPassword: true })} disabled={purgingArchived}>
					{purgingArchived ? 'Purging...' : 'Purge All'}
				</Button>
			</div>
			<div class="danger-item">
				<div class="danger-text">
					<strong>Vacuum Database</strong>
					<p>Rebuilds the database file to reclaim unused space. No data is changed, and ids are not reset.</p>
				</div>
				<Button variant="outline" onclick={() => confirm('Vacuum Database', 'This rebuilds the database file to reclaim unused space. No data is changed, and ids are not reset.', vacuumDatabase)}>
					Vacuum
				</Button>
			</div>
			<div class="danger-item">
				<div class="danger-text">
					<strong>Reset All XP</strong>
					<p>Resets everyone's XP back to 0. Leaderboard will be cleared. This cannot be undone. {asksForPassword(codeAskedHere())}</p>
				</div>
				<Button variant="outline" onclick={() => confirm('Reset All XP', `This will set every user's XP to 0. The leaderboard will be completely cleared. Are you sure? ${asksForPassword(codeAskedHere())}`, resetAllXp, { askPassword: true })}>
					Reset XP
				</Button>
			</div>
			<!-- The superadmin's alone: whoever sets up after a reset is the superadmin. -->
			{#if isSuperadmin}
			<div class="danger-item">
				<div class="danger-text">
					<strong>Reset Everything</strong>
					<p>Deletes ALL data including boards, users, teams, and sessions. The system log and the backup history are kept. You will be redirected to initial setup. {asksForPassword(codeAskedHere())}</p>
				</div>
				<Button variant="outline" onclick={() => confirm('Reset Everything', resetWarning(codeAskedHere()), resetDatabase, { askPassword: true })}>
					Reset Everything
				</Button>
			</div>
			{/if}
		</div>
	</CardContent>
</Card>

<style>
	.danger-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-sm) var(--space-xl);
		padding: var(--space-md) 0;
	}
	.danger-item:first-child {
		padding-top: 0;
	}
	.danger-item:last-child {
		padding-bottom: 0;
	}
	.danger-text {
		flex: 1 1 20rem;
		min-width: 0;
	}
	.danger-item strong {
		display: block;
		margin-bottom: 0.125rem;
		font-weight: 500;
	}
	.danger-item p {
		max-width: 48rem;
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--ui-muted-foreground);
	}
</style>