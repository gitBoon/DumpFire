/**
 * logger.ts — Structured server-side logger for DumpFire.
 *
 * Outputs timestamped, levelled log lines to stdout/stderr so they appear
 * in `docker logs`.  Only WARN, ERROR, and CRITICAL levels are emitted —
 * debug/info noise is intentionally excluded.
 *
 * Format:  [TIMESTAMP] [LEVEL] [CONTEXT] message
 * Example: [2026-04-09T10:30:00.123Z] [ERROR] [BACKUP] Upload failed: timeout
 */

export type LogLevel = 'WARN' | 'ERROR' | 'CRITICAL';

function formatTimestamp(): string {
	return new Date().toISOString();
}

function formatMessage(level: LogLevel, context: string, message: string, meta?: unknown): string {
	const ts = formatTimestamp();
	let line = `[${ts}] [${level}] [${context}] ${message}`;
	if (meta !== undefined && meta !== null) {
		if (meta instanceof Error) {
			line += ` | ${meta.message}`;
			if (meta.stack) {
				line += `\n${meta.stack}`;
			}
		} else if (typeof meta === 'string') {
			line += ` | ${meta}`;
		} else {
			try {
				line += ` | ${JSON.stringify(meta)}`;
			} catch {
				line += ` | [unserializable]`;
			}
		}
	}
	return line;
}

/**
 * Log a warning — something unexpected but recoverable.
 * Examples: deprecated usage, missing optional config, retries.
 */
export function warn(context: string, message: string, meta?: unknown): void {
	console.warn(formatMessage('WARN', context, message, meta));
}

/**
 * Log an error — an operation failed but the server continues.
 * Examples: failed email send, failed backup upload, DB query error.
 */
export function error(context: string, message: string, meta?: unknown): void {
	console.error(formatMessage('ERROR', context, message, meta));
}

/**
 * Log a critical issue — the server may be in a degraded state.
 * Examples: database corruption, migration failure, unrecoverable state.
 */
export function critical(context: string, message: string, meta?: unknown): void {
	console.error(formatMessage('CRITICAL', context, message, meta));
}

/** Convenience: create a scoped logger for a specific context. */
export function createLogger(context: string) {
	return {
		warn: (message: string, meta?: unknown) => warn(context, message, meta),
		error: (message: string, meta?: unknown) => error(context, message, meta),
		critical: (message: string, meta?: unknown) => critical(context, message, meta)
	};
}
