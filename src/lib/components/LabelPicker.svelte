<!--
  LabelPicker.svelte — the Labels section of the card window (card 2010).

  A chip for each of the board's labels puts it on the card or takes it off.
  "+ New label" makes one, with a name and one of the sixteen column colours,
  and puts it on the card at once, as a category made in the window is chosen
  at once. "Edit labels" renames, recolours or deletes one; a delete asks
  first, since it takes the label off every card on the board.

  Labels used to be made only through the API, and a board with none showed
  no Labels section at all. The window shows this on every saved card; a new
  one has no id to put a label on until it is saved.

  Every request's answer is read. A chip changes only once the server has
  changed it, and a refusal is said in the line under the picker in the
  server's own words (`failureMessage`), as the window's other controls say
  theirs (card 2109).
-->
<script lang="ts">
	import * as api from '$lib/api';
	import { COLUMN_COLORS } from '$lib/utils/constants';
	import type { LabelType } from '$lib/types';
	import { drawnColour } from '$lib/colours';

	let {
		cardId,
		boardId,
		labels,
		selected = $bindable([])
	}: {
		cardId: number;
		boardId: number;
		/** The board's labels, as the page has them. */
		labels: LabelType[];
		/** The ids of the labels on the card. The card window keeps them for Save as Template. */
		selected: number[];
	} = $props();

	/**
	 * The labels offered: the page's, and any made, changed or deleted here
	 * since. The board page reloads its labels when the board changes, and this
	 * follows them when it does. The All Tasks and plan pages have no live
	 * stream, so a label made here shows there on their next load.
	 */
	let list = $derived<LabelType[]>([...labels]);

	/** Why the last change was not made, in the server's own words; empty when it was. */
	let pickerError = $state('');

	/** What a change that got no answer says: it may or may not have been made. */
	const NO_ANSWER = 'No answer from the server. It is not known whether that was saved.';

	/** A request that makes, changes or deletes a label is being answered: its button is off until then. */
	let saving = $state(false);

	// "+ New label"
	let showNew = $state(false);
	let newName = $state('');
	let newColor = $state<string>(COLUMN_COLORS[0]);

	// "Edit labels": the label open for editing, what it is being changed to,
	// and whether its delete is being asked about.
	let editMode = $state(false);
	let editingId = $state<number | null>(null);
	let editName = $state('');
	let editColor = $state('');
	let confirmingDelete = $state(false);
	const editingLabel = $derived(list.find((label) => label.id === editingId));

	// Edit mode ends when the last label goes, deleted here or by the board's
	// reload after a delete elsewhere: with nothing to pick, it hid "+ New label".
	$effect(() => {
		if (list.length === 0) {
			editMode = false;
			stopEditing();
		}
	});

	/**
	 * Puts a label on the card, or takes it off. The chip changes only once the
	 * server has changed it, and to what the server says it is now: `toggled`
	 * is true when the label is on the card. What the window believed can be
	 * stale (All Tasks reopens a card as it was loaded; someone else may have
	 * toggled the label since), and flipping that belief showed the opposite of
	 * the truth, which Save as Template then saved.
	 */
	async function toggleLabel(labelId: number) {
		pickerError = '';
		let res: Response;
		try {
			res = await api.toggleLabel(cardId, labelId, boardId);
		} catch {
			pickerError = NO_ANSWER;
			return;
		}
		if (!res.ok) {
			pickerError = await api.failureMessage(res, 'The label was not changed.');
			return;
		}
		const { toggled }: { toggled: boolean } = await res.json();
		const others = selected.filter((id) => id !== labelId);
		selected = toggled ? [...others, labelId] : others;
	}

	/** Makes a label on the board, then puts it on the card. */
	async function createLabel() {
		const name = newName.trim();
		if (!name || saving) return;
		pickerError = '';
		saving = true;
		let res: Response;
		try {
			res = await api.createLabel(boardId, name, newColor);
		} catch {
			pickerError = NO_ANSWER;
			return;
		} finally {
			saving = false;
		}
		if (!res.ok) {
			// The name stays in the form, to be put right and sent again.
			pickerError = await api.failureMessage(res, 'The label was not made.');
			return;
		}
		const made: LabelType = await res.json();
		// The board may have reloaded its labels, this one among them, before the answer came.
		list = [...list.filter((label) => label.id !== made.id), made];
		showNew = false;
		newName = '';
		newColor = COLUMN_COLORS[0];
		await toggleLabel(made.id);
	}

	/** Opens a label for editing, with its name and colour as they are. */
	function startEditing(label: LabelType) {
		editingId = label.id;
		editName = label.name;
		editColor = label.color;
		confirmingDelete = false;
		pickerError = '';
	}

	function stopEditing() {
		editingId = null;
		confirmingDelete = false;
	}

	/**
	 * Saves the name and colour of the label being edited. Both are sent: a
	 * colour stored before colours were checked, sent back as it was, is kept,
	 * so it does not stop a rename.
	 */
	async function saveLabel() {
		const id = editingId;
		const name = editName.trim();
		if (id === null || !name || saving) return;
		pickerError = '';
		saving = true;
		let res: Response;
		try {
			res = await api.updateLabel(id, { name, color: editColor });
		} catch {
			pickerError = NO_ANSWER;
			return;
		} finally {
			saving = false;
		}
		if (!res.ok) {
			pickerError = await api.failureMessage(res, 'The label was not changed.');
			return;
		}
		const changed: LabelType = await res.json();
		list = list.map((label) => (label.id === changed.id ? changed : label));
		editingId = null;
	}

	/** Deletes the label being edited, which takes it off every card on the board. It is asked about first. */
	async function deleteLabel() {
		const id = editingId;
		if (id === null || saving) return;
		pickerError = '';
		saving = true;
		const failure = await api.deleteFailure(() => api.deleteLabel(id), 'label');
		saving = false;
		confirmingDelete = false;
		if (failure) {
			pickerError = failure;
			return;
		}
		list = list.filter((label) => label.id !== id);
		selected = selected.filter((labelId) => labelId !== id);
		editingId = null;
	}

	function toggleEditMode() {
		editMode = !editMode;
		stopEditing();
		showNew = false;
		pickerError = '';
	}
