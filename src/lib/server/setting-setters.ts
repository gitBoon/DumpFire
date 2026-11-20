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
 * Import Backup does the same once a restore is committed (card 2411), so
 * that a backup's setter who is not an administrator in it loses their
 * settings then, and not at the next start.
 */
import { and, eq, isNotNull, like, ne } from 'drizzle-orm';
import { db, sqlite } from './db';
import { settingHolds, settingSetters } from './db/schema';
import { afterCommit, inTransaction } from './db/transaction';
import { destinationPlace, maskDestination, quotedName as quoted, typedSecret, type BackupSettingsChanges } from './backup-secrets';
import { appUrlAsRead, mailConnectionAsRead, recordMailEverConfigured } from './email';
import { revokeEveryLink } from './decision-links';
import type { RecordActor } from './decision-record';
import { writingWithKey } from './write-as';
import { createLogger } from './logger';
// The digest and the settings' names are the holds' too (card 2922): one rule, in the leaf, setting-holds.ts.
import { APP_URL_SETTING as APP_URL, DESTINATION_SETTING as DESTINATION, MAIL_SETTING as MAIL, SETTER_ACCESS_ENDED, mailPlaceOf, placeKey } from './setting-holds';
import { stamp } from '$lib/timestamps';

const smtpLog = createLogger('SMTP');
const backupLog = createLogger('BACKUP');

