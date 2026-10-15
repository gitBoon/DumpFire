import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { join } from 'node:path';
import { DatabaseLocationError, checkDatabaseLocation, type OtherDatabase } from './location';

const DB_PATH = process.env.DB_PATH || join(process.cwd(), 'dumpfire.db');

// Looked at before the open, because opening a path creates the file. At the
// image's path, with nothing written there while a database this server can
// see is somewhere else, it throws, and the server stops before it listens
// (exit code 1), as a failed migration stops it: see db/location.ts. The
// system log is in this database, which is not open, so the line goes to the
// console alone.
let location: ReturnType<typeof checkDatabaseLocation>;
try {
	location = checkDatabaseLocation(DB_PATH);
} catch (err) {
	if (err instanceof DatabaseLocationError) console.error(err.line);
	throw err;
}

const sqlite = new Database(DB_PATH);

// Enable WAL mode for blazing fast reads
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('cache_size = -64000'); // 64MB cache

export const db = drizzle(sqlite, { schema });
export { sqlite };
export function getDbPath(): string { return DB_PATH; }
/** Whether there was no database file, or an empty one, before this start opened it. */
export function createdAtStart(): boolean { return location.isNew; }
/**
 * A database at `<working directory>/dumpfire.db` beside the image's one in
 * use, with the one in use as it was before this start opened it, or null.
 */
export function otherDatabaseAtStart(): OtherDatabase | null { return location.other; }
