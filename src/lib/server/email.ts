/**
 * email.ts — SMTP email utility for DumpFire.
 *
 * Reads SMTP configuration from the settings table and provides
 * a simple sendEmail() function. Silently no-ops if SMTP is not configured.
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { db } from './db';
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

/** Save SMTP configuration to the settings table. */
export function saveSmtpConfig(config: Partial<SmtpConfig>): void {
	if (config.host !== undefined) setSetting('smtp_host', config.host);
	if (config.port !== undefined) setSetting('smtp_port', String(config.port));
	if (config.secure !== undefined) setSetting('smtp_secure', String(config.secure));
	if (config.user !== undefined) setSetting('smtp_user', config.user);
	if (config.pass !== undefined) setSetting('smtp_pass', config.pass);
	if (config.fromAddress !== undefined) setSetting('smtp_from_address', config.fromAddress);
	if (config.fromName !== undefined) setSetting('smtp_from_name', config.fromName);
}

/** Quick check if SMTP is configured (has a host set). */
export function isSmtpConfigured(): boolean {
	return !!getSetting('smtp_host');
}

// ─── App URL ─────────────────────────────────────────────────────────────────

/** Get the configured app URL (no trailing slash). */
export function getAppUrl(): string | null {
	let url = getSetting('app_url') || process.env.APP_URL || null;
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

/**
 * Resolve the public-facing base URL for links (invite emails, etc.).
 * Priority: DB setting → APP_URL env → reverse proxy headers → request URL.
 */
export function resolveBaseUrl(request?: Request, url?: URL): string {
	// 1. Explicit setting (admin-configured or env var)
	const configured = getAppUrl();
	if (configured) return configured;

	// 2. Reverse proxy headers (nginx, Traefik, Cloudflare, etc.)
	if (request) {
		const forwardedHost = request.headers.get('x-forwarded-host');
		const forwardedProto = request.headers.get('x-forwarded-proto') || 'https';
		if (forwardedHost) {
			return `${forwardedProto}://${forwardedHost}`;
		}
	}

	// 3. Fall back to request URL
	if (url) {
		return `${url.protocol}//${url.host}`;
	}

	return 'http://localhost:3000';
}

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
