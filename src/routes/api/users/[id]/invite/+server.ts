import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { users, inviteTokens } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { isSmtpConfigured, resolveBaseUrl } from '$lib/server/email';
import { sendInviteEmail } from '$lib/server/notifications';
import type { RequestHandler } from './$types';

/** POST — Resend invite email (generates a new token). Admin only. */
export const POST: RequestHandler = async ({ params, locals, request, url }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	if (!isSmtpConfigured()) {
		throw error(400, 'SMTP is not configured');
	}

	const userId = Number(params.id);
	const user = db.select().from(users).where(eq(users.id, userId)).get();
	if (!user) throw error(404, 'User not found');

	// Generate a fresh token (invalidates any previous ones implicitly by expiry)
	const token = crypto.randomUUID();
	const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

	db.insert(inviteTokens)
		.values({ token, userId: user.id, expiresAt })
		.run();

	const baseUrl = resolveBaseUrl(request, url);
	sendInviteEmail(user.email, user.username, token, baseUrl);

	return json({ success: true, message: `Invite sent to ${user.email}` });
};
