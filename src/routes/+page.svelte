<script lang="ts">
	/**
	 * Dashboard Page — The home screen of DumpFire.
	 *
	 * Shows personal analytics, boards in a tabular layout with
	 * collapsible sub-boards, and quick navigation.
	 */
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import { onMount, onDestroy, untrack } from 'svelte';
	import { connectLiveRefresh } from '$lib/live-refresh';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	// The shared toast, for a write that failed (card 2148: each in the server's
	// words). Renamed here: this page has `toasts` of its own, which are the
	// new-request notices.
	import FailureToast from '$lib/components/Toast.svelte';
	import { toasts as failureToasts } from '$lib/stores/toast';
	import { boardDeleteWarning, deleteFailure } from '$lib/api';
	import CategoryManager from '$lib/components/CategoryManager.svelte';
	import VelocityModal from '$lib/components/VelocityModal.svelte';
	import SpendModal from '$lib/components/SpendModal.svelte';
	// The dashboard's parts (card 2281, slice C2), each drawn where its markup was.
	import DashboardHeader from '$lib/components/dashboard/DashboardHeader.svelte';
	import BoardsTable from '$lib/components/dashboard/BoardsTable.svelte';
	import AnalyticsSidebar from '$lib/components/dashboard/AnalyticsSidebar.svelte';
	import CreateBoardModal from '$lib/components/dashboard/CreateBoardModal.svelte';
	import BoardContextMenu from '$lib/components/dashboard/BoardContextMenu.svelte';
	import ActiveTasksModal from '$lib/components/dashboard/ActiveTasksModal.svelte';
	import RequestToasts from '$lib/components/dashboard/RequestToasts.svelte';
	import { loadXp } from '$lib/board/xp-utils';
	import type { XpEntry } from '$lib/types';
	import { defaultDisplay, sidePaneShown, writeDashboardDisplay, type DashboardDisplay } from '$lib/dashboard/side-pane';
	import { dueFigures } from '$lib/utils/date-utils';

	let { data }: { data: PageData } = $props();

	let showCreate = $state(false);
	let deleting = $state<number | null>(null);

	let confirmState = $state<{ show: boolean; boardId: number; boardName: string }>({ show: false, boardId: 0, boardName: '' });

	let inboxCount = $state(0);
	let expandedBoards = $state<Set<number>>(new Set());
	let collapsedCategories = $state<Set<string>>(new Set());
	let showCategoryManager = $state(false);
	let showVelocityModal = $state(false);
	let showSpendModal = $state(false);

	// ─── The Display choice (card 2526) ──────────────────────────────────────
	// The done switches and the side pane's panels, set from the boards
	// table's Display menu and remembered for this viewer in this browser, in
	// a cookie of their own (`src/lib/dashboard/side-pane.ts`). The load reads
	// that cookie and hands the choice over as `data.dashboardDisplay`, so the
	// server draws the dashboard as it was left and nothing flashes up as the
	// page wakes; the page starts from it, and writes the cookie on each
	// change. It is taken from the load again only when the user changes, by
	// id: a live refresh hands the same choice back, or, with cookies blocked,
	// the defaults, which would undo what was just chosen.
	const displayUserId = $derived.by(() => $page.data.user?.id ?? null);
	let display = $state<DashboardDisplay>(data.dashboardDisplay ?? defaultDisplay());
	let displayFor = $page.data.user?.id ?? null;
	$effect(() => {
		const id = displayUserId;
		if (id === displayFor) return;
		displayFor = id;
		display = untrack(() => data.dashboardDisplay) ?? defaultDisplay();
	});
	/** Takes the boards table's new choice and remembers it. */
	function changeDisplay(next: DashboardDisplay) {
		display = next;
		writeDashboardDisplay(displayUserId, next);
	}
	/** The panels switched off, for the sidebar. */
	const hiddenPanels = $derived<ReadonlySet<string>>(new Set(display.hiddenPanels));

	/** The Active Tasks window, which the sidebar's tile opens. */
	let activeTasksModal = $state<ReturnType<typeof ActiveTasksModal>>();
	/** The boards' context menu, which a board's row opens. */
	let boardContextMenu = $state<ReturnType<typeof BoardContextMenu>>();

	// Closes the live stream that keeps the board rows, token totals and cost
	// current. Without it this screen only told the truth as at page load.
	let stopLiveRefresh: (() => void) | null = null;

	/**
	 * Everyone's XP, for the sidebar's XP leaderboard (card 2466: the one place
	 * XP is shown since the board header stopped drawing it). Read as the page
	 * mounts and again with each live refresh, which the stream's `xp-update`
	 * (a card completed anywhere) schedules as it does an `update`. `loadXp`
	 * gives an empty list for a read that fails, as for none, and the panel is
	 * then not drawn: it is not critical, as on the board before.
	 */
	let xpEntries = $state<XpEntry[]>([]);
	async function refreshXp() {
		xpEntries = await loadXp();
	}

	onMount(async () => {
		// The due figures' day moves on at midnight, on the board pages' tick.
		clockInterval = setInterval(() => { clock = new Date(); }, 15000);
		refreshXp();
		stopLiveRefresh = connectLiveRefresh(() => {
			invalidateAll();
			refreshXp();
		});
	});

	onDestroy(() => {
		if (stopLiveRefresh) stopLiveRefresh();
		if (clockInterval) clearInterval(clockInterval);
	});

	function confirmDeleteBoard(id: number, name: string) {
		confirmState = { show: true, boardId: id, boardName: name };
	}

	async function deleteBoard(id: number) {
		deleting = id;
		confirmState.show = false;
		const started = failureToasts.navigation();
		try {
			const failure = await deleteFailure(() => fetch(`/api/boards/${id}`, { method: 'DELETE' }), 'board');
			if (failure) {
				failureToasts.add(failure, 'error', started);
				return;
			}
			await invalidateAll();
		} finally {
			deleting = null;
		}
	}

	// ─── Due figures (card 2258) ─────────────────────────────────────────────
	// The viewer's moment, which the sidebar counts its due figures on and
	// Active Tasks its due words (card 2281, slice C2: each says how). Null
	// until the page has loaded, on the server and while the page hydrates.
	// Set again on each live refresh, and on a tick, so a page left open
	// across midnight moves on.
	let clock = $state<Date | null>(null);
	let clockInterval: ReturnType<typeof setInterval> | null = null;
	$effect(() => {
		void data.analytics;
		clock = new Date();
	});

	/**
	 * Whether the side pane's column is drawn (card 2526): not with the pane
	 * off, nor when no panel switched on has anything to draw, so no empty
	 * column is left; the boards then take the width. Upcoming Deadlines is
	 * counted on the page's clock as the sidebar counts it.
	 */
	const paneShown = $derived.by(() => {
		const a = data.analytics;
		const upcoming = clock ? dueFigures(a.dueCards, clock, undefined, a.longOverdue) : dueFigures(a.dueCards, new Date(a.asOf), 'UTC', a.longOverdue);
		return sidePaneShown(display, { analytics: a, xpCount: xpEntries.length, upcomingCount: upcoming.upcoming.length });
	});
