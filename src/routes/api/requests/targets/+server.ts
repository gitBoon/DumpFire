import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users, teams, boards } from '$lib/server/db/schema';
import { asc } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** GET — Returns available users, teams, and boards for the public request form. No auth required. */
export const GET: RequestHandler = async () => {
	const allUsers = db.select({ id: users.id, username: users.username, emoji: users.emoji })
		.from(users)
		.all();

	const allTeams = db.select({ id: teams.id, name: teams.name, emoji: teams.emoji })
		.from(teams)
		.all();

	const allBoards = db.select({ id: boards.id, name: boards.name, emoji: boards.emoji })
		.from(boards)
		.orderBy(asc(boards.name))
		.all();

	const targets = [
		...allTeams.map(t => ({ id: t.id, name: t.name, emoji: t.emoji || '🏢', type: 'team' as const })),
		...allUsers.map(u => ({ id: u.id, name: u.username, emoji: u.emoji || '👤', type: 'user' as const }))
	];

	return json({ targets, boards: allBoards.map(b => ({ id: b.id, name: b.name, emoji: b.emoji || '📋' })) });
};
