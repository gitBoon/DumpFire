/**
 * setting-holds.ts — the settings held for the superadmin's review (card
 * 2922, migration 0074).
 *
 * When an account's access ends with its API keys (an administrator's
 * password set, an invite used, a two-step reset in the app or on the host,
 * the holder's own change that ends its keys), every place its setter rows
 * record (`setting_setters`, card 2397) is copied into `setting_holds`
 * (`holdSettingsSetBy` in setting-setters.ts; the host's copy in
 * scripts/mfa-reset.mjs). A setting is held while it is at a place a row of
 * `setting_holds` names: the mail settings send no mail (`deliverMail`), the
 * App URL begins no link (`getAppUrl`), and a backup destination is not sent
 * to, pruned at, tested or connected (backup.ts and the backup routes). Each
 * of those asks here at the moment it would reach outside, from the values it
 * has just read, and nothing is kept in memory (the plan's R3, R6).
 *
 * Only the superadmin's Keep deletes a row (`POST /api/admin/settings/held`).
 * A removal of the setting, by the superadmin's Remove or by its setter's
 * demotion, disable or delete, leaves the row as a tombstone, so a setting
 * saved or restored at that place again is held again (R1).
 *
 * A leaf (R20): it imports the database and nothing else of the server, so
 * that email.ts, backup.ts and setting-setters.ts can each ask it. Callers
 * pass the values they read; the place is the digest `setting_setters`
 * records (`placeKey`), computed here by the one rule.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, like } from 'drizzle-orm';
import { db } from './db';
import { settingHolds } from './db/schema';
import { HELD_FROM_UNSEALED_BACKUP, HELD_NOT_RECORDED, HELD_REMOVED_HERE } from '../settings-held';

/** The setter rows' and the holds' name for every smtp_* setting, as one. */
export const MAIL_SETTING = 'mail';
/** The App URL's. */
export const APP_URL_SETTING = 'app_url';
/** Each destination's begins with this, its name after it. */
export const DESTINATION_SETTING = 'backup_destination:';
/** Why a setting is held (`held_because`): the account that set it had its access ended. */
export const SETTER_ACCESS_ENDED = 'setter access ended';
/**
 * The one statement that holds the settings an account set, from its setter rows (card 3004, R8), for `@id`, `@hold`,
 * `@at` and `@name` (the account's username, or NULL where a restore cannot vouch for it): each row of `setting_setters`
 * of the account held at its place, a place already held keeping its hold. Used by an ending of an account's access
 * (`holdSettingsSetBy`) and a restore's password reset (`resetOne`), and copied word for word into
 * scripts/mfa-reset.mjs, which tests compare.
 */
export const HOLD_SETTINGS_SET_BY_SQL =
	'INSERT OR IGNORE INTO setting_holds (setting, place, held_because, held_at, set_by, set_by_name) ' +
	'SELECT setting, place, @hold, @at, user_id, @name FROM setting_setters WHERE user_id = @id ORDER BY rowid';
/**
 * Or: it came in with a backup whose seal did not verify, at a place this server did not hold (card 3009, R4;
 * `holdUnsealedSettings` in restore.ts). Set by nobody. Held, kept and removed as any other; told in its own words
 * (its code review, FP4), never as a setter's ending. The words' module holds the value, so the page reads it too.
 */
export const UNSEALED_RESTORE = HELD_FROM_UNSEALED_BACKUP;

/**
 * A place as a row stores it: a SHA-256 digest of what decides where the
 * setting sends, so that no mail host, user name, bucket or key ID is copied
 * into another table (card 2397). scripts/mfa-reset.mjs copies it for the App
 * URL, and a test holds the two equal.
 */
