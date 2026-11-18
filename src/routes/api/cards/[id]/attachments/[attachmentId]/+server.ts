import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardAttachments } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { readFile } from 'fs/promises';
import { requireCard, requireUser } from '$lib/server/route-guards';
import { deleteAttachment } from '$lib/server/card-attachments';
import { trashAfterCommit } from '$lib/server/deletes';
import { attachmentHeaders, attachmentPath } from '$lib/server/uploads';
import { pathId } from '$lib/server/request-body';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';


/**
 * GET — download/serve a file. The card the path names is asked first (card
 * 2762): one that is not there, or that the caller cannot open, is `404 Card
 * not found` whatever attachment id follows it (card 2719's words). Then the
 * file has to be on that card: one that is not is answered as one that is not
 * there (card 2361; the card in the path was never read, so a file was served
 * under the address of any card). It was looked up before the card, so the
 * ids on a card the caller could not open could be told apart.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.id, 'card');
	const attachmentId = pathId(params.attachmentId, 'attachment');
	requireCard(locals.user, cardId, 'view');

	const attachment = db.select().from(cardAttachments)
		.where(eq(cardAttachments.id, attachmentId))
		.get();
	if (!attachment || attachment.cardId !== cardId) throw error(404, 'Attachment not found');

	let filePath: string;
	try {
		// A stored name that is not a file in the card's own folder is refused
		// here, and answered like a file that is not there.
		filePath = attachmentPath(attachment.cardId, attachment.filename);
	} catch {
		throw error(404, 'File not found on disk');
	}
	const data = await readFile(filePath).catch(() => null);
	if (!data) throw error(404, 'File not found on disk');

	// A download unless it is one of a few types that can run nothing, an image
	// only when its bytes are that image, and sandboxed either way. See
	// attachmentHeaders.
	return new Response(data, {
		headers: {
			...attachmentHeaders(attachment, data),
			'Content-Length': String(data.length)
		}
	});
};

/**
 * DELETE — remove an attachment, on the card the path names. The card is asked
 * first, then whether the file is on it (404 otherwise, card 2361), then edit
 * access (403): `deleteAttachment` (card 2762).
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	const cardId = pathId(params.id, 'card');
	const attachmentId = pathId(params.attachmentId, 'attachment');

	// The row in a transaction, with the check that the caller may remove it,
	// its entry and the live event: the service's (card 2337). The file is
	// moved to the trash once that is committed, and not before: it used to be
	// removed first, so a failed delete left a row whose file had gone. The
	// transaction asks first whether the session is still open, and who its
	// account is now (card 2253).
	writeAs(locals, (caller) => {
		const attachment = deleteAttachment(caller, { cardId, attachmentId }, null, { source: 'ui' });
		trashAfterCommit([{ cardId: attachment.cardId, filename: attachment.filename }]);
	});

	return new Response(JSON.stringify({ success: true }), {
		headers: { 'Content-Type': 'application/json' }
	});
};
