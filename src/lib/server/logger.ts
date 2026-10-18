/**
 * logger.ts — Structured server-side logger for DumpFire.
 *
 * Every emitted entry goes to three places:
 *   1. stdout/stderr (visible in `docker logs`)
 *   2. the `system_logs` SQLite table (queryable history, pruned by retention)
 *   3. an in-memory ring buffer + emitter (powers the live console feed on /audit)
 *
 * Levels: DEBUG < INFO < WARN < ERROR < CRITICAL. The threshold comes from the
 * LOG_LEVEL env var (default INFO) — entries below it are dropped entirely.
 *
 * Format:  [TIMESTAMP] [LEVEL] [CONTEXT] message
 * Example: [2026-04-09T10:30:00.123Z] [ERROR] [BACKUP] Upload failed: timeout
 */

import { EventEmitter } from 'node:events';
import { sqlite } from './db';
// uploads.ts imports nothing that imports this module, and has to stay so.
import { emptyTrash } from './uploads';
import { stamp } from '$lib/timestamps';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

/** Structured identity fields attachable to any log entry. */
export type LogFields = {
	userId?: number | null;
	ip?: string | null;
};

export type LogEntry = {
	id: number;
	/** When it was logged, in the stored form: `YYYY-MM-DD HH:MM:SS`, UTC. */
	timestamp: string;
	level: LogLevel;
	context: string;
	message: string;
	meta: string | null;
	userId: number | null;
	ip: string | null;
};

const LEVEL_RANK: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, CRITICAL: 4 };

function currentThreshold(): number {
	const configured = (process.env.LOG_LEVEL || 'INFO').toUpperCase() as LogLevel;
	return LEVEL_RANK[configured] ?? LEVEL_RANK.INFO;
}

/** Whether an entry at `level` is kept and written under the LOG_LEVEL set now. */
export function isLogged(level: LogLevel): boolean {
	return LEVEL_RANK[level] >= currentThreshold();
}

// ─── Live feed (ring buffer + emitter) ──────────────────────────────────────

const RING_BUFFER_SIZE = 300;
const ringBuffer: LogEntry[] = [];
let nextEntryId = 1;

// A single process-wide emitter; SSE connections subscribe/unsubscribe freely.
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

/** Last N in-memory entries (newest last). Used to backfill the live feed. */
export function getRecentLogs(limit = RING_BUFFER_SIZE): LogEntry[] {
	return ringBuffer.slice(-limit);
}

/** Subscribe to live log entries. Returns an unsubscribe function. */
export function subscribeToLogs(listener: (entry: LogEntry) => void): () => void {
	emitter.on('log', listener);
	return () => emitter.off('log', listener);
}

// ─── SQLite persistence ─────────────────────────────────────────────────────

// Self-healing: the logger may fire before migration 0039 has been applied
// (e.g. during the migration run itself), so it creates its own table.
let dbReady = false;

/**
 * Create `system_logs` now if it is not there.
 *
 * The migration runner calls this before its first transaction. Left to the
 * first log entry, the table could be created inside a migration's transaction
 * and then rolled back with it, leaving `dbReady` true and no table behind.
 */
export function ensureSystemLogsTable(): boolean {
	try {
		sqlite.exec(`CREATE TABLE IF NOT EXISTS system_logs (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			timestamp TEXT NOT NULL,
			level TEXT NOT NULL,
			context TEXT NOT NULL,
			message TEXT NOT NULL,
			meta TEXT,
			user_id INTEGER,
			ip TEXT
		)`);
		dbReady = true;
	} catch {
		// DB unavailable — console-only until it recovers
	}
	return dbReady;
}

function ensureTable(): boolean {
	return dbReady || ensureSystemLogsTable();
}

function writeRow(entry: LogEntry): void {
	if (!ensureTable()) return;
	try {
		sqlite.prepare(
			'INSERT INTO system_logs (timestamp, level, context, message, meta, user_id, ip) VALUES (?, ?, ?, ?, ?, ?, ?)'
		).run(entry.timestamp, entry.level, entry.context, entry.message, entry.meta, entry.userId, entry.ip);
	} catch (err) {
		// Never let logging break the request path — console is the fallback
		console.error(`[LOGGER] Failed to persist log entry: ${(err as Error)?.message}`);
	}
}

