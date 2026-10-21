<!--
  PlanHeader.svelte — The plan page's header: the back link to every
  milestone, the goal's name (double-click to rename), its status chip, the
  target date (a date until you go to change it, late while work remains),
  PDF, Close or Reopen, and Add cards (card 2281, slice C3a-3: moved from
  src/routes/plan/[id]/+page.svelte).

  Each change goes through the page's one PATCH path (`mutate`), which says
  a refusal and reads the plan again; `busy` is the page's while one is
  out. Whether the card picker is open is the page's (`picking`, bound
  here), which Add cards opens and closes. The late tag moves on at
  midnight on the header's own 15-second tick, as it did on the page.
-->
<script lang="ts">
	import type { PageData } from '../../../routes/plan/[id]/$types';
	import { daysUntilDue, formatDueDate } from '$lib/utils/date-utils';
	import { onDestroy, onMount } from 'svelte';

	let {
		summary,
		milestone,
		busy,
		mutate,
		picking = $bindable()
	}: {
		/** The page's: the plan, as its load gave it. */
		summary: PageData['summary'];
		/** The page's: the goal itself. */
		milestone: PageData['summary']['milestone'];
		/** The page's: true while a change to the goal is being saved. */
		busy: boolean;
		/** The page's one PATCH path for every change to the goal: true once it is saved. */
		mutate: (body: Record<string, unknown>) => Promise<boolean>;
		/** The page's: whether the card picker is open. */
		picking: boolean;
	} = $props();

	let editingName = $state(false);
	let nameDraft = $state('');
	let editingTarget = $state(false);

	/**
	 * Overdue only counts while work remains. A goal finished after its target
	 * date is done, not late, and flagging it red would be nagging about
	 * something nobody can act on.
	 */
	/**
	 * Everything in the goal is done, but it has not been closed.
	 *
	 * Closing stays a deliberate act — all the cards you thought of being done is
	 * not the same as the goal being delivered, and cards can still be added — so
	 * nothing auto-closes. But "Open" next to 23/23 reads as a bug, so the chip
	 * says what the state actually is and the Close button steps forward.
	 */
	const readyToClose = $derived(
		milestone.status === 'open' &&
			summary.progress.total > 0 &&
			summary.progress.done === summary.progress.total
	);

	// The viewer's today moves on at midnight: the late tag is worked out again
	// on the board pages' tick, or a goal left open overnight kept yesterday's
	// answer.
	let tick = $state(0);
	let tickInterval: ReturnType<typeof setInterval> | null = null;
	onMount(() => {
		tickInterval = setInterval(() => { tick++; }, 15000);
	});
	onDestroy(() => {
		if (tickInterval) clearInterval(tickInterval);
	});

	const targetOverdue = $derived.by(() => {
		void tick;
		if (!milestone.targetDate) return false;
		if (summary.progress.total > 0 && summary.progress.done === summary.progress.total) return false;
		// A calendar day, late from the day after it in the viewer's own zone (card 2259).
		return (daysUntilDue(milestone.targetDate) ?? 0) < 0;
	});

	/**
	 * Whether this box's rename is out, and the name it last sent: Enter and
	 * then a click away sent the rename twice, and the blur after a refusal
	 * sent the refused name again (card 2363). Both are cleared as the box opens.
	 */
	let savingName = false;
	let lastSentName: string | null = null;

	function startRename() {
		nameDraft = milestone.name;
		lastSentName = null;
		editingName = true;
	}

	/**
	 * A rename refused or not answered keeps the box open with what was typed,
	 * to try again or Escape (card 2351). None is sent while one is out, and a
	 * blur sends nothing for the name just sent; Enter sends it again. Nor
	 * once the box is closed: a browser that blurs the box as it is taken
	 * away, after Escape, would otherwise send what Escape threw away. A name
	 * typed while one is out is kept: once the one sent is saved, the box
	 * stays open with what is there now, for Enter to send (card 2363's
	 * review: the box closed and it was lost). It is not sent by itself.
	 */
	async function saveName(fromBlur = false) {
		if (savingName || !editingName) return;
		const name = nameDraft.trim();
		if (!name || name === milestone.name) {
			editingName = false;
			return;
		}
		if (fromBlur && name === lastSentName) return;
		savingName = true;
		lastSentName = name;
		try {
			if ((await mutate({ name })) && nameDraft.trim() === name) editingName = false;
		} finally {
			savingName = false;
		}
	}

	async function toggleStatus() {
		await mutate({ status: milestone.status === 'open' ? 'closed' : 'open' });
	}

	async function setTargetDate(value: string) {
		await mutate({ targetDate: value || null });
	}
