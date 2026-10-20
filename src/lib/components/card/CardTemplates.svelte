<!--
  CardTemplates.svelte — The card window's two template dialogs: Save as
  Template, from a saved card, and Create from Template, for a new one
  (card 2280, slice B4: moved from CardModal.svelte).

  Drawn by the window after its own overlay, in front of it. Which dialog is
  open, the name typed, the list and why the open dialog's last request was
  not done are the window's, bound here: its footer opens them, fills the
  name from the title and reads the list. Saving a template and deleting
  one are sent from here, each answer read and a refusal said in the
  dialog. A template picked is applied by the window (`applyTemplate`) to
  its own fields.
-->
<script module lang="ts">
	export type TemplateItem = { id: number; name: string; title: string; description: string; priority: string; subtasksJson: string; labelsJson: string; boardId: number | null };
</script>

<script lang="ts">
	import { priorityToCopy } from '$lib/utils/card-utils';
	import { deleteFailure, failureMessage } from '$lib/api';
	import type { CardType, SubtaskType } from '$lib/types';

	let {
		card,
		boardId,
		title,
		description,
		priority,
		cardSubtasks,
		cardLabelIds,
		templates = $bindable(),
		showTemplatePicker = $bindable(),
		showSaveTemplate = $bindable(),
		templateName = $bindable(),
		templateError = $bindable(),
		applyTemplate
	}: {
		card: CardType | null;
		boardId: number;
		title: string;
		description: string;
		priority: string;
		cardSubtasks: SubtaskType[];
		cardLabelIds: number[];
		templates: TemplateItem[];
		showTemplatePicker: boolean;
		showSaveTemplate: boolean;
		templateName: string;
		templateError: string;
		/** The window's: fills its fields from the template, and closes the picker. */
		applyTemplate: (tmpl: TemplateItem) => void;
	} = $props();

	/** What a change that got no answer says: it may or may not have been made. */
	const NO_ANSWER = 'No answer from the server. It is not known whether that was saved.';

	let templateSaving = $state(false);

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
</script>

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
	/* Why the open dialog's last request was not done, as the window says a refusal. */
	.dep-error {
		margin-bottom: 8px; padding: 7px 10px;
		font-size: 0.74rem; line-height: 1.4;
		background: rgba(244, 63, 94, 0.1); color: var(--accent-rose);
		border: 1px solid rgba(244, 63, 94, 0.25); border-radius: var(--radius-sm);
	}

	/* ─── Templates ──────────────────────────────────────── */
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
</style>
