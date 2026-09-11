import { db, sqlite } from './index';
import { boards, columns } from './schema';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../logger';

const log = createLogger('DB');

/**
 * Bring a legacy-shaped `card_dependencies` table up to the current shape,
 * preserving every row.
 *
 * Migration 0036 used to do this in raw SQL, and on a database that already had
 * the modern shape it dropped the table and renamed an empty one over it on
 * every single boot (see the comment in 0036 for the full mechanism). Plain SQL
 * cannot ask "which shape is this table?", so the check lives here instead,
 * where it can be explicit, guarded and idempotent.
 *
 * Runs before the migration loop so that 0042 — which adds a unique index on
 * (card_id, depends_on_card_id) — is guaranteed a table with those columns.
 *
 * Does nothing at all in the overwhelmingly common case: no table, or a table
 * that already has the modern columns.
 */
function repairLegacyCardDependencies() {
	try {
		const exists = sqlite
			.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='card_dependencies'")
			.get();
		if (!exists) return;

		const cols = (sqlite.prepare('PRAGMA table_info(card_dependencies)').all() as { name: string }[])
			.map((c) => c.name);

		// Already current — the only branch that ever runs on a healthy database.
		if (cols.includes('card_id') && cols.includes('depends_on_card_id')) return;

		// Not the legacy shape either: leave it alone rather than guess.
		if (!cols.includes('blocker_card_id') || !cols.includes('blocked_card_id')) {
			log.error(`card_dependencies has an unrecognised shape (${cols.join(', ')}) — leaving it untouched`);
			return;
		}

		const before = (sqlite.prepare('SELECT COUNT(*) n FROM card_dependencies').get() as { n: number }).n;
		log.warn(`Converting ${before} legacy card_dependencies row(s) to the current shape`);

		// One transaction: either the table is fully converted with every row
		// carried across, or nothing changes at all.
		sqlite.exec('BEGIN');
		try {
			sqlite.exec(`
				DROP TABLE IF EXISTS card_dependencies_v2;
				CREATE TABLE card_dependencies_v2 (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
					depends_on_card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
					created_at TEXT NOT NULL DEFAULT (datetime('now'))
				);
				INSERT INTO card_dependencies_v2 (card_id, depends_on_card_id, created_at)
					SELECT blocked_card_id, blocker_card_id, created_at FROM card_dependencies;
			`);

			const carried = (sqlite.prepare('SELECT COUNT(*) n FROM card_dependencies_v2').get() as { n: number }).n;
			if (carried !== before) {
				// Never drop the original unless every row is accounted for.
				throw new Error(`row count mismatch: ${before} before, ${carried} copied`);
			}

			sqlite.exec('DROP TABLE card_dependencies');
			sqlite.exec('ALTER TABLE card_dependencies_v2 RENAME TO card_dependencies');
			sqlite.exec('COMMIT');
			log.warn(`card_dependencies converted — ${carried} row(s) preserved`);
		} catch (err) {
			sqlite.exec('ROLLBACK');
			throw err;
		}
	} catch (err) {
		log.critical('card_dependencies repair failed — table left as it was', err);
	}
}

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

	// Must precede the migration loop: 0042 indexes columns this guarantees.
	repairLegacyCardDependencies();

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
