import { error, isHttpError, type HttpError } from '@sveltejs/kit';
import { randomUUID } from 'crypto';
import { json } from '$lib/server/v1-json';
import { BodyReadTimedOut, bytesCounted, readBodyWithin } from '$lib/server/body-limits';
import { attachImage, listAttachments } from '$lib/server/card-attachments';
import { checkImage, imageTypeOf } from '$lib/server/image-check';
import { pathId } from '$lib/server/request-body';
import { requireCard, requireUser } from '$lib/server/route-guards';
import {
	takeUploadBytes,
	takeUploadCount,
	takeUploadPlace,
	UPLOAD_READ_DEADLINE_MS,
	UploadAllowanceRefused
} from '$lib/server/upload-allowance';
import { removeUploadFile, writeUploadFile } from '$lib/server/uploads';
import { refuseWhenFull, requireUploadRoom, UploadSpaceRefused } from '$lib/server/upload-space';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/cards/:cardId/attachments — Every file on a card, oldest first
 * and, within one second, by id, without its name in the card's folder (card
 * 2754, D9). View access, as the card window's list asks. The work is
 * `listAttachments` in `$lib/server/card-attachments`.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.cardId, 'card');
	return json(listAttachments(locals.user, { cardId }, {}));
};

/**
 * A refused allowance, answered as the gate answers its own 429: the wait in
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
 * card window's words. Before the body is read it closes the connection, as
 * every refusal before the body does.
 */
function noRoom(refused: UploadSpaceRefused, opts: { beforeBody?: boolean } = {}): Response {
	return json({ message: refused.message }, { status: 507, headers: opts.beforeBody ? { Connection: 'close' } : {} });
}

