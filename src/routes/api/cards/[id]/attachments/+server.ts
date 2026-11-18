import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardAttachments } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { requireCard, requireUser } from '$lib/server/route-guards';
import { attachFile, attachImage } from '$lib/server/card-attachments';
import { checkImage, imageTypeOf } from '$lib/server/image-check';
import { takeUploadBytes, takeUploadCount, UploadAllowanceRefused } from '$lib/server/upload-allowance';
import { removeUploadFile, writeUploadFile } from '$lib/server/uploads';
import { pathId } from '$lib/server/request-body';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * The card window's files: listed, and uploaded as a form.
 *
 * An upload whose declared type is one of the four image types (PNG, JPEG,
 * GIF, WebP) is held to the rules a key's image upload is held to (card
 * 2761): the bytes checked and their metadata taken out (`checkImage`), 20
 * images a card and no image for a card whose images retention is taking
 * (`attachImage`), and the account's 30 uploads an hour and 100 MB a day,
 * shared with `/api/v1` (`upload-allowance.ts`). Every other file is stored
 * as sent, as before, and only ever served as a download unless its bytes
 * are the image its type names (card 2754).
 */

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

/** A refused allowance, answered as `/api/v1`'s upload answers it: the wait in the body and in `Retry-After`. */
function tooMany(refused: UploadAllowanceRefused): Response {
	return json(
		{ message: refused.message, retryAfterSecs: refused.retryAfterSecs },
		{ status: 429, headers: { 'Retry-After': String(refused.retryAfterSecs) } }
	);
}


/** GET — list attachments for a card */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.id, 'card');
	requireCard(locals.user, cardId, 'view');


	const attachments = db.select().from(cardAttachments)
		.where(eq(cardAttachments.cardId, cardId))
		.all();
	return json(attachments);
};

/**
 * POST — upload a file attachment, as a form.
 *
 * An image, by its declared type (card 2761, D2), in order:
 *
 *   1. the card (404) and edit access (403), before the form is read;
 *   2. the form read: no file 400, over 25 MB 400;
 *   3. in one writeAs, which asks for the session again (401, nothing
 *      taken): the upload counted against the account's hour, then the bytes
 *      read charged to its day (429 with `Retry-After`), both shared with
 *      `/api/v1`. Taken after the form is read, as the type is inside it
 *      (S13; counting before the body for every upload is card 2910);
 *   4. the bytes checked and their metadata taken out (`checkImage`): not
 *      the declared type 415, not a valid image of it 400;
 *   5. the file written as `<uuid>.<extension>`, and its row written by
 *      `attachImage` in a writeAs that asks for the session, the card and
 *      the access again (401, 404, 403), refuses a card closed longer than
 *      IMAGE_RETENTION_DAYS (409) and a card with 20 images (409).
 *
 * A refusal at 5 removes the file, and the card's folder if this upload made
 * it. What 3 took stays taken whatever is refused after it.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	requireUser(locals.user);

	const cardId = pathId(params.id, 'card');
	// Before the upload is read, so that a caller with no access is not sent
	// 25 MB first. It is asked again below, with the row.
	requireCard(locals.user, cardId, 'edit');


	const formData = await request.formData();
	const file = formData.get('file') as File | null;
	if (!file || !(file instanceof File)) throw error(400, 'No file provided');
	if (file.size > MAX_FILE_SIZE) throw error(400, 'File too large (max 25MB)');

	// One of the four image types, as the browser declared it: the image path.
	// Anything else, an image's bytes declared as another type among them, is
	// stored as sent and only ever served as a download (D1).
	const declared = imageTypeOf(file.type);
	if (declared !== null) {
		const bytes = new Uint8Array(await file.arrayBuffer());
		// Counted and charged before the check: an image the check refuses was
		// still sent. The count stays taken when the bytes are refused.
		try {
			writeAs(locals, (caller) => {
				takeUploadCount(caller, { afterRead: true });
				takeUploadBytes(caller, bytes.byteLength);
			});
		} catch (refused) {
			if (refused instanceof UploadAllowanceRefused) return tooMany(refused);
			throw refused;
		}
		const checked = checkImage(bytes, declared);
		if (!checked.ok) throw checked.status === 415 ? error(415, checked.message) : error(400, checked.message);

		const filename = `${randomUUID()}.${checked.extension}`;
		const written = await writeUploadFile(cardId, filename, checked.bytes);
		try {
			const attachment = writeAs(locals, (caller) =>
				attachImage(
					caller,
					{ cardId },
					{ filename, name: file.name, mimeType: checked.mimeType, extension: checked.extension, sizeBytes: checked.bytes.byteLength },
					{ source: 'ui' }
				)
			);
			return json(attachment);
		} catch (err) {
			await removeUploadFile(written);
			throw err;
		}
	}

	const uuid = randomUUID();
	const safeOriginalName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
	const filename = `${uuid}-${safeOriginalName}`;
	const buffer = Buffer.from(await file.arrayBuffer());

	// The file first, and then its row (`writeUploadFile`, which removes what
	// it wrote if the write fails). A row is never left naming a file that was
	// not written; and if the row cannot be written, because the card was
	// deleted while the upload was being read or for any other reason, the
	// file is removed again, and the folder if this request made it.
	const written = await writeUploadFile(cardId, filename, buffer);
	try {
		// The card may have gone, or the caller's access to it, since the check
		// above: the body was awaited in between. So may their session: it is
		// asked again, and who its account is now (card 2253). The row, its
		// entry and the live event are the service's (card 2337). A refusal
		// removes the file, as the catch below does for any.
		const attachment = writeAs(locals, (caller) =>
			attachFile(
				caller,
				{ cardId },
				{ filename, originalName: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size },
				{ source: 'ui' }
			)
		);

		return json(attachment);
	} catch (err) {
		await removeUploadFile(written);
		throw err;
	}
};
