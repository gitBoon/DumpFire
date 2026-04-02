<script lang="ts">
	import type { SubtaskType } from '$lib/types';

	let {
		subtask = null,
		cardId,
		boardId,
		onSave,
		onDelete,
		onClose
	}: {
		subtask: SubtaskType | null;
		cardId: number;
		boardId: number;
		onSave: (data: SubtaskType) => void;
		onDelete?: () => void;
		onClose: () => void;
	} = $props();

	// svelte-ignore state_referenced_locally — intentional: initialize form fields from prop snapshot
	let title = $state(subtask?.title || '');
	let description = $state(subtask?.description || '');
	let priority = $state(subtask?.priority || 'medium');
	let colorTag = $state(subtask?.colorTag || '');
	let dueDate = $state(subtask?.dueDate || '');
	let showDueDate = $state(!!subtask?.dueDate);
	let completed = $state(subtask?.completed || false);

	const colorTags = [
		'', '#ef4444', '#f97316', '#f59e0b', '#22c55e',
		'#06b6d4', '#6366f1', '#8b5cf6', '#ec4899'
	];

	async function save() {
		if (!title.trim()) return;

		const payload = {
			title: title.trim(),
			description,
			priority,
			colorTag,
			dueDate: dueDate || null,
			completed,
			boardId
		};

		// Local-only mode for new card creation (no API calls)
		if (cardId === 0) {
			onSave({ ...payload, id: subtask?.id ?? 0, cardId: 0, position: subtask?.position ?? 0 } as any);
			return;
		}

		if (subtask) {
			// Update existing
			const res = await fetch(`/api/subtasks/${subtask.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (res.ok) {
				const updated = await res.json();
				onSave(updated);
			}
		} else {
			// Create new
			const res = await fetch('/api/subtasks', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cardId, ...payload })
			});
			if (res.ok) {
				const created = await res.json();
				onSave(created);
			}
		}
	}

	async function handleDelete() {
		if (subtask && onDelete) {
			await fetch(`/api/subtasks/${subtask.id}`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ boardId })
			});
			onDelete();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}

	function getPriorityColor(p: string) {
		const map: Record<string, string> = {
			critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e'
		};
		return map[p] || '#eab308';
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay subtask-overlay" onclick={onClose} role="dialog" aria-modal="true" aria-label="Subtask editor">
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="subtask-modal" onclick={(e) => e.stopPropagation()} role="document">
		<div class="modal-header">
			<div class="modal-header-left">
				<span class="subtask-icon" style="background: {getPriorityColor(priority)}20; color: {getPriorityColor(priority)}">
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
						<path d="M3 7l3 3 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				</span>
				<h2>{subtask ? 'Edit Subtask' : 'New Subtask'}</h2>
			</div>
			<button class="close-btn btn-ghost" onclick={onClose} aria-label="Close">
				<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
					<path d="M4 4l10 10M14 4L4 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
				</svg>
			</button>
		</div>

		<div class="form-group">
			<label for="st-title">Title</label>
			<input
				id="st-title" type="text" placeholder="What needs to be done?"
				bind:value={title} autofocus
			/>
		</div>

		<div class="form-group">
			<label for="st-desc">Description</label>
			<textarea
				id="st-desc" placeholder="Add notes, context, or instructions..."
				bind:value={description} rows="4"
			></textarea>
		</div>

		<div class="form-row">
			<div class="form-group" style="flex: 1">
				<label for="st-priority">Priority</label>
				<select id="st-priority" bind:value={priority}>
					<option value="low">🟢 Low</option>
					<option value="medium">🟡 Medium</option>
					<option value="high">🟠 High</option>
					<option value="critical">🔴 Critical</option>
				</select>
			</div>
			<div class="form-group" style="flex: 1">
				{#if showDueDate}
					<div class="due-date-header">
						<label for="st-due">Due Date</label>
						<button class="btn-ghost due-clear" onclick={() => { showDueDate = false; dueDate = ''; }}>
							<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
						</button>
					</div>
					<input id="st-due" type="date" bind:value={dueDate} />
				{:else}
					<label>Due Date</label>
					<button class="btn-ghost due-add-btn" onclick={() => (showDueDate = true)}>
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
						Set date
					</button>
				{/if}
			</div>
		</div>

		<div class="form-group">
			<label>Color Tag</label>
			<div class="color-tag-picker">
				{#each colorTags as ct}
					<button
						class="color-tag-btn" class:active={colorTag === ct}
						style={ct ? `background: ${ct}` : ''} onclick={() => (colorTag = ct)} title={ct || 'None'}
					>
						{#if !ct}
							<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
								<path d="M2 2l8 8M10 2L2 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
							</svg>
						{/if}
					</button>
				{/each}
				<label class="color-custom-wrapper">
					<input type="color" bind:value={colorTag} class="color-native-input" />
					<span class="color-tag-btn custom" style="background: {colorTag || 'var(--bg-elevated)'}">✎</span>
				</label>
			</div>
		</div>

		{#if subtask}
			<div class="form-group">
				<label class="completed-toggle">
					<button class="subtask-checkbox" class:checked={completed} onclick={() => (completed = !completed)}>
						{#if completed}
							<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
								<path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
							</svg>
						{/if}
					</button>
					<span class="toggle-label">{completed ? 'Completed' : 'Mark as complete'}</span>
				</label>
			</div>
		{/if}

		<div class="modal-actions">
			{#if onDelete && subtask}
				<button class="btn-danger" onclick={handleDelete}>
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
						<path d="M2 4h10M5 4V2.5A.5.5 0 015.5 2h3a.5.5 0 01.5.5V4m1.5 0l-.5 8a1 1 0 01-1 1h-5a1 1 0 01-1-1l-.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
					Delete
				</button>
			{/if}
			<div style="flex: 1"></div>
			<button class="btn-ghost" onclick={onClose}>Cancel</button>
			<button class="btn-primary" onclick={save} disabled={!title.trim()}>
				{subtask ? 'Save Changes' : 'Add Subtask'}
			</button>
		</div>
	</div>
</div>

<style>
	.subtask-overlay { z-index: 1100; }

	.subtask-modal {
		background: var(--bg-surface);
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-xl);
		padding: var(--space-2xl);
		width: 90%;
		max-width: 480px;
		max-height: 85vh;
		overflow-y: auto;
		box-shadow: var(--shadow-lg);
		animation: scaleIn var(--duration-normal) var(--ease-spring);
	}

	.modal-header {
		display: flex; align-items: center; justify-content: space-between;
		margin-bottom: var(--space-xl);
	}
	.modal-header-left { display: flex; align-items: center; gap: var(--space-md); }
	.modal-header h2 { font-size: 1.1rem; }

	.subtask-icon {
		width: 32px; height: 32px; border-radius: var(--radius-sm);
		display: flex; align-items: center; justify-content: center;
	}

	.close-btn { padding: var(--space-xs) !important; }

	.form-group { margin-bottom: var(--space-lg); }
	.form-group label {
		display: block; font-size: 0.75rem; font-weight: 600;
		color: var(--text-secondary); text-transform: uppercase;
		letter-spacing: 0.05em; margin-bottom: var(--space-sm);
	}
	.form-row { display: flex; gap: var(--space-lg); }

	.color-tag-picker { display: flex; gap: 6px; }
	.color-tag-btn {
		width: 26px; height: 26px; border-radius: var(--radius-sm);
		border: 2px solid transparent; cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		transition: all var(--duration-fast) var(--ease-out);
		background: var(--bg-elevated); color: var(--text-tertiary);
	}
	.color-tag-btn:hover { transform: scale(1.1); }
	.color-tag-btn.active { border-color: var(--text-primary); }

	.completed-toggle {
		display: flex !important; align-items: center; gap: var(--space-md);
		cursor: pointer; text-transform: none !important; letter-spacing: 0 !important;
		font-size: 0.875rem !important; font-weight: 500 !important;
		color: var(--text-primary) !important;
	}

	.subtask-checkbox {
		width: 20px; height: 20px; border-radius: 4px; flex-shrink: 0;
		border: 2px solid var(--glass-border); background: transparent;
		display: flex; align-items: center; justify-content: center;
		transition: all var(--duration-fast) var(--ease-out); padding: 0;
		color: white; cursor: pointer;
	}
	.subtask-checkbox:hover { border-color: var(--accent-indigo); }
	.subtask-checkbox.checked { background: var(--accent-emerald); border-color: var(--accent-emerald); }

	.modal-actions {
		display: flex; align-items: center; gap: var(--space-md);
		padding-top: var(--space-lg); border-top: 1px solid var(--glass-border);
	}

	.btn-danger {
		display: inline-flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md); background: rgba(244, 63, 94, 0.1);
		color: var(--accent-rose); border-radius: var(--radius-sm);
		font-weight: 500; font-size: 0.85rem; border: 1px solid rgba(244, 63, 94, 0.2);
	}
	.btn-danger:hover { background: rgba(244, 63, 94, 0.2); }

	@keyframes scaleIn {
		from { opacity: 0; transform: scale(0.95); }
		to { opacity: 1; transform: scale(1); }
	}

	/* Due date toggle */
	.due-date-header { display: flex; align-items: center; justify-content: space-between; }
	.due-clear { padding: 2px !important; opacity: 0.5; margin-bottom: var(--space-sm); }
	.due-clear:hover { opacity: 1; }
	.due-add-btn { font-size: 0.8rem !important; display: flex; gap: var(--space-xs); align-items: center; color: var(--text-tertiary) !important; }
	.due-add-btn:hover { color: var(--text-secondary) !important; }

	/* Custom color picker */
	.color-custom-wrapper { position: relative; cursor: pointer; display: inline-flex; }
	.color-native-input { position: absolute; width: 0; height: 0; opacity: 0; pointer-events: none; }
	.color-tag-btn.custom { font-size: 0.6rem; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5); }
</style>
