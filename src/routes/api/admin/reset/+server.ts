import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { SESSION_COOKIE_NAME } from '$lib/server/auth';
import type { RequestHandler } from './$types';

/** POST — Nuclear reset: purge ALL data and redirect to setup. */
export const POST: RequestHandler = async ({ locals, cookies }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	// Order matters due to foreign key constraints — delete children first
	const tables = [
		'card_labels',
		'card_assignees',
		'subtasks',
		'cards',
		'columns',
		'categories',
		'labels',
		'activity_log',
		'board_members',
		'board_teams',
		'boards',
		'team_members',
		'teams',
		'invite_tokens',
		'sessions',
		'user_xp',
		'users',
		'settings'
	];

	for (const table of tables) {
		try {
			sqlite.exec(`DELETE FROM ${table}`);
		} catch {
			// Table might not exist yet, skip
		}
	}

	// Reset auto-increment counters
	try {
		sqlite.exec('DELETE FROM sqlite_sequence');
	} catch {
		// May not exist
	}

	// Clear the session cookie so the caller is logged out
	cookies.delete(SESSION_COOKIE_NAME, { path: '/' });

	return json({ success: true, redirect: '/setup' });
};
