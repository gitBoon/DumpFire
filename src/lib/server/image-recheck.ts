/**
 * image-recheck.ts — the images stored before card 2761, checked once (card
 * 2761, D10 and the plan review's S11; the code review's CS2 to CS4 and CR1
 * to CR4).
 *
 * Until card 2761 the card window's upload stored whatever type the browser
 * claimed, and the bytes as sent: an image kept its hidden data (location,
 * camera details, comments), and a file declared as an image need not be
 * one. Card 2754 kept such a file from being shown unless its bytes match;
 * card 2761 checks every new upload. This checks, once, the images already
 * stored, so that the rule holds for every image DumpFire keeps, whenever it
 * was attached:
 *
 *   - every `card_attachments` row whose stored type is one of the four image
 *     types (`imageTypeOf`, parameters and case ignored), oldest first, has
 *     its file read and checked as an upload is (`checkImage`, against the
 *     stored type). A JPEG with a gain map, a motion photo or a trailer after
 *     its image is cut there and stripped, as an upload is (CS1);
 *   - accepted with the same bytes: `clean`, nothing written but, where the
 *     row's `size_bytes` is not the file's size, that size (`resized`, CR2);
 *   - accepted with metadata taken out: the new bytes written into the card's
 *     folder as `.recheck-<uuid>`, flushed to the disk, and renamed over the
 *     file, then the row's `size_bytes` set, in a transaction of its own:
 *     `stripped`;
 *   - refused by the check (not the image its type names, animated, too
 *     large, or malformed): the row's `mime_type` set to
 *     `application/octet-stream`, the file untouched: `retyped`. It is only
 *     ever a download from then on, and no longer counts toward a card's 20;
 *   - a row whose name names no file in its card's folder, or whose file is
 *     not there: `missing`, the row untouched;
 *   - any other failure on a row: `failed`, and the run goes on. A row that
 *     has failed the same way (the same error code) at `GIVE_UP_AFTER`
 *     starts in a row is `givenUp` instead: counted, named, and no longer
 *     keeping the run from finishing (CS2). Each row's failures are kept
 *     between starts in `settings.stored_images_recheck_failures`, as JSON.
 *
 * Then one WARN line under UPLOADS with the counts, naming the rows retyped,
 * failed and given up by id (not by card or file name), and, only when no
 * row failed, `settings.stored_images_rechecked`, the date, with `INSERT OR
 * IGNORE`, so that the next start does nothing; the failures row is then
 * deleted. A run with a failure leaves the flag unwritten and the next start
 * checks every image again, which changes nothing that was done: a stripped
 * file checks to itself. With no image rows there is nothing to say: the
 * flag is written and no line.
 *
 * Called once from hooks.server.ts, after the report schedules are announced
 * and before the schedulers start, and after every committed import of a
 * backup (`/api/admin/import`, CS3), whose settings replace the flag: a
 * backup made before the release has none, and its images are checked
 * straight away. Not awaited by either. It never rejects: a failure outside
 * a row is one WARN line, no flag, and `null`. Nothing a person did, so no
 * activity entry and no live event: a row keeps its name and its card.
 *
 * Every file call is made through `fs.promises` as it is when called, so that
 * tests/image-recheck.test.ts can stand in for one.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db, sqlite } from './db';
import { cardAttachments } from './db/schema';
import { inTransaction } from './db/transaction';
import { checkImage, imageTypeOf } from './image-check';
import { createLogger } from './logger';
import { attachmentPath, UploadPathError, uploadsDir } from './uploads';

const log = createLogger('UPLOADS');

/** The `settings` key that says the images stored before card 2761 were checked. */
export const STORED_IMAGES_RECHECKED = 'stored_images_rechecked';

/** The `settings` key that holds, as JSON, each failed row's last failure and how many starts in a row it failed so. */
export const STORED_IMAGES_RECHECK_FAILURES = 'stored_images_recheck_failures';

/** How many starts in a row a row may fail the same way before it is given up. */
export const GIVE_UP_AFTER = 3;

/** What a refused image is, in the WARN line and the documents (the code review's CR1). */
const REFUSED = 'refused by the check (not the image its type names, animated, too large, or malformed)';

/** What one run did, row by row. */
export type RecheckResult = {
	/** The image rows looked at. */
	checked: number;
	/** Accepted, the bytes as they were. */
	clean: number;
	/** Of the clean, those whose recorded size was not the file's, and was set. */
	resized: number;
	/** Accepted, with metadata taken out: the file written again, its size set. */
	stripped: number;
	/** Refused: typed `application/octet-stream`, the file untouched. */
	retyped: number;
	/** No file, or a name that names none in the card's folder. */
	missing: number;
	/** Could not be read, written or renamed: left for the next start. */
	failed: number;
	/** Failed the same way at `GIVE_UP_AFTER` starts in a row: no longer keeps the flag from being written. */
	givenUp: number;
	/** The ids of the rows retyped, oldest first. */
	retypedIds: number[];
	/** The ids of the rows that failed, oldest first. */
	failedIds: number[];
	/** The ids of the rows given up, oldest first. */
	givenUpIds: number[];
};

type Row = { id: number; cardId: number; filename: string; mimeType: string; sizeBytes: number };

/** What happened to one row. */
type Outcome = 'clean' | 'resized' | 'stripped' | 'retyped' | 'missing';

/** A row's failures kept between starts: the last one's code, and how many starts in a row failed with it. */
type Failures = Record<string, { reason: string; starts: number }>;

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** How a failure is told from another: its error code, or its name. */
function reasonOf(err: unknown): string {
	const code = (err as NodeJS.ErrnoException)?.code;
	if (typeof code === 'string' && code !== '') return code;
	return err instanceof Error ? err.name : 'unknown';
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
}

