/**
 * date-utils.ts — Date/time utility functions for the DumpFire application.
 *
 * These functions handle SQLite timestamp parsing, relative time formatting,
 * and due-date status classification. They were previously duplicated across
 * the board page and all-tasks page.
 *
 * Functions that accept a `tick` parameter use it as a reactive dependency
 * in Svelte — the `tick` value is read (via `void tick`) to force
 * re-evaluation every 15 seconds when the tick counter increments.
 */

/**
 * Parses a SQLite datetime string as UTC.
 *
 * SQLite's `datetime('now')` stores UTC timestamps without a 'Z' suffix.
 * Without appending 'Z', JavaScript's `new Date()` interprets bare timestamps
 * as local time, causing an offset equal to the user's timezone.
 *
 * @param dateStr — A date string from SQLite (e.g. "2026-04-01 14:30:00")
 * @returns A correctly UTC-interpreted Date object
 */
export function parseUTC(dateStr: string): Date {
	if (!dateStr) return new Date();
	// If it already has timezone info (Z or +/-), parse as-is
	if (/[Zz]|[+-]\d{2}:\d{2}$/.test(dateStr)) return new Date(dateStr);
	// Otherwise it's a bare SQLite UTC timestamp — append Z
	return new Date(dateStr + 'Z');
}

/**
 * Returns a human-readable relative age string (e.g. "3d", "2w", "just now").
 *
 * @param dateStr — The creation/update timestamp from the database
 * @param tick — Reactive tick counter (read to trigger re-evaluation)
 * @returns A compact relative time string
 */
export function getRelativeAge(dateStr: string, tick: number): string {
	void tick; // Reactive dependency — forces re-evaluation every 15s
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

/**
 * Returns a relative string for a due date (e.g. "today", "tomorrow", "3d overdue").
 *
 * @param dueDate — The due date string from the card
 * @param tick — Reactive tick counter (read to trigger re-evaluation)
 * @returns A human-readable relative due date string
 */
export function getDueRelative(dueDate: string, tick: number): string {
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

/**
 * Classifies a due date status for colour-coding badges.
 *
 * @param dueDate — The due date string to classify
 * @returns 'overdue' | 'today' | 'soon' | null
 */
export function getDueStatus(dueDate: string): 'overdue' | 'today' | 'soon' | null {
	const due = new Date(dueDate);
	const now = new Date();
	now.setHours(0, 0, 0, 0);
	due.setHours(0, 0, 0, 0);
	const diff = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
	if (diff < 0) return 'overdue';
	if (diff === 0) return 'today';
	if (diff <= 2) return 'soon';
	return null;
}

/**
 * Checks whether a card/item is "stale" — older than 7 days.
 * Used to visually flag cards that may have been forgotten.
 *
 * @param dateStr — The creation timestamp to check
 * @returns True if the item is 7+ days old
 */
export function isStale(dateStr: string): boolean {
	const days = Math.floor((Date.now() - parseUTC(dateStr).getTime()) / (1000 * 60 * 60 * 24));
	return days >= 7;
}

/**
 * Checks whether a card/item is "new" — created within the last 24 hours.
 * Used to visually highlight freshly created tasks.
 *
 * @param dateStr — The creation timestamp to check
 * @returns True if the item is less than 24 hours old
 */
export function isNew(dateStr: string): boolean {
	const hours = (Date.now() - parseUTC(dateStr).getTime()) / (1000 * 60 * 60);
	return hours < 24;
}
