import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { userXp, users } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';

// GET all XP records (excluding superadmin)
export const GET: RequestHandler = async () => {
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

// POST to award XP — admin only
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	const { name, emoji, amount } = await request.json();
	if (!name || !amount) return json({ error: 'Missing name or amount' }, { status: 400 });

	// Upsert: insert or update
	const existing = db.select().from(userXp).where(eq(userXp.name, name)).get();
	if (existing) {
		db.update(userXp)
			.set({
				xp: existing.xp + amount,
				emoji: emoji || existing.emoji
			})
			.where(eq(userXp.name, name))
			.run();
	} else {
		db.insert(userXp).values({ name, xp: amount, emoji: emoji || '👤' }).run();
	}

	const updated = db.select().from(userXp).where(eq(userXp.name, name)).get();
	return json(updated);
};
