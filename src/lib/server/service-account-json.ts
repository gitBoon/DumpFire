/**
 * service-account-json.ts — a Google service account's JSON key, read by one
 * rule (card 2939).
 *
 * A Google Drive destination that signs in with a service account holds the
 * JSON key file Google gives for it (`serviceAccountJson`). Until card 2939 it
 * was handed, as pasted, to `new google.auth.GoogleAuth({ credentials })`,
 * which picks its way to sign in by the JSON's `type`: an `external_account`
 * JSON reads any file the server can read (`credential_source.file`) and posts
 * it to a `token_url` of the sender's choosing, `credential_source.url`
 * fetches any address, and JSON that reads as `null` falls back to the
 * server's own Google identity. Now the JSON is read here, and only a key of
 * Google's own shape is used: `getDrive` builds a JWT from its fields
 * (backup-destinations.ts), and the JSON never reaches the library.
 *
 * The rule (`readServiceAccountJson`), parsed once here:
 *
 *   - a JSON object (not `null`, a number, a string or a list) whose `type` is
 *     `service_account`;
 *   - each field the rule reads (`READ_FIELDS`) is text where it is present;
 *   - a key: `private_key` non-empty text, `client_email` non-empty text, and
 *     `universe_domain` absent, '' or `googleapis.com` (Google's own, the
 *     default);
 *   - or the key-less shape a backup's copy leaves: `private_key` empty or
 *     absent (the universe is then not asked).
 *
 * What is stored is the JSON rebuilt from the fields DumpFire uses
 * (`SERVICE_ACCOUNT_SHOWN` and `private_key`), each only where it is text, in
 * the order given: every other field is dropped, whatever it holds, so that
 * nothing outside the seal's list holds text the sign-in does not use. A
 * sealed `private_key` is carried as its envelope, byte for byte, and never
 * opened here: its additional data binds `client_email` and
 * `private_key_id`, both kept (stored-secrets.ts).
 *
 * `normalisedServiceAccount` is the one rule every stored destination is
 * brought to: at every start (stored-secrets.ts, `normaliseServiceAccounts`),
 * in a restore (`sealedForRestore`), and so at the save too. Text the save
 * would accept is rebuilt; a `service_account` object the save would refuse
 * becomes the key-less shape; anything else, and any JSON on an OAuth or
 * non-Drive entry, becomes ''.
 *
 * A leaf: imports nothing, so backup-secrets.ts, stored-secrets.ts and
 * backup-destinations.ts all import it with no cycle.
 */

type Entry = Record<string, unknown>;

