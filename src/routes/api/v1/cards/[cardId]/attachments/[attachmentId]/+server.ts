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
 * as a download (card 2754, D8). It has to be on the card the path names: one
 * that is not is answered as one that is not there, before any question of
 * access, as the card window's route answers it (card 2361). Then view access
 * to the card's board (403), and the file itself (404 when it is not on disk).
 *
 * The answer is the file and not JSON: always `attachment`, typed as an image
 * only when the bytes are the image type stored (`downloadHeaders`), with
 * `nosniff`, `sandbox` and `no-store`. A failure is JSON, as everywhere else.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = pathId(params.cardId, 'card');
	const attachmentId = pathId(params.attachmentId, 'attachment');
	const attachment = db.select().from(cardAttachments).where(eq(cardAttachments.id, attachmentId)).get();
	if (!attachment || attachment.cardId !== cardId) throw error(404, 'Attachment not found');

	requireCard(locals.user, attachment.cardId, 'view');

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
