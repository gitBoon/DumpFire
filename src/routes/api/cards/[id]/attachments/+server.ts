import { json, error, isHttpError } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardAttachments } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { requireCard, requireUser } from '$lib/server/route-guards';
import { attachFile, attachImage } from '$lib/server/card-attachments';
import { fileName, storedType } from '$lib/server/attachment-names';
import { checkImage, imageTypeOf } from '$lib/server/image-check';
import { BodyReadTimedOut, bytesCounted, bytesRead, readBodyWithin } from '$lib/server/body-limits';
import {
	takeUploadBytes,
	takeUploadCount,
	takeUploadPlace,
	UPLOAD_READ_DEADLINE_MS,
	UploadAllowanceRefused
} from '$lib/server/upload-allowance';
import { removeUploadFile, writeUploadFile } from '$lib/server/uploads';
import { refuseWhenFull, requireUploadRoom, UploadSpaceRefused } from '$lib/server/upload-space';
import { pathId } from '$lib/server/request-body';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * The card window's files: listed, and uploaded as a form.
 *
 * Every upload, image or not, takes a place in flight (3 an account, 6 the
 * server) and is counted against the account's 30 uploads an hour before its
 * form is read, and charged what was read against its 100 MB a day, all shared
 * with `/api/v1` (`upload-allowance.ts`, card 2910). An upload whose declared
 * type is one of the four image types (PNG, JPEG, GIF, WebP) is then held to
 * the rules a key's image upload is held to (card 2761): the bytes checked and
 * their metadata taken out (`checkImage`), 20 images a card and no image for a
 * card whose images retention is taking (`attachImage`). Every other file has
 * its bytes stored as sent, its name cleaned and cut, its type normalised
 * (`attachment-names.ts`), its name on disk `<uuid>` alone, 20 of them a card
 * (`attachFile`, card 2910); it is only ever served as a download unless its
 * bytes are the image its type names (card 2754). Before any of it, an upload
 * is refused 507 when the uploads volume has too little free space, or its
 * free space cannot be read, and so is a write that runs out of space
 * (`upload-space.ts`, card 2920).
 */

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

/**
 * A refused allowance, answered as `/api/v1`'s upload answers it: the wait in
 * the body and in `Retry-After`. A refusal before the body is read closes the
 * connection (`beforeBody`, card 2910, the review's S7), so that the body it
 * did not read is not drained into a connection kept alive.
 */
function tooMany(refused: UploadAllowanceRefused, opts: { beforeBody?: boolean } = {}): Response {
	const headers: Record<string, string> = { 'Retry-After': String(refused.retryAfterSecs) };
	if (opts.beforeBody) headers.Connection = 'close';
	return json({ message: refused.message, retryAfterSecs: refused.retryAfterSecs }, { status: 429, headers });
}

/**
 * A refusal for want of space on the uploads volume (card 2920): 507, the
 * same words on both routes. Before the form is read it closes the connection,
 * as every refusal before the body does.
 */
function noRoom(refused: UploadSpaceRefused, opts: { beforeBody?: boolean } = {}): Response {
	return json({ message: refused.message }, { status: 507, headers: opts.beforeBody ? { Connection: 'close' } : {} });
}

/**
 * A refusal made before the form is read, answered with `Connection: close`
 * (card 2910's code review, CS3): an allowance's 429, the 507 for space (card
 * 2920), and the 401, 400, 404 and 403 of the session, the card's id, the card
 * and its access. Anything else is thrown on.
 */
function refusedBeforeBody(refused: unknown): Response {
	if (refused instanceof UploadAllowanceRefused) return tooMany(refused, { beforeBody: true });
	if (refused instanceof UploadSpaceRefused) return noRoom(refused, { beforeBody: true });
	if (!isHttpError(refused)) throw refused;
	// Each status written out, so that tests/error-shape.test.ts can read every answer's shape.
	const headers = { Connection: 'close' };
	const message = refused.body.message;
	switch (refused.status) {
		case 400:
			return json({ message }, { status: 400, headers });
		case 401:
			return json({ message }, { status: 401, headers });
		case 403:
			return json({ message }, { status: 403, headers });
		case 404:
			return json({ message }, { status: 404, headers });
		default:
			throw refused;
	}
}

