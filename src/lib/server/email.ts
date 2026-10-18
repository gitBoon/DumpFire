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
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { dev } from '$app/environment';
import { db } from './db';
import { inTransaction } from './db/transaction';
import { settings } from './db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from './logger';

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
 */
export function tlsFaultHint(err: unknown): string | null {
	if (err === null || typeof err !== 'object') return null;
	const { code, message } = err as { code?: unknown; message?: unknown };
	if (code === 'ETLS') return TLS_FAULT_HINT;
	if (typeof message === 'string' && /certificate|altnames|self[- ]signed|STARTTLS/i.test(message)) return TLS_FAULT_HINT;
	return null;
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
 */
function warnIfTlsFault(err: unknown): void {
	const hint = tlsFaultHint(err);
	if (hint === null) return;
	const now = Date.now();
	if (now - lastTlsWarning < TLS_WARNING_EVERY_MS) return;
	lastTlsWarning = now;
	log.warn(`Mail is not being sent: ${asSentence(String((err as { message?: unknown }).message ?? err))} ${hint}`);
}

// ─── Send Email ──────────────────────────────────────────────────────────────

/**
 * Send an email. Silently no-ops if SMTP is not configured.
 * Returns true if sent, false if not configured or failed.
 */
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
	const config = getSmtpConfig();
	if (!config || !config.host) return false;

	try {
		const transporter = createTransporter(config);
		await transporter.sendMail({
			from: `"${config.fromName}" <${config.fromAddress}>`,
			to,
			subject,
			html
		});
		return true;
	} catch (err) {
		log.error(`Failed to send email to ${to}: ${subject}`, err);
		warnIfTlsFault(err);
		return false;
	}
}

/**
 * Send a test email to verify SMTP configuration.
 * Throws on failure so the caller can report the error.
 */
export async function sendTestEmail(to: string): Promise<void> {
	const config = getSmtpConfig();
	if (!config || !config.host) throw new Error('SMTP not configured');

	const transporter = createTransporter(config);
	await transporter.sendMail({
		from: `"${config.fromName}" <${config.fromAddress}>`,
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
	});
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
	const config = getSmtpConfig();
	if (!config || !config.host) return false;

	try {
		const transporter = createTransporter(config);
		await transporter.sendMail({
			from: `"${config.fromName}" <${config.fromAddress}>`,
			to,
			subject,
			html,
			attachments: [{
				filename: attachment.filename,
				content: attachment.content,
				contentType: attachment.contentType
			}]
		});
		return true;
	} catch (err) {
		log.error(`Failed to send email with attachment to ${to}: ${subject}`, err);
		warnIfTlsFault(err);
		return false;
	}
}