/**
 * POST /api/v1/cards/:cardId/attachments?name=<name> — Attach an image to a
 * card (card 2754). The body is the image itself, sent as `image/png`,
 * `image/jpeg`, `image/gif` or `image/webp`: no form, so that a client that
 * cannot send one (PowerShell 5.1) can, and no JSON, which would be a third
 * larger. Held to 5 MB by the gate (`body-limits.ts`), in chunks or not.
 *
 * Like the card window's upload, it asks before it reads the body, so that
 * a caller who would be refused is not sent 5 MB first, and asks again at the
 * write (docs/authentication-security.md, "API Keys and Card Images (Card
 * 2754)"). In order:
 *
 *   1. the card (404) and edit access to its board (403);
 *   2. the declared type, one of the four (415): nothing is read; then the
 *      uploads volume's free space (507, card 2920: too little, or it cannot
 *      be read), with nothing taken or counted. Every refusal before the body
 *      is read, these and 3 and 4, closes the connection (card 2910's code
 *      review, CS3);
 *   3. a place in flight, the key's user's (3) and then the server's (6),
 *      shared with the card window (429, `Retry-After: 5`, `Connection:
 *      close`): nothing is read or counted (card 2910, D6). The `try` whose
 *      `finally` gives it back opens on the next line, and that `finally` is
 *      the only release (the review's S1);
 *   4. the upload count, 30 an hour for the key's user, every file the user
 *      uploads either way counted (429 with `Retry-After` and `Connection:
 *      close`): nothing is read;
 *   5. the body read, given 120 seconds to arrive (408, `Connection: close`,
 *      CS2), and 413 past 5 MB from the gate's count. A read that fails, for
 *      any of these or because the caller went away, is charged what the
 *      gate counted to the day before its failure is answered (CS1);
 *   6. the bytes read charged to the day's 100 MB for the key's user (429),
 *      in a writeAs, which asks again whether the key is still open (401).
 *      Charged before the check, so a body the check refuses still costs
 *      what was sent;
 *   7. the bytes checked and their metadata taken out (`checkImage`): not
 *      the declared type 415, not a valid image of it 400;
 *   8. the file written as `<uuid>.<extension>`, and its row written by
 *      `attachImage` in a writeAs that asks for the key again (401), the card
 *      and the access again (404, 403), and room for one more image (409).
 *
 * A refusal at 8 removes the file, and the card's folder if this upload made
 * it; a write at 8 that runs out of space is removed by the write and
 * answered 507, the words of 2 (card 2920). An allowance taken at 4 or 6
 * stays taken whatever is refused after it;
 * the place of 3 is given back however the upload ends.
 */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	// Whether the body has begun to be read: every refusal before it closes the
	// connection (card 2910's code review, CS3).
	let reading = false;
	try {
		requireUser(locals.user);

		const cardId = pathId(params.cardId, 'card');
		requireCard(locals.user, cardId, 'edit');
		const declared = imageTypeOf(request.headers.get('content-type'));
		if (declared === null) {
			throw error(415, 'Send the image as the body, with Content-Type image/png, image/jpeg, image/gif or image/webp');
		}
		// Room on the uploads volume, before anything is taken or read (card 2920).
		await requireUploadRoom();

		const release = takeUploadPlace(locals.user);
		try {
			takeUploadCount(locals.user);

			reading = true;
			let bytes: Uint8Array;
			try {
				// Given UPLOAD_READ_DEADLINE_MS to arrive (CS2).
				bytes = new Uint8Array(await readBodyWithin(request, UPLOAD_READ_DEADLINE_MS, () => request.arrayBuffer()));
			} catch (failed) {
				// A read that failed, was cut off or ran out of time still cost what
				// it read: the gate's count is charged to the day (CS1), unless the
				// key ended or the day is spent, and the read's own failure is the
				// answer.
				const counted = bytesCounted(request);
				if (counted) {
					try {
						writeAs(locals, (caller) => takeUploadBytes(caller, counted));
					} catch {
						// Nothing charged: the answer is the read's.
					}
				}
				// The words written out, as the document quotes them: UPLOAD_READ_DEADLINE_MS is 120 seconds.
				if (failed instanceof BodyReadTimedOut) {
					return json({ message: 'The upload did not arrive within 120 seconds. Nothing was written.' }, { status: 408, headers: { Connection: 'close' } });
				}
				throw failed;
			}
			// Charged with every byte read, before the check: a body refused 415 or
			// 400 below was still sent, and a body the check strips is charged its
			// size as sent, not as kept. The body is the image: what was read.
			try {
				writeAs(locals, (caller) => takeUploadBytes(caller, bytes.byteLength));
			} catch (refused) {
				if (refused instanceof UploadAllowanceRefused) return tooMany(refused);
				throw refused;
			}
			const checked = checkImage(bytes, declared);
			if (!checked.ok) throw checked.status === 415 ? error(415, checked.message) : error(400, checked.message);

			const name = url.searchParams.get('name');
			const filename = `${randomUUID()}.${checked.extension}`;
			// A disk that filled while the body was read is answered 507 (card 2920).
			const written = await writeUploadFile(cardId, filename, checked.bytes).catch(refuseWhenFull);
			try {
				const attachment = writeAs(locals, (caller) =>
					attachImage(
						caller,
						{ cardId },
						{ filename, name, mimeType: checked.mimeType, extension: checked.extension, sizeBytes: checked.bytes.byteLength },
						{ source: 'api' }
					)
				);
				return json(attachment, { status: 201 });
			} catch (err) {
				await removeUploadFile(written);
				throw err;
			}
		} finally {
			release();
		}
	} catch (refused) {
		// Every refusal before the body is read closes the connection: the key's
		// user, the id, the card, the type, the space (card 2920), the place and
		// the hour (CS3). The day's is answered above, after the read, and so is
		// a write that ran out of space; anything else after it is thrown on.
		if (!reading) {
			if (refused instanceof UploadAllowanceRefused) return tooMany(refused, { beforeBody: true });
			if (refused instanceof UploadSpaceRefused) return noRoom(refused, { beforeBody: true });
			if (isHttpError(refused)) return closing(refused);
		}
		if (refused instanceof UploadSpaceRefused) return noRoom(refused);
		throw refused;
	}
};

/**
 * A guard's refusal before the body is read, answered as it was thrown and
 * with `Connection: close` (card 2910's code review, CS3). Each status is
 * written out, so that tests/openapi-document.test.ts reads what this
 * operation can answer: the key's user (401), the id (400), the card (404),
 * its access (403) and the type (415). Any other is thrown on.
 */
function closing(refused: HttpError): Response {
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
		case 415:
			return json({ message }, { status: 415, headers });
		default:
			throw refused;
	}
}
