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
	appUrlEnvSet,
	appUrlFrom,
	appUrlNormalised,
	appUrlOnEnvironment,
	appUrlRowNotUsed,
	appUrlHeld,
	environmentOrigins,
	mailHeld,
	type SmtpConfig
} from '$lib/server/email';
import { readBody, readBoolean, readEmail, readNumber, readText, readUrl } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { TYPED_SECRET_LOOKS_SEALED, looksSealed } from '$lib/server/stored-secrets';
import { mailPlacesNow, recordMailSetters } from '$lib/server/setting-setters';
import { recordPlacesMoved, settingPlacesIn } from '$lib/server/outbound-changes';
import { sqlite } from '$lib/server/db';
import { confirmStepUp } from '$lib/server/step-up';
import { stillCallerNow, writeAs } from '$lib/server/write-as';
import { whilePasswordHolds, type SessionUser } from '$lib/server/auth';
import type { RequestHandler } from './$types';
import { createLogger } from '$lib/server/logger';

const log = createLogger('SMTP');

// Every administrator's, every method (card 2395, at the owner's request: the
// superadmin's alone before). The mail settings decide which server an invite
// is handed to, and the App URL decides where its link points: whoever sets
// either can read an invite or a password reset meant for somebody else, the
// superadmin's included, and either sets a password. The stored password is
// still never answered, and is kept only for the server it was saved for.
// Since card 2847 a save that would change the App URL is the superadmin's
// alone (403 to anyone else, before the password), and where the server's
// configuration names its address (APP_URL, or an ORIGIN that is not the
// image's default) the App URL must be on it (400): the host's word wins.
// The mail server stays every administrator's (card 2906 asks the owner).
// Who moved the mail settings (host, port, user, way out) to where they are,
// and who set the App URL to its address, is recorded (card 2397,
// setting-setters.ts): that account made a user, or deleted, takes them away.

/**
 * What a save that would change the App URL is refused with when the caller
 * is not the superadmin (card 2847): before the password, nothing counted.
 */
const APP_URL_NEEDS_SUPERADMIN = 'Setting the App URL needs the superadmin: every link in a mail begins with it. Nothing was saved.';

/** What a save of held mail settings is refused with (card 2922's code review, C1), worded as a held destination's save. */
const HELD_MAIL_SAVE =
	"The mail settings are held for the superadmin's review: they cannot be changed by a save. Keep them or remove them under " +
	'Settings held for review first. Nothing was saved.';
/** And a save of a held App URL. */
const HELD_APP_URL_SAVE =
	"The App URL is held for the superadmin's review: it cannot be changed by a save. Keep it or remove it under Settings held " +
	'for review first. Nothing was saved.';

/**
 * What an App URL that is no plain web address is refused with (card 2847's
 * code review, CS1): `appUrlNormalised` answered null for it.
 */
