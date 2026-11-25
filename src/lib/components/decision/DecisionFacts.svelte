<!--
  DecisionFacts.svelte — A decision's facts at a glance, in the side column
  of the decision page, its preview and the personal link's page (card 3075):
  when it closes, who decides, the reader's part and, for a consulted
  participant, the state of their response.

  It is given only the fields it reads, never the decision's id, its board or
  the page's data (card 2707's rule): what the personal link's page shows is
  what that page is already given. Its rows carry `data-fact`, never
  `data-section`, which is DecisionView's (its sections are tested in order).

  The response row is drawn for a consulted participant, and only when
  `response` is given: the preview gives none, as a preview records nothing.
  `responseHref` (the signed-in page's alone) adds a link to the form while
  the participant may respond; on the personal link's page the state is
  text, as that page links nowhere.
-->
<script lang="ts">
	import Card from '$lib/components/ui/Card.svelte';
	import CardContent from '$lib/components/ui/CardContent.svelte';
	import { PARTICIPATION_ROLE_WORDS, responseStateWords, shownMoment } from '$lib/decision-words';

	let {
		closesAt,
		deciderName,
		participant,
		response,
		responseHref
	}: {
		closesAt: string | null;
		deciderName: string | null;
		participant: { role: 'consulted' | 'informed' } | null;
		/** The reader's response, as the response row states it; none for a preview. */
		response?: { mayRespond: boolean; own: { createdAt: string } | null; earlier: { createdAt: string } | null };
		/** Where the response form is, on the signed-in page. */
		responseHref?: string;
	} = $props();
</script>

<Card data-rail="facts">
	<CardContent>
		<dl class="facts">
			{#if closesAt !== null}
				<div class="fact" data-fact="closes">
					<dt>Closes</dt>
					<dd>{shownMoment(closesAt, '')}</dd>
				</div>
			{/if}
			<div class="fact" data-fact="decider">
				<dt>Decider</dt>
				<dd>{deciderName ?? 'None named'}</dd>
			</div>
			{#if participant !== null}
				<div class="fact" data-fact="part">
					<dt>Your part</dt>
					<dd>{PARTICIPATION_ROLE_WORDS[participant.role]}</dd>
				</div>
				{#if participant.role === 'consulted' && response !== undefined}
					<div class="fact" data-fact="response">
						<dt>Your response</dt>
						<dd>
							<span>{responseStateWords(response)}</span>
							{#if responseHref !== undefined && response.mayRespond}
								<a class="to-form" href={responseHref}>Go to the form</a>
							{/if}
						</dd>
					</div>
				{/if}
			{/if}
		</dl>
	</CardContent>
</Card>

<style>
	.facts {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		margin: 0;
	}
	.fact {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}
	dt {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--ui-muted-foreground);
	}
	dd {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.25rem;
		margin: 0;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--ui-foreground);
		overflow-wrap: anywhere;
	}
	.to-form {
		border-radius: var(--ui-radius-sm);
		font-weight: 400;
		color: var(--ui-foreground);
		/* Underlined in the text colour at rest, so the link reads as one in every theme. */
		text-decoration: underline;
		text-decoration-color: currentColor;
		text-decoration-thickness: 1px;
		text-underline-offset: 3px;
	}
	.to-form:hover {
		color: var(--ui-foreground);
		text-decoration-thickness: 2px;
	}
	.to-form:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}

	@media (pointer: coarse) {
		.to-form {
			display: inline-flex;
			align-items: center;
			min-height: 2.75rem;
		}
	}
</style>
