import { db, sqlite } from './index';
import { boards, columns } from './schema';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
				
				const transaction = sqlite.transaction(() => {
					for (const stmt of statements) {
						sqlite.exec(stmt);
					}
					sqlite.prepare('INSERT INTO __drizzle_migrations (hash) VALUES (?)').run(hash);
				});
				transaction();
				console.log(`[DB] Applied migration: ${file}`);
			}
		}
	} catch {
		console.log('[DB] No migrations directory found, skipping.');
	}
}
