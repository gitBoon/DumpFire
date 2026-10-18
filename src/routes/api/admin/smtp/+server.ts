import { json, error } from '@sveltejs/kit';
import { SECRET_MASK, keepMailPassword, readMailHere, trimHost } from '$lib/server/backup-secrets';
import {
	asSentence,
	getSmtpConfig,
	saveSmtpConfig,
	sendTestEmail,
	getAppUrl,
	setAppUrl,
	tlsFaultHint,
	type SmtpConfig
} from '$lib/server/email';
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

/**
 * GET — Return current SMTP config (password masked). `allowInsecure` is the
 * way out of card 2189; "Use SSL/TLS" (`secure`) is no longer answered.
 */
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
		allowInsecure: config.allowInsecure,
		user: config.user,
		pass: config.pass ? SECRET_MASK : '',
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
 *     host, user                  text of at most 2,048 characters; the host
 *                                 saved trimmed of ASCII spaces and tabs
 *     pass                        text. Sent masked, or not sent, the one
 *                                 stored is kept only while the host, port,
 *                                 user and allowInsecure the save leaves are
 *                                 the stored ones (card 2190,
 *                                 keepMailPassword), and the stored host is
 *                                 then written in place of one sent;
 *                                 otherwise a 400 naming what changed, and
 *                                 nothing is written
 *     fromName                    text of at most 200 characters
 *     port                        a whole number from 1 to 65535
 *     allowInsecure               true or false: mail without a checked,
 *                                 encrypted connection (card 2189). A change
 *                                 writes a WARN line naming who made it.
 *                                 `secure` ("Use SSL/TLS") is no longer saved
 *     fromAddress                 an email address
 *     appUrl                      an http or https address, or empty text. One
 *                                 written with no scheme is stored with
 *                                 `http://`, as getAppUrl() reads it
 *
 * A body with none of them is `400 No valid fields to update`, as the backup
 * settings answer one: `{}` was answered 200 and saved nothing.
 */
export const PUT: RequestHandler = async ({ request, locals }) => {
	const caller = requireSuperadmin(locals.user);
	const body = await readBody(request);

	// One transaction: the mail settings and the App URL are saved together or
	// not at all. The password kept for a masked one, and what it is kept
	// against, are read in the same one.
	const wayOutChangedTo = inTransaction(() => {
		const existing = getSmtpConfig();
		const here = readMailHere();
		const config: Partial<SmtpConfig> = {};

		// Saved trimmed of ASCII spaces and tabs only, as the password's rule
		// compares it (the review-fix pass's S1); one sent back as stored is kept.
		const sentHost = readText(body, 'host', { max: 2048, keep: existing?.host });
		const host = sentHost !== undefined && sentHost !== existing?.host ? trimHost(sentHost) : sentHost;
		if (host !== undefined) config.host = host;
		const port = readNumber(body, 'port', { whole: true, min: 1, max: 65535, keep: existing?.port });
		if (port !== undefined) config.port = port;
		const allowInsecure = readBoolean(body, 'allowInsecure', { keep: existing?.allowInsecure });
		if (allowInsecure !== undefined) config.allowInsecure = allowInsecure;
		const user = readText(body, 'user', { max: 2048, keep: existing?.user });
		if (user !== undefined) config.user = user;
		// A password masked or left out is the stored one only where it was saved
		// (card 2190): a change of host, port, user or the way out needs it typed
		// again, so that it is never sent to a server it was not saved for, nor
		// over a connection weaker than the one it was saved with.
		const pass = readText(body, 'pass', {});
		const kept = keepMailPassword({ host, port, allowInsecure, user, pass }, here);
		if ('refusal' in kept) throw error(400, kept.refusal);
		if (kept.pass !== undefined) config.pass = kept.pass;
		// The password kept: the host it was saved with, byte for byte (S1).
		if (kept.host !== undefined) config.host = kept.host;
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

		// A way out saved other than it was: missing is off.
		const wasOn = here.smtp_allow_insecure === 'true';
		return allowInsecure !== undefined && allowInsecure !== wasOn ? allowInsecure : null;
	});

	// Said once it is saved, so that a save undone is never logged (card 2189,
	// decision 14): who lowered the protection of the mail, or raised it again.
	if (wayOutChangedTo !== null) {
		log.warn(
			`Mail is now sent ${wayOutChangedTo ? 'without' : 'with'} a checked, encrypted connection (set by ${caller.username})`
		);
	}

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
		// A certificate that cannot be checked, or a server with no STARTTLS,
		// is answered with the two ways to put it right (card 2189).
		const hint = tlsFaultHint(err);
		throw error(500, hint ? `Failed to send test email: ${asSentence(err.message)} ${hint}` : `Failed to send test email: ${err.message}`);
	}
};
