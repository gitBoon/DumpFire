/**
 * setting-setters.ts — who set where the settings that send mail or backups
 * somewhere send, and what goes when that account stops being an
 * administrator (card 2397, migration 0059).
 *
 * Since card 2395 every administrator can point the mail server, the App URL
 * and a backup destination at a server of their own: whoever holds the mail
 * server reads every invite and password reset, and a destination receives the
 * whole database. Nothing recorded who saved them, so a demoted or deleted
 * administrator's server went on receiving both. Now `setting_setters` names,
 * for each, the account that put it at each place it has been:
 *
 *     mail                       every smtp_* row of `settings`, as one: the
 *                                password goes with the host it was saved for
 *     app_url                    the App URL, which decides where every link
 *                                in a mail points (card 2396 logs it with mail)
 *     backup_destination:<name>  each destination of `backup_config`, by name,
 *                                as everything else finds a destination
 *
 * Each row holds the place: a digest of where the setting sends (the
 * mail host, port, user and way out; the App URL as a link reads it; a
 * destination's type and the fields that say which account and place,
 * card 2270's `elsewhere`). The setter of a setting is the account recorded
 * for the place it is at now. A save that moves a setting to a place nobody
 * is recorded for makes the saver its setter there, as card 2168 has the last
 * to change a webhook; one that moves it back to a recorded place makes it
 * that account's again (the second code review: an administrator who changed
 * a passwordless relay's port and changed it back, or an S3 prefix, or the
 * App URL, had taken over somebody else's settings, and on their demotion
 * took them away). Only a move makes a setter (the first review): a sender's
 * name or address, a password or secret typed again for the same place, an
 * App URL cleared and an SFTP host key confirmed change nobody's. A Google
 * Drive Connect makes the connecting account the setter at its place, as it
 * binds the destination to their Google account. Schedule, Keep Last and the
 * failure mail send nothing anywhere and are nobody's.
 *
 * Demoting an administrator to user (PUT /api/users/:id) or deleting an
 * account (`deleteUser`) calls `removeSettingsSetBy` in its own transaction:
 * the settings that account set go with the change or not at all, and one
 * WARN line under SMTP and one under BACKUP say what went once it is
 * committed. A setting whose place has no row (saved before 0059) stays in
 * force, unattributed: the first save that moves it records the place it
 * leaves as nobody's (`user_id` NULL), so moved back there it is nobody's
 * again (the third code review).
 *
 * The third review also ruled that a move by the superadmin, or one made with
 * a password or secret typed, takes the place it moves to over whoever was
 * recorded there, so an administrator who visits a place first cannot keep
 * it; and that each account keeps one row per setting, its latest place.
 *
 * A role written to `user` from the host runs none of this, so every start
 * also removes what a setter who is no longer an administrator set
 * (`removeSettingsOfFormerAdministrators`, card 2406), and so for a row whose
 * account is gone, which a delete made with foreign keys off leaves. An
 * account deleted from the host with foreign keys on (better-sqlite3's
 * default) takes its rows with it by the cascade: its settings are then
 * unattributed, as one saved before 0059 is, and nothing can tell them apart.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { db, sqlite } from './db';
import { settingSetters } from './db/schema';
import { afterCommit, inTransaction } from './db/transaction';
import { destinationPlace, quotedName as quoted, typedSecret, type BackupSettingsChanges } from './backup-secrets';
import { appUrlAsRead, mailSettingsAsRead } from './email';
import { createLogger } from './logger';

const smtpLog = createLogger('SMTP');
const backupLog = createLogger('BACKUP');

/** The mail settings' row: every smtp_* setting, as one. */
const MAIL = 'mail';
/** The App URL's row. */
const APP_URL = 'app_url';
/** Each destination's row begins with this, its name after it. */
const DESTINATION = 'backup_destination:';

/**
 * A place as a row stores it: a SHA-256 digest of what decides where the
 * setting sends, so that no mail host, user name (some mail providers take it
 * as a token), bucket or key ID is copied into another table.
 */
