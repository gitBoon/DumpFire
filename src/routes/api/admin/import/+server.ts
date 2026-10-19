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
 * was. A restore committed with foreign keys left off says the same, and the
 * request links it replaced, as one that succeeded does (O8).
 *
 * The superadmin's alone. A backup that has users and no superadmin among
 * them is refused before anything is written, and a restore whose rows would
 * leave users and no superadmin, because the superadmin's row could not be
 * copied, is rolled back (`restoreFromBackup`). No session and no unused
 * invite is brought in, whatever the backup holds, so every import signs
 * everybody out, whoever sent it included, and the answer says so, and names
 * the superadmin there is now (`superadmins`).
 *
 * Every task request is given a new link (card 2158), whatever the backup
 * holds, and the key the request form signs with is not brought in. The
 * answer and the log line say how many links were replaced.
 *
 * A backup taken before card 2141 can bring back a board beneath one of its
 * own cards. Once the restore is committed, the line the server writes about
 * such a board at every start is written at once (`reportBoardLoops`).
 */

import { isHttpError, json } from '@sveltejs/kit';
import { SESSION_COOKIE_NAME } from '$lib/server/auth';
import { sqlite } from '$lib/server/db';
import { convertedList, totalConverted } from '$lib/server/db/timestamps';
import { releasedCardsList } from '$lib/server/db/migrate';
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
	type OutsideSwitchedOff,
	type RestoreResult
} from '$lib/server/db/restore';
import Database from 'better-sqlite3';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestHandler } from './$types';
import { createLogger } from '$lib/server/logger';
import { resetFormSecretCache } from '$lib/server/request-tokens';
import { KNOWN_BROWSER_SECRET_KEY, resetKnownBrowserSecretCache } from '$lib/server/known-browsers';
import { requireSuperadmin } from '$lib/server/route-guards';
import { reportBoardLoops } from '$lib/server/startup-checks';
import { failedCheckSentence, secretsKeptSentence, secretsToEnterSentence } from '$lib/server/backup-secrets';

const log = createLogger('IMPORT');

/** The answer to a body that is not sent as a .db backup: see the header. */
const NOT_A_DB_BACKUP =
	'Import takes a .db backup, sent as application/octet-stream. Exports in the old JSON format, which DumpFire ' +
	'wrote only from 1 to 7 April 2026, are no longer imported. Nothing was changed.';

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
 * How many request links the restore replaced (card 2158): every request is
 * given a new one, whatever the backup holds, so a link mailed before the
 * import goes nowhere now. Said only when there were any.
 */
