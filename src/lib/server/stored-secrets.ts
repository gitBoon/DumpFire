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
 * is cached here.
 *
 * Every write of a sealed value records the key check in the same
 * transaction (`recordKeyCheck`, S2's one rule). Nothing here opens a
 * transaction, and nothing here writes a log line: the callers do both.
 *
 * Imports nothing from backup-secrets.ts, email.ts or webhooks.ts, which all
 * import this: no cycle.
 */
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { sqlite } from './db';
import { MFA_KEY_CHECK_SETTING, currentMfaKey, type MfaKey, type StoredAtStart } from './mfa-key';
import { openSealed, sealWith } from './mfa-crypto';
import { confirmedHostKey } from './ssh-host-key';

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
	return hasColumns(database, 'webhooks', 'secret') && database.prepare(`SELECT 1 FROM webhooks WHERE ${SEALED_SQL('secret')} LIMIT 1`).get() !== undefined;
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

/** The additional data's form. A change to any list below is a new version, and every value sealed again at start. */
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

/** A webhook's secret is bound to these (S10). */
export const WEBHOOK_FIELDS = ['id', 'boardId', 'url'] as const;

/** The settings a stored secret is kept in, beside `backup_config`. Their names are the modules' own (email.ts, known-browsers.ts, request-tokens.ts, backup-secrets.ts). */
const MAIL_PASSWORD = 'smtp_pass';
/** The stored mail settings the password is bound to (`mailPasswordAad` reads them): the one list (the code review's E10). */
export const MAIL_CONNECTION_SETTINGS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_allow_insecure'] as const;
/** The stored mail settings the password is bound to, read from `database`, each null where it is not there. */
export function mailConnectionIn(database: Database.Database): Record<string, string | null> {
	return Object.fromEntries(MAIL_CONNECTION_SETTINGS.map((name) => [name, settingIn(database, name)]));
}
export const SIGNING_KEY_SETTINGS = ['known_browser_secret', 'request_form_secret', 'backup_seal_key'] as const;
const STORED_SETTINGS: readonly string[] = [MAIL_PASSWORD, ...SIGNING_KEY_SETTINGS];
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
 * the field `serviceAccountJson.private_key`.
 */
export function destinationSecretAad(destination: unknown, field: string): string {
	const entry = isEntry(destination) ? destination : {};
	const type = entry.type === undefined ? null : entry.type;
	const place = placeFields(entry).map((name) => placeValue(entry, name));
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
	kind: 'mail' | 'destination' | 'webhook' | 'setting';
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
	backup_seal_key: 'the backup seal key'
};

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
 * Reads, and writes nothing.
 */
export function storedSecretsAtStart(database: Database.Database = sqlite): StoredSecret[] {
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
		const rows = database
			.prepare(`SELECT id, board_id AS boardId, url, secret FROM webhooks WHERE ${SEALED_SQL('secret')} ORDER BY id`)
			.all() as { id: number; boardId: number; url: string; secret: string }[];
		for (const row of rows) {
			items.push(storedItem({ kind: 'webhook', where: `webhook ${row.id}`, value: row.secret, aad: webhookSecretAad(row.id, row.boardId, row.url), webhookId: row.id }));
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

/** What `sealPlainSecrets` sealed, by kind, and the backup configurations it could not read. */
export type SealedCounts = { mail: number; destinationFields: number; webhooks: number; signingKeys: number; unreadableConfigs: number };

export const sealedTotal = (counts: SealedCounts) => counts.mail + counts.destinationFields + counts.webhooks + counts.signingKeys;

/**
 * Seal, in `database`, every stored secret held in plain, under `key`, and
 * count them by kind: the mail password, each destination's secret fields on
 * every entry whatever its type, a service account's key, each webhook's
 * secret, and the three signing keys. Empty values and values already sealed
 * are left. A `backup_config` that is not JSON is counted as unreadable and
 * nothing in it is sealed; no text of it is kept (S12). The key check is not
 * recorded here: the caller records it in the same transaction. Opens no
 * transaction. A second run seals nothing.
 */
export function sealPlainSecrets(database: Database.Database = sqlite, key: MfaKey | null = currentMfaKey()): SealedCounts {
	const counts: SealedCounts = { mail: 0, destinationFields: 0, webhooks: 0, signingKeys: 0, unreadableConfigs: 0 };
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
			const value = settingIn(database, setting);
			if (value !== null && value !== '' && !looksSealed(value)) {
				setSetting(setting, sealValue(value, settingAad(setting), key));
				counts.signingKeys++;
			}
		}
	}
	if (hasColumns(database, 'webhooks', 'id', 'board_id', 'url', 'secret')) {
		const plain = database
			.prepare(`SELECT id, board_id AS boardId, url, secret FROM webhooks WHERE secret <> '' AND NOT ${SEALED_SQL('secret')} ORDER BY id`)
			.all() as { id: number; boardId: number; url: string; secret: string }[];
		const update = database.prepare('UPDATE webhooks SET secret = ? WHERE id = ? AND secret = ?');
		for (const row of plain) {
			update.run(sealValue(row.secret, webhookSecretAad(row.id, row.boardId, row.url), key), row.id, row.secret);
			counts.webhooks++;
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

	const hooks = items.filter((item) => item.kind === 'webhook');
	if (hooks.length > 0) {
		const update = database.prepare('UPDATE webhooks SET secret = ? WHERE id = ? AND secret = ?');
		for (const item of hooks) {
			if (update.run(again(item), item.webhookId!, item.value).changes !== 1) throw changedMeanwhile(item);
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
 * enter), and each signing key's row deleted, to be made again. Opens no
 * transaction.
 */
export function forgetStoredSecrets(database: Database.Database, items: readonly StoredSecret[]): void {
	for (const item of items) {
		if (item.kind === 'mail' || item.kind === 'setting') database.prepare('DELETE FROM settings WHERE key = ? AND value = ?').run(item.setting!, item.value);
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

	const hooks = items.filter((item) => item.kind === 'webhook');
	if (hooks.length > 0 && hasColumns(database, 'webhooks', 'id', 'secret', 'active')) {
		const listed: { id: number; active: boolean }[] = [];
		const read = database.prepare('SELECT active FROM webhooks WHERE id = ? AND secret = ?');
		for (const item of hooks) {
			const row = read.get(item.webhookId!, item.value) as { active: number } | undefined;
			if (row !== undefined) listed.push({ id: item.webhookId!, active: row.active !== 0 });
		}
		const forget = database.prepare("UPDATE webhooks SET secret = '', active = 0 WHERE id = ? AND secret = ?");
		for (const item of hooks) forget.run(item.webhookId!, item.value);
		if (listed.length > 0 && hasColumns(database, 'settings', 'key', 'value')) {
			let already: { id: number; active: boolean }[] = [];
			try {
				const parsed = JSON.parse(settingIn(database, WEBHOOK_SECRETS_LEFT_OUT) ?? '[]');
				if (Array.isArray(parsed)) {
					already = parsed.filter(
						(entry): entry is { id: number; active: boolean } => isEntry(entry) && Number.isInteger(entry.id) && typeof entry.active === 'boolean'
					);
				}
			} catch {
				// A list that cannot be read is replaced by the one written here.
			}
			const merged = [...already.filter((entry) => !listed.some((item) => item.id === entry.id)), ...listed].sort((a, b) => a.id - b.id);
			database
				.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
				.run(WEBHOOK_SECRETS_LEFT_OUT, JSON.stringify(merged));
		}
	}
	// The forgotten ciphertexts are still in the file's free space and its log: scrubbed (the code review's S4).
	if (items.length > 0) markScrubPending(database);
}

/**
 * Replace each signing key `database` holds sealed that does not open with
 * `key` by a new one, 32 random bytes as hex, sealed (decision 9, S14), and
 * answer the words of each replaced. Opens no transaction.
 */
export function replaceUnopenableSigningKeys(database: Database.Database, key: MfaKey): string[] {
	const replaced: string[] = [];
	if (!hasColumns(database, 'settings', 'key', 'value')) return replaced;
	for (const setting of SIGNING_KEY_SETTINGS) {
		const value = settingIn(database, setting);
		if (!looksSealed(value) || openWith(key, value, settingAad(setting)) !== null) continue;
		database
			.prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?')
			.run(sealValue(randomBytes(32).toString('hex'), settingAad(setting), key), setting, value);
		replaced.push(SIGNING_KEY_WORDS[setting]);
	}
	return replaced;
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
 * gives an entry with its secrets none); in `webhooks`, each secret, bound to
 * its row's id, board and address. Values already sealed are left. `key` is
 * asked only when there is something to seal, and none is a `NoKeyToSeal`.
 * Answers the rows and how many values were sealed.
 */
export function sealedForRestore(
	table: string,
	rows: Record<string, unknown>[],
	key: () => MfaKey | null = currentMfaKey
): { rows: Record<string, unknown>[]; sealed: number } {
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
			const destinations = config.destinations.map((destination: unknown) => {
				if (!isEntry(destination)) return destination;
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
		const out = rows.map((row) =>
			plain(row.secret) ? { ...row, secret: seal(row.secret, webhookSecretAad(Number(row.id), Number(row.board_id), String(row.url))) } : row
		);
		return { rows: out, sealed };
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
