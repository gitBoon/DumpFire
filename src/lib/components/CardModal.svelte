<script lang="ts">
	/**
	 * CardModal — The full card editor modal.
	 *
	 * Handles editing card properties (title, description, priority, colour,
	 * category, due date), managing subtasks, labels, and sub-boards.
	 * Supports both create and edit modes.
	 */
	import SubtaskModal from './SubtaskModal.svelte';
	import LabelPicker from './LabelPicker.svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { COLUMN_COLORS } from '$lib/utils/constants';
	import { COVER_PRESETS, isCoverValue } from '$lib/colours';
	import { drawnColour } from '$lib/colours';
	import { priorityToCopy } from '$lib/utils/card-utils';
	import { completionPercent } from '$lib/progress';
	import { formatTokens } from '$lib/tokens';
	import { costOf, costInputOf, formatUsd, unpricedReason, BLEND_NOTE, SOURCE_NOTE, NOT_BILLED_NOTE, UNPRICED_SUM_NOTE } from '$lib/pricing';
	import { templateLabelIds } from '$lib/templates';
	import { parseStamp, stamp } from '$lib/timestamps';
	import { daysUntilDue, formatDueDate } from '$lib/utils/date-utils';
	import { answerBody, deleteFailure, dependencyEndBody, dependencyRow, failureMessage, uploadFailure, uploadNoAnswer, uploadNotRead } from '$lib/api';
	import {
		THEMES,
		RELEASE_STATES,
		CLOSE_REASONS,
		CUSTOMER_IMPACTS,
		SUMMARY_MAX,
		FIELD_HINTS
	} from '$lib/reporting';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
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
		milestones = []
	}: {
		card: CardType | null;
		categories: CategoryType[];
		labels: LabelType[];
		boardId: number;
		boardUsers?: { id: number; username: string; email?: string; emoji: string }[];
		onSave: (data: { title: string; description: string; priority: string; categoryId: number | null; dueDate: string | null; onHoldNote?: string; businessValue?: string; summary?: string | null; theme?: string | null; customerImpact?: string | null; closeReason?: string | null; releaseState?: string | null; pendingSubtasks?: string[]; pendingAssigneeIds?: number[]; pendingSubBoards?: string[]; pendingLabelIds?: number[] }) => void;
		onDelete?: () => void;
		onClose: () => void;
		onCreateSubBoard?: (name: string) => void;
		onDeleteSubBoard?: (boardId: number) => void;
		onLinkSubBoard?: (boardId: number) => void;
		availableBoards?: { id: number; name: string; emoji: string }[];
		milestones?: MilestoneType[];
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

	// Pending subtasks for new card creation (full objects, not just titles)
	type PendingSubtask = {
		id: number; // temp local ID
		title: string;
		description: string;
		priority: string;
		colorTag: string;
		dueDate: string | null;
		completed: boolean;
	};
	let pendingSubtasks = $state<PendingSubtask[]>([]);
	let pendingIdCounter = $state(-1); // negative IDs for temp items

	// svelte-ignore state_referenced_locally — intentional: initialize form fields from prop snapshot
	let title = $state(card?.title || '');
	let description = $state(card?.description || '');
	let priority = $state(card?.priority || 'medium');

	// svelte-ignore state_referenced_locally
	let categoryId = $state<number | null>(card?.categoryId ?? null);
	let dueDate = $state(card?.dueDate || '');
	let showDueDate = $state(!!card?.dueDate);
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

	/** How much is filled in, shown on the collapsed header so it is not forgotten. */
	let reportingFilledCount = $derived(
		[summary, theme, customerImpact, closeReason, releaseState].filter((v) => !!v && v.trim() !== '')
			.length
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

	function getPriorityColor(p: string) {
		const m: Record<string, string> = { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e' };
		return m[p] || '#eab308';
	}

	function getPriorityEmoji(p: string) {
		const m: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
		return m[p] || '🟡';
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

	/** Shown at once, and put back as it was if the server does not save it. */
	async function setCover(value: string) {
		const was = coverUrl;
		coverUrl = value;
		if (!card) return;
		windowError = '';
		let res: Response;
		try {
			res = await fetch(`/api/cards/${card.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ coverUrl: value || null, boardId })
			});
		} catch {
			coverUrl = was;
			windowError = NO_ANSWER;
			return;
		}
		if (!res.ok) {
			coverUrl = was;
			windowError = await failureMessage(res, 'The cover was not changed.');
		}
	}

	/** No cover: sent as null, which is what an empty one is. */
	async function clearCover() {
		await setCover('');
	}
	let cardSubtasks = $state<SubtaskType[]>(card?.subtasks || []);

	// Inline category creation state
	let showNewCategory = $state(false);
	let newCatName = $state('');
	let newCatColor = $state('#6366f1');
	let localCategories = $state<CategoryType[]>([...categories]);
	// What the picker offers: this board's categories and the shared ones, of
	// no board, which are everybody's. The server files a card under nothing
	// else (card 2117, R3); the page passes those of every board the caller can
	// open, and one a card carries from a board they cannot, marked `carried`
	// (card 2128), which this leaves out too. A card already filed under
	// another board's keeps it, and its chip still names it.
	const pickableCategories = $derived(localCategories.filter((c) => c.boardId === boardId || c.boardId === null));

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

	async function assignUser(userId: number) {
		const user = boardUsers.find(u => u.id === userId);
		if (!user) return;

		if (card) {
			// Existing card — assign via API
			windowError = '';
			let res: Response;
			try {
				res = await fetch(`/api/cards/${card.id}/assignees`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ userId })
				});
			} catch {
				windowError = NO_ANSWER;
				return;
			}
			if (!res.ok) {
				windowError = await failureMessage(res, `${user.username} was not assigned.`);
				return;
			}
			cardAssignees = [...cardAssignees, { id: user.id, username: user.username, emoji: user.emoji }];
		} else {
			// New card — queue locally
			cardAssignees = [...cardAssignees, { id: user.id, username: user.username, emoji: user.emoji }];
		}
	}

	async function unassignUser(userId: number) {
		if (card) {
			// Taken off the list only once the server has taken them off the card.
			const cardId = card.id;
			windowError = '';
			const failure = await deleteFailure(
				() =>
					fetch(`/api/cards/${cardId}/assignees`, {
						method: 'DELETE',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ userId })
					}),
				'assignee',
				'removed'
			);
			if (failure) {
				windowError = failure;
				return;
			}
		}
		cardAssignees = cardAssignees.filter(a => a.id !== userId);
	}

	let availableAssignees = $derived(
		boardUsers.filter(u => !cardAssignees.some(a => a.id === u.id))
	);

	// Subtask modal state
	let showSubtaskModal = $state(false);
	let editingSubtask = $state<SubtaskType | null>(null);
	let editingPendingSubtask = $state<PendingSubtask | null>(null);

	// Template state
	type TemplateItem = { id: number; name: string; title: string; description: string; priority: string; subtasksJson: string; labelsJson: string; boardId: number | null };
	let templates = $state<TemplateItem[]>([]);
	let showTemplatePicker = $state(false);
	let showSaveTemplate = $state(false);
	let templateName = $state('');
	let templateSaving = $state(false);

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

	async function saveAsTemplate() {
		if (!templateName.trim()) return;
		templateSaving = true;
		templateError = '';
		try {
			let res: Response;
			try {
				res = await fetch('/api/templates', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						boardId,
						name: templateName.trim(),
						title: title,
						description: description,
						priority: priority,
						// A subtask's description may be stored as null, which a template's
						// reader refuses as no text (card 2117): none is empty text. A
						// priority stored that is not one of the four is left out, and the
						// template's step is medium, where the template was refused.
						subtasks: card ? cardSubtasks.map(s => ({ title: s.title, description: s.description ?? '', priority: priorityToCopy(s.priority) })) : [],
						labels: cardLabelIds
					})
				});
			} catch {
				templateError = NO_ANSWER;
				return;
			}
			if (!res.ok) {
				// The dialog stays open, with the name as it was typed.
				templateError = await failureMessage(res, 'The template was not saved.');
				return;
			}
			showSaveTemplate = false;
			templateName = '';
		} finally {
			templateSaving = false;
		}
	}

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

	async function deleteTemplate(id: number) {
		templateError = '';
		const failure = await deleteFailure(() => fetch(`/api/templates/${id}`, { method: 'DELETE' }), 'template');
		if (failure) {
			// It stays in the list: somebody else's template is refused.
			templateError = failure;
			return;
		}
		templates = templates.filter(t => t.id !== id);
	}

	function save() {
		if (!title.trim()) {
			titleError = true;
			setTimeout(() => (titleError = false), 1500);
			return;
		}
		// No colour tag: the window has no control for one, and the empty one it
		// sent cleared a tag set through the API at every save (card 2147).
		onSave({
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
		if (e.key !== 'Escape') return;
		// A confirmation the page opened over this window, such as All Tasks' or
		// the board page's "Archive Card", answers Escape itself, as Cancel. It
		// used to close this window as well, and with it what was typed in it.
		const confirming = document.querySelector('.confirm-modal');
		if (confirming && !overlay?.contains(confirming)) return;
		onClose();
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

	async function toggleSubtask(subtask: SubtaskType) {
		windowError = '';
		let res: Response;
		try {
			res = await fetch(`/api/subtasks/${subtask.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ completed: !subtask.completed, boardId })
			});
		} catch {
			windowError = NO_ANSWER;
			return;
		}
		if (!res.ok) {
			windowError = await failureMessage(res, 'The subtask was not changed.');
			return;
		}
		subtask.completed = !subtask.completed;
		cardSubtasks = [...cardSubtasks];
	}

	$effect(() => {
		if (card) cardSubtasks = card.subtasks || [];
	});

	const completedCount = $derived(cardSubtasks.filter((st) => st.completed).length);
	const totalCount = $derived(cardSubtasks.length);
	const progress = $derived(completionPercent(completedCount, totalCount));

	// ─── Token cost ──────────────────────────────────────────────────────────
	// What this card actually cost, loaded on open. `recorded: false` means
	// nothing has ever been reported — every card predating the ledger is in
	// that state, and it must read as "not recorded" rather than as zero.
	interface TokenLedger {
		recorded: boolean;
		total: number;
		costUsd: number | null;
		costExact: boolean;
		unpricedTokens: number;
		direct: number;
		fromSubtasks: number;
		entries: number;
		byModel: { model: string; tokens: number }[];
		entryList: {
			id: number;
			subtaskId: number | null;
			subtaskTitle: string | null;
			tokens: number;
			model: string | null;
			inputTokens: number | null;
			outputTokens: number | null;
			cacheReadTokens: number | null;
			cacheWrite5mTokens: number | null;
			cacheWrite1hTokens: number | null;
			note: string | null;
			createdAt: string;
		}[];
	}
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
		const id = card?.id;
		if (!id) { tokenLedger = null; return; }
		let cancelled = false;
		fetch(`/api/cards/${id}/tokens`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => { if (!cancelled) tokenLedger = d; })
			.catch(() => { /* cost is supplementary — never block the card on it */ });
		return () => { cancelled = true; };
	});

	function getPriorityLabel(p: string) {
		const m: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
		return m[p] || '🟡';
	}

	function formatDue(d: string | null) {
		if (!d) return '';
		// A due date is a calendar day, counted from the viewer's own today (card 2241).
		const diff = daysUntilDue(d);
		const formatted = formatDueDate(d, { day: 'numeric', month: 'short' });
		if (diff === null) return `📅 ${formatted}`;
		if (diff < 0) return `⚠️ Overdue (${formatted})`;
		if (diff === 0) return `📅 Due today`;
		if (diff === 1) return `📅 Due tomorrow`;
		return `📅 ${formatted}`;
	}
	// ─── Tabs & Comments ────────────────────────────────────────────────────
	let activeTab = $state<'details' | 'comments' | 'attachments'>('details');

	type CommentItem = {
		id: number; cardId: number; userId: number; content: string;
		createdAt: string; updatedAt: string; username: string; userEmoji: string | null;
	};
	let comments = $state<CommentItem[]>([]);
	let newComment = $state('');
	let editingCommentId = $state<number | null>(null);
	let editingCommentText = $state('');
	let loadingComments = $state(false);

	let currentUser = $derived($page.data.user);

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

	async function addDependency(otherCardId: number) {
		if (!card || !pickerMode) return;
		depError = '';
		// The picker finds cards only.
		const body = dependencyEndBody(pickerMode, { kind: 'card', cardId: otherCardId });
		let res: Response;
		try {
			res = await fetch(`/api/cards/${card.id}/dependencies`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
		} catch {
			depError = NO_ANSWER;
			return;
		}
		if (res.ok) {
			const data = await res.json();
			blockedBy = data.blockedBy;
			blocks = data.blocks;
			pickerMode = null;
			pickerQuery = '';
			pickerResults = [];
		} else {
			// A rejected cycle names the loop it found, which is the whole value of
			// the check — surface the server's message rather than a generic error.
			depError = await failureMessage(res, 'Could not add that dependency');
		}
	}

	/** Remove the link the row `d` shows. A subtask row's id is the subtask's, and is sent as one. */
	async function removeDependency(d: DependencyRefType, mode: 'blocked-by' | 'blocks') {
		if (!card) return;
		depError = '';
		const body = dependencyEndBody(mode, d);
		let res: Response;
		try {
			res = await fetch(`/api/cards/${card.id}/dependencies`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
		} catch {
			depError = NO_ANSWER;
			return;
		}
		if (res.ok) {
			const data = await res.json();
			blockedBy = data.blockedBy;
			blocks = data.blocks;
		} else {
			// A link somebody else already removed is answered 404. Say so, where
			// this used to do nothing and leave the row looking removable.
			depError = await failureMessage(res, 'Could not remove that dependency');
			// And read the links again, as when the card was opened: the row
			// that was refused is the one that is out of date, and left in the
			// list it still looks removable beside a message saying it is gone.
			await loadDependencies();
		}
	}

	/**
	 * `select` shows the choice before the answer comes, and is put back to the
	 * milestone the card is in when the change is not made.
	 */
	async function saveMilestone(next: number | null, select?: HTMLSelectElement) {
		if (!card) return;
		milestoneSaving = true;
		depError = '';
		const putBack = () => {
			if (select) select.value = String(milestoneId ?? '');
		};
		try {
			const target = next ?? milestoneId;
			if (target === null) return;
			const res = await fetch(`/api/milestones/${target}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cardId: card.id, attach: next !== null })
			});
			if (res.ok) {
				milestoneId = next;
			} else {
				putBack();
				depError = await failureMessage(res, 'Could not change the milestone');
			}
		} catch {
			putBack();
			depError = NO_ANSWER;
		} finally {
			milestoneSaving = false;
		}
	}

	/** How many blockers are still open — what the "Blocked" state actually means. */
	const openBlockerCount = $derived(blockedBy.filter((d) => !d.resolved).length);

	async function loadComments() {
		if (!card) return;
		loadingComments = true;
		try {
			const res = await fetch(`/api/cards/${card.id}/comments`);
			if (res.ok) comments = await res.json();
		} finally { loadingComments = false; }
	}

	async function postComment() {
		if (!card || !newComment.trim()) return;
		windowError = '';
		let res: Response;
		try {
			res = await fetch(`/api/cards/${card.id}/comments`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: newComment.trim() })
			});
		} catch {
			windowError = NO_ANSWER;
			return;
		}
		if (!res.ok) {
			// What was written stays in the box.
			windowError = await failureMessage(res, 'The comment was not posted.');
			return;
		}
		const created = await res.json();
		comments = [created, ...comments];
		newComment = '';
	}

	async function deleteComment(commentId: number) {
		if (!card) return;
		const cardId = card.id;
		windowError = '';
		const failure = await deleteFailure(() => fetch(`/api/cards/${cardId}/comments/${commentId}`, { method: 'DELETE' }), 'comment');
		if (failure) {
			windowError = failure;
			return;
		}
		comments = comments.filter(c => c.id !== commentId);
	}

	async function saveEditComment(commentId: number) {
		if (!card || !editingCommentText.trim()) return;
		windowError = '';
		let res: Response;
		try {
			res = await fetch(`/api/cards/${card.id}/comments/${commentId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: editingCommentText.trim() })
			});
		} catch {
			windowError = NO_ANSWER;
			return;
		}
		if (!res.ok) {
			// Still open to edit, with what was written.
			windowError = await failureMessage(res, 'The comment was not saved.');
			return;
		}
		comments = comments.map(c => c.id === commentId ? { ...c, content: editingCommentText.trim(), updatedAt: stamp() } : c);
		editingCommentId = null;
		editingCommentText = '';
	}

	function commentTimeAgo(dateStr: string): string {
		const then = parseStamp(dateStr)?.getTime();
		if (then === undefined) return '';
		const diff = Math.floor((Date.now() - then) / 1000);
		if (diff < 60) return 'just now';
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return `${Math.floor(diff / 86400)}d ago`;
	}

	// ─── Attachments ─────────────────────────────────────────────────────
	type AttachmentItem = {
		id: number; cardId: number; filename: string; originalName: string;
		mimeType: string; sizeBytes: number; uploadedBy: number | null; createdAt: string;
	};
	let attachments = $state<AttachmentItem[]>([]);
	let loadingAttachments = $state(false);
	let uploading = $state(false);
	let dragOver = $state(false);

	async function loadAttachments() {
		if (!card) return;
		loadingAttachments = true;
		try {
			const res = await fetch(`/api/cards/${card.id}/attachments`);
			if (res.ok) attachments = await res.json();
		} finally { loadingAttachments = false; }
	}

	/**
	 * Why each file of the last upload that was not attached was not, a line
	 * a file. It stays until the next upload: a file that fails used to be
	 * dropped without a word.
	 */
	let uploadErrors = $state<string[]>([]);

	async function uploadFiles(files: FileList | File[]) {
		if (!card) return;
		uploading = true;
		uploadErrors = [];
		try {
			for (const file of files) {
				const failure = await uploadFile(card.id, file);
				if (failure) uploadErrors = [...uploadErrors, failure];
			}
		} finally {
			// Whatever happened. A request that threw used to leave this set, and
			// the tab saying "Uploading..." until the card was closed.
			uploading = false;
		}
	}

	/**
	 * Attach one file to the card. Null once it is attached, and if it is not,
	 * which of the four things went wrong: see `uploadFailure` in `$lib/api`.
	 */
	async function uploadFile(cardId: number, file: File): Promise<string | null> {
		const what = `"${file.name}"`;

		// The first: it cannot be read here, a folder that was dropped or a file
		// that has moved since. Asked for one byte, so that it is known before
		// the request and not taken for a server that gave no answer.
		try {
			await file.slice(0, 1).arrayBuffer();
		} catch {
			return uploadNotRead(what);
		}

		const form = new FormData();
		form.append('file', file);

		// The second: no answer.
		let res: Response;
		try {
			res = await fetch(`/api/cards/${cardId}/attachments`, {
				method: 'POST',
				body: form
			});
		} catch {
			return uploadNoAnswer(what);
		}

		// The third and the fourth, and anything else the server said of it.
		const created = res.ok ? await answerBody(res.clone()) : null;
		if (created === null) return uploadFailure(res, what);

		attachments = [...attachments, created as AttachmentItem];
		return null;
	}

	async function deleteAttachment(id: number) {
		if (!card) return;
		const cardId = card.id;
		windowError = '';
		const failure = await deleteFailure(() => fetch(`/api/cards/${cardId}/attachments/${id}`, { method: 'DELETE' }), 'attachment');
		if (failure) {
			windowError = failure;
			// And the list is read again, as when the tab was opened: a file
			// somebody else deleted first is the row known to be out of date.
			await loadAttachments();
			return;
		}
		attachments = attachments.filter(a => a.id !== id);
	}

	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	/**
	 * The attachments the server answers as an image, which are the only ones
	 * an <img> can show: PNG, JPEG, GIF and WebP, and each by both the type
	 * stored with the upload and the extension of its name. Everything else is
	 * answered as a download, an SVG among them, and gets the ordinary file row.
	 * Keep in step with `attachmentHeaders` in `$lib/server/uploads.ts`.
	 */
	const SHOWN_AS_IMAGE: { stored: string; extensions: string[] }[] = [
		{ stored: 'image/png', extensions: ['png'] },
		{ stored: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
		{ stored: 'image/gif', extensions: ['gif'] },
		{ stored: 'image/webp', extensions: ['webp'] }
	];

	function isShownAsImage(att: { originalName: string; mimeType: string }): boolean {
		const extension = /\.([A-Za-z0-9]+)$/.exec(String(att.originalName ?? ''))?.[1].toLowerCase() ?? '';
		const stored = String(att.mimeType ?? '').split(';')[0].trim().toLowerCase();
		return SHOWN_AS_IMAGE.some((type) => type.stored === stored && type.extensions.includes(extension));
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		dragOver = true;
	}
</script>

<!--
	The dependency picker, shared by both directions. Searches by "#id" or title
	across every board the user can see, because dependencies are deliberately
	cross-board — a migration touches several projects and the picker has to
	reach those cards. Foreign cards show as "Board / column".
-->
{#snippet depPicker(placeholder: string)}
	<div class="dep-picker">
		<!-- svelte-ignore a11y_autofocus -->
		<input
			class="dep-picker-input"
			type="text"
			{placeholder}
			bind:value={pickerQuery}
			oninput={onPickerInput}
			onkeydown={(e) => { if (e.key === 'Escape') { pickerMode = null; pickerQuery = ''; pickerResults = []; } }}
			autofocus
		/>
		<button class="dep-picker-cancel" title="Cancel" onclick={() => { pickerMode = null; pickerQuery = ''; pickerResults = []; }}>✕</button>
	</div>
	{#if pickerSearching}
		<p class="dep-empty">Searching…</p>
	{:else if pickerQuery.trim() && pickerResults.length === 0}
		<p class="dep-empty">No cards match “{pickerQuery.trim()}”.</p>
	{:else if pickerResults.length > 0}
		<div class="dep-results">
			{#each pickerResults as r}
				<button class="dep-result" onclick={() => addDependency(r.id)}>
					<span class="dep-id">#{r.id}</span>
					<span class="dep-title">{r.title}</span>
					<span class="dep-where">{r.boardEmoji} {r.boardName} / {r.columnName}</span>
				</button>
			{/each}
		</div>
	{/if}
{/snippet}

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
		<div class="title-field" class:title-error={titleError}>
			<input id="card-title" class="modal-title-input" type="text" placeholder="What needs to be done?" maxlength="500" bind:value={title} oninput={() => (titleError = false)} onkeydown={(e) => e.key === 'Enter' && !e.shiftKey && save()} autofocus />
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
				<div class="form-group">
					<div class="desc-header">
						<label for="card-desc">Description</label>
				<div class="desc-tabs">
					<button class="desc-tab" class:active={!descPreview} onclick={() => (descPreview = false)}>Write</button>
					<button class="desc-tab" class:active={descPreview} onclick={() => (descPreview = true)}>Preview</button>
				</div>
			</div>
			{#if descPreview}
				<div class="desc-preview markdown-body">
					{#if description.trim()}
						{@html renderMarkdown(description)}
					{:else}
						<p class="desc-empty">Nothing to preview</p>
					{/if}
				</div>
			{:else}
			<textarea id="card-desc" placeholder="Add a description…" maxlength="50000" bind:value={description} rows="3"></textarea>
			{/if}
			<div class="desc-hint">Supports markdown formatting</div>
		</div>

		<!-- Metadata chips -->
		<div class="metadata-section">
			<div class="metadata-label">Details</div>
			<div class="metadata-row">
				<!-- Priority chip -->
				<div class="dropdown-wrapper">
					<button class="chip" onclick={(e) => { e.stopPropagation(); toggleDrop('priority'); }}>
						<span class="chip-dot" style="background: {drawnColour(getPriorityColor(priority))}"></span>
						<span>{priority.charAt(0).toUpperCase() + priority.slice(1)}</span>
						<svg class="chip-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
					</button>
					{#if showPriorityDrop}
					<div class="chip-dropdown" onclick={(e) => e.stopPropagation()}>
						{#each ['critical', 'high', 'medium', 'low'] as p}
							<button class="chip-dropdown-item" class:selected={priority === p} onclick={() => { priority = p; showPriorityDrop = false; }}>
								<span class="chip-dot" style="background: {drawnColour(getPriorityColor(p))}"></span>
								{p.charAt(0).toUpperCase() + p.slice(1)}
							</button>
						{/each}
					</div>
					{/if}
				</div>

				<!-- Category chip -->
				<div class="dropdown-wrapper">
					<button class="chip" class:is-set={categoryId} onclick={(e) => { e.stopPropagation(); toggleDrop('category'); }}>
						<svg class="chip-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h6v6H4z"/><path d="M14 4h6v6h-6z"/><path d="M4 14h6v6H4z"/><path d="M14 14h6v6h-6z"/></svg>
						<span>{categoryId ? localCategories.find(c => c.id === categoryId)?.name || 'Category' : 'Category'}</span>
						<svg class="chip-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
					</button>
					{#if showCategoryDrop}
					<div class="chip-dropdown" onclick={(e) => e.stopPropagation()}>
						<button class="chip-dropdown-item" class:selected={!categoryId} onclick={() => { categoryId = null; showCategoryDrop = false; }}>None</button>
						{#each pickableCategories as cat}
							<button class="chip-dropdown-item" class:selected={categoryId === cat.id} onclick={() => { categoryId = cat.id; showCategoryDrop = false; }}>
								<span class="chip-dot" style="background: {drawnColour(cat.color)}"></span>
								{cat.name}
							</button>
						{/each}
						<div class="chip-dropdown-divider"></div>
						<button class="chip-dropdown-item" onclick={() => { showNewCategory = true; showCategoryDrop = false; }}>+ New Category</button>
					</div>
					{/if}
				</div>

				<!-- Due date chip -->
				<div class="dropdown-wrapper">
					<button class="chip" class:is-set={dueDate} onclick={(e) => { e.stopPropagation(); toggleDrop('due'); }}>
						<svg class="chip-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
						<span>{dueDate ? formatDueDate(dueDate, {day:'numeric',month:'short'}) : 'Due date'}</span>
						<svg class="chip-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
					</button>
					{#if showDueDateDrop}
					<div class="chip-dropdown" onclick={(e) => e.stopPropagation()}>
						<button class="chip-dropdown-item" class:selected={!dueDate} onclick={() => { dueDate = ''; showDueDateDrop = false; }}>No date</button>
						<div class="chip-dropdown-divider"></div>
						<div style="padding: 4px 8px;">
							<input type="date" bind:value={dueDate} onchange={() => { showDueDateDrop = false; }} style="width: 100%; font-size: 0.82rem;" />
						</div>
					</div>
					{/if}
				</div>

				<!-- Assignee chip -->
				<div class="dropdown-wrapper">
					<button class="chip" class:is-set={cardAssignees.length > 0} onclick={(e) => { e.stopPropagation(); toggleDrop('assignee'); }}>
						<svg class="chip-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
						<span>{cardAssignees.length > 0 ? cardAssignees.map(a => a.username).join(', ') : 'Assign'}</span>
						<svg class="chip-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
					</button>
					{#if showAssigneeDrop}
					<div class="chip-dropdown" onclick={(e) => e.stopPropagation()}>
						{#each cardAssignees as a}
							<button class="chip-dropdown-item selected" onclick={() => unassignUser(a.id)}>
								{a.emoji} {a.username} ✕
							</button>
						{/each}
						{#if cardAssignees.length > 0 && availableAssignees.length > 0}
							<div class="chip-dropdown-divider"></div>
						{/if}
						{#each availableAssignees as u}
							<button class="chip-dropdown-item" onclick={() => assignUser(u.id)}>
								{u.emoji} {u.username}
							</button>
						{/each}
					</div>
					{/if}
				</div>
			</div>
		</div>

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
		<div class="form-group reporting-group">
			<button type="button" class="reporting-toggle" onclick={() => (showReporting = !showReporting)}>
				<span class="reporting-caret" class:open={showReporting}>▸</span>
				Reporting
				{#if !showReporting && reportingFilledCount > 0}
					<span class="reporting-count">{reportingFilledCount} of 5 recorded</span>
				{/if}
			</button>

			{#if showReporting}
				<div class="reporting-fields">
					<div class="reporting-row">
						<label for="card-summary">Summary</label>
						<input
							id="card-summary"
							type="text"
							maxlength={SUMMARY_MAX}
							placeholder="Plain English, about 12 words"
							bind:value={summary}
						/>
						<small>{FIELD_HINTS.summary}</small>
					</div>

					<div class="reporting-grid">
						<div class="reporting-row">
							<label for="card-theme">Theme</label>
							<select id="card-theme" bind:value={theme}>
								<option value="">Not recorded</option>
								{#each THEMES as t}<option value={t}>{t}</option>{/each}
							</select>
						</div>

						<div class="reporting-row">
							<label for="card-release">Release state</label>
							<select id="card-release" bind:value={releaseState}>
								<option value="">Not recorded</option>
								{#each RELEASE_STATES as r}<option value={r}>{r}</option>{/each}
							</select>
						</div>

						<div class="reporting-row">
							<label for="card-close">Close reason</label>
							<select id="card-close" bind:value={closeReason}>
								<option value="">Not recorded</option>
								{#each CLOSE_REASONS as r}<option value={r}>{r}</option>{/each}
							</select>
						</div>

						<div class="reporting-row">
							<label for="card-impact">Customer impact</label>
							<input
								id="card-impact"
								type="text"
								list="customer-impact-options"
								placeholder="none / internal / live customers: Who"
								bind:value={customerImpact}
							/>
							<datalist id="customer-impact-options">
								{#each CUSTOMER_IMPACTS as c}<option value={c}></option>{/each}
							</datalist>
						</div>
					</div>
					<small class="reporting-note">{FIELD_HINTS.closeReason}</small>
				</div>
			{/if}
		</div>

		<!-- On Hold Note -->
		{#if card?.onHoldNote}
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
		{#if card}
			<div class="subtasks-section">
				<div class="subtask-header">
					<label>
						Subtasks
						{#if totalCount > 0}
							<span class="subtask-counter">{completedCount}/{totalCount}</span>
						{/if}
					</label>
					<button class="btn-ghost add-st-btn" onclick={openNewSubtask}>
						<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
							<path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
						</svg>
						Add
					</button>
				</div>

				{#if totalCount > 0}
					<div class="progress-bar-container">
						<div class="progress-bar" style="width: {progress}%" class:complete={progress === 100}></div>
					</div>
				{/if}

				{#if card && tokenLedger}
					<!-- What this cost. Sits with the progress bar because "how much is
					     done" and "what it took" are the same question asked twice. -->
					<div class="token-cost">
						{#if tokenLedger.recorded}
							<button class="token-summary" onclick={() => (tokensExpanded = !tokensExpanded)} type="button">
								<span class="token-label">Cost</span>
								<span class="token-total">{formatTokens(tokenLedger.total)}</span>
								{#if tokenLedger.costUsd !== null}
									<span class="token-money" title="{NOT_BILLED_NOTE}. {SOURCE_NOTE}{tokenLedger.costExact ? ' — exact, from reported input/output splits' : ` — ${BLEND_NOTE}`}.">
										{formatUsd(tokenLedger.costUsd)}{#if !tokenLedger.costExact}<span class="token-est">est</span>{/if}
									</span>
								{/if}
								<span class="token-sub">
									tokens{#if tokenLedger.fromSubtasks !== 0} · incl. {formatTokens(tokenLedger.fromSubtasks)} from subtasks{/if}{#if tokenLedger.unpricedTokens > 0} · <span class="token-unpriced" title="Tokens {UNPRICED_SUM_NOTE}, so they cannot be priced.">{formatTokens(tokenLedger.unpricedTokens)} unpriced</span>{/if}
								</span>
								<span class="token-chevron" class:open={tokensExpanded}>▾</span>
							</button>
							{#if tokensExpanded}
								{#if tokenLedger.byModel.length > 1}
									<div class="token-models">
										{#each tokenLedger.byModel as m}
											<span class="token-model-chip">{m.model} · {formatTokens(m.tokens)}</span>
										{/each}
									</div>
								{/if}
								<ul class="token-entries">
									{#each tokenLedger.entryList as e}
										{@const eCost = costOf([costInputOf(e)]).usd}
										<!-- Priced as the card's total is, so the rows add up to it. -->
										<li class="token-entry" class:negative={e.tokens < 0}>
											<span class="te-amount">{e.tokens > 0 ? '+' : ''}{formatTokens(e.tokens)}</span>
											<span class="te-what">
												{#if e.subtaskTitle}<span class="te-scope">{e.subtaskTitle}</span>{/if}
												{#if e.note}<span class="te-note">{e.note}</span>{/if}
												{#if !e.subtaskTitle && !e.note}<span class="te-note te-plain">card</span>{/if}
											</span>
											{#if e.model}<span class="te-model">{e.model}</span>{/if}
											<span class="te-cost" title={eCost === null ? unpricedReason(e.model) : undefined}>{formatUsd(eCost)}</span>
										</li>
									{/each}
								</ul>
							{/if}
						{:else}
							<div class="token-summary token-none">
								<span class="token-label">Cost</span>
								<span class="token-sub">Not recorded</span>
							</div>
						{/if}
					</div>
				{/if}

				<div class="subtask-list">
					{#each cardSubtasks as subtask (subtask.id)}
						<div class="subtask-item" class:completed={subtask.completed}>
							<button class="subtask-checkbox" class:checked={subtask.completed} onclick={(e) => { e.stopPropagation(); toggleSubtask(subtask); }}>
								{#if subtask.completed}
									<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
										<path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
									</svg>
								{/if}
							</button>
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<div class="subtask-info" onclick={() => openEditSubtask(subtask)} role="button" tabindex="0">
								<div class="subtask-title-row">
									<span class="st-priority">{getPriorityLabel(subtask.priority)}</span>
									<span class="subtask-title">{subtask.title}</span>
									{#if subtaskCost.get(subtask.id)}
										{@const sc = subtaskCost.get(subtask.id)!}
										<span class="st-cost" title="{formatTokens(sc.tokens)} tokens · {NOT_BILLED_NOTE}. {SOURCE_NOTE} — {BLEND_NOTE}.">
											{formatTokens(sc.tokens)}{#if sc.costUsd !== null} · {formatUsd(sc.costUsd)}{/if}
										</span>
									{/if}
								</div>
								{#if subtask.description || subtask.dueDate}
									<div class="subtask-detail-row">
										{#if subtask.description}
											<span class="st-desc-preview">{subtask.description.slice(0, 60)}{subtask.description.length > 60 ? '…' : ''}</span>
										{/if}
										{#if subtask.dueDate}
											<span class="st-due" class:overdue={(daysUntilDue(subtask.dueDate) ?? 0) < 0}>
												{formatDue(subtask.dueDate)}
											</span>
										{/if}
									</div>
								{/if}
							</div>
						</div>
					{/each}
				</div>

				{#if totalCount === 0}
					<button class="add-subtask-inline" onclick={openNewSubtask}>
						<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
						Add subtask
					</button>
				{/if}
			</div>
		{:else}
			<!-- New card: rich subtask management -->
			<div class="subtasks-section">
				<div class="subtask-header">
					<label>
						Subtasks
						{#if pendingSubtasks.length > 0}
							<span class="subtask-counter">{pendingSubtasks.length}</span>
						{/if}
					</label>
					<button class="btn-ghost add-st-btn" onclick={openNewPendingSubtask}>
						<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
							<path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
						</svg>
						Add
					</button>
				</div>

				<div class="subtask-list">
					{#each pendingSubtasks as ps (ps.id)}
						<div class="subtask-item pending">
							<span class="st-priority">{getPriorityLabel(ps.priority)}</span>
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<div class="subtask-info" onclick={() => openEditPendingSubtask(ps)} role="button" tabindex="0">
								<div class="subtask-title-row">
									<span class="subtask-title">{ps.title}</span>
								</div>
								{#if ps.description || ps.dueDate}
									<div class="subtask-detail-row">
										{#if ps.description}
											<span class="st-desc-preview">{ps.description.slice(0, 60)}{ps.description.length > 60 ? '…' : ''}</span>
										{/if}
										{#if ps.dueDate}
											<span class="st-due">{formatDue(ps.dueDate)}</span>
										{/if}
									</div>
								{/if}
							</div>
							<button class="btn-ghost pending-remove" onclick={() => removePendingSubtask(ps.id)} title="Remove">
								<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
							</button>
						</div>
					{/each}
				</div>

				{#if pendingSubtasks.length === 0}
					<button class="add-subtask-inline" onclick={openNewPendingSubtask}>
						<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
						Add subtask
					</button>
				{/if}
			</div>
		{/if}

		{/if} <!-- end details tab / new card -->

		{#if card && activeTab === 'comments'}
		<!-- Comments Tab -->
		<div class="comments-section">
			<div class="comment-input-area">
				<textarea class="comment-input" placeholder="Write a comment... (supports **markdown**)" bind:value={newComment} rows="3" onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) postComment(); }}></textarea>
				<div class="comment-input-actions">
					<span class="comment-hint">Ctrl+Enter to send</span>
					<button class="btn-primary small" onclick={postComment} disabled={!newComment.trim()}>Post Comment</button>
				</div>
			</div>

			{#if loadingComments}
				<div class="comments-loading">Loading comments...</div>
			{:else if comments.length === 0}
				<div class="comments-empty">
					<span class="comments-empty-icon">💬</span>
					<p>No comments yet. Be the first to comment!</p>
				</div>
			{:else}
				<div class="comment-thread">
					{#each comments as comment (comment.id)}
						<div class="comment-item">
							<div class="comment-avatar">{comment.userEmoji || '👤'}</div>
							<div class="comment-body">
								<div class="comment-meta">
									<span class="comment-author">{comment.username}</span>
									<span class="comment-time">{commentTimeAgo(comment.createdAt)}</span>
									{#if comment.createdAt !== comment.updatedAt}<span class="comment-edited">(edited)</span>{/if}
								</div>
								{#if editingCommentId === comment.id}
									<textarea class="comment-edit-input" bind:value={editingCommentText} rows="3"></textarea>
									<div class="comment-edit-actions">
										<button class="btn-primary small" onclick={() => saveEditComment(comment.id)}>Save</button>
										<button class="btn-ghost small" onclick={() => (editingCommentId = null)}>Cancel</button>
									</div>
								{:else}
									<div class="comment-content markdown-body">{@html renderMarkdown(comment.content, { mentions: boardUsers.map((u) => u.username) })}</div>
									{#if currentUser && (currentUser.id === comment.userId || currentUser.role === 'admin' || currentUser.role === 'superadmin')}
										<div class="comment-actions">
											{#if currentUser.id === comment.userId}
												<button class="comment-action-btn" onclick={() => { editingCommentId = comment.id; editingCommentText = comment.content; }}>Edit</button>
											{/if}
											<button class="comment-action-btn danger" onclick={() => deleteComment(comment.id)}>Delete</button>
										</div>
									{/if}
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
		{/if}

		{#if card && activeTab === 'attachments'}
		<!-- Attachments Tab -->
		<div class="attachments-section">
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="upload-zone"
				class:drag-over={dragOver}
				ondrop={handleDrop}
				ondragover={handleDragOver}
				ondragleave={() => dragOver = false}
			>
				<span class="upload-icon">{uploading ? '⏳' : '📎'}</span>
				<p>{uploading ? 'Uploading...' : 'Drag & drop files here or click to browse'}</p>
				<input type="file" multiple class="upload-input" onchange={(e) => { const el = e.target as HTMLInputElement; if (el.files?.length) uploadFiles(el.files); el.value = ''; }} />
			</div>

			{#if uploadErrors.length > 0}
				<div class="dep-error" role="alert" style="margin-top: 8px">
					{#each uploadErrors as failure}
						<div>{failure}</div>
					{/each}
				</div>
			{/if}

			{#if loadingAttachments}
				<div class="comments-loading">Loading attachments...</div>
			{:else if attachments.length === 0}
				<div class="comments-empty">
					<span class="comments-empty-icon">📂</span>
					<p>No files attached yet. Upload files above.</p>
				</div>
			{:else}
				<div class="attachment-list">
					{#each attachments as att (att.id)}
						<div class="attachment-item">
							{#if isShownAsImage(att)}
								<a href="/api/cards/{card.id}/attachments/{att.id}" target="_blank" class="attachment-thumb">
									<img src="/api/cards/{card.id}/attachments/{att.id}" alt={att.originalName} />
								</a>
							{:else}
								<div class="attachment-icon">📄</div>
							{/if}
							<div class="attachment-info">
								<a href="/api/cards/{card.id}/attachments/{att.id}" class="attachment-name" target="_blank" download={att.originalName}>{att.originalName}</a>
								<span class="attachment-meta">{formatFileSize(att.sizeBytes)}</span>
							</div>
							<button class="attachment-delete" onclick={() => deleteAttachment(att.id)} title="Delete">
								<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2.5A.5.5 0 015.5 2h3a.5.5 0 01.5.5V4m1.5 0l-.5 8a1 1 0 01-1 1h-5a1 1 0 01-1-1l-.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
							</button>
						</div>
					{/each}
				</div>
			{/if}
		</div>
		{/if}

		</div> <!-- end main-panel -->

		<!-- New Category inline form -->
		{#if showNewCategory}
		<div class="inline-cat-form" style="margin-bottom: var(--space-lg);">
			<label style="font-size:0.75rem; font-weight:600; color:var(--text-secondary); margin-bottom:6px; display:block;">New Category</label>
			<input type="text" class="inline-cat-input" placeholder="Category name..." bind:value={newCatName} onkeydown={(e) => e.key === 'Enter' && createCategoryInline()} autofocus />
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
				<!--
					Planning: the two facts recorded by hand — what blocks this card,
					and which goal it belongs to. Everything derived from them lives in
					the planning view at /plan.
				-->
				{#if card}
				<div class="form-group">
					<label for="dep-milestone">Milestone</label>
					<div class="milestone-row">
						<select
							id="dep-milestone"
							class="milestone-select"
							value={milestoneId ?? ''}
							disabled={milestoneSaving}
							onchange={(e) => {
								const v = e.currentTarget.value;
								saveMilestone(v === '' ? null : Number(v), e.currentTarget);
							}}
						>
							<option value="">No milestone</option>
							{#each milestones as m}
								<option value={m.id}>{m.name}{m.boardId === null ? ' (cross-board)' : ''}</option>
							{/each}
						</select>
						{#if milestoneId}
							<a class="milestone-plan-link" href="/plan/{milestoneId}" target="_blank" rel="noopener">Open plan ↗</a>
						{/if}
					</div>
				</div>

				<div class="form-group">
					<label id="deps-label">Dependencies</label>
					{#if depError}
						<div class="dep-error">{depError}</div>
					{/if}

					<div class="dep-block" aria-labelledby="deps-label">
						<div class="dep-heading">
							<span class="dep-heading-label">Blocked by</span>
							{#if openBlockerCount > 0}
								<span class="dep-open-count">{openBlockerCount} still open</span>
							{/if}
						</div>
						{#if depsLoading}
							<p class="dep-empty">Loading…</p>
						{:else if blockedBy.length === 0}
							<p class="dep-empty">Nothing is blocking this card.</p>
						{:else}
							<div class="dep-list">
								{#each blockedBy as d}
									{@const row = dependencyRow(d)}
									<div class="dep-row" class:is-resolved={d.resolved}>
										<a class="dep-link" href={row.href} title={d.title}>
											<span class="dep-id">{row.label}</span>
											<span class="dep-title">{d.title}</span>
											<!-- A withheld row, on a board the caller cannot open, has no link and no board or column (card 2129). -->
											{#if !d.withheld}<span class="dep-where">{#if d.boardId !== boardId}{d.boardName} / {/if}{d.columnName}</span>{/if}
										</a>
										<button class="dep-remove" title="Remove this dependency" onclick={() => removeDependency(d, 'blocked-by')}>✕</button>
									</div>
								{/each}
							</div>
						{/if}
						{#if pickerMode === 'blocked-by'}
							{@render depPicker('Search the card this one waits on…')}
						{:else}
							<button class="btn-ghost dep-add-btn" onclick={() => { pickerMode = 'blocked-by'; pickerQuery = ''; pickerResults = []; depError = ''; }}>+ Add a blocker</button>
						{/if}
					</div>

					<div class="dep-block">
						<div class="dep-heading">
							<span class="dep-heading-label">Blocks</span>
						</div>
						{#if blocks.length === 0}
							<p class="dep-empty">This card is not holding anything up.</p>
						{:else}
							<div class="dep-list">
								{#each blocks as d}
									{@const row = dependencyRow(d)}
									<div class="dep-row" class:is-resolved={d.resolved}>
										<a class="dep-link" href={row.href} title={d.title}>
											<span class="dep-id">{row.label}</span>
											<span class="dep-title">{d.title}</span>
											{#if !d.withheld}<span class="dep-where">{#if d.boardId !== boardId}{d.boardName} / {/if}{d.columnName}</span>{/if}
										</a>
										<button class="dep-remove" title="Remove this dependency" onclick={() => removeDependency(d, 'blocks')}>✕</button>
									</div>
								{/each}
							</div>
						{/if}
						{#if pickerMode === 'blocks'}
							{@render depPicker('Search the card that waits on this one…')}
						{:else}
							<button class="btn-ghost dep-add-btn" onclick={() => { pickerMode = 'blocks'; pickerQuery = ''; pickerResults = []; depError = ''; }}>+ Add a card this blocks</button>
						{/if}
					</div>
				</div>
				{/if}

				<!-- Sub-board -->
				<div class="form-group">
					<label>Sub-board</label>
					{#if card}
						{#if card.subBoards && card.subBoards.length > 0}
							<div class="subboard-list">
								{#each card.subBoards as sb}
									<div class="subboard-row">
										<a href="/board/{sb.id}" class="subboard-link">
											<span class="subboard-link-icon">{sb.emoji}</span>
											<div class="subboard-link-info">
												<span class="subboard-link-name">{sb.name}</span>
												<span class="subboard-link-progress">{sb.done}/{sb.total} complete</span>
											</div>
										</a>
										{#if onDeleteSubBoard}
											<button class="subboard-delete-btn" title="Delete" onclick={() => onDeleteSubBoard!(sb.id)}>✕</button>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
						{#if onCreateSubBoard}
							<div class="subboard-create-row">
								<input type="text" class="subboard-name-input" placeholder="Link to a sub-board..." maxlength="200" bind:value={newSubBoardName} onkeydown={(e) => e.key === 'Enter' && newSubBoardName.trim() && onCreateSubBoard!(newSubBoardName.trim())} />
								<button class="btn-ghost subboard-add-btn" onclick={() => { if (newSubBoardName.trim()) onCreateSubBoard!(newSubBoardName.trim()); }} disabled={!newSubBoardName.trim()}>+ Create</button>
							</div>
						{/if}
						{#if onLinkSubBoard && availableBoards.length > 0}
							{#if showLinkPicker}
								<div class="link-picker">
									{#each availableBoards as ab}
										<button class="link-picker-item" onclick={() => { onLinkSubBoard!(ab.id); showLinkPicker = false; }}>{ab.emoji} {ab.name}</button>
									{/each}
								</div>
							{:else}
								<button class="btn-ghost subboard-link-btn" onclick={() => (showLinkPicker = true)}>🔗 Link existing board</button>
							{/if}
						{/if}
					{:else}
						{#if pendingSubBoardNames.length > 0}
							<div class="subboard-list">
								{#each pendingSubBoardNames as name, i}
									<div class="subboard-row">
										<div class="subboard-link" style="cursor: default;">
											<span class="subboard-link-icon">📋</span>
											<span class="subboard-link-name">{name}</span>
										</div>
										<button class="subboard-delete-btn" title="Remove" onclick={() => { pendingSubBoardNames = pendingSubBoardNames.filter((_, idx) => idx !== i); }}>✕</button>
									</div>
								{/each}
							</div>
						{/if}
						<div class="subboard-create-row">
							<input type="text" class="subboard-name-input" placeholder="Link to a sub-board..." maxlength="200" bind:value={newPendingSubBoardName} onkeydown={(e) => { if (e.key === 'Enter' && newPendingSubBoardName.trim()) { pendingSubBoardNames = [...pendingSubBoardNames, newPendingSubBoardName.trim()]; newPendingSubBoardName = ''; } }} />
							<button class="btn-ghost subboard-add-btn" onclick={() => { if (newPendingSubBoardName.trim()) { pendingSubBoardNames = [...pendingSubBoardNames, newPendingSubBoardName.trim()]; newPendingSubBoardName = ''; } }} disabled={!newPendingSubBoardName.trim()}>+ Add</button>
						</div>
					{/if}
				</div>

				<!-- Labels and a cover are put on a saved card: a new one has no id to put them on yet. -->
				{#if card}
				<div class="form-group">
					<label>Labels</label>
					<LabelPicker cardId={card.id} {boardId} {labels} bind:selected={cardLabelIds} />
				</div>

				<div class="form-group">
					<label>Cover</label>
					<div class="cover-picker">
						<button class="cover-swatch cover-swatch-none" class:active={!coverUrl} onclick={clearCover} title="No cover" type="button"></button>
						{#each COVER_PRESETS as preset}
							<button class="cover-swatch" class:active={coverUrl === preset} style="background: {preset}" onclick={() => setCover(preset)} title="Set cover" type="button"></button>
						{/each}
						<label class="color-custom-wrapper">
							<input type="color" value={coverUrl || '#6366f1'} onchange={(e) => setCover((e.target as HTMLInputElement).value)} class="color-native-input" />
							{#if isCoverValue(coverUrl)}
								<span class="cover-swatch custom" style="background: {coverUrl}">✎</span>
							{:else}
								<span class="cover-swatch custom" style="background: var(--bg-elevated)">✎</span>
							{/if}
						</label>
					</div>
				</div>
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
				<button class="btn-create" onclick={save} disabled={!title.trim()}>
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

<!-- Save as Template Modal -->
{#if showSaveTemplate}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="template-overlay" onclick={() => showSaveTemplate = false}>
		<div class="template-dialog" onclick={(e) => e.stopPropagation()}>
			<h3>📋 Save as Template</h3>
			<p class="template-desc">Saves this card's title, description, priority, subtasks and labels as a reusable template.</p>
			<div class="template-field">
				<label for="tmpl-name">Template Name</label>
				<input id="tmpl-name" type="text" bind:value={templateName} placeholder="e.g. Bug Report, Feature Request..." onkeydown={(e) => e.key === 'Enter' && saveAsTemplate()} autofocus />
			</div>
			{#if templateError}
				<div class="dep-error" role="alert">{templateError}</div>
			{/if}
			<div class="template-actions">
				<button class="btn-ghost" onclick={() => showSaveTemplate = false}>Cancel</button>
				<button class="btn-primary" onclick={saveAsTemplate} disabled={!templateName.trim() || templateSaving}>
					{templateSaving ? 'Saving...' : 'Save Template'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Template Picker Modal -->
{#if showTemplatePicker}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="template-overlay" onclick={() => showTemplatePicker = false}>
		<div class="template-dialog" onclick={(e) => e.stopPropagation()}>
			<h3>📋 Create from Template</h3>
			{#if templateError}
				<div class="dep-error" role="alert">{templateError}</div>
			{/if}
			{#if templates.length === 0}
				<p class="template-empty">No templates yet. Save a card as a template first.</p>
			{:else}
				<div class="template-list">
					{#each templates as tmpl}
						<div class="template-item">
							<button class="template-item-btn" onclick={() => applyTemplate(tmpl)}>
								<span class="template-item-name">{tmpl.name}</span>
								<span class="template-item-meta">{tmpl.title || 'No title'} · {tmpl.priority}</span>
							</button>
							<button class="template-delete-btn" onclick={() => deleteTemplate(tmpl.id)} title="Delete template">✕</button>
						</div>
					{/each}
				</div>
			{/if}
			<div class="template-actions">
				<button class="btn-ghost" onclick={() => showTemplatePicker = false}>Cancel</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.card-modal-content {
		max-width: 640px;
		background: var(--bg-surface);
		border: 1px solid var(--glass-border);
	}

	/* Modal body wrapper */
	.modal-body { padding: var(--space-lg) var(--space-xl) var(--space-xl); }

	/* Softer field styles for card modal */
	.card-modal-content input,
	.card-modal-content textarea,
	.card-modal-content select {
		background: var(--bg-base); border: 1px solid var(--glass-border);
	}
	.card-modal-content input:focus,
	.card-modal-content textarea:focus,
	.card-modal-content select:focus {
		border-color: var(--accent-indigo); box-shadow: 0 0 0 2px var(--accent-purple-glow);
	}

	/* Description hint */
	.desc-hint { font-size: 0.65rem; color: var(--text-tertiary); margin-top: var(--space-xs); padding-left: 2px; }

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
	.title-label {
		font-size: 0.7rem; font-weight: 600; color: var(--text-tertiary);
		text-transform: uppercase; letter-spacing: 0.04em;
	}
	.title-label .required { color: #ef4444; }
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
	.sidebar-panel {
		display: flex; flex-direction: column; gap: var(--space-md);
	}
	.sidebar-field label {
		display: block; font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.06em; color: var(--text-tertiary); margin-bottom: var(--space-xs);
	}
	.sidebar-field select, .sidebar-field input[type="date"], .sidebar-field textarea {
		width: 100%; font-size: 0.82rem;
	}
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
	.form-row { display: flex; gap: var(--space-lg); align-items: flex-start; }

	/* Reporting fields — collapsed by default, so writing a card is unchanged. */
	.reporting-group { border-top: 1px solid var(--border-subtle, rgba(128,128,128,0.18)); padding-top: var(--space-md); }
	.reporting-toggle {
		display: flex; align-items: center; gap: var(--space-sm);
		background: none; border: none; padding: 0; cursor: pointer;
		font-size: 0.7rem; font-weight: 600; color: var(--text-secondary);
		text-transform: uppercase; letter-spacing: 0.05em;
	}
	.reporting-toggle:hover { color: var(--text-primary); }
	.reporting-caret { display: inline-block; transition: transform 0.15s ease; }
	.reporting-caret.open { transform: rotate(90deg); }
	.reporting-count {
		text-transform: none; letter-spacing: 0; font-weight: 500;
		font-size: 0.68rem; color: var(--text-tertiary, var(--text-secondary)); opacity: 0.8;
	}
	.reporting-fields { margin-top: var(--space-md); display: flex; flex-direction: column; gap: var(--space-md); }
	.reporting-grid {
		display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: var(--space-md);
	}
	.reporting-row { display: flex; flex-direction: column; }
	.reporting-row small {
		margin-top: 4px; font-size: 0.68rem; line-height: 1.35;
		color: var(--text-tertiary, var(--text-secondary)); opacity: 0.8;
	}
	.reporting-note {
		font-size: 0.68rem; line-height: 1.35;
		color: var(--text-tertiary, var(--text-secondary)); opacity: 0.8;
	}

	/* Inline category creation */
	.new-cat-btn {
		display: inline-flex; align-items: center; gap: 4px;
		font-size: 0.72rem !important; margin-top: var(--space-xs);
		color: var(--accent-indigo) !important;
	}
	.new-cat-btn:hover { text-decoration: underline; }
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



	/* Subtasks */
	.subtasks-section { border-top: 1px solid var(--glass-border); padding-top: var(--space-lg); margin-bottom: var(--space-lg); }

	.subtask-header {
		display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-md);
	}
	.add-st-btn { font-size: 0.75rem !important; }

	.subtask-counter {
		font-size: 0.7rem; font-weight: 600; color: var(--text-tertiary);
		background: var(--bg-base); padding: 1px 6px; border-radius: var(--radius-full);
		text-transform: none; letter-spacing: 0;
	}

	/* === Token cost ==========================================================
	   Cost is context for the work, not a headline, so it reads quieter than
	   the title and the subtasks. The one thing it must never do is imply a
	   measurement where none exists: "Not recorded" is a different statement
	   from "0 tokens", and every card older than this feature is the former. */
	.token-cost { margin-top: var(--space-sm); }
	/* Per-subtask cost. Only present where something was recorded, so it never
	   becomes a row of dashes down the list. */
	.st-cost {
		margin-left: auto; padding: 1px 7px; border-radius: var(--radius-full);
		background: var(--glass-hover); color: var(--text-secondary);
		font-size: 0.68rem; font-variant-numeric: tabular-nums; white-space: nowrap;
	}
	.token-summary {
		display: flex; align-items: baseline; gap: var(--space-sm);
		width: 100%; padding: 7px 10px;
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
		background: var(--bg-surface); color: inherit;
		font-family: var(--font-family); text-align: left; cursor: pointer;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.token-summary:hover { border-color: var(--text-tertiary); }
	.token-none { cursor: default; }
	.token-none:hover { border-color: var(--glass-border); }
	.token-label {
		font-size: 0.68rem; font-weight: 700; letter-spacing: 0.04em;
		text-transform: uppercase; color: var(--text-tertiary);
	}
	.token-total {
		font-size: 0.95rem; font-weight: 700; color: var(--text-primary);
		font-variant-numeric: tabular-nums;
	}
	.token-sub { font-size: 0.74rem; color: var(--text-secondary); flex: 1; }
	.token-chevron {
		font-size: 0.7rem; color: var(--text-tertiary);
		transition: transform var(--duration-fast) var(--ease-out);
	}
	.token-chevron.open { transform: rotate(180deg); }
	.token-money {
		font-size: 0.9rem; font-weight: 700; color: var(--accent-violet, #8b5cf6);
		font-variant-numeric: tabular-nums;
	}
	/* "est" is small but always present on a blended figure — the reader should
	   never have to hover to learn the number is an estimate. */
	.token-est {
		margin-left: 3px; font-size: 0.6rem; font-weight: 600;
		text-transform: uppercase; opacity: 0.7;
	}
	.token-unpriced { color: var(--accent-amber, #f59e0b); }
	.te-cost {
		min-width: 54px; text-align: right; color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}
	.token-models { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 0; }
	.token-model-chip {
		padding: 2px 8px; border-radius: var(--radius-full);
		background: var(--glass-hover); color: var(--text-secondary);
		font-size: 0.7rem; font-variant-numeric: tabular-nums;
	}
	.token-entries { list-style: none; margin: 8px 0 0; padding: 0; }
	.token-entry {
		display: flex; align-items: baseline; gap: var(--space-sm);
		padding: 5px 10px; font-size: 0.74rem;
		border-top: 1px solid var(--glass-border);
	}
	.te-amount {
		min-width: 62px; font-weight: 600; font-variant-numeric: tabular-nums;
		color: var(--text-primary);
	}
	/* A correction reads as a correction, not as more spend. */
	.token-entry.negative .te-amount { color: var(--accent-amber, #f59e0b); }
	.te-what { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 6px; }
	.te-scope { color: var(--text-secondary); font-weight: 600; }
	.te-note { color: var(--text-tertiary); }
	.te-plain { font-style: italic; }
	.te-model { color: var(--text-tertiary); font-size: 0.7rem; white-space: nowrap; }

	.progress-bar-container {
		height: 4px; background: var(--bg-base); border-radius: var(--radius-full);
		margin-bottom: var(--space-md); overflow: hidden;
	}
	.progress-bar {
		height: 100%; background: var(--accent-indigo); border-radius: var(--radius-full);
		transition: width var(--duration-normal) var(--ease-out);
	}
	.progress-bar.complete { background: var(--accent-emerald); }

	.subtask-list {
		display: flex; flex-direction: column; gap: 2px;
		max-height: 180px; overflow-y: auto; overflow-x: hidden;
		scrollbar-width: thin;
	}

	.subtask-item {
		display: flex; align-items: flex-start; gap: var(--space-sm);
		padding: var(--space-sm); border-radius: var(--radius-sm);
		transition: background var(--duration-fast) var(--ease-out);
	}
	.subtask-item:hover { background: var(--glass-bg); }
	.subtask-item.completed .subtask-title { text-decoration: line-through; color: var(--text-tertiary); }

	.subtask-checkbox {
		width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0; margin-top: 2px;
		border: 2px solid var(--glass-border); background: transparent;
		display: flex; align-items: center; justify-content: center;
		transition: all var(--duration-fast) var(--ease-out); padding: 0;
		color: white; cursor: pointer;
	}
	.subtask-checkbox:hover { border-color: var(--accent-indigo); }
	.subtask-checkbox.checked { background: var(--accent-emerald); border-color: var(--accent-emerald); }

	.subtask-info {
		flex: 1; min-width: 0; cursor: pointer; padding: 2px 0;
		border-radius: var(--radius-sm);
	}

	.subtask-title-row { display: flex; align-items: center; gap: var(--space-xs); }
	.st-priority { font-size: 0.7rem; flex-shrink: 0; }
	.subtask-title { font-size: 0.85rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	.subtask-detail-row {
		display: flex; align-items: center; gap: var(--space-sm);
		margin-top: 2px; flex-wrap: wrap;
	}
	.st-desc-preview { font-size: 0.72rem; color: var(--text-tertiary); }
	.st-due { font-size: 0.68rem; color: var(--text-secondary); white-space: nowrap; }
	.st-due.overdue { color: var(--accent-rose); }

	.empty-subtasks { font-size: 0.82rem; color: var(--text-tertiary); text-align: center; padding: var(--space-lg) 0; }

	.card-timestamp { font-size: 0.72rem; color: var(--text-tertiary); margin-bottom: var(--space-lg); }

	/* Sub-boards section */
	.subboard-section {
		border-top: 1px solid var(--glass-border);
		padding-top: var(--space-lg);
		margin-bottom: var(--space-lg);
	}

	/* ─── Dependencies & milestone ─────────────────────────────────────── */

	.milestone-row { display: flex; gap: var(--space-sm); align-items: center; }

	.milestone-select {
		flex: 1; min-width: 0;
		padding: 7px 10px; background: var(--bg-surface);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		color: var(--text-primary); font-family: var(--font-family); font-size: 0.8rem;
		cursor: pointer;
	}
	.milestone-select:focus { outline: none; border-color: var(--accent-indigo); }
	.milestone-select:disabled { opacity: 0.6; cursor: wait; }

	.milestone-plan-link {
		font-size: 0.72rem; font-weight: 600; white-space: nowrap;
		color: #a78bfa; text-decoration: none;
	}
	.milestone-plan-link:hover { text-decoration: underline; }

	.dep-block { margin-bottom: var(--space-md); }
	.dep-block:last-child { margin-bottom: 0; }

	.dep-heading {
		display: flex; align-items: baseline; gap: var(--space-sm);
		margin-bottom: 6px;
	}
	.dep-heading-label {
		font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.05em; color: var(--text-tertiary);
	}
	.dep-open-count {
		font-size: 0.66rem; font-weight: 700; padding: 1px 7px;
		border-radius: var(--radius-full);
		background: rgba(245, 158, 11, 0.14); color: #f59e0b;
		border: 1px solid rgba(245, 158, 11, 0.3);
	}

	.dep-empty { margin: 0 0 6px; font-size: 0.75rem; color: var(--text-tertiary); }

	.dep-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px; }

	.dep-row {
		display: flex; align-items: center; gap: 4px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); padding: 5px 6px 5px 9px;
	}
	/* A resolved end still shows — it is a record of the ordering decision, not
	   noise — but it steps back so the open ones read first. */
	.dep-row.is-resolved { opacity: 0.5; }
	.dep-row.is-resolved .dep-title { text-decoration: line-through; }

	.dep-link {
		display: flex; align-items: baseline; gap: 6px;
		flex: 1; min-width: 0; text-decoration: none; color: inherit;
	}
	.dep-link:hover .dep-title { color: var(--accent-indigo); }

	.dep-id {
		font-size: 0.68rem; font-weight: 700; color: var(--text-tertiary);
		font-variant-numeric: tabular-nums; flex-shrink: 0;
	}
	.dep-title {
		font-size: 0.78rem; color: var(--text-primary);
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		transition: color var(--duration-fast) var(--ease-out);
	}
	.dep-where {
		margin-left: auto; flex-shrink: 0;
		font-size: 0.66rem; color: var(--text-tertiary); white-space: nowrap;
	}

	.dep-remove {
		flex-shrink: 0; width: 20px; height: 20px; padding: 0;
		display: flex; align-items: center; justify-content: center;
		background: none; border: none; cursor: pointer; font: inherit;
		font-size: 0.7rem; color: var(--text-tertiary);
		border-radius: var(--radius-sm);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.dep-remove:hover { background: rgba(244, 63, 94, 0.15); color: var(--accent-rose); }

	.dep-add-btn { font-size: 0.72rem; padding: 4px 10px; }

	.dep-picker { display: flex; gap: 4px; align-items: center; margin-bottom: 6px; }

	.dep-picker-input {
		flex: 1; min-width: 0;
		padding: 6px 10px; background: var(--bg-surface);
		border: 1px solid var(--accent-indigo); border-radius: var(--radius-sm);
		color: var(--text-primary); font-family: var(--font-family); font-size: 0.78rem;
	}
	.dep-picker-input:focus { outline: none; }

	.dep-picker-cancel {
		flex-shrink: 0; width: 24px; height: 24px; padding: 0;
		display: flex; align-items: center; justify-content: center;
		background: none; border: none; cursor: pointer; font: inherit;
		font-size: 0.75rem; color: var(--text-tertiary); border-radius: var(--radius-sm);
	}
	.dep-picker-cancel:hover { background: var(--bg-elevated); color: var(--text-primary); }

	.dep-results {
		display: flex; flex-direction: column; gap: 2px;
		max-height: 220px; overflow-y: auto; margin-bottom: 6px;
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		padding: 3px;
	}

	.dep-result {
		display: flex; align-items: baseline; gap: 6px;
		width: 100%; text-align: left; padding: 5px 8px;
		background: none; border: none; cursor: pointer; font: inherit;
		border-radius: var(--radius-sm);
		transition: background var(--duration-fast) var(--ease-out);
	}
	.dep-result:hover { background: var(--bg-elevated); }

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

	.subboard-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-bottom: var(--space-md);
	}

	.subboard-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.subboard-row .subboard-link { flex: 1; min-width: 0; }

	.subboard-delete-btn {
		flex-shrink: 0;
		width: 28px; height: 28px;
		display: flex; align-items: center; justify-content: center;
		border-radius: var(--radius-sm);
		background: transparent; border: 1px solid transparent;
		color: var(--text-tertiary); cursor: pointer;
		transition: all 0.15s;
	}
	.subboard-delete-btn:hover { color: var(--accent-rose); background: rgba(244, 63, 94, 0.1); border-color: rgba(244, 63, 94, 0.2); }
	.subboard-link {
		display: flex; align-items: center; gap: var(--space-md);
		padding: var(--space-sm) var(--space-md); border-radius: var(--radius-md);
		background: rgba(99, 102, 241, 0.06); border: 1px solid rgba(99, 102, 241, 0.15);
		text-decoration: none; color: var(--text-primary);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.subboard-link:hover {
		background: rgba(99, 102, 241, 0.12);
		border-color: rgba(99, 102, 241, 0.3);
		transform: translateX(2px);
	}
	.subboard-link-icon { font-size: 1rem; flex-shrink: 0; }
	.subboard-link-info { flex: 1; min-width: 0; }
	.subboard-link-name { display: block; font-size: 0.82rem; font-weight: 600; }
	.subboard-link-progress { display: block; font-size: 0.68rem; color: var(--text-secondary); margin-top: 1px; }
	.subboard-link svg { color: var(--text-tertiary); flex-shrink: 0; }

	.subboard-create-row {
		display: flex; gap: var(--space-sm); margin-bottom: var(--space-sm);
	}
	.subboard-name-input {
		flex: 1; padding: 6px var(--space-sm);
		border-radius: var(--radius-sm);
		background: var(--bg-base); border: 1px solid var(--glass-border);
		color: var(--text-primary); font-family: var(--font-family);
		font-size: 0.8rem;
	}
	.subboard-name-input:focus { outline: none; border-color: rgba(99, 102, 241, 0.5); }
	.subboard-add-btn {
		display: flex; align-items: center; gap: 4px;
		font-size: 0.75rem !important; white-space: nowrap;
		padding: 4px var(--space-sm) !important;
	}
	.subboard-add-btn:disabled { opacity: 0.3; cursor: not-allowed; }

	.subboard-link-section { margin-top: var(--space-xs); }
	.subboard-link-btn {
		font-size: 0.75rem !important;
		color: var(--text-tertiary) !important;
		padding: 4px var(--space-sm) !important;
	}
	.subboard-link-btn:hover { color: #818cf8 !important; }

	.link-picker {
		display: flex; flex-direction: column; gap: 2px;
		max-height: 150px; overflow-y: auto;
		padding: var(--space-xs); border-radius: var(--radius-sm);
		background: var(--bg-base); border: 1px solid var(--glass-border);
	}
	.link-picker-item {
		padding: 6px var(--space-sm);
		border: none; background: transparent;
		color: var(--text-primary); font-size: 0.8rem;
		text-align: left; cursor: pointer;
		border-radius: var(--radius-sm);
		transition: background 0.1s;
	}
	.link-picker-item:hover { background: var(--glass-bg); }

	.modal-actions { display: flex; align-items: center; gap: var(--space-md); padding-top: var(--space-lg); border-top: 1px solid var(--glass-border); }

	.btn-danger {
		display: inline-flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md); background: rgba(244, 63, 94, 0.1);
		color: var(--accent-rose); border-radius: var(--radius-sm);
		font-weight: 500; font-size: 0.85rem; border: 1px solid rgba(244, 63, 94, 0.2);
	}
	.btn-danger:hover { background: rgba(244, 63, 94, 0.2); }

	/* Due date toggle */
	.due-date-header { display: flex; align-items: center; justify-content: space-between; }
	.due-clear { padding: 2px !important; opacity: 0.5; margin-bottom: var(--space-sm); }
	.due-clear:hover { opacity: 1; }
	.due-add-btn { font-size: 0.8rem !important; display: flex; gap: var(--space-xs); align-items: center; color: var(--text-tertiary) !important; }
	.due-add-btn:hover { color: var(--text-secondary) !important; }



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

	/* Pending subtasks for new cards */
	.pending-subtask-input {
		display: flex; gap: var(--space-sm); margin-top: var(--space-sm);
	}
	.pending-subtask-input input { flex: 1; }
	.subtask-item.pending {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm);
	}
	.pending-remove { padding: 2px !important; opacity: 0.5; }
	.pending-remove:hover { opacity: 1; }

	/* Description preview */
	.desc-header { display: flex; align-items: center; justify-content: space-between; }
	.desc-tabs { display: flex; gap: 2px; background: var(--glass-bg); border-radius: var(--radius-sm); padding: 2px; }
	.desc-tab {
		padding: 2px 10px; border: none; background: transparent; cursor: pointer;
		font-size: 0.65rem; font-weight: 700; border-radius: var(--radius-sm);
		color: var(--text-tertiary); transition: all 0.15s;
	}
	.desc-tab.active { background: var(--bg-surface); color: var(--text-primary); box-shadow: 0 1px 2px rgba(0,0,0,0.1); }
	.desc-preview {
		min-height: 90px; max-height: 200px; overflow-y: auto;
		padding: var(--space-sm); border-radius: var(--radius-sm);
		border: 1px solid var(--glass-border); background: var(--glass-bg);
		font-size: 0.82rem; line-height: 1.6;
	}
	.desc-preview :global(h1), .desc-preview :global(h2), .desc-preview :global(h3) { margin: 0.5em 0 0.25em; font-weight: 700; }
	.desc-preview :global(h1) { font-size: 1.1em; }
	.desc-preview :global(h2) { font-size: 0.95em; }
	.desc-preview :global(h3) { font-size: 0.85em; }
	.desc-preview :global(p) { margin: 0.3em 0; }
	.desc-preview :global(ul), .desc-preview :global(ol) { padding-left: 1.2em; margin: 0.3em 0; }
	.desc-preview :global(code) { background: var(--glass-bg); padding: 1px 4px; border-radius: 3px; font-size: 0.85em; }
	.desc-preview :global(pre) { background: var(--glass-bg); padding: var(--space-sm); border-radius: var(--radius-sm); overflow-x: auto; }
	.desc-preview :global(blockquote) { border-left: 3px solid var(--accent-indigo); padding-left: var(--space-sm); margin: 0.3em 0; opacity: 0.8; }
	.desc-preview :global(a) { color: var(--accent-indigo); }
	.desc-preview :global(strong) { font-weight: 700; }
	.desc-empty { color: var(--text-tertiary); font-style: italic; }

	/* Assignees */
	.assignees-section { margin-bottom: var(--space-md); }
	.assignees-section label { display: block; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-tertiary); margin-bottom: var(--space-xs); }
	.assignees-list { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
	.assignee-chip {
		display: flex; align-items: center; gap: 4px;
		padding: 3px 8px 3px 4px; border-radius: var(--radius-full);
		background: rgba(99, 102, 241, 0.12); border: 1px solid rgba(99, 102, 241, 0.2);
		font-size: 0.75rem; font-weight: 500;
	}
	.assignee-emoji { font-size: 0.85rem; }
	.assignee-name { color: var(--text-primary); }
	.assignee-remove {
		width: 16px; height: 16px; border-radius: 50%; border: none; background: transparent;
		color: var(--text-tertiary); cursor: pointer; display: flex; align-items: center; justify-content: center;
		opacity: 0.5; transition: all 0.15s; padding: 0; margin-left: 2px;
	}
	.assignee-remove:hover { opacity: 1; color: var(--accent-rose); background: rgba(244, 63, 94, 0.15); }
	.assignee-add {
		padding: 3px 8px; border-radius: var(--radius-full); border: 1px dashed var(--glass-border);
		background: transparent; color: var(--text-tertiary); font-size: 0.72rem;
		cursor: pointer; font-family: var(--font-family);
	}
	.assignee-add:hover { border-color: var(--accent-indigo); color: var(--text-secondary); }

	/* ─── Comments ──────────────────────────────────────────── */
	.comments-section { display: flex; flex-direction: column; gap: var(--space-lg); }
	.comment-input-area { display: flex; flex-direction: column; gap: var(--space-sm); }
	.comment-input {
		padding: var(--space-md); font-size: 0.85rem; min-height: 80px; resize: vertical;
		background: var(--bg-base); border: 1px solid var(--glass-border); border-radius: var(--radius-md);
		color: var(--text-primary); font-family: var(--font-family);
	}
	.comment-input:focus { outline: none; border-color: var(--accent-indigo); }
	.comment-input-actions { display: flex; justify-content: space-between; align-items: center; }
	.comment-hint { font-size: 0.7rem; color: var(--text-tertiary); }
	.comments-loading { text-align: center; color: var(--text-tertiary); padding: var(--space-xl); font-size: 0.85rem; }
	.comments-empty {
		text-align: center; padding: var(--space-2xl); color: var(--text-tertiary);
	}
	.comments-empty-icon { font-size: 2rem; display: block; margin-bottom: var(--space-sm); }
	.comments-empty p { font-size: 0.85rem; }
	.comment-thread { display: flex; flex-direction: column; gap: var(--space-md); }
	.comment-item {
		display: flex; gap: var(--space-sm); padding: var(--space-md);
		background: var(--bg-base); border-radius: var(--radius-md);
		border: 1px solid var(--glass-border); overflow: hidden;
	}
	.comment-avatar {
		width: 32px; height: 32px; border-radius: 50%; background: var(--bg-surface);
		display: flex; align-items: center; justify-content: center; font-size: 1rem;
		flex-shrink: 0; border: 1px solid var(--glass-border);
	}
	.comment-body { flex: 1; min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
	.comment-meta { display: flex; align-items: center; gap: var(--space-sm); margin-bottom: var(--space-xs); }
	.comment-author { font-size: 0.8rem; font-weight: 700; color: var(--text-primary); }
	.comment-time { font-size: 0.7rem; color: var(--text-tertiary); }
	.comment-edited { font-size: 0.65rem; color: var(--text-tertiary); font-style: italic; }
	.comment-content { font-size: 0.85rem; line-height: 1.5; color: var(--text-secondary); overflow-wrap: anywhere; word-break: break-word; overflow: hidden; }
	.comment-content :global(p) { margin: 0 0 var(--space-xs); overflow-wrap: anywhere; word-break: break-word; }
	.comment-content :global(p:last-child) { margin: 0; }
	.comment-content :global(pre) { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
	.comment-content :global(code) { word-break: break-all; }
	.comment-content :global(blockquote) { margin: var(--space-sm) 0; padding-left: var(--space-md); border-left: 3px solid var(--glass-border); color: var(--text-tertiary); }
	.comment-content :global(.mention-chip) {
		display: inline; padding: 1px 4px; border-radius: 3px;
		background: rgba(139, 92, 246, 0.12); color: #8b5cf6;
		font-weight: 600; font-size: 0.82em;
	}
	.comment-actions { display: flex; gap: var(--space-sm); margin-top: var(--space-xs); }
	.comment-action-btn {
		font-size: 0.7rem; color: var(--text-tertiary); background: none; border: none;
		cursor: pointer; padding: 2px 6px; border-radius: var(--radius-sm);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.comment-action-btn:hover { color: var(--text-primary); background: var(--bg-surface); }
	.comment-action-btn.danger:hover { color: #ef4444; background: rgba(239,68,68,0.1); }
	.comment-edit-input {
		width: 100%; padding: var(--space-sm); font-size: 0.82rem; resize: vertical;
		background: var(--bg-surface); border: 1px solid var(--accent-indigo); border-radius: var(--radius-sm);
		color: var(--text-primary); font-family: var(--font-family);
	}
	.comment-edit-actions { display: flex; gap: var(--space-sm); margin-top: var(--space-xs); }

	/* ─── Cover ──────────────────────────────────────────── */
	.modal-cover-preview {
		height: 8px; margin: calc(-1 * var(--space-lg)) calc(-1 * var(--space-lg)) var(--space-md);
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
	}
	.cover-picker {
		display: flex; flex-wrap: wrap; gap: 4px;
	}
	.cover-swatch {
		width: 24px; height: 24px; border-radius: 6px; border: 2px solid transparent;
		cursor: pointer; transition: all 0.15s; flex-shrink: 0;
	}
	.cover-swatch:hover { transform: scale(1.15); }
	.cover-swatch.active { border-color: var(--text-primary); box-shadow: 0 0 0 1px var(--bg-card); }
	.cover-clear {
		font-size: 0.7rem !important; color: var(--text-tertiary) !important;
		margin-top: 4px; padding: 2px 6px !important;
	}
	.cover-clear:hover { color: var(--accent-rose) !important; }

	/* ─── Templates ──────────────────────────────────────── */
	.template-save-btn { font-size: 0.78rem !important; }
	.template-overlay {
		position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5);
		display: flex; align-items: center; justify-content: center;
		z-index: 1100; backdrop-filter: blur(4px);
	}
	.template-dialog {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg); padding: var(--space-xl);
		width: 90%; max-width: 420px; box-shadow: var(--shadow-lg);
	}
	.template-dialog h3 { font-size: 1.1rem; font-weight: 700; margin-bottom: var(--space-xs); }
	.template-desc { font-size: 0.82rem; color: var(--text-secondary); margin-bottom: var(--space-lg); }
	.template-field { margin-bottom: var(--space-lg); }
	.template-field label {
		display: block; font-size: 0.75rem; font-weight: 600;
		color: var(--text-secondary); margin-bottom: 4px;
	}
	.template-field input {
		width: 100%; padding: 8px 12px; background: var(--bg-surface);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
		color: var(--text-primary); font-family: var(--font-family); font-size: 0.85rem;
	}
	.template-field input:focus { outline: none; border-color: var(--accent-indigo); }
	.template-actions { display: flex; justify-content: flex-end; gap: var(--space-sm); }
	.template-empty { font-size: 0.85rem; color: var(--text-tertiary); text-align: center; padding: var(--space-xl); }
	.template-list { display: flex; flex-direction: column; gap: var(--space-xs); margin-bottom: var(--space-lg); max-height: 300px; overflow-y: auto; }
	.template-item { display: flex; align-items: center; gap: var(--space-xs); }
	.template-item-btn {
		flex: 1; display: flex; flex-direction: column; gap: 2px;
		padding: var(--space-sm) var(--space-md); text-align: left;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); cursor: pointer;
		font-family: var(--font-family); transition: all 0.15s;
	}
	.template-item-btn:hover { border-color: var(--accent-indigo); background: rgba(99, 102, 241, 0.05); }
	.template-item-name { font-size: 0.85rem; font-weight: 600; color: var(--text-primary); }
	.template-item-meta { font-size: 0.7rem; color: var(--text-tertiary); }
	.template-delete-btn {
		padding: 4px 6px; background: none; border: none;
		color: var(--text-tertiary); cursor: pointer; font-size: 0.75rem;
		border-radius: var(--radius-sm); transition: all 0.15s;
	}
	.template-delete-btn:hover { color: #ef4444; background: rgba(239, 68, 68, 0.1); }

	/* ─── Attachments ────────────────────────────────────── */
	.attachments-section { display: flex; flex-direction: column; gap: var(--space-md); }
	.upload-zone {
		position: relative; padding: var(--space-xl); text-align: center;
		border: 2px dashed var(--glass-border); border-radius: var(--radius-md);
		background: var(--bg-base); cursor: pointer; transition: all 0.2s;
	}
	.upload-zone:hover, .upload-zone.drag-over {
		border-color: var(--accent-indigo); background: rgba(99, 102, 241, 0.04);
	}
	.upload-icon { font-size: 1.5rem; display: block; margin-bottom: var(--space-xs); }
	.upload-zone p { font-size: 0.82rem; color: var(--text-tertiary); margin: 0; }
	.upload-input {
		position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%;
	}
	.attachment-list { display: flex; flex-direction: column; gap: var(--space-sm); }
	.attachment-item {
		display: flex; align-items: center; gap: var(--space-md);
		padding: var(--space-sm) var(--space-md);
		background: var(--bg-base); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md);
	}
	.attachment-thumb {
		width: 48px; height: 48px; border-radius: var(--radius-sm); overflow: hidden;
		flex-shrink: 0; border: 1px solid var(--glass-border);
	}
	.attachment-thumb img { width: 100%; height: 100%; object-fit: cover; }
	.attachment-icon {
		width: 48px; height: 48px; display: flex; align-items: center; justify-content: center;
		font-size: 1.5rem; flex-shrink: 0;
	}
	.attachment-info { flex: 1; min-width: 0; }
	.attachment-name {
		display: block; font-size: 0.82rem; font-weight: 600; color: var(--accent-indigo);
		text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.attachment-name:hover { text-decoration: underline; }
	.attachment-meta { font-size: 0.7rem; color: var(--text-tertiary); }
	.attachment-delete {
		padding: 6px; background: none; border: none; color: var(--text-tertiary);
		cursor: pointer; border-radius: var(--radius-sm); transition: all 0.15s;
	}
	.attachment-delete:hover { color: #ef4444; background: rgba(239, 68, 68, 0.1); }

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
	/* Cover swatches */
	.cover-picker { display: flex; gap: 6px; flex-wrap: wrap; }
	.cover-swatch {
		width: 26px; height: 26px; border-radius: var(--radius-sm);
		border: 2px solid transparent; cursor: pointer;
		transition: all 0.15s; display: flex; align-items: center; justify-content: center;
	}
	.cover-swatch:hover { transform: scale(1.15); }
	.cover-swatch.active { border-color: var(--text-primary); }
	.cover-swatch-none {
		background: var(--bg-elevated); position: relative;
	}
	.cover-swatch-none::after {
		content: ''; position: absolute; inset: 4px;
		border: 1.5px dashed var(--text-tertiary); border-radius: 3px;
	}
	.cover-swatch.custom {
		font-size: 0.6rem; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5);
	}

	/* Custom color picker (shared pattern) */
	.color-custom-wrapper { position: relative; cursor: pointer; display: inline-flex; }
	.color-native-input { position: absolute; width: 0; height: 0; opacity: 0; pointer-events: none; }

	/* Metadata chips */
	.metadata-section { margin-top: var(--space-xl); }
	.metadata-label {
		font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.06em; color: var(--text-tertiary); margin-bottom: var(--space-md);
	}
	.metadata-row { display: flex; flex-wrap: wrap; gap: var(--space-sm); }

	.chip {
		display: inline-flex; align-items: center; gap: var(--space-sm);
		padding: 5px 10px; font-family: var(--font-family); font-size: 0.78rem; font-weight: 500;
		color: var(--text-secondary); background: var(--bg-elevated);
		border: 1px solid var(--glass-border); border-radius: 100px;
		cursor: pointer; transition: all 0.15s; white-space: nowrap; user-select: none;
	}
	.chip:hover { border-color: var(--text-tertiary); color: var(--text-primary); background: var(--bg-hover); }
	.chip.is-set { border-color: var(--accent-indigo); background: rgba(99, 102, 241, 0.1); color: var(--text-accent); }
	.chip-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
	.chip-icon { display: flex; align-items: center; flex-shrink: 0; }
	.chip-chevron { margin-left: 2px; }

	/* Chip dropdowns */
	.dropdown-wrapper { position: relative; }
	.chip-dropdown {
		position: absolute; top: calc(100% + 6px); left: 0; z-index: 200;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-xs); min-width: 180px;
		box-shadow: var(--shadow-lg); animation: fadeIn 0.15s ease;
	}
	.chip-dropdown-item {
		display: flex; align-items: center; gap: var(--space-md);
		padding: var(--space-sm) var(--space-md); font-size: 0.78rem;
		color: var(--text-secondary); border-radius: var(--radius-sm);
		cursor: pointer; border: none; background: transparent; width: 100%;
		text-align: left; transition: all 0.1s; font-family: var(--font-family);
	}
	.chip-dropdown-item:hover { background: var(--bg-hover); color: var(--text-primary); }
	.chip-dropdown-item.selected { color: var(--text-primary); font-weight: 600; }
	.chip-dropdown-divider { height: 1px; background: var(--glass-border); margin: 4px 0; }

	/* Add subtask inline button */
	.add-subtask-inline {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md); font-size: 0.82rem; font-weight: 500;
		color: var(--text-tertiary); background: transparent; border: none;
		cursor: pointer; transition: all 0.15s; border-radius: var(--radius-sm);
	}
	.add-subtask-inline:hover { color: var(--text-secondary); background: var(--bg-elevated); }

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