const APP_URL_NOT_PLAIN =
	'The App URL must be a plain web address: http or https, a host and a path, with no user name, password, query, ' +
	'fragment, backslash or control character, and no path beginning //. Nothing was saved.';

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
 *
 * `appUrl`, the App URL in effect as `getAppUrl()` answers it, and
 * `appUrlFrom`, where it comes from: `setting`, `environment` (`APP_URL`) or
 * `none` (card 2401). In both answers, with a mail host set or not: the App
 * URL panel fills itself from this, and was given no App URL where no host was
 * set, so its Save stored an empty one. `appUrlEnvSet`, whether `APP_URL` is
 * set (card 2401's review), so that the panel says what clearing a saved App
 * URL goes back to: its value is answered whenever it is in effect, so this
 * reveals nothing new.
 */
export const GET: RequestHandler = async ({ locals }) => {
	requireAdmin(locals.user);

	const appUrl = { appUrl: getAppUrl() || '', appUrlFrom: appUrlFrom(), appUrlEnvSet: appUrlEnvSet() };
	const config = getSmtpConfig();
	if (!config) {
		return json({ configured: false, ...appUrl, mailStatus: mailStatus() }, { headers: { 'Cache-Control': 'no-store' } });
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
		...appUrl,
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
 *                                 `http://`, as getAppUrl() reads it. Stored
 *                                 only when, read so, it differs from the App
 *                                 URL in effect (card 2401): an unchanged
 *                                 save stores nothing, so one that came from
 *                                 `APP_URL` stays the environment's. Also
 *                                 stored over a row that reads as none, such
 *                                 as one of spaces alone (its review), or is
 *                                 ignored (card 2847). A save that would store
 *                                 it is the superadmin's alone (403 to anyone
 *                                 else), and must be on an origin of
 *                                 `environmentOrigins()` where it names any
 *                                 (400), empty text excepted (card 2847).
 *                                 Stored as `appUrlNormalised` makes it, the
 *                                 string the origin is checked on; text that
 *                                 is no plain web address (credentials, a
 *                                 query or fragment, a backslash or control
 *                                 character, a path beginning //) is 400
 *                                 (its code review, CS1)
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
 *
 * Every save asks for the caller's own password again, in `currentPassword`
 * (card 2701, step-up.ts): it chooses the mail server invites and password
 * resets go through, and the App URL their links point at, and the App URL
 * panel saves through it too. Every refusal above is made first, read only,
 * so that none costs a check or a guess.
 */
export const PUT: RequestHandler = async ({ request, locals, cookies }) => {
	requireAdmin(locals.user);
	const body = await readBody(request);

	/**
	 * The save, read only: the caller as their account is now, the settings
	 * as they are, every field read against them, and every refusal; and what
	 * would be saved. Asked before the password, and again in the transaction
	 * that saves it.
	 */
	const readSave = (caller: SessionUser | null) => {
		// Named for the lines below; `user` here is the mail server's.
		const { username: setBy, id: setById, role: setByRole } = requireAdmin(caller);
		const before = mailSettingsAsRead();
		const placesBefore = mailPlacesNow();
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
		// One that looks sealed is refused (card 2898, S9): it would be taken for one.
		if (looksSealed(pass)) throw error(400, TYPED_SECRET_LOOKS_SEALED);
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
		const sentAppUrl = readUrl(body, 'appUrl', { allowEmpty: true, complete: true });
		if (Object.keys(config).length === 0 && sentAppUrl === undefined) throw error(400, 'No valid fields to update');

		// Held for the superadmin's review (card 2922's code review, C1): no save of the mail settings while they are
		// held, nor of the App URL while it is, whoever saves and whatever it changes, a host's case alone included.
		// Only Keep or Remove under Settings held for review releases it. Asked here, before the password, and again
		// in the transaction that saves.
		if (Object.keys(config).length > 0 && mailHeld()) throw error(409, HELD_MAIL_SAVE);
		if (sentAppUrl !== undefined && appUrlHeld()) throw error(409, HELD_APP_URL_SAVE);

		// One string is checked, stored and mailed (card 2847's code review,
		// CS1): the address's origin and path, or a refusal for text that is
		// no plain web address, whoever sends it.
		const appUrl = sentAppUrl === undefined ? undefined : appUrlNormalised(sentAppUrl);
		if (appUrl === null) throw error(400, APP_URL_NOT_PLAIN);

		// Whether the save would store the App URL (card 2401): read so, it
		// differs from the one in effect, or the stored row is not used (spaces
		// alone, or ignored as off the server's own address). The panel sends
		// back what the GET filled it with, which never counts as a change.
		const appUrlChanges = appUrl !== undefined && (appUrl !== appUrlNormalised(before.appUrl) || appUrlRowNotUsed());
		if (appUrl !== undefined && appUrlChanges) {
			// The superadmin's alone (card 2847, D1): every link in a mail begins
			// with it, the superadmin's own invites and set-up links included.
			if (setByRole !== 'superadmin') throw error(403, APP_URL_NEEDS_SUPERADMIN);
			// And on the server's own address where its configuration names one
			// (D2), the superadmin's too: the host's word wins over any account's.
			const origins = environmentOrigins();
			if (appUrl !== '' && !appUrlOnEnvironment(appUrl, origins)) {
				throw error(400, `The App URL must be on this server's own address (${origins.join(', ')}), which its configuration sets. Nothing was saved.`);
			}
		}

		return { setBy, setById, setByRole, before, placesBefore, here, config, allowInsecure, pass, appUrl, appUrlChanges };
	};

	// The caller's password, asked for again (card 2701), once every refusal
	// that needs none has been made.
	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'PUT /api/admin/smtp', (caller) =>
		readSave(caller)
	);

	// One transaction: the mail settings and the App URL are saved together or
	// not at all. The password kept for a masked one, and what it is kept
	// against, are read in the same one. It asks first whether the session is
	// still open and whether its account is still an administrator (cards 2253
	// and 2395), and runs only while the caller's stored hash is the one their
	// password was checked against.
	const { wayOutChangedTo, setBy, setById, changes } = await whilePasswordHolds(userId, hash, () => writeAs(locals, (caller) => {
		const { setBy, setById, setByRole, before, placesBefore, here, config, allowInsecure, pass, appUrl, appUrlChanges } = readSave(caller);
		// Where mail and links go, read before the save, so that a place it moves is recorded (card 3004, O12).
		const outboundBefore = settingPlacesIn(sqlite);

		saveSmtpConfig(config);

		// Saved only where, as a link reads it, it differs from the App URL in
		// effect (card 2401). The panel sends back what the GET filled it with,
		// which can be `APP_URL`'s: stored, that would win over any later change
		// of `APP_URL`. Empty text where a setting is stored is stored, and is
		// none, so `APP_URL` applies again; so is any where a stored row reads as
		// none (a row of spaces alone), which still hides `APP_URL` (card 2401's
		// review), or is ignored as off the server's own address (card 2847).
		// `readSave` has refused it to anyone but the superadmin.
		if (appUrl !== undefined && appUrlChanges) setAppUrl(appUrl);
		// The mail settings' and the App URL's places, each moved one recorded: the old `removed`, the new `set` (O12). A
		// From address, a sender's name or a password typed again alone moves neither.
		recordPlacesMoved(sqlite, outboundBefore, settingPlacesIn(sqlite), ['mail', 'app_url']);

		// The saver is now who set where mail goes (card 2397, as its reviews
		// ruled): the host, port, user or way out moved to a place nobody is
		// recorded for makes them the mail settings' setter, and the App URL set
		// to such an address its own; moved back to a recorded place, it is that
		// account's again. A sender's name or address, or a password typed again
		// alone, takes nothing over, nor does an App URL cleared. Demoting or
		// deleting that account removes it.
		// A password typed with the save, or the superadmin's save, takes the
		// place it moves to over whoever was recorded there (the third review).
		const changes = mailChanges(before, mailSettingsAsRead());
		const passTyped = typeof pass === 'string' && pass !== '' && pass !== SECRET_MASK;
		recordMailSetters(placesBefore, { id: setById, superadmin: setByRole === 'superadmin' }, passTyped);

		// A way out saved other than it was: missing is off.
		const wasOn = here.smtp_allow_insecure === 'true';
		return {
			wayOutChangedTo: allowInsecure !== undefined && allowInsecure !== wasOn ? allowInsecure : null,
			setBy,
			setById,
			changes
		};
	}));

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
