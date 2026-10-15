import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { readBody, readText } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	// Text of 1 to 32 characters (card 2117): any length was stored.
	const emoji = readText(await readBody(request), 'emoji', {
		required: true,
		min: 1,
		max: 32,
		says: { missing: 'Missing emoji', type: 'Missing emoji', empty: 'Missing emoji' }
	});

	db.update(users)
		.set({ emoji })
		.where(eq(users.id, locals.user.id))
		.run();

	return json({ emoji });
};
