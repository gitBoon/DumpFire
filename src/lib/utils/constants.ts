/**
 * constants.ts — Shared constants used across the DumpFire application.
 *
 * Centralising these avoids magic values scattered through components and
 * ensures consistent colour palettes, emoji sets, and timing values.
 */

/** Duration in ms for svelte-dnd-action flip animations. */
export const FLIP_DURATION_MS = 200;

/**
 * Colour palette for column headers and colour pickers.
 * Curated to be visually distinct and accessible on dark/light backgrounds.
 */
export const COLUMN_COLORS = [
	'#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
	'#ec4899', '#f43f5e', '#ef4444', '#f97316',
	'#f59e0b', '#eab308', '#84cc16', '#22c55e',
	'#10b981', '#14b8a6', '#06b6d4', '#0ea5e9'
] as const;

/**
 * Emoji options for the board icon picker.
 * A compact set of commonly used project/category emojis.
 */
export const COMMON_EMOJIS = [
	'📋', '🚀', '💡', '🎯', '🔥', '⚡', '🎨', '🛠️',
	'📦', '🏗️', '🧪', '📊', '🎮', '🎵', '📸', '🛒',
	'💼', '🏠', '✈️', '🎓', '💪', '🌟', '🐛', '🔧',
	'📝', '🎉', '🤖', '🧠', '💎', '🌈', '🍕', '☕'
] as const;

/**
 * Numeric weight for each priority level — lower = more urgent.
 * Used when sorting cards by priority.
 */
export const PRIORITY_ORDER: Record<string, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3
};