export function placeKey(parts: readonly unknown[]): string {
	return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Where mail goes, as a mail reads it: the server, the account on it and the way out (card 2189). */
export type MailConnection = { host: string; port: number; user: string; allowInsecure: boolean };

/** The mail settings' place. */
export function mailPlaceOf(connection: MailConnection): string {
	return placeKey([connection.host, connection.port, connection.user, connection.allowInsecure]);
}

/** The App URL's place, from the URL as a link reads it (`appUrlAsRead`), or null for none. */
export function appUrlPlaceOf(url: string): string | null {
	return url === '' ? null : placeKey([url]);
}

// Every read here is a drizzle select, never a prepared statement: tests/check-at-the-write.test.ts reads a
// `prepare` as a write, and the mail, link and backup paths that ask here are reads.

/** Whether any setting is held: one read of one row, so that the usual empty table costs nothing more. */
export function anyHeld(): boolean {
	return db.select({ setting: settingHolds.setting }).from(settingHolds).limit(1).get() !== undefined;
}

/** Whether `setting` at `place` is held; never for no place. */
export function isHeld(setting: string, place: string | null): boolean {
	if (place === null) return false;
	return (
		db
			.select({ setting: settingHolds.setting })
			.from(settingHolds)
			.where(and(eq(settingHolds.setting, setting), eq(settingHolds.place, place)))
			.get() !== undefined
	);
}

/** Whether the mail settings read as `connection` are held: asked by `deliverMail` with the configuration it has just read (R6). */
export function mailHeldAt(connection: MailConnection): boolean {
	return connection.host !== '' && anyHeld() && isHeld(MAIL_SETTING, mailPlaceOf(connection));
}

/** Whether the App URL, read as a link reads it, is held. */
export function appUrlHeldAt(url: string): boolean {
	return url !== '' && anyHeld() && isHeld(APP_URL_SETTING, appUrlPlaceOf(url));
}

/**
 * Whether a destination at `place` (`placeKey(destinationPlace(entry))` of the
 * entry in use, never found by its name: R3) is held: by a hold of any
 * destination's name at that place (the code review's C12), so that a held
 * or removed destination saved again at the same place under another name is
 * held still. A destination's place leaves its name out.
 */
export function destinationHeldAt(place: string): boolean {
	if (!anyHeld()) return false;
	return (
		db
			.select({ setting: settingHolds.setting })
			.from(settingHolds)
			.where(and(eq(settingHolds.place, place), like(settingHolds.setting, `${DESTINATION_SETTING}%`)))
			.get() !== undefined
	);
}

/**
 * Why `setting` at `place` is held (`held_because`), or null where it is not held there: what the words a hold is told
 * in are picked by (card 3009's code review, FP4).
 */
export function heldBecauseAt(setting: string, place: string | null): string | null {
	if (place === null) return null;
	const row = db
		.select({ heldBecause: settingHolds.heldBecause })
		.from(settingHolds)
		.where(and(eq(settingHolds.setting, setting), eq(settingHolds.place, place)))
		.get();
	return row?.heldBecause ?? null;
}

/**
 * Why a destination at `place` is held, by every hold of a destination's name there (as `destinationHeldAt` finds
 * them): an ended setter's, or another this build does not know, where any is; the unsealed restore's only where every
 * one is (FP4). Null where none is held there.
 */
export function destinationHeldBecause(place: string): string | null {
	if (!anyHeld()) return null;
	const reasons = db
		.select({ heldBecause: settingHolds.heldBecause })
		.from(settingHolds)
		.where(and(eq(settingHolds.place, place), like(settingHolds.setting, `${DESTINATION_SETTING}%`)))
		.all()
		.map((row) => row.heldBecause);
	if (reasons.length === 0) return null;
	return reasons.find((reason) => reason !== UNSEALED_RESTORE) ?? UNSEALED_RESTORE;
}

/** One row of `setting_holds`, as the review list and the start's line read it. */
export type HoldRow = {
	setting: string;
	place: string;
	heldBecause: string;
	heldAt: string;
	setBy: number | null;
	setByName: string | null;
};

/** Every row, by setting and then by when it was held. */
export function holdRows(): HoldRow[] {
	return db.select().from(settingHolds).orderBy(asc(settingHolds.setting), asc(settingHolds.heldAt), asc(settingHolds.place)).all();
}

/** A setting's name as the lines and the list say it: the mail settings, the App URL, or a destination by its name. */
export function heldSettingWords(setting: string): string {
	if (setting === MAIL_SETTING) return 'the mail settings';
	if (setting === APP_URL_SETTING) return 'the App URL';
	if (setting.startsWith(DESTINATION_SETTING)) return `backup destination "${setting.slice(DESTINATION_SETTING.length)}"`;
	return setting;
}

/** What a destination held is told, as a backup run's history, a Test and a Connect say it. */
export const DESTINATION_HELD =
	"This backup destination is held for the superadmin's review: the account that set it up had its access ended. " +
	'Nothing is sent to it until the superadmin keeps or removes it under Settings held for review on the admin page.';

/** The same, of a destination held as it came in with a backup whose seal did not verify (card 3009's code review, FP4). */
export const DESTINATION_HELD_UNSEALED =
	"This backup destination is held for the superadmin's review: it came in with a backup whose seal did not verify, so where it " +
	"sends is only the file's word. Nothing is sent to it until the superadmin keeps or removes it under Settings held for review on the admin page.";

/**
 * The same, of a destination a restore held by this server's record of where it sends (card 3004): removed here since
 * the backup was made, or not in the record. Names no setter.
 */
export const DESTINATION_HELD_BY_RECORD =
	"This backup destination is held for the superadmin's review: it came back with a restore, though it was removed on this server " +
	"since the backup was made or is not in this server's record of where it sends. Nothing is sent to it until the superadmin keeps or " +
	'removes it under Settings held for review on the admin page.';

/** What a destination held at `place` is told, by why it is held (FP4); null where it is not held. */
export function destinationHeldWords(place: string): string | null {
	const because = destinationHeldBecause(place);
	if (because === null) return null;
	if (because === HELD_REMOVED_HERE || because === HELD_NOT_RECORDED) return DESTINATION_HELD_BY_RECORD;
	return because === UNSEALED_RESTORE ? DESTINATION_HELD_UNSEALED : DESTINATION_HELD;
}
