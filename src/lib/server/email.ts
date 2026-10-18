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

const log = createLogger('EMAIL');

// ─── Settings Helpers ────────────────────────────────────────────────────────

function getSetting(key: string): string | null {
	const row = db.select().from(settings).where(eq(settings.key, key)).get();
	return row?.value ?? null;
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
	pass: string;
	fromAddress: string;
	fromName: string;
};

/** Read SMTP config from the settings table. Returns null if not configured. */
export function getSmtpConfig(): SmtpConfig | null {
	const host = getSetting('smtp_host');
	if (!host) return null;

	return {
		host,
		port: Number(getSetting('smtp_port') || '587'),
		allowInsecure: getSetting('smtp_allow_insecure') === 'true',
		user: getSetting('smtp_user') || '',
		pass: getSetting('smtp_pass') || '',
		fromAddress: getSetting('smtp_from_address') || '',
		fromName: getSetting('smtp_from_name') || 'DumpFire'
	};
}

/**
 * Save SMTP configuration to the settings table.
 *
 * One transaction: each setting is a row of its own, and a failure part of
 * the way used to leave a new host saved with the old port and password.
 */
export function saveSmtpConfig(config: Partial<SmtpConfig>): void {
	inTransaction(() => {
		if (config.host !== undefined) setSetting('smtp_host', config.host);
		if (config.port !== undefined) setSetting('smtp_port', String(config.port));
		if (config.allowInsecure !== undefined) setSetting('smtp_allow_insecure', String(config.allowInsecure));
		if (config.user !== undefined) setSetting('smtp_user', config.user);
		if (config.pass !== undefined) setSetting('smtp_pass', config.pass);
		if (config.fromAddress !== undefined) setSetting('smtp_from_address', config.fromAddress);
		if (config.fromName !== undefined) setSetting('smtp_from_name', config.fromName);
	});
}

/** Quick check if SMTP is configured (has a host set). */
export function isSmtpConfigured(): boolean {
	return !!getSetting('smtp_host');
}

/**
 * Whether the mail settings name a user and hold no password: every mail
 * would fail to sign in. What a restore leaves until the password is entered
 * again, since a backup does not hold it (card 2169).
 */
export function smtpPasswordMissing(): boolean {
	return !!getSetting('smtp_user') && !getSetting('smtp_pass');
}

// ─── App URL ─────────────────────────────────────────────────────────────────

/**
 * Get the configured app URL (no trailing slash): the App URL setting, or
 * failing that the `APP_URL` environment variable.
 */
export function getAppUrl(): string | null {
	let url = (getSetting('app_url') || process.env.APP_URL || '').trim().replace(/\/+$/, '') || null;
	if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
		url = `http://${url}`;
	}
	return url;
}

/** Save the app URL setting. */
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
 *   1. the App URL setting;
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
 */
export function linkBaseUrl(url?: URL, isDev: boolean = dev): string | null {
	const configured = getAppUrl();
	if (configured) return configured;

	const origin = configuredOrigin();
	if (origin) return origin;

	if (isDev && url) return `${url.protocol}//${url.host}`;

	return null;
}

/** What a request is refused with when the link it would mail cannot be made. */
export const NO_LINK_ADDRESS =
	'This server has no address configured to make the link from, so nothing was sent and nothing was saved. ' +
	'The superadmin sets it as the App URL on the admin page, under Application Settings; or the server is ' +
	'started with ORIGIN set to its public address';

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
 * says the same to the superadmin who pressed it. So one failure is one
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
	| 'no-password'
	| 'secure-connection'
	| 'unreachable'
	| 'sign-in'
	| 'refused'
	| 'failed';

/**
 * Each problem in the words an answer and the mail panel use. Never the mail
 * server's own words, which can name the mail host and its user name: those
 * are the superadmin's settings, and an invite may be sent by any
 * administrator (decision 10).
 */
export const MAIL_PROBLEM_WORDS: Record<MailProblem, string> = {
	'not-configured': 'mail is not set up on this server',
	'no-password': 'the mail password has not been entered on this server; the superadmin enters it under 📧 Email / SMTP',
	'secure-connection': "the mail server's certificate could not be checked, or it does not offer STARTTLS",
	unreachable: 'the mail server could not be reached',
	'sign-in': 'the mail server refused the sign-in',
	refused: 'the mail server did not accept the message',
	failed: 'the mail could not be sent'
};

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
export function mailProblem(err: unknown): Exclude<MailProblem, 'not-configured'> {
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
 * The mail server's words, fit to log and to show: an encoded hyphen read
 * back as `-`, `maskSecretPaths`, then every run of 16 or more hex digits and
 * hyphens becomes `[token]` (R-M1).
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
	return maskSecretPaths(text.replace(ENCODED_HYPHEN, '-')).replace(BARE_TOKEN, '[token]');
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
 */
async function deliverMail(message: MailMessage, { test = false }: { test?: boolean } = {}): Promise<MailOutcome> {
	const config = getSmtpConfig();
	if (!config || !config.host) {
		return { sent: false, problem: 'not-configured', detail: MAIL_PROBLEM_WORDS['not-configured'] };
	}

	try {
		const transporter = createTransporter(config);
		await transporter.sendMail({ from: `"${config.fromName}" <${config.fromAddress}>`, ...message });
		status.sent++;
		status.lastSentAt = new Date().toISOString();
		return { sent: true };
	} catch (err) {
		const problem = mailProblem(err);
		const said = err instanceof Error ? err.message : String(err);
		const detail = maskMailText(said).slice(0, MAIL_DETAIL_MAX);
		const { code, command, responseCode } = (err !== null && typeof err === 'object' ? err : {}) as {
			code?: unknown;
			command?: unknown;
			responseCode?: unknown;
		};
		status.failed++;
		status.lastFailure = {
			at: new Date().toISOString(),
			subject: message.subject,
			problem: MAIL_PROBLEM_WORDS[problem],
			detail
		};
		log.error(`Failed to send email to ${message.to}: ${message.subject}`, {
			code: typeof code === 'string' ? code.slice(0, 40) : undefined,
			command: typeof command === 'string' ? command.slice(0, 40) : undefined,
			responseCode: typeof responseCode === 'number' ? responseCode : undefined,
			problem,
			detail
		});
		if (!test) warnIfTlsFault(err, detail);
		return { sent: false, problem, detail };
	}
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
 * not sent: `not-configured`.
 */
export function trySendEmail(to: string, subject: string, html: string): Promise<MailOutcome> {
	return deliverMail({ to, subject, html });
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
 * Send an email with a file attachment. Used for scheduled PDF reports.
 * Silently no-ops if SMTP is not configured.
 */
export async function sendEmailWithAttachment(
	to: string,
	subject: string,
	html: string,
	attachment: { filename: string; content: Buffer; contentType: string }
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
	});
	return outcome.sent;
}
