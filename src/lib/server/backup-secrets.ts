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
 *     account's `private_key` inside its JSON), its other fields kept. A
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
 * No SDK is imported here: the destination types are read as plain objects.
 */
import type Database from 'better-sqlite3';
import { createHmac, randomBytes, timingSafeEqual, type Hmac } from 'node:crypto';
import { resolve } from 'node:path';
import { getDbPath, sqlite } from './db';

/** The setting that lists the webhooks a backup left without their secrets. */
export const WEBHOOK_SECRETS_LEFT_OUT_KEY = 'webhook_secrets_left_out';

/** The setting that holds this server's key for sealing its backups: 32 random bytes, as hex. Never in a backup. */
export const BACKUP_SEAL_KEY = 'backup_seal_key';

/** The setting a backup's seal is written in. */
export const BACKUP_SEAL = 'backup_seal';

/** Why nothing was kept from this server: what a restore says of a backup whose seal does not verify, or whose file fails a check. */
export const NOT_SEALED_HERE = 'this backup was not made by this server, or was changed since';

/** The same, of a backup with no seal this server can check: one made before seals, a seal of another form, or a server that has made no backup yet (N7). */
export const NO_SEAL_HERE = 'this backup carries no seal this server can check';

/** The secret fields of each destination type. A service account's JSON is read apart: its key is inside it. */
const SECRET_FIELDS: Record<string, readonly string[]> = {
	sftp: ['password', 'privateKey'],
	s3: ['secretAccessKey'],
	gdrive: ['clientSecret', 'refreshToken'],
	onedrive: ['clientSecret']
};

/** Every type's secret fields together: what a copy clears on every destination, whatever its type (the review's S4). */
const ANY_SECRET_FIELD = [...new Set(Object.values(SECRET_FIELDS).flat())];

/**
 * The fields, beside the type, that must be the same for a destination here to
 * be the same account and the same place as one restored (the plan's R1):
 * every field that is not secret, the name included.
 */
const SAME_IN = {
	sftp: ['name', 'host', 'port', 'username', 'remotePath'],
	s3: ['name', 'region', 'bucket', 'prefix', 'endpoint', 'accessKeyId'],
	gdriveOauth: ['name', 'authMethod', 'folderId', 'clientId'],
	gdriveServiceAccount: ['name', 'authMethod', 'folderId'],
	onedrive: ['name', 'tenantId', 'clientId', 'folderPath']
} as const;

/** The mail settings that decide where the password is sent (R1). The sender's address and name do not. */
const MAIL_KEYS = ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass'] as const;

/** What `runBackup` and Backup History say of a destination whose credentials are not entered (decision 8). */
export const CREDENTIALS_NOT_ENTERED =
	"This destination's credentials are not entered: a backup does not hold them, so they are entered again after a " +
	'restore. Enter them in Admin, Scheduled Backups.';

/** The same, for a Google Drive destination connected with OAuth, which is connected again. */
export const GDRIVE_NOT_CONNECTED =
	"This destination's credentials are not entered: a backup does not hold them, so they are entered again after a " +
	'restore. In Admin, Scheduled Backups, enter its client secret and connect it again.';

type Entry = Record<string, unknown>;

/** A webhook the marker lists: its id, and whether it was on when the backup was made. */
export type ListedWebhook = { id: number; active: boolean };

/** What a restore kept from this server. */
export type SecretsKept = { mailPassword: boolean; destinations: string[]; webhooks: number[] };

/** What is still to enter, with what each destination needs and each webhook's board. */
export type SecretsToEnter = {
	mailPassword: boolean;
	destinations: { name: string; type: string; needs: string }[];
	webhooks: { id: number; boardId: number; board: string | null }[];
};

/** `RestoreResult.secrets`: what the restore kept, and what is to enter. */
export type SecretsAccount = { kept: SecretsKept; toEnter: SecretsToEnter };

