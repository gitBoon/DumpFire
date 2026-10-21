<script lang="ts">
	let {
		title = 'Are you sure?',
		message = '',
		confirmText = 'Delete',
		confirmDanger = true,
		onConfirm,
		onCancel
	}: {
		title?: string;
		message?: string;
		confirmText?: string;
		confirmDanger?: boolean;
		onConfirm: () => void;
		onCancel: () => void;
	} = $props();

	// The message's id, which the dialog names as what describes it: a screen
	// reader on Cancel then reads what is being confirmed (card 2353).
	const messageId = $props.id();

	let dialog: HTMLDivElement;
	let cancelButton: HTMLButtonElement;
	let confirmButton: HTMLButtonElement;

	// Cancel takes the focus as the dialog opens, so Enter straight after it
	// cancels rather than pressing the page's button behind it again. As it
	// closes, the focus goes back to what had it, after one macrotask and only
	// if that is still in the page and the focus is then on nothing: a card
	// window the confirm opened (Cannot Complete's Open Card) focuses its
	// title in a microtask, and keeps it. An `$effect`, not `onMount`, so any
	// runtime runs it (card 2353).
	$effect(() => {
		const opener = document.activeElement;
		cancelButton.focus();
		return () => {
			setTimeout(() => {
				if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected && document.activeElement === document.body) {
					opener.focus();
				}
			}, 0);
		};
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onCancel();
		// Tab and Shift+Tab stay on the two buttons; from outside the dialog
		// (the page behind, after a click on the overlay) Tab comes back to
		// Cancel. Tab from Cancel to the confirm button is the browser's own.
		if (e.key === 'Tab') {
			const at = document.activeElement;
			if (!dialog.contains(at)) {
				e.preventDefault();
				cancelButton.focus();
			} else if (!e.shiftKey && at === confirmButton) {
				e.preventDefault();
				cancelButton.focus();
			} else if (e.shiftKey && at === cancelButton) {
				e.preventDefault();
				confirmButton.focus();
			}
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

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
		<div class="confirm-actions">
			<button class="btn-ghost" onclick={onCancel} bind:this={cancelButton}>Cancel</button>
			<button
				class={confirmDanger ? 'btn-confirm-danger' : 'btn-primary'}
				onclick={onConfirm}
				bind:this={confirmButton}
			>
				{confirmText}
			</button>
		</div>
	</div>
</div>

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
</style>
