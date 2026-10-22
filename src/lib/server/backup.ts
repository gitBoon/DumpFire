/**
 * backup.ts — Scheduled backup orchestrator for DumpFire.
 *
 * Manages backup scheduling, generates backup data, uploads to configured
 * destinations, and maintains a backup history log.
 */

import { db, sqlite, getDbPath } from './db';
import { settings, backupLog } from './db/schema';
import { eq, desc, inArray } from 'drizzle-orm';
import { createDestination, type DestinationConfig } from './backup-destinations';
import { escapeHtml } from '$lib/escape-html';
import { parseStamp } from '$lib/timestamps';
import { sendEmail, isSmtpConfigured } from './email';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './logger';
import { maskSecretsInLog } from './secret-paths';
import { KNOWN_BROWSER_SECRET_KEY } from './known-browsers';
import { REQUEST_FORM_SECRET_KEY } from './request-tokens';
import { backupSealKey, clearSecrets, credentialsMissing, hostKeyMissing, sealCopy } from './backup-secrets';

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

/** How often each schedule runs, in milliseconds; none for `disabled`. PUT /api/admin/backup reads it to weigh a change (card 2270). */
export const SCHEDULE_INTERVALS: Record<BackupSchedule, number> = {
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
 * that signs somebody in by being held, and every secret: every session, and every invite that
 * has not been used, wherever it is written; and the key remembered browsers
 * are signed with (known-browsers.ts), which a restore is meant to lose.
 *
 * A session's id is the whole of what its cookie carries, and an unused
 * invite's token sets its account's password. A backup that held them signed
 * in whoever read it, as anybody who was signed in when it was made, for as
 * long as that session went on being used. Password hashes stay: a backup that
 * cannot restore its users is not a backup.
 *
 * Nor does it hold a task request's link (card 2158). A request's
 * `access_token` is the whole of the key to its thread: whoever has it reads
 * every message, the ones written after the copy was made included, replies
 * as the requester and confirms a request not yet confirmed, and it never
 * expires. So every token is NULL in the copy; the request rows themselves
 * stay. A restore gives every request a new token whatever the backup holds
 * (`restoreFromBackup`), and a backup with no tokens restored by an older
 * build has them filled in by its backfill. The key the public request form
 * signs its tokens with (`request_form_secret`, request-tokens.ts) is left out
 * too: it lets nobody do more than opening the form does, but it is a secret,
 * and a restore makes a new one at first use.
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
 * Nor does it hold a secret (card 2169): not the mail password, not a backup
 * destination's credentials, not a webhook's signing secret (`clearSecrets`,
 * in backup-secrets.ts). Whoever read one copy could send mail as the server,
 * read, replace or delete the copies at every destination, and sign forged
 * deliveries to every webhook's receiver. A webhook that had a secret is
 * switched off in the copy and listed in `webhook_secrets_left_out`: the file
 * can become a database without a restore, by hand or in an older image, and
 * left on with no secret it would send every event unsigned. A restore keeps
 * this server's own secrets where they are for the same account, and says
 * what is to be entered again.
 *
 * And it is sealed (the review's S1): once cleared, an HMAC-SHA256 over every
 * row of the copy, with this server's key (`backupSealKey`, made the first
 * time and held by no backup), is written into it as the `backup_seal`
 * setting (`sealCopy`). A restore fills this server's secrets only into a
 * backup whose seal it can make again with its own key: one this server made,
 * changed by nobody since. `key` is this server's unless a test gives another.
 *
 * `from` is a copy. This is never given the running database, and
 * `clearSecrets` refuses it if it is.
 *
 * A table that is not there is skipped. Anything else that goes wrong is
 * thrown: a copy that could not be cleared is not one to hand on.
 */
export function withoutSecrets(from: string, to: string, key: Buffer = backupSealKey()): void {
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
		// Every request's link, and the key the request form signs with (card
		// 2158): see above. The unique index on the token takes any number of NULLs.
		if (has('task_requests')) copy.prepare('UPDATE task_requests SET access_token = NULL').run();
		if (has('settings')) copy.prepare('DELETE FROM settings WHERE key = ?').run(REQUEST_FORM_SECRET_KEY);
		// The mail password, the destinations' credentials and the webhooks'
		// secrets (card 2169): see above.
		clearSecrets(copy);
		// Sealed last, over the copy as it is written out: `VACUUM INTO` moves
		// rows to other pages and changes none of them, and the seal is taken
		// over the rows (see above).
		sealCopy(copy, key);

		copy.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
	} finally {
		copy.close();
	}
}