function placeKey(parts: readonly unknown[]): string {
	return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Where mail goes, as a mail reads it: the server, the account on it and the way out (card 2189). */
function mailPlace(): string {
	const { host, port, user, allowInsecure } = mailSettingsAsRead();
	return placeKey([host, port, user, allowInsecure]);
}

/** The App URL row's place, as a link reads it, or null where the row holds no address (`APP_URL` is nobody's). */
function appUrlPlace(): string | null {
	const row = sqlite.prepare("SELECT value FROM settings WHERE key = 'app_url'").get() as { value: string } | undefined;
	const url = row === undefined ? '' : appUrlAsRead(row.value);
	return url === '' ? null : placeKey([url]);
}

/** Whether a row records `setting` at `place`, an account's or nobody's. */
function recorded(setting: string, place: string): boolean {
	return (
		db
			.select({ place: settingSetters.place })
			.from(settingSetters)
			.where(and(eq(settingSetters.setting, setting), eq(settingSetters.place, place)))
			.get() !== undefined
	);
}

/**
 * Make `userId` the setter of `setting` at `place`, whoever was recorded
 * there, and drop that account's rows for the setting's other places: one row
 * per account per setting, so that the table grows with the accounts and not
 * with every save (the third code review).
 */
function claim(setting: string, place: string, userId: number): void {
	db.delete(settingSetters)
		.where(and(eq(settingSetters.setting, setting), eq(settingSetters.userId, userId), ne(settingSetters.place, place)))
		.run();
	db.insert(settingSetters)
		.values({ setting, place, userId })
		.onConflictDoUpdate({ target: [settingSetters.setting, settingSetters.place], set: { userId } })
		.run();
}

/**
 * After a save moved `setting` from the place `was` (null for none) to
 * `now`: the saver is recorded as having put it there, unless it did not
 * move, or somebody, or nobody, is recorded for that place already, whose it
 * then is again, so a setting changed and changed back is its first setter's
 * (the second code review). `overrides`, a move by the superadmin or one made
 * with a password or secret typed, is the saver's whoever was recorded there:
 * an administrator who visited a place first does not keep it from the
 * superadmin, nor from whoever brings the secret it is used with (the third
 * review). The place a setting with no row leaves, one saved before 0059, is
 * recorded first as nobody's, so moved back there it is nobody's again.
 */
function recordMove(setting: string, was: string | null, now: string, userId: number, overrides: boolean): void {
	if (now === was) return;
	if (was !== null && !recorded(setting, was)) db.insert(settingSetters).values({ setting, place: was, userId: null }).run();
	if (!overrides && recorded(setting, now)) return;
	claim(setting, now, userId);
}

/** Who saved, for the setter rows: their account, and whether they are the superadmin, whose move takes any place over. */
export type Mover = { id: number; superadmin: boolean };

/** Where the mail and the App URL send, read before a save of them so that `recordMailSetters` can tell whether it moved them; null for none stored. */
export type MailPlaces = { mail: string | null; appUrl: string | null };

/** The mail settings' and the App URL's places now. */
export function mailPlacesNow(): MailPlaces {
	return { mail: mailStored() ? mailPlace() : null, appUrl: appUrlPlace() };
}

/**
 * After a save of the mail settings or the App URL (PUT /api/admin/smtp),
 * `before` as `mailPlacesNow` read it at the start of the save. A save that
 * moves the host, port, user or way out to a place nobody is recorded for
 * makes the saver the setter of every mail setting; the App URL has its own,
 * made only by setting it to an address (clearing it sends no link anywhere
 * new), so that saving it alone does not take the mail over. A sender's name
 * or address, or a password typed again alone, moves nothing. `passTyped`,
 * a password typed with the save: the mail's move is then the saver's
 * whoever was recorded where it goes, as is any move of the superadmin's.
 */
export function recordMailSetters(before: MailPlaces, mover: Mover, passTyped: boolean): void {
	const now = mailPlacesNow();
	if (now.mail !== null) recordMove(MAIL, before.mail, now.mail, mover.id, mover.superadmin || passTyped);
	if (now.appUrl !== null) recordMove(APP_URL, before.appUrl, now.appUrl, mover.id, mover.superadmin);
}

/** The place of the first destination of `list` named `name`, of `type` where one is given, or null for none. */
function destinationPlaceIn(list: readonly unknown[], name: string, type?: string): string | null {
	const found = list.find((d) => {
		const entry = destinationOf(d);
		return entry !== null && entry.name === name && (type === undefined || entry.type === type);
	});
	return found === undefined ? null : placeKey(destinationPlace(found));
}

/**
 * After a save of the backup settings (PUT /api/admin/backup): `changes` are
 * card 2270's, between `before` and `after`, the destinations as stored and
 * as saved. Each removed loses every row first (it sends nowhere now), so a
 * destination renamed, or saved as another type under its name, is the
 * saver's under the name it now has. Each added, and each changed so that
 * its copies go to a place nobody is recorded for, is the saver's; one moved
 * back to a recorded place is that account's again, unless it is moved by
 * the superadmin or with a secret typed into it as `sent` (the third review);
 * a secret typed again for the same place, or an SFTP host key confirmed,
 * moves nothing.
 */
export function recordDestinationSetters(
	before: readonly unknown[],
	after: readonly unknown[],
	sent: readonly unknown[],
	changes: BackupSettingsChanges | null,
	mover: Mover
): void {
	if (changes === null) return;
	const overrides = (name: string) => mover.superadmin || typedSecret(sent.find((d) => destinationOf(d)?.name === name));
	for (const { name } of changes.removed) db.delete(settingSetters).where(eq(settingSetters.setting, DESTINATION + name)).run();
	for (const { name } of changes.added) {
		const now = destinationPlaceIn(after, name);
		if (now !== null) recordMove(DESTINATION + name, null, now, mover.id, overrides(name));
	}
	for (const { name } of changes.changed) {
		const now = destinationPlaceIn(after, name);
		const type = destinationOf(after.find((d) => destinationOf(d)?.name === name))?.type;
		if (now !== null) recordMove(DESTINATION + name, destinationPlaceIn(before, name, type), now, mover.id, overrides(name));
	}
}

/**
 * After a Google Drive Connect is saved: the destination, as saved, is the
 * connecting account's at its place, whoever was recorded there, as it is
 * bound to their Google account now.
 */
export function recordDestinationSetter(destination: unknown, userId: number): void {
	const entry = destinationOf(destination);
	if (entry === null) return;
	claim(DESTINATION + entry.name, placeKey(destinationPlace(destination)), userId);
}

/** What `removeSettingsSetBy` removed: the mail settings, the App URL, and the destinations by name. */
export type SettingsRemoved = { mail: boolean; appUrl: boolean; destinations: string[] };

/** Whether anything was removed: an answer names it only then. */
export function anyRemoved(removed: SettingsRemoved): boolean {
	return removed.mail || removed.appUrl || removed.destinations.length > 0;
}

/** Who an account is, for the lines. */
type Named = { id: number; username: string };

/** Whether any mail setting is stored: what removing the `mail` setter's rows removes. */
function mailStored(): boolean {
	return sqlite.prepare("SELECT 1 FROM settings WHERE key LIKE 'smtp\\_%' ESCAPE '\\' LIMIT 1").get() !== undefined;
}

/**
 * The stored `backup_config`, where it is a JSON object with a list of
 * destinations, or null: a value that is not has nothing to find in it, and
 * is left alone.
 */
function storedBackupConfig(): (Record<string, unknown> & { destinations: unknown[] }) | null {
	const stored = sqlite.prepare("SELECT value FROM settings WHERE key = 'backup_config'").get() as { value: string } | undefined;
	let config: unknown = null;
	try {
		config = stored ? JSON.parse(stored.value) : null;
	} catch {
		// Not JSON: nothing to find in it.
	}
	if (config === null || typeof config !== 'object' || Array.isArray(config)) return null;
	const was = config as Record<string, unknown>;
	return Array.isArray(was.destinations) ? (was as Record<string, unknown> & { destinations: unknown[] }) : null;
}

/** A stored destination's name and type, or null for an entry with no name, which no setter row can name. */
function destinationOf(d: unknown): { name: string; type: string } | null {
	const entry = d !== null && typeof d === 'object' ? (d as Record<string, unknown>) : null;
	return entry && typeof entry.name === 'string' ? { name: entry.name, type: String(entry.type ?? '') } : null;
}

/** Where each setting is now, in the places setter rows record: what decides whose it is. */
type PlacesNow = {
	/** The mail settings' place, or null where no mail setting is stored. */
	mail: string | null;
	/** The App URL row's, or null where it holds no address. */
	appUrl: string | null;
	/** The stored `backup_config`, as `storedBackupConfig` reads it. */
	config: ReturnType<typeof storedBackupConfig>;
	/** Each stored destination that has a name, with its place. */
	destinations: { entry: unknown; name: string; type: string; place: string }[];
};

function placesNow(): PlacesNow {
	const config = storedBackupConfig();
	const destinations: PlacesNow['destinations'] = [];
	for (const entry of config?.destinations ?? []) {
		const named = destinationOf(entry);
		if (named !== null) destinations.push({ entry, ...named, place: placeKey(destinationPlace(entry)) });
	}
	return { mail: mailStored() ? mailPlace() : null, appUrl: appUrlPlace(), config, destinations };
}

/** What one account's setter rows hold now: each setting at a place they record (the second code review). */
function heldIn(rows: readonly { setting: string; place: string }[], now: PlacesNow) {
	const at = (setting: string, place: string | null) => place !== null && rows.some((row) => row.setting === setting && row.place === place);
	return {
		mail: at(MAIL, now.mail),
		appUrl: at(APP_URL, now.appUrl),
		destinations: now.destinations.filter((d) => at(DESTINATION + d.name, d.place))
	};
}

/**
 * What `removeSettingsSetBy` would remove for each account that holds
 * anything still in force, by account id, read as the removal reads it (the
 * review of 2026-10-22), or for `userId` alone where one is given: the admin
 * page's users panel reads it for the account just before it asks to make
 * it a user or delete it (the second review). An account that holds nothing
 * is not in it.
 */
export function settingsHeldBy(userId?: number): Map<number, SettingsRemoved> {
	// A row naming nobody is held by nobody (the third review).
	const rows = db
		.select()
		.from(settingSetters)
		.where(userId === undefined ? isNotNull(settingSetters.userId) : eq(settingSetters.userId, userId))
		.all();
	const held = new Map<number, SettingsRemoved>();
	if (rows.length === 0) return held;
	const now = placesNow();
	const byUser = new Map<number, typeof rows>();
	for (const row of rows) if (row.userId !== null) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
	for (const [id, theirs] of byUser) {
		const holds = heldIn(theirs, now);
		const entry: SettingsRemoved = { mail: holds.mail, appUrl: holds.appUrl, destinations: [...new Set(holds.destinations.map((d) => d.name))] };
		if (anyRemoved(entry)) held.set(id, entry);
	}
	return held;
}

/**
 * Remove what `setter` set (card 2397), inside the caller's transaction:
 * the account was made a user (`demoted`) or is about to be deleted
 * (`deleted`), by `actor`; or, found at start-up with no `actor` (card 2406),
 * it is no longer an administrator (`not-an-administrator`) or no longer
 * exists (`gone`).
 *
 * Each setting is the account's only where it is still at a place the
 * account's rows record (the second code review): one moved since to a place
 * somebody else is recorded for, or nobody is, or an App URL cleared since,
 * is not theirs and stays.
 *
 *   - its mail settings: every smtp_* row, so no mail is sent until an
 *     administrator sets the mail up again;
 *   - its App URL: the row, so links use APP_URL, or ORIGIN;
 *   - each destination that is theirs, out of `backup_config` with the
 *     secrets stored in it (a backup_config that is not a JSON object with a
 *     list of destinations is left alone, as there is nothing to find in it);
 *   - every row of each setting removed, whoever's (it sends nowhere now),
 *     and every setter row of the account.
 *
 * Once committed, one WARN under SMTP for the mail and the App URL and one
 * under BACKUP for the destinations, naming what went, whose it was and why,
 * filed under `actor` (under nobody at start-up). Allowed whoever `actor` is:
 * card 2398's rule, that only the superadmin removes a destination, is about
 * a save of the settings, and this follows the account's own change.
 */
export function removeSettingsSetBy(
	setter: Named,
	why: 'demoted' | 'deleted' | 'not-an-administrator' | 'gone',
	actor: Named | null
): SettingsRemoved {
	const rows = db.select().from(settingSetters).where(eq(settingSetters.userId, setter.id)).all();
	const removed: SettingsRemoved = { mail: false, appUrl: false, destinations: [] };
	if (rows.length === 0) return removed;
	const now = placesNow();
	const holds = heldIn(rows, now);
	/** A setting removed is nobody's anywhere: every row of it goes. */
	const forget = (setting: string) => db.delete(settingSetters).where(eq(settingSetters.setting, setting)).run();

	if (holds.mail) {
		removed.mail = sqlite.prepare("DELETE FROM settings WHERE key LIKE 'smtp\\_%' ESCAPE '\\'").run().changes > 0;
		forget(MAIL);
	}
	if (holds.appUrl) {
		sqlite.prepare("DELETE FROM settings WHERE key = 'app_url'").run();
		removed.appUrl = true;
		forget(APP_URL);
	}

	const gone = holds.destinations.map(({ name, type }) => ({ name, type }));
	if (gone.length > 0 && now.config !== null) {
		const going = new Set(holds.destinations.map((d) => d.entry));
		const kept = now.config.destinations.filter((d) => !going.has(d));
		sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(JSON.stringify({ ...now.config, destinations: kept }));
	}
	removed.destinations = [...new Set(gone.map((d) => d.name))];
	for (const name of removed.destinations) forget(DESTINATION + name);

	db.delete(settingSetters).where(eq(settingSetters.userId, setter.id)).run();

	const by = actor === null ? 'someone' : quoted(actor.username);
	const because = {
		demoted: `who was made a user by ${by}`,
		deleted: `whose account was deleted by ${by}`,
		'not-an-administrator': 'who is no longer an administrator (found at start-up: the role was changed outside the admin page)',
		gone: 'whose account no longer exists (found at start-up: it was deleted outside the admin page)'
	}[why];
	const whose = `saved by ${why === 'gone' ? `account ${setter.id}` : quoted(setter.username)}, ${because}`;
	const filedUnder = { userId: actor?.id ?? null };
	if (removed.mail || removed.appUrl) {
		const what = [removed.mail ? 'mail settings' : null, removed.appUrl ? 'App URL' : null].filter((part) => part !== null).join(' and the ');
		const after = [
			removed.mail ? ' No mail is sent until an administrator sets the mail up again.' : '',
			removed.appUrl ? " Links in mail use APP_URL, or the server's own address, until an App URL is saved again." : ''
		].join('');
		const meta = { setter: setter.id, reason: why, mail: removed.mail, appUrl: removed.appUrl };
		afterCommit(() => smtpLog.warn(`The ${what} removed: ${whose}.${after}`, meta, filedUnder));
	}
	if (gone.length > 0) {
		const list = gone.map((d) => `${quoted(d.name)} (${d.type})`).join(', ');
		const meta = { setter: setter.id, reason: why, destinations: gone };
		afterCommit(() =>
			backupLog.warn(
				`Backup destination${gone.length === 1 ? '' : 's'} ${list} removed: ${whose}. ` +
					`${gone.length === 1 ? 'Its' : 'Their'} stored secrets went with ${gone.length === 1 ? 'it' : 'them'}; the copies already there are kept.`,
				meta,
				filedUnder
			)
		);
	}
	return removed;
}

/**
 * Remove, at start-up, what each setter who is no longer an administrator set
 * (card 2406), by `removeSettingsSetBy`'s rule, in one transaction: a role
 * written to `user` from the host (docs/deployment.md, "If Nobody Can Sign In
 * as the Superadmin") runs no application code, so that person's mail
 * settings, App URL and destinations stayed in force. A row whose account is
 * gone, which only a delete made with foreign keys off leaves, is treated the
 * same. Each removal is one WARN line under SMTP or BACKUP, filed under
 * nobody. Returns, for each such setter, what was removed (nothing, where the
 * settings had moved since and only their rows went).
 *
 * What cannot be found: an account deleted from the host with foreign keys on
 * takes its rows with it (`ON DELETE CASCADE`), so its settings are left in
 * force, unattributed, as one saved before migration 0059 is.
 */
export function removeSettingsOfFormerAdministrators(): { setter: number; removed: SettingsRemoved }[] {
	return inTransaction(() => {
		// An administrator is `admin` or `superadmin`, as `isAdmin` (board-access.ts) has it.
		const found = sqlite
			.prepare(
				`SELECT DISTINCT s.user_id AS id, u.username AS username
				 FROM setting_setters s LEFT JOIN users u ON u.id = s.user_id
				 WHERE s.user_id IS NOT NULL AND (u.id IS NULL OR u.role NOT IN ('admin', 'superadmin'))
				 ORDER BY s.user_id`
			)
			.all() as { id: number; username: string | null }[];
		return found.map(({ id, username }) => ({
			setter: id,
			removed:
				username === null
					? removeSettingsSetBy({ id, username: '' }, 'gone', null)
					: removeSettingsSetBy({ id, username }, 'not-an-administrator', null)
		}));
	});
}
