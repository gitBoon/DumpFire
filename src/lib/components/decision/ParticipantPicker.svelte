<!--
  ParticipantPicker.svelte — who is consulted on a decision and who is told
  of it, in the editor's side column (card 2676, decisions 15 and 29, R3, R4,
  R6, D6).

  It is handed the picker's data as the server shaped it: active people by
  name, job title and groups, and an address only to an administrator; the
  groups with their active members. A search covers name, job title and group
  name (and the address where one is given). Ticking a group ticks its active
  members as Consulted, unticking it unticks them, and a group with some of
  them ticked shows mixed. A group with no active members cannot be ticked.

  The decision's own participants who have left are flagged, "has left:
  remove before saving", and stay ticked until the editor unticks them: Save
  sends them, and the server refuses it naming them. One no longer in the
  people directory cannot be named by any body, and is flagged that saving
  takes them off. Nothing is dropped without the editor's tick.

  Save sends `{ participants, revision }`. On an opened decision it asks
  first, saying how many are mailed, how many consulted are added or made
  consulted without being asked while it is not shown open (card 2743), who
  may be asked when it is reopened (card 2744), and how many taken off:
  counted by `mailedOnSave` (`$lib/decision-rules.ts`), the server's own rule,
  and advice only, as the server's skips and holds are not seen here. A refusal is said
  in the server's words and the ticks are kept; the stale-revision 409
  (`STALE_REVISION`) alone offers to reload (C6). A caller who may not save is
  handed no people and no group members (C4).
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { failureMessage } from '$lib/api';
	import { mailedOnSave, openForInput } from '$lib/decision-rules';
	import { STALE_REVISION } from '$lib/decision-words';

	type Role = 'consulted' | 'informed';
	type Participant = {
		id: number;
		personId: number | null;
		role: string;
		name: string;
		jobTitle: string;
		removedAt: string | null;
		hasLeft: boolean;
		notInDirectory: boolean;
	};
	type Person = { id: number; fullName: string; jobTitle: string; groupIds: number[]; email?: string };
	/** A group by name; its active members are handed over only where the caller may save (C4). */
	type Group = { id: number; name: string; activeMemberIds?: number[] };

	let {
		decisionId,
		status,
		shownStatus,
		editable = false,
		participants,
		people,
		groups,
		revision,
		canSave,
		onSaved,
		onReload
	}: {
		decisionId: number;
		status: string;
		/** The status the decision is shown with, `open` or `awaiting_ruling` past its closing time (card 2743); `status` where not given. */
		shownStatus?: string;
		/** The decision's status lets it be edited: on an open one that the caller may not include people in, the picker says who may. */
		editable?: boolean;
		/** Every participant row, removed ones included, through the server's projection. */
		participants: Participant[];
		/** Active people only; empty unless the caller may save. */
		people: Person[];
		groups: Group[];
		/** The decision's revision as the page holds it: every save sends it. */
		revision: string;
		/** The caller may save the participants now (`edit`, and `include` once opened). */
		canSave: boolean;
		/** A save was taken: the decision's revision after it. */
		onSaved: (revision: string) => void | Promise<void>;
		/** Read the decision again, as it is now. */
		onReload: () => void | Promise<void>;
	} = $props();

	const uid = $props.id();
	const searchId = `picker-search-${uid}`;

	/** The rows still on the decision. */
	const live = (rows: Participant[]) => rows.filter((row) => row.removedAt === null);

	/** Who is ticked, by person, with their role: each live row a body can name. */
	function ticksOf(rows: Participant[]): Record<number, Role> {
		const ticks: Record<number, Role> = {};
		for (const row of live(rows)) {
			if (row.personId === null || row.notInDirectory) continue;
			ticks[row.personId] = row.role === 'informed' ? 'informed' : 'consulted';
		}
		return ticks;
	}

	/** The rows as last saved: the page's, then each save's answer. */
	let rows = $state(untrack(() => participants));
	let ticked = $state(untrack(() => ticksOf(participants)));
	let search = $state('');
	let error = $state('');
	/** The last refusal was the stale-revision 409: the decision changed, and Reload is offered. */
	let stale = $state(false);
	let saving = $state(false);
	/** The confirmation of a save on an opened decision. */
	let confirming = $state<string | null>(null);

	let groupName = $derived(new Map(groups.map((group) => [group.id, group.name])));

	/** The decision's own participants who have left, or are no longer in the directory (decision 29). */
	let flagged = $derived(live(rows).filter((row) => row.hasLeft || row.notInDirectory));

	/** The people the search leaves: over name, job title, group names, and the address where the server gave one. */
	let listed = $derived.by(() => {
		const needle = search.trim().toLowerCase();
		if (needle === '') return people;
		return people.filter((person) =>
			[person.fullName, person.jobTitle, ...person.groupIds.map((id) => groupName.get(id) ?? ''), ...(person.email ? [person.email] : [])].some((text) =>
				text.toLowerCase().includes(needle)
			)
		);
	});

	let consulted = $derived(Object.values(ticked).filter((role) => role === 'consulted').length);
	let informed = $derived(Object.values(ticked).filter((role) => role === 'informed').length);

	/** A group's active members, as the server handed them. */
	const membersOf = (group: Group) => group.activeMemberIds ?? [];

	/** A group's tick: every active member ticked, some, or none. */
	function groupTick(group: Group): 'true' | 'mixed' | 'false' {
		const on = membersOf(group).filter((id) => id in ticked).length;
		if (on === 0) return 'false';
		return on === membersOf(group).length ? 'true' : 'mixed';
	}

	function toggleGroup(group: Group) {
		if (!canSave || membersOf(group).length === 0) return;
		if (groupTick(group) === 'true') {
			for (const id of membersOf(group)) delete ticked[id];
		} else {
			for (const id of membersOf(group)) if (!(id in ticked)) ticked[id] = 'consulted';
		}
	}

	function togglePerson(personId: number) {
		if (!canSave) return;
		if (personId in ticked) delete ticked[personId];
		else ticked[personId] = 'consulted';
	}

	function toggleRole(personId: number) {
		if (!canSave || !(personId in ticked)) return;
		ticked[personId] = ticked[personId] === 'consulted' ? 'informed' : 'consulted';
	}

	const roleWord = (role: string) => (role === 'informed' ? 'Informed' : 'Consulted');

	/**
	 * On an opened decision: how many the save mails, how many consulted it adds or makes consulted without asking (asked at
	 * the reopening, card 2744), and how many it takes off
	 * (decision 29 counts those no longer in the directory). Who is mailed is `mailedOnSave`, the rule `setParticipants`
	 * decides the save by (cards 2740 and 2743), read at the shown status. The count is advice: the server may still skip
	 * one `reachOf` cannot reach or hold back an ask a rest or a cap holds, which the picker cannot see, and decides at the
	 * save, not at the page's load. `unasked` is advice too: the reopening asks only whom the round has not reached, read
	 * from the record, which the picker cannot see either.
	 */
	function changesOnOpen(): { mailed: number; unasked: number; takenOff: number } {
		const on = live(rows);
		const shown = shownStatus ?? status;
		const byPerson = new Map(on.filter((row) => row.personId !== null && !row.notInDirectory).map((row) => [row.personId!, row]));
		let mailed = 0;
		let unasked = 0;
		for (const [id, role] of Object.entries(ticked)) {
			const held = byPerson.get(Number(id));
			if (held === undefined) {
				if (mailedOnSave('included', role, shown)) mailed += 1;
				else unasked += 1;
			} else if (held.role !== role) {
				if (mailedOnSave('role_changed', role, shown)) mailed += 1;
				// Card 2744 (F3): one made consulted while it is not open is asked at the reopening, as one added is.
				else if (role === 'consulted' && !openForInput(shown)) unasked += 1;
			}
		}
		const takenOff = on.filter((row) => row.notInDirectory || (row.personId !== null && !(row.personId in ticked))).length;
		return { mailed, unasked, takenOff };
	}

	function askSave() {
		if (!canSave || saving) return;
		if (status === 'draft') {
			void save();
			return;
		}
		const { mailed, unasked, takenOff } = changesOnOpen();
		// Card 2744 (D7): the Extend or the re-publish asking again that reopens it sends them the invitation, as the caps allow.
		// "May be" (code review 2026-11-05): the count is advice. One the round already reached, then made informed and made
		// consulted again while it was closed, is counted here, but the server, reading the record, does not ask them again.
		const waiting = unasked > 0 ? ` ${unasked} consulted may be asked for their view when the decision is reopened;` : '';
		confirming = `${mailed} ${mailed === 1 ? 'person' : 'people'} will be mailed now;${waiting} ${takenOff} will be marked removed.`;
	}

	async function save() {
		if (saving) return;
		saving = true;
		error = '';
		stale = false;
		const body = {
			participants: Object.entries(ticked).map(([personId, role]) => ({ personId: Number(personId), role })),
			revision
		};
		try {
			const res = await fetch(`/api/decisions/${decisionId}/participants`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (res.ok) {
				const answer = (await res.json()) as { participants: Participant[]; revision: string };
				rows = answer.participants;
				ticked = ticksOf(answer.participants);
				await onSaved(answer.revision);
			} else {
				error = await failureMessage(res, 'The participants were not saved.');
				// Reload throws the ticks away: offered only on the stale-revision words (C6).
				stale = res.status === 409 && error === STALE_REVISION;
			}
		} catch {
			error = 'No answer from the server. It is not known whether the participants were saved.';
		} finally {
			saving = false;
		}
	}
</script>

<section class="picker" aria-label="Participants">
	<h3>Participants</h3>

	{#if flagged.length > 0}
		<ul class="flagged">
			{#each flagged as row (row.id)}
				<li class="flagged-row">
					{#if row.notInDirectory}
						<span class="person-name">{row.name}</span>
						<span class="flag">no longer in the people directory: saving takes them off</span>
					{:else}
						<label class="tick">
							<input
								type="checkbox"
								checked={row.personId !== null && row.personId in ticked}
								disabled={!canSave}
								onchange={() => row.personId !== null && togglePerson(row.personId)}
							/>
							<span class="person-name">{row.name}</span>
						</label>
						<span class="flag">has left: remove before saving</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if canSave}
		<input id={searchId} type="search" class="picker-search" placeholder="Search name, job title or group" aria-label="Search people" bind:value={search} />

		{#if groups.length > 0}
			<p class="picker-sub">Groups</p>
			<ul class="group-ticks">
				{#each groups as group (group.id)}
					<li>
						{#if membersOf(group).length === 0}
							<button type="button" class="group-tick" role="checkbox" aria-checked="false" aria-disabled="true" disabled>{group.name}</button>
							<span class="note">no active members</span>
						{:else}
							<button type="button" class="group-tick" role="checkbox" aria-checked={groupTick(group)} onclick={() => toggleGroup(group)}>{group.name}</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		<p class="picker-sub">People</p>
		{#if listed.length === 0}
			<p class="note">{people.length === 0 ? 'No one is in the people directory.' : 'No one matches.'}</p>
		{:else}
			<ul class="people-ticks">
				{#each listed as person (person.id)}
					<li class="person-row" data-person={person.id}>
						<label class="tick">
							<input type="checkbox" checked={person.id in ticked} onchange={() => togglePerson(person.id)} />
							<span class="person-name">{person.fullName}</span>
						</label>
						{#if person.id in ticked}
							<button type="button" class="role-toggle" aria-label="Role of {person.fullName}: {roleWord(ticked[person.id])}" onclick={() => toggleRole(person.id)}>
								{roleWord(ticked[person.id])}
							</button>
						{/if}
						{#if person.jobTitle}<span class="job">{person.jobTitle}</span>{/if}
						{#each person.groupIds as id (id)}
							<span class="chip">{groupName.get(id)}</span>
						{/each}
					</li>
				{/each}
			</ul>
		{/if}

		<p class="summary">{consulted} consulted, {informed} informed</p>
		{#if error}
			<p class="picker-error" role="alert">
				{error}
				{#if stale}<button type="button" class="btn-ghost btn-xs" onclick={() => onReload()}>Reload</button>{/if}
			</p>
		{/if}
		<button type="button" class="btn-primary btn-sm" aria-busy={saving ? 'true' : undefined} onclick={askSave}>Save participants</button>
	{:else}
		{#if status !== 'draft' && editable}
			<p class="note">Once a decision is open, only its author and its decider can include people.</p>
		{/if}
		{@const shown = live(rows).filter((row) => !row.hasLeft && !row.notInDirectory)}
		{#if shown.length === 0}
			<p class="note">No participants.</p>
		{:else}
			<ul class="people-ticks">
				{#each shown as row (row.id)}
					<li class="person-row">
						<span class="person-name">{row.name}</span>
						<span class="role">{roleWord(row.role)}</span>
						{#if row.jobTitle}<span class="job">{row.jobTitle}</span>{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</section>

{#if confirming}
	<ConfirmModal
		title="Save participants"
		message={confirming}
		confirmText="Save"
		confirmDanger={false}
		onConfirm={async () => {
			confirming = null;
			await save();
		}}
		onCancel={() => (confirming = null)}
	/>
{/if}

<style>
	.picker h3 { font-size: 0.9rem; margin: 0 0 var(--space-sm); }
	.picker-sub { font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); margin: var(--space-sm) 0 var(--space-xs); }
	.picker-search {
		width: 100%; box-sizing: border-box; padding: var(--space-xs) var(--space-sm);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-elevated); color: var(--text-primary); font-size: 0.8rem; font-family: var(--font-family);
	}
	ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
	.people-ticks { max-height: 320px; overflow-y: auto; }
	.person-row, .flagged-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); font-size: 0.8rem; padding: 2px 0; }
	.tick { display: inline-flex; align-items: center; gap: var(--space-xs); cursor: pointer; }
	.person-name { font-weight: 600; }
	.job, .note, .role { font-size: 0.72rem; color: var(--text-tertiary); }
	.flag { font-size: 0.72rem; color: var(--accent-rose); }
	.chip {
		display: inline-block; padding: 0 var(--space-sm); border-radius: 999px;
		font-size: 0.68rem; background: rgba(99, 102, 241, 0.12); color: var(--accent-indigo);
	}
	.group-tick, .role-toggle {
		font-size: 0.75rem; font-family: var(--font-family); padding: 1px var(--space-sm);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-base); color: var(--text-secondary); cursor: pointer;
	}
	.group-tick[aria-checked='true'] { background: var(--accent-indigo); border-color: var(--accent-indigo); color: white; }
	.group-tick[aria-checked='mixed'] { border-color: var(--accent-indigo); color: var(--accent-indigo); }
	.group-tick:disabled { opacity: 0.5; cursor: default; }
	.summary { font-size: 0.78rem; color: var(--text-secondary); margin: var(--space-sm) 0; }
	.picker-error { font-size: 0.78rem; color: var(--accent-rose); margin: var(--space-xs) 0; }
</style>