</script>

<svelte:head>
	<title>DumpFire — Your Boards</title>
</svelte:head>

<div class="dashboard">
	<DashboardHeader {inboxCount} bind:showCreate />

	<!-- ─── Analytics Section ────────────────────────────────────────────── -->
	<div class="dashboard-grid" class:no-sidebar={!paneShown}>
		<div class="main-column stagger-children">
			<!-- ─── Boards List ─────────────────────────────────────────────── -->
			<BoardsTable
				{data}
				{deleting}
				{confirmDeleteBoard}
				openBoardContextMenu={(e, boardId, boardName) => boardContextMenu?.openBoardContextMenu(e, boardId, boardName)}
				bind:showCreate
				bind:expandedBoards
				bind:collapsedCategories
				bind:showCategoryManager
				bind:display={() => display, changeDisplay}
			/>
		</div>

		<!-- ─── Sidebar (Analytics) ──────────────────────────────────────── -->
		{#if paneShown}
		<div class="sidebar-column stagger-children">

			<AnalyticsSidebar
				{data}
				{clock}
				{xpEntries}
				hidden={hiddenPanels}
				openActiveTasksModal={() => activeTasksModal?.openActiveTasksModal()}
				bind:showVelocityModal
				bind:showSpendModal
			/>
		</div>
		{/if}
	</div>

	<!-- Support modals -->
	{#if showCategoryManager}
		<CategoryManager categories={data.allCategories} onClose={() => showCategoryManager = false} />
	{/if}
</div>

<!-- Create board modal -->
<CreateBoardModal {data} bind:showCreate />

<!-- Board Context Menu -->
<BoardContextMenu bind:this={boardContextMenu} {data} {confirmDeleteBoard} bind:expandedBoards bind:collapsedCategories />

{#if confirmState.show}
	<ConfirmModal
		title="Delete Board"
		message={boardDeleteWarning(confirmState.boardName)}
		confirmText="Delete Board"
		onConfirm={() => deleteBoard(confirmState.boardId)}
		onCancel={() => (confirmState.show = false)}
	/>
{/if}

<FailureToast />

<ActiveTasksModal bind:this={activeTasksModal} {clock} />

<!-- Velocity graph modal -->
{#if showVelocityModal}
	<VelocityModal onclose={() => (showVelocityModal = false)} />
{/if}

{#if showSpendModal}
	<SpendModal spend={data.spendByUser} onclose={() => (showSpendModal = false)} />
{/if}

<!-- Toast notifications for new requests -->
<RequestToasts bind:inboxCount />

<style>
	/* The page's last line stops above the user badge (card 2239). */
	.dashboard { max-width: 1400px; margin: 0 auto; padding: var(--space-xl) var(--space-xl) var(--user-badge-space); }

	/* ─── Grid Layout ────────────────────────────────────────────── */
	.dashboard-grid {
		display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: var(--space-xl);
		align-items: start;
	}
	/* The side pane off, or every panel in it (card 2526): the boards list takes the width. */
	.dashboard-grid.no-sidebar { grid-template-columns: minmax(0, 1fr); }
	.main-column { min-width: 0; }
	.sidebar-column { display: flex; flex-direction: column; gap: var(--space-lg); position: sticky; top: var(--space-xl); }

	/* Responsive */
	@media (max-width: 1024px) {
		.dashboard-grid { grid-template-columns: 1fr; }
		.sidebar-column { position: static; }
	}
</style>