// Rows logged while a transaction is open on the connection, oldest first.
//
// The logger writes on the application's only connection, so a row written
// inside a transaction is rolled back with it, and the line that explains why
// a write failed is the one that vanishes. Such a row is kept here and written
// once the transaction is over, whichever way it ended. The console and the
// live feed have had it at once either way.
const pendingRows: LogEntry[] = [];

// A transaction that is never closed must not grow this for ever. Past the
// cap the oldest rows go, and the flush says how many.
const MAX_PENDING_ROWS = 2000;
let pendingRowsDropped = 0;

function persist(entry: LogEntry): void {
	if (sqlite.inTransaction) {
		pendingRows.push(entry);
		if (pendingRows.length > MAX_PENDING_ROWS) {
			pendingRows.shift();
			pendingRowsDropped++;
		}
		return;
	}
	// Rows held during a transaction that `inTransaction` did not open (a
	// migration, a restore) have nobody to flush them, so they go in here,
	// ahead of this one.
	flushPendingLogs();
	writeRow(entry);
}

/**
 * Write the rows that were logged while a transaction was open, in the order
 * they were logged and with the time they were logged at.
 *
 * `inTransaction` calls this when its outermost transaction ends, committed or
 * rolled back. Does nothing while a transaction is still open.
 */
export function flushPendingLogs(): void {
	if (sqlite.inTransaction) return;
	if (pendingRows.length === 0 && pendingRowsDropped === 0) return;

	const rows = pendingRows.splice(0);
	if (pendingRowsDropped > 0) {
		const dropped = pendingRowsDropped;
		pendingRowsDropped = 0;
		writeRow({
			id: 0,
			timestamp: rows[0]?.timestamp ?? stamp(),
			level: 'WARN',
			context: 'LOGGER',
			message: `${dropped} earlier log line(s) written inside one transaction were printed but not stored: more than ${MAX_PENDING_ROWS} were waiting for it to end`,
			meta: null,
			userId: null,
			ip: null
		});
	}
	for (const row of rows) writeRow(row);
}

// ─── Retention ──────────────────────────────────────────────────────────────

const MAX_LOG_ROWS = 50_000;
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

/** Delete entries past the retention window, and hard-cap total row count. */
export function cleanOldSystemLogs(): void {
	if (!ensureTable()) return;
	try {
		const retentionDays = Number(process.env.LOG_RETENTION_DAYS) || 30;
		const cutoff = stamp(new Date(Date.now() - retentionDays * 86400000));
		sqlite.prepare('DELETE FROM system_logs WHERE timestamp < ?').run(cutoff);
		sqlite.prepare(
			'DELETE FROM system_logs WHERE id NOT IN (SELECT id FROM system_logs ORDER BY id DESC LIMIT ?)'
		).run(MAX_LOG_ROWS);
	} catch (err) {
		console.error(`[LOGGER] Log retention cleanup failed: ${(err as Error)?.message}`);
	}
}

/**
 * Empty the uploads trash of what has been in it for 30 days (`emptyTrash`,
 * in uploads.ts, which says what the trash is). It reaches nothing outside
 * the trash folder, and a failure is logged and goes no further.
 */
export function emptyOldTrash(): void {
	try {
		const { removed, failed } = emptyTrash();
		if (removed > 0) {
			info('UPLOADS', `The trash was emptied of the attachment files of ${removed} card(s), deleted 30 days ago or more`);
		}
		if (failed.length > 0) {
			warn('UPLOADS', `${failed.length} folder(s) of the uploads trash were due to be removed and could not be`, {
				folders: failed.slice(0, 10)
			});
		}
	} catch (err) {
		warn('UPLOADS', `The uploads trash was not emptied: ${(err as Error)?.message}`);
	}
}

/**
 * Start periodic retention cleanup (idempotent). Called once from hooks.
 *
 * The log is pruned now and then every six hours. The uploads trash is
 * emptied ten minutes from now and then every six hours, and not now: nothing
 * is removed from the disk as the server starts. Without the run at ten
 * minutes, a server restarted more often than every six hours never emptied
 * its trash. That one timer does not keep the process alive, and a second
 * call starts neither it nor the interval again.
 */
