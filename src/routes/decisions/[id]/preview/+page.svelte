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
	 * An informed one is shown none. No seen watch is armed, and the page
	 * fetches and posts nothing of its own.
	 */
	import type { PageData } from './$types';
	import { goto } from '$app/navigation';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';
	import DecisionView from '$lib/components/decision/DecisionView.svelte';
	import ResponseForm from '$lib/components/decision/ResponseForm.svelte';
	import { theme, themeIcon } from '$lib/stores/theme';

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
	<ResponseForm voteMode={data.decision.voteMode} options={data.options} disabled />
{/snippet}

<div class="decision-page">
	<header class="decision-header glass">
		<div class="decision-header-inner">
			<a href="/" class="header-logo" title="Back to DumpFire">
				<span class="logo-fire">🔥</span>
				<span class="logo-text">DumpFire</span>
			</a>
			<nav class="crumb" aria-label="Where this is">
				{#if data.decision.boardName !== null}<span>{data.decision.boardName}</span><span aria-hidden="true">›</span>{/if}
				<a href="/decisions/{data.decision.id}/edit">Back to the editor</a>
			</nav>
			<HeaderMenu label="Theme" triggerClass="btn-ghost" triggerTitle="Change theme">
				{#snippet trigger()}<span aria-hidden="true">{themeIcon($theme)}</span>{/snippet}
				<ThemeMenuItems heading={false} />
			</HeaderMenu>
		</div>
	</header>

	<main class="decision-content">
		<section class="preview-bar glass" aria-label="Preview as">
			<label class="bar-field">
				<span>Preview as</span>
				<select class="form-input" value={asValue} onchange={(e) => previewAs(e.currentTarget.value)} data-select="participant">
					<option value="">A participant by role and group</option>
					{#each data.participants as p (p.id)}
						<option value={String(p.id)}>{p.name} ({p.role}{p.groups.length > 0 ? `, ${p.groups.join(', ')}` : ''})</option>
					{/each}
				</select>
			</label>
			{#if data.previewing.kind === 'generic'}
				<span class="bar-or">or</span>
				<label class="bar-field">
					<span>Role</span>
					<select class="form-input" value={roleValue} onchange={(e) => previewGeneric(e.currentTarget.value, groupValue)} data-select="role">
						<option value="consulted">Consulted</option>
						<option value="informed">Informed</option>
					</select>
				</label>
				<label class="bar-field">
					<span>in</span>
					<select class="form-input" value={groupValue} onchange={(e) => previewGeneric(roleValue, e.currentTarget.value)} data-select="group">
						<option value="">No group</option>
						{#each data.groups as group (group.id)}
							<option value={String(group.id)}>{group.name}</option>
						{/each}
					</select>
				</label>
			{/if}
		</section>

		<DecisionView
			decision={data.decision}
			content={data.content}
			options={data.options}
			audiences={data.audiences}
			participant={data.participant}
			mode="preview"
			{banner}
			{response}
		/>
	</main>
</div>

<style>
	.decision-page { min-height: 100vh; padding-top: 64px; }
	.decision-header {
		position: fixed; top: 0; left: 0; right: 0; z-index: 200;
		height: 64px; border-bottom: 1px solid var(--glass-border);
		backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
	}
	.decision-header-inner {
		max-width: 1400px; margin: 0 auto; height: 100%;
		display: flex; align-items: center; gap: var(--space-md);
		padding: 0 var(--space-xl);
	}
	.header-logo {
		display: flex; align-items: center; gap: var(--space-sm);
		text-decoration: none; color: var(--text-primary);
		font-weight: 700; font-size: 1.1rem;
	}
	.logo-fire { font-size: 1.4rem; }
	.crumb { flex: 1; display: flex; align-items: center; gap: var(--space-sm); font-size: 0.85rem; min-width: 0; color: var(--text-secondary); }
	.crumb a { color: var(--text-secondary); text-decoration: none; }
	.crumb a:hover { color: var(--accent-indigo); }

	/* One column, phone first, as the participant page; its last line stops above the user badge (card 2239). */
	.decision-content { max-width: 46rem; margin: 0 auto; padding: var(--space-xl) var(--space-md) var(--user-badge-space); }
	@media (max-width: 640px) {
		.decision-header-inner { padding: 0 var(--space-md); }
		.logo-text { display: none; }
	}
	.preview-bar {
		display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-sm) var(--space-md);
		padding: var(--space-md); border-radius: var(--radius-lg); margin-bottom: var(--space-lg);
	}
	.bar-field { display: flex; flex-direction: column; gap: var(--space-xs); font-size: 0.8rem; color: var(--text-secondary); min-width: 0; }
	.bar-field select { max-width: 100%; }
	.bar-or { font-size: 0.8rem; color: var(--text-tertiary); padding-bottom: var(--space-sm); }
	.banner-line { margin: 0 0 var(--space-xs); font-weight: 600; }
	.banner-line.preview { color: var(--accent-indigo); }
	.banner-note { margin: 0; font-size: 0.9rem; color: var(--text-secondary); }
</style>
