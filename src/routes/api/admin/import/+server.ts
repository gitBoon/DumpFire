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
			// ── Disable FK checks during bulk import ──────────────────────
			sqlite.pragma('foreign_keys = OFF');

			// ── Clear ALL tables (order: leaf → root) ────────────────────
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

			// ── Users ────────────────────────────────────────────────────
			for (const row of (data.users || [])) {
				sqlite.prepare(
					'INSERT INTO users (id, username, email, password_hash, emoji, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
				).run(row.id, row.username, row.email, row.password_hash, row.emoji, row.role, row.created_at);
			}

			// ── Teams ────────────────────────────────────────────────────
			for (const row of (data.teams || [])) {
				sqlite.prepare(
					'INSERT INTO teams (id, name, emoji, created_at) VALUES (?, ?, ?, ?)'
				).run(row.id, row.name, row.emoji, row.created_at);
			}

			// ── Team Members ─────────────────────────────────────────────
			for (const row of (data.teamMembers || [])) {
				sqlite.prepare(
					'INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)'
				).run(row.team_id, row.user_id, row.role);
			}

			// ── Board Categories ─────────────────────────────────────────
			for (const row of (data.boardCategories || [])) {
				sqlite.prepare(
					'INSERT INTO board_categories (id, name, color) VALUES (?, ?, ?)'
				).run(row.id, row.name, row.color);
			}

			// ── Boards ───────────────────────────────────────────────────
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

			// ── Board Members ────────────────────────────────────────────
			for (const row of (data.boardMembers || [])) {
				sqlite.prepare(
					'INSERT INTO board_members (board_id, user_id, role) VALUES (?, ?, ?)'
				).run(row.board_id, row.user_id, row.role);
			}

			// ── Board Teams ──────────────────────────────────────────────
			for (const row of (data.boardTeams || [])) {
				sqlite.prepare(
					'INSERT INTO board_teams (board_id, team_id, role) VALUES (?, ?, ?)'
				).run(row.board_id, row.team_id, row.role);
			}

			// ── Columns ──────────────────────────────────────────────────
			for (const row of data.columns) {
				sqlite.prepare(
					'INSERT INTO columns (id, board_id, title, position, color, show_add_card) VALUES (?, ?, ?, ?, ?, ?)'
				).run(row.id, row.board_id, row.title, row.position, row.color, row.show_add_card ?? 0);
			}

			// ── Categories ───────────────────────────────────────────────
			for (const row of data.categories) {
				sqlite.prepare(
					'INSERT INTO categories (id, board_id, name, color) VALUES (?, ?, ?, ?)'
				).run(row.id, row.board_id, row.name, row.color);
			}

			// ── Cards ────────────────────────────────────────────────────
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

			// ── Subtasks ─────────────────────────────────────────────────
			for (const row of (data.subtasks || [])) {
				sqlite.prepare(
					'INSERT INTO subtasks (id, card_id, title, description, priority, color_tag, due_date, completed, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
				).run(row.id, row.card_id, row.title, row.description, row.priority, row.color_tag, row.due_date, row.completed, row.position);
			}

			// ── Labels ───────────────────────────────────────────────────
			for (const row of (data.labels || [])) {
				sqlite.prepare(
					'INSERT INTO labels (id, board_id, name, color) VALUES (?, ?, ?, ?)'
				).run(row.id, row.board_id, row.name, row.color);
			}

			// ── Card Labels ──────────────────────────────────────────────
			for (const row of (data.cardLabels || [])) {
				sqlite.prepare(
					'INSERT INTO card_labels (card_id, label_id) VALUES (?, ?)'
				).run(row.card_id, row.label_id);
			}

			// ── Card Assignees ───────────────────────────────────────────
			for (const row of (data.cardAssignees || [])) {
				sqlite.prepare(
					'INSERT INTO card_assignees (card_id, user_id) VALUES (?, ?)'
				).run(row.card_id, row.user_id);
			}

			// ── Card Comments ────────────────────────────────────────────
			for (const row of (data.cardComments || [])) {
				sqlite.prepare(
					'INSERT INTO card_comments (id, card_id, user_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
				).run(row.id, row.card_id, row.user_id, row.content, row.created_at, row.updated_at);
			}

			// ── Activity Log ─────────────────────────────────────────────
			for (const row of (data.activityLog || [])) {
				sqlite.prepare(
					'INSERT INTO activity_log (id, board_id, card_id, user_id, action, detail, user_name, user_emoji, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
				).run(row.id, row.board_id, row.card_id, row.user_id, row.action, row.detail, row.user_name, row.user_emoji, row.created_at);
			}

			// ── User XP ──────────────────────────────────────────────────
			for (const row of (data.userXp || [])) {
				sqlite.prepare(
					'INSERT INTO user_xp (name, xp, emoji) VALUES (?, ?, ?)'
				).run(row.name, row.xp, row.emoji);
			}

			// ── Task Requests ────────────────────────────────────────────
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

			// ── Settings ─────────────────────────────────────────────────
			for (const row of (data.settings || [])) {
				sqlite.prepare(
					'INSERT INTO settings (key, value) VALUES (?, ?)'
				).run(row.key, row.value);
			}

			// ── Re-enable FK checks ──────────────────────────────────────
			sqlite.pragma('foreign_keys = ON');
		});

		importTransaction();

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
		// Ensure FK checks are re-enabled even on error
		try { sqlite.pragma('foreign_keys = ON'); } catch {}
		const msg = error instanceof Error ? error.message : 'Unknown error';
		return json({ error: `Import failed: ${msg}` }, { status: 500 });
	}
};