export function initLogMaintenance(): void {
	cleanOldSystemLogs();
	if (maintenanceTimer) return;
	maintenanceTimer = setInterval(() => {
		cleanOldSystemLogs();
		emptyOldTrash();
	}, 6 * 60 * 60 * 1000);
	setTimeout(emptyOldTrash, 10 * 60 * 1000).unref();
}

// ─── Core emit ──────────────────────────────────────────────────────────────

function serializeMeta(meta: unknown): string | null {
	if (meta === undefined || meta === null) return null;
	if (meta instanceof Error) {
		return JSON.stringify({ error: meta.message, stack: meta.stack });
	}
	if (typeof meta === 'string') return JSON.stringify({ detail: meta });
	try {
		return JSON.stringify(meta);
	} catch {
		return JSON.stringify({ detail: '[unserializable]' });
	}
}

/**
 * The console line. Its time is ISO 8601 with milliseconds, as a console line
 * has always been; the row and the live feed carry the stored form (card 2095).
 */
function formatLine(entry: LogEntry, at: Date): string {
	let line = `[${at.toISOString()}] [${entry.level}] [${entry.context}] ${entry.message}`;
	if (entry.meta) line += ` | ${entry.meta}`;
	return line;
}

function emit(level: LogLevel, context: string, message: string, meta?: unknown, fields?: LogFields): void {
	if (LEVEL_RANK[level] < currentThreshold()) return;

	const at = new Date();
	const entry: LogEntry = {
		id: nextEntryId++,
		timestamp: stamp(at),
		level,
		context,
		message,
		meta: serializeMeta(meta),
		userId: fields?.userId ?? null,
		ip: fields?.ip ?? null
	};

	const line = formatLine(entry, at);
	if (level === 'ERROR' || level === 'CRITICAL') console.error(line);
	else if (level === 'WARN') console.warn(line);
	else console.log(line);

	persist(entry);

	ringBuffer.push(entry);
	if (ringBuffer.length > RING_BUFFER_SIZE) ringBuffer.shift();
	emitter.emit('log', entry);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Log fine-grained diagnostics. Dropped unless LOG_LEVEL=DEBUG. */
export function debug(context: string, message: string, meta?: unknown, fields?: LogFields): void {
	emit('DEBUG', context, message, meta, fields);
}

/**
 * Log normal operations worth an audit trail.
 * Examples: request handled, session created, login succeeded.
 */
export function info(context: string, message: string, meta?: unknown, fields?: LogFields): void {
	emit('INFO', context, message, meta, fields);
}

/**
 * Log a warning — something unexpected but recoverable.
 * Examples: deprecated usage, missing optional config, retries.
 */
export function warn(context: string, message: string, meta?: unknown, fields?: LogFields): void {
	emit('WARN', context, message, meta, fields);
}

/**
 * Log an error — an operation failed but the server continues.
 * Examples: failed email send, failed backup upload, DB query error.
 */
export function error(context: string, message: string, meta?: unknown, fields?: LogFields): void {
	emit('ERROR', context, message, meta, fields);
}

/**
 * Log a critical issue — the server may be in a degraded state.
 * Examples: database corruption, migration failure, unrecoverable state.
 */
export function critical(context: string, message: string, meta?: unknown, fields?: LogFields): void {
	emit('CRITICAL', context, message, meta, fields);
}

/** Convenience: create a scoped logger for a specific context. */
export function createLogger(context: string) {
	return {
		debug: (message: string, meta?: unknown, fields?: LogFields) => debug(context, message, meta, fields),
		info: (message: string, meta?: unknown, fields?: LogFields) => info(context, message, meta, fields),
		warn: (message: string, meta?: unknown, fields?: LogFields) => warn(context, message, meta, fields),
		error: (message: string, meta?: unknown, fields?: LogFields) => error(context, message, meta, fields),
		critical: (message: string, meta?: unknown, fields?: LogFields) => critical(context, message, meta, fields)
	};
}
