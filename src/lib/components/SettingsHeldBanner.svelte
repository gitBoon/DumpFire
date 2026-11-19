<!--
  SettingsHeldBanner.svelte — the superadmin's banner on the admin pages while
  any setting is held for their review (card 2922, its plan's R7).

  Drawn from what the page gives it: the settings held, as the page's load
  read them (the people and ISO pages) or as the list on the admin page read
  them, and whether the reader is the superadmin, who alone keeps or removes
  one. One line, linking to the list on the admin page; nothing otherwise.
-->
<script lang="ts">
	import { heldIsPlural, heldSettingName, type HeldSetting } from '$lib/settings-held';

	let {
		held = [],
		superadmin = false
	}: {
		/** The settings held for review: their kind and name are what the line says. */
		held?: Pick<HeldSetting, 'kind' | 'name'>[];
		/** Whether the reader is the superadmin. */
		superadmin?: boolean;
	} = $props();

	let mayRelease = $derived(superadmin);
	/** One setting held: the line names it, in its own number (the code review's C11). */
	let one = $derived(held.length === 1);
	/** Whether what is held is spoken of as one thing: one setting that is not the mail settings. */
	let singular = $derived(one && !heldIsPlural(held[0]));
</script>

{#if mayRelease && held.length > 0}
	<div class="settings-held-banner" role="status">
		⏸️ {one ? `${heldSettingName(held[0])} ${singular ? 'is' : 'are'}` : `${held.length} settings are`} held for your
		review: nothing is sent to {singular ? 'it' : 'them'} until you keep or remove {singular ? 'it' : 'them'}.
		<a href="/admin#settings-held">Review {singular ? 'it' : 'them'}</a>
	</div>
{/if}

<style>
	.settings-held-banner {
		margin: var(--space-sm) auto;
		max-width: 1100px;
		padding: var(--space-sm) var(--space-md);
		border-radius: 8px;
		background: color-mix(in srgb, var(--accent-amber) 15%, transparent);
		color: var(--text-primary);
		font-size: 0.8rem;
	}
</style>
