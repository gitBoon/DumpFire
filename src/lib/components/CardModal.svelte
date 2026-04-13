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
	import DOMPurify from 'dompurify';
	import { COLUMN_COLORS } from '$lib/utils/constants';
	import { highlightMentions } from '$lib/utils/mentions';
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
	let titleError = $state(false);

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

	// Card cover state
	// svelte-ignore state_referenced_locally
	let coverUrl = $state(card?.coverUrl || '');
	const coverPresets = [
		'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
		'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
		'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
		'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
		'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
		'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
		'linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)',
		'linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)',
		'#6366f1', '#ef4444', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'
	];

	async function setCover(value: string) {
		coverUrl = value;
		if (card) {
			await fetch(`/api/cards/${card.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ coverUrl: value || null, boardId })
			});
		}
	}

	async function clearCover() {
		coverUrl = '';
		if (card) {
			await fetch(`/api/cards/${card.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ coverUrl: null, boardId })
			});
		}
	}
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

	// Template state
	type TemplateItem = { id: number; name: string; title: string; description: string; priority: string; subtasksJson: string; labelsJson: string; boardId: number | null };
	let templates = $state<TemplateItem[]>([]);
	let showTemplatePicker = $state(false);
	let showSaveTemplate = $state(false);
	let templateName = $state('');
	let templateSaving = $state(false);

	async function loadTemplates() {
		const res = await fetch(`/api/templates?boardId=${boardId}`);
		if (res.ok) templates = await res.json();
	}

	async function saveAsTemplate() {
		if (!templateName.trim()) return;
		templateSaving = true;
		await fetch('/api/templates', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				boardId,
				name: templateName.trim(),
				title: title,
				description: description,
				priority: priority,
				subtasks: card ? cardSubtasks.map(s => ({ title: s.title, description: s.description, priority: s.priority })) : [],
				labels: cardLabelIds
			})
		});
		templateSaving = false;
		showSaveTemplate = false;
		templateName = '';
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
		showTemplatePicker = false;
	}

	async function deleteTemplate(id: number) {
		await fetch(`/api/templates/${id}`, { method: 'DELETE' });
		templates = templates.filter(t => t.id !== id);
	}

	function save() {
		if (!title.trim()) {
			titleError = true;
			setTimeout(() => (titleError = false), 1500);
			return;
		}
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

	async function uploadFiles(files: FileList | File[]) {
		if (!card) return;
		uploading = true;
		for (const file of files) {
			const form = new FormData();
			form.append('file', file);
			const res = await fetch(`/api/cards/${card.id}/attachments`, {
				method: 'POST',
				body: form
			});
			if (res.ok) {
				const created = await res.json();
				attachments = [...attachments, created];
			}
		}
		uploading = false;
	}

	async function deleteAttachment(id: number) {
		if (!card) return;
		const res = await fetch(`/api/cards/${card.id}/attachments/${id}`, { method: 'DELETE' });
		if (res.ok) attachments = attachments.filter(a => a.id !== id);
	}

	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function isImageMime(mime: string): boolean {
		return mime.startsWith('image/');
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

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Card editor">
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-content card-modal-content" onclick={(e) => { e.stopPropagation(); closeAllDropdowns(); }} role="document">
		{#if coverUrl}
			<div class="modal-cover-preview" style="background: {coverUrl}"></div>
		{/if}
		<div class="modal-header">
			<h2>{card ? 'Edit Task' : 'New Task'}</h2>
			<div class="modal-header-actions">
				{#if card}
					<button class="share-link-btn btn-ghost" onclick={shareLink} title="Copy link to this task">
						{#if linkCopied}
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green, #10b981)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
							<span class="copied-tooltip">Copied!</span>
						{:else}
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
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
		<div class="title-field" class:title-error={titleError}>
			<input id="card-title" class="modal-title-input" type="text" placeholder="What needs to be done?" bind:value={title} oninput={() => (titleError = false)} onkeydown={(e) => e.key === 'Enter' && !e.shiftKey && save()} autofocus />
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
						{@html DOMPurify.sanitize(marked(description) as string)}
					{:else}
						<p class="desc-empty">Nothing to preview</p>
					{/if}
				</div>
			{:else}
			<textarea id="card-desc" placeholder="Add a description…" bind:value={description} rows="3"></textarea>
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
						<span class="chip-dot" style="background: {getPriorityColor(priority)}"></span>
						<span>{priority.charAt(0).toUpperCase() + priority.slice(1)}</span>
						<svg class="chip-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
					</button>
					{#if showPriorityDrop}
					<div class="chip-dropdown" onclick={(e) => e.stopPropagation()}>
						{#each ['critical', 'high', 'medium', 'low'] as p}
							<button class="chip-dropdown-item" class:selected={priority === p} onclick={() => { priority = p; showPriorityDrop = false; }}>
								<span class="chip-dot" style="background: {getPriorityColor(p)}"></span>
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
						{#each localCategories as cat}
							<button class="chip-dropdown-item" class:selected={categoryId === cat.id} onclick={() => { categoryId = cat.id; showCategoryDrop = false; }}>
								<span class="chip-dot" style="background: {cat.color}"></span>
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
						<span>{dueDate ? new Date(dueDate + 'T00:00').toLocaleDateString('en-GB', {day:'numeric',month:'short'}) : 'Due date'}</span>
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
			<textarea id="card-bv" placeholder="Why is this important? What value does it deliver?" bind:value={businessValue} rows="2"></textarea>
		</div>
		{/if}

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
									<div class="comment-content markdown-body">{@html DOMPurify.sanitize(highlightMentions(marked(comment.content) as string))}</div>
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
							{#if isImageMime(att.mimeType)}
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
								<input type="text" class="subboard-name-input" placeholder="Link to a sub-board..." bind:value={newSubBoardName} onkeydown={(e) => e.key === 'Enter' && newSubBoardName.trim() && onCreateSubBoard!(newSubBoardName.trim())} />
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
							<input type="text" class="subboard-name-input" placeholder="Link to a sub-board..." bind:value={newPendingSubBoardName} onkeydown={(e) => { if (e.key === 'Enter' && newPendingSubBoardName.trim()) { pendingSubBoardNames = [...pendingSubBoardNames, newPendingSubBoardName.trim()]; newPendingSubBoardName = ''; } }} />
							<button class="btn-ghost subboard-add-btn" onclick={() => { if (newPendingSubBoardName.trim()) { pendingSubBoardNames = [...pendingSubBoardNames, newPendingSubBoardName.trim()]; newPendingSubBoardName = ''; } }} disabled={!newPendingSubBoardName.trim()}>+ Add</button>
						</div>
					{/if}
				</div>

				{#if labels.length > 0}
				<div class="form-group">
					<label>Labels</label>
					<div class="labels-picker">
						{#each labels as label}
							<button class="label-toggle" class:active={cardLabelIds.includes(label.id)} style="--lc: {label.color}" onclick={() => toggleLabel(label.id)}>{label.name}</button>
						{/each}
					</div>
				</div>
				{/if}

				<div class="form-group">
					<label>Cover</label>
					<div class="cover-picker">
						<button class="cover-swatch cover-swatch-none" class:active={!coverUrl} onclick={clearCover} title="No cover" type="button"></button>
						{#each coverPresets as preset}
							<button class="cover-swatch" class:active={coverUrl === preset} style="background: {preset}" onclick={() => setCover(preset)} title="Set cover" type="button"></button>
						{/each}
						<label class="color-custom-wrapper">
							<input type="color" value={coverUrl || '#6366f1'} onchange={(e) => setCover((e.target as HTMLInputElement).value)} class="color-native-input" />
							<span class="cover-swatch custom" style="background: {coverUrl || 'var(--bg-elevated)'}">✎</span>
						</label>
					</div>
				</div>
			</div>
			{/if}
		</div>

		{#if card}
			<div class="sidebar-timestamp">
				Created {new Date(card.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
			</div>
		{/if}
		{/if} <!-- end details-only block for more options -->
		</div> <!-- end modal-body-grid -->
		</div> <!-- end modal-body -->

		<div class="modal-footer">
			<div class="footer-left">
				{#if card}
					<button class="template-btn" onclick={() => { showSaveTemplate = true; templateName = title; }} type="button">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
						Save as Template
					</button>
				{:else}
					<button class="template-btn" onclick={() => { showTemplatePicker = true; loadTemplates(); }} type="button">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
						From template
					</button>
				{/if}
				{#if onDelete}
					<button class="btn-danger" onclick={onDelete}>
						<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2.5A.5.5 0 015.5 2h3a.5.5 0 01.5.5V4m1.5 0l-.5 8a1 1 0 01-1 1h-5a1 1 0 01-1-1l-.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
						Delete
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
			<p class="template-desc">Save this card's configuration as a reusable template.</p>
			<div class="template-field">
				<label for="tmpl-name">Template Name</label>
				<input id="tmpl-name" type="text" bind:value={templateName} placeholder="e.g. Bug Report, Feature Request..." onkeydown={(e) => e.key === 'Enter' && saveAsTemplate()} autofocus />
			</div>
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
		background: white;
		border: 1px solid #e5e7eb;
	}
	[data-theme="dark"] .card-modal-content,
	[data-theme="midnight"] .card-modal-content,
	[data-theme="ocean-depth"] .card-modal-content,
	[data-theme="cyberpunk"] .card-modal-content,
	[data-theme="nord-dark"] .card-modal-content,
	[data-theme="tokyo-night"] .card-modal-content,
	[data-theme="gruvbox-dark"] .card-modal-content,
	[data-theme="synthwave"] .card-modal-content,
	[data-theme="monokai"] .card-modal-content { background: var(--bg-surface); border-color: var(--glass-border); }

	/* Modal body wrapper */
	.modal-body { padding: var(--space-lg) var(--space-xl) var(--space-xl); }

	/* Softer field styles for card modal */
	.card-modal-content input,
	.card-modal-content textarea,
	.card-modal-content select {
		background: #f4f4f8; border: 1px solid #e5e5ec;
	}
	.card-modal-content input:focus,
	.card-modal-content textarea:focus,
	.card-modal-content select:focus {
		border-color: var(--accent-indigo); box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.12);
	}
	[data-theme="dark"] .card-modal-content input,
	[data-theme="dark"] .card-modal-content textarea,
	[data-theme="dark"] .card-modal-content select {
		background: var(--bg-base); border-color: var(--glass-border);
	}
	[data-theme="dark"] .card-modal-content input:focus,
	[data-theme="dark"] .card-modal-content textarea:focus,
	[data-theme="dark"] .card-modal-content select:focus {
		box-shadow: 0 0 0 2px var(--accent-purple-glow);
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
		background: #f4f4f8; border: 1px solid transparent;
		border-radius: var(--radius-md);
		color: var(--text-primary); font-family: var(--font-family); outline: none;
		padding: var(--space-md) var(--space-lg);
		transition: border-color 0.2s ease, background 0.2s ease;
		caret-color: var(--accent-indigo);
	}
	.modal-title-input:hover { border-color: #e5e5ec; }
	.modal-title-input:focus { border-color: var(--accent-indigo); background: #f4f4f8; box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.12); }
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
	.modal-header-actions { display: flex; align-items: center; gap: var(--space-xs); }
	.close-btn { padding: var(--space-xs) !important; flex-shrink: 0; }
	.share-link-btn {
		position: relative; padding: var(--space-xs) !important; flex-shrink: 0;
		color: var(--text-tertiary); transition: color var(--duration-fast) var(--ease-out);
	}
	.share-link-btn:hover { color: var(--accent-purple, #6366f1); }
	.copied-tooltip {
		position: absolute; top: -28px; left: 50%; transform: translateX(-50%);
		background: var(--accent-green, #10b981); color: white; font-size: 0.65rem; font-weight: 600;
		padding: 2px 8px; border-radius: var(--radius-sm); white-space: nowrap;
		animation: fade-tooltip 2s ease-out forwards; pointer-events: none;
	}
	@keyframes fade-tooltip {
		0%, 70% { opacity: 1; transform: translateX(-50%) translateY(0); }
		100% { opacity: 0; transform: translateX(-50%) translateY(-4px); }
	}

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
