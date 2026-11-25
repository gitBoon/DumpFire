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
  `'all'`. Card 2728: so do the title, the decider and the participants an
  API key chose, the label beside the title, beside the Decider heading and
  at the head of the participant picker's section. A Mark reviewed waits,
  with a hint to save first, while its title, section, option or decider has
  edits not yet saved, and Mark all reviewed while any flagged one has (card
  2728's code review): a person marks reviewed what is stored. The decider
  select lists the board's editors, the Product Owner
  marked, and is read-only to a caller who may not change the decider (D6).
  Card 2684 (R24): wherever the decider may be changed, a fixed sentence
  (`FLAGS_HANDED_OVER`) says that any objections or requests to talk already
  raised, with names, become visible to the new decider: no number, and the
  same words whether or not any were raised, so the form tells the author or a
  board owner nothing of them.

  Every save sends the revision (R2). A refusal is said in the server's
  words, which name the field of a 400 (D12), and the edits are kept; the
  stale-revision 409 (`STALE_REVISION`) alone offers to reload (C6). A group
  whose members the page was not handed (C4) is not judged "nobody ticked" on
  unsaved edits. The readability panel shows the server's refusals as it
  gave them, and `checkContent`'s warnings worked out again on edits not yet
  saved (decision 11). `side` is drawn in the side column after the decider:
  the page's participant picker.

  Card 2697: the closing time says it is at most a year ahead, in UTC, from
  `CLOSES_WITHIN_DAYS` (Q25), and `onDirtyChange` tells the page whether
  there are edits not yet saved, which holds its Open, Re-publish and dry run
  off (Q14).

  Its code review's part B: the status, the chip and the closing time follow
  `decision` as the page reads it again after a lifecycle write, the edits
  not yet saved kept (F1); a closing time more than a year ahead is warned of
  (S3); and the help sentence and the field's form are `$lib/decision-readiness`'s,
  shared with Extend (F5).

  Card 2683 (slice S3a): the survey questions, after the options, in
  `SurveyEditor`, bound to the form and sent with every save (R15: the list
  as edited, `[]` once all are removed). A question published in a version,
  by `surveyQuestions`' rows, keeps its kind (R8); one an agent wrote carries
  the label under `survey.<questionId>` (R16). While the current version puts
  no option to a vote (no live option row published), the vote mode may be
  changed on an opened decision too (R23), so that a survey becomes a vote in
  either mode; otherwise it is fixed once opened.

  Card 3075: the kit's buttons, fields and status badge; the side column is
  the shell's rail width (--ui-rail) beside the form from 1024px, the shell's
  breakpoint, and stacked under it beneath that.
-->
<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { CLOSES_HELP, checkContent, closesField, type AudienceFacts, type ContentAnswer, type Refusal, type Warning } from '$lib/decision-readiness';
	import { stamp } from '$lib/timestamps';
	import { FLAGS_HANDED_OVER, STALE_REVISION, STATUS_WORDS, shownMoment } from '$lib/decision-words';
	import { DECISION_TITLE_MAX } from '$lib/decision-rules';
	import { failureMessage } from '$lib/api';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import AgentLabel from './AgentLabel.svelte';
	import ReadinessPanel from './ReadinessPanel.svelte';
	import SurveyEditor, { surveyContentOf, surveyFormOf, type SurveyDraft } from './SurveyEditor.svelte';

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
	/** An option row; `addedInVersion` set once a version has published it (card 2683, R23). */
	type Option = { id: number; label: string; addedInVersion?: number | null };
	/** A survey question row (card 2683): its words are in the content. */
	type SurveyRow = { id: number; addedInVersion: number | null };
	type Participant = { personId: number | null; removedAt: string | null };
	/** A group by name; its active members only where the caller may save the participants (C4). */
	type Group = { id: number; name: string; activeMemberIds?: number[] };
	type Candidate = { id: number; username: string; emoji: string };

	let {
		decision,
		options,
		surveyQuestions = [],
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
		onDirtyChange,
		side
	}: {
		decision: Decision;
		/** The live options, by the labels the server issued. */
		options: Option[];
		/** Card 2683: the live survey question rows, which say which questions a version has published. */
		surveyQuestions?: SurveyRow[];
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
		/**
		 * Whether there are edits not yet saved, as that changes (card 2697,
		 * Q14): the page holds Open, Re-publish and the dry run off meanwhile,
		 * as each acts on the saved working copy.
		 */
		onDirtyChange?: (dirty: boolean) => void;
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
		surveyQuestions: SurveyDraft[];
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
			surveyQuestions: surveyFormOf(content.surveyQuestions, key),
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
			// Card 2683 (R15): always sent, so a question removed here is removed, and `[]` clears them.
			surveyQuestions: surveyContentOf(form.surveyQuestions),
			audiences: form.audiences.map((audience) => ({ groupId: audience.groupId === '' ? null : Number(audience.groupId), heading: audience.heading, body: audience.body })),
			stories: form.stories.map((story) => ({ title: story.title, body: story.body })),
			unknowns: form.unknowns,
			alreadyRuled: form.alreadyRuled,
			technicalDetail: form.technicalDetail
		};
	}

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
	/**
	 * Card 2683 (R23): whether the vote mode may be changed: on a draft, and on
	 * an opened decision while no live option has been published, as the
	 * server's `updateDraft` asks it. The re-publish that adds the first
	 * options puts them in the mode saved.
	 */
	let modeFree = $derived(draft || !options.some((option) => option.addedInVersion !== null && option.addedInVersion !== undefined));
	/** Card 2683 (R8): the survey questions a version has published, by id: their kind is fixed. */
	let publishedQuestions = $derived(new Set(surveyQuestions.filter((row) => row.addedInVersion !== null).map((row) => row.id)));

	/**
	 * The status, the shown status and the closing time follow the decision as
	 * the page reads it again (the code review's part B, F1): Open, Close,
	 * Extend, Withdraw and Re-publish change them on the server, and the page's
	 * data is read again after each, while this editor stays drawn. So the chip,
	 * the fields a draft alone edits and the closing time shown follow the
	 * server. The edits not yet saved are kept, as Close, Extend and Withdraw
	 * are allowed while there are some: the content, and a draft's closing time
	 * typed and not yet saved while it is still a draft.
	 */
	$effect(() => {
		const { status, shownStatus, closesAt } = decision;
		untrack(() => {
			if (saved.status === status && saved.shownStatus === shownStatus && saved.closesAt === closesAt) return;
			const typed = closes !== closesField(saved.closesAt);
			saved = { ...saved, status, shownStatus, closesAt };
			if (!typed || status !== 'draft') closes = closesField(closesAt);
		});
	});

	/** The closing time a save sends: the stored one, to the second, while the field is as it was. */
	function closesToSend(): string | null {
		if (!draft || closes === closesField(saved.closesAt)) return saved.closesAt;
		return closes === '' ? null : closes;
	}

	/** The content as edited, and as last saved, each as a body's `content`. */
	let edited = $derived(contentOf(form));
	let savedContent = $derived(contentOf(formOf(saved.content)));

	let dirty = $derived(
		JSON.stringify(edited) !== JSON.stringify(savedContent) ||
			(draft && (title.trim() !== saved.title || closes !== closesField(saved.closesAt))) ||
			(modeFree && voteMode !== saved.voteMode)
	);

	/**
	 * Whether a flagged key has edits not yet saved (card 2728's code review):
	 * its Mark reviewed waits for Save, so a person marks reviewed what is
	 * stored, never what the agent chose with a change typed over it that may
	 * not be kept. The title as typed; a section as the form holds it; an
	 * option by the id the server issued it; the decider as selected and not
	 * yet changed. The participants are saved by the page's picker, not here.
	 */
	function unsavedKey(k: string): boolean {
		if (k === 'title') return draft && title.trim() !== saved.title;
		if (k === 'decider') return chosenDecider !== storedDecider;
		// Card 2683 (code review F5): the vote mode as selected, while it may still change (R23).
		if (k === 'voteMode') return modeFree && voteMode !== saved.voteMode;
		const optionId = /^options\.(\d+)$/.exec(k)?.[1];
		if (optionId !== undefined) {
			const optionIn = (body: typeof edited) => JSON.stringify(body.options.find((option) => option.optionId === Number(optionId)));
			return optionIn(edited) !== optionIn(savedContent);
		}
		// Card 2683 (R16): a survey question by the id its row holds, as an option.
		const questionId = /^survey\.(\d+)$/.exec(k)?.[1];
		if (questionId !== undefined) {
			const questionIn = (body: typeof edited) => JSON.stringify(body.surveyQuestions.find((question) => question.questionId === Number(questionId)));
			return questionIn(edited) !== questionIn(savedContent);
		}
		return k in edited && JSON.stringify(edited[k as keyof typeof edited]) !== JSON.stringify(savedContent[k as keyof typeof savedContent]);
	}

	// The page is told as `dirty` changes, and once as the editor is drawn (card 2697, Q14).
	$effect(() => {
		const now = dirty;
		untrack(() => onDirtyChange?.(now));
	});

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

	/**
	 * The closing time `checkContent` is handed (the code review's part B, S3),
	 * as the server hands it: an opened decision's, whose refusals are not
	 * worked out; and a draft's typed and not yet saved, which no refusal has
	 * judged yet. The field's minutes are read in the stored form.
	 */
	let closing = $derived(
		!draft ? { closesAt: saved.closesAt, now: stamp() } : closes !== closesField(saved.closesAt) && closes !== '' ? { closesAt: `${closes.replace('T', ' ')}:00`, now: stamp() } : undefined
	);

	/** The server's warnings, until there are edits not yet saved: then `checkContent`'s on them. */
	let warnings = $derived(editable && dirty ? checkContent(working, audienceFacts, closing).filter(knowable) : readiness.warnings);

	const flaggedKey = (k: string) => saved.content.agentDrafted[k] === true;
	let anyFlagged = $derived(Object.keys(saved.content.agentDrafted).length > 0);
	/** Mark all reviewed waits for Save too while any flagged key has edits not yet saved. */
	let anyFlaggedUnsaved = $derived(Object.keys(saved.content.agentDrafted).some((k) => flaggedKey(k) && unsavedKey(k)));

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
			voteMode: modeFree ? voteMode : saved.voteMode,
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
		if (sections === 'all' ? anyFlaggedUnsaved : sections.some(unsavedKey)) return;
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
	/** Beside a Mark reviewed held off by edits not yet saved (card 2728's code review). */
	const SAVE_FIRST = 'Save your changes first to mark this reviewed';
