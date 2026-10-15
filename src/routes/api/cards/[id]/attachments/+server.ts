import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { cardAttachments } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { writeFile, mkdir, unlink, rmdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { requireCard } from '$lib/server/route-guards';
import { attachmentPath, cardDir } from '$lib/server/uploads';
import { pathId } from '$lib/server/request-body';
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
	if (!locals.user) throw error(401, 'Not authenticated');
	const user = locals.user;

	const cardId = pathId(params.id, 'card');
	// Before the upload is read, so that a caller with no access is not sent
	// 25 MB first. It is asked again below, with the row.
	requireCard(user, cardId, 'edit');


	const formData = await request.formData();
	const file = formData.get('file') as File | null;
	if (!file || !(file instanceof File)) throw error(400, 'No file provided');
	if (file.size > MAX_FILE_SIZE) throw error(400, 'File too large (max 25MB)');

	const uuid = randomUUID();
	const safeOriginalName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
	const filename = `${uuid}-${safeOriginalName}`;
	const filePath = attachmentPath(cardId, filename);
	const buffer = Buffer.from(await file.arrayBuffer());

	// The file first, and then its row. A row is never left naming a file that
	// was not written; and if the row cannot be written, because the card was
	// deleted while the upload was being read or for any other reason, the
	// file is removed again, and the folder if this request made it.
	let madeDir = false;
	try {
		madeDir = (await mkdir(cardDir(cardId), { recursive: true })) !== undefined;
		await writeFile(filePath, buffer);

		const attachment = inTransaction(() => {
			// The card may have gone, or the caller's access to it, since the
			// check above: the body was awaited in between.
			requireCard(user, cardId, 'edit');

			return db.insert(cardAttachments).values({
				cardId,
				filename,
				originalName: file.name,
				mimeType: file.type || 'application/octet-stream',
				sizeBytes: file.size,
				uploadedBy: user.id
			}).returning().get();
		});

		return json(attachment);
	} catch (err) {
		try { await unlink(filePath); } catch { /* it was never written */ }
		// Not recursive: a folder with another upload in it stays.
		if (madeDir) { try { await rmdir(cardDir(cardId)); } catch { /* not empty, or gone */ } }
		throw err;
	}
};
