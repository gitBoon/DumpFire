<!--
  CurrentPasswordField.svelte — the caller's own password and a sign-in code,
  asked for again before an action that cannot be taken back (cards 2701 and
  2770), and the server's refusal of them. One field for every dialog that
  asks (the code review's F7, 2026-11-04): the app's confirm dialog, the
  import dialog, the password dialog, Google Drive's Connect, Add User, Add
  from accounts and the Person dialog.

  The password: a visible label; `autocomplete="current-password"`, so that a
  password manager may fill it.

  The code (card 2770, D2 and D3), under it: one `<input>` in two modes, as
  `/login/verify` asks. The code from the authenticator app (the default:
  numeric keypad, `autocomplete="one-time-code"`, seven characters at most for
  `123 456`), or a recovery code (a letter keyboard, nothing filled, no
  length). The switch under it changes the mode on the same element, empties
  it and puts the focus in it, all in its own click handler so that a phone
  keeps its keyboard up. Every mounting starts in the authenticator mode (S7).
  The code is sent as typed: the server's rules read it.

  Enter in the password moves the focus to the code while the code is blank,
  whether or not `onEnter` is given; otherwise it is `onEnter`, as is Enter in
  the code.

  One refusal, in an alert after both, which both fields name with
  `aria-describedby` and mark with `aria-invalid`; and the focus put back in
  the password as a refusal comes, to type both again (the server never says
  which was wrong). For the three refusals decided before the password was
  compared (the code in neither form, its step already used, the
  authenticator not to be checked here: card 2771, D9, E9), the dialog keeps
  the password (`passwordKeptAfter`) and the focus goes to the code, the one
  thing to type again.

  A refusal that says the session is signed out (`STEP_UP_SIGNED_OUT`, its
  third wrong password, or a session that had ended) leaves nothing to type
  in: both fields and the switch are off, and the page goes to sign in
  (`$lib/signed-out.ts`, the code review's F5).

  The password and the code are the parent's, bound in `value` and `code`:
  held there alone, never in a toast or in storage, and cleared once sent
  (decision 12). `code` has no default, so a dialog that does not bind it is
  refused by `svelte-check` (card 2770, UX2).
-->
<script lang="ts">
	import { flushSync } from 'svelte';
	import { passwordKeptAfter, STEP_UP_SIGNED_OUT } from '$lib/step-up-words';

	let {
		value = $bindable(''),
		code = $bindable(),
		refusal = null,
		label = 'Your password',
		disabled = false,
		readonly = false,
		onEnter
	}: {
		/** The password typed. */
		value?: string;
		/** The code typed, from the authenticator app or a recovery code. */
		code: string;
		/** The server's refusal of the last one sent, or null. */
		refusal?: string | null;
		label?: string;
		/** Off, as when the dialog cannot be sent yet. */
		disabled?: boolean;
		/** Kept as typed while it is being sent; the switch is off. */
		readonly?: boolean;
		/** Enter in the field, as a form's would submit. */
		onEnter?: () => void;
	} = $props();

	const id = $props.id();
	const fieldId = `${id}-current-password`;
	const codeId = `${id}-current-code`;
	const refusalId = `${id}-current-password-refusal`;

	let input = $state<HTMLInputElement>();
	let codeInput = $state<HTMLInputElement>();

	/** Which code is asked for: the authenticator app's (the default) or a recovery code. */
	let recovery = $state(false);

	/** The session is signed out: nothing more can be sent from it. */
	let ended = $derived(refusal === STEP_UP_SIGNED_OUT);

	/** Put the focus in the password, as a dialog that opens on it does. */
	export function focus() {
		input?.focus();
	}

	/** The password field itself, for a dialog's own keeping of the focus (`$lib/dialog-focus`). */
	export function element(): HTMLInputElement | undefined {
		return input;
	}

	/** The code field itself. */
	export function codeElement(): HTMLInputElement | undefined {
		return codeInput;
	}

	/**
	 * The refusal keeps the password typed (card 2771, D9): decided before the
	 * password was compared, so only the code is to be typed again. Asked of
	 * `passwordKeptAfter` itself, the one list of those refusals, with a
	 * stand-in for the password sent: it gives that back exactly when the
	 * refusal keeps it.
	 */
	let keepsPassword = $derived(passwordKeptAfter(refusal, 'kept') !== '');

	// A refusal puts the focus back in the password, to type both again; or in
	// the code, where the password is kept.
	$effect(() => {
		if (refusal === null || ended) return;
		if (keepsPassword) codeInput?.focus();
		else input?.focus();
	});

	function passwordKeydown(e: KeyboardEvent) {
		if (e.key !== 'Enter') return;
		if (code.trim() === '') {
			e.preventDefault();
			codeInput?.focus();
			return;
		}
		if (!onEnter) return;
		e.preventDefault();
		onEnter();
	}

	function codeKeydown(e: KeyboardEvent) {
		if (e.key !== 'Enter' || !onEnter) return;
		e.preventDefault();
		onEnter();
	}

	/**
	 * The switch: the other mode, the field emptied and focused in this
	 * handler. Drawn at once (`flushSync`) before the focus, so the field has
	 * its new keyboard attributes as it takes it and a phone opens the right
	 * keyboard (the code review's CR1).
	 */
	function switchMode() {
		recovery = !recovery;
		code = '';
		flushSync();
		codeInput?.focus();
	}
</script>

<div class="current-password">
	<label for={fieldId}>{label}</label>
	<input
		id={fieldId}
		type="password"
		autocomplete="current-password"
		class="form-input"
		bind:value
		bind:this={input}
		disabled={disabled || ended}
		{readonly}
		aria-invalid={refusal !== null ? 'true' : undefined}
		aria-describedby={refusal !== null ? refusalId : undefined}
		onkeydown={passwordKeydown}
	/>
	<label for={codeId}>{recovery ? 'Recovery code' : 'Code from your authenticator app'}</label>
	<input
		id={codeId}
		type="text"
		class="form-input"
		inputmode={recovery ? 'text' : 'numeric'}
		autocomplete={recovery ? 'off' : 'one-time-code'}
		autocapitalize={recovery ? 'characters' : undefined}
		autocorrect={recovery ? 'off' : undefined}
		spellcheck={recovery ? 'false' : undefined}
		maxlength={recovery ? undefined : 7}
		placeholder={recovery ? 'XXXX-XXXX-XXXX-XXXX' : '123456'}
		bind:value={code}
		bind:this={codeInput}
		disabled={disabled || ended}
		{readonly}
		aria-invalid={refusal !== null ? 'true' : undefined}
		aria-describedby={refusal !== null ? refusalId : undefined}
		onkeydown={codeKeydown}
	/>
	<button type="button" class="code-switch" onclick={switchMode} disabled={disabled || readonly || ended}>
		{recovery ? 'Use a code from your authenticator app instead' : 'Use a recovery code instead'}
	</button>
	{#if refusal !== null}
		<p class="current-password-refusal" id={refusalId} role="alert">{refusal}</p>
	{/if}
</div>

<style>
	.current-password {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		text-align: left;
		margin-bottom: var(--space-md);
	}

	.current-password label {
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.current-password input {
		width: 100%;
	}

	/* The switch between the authenticator's code and a recovery code */
	.code-switch {
		align-self: flex-start;
		padding: 0;
		background: none;
		border: none;
		color: var(--accent-indigo);
		font-family: var(--font-family);
		font-size: 0.78rem;
		cursor: pointer;
		text-decoration: underline;
	}

	.code-switch:disabled {
		opacity: 0.5;
		cursor: default;
	}

	/* The server's refusal of the password or code, said beside them */
	.current-password-refusal {
		margin: 0;
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm);
		background: rgba(244, 63, 94, 0.1);
		border: 1px solid rgba(244, 63, 94, 0.3);
		color: var(--accent-rose);
		font-size: 0.8rem;
		line-height: 1.4;
		text-align: left;
	}
</style>