</script>

{#snippet agentLabel(k: string, name: string)}
	{#if flaggedKey(k)}
		<AgentLabel data-section={k} />
		{#if canReview}
			{@const unsaved = unsavedKey(k)}
			<Button
				variant="ghost"
				size="sm"
				aria-label="Mark {name} reviewed"
				aria-disabled={unsaved ? 'true' : undefined}
				aria-describedby={unsaved ? `${uid}-${k}-save-first` : undefined}
				onclick={() => markReviewed([k])}>Mark reviewed</Button
			>
			{#if unsaved}<span id="{uid}-{k}-save-first" class="save-first" data-save-first={k}>{SAVE_FIRST}</span>{/if}
		{/if}
	{/if}
{/snippet}

{#snippet textSection(k: 'situation' | 'ask' | 'unknowns' | 'alreadyRuled' | 'technicalDetail', heading: string, rows: number)}
	<section class="editor-section">
		<div class="section-head">
			<label class="ui-label" for="{uid}-{k}">{heading}</label>
			{@render agentLabel(k, heading)}
		</div>
		<textarea id="{uid}-{k}" class="ui-textarea" {rows} readonly={!editable} bind:value={form[k]}></textarea>
	</section>
{/snippet}

<div class="editor">
	<div class="top-bar">
		{#if draft && editable}
			<label class="visually-hidden" for="{uid}-title">Title</label>
			<input id="{uid}-title" class="ui-input title-input" maxlength={DECISION_TITLE_MAX} bind:value={title} />
		{:else}
			<h1 class="title-text">{saved.title}</h1>
		{/if}
		{@render agentLabel('title', 'Title')}
		<Badge status={saved.shownStatus} />
		{#if anyFlagged && canReview}
			<Button
				variant="outline"
				size="sm"
				aria-disabled={anyFlaggedUnsaved ? 'true' : undefined}
				aria-describedby={anyFlaggedUnsaved ? `${uid}-all-save-first` : undefined}
				onclick={() => markReviewed('all')}>Mark all reviewed</Button
			>
			{#if anyFlaggedUnsaved}<span id="{uid}-all-save-first" class="save-first" data-save-first="all">{SAVE_FIRST}</span>{/if}
		{/if}
		{#if editable}
			{#if dirty}<span class="unsaved">Unsaved changes</span>{/if}
			<Button size="sm" class="save" aria-disabled={!dirty || saving ? 'true' : undefined} aria-busy={saving ? 'true' : undefined} onclick={save}>Save</Button>
		{/if}
	</div>

	{#if error}
		<p class="editor-error" role="alert">
			{error}
			{#if stale}<Button variant="outline" size="sm" onclick={() => onReload()}>Reload</Button>{/if}
		</p>
	{/if}
	{#if !editable}
		<p class="note">This decision is {(STATUS_WORDS[saved.shownStatus] ?? saved.shownStatus).toLowerCase()}: nothing in it can be changed.</p>
	{:else if !draft && modeFree}
		<p class="note" data-note="mode-free">
			This decision has been opened: its title and closing time are fixed. It puts no options to a vote yet, so its vote mode can still be changed: the re-publish
			that adds options puts them to a vote in that mode. Its working copy can still be edited; participants see only what is published.
		</p>
	{:else if !draft}
		<p class="note">This decision has been opened: its title, closing time and vote mode are fixed. Its working copy can still be edited; participants see only what is published.</p>
	{/if}

	<div class="columns">
		<div class="main-column">
			{@render textSection('situation', 'Situation', 6)}

			<section class="editor-section">
				<div class="section-head">
					<label class="ui-label" for="{uid}-question">Question</label>
					{@render agentLabel('question', 'Question')}
				</div>
				<input id="{uid}-question" class="ui-input" maxlength="500" readonly={!editable} bind:value={form.question} />
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
							<label class="ui-label" for="{uid}-o{option.key}-title">Title</label>
							<input id="{uid}-o{option.key}-title" class="ui-input" maxlength="200" readonly={!editable} bind:value={option.title} />
							<label class="ui-label" for="{uid}-o{option.key}-summary">Summary</label>
							<textarea id="{uid}-o{option.key}-summary" class="ui-textarea" rows="3" readonly={!editable} bind:value={option.summary}></textarea>
							<label class="ui-label" for="{uid}-o{option.key}-pros">Pros, one a line</label>
							<textarea id="{uid}-o{option.key}-pros" class="ui-textarea" rows="3" readonly={!editable} bind:value={option.pros}></textarea>
							<label class="ui-label" for="{uid}-o{option.key}-cons">Cons, one a line</label>
							<textarea id="{uid}-o{option.key}-cons" class="ui-textarea" rows="3" readonly={!editable} bind:value={option.cons}></textarea>
							<label class="ui-label" for="{uid}-o{option.key}-commercial">Commercial notes</label>
							<textarea id="{uid}-o{option.key}-commercial" class="ui-textarea" rows="2" readonly={!editable} bind:value={option.commercial}></textarea>
							{#if editable}
								<div class="option-actions">
									<Button variant="ghost" size="icon" aria-label="Move option {index + 1} left" disabled={index === 0} onclick={() => moveOption(index, -1)}>←</Button>
									<Button variant="ghost" size="icon" aria-label="Move option {index + 1} right" disabled={index === form.options.length - 1} onclick={() => moveOption(index, 1)}>→</Button>
									<Button variant="ghost" size="sm" aria-label="Remove option {index + 1}" onclick={() => form.options.splice(index, 1)}>Remove</Button>
								</div>
							{/if}
						</div>
					{/each}
				</div>
				{#if editable}<div class="add-row"><Button variant="outline" size="sm" onclick={addOption}>+ Add option</Button></div>{/if}
			</section>

			<SurveyEditor bind:questions={form.surveyQuestions} {editable} published={publishedQuestions} flag={agentLabel} newKey={key} />

			<section class="editor-section">
				<div class="section-head"><h2>How it affects you</h2>{@render agentLabel('audiences', 'How it affects you')}</div>
				{#each form.audiences as audience, index (audience.key)}
					<div class="entry">
						{#if editable}
							<label class="ui-label" for="{uid}-a{audience.key}-group">Group</label>
							<select id="{uid}-a{audience.key}-group" class="ui-select" bind:value={audience.groupId}>
								<option value="">No group</option>
								{#if audience.groupId !== '' && !groupName.has(audience.groupId)}
									<option value={audience.groupId}>A group that has been deleted</option>
								{/if}
								{#each groups as group (group.id)}
									<option value={String(group.id)}>{group.name}</option>
								{/each}
							</select>
						{/if}
						<label class="ui-label" for="{uid}-a{audience.key}-heading">Heading</label>
						<input id="{uid}-a{audience.key}-heading" class="ui-input" maxlength="200" readonly={!editable} bind:value={audience.heading} />
						<label class="ui-label" for="{uid}-a{audience.key}-body">Text</label>
						<textarea id="{uid}-a{audience.key}-body" class="ui-textarea" rows="3" readonly={!editable} bind:value={audience.body}></textarea>
						{#if editable}<div class="entry-actions"><Button variant="ghost" size="sm" aria-label="Remove audience {index + 1}" onclick={() => form.audiences.splice(index, 1)}>Remove</Button></div>{/if}
					</div>
				{/each}
				{#if editable}<div class="add-row"><Button variant="outline" size="sm" onclick={() => form.audiences.push({ key: key(), groupId: '', heading: '', body: '' })}>+ Add audience</Button></div>{/if}
			</section>

			<section class="editor-section">
				<div class="section-head"><h2>User stories</h2>{@render agentLabel('stories', 'User stories')}</div>
				{#each form.stories as story, index (story.key)}
					<div class="entry">
						<label class="ui-label" for="{uid}-s{story.key}-title">Title</label>
						<input id="{uid}-s{story.key}-title" class="ui-input" maxlength="200" readonly={!editable} bind:value={story.title} />
						<label class="ui-label" for="{uid}-s{story.key}-body">Story</label>
						<textarea id="{uid}-s{story.key}-body" class="ui-textarea" rows="3" readonly={!editable} bind:value={story.body}></textarea>
						{#if editable}<div class="entry-actions"><Button variant="ghost" size="sm" aria-label="Remove story {index + 1}" onclick={() => form.stories.splice(index, 1)}>Remove</Button></div>{/if}
					</div>
				{/each}
				{#if editable}<div class="add-row"><Button variant="outline" size="sm" onclick={() => form.stories.push({ key: key(), title: '', body: '' })}>+ Add story</Button></div>{/if}
			</section>

			{@render textSection('unknowns', 'What is not yet known', 4)}
			{@render textSection('alreadyRuled', 'Already settled', 4)}
			{@render textSection('technicalDetail', 'Technical detail', 6)}
		</div>

		<aside class="side-column" aria-label="Decision settings">
			<section class="side-section">
				<label class="ui-label" for="{uid}-closes">Closes (UTC)</label>
				{#if draft && editable}
					<input id="{uid}-closes" class="ui-input" type="datetime-local" aria-describedby="{uid}-closes-help" bind:value={closes} />
					<p id="{uid}-closes-help" class="ui-hint help" data-help="closes">{CLOSES_HELP}</p>
				{:else}
					<p id="{uid}-closes" class="fixed">{shownMoment(saved.closesAt, 'Not set')}</p>
				{/if}
				<div class="side-head"><label class="ui-label" for="{uid}-vote">Vote mode</label>{@render agentLabel('voteMode', 'Vote mode')}</div>
				{#if modeFree && editable}
					<select id="{uid}-vote" class="ui-select" bind:value={voteMode}>
						<option value="single">{VOTE_WORDS.single}</option>
						<option value="score">{VOTE_WORDS.score}</option>
					</select>
				{:else}
					<p id="{uid}-vote" class="fixed">{VOTE_WORDS[saved.voteMode] ?? saved.voteMode}</p>
				{/if}
			</section>

			<section class="side-section">
				{#if canSetDecider}
					<div class="side-head"><label class="ui-label" for="{uid}-decider">Decider</label>{@render agentLabel('decider', 'Decider')}</div>
					<select id="{uid}-decider" class="ui-select" bind:value={chosenDecider}>
						{#if saved.deciderUserId === null}
							<option value="">None named</option>
						{:else if !offered.some((candidate) => candidate.id === saved.deciderUserId)}
							<option value={String(saved.deciderUserId)}>{saved.deciderName}</option>
						{/if}
						{#each offered as candidate (candidate.id)}
							<option value={String(candidate.id)}>{candidate.emoji} {candidate.username}{candidate.id === productOwnerUserId ? ' (Product Owner)' : ''}</option>
						{/each}
					</select>
					<!-- Card 2684 (R24): fixed words wherever the form is offered, with no number and whether or not anything was raised. -->
					<p class="ui-hint help" id="{uid}-flags-handed-over" data-note="flags-handed-over">{FLAGS_HANDED_OVER}</p>
					<div>
						<Button
							variant="outline"
							size="sm"
							aria-disabled={chosenDecider === storedDecider || saving ? 'true' : undefined}
							aria-describedby="{uid}-flags-handed-over"
							onclick={saveDecider}>Change decider</Button
						>
					</div>
				{:else}
					<div class="side-head"><p class="ui-label">Decider</p>{@render agentLabel('decider', 'Decider')}</div>
					<p class="fixed decider-fixed">{saved.deciderName ?? 'None named'}</p>
				{/if}
			</section>

			{#if side || flaggedKey('participants')}
				<div class="side-section">
					{#if flaggedKey('participants')}
						<div class="side-head" data-flagged="participants"><p class="ui-label">Participants</p>{@render agentLabel('participants', 'Participants')}</div>
					{/if}
					{#if side}{@render side()}{/if}
				</div>
			{/if}

			<div class="side-section">
				<ReadinessPanel refusals={readiness.refusals} {warnings} draft={draft} />
			</div>
		</aside>
	</div>
</div>

<style>
	.editor { display: flex; flex-direction: column; gap: var(--space-md); min-width: 0; color: var(--ui-foreground); }
	.top-bar { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); }
	.title-input { flex: 1; min-width: 200px; width: auto; height: 2.75rem; font-size: 1.25rem; font-weight: 600; letter-spacing: -0.02em; }
	.title-text { flex: 1; margin: 0; font-size: 1.625rem; font-weight: 600; line-height: 1.2; letter-spacing: -0.025em; overflow-wrap: anywhere; }
	.unsaved { display: inline-flex; align-items: center; gap: 0.375rem; font-size: 0.75rem; color: var(--ui-foreground); }
	.unsaved::before { content: ''; width: 0.375rem; height: 0.375rem; border-radius: var(--radius-full); background: var(--ui-warning); }
	.save-first { font-size: 0.75rem; color: var(--ui-muted-foreground); }
	/* A refusal: the words in the text colour, marked by the destructive tone. */
	.editor-error {
		display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm);
		margin: 0; padding-left: 0.625rem; border-left: 3px solid var(--ui-destructive);
		font-size: 0.875rem; color: var(--ui-foreground);
	}
	.note { font-size: 0.8125rem; color: var(--ui-muted-foreground); margin: 0; }

	/* The side column is the shell's rail width, beside the form from the shell's own breakpoint (card 3075). */
	.columns { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-xl); align-items: start; }
	@media (min-width: 1024px) { .columns { grid-template-columns: minmax(0, 1fr) var(--ui-rail); } }
	.main-column, .side-column { display: flex; flex-direction: column; gap: var(--space-lg); min-width: 0; }
	.side-section {
		display: flex; flex-direction: column; gap: var(--space-sm);
		padding: 1rem 1.25rem;
		border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg);
		background: var(--ui-card); box-shadow: var(--ui-shadow-sm);
	}

	.editor-section { display: flex; flex-direction: column; gap: var(--space-sm); }
	.section-head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-sm); }
	.section-head .ui-label, .section-head h2 { font-size: 0.9375rem; font-weight: 600; margin: 0; }
	/* Read-only: the muted fill (the kit has no read-only look of its own). */
	.ui-input[readonly], .ui-textarea[readonly] { background: var(--ui-muted); }
	.side-head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-xs); }
	.side-head p { margin: 0; }
	.fixed { font-size: 0.875rem; margin: 0; }
	.help { margin: 0; }

	.option-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr)); gap: var(--space-md); }
	.option-card, .entry {
		display: flex; flex-direction: column; gap: var(--space-sm);
		padding: 1rem 1.25rem;
		border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg);
		background: var(--ui-card); box-shadow: var(--ui-shadow-sm);
	}
	.option-card .ui-label, .entry .ui-label { margin-top: var(--space-xs); }
	.option-label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ui-muted-foreground); }
	.option-actions, .entry-actions { display: flex; gap: var(--space-xs); justify-content: flex-end; }
	.add-row { display: flex; }
	.visually-hidden {
		position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
		overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
	}
</style>
