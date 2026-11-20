/**
 * restore.ts — copy the rows of a backup database into the running one.
 *
 * The restore route (`/api/admin/import`) owns the upload, the temporary file
 * and the safety copy; this owns what happens to the data. It lives here, and
 * takes both connections as arguments, so that it can be tested against
 * in-memory databases — a `+server.ts` file may export only HTTP handlers.
 *
 * A restore replaces rows, never structure. The running database keeps the
 * tables and columns its own migrations gave it, and the backup's rows are
 * copied into them, column by column, wherever a column of the same name
 * exists on both sides.
 */
import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { dev } from '$app/environment';
import { schedulerSetting } from '../schedulers';
import { putBackFromTrash, type UploadFile } from '../uploads';
import { BOARDS_UNDER_DELETED_GROUPINGS, defaultsForNull, orDefault, runBackfills, type Backfill } from './migrate';
import { normaliseTimestamps, registerStampFunctions, unreadableList, type TimestampNormalisation } from './timestamps';
import { isStamp, stamp, toStamp } from '$lib/timestamps';
import { KNOWN_BROWSER_SECRET_KEY } from '../known-browsers';
import { REQUEST_FORM_SECRET_KEY, writeFormSecret } from '../request-tokens';
import {
	BACKUP_SEAL,
	BACKUP_SEAL_KEY,
	INSTALLATION_ID,
	destinationPlace,
	WEBHOOK_ADDRESSES_LEFT_OUT_KEY,
	WEBHOOK_SECRETS_LEFT_OUT_KEY,
	addressMacKeyHere,
	fillAddressGaps,
	fillSecretGaps,
	fromTableStorage,
	installationIdHere,
	installationOf,
	keepSealKey,
	keepSetting,
	nothingHere,
	readAddressesListed,
	readListed,
	readSecretsHere,
	sealKeyHere,
	settingOf,
	unsealedBecause,
	type Installation,
	type ListedWebhook,
	type SecretsAccount,
	type SecretsToEnter,
	type Unsealed,
	boardName,
	withHeldApart
} from '../backup-secrets';
import { HELD_FROM_UNSEALED_BACKUP } from '$lib/settings-held';
import { MFA_KEY_CHECK_SETTING, currentMfaKey, type MfaKey } from '../mfa-key';
import { BACKUP_SEAL_KEY_MADE_AT, NoKeyToSeal, SECRETS_SCRUB_PENDING, WEBHOOK_ADDRESS_MAC_KEY, addressToBind, checkpointTruncate, markScrubPending, receiverColumn, sealedForRestore } from '../stored-secrets';
import {
	MFA_ROWS_NOT_RESTORED,
	NO_MFA_RESTORE,
	accountsWithoutFactor,
	carryFactors,
	readMfaHere,
	restoreMfaRows,
	sameAccountHere,
	type GrantTrust,
	type MfaHere,
	type MfaRestore
} from '../mfa-backup';
import { TWO_STEP_RELEASED_AT, passwordSetUpEnds } from '../mfa-store';
import { createLogger } from '../logger';
import { REPLACE_PLAIN_USED_INVITES, inHashForm } from '../invites';
import {
	coverReadable,
	holdNoLongerReadableIn,
	holdRevealedIn,
	holdRevealsOfEndedKeys,
	holdUnheldOfGoneSetters,
	readableBy,
	type RuledReader,
	readableCoveredAt,
	seedRevealsOnce,
	switchOffLostWebhooks,
	tellSwitchedOff,
	WEBHOOK_REVEALS_SEEDED,
	WEBHOOKS_ALREADY_OFF_HELD,
	type Reveal,
	type SwitchedOff
} from '../webhooks';
import {
	KEY_RECORD_TABLE,
	REVOKED_BECAUSE,
	REVOKED_BECAUSE_WORDS,
	WATERMARK,
	endApiKeys,
	keyRecordedWhere,
	raiseKeyCounterOverRecord,
	seedNames,
	watermarkOf,
	type RevokedBecause
} from '../key-revocations';
import {
	ACCOUNT_ENDING,
	ACCOUNT_ENDING_WORDS,
	ACCOUNT_RECORD_TABLE,
	CARRY_ACCOUNT_ENDING_SQL,
	ENDED_ROLES,
	ORIGIN,
	accountRulings,
	accountWatermarkOf,
	credentialOf,
	hasAccountRecord,
	passwordReplacedHere,
	raiseUserCounterOverSeed,
	recordAccountEnding,
	recordPasswordReplaced,
	type AccountRuling
} from '../account-endings';
import { DUMMY_HASH } from '../dummy-hash';
import { appUrlAsRead } from '../email';
import { failureConfigOf } from '../setting-setters';
import { APP_URL_SETTING, DESTINATION_SETTING, MAIL_SETTING, UNSEALED_RESTORE, appUrlPlaceOf, mailPlaceOf, placeKey } from '../setting-holds';
import { sqlite } from './index';

const log = createLogger('AUTH');

/** The runner's record of which migration files this database has applied. */
const MIGRATION_RECORD = '__drizzle_migrations';

/** This server's own record of what was done to it, and by whom: a restore keeps it (card 2899). */
const SYSTEM_LOG = 'system_logs';

/**
 * This server's record of every API key ended here (card 2995, migration 0076): a restore keeps it, as it keeps the
 * system log, and adds the backup's rows to it (`carryKeyRevocations`); Reset Everything keeps it too.
 */
const KEY_RECORD = KEY_RECORD_TABLE;

/**
 * This server's record of every ending of an account here (card 2996, migration 0077): a restore keeps it, as it keeps
 * the record of ended keys, and adds the backup's rows to it; Reset Everything keeps it too.
 */
const ACCOUNT_RECORD = ACCOUNT_RECORD_TABLE;

/**
 * The lines a backup's system log held, which a restore does not bring in
 * (card 2899): how many, and the first and last of their times, each only
 * where both are a real moment in the stored form, and otherwise null, never
 * the backup's own text (the code review's F2). `lines` is -1 where the log
 * could not be counted. Null where the backup has no system log.
 */
export type SystemLogLeftOut = { lines: number; first: string | null; last: string | null };

/**
 * What a restore does with the parts of a backup that reach outside the
 * instance: `keep` restores them as the backup has them, and `off` switches
 * them off or removes them. See `switchOffOutside`. A backup made since card
 * 2169 holds no mail password, destination credential or webhook secret:
 * either way, the ones this server has for the same accounts are filled in
 * first (`fillSecretGaps`), and `keep` leaves a webhook that had a secret off
 * until it is set, where none is filled.
 */
export type Outside = 'keep' | 'off';

/** What `switchOffOutside` did. */
export type OutsideSwitchedOff = {
	/** Report schedules that were enabled and are not now. */
	reportSchedules: number;
	/** Webhooks that were active and are not now. */
	webhooks: number;
	/** Whether the backup schedule was anything other than disabled. It is disabled now. */
	backupScheduleWasOn: boolean;
	/** Backup destinations the configuration had. It has none now. */
	backupDestinations: number;
	/** Mail settings removed. */
	mailSettings: number;
	/**
	 * The App URL removed, 1: only on a working copy of a backup whose seal did not verify, whose App URL is only the
	 * file's word (card 3009's code review, FP3); absent where none was removed, and on any other working copy, which keeps it.
	 */
	appUrl?: number;
};

export type RestoreResult = {
	/**
	 * Rows put into each table: copied from the backup or, for
	 * `work_dependencies` when the backup predates it, carried across from the
	 * restored `card_dependencies`.
	 */
	restored: Record<string, number>;
	/**
	 * NULLs in the backup that went into a column which is NOT NULL here, and
	 * were given that column's default: the table, the column, how many rows,
	 * and the default as SQL.
	 */
	defaulted: { table: string; column: string; rows: number; value: string }[];
	/**
	 * What could not be cleared, copied or filled in, and anything else found
	 * that somebody should know about. The restore committed all the same, and
	 * what could not be copied was left out.
	 *
	 * It never holds a row that other rows depend on through a foreign key: a
	 * restore that would leave rows pointing, through one, at a row it could not
	 * copy is rolled back instead, and throws. A reference with no foreign key,
	 * which `cards.milestone_id` and `boards.category_id` are, is not seen by
	 * that check.
	 */
	errors: string[];
	/** Rows the backup left without a value that the current code needs. */
	backfilled: Backfill;
	/**
	 * Timestamps the backup held in another form, now in the stored one, and
	 * any it held that could not be read (card 2095). A failure, and each column
	 * left unread, is in `errors` too.
	 */
	timestamps: TimestampNormalisation;
	/**
	 * What was switched off or removed once the tables were copied, for a
	 * restore asked to switch off what reaches outside. `null` for one that
	 * kept it all.
	 */
	outside: OutsideSwitchedOff | null;
	/**
	 * Task requests whose links the restore ended: every request it restored
	 * (cards 2158 and 2870). A link mailed before the restore no longer works,
	 * and none is kept or brought in.
	 */
	requestLinksReplaced: number;
	/**
	 * API keys given this server's deadline inside the restore's transaction,
	 * for a backup made before migration 0069 (card 2772, D5): each of its keys
	 * with no expiry, or one later than the deadline. 0 for a backup made
	 * since, which is restored as it is.
	 */
	apiKeyDeadlines: number;
	/**
	 * Personal decision links emptied inside the restore's transaction: every
	 * `decision_participants.link_token_hash` there is now, drafts' included
	 * (card 2675, decision 13). Each one on a decision that is not a draft is
	 * recorded on it as `link_revoked { reason: 'restore' }`. A link mailed
	 * before the restore no longer works. The import does not pass it on yet
	 * (card 2676).
	 */
	decisionLinksCleared: number;
	/**
	 * The secrets a backup does not hold (card 2169): those kept from this
	 * server, where they were for the same account, and those to enter again.
	 * A working copy names only webhooks: its mail settings and destinations
	 * are removed. Both empty for a backup made before card
	 * 2169, which holds its secrets.
	 */
	secrets: SecretsAccount;
	/**
	 * Whether the backup's seal verified with this server's key (the review's
	 * S1): it was made by this server and nobody has changed it since. Only
	 * then is anything kept from this server; otherwise every gap is in
	 * `secrets.toEnter`. False for a backup made before seals, which holds its
	 * secrets and has no gap.
	 */
	sealVerified: boolean;
	/**
	 * Why nothing was kept from this server, or null where the seal verified:
	 * no seal this server can check, or a seal that does not verify or a file
	 * that failed the checks made before it, which `check` names (the second
	 * review's B1 and N7). The restore goes ahead either way.
	 */
	unsealed: Unsealed | null;
	/**
	 * Whether this server had a key to check a seal with (card 2899's code
	 * review, F8). Without one, `unsealed.seal` is `none` whatever the file
	 * carries, and the import's line says the backup could not be checked.
	 */
	sealKeyHere: boolean;
	/**
	 * What the backup's installation id says of it beside this server's (card 3009, R6; `installationOf`): `this`,
	 * `other` (another, malformed, doubled, or any where this server has none) or `none`. The verdict only, never the id.
	 * With `sealVerified`, it decides the same account here for what this server grants (`sameAccountHere`).
	 */
	installation: Installation;
	/**
	 * Webhooks switched off for good inside the restore's transaction (card
	 * 2752, S1): each restored on whose setter cannot open its board in the
	 * restored data, or that nobody is recorded as having set up. 0 for a
	 * working copy, which switches every webhook off, and for a restore into
	 * any connection but the server's own, which is not swept:
	 * the next start that opens it as the server's database does.
	 */
	webhooksSwitchedOff: number;
	/**
	 * What became of the second factors and recovery codes (card 2768): how
	 * many accounts kept this server's and how many took the backup's, whose
	 * the backup held that were left out and why, and, once two-step sign-in
	 * is in use, every account left with no factor (`restoreMfaRows`).
	 */
	mfa: MfaRestore;
	/**
	 * The backup's system log, which was not brought in (card 2899): this
	 * server's log is kept as it was (`restorableTables`). Null where the
	 * backup has no system log; `lines` is -1 where it could not be counted,
	 * which `errors` says.
	 */
	systemLogLeftOut: SystemLogLeftOut | null;
	/**
	 * Settings held for the superadmin's review here that the backup did not
	 * hold, carried over it (card 2922, R10): each is held after the restore,
	 * one the superadmin kept here since the backup was made included, and is
	 * kept again under Settings held for review. 0 where none.
	 */
	settingHoldsCarried: number;
	/**
	 * The backup's API keys the restore left out (card 2995): `keyIds`, by the backup's key id, those the record of
	 * keys ended on this server names (`leaveOutRecordedKeys`) and those of an account disabled here (`carryDisabled`,
	 * R13), with `count` how many; and `workingCopy`, a working copy's every other key, counted only (R4). Never an
	 * account, a name or a prefix.
	 */
	apiKeysLeftOut: ApiKeysLeftOut;
	/**
	 * The restored accounts the record of account endings kept ended or lowered (card 2996), counted only, never named:
	 * `deleted`, brought back disabled and inert; `beforeRecord`, sharing an id this server had and deleted before it
	 * recorded endings, or held with a later creation time, brought back disabled with no password that works;
	 * `disabled`, kept disabled as the record says; `lowered`, given back the lower role it holds.
	 */
	accountsKept: AccountsKept;
	/**
	 * The rows of the backup's record of account endings left out whole (card 2996's code review, FP3, FP7): more than
	 * 1,000,000 seed rows or other rows, or more than 100 for one account. Counted, naming no account; 0 where it was taken.
	 */
	accountRecordLeftOut: number;
	/**
	 * The restored accounts holding a password this server's record of account endings says was replaced here (card
	 * 2997, `applyPasswordRulings`), counted only, never named: `here`, the same account here, given back the password it
	 * has on this server; `reset`, given a password nothing matches, needing one set or an invite; `superadmin`, a
	 * superadmin left with the password it holds, so that the superadmin can still sign in. All 0 where none.
	 *
	 * And, where the backup's seal did not verify (card 3009): `unsealed`, the restored accounts not the same here
	 * (`sameAccountHere`) given a password nothing matches in place of the file's; `superadminGivenYours`, 1 where the
	 * backup's superadmin was given the importing account's own password, and its authenticators (R1), else 0; and
	 * `givenYoursWithoutFactor`, 1 where it was given the password but no authenticator (no MFA key loaded, or none of the
	 * importer's opened with it), so that it cannot sign in until the host resets its two-step sign-in, else 0;
	 * `givenYoursMayEnrol`, 1 where, so given, it holds the importer's leave to set up two-step sign-in on its password
	 * alone and that leave's 14 days still run, so that it may set up an authenticator itself (its code review, FP6); and
	 * `emailGivenUp`, how many other restored accounts held the importer's email address, which the carried superadmin
	 * always takes, and were given one that receives no mail (FP5).
	 */
	passwordsKept: PasswordsKept;
	/**
	 * What a restore of a backup whose seal did not verify, keeping what reaches outside (`outside` `keep`), held for the
	 * superadmin's review (card 3009, R4; card 2922's `setting_holds`), counted only, never named: `mail`, 1 where the
	 * restored mail settings are at another place than this server's were before the restore; `destinations`, the
	 * restored backup destinations at a place this server did not hold; `appUrl`, 1 where the restored App URL differs
	 * from this server's. All 0 for a sealed backup and a working copy, which removes the mail, destinations and App URL itself (FP3).
	 */
	unsealedHeld: UnsealedHeld;
	/**
	 * What a restore of a backup whose seal did not verify kept from reaching outside as the file has it (card 3012),
	 * counted only, never named: `webhooks`, the restored webhooks with an address it newly held, their secrets discarded,
	 * and still held for that reason once this server's holds were carried (R1, R15); `schedules`, the enabled report
	 * schedules it paused, kept as it is, beyond those card 3009 paused (R4); `accountsAsHere`, the accounts that are the
	 * same here given this server's email address and notification choices; `addressesGivenUp`, the other accounts that
	 * held one of those addresses and were given one that receives no mail (R7); `notificationsOff`, the accounts not the
	 * same here whose notification mail it switched off (R6); `notifyEmail`, 1 where it gave the backup failure mail this
	 * server's address (R5); `requestsMailHeld` and `requestsUnconfirmedHeld`, the restored requests with an address that
	 * this server did not hold as they are, and whose requester mail it newly held, confirmed and unconfirmed apart (card
	 * 3020, R11); `peopleMailOff`, the people it marked left, as this server did not hold their address and account or has
	 * them as left, and `decisionPlacesMailOff`, those people's places on decisions, not removed (card 3020, R7, R8, R21).
	 * All 0 for a sealed backup.
	 */
	unsealedReach: UnsealedReach;
};

/** The settings of an unsealed backup held for review (card 3009, R4): see `RestoreResult.unsealedHeld`. */
export type UnsealedHeld = { mail: number; destinations: number; appUrl: number };

/** What a restore of a backup whose seal did not verify kept from reaching outside (card 3012), counted only. */
export type UnsealedReach = {
	/** Newly held and still held for the unsealed reason after `carryHolds` (R1, R15). */
	webhooks: number;
	/** Enabled schedules this restore paused, beyond card 3009's (R4); 0 on a working copy, which switches every one off. */
	schedules: number;
	/** Same-here accounts given this server's email and notification choices. */
	accountsAsHere: number;
	/** Other accounts given `email-given-up-<id>@restore.invalid` for holding a same-here account's address (R7, R15). */
	addressesGivenUp: number;
	/** Accounts not the same here whose `email_all` was not already false (R6). */
	notificationsOff: number;
	/** 1 where the backup failure mail's address was replaced with this server's (R5). */
	notifyEmail: number;
	/** Card 3020: confirmed requests whose requester mail this restore newly held. */
	requestsMailHeld: number;
	/** Card 3020 (R11): unconfirmed requests it newly held; they cannot be released and lapse after 7 days. */
	requestsUnconfirmedHeld: number;
	/** Card 3020: people it marked left. */
	peopleMailOff: number;
	/** Card 3020 (R21): participant rows, not removed, of those people: places on decisions. */
	decisionPlacesMailOff: number;
};

/** A restore's `unsealedReach` before anything is counted. */
export const NO_UNSEALED_REACH: UnsealedReach = {
	webhooks: 0,
	schedules: 0,
	accountsAsHere: 0,
	addressesGivenUp: 0,
	notificationsOff: 0,
	notifyEmail: 0,
	requestsMailHeld: 0,
	requestsUnconfirmedHeld: 0,
	peopleMailOff: 0,
	decisionPlacesMailOff: 0
};

/** The restored passwords a restore kept out of use (cards 2997 and 3009): see `RestoreResult.passwordsKept`. */
export type PasswordsKept = {
	here: number;
	reset: number;
	superadmin: number;
	unsealed: number;
	superadminGivenYours: number;
	givenYoursWithoutFactor: number;
	/** Card 3009's code review, FP6: 1 where no authenticator was carried and the importer's leave to set up on its password alone was, while its 14 days run. */
	givenYoursMayEnrol: number;
	/** FP5: the other restored accounts that held the importer's email address and gave it up for one that receives no mail. */
	emailGivenUp: number;
};

/** A restore's `passwordsKept` before anything is counted. */
const NO_PASSWORDS_KEPT: PasswordsKept = { here: 0, reset: 0, superadmin: 0, unsealed: 0, superadminGivenYours: 0, givenYoursWithoutFactor: 0, givenYoursMayEnrol: 0, emailGivenUp: 0 };

/** The keys a restore left out (card 2995): see `RestoreResult.apiKeysLeftOut`. */
export type ApiKeysLeftOut = { count: number; keyIds: number[]; workingCopy: number; unsealed: number };

/** The accounts a restore kept ended or lowered (card 2996): see `RestoreResult.accountsKept`. */
export type AccountsKept = { deleted: number; beforeRecord: number; disabled: number; lowered: number };

/** What a restore that committed had done, for a `RestoreError` thrown after the commit. */
export type CommittedRestore = Pick<
	RestoreResult,
	| 'requestLinksReplaced'
	| 'apiKeyDeadlines'
	| 'decisionLinksCleared'
	| 'secrets'
	| 'sealVerified'
	| 'unsealed'
	| 'sealKeyHere'
	| 'installation'
	| 'mfa'
	| 'systemLogLeftOut'
	| 'apiKeysLeftOut'
	| 'accountsKept'
	| 'accountRecordLeftOut'
	| 'passwordsKept'
	| 'unsealedHeld'
	| 'unsealedReach'
>;

/**
 * A restore that went wrong in a way the caller has to be told about, as
 * distinct from one that left a row out and said so in `errors`.
 *
 * `committed` says which of two very different things happened, and the
 * message says the same in words:
 *
 * - `false`: the restore did not commit, and the database holds what it held
 *   before. This is every case but one.
 * - `true`: the backup's rows are in and committed, and it is the connection
 *   that is wrong: foreign keys could not be switched back on. Nothing is to be
 *   restored again; the server is to be restarted.
 *
 * `errors` is what had already gone wrong, row by row and table by table, when
 * it stopped. The caller would otherwise never see that list: it is built up
 * inside `restoreFromBackup`, which is throwing rather than returning.
 *
 * `done`, for the one that committed, is what it did that the import's answer
 * says of every restore that commits (the review's O8): the requests whose
 * links it ended, and the secrets it kept and those to enter again.
 */
export class RestoreError extends Error {
	readonly errors: string[];
	readonly committed: boolean;
	readonly done: CommittedRestore | null;

	constructor(
		message: string,
		detail: { errors: readonly string[]; committed: boolean; cause?: unknown; done?: CommittedRestore }
	) {
		super(message, detail.cause ? { cause: detail.cause } : undefined);
		this.name = 'RestoreError';
		this.errors = [...detail.errors];
		this.committed = detail.committed;
		this.done = detail.done ?? null;
	}
}

/**
 * A restore refused because the rows it restored would have user accounts and
 * none of them the superadmin. Never committed: nothing was changed. It is
 * what the backup holds, not a fault, so the import answers it 422 and logs
 * it at WARN, where a `RestoreError` is a 500 and CRITICAL.
 */
export class RestoreLeavesNoSuperadmin extends RestoreError {
	constructor(message: string, detail: { errors: readonly string[]; cause?: unknown }) {
		super(message, { ...detail, committed: false });
		this.name = 'RestoreLeavesNoSuperadmin';
	}
}

/**
 * The copy that migration 0043 made, once, when `work_dependencies` replaced
 * `card_dependencies`: every card dependency as a (card, card) pair. Taken
 * from `drizzle/0043_add_work_dependencies.sql`.
 */
const CARRY_CARD_DEPENDENCIES = `
	INSERT OR IGNORE INTO work_dependencies
		(blocked_type, blocked_id, blocker_type, blocker_id, created_by_user_id, created_at)
	SELECT 'card', card_id, 'card', depends_on_card_id, created_by_user_id, created_at
	FROM card_dependencies
`;

/**
 * The record of every personal decision link a restore ends (card 2675,
 * decision 13): one `link_revoked { reason: 'restore' }` by DumpFire for each
 * participant holding a link on a decision that is not a draft. A draft's
 * participant is named by no event (comment 5599, R8). The moment is bound.
 */
const RECORD_DECISION_LINKS_ENDED = `
	INSERT INTO decision_events (decision_id, participant_id, kind, detail, actor_name, source, created_at)
	SELECT p.decision_id, p.id, 'link_revoked', '{"reason":"restore"}', 'DumpFire', 'system', ?
	FROM decision_participants p JOIN decisions d ON d.id = p.decision_id
	WHERE p.link_token_hash IS NOT NULL AND d.status <> 'draft'
	ORDER BY p.id
`;

/** Every personal decision link emptied, drafts' included (decision 13). */
const CLEAR_DECISION_LINKS =
	'UPDATE decision_participants SET link_token_hash = NULL, link_issued_at = NULL WHERE link_token_hash IS NOT NULL';

/** The setting migration 0069 writes: the deadline of every API key made before two-step sign-in (card 2772). */
const API_KEY_DEADLINE_SETTING = 'api_key_deadline';

/**
 * Migration 0069's `UPDATE`, repeated for a backup made before it (card 2772,
 * D5, S11): every key with no expiry, or one later than the deadline, given
 * the deadline (`@deadline`, bound). The expiry is compared as the moment it
 * names (`stamp_of`, `registerStampFunctions`), since such a backup can hold
 * one in another form; one that names none is left, as it has ended already.
 */
const GIVE_API_KEY_DEADLINES =
	'UPDATE api_keys SET deadline_at = @deadline WHERE expires_at IS NULL OR stamp_of(expires_at) > @deadline';

/**
 * The setting migration 0071 writes: the moment API keys began to be recorded
 * on webhooks (cards 2752 and 2893, S9). A restore keeps the earlier of this
 * server's value and the backup's (card 2893's code review, CS1): a key made
 * before the later of the two may have been made after the release on the
 * other server, so only the earlier moment is safe to count keys before. The
 * backup's stands where this server has none, and this server's where the
 * backup's names no moment.
 */
const WEBHOOK_KEYS_RECORDED_SETTING = 'webhook_keys_recorded_at';

/**
 * 0071's setting put back as this server had it (`@value`), unless the
 * backup's names an earlier moment (`stamp_of`, which `registerStampFunctions`
 * gives the connection): then the backup's, as stored.
 */
const KEEP_WEBHOOK_KEYS_RECORDED_SETTING =
	`INSERT INTO settings (key, value) VALUES ('${WEBHOOK_KEYS_RECORDED_SETTING}', @value) ON CONFLICT (key) DO UPDATE SET value = ` +
	'CASE WHEN stamp_of(settings.value) IS NOT NULL AND stamp_of(settings.value) < stamp_of(excluded.value) THEN settings.value ELSE excluded.value END';

/** A webhook of this server's switched off for good, as `webhookHoldsHere` reads it: its address as stored, sealed (card 2928). */
type HoldHere = { id: number; boardId: number; url: string; receiver: string; setBy: number | null; heldBecause: string; heldAt: string | null };

/**
 * This server's webhooks switched off for good (migration 0071), whatever
 * their secret, read before a restore clears the table (card 2752's code
 * review, CS5). None where the database has no such column.
 */
