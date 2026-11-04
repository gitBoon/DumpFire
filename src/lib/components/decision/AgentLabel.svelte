<!--
  AgentLabel.svelte — the one agent-drafted label (card 2712, folded into card
  2678, decision 20).

  `AGENT_UNREVIEWED` on what an API key drafted and no person has reviewed: a
  decision's section or option on the participant page and in the editor,
  and an agent's draft of an answer, which only the author, the decider and
  administrators see. With `reviewed`, `AGENT_REVIEWED`, on an agent's answer
  a person published, which everyone who reads the question sees. The words
  are written in `decision-words.ts` alone (tests/decision-questions.svelte.test.ts,
  case 26).

  It owns the words, from `decision-words.ts`, the `agent-label` class and its
  style. `tag` picks the element (`span` by default, `p` where the label
  stands on a line of its own), and every other attribute passes through to
  it, so that each page keeps the data attribute it is found by (`data-flag`
  on the participant page, `data-section` in the editor).
-->
<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { AGENT_REVIEWED, AGENT_UNREVIEWED } from '$lib/decision-words';

	let {
		reviewed = false,
		tag = 'span',
		...rest
	}: {
		/** An agent's answer a person published, rather than one no person has reviewed. */
		reviewed?: boolean;
		/** The element drawn. */
		tag?: 'p' | 'span';
	} & Omit<HTMLAttributes<HTMLElement>, 'class'> = $props();
</script>

<svelte:element this={tag} {...rest} class="agent-label" class:reviewed data-label={reviewed ? 'agent-reviewed' : 'agent-unreviewed'}
	>{reviewed ? AGENT_REVIEWED : AGENT_UNREVIEWED}</svelte:element
>

<style>
	.agent-label {
		display: inline-block; font-size: 0.8rem; line-height: 1.4; padding: 2px var(--space-sm); border-radius: 999px;
		background: rgba(245, 158, 11, 0.15); color: var(--accent-amber); overflow-wrap: anywhere;
	}
	/* A line of its own, on the participant page: a little room below it. */
	p.agent-label { margin: 0 0 var(--space-sm); }
	.agent-label.reviewed { background: rgba(99, 102, 241, 0.12); color: var(--accent-indigo); }
</style>
