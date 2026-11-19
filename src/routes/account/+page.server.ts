import type { PageServerLoad } from './$types';
import { and, count, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { reportSchedules, webhooks } from '$lib/server/db/schema';
import { twoStepView } from '$lib/server/account-two-step';
import { webhooksReadableBy } from '$lib/server/webhooks';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	// How many webhooks the account set that are on. Ending the keys with a
	// password change switches them off too (card 2168), and the password form
	// offers to while there is one, with no key left as well: revoking the key
	// that set a webhook up switches it off (card 2893), but one set up before
	// keys were recorded goes on while the account holds a working key from
	// then. The count only.
	const hooks = db
		.select({ count: count() })
		.from(webhooks)
		.where(and(eq(webhooks.setBy, user.id), eq(webhooks.active, true)))
		.get();
	// How many of the account's report schedules are on (card 2894, D1): a
	// password change pauses every one, and the form says so before the
	// button. The count only.
	const schedules = db
		.select({ count: count() })
		.from(reportSchedules)
		.where(and(eq(reportSchedules.userId, user.id), eq(reportSchedules.enabled, true)))
		.get();
	return {
		user,
		webhooks: hooks?.count ?? 0,
		// Whether ending the keys holds webhooks of others whose secret the account could read (card 2935, P8): in words.
		holdsReadable: webhooksReadableBy(user.id) > 0,
		reportSchedulesOn: schedules?.count ?? 0,
		// The Two-step sign-in section and the warning at the top of the page
		// (card 2772, D10): never a secret, a recovery code or a pending id.
		twoStep: twoStepView(user.id)
	};
};
