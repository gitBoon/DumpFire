/**
 * email.ts — SMTP email utility for DumpFire.
 *
 * Reads SMTP configuration from the settings table and provides
 * a simple sendEmail() function. Silently no-ops if SMTP is not configured.
 *
 * Every mail goes over a checked, encrypted connection (card 2189): TLS from
 * the first byte on port 465, STARTTLS required on every other port, and the
 * server's certificate checked for the host's name on all of them. Mail on
 * 587 used to go out without requiring STARTTLS and without checking the
 * certificate, so anyone on the network path could read the mail password and
 * every message. A mail server whose certificate comes from a private
 * authority is trusted through `NODE_EXTRA_CA_CERTS`, which Node reads at
 * start (docs/deployment.md, Mail Server Certificates); a relay on this
 * server's own network that cannot use TLS is what the one way out is for,
 * the `smtp_allow_insecure` setting.
 *
 * Every mail is handed to the mail server in one place, `deliverMail` (card
 * 2196), which says whether it went: `{ sent: true }`, or `{ sent: false,
 * problem, detail }`, the problem one of seven read from nodemailer's error
 * (`mailProblem`). `sendEmail` and `sendEmailWithAttachment` still answer a
 * boolean, `trySendEmail` the whole outcome, and `sendTestEmail` still throws.
 * A failure is logged once, as an `ERROR` holding nothing of the error but its
 * code and its message masked (`maskMailText`): a mail server's refusal can
 * quote the mail's link, and an invite's link sets a password. And it is kept
 * in memory, with a count of what was sent, for the mail panel (`mailStatus`):
 * a mail that failed used to be an `ERROR` line and nothing else, and an
 * invite whose mail failed was reported as sent.
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { dev } from '$app/environment';
import { db } from './db';
import { inTransaction } from './db/transaction';
import { settings } from './db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from './logger';
import { maskSecretPaths } from './secret-paths';
import { MAIL_CONNECTION_SETTINGS, mailPasswordAad, openStored, sealStored } from './stored-secrets';
// The settings held for the superadmin's review (card 2922): a leaf, which this passes the values it reads.
import { anyHeld, appUrlHeldAt, heldBecauseAt, mailHeldAt, mailPlaceOf, MAIL_SETTING, UNSEALED_RESTORE } from './setting-holds';
import { stamp } from '$lib/timestamps';
import { HELD_NOT_RECORDED, HELD_REMOVED_HERE } from '$lib/settings-held';
import { EMAIL_ADDRESS } from './request-body';

const log = createLogger('EMAIL');

// ─── Settings Helpers ────────────────────────────────────────────────────────

/**
 * A setting's value, or null where there is none or it is not text (card 3004, R15; card 3031): a BLOB, a number or a
 * NULL a restore or a host edit left is none to every sender, never a value read another way.
 */
function getSetting(key: string): string | null {
	const row = db.select().from(settings).where(eq(settings.key, key)).get();
	const value = row?.value as unknown;
	return typeof value === 'string' ? value : null;
}

function setSetting(key: string, value: string): void {
	const existing = db.select().from(settings).where(eq(settings.key, key)).get();
	if (existing) {
		db.update(settings).set({ value }).where(eq(settings.key, key)).run();
	} else {
		db.insert(settings).values({ key, value }).run();
	}
}

// ─── SMTP Config ─────────────────────────────────────────────────────────────

export type SmtpConfig = {
	host: string;
	port: number;
	/**
	 * The way out (card 2189): mail without a checked, encrypted connection,
	 * as before that card, on any port but 465. Off unless it is saved on.
	 * It replaces "Use SSL/TLS" (`smtp_secure`), whose row is left where it
	 * is and no longer read or written: the certificate is now checked
	 * whatever it says.
	 */
	allowInsecure: boolean;
	user: string;
	/** The mail password opened (card 2898); '' for none, and for one that does not open. */
	pass: string;
	fromAddress: string;
	fromName: string;
	/**
	 * Present, and true, only where a password is stored that does not open
	 * under this server's key (card 2898, S3): a host changed by hand, or a
	 * row tampered with. No mail is sent while a user is set.
	 */
	passUnopenable?: true;
};

/** The stored mail settings the password is sealed bound to (card 2898): `mailPasswordAad`'s connection. */
function storedMailConnection(): Record<string, string | null> {
	return Object.fromEntries(MAIL_CONNECTION_SETTINGS.map((name) => [name, getSetting(name)]));
}

/**
 * Where mail goes, as a mail reads it, without the password, which is not
 * opened for it (the code review's E10): the host, port, user and way out.
 */
export function mailConnectionAsRead(): Pick<SmtpConfig, 'host' | 'port' | 'user' | 'allowInsecure'> {
	return {
		host: getSetting('smtp_host') || '',
		port: Number(getSetting('smtp_port') || '587'),
		allowInsecure: getSetting('smtp_allow_insecure') === 'true',
		user: getSetting('smtp_user') || ''
	};
}

/** The stored mail password, opened (card 2898). */
function storedMailPassword() {
	return openStored(getSetting('smtp_pass'), mailPasswordAad(storedMailConnection()));
}

/** Read SMTP config from the settings table. Returns null if not configured. */
export function getSmtpConfig(): SmtpConfig | null {
	const host = getSetting('smtp_host');
	if (!host) return null;

	return smtpSettingsWith(host);
}

