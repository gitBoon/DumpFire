/**
 * key-revocations.ts — the record of every API key ended on this server (card 2995, migration 0076).
 *
 * A row of `api_key_revocations` says that the key with this row id and this SHA-256 was ended here: revoked, ended
 * with its account's access, deleted with its account, cleared by Reset Everything, or gone before the record existed.
 * It holds the hash the gate checks a key by, never the key. The record is this server's, as the system log is: a
 * restore never clears it and adds the backup's rows to it, Reset Everything keeps it, and no write deletes, changes
 * or replaces a row of it.
 *
 * A seed row (`key_hash` '') names a key by its id alone: migration 0076 wrote one for every id up to the watermark W
 * that `api_keys` no longer held, whose hash nobody knew. It names a key only where that id is at most W (the plan
 * review's R1): W is the larger of the id counter and the largest id held when the record began, read from the
 * watermark rows (`key_hash` 'watermark'). With no watermark row, every seed row names its id (fail closed).
 *
 * This module imports only the database's types and the stored form of a moment: auth.ts, webhooks.ts and the restore
 * all read it.
 */
import type Database from 'better-sqlite3';
import { stamp } from '$lib/timestamps';

/** The table, by its name. */
export const KEY_RECORD_TABLE = 'api_key_revocations';

/** The `key_hash` of a watermark row (R1): neither '' nor a SHA-256, so it never names a key. */
export const WATERMARK = 'watermark';

/**
 * Why a key was ended here, as `revoked_because` records it: on the Account page; with its account's access (an
 * administrator's password set, an invite used, the holder's own change ending keys, a two-step reset, a disable, and
 * the restore's carry of a disable); with its account; by Reset Everything (R5); before the record existed (the seed,
 * and the hash belt, R2); and a backup's row whose word this build does not know.
 */
export const REVOKED_BECAUSE = {
	revoked: 'revoked',
	accessEnded: 'access ended',
	accountDeleted: 'account deleted',
	reset: 'reset',
	beforeRecord: 'before record',
	inABackup: 'recorded in a backup'
} as const;

export type RevokedBecause = (typeof REVOKED_BECAUSE)[keyof typeof REVOKED_BECAUSE];

/** Every word `revoked_because` may hold. */
export const REVOKED_BECAUSE_WORDS: readonly string[] = Object.values(REVOKED_BECAUSE);

/** W as SQL: the largest watermark, or NULL where there is none. */
const WATERMARK_SQL = `(SELECT max(kr_w.key_id) FROM api_key_revocations AS kr_w WHERE kr_w.key_hash = '${WATERMARK}')`;

/**
 * The one rule, as a SELECT that has a row where the record names the key whose id is `id` and whose hash is `hash`
 * (both SQL expressions): a row of its hash; or a seed row of its id, where that id is at most W (R1). The gate's
 * statement (`keyRecorded`) and the restore's leave-out (`DELETE ... WHERE EXISTS (...)`, R6) share it, so they
 * cannot disagree. Each half is a search on the primary key (key_hash, key_id) (R9).
 */
export function keyRecordedSelect(id: string, hash: string): string {
	return `SELECT 1 FROM api_key_revocations AS kr_h WHERE kr_h.key_hash = ${hash} UNION ALL ${seedNames(id)}`;
}

/**
 * The seed's half of the rule, as a SELECT that has a row where a seed row (`key_hash` '') names the id `id` (an SQL
 * expression) and that id is at most W (R1). `keyRecordedSelect` and the restore's hash belt are both built from it,
 * so the two cannot disagree on which keys a seed row names (card 2995's code review, FP7).
 */
export function seedNames(id: string): string {
	return `SELECT 1 FROM api_key_revocations AS kr_s WHERE kr_s.key_hash = '' AND kr_s.key_id = ${id} AND ${id} <= coalesce(${WATERMARK_SQL}, ${id})`;
}

/** The rule as a condition on a row of `api_keys` read as `id` and `hash`: `EXISTS (keyRecordedSelect)`. */
export function keyRecordedWhere(id: string, hash: string): string {
	return `EXISTS (${keyRecordedSelect(id, hash)})`;
}

/** The gate's statement (R9: three searches on the key, no scan). */
export const KEY_RECORDED_SQL = `${keyRecordedSelect('@id', '@hash')} LIMIT 1`;

const recordedStatements = new WeakMap<Database.Database, Database.Statement>();

/**
 * Whether the record names this key (`keyRecordedWhere`). One prepared statement per connection. Asked by `keyEnded`
 * in auth.ts, so by the gate, `stillAuthenticated`, every list of live keys and the webhooks' hold rule (R7).
 */
