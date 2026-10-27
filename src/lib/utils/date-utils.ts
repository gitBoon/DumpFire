/**
 * date-utils.ts — Date/time utility functions for the DumpFire application.
 *
 * These functions handle SQLite timestamp parsing, relative time formatting,
 * and due dates, which are calendar days read in the viewer's own zone. They
 * were previously duplicated across the board page and all-tasks page.
 *
 * Functions that accept a `tick` parameter use it as a reactive dependency
 * in Svelte — the `tick` value is read (via `void tick`) to force
 * re-evaluation every 15 seconds when the tick counter increments.
 */

import { parseStamp } from '$lib/timestamps';
import { calendarDayIn } from '$lib/report-schedule-time';

/**
 * Parses a stored timestamp as UTC: `parseStamp` under the name its importers
 * know (card 2095).
 *
 * The stored form, `YYYY-MM-DD HH:MM:SS`, names no zone, and `new Date()`
 * reads it as local time, so every page parses a stored value through
 * `parseStamp`, which reads it as UTC.
 *
 * @param dateStr — A stored timestamp (e.g. "2026-04-01 14:30:00")
 * @returns The moment it names; now for an empty string, as before; an
 *   invalid Date for anything that is not a timestamp
 */
export function parseUTC(dateStr: string): Date {
	if (!dateStr) return new Date();
	return parseStamp(dateStr) ?? new Date(NaN);
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

/** A calendar day: the year, the month (1 to 12) and the day of the month. */
export interface CalendarDay {
	year: number;
	month: number;
	day: number;
}

/**
 * Reads a due date as the calendar day it names (card 2241).
 *
 * A due date is stored as `YYYY-MM-DD`: a day, not a moment. `new Date()`
 * reads that form as midnight UTC, which is the evening before west of UTC,
 * so every reader of a due date goes through this instead. Any other stored
 * calendar date (a milestone's target date) reads the same way.
 *
 * @param dueDate — The stored value
 * @returns The day, or null when the value is not a real `YYYY-MM-DD`
 */
export function dueDay(dueDate: string | null | undefined): CalendarDay | null {
	// The day may be followed by a time (an older row written before dates were
	// checked), but not by another digit: 2026-10-199 is not the 19th.
	const m = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(dueDate ?? '');
	if (!m) return null;
	const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
	// `Date.UTC` reads a year below 100 as 1900 and on, and no date input
	// writes a year below 1000, so one is not a day.
	if (year < 1000) return null;
	// Day 0 of the next month is the last day of this one.
	const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
	if (month < 1 || month > 12 || day < 1 || day > lastDay) return null;
	return { year, month, day };
}

/**
 * Whole calendar days from the viewer's own today to a due date: 0 on the due
 * day, 1 the day before it, -1 the day after it.
 *
 * Both days are placed at midnight UTC before they are subtracted, so a 23- or
 * 25-hour day at a clock change still counts as one.
 *
 * With a zone, today is the date in that zone (card 2258): the server, which
 * runs in UTC, counts a report's Overdue figure from the reader's day, and the
 * dashboard its figures from the UTC day until the page has loaded. Without
 * one, today is `now`'s local day, which in the browser is the viewer's.
 *
 * @param dueDate — The stored `YYYY-MM-DD`
 * @param now — The moment whose calendar day is today
 * @param timeZone — The zone whose day that is; the process's own when left out
 * @returns The days, or null for a value that is not a date
 */
export function daysUntilDue(dueDate: string | null | undefined, now: Date = new Date(), timeZone?: string): number | null {
	return daysFromDay(dueDate, todayIn(now, timeZone));
}

/**
 * The calendar day that is today at `now`: the date in `timeZone`, or `now`'s
 * local date without one, as `daysUntilDue` reads it. Worked out once for a
 * list and handed to `daysFromDay`: reading a zone builds an
 * `Intl.DateTimeFormat`, which a report of many cards paid for each card
 * (group B's review).
 */
export function todayIn(now: Date, timeZone?: string): CalendarDay {
	return timeZone === undefined
		? { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }
		: calendarDayIn(now, timeZone);
}

/**
 * Whole calendar days from `today` to a due date, as `daysUntilDue` counts
 * them, or null for a value that is not a date.
 */
export function daysFromDay(dueDate: string | null | undefined, today: CalendarDay): number | null {
	const due = dueDay(dueDate);
	if (!due) return null;
	return (Date.UTC(due.year, due.month - 1, due.day) - Date.UTC(today.year, today.month - 1, today.day)) / 86_400_000;
}

/**
 * The dashboard's due-date figures (card 2258), counted from one day: overdue
 * is every card due before it; due soon, every card due on it or in the three
 * days after it; upcoming, the first five due on it or later, in the order
 * given (the load sends them by due date). A value that is not a day counts
 * in none. `alreadyOverdue` is added to overdue: the cards the load counted
 * itself, due so long ago that they are overdue in every zone, and not sent.
 *
 * @param cards — The reader's open cards with a due date, by due date
 * @param now — The moment whose calendar day is today
 * @param timeZone — The zone whose day that is; the process's own when left out
 * @param alreadyOverdue — Cards overdue wherever the reader is, counted by the load
 */
export function dueFigures<T extends { dueDate: string }>(
	cards: T[],
	now: Date,
	timeZone?: string,
	alreadyOverdue = 0
): { overdue: number; dueSoon: number; upcoming: T[] } {
	let overdue = alreadyOverdue;
	let dueSoon = 0;
	const upcoming: T[] = [];
	// Today once, for the whole list.
	const today = todayIn(now, timeZone);
	for (const card of cards) {
		const days = daysFromDay(card.dueDate, today);
		if (days === null) continue;
		if (days < 0) overdue++;
		else {
			if (days <= 3) dueSoon++;
			if (upcoming.length < 5) upcoming.push(card);
		}
	}
	return { overdue, dueSoon, upcoming };
}

/**
 * Prints a due date as the day stored, in any zone (e.g. "19 Oct 2026").
 *
 * @param dueDate — The stored `YYYY-MM-DD`
 * @param options — Which parts to show; day, short month and year by default
 * @returns The day in words, or the value as it is when it is not a date
 */
export function formatDueDate(
	dueDate: string,
	options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }
): string {
	const due = dueDay(dueDate);
	if (!due) return dueDate;
	return new Date(Date.UTC(due.year, due.month - 1, due.day)).toLocaleDateString('en-GB', { ...options, timeZone: 'UTC' });
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
	const diffDays = daysUntilDue(dueDate);
	if (diffDays === null) return dueDate;
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
 * @returns 'overdue' | 'today' | 'soon' | null (null for a value that is not a date)
 */
export function getDueStatus(dueDate: string): 'overdue' | 'today' | 'soon' | null {
	const diff = daysUntilDue(dueDate);
	if (diff === null) return null;
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

/**
 * Whether a card shows its "New" badge: created under 24 hours ago, and not
 * in a Complete column. The board's card and the list view's row both ask
 * this, so the two agree (card 2537).
 *
 * @param card — The card, of which only `createdAt` is read
 * @param completed — The card is in a Complete column
 * @param tick — Reactive tick counter (read to trigger re-evaluation), so the
 *   badge goes at the 24-hour mark without a reload, in both views at once
 * @returns True while the badge is shown
 */
export function showsNewBadge(card: { createdAt: string }, completed: boolean, tick: number): boolean {
	void tick; // Reactive dependency — forces re-evaluation every 15s
	return !completed && isNew(card.createdAt);
}
