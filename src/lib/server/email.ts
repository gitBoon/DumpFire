/**
 * email.ts — SMTP email utility for DumpFire.
 *
 * Reads SMTP configuration from the settings table and provides
 * a simple sendEmail() function. Silently no-ops if SMTP is not configured.
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
	secure: boolean;
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
		secure: getSetting('smtp_secure') === 'true',
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
		if (config.secure !== undefined) setSetting('smtp_secure', String(config.secure));
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

function createTransporter(config: SmtpConfig): Transporter {
	// Port 465 = direct SSL, port 587/25 = STARTTLS (secure must be false)
	const useDirectSSL = config.port === 465;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return nodemailer.createTransport({
		host: config.host,
		port: config.port,
		secure: useDirectSSL,
		auth: config.user ? { user: config.user, pass: config.pass } : undefined,
		tls: { rejectUnauthorized: useDirectSSL || config.secure },
		family: 4, // Force IPv4 — prevents ETIMEDOUT on IPv6 DNS resolution
		name: 'dumpfire.app', // Explicit EHLO name prevents Google 421 rate-limit errors from local computer names
		connectionTimeout: 10000,
		greetingTimeout: 10000,
		socketTimeout: 15000
	} as any);
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
		return false;
	}
}