/** The mail settings with `host`, each other one read with the default a mail uses. */
function smtpSettingsWith(host: string): SmtpConfig {
	const pass = storedMailPassword();
	return {
		host,
		port: Number(getSetting('smtp_port') || '587'),
		allowInsecure: getSetting('smtp_allow_insecure') === 'true',
		user: getSetting('smtp_user') || '',
		pass: pass.value,
		fromAddress: getSetting('smtp_from_address') || '',
		fromName: getSetting('smtp_from_name') || 'DumpFire',
		...(pass.kind === 'unopenable' ? { passUnopenable: true as const } : {})
	};
}

/**
 * The From a mail is handed to nodemailer with (card 3029, its plan's R1), from the From Address and From Name as
 * stored: a name and an address apart, never joined as text, so that nodemailer quotes the name and no name can add
 * an address of its own, nor take the envelope's sender. Each is read as text: text as it is, and anything else (a
 * BLOB, a number) as '', as the mailer reads every setting (`getSetting`, card 3004 R15; card 3031); the name '' is
 * 'DumpFire'. An address that is not one a save takes is ''. An address '' gives a
 * mail no From and the envelope `MAIL FROM:<>`.
 * A restore of a backup whose seal did not verify counts by it too (`keepMailFromHere`), so the two cannot differ.
 */
export function mailFromAsRead(address: unknown, name: unknown): { name: string; address: string } {
	const asText = (value: unknown) => (typeof value === 'string' ? value : '');
	const text = asText(address);
	// Fails closed: an address a save would refuse (`EMAIL_ADDRESS`, at most 254 characters) is no address, so no line
	// break, comma or second address stored by any route reaches a header or the envelope.
	return { name: asText(name) || 'DumpFire', address: text.length <= 254 && EMAIL_ADDRESS.test(text) ? text : '' };
}

/**
 * The mail settings as a mail reads them, a host set or not, and the App URL
 * as a link reads it, empty for none (card 2396). A save of the mail settings
 * reads them before and after it writes, and logs each that differs: a row
 * written with the value a mail already used is no change.
 */
export function mailSettingsAsRead(): SmtpConfig & { appUrl: string } {
	return { ...smtpSettingsWith(getSetting('smtp_host') || ''), appUrl: getAppUrl() || '' };
}

/**
 * Save SMTP configuration to the settings table.
 *
 * One transaction: each setting is a row of its own, and a failure part of
 * the way used to leave a new host saved with the old port and password.
 *
 * A password is written sealed under the MFA key (card 2898), bound to the
 * mail connection the save leaves stored, the key check recorded with it; ''
 * is stored ''. One kept by the save is not passed, and its row is left as it
 * is (decision 18).
 */
export function saveSmtpConfig(config: Partial<SmtpConfig>): void {
	inTransaction(() => {
		if (config.host !== undefined) setSetting('smtp_host', config.host);
		if (config.port !== undefined) setSetting('smtp_port', String(config.port));
		if (config.allowInsecure !== undefined) setSetting('smtp_allow_insecure', String(config.allowInsecure));
		if (config.user !== undefined) setSetting('smtp_user', config.user);
		if (config.pass !== undefined) setSetting('smtp_pass', sealStored(config.pass, mailPasswordAad(storedMailConnection())));
		if (config.fromAddress !== undefined) setSetting('smtp_from_address', config.fromAddress);
		if (config.fromName !== undefined) setSetting('smtp_from_name', config.fromName);
		// Mail is set up on this server from now on, whatever happens to its settings (card 2922, R9).
		if (config.host) recordMailEverConfigured();
	});
}

/** Quick check if SMTP is configured (has a host set). */
export function isSmtpConfigured(): boolean {
	return !!getSetting('smtp_host');
}

/**
 * The setting that records that mail has been set up on this server, with
 * when it first was (card 2922, R9). Written at the first save of a mail host
 * and at every start where a host is stored (`recordMailEverConfigured`), kept
 * by a restore, and never removed: so the leave to set up two-step sign-in on
 * the password alone (card 2769, R1), given only where no mail host is set,
 * never opens again once one was, whatever removes the mail settings since (a
 * Remove of held mail, a demotion, a disable, a working copy).
 */
export const MAIL_EVER_CONFIGURED = 'mail_ever_configured_at';

/** Whether mail has ever been set up on this server (R9). */
export function mailEverConfigured(): boolean {
	return getSetting(MAIL_EVER_CONFIGURED) !== null;
}

/** Record that mail is set up, once: the first moment stays. In the caller's transaction where one is open. */
export function recordMailEverConfigured(): void {
	if (getSetting(MAIL_EVER_CONFIGURED) === null) setSetting(MAIL_EVER_CONFIGURED, stamp());
}

/**
 * Whether the mail settings are held for the superadmin's review (card 2922):
 * a host is stored, and the place it sends to is held (setting-holds.ts).
 * `isSmtpConfigured` still says yes, so that nothing reads a held mail as no
 * mail at all (the password-alone leave above all); every mail is refused at
 * `deliverMail`, and every place that asks whether one can go asks
 * `mailCannotSend`.
 */
export function mailHeld(): boolean {
	// Nothing read of the mail settings while nothing is held (the code review's C13).
	if (!anyHeld()) return false;
	return mailHeldAt(mailConnectionAsRead());
}

/** Whether the App URL row is held for the superadmin's review (card 2922): a stored row at a held place. */
export function appUrlHeld(): boolean {
	if (!anyHeld()) return false;
	const stored = getSetting('app_url');
	return stored !== null && appUrlHeldAt(appUrlAsRead(stored));
}

/**
 * What a held mail is told (`MAIL_PROBLEM_WORDS.held`), in the words of why the mail settings read as `connection` are
 * held (card 3009's code review, FP4): an ended setter's access as before, or a backup whose seal did not verify, which
 * names no setter. Read at the moment it is said, as the hold is.
 */
