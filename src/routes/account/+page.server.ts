import type { PageServerLoad } from './$types';
import { and, count, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { webhooks } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	// How many webhooks the account set that are on. Ending the keys with a
	// password change switches them off too (card 2168), and the password form
	// offers to while there is one, with no key left as well: deleting the key
	// that made a webhook leaves the webhook sending. The count only.
	const hooks = db
		.select({ count: count() })
		.from(webhooks)
		.where(and(eq(webhooks.setBy, user.id), eq(webhooks.active, true)))
		.get();
	return {
		user,
		webhooks: hooks?.count ?? 0
	};
};
