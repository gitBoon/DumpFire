/**
 * card-attachments.ts — a file attached to a card and one deleted: the row,
 * its entry in the board's log and the live event, one function for each
 * (card 2337); and a card's files listed, and an image attached, through
 * `/api/v1` (card 2754).
 *
 * The card window's two routes, `POST /api/cards/:id/attachments` and
 * `DELETE /api/cards/:id/attachments/:attachmentId`, wrote the row and
 * nothing else: no entry, so the audit trail had no record of a file
 * attached or deleted (and any editor of a board may delete any file on
 * it), and no event, so a second person's card window kept showing a file
 * that had gone, or missed a new one, until it was opened again. These are
 * services so that the service rules (`tests/check-at-the-write.test.ts`)
 * hold these writes as they hold every other. `/api/v1` lists a card's
 * files and attaches an image (card 2754): its upload is the second tree's
 * twin of the card window's, and records the same entry and sends the same
 * event, through the one helper both call. It deletes nothing. The card
 * window's upload of an image is held to the same rules through
 * `attachImage` too (card 2761); its other files go through `attachFile`,
 * which holds a card to 20 of them beside its 20 images (card 2910, D4).
 * Names are cleaned by `attachment-names.ts` (card 2910, D11).
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
import { asc, eq } from 'drizzle-orm';
import { db } from './db';
import { cardAttachments, type Card, type CardAttachment } from './db/schema';
import type { SessionUser } from './auth';
import { cleanedName, stampOf } from './attachment-names';
import { requireCard, requireUser } from './route-guards';
import { emit } from './events';
import { imageTypeOf, type ImageType } from './image-check';
import { isExpiredCard, retentionDays } from './image-retention';
import { ACTIONS, actorOf, logActivity } from './logActivity';
import { inWrite, type ServiceOptions } from './write-as';

/** The functions here that only read. Every other export is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = ['listAttachments'];

/** The most images a card holds, whichever tree attached them (card 2754, D5 and S10). */
const MOST_IMAGES_ON_A_CARD = 20;

/** The most files that are not images a card holds, beside its images (card 2910, D4). */
const MOST_OTHER_FILES_ON_A_CARD = 20;

/** The longest name an image is given, before its extension (card 2754, D7 and S11). */
const LONGEST_IMAGE_NAME = 100;

/**
 * An attachment as `/api/v1` answers it: the row without `filename`, its
 * name in the card's folder, which is the server's own (card 2754, D9).
 */
export type AttachmentAnswer = Omit<CardAttachment, 'filename'>;

/** The row as `/api/v1` answers it. */
function answerOf(row: CardAttachment): AttachmentAnswer {
	return {
		id: row.id,
		cardId: row.cardId,
		originalName: row.originalName,
		mimeType: row.mimeType,
		sizeBytes: row.sizeBytes,
		uploadedBy: row.uploadedBy,
		createdAt: row.createdAt
	};
}

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
 * gone, or the access, while the upload was read. A card that already holds
 * `MOST_OTHER_FILES_ON_A_CARD` files whose stored type is not one of the four
 * image types is refused, 409 (card 2910, D4): counted here, in the
 * transaction that writes, as `attachImage` counts images, so that two
 * uploads cannot both find room for one; a card already over it keeps what it
 * holds. The name and the type are the route's (`attachment-names.ts`). A
 * refusal or a failure here rolls the row and the entry back, and the route
 * removes the file.
 */
export function attachFile(caller: SessionUser | null, at: { cardId: number }, file: AttachedFile, opts: ServiceOptions): CardAttachment {
	inWrite();
	const user = requireUser(caller);
	const { card, boardId } = requireCard(user, at.cardId, 'edit', opts.says);

	const others = db
		.select({ mimeType: cardAttachments.mimeType })
		.from(cardAttachments)
		.where(eq(cardAttachments.cardId, card.id))
		.all()
		.filter((row) => imageTypeOf(row.mimeType) === null).length;
	if (others >= MOST_OTHER_FILES_ON_A_CARD) throw error(409, 'This card already has 20 files other than images');

	return addAttachment(user, card, boardId, file, opts);
}

/**
 * The row of a file attached to `card`, by `user`, with its entry `Attached
 * "<file>" to "<card>"` and the live event: what both trees' uploads write,
 * once each has checked what it checks (`attachFile`, `attachImage`).
 */
function addAttachment(user: SessionUser, card: Card, boardId: number, file: AttachedFile, opts: ServiceOptions): CardAttachment {
	const attachment = db
		.insert(cardAttachments)
		.values({
			cardId: card.id,
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
		cardId: card.id,
		action: ACTIONS.attachmentAdded,
		detail: `Attached "${quotedName(file.originalName)}" to "${card.title}"`,
		source: opts.source,
		...actorOf(user)
	});
	emit(boardId, 'update', attachmentEvent(card.id));
	return attachment;
}

/**
 * Every file on a card (`GET /api/v1/cards/:cardId/attachments`), oldest
 * first and, within one second, by id; each as `/api/v1` answers it, without
 * the name in the card's folder (card 2754, D9). The card is looked for and
 * the caller asked for view access (404, then 403).
 */
export function listAttachments(user: SessionUser | null | undefined, at: { cardId: number }, opts: { says?: string }): AttachmentAnswer[] {
	requireCard(user, at.cardId, 'view', opts.says);
	return db
		.select()
		.from(cardAttachments)
		.where(eq(cardAttachments.cardId, at.cardId))
		.orderBy(asc(cardAttachments.createdAt), asc(cardAttachments.id))
		.all()
		.map(answerOf);
}