export function mailHeldWords(connection: { host: string; port: number; user: string; allowInsecure: boolean } = mailConnectionAsRead()): string {
	const because = connection.host === '' ? null : heldBecauseAt(MAIL_SETTING, mailPlaceOf(connection));
	if (because === HELD_REMOVED_HERE || because === HELD_NOT_RECORDED) return MAIL_HELD_BY_RECORD;
	return because === UNSEALED_RESTORE ? MAIL_HELD_UNSEALED : MAIL_PROBLEM_WORDS.held;
}

/** A mail problem in the words an answer uses (`MAIL_PROBLEM_WORDS`), a held mail's by why it is held (FP4). */
export function mailProblemWords(problem: MailProblem): string {
	return problem === 'held' ? mailHeldWords() : MAIL_PROBLEM_WORDS[problem];
}

/**
 * Whether no mail can go although a mail host is set (card 2922, its plan's
 * R12): its password missing or unopenable (`smtpPasswordMissing`), or the
 * mail settings held for review (`mailHeld`). Asked wherever the server
 * decides before sending whether a mail can go; `deliverMail` refuses a held
 * mail whatever was asked.
 */
export function mailCannotSend(): boolean {
	return smtpPasswordMissing() || mailHeld();
}

/** Why no mail can go although a host is set, in `MAIL_PROBLEM_WORDS`'s terms, or null: held first, then no password. */
export function mailCannotSendProblem(): 'held' | 'no-password' | null {
	if (mailHeld()) return 'held';
	return smtpPasswordMissing() ? 'no-password' : null;
}

/**
 * Whether the mail settings name a user and hold no password: every mail
 * would fail to sign in. What a restore leaves until the password is entered
 * again, since a backup does not hold it (card 2169). And where the stored one
 * does not open under this server's key (card 2898, S3), which is as good as
 * none.
 */
export function smtpPasswordMissing(): boolean {
	if (!getSetting('smtp_user')) return false;
	const pass = storedMailPassword();
	return pass.kind === 'empty' || pass.kind === 'unopenable';
}

// ─── App URL ─────────────────────────────────────────────────────────────────

/**
 * An App URL as a link reads it: trimmed, with no trailing slash, and
 * `http://` added to one with no scheme; empty text for none. What
 * `getAppUrl()` makes of the setting or `APP_URL`, and what a save compares
 * (card 2401). The scheme in any case, as an address reads it and as a save
 * accepts it: `HTTPS://Host` was read as `http://HTTPS://Host` (card 2401's
 * review).
 */
export function appUrlAsRead(value: string): string {
	const url = value.trim().replace(/\/+$/, '');
	return url && !/^https?:\/\//i.test(url) ? `http://${url}` : url;
}

/** The origin of an http or https address, or null for text that is no such address. */
function httpOrigin(address: string): string | null {
	try {
		const url = new URL(address);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
	} catch {
		return null;
	}
}

/**
 * The origins this server's configuration names as its own address (card
 * 2847, D2): `APP_URL`'s, as a link reads it, where it is set, and `ORIGIN`'s,
 * as the adapter reads it, where it is set and is not `PLACEHOLDER_ORIGIN`,
 * the image's default, which is nobody's real address. Empty where neither
 * is: the App URL setting is then the only word on the address.
 */
export function environmentOrigins(): string[] {
	const origins: string[] = [];
	const fromAppUrl = httpOrigin(appUrlAsRead(process.env.APP_URL || ''));
	if (fromAppUrl !== null) origins.push(fromAppUrl);
	const origin = configuredOrigin();
	if (origin !== null && origin !== PLACEHOLDER_ORIGIN && !origins.includes(origin)) origins.push(origin);
	return origins;
}

/**
 * Whether an App URL, as a link reads it, may be used (card 2847): always
 * where the configuration names no address, and otherwise only on one of its
 * origins. The host's configuration wins over a setting any account saves.
 */
export function appUrlOnEnvironment(url: string, origins: string[] = environmentOrigins()): boolean {
	if (origins.length === 0) return true;
	const origin = httpOrigin(url);
	return origin !== null && origins.includes(origin);
}

/**
 * An App URL as it is checked, stored and used, one string for all three
 * (card 2847's code review, CS1): empty text for none; otherwise, read as a
 * link reads it (`appUrlAsRead`), the origin and path of the address it
 * parses to, trailing slashes stripped. Null for text that is no plain web
 * address: one that does not parse as http or https, holds a backslash or a
 * control character, a user name or password, a query or a fragment, or a
 * path that begins `//`. The origin check judged the parsed address while the
 * text was stored and mailed as typed, so `https://host\@evil` or a line break
 * before `@host` passed it and sent readers elsewhere.
 */
