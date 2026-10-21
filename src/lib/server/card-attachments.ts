/**
 * card-attachments.ts — a file attached to a card and one deleted: the row,
 * its entry in the board's log and the live event, one function for each
 * (card 2337).
 *
 * The card window's two routes, `POST /api/cards/:id/attachments` and
 * `DELETE /api/cards/:id/attachments/:attachmentId`, wrote the row and
 * nothing else: no entry, so the audit trail had no record of a file
 * attached or deleted (and any editor of a board may delete any file on
 * it), and no event, so a second person's card window kept showing a file
 * that had gone, or missed a new one, until it was opened again. `/api/v1`
 * serves no attachments, so there is no second tree: these are services so
 * that the service rules (`tests/check-at-the-write.test.ts`) hold these
 * writes as they hold every other.
 *
 * The file itself is the routes' (written before the row, moved to the
 * trash after the delete commits): nothing here touches the disk.
 *
 * Each write has the one shape of a service (`ServiceOptions` in
 * `write-as.ts`): `inWrite()` first, then `requireUser(caller)` (401), then
 * the guard (404, then 403). The entry and the event wait for the commit, as
 * every entry's and event's does. Neither entry sends a webhook: neither
 * action is in `ACTION_TO_EVENT`, and a receiver could not fetch the file.
 */
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { cardAttachments, type CardAttachment } from './db/schema';
import type { SessionUser } from './auth';
import { requireCard, requireUser } from './route-guards';
import { emit } from './events';
import { ACTIONS, actorOf, logActivity } from './logActivity';
import { inWrite, type ServiceOptions } from './write-as';

/** The functions here that only read: none. Every export is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = [];

/**
 * The live update a change to a card's files sends its board: the card
 * named, so that a card window open on it re-reads its files and no other
 * window does (`attachmentsChanged` in `$lib/board/sse`), as a comment's
 * does for comments (card 2282). Every page re-reads on any update that is
 * not `access`, as for any other.
 */
function attachmentEvent(cardId: number): { type: 'attachment'; cardId: number } {
	return { type: 'attachment', cardId };
}

/**
 * A file's name as an entry quotes it: the uploader's own, without its Unicode
 * format characters (category Cf: a right-to-left override, a zero-width
 * space), which could reorder or hide part of the entry's line where it is
 * shown (the card 2337 review). The row keeps the name as uploaded.
 */
function quotedName(name: string): string {
	return name.replace(/\p{Cf}/gu, '');
}

/** The file the route has written into the card's folder, as its row records it. */
export type AttachedFile = {
	/** Its name in the card's folder. */
	filename: string;
	/** The uploader's own name for it, which the entry quotes. */
	originalName: string;
	mimeType: string;
	sizeBytes: number;
};

/**
 * The row of a file the route has written into the card's folder (`POST
 * /api/cards/:id/attachments`), uploaded by the caller, with its entry
 * `Attached "<file>" to "<card>"` and the live event. The card is looked for
 * and the caller asked for edit access again (404, then 403): it may have
 * gone, or the access, while the upload was read. A refusal or a failure
 * here rolls the row and the entry back, and the route removes the file.
 */
export function attachFile(caller: SessionUser | null, at: { cardId: number }, file: AttachedFile, opts: ServiceOptions): CardAttachment {
	inWrite();
	const user = requireUser(caller);
	const { cardId } = at;
	const { card, boardId } = requireCard(user, cardId, 'edit', opts.says);

	const attachment = db
		.insert(cardAttachments)
		.values({
			cardId,
			filename: file.filename,
			originalName: file.originalName,
			mimeType: file.mimeType,
			sizeBytes: file.sizeBytes,
			uploadedBy: user.id
		})
		.returning()
		.get();

	logActivity({
		boardId,
		cardId,
		action: ACTIONS.attachmentAdded,
		detail: `Attached "${quotedName(file.originalName)}" to "${card.title}"`,
		source: opts.source,
		...actorOf(user)
	});
	emit(boardId, 'update', attachmentEvent(cardId));
	return attachment;
}

/**
 * Delete a file's row (`DELETE /api/cards/:id/attachments/:attachmentId`),
 * with its entry `Deleted the file "<file>" from "<card>"` and the live
 * event. The attachment is looked for on the card the path names, `at.cardId`
 * (404 for one that is not there or is on another card, card 2361: the card in
 * the path was never read), and the caller asked for edit access to that card
 * (403). Its uploader is not named: the upload's own entry says who attached
 * it. The row deleted is handed back, for the route to move its file to the
 * trash once this is committed.
 */
export function deleteAttachment(
	caller: SessionUser | null,
	at: { cardId: number; attachmentId: number },
	body: null,
	opts: ServiceOptions
): CardAttachment {
	inWrite();
	const user = requireUser(caller);
	const attachment = db.select().from(cardAttachments).where(eq(cardAttachments.id, at.attachmentId)).get();
	if (!attachment || attachment.cardId !== at.cardId) throw error(404, 'Attachment not found');
	const { card, boardId } = requireCard(user, attachment.cardId, 'edit', opts.says);

	db.delete(cardAttachments).where(eq(cardAttachments.id, at.attachmentId)).run();

	logActivity({
		boardId,
		cardId: attachment.cardId,
		action: ACTIONS.attachmentDeleted,
		detail: `Deleted the file "${quotedName(attachment.originalName)}" from "${card.title}"`,
		source: opts.source,
		...actorOf(user)
	});
	emit(boardId, 'update', attachmentEvent(attachment.cardId));
	return attachment;
}
