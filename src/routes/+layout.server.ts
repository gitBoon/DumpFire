import { and, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { mfaFactors } from '$lib/server/db/schema';
import { codeAskedOf } from '$lib/server/mfa-store';
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
			: 0,
		// Whether a confirmation asks for a code beside the password (card 3064,
		// R7): the step-up's own rule (R6), the account holding a factor or
		// two-step sign-in required. False only for an account with no factor
		// while it is dormant, whose dialogs then ask for the password alone.
		// True with no user. The server's rule is the guard; the page follows it.
		codeAsked: locals.user ? codeAskedOf(locals.user.id) : true
	};
};