</script>

<header class="plan-header">
	<div class="plan-header-left">
		<a href="/plan" class="back-btn" title="All milestones" aria-label="All milestones">
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
				<path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</a>
		<span class="plan-title-icon">🎯</span>
		{#if editingName}
			<!-- svelte-ignore a11y_autofocus -->
			<input
				class="name-input"
				bind:value={nameDraft}
				onblur={() => saveName(true)}
				onkeydown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') editingName = false; }}
				autofocus
			/>
		{:else}
			<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
			<h1 ondblclick={startRename} title="Double-click to rename">
				{milestone.name}
			</h1>
		{/if}
		<span
			class="status-chip"
			class:open={milestone.status === 'open' && !readyToClose}
			class:ready={readyToClose}
			class:closed={milestone.status !== 'open'}
			title={readyToClose ? 'Every card in this goal is complete — close it when you are satisfied it is delivered' : ''}
		>
			{#if readyToClose}Ready to close{:else if milestone.status === 'open'}Open{:else}Closed{/if}
		</span>
	</div>

	<div class="plan-header-right">
		<!--
			The target date reads as a date until you go to change it. A permanent
			empty dd/mm/yyyy input took more room than the milestone name and said
			nothing; this says what the date IS, which is the question being asked.
		-->
		{#if editingTarget}
			<!-- svelte-ignore a11y_autofocus -->
			<input
				class="target-input"
				type="date"
				value={milestone.targetDate ?? ''}
				autofocus
				onchange={(e) => { setTargetDate((e.target as HTMLInputElement).value); editingTarget = false; }}
				onblur={() => (editingTarget = false)}
				onkeydown={(e) => { if (e.key === 'Escape') editingTarget = false; }}
			/>
		{:else}
			<button
				class="target-btn"
				class:is-set={!!milestone.targetDate}
				class:overdue={targetOverdue}
				onclick={() => (editingTarget = true)}
				title={milestone.targetDate ? 'Change the target date' : 'Set a target date'}
			>
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
					<rect x="2" y="3" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.3"/>
					<path d="M2 6.5h12M5.5 2v2.5M10.5 2v2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
				</svg>
				{#if milestone.targetDate}
					{formatDueDate(milestone.targetDate)}
					{#if targetOverdue}<span class="overdue-tag">overdue</span>{/if}
				{:else}
					Set target
				{/if}
			</button>
		{/if}

		<a
			class="hdr-btn"
			href="/api/milestones/{milestone.id}/pdf"
			title="Download this plan as a PDF, in the same style as the board reports"
		>
			<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
				<path d="M8 2v8m0 0L5 7m3 3l3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
				<path d="M2.5 11.5v1a1 1 0 001 1h9a1 1 0 001-1v-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
			</svg>
			PDF
		</a>

		<button class="hdr-btn" class:ready={readyToClose} onclick={toggleStatus} disabled={busy}>
			{milestone.status === 'open' ? 'Close' : 'Reopen'}
		</button>

		<button class="hdr-btn primary" class:is-on={picking} onclick={() => (picking = !picking)}>
			<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
				<path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
			</svg>
			Add cards
		</button>
	</div>
</header>

<style>
	/* ─── Header ───────────────────────────────────────────────────────── */

	.plan-header {
		display: flex; align-items: center; justify-content: space-between;
		gap: var(--space-md); padding: var(--space-md) var(--space-xl);
		background: var(--bg-surface); border-bottom: 1px solid var(--glass-border);
		position: sticky; top: 0; z-index: 10;
	}
	.plan-header-left { display: flex; align-items: center; gap: var(--space-md); min-width: 0; flex: 1; }
	.plan-header-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

	.back-btn {
		display: flex; align-items: center; justify-content: center;
		width: 32px; height: 32px; border-radius: var(--radius-sm);
		color: var(--text-secondary); transition: all 0.15s; flex-shrink: 0;
	}
	.back-btn:hover { background: var(--glass-hover); color: var(--text-primary); }

	.plan-title-icon { font-size: 1.3rem; flex-shrink: 0; }

	.plan-header h1 {
		font-size: 1.1rem; font-weight: 700; color: var(--text-primary);
		letter-spacing: -0.02em; min-width: 0;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: text;
	}

	.name-input {
		flex: 1; min-width: 0; padding: 5px 10px;
		background: var(--bg-elevated); border: 1px solid var(--accent-indigo);
		border-radius: var(--radius-sm); color: var(--text-primary);
		font-family: var(--font-family); font-size: 1.05rem; font-weight: 700;
	}
	.name-input:focus { outline: none; }

	.status-chip {
		flex-shrink: 0; padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
	}
	.status-chip.closed {
		background: rgba(136, 136, 170, 0.12); color: var(--text-tertiary);
		border: 1px solid rgba(136, 136, 170, 0.25);
	}
	.status-chip.ready {
		background: rgba(99, 102, 241, 0.14); color: #818cf8;
		border: 1px solid rgba(99, 102, 241, 0.3); cursor: help;
	}
	/* When there is nothing left to do, closing is the obvious next action. */
	.hdr-btn.ready {
		background: rgba(99, 102, 241, 0.14); color: #818cf8;
		border-color: rgba(99, 102, 241, 0.35);
	}
	.status-chip.open {
		background: rgba(16, 185, 129, 0.12); color: var(--accent-emerald);
		border: 1px solid rgba(16, 185, 129, 0.25);
	}

	/* Header controls share one size and never wrap — the title truncates when
	   space runs out, because the controls are the part you still need. */
	.hdr-btn {
		display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
		height: 30px; padding: 0 11px;
		background: var(--bg-elevated); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); color: var(--text-secondary);
		font-family: var(--font-family); font-size: 0.76rem; font-weight: 600;
		cursor: pointer; text-decoration: none;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.hdr-btn:hover { color: var(--text-primary); border-color: var(--text-tertiary); }
	.hdr-btn:disabled { opacity: 0.5; cursor: wait; }
	.hdr-btn.primary {
		background: var(--accent-indigo); border-color: var(--accent-indigo); color: #fff;
	}
	.hdr-btn.primary:hover { filter: brightness(1.08); border-color: var(--accent-indigo); }
	.hdr-btn.primary.is-on { background: #4f46e5; }

	/* Reads as a date, becomes an input only when you go to change it. */
	.target-btn {
		display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
		height: 30px; padding: 0 11px;
		background: none; border: 1px dashed var(--glass-border);
		border-radius: var(--radius-sm); color: var(--text-tertiary);
		font-family: var(--font-family); font-size: 0.76rem; font-weight: 600;
		cursor: pointer; transition: all var(--duration-fast) var(--ease-out);
	}
	.target-btn:hover { color: var(--text-primary); border-color: var(--text-tertiary); }
	.target-btn.is-set { border-style: solid; color: var(--text-secondary); }
	.target-btn.overdue {
		background: rgba(244, 63, 94, 0.1); color: var(--accent-rose);
		border-color: rgba(244, 63, 94, 0.3); border-style: solid;
	}
	.overdue-tag {
		font-size: 0.6rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.04em; opacity: 0.85;
	}

	.target-input {
		height: 30px; padding: 0 9px; background: var(--bg-elevated);
		border: 1px solid var(--accent-indigo); border-radius: var(--radius-sm);
		color: var(--text-primary); font-family: var(--font-family); font-size: 0.76rem;
	}
	.target-input:focus { outline: none; }

	@media (max-width: 720px) {
		.plan-header { flex-wrap: wrap; }
	}
</style>
