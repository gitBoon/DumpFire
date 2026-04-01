import { json } from '@sveltejs/kit';
import { db, sqlite } from '$lib/server/db';

export async function GET() {
	// Use raw SQLite for reliable full export
	const data = {
		version: 1,
		exportedAt: new Date().toISOString(),
		boards: sqlite.prepare('SELECT * FROM boards').all(),
		columns: sqlite.prepare('SELECT * FROM columns').all(),
		categories: sqlite.prepare('SELECT * FROM categories').all(),
		cards: sqlite.prepare('SELECT * FROM cards').all(),
		subtasks: sqlite.prepare('SELECT * FROM subtasks').all(),
		userXp: sqlite.prepare('SELECT * FROM user_xp').all()
	};

	return new Response(JSON.stringify(data, null, 2), {
		headers: {
			'Content-Type': 'application/json',
			'Content-Disposition': `attachment; filename="dumpfire-backup-${new Date().toISOString().slice(0, 10)}.json"`
		}
	});
}
