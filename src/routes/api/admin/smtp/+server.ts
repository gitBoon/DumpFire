import { json, error } from '@sveltejs/kit';
import { SECRET_MASK, keepMailPassword, quotedName as quoted, readMailHere, trimHost } from '$lib/server/backup-secrets';
import {
	MailNotSent,
	TLS_FAULT_HINT,
	asSentence,
	getSmtpConfig,
	mailSettingsAsRead,
	mailStatus,
	saveSmtpConfig,
	sendTestEmail,
	getAppUrl,
	setAppUrl,
	type SmtpConfig
} from '$lib/server/email';
import { readBody, readBoolean, readEmail, readNumber, readText, readUrl } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { stillCallerNow, writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';
import { createLogger } from '$lib/server/logger';

const log = createLogger('SMTP');

// Every administrator's, every method (card 2395, at the owner's request: the
// superadmin's alone before). The mail settings decide which server an invite
// is handed to, and the App URL decides where its link points: whoever sets
// either can read an invite or a password reset meant for somebody else, the
// superadmin's included, and either sets a password. The stored password is
// still never answered, and is kept only for the server it was saved for.

/** The settings a save is logged by (card 2396), in the order its line names them. */
const MAIL_FIELDS = ['host', 'port', 'allowInsecure', 'user', 'pass', 'fromAddress', 'fromName', 'appUrl'] as const;

/**
 * Logged by name alone, never with a value (card 2396's review): the password,
 * and the user name, which some mail providers take as the API token for both.
 */
const NAMED_ALONE: readonly string[] = ['user', 'pass'];

/** One setting a save changed: its values, or for the password and the user name none. */
type MailChange = { field: (typeof MAIL_FIELDS)[number]; from?: string | number | boolean; to?: string | number | boolean };

/**
 * What a save changed in the mail settings and the App URL (card 2396), each
 * as a mail reads it (`mailSettingsAsRead`), so a save that changes nothing
 * finds nothing (card 2183's rule). The password and the user name by name
 * alone.
 */
function mailChanges(before: ReturnType<typeof mailSettingsAsRead>, after: ReturnType<typeof mailSettingsAsRead>): MailChange[] {
	return MAIL_FIELDS.filter((field) => !Object.is(before[field], after[field])).map((field) =>
		NAMED_ALONE.includes(field) ? { field } : { field, from: before[field], to: after[field] }
	);
}

/**
 * The line a save writes for what it changed (card 2396), in the style of the
 * backup settings' (card 2270): each setting by its name with its values,
 * text in quotation marks with each `\` and `"` escaped, the user name as
 * `user changed` and the password as `password changed`, never a value; then
 * who saved it, quoted as the values are.
 */
function mailChangeLine(changes: MailChange[], setBy: string): string {
	const value = (v: unknown) => (typeof v === 'string' ? quoted(v) : String(v));
	const parts = changes.map((c) =>
		c.field === 'pass' ? 'password changed' : c.field === 'user' ? 'user changed' : `${c.field} from ${value(c.from)} to ${value(c.to)}`
	);
	return `Mail settings changed: ${parts.join('; ')} (set by ${quoted(setBy)})`;
}

/**
 * GET — Return current SMTP config (password masked). `allowInsecure` is the
 * way out of card 2189; "Use SSL/TLS" (`secure`) is no longer answered.
 *
 * `mailStatus`, configured or not (card 2196): what mail has done since the
 * server started, as `mailStatus()` in email.ts keeps it. How many mails were
 * sent and how many failed, when the last was sent, and the last failure:
 * when, its subject, the problem in words and the mail server's own words,
 * masked. An administrator's, as the rest of this answer is: the mail
 * server's words can name the mail host and its user name. Both answers are
 * `no-store`, so nothing on the way keeps them (the review-fix pass's item 7).
 */
export const GET: RequestHandler = async ({ locals }) => {
	requireAdmin(locals.user);

	const config = getSmtpConfig();
	if (!config) {
		return json({ configured: false, mailStatus: mailStatus() }, { headers: { 'Cache-Control': 'no-store' } });
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
		appUrl: getAppUrl() || '',
		mailStatus: mailStatus()
	}, { headers: { 'Cache-Control': 'no-store' } });
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
 *
 * A save that changes any of them, as a mail reads them, is one line under
 * SMTP once it is committed, filed under the account that saved it and naming
 * it (card 2396): `Mail settings changed: host from "a" to "b"; password
 * changed (set by "chief")`, each setting with its values but the user name
 * and the password, which are named alone. Always a WARN, so that it is kept
 * at every LOG_LEVEL that keeps any (card 2396's review). A save that changes
 * nothing, is refused or fails writes none. The way out's own WARN follows it.
 */
export const PUT: RequestHandler = async ({ request, locals }) => {
	requireAdmin(locals.user);
	const body = await readBody(request);

	// One transaction: the mail settings and the App URL are saved together or
	// not at all. The password kept for a masked one, and what it is kept
	// against, are read in the same one. It asks first whether the session is
	// still open and whether its account is still an administrator (cards 2253
	// and 2395).
	const { wayOutChangedTo, setBy, setById, changes } = writeAs(locals, (caller) => {
		// Named for the lines below; `user` here is the mail server's.
		const { username: setBy, id: setById } = requireAdmin(caller);
		const before = mailSettingsAsRead();
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
		return {
			wayOutChangedTo: allowInsecure !== undefined && allowInsecure !== wasOn ? allowInsecure : null,
			setBy,
			setById,
			changes: mailChanges(before, mailSettingsAsRead())
		};
	});

	// Every save that changes a setting, filed under who saved it (card 2396):
	// since card 2395 any administrator can point mail at a server of their
	// own, which sees every mail sent. Once it is saved, as below, and before
	// the way out's own line.
	if (changes.length > 0) log.warn(mailChangeLine(changes, setBy), { changes }, { userId: setById });

	// Said once it is saved, so that a save undone is never logged (card 2189,
	// decision 14): who lowered the protection of the mail, or raised it again.
	if (wayOutChangedTo !== null) {
		log.warn(
			`Mail is now sent ${wayOutChangedTo ? 'without' : 'with'} a checked, encrypted connection (set by ${setBy})`
		);
	}

	return json({ success: true });
};

/**
 * POST — Send a test email. A failure is logged once, by `deliverMail` in
 * email.ts, with the mail server's words masked; this route used to write a
 * line of its own beside it, unmasked (card 2196's N2). The gate's line for
 * the `500` stays.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireAdmin(locals.user);

	// An address, or none for the caller's own.
	const to = readEmail(await readBody(request), 'to', { allowEmpty: true });
	// Asked again once the body is in, with nothing awaited between this and
	// the mail, which leaves the process (card 2253): a session that has ended,
	// or an account that is no longer an administrator, sends nothing. The
	// caller's own address is theirs as it is now.
	const sender = requireAdmin(stillCallerNow(locals));
	const recipient = to || sender.email;

	try {
		await sendTestEmail(recipient);
		return json({ success: true, message: `Test email sent to ${recipient}` });
	} catch (err: any) {
		// A certificate that cannot be checked, or a server with no STARTTLS,
		// is answered with the two ways to put it right (card 2189): the
		// problem `deliverMail` read with the same test as `tlsFaultHint`.
		const hint = err instanceof MailNotSent && err.problem === 'secure-connection' ? TLS_FAULT_HINT : null;
		throw error(500, hint ? `Failed to send test email: ${asSentence(err.message)} ${hint}` : `Failed to send test email: ${err.message}`);
	}
};
