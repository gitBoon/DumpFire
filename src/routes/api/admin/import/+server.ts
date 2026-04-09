/**
 * /api/admin/import — Restore from a .db or legacy .json backup.
 *
 * Accepts the uploaded file, detects the format, and restores accordingly:
 * - .db files: opens as a separate SQLite connection, copies all data into the
 *   running database using transactions (no server restart needed)
 * - .json files: legacy import using row-by-row INSERT (backward compat)
 */

import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import Database from 'better-sqlite3';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	try {
		const contentType = request.headers.get('content-type') || '';

		// ── SQLite .db file restore ──────────────────────────────────
		if (contentType.includes('application/octet-stream') || contentType.includes('application/x-sqlite3')) {
			const buffer = Buffer.from(await request.arrayBuffer());

			// Validate it's a SQLite file (magic header: "SQLite format 3\0")
			const header = buffer.slice(0, 16).toString('ascii');
			if (!header.startsWith('SQLite format 3')) {
				return json({ error: 'Invalid file — not a SQLite database' }, { status: 400 });
			}

			// Create a JSON safety backup BEFORE touching anything
			const safetyBackup: Record<string, unknown[]> = {};
			const runningTables: string[] = sqlite
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_drizzle%' AND name NOT LIKE '__new_%'")
				.all()
				.map((r: any) => r.name);

			for (const table of runningTables) {
				try {
					safetyBackup[table] = sqlite.prepare(`SELECT * FROM "${table}"`).all();
				} catch {}
			}
			writeFileSync(join(process.cwd(), '.pre-restore-safety.json'), JSON.stringify(safetyBackup));

			// Write the uploaded backup to a temp file so we can open it as a DB
			const tempPath = join(process.cwd(), '.restore-temp.db');
			writeFileSync(tempPath, buffer);

			const errors: string[] = [];
			const restored: Record<string, number> = {};

			try {
				const backupDb = new Database(tempPath, { readonly: true });

				// MUST be set OUTSIDE transaction — SQLite ignores this inside transactions
				sqlite.pragma('foreign_keys = OFF');

				const restoreTransaction = sqlite.transaction(() => {
					// Clear tables that exist in BOTH the running DB and backup
					for (const table of runningTables) {
						try {
							sqlite.prepare(`DELETE FROM "${table}"`).run();
						} catch (e: any) {
							errors.push(`Clear ${table}: ${e.message}`);
						}
					}

					// Copy data from backup into running DB, table by table
					for (const table of runningTables) {
						try {
							// Check if this table exists in the backup
							const exists = backupDb
								.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
								.get(table);
							if (!exists) continue;

							const rows = backupDb.prepare(`SELECT * FROM "${table}"`).all();
							if (rows.length === 0) continue;

							// Get column names and filter to only columns that exist in running DB
							const backupCols = Object.keys(rows[0] as Record<string, unknown>);
							const runningCols: string[] = sqlite
								.prepare(`PRAGMA table_info("${table}")`)
								.all()
								.map((c: any) => c.name);
							const commonCols = backupCols.filter(c => runningCols.includes(c));

							if (commonCols.length === 0) {
								errors.push(`${table}: no matching columns`);
								continue;
							}

							const placeholders = commonCols.map(() => '?').join(', ');
							const quotedCols = commonCols.map(c => `"${c}"`).join(', ');
							const insertStmt = sqlite.prepare(
								`INSERT INTO "${table}" (${quotedCols}) VALUES (${placeholders})`
							);

							let rowCount = 0;
							for (const row of rows) {
								const values = commonCols.map(c => (row as Record<string, unknown>)[c]);
								try {
									insertStmt.run(...values);
									rowCount++;
								} catch (e: any) {
									errors.push(`${table} row: ${e.message}`);
								}
							}
							restored[table] = rowCount;
						} catch (e: any) {
							errors.push(`${table}: ${e.message}`);
						}
					}
				});

				restoreTransaction();
				sqlite.pragma('foreign_keys = ON');
				backupDb.close();

				// Clean up temp file
				try { unlinkSync(tempPath); } catch {}

				const summary = Object.entries(restored)
					.filter(([, count]) => count > 0)
					.map(([table, count]) => `${table}: ${count}`)
					.join(', ');

				return json({
					success: true,
					message: `Database restored (${(buffer.length / 1024).toFixed(1)} KB). ${summary || 'No data rows found in backup.'}`,
					errors: errors.length > 0 ? errors : undefined
				});
			} catch (err: any) {
				try { unlinkSync(tempPath); } catch {}
				return json({ error: `Restore failed: ${err.message}`, errors }, { status: 500 });
			}
		}

		// ── Legacy JSON import (backward compat) ─────────────────────
		const data = await request.json();

		if (!data.version || !data.boards || !data.columns) {
			return json({ error: 'Invalid backup file format' }, { status: 400 });
		}

		sqlite.pragma('foreign_keys = OFF');

		const importTransaction = sqlite.transaction(() => {

			sqlite.prepare('DELETE FROM card_comments').run();
			sqlite.prepare('DELETE FROM card_assignees').run();
			sqlite.prepare('DELETE FROM card_labels').run();
			sqlite.prepare('DELETE FROM subtasks').run();
			sqlite.prepare('DELETE FROM task_requests').run();
			sqlite.prepare('DELETE FROM activity_log').run();
			sqlite.prepare('DELETE FROM labels').run();
			sqlite.prepare('DELETE FROM cards').run();
			sqlite.prepare('DELETE FROM categories').run();
			sqlite.prepare('DELETE FROM columns').run();
			sqlite.prepare('DELETE FROM board_teams').run();
			sqlite.prepare('DELETE FROM board_members').run();
			sqlite.prepare('DELETE FROM board_categories').run();
			sqlite.prepare('DELETE FROM boards').run();
			sqlite.prepare('DELETE FROM team_members').run();
			sqlite.prepare('DELETE FROM teams').run();
			sqlite.prepare('DELETE FROM sessions').run();
			sqlite.prepare('DELETE FROM invite_tokens').run();
			sqlite.prepare('DELETE FROM users').run();
			sqlite.prepare('DELETE FROM user_xp').run();
			sqlite.prepare('DELETE FROM settings').run();

			for (const row of (data.users || [])) {
				sqlite.prepare(
					'INSERT INTO users (id, username, email, password_hash, emoji, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
				).run(row.id, row.username, row.email, row.password_hash, row.emoji, row.role, row.created_at);
			}

			for (const row of (data.teams || [])) {
				sqlite.prepare(
					'INSERT INTO teams (id, name, emoji, created_at) VALUES (?, ?, ?, ?)'
				).run(row.id, row.name, row.emoji, row.created_at);
			}

			for (const row of (data.teamMembers || [])) {
				sqlite.prepare(
					'INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)'
				).run(row.team_id, row.user_id, row.role);
			}

			for (const row of (data.boardCategories || [])) {
				sqlite.prepare(
					'INSERT INTO board_categories (id, name, color) VALUES (?, ?, ?)'
				).run(row.id, row.name, row.color);
			}

			for (const row of data.boards) {
				sqlite.prepare(
					'INSERT INTO boards (id, name, emoji, parent_card_id, category_id, is_public, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
				).run(
					row.id, row.name, row.emoji,
					row.parent_card_id ?? null, row.category_id ?? null,
					row.is_public ?? 0, row.created_by ?? null,
					row.created_at, row.updated_at
				);
			}

			for (const row of (data.boardMembers || [])) {
				sqlite.prepare(
					'INSERT INTO board_members (board_id, user_id, role) VALUES (?, ?, ?)'
				).run(row.board_id, row.user_id, row.role);
			}

			for (const row of (data.boardTeams || [])) {
				sqlite.prepare(
					'INSERT INTO board_teams (board_id, team_id, role) VALUES (?, ?, ?)'
				).run(row.board_id, row.team_id, row.role);
			}

			for (const row of data.columns) {
				sqlite.prepare(
					'INSERT INTO columns (id, board_id, title, position, color, show_add_card) VALUES (?, ?, ?, ?, ?, ?)'
				).run(row.id, row.board_id, row.title, row.position, row.color, row.show_add_card ?? 0);
			}

			for (const row of data.categories) {
				sqlite.prepare(
					'INSERT INTO categories (id, board_id, name, color) VALUES (?, ?, ?, ?)'
				).run(row.id, row.board_id, row.name, row.color);
			}

			for (const row of data.cards) {
				sqlite.prepare(
					'INSERT INTO cards (id, column_id, category_id, title, description, position, priority, color_tag, due_date, on_hold_note, business_value, pinned, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
				).run(
					row.id, row.column_id, row.category_id, row.title, row.description,
					row.position, row.priority, row.color_tag, row.due_date,
					row.on_hold_note, row.business_value ?? '', row.pinned ?? 0,
					row.completed_at, row.created_at, row.updated_at
				);
			}

			for (const row of (data.subtasks || [])) {
				sqlite.prepare(
					'INSERT INTO subtasks (id, card_id, title, description, priority, color_tag, due_date, completed, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
				).run(row.id, row.card_id, row.title, row.description, row.priority, row.color_tag, row.due_date, row.completed, row.position);
			}

			for (const row of (data.labels || [])) {
				sqlite.prepare(
					'INSERT INTO labels (id, board_id, name, color) VALUES (?, ?, ?, ?)'
				).run(row.id, row.board_id, row.name, row.color);
			}

			for (const row of (data.cardLabels || [])) {
				sqlite.prepare(
					'INSERT INTO card_labels (card_id, label_id) VALUES (?, ?)'
				).run(row.card_id, row.label_id);
			}

			for (const row of (data.cardAssignees || [])) {
				sqlite.prepare(
					'INSERT INTO card_assignees (card_id, user_id) VALUES (?, ?)'
				).run(row.card_id, row.user_id);
			}

			for (const row of (data.cardComments || [])) {
				sqlite.prepare(
					'INSERT INTO card_comments (id, card_id, user_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
				).run(row.id, row.card_id, row.user_id, row.content, row.created_at, row.updated_at);
			}

			for (const row of (data.activityLog || [])) {
				sqlite.prepare(
					'INSERT INTO activity_log (id, board_id, card_id, user_id, action, detail, user_name, user_emoji, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
				).run(row.id, row.board_id, row.card_id, row.user_id, row.action, row.detail, row.user_name, row.user_emoji, row.created_at);
			}

			for (const row of (data.userXp || [])) {
				sqlite.prepare(
					'INSERT INTO user_xp (name, xp, emoji) VALUES (?, ?, ?)'
				).run(row.name, row.xp, row.emoji);
			}

			for (const row of (data.taskRequests || [])) {
				sqlite.prepare(
					'INSERT INTO task_requests (id, target_type, target_id, requester_name, requester_email, requester_user_id, title, description, priority, status, business_value, resolved_by, resolved_card_id, reject_reason, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
				).run(
					row.id, row.target_type, row.target_id, row.requester_name,
					row.requester_email, row.requester_user_id, row.title,
					row.description, row.priority, row.status, row.business_value,
					row.resolved_by, row.resolved_card_id, row.reject_reason,
					row.created_at, row.resolved_at
				);
			}

			for (const row of (data.settings || [])) {
				sqlite.prepare(
					'INSERT INTO settings (key, value) VALUES (?, ?)'
				).run(row.key, row.value);
			}

			sqlite.prepare('DELETE FROM backup_log').run();
			for (const row of (data.backupLog || [])) {
				sqlite.prepare(
					'INSERT INTO backup_log (id, destination_type, destination_name, filename, size_bytes, status, error, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
				).run(row.id, row.destination_type, row.destination_name, row.filename, row.size_bytes, row.status, row.error, row.duration_ms, row.created_at);
			}

		});

		importTransaction();
		sqlite.pragma('foreign_keys = ON');

		const counts = {
			users: (data.users || []).length,
			teams: (data.teams || []).length,
			boards: (data.boards || []).length,
			cards: (data.cards || []).length,
			comments: (data.cardComments || []).length,
			requests: (data.taskRequests || []).length
		};

		return json({
			success: true,
			message: `Restored ${counts.users} users, ${counts.teams} teams, ${counts.boards} boards, ${counts.cards} cards, ${counts.comments} comments, ${counts.requests} task requests`
		});
	} catch (error) {
		try { sqlite.pragma('foreign_keys = ON'); } catch {}
		const msg = error instanceof Error ? error.message : 'Unknown error';
		return json({ error: `Import failed: ${msg}` }, { status: 500 });
	}
};
