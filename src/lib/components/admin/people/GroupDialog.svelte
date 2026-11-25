<!--
  GroupDialog.svelte — Add a group to the people directory, or change one
  (card 2674, plan 4.3): its name, its description, and who is in it, from a
  searchable list of people (active first; those who left marked).

  Drawn by /admin/people. A new group is added with POST /api/people-groups,
  a changed name or description saved with PUT /api/people-groups/:id, and
  the people ticked, where they changed, set with PUT
  /api/people-groups/:id/members. A refusal is said in the server's words
  (`sent`), and the page's data is read again once saved.
-->
<script lang="ts">
	import type { PageData } from '../../../../routes/admin/people/$types';
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { answerBody } from '$lib/api';
	import { sent, showToast } from '$lib/admin/send';
	import Button from '$lib/components/ui/Button.svelte';
	import Dialog from '$lib/components/ui/Dialog.svelte';

	type DirectoryGroup = PageData['groups'][number];

	let {
		data,
		group,
		onClose
	}: {
		/** What the page's load gave it: the people and groups. */
		data: PageData;
		/** The group to change, or null to add one. */
		group: DirectoryGroup | null;
		onClose: () => void;
	} = $props();

	// The form starts from the group as the dialog opened on it.
	const start = untrack(() => (group ? { ...group, personIds: [...group.personIds] } : null));
	/** The group's id once it exists: a new group's, once added, so that a members set refused after it is not added twice. */
	let groupId = $state<number | null>(start?.id ?? null);
	let saved = $state({ name: start?.name ?? '', description: start?.description ?? '', personIds: start?.personIds ?? [] });
	let name = $state(start?.name ?? '');
	let description = $state(start?.description ?? '');
	let personIds = $state<number[]>(start ? [...start.personIds] : []);
	let search = $state('');
	let saving = $state(false);

	/** The people, active first and then those who left, each by name; narrowed by the search. */
	let listed = $derived.by(() => {
		const needle = search.trim().toLowerCase();
		return data.people
			.filter((p) => needle === '' || p.fullName.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle))
			.sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1));
	});

	let canSave = $derived(name.trim() !== '');

	function toggle(personId: number, on: boolean) {
		personIds = on ? [...personIds, personId] : personIds.filter((id) => id !== personId);
	}

	const sameIds = (a: number[], b: number[]) => [...a].sort((x, y) => x - y).join(',') === [...b].sort((x, y) => x - y).join(',');

	async function save() {
		if (!canSave || saving) return;
		saving = true;
		try {
			const fields = { name: name.trim(), description: description.trim() };
			let id = groupId;
			if (id === null) {
				const res = await sent(
					() => fetch('/api/people-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) }),
					'The group was not added'
				);
				if (!res) return;
				const answer = await answerBody(res);
				id = typeof answer?.id === 'number' ? answer.id : null;
				if (id === null) {
					await invalidateAll();
					onClose();
					return;
				}
				groupId = id;
				saved = { ...fields, personIds: [] };
			} else if (fields.name !== saved.name || fields.description !== saved.description) {
				const res = await sent(
					() => fetch(`/api/people-groups/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) }),
					'The group was not saved'
				);
				if (!res) return;
				saved = { ...fields, personIds: saved.personIds };
			}
			// Only people still in the page's data: one another administrator deleted is dropped, not sent to be refused.
			const members = personIds.filter((pid) => data.people.some((p) => p.id === pid));
			if (!sameIds(members, saved.personIds)) {
				const res = await sent(
					() =>
						fetch(`/api/people-groups/${id}/members`, {
							method: 'PUT',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ personIds: members })
						}),
					'Who is in the group was not saved'
				);
				if (!res) {
					await invalidateAll();
					return;
				}
			}
			await invalidateAll();
			showToast(start ? 'Group saved' : 'Group added');
			onClose();
		} finally {
			saving = false;
		}
	}
</script>

{#snippet groupActions()}
	<Button variant="outline" onclick={onClose}>Cancel</Button>
	<Button onclick={save} disabled={!canSave} aria-busy={saving ? 'true' : undefined}>{start ? 'Save' : 'Add Group'}</Button>
{/snippet}

<!-- Card 3078: the kit's frame, on the same focus rules. -->
<Dialog
	aria-label={start ? 'Edit Group' : 'Add Group'}
	title={start ? 'Edit Group' : 'Add Group'}
	size="md"
	class="group-dialog"
	footerClass="modal-actions"
	initialFocus="input"
	onEscape={onClose}
	footer={groupActions}
>
	<div class="dialog-fields">
		<label class="dialog-field">
			<span class="ui-label">Name</span>
			<input type="text" class="ui-input" bind:value={name} maxlength="100" />
		</label>
		<label class="dialog-field">
			<span class="ui-label">Description</span>
			<textarea class="ui-textarea" rows="2" bind:value={description} maxlength="1000"></textarea>
		</label>
		<fieldset class="dialog-field">
			<legend class="ui-label">People ({personIds.length} ticked)</legend>
			<input type="search" class="ui-input" placeholder="Search people" aria-label="Search people" bind:value={search} />
			{#if listed.length === 0}
				<p class="ui-hint">{data.people.length === 0 ? 'No people yet.' : 'No one matches.'}</p>
			{:else}
				<div class="tick-list">
					{#each listed as p (p.id)}
						<label class="tick" class:left={p.status === 'left'}>
							<input type="checkbox" checked={personIds.includes(p.id)} onchange={(e) => toggle(p.id, e.currentTarget.checked)} />
							<span>{p.fullName}</span>
							{#if p.status === 'left'}<span class="left-mark">left</span>{/if}
						</label>
					{/each}
				</div>
			{/if}
		</fieldset>
	</div>
</Dialog>

<style>
	/* Card 3076: the fields the kit's (ui-field.css), their names the kit's label. Card 3078: the frame and buttons the kit's dialog. */
	.dialog-fields { display: flex; flex-direction: column; gap: var(--space-md); }
	.dialog-field { display: flex; flex-direction: column; gap: 0.375rem; border: none; padding: 0; margin: 0; }
	.dialog-field legend { margin-bottom: var(--space-xs); padding: 0; }
	.dialog-fields .ui-hint { margin: 0; }
	/* The people to tick: a bordered list that scrolls within itself. */
	.tick-list { display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow-y: auto; padding: var(--space-sm) var(--space-md); border: 1px solid var(--ui-border); border-radius: var(--ui-radius); }
	.tick { display: flex; align-items: center; gap: var(--space-xs); font-size: 0.8125rem; color: var(--ui-foreground); }
	.tick.left { color: var(--ui-muted-foreground); }
	/* Left: said in the text colour, marked by its edge (card 3076, F3). */
	.left-mark { padding: 0 0.375rem; border: 1px solid color-mix(in srgb, var(--ui-warning) 40%, transparent); border-radius: var(--ui-radius-sm); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ui-foreground); }
</style>
