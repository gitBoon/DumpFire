<!--
  DecisionEditor.svelte — a decision's working copy, edited (card 2676,
  decisions 6 to 10, 17 and 28, plan 4.2).

  The title, the closing time (UTC) and the vote mode are edited on a draft
  and shown read-only once the decision is open, when Save sends them
  unchanged with the content and the server accepts them so (D5). The main
  column is design 4.7's order: situation, question, what is asked, the
  options (each with the label the server issued it, D3; a new one has none
  until it is saved), how it affects you, user stories, what is not yet
  known, already settled and technical detail.

  A section an agent drafted carries the label until a person marks it
  reviewed; Mark reviewed sends that section, and Mark all reviewed sends
  `'all'`. The decider select lists the board's editors, the Product Owner
  marked, and is read-only to a caller who may not change the decider (D6).

  Every save sends the revision (R2). A refusal is said in the server's
  words, which name the field of a 400 (D12), and the edits are kept; the
  stale-revision 409 (`STALE_REVISION`) alone offers to reload (C6). A group
  whose members the page was not handed (C4) is not judged "nobody ticked" on
  unsaved edits. The readability panel shows the server's refusals as it
  gave them, and `checkContent`'s warnings worked out again on edits not yet
  saved (decision 11). `side` is drawn in the side column after the decider:
  the page's participant picker.
