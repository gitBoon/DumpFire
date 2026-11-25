<script lang="ts">
	/**
	 * A decision previewed as a participant (card 2697, decision 18, Q4 to Q7,
	 * plan 4.2): the "Preview as" bar, then the working copy in 2677's
	 * `DecisionView` with `mode: 'preview'`, so that the preview cannot differ
	 * from what participants see.
	 *
	 * The bar shows the decision as one of its live participants (by name,
	 * role and groups, never an address), or as a generic participant of a
	 * role in a group; each choice reads the page again with `?as=`, or with
	 * `?role=` and `?group=`. The banner says nothing is recorded. A consulted
	 * participant is shown the response form, switched off: it sends nothing.
	 * An informed one is shown none. Card 2683: the survey questions the next
	 * version would ask, in the form, its inputs switched off, or alone, as
	 * `DecisionView` draws them; never a response or an answer. No seen watch is armed, and the page
	 * fetches and posts nothing of its own.
	 *
	 * Card 3075: on the kit's shell, full width; the "Preview as" choosers and
	 * the facts of the person previewed (`DecisionFacts`, with no response row)
	 * in a side column on the right.
	 */
	import type { PageData } from './$types';
	import { goto } from '$app/navigation';
	import PageShell from '$lib/components/ui/PageShell.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import CardContent from '$lib/components/ui/CardContent.svelte';
	import DecisionFacts from '$lib/components/decision/DecisionFacts.svelte';
	import DecisionView from '$lib/components/decision/DecisionView.svelte';
	import ResponseForm from '$lib/components/decision/ResponseForm.svelte';

	let { data }: { data: PageData } = $props();

	/** Who the banner names: the participant, or the generic one in words. */
	const whom = $derived.by(() => {
		const p = data.previewing;
		if (p.kind === 'participant') return p.name;
		const role = p.role === 'informed' ? 'an informed participant' : 'a consulted participant';
		return p.groupName === null ? role : `${role} in ${p.groupName}`;
	});

	const asValue = $derived(data.previewing.kind === 'participant' ? String(data.previewing.participantId) : '');
	const roleValue = $derived(data.previewing.role);
	const groupValue = $derived(data.previewing.kind === 'generic' && data.previewing.groupId !== null ? String(data.previewing.groupId) : '');

	/** Read the page again as the participant chosen, or as the generic one the role and group make. */
	function previewAs(participantId: string) {
		if (participantId !== '') void goto(`/decisions/${data.decision.id}/preview?as=${encodeURIComponent(participantId)}`, { keepFocus: true });
		else void goto(`/decisions/${data.decision.id}/preview`, { keepFocus: true });
	}
	function previewGeneric(role: string, groupId: string) {
		const query = new URLSearchParams({ role });
		if (groupId !== '') query.set('group', groupId);
		void goto(`/decisions/${data.decision.id}/preview?${query}`, { keepFocus: true });
	}
</script>

<svelte:head>
	<title>Preview: {data.decision.title} — DumpFire</title>
</svelte:head>

{#snippet banner()}
	<p class="banner-line preview" data-banner="preview">Preview: this is what {whom} will see. Nothing is recorded.</p>
	{#if data.previewing.kind === 'participant' && data.previewing.groupNames.length > 0}
		<p class="banner-note">In {data.previewing.groupNames.join(', ')}.</p>
	{/if}
{/snippet}

{#snippet response()}
	<ResponseForm voteMode={data.decision.voteMode} options={data.options} surveyQuestions={data.surveyQuestions} deciderName={data.decision.deciderName} disabled />
{/snippet}

{#snippet crumbs()}
	<nav class="crumb" aria-label="Where this is">
		{#if data.decision.boardName !== null}<span>{data.decision.boardName}</span><span aria-hidden="true">›</span>{/if}
		<a href="/decisions/{data.decision.id}/edit">Back to the editor</a>
	</nav>
{/snippet}

{#snippet settings()}
	<div class="rail-stack">
		<Card>
			<CardContent>
				<section class="preview-bar" aria-label="Preview as">
					<label class="bar-field">
						<span class="ui-label">Preview as</span>
						<select class="ui-select" value={asValue} onchange={(e) => previewAs(e.currentTarget.value)} data-select="participant">
							<option value="">A participant by role and group</option>
							{#each data.participants as p (p.id)}
								<option value={String(p.id)}>{p.name} ({p.role}{p.groups.length > 0 ? `, ${p.groups.join(', ')}` : ''})</option>
							{/each}
						</select>
					</label>
					{#if data.previewing.kind === 'generic'}
						<span class="bar-or ui-hint">or</span>
						<label class="bar-field">
							<span class="ui-label">Role</span>
							<select class="ui-select" value={roleValue} onchange={(e) => previewGeneric(e.currentTarget.value, groupValue)} data-select="role">
								<option value="consulted">Consulted</option>
								<option value="informed">Informed</option>
							</select>
						</label>
						<label class="bar-field">
							<span class="ui-label">in</span>
							<select class="ui-select" value={groupValue} onchange={(e) => previewGeneric(roleValue, e.currentTarget.value)} data-select="group">
								<option value="">No group</option>
								{#each data.groups as group (group.id)}
									<option value={String(group.id)}>{group.name}</option>
								{/each}
							</select>
						</label>
					{/if}
				</section>
			</CardContent>
		</Card>
		<!-- The person previewed: no response row, as a preview records nothing. -->
		<DecisionFacts closesAt={data.decision.closesAt} deciderName={data.decision.deciderName} participant={data.participant} />
	</div>
{/snippet}

<!-- Card 3075: full width, the preview's settings and the facts of the person previewed in a side column on the right. -->
<PageShell width="full" {crumbs} rail={settings} railLabel="Preview settings" railPosition="end">
	<DecisionView
		decision={data.decision}
		content={data.content}
		options={data.options}
		surveyQuestions={data.surveyQuestions}
		audiences={data.audiences}
		participant={data.participant}
		mode="preview"
		{banner}
		{response}
	/>
</PageShell>

<style>
	.crumb {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
	}
	.crumb a {
		border-radius: var(--ui-radius-sm);
		color: var(--ui-muted-foreground);
		text-decoration: none;
	}
	.crumb a:hover {
		color: var(--ui-foreground);
	}
	.crumb a:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}

	.rail-stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}
	.preview-bar {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}
	.bar-field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}
	.bar-or {
		margin-bottom: calc(-1 * var(--space-sm));
	}
	.banner-line {
		margin: 0 0 var(--space-xs);
		font-weight: 600;
		color: var(--ui-foreground);
	}
	.banner-note {
		margin: 0;
		font-size: 0.875rem;
		color: var(--ui-muted-foreground);
	}
</style>
