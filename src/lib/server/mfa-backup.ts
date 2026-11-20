/**
 * mfa-backup.ts — what a restore does with two-step sign-in's rows (card
 * 2768).
 *
 * A backup holds every account's second factors, sealed, and its recovery
 * codes, as hashes, and `settings.mfa_key_check`; never the key, which is in
 * a file of its own (mfa-key.ts), and never a pending sign-in or an
 * enrolment link (`withoutSecrets`, backup.ts). The restore copies none of
 * the four tables and not the key check (`rowsToRestore`, restore.ts): it
 * puts their rows back here, inside its own transaction, by these rules.
 *
 * - An account is the same one here and in the backup when its id and its
 *   `created_at` are, both written once and never changed: never by its
 *   username, which a rename changes. The two `created_at` are compared as the
 *   moments they name (`toStamp`), and one that names none matches nothing,
 *   so a doubt is a different account. Such an account keeps this server's
 *   factors and codes as they are now, so that a factor removed since the
 *   backup stays removed, a code used since stays used and a step spent
 *   since stays spent.
 * - Any other account has the backup's rows only when the backup's seal
 *   verified with this server's key (made here, changed by nobody since) and
 *   its key check, read from the backup's own `settings` storage, is this
 *   server's MFA key's: otherwise none of its rows, and it is named as left
 *   out, with why (the seal did not verify, no key is loaded, or the key
 *   differs).
 * - Every account's guessing counters and pauses are zeroed. The same
 *   accounts keep this server's last sign-in, failed-code count and banner;
 *   any other has the backup's.
 * - Every account's leave to set up on its password alone
 *   (`mfa_password_enrol`, card 2769) is zeroed, and the same accounts then
 *   have this server's back: a backup gives it to no account, and a reset
 *   made here since the backup stays made.
 * - The key check is this key's when any factor exists afterwards; with none
 *   it is this server's as it was.
 *
 * Takes both connections as arguments, as backup-secrets.ts does, and runs
 * raw statements only: the restore's transaction is better-sqlite3's own on
 * `live`, in which `inTransaction` refuses to run. Every read of the backup
 * first asks whether its table is there, as the restore asks of
 * `work_dependencies`, so a backup made before migration 0065 restores, and
 * reads each table from its own rows (`fromTableStorage`), as the seal is
 * made. The live side is asked the same way. An insert that fails is not
 * caught: the restore rolls back.
 */
import type Database from 'better-sqlite3';
import { toStamp } from '$lib/timestamps';
import { fromTableStorage } from './backup-secrets';
import { MFA_KEY_CHECK_SETTING, type MfaKey } from './mfa-key';
import { readMfaKeyCheck } from './mfa-store';
import { anythingSealed } from './stored-secrets';

/** The tables no restore copies: this module puts back the first two, and the other two are never brought in. */
export const MFA_ROWS_NOT_RESTORED = ['mfa_factors', 'mfa_recovery_codes', 'sign_in_challenges', 'enrolment_links'] as const;

/**
 * An account's sign-in history, which the same account keeps from this server
 * across a restore; and its leave to set up two-step sign-in on its password
 * alone (card 2769), so that a reset made here since the backup stays made.
 */
const HISTORY = [
	'last_sign_in_at',
	'last_sign_in_from',
	'failed_codes_since_sign_in',
	'security_banner',
	'security_banner_at',
	'mfa_password_enrol',
	// Migration 0069 (card 2772's code review, CS1): the latest signal's moment, kept with the banner it qualifies.
	'security_signal_last_at'
] as const;

/**
 * Every account's guessing counters and pauses, as a restore leaves them; and
 * its leave to set up on its password alone, which only the same account then
 * has back (`HISTORY`): no backup gives it to any other (card 2769, decision 18).
 */
const GUESSING: Record<string, number | null> = {
	mfa_known_wrong: 0,
	mfa_other_wrong: 0,
	mfa_known_resumes_at: null,
	mfa_other_resumes_at: null,
	mfa_recovery_wrong: 0,
	mfa_recovery_resumes_at: null,
	mfa_password_enrol: 0
};

/** What this server held before the restore cleared it. */
export type MfaHere = {
	/** Each account's id and its `created_at`: what makes it the same account. */
	accounts: Map<number, string>;
	/** Every factor row, every column but `id`. */
	factors: Record<string, unknown>[];
	/** Every recovery code row, every column but `id`. */
	codes: Record<string, unknown>[];
	/** Each account's sign-in history (`HISTORY`), by id. */
	detection: Map<number, Record<string, unknown>>;
	/** `settings.mfa_key_check` here, or null. */
	keyCheck: string | null;
};

