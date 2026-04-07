import { json } from '@sveltejs/kit';
import { db, sqlite } from '$lib/server/db';

export async function GET() {
	// Full database export — every table except ephemeral sessions/invite_tokens
	const data = {
		version: 2,
		exportedAt: new Date().toISOString(),

		// Users & Auth
		users: sqlite.prepare('SELECT * FROM users').all(),

		// Teams
		teams: sqlite.prepare('SELECT * FROM teams').all(),
		teamMembers: sqlite.prepare('SELECT * FROM team_members').all(),

		// Boards & Access Control
		boards: sqlite.prepare('SELECT * FROM boards').all(),
		boardCategories: sqlite.prepare('SELECT * FROM board_categories').all(),
		boardMembers: sqlite.prepare('SELECT * FROM board_members').all(),
		boardTeams: sqlite.prepare('SELECT * FROM board_teams').all(),

		// Columns, Cards & Related
		columns: sqlite.prepare('SELECT * FROM columns').all(),
		categories: sqlite.prepare('SELECT * FROM categories').all(),
		cards: sqlite.prepare('SELECT * FROM cards').all(),
		subtasks: sqlite.prepare('SELECT * FROM subtasks').all(),
		labels: sqlite.prepare('SELECT * FROM labels').all(),
		cardLabels: sqlite.prepare('SELECT * FROM card_labels').all(),
		cardAssignees: sqlite.prepare('SELECT * FROM card_assignees').all(),
		cardComments: sqlite.prepare('SELECT * FROM card_comments').all(),

		// Activity & XP
		activityLog: sqlite.prepare('SELECT * FROM activity_log').all(),
		userXp: sqlite.prepare('SELECT * FROM user_xp').all(),

		// Task Requests
		taskRequests: sqlite.prepare('SELECT * FROM task_requests').all(),

		// Settings
		settings: sqlite.prepare('SELECT * FROM settings').all()
	};

	return new Response(JSON.stringify(data, null, 2), {
		headers: {
			'Content-Type': 'application/json',
			'Content-Disposition': `attachment; filename="dumpfire-backup-${new Date().toISOString().slice(0, 10)}.json"`
		}
	});
}
