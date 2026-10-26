<!--
  ThemeMenuItems.svelte — The theme choice as items of a header's More menu
  (card 2466: the theme picker left the dashboard's and the board's bars).

  Every theme is one radio item, its icon and its name, in a plain list: the
  code review found a grid of bare icons too small to press on a phone and
  its rows not matching the up and down arrows, and a list is both. Choosing
  one sets it as the picker does (`theme.set`), and the menu closes. The
  picker's preview on hover is not carried over: here a theme is chosen by a
  click or Enter.
-->
<script lang="ts">
	import { theme, THEMES } from '$lib/stores/theme';

	const uid = $props.id();
	const labelId = `theme-label-${uid}`;
</script>

<div class="hm-label" id={labelId}>Theme</div>
<div role="group" aria-labelledby={labelId}>
	{#each THEMES as t (t.id)}
		<button
			type="button"
			class="hm-item"
			role="menuitemradio"
			tabindex="-1"
			aria-checked={$theme === t.id}
			onclick={() => theme.set(t.id)}
		>
			<span class="hm-icon" aria-hidden="true">{t.icon}</span>
			{t.label}
			{#if $theme === t.id}<span class="hm-check" aria-hidden="true">✓</span>{/if}
		</button>
	{/each}
</div>
