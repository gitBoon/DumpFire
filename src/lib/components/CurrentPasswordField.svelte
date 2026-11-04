<!--
  CurrentPasswordField.svelte — the caller's own password, asked for again
  before an action that cannot be taken back (card 2701), and the server's
  refusal of it. One field for every dialog that asks (the code review's F7,
  2026-11-04): the app's confirm dialog, the import dialog, the password
  dialog, Google Drive's Connect and Add User.

  A visible label; `autocomplete="current-password"`, so that a password
  manager may fill it; the refusal in an alert, which the field names with
  `aria-describedby` and marks with `aria-invalid`; and the focus put back in
  the field as a refusal comes, to type again.

  A refusal that says the session is signed out (`STEP_UP_SIGNED_OUT`, its
  third wrong password, or a session that had ended) leaves no field to type
  in: it is switched off, and the page goes to sign in (`$lib/signed-out.ts`,
  the code review's F5).

  The password is the parent's, bound in `value`: held there alone, never in
  a toast or in storage, and cleared once sent (decision 12).
-->
<script lang="ts">
	import { STEP_UP_SIGNED_OUT } from '$lib/step-up-words';

	let {
		value = $bindable(''),
		refusal = null,
		label = 'Your password',
		disabled = false,
		readonly = false,
		onEnter
	}: {
		/** The password typed. */
		value?: string;
		/** The server's refusal of the last one sent, or null. */
		refusal?: string | null;
		label?: string;
		/** Off, as when the dialog cannot be sent yet. */
		disabled?: boolean;
		/** Kept as typed while it is being sent. */
		readonly?: boolean;
		/** Enter in the field, as a form's would submit. */
		onEnter?: () => void;
	} = $props();

	const id = $props.id();
	const fieldId = `${id}-current-password`;
	const refusalId = `${id}-current-password-refusal`;

	let input = $state<HTMLInputElement>();

	/** The session is signed out: nothing more can be sent from it. */
	let ended = $derived(refusal === STEP_UP_SIGNED_OUT);

	/** Put the focus in the field, as a dialog that opens on it does. */
	export function focus() {
		input?.focus();
	}

	/** The field itself, for a dialog's own keeping of the focus (`$lib/dialog-focus`). */
	export function element(): HTMLInputElement | undefined {
		return input;
	}

	// A refusal puts the focus back in the field, to type again.
	$effect(() => {
		if (refusal !== null && !ended) input?.focus();
	});

	function keydown(e: KeyboardEvent) {
		if (e.key !== 'Enter' || !onEnter) return;
		e.preventDefault();
		onEnter();
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
		onkeydown={keydown}
	/>
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

	/* The server's refusal of the password, said beside it */
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
