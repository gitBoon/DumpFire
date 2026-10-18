/**
 * uploads-sweep.ts — the sweep that moves attachment files no row names to
 * the trash.
 *
 * A file can be left in a card's folder with no attachment row naming it: the
 * server stopped between a delete's commit and the move to the trash, or
 * between an upload's file and its row; a move to the trash failed; an import
 * replaced the rows and dropped some; or a permanent delete made before the
 * trash existed left its files where they were. Nothing else ever looks for
 * them, so the uploads folder only grows.
 *
 * The sweep is one of the schedulers (`schedulers.ts`): it runs only where
 * they run, so not under the dev server unless asked for, not in a rehearsal
 * and not with SCHEDULERS=off. Its first run is 15 minutes after the server
 * starts and then every six hours, never as the server starts: nothing is
 * removed from the disk at start-up, and a start straight after the wrong
 * backup was restored must leave time to look.
 *
 * What it moves and what it leaves alone is `sweepUnnamed`, in uploads.ts.
 * Whatever it moves stays in the trash for 30 days, where Import Backup still
 * finds a file that a restored row names.
 */
import { sqlite } from './db';
import { createLogger } from './logger';
import { sweepUnnamed, uploadKey, UploadsDirError, type SweepResult } from './uploads';

const log = createLogger('UPLOADS');

/** A file changed more recently than this is never moved: an upload writes its file before its row. */
export const SWEEP_MARGIN_MS = 24 * 60 * 60 * 1000;
/** How long after the server starts the first sweep runs. */
export const FIRST_SWEEP_MS = 15 * 60 * 1000;
/** How often it runs after that. */
export const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

/** The first few of a list, for a log line. */
function firstTen(list: readonly string[]): string {
	return list.slice(0, 10).join('; ') + (list.length > 10 ? `; and ${list.length - 10} more` : '');
}

/**
 * Sweep once, and log what was done. Returns what `sweepUnnamed` did, or
 * null if the sweep did not run.
 *
 * It does nothing while a transaction is open on the connection. The rows,
 * the counter and the folder are read and the files moved in one synchronous
 * pass, so no request on this process can write a row in between.
 *
 * If the rows or the counter cannot be read, it stops before it lists the
 * folder: a sweep that took a failed read for "no rows" would move every
 * file. Nothing it meets is thrown: it runs on a timer, where a throw would
 * stop the server.
 */
export function sweepUploads(now: Date = new Date()): SweepResult | null {
	try {
		if (sqlite.inTransaction) return null;

		let named: Set<string>;
		let highestCardId: number;
		try {
			const rows = sqlite.prepare('SELECT card_id AS cardId, filename FROM card_attachments').all() as {
				cardId: number;
				filename: string;
			}[];
			named = new Set(rows.map((row) => uploadKey(row.cardId, row.filename)));
			// The larger of the counter and the highest id in use, so that a
			// counter row that is missing cannot make every folder another
			// database's.
			highestCardId = Number(
				sqlite
					.prepare(
						"SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'cards'), 0), " +
							'COALESCE((SELECT MAX(id) FROM cards), 0))'
					)
					.pluck()
					.get()
			);
			if (!Number.isSafeInteger(highestCardId)) throw new Error(`the highest card id read is ${highestCardId}`);
		} catch (err) {
			log.warn(
				`Attachment files were not swept: the attachment rows or the card counter could not be read ` +
					`(${err instanceof Error ? err.message : String(err)}). Nothing was moved.`
			);
			return null;
		}

		const result = sweepUnnamed(named, { now, marginMs: SWEEP_MARGIN_MS, highestCardId });

		if (result.moved > 0) {
			log.info(
				`Moved ${result.moved} attachment file(s) that no attachment names to the trash, from ` +
					`${result.folders} card folder(s); ${result.emptyRemoved} card folder(s) left empty were removed`
			);
		}
		if (result.failed.length > 0) {
			log.warn(
				`${result.failed.length} attachment file(s) that no attachment names could not be moved to the trash, ` +
					`and are where they were: ${firstTen(result.failed)}`
			);
		}
		if (result.caseOnly > 0) {
			log.warn(
				`${result.caseOnly} attachment file(s) were left alone because an attachment names each only in another ` +
					`case: on Windows and macOS each is that attachment's file; where case tells names apart no ` +
					`attachment reads them, so look at them by hand`
			);
		}
		if (result.otherDatabase.length > 0) {
			log.warn(
				`${result.otherDatabase.length} folder(s) in the uploads folder are numbered above the highest card id ` +
					`this database has issued (${highestCardId}), so were made by another database, and were left alone: ` +
					firstTen(result.otherDatabase)
			);
		}
		if (result.notCardFolders.length > 0) {
			log.warn(
				`${result.notCardFolders.length} name(s) in the uploads folder are not a card's folder, and were left ` +
					`alone: ${firstTen(result.notCardFolders.map((name) => JSON.stringify(name)))}`
			);
		}
		return result;
	} catch (err) {
		log.warn(
			err instanceof UploadsDirError
				? `Attachment files were not swept: ${err.message}`
				: `The attachment file sweep stopped: ${err instanceof Error ? err.message : String(err)}`
		);
		return null;
	}
}

let sweepTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Sweep 15 minutes from now and then every six hours (idempotent). Called by
 * `startSchedulers`, only where the schedulers run. Neither timer keeps the
 * process alive, and a second call starts nothing.
 */
export function initUploadsSweep(): void {
	if (sweepTimer) return;
	sweepTimer = setTimeout(() => {
		sweepUploads();
		sweepTimer = setInterval(() => sweepUploads(), SWEEP_EVERY_MS);
		sweepTimer.unref();
	}, FIRST_SWEEP_MS);
	sweepTimer.unref();
	log.info('Attachment file sweep initialised: first run in 15 minutes, then every six hours');
}
