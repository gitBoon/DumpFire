/**
 * backup-secrets.ts — what a backup leaves out because it is a secret, and
 * what a restore and the server do about the gaps that leaves (card 2169).
 *
 * A backup held the mail password, every backup destination's credentials and
 * every webhook's signing secret. Whoever read one copy could send mail as the
 * server's mail account, read, replace or delete the copies at every
 * destination, and sign forged deliveries to every webhook's receiver. So the
 * copy holds none of them (`clearSecrets`, called by `withoutSecrets` in
 * backup.ts):
 *
 *   - the mail password: its row is deleted;
 *   - a destination's secret fields: each set to '' (a Google service
 *     account's JSON keeps only its allowlisted fields, `SERVICE_ACCOUNT_SHOWN`,
 *     every other set to '': card 2938), its other fields kept. A
 *     destination of a type this version does not know is left out, and so is
 *     a `backup_config` that is not JSON;
 *   - a webhook's secret: set to '', and the webhook switched off, so that a
 *     file put in place by hand, without the restore's code, sends nothing
 *     unsigned. The `webhook_secrets_left_out` setting lists each such webhook
 *     with whether it was on, which is how a restore tells it from a webhook
 *     made without a secret.
 *
 * A restore fills each gap from this server, inside its transaction, where it
 * is for the same account (`readSecretsHere` before the first table is
 * cleared, `fillSecretGaps` after the copy): only from an entry here that is
 * the same in every field that is not secret, and only when exactly one is.
 * Every field beside a secret is the backup's word, and the backup is not
 * trusted: a destination that matched on its connection alone would upload
 * this server's database to a bucket or folder the backup chose, with this
 * server's credentials. A value the backup has is never replaced, so a backup
 * made before this change restores as it does today.
 *
 * Since card 2898 the live database holds each of these sealed under the MFA
 * key, bound to where it is used, and a fill moves the sealed value as it is:
 * the rules that match an entry here are the ones its seal is bound to, so it
 * opens where it is put. A value here that does not open is not moved
 * (`readSecretsHere`), and a backup that holds one in plain has it sealed as
 * the restore reads it (`rowsToRestore`, db/restore.ts).
 *
 * And only from a backup this server made and nobody changed since (the
 * review's S1). Matching the fields beside a secret is not enough on its own:
 * a backup that is this server's own in every field but one added superadmin
 * would have every secret filled, and the superadmin it added would then hold
 * them. So every backup is sealed (`sealCopy`, called by `withoutSecrets`): an
 * HMAC-SHA256, with a key this server keeps and no backup holds
 * (`backup_seal_key`), over every row of the cleared copy, written into the
 * copy as the `backup_seal` setting. A restore recomputes it with its own key
 * (`sealVerifies`) and fills nothing when it does not match: a backup made by
 * another server, or changed since in anything a restore brings in, has every
 * gap listed to enter again instead. What the seal does not cover, a restore
 * does not bring in: the rowids of a table with no INTEGER PRIMARY KEY (their
 * order is covered, not their values), `sqlite_sequence`, the file's header
 * and its free space. A restore copies each table's columns, in rowid order,
 * into this server's own tables, and none of those comes with them.
 *
 * The seal is made over the rows as the tables store them, and what a restore
 * copies is read the same way (the second review's B1): an index can hold
 * rows its table does not, and a bare `SELECT *` steered by a `sqlite_stat1`
 * row would read them. So the seal covers every row of `sqlite_master`,
 * SQLite's own included, and the `sqlite_stat*` tables; a file that holds an
 * object named as SQLite's own that no backup of this server's holds, or that
 * fails `PRAGMA integrity_check`, is treated as unsealed before its seal is
 * asked (`unsealedBecause`); and the seal, the restore's copy and the settings
 * it reads all read each table `NOT INDEXED` (`fromTableStorage`).
 *
 * What is still to enter is said by the restore's answer, by the start-up
 * line (`secretsToEnter`) and, for a destination, by Backup History, because
 * `runBackup` does not try one that lacks its credentials (`credentialsMissing`).
 * An SFTP destination with neither password nor key is the exception there:
 * a server that allows `none` authentication accepts it, so it is tried as
 * it was before this change and not named at start (the plan's section 9).
 *
 * The same list and the same rule serve the admin routes (cards 2187 and
 * 2190). `GET /api/admin/backup` shows every secret field masked
 * (`maskDestination`), the Google Drive refresh token included, which it used
 * to send as stored. A save or a test that sends a secret back masked has it
 * kept only from the one stored destination that is the same in every field
 * that is not secret, as a restore fills one (`keepMaskedSecrets`), never by
 * its place in the list; otherwise it is refused, naming what changed. The
 * mail password is kept by the restore's mail rule (`keepMailPassword`). A
 * field added to `SECRET_FIELDS` is then cleared from a copy, filled by a
 * restore, masked by the GET and kept by a save and a test, with nothing else
 * to change.
 *
 * An SFTP destination's confirmed host key (card 2250) is no secret: it stays
 * in a copy and the GET shows it. But it decides where a secret may go, so a
 * save or a test that changes or removes it needs the secret typed again
 * (`differences`), a restore never takes one from a backup (`fillSecretGaps`),
 * and `runBackup` does not try an SFTP destination without one
 * (`hostKeyMissing`).
 *
 * No SDK is imported here: the destination types are read as plain objects.
 */
import type Database from 'better-sqlite3';
import { createHmac, randomBytes, timingSafeEqual, type Hmac } from 'node:crypto';
import { resolve } from 'node:path';
import { driveScopeIsNarrow } from '$lib/drive-scope';
import { getDbPath, sqlite } from './db';
// A name or a title as a sentence prints it: each control character, a line
// break above all, as a space (the log's own cleaner, card 2214).
import { createLogger, printable } from './logger';
import { HOST_KEY_NOT_CONFIRMED, confirmedHostKey, hostKeyText } from './ssh-host-key';
import { NEW_SECRET_REASONS } from './webhooks';
import { SERVICE_ACCOUNT_SHOWN, readServiceAccountJson, serviceAccountKey } from './service-account-json';
import { driveProblem, driveSet } from './onedrive-address';
import {
	WEBHOOK_ADDRESSES_LEFT_OUT,
	WEBHOOK_ADDRESS_KEY_WORDS,
	WEBHOOK_ADDRESS_MAC_KEY,
	addressToBind,
	replacedSigningKeysLine,
	looksSealed,
	sameAddressMac,
	webhookAddressMac,
	mailPasswordAad,
	openDestinationSecrets,
	openStored,
	receiverColumn,
	sealStored,
	settingAad,
	unopenableFields,
	webhookSecretAad,
	withSecretField,
	withUnopenableCarried
} from './stored-secrets';

/** The setting that lists the webhooks a backup left without their secrets. */
export const WEBHOOK_SECRETS_LEFT_OUT_KEY = 'webhook_secrets_left_out';

/** Backup's own log label, for the WARN of a replaced webhook address key (card 2928's code review, C14). */
const log = createLogger('BACKUP');

/** The setting that holds this server's key for sealing its backups: 32 random bytes, as hex. Never in a backup. */
export const BACKUP_SEAL_KEY = 'backup_seal_key';

/** The setting a backup's seal is written in. */
export const BACKUP_SEAL = 'backup_seal';

/** Why nothing was kept from this server: what a restore says of a backup whose seal does not verify, or whose file fails a check. */
export const NOT_SEALED_HERE = 'this backup was not made by this server, or was changed since';

/** The same, of a backup with no seal this server can check: one made before seals, a seal of another form, or a server that has made no backup yet (N7). */
export const NO_SEAL_HERE = 'this backup carries no seal this server can check';

/**
 * How a secret is shown by `GET /api/admin/backup` and `GET /api/admin/smtp`,
 * and how the admin page sends back one that was not typed again (card 2187).
 */
export const SECRET_MASK = '••••••••';

/**
 * The secret fields of each destination type: the one list (card 2187). A
 * service account's JSON is read apart: its key is inside it.
 */
export const SECRET_FIELDS: Record<string, readonly string[]> = {
	sftp: ['password', 'privateKey'],
	s3: ['secretAccessKey'],
	gdrive: ['clientSecret', 'refreshToken'],
	onedrive: ['clientSecret']
};

/**
 * Every type's secret fields together: what a copy clears on every
 * destination, whatever its type (the review's S4). The same fields as
 * stored-secrets.ts's `DESTINATION_SECRET_FIELDS`, what is sealed, which a
 * test pins (card 2938).
 */
const ANY_SECRET_FIELD = [...new Set(Object.values(SECRET_FIELDS).flat())];

/**
 * The fields, beside the type, that must be the same for a destination here to
 * be the same account and the same place as one restored (the plan's R1):
 * every field that is not secret, the name included. The same rule decides
 * whether a secret sent back masked to the admin routes is kept (card 2190).
 *
 * Frozen into the stored secrets' additional data (card 2898, S8): these
 * fields less `name` are `DESTINATION_PLACE_FIELDS` in stored-secrets.ts at
 * version 1, which every destination secret is sealed bound to. A change here
 * changes which secrets a restore moves, not what they open with: change the
 * two together, with a new `AAD_VERSION` and a re-seal at start, or a secret
 * moved by the new rule will not open.
 *
 * OneDrive's `drive` (card 2941) is compared here as stored, and joins the
 * place and the additional data only when it is a non-empty text (`driveSet`,
 * the one rule, ruling R2): a field appended only when set leaves every value
 * stored without it unchanged, so it needed no new version and no re-seal.
 */
const SAME_IN = {
	sftp: ['name', 'host', 'port', 'username', 'remotePath'],
	s3: ['name', 'region', 'bucket', 'prefix', 'endpoint', 'accessKeyId'],
	gdriveOauth: ['name', 'authMethod', 'folderId', 'clientId'],
	gdriveServiceAccount: ['name', 'authMethod', 'folderId'],
	onedrive: ['name', 'tenantId', 'clientId', 'folderPath', 'drive']
} as const;

/**
 * The mail settings that decide where the password is sent (R1), and over what
 * (card 2189's way out, in the place of "Use SSL/TLS", which is no longer
 * read), and the password. The sender's address and name do not.
 */
const MAIL_KEYS = ['smtp_host', 'smtp_port', 'smtp_allow_insecure', 'smtp_user', 'smtp_pass'] as const;

/** Each field's name as a refusal says it (card 2190). */
const FIELD_WORDS: Record<string, string> = {
	password: 'password',
	privateKey: 'private key',
	secretAccessKey: 'secret access key',
	clientSecret: 'client secret',
	refreshToken: 'refresh token',
	serviceAccountJson: 'service account JSON',
	type: 'type',
	name: 'name',
	host: 'host',
	port: 'port',
	username: 'user name',
	remotePath: 'remote path',
	region: 'region',
	bucket: 'bucket',
	prefix: 'prefix',
	endpoint: 'endpoint',
	accessKeyId: 'access key ID',
	authMethod: 'sign-in method',
	folderId: 'folder ID',
	clientId: 'client ID',
	tenantId: 'tenant ID',
	folderPath: 'folder path',
	// A OneDrive destination's user or drive ID (card 2941).
	drive: 'user or drive ID',
	// A service account's JSON naming another `client_email` or `private_key_id`.
	serviceAccount: 'service account',
	// An SFTP destination's confirmed host key changed or removed (card 2250, decision 8).
	hostKey: 'host key'
};

/** What `runBackup` and Backup History say of a destination whose credentials are not entered (decision 8). */
export const CREDENTIALS_NOT_ENTERED =
	"This destination's credentials are not entered: a backup does not hold them, so they are entered again after a " +
	'restore. Enter them in Admin, Scheduled Backups.';

/** The same, for a Google Drive destination connected with OAuth, which is connected again. */
export const GDRIVE_NOT_CONNECTED =
	"This destination's credentials are not entered: a backup does not hold them, so they are entered again after a " +
	'restore. In Admin, Scheduled Backups, enter its client secret and connect it again.';

/**
 * The same, for a Google Drive destination whose service account JSON was
 * entered but is not a service account key (card 2938's code review, R2),
 * worded for any way it fails the rule (card 2939, ruling P7).
 */
export const SERVICE_ACCOUNT_NOT_A_KEY =
	"This destination's JSON is not a service account key file from Google, so it is not tried. In Admin, Scheduled " +
	'Backups, enter the JSON key file Google gives for the service account.';

type Entry = Record<string, unknown>;

/** A webhook the marker lists: its id, and whether it was on when the backup was made. */
export type ListedWebhook = { id: number; active: boolean };

/** A webhook the marker of addresses left out lists (card 2928): with the match of its address, where it opened. */
export type ListedAddress = ListedWebhook & { address?: string };

/** The setting that lists the webhooks whose address a backup left out (card 2928). */
export const WEBHOOK_ADDRESSES_LEFT_OUT_KEY = WEBHOOK_ADDRESSES_LEFT_OUT;

/** What a restore kept from this server; `webhookAddresses` (card 2928) present only where it kept one. */
export type SecretsKept = { mailPassword: boolean; destinations: string[]; webhooks: number[]; webhookAddresses?: number[] };

/** What is still to enter, with what each destination needs and each webhook's board. */
export type SecretsToEnter = {
	mailPassword: boolean;
	/**
	 * The way out as a restore brought it in (card 2189's "Allow mail without a
	 * checked, encrypted connection"), present only where the mail password was
	 * not kept and the backup's setting differs from the one this server had,
	 * so that the sentence names the box (the review-fix pass's S5).
	 */
	mailWayOut?: boolean;
	destinations: { name: string; type: string; needs: string }[];
	webhooks: { id: number; boardId: number; board: string | null }[];
	/**
	 * Of those with no secret, the ones held off for good for a reason that
	 * gives a new secret on switch-on (`NEW_SECRET_REASONS`, card 2923's code
	 * review, E1): nothing is to be entered for them, and a secret sent with
	 * the switch-on is refused. Present only where there is one.
	 */
	heldWebhooks?: { id: number; boardId: number; board: string | null }[];
	/**
	 * The webhooks whose address a backup left out and is still to enter (card
	 * 2928), held or not: none is switched on without one. Present only where
	 * there is one.
	 */
	webhookAddresses?: { id: number; boardId: number; board: string | null }[];
};

/** `RestoreResult.secrets`: what the restore kept, and what is to enter. */
export type SecretsAccount = { kept: SecretsKept; toEnter: SecretsToEnter };

