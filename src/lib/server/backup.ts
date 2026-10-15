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
import { escapeHtml } from '$lib/escape-html';
import { sendEmail, isSmtpConfigured } from './email';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './logger';
import { maskSecretsInLog } from './secret-paths';
import { KNOWN_BROWSER_SECRET_KEY } from './known-browsers';

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

/** Every schedule there is, as PUT /api/admin/backup reads one. */
export const BACKUP_SCHEDULES: readonly BackupSchedule[] = ['disabled', 'hourly', 'every6h', 'every12h', 'daily', 'weekly'];

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
 * Write to `to` the database file at `from` with everything taken out of it
 * that signs somebody in by being held: every session, and every invite that
 * has not been used, wherever it is written; and the key remembered browsers
 * are signed with (known-browsers.ts), which a restore is meant to lose.
 *
 * A session's id is the whole of what its cookie carries, and an unused
 * invite's token sets its account's password. A backup that held them signed
 * in whoever read it, as anybody who was signed in when it was made, for as
 * long as that session went on being used. Password hashes stay: a backup that
 * cannot restore its users is not a backup.
 *
 * An invite's token is also the last part of its address, and the system log
 * wrote that address down for every request to it until the gate masked it
 * (`pathToLog`, in secret-paths.ts). So the log's lines are masked here too,
 * as the gate masks them now, and any line that still holds the token of an
 * unused invite anywhere else has it replaced (`maskSecretsInLog`): an
 * installation whose log already holds tokens makes backups that do not. The
 * running database's log is masked by the same rule once at every start.
 *
 * Deleting the rows is not enough. The pages they were on are still in the
 * file, with the ids in them: after a plain DELETE of 400 sessions, their ids
 * were found in the file 925 times. So the copy is written out again, from the
 * rows it still has, with `VACUUM INTO` to `to`, and only then is nothing of
 * them left. `to` is the file to read; `from` is thrown away.
 *
 * Written out, and not vacuumed in place: a `VACUUM` of the copy needs a
 * rollback journal on the volume as large as the copy, and was measured
 * taking two to three times as long as `VACUUM INTO` (docs/deployment.md, "What
 * a Backup Holds"). For the same reason `from` keeps no journal at all while
 * its rows are deleted: nothing of it is kept, so nothing of it needs undoing.
 *
 * `from` is a copy. This is never given the running database.
 *
 * A table that is not there is skipped. Anything else that goes wrong is
 * thrown: a copy that could not be cleared is not one to hand on.
 */
export function withoutSignIns(from: string, to: string): void {
	const copy = new Database(from);
	try {
		// better-sqlite3 opens every connection in SQLite's defensive mode,
		// which refuses `journal_mode = OFF` without an error and keeps the
		// journal on the disk. This connection is to a copy that is thrown away
		// once `to` is written, so it is let have no journal.
		copy.unsafeMode(true);
		copy.pragma('journal_mode = OFF');
		const has = (table: string) =>
			!!copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

		// The log first, while the unused invites whose tokens it looks for are
		// still there to be asked. The same rule the running log is masked with
		// at start: see maskSecretsInLog.
		maskSecretsInLog(copy);
		if (has('sessions')) copy.prepare('DELETE FROM sessions').run();
		if (has('invite_tokens')) copy.prepare('DELETE FROM invite_tokens WHERE used = 0').run();
		// The key remembered browsers are signed with (card 2194): whoever held
		// it could make a cookie that skips sign-in's throttling for any account
		// whose hash they also hold, and a backup holds every hash.
		if (has('settings')) copy.prepare('DELETE FROM settings WHERE key = ?').run(KNOWN_BROWSER_SECRET_KEY);

		copy.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
	} finally {
		copy.close();
	}
}

/**
 * Generate a consistent SQLite backup file, with no session and no unused
 * invite in it.
 *
 * Uses VACUUM INTO to create a complete, self-contained .db copy that includes
 * all WAL data — readFileSync alone would miss unflushed WAL entries. The copy
 * is then cleared of what signs somebody in and written out again
 * (`withoutSignIns`), and that second file is read. The running database is
 * not touched by any of it: its sessions are as they were.
 *
 * The export the superadmin downloads and the copy a schedule uploads are
 * both made here, so that neither can hold what the other does not.
 *
 * Two `VACUUM INTO`s, then, and every step of it is synchronous: better-sqlite3
 * waits on SQLite, and the file is read with `readFileSync`. So the server
 * answers nothing for the whole of it, both copies, the masking, the deletes
 * and the read, and not only while the first copy reads the running database.
 * How long that is was measured only in parts, on a made-up 196 MB database
 * on a development machine: 0.7 to 1.5 s for the first copy and 0.5 to 1.3 s
 * for the second, so about 1.2 to 2.8 s for the two added together, and the
 * rest on top, unmeasured (docs/deployment.md, "How long the server stops
 * answering"). Expect more on a larger database.
 *
 * The two files are written beside the database, which is where there is room
 * for them. A database in memory has nothing beside it, so they go to a
 * folder of their own under the temp folder.
 */
export function generateBackupData(): Buffer<ArrayBuffer> {
	const dbPath = getDbPath();
	const tempDir = dbPath === ':memory:' ? mkdtempSync(join(tmpdir(), 'dumpfire-backup-')) : null;
	const backupPath = tempDir ? join(tempDir, 'backup.db') : dbPath + '.backup-temp';
	const clearedPath = tempDir ? join(tempDir, 'backup-cleared.db') : dbPath + '.backup-temp-cleared';

	// The two files, and what SQLite may leave beside one while it is being changed.
	const removeCopy = () => {
		for (const path of [backupPath, clearedPath]) {
			for (const suffix of ['', '-journal', '-wal', '-shm']) {
				try { unlinkSync(path + suffix); } catch {}
			}
		}
	};

	// Remove any stale temp file
	removeCopy();

	try {
		// VACUUM INTO creates a fresh, complete copy including all WAL data
		sqlite.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

		withoutSignIns(backupPath, clearedPath);

		return readFileSync(clearedPath);
	} finally {
		// Clean up temp file, whether or not it could be made and cleared
		removeCopy();
		if (tempDir) {
			try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
		}
	}
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

			// Send failure notification if configured. The error is whatever the
			// destination's server answered, so it and the destination's name
			// and type are escaped where they are put (card 2149).
			if (config.notifyOnFailure && config.notifyEmail && isSmtpConfigured()) {
				try {
					await sendEmail(
						config.notifyEmail,
						'⚠️ DumpFire Backup Failed',
						`<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
							<h2 style="color: #f43f5e;">Scheduled Backup Failed</h2>
							<p style="color: #64748b; line-height: 1.6;">
								A scheduled backup to <strong>${escapeHtml(String(destConfig.name))}</strong> (${escapeHtml(String(destConfig.type))}) failed.
							</p>
							<div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 16px 0;">
								<strong style="color: #991b1b;">Error:</strong>
								<p style="color: #991b1b; margin: 4px 0 0;">${escapeHtml(String(errMsg))}</p>
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
