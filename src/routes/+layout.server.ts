import { and, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { mfaFactors } from '$lib/server/db/schema';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	return {
		user: locals.user,
		// The signed-in account's authenticators (card 2772, D4, D10): a wrong
		// answer at a confirmation counts one for each, which the confirm
		// dialog says before sending (CurrentPasswordField). 0 with no user.
		authenticators: locals.user
			? db
					.select({ n: sql<number>`count(*)` })
					.from(mfaFactors)
					.where(and(eq(mfaFactors.userId, locals.user.id), eq(mfaFactors.kind, 'totp')))
					.get()!.n
			: 0
	};
};
