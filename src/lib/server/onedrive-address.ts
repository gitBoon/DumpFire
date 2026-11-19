/**
 * onedrive-address.ts — where a OneDrive destination's copies go, as Microsoft
 * Graph addresses them with app-only sign-in (card 2941).
 *
 * DumpFire signs in to Graph as the app itself (`ClientSecretCredential`),
 * with no user, so `/me` and `/drive` name nothing. Graph's app-only forms are
 * `/users/{id or userPrincipalName}/drive` and `/drives/{drive-id}`: the
 * destination's `drive` says which, as a user's sign-in name or object ID, or
 * a drive ID (`b!…`). The addresses before this card, `/drives/root:/…`, were
 * valid for no sign-in.
 *
 * The same rules are asked at save (`readDestination`) and at use
 * (`OneDriveDestination`), because a restore and the settings JSON reach the
 * stored entry without a save (ruling R3). Every segment of an address is
 * encoded: the Graph client encodes nothing, and reads everything after a `?`
 * as a query (its `GraphRequest.parsePath`).
 *
 * A leaf: it imports nothing, so that backup-destinations.ts and
 * backup-secrets.ts can both ask it.
 */

/** What a run, a Test and Backup History say of a OneDrive destination with no `drive`. */
export const ONEDRIVE_DRIVE_NOT_SET =
	"This OneDrive destination does not say whose OneDrive to use. In Admin, Scheduled Backups, edit it and give the user's " +
	'sign-in name or object ID, or a drive ID, then type its client secret again.';

/** What follows the field's name in a refusal of a `drive` that is none of the three forms. */
export const DRIVE_REFUSAL =
	'must be the sign-in name or object ID of the user whose OneDrive holds the backups, or a drive ID beginning b!';

/** What follows the field's name in a refusal of a folder path. */
export const FOLDER_PATH_REFUSAL =
	'must be folder names separated by /, none of them empty, . or .., and none holding a control character or any of " * : < > ? \\ |';

/** The folder copies go to when none is given: as before card 2941. */
export const DEFAULT_FOLDER = 'DumpFire Backups';

/** A character a sign-in name's either side may not hold: controls, space, and every one with a meaning in a path, a query or an address. */
const NAME_PART = '[^\\x00-\\x20\\x7f/\\\\?#%:@"*<>|]+';
const SIGN_IN_NAME = new RegExp(`^${NAME_PART}@${NAME_PART}$`);
const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRIVE_ID = /^b![A-Za-z0-9_-]{1,200}$/;

/** A character no folder name may hold: controls, and what OneDrive refuses. */
const NOT_IN_A_FOLDER = /[\x00-\x1f\x7f"*:<>?\\|]/;

/** What `drive` names, exactly as stored, or null for none of the three forms. */
export function driveForm(drive: unknown): { kind: 'user' | 'drive'; value: string } | null {
	if (typeof drive !== 'string') return null;
	if (SIGN_IN_NAME.test(drive) || OBJECT_ID.test(drive)) return { kind: 'user', value: drive };
	if (DRIVE_ID.test(drive)) return { kind: 'drive', value: drive };
	return null;
}

/**
 * A `drive` as a save stores it: trimmed of whitespace, an object ID in lower
 * case; '' for none; null for text that is none of the three forms.
 */
export function savedDrive(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed === '') return '';
	const value = OBJECT_ID.test(trimmed) ? trimmed.toLowerCase() : trimmed;
	return driveForm(value) === null ? null : value;
}

/** Whether a stored `drive` is set: a non-empty text, the one rule the place and the seal's additional data use too (ruling R2). */
export const driveSet = (drive: unknown): drive is string => typeof drive === 'string' && drive !== '';

/**
 * The folders of `folderPath`, outermost first: slashes at either end trimmed
 * and '' (or none) the default folder; null where a folder is empty, `.` or
 * `..`, or holds a control character or one of `" * : < > ? \ |` (ruling R3).
 */
export function folderSegments(folderPath: unknown): string[] | null {
	if (folderPath === undefined || folderPath === null) return [DEFAULT_FOLDER];
	if (typeof folderPath !== 'string') return null;
	const trimmed = folderPath.replace(/^\/+/, '').replace(/\/+$/, '');
	if (trimmed === '') return [DEFAULT_FOLDER];
	const segments = trimmed.split('/');
	for (const segment of segments) {
		if (segment === '' || segment === '.' || segment === '..' || NOT_IN_A_FOLDER.test(segment)) return null;
	}
	return segments;
}

/** Why a OneDrive destination cannot be addressed: its words are the run's, the Test's and Backup History's. */
export class OneDriveNotAddressable extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OneDriveNotAddressable';
	}
}

/**
 * Why a stored `drive` cannot be used, or null: none set, or none of the three
 * forms. The one sentence for both, which the run (`driveMissing`), Test and
 * every address (`driveBase`) say (the fix pass's C6).
 */
export function driveProblem(drive: unknown): string | null {
	if (!driveSet(drive)) return ONEDRIVE_DRIVE_NOT_SET;
	return driveForm(drive) === null ? `This OneDrive destination's user or drive ID ${DRIVE_REFUSAL}.` : null;
}

/** The Graph address of the drive `drive` names; throws `OneDriveNotAddressable` for none, or one of no form. */
export function driveBase(drive: unknown): string {
	const problem = driveProblem(drive);
	const form = driveForm(drive);
	if (problem !== null || form === null) throw new OneDriveNotAddressable(problem ?? ONEDRIVE_DRIVE_NOT_SET);
	const value = encodeURIComponent(form.value);
	return form.kind === 'user' ? `/users/${value}/drive` : `/drives/${value}`;
}

/**
 * The Graph address of the item at `folderPath`, and `names` within it, in the
 * drive `drive` names: `{driveBase}/root:/{each segment encoded}`. Throws
 * `OneDriveNotAddressable` where the drive or the folder path is refused.
 */
export function itemPath(drive: unknown, folderPath: unknown, ...names: string[]): string {
	const base = driveBase(drive);
	const folders = folderSegments(folderPath);
	if (folders === null) throw new OneDriveNotAddressable(`This OneDrive destination's folder path ${FOLDER_PATH_REFUSAL}.`);
	return `${base}/root:/${[...folders, ...names].map(encodeURIComponent).join('/')}`;
}

/** The folder path as messages show it: its folders joined by `/`. */
export const shownFolder = (folderPath: unknown): string => (folderSegments(folderPath) ?? []).join('/');

/** How many pages of 200 a OneDrive listing reads before it gives up. */
export const ONEDRIVE_MAX_PAGES = 100;

/**
 * A next page Graph answered (`@odata.nextLink`), as the address to ask, or
 * null where it is not plainly Graph's own (ruling R4): `https:` on
 * `graph.microsoft.com`, no port, no user name or password, a path under
 * `/v1.0/`, and no backslash in the text. The Graph client's own check reads
 * the host as the text before the first `:` or `/`, so a link such as
 * `https://graph.microsoft.com:x@elsewhere/` would be sent its bearer token.
 */
export function nextPageUrl(link: unknown): string | null {
	if (typeof link !== 'string' || link.includes('\\')) return null;
	let url: URL;
	try {
		url = new URL(link);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.hostname !== 'graph.microsoft.com' || url.port !== '') return null;
	if (url.username !== '' || url.password !== '' || !url.pathname.startsWith('/v1.0/')) return null;
	return url.href;
}
