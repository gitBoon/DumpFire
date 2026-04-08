<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { COLUMN_COLORS } from '$lib/utils/constants';

	let { categories, onClose }: { categories: { id: number; name: string; color: string }[]; onClose: () => void } = $props();

	let newName = $state('');
	let newColor = $state('#6366f1');
	let editingId = $state<number | null>(null);
	let editName = $state('');
	let editColor = $state('');
	let loading = $state(false);

	async function createCategory() {
		if (!newName.trim() || loading) return;
		loading = true;
		const res = await fetch('/api/board-categories', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: newName.trim(), color: newColor })
		});
		if (res.ok) {
			newName = '';
			newColor = '#6366f1';
			await invalidateAll();
		}
		loading = false;
	}

	function startEdit(cat: { id: number; name: string; color: string }) {
		editingId = cat.id;
		editName = cat.name;
		editColor = cat.color;
	}

	async function saveEdit() {
		if (!editingId || !editName.trim() || loading) return;
		loading = true;
		const res = await fetch(`/api/board-categories/${editingId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: editName.trim(), color: editColor })
		});
		if (res.ok) {
			editingId = null;
			await invalidateAll();
		}
		loading = false;
	}

	async function deleteCategory(id: number) {
		if (loading || !confirm('Are you sure you want to delete this category? Boards using it will become uncategorised.')) return;
		loading = true;
		const res = await fetch(`/api/board-categories/${id}`, { method: 'DELETE' });
		if (res.ok) {
			await invalidateAll();
		}
		loading = false;
	}
</script>

<div class="modal-overlay" role="dialog" aria-modal="true">
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-content cat-mgr" onclick={(e) => e.stopPropagation()} role="document">
		<header class="mgr-header">
			<h2>Manage Categories</h2>
			<button class="close-btn" onclick={onClose}>×</button>
		</header>

		<div class="cat-list">
			{#if categories.length === 0}
				<div class="empty-state">No categories yet.</div>
			{/if}

			{#each categories as cat (cat.id)}
				<div class="cat-row" class:is-editing={editingId === cat.id}>
					{#if editingId === cat.id}
						<div class="edit-mode">
							<label class="color-picker-wrap">
								<input type="color" bind:value={editColor} class="color-native" title="Pick color" />
								<div class="color-swatch custom" style="background: {editColor}">🎨</div>
							</label>
							<input type="text" bind:value={editName} class="edit-input" onkeydown={(e) => e.key === 'Enter' && saveEdit()} autofocus />
							<div class="edit-actions">
								<button class="btn-primary small" onclick={saveEdit} disabled={loading || !editName.trim()}>Save</button>
								<button class="btn-ghost small" onclick={() => (editingId = null)}>Cancel</button>
							</div>
						</div>
					{:else}
						<div class="view-mode">
							<span class="cat-dot" style="background: {cat.color}"></span>
							<span class="cat-name">{cat.name}</span>
							<div class="row-actions">
								<button class="action-btn" title="Edit category" onclick={() => startEdit(cat)}>✎</button>
								<button class="action-btn danger" title="Delete category" onclick={() => deleteCategory(cat.id)}>
									<svg width="12" height="12" viewBox="0 0 14 14" fill="none">
										<path d="M2 4h10M5 4V2.5A.5.5 0 015.5 2h3a.5.5 0 01.5.5V4m1.5 0l-.5 8a1 1 0 01-1 1h-5a1 1 0 01-1-1l-.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
									</svg>
								</button>
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>

		<div class="create-section">
			<h3>Create New</h3>
			<div class="create-form">
				<label class="color-picker-wrap">
					<input type="color" bind:value={newColor} class="color-native" title="Pick color" />
					<div class="color-swatch custom" style="background: {newColor}">🎨</div>
				</label>
				<input type="text" placeholder="Category name..." bind:value={newName} class="create-input" onkeydown={(e) => e.key === 'Enter' && createCategory()} />
				<button class="btn-primary" onclick={createCategory} disabled={loading || !newName.trim()}>Add</button>
			</div>
			<div class="quick-colors">
				{#each COLUMN_COLORS.slice(0, 8) as c}
					<button class="quick-swatch" class:active={newColor === c} style="background: {c}" onclick={() => (newColor = c)} type="button"></button>
				{/each}
			</div>
		</div>
	</div>
</div>

<style>
	.cat-mgr {
		max-width: 480px; padding: 0; display: flex; flex-direction: column; overflow: hidden;
	}
	.mgr-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-lg) var(--space-xl);
		border-bottom: 1px solid var(--glass-border); background: var(--bg-surface);
	}
	.mgr-header h2 { font-size: 1.1rem; margin: 0; }
	.close-btn { background: none; border: none; font-size: 1.5rem; color: var(--text-tertiary); cursor: pointer; padding: 0 4px; line-height: 1; }
	.close-btn:hover { color: var(--text-primary); }

	.cat-list {
		padding: var(--space-md) var(--space-xl); max-height: 50vh; overflow-y: auto;
		display: flex; flex-direction: column; gap: var(--space-xs);
	}
	.empty-state { padding: var(--space-xl) 0; text-align: center; color: var(--text-tertiary); font-size: 0.85rem; }
	
	.cat-row {
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
		background: var(--bg-card); transition: all var(--duration-fast);
	}
	.cat-row:hover { border-color: rgba(99, 102, 241, 0.3); }
	.cat-row.is-editing { border-color: var(--accent-indigo); background: rgba(99, 102, 241, 0.03); }

	.view-mode {
		display: flex; align-items: center; gap: var(--space-md);
		padding: var(--space-sm) var(--space-md);
	}
	.cat-dot { width: 12px; height: 12px; border-radius: 50%; box-shadow: 0 0 6px currentColor; flex-shrink: 0; }
	.cat-name { flex: 1; font-size: 0.85rem; font-weight: 600; color: var(--text-primary); }
	
	.row-actions { display: flex; gap: 4px; opacity: 0; transition: opacity 0.2s; }
	.cat-row:hover .row-actions { opacity: 1; }
	.action-btn {
		width: 28px; height: 28px; border-radius: var(--radius-sm); border: none; background: transparent;
		color: var(--text-secondary); display: flex; align-items: center; justify-content: center;
		cursor: pointer; font-size: 0.9rem; transition: all 0.15s;
	}
	.action-btn:hover { background: var(--glass-hover); color: var(--text-primary); }
	.action-btn.danger:hover { background: rgba(244, 63, 94, 0.15); color: var(--accent-rose); }

	.edit-mode {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md); flex-wrap: wrap;
	}
	.edit-input { flex: 1; min-width: 120px; padding: 6px 10px; }
	.edit-actions { display: flex; gap: 4px; }
	
	.create-section {
		padding: var(--space-lg) var(--space-xl);
		background: var(--bg-base); border-top: 1px solid var(--glass-border);
	}
	.create-section h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-tertiary); margin-bottom: var(--space-md); }
	.create-form { display: flex; align-items: center; gap: var(--space-sm); margin-bottom: var(--space-sm); }
	.create-input { flex: 1; }
	
	.color-picker-wrap { position: relative; cursor: pointer; display: flex; flex-shrink: 0; }
	.color-native { position: absolute; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
	.color-swatch {
		width: 32px; height: 32px; border-radius: var(--radius-sm);
		display: flex; align-items: center; justify-content: center;
		color: white; font-size: 0.8rem; text-shadow: 0 1px 2px rgba(0,0,0,0.5);
		border: 2px solid rgba(255,255,255,0.2); transition: transform 0.1s;
	}
	.color-picker-wrap:hover .color-swatch { transform: scale(1.05); }

	.quick-colors { display: flex; gap: 6px; padding-left: 40px; }
	.quick-swatch {
		width: 16px; height: 16px; border-radius: 4px; border: 2px solid transparent; padding: 0;
		cursor: pointer; transition: transform 0.1s;
	}
	.quick-swatch:hover { transform: scale(1.2); }
	.quick-swatch.active { border-color: var(--text-primary); transform: scale(1.1); }
	
	.btn-primary.small { padding: 4px 10px; font-size: 0.75rem; }
	.btn-ghost.small { padding: 4px 10px; font-size: 0.75rem; }
</style>