</script>

<div class="label-picker">
	{#if list.length > 0}
		<div class="label-chips">
			{#each list as label (label.id)}
				{#if editMode}
					<button class="label-toggle" class:active={editingId === label.id} style="--lc: {drawnColour(label.color)}" onclick={() => startEditing(label)} title="Edit this label" type="button">{label.name}</button>
				{:else}
					<button class="label-toggle" class:active={selected.includes(label.id)} aria-pressed={selected.includes(label.id)} style="--lc: {drawnColour(label.color)}" onclick={() => toggleLabel(label.id)} type="button">{label.name}</button>
				{/if}
			{/each}
		</div>
	{:else}
		<p class="label-hint">No labels on this board yet.</p>
	{/if}

	{#if editMode}
		{#if editingLabel}
			<div class="label-form">
				<input type="text" class="label-input" placeholder="Label name" maxlength="200" bind:value={editName} onkeydown={(e) => e.key === 'Enter' && saveLabel()} aria-label="Label name" />
				<div class="label-colors">
					{#each COLUMN_COLORS as color}
						<button class="label-swatch" class:active={editColor === color} style="background: {drawnColour(color)}" onclick={() => (editColor = color)} aria-label="Colour {color}" type="button"></button>
					{/each}
				</div>
				{#if confirmingDelete}
					<p class="label-confirm">Take “{editingLabel.name}” off every card on this board and delete it?</p>
					<div class="label-actions">
						<button class="label-btn danger" onclick={deleteLabel} disabled={saving} type="button">Delete</button>
						<button class="label-btn" onclick={() => (confirmingDelete = false)} type="button">Keep it</button>
					</div>
				{:else}
					<div class="label-actions">
						<button class="label-btn primary" onclick={saveLabel} disabled={saving || !editName.trim()} type="button">Save</button>
						<button class="label-btn danger-text" onclick={() => (confirmingDelete = true)} type="button">Delete</button>
						<button class="label-btn" onclick={stopEditing} type="button">Cancel</button>
					</div>
				{/if}
			</div>
		{:else}
			<p class="label-hint">Pick a label to rename, recolour or delete it.</p>
		{/if}
	{:else if showNew}
		<div class="label-form">
			<!-- svelte-ignore a11y_autofocus -->
			<input type="text" class="label-input" placeholder="Label name" maxlength="200" bind:value={newName} onkeydown={(e) => e.key === 'Enter' && createLabel()} aria-label="New label name" autofocus />
			<div class="label-colors">
				{#each COLUMN_COLORS as color}
					<button class="label-swatch" class:active={newColor === color} style="background: {drawnColour(color)}" onclick={() => (newColor = color)} aria-label="Colour {color}" type="button"></button>
				{/each}
			</div>
			<div class="label-actions">
				<button class="label-btn primary" onclick={createLabel} disabled={saving || !newName.trim()} type="button">Create</button>
				<button class="label-btn" onclick={() => (showNew = false)} type="button">Cancel</button>
			</div>
		</div>
	{/if}

	<div class="label-links">
		{#if !editMode && !showNew}
			<button class="label-link" onclick={() => { showNew = true; pickerError = ''; }} type="button">+ New label</button>
		{/if}
		<!-- "Done editing" whenever edit mode is on, labels or none: it is the only way out. -->
		{#if editMode || (list.length > 0 && !showNew)}
			<button class="label-link" onclick={toggleEditMode} type="button">{editMode ? 'Done editing' : 'Edit labels'}</button>
		{/if}
	</div>

	{#if pickerError}
		<p class="label-error" role="alert">{pickerError}</p>
	{/if}
</div>

<style>
	.label-picker { display: flex; flex-direction: column; gap: var(--space-sm); }
	.label-chips { display: flex; flex-wrap: wrap; gap: 4px; }
	.label-toggle {
		padding: 3px 10px; border-radius: var(--radius-full);
		font-size: 0.7rem; font-weight: 600; cursor: pointer;
		border: 1.5px solid var(--lc); color: var(--lc);
		background: transparent; transition: all 0.15s;
	}
	.label-toggle:hover { background: color-mix(in srgb, var(--lc) 10%, transparent); }
	.label-toggle.active { background: var(--lc); color: white; }
	.label-hint { font-size: 0.72rem; color: var(--text-tertiary); margin: 0; }

	.label-form {
		display: flex; flex-direction: column; gap: var(--space-sm);
		padding: var(--space-md); background: var(--bg-base);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
	}
	.label-input {
		padding: var(--space-sm); font-size: 0.85rem;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); color: var(--text-primary);
		font-family: var(--font-family);
	}
	.label-input:focus { outline: none; border-color: var(--accent-indigo); }
	.label-colors { display: flex; gap: 4px; flex-wrap: wrap; }
	.label-swatch {
		width: 20px; height: 20px; border-radius: var(--radius-sm);
		border: 2px solid transparent; cursor: pointer;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.label-swatch:hover { transform: scale(1.15); }
	.label-swatch.active { border-color: var(--text-primary); box-shadow: 0 0 6px rgba(255, 255, 255, 0.2); }
	.label-confirm { font-size: 0.75rem; color: var(--text-primary); margin: 0; }

	.label-actions { display: flex; gap: var(--space-sm); flex-wrap: wrap; }
	.label-btn {
		padding: var(--space-xs) var(--space-md); font-size: 0.75rem; font-weight: 500;
		background: transparent; color: var(--text-secondary);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm); cursor: pointer;
	}
	.label-btn:hover { color: var(--text-primary); background: var(--glass-hover); }
	.label-btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.label-btn.primary {
		color: white; border-color: transparent;
		background: linear-gradient(135deg, var(--accent-purple), var(--accent-indigo));
	}
	.label-btn.danger { color: white; border-color: transparent; background: var(--accent-rose); }
	.label-btn.danger-text { color: var(--accent-rose); }

	.label-links { display: flex; gap: var(--space-md); }
	.label-link {
		font-size: 0.72rem; padding: 0; background: none; border: none;
		color: var(--accent-indigo); cursor: pointer;
	}
	.label-link:hover { text-decoration: underline; }
	.label-error { font-size: 0.72rem; color: var(--accent-rose); margin: 0; }
</style>