export function appUrlNormalised(value: string): string | null {
	const read = appUrlAsRead(value);
	if (read === '') return '';
	if (/[\p{Cc}\\]/u.test(read)) return null;
	let url: URL;
	try {
		url = new URL(read);
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	if (url.username || url.password || url.search || url.hash || url.pathname.startsWith('//')) return null;
	return (url.origin + url.pathname).replace(/\/+$/, '');
}

/** The App URL setting as a link reads it, used or not, or null for no row or one that reads as none. */
export function storedAppUrlText(): string | null {
	return appUrlAsRead(getSetting('app_url') || '') || null;
}

/** The App URL setting as it would be used (`appUrlNormalised`), or null for no row, one that reads as none, or one that is no plain web address. */
export function storedAppUrl(): string | null {
	const text = storedAppUrlText();
	return text === null ? null : appUrlNormalised(text) || null;
}

/**
 * Whether a stored App URL is ignored: on another origin than the server's
 * configuration names (card 2847, D3), saved before that card by any
 * administrator or brought by an import; or, since its code review (CS1), no
 * plain web address. Said once at start (`reportAppUrlNotUsed`).
 */
export function appUrlIgnored(): boolean {
	if (storedAppUrlText() === null) return false;
	const stored = storedAppUrl();
	return stored === null || !appUrlOnEnvironment(stored);
}

/**
 * Get the configured app URL (no trailing slash): the App URL setting, or
 * failing that the `APP_URL` environment variable.
 *
 * A setting on another origin than the server's configuration names
 * (`environmentOrigins`) is not used (card 2847, D3): `APP_URL`'s is
 * answered, or null, so that `linkBaseUrl` falls to `ORIGIN`. A row that
 * reads as none (spaces alone) still answers null, as before. A row that is
 * no plain web address is not used either, and one that is is answered as
 * `appUrlNormalised` makes it, the string the origin was checked on (CS1).
 */
export function getAppUrl(): string | null {
	const stored = getSetting('app_url');
	// A row held for the superadmin's review is not used (card 2922): `APP_URL` is answered, or null.
	if (stored && appUrlHeldAt(appUrlAsRead(stored))) return appUrlAsRead(process.env.APP_URL || '') || null;
	if (stored) {
		if (!appUrlAsRead(stored)) return null;
		const normal = appUrlNormalised(stored);
		if (normal && appUrlOnEnvironment(normal)) return normal;
	}
	return appUrlAsRead(process.env.APP_URL || '') || null;
}

/**
 * Where the App URL `getAppUrl()` answers comes from (card 2401): the
 * setting, which wins whenever a row holds any text it uses; `APP_URL`, where
 * no row does (an empty row is none) or the row is ignored (card 2847); or
 * neither. A row of spaces alone is `none`, as `getAppUrl()` answers null for
 * it. The admin panel says which, so that an App URL from the environment is
 * not taken for one saved.
 */
export function appUrlFrom(): 'setting' | 'environment' | 'none' {
	const stored = getSetting('app_url');
	if (stored) {
		if (!appUrlAsRead(stored)) return 'none';
		// Held for review (card 2922): not in use, as `getAppUrl` has it.
		if (!appUrlIgnored() && !appUrlHeldAt(appUrlAsRead(stored))) return 'setting';
	}
	return appUrlEnvSet() ? 'environment' : 'none';
}

/**
 * Whether `APP_URL` holds an App URL, as a link reads it (card 2401's review),
 * so that the panel can say what clearing a saved one goes back to: `APP_URL`,
 * or `ORIGIN` where it is not set. Its value is answered whenever it is in
 * effect, so this says nothing new.
 */
export function appUrlEnvSet(): boolean {
	return appUrlAsRead(process.env.APP_URL || '') !== '';
}

/**
 * Whether the App URL setting holds a row that is not used: text that reads
 * as none, such as a row of spaces alone saved before card 2117's rule (card
 * 2401's review), which still hides `APP_URL`; or, since card 2847, a row on
 * another origin than the server's configuration names, which is ignored. A
 * save writes over either although the App URL in effect reads the same, so
 * that the superadmin's empty save clears it.
 */
export function appUrlRowNotUsed(): boolean {
	const stored = getSetting('app_url');
	return !!stored && (!appUrlAsRead(stored) || appUrlIgnored());
}

/** Save the app URL setting. Empty text is none: `APP_URL` then applies again. */
export function setAppUrl(url: string): void {
	// Strip trailing slash
	setSetting('app_url', url.replace(/\/+$/, ''));
}

/** The `ORIGIN` the image is built with, which is nobody's real address. */
export const PLACEHOLDER_ORIGIN = 'http://localhost:3000';

/**
 * `ORIGIN` as the node adapter reads it (`parse_origin` in its handler): the
 * origin of the address it holds, so `https://kanban.example.com/` and
 * `https://KANBAN.example.com` are both `https://kanban.example.com`. Null if
 * it is not set, or is not an http or https address: the adapter refuses to
 * start on that, so in a built server it is never the case.
 */
export function configuredOrigin(value: string | undefined = process.env.ORIGIN): string | null {
	if (value === undefined) return null;
	try {
		const url = new URL(value.trim());
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
	} catch {
		return null;
	}
}

/**
 * The address a link in a mail begins with, with no trailing slash, or null
 * if this server has none it may use.
 *
 * In order:
 *
 *   1. the App URL setting, the superadmin's (card 2847), and only where it
 *      is on an origin the server's configuration names, if it names any
 *      (`getAppUrl`);
 *   2. the `APP_URL` environment variable;
 *   3. `ORIGIN`, the address the server was started with, as the adapter
 *      reads it.
 *
 * All three are configuration. Nothing a request says is used in a built
 * server: not `Host`, not `X-Forwarded-Host`, not the address it was sent to.
 * A link used to take its host from `X-Forwarded-Host` when no App URL was
 * set, so whoever could send a request could have an invite mailed with a
 * link to a server of their own, and an invite sets a password.
 *
 * Under `vite dev` there is no `ORIGIN`, and the address the request was sent
 * to (`url`) is used last of all, as it always was.
 *
 * Null, then, is a built server started with no `ORIGIN` and given no App
 * URL. What each caller does about it is its own to say: an invite and a
 * public request are refused before anything is written (`NO_LINK_ADDRESS`),
 * and a notification is not sent (`notifications.ts`).
 *
 * `isDev` is the mode, and is this server's own unless it is given: a test
 * asks what a built server does by passing `false`.
 *
 * Composed since card 2922's code review (C9): the App URL setting as
 * `getAppUrl` gives it (with `APP_URL` behind it), else what the server would
 * answer with no setting at all (`linkBaseUrlWithoutAppUrlSetting`).
 */
export function linkBaseUrl(url?: URL, isDev: boolean = dev): string | null {
	return getAppUrl() ?? linkBaseUrlWithoutAppUrlSetting(url, isDev);
}

/**
 * The address a link would begin with were the App URL setting not used
 * (card 2922, its plan's R8): `APP_URL`, then `ORIGIN`, then, under dev, the
 * request's own. What `linkBaseUrl` answers once a reset has held the App URL
 * an account set, asked before the reset so that one that would leave no
 * address is refused before anything is held or ended.
 */
export function linkBaseUrlWithoutAppUrlSetting(url?: URL, isDev: boolean = dev): string | null {
	const fromEnv = appUrlAsRead(process.env.APP_URL || '');
	if (fromEnv) return fromEnv;
	const origin = configuredOrigin();
	if (origin) return origin;
	if (isDev && url) return `${url.protocol}//${url.host}`;
	return null;
}

/**
 * What a request is refused with when the link it would mail cannot be made.
 * It lives in `$lib/mail-words`, which the browser may load too (card 2676,
 * F7), and is re-exported here so that its importers are unchanged.
 */
export { NO_LINK_ADDRESS } from '$lib/mail-words';

// ─── Transporter ─────────────────────────────────────────────────────────────

/**
 * The transport every mail is sent through (card 2189):
 *
 *     port 465     TLS from the first byte (`secure`)
 *     any other    STARTTLS required (`requireTLS`): a server that does not
 *                  offer it is refused (`ETLS`) before the password is sent,
 *                  where nodemailer upgrades only when the greeting offers it
 *     every port   the certificate checked for the host's name
 *                  (`rejectUnauthorized`); `NODE_EXTRA_CA_CERTS` adds to the
 *                  authorities trusted
 *
 * With the way out (`allowInsecure`) on, any port but 465 is as it was before
 * the card: STARTTLS when offered, the certificate not checked. Port 465
 * checked the certificate before and still does (the plan's R9).
 *
 * The check the deployment guide runs before deploying (docs/deployment.md,
 * Mail Server Certificates: the query that reads the mail settings and calls
 * `verify()`, and the same in the new image) builds these same options, so it
 * tells what the first mail will meet: change the two together.
 */
function createTransporter(config: SmtpConfig): Transporter {
	const implicitTls = config.port === 465;
	const checked = implicitTls || !config.allowInsecure;

	return nodemailer.createTransport({
		host: config.host,
		port: config.port,
		secure: implicitTls,
		requireTLS: !implicitTls && checked,
		auth: config.user ? { user: config.user, pass: config.pass } : undefined,
		// With a user set, the password is always sent, and a server that does
		// not ask for one is not mailed through without it (card 2898, S3).
		...(config.user ? { forceAuth: true } : {}),
		tls: { rejectUnauthorized: checked },
		name: 'dumpfire.app', // Explicit EHLO name prevents Google 421 rate-limit errors from local computer names
		connectionTimeout: 10000,
		greetingTimeout: 10000,
		socketTimeout: 15000
	});
}

/**
 * What Send Test, and the log, add when mail fails for the certificate or
 * STARTTLS (card 2189, decision 15): the two ways to put it right.
 */
export const TLS_FAULT_HINT =
	"The mail server's certificate could not be checked, or the server does not offer STARTTLS. For a certificate " +
	"from a private authority, see docs/deployment.md, Mail Server Certificates; for a relay on this server's own " +
	'network that cannot use TLS, tick "Allow mail without a checked, encrypted connection" and type the password again.';

/**
 * `TLS_FAULT_HINT` when `err` is a failure of the certificate or of STARTTLS,
 * otherwise null. nodemailer codes a STARTTLS refused or not offered, and a
 * handshake that fails, `ETLS`; a certificate refused during the handshake
 * can also come back as `ESOCKET` ("Hostname/IP does not match certificate's
 * altnames", "self-signed certificate"), so the message is read as well, and
 * nodemailer 10 codes a server that answers neither EHLO nor STARTTLS
 * `ECONNECTION`, "EHLO failed but HELO does not support required STARTTLS"
 * (the review-fix pass's S6). A sign-in refused or a timeout is neither.
 *
 * The one test of the error, shared with `mailProblem`'s `secure-connection`
 * (card 2196): `isTlsFault`, below.
 */
export function tlsFaultHint(err: unknown): string | null {
	return isTlsFault(err) ? TLS_FAULT_HINT : null;
}

/**
 * Whether `err` is a failure of the certificate or of STARTTLS: coded `ETLS`
 * (or `EREQUIRETLS`, a server without the REQUIRETLS extension), or saying
 * so in nodemailer's or Node's own words. The mail server's reply, which
 * nodemailer keeps as `response` and adds to the end of the message, is not
 * read for the words: a refusal whose text happens to say "certificate" is
 * the server's answer to the message, not a connection that failed (card
 * 2196's N3). nodemailer's "EHLO failed but HELO does not support required
 * STARTTLS" carries a reply, and its own words still say STARTTLS.
 */
function isTlsFault(err: unknown): boolean {
	if (err === null || typeof err !== 'object') return false;
	const { code, message, response } = err as { code?: unknown; message?: unknown; response?: unknown };
	if (code === 'ETLS' || code === 'EREQUIRETLS') return true;
	if (typeof message !== 'string') return false;
	const own =
		typeof response === 'string' && response !== '' && message.endsWith(`: ${response}`)
			? message.slice(0, message.length - response.length - 2)
			: message;
	return /certificate|altnames|self[- ]signed|STARTTLS/i.test(own);
}

/** `text` ended as a sentence, so that another can follow it. */
export function asSentence(text: string): string {
	const trimmed = text.trim().replace(/[\s:;,]+$/, '');
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** How often, at most, a mail that fails for the certificate or STARTTLS is said in the log. */
const TLS_WARNING_EVERY_MS = 10 * 60 * 1000;
let lastTlsWarning = -Infinity;

/**
 * A `WARN` line, at most once in ten minutes in a process, when a mail sent
 * after its write fails for the certificate or STARTTLS (the plan's R3).
 * Those mails are logged as an `ERROR` and nothing else, so a mail server the
 * new check refuses would otherwise stop invites, notifications, reports and
 * the backup failure mail together with nothing on the log page to say why.
 *
 * Called by `deliverMail` after its `ERROR` line, with the same masked
 * `detail` (card 2196, R-M1), and not for Send Test, whose answer already
 * says the same to the administrator who pressed it. So one failure is one
 * `ERROR`, and this line is said beside it only as the reminder it is: the
 * first such failure in ten minutes.
 */
function warnIfTlsFault(err: unknown, detail: string): void {
	const hint = tlsFaultHint(err);
	if (hint === null) return;
	const now = Date.now();
	if (now - lastTlsWarning < TLS_WARNING_EVERY_MS) return;
	lastTlsWarning = now;
	log.warn(`Mail is not being sent: ${asSentence(detail)} ${hint}`);
}

// ─── What Became of a Mail (card 2196) ───────────────────────────────────────

/**
 * Why a mail did not go, read from nodemailer's error codes (`mailProblem`).
 * `not-configured` is a mail with no mail host to send it to, which is not
 * counted as a failure.
 */
export type MailProblem =
	| 'not-configured'
	| 'held'
	| 'no-password'
	| 'password-unopenable'
	| 'secure-connection'
	| 'unreachable'
	| 'sign-in'
	| 'refused'
	| 'failed';

/**
 * Each problem in the words an answer and the mail panel use. Never the mail
 * server's own words, which can name the mail host and its user name: those
 * are read on the mail panel and in the system log (decision 10; the panel is
 * every administrator's since card 2395), not in an answer.
 */
export const MAIL_PROBLEM_WORDS: Record<MailProblem, string> = {
	'not-configured': 'mail is not set up on this server',
	held:
		"the mail settings are held for the superadmin's review, as the account that set them had its access ended; the superadmin keeps or removes them under Settings held for review on the admin page",
	'no-password': 'the mail password has not been entered on this server; an administrator enters it under 📧 Email / SMTP',
	'password-unopenable':
		'the mail password stored on this server cannot be opened, so it must be entered again; an administrator enters it under 📧 Email / SMTP',
	'secure-connection': "the mail server's certificate could not be checked, or it does not offer STARTTLS",
	unreachable: 'the mail server could not be reached',
	'sign-in': 'the mail server refused the sign-in',
	refused: 'the mail server did not accept the message',
	failed: 'the mail could not be sent'
};

/**
 * A held mail's words where the mail settings came in with a backup whose seal did not verify (card 3009, R4; its code
 * review, FP4): nobody set them, so no setter is named, and where they send is only the file's word.
 */
export const MAIL_HELD_UNSEALED =
	"the mail settings are held for the superadmin's review, as they came in with a backup whose seal did not verify, so the mail host is only the file's word; the superadmin checks it and keeps or removes them under Settings held for review on the admin page";

/**
 * A held mail's words where a restore held the mail settings by this server's record of where it sends (card 3004):
 * moved or removed here since the backup was made, or not in the record. Names no setter.
 */
export const MAIL_HELD_BY_RECORD =
	"the mail settings are held for the superadmin's review, as they came back with a restore though they were moved or removed on this server since the backup was made, or are not in this server's record of where it sends; the superadmin checks them and keeps or removes them under Settings held for review on the admin page";

/**
 * Whether a mail went: handed to the mail server and accepted by it. A bounce
 * afterwards goes to the From address, and is not known here. `detail` is the
 * error's message, masked by `maskMailText` and cut at 500 characters.
 */
export type MailOutcome = { sent: true } | { sent: false; problem: MailProblem; detail: string };

/**
 * The problem of an error nodemailer threw:
 *
 *     secure-connection   the certificate or STARTTLS (`isTlsFault`, the
 *                         test Send Test's sentence is given by)
 *     no-password         EAUTH from nodemailer itself (`command` 'API',
 *                         "Missing credentials"): a mail user and no
 *                         password, as a restore leaves the settings (card
 *                         2169). Nothing was asked of the mail server, so
 *                         it is not a sign-in the server refused
 *     sign-in             EAUTH otherwise
 *     refused             EENVELOPE, EMESSAGE
 *     unreachable         ECONNECTION, EDNS, ETIMEDOUT, ESOCKET
 *     failed              anything else
 */
export function mailProblem(err: unknown): Exclude<MailProblem, 'not-configured' | 'held'> {
	if (isTlsFault(err)) return 'secure-connection';
	const { code, command } = (err !== null && typeof err === 'object' ? err : {}) as { code?: unknown; command?: unknown };
	switch (code) {
		case 'EAUTH':
			return command === 'API' ? 'no-password' : 'sign-in';
		case 'EENVELOPE':
		case 'EMESSAGE':
			return 'refused';
		case 'ECONNECTION':
		case 'EDNS':
		case 'ETIMEDOUT':
		case 'ESOCKET':
			return 'unreachable';
		default:
			return 'failed';
	}
}

/**
 * A run of 16 or more hex digits and hyphens, in any case: an invite's token
 * is a UUID (`invites.ts`), a public request's 64 hex digits
 * (`request-tokens.ts`).
 */
const BARE_TOKEN = /[0-9a-f-]{16,}/gi;

/**
 * A hyphen encoded: `%2D`, `&#45;` or `&#x2D;`, in any case. Encoded, the
 * hyphens of a UUID break it into runs of 12 characters or fewer, which
 * `BARE_TOKEN` would leave; so they are read back first (the review-fix
 * pass's item 6).
 */
const ENCODED_HYPHEN = /%2d|&#0*45;|&#x0*2d;/gi;

/**
 * A slash encoded: `%2F`, `&#47;` or `&#x2F;`, in any case. Encoded, a
 * decision link's path is not one `maskSecretPaths` finds, so they are read
 * back first, as the hyphens are (card 2675, the code review's S1).
 */
const ENCODED_SLASH = /%2f|&#0*47;|&#x0*2f;/gi;

/**
 * A run of 32 or more base64url characters: a decision link's token is 43
 * (decision-links.ts), and is not hex, so `BARE_TOKEN` alone would leave it
 * wherever it stood outside its path, or in a piece of it split across two
 * reply lines (S1).
 */
const LONG_TOKEN = /[A-Za-z0-9_-]{32,}/g;

/**
 * The mail server's words, fit to log and to show: an encoded hyphen read
 * back as `-` and an encoded slash as `/`, `maskSecretPaths` in any case,
 * then every run of 16 or more hex digits and hyphens, and every run of 32 or
 * more base64url characters, becomes `[token]` (R-M1; card 2675's S1).
 *
 * A refusal can quote the mail's link, and nodemailer adds the server's reply
 * to its message: URL-encoded, in capitals, with HTML entities, or split
 * across two reply lines after `/invite/`, none of which `maskSecretPaths`
 * finds. Each leaves the token's own characters as they are, which this
 * finds, and a piece of one split inside it is masked if it is 16 characters
 * or more. The cost is the odd queue id, which the mail provider's own log
 * keeps. Not in `maskSecretPaths`, which is run over the whole log at start:
 * it would mask every UUID there.
 */
export function maskMailText(text: string): string {
	const decoded = text.replace(ENCODED_HYPHEN, '-').replace(ENCODED_SLASH, '/');
	// The long runs first, so that no hex run inside a token is masked alone and leaves the rest of it.
	return maskSecretPaths(decoded, { anyCase: true }).replace(LONG_TOKEN, '[token]').replace(BARE_TOKEN, '[token]');
}

/** How much of the mail server's words is kept. */
const MAIL_DETAIL_MAX = 500;

/** The last mail that failed, as the mail panel shows it. */
export type MailFailure = { at: string; subject: string; problem: string; detail: string };

/**
 * What mail has done since the server started (decision 11): kept in memory,
 * never in the database, so that a mail sent after a request writes no row
 * that the request did not, and no backup carries another server's mail.
 * A restart starts it again; the system log keeps each failure for 30 days.
 */
export type MailStatus = {
	since: string;
	sent: number;
	failed: number;
	lastSentAt: string | null;
	lastFailure: MailFailure | null;
};

const freshStatus = (): MailStatus => ({
	since: new Date().toISOString(),
	sent: 0,
	failed: 0,
	lastSentAt: null,
	lastFailure: null
});

let status: MailStatus = freshStatus();

/** A copy of what mail has done since the server started, for `GET /api/admin/smtp`. */
export function mailStatus(): MailStatus {
	return { ...status, lastFailure: status.lastFailure && { ...status.lastFailure } };
}

/** Start the record again, and the ten minutes of R3's line, as a restart does. For the tests' `resetDb`. */
export function resetMailStatus(): void {
	status = freshStatus();
	lastTlsWarning = -Infinity;
}

type MailMessage = {
	to: string;
	subject: string;
	html: string;
	attachments?: { filename: string; content: Buffer; contentType: string }[];
};

/**
 * The one place a mail is handed to the mail server: every mail DumpFire
 * sends comes through here, and says whether it went.
 *
 * Sent, it is counted, with when. Failed, it is counted and kept as the last
 * failure, with its subject and not its recipient, and logged as one `ERROR`
 * line, `Failed to send email to <to>: <subject>`, whose fields are the
 * error's code, command and reply code, the problem and the masked `detail`.
 * The error itself is never handed to the logger: its stack, and its
 * `response`, carry the mail server's words unmasked (R-M1). With no mail
 * host, nothing is sent, counted or logged: `not-configured`.
 *
 * `test` is Send Test, which throws what this says and is not given R3's
 * line (`warnIfTlsFault`).
 *
 * `recipient` names the recipient in the log line in place of the address,
 * and stands for the address wherever the mail server's words quote it, in
 * `detail` too: a decision's record mail passes `participant <id> of decision
 * <id>`, so that no participant's address is logged (card 2675's code review,
 * S7), and every mail to a task request's requester passes `the requester of
 * request <id>` (`requesterLabel`, card 2896). Every other mail, to an
 * account holder, logs its address as before.
 */
async function deliverMail(
	message: MailMessage,
	{ test = false, recipient }: { test?: boolean; recipient?: string } = {}
): Promise<MailOutcome> {
	const config = getSmtpConfig();
	if (!config || !config.host) {
		return { sent: false, problem: 'not-configured', detail: MAIL_PROBLEM_WORDS['not-configured'] };
	}
	// Held for the superadmin's review (card 2922, its plan's R6): asked here, of the configuration just read and
	// with nothing awaited between this and the transport below, so a hold committed meanwhile is never missed. Not
	// counted and not logged, as a mail with no host is not: the hold's own line says that mail stops.
	if (mailHeldAt(config)) {
		return { sent: false, problem: 'held', detail: mailHeldWords(config) };
	}

	/** Counted, kept as the last failure and logged at ERROR, as every mail that did not go is. */
	const failed = (problem: Exclude<MailProblem, 'not-configured' | 'held'>, detail: string, fields: Record<string, unknown> = {}): MailOutcome => {
		status.failed++;
		status.lastFailure = {
			at: new Date().toISOString(),
			subject: message.subject,
			problem: MAIL_PROBLEM_WORDS[problem],
			detail
		};
		log.error(`Failed to send email to ${recipient ?? message.to}: ${message.subject}`, { ...fields, problem, detail });
		return { sent: false, problem, detail };
	};

	// A user set and no password to send, or one that cannot be opened (card
	// 2898, S3): refused before anything is asked of the mail server, so that
	// no mail server that does not ask for a password is mailed through without one.
	if (config.user && (config.passUnopenable || !config.pass)) {
		const problem = config.passUnopenable ? 'password-unopenable' : 'no-password';
		return failed(problem, MAIL_PROBLEM_WORDS[problem]);
	}

	try {
		const transporter = createTransporter(config);
		// The From last, as a name and an address apart (card 3029, R1, R2): nodemailer quotes the name, so no name adds an
		// address of its own, and nothing in the message replaces it.
		await transporter.sendMail({ ...message, from: mailFromAsRead(config.fromAddress, config.fromName) });
		status.sent++;
		status.lastSentAt = new Date().toISOString();
		return { sent: true };
	} catch (err) {
		const problem = mailProblem(err);
		const said = err instanceof Error ? err.message : String(err);
		const masked = maskMailText(said);
		const detail = (recipient === undefined || message.to === '' ? masked : withoutAddress(masked, message.to, recipient)).slice(0, MAIL_DETAIL_MAX);
		const { code, command, responseCode } = (err !== null && typeof err === 'object' ? err : {}) as {
			code?: unknown;
			command?: unknown;
			responseCode?: unknown;
		};
		const outcome = failed(problem, detail, {
			code: typeof code === 'string' ? code.slice(0, 40) : undefined,
			command: typeof command === 'string' ? command.slice(0, 40) : undefined,
			responseCode: typeof responseCode === 'number' ? responseCode : undefined
		});
		if (!test) warnIfTlsFault(err, detail);
		return outcome;
	}
}

/**
 * What a mail to a task request's requester is called in the log in place of
 * their address (card 2896): `deliverMail`'s `recipient`, in one spelling.
 */
export function requesterLabel(requestId: number): string {
	return `the requester of request ${requestId}`;
}

/** `text` with every occurrence of `address`, in any case, replaced by `[<label>]`. */
function withoutAddress(text: string, address: string, label: string): string {
	return text.replace(new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), `[${label}]`);
}

/**
 * What Send Test throws when its mail did not go: the masked `detail` as its
 * message, and the problem, which tells the route whether to add the two ways
 * to put the certificate or STARTTLS right.
 */
export class MailNotSent extends Error {
	constructor(
		readonly problem: MailProblem,
		detail: string
	) {
		super(detail);
		this.name = 'MailNotSent';
	}
}

// ─── Send Email ──────────────────────────────────────────────────────────────

/**
 * Send an email, and say whether it went (card 2196). With no mail host it is
 * not sent: `not-configured`. `opts.recipient` names the recipient in the
 * log in place of the address (`deliverMail`): a decision's record mail
 * passes it (card 2675's S7).
 */
export function trySendEmail(to: string, subject: string, html: string, opts: { recipient?: string } = {}): Promise<MailOutcome> {
	return deliverMail({ to, subject, html }, { recipient: opts.recipient });
}

/**
 * Send an email. Silently no-ops if SMTP is not configured.
 * Returns true if sent, false if not configured or failed.
 */
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
	return (await deliverMail({ to, subject, html })).sent;
}

