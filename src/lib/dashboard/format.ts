/**
 * How the dashboard says how long ago a moment was: a board's last activity
 * in the boards table, an entry's time in the sidebar's Recent Activity
 * (card 2281, slice C2: moved from src/routes/+page.svelte as written).
 */
import { parseStamp } from '$lib/timestamps';

export function timeAgo(dateStr: string | null | undefined): string {
	const dateObj = parseStamp(dateStr);
	if (!dateObj) return 'unknown';
	const diff = Math.floor((Date.now() - dateObj.getTime()) / 1000);
	if (diff < 60) return 'just now';
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}