function requestLinksSentence(count: number): string {
	return (
		`${count} request link(s) replaced: a link mailed before this restore no longer works, and its requester ` +
		'can have a new one sent from the page it opens.'
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

/** `text`, closed with a full stop if it has none, and then `sentence`. */
function endingWith(text: string, sentence: string): string {
	return `${text.replace(/\.?$/, '.')} ${sentence}`;
}

export const POST: RequestHandler = async ({ request, locals, url, cookies }) => {
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

	try {
		const buffer = Buffer.from(await request.arrayBuffer());

		// Validate it's a SQLite file (magic header: "SQLite format 3\0")
		const header = buffer.slice(0, 16).toString('ascii');
		if (!header.startsWith('SQLite format 3')) {
			return json({ message: 'Invalid file — not a SQLite database' }, { status: 400 });
		}

		// Write the uploaded backup to a temp file so we can open it as a DB
		const tempPath = join(process.cwd(), '.restore-temp.db');
		writeFileSync(tempPath, buffer);

		let errors: string[] = [];

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
					// review's I3): the restore forgets it anyway.
					const safetyBackup: Record<string, unknown[]> = {};
					const runningTables = restorableTables(sqlite);

					for (const table of runningTables) {
						try {
							safetyBackup[table] =
								table === 'settings'
									? sqlite.prepare('SELECT * FROM "settings" WHERE key <> ?').all(KNOWN_BROWSER_SECRET_KEY)
									: sqlite.prepare(`SELECT * FROM "${table}"`).all();
						} catch {}
					}
					writeFileSync(join(process.cwd(), '.pre-restore-safety.json'), JSON.stringify(safetyBackup));

					result = restoreFromBackup(sqlite, backupDb, { outside });
				}
			} finally {
				backupDb.close();
			}
			if (result === null) {
				try { unlinkSync(tempPath); } catch {}
				return json({ message: NO_SUPERADMIN_IN_BACKUP }, { status: 400 });
			}
			// No session came in with the backup, and the one this request was
			// made with went with the rest: its cookie names nothing now.
			cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
			// The settings are the backup's now, less the key the public
			// request form signs with, which no restore brings in (card 2158):
			// the row that was here went with the rest. The copy of it in
			// memory is forgotten, as a reset does, or it would go on signing
			// and accepting form tokens with the key the restore cleared, and a
			// new one is made at first use. So is
			// the key remembered browsers are signed with, which no backup
			// holds (card 2194): every browser is forgotten.
			resetFormSecretCache();
			resetKnownBrowserSecretCache();
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

			// Nothing is logged until here, with the restore's transaction over:
			// the logger writes to system_logs on this same connection.
			//
			// What was restored and what was filled in, whether or not there is
			// a problem to report as well: the restore is committed either way.
			const filled = [
				`first_completed_at on ${result.backfilled.firstCompletedAt} card(s)`,
				`access_token on ${result.backfilled.accessTokens} request(s)`,
				// Only when there were any, so that a restore of a backup with
				// none reads as it did (card 2179), naming the first 50: once a
				// card is out, nothing records which goal held it (its review).
				...(result.backfilled.releasedFromMilestones > 0
					? [
							`${result.backfilled.releasedFromMilestones} card(s) taken out of a milestone of another board ` +
								`(${releasedCardsList(result.backfilled)})`
						]
					: []),
				...result.defaulted.map(
					(d) => `the default (${d.value}) in place of NULL in ${d.table}.${d.column} on ${d.rows} row(s)`
				)
			].join(', ');
			// A working copy says what it switched off and removed, at the end
			// of this line and of the answer, with or without a problem.
			const workingCopy = result.outside ? workingCopySentence(result.outside) : null;
			// Request links replaced and files put back are said too, before it,
			// and only when there were any. So are the secrets a backup does not
			// hold (card 2169): those kept from this server, and those to enter
			// again, so that a backup made before it reads as it did.
			const linksReplaced = result.requestLinksReplaced > 0 ? requestLinksSentence(result.requestLinksReplaced) : null;
			const secretsKept = secretsKeptSentence(result.secrets.kept);
			const secretsToEnter = secretsToEnterSentence(result.secrets.toEnter, false, result.unsealed);
			const ending = (text: string) =>
				[linksReplaced, putBack, secretsKept, secretsToEnter, workingCopy].reduce<string>(
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
				attachmentsPutBack: files.putBack,
				workingCopy: workingCopy ?? undefined,
				secretsKept: secretsKept ?? undefined,
				secretsToEnter: secretsToEnter ?? undefined,
				superadmins
			};
			log.info(
				ending(`Database restored from an uploaded backup (${size}). Rows: ${summary || 'none'}. Filled in: ${filled}.`)
			);
			// What is to enter, on a line of its own at WARN as well (R2), so that
			// it stands out on the log page beside the line every start writes
			// while it is so, and is not lost among the INFO lines.
			if (secretsToEnter) log.warn(secretsToEnter);
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
				log.warn(`Database restore refused: ${err.message}`, errors.length > 0 ? { errors } : undefined);
				return json({ message: err.message, errors, committed: false }, { status: 422 });
			}
			if (err instanceof RestoreError) {
				// A restore that throws never returned its list of what went wrong
				// along the way; the error carries it out instead. Its message is
				// the whole account and is passed on as it is: it says whether
				// anything was changed, and one of them is not a failed restore at
				// all but a committed one on a connection that needs a restart.
				// That one replaced the settings too, and the sessions.
				if (err.committed) {
					resetFormSecretCache();
					resetKnownBrowserSecretCache();
					cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
				}
				errors = err.errors;
				// The one that committed replaced every request's link and kept
				// or listed the secrets as one that succeeded does, and says so
				// the same way (O8): in the message, the log line and the
				// figures, with what is to enter at WARN on its own line too.
				const done = err.committed ? err.done : null;
				const linksReplaced = done && done.requestLinksReplaced > 0 ? requestLinksSentence(done.requestLinksReplaced) : null;
				const secretsKept = done ? secretsKeptSentence(done.secrets.kept) : null;
				const secretsToEnter = done ? secretsToEnterSentence(done.secrets.toEnter, false, done.unsealed) : null;
				const message = [linksReplaced, secretsKept, secretsToEnter].reduce<string>(
					(said, sentence) => (sentence ? endingWith(said, sentence) : said),
					err.message
				);
				log.critical(`Database restore: ${message}`, errors.length > 0 ? { errors } : undefined);
				if (secretsToEnter) log.warn(secretsToEnter);
				if (done?.unsealed?.check) log.warn(failedCheckSentence(done.unsealed.check));
				return json(
					{
						message,
						errors,
						committed: err.committed,
						requestLinksReplaced: done?.requestLinksReplaced,
						secretsKept: secretsKept ?? undefined,
						secretsToEnter: secretsToEnter ?? undefined
					},
					{ status: 500 }
				);
			}
			log.critical(`Database restore failed: ${err.message}`);
			return json({ message: `Restore failed: ${err.message}`, errors }, { status: 500 });
		}
	} catch (err) {
		// An error SvelteKit made is an answer already, and is passed on as it
		// is: a body sent in chunks that runs past the limit is refused 413
		// where it is read, above. It is not an Error, so left to the lines
		// below it would be answered 500 "Import failed: Unknown error".
		if (isHttpError(err)) throw err;
		// Anything else thrown before the restore, which answers for itself:
		// the upload could not be written down to be opened, above all.
		const msg = err instanceof Error ? err.message : 'Unknown error';
		log.critical(`Import failed: ${msg}`, err);
		return json({ message: `Import failed: ${msg}` }, { status: 500 });
	}
};
