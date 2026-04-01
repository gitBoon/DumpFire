import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, userXp } from '$lib/server/db/schema';
import { sqlite } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
	// Delete all boards (columns, cards, subtasks cascade)
	db.delete(boards).run();
	// Also clear XP
	db.delete(userXp).run();
	// Reset auto-increment counters so IDs start fresh
	sqlite.exec('DELETE FROM sqlite_sequence');
	return json({ success: true });
};
