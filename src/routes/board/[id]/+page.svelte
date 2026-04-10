<script lang="ts">
	/**
	 * Board Page — The main Kanban board view.
	 *
	 * This file is a thin orchestration layer: it declares reactive state,
	 * delegates all business logic to extracted modules, and wires up the
	 * template. Heavy lifting lives in:
	 *   - board-actions.ts (board/column/category CRUD)
	 *   - card-actions.ts  (card CRUD, duplicate, pin, sub-boards)
	 *   - dnd-handlers.ts  (drag-and-drop orchestration)
	 *   - bulk-actions.ts  (multi-select operations)
	 *   - xp-utils.ts      (XP levelling calculations)
	 *   - sse.ts           (Server-Sent Events connection)
	 */
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
	import { dndzone } from 'svelte-dnd-action';
	import { flip } from 'svelte/animate';
	import { theme } from '$lib/stores/theme';
	import { toasts } from '$lib/stores/toast';

	// Shared types
	import type { CardType, ColumnType, CategoryType, LabelType, ActivityType, SortOption, XpEntry, BlockedState, OnHoldState } from '$lib/types';

	// Shared utilities
	import { COLUMN_COLORS, COMMON_EMOJIS, FLIP_DURATION_MS } from '$lib/utils/constants';
	import { parseUTC, getRelativeAge, getDueRelative, getDueStatus, isStale, isNew } from '$lib/utils/date-utils';
	import { isCompleteColumn, isOnHoldColumn, subtaskProgress, matchesSearch, sortCards, getCategoryById, getLabelById, getPriorityLabel, getSortLabel, getActionLabel, getVisibleCount } from '$lib/utils/card-utils';
	import { playMoveSound, playCompleteSound } from '$lib/utils/sounds';

	// Board-specific modules
	import * as api from '$lib/api';
	import * as boardActions from '$lib/board/board-actions';
	import * as cardActions from '$lib/board/card-actions';
	import * as dndHandlers from '$lib/board/dnd-handlers';
	import * as bulkOps from '$lib/board/bulk-actions';
	import { getLevel, getXpProgress, loadXp as fetchXpData } from '$lib/board/xp-utils';
	import { connectSSE } from '$lib/board/sse';

	// Components
	import CardModal from '$lib/components/CardModal.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import ShareModal from '$lib/components/ShareModal.svelte';
	import ThemePicker from '$lib/components/ThemePicker.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import KanbanCard from '$lib/components/board/KanbanCard.svelte';
	import ActivityPanel from '$lib/components/board/ActivityPanel.svelte';
	import StatsPanel from '$lib/components/board/StatsPanel.svelte';
	import BulkActionBar from '$lib/components/board/BulkActionBar.svelte';
	import ContextMenu from '$lib/components/board/ContextMenu.svelte';
	import FireworksCelebration from '$lib/components/board/FireworksCelebration.svelte';
	import AddColumnModal from '$lib/components/board/AddColumnModal.svelte';
	import CategoryModal from '$lib/components/board/CategoryModal.svelte';
	import OnHoldModal from '$lib/components/board/OnHoldModal.svelte';

	// ─── Props & Core State ──────────────────────────────────────────────────

	let { data }: { data: PageData } = $props();

	let boardColumns = $state<ColumnType[]>(data.columns as unknown as ColumnType[]);
	let boardCategories = $state<CategoryType[]>(data.categories as CategoryType[]);
	let boardLabels = $state<LabelType[]>((data.labels || []) as LabelType[]);

	// ─── Panel State ─────────────────────────────────────────────────────────

	let showActivityPanel = $state(false);
	let activities = $state<ActivityType[]>([]);
	let loadingActivities = $state(false);
	let showStatsPanel = $state(false);

	// ─── Inline Card Editing ─────────────────────────────────────────────────
	let inlineEditCardId = $state<number | null>(null);
	let inlineEditValue = $state('');

	function startInlineEdit(card: CardType, e: MouseEvent) {
		e.stopPropagation();
		e.preventDefault();
		inlineEditCardId = card.id;
		inlineEditValue = card.title;
	}

	async function saveInlineEdit(cardId: number) {
		const trimmed = inlineEditValue.trim();
		if (!trimmed) { inlineEditCardId = null; return; }
		const col = boardColumns.find(c => c.cards.some(cd => cd.id === cardId));
		const card = col?.cards.find(cd => cd.id === cardId);
		if (card && card.title !== trimmed) {
			card.title = trimmed;
			boardColumns = [...boardColumns];
			await api.updateCard(cardId, { title: trimmed, boardId: data.board.id });
			toasts.add('Title updated');
		}
		inlineEditCardId = null;
	}

	function cancelInlineEdit() { inlineEditCardId = null; }

	function handleInlineKeydown(e: KeyboardEvent, cardId: number) {
		if (e.key === 'Enter') { e.preventDefault(); saveInlineEdit(cardId); }
		else if (e.key === 'Escape') { e.preventDefault(); cancelInlineEdit(); }
	}

	// Priority cycling for quick-edit
	const PRIORITY_CYCLE = ['low', 'medium', 'high', 'critical'] as const;

	async function cyclePriority(card: CardType, e: MouseEvent) {
		e.stopPropagation();
		const idx = PRIORITY_CYCLE.indexOf(card.priority as any);
		const next = PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length];
		card.priority = next;
		boardColumns = [...boardColumns];
		await api.updateCard(card.id, { priority: next, boardId: data.board.id });
	}

	// ─── Bulk Selection ──────────────────────────────────────────────────────

	let selectionMode = $state(false);
	let selectedCards = $state<Set<number>>(new Set());

	function toggleSelection(cardId: number, e: MouseEvent) {
		e.stopPropagation();
		const next = new Set(selectedCards);
		if (next.has(cardId)) next.delete(cardId); else next.add(cardId);
		selectedCards = next;
	}

	function clearSelection() {
		selectionMode = false;
		selectedCards = new Set();
	}

	async function handleBulkMove(targetColumnId: number) {
		const targetCol = boardColumns.find(c => c.id === targetColumnId);
		if (!targetCol) return;
		await bulkOps.bulkMove(selectedCards, targetColumnId, targetCol.cards.length, data.board.id, currentUser?.username || '', currentUser?.emoji || '👤');
		clearSelection();
		await invalidateAll();
	}

	async function handleBulkDelete() {
		await bulkOps.bulkDelete(selectedCards, data.board.id);
		clearSelection();
		await invalidateAll();
	}

	async function handleBulkPriority(priority: string) {
		await bulkOps.bulkPriority(selectedCards, priority, data.board.id);
		clearSelection();
		await invalidateAll();
	}

	// ─── Column Editing ──────────────────────────────────────────────────────

	let editingColumn = $state<number | null>(null);
	let editColumnTitle = $state('');

	function startEditColumn(col: ColumnType) {
		editingColumn = col.id;
		editColumnTitle = col.title;
	}

	async function finishEditColumn(colId: number) {
		if (editColumnTitle.trim()) {
			await boardActions.updateColumn(colId, { title: editColumnTitle.trim() }, data.board.id);
			const col = boardColumns.find((c) => c.id === colId);
			if (col) col.title = editColumnTitle.trim();
		}
		editingColumn = null;
	}

	// ─── Card Modal ──────────────────────────────────────────────────────────

	let showCardModal = $state(false);
	let editingCard = $state<CardType | null>(null);
	let cardModalColumnId = $state<number | null>(null);

	onMount(() => {
		const targetCardId = $page.url.searchParams.get('card');
		if (targetCardId) {
			const cid = parseInt(targetCardId, 10);
			const card = boardColumns.flatMap(c => c.cards).find(c => c.id === cid);
			if (card) {
				// Strip query param from URL without reloading
				const newUrl = new URL($page.url);
				newUrl.searchParams.delete('card');
				window.history.replaceState({}, '', newUrl.toString());
				openCardModal(card);
			}
		}
	});

	function openCardModal(card: CardType) {
		editingCard = card;
		cardModalColumnId = card.columnId;
		showCardModal = true;
	}

	function openNewCardModal(columnId: number) {
		editingCard = null;
		cardModalColumnId = columnId;
		showCardModal = true;
	}

	async function saveCard(cardData: { title: string; description: string; priority: string; colorTag: string; categoryId: number | null; dueDate: string | null; onHoldNote?: string; businessValue?: string; pendingSubtasks?: string[]; pendingAssigneeIds?: number[]; pendingSubBoards?: string[] }) {
		const result = await cardActions.saveCard(editingCard, cardModalColumnId, data.board.id, boardColumns, cardData);
		showCardModal = false;
		if (result.isNew && cardData.title) {
			logActivity('card_created', cardData.title);
			toasts.add(`Created "${cardData.title}"`);

			// Assign pending users to the newly created card
			if (result.cardId && cardData.pendingAssigneeIds?.length) {
				await Promise.all(cardData.pendingAssigneeIds.map(userId =>
					fetch(`/api/cards/${result.cardId}/assignees`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ userId })
					})
				));
			}

			// Create pending sub-boards for the newly created card
			if (result.cardId && cardData.pendingSubBoards?.length) {
				for (const sbName of cardData.pendingSubBoards) {
					const res = await fetch('/api/boards', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ name: sbName, parentCardId: result.cardId })
					});
					if (res.ok) {
						toasts.add(`Sub-board "${sbName}" created`);
					}
				}
			}
		} else if (!result.isNew && editingCard) {
			toasts.add('Card updated');
		}
		editingCard = null;
		await invalidateAll();
	}

	function confirmDeleteCard(cardId: number) {
		showConfirm(
			'Delete Card',
			'Are you sure you want to delete this card and all its subtasks? This cannot be undone.',
			'Delete Card',
			async () => {
				const card = boardColumns.flatMap(c => c.cards).find(c => c.id === cardId);
				await cardActions.deleteCard(cardId, data.board.id);
				if (card) logActivity('card_deleted', card.title, cardId);
				toasts.add('Card deleted', 'info');
				confirmState.show = false;
				showCardModal = false;
				editingCard = null;
				await invalidateAll();
			}
		);
	}

	// ─── Board Identity ──────────────────────────────────────────────────────

	let editingBoardName = $state(false);
	let boardName = $state(data.board.name);
	let boardEmoji = $state(data.board.emoji || '📋');
	let showEmojiPicker = $state(false);

	async function saveBoardName() {
		await boardActions.saveBoardName(data.board.id, boardName);
		editingBoardName = false;
	}

	async function saveBoardEmoji(emoji: string) {
		boardEmoji = emoji;
		showEmojiPicker = false;
		await boardActions.saveBoardEmoji(data.board.id, emoji);
	}

	// ─── Add Column Modal ────────────────────────────────────────────────────

	let showAddColumnModal = $state(false);
	let newColumnTitle = $state('');
	let newColumnColor = $state('#6366f1');
	let newColumnPosition = $state('end');

	async function addColumn() {
		await boardActions.addColumn(data.board.id, newColumnTitle, newColumnColor, newColumnPosition, boardColumns);
		showAddColumnModal = false;
		newColumnTitle = '';
		newColumnPosition = 'end';
		await invalidateAll();
	}

	async function updateColumn(colId: number, updates: Record<string, unknown>) {
		await boardActions.updateColumn(colId, updates, data.board.id);
	}

	function confirmDeleteColumn(colId: number, colTitle: string) {
		showConfirm(
			'Delete Column',
			`Are you sure you want to delete "${colTitle}" and all its cards? This cannot be undone.`,
			'Delete Column',
			async () => {
				await boardActions.deleteColumn(colId, data.board.id);
				confirmState.show = false;
				await invalidateAll();
			}
		);
	}

	// ─── Category Management ─────────────────────────────────────────────────

	let showCategoryModal = $state(false);
	let newCategoryName = $state('');
	let newCategoryColor = $state('#6366f1');

	async function addCategory() {
		await boardActions.addCategory(data.board.id, newCategoryName, newCategoryColor);
		newCategoryName = '';
		newCategoryColor = '#6366f1';
		await invalidateAll();
	}

	async function deleteCategory(id: number) {
		await boardActions.deleteCategory(id);
		await invalidateAll();
	}

	// ─── Confirm Modal ───────────────────────────────────────────────────────

	let confirmState = $state<{
		show: boolean; title: string; message: string;
		confirmText: string; onConfirm: () => void;
	}>({ show: false, title: '', message: '', confirmText: '', onConfirm: () => {} });

	function showConfirm(title: string, message: string, confirmText: string, onConfirm: () => void) {
		confirmState = { show: true, title, message, confirmText, onConfirm };
	}

	// ─── Dropdown & Context Menu ─────────────────────────────────────────────

	let openDropdown = $state<string | null>(null);
	let contextMenu = $state<{ show: boolean; x: number; y: number; card: CardType | null; columnId: number }>({ show: false, x: 0, y: 0, card: null, columnId: 0 });

	function toggleDropdown(id: string) { openDropdown = openDropdown === id ? null : id; }
	function closeDropdowns() { openDropdown = null; showEmojiPicker = false; showMoreMenu = false; contextMenu = { ...contextMenu, show: false }; }

	function openContextMenu(e: MouseEvent, card: CardType, columnId: number) {
		e.preventDefault();
		e.stopPropagation();
		contextMenu = { show: true, x: e.clientX, y: e.clientY, card, columnId };
	}

	async function duplicateCard(card: CardType) {
		const title = await cardActions.duplicateCard(card, boardColumns, data.board.id);
		if (title) {
			logActivity('card_created', `${title} (Copy)`);
			toasts.add(`Duplicated "${title}"`);
		}
		contextMenu = { ...contextMenu, show: false };
		await invalidateAll();
	}

	async function togglePin(card: CardType) {
		const newPinned = await cardActions.togglePin(card, data.board.id);
		card.pinned = newPinned;
		boardColumns = [...boardColumns];
		toasts.add(newPinned ? `Pinned "${card.title}"` : `Unpinned "${card.title}"`);
		contextMenu = { ...contextMenu, show: false };
	}

	async function createSubBoard(card: CardType, name?: string) {
		contextMenu = { ...contextMenu, show: false };
		const boardId = await cardActions.createSubBoard(card.id, name || card.title);
		if (boardId) window.location.href = `/board/${boardId}`;
	}

	async function linkSubBoard(cardId: number, boardId: number) {
		await cardActions.linkSubBoard(cardId, boardId);
		await invalidateAll();
		toasts.add('Board linked as sub-board');
	}

	function deleteSubBoard(boardId: number) {
		const sbName = cardActions.findSubBoardName(boardId, boardColumns);
		showConfirm(
			'Delete Sub-board',
			`Delete "${sbName}" and all its cards? This cannot be undone.`,
			'Delete',
			async () => {
				const ok = await cardActions.deleteSubBoard(boardId);
				if (ok) {
					await invalidateAll();
					if (editingCard) {
						const cardId = editingCard.id;
						for (const col of boardColumns) {
							const found = col.cards.find(c => c.id === cardId);
							if (found) { editingCard = found; break; }
						}
					}
					toasts.add('Sub-board deleted');
				}
			}
		);
	}

	// ─── Column Sort ─────────────────────────────────────────────────────────

	let columnSorts = $state<Record<number, SortOption>>({});

	function setColumnSort(columnId: number, sort: SortOption) {
		columnSorts = { ...columnSorts, [columnId]: sort };
		if (sort !== 'none') {
			const col = boardColumns.find(c => c.id === columnId);
			if (col) {
				col.cards = sortCards([...col.cards], sort, boardCategories);
				boardColumns = [...boardColumns];
			}
		}
		openDropdown = null;
	}

	// ─── Search ──────────────────────────────────────────────────────────────

	let searchQuery = $state('');
	let filterAssigneeId = $state<number | null>(null);


	// ─── Archive Panel ──────────────────────────────────────────────────────────

	let showArchivePanel = $state(false);
	let archivedCards = $state<any[]>([]);
	let loadingArchive = $state(false);

	async function loadArchivedCards() {
		loadingArchive = true;
		try {
			const res = await fetch(`/api/boards/${data.board.id}/archive`);
			if (res.ok) archivedCards = await res.json();
		} finally { loadingArchive = false; }
	}

	async function toggleArchivePanel() {
		showArchivePanel = !showArchivePanel;
		if (showArchivePanel) await loadArchivedCards();
	}

	async function restoreCard(cardId: number) {
		await fetch(`/api/boards/${data.board.id}/archive`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cardId })
		});
		archivedCards = archivedCards.filter(c => c.id !== cardId);
		toasts.add('Card restored');
		await invalidateAll();
	}

	async function permanentlyDeleteCard(cardId: number) {
		await fetch(`/api/cards/${cardId}?permanent=true`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ boardId: data.board.id })
		});
		archivedCards = archivedCards.filter(c => c.id !== cardId);
		toasts.add('Card permanently deleted', 'info');
	}

	// ─── WIP Limit Editing ─────────────────────────────────────────────────────

	let editingWipColumn = $state<number | null>(null);
	let wipLimitInput = $state(0);

	function startEditWipLimit(col: ColumnType) {
		editingWipColumn = col.id;
		wipLimitInput = col.wipLimit || 0;
	}

	async function saveWipLimit(colId: number) {
		const limit = Math.max(0, wipLimitInput);
		await updateColumn(colId, { wipLimit: limit });
		const col = boardColumns.find(c => c.id === colId);
		if (col) col.wipLimit = limit;
		boardColumns = [...boardColumns];
		editingWipColumn = null;
		toasts.add(limit > 0 ? `WIP limit set to ${limit}` : 'WIP limit removed');
	}

	// ─── Blocked & On Hold Modals ────────────────────────────────────────────

	let blockedState = $state<BlockedState>({ show: false, card: null, incomplete: 0, reason: 'subtasks' });
	let onHoldState = $state<OnHoldState>({ show: false, cardId: 0, cardTitle: '', note: '', pendingUpdates: [], pendingColumnId: 0 });

	async function confirmOnHold() {
		await dndHandlers.confirmOnHold(onHoldState, data.board.id, currentUser?.username || '', currentUser?.emoji || '👤');
		logActivity('card_moved', `${onHoldState.cardTitle} → On Hold`, onHoldState.cardId);
		onHoldState = { show: false, cardId: 0, cardTitle: '', note: '', pendingUpdates: [], pendingColumnId: 0 };
	}

	async function cancelOnHold() {
		onHoldState = { show: false, cardId: 0, cardTitle: '', note: '', pendingUpdates: [], pendingColumnId: 0 };
		await invalidateAll();
	}

	// ─── Theme & User ────────────────────────────────────────────────────────

	let currentTheme = $state('light');
	theme.subscribe((v) => (currentTheme = v));

	// User from server-side auth
	let currentUser = $derived($page.data.user);
	let canManage = $derived(data.canManage);
	let showShareModal = $state(false);
	let showMoreMenu = $state(false);

	// ─── Fireworks ───────────────────────────────────────────────────────────

	let showFireworks = $state(false);
	let celebrateCardTitle = $state('');
	let celebrateUserName = $state('');
	let celebrateUserEmoji = $state('');
	let celebrateXpGained = $state(0);

	// ─── XP Leaderboard ──────────────────────────────────────────────────────

	let xpLeaderboard = $state<XpEntry[]>([]);

	async function refreshXp() {
		xpLeaderboard = await fetchXpData();
	}

	// ─── Live Timestamps ─────────────────────────────────────────────────────

	let tick = $state(0);
	let tickInterval: ReturnType<typeof setInterval> | null = null;

	// ─── Drag & Drop ─────────────────────────────────────────────────────────

	function handleColumnDndConsider(e: CustomEvent) {
		boardColumns = e.detail.items;
	}

	async function handleColumnDndFinalize(e: CustomEvent) {
		boardColumns = e.detail.items;
		await dndHandlers.handleColumnDndFinalize(boardColumns, data.board.id);
	}

	function handleCardDndConsider(columnId: number, e: CustomEvent) {
		const col = boardColumns.find((c) => c.id === columnId);
		if (col) col.cards = e.detail.items;
		boardColumns = [...boardColumns];
	}

	async function handleCardDndFinalize(columnId: number, e: CustomEvent) {
		// Clear sort on manual drag
		if (columnSorts[columnId]) {
			columnSorts = { ...columnSorts, [columnId]: 'none' };
		}
		const result = await dndHandlers.handleCardDndFinalize(
			columnId, e.detail.items, boardColumns,
			data.board.id, currentUser?.username || '', currentUser?.emoji || '👤'
		);
		switch (result.action) {
			case 'blocked':
				blockedState = result.blockedState;
				await invalidateAll();
				break;
			case 'on-hold':
				onHoldState = result.onHoldState;
				boardColumns = result.updatedColumns;
				break;
			case 'committed':
				boardColumns = result.updatedColumns;
				for (const entry of result.movedCards) {
					if (entry.isComplete) {
						playCompleteSound();
						logActivity('card_completed', `${entry.card.title} (${entry.fromName} → ${entry.toName})`, entry.card.id);
					} else {
						playMoveSound();
						logActivity('card_moved', `${entry.card.title} (${entry.fromName} → ${entry.toName})`, entry.card.id);
					}
				}
				// Check WIP limit on destination column
				if (result.movedCards.length > 0) {
					const destCol = boardColumns.find(c => c.id === columnId);
					if (destCol && destCol.wipLimit > 0 && destCol.cards.length > destCol.wipLimit) {
						toasts.add(`⚠ ${destCol.title} exceeds WIP limit (${destCol.cards.length}/${destCol.wipLimit})`, 'warning');
					}
				}
				break;
		}
	}

	// ─── Activity Logging ────────────────────────────────────────────────────

	function logActivity(action: string, detail: string, cardId?: number) {
		api.logActivity(data.board.id, action, detail, currentUser?.username || '', currentUser?.emoji || '👤', cardId);
	}

	async function loadActivities() {
		loadingActivities = true;
		const res = await api.loadActivities(data.board.id);
		if (res.ok) activities = await res.json();
		loadingActivities = false;
	}

	// ─── Panel Toggles ───────────────────────────────────────────────────────

	async function toggleActivityPanel() {
		showActivityPanel = !showActivityPanel;
		if (showActivityPanel) await loadActivities();
	}

	function toggleStatsPanel() {
		showStatsPanel = !showStatsPanel;
	}

	// ─── Lifecycle ───────────────────────────────────────────────────────────

	let cleanupSSE: (() => void) | null = null;

	onMount(() => {
		refreshXp();
		tickInterval = setInterval(() => { tick++; }, 15000);
		if (browser) {
			cleanupSSE = connectSSE(data.board.id, {
				onUpdate: () => invalidateAll(),
				onCelebrate: (d) => {
					celebrateCardTitle = d.cardTitle;
					celebrateUserName = d.userName;
					celebrateUserEmoji = d.userEmoji;
					celebrateXpGained = d.xpGained;
					showFireworks = true;
					playCompleteSound();
					setTimeout(() => (showFireworks = false), 3000);
				},
				onXpUpdate: () => refreshXp()
			});
		}
	});

	onDestroy(() => {
		if (cleanupSSE) cleanupSSE();
		if (tickInterval) clearInterval(tickInterval);
	});

	/** Sync board state when page data changes (e.g. after invalidateAll). */
	$effect(() => {
		boardColumns = data.columns as unknown as ColumnType[];
		boardCategories = data.categories as CategoryType[];
		boardLabels = (data.labels || []) as LabelType[];
		boardName = data.board.name;
		boardEmoji = data.board.emoji || '📋';
	});
