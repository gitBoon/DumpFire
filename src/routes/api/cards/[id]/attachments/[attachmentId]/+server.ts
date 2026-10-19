import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardAttachments } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { readFile } from 'fs/promises';
import { requireCard, requireUser } from '$lib/server/route-guards';
import { trashAfterCommit } from '$lib/server/deletes';
import { attachmentHeaders, attachmentPath } from '$lib/server/uploads';
import { pathId } from '$lib/server/request-body';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';


/** GET — download/serve a file */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const attachmentId = pathId(params.attachmentId, 'attachment');
	const attachment = db.select().from(cardAttachments)
		.where(eq(cardAttachments.id, attachmentId))
		.get();
	if (!attachment) throw error(404, 'Attachment not found');

	// The board is the one the attachment's own card is on. A card that could
	// not be resolved used to skip the check instead of failing it.
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

	// A download unless it is one of a few types that can run nothing, and
	// sandboxed either way. See attachmentHeaders.
	return new Response(data, {
		headers: {
			...attachmentHeaders(attachment),
			'Content-Length': String(data.length)
		}
	});
};

/** DELETE — remove an attachment */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	const attachmentId = pathId(params.attachmentId, 'attachment');

	// The row in a transaction, with the check that the caller may remove it.
	// The file is moved to the trash once that is committed, and not before:
	// it used to be removed first, so a failed delete left a row whose file
	// had gone. The transaction asks first whether the session is still open,
	// and who its account is now (card 2253).
	writeAs(locals, (caller) => {
		const user = requireUser(caller);
		const attachment = db.select().from(cardAttachments)
			.where(eq(cardAttachments.id, attachmentId))
			.get();
		if (!attachment) throw error(404, 'Attachment not found');

		requireCard(user, attachment.cardId, 'edit');

		db.delete(cardAttachments).where(eq(cardAttachments.id, attachmentId)).run();
		trashAfterCommit([{ cardId: attachment.cardId, filename: attachment.filename }]);
	});

	return new Response(JSON.stringify({ success: true }), {
		headers: { 'Content-Type': 'application/json' }
	});
};
