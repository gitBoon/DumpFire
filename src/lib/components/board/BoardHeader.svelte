<!--
  BoardHeader.svelte — The board page's header (card 2280, slice B3: moved
  from the board page).

  On the left the way back (the boards above this one, or the dashboard), the
  board's emoji and name, each changed in place, and what the board has cost;
  then the XP bars the page hands it (`xp`), the search, the assignee filter
  and Hide blocked; on the right the Board | List switch, Planning, All To
  Do, Add Column, the More menu the page hands it (`more`) and the theme.

  It sends nothing itself. The name being typed, the search and the filters
  are the page's, bound here; the rename, the emoji and the rest are handed
  to the page's own functions.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';
	import ThemePicker from '$lib/components/ThemePicker.svelte';
	import BoardViewSwitch from './BoardViewSwitch.svelte';
	import { formatTokens } from '$lib/tokens';
	import { formatUsd, BLEND_NOTE, SOURCE_NOTE, NOT_BILLED_NOTE } from '$lib/pricing';
	import type { BoardViewName } from '$lib/board/board-view';
	import type { BoardContentsData, BreadcrumbType } from '$lib/board/contents-answer';

	let {
		boardId,
		boardName,
		boardEmoji,
		breadcrumbs,
		tokenSummary,
		editingName,
		nameDraft = $bindable(),
		searchQuery = $bindable(),
		filterAssigneeId = $bindable(),
		hideBlocked = $bindable(),
		currentUser,
		boardUsers,
		view,
		onEmoji,
		onStartRename,
		onRename,
		onViewChange,
		onAddColumn,
		xp,
		more
	}: {
		boardId: number;
		boardName: string;
		boardEmoji: string;
		breadcrumbs: BreadcrumbType[];
		tokenSummary: BoardContentsData['boardTokenSummary'];
		/** The name is being changed in place: the box is shown, on `nameDraft`. */
		editingName: boolean;
		nameDraft: string;
		searchQuery: string;
		filterAssigneeId: number | null;
		hideBlocked: boolean;
		currentUser: { id: number } | null | undefined;
		boardUsers: BoardContentsData['boardUsers'];
		view: BoardViewName;
		onEmoji: (emoji: string) => void;
		onStartRename: () => void;
		/** The box's blur and Enter: the page sends the name, once. */
		onRename: () => void;
		onViewChange: (view: BoardViewName) => void;
		onAddColumn: () => void;
		/** The XP bars, between the name and the search. */
		xp?: Snippet;
		/** The More menu, before the theme. */
		more?: Snippet;
	} = $props();
</script>

