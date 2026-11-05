import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardAttachments } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { requireCard, requireUser } from '$lib/server/route-guards';
import { attachFile } from '$lib/server/card-attachments';
import { removeUploadFile, writeUploadFile } from '$lib/server/uploads';
import { pathId } from '$lib/server/request-body';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB


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

/** POST — upload file attachment */
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
