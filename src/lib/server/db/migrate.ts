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
				// Split on Drizzle's statement-breakpoint markers. Hand-written files
				// use "-->statement-breakpoint", drizzle-kit generates
				// "--> statement-breakpoint" — accept both, or a single failing
				// statement aborts the whole file's exec and the rest never runs.
				const statements = raw
					.split(/-->\s*statement-breakpoint/)
					.map((s) => s.trim())
					.filter((s) => s.length > 0);

				let hardFailure = false;
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
							hardFailure = true;
						}
					}
				}

				// Only record the migration when every statement succeeded or was
				// tolerably skipped — a hard failure must retry on the next boot,
				// not be silently marked as applied with statements missing.
				if (hardFailure) {
					log.error(`Migration ${file} had failing statements — will retry on next start`);
				} else {
					sqlite.prepare('INSERT INTO __drizzle_migrations (hash) VALUES (?)').run(hash);
					log.warn(`Applied migration: ${file}`);
				}
			}
		}
	} catch (err) {
		log.critical('Migration error', err);
	}
}