/** A form that did not arrive within its deadline (CS2): 408, the connection closed. */
function timedOut(late: BodyReadTimedOut): Response {
	return json({ message: late.message }, { status: 408, headers: { Connection: 'close' } });
}

/**
 * The bytes of a form's parts, every one of them: what is charged for a form
 * whose request neither declared its length nor was counted by the gate
 * (`bytesRead` null), which only a test that calls the handler itself sends.
 */
function partsLength(form: FormData): number {
	let parts = 0;
	for (const [, value] of form) parts += typeof value === 'string' ? Buffer.byteLength(value) : value.size;
	return parts;
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
 * POST — upload a file attachment, as a form. In order (card 2910, D5):
 *
 *   1. the session (401), the card's id (400), the card (404) and edit
 *      access (403), before the form is read; then the uploads volume's free
 *      space (507, card 2920: too little, or it cannot be read), with nothing
 *      taken or counted. Every refusal before the form is read, these and 2
 *      and 3, closes the connection (card 2910's code review, CS3);
 *   2. a place in flight, the account's (3) and then the server's (6), taken
 *      before the form is read (429, `Retry-After: 5`, `Connection: close`):
 *      nothing read, nothing counted. The `try` whose `finally` gives it
 *      back opens on the next line, and that `finally` is the only release
 *      (the review's S1);
 *   3. the upload counted against the account's hour (429 with
 *      `Retry-After` and `Connection: close`), before the form is read, for
 *      every file, as `/api/v1` counts it (closing card 2761's S13);
 *   4. the form read, given 120 seconds to arrive (408, `Connection:
 *      close`, CS2), and 413 from the gate's count past 26 MB. A read that
 *      fails, for any of these or because the caller went away, is charged
 *      what the gate counted to the day before its failure is answered (CS1);
 *   5. in one writeAs, which asks for the session again (401, nothing
 *      charged): what was read charged to the account's day (429), before
 *      anything in the form is checked (S4);
 *   6. the form: exactly one part, a file named `file`, else 400 (S4); over
 *      25 MB 400;
 *   7. an image, by its declared type (card 2761, D2): the bytes checked and
 *      their metadata taken out (`checkImage`): not the declared type 415,
 *      not a valid image of it 400; the file written as
 *      `<uuid>.<extension>`, and its row written by `attachImage` in a
 *      writeAs that asks for the session, the card and the access again
 *      (401, 404, 403), refuses a card closed longer than
 *      IMAGE_RETENTION_DAYS (409) and a card with 20 images (409);
 *   8. any other file: its name cleaned and cut to 100 characters, its
 *      extension kept as sent (`fileName`), its type a plain one or
 *      application/octet-stream (`storedType`); written as `<uuid>`, and its
 *      row written by `attachFile` in a writeAs that asks for the session,
 *      the card and the access again (401, 404, 403) and refuses a card with
 *      20 files other than images (409).
 *
 * A refusal at the row's write removes the file, and the card's folder if
 * this upload made it. A file whose write runs out of space is removed by the
 * write and answered 507, the words of 1 (card 2920). What 3 and 5 took stays
 * taken whatever is refused after it; the place of 2 is given back however
 * the upload ends.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	// Whether the form has begun to be read: every refusal before it closes the
	// connection (card 2910's code review, CS3).
	let reading = false;
	try {
		requireUser(locals.user);

		const cardId = pathId(params.id, 'card');
		// Before the upload is read, so that a caller with no access is not sent
		// 25 MB first. It is asked again below, with the row.
		requireCard(locals.user, cardId, 'edit');
		// Room on the uploads volume, before anything is taken or read (card 2920).
		await requireUploadRoom();

		const release = takeUploadPlace(locals.user);
		try {
			takeUploadCount(locals.user);

			reading = true;
			let formData: FormData;
			try {
				// Given UPLOAD_READ_DEADLINE_MS to arrive (CS2).
				formData = await readBodyWithin(request, UPLOAD_READ_DEADLINE_MS, () => request.formData());
			} catch (failed) {
				// A read that failed, was cut off or ran out of time still cost what
				// it read: the gate's count is charged to the day (CS1), unless the
				// session ended or the day is spent, and the read's own failure is
				// the answer.
				const counted = bytesCounted(request);
				if (counted) {
					try {
						writeAs(locals, (caller) => takeUploadBytes(caller, counted));
					} catch {
						// Nothing charged: the answer is the read's.
					}
				}
				if (failed instanceof BodyReadTimedOut) return timedOut(failed);
				throw failed;
			}

			// Charged with what was read, before anything in it is checked: a form
			// the checks below refuse was still sent (S4).
			const read = bytesRead(request) ?? partsLength(formData);
			try {
				writeAs(locals, (caller) => takeUploadBytes(caller, read));
			} catch (refused) {
				if (refused instanceof UploadAllowanceRefused) return tooMany(refused);
				throw refused;
			}

			// One part, the file, and nothing else: a part the upload does not keep would be read for nothing.
			const parts = [...formData.entries()];
			const file = parts.length === 1 && parts[0][0] === 'file' ? parts[0][1] : null;
			if (!(file instanceof File)) throw error(400, 'Send one file, as the only part of the form, named "file"');
			if (file.size > MAX_FILE_SIZE) throw error(400, 'File too large (max 25MB)');

			const bytes = new Uint8Array(await file.arrayBuffer());

			// One of the four image types, as the browser declared it: the image path.
			// Anything else, an image's bytes declared as another type among them, has
			// its bytes stored as sent, its name cleaned and its type normalised (card
			// 2910), and is only ever served as a download (card 2761, D1).
			const declared = imageTypeOf(file.type);
			if (declared !== null) {
				const checked = checkImage(bytes, declared);
				if (!checked.ok) throw checked.status === 415 ? error(415, checked.message) : error(400, checked.message);

				const filename = `${randomUUID()}.${checked.extension}`;
				const written = await writeUploadFile(cardId, filename, checked.bytes).catch(refuseWhenFull);
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

			// Its name cleaned and cut, its extension kept as sent, its type a plain
			// one or application/octet-stream (card 2910, D11 and D12); on disk the
			// server's own name, `<uuid>` and nothing of the uploader's (S5).
			const { name } = fileName(file.name, new Date());
			const type = storedType(file.type);
			const filename = randomUUID();

			// The file first, and then its row (`writeUploadFile`, which removes what
			// it wrote if the write fails). A row is never left naming a file that was
			// not written; and if the row cannot be written, because the card was
			// deleted while the upload was being read or for any other reason, the
			// file is removed again, and the folder if this request made it.
			// A disk that filled while the form was read is answered 507 (card 2920).
			const written = await writeUploadFile(cardId, filename, bytes).catch(refuseWhenFull);
			try {
				// The card may have gone, or the caller's access to it, since the check
				// above: the body was awaited in between. So may their session: it is
				// asked again, and who its account is now (card 2253). The row, its
				// entry and the live event are the service's (card 2337), and so is the
				// card's room for one more file (409, card 2910). A refusal removes the
				// file, as the catch below does for any.
				const attachment = writeAs(locals, (caller) =>
					attachFile(
						caller,
						{ cardId },
						{ filename, originalName: name, mimeType: type, sizeBytes: bytes.byteLength },
						{ source: 'ui' }
					)
				);

				return json(attachment);
			} catch (err) {
				await removeUploadFile(written);
				throw err;
			}
		} finally {
			release();
		}
	} catch (refused) {
		// Every refusal before the form is read closes the connection: the
		// session, the id, the card, the place and the hour (CS3). The day's is
		// answered above, after the read, and so is a write that ran out of
		// space (card 2920); anything else after it is thrown on.
		if (!reading) return refusedBeforeBody(refused);
		if (refused instanceof UploadSpaceRefused) return noRoom(refused);
		throw refused;
	}
};
