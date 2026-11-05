import { error } from '@sveltejs/kit';
import { randomUUID } from 'crypto';
import { json } from '$lib/server/v1-json';
import { attachImage, listAttachments } from '$lib/server/card-attachments';
import { checkImage, imageTypeOf } from '$lib/server/image-check';
import { pathId } from '$lib/server/request-body';
import { requireCard, requireUser } from '$lib/server/route-guards';
import { takeUploadBytes, takeUploadCount, UploadAllowanceRefused } from '$lib/server/upload-allowance';
import { removeUploadFile, writeUploadFile } from '$lib/server/uploads';
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

/** A refused allowance, answered as the gate answers its own 429: the wait in the body and in `Retry-After`. */
function tooMany(refused: UploadAllowanceRefused): Response {
	return json(
		{ message: refused.message, retryAfterSecs: refused.retryAfterSecs },
		{ status: 429, headers: { 'Retry-After': String(refused.retryAfterSecs) } }
	);
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
 *   2. the declared type, one of the four (415): nothing is read;
 *   3. the upload count, 30 an hour for the key's user (429 with
 *      `Retry-After`): nothing is read;
 *   4. the body read (413 past 5 MB, from the gate's count): nothing is
 *      charged;
 *   5. the bytes read charged to the day's 100 MB for the key's user (429),
 *      in a writeAs, which asks again whether the key is still open (401).
 *      Charged before the check, so a body the check refuses still costs
 *      what was sent;
 *   6. the bytes checked and their metadata taken out (`checkImage`): not
 *      the declared type 415, not a valid image of it 400;
 *   7. the file written as `<uuid>.<extension>`, and its row written by
 *      `attachImage` in a writeAs that asks for the key again (401), the card
 *      and the access again (404, 403), and room for one more image (409).
 *
 * A refusal at 7 removes the file, and the card's folder if this upload made
 * it. An allowance taken at 3 or 5 stays taken whatever is refused after it.
 */
export const POST: RequestHandler = async ({ params, request, locals, url }) => {
	requireUser(locals.user);

	const cardId = pathId(params.cardId, 'card');
	requireCard(locals.user, cardId, 'edit');
	const declared = imageTypeOf(request.headers.get('content-type'));
	if (declared === null) {
		throw error(415, 'Send the image as the body, with Content-Type image/png, image/jpeg, image/gif or image/webp');
	}
	try {
		takeUploadCount(locals.user);
	} catch (refused) {
		if (refused instanceof UploadAllowanceRefused) return tooMany(refused);
		throw refused;
	}

	const bytes = new Uint8Array(await request.arrayBuffer());
	// Charged with every byte read, before the check: a body refused 415 or
	// 400 below was still sent, and a body the check strips is charged its
	// size as sent, not as kept.
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
	const written = await writeUploadFile(cardId, filename, checked.bytes);
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
};
