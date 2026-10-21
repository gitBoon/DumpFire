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
 * The `POST` takes a code only from the session that started the Connect
 * (card 2251): the `GET` puts a random `state` and a PKCE `code_challenge` in
 * the consent address, and the `POST` must send that state back, from the
 * same session and account and for the same destination, within ten minutes
 * and once; the code goes to Google with the verifier. See
 * `$lib/server/gdrive-connect`.
 *
 * Every administrator's: see `/api/admin/backup`. A Connect is bound to the
 * account and session that began it, so one administrator cannot finish
 * another's.
 */

import { error, isHttpError, json } from '@sveltejs/kit';
import { google, type Auth, type drive_v3 } from 'googleapis';
import { DRIVE_FILE_SCOPE, driveScopeIsNarrow } from '$lib/drive-scope';
import { getBackupConfig, saveBackupConfig } from '$lib/server/backup';
import { makeDumpfireFolder, reachFolder } from '$lib/server/backup-destinations';
import { quotedName } from '$lib/server/backup-secrets';
import { afterCommit } from '$lib/server/db/transaction';
import { startConnect, takeConnect } from '$lib/server/gdrive-connect';
import { requireAdmin } from '$lib/server/route-guards';
import { readBody, readText } from '$lib/server/request-body';
import { stillCallerNow, writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';
import { createLogger } from '$lib/server/logger';

const log = createLogger('GDRIVE');
/** A Connect saved is a change to the backup settings, so its line is beside theirs (card 2273, decision 2). */
const backupLog = createLogger('BACKUP');

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

/**
 * Why a code is refused when its state is not one this session started, has
 * expired or has been used (card 2251, decision 7): one sentence for all of
 * them, never saying which.
 */
const NOT_STARTED_HERE =
	'This connection was not started from this session, or has expired or been used. ' +
	"Press Connect again, and paste the whole address Google's page leads to.";

/** What a Connect saved: the line's meta (card 2273, decision 3), with no token, code, state, verifier or folder id. */
interface ConnectSaved {
	destination: string;
	/** The scope granted, as the page reads it: `drive.file` alone, anything else, or none named by Google. */
	scope: 'narrow' | 'wide' | 'none';
	folder: 'made' | 'reached';
	/** Whether the destination held a refresh token already, which this Connect replaced (decision 1). */
	replaced: boolean;
}

/**
 * The line a Connect saved writes (card 2273): the destination's name, quoted
 * as the backup settings' lines quote it, the scope's kind and what was done
 * for the folder.
 */
function connectLine(saved: ConnectSaved): string {
	const connected = saved.replaced ? 'connected again, replacing the connection it had' : 'connected';
	const scope = { narrow: 'scope narrow (drive.file)', wide: 'scope wide', none: 'scope none named (read as wide)' }[saved.scope];
	const folder = saved.folder === 'made' ? 'a folder made' : 'its folder reached';
	return `Google Drive destination ${quotedName(saved.destination)} ${connected}: ${scope}; ${folder}`;
}

/**
 * GET — Generate the Google OAuth consent URL, with a new state and PKCE
 * challenge bound to this session (card 2251). Not to be kept by anything on
 * the way: the state is this session's alone.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	const caller = requireAdmin(locals.user);

	const destName = url.searchParams.get('dest');
	if (!destName) throw error(400, 'Missing dest parameter');

	const config = getBackupConfig();
	const dest = config.destinations.find(d => d.name === destName && d.type === 'gdrive');
	if (!dest || dest.type !== 'gdrive') throw error(404, 'Google Drive destination not found');

	const { clientId, clientSecret } = dest as any;
	if (!clientId || !clientSecret) throw error(400, 'Client ID and Secret required');

	const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
	const { state, codeChallenge } = startConnect({ userId: caller.id, credential: locals.credential }, destName);

	const authUrl = oauth2Client.generateAuthUrl({
		access_type: 'offline',
		prompt: 'consent',
		scope: SCOPES,
		state,
		code_challenge: codeChallenge,
		code_challenge_method: 'S256' as Auth.CodeChallengeMethod
	});

	return json({ authUrl }, { headers: { 'cache-control': 'no-store' } });
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
 *
 * Before all of that, the `state` (card 2251): taken once, here, whatever
 * follows, and refused unless this session, this account and this destination
 * started it within ten minutes. Nothing is exchanged or written then. The
 * code goes to Google with the Connect's PKCE verifier.
 *
 * A Connect saved writes one line under `BACKUP`, filed under the account,
 * once the write is committed (card 2273): the destination, the scope's kind
 * and whether a folder was made or reached, never a secret. An `INFO` for a
 * destination's first connection, a `WARN` for one that replaces a connection
 * it had, since that can send every later backup to another Google account,
 * which the server cannot see. A Connect refused, or not saved, writes none.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireAdmin(locals.user);

	// Each text: `code` that was not was handed to Google as it was sent.
	const body = await readBody(request);
	// Asked again once the body is in, with nothing awaited before the code
	// goes to Google (card 2253): a session that has ended, or an account that
	// is no longer an administrator, takes no state and sends no code. The
	// write after Google's answers asks again.
	const caller = requireAdmin(stillCallerNow(locals));
	const MISSING = 'Missing code or destName';
	const code = readText(body, 'code', { required: true, min: 1, says: { missing: MISSING, empty: MISSING } });
	const destName = readText(body, 'destName', { required: true, min: 1, says: { missing: MISSING, empty: MISSING } });
	const state = readText(body, 'state', {});

	const started = state ? takeConnect(state, { userId: caller.id, credential: locals.credential }, destName) : null;
	if (!started) {
		// Filed under the account, and telling a paste with no state (an old page,
		// or a bare code) from one whose state failed; the answer says neither.
		// The name quoted as every line of the Connect quotes it (the card 2273 review).
		log.warn(
			`Google Drive Connect refused for destination ${quotedName(destName)}: its state was not one this session started, or had expired or been used`,
			{ stateSent: !!state },
			{ userId: caller.id }
		);
		throw error(400, NOT_STARTED_HERE);
	}

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
	// Every line of the Connect is filed under the account that pressed it, with
	// the name quoted as the backup settings' lines quote it (the card 2273 review).
	const byCaller = { userId: caller.id };
	const removeMade = async () => {
		if (!made || !drive) return;
		try {
			await drive.files.delete({ fileId: made.id, supportsAllDrives: true });
		} catch (err: any) {
			log.warn(
				`Could not delete the folder ${made.id} made for destination ${quotedName(destName)} by a Connect that was not saved: ${err?.message ?? err}`,
				undefined,
				byCaller
			);
		}
	};

	try {
		const { tokens } = await oauth2Client.getToken({ code, codeVerifier: started.verifier });
		if (!tokens.refresh_token) {
			return json({ success: false, message: 'No refresh token received. Try revoking app access at https://myaccount.google.com/permissions and reconnecting.' });
		}
		oauth2Client.setCredentials(tokens);
		drive = google.drive({ version: 'v3', auth: oauth2Client });

		if (folderId) {
			const reached = await reachFolder(drive, folderId);
			if (!reached.reached) {
				log.warn(`Connect of destination ${quotedName(destName)} refused: Google Drive cannot reach its folder ${folderId}: ${reached.reason}`, undefined, byCaller);
				const wide = connectedBefore && !driveScopeIsNarrow(dest.grantedScope);
				const kept = connectedBefore ? 'Nothing was changed: the destination keeps the connection it had.' : 'Nothing was changed.';
				return json({ success: false, message: `${CANNOT_REACH} ${kept} ${wide ? REMEDY_WIDE : REMEDY_NARROW}` });
			}
		} else {
			made = await makeDumpfireFolder(drive);
		}

		// Read again, and written with nothing awaited between (decision 9), in
		// one transaction: the line is queued to follow the commit, since the
		// logger writes a row logged inside a transaction whichever way it ends,
		// and a write that fails would leave a line for a Connect never saved
		// (card 2273, decision 4, as cards 2267 and 2270 have it). It asks first
		// whether the session is still open and whether its account is still an
		// administrator (cards 2253 and 2395): refused, nothing is saved, and the
		// catch below removes the folder made and answers the refusal.
		const refreshToken = tokens.refresh_token;
		const grantedScope = typeof tokens.scope === 'string' && tokens.scope.trim() !== '' ? tokens.scope : null;
		const madeNow = made;
		const written = writeAs(locals, (callerNow) => {
			requireAdmin(callerNow);
			const current = getBackupConfig();
			const index = current.destinations.findIndex(d => d.name === destName && d.type === 'gdrive');
			const now = index === -1 ? null : (current.destinations[index] as any);
			if (!now || now.clientId !== clientId || now.clientSecret !== clientSecret || (now.folderId || '') !== folderId) return false;
			const connected = { ...now, refreshToken, folderId: madeNow ? madeNow.id : folderId };
			delete connected.grantedScope;
			if (grantedScope !== null) connected.grantedScope = grantedScope;
			current.destinations[index] = connected;
			// Replaced: a token in the settings as read again, so a Connect finished meanwhile counts.
			const saved: ConnectSaved = {
				destination: destName,
				scope: grantedScope === null ? 'none' : driveScopeIsNarrow(grantedScope) ? 'narrow' : 'wide',
				folder: madeNow ? 'made' : 'reached',
				replaced: !!now.refreshToken
			};
			afterCommit(() => (saved.replaced ? backupLog.warn : backupLog.info)(connectLine(saved), saved, byCaller));
			saveBackupConfig(current);
			return true;
		});
		if (!written) {
			await removeMade();
			return json({ success: false, message: CHANGED_MEANWHILE });
		}
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
		// The write refused (card 2253): the session ended, or the account is no
		// longer an administrator, while Google answered. That refusal is the
		// answer, as it is anywhere else, and not a failed Connect.
		if (isHttpError(err)) throw err;
		log.error(`Google Drive Connect failed for destination ${quotedName(destName)}: ${err.message}`, undefined, byCaller);
		return json({ success: false, message: err.message || 'Failed to exchange auth code' });
	}
};
