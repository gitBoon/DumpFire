import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { join } from 'node:path';

const DB_PATH = process.env.DB_PATH || join(process.cwd(), 'dumpfire.db');

const sqlite = new Database(DB_PATH);

// Enable WAL mode for blazing fast reads
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('cache_size = -64000'); // 64MB cache

export const db = drizzle(sqlite, { schema });
export { sqlite };
