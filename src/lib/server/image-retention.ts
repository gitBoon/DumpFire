/**
 * image-retention.ts — the images of cards closed long ago, moved to the
 * trash (card 2754, D14 and the plan review's S1, S5 and S6).
 *
 * Images are kept on disk, not in the database, and a card keeps its
 * screenshots after it is completed: cards are reopened, and the screenshots
 * are the record of what was asked. So nothing is deleted on Complete. A card
 * closed for longer than `IMAGE_RETENTION_DAYS` (180 unless set) has its
 * image rows deleted here, and their files moved to the 30-day trash once
 * that is committed, where an import of an earlier backup can still find
 * them. A card counts as closed when:
 *
 *   - it is archived, with `archived_at` older than the cutoff, whatever
 *     column it is in; or
 *   - it sits now in a Complete-role column (`isCompleteColumnTitle`, the
 *     rule burndown uses), with `completed_at` older than the cutoff.
 *
 * `completed_at` alone is not enough: a card moved out of Complete by a
 * column that was renamed, or by an older route, can keep a stale stamp,
 * and that must not delete anything (S1).
 *
 * Only image rows are taken (the stored type one of the four, read by
 * `imageTypeOf`, parameters and case ignored, as the per-card cap counts
 * them), whichever tree attached them; a PDF or a text file stays. Each row
 * deleted writes an `attachment_expired` entry with no user, named
 * `DumpFire`, with source `system` (D15), and each card's board is sent the
 * attachment event, so an open card window drops the file. No webhook: the
 * action is in no event's map.
 *
 * It runs inside the attachment file sweep (`uploads-sweep.ts`), first, in
 * its own try/catch, and so only where the schedulers run. At most
 * `MOST_EXPIRED_A_RUN` rows go in one run, oldest first, and the count is
 * logged; the rest go in the next run, six hours later.
 *
 * `IMAGE_RETENTION_DAYS` is read by `retentionDays`: `off` turns retention
 * off; a whole number from 30 to 3650 is the days; unset is 180; anything
 * else stops retention, with an error in the log, and deletes nothing.
 *
 * A key's upload to a card retention would already take is refused 409
 * (`attachImage`, asking `isExpiredCard`): the image would go in the next run.
 */
import { inArray } from 'drizzle-orm';
import { db, sqlite } from './db';
import { cardAttachments } from './db/schema';
import { inTransaction } from './db/transaction';
import { trashAfterCommit } from './deletes';
import { emit } from './events';
import { imageTypeOf } from './image-check';
import { createLogger } from './logger';
import { ACTIONS, logActivity } from './logActivity';
import { isCompleteColumnTitle } from '$lib/column-role';
import { stamp } from '$lib/timestamps';

const log = createLogger('UPLOADS');

/** The days a closed card keeps its images when `IMAGE_RETENTION_DAYS` is not set. */
export const DEFAULT_IMAGE_RETENTION_DAYS = 180;
/** The fewest days `IMAGE_RETENTION_DAYS` may be. */
export const FEWEST_IMAGE_RETENTION_DAYS = 30;
/** The most days `IMAGE_RETENTION_DAYS` may be. */
export const MOST_IMAGE_RETENTION_DAYS = 3650;
/** The most image rows one run deletes. */
export const MOST_EXPIRED_A_RUN = 200;
/** The name the entries are written under: no person made them. */
export const RETENTION_ACTOR = 'DumpFire';

const DAY_MS = 86_400_000;

/**
 * What `IMAGE_RETENTION_DAYS` says: the days a closed card keeps its images,
 * `null` for `off`, or a refusal whose message the caller logs as an error,
 * and then runs nothing.
 */
export type RetentionSetting = { ok: true; days: number | null } | { ok: false; message: string };

/**
 * Read `IMAGE_RETENTION_DAYS` (S6). `off` is off; digits alone, from 30 to
 * 3650, are the days; unset is 180. Anything else, a space, a sign, a
 * fraction, an empty value or a number out of range among it, is refused:
 * retention fails closed, and nothing is deleted on a value nobody meant.
 */
export function retentionDays(value: string | undefined = process.env.IMAGE_RETENTION_DAYS): RetentionSetting {
	if (value === undefined) return { ok: true, days: DEFAULT_IMAGE_RETENTION_DAYS };
	if (value === 'off') return { ok: true, days: null };
	if (/^\d+$/.test(value)) {
		const days = Number(value);
		if (days >= FEWEST_IMAGE_RETENTION_DAYS && days <= MOST_IMAGE_RETENTION_DAYS) return { ok: true, days };
	}
	return {
		ok: false,
		message:
			`IMAGE_RETENTION_DAYS is set to ${JSON.stringify(value)}, which is neither off nor a whole number of days from ` +
			`${FEWEST_IMAGE_RETENTION_DAYS} to ${MOST_IMAGE_RETENTION_DAYS}. No image was moved to the trash: set it to off, ` +
			`or to a number of days, or leave it unset for ${DEFAULT_IMAGE_RETENTION_DAYS}.`
	};
}

/** The moment a card closed before is past keeping its images, in the stored form. */
function cutoffOf(now: Date, days: number): string {
	return stamp(new Date(now.getTime() - days * DAY_MS));
}

/** What retention reads of a card. */
type ClosedCard = { completedAt: string | null; archivedAt: string | null; columnTitle: string | null };

