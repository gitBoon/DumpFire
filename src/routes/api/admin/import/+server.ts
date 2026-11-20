/**
 * /api/admin/import — Restore from a .db backup.
 *
 * Takes the uploaded file, sent as `application/octet-stream` (or
 * `application/x-sqlite3`), opens it as a separate SQLite connection and
 * copies all data into the running database in one transaction (no server
 * restart needed). The rows are replaced and the structure is not: the
 * running database keeps its own tables, columns and migration record.
 *
 * A body sent as anything else is refused 400 before it is read. The legacy
 * import of a JSON export, which DumpFire wrote only from 1 to 7 April 2026,
 * was removed (card 2157). If one is ever wanted, import it into an empty
 * installation of an image built before that change, and export a .db there.
 *
 * `?outside=keep` restores everything as the backup has it. `?outside=off`
 * restores a working copy: report schedules and webhooks switched off, the
 * backup schedule switched off and its destinations removed, and the mail
 * settings removed. Without it, the choice follows whether this instance runs
 * its schedulers — see defaultOutside.
 *
 * A backup holds no mail password, destination credential or webhook secret
 * (card 2169): either way, the ones this server has for the same accounts are
 * kept, and the answer and the log say which, and which are to enter again; a
 * webhook that had a secret stays off until it is set. What is to enter is
 * also logged at WARN, beside the start-up line that says it at every start.
 * Only a backup this server made, and nobody changed since, has anything kept
 * (its seal, the review's S1); for any other the same WARN line says why none
 * was. A restore committed with foreign keys left off says the same, and how
 * many requests' links it ended, as one that succeeded does (O8).
 *
 * With a confirmation of the superadmin's current password (card 2701): the
 * page sends `{ currentPassword }` to `/api/admin/import/confirm` first, and
 * the confirmation it is answered in this request's `X-DumpFire-Confirmation`
 * header. It is taken after the two refusals above and before the upload is
 * read, good once, for this session, for 60 seconds; once the upload is in it
 * must still be the superadmin's as they are now, with the password checked
 * still theirs (step-up.ts).
 *
 * The superadmin's alone. A backup that has users and no superadmin among
 * them is refused before anything is written, and a restore whose rows would
 * leave users and no superadmin, because the superadmin's row could not be
 * copied, is rolled back (`restoreFromBackup`). No session and no unused
 * invite is brought in, whatever the backup holds, so every import signs
 * everybody out, whoever sent it included, and the answer says so, and names
 * the superadmin there is now (`superadmins`).
 *
 * Every task request's links are ended (cards 2158 and 2870), whatever the
 * backup holds: none is brought in, and each requester has a new one mailed
 * from the page an old link opens, or with the next mail that carries one.
 * The key the request form signs with is not brought in. The answer and the
 * log line say for how many requests, in the words "request link(s) replaced".
 *
 * A backup made before migration 0069 has its API keys given this server's
 * deadline (card 2772, D5): the answer, its `apiKeyDeadlines` (and
 * `apiKeyDeadline`, the date) and the log line say how many, and the date,
 * when there were any.
 *
 * Second factors and recovery codes are restored by their own rules (card
 * 2768; `restoreMfaRows`). Once two-step sign-in is in use, every account
 * left with no factor is named in one sentence, in the answer and its
 * `mfaWithoutFactor`, and at WARN: each needs its two-step sign-in reset
 * before it can sign in. The same sentence says why any account's factors in
 * the backup were left out, and, when any account's rows were taken from the
 * backup, that their recovery codes are as they were then. Absent when there
 * is nothing to say.
 *
 * A backup taken before card 2141 can bring back a board beneath one of its
 * own cards. Once the restore is committed, the line the server writes about
 * such a board at every start is written at once (`reportBoardLoops`).
 *
 * The same for the start-up removal of card 2406 (card 2411): the restored
 * mail settings, App URL and destinations of a setter who is not an
 * administrator in the restored data are removed once the restore is
 * committed, in their own transaction, with their WARN lines, for either
 * choice of `outside` (`removeSettingsOfFormerAdministrators`). That is done
 * before the answer is made (the code review): the answer, the log line and
 * `settingsRemoved` say what went, and nothing that went is listed as kept or
 * to enter again.
 *
 * This server's system log is kept as it was, and none of the backup's lines
 * is brought in (card 2899; `restorableTables`): an import used to replace the
 * log with the backup's, so that every import deleted the lines written since
 * the backup, and an edited one put its own words there. Once the restore is
 * committed, one CRITICAL line says who imported (by name and id as they were
 * before it, the line's user field left empty), the file's size and SHA-256,
 * whether it is a backup this server made that nobody has changed, how it was
 * restored, and how many log lines the file held that were not brought in;
 * the answer says the last in `systemLog`, a restore committed with foreign
 * keys left off included. That line is written first after the commit, and a
 * failure after it is said as one of a restore that committed (card 2899's
 * code review, F3). An import that changed nothing names who tried, with
 * their user id and address, on the line it writes: a file that is not a
 * SQLite database and a backup with no superadmin, each at WARN (F7), among
 * them.
 *
 * The import's two files, its working copy of the upload and the safety copy,
 * are written beside the database (card 2776). One it cannot write (a full
 * disk, a folder it may not write, the database's folder missing) is refused
 * 500 in words that name no path, with nothing changed and no part-written
 * file left; its CRITICAL line keeps the error. The safety copy is written
 * under a temporary name and renamed over an earlier one, which a failed write
 * leaves as it was. The folder is made when missing only for a database in
 * memory (card 2925): see writeImportFile.
 */

import { error, isHttpError, json } from '@sveltejs/kit';
import { clearSessionCookie, sessionHashIn } from '$lib/server/auth';
import { getDbPath, sqlite } from '$lib/server/db';
import { importFiles } from '$lib/server/db/location';
import { convertedList, totalConverted } from '$lib/server/db/timestamps';
import { releasedCardsList, unfiledBoardsList } from '$lib/server/db/migrate';
import {
	NO_SUPERADMIN_IN_BACKUP,
	RestoreError,
	RestoreLeavesNoSuperadmin,
	SIGNED_OUT,
	backupLacksSuperadmin,
	defaultOutside,
	putBackTrashedFiles,
	restorableTables,
	restoreFromBackup,
	superadminsOf,
	type Outside,
	type OutsideSwitchedOff,
	type AccountsKept,
	type ApiKeysLeftOut,
	type PasswordsKept,
	type RestoreResult,
	type SystemLogLeftOut
} from '$lib/server/db/restore';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RequestHandler } from './$types';
import { createLogger } from '$lib/server/logger';
import { resetFormSecretCache } from '$lib/server/request-tokens';
import { resetKnownBrowserSecretCache } from '$lib/server/known-browsers';
import { SIGNING_KEY_SETTINGS } from '$lib/server/stored-secrets';
import { requireSuperadmin } from '$lib/server/route-guards';
import { reportBoardLoops } from '$lib/server/startup-checks';
import { recheckStoredImages } from '$lib/server/image-recheck';
import { anyRemoved, removeSettingsOfFormerAdministrators, type SettingsRemoved } from '$lib/server/setting-setters';
import {
	CONFIRMATION_HEADER,
	CONFIRMATION_REFUSED,
	requirePasswordUnchanged,
	takeImportConfirmation
} from '$lib/server/step-up';
import { stillCallerNow } from '$lib/server/write-as';
import { addressOf } from '$lib/server/client-address';
import {
	failedCheckSentence,
	quotedName,
	secretsKeptSentence,
	secretsToEnterSentence,
	type SecretsAccount,
	type Unsealed
} from '$lib/server/backup-secrets';
import { mfaWithoutFactorSentence } from '$lib/server/mfa-backup';
import { toStamp } from '$lib/timestamps';