/**
 * Generate a consistent SQLite backup file, with no session, no unused
 * invite, no request link and no secret in it.
 *
 * Uses VACUUM INTO to create a complete, self-contained .db copy that includes
 * all WAL data — readFileSync alone would miss unflushed WAL entries. The copy
 * is then cleared of what signs somebody in and of every secret, and written
 * out again (`withoutSecrets`), sealed, and that second file is read. The
 * running database is not touched by any of it: its sessions, its mail
 * password, its destinations' credentials and its webhooks are as they were.
 * The one thing written to it is the key backups are sealed with, by the
 * first backup the server makes, and never again.
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
 * answering"). Expect more on a larger database. The seal (card 2169's S1)
 * reads every row of the copy once more: 0.2 s for a made-up 59 MB copy of
 * 115,000 rows, 0.56 s for 177 MB and 345,000, on the same kind of machine.
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

		withoutSecrets(backupPath, clearedPath);

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

/**
 * How many runs Backup History keeps (card 2413). A run is the rows that share
 * a file name: `runBackup` names its copy once, from the run's start, and
 * writes one row a destination with that name. The history kept the newest 10
 * rows, so four destinations left under three runs; by runs, every row of each
 * is kept, at most 30 a destination. By age was not taken: 30 days of an
 * hourly schedule is 720 rows a destination.
 */
export const BACKUP_HISTORY_RUNS = 30;

/** The file names of the newest `?` runs, newest first: a run by its newest row. */
const NEWEST_RUNS = `
	SELECT filename FROM backup_log GROUP BY filename
	ORDER BY MAX(created_at) DESC, MAX(id) DESC LIMIT ?
`;

/**
 * A successful scheduled row: not a ▶ Run Now's, whose file is `…-manual.db`
 * (`MANUAL_COPY`, card 2405). GLOB is case-sensitive, as that pattern is.
 */
const SCHEDULED_SUCCESS = `status = 'success' AND filename NOT GLOB '*-manual.db'`;

/**
 * Every row of the newest `runs` runs of `backup_log`, newest first: what
 * `GET /api/admin/backup` answers as the history, by the rule `logBackup`
 * keeps it to (card 2413; it asked for 30 rows of a table kept at 10). A
 * read, and nothing more: it deleted every row past the newest 10 each time
 * it was called, so the GET wrote (card 2412).
 */
export function getBackupHistory(runs = BACKUP_HISTORY_RUNS) {
	const names = sqlite.prepare(NEWEST_RUNS).pluck().all(runs) as string[];
	if (names.length === 0) return [];
	return db.select().from(backupLog)
		.where(inArray(backupLog.filename, names))
		.orderBy(desc(backupLog.createdAt), desc(backupLog.id))
		.all();
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

	// Prune old history — keep the rows of the newest BACKUP_HISTORY_RUNS runs
	// (card 2413), and the newest successful scheduled row stamped no later
	// than now whatever its age, so that lastScheduledBackupAt() finds it
	// however many Run Now presses or failures came after it. It kept the
	// newest of all, so where that one was stamped ahead (a clock that ran
	// fast) the one read was kept only while in the newest 30 runs (card
	// 2416); one stamped ahead is now kept as any other row is. The one place
	// the history is trimmed: a read of it writes nothing (card 2412).
	sqlite.prepare(`
		DELETE FROM backup_log
		WHERE filename NOT IN (${NEWEST_RUNS})
		AND id IS NOT (SELECT id FROM backup_log WHERE ${SCHEDULED_SUCCESS} AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT 1)
	`).run(BACKUP_HISTORY_RUNS, logStamp(Date.now()));
}

// ─── Retention Cleanup ───────────────────────────────────────────────────────

/**
 * How a copy made by ▶ Run Now is named: the scheduled copy's name with
 * `-manual` before `.db`, so that it still sorts by its time. Keep Last
 * counts such copies apart from the scheduled ones (card 2405).
 */