const isEntry = (value: unknown): value is Entry => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The fields of a service account's JSON that a backup's copy keeps and the
 * GET shows, each only where it is text (card 2938's code review, R1): an
 * allowlist. With `private_key`, they are the fields a save stores (card 2939).
 */
export const SERVICE_ACCOUNT_SHOWN: readonly string[] = Object.freeze(['type', 'project_id', 'client_email', 'private_key_id', 'client_id']);

/** The fields the rule reads: each must be text where it is present (card 2939, ruling P8). */
const READ_FIELDS = ['type', 'client_email', 'private_key', 'private_key_id', 'universe_domain'] as const;

/** Google's own universe, the only one DumpFire backs up to. */
export const DEFAULT_UNIVERSE = 'googleapis.com';

/** What a JWT is built from: the account's address, its key, and the key's ID where it has one. */
export type ServiceAccountKey = { email: string; key: string; keyId?: string };

/** Why a service account's JSON is refused: not JSON, not a key file of Google's shape, or another universe. */
export type ServiceAccountRefusal = 'not-json' | 'not-key' | 'other-universe';

/**
 * A service account's JSON as the rule reads it: refused, or the JSON to
 * store (rebuilt) with its key, null for the key-less shape (and for '').
 */
export type ServiceAccountReading = { refusal: ServiceAccountRefusal } | { stored: string; key: ServiceAccountKey | null };

const isText = (value: unknown): value is string => typeof value === 'string';
const isFilled = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** A service account's JSON parsed once: not text, not JSON, or the value it reads as. */
function parsed(json: unknown): { kind: 'not-text' } | { kind: 'not-json' } | { kind: 'json'; value: unknown } {
	if (typeof json !== 'string') return { kind: 'not-text' };
	try {
		return { kind: 'json', value: JSON.parse(json) };
	} catch {
		// Never its message: V8 quotes the text around the fault, which can be the key.
		return { kind: 'not-json' };
	}
}

/** `account` as stored: its allowlisted fields and `private_key`, each where it is text, in its order; `private_key` emptied unless `keepKey`. */
function rebuilt(account: Entry, keepKey: boolean): string {
	const kept: [string, string][] = [];
	for (const [field, value] of Object.entries(account)) {
		if (!isText(value)) continue;
		if (field === 'private_key') kept.push([field, keepKey ? value : '']);
		else if (SERVICE_ACCOUNT_SHOWN.includes(field)) kept.push([field, value]);
	}
	return JSON.stringify(Object.fromEntries(kept));
}

/** `account`, a JSON object, read by the rule. */
function readAccount(account: Entry): ServiceAccountReading {
	if (account.type !== 'service_account') return { refusal: 'not-key' };
	for (const field of READ_FIELDS) {
		if (Object.hasOwn(account, field) && !isText(account[field])) return { refusal: 'not-key' };
	}
	if (!isFilled(account.private_key)) return { stored: rebuilt(account, true), key: null };
	if (!isFilled(account.client_email)) return { refusal: 'not-key' };
	const universe = account.universe_domain;
	if (universe !== undefined && universe !== '' && universe !== DEFAULT_UNIVERSE) return { refusal: 'other-universe' };
	const key: ServiceAccountKey = { email: account.client_email, key: account.private_key };
	if (isFilled(account.private_key_id)) key.keyId = account.private_key_id;
	return { stored: rebuilt(account, true), key };
}

/**
 * A service account's JSON, as a save reads it (card 2939, decision 3): ''
 * is nothing entered; otherwise it is parsed once, here, and refused unless
 * it is a key of Google's shape or the key-less shape a backup's copy leaves.
 * What to store is the JSON rebuilt. A refusal never carries any of the text.
 */
export function readServiceAccountJson(json: unknown): ServiceAccountReading {
	if (json === '') return { stored: '', key: null };
	const read = parsed(json);
	if (read.kind === 'not-json') return { refusal: 'not-json' };
	if (read.kind === 'not-text' || !isEntry(read.value)) return { refusal: 'not-key' };
	return readAccount(read.value);
}

/** The key a service account's JSON holds, by the rule, or null: refused, empty, or the key-less shape. */
export function serviceAccountKey(json: unknown): ServiceAccountKey | null {
	const reading = readServiceAccountJson(json);
	return 'key' in reading ? reading.key : null;
}

/** How `normalisedServiceAccount` changed a destination's JSON: rebuilt, its key cleared, or cleared whole. */
export type ServiceAccountChange = 'rebuilt' | 'key-cleared' | 'cleared';

/**
 * A destination's `serviceAccountJson` as it is to be stored (card 2939,
 * ruling P1), and how it changed (null for not at all), whatever the
 * destination's type and sign-in method. On a Google Drive destination that
 * signs in with a service account: text the save accepts, rebuilt; a
 * `service_account` object it refuses, the key-less shape (allowlisted
 * fields, `private_key` ''); anything else ''. On any other destination, an
 * OAuth one among them: ''. A field absent stays absent, and '' stays ''.
 * Brought once to this form, a JSON is not changed again.
 */
export function normalisedServiceAccount(destination: Entry): { value: unknown; change: ServiceAccountChange | null } {
	const json = destination.serviceAccountJson;
	if (json === undefined || json === '') return { value: json, change: null };
	const cleared = { value: '', change: 'cleared' as const };
	if (destination.type !== 'gdrive' || destination.authMethod === 'oauth') return cleared;
	const read = parsed(json);
	if (read.kind !== 'json' || !isEntry(read.value)) return cleared;
	const reading = readAccount(read.value);
	if ('stored' in reading) return { value: reading.stored, change: reading.stored === json ? null : 'rebuilt' };
	if (read.value.type !== 'service_account') return cleared;
	const keyless = rebuilt(read.value, false);
	return { value: keyless, change: keyless === json ? null : 'key-cleared' };
}
