/**
 * stored-secrets.ts — the secrets the server keeps in its database, sealed at
 * rest (card 2898).
 *
 * Seven things in the database are secrets the server must read back to use:
 * the mail password (`settings.smtp_pass`), every backup destination's
 * credentials (the secret fields of `settings.backup_config`, and a Google
 * service account's `private_key` inside its JSON), every webhook's signing
 * secret (`webhooks.secret`), and three signing keys (`known_browser_secret`,
 * `request_form_secret`, `backup_seal_key`). Each is stored sealed, in place,
 * as a text envelope in the column or JSON field it always lived in:
 *
 *     dfsealed:1:<key id>:<nonce>:<ciphertext>
 *
 * AES-256-GCM (`sealWith` / `openSealed`, mfa-crypto.ts) under `secretsKey`,
 * a key derived from the MFA key file for this purpose alone (mfa-key.ts), a
 * nonce of 12 random bytes for every seal and a 16-byte tag. The plaintext is
 * padded to 64-byte buckets (0x80, then zeros) before it is sealed, so that a
 * ciphertext's length does not tell a password's (S17).
 *
 * Each seal is bound by its additional data to where it is used, so that a
 * value copied elsewhere does not open: the mail password to the mail
 * connection (host, port, user and the way out), a destination's secret to
 * its field and its place (and an SFTP destination's confirmed host key), a
 * webhook's secret to its id, board and address, a signing key to its
 * setting's name. The fields are frozen here as versioned constants and
 * encoded as canonical JSON (S8, decision 25): they are the restore's and a
 * masked save's own match rules (`mailConnection`, `destinationPlace` and
 * `SAME_IN` in backup-secrets.ts) as they stand at version 1, read by
 * normalisers of their own here, so that a later change to those rules cannot
 * change the additional data without a new version and a re-seal at start.
 *
 * `openStored` answers one of four: `empty`, `plain` (a value from before
 * this card, used as it is until the next start seals it, decision 7),
 * `opened`, or `unopenable` (another key, other additional data, a changed
 * byte, a bad padding, or text that begins as an envelope and is not one).
 * An unopenable value is never used as a value (decision 9). Nothing opened
 * is cached here, a webhook's address included (card 2928, R13).
 *
 * Since card 2928 every webhook's address (`webhooks.url`) is sealed too, in
 * place, bound to the webhook's id, board and the plain `receiver` beside it
 * (`webhookUrlAad`, `openedUrl`): a Slack, Teams or Discord address holds its
 * secret in its path. Its secret stays bound to the address as opened.
 *
 * Every write of a sealed value records the key check in the same
 * transaction (`recordKeyCheck`, S2's one rule). Nothing here opens a
 * transaction, and nothing here writes a log line: the callers do both.
 *
 * Imports nothing from backup-secrets.ts, email.ts or webhooks.ts, which all
 * import this: no cycle. The service account rule is service-account-json.ts,
 * a leaf (card 2939).
 */
import type Database from 'better-sqlite3';
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { sqlite } from './db';
import { MFA_KEY_CHECK_SETTING, currentMfaKey, type MfaKey, type StoredAtStart } from './mfa-key';
import { openSealed, sealWith } from './mfa-crypto';
import { confirmedHostKey } from './ssh-host-key';
import { normalisedServiceAccount, type ServiceAccountChange } from './service-account-json';
import { receiverOf } from './webhook-address';

// ─── The envelope ────────────────────────────────────────────────────────────

/** What every sealed value begins with, before its form's number. */
export const SEALED_MARK = 'dfsealed:';

/** The envelope of form 1, exactly: key id, a 12-byte nonce and a ciphertext, each strict (S9). */
const ENVELOPE = /^dfsealed:1:([0-9a-f]{16}):([A-Za-z0-9+/]{16}):([A-Za-z0-9+/]+={0,2})$/;

/** Whether `value` is a sealed value of form 1: the strict pattern, nothing near it. */
export function isSealed(value: unknown): value is string {
	return typeof value === 'string' && ENVELOPE.test(value);
}

/**
 * Whether a secret as typed looks sealed: it begins `dfsealed:` (S9). No
 * secret anyone uses has that form, and one that did could be taken for a
 * sealed value, so every route a secret is typed into refuses it 400.
 */
export function looksSealed(value: unknown): value is string {
	return typeof value === 'string' && value.startsWith(SEALED_MARK);
}

/** The bucket a plaintext is padded to (S17). */
const BUCKET = 64;

function padded(plain: string): Buffer {
	const text = Buffer.from(plain, 'utf8');
	const out = Buffer.alloc((Math.floor(text.length / BUCKET) + 1) * BUCKET);
	text.copy(out);
	out[text.length] = 0x80;
	text.fill(0);
	return out;
}

/** The text inside a padded plaintext, or null for a padding that is not 0x80 then zeros. Zeroes `opened`. */
function unpadded(opened: Buffer): string | null {
	try {
		if (opened.length === 0 || opened.length % BUCKET !== 0) return null;
		let end = opened.length - 1;
		while (end >= 0 && opened[end] === 0) end--;
		if (end < 0 || opened[end] !== 0x80) return null;
		return opened.subarray(0, end).toString('utf8');
	} finally {
		opened.fill(0);
	}
}

/** The key the stored secrets are sealed with: the file's key with `secretsKey` in the AES key's place. */
const sealingKey = (key: MfaKey): MfaKey => ({ ...key, encryptionKey: key.secretsKey });

/**
 * `plain` sealed under `key`, bound to `aad`, as an envelope: no key check is
 * recorded. For a caller that records it itself in the same transaction (the
 * start's sweep, a restore). `seal` is a seam for the start's tests.
 */
export function sealValue(plain: string, aad: string, key: MfaKey, seal: typeof sealWith = sealWith): string {
	if (looksSealed(plain)) throw new Error('A value that is already sealed is not sealed again.');
	const body = padded(plain);
	try {
		const sealed = seal(sealingKey(key), body, aad);
		return `${SEALED_MARK}1:${sealed.keyId}:${sealed.nonce}:${sealed.ciphertext}`;
	} finally {
		body.fill(0);
	}
}

/**
 * Seal `plain` for storing, bound to `aad`, under `key` (this server's), and
 * record the key check in `database` by the one rule (`recordKeyCheck`). ''
 * is '' (E6). Throws on a value that is already sealed (S9) and when no key
 * is loaded (E9): nothing is then written.
 */
export function sealStored(plain: string, aad: string, database: Database.Database = sqlite, key: MfaKey | null = currentMfaKey()): string {
	if (plain === '') return '';
	if (key === null) throw new Error('No MFA key is loaded, so no secret can be stored sealed.');
	const sealed = sealValue(plain, aad, key);
	recordKeyCheck(database, key);
	return sealed;
}

/** A stored value read: what kind it is, and the value to use ('' for empty and unopenable). */
export type Opened = { kind: 'empty' | 'plain' | 'opened' | 'unopenable'; value: string };

/** The text `envelope` opens to under `key` with `aad`, or null. */
function openWith(key: MfaKey, envelope: string, aad: string): string | null {
	const parts = ENVELOPE.exec(envelope);
	if (parts === null || parts[1] !== key.id) return null;
	const opened = openSealed(sealingKey(key), { nonce: parts[2], ciphertext: parts[3] }, aad);
	return opened === null ? null : unpadded(opened);
}

/**
 * A stored value as it is to be used: '' or none is `empty`; a value with no
 * envelope is `plain`, as it is (decision 7); an envelope that opens with
 * `key` and `aad` is `opened`; anything else that begins `dfsealed:` is
 * `unopenable`, its value '' (decision 9). Nothing is thrown.
 */
export function openStored(value: string | null | undefined, aad: string, key: MfaKey | null = currentMfaKey()): Opened {
	if (value === null || value === undefined || value === '') return { kind: 'empty', value: '' };
	if (!looksSealed(value)) return { kind: 'plain', value };
	const opened = key === null ? null : openWith(key, value, aad);
	return opened === null ? { kind: 'unopenable', value: '' } : { kind: 'opened', value: opened };
}

// ─── The key check: the one rule (S2, decision 11) ───────────────────────────