/** What a restore did with the second factors. */
export type MfaRestore = {
	/** Accounts that got this server's factors or codes back, being the same account here. */
	keptFromHere: number;
	/** Accounts that got the backup's factors or codes. */
	takenFromBackup: number;
	/** Usernames whose factors or codes in the backup were left out. */
	leftOut: string[];
	/**
	 * Why they were: the backup's seal did not verify (`unsealed`), it did and
	 * this server has no MFA key loaded (`no key`), or it did and its key check
	 * is not this key's (`key differs`). Null when none was.
	 */
	leftOutBecause: 'unsealed' | 'no key' | 'key differs' | null;
	/** Usernames, by id, of the accounts with no factor, once two-step sign-in is in use; otherwise none. */
	withoutFactor: string[];
};

const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

const hasTable = (database: Database.Database, table: string) =>
	!!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

/** The columns of `table`, none where it is not there. */
const columnsOf = (database: Database.Database, table: string): string[] =>
	hasTable(database, table)
		? (database.prepare(`PRAGMA table_info(${quoted(table)})`).all() as { name: string }[]).map((column) => column.name)
		: [];

function withoutId(row: Record<string, unknown>): Record<string, unknown> {
	const { id: _id, ...rest } = row;
	return rest;
}

/** The rows of an MFA table, every column but `id`, from its own storage; none where it, or its `user_id`, is not there. */
function rowsOf(database: Database.Database, table: string): Record<string, unknown>[] {
	if (!columnsOf(database, table).includes('user_id')) return [];
	return (database.prepare(fromTableStorage(database, table)).all() as Record<string, unknown>[]).map(withoutId);
}

/** `rows` by their account. */
function byAccount(rows: readonly Record<string, unknown>[]): Map<number, Record<string, unknown>[]> {
	const grouped = new Map<number, Record<string, unknown>[]>();
	for (const row of rows) {
		const userId = Number(row.user_id);
		grouped.set(userId, [...(grouped.get(userId) ?? []), row]);
	}
	return grouped;
}

/**
 * This server's accounts, factors, codes, sign-in history and key check, read
 * before the restore clears anything. Reads, and writes nothing.
 */
export function readMfaHere(live: Database.Database): MfaHere {
	const accounts = new Map<number, string>();
	const detection = new Map<number, Record<string, unknown>>();
	const userColumns = columnsOf(live, 'users');
	if (userColumns.includes('id') && userColumns.includes('created_at')) {
		const history = HISTORY.filter((column) => userColumns.includes(column));
		const rows = live
			.prepare(`SELECT id, created_at${history.map((column) => `, ${quoted(column)}`).join('')} FROM users`)
			.all() as Record<string, unknown>[];
		for (const row of rows) {
			const id = Number(row.id);
			if (typeof row.created_at === 'string') accounts.set(id, row.created_at);
			detection.set(id, Object.fromEntries(history.map((column) => [column, row[column]])));
		}
	}
	return {
		accounts,
		factors: rowsOf(live, 'mfa_factors'),
		codes: rowsOf(live, 'mfa_recovery_codes'),
		detection,
		keyCheck: readMfaKeyCheck(live)
	};
}

/**
 * The backup's `settings.mfa_key_check`, read from the table's own storage
 * (`fromTableStorage`) as every other read of the backup is, never through an
 * index: null where the table or its two columns are not there, where no row
 * holds it, or where more than one does, so that a doubt never takes the
 * backup's factors. `readMfaKeyCheck` (mfa-store.ts) is for this server's own
 * database.
 */
export function readBackupMfaKeyCheck(backup: Database.Database): string | null {
	const columns = columnsOf(backup, 'settings');
	if (!columns.includes('key') || !columns.includes('value')) return null;
	const rows = backup.prepare(fromTableStorage(backup, 'settings', 'key = ?')).all(MFA_KEY_CHECK_SETTING) as {
		value: unknown;
	}[];
	if (rows.length !== 1 || typeof rows[0].value !== 'string') return null;
	return rows[0].value;
}

/** Whether two `created_at` name the same moment: false when either names none (`toStamp`). */
function sameMoment(a: unknown, b: unknown): boolean {
	const left = toStamp(a);
	const right = toStamp(b);
	return left !== null && right !== null && left === right;
}

