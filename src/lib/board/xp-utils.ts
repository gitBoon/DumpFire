/**
 * xp-utils.ts — XP levelling system helpers.
 *
 * Pure functions for calculating player levels and progress
 * from raw XP totals. Used by the board header's leaderboard display.
 *
 * Levelling formula: 500 XP per level, starting at level 1.
 */

import * as api from '$lib/api';
import type { XpEntry } from '$lib/types';

/** Returns the level number for a given XP total (500 XP per level). */
export function getLevel(xp: number): number {
	return Math.floor(xp / 500) + 1;
}

/** Returns the cumulative XP required to reach a given level. */
export function getXpForLevel(level: number): number {
	return (level - 1) * 500;
}

/** Returns the progress percentage (0–100) within the current level. */
export function getXpProgress(xp: number): number {
	const level = getLevel(xp);
	const base = getXpForLevel(level);
	return ((xp - base) / 500) * 100;
}

/** Fetches the XP leaderboard from the server. Returns the entries or an empty array on error. */
export async function loadXp(): Promise<XpEntry[]> {
	try {
		const res = await api.fetchXp();
		if (res.ok) return await res.json();
	} catch { /* swallow — leaderboard is non-critical */ }
	return [];
}
