/**
 * /api/admin/backup/gdrive/auth — Google Drive OAuth2 flow (manual code entry).
 *
 * GET  — Generate the Google OAuth consent URL (returned as JSON, not redirect)
 * POST — Exchange auth code for tokens
 *
 * The consent address redirects to `http://localhost`, where the browser shows
 * an error page whose address holds the code for the user to copy. This works
 * without a public domain, for self-hosted instances.
 *
 * DumpFire asks for `drive.file` alone (card 2188): the files it makes, never
 * the whole of the account's Drive, which it asked for before. A connection
 * made before keeps what it was granted until it is connected again; Connect
 * records the scope Google granted (`grantedScope`), so the page can tell the
 * two apart. With `drive.file` DumpFire cannot be sure of reaching a folder it
 * did not make, so Connect makes one of its own when the Folder ID is empty,
 * and checks the one it is given when it is not.
 *
 * The superadmin's alone: see `/api/admin/backup`.
 */

import { json, error } from '@sveltejs/kit';
import { google, type drive_v3 } from 'googleapis';
import { DRIVE_FILE_SCOPE, driveScopeIsNarrow } from '$lib/drive-scope';
import { getBackupConfig, saveBackupConfig } from '$lib/server/backup';
import { makeDumpfireFolder, reachFolder } from '$lib/server/backup-destinations';
import { requireSuperadmin } from '$lib/server/route-guards';
import { readBody, readText } from '$lib/server/request-body';
import type { RequestHandler } from './$types';
import { createLogger } from '$lib/server/logger';

const log = createLogger('GDRIVE');

/** What Connect asks Google for: DumpFire's own files, nothing else (card 2188, decision 6). */
const SCOPES = [DRIVE_FILE_SCOPE];

// Google's special redirect URI that displays the auth code on a page for the user to copy.
// This avoids requiring a public domain for the redirect.
const REDIRECT_URI = 'http://localhost';

/** Why a Connect is refused when the folder the destination names cannot be reached (decision 8). */
const CANNOT_REACH = 'Google gave DumpFire access only to the files it makes, and it cannot reach the folder this destination names, so no backup could be written there.';

/** The remedy, for a connection that reaches only DumpFire's files, or none yet. */
const REMEDY_NARROW = 'To use a folder DumpFire makes itself, remove this destination, add it again with the Folder ID left empty, and connect it.';

/**
 * The remedy for a connection made before card 2188, or of a scope that is
 * not `drive.file` alone, whose grant reaches the whole of Drive: ending that
 * grant comes first, since ending it after would end the new connection too
 * (the review's R2).
 */
const REMEDY_WIDE =
	"To use a folder DumpFire makes itself, first remove DumpFire's access in the Google account (Google Account, Security, Your " +
	'connections to third-party apps and services), then remove this destination, add it again with the Folder ID left empty, and connect it.';

/** Why a Connect is refused when the destination was saved meanwhile (decision 9). */
const CHANGED_MEANWHILE = 'The destination was changed or removed while it was being connected, so the connection was not saved. Connect it again.';

