<!--
  RecordEvents.svelte — a list of a decision's record entries (card 2680,
  decision 16), as the record view and an administrator's or decider's
  person record show them: each with its moment, its kind in words, the
  version, the participant it names by their snapshot name, who did it, and
  its detail as the server projected it through `RECORD_DETAIL`, each key in
  words (`DETAIL_WORDS`, code review F8). Nothing is added here: a key the
  server left out is not drawn, and every value is drawn as text, never
  markup.

  An ordered list, oldest first as given. Empty, it says so in `empty`.
-->
<script lang="ts">
	import type { RecordEntry } from '$lib/decision-register-types';
	import { detailWords, eventWords, shownMoment } from '$lib/decision-words';

	let { entries, empty = 'No events.' }: { entries: RecordEntry[]; empty?: string } = $props();

	/** A detail value as text: a primitive as it is, an object as its fields in words, a list as its items. */
	function valueText(value: unknown): string {
		if (value === null || value === undefined) return '—';
		if (typeof value === 'boolean') return value ? 'yes' : 'no';
		if (typeof value === 'string' || typeof value === 'number') return String(value);
		if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map(valueText).join('; ');
		if (typeof value === 'object') {
			const fields = Object.entries(value as Record<string, unknown>);
			return fields.length === 0 ? 'not shown' : fields.map(([key, inner]) => `${detailWords(key)} ${valueText(inner)}`).join(', ');
		}
		return '';
	}

	/** The detail's keys in words (`DETAIL_WORDS`, code review F8: no stored camelCase name is shown) and values, in the order the server gave them. */
	const detailOf = (entry: RecordEntry) => Object.entries(entry.detail).map(([key, value]) => ({ key, words: detailWords(key), text: valueText(value) }));
</script>

{#if entries.length === 0}
	<p class="record-empty">{empty}</p>
{:else}
	<ol class="record-events">
		{#each entries as entry, i (i)}
			{@const details = detailOf(entry)}
			<li class="record-event" data-kind={entry.kind}>
				<p class="event-line">
					<time datetime={entry.at}>{shownMoment(entry.at, '')}</time>
					<span class="event-kind">{eventWords(entry.kind)}</span>
					{#if entry.versionNumber !== null}<span class="event-version">version {entry.versionNumber}</span>{/if}
				</p>
				<p class="event-who">
					{#if entry.participant !== null}<span data-field="participant">Participant: {entry.participant}</span>{/if}
					<span data-field="actor">By {entry.actor.name} ({entry.actor.source})</span>
				</p>
				{#if details.length > 0}
					<dl class="event-detail">
						{#each details as detail (detail.key)}
							<div>
								<dt data-key={detail.key}>{detail.words}:</dt>{' '}<dd>{detail.text}</dd>
							</div>
						{/each}
					</dl>
				{/if}
			</li>
		{/each}
	</ol>
{/if}

<style>
	.record-empty { font-size: 0.9rem; color: var(--text-tertiary); margin: 0; }
	.record-events { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-sm); }
	.record-event { padding: var(--space-sm) var(--space-md); border-radius: var(--radius-sm); background: var(--bg-elevated); overflow-wrap: anywhere; }
	.event-line { margin: 0; display: flex; flex-wrap: wrap; gap: var(--space-sm); align-items: baseline; }
	.event-line time { font-size: 0.8rem; color: var(--text-secondary); }
	.event-kind { font-weight: 600; }
	.event-version { font-size: 0.8rem; color: var(--text-tertiary); }
	.event-who { margin: var(--space-xs) 0 0; display: flex; flex-wrap: wrap; gap: var(--space-md); font-size: 0.85rem; color: var(--text-secondary); }
	.event-detail { margin: var(--space-xs) 0 0; display: grid; gap: 2px; font-size: 0.85rem; }
	.event-detail div { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
	.event-detail dt { font-weight: 600; }
	.event-detail dd { margin: 0; white-space: pre-wrap; }
</style>