function webhookHoldsHere(live: Database.Database): HoldHere[] {
	try {
		return live
			.prepare(
				`SELECT id, board_id AS boardId, url, ${receiverColumn(live)} AS receiver, set_by AS setBy, held_because AS heldBecause, held_at AS heldAt FROM webhooks WHERE held_because IS NOT NULL`
			)
			.all() as HoldHere[];
	} catch {
		return [];
	}
}

/**
 * Carry this server's holds onto the restored rows of the same webhooks (card
 * 2752's code review, CS5): a restored row with the same id, board, address
 * and setter as one switched off here is switched off with the same hold,
 * whatever the backup had it as, so a restore never switches back on a
 * webhook held off here, the backup's setter being able to open the board or
 * not, its secret filled or not. Returns the ids of the rows it changed, so that
 * an unsealed restore counts only the webhooks this server did not hold (card
 * 3020's code review, FP2).
 *
 * The addresses are compared opened (card 2928): the same text sealed twice is
 * two envelopes. Where either side's address is '' or does not open, the hold
 * is carried on the id, board and setter alone (R17): failing closed, a hold
 * is never lost because an address could not be read.
 *
 * Card 3012 (R3): a restored row `holdUnsealedWebhooks` held, for a backup whose seal did not verify, takes this server's
 * reason only where both addresses open and are equal; otherwise it keeps the unsealed reason, which is then the true
 * one. Held either way: R3 decides only the words. Only where `sealVerified` is false (its code review, FP9): a sealed
 * backup's row held for that reason by an earlier restore takes this server's hold as any other does.
 */
function carryHolds(live: Database.Database, holds: readonly HoldHere[], sealVerified: boolean): Set<number> {
	const carried = new Set<number>();
	if (holds.length === 0) return carried;
	const find = live.prepare(
		`SELECT id, board_id AS boardId, url, ${receiverColumn(live)} AS receiver, held_because AS heldBecause FROM webhooks WHERE id = ? AND board_id = ? AND set_by IS ?`
	);
	const carry = live.prepare('UPDATE webhooks SET active = 0, held_because = ?, held_at = ? WHERE id = ?');
	for (const hold of holds) {
		const row = find.get(hold.id, hold.boardId, hold.setBy) as { id: number; boardId: number; url: string; receiver: string; heldBecause: string | null } | undefined;
		if (row === undefined) continue;
		const here = addressToBind(hold);
		const restored = addressToBind(row);
		if (here !== null && restored !== null && here !== restored) continue;
		if (!sealVerified && row.heldBecause === HELD_FROM_UNSEALED_BACKUP && (here === null || restored === null)) continue;
		if (carry.run(hold.heldBecause, hold.heldAt, row.id).changes > 0) carried.add(row.id);
	}
	return carried;
}

/**
 * Card 3012 (R1, R2): on a restore of a backup whose seal did not verify, as it is or as a working copy, hold every
 * restored webhook with an address, whatever the file says of it: switched off, `held_because`
 * `HELD_FROM_UNSEALED_BACKUP` over any reason the file gave, `held_at` the restore's moment, its secret discarded and
 * its `webhook_reveals` rows deleted, so that switching it on gives it a new secret (`NEW_SECRET_REASONS`). Every one
 * with no address the file has on is switched off, not held, and stays listed to enter. After the address fill (which
 * fills nothing here) and before `carryHolds`. Returns every id it held, the file's own holds among them, which are
 * listed (its code review, FP19); those `carryHolds` does not then give this server's hold are counted (R15), whatever
 * the file put in `held_because` (card 3020's code review, FP2). Nothing where the live table lacks the columns. Not
 * caught.
 */
function holdUnsealedWebhooks(live: Database.Database, at: string): { held: number[] } {
	const present = live
		.prepare("SELECT COUNT(*) FROM pragma_table_info('webhooks') WHERE name IN ('url', 'active', 'secret', 'held_because', 'held_at')")
		.pluck()
		.get() as number;
	if (present < 5) return { held: [] };
	const held = live.prepare("SELECT id FROM webhooks WHERE url <> '' ORDER BY id").pluck().all() as number[];
	if (tableIn(live, 'webhook_reveals')) live.prepare("DELETE FROM webhook_reveals WHERE webhook_id IN (SELECT id FROM webhooks WHERE url <> '')").run();
	live.prepare("UPDATE webhooks SET active = 0, secret = '', held_because = ?, held_at = ? WHERE url <> ''").run(HELD_FROM_UNSEALED_BACKUP, at);
	live.prepare("UPDATE webhooks SET active = 0 WHERE url = '' AND active <> 0").run();
	return { held };
}

/**
 * `toEnter` with every webhook `holdUnsealedWebhooks` held and still holds (card 3012, R15; its code review, FP19) among
 * `heldWebhooks`, by id and board name, never by host, deduplicated and sorted: the panel lists them as switched off for
 * good.
 */
function withUnsealedHeld(live: Database.Database, toEnter: SecretsToEnter, ids: readonly number[]): SecretsToEnter {
	const already = new Set((toEnter.heldWebhooks ?? []).map((hook) => hook.id));
	const boardOf = live.prepare('SELECT board_id FROM webhooks WHERE id = ?').pluck();
	const added = ids
		.filter((id) => !already.has(id))
		.map((id) => {
			const boardId = boardOf.get(id) as number;
			return { id, boardId, board: boardName(live, boardId) };
		});
	if (added.length === 0) return toEnter;
	return { ...toEnter, heldWebhooks: [...(toEnter.heldWebhooks ?? []), ...added].sort((a, b) => a.id - b.id) };
}

/** The placeholder addresses a restore writes end in this (RFC 2606: receives no mail), compared ignoring case. */
const NO_MAIL_DOMAIN = '@restore.invalid';

/**
 * The address an account gives its own up for, one that receives no mail (card 3009, R2; card 3012, R7): the one both
 * cards' give-ups write (card 3012's code review, FP14). With `nonce`, the restore's own, where no value this server
 * already holds may be met (FP6).
 */
function givenUpAddress(id: number, nonce?: string): string {
	return `email-given-up-${id}${nonce === undefined ? '' : `-${nonce}`}${NO_MAIL_DOMAIN}`;
}

/**
 * Notification choices with `email_all` false, read as `getUserNotifPrefs` reads them, with `JSON.parse` (card 3012,
 * R6; its code review, FP1): a JSON object keeps its other choices, and of a key written twice the last is the one that
 * counts, as it is for the reader; anything else becomes `{"email_all":false}`. `off` where they were an object whose
 * `email_all` was already false, which is not counted.
 */
