<script lang="ts">
	/**
	 * A board's decisions (card 2676, decisions 13 and 14, plan 4.2), newest
	 * first: each opened decision's title links to its page (card 2677, F4),
	 * with Edit beside it where the caller may edit it; a draft's title links
	 * to its editor where the caller may edit it, and is plain text otherwise.
	 * New decision, for those who can edit the board,
	 * asks for a title, makes the draft and goes to its editor.
	 *
	 * Card 2680 (decisions 26 and 28): All decisions goes to the register,
	 * filtered to this board; and the list re-reads on a `decision` event of
	 * this board alone, through the one 250 ms debounce.
	 *
	 * Card 3075: a list page on the kit's shell, full width (not the board
	 * view, which never uses the kit); New decision is the page's one main
	 * action, with the kit's short sheen.
	 */
	import type { PageData } from './$types';
	import { goto, invalidateAll } from '$app/navigation';
	import { connectLiveRefresh } from '$lib/live-refresh';
	import Toast from '$lib/components/Toast.svelte';
	import PageShell from '$lib/components/ui/PageShell.svelte';
	import PageHeader from '$lib/components/ui/PageHeader.svelte';
	import Table from '$lib/components/ui/Table.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import { failureMessage } from '$lib/api';
	import { shownMoment } from '$lib/decision-words';

	let { data }: { data: PageData } = $props();

	/** The New decision dialog: open, what is typed, and what the server said. */
	let creating = $state(false);
	let newTitle = $state('');
	let error = $state('');
	let sending = $state(false);

	function openNew() {
		newTitle = '';
		error = '';
		creating = true;
	}

	async function createDraft() {
		if (sending) return;
		if (newTitle.trim() === '') {
			error = 'A decision needs a title.';
			return;
		}
		sending = true;
		error = '';
		try {
			const res = await fetch(`/api/boards/${data.board.id}/decisions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: newTitle })
			});
			if (res.ok) {
				const answer = (await res.json()) as { decision: { id: number } };
				creating = false;
				await goto(`/decisions/${answer.decision.id}/edit`);
			} else {
				error = await failureMessage(res, 'The decision was not made.');
			}
		} catch {
			error = 'No answer from the server. It is not known whether the decision was made.';
		} finally {
			sending = false;
		}
	}

	function keydown(e: KeyboardEvent) {
		if (creating && e.key === 'Escape') creating = false;
	}

	// Listened again only when the page is read for another board: a re-read of this one gives the same id.
	const listenedBoard = $derived(data.board.id);
	$effect(() => connectLiveRefresh(() => invalidateAll(), undefined, { events: ['decision'], boardId: listenedBoard }));
</script>

<svelte:window onkeydown={keydown} />

<svelte:head>
	<title>Decisions on {data.board.name} — DumpFire</title>
</svelte:head>

{#snippet crumbs()}
	<nav class="crumb" aria-label="Where this is">
		<a href="/board/{data.board.id}">{data.board.name}</a>
	</nav>
{/snippet}

{#snippet headerActions()}
	<Button variant="outline" size="sm" href="/decisions?board={data.board.id}" data-action="all">All decisions</Button>
	{#if data.canCreate}
		<Button size="sm" highlight onclick={openNew}>New decision</Button>
	{/if}
{/snippet}

<PageShell width="full" {crumbs}>
	<PageHeader title="Decisions on {data.board.name}" actions={headerActions} />

	{#if data.decisions.length === 0}
		<EmptyState title="No decisions on this board yet." />
	{:else}
		<Table caption="Decisions on {data.board.name}" captionHidden stack>
			<thead>
				<tr>
					<th>Title</th>
					<th>Status</th>
					<th>Decider</th>
					<th>Closes</th>
					<th>Updated</th>
				</tr>
			</thead>
			<tbody>
				{#each data.decisions as decision (decision.id)}
					<tr data-decision={decision.id}>
						<td class="title" data-label="Title">
							{#if decision.status !== 'draft'}
								<a class="row-link" href="/decisions/{decision.id}">{decision.title}</a>
								{#if decision.mayEdit}<Button variant="link" size="sm" class="edit-link" href="/decisions/{decision.id}/edit">Edit</Button>{/if}
							{:else if decision.mayEdit}
								<a class="row-link" href="/decisions/{decision.id}/edit">{decision.title}</a>
							{:else}
								<span>{decision.title}</span>
							{/if}
						</td>
						<td data-label="Status"><Badge status={decision.shownStatus} /></td>
						<td data-label="Decider">{decision.deciderName ?? '—'}</td>
						<td data-label="Closes" class="when">{shownMoment(decision.closesAt, '—')}</td>
						<td data-label="Updated" class="when">{shownMoment(decision.updatedAt, '—')}</td>
					</tr>
				{/each}
			</tbody>
		</Table>
	{/if}
</PageShell>

{#if creating}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-overlay" role="presentation" onclick={() => (creating = false)}>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="new-dialog" role="dialog" aria-modal="true" aria-label="New decision" tabindex="-1" onclick={(e) => e.stopPropagation()}>
			<h2>New decision</h2>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					createDraft();
				}}
			>
				<label class="ui-label" for="new-decision-title">Title</label>
				<!-- svelte-ignore a11y_autofocus -->
				<input id="new-decision-title" class="ui-input" maxlength="200" autofocus bind:value={newTitle} />
				{#if error}<p class="dialog-error" role="alert">{error}</p>{/if}
				<div class="dialog-actions">
					<Button variant="ghost" size="sm" onclick={() => (creating = false)}>Cancel</Button>
					<Button type="submit" size="sm" aria-busy={sending ? 'true' : undefined}>Make draft</Button>
				</div>
			</form>
		</div>
	</div>
{/if}

<Toast />

<style>
	.crumb {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.crumb a {
		border-radius: var(--ui-radius-sm);
		color: var(--ui-muted-foreground);
		text-decoration: none;
	}
	.crumb a:hover {
		color: var(--ui-foreground);
	}
	.crumb a:focus-visible,
	.row-link:focus-visible {
		outline: 2px solid var(--ui-ring);
		outline-offset: 2px;
	}

	.title {
		font-weight: 500;
	}
	.row-link {
		border-radius: var(--ui-radius-sm);
		color: var(--ui-foreground);
		text-decoration: none;
		text-underline-offset: 3px;
	}
	.row-link:hover {
		color: var(--ui-foreground);
		text-decoration: underline;
	}
	.when {
		white-space: nowrap;
		color: var(--ui-muted-foreground);
	}

	/* The New decision dialog, over the page. */
	.modal-overlay {
		position: fixed;
		inset: 0;
		z-index: 300;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-md);
		background: color-mix(in srgb, var(--ui-background) 75%, transparent);
	}
	.new-dialog {
		width: 100%;
		max-width: 28rem;
		padding: 1.5rem;
		border: 1px solid var(--ui-border);
		border-radius: var(--ui-radius-lg);
		background: var(--ui-card);
		color: var(--ui-foreground);
		box-shadow: var(--ui-shadow);
	}
	.new-dialog h2 {
		margin: 0 0 var(--space-md);
		font-size: 1.125rem;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.new-dialog form {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}
	.dialog-error {
		margin: 0;
		padding-left: 0.625rem;
		border-left: 3px solid var(--ui-destructive);
		font-size: 0.8125rem;
		color: var(--ui-foreground);
	}
	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-sm);
		margin-top: var(--space-sm);
	}

	@media (pointer: coarse) {
		.row-link {
			display: inline-flex;
			align-items: center;
			min-height: 2.75rem;
		}
	}
</style>
