<script lang="ts">
	/**
	 * CardModal — The full card editor modal.
	 *
	 * Handles editing card properties (title, description, priority, colour,
	 * category, due date), managing subtasks, labels, and sub-boards.
	 * Supports both create and edit modes.
	 *
	 * Its sections are components of their own, in ./card/ (card 2280, slice
	 * B4). The window keeps what it saves and what must outlast a section
	 * being hidden (another tab shown, More options shut): its fields, which
	 * it fills from its card once and hands to `onSave`, the lists it reads
	 * when it opens, and which dropdown or dialog is open. Each section is
	 * handed those as props, bound where it changes them, and sends its own
	 * writes, saying a refusal in the window's message box (`windowError`).
	 */
	import SubtaskModal from './SubtaskModal.svelte';
	import LabelPicker from './LabelPicker.svelte';
	import CardDescription from './card/CardDescription.svelte';
	import CardMetaChips from './card/CardMetaChips.svelte';
	import CardReportingFields from './card/CardReportingFields.svelte';
	import CardSubtasks, { type PendingSubtask } from './card/CardSubtasks.svelte';
	import type { TokenLedger } from './card/CardTokenCost.svelte';
	import CardComments, { type CommentItem } from './card/CardComments.svelte';
	import CardAttachments, { type AttachmentItem } from './card/CardAttachments.svelte';
	import CardDependencies from './card/CardDependencies.svelte';
	import CardSubBoards from './card/CardSubBoards.svelte';
	import CardCoverPicker from './card/CardCoverPicker.svelte';
	import CardTemplates, { type TemplateItem } from './card/CardTemplates.svelte';
	import { COLUMN_COLORS } from '$lib/utils/constants';
	import { isCoverValue } from '$lib/colours';
	import { drawnColour } from '$lib/colours';
	import { costOf, costInputOf } from '$lib/pricing';
	import { templateLabelIds } from '$lib/templates';
	import { parseStamp } from '$lib/timestamps';
	import { failureMessage } from '$lib/api';
	import { onMount, untrack } from 'svelte';
	import type { CardType, CategoryType, LabelType, SubtaskType, DependencyRefType, MilestoneType } from '$lib/types';

	let {
		card = null,
		categories = [],
		labels = [],
		boardId,
		boardUsers = [],
		onSave,
		onDelete,
		onClose,
		onCreateSubBoard,
		onDeleteSubBoard,
		onLinkSubBoard,
		availableBoards = [],
		milestones = [],
		notice = '',
	}: {
		card: CardType | null;
		categories: CategoryType[];
		labels: LabelType[];
		boardId: number;
		boardUsers?: { id: number; username: string; email?: string; emoji: string }[];
		onSave: (data: { title: string; description: string; priority: string; categoryId: number | null; dueDate: string | null; onHoldNote?: string; businessValue?: string; summary?: string | null; theme?: string | null; customerImpact?: string | null; closeReason?: string | null; releaseState?: string | null; pendingSubtasks?: string[]; pendingAssigneeIds?: number[]; pendingSubBoards?: string[]; pendingLabelIds?: number[] }) => void | Promise<unknown>;
		onDelete?: () => void;
		onClose: () => void;
		onCreateSubBoard?: (name: string) => void;
		onDeleteSubBoard?: (boardId: number) => void;
		onLinkSubBoard?: (boardId: number) => void;
		availableBoards?: { id: number; name: string; emoji: string }[];
		milestones?: MilestoneType[];
		/** Said at the top of the window while it holds: the board page's "This card is no longer on this board." (card 2280, the B2c review). */
		notice?: string;
	} = $props();

	// svelte-ignore state_referenced_locally — intentional: initialize form fields from prop snapshot
	// A board's name is at most 200 characters and a card's title 500: the
	// title as it is would be refused (card 2117).
	let newSubBoardName = $state((card?.title || '').slice(0, 200));
	let showLinkPicker = $state(false);

	/**
	 * Why the last change made in this window was not made, shown at the top of
	 * the window until it is closed or the next change is tried: the server's
	 * own words for a refusal (`failureMessage`). A label, the cover, an
	 * assignee, a subtask ticked, a comment or a file used to look changed, or
	 * stay as it was, with nothing said either way. What was changed on the
	 * window before the answer came is put back.
	 */
	let windowError = $state('');

	/**
	 * The box `windowError` is shown in. It keeps to the top of the window as
	 * it scrolls (`position: sticky`), and is brought into view when it is
	 * set: a refusal of a control far down the window, a comment or a file,
	 * was said above the top of what could be seen.
	 */
	let windowErrorBox = $state<HTMLDivElement | null>(null);
	$effect(() => {
		if (windowError && windowErrorBox) windowErrorBox.scrollIntoView({ block: 'nearest' });
	});

	/** What a change that got no answer says: it may or may not have been made. */
	const NO_ANSWER = 'No answer from the server. It is not known whether that was saved.';

	// The card's labels: put on and taken off by the label picker
	// (`LabelPicker.svelte`), and saved with a template.
	// svelte-ignore state_referenced_locally
	let cardLabelIds = $state<number[]>((card as any)?.labelIds || []);

	// Pending subtasks for new card creation (full objects, not just titles: `PendingSubtask`)
	let pendingSubtasks = $state<PendingSubtask[]>([]);
	let pendingIdCounter = $state(-1); // negative IDs for temp items

	// svelte-ignore state_referenced_locally — intentional: initialize form fields from prop snapshot
	let title = $state(card?.title || '');
	let description = $state(card?.description || '');
	let priority = $state(card?.priority || 'medium');

	// svelte-ignore state_referenced_locally
	let categoryId = $state<number | null>(card?.categoryId ?? null);
	let dueDate = $state(card?.dueDate || '');
	let descPreview = $state(false);
	let onHoldNote = $state(card?.onHoldNote || '');
	let businessValue = $state(card?.businessValue || '');
	let editingOnHold = $state(false);
	let titleError = $state(false);

	// ── Reporting fields ────────────────────────────────────────────────────
	// Filled in here so a management report does not have to be reconstructed
	// from technical card text later. Every one is optional: an empty field
	// reports as "not recorded", which is a better answer than a guess.
	let summary = $state(card?.summary || '');
	let theme = $state(card?.theme || '');
	let customerImpact = $state(card?.customerImpact || '');
	let closeReason = $state(card?.closeReason || '');
	let releaseState = $state(card?.releaseState || '');

	// Open the section by default once anything in it has been recorded, so an
	// existing value is never hidden behind a collapsed heading.
	let showReporting = $state(
		!!(card?.summary || card?.theme || card?.customerImpact || card?.closeReason || card?.releaseState)
	);

	// Chip dropdown visibility
	let showPriorityDrop = $state(false);
	let showCategoryDrop = $state(false);
	let showDueDateDrop = $state(false);
	let showAssigneeDrop = $state(false);
	let showAdvanced = $state(false);

	function closeAllDropdowns() {
		showPriorityDrop = false;
		showCategoryDrop = false;
		showDueDateDrop = false;
		showAssigneeDrop = false;
	}

	function toggleDrop(name: string) {
		const wasOpen = name === 'priority' ? showPriorityDrop : name === 'category' ? showCategoryDrop : name === 'due' ? showDueDateDrop : showAssigneeDrop;
		closeAllDropdowns();
		if (!wasOpen) {
			if (name === 'priority') showPriorityDrop = true;
			else if (name === 'category') showCategoryDrop = true;
			else if (name === 'due') showDueDateDrop = true;
			else showAssigneeDrop = true;
		}
	}

	// Whether to show business justification (only for request-origin cards or if it already has content)
	let showBusinessValue = $derived(
		!!card?.requestOrigin || !!card?.businessValue || !!businessValue
	);

	// Card cover state. A cover is a colour written #rrggbb or one of the
	// presets (`COVER_PRESETS`); it is drawn only when `isCoverValue` says it is
	// one, so a value stored before the rule is kept and not drawn (card 2010).
	// svelte-ignore state_referenced_locally
	let coverUrl = $state(card?.coverUrl || '');
	// Copies: a tick in the window changes its own list, not the board's card (the B2c review).
	let cardSubtasks = $state<SubtaskType[]>((card?.subtasks || []).map((s) => ({ ...s })));

	// Inline category creation state
	let showNewCategory = $state(false);
	let newCatName = $state('');
	let newCatColor = $state('#6366f1');
	let localCategories = $state<CategoryType[]>([...categories]);

	async function createCategoryInline() {
		if (!newCatName.trim()) return;
		windowError = '';
		let res: Response;
		try {
			res = await fetch('/api/categories', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ boardId, name: newCatName.trim(), color: newCatColor })
			});
		} catch {
			windowError = NO_ANSWER;
			return;
		}
		if (!res.ok) {
			// The name stays in the form, to be put right and sent again.
			windowError = await failureMessage(res, 'The category was not created.');
			return;
		}
		const created = await res.json();
		localCategories = [...localCategories, created];
		categoryId = created.id;
		newCatName = '';
		newCatColor = '#6366f1';
		showNewCategory = false;
	}

	// Planned sub-boards for new card creation
	let pendingSubBoardNames = $state<string[]>([]);
	let newPendingSubBoardName = $state('');

	// svelte-ignore state_referenced_locally
	let cardAssignees = $state<{ id: number; username: string; emoji: string }[]>(card?.assignees || []);

	// Subtask modal state
	let showSubtaskModal = $state(false);
	let editingSubtask = $state<SubtaskType | null>(null);
	let editingPendingSubtask = $state<PendingSubtask | null>(null);

	// Template state (`TemplateItem`); the two dialogs are CardTemplates.svelte
	let templates = $state<TemplateItem[]>([]);
	let showTemplatePicker = $state(false);
	let showSaveTemplate = $state(false);
	let templateName = $state('');

	/**
	 * The labels of the template applied to a new card, which the board page
	 * puts on the card once it is created (card 2163): the picker shows only on
	 * a saved card. Listed above the footer, so they are seen before the card
	 * is made.
	 */
	let templateLabels = $state<number[]>([]);

	async function loadTemplates() {
		const res = await fetch(`/api/templates?boardId=${boardId}`);
		if (res.ok) templates = await res.json();
	}

	/**
	 * Why the open template dialog's last request was not done, shown in that
	 * dialog: it is in front of the window. A template that was not saved used
	 * to close the dialog as if it had been, and one not deleted left the list.
	 */
	let templateError = $state('');

	function applyTemplate(tmpl: TemplateItem) {
		title = tmpl.title || '';
		description = tmpl.description || '';
		priority = tmpl.priority || 'medium';
		try {
			const subs = JSON.parse(tmpl.subtasksJson || '[]');
			pendingSubtasks = subs.map((s: any, i: number) => ({
				id: -(i + 100),
				title: s.title || '',
				description: s.description || '',
				priority: s.priority || 'medium',
				colorTag: '',
				dueDate: null,
				completed: false
			}));
		} catch { /* ignore */ }
		// Its labels that are labels of this board, once each (`templateLabelIds`).
		templateLabels = templateLabelIds(tmpl.labelsJson, labels);
		showTemplatePicker = false;
	}

	/**
	 * A save handed to the page and not yet answered: no second one is sent
	 * until it is, by Ctrl+Enter, Enter in the title or the button (the B5
	 * review): a create sent twice would make the card twice. Every page's
	 * `onSave` hands back its promise.
	 */
	let saving = $state(false);

	function save() {
		if (saving) return;
		if (!title.trim()) {
			titleError = true;
			setTimeout(() => (titleError = false), 1500);
			return;
		}
		// No colour tag: the window has no control for one, and the empty one it
		// sent cleared a tag set through the API at every save (card 2147).
		const out = onSave({
			title: title.trim(), description, priority, categoryId,
			// An emptied box is sent as '' when the card held a value, which clears it; otherwise left out (card 2200).
			dueDate: dueDate || null, onHoldNote: onHoldNote || (card?.onHoldNote ? '' : undefined),
			businessValue: businessValue || (card?.businessValue ? '' : undefined),
			// Sent as null rather than omitted when cleared, so emptying a field
			// actually clears it instead of leaving the stored value in place.
			summary: summary.trim() || null,
			theme: theme || null,
			customerImpact: customerImpact.trim() || null,
			closeReason: closeReason || null,
			releaseState: releaseState || null,
			pendingSubtasks: pendingSubtasks.length > 0
				? pendingSubtasks.map(s => JSON.stringify({ title: s.title, description: s.description, priority: s.priority, colorTag: s.colorTag, dueDate: s.dueDate }))
				: undefined,
			pendingAssigneeIds: !card && cardAssignees.length > 0
				? cardAssignees.map(a => a.id)
				: undefined,
			pendingSubBoards: !card && pendingSubBoardNames.length > 0
				? pendingSubBoardNames
				: undefined,
			pendingLabelIds: !card && templateLabels.length > 0
				? templateLabels
				: undefined
		});
		if (out) {
			saving = true;
			const answered = () => { saving = false; };
			out.then(answered, answered);
		}
	}

	function openNewPendingSubtask() {
		editingPendingSubtask = null;
		editingSubtask = null;
		showSubtaskModal = true;
	}

	function handlePendingSubtaskSaved(data: any) {
		if (editingPendingSubtask) {
			// Update existing pending
			pendingSubtasks = pendingSubtasks.map(s =>
				s.id === editingPendingSubtask!.id
					? { ...s, title: data.title, description: data.description, priority: data.priority, colorTag: data.colorTag, dueDate: data.dueDate }
					: s
			);
		} else {
			// Add new pending
			pendingSubtasks = [...pendingSubtasks, {
				id: pendingIdCounter--,
				title: data.title,
				description: data.description || '',
				priority: data.priority || 'medium',
				colorTag: data.colorTag || '',
				dueDate: data.dueDate || null,
				completed: false
			}];
		}
		showSubtaskModal = false;
		editingPendingSubtask = null;
	}

	function openEditPendingSubtask(ps: PendingSubtask) {
		editingPendingSubtask = ps;
		editingSubtask = null;
		showSubtaskModal = true;
	}

	function removePendingSubtask(id: number) {
		pendingSubtasks = pendingSubtasks.filter(s => s.id !== id);
	}

	// Share link
	let linkCopied = $state(false);
	function shareLink() {
		if (!card) return;
		const url = `${window.location.origin}/board/${boardId}?card=${card.id}`;
		navigator.clipboard.writeText(url).then(() => {
			linkCopied = true;
			setTimeout(() => (linkCopied = false), 2000);
		});
	}

	/** The window's own overlay, to tell a confirmation of its own from one of the page's. */
	let overlay = $state<HTMLDivElement | null>(null);

	function handleKeydown(e: KeyboardEvent) {
		if (showSubtaskModal) return; // Let subtask modal handle its own escape
		// Ctrl+Enter (Cmd+Enter) saves, as the footer says (card 2280, slice B5c).
		// The comment, label, sub-board and category boxes keep theirs: they
		// stop it before it gets here.
		const saveKey = e.key === 'Enter' && (e.ctrlKey || e.metaKey);
		if (e.key !== 'Escape' && !saveKey) return;
		// A confirmation the page opened over this window, such as All Tasks' or
		// the board page's "Archive Card", answers Escape itself, as Cancel. It
		// used to close this window as well, and with it what was typed in it.
		const confirming = document.querySelector('.confirm-modal');
		if (confirming && !overlay?.contains(confirming)) return;
		if (saveKey) {
			// Not while a template dialog is open: its own Enter is its answer.
			if (showTemplatePicker || showSaveTemplate) return;
			// The key is the window's: a focused button is not pressed by it too.
			e.preventDefault();
			// A held key repeats; and `save()` sends one save at a time.
			if (!e.repeat) save();
			return;
		}
		// Not while a save is on its way: a refused one leaves the window open
		// with what was typed, which an Escape pressed by accident would lose
		// (the B5 review). Cancel and ✕ still close: they are meant.
		if (saving) return;
		// Escape closes the innermost thing open, and the window only when
		// nothing is (the B5 review). A section's own, a comment or a label being
		// edited, is closed by its box, which stops it; the dependency picker's
		// box does too, and the picker is the window's, closed here wherever
		// the focus is.
		if (showSaveTemplate) showSaveTemplate = false;
		else if (showTemplatePicker) showTemplatePicker = false;
		else if (showNewCategory) showNewCategory = false;
		else if (showPriorityDrop || showCategoryDrop || showDueDateDrop || showAssigneeDrop) closeAllDropdowns();
		else if (pickerMode) { pickerMode = null; pickerQuery = ''; pickerResults = []; }
		else if (showLinkPicker) showLinkPicker = false;
		else onClose();
	}

	// Subtask operations
	function openNewSubtask() {
		editingSubtask = null;
		showSubtaskModal = true;
	}

	function openEditSubtask(subtask: SubtaskType) {
		editingSubtask = subtask;
		showSubtaskModal = true;
	}

	function handleSubtaskSaved(saved: SubtaskType) {
		if (editingSubtask) {
			cardSubtasks = cardSubtasks.map((st) => st.id === saved.id ? saved : st);
		} else {
			cardSubtasks = [...cardSubtasks, saved];
		}
		showSubtaskModal = false;
		editingSubtask = null;
	}

	function handleSubtaskDeleted() {
		if (editingSubtask) {
			cardSubtasks = cardSubtasks.filter((st) => st.id !== editingSubtask!.id);
		}
		showSubtaskModal = false;
		editingSubtask = null;
	}

	// The card's id alone: the window's subtasks and its cost are read again
	// for another card, and not for every read of the board, which hands the
	// window its card afresh as each read draws it (card 2280, slice B2c).
	// Once open, the subtasks shown are the window's own, as its typed fields
	// are: a read sent before a tick was answered would untick it.
	const windowCardId = $derived(card?.id);

	$effect(() => {
		if (!windowCardId) return;
		untrack(() => {
			if (card) cardSubtasks = (card.subtasks || []).map((s) => ({ ...s }));
		});
	});

	// ─── Token cost ──────────────────────────────────────────────────────────
	// What this card actually cost, loaded on open (`TokenLedger`, drawn by
	// CardTokenCost.svelte).
	let tokenLedger = $state<TokenLedger | null>(null);
	let tokensExpanded = $state(false);

	/**
	 * Per-subtask cost, folded out of the card's own ledger.
	 *
	 * A subtask only appears here if something was reported against it; the rest
	 * show nothing at all rather than a zero, for the same reason cards do.
	 */
	const subtaskCost = $derived.by(() => {
		const m = new Map<number, { tokens: number; costUsd: number | null }>();
		for (const e of tokenLedger?.entryList ?? []) {
			if (e.subtaskId === null) continue;
			const prev = m.get(e.subtaskId);
			m.set(e.subtaskId, { tokens: (prev?.tokens ?? 0) + e.tokens, costUsd: null });
		}
		for (const [id] of m) {
			const mine = (tokenLedger?.entryList ?? []).filter((e) => e.subtaskId === id);
			// Priced as the card's total is, measured breakdown and all.
			const c = costOf(mine.map(costInputOf));
			m.get(id)!.costUsd = c.usd;
		}
		return m;
	});

	$effect(() => {
		const id = windowCardId;
		if (!id) { tokenLedger = null; return; }
		let cancelled = false;
		fetch(`/api/cards/${id}/tokens`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => { if (!cancelled) tokenLedger = d; })
			.catch(() => { /* cost is supplementary — never block the card on it */ });
		return () => { cancelled = true; };
	});

	// ─── Tabs & Comments ────────────────────────────────────────────────────
	let activeTab = $state<'details' | 'comments' | 'attachments'>('details');

	// The comments, read here (the tab shows their count); written, edited and
	// deleted in CardComments.svelte.
	let comments = $state<CommentItem[]>([]);
	let loadingComments = $state(false);

	onMount(() => {
		if (card) {
			loadComments();
			loadDependencies();
		}
	});

	// ─── Dependencies & milestone ────────────────────────────────────────────
	//
	// The two planning facts that are recorded by hand. Everything derived from
	// them (critical path, what is startable) lives in the planning view at
	// /plan — this section only edits the raw facts.

	let blockedBy = $state<DependencyRefType[]>([]);
	let blocks = $state<DependencyRefType[]>([]);
	let depsLoading = $state(false);
	let depError = $state('');

	/** Which list the picker is adding to: this card waits on X, or X waits on this card. */
	let pickerMode = $state<null | 'blocked-by' | 'blocks'>(null);
	let pickerQuery = $state('');
	let pickerResults = $state<{ id: number; title: string; boardId: number; boardName: string; boardEmoji: string; columnName: string; priority: string }[]>([]);
	let pickerSearching = $state(false);
	let pickerTimer: ReturnType<typeof setTimeout> | null = null;

	// svelte-ignore state_referenced_locally
	let milestoneId = $state<number | null>(card?.milestoneId ?? null);
	let milestoneSaving = $state(false);

	async function loadDependencies() {
		if (!card) return;
		depsLoading = true;
		try {
			const res = await fetch(`/api/cards/${card.id}/dependencies`);
			if (res.ok) {
				const data = await res.json();
				blockedBy = data.blockedBy;
				blocks = data.blocks;
			}
		} finally {
			depsLoading = false;
		}
	}

	/**
	 * Search by "#id" or title across every board the user can see. Debounced —
	 * the search runs on every keystroke otherwise, and a title search scans
	 * cards across the whole workspace.
	 */
	function onPickerInput() {
		if (pickerTimer) clearTimeout(pickerTimer);
		const q = pickerQuery.trim();
		if (q.length === 0) {
			pickerResults = [];
			return;
		}
		pickerSearching = true;
		pickerTimer = setTimeout(async () => {
			try {
				// No card yet, no `exclude`: 0 is no id, and is refused.
				const exclude = card?.id ? `&exclude=${card.id}` : '';
				const res = await fetch(`/api/cards/search?q=${encodeURIComponent(q)}${exclude}`);
				pickerResults = res.ok ? await res.json() : [];
			} finally {
				pickerSearching = false;
			}
		}, 250);
	}

	async function loadComments() {
		if (!card) return;
		loadingComments = true;
		try {
			const res = await fetch(`/api/cards/${card.id}/comments`);
			if (res.ok) comments = await res.json();
		} finally { loadingComments = false; }
	}

	// ─── Attachments ─────────────────────────────────────────────────────
	// The files, read here when the tab is opened on none (the tab shows their
	// count); uploaded and deleted in CardAttachments.svelte.
	let attachments = $state<AttachmentItem[]>([]);
	let loadingAttachments = $state(false);

	async function loadAttachments() {
		if (!card) return;
		loadingAttachments = true;
		try {
			const res = await fetch(`/api/cards/${card.id}/attachments`);
			if (res.ok) attachments = await res.json();
		} finally { loadingAttachments = false; }
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Card editor" bind:this={overlay}>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-content card-modal-content" onclick={(e) => { e.stopPropagation(); closeAllDropdowns(); }} role="document">
		{#if isCoverValue(coverUrl)}
			<div class="modal-cover-preview" style="background: {coverUrl}"></div>
		{/if}
		<div class="modal-header">
			<h2>{card ? `Edit Task` : 'New Task'}{#if card}<span class="card-id-header">#{card.id}</span>{/if}</h2>
			<div class="modal-header-actions">
				{#if card}
					<button class="share-link-btn" onclick={shareLink} title="Copy link to this task">
						{#if linkCopied}
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
							Copied!
						{:else}
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
							Share
						{/if}
					</button>
				{/if}
				<button class="close-btn btn-ghost" onclick={onClose} aria-label="Close">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="18" y1="6" x2="6" y2="18"></line>
						<line x1="6" y1="6" x2="18" y2="18"></line>
					</svg>
				</button>
			</div>
		</div>

		<div class="modal-body">
		{#if windowError}
			<div class="dep-error window-error" role="alert" bind:this={windowErrorBox}>
				<span>{windowError}</span>
				<button class="window-error-close" onclick={() => (windowError = '')} aria-label="Close this message" type="button">✕</button>
			</div>
		{/if}
		{#if notice}
			<div class="dep-error window-error" role="status">{notice}</div>
		{/if}
		<div class="title-field" class:title-error={titleError}>
			<input id="card-title" class="modal-title-input" type="text" placeholder="What needs to be done?" maxlength="500" bind:value={title} oninput={() => (titleError = false)} onkeydown={(e) => e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && save()} autofocus />
			{#if titleError}<span class="title-error-msg">A title is required</span>{/if}
		</div>

		{#if card}
		<div class="tab-bar">
			<button class="tab" class:active={activeTab === 'details'} onclick={() => (activeTab = 'details')}>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3h8M3 7h5M3 11h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
				Details
			</button>
			<button class="tab" class:active={activeTab === 'comments'} onclick={() => { activeTab = 'comments'; if (comments.length === 0 && !loadingComments) loadComments(); }}>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3a1 1 0 011-1h8a1 1 0 011 1v6a1 1 0 01-1 1H5l-3 2V3z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
				Comments{#if comments.length > 0}<span class="tab-badge">{comments.length}</span>{/if}
			</button>
		<button class="tab" class:active={activeTab === 'attachments'} onclick={() => { activeTab = 'attachments'; if (attachments.length === 0 && !loadingAttachments) loadAttachments(); }}>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7.5 2L4 5.5a2.12 2.12 0 003 3L10.5 5a1.41 1.41 0 00-2-2L5 6.5a.71.71 0 001 1L9 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
			Files{#if attachments.length > 0}<span class="tab-badge">{attachments.length}</span>{/if}
		</button>
		</div>
		{/if}

		<div class="modal-body-grid">
			<div class="main-panel">
				{#if !card || activeTab === 'details'}
				<!-- Description -->
				<CardDescription bind:description bind:descPreview />

		<!-- Metadata chips -->
		<CardMetaChips
			{card}
			{boardId}
			{boardUsers}
			{localCategories}
			bind:priority
			bind:categoryId
			bind:dueDate
			bind:cardAssignees
			bind:showPriorityDrop
			bind:showCategoryDrop
			bind:showDueDateDrop
			bind:showAssigneeDrop
			bind:showNewCategory
			bind:windowError
			{toggleDrop}
		/>

		{#if card?.requestOrigin}
			<div class="request-origin-banner">
				<span class="request-origin-icon">📨</span>
				<span>Created from request by <strong>{card.requestOrigin.requesterName}</strong></span>
			</div>
		{/if}

		{#if showBusinessValue}
		<div class="form-group">
			<label for="card-bv">Business Value / Justification</label>
			<textarea id="card-bv" placeholder="Why is this important? What value does it deliver?" maxlength="10000" bind:value={businessValue} rows="2"></textarea>
		</div>
		{/if}

		<!--
			Reporting — the five facts a management report needs that the technical
			card text cannot supply. Collapsed by default so it stays out of the way
			of writing a card, and expanded automatically once anything is recorded.
		-->
		<CardReportingFields bind:summary bind:theme bind:customerImpact bind:closeReason bind:releaseState bind:showReporting />

		<!-- On Hold Note: shown from the window's own note, which a read never
		     changes, so a note someone else wrote meanwhile neither shows a blank
		     box nor takes it away mid-edit (card 2280, the B2c review). -->
		{#if onHoldNote || editingOnHold}
			<div class="on-hold-note-display">
				<div class="on-hold-label">
					⏸️ On Hold
					<button class="btn-ghost on-hold-edit-btn" onclick={() => (editingOnHold = !editingOnHold)} title="Edit reason">
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8.5 1.5l2 2L4 10H2v-2l6.5-6.5z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
					</button>
				</div>
				{#if editingOnHold}
					<textarea class="on-hold-edit" placeholder="Why is this on hold?" bind:value={onHoldNote} rows="2"></textarea>
				{:else}
					<p class="on-hold-note-text">{onHoldNote}</p>
				{/if}
			</div>
		{/if}

		<!-- Subtasks section -->
		<CardSubtasks
			{card}
			{boardId}
			bind:cardSubtasks
			{pendingSubtasks}
			{tokenLedger}
			bind:tokensExpanded
			{subtaskCost}
			bind:windowError
			{openNewSubtask}
			{openEditSubtask}
			{openNewPendingSubtask}
			{openEditPendingSubtask}
			{removePendingSubtask}
		/>

		{/if} <!-- end details tab / new card -->

		<!-- The Comments and Files tabs: each shows itself on its tab of a saved card. -->
		<CardComments {card} {activeTab} {boardUsers} bind:comments {loadingComments} bind:windowError />

		<CardAttachments {card} {activeTab} bind:attachments {loadingAttachments} {loadAttachments} bind:windowError />

		</div> <!-- end main-panel -->

		<!-- New Category inline form -->
		{#if showNewCategory}
		<div class="inline-cat-form" style="margin-bottom: var(--space-lg);">
			<label style="font-size:0.75rem; font-weight:600; color:var(--text-secondary); margin-bottom:6px; display:block;">New Category</label>
			<input type="text" class="inline-cat-input" placeholder="Category name..." bind:value={newCatName} onkeydown={(e) => { if (e.key !== 'Enter') return; if (e.ctrlKey || e.metaKey) e.stopPropagation(); createCategoryInline(); }} autofocus />
			<div class="inline-cat-colors">
				{#each COLUMN_COLORS.slice(0, 8) as color}
					<button class="cat-color-swatch" class:active={newCatColor === color} style="background: {drawnColour(color)}" onclick={() => (newCatColor = color)} type="button"></button>
				{/each}
				<label class="color-custom-wrapper">
					<input type="color" bind:value={newCatColor} class="color-native-input" />
					<span class="cat-color-swatch custom" style="background: {drawnColour(newCatColor)}">✎</span>
				</label>
			</div>
			<div class="inline-cat-actions">
				<button class="btn-primary small" onclick={createCategoryInline} disabled={!newCatName.trim()} type="button">Create</button>
				<button class="btn-ghost small" onclick={() => (showNewCategory = false)} type="button">Cancel</button>
			</div>
		</div>
		{/if}

		{#if !card || activeTab === 'details'}
		<!-- More options (progressive disclosure) -->
		<div class="advanced-section">
			<button class="advanced-toggle" class:is-expanded={showAdvanced} onclick={() => (showAdvanced = !showAdvanced)}>
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
				More options
			</button>

			{#if showAdvanced}
			<div class="advanced-content">
				<CardDependencies
					{card}
					{boardId}
					{milestones}
					bind:blockedBy
					bind:blocks
					{depsLoading}
					bind:depError
					bind:pickerMode
					bind:pickerQuery
					bind:pickerResults
					{pickerSearching}
					bind:milestoneId
					bind:milestoneSaving
					{loadDependencies}
					{onPickerInput}
				/>

				<!-- Sub-board -->
				<CardSubBoards
					{card}
					{availableBoards}
					{onCreateSubBoard}
					{onDeleteSubBoard}
					{onLinkSubBoard}
					bind:newSubBoardName
					bind:showLinkPicker
					bind:pendingSubBoardNames
					bind:newPendingSubBoardName
				/>

				<!-- Labels and a cover are put on a saved card: a new one has no id to put them on yet. -->
				{#if card}
				<div class="form-group">
					<label>Labels</label>
					<LabelPicker cardId={card.id} {boardId} {labels} bind:selected={cardLabelIds} />
				</div>

				<CardCoverPicker {card} {boardId} bind:coverUrl bind:windowError />
				{/if}
			</div>
			{/if}
		</div>

		{#if card}
			<div class="sidebar-timestamp">
				Created {parseStamp(card.createdAt)?.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) ?? ''}
			</div>
		{/if}
		{/if} <!-- end details-only block for more options -->
		</div> <!-- end modal-body-grid -->
		</div> <!-- end modal-body -->

		<!-- The template's labels, put on the card once it is created: the picker shows only on a saved card (card 2163). -->
		{#if !card && templateLabels.length > 0}
			<div class="template-labels">
				<span class="template-labels-title">Labels from the template:</span>
				{#each templateLabels as labelId (labelId)}
					{@const label = labels.find((l) => l.id === labelId)}
					{#if label}
						<span class="template-label" style="--lc: {drawnColour(label.color)}">{label.name}</span>
					{/if}
				{/each}
			</div>
		{/if}

		<div class="modal-footer">
			<div class="footer-left">
				{#if card}
					<button class="template-btn" onclick={() => { showSaveTemplate = true; templateName = title.slice(0, 200); templateError = ''; }} type="button">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
						Save as Template
					</button>
				{:else}
					<button class="template-btn" onclick={() => { showTemplatePicker = true; templateError = ''; loadTemplates(); }} type="button">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
						From template
					</button>
				{/if}
				{#if onDelete}
					<button class="btn-danger" onclick={onDelete}>
						<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2.5A.5.5 0 015.5 2h3a.5.5 0 01.5.5V4m1.5 0l-.5 8a1 1 0 01-1 1h-5a1 1 0 01-1-1l-.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
						Archive
					</button>
				{/if}
			</div>
			<div class="footer-right">
				<button class="btn-cancel" onclick={onClose}>Cancel</button>
				<button class="btn-create" onclick={save} disabled={!title.trim() || saving}>
					{card ? 'Save Changes' : 'Create task'}
				</button>
			</div>
		</div>

		<div class="shortcut-hint">
			<kbd>Ctrl</kbd> <kbd>Enter</kbd> to {card ? 'save' : 'create'} · <kbd>Esc</kbd> to close
		</div>
	</div>
</div>

<!-- Subtask Modal (spawns on top) -->
{#if showSubtaskModal && card}
	<SubtaskModal
		subtask={editingSubtask}
		cardId={card.id}
		{boardId}
		onSave={handleSubtaskSaved}
		onDelete={editingSubtask ? handleSubtaskDeleted : undefined}
		onClose={() => { showSubtaskModal = false; editingSubtask = null; }}
	/>
{:else if showSubtaskModal && !card}
	<SubtaskModal
		subtask={editingPendingSubtask ? { id: editingPendingSubtask.id, cardId: 0, title: editingPendingSubtask.title, description: editingPendingSubtask.description, priority: editingPendingSubtask.priority, colorTag: editingPendingSubtask.colorTag, dueDate: editingPendingSubtask.dueDate, completed: false, position: 0 } : null}
		cardId={0}
		{boardId}
		onSave={handlePendingSubtaskSaved}
		onDelete={editingPendingSubtask ? () => { removePendingSubtask(editingPendingSubtask!.id); showSubtaskModal = false; editingPendingSubtask = null; } : undefined}
		onClose={() => { showSubtaskModal = false; editingPendingSubtask = null; }}
	/>
{/if}

<!-- Save as Template and Create from Template (spawn on top) -->
<CardTemplates
	{card}
	{boardId}
	{title}
	{description}
	{priority}
	{cardSubtasks}
	{cardLabelIds}
	bind:templates
	bind:showTemplatePicker
	bind:showSaveTemplate
	bind:templateName
	bind:templateError
	{applyTemplate}
/>

<style>
	.card-modal-content {
		max-width: 640px;
		background: var(--bg-surface);
		border: 1px solid var(--glass-border);
	}

	/* Modal body wrapper */
	.modal-body { padding: var(--space-lg) var(--space-xl) var(--space-xl); }

	/* Softer field styles for card modal (each section in ./card/ holds the
	   same rule for its own boxes, under :global(.card-modal-content)) */
	.card-modal-content input,
	.card-modal-content textarea {
		background: var(--bg-base); border: 1px solid var(--glass-border);
	}
	.card-modal-content input:focus,
	.card-modal-content textarea:focus {
		border-color: var(--accent-indigo); box-shadow: 0 0 0 2px var(--accent-purple-glow);
	}

	/* Request origin banner */
	.request-origin-banner {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md); margin-bottom: var(--space-lg);
		background: rgba(99, 102, 241, 0.08); border: 1px solid rgba(99, 102, 241, 0.15);
		border-radius: var(--radius-sm); font-size: 0.78rem; color: var(--text-secondary);
	}
	.request-origin-icon { font-size: 0.9rem; }
	.request-origin-banner strong { color: var(--text-primary); }

	/* Title field */
	.title-field { flex: 1; display: flex; flex-direction: column; gap: 2px; }
	.modal-title-input {
		width: 100%; font-size: 1.05rem; font-weight: 600;
		background: var(--bg-base); border: 1px solid transparent;
		border-radius: var(--radius-md);
		color: var(--text-primary); font-family: var(--font-family); outline: none;
		padding: var(--space-md) var(--space-lg);
		transition: border-color 0.2s ease, background 0.2s ease;
		caret-color: var(--accent-indigo);
	}
	.modal-title-input:hover { border-color: var(--glass-border); }
	.modal-title-input:focus { border-color: var(--accent-indigo); background: var(--bg-base); box-shadow: 0 0 0 2px var(--accent-purple-glow); }
	.modal-title-input::placeholder { color: var(--text-tertiary); font-weight: 500; }
	.title-error .modal-title-input {
		border-color: #ef4444; animation: shake 0.4s ease;
	}
	.title-error-msg {
		font-size: 0.7rem; color: #ef4444; font-weight: 500;
		animation: fadeIn 0.2s ease;
	}

	@keyframes shake {
		0%, 100% { transform: translateX(0); }
		20% { transform: translateX(-6px); }
		40% { transform: translateX(6px); }
		60% { transform: translateX(-4px); }
		80% { transform: translateX(4px); }
	}
	@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

	.modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0; padding: var(--space-lg) var(--space-xl) 0; }
	.modal-header h2 { font-size: 0.8rem; font-weight: 500; color: var(--text-secondary); }
	.modal-header-actions { display: flex; align-items: center; gap: var(--space-sm); }
	.close-btn { padding: var(--space-xs) !important; flex-shrink: 0; }
	.share-link-btn {
		display: flex; align-items: center; gap: 5px;
		padding: 4px 12px; flex-shrink: 0; border: none; cursor: pointer;
		font-size: 0.72rem; font-weight: 600; font-family: inherit;
		color: var(--accent-purple, #6366f1);
		background: var(--accent-purple-glow, rgba(99, 102, 241, 0.1));
		border-radius: var(--radius-full, 999px);
		border: 1px solid var(--accent-purple, #6366f1);
		transition: all var(--duration-fast, 150ms) var(--ease-out, ease-out);
	}
	.share-link-btn:hover {
		background: var(--accent-purple, #6366f1); color: white;
	}
	.share-link-btn:hover svg { stroke: white; }

	/* Tab bar */
	.tab-bar {
		display: flex; gap: 2px; border-bottom: 1px solid var(--glass-border);
		margin-bottom: var(--space-lg);
	}
	.tab {
		display: flex; align-items: center; gap: 6px;
		padding: var(--space-sm) var(--space-md); border: none; background: none;
		color: var(--text-tertiary); font: inherit; font-size: 0.75rem; font-weight: 600;
		cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.tab:hover { color: var(--text-secondary); }
	.tab.active { color: var(--accent-indigo); border-bottom-color: var(--accent-indigo); }
	.tab-badge {
		font-size: 0.65rem; background: var(--accent-indigo); color: white;
		padding: 1px 6px; border-radius: var(--radius-full); font-weight: 700;
	}

	/* Single-column layout */
	.modal-body-grid { display: flex; flex-direction: column; }
	.main-panel { min-width: 0; }
	.sidebar-timestamp {
		font-size: 0.7rem; color: var(--text-tertiary); margin-top: auto;
		padding-top: var(--space-md); border-top: 1px solid var(--glass-border);
	}

	.form-group { margin-bottom: var(--space-lg); }
	.form-group label {
		display: flex; align-items: center; gap: var(--space-sm);
		font-size: 0.7rem; font-weight: 600; color: var(--text-secondary);
		text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm);
	}

	/* Inline category creation */
	.inline-cat-form {
		display: flex; flex-direction: column; gap: var(--space-sm);
		padding: var(--space-md); background: var(--bg-base);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
	}
	.inline-cat-input {
		padding: var(--space-sm); font-size: 0.85rem;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); color: var(--text-primary);
		font-family: var(--font-family);
	}
	.inline-cat-input:focus { outline: none; border-color: var(--accent-indigo); }
	.inline-cat-colors { display: flex; gap: 4px; flex-wrap: wrap; }
	.cat-color-swatch {
		width: 20px; height: 20px; border-radius: var(--radius-sm);
		border: 2px solid transparent; cursor: pointer;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.cat-color-swatch:hover { transform: scale(1.15); }
	.cat-color-swatch.active { border-color: var(--text-primary); box-shadow: 0 0 6px rgba(255,255,255,0.2); }
	.inline-cat-actions { display: flex; gap: var(--space-sm); }
	.inline-cat-actions .small { padding: var(--space-xs) var(--space-md); font-size: 0.75rem; }
	.color-custom-wrapper { position: relative; cursor: pointer; display: inline-flex; }
	.color-native-input { position: absolute; width: 0; height: 0; opacity: 0; pointer-events: none; }
	.cat-color-swatch.custom {
		display: flex; align-items: center; justify-content: center;
		font-size: 0.6rem; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5); cursor: pointer;
	}

	/* A refusal said in the window (also in the Dependencies, Files and template sections) */
	.dep-error {
		margin-bottom: 8px; padding: 7px 10px;
		font-size: 0.74rem; line-height: 1.4;
		background: rgba(244, 63, 94, 0.1); color: var(--accent-rose);
		border: 1px solid rgba(244, 63, 94, 0.25); border-radius: var(--radius-sm);
	}
	/*
	 * A change the window made that was not saved: it stays until closed, at
	 * the top of the window however far it is scrolled. Its tint is laid on
	 * the window's own colour, so what scrolls under it does not show through.
	 */
	.window-error {
		display: flex; align-items: flex-start; gap: 8px;
		position: sticky; top: 0; z-index: 1;
		background: linear-gradient(rgba(244, 63, 94, 0.1), rgba(244, 63, 94, 0.1)), var(--bg-surface);
	}
	.window-error span { flex: 1; }
	.window-error-close {
		background: none; border: none; cursor: pointer; padding: 0 2px;
		color: inherit; font-size: 0.7rem; opacity: 0.7;
	}
	.window-error-close:hover { opacity: 1; }

	.btn-danger {
		display: inline-flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md); background: rgba(244, 63, 94, 0.1);
		color: var(--accent-rose); border-radius: var(--radius-sm);
		font-weight: 500; font-size: 0.85rem; border: 1px solid rgba(244, 63, 94, 0.2);
	}
	.btn-danger:hover { background: rgba(244, 63, 94, 0.2); }

	/* On Hold note display */
	.on-hold-note-display {
		background: rgba(239, 68, 68, 0.06); border: 1px solid rgba(239, 68, 68, 0.15);
		border-radius: var(--radius-md); padding: var(--space-md);
		margin-bottom: var(--space-lg);
	}
	.on-hold-label {
		font-size: 0.75rem; font-weight: 700; color: var(--accent-rose);
		text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-xs);
		display: flex; align-items: center; gap: var(--space-sm);
	}
	.on-hold-edit-btn {
		padding: 2px 6px !important; opacity: 0.5; font-size: 0.7rem;
	}
	.on-hold-edit-btn:hover { opacity: 1; }
	.on-hold-note-text {
		font-size: 0.85rem; color: var(--text-secondary); font-style: italic; line-height: 1.5; margin: 0;
	}
	.on-hold-edit {
		width: 100%; padding: var(--space-sm); border-radius: var(--radius-sm);
		background: var(--bg-base); border: 1px solid rgba(239, 68, 68, 0.2);
		color: var(--text-primary); font-family: var(--font-family); font-size: 0.85rem;
		resize: vertical; margin-top: var(--space-xs);
	}
	.on-hold-edit:focus { outline: none; border-color: var(--accent-rose); }

	/* ─── Cover ──────────────────────────────────────────── */
	.modal-cover-preview {
		height: 8px; margin: calc(-1 * var(--space-lg)) calc(-1 * var(--space-lg)) var(--space-md);
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
	}

	/* Modal cover preview strip */
	.modal-cover-preview { height: 6px; border-radius: var(--radius-xl) var(--radius-xl) 0 0; }

	/* Footer */
	.modal-footer {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-lg) var(--space-xl);
		border-top: 1px solid var(--glass-border); margin-top: var(--space-xl);
	}
	.footer-left { display: flex; align-items: center; gap: var(--space-md); }
	.footer-right { display: flex; align-items: center; gap: var(--space-md); }

	/* The template's labels on a new card: read-only, drawn as the label picker draws one not on the card */
	.template-labels {
		display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
		padding: var(--space-md) var(--space-xl) 0;
	}
	.template-labels-title { font-size: 0.72rem; color: var(--text-tertiary); margin-right: 4px; }
	.template-label {
		padding: 3px 10px; border-radius: var(--radius-full);
		font-size: 0.7rem; font-weight: 600;
		border: 1.5px solid var(--lc); color: var(--lc);
	}

	.template-btn {
		display: inline-flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md); font-size: 0.75rem;
		color: var(--text-tertiary); background: transparent;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		cursor: pointer; transition: all 0.15s;
	}
	.template-btn:hover { color: var(--text-secondary); border-color: var(--text-tertiary); }

	.btn-cancel {
		padding: var(--space-sm) var(--space-lg); font-size: 0.82rem; font-weight: 500;
		color: var(--text-secondary); background: transparent; border: none;
		border-radius: var(--radius-sm); cursor: pointer; transition: all 0.15s;
	}
	.btn-cancel:hover { color: var(--text-primary); background: var(--glass-hover); }

	.btn-create {
		padding: 8px 20px; font-size: 0.82rem; font-weight: 600;
		color: white; background: linear-gradient(135deg, var(--accent-purple), var(--accent-indigo));
		border: none; border-radius: var(--radius-sm); cursor: pointer;
		transition: all 0.15s; box-shadow: var(--shadow-sm), var(--shadow-glow-purple);
	}
	.btn-create:hover { filter: brightness(1.08); transform: translateY(-1px); }
	.btn-create:active { transform: translateY(0); }
	.btn-create:disabled { opacity: 0.35; cursor: not-allowed; transform: none; filter: none; }

	/* Keyboard shortcut hint */
	.shortcut-hint {
		font-size: 0.6rem; color: var(--text-tertiary);
		padding: var(--space-xs) var(--space-xl) var(--space-lg); text-align: right;
	}
	.shortcut-hint kbd {
		display: inline-block; padding: 1px 5px; font-family: var(--font-family);
		font-size: 0.6rem; color: var(--text-tertiary);
		background: var(--bg-elevated); border: 1px solid var(--glass-border); border-radius: 3px;
	}

	/* Advanced section (progressive disclosure) */
	.advanced-section { margin-top: var(--space-xl); }
	.advanced-toggle {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md); font-size: 0.78rem; font-weight: 500;
		color: var(--text-tertiary); background: transparent; border: none;
		border-radius: var(--radius-sm); cursor: pointer; transition: all 0.15s; user-select: none;
	}
	.advanced-toggle:hover { color: var(--text-secondary); background: var(--bg-elevated); }
	.advanced-toggle svg { transition: transform 0.25s ease; }
	.advanced-toggle.is-expanded svg { transform: rotate(90deg); }
	.advanced-content { margin-top: var(--space-lg); display: flex; flex-direction: column; gap: var(--space-lg); animation: fadeIn 0.2s ease; }
</style>