/** Where mail goes, as a mail reads it: the server, the account on it and the way out (card 2189). */
function mailPlace(): string {
	// The password is not opened for it (card 2898's code review, E10).
	return mailPlaceOf(mailConnectionAsRead());
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

// ─── The backup failure address (card 2671) ──────────────────────────────────
//
// One rule for reading it (the code review's CR9), asked by the admin page,
// which says whether an account's address is there, and by the removal below,
// which a disable and the start's sweep run.

/** The addresses of a failure address text, as the backup route reads them: separated by commas, semicolons or lines. */
function addressesIn(text: string): string[] {
	return text
		.split(/[,;\r\n]/)
		.map((each) => each.trim())
		.filter((each) => each !== '');
}

/** An address with its ASCII capitals lower-cased, as the backup route compares them (not a full lower-casing: look-alikes). */
const folded = (address: string) => address.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * `backup_config` as stored, read as the failure address is: the object and
 * the addresses of its `notifyEmail`, or null for a value that is missing or
 * not a JSON object, which is left alone.
 */
function failureConfigOf(stored: unknown): { config: Record<string, unknown>; addresses: string[] } | null {
	if (typeof stored !== 'string') return null;
	let config: unknown;
	try {
		config = JSON.parse(stored);
	} catch {
		return null;
	}
	if (config === null || typeof config !== 'object' || Array.isArray(config)) return null;
	const was = config as Record<string, unknown>;
	return { config: was, addresses: typeof was.notifyEmail === 'string' ? addressesIn(was.notifyEmail) : [] };
}

/** Whether `address` is one of the backup failure addresses in `stored`, `backup_config`'s value as stored. */
export function isFailureAddress(stored: unknown, address: string): boolean {
	const read = failureConfigOf(stored);
	return read !== null && read.addresses.some((each) => folded(each) === folded(address));
}

/**
 * Take `address` out of the backup failure address (`backup_config`'s
 * `notifyEmail`), where it is one of the addresses there (card 2671, S7): the
 * mail is sent outside the account, to whoever holds that address. True when
 * it was there. A `backup_config` that is not a JSON object is left alone.
 * Writes in the caller's transaction.
 */
export function removeFailureAddress(address: string): boolean {
	const stored = sqlite.prepare("SELECT value FROM settings WHERE key = 'backup_config'").get() as { value: unknown } | undefined;
	const read = failureConfigOf(stored?.value);
	if (read === null) return false;
	const kept = read.addresses.filter((each) => folded(each) !== folded(address));
	if (kept.length === read.addresses.length) return false;
	sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(JSON.stringify({ ...read.config, notifyEmail: kept.join(', ') }));
	return true;
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

/**
 * What one account's setter rows set that is in force now: each setting at a place they record (the second code
 * review). Named `heldIn` before card 2922, whose "hold" is the review hold alone (its R16).
 */
function setIn(rows: readonly { setting: string; place: string }[], now: PlacesNow) {
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
 * is not in it. Named `settingsHeldBy` before card 2922 (its R16).
 */
export function settingsSetBy(userId?: number): Map<number, SettingsRemoved> {
	// A row naming nobody is set by nobody (the third review).
	const rows = db
		.select()
		.from(settingSetters)
		.where(userId === undefined ? isNotNull(settingSetters.userId) : eq(settingSetters.userId, userId))
		.all();
	const set = new Map<number, SettingsRemoved>();
	if (rows.length === 0) return set;
	const now = placesNow();
	const byUser = new Map<number, typeof rows>();
	for (const row of rows) if (row.userId !== null) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
	for (const [id, theirs] of byUser) {
		const setRows = setIn(theirs, now);
		const entry: SettingsRemoved = { mail: setRows.mail, appUrl: setRows.appUrl, destinations: [...new Set(setRows.destinations.map((d) => d.name))] };
		if (anyRemoved(entry)) set.set(id, entry);
	}
	return set;
}

/**
 * Remove what `setter` set (card 2397), inside the caller's transaction:
 * the account was made a user (`demoted`), is about to be deleted
 * (`deleted`) or is being disabled (`disabled`, card 2671), by `actor`; or,
 * found at start-up with no `actor` (card 2406), it is no longer an
 * administrator (`not-an-administrator`), no longer exists (`gone`) or is
 * disabled (`disabled`). `found` says where those were found: at start-up,
 * or after a restore (card 2411), which the line then says.
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
	why: 'demoted' | 'deleted' | 'disabled' | 'not-an-administrator' | 'gone',
	actor: Named | null,
	found: 'start-up' | 'restore' | 'record' = 'start-up'
): SettingsRemoved {
	const rows = db.select().from(settingSetters).where(eq(settingSetters.userId, setter.id)).all();
	const removed: SettingsRemoved = { mail: false, appUrl: false, destinations: [] };
	if (rows.length === 0) return removed;
	const now = placesNow();
	const setRows = setIn(rows, now);
	/**
	 * A setting removed is nobody's anywhere: every setter row of it goes. A hold of it stays (card 2922, R1): a
	 * tombstone, so that the setting saved or restored at that place again is held again.
	 */
	const forget = (setting: string) => db.delete(settingSetters).where(eq(settingSetters.setting, setting)).run();

	if (setRows.mail) {
		// Mail set up on this server is recorded before its rows go (card 2922's code review, C4): the removal never
		// opens the password-alone set-up leave, though the start has not yet recorded it.
		recordMailEverConfigured();
		removed.mail = sqlite.prepare("DELETE FROM settings WHERE key LIKE 'smtp\\_%' ESCAPE '\\'").run().changes > 0;
		forget(MAIL);
	}
	if (setRows.appUrl) {
		sqlite.prepare("DELETE FROM settings WHERE key = 'app_url'").run();
		removed.appUrl = true;
		forget(APP_URL);
	}

	const gone = setRows.destinations.map(({ name, type }) => ({ name, type }));
	if (gone.length > 0 && now.config !== null) {
		const going = new Set(setRows.destinations.map((d) => d.entry));
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
		// Card 2671: by `actor` at the disable, or found at start-up or after a restore with none.
		disabled:
			actor !== null
				? `whose account was disabled by ${by}`
				: `whose account is disabled (found ${found === 'restore' ? 'after a restore' : 'at start-up'})`,
		'not-an-administrator':
			found === 'restore'
				? 'who is not an administrator in the restored data (found after a restore)'
				: 'who is no longer an administrator (found at start-up: the role was changed outside the admin page)',
		gone:
			found === 'restore'
				? 'whose account is not in the restored data (found after a restore)'
				: 'whose account no longer exists (found at start-up: it was deleted outside the admin page)'
	}[why];
	// Card 2996 (FP16): the record of account endings' pass names no account, in the words or the details.
	const unnamed = found === 'record';
	const whose = unnamed
		? 'saved by an account that the record of account endings on this server ends or lowers (found by its pass)'
		: `saved by ${why === 'gone' ? `account ${setter.id}` : quoted(setter.username)}, ${because}`;
	const setterMeta = unnamed ? {} : { setter: setter.id };
	const filedUnder = { userId: actor?.id ?? null };
	if (removed.mail || removed.appUrl) {
		const what = [removed.mail ? 'mail settings' : null, removed.appUrl ? 'App URL' : null].filter((part) => part !== null).join(' and the ');
		const after = [
			removed.mail ? ' No mail is sent until an administrator sets the mail up again.' : '',
			removed.appUrl ? " Links in mail use APP_URL, or the server's own address, until an App URL is saved again." : ''
		].join('');
		const meta = { ...setterMeta, reason: why, mail: removed.mail, appUrl: removed.appUrl };
		afterCommit(() => smtpLog.warn(`The ${what} removed: ${whose}.${after}`, meta, filedUnder));
	}
	if (gone.length > 0) {
		const list = gone.map((d) => `${quoted(d.name)} (${d.type})`).join(', ');
		const meta = { ...setterMeta, reason: why, destinations: gone };
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

/** What `holdSettingsSetBy` held: the settings named by the rows it copied, and those of them in force, for an answer. */
export type SettingsHeld = {
	/** Each setting a row of the account names, by its row's name (`mail`, `app_url`, `backup_destination:<name>`), once each. */
	rows: string[];
	/** Of them, those at a place the account's rows record now, as `settingsSetBy` reads them: what an answer and a screen say. */
	inForce: SettingsRemoved;
};

/**
 * Hold for the superadmin's review what `setter` set (card 2922), inside the
 * caller's transaction: the account's access is ending with its API keys
 * (`endAccountAccess`), `cause` saying how, as the webhooks' lines say it.
 * Every setter row of the account is copied into `setting_holds`, as it is,
 * whatever the setting is at now (`INSERT OR IGNORE`: a place held already
 * keeps its hold): a setting is then held while it is at one of those
 * places (setting-holds.ts). Nothing is removed, and no setter row changes:
 * the sealed mail password and destination secrets stay, for Keep.
 *
 * Once committed, one WARN under SMTP for the mail settings and the App URL
 * and one under BACKUP for the destinations, written from the rows copied
 * (its plan's R13, as scripts/mfa-reset.mjs writes them from its own copy),
 * naming the settings, whose they were and why; none where the account has
 * no row. `inForce` is what an answer says (`setIn`). Where `cause.unnamed`
 * (the record of account endings' passes, card 2996's FP16 and card 2997's
 * code review, FP1), the lines name no account, in the words or the details.
 */
export function holdSettingsSetBy(setter: Named, cause: { log: string; unnamed?: boolean }): SettingsHeld {
	const rows = db.select().from(settingSetters).where(eq(settingSetters.userId, setter.id)).all();
	const held: SettingsHeld = { rows: [], inForce: { mail: false, appUrl: false, destinations: [] } };
	if (rows.length === 0) return held;
	const now = placesNow();
	const set = setIn(rows, now);
	held.inForce = { mail: set.mail, appUrl: set.appUrl, destinations: [...new Set(set.destinations.map((d) => d.name))] };
	const at = stamp();
	const copy = sqlite.prepare(
		'INSERT OR IGNORE INTO setting_holds (setting, place, held_because, held_at, set_by, set_by_name) VALUES (?, ?, ?, ?, ?, ?)'
	);
	for (const row of rows) copy.run(row.setting, row.place, SETTER_ACCESS_ENDED, at, setter.id, setter.username);
	held.rows = [...new Set(rows.map((row) => row.setting))].sort();
	for (const [line, ofIt] of heldLines(setter, held.rows, cause.log, cause.unnamed)) afterCommit(() => line.warn(ofIt.message, ofIt.meta, ofIt.filedUnder));
	return held;
}

/**
 * The lines a hold writes (card 2922, R13): one under SMTP for the mail
 * settings and the App URL and one under BACKUP for the destinations, from
 * the settings the rows name, filed under nobody (the ending's own line names
 * who made it). scripts/mfa-reset.mjs writes the same words, which
 * tests/mfa-reset-script.test.ts holds equal. `unnamed` (card 2997's code
 * review, FP1): the words and the details name no account, as
 * `removeSettingsSetBy(…, 'record')` words them.
 */
export function heldLines(
	setter: Named,
	settings: readonly string[],
	because: string,
	unnamed = false
): [ReturnType<typeof createLogger>, { message: string; meta: Record<string, unknown>; filedUnder: { userId: null } }][] {
	const lines: [ReturnType<typeof createLogger>, { message: string; meta: Record<string, unknown>; filedUnder: { userId: null } }][] = [];
	const whose = unnamed
		? 'set by an account whose access the record of account endings on this server ended (found by its pass)'
		: `set by ${quoted(setter.username)} (user ${setter.id})`;
	const setterMeta = unnamed ? {} : { setter: setter.id };
	const mail = settings.filter((s) => s === MAIL || s === APP_URL);
	if (mail.length > 0) {
		const what = mail.map((s) => (s === MAIL ? 'the mail settings' : 'the App URL')).join(' and ');
		lines.push([
			smtpLog,
			{
				message:
					`Held for the superadmin's review: ${what}, ${whose}, as ${because}. No mail is sent through held mail settings, and no ` +
					'link begins with a held App URL, until the superadmin keeps or removes each under Settings held for review.',
				meta: { ...setterMeta, held: mail },
				filedUnder: { userId: null }
			}
		]);
	}
	const destinations = settings.filter((s) => s.startsWith(DESTINATION)).map((s) => s.slice(DESTINATION.length));
	if (destinations.length > 0) {
		const list = destinations.map((name) => quoted(name)).join(', ');
		lines.push([
			backupLog,
			{
				message:
					`Held for the superadmin's review: backup destination${destinations.length === 1 ? '' : 's'} ${list}, ${whose}, as ${because}. ` +
					'No backup is sent to, pruned at, tested at or connected for a held destination until the superadmin keeps or removes it under Settings held for review.',
				meta: { ...setterMeta, held: destinations.map((name) => DESTINATION + name) },
				filedUnder: { userId: null }
			}
		]);
	}
	return lines;
}

// ─── Settings held for review: the list, Keep and Remove (card 2922) ────────

/** One setting held for the superadmin's review and in force at its held place, as the review list shows it. */
export type HeldForReview = {
	/** The setter rows' name: `mail`, `app_url` or `backup_destination:<name>`. */
	setting: string;
	kind: 'mail' | 'app_url' | 'destination';
	/** A destination's name; null for the mail settings and the App URL. */
	name: string | null;
	/**
	 * What the superadmin reviewed, the digest Keep and Remove are sent back with (its plan's R4): the place
	 * it is held at, and for an SFTP destination its confirmed host key's fingerprint too (the code review's
	 * C16), so a key confirmed after the list was read is refused.
	 */
	place: string;
	/** The place the hold names, which Keep deletes. */
	holdPlace: string;
	heldAt: string;
	setBy: number | null;
	setByName: string | null;
	/** Where it sends, with no secret (R4): the mail's host, port, user and way out; the App URL; a destination masked. */
	where: Record<string, unknown>;
};

/**
 * Every setting held for review that is at its held place now, by the hold
 * rows and the settings as stored, for the review list (`GET
 * /api/admin/settings/held`) and the checks of Keep and Remove; and how many
 * holds are at a place no setting is at now (tombstones, R1, R19). Never a
 * secret: a destination is masked as the backup panel masks it.
 */
export function settingsHeldForReview(): { held: HeldForReview[]; tombstones: number } {
	const rows = db.select().from(settingHolds).all();
	if (rows.length === 0) return { held: [], tombstones: 0 };
	const now = placesNow();
	const held: HeldForReview[] = [];
	/** The destinations listed already: a place held under two names (a rename) is one entry (C12). */
	const listed = new Set<unknown>();
	let inForce = 0;
	for (const row of rows) {
		const base = { place: row.place, holdPlace: row.place, heldAt: row.heldAt, setBy: row.setBy, setByName: row.setByName };
		if (row.setting === MAIL && now.mail === row.place) {
			const { host, port, user, allowInsecure } = mailConnectionAsRead();
			held.push({ ...base, setting: MAIL, kind: 'mail', name: null, where: { host, port, user, allowInsecure } });
			inForce++;
		} else if (row.setting === APP_URL && now.appUrl === row.place) {
			held.push({ ...base, setting: APP_URL, kind: 'app_url', name: null, where: { url: appUrlAsRead(storedAppUrlValue()) } });
			inForce++;
		} else if (row.setting.startsWith(DESTINATION)) {
			// By its place, under whatever name it has now (C12).
			const found = now.destinations.filter((d) => d.place === row.place);
			if (found.length === 0) continue;
			inForce++;
			for (const destination of found) {
				if (listed.has(destination.entry)) continue;
				listed.add(destination.entry);
				const entry = destination.entry as Record<string, unknown>;
				const { name: _name, ...shown } = maskDestination(entry) as Record<string, unknown>;
				// An SFTP destination's confirmed host key is part of what was reviewed (C16).
				const place = entry.type === 'sftp' ? placeKey([row.place, String(entry.hostKey ?? '')]) : row.place;
				held.push({ ...base, place, setting: DESTINATION + destination.name, kind: 'destination', name: destination.name, where: shown });
			}
		}
	}
	held.sort((a, b) => (a.setting < b.setting ? -1 : a.setting > b.setting ? 1 : 0));
	return { held, tombstones: rows.length - inForce };
}

/** The settings held for review, by kind and name alone: what the superadmin's banner on the admin pages says (R7). */
export function settingsHeldForBanner(): Pick<HeldForReview, 'kind' | 'name'>[] {
	return settingsHeldForReview().held.map(({ kind, name }) => ({ kind, name }));
}

/** The App URL row as stored, '' for none. */
function storedAppUrlValue(): string {
	const row = sqlite.prepare("SELECT value FROM settings WHERE key = 'app_url'").get() as { value: string } | undefined;
	return row?.value ?? '';
}

/** A setting's name as the lines say it. */
const settingWords = (held: Pick<HeldForReview, 'kind' | 'name'>) =>
	held.kind === 'mail' ? 'the mail settings' : held.kind === 'app_url' ? 'the App URL' : `backup destination ${quoted(held.name ?? '')}`;

/** Whose a hold says it was, for the lines. */
const heldFor = (held: Pick<HeldForReview, 'setBy' | 'setByName'>) =>
	held.setByName === null ? `user ${held.setBy ?? 'unknown'}` : `${quoted(held.setByName)} (user ${held.setBy ?? 'unknown'})`;

/** The logger a setting's lines go under: SMTP for the mail settings and the App URL, BACKUP for a destination. */
const logOf = (held: Pick<HeldForReview, 'kind'>) => (held.kind === 'destination' ? backupLog : smtpLog);

/**
 * Keep a setting held for review (card 2922, its plan's R4), inside the
 * caller's transaction: its hold at that place is deleted, and nothing else.
 * No setter row changes: the superadmin approves the place, and does not take
 * it over. One WARN once committed, filed under `actor`.
 */
export function keepHeldSetting(held: HeldForReview, actor: Named): void {
	// A destination's hold is by its place under any name (C12): every hold of a destination at that place goes.
	if (held.kind === 'destination') {
		db.delete(settingHolds).where(and(like(settingHolds.setting, `${DESTINATION}%`), eq(settingHolds.place, held.holdPlace))).run();
	} else {
		db.delete(settingHolds).where(and(eq(settingHolds.setting, held.setting), eq(settingHolds.place, held.holdPlace))).run();
	}
	afterCommit(() =>
		logOf(held).warn(
			`Kept after the superadmin's review by ${quoted(actor.username)}: ${settingWords(held)}, set by ${heldFor(held)}, held since ${held.heldAt}. ` +
				'It is in use again.',
			{ setting: held.setting, keptBy: actor.id, setBy: held.setBy },
			{ userId: actor.id }
		)
	);
}

/** What removing held mail settings or a held App URL ended across the server (R2; the code review's C2, C3): every mailed key. */
export type MailCredentialsEnded = { invites: number; enrolmentLinks: number; requestLinks: number; decisionLinks: number };

/**
 * End, across the server, every key mailed to anyone, inside the caller's
 * transaction (R2, C2, C3): each invite not yet used, each set-up link, each
 * request link and each decision participant's personal link. Each was mailed
 * through the mail settings, and its link began with the App URL: whoever ran
 * the relay, or the server a held App URL named, may hold any of them. Each
 * decision link ended is recorded on its decision, as every other ending of
 * one is: `link_revoked { reason: 'held_setting_removed' }` by `actor`.
 */
function endMailedCredentials(actor: Named): MailCredentialsEnded {
	const by: RecordActor = { userId: actor.id, name: actor.username, source: writingWithKey() ? 'api' : 'ui' };
	return {
		invites: sqlite.prepare('DELETE FROM invite_tokens WHERE used = 0').run().changes,
		enrolmentLinks: sqlite.prepare('DELETE FROM enrolment_links').run().changes,
		requestLinks: sqlite.prepare('DELETE FROM request_links').run().changes,
		decisionLinks: revokeEveryLink('held_setting_removed', by)
	};
}

/**
 * Remove a setting held for review (card 2922), inside the caller's
 * transaction: the mail settings (every smtp_* row), the App URL row, or the
 * destination with its stored secrets out of `backup_config`; and every
 * setter row of it. Its hold stays, a tombstone (R1): the setting saved or
 * restored at that place again is held again.
 *
 * Removing held mail settings, or a held App URL (the code review's C3), also
 * ends, across the server, every key that was mailed (`endMailedCredentials`:
 * R2, C2). Their counts are answered and said in one line, counts only. Mail
 * set up on this server is recorded first (`recordMailEverConfigured`, C4), so
 * that the removal never opens the password-alone set-up leave.
 *
 * One WARN once committed, filed under `actor`, and the credentials' line.
 */
export function removeHeldSetting(held: HeldForReview, actor: Named): { ended: MailCredentialsEnded | null } {
	let ended: MailCredentialsEnded | null = null;
	if (held.kind === 'mail') {
		if (mailStored()) recordMailEverConfigured();
		sqlite.prepare("DELETE FROM settings WHERE key LIKE 'smtp\\_%' ESCAPE '\\'").run();
		ended = endMailedCredentials(actor);
	} else if (held.kind === 'app_url') {
		sqlite.prepare("DELETE FROM settings WHERE key = 'app_url'").run();
		ended = endMailedCredentials(actor);
	} else {
		const config = storedBackupConfig();
		if (config !== null) {
			// Every entry at the held place, whatever its name (C12).
			const kept = config.destinations.filter((d) => placeKey(destinationPlace(d)) !== held.holdPlace);
			sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(JSON.stringify({ ...config, destinations: kept }));
		}
	}
	db.delete(settingSetters).where(eq(settingSetters.setting, held.setting)).run();
	// And a destination's rows under any other name at the place removed (C12).
	if (held.kind === 'destination') {
		db.delete(settingSetters).where(and(like(settingSetters.setting, `${DESTINATION}%`), eq(settingSetters.place, held.holdPlace))).run();
	}
	afterCommit(() =>
		logOf(held).warn(
			`Removed after the superadmin's review by ${quoted(actor.username)}: ${settingWords(held)}, set by ${heldFor(held)}, held since ${held.heldAt}. ` +
				'Its hold stays: saved again at the same place, it is held again.',
			{ setting: held.setting, removedBy: actor.id, setBy: held.setBy },
			{ userId: actor.id }
		)
	);
	if (ended !== null) {
		const counts = ended;
		afterCommit(() =>
			smtpLog.warn(
				`Removing the held ${held.kind === 'mail' ? 'mail settings' : 'App URL'} ended, across the server, ${counts.invites} invite(s) ` +
					`not yet used, ${counts.enrolmentLinks} set-up link(s), ${counts.requestLinks} request link(s) and ${counts.decisionLinks} ` +
					`decision link(s): each was mailed ${held.kind === 'mail' ? 'through them' : 'with a link that began with it'}.`,
				{ ...counts },
				{ userId: actor.id }
			)
		);
	}
	return { ended };
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
 *
 * Import Backup runs it too, `when` `'restore'`, once a restore of the
 * running database is committed (card 2411): a backup taken while such a
 * setter waited for a restart, or one whose setter's row could not be copied,
 * brings their settings back in force, and they stayed until the next start.
 */
export function removeSettingsOfFormerAdministrators(
	when: 'start-up' | 'restore' = 'start-up'
): { setter: number; removed: SettingsRemoved }[] {
	return inTransaction(() => {
		// An administrator is `admin` or `superadmin`, as `isAdmin` (board-access.ts) has it.
		// A disabled account is treated the same (card 2671): disabling removes
		// what it set, and this finds what a restore or a host edit left.
		const found = sqlite
			.prepare(
				`SELECT DISTINCT s.user_id AS id, u.username AS username, u.disabled_at IS NOT NULL AS disabled
				 FROM setting_setters s LEFT JOIN users u ON u.id = s.user_id
				 WHERE s.user_id IS NOT NULL AND (u.id IS NULL OR u.role NOT IN ('admin', 'superadmin') OR u.disabled_at IS NOT NULL)
				 ORDER BY s.user_id`
			)
			.all() as { id: number; username: string | null; disabled: number | null }[];
		const removed = found.map(({ id, username, disabled }) => ({
			setter: id,
			removed:
				username === null
					? removeSettingsSetBy({ id, username: '' }, 'gone', null, when)
					: removeSettingsSetBy({ id, username }, disabled === 1 ? 'disabled' : 'not-an-administrator', null, when)
		}));
		// And every disabled account's address out of the backup failure address,
		// whatever its role (the code review's CS2): a restore, or a host edit,
		// can bring it back after the disable took it out. One WARN each, naming
		// the account and not the address.
		const disabledAccounts = sqlite
			.prepare('SELECT id, username, email FROM users WHERE disabled_at IS NOT NULL ORDER BY id')
			.all() as { id: number; username: string; email: string }[];
		for (const account of disabledAccounts) {
			if (!removeFailureAddress(account.email)) continue;
			afterCommit(() =>
				backupLog.warn(
					`The address of user ${account.id} ("${account.username}"), whose account is disabled, was taken out of the backup ` +
						`failure address (found ${when === 'restore' ? 'after a restore' : 'at start-up'}): backup failures are not mailed to it.`,
					{ userId: account.id, why: 'disabled', found: when },
					{ userId: null }
				)
			);
		}
		return removed;
	});
}