const log = createLogger('IMPORT');

/** The answer to a body that is not sent as a .db backup: see the header. */
const NOT_A_DB_BACKUP =
	'Import takes a .db backup, sent as application/octet-stream. Exports in the old JSON format, which DumpFire ' +
	'wrote only from 1 to 7 April 2026, are no longer imported. Nothing was changed.';

/**
 * The answer when the folder of a database file is not there to write the
 * upload's working copy in (card 2925, ruled 2026-11-18): the import never
 * makes that folder, which is the database's own and is missing only on a
 * server that is already broken.
 */
const NO_FOLDER_FOR_WORKING_COPY = 'The import could not write its working copy beside the database. Nothing was changed.';

/**
 * A file the import could not write (card 2925): its working copy of the
 * upload, or the safety copy. Its message is for the page: why, in words, and
 * no path. The error it came from, path and all, is its `cause`, for the
 * CRITICAL line.
 */
class ImportFileError extends Error {
	constructor(message: string, cause: unknown) {
		super(message, { cause });
		this.name = 'ImportFileError';
	}
}

/** Why a write failed, in words, from the error's code. */
function writeFailureReason(code: string | undefined): string {
	switch (code) {
		case 'ENOSPC':
			return 'there is no space left on the disk';
		case 'EACCES':
		case 'EPERM':
			return 'the server may not write there';
		case 'EROFS':
			return 'the disk is read-only';
		case 'ENOENT':
			return 'its folder is missing';
		// The code review's F5.
		case 'EISDIR':
		case 'ENOTDIR':
			return 'something else is in the way';
		case 'EBUSY':
			return 'the file is in use';
		default:
			return code || 'an unknown error';
	}
}

/**
 * The calls a failed write got as far as, having opened the file it writes
 * (card 2925's code review, F2): only then is that file its own, part-written,
 * and removed. An allow-list, so a failure before it (making the folder,
 * opening the file) never removes a file the write did not make.
 */
const GOT_PAST_OPENING = new Set(['write', 'close', 'rename']);

/**
 * Write one of the import's two files, readable by its owner alone (card
 * 2776), in the folder `importFiles` names (card 2925).
 *
 * For a database in memory that folder is the working directory, which only
 * tests use: it is made when missing, as a temporary folder made for a test
 * was once found gone by the time the import wrote into it. For a database
 * file it is the database's own folder, and it is never made: missing, the
 * import refuses, in words, with nothing changed.
 *
 * The safety copy is written to a temporary name beside it, `.tmp` after its
 * own, and renamed over the copy an earlier import left (the code review's
 * F3): a write that fails leaves that earlier copy as it was. The working copy
 * is written in place: nothing before it is worth keeping.
 *
 * A write that fails once its file is open (a full disk, or a rename refused)
 * leaves no part-written file: the file it wrote is removed, the temporary
 * one for the safety copy. One that failed before (see GOT_PAST_OPENING) is
 * not touched.
 */