export const MANUAL_COPY = /-manual\.db$/;

/**
 * Remove the oldest copies of one kind at a destination beyond `retention`:
 * the scheduled copies after a scheduled run, the Run Now copies (`…-manual.db`)
 * after a Run Now, each list kept on its own (card 2405).
 *
 * Keep Last counted every copy, so an administrator who pressed Run Now Keep
 * Last times pushed every older copy out, which card 2398 had made lowering
 * Keep Last the superadmin's to stop. Not pruning on Run Now alone was not
 * enough: the next scheduled run would then have kept the newest copies, Run
 * Now's, and removed the rest. With two lists, a Run Now can push out only
 * older Run Now copies and a scheduled run only older scheduled ones, and a
 * destination holds at most twice Keep Last (the code review: Run Now copies
 * kept until removed by hand grew without limit).
 */
async function cleanupRetention(config: DestinationConfig, retention: number, kind: 'scheduled' | 'manual'): Promise<void> {
	if (retention <= 0) return;
	try {
		const dest = createDestination(config);
		// Only the files retention may remove are counted: one the account may
		// not remove is left, with one warning a run, and not tried every run
		// (card 2238). A destination that cannot tell removes all it lists.
		let files: string[];
		if (dest.listForRetention) {
			const { removable, setAside } = await dest.listForRetention();
			files = removable;
			if (setAside.length > 0) {
				log.warn(
					`Retention: ${setAside.length} file(s) in ${config.name} cannot be removed by this account (for example ${setAside[0]}); remove them by hand as their owner, or make the account a Manager of the Shared drive`
				);
			}
		} else {
			files = await dest.list();
		}
		files = files.filter((filename) => MANUAL_COPY.test(filename) === (kind === 'manual'));
		if (files.length > retention) {
			// Files are sorted oldest-first; delete the oldest
			const toDelete = files.slice(0, files.length - retention);
			for (const filename of toDelete) {
				try {
					const how = (await dest.delete(filename)) === 'trashed' ? 'moved to the trash' : 'deleted';
					log.warn(`Retention cleanup: ${how} ${filename} from ${config.name}`);
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

/** When this process last named a copy, in milliseconds (`copyName`). */
let lastNamedAt = 0;

/**
 * The name of a run's copy: `dumpfire-backup-` and the run's start in UTC to
 * the millisecond, with `-manual` before `.db` for a ▶ Run Now (`MANUAL_COPY`),
 * so that names sort by time (card 2415). It was to the second, so two Run
 * Now presses in one second shared a name: one run in Backup History, and the
 * second upload replaced the first copy. A run named in the same millisecond
 * as the one before it, or a moment before it, is named a millisecond after
 * it, so that no two runs of this process share a name; a clock put back
 * further than a second names by the clock.
 */
function copyName(manual: boolean): string {
	let at = Date.now();
	if (at <= lastNamedAt && at > lastNamedAt - 1000) at = lastNamedAt + 1;
	lastNamedAt = at;
	return `dumpfire-backup-${new Date(at).toISOString().replace(/[:.]/g, '-').slice(0, 23)}${manual ? '-manual' : ''}.db`;
}

/**
 * Run a backup to all configured destinations (or a specific one).
 * Returns results for each destination.
 *
 * `how` is `scheduled` for the scheduler's runs, which remove the oldest
 * scheduled copies beyond Keep Last, and `manual` for ▶ Run Now (POST
 * /api/admin/backup), whose copy is named `…-manual.db` and which removes
 * only the oldest Run Now copies beyond Keep Last, never a scheduled one
 * (card 2405, `cleanupRetention`).
 */
export async function runBackup(targetDestinationName?: string, how: 'scheduled' | 'manual' = 'scheduled'): Promise<Array<{
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

	const manual = how === 'manual';
	const filename = copyName(manual);

	type Result = { destination: string; status: 'success' | 'failed'; message: string; durationMs: number };
	/** Each destination's result, given in the order the destinations are. */
	const outcome = new Map<DestinationConfig, Result>();

	/** Each destination that failed, and its error, for the run's one failure mail (`mailFailures`). */
	const failures: Array<{ destConfig: DestinationConfig; errMsg: string }> = [];

	/**
	 * A destination that failed: its `backup_log` row, its result and the
	 * ERROR line, and it is kept for the run's failure mail. A row that cannot
	 * be written (the volume too full for the copy may be too full for it) is
	 * said, and the run still answers and sends its mail (card 2416).
	 */
	const failed = (destConfig: DestinationConfig, errMsg: string, durationMs: number, sizeBytes: number) => {
		try {
			logBackup({
				destinationType: destConfig.type,
				destinationName: destConfig.name,
				filename,
				sizeBytes,
				status: 'failed',
				error: errMsg,
				durationMs
			});
		} catch (err) {
			log.error(`Backup History row for ${destConfig.name} could not be written`, err);
		}

		outcome.set(destConfig, {
			destination: destConfig.name,
			status: 'failed',
			message: errMsg,
			durationMs
		});

		log.error(`Backup failed: ${destConfig.name} → ${errMsg}`);
		failures.push({ destConfig, errMsg });
	};

	/**
	 * The failure mail, if one is configured and a destination failed: one a
	 * run, with a paragraph and the error for each destination that failed, in
	 * the destinations' order (card 2415). It was sent once for each, so four
	 * destinations failing sent four mails for one run. The error is whatever
	 * the destination's server answered, so it and the destination's name and
	 * type are escaped where they are put in the mail (card 2149). The mail
	 * says which kind of run failed: it said "scheduled" for a Run Now too
	 * (card 2413).
	 */
	const mailFailures = async () => {
		if (failures.length === 0 || !(config.notifyOnFailure && config.notifyEmail && isSmtpConfigured())) return;
		const each = failures.map(({ destConfig, errMsg }) => `
						<p style="color: #64748b; line-height: 1.6;">
							${manual ? 'A backup made by ▶ Run Now to' : 'A scheduled backup to'} <strong>${escapeHtml(String(destConfig.name))}</strong> (${escapeHtml(String(destConfig.type))}) failed.
						</p>
						<div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 16px 0;">
							<strong style="color: #991b1b;">Error:</strong>
							<p style="color: #991b1b; margin: 4px 0 0;">${escapeHtml(String(errMsg))}</p>
						</div>`).join('');
		try {
			await sendEmail(
				config.notifyEmail,
				'⚠️ DumpFire Backup Failed',
				`<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
						<h2 style="color: #f43f5e;">${manual ? 'Run Now Backup Failed' : 'Scheduled Backup Failed'}</h2>${each}
						<p style="color: #94a3b8; font-size: 12px;">Check your Admin Panel → Scheduled Backups for details.</p>
					</div>`
			);
		} catch {
			log.error('Failed to send backup failure notification email');
		}
	};

	// A destination whose credentials are not entered is not tried (card 2169,
	// decision 8): a backup does not hold them, so after a restore onto
	// another server they are entered again, and until then Backup History
	// says so where it would have shown a library's error. Asked before the
	// copy is made, which stops the server answering for seconds: a run with
	// no destination that can take it makes none (the plan's N2). Nor is an
	// SFTP destination whose host key is not confirmed (card 2250, decision
	// 6): it would send its password, and the backup, to whoever answered.
	const ready: DestinationConfig[] = [];
	for (const destConfig of destinations) {
		const missing = credentialsMissing(destConfig) ?? hostKeyMissing(destConfig);
		if (missing === null) ready.push(destConfig);
		else failed(destConfig, missing, 0, 0);
	}

	/** The run's failure mail, then each destination's result in the destinations' order. */
	const finish = async () => {
		await mailFailures();
		return destinations.flatMap((destConfig) => outcome.get(destConfig) ?? []);
	};
	if (ready.length === 0) return finish();

	// Generate backup data (SQLite snapshot). A copy that cannot be made (the
	// volume beside the database full, a disk error) fails each destination
	// that was to be tried, with its row and the reason, and the run's one
	// failure mail says it (card 2416). It threw out of the run: no row, no
	// mail, and a 500 for ▶ Run Now. The scheduler tries it again as a run
	// that failed at every destination, these not being failures before
	// anything was sent.
	const copyStart = Date.now();
	let buffer: Buffer<ArrayBuffer>;
	try {
		buffer = generateBackupData();
	} catch (err: any) {
		log.error('The copy of the database could not be made', err);
		const reason = `The copy of the database could not be made: ${err?.message || 'Unknown error'}`;
		const durationMs = Date.now() - copyStart;
		for (const destConfig of ready) failed(destConfig, reason, durationMs, 0);
		return finish();
	}

	for (const destConfig of ready) {
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

			// Run retention cleanup over this run's own kind of copy (card 2405).
			await cleanupRetention(destConfig, config.retention, how);

			outcome.set(destConfig, {
				destination: destConfig.name,
				status: 'success',
				message: `Uploaded ${filename} (${(buffer.length / 1024).toFixed(1)} KB)`,
				durationMs
			});

			log.warn(
				`Backup succeeded: ${destConfig.name} → ${filename} (${durationMs}ms, ${(buffer.length / 1024).toFixed(1)} KB)` +
					(manual ? '. Made by Run Now: Keep Last counts Run Now copies apart from scheduled ones, so only an older Run Now copy can be removed' : '')
			);
		} catch (err: any) {
			failed(destConfig, err.message || 'Unknown error', Date.now() - start, buffer.length);
		}
	}

	return finish();
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;

/**
 * How long after a scheduled run that failed at every destination it is tried
 * again, and how many times (card 2415). It waited for the schedule's next
 * run: an hour, 12 hours, a day or a week without a copy after the outage had
 * cleared, where a restart tried again at once. The tries are spent until a
 * run the scheduler makes succeeds at a destination, so that a destination
 * down for days does not send a failure mail every 15 minutes. A restart gives
 * them back, except where the run due has already failed before it: then the
 * start makes one try (the review, `scheduledFailureSince`).
 */
export const BACKUP_RETRY_DELAY = 15 * 60 * 1000;
export const BACKUP_RETRIES = 3;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let lastBackupTime = 0;
/**
 * The latest target time of a daily or weekly schedule this process has
 * decided, in milliseconds: run, found already made, or let pass (card 2415).
 * In place of the local date and minute it ran in, which a restart forgot.
 */
let decidedTarget = 0;
/** What was scheduled at the last check: schedule, time, day, and whether there is a destination (card 2415). */
let scheduledAtLastCheck = '';
/** When the last check was, in milliseconds, or 0 for none since the start (the card 2415 review). */
let lastCheckAt = 0;
/**
 * What the run `isBackupDue` last found due is counted from, in milliseconds:
 * the target time of a daily or weekly schedule, the last scheduled run of an
 * interval one (the card 2415 review).
 */
let dueSince = 0;
/** When a run that failed at every destination is tried again, in milliseconds, or 0 for none (card 2415). */
let retryAt = 0;
/** How many of the `BACKUP_RETRIES` tries are left. */
let retriesLeft = BACKUP_RETRIES;
/** Whether no scheduled run has started since the start (the card 2415 review). */
let firstRunSinceStart = true;
/** The scheduled runs numbered as they start, and the newest that succeeded at a destination (the card 2415 review). */
let runsStarted = 0;
let lastSucceededRun = 0;

/** A time in the form `backup_log` stamps its rows (`datetime('now')`, UTC, to the second). */
const logStamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/**
 * When the newest successful scheduled backup in `backup_log` stamped no
 * later than `now` was made, in milliseconds, or 0 for none: what an interval
 * schedule counts from after a start (card 2412). A row stamped later than
 * `now` (a clock that ran fast, then was put back) is left out (card 2415):
 * counted, it held every hourly, 6-hourly or 12-hourly run off until the real
 * time passed it and one interval more, with nothing said; the scheduler says
 * it now (`warnOfStampAhead`).
 *
 * A row made by ▶ Run Now is not counted. It was, so a Run
 * Now pressed just before a restart moved the next hourly, 6-hourly or
 * 12-hourly run that much later once, which a Run Now without a restart never
 * did (only the scheduler sets `lastBackupTime`). `backup_log` has no column
 * for the kind of run: a Run Now's row is told by its file's name, `…-manual.db`
 * (`MANUAL_COPY`, card 2405), as retention tells its copies. A Run Now made
 * before card 2405 has no `-manual` and is counted, as before.
 *
 * It does not depend on how much history is kept (card 2413): `logBackup`'s
 * trim keeps this row whatever came after it, where ten newer rows of Run Now
 * presses or failures used to push it out and make this 0. One query,
 * the newest such row alone; the row the trim keeps is this one, the newest
 * stamped no later than the trim (card 2416): it kept the newest of all, so
 * where that one was stamped ahead, this one went after 30 runs.
 */
export function lastScheduledBackupAt(now = Date.now()): number {
	const createdAt = sqlite
		.prepare(`SELECT created_at FROM backup_log WHERE ${SCHEDULED_SUCCESS} AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT 1`)
		.pluck()
		.get(logStamp(now)) as string | undefined;
	// Read as UTC, which is what it is: `new Date()` read the stored
	// form as the server's local time (card 2095, A10).
	return createdAt ? parseStamp(createdAt)?.getTime() ?? 0 : 0;
}

/**
 * Say where the newest successful scheduled row is stamped later than the
 * server's clock (the card 2414 review): the clock may have run fast and been
 * put back. Said where the scheduler reads `backup_log`, which is at the first
 * check after a start, and for a daily or weekly schedule once a target time.
 */
function warnOfStampAhead(now: Date): void {
	const ahead = sqlite
		.prepare(`SELECT created_at FROM backup_log WHERE ${SCHEDULED_SUCCESS} AND created_at > ? ORDER BY created_at DESC, id DESC LIMIT 1`)
		.pluck()
		.get(logStamp(now.getTime())) as string | undefined;
	if (!ahead) return;
	log.warn(
		`The last scheduled backup is recorded at ${parseStamp(ahead)?.toISOString() ?? ahead}, later than the server's clock (${now.toISOString()}): ` +
			'the clock may have run fast and been put back. Check the server\'s time.'
	);
}

/**
 * The latest time a daily or weekly schedule was due at or before `now`, in
 * milliseconds (card 2415): the configured time of day, on the configured
 * weekday for `weekly`, on the server's own clock and zone, today's or the one
 * before it where today's is still to come. A date made from a day and a time
 * of day is the wall clock's, so where the clocks change each day still has
 * one: when they go back, a time in the hour that comes twice is the first of
 * the two (01:30 BST), and when they go forward, a time in the hour skipped is
 * read an hour on (01:30 is 02:30 BST). NaN for a time that is not HH:MM.
 */
function latestTarget(config: BackupConfig, now: Date): number {
	const [h, m] = (config.scheduleTime || '02:00').split(':').map(Number);
	const weekly = config.schedule === 'weekly';
	const back = weekly ? (now.getDay() - (config.scheduleDay ?? 0) + 7) % 7 : 0;
	const on = (daysBack: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, h, m).getTime();
	const target = on(back);
	return target <= now.getTime() ? target : on(back + (weekly ? 7 : 1));
}

/**
 * When a successful scheduled backup was made for the target time `target`,
 * in milliseconds, or 0 for none (card 2415): one stamped at or after it and
 * less than an hour later than the server's clock. Its rows are written after
 * its upload, so none is stamped before the target. The hour's allowance is
 * card 2414's: a clock put back across a restart into the target minute,
 * ahead of the first run's stamp, still finds that run. A row stamped further
 * ahead (a clock that ran fast, then corrected) does not count, so it holds
 * no run back (the card 2414 review), however long the trim keeps it.
 */
function scheduledRunSince(target: number, now: Date): number {
	const createdAt = sqlite
		.prepare(`SELECT created_at FROM backup_log WHERE ${SCHEDULED_SUCCESS} AND created_at >= ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT 1`)
		.pluck()
		.get(logStamp(target), logStamp(now.getTime() + HOUR)) as string | undefined;
	return createdAt ? parseStamp(createdAt)?.getTime() ?? 0 : 0;
}

/**
 * Check if now is the right time to run a scheduled backup.
 * For hourly/every6h/every12h: interval-based (elapsed time since last backup).
 * For daily and weekly: when no scheduled backup has been made for the latest
 * target time since it (card 2415, `latestTarget`).
 */
function isBackupDue(config: BackupConfig, now: Date): boolean {
	// What is scheduled, against what the last check saw (card 2415). Where it
	// changed in this process, a daily or weekly target time already passed is
	// not made up: setting a daily 02:00 schedule at 10:00, moving the time to
	// an earlier hour, or adding the first destination would otherwise run a
	// backup within a minute. Only a target time at or before the check before
	// the change is let pass (the review): one after it may have come after the
	// save (the time set to the next minute, or daily switched on just before
	// it), and is run. A start has seen nothing, so it makes up a target time
	// not made since: it cannot tell downtime from a change made before it.
	const scheduled = `${config.schedule} ${config.scheduleTime} ${config.scheduleDay} ${config.destinations.length > 0}`;
	const changed = scheduledAtLastCheck !== '' && scheduledAtLastCheck !== scheduled;
	const previousCheckAt = lastCheckAt;
	scheduledAtLastCheck = scheduled;
	lastCheckAt = now.getTime();

	if (config.schedule === 'disabled' || config.destinations.length === 0) return false;

	const schedule = config.schedule;

	// Interval-based schedules (hourly, every6h, every12h)
	if (schedule === 'hourly' || schedule === 'every6h' || schedule === 'every12h') {
		const interval = SCHEDULE_INTERVALS[schedule];
		if (!interval) return false;

		if (lastBackupTime === 0) {
			// On first check, look at the most recent successful scheduled
			// backup, a Run Now's left out (card 2412), and one stamped later
			// than now too, which is said (card 2415).
			warnOfStampAhead(now);
			lastBackupTime = lastScheduledBackupAt(now.getTime());
		}

		dueSince = lastBackupTime;
		return now.getTime() - lastBackupTime >= interval;
	}

	// Time-based schedules (daily, weekly), card 2415: due where no scheduled
	// backup has been made for the latest target time since it. They ran only
	// in the target minute (local hour and minute), so a server down or busy
	// through it made no copy that day, and a time in the hour the clocks go
	// forward never ran that day. One in the hour they go back is the first of
	// its two times here, so the second finds its row, after a restart too
	// (`latestTarget`). A target time is decided once in this process
	// (`decidedTarget`): a run still uploading has no row yet, and the
	// minute's next check must not start another. Only a finished run is seen
	// from `backup_log`, so another instance on this database checking while
	// one uploads makes a second copy all the same (card 2414).
	const target = latestTarget(config, now);
	if (!Number.isFinite(target)) return false;
	if (changed) decidedTarget = latestTarget(config, new Date(previousCheckAt));
	if (target === decidedTarget) return false;
	decidedTarget = target;
	dueSince = target;

	const time = config.scheduleTime || '02:00';
	const inItsMinute = now.getTime() - target < 60_000;
	warnOfStampAhead(now);
	const made = scheduledRunSince(target, now);
	if (made) {
		// Ordinary after a restart; said where the check is in the target
		// minute itself, as card 2414 said it (a clock put back across a
		// restart, or another instance on this database).
		if (inItsMinute) {
			log.warn(
				`Scheduled ${schedule} backup at ${time} not made: a scheduled backup recorded at ${new Date(made).toISOString()} ` +
					'was already made in this minute (after a restart, or by another instance on this database).'
			);
		}
		return false;
	}
	if (!inItsMinute) {
		log.warn(`Scheduled ${schedule} backup at ${time} was not made at its time, ${new Date(target).toISOString()} (the server was down, or busy past the check): made now.`);
	}
	return true;
}

/**
 * Whether a scheduled run that failed has been recorded since `since` (and no
 * later than now): with no success after it, the run due now has already been
 * tried and failed, before this start (the card 2415 review).
 */
function scheduledFailureSince(since: number, now: Date): boolean {
	return !!sqlite
		.prepare(`SELECT 1 FROM backup_log WHERE status = 'failed' AND filename NOT GLOB '*-manual.db' AND created_at >= ? AND created_at <= ? LIMIT 1`)
		.get(logStamp(since), logStamp(now.getTime()));
}

/**
 * After scheduled run number `run` (card 2415): one that failed at every
 * destination, or stopped before any upload (`results` null), is tried again
 * `BACKUP_RETRY_DELAY` later while any of the `BACKUP_RETRIES` tries are left;
 * one that succeeded at a destination gives them all back.
 *
 * Not tried again (the review): a failure of a run older than one that has
 * since succeeded, the two having overlapped; nor a run where every
 * destination failed before anything was sent (`unfixable`: credentials not
 * entered, or an SFTP host key not confirmed), which only an administrator
 * can put right.
 */
function afterScheduledRun(run: number, results: Array<{ destination: string; status: string }> | null, unfixable: Set<string>, retry: boolean): void {
	if (results?.some((result) => result.status === 'success')) {
		lastSucceededRun = Math.max(lastSucceededRun, run);
		retriesLeft = BACKUP_RETRIES;
		return;
	}
	if (run < lastSucceededRun) return;
	if (results && results.every((result) => unfixable.has(result.destination))) {
		log.warn(
			'Scheduled backup failed at every destination before anything was sent (credentials not entered, or an SFTP host key not confirmed): not tried again, as trying cannot put it right. Enter them in Admin, Scheduled Backups.'
		);
		return;
	}
	if (retriesLeft > 0) {
		retriesLeft--;
		retryAt = Date.now() + BACKUP_RETRY_DELAY;
		log.warn(
			`Scheduled backup failed at every destination: tried again at ${new Date(retryAt).toISOString()} (${BACKUP_RETRIES - retriesLeft} of ${BACKUP_RETRIES}).`
		);
	} else if (retry) {
		log.warn(
			`Scheduled backup failed at every destination, and its ${BACKUP_RETRIES} tries again are spent: the next is the schedule's own, and a run that succeeds gives them back.`
		);
	}
}

export function initBackupScheduler(): void {
	if (schedulerTimer) {
		clearInterval(schedulerTimer);
	}
	// A start remembers nothing from before it, as a new process does (card
	// 2414). Called once a process; a test calls it again for a restart.
	lastBackupTime = 0;
	decidedTarget = 0;
	scheduledAtLastCheck = '';
	lastCheckAt = 0;
	dueSince = 0;
	retryAt = 0;
	retriesLeft = BACKUP_RETRIES;
	firstRunSinceStart = true;

	// Check every 60 seconds if a backup is due
	schedulerTimer = setInterval(async () => {
		try {
			const config = getBackupConfig();
			const now = new Date();

			// A try again is dropped where the schedule was switched off or its
			// last destination removed (card 2415).
			if (config.schedule === 'disabled' || config.destinations.length === 0) retryAt = 0;
			const retry = retryAt !== 0 && now.getTime() >= retryAt;

			if (retry || isBackupDue(config, now)) {
				log.warn(
					retry
						? `Scheduled backup tried again (${BACKUP_RETRIES - retriesLeft} of ${BACKUP_RETRIES}) after a run that failed at every destination`
						: `Scheduled backup triggered (${config.schedule} at ${config.scheduleTime || 'now'})`
				);
				retryAt = 0;
				lastBackupTime = now.getTime();
				// The first run after a start, where the run due has already been
				// tried and failed before it (the review): this is its one try
				// until a run succeeds, so that a server restarted again and again
				// does not send several failure mails a start, or try a refused
				// SFTP login several times a start.
				if (!retry && firstRunSinceStart && scheduledFailureSince(dueSince, now)) {
					retriesLeft = 0;
					log.warn(
						'This scheduled backup already failed before this start: this is its one try until a run succeeds, so that a restart does not try it again and again.'
					);
				}
				firstRunSinceStart = false;
				const run = ++runsStarted;
				const unfixable = new Set(
					config.destinations.filter((d) => (credentialsMissing(d) ?? hostKeyMissing(d)) !== null).map((d) => d.name)
				);
				let results: Awaited<ReturnType<typeof runBackup>> | null = null;
				try {
					results = await runBackup();
				} finally {
					// A run that threw made no copy anywhere. A copy that could not be
					// made no longer throws: each destination fails (card 2416).
					afterScheduledRun(run, results, unfixable, retry);
				}
			}
		} catch (err) {
			log.error('Scheduler error', err);
		}
	}, 60_000);

	log.warn('Backup scheduler initialized');
}