/** Insert `rows` into `table` in `live`, without `id` and in the columns `live` has. Not caught. */
function insertInto(live: Database.Database, table: 'mfa_factors' | 'mfa_recovery_codes', rows: readonly Record<string, unknown>[]): void {
	if (rows.length === 0) return;
	const liveColumns = columnsOf(live, table);
	const columns = Object.keys(rows[0]).filter((column) => column !== 'id' && liveColumns.includes(column));
	const into = `(${columns.map(quoted).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
	// Each table named in its SQL, so that the source scans see which one is written.
	const insert = live.prepare(
		table === 'mfa_factors' ? `INSERT INTO mfa_factors ${into}` : `INSERT INTO mfa_recovery_codes ${into}`
	);
	for (const row of rows) insert.run(...columns.map((column) => row[column]));
}

/**
 * Put the second factors and recovery codes back after the restore's copy,
 * inside its transaction, by the rules in the header; zero every account's
 * guessing counters; give the same accounts this server's sign-in history;
 * and set the key check. `here` is `readMfaHere(live)` from before the clear,
 * `sealVerified` the restore's verdict on the backup's seal, and `key` this
 * server's MFA key, or null where it has none.
 *
 * `ended` is what the record of account endings ruled of the restored accounts
 * (card 2996, decision 4): one ruled deleted, or one this server had before it
 * recorded endings, gets no factor and no code from anywhere; one ruled
 * disabled gets this server's own where it is the same account here, and never
 * the backup's. None of them is named in `leftOut` or `withoutFactor`: the
 * answer names no account the record ended.
 */
export function restoreMfaRows(
	live: Database.Database,
	backup: Database.Database,
	here: MfaHere,
	options: { sealVerified: boolean; key: MfaKey | null; ended?: ReadonlyMap<number, 'deleted' | 'before record' | 'disabled'> }
): MfaRestore {
	const result: MfaRestore = { keptFromHere: 0, takenFromBackup: 0, leftOut: [], leftOutBecause: null, withoutFactor: [] };
	const userColumns = columnsOf(live, 'users');
	if (!userColumns.includes('id') || !userColumns.includes('created_at')) return result;

	const restoredAccounts = live
		.prepare(`SELECT id, created_at, ${userColumns.includes('username') ? 'username' : 'CAST(id AS TEXT) AS username'} FROM users ORDER BY id`)
		.all() as { id: number; created_at: unknown; username: string }[];

	const hereFactors = byAccount(here.factors);
	const hereCodes = byAccount(here.codes);
	const backupFactors = byAccount(rowsOf(backup, 'mfa_factors'));
	const backupCodes = byAccount(rowsOf(backup, 'mfa_recovery_codes'));
	const backupTaken =
		options.sealVerified && options.key !== null && readBackupMfaKeyCheck(backup) === options.key.check;
	const factorsHere = hasTable(live, 'mfa_factors');
	const codesHere = hasTable(live, 'mfa_recovery_codes');

	// 1. Each restored account's factors and codes: this server's for the same
	// account, the backup's only when it is to be taken, and otherwise none.
	const same: { id: number; createdAt: string }[] = [];
	for (const account of restoredAccounts) {
		const matched = here.accounts.has(account.id) && sameMoment(here.accounts.get(account.id), account.created_at);
		// The record of account endings first (card 2996): an ended account gets none, and is named nowhere; a disabled
		// one only this server's own, where it is the same account here.
		const ruled = options.ended?.get(account.id);
		if (ruled === 'deleted' || ruled === 'before record' || (ruled === 'disabled' && !matched)) continue;
		const from = matched
			? { factors: hereFactors.get(account.id) ?? [], codes: hereCodes.get(account.id) ?? [] }
			: { factors: backupFactors.get(account.id) ?? [], codes: backupCodes.get(account.id) ?? [] };
		if (matched) same.push({ id: account.id, createdAt: account.created_at as string });
		const held = from.factors.length + from.codes.length > 0;
		if (!matched && !backupTaken) {
			if (held) result.leftOut.push(account.username);
			continue;
		}
		if (factorsHere) insertInto(live, 'mfa_factors', from.factors);
		if (codesHere) insertInto(live, 'mfa_recovery_codes', from.codes);
		if (held && matched) result.keptFromHere++;
		if (held && !matched) result.takenFromBackup++;
	}
	if (result.leftOut.length > 0) {
		result.leftOutBecause = !options.sealVerified ? 'unsealed' : options.key === null ? 'no key' : 'key differs';
	}

	// 2. Every account's guessing counters and pauses, zeroed.
	const guessing = Object.keys(GUESSING).filter((column) => userColumns.includes(column));
	if (guessing.length > 0) {
		live
			.prepare(`UPDATE users SET ${guessing.map((column) => `${quoted(column)} = ?`).join(', ')}`)
			.run(...guessing.map((column) => GUESSING[column]));
	}

	// 3. The same accounts' sign-in history, as this server had it.
	for (const account of same) {
		const history = Object.entries(here.detection.get(account.id) ?? {}).filter(([column]) => userColumns.includes(column));
		if (history.length === 0) continue;
		live
			.prepare(`UPDATE users SET ${history.map(([column]) => `${quoted(column)} = ?`).join(', ')} WHERE id = ? AND created_at = ?`)
			.run(...history.map(([, value]) => value), account.id, account.createdAt);
	}

	// 4. The key check: this key's when any factor exists now; otherwise the
	// one recorded in this restore with a stored secret sealed in it (card
	// 2898, S2: the restore's form key, and any secret `rowsToRestore`
	// sealed, were written under this server's key, which recorded it);
	// otherwise this server's as it was. The backup's is never copied
	// (rowsToRestore).
	const factorsNow = factorsHere ? (live.prepare('SELECT COUNT(*) AS n FROM mfa_factors').get() as { n: number }).n : 0;
	const recordedNow = anythingSealed(live) ? readMfaKeyCheck(live) : null;
	const check = factorsNow > 0 && options.key !== null ? options.key.check : (recordedNow ?? here.keyCheck);
	const settingsColumns = columnsOf(live, 'settings');
	if (check !== null && settingsColumns.includes('key') && settingsColumns.includes('value')) {
		live
			.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
			.run(MFA_KEY_CHECK_SETTING, check);
	}

	// 5. Who has no factor, once two-step sign-in is in use: a factor in the
	// restored data, or one of the backup's left out.
	if (factorsHere && (factorsNow > 0 || result.leftOut.length > 0)) {
		result.withoutFactor = (
			live
				.prepare(
					`SELECT id, ${userColumns.includes('username') ? 'username' : 'CAST(id AS TEXT)'} AS name FROM users u ` +
						'WHERE NOT EXISTS (SELECT 1 FROM mfa_factors f WHERE f.user_id = u.id) ORDER BY u.id'
				)
				.all() as { id: number; name: string }[]
		)
			// No account the record of account endings ended is named (card 2996).
			.filter((row) => !options.ended?.has(row.id))
			.map((row) => row.name);
	}

	return result;
}

/** Why an account's second factors in the backup were left out, in plain words. */
const LEFT_OUT_BECAUSE: Record<NonNullable<MfaRestore['leftOutBecause']>, string> = {
	unsealed: 'the backup was not made by this server, or was changed after it was made',
	'no key': 'no MFA key is loaded on this server',
	'key differs': 'the backup was made under a different MFA key'
};

/**
 * What the import says of the second factors after a restore, or null when
 * there is nothing to say: the accounts left with no second factor, and of
 * those whose factors in the backup were left out, why; then, once, when any
 * account's rows were taken from the backup, that their recovery codes are
 * as they were then.
 */
export function mfaWithoutFactorSentence(mfa: {
	readonly withoutFactor: readonly string[];
	readonly leftOut: readonly string[];
	readonly leftOutBecause: MfaRestore['leftOutBecause'];
	readonly takenFromBackup: number;
}): string | null {
	const said: string[] = [];
	if (mfa.withoutFactor.length > 0) {
		said.push(
			`${mfa.withoutFactor.length} account(s) have no second factor after this restore and each needs its two-step ` +
				`sign-in reset before it can sign in: ${mfa.withoutFactor.join(', ')}.`
		);
	}
	if (mfa.leftOut.length > 0 && mfa.leftOutBecause !== null) {
		said.push(
			`Their second factors in the backup were left out because ${LEFT_OUT_BECAUSE[mfa.leftOutBecause]}: ` +
				`${mfa.leftOut.join(', ')}.`
		);
	}
	if (mfa.takenFromBackup > 0) {
		said.push(
			'Accounts brought back from the backup have their recovery codes as they were then; ask them to regenerate ' +
				'their codes.'
		);
	}
	if (said.length === 0) return null;
	return `${said.join(' ')} See docs/admin-guide.md, Restoring from Backup.`;
}
