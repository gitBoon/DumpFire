<script lang="ts">
	import { toasts } from '$lib/stores/toast';

	let items = $state<{ id: number; message: string; type: string }[]>([]);
	toasts.subscribe(v => (items = v));
</script>

{#if items.length > 0}
	<div class="toast-container">
		{#each items as toast (toast.id)}
			<div class="toast toast-{toast.type}" role="alert">
				<span class="toast-icon">
					{#if toast.type === 'success'}✓{:else if toast.type === 'error'}✕{:else if toast.type === 'warning'}⚠️{:else}ℹ{/if}
				</span>
				<span class="toast-msg">{toast.message}</span>
				<button class="toast-close" onclick={() => toasts.dismiss(toast.id)}>✕</button>
			</div>
		{/each}
	</div>
{/if}

<style>
	.toast-container {
		position: fixed; bottom: 24px; right: 24px; z-index: 200;
		display: flex; flex-direction: column-reverse; gap: 8px;
		pointer-events: none;
	}
	.toast {
		pointer-events: auto;
		display: flex; align-items: center; gap: 8px;
		padding: 10px 16px; border-radius: 10px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		box-shadow: 0 8px 24px rgba(0,0,0,0.25);
		font-size: 0.82rem; font-weight: 600;
		animation: toastIn 0.25s ease-out;
		min-width: 200px; max-width: 360px;
	}
	@keyframes toastIn {
		from { transform: translateX(40px); opacity: 0; }
		to { transform: translateX(0); opacity: 1; }
	}
	.toast-icon { font-size: 1rem; flex-shrink: 0; }
	.toast-success .toast-icon { color: #22c55e; }
	.toast-error .toast-icon { color: #ef4444; }
	.toast-info .toast-icon { color: #6366f1; }
	.toast-warning .toast-icon { color: #f59e0b; }
	.toast-warning { border-color: rgba(245, 158, 11, 0.3); }
	.toast-msg { flex: 1; }
	.toast-close {
		background: none; border: none; cursor: pointer; padding: 2px;
		color: var(--text-tertiary); font-size: 0.7rem;
		opacity: 0.5; transition: opacity 0.15s;
	}
	.toast-close:hover { opacity: 1; }
</style>