function writeImportFile(
	path: string,
	data: string | Buffer,
	which: 'its working copy' | "the safety copy of this server's data",
	inMemory: boolean
): void {
	const replacing = which !== 'its working copy';
	const written = replacing ? `${path}.tmp` : path;
	try {
		if (inMemory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(written, data, { mode: 0o600 });
		if (replacing) renameSync(written, path);
	} catch (err) {
		const { code, syscall } = (err ?? {}) as NodeJS.ErrnoException;
		if (syscall && GOT_PAST_OPENING.has(syscall)) {
			try { unlinkSync(written); } catch {}
		}
		throw new ImportFileError(
			!inMemory && code === 'ENOENT' && which === 'its working copy'
				? NO_FOLDER_FOR_WORKING_COPY
				: `The import could not write ${which} beside the database (${writeFailureReason(code)}). Nothing was changed.`,
			err
		);
	}
}

/** What the CRITICAL line says of an error: for a file not written, the error it came from, path and all. */
function loggedMessage(err: unknown): string {
	const said = err instanceof ImportFileError ? err.cause : err;
	return said instanceof Error ? said.message : String(said ?? 'Unknown error');
}

/**
 * What a working copy had switched off or removed, as the one sentence that
 * ends the answer and the log line. Every count is given, a zero included:
 * "0 webhook(s) switched off" says that it was looked at.
 */
function workingCopySentence(done: OutsideSwitchedOff): string {
	return (
		`Restored as a working copy: ${done.reportSchedules} report schedule(s) and ${done.webhooks} webhook(s) ` +
		`switched off, the backup schedule ${done.backupScheduleWasOn ? 'switched off' : 'was already off'}, ` +
		`${done.backupDestinations} backup destination(s) removed, ${done.mailSettings} mail setting(s) removed.`
	);
}

/**
 * For how many requests the restore ended every link (cards 2158 and 2870):
 * none is brought in, whatever the backup holds, so a link mailed before the
 * import goes nowhere now, and its requester asks for a new one. Said only
 * when there were any. The sentence's words are the ones it has always had.
 */
function requestLinksSentence(count: number): string {
	return (
		`${count} request link(s) replaced: a link mailed before this restore no longer works, and its requester ` +
		'can have a new one sent from the page it opens.'
	);
}

/**
 * This server's settings held for review carried over a backup that did not
 * hold them (card 2922, R10), or null for none: each is held, one the
 * superadmin kept since the backup was made included, and is kept again.
 */
function settingsHeldCarriedSentence(count: number): string | null {
	if (count === 0) return null;
	return (
		`${count} setting hold(s) of this server's kept: a mail setting, App URL or backup destination at a place held for ` +
		"the superadmin's review is held again, one kept since this backup was made included; keep it again under Settings held for review."
	);
}

/**
 * The API key deadline the restore left in the settings (migration 0069, card
 * 2772), as `YYYY-MM-DD HH:MM UTC`; null where there is none that can be read.
 */
function apiKeyDeadlineNow(): string | null {
	const row = sqlite.prepare("SELECT value FROM settings WHERE key = 'api_key_deadline'").get() as { value: unknown } | undefined;
	const deadline = toStamp(row?.value);
	return deadline ? `${deadline.slice(0, 16)} UTC` : null;
}

/**
 * How many API keys of a backup made before migration 0069 the restore gave
 * this server's deadline (card 2772, D5, E12), with the deadline
 * (`apiKeyDeadlineNow`). Said only when there were any.
 */
function apiKeyDeadlinesSentence(count: number, deadline: string | null): string {
	return `${count} API key(s) from before two-step sign-in were given this server's deadline${deadline ? `, ${deadline}` : ''}.`;
}

/**
 * How many personal decision links the restore cancelled (card 2697, Q15):
 * every link a backup holds is emptied, so a link mailed before the import
 * goes nowhere now, and its holder needs a new one. Said only when there were
 * any.
 */
function decisionLinksSentence(count: number): string {
	return (
		`${count} personal decision link(s) cancelled: a link mailed before this restore no longer works, and the decision's ` +
		'author, decider or an administrator can send its holder a new one with Resend.'
	);
}

/** How many attachment files an import had back from the uploads trash. */
function putBackSentence(count: number): string {
	return `${count} attachment file(s) put back from the trash.`;
}

/**
 * Who can sign in as the superadmin now, as a sentence. Whoever imported has
 * been signed out with everybody else, and the backup's accounts are the ones
 * there are: this is the account that can export, import or reset again. A
 * restore never commits with users and no superadmin among them
 * (`restoreFromBackup`), so with none there are no users, and set-up is open.
 */
function superadminSentence(names: readonly string[]): string {
	if (names.length === 0) return 'There are no user accounts now: set-up is open, and whoever completes it is the superadmin.';
	if (names.length === 1) return `The superadmin is now ${names[0]}.`;
	return `The superadmins are now ${names.join(', ')}.`;
}

/**
 * What the removal after a restore took (card 2411), as the one sentence the
 * answer, the log line and `settingsRemoved` carry: the mail settings, with
 * what their going stops; the App URL, with what links then use (a working
 * copy keeps it, so it is all a working copy can lose); the destinations.
 */
function settingsRemovedSentence(removed: SettingsRemoved): string {
	const parts = [
		removed.mail
			? 'the mail settings, so no mail is sent, invites and password resets included, until an administrator sets the mail up again'
			: null,
		removed.appUrl ? "the App URL, so links in mail use APP_URL, or the server's own address, until an App URL is saved again" : null,
		removed.destinations.length > 0
			? `backup destination(s) ${removed.destinations.map((name) => quotedName(name)).join(', ')}, with their stored secrets`
			: null
	].filter((part) => part !== null);
	return (
		'Removed after the restore, because whoever set them is not an administrator in the restored data, or has no ' +
		`account in it: ${parts.join('; ')}.`
	);
}

/**
 * The restore's account of the secrets, less what the removal after it took
 * (card 2411): a mail password or a destination's credentials kept, or to
 * enter again, for settings that are gone is neither.
 */
function withoutRemoved(secrets: SecretsAccount, removed: SettingsRemoved): SecretsAccount {
	const gone = new Set(removed.destinations);
	return {
		kept: {
			...secrets.kept,
			mailPassword: secrets.kept.mailPassword && !removed.mail,
			destinations: secrets.kept.destinations.filter((name) => !gone.has(name))
		},
		toEnter: {
			...secrets.toEnter,
			mailPassword: secrets.toEnter.mailPassword && !removed.mail,
			destinations: secrets.toEnter.destinations.filter((d) => !gone.has(d.name))
		}
	};
}

/**
 * What the answer says of the system log (card 2899): this server's is kept
 * as it was, and the backup's lines are not brought in. Said only when the
 * backup held any, or held a log that could not be counted.
 */
function systemLogSentence(left: SystemLogLeftOut | null): string | null {
	if (left === null || left.lines === 0) return null;
	if (left.lines < 0) return "The system log was kept as it was: the backup's log was not brought in, and remains in the backup file.";
	return `The system log was kept as it was: the backup's ${left.lines} log line(s) were not brought in, and remain in the backup file.`;
}

/**
 * What the answer says of the backup's API keys the restore left out (card 2995): those the record of keys ended on
 * this server names, with those of accounts disabled here, and a working copy's every other key. Absent when none was
 * left out, so that an import of a backup with none reads as it did. Names no account, no key and no id: the ids are
 * in the CRITICAL line's details alone.
 */
function keysLeftOutSentence(left: ApiKeysLeftOut): string | null {
	const ended =
		left.count > 0
			? `${left.count} API key(s) in the backup were left out, because each was revoked or ended on this server, was gone ` +
				'from it before endings were recorded, or is named by the record of ended keys of a backup imported here before, ' +
				'another server\'s among them: none of them works, and their holders make new ones on the Account page.'
			: null;
	const copy =
		left.workingCopy > 0
			? `As a working copy, it ${ended ? 'also left out the other' : 'left out the'} ${left.workingCopy} API key(s) the backup held: no key works on a working copy.`
			: null;
	return [ended, copy].filter((sentence) => sentence !== null).join(' ') || null;
}

/**
 * What the answer and the panel say of the restored accounts the record of account endings kept ended or lowered
 * (card 2996, section 3.7 as section 11 rules it): one sentence for each kind there was any of, counts only, naming no
 * account. Empty where there were none, so that an import with none reads as it did. A `deleted` ruling may rest on a
 * backup's row, so no sentence says the account was deleted on this server (R18).
 *
 * Then the restored passwords kept out of use (card 2997, section 3.7, `passwords` passed in apart, R18): one sentence
 * for each count above 0, counts only. Each is worded for every way `applyPasswordRulings` counts it: `here` and
 * `reset` also count, where the backup's seal did not verify, the same account holding another password than this
 * server's (R2); `reset` also counts the same account whose password here cannot be given back (R11) and a superadmin
 * not here (R9); `superadmin` also counts the same account given back this server's password, replaced too (R12).
 */
function accountsKeptLines(kept: AccountsKept | undefined, passwords?: PasswordsKept): string[] {
	return [...endedLines(kept), ...passwordLines(passwords)];
}

/** Card 2996's sentences of `accountsKeptLines`. */
function endedLines(kept: AccountsKept | undefined): string[] {
	if (kept === undefined) return [];
	return [
		kept.deleted > 0
			? `${kept.deleted} account(s) in the backup are named as deleted by the record of account endings: each is kept disabled, with no ` +
				'password or second factor that works, and cannot be enabled again. Delete each on the Users page before making a new account for anyone ' +
				'who returns: its username and email address would otherwise block the new one.'
			: null,
		kept.beforeRecord > 0
			? `${kept.beforeRecord} account(s) in the backup share a number with an account this server had before it recorded account endings: ` +
				'each is kept disabled with no password that works. If one should stay, the superadmin enables it and sends it an invite.'
			: null,
		kept.disabled > 0 ? `${kept.disabled} account(s) in the backup are kept disabled, as the record of account endings says.` : null,
		kept.lowered > 0 ? `${kept.lowered} account(s) in the backup were given back the lower role the record of account endings holds.` : null
	].filter((line): line is string => line !== null);
}

/** How many accounts the record kept ended or lowered, for the CRITICAL line (card 2996): 0 where none. */
const accountsKeptCount = (kept: AccountsKept | undefined) => (kept === undefined ? 0 : kept.deleted + kept.beforeRecord + kept.disabled + kept.lowered);

/** Card 2997's sentences of `accountsKeptLines`: the restored passwords kept out of use, counted, naming nobody. */
function passwordLines(passwords: PasswordsKept | undefined): string[] {
	if (passwords === undefined) return [];
	return [
		passwords.here > 0
			? `${passwords.here} account(s) in the backup hold a password that was changed on this server after the backup was made, or, where the ` +
				"backup's seal did not verify, any other than the one each has on this server: each keeps the password it has on this server, and the " +
				'one in the backup does not work.'
			: null,
		passwords.reset > 0
			? `${passwords.reset} account(s) in the backup hold a password that was replaced on this server, or, where the backup's seal did not ` +
				'verify, any other than the one each has on this server, and have no password on this server that can be given back to them: none of ' +
				'those passwords works, and each account needs its password set (🔑) or an invite (📧; for a superadmin, 🔑 by another superadmin) before it can sign in.'
			: null,
		passwords.superadmin > 0
			? `${passwords.superadmin} superadmin account(s) were left with a password that was replaced on this server, or, where the backup's seal ` +
				"did not verify, one other than this server's, so that a superadmin can still sign in: sign in and change it on the Account page at once."
			: null
	].filter((line): line is string => line !== null);
}

/** Whether a restore kept any password out of use or left a superadmin's (card 2997): the answer and the line say so only then. */
const anyPasswordsKept = (passwords: PasswordsKept | undefined) => passwords !== undefined && passwords.here + passwords.reset + passwords.superadmin > 0;

/**
 * The CRITICAL line's words for how it was restored (card 2995): as before where no key was left out, else with how
 * many keys ended here were left out, and a working copy's others. And how many accounts the record of account endings
 * kept ended or lowered (card 2996), only where there were any. And how many of the backup's passwords it kept out of
 * use (card 2997), `here` and `reset`, and how many superadmins it left with a password to change, only where any: a
 * superadmin's is left in use, so it is not counted among those kept out of it.
 */
function restoredWords(outside: Outside, left: ApiKeysLeftOut | undefined, kept?: AccountsKept, recordLeftOut = 0, passwords?: PasswordsKept): string {
	const how = outside === 'off' ? 'as a working copy' : 'as it is';
	const accounts = accountsKeptCount(kept);
	const keptOut = passwords === undefined ? 0 : passwords.here + passwords.reset;
	const supers = passwords?.superadmin ?? 0;
	// The backup's record of account endings left out whole for its size (card 2996's code review, FP3, FP7): counted.
	const keeping =
		(accounts > 0 ? `, keeping ${accounts} account(s) ended or lowered as the record of account endings says` : '') +
		(keptOut > 0 ? `, keeping ${keptOut} of the backup's password(s) out of use` : '') +
		(supers > 0 ? `, leaving ${supers} superadmin account(s) with a password to change at once` : '') +
		(recordLeftOut > 0 ? `, the backup's record of account endings (${recordLeftOut} row(s)) left out for its size` : '');
	if (left === undefined || (left.count === 0 && left.workingCopy === 0)) return `${how}${keeping}`;
	const parts = [
		...(left.count > 0 ? [`${left.count} API key(s) ended on this server`] : []),
		...(left.workingCopy > 0 ? [`${left.count > 0 ? 'the other' : 'the'} ${left.workingCopy} API key(s) it held, as a working copy`] : [])
	];
	return `${how}${keeping}, leaving out ${parts.join(' and ')}`;
}

/**
 * Whose backup it was, by its seal, in the words of the import's CRITICAL line
 * (card 2899). A server with no key to check a seal with cannot say, whatever
 * the file carries (the code review's F8).
 */
function sealWords(unsealed: Unsealed | null, sealKeyHere: boolean): string {
	if (unsealed === null) return 'a backup this server made that nobody has changed';
	if (!sealKeyHere) return 'a backup this server could not check, as it has no key to check a seal with';
	if (unsealed.seal === 'none') return 'not a backup this server sealed';
	return 'a backup whose seal does not check out: changed since, or sealed by another server';
}

/** The seal, as the import line's details give it: checked and verified, none to check, or one that failed. */
function sealOf(unsealed: Unsealed | null, sealKeyHere: boolean): string {
	if (unsealed === null) return 'verified';
	return sealKeyHere ? unsealed.seal : 'not checked';
}

/** Who imported, as the line names them: by name and id as they were before the import, and from where. */
type Importer = { id: number; username: string; ip: string | null };

/**
 * The import's CRITICAL line, written once the restore is committed (card
 * 2899): who imported, which file (its size and SHA-256, so that a file held
 * anywhere can be matched to it), whether it was this server's own backup
 * that nobody changed, how it was restored, and what the backup's own log
 * held, which was not brought in. Reset Everything writes the same level for
 * the same weight of change.
 *
 * The name and id are the account's as it was before the import: once it is
 * committed the users are the backup's, and that id may be somebody else's.
 * So they are in the text and the details, and the line's user field is left
 * empty, where the Live Console would label it with whoever has that id now.
 * The details carry the address the import came from as well (F8), as a
 * sign-in's line carries its own.
 *
 * The backup's log is described, never quoted (F2): its first and last times
 * are given only where both are a real moment in the stored form
 * (`systemLogOf` in restore.ts). The check a file failed goes in the details
 * as `backupFailsCheck` words it (F8), the names it quotes made printable,
 * as the WARN line the import writes of it has always carried it.
 */
function importedLine(
	caller: Importer,
	file: { sizeBytes: number; size: string; sha256: string },
	outside: Outside,
	done: {
		unsealed: Unsealed | null;
		sealKeyHere: boolean;
		systemLogLeftOut: SystemLogLeftOut | null;
		apiKeysLeftOut?: ApiKeysLeftOut;
		accountsKept?: AccountsKept;
		accountRecordLeftOut?: number;
		passwordsKept?: PasswordsKept;
	}
): { message: string; meta: Record<string, unknown> } {
	const left = done.apiKeysLeftOut;
	// The keys left out by id, in the details alone, only where there were any (card 2995): the line as before at none.
	const keysMeta = left !== undefined && (left.count > 0 || left.workingCopy > 0) ? { apiKeysLeftOut: left } : {};
	// The accounts the record of account endings kept ended or lowered, counted, never named (card 2996): only where any.
	const accountsMeta = {
		...(accountsKeptCount(done.accountsKept) > 0 ? { accountsKept: done.accountsKept } : {}),
		...((done.accountRecordLeftOut ?? 0) > 0 ? { accountRecordLeftOut: done.accountRecordLeftOut } : {}),
		// The restored passwords kept out of use, counted, never named (card 2997): only where any.
		...(anyPasswordsKept(done.passwordsKept) ? { passwordsKept: done.passwordsKept } : {})
	};
	const logLeft = done.systemLogLeftOut;
	const logPart =
		logLeft === null || logLeft.lines === 0
			? 'the backup held no log lines.'
			: logLeft.lines < 0
				? "the backup's log, which could not be counted, was not brought in and remains in the file."
				: logLeft.first === null || logLeft.last === null
					? `the backup's ${logLeft.lines} log line(s), at times in no form this build reads, were not brought in and remain in the file.`
					: `the backup's ${logLeft.lines} log line(s), ${logLeft.first} to ${logLeft.last}, were not brought in and remain in the file.`;
	return {
		message:
			`The database was replaced from an uploaded backup by ${caller.username} (user ${caller.id} before the import): ` +
			`${file.size}, SHA-256 ${file.sha256}, ${sealWords(done.unsealed, done.sealKeyHere)}, ` +
			`restored ${restoredWords(outside, left, done.accountsKept, done.accountRecordLeftOut, done.passwordsKept)}. The system log was kept as it was; ${logPart}`,
		meta: {
			by: { id: caller.id, username: caller.username },
			ip: caller.ip,
			sizeBytes: file.sizeBytes,
			sha256: file.sha256,
			seal: sealOf(done.unsealed, done.sealKeyHere),
			check: done.unsealed?.check ?? null,
			outside,
			systemLogLeftOut: logLeft,
			...keysMeta,
			...accountsMeta
		}
	};
}

/** Who tried an import that changed nothing, for the end of the line it writes (card 2899). */
function byCaller(caller: Importer): string {
	return ` (import by ${caller.username}, user ${caller.id})`;
}

/** `text`, closed with a full stop if it has none, and then `sentence`. */
function endingWith(text: string, sentence: string): string {
	return `${text.replace(/\.?$/, '.')} ${sentence}`;
}

export const POST: RequestHandler = async ({ request, locals, url, cookies, getClientAddress }) => {
	// The superadmin's alone, and asked before the upload is read: an import
	// replaces every account with the backup's, so whoever may import may make
	// themselves anybody. The gate lets this route be sent the largest body of
	// any, and a caller who is refused here has had none of it read if it said
	// how long it was. One sent in chunks may have had a chunk or two read
	// ahead by then, as soon as the gate handed it on, and no more.
	requireSuperadmin(locals.user);

	// Settled before the upload is read or anything is written. A value that
	// is neither is refused, not given the default: a misspelt `off` must not
	// restore a copy with everything in it still live.
	const asked = url.searchParams.get('outside');
	if (asked !== null && asked !== 'keep' && asked !== 'off') {
		return json(
			{
				message:
					`outside must be "keep" (restore everything as it is) or "off" (restore as a working copy), ` +
					`not "${asked}". Nothing was changed.`
			},
			{ status: 400 }
		);
	}
	const outside = asked ?? defaultOutside();

	// Only a .db backup is imported, and a body that is not sent as one is
	// refused here, before any of it is read. The import of the JSON export
	// DumpFire wrote in its first week was removed (card 2157): no such file
	// can hold what has been added since, and it left twelve tables of the
	// data it replaced in place, so that an API key could answer as another
	// account. The media type alone is compared, without its parameters and
	// in any case: `application/json; x=application/octet-stream` is JSON.
	const mediaType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (mediaType !== 'application/octet-stream' && mediaType !== 'application/x-sqlite3') {
		return json({ message: NOT_A_DB_BACKUP }, { status: 400 });
	}

	// The superadmin's password, confirmed first at /api/admin/import/confirm
	// (card 2701, decision 8): the upload is the body, and cannot carry it. The
	// confirmation is taken here, from its header and the session's hash as the
	// gate found it (card 2775), and
	// never from the request itself, before any of the upload is read. Missing,
	// unknown, used, expired or another session's, it is refused 403 and
	// nothing is read.
	const confirmed = takeImportConfirmation(request.headers.get(CONFIRMATION_HEADER), sessionHashIn(locals.credential));

	// Who imports, once the upload is in and they are asked again below, for
	// every line from there on, the last catch's included (card 2899's code
	// review, F7): by name and id as they are now, and the address it came
	// from, as a sign-in's line carries it.
	let caller: Importer | null = null;
	const ip = addressOf({ getClientAddress })?.slice(0, 100) ?? null;

	try {
		const buffer = Buffer.from(await request.arrayBuffer());
		// Asked again once the upload is in, before anything is written (card
		// 2253): a session that ended while it arrived, or an account that is
		// no longer the superadmin, is refused here, with no temporary copy and
		// no safety file on disk. Asked once: the restore opens its own
		// transaction, and after it the database to ask is the backup's, not the
		// one the caller was let in by. Nothing is awaited from here to the
		// restore.
		const asNow = requireSuperadmin(stillCallerNow(locals));
		// The confirmation holds only for the account it was issued to, as that
		// account is now, and only while its password is the one checked: one
		// changed while the upload arrived is no proof (card 2701, D2 and D9).
		if (asNow.id !== confirmed.userId) error(403, { message: CONFIRMATION_REFUSED, stepUp: 'confirmation' });
		requirePasswordUnchanged(confirmed.userId, confirmed.hash, 'confirmation');
		const importer: Importer = { id: asNow.id, username: asNow.username, ip };
		caller = importer;

		// Validate it's a SQLite file (magic header: "SQLite format 3\0")
		const header = buffer.slice(0, 16).toString('ascii');
		if (!header.startsWith('SQLite format 3')) {
			// Said, naming who sent it (card 2899's code review, F7): nothing was changed.
			log.warn(`Import refused: the file is not a SQLite database${byCaller(importer)}`, undefined, { userId: importer.id, ip });
			return json({ message: 'Invalid file — not a SQLite database' }, { status: 400 });
		}
		// The file, as the import's line names it (card 2899): its size, and its
		// SHA-256, by which a file held anywhere can be matched to this import.
		const file = { sizeBytes: buffer.length, size: `${(buffer.length / 1024).toFixed(1)} KB`, sha256: createHash('sha256').update(buffer).digest('hex') };

		// Write the uploaded backup to a temp file so we can open it as a DB
		// Beside the database, readable by its owner alone (card 2776): see importFiles.
		// Its folder is made only for a database in memory, and a write that
		// cannot be made is refused in words, with no path (card 2925): see
		// writeImportFile.
		const importPaths = importFiles(getDbPath());
		const tempPath = importPaths.upload;
		writeImportFile(tempPath, buffer, 'its working copy', importPaths.inMemory);

		let errors: string[] = [];
		// Whether the restore has committed: from then on a failure is one of a
		// database already replaced (card 2899's code review, F3).
		let committed = false;

		try {
			const backupDb = new Database(tempPath, { readonly: true });

			// The copy itself, with foreign keys off for its duration and back
			// on whether it succeeds or throws, followed by the runner's
			// backfills and its timestamp conversion — see restoreFromBackup.
			let result: RestoreResult | null = null;
			try {
				// Asked of the backup before anything here is touched, the
				// safety copy included: a backup with users and no superadmin
				// among them would leave nobody able to undo it.
				if (!backupLacksSuperadmin(backupDb)) {
					// Create a JSON safety backup BEFORE touching anything. It holds the
					// tables the restore is about to replace, which does not include the
					// migration record — see restorableTables. Not the key remembered
					// browsers are signed with, which no backup holds (card 2194; the
					// review's I3): the restore forgets it anyway. Nor any other
					// signing key (card 2943, R8): the key webhook address matches are
					// made with (card 2928, R14) and the backup seal key, which the
					// restore keeps and no copy holds, and the request form's key,
					// which the restore makes anew.
					const safetyBackup: Record<string, unknown[]> = {};
					const runningTables = restorableTables(sqlite);

					for (const table of runningTables) {
						try {
							safetyBackup[table] =
								table === 'settings'
									? sqlite
											.prepare(`SELECT * FROM "settings" WHERE key NOT IN (${SIGNING_KEY_SETTINGS.map(() => '?').join(', ')})`)
											.all(...SIGNING_KEY_SETTINGS)
									: sqlite.prepare(`SELECT * FROM "${table}"`).all();
						} catch {}
					}
					writeImportFile(importPaths.safety, JSON.stringify(safetyBackup), "the safety copy of this server's data", importPaths.inMemory);

					result = restoreFromBackup(sqlite, backupDb, { outside, by: importer.username, importer: importer.id });
				}
			} finally {
				backupDb.close();
			}
			if (result === null) {
				try { unlinkSync(tempPath); } catch {}
				// Said, naming who sent it (card 2899's code review, F7): nothing was changed.
				log.warn(`Import refused: ${NO_SUPERADMIN_IN_BACKUP}${byCaller(importer)}`, undefined, { userId: importer.id, ip });
				return json({ message: NO_SUPERADMIN_IN_BACKUP }, { status: 400 });
			}
			committed = true;
			// Who imported which file, at CRITICAL, into the log the restore kept
			// (card 2899): see importedLine. First, before anything else after the
			// commit, so that nothing that fails after it can keep it from being
			// written (the code review's F3).
			const imported = importedLine(importer, file, outside, result);
			log.critical(imported.message, imported.meta);
			// No session came in with the backup, and the one this request was
			// made with went with the rest: its cookie names nothing now.
			clearSessionCookie(cookies, url);
			// The settings are the backup's now, less the key the public
			// request form signs with, which no restore brings in (card 2158):
			// the row that was here went with the rest. The copy of it in
			// memory is forgotten, as a reset does, or it would go on signing
			// and accepting form tokens with the key the restore cleared, and the
			// new one the restore wrote in its transaction is read (card 2750). So is
			// the key remembered browsers are signed with, which no backup
			// holds (card 2194): every browser is forgotten.
			resetFormSecretCache();
			resetKnownBrowserSecretCache();
			// The restored settings of a setter who is not an administrator in
			// the restored data are removed now, as every start removes them
			// (card 2411): whichever way it was restored, as a working copy
			// keeps the App URL and its setter rows. In a transaction of its
			// own, after the restore's: one that fails changes nothing, and is
			// no reason to answer a committed restore with a failure. Done
			// before anything below is said (the code review), so that the
			// answer and the log line name what went, and name nothing that
			// went as kept or to enter again (`withoutRemoved`).
			let removed: SettingsRemoved = { mail: false, appUrl: false, destinations: [] };
			try {
				for (const setter of removeSettingsOfFormerAdministrators('restore')) {
					removed = {
						mail: removed.mail || setter.removed.mail,
						appUrl: removed.appUrl || setter.removed.appUrl,
						destinations: [...new Set([...removed.destinations, ...setter.removed.destinations])]
					};
				}
			} catch (err) {
				log.warn(
					`The settings of setters who are not administrators in the restored data could not be checked: ` +
						`${(err as Error)?.message ?? err}. The next start checks again; until then mail and backups may still ` +
						'go where such a person set them.'
				);
			}
			const secrets = withoutRemoved(result.secrets, removed);
			const settingsRemoved = anyRemoved(removed) ? settingsRemovedSentence(removed) : null;
			// The restore is committed and its transaction is over. Rows it
			// brought back may name files that a delete since the backup moved
			// to the trash: those are put back. What could not be is reported
			// with the rest, about a restore that succeeded.
			const files = putBackTrashedFiles(sqlite);
			errors = [...result.errors, ...files.errors];
			const putBack = files.putBack > 0 ? putBackSentence(files.putBack) : null;

			// Clean up temp file
			try { unlinkSync(tempPath); } catch {}

			const size = `${(buffer.length / 1024).toFixed(1)} KB`;
			const summary = Object.entries(result.restored)
				.filter(([, count]) => count > 0)
				.map(([table, count]) => `${table}: ${count}`)
				.join(', ');

			// Nothing is logged until the restore's transaction is over, the
			// removal's lines above included: the logger writes to system_logs
			// on this same connection.
			//
			// What was restored and what was filled in, whether or not there is
			// a problem to report as well: the restore is committed either way.
			const filled = [
				`first_completed_at on ${result.backfilled.firstCompletedAt} card(s)`,
				// Only when there were any, so that a restore of a backup with
				// none reads as it did (card 2179), naming the first 50: once a
				// card is out, nothing records which goal held it (its review).
				...(result.backfilled.releasedFromMilestones > 0
					? [
							`${result.backfilled.releasedFromMilestones} card(s) taken out of a milestone of another board ` +
								`(${releasedCardsList(result.backfilled)})`
						]
					: []),
				// The same for boards filed under a grouping that is not there (card 2293).
				...(result.backfilled.unfiledBoards > 0
					? [
							`${result.backfilled.unfiledBoards} board(s) taken out of a grouping that no longer exists ` +
								`(${unfiledBoardsList(result.backfilled)})`
						]
					: []),
				// The commitment point (milestone 22), only when there were any: a
				// backup made before 0060 brings cards with no commitment.
				...(result.backfilled.committedFilled > 0
					? [`committed_at and committed_by on ${result.backfilled.committedFilled} card(s) not upstream`]
					: []),
				// Every delivery board's Options column (card 2527), only when there
				// were any: a backup made before it holds boards with none.
				...(result.backfilled.optionsAdded > 0
					? [`an Options column at the far left of ${result.backfilled.optionsAdded} delivery board(s)`]
					: []),
				...(result.backfilled.optionsRenamed > 0
					? [`the title Options on ${result.backfilled.optionsRenamed} Options column(s)`]
					: []),
				...(result.backfilled.optionsMoved > 0
					? [`the far-left place on its board for ${result.backfilled.optionsMoved} Options column(s)`]
					: []),
				...result.defaulted.map(
					(d) => `the default (${d.value}) in place of NULL in ${d.table}.${d.column} on ${d.rows} row(s)`
				)
			].join(', ');
			// What the commitment point's repairs took away is not something
			// filled in, and is said as what it is (the S1a review's R7), each
			// part only when there were any, so a restore with none reads as it did.
			const cleared = [
				...(result.backfilled.upstreamCleared > 0
					? [`the commitment of ${result.backfilled.upstreamCleared} upstream card(s)`]
					: []),
				...(result.backfilled.discardedCleared > 0
					? [`the discard mark of ${result.backfilled.discardedCleared} card(s) that are not archived`]
					: []),
				// A board's second Options column (card 2527), only when there were any.
				...(result.backfilled.optionsDemoted > 0
					? [`the Options role of ${result.backfilled.optionsDemoted} second Options column(s), each board keeping its leftmost`]
					: [])
			].join(', ');
			// A working copy says what it switched off and removed, at the end
			// of this line and of the answer, with or without a problem.
			const workingCopy = result.outside ? workingCopySentence(result.outside) : null;
			// Request links replaced and files put back are said too, before it,
			// and only when there were any. So are the secrets a backup does not
			// hold (card 2169): those kept from this server, and those to enter
			// again, so that a backup made before it reads as it did.
			const linksReplaced = result.requestLinksReplaced > 0 ? requestLinksSentence(result.requestLinksReplaced) : null;
			// The API keys of a backup made before 0069 given this server's deadline (card 2772).
			const keyDeadline = result.apiKeyDeadlines > 0 ? apiKeyDeadlineNow() : null;
			const keyDeadlines = result.apiKeyDeadlines > 0 ? apiKeyDeadlinesSentence(result.apiKeyDeadlines, keyDeadline) : null;
			// The backup's keys left out, ended here or a working copy's (card 2995), after the deadlines' sentence.
			const keysLeftOut = keysLeftOutSentence(result.apiKeysLeftOut);
			// And the accounts the record of account endings kept ended or lowered (card 2996), and the restored passwords
			// kept out of use (card 2997), counted, naming nobody.
			const accountsKept = accountsKeptLines(result.accountsKept, result.passwordsKept);
			const accountsKeptSaid = accountsKept.length > 0 ? accountsKept.join(' ') : null;
			// And the personal decision links it cancelled (card 2697, Q15).
			const decisionLinks = result.decisionLinksCleared > 0 ? decisionLinksSentence(result.decisionLinksCleared) : null;
			// What the removal above took is said after them (card 2411).
			const secretsKept = secretsKeptSentence(secrets.kept);
			const secretsToEnter = secretsToEnterSentence(secrets.toEnter, false, result.unsealed);
			// The accounts left with no second factor, once two-step sign-in is
			// in use (card 2768): each needs its reset before it can sign in.
			// Absent when there are none, so a restore without reads as it did.
			const mfaLine = mfaWithoutFactorSentence(result.mfa);
			// This server's system log kept, and the backup's lines not brought
			// in (card 2899): last, and only when the backup held any.
			const systemLog = systemLogSentence(result.systemLogLeftOut);
			// This server's settings held for review that the backup did not hold, carried over it (card 2922, R10):
			// one the superadmin kept here since the backup was made is held again.
			const settingsHeld = settingsHeldCarriedSentence(result.settingHoldsCarried);
			const ending = (text: string) =>
				[linksReplaced, keyDeadlines, keysLeftOut, accountsKeptSaid, decisionLinks, putBack, secretsKept, secretsToEnter, mfaLine, settingsRemoved, settingsHeld, workingCopy, systemLog].reduce<string>(
					(said, sentence) => (sentence ? endingWith(said, sentence) : said),
					text
				);
			// The answer says two things more than the log line does, to whoever
			// is reading it: that they have been signed out with everybody else,
			// and who the superadmin is now, which is whoever can sign in to put
			// it back.
			const superadmins = superadminsOf(sqlite);
			const answering = (text: string) =>
				ending(endingWith(endingWith(text, SIGNED_OUT), superadminSentence(superadmins)));
			// The same account as the message, in parts, for a page that lays
			// it out instead of printing one long sentence.
			const figures = {
				sizeBytes: buffer.length,
				restored: result.restored,
				requestLinksReplaced: result.requestLinksReplaced,
				apiKeyDeadlines: result.apiKeyDeadlines,
				apiKeyDeadline: keyDeadline ?? undefined,
				// The keys ended here that were left out, 0 when none, and what the answer says of every key left out (card 2995).
				apiKeysLeftOut: result.apiKeysLeftOut.count,
				keysLeftOut: keysLeftOut ?? undefined,
				// The accounts the record of account endings kept ended or lowered, counted, and the panel's lines (card 2996).
				accountsKept: result.accountsKept,
				accountsKeptLines: accountsKept.length > 0 ? accountsKept : undefined,
				// The rows of the backup's record of account endings left out whole for its size (FP3, FP7), 0 when none.
				accountRecordLeftOut: result.accountRecordLeftOut,
				// The restored passwords kept out of use, counted (card 2997): absent where none.
				passwordsKept: anyPasswordsKept(result.passwordsKept) ? result.passwordsKept : undefined,
				decisionLinksCleared: result.decisionLinksCleared,
				attachmentsPutBack: files.putBack,
				workingCopy: workingCopy ?? undefined,
				secretsKept: secretsKept ?? undefined,
				secretsToEnter: secretsToEnter ?? undefined,
				mfaWithoutFactor: mfaLine ?? undefined,
				settingsRemoved: settingsRemoved ?? undefined,
				settingsHeld: settingsHeld ?? undefined,
				systemLog: systemLog ?? undefined,
				superadmins
			};
			log.info(
				ending(
					`Database restored from an uploaded backup (${size}). Rows: ${summary || 'none'}. Filled in: ${filled}.` +
						(cleared ? ` Cleared: ${cleared}.` : '')
				)
			);
			// What is to enter, on a line of its own at WARN as well (R2), so that
			// it stands out on the log page beside the line every start writes
			// while it is so, and is not lost among the INFO lines.
			if (secretsToEnter) log.warn(secretsToEnter);
			// So are the accounts left with no second factor (card 2768): none
			// of them can sign in until its two-step sign-in is reset.
			if (mfaLine) log.warn(mfaLine);
			// A file that failed a check made before its seal (the second
			// review's B1) is said once, at WARN, with the check it failed.
			if (result.unsealed?.check) log.warn(failedCheckSentence(result.unsealed.check));
			// A backup made before card 2095 holds timestamps in two forms, and
			// they were brought to one. Said as a start says it, in a WARN line:
			// expected after an import of an older backup, and at no other time.
			const converted = totalConverted(result.timestamps.converted);
			if (converted > 0) {
				log.warn(
					`${converted} timestamp(s) the backup held in another form were converted to the stored form ` +
						`(YYYY-MM-DD HH:MM:SS, UTC), each still naming the same moment to the second: ` +
						`${convertedList(result.timestamps.converted)}.`
				);
			}
			// A backup taken before card 2141 can hold a board beneath one of its
			// own cards. Said now, as the server says it at every start, so that
			// it is not first seen at the next one. A check that cannot be made
			// is no reason to answer a committed restore with a failure.
			try {
				reportBoardLoops(log);
			} catch (err) {
				log.error(`The restored boards could not be checked for a loop: ${(err as Error)?.message ?? err}`);
			}
			// The restore replaced `settings`, and the flag that says the images
			// stored before card 2761 were checked with it: a backup made before
			// that release has none. So its images are checked now, as a start
			// checks them (the code review's CS3), and not first at the next start.
			// Not awaited: the answer does not wait on the files. It never rejects.
			void recheckStoredImages();

			if (errors.length > 0) {
				// Committed, with something to report. Said in the log, in the
				// message and in the list, because a message that only said
				// "restored" is how a missing row goes unnoticed. Neither line
				// says that anything was left out: the list also holds notes
				// about rows that were copied, such as a card whose column is not
				// in the backup either, and then it would not be true.
				const shown =
					errors.slice(0, 10).join('; ') + (errors.length > 10 ? `; and ${errors.length - 10} more` : '');
				log.error(`Restore committed, with ${errors.length} problem(s): ${shown}`);
				return json({
					success: true,
					message: answering(
						`Database restored (${size}), with ${errors.length} problem(s); each is given in the list. ` +
							(summary || 'No data rows found in backup.')
					),
					errors,
					outside: result.outside ?? undefined,
					...figures
				});
			}

			return json({
				success: true,
				message: answering(`Database restored (${size}). ${summary || 'No data rows found in backup.'}`),
				outside: result.outside ?? undefined,
				...figures
			});
		} catch (err: any) {
			try { unlinkSync(tempPath); } catch {}
			if (err instanceof RestoreLeavesNoSuperadmin) {
				// Refused for what the backup holds, as one with no superadmin
				// in it is refused above, and rolled back: nothing was changed,
				// and the server is as it was. A 422 and a WARN, not a fault.
				errors = err.errors;
				// Who tried, as the account is: nothing changed, so its id is still theirs (card 2899).
				log.warn(`Database restore refused: ${err.message}${byCaller(importer)}`, errors.length > 0 ? { errors } : undefined, { userId: importer.id, ip });
				return json({ message: err.message, errors, committed: false }, { status: 422 });
			}
			if (err instanceof RestoreError) {
				// A restore that throws never returned its list of what went wrong
				// along the way; the error carries it out instead. Its message is
				// the whole account and is passed on as it is: it says whether
				// anything was changed, and one of them is not a failed restore at
				// all but a committed one on a connection that needs a restart.
				// That one replaced the settings too, and the sessions.
				const done = err.committed ? err.done : null;
				// Committed, it replaced the database as one that succeeded does, and
				// says who imported which file the same way, first (card 2899; the
				// code review's F3).
				if (done) {
					committed = true;
					const imported = importedLine(importer, file, outside, done);
					log.critical(imported.message, imported.meta);
				}
				if (err.committed) {
					resetFormSecretCache();
					resetKnownBrowserSecretCache();
					clearSessionCookie(cookies, url);
				}
				errors = err.errors;
				// The one that committed replaced every request's link and kept
				// or listed the secrets as one that succeeded does, and says so
				// the same way (O8): in the message, the log line and the
				// figures, with what is to enter at WARN on its own line too.
				const linksReplaced = done && done.requestLinksReplaced > 0 ? requestLinksSentence(done.requestLinksReplaced) : null;
				// The API keys given this server's deadline, as a restore that succeeded says them (card 2772).
				const keyDeadline = done && done.apiKeyDeadlines > 0 ? apiKeyDeadlineNow() : null;
				const keyDeadlines = done && done.apiKeyDeadlines > 0 ? apiKeyDeadlinesSentence(done.apiKeyDeadlines, keyDeadline) : null;
				// The backup's keys left out, as a restore that succeeded says them (card 2995).
				const keysLeftOut = done ? keysLeftOutSentence(done.apiKeysLeftOut) : null;
				// The accounts the record of account endings kept ended or lowered (card 2996), and the restored passwords kept
				// out of use (card 2997), as a restore that succeeded says them.
				const accountsKept = done ? accountsKeptLines(done.accountsKept, done.passwordsKept) : [];
				const accountsKeptSaid = accountsKept.length > 0 ? accountsKept.join(' ') : null;
				// The personal decision links it cancelled, as a restore that succeeded says them (card 2697, Q15).
				const decisionLinks = done && done.decisionLinksCleared > 0 ? decisionLinksSentence(done.decisionLinksCleared) : null;
				const secretsKept = done ? secretsKeptSentence(done.secrets.kept) : null;
				const secretsToEnter = done ? secretsToEnterSentence(done.secrets.toEnter, false, done.unsealed) : null;
				// The accounts left with no second factor (card 2768), as above.
				const mfaLine = done ? mfaWithoutFactorSentence(done.mfa) : null;
				// This server's system log kept, as a restore that succeeded says it (the code review's F6).
				const systemLog = done ? systemLogSentence(done.systemLogLeftOut) : null;
				const message = [linksReplaced, keyDeadlines, keysLeftOut, accountsKeptSaid, decisionLinks, secretsKept, secretsToEnter, mfaLine, systemLog].reduce<string>(
					(said, sentence) => (sentence ? endingWith(said, sentence) : said),
					err.message
				);
				// One that changed nothing names who tried on its own line, with
				// their id, which is still theirs (card 2899).
				if (done) {
					log.critical(`Database restore: ${message}`, errors.length > 0 ? { errors } : undefined);
				} else {
					log.critical(`Database restore: ${message}${byCaller(importer)}`, errors.length > 0 ? { errors } : undefined, { userId: importer.id, ip });
				}
				if (secretsToEnter) log.warn(secretsToEnter);
				if (mfaLine) log.warn(mfaLine);
				if (done?.unsealed?.check) log.warn(failedCheckSentence(done.unsealed.check));
				return json(
					{
						message,
						errors,
						committed: err.committed,
						requestLinksReplaced: done?.requestLinksReplaced,
						apiKeyDeadlines: done?.apiKeyDeadlines,
						apiKeyDeadline: keyDeadline ?? undefined,
						apiKeysLeftOut: done?.apiKeysLeftOut.count,
						keysLeftOut: keysLeftOut ?? undefined,
						accountsKept: done?.accountsKept,
						accountsKeptLines: accountsKept.length > 0 ? accountsKept : undefined,
						accountRecordLeftOut: done?.accountRecordLeftOut,
						passwordsKept: done && anyPasswordsKept(done.passwordsKept) ? done.passwordsKept : undefined,
						decisionLinksCleared: done?.decisionLinksCleared,
						secretsKept: secretsKept ?? undefined,
						secretsToEnter: secretsToEnter ?? undefined,
						mfaWithoutFactor: mfaLine ?? undefined,
						systemLog: systemLog ?? undefined
					},
					{ status: 500 }
				);
			}
			// A failure after the commit is one of a database already replaced
			// (card 2899's code review, F3): said so, and with no user on the line,
			// since the caller's id may now be somebody else's. Its CRITICAL line
			// of who imported which file was written at the commit.
			if (committed) {
				log.critical(
					`Database restore committed, and then failed: ${err?.message ?? err}. The backup is in; nothing was rolled back` +
						` (import by ${importer.username}, user ${importer.id} before the import)`
				);
				return json(
					{ message: `The backup was restored and committed, and then something failed: ${err?.message ?? err}. Reload the page.`, errors, committed: true },
					{ status: 500 }
				);
			}
			// A safety copy that could not be written (card 2925) is said on the
			// page in words, and on this line as the error it came from, path and
			// all, that error as the line's details too (the code review's F7).
			log.critical(
				`Database restore failed: ${loggedMessage(err)}${byCaller(importer)}`,
				err instanceof ImportFileError ? err.cause : undefined,
				{ userId: importer.id, ip }
			);
			return json({ message: `Restore failed: ${err.message}`, errors }, { status: 500 });
		}
	} catch (err) {
		// An error SvelteKit made is an answer already, and is passed on as it
		// is: a body sent in chunks that runs past the limit is refused 413
		// where it is read, above. It is not an Error, so left to the lines
		// below it would be answered 500 "Import failed: Unknown error".
		if (isHttpError(err)) throw err;
		// The upload's working copy that could not be written (card 2925): the
		// page has the refusal in words, with no path; this line has the error
		// it came from, path and all.
		if (err instanceof ImportFileError) {
			log.critical(`Import failed: ${loggedMessage(err)}${caller ? byCaller(caller) : ''}`, err.cause, caller ? { userId: caller.id, ip } : undefined);
			return json({ message: err.message }, { status: 500 });
		}
		// Anything else thrown before the restore, which answers for itself.
		const msg = err instanceof Error ? err.message : 'Unknown error';
		// Naming who sent it, once they are known (card 2899's code review, F7).
		log.critical(`Import failed: ${msg}${caller ? byCaller(caller) : ''}`, err, caller ? { userId: caller.id, ip } : undefined);
		return json({ message: `Import failed: ${msg}` }, { status: 500 });
	}
};
