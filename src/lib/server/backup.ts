/**
 * backup.ts — Scheduled backup orchestrator for DumpFire.
 *
 * Manages backup scheduling, generates backup data, uploads to configured
 * destinations, and maintains a backup history log.
 */

import { db, sqlite, getDbPath } from './db';
import { settings, backupLog } from './db/schema';
import { eq, desc } from 'drizzle-orm';
import { createDestination, type DestinationConfig } from './backup-destinations';
import { sendEmail, isSmtpConfigured } from './email';
import { readFileSync, unlinkSync } from 'node:fs';
import { createLogger } from './logger';

const log = createLogger('BACKUP');

// ─── Settings Helpers ────────────────────────────────────────────────────────

function getSetting(key: string): string | null {
	const row = db.select().from(settings).where(eq(settings.key, key)).get();
	return row?.value ?? null;
}

function setSetting(key: string, value: string): void {
	const existing = db.select().from(settings).where(eq(settings.key, key)).get();
	if (existing) {
		db.update(settings).set({ value }).where(eq(settings.key, key)).run();
	} else {
		db.insert(settings).values({ key, value }).run();
	}
}

// ─── Backup Schedule ─────────────────────────────────────────────────────────

export type BackupSchedule = 'disabled' | 'hourly' | 'every6h' | 'every12h' | 'daily' | 'weekly';

const SCHEDULE_INTERVALS: Record<BackupSchedule, number> = {
	disabled: 0,
	hourly: 60 * 60 * 1000,
	every6h: 6 * 60 * 60 * 1000,
	every12h: 12 * 60 * 60 * 1000,
	daily: 24 * 60 * 60 * 1000,
	weekly: 7 * 24 * 60 * 60 * 1000
};

export interface BackupConfig {
	schedule: BackupSchedule;
	scheduleTime: string; // HH:MM (24h format) — used for daily/weekly
	scheduleDay: number;  // 0=Sunday, 1=Monday, ..., 6=Saturday — used for weekly
	retention: number; // Max backups to keep per destination
	destinations: DestinationConfig[];
	notifyOnFailure: boolean;
	notifyEmail: string;
}

export function getBackupConfig(): BackupConfig {
	const raw = getSetting('backup_config');
	if (!raw) {
		return {
			schedule: 'disabled',
			scheduleTime: '02:00',
			scheduleDay: 0,
			retention: 7,
			destinations: [],
			notifyOnFailure: false,
			notifyEmail: ''
		};
	}
	try {
		return JSON.parse(raw) as BackupConfig;
	} catch {
		return {
			schedule: 'disabled',
			scheduleTime: '02:00',
			scheduleDay: 0,
			retention: 7,
			destinations: [],
			notifyOnFailure: false,
			notifyEmail: ''
		};
	}
}

export function saveBackupConfig(config: BackupConfig): void {
	setSetting('backup_config', JSON.stringify(config));
}

// ─── Backup Data Generation ─────────────────────────────────────────────────

/**
 * Generate a consistent SQLite backup file.
 * Uses VACUUM INTO to create a complete, self-contained .db copy that includes
 * all WAL data — readFileSync alone would miss unflushed WAL entries.
 */
export function generateBackupData(): Buffer {
	const dbPath = getDbPath();
	const backupPath = dbPath + '.backup-temp';

	// Remove any stale temp file
	try { unlinkSync(backupPath); } catch {}

	// VACUUM INTO creates a fresh, complete copy including all WAL data
	sqlite.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

	const data = readFileSync(backupPath);

	// Clean up temp file
	try { unlinkSync(backupPath); } catch {}

	return data;
}

// ─── Backup History ──────────────────────────────────────────────────────────

export function getBackupHistory(limit = 10) {
	// Prune stale entries on every read
	sqlite.prepare(`
		DELETE FROM backup_log WHERE id NOT IN (
			SELECT id FROM backup_log ORDER BY created_at DESC LIMIT 10
		)
	`).run();
	return db.select().from(backupLog).orderBy(desc(backupLog.createdAt)).limit(limit).all();
}

function logBackup(entry: {
	destinationType: string;
	destinationName: string;
	filename: string;
	sizeBytes: number;
	status: 'success' | 'failed';
	error?: string;
	durationMs: number;
}) {
	db.insert(backupLog).values({
		destinationType: entry.destinationType,
		destinationName: entry.destinationName,
		filename: entry.filename,
		sizeBytes: entry.sizeBytes,
		status: entry.status,
		error: entry.error || null,
		durationMs: entry.durationMs
	}).run();

	// Prune old history — keep only the last 10 entries
	sqlite.prepare(`
		DELETE FROM backup_log WHERE id NOT IN (
			SELECT id FROM backup_log ORDER BY created_at DESC LIMIT 10
		)
	`).run();
}

// ─── Retention Cleanup ───────────────────────────────────────────────────────

async function cleanupRetention(config: DestinationConfig, retention: number): Promise<void> {
	if (retention <= 0) return;
	try {
		const dest = createDestination(config);
		const files = await dest.list();
		if (files.length > retention) {
			// Files are sorted oldest-first; delete the oldest
			const toDelete = files.slice(0, files.length - retention);
			for (const filename of toDelete) {
				try {
					await dest.delete(filename);
					log.warn(`Retention cleanup: deleted ${filename} from ${config.name}`);
				} catch (err) {
					log.error(`Retention cleanup: failed to delete ${filename}`, err);
				}
			}
		}
	} catch (err) {
		log.error(`Retention cleanup failed for ${config.name}`, err);
	}
}

// ─── Run Backup ──────────────────────────────────────────────────────────────

/**
 * Run a backup to all configured destinations (or a specific one).
 * Returns results for each destination.
 */
