/**
 * card-utils.ts — Card-related utility functions for the DumpFire application.
 *
 * Pure, stateless helper functions for card operations: search filtering,
 * sorting, subtask progress, status classification, and label lookups.
 * Extracted from the board page to enable sharing and testing.
 */

import type { CardType, ColumnType, CategoryType, LabelType, SortOption } from '$lib/types';
import { PRIORITY_ORDER } from './constants';
import { isHexColour } from '$lib/colours';
import { isCompleteColumnTitle, isHoldColumnTitle } from '$lib/column-role';

// ─── Column Status Helpers ───────────────────────────────────────────────────

/**
 * Checks if a column holds finished cards.
 * Cards in such a column are considered finished and trigger celebrations.
 *
 * Asks `$lib/column-role`, the same definition the server uses. This used to
 * accept only "complete" while the server also accepted "done", so a card
 * dragged into a "Done" column was completed by the server and not celebrated,
 * greyed out or logged as a completion by the browser.
 */
export function isCompleteColumn(col: Pick<ColumnType, 'title'>): boolean {
	return isCompleteColumnTitle(col.title);
}

/**
 * Checks if a column holds paused cards.
 * Cards moved into one prompt for a reason note.
 */
export function isOnHoldColumn(title: string): boolean {
	return isHoldColumnTitle(title);
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
 *
 * Counts the sub-boards the caller cannot open as well, by
 * `hiddenOpenCount`: the board page leaves them off the card, and the server
 * refuses to complete it while they have open cards (card 2130's review).
 */
export function hasIncompleteSubBoard(card: CardType): boolean {
	return (card.subBoards ?? []).some(sb => sb.total > 0 && sb.done < sb.total) || (card.hiddenOpenCount ?? 0) > 0;
}

/**
 * Returns true if a card is "blocked" from completion — either by
 * incomplete subtasks or incomplete sub-board tasks, those on sub-boards the
 * caller cannot open included.
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
 * Counts the total number of incomplete tasks across all sub-boards, those on
 * sub-boards the caller cannot open included (`hiddenOpenCount`).
 */
export function subBoardIncompleteCount(card: CardType): number {
	return (card.subBoards ?? []).reduce((sum, sb) => sum + (sb.total - sb.done), 0) + (card.hiddenOpenCount ?? 0);
}

// ─── Search & Filtering ──────────────────────────────────────────────────────

/**
 * Tests whether a card matches the current search query.
 * Searches card ID (with `#` prefix for exact match), title, description,
 * category name, and assignee usernames.
 *
 * @param card — The card to test
 * @param searchQuery — The raw search string (case-insensitive).
 *   Use `#123` to match card ID 123 exactly.
 * @param categories — Board categories for name matching
 * @returns True if the card matches, or if the query is empty
 */
export function matchesSearch(card: CardType, searchQuery: string, categories: CategoryType[]): boolean {
	if (!searchQuery.trim()) return true;
	const q = searchQuery.trim().toLowerCase();

	// Exact card-ID match: "#123" matches only card 123
	const hashMatch = q.match(/^#(\d+)$/);
	if (hashMatch) {
		return card.id === parseInt(hashMatch[1], 10);
	}

	const idStr = String(card.id);
	return (
		idStr.includes(q) ||
		card.title.toLowerCase().includes(q) ||
		card.description?.toLowerCase().includes(q) ||
		categories.find(cat => cat.id === card.categoryId)?.name.toLowerCase().includes(q) ||
		card.assignees?.some(a => a.username.toLowerCase().includes(q)) ||
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
			case 'assignee':
				sorted.sort((a, b) => {
					const nameA = a.assignees?.[0]?.username || 'zzz';
					const nameB = b.assignees?.[0]?.username || 'zzz';
					return nameA.localeCompare(nameB);
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

// ─── What a Copy Carries ─────────────────────────────────────────────────────

// A duplicate, its subtasks and a template saved from a card are made from the
// card's stored values, and the server checks them as it checks anything new
// (card 2117, R6). A value stored before its rule would have the copy refused,
// so each of these hands back what the server takes, or undefined, for the
// server's default (card 2117's second fix pass).

/** A stored priority, if it is one of the four in any case, as the server reads it. */
export function priorityToCopy(priority: string | null | undefined): string | undefined {
	return typeof priority === 'string' && Object.hasOwn(PRIORITY_ORDER, priority.toLowerCase()) ? priority : undefined;
}

/** A stored colour tag, if it is written `#rrggbb`; empty text, no tag, otherwise. */
export function colourToCopy(colorTag: string | null | undefined): string {
	return isHexColour(colorTag) ? colorTag : '';
}

/**
 * A stored due date, if it is written `YYYY-MM-DD` and is a day there is, or
 * the first ten characters of one, if they are (`2026-10-14T09:00:00Z`).
 */
export function dueDateToCopy(dueDate: string | null | undefined): string | undefined {
	const day = typeof dueDate === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(dueDate) : null;
	if (!day) return undefined;
	const [year, month, date] = [Number(day[1]), Number(day[2]), Number(day[3])];
	const at = new Date(Date.UTC(year, month - 1, date));
	return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === date ? day[0] : undefined;
}

/**
 * A stored category, if a card on board `boardId` may be filed under it: one
 * of that board's, or a shared one, of no board (card 2117, R3).
 */
export function categoryToCopy(
	categoryId: number | null | undefined,
	boardId: number,
	categories: { id: number; boardId: number | null }[]
): number | undefined {
	const category = categories.find((c) => c.id === categoryId);
	return category && (category.boardId === boardId || category.boardId === null) ? category.id : undefined;
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
		case 'assignee': return '👤 Assignee';
		default: return '';
	}
}