export function keyRecorded(database: Database.Database, key: { id: number; keyHash: string }): boolean {
	let statement = recordedStatements.get(database);
	if (statement === undefined) {
		statement = database.prepare(KEY_RECORDED_SQL);
		recordedStatements.set(database, statement);
	}
	return statement.get({ id: key.id, hash: key.keyHash }) !== undefined;
}

/** W as this server's record holds it: the largest watermark, or null where there is none. */
export function watermarkOf(database: Database.Database): number | null {
	const row = database.prepare(`SELECT ${WATERMARK_SQL} AS w`).get() as { w: number | null };
	return row.w === null ? null : Number(row.w);
}

/** Which keys an ending ends: one key, an account's keys, or every key (Reset Everything, R5). */
export type KeyScope = { keyId: number } | { userId: number } | { every: true };

/** A scope as SQL over `api_keys`, with its parameters. */
function scopeOf(scope: KeyScope): { where: string; params: Record<string, number> } {
	if ('keyId' in scope) return { where: 'id = @keyId', params: { keyId: scope.keyId } };
	if ('userId' in scope) return { where: 'user_id = @userId', params: { userId: scope.userId } };
	return { where: '1 = 1', params: {} };
}

/**
 * The record's statement for the keys of `where` (`@at` the moment, `@because` the word): every one's id and hash,
 * `INSERT OR IGNORE`, a key already recorded keeping its first row. A row whose hash is '' or the watermark's is not
 * one a key holds, and records nothing.
 */
function recordKeysEndedSql(where: string): string {
	return (
		'INSERT OR IGNORE INTO api_key_revocations (key_id, key_hash, revoked_at, revoked_because) ' +
		`SELECT id, key_hash, @at, @because FROM api_keys WHERE ${where} AND key_hash NOT IN ('', '${WATERMARK}')`
	);
}

/**
 * The account form of the record's statement (`@userId`, `@at`, `@because`): scripts/mfa-reset.mjs runs its own copy
 * word for word before it deletes an account's keys, and tests/mfa-reset-script.test.ts compares the two.
 */
export const RECORD_ACCOUNT_KEYS_ENDED_SQL = recordKeysEndedSql('user_id = @userId');

/**
 * End the API keys of `scope` on `database`, recording each first (card 2995): the record's statement, then the
 * delete, in the caller's transaction, so that a key is never deleted unrecorded nor recorded and kept. Every ender
 * calls it: the revoke (`revokeApiKeys`), an ending of an account's access (`endAccountAccess`), `deleteUser`, the
 * restore's carry of a disable (`carryDisabled`) and Reset Everything; the host's reset runs its own copy
 * (`RECORD_ACCOUNT_KEYS_ENDED_SQL`). Asks `inTransaction` of the connection it is given, not of the server's (R14),
 * and throws without writing when none is open. Returns the ids deleted, in order.
 */
export function endApiKeys(database: Database.Database, scope: KeyScope, because: RevokedBecause): number[] {
	if (!database.inTransaction) {
		throw new Error('endApiKeys records and deletes keys inside the transaction of the ending, and none is open on the connection it was given');
	}
	const { where, params } = scopeOf(scope);
	database.prepare(recordKeysEndedSql(where)).run({ ...params, at: stamp(), because });
	return (database.prepare(`DELETE FROM api_keys WHERE ${where} RETURNING id`).all(params) as { id: number }[]).map((row) => row.id).sort((a, b) => a - b);
}

/**
 * Raise the `api_keys` id counter to the largest id any row of the record names, the watermark W and every hashed and
 * seed row alike, in SQL with `max()`, writing its row where there is none (R6, widened by card 2995's code review,
 * FP1): so this server's counter never sits below an id its record names, and a key made here never takes one: a seed
 * row's id would refuse it, and a hashed row's id would be an id issued twice. Run in every restore and at every start.
 * Opens no transaction; the caller's holds it.
 */
export function raiseKeyCounterOverRecord(database: Database.Database): void {
	const named = '(SELECT max(key_id) FROM api_key_revocations)';
	database.prepare(`UPDATE sqlite_sequence SET seq = max(seq, coalesce(${named}, 0)) WHERE name = 'api_keys'`).run();
	database
		.prepare(
			`INSERT INTO sqlite_sequence (name, seq) SELECT 'api_keys', ${named} ` +
				`WHERE coalesce(${named}, 0) > 0 AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'api_keys')`
		)
		.run();
}