/** An image the route has checked (`checkImage`) and written into the card's folder. */
export type AttachedImage = {
	/** Its name in the card's folder: `<uuid>.<extension>`, the server's own. */
	filename: string;
	/** The name the caller asked for (`?name=`, or the card window's file name), as sent, or null for none. */
	name: string | null;
	/** The type the bytes are, as the check found it. */
	mimeType: ImageType;
	/** That type's extension, without the dot: `png`, `jpg`, `gif`, `webp`. */
	extension: string;
	/** The size written, once the metadata was taken out. */
	sizeBytes: number;
};

/**
 * The row of an image a key has uploaded (`POST /api/v1/cards/:cardId/attachments`,
 * card 2754), or the card window has (`POST /api/cards/:id/attachments`, an
 * upload declared as one of the four image types, card 2761, with the file's
 * own name as `name` and `source: 'ui'`), with the entry and the live event
 * every upload writes (`addAttachment`). The card is looked for and the caller asked for
 * edit access again (404, then 403): either may have changed while the
 * upload was read. A card closed longer than `IMAGE_RETENTION_DAYS`, whose
 * images retention moves to the trash, is refused 409 (`isExpiredCard`, S6).
 * A card that already holds `MOST_IMAGES_ON_A_CARD` images
 * is refused, 409: every image row counts, whichever tree attached it, and
 * it is counted here, in the transaction that writes, so that two uploads
 * cannot both find room for one (S10). The name is `imageName`'s. A refusal
 * or a failure here rolls the row and the entry back, and the route removes
 * the file.
 */
export function attachImage(caller: SessionUser | null, at: { cardId: number }, image: AttachedImage, opts: ServiceOptions): AttachmentAnswer {
	inWrite();
	const user = requireUser(caller);
	const { card, boardId } = requireCard(user, at.cardId, 'edit', opts.says);

	// A card retention would take the images of now (card 2754, S6): the
	// image would be moved to the trash by the next sweep. With the setting
	// refused, retention runs nothing, and nothing here is refused for it.
	const retention = retentionDays();
	if (retention.ok && isExpiredCard(card.id, new Date(), retention.days)) {
		throw error(
			409,
			`This card was closed more than ${retention.days} days ago, so its images are moved to the trash: reopen or restore it to attach one`
		);
	}

	const images = db
		.select({ mimeType: cardAttachments.mimeType })
		.from(cardAttachments)
		.where(eq(cardAttachments.cardId, card.id))
		.all()
		.filter((row) => imageTypeOf(row.mimeType) !== null).length;
	if (images >= MOST_IMAGES_ON_A_CARD) throw error(409, 'This card already has 20 images');

	const attachment = addAttachment(
		user,
		card,
		boardId,
		{ filename: image.filename, originalName: imageName(image.name, image.extension, new Date()), mimeType: image.mimeType, sizeBytes: image.sizeBytes },
		opts
	);
	return answerOf(attachment);
}

/**
 * The name an uploaded image is given (card 2754, D7 and S11): the caller's,
 * cleaned, or `image-<UTC date>-<time>.<extension>` where it leaves nothing.
 * Only its last part after a `/` or `\` is kept; control and format
 * characters, line and paragraph separators (since card 2910, S6) and
 * `<>:"|?*` are taken out, and the ends trimmed (`cleanedName`); it is cut to
 * `LONGEST_IMAGE_NAME` characters, and then an extension left at its end (a
 * dot and one to five letters or digits) is taken off and the one the bytes
 * are put on, so the extension always survives the cut. A dot that starts
 * no such extension stays: `Fig. 3 login page` is `Fig. 3 login page.png`,
 * and `v1.2 release notes` is `v1.2 release notes.png`. The name is shown
 * and given back as the download's name; the file on disk is named by the
 * server.
 */
function imageName(asked: string | null, extension: string, now: Date): string {
	const cleaned = cleanedName(asked ?? '');
	const cut = Array.from(cleaned).slice(0, LONGEST_IMAGE_NAME).join('');
	const stem = cut.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[.\s]+$/, '').trim();
	if (stem !== '') return `${stem}.${extension}`;
	return `image-${stampOf(now)}.${extension}`;
}

/**
 * Delete a file's row (`DELETE /api/cards/:id/attachments/:attachmentId`),
 * with its entry `Deleted the file "<file>" from "<card>"` and the live
 * event. The card the path names, `at.cardId`, is asked first (card 2762): one
 * that is not there or that the caller cannot open is `404 Card not found`,
 * whatever attachment id follows it (card 2719). Then the attachment is looked
 * for on that card (404 for one that is not there or is on another card, card
 * 2361: the card in the path was never read), and only then is the caller
 * asked for edit access to it (403). The attachment was looked for first, so
 * the ids on a card the caller could not open could be told apart. Its
 * uploader is not named: the upload's own entry says who attached it. The row
 * deleted is handed back, for the route to move its file to the trash once
 * this is committed.
 */
export function deleteAttachment(
	caller: SessionUser | null,
	at: { cardId: number; attachmentId: number },
	body: null,
	opts: ServiceOptions
): CardAttachment {
	inWrite();
	const user = requireUser(caller);
	requireCard(user, at.cardId, 'view');
	const attachment = db.select().from(cardAttachments).where(eq(cardAttachments.id, at.attachmentId)).get();
	if (!attachment || attachment.cardId !== at.cardId) throw error(404, 'Attachment not found');
	const { card, boardId } = requireCard(user, at.cardId, 'edit', opts.says);

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
