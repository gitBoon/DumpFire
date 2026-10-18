/**
 * drive-scope.ts — what a Google Drive connection may reach (card 2188).
 *
 * A Google Drive destination connected with OAuth records, at Connect, the
 * scope Google granted its refresh token (`grantedScope`). DumpFire asks for
 * `drive.file`, which reaches only the files DumpFire makes; a connection made
 * before card 2188 asked for `drive`, the whole of the account's Drive, and
 * keeps it until it is connected again.
 *
 * No server imports, so that the admin page reads a connection the same way.
 */

/** The one scope DumpFire asks Google for: the files it makes, and no others. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * Whether `scope`, as recorded, reaches only the files DumpFire makes: it is
 * text, not empty, and every scope in it (Google separates them with spaces)
 * is exactly `drive.file`. Anything else is the whole of Drive as far as a
 * badge or a refusal is concerned: `…/auth/drive` (of which `drive.file` is
 * only a prefix match), `drive drive.file`, a scope of another kind, and a
 * scope never recorded, which is every connection made before card 2188 (the
 * plan's R6).
 */
export function driveScopeIsNarrow(scope: unknown): boolean {
	if (typeof scope !== 'string') return false;
	const scopes = scope.split(/\s+/).filter((part) => part !== '');
	return scopes.length > 0 && scopes.every((part) => part === DRIVE_FILE_SCOPE);
}

/**
 * The name of the folder Connect makes for a Google Drive destination whose
 * Folder ID is empty (card 2188, decision 8, as the review's R5 named it): the
 * day it is made in it, so that it is not mistaken for a folder made by hand,
 * which was often called "DumpFire Backups". Here rather than beside Connect so
 * that the admin page names the folder Connect will make.
 */
export function dumpfireFolderName(now: Date = new Date()): string {
	return `DumpFire backups (made ${now.toISOString().slice(0, 10)})`;
}
