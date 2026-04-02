<script lang="ts">
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { dndzone } from 'svelte-dnd-action';
	import { flip } from 'svelte/animate';
	import { theme } from '$lib/stores/theme';
	import { user, type UserProfile } from '$lib/stores/user';
	import CardModal from '$lib/components/CardModal.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import UserSetup from '$lib/components/UserSetup.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import { toasts } from '$lib/stores/toast';

	let { data }: { data: PageData } = $props();

	type SubtaskType = {
		id: number;
		cardId: number;
		title: string;
		description: string;
		priority: string;
		colorTag: string;
		dueDate: string | null;
		completed: boolean;
		position: number;
	};

	type CategoryType = {
		id: number;
		boardId: number;
		name: string;
		color: string;
	};

	type SubBoardType = {
		id: number;
		name: string;
		emoji: string;
		done: number;
		total: number;
	};

	type CardType = {
		id: number;
		columnId: number;
		categoryId: number | null;
		title: string;
		description: string;
		position: number;
		priority: string;
		colorTag: string;
		dueDate: string | null;
		createdAt: string;
		updatedAt: string;
		subtasks: SubtaskType[];
		labelIds: number[];
		pinned: boolean;
		onHoldNote: string;
		subBoards: SubBoardType[];
	};

	type LabelType = {
		id: number;
		boardId: number;
		name: string;
		color: string;
	};

	type ActivityType = {
		id: number;
		boardId: number;
		cardId: number | null;
		action: string;
		detail: string;
		userName: string;
		userEmoji: string;
		createdAt: string;
	};

	type ColumnType = {
		id: number;
		boardId: number;
		title: string;
		position: number;
		color: string;
		cards: CardType[];
	};

	let boardColumns = $state<ColumnType[]>(data.columns);
	let boardCategories = $state<CategoryType[]>(data.categories);
	let boardLabels = $state<LabelType[]>(data.labels || []);

	// Activity log state
	let showActivityPanel = $state(false);
	let activities = $state<ActivityType[]>([]);
	let loadingActivities = $state(false);

	// Stats panel state
	let showStatsPanel = $state(false);

	// Bulk selection state
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

	async function bulkMove(targetColumnId: number) {
		const updates: { id: number; columnId: number; position: number }[] = [];
		const targetCol = boardColumns.find(c => c.id === targetColumnId);
		if (!targetCol) return;
		let pos = targetCol.cards.length;
		for (const cardId of selectedCards) {
			updates.push({ id: cardId, columnId: targetColumnId, position: pos++ });
		}
		await fetch('/api/cards/reorder', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ updates, boardId: data.board.id, userName: currentUser.name, userEmoji: currentUser.emoji })
		});
		clearSelection();
		await invalidateAll();
	}

	async function bulkDelete() {
		for (const cardId of selectedCards) {
			await fetch(`/api/cards/${cardId}`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ boardId: data.board.id })
			});
		}
		clearSelection();
		await invalidateAll();
	}

	async function bulkPriority(priority: string) {
		for (const cardId of selectedCards) {
			await fetch(`/api/cards/${cardId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ priority, boardId: data.board.id })
			});
		}
		clearSelection();
		await invalidateAll();
	}
	let editingColumn = $state<number | null>(null);
	let editColumnTitle = $state('');

	// Card modal
	let showCardModal = $state(false);
	let editingCard = $state<CardType | null>(null);
	let cardModalColumnId = $state<number | null>(null);

	// Board name editing
	let editingBoardName = $state(false);
	let boardName = $state(data.board.name);
	let boardEmoji = $state(data.board.emoji || '📋');
	let showEmojiPicker = $state(false);

	const commonEmojis = [
		'📋', '🚀', '💡', '🎯', '🔥', '⚡', '🎨', '🛠️',
		'📦', '🏗️', '🧪', '📊', '🎮', '🎵', '📸', '🛒',
		'💼', '🏠', '✈️', '🎓', '💪', '🌟', '🐛', '🔧',
		'📝', '🎉', '🤖', '🧠', '💎', '🌈', '🍕', '☕'
	];

	// Add column modal
	let showAddColumnModal = $state(false);
	let newColumnTitle = $state('');
	let newColumnColor = $state('#6366f1');
	let newColumnPosition = $state('end');

	// Category management
	let showCategoryModal = $state(false);
	let newCategoryName = $state('');
	let newCategoryColor = $state('#6366f1');

	// Confirm modals
	let confirmState = $state<{
		show: boolean;
		title: string;
		message: string;
		confirmText: string;
		onConfirm: () => void;
	}>({ show: false, title: '', message: '', confirmText: '', onConfirm: () => {} });

	// Column dropdown menus (click-based)
	let openDropdown = $state<string | null>(null);
	function toggleDropdown(id: string) {
		openDropdown = openDropdown === id ? null : id;
	}
	function closeDropdowns() {
		openDropdown = null;
		showEmojiPicker = false;
		contextMenu = { ...contextMenu, show: false };
	}

	// Context menu state
	let contextMenu = $state<{ show: boolean; x: number; y: number; card: CardType | null; columnId: number }>({ show: false, x: 0, y: 0, card: null, columnId: 0 });

	function openContextMenu(e: MouseEvent, card: CardType, columnId: number) {
		e.preventDefault();
		e.stopPropagation();
		contextMenu = { show: true, x: e.clientX, y: e.clientY, card, columnId };
	}

	async function duplicateCard(card: CardType) {
		const col = boardColumns.find(c => c.cards.some(cc => cc.id === card.id));
		if (!col) return;
		const maxPos = col.cards.length;
		const res = await fetch('/api/cards', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				columnId: col.id, position: maxPos, boardId: data.board.id,
				title: `${card.title} (Copy)`, description: card.description,
				priority: card.priority, colorTag: card.colorTag,
				categoryId: card.categoryId, dueDate: card.dueDate
			})
		});
		if (res.ok && card.subtasks?.length > 0) {
			const newCard = await res.json();
			for (const st of card.subtasks) {
				await fetch('/api/subtasks', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						cardId: newCard.id, title: st.title, description: st.description,
						priority: st.priority, colorTag: st.colorTag, dueDate: st.dueDate,
						completed: false, boardId: data.board.id
					})
				});
			}
		}
		logActivity('card_created', `${card.title} (Copy)`);
		toasts.add(`Duplicated "${card.title}"`);
		contextMenu = { ...contextMenu, show: false };
		await invalidateAll();
	}

	async function togglePin(card: CardType) {
		const newPinned = !card.pinned;
		await fetch(`/api/cards/${card.id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ pinned: newPinned, boardId: data.board.id })
		});
		card.pinned = newPinned;
		boardColumns = [...boardColumns];
		toasts.add(newPinned ? `Pinned "${card.title}"` : `Unpinned "${card.title}"`);
		contextMenu = { ...contextMenu, show: false };
	}

	async function createSubBoard(card: CardType, name?: string) {
		contextMenu = { ...contextMenu, show: false };
		const res = await fetch('/api/boards', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: name || card.title,
				emoji: '🗂️',
				parentCardId: card.id
			})
		});
		if (res.ok) {
			const board = await res.json();
			window.location.href = `/board/${board.id}`;
		}
	}

	async function linkSubBoard(cardId: number, boardId: number) {
		await fetch(`/api/boards/${boardId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ parentCardId: cardId })
		});
		await invalidateAll();
		toasts.add('Board linked as sub-board');
	}

	function deleteSubBoard(boardId: number) {
		// Find the sub-board name for the confirm message
		let sbName = 'this sub-board';
		for (const col of boardColumns) {
			for (const card of col.cards) {
				const sb = card.subBoards.find(s => s.id === boardId);
				if (sb) { sbName = sb.name; break; }
			}
		}
		showConfirm(
			'Delete Sub-board',
			`Delete "${sbName}" and all its cards? This cannot be undone.`,
			'Delete',
			async () => {
				const res = await fetch(`/api/boards/${boardId}`, { method: 'DELETE' });
				if (res.ok) {
					await invalidateAll();
					// Refresh editingCard from updated data
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

	// Column sort state (per-column, independent)
	type SortOption = 'none' | 'date-asc' | 'date-desc' | 'priority' | 'category';
	let columnSorts = $state<Record<number, SortOption>>({});

	const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

	function setColumnSort(columnId: number, sort: SortOption) {
		columnSorts = { ...columnSorts, [columnId]: sort };
		if (sort !== 'none') {
			const col = boardColumns.find(c => c.id === columnId);
			if (col) {
				col.cards = sortCards([...col.cards], sort);
				boardColumns = [...boardColumns];
			}
		}
		openDropdown = null;
	}

	function sortCards(cards: CardType[], sort: SortOption): CardType[] {
		// Pinned cards always come first
		const pinned = cards.filter(c => c.pinned);
		const unpinned = cards.filter(c => !c.pinned);
		if (sort === 'none' || !sort) return [...pinned, ...unpinned];
		const doSort = (arr: CardType[]) => {
			const sorted = [...arr];
			switch (sort) {
				case 'date-asc':
					sorted.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
					break;
				case 'date-desc':
					sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
					break;
				case 'priority':
					sorted.sort((a, b) => (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9));
					break;
				case 'category':
					sorted.sort((a, b) => {
						const catA = boardCategories.find(c => c.id === a.categoryId)?.name || 'zzz';
						const catB = boardCategories.find(c => c.id === b.categoryId)?.name || 'zzz';
						return catA.localeCompare(catB);
					});
					break;
			}
			return sorted;
		};
		return [...doSort(pinned), ...doSort(unpinned)];
	}

	// Search state
	let searchQuery = $state('');

	function matchesSearch(card: CardType): boolean {
		if (!searchQuery.trim()) return true;
		const q = searchQuery.toLowerCase();
		return (
			card.title.toLowerCase().includes(q) ||
			card.description?.toLowerCase().includes(q) ||
			boardCategories.find(cat => cat.id === card.categoryId)?.name.toLowerCase().includes(q) ||
			false
		);
	}

	function getSortLabel(sort: SortOption): string {
		switch (sort) {
			case 'date-asc': return '↑ Oldest';
			case 'date-desc': return '↓ Newest';
			case 'priority': return '⚡ Priority';
			case 'category': return '🏷 Category';
			default: return '';
		}
	}

	// Subtask blocked modal
	let blockedState = $state<{
		show: boolean;
		card: CardType | null;
		incomplete: number;
		reason: 'subtasks' | 'subboard';
	}>({ show: false, card: null, incomplete: 0, reason: 'subtasks' });

	// On Hold note prompt
	let onHoldState = $state<{
		show: boolean;
		cardId: number;
		cardTitle: string;
		note: string;
		pendingUpdates: any[];
		pendingColumnId: number;
	}>({ show: false, cardId: 0, cardTitle: '', note: '', pendingUpdates: [], pendingColumnId: 0 });

	function isOnHoldColumn(title: string) {
		return title.toLowerCase() === 'on hold';
	}

	const flipDurationMs = 200;
	let currentTheme = $state('dark');
	theme.subscribe((v) => (currentTheme = v));

	// Firework celebration
	let showFireworks = $state(false);
	let celebrateCardTitle = $state('');
	let celebrateUserName = $state('');
	let celebrateUserEmoji = $state('');
	let celebrateXpGained = $state(0);

	// User profile
	let currentUser = $state<UserProfile>({ name: '', emoji: '👤' });
	let showUserSetup = $state(false);
	user.subscribe((v) => (currentUser = v));

	// Live-updating tick for relative timestamps (every 15s)
	let tick = $state(0);
	let tickInterval: ReturnType<typeof setInterval> | null = null;

	onMount(() => {
		if (browser && !currentUser.name) {
			showUserSetup = true;
		}
		fetchXp();
		tickInterval = setInterval(() => { tick++; }, 15000);
	});

	// XP system
	type XpEntry = { name: string; xp: number; emoji: string };
	let xpLeaderboard = $state<XpEntry[]>([]);

	async function fetchXp() {
		try {
			const res = await fetch('/api/xp');
			if (res.ok) xpLeaderboard = await res.json();
		} catch {}
	}

	function getLevel(xp: number) {
		return Math.floor(xp / 500) + 1;
	}

	function getXpForLevel(level: number) {
		return (level - 1) * 500;
	}

	function getXpProgress(xp: number) {
		const level = getLevel(xp);
		const base = getXpForLevel(level);
		return ((xp - base) / 500) * 100;
	}

	const columnColors = [
		'#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
		'#ec4899', '#f43f5e', '#ef4444', '#f97316',
		'#f59e0b', '#eab308', '#84cc16', '#22c55e',
		'#10b981', '#14b8a6', '#06b6d4', '#0ea5e9'
	];

	// SSE for live updates
	let eventSource: EventSource | null = null;

	onMount(() => {
		if (browser) {
			connectSSE();
		}
	});

	onDestroy(() => {
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
		if (tickInterval) clearInterval(tickInterval);
	});

	function connectSSE() {
		eventSource = new EventSource(`/api/boards/${data.board.id}/events`);
		eventSource.addEventListener('update', () => {
			invalidateAll();
		});
		eventSource.addEventListener('celebrate', (e) => {
			try {
				const data = JSON.parse(e.data);
				celebrateCardTitle = data.cardTitle || '';
				celebrateUserName = data.userName || 'Someone';
				celebrateUserEmoji = data.userEmoji || '👤';
				celebrateXpGained = data.xpGained || 0;
			} catch {
				celebrateCardTitle = '';
				celebrateUserName = 'Someone';
				celebrateUserEmoji = '👤';
			}
			showFireworks = true;
			setTimeout(() => (showFireworks = false), 3000);
		});
		eventSource.addEventListener('xp-update', () => {
			fetchXp();
		});
		eventSource.onerror = () => {
			// Reconnect after 3s on error
			if (eventSource) eventSource.close();
			setTimeout(connectSSE, 3000);
		};
	}

	$effect(() => {
		boardColumns = data.columns;
		boardCategories = data.categories;
		boardLabels = data.labels || [];
		boardName = data.board.name;
		boardEmoji = data.board.emoji || '📋';
	});

	// Helpers
	function isCompleteColumn(col: ColumnType) {
		return col.title.toLowerCase() === 'complete';
	}

	function hasIncompleteSubtasks(card: CardType) {
		return card.subtasks && card.subtasks.some((st) => !st.completed);
	}

	function hasIncompleteSubBoard(card: CardType) {
		return card.subBoards && card.subBoards.some(sb => sb.total > 0 && sb.done < sb.total);
	}

	function isCardBlocked(card: CardType) {
		return hasIncompleteSubtasks(card) || hasIncompleteSubBoard(card);
	}

	function incompleteCount(card: CardType) {
		return card.subtasks ? card.subtasks.filter((st) => !st.completed).length : 0;
	}

	function subBoardIncompleteCount(card: CardType) {
		return card.subBoards.reduce((sum, sb) => sum + (sb.total - sb.done), 0);
	}

	// Confirm helper
	function showConfirm(title: string, message: string, confirmText: string, onConfirm: () => void) {
		confirmState = { show: true, title, message, confirmText, onConfirm };
	}

	// Column DnD
	function handleColumnDndConsider(e: CustomEvent) {
		boardColumns = e.detail.items;
	}

	async function handleColumnDndFinalize(e: CustomEvent) {
		boardColumns = e.detail.items;
		const updates = boardColumns.map((col, i) => ({ id: col.id, position: i }));
		await fetch('/api/columns/reorder', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ updates, boardId: data.board.id })
		});
	}

	// Card DnD — with subtask validation for Complete column
	function handleCardDndConsider(columnId: number, e: CustomEvent) {
		const col = boardColumns.find((c) => c.id === columnId);
		if (col) col.cards = e.detail.items;
		boardColumns = [...boardColumns];
	}

	async function handleCardDndFinalize(columnId: number, e: CustomEvent) {
		const targetCol = boardColumns.find((c) => c.id === columnId);
		if (!targetCol) return;

		// Clear sort on manual drag — user is reordering
		if (columnSorts[columnId]) {
			columnSorts = { ...columnSorts, [columnId]: 'none' };
		}

		const newItems: CardType[] = e.detail.items;

		// Check if a card was moved INTO a "Complete" column and has incomplete work
		if (isCompleteColumn(targetCol)) {
			for (const card of newItems) {
				if (card.columnId !== columnId && isCardBlocked(card)) {
					// Determine why it's blocked
					const reason = hasIncompleteSubBoard(card) ? 'subboard' as const : 'subtasks' as const;
					const count = reason === 'subboard' ? subBoardIncompleteCount(card) : incompleteCount(card);
					blockedState = {
						show: true,
						card,
						incomplete: count,
						reason
					};
					await invalidateAll();
					return;
				}
			}
		}

		// Detect if any card moved TO the complete column (for fireworks)
		let movedToComplete = false;
		if (isCompleteColumn(targetCol)) {
			for (const card of newItems) {
				if (card.columnId !== columnId) {
					movedToComplete = true;
				}
			}
		}

		// Detect if a card was moved OUT of an "On Hold" column — purge the note
		if (!isOnHoldColumn(targetCol.title)) {
			for (const card of newItems) {
				if (card.columnId !== columnId) {
					const oldCol = boardColumns.find((c) => c.id === card.columnId);
					if (oldCol && isOnHoldColumn(oldCol.title) && card.onHoldNote) {
						card.onHoldNote = '';
						fetch(`/api/cards/${card.id}`, {
							method: 'PUT',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ onHoldNote: '', boardId: data.board.id })
						});
					}
				}
			}
		}

		// Detect if a card was moved INTO an "On Hold" column
		if (isOnHoldColumn(targetCol.title)) {
			for (const card of newItems) {
				if (card.columnId !== columnId) {
					// Pause and prompt for a note
					const allUpdates: { id: number; columnId: number; position: number }[] = [];
					for (const column of boardColumns) {
						for (let i = 0; i < column.cards.length; i++) {
							allUpdates.push({ id: column.cards[i].id, columnId: column.id, position: i });
						}
					}
					targetCol.cards = newItems;
					boardColumns = [...boardColumns];
					onHoldState = {
						show: true,
						cardId: card.id,
						cardTitle: card.title,
						note: card.onHoldNote || '',
						pendingUpdates: allUpdates,
						pendingColumnId: columnId
					};
					return;
				}
			}
		}

		targetCol.cards = newItems;
		boardColumns = [...boardColumns];

		// Track which cards actually moved columns for activity log
		const movedCards = newItems.filter(card => card.columnId !== columnId);

		const updates: { id: number; columnId: number; position: number }[] = [];
		for (const column of boardColumns) {
			for (let i = 0; i < column.cards.length; i++) {
				updates.push({ id: column.cards[i].id, columnId: column.id, position: i });
			}
		}

		await fetch('/api/cards/reorder', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				updates,
				boardId: data.board.id,
				userName: currentUser.name,
				userEmoji: currentUser.emoji
			})
		});

		// Log activity for each card that moved columns
		for (const card of movedCards) {
			const fromCol = boardColumns.find(c => c.id === card.columnId);
			const fromName = fromCol?.title || '?';
			const toName = targetCol.title;
			if (isCompleteColumn(targetCol)) {
				logActivity('card_completed', `${card.title} (${fromName} → ${toName})`, card.id);
			} else {
				logActivity('card_moved', `${card.title} (${fromName} → ${toName})`, card.id);
			}
		}
	}

	// Add column
	async function confirmOnHold() {
		// Save the on hold note
		await fetch(`/api/cards/${onHoldState.cardId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ onHoldNote: onHoldState.note })
		});
		// Now commit the reorder
		await fetch('/api/cards/reorder', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				updates: onHoldState.pendingUpdates,
				boardId: data.board.id,
				userName: currentUser.name,
				userEmoji: currentUser.emoji
			})
		});
		logActivity('card_moved', `${onHoldState.cardTitle} → On Hold`, onHoldState.cardId);
		onHoldState = { show: false, cardId: 0, cardTitle: '', note: '', pendingUpdates: [], pendingColumnId: 0 };
	}

	async function cancelOnHold() {
		onHoldState = { show: false, cardId: 0, cardTitle: '', note: '', pendingUpdates: [], pendingColumnId: 0 };
		await invalidateAll();
	}

	async function addColumn() {
		let position: number;
		if (newColumnPosition === 'end') {
			position = boardColumns.length > 0 ? Math.max(...boardColumns.map((c) => c.position)) + 1 : 0;
		} else if (newColumnPosition === 'start') {
			position = boardColumns.length > 0 ? Math.min(...boardColumns.map((c) => c.position)) - 1 : 0;
		} else {
			const afterId = Number(newColumnPosition.replace('after-', ''));
			const afterCol = boardColumns.find((c) => c.id === afterId);
			const afterIdx = boardColumns.indexOf(afterCol!);
			if (afterIdx < boardColumns.length - 1) {
				position = (afterCol!.position + boardColumns[afterIdx + 1].position) / 2;
			} else {
				position = afterCol!.position + 1;
			}
		}

		await fetch('/api/columns', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				boardId: data.board.id,
				title: newColumnTitle.trim() || 'New Column',
				position,
				color: newColumnColor
			})
		});
		showAddColumnModal = false;
		newColumnTitle = '';
		newColumnPosition = 'end';
		await invalidateAll();
	}

	// Update column
	async function updateColumn(colId: number, updates: Record<string, unknown>) {
		await fetch(`/api/columns/${colId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...updates, boardId: data.board.id })
		});
	}

	function confirmDeleteColumn(colId: number, colTitle: string) {
		showConfirm(
			'Delete Column',
			`Are you sure you want to delete "${colTitle}" and all its cards? This cannot be undone.`,
			'Delete Column',
			async () => {
				await fetch(`/api/columns/${colId}`, {
					method: 'DELETE',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ boardId: data.board.id })
				});
				confirmState.show = false;
				await invalidateAll();
			}
		);
	}

	function startEditColumn(col: ColumnType) {
		editingColumn = col.id;
		editColumnTitle = col.title;
	}

	async function finishEditColumn(colId: number) {
		if (editColumnTitle.trim()) {
			await updateColumn(colId, { title: editColumnTitle.trim() });
			const col = boardColumns.find((c) => c.id === colId);
			if (col) col.title = editColumnTitle.trim();
		}
		editingColumn = null;
	}

	// Card modal
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

	async function saveCard(cardData: { title: string; description: string; priority: string; colorTag: string; categoryId: number | null; dueDate: string | null; onHoldNote?: string; pendingSubtasks?: string[] }) {
		const { pendingSubtasks, ...rest } = cardData;
		if (editingCard) {
			await fetch(`/api/cards/${editingCard.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...rest, boardId: data.board.id })
			});
		} else if (cardModalColumnId) {
			const col = boardColumns.find((c) => c.id === cardModalColumnId);
			const maxPos = col && col.cards.length > 0 ? Math.max(...col.cards.map((c) => c.position)) + 1 : 0;
			const res = await fetch('/api/cards', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					columnId: cardModalColumnId,
					position: maxPos,
					boardId: data.board.id,
					...rest
				})
			});
			// Create pending subtasks for the new card
			if (res.ok && pendingSubtasks && pendingSubtasks.length > 0) {
				const newCard = await res.json();
				for (let i = 0; i < pendingSubtasks.length; i++) {
					const stData = JSON.parse(pendingSubtasks[i]);
					await fetch('/api/subtasks', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							cardId: newCard.id,
							title: stData.title,
							description: stData.description || '',
							priority: stData.priority || 'medium',
							colorTag: stData.colorTag || '',
							dueDate: stData.dueDate || null,
							completed: false,
							boardId: data.board.id
						})
					});
				}
			}
		}
		showCardModal = false;
		if (!editingCard && cardData.title) {
			logActivity('card_created', cardData.title);
			toasts.add(`Created "${cardData.title}"`);
		} else if (editingCard) {
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
				await fetch(`/api/cards/${cardId}`, {
					method: 'DELETE',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ boardId: data.board.id })
				});
				if (card) logActivity('card_deleted', card.title, cardId);
				toasts.add('Card deleted', 'info');
				confirmState.show = false;
				showCardModal = false;
				editingCard = null;
				await invalidateAll();
			}
		);
	}

	// Board name
	async function saveBoardName() {
		if (boardName.trim()) {
			await fetch(`/api/boards/${data.board.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: boardName.trim() })
			});
		}
		editingBoardName = false;
	}

	async function saveBoardEmoji(emoji: string) {
		boardEmoji = emoji;
		showEmojiPicker = false;
		await fetch(`/api/boards/${data.board.id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ emoji })
		});
	}

	// Categories
	async function addCategory() {
		if (!newCategoryName.trim()) return;
		await fetch('/api/categories', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				boardId: data.board.id,
				name: newCategoryName.trim(),
				color: newCategoryColor
			})
		});
		newCategoryName = '';
		newCategoryColor = '#6366f1';
		await invalidateAll();
	}

	async function deleteCategory(id: number) {
		await fetch(`/api/categories/${id}`, { method: 'DELETE' });
		await invalidateAll();
	}

	function getCategoryById(id: number | null) {
		if (!id) return null;
		return boardCategories.find((c) => c.id === id) || null;
	}

	function getPriorityLabel(priority: string) {
		const labels: Record<string, string> = {
			critical: '🔴 Critical',
			high: '🟠 High',
			medium: '🟡 Medium',
			low: '🟢 Low'
		};
		return labels[priority] || priority;
	}

	function subtaskProgress(card: CardType) {
		if (!card.subtasks || card.subtasks.length === 0) return null;
		const done = card.subtasks.filter((st) => st.completed).length;
		return { done, total: card.subtasks.length };
	}

	// SQLite datetime('now') stores UTC without a Z suffix.
	// Without the Z, JavaScript interprets it as local time — off by the timezone offset.
	function parseUTC(dateStr: string): Date {
		if (!dateStr) return new Date();
		// If it already has timezone info (Z or +/-), parse as-is
		if (/[Zz]|[+-]\d{2}:\d{2}$/.test(dateStr)) return new Date(dateStr);
		// Otherwise it's a bare SQLite UTC timestamp — append Z
		return new Date(dateStr + 'Z');
	}

	// Due date status for color coding
	function getDueStatus(card: CardType): 'overdue' | 'today' | 'soon' | null {
		if (!card.dueDate) return null;
		const due = new Date(card.dueDate);
		const now = new Date();
		now.setHours(0, 0, 0, 0);
		due.setHours(0, 0, 0, 0);
		const diff = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
		if (diff < 0) return 'overdue';
		if (diff === 0) return 'today';
		if (diff <= 2) return 'soon';
		return null;
	}

	// Relative time until/since due date
	function getDueRelative(dueDate: string): string {
		void tick;
		const due = new Date(dueDate);
		const now = new Date();
		now.setHours(0, 0, 0, 0);
		due.setHours(0, 0, 0, 0);
		const diffDays = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
		if (diffDays === 0) return 'today';
		if (diffDays === 1) return 'tomorrow';
		if (diffDays === -1) return '1d overdue';
		if (diffDays < -1) return `${Math.abs(diffDays)}d overdue`;
		if (diffDays < 7) return `in ${diffDays}d`;
		if (diffDays < 30) return `in ${Math.floor(diffDays / 7)}w`;
		return `in ${Math.floor(diffDays / 30)}mo`;
	}

	// Relative age string (reads `tick` to stay reactive)
	function getRelativeAge(dateStr: string): string {
		void tick; // reactive dependency — forces re-evaluation every 15s
		const now = Date.now();
		const created = parseUTC(dateStr).getTime();
		const secs = Math.floor((now - created) / 1000);
		if (secs < 30) return 'just now';
		if (secs < 60) return `${secs}s`;
		const mins = Math.floor(secs / 60);
		if (mins < 60) return `${mins}m`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h`;
		const days = Math.floor(hrs / 24);
		if (days < 7) return `${days}d`;
		const weeks = Math.floor(days / 7);
		if (weeks < 4) return `${weeks}w`;
		const months = Math.floor(days / 30);
		return `${months}mo`;
	}

	function isStale(dateStr: string): boolean {
		const days = Math.floor((Date.now() - parseUTC(dateStr).getTime()) / (1000 * 60 * 60 * 24));
		return days >= 7;
	}

	// Visible card count for search filtering
	function getVisibleCount(column: ColumnType): number {
		if (!searchQuery.trim()) return column.cards.length;
		return column.cards.filter(c => matchesSearch(c)).length;
	}

	// Activity log helpers
	function logActivity(action: string, detail: string, cardId?: number) {
		fetch('/api/activity', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				boardId: data.board.id, cardId: cardId || null,
				action, detail,
				userName: currentUser.name, userEmoji: currentUser.emoji
			})
		});
	}

	async function loadActivities() {
		loadingActivities = true;
		const res = await fetch(`/api/activity?boardId=${data.board.id}`);
		if (res.ok) activities = await res.json();
		loadingActivities = false;
	}

	async function toggleActivityPanel() {
		showActivityPanel = !showActivityPanel;
		showStatsPanel = false;
		if (showActivityPanel) await loadActivities();
	}

	function toggleStatsPanel() {
		showStatsPanel = !showStatsPanel;
		showActivityPanel = false;
	}

	function getActionLabel(action: string): string {
		const map: Record<string, string> = {
			card_created: '➕ Created',
			card_moved: '📦 Moved',
			card_completed: '✅ Completed',
			card_deleted: '🗑️ Deleted',
			subtask_completed: '☑️ Subtask done'
		};
		return map[action] || action;
	}

	function getLabelById(id: number): LabelType | null {
		return boardLabels.find(l => l.id === id) || null;
	}

	// Stats derived values
	const allCards = $derived(boardColumns.flatMap(c => c.cards));
	const totalCards = $derived(allCards.length);
	const completedCards = $derived(boardColumns.filter(c => c.title.toLowerCase() === 'complete' || c.title.toLowerCase() === 'done').flatMap(c => c.cards).length);
	const overdueCards = $derived(allCards.filter(c => getDueStatus(c) === 'overdue').length);
	const avgAge = $derived(() => {
		if (allCards.length === 0) return '0d';
		const totalDays = allCards.reduce((sum, c) => sum + Math.floor((Date.now() - new Date(c.createdAt).getTime()) / 86400000), 0);
		return `${Math.round(totalDays / allCards.length)}d`;
	});
</script>

<svelte:head>
	<title>{boardEmoji} {boardName} — DumpFire</title>
</svelte:head>

<svelte:window onclick={closeDropdowns} />

<div class="board-page">
	<header class="board-header">
		<div class="board-header-left">
			{#if data.breadcrumbs && data.breadcrumbs.length > 0}
				<nav class="breadcrumbs">
					<a href="/" class="breadcrumb-link" title="Dashboard">🔥</a>
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
						{#each commonEmojis as emoji}
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

		<div class="board-header-right">
			<span class="board-stats">
				{boardColumns.length} columns · {boardColumns.reduce((sum, col) => sum + col.cards.length, 0)} cards
			</span>

			<button class="btn-ghost" class:active-panel-btn={showActivityPanel} onclick={toggleActivityPanel} title="Activity log">
				📋
			</button>
			<button class="btn-ghost" class:active-panel-btn={showStatsPanel} onclick={toggleStatsPanel} title="Board statistics">
				📊
			</button>
			{#if data.breadcrumbs && data.breadcrumbs.length > 0}
				<button class="btn-ghost btn-delete-subboard" onclick={() => {
					showConfirm('Delete Sub-board', `Delete "${boardName}" and all its cards? This cannot be undone.`, 'Delete', async () => {
						const parentHref = data.breadcrumbs[data.breadcrumbs.length - 1]?.href || '/';
						await fetch(`/api/boards/${data.board.id}`, { method: 'DELETE' });
						window.location.href = parentHref;
					});
				}} title="Delete this sub-board">
					🗑️
				</button>
			{/if}
			<button class="btn-ghost" class:active-panel-btn={selectionMode} onclick={() => { selectionMode = !selectionMode; if (!selectionMode) clearSelection(); }} title="Bulk select">
				☑️
			</button>

			<button class="btn-ghost" onclick={() => (showCategoryModal = true)} title="Manage categories">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<path d="M2 3h4l2 2h6v8H2V3z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
				Categories
			</button>
			<button class="btn-ghost" onclick={() => (showAddColumnModal = true)} title="Add column">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/>
					<path d="M8 5v6M5 8h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
				</svg>
				Add Column
			</button>
			<button class="theme-toggle btn-ghost" onclick={() => theme.toggle()} title="Toggle theme">
				{#if currentTheme === 'dark'}
					<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
						<circle cx="9" cy="9" r="4" stroke="currentColor" stroke-width="1.5"/>
						<path d="M9 1v2M9 15v2M1 9h2M15 9h2M3.3 3.3l1.4 1.4M13.3 13.3l1.4 1.4M3.3 14.7l1.4-1.4M13.3 4.7l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
					</svg>
				{:else}
					<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
						<path d="M15.5 10.1A6.5 6.5 0 017.9 2.5 7 7 0 1015.5 10.1z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				{/if}
			</button>
			{#if currentUser.name}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<div class="user-badge" onclick={() => (showUserSetup = true)} role="button" tabindex="0" title="Change profile">
					<span class="user-emoji">{currentUser.emoji}</span>
					<span class="user-name">{currentUser.name}</span>
				</div>
			{/if}
		</div>
	</header>

	<!-- Kanban columns -->
	<div class="kanban-container">
		<div
			class="columns-wrapper"
			use:dndzone={{
				items: boardColumns,
				flipDurationMs,
				type: 'columns',
				dropTargetStyle: { outline: '2px solid rgba(99, 102, 241, 0.4)', borderRadius: '14px' }
			}}
			onconsider={handleColumnDndConsider}
			onfinalize={handleColumnDndFinalize}
		>
			{#each boardColumns as column (column.id)}
				<div class="kanban-column glass" animate:flip={{ duration: flipDurationMs }}>
					<div class="column-header">
						<div class="column-top-bar" style="background: {column.color}"></div>
						<div class="column-title-row">
							{#if editingColumn === column.id}
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
								<h3 class="column-title" onclick={() => startEditColumn(column)} role="button" tabindex="0">
									{column.title}
								</h3>
							{/if}
							<span class="column-count">{#if searchQuery.trim()}{getVisibleCount(column)}<span class="of-total">/{column.cards.length}</span>{:else}{column.cards.length}{/if}</span>
							{#if columnSorts[column.id] && columnSorts[column.id] !== 'none'}
								<button class="sort-badge" onclick={() => setColumnSort(column.id, 'none')} title="Clear sort">
									{getSortLabel(columnSorts[column.id])} ✕
								</button>
							{/if}
							<button class="add-card-badge" onclick={() => openNewCardModal(column.id)} title="Add task">
								<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
								Add Task
							</button>
							<div class="column-actions">
							<div class="color-picker-wrapper">
								<button class="btn-ghost column-action-btn" title="Change color" onclick={(e) => { e.stopPropagation(); toggleDropdown(`color-${column.id}`); }}>
									<span class="color-dot" style="background: {column.color}"></span>
								</button>
								{#if openDropdown === `color-${column.id}`}
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div class="color-picker-dropdown show" onclick={(e) => e.stopPropagation()}>
										{#each columnColors as color}
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
										{#if columnSorts[column.id] && columnSorts[column.id] !== 'none'}
											<button class="column-menu-item" onclick={() => setColumnSort(column.id, 'none')}>
												✕ Clear sort
											</button>
										{/if}
										<div class="menu-divider"></div>
										<button class="column-menu-item danger" onclick={() => { confirmDeleteColumn(column.id, column.title); closeDropdowns(); }}>
											<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 3.5h8M4.5 3.5V2.5a.5.5 0 01.5-.5h2a.5.5 0 01.5.5v1m1 0l-.4 6a1 1 0 01-1 .9H4.9a1 1 0 01-1-.9l-.4-6" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>
											Delete column
										</button>
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
							flipDurationMs,
							type: 'cards',
							dropTargetStyle: { outline: 'none' },
							dropTargetClasses: ['drop-target-active']
						}}
						onconsider={(e) => handleCardDndConsider(column.id, e)}
						onfinalize={(e) => handleCardDndFinalize(column.id, e)}
						ondblclick={(e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.kanban-card')) openNewCardModal(column.id); }}
					>
						{#if column.cards.length === 0}
							<div class="empty-column-prompt">
								<span class="empty-icon">✨</span>
								<span class="empty-text">No cards yet</span>
								<span class="empty-hint">Double-click to add one</span>
							</div>
						{/if}
						{#each column.cards as card (card.id)}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<div
								class="kanban-card"
								class:card-completed={isCompleteColumn(column)}
								class:card-on-hold={isOnHoldColumn(column.title)}
								class:card-hidden={!matchesSearch(card)}
								class:card-stale={isStale(card.createdAt) && !isCompleteColumn(column)}
								class:card-selected={selectedCards.has(card.id)}
								class:card-pinned={card.pinned}
								animate:flip={{ duration: flipDurationMs }}
								onclick={(e) => selectionMode ? toggleSelection(card.id, e) : openCardModal(card)}
								oncontextmenu={(e) => openContextMenu(e, card, column.id)}
								role="button"
								tabindex="0"
								id="card-{card.id}"
							>
								{#if card.pinned}
									<span class="pin-indicator" title="Pinned">📌</span>
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
									{#if getCategoryById(card.categoryId)?.color}
									<div class="card-color-strip" style="background: {getCategoryById(card.categoryId)?.color}; --strip-color: {getCategoryById(card.categoryId)?.color}"></div>
								{/if}
								<h4 class="card-title">{card.title}</h4>
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
									{#if getCategoryById(card.categoryId)}
										{@const cat = getCategoryById(card.categoryId)!}
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
										{@const dueStatus = getDueStatus(card)}
										<span class="due-badge" class:due-overdue={dueStatus === 'overdue'} class:due-today={dueStatus === 'today'} class:due-soon={dueStatus === 'soon'} title="Due {new Date(card.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}">
											{#if dueStatus === 'overdue'}⚠️{:else if dueStatus === 'today'}🔥{:else if dueStatus === 'soon'}📅{:else}📅{/if}
											Due {getDueRelative(card.dueDate)}
										</span>
									{/if}
									<span class="card-date" title="Created {parseUTC(card.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}">Created {getRelativeAge(card.createdAt)}</span>
								</div>
								{#if card.labelIds && card.labelIds.length > 0}
									<div class="card-labels">
										{#each card.labelIds as labelId}
											{@const label = getLabelById(labelId)}
											{#if label}
												<span class="label-chip" style="background: {label.color}25; color: {label.color}; border: 1px solid {label.color}40">{label.name}</span>
											{/if}
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
</div>

<!-- Activity Panel -->
{#if showActivityPanel}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="panel-overlay" onclick={() => (showActivityPanel = false)}></div>
	<aside class="side-panel glass">
		<div class="panel-header">
			<h3>📋 Activity Log</h3>
			<button class="btn-ghost close-btn" onclick={() => (showActivityPanel = false)}>✕</button>
		</div>
		<div class="panel-body">
			{#if loadingActivities}
				<p class="panel-empty">Loading...</p>
			{:else if activities.length === 0}
				<p class="panel-empty">No activity yet.</p>
			{:else}
				{#each activities as activity}
					<div class="activity-item">
						<span class="activity-emoji">{activity.userEmoji}</span>
						<div class="activity-info">
							<span class="activity-action">{getActionLabel(activity.action)}</span>
							<span class="activity-detail">{activity.detail}</span>
							<span class="activity-time">{getRelativeAge(activity.createdAt)} · {activity.userName}</span>
						</div>
					</div>
				{/each}
			{/if}
		</div>
	</aside>
{/if}

<!-- Stats Panel -->
{#if showStatsPanel}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="panel-overlay" onclick={() => (showStatsPanel = false)}></div>
	<aside class="side-panel glass">
		<div class="panel-header">
			<h3>📊 Board Stats</h3>
			<button class="btn-ghost close-btn" onclick={() => (showStatsPanel = false)}>✕</button>
		</div>
		<div class="panel-body">
			<div class="stats-grid">
				<div class="stat-card">
					<span class="stat-value">{totalCards}</span>
					<span class="stat-label">Total Cards</span>
				</div>
				<div class="stat-card">
					<span class="stat-value">{completedCards}</span>
					<span class="stat-label">Completed</span>
				</div>
				<div class="stat-card">
					<span class="stat-value">{overdueCards}</span>
					<span class="stat-label">Overdue</span>
				</div>
				<div class="stat-card">
					<span class="stat-value">{avgAge()}</span>
					<span class="stat-label">Avg Age</span>
				</div>
			</div>

			<h4 class="stats-section-title">Cards per Column</h4>
			<div class="stats-bars">
				{#each boardColumns as col}
					{@const pct = totalCards > 0 ? (col.cards.length / totalCards) * 100 : 0}
					<div class="stats-bar-row">
						<span class="stats-bar-label">{col.title}</span>
						<div class="stats-bar-track">
							<div class="stats-bar-fill" style="width: {pct}%; background: {col.color}"></div>
						</div>
						<span class="stats-bar-count">{col.cards.length}</span>
					</div>
				{/each}
			</div>

			{#if boardCategories.length > 0}
				<h4 class="stats-section-title">By Category</h4>
				<div class="stats-bars">
					{#each boardCategories as cat}
						{@const count = allCards.filter(c => c.categoryId === cat.id).length}
						{@const pct = totalCards > 0 ? (count / totalCards) * 100 : 0}
						<div class="stats-bar-row">
							<span class="stats-bar-label" style="color: {cat.color}">{cat.name}</span>
							<div class="stats-bar-track">
								<div class="stats-bar-fill" style="width: {pct}%; background: {cat.color}"></div>
							</div>
							<span class="stats-bar-count">{count}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</aside>
{/if}

<!-- Bulk Action Bar -->
{#if selectionMode && selectedCards.size > 0}
	<div class="bulk-bar glass">
		<span class="bulk-count">{selectedCards.size} selected</span>
		<div class="bulk-actions">
			<div class="bulk-group">
				<span class="bulk-label">Move to:</span>
				{#each boardColumns as col}
					<button class="btn-ghost bulk-btn" onclick={() => bulkMove(col.id)}>{col.title}</button>
				{/each}
			</div>
			<div class="bulk-divider"></div>
			<div class="bulk-group">
				<span class="bulk-label">Priority:</span>
				<button class="btn-ghost bulk-btn" onclick={() => bulkPriority('critical')}>🔴</button>
				<button class="btn-ghost bulk-btn" onclick={() => bulkPriority('high')}>🟠</button>
				<button class="btn-ghost bulk-btn" onclick={() => bulkPriority('medium')}>🟡</button>
				<button class="btn-ghost bulk-btn" onclick={() => bulkPriority('low')}>🟢</button>
			</div>
			<div class="bulk-divider"></div>
			<button class="btn-ghost bulk-btn bulk-danger" onclick={bulkDelete}>🗑️ Delete</button>
		</div>
		<button class="btn-ghost" onclick={clearSelection}>✕</button>
	</div>
{/if}

<!-- Context Menu -->
{#if contextMenu.show && contextMenu.card}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="ctx-overlay" onclick={closeDropdowns}></div>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="ctx-menu glass" style="left: {contextMenu.x}px; top: {contextMenu.y}px" onclick={(e) => e.stopPropagation()}>
		<div class="ctx-section">
			<span class="ctx-label">Move to</span>
			{#each boardColumns as col}
				{#if col.id !== contextMenu.columnId}
					<button class="ctx-item" onclick={async () => {
						const card = contextMenu.card!;
						const updates = [{ id: card.id, columnId: col.id, position: col.cards.length }];
						await fetch('/api/cards/reorder', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updates, boardId: data.board.id, userName: currentUser.name, userEmoji: currentUser.emoji }) });
						logActivity('card_moved', `${card.title} → ${col.title}`, card.id);
						toasts.add(`Moved to ${col.title}`);
						contextMenu = { ...contextMenu, show: false };
						await invalidateAll();
					}}>
						<span class="ctx-dot" style="background: {col.color}"></span> {col.title}
					</button>
				{/if}
			{/each}
		</div>
		<div class="ctx-divider"></div>
		<div class="ctx-section">
			<span class="ctx-label">Priority</span>
			<div class="ctx-row">
				{#each [['critical', '🔴'], ['high', '🟠'], ['medium', '🟡'], ['low', '🟢']] as [p, emoji]}
					<button class="ctx-item ctx-priority" onclick={async () => {
						await fetch(`/api/cards/${contextMenu.card!.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ priority: p, boardId: data.board.id }) });
						toasts.add(`Priority → ${p}`);
						contextMenu = { ...contextMenu, show: false };
						await invalidateAll();
					}}>{emoji}</button>
				{/each}
			</div>
		</div>
		<div class="ctx-divider"></div>
		<button class="ctx-item" onclick={() => togglePin(contextMenu.card!)}>
			{contextMenu.card.pinned ? '📌 Unpin' : '📌 Pin to top'}
		</button>
		<button class="ctx-item" onclick={() => duplicateCard(contextMenu.card!)}>📋 Duplicate</button>
		<button class="ctx-item" onclick={() => createSubBoard(contextMenu.card!)}>🗂️ Add Sub-board</button>
		{#if contextMenu.card.subBoards.length > 0}
			{#each contextMenu.card.subBoards as sb}
				<button class="ctx-item" onclick={() => { window.location.href = `/board/${sb.id}`; }}>→ {sb.emoji} {sb.name}</button>
			{/each}
		{/if}
		<div class="ctx-divider"></div>
		<button class="ctx-item ctx-danger" onclick={() => { confirmDeleteCard(contextMenu.card!.id); contextMenu = { ...contextMenu, show: false }; }}>🗑️ Delete</button>
	</div>
{/if}

<Toast />

<!-- Card Modal -->
{#if showCardModal}
	<CardModal
		card={editingCard}
		categories={boardCategories}
		labels={boardLabels}
		boardId={data.board.id}
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
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-overlay" onclick={() => (showAddColumnModal = false)} role="dialog" aria-modal="true">
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="modal-content" onclick={(e) => e.stopPropagation()} role="document">
			<h2>Add Column</h2>
			<div class="form-group">
				<label for="col-name">Column name</label>
				<input id="col-name" type="text" placeholder="e.g. Review, Testing..." bind:value={newColumnTitle} onkeydown={(e) => e.key === 'Enter' && addColumn()} autofocus />
			</div>
			<div class="form-group">
				<label>Position</label>
				<select bind:value={newColumnPosition}>
					<option value="start">At the start</option>
					{#each boardColumns as col}
						<option value="after-{col.id}">After "{col.title}"</option>
					{/each}
					<option value="end">At the end</option>
				</select>
			</div>
			<div class="form-group">
				<label>Color</label>
				<div class="color-row">
					{#each columnColors as color}
						<button class="color-swatch" class:active={newColumnColor === color} style="background: {color}" onclick={() => (newColumnColor = color)}></button>
					{/each}
					<label class="color-custom-wrapper">
						<input type="color" bind:value={newColumnColor} class="color-native-input" />
						<span class="color-swatch custom" style="background: {newColumnColor}">✎</span>
					</label>
				</div>
			</div>
			<div class="modal-actions">
				<button class="btn-ghost" onclick={() => (showAddColumnModal = false)}>Cancel</button>
				<button class="btn-primary" onclick={addColumn}>Add Column</button>
			</div>
		</div>
	</div>
{/if}

<!-- On Hold Note Modal -->
{#if onHoldState.show}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-overlay" onclick={cancelOnHold} role="dialog" aria-modal="true">
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="modal-content on-hold-modal" onclick={(e) => e.stopPropagation()} role="document">
			<div class="on-hold-header">
				<span class="on-hold-icon">⏸️</span>
				<h2>Put on Hold</h2>
				<p class="on-hold-task-name">"{onHoldState.cardTitle}"</p>
			</div>
			<div class="form-group">
				<label for="hold-note">Why is this on hold? What are you waiting for?</label>
				<textarea
					id="hold-note"
					rows="4"
					placeholder="e.g. Waiting for design approval, blocked by API changes..."
					bind:value={onHoldState.note}
					autofocus
				></textarea>
			</div>
			<div class="modal-actions">
				<button class="btn-ghost" onclick={cancelOnHold}>Cancel</button>
				<button class="btn-primary on-hold-confirm" onclick={confirmOnHold}>
					⏸️ Put on Hold
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Category Modal -->
{#if showCategoryModal}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-overlay" onclick={() => (showCategoryModal = false)} role="dialog" aria-modal="true">
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="modal-content" onclick={(e) => e.stopPropagation()} role="document">
			<h2>Manage Categories</h2>
			<p class="modal-subtitle">Categories help organise your cards across the board.</p>
			<div class="category-list">
				{#each boardCategories as cat (cat.id)}
					<span class="category-chip" style="background: {cat.color}15; color: {cat.color}; border: 1px solid {cat.color}35">
						{cat.name}
						<button class="chip-delete" onclick={() => deleteCategory(cat.id)} title="Delete" style="color: {cat.color}">
							<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
						</button>
					</span>
				{:else}
					<p class="empty-cats">No categories yet. Add one below.</p>
				{/each}
			</div>
			<div class="add-category-row">
				<input type="text" placeholder="Category name..." bind:value={newCategoryName} onkeydown={(e) => e.key === 'Enter' && addCategory()} />
				<div class="color-row compact">
					{#each columnColors.slice(0, 8) as color}
						<button class="color-swatch small" class:active={newCategoryColor === color} style="background: {color}" onclick={() => (newCategoryColor = color)}></button>
					{/each}
					<label class="color-custom-wrapper">
						<input type="color" bind:value={newCategoryColor} class="color-native-input" />
						<span class="color-swatch small custom" style="background: {newCategoryColor}">✎</span>
					</label>
				</div>
				<button class="btn-primary small" onclick={addCategory} disabled={!newCategoryName.trim()}>Add</button>
			</div>
			<div class="modal-actions">
				<div style="flex: 1"></div>
				<button class="btn-ghost" onclick={() => (showCategoryModal = false)}>Done</button>
			</div>
		</div>
	</div>
{/if}

<!-- Fireworks celebration -->
{#if showFireworks}
	<div class="fireworks-overlay">
		<div class="fireworks-backdrop"></div>
		<div class="fireworks-stripe"></div>
		{#each Array(60) as _, i}
			<div class="firework-particle" style="
				--x: {Math.random() * 100}vw;
				--y: {Math.random() * 100}vh;
				--start-x: {30 + Math.random() * 40}vw;
				--start-y: {40 + Math.random() * 20}vh;
				--delay: {Math.random() * 0.8}s;
				--size: {3 + Math.random() * 10}px;
				--color: hsl({Math.random() * 360}, 85%, {50 + Math.random() * 20}%);
				--duration: {0.8 + Math.random() * 1.8}s;
				--spin: {Math.random() * 720}deg;
			"></div>
		{/each}
		{#each Array(20) as _, i}
			<div class="firework-sparkle" style="
				--x: {Math.random() * 100}vw;
				--y: {Math.random() * 100}vh;
				--delay: {0.2 + Math.random() * 0.6}s;
				--color: hsl({Math.random() * 60 + 30}, 100%, 70%);
			"></div>
		{/each}
		<div class="firework-center">
			<div class="firework-text">🎉 Complete!</div>
			{#if celebrateCardTitle}
				<div class="firework-card-title">"{celebrateCardTitle}"</div>
			{/if}
			<div class="firework-user">{celebrateUserEmoji} {celebrateUserName}{#if celebrateXpGained} <span class="firework-xp">+{celebrateXpGained} XP</span>{/if}</div>
		</div>
	</div>
{/if}

<!-- User setup prompt -->
{#if showUserSetup}
	<UserSetup onComplete={() => (showUserSetup = false)} />
{/if}

<style>
	.board-page { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

	.board-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-md) var(--space-xl); border-bottom: 1px solid var(--glass-border);
		flex-shrink: 0; gap: var(--space-md);
	}
	.board-header-left { display: flex; align-items: center; gap: var(--space-md); min-width: 0; }
	.board-header-right { display: flex; align-items: center; gap: var(--space-sm); flex-shrink: 0; }
	.back-btn { padding: var(--space-sm); }
	.btn-delete-subboard { opacity: 0.5; }
	.btn-delete-subboard:hover { opacity: 1; background: rgba(244, 63, 94, 0.1) !important; }

	.breadcrumbs {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		font-size: 0.8rem;
		flex-shrink: 1;
		min-width: 0;
		overflow: hidden;
	}

	.breadcrumb-link {
		color: var(--text-secondary);
		text-decoration: none;
		white-space: nowrap;
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
	.column-count { font-size: 0.7rem; font-weight: 600; color: var(--text-tertiary); background: var(--bg-base); padding: 1px 6px; border-radius: var(--radius-full); flex-shrink: 0; }
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
	.on-hold-note-badge {
		display: flex; align-items: flex-start; gap: 4px;
		padding: 4px 8px; margin-bottom: var(--space-sm);
		background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.15);
		border-radius: var(--radius-sm); font-size: 0.7rem; color: var(--accent-rose);
		line-height: 1.4; font-style: italic;
	}
	.on-hold-note-badge svg { flex-shrink: 0; margin-top: 2px; }

	/* On Hold modal */
	.on-hold-modal { max-width: 440px; }
	.on-hold-header { text-align: center; margin-bottom: var(--space-xl); }
	.on-hold-icon { font-size: 2rem; display: block; margin-bottom: var(--space-sm); animation: pulse 1.5s ease-in-out infinite; }
	.on-hold-task-name { font-size: 0.9rem; color: var(--text-secondary); font-style: italic; margin-top: var(--space-xs); }
	.on-hold-confirm { background: var(--accent-rose) !important; }
	.on-hold-confirm:hover { background: #dc2626 !important; }

	@keyframes pulse {
		0%, 100% { transform: scale(1); }
		50% { transform: scale(1.1); }
	}
	.card-color-strip {
		position: absolute; left: 0; top: 0; bottom: 0; width: 5px;
		border-radius: 5px 0 0 5px;
		box-shadow: 2px 0 8px var(--strip-color, transparent);
	}
	.card-title { font-size: 0.85rem; font-weight: 500; line-height: 1.4; margin-bottom: var(--space-xs); }
	.card-description { font-size: 0.75rem; color: var(--text-tertiary); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: var(--space-sm); }
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
	.due-badge.due-overdue {
		background: rgba(239, 68, 68, 0.12); color: #ef4444;
		border: 1px solid rgba(239, 68, 68, 0.25);
	}
	.due-badge.due-today {
		background: rgba(245, 158, 11, 0.12); color: #f59e0b;
		border: 1px solid rgba(245, 158, 11, 0.25);
	}
	.due-badge.due-soon {
		background: rgba(234, 179, 8, 0.08); color: #eab308;
		border: 1px solid rgba(234, 179, 8, 0.15);
	}

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
	.subtask-badge.all-done {
		background: rgba(16, 185, 129, 0.1); color: var(--accent-emerald);
		border-color: rgba(16, 185, 129, 0.2);
	}

	.subboard-badge {
		display: inline-flex; align-items: center; gap: 3px;
		padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.68rem; font-weight: 600;
		background: rgba(99, 102, 241, 0.1); color: #818cf8;
		border: 1px solid rgba(99, 102, 241, 0.2);
		text-decoration: none;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.subboard-badge:hover {
		background: rgba(99, 102, 241, 0.2);
		border-color: rgba(99, 102, 241, 0.4);
	}
	.subboard-badge.all-done {
		background: rgba(16, 185, 129, 0.1); color: var(--accent-emerald);
		border-color: rgba(16, 185, 129, 0.2);
	}
	.add-card-btn {
		display: flex; align-items: center; gap: var(--space-sm);
		width: calc(100% - var(--space-md) * 2); margin: 0 var(--space-md) var(--space-sm);
		padding: var(--space-sm) var(--space-md); background: transparent; color: var(--text-tertiary);
		border-radius: var(--radius-sm); font-size: 0.8rem; font-weight: 500;
		flex-shrink: 0;
	}
	.add-card-btn:hover { background: var(--glass-hover); color: var(--text-secondary); }

	.form-group { margin-top: var(--space-xl); }
	.form-group label { display: block; font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-sm); }
	.color-row { display: flex; flex-wrap: wrap; gap: 6px; }
	.color-row.compact { margin-top: var(--space-sm); }
	.color-swatch.small { width: 20px; height: 20px; }
	.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-md); margin-top: var(--space-2xl); }
	.modal-subtitle { font-size: 0.85rem; color: var(--text-secondary); margin-top: var(--space-sm); }
	.category-list {
		margin-top: var(--space-lg); display: flex; flex-wrap: wrap;
		gap: var(--space-sm); max-height: 200px; overflow-y: auto;
		padding: var(--space-sm); background: var(--bg-base);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
	}
	.category-chip {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 4px 10px; border-radius: var(--radius-full);
		font-size: 0.75rem; font-weight: 600; white-space: nowrap;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.category-chip:hover { filter: brightness(1.1); }
	.chip-delete {
		display: flex; align-items: center; background: none; border: none;
		cursor: pointer; padding: 0; opacity: 0.4; transition: opacity var(--duration-fast) var(--ease-out);
	}
	.chip-delete:hover { opacity: 1; }
	.empty-cats { font-size: 0.85rem; color: var(--text-tertiary); text-align: center; padding: var(--space-lg); width: 100%; }
	.add-category-row { margin-top: var(--space-lg); padding-top: var(--space-lg); border-top: 1px solid var(--glass-border); display: flex; flex-direction: column; gap: var(--space-sm); }
	.add-category-row .btn-primary.small { padding: var(--space-sm) var(--space-lg); font-size: 0.8rem; align-self: flex-start; }

	/* Native color picker */
	.color-custom-wrapper { position: relative; cursor: pointer; display: inline-flex; }
	.color-native-input { position: absolute; width: 0; height: 0; opacity: 0; pointer-events: none; }
	.color-swatch.custom {
		display: flex; align-items: center; justify-content: center;
		font-size: 0.6rem; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5);
		cursor: pointer;
	}

	/* Fireworks */
	.fireworks-overlay {
		position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
		z-index: 9999; pointer-events: none;
		animation: fireworksFade 3s ease-out forwards;
	}
	.fireworks-backdrop {
		position: absolute; inset: 0;
		background: rgba(0, 0, 0, 0.35);
		animation: backdropFade 3s ease-out forwards;
	}
	.fireworks-stripe {
		position: absolute; top: 50%; left: 0; right: 0;
		height: 140px; transform: translateY(-50%);
		background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.75) 15%, rgba(0, 0, 0, 0.75) 85%, transparent);
		animation: stripeFade 3s ease-out forwards;
	}
	.firework-particle {
		position: absolute;
		left: var(--start-x); top: var(--start-y);
		width: var(--size); height: var(--size);
		background: var(--color);
		border-radius: 50%;
		animation: fireworkBurst var(--duration) var(--delay) ease-out forwards;
		box-shadow: 0 0 6px var(--color), 0 0 14px var(--color);
	}
	.firework-sparkle {
		position: absolute;
		left: var(--x); top: var(--y);
		width: 3px; height: 3px;
		background: var(--color);
		border-radius: 50%;
		animation: sparklePop 0.6s var(--delay) ease-out forwards;
		box-shadow: 0 0 8px var(--color), 0 0 20px var(--color);
		opacity: 0;
	}
	.firework-center {
		position: absolute; top: 50%; left: 50%;
		transform: translate(-50%, -50%);
		z-index: 1; text-align: center;
		animation: fireworkTextPop 0.6s ease-out forwards;
		white-space: nowrap;
	}
	.firework-text {
		font-size: 2.8rem; font-weight: 900; letter-spacing: -0.02em;
		background: linear-gradient(135deg, #fbbf24, #f472b6, #818cf8, #34d399);
		background-size: 300% 300%;
		-webkit-background-clip: text; -webkit-text-fill-color: transparent;
		background-clip: text;
		animation: textShimmer 1.5s ease-in-out infinite;
		filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.5));
		line-height: 1.1;
	}
	.firework-card-title {
		font-size: 1.1rem; font-weight: 600; color: rgba(255, 255, 255, 0.9);
		margin-top: 4px; font-style: italic;
		text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
		max-width: 400px; overflow: hidden; text-overflow: ellipsis;
	}
	.firework-user {
		font-size: 0.85rem; font-weight: 500; color: rgba(255, 255, 255, 0.6);
		margin-top: 6px;
		text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
	}
	.firework-xp {
		display: inline-block; margin-left: 8px;
		padding: 1px 8px; border-radius: var(--radius-full);
		background: rgba(245, 158, 11, 0.25); color: #fbbf24;
		font-weight: 700; font-size: 0.8rem;
	}

	@keyframes fireworkBurst {
		0% { transform: translate(0, 0) scale(1) rotate(0deg); opacity: 1; }
		70% { opacity: 0.8; }
		100% { transform: translate(calc(var(--x) - var(--start-x)), calc(var(--y) - var(--start-y))) scale(0) rotate(var(--spin)); opacity: 0; }
	}
	@keyframes sparklePop {
		0% { opacity: 0; transform: scale(0); }
		50% { opacity: 1; transform: scale(3); }
		100% { opacity: 0; transform: scale(0); }
	}
	@keyframes fireworkTextPop {
		0% { opacity: 0; transform: translate(-50%, -50%) scale(0.3); }
		50% { opacity: 1; transform: translate(-50%, -50%) scale(1.15); }
		100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
	}
	@keyframes textShimmer {
		0% { background-position: 0% 50%; }
		50% { background-position: 100% 50%; }
		100% { background-position: 0% 50%; }
	}
	@keyframes backdropFade {
		0% { opacity: 0; }
		15% { opacity: 1; }
		75% { opacity: 1; }
		100% { opacity: 0; }
	}
	@keyframes stripeFade {
		0% { opacity: 0; transform: translateY(-50%) scaleX(0); }
		15% { opacity: 1; transform: translateY(-50%) scaleX(1); }
		75% { opacity: 1; }
		100% { opacity: 0; }
	}
	@keyframes fireworksFade {
		0%, 80% { opacity: 1; }
		100% { opacity: 0; }
	}
	/* Side panel */
	.panel-overlay {
		position: fixed; inset: 0; background: rgba(0,0,0,0.3);
		z-index: 90;
	}
	.side-panel {
		position: fixed; top: 0; right: 0; bottom: 0; width: 360px;
		z-index: 91; display: flex; flex-direction: column;
		border-left: 1px solid var(--glass-border);
		background: var(--bg-base) !important;
		animation: panelSlide 0.2s ease-out;
	}
	@keyframes panelSlide { from { transform: translateX(100%); } to { transform: translateX(0); } }
	.panel-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: var(--space-md) var(--space-lg); border-bottom: 1px solid var(--glass-border);
	}
	.panel-header h3 { font-size: 1rem; font-weight: 700; }
	.panel-body { flex: 1; overflow-y: auto; padding: var(--space-md); }
	.panel-empty { color: var(--text-tertiary); text-align: center; padding: var(--space-xl); font-size: 0.85rem; }

	/* Activity items */
	.activity-item {
		display: flex; gap: var(--space-sm); padding: var(--space-sm);
		border-radius: var(--radius-sm); transition: background 0.15s;
	}
	.activity-item:hover { background: var(--glass-bg); }
	.activity-emoji { font-size: 1.2rem; flex-shrink: 0; }
	.activity-info { display: flex; flex-direction: column; min-width: 0; }
	.activity-action { font-weight: 600; font-size: 0.78rem; }
	.activity-detail { font-size: 0.75rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.activity-time { font-size: 0.65rem; color: var(--text-tertiary); }

	/* Stats */
	.stats-grid {
		display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-sm);
		margin-bottom: var(--space-lg);
	}
	.stat-card {
		display: flex; flex-direction: column; align-items: center;
		padding: var(--space-md); border-radius: var(--radius-md);
		background: var(--glass-bg); border: 1px solid var(--glass-border);
	}
	.stat-value { font-size: 1.5rem; font-weight: 800; color: var(--accent-indigo); }
	.stat-label { font-size: 0.68rem; color: var(--text-tertiary); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
	.stats-section-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary); margin-bottom: var(--space-sm); }
	.stats-bars { display: flex; flex-direction: column; gap: var(--space-xs); margin-bottom: var(--space-lg); }
	.stats-bar-row { display: flex; align-items: center; gap: var(--space-sm); }
	.stats-bar-label { font-size: 0.72rem; font-weight: 600; width: 80px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
	.stats-bar-track { flex: 1; height: 8px; background: var(--glass-bg); border-radius: 4px; overflow: hidden; }
	.stats-bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s ease-out; min-width: 2px; }
	.stats-bar-count { font-size: 0.68rem; font-weight: 700; color: var(--text-secondary); width: 24px; text-align: right; }

	/* Bulk action bar */
	.bulk-bar {
		position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
		display: flex; align-items: center; gap: var(--space-md);
		padding: var(--space-sm) var(--space-lg);
		border-radius: var(--radius-lg);
		border: 1px solid var(--glass-border);
		background: var(--bg-base) !important;
		box-shadow: 0 8px 32px rgba(0,0,0,0.3);
		z-index: 80;
		animation: bulkSlide 0.2s ease-out;
	}
	@keyframes bulkSlide { from { transform: translateX(-50%) translateY(20px); opacity: 0; } to { transform: translateX(-50%) translateY(0); opacity: 1; } }
	.bulk-count { font-weight: 700; font-size: 0.85rem; white-space: nowrap; }
	.bulk-actions { display: flex; align-items: center; gap: var(--space-xs); }
	.bulk-group { display: flex; align-items: center; gap: 2px; }
	.bulk-label { font-size: 0.68rem; font-weight: 600; color: var(--text-tertiary); margin-right: 4px; white-space: nowrap; }
	.bulk-btn { font-size: 0.72rem !important; padding: 3px 8px !important; }
	.bulk-danger { color: var(--accent-rose) !important; }
	.bulk-divider { width: 1px; height: 20px; background: var(--glass-border); margin: 0 4px; }

	/* Card labels */
	.card-labels { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; }
	.label-chip {
		display: inline-flex; align-items: center;
		padding: 0px 6px; border-radius: var(--radius-full);
		font-size: 0.58rem; font-weight: 600; white-space: nowrap;
	}

	/* Selection checkbox */
	.select-checkbox {
		position: absolute; top: 6px; right: 6px; width: 18px; height: 18px;
		border: 2px solid var(--glass-border); border-radius: 4px;
		display: flex; align-items: center; justify-content: center;
		font-size: 0.65rem; font-weight: 800; z-index: 2;
		background: var(--bg-surface); color: var(--accent-indigo);
		transition: all 0.15s;
	}
	.select-checkbox.checked {
		background: var(--accent-indigo); color: white; border-color: var(--accent-indigo);
	}
	.kanban-card.card-selected { outline: 2px solid var(--accent-indigo); outline-offset: -2px; }

	/* Active panel button */
	.active-panel-btn { background: rgba(99, 102, 241, 0.12) !important; color: var(--accent-indigo) !important; }

	/* Context menu */
	.ctx-overlay { position: fixed; inset: 0; z-index: 95; }
	.ctx-menu {
		position: fixed; z-index: 96; min-width: 180px;
		padding: 6px; border-radius: var(--radius-md);
		background: var(--bg-surface) !important;
		border: 1px solid var(--glass-border);
		box-shadow: 0 8px 32px rgba(0,0,0,0.3);
		animation: ctxIn 0.12s ease-out;
	}
	@keyframes ctxIn { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }
	.ctx-section { padding: 2px 0; }
	.ctx-label { font-size: 0.6rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-tertiary); padding: 4px 10px; display: block; }
	.ctx-item {
		display: flex; align-items: center; gap: 6px; width: 100%;
		padding: 5px 10px; border: none; background: none; cursor: pointer;
		font-size: 0.78rem; border-radius: var(--radius-sm);
		color: var(--text-primary); text-align: left; transition: background 0.1s;
	}
	.ctx-item:hover { background: var(--glass-bg); }
	.ctx-danger { color: var(--accent-rose) !important; }
	.ctx-danger:hover { background: rgba(239, 68, 68, 0.1) !important; }
	.ctx-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
	.ctx-divider { height: 1px; background: var(--glass-border); margin: 4px 6px; }
	.ctx-row { display: flex; gap: 2px; padding: 0 4px; }
	.ctx-priority { flex: 1; justify-content: center; font-size: 1rem !important; padding: 4px !important; }

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
	.pin-indicator {
		position: absolute; top: 4px; right: 4px; font-size: 0.7rem;
		z-index: 2; opacity: 0.7;
	}
	.kanban-card.card-pinned {
		border-top: 2px solid var(--accent-indigo);
	}

	/* Drag shadow */
	:global(.kanban-card[aria-grabbed="true"]) {
		transform: rotate(2deg) scale(1.03);
		box-shadow: 0 12px 40px rgba(0,0,0,0.3);
		opacity: 0.9;
	}

	/* Progress ring */
	.progress-ring { flex-shrink: 0; transition: stroke-dashoffset 0.3s ease-out; }
</style>
