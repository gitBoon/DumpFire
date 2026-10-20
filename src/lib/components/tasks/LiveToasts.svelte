<!--
  LiveToasts.svelte — All Tasks' live notices: a toast for each card
  someone creates or moves, the five newest, each for 5 seconds; and the
  fireworks for each card completed, one after another (card 2281, slice
  C3a-2: moved from src/routes/all/+page.svelte).

  The page's live stream hands each event in: `addLiveToast` and
  `celebrate` are exported, and the page reaches them with `bind:this`.
  Drawn by the page where they were, last.
-->
<script lang="ts">
	import FireworksCelebration from '$lib/components/board/FireworksCelebration.svelte';
	import { playCompleteSound } from '$lib/utils/sounds';

	// ─── Fireworks Celebration ────────────────────────────────────────────
	let showFireworks = $state(false);
	let celebrateCardTitle = $state('');
	let celebrateUserName = $state('');
	let celebrateUserEmoji = $state('');
	let celebrateXpGained = $state(0);

	type CelebrationItem = { cardTitle: string; userName: string; userEmoji: string; xpGained: number };
	let celebrationQueue: CelebrationItem[] = [];
	let celebrationPlaying = false;

	function playNextCelebration() {
		const next = celebrationQueue.shift();
		if (!next) {
			celebrationPlaying = false;
			return;
		}
		celebrationPlaying = true;
		// Brief reset to re-trigger animation if already showing
		showFireworks = false;
		requestAnimationFrame(() => {
			celebrateCardTitle = next.cardTitle;
			celebrateUserName = next.userName;
			celebrateUserEmoji = next.userEmoji;
			celebrateXpGained = next.xpGained;
			showFireworks = true;
			playCompleteSound();
			setTimeout(() => {
				showFireworks = false;
				// Always try to drain the queue
				setTimeout(playNextCelebration, 300);
			}, 3000);
		});
	}

	/** Queues a celebration the page's live stream handed in; each shows in turn. */
	export function celebrate(item: CelebrationItem) {
		celebrationQueue.push(item);
		if (!celebrationPlaying) playNextCelebration();
	}

	// ─── Live Activity Toast ──────────────────────────────────────────────
	type LiveToast = {
		id: number;
		type: 'created' | 'moved';
		cardTitle: string;
		userName: string;
		userEmoji: string;
		fromColumn?: string;
		toColumn?: string;
	};
	let liveToasts = $state<LiveToast[]>([]);
	let toastCounter = 0;

	export function addLiveToast(toast: Omit<LiveToast, 'id'>) {
		const id = ++toastCounter;
		liveToasts = [{ ...toast, id }, ...liveToasts].slice(0, 5);
		setTimeout(() => {
			liveToasts = liveToasts.filter(t => t.id !== id);
		}, 5000);
	}
</script>

<!-- Fireworks celebration -->
{#if showFireworks}
	<FireworksCelebration
		cardTitle={celebrateCardTitle}
		userName={celebrateUserName}
		userEmoji={celebrateUserEmoji}
		xpGained={celebrateXpGained}
	/>
{/if}

{#if liveToasts.length > 0}
	<div class="live-toast-container">
		{#each liveToasts as toast (toast.id)}
			<div class="live-toast" class:live-toast-created={toast.type === 'created'} class:live-toast-moved={toast.type === 'moved'}>
				<div class="live-toast-glow"></div>
				<div class="live-toast-inner">
					<span class="live-toast-emoji">{toast.userEmoji}</span>
					<div class="live-toast-body">
						<span class="live-toast-user">{toast.userName}</span>
						{#if toast.type === 'created'}
							<span class="live-toast-action">created</span>
							<span class="live-toast-card">"{toast.cardTitle}"</span>
						{:else}
							<span class="live-toast-action">moved</span>
							<span class="live-toast-card">"{toast.cardTitle}"</span>
							{#if toast.fromColumn && toast.toColumn}
								<span class="live-toast-cols">{toast.fromColumn} → {toast.toColumn}</span>
							{/if}
						{/if}
					</div>
					<span class="live-toast-icon">{toast.type === 'created' ? '✨' : '➡️'}</span>
				</div>
			</div>
		{/each}
	</div>
{/if}

<style>
	/* ── Live Activity Toasts ─────────────────────────── */
	.live-toast-container {
		position: fixed;
		top: var(--space-xl);
		left: 50%;
		transform: translateX(-50%);
		z-index: 9999;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		pointer-events: none;
		max-width: 420px;
		width: 90%;
	}

	.live-toast {
		position: relative;
		border-radius: var(--radius-lg);
		overflow: hidden;
		animation: toastSlideIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
		pointer-events: auto;
	}

	.live-toast-glow {
		position: absolute;
		inset: 0;
		border-radius: var(--radius-lg);
		opacity: 0.4;
		animation: toastGlow 2s ease-in-out infinite;
	}

	.live-toast-created .live-toast-glow {
		box-shadow: 0 0 20px rgba(16, 185, 129, 0.3), 0 0 40px rgba(16, 185, 129, 0.15);
	}

	.live-toast-moved .live-toast-glow {
		box-shadow: 0 0 20px rgba(99, 102, 241, 0.3), 0 0 40px rgba(99, 102, 241, 0.15);
	}

	.live-toast-inner {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-md);
		padding: var(--space-md) var(--space-lg);
		background: var(--bg-card);
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg);
		backdrop-filter: blur(16px);
		-webkit-backdrop-filter: blur(16px);
	}

	.live-toast-created .live-toast-inner {
		border-left: 3px solid #10b981;
		background: linear-gradient(135deg, var(--bg-card), rgba(16, 185, 129, 0.04));
	}

	.live-toast-moved .live-toast-inner {
		border-left: 3px solid #6366f1;
		background: linear-gradient(135deg, var(--bg-card), rgba(99, 102, 241, 0.04));
	}

	.live-toast-emoji {
		font-size: 1.5rem;
		flex-shrink: 0;
		animation: toastBounce 0.6s ease-out;
	}

	.live-toast-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px;
		font-size: 0.82rem;
		line-height: 1.4;
	}

	.live-toast-user {
		font-weight: 700;
		color: var(--text-primary);
	}

	.live-toast-action {
		color: var(--text-secondary);
		font-weight: 500;
	}

	.live-toast-card {
		font-weight: 600;
		color: var(--text-primary);
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.live-toast-cols {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-size: 0.7rem;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: var(--radius-sm);
		background: rgba(99, 102, 241, 0.1);
		color: var(--accent-indigo);
		white-space: nowrap;
	}

	.live-toast-icon {
		font-size: 1.1rem;
		flex-shrink: 0;
		animation: toastIconPulse 1.5s ease-in-out infinite;
	}

	@keyframes toastSlideIn {
		from {
			opacity: 0;
			transform: translateY(-30px) scale(0.9);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	@keyframes toastGlow {
		0%, 100% { opacity: 0.3; }
		50% { opacity: 0.6; }
	}

	@keyframes toastBounce {
		0% { transform: scale(0.5); }
		50% { transform: scale(1.2); }
		100% { transform: scale(1); }
	}

	@keyframes toastIconPulse {
		0%, 100% { transform: scale(1); }
		50% { transform: scale(1.15); }
	}
</style>
