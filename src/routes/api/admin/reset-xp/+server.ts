import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { whilePasswordHolds } from '$lib/server/auth';
import { readBody } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	requireAdmin(locals.user);
	const body = await readBody(request);

	// The caller's password, asked for again (card 2701): the XP cannot be
	// given back.
	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/admin/reset-xp', requireAdmin);

	// Everybody's XP or nobody's, by an administrator as the account is now
	// (card 2253), while the stored hash is the one the password was checked
	// against.
	await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => {
			requireAdmin(caller);
			sqlite.prepare('UPDATE user_xp SET xp = 0').run();
		}));
	return json({ success: true });
};