const tableColumns = (database: Database.Database, table: string): string[] =>
	(database.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((column) => column.name);

const hasColumns = (database: Database.Database, table: string, ...columns: string[]) => {
	const present = tableColumns(database, table);
	return columns.every((column) => present.includes(column));
};

/** The key check `database` stores, or null. */
function storedCheckIn(database: Database.Database): string | null {
	if (!hasColumns(database, 'settings', 'key', 'value')) return null;
	const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(MFA_KEY_CHECK_SETTING) as { value: string | null } | undefined;
	return row?.value ?? null;
}

/**
 * SQL that is true where `column` begins `dfsealed:`, in that case exactly,
 * as `looksSealed` reads it (the code review's S2): `LIKE` takes ASCII
 * letters in any case, so a plain `DFSEALED:…` was taken for sealed.
 */
const SEALED_SQL = (column: string) => `substr(${column}, 1, 9) = 'dfsealed:'`;

/**
 * Whether anything in `database` is sealed under some MFA key: a second
 * factor, or a stored secret (anything that begins `dfsealed:`, an envelope
 * that does not read included). A backup configuration is read as JSON and
 * only its secret fields asked, so that a name or a path holding the text is
 * not taken for one (S2).
 */
export function anythingSealed(database: Database.Database): boolean {
	if (hasColumns(database, 'mfa_factors', 'id') && database.prepare('SELECT 1 FROM mfa_factors LIMIT 1').get() !== undefined) return true;
	if (hasColumns(database, 'settings', 'key', 'value')) {
		const sealedSetting = database
			.prepare(`SELECT 1 FROM settings WHERE key IN (${STORED_SETTINGS.map(() => '?').join(', ')}) AND ${SEALED_SQL('value')} LIMIT 1`)
			.get(...STORED_SETTINGS);
		if (sealedSetting !== undefined) return true;
		const config = configIn(database);
		if (config !== null && Array.isArray(config.destinations)) {
			for (const destination of config.destinations) {
				if (isEntry(destination) && secretFieldsOf(destination).some(({ value }) => looksSealed(value))) return true;
			}
		}
	}
	// A webhook's secret, or its address (card 2928).
	return (
		hasColumns(database, 'webhooks', 'secret', 'url') &&
		database.prepare(`SELECT 1 FROM webhooks WHERE ${SEALED_SQL('secret')} OR ${SEALED_SQL('url')} LIMIT 1`).get() !== undefined
	);
}

/** What `recordKeyCheck` throws: another key's check is stored, and something is sealed under it. */
export class KeyCheckMismatch extends Error {
	constructor() {
		super("The stored MFA key check does not match this server's key, and something is sealed under it; nothing was written.");
		this.name = 'KeyCheckMismatch';
	}
}

/**
 * The one rule of decision 11 (S2), for whatever writes a sealed value, in
 * its transaction: no check stored, `key`'s is recorded; another key's while
 * anything is sealed is a throw, nothing written; another key's while nothing
 * is sealed is replaced (the existing T35 rule). Called before the sealed
 * value is written, so "anything sealed" is what was there before it.
 */
export function recordKeyCheck(database: Database.Database, key: MfaKey): void {
	if (!hasColumns(database, 'settings', 'key', 'value')) return;
	const stored = storedCheckIn(database);
	if (stored === key.check) return;
	if (stored !== null && anythingSealed(database)) throw new KeyCheckMismatch();
	database
		.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
		.run(MFA_KEY_CHECK_SETTING, key.check);
}

// ─── The additional data, frozen (S8, decision 25) ──────────────────────────

/**
 * The additional data's form. A change to any list below is a new version, and
 * every value sealed again at start. One exception, which changes no value
 * stored (card 2941, ruling R2): a field appended only when it is a non-empty
 * text, as OneDrive's `drive` (`ONEDRIVE_DRIVE_FIELD`), leaves the additional
 * data of every value stored without it as it was, byte for byte.
 */
export const AAD_VERSION = 1;

/**
 * The mail connection a password is bound to: `mailConnection`'s fields in
 * backup-secrets.ts (R1's mail rule) at version 1.
 */
export const MAIL_CONNECTION_FIELDS = ['host', 'port', 'user', 'allowInsecure'] as const;

/**
 * A destination's place, by type: `SAME_IN` in backup-secrets.ts, less
 * `name`, at version 1 (`destinationPlace`). A rename keeps a secret; any
 * other change of place does not.
 */
export const DESTINATION_PLACE_FIELDS = {
	sftp: ['host', 'port', 'username', 'remotePath'],
	s3: ['region', 'bucket', 'prefix', 'endpoint', 'accessKeyId'],
	gdriveOauth: ['authMethod', 'folderId', 'clientId'],
	gdriveServiceAccount: ['authMethod', 'folderId'],
	onedrive: ['tenantId', 'clientId', 'folderPath']
} as const;

/**
 * A OneDrive destination's user or drive ID (card 2941): appended to its place,
 * as stored, only when it is a non-empty text, by its own frozen copy of
 * `driveSet`'s test (onedrive-address.ts, which `destinationPlace` in
 * backup-secrets.ts asks; ruling R2). Frozen with the lists above, so that a
 * later change to `driveSet` cannot change the additional data: an entry
 * without it keeps its version 1 additional data.
 */
export const ONEDRIVE_DRIVE_FIELD = 'drive';

/** A webhook's secret is bound to these (S10): `url` as opened, never as stored (card 2928). */
export const WEBHOOK_FIELDS = ['id', 'boardId', 'url'] as const;

/** A webhook's address is bound to these (card 2928): its row, its board and the plain `receiver` beside it. */
export const WEBHOOK_URL_FIELDS = ['id', 'boardId', 'receiver'] as const;

/** The settings a stored secret is kept in, beside `backup_config`. Their names are the modules' own (email.ts, known-browsers.ts, request-tokens.ts, backup-secrets.ts). */
const MAIL_PASSWORD = 'smtp_pass';
/** The stored mail settings the password is bound to (`mailPasswordAad` reads them): the one list (the code review's E10). */
export const MAIL_CONNECTION_SETTINGS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_allow_insecure'] as const;
/** The stored mail settings the password is bound to, read from `database`, each null where it is not there. */
export function mailConnectionIn(database: Database.Database): Record<string, string | null> {
	return Object.fromEntries(MAIL_CONNECTION_SETTINGS.map((name) => [name, settingIn(database, name)]));
}
/**
 * The key the restore's match of a webhook address a backup left out is made
 * with (card 2928, R14): 32 random bytes as hex, a signing key like the
 * others, so stored sealed, sealed again at a key change, replaced when it does
 * not open and forgotten with the rest; in no backup, export or safety copy,
 * and kept across a restore.
 */
export const WEBHOOK_ADDRESS_MAC_KEY = 'webhook_address_mac_key';
export const SIGNING_KEY_SETTINGS = ['known_browser_secret', 'request_form_secret', 'backup_seal_key', WEBHOOK_ADDRESS_MAC_KEY] as const;
const STORED_SETTINGS: readonly string[] = [MAIL_PASSWORD, ...SIGNING_KEY_SETTINGS];

// ─── The signing keys' form (card 2943) ─────────────────────────────────────

/** backup-secrets.ts's `BACKUP_SEAL_KEY`: imports run the other way. */
const SEAL_KEY_SETTING = 'backup_seal_key';

/**
 * The signing keys whose stored text says its form, inside the seal (card
 * 2943, R1 and R8): `v2:` and 64 lower-case hex. Each was stored in plain
 * before card 2898, so every copy of the database made before then holds it;
 * one of any other form is never sealed in place, and is replaced at start
 * (`replaceSigningKeysAtStart`). The form is inside the envelope, bound to the
 * setting's name as before, so nobody without the MFA key can write a key of
 * it: the decision rests on nothing a row written by hand can forge.
 */
export const V2_SIGNING_KEYS = ['known_browser_secret', 'request_form_secret', SEAL_KEY_SETTING] as const;

/** A signing key's stored text of the current form, the 64 hex captured. */
const V2_TEXT = /^v2:([0-9a-f]{64})$/;

/** Whether `setting` is one of `V2_SIGNING_KEYS`. */
const isV2Setting = (setting: string): boolean => (V2_SIGNING_KEYS as readonly string[]).includes(setting);

/** A new signing key's text, as it is sealed (card 2943): `v2:` and 32 random bytes as hex. */
export function newSigningKeyText(): string {
	return `v2:${randomBytes(32).toString('hex')}`;
}

/** The 64 hex of a signing key read by `openStored`, where it opened and is of the current form; null for anything else, a key in plain included (R2). */
export function currentSigningKeyHex(opened: Opened): string | null {
	return opened.kind === 'opened' ? (V2_TEXT.exec(opened.value)?.[1] ?? null) : null;
}

/**
 * When this server's backup seal key was made (card 2943): an ISO time,
 * written by every writer of the key (R4). Information only, never an input
 * to whether the key is kept (R1); deleted from every copy (`clearSecrets`),
 * never brought in by a restore and kept by one only beside the key it keeps
 * (R3), and forgotten with the key.
 */
export const BACKUP_SEAL_KEY_MADE_AT = 'backup_seal_key_made_at';

/** Record, in `database`, that its backup seal key was made now (R4). Opens no transaction. */
export function recordSealKeyMade(database: Database.Database): void {
	database
		.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
		.run(BACKUP_SEAL_KEY_MADE_AT, new Date().toISOString());
}
const BACKUP_CONFIG = 'backup_config';
/** backup-secrets.ts's `WEBHOOK_SECRETS_LEFT_OUT_KEY`. */
const WEBHOOK_SECRETS_LEFT_OUT = 'webhook_secrets_left_out';

const aadOf = (kind: string, ...values: unknown[]) => JSON.stringify([AAD_VERSION, kind, ...values]);

/** A host as the rules compare it: ASCII spaces and tabs off either end, ASCII letters in lower case (backup-secrets.ts `hostAsCompared`). */
function hostAsCompared(host: string): string {
	let start = 0;
	let end = host.length;
	while (start < end && (host[start] === ' ' || host[start] === '\t')) start++;
	while (end > start && (host[end - 1] === ' ' || host[end - 1] === '\t')) end--;
	return host.slice(start, end).replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/**
 * The additional data of the mail password: the mail connection as the
 * mailer reads it (`mailConnection`'s rule), from stored settings
 * (`smtp_host` and the rest) or as a save reads them (`host` and the rest).
 */
export function mailPasswordAad(values: Partial<Record<string, unknown>>): string {
	const host = values.host ?? values.smtp_host;
	const user = values.user ?? values.smtp_user;
	const allowInsecure = values.allowInsecure ?? values.smtp_allow_insecure;
	const connection = {
		host: typeof host === 'string' ? hostAsCompared(host) : '',
		port: Number((values.port ?? values.smtp_port) || 587),
		user: typeof user === 'string' ? user : '',
		allowInsecure: allowInsecure === true || allowInsecure === 'true'
	};
	return aadOf('mail-password', ...MAIL_CONNECTION_FIELDS.map((field) => connection[field]));
}

type Entry = Record<string, unknown>;
const isEntry = (value: unknown): value is Entry => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A field of a destination as the place compares it (backup-secrets.ts `inUse`, version 1). */
function placeValue(destination: Entry, field: string): unknown {
	const value = destination[field];
	const empty = value === undefined || value === null || value === '';
	switch (field) {
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

/** A service account's JSON read, or null for none, or for text that is not a JSON object. */
function serviceAccountOf(json: unknown): Entry | null {
	if (typeof json !== 'string' || json === '') return null;
	try {
		const parsed = JSON.parse(json);
		return isEntry(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** The place fields of `destination`'s type, version 1; none for a type this version does not know. */
function placeFields(destination: Entry): readonly string[] {
	switch (destination.type) {
		case 'sftp':
			return DESTINATION_PLACE_FIELDS.sftp;
		case 's3':
			return DESTINATION_PLACE_FIELDS.s3;
		case 'onedrive':
			return DESTINATION_PLACE_FIELDS.onedrive;
		case 'gdrive':
			return destination.authMethod === 'oauth' ? DESTINATION_PLACE_FIELDS.gdriveOauth : DESTINATION_PLACE_FIELDS.gdriveServiceAccount;
		default:
			return [];
	}
}

/**
 * The additional data of a destination's secret `field`: the field, the
 * destination's type and place (`destinationPlace`'s rule: never its name),
 * a service account's `client_email` and `private_key_id`, and for SFTP its
 * confirmed host key's fingerprint ('' for none). A service account's key is
 * the field `serviceAccountJson.private_key`. A OneDrive destination's `drive`
 * is the place's last field where it is set (card 2941).
 */
export function destinationSecretAad(destination: unknown, field: string): string {
	const entry = isEntry(destination) ? destination : {};
	const type = entry.type === undefined ? null : entry.type;
	const place = placeFields(entry).map((name) => placeValue(entry, name));
	// Only when set, as stored (`ONEDRIVE_DRIVE_FIELD`, card 2941, ruling R2).
	const drive = entry[ONEDRIVE_DRIVE_FIELD];
	if (entry.type === 'onedrive' && typeof drive === 'string' && drive !== '') place.push(drive);
	let account: unknown = null;
	if (entry.type === 'gdrive' && entry.authMethod !== 'oauth') {
		const parsed = serviceAccountOf(entry.serviceAccountJson);
		account = parsed === null ? null : [parsed.client_email ?? null, parsed.private_key_id ?? null];
	}
	const hostKey = entry.type === 'sftp' ? (confirmedHostKey(entry.hostKey)?.fingerprint ?? '') : null;
	return aadOf('destination-secret', field, type, place, account, hostKey);
}

/** The additional data of a webhook's secret (S10). */
export function webhookSecretAad(id: number, boardId: number, url: string): string {
	return aadOf('webhook-secret', id, boardId, url);
}

/** The additional data of a webhook's address (card 2928): its id, its board and its stored `receiver`. */
export function webhookUrlAad(id: number, boardId: number, receiver: string): string {
	return aadOf('webhook-url', id, boardId, receiver);
}

/** A webhook row as its address is read: the address as stored, and what it is bound to. */
export type AddressRow = { id: number; boardId: number; url: string; receiver: string };

/**
 * A webhook's address as it is to be used (card 2928): `empty` for '' (a
 * backup left it out), `plain` for one not yet sealed (used as it is, card
 * 2898 decision 7), `opened`, or `unopenable` with '' (another key, a changed
 * byte, a hand-edited `receiver`). Opened every time it is needed, never
 * cached. Never logged: a line names the webhook and its `receiver`'s host.
 */
export function openedUrl(row: AddressRow, key: MfaKey | null = currentMfaKey()): Opened {
	return openStored(row.url, webhookUrlAad(row.id, row.boardId, row.receiver), key);
}

/**
 * The text a webhook's secret is bound to (card 2928): its address as it is
 * when plain, as opened with the first of `keys` that opens it when sealed,
 * and null when it is '' or opens with none, when no secret may be sealed or
 * opened against it (R5).
 */
export function addressToBind(row: AddressRow, keys: readonly (MfaKey | null)[] = [currentMfaKey()]): string | null {
	if (row.url === '') return null;
	if (!looksSealed(row.url)) return row.url;
	for (const key of keys) {
		if (key === null) continue;
		const opened = openedUrl(row, key);
		if (opened.kind === 'opened') return opened.value;
	}
	return null;
}

/** `receiver` where `database`'s webhooks have the column (migration 0073), else '' for every row. */
export const receiverColumn = (database: Database.Database) => (hasColumns(database, 'webhooks', 'receiver') ? 'receiver' : "''");

/** The additional data of a signing key kept in `settings` under `key`. */
export function settingAad(key: string): string {
	return aadOf('setting', key);
}

// ─── Destinations ────────────────────────────────────────────────────────────

/**
 * Every type's secret fields together: backup-secrets.ts's `ANY_SECRET_FIELD`
 * (`SECRET_FIELDS`), sealed on every entry, a type this version does not know
 * included (S12, E7).
 */
export const DESTINATION_SECRET_FIELDS = ['password', 'privateKey', 'secretAccessKey', 'clientSecret', 'refreshToken'] as const;

/** The keys of a service account's JSON that hold its private key: both are masked by the GET, and both are sealed. */
const ACCOUNT_KEY_FIELDS = ['private_key', 'privateKey'] as const;

/** A service account JSON that is not a JSON object is addressed whole, by this name; a key inside one by this name, a dot and its key's. */
const WHOLE_ACCOUNT = 'serviceAccountJson';
const ACCOUNT_PREFIX = `${WHOLE_ACCOUNT}.`;
const accountField = (name: string) => `${ACCOUNT_PREFIX}${name}`;

/**
 * Every secret field of a destination that holds text, by its address: the
 * one visitor every reader and writer of them goes through (the code
 * review's E10). Each of `DESTINATION_SECRET_FIELDS`; a service account JSON
 * that is not a JSON object, whole (`serviceAccountJson`, a sealed one
 * included); and each key inside one that is (`serviceAccountJson.private_key`,
 * `serviceAccountJson.privateKey`).
 */
export function secretFieldsOf(destination: Entry): { field: string; value: string }[] {
	const found: { field: string; value: string }[] = [];
	const holds = (value: unknown): value is string => typeof value === 'string' && value !== '';
	for (const field of DESTINATION_SECRET_FIELDS) {
		const value = destination[field];
		if (holds(value)) found.push({ field, value });
	}
	const json = destination.serviceAccountJson;
	if (holds(json)) {
		const account = serviceAccountOf(json);
		if (account === null) found.push({ field: WHOLE_ACCOUNT, value: json });
		else {
			for (const name of ACCOUNT_KEY_FIELDS) {
				const value = account[name];
				if (holds(value)) found.push({ field: accountField(name), value });
			}
		}
	}
	return found;
}

/** The text at `field` of `destination`, by the visitor's addresses; '' for none. */
export function secretFieldValue(destination: Entry, field: string): string {
	const value = field.startsWith(ACCOUNT_PREFIX)
		? serviceAccountOf(destination.serviceAccountJson)?.[field.slice(ACCOUNT_PREFIX.length)]
		: destination[field];
	return typeof value === 'string' ? value : '';
}

/** `destination` with `value` at `field`, by the visitor's addresses: a key inside a service account's JSON is written into it. */
export function withSecretField(destination: Entry, field: string, value: string): Entry {
	if (!field.startsWith(ACCOUNT_PREFIX)) return { ...destination, [field]: value };
	const account = serviceAccountOf(destination.serviceAccountJson) ?? {};
	return { ...destination, serviceAccountJson: JSON.stringify({ ...account, [field.slice(ACCOUNT_PREFIX.length)]: value }) };
}

/** The fields of a destination, as `openDestinationSecrets` gives it, whose stored value did not open (S3). */
export function unopenableFields(destination: unknown): string[] {
	if (!isEntry(destination) || !Array.isArray(destination.unopenable)) return [];
	return destination.unopenable.filter((field): field is string => typeof field === 'string');
}

/** The envelopes, as stored, of a destination's fields that did not open (the code review's E2), by field. */
function unopenableAsStored(destination: Entry): Record<string, string> {
	const held = destination.unopenableAsStored;
	return isEntry(held) ? (Object.fromEntries(Object.entries(held).filter(([, value]) => looksSealed(value))) as Record<string, string>) : {};
}

/**
 * Each destination of a backup configuration with its secrets opened, for
 * use: a sealed field that opens is its value, one that does not is '' and
 * named in the destination's `unopenable`, its envelope kept as it is stored
 * in `unopenableAsStored` (both present only where there is one, S3, E2), so
 * that a save that does not type it again keeps it; a plain field is as it is
 * (decision 7). A service account's JSON keeps its other fields. Anything not
 * an object is as it is. Neither carrier ever reaches a row or an answer.
 */
export function openDestinationSecrets<T>(config: T, key: MfaKey | null = currentMfaKey()): T {
	if (!isEntry(config) || !Array.isArray(config.destinations)) return config;
	const destinations = config.destinations.map((destination: unknown) => {
		if (!isEntry(destination)) return destination;
		let opened = withoutUnopenable(destination);
		const unopenable: string[] = [];
		const asStored: Record<string, string> = {};
		for (const { field, value } of secretFieldsOf(destination)) {
			if (!looksSealed(value)) continue;
			const read = openStored(value, destinationSecretAad(destination, field), key);
			opened = withSecretField(opened, field, read.value);
			if (read.kind === 'unopenable') {
				unopenable.push(field);
				asStored[field] = value;
			}
		}
		return unopenable.length > 0 ? { ...opened, unopenable, unopenableAsStored: asStored } : opened;
	});
	return { ...config, destinations } as T;
}

/**
 * One destination with every secret in it sealed by `seal(plain, aad)`, by the
 * visitor: each secret field holding text, a service account's key inside its
 * JSON, and a service account JSON that is not a JSON object whole (it is not
 * known to hold no key). A field that did not open and was not typed again
 * (still '', with its envelope carried) keeps its envelope as it is stored
 * (the code review's E2); the carriers are dropped. `skipSealed` leaves a
 * value already sealed as it is (the start's sweep); otherwise it is handed to
 * `seal`, which refuses it. Answers the destination and how many fields were
 * sealed.
 */
function sealedDestination(
	destination: Entry,
	seal: (plain: string, aad: string) => string,
	skipSealed: boolean,
	boundTo: Entry = destination
): { destination: Entry; count: number } {
	let out: Entry = withoutUnopenable(destination);
	const kept = unopenableAsStored(destination);
	for (const field of unopenableFields(destination)) {
		if (kept[field] !== undefined && secretFieldValue(destination, field) === '') out = withSecretField(out, field, kept[field]);
	}
	let count = 0;
	for (const { field, value } of secretFieldsOf(destination)) {
		if (skipSealed && looksSealed(value)) continue;
		out = withSecretField(out, field, seal(value, destinationSecretAad(boundTo, field)));
		count++;
	}
	return { destination: out, count };
}

/**
 * A backup configuration as it is stored: every destination's secrets sealed
 * under this server's key, the key check recorded in `database`
 * (`sealStored`), a field that did not open and was not typed again kept as
 * it is stored, and the carriers dropped. Throws on a value typed that is
 * already sealed (S9).
 */
export function sealDestinationSecrets<T>(config: T, database: Database.Database = sqlite, key: MfaKey | null = currentMfaKey()): T {
	if (!isEntry(config) || !Array.isArray(config.destinations)) return config;
	const destinations = config.destinations.map((destination: unknown) =>
		isEntry(destination) ? sealedDestination(destination, (plain, aad) => sealStored(plain, aad, database, key), false).destination : destination
	);
	return { ...config, destinations } as T;
}

/** A destination as it is shown or compared, without `openDestinationSecrets`' carriers, `unopenable` and `unopenableAsStored`. */
export function withoutUnopenable<T>(destination: T): T {
	if (!isEntry(destination) || (!('unopenable' in destination) && !('unopenableAsStored' in destination))) return destination;
	const { unopenable: _unopenable, unopenableAsStored: _asStored, ...rest } = destination;
	return rest as T;
}

/**
 * A destination as the GET shows it before masking (E2): each field whose
 * stored value does not open shown as `mask`, as a secret that is stored, so
 * that the page sends it back masked and a save keeps it (it is still to be
 * typed again: no backup goes to it until then); the carriers dropped.
 */
export function withUnopenableMasked<T>(destination: T, mask: string): T {
	if (!isEntry(destination)) return destination;
	let shown: Entry = withoutUnopenable(destination);
	for (const field of unopenableFields(destination)) shown = withSecretField(shown, field, mask);
	return shown as T;
}

/**
 * `kept`, a destination a save or a test keeps masked secrets into from
 * `stored` (`keepMaskedSecrets`), given the carriers of each stored field that
 * did not open and was sent masked (`masked`, a whole service account JSON
 * naming each key in it), so that a save keeps its envelope (E2).
 */
export function withUnopenableCarried(kept: Entry, stored: Entry, masked: readonly string[]): Entry {
	const fields = unopenableFields(stored).filter((field) => masked.includes(field) || (field.startsWith(WHOLE_ACCOUNT) && masked.includes(WHOLE_ACCOUNT)));
	if (fields.length === 0) return kept;
	const asStored = unopenableAsStored(stored);
	return { ...kept, unopenable: fields, unopenableAsStored: Object.fromEntries(fields.filter((field) => asStored[field] !== undefined).map((field) => [field, asStored[field]])) };
}

/** What every route a secret is typed into answers, with 400, to one that looks sealed (S9). */
export const TYPED_SECRET_LOOKS_SEALED =
	'A secret cannot begin "dfsealed:", which is how this server marks the secrets it has sealed: type the secret itself.';

/**
 * Whether a destination as sent has a secret typed into it that looks sealed
 * (S9): any secret field, a service account JSON, or the key inside one.
 */
export function destinationLooksSealed(destination: unknown): boolean {
	return isEntry(destination) && secretFieldsOf(destination).some(({ value }) => looksSealed(value));
}

// ─── At start ────────────────────────────────────────────────────────────────

/** A stored secret sealed in a database, as the start reads it: where it is, and how to read and write it again. */
export type StoredSecret = StoredAtStart & {
	/** `webhook` is a webhook's secret; `webhook-address` its address (card 2928). */
	kind: 'mail' | 'destination' | 'webhook' | 'webhook-address' | 'setting';
	/** The envelope as stored. */
	value: string;
	aad: string;
	/** The setting it is kept in, for 'mail' and 'setting'. */
	setting?: string;
	/** Its destination's place in the list, and its field, for 'destination'. */
	index?: number;
	field?: string;
	/** Its webhook, for 'webhook'. */
	webhookId?: number;
};

/** The words a signing key is named by at start. */
const SIGNING_KEY_WORDS: Record<string, string> = {
	known_browser_secret: 'the remembered-browser key',
	request_form_secret: 'the request-form key',
	backup_seal_key: 'the backup seal key',
	webhook_address_mac_key: 'the webhook address key'
};

/**
 * The one WARN said when a backup replaces the webhook address key that does
 * not open (card 2928's code review, C14), `words` naming it
 * (`SIGNING_KEY_WORDS`). Never a value. At start, a key that does not open is
 * named in the CRITICAL key-change record instead (`signingKeysMadeLine`,
 * card 2943's fix pass, C4).
 */
export function replacedSigningKeysLine(words: readonly string[]): string {
	return (
		`Replaced ${words.join(', ')}, which could not be opened with this server's MFA key, by a new one. A new ` +
		'remembered-browser key forgets every remembered browser; a new request-form key makes open forms, decision ' +
		'revisions and comment keys reload; a new backup seal key stops older backups verifying, so a restore of one ' +
		'fills no secret and takes none of its second factors; a new webhook address key means a restore of an older backup ' +
		'fills no webhook address, each listed to enter again.'
	);
}

/** The words the webhook address key is named by in that line. */
export const WEBHOOK_ADDRESS_KEY_WORDS = SIGNING_KEY_WORDS[WEBHOOK_ADDRESS_MAC_KEY];

/** The form of the restore's match of a webhook's address (card 2928, R14): the HKDF info its key is derived with. */
const ADDRESS_MAC_INFO = 'dumpfire webhook address v1';

/**
 * The match a backup carries of a webhook's address it left out (card 2928,
 * R14): HMAC-SHA256, under a key derived by HKDF-SHA256 from `key` (the
 * server's `webhook_address_mac_key`, 32 bytes), over the canonical JSON of the
 * webhook's id, board, receiver and address, as 64 lower-case hex characters.
 * Whoever holds a backup and not the key can test no guess at an address.
 */
export function webhookAddressMac(key: Buffer, row: { id: number; boardId: number; receiver: string }, url: string): string {
	const derived = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), ADDRESS_MAC_INFO, 32));
	try {
		return createHmac('sha256', derived).update(JSON.stringify([row.id, row.boardId, row.receiver, url])).digest('hex');
	} finally {
		derived.fill(0);
	}
}

/** Whether two matches are the same, compared in constant time; false for any that is not 64 hex. */
export function sameAddressMac(a: string, b: unknown): boolean {
	if (typeof b !== 'string' || !/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
	return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

const settingIn = (database: Database.Database, key: string): string | null => {
	const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string | null } | undefined;
	return row?.value ?? null;
};

/** The parsed `backup_config` of `database`, or null where it is not there or not a JSON object. */
function configIn(database: Database.Database): Entry | null {
	const text = settingIn(database, BACKUP_CONFIG);
	if (text === null) return null;
	try {
		const parsed = JSON.parse(text);
		return isEntry(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

const storedItem = (item: Omit<StoredSecret, 'keyId' | 'opens'>): StoredSecret => {
	const keyId = ENVELOPE.exec(item.value)?.[1] ?? '';
	return { ...item, keyId, opens: (key: MfaKey) => openWith(key, item.value, item.aad) !== null };
};

/**
 * Every stored secret `database` holds sealed (anything beginning
 * `dfsealed:`), for the start's verdict (mfa-key.ts), in a fixed order: the
 * mail password, the destinations' fields, the webhooks, the signing keys.
 * Reads, and writes nothing. `keys` (this server's, and the previous one while
 * it is changed) open each webhook's address, which its secret is bound to
 * (card 2928).
 */
export function storedSecretsAtStart(database: Database.Database = sqlite, keys: readonly (MfaKey | null)[] = [currentMfaKey()]): StoredSecret[] {
	const items: StoredSecret[] = [];
	if (hasColumns(database, 'settings', 'key', 'value')) {
		const mail = settingIn(database, MAIL_PASSWORD);
		if (looksSealed(mail)) {
			items.push(storedItem({ kind: 'mail', where: 'the mail password', value: mail, aad: mailPasswordAad(mailConnectionIn(database)), setting: MAIL_PASSWORD }));
		}
		const config = configIn(database);
		if (config !== null && Array.isArray(config.destinations)) {
			config.destinations.forEach((destination: unknown, index: number) => {
				if (!isEntry(destination)) return;
				for (const { field, value } of secretFieldsOf(destination)) {
					if (!looksSealed(value)) continue;
					const where = `destination "${String(destination.name ?? '')}" (${field})`;
					items.push(storedItem({ kind: 'destination', where, value, aad: destinationSecretAad(destination, field), index, field }));
				}
			});
		}
	}
	if (hasColumns(database, 'webhooks', 'id', 'board_id', 'url', 'secret')) {
		// Each address sealed (card 2928), bound to its id, board and receiver: one of the stored secrets, re-sealed, refused and forgotten with them.
		const addresses = database
			.prepare(`SELECT id, board_id AS boardId, url, ${receiverColumn(database)} AS receiver FROM webhooks WHERE ${SEALED_SQL('url')} ORDER BY id`)
			.all() as AddressRow[];
		for (const row of addresses) {
			items.push(storedItem({ kind: 'webhook-address', where: `webhook ${row.id}'s address`, value: row.url, aad: webhookUrlAad(row.id, row.boardId, row.receiver), webhookId: row.id }));
		}
		const rows = database
			.prepare(`SELECT id, board_id AS boardId, url, ${receiverColumn(database)} AS receiver, secret FROM webhooks WHERE ${SEALED_SQL('secret')} ORDER BY id`)
			.all() as (AddressRow & { secret: string })[];
		for (const row of rows) {
			// Bound to the address as opened (card 2928), with whichever key opens it: one that opens with none binds it to nothing, and it is unreadable.
			const address = addressToBind(row, keys) ?? '';
			items.push(storedItem({ kind: 'webhook', where: `webhook ${row.id}`, value: row.secret, aad: webhookSecretAad(row.id, row.boardId, address), webhookId: row.id }));
		}
	}
	if (hasColumns(database, 'settings', 'key', 'value')) {
		for (const setting of SIGNING_KEY_SETTINGS) {
			const value = settingIn(database, setting);
			if (looksSealed(value)) items.push(storedItem({ kind: 'setting', where: SIGNING_KEY_WORDS[setting], value, aad: settingAad(setting), setting }));
		}
	}
	return items;
}

/** A destination whose service account JSON `normaliseServiceAccounts` changed (card 2939): by name, and how. */
export type ServiceAccountNormalised = { name: string; change: ServiceAccountChange };

/**
 * Bring every destination's `serviceAccountJson` in `database`'s
 * `backup_config` to the one rule's form (`normalisedServiceAccount`,
 * service-account-json.ts; card 2939, ruling P1), whatever the destination's
 * type and sign-in method: a key rebuilt to the fields DumpFire uses, its
 * sealed `private_key` carried byte for byte and never opened (its additional
 * data binds `client_email` and `private_key_id`, both kept); a
 * `service_account` object that is not a key, the key-less shape; anything
 * else, and any JSON on an OAuth or non-Drive entry, ''. Writes only when
 * something changed, and answers each change, by name. A configuration that
 * cannot be read is left (`sealPlainSecrets` counts it). Opens no
 * transaction: the start's is open. Brought once to this form, a second run
 * changes nothing.
 */
export function normaliseServiceAccounts(database: Database.Database = sqlite): ServiceAccountNormalised[] {
	if (!hasColumns(database, 'settings', 'key', 'value')) return [];
	const config = configIn(database);
	if (config === null || !Array.isArray(config.destinations)) return [];
	const changed: ServiceAccountNormalised[] = [];
	const destinations = config.destinations.map((destination: unknown) => {
		if (!isEntry(destination)) return destination;
		const { value, change } = normalisedServiceAccount(destination);
		if (change === null) return destination;
		changed.push({ name: String(destination.name ?? ''), change });
		return { ...destination, serviceAccountJson: value };
	});
	if (changed.length > 0) {
		database.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify({ ...config, destinations }), BACKUP_CONFIG);
	}
	return changed;
}

/**
 * What `sealPlainSecrets` sealed, by kind, and the backup configurations it
 * could not read; and, by id, the webhooks whose secret it left in plain
 * because their address is '' or does not open (card 2928, R5).
 */
export type SealedCounts = {
	mail: number;
	destinationFields: number;
	webhooks: number;
	webhookAddresses: number;
	signingKeys: number;
	unreadableConfigs: number;
	secretsBesideNoAddress: number[];
};

/** Every value sealed, addresses included (card 2928, R11). */
export const sealedTotal = (counts: SealedCounts) => counts.mail + counts.destinationFields + counts.webhooks + counts.webhookAddresses + counts.signingKeys;

/**
 * Seal, in `database`, every stored secret held in plain, under `key`, and
 * count them by kind: the mail password, each destination's secret fields on
 * every entry whatever its type, a service account's key, each webhook's
 * secret, and the webhook address key. Never the three signing keys of
 * `V2_SIGNING_KEYS` (card 2943, R8): one of those held in plain is replaced by
 * `replaceSigningKeysAtStart`, never sealed in place, and a direct call leaves
 * it as it is. Empty values and values already sealed
 * are left. A `backup_config` that is not JSON is counted as unreadable and
 * nothing in it is sealed; no text of it is kept (S12). The key check is not
 * recorded here: the caller records it in the same transaction. Opens no
 * transaction. A second run seals nothing.
 */
export function sealPlainSecrets(database: Database.Database = sqlite, key: MfaKey | null = currentMfaKey()): SealedCounts {
	const counts: SealedCounts = { mail: 0, destinationFields: 0, webhooks: 0, webhookAddresses: 0, signingKeys: 0, unreadableConfigs: 0, secretsBesideNoAddress: [] };
	if (key === null) throw new Error('No MFA key is loaded, so no stored secret can be sealed.');
	const setSetting = (name: string, value: string) => database.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, name);
	if (hasColumns(database, 'settings', 'key', 'value')) {
		const mail = settingIn(database, MAIL_PASSWORD);
		if (mail !== null && mail !== '' && !looksSealed(mail)) {
			setSetting(MAIL_PASSWORD, sealValue(mail, mailPasswordAad(mailConnectionIn(database)), key));
			counts.mail++;
		}
		const text = settingIn(database, BACKUP_CONFIG);
		if (text !== null) {
			let config: unknown;
			let readable = true;
			try {
				config = JSON.parse(text);
			} catch {
				readable = false;
			}
			if (!readable || !isEntry(config)) {
				counts.unreadableConfigs++;
			} else if (Array.isArray(config.destinations)) {
				let changed = 0;
				const destinations = config.destinations.map((destination: unknown) => {
					if (!isEntry(destination)) return destination;
					const sealed = sealedDestination(destination, (plain, aad) => sealValue(plain, aad, key), true);
					changed += sealed.count;
					return sealed.count > 0 ? sealed.destination : destination;
				});
				if (changed > 0) {
					setSetting(BACKUP_CONFIG, JSON.stringify({ ...config, destinations }));
					counts.destinationFields += changed;
				}
			}
		}
		for (const setting of SIGNING_KEY_SETTINGS) {
			// Never sealed in place (card 2943, R8): one held in plain is in every older copy, and is replaced at start.
			if (isV2Setting(setting)) continue;
			const value = settingIn(database, setting);
			if (value !== null && value !== '' && !looksSealed(value)) {
				setSetting(setting, sealValue(value, settingAad(setting), key));
				counts.signingKeys++;
			}
		}
	}
	if (hasColumns(database, 'webhooks', 'id', 'board_id', 'url', 'secret')) {
		// Card 2928: each plain address too, where the database has the receiver to bind it to (migration 0073).
		const addresses = hasColumns(database, 'webhooks', 'receiver');
		const plain = database
			.prepare(
				`SELECT id, board_id AS boardId, url, ${receiverColumn(database)} AS receiver, secret FROM webhooks ` +
					`WHERE (secret <> '' AND NOT ${SEALED_SQL('secret')})${addresses ? ` OR (url <> '' AND NOT ${SEALED_SQL('url')})` : ''} ORDER BY id`
			)
			.all() as (AddressRow & { secret: string })[];
		// One write: the address, its receiver and the secret, matched on the values read.
		const update = database.prepare(`UPDATE webhooks SET url = ?, ${addresses ? 'receiver' : 'url'} = ?, secret = ? WHERE id = ? AND url = ? AND secret = ?`);
		for (const row of plain) {
			let { url, receiver, secret } = row;
			// Canonical first (card 2928's code review, C3): one string, well-formed, for the receiver, the envelope and the secret's binding.
			const plainAddress = addresses && url !== '' && !looksSealed(url) ? row.url.toWellFormed() : null;
			if (plainAddress !== null) {
				// The receiver recomputed from the address, never the row's (R6).
				receiver = receiverOf(plainAddress) ?? '';
				url = sealValue(plainAddress, webhookUrlAad(row.id, row.boardId, receiver), key);
				counts.webhookAddresses++;
			}
			if (secret !== '' && !looksSealed(secret)) {
				// Bound to the address as opened (card 2928); never to one that is '' or does not open (R5): left, and named.
				const address = plainAddress ?? addressToBind(row, [key]);
				if (address === null) counts.secretsBesideNoAddress.push(row.id);
				else {
					secret = sealValue(secret, webhookSecretAad(row.id, row.boardId, address), key);
					counts.webhooks++;
				}
			}
			// With no receiver column, the address twice (only the secret can change then).
			if (url !== row.url || secret !== row.secret) update.run(url, addresses ? receiver : url, secret, row.id, row.url, row.secret);
		}
	}
	return counts;
}

/**
 * Seal again under `key` each of `items` that opens with `old` (a key
 * rotation, card 2773 as card 2898 extends it), with the same additional data
 * and a new nonce, in `database`. Throws when one no longer opens or was
 * changed meanwhile: the caller's transaction then changes nothing. `seal` is
 * the start's seam. Opens no transaction.
 */
export function resealStoredSecrets(
	database: Database.Database,
	items: readonly StoredSecret[],
	old: MfaKey,
	key: MfaKey,
	seal: typeof sealWith = sealWith
): number {
	const again = (item: StoredSecret): string => {
		const opened = openWith(old, item.value, item.aad);
		if (opened === null) throw new Error(`${item.where} no longer opens with the previous key`);
		return sealValue(opened, item.aad, key, seal);
	};
	const changedMeanwhile = (item: StoredSecret) => new Error(`${item.where} was changed while it was sealed again`);

	const setting = database.prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?');
	for (const item of items) {
		if ((item.kind === 'mail' || item.kind === 'setting') && setting.run(again(item), item.setting!, item.value).changes !== 1) throw changedMeanwhile(item);
	}

	const inConfig = items.filter((item) => item.kind === 'destination');
	if (inConfig.length > 0) {
		const config = configIn(database);
		const destinations = config !== null && Array.isArray(config.destinations) ? [...config.destinations] : null;
		if (destinations === null) throw changedMeanwhile(inConfig[0]);
		for (const item of inConfig) {
			const destination = destinations[item.index!];
			if (!isEntry(destination) || secretFieldValue(destination, item.field!) !== item.value) throw changedMeanwhile(item);
			destinations[item.index!] = withSecretField(destination, item.field!, again(item));
		}
		database.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify({ ...config, destinations }), BACKUP_CONFIG);
	}

	// A webhook's secret, and its address (card 2928): each with the additional data it was read with.
	const hooks = items.filter((item) => item.kind === 'webhook' || item.kind === 'webhook-address');
	if (hooks.length > 0) {
		const update = database.prepare(
			"UPDATE webhooks SET secret = CASE WHEN ? = 'secret' THEN ? ELSE secret END, url = CASE WHEN ? = 'url' THEN ? ELSE url END " +
				"WHERE id = ? AND (CASE WHEN ? = 'secret' THEN secret ELSE url END) = ?"
		);
		for (const item of hooks) {
			const column = item.kind === 'webhook' ? 'secret' : 'url';
			const sealed = again(item);
			if (update.run(column, sealed, column, sealed, item.webhookId!, column, item.value).changes !== 1) throw changedMeanwhile(item);
		}
	}
	// The old key's ciphertexts are still in the file's free space and its log: scrubbed (the code review's S4).
	if (items.length > 0) markScrubPending(database);
	return items.length;
}

/**
 * Forget `items` (decision 10 as the code review's S6 amends it: no key check
 * stored, nothing sealed opens with this key, and the operator has asked for
 * it, `FORGET_UNOPENABLE_SECRETS=1`), as a backup forgets them: the mail password's row deleted,
 * each destination's field emptied, each webhook's secret emptied with the
 * webhook switched off and listed in `webhook_secrets_left_out` with whether
 * it was on (as `clearSecrets` lists it, so that the start names it to
 * enter), each webhook's address the same way in `webhook_addresses_left_out`
 * (card 2928), and each signing key's row deleted, to be made again. Opens no
 * transaction.
 */
export function forgetStoredSecrets(database: Database.Database, items: readonly StoredSecret[]): void {
	for (const item of items) {
		if (item.kind !== 'mail' && item.kind !== 'setting') continue;
		const deleted = database.prepare('DELETE FROM settings WHERE key = ? AND value = ?').run(item.setting!, item.value).changes;
		// The backup seal key's record goes with it (card 2943, R4).
		if (deleted === 1 && item.setting === SEAL_KEY_SETTING) database.prepare('DELETE FROM settings WHERE key = ?').run(BACKUP_SEAL_KEY_MADE_AT);
	}

	const inConfig = items.filter((item) => item.kind === 'destination');
	const config = inConfig.length > 0 ? configIn(database) : null;
	if (config !== null && Array.isArray(config.destinations)) {
		const destinations = [...config.destinations];
		for (const item of inConfig) {
			const destination = destinations[item.index!];
			if (isEntry(destination) && secretFieldValue(destination, item.field!) === item.value) {
				destinations[item.index!] = withSecretField(destination, item.field!, '');
			}
		}
		database.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify({ ...config, destinations }), BACKUP_CONFIG);
	}

	// A webhook's secret and its address (card 2928): each emptied, the webhook switched off and listed in the
	// marker of what it lacks, with whether it was on, read before either is written.
	const hooks = items.filter((item) => item.kind === 'webhook' || item.kind === 'webhook-address');
	if (hooks.length > 0 && hasColumns(database, 'webhooks', 'id', 'secret', 'url', 'active')) {
		const wasOn = new Map<number, boolean>();
		const read = database.prepare('SELECT active FROM webhooks WHERE id = ?');
		for (const item of hooks) {
			const row = read.get(item.webhookId!) as { active: number } | undefined;
			if (row !== undefined && !wasOn.has(item.webhookId!)) wasOn.set(item.webhookId!, row.active !== 0);
		}
		const forget = {
			secret: database.prepare("UPDATE webhooks SET secret = '', active = 0 WHERE id = ? AND secret = ?"),
			url: database.prepare("UPDATE webhooks SET url = '', active = 0 WHERE id = ? AND url = ?")
		};
		const listed = { secret: [] as { id: number; active: boolean }[], url: [] as { id: number; active: boolean }[] };
		for (const item of hooks) {
			const column = item.kind === 'webhook' ? 'secret' : 'url';
			if (forget[column].run(item.webhookId!, item.value).changes === 1) listed[column].push({ id: item.webhookId!, active: wasOn.get(item.webhookId!) ?? false });
		}
		if (hasColumns(database, 'settings', 'key', 'value')) {
			mergeListed(database, WEBHOOK_SECRETS_LEFT_OUT, listed.secret);
			mergeListed(database, WEBHOOK_ADDRESSES_LEFT_OUT, listed.url);
		}
	}
	// The forgotten ciphertexts are still in the file's free space and its log: scrubbed (the code review's S4).
	if (items.length > 0) markScrubPending(database);
}

/**
 * Forget, at every start that finds one (card 2928's code review, C2), each
 * plain secret of `ids` that the start's sweep left because its webhook's
 * address is '' or does not open (R5): emptied, the webhook switched off and listed in
 * `webhook_secrets_left_out` with whether it was on, as a backup forgets one.
 * Only one still plain is touched. Marks the scrub when it changed any. Opens
 * no transaction. Answers the ids it forgot.
 */
export function forgetSecretsBesideNoAddress(database: Database.Database, ids: readonly number[]): number[] {
	const forgotten: { id: number; active: boolean }[] = [];
	const before = database.prepare('SELECT active FROM webhooks WHERE id = ?').pluck();
	// SEALED_SQL written out: one whole statement, as the webhook-writer inventory reads it.
	const forget = database.prepare("UPDATE webhooks SET secret = '', active = 0 WHERE id = ? AND secret <> '' AND substr(secret, 1, 9) <> 'dfsealed:'");
	for (const id of ids) {
		const active = before.get(id) as number | undefined;
		if (forget.run(id).changes === 1) forgotten.push({ id, active: active === 1 });
	}
	if (forgotten.length > 0) {
		mergeListed(database, WEBHOOK_SECRETS_LEFT_OUT, forgotten);
		markScrubPending(database);
	}
	return forgotten.map((entry) => entry.id);
}

/**
 * Add `listed` to the marker `key` in `database` (`webhook_secrets_left_out`,
 * or card 2928's `webhook_addresses_left_out`), each entry replacing one of
 * the same id; a marker that cannot be read is replaced. Nothing for none.
 */
export function mergeListed(database: Database.Database, key: string, listed: readonly { id: number; active: boolean }[]): void {
	if (listed.length === 0) return;
	let already: Entry[] = [];
	try {
		const parsed = JSON.parse(settingIn(database, key) ?? '[]');
		if (Array.isArray(parsed)) {
			already = parsed.filter((entry): entry is Entry => isEntry(entry) && Number.isInteger(entry.id) && typeof entry.active === 'boolean');
		}
	} catch {
		// A list that cannot be read is replaced by the one written here.
	}
	const merged = [...already.filter((entry) => !listed.some((item) => item.id === entry.id)), ...listed].sort((a, b) => Number(a.id) - Number(b.id));
	database.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(merged));
}

/**
 * The setting that lists the webhooks whose address a backup left out, or a
 * forget emptied (card 2928): each `{ id, active, address? }`, `address` the
 * HMAC a restore matches this server's own with. backup-secrets.ts reads it.
 */
export const WEBHOOK_ADDRESSES_LEFT_OUT = 'webhook_addresses_left_out';

/**
 * Replace each signing key `database` holds sealed that does not open with
 * `key` by a new one, 32 random bytes as hex (after `v2:` for one of
 * `V2_SIGNING_KEYS`), sealed (decision 9, S14), and
 * answer each replaced, with the reason `unopenable`, for the start's
 * key-change record line (card 2943's fix pass, C4). One of `V2_SIGNING_KEYS`
 * is made of the current form, `v2:` and 64 hex, and the backup seal key's
 * record is written with it (card 2943, R4). Opens no transaction.
 */
export function replaceUnopenableSigningKeys(database: Database.Database, key: MfaKey): SigningKeyMade[] {
	const replaced: SigningKeyMade[] = [];
	if (!hasColumns(database, 'settings', 'key', 'value')) return replaced;
	for (const setting of SIGNING_KEY_SETTINGS) {
		const value = settingIn(database, setting);
		if (!looksSealed(value) || openWith(key, value, settingAad(setting)) !== null) continue;
		const text = isV2Setting(setting) ? newSigningKeyText() : randomBytes(32).toString('hex');
		const changed = database
			.prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?')
			.run(sealValue(text, settingAad(setting), key), setting, value).changes;
		if (changed === 1 && setting === SEAL_KEY_SETTING) recordSealKeyMade(database);
		replaced.push({ setting, because: 'unopenable' });
	}
	return replaced;
}

/** A signing key made anew, and why (card 2943). */
export type SigningKeyMade = {
	setting: (typeof SIGNING_KEY_SETTINGS)[number];
	because: 'none' | 'plain' | 'older' | 'unopenable' | 'not trusted at run time';
};

/** How each reason is said in the record line. */
const MADE_BECAUSE: Record<SigningKeyMade['because'], string> = {
	none: 'none was stored',
	plain: 'the one stored was in plain',
	older: 'the one stored was of an older form',
	unopenable: "the one stored could not be opened with this server's MFA key",
	'not trusted at run time': "the one stored was not trusted at run time: in plain, of an older form, or not opening with this server's MFA key"
};

/**
 * At start (card 2943, R1, R5, R8), in the start's transaction and before
 * `sealPlainSecrets`: make anew, sealed under `key` and of the current form,
 * each of `V2_SIGNING_KEYS` that is stored in plain or opens to another form,
 * and the backup seal key where none is stored (or '' is). Each is in every
 * copy of the database made before card 2898 sealed it, so it is never sealed
 * in place and never trusted. One that does not open is left to
 * `replaceUnopenableSigningKeys`, which follows, so it is replaced once.
 *
 * The backup seal key's record is written with it (R4), and any key made
 * marks the scrub (R14): the old text may be in the file's free pages, or a
 * row deleted by hand was. Answers each key made, and why. The caller records
 * the key check first, in the same transaction, and writes the record line
 * (`signingKeysMadeLine`). Opens no transaction.
 */
export function replaceSigningKeysAtStart(database: Database.Database, key: MfaKey): SigningKeyMade[] {
	const made: { setting: (typeof V2_SIGNING_KEYS)[number]; because: SigningKeyMade['because'] }[] = [];
	if (!hasColumns(database, 'settings', 'key', 'value')) return made;
	for (const setting of V2_SIGNING_KEYS) {
		const opened = openStored(settingIn(database, setting), settingAad(setting), key);
		let because: SigningKeyMade['because'];
		if (opened.kind === 'empty') {
			// The two others are made where they are first needed (`writeFormSecret`, `rememberBrowser`).
			if (setting !== SEAL_KEY_SETTING) continue;
			because = 'none';
		} else if (opened.kind === 'plain') because = 'plain';
		else if (opened.kind === 'opened' && currentSigningKeyHex(opened) === null) because = 'older';
		else continue;
		database
			.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
			.run(setting, sealValue(newSigningKeyText(), settingAad(setting), key));
		if (setting === SEAL_KEY_SETTING) recordSealKeyMade(database);
		made.push({ setting, because });
	}
	if (made.length > 0) markScrubPending(database);
	return made;
}

/**
 * The one CRITICAL line for signing keys made anew (card 2943, R6, and its fix
 * pass, C4): a key-change record, kept for good with the system log's
 * CRITICAL lines (card 2899), naming each key and why, and what each makes
 * happen once. Never a value. `where` says what made them: the start
 * (`replaceSigningKeysAtStart` and `replaceUnopenableSigningKeys` together),
 * or a backup or a sign-in at run time. Worded as a record, true for every
 * reason.
 */
export function signingKeysMadeLine(made: readonly SigningKeyMade[], where = 'at this start'): string {
	const each = made.map(({ setting, because }) => `${SIGNING_KEY_WORDS[setting]} (${MADE_BECAUSE[because]})`).join('; ');
	const settings = new Set<string>(made.map(({ setting }) => setting));
	const effects = [
		settings.has(SEAL_KEY_SETTING)
			? "Backups sealed before now are taken as another server's: a restore of one fills no secret or webhook address, takes no second factors for accounts not on this server, and lists each to enter again."
			: '',
		settings.has('known_browser_secret') ? 'Every remembered browser is forgotten once.' : '',
		settings.has('request_form_secret') ? 'Open request forms, decision revisions and comment keys are made again once: a page open now is reloaded.' : '',
		settings.has(WEBHOOK_ADDRESS_MAC_KEY) ? 'A restore of an older backup fills no webhook address, each listed to enter again.' : ''
	].filter((effect) => effect !== '');
	return `Key change recorded: made ${where}, each stored encrypted under the MFA key: ${each}. ${effects.join(' ')}`;
}

// ─── A restore ───────────────────────────────────────────────────────────────

/** What a restore throws when a backup holds a secret in plain and no MFA key is loaded to seal it (E9): the restore rolls back. */
export class NoKeyToSeal extends Error {
	constructor() {
		super('No MFA key is loaded, so the secrets this backup holds in plain cannot be sealed. Nothing was restored.');
		this.name = 'NoKeyToSeal';
	}
}

/**
 * The rows a restore reads from a backup's `table`, each secret held in plain
 * sealed as it is read (S7), so that none reaches the live file: in
 * `settings`, the mail password, bound to the backup's own mail settings, and
 * each destination's secret fields in `backup_config`, on every entry, an
 * SFTP one bound to no host key (a restore never takes one from a backup, and
 * gives an entry with its secrets none); in `webhooks`, each address (card
 * 2928), bound to its row's id, board and receiver, recomputed from it, and
 * each secret, bound to its row's id, board and address as opened. A secret
 * beside an address that is '' or does not open here is left out, the webhook
 * off, and answered in `secretsLeftOut` for the restore to list (R5, R6). Each
 * destination's service account JSON is first brought to the one rule's form
 * (`normalisedServiceAccount`, card 2939). Values already sealed are left.
 * `key` is asked only when there is something to seal, and none is a
 * `NoKeyToSeal`. Answers the rows and how many values were sealed.
 */
export function sealedForRestore(
	table: string,
	rows: Record<string, unknown>[],
	key: () => MfaKey | null = currentMfaKey
): { rows: Record<string, unknown>[]; sealed: number; secretsLeftOut?: { id: number; active: boolean }[] } {
	let sealed = 0;
	const seal = (plain: string, aad: string) => {
		const mfaKey = key();
		if (mfaKey === null) throw new NoKeyToSeal();
		sealed++;
		return sealValue(plain, aad, mfaKey);
	};
	const plain = (value: unknown): value is string => typeof value === 'string' && value !== '' && !looksSealed(value);
	const name = table.toLowerCase();
	if (name === 'settings') {
		const mail = Object.fromEntries(MAIL_CONNECTION_SETTINGS.map((setting) => [setting, rows.find((row) => row.key === setting)?.value ?? null]));
		const out = rows.map((row) => {
			if (row.key === MAIL_PASSWORD && plain(row.value)) return { ...row, value: seal(row.value, mailPasswordAad(mail)) };
			if (row.key !== BACKUP_CONFIG || typeof row.value !== 'string') return row;
			let config: unknown;
			try {
				config = JSON.parse(row.value);
			} catch {
				return row;
			}
			if (!isEntry(config) || !Array.isArray(config.destinations)) return row;
			let changed = 0;
			const destinations = config.destinations.map((restored: unknown) => {
				if (!isEntry(restored)) return restored;
				// Its service account JSON brought to the one rule's form first (card
				// 2939, ruling P1), so that nothing else reaches the live file.
				const normalised = normalisedServiceAccount(restored);
				const destination = normalised.change === null ? restored : { ...restored, serviceAccountJson: normalised.value };
				if (normalised.change !== null) changed++;
				const boundTo = destination.type === 'sftp' ? { ...destination, hostKey: undefined } : destination;
				const result = sealedDestination(destination, seal, true, boundTo);
				changed += result.count;
				return result.count > 0 ? result.destination : destination;
			});
			return changed > 0 ? { ...row, value: JSON.stringify({ ...config, destinations }) } : row;
		});
		return { rows: out, sealed };
	}
	if (name === 'webhooks') {
		const secretsLeftOut: { id: number; active: boolean }[] = [];
		const out = rows.map((row) => {
			const id = Number(row.id);
			const boardId = Number(row.board_id);
			let url = typeof row.url === 'string' ? row.url : '';
			// Every row carries a receiver, for the restore's columns (a backup from before 0073 has none).
			let receiver = typeof row.receiver === 'string' ? row.receiver : '';
			// Canonical first (card 2928's code review, C3), as the start's sweep makes it.
			const plainAddress = plain(url) ? url.toWellFormed() : null;
			if (plainAddress !== null) {
				// Sealed as it is read (card 2928), its receiver recomputed from it, never the backup's (R6).
				receiver = receiverOf(plainAddress) ?? '';
				url = seal(plainAddress, webhookUrlAad(id, boardId, receiver));
			}
			let next: Record<string, unknown> = { ...row, url, receiver };
			if (plain(row.secret)) {
				// Bound to the address as opened, never to one that is '' or does not open here (R5, R6): such a
				// secret is left out, the webhook off and listed to enter, as a backup leaves one out.
				const address = plainAddress ?? addressToBind({ id, boardId, url, receiver }, [key()]);
				if (address === null) {
					secretsLeftOut.push({ id, active: Number(row.active) !== 0 });
					next = { ...next, secret: '', active: 0 };
				} else {
					next = { ...next, secret: seal(row.secret, webhookSecretAad(id, boardId, address)) };
				}
			}
			return next;
		});
		return { rows: out, sealed, secretsLeftOut };
	}
	return { rows, sealed };
}

/**
 * The `settings` key that says old plain text, or old ciphertext, may still be
 * in the file's free space or its WAL (decision 14, S6): an ISO time. Never
 * brought in by a restore (`rowsToRestore`), and set again by every restore
 * and Reset (the code review's S1).
 */
export const SECRETS_SCRUB_PENDING = 'secrets_scrub_pending';

/**
 * The `settings` key written, as an ISO time, by the first start that sealed
 * anything: only that start deletes the stale `.backup-temp` copies (the code
 * review's E8). A restore brings the backup's in, or none.
 */
export const STORED_SECRETS_FIRST_SEALED = 'stored_secrets_first_sealed';

/**
 * The `settings` key written, as an ISO time, by the first start of card
 * 2928's release, which marks the scrub once whatever it seals (R20): the free
 * pages a file kept from before `secure_delete` are cleared.
 *
 * That start, the one that writes it, also deletes the stale `.backup-temp`
 * copies, which held the addresses in plain (R21 as its code review's C4 moves
 * it).
 */
export const WEBHOOK_ADDRESSES_SCRUB_MARKED = 'webhook_addresses_scrub_marked';

/** When this process loaded the module: a scrub marker set since was set by this start, and is scrubbed before the server listens (E4). */
export const PROCESS_STARTED_AT = new Date().toISOString();

/**
 * Set the scrub's marker in `database`, in the caller's transaction (S1, S4):
 * a restore, a Reset, a change of key and a forget each leave old text in the
 * file's free space and its log. The time is now's, so that a start that
 * sets it scrubs before the server listens (E4).
 */
export function markScrubPending(database: Database.Database): void {
	if (!hasColumns(database, 'settings', 'key', 'value')) return;
	database
		.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
		.run(SECRETS_SCRUB_PENDING, new Date().toISOString());
}

/** A `wal_checkpoint(TRUNCATE)` of `database`: true when no reader held it up. */
export function checkpointTruncate(database: Database.Database): boolean {
	const [row] = database.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
	return row === undefined || row.busy === 0;
}

/**
 * Admin › Vacuum (card 2898, S6): `VACUUM`, then a checkpoint that empties
 * the write-ahead log, which held the pages as they were; when it was not
 * held up, the scrub's marker is cleared, and the log emptied of that too.
 * Answers whether the scrub finished (the code review's E7, S5): false when a
 * reader held the log, the marker kept. Not in a transaction: VACUUM cannot
 * run in one. Throws what VACUUM throws.
 */
export function vacuumAndScrub(database: Database.Database = sqlite): boolean {
	database.exec('VACUUM');
	if (!checkpointTruncate(database)) return false;
	database.prepare('DELETE FROM settings WHERE key = ?').run(SECRETS_SCRUB_PENDING);
	checkpointTruncate(database);
	return true;
}