/**
 * Send a test email to verify SMTP configuration.
 * Throws on failure so the caller can report the error: `MailNotSent`, whose
 * message is the mail server's words masked, as the log has them.
 */
export async function sendTestEmail(to: string): Promise<void> {
	const config = getSmtpConfig();
	if (!config || !config.host) throw new Error('SMTP not configured');

	const outcome = await deliverMail({
		to,
		subject: 'DumpFire — SMTP Test',
		html: `
			<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
				<h2 style="color: #6366f1;">SMTP Configuration Working!</h2>
				<p style="color: #64748b; line-height: 1.6;">
					Your DumpFire email notifications are properly configured.
					You'll now receive notifications for task assignments and updates.
				</p>
				<hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
				<p style="color: #94a3b8; font-size: 12px;">Sent from DumpFire</p>
			</div>
		`
	}, { test: true });
	if (!outcome.sent) throw new MailNotSent(outcome.problem, outcome.detail);
}

/**
 * Send an email with a file attachment. Used for scheduled PDF reports, and
 * for a requester's completion mail, which passes `opts.recipient` so that
 * its address is not logged (`requesterLabel`, card 2896).
 * Silently no-ops if SMTP is not configured.
 */
export async function sendEmailWithAttachment(
	to: string,
	subject: string,
	html: string,
	attachment: { filename: string; content: Buffer; contentType: string },
	opts: { recipient?: string } = {}
): Promise<boolean> {
	const outcome = await deliverMail({
		to,
		subject,
		html,
		attachments: [{
			filename: attachment.filename,
			content: attachment.content,
			contentType: attachment.contentType
		}]
	}, { recipient: opts.recipient });
	return outcome.sent;
}
