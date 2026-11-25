<!--
  DecisionExport.svelte — a decision as a PDF, in the decision page's actions
  bar (card 2688, R14, decision 29). The signed-in page alone: the personal
  link's page draws none of it.

  Where the decision is out of draft, "Shareable copy (PDF)", which anyone
  who may view the decision may take: what every viewer of it sees. Where the
  caller may also read its record (`mayReadRecord`: the decider with board
  edit while the board exists, and administrators), "Full record (PDF)", with
  its note that it is private and that taking one is written on the record.
  Each carries `data-action`, as the bar's other actions do, so that the pin of
  the signed-in page's actions, and of the link page drawing none, covers them.

  Each posts `{ copy }` as JSON to `/api/decisions/[id]/pdf` and saves the
  answer as a file, under the name the answer's `Content-Disposition` gives
  (only `[a-z0-9.-]`), else `decision-<id>.pdf`. A refusal (403, 404, 409,
  429, and the 503 while another export is being drawn) is said in the
  server's words, in a status region that stays drawn. Once an export ends, the
  pressed button has the focus again (card 2688's code review, E-L5).
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { failureMessage } from '$lib/api';
	import Button from '$lib/components/ui/Button.svelte';

	let {
		decisionId,
		draft,
		mayReadRecord
	}: {
		decisionId: number;
		/** A draft offers neither: nothing has been published to export (R1). */
		draft: boolean;
		/** Whether the full record is offered too. */
		mayReadRecord: boolean;
	} = $props();

	const id = $props.id();

	/** The copy being exported now, or null. One at a time: the server draws one at a time too. */
	let busy = $state<'full' | 'shareable' | null>(null);
	/** What was done, or the last refusal, said in the status region. */
	let said = $state<{ refused: boolean; words: string } | null>(null);

	/** The file name the answer gives, where it is one this page would have made; null otherwise. */
	function filenameOf(res: Response): string | null {
		const found = /filename="([a-z0-9.-]+\.pdf)"/.exec(res.headers.get('content-disposition') ?? '');
		return found === null ? null : found[1];
	}

	/**
	 * Export `copy`. `button`, the one pressed, is disabled while the export
	 * runs, which takes the focus off it; it is given it back once the export
	 * ends (card 2688's code review, E-L5), where the focus was left on nothing,
	 * so that a keyboard is where it was and focus moved elsewhere meanwhile is
	 * left there.
	 */
	async function exportCopy(copy: 'full' | 'shareable', button: HTMLButtonElement) {
		if (busy !== null) return;
		busy = copy;
		said = null;
		const what = copy === 'full' ? 'The full record' : 'The shareable copy';
		try {
			const res = await fetch(`/api/decisions/${decisionId}/pdf`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ copy })
			});
			if (!res.ok) {
				said = { refused: true, words: await failureMessage(res, `${what} was not exported.`) };
				return;
			}
			// Typed as a PDF whatever the answer says it is, and saved, never shown in the page.
			const url = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: 'application/pdf' }));
			const name = filenameOf(res) ?? `decision-${decisionId}.pdf`;
			const link = document.createElement('a');
			link.href = url;
			link.download = name;
			document.body.appendChild(link);
			link.click();
			link.remove();
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
			said = { refused: false, words: `${what} was downloaded as ${name}.` };
		} catch {
			said = {
				refused: true,
				words:
					copy === 'full'
						? 'No answer from the server. Nothing was downloaded, and it is not known whether the export was written on the record.'
						: 'No answer from the server. Nothing was downloaded.'
			};
		} finally {
			busy = null;
			// Enabled again first: a disabled button takes no focus.
			await tick();
			if (document.activeElement === null || document.activeElement === document.body) button.focus();
		}
	}
</script>

{#if !draft}
	<span class="decision-export">
		<Button
			variant="outline"
			size="sm"
			data-action="export-shareable"
			disabled={busy !== null}
			aria-busy={busy === 'shareable' ? 'true' : undefined}
			onclick={(event) => exportCopy('shareable', event.currentTarget as HTMLButtonElement)}>Shareable copy (PDF)</Button
		>
		{#if mayReadRecord}
			<Button
				variant="outline"
				size="sm"
				data-action="export-full"
				aria-describedby="{id}-private"
				disabled={busy !== null}
				aria-busy={busy === 'full' ? 'true' : undefined}
				onclick={(event) => exportCopy('full', event.currentTarget as HTMLButtonElement)}>Full record (PDF)</Button
			>
			<span class="private-note" id="{id}-private" data-note="export-full">Private: holds names and views. Taking one is written on the record.</span>
		{/if}
		<!-- Drawn from the start, so a screen reader hears each change of its words. -->
		<span class="said" class:refused={said?.refused} role="status" data-said="export">{said?.words ?? ''}</span>
	</span>
{/if}

<style>
	/* Its parts sit in the actions column beside the page's other actions (card 3075). */
	.decision-export { display: contents; }
	.private-note { font-size: 0.8125rem; line-height: 1.4; color: var(--ui-muted-foreground); }
	.said { font-size: 0.8125rem; line-height: 1.4; color: var(--ui-muted-foreground); }
	/* A refusal: the words in the text colour, which reads in every theme, marked by the destructive tone. */
	.said.refused { padding-left: 0.625rem; border-left: 3px solid var(--ui-destructive); color: var(--ui-foreground); }
</style>
