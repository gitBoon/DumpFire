import { db, sqlite } from './index';
import { boards, columns } from './schema';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../logger';

const log = createLogger('DB');

export function runMigrations() {
	const migrationsDir = join(process.cwd(), 'drizzle');
	
	// Create migrations tracking table
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS __drizzle_migrations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			hash TEXT NOT NULL UNIQUE,
			created_at TEXT DEFAULT (datetime('now'))
		)
	`);

	try {
		const files = readdirSync(migrationsDir)
			.filter((f) => f.endsWith('.sql'))
			.sort();

		for (const file of files) {
			const hash = file;
			const existing = sqlite
				.prepare('SELECT id FROM __drizzle_migrations WHERE hash = ?')
				.get(hash);

			if (!existing) {
				const raw = readFileSync(join(migrationsDir, file), 'utf-8');
				// Split on Drizzle's statement-breakpoint markers
				const statements = raw
					.split('-->statement-breakpoint')
					.map((s) => s.trim())
					.filter((s) => s.length > 0);
				
				let allOk = true;
				for (const stmt of statements) {
					try {
						sqlite.exec(stmt);
					} catch (stmtErr: any) {
						// Tolerate "already exists" / "duplicate column" errors
						const msg = stmtErr?.message || '';
						if (msg.includes('already exists') || msg.includes('duplicate column')) {
							log.warn(`Skipping (already applied): ${msg}`);
						} else {
							log.error(`Statement error in ${file}: ${msg}`);
							allOk = false;
						}
					}
				}
				// Mark migration as applied even if individual statements were skipped
				sqlite.prepare('INSERT INTO __drizzle_migrations (hash) VALUES (?)').run(hash);
				log.warn(`Applied migration: ${file}${allOk ? '' : ' (with warnings)'}`);
			}
		}
	} catch (err) {
		log.critical('Migration error', err);
	}
}
