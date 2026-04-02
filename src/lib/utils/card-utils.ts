/**
 * card-utils.ts — Card-related utility functions for the DumpFire application.
 *
 * Pure, stateless helper functions for card operations: search filtering,
 * sorting, subtask progress, status classification, and label lookups.
 * Extracted from the board page to enable sharing and testing.
 */

import type { CardType, ColumnType, CategoryType, LabelType, SortOption } from '$lib/types';
import { PRIORITY_ORDER } from './constants';

// ─── Column Status Helpers ───────────────────────────────────────────────────

/**
 * Checks if a column is the "Complete" column by title convention.
 * Cards in this column are considered finished and trigger celebrations.
 */
export function isCompleteColumn(col: ColumnType): boolean {
	return col.title.toLowerCase() === 'complete';
}

/**
 * Checks if a column title matches the "On Hold" convention.
 * Cards moved here prompt for a reason note.
 */
export function isOnHoldColumn(title: string): boolean {
	return title.toLowerCase() === 'on hold';
}

// ─── Subtask & Sub-board Progress ────────────────────────────────────────────

/**
 * Returns the subtask completion ratio for a card.
 * @returns `{ done, total }` or null if the card has no subtasks.
 */
export function subtaskProgress(card: CardType): { done: number; total: number } | null {
	if (!card.subtasks || card.subtasks.length === 0) return null;
	const done = card.subtasks.filter((st) => st.completed).length;
	return { done, total: card.subtasks.length };
}

/**
 * Checks if a card has any incomplete (unchecked) subtasks.
 * Used to block moving cards to the Complete column.
 */
export function hasIncompleteSubtasks(card: CardType): boolean {
	return card.subtasks && card.subtasks.some((st) => !st.completed);
}

/**
 * Checks if a card has any sub-board with incomplete tasks.
 * Used alongside subtask checks to enforce completion rules.
 */
export function hasIncompleteSubBoard(card: CardType): boolean {
	return card.subBoards && card.subBoards.some(sb => sb.total > 0 && sb.done < sb.total);
}

/**
 * Returns true if a card is "blocked" from completion — either by
 * incomplete subtasks or incomplete sub-board tasks.
 */
export function isCardBlocked(card: CardType): boolean {
	return hasIncompleteSubtasks(card) || hasIncompleteSubBoard(card);
}

/**
 * Counts the number of incomplete subtasks on a card.
 */
export function incompleteCount(card: CardType): number {
	return card.subtasks ? card.subtasks.filter((st) => !st.completed).length : 0;
}

/**
 * Counts the total number of incomplete tasks across all sub-boards.
 */
export function subBoardIncompleteCount(card: CardType): number {
	return card.subBoards.reduce((sum, sb) => sum + (sb.total - sb.done), 0);
}

// ─── Search & Filtering ──────────────────────────────────────────────────────

/**
 * Tests whether a card matches the current search query.
 * Searches card title, description, and category name.
 *
 * @param card — The card to test
 * @param searchQuery — The raw search string (case-insensitive)
 * @param categories — Board categories for name matching
 * @returns True if the card matches, or if the query is empty
 */
export function matchesSearch(card: CardType, searchQuery: string, categories: CategoryType[]): boolean {
	if (!searchQuery.trim()) return true;
	const q = searchQuery.toLowerCase();
	return (
		card.title.toLowerCase().includes(q) ||
		card.description?.toLowerCase().includes(q) ||
		categories.find(cat => cat.id === card.categoryId)?.name.toLowerCase().includes(q) ||
		false
	);
}

// ─── Sorting ─────────────────────────────────────────────────────────────────

/**
 * Sorts an array of cards by the given sort option.
 * Pinned cards always appear first, regardless of sort order.
 *
 * @param cards — The cards to sort (a new array is returned)
 * @param sort — The sort criterion
 * @param categories — Board categories (needed for category sort)
 * @returns A new sorted array — does not mutate the input
 */
export function sortCards(cards: CardType[], sort: SortOption, categories: CategoryType[]): CardType[] {
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
				sorted.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9));
				break;
			case 'category':
				sorted.sort((a, b) => {
					const catA = categories.find(c => c.id === a.categoryId)?.name || 'zzz';
					const catB = categories.find(c => c.id === b.categoryId)?.name || 'zzz';
					return catA.localeCompare(catB);
				});
				break;
		}
		return sorted;
	};
	return [...doSort(pinned), ...doSort(unpinned)];
}

// ─── Label & Category Lookups ────────────────────────────────────────────────

/**
 * Finds a category by ID from the board's category list.
 * @returns The matching category, or null if not found or ID is null.
 */
export function getCategoryById(id: number | null, categories: CategoryType[]): CategoryType | null {
	if (!id) return null;
	return categories.find((c) => c.id === id) || null;
}

/**
 * Finds a label by ID from the board's label list.
 * @returns The matching label, or null if not found.
 */
export function getLabelById(id: number, labels: LabelType[]): LabelType | null {
	return labels.find(l => l.id === id) || null;
}

// ─── Display Helpers ─────────────────────────────────────────────────────────

/**
 * Returns a human-readable priority label with emoji.
 * Used in both card badges and column sort labels.
 *
 * @param priority — The priority key (e.g. 'critical', 'high', 'medium', 'low')
 * @returns Emoji + label string (e.g. '🔴 Critical')
 */
export function getPriorityLabel(priority: string): string {
	const labels: Record<string, string> = {
		critical: '🔴 Critical',
		high: '🟠 High',
		medium: '🟡 Medium',
		low: '🟢 Low'
	};
	return labels[priority] || priority;
}

/**
 * Returns a display label for the current sort option.
 * Shown in the column header's sort badge.
 */
export function getSortLabel(sort: SortOption): string {
	switch (sort) {
		case 'date-asc': return '↑ Oldest';
		case 'date-desc': return '↓ Newest';
		case 'priority': return '⚡ Priority';
		case 'category': return '🏷 Category';
		default: return '';
	}
}

/**
 * Converts an activity log action key to a human-readable label with emoji.
 * Used in the activity panel sidebar.
 */
export function getActionLabel(action: string): string {
	const map: Record<string, string> = {
		card_created: '➕ Created',
		card_moved: '📦 Moved',
		card_completed: '✅ Completed',
		card_deleted: '🗑️ Deleted',
		subtask_completed: '☑️ Subtask done'
	};
	return map[action] || action;
}

/**
 * Returns the number of cards visible after search filtering in a column.
 */
export function getVisibleCount(column: ColumnType, searchQuery: string, categories: CategoryType[]): number {
	if (!searchQuery.trim()) return column.cards.length;
	return column.cards.filter(c => matchesSearch(c, searchQuery, categories)).length;
}
