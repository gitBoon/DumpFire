<script lang="ts">
	import { theme, THEMES, type ThemeName } from '$lib/stores/theme';
	import { browser } from '$app/environment';

	let open = $state(false);
	let savedTheme = $state<ThemeName>($theme);

	function previewTheme(name: ThemeName) {
		if (browser) document.documentElement.setAttribute('data-theme', name);
	}

	function restoreTheme() {
		if (browser) document.documentElement.setAttribute('data-theme', savedTheme);
	}

	function selectTheme(name: ThemeName) {
		savedTheme = name;
		theme.set(name);
		open = false;
	}

	function toggleDropdown() {
		if (!open) savedTheme = $theme;
		open = !open;
	}

	function handleClickOutside(e: MouseEvent) {
		const el = (e.target as HTMLElement).closest('.theme-picker');
		if (!el) { restoreTheme(); open = false; }
	}

	$effect(() => {
		if (open && browser) {
			document.addEventListener('click', handleClickOutside, true);
			return () => document.removeEventListener('click', handleClickOutside, true);
		}
	});

	const currentTheme = $derived(THEMES.find(t => t.id === $theme));
</script>

<div class="theme-picker">
	<button class="theme-trigger btn-ghost" onclick={toggleDropdown} title="Change theme">
		<span class="theme-trigger-icon">{currentTheme?.icon || '☀️'}</span>
		<svg class="theme-chevron" class:open width="10" height="10" viewBox="0 0 10 10" fill="none">
			<path d="M2 4l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
		</svg>
	</button>

	{#if open}
	<div class="theme-dropdown">
		{#each THEMES as t (t.id)}
			<button
				class="theme-option"
				class:active={$theme === t.id}
				onmouseenter={() => previewTheme(t.id)}
				onmouseleave={restoreTheme}
				onclick={() => selectTheme(t.id)}
			>
				<span class="theme-option-icon">{t.icon}</span>
				<span class="theme-option-label">{t.label}</span>
				{#if $theme === t.id}
					<svg class="theme-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
						<path d="M3 7l3 3 5-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				{/if}
			</button>
		{/each}
	</div>
	{/if}
</div>

<style>
	.theme-picker { position: relative; }
	.theme-trigger {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 6px 10px; border-radius: var(--radius-sm);
		font-size: 0.8rem; font-weight: 500;
	}
	.theme-trigger-icon { font-size: 1rem; line-height: 1; }
	.theme-chevron {
		color: var(--text-tertiary);
		transition: transform var(--duration-fast) var(--ease-out);
	}
	.theme-chevron.open { transform: rotate(180deg); }

	.theme-dropdown {
		position: absolute; top: calc(100% + 6px); right: 0;
		min-width: 180px; padding: 6px;
		max-height: 360px; overflow-y: auto;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
		z-index: 200; animation: fadeIn var(--duration-fast) var(--ease-out);
	}

	.theme-option {
		display: flex; align-items: center; gap: 10px; width: 100%;
		padding: 8px 12px; border: none; background: transparent;
		color: var(--text-secondary); font: inherit; font-size: 0.82rem;
		border-radius: var(--radius-sm); cursor: pointer;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.theme-option:hover {
		background: var(--glass-hover); color: var(--text-primary);
	}
	.theme-option.active {
		color: var(--accent-indigo); font-weight: 600;
	}
	.theme-option-icon { font-size: 1.1rem; width: 24px; text-align: center; }
	.theme-option-label { flex: 1; text-align: left; }
	.theme-check { color: var(--accent-indigo); flex-shrink: 0; }

	@keyframes fadeIn {
		from { opacity: 0; transform: translateY(-4px); }
		to { opacity: 1; transform: translateY(0); }
	}
</style>