/**
 * The stamp a card counts as closed from, if it is older than `cutoff`, or
 * null: archived before it, anywhere; or in a Complete-role column now and
 * completed before it. Where both hold, the older.
 */
function closedBefore(card: ClosedCard, cutoff: string): string | null {
	const stamps: string[] = [];
	if (card.archivedAt !== null && card.archivedAt < cutoff) stamps.push(card.archivedAt);
	if (card.completedAt !== null && card.completedAt < cutoff && isCompleteColumnTitle(card.columnTitle)) stamps.push(card.completedAt);
	return stamps.length === 0 ? null : stamps.sort()[0];
}

/**
 * Whether retention, set to `days`, would take the images of the card `id`
 * now: the rule `expireClosedCardImages` keeps, for one card. Asked by a
 * key's upload, inside its transaction (409). False for a card that is not
 * there, and for `days` null (retention off).
 */
export function isExpiredCard(cardId: number, now: Date, days: number | null): boolean {
	if (days === null) return false;
	const card = sqlite
		.prepare(
			`SELECT c.completed_at AS completedAt, c.archived_at AS archivedAt, col.title AS columnTitle
			   FROM cards c
			   JOIN columns col ON col.id = c.column_id
			  WHERE c.id = ?`
		)
		.get(cardId) as ClosedCard | undefined;
	return card !== undefined && closedBefore(card, cutoffOf(now, days)) !== null;
}

/** What one run did. */
export type RetentionResult = {
	/** Image rows deleted, their files queued for the trash. */
	expired: number;
	/** Whether more were due than one run takes. */
	more: boolean;
};

/** A file's name as an entry quotes it, without Unicode format characters (as `card-attachments.ts` quotes it). */
function quotedName(name: string): string {
	return name.replace(/\p{Cf}/gu, '');
}

type Candidate = {
	id: number;
	cardId: number;
	filename: string;
	originalName: string;
	mimeType: string;
	cardTitle: string;
	boardId: number;
	completedAt: string | null;
	archivedAt: string | null;
	columnTitle: string | null;
};

/**
 * Delete the image rows of cards closed more than `days` before `now`, at
 * most `MOST_EXPIRED_A_RUN`, oldest first (by the stamp the card counts as
 * closed from, then by id), each with its entry, and each card's board told;
 * their files go to the trash once that is committed (`trashAfterCommit`, as
 * a delete's do). A file whose move fails stays in the card's folder with no
 * row naming it, and the orphan sweep that follows moves it.
 *
 * Returns null, and does nothing, while a transaction is open on the
 * connection: the sweep runs on a timer, between requests. Throws what the
 * database throws; the sweep catches it.
 */
export function expireClosedCardImages(now: Date, days: number): RetentionResult | null {
	if (sqlite.inTransaction) return null;
	const cutoff = cutoffOf(now, days);

	const result = inTransaction((): RetentionResult => {
		const due = (
			sqlite
				.prepare(
					`SELECT a.id, a.card_id AS cardId, a.filename, a.original_name AS originalName, a.mime_type AS mimeType,
					        c.title AS cardTitle, col.board_id AS boardId,
					        c.completed_at AS completedAt, c.archived_at AS archivedAt, col.title AS columnTitle
					   FROM card_attachments a
					   JOIN cards c ON c.id = a.card_id
					   JOIN columns col ON col.id = c.column_id
					  WHERE (c.archived_at IS NOT NULL AND c.archived_at < ?)
					     OR (c.completed_at IS NOT NULL AND c.completed_at < ?)`
				)
				.all(cutoff, cutoff) as Candidate[]
		)
			.filter((row) => imageTypeOf(row.mimeType) !== null)
			.map((row) => ({ row, closed: closedBefore(row, cutoff) }))
			.filter((one): one is { row: Candidate; closed: string } => one.closed !== null)
			.sort((a, b) => (a.closed < b.closed ? -1 : a.closed > b.closed ? 1 : a.row.id - b.row.id));

		const taken = due.slice(0, MOST_EXPIRED_A_RUN).map((one) => one.row);
		if (taken.length === 0) return { expired: 0, more: false };

		db.delete(cardAttachments)
			.where(inArray(cardAttachments.id, taken.map((row) => row.id)))
			.run();

		for (const row of taken) {
			logActivity({
				boardId: row.boardId,
				cardId: row.cardId,
				action: ACTIONS.attachmentExpired,
				detail: `Moved "${quotedName(row.originalName)}" on "${row.cardTitle}" to the trash: the card was closed more than ${days} days ago`,
				source: 'system',
				userId: null,
				userName: RETENTION_ACTOR
			});
		}
		const told = new Map<number, number>();
		for (const row of taken) told.set(row.cardId, row.boardId);
		for (const [cardId, boardId] of told) emit(boardId, 'update', { type: 'attachment', cardId });

		trashAfterCommit(taken.map((row) => ({ cardId: row.cardId, filename: row.filename })));
		return { expired: taken.length, more: due.length > taken.length };
	});

	if (result.expired > 0) {
		log.info(
			`Moved ${result.expired} image(s) of cards closed more than ${days} days ago to the trash` +
				(result.more ? `; more are due, and the next run takes up to ${MOST_EXPIRED_A_RUN} of them` : '')
		);
	}
	return result;
}