export async function runBackup(targetDestinationName?: string): Promise<Array<{
	destination: string;
	status: 'success' | 'failed';
	message: string;
	durationMs: number;
}>> {
	const config = getBackupConfig();
	if (config.destinations.length === 0) {
		return [{ destination: 'none', status: 'failed', message: 'No destinations configured', durationMs: 0 }];
	}

	const destinations = targetDestinationName
		? config.destinations.filter(d => d.name === targetDestinationName)
		: config.destinations;

	if (destinations.length === 0) {
		return [{ destination: targetDestinationName || 'none', status: 'failed', message: 'Destination not found', durationMs: 0 }];
	}

	// Generate backup data (SQLite snapshot)
	const buffer = generateBackupData();
	const filename = `dumpfire-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`;

	const results: Array<{
		destination: string;
		status: 'success' | 'failed';
		message: string;
		durationMs: number;
	}> = [];

	for (const destConfig of destinations) {
		const start = Date.now();
		try {
			const dest = createDestination(destConfig);
			await dest.upload(buffer, filename);
			const durationMs = Date.now() - start;

			logBackup({
				destinationType: destConfig.type,
				destinationName: destConfig.name,
				filename,
				sizeBytes: buffer.length,
				status: 'success',
				durationMs
			});

			// Run retention cleanup
			await cleanupRetention(destConfig, config.retention);

			results.push({
				destination: destConfig.name,
				status: 'success',
				message: `Uploaded ${filename} (${(buffer.length / 1024).toFixed(1)} KB)`,
				durationMs
			});

			log.warn(`Backup succeeded: ${destConfig.name} → ${filename} (${durationMs}ms, ${(buffer.length / 1024).toFixed(1)} KB)`);
		} catch (err: any) {
			const durationMs = Date.now() - start;
			const errMsg = err.message || 'Unknown error';

			logBackup({
				destinationType: destConfig.type,
				destinationName: destConfig.name,
				filename,
				sizeBytes: buffer.length,
				status: 'failed',
				error: errMsg,
				durationMs
			});

			results.push({
				destination: destConfig.name,
				status: 'failed',
				message: errMsg,
				durationMs
			});

			log.error(`Backup failed: ${destConfig.name} → ${errMsg}`);

			// Send failure notification if configured
			if (config.notifyOnFailure && config.notifyEmail && isSmtpConfigured()) {
				try {
					await sendEmail(
						config.notifyEmail,
						'⚠️ DumpFire Backup Failed',
						`<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
							<h2 style="color: #f43f5e;">Scheduled Backup Failed</h2>
							<p style="color: #64748b; line-height: 1.6;">
								A scheduled backup to <strong>${destConfig.name}</strong> (${destConfig.type}) failed.
							</p>
							<div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 16px 0;">
								<strong style="color: #991b1b;">Error:</strong>
								<p style="color: #991b1b; margin: 4px 0 0;">${errMsg}</p>
							</div>
							<p style="color: #94a3b8; font-size: 12px;">Check your Admin Panel → Scheduled Backups for details.</p>
						</div>`
					);
				} catch {
					log.error('Failed to send backup failure notification email');
				}
			}
		}
	}

	return results;
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let lastBackupTime = 0;
let lastCheckedDate = ''; // Track which date+hour we last checked to avoid double-runs

/**
 * Check if now is the right time to run a scheduled backup.
 * For hourly/every6h/every12h: interval-based (elapsed time since last backup).
 * For daily: fires once per day at the configured time.
 * For weekly: fires once per week on the configured day at the configured time.
 */
function isBackupDue(config: BackupConfig, now: Date): boolean {
	if (config.schedule === 'disabled' || config.destinations.length === 0) return false;

	const schedule = config.schedule;

	// Interval-based schedules (hourly, every6h, every12h)
	if (schedule === 'hourly' || schedule === 'every6h' || schedule === 'every12h') {
		const interval = SCHEDULE_INTERVALS[schedule];
		if (!interval) return false;

		if (lastBackupTime === 0) {
			// On first check, look at the most recent successful backup
			const latest = db.select().from(backupLog)
				.where(eq(backupLog.status, 'success'))
				.orderBy(desc(backupLog.createdAt))
				.limit(1)
				.all();
			if (latest.length > 0) {
				lastBackupTime = new Date(latest[0].createdAt).getTime();
			}
		}

		return now.getTime() - lastBackupTime >= interval;
	}

	// Time-based schedules (daily, weekly)
	const [targetH, targetM] = (config.scheduleTime || '02:00').split(':').map(Number);
	const currentH = now.getHours();
	const currentM = now.getMinutes();

	// Only trigger within the target minute (checked every 60s so we won't miss it)
	if (currentH !== targetH || currentM !== targetM) return false;

	// Prevent double-trigger within the same minute
	const dateKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${currentH}-${currentM}`;
	if (lastCheckedDate === dateKey) return false;

	if (schedule === 'weekly') {
		const targetDay = config.scheduleDay ?? 0; // 0 = Sunday
		if (now.getDay() !== targetDay) return false;
	}

	// daily: correct hour+minute, any day → fire
	// weekly: correct day + hour+minute → fire
	lastCheckedDate = dateKey;
	return true;
}

export function initBackupScheduler(): void {
	if (schedulerTimer) {
		clearInterval(schedulerTimer);
	}

	// Check every 60 seconds if a backup is due
	schedulerTimer = setInterval(async () => {
		try {
			const config = getBackupConfig();
			const now = new Date();

			if (isBackupDue(config, now)) {
				log.warn(`Scheduled backup triggered (${config.schedule} at ${config.scheduleTime || 'now'})`);
				lastBackupTime = now.getTime();
				await runBackup();
			}
		} catch (err) {
			log.error('Scheduler error', err);
		}
	}, 60_000);

	log.warn('Backup scheduler initialized');
}
