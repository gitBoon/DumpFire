/**
 * /api/admin/backup/gdrive/auth — Google Drive OAuth2 flow (manual code entry).
 *
 * GET  — Generate the Google OAuth consent URL (returned as JSON, not redirect)
 * POST — Exchange auth code for tokens
 *
 * Uses redirect_uri=urn:ietf:wg:oauth:2.0:oob which shows the code on a Google
 * page for the user to copy. This works without a public domain, making it ideal
 * for self-hosted instances.
 */

import { json, error } from '@sveltejs/kit';
import { google } from 'googleapis';
import { getBackupConfig, saveBackupConfig } from '$lib/server/backup';
import type { RequestHandler } from './$types';
import { createLogger } from '$lib/server/logger';

const log = createLogger('GDRIVE');

const SCOPES = ['https://www.googleapis.com/auth/drive'];

// Google's special redirect URI that displays the auth code on a page for the user to copy.
// This avoids requiring a public domain for the redirect.
const REDIRECT_URI = 'http://localhost';

/** GET — Generate the Google OAuth consent URL. */
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	const destName = url.searchParams.get('dest');
	if (!destName) throw error(400, 'Missing dest parameter');

	const config = getBackupConfig();
	const dest = config.destinations.find(d => d.name === destName && d.type === 'gdrive');
	if (!dest || dest.type !== 'gdrive') throw error(404, 'Google Drive destination not found');

	const { clientId, clientSecret } = dest as any;
	if (!clientId || !clientSecret) throw error(400, 'Client ID and Secret required');

	const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

	const authUrl = oauth2Client.generateAuthUrl({
		access_type: 'offline',
		prompt: 'consent',
		scope: SCOPES,
		state: destName
	});

	return json({ authUrl });
};

/** POST — Exchange an auth code for tokens and store the refresh token. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user || (locals.user.role !== 'admin' && locals.user.role !== 'superadmin')) {
		throw error(403, 'Forbidden');
	}

	const body = await request.json();
	const { code, destName } = body;

	if (!code || !destName) throw error(400, 'Missing code or destName');

	const config = getBackupConfig();
	const destIndex = config.destinations.findIndex(d => d.name === destName && d.type === 'gdrive');
	if (destIndex === -1) throw error(404, 'Google Drive destination not found');

	const dest = config.destinations[destIndex] as any;
	const { clientId, clientSecret } = dest;
	if (!clientId || !clientSecret) throw error(400, 'Client ID and Secret required');

	const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

	try {
		const { tokens } = await oauth2Client.getToken(code);
		if (!tokens.refresh_token) {
			return json({ success: false, message: 'No refresh token received. Try revoking app access at https://myaccount.google.com/permissions and reconnecting.' });
		}

		dest.refreshToken = tokens.refresh_token;
		config.destinations[destIndex] = dest;
		saveBackupConfig(config);

		return json({ success: true, message: 'Google Drive connected successfully!' });
	} catch (err: any) {
		log.error(`OAuth token exchange failed for destination "${destName}": ${err.message}`);
		return json({ success: false, message: err.message || 'Failed to exchange auth code' });
	}
};
