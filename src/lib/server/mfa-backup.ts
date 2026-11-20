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
 *   `created_at` are, both written once and never changed (`sameAccountHere`,
 *   card 3009). The two `created_at` are compared as the moments they name
 *   (`toStamp`), and one that names none matches nothing, so a doubt is a
 *   different account. For a backup whose seal verified, or one that carries
 *   this installation's id, that is all; one that carries another
 *   installation's id, or a malformed one, matches no account; and one that
 *   carries none (made before card 3009) matches only where the username is
 *   the same too, the one place a username counts, so that an account renamed
 *   since is not matched there. Such an account keeps this server's
 *   factors and codes as they are now, so that a factor removed since the
 *   backup stays removed, a code used since stays used and a step spent
 *   since stays spent.
 * - Any other account has the backup's rows only when the backup's seal
 *   verified with this server's key (made here, changed by nobody since) and
 *   its key check, read from the backup's own `settings` storage, is this
 *   server's MFA key's: otherwise none of its rows, and it is named as left
 *   out, with why (the seal did not verify, no key is loaded, or the key
 *   differs). Where the seal did not verify, the accounts that are not the
 *   same here are counted and never named (card 3009, R10).
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
import { fromTableStorage, type Installation } from './backup-secrets';
import { MFA_KEY_CHECK_SETTING, type MfaKey } from './mfa-key';
import { factorAad, openSealed, sealWith } from './mfa-crypto';
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
	/** Each account's id, with its `created_at` and its username (card 3009): what makes it the same account (`sameAccountHere`). */
	accounts: Map<number, { createdAt: string; username: unknown }>;
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
	/** Usernames whose factors or codes in the backup were left out: only where its seal verified (card 3009, R10: `notSameHere`). */
	leftOut: string[];
	/**
	 * Why they were: the backup's seal did not verify (`unsealed`), it did and
	 * this server has no MFA key loaded (`no key`), or it did and its key check
	 * is not this key's (`key differs`). Null when none was.
	 */
	leftOutBecause: 'unsealed' | 'no key' | 'key differs' | null;
	/**
	 * Usernames, by id, of the accounts with no factor, once two-step sign-in is in use; otherwise none. Only where the
	 * backup's seal verified: an unsealed import names no account from the file's text (card 3009's code review, FP7).
	 */
	withoutFactor: string[];
	/**
	 * Where the backup's seal did not verify (FP7): how many accounts that are the same here have no factor, once two-step
	 * sign-in is in use, counted and never named, as their usernames as restored are the file's. 0 for a sealed backup.
	 */
	withoutFactorUnnamed: number;
	/**
	 * Whether the importer's authenticators, carried to the backup's superadmin (`carryFactors`, restore.ts), are the
	 * first second factors on this server, so that two-step sign-in is in use from this restore (FP12).
	 */
	firstFactorsCarried: boolean;
	/**
	 * Where the backup's seal did not verify (card 3009, R10): how many accounts that are not the same here have no
	 * factor, once two-step sign-in is in use, counted and never named; their factors in the backup, where they held
	 * any, are left out (`leftOutBecause`), and are not in `leftOut`. 0 for a backup whose seal verified.
	 */
	notSameHere: number;
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
	const accounts: MfaHere['accounts'] = new Map();
	const detection = new Map<number, Record<string, unknown>>();
	const userColumns = columnsOf(live, 'users');
	if (userColumns.includes('id') && userColumns.includes('created_at')) {
		const history = HISTORY.filter((column) => userColumns.includes(column));
		// The username beside the creation time (card 3009): a backup that carries no installation id asks it too.
		const username = userColumns.includes('username') ? 'username' : 'NULL';
		const rows = live
			.prepare(`SELECT id, created_at, ${username} AS username${history.map((column) => `, ${quoted(column)}`).join('')} FROM users`)
			.all() as Record<string, unknown>[];
		for (const row of rows) {
			const id = Number(row.id);
			if (typeof row.created_at === 'string') accounts.set(id, { createdAt: row.created_at, username: row.username });
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

/**
 * Whether two `created_at` name the same moment: false when either names none (`toStamp`). Shared with the restore's
 * password rulings (card 2997's code review, FP10), which ask "the same account here" as this module does.
 */
export function sameMoment(a: unknown, b: unknown): boolean {
	const left = toStamp(a);
	const right = toStamp(b);
	return left !== null && right !== null && left === right;
}

/**
 * What a restore knows of a backup that decides whether a restored account is the same account here (card 3009):
 * whether its seal verified with this server's key, and what its installation id says (`installationOf`).
 */
export type GrantTrust = { sealVerified: boolean; installation: Installation };

/**
 * The one rule for anything this server grants a restored account from what it held before the restore (card 3009,
 * section 3.3): its second factors, codes, sign-in history and enrol leave (`restoreMfaRows`), and its password
 * (`applyPasswordRulings`, restore.ts). False where this server held no account of that id (`here` undefined) or its
 * `created_at` is not the same moment (`sameMoment`); otherwise true for a sealed backup or one carrying this
 * installation's id, false for one carrying another's (or a malformed one), and, for one carrying none, true only
 * where the username is exactly the same. Rules that restrict, `carryDisabled` and the record of account endings,
 * keep id and `created_at` alone: a stricter identity there would fail open.
 *
 * Forging it gains nothing: a match gives an account back only this server's own password, factors and keys for that
 * id, which only that account's holder has.
 */
export function sameAccountHere(
	here: { createdAt: unknown; username: unknown } | undefined,
	restored: { createdAt: unknown; username: unknown },
	trust: GrantTrust
): boolean {
	if (here === undefined || !sameMoment(here.createdAt, restored.createdAt)) return false;
	if (trust.sealVerified || trust.installation === 'this') return true;
	if (trust.installation === 'other') return false;
	return typeof here.username === 'string' && here.username === restored.username;
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
 * `trust` the restore's verdict on the backup's seal and its installation id,
 * which decide the same account here (`sameAccountHere`, card 3009), and `key`
 * this server's MFA key, or null where it has none.
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
	options: { trust: GrantTrust; key: MfaKey | null; ended?: ReadonlyMap<number, 'deleted' | 'before record' | 'disabled'> }
): MfaRestore {
	const result: MfaRestore = { ...NO_MFA_RESTORE, leftOut: [], withoutFactor: [] };
	const sealVerified = options.trust.sealVerified;
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
		sealVerified && options.key !== null && readBackupMfaKeyCheck(backup) === options.key.check;
	const factorsHere = hasTable(live, 'mfa_factors');
	const codesHere = hasTable(live, 'mfa_recovery_codes');

	// 1. Each restored account's factors and codes: this server's for the same
	// account, the backup's only when it is to be taken, and otherwise none.
	const same: { id: number; createdAt: string }[] = [];
	// The accounts whose rows in the backup were left out, named in `leftOut` only where the seal verified (R10).
	let leftOutCount = 0;
	for (const account of restoredAccounts) {
		const matched = sameAccountHere(here.accounts.get(account.id), { createdAt: account.created_at, username: account.username }, options.trust);
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
			if (held) {
				leftOutCount++;
				if (sealVerified) result.leftOut.push(account.username);
			}
			continue;
		}
		if (factorsHere) insertInto(live, 'mfa_factors', from.factors);
		if (codesHere) insertInto(live, 'mfa_recovery_codes', from.codes);
		if (held && matched) result.keptFromHere++;
		if (held && !matched) result.takenFromBackup++;
	}
	if (leftOutCount > 0) {
		result.leftOutBecause = !sealVerified ? 'unsealed' : options.key === null ? 'no key' : 'key differs';
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
	if (factorsHere && (factorsNow > 0 || leftOutCount > 0)) Object.assign(result, accountsWithoutFactor(live, here, options));

	return result;
}

/** A restore's second factors before anything is done (`MfaRestore`). */
export const NO_MFA_RESTORE: MfaRestore = {
	keptFromHere: 0,
	takenFromBackup: 0,
	leftOut: [],
	leftOutBecause: null,
	withoutFactor: [],
	withoutFactorUnnamed: 0,
	notSameHere: 0,
	firstFactorsCarried: false
};

/**
 * The restored accounts with no second factor, as `restoreMfaRows` says them once two-step sign-in is in use, read from
 * `live` as it is now; by `restoreMfaRows`, and by the restore again after the carry of the importer's authenticators
 * (card 3009's code review, FP12), which can be the first. None the record of account endings ended (card 2996). Where
 * the backup's seal verified, each named; otherwise none is (FP7): those that are the same here (`sameAccountHere`,
 * under `trust`, by `here.accounts` from before the clear) counted in `withoutFactorUnnamed`, the others in
 * `notSameHere` (R10). Reads.
 */
export function accountsWithoutFactor(
	live: Database.Database,
	here: MfaHere,
	options: { trust: GrantTrust; ended?: ReadonlyMap<number, 'deleted' | 'before record' | 'disabled'> }
): Pick<MfaRestore, 'withoutFactor' | 'withoutFactorUnnamed' | 'notSameHere'> {
	const userColumns = columnsOf(live, 'users');
	const without = (
		live
			.prepare(
				`SELECT id, created_at AS createdAt, ${userColumns.includes('username') ? 'username' : 'CAST(id AS TEXT)'} AS name FROM users u ` +
					'WHERE NOT EXISTS (SELECT 1 FROM mfa_factors f WHERE f.user_id = u.id) ORDER BY u.id'
			)
			.all() as { id: number; createdAt: unknown; name: string }[]
	)
		// No account the record of account endings ended is named (card 2996).
		.filter((row) => !options.ended?.has(row.id));
	if (options.trust.sealVerified) return { withoutFactor: without.map((row) => row.name), withoutFactorUnnamed: 0, notSameHere: 0 };
	// Where the seal did not verify, every username is only the file's word: none is named (R10, FP7).
	const same = without.filter((row) => sameAccountHere(here.accounts.get(row.id), { createdAt: row.createdAt, username: row.name }, options.trust)).length;
	return { withoutFactor: [], withoutFactorUnnamed: same, notSameHere: without.length - same };
}

/**
 * The importing account's authenticators given to the backup's superadmin it carries its password to (card 3009, R1;
 * `applyPasswordRulings`, restore.ts), inside the restore's transaction, after `restoreMfaRows`: each factor `from` held
 * on this server before the clear (`here.factors`, `readMfaHere`), of `key` and opening with it under `factorAad(from,
 * uid)`, sealed again under `factorAad(to, uid)` and inserted for `to`, as it was in every other column. Its recovery
 * codes do not move. A factor of another key, or one that does not open, is not carried, and nothing names it. Where any
 * was, the key check is this key's, as `restoreMfaRows` sets it once a factor exists. Returns how many were. Not caught.
 */
export function carryFactors(live: Database.Database, here: MfaHere, key: MfaKey, from: number, to: number): number {
	if (!hasTable(live, 'mfa_factors')) return 0;
	const carried: Record<string, unknown>[] = [];
	for (const factor of here.factors) {
		if (Number(factor.user_id) !== from || factor.key_id !== key.id || typeof factor.factor_uid !== 'string') continue;
		const secret = openSealed(key, { nonce: String(factor.secret_nonce), ciphertext: String(factor.secret_ciphertext) }, factorAad(from, factor.factor_uid));
		if (secret === null) continue;
		try {
			const sealed = sealWith(key, secret, factorAad(to, factor.factor_uid));
			carried.push({ ...factor, user_id: to, key_id: sealed.keyId, secret_nonce: sealed.nonce, secret_ciphertext: sealed.ciphertext });
		} finally {
			secret.fill(0);
		}
	}
	insertInto(live, 'mfa_factors', carried);
	const settingsColumns = columnsOf(live, 'settings');
	if (carried.length > 0 && settingsColumns.includes('key') && settingsColumns.includes('value')) {
		live
			.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
			.run(MFA_KEY_CHECK_SETTING, key.check);
	}
	return carried.length;
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
 * as they were then. Where the backup's seal did not verify, the accounts that
 * are not the same here are counted and not named (card 3009, R10).
 */
export function mfaWithoutFactorSentence(mfa: {
	readonly withoutFactor: readonly string[];
	readonly leftOut: readonly string[];
	readonly leftOutBecause: MfaRestore['leftOutBecause'];
	readonly takenFromBackup: number;
	readonly notSameHere?: number;
	readonly withoutFactorUnnamed?: number;
	readonly firstFactorsCarried?: boolean;
}): string | null {
	const said: string[] = [];
	const notSameHere = mfa.notSameHere ?? 0;
	const unnamed = mfa.withoutFactorUnnamed ?? 0;
	// Card 3009's code review, FP12: the carry switched two-step sign-in on, as it says before who now needs a reset.
	if (mfa.firstFactorsCarried === true) {
		said.push(
			"Your authenticators, given to the backup's superadmin, are the first second factors on this server, so two-step sign-in " +
				'is in use from this restore: every other account needs a second factor before it can sign in.'
		);
	}
	if (mfa.withoutFactor.length > 0) {
		said.push(
			`${mfa.withoutFactor.length} account(s) have no second factor after this restore and each needs its two-step ` +
				`sign-in reset before it can sign in: ${mfa.withoutFactor.join(', ')}.`
		);
	}
	// FP7: an unsealed import's accounts that are the same here, counted, their usernames as restored being the file's.
	if (unnamed > 0) {
		said.push(
			`${unnamed} account(s) on this server have no second factor after this restore and each needs its two-step sign-in ` +
				"reset before it can sign in; the backup's seal did not verify, so none is named here."
		);
	}
	if (notSameHere > 0) {
		said.push(
			`${notSameHere} account(s) in the backup are not on this server as the same account and have no second factor ` +
				'after this restore: each needs its two-step sign-in reset before it can sign in.'
		);
	}
	if (mfa.leftOut.length > 0 && mfa.leftOutBecause !== null) {
		said.push(
			`Their second factors in the backup were left out because ${LEFT_OUT_BECAUSE[mfa.leftOutBecause]}: ` +
				`${mfa.leftOut.join(', ')}.`
		);
	} else if (notSameHere > 0 && mfa.leftOutBecause !== null) {
		said.push(`Their second factors in the backup were left out because ${LEFT_OUT_BECAUSE[mfa.leftOutBecause]}.`);
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