<header class="board-header">
	<div class="board-header-left">
		{#if breadcrumbs && breadcrumbs.length > 0}
			<nav class="breadcrumbs">
				<a href="/" class="breadcrumb-link breadcrumb-home" title="Dashboard">🔥</a>
				<span class="breadcrumb-sep">›</span>
				{#each breadcrumbs as crumb}
					<!-- A board above this one that the caller cannot open has no name and no link (card 2130), nor has the "…" above the nearest 20 (card 2172). -->
					{#if crumb.href}
						<a href={crumb.href} class="breadcrumb-link">{crumb.emoji} {crumb.label}</a>
					{:else}
						<span class="breadcrumb-link breadcrumb-withheld" title={crumb.title}>{#if crumb.emoji}{crumb.emoji} {/if}{crumb.label}</span>
					{/if}
					<span class="breadcrumb-sep">›</span>
				{/each}
			</nav>
		{:else}
			<a href="/" class="back-btn btn-ghost" id="back-to-dashboard">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</a>
		{/if}
		<EmojiPicker value={boardEmoji} onSelect={(emoji) => onEmoji(emoji)} />
		{#if editingName}
			<input
				class="board-name-input"
				type="text"
				bind:value={nameDraft}
				onblur={onRename}
				onkeydown={(e) => e.key === 'Enter' && onRename()}
				autofocus
			/>
		{:else}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<h1 class="board-name" onclick={onStartRename} role="button" tabindex="0">
				{boardName}
				<span class="board-id">#{boardId}</span>
			</h1>
		{/if}
		<!-- What this board has cost. Only shown once something is recorded:
		     a permanent "—" in the header would be noise on every board
		     nobody reports against. -->
		{#if tokenSummary}
			<span class="hdr-cost" title="{formatTokens(tokenSummary.total)} tokens across this board · {NOT_BILLED_NOTE}. {SOURCE_NOTE} — {BLEND_NOTE}.">
				{formatTokens(tokenSummary.total)}
				{#if tokenSummary.costUsd !== null}
					<span class="hdr-cost-money">{formatUsd(tokenSummary.costUsd)}</span>
				{/if}
			</span>
		{/if}
	</div>

	{@render xp?.()}

	<div class="search-wrapper hdr-search">
		<svg class="search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
			<circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5"/>
			<path d="M9.5 9.5L13 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
		</svg>
		<input
			class="search-input"
			type="text"
			placeholder="Search tasks or #id..."
			bind:value={searchQuery}
		/>
		{#if searchQuery}
			<button class="search-clear btn-ghost" onclick={() => (searchQuery = '')}>
				<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
			</button>
		{/if}
	</div>
	<select class="hdr-control assignee-filter" bind:value={filterAssigneeId}>
		<option value={null}>All assignees</option>
		{#if currentUser}
			<option value={currentUser.id}>👤 My Cards</option>
		{/if}
		{#each boardUsers.filter(u => u.id !== currentUser?.id) as u}
			<option value={u.id}>{u.emoji || '👤'} {u.username}</option>
		{/each}
	</select>
	<button
		class="hdr-control blocked-filter-toggle"
		class:is-on={hideBlocked}
		onclick={() => (hideBlocked = !hideBlocked)}
		title="Hide cards that are still waiting on another card"
	>
		<svg width="13" height="13" viewBox="0 0 10 10" fill="none" aria-hidden="true">
			<circle cx="5" cy="5" r="4" stroke="currentColor" stroke-width="1.4"/>
			<path d="M2.2 7.8L7.8 2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
		</svg>
		Hide blocked
	</button>

	<div class="board-header-right">
		<BoardViewSwitch {view} onChange={(view) => onViewChange(view)} />
		<!-- Scoped to this board: arriving from a board, the question is about
		     this board's goals, not every goal in the workspace. -->
		<a href="/plan?board={boardId}" class="hdr-control hdr-action" title="Planning — critical path and what is startable for this board">
			<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
				<circle cx="3.5" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/>
				<circle cx="8" cy="4" r="1.8" stroke="currentColor" stroke-width="1.2"/>
				<circle cx="12.5" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/>
				<path d="M5.2 7.1L6.4 4.9M9.6 4.9l1.2 2.2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
				<path d="M5.3 8.9l5.4 2.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-dasharray="1.5 1.5"/>
			</svg>
			Planning
		</a>
		<!-- Every board's To Do column as one table, filtered to this board and
		     its sub-boards (card 2240). Shown on every board, one with no To Do
		     column too: its sub-boards may have one. -->
		<a href="/todo?board={boardId}" class="hdr-control hdr-action" title="This board's To Do column, and its sub-boards', with every other board's a filter away">
			<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
				<rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.3"/>
				<path d="M4.8 6.2l1.2 1.2 2-2.2M9.6 6.4h2M4.8 10.2h6.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
			All To Do
		</a>
		<button class="hdr-control hdr-action" onclick={() => onAddColumn()} title="Add column">
			<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
				<rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/>
				<path d="M8 5v6M5 8h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
			</svg>
			Add Column
		</button>

		{@render more?.()}

		<ThemePicker />
	</div>
</header>

<style>
	.board-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-md) var(--space-xl); border-bottom: 1px solid var(--glass-border);
		flex-shrink: 0; gap: var(--space-md); flex-wrap: wrap;
	}
	.board-header-left { display: flex; align-items: center; gap: var(--space-md); min-width: 0; flex: 1 1 auto; }
	.board-header-right { display: flex; align-items: center; gap: var(--space-sm); flex-shrink: 0; flex-wrap: wrap; }
	.back-btn { padding: var(--space-sm); }

	.breadcrumbs {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		font-size: 0.8rem;
		flex-shrink: 1;
		min-width: 0;
		overflow: hidden;
	}

	.breadcrumb-home {
		font-size: 1.25rem;
		line-height: 1;
		flex-shrink: 0;
	}

	.breadcrumb-link {
		color: var(--text-secondary);
		text-decoration: none;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 160px;
		transition: color var(--duration-fast) var(--ease-out);
	}

	.breadcrumb-link:hover {
		color: var(--text-primary);
	}

	/* Not a link: it does not answer the pointer as one. */
	.breadcrumb-withheld,
	.breadcrumb-withheld:hover {
		color: var(--text-tertiary);
		cursor: default;
	}

	.breadcrumb-sep {
		color: var(--text-tertiary);
		font-weight: 300;
		flex-shrink: 0;
	}

	/* What has been spent, on the header strip. Sized to be read at a glance:
	   this is the figure the whole ledger exists to surface, and at 0.72rem it
	   was easy to miss entirely. The money carries the most weight because it
	   is the part people act on. Identical on the board and All Tasks headers. */
	.hdr-cost {
		display: inline-flex; align-items: baseline; gap: 8px;
		padding: 5px 14px; border-radius: var(--radius-full);
		background: var(--bg-surface);
		border: 1px solid var(--accent-purple-glow, var(--glass-border));
		font-size: 1rem; font-weight: 600; line-height: 1.25;
		color: var(--text-primary);
		font-variant-numeric: tabular-nums; white-space: nowrap;
	}
	.hdr-cost-money { font-weight: 800; font-size: 1.1rem; color: var(--accent-purple, #8b5cf6); }
	.board-name {
		font-size: 1.25rem; cursor: pointer; padding: 2px var(--space-sm);
		border-radius: var(--radius-sm); transition: background var(--duration-fast) var(--ease-out);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.board-name:hover { background: var(--glass-hover); }
	.board-name-input { font-size: 1.25rem; font-weight: 700; padding: 2px var(--space-sm); background: var(--bg-surface); width: 300px; }

	/* Search bar */
	.search-wrapper {
		position: relative; display: flex; align-items: center;
		flex: 1; max-width: 280px;
	}
	.search-icon {
		position: absolute; left: 10px; color: var(--text-tertiary);
		pointer-events: none;
	}
	/* Header controls come from .hdr-control / .hdr-search in app.css so the
	   board, All Tasks and the planning view cannot drift apart again. Only
	   what is genuinely local to this header stays here. */
	.search-input { width: 100%; }
	.assignee-filter { padding-right: 8px; }


	.search-input::placeholder { color: var(--text-tertiary); }
	.search-input:focus { outline: none; border-color: var(--accent-indigo); }
	.search-clear {
		position: absolute; right: 6px; padding: 3px !important;
		opacity: 0.5;
	}
	.search-clear:hover { opacity: 1; }
	.assignee-filter:focus { outline: none; border-color: var(--accent-indigo); }

	/* Amber is specific to "blocked", so this state stays local to the filter. */
	.blocked-filter-toggle.is-on {
		background: rgba(245, 158, 11, 0.14); color: #f59e0b;
		border-color: rgba(245, 158, 11, 0.35);
	}

	/* ─── Mobile Responsive ──────────────────────────────────────────────── */

	@media (max-width: 768px) {
		.board-header {
			padding: var(--space-sm) var(--space-md);
			gap: var(--space-sm);
		}
		.board-header-left { gap: var(--space-sm); }
		.board-header-right { gap: var(--space-xs); }
		.board-name { font-size: 1rem; max-width: 180px; }
		.search-wrapper { max-width: 100%; }
		.breadcrumb-link { max-width: 100px; }

		/* Touch-friendly buttons */
		.btn-ghost {
			min-height: 36px;
			min-width: 36px;
		}
	}

	@media (max-width: 480px) {
		.board-header { flex-direction: column; align-items: stretch; }
		.board-header-left { flex-wrap: wrap; }
		.board-header-right { justify-content: flex-end; }
	}
</style>