/** This server's secrets and what decides where each goes, read before a restore clears anything. */
export type SecretsHere = {
	mail: Record<(typeof MAIL_KEYS)[number], string | null>;
	destinations: Entry[];
	webhooks: { id: number; boardId: number; url: string; secret: string }[];
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

/** A name or a title as a sentence prints it: each control character, a line break above all, as a space. */
const printable = (text: string): string => text.replace(/[\x00-\x1f\x7f]/g, ' ');

const emptyKept = (): SecretsKept => ({ mailPassword: false, destinations: [], webhooks: [] });
const emptyToEnter = (): SecretsToEnter => ({ mailPassword: false, destinations: [], webhooks: [] });

// ─── What a destination lacks ────────────────────────────────────────────────

/**
 * Whether `destination` lacks the credentials it needs: an S3 one with no
 * secret, Google Drive OAuth without its client secret or its refresh token, a
 * service account whose JSON holds no private key, OneDrive with no client
 * secret; and, only where `sftp` is asked, SFTP with neither password nor key.
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
				: !has(serviceAccount(destination.serviceAccountJson)?.private_key);
		case 'onedrive':
			return !has(destination.clientSecret);
		default:
			return false;
	}
}

/** What a destination needs entered, as decision 5's sentence says it. */
function needs(destination: Entry): string {
	switch (destination.type) {
		case 'sftp':
			return 'SFTP: its password or private key';
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
 * which `createDestination` refuses as before.
 */
export function credentialsMissing(destination: unknown): string | null {
	if (!isEntry(destination) || !lacks(destination, false)) return null;
	return destination.type === 'gdrive' && isOauth(destination) ? GDRIVE_NOT_CONNECTED : CREDENTIALS_NOT_ENTERED;
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
 * cleared, and a service account's key, on every destination whatever its
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
		// The key out, the rest kept: `client_email` and `private_key_id` are
		// what a restore knows the same account by. JSON that cannot be read is
		// not known to hold no key, so it goes whole.
		const account = serviceAccount(destination.serviceAccountJson);
		cleared.serviceAccountJson = account
			? JSON.stringify('private_key' in account ? { ...account, private_key: '' } : account)
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
 * Throws, before it writes anything, when handed the running database (N1):
 * there it would delete the mail password and switch off every signed
 * webhook. A table that is not there is skipped; anything else that goes
 * wrong is thrown, for `withoutSecrets` to stop the backup with.
 */
export function clearSecrets(copy: Database.Database): void {
	if (isTheRunningDatabase(copy)) {
		throw new Error('The secrets are cleared from a backup’s copy only, never from the running database. Nothing was changed.');
	}
	const hasSettings = hasColumns(copy, 'settings', 'key', 'value');

	if (hasSettings) {
		copy.prepare("DELETE FROM settings WHERE key = 'smtp_pass'").run();
		// The key this server seals its backups with (S1): whoever held it could
		// seal a backup of their own making, and have this server fill it. And
		// any seal already in the copy, which `sealCopy` writes afresh.
		copy.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(BACKUP_SEAL_KEY, BACKUP_SEAL);
		const stored = settingOf(copy, 'backup_config');
		if (stored !== null) {
			const cleared = clearedConfig(stored);
			if (cleared === null) copy.prepare("DELETE FROM settings WHERE key = 'backup_config'").run();
			else if (cleared !== stored) copy.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(cleared);
		}
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
		).map((row) => ({ id: row.id, active: row.active !== 0 }));
		copy.prepare("UPDATE webhooks SET secret = '', active = 0 WHERE secret IS NOT NULL AND secret <> ''").run();
		entries = [...carried, ...signed].sort((a, b) => a.id - b.id);
	}
	if (hasSettings) {
		copy.prepare('DELETE FROM settings WHERE key = ?').run(WEBHOOK_SECRETS_LEFT_OUT_KEY);
		if (entries.length > 0) {
			copy.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(WEBHOOK_SECRETS_LEFT_OUT_KEY, JSON.stringify(entries));
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
 */
export function backupSealKey(live: Database.Database = sqlite): Buffer {
	const stored = settingOf(live, BACKUP_SEAL_KEY);
	if (stored !== null && HEX_32.test(stored)) return Buffer.from(stored, 'hex');
	const made = randomBytes(32).toString('hex');
	live
		.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
		.run(BACKUP_SEAL_KEY, made);
	return Buffer.from(made, 'hex');
}

/** This server's key as `live` holds it, or null where it has none yet. Reads, and writes nothing. */
export function sealKeyHere(live: Database.Database): string | null {
	const stored = settingOf(live, BACKUP_SEAL_KEY);
	return stored !== null && HEX_32.test(stored) ? stored : null;
}

/**
 * Put back, in `live`'s restored settings, this server's key as it was read
 * before the restore cleared them (`sealKeyHere`). A backup holds none, and
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
 * host, port, "Use SSL/TLS", user and password; every destination whole; each
 * webhook that has a secret, with its board and address. Read by
 * `restoreFromBackup` inside its transaction, before the first table is
 * cleared. A table or setting that is not there reads as none.
 */
export function readSecretsHere(live: Database.Database): SecretsHere {
	const mail = Object.fromEntries(MAIL_KEYS.map((key) => [key, settingOf(live, key)])) as SecretsHere['mail'];
	const webhooks = hasColumns(live, 'webhooks', 'id', 'board_id', 'url', 'secret')
		? (live
				.prepare("SELECT id, board_id AS boardId, url, secret FROM webhooks WHERE secret IS NOT NULL AND secret <> ''")
				.all() as SecretsHere['webhooks'])
		: [];
	return { mail, destinations: destinationsIn(settingOf(live, 'backup_config')), webhooks };
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
	webhooks: []
});

/** A field as it is compared: as stored, a missing one and a null alike. */
const asStored = (value: unknown) => (value === undefined ? null : value);

/** A host as it is compared: trimmed, in any case. */
const asHost = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : asStored(value));

/** Whether `here` is the same account and the same place as `restored`, in every field that is not secret (R1). */
function sameAccount(restored: Entry, here: Entry): boolean {
	if (here.type !== restored.type) return false;
	const same = (fields: readonly string[]) =>
		fields.every((field) => {
			if (field === 'host') return asHost(restored[field]) === asHost(here[field]);
			// A missing endpoint and an empty one alike: both are AWS.
			if (field === 'endpoint') return (asStored(restored[field]) ?? '') === (asStored(here[field]) ?? '');
			return asStored(restored[field]) === asStored(here[field]);
		});
	switch (restored.type) {
		case 'sftp':
			return same(SAME_IN.sftp);
		case 's3':
			return same(SAME_IN.s3);
		case 'onedrive':
			return same(SAME_IN.onedrive);
		case 'gdrive': {
			if (isOauth(restored)) return same(SAME_IN.gdriveOauth);
			// A service account is known by its JSON's address and key id, the
			// key itself excepted. The restored JSON must name an address.
			const ours = serviceAccount(restored.serviceAccountJson);
			const theirs = serviceAccount(here.serviceAccountJson);
			return (
				same(SAME_IN.gdriveServiceAccount) &&
				ours !== null &&
				theirs !== null &&
				typeof ours.client_email === 'string' &&
				ours.client_email !== '' &&
				ours.client_email === theirs.client_email &&
				asStored(ours.private_key_id) === asStored(theirs.private_key_id)
			);
		}
		default:
			return false;
	}
}

/** `restored` with the secrets of `here` in it: a service account's JSON is taken whole. */
function withSecretsOf(restored: Entry, here: Entry): Entry {
	const filled: Entry = { ...restored };
	if (restored.type === 'gdrive' && !isOauth(restored)) {
		filled.serviceAccountJson = here.serviceAccountJson;
		return filled;
	}
	for (const field of SECRET_FIELDS[restored.type as string]) {
		if (field in here) filled[field] = here[field];
	}
	return filled;
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
 *     user and hold no password, and host (trimmed, any case), port, "Use
 *     SSL/TLS" and user are all this server's;
 *   - a destination that lacks its credentials (SFTP: neither password nor
 *     key), from the one destination here of its type that is the same in
 *     every field that is not secret. None, or more than one: not filled. A
 *     Google Drive OAuth destination is filled only when both its client
 *     secret and its refresh token are empty, and then both are taken; an
 *     SFTP one whose match here has neither either is as it is here;
 *   - a webhook `listed` in the backup's marker that has no secret, from the
 *     webhook here with the same id, board and address, switched on or off as
 *     the marker says it was. One with a secret in the backup is left as it is.
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
	options: { writeMarker: boolean }
): { kept: SecretsKept; unfilled: SecretsToEnter; listedOnLeftOff: number } {
	const kept = emptyKept();
	const unfilled = emptyToEnter();
	let listedOnLeftOff = 0;
	const hasSettings = hasColumns(live, 'settings', 'key', 'value');

	// The mail password.
	if (hasSettings) {
		const restored = Object.fromEntries(MAIL_KEYS.map((key) => [key, settingOf(live, key)])) as SecretsHere['mail'];
		if (has(restored.smtp_host) && has(restored.smtp_user) && !has(restored.smtp_pass)) {
			const same =
				asHost(restored.smtp_host) === asHost(here.mail.smtp_host) &&
				restored.smtp_port === here.mail.smtp_port &&
				restored.smtp_secure === here.mail.smtp_secure &&
				restored.smtp_user === here.mail.smtp_user;
			if (same && has(here.mail.smtp_pass)) {
				live.prepare("DELETE FROM settings WHERE key = 'smtp_pass'").run();
				live.prepare("INSERT INTO settings (key, value) VALUES ('smtp_pass', ?)").run(here.mail.smtp_pass);
				kept.mailPassword = true;
			} else {
				unfilled.mailPassword = true;
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
		const destinations = (config.destinations as unknown[]).map((destination) => {
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
			const matches = here.destinations.filter((candidate) => sameAccount(destination, candidate));
			if (matches.length !== 1) return listIt();
			const match = matches[0];
			// An SFTP destination with neither here either is as it is here.
			if (destination.type === 'sftp' && lacks(match, true)) return destination;
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
		const find = live.prepare('SELECT id, board_id AS boardId, url, secret, active FROM webhooks WHERE id = ?');
		const fill = live.prepare('UPDATE webhooks SET secret = ?, active = ? WHERE id = ?');
		for (const entry of listed) {
			const row = find.get(entry.id) as { id: number; boardId: number; url: string; secret: string | null; active: number } | undefined;
			if (!row || has(row.secret)) continue;
			const match = here.webhooks.find((hook) => hook.id === row.id && hook.boardId === row.boardId && hook.url === row.url);
			if (match) {
				// On or off as the marker says it was. The marker is the backup's
				// word, but `here` holds anything only for a backup whose seal
				// verified (S1): one this server made, whose marker this server
				// wrote, and nobody changed since.
				fill.run(match.secret, entry.active ? 1 : 0, row.id);
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

	return { kept, unfilled, listedOnLeftOff };
}

// ─── What is still to enter ──────────────────────────────────────────────────

/**
 * What `database` still lacks, as the start-up line says it (decision 7): the
 * mail settings name a host and a user and hold no password; a destination
 * lacks its credentials (`credentialsMissing`'s rule, so not an SFTP one); a
 * webhook its own marker lists is still there, off and with no secret. What
 * in the marker could not be read is in `problems`. Reads, and writes nothing.
 */
export function secretsToEnter(database: Database.Database): { toEnter: SecretsToEnter; problems: string[] } {
	const toEnter = emptyToEnter();
	toEnter.mailPassword =
		has(settingOf(database, 'smtp_host')) && has(settingOf(database, 'smtp_user')) && !has(settingOf(database, 'smtp_pass'));
	for (const destination of destinationsIn(settingOf(database, 'backup_config'))) {
		if (credentialsMissing(destination) !== null) {
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
	return { toEnter, problems };
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
	if (toEnter.mailPassword) parts.push('the mail password (Admin, 📧 Email / SMTP)');
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
	if (parts.length === 0) return null;
	const said = `To enter again, because a backup does not hold them: ${parts.join('; ')}.`;
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