-->
<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { checkContent, type AudienceFacts, type ContentAnswer, type Refusal, type Warning } from '$lib/decision-readiness';
	import { STALE_REVISION, STATUS_WORDS, shownMoment } from '$lib/decision-words';
	import { failureMessage } from '$lib/api';
	import ReadinessPanel from './ReadinessPanel.svelte';

	type Decision = {
		id: number;
		title: string;
		status: string;
		shownStatus: string;
		voteMode: string;
		closesAt: string | null;
		deciderUserId: number | null;
		deciderName: string | null;
		content: ContentAnswer;
	};
	type Option = { id: number; label: string };
	type Participant = { personId: number | null; removedAt: string | null };
	/** A group by name; its active members only where the caller may save the participants (C4). */
	type Group = { id: number; name: string; activeMemberIds?: number[] };
	type Candidate = { id: number; username: string; emoji: string };

	let {
		decision,
		options,
		participants,
		groups,
		revision,
		readiness,
		editable,
		canSetDecider,
		canReview,
		productOwnerUserId,
		deciderCandidates,
		callerId,
		onSaved,
		onReload,
		side
	}: {
		decision: Decision;
		/** The live options, by the labels the server issued. */
		options: Option[];
		participants: Participant[];
		groups: Group[];
		/** The decision's revision as the page holds it: every save sends it. */
		revision: string;
		readiness: { refusals: Refusal[]; warnings: Warning[] };
		editable: boolean;
		canSetDecider: boolean;
		canReview: boolean;
		productOwnerUserId: number | null;
		deciderCandidates: Candidate[];
		/** The signed-in account: not offered as decider once the decision is open. */
		callerId: number;
		/** A save was taken: the decision's revision after it. */
		onSaved: (revision: string) => void | Promise<void>;
		/** Read the decision again, as it is now. */
		onReload: () => void | Promise<void>;
		side?: Snippet;
	} = $props();

	const uid = $props.id();

	// ─── What is being edited ────────────────────────────────────────────────

	type OptionDraft = { key: number; optionId?: number; title: string; summary: string; pros: string; cons: string; commercial: string };
	type AudienceDraft = { key: number; groupId: string; heading: string; body: string };
	type StoryDraft = { key: number; title: string; body: string };
	type Form = {
		situation: string;
		question: string;
		ask: string;
		options: OptionDraft[];
		audiences: AudienceDraft[];
		stories: StoryDraft[];
		unknowns: string;
		alreadyRuled: string;
		technicalDetail: string;
	};

	let nextKey = 0;
	const key = () => nextKey++;

	/** The content as the form edits it: pros and cons as one item a line, a group as the select's value. */
	function formOf(content: ContentAnswer): Form {
		return {
			situation: content.situation,
			question: content.question,
			ask: content.ask,
			options: content.options.map((option) => ({
				key: key(),
				...(option.optionId === undefined ? {} : { optionId: option.optionId }),
				title: option.title,
				summary: option.summary,
				pros: option.pros.join('\n'),
				cons: option.cons.join('\n'),
				commercial: option.commercial
			})),
			audiences: content.audiences.map((audience) => ({ key: key(), groupId: audience.groupId === null ? '' : String(audience.groupId), heading: audience.heading, body: audience.body })),
			stories: content.stories.map((story) => ({ key: key(), title: story.title, body: story.body })),
			unknowns: content.unknowns,
			alreadyRuled: content.alreadyRuled,
			technicalDetail: content.technicalDetail
		};
	}

	const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter((line) => line !== '');

	/** The form as a body's `content`: design 4.4's keys and no others, and no key the server keeps. */
	function contentOf(form: Form) {
		return {
			situation: form.situation,
			question: form.question,
			ask: form.ask,
			options: form.options.map((option) => ({
				...(option.optionId === undefined ? {} : { optionId: option.optionId }),
				title: option.title,
				summary: option.summary,
				pros: lines(option.pros),
				cons: lines(option.cons),
				commercial: option.commercial
			})),
			audiences: form.audiences.map((audience) => ({ groupId: audience.groupId === '' ? null : Number(audience.groupId), heading: audience.heading, body: audience.body })),
			stories: form.stories.map((story) => ({ title: story.title, body: story.body })),
			unknowns: form.unknowns,
			alreadyRuled: form.alreadyRuled,
			technicalDetail: form.technicalDetail
		};
	}

	/** A stored closing time as the field shows it, to the minute; the field is read as UTC. */
	const closesField = (closesAt: string | null) => (closesAt === null ? '' : `${closesAt.slice(0, 10)}T${closesAt.slice(11, 16)}`);

	/** What was last saved, as the server answered it. */
	let saved = $state(untrack(() => ({ ...decision })));
	let labels = $state(untrack(() => new Map(options.map((option) => [option.id, option.label]))));
	let form = $state(untrack(() => formOf(decision.content)));
	let title = $state(untrack(() => decision.title));
	let closes = $state(untrack(() => closesField(decision.closesAt)));
	let voteMode = $state(untrack(() => decision.voteMode));
	let chosenDecider = $state(untrack(() => (decision.deciderUserId === null ? '' : String(decision.deciderUserId))));

	let error = $state('');
	/** The last refusal was the stale-revision 409: the decision changed, and Reload is offered. */
	let stale = $state(false);
	let saving = $state(false);

	let draft = $derived(saved.status === 'draft');

	/** The closing time a save sends: the stored one, to the second, while the field is as it was. */
	function closesToSend(): string | null {
		if (!draft || closes === closesField(saved.closesAt)) return saved.closesAt;
		return closes === '' ? null : closes;
	}

	let dirty = $derived(
		JSON.stringify(contentOf(form)) !== JSON.stringify(contentOf(formOf(saved.content))) ||
			(draft && (title.trim() !== saved.title || closes !== closesField(saved.closesAt) || voteMode !== saved.voteMode))
	);

	/** The content as `checkContent` reads it, with the flags and stamps as last saved. */
	let working = $derived<ContentAnswer>({
		...contentOf(form),
		agentDrafted: saved.content.agentDrafted,
		reviewed: saved.content.reviewed
	});

	/** The audience facts from the load: the groups as the picker has them, and the live participants' persons. */
	let audienceFacts = $derived<AudienceFacts>({
		groups: Object.fromEntries(groups.map((group) => [group.id, { exists: true, activeMemberIds: group.activeMemberIds ?? [] }])),
		participantPersonIds: participants.filter((row) => row.removedAt === null && row.personId !== null).map((row) => row.personId!)
	});

	/** The groups whose members the page was handed: whether anyone in another is included is the server's to say, once saved (C4). */
	let membersKnown = $derived(new Set(groups.filter((group) => group.activeMemberIds !== undefined).map((group) => group.id)));

	/** Whether an unsaved warning can be worked out here: not "nobody ticked" for a group whose members were withheld. */
	function knowable(warning: Warning): boolean {
		if (warning.code !== 'audience_nobody_ticked') return true;
		const index = Number(/^audiences\[(\d+)\]$/.exec(warning.key ?? '')?.[1]);
		const groupId = working.audiences[index]?.groupId;
		return groupId !== null && groupId !== undefined && membersKnown.has(groupId);
	}

	/** The server's warnings, until there are edits not yet saved: then `checkContent`'s on them. */
	let warnings = $derived(editable && dirty ? checkContent(working, audienceFacts).filter(knowable) : readiness.warnings);

	const flaggedKey = (k: string) => saved.content.agentDrafted[k] === true;
	let anyFlagged = $derived(Object.keys(saved.content.agentDrafted).length > 0);

	/** Takes a write's answer as what was last saved. */
	function take(answer: Decision) {
		saved = { ...answer };
		form = formOf(answer.content);
		title = answer.title;
		closes = closesField(answer.closesAt);
		voteMode = answer.voteMode;
		chosenDecider = answer.deciderUserId === null ? '' : String(answer.deciderUserId);
	}

	/** Says a refusal or no answer, the edits kept. */
	async function refused(res: Response | null, fallback: string) {
		error = res === null ? `No answer from the server. ${fallback.replace(/\.$/, '')} may not have happened.` : await failureMessage(res, fallback);
		// Reload throws the edits away: offered only where they cannot be saved over the change (C6), not on any other 409.
		stale = res?.status === 409 && error === STALE_REVISION;
	}

	// ─── The writes ──────────────────────────────────────────────────────────

	async function save() {
		if (!editable || saving || !dirty) return;
		saving = true;
		error = '';
		stale = false;
		const body = {
			revision,
			title: draft ? title : saved.title,
			closesAt: closesToSend(),
			voteMode: draft ? voteMode : saved.voteMode,
			content: contentOf(form)
		};
		try {
			const res = await fetch(`/api/decisions/${saved.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
			if (res.ok) {
				const answer = (await res.json()) as { decision: Decision; options: Option[]; revision: string };
				labels = new Map(answer.options.map((option) => [option.id, option.label]));
				take(answer.decision);
				await onSaved(answer.revision);
			} else {
				await refused(res, 'The decision was not saved.');
			}
		} catch {
			await refused(null, 'The save.');
		} finally {
			saving = false;
		}
	}

	async function markReviewed(sections: string[] | 'all') {
		if (!canReview || saving) return;
		saving = true;
		error = '';
		stale = false;
		try {
			const res = await fetch(`/api/decisions/${saved.id}/reviewed`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sections, revision })
			});
			if (res.ok) {
				const answer = (await res.json()) as { decision: Decision; revision: string };
				// Only the flags and stamps changed: the edits not yet saved are kept.
				saved = { ...saved, content: { ...saved.content, agentDrafted: answer.decision.content.agentDrafted, reviewed: answer.decision.content.reviewed } };
				await onSaved(answer.revision);
			} else {
				await refused(res, 'It was not marked reviewed.');
			}
		} catch {
			await refused(null, 'Marking it reviewed.');
		} finally {
			saving = false;
		}
	}

	let storedDecider = $derived(saved.deciderUserId === null ? '' : String(saved.deciderUserId));

	/** The candidates offered: the caller left out once the decision is open, as the server refuses them (decision 17). */
	let offered = $derived(draft ? deciderCandidates : deciderCandidates.filter((candidate) => candidate.id !== callerId));

	async function saveDecider() {
		if (!canSetDecider || saving || chosenDecider === '' || chosenDecider === storedDecider) return;
		saving = true;
		error = '';
		stale = false;
		try {
			const res = await fetch(`/api/decisions/${saved.id}/decider`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ deciderUserId: Number(chosenDecider), revision })
			});
			if (res.ok) {
				const answer = (await res.json()) as { decision: Decision; revision: string };
				saved = { ...saved, deciderUserId: answer.decision.deciderUserId, deciderName: answer.decision.deciderName };
				chosenDecider = answer.decision.deciderUserId === null ? '' : String(answer.decision.deciderUserId);
				await onSaved(answer.revision);
			} else {
				chosenDecider = storedDecider;
				await refused(res, 'The decider was not changed.');
			}
		} catch {
			chosenDecider = storedDecider;
			await refused(null, 'Changing the decider.');
		} finally {
			saving = false;
		}
	}

	// ─── Lists ───────────────────────────────────────────────────────────────

	function addOption() {
		form.options.push({ key: key(), title: '', summary: '', pros: '', cons: '', commercial: '' });
	}
	function moveOption(index: number, by: -1 | 1) {
		const to = index + by;
		if (to < 0 || to >= form.options.length) return;
		const [moved] = form.options.splice(index, 1);
		form.options.splice(to, 0, moved);
	}
	const labelOf = (option: OptionDraft) => (option.optionId === undefined ? undefined : labels.get(option.optionId));

	let groupName = $derived(new Map(groups.map((group) => [String(group.id), group.name])));

	const VOTE_WORDS: Record<string, string> = { single: 'One choice', score: 'A score for each option, 0 to 5' };
</script>

{#snippet agentLabel(k: string, name: string)}
	{#if flaggedKey(k)}
		<span class="agent-label" data-section={k}>Drafted by an agent and not yet reviewed by a person</span>
		{#if canReview}
			<button type="button" class="btn-ghost btn-xs" aria-label="Mark {name} reviewed" onclick={() => markReviewed([k])}>Mark reviewed</button>
		{/if}
	{/if}
{/snippet}

{#snippet textSection(k: 'situation' | 'ask' | 'unknowns' | 'alreadyRuled' | 'technicalDetail', heading: string, rows: number)}
	<section class="editor-section">
		<div class="section-head">
			<label for="{uid}-{k}">{heading}</label>
			{@render agentLabel(k, heading)}
		</div>
		<textarea id="{uid}-{k}" class="field" {rows} readonly={!editable} bind:value={form[k]}></textarea>
	</section>
{/snippet}

<div class="editor">
	<div class="top-bar">
		{#if draft && editable}
			<label class="visually-hidden" for="{uid}-title">Title</label>
			<input id="{uid}-title" class="title-input" maxlength="200" bind:value={title} />
		{:else}
			<h1 class="title-text">{saved.title}</h1>
		{/if}
		<span class="status-chip" data-status={saved.shownStatus}>{STATUS_WORDS[saved.shownStatus] ?? saved.shownStatus}</span>
		{#if anyFlagged && canReview}
			<button type="button" class="btn-ghost btn-sm" onclick={() => markReviewed('all')}>Mark all reviewed</button>
		{/if}
		{#if editable}
			{#if dirty}<span class="unsaved">Unsaved changes</span>{/if}
			<button type="button" class="btn-primary btn-sm save" aria-disabled={!dirty || saving ? 'true' : undefined} aria-busy={saving ? 'true' : undefined} onclick={save}>Save</button>
		{/if}
	</div>

	{#if error}
		<p class="editor-error" role="alert">
			{error}
			{#if stale}<button type="button" class="btn-ghost btn-xs" onclick={() => onReload()}>Reload</button>{/if}
		</p>
	{/if}
	{#if !editable}
		<p class="note">This decision is {(STATUS_WORDS[saved.shownStatus] ?? saved.shownStatus).toLowerCase()}: nothing in it can be changed.</p>
	{:else if !draft}
		<p class="note">This decision has been opened: its title, closing time and vote mode are fixed. Its working copy can still be edited; participants see only what is published.</p>
	{/if}

	<div class="columns">
		<div class="main-column">
			{@render textSection('situation', 'Situation', 6)}

			<section class="editor-section">
				<div class="section-head">
					<label for="{uid}-question">Question</label>
					{@render agentLabel('question', 'Question')}
				</div>
				<input id="{uid}-question" class="field" maxlength="500" readonly={!editable} bind:value={form.question} />
			</section>

			{@render textSection('ask', 'What is asked', 3)}

			<section class="editor-section">
				<div class="section-head"><h2>Options</h2></div>
				<div class="option-cards">
					{#each form.options as option, index (option.key)}
						<div class="option-card" data-option={index}>
							<div class="section-head">
								<span class="option-label">{labelOf(option) ? `Option ${labelOf(option)}` : 'New option'}</span>
								{#if option.optionId !== undefined}{@render agentLabel(`options.${option.optionId}`, `option ${index + 1}`)}{/if}
							</div>
							<label class="small" for="{uid}-o{option.key}-title">Title</label>
							<input id="{uid}-o{option.key}-title" class="field" maxlength="200" readonly={!editable} bind:value={option.title} />
							<label class="small" for="{uid}-o{option.key}-summary">Summary</label>
							<textarea id="{uid}-o{option.key}-summary" class="field" rows="3" readonly={!editable} bind:value={option.summary}></textarea>
							<label class="small" for="{uid}-o{option.key}-pros">Pros, one a line</label>
							<textarea id="{uid}-o{option.key}-pros" class="field" rows="3" readonly={!editable} bind:value={option.pros}></textarea>
							<label class="small" for="{uid}-o{option.key}-cons">Cons, one a line</label>
							<textarea id="{uid}-o{option.key}-cons" class="field" rows="3" readonly={!editable} bind:value={option.cons}></textarea>
							<label class="small" for="{uid}-o{option.key}-commercial">Commercial notes</label>
							<textarea id="{uid}-o{option.key}-commercial" class="field" rows="2" readonly={!editable} bind:value={option.commercial}></textarea>
							{#if editable}
								<div class="option-actions">
									<button type="button" class="btn-ghost btn-xs" aria-label="Move option {index + 1} left" disabled={index === 0} onclick={() => moveOption(index, -1)}>←</button>
									<button type="button" class="btn-ghost btn-xs" aria-label="Move option {index + 1} right" disabled={index === form.options.length - 1} onclick={() => moveOption(index, 1)}>→</button>
									<button type="button" class="btn-ghost btn-xs danger" aria-label="Remove option {index + 1}" onclick={() => form.options.splice(index, 1)}>Remove</button>
								</div>
							{/if}
						</div>
					{/each}
				</div>
				{#if editable}<button type="button" class="btn-ghost btn-sm" onclick={addOption}>+ Add option</button>{/if}
			</section>

			<section class="editor-section">
				<div class="section-head"><h2>How it affects you</h2>{@render agentLabel('audiences', 'How it affects you')}</div>
				{#each form.audiences as audience, index (audience.key)}
					<div class="entry">
						{#if editable}
							<label class="small" for="{uid}-a{audience.key}-group">Group</label>
							<select id="{uid}-a{audience.key}-group" class="field" bind:value={audience.groupId}>
								<option value="">No group</option>
								{#if audience.groupId !== '' && !groupName.has(audience.groupId)}
									<option value={audience.groupId}>A group that has been deleted</option>
								{/if}
								{#each groups as group (group.id)}
									<option value={String(group.id)}>{group.name}</option>
								{/each}
							</select>
						{/if}
						<label class="small" for="{uid}-a{audience.key}-heading">Heading</label>
						<input id="{uid}-a{audience.key}-heading" class="field" maxlength="200" readonly={!editable} bind:value={audience.heading} />
						<label class="small" for="{uid}-a{audience.key}-body">Text</label>
						<textarea id="{uid}-a{audience.key}-body" class="field" rows="3" readonly={!editable} bind:value={audience.body}></textarea>
						{#if editable}<button type="button" class="btn-ghost btn-xs danger" aria-label="Remove audience {index + 1}" onclick={() => form.audiences.splice(index, 1)}>Remove</button>{/if}
					</div>
				{/each}
				{#if editable}<button type="button" class="btn-ghost btn-sm" onclick={() => form.audiences.push({ key: key(), groupId: '', heading: '', body: '' })}>+ Add audience</button>{/if}
			</section>

			<section class="editor-section">
				<div class="section-head"><h2>User stories</h2>{@render agentLabel('stories', 'User stories')}</div>
				{#each form.stories as story, index (story.key)}
					<div class="entry">
						<label class="small" for="{uid}-s{story.key}-title">Title</label>
						<input id="{uid}-s{story.key}-title" class="field" maxlength="200" readonly={!editable} bind:value={story.title} />
						<label class="small" for="{uid}-s{story.key}-body">Story</label>
						<textarea id="{uid}-s{story.key}-body" class="field" rows="3" readonly={!editable} bind:value={story.body}></textarea>
						{#if editable}<button type="button" class="btn-ghost btn-xs danger" aria-label="Remove story {index + 1}" onclick={() => form.stories.splice(index, 1)}>Remove</button>{/if}
					</div>
				{/each}
				{#if editable}<button type="button" class="btn-ghost btn-sm" onclick={() => form.stories.push({ key: key(), title: '', body: '' })}>+ Add story</button>{/if}
			</section>

			{@render textSection('unknowns', 'What is not yet known', 4)}
			{@render textSection('alreadyRuled', 'Already settled', 4)}
			{@render textSection('technicalDetail', 'Technical detail', 6)}
		</div>

		<aside class="side-column">
			<section class="side-section">
				<label class="small" for="{uid}-closes">Closes (UTC)</label>
				{#if draft && editable}
					<input id="{uid}-closes" class="field" type="datetime-local" bind:value={closes} />
				{:else}
					<p id="{uid}-closes" class="fixed">{shownMoment(saved.closesAt, 'Not set')}</p>
				{/if}
				<label class="small" for="{uid}-vote">Vote mode</label>
				{#if draft && editable}
					<select id="{uid}-vote" class="field" bind:value={voteMode}>
						<option value="single">{VOTE_WORDS.single}</option>
						<option value="score">{VOTE_WORDS.score}</option>
					</select>
				{:else}
					<p id="{uid}-vote" class="fixed">{VOTE_WORDS[saved.voteMode] ?? saved.voteMode}</p>
				{/if}
			</section>

			<section class="side-section">
				{#if canSetDecider}
					<label class="small" for="{uid}-decider">Decider</label>
					<select id="{uid}-decider" class="field" bind:value={chosenDecider}>
						{#if saved.deciderUserId === null}
							<option value="">None named</option>
						{:else if !offered.some((candidate) => candidate.id === saved.deciderUserId)}
							<option value={String(saved.deciderUserId)}>{saved.deciderName}</option>
						{/if}
						{#each offered as candidate (candidate.id)}
							<option value={String(candidate.id)}>{candidate.emoji} {candidate.username}{candidate.id === productOwnerUserId ? ' (Product Owner)' : ''}</option>
						{/each}
					</select>
					<button type="button" class="btn-ghost btn-xs" aria-disabled={chosenDecider === storedDecider || saving ? 'true' : undefined} onclick={saveDecider}>Change decider</button>
				{:else}
					<p class="small">Decider</p>
					<p class="fixed decider-fixed">{saved.deciderName ?? 'None named'}</p>
				{/if}
			</section>

			{#if side}
				<div class="side-section">{@render side()}</div>
			{/if}

			<div class="side-section">
				<ReadinessPanel refusals={readiness.refusals} {warnings} draft={draft} />
			</div>
		</aside>
	</div>
</div>

<style>
	.editor { display: flex; flex-direction: column; gap: var(--space-md); }
	.top-bar { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); }
	.title-input {
		flex: 1; min-width: 200px; font-size: 1.1rem; font-weight: 700; font-family: var(--font-family);
		padding: var(--space-xs) var(--space-sm); border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-elevated); color: var(--text-primary);
	}
	.title-text { flex: 1; font-size: 1.1rem; margin: 0; }
	.status-chip {
		font-size: 0.72rem; font-weight: 600; padding: 2px var(--space-sm); border-radius: 999px;
		background: rgba(99, 102, 241, 0.12); color: var(--accent-indigo);
	}
	.unsaved { font-size: 0.75rem; color: var(--accent-amber); }
	.editor-error { font-size: 0.8rem; color: var(--accent-rose); margin: 0; }
	.note { font-size: 0.8rem; color: var(--text-tertiary); margin: 0; }

	.columns { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: var(--space-xl); align-items: start; }
	@media (max-width: 900px) { .columns { grid-template-columns: minmax(0, 1fr); } }
	.main-column, .side-column { display: flex; flex-direction: column; gap: var(--space-lg); }
	.side-section { padding: var(--space-md); border: 1px solid var(--glass-border); border-radius: var(--radius-md); background: var(--bg-base); display: flex; flex-direction: column; gap: var(--space-xs); }

	.editor-section { display: flex; flex-direction: column; gap: var(--space-xs); }
	.section-head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); }
	.section-head label, .section-head h2 { font-size: 0.9rem; font-weight: 700; margin: 0; }
	.agent-label {
		font-size: 0.7rem; padding: 1px var(--space-sm); border-radius: 999px;
		background: rgba(245, 158, 11, 0.15); color: var(--accent-amber);
	}
	.field {
		width: 100%; box-sizing: border-box; padding: var(--space-xs) var(--space-sm);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-elevated); color: var(--text-primary); font-size: 0.82rem; font-family: var(--font-family);
	}
	.field[readonly] { background: var(--bg-base); }
	.small { font-size: 0.72rem; color: var(--text-secondary); margin: 0; }
	.fixed { font-size: 0.82rem; margin: 0; }

	.option-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--space-md); }
	.option-card, .entry { display: flex; flex-direction: column; gap: var(--space-xs); padding: var(--space-md); border: 1px solid var(--glass-border); border-radius: var(--radius-md); background: var(--bg-base); }
	.option-label { font-weight: 700; font-size: 0.85rem; }
	.option-actions { display: flex; gap: var(--space-xs); justify-content: flex-end; }
	.danger { color: var(--accent-rose) !important; }
	.visually-hidden {
		position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
		overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
	}
</style>
