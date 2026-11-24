<!--
  TwoStepSection.svelte — the Account page's Two-step sign-in section (card
  2772, D9): the last sign-in, the way back from a lost phone, the account's
  authenticators (each with Remove), adding one, and the recovery codes left
  with a way to make a new set.

  Adding, removing and a new set of codes each ask for the password and a code
  in `ConfirmModal` (`askPassword`, E24), the body spread from the proof; a
  refusal of either goes back to the dialog, anything else is said on the
  section's own line. Adding then shows the new secret and its QR code once,
  with "Keep this page open…" and a warning if the page is left (E19:
  `beforeunload`, and `beforeNavigate` for a move within DumpFire, CR2), the
  focus in the new phone's code field, labelled apart from the step-up's
  (E18); an `aria-live` region says each step. The new recovery codes are held
  in this component alone, never in the page's data, and the box that shows
  them closes only on "I have saved these codes" (E20), and leaving the page
  while it shows warns as the set-up does. Where the clipboard refuses them,
  Download and Select all are offered beside Copy (CR5).

  A greyed button says why under it, tied by `aria-describedby` (E18). After
  each success the page's data is read again (`invalidateAll`).
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { beforeNavigate, invalidateAll } from '$app/navigation';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { failureMessage } from '$lib/api';
	import { codeAskedHere } from '$lib/code-asked';
	import { asksForPassword, stepUpRefusal, type StepUpProof } from '$lib/step-up-words';
	import { parseStamp } from '$lib/timestamps';

	/** What the Account page loads for the section (card 2772, D10). */
	type TwoStep = {
		factors: { id: number; label: string; kind: string; createdAt: string; lastUsedAt: string | null }[];
		codesLeft: number;
		most: number;
		keys: { name: string; createdAt: string; lastUsedAt: string | null }[];
		webhooks: { board: string; host: string; createdAt: string }[];
		words: { codesLeft: string; lastSignIn: string | null; wrongCodes: string | null };
	};

	let { twoStep }: { twoStep: TwoStep } = $props();

	const id = $props.id();
	const removeReasonId = `${id}-remove-reason`;
	const addReasonId = `${id}-add-reason`;
	const newCodeId = `${id}-new-code`;
	const labelId = `${id}-label`;

	/** A moment in the stored form with its time and zone, `2026-11-17 09:12 UTC`. */
	function moment(at: string): string {
		const d = parseStamp(at);
		return d === null ? at : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
	}

	/** Only one authenticator: it cannot be removed until another is added. */
	let onlyOne = $derived(twoStep.factors.length <= 1);
	/** As many as an account may hold: none can be added until one is removed. */
	let full = $derived(twoStep.factors.length >= twoStep.most);

	/** What the section's own line says: a refusal that is not of the password or the code. */
	let sectionError = $state('');
	/** What the `aria-live` region says of the step reached. */
	let announced = $state('');

	// ─── Adding ───────────────────────────────────────────────────────────────

	/** The name typed for the new authenticator (E17: required). */
	let newLabel = $state('');
	/** The Add dialog is open. */
	let askingToAdd = $state(false);
	/** The set-up under way: what the start answered, shown once. */
	let adding = $state<{ pendingId: string; account: string; issuer: string; secret: string; qr: string; expiresAt: string } | null>(null);
	/** The new phone's code. */
	let newCode = $state('');
	let confirmingAdd = $state(false);
	let newCodeField = $state<HTMLInputElement>();

	/**
	 * Begin adding, confirmed with the password and a code: the set-up shown,
	 * the focus in the new phone's code field. A refusal of the password or the
	 * code goes back to the dialog; any other closes it, said on the line.
	 */
	async function startAdding(proof: StepUpProof): Promise<string | void> {
		sectionError = '';
		try {
			const res = await fetch('/api/account/two-step/authenticators', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ label: newLabel, currentPassword: proof.currentPassword, currentCode: proof.currentCode })
			});
			if (res.ok) {
				askingToAdd = false;
				adding = await res.json();
				newCode = '';
				announced = 'Scan the QR code with the new phone, then enter the code it shows.';
				await tick();
				newCodeField?.focus();
			} else {
				const refusal = await stepUpRefusal(res);
				if (refusal !== null) return refusal;
				askingToAdd = false;
				sectionError = await failureMessage(res, 'The authenticator was not added.');
			}
		} catch {
			askingToAdd = false;
			sectionError = 'No answer from the server. Nothing was added: start again.';
		}
	}

	/**
	 * The new phone's code: the authenticator written. A wrong code keeps the
	 * set-up to try again; a set-up that has ended (replaced, timed out, too
	 * many wrong codes) goes, with the server's words.
	 */
	async function confirmAdding() {
		if (adding === null || newCode.trim() === '' || confirmingAdd) return;
		confirmingAdd = true;
		sectionError = '';
		const pendingId = adding.pendingId;
		const code = newCode;
		newCode = '';
		try {
			const res = await fetch('/api/account/two-step/authenticators/confirm', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ pendingId, code })
			});
			if (res.ok) {
				adding = null;
				newLabel = '';
				announced = 'Authenticator added.';
				await invalidateAll();
			} else {
				sectionError = await failureMessage(res, 'The authenticator was not added.');
				if (res.status === 409) adding = null;
				else newCodeField?.focus();
			}
		} catch {
			sectionError = 'No answer from the server. Reload the page to see whether the authenticator was added.';
		} finally {
			confirmingAdd = false;
		}
	}

	/** Stop adding: the set-up is left to end on its own. */
	function cancelAdding() {
		adding = null;
		newCode = '';
		announced = 'Adding was cancelled.';
	}

	/**
	 * Whether leaving the page would lose what is shown once: a set-up under
	 * way (E19), or new recovery codes not yet marked saved (E20).
	 */
	function holdsWhatIsShownOnce(): boolean {
		return adding !== null || freshCodes !== null;
	}

	/** While either is shown, closing or reloading the page warns: it is not shown again. */
	function warnBeforeLeaving(e: BeforeUnloadEvent) {
		if (!holdsWhatIsShownOnce()) return;
		e.preventDefault();
		e.returnValue = '';
	}

	/**
	 * And a move to another page of DumpFire, which `beforeunload` does not
	 * see, asks first (code review CR2). A move that unloads the page is left
	 * to `beforeunload`, so that it asks once.
	 */
	beforeNavigate((navigation) => {
		if (navigation.willUnload || !holdsWhatIsShownOnce()) return;
		const what =
			adding !== null
				? 'The authenticator you are adding is not finished, and its QR code and secret are not shown again.'
				: 'Your new recovery codes are not shown again.';
		if (!confirm(`${what} Leave this page anyway?`)) navigation.cancel();
	});

	// ─── Removing ─────────────────────────────────────────────────────────────

	/** The authenticator whose Remove dialog is open. */
	let removing = $state<TwoStep['factors'][number] | null>(null);

	/** What the Remove dialog says (D2, S4, S10, E21): other browsers sign out, and the live keys and webhooks to check. */
	function removeMessage(factor: TwoStep['factors'][number]): string {
		const keys =
			twoStep.keys.length === 0
				? 'API keys: none.'
				: `API keys: ${twoStep.keys.map((key) => `${key.name} (made ${moment(key.createdAt)}, ${key.lastUsedAt === null ? 'never used' : `last used ${moment(key.lastUsedAt)}`})`).join('; ')}.`;
		const hooks =
			twoStep.webhooks.length === 0
				? 'Webhooks: none.'
				: `Webhooks: ${twoStep.webhooks.map((hook) => `${hook.board}, to ${hook.host} (made ${moment(hook.createdAt)})`).join('; ')}.`;
		return (
			`Remove ${factor.label} (added ${moment(factor.createdAt)})? Every other browser signed in to your account will be signed out. ` +
			'If the device was lost, also change your password, and check the API keys and webhooks below: revoke any you do not recognise. ' +
			`${keys} ${hooks} ${asksForPassword(codeAskedHere())}`
		);
	}

	/** Remove, confirmed with the password and a code (D2). */
	async function removeAuthenticator(factorId: number, proof: StepUpProof): Promise<string | void> {
		sectionError = '';
		try {
			const res = await fetch(`/api/account/two-step/authenticators/${factorId}`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ currentPassword: proof.currentPassword, currentCode: proof.currentCode })
			});
			if (res.ok) {
				removing = null;
				announced = 'Authenticator removed. Your other browsers were signed out.';
				await invalidateAll();
			} else {
				const refusal = await stepUpRefusal(res);
				if (refusal !== null) return refusal;
				removing = null;
				sectionError = await failureMessage(res, 'The authenticator was not removed.');
			}
		} catch {
			removing = null;
			sectionError = 'No answer from the server. Reload the page to see whether the authenticator was removed.';
		}
	}

	// ─── Recovery codes ───────────────────────────────────────────────────────

	/** The Make new recovery codes dialog is open. */
	let askingForCodes = $state(false);
	/** The new codes, shown once: held here alone, never in the page's data (E20). */
	let freshCodes = $state<string[] | null>(null);
	let codesCopied = $state(false);
	/** The clipboard refused the codes (code review CR5): Download and Select all are offered beside Copy. */
	let copyFailed = $state(false);
	/** Where the clipboard cannot be written, Download and Select all are offered instead. */
	let canCopy = $derived(typeof navigator !== 'undefined' && navigator.clipboard !== undefined);
	let codesBox = $state<HTMLTextAreaElement>();

	/** A new set of ten, confirmed with the password and a code (D3). */
	async function regenerateCodes(proof: StepUpProof): Promise<string | void> {
		sectionError = '';
		try {
			const res = await fetch('/api/account/two-step/recovery-codes', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ currentPassword: proof.currentPassword, currentCode: proof.currentCode })
			});
			if (res.ok) {
				askingForCodes = false;
				const made = await res.json();
				freshCodes = made.codes;
				codesCopied = false;
				copyFailed = false;
				announced = 'Ten new recovery codes were made. Save them now: they are not shown again.';
				await invalidateAll();
			} else {
				const refusal = await stepUpRefusal(res);
				if (refusal !== null) return refusal;
				askingForCodes = false;
				sectionError = await failureMessage(res, 'No new recovery codes were made.');
			}
		} catch {
			askingForCodes = false;
			sectionError = 'No answer from the server. Reload the page to see whether new recovery codes were made.';
		}
	}

	async function copyCodes() {
		if (freshCodes === null) return;
		try {
			await navigator.clipboard.writeText(freshCodes.join('\n'));
			codesCopied = true;
		} catch {
			// Refused (no permission, the page not focused, an insecure origin):
			// the other two ways are shown beside it.
			codesCopied = false;
			copyFailed = true;
			announced = 'The codes could not be copied. Download them, or select them all and copy them yourself.';
		}
	}

	/** The codes as a text file made in the page: nothing is sent. */
	function downloadCodes() {
		if (freshCodes === null) return;
		const url = URL.createObjectURL(new Blob([`${freshCodes.join('\n')}\n`], { type: 'text/plain' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = 'dumpfire-recovery-codes.txt';
		a.click();
		URL.revokeObjectURL(url);
	}

	function selectCodes() {
		codesBox?.focus();
		codesBox?.select();
	}

	/** The box goes only on I have saved these codes, and the codes with it. */
	function savedCodes() {
		freshCodes = null;
		codesCopied = false;
		copyFailed = false;
		announced = 'Recovery codes saved.';
	}
</script>

<svelte:window onbeforeunload={warnBeforeLeaving} />

<section class="account-card glass fade-in-up two-step" style="animation-delay: 0.25s" aria-labelledby="{id}-heading">
	<h2 id="{id}-heading">🛡️ Two-step sign-in</h2>

	<!-- Each step said, as it comes (E18). -->
	<p class="sr-only" aria-live="polite">{announced}</p>

	{#if twoStep.words.lastSignIn}
		<p class="two-step-line">{twoStep.words.lastSignIn}{#if twoStep.words.wrongCodes} {twoStep.words.wrongCodes}{/if}</p>
	{/if}
	<p class="two-step-line">
		Lost a phone? Sign in with a recovery code, add your new phone here, remove the lost one, then make new recovery codes and change your password.
	</p>

	{#if sectionError}
		<div class="password-msg error" role="alert">{sectionError}</div>
	{/if}

	<h3 class="two-step-sub">Authenticators</h3>
	<ul class="factor-list">
		{#each twoStep.factors as factor (factor.id)}
			<li class="factor-row">
				<div class="factor-info">
					<span class="factor-name">{factor.label}</span>
					<span class="factor-meta">Authenticator app · added {moment(factor.createdAt)}</span>
					<span class="factor-used">{factor.lastUsedAt === null ? 'Never used' : `Last used ${moment(factor.lastUsedAt)}`}</span>
				</div>
				<button
					class="btn-ghost-sm factor-remove"
					onclick={() => (removing = factor)}
					disabled={onlyOne}
					aria-describedby={onlyOne ? removeReasonId : undefined}
				>
					Remove
				</button>
			</li>
		{/each}
	</ul>
	{#if onlyOne}
		<p class="greyed-reason" id={removeReasonId}>Add the new one first, then remove this one.</p>
	{/if}

	{#if adding === null}
		<div class="add-row">
			<label for={labelId}>Name for a new authenticator</label>
			<input id={labelId} type="text" bind:value={newLabel} placeholder="Work phone" maxlength="40" disabled={full} />
			<button
				class="btn-primary"
				onclick={() => (askingToAdd = true)}
				disabled={full || newLabel.trim() === ''}
				aria-describedby={full ? addReasonId : undefined}
			>
				Add an authenticator
			</button>
			{#if full}
				<p class="greyed-reason" id={addReasonId}>You have three: remove one first.</p>
			{/if}
		</div>
	{:else}
		<!-- The set-up, shown once: the secret is not shown again (E19). -->
		<div class="adding">
			<p class="keep-open">Keep this page open until the new phone's code is accepted.</p>
			<p>Scan the QR code with the authenticator app on the new phone, or type the secret into it.</p>
			<img class="adding-qr" src={adding.qr} alt="QR code for {adding.issuer} ({adding.account})" width="200" height="200" />
			<p class="adding-secret">Secret: <code>{adding.secret}</code></p>
			<label for={newCodeId}>Code from the new authenticator</label>
			<input
				id={newCodeId}
				type="text"
				inputmode="numeric"
				autocomplete="one-time-code"
				maxlength="7"
				placeholder="123456"
				bind:value={newCode}
				bind:this={newCodeField}
				readonly={confirmingAdd}
				onkeydown={(e) => e.key === 'Enter' && confirmAdding()}
			/>
			<div class="password-actions">
				<button class="btn-ghost" onclick={cancelAdding} disabled={confirmingAdd}>Cancel</button>
				<button class="btn-primary" onclick={confirmAdding} disabled={confirmingAdd || newCode.trim() === ''}>
					{confirmingAdd ? 'Adding…' : 'Add'}
				</button>
			</div>
		</div>
	{/if}

	<h3 class="two-step-sub">Recovery codes</h3>
	<p class="two-step-line" class:few={twoStep.codesLeft <= 3}>{twoStep.words.codesLeft}</p>
	<button class="btn-ghost" onclick={() => (askingForCodes = true)} disabled={freshCodes !== null}>Make new recovery codes</button>

	{#if freshCodes !== null}
		<div class="fresh-codes" role="region" aria-label="Your new recovery codes">
			<p class="keep-open">Save these ten codes somewhere safe now: they are not shown again. Each works once, in place of a code from your phone.</p>
			<textarea class="codes-box" readonly rows="10" bind:this={codesBox} value={freshCodes.join('\n')} aria-label="Recovery codes"></textarea>
			<div class="codes-actions">
				{#if canCopy}
					<button class="btn-ghost" onclick={copyCodes}>{codesCopied ? 'Copied' : 'Copy'}</button>
				{/if}
				{#if !canCopy || copyFailed}
					<button class="btn-ghost" onclick={downloadCodes}>Download</button>
					<button class="btn-ghost" onclick={selectCodes}>Select all</button>
				{/if}
				<button class="btn-primary" onclick={savedCodes}>I have saved these codes</button>
			</div>
		</div>
	{/if}
</section>

{#if askingToAdd}
	<ConfirmModal
		title="Add an authenticator"
		message={`Add an authenticator named “${newLabel.trim()}”? It will sign in to your account as your phone does. ${asksForPassword(codeAskedHere())}`}
		confirmText="Continue"
		confirmDanger={false}
		askPassword
		onConfirm={(proof) => startAdding(proof)}
		onCancel={() => (askingToAdd = false)}
	/>
{/if}

{#if removing}
	{@const factor = removing}
	<ConfirmModal
		title="Remove this authenticator"
		message={removeMessage(factor)}
		confirmText="Remove"
		askPassword
		onConfirm={(proof) => removeAuthenticator(factor.id, proof)}
		onCancel={() => (removing = null)}
	/>
{/if}

{#if askingForCodes}
	<ConfirmModal
		title="Make new recovery codes"
		message={`Make ten new recovery codes? The ones you have now stop working. ${asksForPassword(codeAskedHere())}`}
		confirmText="Make new codes"
		confirmDanger={false}
		askPassword
		onConfirm={(proof) => regenerateCodes(proof)}
		onCancel={() => (askingForCodes = false)}
	/>
{/if}

<style>
	.two-step-line { font-size: 0.82rem; color: var(--text-secondary); margin: 0 0 var(--space-md); }
	.two-step-line.few { color: var(--accent-amber); font-weight: 600; }
	.two-step-sub {
		font-size: 0.78rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
		color: var(--text-tertiary); margin: var(--space-lg) 0 var(--space-sm);
	}
	.factor-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
	.factor-row {
		display: flex; align-items: center; justify-content: space-between; gap: var(--space-md);
		padding: var(--space-sm) var(--space-md); border-radius: var(--radius-sm);
	}
	.factor-row:hover { background: var(--bg-surface); }
	.factor-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.factor-name { font-size: 0.85rem; font-weight: 600; color: var(--text-primary); overflow-wrap: anywhere; }
	.factor-meta { font-size: 0.68rem; color: var(--text-tertiary); }
	.factor-used { font-size: 0.75rem; color: var(--text-secondary); font-weight: 500; }
	.greyed-reason { font-size: 0.72rem; color: var(--text-tertiary); margin: var(--space-xs) 0 0; }
	.add-row { display: flex; flex-direction: column; gap: var(--space-xs); margin-top: var(--space-md); }
	.add-row label, .adding label {
		font-size: 0.72rem; font-weight: 600; color: var(--text-secondary);
		text-transform: uppercase; letter-spacing: 0.05em;
	}
	.add-row .btn-primary { width: fit-content; margin-top: var(--space-xs); }
	.adding {
		display: flex; flex-direction: column; gap: var(--space-sm); margin-top: var(--space-md);
		padding: var(--space-md); border: 1px solid var(--glass-border); border-radius: var(--radius-md);
	}
	.adding p { font-size: 0.82rem; color: var(--text-secondary); margin: 0; }
	.keep-open { color: var(--accent-amber) !important; font-weight: 600; }
	.adding-qr { background: white; padding: var(--space-sm); border-radius: var(--radius-sm); width: 200px; height: 200px; }
	.adding-secret code { font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; word-break: break-all; }
	.password-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-sm); }
	.fresh-codes {
		display: flex; flex-direction: column; gap: var(--space-sm); margin-top: var(--space-md);
		padding: var(--space-md); background: rgba(245, 158, 11, 0.08);
		border: 1px solid rgba(245, 158, 11, 0.25); border-radius: var(--radius-md);
	}
	.fresh-codes p { font-size: 0.82rem; margin: 0; }
	.codes-box { font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; resize: none; }
	.codes-actions { display: flex; flex-wrap: wrap; gap: var(--space-sm); justify-content: flex-end; }
	.password-msg {
		padding: var(--space-sm) var(--space-md); border-radius: var(--radius-sm);
		font-size: 0.82rem; font-weight: 500; margin-bottom: var(--space-md);
	}
	.password-msg.error {
		background: rgba(244, 63, 94, 0.1); border: 1px solid rgba(244, 63, 94, 0.3); color: var(--accent-rose);
	}
	.btn-ghost-sm {
		padding: 2px 10px; font-size: 0.72rem; border-radius: var(--radius-sm);
		background: transparent; color: var(--text-secondary); border: 1px solid var(--glass-border);
		cursor: pointer; font-weight: 500;
	}
	.btn-ghost-sm:disabled { opacity: 0.5; cursor: not-allowed; }
	.factor-remove { color: var(--accent-rose); flex-shrink: 0; }
	.sr-only {
		position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
		overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
	}
	.account-card { padding: var(--space-xl); border-radius: var(--radius-lg); }
	.account-card h2 {
		font-size: 1.05rem; margin-bottom: var(--space-xl);
		padding-bottom: var(--space-md); border-bottom: 1px solid var(--glass-border);
	}
	.fade-in-up { animation: fadeInUp 0.5s ease-out both; }
	@keyframes fadeInUp {
		from { opacity: 0; transform: translateY(16px); }
		to { opacity: 1; transform: translateY(0); }
	}
</style>
