import { json, error } from '@sveltejs/kit';
import { getSmtpConfig, saveSmtpConfig, sendTestEmail, getAppUrl, setAppUrl } from '$lib/server/email';
import type { RequestHandler } from './$types';
import { createLogger } from '$lib/server/logger';

const log = createLogger('SMTP');

/** GET — Return current SMTP config (password masked). */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

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

/** PUT — Save SMTP config. */
export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	const data = await request.json();

	// If pass is masked, don't overwrite existing password
	const config: Record<string, unknown> = { ...data };
	if (config.pass === '••••••••') {
		const existing = getSmtpConfig();
		config.pass = existing?.pass || '';
	}

	saveSmtpConfig(config);

	// Save App URL separately
	if (data.appUrl !== undefined) {
		setAppUrl(data.appUrl || '');
	}

	return json({ success: true });
};

/** POST — Send a test email. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	const { to } = await request.json();
	const recipient = to || locals.user.email;

	try {
		await sendTestEmail(recipient);
		return json({ success: true, message: `Test email sent to ${recipient}` });
	} catch (err: any) {
		log.error(`Test email to ${recipient} failed: ${err.message}`);
		throw error(500, `Failed to send test email: ${err.message}`);
	}
};
