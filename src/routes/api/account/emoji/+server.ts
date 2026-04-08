import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const { emoji } = await request.json();
	if (!emoji || typeof emoji !== 'string') {
		throw error(400, 'Missing emoji');
	}

	db.update(users)
		.set({ emoji })
		.where(eq(users.id, locals.user.id))
		.run();

	return json({ emoji });
};
