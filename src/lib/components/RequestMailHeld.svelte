<!--
  RequestMailHeld.svelte — a request whose mail to its requester is held (card
  3020, its plan's R2, R3, R4 and R11).

  A restore of a backup whose seal did not verify holds the mail of each request
  it brought in with an address this server did not hold as it is: no progress,
  reply or completion report goes to its requester until an administrator
  releases it.

  Without `held`, the badge alone, for a request the inbox lists. With `held`, a
  row of the inbox's Mail held section, read from GET /api/requests/held by an
  administrator: the request's title, its requester's address and name and its
  card as they came in, and Release, which asks for the password and a code
  (`STEP_UP_ACTIONS`) and sends the address and the card reviewed back (R4; its
  code review's FP4). An unconfirmed request is never released (R11): it says
  that it lapses instead. Nor is one with no address (FP3): it says so.

  The address came from a file whose seal did not verify, so it is shown with
  `asciiShown`, every character outside printable ASCII as its code point, and
  the names and titles through `printable` (R3).
-->
<script module lang="ts">
	/** One held request, as GET /api/requests/held answers it. */
	export type HeldRequest = {
		id: number;
		title: string;
		status: string;
		unconfirmed: boolean;
		releasable: boolean;
		requesterName: string;
		address: string | null;
		card: { id: number; title: string; board: string } | null;
		heldBecause: string;
		createdAt: string;
	};
</script>

<script lang="ts">
	import ConfirmModal from './ConfirmModal.svelte';
	import { sentAsking, showToast } from '$lib/admin/send';
	import { asciiShown, printable } from '$lib/printable';
	import { ASKS_FOR_PASSWORD, type StepUpProof } from '$lib/step-up-words';

	let {
		held = null,
		onReleased = () => {}
	}: {
		/** The held request, as the review list gives it; none for the badge alone. */
		held?: HeldRequest | null;
		/** Told after a release, or a refusal, so the page reads the lists again. */
		onReleased?: (requestId: number) => void;
	} = $props();

	/** The release dialog is open. */
	let asking = $state(false);

	/** The address in the words the page shows: its code points, or that there is none. */
	const shownAddress = (request: HeldRequest) => (request.address === null ? 'no address' : asciiShown(request.address));

	/** What the release dialog says: the address reviewed, and the card, as they came in (R1, R3). */
	function releaseWords(request: HeldRequest): string {
		const card = request.card === null ? 'It has no card.' : `Its card: ${printable(request.card.title)} on ${printable(request.card.board)}.`;
		return (
			`Mail to ${shownAddress(request)} is held: this request came in with a backup whose seal did not verify. ${card} ` +
			'Release it only if you recognise the address and the card. Its requester is then mailed progress, replies and the completion report. ' +
			ASKS_FOR_PASSWORD
		);
	}

	/** Release, confirmed with the password: the address and the card reviewed are sent back (R4, FP4). */
	async function release(request: HeldRequest, proof: StepUpProof): Promise<string | void> {
		const res = await sentAsking(
			() =>
				fetch('/api/requests/held', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						requestId: request.id,
						address: request.address,
						cardId: request.card?.id ?? null,
						cardTitle: request.card?.title ?? null,
						cardBoard: request.card?.board ?? null,
						currentPassword: proof.currentPassword,
						currentCode: proof.currentCode
					})
				}),
			'The mail was not released'
		);
		if (typeof res === 'string') return res;
		asking = false;
		// Released, or refused (a change since the list was read, said in a toast): the list is read again either way.
		if (res) showToast(`Mail to the requester of "${printable(request.title)}" released`);
		onReleased(request.id);
	}
</script>

{#if held === null}
	<span class="mail-held-badge" title="Mail to this request's requester is held: it came in with a backup whose seal did not verify">⏸️ Mail held</span>
{:else}
	<li class="mail-held-item">
		<div>
			<span class="mail-held-badge">⏸️ Mail held</span>
			<strong>{printable(held.title)}</strong>
			<div class="mail-held-meta">
				From {printable(held.requesterName)}, to <code>{shownAddress(held)}</code>
			</div>
			<div class="mail-held-meta">
				{#if held.card}
					Card: {printable(held.card.title)} on {printable(held.card.board)}
				{:else}
					No card
				{/if}
			</div>
		</div>
		{#if held.releasable}
			<button class="btn-release" aria-label={`Release mail of ${printable(held.title)}`} onclick={() => (asking = true)}>Release</button>
		{:else if held.unconfirmed}
			<span class="mail-held-meta">Cannot be released: lapses after 7 days</span>
		{:else}
			<span class="mail-held-meta">Cannot be released: no address</span>
		{/if}
	</li>
	{#if asking}
		{@const request = held}
		<ConfirmModal
			title={printable(request.title)}
			message={releaseWords(request)}
			confirmText="Release"
			confirmDanger={false}
			askPassword={true}
			onConfirm={(proof) => release(request, proof)}
			onCancel={() => (asking = false)}
		/>
	{/if}
{/if}

<style>
	.mail-held-badge {
		display: inline-block;
		padding: 2px 8px;
		border-radius: 999px;
		font-size: 0.68rem;
		font-weight: 600;
		background: rgba(245, 158, 11, 0.15);
		color: #b45309;
		border: 1px solid rgba(245, 158, 11, 0.35);
	}
	.mail-held-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-sm);
		flex-wrap: wrap;
		padding: var(--space-sm) 0;
	}
	.mail-held-meta {
		font-size: 0.72rem;
		color: var(--text-secondary);
		overflow-wrap: anywhere;
	}
	.btn-release {
		padding: 4px 12px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--glass-border);
		background: transparent;
		color: var(--text-primary);
		font-size: 0.75rem;
		cursor: pointer;
	}
</style>
