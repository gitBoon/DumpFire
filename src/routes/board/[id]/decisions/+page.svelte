<script lang="ts">
	/**
	 * A board's decisions (card 2676, decisions 13 and 14, plan 4.2), newest
	 * first: each title links to its editor where the caller may edit it, and
	 * is plain text otherwise. New decision, for those who can edit the board,
	 * asks for a title, makes the draft and goes to its editor.
	 */
	import type { PageData } from './$types';
	import { goto } from '$app/navigation';
	import HeaderMenu from '$lib/components/HeaderMenu.svelte';
	import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import { failureMessage } from '$lib/api';
	import { STATUS_WORDS, shownMoment } from '$lib/decision-words';
	import { theme, themeIcon } from '$lib/stores/theme';

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
</script>

<svelte:window onkeydown={keydown} />

<svelte:head>
	<title>Decisions on {data.board.name} — DumpFire</title>
</svelte:head>

<div class="decisions-page">
	<header class="decisions-header glass">
		<div class="decisions-header-inner">
			<a href="/" class="header-logo" title="Back to DumpFire">
				<span class="logo-fire">🔥</span>
				<span class="logo-text">DumpFire</span>
			</a>
			<nav class="crumb" aria-label="Where this is">
				<a href="/board/{data.board.id}">{data.board.name}</a>
			</nav>
			<HeaderMenu label="Theme" triggerClass="btn-ghost" triggerTitle="Change theme">
				{#snippet trigger()}<span aria-hidden="true">{themeIcon($theme)}</span>{/snippet}
				<ThemeMenuItems heading={false} />
			</HeaderMenu>
		</div>
	</header>

	<main class="decisions-content">
		<section class="decisions-card glass">
			<div class="section-header">
				<h1>Decisions on {data.board.name}</h1>
				{#if data.canCreate}
					<button type="button" class="btn-primary btn-sm" onclick={openNew}>New decision</button>
				{/if}
			</div>

			{#if data.decisions.length === 0}
				<p class="empty-msg">No decisions on this board yet.</p>
			{:else}
				<div class="table-wrap">
					<table class="decisions-table">
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
									<td class="title">
										{#if decision.mayEdit}
											<a href="/decisions/{decision.id}/edit">{decision.title}</a>
										{:else}
											<span>{decision.title}</span>
										{/if}
									</td>
									<td><span class="status-chip" data-status={decision.shownStatus}>{STATUS_WORDS[decision.shownStatus] ?? decision.shownStatus}</span></td>
									<td>{decision.deciderName ?? '—'}</td>
									<td>{shownMoment(decision.closesAt, '—')}</td>
									<td>{shownMoment(decision.updatedAt, '—')}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	</main>
</div>

{#if creating}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-overlay" role="presentation" onclick={() => (creating = false)}>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="new-dialog glass" role="dialog" aria-modal="true" aria-label="New decision" tabindex="-1" onclick={(e) => e.stopPropagation()}>
			<h2>New decision</h2>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					createDraft();
				}}
			>
				<label for="new-decision-title">Title</label>
				<!-- svelte-ignore a11y_autofocus -->
				<input id="new-decision-title" class="form-input" maxlength="200" autofocus bind:value={newTitle} />
				{#if error}<p class="dialog-error" role="alert">{error}</p>{/if}
				<div class="dialog-actions">
					<button type="button" class="btn-ghost btn-sm" onclick={() => (creating = false)}>Cancel</button>
					<button type="submit" class="btn-primary btn-sm" aria-busy={sending ? 'true' : undefined}>Make draft</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<Toast />

<style>
	.decisions-page { min-height: 100vh; padding-top: 64px; }
	.decisions-header {
		position: fixed; top: 0; left: 0; right: 0; z-index: 200;
		height: 64px; border-bottom: 1px solid var(--glass-border);
		backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
	}
	.decisions-header-inner {
		max-width: 1400px; margin: 0 auto; height: 100%;
		display: flex; align-items: center; gap: var(--space-lg);
		padding: 0 var(--space-xl);
	}
	.header-logo {
		display: flex; align-items: center; gap: var(--space-sm);
		text-decoration: none; color: var(--text-primary);
		font-weight: 700; font-size: 1.1rem;
	}
	.logo-fire { font-size: 1.4rem; }
	.crumb { flex: 1; font-size: 0.85rem; min-width: 0; }
	.crumb a { color: var(--text-secondary); text-decoration: none; }
	.crumb a:hover { color: var(--accent-indigo); }

	/* The page's last line stops above the user badge (card 2239). */
	.decisions-content { max-width: 1100px; margin: 0 auto; padding: var(--space-2xl) var(--space-2xl) var(--user-badge-space); }
	@media (max-width: 640px) {
		.decisions-header-inner { padding: 0 var(--space-md); }
		.logo-text { display: none; }
		.decisions-content { padding: var(--space-md) var(--space-md) var(--user-badge-space); }
	}
	.decisions-card { padding: var(--space-xl); border-radius: var(--radius-lg); }
	.section-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-md); margin-bottom: var(--space-lg); }
	.section-header h1 { font-size: 1.05rem; margin: 0; }
	.empty-msg { font-size: 0.85rem; color: var(--text-tertiary); text-align: center; padding: var(--space-xl); }

	.table-wrap { overflow-x: auto; }
	.decisions-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
	.decisions-table th {
		text-align: left; font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
		color: var(--text-tertiary); padding: var(--space-xs) var(--space-sm); border-bottom: 1px solid var(--glass-border);
	}
	.decisions-table td { padding: var(--space-sm); border-bottom: 1px solid var(--glass-border); vertical-align: middle; }
	.decisions-table td.title { font-weight: 600; }
	.decisions-table td.title a { color: var(--accent-indigo); text-decoration: none; }
	.status-chip {
		display: inline-block; padding: 1px var(--space-sm); border-radius: 999px;
		font-size: 0.7rem; background: rgba(99, 102, 241, 0.12); color: var(--accent-indigo);
	}

	.modal-overlay { position: fixed; inset: 0; z-index: 300; background: rgba(0, 0, 0, 0.4); display: flex; align-items: center; justify-content: center; padding: var(--space-md); }
	.new-dialog { width: 100%; max-width: 420px; padding: var(--space-xl); border-radius: var(--radius-lg); background: var(--bg-surface); }
	.new-dialog h2 { font-size: 1rem; margin: 0 0 var(--space-md); }
	.new-dialog form { display: flex; flex-direction: column; gap: var(--space-sm); }
	.new-dialog label { font-size: 0.75rem; color: var(--text-secondary); }
	.form-input {
		padding: var(--space-sm) var(--space-md);
		border: 1px solid var(--glass-border); border-radius: var(--radius-sm);
		background: var(--bg-elevated); color: var(--text-primary);
		font-size: 0.82rem; font-family: var(--font-family);
	}
	.dialog-error { font-size: 0.78rem; color: var(--accent-rose); margin: 0; }
	.dialog-actions { display: flex; justify-content: flex-end; gap: var(--space-sm); }
	.decisions-page :global(.btn-sm), .new-dialog .btn-sm { font-size: 0.78rem !important; padding: var(--space-xs) var(--space-md) !important; }
</style>
