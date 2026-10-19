import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { readBody, readText } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);

	// Text of 1 to 32 characters (card 2117): any length was stored.
	const emoji = readText(await readBody(request), 'emoji', {
		required: true,
		min: 1,
		max: 32,
		says: { missing: 'Missing emoji', type: 'Missing emoji', empty: 'Missing emoji' }
	});

	// Written to the account as it is now, in a transaction that asks first
	// whether the session is still open (card 2253).
	writeAs(locals, (caller) => {
		db.update(users)
			.set({ emoji })
			.where(eq(users.id, requireUser(caller).id))
			.run();
	});

	return json({ emoji });
};
