import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users, teams } from '$lib/server/db/schema';
import type { RequestHandler } from './$types';

/** GET — Returns available users and teams for the public request form. No auth required. */
export const GET: RequestHandler = async () => {
	const allUsers = db.select({ id: users.id, username: users.username, emoji: users.emoji })
		.from(users)
		.all();

	const allTeams = db.select({ id: teams.id, name: teams.name, emoji: teams.emoji })
		.from(teams)
		.all();

	const targets = [
		...allTeams.map(t => ({ id: t.id, name: t.name, emoji: t.emoji || '🏢', type: 'team' as const })),
		...allUsers.map(u => ({ id: u.id, name: u.username, emoji: u.emoji || '👤', type: 'user' as const }))
	];

	return json(targets);
};