function mailSwitchedOff(prefs: unknown): { value: string; off: boolean } {
	let parsed: unknown = null;
	try {
		parsed = typeof prefs === 'string' ? (JSON.parse(prefs) as unknown) : null;
	} catch {
		parsed = null;
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { value: '{"email_all":false}', off: false };
	const choices = parsed as Record<string, unknown>;
	return { value: JSON.stringify({ ...choices, email_all: false }), off: choices.email_all === false };
}

/**
 * Card 3012 (R6, R7): on a restore of a backup whose seal did not verify, as it is or as a working copy, every restored
 * account that is the same here (`sameAccountHere` under `trust`) takes this server's email address and notification
 * choices, and every other has its notification mail switched off (`email_all` false, its other choices kept), the
 * file's address left as it is: so that no mail goes to an address only the file vouches for. Any other account holding
 * one of the same-here accounts' addresses, compared ignoring case, gives it up for one that receives no mail, and so
 * does every other account but the lowest-numbered of those sharing one apart from case (its code review, FP5).
 * Placeholder addresses (`@restore.invalid`) are rewritten first, with a nonce, so that none the file planted, and none
 * this server holds, can break the unique index (FP6). After `applyAccountEndings` (FP7) and before card 3009's carry,
 * whose email write then sees the addresses settled. Counts what it changed, naming nobody; an account the record of
 * endings deleted (`ended`) is not counted as switched off. Where this server held no account to compare, every account
 * is another. Not caught.
 */
function keepAccountsHere(
	live: Database.Database,
	here: AccountsHere,
	trust: GrantTrust,
	ended: ReadonlyMap<number, 'deleted' | 'before record' | 'disabled'>
): Pick<UnsealedReach, 'accountsAsHere' | 'addressesGivenUp' | 'notificationsOff'> {
	const counted = { accountsAsHere: 0, addressesGivenUp: 0, notificationsOff: 0 };
	const columns = columnNamesOf(live, 'users');
	if (!columns.includes('email')) return counted;
	const prefs = columns.includes('notification_prefs');
	// Each address read as text (the code review's FP11): one the file stored as a BLOB is compared, never thrown on.
	const restored = live
		.prepare(`SELECT id, coalesce(CAST(email AS TEXT), '') AS email, ${prefs ? 'notification_prefs' : 'NULL'} AS prefs FROM users ORDER BY id`)
		.all() as { id: number; email: string; prefs: unknown }[];
	if (restored.length === 0) return counted;
	const sameHere = restoredSameHere(live, here, trust);
	const same = restored.filter((account) => sameHere(account.id));
	const sameIds = new Set(same.map((account) => account.id));
	const others = restored.filter((account) => !sameIds.has(account.id));
	const nonce = randomBytes(16).toString('hex');
	const setEmail = live.prepare('UPDATE users SET email = ? WHERE id = ?');
	const pending = (id: number) => setEmail.run(`email-pending-${id}-${nonce}${NO_MAIL_DOMAIN}`, id);
	const givenUp = new Set<number>();
	const giveUp = (id: number, withNonce = false) => {
		givenUp.add(id);
		return setEmail.run(givenUpAddress(id, withNonce ? nonce : undefined), id).changes;
	};
	const placeholder = (email: string) => email.toLowerCase().endsWith(NO_MAIL_DOMAIN);

	// Step 0 (R7): every placeholder made one that nothing planted, and nothing this server holds, can be (the code
	// review's FP6): a same-here account's set apart, each other account's its own given-up address, both with the
	// nonce. Not counted: such an address receives no mail anyway.
	for (const account of restored) {
		if (!placeholder(account.email)) continue;
		if (sameIds.has(account.id)) pending(account.id);
		else giveUp(account.id, true);
	}
	// Step 1: every same-here account whose address differs from this server's set apart, so that two swapped in the file
	// break no unique index.
	const rowHere = (id: number) => here.hashes.get(id)!;
	for (const account of same) if (account.email !== rowHere(account.id).email && !placeholder(account.email)) pending(account.id);
	// Step 2 (R7): every other account holding a same-here account's final address, this server's, ignoring case.
	const finals = new Set(same.map((account) => rowHere(account.id).email.toLowerCase()));
	for (const account of others) {
		if (placeholder(account.email) || !finals.has(account.email.toLowerCase())) continue;
		counted.addressesGivenUp += giveUp(account.id);
	}
	// Step 2b (the code review's FP5): no two other accounts left sharing an address apart from case; the lowest id keeps
	// it, and each higher one gives it up, counted. Two same-here accounts sharing one are this server's own state.
	const keptBy = new Set<string>();
	for (const account of others) {
		if (givenUp.has(account.id)) continue;
		const folded = account.email.toLowerCase();
		if (keptBy.has(folded)) counted.addressesGivenUp += giveUp(account.id);
		else keptBy.add(folded);
	}
	// Step 3: every same-here account given this server's address and choices, counted where either differed in the file.
	const setPrefs = prefs ? live.prepare('UPDATE users SET notification_prefs = ? WHERE id = ?') : null;
	for (const account of same) {
		const ours = rowHere(account.id);
		if (account.email !== ours.email || placeholder(account.email)) setEmail.run(ours.email, account.id);
		const prefsDiffer = setPrefs !== null && account.prefs !== ours.notificationPrefs;
		if (prefsDiffer) setPrefs!.run(ours.notificationPrefs, account.id);
		if (account.email !== ours.email || prefsDiffer) counted.accountsAsHere++;
	}
	// Step 4 (R6): every other account's notification mail switched off, its other choices kept where they are a JSON
	// object, read with the reader's own parser (the code review's FP1: SQLite's JSON functions take the first of a key
	// written twice, `JSON.parse` the last); counted unless `email_all` was already false, or the record of account
	// endings deleted the account (FP7, N1: inert, it is mailed nothing anyway). The carried superadmin among them.
	if (setPrefs !== null) {
		for (const account of others) {
			const switched = mailSwitchedOff(account.prefs);
			setPrefs.run(switched.value, account.id);
			if (!switched.off && ended.get(account.id) !== 'deleted') counted.notificationsOff++;
		}
	}
	return counted;
}

/**
 * Card 3012 (R4): on a restore of a backup whose seal did not verify, kept as it is, every enabled report schedule
 * paused, after card 3009's pause of the accounts not the same here, which it does not count again. A working copy
 * switches every one off itself (`switchOffOutside`). Each owner turns one on again on the Reports page, with their
 * password and a code. Counts those it paused. Not caught.
 */
function pauseUnsealedSchedules(live: Database.Database, at: string): number {
	const columns = columnNamesOf(live, 'report_schedules');
	if (!columns.includes('enabled') || !columns.includes('updated_at')) return 0;
	return live.prepare('UPDATE report_schedules SET enabled = 0, updated_at = ? WHERE enabled = 1').run(at).changes;
}

/**
 * This server's backup failure mail address (`backup_config.notifyEmail`), where it is a string, read before the clear
 * (card 3012, R5) as the failure address is read (`failureConfigOf`, its code review's FP14).
 */
function notifyEmailHere(live: Database.Database): string | null {
	const notifyEmail = failureConfigOf(settingOf(live, 'backup_config'))?.config.notifyEmail;
	return typeof notifyEmail === 'string' ? notifyEmail : null;
}

/**
 * Card 3012 (R5): on a restore of a backup whose seal did not verify, as it is or as a working copy, the backup failure
 * mail's address is this server's (`before`, or '' where it had none) unless the restored one is exactly that string,
 * whatever its type: written back into the restored configuration where that is a JSON object; one that is not is left,
 * as nothing reads an address from it. The last of card 3012's steps (R14). Counts 1 only where the address the failure
 * mail would go to changes (its code review, FP18): not where neither side had one, which is written and not counted.
 */
function keepNotifyEmailHere(live: Database.Database, before: string | null): number {
	const read = failureConfigOf(settingOf(live, 'backup_config'));
	if (read === null) return 0;
	const was = read.config;
	const addressHere = before ?? '';
	if (was.notifyEmail === addressHere) return 0;
	live.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'").run(JSON.stringify({ ...was, notifyEmail: addressHere }));
	// The failure mail goes only to a value that is set (`config.notifyEmail &&`, backup.ts): none for none is no change.
	return was.notifyEmail || addressHere !== '' ? 1 : 0;
}

/**
 * A request as `requestRowsOf` reads it (card 3020, R1), this server's or a restored one: the fields that decide "the
 * same request here", with its card's and that card's board's, and its hold and last release (R9). Each as
 * better-sqlite3 returns it.
 */
type RequestIdentity = {
	id: number;
	created_at: unknown;
	title: unknown;
	requester_email: unknown;
	requester_user_id: unknown;
	status: unknown;
	resolved_card_id: unknown;
	card_created_at: unknown;
	card_title: unknown;
	card_board_id: unknown;
	mail_held_because: unknown;
	mail_released_at: unknown;
	mail_released_by: unknown;
	mail_released_by_name: unknown;
};

/** The fields of `RequestIdentity` that must all be `===` equal for a restored request to be the one this server held (R1). */
const SAME_REQUEST_FIELDS = [
	'created_at',
	'title',
	'requester_email',
	'requester_user_id',
	'status',
	'resolved_card_id',
	'card_created_at',
	'card_title',
	'card_board_id'
] as const satisfies readonly (keyof RequestIdentity)[];

/**
 * Every request in `live` by id, with its card's `created_at` and `title` and the board of that card's column (card
 * 3020, R1), and its hold and last release: read before the clear for this server, and after the copy for the backup.
 * Guarded on the tables and columns being there: none where `task_requests` or one of its columns is missing, and the
 * card's three NULL where the card's tables or columns are. Reads.
 */
function requestRowsOf(live: Database.Database): Map<number, RequestIdentity> {
	const requests = new Map<number, RequestIdentity>();
	const needed = ['id', 'created_at', 'title', 'requester_email', 'requester_user_id', 'status', 'resolved_card_id'];
	const holdColumns = ['mail_held_because', 'mail_released_at', 'mail_released_by', 'mail_released_by_name'];
	if (!hasColumns(live, 'task_requests', [...needed, ...holdColumns])) return requests;
	const withCard = hasColumns(live, 'cards', ['id', 'created_at', 'title', 'column_id']);
	const withBoard = withCard && hasColumns(live, 'columns', ['id', 'board_id']);
	const rows = live
		.prepare(
			'SELECT r.id, r.created_at, r.title, r.requester_email, r.requester_user_id, r.status, r.resolved_card_id, ' +
				`${withCard ? 'c.created_at' : 'NULL'} AS card_created_at, ${withCard ? 'c.title' : 'NULL'} AS card_title, ` +
				`${withBoard ? 'col.board_id' : 'NULL'} AS card_board_id, ` +
				'r.mail_held_because, r.mail_released_at, r.mail_released_by, r.mail_released_by_name FROM task_requests r' +
				(withCard ? ' LEFT JOIN cards c ON c.id = r.resolved_card_id' : '') +
				(withBoard ? ' LEFT JOIN columns col ON col.id = c.column_id' : '') +
				' ORDER BY r.id'
		)
		.all() as RequestIdentity[];
	for (const row of rows) requests.set(row.id, row);
	return requests;
}

/**
 * Card 3020 (section 3.2; R1, R9, R11): on a restore of a backup whose seal did not verify, as it is or as a working
 * copy, every restored request's hold decided by this server, never the file. A request is the same here where this
 * server had the same id, every field of `SAME_REQUEST_FIELDS` is `===` equal, and its requester account, if any, is
 * the same here (`sameHere`): it takes this server's `mail_held_because` and last release, the release naming its
 * account only where that account is the same here, and otherwise keeping its moment and name with no account, as ON
 * DELETE SET NULL would (its code review, FP1). Any other request with an address (an account, or a requester email
 * neither NULL nor '') has its mail held (`HELD_FROM_UNSEALED_BACKUP`, over any text the file gave) and no release; one
 * with no address has neither, since nothing can be mailed. Counts every request it holds that was not the same here,
 * whatever the file put in `mail_held_because` (its code review, FP2): `unconfirmed` for a request awaiting
 * confirmation, which cannot be released (R11), and `held` for any other. Names nobody. After `keepNotifyEmailHere`.
 * Not caught.
 */
function holdUnsealedRequestMail(
	live: Database.Database,
	here: ReadonlyMap<number, RequestIdentity>,
	sameHere: (id: number) => boolean
): { held: number; unconfirmed: number } {
	const counted = { held: 0, unconfirmed: 0 };
	const restored = requestRowsOf(live);
	if (restored.size === 0) return counted;
	const write = live.prepare(
		'UPDATE task_requests SET mail_held_because = ?, mail_released_at = ?, mail_released_by = ?, mail_released_by_name = ? WHERE id = ?'
	);
	for (const row of restored.values()) {
		const ours = here.get(row.id);
		const sameRequestHere =
			ours !== undefined &&
			SAME_REQUEST_FIELDS.every((field) => row[field] === ours[field]) &&
			(row.requester_user_id === null || (typeof row.requester_user_id === 'number' && sameHere(row.requester_user_id)));
		if (sameRequestHere) {
			// Never an account the restore did not bring back as the same one (FP1): `PRAGMA foreign_key_check` stays empty.
			const releasedBy = typeof ours.mail_released_by === 'number' && sameHere(ours.mail_released_by) ? ours.mail_released_by : null;
			write.run(ours.mail_held_because, ours.mail_released_at, releasedBy, ours.mail_released_by_name, row.id);
			continue;
		}
		const hasAddress = row.requester_user_id !== null || (row.requester_email !== null && row.requester_email !== '');
		if (!hasAddress) {
			write.run(null, null, null, null, row.id);
			continue;
		}
		write.run(HELD_FROM_UNSEALED_BACKUP, null, null, null, row.id);
		// Counted against this server, never the file (FP2): a hold the file wrote in is no hold here.
		if (row.status === 'unverified') counted.unconfirmed++;
		else counted.held++;
	}
	return counted;
}

/**
 * A person as `peopleRowsOf` reads them (card 3020, R7, R8), this server's or a restored one: the fields that decide
 * "the same person here", each as better-sqlite3 returns it, with the address's storage class, and the moment they
 * left as text, which the record a marking writes takes from this server's row alone.
 */
type PersonIdentity = {
	id: number;
	email: unknown;
	email_type: unknown;
	user_id: unknown;
	status: unknown;
	left_at: unknown;
	left_at_text: unknown;
};

/**
 * Every person in `live` by id (card 3020, section 3.3): the address as text with its storage class, the account, the
 * status and when they left. Read before the clear for this server, and after the copy for the backup. None where
 * `people` or one of its columns is missing. Reads.
 */
function peopleRowsOf(live: Database.Database): Map<number, PersonIdentity> {
	const people = new Map<number, PersonIdentity>();
	if (!hasColumns(live, 'people', ['id', 'email', 'user_id', 'status', 'left_at', 'updated_at'])) return people;
	const rows = live
		.prepare(
			'SELECT id, CAST(email AS TEXT) AS email, typeof(email) AS email_type, user_id, status, ' +
				'left_at, CAST(left_at AS TEXT) AS left_at_text FROM people ORDER BY id'
		)
		.all() as PersonIdentity[];
	for (const row of rows) people.set(row.id, row);
	return people;
}

/**
 * What a people_changes row says a restored person was (card 3020's code review, FP6): the status only where it is
 * `'active'` or `'left'`, else the fixed word `'other'`, and the moment they left only where it reads as a timestamp, in
 * this build's form. Never the file's own text.
 */
function personBefore(row: PersonIdentity): string {
	const status = row.status === 'active' || row.status === 'left' ? row.status : 'other';
	return JSON.stringify({ status, leftAt: toStamp(row.left_at) });
}

/**
 * Card 3020 (section 3.3; R7, R8, R13): on a restore of a backup whose seal did not verify, as it is or as a working
 * copy, every restored person this server did not hold, or has as left, marked left, so that no decision mail, reminder
 * or personal link goes to the address the file gave them (`reachOf` skips anyone not active). A person is held here
 * where this server had the same id, the address is text on both sides and `===` equal, the account (`user_id`) is
 * `===` equal, and that account, if any, is the same here (`sameHere`). A person the file has as left stays as it has
 * them. Any other is marked left: one the same here whom this server has as left with this server's `left_at`; one the
 * same here and active on both sides is left alone; anyone else, a status that is neither active nor left among them
 * (R8), with `left_at` the restore's moment `at`. Each marked has one `people_changes` row by DumpFire, source `restore`,
 * saying the status and when they left, before (`personBefore`: never the file's text, its code review's FP6) and
 * after: no address and no account id (R13). Nothing writes `email`,
 * so its UNIQUE index cannot break, and no participant row is written: the restore has ended every link already.
 * Counts the people marked, and their places on decisions (participant rows not removed), in JavaScript. The last of
 * card 3020's steps. Not caught.
 */
function switchOffUnsealedPeople(
	live: Database.Database,
	here: ReadonlyMap<number, PersonIdentity>,
	sameHere: (id: number) => boolean,
	at: string
): { people: number; places: number } {
	const restored = peopleRowsOf(live);
	const marked = new Set<number>();
	if (restored.size === 0) return { people: 0, places: 0 };
	const markLeft = live.prepare("UPDATE people SET status = 'left', left_at = ?, updated_at = ? WHERE id = ?");
	const recorded = columnNamesOf(live, 'people_changes').length > 0;
	const record = recorded
		? live.prepare(
				'INSERT INTO people_changes (created_at, actor_user_id, actor_name, source, subject, subject_id, kind, before, after) ' +
					"VALUES (?, NULL, 'DumpFire', 'restore', 'person', ?, 'updated', ?, ?)"
			)
		: null;
	for (const row of restored.values()) {
		// Left in the file: kept as the file has them, held here or not.
		if (row.status === 'left') continue;
		const ours = here.get(row.id);
		const samePersonHere =
			ours !== undefined &&
			row.email_type === 'text' &&
			ours.email_type === 'text' &&
			row.email === ours.email &&
			row.user_id === ours.user_id &&
			(row.user_id === null || (typeof row.user_id === 'number' && sameHere(row.user_id)));
		let leftAt: { value: unknown; text: unknown };
		if (samePersonHere && ours.status === 'left') leftAt = { value: ours.left_at, text: ours.left_at_text };
		else if (samePersonHere && row.status === 'active') continue;
		else leftAt = { value: at, text: at };
		markLeft.run(leftAt.value, at, row.id);
		record?.run(at, row.id, personBefore(row), JSON.stringify({ status: 'left', leftAt: leftAt.text }));
		marked.add(row.id);
	}
	let places = 0;
	if (marked.size > 0 && columnNamesOf(live, 'decision_participants').length > 0) {
		const participants = live.prepare('SELECT person_id, removed_at FROM decision_participants').all() as { person_id: unknown; removed_at: unknown }[];
		places = participants.filter((p) => p.removed_at === null && typeof p.person_id === 'number' && marked.has(p.person_id)).length;
	}
	return { people: marked.size, places };
}

/** Where this server's settings that reach outside are (card 3009, R4), in the places `setting_holds` names them by. */
type SettingPlaces = { mail: string | null; appUrl: string | null; destinations: { name: string; place: string }[] };

/**
 * Where the settings that reach outside are in `database` (card 3009, R4), as the readers that hold them ask: the
 * mail settings' place as a mail reads them (`mailConnectionAsRead`, `mailHeldAt`; none without a host), the App URL's
 * as a link reads it (`appUrlAsRead`, `appUrlHeldAt`), and each named destination's (`destinationPlace`,
 * `destinationHeldAt`). Read before the clear for this server, and after the copy for the backup. Reads.
 */
function settingPlacesIn(database: Database.Database): SettingPlaces {
	// backup-secrets' one read of a setting (card 3009's code review, FP15); a value that is not text is read as none.
	const textSettingOf = (from: Database.Database, key: string) => {
		const value = settingOf(from, key) as unknown;
		return typeof value === 'string' ? value : null;
	};
	const host = textSettingOf(database, 'smtp_host') ?? '';
	const mail =
		host === ''
			? null
			: mailPlaceOf({
					host,
					port: Number(textSettingOf(database, 'smtp_port') || '587'),
					user: textSettingOf(database, 'smtp_user') || '',
					allowInsecure: textSettingOf(database, 'smtp_allow_insecure') === 'true'
				});
	const appUrl = appUrlPlaceOf(appUrlAsRead(textSettingOf(database, 'app_url') ?? ''));
	const destinations: SettingPlaces['destinations'] = [];
	let config: unknown = null;
	try {
		config = JSON.parse(textSettingOf(database, 'backup_config') ?? 'null');
	} catch {
		// Not JSON: no destination in it.
	}
	const listed = config !== null && typeof config === 'object' && Array.isArray((config as { destinations?: unknown }).destinations)
		? ((config as { destinations: unknown[] }).destinations)
		: [];
	for (const entry of listed) {
		const name = entry !== null && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined;
		if (typeof name === 'string') destinations.push({ name, place: placeKey(destinationPlace(entry)) });
	}
	return { mail, appUrl, destinations };
}

/**
 * Hold for the superadmin's review what a backup whose seal did not verify brings in that reaches outside (card 3009,
 * R4), inside the restore's transaction, after the copy and the carry of this server's holds (`carrySettingHolds`),
 * as card 2922's ending holds what an account set: a `setting_holds` row, `INSERT OR IGNORE`, set by nobody, for the
 * restored mail settings where they are at another place than this server's were (`before`), for each restored
 * destination at a place this server held no destination at, and for the restored App URL where it differs from this
 * server's, wherever `ORIGIN` points: with the image's placeholder no origin restricts it (`appUrlOnEnvironment`).
 * Nothing is sent through any of them, and no link begins with the App URL, until the superadmin keeps or removes it.
 * Only on the server's own restore that keeps what reaches outside; a working copy removes the mail, the destinations and,
 * for an unsealed backup, the App URL (`switchOffOutside`; card 3009's code review, FP3).
 * Counts the rows it wrote (FP8), naming nothing. Not caught.
 */
function holdUnsealedSettings(live: Database.Database, before: SettingPlaces, at: string): UnsealedHeld {
	const held: UnsealedHeld = { mail: 0, destinations: 0, appUrl: 0 };
	const now = settingPlacesIn(live);
	const hold = live.prepare(
		'INSERT OR IGNORE INTO setting_holds (setting, place, held_because, held_at, set_by, set_by_name) VALUES (?, ?, ?, ?, NULL, NULL)'
	);
	// Each counted by the rows it wrote (card 3009's code review, FP8): a hold this server carried there already is no new one.
	if (now.mail !== null && now.mail !== before.mail) {
		held.mail = hold.run(MAIL_SETTING, now.mail, UNSEALED_RESTORE, at).changes;
	}
	if (now.appUrl !== null && now.appUrl !== before.appUrl) {
		held.appUrl = hold.run(APP_URL_SETTING, now.appUrl, UNSEALED_RESTORE, at).changes;
	}
	const placesHere = new Set(before.destinations.map((destination) => destination.place));
	for (const destination of now.destinations) {
		if (placesHere.has(destination.place)) continue;
		held.destinations += hold.run(DESTINATION_SETTING + destination.name, destination.place, UNSEALED_RESTORE, at).changes;
	}
	return held;
}

/** A setting held for the superadmin's review here (card 2922, migration 0074), as `settingHoldsHere` reads it. */
type SettingHoldHere = { setting: string; place: string; heldBecause: string; heldAt: string; setBy: number | null; setByName: string | null };

/**
 * This server's settings held for review (card 2922), read before a restore
 * clears the table. None where the database has no such table.
 */
function settingHoldsHere(live: Database.Database): SettingHoldHere[] {
	try {
		return live
			.prepare(
				'SELECT setting, place, held_because AS heldBecause, held_at AS heldAt, set_by AS setBy, set_by_name AS setByName FROM setting_holds'
			)
			.all() as SettingHoldHere[];
	} catch {
		return [];
	}
}

/**
 * Carry this server's settings held for review over the restored ones (card
 * 2922, its plan's R10): a union, each (setting, place) held here held after
 * the restore whatever the backup had, and the backup's own holds kept. So a
 * backup made before an ending, or before a Remove (whose hold stays as a
 * tombstone, R1), never brings a setting back in force at a held place; and a
 * setting kept here since the backup was made may come back held, which the
 * import says. A name of its own, apart from the webhooks' `carryHolds`.
 * Returns how many holds the backup did not have.
 */
function carrySettingHolds(live: Database.Database, holds: readonly SettingHoldHere[]): number {
	if (holds.length === 0) return 0;
	const carry = live.prepare(
		'INSERT OR IGNORE INTO setting_holds (setting, place, held_because, held_at, set_by, set_by_name) VALUES (?, ?, ?, ?, ?, ?)'
	);
	let carried = 0;
	for (const hold of holds) carried += carry.run(hold.setting, hold.place, hold.heldBecause, hold.heldAt, hold.setBy, hold.setByName).changes;
	return carried;
}

/** The setting `mail_ever_configured_at` here (card 2922, R9: `MAIL_EVER_CONFIGURED` in email.ts), or null for none. */
function mailEverConfiguredHere(live: Database.Database): string | null {
	try {
		const row = live.prepare("SELECT value FROM settings WHERE key = 'mail_ever_configured_at'").get() as { value: string } | undefined;
		return row?.value ?? null;
	} catch {
		return null;
	}
}

/**
 * An account of this server's that is disabled (migration 0072, card 2671), as
 * `disabledHere` reads it: with the account that disabled it, by id,
 * `created_at` and role, or nulls where that account is gone.
 */
type DisabledHere = {
	id: number;
	createdAt: string;
	disabledAt: string;
	disabledBy: number | null;
	disablerCreatedAt: string | null;
	disablerRole: string | null;
};

/**
 * This server's disabled accounts, read before a restore clears `users` (card
 * 2671, S6): by id and `created_at`, which name one account for its whole
 * life (schema.ts), with when, and by whom by the same two (the code review's
 * CS3). None where the database has no such columns, asked of its columns
 * (CS4); any other failure throws, and the restore is rolled back.
 */
function disabledHere(live: Database.Database): DisabledHere[] {
	const columns = columnNamesOf(live, 'users');
	if (!columns.includes('disabled_at') || !columns.includes('disabled_by')) return [];
	return live
		.prepare(
			`SELECT u.id, u.created_at AS createdAt, u.disabled_at AS disabledAt, u.disabled_by AS disabledBy,
				d.created_at AS disablerCreatedAt, d.role AS disablerRole
			 FROM users u LEFT JOIN users d ON d.id = u.disabled_by
			 WHERE u.disabled_at IS NOT NULL`
		)
		.all() as DisabledHere[];
}

/**
 * Hold the restored webhooks already switched off without a hold (card 2923,
 * S3; its code review, S2, S3), after the carries, so that switching one on
 * gives it a new secret: every one of them, whoever set it, where the restored
 * `settings` do not hold `webhooks_already_off_held` (a backup from before the
 * release, whose endings of access held none); else those whose setter is
 * disabled, carried here or in the backup, or not recorded
 * (`holdUnheldOfGoneSetters`). The flag is not written here: the restored
 * settings are the backup's, and the next start, finding none, holds every
 * one still unheld and writes it. Inside the restore's transaction, so a
 * failure rolls the restore back. Returns those held; the server's own
 * restore tells them with its sweep, a working copy nobody.
 */
function holdRestoredAlreadyOff(live: Database.Database): SwitchedOff[] {
	const every = !live.prepare('SELECT 1 FROM settings WHERE key = ?').get(WEBHOOKS_ALREADY_OFF_HELD);
	return holdUnheldOfGoneSetters(live, { every });
}

/**
 * The start pass run by the restore itself (card 2935, P12; its code review, C3), after the carries and before any
 * secret is filled, always: from the restored `settings`' own moment, every webhook a disabled owner or
 * administrator of the restored data could read and that was made before its disable (or, with no moment, as the
 * first start does: every disabled one's, and every one made before setters were recorded), a webhook the backup
 * left without its secret counted as having one (`listed`); the moment then written as now where anything lay after
 * it (`coverReadable`). Never skipped for what this server's own moment says: the restored data's disables are the
 * backup's. Inside the restore's transaction: a failure rolls the restore back. Returns those held, told with the
 * sweep by the server's own restore, and to nobody by a working copy.
 */
function holdRestoredReadable(live: Database.Database, listed: readonly number[]): { switchedOff: SwitchedOff[]; held: SwitchedOff[] } {
	if (!hasSettingsTable(live)) return { switchedOff: [], held: [] };
	return coverReadable(live, { since: readableCoveredAt(live), listed });
}

/** Whether `live` has a `settings` table to hold the pass's moment in. */
function hasSettingsTable(live: Database.Database): boolean {
	return !!live.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get();
}

/**
 * Carry this server's disabled accounts onto the same accounts restored (card
 * 2671, S6, D17): a restored account with the same id and `created_at` as one
 * disabled here is disabled again, whatever the backup had, so that a restore
 * never lets a disabled account back in, from a backup made before it was
 * disabled or before migration 0072 alike. Never onto a restored superadmin,
 * whom nobody may disable, and who must stay able to sign in.
 *
 * `disabled_by` is kept only where the account that disabled it is restored
 * too, by id and `created_at` (the code review's CS3): an id alone may name
 * someone else in the backup. Where it is not, and that account was the
 * superadmin here, it is the restored superadmin, so that only the
 * superadmin may undo it there too (S14); else NULL. What disabling ended is
 * ended again for each: their restored API keys deleted and their restored
 * report schedules paused. Their webhooks are switched off by the restore's
 * sweep, which runs after this. Returns the ids carried.
 *
 * The ids of the keys it deletes go into `keyIds`, which the restore's answer
 * counts with the keys it leaves out (card 2995, R13), and every webhook that
 * names one of them as the key that set it is made to name none, as the
 * foreign key's ON DELETE SET NULL would with the foreign keys on (R8): the
 * hold rule reads that as a key that ended.
 */
function carryDisabled(live: Database.Database, disabled: readonly DisabledHere[], reveals: Reveal[] = [], keyIds: number[] = []): number[] {
	if (disabled.length === 0) return [];
	const restored = live.prepare('SELECT id FROM users WHERE id = ? AND created_at = ? AND role <> ?');
	const sameAccount = live.prepare('SELECT 1 FROM users WHERE id = ? AND created_at = ?');
	const superadmin = live.prepare("SELECT id FROM users WHERE role = 'superadmin' AND disabled_at IS NULL ORDER BY id LIMIT 1");
	const disable = live.prepare('UPDATE users SET disabled_at = ?, disabled_by = ? WHERE id = ?');
	const endRestoredAccess = restoredAccessEnder(live);
	const carried: number[] = [];
	for (const account of disabled) {
		if (restored.get(account.id, account.createdAt, 'superadmin') === undefined) continue;
		const disabler =
			account.disabledBy !== null && account.disablerCreatedAt !== null && sameAccount.get(account.disabledBy, account.disablerCreatedAt) !== undefined
				? account.disabledBy
				: null;
		const by =
			disabler !== null
				? disabler
				: account.disablerRole === 'superadmin'
					? ((superadmin.get() as { id: number } | undefined)?.id ?? null)
					: null;
		disable.run(account.disabledAt, by, account.id);
		// Its keys recorded as ended here first, `access ended` (card 2995): its disable ended them, and a later restore of
		// the same backup, the account enabled again meanwhile, still leaves them out.
		endRestoredAccess(account.id, REVOKED_BECAUSE.accessEnded, reveals, keyIds);
		carried.push(account.id);
	}
	return carried;
}

/**
 * What a restore ends of a restored account it disables (card 2671's carry, and card 2996's `applyAccountEndings`),
 * one body for both on the restore's own connection: the rows of `webhook_reveals` of its keys collected into
 * `reveals`, for the restore to hold what those keys were given, and deleted explicitly with them (card 2947, R2: the
 * foreign keys are off during a restore, so no cascade takes them); its keys recorded as ended and deleted
 * (`endApiKeys`, `because`), their ids added to `keyIds`, which the answer counts with the keys left out (card 2995,
 * R13), and every webhook that names one as the key that set it made to name none (R8); its report schedules paused.
 * Its sessions, invites, pending sign-ins, enrolment links and request links no restore brings in; what it set is
 * switched off by the restore's sweep; what it could read is held by the readable pass and `holdNoLongerReadableIn`;
 * and the settings it set, with its address in the backup failure address, go once the import has committed
 * (`removeSettingsOfFormerAdministrators('restore')`, A15). Not caught.
 *
 * Made once for a restore's connection (card 2996's code review, FP11): the probe of `webhook_reveals` and the
 * statements are prepared once, not once an account.
 */
function restoredAccessEnder(live: Database.Database): (accountId: number, because: RevokedBecause, reveals: Reveal[], keyIds: number[]) => void {
	const hasReveals = tableIn(live, 'webhook_reveals');
	const revealsOf = hasReveals
		? live.prepare(
				'SELECT r.webhook_id AS webhookId, r.key_id AS keyId, k.user_id AS userId, r.revealed_at IS NULL AS before ' +
					'FROM webhook_reveals AS r JOIN api_keys AS k ON k.id = r.key_id WHERE k.user_id = ? ORDER BY r.webhook_id, r.key_id'
			)
		: null;
	const forgetReveals = hasReveals ? live.prepare('DELETE FROM webhook_reveals WHERE key_id IN (SELECT id FROM api_keys WHERE user_id = ?)') : null;
	const pauseSchedules = live.prepare('UPDATE report_schedules SET enabled = 0, updated_at = ? WHERE user_id = ? AND enabled = 1');
	return function endRestoredAccess(accountId, because, reveals, keyIds) {
		if (revealsOf !== null && forgetReveals !== null) {
			for (const row of revealsOf.all(accountId) as (Omit<Reveal, 'before'> & { before: number })[]) reveals.push({ ...row, before: row.before === 1 });
			forgetReveals.run(accountId);
		}
		const ended = endApiKeys(live, { userId: accountId }, because);
		keyIds.push(...ended);
		forgetSetByKey(live, ended);
		pauseSchedules.run(stamp(), accountId);
	};
}

/** Whether `database` has a table of this name (card 2996's code review, FP11: one probe for the carries). */
function tableIn(database: Database.Database, name: string): boolean {
	return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * A backup's own id bound for `table` (card 2995, R6; card 2996, R14; FP11): the larger of its `sqlite_sequence`
 * counter `counterName` and the largest whole-number `id` its `table` holds, read from the table's own storage; 0 where
 * it has neither.
 */
function backupBound(backup: Database.Database, table: string, counterName: string): number {
	const counter = tableIn(backup, 'sqlite_sequence')
		? Number((backup.prepare('SELECT max(seq) AS seq FROM sqlite_sequence WHERE name = ?').get(counterName) as { seq: unknown }).seq ?? 0)
		: 0;
	const largest = columnNamesOf(backup, table).includes('id')
		? Number((backup.prepare(`SELECT max(id) AS id FROM (${fromTableStorage(backup, table)})`).get() as { id: unknown }).id ?? 0)
		: 0;
	return Math.max(Number.isSafeInteger(counter) ? counter : 0, Number.isSafeInteger(largest) ? largest : 0);
}

/** This server's accounts as the record of account endings reads them, before the clear (card 2996). */
type AccountsHere = {
	/** Each account with an id up to W, by id, with its `created_at` (rule 2's held-here half); every one where W is unknown. */
	held: Map<number, string>;
	/** Its superadmins, by id and fingerprint: no backup row naming one is taken (R1). */
	superadmins: { ids: number[]; credentials: string[] };
	/**
	 * Every account it holds, whatever its id, by id, with its `created_at` and its password hash (card 2997): the same
	 * account restored is given back this server's password where the backup's is one replaced here (`applyPasswordRulings`).
	 * With its username, which `sameAccountHere` asks of a backup that carries no installation id, and its email (card
	 * 3009). And its notification choices, which the same account restored from an unsealed backup is given back (card
	 * 3012), null where the column is not there or holds none.
	 */
	hashes: Map<number, { createdAt: string; username: string; email: string; passwordHash: string; enrol: number; notificationPrefs: string | null }>;
};

/**
 * W, and the id and `created_at` of every account this server holds with an id up to W, with its superadmins, and every
 * account's `created_at` and password hash (card 2997), read before a restore clears `users` (card 2996), as
 * `keysHeldHere` is read. None where the database has no record.
 */
function accountsHeldHere(live: Database.Database): AccountsHere {
	const none: AccountsHere = { held: new Map(), superadmins: { ids: [], credentials: [] }, hashes: new Map() };
	if (!hasAccountRecord(live) || !columnNamesOf(live, 'users').includes('created_at')) return none;
	const watermark = accountWatermarkOf(live);
	// The leave to set up on a password alone (card 2769), which the carry gives the backup's superadmin from the importer
	// (card 3009's code review, FP6); none before migration 0066.
	const enrol = columnNamesOf(live, 'users').includes('mfa_password_enrol') ? 'mfa_password_enrol' : '0';
	// Card 3012: the notification choices, which `keepAccountsHere` gives back to the same account here.
	const prefs = columnNamesOf(live, 'users').includes('notification_prefs') ? 'notification_prefs' : 'NULL';
	const rows = live
		.prepare(
			`SELECT id, created_at AS createdAt, username, email, role, password_hash AS passwordHash, ${enrol} AS enrol, ${prefs} AS notificationPrefs FROM users ORDER BY id`
		)
		.all() as {
		id: number;
		createdAt: string;
		username: string;
		email: string;
		role: string;
		passwordHash: string;
		enrol: number;
		notificationPrefs: string | null;
	}[];
	const supers = rows.filter((row) => row.role === 'superadmin');
	return {
		held: new Map(rows.filter((row) => watermark === null || row.id <= watermark).map((row) => [row.id, row.createdAt])),
		superadmins: { ids: supers.map((row) => row.id), credentials: supers.map((row) => credentialOf(row.passwordHash)).filter((c) => c !== '') },
		hashes: new Map(rows.map((row) => [row.id, { createdAt: row.createdAt, username: row.username, email: row.email, passwordHash: row.passwordHash, enrol: row.enrol === 1 ? 1 : 0, notificationPrefs: row.notificationPrefs }]))
	};
}

/** Why a row of a backup's record of account endings was left out (card 2996, R14, R1), counted by reason: never the row's own text. */
type AccountRowFault =
	| 'an id that is not a whole number from 1 to 2^53 - 1'
	| 'an ending this build does not know'
	| 'a creation time that is not one the ending can have'
	| 'a role that is neither user nor admin'
	| 'a fingerprint that is not one the ending can have'
	| "an id above the backup's own account counter"
	| 'a creation time later than the restore'
	| 'a row naming the superadmin';

/**
 * The most rows taken from one backup's record of account endings (R14; card 2996's code review, FP7): seed rows,
 * which name an account by its id alone, as many as migration 0077's guard lets it write, and as many other rows
 * again; over either, none of it is.
 */
const MOST_SEED_ROWS = 1_000_000;
const MOST_OTHER_ROWS = 1_000_000;

/** The most rows one backup's record may hold for one account, by id and creation time (FP3): over that, none of it is taken. */
const MOST_ROWS_PER_ACCOUNT = 100;

/** A row of the backup's record as the union takes it. */
type CarriedRow = { id: number; created: string; ending: string; role: string; credential: string; endedAt: string | null; stated: string };

/**
 * Add the backup's record of account endings to this server's (card 2996, section 3.5 as section 11 rules it), inside
 * the restore's transaction, each row read from the snapshot's table storage in its order and kept only where:
 *
 * - `user_id` is a safe integer of at least 1 (0 on a watermark row) and at most the backup's own bound, its `users`
 *   counter or its largest account id, whichever is greater: exact, seed and watermark rows alike (R14);
 * - `ending` is one of this build's words;
 * - `account_created` is '' on a watermark row, '' or a moment on a `deleted` row, a moment on any other (a
 *   `password` row's included, card 2997), and that moment no later than the restore's (R14);
 * - `role` is `user` or `admin` on a `role` row, '' on any other;
 * - `credential` is '' or a SHA-256 in lower-case hex on a `deleted` row, always one on a `password` row (card 2997),
 *   and '' on any other;
 * - it names no superadmin, of the restored data or this server's, by id or by fingerprint (R1); but for a `password`
 *   row, which is carried whoever it names (card 2997, R7), since a backup's never counts for a superadmin.
 *
 * `ended_at` is read as a moment; one that names none, or one later than the restore, is taken as the backup's own
 * latest moment that is not, among the rows it takes and its accounts' creation times (R15; card 2996's code review,
 * FP5). A row is added, `origin` `backup`, only where no row of this server's record before this restore has the same
 * natural key: its creation time in the stored form and the moment as the backup stated it (`stated_ended`), so that
 * importing the same backup again adds nothing whenever it runs (R4, FP3, FP5): the backup's own rows are all kept, so
 * that two endings in one second keep their order. More than 1,000,000 seed rows, more than 1,000,000 other rows, or
 * more than 100 rows for one account by id and creation time, its `password` rows not counted among the 100 (card 2997,
 * R8: an account changes its password more often than it is ended): none of it is added, and the rows it held are
 * counted (R14, FP3, FP7). Every row left out is counted in one `errors` line, a count and reasons, never quoting the backup.
 * The rows are read twice, as an iteration, never all at once (FP7). Then this server's `users` counter is raised over
 * every seed and watermark id (`raiseUserCounterOverSeed`). Not caught: a failure rolls the restore back. Returns how
 * many rows it added, and how many of the backup's it left out whole.
 */
function carryAccountEndings(live: Database.Database, backup: Database.Database, errors: string[], at: string, here: AccountsHere): { added: number; leftOutWhole: number } {
	let added = 0;
	let leftOutWhole = 0;
	if (tableIn(backup, ACCOUNT_RECORD)) {
		const columns = columnNamesOf(backup, ACCOUNT_RECORD);
		const readable = hasColumns(backup, ACCOUNT_RECORD, ['user_id', 'account_created', 'ending', 'ended_at']);
		const from = fromTableStorage(backup, ACCOUNT_RECORD);
		const sizes = readable
			? (backup
					.prepare(
						"SELECT count(*) AS total, coalesce(sum(CASE WHEN account_created = '' AND ending = 'deleted' THEN 1 ELSE 0 END), 0) AS seed, " +
							`coalesce((SELECT max(n) FROM (SELECT count(*) AS n FROM (${from}) WHERE coalesce(ending, '') NOT IN ('watermark', 'password') GROUP BY user_id, account_created)), 0) AS most ` +
							`FROM (${from})`
					)
					.get() as { total: number; seed: number; most: number })
			: { total: 0, seed: 0, most: 0 };
		const whole = (why: string) => {
			leftOutWhole = sizes.total;
			errors.push(`The backup's record of account endings holds ${why}, more than any server writes, and none of its ${sizes.total} row(s) was added to this server's.`);
		};
		if (!readable) {
			errors.push("The backup's record of account endings has not the columns this build reads, and was not added to this server's.");
		} else if (sizes.seed > MOST_SEED_ROWS) {
			whole(`more than ${MOST_SEED_ROWS.toLocaleString('en-GB')} rows naming accounts by number alone`);
		} else if (sizes.total - sizes.seed > MOST_OTHER_ROWS) {
			whole(`more than ${MOST_OTHER_ROWS.toLocaleString('en-GB')} rows naming accounts by number and creation time`);
		} else if (sizes.most > MOST_ROWS_PER_ACCOUNT) {
			whole(`more than ${MOST_ROWS_PER_ACCOUNT} rows for one account`);
		} else {
			// The backup's own bound: its account counter, or its largest account id, whichever is greater (FP11).
			const bound = backupBound(backup, 'users', 'users');
			// The superadmins of the restored data, with this server's (R1).
			const restoredSupers = live.prepare("SELECT id, password_hash AS passwordHash FROM users WHERE role = 'superadmin'").all() as { id: number; passwordHash: string }[];
			const superIds = new Set([...here.superadmins.ids, ...restoredSupers.map((row) => row.id)]);
			const superCredentials = new Set([...here.superadmins.credentials, ...restoredSupers.map((row) => credentialOf(row.passwordHash)).filter((c) => c !== '')]);
			const stated = columns.includes('stated_ended');
			// A row this server holds already, by the union's own key (FP1): a backup of this server's own carries its rows on
			// an account promoted to superadmin since, which are no news and are not counted as left out.
			const heldAlready = live.prepare(
				'SELECT 1 FROM account_endings WHERE user_id = @id AND account_created = @created AND ending = @ending ' +
					"AND (stated_ended = @stated OR (stated_ended = '' AND ended_at = @stated)) AND role = @role AND credential = @credential LIMIT 1"
			);
			/** A row of the backup judged: taken, the reason it is left out, or `held` where this server holds it already. */
			const judge = (row: Record<string, unknown>): CarriedRow | AccountRowFault | 'held' => {
				const id = row.user_id;
				const ending = row.ending;
				const watermark = ending === ACCOUNT_ENDING.watermark;
				if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < (watermark ? 0 : 1)) return 'an id that is not a whole number from 1 to 2^53 - 1';
				if (typeof ending !== 'string' || !ACCOUNT_ENDING_WORDS.includes(ending)) return 'an ending this build does not know';
				const createdText = row.account_created;
				const created = toStamp(createdText);
				const seedLike = createdText === '';
				if (watermark ? !seedLike : seedLike ? ending !== ACCOUNT_ENDING.deleted : created === null) return 'a creation time that is not one the ending can have';
				const role = row.role ?? '';
				if (ending === ACCOUNT_ENDING.role ? typeof role !== 'string' || !ENDED_ROLES.includes(role) : role !== '') return 'a role that is neither user nor admin';
				const credential = row.credential ?? '';
				// A fingerprint on a `deleted` row, or '' there; on a `password` row always one (card 2997: a row of a hash replaced).
				const fingerprinted = ending === ACCOUNT_ENDING.deleted || ending === ACCOUNT_ENDING.password;
				if (
					typeof credential !== 'string' ||
					(credential !== '' && (!fingerprinted || !/^[0-9a-f]{64}$/.test(credential))) ||
					(ending === ACCOUNT_ENDING.password && credential === '')
				) {
					return 'a fingerprint that is not one the ending can have';
				}
				if (id > bound) return "an id above the backup's own account counter";
				if (created !== null && created > at) return 'a creation time later than the restore';
				// The moment as the backup stated it (FP5): its own stated moment where it carries one, else its `ended_at`;
				// the stored form where it names a moment, else a digest of its text, never the text.
				const said = stated && typeof row.stated_ended === 'string' && row.stated_ended !== '' ? row.stated_ended : row.ended_at;
				const statedAt = toStamp(said) ?? `?${createHash('sha256').update(String(said)).digest('hex').slice(0, 32)}`;
				const taken: CarriedRow = { id, created: created ?? '', ending, role: role as string, credential, endedAt: toStamp(row.ended_at), stated: statedAt };
				// A `password` row is carried whoever it names (card 2997, R7): a backup's never counts for a superadmin.
				if (!watermark && ending !== ACCOUNT_ENDING.password && (superIds.has(id) || (credential !== '' && superCredentials.has(credential)))) {
					const { endedAt: _endedAt, ...key } = taken;
					return heldAlready.get(key) === undefined ? 'a row naming the superadmin' : 'held';
				}
				return taken;
			};

			// First pass: what is taken, and the backup's own latest moment no later than the restore's among those rows and
			// its accounts' creation times (R15, FP5).
			const faults = new Map<AccountRowFault, number>();
			let fixed = '';
			const later = (moment: string | null) => {
				if (moment !== null && moment <= at && moment > fixed) fixed = moment;
			};
			for (const row of backup.prepare(from).iterate() as Iterable<Record<string, unknown>>) {
				const taken = judge(row);
				if (taken === 'held') continue;
				if (typeof taken === 'string') faults.set(taken, (faults.get(taken) ?? 0) + 1);
				else later(taken.endedAt);
			}
			if (columnNamesOf(backup, 'users').includes('created_at')) {
				for (const row of backup.prepare(`SELECT created_at FROM (${fromTableStorage(backup, 'users')})`).iterate() as Iterable<{ created_at: unknown }>) {
					later(toStamp(row.created_at));
				}
			}
			const fixedPoint = fixed === '' ? at : fixed;

			// Second pass: each taken row added where this server held no row of its key before the restore (R4, FP3, FP5).
			const before = (live.prepare('SELECT coalesce(max(seq), 0) AS seq FROM account_endings').get() as { seq: number }).seq;
			const put = live.prepare(CARRY_ACCOUNT_ENDING_SQL);
			for (const row of backup.prepare(from).iterate() as Iterable<Record<string, unknown>>) {
				const taken = judge(row);
				if (typeof taken === 'string') continue;
				const { endedAt, ...key } = taken;
				added += put.run({ ...key, endedAt: endedAt === null || endedAt > at ? fixedPoint : endedAt, before }).changes;
			}
			const leftOut = [...faults.values()].reduce((sum, n) => sum + n, 0);
			if (leftOut > 0) {
				errors.push(
					`${leftOut} row(s) of the backup's record of account endings were left out, as they can name no account here: ` +
						[...faults].map(([why, n]) => `${n} with ${why}`).join(', ') +
						". The rest of the record was added to this server's."
				);
			}
		}
	}
	raiseUserCounterOverSeed(live);
	return { added, leftOutWhole };
}

/**
 * Apply the record's rulings to the restored accounts (card 2996, section 3.4 as section 11 rules it), inside the
 * restore's transaction, after `carryDisabled`: each through `endRestoredAccess`, as the carry of a disable ends what an
 * account held.
 *
 * - **Deleted (inert):** a `deleted` row written, `here`, where none names it by its very creation time, carrying the
 *   fingerprint it was matched on (R3); disabled (at the restore's moment where it was not), by the superadmin, with
 *   `DUMMY_HASH` for its password and no leave to set up on it; its keys ended `account deleted`.
 * - **Before record:** an exact `disabled` row written, `here`, so that from then on its exact rows govern and an
 *   enable by the superadmin sticks; disabled by the superadmin with `DUMMY_HASH` (R21); its keys ended `access ended`.
 * - Either way, the hash `DUMMY_HASH` replaces is recorded as replaced, a `password` row, `belt`, unless it is a
 *   superadmin (card 2997, N1).
 * - **Disabled:** where it is enabled, disabled at the latest `disabled` row's moment, by the superadmin; its password
 *   kept; its keys ended `access ended`.
 * - **Lowered:** given the role the record holds.
 *
 * `disabled_by` is the enabled superadmin of the restored rows with the lowest id that the record ends nothing of
 * (S14: only the superadmin may enable or delete it), or none. A superadmin the record ends or lowers is ended or
 * lowered, and the restore is then refused, if none is left (decision 6). Not caught. Returns the counts, and every
 * account it ended or lowered, with the role it was restored with, for `holdNoLongerReadableIn` (R7).
 */
function applyAccountEndings(
	live: Database.Database,
	rulings: readonly AccountRuling[],
	at: string,
	reveals: Reveal[],
	keyIds: number[]
): { kept: AccountsKept; ruled: RuledReader[]; superadminEnded: boolean } {
	const kept: AccountsKept = { deleted: 0, beforeRecord: 0, disabled: 0, lowered: 0 };
	const ruled: RuledReader[] = [];
	let superadminEnded = false;
	if (rulings.length === 0) return { kept, ruled, superadminEnded };
	const ending = rulings.filter((ruling) => ruling.ended !== null).map((ruling) => ruling.id);
	const by =
		(
			live
				.prepare(
					"SELECT id FROM users WHERE role = 'superadmin' AND disabled_at IS NULL AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 1"
				)
				.get(JSON.stringify(ending)) as { id: number } | undefined
		)?.id ?? null;
	const current = live.prepare('SELECT role, disabled_at AS disabledAt FROM users WHERE id = ?');
	const inert = live.prepare(
		'UPDATE users SET disabled_at = coalesce(disabled_at, @at), disabled_by = @by, password_hash = @dummy, mfa_password_enrol = 0 WHERE id = @id'
	);
	const disable = live.prepare('UPDATE users SET disabled_at = @at, disabled_by = @by WHERE id = @id');
	const lower = live.prepare('UPDATE users SET role = @role WHERE id = @id');
	const endRestoredAccess = restoredAccessEnder(live);
	for (const ruling of rulings) {
		const account = current.get(ruling.id) as { role: string; disabledAt: string | null } | undefined;
		if (account === undefined) continue;
		// A superadmin of the restored data or here (FP2): never given a belt.
		const superadmin = account.role === 'superadmin' || ruling.superadmin;
		let ended = false;
		if (ruling.ended === 'deleted' || ruling.ended === 'before record') {
			const deleted = ruling.ended === 'deleted';
			// The belt (R3; rule 2), `origin` `belt` (FP2): written before the password goes, so that a `deleted` row carries
			// the fingerprint the account was matched on. Never of a superadmin, whose only rows that count are this server's
			// own `deleted` rows, there already.
			if (!superadmin && (!deleted || !ruling.exactDeleted)) {
				recordAccountEnding(live, ruling.id, deleted ? ACCOUNT_ENDING.deleted : ACCOUNT_ENDING.disabled, { at, origin: ORIGIN.belt });
			}
			// And the hash `DUMMY_HASH` replaces, recorded as replaced, `belt` (card 2997, N1, R17): so that an account the
			// superadmin brings back into use, with a new password, is not given this one by the next restore of the same
			// backup. Never of a superadmin (R6: a belt never counts for one). At the restore's moment, as the belt above
			// (the code review's FP5, closing NF3); written once, so that importing the same backup again adds none.
			if (!superadmin) recordPasswordReplaced(live, ruling.id, { origin: ORIGIN.belt, at });
			inert.run({ at, by, dummy: DUMMY_HASH, id: ruling.id });
			endRestoredAccess(ruling.id, deleted ? REVOKED_BECAUSE.accountDeleted : REVOKED_BECAUSE.accessEnded, reveals, keyIds);
			if (deleted) kept.deleted++;
			else kept.beforeRecord++;
			ended = true;
		} else if (ruling.ended === 'disabled' && account.disabledAt === null) {
			disable.run({ at: ruling.disabledAt ?? at, by, id: ruling.id });
			endRestoredAccess(ruling.id, REVOKED_BECAUSE.accessEnded, reveals, keyIds);
			kept.disabled++;
			ended = true;
		}
		if (ruling.lowerTo !== null) {
			lower.run({ role: ruling.lowerTo, id: ruling.id });
			kept.lowered++;
		}
		// Only an account this restore disabled, made inert or lowered is held for what it could read (FP8).
		if (!ended && ruling.lowerTo === null) continue;
		if (account.role === 'superadmin') superadminEnded = true;
		ruled.push({ id: ruling.id, was: ruling.role, ended });
	}
	return { kept, ruled, superadminEnded };
}

/**
 * Keep every restored password this server replaced out of use (card 2997, section 13.1 of its plan), inside the
 * restore's transaction, after `applyAccountEndings`: for each restored account but one card 2996 ruled `deleted` or
 * `before record` (`ended`, already `DUMMY_HASH`), a superadmin by its role as restored now (R10):
 *
 * - **Replaced:** the record names its hash as replaced here (`passwordReplacedHere`, the one matcher). Acted on then,
 *   or, where the backup's seal did not verify, wherever it is the same account here holding another hash than this
 *   server's (R2: an edited or foreign backup can give a fresh hash of a leaked password). Otherwise left as the backup
 *   has it.
 * - **The same account here** (`here.hashes`, by `sameAccountHere` under `trust`, card 3009: its creation time the
 *   same moment, and, for an unsealed backup, this installation's id, or no id and the same username): this server's hash where that is
 *   usable, a bcrypt string the record does not name, counted `here`; otherwise `DUMMY_HASH`, no leave to set up
 *   two-step sign-in on it, and its access ended (`endRestoredAccess`, `access ended`), counted `reset` (R11); a
 *   superadmin instead given this server's hash where that is bcrypt, else left, and counted `superadmin`.
 * - **Not here:** `DUMMY_HASH`, no enrol leave and its access ended, counted `reset`. A superadmin not here, whatever
 *   the first lookup said, is decided once every other account is (R9, and the code review's FP7): where `importer`, the
 *   id the importing account had before the import, is now the same account here, an enabled superadmin, holding this
 *   server's usable hash, so that somebody can still sign in as the superadmin, it is asked about as anyone else is
 *   (`@super = 0`: any row names it), and given `DUMMY_HASH` likewise where a row does, counted `reset`; otherwise left
 *   as the backup has it, counted `superadmin` only where its own exact `here` row names it.
 *
 * Where R2 discards the backup's hash of an account that is not a superadmin, as restored or here (the same account
 * here, an unsealed backup, another hash than this server's), that hash is first recorded as replaced, a `password` row,
 * `belt`, at the restore's moment (the code review's FP6): so that, once the account is gone from this server, the same
 * backup cannot give it back. Written once (FP5); no other row is written, as a hash it replaces otherwise is recorded already and
 * `DUMMY_HASH` has no fingerprint. Its keys' ids go to `keyIds` and their reveals to `reveals`, counted and held with
 * the others. Not caught: a failure rolls the restore back.
 *
 * **Where the backup's seal did not verify** (card 3009, section 14.1 of its plan), before all of the above, an account
 * that is not the same account here (`mineOf` null) takes nothing from the file that signs in:
 * - anyone but a superadmin: `DUMMY_HASH` and no leave to set up two-step sign-in on it, whatever the file's value,
 *   counted `unsealed`; one already holding `DUMMY_HASH` is not written or counted. Whatever its hash, its report
 *   schedules paused where the restore keeps what reaches outside (`working` false; a working copy's `switchOffOutside`
 *   counts them all, R7; the code review's FP2). No key is ended here and no `password` row is written: the hash was
 *   never this server's (its keys are the key rule's);
 * - a superadmin: decided after every other account. Where the importer is, as restored, the same account here (R2),
 *   or a superadmin of this server is restored as the same account, enabled and holding a usable hash of this server's,
 *   so that somebody can sign in as the superadmin (the code review's FP5): `DUMMY_HASH` as above. Otherwise, where the
 *   importer is one this server held (`here.hashes`) and one of them is enabled, the one with the lowest id is given the
 *   importer's hash as it was here, the importer's leave to set up on its password alone in place of the file's (FP6),
 *   the importer's authenticators sealed again for it with `mfaKey` (R1, `carryFactors`; none where no key is loaded),
 *   and the importer's email, which any other restored account holding that address gives up for one that receives no
 *   mail (R2; FP5, counted `emailGivenUp`); its report schedules are paused as above (FP2); and `superadminGivenYours`
 *   is 1, `givenYoursWithoutFactor` 1 where no authenticator was carried (it then needs the host's `mfa-reset`), and
 *   `givenYoursMayEnrol` 1 where, so, the leave it was given still runs (FP6); every other `DUMMY_HASH`. Otherwise (no
 *   importer, one this server did not hold, or none enabled: R3, failing closed) every one `DUMMY_HASH`.
 *
 * Returns the counts, and how many authenticators were carried, which the second factors' count of accounts with none
 * then leaves out.
 */
function applyPasswordRulings(
	live: Database.Database,
	here: AccountsHere,
	options: {
		/** Whether the backup's seal verified, and its installation id's verdict: what decides the same account here (card 3009). */
		trust: GrantTrust;
		importer?: number;
		ended: ReadonlyMap<number, 'deleted' | 'before record' | 'disabled'>;
		/** The restore's moment, the stored form: R2's belts are stamped with it (FP6). */
		at: string;
		reveals: Reveal[];
		keyIds: number[];
		/** A working copy (`outside` `off`): no schedule is paused here, as `switchOffOutside` switches them all off (card 3009, R7). */
		working: boolean;
		/** This server's second factors as they were before the clear (`readMfaHere`): the importer's are carried (R1). */
		mfaHere: MfaHere;
		/** The restore's MFA key, or null where none is loaded: no authenticator is carried then. */
		mfaKey: MfaKey | null;
	}
): { kept: PasswordsKept; factorsCarried: number } {
	const kept: PasswordsKept = { ...NO_PASSWORDS_KEPT };
	let factorsCarried = 0;
	if (!hasAccountRecord(live)) return { kept, factorsCarried };
	type Restored = { id: number; createdAt: unknown; username: unknown; role: string; passwordHash: unknown; disabledAt: string | null };
	const restoredAll = live.prepare('SELECT id, created_at AS createdAt, username, role, password_hash AS passwordHash, disabled_at AS disabledAt FROM users ORDER BY id');
	const restoredOne = live.prepare('SELECT id, created_at AS createdAt, username, role, password_hash AS passwordHash, disabled_at AS disabledAt FROM users WHERE id = ?');
	const keep = live.prepare('UPDATE users SET password_hash = @hash WHERE id = @id');
	const reset = live.prepare('UPDATE users SET password_hash = @dummy, mfa_password_enrol = 0 WHERE id = @id');
	const endRestoredAccess = restoredAccessEnder(live);
	const resetOne = (id: number) => {
		reset.run({ dummy: DUMMY_HASH, id });
		endRestoredAccess(id, REVOKED_BECAUSE.accessEnded, options.reveals, options.keyIds);
		kept.reset++;
	};
	// Card 3009: the backup's seal did not verify, so its rows are only the uploader's word.
	const unsealed = !options.trust.sealVerified;
	const pauseSchedules = live.prepare('UPDATE report_schedules SET enabled = 0, updated_at = ? WHERE user_id = ? AND enabled = 1');
	/** An account's report schedules paused, unless a working copy switches them all off (R7). */
	const pauseOf = (id: number) => {
		if (!options.working) pauseSchedules.run(stamp(), id);
	};
	/**
	 * An account not the same here, from an unsealed backup (card 3009): the file's password not taken, whatever it is, and
	 * no leave to enrol on it, written and counted only where it did not hold `DUMMY_HASH` already; and its schedules
	 * paused whatever its hash (the code review's FP2). No key ended and no `password` row: the hash was never this server's.
	 */
	const notTakenOne = (account: Restored) => {
		if (account.passwordHash !== DUMMY_HASH) {
			reset.run({ dummy: DUMMY_HASH, id: account.id });
			kept.unsealed++;
		}
		pauseOf(account.id);
	};
	/** This server's hash for the account, where it is the same account here (`sameAccountHere`, card 3009). */
	const mineOf = (account: Restored) => {
		const mine = here.hashes.get(account.id);
		return mine !== undefined && sameAccountHere(mine, account, options.trust) ? mine.passwordHash : null;
	};
	/** Whether this server's hash is one to give back: bcrypt, and not named by the record (asked by the account's role). */
	const usable = (account: Restored, mine: string) => credentialOf(mine) !== '' && !passwordReplacedHere(live, { ...account, passwordHash: mine });
	/** Every superadmin not here with a hash that has a fingerprint, and whether its own exact row names that hash (R9, FP7). */
	const notHereSupers: { account: Restored; replaced: boolean }[] = [];
	/** Card 3009: every superadmin of an unsealed backup that is not the same here, decided after the loop (section 14.1). */
	const unsealedSupers: Restored[] = [];
	for (const account of restoredAll.all() as Restored[]) {
		const ruled = options.ended.get(account.id);
		if (ruled === 'deleted' || ruled === 'before record') continue;
		const superadmin = account.role === 'superadmin';
		const mine = mineOf(account);
		// Card 3009: not the same account here, from a backup whose seal did not verify. Before card 2997's rules, which
		// the same account here and a sealed backup keep.
		if (unsealed && mine === null) {
			if (superadmin) unsealedSupers.push(account);
			else notTakenOne(account);
			continue;
		}
		const replaced = credentialOf(account.passwordHash) !== '' && passwordReplacedHere(live, account);
		if (superadmin && mine === null) {
			if (credentialOf(account.passwordHash) !== '') notHereSupers.push({ account, replaced });
			continue;
		}
		const discarded = !options.trust.sealVerified && mine !== null && account.passwordHash !== mine;
		if (!replaced && !discarded) continue;
		// FP6: the backup's hash R2 throws away, recorded before it is overwritten; never of a superadmin (R6), of the
		// restored data or this server's (card 2996's FP2: a forged backup that lowers this server's superadmin writes no
		// belt on it).
		if (discarded && !superadmin && !here.superadmins.ids.includes(account.id)) recordPasswordReplaced(live, account.id, { origin: ORIGIN.belt, at: options.at });
		if (mine !== null) {
			if (usable(account, mine)) {
				keep.run({ hash: mine, id: account.id });
				kept.here++;
			} else if (!superadmin) {
				resetOne(account.id);
			} else {
				if (credentialOf(mine) !== '') keep.run({ hash: mine, id: account.id });
				kept.superadmin++;
			}
		} else {
			resetOne(account.id);
		}
	}
	if (notHereSupers.length === 0 && unsealedSupers.length === 0) return { kept, factorsCarried };
	// R9: the importer as restored, now that every other account is decided; the same account here (card 3009), and able
	// to sign in as the superadmin with this server's password.
	const importer = options.importer === undefined ? undefined : (restoredOne.get(options.importer) as Restored | undefined);
	const importerMine = importer === undefined ? null : mineOf(importer);
	const importerSame = importer !== undefined && importerMine !== null;
	const importerCanSignIn =
		importer !== undefined &&
		importerMine !== null &&
		importer.role === 'superadmin' &&
		importer.disabledAt === null &&
		importer.passwordHash === importerMine &&
		usable(importer, importerMine);
	for (const { account, replaced } of notHereSupers) {
		// FP7: with somebody able to sign in as the superadmin, asked as anyone else is, so that any row names it.
		if (importerCanSignIn) {
			if (passwordReplacedHere(live, { ...account, role: 'user' })) resetOne(account.id);
		} else if (replaced) {
			kept.superadmin++;
		}
	}
	if (unsealedSupers.length === 0) return { kept, factorsCarried };
	// The code review's FP5: a superadmin of this server, restored as the same account, enabled and holding a usable hash
	// of this server's, so that somebody can sign in as the superadmin (the importer able to sign in among them).
	const superadminHere = here.superadmins.ids.some((id) => {
		const restored = restoredOne.get(id) as Restored | undefined;
		if (restored === undefined || restored.role !== 'superadmin' || restored.disabledAt !== null) return false;
		const mine = mineOf(restored);
		return mine !== null && restored.passwordHash === mine && usable(restored, mine);
	});
	// Card 3009, section 14.1: the importer is in the backup as the same account (R2), or a superadmin here can sign in,
	// so that no superadmin of the file's choosing is given anything.
	if (importerSame || superadminHere) {
		for (const account of unsealedSupers) notTakenOne(account);
		return { kept, factorsCarried };
	}
	// Otherwise the importer's own password, the one this import was just confirmed with, as this server held it before
	// the clear, to the lowest-numbered enabled one (`restoredAll` is by id); none where the importer is not one this
	// server held or none is enabled (R3: failing closed).
	let yours: { id: number; passwordHash: string; email: string; enrol: number } | undefined;
	if (options.importer !== undefined) {
		const held = here.hashes.get(options.importer);
		if (held !== undefined) yours = { id: options.importer, passwordHash: held.passwordHash, email: held.email, enrol: held.enrol };
	}
	const chosen = yours === undefined ? undefined : unsealedSupers.find((account) => account.disabledAt === null);
	for (const account of unsealedSupers) if (account !== chosen) notTakenOne(account);
	if (chosen === undefined || yours === undefined) return { kept, factorsCarried };
	keep.run({ hash: yours.passwordHash, id: chosen.id });
	// FP6: the importer's leave to set up two-step sign-in on its password alone, in place of the file's, whatever is carried.
	if (columnNamesOf(live, 'users').includes('mfa_password_enrol')) live.prepare('UPDATE users SET mfa_password_enrol = ? WHERE id = ?').run(yours.enrol, chosen.id);
	// FP2: its report schedules, the file's, paused as every account's not the same here.
	pauseOf(chosen.id);
	// R1: the importer's authenticators, sealed again for it; its recovery codes stay behind. None without a key.
	if (options.mfaKey !== null) factorsCarried = carryFactors(live, options.mfaHere, options.mfaKey, yours.id, chosen.id);
	// R2, FP5: the importer's email, always: any other restored account holding that address (the column is unique) gives
	// it up for one under `.invalid`, which receives no mail (RFC 2606), counted. So the answer can point at the account by it.
	// Card 3012's code review (FP15): never from an account that is the same here and holds this server's own address
	// for it, one apart from the importer's only in case: that pair is this server's own state, not the file's.
	const sameHereNow = restoredSameHere(live, here, options.trust);
	const holders = live
		.prepare('SELECT id, CAST(email AS TEXT) AS email FROM users WHERE lower(email) = lower(?) AND id <> ?')
		.all(yours.email, chosen.id) as { id: number; email: string }[];
	const giveUp = live.prepare('UPDATE users SET email = ? WHERE id = ?');
	for (const holder of holders) {
		if (sameHereNow(holder.id) && holder.email === here.hashes.get(holder.id)?.email) continue;
		kept.emailGivenUp += giveUp.run(givenUpAddress(holder.id), holder.id).changes;
	}
	live.prepare('UPDATE users SET email = ? WHERE id = ?').run(yours.email, chosen.id);
	kept.superadminGivenYours = 1;
	// No authenticator carried (no key loaded, or none of the importer's opened with it): the password alone does not
	// sign in, as an account with no factor needs a set-up link, which only the host makes for a superadmin; unless it holds
	// the leave to set up on its password alone, given above, and that leave's 14 days still run (FP6).
	if (factorsCarried === 0) {
		kept.givenYoursWithoutFactor = 1;
		const releasedAt = settingOf(live, TWO_STEP_RELEASED_AT) as unknown;
		const ends = passwordSetUpEnds(typeof releasedAt === 'string' ? releasedAt : null);
		if (yours.enrol === 1 && ends !== null && ends.getTime() > Date.now()) kept.givenYoursMayEnrol = 1;
	}
	return { kept, factorsCarried };
}

/**
 * Card 3009, R2: on a restore of a backup whose seal did not verify, each superadmin of this server whose restored row
 * is the same account here (`sameAccountHere`, under `trust`) is a superadmin again and enabled, whatever the file made
 * it: so that no file can lower or disable the superadmin it was imported over and hand the importer's password to an
 * account of its choosing. Run before `carryDisabled`, `applyAccountEndings` and `applyPasswordRulings`, so that each,
 * and the check that a superadmin remains, sees it. A superadmin here is never ended by this server's own record, and no
 * row of a backup's naming one is taken (card 2996, R1), so nothing after it undoes it. Nothing for a sealed backup.
 * Not caught.
 */
function keepSuperadminsHere(live: Database.Database, here: AccountsHere, trust: GrantTrust): void {
	if (trust.sealVerified || here.superadmins.ids.length === 0) return;
	const sameHere = restoredSameHere(live, here, trust);
	const restore = live.prepare("UPDATE users SET role = 'superadmin', disabled_at = NULL, disabled_by = NULL WHERE id = ?");
	for (const id of here.superadmins.ids) if (sameHere(id)) restore.run(id);
}

/**
 * Whether the restored account of an id is the same account here (`sameAccountHere`, under `trust`), by its row as
 * restored and this server's before the clear (`here.hashes`): the one read `keepSuperadminsHere` and
 * `keysOfTheSameHere` share (card 3009's code review, FP15). False where no row of that id is restored. Reads.
 */
function restoredSameHere(live: Database.Database, here: AccountsHere, trust: GrantTrust): (id: number) => boolean {
	const restoredOne = live.prepare('SELECT created_at AS createdAt, username FROM users WHERE id = ?');
	return (id) => {
		const restored = restoredOne.get(id) as { createdAt: unknown; username: unknown } | undefined;
		return restored !== undefined && sameAccountHere(here.hashes.get(id), restored, trust);
	};
}

/**
 * This server's keys (`keysHeldHere(...).all`) whose owner, as restored, is the same account here (`sameAccountHere`,
 * under `trust`; card 3009, section 3.6): the only keys a backup whose seal did not verify may bring back, and only
 * where it holds that very key. None where this server held no account to compare (failing closed). Reads.
 */
function keysOfTheSameHere(live: Database.Database, here: AccountsHere, keys: readonly KeyHere[], trust: GrantTrust): KeyHere[] {
	if (keys.length === 0 || here.hashes.size === 0) return [];
	const restoredSame = restoredSameHere(live, here, trust);
	const same = new Map<number, boolean>();
	const sameHere = (userId: number) => {
		if (!same.has(userId)) same.set(userId, restoredSame(userId));
		return same.get(userId) as boolean;
	};
	return keys.filter((key) => sameHere(key.userId));
}

/**
 * Every webhook that names one of `keyIds` as the key that set it made to name none (card 2995, R8): what the foreign
 * key's ON DELETE SET NULL does with the foreign keys on, done by hand inside a restore, where they are off. The hold
 * rule reads a webhook set with a key that names none as one whose key ended (`holdOf`).
 */
function forgetSetByKey(live: Database.Database, keyIds: readonly number[]): void {
	if (keyIds.length === 0 || !live.prepare("SELECT 1 FROM pragma_table_info('webhooks') WHERE name = 'set_by_key'").get()) return;
	live.prepare('UPDATE webhooks SET set_by_key = NULL WHERE set_by_key IN (SELECT value FROM json_each(?))').run(JSON.stringify(keyIds));
}

/** This server's keys up to W (card 2995, R1), read before the clear: a backup key with one of these ids and another hash is left out. */
type KeysHeldHere = {
	watermark: number | null;
	held: [number, string][];
	/**
	 * Every key this server holds, whatever W, with its owner, expiry and deadline (card 3009, section 3.6 and R5): from a
	 * backup whose seal did not verify only these are kept, for the same account here, each with the earlier expiry.
	 */
	all: KeyHere[];
};

/** One of this server's keys before the clear, as card 3009's unsealed rule reads it. */
type KeyHere = { id: number; keyHash: string; userId: number; expiresAt: string | null; deadlineAt: string | null };

/**
 * W, and the id and hash of every key this server holds with an id up to W, read before a restore clears `api_keys`
 * (card 2995, R1), as `revealsHere` is read. With no watermark, every key's (fail closed). None where the database
 * has no record.
 */
function keysHeldHere(live: Database.Database): KeysHeldHere {
	const all = hasColumns(live, 'api_keys', ['user_id', 'key_hash', 'expires_at', 'deadline_at'])
		? (live
				.prepare('SELECT id, key_hash AS keyHash, user_id AS userId, expires_at AS expiresAt, deadline_at AS deadlineAt FROM api_keys ORDER BY id')
				.all() as KeyHere[])
		: [];
	if (!live.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(KEY_RECORD)) return { watermark: null, held: [], all };
	const watermark = watermarkOf(live);
	const held = live
		.prepare('SELECT id, key_hash AS keyHash FROM api_keys WHERE ? IS NULL OR id <= ? ORDER BY id')
		.all(watermark, watermark) as { id: number; keyHash: string }[];
	return { watermark, held: held.map((key) => [key.id, key.keyHash]), all };
}

/** Why a row of a backup's record was left out (card 2995, R6), counted by reason: never the row's own text. */
type RecordRowFault = 'an id that is not a whole number from 1 to 2^53 - 1' | "an id above the backup's own key counter" | 'a hash that is neither empty nor a SHA-256';

/**
 * Add the backup's record of ended API keys to this server's (card 2995, R6, as its code review's FP1 widened it),
 * inside the restore's transaction: each row read from the snapshot's table storage, kept only where `key_id` is a safe
 * integer of at least 1 and `key_hash` is '' or a SHA-256 in lower-case hex; a seed row ('') only where its id is at
 * most the backup's own `api_keys` counter or its largest key id, whichever is greater; a hashed row whatever its id,
 * since it names a key by hash alone and a server whose counter row was deleted can hold one above its counter;
 * `revoked_at` read as a moment, else the restore's; `revoked_because` one of this build's words, else `recorded in a
 * backup`. `INSERT OR IGNORE`: this server's rows are kept. The backup's watermark rows (R1) are added up to the larger
 * of that bound and every id its accepted rows name, so a seed row from it names a key by id here too; a later restore
 * of an older backup then leaves those keys out. Every row left out is counted in one `errors` line giving how many and
 * why, never quoting the backup. Then this server's key counter is raised over every id the record names
 * (`raiseKeyCounterOverRecord`). Not caught: a failure rolls the restore back. Returns how many rows it added.
 */
function carryKeyRevocations(live: Database.Database, backup: Database.Database, errors: string[], at: string): number {
	let added = 0;
	if (tableIn(backup, KEY_RECORD)) {
		const readable = hasColumns(backup, KEY_RECORD, ['key_id', 'key_hash']);
		const rows = readable ? (backup.prepare(fromTableStorage(backup, KEY_RECORD)).all() as Record<string, unknown>[]) : [];
		const unreadable = !readable;
		// The backup's own bound: its key counter, or its largest key id, whichever is greater (card 2996's code review, FP11).
		const bound = backupBound(backup, 'api_keys', 'api_keys');
		const faults = new Map<RecordRowFault, number>();
		const fault = (why: RecordRowFault) => faults.set(why, (faults.get(why) ?? 0) + 1);
		const put = live.prepare('INSERT OR IGNORE INTO api_key_revocations (key_id, key_hash, revoked_at, revoked_because) VALUES (?, ?, ?, ?)');
		const accepted: { id: number; hash: string; row: Record<string, unknown> }[] = [];
		const watermarks: { id: number; row: Record<string, unknown> }[] = [];
		// The largest id an accepted seed or hashed row names: a watermark up to it is the backup's own (FP1).
		let named = 0;
		for (const row of rows) {
			const id = row.key_id;
			const hash = row.key_hash;
			const watermark = hash === WATERMARK;
			if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < (watermark ? 0 : 1)) {
				fault('an id that is not a whole number from 1 to 2^53 - 1');
				continue;
			}
			if (watermark) {
				watermarks.push({ id, row });
				continue;
			}
			if (typeof hash !== 'string' || (hash !== '' && !/^[0-9a-f]{64}$/.test(hash))) {
				fault('a hash that is neither empty nor a SHA-256');
				continue;
			}
			// Only a seed row is held to the backup's own key counter (card 2995's code review, FP1): it names a key by id,
			// where a hashed row names one by hash alone, and its id was a key of that server's whatever its counter says
			// now (Vacuum and Reset deleted the counters before c6ed310).
			if (hash === '' && id > bound) {
				fault("an id above the backup's own key counter");
				continue;
			}
			named = Math.max(named, id);
			accepted.push({ id, hash, row });
		}
		// The watermark up to the larger of the backup's own bound and the ids its accepted rows name (FP1): W was at least
		// every id the record held when it was written.
		for (const { id, row } of watermarks) {
			if (id > Math.max(bound, named)) {
				fault("an id above the backup's own key counter");
				continue;
			}
			accepted.push({ id, hash: WATERMARK, row });
		}
		for (const { id, hash, row } of accepted) {
			const when = toStamp(row.revoked_at) ?? at;
			const because = typeof row.revoked_because === 'string' && REVOKED_BECAUSE_WORDS.includes(row.revoked_because) ? row.revoked_because : REVOKED_BECAUSE.inABackup;
			added += put.run(id, hash, when, because).changes;
		}
		const leftOut = [...faults.values()].reduce((sum, n) => sum + n, 0);
		if (leftOut > 0) {
			errors.push(
				`${leftOut} row(s) of the backup's record of ended API keys were left out, as they can name no key: ` +
					[...faults].map(([why, n]) => `${n} with ${why}`).join(', ') +
					'. The rest of the record was added to this server\'s.'
			);
		}
		if (unreadable) errors.push("The backup's record of ended API keys has not the columns this build reads, and was not added to this server's.");
	}
	raiseKeyCounterOverRecord(live);
	return added;
}

