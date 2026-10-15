import { json, error } from '@sveltejs/kit';
import { getSmtpConfig, saveSmtpConfig, sendTestEmail, getAppUrl, setAppUrl, type SmtpConfig } from '$lib/server/email';
import { inTransaction } from '$lib/server/db/transaction';
import { readBody, readBoolean, readEmail, readNumber, readText, readUrl } from '$lib/server/request-body';
import { requireSuperadmin } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';
import { createLogger } from '$lib/server/logger';

const log = createLogger('SMTP');

// The superadmin's alone, every method. The mail settings decide which server
// an invite is handed to, and the App URL decides where its link points: an
// administrator who could set either could read an invite meant for somebody
// else, and an invite sets a password.

/** GET — Return current SMTP config (password masked). */
export const GET: RequestHandler = async ({ locals }) => {
	requireSuperadmin(locals.user);

	const config = getSmtpConfig();
	if (!config) {
		return json({ configured: false });
	}

	return json({
		configured: true,
		host: config.host,
		port: config.port,
		secure: config.secure,
		user: config.user,
		pass: config.pass ? '••••••••' : '',
		fromAddress: config.fromAddress,
		fromName: config.fromName,
		appUrl: getAppUrl() || ''
	});
};

/**
 * PUT — Save SMTP config.
 *
 * Only these are saved, each by its rule (card 2117, R10), and a value the
 * settings hold now is kept as it is, sent back unchanged. The body used to be
 * handed on whole, so a port of `"abc"` or a host of 5 was stored as sent.
 *
 *     host, user                  text of at most 2,048 characters
 *     pass                        text; sent masked, it keeps the one stored
 *     fromName                    text of at most 200 characters
 *     port                        a whole number from 1 to 65535
 *     secure                      true or false
 *     fromAddress                 an email address
 *     appUrl                      an http or https address, or empty text. One
 *                                 written with no scheme is stored with
 *                                 `http://`, as getAppUrl() reads it
 *
 * A body with none of them is `400 No valid fields to update`, as the backup
 * settings answer one: `{}` was answered 200 and saved nothing.
 */
export const PUT: RequestHandler = async ({ request, locals }) => {
	requireSuperadmin(locals.user);
	const body = await readBody(request);

	// One transaction: the mail settings and the App URL are saved together or
	// not at all. The password kept for a masked one is read in the same one.
	inTransaction(() => {
		const existing = getSmtpConfig();
		const config: Partial<SmtpConfig> = {};

		const host = readText(body, 'host', { max: 2048, keep: existing?.host });
		if (host !== undefined) config.host = host;
		const port = readNumber(body, 'port', { whole: true, min: 1, max: 65535, keep: existing?.port });
		if (port !== undefined) config.port = port;
		const secure = readBoolean(body, 'secure', { keep: existing?.secure });
		if (secure !== undefined) config.secure = secure;
		const user = readText(body, 'user', { max: 2048, keep: existing?.user });
		if (user !== undefined) config.user = user;
		// If pass is masked, don't overwrite existing password
		const pass = readText(body, 'pass', {});
		if (pass !== undefined) config.pass = pass === '••••••••' ? existing?.pass || '' : pass;
		const fromAddress = readEmail(body, 'fromAddress', { keep: existing?.fromAddress });
		if (fromAddress !== undefined) config.fromAddress = fromAddress;
		const fromName = readText(body, 'fromName', { max: 200, keep: existing?.fromName });
		if (fromName !== undefined) config.fromName = fromName;
		// `kanban.example.com` was stored as typed and read as `http://` (card
		// 2117's second fix pass): it is stored as it is read.
		const appUrl = readUrl(body, 'appUrl', { allowEmpty: true, complete: true });
		if (Object.keys(config).length === 0 && appUrl === undefined) throw error(400, 'No valid fields to update');

		saveSmtpConfig(config);

		// Save App URL separately
		if (appUrl !== undefined) setAppUrl(appUrl);
	});

	return json({ success: true });
};

/** POST — Send a test email. */
export const POST: RequestHandler = async ({ request, locals }) => {
	const caller = requireSuperadmin(locals.user);

	// An address, or none for the caller's own.
	const to = readEmail(await readBody(request), 'to', { allowEmpty: true });
	const recipient = to || caller.email;

	try {
		await sendTestEmail(recipient);
		return json({ success: true, message: `Test email sent to ${recipient}` });
	} catch (err: any) {
		log.error(`Test email to ${recipient} failed: ${err.message}`);
		throw error(500, `Failed to send test email: ${err.message}`);
	}
};
