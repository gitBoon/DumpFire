<!--
  A decision's markdown, drawn once the page is in the browser (card 2677,
  decision 17, F5). `renderMarkdown` cleans with DOMPurify, which needs a DOM:
  on the server it gives escaped text, and Svelte keeps an `{@html}` the
  server drew when the page hydrates, so drawn there it would stay plain text.
  So the server, and a browser with no script, draw the text itself, escaped,
  its lines kept; once mounted the block draws `renderMarkdown`'s output, and
  nothing else, through the one `{@html}`.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { renderMarkdown } from '$lib/markdown';

	let { text }: { text: string } = $props();

	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});
</script>

{#if mounted}
	<div class="markdown-block markdown-body">{@html renderMarkdown(text)}</div>
{:else}
	<div class="markdown-block plain">{text}</div>
{/if}

<style>
	.markdown-block { font-size: 1rem; line-height: 1.55; overflow-wrap: anywhere; }
	.plain { white-space: pre-wrap; }
</style>