/** What `leaveOutRecordedKeys` left out (card 2995). */
type KeysLeftOut = {
	/** The restored keys the record names (R6), and those `carryDisabled` ended are added by the caller (R13): by id, sorted. */
	keyIds: number[];
	/** A working copy's other keys, left out as it is one (R4): counted only. */
	workingCopy: number;
	/** The keys of a backup whose seal did not verify that this server did not hold for the same account (card 3009): counted only. */
	unsealed: number;
	/** Every webhook a key left out may have been given the secret of, for the one `holdRevealedIn` (R3). */
	reveals: Reveal[];
};

/**
 * Leave out of the restored data every API key the record of ended keys names (card 2995), inside the restore's
 * transaction, after the secrets are filled and `carryRevealsHere` and the once-only seed have run (R3), and before
 * the ended-key sweep:
 *
 * 1. The hash belt (R2): every restored key a seed row names by its id (at most W), and every one whose id this server
 *    held with another hash just before the restore (`held`, R1), has its own hash recorded, `before record`, so it
 *    is caught under any id in any later backup. Both are then named by the one rule.
 * 2. What each key left out may have been given (R3): every row of `webhook_reveals` it has, seeded, carried or the
 *    backup's own, and every webhook with a secret, not held, that its account could set or read as an owner or an
 *    administrator, whatever its last use: the backup's last use predates the leak. Returned for the one hold.
 * 3. Its rows of `webhook_reveals` deleted, then one `DELETE FROM api_keys WHERE <keyRecordedWhere>` over every row
 *    (R6), the gate's own predicate, then `set_by_key` emptied on every webhook naming one (R8).
 *
 * A working copy (`every`, R4) then leaves out every other key the same way, counted only: no key of a backup works
 * on a copy of it.
 *
 * Otherwise, where the backup's seal did not verify (`unsealed`, card 3009, section 3.6), every other restored key is
 * left out the same way unless this server held that very key, the same id, hash and owner, for an account that is the
 * same account here (`unsealed.keep`), counted only, and never recorded in `api_key_revocations`: these keys never
 * existed here. A key planted on an account that is here is left out too. Each key kept then takes the earlier of this
 * server's expiry and deadline and the backup's (R5, `takeEarlierEnds`). Not caught: a failure rolls the restore back.
 */