/** The failures the last starts kept, or none for a value that is not theirs. */
function failuresKept(): Failures {
	const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(STORED_IMAGES_RECHECK_FAILURES) as { value: string } | undefined;
	if (!row) return {};
	try {
		const parsed: unknown = JSON.parse(row.value);
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Failures) : {};
	} catch {
		return {};
	}
}

/** Set a row's `size_bytes`, in a transaction of its own; a row deleted meanwhile updates nothing. */
function setSize(id: number, sizeBytes: number): void {
	inTransaction(() => {
		db.update(cardAttachments).set({ sizeBytes }).where(eq(cardAttachments.id, id)).run();
	});
}

/** Write `bytes` over the file at `path`: into a temp file beside it, flushed to the disk, then renamed over it. */
async function replaceFile(row: Row, path: string, bytes: Uint8Array): Promise<void> {
	const temp = attachmentPath(row.cardId, `.recheck-${randomUUID()}`);
	try {
		const handle = await fsp.open(temp, 'w');
		try {
			await handle.writeFile(bytes);
			await handle.datasync();
		} finally {
			await handle.close();
		}
		await fsp.rename(temp, path);
	} catch (err) {
		await fsp.unlink(temp).catch(() => {});
		throw err;
	}
}

/** Check one row's file, and write what that calls for. Throws only for a failure: the caller counts it. */
async function recheckRow(row: Row): Promise<Outcome> {
	let path: string;
	let bytes: Uint8Array;
	try {
		path = attachmentPath(row.cardId, row.filename);
		bytes = new Uint8Array(await fsp.readFile(path));
	} catch (err) {
		if (err instanceof UploadPathError || (err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing';
		throw err;
	}

	const checked = checkImage(bytes, row.mimeType);
	if (!checked.ok) {
		inTransaction(() => {
			db.update(cardAttachments).set({ mimeType: 'application/octet-stream' }).where(eq(cardAttachments.id, row.id)).run();
		});
		return 'retyped';
	}
	if (sameBytes(checked.bytes, bytes)) {
		if (row.sizeBytes === bytes.byteLength) return 'clean';
		setSize(row.id, bytes.byteLength);
		return 'resized';
	}

	await replaceFile(row, path, checked.bytes);
	setSize(row.id, checked.bytes.byteLength);
	return 'stripped';
}

/** ` (attachment ids 1, 2)`, or nothing for none. */
function idsOf(ids: readonly number[]): string {
	return ids.length > 0 ? ` (attachment ids ${ids.join(', ')})` : '';
}

/**
 * Check every image stored before card 2761, once (see the head of this
 * file). Resolves to what was done, `null` when the flag says it was done
 * before or it could not run. Never rejects.
 */
export async function recheckStoredImages(): Promise<RecheckResult | null> {
	try {
		if (sqlite.prepare('SELECT 1 FROM settings WHERE key = ?').get(STORED_IMAGES_RECHECKED)) return null;
		const rows = (
			sqlite
				.prepare(
					'SELECT id, card_id AS cardId, filename, mime_type AS mimeType, size_bytes AS sizeBytes FROM card_attachments ORDER BY created_at, id'
				)
				.all() as Row[]
		).filter((row) => imageTypeOf(row.mimeType) !== null);

		const result: RecheckResult = {
			checked: 0,
			clean: 0,
			resized: 0,
			stripped: 0,
			retyped: 0,
			missing: 0,
			failed: 0,
			givenUp: 0,
			retypedIds: [],
			failedIds: [],
			givenUpIds: []
		};
		const before = failuresKept();
		const failures: Failures = {};
		// The uploads folder asked once, before any row: one refused is not a row's failure.
		if (rows.length > 0) uploadsDir();
		for (const row of rows) {
			result.checked++;
			try {
				const outcome = await recheckRow(row);
				if (outcome === 'resized') {
					result.clean++;
					result.resized++;
				} else {
					result[outcome]++;
				}
				if (outcome === 'retyped') result.retypedIds.push(row.id);
			} catch (err) {
				const reason = reasonOf(err);
				const last = before[String(row.id)];
				const starts = last && last.reason === reason ? last.starts + 1 : 1;
				failures[String(row.id)] = { reason, starts };
				if (starts >= GIVE_UP_AFTER) {
					result.givenUp++;
					result.givenUpIds.push(row.id);
				} else {
					result.failed++;
					result.failedIds.push(row.id);
				}
			}
		}

		if (result.checked > 0) {
			log.warn(
				`Checked the ${result.checked} images stored before card 2761: ${result.stripped} had hidden data taken out, ` +
					`${result.resized} had only their recorded size corrected, ` +
					`${result.retyped} were ${REFUSED} and are now downloads only${idsOf(result.retypedIds)}, ` +
					`${result.missing} had no file, ${result.failed} could not be checked${idsOf(result.failedIds)}, ` +
					`${result.givenUp} were given up after failing the same way at ${GIVE_UP_AFTER} starts${idsOf(result.givenUpIds)}.` +
					(result.failed > 0 ? ' The next start checks them again.' : '')
			);
		}
		if (result.failed === 0) {
			sqlite.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(STORED_IMAGES_RECHECKED, new Date().toISOString());
			sqlite.prepare('DELETE FROM settings WHERE key = ?').run(STORED_IMAGES_RECHECK_FAILURES);
		} else {
			sqlite.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(STORED_IMAGES_RECHECK_FAILURES, JSON.stringify(failures));
		}
		return result;
	} catch (err) {
		try {
			log.warn(`The images stored before card 2761 could not be checked: ${messageOf(err)}. The next start tries again.`);
		} catch {
			// Nothing more to be done about it.
		}
		return null;
	}
}
