<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { keepTab, takeFocus } from '$lib/dialog-focus';
	import { isStepUpMissing, NO_ANSWER_TRY_AGAIN, NO_PROOF, passwordKeptAfter, proofTyped, STEP_UP_SIGNED_OUT, type StepUpProof } from '$lib/step-up-words';
	import CurrentPasswordField from './CurrentPasswordField.svelte';
	import Button from './ui/Button.svelte';
	import Dialog from './ui/Dialog.svelte';

	let {
		title = 'Are you sure?',
		message = '',
		confirmText = 'Delete',
		confirmDanger = true,
		askPassword = false,
		kit = false,
		onConfirm,
		onCancel
	}: {
		title?: string;
		message?: string;
		confirmText?: string;
		confirmDanger?: boolean;
		/**
		 * Ask for the caller's own password and a sign-in code, for an action
		 * that asks for them again (cards 2701 and 2770): labelled fields,
		 * Confirm off until both are typed, and Enter confirms once they are.
		 */
		askPassword?: boolean;
		/**
		 * The UI kit's look (card 3078), for the pages on the kit alone: the
		 * kit's dialog frame (`ui/Dialog.svelte`), its buttons and fields, the
		 * keyboard held by that frame's `holdFocus` on the same rules. Off (the
		 * board view and the pages not yet on the kit), the dialog is drawn and
		 * behaves exactly as before. Set once, as the dialog is drawn.
		 */
		kit?: boolean;
		/**
		 * Confirm pressed, handed the proof typed (`NO_PROOF` with no field). It may
		 * be awaited (card 2701, D6): while it runs both buttons are off and
		 * Confirm says it is working, so one press sends one request. Text given
		 * back is the server's refusal, and the dialog stays open and shows it,
		 * both fields cleared, the password focused; for the refusals decided
		 * before the password was compared (`passwordKeptAfter`, card 2771) the
		 * password is put back and the code focused. Anything else, and the
		 * caller closes the dialog. One that throws, or is rejected, is said as
		 * no answer.
		 */
		onConfirm: (proof: StepUpProof) => void | Promise<string | null | void>;
		onCancel: () => void;
	} = $props();

	// The message's id, which the dialog names as what describes it: a screen
	// reader on Cancel then reads what is being confirmed (card 2353).
	const messageId = $props.id();
	const refusalId = `${messageId}-refusal`;

	// Bound in the default look alone, now inside its `{#if}` (card 3078), and read only by its own focus rules.
	// svelte-ignore non_reactive_update
	let dialog: HTMLDivElement;
	// svelte-ignore non_reactive_update
	let cancelButton: HTMLButtonElement;
	let passwordField = $state<ReturnType<typeof CurrentPasswordField>>();

	/**
	 * The password typed: held here alone, never in a toast or in storage, and
	 * cleared once sent, on a refusal and as the dialog goes (card 2701,
	 * decision 12).
	 */
	let password = $state('');
	/** The code typed beside it (card 2770), held and cleared as the password is. */
	let code = $state('');
	/**
	 * The server asked for the password where the dialog showed no field: a
	 * column whose cards are all archived, which the page cannot see (decision
	 * 18). The field is shown from then on.
	 */
	let toldToAsk = $state(false);
	let asking = $derived(askPassword || toldToAsk);
	/** The server's refusal of the last Confirm, shown in the dialog until the next. */
	let refusal = $state<string | null>(null);
	/** Confirm's answer is awaited: both buttons are off, so one press sends one request. */
	let waiting = $state(false);
	/**
	 * The session was signed out by the step-up (the code review's F5): nothing
	 * more can be sent from it, so Confirm is off and no field is left to type
	 * in, and the page goes to sign in (`$lib/signed-out.ts`).
	 */
	let ended = $derived(refusal === STEP_UP_SIGNED_OUT);
	/**
	 * Both the password and a code that is not blank are typed (card 2770, S1);
	 * the password alone where the layout says no code is asked (card 3064,
	 * R7), as `CurrentPasswordField` then shows no code field. Asked where the
	 * page's data cannot be read.
	 */
	let typed = $derived.by(() => {
		try {
			return proofTyped(password, code, page.data.codeAsked);
		} catch {
			return proofTyped(password, code);
		}
	});

	// Cancel takes the focus as the dialog opens, so Enter straight after it
	// cancels rather than pressing the page's button behind it again; or the
	// password field, for a dialog that asks for one, where Enter does nothing
	// until something is typed. As it closes, the focus goes back to what had
	// it, after one macrotask and only if that is still in the page and the
	// focus is then on nothing: a card window the confirm opened (Cannot
	// Complete's Open Card) focuses its title in a microtask, and keeps it. An
	// `$effect`, not `onMount`, so any runtime runs it (card 2353). The rules
	// are `$lib/dialog-focus`'s, which the admin page's own dialogs share (card
	// 2362).
	// In the kit's look the frame holds the focus on these rules instead (card
	// 3078): this effect and the keys below stand aside.
	$effect(() => {
		if (kit) return;
		return takeFocus(untrack(() => (askPassword ? passwordField?.element() : undefined)) ?? cancelButton);
	});

	function handleKeydown(e: KeyboardEvent) {
		if (kit) return;
		if (e.key === 'Escape' && !waiting) onCancel();
		// Tab and Shift+Tab stay on the dialog's own stops; from outside the
		// dialog (the page behind, after a click on the overlay) Tab comes back
		// to Cancel, or to the password field where there is one. Tab between
		// them is the browser's own.
		const field = asking && !ended ? passwordField?.element() : undefined;
		keepTab(e, dialog, field ?? cancelButton);
	}

	/** Cancel: the password and code typed go with the dialog. */
	function cancel() {
		password = '';
		code = '';
		onCancel();
	}

	/**
	 * Confirm: the caller's `onConfirm`, handed the proof, both fields cleared
	 * here as it goes. Nothing is sent while either is blank, whatever key or
	 * button asked (card 2770, S1). A refusal it gives back is shown, and the focus put in
	 * the field to type again (`CurrentPasswordField`), the password sent put
	 * back where the refusal was decided before it was compared (card 2771,
	 * D9: `passwordKeptAfter`; the code is always typed again); a 400 asking for a
	 * password the dialog did not ask for shows the field. An `onConfirm` that
	 * throws, or whose promise is rejected, is said as no answer (the code
	 * review's F9), the field focused to try again.
	 */
	async function confirm() {
		if (waiting || ended || (asking && !typed)) return;
		const proof: StepUpProof = asking ? { currentPassword: password, currentCode: code } : NO_PROOF;
		password = '';
		code = '';
		refusal = null;
		waiting = true;
		let answer: string | null | void;
		try {
			answer = await onConfirm(proof);
		} catch {
			answer = NO_ANSWER_TRY_AGAIN;
		} finally {
			waiting = false;
		}
		if (typeof answer !== 'string') return;
		refusal = answer;
		password = passwordKeptAfter(answer, proof.currentPassword);
		// Either words of no password (card 3064, F25): the server says what it asks of the account. The field, shown
		// from then on, reads the page again where the server asks a code the page did not know of (its code review,
		// CS-L5), which draws the code field and makes Confirm wait for a code.
		if (isStepUpMissing(answer)) toldToAsk = true;
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if kit}
	<!-- The kit's look (card 3078): the frame holds the focus on the rules above, Escape off while the answer is awaited. -->
	{#snippet describedBy()}
		<p class="confirm-message kit" id={messageId}>{message}</p>
	{/snippet}
	{#snippet actions()}
		<Button variant="outline" class="confirm-cancel" onclick={cancel} disabled={waiting}>Cancel</Button>
		<Button
			variant={confirmDanger ? 'destructive' : 'default'}
			class={confirmDanger ? 'btn-confirm-danger' : undefined}
			onclick={confirm}
			disabled={waiting || ended || (asking && !typed)}
			aria-busy={waiting ? 'true' : undefined}
		>
			{waiting ? 'Working…' : confirmText}
		</Button>
	{/snippet}
	<Dialog
		{title}
		titleLevel={3}
		size="sm"
		class="confirm-modal"
		footerClass="confirm-actions"
		aria-label={title}
		aria-describedby={message ? messageId : undefined}
		description={message ? describedBy : undefined}
		initialFocus={asking && !ended ? 'input[autocomplete="current-password"]' : '.confirm-cancel'}
		onEscape={waiting ? undefined : onCancel}
		footer={actions}
	>
		{#if asking}
			<!-- The caller's own password and a sign-in code (cards 2701, 2770), with the server's refusal: a password manager may fill it. -->
			<CurrentPasswordField kit bind:value={password} bind:code bind:this={passwordField} {refusal} readonly={waiting} onEnter={confirm} />
		{:else if refusal}
			<p class="confirm-refusal kit" id={refusalId} role="alert">{refusal}</p>
		{/if}
	</Dialog>
{:else}
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay" role="dialog" aria-modal="true" aria-label={title} aria-describedby={message ? messageId : undefined}>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="confirm-modal" onclick={(e) => e.stopPropagation()} role="document" bind:this={dialog}>
		<div class="confirm-icon" class:danger={confirmDanger}>
			{#if confirmDanger}
				<svg width="28" height="28" viewBox="0 0 24 24" fill="none">
					<path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			{:else}
				<svg width="28" height="28" viewBox="0 0 24 24" fill="none">
					<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
					<path d="M12 8v4m0 4h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
				</svg>
			{/if}
		</div>
		<h3>{title}</h3>
		{#if message}
			<p class="confirm-message" id={messageId}>{message}</p>
		{/if}
		{#if asking}
			<!-- The caller's own password and a sign-in code (cards 2701, 2770), with the server's refusal: a password manager may fill it. -->
			<CurrentPasswordField bind:value={password} bind:code bind:this={passwordField} {refusal} readonly={waiting} onEnter={confirm} />
		{:else if refusal}
			<p class="confirm-refusal" id={refusalId} role="alert">{refusal}</p>
		{/if}
		<div class="confirm-actions">
			<button class="btn-ghost" onclick={cancel} disabled={waiting} bind:this={cancelButton}>Cancel</button>
			<button
				class={confirmDanger ? 'btn-confirm-danger' : 'btn-primary'}
				onclick={confirm}
				disabled={waiting || ended || (asking && !typed)}
				aria-busy={waiting ? 'true' : undefined}
			>
				{waiting ? 'Working…' : confirmText}
			</button>
		</div>
	</div>
</div>
{/if}

<style>
	.confirm-modal {
		background: var(--bg-surface);
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-xl);
		padding: var(--space-2xl);
		width: 90%;
		max-width: 400px;
		text-align: center;
		box-shadow: var(--shadow-lg);
		animation: scaleIn var(--duration-normal) var(--ease-spring);
	}

	.confirm-icon {
		width: 56px;
		height: 56px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		margin: 0 auto var(--space-lg);
		background: rgba(99, 102, 241, 0.1);
		color: var(--accent-indigo);
	}

	.confirm-icon.danger {
		background: rgba(244, 63, 94, 0.1);
		color: var(--accent-rose);
	}

	h3 {
		margin-bottom: var(--space-sm);
	}

	.confirm-message {
		color: var(--text-secondary);
		font-size: 0.875rem;
		line-height: 1.5;
		margin-bottom: var(--space-xl);
	}

	/* A refusal of a Confirm that asked for no password, said in the dialog */
	.confirm-refusal {
		margin-top: var(--space-md);
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm);
		background: rgba(244, 63, 94, 0.1);
		border: 1px solid rgba(244, 63, 94, 0.3);
		color: var(--accent-rose);
		font-size: 0.8rem;
		line-height: 1.4;
		text-align: left;
	}

	.confirm-actions {
		display: flex;
		gap: var(--space-md);
		justify-content: center;
		margin-top: var(--space-xl);
	}

	.btn-confirm-danger {
		display: inline-flex;
		align-items: center;
		gap: var(--space-sm);
		padding: var(--space-md) var(--space-xl);
		background: linear-gradient(135deg, #e11d48, #f43f5e);
		color: white;
		border-radius: var(--radius-md);
		font-weight: 600;
		font-size: 0.875rem;
		box-shadow: 0 4px 12px rgba(244, 63, 94, 0.3);
		font-family: var(--font-family);
		cursor: pointer;
		border: none;
		transition: all var(--duration-normal) var(--ease-out);
	}

	.btn-confirm-danger:hover {
		transform: translateY(-1px);
		box-shadow: 0 8px 20px rgba(244, 63, 94, 0.4);
	}

	@keyframes scaleIn {
		from { opacity: 0; transform: scale(0.95); }
		to { opacity: 1; transform: scale(1); }
	}

	/*
	 * The kit's look (card 3078): only on elements marked `kit`, which the
	 * default look never draws, so none of these reaches it. The frame draws
	 * the message's place and size; these set what the rules above would.
	 */
	.confirm-message.kit {
		margin: 0.375rem 0 0;
		color: var(--ui-muted-foreground);
		font-size: 0.875rem;
		line-height: 1.5;
	}

	/* The refusal as the kit's notice: a red edge, the words in the text colour. */
	.confirm-refusal.kit {
		margin: 0;
		padding: 0 0 0 0.625rem;
		border: 0;
		border-left: 3px solid var(--ui-destructive);
		border-radius: 0;
		background: none;
		color: var(--ui-foreground);
		font-size: 0.8125rem;
		line-height: 1.45;
	}
</style>
