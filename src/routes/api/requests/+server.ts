import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { taskRequests, users, teams, teamMembers, cards, columns } from '$lib/server/db/schema';
import { eq, and, inArray, or, desc } from 'drizzle-orm';
import { notifyTaskRequest } from '$lib/server/notifications';
import type { RequestHandler } from './$types';

/** GET — Returns requests targeted at the current user or their teams. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	// Find teams the user belongs to
	const userTeamRows = db.select({ teamId: teamMembers.teamId })
		.from(teamMembers)
		.where(eq(teamMembers.userId, locals.user.id))
		.all();
	const userTeamIds = userTeamRows.map(r => r.teamId);

	// Build conditions: requests targeting this user directly OR their teams
	const conditions = [
		and(eq(taskRequests.targetType, 'user'), eq(taskRequests.targetId, locals.user.id))
	];
	if (userTeamIds.length > 0) {
		conditions.push(
			and(eq(taskRequests.targetType, 'team'), inArray(taskRequests.targetId, userTeamIds))
		);
	}

	// Admins see everything
	let rows;
	if (locals.user.role === 'admin' || locals.user.role === 'superadmin') {
		rows = db.select().from(taskRequests).orderBy(desc(taskRequests.createdAt)).all();
	} else {
		rows = db.select().from(taskRequests)
			.where(or(...conditions))
			.orderBy(desc(taskRequests.createdAt))
			.all();
	}

	// Enrich with target name and resolved board ID
	const enriched = rows.map(r => {
		let targetName = 'Unknown';
		let targetEmoji = '❓';
		if (r.targetType === 'team') {
			const team = db.select({ name: teams.name, emoji: teams.emoji }).from(teams).where(eq(teams.id, r.targetId)).get();
			if (team) { targetName = team.name; targetEmoji = team.emoji || '🏢'; }
		} else {
			const user = db.select({ username: users.username, emoji: users.emoji }).from(users).where(eq(users.id, r.targetId)).get();
			if (user) { targetName = user.username; targetEmoji = user.emoji || '👤'; }
		}

		// Look up the board for resolved cards
		let resolvedBoardId: number | null = null;
		if (r.resolvedCardId) {
			const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, r.resolvedCardId)).get();
			if (card) {
				const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
				if (col) resolvedBoardId = col.boardId;
			}
		}

		return { ...r, targetName, targetEmoji, resolvedBoardId };
	});

	return json(enriched);
};

/** POST — Create a new task request. Works authed or unauthed. */
export const POST: RequestHandler = async ({ request, locals, url }) => {
	const body = await request.json();
	const { targetType, targetId, title, description, priority, requesterName, requesterEmail, businessValue } = body;

	if (!title?.trim()) throw error(400, 'Title is required');
	if (!targetType || !targetId) throw error(400, 'Target is required');
	if (!['user', 'team'].includes(targetType)) throw error(400, 'Invalid target type');

	// Validate target exists
	if (targetType === 'team') {
		const team = db.select({ id: teams.id }).from(teams).where(eq(teams.id, targetId)).get();
		if (!team) throw error(404, 'Team not found');
	} else {
		const user = db.select({ id: users.id }).from(users).where(eq(users.id, targetId)).get();
		if (!user) throw error(404, 'User not found');
	}

	const result = db.insert(taskRequests).values({
		targetType,
		targetId,
		title: title.trim(),
		description: description || '',
		priority: priority || 'medium',
		businessValue: businessValue || '',
		requesterName: locals.user ? locals.user.username : (requesterName?.trim() || 'Anonymous'),
		requesterEmail: locals.user ? locals.user.email : (requesterEmail?.trim() || null),
		requesterUserId: locals.user?.id || null
	}).returning().get();

	const name = locals.user ? locals.user.username : (requesterName?.trim() || 'Anonymous');
	const baseUrl = `${url.protocol}//${url.host}`;
	notifyTaskRequest(targetType, targetId, title.trim(), name, priority || 'medium', baseUrl);

	return json(result, { status: 201 });
};
