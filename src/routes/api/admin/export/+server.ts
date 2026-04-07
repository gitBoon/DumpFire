/**
 * /api/admin/export — Download a complete SQLite database backup.
 *
 * Uses VACUUM INTO to create a self-contained .db copy that includes all WAL
 * data. This captures everything automatically — no need to list tables.
 */

import { sqlite, getDbPath } from '$lib/server/db';
import { readFileSync, unlinkSync } from 'node:fs';

export async function GET() {
	const dbPath = getDbPath();
	const backupPath = dbPath + '.export-temp';

	// Remove any stale temp file
	try { unlinkSync(backupPath); } catch {}

	// VACUUM INTO creates a complete, self-contained copy including all WAL data
	sqlite.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

	const dbBuffer = readFileSync(backupPath);

	// Clean up temp file
	try { unlinkSync(backupPath); } catch {}

	const timestamp = new Date().toISOString().slice(0, 10);

	return new Response(dbBuffer, {
		headers: {
			'Content-Type': 'application/x-sqlite3',
			'Content-Disposition': `attachment; filename="dumpfire-backup-${timestamp}.db"`
		}
	});
}
