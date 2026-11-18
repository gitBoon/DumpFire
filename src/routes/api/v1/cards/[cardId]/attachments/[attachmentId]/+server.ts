import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { readFile } from 'fs/promises';
import { db } from '$lib/server/db';
import { cardAttachments } from '$lib/server/db/schema';
import { pathId } from '$lib/server/request-body';
import { requireCard } from '$lib/server/route-guards';
import { attachmentPath, downloadHeaders } from '$lib/server/uploads';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/cards/:cardId/attachments/:attachmentId — One file on a card,
 * as a download (card 2754, D8). The card the path names is asked first (card
 * 2762): one that is not there, or that the key's user cannot open, is `404
 * Card not found` whatever attachment id follows it (card 2719). Then the file
 * has to be on that card: one that is not is answered as one that is not
 * there, as the card window's route answers it (card 2361). Then the file
 * itself (404 when it is not on disk).
 *
 * The answer is the file and not JSON: always `attachment`, typed as an image
 * only when the bytes are the image type stored (`downloadHeaders`), with
 * `nosniff`, `sandbox` and `no-store`. A failure is JSON, as everywhere else.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.cardId, 'card');
	const attachmentId = pathId(params.attachmentId, 'attachment');
	requireCard(locals.user, cardId, 'view');

	const attachment = db.select().from(cardAttachments).where(eq(cardAttachments.id, attachmentId)).get();
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

	return new Response(data, {
		headers: {
			...downloadHeaders(attachment, data),
			'Content-Length': String(data.length)
		}
	});
};
