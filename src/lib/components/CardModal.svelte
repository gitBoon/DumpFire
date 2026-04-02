<script lang="ts">
	import SubtaskModal from './SubtaskModal.svelte';
	import { marked } from 'marked';

	type SubtaskType = {
		id: number;
		cardId: number;
		title: string;
		description: string;
		priority: string;
		colorTag: string;
		dueDate: string | null;
		completed: boolean;
		position: number;
	};

	type SubBoardType = {
		id: number;
		name: string;
		emoji: string;
		done: number;
		total: number;
	};

	type CardType = {
		id: number;
		columnId: number;
		categoryId: number | null;
		title: string;
		description: string;
		position: number;
		priority: string;
		colorTag: string;
		dueDate: string | null;
		onHoldNote: string;
		createdAt: string;
		updatedAt: string;
		subtasks: SubtaskType[];
		subBoards?: SubBoardType[];
	};

	type CategoryType = {
		id: number;
		boardId: number;
		name: string;
		color: string;
	};

	type LabelType = {
		id: number;
		boardId: number;
		name: string;
		color: string;
	};

	let {
		card = null,
		categories = [],
		labels = [],
		boardId,
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
		onSave: (data: { title: string; description: string; priority: string; colorTag: string; categoryId: number | null; dueDate: string | null; onHoldNote?: string; pendingSubtasks?: string[] }) => void;
		onDelete?: () => void;
		onClose: () => void;
		onCreateSubBoard?: (name: string) => void;
		onDeleteSubBoard?: (boardId: number) => void;
		onLinkSubBoard?: (boardId: number) => void;
		availableBoards?: { id: number; name: string; emoji: string }[];
	} = $props();

	let newSubBoardName = $state(card?.title || '');
	let showLinkPicker = $state(false);

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

	let title = $state(card?.title || '');
	let description = $state(card?.description || '');
	let priority = $state(card?.priority || 'medium');

	let categoryId = $state<number | null>(card?.categoryId ?? null);
	let dueDate = $state(card?.dueDate || '');
	let showDueDate = $state(!!card?.dueDate);
	let descPreview = $state(false);
	let onHoldNote = $state(card?.onHoldNote || '');
	let editingOnHold = $state(false);
	let cardSubtasks = $state<SubtaskType[]>(card?.subtasks || []);

	// Subtask modal state
	let showSubtaskModal = $state(false);
	let editingSubtask = $state<SubtaskType | null>(null);
	let editingPendingSubtask = $state<PendingSubtask | null>(null);



	function save() {
		if (!title.trim()) return;
		onSave({
			title: title.trim(), description, priority, colorTag: '', categoryId,
			dueDate: dueDate || null, onHoldNote: onHoldNote || undefined,
			pendingSubtasks: pendingSubtasks.length > 0
				? pendingSubtasks.map(s => JSON.stringify({ title: s.title, description: s.description, priority: s.priority, colorTag: s.colorTag, dueDate: s.dueDate }))
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
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay" onclick={onClose} role="dialog" aria-modal="true" aria-label="Card editor">
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-content card-modal-content" onclick={(e) => e.stopPropagation()} role="document">
		<div class="modal-header">
			<h2>{card ? 'Edit Card' : 'New Card'}</h2>
			<button class="close-btn btn-ghost" onclick={onClose} aria-label="Close">
				<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
					<path d="M4 4l10 10M14 4L4 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
				</svg>
			</button>
		</div>

		<div class="form-group">
			<label for="card-title">Title</label>
			<input
				id="card-title" type="text" placeholder="What needs to be done?"
				bind:value={title}
				onkeydown={(e) => e.key === 'Enter' && !e.shiftKey && save()}
				autofocus
			/>
		</div>

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

		<div class="form-row">
			<div class="form-group" style="flex: 1">
				<label for="card-priority">Priority</label>
				<select id="card-priority" bind:value={priority}>
					<option value="low">🟢 Low</option>
					<option value="medium">🟡 Medium</option>
					<option value="high">🟠 High</option>
					<option value="critical">🔴 Critical</option>
				</select>
			</div>
			<div class="form-group" style="flex: 1">
				<label for="card-category">Category</label>
				<select id="card-category" bind:value={categoryId}>
					<option value={null}>None</option>
					{#each categories as cat}
						<option value={cat.id}>{cat.name}</option>
					{/each}
				</select>
			</div>
		</div>

		<div class="form-row">
			<div class="form-group" style="flex: 1">
				{#if showDueDate}
					<div class="due-date-header">
						<label for="card-due">Due Date</label>
						<button class="btn-ghost due-clear" onclick={() => { showDueDate = false; dueDate = ''; }} title="Remove due date">
							<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
						</button>
					</div>
					<input id="card-due" type="date" bind:value={dueDate} />
				{:else}
					<label>Due Date</label>
					<button class="btn-ghost due-add-btn" onclick={() => (showDueDate = true)}>
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
						Set due date
					</button>
				{/if}
			</div>
		</div>

		<!-- Labels -->
		{#if card && labels.length > 0}
			<div class="labels-section">
				<label>Labels</label>
				<div class="labels-picker">
					{#each labels as label}
						<button
							class="label-toggle"
							class:active={cardLabelIds.includes(label.id)}
							style="--lc: {label.color}"
							onclick={() => toggleLabel(label.id)}
						>
							{label.name}
						</button>
					{/each}
				</div>
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
						<input
							type="text"
							class="subboard-name-input"
							placeholder="Sub-board name..."
							bind:value={newSubBoardName}
							onkeydown={(e) => e.key === 'Enter' && newSubBoardName.trim() && onCreateSubBoard!(newSubBoardName.trim())}
						/>
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
									<button class="link-picker-item" onclick={() => { onLinkSubBoard!(ab.id); showLinkPicker = false; }}>
										{ab.emoji} {ab.name}
									</button>
								{/each}
							</div>
						{:else}
							<button class="btn-ghost subboard-link-btn" onclick={() => (showLinkPicker = true)}>
								🔗 Link existing board
							</button>
						{/if}
					</div>
				{/if}

				{#if (!card.subBoards || card.subBoards.length === 0) && !onCreateSubBoard}
					<p class="empty-subtasks">No sub-boards yet.</p>
				{/if}
			</div>
		{/if}

		{#if card}
			<div class="card-timestamp">
				Created {new Date(card.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
			</div>
		{/if}

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
	.card-modal-content { max-width: 840px; }

	.modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-lg); }
	.modal-header h2 { font-size: 1.2rem; }
	.close-btn { padding: var(--space-xs) !important; }

	.form-group { margin-bottom: var(--space-lg); }
	.form-group label {
		display: flex; align-items: center; gap: var(--space-sm);
		font-size: 0.75rem; font-weight: 600; color: var(--text-secondary);
		text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm);
	}
	.form-row { display: flex; gap: var(--space-lg); align-items: flex-start; }



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
</style>