/** GET — Generate the Google OAuth consent URL. */
export const GET: RequestHandler = async ({ locals, url }) => {
	requireSuperadmin(locals.user);

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

/**
 * POST — Exchange an auth code for tokens and store the refresh token.
 *
 * In this order (card 2188, the review's R5): the code exchanged; no refresh
 * token, and nothing is made or written; then, with the new token, the Folder
 * ID fetched (`reachFolder`) and the Connect refused if it cannot be reached,
 * or, when it is empty, a folder of DumpFire's own made; then the settings
 * read again and written, with no `await` between the two, only if the
 * destination is still there with the client id, client secret and Folder ID
 * it had when the Connect began (decision 9). The settings read before
 * Google's answers used to be written back after them, over any save made
 * meanwhile. A folder made for a Connect that is not saved is deleted again.
 * The token, the scope Google granted (none where it names none, R6) and a
 * new folder's id are saved together.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireSuperadmin(locals.user);

	// Each text: `code` that was not was handed to Google as it was sent.
	const body = await readBody(request);
	const MISSING = 'Missing code or destName';
	const code = readText(body, 'code', { required: true, min: 1, says: { missing: MISSING, empty: MISSING } });
	const destName = readText(body, 'destName', { required: true, min: 1, says: { missing: MISSING, empty: MISSING } });

	const config = getBackupConfig();
	const destIndex = config.destinations.findIndex(d => d.name === destName && d.type === 'gdrive');
	if (destIndex === -1) throw error(404, 'Google Drive destination not found');

	const dest = config.destinations[destIndex] as any;
	const { clientId, clientSecret } = dest;
	if (!clientId || !clientSecret) throw error(400, 'Client ID and Secret required');
	const folderId: string = dest.folderId || '';
	const connectedBefore = !!dest.refreshToken;

	const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
	/** The folder this Connect made, until it is saved: deleted again if it is not. */
	let made: { id: string; name: string } | null = null;
	let drive: drive_v3.Drive | null = null;
	const removeMade = async () => {
		if (!made || !drive) return;
		try {
			await drive.files.delete({ fileId: made.id, supportsAllDrives: true });
		} catch (err: any) {
			log.warn(`Could not delete the folder ${made.id} made for destination "${destName}" by a Connect that was not saved: ${err?.message ?? err}`);
		}
	};

	try {
		const { tokens } = await oauth2Client.getToken(code);
		if (!tokens.refresh_token) {
			return json({ success: false, message: 'No refresh token received. Try revoking app access at https://myaccount.google.com/permissions and reconnecting.' });
		}
		oauth2Client.setCredentials(tokens);
		drive = google.drive({ version: 'v3', auth: oauth2Client });

		if (folderId) {
			const reached = await reachFolder(drive, folderId);
			if (!reached.reached) {
				log.warn(`Connect of destination "${destName}" refused: Google Drive cannot reach its folder ${folderId}: ${reached.reason}`);
				const wide = connectedBefore && !driveScopeIsNarrow(dest.grantedScope);
				const kept = connectedBefore ? 'Nothing was changed: the destination keeps the connection it had.' : 'Nothing was changed.';
				return json({ success: false, message: `${CANNOT_REACH} ${kept} ${wide ? REMEDY_WIDE : REMEDY_NARROW}` });
			}
		} else {
			made = await makeDumpfireFolder(drive);
		}

		// Read again, and written with nothing awaited between (decision 9).
		const current = getBackupConfig();
		const index = current.destinations.findIndex(d => d.name === destName && d.type === 'gdrive');
		const now = index === -1 ? null : (current.destinations[index] as any);
		if (!now || now.clientId !== clientId || now.clientSecret !== clientSecret || (now.folderId || '') !== folderId) {
			await removeMade();
			return json({ success: false, message: CHANGED_MEANWHILE });
		}
		const connected = { ...now, refreshToken: tokens.refresh_token, folderId: made ? made.id : folderId };
		delete connected.grantedScope;
		if (typeof tokens.scope === 'string' && tokens.scope.trim() !== '') connected.grantedScope = tokens.scope;
		current.destinations[index] = connected;
		saveBackupConfig(current);
		const saved = made;
		made = null;

		return json({
			success: true,
			message: saved
				? `Google Drive connected. DumpFire made the folder "${saved.name}" in this account's My Drive, and backs up there.`
				: 'Google Drive connected successfully!'
		});
	} catch (err: any) {
		// The exchange, a call to Drive, or the write: a folder made and not
		// saved is deleted again, so a failed Connect leaves nothing behind.
		await removeMade();
		log.error(`Google Drive Connect failed for destination "${destName}": ${err.message}`);
		return json({ success: false, message: err.message || 'Failed to exchange auth code' });
	}
};
