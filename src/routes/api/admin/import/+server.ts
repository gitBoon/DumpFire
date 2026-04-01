import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const data = await request.json();

		if (!data.version || !data.boards || !data.columns) {
			return json({ error: 'Invalid backup file format' }, { status: 400 });
		}

		const importTransaction = sqlite.transaction(() => {
			// Clear all existing data (order matters for foreign keys)
			sqlite.prepare('DELETE FROM subtasks').run();
			sqlite.prepare('DELETE FROM cards').run();
			sqlite.prepare('DELETE FROM categories').run();
			sqlite.prepare('DELETE FROM columns').run();
			sqlite.prepare('DELETE FROM boards').run();
			sqlite.prepare('DELETE FROM user_xp').run();

			// Re-insert boards
			for (const row of data.boards) {
				sqlite.prepare(
					'INSERT INTO boards (id, name, emoji, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
				).run(row.id, row.name, row.emoji, row.created_at, row.updated_at);
			}

			// Re-insert columns
			for (const row of data.columns) {
				sqlite.prepare(
					'INSERT INTO columns (id, board_id, title, position, color) VALUES (?, ?, ?, ?, ?)'
				).run(row.id, row.board_id, row.title, row.position, row.color);
			}

			// Re-insert categories
			for (const row of data.categories) {
				sqlite.prepare(
					'INSERT INTO categories (id, board_id, name, color) VALUES (?, ?, ?, ?)'
				).run(row.id, row.board_id, row.name, row.color);
			}

			// Re-insert cards
			for (const row of data.cards) {
				sqlite.prepare(
					'INSERT INTO cards (id, column_id, category_id, title, description, position, priority, color_tag, due_date, on_hold_note, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
				).run(
					row.id, row.column_id, row.category_id, row.title, row.description,
					row.position, row.priority, row.color_tag, row.due_date,
					row.on_hold_note, row.completed_at, row.created_at, row.updated_at
				);
			}

			// Re-insert subtasks
			for (const row of (data.subtasks || [])) {
				sqlite.prepare(
					'INSERT INTO subtasks (id, card_id, title, description, priority, color_tag, due_date, completed, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
				).run(row.id, row.card_id, row.title, row.description, row.priority, row.color_tag, row.due_date, row.completed, row.position);
			}

			// Re-insert user XP
			for (const row of (data.userXp || [])) {
				sqlite.prepare(
					'INSERT INTO user_xp (name, xp, emoji) VALUES (?, ?, ?)'
				).run(row.name, row.xp, row.emoji);
			}
		});

		importTransaction();

		const totalCards = (data.cards || []).length;
		const totalBoards = (data.boards || []).length;

		return json({
			success: true,
			message: `Imported ${totalBoards} boards and ${totalCards} cards successfully`
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : 'Unknown error';
		return json({ error: `Import failed: ${msg}` }, { status: 500 });
	}
};
