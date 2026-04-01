<script lang="ts">
	import { user } from '$lib/stores/user';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';

	let { onComplete }: { onComplete: () => void } = $props();

	let name = $state('');
	let selectedEmoji = $state('👤');

	function save() {
		if (!name.trim()) return;
		user.setProfile({ name: name.trim(), emoji: selectedEmoji });
		onComplete();
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay" role="dialog" aria-modal="true" aria-label="User setup">
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-content setup-modal" onclick={(e) => e.stopPropagation()} role="document">
		<div class="setup-header">
			<span class="setup-icon">🔥</span>
			<h2>Welcome to DumpFire</h2>
			<p>Pick a name so your team knows who you are.</p>
		</div>

		<div class="form-group">
			<label for="user-name">Your Name</label>
			<input
				id="user-name" type="text" placeholder="e.g. Alex, Sam, Jordan..."
				bind:value={name}
				onkeydown={(e) => e.key === 'Enter' && save()}
				autofocus
			/>
		</div>

		<div class="form-group">
			<label>Avatar</label>
			<div class="avatar-row">
				<EmojiPicker value={selectedEmoji} onSelect={(e) => (selectedEmoji = e)} />
				<span class="avatar-hint">Pick your avatar emoji</span>
			</div>
		</div>

		<button class="btn-primary save-btn" onclick={save} disabled={!name.trim()}>
			Let's go! 🚀
		</button>
	</div>
</div>

<style>
	.setup-modal { max-width: 400px; text-align: center; }

	.setup-header { margin-bottom: var(--space-xl); }
	.setup-icon { font-size: 2.5rem; display: block; margin-bottom: var(--space-md); animation: bounceIn 0.5s ease-out; }
	.setup-header h2 { font-size: 1.3rem; margin-bottom: var(--space-xs); }
	.setup-header p { font-size: 0.85rem; color: var(--text-secondary); }

	.form-group { margin-bottom: var(--space-xl); text-align: left; }
	.form-group label {
		display: block; font-size: 0.75rem; font-weight: 600;
		color: var(--text-secondary); text-transform: uppercase;
		letter-spacing: 0.05em; margin-bottom: var(--space-sm);
	}

	.avatar-row {
		display: flex; align-items: center; gap: var(--space-md);
	}
	.avatar-hint { font-size: 0.8rem; color: var(--text-tertiary); }

	.save-btn { width: 100%; padding: var(--space-md) !important; font-size: 1rem !important; }

	@keyframes bounceIn {
		0% { transform: scale(0); opacity: 0; }
		60% { transform: scale(1.2); opacity: 1; }
		100% { transform: scale(1); }
	}
</style>