function leaveOutRecordedKeys(
	live: Database.Database,
	options: { held: KeysHeldHere['held']; every: boolean; at: string; unsealed: { keep: readonly KeyHere[] } | null }
): KeysLeftOut {
	const hasReveals = !!live.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'webhook_reveals'").get();
	const belt =
		'INSERT OR IGNORE INTO api_key_revocations (key_id, key_hash, revoked_at, revoked_because) ' +
		`SELECT k.id, k.key_hash, @at, '${REVOKED_BECAUSE.beforeRecord}' FROM api_keys AS k WHERE k.key_hash NOT IN ('', '${WATERMARK}') AND (` +
		// The seed's half of the gate's own rule (`seedNames`, card 2995's code review, FP7).
		`EXISTS (${seedNames('k.id')}) ` +
		"OR EXISTS (SELECT 1 FROM json_each(@held) AS h WHERE json_extract(h.value, '$[0]') = k.id AND json_extract(h.value, '$[1]') IS NOT k.key_hash))";
	live.prepare(belt).run({ at: options.at, held: JSON.stringify(options.held) });

	const leaveOut = (where: string, params: Record<string, string> = {}): { keyIds: number[]; reveals: Reveal[] } => {
		// Bound parameters only where the condition names any (card 3009): better-sqlite3 refuses values a statement has no place for.
		const args: unknown[] = Object.keys(params).length === 0 ? [] : [params];
		const reveals: Reveal[] = [];
		if (hasReveals) {
			const given = live
				.prepare(
					'SELECT r.webhook_id AS webhookId, r.key_id AS keyId, k.user_id AS userId, r.revealed_at IS NULL AS before ' +
						`FROM webhook_reveals AS r JOIN api_keys AS k ON k.id = r.key_id WHERE ${where} ` +
						'UNION SELECT w.id AS webhookId, k.id AS keyId, k.user_id AS userId, 1 AS before FROM api_keys AS k JOIN users AS u ON u.id = k.user_id ' +
						"JOIN webhooks AS w ON w.secret <> '' AND (w.active = 1 OR w.held_because IS NULL) " +
						`AND (w.set_by = k.user_id OR ${readableBy('k.user_id', 'u.role', 'w.board_id')}) WHERE ${where} ` +
						'ORDER BY webhookId, keyId'
				)
				.all(...args) as (Omit<Reveal, 'before'> & { before: number })[];
			for (const row of given) reveals.push({ ...row, before: row.before === 1 });
			live.prepare(`DELETE FROM webhook_reveals WHERE key_id IN (SELECT k.id FROM api_keys AS k WHERE ${where})`).run(...args);
		}
		const keyIds = (live.prepare(`DELETE FROM api_keys AS k WHERE ${where} RETURNING id`).all(...args) as { id: number }[]).map((row) => row.id).sort((a, b) => a - b);
		forgetSetByKey(live, keyIds);
		return { keyIds, reveals };
	};
	const recorded = leaveOut(keyRecordedWhere('k.id', 'k.key_hash'));
	const rest = options.every ? leaveOut('1 = 1') : { keyIds: [], reveals: [] };
	// Card 3009: a working copy has left out every key already, and counts it `workingCopy`.
	const sealless = options.unsealed !== null && !options.every ? options.unsealed : null;
	const unsealed =
		sealless !== null
			? leaveOut(
					'NOT EXISTS (SELECT 1 FROM json_each(@keep) AS h ' +
						"WHERE json_extract(h.value, '$[0]') = k.id AND json_extract(h.value, '$[1]') = k.key_hash AND json_extract(h.value, '$[2]') = k.user_id)",
					{ keep: JSON.stringify(sealless.keep.map((key) => [key.id, key.keyHash, key.userId])) }
				)
			: { keyIds: [], reveals: [] };
	if (sealless !== null) takeEarlierEnds(live, sealless.keep);
	return {
		keyIds: recorded.keyIds,
		workingCopy: rest.keyIds.length,
		unsealed: unsealed.keyIds.length,
		reveals: [...recorded.reveals, ...rest.reveals, ...unsealed.reveals]
	};
}

/**
 * Of two moments a key ends at, as stored (card 3009, R5): the earlier; one that is set beats none; one that is set
 * and names no moment beats any, as `keyExpired` and `deadlinePassed` read it as passed (the safe side).
 */
function earlierEnd(here: string | null, backup: string | null): string | null {
	if (here === null) return backup;
	if (backup === null) return here;
	const mine = toStamp(here);
	const theirs = toStamp(backup);
	if (mine === null) return here;
	if (theirs === null) return backup;
	return theirs < mine ? backup : here;
}

/**
 * Every key a restore of a backup whose seal did not verify kept (card 3009, R5), given the earlier of this server's
 * expiry and the backup's, and likewise of the deadline (`earlierEnd`), inside the restore's transaction, so that a
 * key expired or past its deadline here never comes back working from a file that says it has none. Written only
 * where either changes. Not caught.
 */
function takeEarlierEnds(live: Database.Database, kept: readonly KeyHere[]): void {
	if (kept.length === 0) return;
	const restored = live.prepare('SELECT expires_at AS expiresAt, deadline_at AS deadlineAt FROM api_keys WHERE id = ?');
	const tighten = live.prepare('UPDATE api_keys SET expires_at = @expiresAt, deadline_at = @deadlineAt WHERE id = @id');
	for (const key of kept) {
		const row = restored.get(key.id) as { expiresAt: string | null; deadlineAt: string | null } | undefined;
		if (row === undefined) continue;
		const expiresAt = earlierEnd(key.expiresAt, row.expiresAt);
		const deadlineAt = earlierEnd(key.deadlineAt, row.deadlineAt);
		if (expiresAt !== row.expiresAt || deadlineAt !== row.deadlineAt) tighten.run({ expiresAt, deadlineAt, id: key.id });
	}
}

/** A row of this server's `webhook_reveals`, read before a restore clears it, with what its carry is matched on (card 2947). */
type RevealHere = { webhookId: number; boardId: number; keyId: number; keyHash: string; userId: number; revealedAt: string | null };

