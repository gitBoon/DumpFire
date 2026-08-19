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

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

/** Structured identity fields attachable to any log entry. */
export type LogFields = {
	userId?: number | null;
	ip?: string | null;
};

export type LogEntry = {
	id: number;
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
function ensureTable(): boolean {
	if (dbReady) return true;
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

function persist(entry: LogEntry): void {
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

// ─── Retention ──────────────────────────────────────────────────────────────

const MAX_LOG_ROWS = 50_000;
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

/** Delete entries past the retention window, and hard-cap total row count. */
export function cleanOldSystemLogs(): void {
	if (!ensureTable()) return;
	try {
		const retentionDays = Number(process.env.LOG_RETENTION_DAYS) || 30;
		const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
		sqlite.prepare('DELETE FROM system_logs WHERE timestamp < ?').run(cutoff);
		sqlite.prepare(
			'DELETE FROM system_logs WHERE id NOT IN (SELECT id FROM system_logs ORDER BY id DESC LIMIT ?)'
		).run(MAX_LOG_ROWS);
	} catch (err) {
		console.error(`[LOGGER] Log retention cleanup failed: ${(err as Error)?.message}`);
	}
}

/** Start periodic retention cleanup (idempotent). Called once from hooks. */
export function initLogMaintenance(): void {
	cleanOldSystemLogs();
	if (maintenanceTimer) return;
	maintenanceTimer = setInterval(cleanOldSystemLogs, 6 * 60 * 60 * 1000);
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

function formatLine(entry: LogEntry): string {
	let line = `[${entry.timestamp}] [${entry.level}] [${entry.context}] ${entry.message}`;
	if (entry.meta) line += ` | ${entry.meta}`;
	return line;
}

function emit(level: LogLevel, context: string, message: string, meta?: unknown, fields?: LogFields): void {
	if (LEVEL_RANK[level] < currentThreshold()) return;

	const entry: LogEntry = {
		id: nextEntryId++,
		timestamp: new Date().toISOString(),
		level,
		context,
		message,
		meta: serializeMeta(meta),
		userId: fields?.userId ?? null,
		ip: fields?.ip ?? null
	};

	const line = formatLine(entry);
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