/** This server's secrets and what decides where each goes, read before a restore clears anything. */
export type SecretsHere = {
	mail: Record<(typeof MAIL_KEYS)[number], string | null>;
	destinations: Entry[];
	webhooks: {
		id: number;
		boardId: number;
		/** As stored: sealed (card 2928), compared opened. */
		url: string;
		receiver: string;
		secret: string;
		setBy: number | null;
		heldBecause: string | null;
		heldAt: string | null;
	}[];
	/**
	 * Every webhook here whose address opens (card 2928): as stored, for a fill
	 * to move byte for byte, and opened, for the match. Absent where none was read.
	 */
	addresses?: { id: number; boardId: number; receiver: string; url: string; opened: string; setBy: number | null; heldBecause: string | null }[];
};

const isEntry = (value: unknown): value is Entry => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Whether a field holds anything. */
const has = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

const isKnownType = (type: unknown): type is string => typeof type === 'string' && Object.hasOwn(SECRET_FIELDS, type);

const isOauth = (destination: Entry) => destination.authMethod === 'oauth';

/** A service account's JSON, read; null for none, or for JSON that is not an object. */
function serviceAccount(json: unknown): Entry | null {
	if (typeof json !== 'string' || json === '') return null;
	try {
		const parsed = JSON.parse(json);
		return isEntry(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Whether a service account JSON's `field` is kept and shown as it is:
 * allowlisted, and text. The allowlist, `SERVICE_ACCOUNT_SHOWN`
 * (service-account-json.ts, card 2939), is what a backup's copy keeps and the
 * GET shows (card 2938's code review, R1), and what a save stores beside
 * `private_key`. Every other field is '' in a copy and masked by the GET,
 * whatever its name, so that JSON of another shape (an `authorized_user`'s
 * `client_secret` and `refresh_token`, an impersonated account's
 * `source_credentials`, a key under any name) reaches neither. A restore
 * knows the same account by `client_email` and `private_key_id`
 * (`differences`) and fills this server's JSON whole (`withSecretsOf`).
 */
const shownAsIs = (field: string, value: unknown): boolean => SERVICE_ACCOUNT_SHOWN.includes(field) && typeof value === 'string';

/**
 * Whether a service account's JSON is a key DumpFire signs in with, by the
 * one rule (`serviceAccountKey`, service-account-json.ts, card 2939): an
 * object whose `type` is `service_account`, with text `client_email` and
 * `private_key`, each field the rule reads text, and Google's own universe.
 * Google's library would pick another way to sign in for another `type`
 * (card 2938's code review, R2); DumpFire builds a JWT from these fields alone
 * (`getDrive`), so nothing else is a key.
 */
function isServiceAccountKey(json: unknown): boolean {
	return serviceAccountKey(json) !== null;
}

/**
 * Why a Google Drive destination that signs in with a service account has no
 * key to sign in with, as `runBackup` and a Test say it (card 2939, ruling
 * P5), by the one rule (`readServiceAccountJson`, the code review's F3): its
 * credentials not entered where its JSON is none, '' or the key-less shape a
 * backup's copy leaves (the rule accepts it, with no key), otherwise not a
 * service account key file. `getDrive` throws it for JSON `serviceAccountKey`
 * gives no key for, and `credentialsMissing` answers it.
 */
export function serviceAccountMissing(json: unknown): string {
	if (!has(json)) return CREDENTIALS_NOT_ENTERED;
	const reading = readServiceAccountJson(json);
	return 'stored' in reading && reading.key === null ? CREDENTIALS_NOT_ENTERED : SERVICE_ACCOUNT_NOT_A_KEY;
}

const emptyKept = (): SecretsKept => ({ mailPassword: false, destinations: [], webhooks: [] });
const emptyToEnter = (): SecretsToEnter => ({ mailPassword: false, destinations: [], webhooks: [] });

// ─── What a destination lacks ────────────────────────────────────────────────

/**
 * Whether `destination` lacks the credentials it needs: an S3 one with no
 * secret, Google Drive OAuth without its client secret or its refresh token, a
 * service account whose JSON is not a service account key, OneDrive with no
 * client secret; and, only where `sftp` is asked, SFTP with neither password
 * nor key.
 *
 * A service account's JSON has its key only where the one rule finds one
 * (`isServiceAccountKey`: card 2938's code review, R2, and card 2939's
 * `client_email`, read fields as text and Google's universe). Google's library picks
 * its way to sign in by `type`, and only that way needs `private_key`: JSON of
 * another type would sign in another way, and JSON with no `type`, or a key
 * only under another name (`privateKey`), is refused or not what this
 * destination is for. Such JSON lacks its key: `runBackup` does not try it, and
 * an entry here holding it is never used to fill a restored one, which is
 * listed to enter.
 */
function lacks(destination: Entry, sftp: boolean): boolean {
	switch (destination.type) {
		case 'sftp':
			return sftp && !has(destination.password) && !has(destination.privateKey);
		case 's3':
			return !has(destination.secretAccessKey);
		case 'gdrive':
			return isOauth(destination)
				? !has(destination.clientSecret) || !has(destination.refreshToken)
				: !isServiceAccountKey(destination.serviceAccountJson);
		case 'onedrive':
			return !has(destination.clientSecret);
		default:
			return false;
	}
}

/**
 * What a destination needs entered, as decision 5's sentence says it. A
 * restore never takes an SFTP host key from a backup (card 2250, decision 9),
 * so an SFTP destination's key is confirmed again by its Test.
 */
function needs(destination: Entry): string {
	switch (destination.type) {
		case 'sftp':
			return 'SFTP: its password or private key, then Test to confirm its host key';
		case 's3':
			return 'S3: its secret access key';
		case 'gdrive':
			return isOauth(destination) ? 'Google Drive: its client secret, then Connect' : 'Google Drive: its service account JSON';
		default:
			return 'OneDrive: its client secret';
	}
}

/**
 * Why `runBackup` does not try `destination`, or null when it has what it
 * needs (decision 8). An SFTP destination with neither password nor key is
 * tried, as before (section 9), and so is a type this version does not know,
 * which `createDestination` refuses as before. A service account whose JSON
 * was entered but is not a service account key says so
 * (`SERVICE_ACCOUNT_NOT_A_KEY`, card 2938's code review, R2); one as a
 * backup's copy leaves it says its credentials are not entered.
 */
export function credentialsMissing(destination: unknown): string | null {
	if (!isEntry(destination) || !lacks(destination, false)) return null;
	if (destination.type === 'gdrive' && isOauth(destination)) return GDRIVE_NOT_CONNECTED;
	if (destination.type === 'gdrive') return serviceAccountMissing(destination.serviceAccountJson);
	return CREDENTIALS_NOT_ENTERED;
}

/** Whether `destination` is an SFTP one with no confirmed host key: none, or text that does not read as one (card 2250). */
const lacksHostKey = (destination: unknown): boolean =>
	isEntry(destination) && destination.type === 'sftp' && confirmedHostKey(destination.hostKey) === null;

/**
 * Why `runBackup` does not try `destination`, beside `credentialsMissing`, or
 * null: an SFTP destination with no confirmed host key (card 2250, decision
 * 6), one with neither password nor key among them, since it would still
 * upload the database to whoever answers. Its words go to Backup History, the
 * ERROR line and the failure mail.
 */
export function hostKeyMissing(destination: unknown): string | null {
	return lacksHostKey(destination) ? HOST_KEY_NOT_CONFIRMED : null;
}

/**
 * Why `runBackup` does not try `destination`, beside those above, or null: a
 * OneDrive destination with no drive (one saved before card 2941), or one
 * whose drive is none of the three forms (a restore or the settings JSON can
 * leave one). Asked before the copy is made, so no token is asked for.
 */
export function driveMissing(destination: unknown): string | null {
	if (!isEntry(destination) || destination.type !== 'onedrive') return null;
	return driveProblem(destination.drive);
}

/**
 * The name of every SFTP destination in `database`'s backup settings with no
 * confirmed host key, in the order they are listed: what the start-up line
 * names (card 2250, decision 7). Reads, and writes nothing.
 */
export function unconfirmedHostKeys(database: Database.Database): string[] {
	return destinationsIn(settingOf(database, 'backup_config'))
		.filter(lacksHostKey)
		.map((destination) => String(destination.name ?? ''));
}

// ─── The marker ──────────────────────────────────────────────────────────────

/**
 * The webhooks a marker's text lists, and what in it could not be read. It is
 * a backup's word (the plan's N4): text that is not a JSON list is read as
 * none, an entry whose `id` is not a whole number or whose `active` is not
 * true or false is ignored, and each is said in `problems`. An id listed
 * twice is read once.
 */
export function parseListed(text: string | null | undefined): { listed: ListedWebhook[]; problems: string[] } {
	if (text === null || text === undefined) return { listed: [], problems: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	if (!Array.isArray(parsed)) {
		return {
			listed: [],
			problems: [`The list of webhooks a backup left without their secrets (${WEBHOOK_SECRETS_LEFT_OUT_KEY}) is not a JSON list, so none was read from it`]
		};
	}
	const listed: ListedWebhook[] = [];
	let ignored = 0;
	for (const entry of parsed) {
		if (!isEntry(entry) || !Number.isInteger(entry.id) || typeof entry.active !== 'boolean') {
			ignored++;
			continue;
		}
		if (!listed.some((seen) => seen.id === entry.id)) listed.push({ id: entry.id as number, active: entry.active });
	}
	const problems =
		ignored > 0
			? [
					`${ignored} entry(ies) of the list of webhooks a backup left without their secrets (${WEBHOOK_SECRETS_LEFT_OUT_KEY}) ` +
						'had no whole-number id or no true-or-false active, and were ignored'
				]
			: [];
	return { listed, problems };
}

/** The columns `table` has in `database`; none for a table that is not there. */
function columnsOf(database: Database.Database, table: string): string[] {
	return (database.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((column) => column.name);
}

const hasColumns = (database: Database.Database, table: string, ...columns: string[]) => {
	const present = columnsOf(database, table);
	return columns.every((column) => present.includes(column));
};

/**
 * One setting of `database`, or null where it, or the table, is not there.
 * Read from the table's own rows, never through an index (`NOT INDEXED`), the
 * first in the order they are stored: in a backup, an index can hold rows its
 * table does not, and the table's rows are the ones the seal is made over
 * (the second review's B1).
 */
function settingOf(database: Database.Database, key: string): string | null {
	if (!hasColumns(database, 'settings', 'key', 'value')) return null;
	const row = database.prepare('SELECT value FROM settings NOT INDEXED WHERE key = ?').get(key) as { value: string } | undefined;
	return row ? row.value : null;
}

/** The webhooks `database`'s own marker lists, and what in it could not be read. */
export function readListed(database: Database.Database): { listed: ListedWebhook[]; problems: string[] } {
	return parseListed(settingOf(database, WEBHOOK_SECRETS_LEFT_OUT_KEY));
}

/**
 * The webhooks a marker of addresses left out lists (card 2928), as
 * `parseListed` reads its own, each with its `address` match where it holds 64
 * hex characters, none where it holds none or anything else (it then matches
 * nothing, and the address is to enter). The backup's word, as the other.
 */
export function parseAddressesListed(text: string | null | undefined): { listed: ListedAddress[]; problems: string[] } {
	const { listed, problems } = parseListed(text);
	let raw: unknown[] = [];
	try {
		const parsed = JSON.parse(text ?? '[]');
		if (Array.isArray(parsed)) raw = parsed;
	} catch {
		// Said by parseListed.
	}
	const addressOf = (id: number): string | undefined => {
		const entry = raw.find((each) => isEntry(each) && each.id === id) as Entry | undefined;
		return entry !== undefined && typeof entry.address === 'string' && /^[0-9a-f]{64}$/.test(entry.address) ? entry.address : undefined;
	};
	return {
		listed: listed.map((entry) => {
			const address = addressOf(entry.id);
			return address === undefined ? entry : { ...entry, address };
		}),
		problems: problems.map((problem) => problem.replace(`without their secrets (${WEBHOOK_SECRETS_LEFT_OUT_KEY})`, `without their addresses (${WEBHOOK_ADDRESSES_LEFT_OUT_KEY})`))
	};
}

/** The webhooks `database`'s own marker of addresses left out lists (card 2928). */
export function readAddressesListed(database: Database.Database): { listed: ListedAddress[]; problems: string[] } {
	return parseAddressesListed(settingOf(database, WEBHOOK_ADDRESSES_LEFT_OUT_KEY));
}

/** The destinations a `backup_config`'s text holds, each an object; none where it is not JSON or holds no list (N4). */
function destinationsIn(text: string | null): Entry[] {
	if (text === null) return [];
	try {
		const config = JSON.parse(text);
		return isEntry(config) && Array.isArray(config.destinations) ? config.destinations.filter(isEntry) : [];
	} catch {
		return [];
	}
}

// ─── The copy ────────────────────────────────────────────────────────────────

/** Whether `database` is the application's own connection, or another connection to its file (N1). */
function isTheRunningDatabase(database: Database.Database): boolean {
	if (database === sqlite) return true;
	const inMemory = (name: string) => name === '' || name === ':memory:';
	const running = getDbPath();
	return !inMemory(database.name) && !inMemory(running) && resolve(database.name) === resolve(running);
}

/**
 * A destination as the copy holds it: every secret field '' where it was
 * there, its other fields as they were. Every type's secret fields are
 * cleared, and a service account's JSON but its allowlist
 * (`SERVICE_ACCOUNT_SHOWN`), on every destination whatever its
 * type (the review's S4): a field another type keeps a secret in may have
 * been left on one whose type was changed, and the copy is no place to find
 * out whether it still holds one.
 */
function clearedDestination(destination: Entry): Entry {
	const cleared: Entry = { ...destination };
	for (const field of ANY_SECRET_FIELD) {
		if (field in cleared) cleared[field] = '';
	}
	if (has(destination.serviceAccountJson)) {
		// The allowlist kept, every other field '' whatever it holds, none added
		// (card 2938's code review, R1): `client_email` and `private_key_id` are
		// what a restore knows the same account by. JSON that cannot be read
		// is not known to hold no key, so it goes whole.
		const account = serviceAccount(destination.serviceAccountJson);
		cleared.serviceAccountJson = account
			? JSON.stringify(Object.fromEntries(Object.entries(account).map(([field, value]) => [field, shownAsIs(field, value) ? value : ''])))
			: '';
	}
	return cleared;
}

/**
 * A `backup_config`'s text as the copy holds it, or null to leave the setting
 * out: JSON that is not an object, or whose `destinations` is not a list,
 * cannot be read for what is secret in it, and is read as no destinations
 * anyway (`getBackupConfig`). An entry that is not an object, or of a type
 * this version does not know, is left out: it cannot be used, and what in it
 * is secret is not known.
 */
function clearedConfig(text: string): string | null {
	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isEntry(config)) return null;
	if (config.destinations === undefined) return text;
	if (!Array.isArray(config.destinations)) return null;
	const destinations = config.destinations
		.filter((destination): destination is Entry => isEntry(destination) && isKnownType(destination.type))
		.map(clearedDestination);
	return JSON.stringify({ ...config, destinations });
}

/**
 * Take every secret out of `copy`, a backup's copy, before it is written out
 * again (decision 1): the mail password's row deleted, and the key this server
 * seals its backups with (S1), each destination's
 * secret fields '', and each webhook's secret '' with the webhook switched off
 * and listed in `webhook_secrets_left_out` with whether it was on. Any marker
 * already in the copy is replaced, keeping each entry whose webhook is still
 * there with no secret, with the `active` it recorded (R2): a backup made
 * before a restored webhook's secret is entered still says it lacks one.
 *
 * And every webhook's address (card 2928): '' in the copy, the webhook
 * switched off and listed in `webhook_addresses_left_out` with whether it was
 * on and, where it opens and `macKey` is given, the match of it a restore
 * fills it back by (`webhookAddressMac`); the key itself deleted. Entries the
 * copy's own marker holds for a webhook still without one are carried (R8).
 *
 * Throws, before it writes anything, when handed the running database (N1):
 * there it would delete the mail password and switch off every signed
 * webhook. A table that is not there is skipped; anything else that goes
 * wrong is thrown, for `withoutSecrets` to stop the backup with.
 */
export function clearSecrets(copy: Database.Database, macKey: Buffer | null = null): void {
	if (isTheRunningDatabase(copy)) {
		throw new Error('The secrets are cleared from a backup’s copy only, never from the running database. Nothing was changed.');
	}
	const hasSettings = hasColumns(copy, 'settings', 'key', 'value');

	if (hasSettings) {
		copy.prepare("DELETE FROM settings WHERE key = 'smtp_pass'").run();
		// The key this server seals its backups with (S1): whoever held it could
		// seal a backup of their own making, and have this server fill it. And
		// any seal already in the copy, which `sealCopy` writes afresh. And the
		// key the copy's address matches are made with (card 2928, R14).
		copy.prepare('DELETE FROM settings WHERE key IN (?, ?, ?)').run(BACKUP_SEAL_KEY, BACKUP_SEAL, WEBHOOK_ADDRESS_MAC_KEY);		const stored = settingOf(copy, 'backup_config');
		if (stored !== null) {
			const cleared = clearedConfig(stored);
			if (cleared === null) copy.prepare("DELETE FROM settings WHERE key = 'backup_config'").run();
			else if (cleared !== stored) copy.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(cleared);
		}
	}

	// Each address (card 2928): '' in the copy, the webhook off, and listed with whether it was on and the match
	// of the address this server can make again (`macKey`); read, with every webhook's on or off, before anything
	// below switches one off. The live marker's entries for rows still '' are carried (R8).
	let addressEntries: ListedAddress[] = [];
	const wasOn = new Map<number, boolean>(
		hasColumns(copy, 'webhooks', 'id', 'active')
			? (copy.prepare('SELECT id, active FROM webhooks').all() as { id: number; active: number }[]).map((row) => [row.id, row.active !== 0])
			: []
	);
	if (hasColumns(copy, 'webhooks', 'id', 'board_id', 'url', 'active')) {
		const stillWithoutAddress = (id: number) => !!copy.prepare("SELECT 1 FROM webhooks WHERE id = ? AND url = ''").get(id);
		const carried = hasSettings ? readAddressesListed(copy).listed.filter((entry) => stillWithoutAddress(entry.id)) : [];
		const left = (
			copy
				.prepare(`SELECT id, board_id AS boardId, url, ${receiverColumn(copy)} AS receiver, active FROM webhooks WHERE url <> '' ORDER BY id`)
				.all() as { id: number; boardId: number; url: string; receiver: string; active: number }[]
		).map((row) => {
			const opened = addressToBind(row);
			return { id: row.id, active: row.active !== 0, ...(opened !== null && macKey !== null ? { address: webhookAddressMac(macKey, row, opened) } : {}) };
		});
		copy.prepare("UPDATE webhooks SET url = '', active = 0 WHERE url <> ''").run();
		addressEntries = [...carried, ...left].sort((a, b) => a.id - b.id);
	}

	let entries: ListedWebhook[] = [];
	if (hasColumns(copy, 'webhooks', 'id', 'secret', 'active')) {
		const stillWithout = (id: number) =>
			!!copy.prepare("SELECT 1 FROM webhooks WHERE id = ? AND (secret IS NULL OR secret = '')").get(id);
		const carried = hasSettings ? readListed(copy).listed.filter((entry) => stillWithout(entry.id)) : [];
		const signed = (
			copy.prepare("SELECT id, active FROM webhooks WHERE secret IS NOT NULL AND secret <> '' ORDER BY id").all() as {
				id: number;
				active: number;
			}[]
		).map((row) => ({ id: row.id, active: wasOn.get(row.id) ?? row.active !== 0 }));
		copy.prepare("UPDATE webhooks SET secret = '', active = 0 WHERE secret IS NOT NULL AND secret <> ''").run();
		entries = [...carried, ...signed].sort((a, b) => a.id - b.id);
	}
	if (hasSettings) {
		copy.prepare('DELETE FROM settings WHERE key = ?').run(WEBHOOK_SECRETS_LEFT_OUT_KEY);
		if (entries.length > 0) {
			copy.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(WEBHOOK_SECRETS_LEFT_OUT_KEY, JSON.stringify(entries));
		}
		copy.prepare('DELETE FROM settings WHERE key = ?').run(WEBHOOK_ADDRESSES_LEFT_OUT_KEY);
		if (addressEntries.length > 0) {
			copy.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(WEBHOOK_ADDRESSES_LEFT_OUT_KEY, JSON.stringify(addressEntries));
		}
	}
}

// ─── The seal ────────────────────────────────────────────────────────────────

/** Which form a seal is in: the first thing it is taken over, and written before it where it is stored. */
const SEAL_VERSION = 2;

/** The first thing every seal is taken over: says which form the rest is in. */
const SEAL_FORMAT = `DumpFire backup seal ${SEAL_VERSION}`;

/** A key as it is stored: 32 bytes as 64 lower-case hex characters. */
const HEX_32 = /^[0-9a-f]{64}$/;

/**
 * A seal as it is stored: its form's number, a colon, and the HMAC as 64
 * lower-case hex characters (`2:…`). A seal of another form is one this build
 * cannot check, and is taken as no seal (`sealCarried`).
 */
const STORED_SEAL = new RegExp(`^${SEAL_VERSION}:([0-9a-f]{64})$`);

/** What each part of the dump begins with. */
const MARK = { schema: 0x53, table: 0x54, row: 0x52, end: 0x45 } as const;

/** What each value begins with: its type. */
const TYPE = { null: 0, integer: 1, real: 2, text: 3, blob: 4 } as const;

/** Values longer than this go to the HMAC as they are, not through the buffer. */
const LARGE = 16 * 1024;

/**
 * The dump a seal is taken over, written straight into the HMAC through a
 * buffer of its own, so that a database of any size is never held whole.
 * Every value is its type and then its bytes, text and blobs with their
 * length first, so that no two different databases write the same bytes: a
 * text '1' and an integer 1, or 'ab' + 'c' and 'a' + 'bc', are told apart.
 */
class SealWriter {
	private readonly buffer = Buffer.allocUnsafe(64 * 1024);
	private at = 0;

	constructor(private readonly hmac: Hmac) {}

	private room(n: number): void {
		if (this.at + n > this.buffer.length) this.flush();
	}

	flush(): void {
		if (this.at > 0) this.hmac.update(this.buffer.subarray(0, this.at));
		this.at = 0;
	}

	byte(value: number): void {
		this.room(1);
		this.buffer[this.at++] = value;
	}

	length(n: number): void {
		this.room(4);
		this.buffer.writeUInt32BE(n, this.at);
		this.at += 4;
	}

	text(value: string): void {
		const n = Buffer.byteLength(value, 'utf8');
		this.length(n);
		if (n > LARGE) {
			this.flush();
			this.hmac.update(value, 'utf8');
			return;
		}
		this.room(n);
		this.at += this.buffer.write(value, this.at, 'utf8');
	}

	blob(value: Buffer): void {
		this.length(value.length);
		if (value.length > LARGE) {
			this.flush();
			this.hmac.update(value);
			return;
		}
		this.room(value.length);
		value.copy(this.buffer, this.at);
		this.at += value.length;
	}

	/** One value as SQLite holds it, read with every integer as a bigint. */
	value(value: unknown): void {
		if (value === null || value === undefined) {
			this.byte(TYPE.null);
		} else if (typeof value === 'bigint') {
			this.byte(TYPE.integer);
			this.room(8);
			this.buffer.writeBigInt64BE(value, this.at);
			this.at += 8;
		} else if (typeof value === 'number') {
			this.byte(TYPE.real);
			this.room(8);
			this.buffer.writeDoubleBE(value, this.at);
			this.at += 8;
		} else if (typeof value === 'string') {
			this.byte(TYPE.text);
			this.text(value);
		} else if (Buffer.isBuffer(value)) {
			this.byte(TYPE.blob);
			this.blob(value);
		} else {
			throw new Error(`A value of a kind SQLite does not hold was read: ${typeof value}`);
		}
	}
}

/** A name, quoted for SQL. */
const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * A SELECT of every row of `table` (with `where`, when given) read from the
 * table's own storage and never through an index: `NOT INDEXED`, in rowid
 * order, or in primary key order for a table without rowids, which is the
 * order it is stored in. What the seal is made over and what a restore copies
 * are both read this way (the second review's B1): an index can hold rows its
 * table does not, a `sqlite_stat1` row can steer a bare `SELECT *` to read
 * one, and then the rows copied would not be the rows sealed.
 */
export function fromTableStorage(database: Database.Database, table: string, where = ''): string {
	const withoutRowid = (database.prepare('SELECT wr FROM pragma_table_list WHERE schema = ? AND name = ?').pluck().get('main', table) ?? 0) !== 0;
	const order = withoutRowid
		? (database.prepare(`PRAGMA table_info(${quoted(table)})`).all() as { name: string; pk: number }[])
				.filter((column) => column.pk > 0)
				.sort((a, b) => a.pk - b.pk)
				.map((column) => quoted(column.name))
				.join(', ')
		: 'rowid';
	return `SELECT * FROM ${quoted(table)} NOT INDEXED${where ? ` WHERE ${where}` : ''} ORDER BY ${order}`;
}

/** SQLite's own tables a backup of this server's may hold: the AUTOINCREMENT counters, and what ANALYZE writes. */
const SQLITE_TABLES_ALLOWED = new Set(['sqlite_sequence', 'sqlite_stat1', 'sqlite_stat2', 'sqlite_stat3', 'sqlite_stat4']);

/** A row of `sqlite_master`, as `strayInternalObjects` is given it. */
export type SchemaEntry = { type: string; name: string; tbl_name: string; sql: string | null };

/**
 * The names, in `schema` (every row of a database's `sqlite_master`), of
 * objects named as SQLite's own that no backup of this server's holds: every
 * name beginning `sqlite_`, in any case, but the tables `sqlite_sequence` and
 * `sqlite_stat1` to `sqlite_stat4`, and the index SQLite makes for a UNIQUE or
 * PRIMARY KEY of one of the database's own tables, which is named
 * `sqlite_autoindex_<table>_<n>`, is on that table and has no SQL. Anything
 * else so named was put there by hand (the second review's B1: a covering
 * index named `sqlite_cover`, which a seal that left `sqlite_` names out did
 * not see). Reads only what it is given.
 */
export function strayInternalObjects(schema: readonly SchemaEntry[]): string[] {
	const isInternal = (name: string) => name.toLowerCase().startsWith('sqlite_');
	const ownTables = new Set(
		schema.filter((entry) => entry.type === 'table' && !isInternal(entry.name)).map((entry) => entry.name.toLowerCase())
	);
	const allowed = (entry: SchemaEntry): boolean => {
		const name = entry.name.toLowerCase();
		if (entry.type === 'table') return SQLITE_TABLES_ALLOWED.has(name);
		if (entry.type !== 'index' || entry.sql !== null) return false;
		const table = entry.tbl_name.toLowerCase();
		const prefix = `sqlite_autoindex_${table}_`;
		return ownTables.has(table) && name.startsWith(prefix) && /^[1-9][0-9]*$/.test(name.slice(prefix.length));
	};
	return schema.filter((entry) => isInternal(entry.name) && !allowed(entry)).map((entry) => entry.name);
}

/**
 * The check `backup` fails before its seal is asked (the second review's B1),
 * in words, or null where it fails none: it holds an object named as SQLite's
 * own that no backup of this server's holds (`strayInternalObjects`), or
 * `PRAGMA integrity_check`, which compares every index with its table, says
 * anything but `ok`. Either way the rows a query reads may not be the rows the
 * seal was made over. Reads, and writes nothing; the integrity check reads the
 * whole file (about 0.12 s for 59 MB, measured on a development machine).
 */
export function backupFailsCheck(backup: Database.Database): string | null {
	const stray = strayInternalObjects(backup.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all() as SchemaEntry[]);
	if (stray.length > 0) {
		const named = stray.slice(0, 5).map((name) => `"${printable(name)}"`).join(', ') + (stray.length > 5 ? ` and ${stray.length - 5} more` : '');
		return `it holds ${named}, named as SQLite's own, which no backup made by this server holds`;
	}
	let found: string[];
	try {
		found = (backup.prepare('PRAGMA integrity_check').pluck().all() as unknown[]).map(String);
	} catch (e) {
		return `PRAGMA integrity_check could not be run on it (${printable((e as Error)?.message ?? String(e))})`;
	}
	if (found.length === 1 && found[0] === 'ok') return null;
	const said = found.slice(0, 3).map(printable).join('; ') + (found.length > 3 ? `; and ${found.length - 3} more` : '');
	return `PRAGMA integrity_check on it did not answer "ok" (${said})`;
}

/**
 * The seal of `database` with `key`, as 64 hex characters: an HMAC-SHA256 over
 * a dump of everything in it that a restore can bring in, made the same way
 * from the same rows whatever file they are in, so that a copy written out
 * again with `VACUUM INTO` has the seal it had before:
 *
 *   - the structure: every row of `sqlite_master`, SQLite's own included (an
 *     index it makes for a UNIQUE column, `sqlite_stat1` once ANALYZE has
 *     run, and anything named as SQLite's own put there by hand), as written,
 *     by type and name (not where it is in the file, which `VACUUM INTO`
 *     changes);
 *   - every table but `sqlite_sequence`, by name, the `sqlite_stat1` to
 *     `sqlite_stat4` that steer how a query reads included (the second
 *     review's B1): its name and its columns' names, then every row from the
 *     table's own storage in rowid order (in primary key order for a table
 *     without one; `fromTableStorage`), each value typed and its length
 *     given. The seal's own row of `settings` is left out, so that it can be
 *     written into what it seals.
 *
 * Reads, and writes nothing. Takes as long as reading every row does.
 */
export function sealOf(database: Database.Database, key: Buffer): string {
	const hmac = createHmac('sha256', key);
	const out = new SealWriter(hmac);
	out.text(SEAL_FORMAT);

	const schema = database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').raw(true).all() as unknown[][];
	out.byte(MARK.schema);
	out.length(schema.length);
	for (const row of schema) for (const value of row) out.value(value);

	const tables = database
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'sqlite_sequence' ORDER BY name")
		.pluck()
		.all() as string[];
	for (const table of tables) {
		const columns = database.prepare(`PRAGMA table_info(${quoted(table)})`).all() as { name: string }[];
		const leaveOutSeal = table === 'settings' && columns.some((column) => column.name === 'key') ? `"key" IS NOT '${BACKUP_SEAL}'` : '';
		const rows = database.prepare(fromTableStorage(database, table, leaveOutSeal)).raw(true).safeIntegers(true);
		const names = rows.columns().map((column) => column.name);

		out.byte(MARK.table);
		out.text(table);
		out.length(names.length);
		for (const name of names) out.text(name);
		for (const row of rows.iterate() as IterableIterator<unknown[]>) {
			out.byte(MARK.row);
			for (const value of row) out.value(value);
		}
		out.byte(MARK.end);
	}

	out.flush();
	return hmac.digest('hex');
}

/**
 * This server's key for sealing its backups, made the first time one is asked
 * for: 32 random bytes, kept in `live`'s settings as `backup_seal_key`. No
 * backup holds it (`clearSecrets`), and a restore keeps this server's in
 * place of anything a backup brings (`restoreFromBackup`). A key that is not
 * 64 hex characters is replaced, as one never made is.
 *
 * Stored sealed under the MFA key (card 2898), bound to its setting's name,
 * and opened here; one held in plain, from before, is used as it is until the
 * next start seals it. One that does not open is replaced, as one never made
 * is (decision 9): backups made before then no longer verify.
 */
export function backupSealKey(live: Database.Database = sqlite): Buffer {
	const opened = sealKeyOpened(settingOf(live, BACKUP_SEAL_KEY));
	if (opened !== null) return Buffer.from(opened, 'hex');
	const made = randomBytes(32).toString('hex');
	// The key check and the key in one transaction (card 2898's code review, E10).
	live.transaction(() => {
		live
			.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
			.run(BACKUP_SEAL_KEY, sealStored(made, settingAad(BACKUP_SEAL_KEY), live));
	})();
	return Buffer.from(made, 'hex');
}

/**
 * This server's key for the match a backup carries of each webhook address it
 * leaves out (card 2928, R14), made the first time a backup asks for it: 32
 * random bytes, stored sealed as `webhook_address_mac_key`, bound to its
 * setting's name. No backup, export or safety copy holds it, and a restore
 * keeps this server's (`addressMacKeyHere`, `keepSetting`).
 */
export function webhookAddressMacKey(live: Database.Database = sqlite): Buffer {
	const here = addressMacKeyHere(live);
	if (here !== null) return here.key;
	// One stored that does not open is replaced, with the start's own WARN for a replaced key (its code review, C14).
	if (settingOf(live, WEBHOOK_ADDRESS_MAC_KEY) !== null) log.warn(replacedSigningKeysLine([WEBHOOK_ADDRESS_KEY_WORDS]));
	const made = randomBytes(32).toString('hex');
	live.transaction(() => {
		live
			.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
			.run(WEBHOOK_ADDRESS_MAC_KEY, sealStored(made, settingAad(WEBHOOK_ADDRESS_MAC_KEY), live));
	})();
	return Buffer.from(made, 'hex');
}

/**
 * The webhook address key as `live` holds it: `stored`, as it is stored, for a
 * restore to put back unchanged, and `key`, opened; null where there is none,
 * or none that opens (a restore then fills no address, R14). Writes nothing.
 */
export function addressMacKeyHere(live: Database.Database): { stored: string; key: Buffer } | null {
	const stored = settingOf(live, WEBHOOK_ADDRESS_MAC_KEY);
	const opened = openStored(stored, settingAad(WEBHOOK_ADDRESS_MAC_KEY));
	return stored !== null && (opened.kind === 'opened' || opened.kind === 'plain') && HEX_32.test(opened.value)
		? { stored, key: Buffer.from(opened.value, 'hex') }
		: null;
}

/** Put back, in `live`'s restored settings, a setting of this server's as it was read before the restore cleared them. */
export function keepSetting(live: Database.Database, key: string, stored: string): void {
	if (!hasColumns(live, 'settings', 'key', 'value')) return;
	live.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, stored);
}

/** The key, 64 hex characters, from its setting as stored: opened, or as it is when plain; null for none, one that does not open, or one that is not 64 hex. */
function sealKeyOpened(stored: string | null): string | null {
	const opened = openStored(stored, settingAad(BACKUP_SEAL_KEY));
	return (opened.kind === 'opened' || opened.kind === 'plain') && HEX_32.test(opened.value) ? opened.value : null;
}

/**
 * This server's key as `live` holds it, or null where it has none yet, or
 * none that opens: `stored`, the setting as it is stored (sealed, card 2898),
 * which a restore puts back unchanged, and `key`, the 64 hex characters a
 * backup's seal is checked with (S5, E1). Reads, and writes nothing.
 */
export function sealKeyHere(live: Database.Database): { stored: string; key: string } | null {
	const stored = settingOf(live, BACKUP_SEAL_KEY);
	const key = sealKeyOpened(stored);
	return stored !== null && key !== null ? { stored, key } : null;
}

/**
 * Put back, in `live`'s restored settings, this server's key as it was read
 * before the restore cleared them (`sealKeyHere`'s `stored`). A backup holds none, and
 * one that does has it left out (`rowsToRestore`): the key is this server's,
 * so that the backups it made before the restore still verify after it.
 */
export function keepSealKey(live: Database.Database, stored: string): void {
	if (!hasColumns(live, 'settings', 'key', 'value')) return;
	live
		.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
		.run(BACKUP_SEAL_KEY, stored);
}

/**
 * Seal `copy`, a backup's copy once its secrets are cleared, with `key`:
 * `sealOf` it, and write the seal into it as the `backup_seal` setting, after
 * its form's number (`2:…`), so that the backup stays one .db file and a later
 * build can tell a seal it cannot check. A copy with no settings table is left
 * unsealed, and a restore fills nothing from this server for it. Throws, like
 * `clearSecrets`, when handed the running database.
 */
export function sealCopy(copy: Database.Database, key: Buffer): void {
	if (isTheRunningDatabase(copy)) {
		throw new Error('A backup’s copy is sealed, never the running database. Nothing was changed.');
	}
	if (!hasColumns(copy, 'settings', 'key', 'value')) return;
	copy.prepare('DELETE FROM settings WHERE key = ?').run(BACKUP_SEAL);
	copy.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(BACKUP_SEAL, `${SEAL_VERSION}:${sealOf(copy, key)}`);
}

/**
 * The HMAC of the seal `backup` carries, as 64 hex characters, where it is a
 * seal of this build's form (`STORED_SEAL`); null for none, and for one of
 * any other form, which this build cannot check. Reads, and writes nothing.
 */
function sealCarried(backup: Database.Database): string | null {
	const stored = settingOf(backup, BACKUP_SEAL);
	return stored === null ? null : (STORED_SEAL.exec(stored)?.[1] ?? null);
}

/**
 * Whether `backup` carries a seal made with `key` over what it holds now: the
 * seal it carries is `sealOf` it, compared in constant time. False for no
 * seal this build can check (a backup made before seals, by something else,
 * or with a seal of another form), for no key here (this server has made no
 * backup yet), and for any change since, of a single value or of the
 * structure. Reads, and writes nothing. A restore asks `unsealedBecause`,
 * which makes the file's checks first.
 */
export function sealVerifies(backup: Database.Database, key: string | null): boolean {
	const seal = sealCarried(backup);
	if (key === null || seal === null) return false;
	return timingSafeEqual(Buffer.from(sealOf(backup, Buffer.from(key, 'hex')), 'hex'), Buffer.from(seal, 'hex'));
}

/**
 * Why a restore keeps nothing from this server for a backup (S1 and the
 * second review's N7): `none`, it carries no seal this server can check (a
 * backup made before seals, a seal of another form, or this server has no
 * key yet); `failed`, its
 * seal does not verify, or the file failed a check made first, which `check`
 * then names (`backupFailsCheck`).
 */
export type Unsealed = { seal: 'none' | 'failed'; check: string | null };

/**
 * Why nothing from this server is to be kept for `backup`, or null where its
 * seal verifies with `key`. A backup that carries a seal of this build's form,
 * on a server with a key, has the file's checks made first (`backupFailsCheck`): one it fails
 * counts as a seal that does not verify, whatever the seal says, and is named.
 * The checks are not made where there is no seal to check, which fills
 * nothing anyway. Reads, and writes nothing.
 */
export function unsealedBecause(backup: Database.Database, key: string | null): Unsealed | null {
	if (key === null || sealCarried(backup) === null) return { seal: 'none', check: null };
	const check = backupFailsCheck(backup);
	if (check !== null) return { seal: 'failed', check };
	return sealVerifies(backup, key) ? null : { seal: 'failed', check: null };
}

// ─── The restore ─────────────────────────────────────────────────────────────

/**
 * This server's secrets, and the fields that decide where each goes: the mail
 * host, port, way out, user and password; every destination whole; each
 * webhook that has a secret, with its board, its address and who set them
 * (`set_by`, card 2168; none before migration 0056), and the hold it was
 * switched off for, and when (card 2752; none before migration 0071). Read by
 * `restoreFromBackup` inside its transaction, before the first table is
 * cleared. A table or setting that is not there reads as none.
 *
 * Each secret is read as stored, sealed (card 2898), and moved so by
 * `fillSecretGaps`: its additional data are the match rules that move it, so
 * it opens where it is put. One that does not open under this server's key
 * (tampered with, or sealed under another key) is read as absent (S15, E8):
 * nothing is filled from it, and the gap is listed.
 */
export function readSecretsHere(live: Database.Database): SecretsHere {
	const mail = readMailHere(live);
	if (looksSealed(mail.smtp_pass) && openStored(mail.smtp_pass, mailPasswordAad(mail)).kind === 'unopenable') mail.smtp_pass = null;
	const setBy = hasColumns(live, 'webhooks', 'set_by') ? 'set_by' : 'NULL';
	const holds = hasColumns(live, 'webhooks', 'held_because', 'held_at');
	const held = holds ? 'held_because AS heldBecause, held_at AS heldAt' : 'NULL AS heldBecause, NULL AS heldAt';
	const webhooks = hasColumns(live, 'webhooks', 'id', 'board_id', 'url', 'secret')
		? (live
				.prepare(
					`SELECT id, board_id AS boardId, url, ${receiverColumn(live)} AS receiver, secret, ${setBy} AS setBy, ${held} FROM webhooks WHERE secret IS NOT NULL AND secret <> ''`
				)
				.all() as SecretsHere['webhooks']).filter((hook) => {
				// Bound to the address as opened (card 2928): one beside an address that is '' or does not open is absent too (R5).
				const address = addressToBind(hook);
				if (address === null) return false;
				return !looksSealed(hook.secret) || openStored(hook.secret, webhookSecretAad(hook.id, hook.boardId, address)).kind !== 'unopenable';
			})
		: [];
	// Every address here that opens (card 2928), for the restore to fill one a backup left out.
	const addresses = hasColumns(live, 'webhooks', 'id', 'board_id', 'url', 'receiver')
		? (
				live
					.prepare(`SELECT id, board_id AS boardId, url, receiver, ${setBy} AS setBy, ${holds ? 'held_because' : 'NULL'} AS heldBecause FROM webhooks WHERE url <> ''`)
					.all() as { id: number; boardId: number; url: string; receiver: string; setBy: number | null; heldBecause: string | null }[]
			).flatMap((hook) => {
				const opened = addressToBind(hook);
				return opened === null ? [] : [{ ...hook, opened }];
			})
		: [];
	return { mail, destinations: destinationsIn(settingOf(live, 'backup_config')).map(withoutUnopenableSecrets), webhooks, addresses };
}

/**
 * A destination here as stored, each secret in it that does not open under
 * this server's key emptied (S15), by the one visitor, and named in its
 * `unopenable`: `fillSecretGaps` lists a destination matched with it, and
 * never takes it as one with no credentials (card 2898's code review, E2,
 * S3).
 */
function withoutUnopenableSecrets(destination: Entry): Entry {
	const fields = unopenableFields(openDestinationSecrets({ destinations: [destination] }).destinations[0]);
	if (fields.length === 0) return destination;
	let usable: Entry = { ...destination };
	for (const field of fields) usable = withSecretField(usable, field, '');
	return { ...usable, unopenable: fields };
}

/**
 * No secrets at all: what `fillSecretGaps` is given in place of this server's
 * for a backup whose seal does not verify (S1), so that it fills nothing and
 * lists every gap, and still writes the list and counts what a working copy
 * says, as for any restore.
 */
export const nothingHere = (): SecretsHere => ({
	mail: Object.fromEntries(MAIL_KEYS.map((key) => [key, null])) as SecretsHere['mail'],
	destinations: [],
	webhooks: [],
	addresses: []
});

/** A field as it is compared: as stored, a missing one and a null alike. */
const asStored = (value: unknown) => (value === undefined ? null : value);

/**
 * A mail or destination host as it is saved: ASCII spaces and tabs taken off
 * either end, and nothing else (the review-fix pass's S1). `String.trim()`
 * takes off every Unicode space too (U+00A0, U+FEFF, U+3000), so a host
 * compared by it was not the host connected to: one sent with an ideographic
 * space was the same as the stored host for keeping its secret, and stored,
 * and connected to, with the space.
 */
export function trimHost(host: string): string {
	let start = 0;
	let end = host.length;
	while (start < end && (host[start] === ' ' || host[start] === '\t')) start++;
	while (end > start && (host[end - 1] === ' ' || host[end - 1] === '\t')) end--;
	return host.slice(start, end);
}

/**
 * A host as two are compared: `trimHost`, and ASCII letters in lower case
 * alone, as a name is matched by DNS. `toLowerCase()` folds letters outside
 * ASCII too (the Kelvin sign U+212A to `k`), which is not a host's own case.
 * Any other difference, a Unicode space included, is a change.
 */
const hostAsCompared = (host: string): string => trimHost(host).replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

/**
 * What a destination uses for `field`, as it is compared (the plan for cards
 * 2187 to 2190, R8): a missing, a null and an empty text alike, and each
 * default as the destination applies it, so that a field the admin page's edit
 * form fills in (an S3 region of "us-east-1", a OneDrive path of "/DumpFire
 * Backups", an SFTP port of 22) is the same as one stored without it:
 *
 *   host        trimmed of ASCII spaces and tabs, ASCII letters in any case
 *               (`hostAsCompared`, S1)
 *   port        22 for none (`port || 22`, SftpDestination)
 *   region      "us-east-1" for none (S3Destination)
 *   folderPath  its slashes trimmed, "DumpFire Backups" for none (OneDriveDestination)
 *
 * An SFTP `remotePath` has no default: one stored empty uploads elsewhere than
 * the form's "/backups", so the two are not the same.
 *
 * An SFTP `hostKey` is its fingerprint alone, `SHA256:…`, '' for none (card
 * 2250, decision 8): the type is inside the blob the fingerprint covers.
 */
function inUse(destination: Entry, field: string): unknown {
	const value = destination[field];
	const empty = value === undefined || value === null || value === '';
	switch (field) {
		case 'hostKey':
			return confirmedHostKey(value)?.fingerprint ?? '';
		case 'host':
			return typeof value === 'string' ? hostAsCompared(value) : empty ? '' : value;
		case 'port':
			return Number(value || 22);
		case 'region':
			return empty ? 'us-east-1' : value;
		case 'folderPath':
			return typeof value === 'string' ? value.replace(/^\/+/, '').replace(/\/+$/, '') || 'DumpFire Backups' : empty ? 'DumpFire Backups' : value;
		default:
			return empty ? '' : value;
	}
}

/** The fields `SAME_IN` compares for `destination`'s type and sign-in method; none for a type this version does not know. */
function sameInFields(destination: Entry): readonly string[] {
	switch (destination.type) {
		case 'sftp':
			return SAME_IN.sftp;
		case 's3':
			return SAME_IN.s3;
		case 'onedrive':
			return SAME_IN.onedrive;
		case 'gdrive':
			return isOauth(destination) ? SAME_IN.gdriveOauth : SAME_IN.gdriveServiceAccount;
		default:
			return [];
	}
}

/**
 * The fields in which `b` is not the same account and the same place as `a`
 * (R1, compared as R8): `type` alone when the types differ, or a type this
 * version does not know; otherwise each of `SAME_IN`'s fields that differs in
 * use (`inUse`), and `serviceAccount` for a service account's JSON naming
 * another `client_email` or `private_key_id`, the key itself excepted.
 *
 * A restore asks it of a backup's entry (`a`) against this server's, and
 * requires the backup's JSON to name an address. A save asks it of the entry
 * sent against the stored one (`keeping`), where JSON that is not an object
 * was masked whole and sent back so (the plan's R7): two that are not objects
 * are the same, since what is kept is the stored entry's own value.
 *
 * A save also compares an SFTP destination's `hostKey`, as a narrowing
 * (card 2250, decision 8): it differs where the stored entry has a key and the
 * one sent has another fingerprint, or none. A key sent where none is stored
 * does not differ: it only narrows where the secret may go, so the first
 * confirmation keeps the password, and changing or removing a confirmed key
 * needs it typed again. A test (`keeping` 'test') compares it exactly, the
 * stored key or none against the one sent (the card 2250 review's M1): only a
 * save may add a key, where it is seen, so that a Test cannot send the stored
 * password to a key of the caller's choosing. A restore does not compare it:
 * it takes no key from a backup (`fillSecretGaps`).
 */
function differences(a: Entry, b: Entry, keeping: Keeping = false): string[] {
	if (a.type !== b.type || !isKnownType(a.type)) return ['type'];
	const differ = sameInFields(a).filter((field) => inUse(a, field) !== inUse(b, field));
	if (keeping && a.type === 'sftp') {
		const confirmed = inUse(b, 'hostKey');
		const sent = inUse(a, 'hostKey');
		if (keeping === 'test' ? keyAsStored(a) !== keyAsStored(b) : confirmed !== '' && sent !== confirmed) differ.push('hostKey');
	}
	if (a.type === 'gdrive' && !isOauth(a)) {
		const ours = serviceAccount(a.serviceAccountJson);
		const theirs = serviceAccount(b.serviceAccountJson);
		const same =
			ours !== null && theirs !== null
				? (keeping || (typeof ours.client_email === 'string' && ours.client_email !== '')) &&
					asStored(ours.client_email) === asStored(theirs.client_email) &&
					asStored(ours.private_key_id) === asStored(theirs.private_key_id)
				: keeping && ours === null && theirs === null;
		if (!same) differ.push('serviceAccount');
	}
	return differ;
}

/** Whether `b` is the same account and the same place as `a`, in every field that is not secret (R1). */
const sameEntry = (a: Entry, b: Entry, keeping: Keeping = false) => differences(a, b, keeping).length === 0;

/**
 * Whether `differences` is asked for a restore (false), or for a masked secret
 * kept by a save or by a test: they differ only in an SFTP host key (card
 * 2250 and its review's M1).
 */
type Keeping = false | 'save' | 'test';

/** An SFTP destination's host key as stored, `<type> SHA256:…`, or '' for none: what a test's must equal exactly. */
const keyAsStored = (destination: Entry): string => {
	const key = confirmedHostKey(destination.hostKey);
	return key === null ? '' : hostKeyText(key);
};

/** One SFTP destination whose host key a save adds, changes or removes (card 2267): each key as stored, '' for none. */
export interface HostKeyChange {
	name: string;
	host: string;
	port: number;
	from: string;
	to: string;
	/** The destination is gone from the save, or saved as another type: its key went with it. */
	removed: boolean;
	/**
	 * Where the key it had belonged, `host:port`, when the same save moved the
	 * destination as well as changing or clearing its key (the card 2267
	 * review); absent where it did not move, or had no key.
	 */
	fromAt?: string;
}

/**
 * Each destination saved with the stored one it keeps, by `same`, or none, and
 * the stored ones no saved one keeps, in the stored order. Each stored entry is
 * matched once, so where two were stored under one name and the save keeps
 * one, the other is left over (the card 2270 review).
 */
function matchOneToOne(stored: readonly Entry[], saved: readonly Entry[], same: (a: Entry, b: Entry) => boolean) {
	const unmatched = [...stored];
	const pairs = saved.map((destination) => {
		const at = unmatched.findIndex((d) => same(d, destination));
		return { destination, kept: at === -1 ? undefined : unmatched.splice(at, 1)[0] };
	});
	return { pairs, unmatched };
}

/**
 * The SFTP host keys a save of the destinations changes (card 2267), so that
 * each is one line in the system log: a name in both lists whose key as
 * stored differs, a name stored with a key that the save drops or makes
 * another type (decision 2), and a name new in the save with a key. Stored and
 * saved are matched one to one (`matchOneToOne`), so a key on one of two
 * stored under a name that the save keeps once is removed too. Keys are
 * compared as stored, `<type> SHA256:…` (decision 3: a change of type with the
 * same fingerprint is a change), so the same key sent back as `ssh-keygen -l`
 * prints it, which `readDestination` stores canonical, is no change; stored
 * text that does not read is no key. The host and port are the saved
 * destination's, or the stored one's where it is gone, and `fromAt` the
 * stored one's where a key that was there moves with the save. Only an SFTP
 * destination is ever named.
 */
export function hostKeyChanges(before: readonly unknown[], after: readonly unknown[]): HostKeyChange[] {
	const sftpIn = (list: readonly unknown[]) => list.filter((d): d is Entry => isEntry(d) && d.type === 'sftp' && typeof d.name === 'string');
	const stored = sftpIn(before);
	const saved = sftpIn(after);
	const place = (destination: Entry) => ({
		host: typeof destination.host === 'string' ? destination.host : '',
		port: Number(destination.port) || 22
	});
	const change = (destination: Entry, from: string, to: string, removed: boolean): HostKeyChange => ({
		name: destination.name as string,
		...place(destination),
		from,
		to,
		removed
	});
	const changes: HostKeyChange[] = [];
	const { pairs, unmatched } = matchOneToOne(stored, saved, (a, b) => a.name === b.name);
	for (const { destination, kept: was } of pairs) {
		const from = was === undefined ? '' : keyAsStored(was);
		const to = keyAsStored(destination);
		if (from === to) continue;
		const entry = change(destination, from, to, false);
		// A key that was there, at a place the save leaves: the line names both places.
		if (was !== undefined && from !== '') {
			const old = place(was);
			if (old.host !== entry.host || old.port !== entry.port) entry.fromAt = `${old.host}:${old.port}`;
		}
		changes.push(entry);
	}
	for (const destination of unmatched) {
		const from = keyAsStored(destination);
		if (from !== '') changes.push(change(destination, from, '', true));
	}
	return changes;
}

/**
 * What a save of the backup settings changes (card 2270), for its one line in
 * the system log. Never a value of a destination's field: the settings were
 * the superadmin's and the log every administrator's (decision 4), and a log
 * line is kept where a value saved over is not. The settings are every
 * administrator's since card 2395, their secrets still masked.
 */
export interface BackupSettingsChanges {
	/** Each setting beside the destinations that changed, with its values; `notifyEmail` without them. */
	settings: { field: string; from?: unknown; to?: unknown }[];
	/** Destinations new by name, or saved as another type under a name: in the save's order. */
	added: { name: string; type: string }[];
	/** Destinations gone by name, or saved as another type: in the stored order. */
	removed: { name: string; type: string }[];
	/**
	 * The fields of each destination kept, by name, whose value changed: in the
	 * save's order. `elsewhere` where one of them says where the copies go, by
	 * `SAME_IN`'s rule of the same account and place (`differences`): the copies
	 * now go elsewhere (the card 2270 review).
	 */
	changed: { name: string; fields: string[]; elsewhere?: true }[];
}

/** The settings beside the destinations, in the order the line names them. `notifyEmail` holds addresses, so it is named alone. */
const SETTINGS_FIELDS = ['schedule', 'scheduleTime', 'scheduleDay', 'retention', 'notifyOnFailure', 'notifyEmail'] as const;

/** The settings that are numbers: compared as numbers, so `"7"` stored and 7 sent are the same (the card 2270 review). */
const NUMBER_SETTINGS: readonly string[] = ['scheduleDay', 'retention'];

/**
 * Whether a destination's `field` differs between `a` and `b`, as it is used
 * (card 2270, decision 4): a host, port, region and folder path by their
 * defaults (`inUse`), a host key as stored (`keyAsStored`, so that it is named
 * exactly when card 2267's line is written), and every other field with a
 * missing, a null and an empty text alike.
 */
function fieldDiffers(a: Entry, b: Entry, field: string): boolean {
	if (field === 'hostKey') return keyAsStored(a) !== keyAsStored(b);
	const one = inUse(a, field);
	const other = inUse(b, field);
	if (one === other) return false;
	const isObject = (value: unknown) => value !== null && typeof value === 'object';
	return !(isObject(one) && isObject(other) && JSON.stringify(one) === JSON.stringify(other));
}

/**
 * A destination's name in quotation marks for a line, with each `\` and `"`
 * in it escaped (`\\`, `\"`), so that no name can end the quotation early and
 * make the rest of the line read as something else (the card 2270 review).
 * Shared by every line about a change to the backup settings: a save's (cards
 * 2267 and 2270) and a Google Drive Connect's (card 2273).
 */
export const quotedName = (name: string) => `"${name.replace(/[\\"]/g, '\\$&')}"`;

/**
 * What a save of the backup settings changes (card 2270), `before` as stored
 * and `after` as it is to be saved, or null where it changes nothing, so that
 * such a save writes no line (decision 5). A destination is matched by name, as
 * everything else matches it: one saved as another type under its name is
 * removed and added, as card 2267 has it. Each stored entry is matched once, so
 * where two were stored under one name and the save keeps one, the other is
 * removed (the card 2270 review). The fields compared are every field either
 * entry holds but `name` and `type`, so a field no list names is compared too
 * (`grantedScope` among them). The retention and the day are compared as
 * numbers. The order of the destinations is not a change.
 */
export function settingsChanges(before: object, after: object): BackupSettingsChanges | null {
	const was = before as Entry;
	const now = after as Entry;
	const named = (list: unknown) =>
		(Array.isArray(list) ? list : []).filter((d): d is Entry => isEntry(d) && typeof d.name === 'string');
	const stored = named(was.destinations);
	const saved = named(now.destinations);
	const typeOf = (destination: Entry) => String(destination.type ?? '');
	const sameKind = (a: Entry, b: Entry) => a.name === b.name && a.type === b.type;

	const settings: BackupSettingsChanges['settings'] = [];
	for (const field of SETTINGS_FIELDS) {
		const same = NUMBER_SETTINGS.includes(field) ? Number(was[field]) === Number(now[field]) : was[field] === now[field];
		if (same) continue;
		settings.push(field === 'notifyEmail' ? { field } : { field, from: was[field], to: now[field] });
	}

	// Each stored entry matched once: those left over are the ones removed.
	const { pairs, unmatched } = matchOneToOne(stored, saved, sameKind);
	const added: BackupSettingsChanges['added'] = [];
	const changed: BackupSettingsChanges['changed'] = [];
	for (const { destination, kept } of pairs) {
		if (kept === undefined) {
			added.push({ name: destination.name as string, type: typeOf(destination) });
			continue;
		}
		const fields = [...new Set([...Object.keys(destination), ...Object.keys(kept)])].filter(
			(field) => field !== 'name' && field !== 'type' && fieldDiffers(kept, destination, field)
		);
		if (fields.length === 0) continue;
		// The rule a masked secret is kept by: another account or place, the host key aside (card 2267's line has it).
		const elsewhere = differences(destination, kept, 'save').some((field) => field !== 'hostKey' && field !== 'type');
		changed.push({ name: destination.name as string, fields, ...(elsewhere ? { elsewhere: true as const } : {}) });
	}
	const removed = unmatched.map((destination) => ({ name: destination.name as string, type: typeOf(destination) }));

	if (settings.length + added.length + removed.length + changed.length === 0) return null;
	return { settings, added, removed, changed };
}

/**
 * Where a destination's copies go, for card 2397's setter rows (its second
 * code review): its type and each field `differences` compares for it but its
 * name, each as it is used (`inUse`), and for a Google Drive service account
 * the account its JSON names (`client_email` and `private_key_id`, the key
 * itself excepted). Two entries with the same place are what `elsewhere`
 * calls the same account and place: a secret typed again, an SFTP host key
 * and a field no list names do not move a destination. Empty for an entry
 * that is not an object.
 *
 * Frozen into the stored secrets' additional data (card 2898, S8):
 * `destinationSecretAad` in stored-secrets.ts reads the same place, by its
 * own copy of this rule at version 1. Change the two together, with a new
 * `AAD_VERSION` and a re-seal at start.
 *
 * A OneDrive `drive` is appended last, as stored, only when it is a non-empty
 * text (`driveSet`, card 2941, ruling R2): an entry without one has the place
 * it had before, and `destinationSecretAad` appends it by the same rule.
 */
export function destinationPlace(destination: unknown): unknown[] {
	if (!isEntry(destination)) return [];
	const fields = sameInFields(destination).filter((field) => field !== 'name' && field !== 'drive');
	const place: unknown[] = [asStored(destination.type), ...fields.map((field) => inUse(destination, field))];
	if (destination.type === 'gdrive' && !isOauth(destination)) {
		const account = serviceAccount(destination.serviceAccountJson);
		place.push(account === null ? null : [asStored(account.client_email), asStored(account.private_key_id)]);
	}
	if (destination.type === 'onedrive' && driveSet(destination.drive)) place.push(destination.drive);
	return place;
}

/**
 * `restored` with the secrets of `here` in it: a service account's JSON is
 * taken whole. A Google Drive refresh token brings the scope this server
 * recorded for it, and none where it recorded none (card 2188, decision 7):
 * the scope a backup names is the backup's word, and the badge on the admin
 * page reads it. An SFTP destination takes the host key of the entry here it
 * was matched with, or none (card 2250, R4): a host key is this server's
 * trust, never the backup's word.
 */
function withSecretsOf(restored: Entry, here: Entry): Entry {
	const filled: Entry = { ...restored };
	if (restored.type === 'gdrive' && !isOauth(restored)) {
		filled.serviceAccountJson = here.serviceAccountJson;
		return filled;
	}
	for (const field of SECRET_FIELDS[restored.type as string]) {
		if (field in here) filled[field] = here[field];
	}
	if (restored.type === 'sftp') {
		delete filled.hostKey;
		if (has(here.hostKey)) filled.hostKey = here.hostKey;
	}
	if (restored.type === 'gdrive') {
		delete filled.grantedScope;
		if (has(filled.refreshToken) && has(here.grantedScope)) filled.grantedScope = here.grantedScope;
	}
	return filled;
}

/** An SFTP destination a backup holds, copied without its `hostKey` field where it has one; anything else as it is (card 2250, R4). */
function withoutHostKey(restored: unknown): unknown {
	if (!isEntry(restored) || restored.type !== 'sftp' || !('hostKey' in restored)) return restored;
	const { hostKey: _fromTheBackup, ...rest } = restored;
	return rest;
}

/** A board's name in `database`, or null where it is not there. */
function boardName(database: Database.Database, boardId: number): string | null {
	try {
		const row = database.prepare('SELECT name FROM boards WHERE id = ?').get(boardId) as { name: string } | undefined;
		return row ? row.name : null;
	} catch {
		return null;
	}
}

/**
 * Fill, in `live`'s restored rows, each gap the backup left, from this
 * server's secrets as `readSecretsHere` read them (decision 4, as R1 revised
 * it), and say what was kept and what was not:
 *
 *   - the mail password, when the restored mail settings name a host and a
 *     user and hold no password, and host (trimmed, any case), port, the
 *     way out (card 2189) and user are all this server's, read as the mailer
 *     reads them (`mailConnection`: a port of 587 and none alike, a way out
 *     of 'false' and none alike);
 *   - a destination that lacks its credentials (SFTP: neither password nor
 *     key), from the one destination here of its type that is the same in
 *     every field that is not secret, in use (`differences`: a field missing
 *     and empty alike, an S3 region of "us-east-1" and none alike, and so
 *     on). None, or more than one: not filled. A
 *     Google Drive OAuth destination is filled only when both its client
 *     secret and its refresh token are empty, and then both are taken; an
 *     SFTP one whose match here has neither either is as it is here. Every
 *     SFTP destination loses the host key the backup gives it, filled or not,
 *     sealed or not, and one filled, or as it is here, takes the key of its
 *     match here, or none (card 2250, R4);
 *   - a webhook `listed` in the backup's marker that has no secret, from the
 *     webhook here with the same id, board, address and setter (`set_by`,
 *     none and none alike), switched on or off as the marker says it was. The
 *     setter is the account that last set the address or the secret, and a
 *     password reset switches off what it set (card 2168): a secret here set
 *     by another account than the one the backup's row names was set again
 *     since, and filled it would be the other account's secret under the
 *     backup's setter, which that account's reset would not reach. One with a
 *     secret in the backup is left as it is. Never switched on where it is
 *     held off (card 2752, S1): the webhook here switched off by a hold keeps
 *     its hold, and stays off, and so does a restored row with one.
 *
 * A value the backup has is never replaced. `writeMarker`, for a restore as it
 * is, writes the marker into the restored settings trimmed to the webhooks
 * not filled (R2), so that every start names them; a working copy writes none.
 * `listedOnLeftOff` counts the webhooks the marker lists as on that are not
 * filled and are off, which a working copy counts among those switched off
 * (R3). Opens no transaction: the restore's is open.
 */
export function fillSecretGaps(
	live: Database.Database,
	here: SecretsHere,
	listed: readonly ListedWebhook[],
	options: { writeMarker: boolean; addressListed?: readonly ListedAddress[] }
): { kept: SecretsKept; unfilled: SecretsToEnter; listedOnLeftOff: number } {
	const kept = emptyKept();
	const unfilled = emptyToEnter();
	let listedOnLeftOff = 0;
	const hasSettings = hasColumns(live, 'settings', 'key', 'value');

	// The mail password.
	if (hasSettings) {
		const restored = Object.fromEntries(MAIL_KEYS.map((key) => [key, settingOf(live, key)])) as SecretsHere['mail'];
		if (has(restored.smtp_host) && has(restored.smtp_user) && !has(restored.smtp_pass)) {
			const changes = mailChanges(mailConnection(restored), mailConnection(here.mail));
			if (changes.length === 0 && has(here.mail.smtp_pass)) {
				live.prepare("DELETE FROM settings WHERE key = 'smtp_pass'").run();
				live.prepare("INSERT INTO settings (key, value) VALUES ('smtp_pass', ?)").run(here.mail.smtp_pass);
				kept.mailPassword = true;
			} else {
				unfilled.mailPassword = true;
				// A restore brings the way out in with the backup's settings, with no
				// password asked and no WARN line: where it differs from this
				// server's, the sentence names the box (S5). Only against a server
				// that had a password, so never for a backup whose seal did not
				// verify (`nothingHere`), where the seal is the reason.
				if (changes.includes('allowInsecure') && has(here.mail.smtp_pass)) {
					unfilled.mailWayOut = mailConnection(restored).allowInsecure;
				}
			}
		}
	}

	// The destinations. A configuration that cannot be read is no destinations,
	// as `getBackupConfig` reads it, and is left as the backup has it.
	const stored = hasSettings ? settingOf(live, 'backup_config') : null;
	let config: Entry | null = null;
	if (stored !== null) {
		try {
			const parsed = JSON.parse(stored);
			if (isEntry(parsed) && Array.isArray(parsed.destinations)) config = parsed;
		} catch {
			// Not JSON: no destinations.
		}
	}
	if (config) {
		let changed = false;
		const destinations = (config.destinations as unknown[]).map((restored) => {
			// A restore never takes an SFTP host key from a backup (card 2250,
			// decision 9 and R4): a crafted backup could otherwise pin a key of its
			// choosing beside the real host's name, waiting for the password to be
			// typed again. So every SFTP entry loses its key first, on every path
			// below, and only `withSecretsOf` and the "neither here either" case
			// give it the key of the entry here it was matched with.
			const destination = withoutHostKey(restored);
			if (destination !== restored) changed = true;
			if (!isEntry(destination) || !isKnownType(destination.type) || !lacks(destination, true)) return destination;
			const name = String(destination.name ?? '');
			const listIt = () => {
				unfilled.destinations.push({ name, type: destination.type as string, needs: needs(destination) });
				return destination;
			};
			// One of the two set and the other not is not this server's to complete.
			if (destination.type === 'gdrive' && isOauth(destination) && (has(destination.clientSecret) || has(destination.refreshToken))) {
				return listIt();
			}
			const matches = here.destinations.filter((candidate) => sameEntry(destination, candidate));
			if (matches.length !== 1) return listIt();
			const match = matches[0];
			// Its credentials here do not open (card 2898's code review, E2, S3): listed to
			// enter, never taken as an entry with none, which an SFTP one would be tried as.
			if (unopenableFields(match).length > 0) return listIt();
			// An SFTP destination with neither here either is as it is here, with
			// the key it has here, or none.
			if (destination.type === 'sftp' && lacks(match, true)) {
				if (!has(match.hostKey)) return destination;
				changed = true;
				return { ...destination, hostKey: match.hostKey };
			}
			if (lacks(match, true)) return listIt();
			changed = true;
			kept.destinations.push(name);
			return withSecretsOf(destination, match);
		});
		if (changed) {
			live.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(JSON.stringify({ ...config, destinations }));
		}
	}

	// The webhooks the backup's marker lists.
	const leftListed: ListedWebhook[] = [];
	if (hasColumns(live, 'webhooks', 'id', 'board_id', 'url', 'secret', 'active')) {
		const setBy = hasColumns(live, 'webhooks', 'set_by') ? 'set_by' : 'NULL';
		// The hold (card 2752, migration 0071), where this server has its columns.
		const holds = hasColumns(live, 'webhooks', 'held_because', 'held_at');
		const find = live.prepare(
			`SELECT id, board_id AS boardId, url, ${receiverColumn(live)} AS receiver, secret, active, ${setBy} AS setBy, ${holds ? 'held_because' : 'NULL'} AS heldBecause FROM webhooks WHERE id = ?`
		);
		const fill = live.prepare(
			`UPDATE webhooks SET secret = @secret, active = @active${holds ? ', held_because = COALESCE(@heldBecause, held_because), held_at = COALESCE(@heldAt, held_at)' : ''} WHERE id = @id`
		);
		for (const entry of listed) {
			const row = find.get(entry.id) as
				| { id: number; boardId: number; url: string; receiver: string; secret: string | null; active: number; setBy: number | null; heldBecause: string | null }
				| undefined;
			if (!row || has(row.secret)) continue;
			// The same address, compared opened on both sides (card 2928): never one that is '' or does not open.
			const address = addressToBind(row);
			const match =
				address === null
					? undefined
					: here.webhooks.find(
							(hook) => hook.id === row.id && hook.boardId === row.boardId && addressToBind(hook) === address && (hook.setBy ?? null) === row.setBy
						);
			if (match) {
				// On or off as the marker says it was. The marker is the backup's
				// word, but `here` holds anything only for a backup whose seal
				// verified (S1): one this server made, whose marker this server
				// wrote, and nobody changed since. Never on where it is held off,
				// here or in the restored row (card 2752, S1): it stays off, with
				// this server's hold, or the row's own.
				const heldOff = (match.heldBecause ?? null) !== null || (row.heldBecause ?? null) !== null;
				// On only where its address opens (card 2928, R17): `address` is the row's, after the addresses were filled.
				const params = { secret: match.secret, active: entry.active && !heldOff && address !== null ? 1 : 0, id: row.id };
				fill.run(holds ? { ...params, heldBecause: match.heldBecause ?? null, heldAt: match.heldAt ?? null } : params);
				kept.webhooks.push(row.id);
			} else {
				unfilled.webhooks.push({ id: row.id, boardId: row.boardId, board: boardName(live, row.boardId) });
				leftListed.push(entry);
				if (entry.active && row.active === 0) listedOnLeftOff++;
			}
		}
	}
	if (options.writeMarker && hasSettings && leftListed.length > 0) {
		live.prepare('DELETE FROM settings WHERE key = ?').run(WEBHOOK_SECRETS_LEFT_OUT_KEY);
		live.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(WEBHOOK_SECRETS_LEFT_OUT_KEY, JSON.stringify(leftListed));
	}

	// The webhooks whose address alone the backup left out (card 2928, R19): decided here, after `carryHolds`,
	// once the addresses were filled (`fillAddressGaps`), on or off as the marker says only where the address
	// opens and nothing holds it off (R17). One listed as on that stays off is counted.
	const addressOnly = (options.addressListed ?? []).filter((entry) => !listed.some((each) => each.id === entry.id));
	if (addressOnly.length > 0 && hasColumns(live, 'webhooks', 'id', 'board_id', 'url', 'receiver', 'active')) {
		const holds = hasColumns(live, 'webhooks', 'held_because');
		const find = live.prepare(`SELECT id, board_id AS boardId, url, receiver, active, ${holds ? 'held_because' : 'NULL'} AS heldBecause FROM webhooks WHERE id = ?`);
		const switchOn = live.prepare('UPDATE webhooks SET active = 1 WHERE id = ? AND active = 0');
		for (const entry of addressOnly) {
			const row = find.get(entry.id) as { id: number; boardId: number; url: string; receiver: string; active: number; heldBecause: string | null } | undefined;
			if (!row) continue;
			const opens = addressToBind(row) !== null;
			if (entry.active && opens && row.heldBecause === null) switchOn.run(row.id);
			else if (entry.active && row.active === 0) listedOnLeftOff++;
		}
	}

	return { kept, unfilled, listedOnLeftOff };
}

/**
 * Fill each webhook address a backup left out (card 2928), inside the
 * restore's transaction, before `carryHolds`: a webhook `listed` in the
 * backup's marker whose restored row has no address is given the stored
 * address, byte for byte, of the one webhook here with the same id, board,
 * receiver and setter whose address, opened, gives the match the backup
 * carries (`webhookAddressMac` under `macKey`, compared in constant time).
 * It moves sealed, and opens where it is put: its seal is bound to the id,
 * board and receiver it matched. Nothing is switched on here (R19):
 * `fillSecretGaps` decides on or off after the holds are carried. With no key
 * (none here, or one that does not open, R14), or a backup whose seal did not
 * verify (`here` empty), nothing is filled and each is listed. A row the
 * backup gave an address keeps it. `writeMarker` writes the marker into the
 * restored settings trimmed to those not filled, for every start to name.
 * Opens no transaction.
 */
export function fillAddressGaps(
	live: Database.Database,
	here: SecretsHere,
	listed: readonly ListedAddress[],
	macKey: Buffer | null,
	options: { writeMarker: boolean }
): { kept: number[]; unfilled: { id: number; boardId: number; board: string | null }[] } {
	const kept: number[] = [];
	const unfilled: { id: number; boardId: number; board: string | null }[] = [];
	if (listed.length === 0 || !hasColumns(live, 'webhooks', 'id', 'board_id', 'url', 'receiver')) return { kept, unfilled };
	const setBy = hasColumns(live, 'webhooks', 'set_by') ? 'set_by' : 'NULL';
	const find = live.prepare(`SELECT id, board_id AS boardId, url, receiver, ${setBy} AS setBy FROM webhooks WHERE id = ?`);
	const fill = live.prepare("UPDATE webhooks SET url = ? WHERE id = ? AND url = ''");
	const leftListed: ListedAddress[] = [];
	for (const entry of listed) {
		const row = find.get(entry.id) as { id: number; boardId: number; url: string; receiver: string; setBy: number | null } | undefined;
		if (!row || row.url !== '') continue;
		const match =
			macKey === null || entry.address === undefined
				? undefined
				: (here.addresses ?? []).find(
						(hook) =>
							hook.id === row.id &&
							hook.boardId === row.boardId &&
							hook.receiver === row.receiver &&
							(hook.setBy ?? null) === (row.setBy ?? null) &&
							sameAddressMac(webhookAddressMac(macKey, hook, hook.opened), entry.address)
					);
		if (match && fill.run(match.url, row.id).changes === 1) {
			kept.push(row.id);
		} else {
			unfilled.push({ id: row.id, boardId: row.boardId, board: boardName(live, row.boardId) });
			leftListed.push(entry);
		}
	}
	if (options.writeMarker && hasColumns(live, 'settings', 'key', 'value')) {
		live.prepare('DELETE FROM settings WHERE key = ?').run(WEBHOOK_ADDRESSES_LEFT_OUT_KEY);
		if (leftListed.length > 0) live.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(WEBHOOK_ADDRESSES_LEFT_OUT_KEY, JSON.stringify(leftListed));
	}
	return { kept, unfilled };
}

// ─── What is still to enter ──────────────────────────────────────────────────

/**
 * What `database` still lacks, as the start-up line says it (decision 7): the
 * mail settings name a host and a user and hold no password; a destination
 * lacks its credentials (`credentialsMissing`'s rule, so not an SFTP one); a
 * webhook its own marker lists is still there, off and with no secret. What
 * in the marker could not be read is in `problems`. Reads, and writes nothing.
 *
 * A mail password or a destination's secret that does not open under this
 * server's key (card 2898, S15) is read as missing, an SFTP one included.
 */
export function secretsToEnter(database: Database.Database): { toEnter: SecretsToEnter; problems: string[] } {
	const toEnter = emptyToEnter();
	const mail = readMailHere(database);
	toEnter.mailPassword =
		has(mail.smtp_host) && has(mail.smtp_user) && (!has(mail.smtp_pass) || openStored(mail.smtp_pass, mailPasswordAad(mail)).kind === 'unopenable');
	for (const stored of destinationsIn(settingOf(database, 'backup_config'))) {
		const destination = openDestinationSecrets({ destinations: [stored] }).destinations[0];
		if (credentialsMissing(destination) !== null || unopenableFields(destination).length > 0) {
			toEnter.destinations.push({ name: String(destination.name ?? ''), type: String(destination.type), needs: needs(destination) });
		}
	}
	const { listed, problems } = readListed(database);
	if (listed.length > 0 && hasColumns(database, 'webhooks', 'id', 'board_id', 'secret', 'active')) {
		const find = database.prepare(
			"SELECT id, board_id AS boardId FROM webhooks WHERE id = ? AND active = 0 AND (secret IS NULL OR secret = '')"
		);
		for (const entry of listed) {
			const row = find.get(entry.id) as { id: number; boardId: number } | undefined;
			if (row) toEnter.webhooks.push({ id: row.id, boardId: row.boardId, board: boardName(database, row.boardId) });
		}
	}
	// The webhooks its own marker lists as left without their address, still without one (card 2928), held or not.
	const addressed = readAddressesListed(database);
	if (addressed.listed.length > 0 && hasColumns(database, 'webhooks', 'id', 'board_id', 'url')) {
		const find = database.prepare("SELECT id, board_id AS boardId FROM webhooks WHERE id = ? AND url = ''");
		const toEnterAddresses = addressed.listed.flatMap((entry) => {
			const row = find.get(entry.id) as { id: number; boardId: number } | undefined;
			return row ? [{ id: row.id, boardId: row.boardId, board: boardName(database, row.boardId) }] : [];
		});
		if (toEnterAddresses.length > 0) toEnter.webhookAddresses = toEnterAddresses;
	}
	return { toEnter: withHeldApart(database, toEnter), problems: [...problems, ...addressed.problems] };
}

/**
 * `toEnter` with the webhooks `database` holds off for good for a reason in
 * `NEW_SECRET_REASONS` moved to `heldWebhooks` (card 2923's code review, E1):
 * their secret is not entered, since switching one on gives it a new one and
 * refuses a secret sent with it. Read as the rows are now, so the restore
 * asks it after its own holds. Unchanged where there is none, or where the
 * database has no hold column.
 */
export function withHeldApart(database: Database.Database, toEnter: SecretsToEnter): SecretsToEnter {
	const addresses = toEnter.webhookAddresses ?? [];
	if ((toEnter.webhooks.length === 0 && addresses.length === 0) || !hasColumns(database, 'webhooks', 'id', 'held_because')) return toEnter;
	const heldBecause = database.prepare('SELECT held_because FROM webhooks WHERE id = ?').pluck();
	const isHeld = (id: number) => {
		const reason = heldBecause.get(id);
		return typeof reason === 'string' && NEW_SECRET_REASONS.includes(reason);
	};
	// Card 2928's code review (C1): a held webhook whose address is to enter is held too, and stays among the
	// addresses to enter: its sentence tells it to be switched on with its url and no secret.
	const already = new Set((toEnter.heldWebhooks ?? []).map((hook) => hook.id));
	const held = [...toEnter.webhooks, ...addresses].filter((hook, at, all) => isHeld(hook.id) && !already.has(hook.id) && all.findIndex((each) => each.id === hook.id) === at);
	if (held.length === 0) return toEnter;
	return {
		...toEnter,
		webhooks: toEnter.webhooks.filter((hook) => !isHeld(hook.id)),
		heldWebhooks: [...(toEnter.heldWebhooks ?? []), ...held].sort((a, b) => a.id - b.id)
	};
}

// ─── The two sentences ───────────────────────────────────────────────────────

/** Decision 5's first sentence, or null when nothing was kept. */
export function secretsKeptSentence(kept: SecretsKept): string | null {
	const parts: string[] = [];
	if (kept.mailPassword) parts.push('the mail password');
	if (kept.destinations.length > 0) {
		parts.push(`the credentials of backup destination(s) ${kept.destinations.map((name) => `"${printable(name)}"`).join(', ')}`);
	}
	if (kept.webhooks.length > 0) parts.push(`the signing secret(s) of webhook(s) ${kept.webhooks.join(', ')}`);
	if ((kept.webhookAddresses ?? []).length > 0) parts.push(`the address(es) of webhook(s) ${kept.webhookAddresses!.join(', ')}`);
	return parts.length > 0 ? `Kept from this server, because a backup does not hold them: ${parts.join('; ')}.` : null;
}

/**
 * Decision 5's second sentence, or null when nothing is to enter. `atStart`
 * gives the start-up line's words for the webhooks (R2), which add that an
 * unwanted one is deleted, so that it is not named at every start for ever.
 * `unsealed`, for a restore of a backup whose seal did not verify (S1), adds
 * why none was kept from this server: it carries no seal this server can check, or
 * it was not made by this server or was changed since (the second review's
 * N7). Each place is named as the admin page names it (the review's O4).
 */
export function secretsToEnterSentence(toEnter: SecretsToEnter, atStart = false, unsealed: Unsealed | null = null): string | null {
	const parts: string[] = [];
	if (toEnter.mailPassword) {
		parts.push(
			toEnter.mailWayOut === undefined
				? 'the mail password (Admin, 📧 Email / SMTP)'
				: `the mail password (Admin, 📧 Email / SMTP, where the backup brought in ${WAY_OUT} ` +
						`${toEnter.mailWayOut ? 'ticked and this server had it unticked' : 'unticked and this server had it ticked'})`
		);
	}
	if (toEnter.destinations.length > 0) {
		const named = toEnter.destinations.map((d) => `"${printable(d.name)}" (${d.needs})`).join(', ');
		parts.push(`backup destination(s) ${named} (Admin, Scheduled Backups)`);
	}
	if (toEnter.webhooks.length > 0) {
		const named = toEnter.webhooks
			.map((hook) => `${hook.id} (board ${hook.board === null ? hook.boardId : `"${printable(hook.board)}"`})`)
			.join(', ');
		parts.push(
			`the signing secret(s) of webhook(s) ${named}, which stay switched off until the board's owner or an administrator ` +
				(atStart
					? "sets each one's secret and switches it on with PUT /api/v1/webhooks/{id}, or deletes it if it is no longer wanted"
					: 'sets each one and switches it on with PUT /api/v1/webhooks/{id}')
		);
	}
	// Card 2928: the addresses a backup left out. A webhook held for good among them is given one instruction, its url
	// with active true and no secret (its code review, C1): it is given a new secret then, and a secret sent is refused.
	const heldIds = new Set((toEnter.heldWebhooks ?? []).map((hook) => hook.id));
	const addresses = (toEnter.webhookAddresses ?? []).filter((hook) => !heldIds.has(hook.id));
	const heldAddresses = (toEnter.webhookAddresses ?? []).filter((hook) => heldIds.has(hook.id));
	const nameAll = (hooks: readonly { id: number; boardId: number; board: string | null }[]) =>
		hooks.map((hook) => `${hook.id} (board ${hook.board === null ? hook.boardId : `"${printable(hook.board)}"`})`).join(', ');
	if (addresses.length > 0) {
		parts.push(
			`the address(es) of webhook(s) ${nameAll(addresses)}, which stay switched off until the board's owner or an administrator ` +
				'sends each one its url (and its secret) with active true in PUT /api/v1/webhooks/{id}' +
				(atStart ? ', or deletes it if it is no longer wanted' : '')
		);
	}
	if (heldAddresses.length > 0) {
		parts.push(
			`the address(es) of webhook(s) ${nameAll(heldAddresses)}, switched off for good: to keep one, the board's owner or an ` +
				'administrator switches it on with its url and active true, and no secret, in PUT /api/v1/webhooks/{id} (it is given a new ' +
				'secret, returned once in that answer)' +
				(atStart ? ', or deletes it if it is no longer wanted' : '')
		);
	}
	// Card 2923's code review (E1): a webhook held for good is never "set its secret and switch it on".
	const held = (toEnter.heldWebhooks ?? []).filter((hook) => !heldAddresses.some((each) => each.id === hook.id));
	const heldSaid =
		held.length === 0
			? null
			: `Nothing to enter for webhook(s) ${held
					.map((hook) => `${hook.id} (board ${hook.board === null ? hook.boardId : `"${printable(hook.board)}"`})`)
					.join(', ')}, switched off for good: to keep one, the board's owner or an administrator should switch it on with no secret; ` +
				'it is given a new one, returned once in that answer (PUT /api/v1/webhooks/{id} with active true alone)' +
				(atStart ? ', or delete it if it is no longer wanted.' : '.');
	if (parts.length === 0 && heldSaid === null) return null;
	const said = [parts.length === 0 ? null : `To enter again, because a backup does not hold them: ${parts.join('; ')}.`, heldSaid]
		.filter((part) => part !== null)
		.join(' ');
	if (unsealed === null) return said;
	return `${said} None was kept from this server, because ${unsealed.seal === 'none' ? NO_SEAL_HERE : NOT_SEALED_HERE}.`;
}

/**
 * The import's one `WARN` line for a backup that failed a check made before
 * its seal (`backupFailsCheck`, the second review's B1), naming the check.
 */
export function failedCheckSentence(check: string): string {
	return `Nothing was kept from this server, because the backup failed a check made before its seal is checked: ${check}. The restore itself went ahead.`;
}

// ─── The admin routes (cards 2187 and 2190) ──────────────────────────────────

/** Words joined as a sentence lists them: "a", "a and b", "a, b and c". */
function inWords(words: readonly string[]): string {
	return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * `destination` as `GET /api/admin/backup` shows it (card 2187): every field
 * that is secret in any type, `SECRET_FIELDS` (the Google Drive refresh token
 * among them), masked where it holds anything, whatever the destination's
 * type, so that a secret left in a field of another type is masked too. A
 * service account's JSON, where it is an object, shows its allowlist
 * (`SERVICE_ACCOUNT_SHOWN`, text only) as stored and masks every other field
 * that holds anything, `private_key` among them (card 2938's code review,
 * R1); an empty one, as a restore leaves it, shows empty (card 2169's O2).
 * JSON that cannot be read, or that reads as
 * anything but an object (a key pasted in quotes, a list), is masked whole
 * (R7): spread as an object, its text would reach the browser. JSON that
 * reads as an object is always written out again from what was read, never
 * shown as stored (S3): text that names `private_key` twice reads as its
 * last, so an empty last one would have shown the stored text, the first key
 * in it. The same allowlist decides what a backup's copy keeps
 * (`clearedDestination`). Every other field of the destination is as stored,
 * `grantedScope` included, which the page's badge reads.
 */
export function maskDestination<T>(destination: T): T {
	if (!isEntry(destination)) return destination;
	const masked: Entry = { ...destination };
	for (const field of ANY_SECRET_FIELD) {
		if (has(masked[field])) masked[field] = SECRET_MASK;
	}
	if (has(masked.serviceAccountJson)) {
		const account = serviceAccount(masked.serviceAccountJson);
		if (account === null) {
			masked.serviceAccountJson = SECRET_MASK;
		} else {
			const shown = Object.entries(account).map(([field, value]) => [field, shownAsIs(field, value) || !has(value) ? value : SECRET_MASK]);
			masked.serviceAccountJson = JSON.stringify(Object.fromEntries(shown));
		}
	}
	return masked as T;
}

/**
 * Whether `destination`, as sent, has a secret typed into it: any type's
 * secret field holding text that is not the mask, or a service account's JSON
 * with no mask in it that holds a key by the one rule (`serviceAccountKey`,
 * card 2939's code review, F1). JSON with no key (the key-less shape the GET
 * shows of a restored destination, or anything the rule refuses) carries no
 * secret, so sending it back types none. Read by a move's setter (card 2397's
 * third review: a move made with a secret typed is the mover's, whoever was
 * recorded for the place it moves to) and by a Test (`destinationToTest`).
 */
export function typedSecret(destination: unknown): boolean {
	if (!isEntry(destination)) return false;
	const typed = (value: unknown) => typeof value === 'string' && value !== '' && value !== SECRET_MASK;
	if (ANY_SECRET_FIELD.some((field) => typed(destination[field]))) return true;
	const json = destination.serviceAccountJson;
	return !serviceAccountJsonMasked(json) && serviceAccountKey(json) !== null;
}

/**
 * Whether a service account's JSON, as sent, is sent masked: text holding the
 * mask anywhere. The one predicate (card 2939, ruling P6) read by
 * `maskedFields`, which `keepMaskedSecrets` replaces whole by the stored JSON,
 * and by `readDestination`, which leaves such JSON unchecked for that reason:
 * the two cannot differ, so no JSON skips the check that is not replaced.
 */
export function serviceAccountJsonMasked(json: unknown): boolean {
	return typeof json === 'string' && json.includes(SECRET_MASK);
}

/** The fields of `destination` that are sent masked: any type's secret field holding the mask, and a service account's JSON holding it anywhere. */
function maskedFields(destination: Entry): string[] {
	const masked = ANY_SECRET_FIELD.filter((field) => destination[field] === SECRET_MASK);
	if (serviceAccountJsonMasked(destination.serviceAccountJson)) masked.push('serviceAccountJson');
	return masked;
}

/**
 * The way out of two saved destinations of one name (the review-fix pass's
 * O1), in the words the deployment guide's check 0j quotes: the page's Remove
 * removes every destination of the name it is pressed on, and only the
 * superadmin removes a destination (card 2398).
 */
const removeAndAddOnce = (name: string) =>
	`Remove the destinations named "${name}" (the page's Remove removes every one of that name, and removing a destination is the superadmin's) and add it once with its secret typed`;

/** Where a connected Google Drive destination reaches all of Drive, the step that comes first (R2). */
const DRIVE_ACCESS_FIRST =
	"First remove DumpFire's access in the Google account (Google Account, Security, Your connections to third-party apps and services).";

/**
 * Why a list of destinations is refused for naming two alike (S4), or null:
 * a destination is found by its name to be connected, tested and backed up
 * to, and two of one name are the same entry to none of them. Where `stored`
 * already holds that name twice (saved before this), the way out is O1's;
 * otherwise the save gave a second destination a name already used.
 */
export function twiceNamed(destinations: readonly unknown[], stored: readonly unknown[]): string | null {
	const seen = new Set<string>();
	for (const destination of destinations) {
		if (!isEntry(destination)) continue;
		const name = String(destination.name ?? '');
		if (seen.has(name)) {
			const savedTwice = stored.filter((entry) => isEntry(entry) && String(entry.name ?? '') === name).length > 1;
			return (
				`Two backup destinations are named "${printable(name)}". ` +
				(savedTwice ? `${removeAndAddOnce(printable(name))}.` : 'Each destination needs a name of its own: give one of them another name.')
			);
		}
		seen.add(name);
	}
	return null;
}

/**
 * The refusal's remedy for a connected Google Drive destination, by the scope
 * it was connected with (R2, R5). Removing the destination is the
 * superadmin's (card 2398), so the words say so.
 */
const DRIVE_REMEDY = {
	narrow:
		"To change them, remove the destination (removing a destination is the superadmin's), add it again, and connect it. To keep " +
		'using a folder DumpFire made, give its Folder ID again (shown on the destination as Folder:); Connect checks it can reach it.',
	wide:
		"To change them, first remove DumpFire's access in the Google account (Google Account, Security, Your connections to " +
		"third-party apps and services), then remove this destination (removing a destination is the superadmin's), add it again " +
		'with the Folder ID left empty, and connect it.'
};

/**
 * Why a destination sent with `masked` secrets is refused, in decision 3's
 * words: what to type again (every field still masked, R8), and why, against
 * the stored destinations of its name: none of them; more than one the same
 * (`matches`); or what changes from the closest of them. A connected Google
 * Drive destination, whose token no form can type, is told to be removed,
 * added and connected again, beginning with removing DumpFire's access in the
 * Google account unless every stored destination it could be was connected
 * with `drive.file` alone (R2).
 */
function refusal(destination: Entry, masked: string[], stored: Entry[], matches: Entry[], keeping: 'save' | 'test'): string {
	const name = printable(String(destination.name ?? ''));
	const named = `Backup destination "${name}"`;
	const sameName = stored.filter((entry) => entry.name === destination.name);
	let why: string;
	let could: Entry[];
	if (matches.length > 1) {
		// Typing the secret again is no way out here: the list sent still holds
		// both, which a save refuses (`twiceNamed`). The way out is O1's.
		const drive = destination.type === 'gdrive' && isOauth(destination) && masked.includes('refreshToken');
		const narrow = drive && matches.every((entry) => driveScopeIsNarrow(entry.grantedScope));
		return (
			`${named}: more than one saved destination matches it, so its saved secret cannot be told apart. ` +
			(drive && !narrow ? `${DRIVE_ACCESS_FIRST} ` : '') +
			`${removeAndAddOnce(name)}${drive ? ', then connect it' : ''}.`
		);
	} else if (sameName.length === 0) {
		why = 'no destination of this name was saved';
		could = [];
	} else {
		const closest = sameName
			.map((entry) => ({ entry, changes: differences(destination, entry, keeping) }))
			.reduce((best, next) => (next.changes.length < best.changes.length ? next : best));
		why = `this changes its ${inWords(closest.changes.map((field) => FIELD_WORDS[field] ?? field))}`;
		could = [closest.entry];
	}
	if (destination.type === 'gdrive' && isOauth(destination) && masked.includes('refreshToken')) {
		const narrow = could.length > 0 && could.every((entry) => driveScopeIsNarrow(entry.grantedScope));
		return (
			`${named}: a connected Google Drive destination keeps its connection only while its name, sign-in method, folder ID and ` +
			`client ID are as they were when it was connected, and ${why}. ${narrow ? DRIVE_REMEDY.narrow : DRIVE_REMEDY.wide}`
		);
	}
	const secrets = inWords(masked.map((field) => FIELD_WORDS[field] ?? field));
	return `${named}: type its ${secrets} again. A saved secret is used only with the settings it was saved with, and ${why}.`;
}

/**
 * The destination a save or a test of `incoming` uses, or why it is refused
 * (card 2190, decision 3). `incoming` is a destination as the request sent it
 * (`readDestination`), `stored` the destinations saved now.
 *
 * A secret sent masked, as the GET shows it, is kept only from the one stored
 * destination that is the same in type and every field that is not secret
 * (`differences`, a restore's rule; never by its place in the list): each
 * masked field takes that entry's value, a masked service account JSON its
 * JSON whole, and an SFTP host is written as that entry has it (S1). None
 * the same, or more than one, and it is refused, before
 * anything is written. A destination with no mask is used as it was sent: a
 * secret typed, an empty one and a new destination are the caller's word.
 *
 * `grantedScope` belongs to the refresh token (card 2188, decision 7): it is
 * never taken from the request, only from the stored entry whose masked token
 * is kept; a token typed, empty or not sent has none.
 *
 * `use` is 'test' for the test route: there an SFTP destination's host key
 * must be the stored one exactly, none for none, for its masked secret to be
 * kept (the card 2250 review's M1), where a save may add one.
 */
export function keepMaskedSecrets<T>(
	incoming: T,
	stored: readonly unknown[],
	use: 'save' | 'test' = 'save'
): { destination: T } | { refusal: string } {
	const destination: Entry = { ...(incoming as Entry) };
	delete destination.grantedScope;
	const masked = maskedFields(destination);
	if (masked.length === 0) return { destination: destination as T };

	const entries = stored.filter(isEntry);
	const matches = entries.filter((entry) => sameEntry(destination, entry, use));
	if (matches.length !== 1) return { refusal: refusal(destination, masked, entries, matches, use) };

	const match = matches[0];
	for (const field of masked) destination[field] = has(match[field]) ? match[field] : '';
	// The stored host, which compares the same as the one sent, so that the
	// secret goes to the host it was saved with byte for byte (S1).
	if ('host' in destination && typeof match.host === 'string') destination.host = match.host;
	if (masked.includes('refreshToken') && has(match.refreshToken) && has(match.grantedScope)) destination.grantedScope = match.grantedScope;
	// A masked field whose stored value does not open is kept as it is stored
	// by the save, still to be typed again (card 2898's code review, E2).
	return { destination: withUnopenableCarried(destination, match, masked) as T };
}

/** What the Test route answers, with 400, to anything but a saved destination as it is stored (card 2939, ruling P3). */
export const SAVE_BEFORE_TEST = 'Save the destination first, then Test it.';

/**
 * The stored destination a Test of `sent` runs, or why it is refused (card
 * 2939, ruling P3): a Test runs only a saved destination, exactly as it is
 * stored, whatever its type. `sent` must have no secret typed
 * (`typedSecret`), and its name exactly one stored entry the same in every
 * field that is not secret, as a masked Test is held to (`differences`,
 * 'test', the SFTP host key included); that entry is what is tested, never
 * what was sent, so no endpoint, host, folder or key typed into a Test is
 * ever connected to. A masked destination `keepMaskedSecrets` refuses keeps
 * its own words, which say what to type and why, and so does one the same as
 * more than one saved entry ("more than one saved destination matches it");
 * anything else is `SAVE_BEFORE_TEST`.
 */
export function destinationToTest<T>(sent: unknown, stored: readonly T[]): { destination: T } | { refusal: string } {
	if (!isEntry(sent) || typedSecret(sent)) return { refusal: SAVE_BEFORE_TEST };
	const kept = keepMaskedSecrets(sent, stored, 'test');
	if ('refusal' in kept) return kept;
	const named = stored.filter((entry) => isEntry(entry) && entry.name === sent.name) as Entry[];
	const matches = named.filter((entry) => sameEntry(sent, entry, 'test'));
	// More than one saved entry it is the same as: the save's own words and way out (the code review's F4).
	if (matches.length > 1) return { refusal: refusal(sent, [], named, matches, 'test') };
	if (named.length !== 1 || matches.length !== 1) return { refusal: SAVE_BEFORE_TEST };
	return { destination: { ...matches[0] } as T };
}

/** The mail settings as they decide where the password goes, and over what. */
export type MailConnection = { host: string; port: number; allowInsecure: boolean; user: string };

/** The way out's name on the panel (card 2189, decision 14). */
const WAY_OUT = '"Allow mail without a checked, encrypted connection"';

/** Each of the mail rule's fields as the refusal names it. */
const MAIL_WORDS: Record<keyof MailConnection, string> = {
	host: 'host',
	port: 'port',
	user: 'user name',
	allowInsecure: `${WAY_OUT} setting`
};

/**
 * Mail settings, as stored text (`smtp_host` and the rest) or as the SMTP
 * route reads a save (`host`, a port as a number, `allowInsecure` as true or
 * false), read as `getSmtpConfig` reads them for the mailer (R8): the host
 * as `hostAsCompared` has it (S1), the port a number with 587 for none, the way out
 * on only for true (a backup made before card 2189 has no row: off), the
 * user '' for none.
 *
 * Frozen into the mail password's additional data (card 2898, S8):
 * `mailPasswordAad` in stored-secrets.ts reads the same connection
 * (`MAIL_CONNECTION_FIELDS`) by its own copy of this rule at version 1.
 * Change the two together, with a new `AAD_VERSION` and a re-seal at start.
 */
export function mailConnection(values: Partial<Record<string, unknown>>): MailConnection {
	const host = values.host ?? values.smtp_host;
	const user = values.user ?? values.smtp_user;
	const allowInsecure = values.allowInsecure ?? values.smtp_allow_insecure;
	return {
		host: typeof host === 'string' ? hostAsCompared(host) : '',
		port: Number((values.port ?? values.smtp_port) || 587),
		allowInsecure: allowInsecure === true || allowInsecure === 'true',
		user: typeof user === 'string' ? user : ''
	};
}

/** The fields of the mail rule in which `b` differs from `a`: R1's mail rule, the restore's and the SMTP route's. */
export function mailChanges(a: MailConnection, b: MailConnection): (keyof MailConnection)[] {
	return (['host', 'port', 'user', 'allowInsecure'] as const).filter((field) => a[field] !== b[field]);
}

/** This server's mail settings and password, as stored: what the mail rule and a restore read. A setting not there is null. */
export function readMailHere(live: Database.Database = sqlite): SecretsHere['mail'] {
	return Object.fromEntries(MAIL_KEYS.map((key) => [key, settingOf(live, key)])) as SecretsHere['mail'];
}

/**
 * The mail password a save of the mail settings writes, or why it is refused
 * (card 2190, decision 4). `sent` is what the save sends of the host, port,
 * way out, user and password, each undefined where it is not sent;
 * `stored` the mail settings as stored now (`readMailHere`).
 *
 * A password typed, an empty one included, is written as typed. One masked
 * or left out, while a password is stored, is kept only while the host, port,
 * user name and way out the save would leave stored (each sent over the
 * one stored) are the stored ones by the mail rule a restore fills it by
 * (`mailConnection`); otherwise the save is refused, naming what changed. The
 * sender's address and name and the App URL decide nothing about where the
 * password goes, and are not asked. With no password stored there is none to
 * keep: a masked one is written empty, as before. `pass` is undefined where
 * nothing is to be written, and `keep` is true where the stored one is kept
 * (card 2898, decision 18): nothing is written for it, so its sealed row is
 * left as it is.
 *
 * Where the stored password is kept and a host was sent, `host` is the stored
 * host, which the save writes in place of the one sent (S1, belt and braces):
 * the two compare the same, so the host the password goes to is byte for byte
 * the one it was saved with. Otherwise `host` is undefined.
 */
export function keepMailPassword(
	sent: { host?: string; port?: number; allowInsecure?: boolean; user?: string; pass?: string },
	stored: SecretsHere['mail']
): { pass: string | undefined; keep?: true; host?: string } | { refusal: string } {
	if (sent.pass !== undefined && sent.pass !== SECRET_MASK) return { pass: sent.pass };
	const password = stored.smtp_pass;
	if (!has(password)) return { pass: sent.pass === undefined ? undefined : '' };

	const now = mailConnection(stored);
	const after = mailConnection({
		host: sent.host ?? stored.smtp_host,
		port: sent.port ?? stored.smtp_port,
		allowInsecure: sent.allowInsecure ?? stored.smtp_allow_insecure,
		user: sent.user ?? stored.smtp_user
	});
	const changes = mailChanges(now, after);
	if (changes.length > 0) {
		return {
			refusal:
				`Type the mail password again. The saved password is used only with the host, port, user name and ${WAY_OUT} ` +
				`setting it was saved with, and this changes the ${inWords(changes.map((field) => MAIL_WORDS[field]))}.`
		};
	}
	const host = sent.host !== undefined && typeof stored.smtp_host === 'string' ? stored.smtp_host : undefined;
	// Kept: nothing is written for it (card 2898, decision 18), so the row,
	// sealed, stays byte for byte as it is, and still opens with the
	// connection the save leaves, which is the same by this rule.
	return { pass: undefined, keep: true, host };
}
