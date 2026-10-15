import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { userXp, users } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';

// XP is awarded when a card is completed (`card-moves.ts`) and cleared by
// Reset XP. There is no POST: the one there was let an administrator write any
// amount to any name, and nothing called it (card 2010, decision 13).

// GET all XP records (excluding superadmin)
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const all = db.select({
		name: userXp.name,
		xp: userXp.xp,
		emoji: userXp.emoji
	})
	.from(userXp)
	.leftJoin(users, eq(userXp.name, users.username))
	.where(sql`${users.role} IS NULL OR ${users.role} != 'superadmin'`)
	.all();
	return json(all);
};