/** This server's record of which key was given which webhook's secret, read before the clear (card 2947, R1); none where it has no table. */
function revealsHere(live: Database.Database): RevealHere[] {
	if (!live.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'webhook_reveals'").get()) return [];
	return live
		.prepare(
			'SELECT r.webhook_id AS webhookId, w.board_id AS boardId, r.key_id AS keyId, k.key_hash AS keyHash, k.user_id AS userId, r.revealed_at AS revealedAt ' +
				'FROM webhook_reveals AS r JOIN api_keys AS k ON k.id = r.key_id JOIN webhooks AS w ON w.id = r.webhook_id ORDER BY r.webhook_id, r.key_id'
		)
		.all() as RevealHere[];
}

/**
 * Carry this server's record of which key was given which secret onto the restored data (card 2947, R1), inside the
 * restore's transaction, after the secrets are filled: for every restored webhook on the same id and board as one
 * here that has a secret now, whether filled from here (`fillSecretGaps`) or brought in with the backup's own (its
 * code review, FP6: a backup that still carries secrets, as a whole database copy does), since that secret may be the
 * one the record speaks of; holding one whose secret differs only over-holds, the accepted direction. A row is put back
 * (`INSERT OR IGNORE`, the backup's own kept) where the restore brought back a key with the same id and hash; every
 * other row of such a webhook names a key the restore did not bring back, which may have been given the secret the
 * webhook still has, and is returned for the restore to hold (never failing open). Rows of a webhook with no secret now
 * are dropped: it has none until one is entered, which forgets every row anyway.
 */
function carryRevealsHere(live: Database.Database, here: readonly RevealHere[]): Reveal[] {
	if (here.length === 0 || !live.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'webhook_reveals'").get()) return [];
	const sameKey = live.prepare('SELECT 1 FROM api_keys WHERE id = ? AND key_hash = ?');
	const sameHook = live.prepare("SELECT 1 FROM webhooks WHERE id = ? AND board_id = ? AND secret IS NOT NULL AND secret <> ''");
	const put = live.prepare('INSERT OR IGNORE INTO webhook_reveals (webhook_id, key_id, revealed_at) VALUES (?, ?, ?)');
	const lost: Reveal[] = [];
	for (const row of here) {
		if (!sameHook.get(row.webhookId, row.boardId)) continue;
		if (sameKey.get(row.keyId, row.keyHash)) put.run(row.webhookId, row.keyId, row.revealedAt);
		else lost.push({ webhookId: row.webhookId, keyId: row.keyId, userId: row.userId, before: row.revealedAt === null });
	}
	return lost;
}

/** What the owners' mail says caused a restore's switch-offs (card 2947's code review, FP5): the log names who restored, the mail nobody. */
const SWEPT_IN_MAIL = 'found after a restore';

/** This server's 0071 setting as stored, read before a restore clears `settings`; null where it has none. */
function webhookKeysRecordedHere(live: Database.Database): string | null {
	if (!columnNamesOf(live, 'settings').includes('value')) return null;
	const row = live.prepare('SELECT value FROM settings WHERE key = ?').get(WEBHOOK_KEYS_RECORDED_SETTING) as { value: unknown } | undefined;
	return typeof row?.value === 'string' ? row.value : null;
}

/** 0069's setting, kept where a backup made before it held none (card 2772). */
const KEEP_API_KEY_DEADLINE_SETTING =
	`INSERT INTO settings (key, value) VALUES ('${API_KEY_DEADLINE_SETTING}', @deadline) ON CONFLICT (key) DO NOTHING`;

/**
 * This server's API key deadline (migration 0069), in the stored form, read
 * before a restore clears `settings`; null where it has none, or one that
 * names no moment.
 */
function apiKeyDeadlineHere(live: Database.Database): string | null {
	if (!columnNamesOf(live, 'settings').includes('value')) return null;
	const row = live.prepare('SELECT value FROM settings WHERE key = ?').get(API_KEY_DEADLINE_SETTING) as { value: unknown } | undefined;
	return row ? toStamp(row.value) : null;
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The first few of a list, and how many more there are. */
function some(items: readonly string[], limit = 10, separator = '; '): string {
	const more = items.length > limit ? `${separator}and ${items.length - limit} more` : '';
	return items.slice(0, limit).join(separator) + more;
}

/**
 * What a row of the backup that could not be copied is called in `errors`: its
 * primary key, as `id 4` or `card_id 1, label_id 2`, or its place in the
 * backup's table where it has no key to go by.
 */
function nameOf(row: Record<string, unknown>, keyColumns: readonly string[], index: number): string {
	if (keyColumns.length === 0) return `number ${index + 1} of the table in the backup`;
	const shown = (value: unknown) =>
		value === null || value === undefined
			? 'NULL'
			: typeof value === 'string'
				? `'${value}'`
				: Buffer.isBuffer(value)
					? 'a blob'
					: String(value);
	return keyColumns.map((column) => `${column} ${shown(row[column])}`).join(', ');
}

/** Rows of one table that refer to rows of another which are not there. */
type Stranded = { table: string; parent: string; rows: (number | null)[] };

/** The columns of `table` in `database`: none when there is no such table. */
const columnNamesOf = (database: Database.Database, table: string): string[] =>
	(database.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((column) => column.name);

/** Whether `table` in `database` has every one of `columns`: false when there is no such table (card 3020's code review, FP10). */
function hasColumns(database: Database.Database, table: string, columns: readonly string[]): boolean {
	const present = columnNamesOf(database, table);
	return columns.every((column) => present.includes(column));
}

/**
 * Every row in `live` that refers, through a foreign key, to a row that is not
 * there (`PRAGMA foreign_key_check`), sorted by whose doing that is.
 *
 * And one reference with no foreign key, asked as if it had one (card 2293):
 * a board filed under a dashboard grouping that is not there
 * (`boards.category_id`). The pragma cannot see it, and the backfill after the
 * commit clears it, so a grouping this restore could not copy would otherwise
 * have its boards unfiled without a word. It is sorted board by board, by the
 * grouping each names, which the pragma cannot do: fatal when that grouping is
 * one the backup holds and this restore did not copy (`groupingsLeftOut`), and
 * as it was otherwise, however many other groupings were left out (the review
 * of card 2293).
 *
 * `fatal`: the row it wants is in a table that this restore left something out
 * of. Committing would make an orphan of it.
 *
 * `asItWas`: every row of the table it refers to was copied, so no row of that
 * table is missing because of this restore.
 */
function strandedBy(
	live: Database.Database,
	leftOut: ReadonlyMap<string, string[]>,
	groupingsLeftOut: ReadonlySet<number>
): { fatal: Stranded[]; asItWas: Stranded[] } {
	const groups = new Map<string, Stranded>();
	for (const violation of live.pragma('foreign_key_check') as {
		table: string;
		rowid: number | null;
		parent: string;
	}[]) {
		const key = `${violation.table}\n${violation.parent.toLowerCase()}`;
		const group = groups.get(key) ?? { table: violation.table, parent: violation.parent, rows: [] };
		group.rows.push(violation.rowid);
		groups.set(key, group);
	}

	const fatal: Stranded[] = [];
	const asItWas: Stranded[] = [];
	for (const group of groups.values()) {
		(leftOut.has(group.parent.toLowerCase()) ? fatal : asItWas).push(group);
	}
	if (columnNamesOf(live, 'boards').includes('category_id') && columnNamesOf(live, 'board_categories').includes('id')) {
		const unfiled = live.prepare(BOARDS_UNDER_DELETED_GROUPINGS).all() as { id: number; groupingId: number }[];
		const lost = unfiled.filter((board) => groupingsLeftOut.has(Number(board.groupingId)));
		const own = unfiled.filter((board) => !groupingsLeftOut.has(Number(board.groupingId)));
		const of = (boards: typeof unfiled): Stranded => ({ table: 'boards', parent: 'board_categories', rows: boards.map((b) => b.id) });
		if (lost.length > 0) fatal.push(of(lost));
		if (own.length > 0) asItWas.push(of(own));
	}

	// By name, so that what is said about them does not depend on the order
	// SQLite happened to check the tables in.
	const byName = (a: Stranded, b: Stranded) => a.table.localeCompare(b.table) || a.parent.localeCompare(b.parent);
	return { fatal: fatal.sort(byName), asItWas: asItWas.sort(byName) };
}

/**
 * The ids of the backup's dashboard groupings that are not in `live` after the
 * copy: the rows of `board_categories` this restore could not copy. Empty when
 * either database has no such table. Read from the table's storage, as every
 * other read of the backup is.
 */
function groupingsNotCopied(live: Database.Database, backup: Database.Database): Set<number> {
	if (!columnNamesOf(backup, 'board_categories').includes('id') || !columnNamesOf(live, 'board_categories').includes('id')) {
		return new Set();
	}
	const copied = new Set(
		(live.prepare('SELECT id FROM board_categories').all() as { id: number }[]).map((row) => Number(row.id))
	);
	const held = (backup.prepare(fromTableStorage(backup, 'board_categories')).all() as { id: unknown }[])
		.map((row) => Number(row.id))
		.filter((id) => Number.isInteger(id));
	return new Set(held.filter((id) => !copied.has(id)));
}

/**
 * The tables a restore clears and refills: every table in the running database
 * except SQLite's own, tables drizzle-kit left behind mid-rebuild (`__new_*`),
 * the migration record, the system log, the record of API keys ended here and
 * the record of accounts ended here.
 *
 * The record of ended keys (card 2995) is this server's, as the system log is:
 * cleared and refilled from a backup made before an ending, it would forget the
 * ending and bring the key back. The restore adds the backup's rows to it
 * instead, and Reset Everything, which reads this list, keeps it. The record of
 * account endings (card 2996) is kept for the same reason.
 *
 * The system log is this server's record of what was done to it, and by whom
 * (card 2899). A restore cleared it and copied the backup's in its place, so
 * every import, of a backup nobody had changed too, deleted every line written
 * since that backup was made, and an edited backup put its own words there. It
 * is kept as Reset Everything keeps it, and none of the backup's lines is
 * brought in: they stay in the backup file, which the import's line names by
 * its SHA-256. The import's safety copy and Reset read this list too.
 *
 * The migration record is excluded by its exact name, and that matters. It
 * describes the structure of *this* database, which a restore does not change.
 * Replacing it with an older backup's shorter list tells the runner, at the
 * next start, that migrations already applied here have not been — and it runs
 * them again, against columns that already exist, and halts. The filter used to
 * be `NOT LIKE '_drizzle%'`, which does not match `__drizzle_migrations` at all:
 * in LIKE an underscore is a wildcard for exactly one character. The names are
 * compared in code here so that no wildcard is involved.
 */
export function restorableTables(live: Database.Database): string[] {
	return (live.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
		.map((row) => row.name)
		.filter(
			(name) =>
				!name.startsWith('sqlite_') &&
				!name.startsWith('__new_') &&
				name !== MIGRATION_RECORD &&
				name !== SYSTEM_LOG &&
				name !== KEY_RECORD &&
				name !== ACCOUNT_RECORD
		);
}

/**
 * What `backup`'s system log holds, which a restore leaves where it is (card
 * 2899): its lines counted and their first and last times, read from the
 * table's own storage, as every read of a backup is. Null where it has no
 * `system_logs` at all.
 *
 * Counted whenever it is there, whatever its shape (the code review's F5): a
 * table with no `timestamp` column is counted with no times. The times are
 * given only when both are a real moment in the stored form (`isStamp`; F2):
 * they are the backup's text, and an edited backup could make them anything,
 * so anything else is given as no time at all and never quoted. Throws on a
 * log that cannot be read, a view over nothing among them; the restore says
 * so and goes on.
 */
function systemLogOf(backup: Database.Database): SystemLogLeftOut | null {
	const there = backup.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')").get(SYSTEM_LOG);
	if (!there) return null;
	const from = fromTableStorage(backup, SYSTEM_LOG);
	const timed = columnNamesOf(backup, SYSTEM_LOG).includes('timestamp');
	const row = backup
		.prepare(
			timed
				? `SELECT COUNT(*) AS lines, MIN("timestamp") AS first, MAX("timestamp") AS last FROM (${from})`
				: `SELECT COUNT(*) AS lines, NULL AS first, NULL AS last FROM (${from})`
		)
		.get() as { lines: number; first: unknown; last: unknown };
	const readable = isStamp(row.first) && isStamp(row.last);
	return { lines: Number(row.lines), first: readable ? (row.first as string) : null, last: readable ? (row.last as string) : null };
}

/**
 * Whether `backup` has user accounts and none of them is the superadmin.
 *
 * Restoring such a backup would leave an installation that nobody could
 * export, import into or reset: those are the superadmin's alone (the backup
 * and mail settings are every administrator's since card 2395), `superadmin`
 * is written by set-up and by nothing else,
 * and set-up is closed while there is any user. So the import asks here
 * first, and refuses before anything is written.
 *
 * A backup with no users at all is another matter, and is not refused: with
 * nobody in it, set-up is open again and whoever completes it is the
 * superadmin. Its `users` table having no `role` column counts as nobody
 * being one.
 */
export function backupLacksSuperadmin(backup: Database.Database): boolean {
	return lacksSuperadmin(backup);
}

/**
 * Whether `database` has user accounts and none of them is the superadmin, a
 * disabled superadmin counting as none (card 2671, D4):
 * `backupLacksSuperadmin`, asked of any database. `restoreFromBackup` asks it
 * of the restored rows before it commits. Both counts read the table's own
 * rows, never an index (`NOT INDEXED`), as the restore copies them: in a
 * backup an index can hold rows its table does not (the second review's B1).
 */
export function lacksSuperadmin(database: Database.Database): boolean {
	const hasUsers = !!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
	if (!hasUsers) return false;
	const users = (database.prepare('SELECT COUNT(*) AS n FROM users NOT INDEXED').get() as { n: number }).n;
	if (users === 0) return false;

	const columns = (database.prepare('PRAGMA table_info("users")').all() as { name: string }[]).map((column) => column.name);
	if (!columns.includes('role')) return true;
	// A disabled superadmin (a host edit, a crafted backup) is none (card 2671,
	// D4): nobody could sign in as them. A database from before 0072 has no
	// disabled one.
	const enabled = columns.includes('disabled_at') ? ' AND disabled_at IS NULL' : '';
	const superadmins = (database.prepare(`SELECT COUNT(*) AS n FROM users NOT INDEXED WHERE role = 'superadmin'${enabled}`).get() as { n: number }).n;
	return superadmins === 0;
}

/**
 * The usernames of the superadmins `database` has, in the order they were
 * made: what an import's answer names, so that whoever restored it knows who
 * can sign in to undo it. Empty where there are no users, or no `role`.
 */
export function superadminsOf(database: Database.Database): string[] {
	// A disabled superadmin cannot sign in to undo it, so is not named (card
	// 2671, E15); a database from before 0072 has the column not at all.
	for (const sql of [
		"SELECT username FROM users WHERE role = 'superadmin' AND disabled_at IS NULL ORDER BY id",
		"SELECT username FROM users WHERE role = 'superadmin' ORDER BY id"
	]) {
		try {
			return database.prepare(sql).pluck().all() as string[];
		} catch {
			// No such column, or no such table: the next, then none.
		}
	}
	return [];
}

/** What the import answers for a backup that `backupLacksSuperadmin`. */
export const NO_SUPERADMIN_IN_BACKUP =
	'This backup has user accounts and none of them is the superadmin. Restoring it would leave nobody able to ' +
	'export, import or reset the database, so it is refused. ' +
	'Nothing was changed.';

/**
 * What a restore says of the sessions, in its answer: whoever restores is
 * signed out with everybody else.
 */
export const SIGNED_OUT = 'Everybody has been signed out, you included: sign in again.';

/**
 * The backup's rows of `table` that a restore brings in: all of them, for
 * every table but those below.
 *
 * No session is brought in, and no invite that has not been used. A backup
 * made by this version holds neither (`withoutSecrets`, in `backup.ts`). One
 * made before it holds the session of everybody who was signed in when it was
 * made, and a session's expiry moves on every time it is used, so those are as
 * good today as they were then: restored, each would sign in whoever has read
 * that file. So they are left out whatever the backup's age, and a restore
 * signs everybody out.
 *
 * An invite with no `used` column to say otherwise is taken to be unused.
 *
 * Nor is the key remembered browsers are signed with (card 2194), which a
 * backup made by this version does not hold either: the restored server makes
 * a new one, and every browser is forgotten, as every session is. Nor the key
 * the public request form signs its tokens with (card 2158), which a backup
 * made since does not hold: the restored server makes a new one at first use,
 * and a form open during the restore fails once and is reloaded. Nor the list
 * of webhooks a backup left without their secrets (card 2169): the restore
 * reads it from the backup (`readListed`), and writes it again itself only
 * for the webhooks it could not fill (`fillSecretGaps`). Nor the backup's
 * seal, which is about the file and not the data, nor any key to seal with
 * that a backup holds (the review's S1): this server keeps its own, and
 * puts it back itself (`keepSealKey`), with its record, `backup_seal_key_made_at`
 * (card 2943, R3).
 *
 * Nor any row of two-step sign-in's four tables, nor the backup's
 * `mfa_key_check` (card 2768): a pending sign-in and an enrolment link are
 * never brought in, and the second factors and recovery codes are put back
 * by their own rules once the copy is done (`restoreMfaRows`, in
 * mfa-backup.ts), as is the key check.
 *
 * Every table is read from its own storage, never through an index, in rowid
 * order (`fromTableStorage`), as the seal is made: an index in a backup can
 * hold rows its table does not, and a bare `SELECT *` that a `sqlite_stat1`
 * row steers to it would copy rows the seal never saw (the second review's B1).
 *
 * And every secret a backup holds in plain (one made before card 2169, or a
 * file copied by hand) is sealed as it is read (card 2898, S7:
 * `sealedForRestore`), so that none reaches the live file, not even to be
 * written over: the mail password, each destination's secret fields and each
 * webhook's secret. `sealed` counts them, for the restore's checkpoint after
 * its commit. With no MFA key loaded that is a `NoKeyToSeal`, which the
 * restore does not catch: it rolls back (E9).
 */
export function rowsToRestore(
	backup: Database.Database,
	table: string,
	sealed: { count: number; secretsLeftOut?: ListedWebhook[] } = { count: 0 },
	/** Whether the backup's seal verified (card 3009's code review, FP1): none of an unsealed backup's invites is read. Failing closed. */
	trust: { sealVerified: boolean } = { sealVerified: false }
): Record<string, unknown>[] {
	const sealing = (rows: Record<string, unknown>[]) => {
		const result = sealedForRestore(table, rows);
		sealed.count += result.sealed;
		// A secret beside an address that does not open here, left out (card 2928, R6): listed with the backup's.
		if (result.secretsLeftOut !== undefined && result.secretsLeftOut.length > 0) sealed.secretsLeftOut = [...(sealed.secretsLeftOut ?? []), ...result.secretsLeftOut];
		return result.rows;
	};
	const name = table.toLowerCase();
	if (name === 'sessions') return [];
	if ((MFA_ROWS_NOT_RESTORED as readonly string[]).includes(name)) return [];
	if (name === 'settings') {
		const hasKey = (backup.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).some(
			(column) => column.name === 'key'
		);
		if (hasKey) {
			const leftOut = [
				KNOWN_BROWSER_SECRET_KEY,
				REQUEST_FORM_SECRET_KEY,
				WEBHOOK_SECRETS_LEFT_OUT_KEY,
				// Card 2928: the marker of addresses left out, read by the restore itself, and this server's own key.
				WEBHOOK_ADDRESSES_LEFT_OUT_KEY,
				WEBHOOK_ADDRESS_MAC_KEY,
				BACKUP_SEAL,
				BACKUP_SEAL_KEY,
				// The seal key's record, this server's own (card 2943, R3).
				BACKUP_SEAL_KEY_MADE_AT,
				MFA_KEY_CHECK_SETTING,
				// This server's own: set by the restore itself (card 2898's code review, S1).
				SECRETS_SCRUB_PENDING,
				// This server's installation id, put back as it was, or none where it had none (card 3009, R6).
				INSTALLATION_ID
			];
			return sealing(
				backup.prepare(fromTableStorage(backup, table, leftOut.map(() => 'key IS NOT ?').join(' AND '))).all(...leftOut) as Record<string, unknown>[]
			);
		}
	}
	if (name === 'invite_tokens') {
		const hasUsed = (backup.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).some(
			(column) => column.name === 'used'
		);
		// Card 3009's code review, FP1: an invite is restored as history alone, and only from a backup whose seal verified.
		// None of an unsealed backup's, whatever it says, as its rows are only the uploader's word.
		if (!hasUsed || !trust.sealVerified) return [];
		// A used one only, by the stored type as well as the value: a column the backup declares with no type can hold the
		// text '0', which is not 0 here and would land as 0 in this server's integer column, an unused invite. And each
		// is written used, whatever the backup holds.
		// A backup made before card 2849 holds each used invite's token as it
		// was mailed. It is given 0068's 32 random bytes here, as it is read, so
		// that no plain token reaches the live file, not even to be written over
		// (the code review, CR3). A token in hash form is kept.
		return (backup.prepare(fromTableStorage(backup, table, "typeof(used) = 'integer' AND used <> 0")).all() as Record<string, unknown>[]).map((row) => ({
			...row,
			used: 1,
			...('token' in row && !inHashForm(row.token) ? { token: randomBytes(32) } : {})
		}));
	}
	// A requester's links are never brought in (card 2870, decision 10): a
	// backup of another installation would bring hashes whose tokens that
	// installation's requesters hold, for request ids that are somebody
	// else's here. And the retired `access_token` is read as NULL, so that a
	// backup made before card 2158, which holds each token as it was mailed,
	// puts none in the live file, not even to be written over.
	if (name === 'request_links') return [];
	const rows = backup.prepare(fromTableStorage(backup, table)).all() as Record<string, unknown>[];
	if (name === 'task_requests') return rows.map((row) => ('access_token' in row ? { ...row, access_token: null } : row));
	if (name === 'webhooks') return sealing(rows);
	return rows;
}

/**
 * The settings that make up the mail configuration. No mail is sent without
 * `smtp_host`; the others go with it because one of them is a password.
 * `smtp_secure` is no longer read (card 2189) but goes with the rest;
 * `smtp_allow_insecure` is the way out that took its place.
 */
const MAIL_SETTINGS = [
	'smtp_host',
	'smtp_port',
	'smtp_user',
	'smtp_pass',
	'smtp_secure',
	'smtp_allow_insecure',
	'smtp_from_address',
	'smtp_from_name'
] as const;

/**
 * Switch off or remove everything in `database` that reaches outside the
 * instance, and say what was done.
 *
 * Not running the schedulers does not do this. An instance that holds
 * production's rows still mails real people and calls real webhook addresses
 * when a card is assigned or moved, and a backup run by hand still uploads to
 * production's destination and prunes the backups there.
 *
 * Where there is a flag it is cleared, so that it can be set again:
 * `report_schedules.enabled`, by the schedule's owner on the Reports page,
 * and `webhooks.active`, by the board's owner or an administrator through the
 * API (`PUT /api/v1/webhooks/{id}`), since no screen shows webhooks. Where there
 * is none the setting is removed: the backup destinations, and the mail
 * settings. The backup schedule is set to disabled. `app_url` and every other
 * setting are left alone, and so is every other table but `setting_setters`,
 * whose rows for the mail and the destinations go with them (card 2406), and
 * `users.mfa_password_enrol`, set to 0 for every account (card 2769, CS5).
 * With `appUrl` (a backup whose seal did not verify: card 3009's code review,
 * FP3) the App URL is removed as the mail settings are, its setter rows and
 * holds with it, and counted.
 *
 * A `backup_config` that is not a JSON object is removed rather than
 * rewritten. A missing one is read as no destinations and no schedule, which
 * is what is wanted of it.
 *
 * A table or a setting that is not there is skipped. No transaction is opened
 * here. The caller has one open, and this is undone with the rest of it if it
 * rolls back.
 */
export function switchOffOutside(database: Database.Database, options: { appUrl?: boolean } = {}): OutsideSwitchedOff {
	const has = (table: string, ...columns: string[]) => hasColumns(database, table, columns);

	const done: OutsideSwitchedOff = {
		reportSchedules: 0,
		webhooks: 0,
		backupScheduleWasOn: false,
		backupDestinations: 0,
		mailSettings: 0
	};

	if (has('report_schedules', 'enabled')) {
		done.reportSchedules = database
			.prepare('UPDATE report_schedules SET enabled = 0 WHERE enabled != 0')
			.run().changes;
	}
	if (has('webhooks', 'active')) {
		done.webhooks = database.prepare('UPDATE webhooks SET active = 0 WHERE active != 0').run().changes;
	}
	// A working copy has no mail host, which would let every account marked
	// for it set up two-step sign-in on its password alone (card 2769, R1):
	// that leave is taken from every account instead (CS5). Its owners are
	// given set-up links by an administrator.
	if (has('users', 'mfa_password_enrol')) {
		database.prepare('UPDATE users SET mfa_password_enrol = 0 WHERE mfa_password_enrol != 0').run();
	}
	if (!has('settings', 'key', 'value')) return done;

	const stored = database.prepare("SELECT value FROM settings WHERE key = 'backup_config'").get() as
		| { value: string }
		| undefined;
	if (stored) {
		let config: unknown = null;
		try {
			config = JSON.parse(stored.value);
		} catch {
			// Not JSON. Removed below, with whatever else is not an object.
		}
		if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
			const was = config as Record<string, unknown>;
			// A configuration with no schedule in it is one that was never on.
			done.backupScheduleWasOn = typeof was.schedule === 'string' && was.schedule !== 'disabled';
			done.backupDestinations = Array.isArray(was.destinations) ? was.destinations.length : 0;
			database
				.prepare("UPDATE settings SET value = ? WHERE key = 'backup_config'")
				.run(JSON.stringify({ ...was, schedule: 'disabled', destinations: [] }));
		} else {
			database.prepare("DELETE FROM settings WHERE key = 'backup_config'").run();
		}
	}

	done.mailSettings = database
		.prepare(`DELETE FROM settings WHERE key IN (${MAIL_SETTINGS.map(() => '?').join(', ')})`)
		.run(...MAIL_SETTINGS).changes;

	// Who set the mail and each destination goes with them (card 2406): left,
	// a row would make the mail or a destination set up again at the same
	// place its account's again (setting-setters.ts), and that account's
	// demotion would take it away. The App URL's rows stay, as the App URL
	// does. Not counted: nothing reaches outside through them.
	if (has('setting_setters', 'setting')) {
		database.prepare("DELETE FROM setting_setters WHERE setting = 'mail' OR substr(setting, 1, 19) = 'backup_destination:'").run();
	}
	// And their holds for review, carried just before (card 2922, its plan's R17): a working copy has no mail
	// settings or destinations to hold, and none of this server's is to be held there. The App URL's stay, as it does.
	if (has('setting_holds', 'setting')) {
		database.prepare("DELETE FROM setting_holds WHERE setting = 'mail' OR substr(setting, 1, 19) = 'backup_destination:'").run();
	}
	// A working copy of a backup whose seal did not verify (FP3): its App URL is only the file's word, so it goes as the
	// mail settings do, with its setter rows and holds, and is counted. Links then begin with the environment's.
	if (options.appUrl === true) {
		const removed = database.prepare("DELETE FROM settings WHERE key = 'app_url'").run().changes;
		if (removed > 0) done.appUrl = removed;
		if (has('setting_setters', 'setting')) database.prepare("DELETE FROM setting_setters WHERE setting = 'app_url'").run();
		if (has('setting_holds', 'setting')) database.prepare("DELETE FROM setting_holds WHERE setting = 'app_url'").run();
	}

	return done;
}

/**
 * Put back, from the uploads trash, the file of every attachment row in
 * `database` whose file is missing from its card's folder and is in the
 * trash, and say how many were.
 *
 * A backup holds the database and not the files. When a card is deleted its
 * files are moved to the trash and kept there for 30 days (`uploads.ts`), so
 * an import of a backup taken before the delete brings back rows whose files
 * are there to be had.
 *
 * Call it once the import is committed, with no transaction open: it moves
 * files, which no rollback undoes. It never throws. A file that could not be
 * put back, or an uploads folder that could not be used, is in `errors`, and
 * is something to report about an import that succeeded.
 */
export function putBackTrashedFiles(database: Database.Database): { putBack: number; errors: string[] } {
	try {
		const files = database
			.prepare('SELECT card_id AS cardId, filename FROM card_attachments ORDER BY id')
			.all() as UploadFile[];
		const { putBack, failed } = putBackFromTrash(files);
		return {
			putBack,
			errors: failed.map((entry) => `Attachment file not put back from the trash (${entry})`)
		};
	} catch (e) {
		return { putBack: 0, errors: [`Attachment files were not put back from the trash: ${messageOf(e)}`] };
	}
}

/**
 * What an import does about the outside when it is not told: `off` on an
 * instance whose schedulers are off, and `keep` on one that runs them.
 *
 * An instance that does not run its schedulers is a dev server or a
 * rehearsal, and what is restored into it is a copy. One that runs them is
 * the installation, being put back. The import route and the admin page's
 * load both ask here, so the choice the dialog shows as selected is the one
 * the route makes when it is given none.
 */
export function defaultOutside(
	value: string | undefined = process.env.SCHEDULERS,
	isDev: boolean = dev
): Outside {
	return schedulerSetting(value, isDev).run ? 'keep' : 'off';
}

/**
 * Replace the rows of `live` with the rows of `backup`.
 *
 * Foreign keys are off for the copy, because tables are cleared and refilled
 * in no particular order, and are switched back on whether it succeeds or
 * throws: `live` is the application's only connection, and leaving it with
 * foreign keys off would silently stop every cascade in the application.
 *
 * A backup can be older than the migrations this database has applied, and
 * those migrations are recorded here and will not run again. What they did to
 * the rows is therefore repeated:
 *
 * - A backup taken before migration 0043 has no `work_dependencies` table, so
 *   the table here is cleared and nothing refills it. 0043's copy from
 *   `card_dependencies` is run again, inside the restore's transaction. This
 *   happens here and nowhere else. `card_dependencies` is kept after 0043 and
 *   nothing removes a row from it when a dependency is deleted, so the same
 *   copy at every start would bring deleted dependencies back.
 * - A backup taken before `cards.first_completed_at` existed has no values
 *   for it. The runner's backfills are repeated once the restore has
 *   committed. If they fail, the restore has still succeeded: the failure is
 *   reported in `errors`, and the backfills run again at the next start. One
 *   taken before cards 2155 and 2179 can hold a card in a milestone of
 *   another board: the backfills take it out, as 0057 did once (card 2179).
 *   One taken before 0060 has no commitment on any card: the backfills
 *   commit every card that is not upstream, as 0060 did once (milestone 22).
 * - A backup taken before card 2095 holds timestamps in two forms. They are
 *   brought to the stored one after the backfills, as at every start
 *   (`normaliseTimestamps`), and the count is in `timestamps`. A failure, or a
 *   value in no form that can be read, is reported in `errors`.
 * - A backup taken while a column was nullable can hold a NULL where the
 *   column is NOT NULL here: `columns.wip_limit`, in every backup of
 *   production taken before card 2006. Where the column has a default, the
 *   NULL is given it, which is the rule the rebuild of that table follows
 *   (`defaultsForNull`, in `migrate.ts`). Without it the row would be refused,
 *   and for `columns` that is a column of a board gone and every card on it
 *   left pointing at nothing. A decision's tables are given no default: the
 *   row is left out, and the restore refused, as below (card 2675's F8).
 * - A backup taken before card 2849 holds each used invite's token as it was
 *   mailed. Each is given 32 random bytes as the rows are read
 *   (`rowsToRestore`), so that none reaches the live file, and 0068's
 *   `UPDATE` is repeated after the copy inside the transaction as a backstop
 *   (`REPLACE_PLAIN_USED_INVITES`, in invites.ts). Rows already in hash form
 *   are left.
 * - A backup taken before migration 0069 (card 2772) has no
 *   `api_keys.deadline_at`. This server's `api_key_deadline` is read before
 *   the clear, and after the copy, inside the transaction, 0069's `UPDATE` is
 *   repeated with it: every key with no expiry, or one later than it (read as
 *   the moment it names, `stamp_of`), is given it, and the setting is written
 *   back where the backup held none. Where this server has no deadline that
 *   can be read, the restore's own moment is used, so such keys end at once.
 *   The count is `apiKeyDeadlines`. A backup taken since is restored as it
 *   is, so a key kept there stays kept.
 *
 * A row that still cannot be copied is left out and reported in `errors`, and
 * the restore goes on, on one condition: nothing depends on that row. Before
 * the commit the whole database is checked for rows that point at a row which
 * is not there. If any of them points into a table from which this restore
 * left something out, the restore is rolled back and throws: a restore must
 * not report success over a board whose columns have gone. Rows that point at
 * nothing in a table this restore copied in full were that way in the backup;
 * they are reported in `errors` and do not stop it.
 *
 * Two kinds of row are never copied, though the backup has them: a session,
 * and an invite that has not been used (`rowsToRestore`). Both tables are
 * cleared like any other, so a restore signs everybody out, whoever started
 * it included, and ends every invite that was waiting here. A used invite is
 * copied, and one a backup held in plain is given 0068's token (above).
 *
 * Every task request's links are ended (cards 2158 and 2870). The clear
 * empties `request_links`, and no backup refills it (`rowsToRestore` brings
 * in none, whatever the backup's age); it is emptied again after the copy, not
 * caught, so a restore that cannot empty it is rolled back rather than
 * committed with the old links live (the code review's CS2); every `task_requests.access_token`,
 * retired and always NULL, is read as NULL, so a backup made before card 2158,
 * which holds every request's token as it was mailed, puts none in the live
 * file. A link mailed before the restore stops working, and its requester
 * asks for a new one from the page it opens (`POST /api/requests/[id]/link`),
 * or gets one in the next mail the team's reply or a progress update sends.
 * The count is `requestLinksReplaced`, the requests restored. This is the
 * restore's own rule, made at every restore. A request's links are not kept
 * even where the same id is in the database being replaced: a backup of
 * another installation, whose request 5 is somebody else's, would give one
 * requester's link to another person's thread.
 *
 * Every personal decision link is ended too (card 2675, decision 13). Inside
 * the transaction, `link_revoked { reason: 'restore' }` is recorded by
 * DumpFire for each participant holding a link on a decision that is not a
 * draft, and then every `link_token_hash` and `link_issued_at` is emptied,
 * drafts' included. The count is `decisionLinksCleared`. The backup itself is
 * not changed: a hash is not a credential, and keeping it is what lets the
 * restore record which links it ended. And a decision's record is never
 * restored in part: a row of `decisions` or of any `decision_` table that
 * cannot be copied rolls the restore back and throws, naming the tables,
 * because a lost event strands no row and the check below would not see it.
 *
 * A backup made since card 2169 holds no mail password, destination
 * credential or webhook secret, and a webhook that had a secret is off in it
 * and listed in its `webhook_secrets_left_out`. A restore clears `settings`
 * and `webhooks` with the rest, so on its own it would leave this server with
 * no mail, no backups and its signed webhooks off, a restore of its own backup
 * included. So this server's secrets are read before anything is cleared
 * (`readSecretsHere`), and once the rows are copied each gap is filled from
 * them where it is for the same account, inside the transaction
 * (`fillSecretGaps`): only from an entry that is the same in every field that
 * is not secret, and only when exactly one is. A value the backup has is never
 * replaced, so a backup made before card 2169 restores as it did. What was
 * kept and what is to enter again is `secrets`. A restore that rolls back
 * leaves this server's secrets as they were.
 *
 * And only into a backup whose seal verifies (the review's S1): every backup
 * this server makes carries an HMAC of its rows made with a key this server
 * keeps and no backup holds, and it is made again here, from the backup, with
 * this server's key, before anything is written (`sealVerifies`). A backup
 * made by another server, or changed since, by one added superadmin or one
 * changed card, has nothing filled, and every gap is listed to enter again;
 * `sealVerified` says which, and `unsealed` why. A file that fails
 * `PRAGMA integrity_check`, or holds an object named as SQLite's own that no
 * backup of this server's holds, is unsealed before its seal is asked (the
 * second review's B1). This server's key stays this server's: it is read
 * before the clear and put back after the copy (`keepSealKey`), so that the
 * backups it made before the restore still verify after it.
 *
 * Two-step sign-in's rows have rules of their own (card 2768;
 * `restoreMfaRows`, in mfa-backup.ts). No pending sign-in or enrolment link
 * is brought in. Once the rows are copied, inside the transaction, an account
 * that is the same one here (`sameAccountHere`: its id and `created_at`, and,
 * where the seal did not verify, the backup's installation id this server's,
 * or none and the same username; card 3009) gets this server's second factors
 * and recovery codes back as they are now, and its sign-in history; any other
 * gets the backup's only when its seal verified and its key check is this
 * server's MFA key's (`options.key`, this process's key unless a test gives
 * another or none), and otherwise none, named in `mfa.leftOut` where the seal
 * verified and counted in `mfa.notSameHere` where it did not (R10).
 *
 * This server's installation id (card 3009, R6) is read before the clear and
 * put back after the copy, as the seal key is; where it had none, none is kept
 * and none made. The backup's is never brought in, and only its verdict,
 * `installation`, is answered. Every account's guessing counters and pauses are
 * zeroed. The key check is this key's when a factor exists afterwards, and
 * this server's as it was when none does; the backup's is never kept. Once a
 * factor exists, or one was left out, `mfa.withoutFactor` names every account
 * with none. This server's rows are read before anything is cleared
 * (`readMfaHere`), and every read of the backup's first asks whether its
 * table is there, so a backup made before migration 0065 restores.
 *
 * Nor is a restore committed whose rows would have user accounts and no
 * superadmin among them (`lacksSuperadmin`): it is rolled back and throws.
 * The backup can have a superadmin and the restore still lose it, when that
 * row is one that cannot be copied, and then nobody could undo it.
 *
 * `outside` says what the restore is for. `'keep'`, the default, puts an
 * installation back: its backup destinations, report schedules, mail settings
 * and webhooks return as the backup has them, with the secrets filled as above
 * and a webhook not filled left off. `'off'` makes a working copy. A
 * copy of production's data is as able to mail people, call webhooks and
 * change the backup store as production is, so once the tables are copied all
 * four are switched off or removed (`switchOffOutside`) and the result says
 * what was done. That happens inside the restore's transaction: a restore
 * that rolls back leaves all four as they were, and a working copy that could
 * not be switched off is not committed.
 *
 * A webhook held off here is not brought back on by a restore (card 2752,
 * S1). This server's webhooks switched off for good are read before the
 * clear, whatever their secret, and once the rows are copied each restored row
 * of the same webhook (id, board, address and setter) is switched off with the
 * same hold (`carryHolds`, the code review's CS5). `fillSecretGaps` never switches on one whose `held_because` is set,
 * here or in the restored row, and keeps this server's hold on it; and once
 * the gaps are filled, inside the transaction, every restored webhook that is
 * on and whose setter cannot open its board in the restored data, or that
 * nobody is recorded as having set up, is switched off for good
 * (`switchOffLostWebhooks('all')`; a backup made before migration 0071 holds
 * no hold, so its webhooks come in on). The count is `webhooksSwitchedOff`.
 * After the commit each is a WARN naming `by`, who restored, and the boards'
 * owners are mailed where the schedulers run (S2). Not for a working copy,
 * which switches every webhook off anyway. Only on the server's own
 * connection, which the hold rule reads (`canViewBoard`): a restore into any
 * other is not swept, and the start that opens it as the server's database
 * sweeps it. On the same terms, after the sweep, the restored webhooks already
 * switched off without a hold are held (`holdRestoredAlreadyOff`, card 2923,
 * S3): all of them where the restored settings lack
 * `webhooks_already_off_held`, else those whose setter is disabled or not
 * recorded; told with the sweep, the held listed apart in the same mail. A
 * working copy holds them the same way, before it switches every webhook off,
 * and tells nobody (the code review's S3).
 * This server's `webhook_keys_recorded_at` (migration 0071) is
 * read before the clear, and the earlier of it and the backup's is kept (card
 * 2893's code review, CS1).
 *
 * This server's system log is never cleared or written over (card 2899;
 * `restorableTables`): the record of what was done here, and by whom, is not
 * the backup's to replace, and an edited backup cannot put words in it. The
 * backup's own log is not brought in. It is counted, with its first and last
 * times (`systemLogLeftOut`), so that the import can say what the file still
 * holds; a log that cannot be counted is said in `errors`, and the restore
 * goes on.
 *
 * No API key ended on this server comes back (card 2995). The record of ended
 * keys is not cleared (`restorableTables`); after `carryDisabled`, which
 * records the keys it deletes, the backup's own record is added within its
 * bounds (`carryKeyRevocations`); and after the secrets are filled and the
 * reveals carried, every restored key the record names is left out with what
 * it set or was given, a working copy leaving out every key
 * (`leaveOutRecordedKeys`). `apiKeysLeftOut` counts them.
 *
 * No account deleted, disabled or demoted on this server comes back so (card
 * 2996). The record of account endings is not cleared (`restorableTables`);
 * after the copy, the backup's own record is added within its bounds
 * (`carryAccountEndings`) and the one rule is asked of every restored account
 * (`accountRulings`), before the second factors, which give none to an account
 * it ends; after `carryDisabled`, each account it ends is brought back
 * disabled, an inert one with no password that works, and each it lowers given
 * the lower role (`applyAccountEndings`); after the fill, what each could read
 * is held (`holdNoLongerReadableIn`). A working copy does the same.
 * `accountsKept` counts them, and names nobody.
 *
 * No password replaced on this server comes back so either (card 2997):
 * after the record's rulings, each restored account holding a hash the record
 * names as replaced is given this server's own where it is the same account
 * here, and otherwise one nothing matches, a superadmin left so that somebody
 * can still sign in as one (`applyPasswordRulings`; `importer`, the id the
 * importing account had before the import). `passwordsKept` counts them.
 * And where the backup's seal did not verify (card 3009), no account that is
 * not the same account here takes its password from the file: each is given
 * one nothing matches, counted `unsealed`; this server's superadmin, restored
 * as the same account, stays an enabled superadmin; and where the importer is
 * not in the backup as the same account and could not otherwise sign in, the
 * backup's lowest-numbered enabled superadmin is given the importer's own
 * password and authenticators (`superadminGivenYours`), failing closed with
 * no importer. From such a backup only the API keys this server held, the
 * same id, hash and owner, for the same account here are kept, each with the
 * earlier of the two expiries and deadlines; the rest are left out, counted
 * `apiKeysLeftOut.unsealed` (`keysOfTheSameHere`, `takeEarlierEnds`). And,
 * keeping what reaches outside, its mail settings, App URL and destinations
 * at places this server did not hold are held for the superadmin's review
 * (`holdUnsealedSettings`), counted `unsealedHeld`.
 *
 * Throws a `RestoreError` in every case but a clean return. Its `committed`
 * says whether the database was changed: it is false, and the database is as
 * it was, for everything except foreign keys that could not be switched back
 * on after the commit.
 */
export function restoreFromBackup(
	live: Database.Database,
	backup: Database.Database,
	options: { outside?: Outside; key?: MfaKey | null; by?: string; importer?: number } = {}
): RestoreResult {
	// Every read of the backup, from its list and its seal (and the file's
	// checks before it) to the rows copied, inside one read transaction on its
	// connection, so that all of them see the one snapshot: the rows copied are
	// the rows the seal was checked over, even were the file written to
	// meanwhile. It writes nothing, so it is always rolled back, whether the
	// restore returns or throws. A transaction the caller already has open is
	// the caller's to end.
	const began = !backup.inTransaction;
	if (began) backup.exec('BEGIN');
	try {
		return restoreInOneSnapshot(live, backup, options);
	} finally {
		if (began && backup.inTransaction) backup.exec('ROLLBACK');
	}
}

/** `restoreFromBackup`, inside its read transaction on the backup: see there. */
function restoreInOneSnapshot(
	live: Database.Database,
	backup: Database.Database,
	options: { outside?: Outside; key?: MfaKey | null; by?: string; importer?: number }
): RestoreResult {
	const tables = restorableTables(live);
	const errors: string[] = [];
	const restored: Record<string, number> = {};
	const defaulted: RestoreResult['defaulted'] = [];
	let outside: OutsideSwitchedOff | null = null;
	let requestLinksReplaced = 0;
	// The settings held for review here that the backup did not hold, carried over it (card 2922, R10).
	let settingHoldsCarried = 0;
	// What an unsealed backup brought in that reaches outside, held for review (card 3009, R4), counted only.
	let unsealedHeld: UnsealedHeld = { mail: 0, destinations: 0, appUrl: 0 };
	// What an unsealed backup would have sent outside as the file has it, kept from it (card 3012), counted only.
	let unsealedReach: UnsealedReach = { ...NO_UNSEALED_REACH };
	// The webhooks held for that reason, by id, listed among those held for good (R15; its code review, FP19).
	let unsealedWebhooks: number[] = [];
	// Those of them counted in it, which a working copy does not count again among those it switched off (FP8).
	let unsealedCounted = new Set<number>();
	let apiKeyDeadlines = 0;
	// The backup's keys left out: those the record of keys ended here names, those of accounts disabled here, and a
	// working copy's every other key (card 2995).
	let apiKeysLeftOut: ApiKeysLeftOut = { count: 0, keyIds: [], workingCopy: 0, unsealed: 0 };
	let decisionLinksCleared = 0;
	// The webhooks switched off for good inside the transaction (card 2752), told after the commit.
	let swept: SwitchedOff[] = [];
	// And those already off that it held (card 2923, S3), told with them.
	let held: SwitchedOff[] = [];
	// And those a disabled owner or administrator could read (card 2935, P12), told with them.
	let readable: { switchedOff: SwitchedOff[]; held: SwitchedOff[] } = { switchedOff: [], held: [] };
	// And those a key the restore did not bring back, or an ended key, was given the secret of (card 2947, R1), told with them.
	let revealed: { switchedOff: SwitchedOff[]; held: SwitchedOff[] } = { switchedOff: [], held: [] };
	// And those an account the record of account endings ended or lowered could read (card 2996, R7), told with them.
	let ruledHeld: { switchedOff: SwitchedOff[]; held: SwitchedOff[] } = { switchedOff: [], held: [] };
	// The accounts the record of account endings kept ended or lowered (card 2996), counted only.
	let accountsKept: AccountsKept = { deleted: 0, beforeRecord: 0, disabled: 0, lowered: 0 };
	// The rows of the backup's record of account endings left out whole, for its size (card 2996's code review, FP3, FP7).
	let accountRecordLeftOut = 0;
	// The restored passwords this server replaced, kept out of use (card 2997), counted only.
	let passwordsKept: PasswordsKept = { ...NO_PASSWORDS_KEPT };
	const sweptBecause = `found after a restore${options.by ? ` by ${options.by}` : ''}`;
	let secrets: SecretsAccount = {
		kept: { mailPassword: false, destinations: [], webhooks: [] },
		toEnter: { mailPassword: false, destinations: [], webhooks: [] }
	};
	let mfa: MfaRestore = { ...NO_MFA_RESTORE, leftOut: [], withoutFactor: [] };
	// This server's MFA key, unless the caller gives another or none (card
	// 2768): the restore's second factors are taken from a backup only when
	// its key check is this key's.
	const mfaKey = options.key === undefined ? currentMfaKey() : options.key;
	/**
	 * Tables that do not hold everything the backup had for them, by name in
	 * lower case, with what `errors` says about each.
	 */
	const leftOut = new Map<string, string[]>();
	const leaveOut = (table: string, entry: string) => {
		errors.push(entry);
		leftOut.set(table.toLowerCase(), [...(leftOut.get(table.toLowerCase()) ?? []), entry]);
	};
	const foreignKeys = () => live.pragma('foreign_keys', { simple: true });

	// SQLite ignores `PRAGMA foreign_keys` inside a transaction, without an
	// error, so the restore must not start in one.
	if (live.inTransaction) {
		throw new RestoreError(
			'A restore cannot start while a transaction is open on the database connection, because foreign keys ' +
				'cannot be switched off inside one. Nothing was changed. Try again; if it repeats, restart the server.',
			{ errors, committed: false }
		);
	}

	const inBackup = (table: string) =>
		!!backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);

	// The webhooks the backup lists as left without their secrets (card 2169),
	// read from the backup, whose word it is: what cannot be read is ignored
	// and said, and the restore goes on (the plan's N4).
	const { listed, problems } = readListed(backup);
	errors.push(...problems);
	// And those it lists as left without their address (card 2928), with the match each is filled back by.
	const addressListed = readAddressesListed(backup);
	errors.push(...addressListed.problems);
	// This server's key for those matches, read now to be put back once the clear has taken it (R14): none, or
	// one that does not open, fills no address.
	const macKeyHere = addressMacKeyHere(live);

	// Whether this server made the backup, and nobody has changed it since
	// (S1): its seal made again with this server's key. Asked before anything
	// is written, and of the backup alone, after the file's own checks (the
	// second review's B1): one that holds an object named as SQLite's own
	// that no backup of this server's holds, or fails its integrity check, is
	// unsealed whatever its seal says. The restore goes ahead either way; only
	// the filling is withheld. The key is read now, to be put back once the
	// restore has cleared the settings it is in.
	// As stored (sealed, card 2898) to be put back unchanged, and opened to verify with (S5).
	const sealKey = sealKeyHere(live);
	const unsealed = unsealedBecause(backup, sealKey?.key ?? null);
	const sealVerified = unsealed === null;
	// This server's installation id, read now to be put back once the clear has taken it (never made here), and what
	// the backup's says beside it, asked of the snapshot before anything is written (card 3009, R6). Never logged.
	const installationHere = installationIdHere(live);
	const installation = installationOf(backup, installationHere);
	// What decides the same account here, for what this server grants a restored account (`sameAccountHere`).
	const trust: GrantTrust = { sealVerified, installation };
	// A working copy (`outside` `off`), asked by every step below that treats one apart (card 3009's code review, FP15).
	const working = options.outside === 'off';
	// How many secrets the backup held in plain and rowsToRestore sealed (card 2898, S7).
	const sealedInRestore: { count: number; secretsLeftOut?: ListedWebhook[] } = { count: 0 };

	// The backup's system log, which is not brought in (card 2899): counted
	// from this snapshot, so that the import can say what the file still
	// holds. Never a reason to stop the restore.
	let systemLogLeftOut: SystemLogLeftOut | null = null;
	try {
		systemLogLeftOut = systemLogOf(backup);
	} catch (e) {
		systemLogLeftOut = { lines: -1, first: null, last: null };
		errors.push(`The backup's system log, which a restore does not bring in, could not be counted: ${messageOf(e)}`);
	}

	// Off, and read back as off. With them on, clearing a table would delete
	// the rows of every table that refers to it, and a row copied in before the
	// row it refers to would be refused: left out, in a restore that then
	// reported success.
	let switchingOff: unknown = null;
	try {
		live.pragma('foreign_keys = OFF');
	} catch (e) {
		switchingOff = e;
	}
	if (foreignKeys() !== 0) {
		throw new RestoreError(
			'The restore was not started, because foreign keys could not be switched off' +
				(switchingOff ? ` (${messageOf(switchingOff)})` : '') +
				'. Nothing was changed. Try again; if it repeats, restart the server.',
			{ errors, committed: false, cause: switchingOff }
		);
	}

	let failure: unknown = null;
	let unfinished: number[] = [];
	try {
		live.transaction(() => {
			// This server's secrets, read before anything is cleared, for the
			// gaps a backup leaves (card 2169): see above.
			const here = readSecretsHere(live);
			// And its second factors, recovery codes, accounts and key check
			// (card 2768), for restoreMfaRows below.
			const mfaHere = readMfaHere(live);
			// And its API key deadline (migration 0069, card 2772), for a backup
			// made before it: see above. Null where there is none that can be read.
			const deadlineHere = apiKeyDeadlineHere(live);
			// And when it began to record keys on webhooks (migration 0071), kept over the backup's: see above.
			const keysRecordedHere = webhookKeysRecordedHere(live);
			// And its webhooks switched off for good, whatever their secret (card 2752's code review, CS5): see above.
			const holdsHere = webhookHoldsHere(live);
			// And its settings held for review, and whether mail was ever set up here (card 2922, R10 and R9).
			const settingHoldsNow = settingHoldsHere(live);
			// And where its mail, App URL and destinations are (card 3009, R4): see `holdUnsealedSettings`.
			const placesNow = settingPlacesIn(live);
			// And its backup failure mail's address (card 3012, R5): see `keepNotifyEmailHere`.
			const notifyEmailNow = notifyEmailHere(live);
			const mailEverHere = mailEverConfiguredHere(live);
			// And its disabled accounts (card 2671, S6): see `carryDisabled`.
			const disabledAccountsHere = disabledHere(live);
			// And which of its keys were given which webhook's secret (card 2947, R1): see `carryRevealsHere`.
			const revealsNow = revealsHere(live);
			// And W, and its keys up to W by id and hash (card 2995, R1): see `leaveOutRecordedKeys`.
			const keysNow = keysHeldHere(live);
			// And its accounts up to the account watermark, with its superadmins (card 2996): see `accountRulings`.
			const accountsNow = accountsHeldHere(live);
			// And its requests, with their cards and boards, where the seal did not verify (card 3020, R1): see
			// `holdUnsealedRequestMail`.
			const requestsNow = sealVerified ? new Map<number, RequestIdentity>() : requestRowsOf(live);
			// And its people, with their addresses and accounts, where the seal did not verify (card 3020, R7): see
			// `switchOffUnsealedPeople`.
			const peopleNow = sealVerified ? new Map<number, PersonIdentity>() : peopleRowsOf(live);
			// The rows of the keys `carryDisabled` deletes, for the hold below (R2).
			const disabledReveals: Reveal[] = [];
			// And those keys' ids, counted with the keys left out (card 2995, R13).
			const disabledKeyIds: number[] = [];
			// The sign-ins left at their second step, which the clear below
			// ends (card 2769, CS1): said once the restore is committed. No
			// notice is mailed, since the accounts are the backup's from here.
			if (live.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sign_in_challenges'").get()) {
				unfinished = (live.prepare("SELECT user_id FROM sign_in_challenges WHERE purpose = 'verify' ORDER BY user_id").all() as { user_id: number }[]).map(
					(row) => row.user_id
				);
			}

			// Clear every table first, so the order of the copy does not matter.
			for (const table of tables) {
				try {
					live.prepare(`DELETE FROM "${table}"`).run();
				} catch (e) {
					// Its old rows are still in it, so it is not what the backup had.
					leaveOut(table, `Clear ${table}: ${(e as Error).message}`);
				}
			}

			// Copy data from the backup, table by table.
			for (const table of tables) {
				try {
					const exists = backup
						.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
						.get(table);
					if (!exists) continue;

					// Every row, but no session and no unused invite, every plain secret sealed: see rowsToRestore.
					const rows = rowsToRestore(backup, table, sealedInRestore, { sealVerified });
					if (rows.length === 0) continue;

					// Only the columns both sides have.
					const backupCols = Object.keys(rows[0]);
					const liveInfo = live.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; pk: number }[];
					const liveCols = liveInfo.map((c) => c.name);
					const commonCols = backupCols.filter((c) => liveCols.includes(c));

					if (commonCols.length === 0) {
						leaveOut(table, `${table}: no matching columns`);
						continue;
					}

					// A NULL headed for a column that is NOT NULL here and has a
					// default is given the default. See the comment above. Never in
					// a decision's tables (card 2675's code review, F8): a default
					// put into a record, `created_at` now for one, would be a false
					// one, so the row is left out, and the rule below refuses the
					// restore. By prefix, so that no record table is named as text.
					const defaults = table === 'decisions' || table.startsWith('decision_') ? new Map<string, string>() : defaultsForNull(live, table);
					const defaulting = commonCols.filter((c) => defaults.has(c));
					const values = commonCols
						.map((c) => (defaults.has(c) ? orDefault('?', defaults.get(c) as string) : '?'))
						.join(', ');
					const quotedCols = commonCols.map((c) => `"${c}"`).join(', ');
					const insert = live.prepare(`INSERT INTO "${table}" (${quotedCols}) VALUES (${values})`);

					// What a row that cannot be copied is called in `errors`.
					const keyCols = liveInfo
						.filter((c) => c.pk > 0 && commonCols.includes(c.name))
						.sort((a, b) => a.pk - b.pk)
						.map((c) => c.name);

					let rowCount = 0;
					const given = new Map<string, number>();
					rows.forEach((row, index) => {
						try {
							insert.run(...commonCols.map((c) => row[c]));
							rowCount++;
							for (const c of defaulting) {
								if (row[c] === null) given.set(c, (given.get(c) ?? 0) + 1);
							}
						} catch (e) {
							leaveOut(table, `${table} row (${nameOf(row, keyCols, index)}): ${(e as Error).message}`);
						}
					});
					restored[table] = rowCount;
					for (const [column, count] of given) {
						defaulted.push({ table, column, rows: count, value: defaults.get(column) as string });
					}
				} catch (e) {
					// A secret in plain with no key to seal it (card 2898, E9): the restore rolls back.
					if (e instanceof NoKeyToSeal) throw e;
					leaveOut(table, `${table}: ${(e as Error).message}`);
				}
			}

			// A backup from before 0043: see above.
			if (
				!inBackup('work_dependencies') &&
				tables.includes('work_dependencies') &&
				tables.includes('card_dependencies')
			) {
				try {
					const carried = live.prepare(CARRY_CARD_DEPENDENCIES).run().changes;
					if (carried > 0) restored['work_dependencies'] = carried;
				} catch (e) {
					leaveOut('work_dependencies', `work_dependencies, carried from card_dependencies: ${messageOf(e)}`);
				}
			}

			// This server's key for sealing its backups, as it was before the
			// clear: see above. Not caught: a restore that lost it is rolled back.
			// Its record only beside it, and neither where the key is not kept
			// (card 2943, R3).
			if (sealKey !== null) {
				keepSealKey(live, sealKey.stored);
				if (sealKey.madeAt !== null) keepSetting(live, BACKUP_SEAL_KEY_MADE_AT, sealKey.madeAt);
			}
			// And its webhook address key (card 2928, R14), the same way.
			if (macKeyHere !== null) keepSetting(live, WEBHOOK_ADDRESS_MAC_KEY, macKeyHere.stored);
			// And its installation id (card 3009, R6): none kept, and none made, where it had none.
			if (installationHere !== null) keepSetting(live, INSTALLATION_ID, installationHere);

			// A new form signing key, which no restore brings in and the clear
			// took (card 2158): made here, so the restore never commits without
			// one and no read-only check is the first to need it (card 2750).
			// Not caught: a restore that could not make it is rolled back.
			writeFormSecret(live);

			// The rows replaced, this server's sealed secrets among them, are still
			// in the file's free space and its log: the scrub is marked pending in
			// this transaction, a working copy's included (card 2898's code review,
			// S1), and tried at the next start. Never cleared by a restore.
			markScrubPending(live);

			// The restore's moment, for every record it writes (card 2995; card 2996, R22: before the second factors).
			const restoredAt = stamp();

			// The backup's record of account endings added to this server's, which the clear never touched, each row within
			// the backup's own bounds, and the account counter raised over every seed id; then the one rule asked of every
			// restored account (card 2996), before the second factors, which follow it. Not caught: a restore that could not
			// add them or rule is rolled back.
			let rulings: AccountRuling[] = [];
			if (tables.includes('users') && hasAccountRecord(live)) {
				accountRecordLeftOut = carryAccountEndings(live, backup, errors, restoredAt, accountsNow).leftOutWhole;
				const restoredAccounts = live.prepare('SELECT id, created_at AS createdAt, role, password_hash AS passwordHash FROM users ORDER BY id').all() as {
					id: number;
					createdAt: unknown;
					role: string;
					passwordHash: unknown;
				}[];
				// This server's superadmins are ruled as superadmins whatever the backup makes them (FP2).
				rulings = accountRulings(live, restoredAccounts, { heldHere: accountsNow.held, superadminsHere: new Set(accountsNow.superadmins.ids) });
			}
			const endedByRecord = new Map(
				rulings.filter((ruling) => ruling.ended !== null).map((ruling) => [ruling.id, ruling.ended as 'deleted' | 'before record' | 'disabled'])
			);

			// The second factors and recovery codes, by their own rules, the
			// guessing counters zeroed, the same accounts' sign-in history and
			// the key check (card 2768): see above. None to an account the record
			// of account endings ended, and never the backup's to one it keeps
			// disabled; none of them named (card 2996). Not caught: a restore that
			// could not put them back is rolled back.
			mfa = restoreMfaRows(live, backup, mfaHere, { trust, key: mfaKey, ended: endedByRecord });
			for (const table of ['mfa_factors', 'mfa_recovery_codes']) {
				if (!tables.includes(table)) continue;
				const rows = (live.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
				if (rows > 0) restored[table] = rows;
			}

			// Every request's link ended: see above. No backup refills
			// `request_links`, and every `access_token` was read as NULL
			// (`rowsToRestore`), so the count is the requests restored (card
			// 2870, E7). Emptied again here, and not caught (the code review's
			// CS2): the clear above catches its failure and only leaves the table
			// out, which would commit the restore with every old link live, each
			// for a request id that may now be somebody else's thread. A restore
			// that cannot empty it is rolled back.
			if (tables.includes('request_links')) live.prepare('DELETE FROM request_links').run();
			requestLinksReplaced = restored['task_requests'] ?? 0;

			// Every used invite held in plain given 0068's form: see above. Not
			// caught, so that a restore that could not do it is rolled back, and
			// brings in no token a backup held.
			if (tables.includes('invite_tokens')) live.prepare(REPLACE_PLAIN_USED_INVITES).run();

			// A backup made before 0069 (its api_keys has no deadline_at): every
			// key of it with no expiry, or one later than the deadline, given
			// this server's deadline, or the restore's own moment where this
			// server has none that can be read, so such keys end at once; and the
			// setting written back where the backup held none (card 2772, D5,
			// S11). Not caught, so that a restore that could not do it is rolled
			// back, and brings in no key a backup held without its deadline. A
			// backup made since is restored as it is: a key kept there stays kept.
			if (
				inBackup('api_keys') &&
				!columnNamesOf(backup, 'api_keys').includes('deadline_at') &&
				tables.includes('api_keys') &&
				columnNamesOf(live, 'api_keys').includes('deadline_at')
			) {
				const deadline = deadlineHere ?? stamp();
				registerStampFunctions(live);
				apiKeyDeadlines = live.prepare(GIVE_API_KEY_DEADLINES).run({ deadline }).changes;
				if (tables.includes('settings')) live.prepare(KEEP_API_KEY_DEADLINE_SETTING).run({ deadline });
			}

			// The earlier of this server's 0071 setting and the backup's (cards
			// 2752 and 2893; card 2893's code review, CS1): see above. Not
			// caught, so that a restore that could not keep it is rolled back.
			if (keysRecordedHere !== null && tables.includes('settings')) {
				registerStampFunctions(live);
				live.prepare(KEEP_WEBHOOK_KEYS_RECORDED_SETTING).run({ value: keysRecordedHere });
			}

			// Every personal decision link ended, and recorded on its decision
			// (card 2675, decision 13): see above. Not caught, so that a restore
			// that could not end them is rolled back, and brings in no link a
			// backup held. The record first, while the hashes say who held one.
			if (tables.includes('decision_participants') && columnNamesOf(live, 'decision_participants').includes('link_token_hash')) {
				if (tables.includes('decision_events') && tables.includes('decisions')) {
					live.prepare(RECORD_DECISION_LINKS_ENDED).run(stamp());
				}
				decisionLinksCleared = live.prepare(CLEAR_DECISION_LINKS).run().changes;
			}

			// Nothing is committed with a decision's record copied in part (card
			// 2675, decision 13, R8): a partial record would be a false one, and a
			// lost event strands no row, so strandedBy below would not see it. By
			// prefix, so that no record table is named here as text (decision 27).
			const lostRecord = [...leftOut.keys()].filter((t) => t === 'decisions' || t.startsWith('decision_')).sort();
			if (lostRecord.length > 0) {
				throw new Error(
					`decision records could not be copied whole (${lostRecord.join(', ')}): a partial record would be a false one ` +
						`(${some(lostRecord.flatMap((table) => leftOut.get(table) ?? []))})`
				);
			}

			// Nothing is committed that leaves a row pointing at a row this
			// restore left out. Foreign keys are off, so nothing has objected
			// until now; this is where it is asked.
			const stranded = strandedBy(live, leftOut, groupingsNotCopied(live, backup));
			if (stranded.fatal.length > 0) {
				const parents = [...new Set(stranded.fatal.map((group) => group.parent.toLowerCase()))];
				const notCopied = parents.flatMap((parent) => leftOut.get(parent) ?? []);
				const dependants = stranded.fatal.map(
					(group) => `${group.rows.length} row(s) of ${group.table} refer to a row of ${group.parent} that would not be there`
				);
				throw new Error(
					`rows that other rows depend on could not be copied (${some(notCopied)}), and ${dependants.join(', and ')}`
				);
			}
			for (const group of stranded.asItWas) {
				// A board's grouping is sorted board by board (strandedBy), so its
				// table can have lost other rows: then only the ones referred to were not.
				const notLeftOut = leftOut.has(group.parent.toLowerCase())
					? `The backup holds no row of ${group.parent} they refer to`
					: `No row of ${group.parent} was left out by this restore`;
				errors.push(
					`${group.table}: ${group.rows.length} row(s) refer to a row of ${group.parent} that is not there ` +
						`(rowid ${some(group.rows.map(String), 5, ', ')}). ${notLeftOut}` +
						(tables.includes(group.table)
							? ', so the backup holds them that way'
							: `; ${group.table} is not a table a restore replaces, and its rows are the ones it had before`)
				);
			}

			// This server's disabled accounts disabled again on the same accounts
			// restored (card 2671, S6): before the superadmin is asked about,
			// so that the answer is of the accounts as they will be, and before
			// the sweep below, which then switches off the webhooks they set. Not
			// caught: a restore that could not carry them is rolled back.
			// Card 3009, R2: before that, where the backup's seal did not verify, this server's superadmin, restored as the same
			// account, a superadmin again and enabled whatever the file made it, so that the carry, card 2996's rulings, card
			// 2997's rules and the check that a superadmin remains all see it. Not caught.
			if (tables.includes('users') && hasAccountRecord(live)) keepSuperadminsHere(live, accountsNow, trust);
			if (tables.includes('users')) carryDisabled(live, disabledAccountsHere, disabledReveals, disabledKeyIds);

			// Every restored account the record of account endings ends or lowers, ended or lowered (card 2996): after the
			// carry of this server's disables, which keeps the disabler, and before the superadmin is asked about, the
			// readable pass, the fill and card 2995's carry, so that each sees the accounts as they will be. Not caught.
			const applied = applyAccountEndings(live, rulings, restoredAt, disabledReveals, disabledKeyIds);
			accountsKept = applied.kept;
			// Card 3012 (R6, R7): then, where the seal did not verify, as it is or as a working copy, the same accounts here
			// given this server's email address and notification choices, and every other's notification mail switched off:
			// after the record's endings, whose deleted accounts it does not count (its code review, FP7, N1), and before
			// card 3009's carry writes the importer's address. Not caught.
			if (!sealVerified && tables.includes('users') && hasAccountRecord(live)) {
				unsealedReach = { ...unsealedReach, ...keepAccountsHere(live, accountsNow, trust, endedByRecord) };
			}

			// Every restored password this server replaced kept out of use (card 2997, section 13.1): after the record's
			// rulings, whose roles it asks (R10), and before card 2995's carry and the superadmin is asked about. Its keys are
			// counted and their reveals held with the carry's. Not caught: a restore that could not do it is rolled back.
			// Card 3009: where the seal did not verify, an account not the same here takes no password from the file, and the
			// backup's superadmin may be given the importer's, with its authenticators: those it was given are then no longer
			// counted among the accounts with none.
			if (tables.includes('users') && hasAccountRecord(live)) {
				// Whether any second factor is held before the carry (card 3009's code review, FP12): where none is, the
				// importer's carried to the backup's superadmin are the first, and two-step sign-in is in use from here.
				const factorsBefore = tableIn(live, 'mfa_factors') ? (live.prepare('SELECT COUNT(*) FROM mfa_factors').pluck().get() as number) : 0;
				const passwords = applyPasswordRulings(live, accountsNow, {
					trust,
					importer: options.importer,
					ended: endedByRecord,
					at: restoredAt,
					reveals: disabledReveals,
					keyIds: disabledKeyIds,
					working,
					mfaHere,
					mfaKey
				});
				passwordsKept = passwords.kept;
				// Those carried are counted again with every account's (FP12): the carried superadmin holds one now, and, where they
				// are the first, every other account with none now needs its two-step sign-in reset, counted and named by none.
				if (passwords.factorsCarried > 0) {
					mfa = { ...mfa, ...accountsWithoutFactor(live, mfaHere, { trust, ended: endedByRecord }), firstFactorsCarried: factorsBefore === 0 };
				}
			}
			// Card 3012 (R4): where the seal did not verify, kept as it is, every enabled report schedule paused, after card
			// 3009's pause of the accounts not the same here, which it does not count again. Not caught.
			if (!sealVerified && !working) unsealedReach = { ...unsealedReach, schedules: pauseUnsealedSchedules(live, restoredAt) };

			// The backup's record of ended API keys added to this server's, which the clear never touched, each row
			// within the backup's own bounds; and the key counter raised over every seed row (card 2995, R6). Not
			// caught: a restore that could not add them is rolled back.
			if (tables.includes('api_keys')) carryKeyRevocations(live, backup, errors, restoredAt);

			// Nothing is committed that leaves user accounts and no superadmin
			// among them: nobody could export, import or reset again, and
			// `superadmin` is written by set-up alone. The import refuses a backup
			// that has no superadmin before it starts (`backupLacksSuperadmin`),
			// but that asks the backup, and a row that cannot be copied is left
			// out above: the superadmin's among them, in a restore that would
			// otherwise commit. So it is asked again here, of the rows as restored.
			if (lacksSuperadmin(live)) {
				const users = leftOut.get('users') ?? [];
				// Its own sentence where this server's record of account endings ended or lowered the superadmin (card 2996,
				// decision 6): only this server's own rows can (R1), which a genuine backup never meets.
				throw new RestoreLeavesNoSuperadmin(
					applied.superadminEnded
						? "the restored data's superadmin is an account this server's record of account endings names as deleted, disabled or " +
								'given a lower role here, so restoring it would leave nobody able to sign in as the superadmin'
						: 'the restored data would have user accounts and none of them the superadmin' +
								(users.length > 0 ? `, because a row of users could not be copied (${some(users)})` : ''),
					{ errors }
				);
			}

			// The secrets the backup does not hold, filled from this server
			// where they are for the same account, and before a working copy
			// switches off what reaches outside, so that it lists no mail
			// password and no destination. Not caught: a restore that could
			// not fill them is rolled back, and leaves this server's secrets
			// as they were.
			// Only for a backup whose seal verified (S1): for any other, from
			// nothing, so that nothing is filled and every gap is listed.
			// The addresses the backup left out filled first, switching nothing on (card 2928, R19), so that the holds
			// are carried onto the same webhooks, their addresses opened, and the switch-on below sees them.
			const addressesFilled = fillAddressGaps(live, sealVerified ? here : nothingHere(), addressListed.listed, macKeyHere?.key ?? null, {
				writeMarker: !working
			});
			// This server's holds carried onto the same webhooks restored (card
			// 2752's code review, CS5): see above. Before the secrets are filled,
			// and before any webhook is switched on, so that no fill switches one
			// on. Not caught.
			// Card 3012 (R1, R2): before that, where the seal did not verify, every restored webhook with an address held, its
			// secret discarded, and every one without switched off, as it is or as a working copy. Not caught.
			const unsealedHeldNow = sealVerified ? { held: [] } : holdUnsealedWebhooks(live, restoredAt);
			const carriedHere = carryHolds(live, holdsHere, sealVerified);
			// Only those still held for that reason once this server's holds are carried (R3): every one listed below (its
			// code review, FP19), and those this server did not hold counted (R15), whatever the file put in `held_because`
			// (card 3020's code review, FP2).
			const stillUnsealed = new Set(
				unsealedHeldNow.held.length === 0 ? [] : (live.prepare('SELECT id FROM webhooks WHERE held_because = ?').pluck().all(HELD_FROM_UNSEALED_BACKUP) as number[])
			);
			unsealedWebhooks = unsealedHeldNow.held.filter((id) => stillUnsealed.has(id));
			unsealedCounted = new Set(unsealedWebhooks.filter((id) => !carriedHere.has(id)));
			unsealedReach = { ...unsealedReach, webhooks: unsealedCounted.size };
			// This server's settings held for review carried over the backup's, a union (card 2922, R10), before any
			// secret is filled, so that a destination or mail at a held place comes back held. And mail set up here
			// once stays so (R9). Not caught: a restore that could not carry them is rolled back.
			if (tables.includes('setting_holds')) settingHoldsCarried = carrySettingHolds(live, settingHoldsNow);
			// Card 3009, R4: from a backup whose seal did not verify, restored keeping what reaches outside, its mail, App URL
			// and destinations at places this server did not hold are held for the superadmin's review, before the commit
			// and so before anything is mailed or sent. Not caught.
			if (!sealVerified && !working && tables.includes('settings') && tables.includes('setting_holds')) {
				unsealedHeld = holdUnsealedSettings(live, placesNow, restoredAt);
			}
			// Card 3012 (R5): and, as it is or as a working copy, the backup failure mail's address this server's, called on its
			// own: the last of card 3012's steps (R14). Not caught.
			if (!sealVerified && tables.includes('settings')) unsealedReach = { ...unsealedReach, notifyEmail: keepNotifyEmailHere(live, notifyEmailNow) };
			// Card 3020 (R1, R9, R11): then, as it is or as a working copy, every restored request this server did not hold as it
			// is, with an address, has its requester mail held, and every one it did takes this server's hold. Not caught.
			// Card 3020 (R7, R8, R13): and, as it is or as a working copy, every restored person this server did not hold, or has
			// as left, marked left, each recorded in people_changes: the last of card 3020's steps. Not caught. Both ask one
			// `restoredSameHere` (its code review, FP10).
			if (!sealVerified) {
				const sameHere = restoredSameHere(live, accountsNow, trust);
				if (tables.includes('task_requests')) {
					const requests = holdUnsealedRequestMail(live, requestsNow, sameHere);
					unsealedReach = { ...unsealedReach, requestsMailHeld: requests.held, requestsUnconfirmedHeld: requests.unconfirmed };
				}
				if (tables.includes('people')) {
					const marked = switchOffUnsealedPeople(live, peopleNow, sameHere, restoredAt);
					unsealedReach = { ...unsealedReach, peopleMailOff: marked.people, decisionPlacesMailOff: marked.places };
				}
			}
			if (mailEverHere !== null && tables.includes('settings')) {
				live.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('mail_ever_configured_at', mailEverHere);
			}
			// And mail set up in the backup is recorded too (the code review's C4), before a working copy removes it: a
			// backup made before this release holds no record, and the start that would write it comes after.
			if (tables.includes('settings')) {
				live
					.prepare(
						"INSERT OR IGNORE INTO settings (key, value) SELECT 'mail_ever_configured_at', ? " +
							"WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'smtp_host' AND coalesce(value, '') <> '')"
					)
					.run(stamp());
			}
			// With the secrets the restore left out itself, beside an address that does not open here (card 2928, R6).
			const listedAll = [...listed.filter((entry) => !(sealedInRestore.secretsLeftOut ?? []).some((left) => left.id === entry.id)), ...(sealedInRestore.secretsLeftOut ?? [])];
			// The webhooks a disabled owner or administrator of the backup could read, before any secret is filled
			// (card 2935, P12): see `holdRestoredReadable`. Not caught.
			readable = holdRestoredReadable(live, listedAll.map((entry) => entry.id));
			const filled = fillSecretGaps(live, sealVerified ? here : nothingHere(), listedAll, { writeMarker: !working, addressListed: addressListed.listed });
			// The addresses kept and to enter beside the secrets' (card 2928), each only where there is one.
			if (addressesFilled.kept.length > 0) filled.kept.webhookAddresses = addressesFilled.kept;
			if (addressesFilled.unfilled.length > 0) filled.unfilled.webhookAddresses = addressesFilled.unfilled;
			// This server's record of who was given each secret it filled, carried where the same key came back, and
			// the rest returned to be held below (card 2947, R1). Not caught.
			const lostReveals = carryRevealsHere(live, revealsNow);

			// The reads made before reads were recorded seeded where the restored settings lack the flag (card 2995,
			// R3), on the own restore and a working copy alike, after the fill, so that the leave-out below reads every
			// row of each key it leaves out. Then every restored key the record of ended keys names left out, with what
			// it was given, and a working copy's every other key (R4). Before the sweep, which then reads each webhook
			// such a key set as one whose key ended (R8). Not caught.
			let leftOutReveals: Reveal[] = [];
			if (tables.includes('api_keys')) {
				if (tables.includes('settings') && tables.includes('webhook_reveals') && !live.prepare('SELECT 1 FROM settings WHERE key = ?').get(WEBHOOK_REVEALS_SEEDED)) {
					seedRevealsOnce(live);
				}
				// Card 3009: where the seal did not verify, only this server's own keys of the same accounts here are kept.
				const unsealedKeys = sealVerified ? null : { keep: keysOfTheSameHere(live, accountsNow, keysNow.all, trust) };
				const leftOutKeys = leaveOutRecordedKeys(live, { held: keysNow.held, every: working, at: restoredAt, unsealed: unsealedKeys });
				leftOutReveals = leftOutKeys.reveals;
				const keyIds = [...new Set([...disabledKeyIds, ...leftOutKeys.keyIds])].sort((a, b) => a - b);
				apiKeysLeftOut = { count: keyIds.length, keyIds, workingCopy: leftOutKeys.workingCopy, unsealed: leftOutKeys.unsealed };
			}

			// Every restored webhook that is on and held switched off for good
			// (card 2752, S1): see above. On the server's own connection alone,
			// which the hold rule reads, and not for a working copy, which
			// switches every webhook off below and mails nobody. Not caught: a
			// restore that could not switch them off is rolled back. Told after
			// the commit.
			if (live === sqlite && !working) {
				swept = switchOffLostWebhooks('all', sweptBecause, { told: 'by the caller' });
				// After the carries (carryDisabled, carryHolds): the restored webhooks already switched off without a
				// hold held for good (card 2923, S3; its code review, S2): see `holdRestoredAlreadyOff`. Not caught.
				held = holdRestoredAlreadyOff(live);
			}
			// Held as the server's own restore holds them, before every webhook is switched off below, so that
			// only those the backup had off are held, and told to nobody (card 2923's code review, S3).
			if (working) holdRestoredAlreadyOff(live);

			// Never failing open (card 2947, R1, R2; its code review, FP1, a working copy included): every webhook whose
			// secret may be one a key the restore did not bring back was given, and every one the keys of an account
			// disabled again were given, held, before a working copy switches every webhook off, so that switching one
			// on gives it a new secret. The server's own restore tells them with its sweep; a working copy nobody.
			// With every webhook a key left out may have been given (card 2995, R3).
			const fromLost = live === sqlite || working ? holdRevealedIn(live, [...lostReveals, ...disabledReveals, ...leftOutReveals]) : { switchedOff: [], held: [] };
			// And every webhook with a secret an account the record of account endings ended or lowered could read and cannot
			// now, beside it, after the fill, each taken as one that may have read (card 2996, R7). Told with the sweep.
			ruledHeld = live === sqlite || working ? holdNoLongerReadableIn(live, applied.ruled, listedAll.map((entry) => entry.id)) : { switchedOff: [], held: [] };
			if (live === sqlite && !working) {
				// Then what every ended key was given, as the sweep does, the once-only seed first where the restored
				// settings lack its flag, so nothing waits for the five-minute sweep. Told with the sweep. Not caught.
				const fromEnded = holdRevealsOfEndedKeys();
				revealed = { switchedOff: [...fromLost.switchedOff, ...fromEnded.switchedOff], held: [...fromLost.held, ...fromEnded.held] };
			}

			// A working copy: see above. Not caught, so that a failure here rolls
			// the restore back like any other.
			if (working) {
				// With the App URL where the seal did not verify (card 3009's code review, FP3).
				const done = switchOffOutside(live, { appUrl: !sealVerified });
				// What the backup had on, as before card 2169: a webhook that
				// had a secret is off in a backup made since, and is counted
				// from the list, where it was not switched on above (R3).
				// Card 3012's code review (FP8): one held because the seal did not verify is counted there, not here too.
				outside = { ...done, webhooks: done.webhooks + filled.listedOnLeftOff.filter((id) => !unsealedCounted.has(id)).length };
			}
			// A working copy has removed its mail settings and destinations, so
			// it says nothing of their secrets, kept or to enter: only of its
			// webhooks, which stay, switched off.
			// A webhook held for good is set apart from those to enter (card 2923's code review, E1), read after the holds.
			secrets = working
				? {
						kept: {
							mailPassword: false,
							destinations: [],
							webhooks: filled.kept.webhooks,
							...(filled.kept.webhookAddresses ? { webhookAddresses: filled.kept.webhookAddresses } : {})
						},
						toEnter: withUnsealedHeld(
							live,
							withHeldApart(live, {
								mailPassword: false,
								destinations: [],
								webhooks: filled.unfilled.webhooks,
								...(filled.unfilled.webhookAddresses ? { webhookAddresses: filled.unfilled.webhookAddresses } : {})
							}),
							unsealedWebhooks
						)
					}
				: { kept: filled.kept, toEnter: withUnsealedHeld(live, withHeldApart(live, filled.unfilled), unsealedWebhooks) };
		})();
	} catch (e) {
		failure = e;
	}
	const committed = failure === null;

	// Back on, and read back as on, whichever way that went: this is the
	// application's only connection. Inside a transaction this pragma is
	// ignored too, so a rollback that did not happen shows up here.
	let switchingOn: unknown = null;
	try {
		live.pragma('foreign_keys = ON');
	} catch (e) {
		switchingOn = e;
	}
	if (foreignKeys() !== 1) {
		const cause = switchingOn ?? failure;
		if (committed) {
			throw new RestoreError(
				'The backup was restored and committed, but foreign keys could not be switched back on. Restart the ' +
					'server now: until it restarts, deleting a board, a card or a user leaves behind what belonged to it.',
				{ errors, committed: true, cause, done: { requestLinksReplaced, apiKeyDeadlines, decisionLinksCleared, secrets, sealVerified, unsealed, sealKeyHere: sealKey !== null, installation, mfa, systemLogLeftOut, apiKeysLeftOut, accountsKept, accountRecordLeftOut, passwordsKept, unsealedHeld, unsealedReach } }
			);
		}
		throw new RestoreError(
			live.inTransaction
				? `The restore failed (${messageOf(failure)}) and its transaction could not be rolled back, so foreign ` +
					'keys could not be switched back on either. Nothing was committed, and what it had done is ' +
					'discarded when the server stops. Restart the server now.'
				: `The restore failed and nothing was changed (${messageOf(failure)}), and foreign keys could not be ` +
					'switched back on afterwards. Restart the server now.',
			{ errors, committed: false, cause }
		);
	}
	if (failure) {
		// Rolled back, and foreign keys are on again. A refusal for want of a
		// superadmin stays one: see RestoreLeavesNoSuperadmin.
		const message = `The restore failed and nothing was changed: ${messageOf(failure)}`;
		if (failure instanceof RestoreLeavesNoSuperadmin) {
			throw new RestoreLeavesNoSuperadmin(message, { errors, cause: failure });
		}
		throw new RestoreError(message, { errors, committed: false, cause: failure });
	}

	// The restore is committed. A failure from here on is something to report
	// about a restore that succeeded, not a failed restore.
	// The webhooks it switched off, each a WARN, and the boards' owners mailed
	// only where the schedulers run (card 2752, S1, S2).
	// Those already off that it held with them, listed apart (card 2923).
	// With those a disabled owner or administrator could read (card 2935, P12), on the server's own restore alone.
	const readableTold = options.outside === 'off' ? { switchedOff: [], held: [] } : readable;
	// With those a lost or ended key was given the secret of (card 2947, R1), on the server's own restore alone.
	// And those an account the record of account endings ended or lowered could read (card 2996, R7), the same way.
	const ruledTold = options.outside === 'off' || live !== sqlite ? { switchedOff: [], held: [] } : ruledHeld;
	const toldCount =
		swept.length + held.length + readableTold.switchedOff.length + readableTold.held.length + revealed.switchedOff.length + revealed.held.length + ruledTold.switchedOff.length + ruledTold.held.length;
	if (toldCount > 0) {
		try {
			const setting = schedulerSetting(process.env.SCHEDULERS, dev);
			tellSwitchedOff(
				[...swept, ...readableTold.switchedOff, ...revealed.switchedOff, ...ruledTold.switchedOff],
				sweptBecause,
				// Card 3012 (R9): mailed to nobody where the seal did not verify, since the owners' addresses are the file's word.
				!sealVerified
					? { mail: false, because: "the backup's seal did not verify" }
					: setting.run
						? { mail: true }
						: { mail: false, because: `the schedulers are off (${setting.reason})` },
				[...held, ...readableTold.held, ...revealed.held, ...ruledTold.held],
				// The owners' mail names no account (card 2947's code review, FP5): who restored is in the log alone.
				SWEPT_IN_MAIL
			);
		} catch (e) {
			// The readable ones counted too (card 2935's code review, C12), the revealed ones (card 2947) and the ruled ones (card 2996).
			const all = toldCount;
			errors.push(`The ${all} webhook(s) the restore switched off or held could not all be said: ${messageOf(e)}`);
		}
	}
	if (unfinished.length > 0) {
		log.warn(
			`The restore ended ${unfinished.length} sign-in(s) left at their second step, of user id(s) ` +
				`${[...new Set(unfinished)].join(', ')} as they were before it; no notice was mailed`,
			{ userIds: [...new Set(unfinished)] }
		);
	}
	let backfilled: Backfill = {
		firstCompletedAt: 0,
		releasedFromMilestones: 0,
		released: [],
		unfiledBoards: 0,
		unfiled: [],
		committedFilled: 0,
		upstreamCleared: 0,
		discardedCleared: 0,
		optionsAdded: 0,
		optionsMoved: 0,
		optionsRenamed: 0,
		optionsDemoted: 0
	};
	try {
		backfilled = runBackfills(live);
	} catch (e) {
		errors.push(`Backfill after the restore: ${messageOf(e)}`);
	}

	// A backup copies its timestamps as it holds them, and one made before card
	// 2095 holds two forms: brought to one, as every start does. It never throws.
	// Only over the tables this restore replaced: the system log it kept is
	// not rewritten (card 2899's code review, F4).
	const timestamps = normaliseTimestamps(live, { tables });
	if (timestamps.failed !== null) {
		errors.push(
			`Timestamps after the restore were not brought to the stored form, and none was changed: ${timestamps.failed}. ` +
				'The next start tries again.'
		);
	}
	if (Object.keys(timestamps.unreadable).length > 0) {
		errors.push(
			`Timestamps in no form this build can read were left as they are: ${unreadableList(timestamps.unreadable)}. ` +
				'Each start reports them until they are corrected.'
		);
	}

	// The plain text of the secrets this restore sealed was never written to the
	// live file, but the write-ahead log still holds the pages the restore
	// replaced: emptied into the file (card 2898, S7). Best effort: a reader
	// that holds the log leaves it to the next start's scrub.
	if (sealedInRestore.count > 0) {
		try {
			checkpointTruncate(live);
		} catch {
			// Nothing more to be done here.
		}
	}

	return { restored, defaulted, errors, backfilled, timestamps, outside, requestLinksReplaced, apiKeyDeadlines, decisionLinksCleared, secrets, sealVerified, unsealed, sealKeyHere: sealKey !== null, installation, webhooksSwitchedOff: swept.length, mfa, systemLogLeftOut, settingHoldsCarried, apiKeysLeftOut, accountsKept, accountRecordLeftOut, passwordsKept, unsealedHeld, unsealedReach };
}
