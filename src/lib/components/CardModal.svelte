<script lang="ts">
	/**
	 * CardModal — The full card editor modal.
	 *
	 * Handles editing card properties (title, description, priority, colour,
	 * category, due date), managing subtasks, labels, and sub-boards.
	 * Supports both create and edit modes.
	 */
	import SubtaskModal from './SubtaskModal.svelte';
	import { marked } from 'marked';
	import { COLUMN_COLORS } from '$lib/utils/constants';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import type { CardType, CategoryType, LabelType, SubtaskType } from '$lib/types';

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
		availableBoards = []
	}: {
		card: CardType | null;
		categories: CategoryType[];
		labels: LabelType[];
		boardId: number;
		boardUsers?: { id: number; username: string; email?: string; emoji: string }[];
		onSave: (data: { title: string; description: string; priority: string; colorTag: string; categoryId: number | null; dueDate: string | null; onHoldNote?: string; businessValue?: string; pendingSubtasks?: string[]; pendingAssigneeIds?: number[]; pendingSubBoards?: string[] }) => void;
		onDelete?: () => void;
		onClose: () => void;
		onCreateSubBoard?: (name: string) => void;
		onDeleteSubBoard?: (boardId: number) => void;
		onLinkSubBoard?: (boardId: number) => void;
		availableBoards?: { id: number; name: string; emoji: string }[];
	} = $props();

	// svelte-ignore state_referenced_locally — intentional: initialize form fields from prop snapshot
	let newSubBoardName = $state(card?.title || '');
	let showLinkPicker = $state(false);

	// svelte-ignore state_referenced_locally
	let cardLabelIds = $state<number[]>((card as any)?.labelIds || []);

	async function toggleLabel(labelId: number) {
		if (!card) return;
		await fetch('/api/labels', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cardId: card.id, labelId, boardId })
		});
		if (cardLabelIds.includes(labelId)) {
			cardLabelIds = cardLabelIds.filter(id => id !== labelId);
		} else {
			cardLabelIds = [...cardLabelIds, labelId];
		}
	}

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
	let cardSubtasks = $state<SubtaskType[]>(card?.subtasks || []);

	// Inline category creation state
	let showNewCategory = $state(false);
	let newCatName = $state('');
	let newCatColor = $state('#6366f1');
	let localCategories = $state<CategoryType[]>([...categories]);

	async function createCategoryInline() {
		if (!newCatName.trim()) return;
		const res = await fetch('/api/categories', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ boardId, name: newCatName.trim(), color: newCatColor })
		});
		if (res.ok) {
			const created = await res.json();
			localCategories = [...localCategories, created];
			categoryId = created.id;
			newCatName = '';
			newCatColor = '#6366f1';
			showNewCategory = false;
		}
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
			const res = await fetch(`/api/cards/${card.id}/assignees`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ userId })
			});
			if (res.ok) {
				cardAssignees = [...cardAssignees, { id: user.id, username: user.username, emoji: user.emoji }];
			}
		} else {
			// New card — queue locally
			cardAssignees = [...cardAssignees, { id: user.id, username: user.username, emoji: user.emoji }];
		}
	}

	async function unassignUser(userId: number) {
		if (card) {
			await fetch(`/api/cards/${card.id}/assignees`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ userId })
			});
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



	function save() {
		if (!title.trim()) return;
		onSave({
			title: title.trim(), description, priority, colorTag: '', categoryId,
			dueDate: dueDate || null, onHoldNote: onHoldNote || undefined,
			businessValue: businessValue || undefined,
			pendingSubtasks: pendingSubtasks.length > 0
				? pendingSubtasks.map(s => JSON.stringify({ title: s.title, description: s.description, priority: s.priority, colorTag: s.colorTag, dueDate: s.dueDate }))
				: undefined,
			pendingAssigneeIds: !card && cardAssignees.length > 0
				? cardAssignees.map(a => a.id)
				: undefined,
			pendingSubBoards: !card && pendingSubBoardNames.length > 0
				? pendingSubBoardNames
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

	function handleKeydown(e: KeyboardEvent) {
		if (showSubtaskModal) return; // Let subtask modal handle its own escape
		if (e.key === 'Escape') onClose();
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
		const res = await fetch(`/api/subtasks/${subtask.id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ completed: !subtask.completed, boardId })
		});
		if (res.ok) {
			subtask.completed = !subtask.completed;
			cardSubtasks = [...cardSubtasks];
		}
	}

	$effect(() => {
		if (card) cardSubtasks = card.subtasks || [];
	});

	const completedCount = $derived(cardSubtasks.filter((st) => st.completed).length);
	const totalCount = $derived(cardSubtasks.length);
	const progress = $derived(totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0);

	function getPriorityLabel(p: string) {
		const m: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
		return m[p] || '🟡';
	}

	function formatDue(d: string | null) {
		if (!d) return '';
		const date = new Date(d);
		const now = new Date();
		const diff = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
		const formatted = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
		if (diff < 0) return `⚠️ Overdue (${formatted})`;
		if (diff === 0) return `📅 Due today`;
		if (diff === 1) return `📅 Due tomorrow`;
		return `📅 ${formatted}`;
	}
	// ─── Tabs & Comments ────────────────────────────────────────────────────
	let activeTab = $state<'details' | 'comments'>('details');

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
		if (card) loadComments();
	});

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
		const res = await fetch(`/api/cards/${card.id}/comments`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: newComment.trim() })
		});
		if (res.ok) {
			const created = await res.json();
			comments = [created, ...comments];
			newComment = '';
		}
	}

	async function deleteComment(commentId: number) {
		if (!card) return;
		const res = await fetch(`/api/cards/${card.id}/comments/${commentId}`, { method: 'DELETE' });
		if (res.ok) comments = comments.filter(c => c.id !== commentId);
	}

	async function saveEditComment(commentId: number) {
		if (!card || !editingCommentText.trim()) return;
		const res = await fetch(`/api/cards/${card.id}/comments/${commentId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: editingCommentText.trim() })
		});
		if (res.ok) {
			comments = comments.map(c => c.id === commentId ? { ...c, content: editingCommentText.trim(), updatedAt: new Date().toISOString() } : c);
			editingCommentId = null;
			editingCommentText = '';
		}
	}

	function commentTimeAgo(dateStr: string): string {
		const diff = Math.floor((Date.now() - new Date(dateStr + 'Z').getTime()) / 1000);
		if (diff < 60) return 'just now';
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return `${Math.floor(diff / 86400)}d ago`;
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay" onclick={onClose} role="dialog" aria-modal="true" aria-label="Card editor">
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-content card-modal-content" onclick={(e) => e.stopPropagation()} role="document">
		<div class="modal-header">
			<input class="modal-title-input" type="text" placeholder="What needs to be done?" bind:value={title} onkeydown={(e) => e.key === 'Enter' && !e.shiftKey && save()} autofocus />
			<button class="close-btn btn-ghost" onclick={onClose} aria-label="Close">
				<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
					<path d="M4 4l10 10M14 4L4 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
				</svg>
			</button>
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
						{@html marked(description)}
					{:else}
						<p class="desc-empty">Nothing to preview</p>
					{/if}
				</div>
			{:else}
				<textarea id="card-desc" placeholder="Supports **markdown** formatting..." bind:value={description} rows="4"></textarea>
			{/if}
		</div>

		<div class="form-group">
			<label for="card-bv">Business Value / Justification</label>
			<textarea id="card-bv" placeholder="Why is this important? What value does it deliver?" bind:value={businessValue} rows="2"></textarea>
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
								</div>
								{#if subtask.description || subtask.dueDate}
									<div class="subtask-detail-row">
										{#if subtask.description}
											<span class="st-desc-preview">{subtask.description.slice(0, 60)}{subtask.description.length > 60 ? '…' : ''}</span>
										{/if}
										{#if subtask.dueDate}
											<span class="st-due" class:overdue={new Date(subtask.dueDate) < new Date()}>
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
					<p class="empty-subtasks">No subtasks yet. Click "Add" to break this task down.</p>
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
					<p class="empty-subtasks">No subtasks yet. Click "Add" to break this task down.</p>
				{/if}
			</div>
		{/if}

		<!-- Sub-boards section -->
		{#if card}
			<div class="subboard-section">
				<div class="subtask-header">
					<label>
						Sub-boards
						{#if card.subBoards && card.subBoards.length > 0}
							<span class="subtask-counter">{card.subBoards.length}</span>
						{/if}
					</label>
				</div>

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
									<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
										<path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
									</svg>
								</a>
								{#if onDeleteSubBoard}
								<button class="subboard-delete-btn" title="Delete sub-board" onclick={() => onDeleteSubBoard!(sb.id)}>
									<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2.5A.5.5 0 015.5 2h3a.5.5 0 01.5.5V4m1.5 0l-.5 8a1 1 0 01-1 1h-5a1 1 0 01-1-1l-.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
								</button>
								{/if}
							</div>
						{/each}
					</div>
				{/if}

				{#if onCreateSubBoard}
					<div class="subboard-create-row">
						<input type="text" class="subboard-name-input" placeholder="Sub-board name..." bind:value={newSubBoardName} onkeydown={(e) => e.key === 'Enter' && newSubBoardName.trim() && onCreateSubBoard!(newSubBoardName.trim())} />
						<button class="btn-ghost subboard-add-btn" onclick={() => { if (newSubBoardName.trim()) onCreateSubBoard!(newSubBoardName.trim()); }} disabled={!newSubBoardName.trim()}>
							<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
							Create
						</button>
					</div>
				{/if}

				{#if onLinkSubBoard && availableBoards.length > 0}
					<div class="subboard-link-section">
						{#if showLinkPicker}
							<div class="link-picker">
								{#each availableBoards as ab}
									<button class="link-picker-item" onclick={() => { onLinkSubBoard!(ab.id); showLinkPicker = false; }}>{ab.emoji} {ab.name}</button>
								{/each}
							</div>
						{:else}
							<button class="btn-ghost subboard-link-btn" onclick={() => (showLinkPicker = true)}>🔗 Link existing board</button>
						{/if}
					</div>
				{/if}

				{#if (!card.subBoards || card.subBoards.length === 0) && !onCreateSubBoard}
					<p class="empty-subtasks">No sub-boards yet.</p>
				{/if}
			</div>
		{:else}
			<!-- New card: planned sub-boards -->
			<div class="subboard-section">
				<div class="subtask-header">
					<label>
						Planned Sub-boards
						{#if pendingSubBoardNames.length > 0}
							<span class="subtask-counter">{pendingSubBoardNames.length}</span>
						{/if}
					</label>
				</div>
				{#if pendingSubBoardNames.length > 0}
					<div class="subboard-list">
						{#each pendingSubBoardNames as name, i}
							<div class="subboard-row">
								<div class="subboard-link" style="cursor: default;">
									<span class="subboard-link-icon">📋</span>
									<div class="subboard-link-info">
										<span class="subboard-link-name">{name}</span>
										<span class="subboard-link-progress">Will be created on save</span>
									</div>
								</div>
								<button class="subboard-delete-btn" title="Remove" onclick={() => { pendingSubBoardNames = pendingSubBoardNames.filter((_, idx) => idx !== i); }}>
									<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
								</button>
							</div>
						{/each}
					</div>
				{/if}
				<div class="subboard-create-row">
					<input type="text" class="subboard-name-input" placeholder="Sub-board name..." bind:value={newPendingSubBoardName} onkeydown={(e) => { if (e.key === 'Enter' && newPendingSubBoardName.trim()) { pendingSubBoardNames = [...pendingSubBoardNames, newPendingSubBoardName.trim()]; newPendingSubBoardName = ''; } }} />
					<button class="btn-ghost subboard-add-btn" onclick={() => { if (newPendingSubBoardName.trim()) { pendingSubBoardNames = [...pendingSubBoardNames, newPendingSubBoardName.trim()]; newPendingSubBoardName = ''; } }} disabled={!newPendingSubBoardName.trim()}>
						<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
						Add
					</button>
				</div>
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
									<div class="comment-content markdown-body">{@html marked(comment.content)}</div>
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

		</div> <!-- end main-panel -->

		<!-- Sidebar -->
		<div class="sidebar-panel">
			<div class="sidebar-field">
				<label for="sb-priority">Priority</label>
				<select id="sb-priority" bind:value={priority}>
					<option value="low">🟢 Low</option>
					<option value="medium">🟡 Medium</option>
					<option value="high">🟠 High</option>
					<option value="critical">🔴 Critical</option>
				</select>
			</div>

			<div class="sidebar-field">
				<label for="sb-category">Category</label>
				{#if showNewCategory}
					<div class="inline-cat-form">
						<input type="text" class="inline-cat-input" placeholder="Category name..." bind:value={newCatName} onkeydown={(e) => e.key === 'Enter' && createCategoryInline()} autofocus />
						<div class="inline-cat-colors">
							{#each COLUMN_COLORS.slice(0, 8) as color}
								<button class="cat-color-swatch" class:active={newCatColor === color} style="background: {color}" onclick={() => (newCatColor = color)} type="button"></button>
							{/each}
							<label class="color-custom-wrapper">
								<input type="color" bind:value={newCatColor} class="color-native-input" />
								<span class="cat-color-swatch custom" style="background: {newCatColor}">✎</span>
							</label>
						</div>
						<div class="inline-cat-actions">
							<button class="btn-primary small" onclick={createCategoryInline} disabled={!newCatName.trim()} type="button">Create</button>
							<button class="btn-ghost small" onclick={() => (showNewCategory = false)} type="button">Cancel</button>
						</div>
					</div>
				{:else}
					<select id="sb-category" bind:value={categoryId}>
						<option value={null}>None</option>
						{#each localCategories as cat}
							<option value={cat.id}>{cat.name}</option>
						{/each}
					</select>
					<button class="btn-ghost new-cat-btn" onclick={() => (showNewCategory = true)} type="button">+ New Category</button>
				{/if}
			</div>

			<div class="sidebar-field">
				{#if showDueDate}
					<div class="due-date-header">
						<label for="sb-due">Due Date</label>
						<button class="btn-ghost due-clear" onclick={() => { showDueDate = false; dueDate = ''; }} title="Remove">✕</button>
					</div>
					<input id="sb-due" type="date" bind:value={dueDate} />
				{:else}
					<label>Due Date</label>
					<button class="btn-ghost due-add-btn" onclick={() => (showDueDate = true)}>+ Set due date</button>
				{/if}
			</div>

			<div class="sidebar-field">
				<label>Assignees</label>
				<div class="assignees-list">
					{#each cardAssignees as assignee}
						<div class="assignee-chip">
							<span class="assignee-emoji">{assignee.emoji}</span>
							<span class="assignee-name">{assignee.username}</span>
							<button class="assignee-remove" onclick={() => unassignUser(assignee.id)} title="Remove">✕</button>
						</div>
					{/each}
					{#if availableAssignees.length > 0}
						<select class="assignee-add" onchange={(e) => { const v = Number((e.target as HTMLSelectElement).value); if (v) assignUser(v); (e.target as HTMLSelectElement).value = ''; }}>
							<option value="">+ Assign...</option>
							{#each availableAssignees as u}
								<option value={u.id}>{u.emoji} {u.username}</option>
							{/each}
						</select>
					{/if}
				</div>
			</div>

			{#if labels.length > 0}
			<div class="sidebar-field">
				<label>Labels</label>
				<div class="labels-picker">
					{#each labels as label}
						<button class="label-toggle" class:active={cardLabelIds.includes(label.id)} style="--lc: {label.color}" onclick={() => toggleLabel(label.id)}>{label.name}</button>
					{/each}
				</div>
			</div>
			{/if}

			{#if card}
				<div class="sidebar-timestamp">
					Created {new Date(card.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
				</div>
			{/if}
		</div>
		</div> <!-- end modal-body-grid -->

		<div class="modal-actions">
			{#if onDelete}
				<button class="btn-danger" onclick={onDelete}>
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
						<path d="M2 4h10M5 4V2.5A.5.5 0 015.5 2h3a.5.5 0 01.5.5V4m1.5 0l-.5 8a1 1 0 01-1 1h-5a1 1 0 01-1-1l-.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
					Delete
				</button>
			{/if}
			<div style="flex: 1"></div>
			<button class="btn-ghost" onclick={onClose}>Cancel</button>
			<button class="btn-primary" onclick={save} disabled={!title.trim()}>
				{card ? 'Save Changes' : 'Create Card'}
			</button>
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

<style>
	.card-modal-content { max-width: 960px; }

	/* Title input */
	.modal-title-input {
		flex: 1; font-size: 1.3rem; font-weight: 700; border: none; background: transparent;
		color: var(--text-primary); font-family: var(--font-family); outline: none;
		padding: var(--space-xs) 0;
	}
	.modal-title-input::placeholder { color: var(--text-tertiary); font-weight: 400; }

	.modal-header { display: flex; align-items: center; gap: var(--space-md); margin-bottom: var(--space-md); }
	.close-btn { padding: var(--space-xs) !important; flex-shrink: 0; }

	/* Tab bar */
	.tab-bar {
		display: flex; gap: 2px; border-bottom: 1px solid var(--glass-border);
		margin-bottom: var(--space-lg);
	}
	.tab {
		display: flex; align-items: center; gap: 6px;
		padding: var(--space-sm) var(--space-md); border: none; background: none;
		color: var(--text-tertiary); font: inherit; font-size: 0.82rem; font-weight: 600;
		cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.tab:hover { color: var(--text-secondary); }
	.tab.active { color: var(--accent-indigo); border-bottom-color: var(--accent-indigo); }
	.tab-badge {
		font-size: 0.65rem; background: var(--accent-indigo); color: white;
		padding: 1px 6px; border-radius: var(--radius-full); font-weight: 700;
	}

	/* Two-column grid */
	.modal-body-grid { display: grid; grid-template-columns: 1fr 240px; gap: var(--space-xl); }
	.main-panel { min-width: 0; }
	.sidebar-panel {
		border-left: 1px solid var(--glass-border); padding-left: var(--space-lg);
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
	@media (max-width: 768px) {
		.modal-body-grid { grid-template-columns: 1fr; }
		.sidebar-panel { border-left: none; padding-left: 0; border-top: 1px solid var(--glass-border); padding-top: var(--space-lg); }
	}

	.form-group { margin-bottom: var(--space-lg); }
	.form-group label {
		display: flex; align-items: center; gap: var(--space-sm);
		font-size: 0.75rem; font-weight: 600; color: var(--text-secondary);
		text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm);
	}
	.form-row { display: flex; gap: var(--space-lg); align-items: flex-start; }

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

	/* Labels picker */
	.labels-section { margin-bottom: var(--space-md); }
	.labels-section label { display: block; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-tertiary); margin-bottom: var(--space-xs); }
	.labels-picker { display: flex; flex-wrap: wrap; gap: 4px; }
	.label-toggle {
		padding: 3px 10px; border-radius: var(--radius-full);
		font-size: 0.7rem; font-weight: 600; cursor: pointer;
		border: 1.5px solid var(--lc); color: var(--lc);
		background: transparent; transition: all 0.15s;
	}
	.label-toggle:hover { background: color-mix(in srgb, var(--lc) 10%, transparent); }
	.label-toggle.active { background: var(--lc); color: white; }

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
</style>
