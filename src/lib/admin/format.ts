/**
 * How the admin page's backup panels show a destination's type, a size, a
 * time taken and a moment, and the types those panels share (card 2281,
 * slice C1a: moved from src/routes/admin/+page.svelte as written).
 */
import { parseStamp } from '$lib/timestamps';

export type DestType = 'sftp' | 's3' | 'gdrive' | 'onedrive';

export interface BackupHistoryEntry {
	id: number;
	destinationType: string;
	destinationName: string;
	filename: string;
	sizeBytes: number | null;
	status: string;
	error: string | null;
	durationMs: number | null;
	createdAt: string;
}

export const destTypeLabels: Record<DestType, string> = {
	sftp: '🔐 SFTP / SCP',
	s3: '☁️ Amazon S3',
	gdrive: '📁 Google Drive',
	onedrive: '💙 OneDrive'
};

export function formatBytes(bytes: number | null): string {
	if (!bytes) return '—';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number | null): string {
	if (!ms) return '—';
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

export function formatRelativeTime(dateStr: string): string {
	if (!dateStr) return '—';
	// The stored form, 'YYYY-MM-DD HH:MM:SS', is UTC with no zone: read as UTC.
	const d = parseStamp(dateStr);
	if (!d) return dateStr;
	const now = new Date();
	const diff = now.getTime() - d.getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.floor(hrs / 24);
	return `${days}d ago`;
}