</script>

<svelte:head>
	<title>{boardEmoji} {boardName} — DumpFire</title>
</svelte:head>

<svelte:window onclick={closeDropdowns} />

<div class="board-page-wrapper">
<div class="board-page">
	<header class="board-header">
		<div class="board-header-left">
			{#if data.breadcrumbs && data.breadcrumbs.length > 0}
				<nav class="breadcrumbs">
					<a href="/" class="breadcrumb-link breadcrumb-home" title="Dashboard">🔥</a>
					<span class="breadcrumb-sep">›</span>
					{#each data.breadcrumbs as crumb}
						<a href={crumb.href} class="breadcrumb-link">{crumb.emoji} {crumb.label}</a>
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
			<div class="emoji-picker-wrapper">
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<span class="board-emoji clickable" onclick={(e) => { e.stopPropagation(); showEmojiPicker = !showEmojiPicker; }} role="button" tabindex="0" title="Change icon">{boardEmoji}</span>
				{#if showEmojiPicker}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="emoji-dropdown" onclick={(e) => e.stopPropagation()}>
						{#each COMMON_EMOJIS as emoji}
							<button class="emoji-option" class:active={boardEmoji === emoji} onclick={() => saveBoardEmoji(emoji)}>{emoji}</button>
						{/each}
					</div>
				{/if}
			</div>
			{#if editingBoardName}
				<input
					class="board-name-input"
					type="text"
					bind:value={boardName}
					onblur={saveBoardName}
					onkeydown={(e) => e.key === 'Enter' && saveBoardName()}
					autofocus
				/>
			{:else}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<h1 class="board-name" onclick={() => (editingBoardName = true)} role="button" tabindex="0">
					{boardName}
				</h1>
			{/if}
		</div>

		<!-- XP Leaderboard -->
		{#if xpLeaderboard.length > 0}
			<div class="xp-bar-container">
				{#each xpLeaderboard.sort((a, b) => b.xp - a.xp) as entry (entry.name)}
					{@const level = getLevel(entry.xp)}
					{@const progress = getXpProgress(entry.xp)}
					<div class="xp-entry" title="{entry.name}: {entry.xp} XP (Level {level})">
						<span class="xp-avatar">{entry.emoji}</span>
						<div class="xp-info">
							<div class="xp-name-row">
								<span class="xp-name">{entry.name}</span>
								<span class="xp-level">Lv.{level}</span>
							</div>
							<div class="xp-track">
								<div class="xp-fill" style="width: {progress}%"></div>
							</div>
						</div>
					</div>
				{/each}
			</div>
		{/if}

		<div class="search-wrapper">
			<svg class="search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
				<circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.5"/>
				<path d="M9.5 9.5L13 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
			</svg>
			<input
				class="search-input"
				type="text"
				placeholder="Search tasks..."
				bind:value={searchQuery}
			/>
			{#if searchQuery}
				<button class="search-clear btn-ghost" onclick={() => (searchQuery = '')}>
					<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
				</button>
			{/if}
		</div>
		<select class="assignee-filter" bind:value={filterAssigneeId}>
			<option value={null}>All assignees</option>
			{#if currentUser}
				<option value={currentUser.id}>👤 My Cards</option>
			{/if}
			{#each data.boardUsers.filter(u => u.id !== currentUser?.id) as u}
				<option value={u.id}>{u.emoji || '👤'} {u.username}</option>
			{/each}
		</select>

		<div class="board-header-right">
			<button class="btn-ghost" onclick={() => (showAddColumnModal = true)} title="Add column">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/>
					<path d="M8 5v6M5 8h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
				</svg>
				Add Column
			</button>

			<!-- More menu (progressive disclosure) -->
			<div class="more-menu-wrapper">
				<button class="btn-ghost more-menu-trigger" class:active-panel-btn={showMoreMenu} onclick={(e) => { e.stopPropagation(); showMoreMenu = !showMoreMenu; }} title="More actions">
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<circle cx="3" cy="8" r="1.5" fill="currentColor"/>
						<circle cx="8" cy="8" r="1.5" fill="currentColor"/>
						<circle cx="13" cy="8" r="1.5" fill="currentColor"/>
					</svg>
					More
				</button>
				{#if showMoreMenu}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="more-dropdown" onclick={(e) => e.stopPropagation()}>
						<div class="more-dropdown-section">
							<div class="more-dropdown-label">Panels</div>
							<button class="more-dropdown-item" class:more-active={showActivityPanel} onclick={() => { toggleActivityPanel(); showMoreMenu = false; }}>
								<span class="more-item-icon">📋</span> Activity Log
								{#if showActivityPanel}<span class="more-check">✓</span>{/if}
							</button>
							<button class="more-dropdown-item" class:more-active={showStatsPanel} onclick={() => { toggleStatsPanel(); showMoreMenu = false; }}>
								<span class="more-item-icon">📊</span> Statistics
								{#if showStatsPanel}<span class="more-check">✓</span>{/if}
							</button>
							<button class="more-dropdown-item" class:more-active={showArchivePanel} onclick={() => { toggleArchivePanel(); showMoreMenu = false; }}>
								<span class="more-item-icon">🗄️</span> Archived Cards
								{#if showArchivePanel}<span class="more-check">✓</span>{/if}
							</button>
						</div>

						<div class="more-dropdown-divider"></div>

						<div class="more-dropdown-section">
							<div class="more-dropdown-label">Board</div>
							<button class="more-dropdown-item" onclick={() => { showCategoryModal = true; showMoreMenu = false; }}>
								<span class="more-item-icon">🏷️</span> Manage Categories
							</button>
							<button class="more-dropdown-item" class:more-active={selectionMode} onclick={() => { selectionMode = !selectionMode; if (!selectionMode) clearSelection(); showMoreMenu = false; }}>
								<span class="more-item-icon">☑️</span> Bulk Select
								{#if selectionMode}<span class="more-check">✓</span>{/if}
							</button>
							{#if canManage}
								<button class="more-dropdown-item" onclick={() => { showShareModal = true; showMoreMenu = false; }}>
									<span class="more-item-icon">🔗</span> Share Board
								</button>
							{/if}
							{#if data.breadcrumbs && data.breadcrumbs.length > 0}
								<button class="more-dropdown-item more-danger" onclick={() => {
									showMoreMenu = false;
									showConfirm('Delete Sub-board', `Delete "${boardName}" and all its cards? This cannot be undone.`, 'Delete', async () => {
										const parentHref = data.breadcrumbs[data.breadcrumbs.length - 1]?.href || '/';
										await fetch(`/api/boards/${data.board.id}`, { method: 'DELETE' });
										window.location.href = parentHref;
									});
								}}>
									<span class="more-item-icon">🗑️</span> Delete Sub-board
								</button>
							{/if}
						</div>
					</div>
				{/if}
			</div>

			<ThemePicker />
		</div>
	</header>

	<!-- Kanban columns -->
	<div class="kanban-container">
		<div
			class="columns-wrapper"
			use:dndzone={{
				items: boardColumns,
				flipDurationMs: FLIP_DURATION_MS,
				type: 'columns',
				dropTargetStyle: { outline: '2px solid rgba(99, 102, 241, 0.4)', borderRadius: '14px' }
			}}
			onconsider={handleColumnDndConsider}
			onfinalize={handleColumnDndFinalize}
		>
			{#each boardColumns as column (column.id)}
				<div class="kanban-column glass" class:wip-warning={column.wipLimit > 0 && column.cards.length >= column.wipLimit} animate:flip={{ duration: FLIP_DURATION_MS }}>
					<div class="column-header">
						<div class="column-top-bar" style="background: {column.color}"></div>
						<div class="column-title-row">
							{#if editingColumn === column.id && canManage}
								<input
									class="column-title-input"
									type="text"
									bind:value={editColumnTitle}
									onblur={() => finishEditColumn(column.id)}
									onkeydown={(e) => e.key === 'Enter' && finishEditColumn(column.id)}
									autofocus
								/>
							{:else}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<h3 class="column-title" onclick={() => canManage && startEditColumn(column)} role="button" tabindex="0">
									{column.title}
								</h3>
							{/if}
							<span class="column-count" class:wip-over={column.wipLimit > 0 && column.cards.length >= column.wipLimit}>{#if searchQuery.trim() || filterAssigneeId !== null}{column.cards.filter(c => matchesSearch(c, searchQuery, boardCategories) && (filterAssigneeId === null || c.assignees?.some(a => a.id === filterAssigneeId))).length}<span class="of-total">/{column.cards.length}</span>{:else}{column.cards.length}{/if}{#if column.wipLimit > 0}<span class="wip-limit-label">/{column.wipLimit}</span>{/if}</span>
							{#if columnSorts[column.id] && columnSorts[column.id] !== 'none'}
								<button class="sort-badge" onclick={() => setColumnSort(column.id, 'none')} title="Clear sort">
									{getSortLabel(columnSorts[column.id])} ✕
								</button>
							{/if}
							{#if column.title.toLowerCase() === 'to do' || column.showAddCard}
								<button class="add-card-badge" onclick={() => openNewCardModal(column.id)} title="Add task">
									<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
									Add Task
								</button>
							{/if}
							<div class="column-actions">
							<div class="color-picker-wrapper">
								<button class="btn-ghost column-action-btn" title="Change color" onclick={(e) => { e.stopPropagation(); toggleDropdown(`color-${column.id}`); }}>
									<span class="color-dot" style="background: {column.color}"></span>
								</button>
								{#if openDropdown === `color-${column.id}`}
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div class="color-picker-dropdown show" onclick={(e) => e.stopPropagation()}>
										{#each COLUMN_COLORS as color}
											<button
												class="color-swatch"
												class:active={column.color === color}
												style="background: {color}"
												onclick={() => { updateColumn(column.id, { color }); column.color = color; closeDropdowns(); }}
											></button>
										{/each}
									</div>
								{/if}
							</div>
							<div class="column-menu-wrapper">
								<button class="btn-ghost column-action-btn" title="Column options" onclick={(e) => { e.stopPropagation(); toggleDropdown(`menu-${column.id}`); }}>
									<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
										<circle cx="7" cy="3" r="1.2" fill="currentColor"/>
										<circle cx="7" cy="7" r="1.2" fill="currentColor"/>
										<circle cx="7" cy="11" r="1.2" fill="currentColor"/>
									</svg>
								</button>
								{#if openDropdown === `menu-${column.id}`}
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div class="column-menu-dropdown show" onclick={(e) => e.stopPropagation()}>
										<button class="column-menu-item" onclick={() => { startEditColumn(column); closeDropdowns(); }}>
											<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8.5 1.5l2 2L4 10H2v-2l6.5-6.5z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
											Rename
										</button>
										<div class="menu-divider"></div>
										<div class="menu-label">Sort by</div>
										<button class="column-menu-item" class:active-sort={columnSorts[column.id] === 'date-asc'} onclick={() => setColumnSort(column.id, 'date-asc')}>
											↑ Oldest first
										</button>
										<button class="column-menu-item" class:active-sort={columnSorts[column.id] === 'date-desc'} onclick={() => setColumnSort(column.id, 'date-desc')}>
											↓ Newest first
										</button>
										<button class="column-menu-item" class:active-sort={columnSorts[column.id] === 'priority'} onclick={() => setColumnSort(column.id, 'priority')}>
											⚡ Priority
										</button>
										<button class="column-menu-item" class:active-sort={columnSorts[column.id] === 'category'} onclick={() => setColumnSort(column.id, 'category')}>
											🏷 Category
										</button>
										<button class="column-menu-item" class:active-sort={columnSorts[column.id] === 'assignee'} onclick={() => setColumnSort(column.id, 'assignee')}>
											👤 Assignee
										</button>
										{#if columnSorts[column.id] && columnSorts[column.id] !== 'none'}
											<button class="column-menu-item" onclick={() => setColumnSort(column.id, 'none')}>
												✕ Clear sort
											</button>
										{/if}
										{#if canManage}
										<div class="menu-divider"></div>
										<button class="column-menu-item" onclick={() => { const newVal = !(column.showAddCard || column.title.toLowerCase() === 'to do'); updateColumn(column.id, { showAddCard: newVal }); column.showAddCard = newVal; closeDropdowns(); }}>
											{column.showAddCard || column.title.toLowerCase() === 'to do' ? '✓' : '○'} Show Add Task
										</button>
										{#if editingWipColumn === column.id}
											<!-- svelte-ignore a11y_click_events_have_key_events -->
											<!-- svelte-ignore a11y_no_static_element_interactions -->
											<div class="wip-limit-edit" onclick={(e) => e.stopPropagation()}>
												<label class="wip-label">WIP Limit (0 = none)</label>
												<div class="wip-input-row">
													<input type="number" class="wip-input" min="0" max="99" bind:value={wipLimitInput} onkeydown={(e) => e.key === 'Enter' && saveWipLimit(column.id)} autofocus />
													<button class="btn-primary small" onclick={() => saveWipLimit(column.id)}>Set</button>
													<button class="btn-ghost small" onclick={() => (editingWipColumn = null)}>✕</button>
												</div>
											</div>
										{:else}
											<button class="column-menu-item" onclick={() => startEditWipLimit(column)}>
												📊 WIP Limit {column.wipLimit > 0 ? `(${column.wipLimit})` : ''}
											</button>
										{/if}
										<div class="menu-divider"></div>
										<button class="column-menu-item danger" onclick={() => { confirmDeleteColumn(column.id, column.title); closeDropdowns(); }}>
											<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 3.5h8M4.5 3.5V2.5a.5.5 0 01.5-.5h2a.5.5 0 01.5.5v1m1 0l-.4 6a1 1 0 01-1 .9H4.9a1 1 0 01-1-.9l-.4-6" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>
											Delete column
										</button>
										{/if}
									</div>
								{/if}
							</div>
							</div>
						</div>
					</div>



					<div
						class="column-cards"
						use:dndzone={{
							items: column.cards,
							flipDurationMs: FLIP_DURATION_MS,
							type: 'cards',
							dropTargetStyle: { outline: 'none' },
							dropTargetClasses: ['drop-target-active']
						}}
						onconsider={(e) => handleCardDndConsider(column.id, e)}
						onfinalize={(e) => handleCardDndFinalize(column.id, e)}
						ondblclick={(e: MouseEvent) => { if ((column.title.toLowerCase() === 'to do' || column.showAddCard) && !(e.target as HTMLElement).closest('.kanban-card')) openNewCardModal(column.id); }}
					>
						{#if column.cards.length === 0}
							<div class="empty-column-prompt">
								<span class="empty-icon">✨</span>
								<span class="empty-text">No cards yet</span>
								{#if column.title.toLowerCase() === 'to do' || column.showAddCard}
									<span class="empty-hint">Double-click to add one</span>
								{/if}
							</div>
						{/if}
						{#each column.cards as card (card.id)}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<div
								class="kanban-card"
								class:card-completed={isCompleteColumn(column)}
								class:card-on-hold={isOnHoldColumn(column.title)}
								class:card-hidden={!matchesSearch(card, searchQuery, boardCategories) || (filterAssigneeId !== null && !card.assignees?.some(a => a.id === filterAssigneeId))}
								class:card-stale={isStale(card.createdAt) && !isCompleteColumn(column)}
								class:card-selected={selectedCards.has(card.id)}
								class:card-pinned={card.pinned}
								animate:flip={{ duration: FLIP_DURATION_MS }}
								onclick={(e) => inlineEditCardId === card.id ? null : (selectionMode ? toggleSelection(card.id, e) : openCardModal(card))}
								oncontextmenu={(e) => openContextMenu(e, card, column.id)}
								role="button"
								tabindex="0"
								id="card-{card.id}"
							>
								{#if card.pinned}
									<span class="pin-indicator" title="Pinned">📌</span>
								{/if}
								{#if isNew(card.createdAt) && !isCompleteColumn(column)}
									<span class="new-badge">New</span>
								{/if}
								{#if selectionMode}
									<div class="select-checkbox" class:checked={selectedCards.has(card.id)}>
										{#if selectedCards.has(card.id)}✓{/if}
									</div>
								{/if}
								<div class="drag-handle" aria-hidden="true">
									<svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor">
										<circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/>
										<circle cx="2" cy="7" r="1.2"/><circle cx="6" cy="7" r="1.2"/>
										<circle cx="2" cy="12" r="1.2"/><circle cx="6" cy="12" r="1.2"/>
									</svg>
								</div>
									{#if getCategoryById(card.categoryId, boardCategories)?.color}
									<div class="card-color-strip" style="background: {getCategoryById(card.categoryId, boardCategories)?.color}; --strip-color: {getCategoryById(card.categoryId, boardCategories)?.color}"></div>
								{/if}
								{#if inlineEditCardId === card.id}
								<!-- svelte-ignore a11y_autofocus -->
								<input
									class="inline-edit-input"
									bind:value={inlineEditValue}
									onkeydown={(e) => handleInlineKeydown(e, card.id)}
									onblur={() => saveInlineEdit(card.id)}
									onclick={(e) => e.stopPropagation()}
									autofocus
								/>
							{:else}
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<h4 class="card-title" ondblclick={(e) => startInlineEdit(card, e)}>
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<span class="priority-dot priority-{card.priority}" onclick={(e) => cyclePriority(card, e)} title="Priority: {card.priority} (click to cycle)"></span>
									{card.title}
								</h4>
							{/if}
								{#if card.description}
									<p class="card-description">{card.description}</p>
								{/if}
								{#if isOnHoldColumn(column.title) && card.onHoldNote}
									<div class="on-hold-note-badge">
										<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 1v4M5 7v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
										{card.onHoldNote}
									</div>
								{/if}
								<div class="card-meta">
									<span class="priority-badge priority-{card.priority}">
										{getPriorityLabel(card.priority)}
									</span>
									{#if getCategoryById(card.categoryId, boardCategories)}
										{@const cat = getCategoryById(card.categoryId, boardCategories)!}
										<span class="category-badge" style="background: {cat.color}20; color: {cat.color}; border: 1px solid {cat.color}40">
											{cat.name}
										</span>
									{/if}
									{#if subtaskProgress(card)}
										{@const prog = subtaskProgress(card)!}
										{@const pct = prog.done / prog.total}
										<span class="subtask-badge" class:all-done={prog.done === prog.total}>
											<svg class="progress-ring" width="14" height="14" viewBox="0 0 14 14">
												<circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--glass-border)" stroke-width="2"/>
												<circle cx="7" cy="7" r="5.5" fill="none"
													stroke={prog.done === prog.total ? '#22c55e' : '#6366f1'}
													stroke-width="2"
													stroke-dasharray={2 * Math.PI * 5.5}
													stroke-dashoffset={2 * Math.PI * 5.5 * (1 - pct)}
													transform="rotate(-90 7 7)"
													stroke-linecap="round"/>
											</svg>
											{prog.done}/{prog.total}
										</span>
									{/if}
									{#if card.subBoards.length > 0}
										{#each card.subBoards as sb}
											<a href="/board/{sb.id}" class="subboard-badge" class:all-done={sb.total > 0 && sb.done === sb.total} title="{sb.emoji} {sb.name} — {sb.done}/{sb.total} complete" onclick={(e) => e.stopPropagation()}>
												🗂️ {sb.name} {sb.done}/{sb.total}
											</a>
										{/each}
									{/if}
									{#if card.dueDate}
										{@const dueStatus = getDueStatus(card.dueDate)}
										<span class="due-badge" class:due-overdue={dueStatus === 'overdue'} class:due-today={dueStatus === 'today'} class:due-soon={dueStatus === 'soon'} title="Due {new Date(card.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}">
											{#if dueStatus === 'overdue'}⚠️{:else if dueStatus === 'today'}🔥{:else if dueStatus === 'soon'}📅{:else}📅{/if}
											Due {getDueRelative(card.dueDate, tick)}
										</span>
									{/if}
									<span class="card-date" title="Created {parseUTC(card.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}">Created {getRelativeAge(card.createdAt, tick)}</span>
								</div>
								{#if card.labelIds && card.labelIds.length > 0}
									<div class="card-labels">
										{#each card.labelIds as labelId}
										{@const label = getLabelById(labelId, boardLabels)}
											{#if label}
												<span class="label-chip" style="background: {label.color}25; color: {label.color}; border: 1px solid {label.color}40">{label.name}</span>
											{/if}
										{/each}
									</div>
								{/if}
								{#if card.assignees && card.assignees.length > 0}
									<div class="card-assignees">
										{#each card.assignees as assignee}
											<span class="assignee-chip">{assignee.emoji} {assignee.username}</span>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	</div>
</div> <!-- /.board-page -->
<div class="board-panels-area">
{#if showActivityPanel}
	<aside class="board-side-panel">
		<div class="board-side-panel-header">
			<h3>📋 Activity Log</h3>
			<button class="btn-ghost" onclick={() => (showActivityPanel = false)} title="Close">✕</button>
		</div>
		<div class="board-side-panel-body">
			{#if loadingActivities}
				<p class="panel-empty">Loading...</p>
			{:else if activities.length === 0}
				<p class="panel-empty">No activity yet.</p>
			{:else}
				{#each activities as activity}
					<div class="activity-item">
						<span class="activity-emoji">{activity.userEmoji}</span>
						<div class="activity-info">
							<span class="activity-action">{activity.action.replace('api:', '').replace(/_/g, ' ')}</span>
							<span class="activity-detail">{activity.detail}</span>
							<span class="activity-time">{new Date(activity.createdAt + 'Z').toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {activity.userName}</span>
						</div>
					</div>
				{/each}
			{/if}
		</div>
	</aside>
{/if}
{#if showStatsPanel}
	<StatsPanel
		{boardColumns}
		{boardCategories}
		boardId={data.board.id}
		onClose={() => (showStatsPanel = false)}
	/>
{/if}
{#if showArchivePanel}
	<aside class="board-side-panel">
		<div class="board-side-panel-header">
			<h3>🗄️ Archived Cards</h3>
			<button class="btn-ghost" onclick={() => (showArchivePanel = false)} title="Close">✕</button>
		</div>
		<div class="board-side-panel-body">
			{#if loadingArchive}
				<div class="archive-loading">Loading...</div>
			{:else if archivedCards.length === 0}
				<div class="archive-empty">
					<span class="archive-empty-icon">📦</span>
					<p>No archived cards</p>
					<p class="archive-empty-hint">Deleted cards will appear here for recovery</p>
				</div>
			{:else}
				<div class="archive-list">
					{#each archivedCards as card (card.id)}
						<div class="archive-card">
							<div class="archive-card-info">
								<span class="archive-card-title">{card.title}</span>
								{#if card.archivedAt}
									<span class="archive-card-date">Archived {new Date(card.archivedAt + 'Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
								{/if}
							</div>
							<div class="archive-card-actions">
								<button class="btn-ghost small" onclick={() => restoreCard(card.id)} title="Restore">
									↩️ Restore
								</button>
								<button class="btn-ghost small danger" onclick={() => {
									showConfirm('Delete Permanently', `Permanently delete "${card.title}"? This cannot be undone.`, 'Delete Forever', async () => {
										await permanentlyDeleteCard(card.id);
										confirmState.show = false;
									});
								}} title="Delete permanently">
									🗑️
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</aside>
{/if}
</div> <!-- /.board-panels-area -->
</div> <!-- /.board-page-wrapper -->


<!-- Bulk Action Bar -->
{#if selectionMode && selectedCards.size > 0}
	<BulkActionBar
		selectedCount={selectedCards.size}
		columns={boardColumns}
		onMove={handleBulkMove}
		onPriority={handleBulkPriority}
		onDelete={handleBulkDelete}
		onClear={clearSelection}
	/>
{/if}

<!-- Context Menu -->
{#if contextMenu.show && contextMenu.card}
	<ContextMenu
		card={contextMenu.card}
		columnId={contextMenu.columnId}
		x={contextMenu.x}
		y={contextMenu.y}
		columns={boardColumns}
		onClose={closeDropdowns}
		onMove={async (card, targetColId) => {
			const col = boardColumns.find(c => c.id === targetColId);
			if (!col) return;
			const updates = [{ id: card.id, columnId: targetColId, position: col.cards.length }];
			await api.reorderCards(updates, data.board.id, currentUser.name, currentUser.emoji);
			logActivity('card_moved', `${card.title} → ${col.title}`, card.id);
			toasts.add(`Moved to ${col.title}`);
			// WIP limit violation alert
			if (col.wipLimit > 0 && col.cards.length + 1 > col.wipLimit) {
				toasts.add(`⚠ ${col.title} exceeds WIP limit (${col.cards.length + 1}/${col.wipLimit})`, 'warning');
			}
			contextMenu = { ...contextMenu, show: false };
			await invalidateAll();
		}}
		onPriority={async (card, priority) => {
			await api.updateCard(card.id, { priority, boardId: data.board.id });
			toasts.add(`Priority → ${priority}`);
			contextMenu = { ...contextMenu, show: false };
			await invalidateAll();
		}}
		onTogglePin={(card) => togglePin(card)}
		onDuplicate={(card) => duplicateCard(card)}
		onCreateSubBoard={(card) => createSubBoard(card)}
		onDelete={(cardId) => confirmDeleteCard(cardId)}
	/>
{/if}

<Toast />

<!-- Card Modal -->
{#if showCardModal}
	<CardModal
		card={editingCard}
		categories={boardCategories}
		labels={boardLabels}
		boardId={data.board.id}
		boardUsers={data.boardUsers.map(u => ({ ...u, emoji: u.emoji || '👤' }))}
		onSave={saveCard}
		onDelete={editingCard ? () => confirmDeleteCard(editingCard!.id) : undefined}
		onClose={() => { showCardModal = false; editingCard = null; }}
		onCreateSubBoard={editingCard ? (name) => createSubBoard(editingCard!, name) : undefined}
		onDeleteSubBoard={editingCard ? (boardId) => deleteSubBoard(boardId) : undefined}
		onLinkSubBoard={editingCard ? (boardId) => linkSubBoard(editingCard!.id, boardId) : undefined}
		availableBoards={data.linkableBoards.map(b => ({ id: b.id, name: b.name, emoji: b.emoji || '📋' }))}
	/>
{/if}

<!-- Confirm Modal -->
{#if confirmState.show}
	<ConfirmModal
		title={confirmState.title}
		message={confirmState.message}
		confirmText={confirmState.confirmText}
		onConfirm={() => { confirmState.show = false; confirmState.onConfirm(); }}
		onCancel={() => (confirmState.show = false)}
	/>
{/if}

<!-- Blocked by subtasks/sub-board modal -->
{#if blockedState.show}
	<ConfirmModal
		title="Cannot Complete"
		message={blockedState.reason === 'subboard'
			? `This card has ${blockedState.incomplete} incomplete task${blockedState.incomplete > 1 ? 's' : ''} on its sub-board. All sub-board tasks must be completed first.`
			: `This card has ${blockedState.incomplete} incomplete subtask${blockedState.incomplete > 1 ? 's' : ''}. All subtasks must be completed before moving it to the Complete column.`
		}
		confirmText={blockedState.reason === 'subboard' ? 'Open Sub-board' : 'Open Card'}
		confirmDanger={false}
		onConfirm={() => {
			blockedState.show = false;
			if (blockedState.card) {
				if (blockedState.reason === 'subboard' && blockedState.card.subBoards.length > 0) {
					const firstIncomplete = blockedState.card.subBoards.find(sb => sb.done < sb.total);
					if (firstIncomplete) window.location.href = `/board/${firstIncomplete.id}`;
				} else {
					openCardModal(blockedState.card);
				}
			}
		}}
		onCancel={() => (blockedState.show = false)}
	/>
{/if}

<!-- Add Column Modal -->
{#if showAddColumnModal}
	<AddColumnModal
		columns={boardColumns}
		onAdd={({ title, position, color }) => {
			newColumnTitle = title;
			newColumnPosition = position;
			newColumnColor = color;
			addColumn();
		}}
		onClose={() => (showAddColumnModal = false)}
	/>
{/if}

<!-- On Hold Note Modal -->
{#if onHoldState.show}
	<OnHoldModal
		cardTitle={onHoldState.cardTitle}
		bind:note={onHoldState.note}
		onConfirm={confirmOnHold}
		onCancel={cancelOnHold}
	/>
{/if}

<!-- Category Modal -->
{#if showCategoryModal}
	<CategoryModal
		categories={boardCategories}
		onAdd={async ({ name, color }) => {
			await api.createCategory({ boardId: data.board.id, name, color });
			await invalidateAll();
		}}
		onDeleteCategory={async (id) => {
			await api.deleteCategoryApi(id);
			await invalidateAll();
		}}
		onClose={() => (showCategoryModal = false)}
	/>
{/if}

<!-- Fireworks celebration -->
{#if showFireworks}
	<FireworksCelebration
		cardTitle={celebrateCardTitle}
		userName={celebrateUserName}
		userEmoji={celebrateUserEmoji}
		xpGained={celebrateXpGained}
	/>
{/if}

<!-- Share modal -->
{#if showShareModal}
	<ShareModal boardId={data.board.id} boardName={boardName} canManage={data.canManage} onClose={() => { showShareModal = false; invalidateAll(); }} />
{/if}

<style>
	/* Flex wrapper: board + side panels */
	.board-page-wrapper { display: flex; height: 100vh; overflow: hidden; }
	.board-page { height: 100vh; display: flex; flex-direction: column; overflow: hidden; flex: 1; min-width: 0; }
	.board-panels-area { display: flex; flex-shrink: 0; }

	/* Side panels — push content */
	.board-side-panel {
		width: 340px; height: 100vh; flex-shrink: 0;
		background: var(--bg-surface); border-left: 1px solid var(--glass-border);
		display: flex; flex-direction: column;
		animation: panelSlideIn 0.2s ease-out;
	}
	@keyframes panelSlideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
	.board-side-panel-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-md) var(--space-lg); border-bottom: 1px solid var(--glass-border);
		flex-shrink: 0;
	}
	.board-side-panel-header h3 { font-size: 0.9rem; font-weight: 700; margin: 0; }
	.board-side-panel-body { flex: 1; overflow-y: auto; padding: var(--space-md); }

	/* Activity items (inline in board page now) */
	.activity-item {
		display: flex; gap: var(--space-sm); padding: var(--space-sm);
		border-radius: var(--radius-sm); transition: background 0.15s;
	}
	.activity-item:hover { background: var(--glass-bg); }
	.activity-emoji { font-size: 1.2rem; flex-shrink: 0; }
	.activity-info { display: flex; flex-direction: column; min-width: 0; }
	.activity-action { font-weight: 600; font-size: 0.78rem; text-transform: capitalize; }
	.activity-detail { font-size: 0.75rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.activity-time { font-size: 0.65rem; color: var(--text-tertiary); }
	.panel-empty { color: var(--text-tertiary); text-align: center; padding: var(--space-xl); font-size: 0.85rem; }

	.board-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-md) var(--space-xl); border-bottom: 1px solid var(--glass-border);
		flex-shrink: 0; gap: var(--space-md); flex-wrap: wrap;
	}
	.board-header-left { display: flex; align-items: center; gap: var(--space-md); min-width: 0; flex: 1 1 auto; }
	.board-header-right { display: flex; align-items: center; gap: var(--space-sm); flex-shrink: 0; flex-wrap: wrap; }
	.back-btn { padding: var(--space-sm); }

	/* More menu dropdown */
	.more-menu-wrapper { position: relative; }
	.more-menu-trigger { display: flex; align-items: center; gap: 6px; }
	.more-dropdown {
		position: absolute; top: calc(100% + 6px); right: 0;
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg); min-width: 220px;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(255, 255, 255, 0.04);
		z-index: 200; padding: var(--space-xs) 0;
		animation: moreDropdownIn 0.15s ease-out;
		backdrop-filter: blur(12px);
	}
	@keyframes moreDropdownIn {
		from { opacity: 0; transform: translateY(-6px) scale(0.97); }
		to { opacity: 1; transform: translateY(0) scale(1); }
	}
	.more-dropdown-section { padding: var(--space-xs) 0; }
	.more-dropdown-label {
		font-size: 0.62rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.08em; color: var(--text-tertiary);
		padding: var(--space-xs) var(--space-md) 4px;
	}
	.more-dropdown-divider {
		height: 1px; background: var(--glass-border);
		margin: var(--space-xs) var(--space-md);
	}
	.more-dropdown-item {
		display: flex; align-items: center; gap: var(--space-sm);
		width: 100%; padding: 7px var(--space-md);
		border: none; background: transparent;
		color: var(--text-secondary); font-size: 0.82rem; font-weight: 500;
		font-family: var(--font-family); cursor: pointer;
		text-decoration: none; text-align: left;
		transition: all 0.1s ease;
	}
	.more-dropdown-item:hover {
		background: rgba(99, 102, 241, 0.08); color: var(--text-primary);
	}
	.more-dropdown-item.more-active {
		color: var(--accent-indigo); font-weight: 600;
	}
	.more-dropdown-item.more-danger { color: var(--text-tertiary); }
	.more-dropdown-item.more-danger:hover {
		color: var(--accent-rose); background: rgba(244, 63, 94, 0.08);
	}
	.more-item-icon { font-size: 0.9rem; width: 20px; text-align: center; flex-shrink: 0; }
	.more-check {
		margin-left: auto; font-size: 0.75rem; font-weight: 700;
		color: var(--accent-indigo);
	}

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

	.breadcrumb-sep {
		color: var(--text-tertiary);
		font-weight: 300;
		flex-shrink: 0;
	}
	.emoji-picker-wrapper { position: relative; }
	.board-emoji { font-size: 1.5rem; }
	.board-emoji.clickable { cursor: pointer; transition: transform 0.15s; }
	.board-emoji.clickable:hover { transform: scale(1.15); }
	.emoji-dropdown {
		position: absolute; top: 100%; left: 0; z-index: 50;
		display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px;
		padding: var(--space-sm); border-radius: var(--radius-md);
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		box-shadow: 0 8px 24px rgba(0,0,0,0.2); width: 280px;
		animation: panelSlide 0.15s ease-out;
	}
	.emoji-option {
		padding: 4px; font-size: 1.2rem; border-radius: var(--radius-sm);
		background: transparent; border: none; cursor: pointer; transition: all 0.1s;
		display: flex; align-items: center; justify-content: center;
	}
	.emoji-option:hover { background: var(--glass-bg); transform: scale(1.2); }
	.emoji-option.active { background: rgba(99, 102, 241, 0.15); outline: 2px solid var(--accent-indigo); }
	.board-name {
		font-size: 1.25rem; cursor: pointer; padding: 2px var(--space-sm);
		border-radius: var(--radius-sm); transition: background var(--duration-fast) var(--ease-out);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.board-name:hover { background: var(--glass-hover); }
	.board-name-input { font-size: 1.25rem; font-weight: 700; padding: 2px var(--space-sm); background: var(--bg-surface); width: 300px; }
	.board-stats { font-size: 0.8rem; color: var(--text-tertiary); font-weight: 500; white-space: nowrap; }
	.theme-toggle { font-size: 0; }
	.nav-btn {
		display: inline-flex; align-items: center; gap: 4px;
		font-size: 0.78rem !important; font-weight: 600;
		text-decoration: none; color: var(--text-secondary);
	}
	.nav-btn:hover { color: var(--text-primary); }

	/* Search bar */
	.search-wrapper {
		position: relative; display: flex; align-items: center;
		flex: 1; max-width: 280px;
	}
	.search-icon {
		position: absolute; left: 10px; color: var(--text-tertiary);
		pointer-events: none;
	}
	.search-input {
		width: 100%; padding: 6px 30px 6px 32px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-full); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.8rem;
		transition: border-color var(--duration-fast) var(--ease-out);
	}
	.search-input::placeholder { color: var(--text-tertiary); }
	.search-input:focus { outline: none; border-color: var(--accent-indigo); }
	.search-clear {
		position: absolute; right: 6px; padding: 3px !important;
		opacity: 0.5;
	}
	.search-clear:hover { opacity: 1; }
	.assignee-filter {
		padding: 6px 10px; background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-full); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.78rem; cursor: pointer;
		transition: border-color var(--duration-fast) var(--ease-out);
	}
	.assignee-filter:focus { outline: none; border-color: var(--accent-indigo); }

	/* Sort badge */
	.sort-badge {
		display: inline-flex; align-items: center; gap: 3px;
		padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.6rem; font-weight: 600; white-space: nowrap;
		background: rgba(99, 102, 241, 0.12); color: var(--accent-indigo);
		border: 1px solid rgba(99, 102, 241, 0.2);
		cursor: pointer; font-family: var(--font-family);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.sort-badge:hover { background: rgba(99, 102, 241, 0.2); }

	/* Menu label */
	.menu-label {
		font-size: 0.6rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.05em; color: var(--text-tertiary);
		padding: var(--space-xs) var(--space-md);
	}
	.column-menu-item.active-sort {
		color: var(--accent-indigo); font-weight: 600;
	}

	/* Card hidden by search */
	.kanban-card.card-hidden {
		display: none;
	}

	/* XP Bars */
	.xp-bar-container {
		display: flex; gap: var(--space-md); align-items: center;
		flex: 1; justify-content: center; max-width: 500px;
		min-width: 0; overflow-x: auto;
	}
	.xp-entry {
		display: flex; align-items: center; gap: 6px;
		padding: 4px 8px; border-radius: var(--radius-md);
		background: var(--glass-bg); border: 1px solid var(--glass-border);
		min-width: 120px; flex-shrink: 0;
	}
	.xp-avatar { font-size: 1rem; flex-shrink: 0; }
	.xp-info { flex: 1; min-width: 0; }
	.xp-name-row { display: flex; justify-content: space-between; align-items: center; gap: 4px; }
	.xp-name { font-size: 0.65rem; font-weight: 600; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.xp-level {
		font-size: 0.6rem; font-weight: 800; color: var(--accent-amber);
		background: rgba(245, 158, 11, 0.1); padding: 0 4px; border-radius: var(--radius-full);
		white-space: nowrap;
	}
	.xp-track {
		height: 4px; background: var(--bg-base); border-radius: var(--radius-full);
		margin-top: 3px; overflow: hidden;
	}
	.xp-fill {
		height: 100%; border-radius: var(--radius-full);
		background: linear-gradient(90deg, var(--accent-indigo), var(--accent-purple));
		transition: width var(--duration-normal) var(--ease-out);
	}

	.user-badge {
		display: flex; align-items: center; gap: 6px;
		padding: 4px var(--space-sm) 4px 4px; border-radius: var(--radius-full);
		background: var(--glass-bg); border: 1px solid var(--glass-border);
		cursor: pointer; transition: all var(--duration-fast) var(--ease-out);
	}
	.user-badge:hover { background: var(--glass-hover); }
	.user-emoji { font-size: 1.1rem; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; background: var(--bg-base); border-radius: 50%; }
	.user-name { font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); }

	/* Column menu */
	.column-menu-wrapper { position: relative; display: inline-flex; }
	.column-menu-dropdown {
		display: none; position: absolute; top: calc(100% + 4px); right: 0; z-index: 500;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-xs);
		min-width: 150px; box-shadow: var(--shadow-lg);
	}
	.column-menu-wrapper:hover .column-menu-dropdown, .column-menu-dropdown.show { display: block; }
	.column-menu-item {
		display: flex; align-items: center; gap: var(--space-sm); width: 100%;
		padding: var(--space-sm) var(--space-md); border-radius: var(--radius-sm);
		background: transparent; color: var(--text-secondary); font-size: 0.8rem;
		font-weight: 500; text-align: left; font-family: var(--font-family); cursor: pointer;
		border: none; transition: all var(--duration-fast) var(--ease-out);
	}
	.column-menu-item:hover { background: var(--glass-hover); color: var(--text-primary); }
	.column-menu-item.danger { color: var(--accent-rose); }
	.column-menu-item.danger:hover { background: rgba(244, 63, 94, 0.1); }
	.menu-divider { height: 1px; background: var(--glass-border); margin: var(--space-xs) 0; }

	.kanban-container { flex: 1; display: flex; padding: var(--space-lg); overflow: hidden; min-height: 0; }
	.columns-wrapper { display: flex; gap: var(--space-lg); flex: 1; height: 100%; min-height: 0; }

	.kanban-column {
		flex: 1; min-width: 240px; height: 100%; min-height: 0;
		display: flex; flex-direction: column; border-radius: var(--radius-lg);
	}
	.column-header { padding: var(--space-md) var(--space-lg) 0; flex-shrink: 0; display: flex; flex-direction: column; gap: 0; }
	.column-top-bar { height: 3px; margin: 0 calc(-1 * var(--space-lg)); margin-bottom: var(--space-md); opacity: 0.8; border-radius: 0 0 var(--radius-sm) var(--radius-sm); }
	.column-title-row { display: flex; align-items: center; gap: var(--space-xs); }
	.column-title { font-size: 0.9rem; font-weight: 600; cursor: pointer; padding: 2px var(--space-xs); border-radius: var(--radius-sm); transition: background var(--duration-fast) var(--ease-out); white-space: nowrap; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
	.column-title:hover { background: var(--glass-hover); }
	.column-title-input { font-size: 0.9rem; font-weight: 600; padding: 2px var(--space-xs); width: 100%; }
	.column-count {
		font-size: 0.78rem; font-weight: 700; color: var(--text-secondary);
		background: var(--bg-base); padding: 2px 8px;
		border-radius: var(--radius-full); flex-shrink: 0;
		border: 1px solid var(--glass-border);
		min-width: 22px; text-align: center;
	}
	.column-actions { display: flex; align-items: center; gap: 0; opacity: 0; transition: opacity var(--duration-fast) var(--ease-out); flex-shrink: 0; margin-left: auto; margin-bottom: var(--space-xs); }
	.kanban-column:hover .column-actions { opacity: 1; }
	.column-action-btn { padding: 2px !important; }
	.add-card-badge {
		display: flex; align-items: center; gap: 4px;
		padding: 3px 10px 3px 7px; border-radius: var(--radius-full);
		background: var(--accent-indigo); color: white;
		border: none; cursor: pointer; flex-shrink: 0;
		font-size: 0.68rem; font-weight: 600; font-family: var(--font-family);
		transition: all var(--duration-fast) var(--ease-out);
		box-shadow: 0 1px 4px rgba(99, 102, 241, 0.3);
		white-space: nowrap;
	}
	.add-card-badge:hover { transform: scale(1.05); background: var(--accent-purple); box-shadow: 0 2px 8px rgba(99, 102, 241, 0.5); }
	.add-card-badge:active { transform: scale(0.95); }

	.color-picker-wrapper { position: relative; }
	.color-picker-dropdown {
		display: none; position: absolute; top: 100%; right: 0; z-index: 500;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-sm);
		gap: 4px; flex-wrap: wrap; width: 160px; box-shadow: var(--shadow-lg);
	}
	.color-picker-wrapper:hover .color-picker-dropdown, .color-picker-dropdown.show { display: flex; }
	.color-swatch { width: 24px; height: 24px; border-radius: var(--radius-sm); border: 2px solid transparent; cursor: pointer; transition: all var(--duration-fast) var(--ease-out); }
	.color-swatch:hover { transform: scale(1.15); }
	.color-swatch.active { border-color: var(--text-primary); box-shadow: 0 0 8px rgba(255, 255, 255, 0.2); }

	.column-cards { flex: 1; overflow-y: auto; padding: 0 var(--space-md) var(--space-md); min-height: 0; display: flex; flex-direction: column; gap: var(--space-sm); }
	:global(.drop-target-active) { background: rgba(99, 102, 241, 0.05) !important; border-radius: var(--radius-md); }

	.kanban-card {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-md); cursor: pointer;
		transition: all var(--duration-normal) var(--ease-out); position: relative; overflow: hidden;
		flex-shrink: 0;
	}
	.kanban-card:hover { border-color: var(--glass-border); transform: translateY(-1px); box-shadow: var(--shadow-md); }
	.kanban-card.card-completed {
		background: rgba(16, 185, 129, 0.06);
		border-color: rgba(16, 185, 129, 0.15);
	}
	.kanban-card.card-completed:hover {
		border-color: rgba(16, 185, 129, 0.25);
		box-shadow: 0 4px 12px rgba(16, 185, 129, 0.1);
	}
	.kanban-card.card-on-hold {
		background: rgba(239, 68, 68, 0.05);
		border-color: rgba(239, 68, 68, 0.15);
	}
	.kanban-card.card-on-hold:hover {
		border-color: rgba(239, 68, 68, 0.25);
		box-shadow: 0 4px 12px rgba(239, 68, 68, 0.1);
	}
	/* On Hold note badge — still rendered inline in card */
	.on-hold-note-badge {
		display: flex; align-items: flex-start; gap: 4px;
		padding: 4px 8px; margin-bottom: var(--space-sm);
		background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.15);
		border-radius: var(--radius-sm); font-size: 0.7rem; color: var(--accent-rose);
		line-height: 1.4; font-style: italic;
	}
	.on-hold-note-badge svg { flex-shrink: 0; margin-top: 2px; }

	.card-color-strip {
		position: absolute; left: 0; top: 0; bottom: 0; width: 5px;
		border-radius: 5px 0 0 5px;
		box-shadow: 2px 0 8px var(--strip-color, transparent);
	}
	.card-title { font-size: 0.85rem; font-weight: 500; line-height: 1.4; margin-bottom: var(--space-xs); cursor: text; }
	.inline-edit-input {
		width: 100%; font-size: 0.85rem; font-weight: 500; line-height: 1.4;
		margin-bottom: var(--space-xs); padding: 2px 4px; border: 1px solid var(--accent-indigo);
		border-radius: var(--radius-sm); background: var(--bg-base); color: var(--text-primary);
		font-family: var(--font-family); outline: none;
		box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
	}
	.priority-dot {
		display: inline-block; width: 7px; height: 7px; border-radius: 50%;
		margin-right: 4px; vertical-align: middle; cursor: pointer;
		transition: transform 0.15s ease;
	}
	.priority-dot:hover { transform: scale(1.5); }
	.priority-dot.priority-low { background: #94a3b8; }
	.priority-dot.priority-medium { background: #3b82f6; }
	.priority-dot.priority-high { background: #f59e0b; }
	.priority-dot.priority-critical { background: #ef4444; }
	.card-description { font-size: 0.75rem; color: var(--text-tertiary); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: var(--space-sm); }
	.card-meta { display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap; }
	.card-date { font-size: 0.65rem; color: var(--text-secondary); margin-left: auto; flex-shrink: 0; }
	.category-badge { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: var(--radius-full); font-size: 0.68rem; font-weight: 600; }

	/* Drag handle */
	.drag-handle {
		position: absolute; top: 50%; left: 4px; transform: translateY(-50%);
		color: var(--text-tertiary); opacity: 0; transition: opacity 0.15s;
		cursor: grab;
	}
	.kanban-card:hover .drag-handle { opacity: 0.4; }
	.kanban-card:hover .drag-handle:hover { opacity: 0.8; }
	.kanban-card { padding-left: calc(var(--space-md) + 12px); }

	/* Due date badge */
	.due-badge {
		display: inline-flex; align-items: center; gap: 2px;
		font-size: 0.62rem; font-weight: 600; padding: 1px 6px;
		border-radius: var(--radius-full); white-space: nowrap;
		background: rgba(136, 136, 170, 0.08); color: var(--text-secondary);
	}
	.due-badge.due-overdue { background: rgba(239, 68, 68, 0.12); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.25); }
	.due-badge.due-today { background: rgba(245, 158, 11, 0.12); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.25); }
	.due-badge.due-soon { background: rgba(234, 179, 8, 0.08); color: #eab308; border: 1px solid rgba(234, 179, 8, 0.15); }

	/* Stale card */
	.kanban-card.card-stale { border-left: 2px solid rgba(136, 136, 170, 0.3); }

	/* Search count */
	.of-total { opacity: 0.5; font-size: 0.6rem; }

	.subtask-badge {
		display: inline-flex; align-items: center; gap: 3px;
		padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.68rem; font-weight: 600;
		background: rgba(136, 136, 170, 0.1); color: var(--text-secondary);
		border: 1px solid rgba(136, 136, 170, 0.2);
	}
	.subtask-badge.all-done { background: rgba(16, 185, 129, 0.1); color: var(--accent-emerald); border-color: rgba(16, 185, 129, 0.2); }

	.subboard-badge {
		display: inline-flex; align-items: center; gap: 3px;
		padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.68rem; font-weight: 600;
		background: rgba(99, 102, 241, 0.1); color: #818cf8;
		border: 1px solid rgba(99, 102, 241, 0.2);
		text-decoration: none; transition: all var(--duration-fast) var(--ease-out);
	}
	.subboard-badge:hover { background: rgba(99, 102, 241, 0.2); border-color: rgba(99, 102, 241, 0.4); }
	.subboard-badge.all-done { background: rgba(16, 185, 129, 0.1); color: var(--accent-emerald); border-color: rgba(16, 185, 129, 0.2); }

	/* Card labels */
	.card-labels { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; }
	.label-chip { display: inline-flex; align-items: center; padding: 0px 6px; border-radius: var(--radius-full); font-size: 0.58rem; font-weight: 600; white-space: nowrap; }
	.card-assignees { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
	.assignee-chip {
		display: inline-flex; align-items: center; gap: 3px;
		padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.65rem; font-weight: 600; white-space: nowrap;
		background: rgba(99, 102, 241, 0.08); color: var(--accent-indigo);
		border: 1px solid rgba(99, 102, 241, 0.2);
	}

	/* Selection checkbox */
	.select-checkbox {
		position: absolute; top: 6px; right: 6px; width: 18px; height: 18px;
		border: 2px solid var(--glass-border); border-radius: 4px;
		display: flex; align-items: center; justify-content: center;
		font-size: 0.65rem; font-weight: 800; z-index: 2;
		background: var(--bg-surface); color: var(--accent-indigo); transition: all 0.15s;
	}
	.select-checkbox.checked { background: var(--accent-indigo); color: white; border-color: var(--accent-indigo); }
	.kanban-card.card-selected { outline: 2px solid var(--accent-indigo); outline-offset: -2px; }

	/* Active panel button */
	.active-panel-btn { background: rgba(99, 102, 241, 0.12) !important; color: var(--accent-indigo) !important; }

	/* Empty column */
	.empty-column-prompt {
		display: flex; flex-direction: column; align-items: center;
		padding: var(--space-xl) var(--space-md);
		color: var(--text-tertiary); pointer-events: none;
	}
	.empty-icon { font-size: 1.5rem; margin-bottom: var(--space-xs); opacity: 0.5; }
	.empty-text { font-size: 0.78rem; font-weight: 600; }
	.empty-hint { font-size: 0.65rem; opacity: 0.6; }

	/* Pin indicator */
	.pin-indicator { position: absolute; top: 4px; right: 4px; font-size: 0.7rem; z-index: 2; opacity: 0.7; }
	.kanban-card.card-pinned { border-top: 2px solid var(--accent-indigo); }

	/* New badge */
	.new-badge {
		position: absolute; top: 4px; right: 4px; z-index: 2;
		font-size: 0.5rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.06em; padding: 1px 6px;
		border-radius: var(--radius-full);
		background: linear-gradient(135deg, #22c55e, #10b981);
		color: #fff;
		box-shadow: 0 0 8px rgba(34, 197, 94, 0.4);
		animation: newPulse 2s ease-in-out infinite;
	}
	.kanban-card.card-pinned .new-badge { right: 22px; }
	@keyframes newPulse {
		0%, 100% { box-shadow: 0 0 6px rgba(34, 197, 94, 0.3); }
		50% { box-shadow: 0 0 12px rgba(34, 197, 94, 0.6); }
	}

	/* Drag shadow */
	:global(.kanban-card[aria-grabbed="true"]) {
		transform: rotate(2deg) scale(1.03);
		box-shadow: 0 12px 40px rgba(0,0,0,0.3);
		opacity: 0.9;
	}

	/* Progress ring */
	.progress-ring { flex-shrink: 0; transition: stroke-dashoffset 0.3s ease-out; }

	/* ─── WIP Limit Styles ──────────────────────────────────────────────── */
	.wip-warning { box-shadow: inset 0 0 0 2px rgba(245, 158, 11, 0.35); }
	.wip-warning .column-top-bar { animation: wip-pulse 2s ease-in-out infinite; }
	@keyframes wip-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
	.wip-over { color: #f59e0b !important; font-weight: 700; }
	.wip-limit-label { color: var(--text-tertiary); font-weight: 400; }

	.wip-limit-edit { padding: 8px 12px; }
	.wip-label { font-size: 0.72rem; font-weight: 600; color: var(--text-secondary); display: block; margin-bottom: 6px; }
	.wip-input-row { display: flex; align-items: center; gap: 6px; }
	.wip-input {
		width: 60px; padding: 4px 8px; border-radius: var(--radius-sm);
		border: 1px solid var(--glass-border); background: var(--bg-surface);
		color: var(--text-primary); font-size: 0.82rem; text-align: center;
		font-family: var(--font-family);
	}
	.wip-input:focus { outline: none; border-color: var(--accent-indigo); }

	/* ─── Archive Panel Styles ──────────────────────────────────────────── */
	.archive-panel {
		position: fixed; top: 0; right: 0; bottom: 0; width: 360px; z-index: 100;
		background: var(--bg-card); border-left: 1px solid var(--glass-border);
		box-shadow: -4px 0 24px rgba(0,0,0,0.15); display: flex; flex-direction: column;
		animation: slide-in-right 0.2s ease-out;
	}
	@keyframes slide-in-right { from { transform: translateX(100%); } to { transform: translateX(0); } }
	.side-panel-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-lg); border-bottom: 1px solid var(--glass-border); flex-shrink: 0;
	}
	.side-panel-header h3 { font-size: 0.95rem; font-weight: 700; }
	.side-panel-body { flex: 1; overflow-y: auto; padding: var(--space-md); }

	.archive-loading { text-align: center; padding: var(--space-xl); color: var(--text-tertiary); font-size: 0.85rem; }

	.archive-empty { text-align: center; padding: var(--space-xl) var(--space-md); }
	.archive-empty-icon { font-size: 2rem; display: block; margin-bottom: var(--space-sm); }
	.archive-empty p { color: var(--text-secondary); font-size: 0.85rem; margin: 2px 0; }
	.archive-empty-hint { color: var(--text-tertiary); font-size: 0.75rem; }

	.archive-list { display: flex; flex-direction: column; gap: var(--space-sm); }
	.archive-card {
		display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md); border-radius: var(--radius-md);
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.archive-card:hover { border-color: var(--accent-indigo); }
	.archive-card-info { flex: 1; min-width: 0; }
	.archive-card-title { font-size: 0.82rem; font-weight: 600; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.archive-card-date { font-size: 0.68rem; color: var(--text-tertiary); }
	.archive-card-actions { display: flex; gap: 4px; flex-shrink: 0; }
	.archive-card-actions .danger { color: var(--accent-rose); }
	.archive-card-actions .danger:hover { background: rgba(239, 68, 68, 0.1); }

	/* ─── Mobile Responsive ──────────────────────────────────────────────── */

	@media (max-width: 768px) {
		.board-header {
			padding: var(--space-sm) var(--space-md);
			gap: var(--space-sm);
		}
		.board-header-left { gap: var(--space-sm); }
		.board-header-right { gap: var(--space-xs); }
		.board-name { font-size: 1rem; max-width: 180px; }
		.board-stats { display: none; }
		.search-wrapper { max-width: 100%; }
		.xp-bar-container { display: none; }
		.breadcrumb { font-size: 0.7rem; }
		.breadcrumb-link { max-width: 100px; }

		.kanban-container {
			padding: var(--space-sm);
			overflow-x: auto;
			-webkit-overflow-scrolling: touch;
		}
		.columns-wrapper {
			gap: var(--space-md);
			overflow-x: auto;
			scroll-snap-type: x mandatory;
			-webkit-overflow-scrolling: touch;
			padding-bottom: var(--space-md);
		}
		.kanban-column {
			flex: 0 0 85vw;
			min-width: 260px;
			max-width: 85vw;
			scroll-snap-align: start;
		}
		.kanban-card {
			padding: var(--space-md) var(--space-lg) !important;
		}
		.card-title { font-size: 0.9rem; }

		/* Side panels become full-width on mobile */
		.board-page-wrapper { flex-direction: column; }
		.board-side-panel {
			width: 100% !important;
			height: 50vh;
		}

		/* Touch-friendly buttons */
		.btn-ghost, .column-action-btn, .nav-btn {
			min-height: 36px;
			min-width: 36px;
		}
		.more-dropdown-item, .column-menu-item {
			padding: var(--space-md) var(--space-lg) !important;
			min-height: 40px;
		}
	}

	@media (max-width: 480px) {
		.board-header { flex-direction: column; align-items: stretch; }
		.board-header-left { flex-wrap: wrap; }
		.board-header-right { justify-content: flex-end; }
		.kanban-column {
			flex: 0 0 92vw;
			max-width: 92vw;
		}
		.nav-btn span { display: none; }
		.user-name { display: none; }
	}
</style>
