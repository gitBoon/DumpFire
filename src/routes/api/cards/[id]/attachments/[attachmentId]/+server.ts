import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardAttachments } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { readFile, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import type { RequestHandler } from './$types';

const DB_PATH = process.env.DB_PATH || 'dumpfire.db';
const UPLOADS_DIR = join(dirname(DB_PATH), 'uploads');

/** GET — download/serve a file */
export const GET: RequestHandler = async ({ params }) => {
	const attachmentId = Number(params.attachmentId);
	const attachment = db.select().from(cardAttachments)
		.where(eq(cardAttachments.id, attachmentId))
		.get();
	if (!attachment) throw error(404, 'Attachment not found');

	const filePath = join(UPLOADS_DIR, String(attachment.cardId), attachment.filename);

	try {
		const data = await readFile(filePath);
		return new Response(data, {
			headers: {
				'Content-Type': attachment.mimeType,
				'Content-Disposition': `inline; filename="${attachment.originalName}"`,
				'Content-Length': String(data.length)
			}
		});
	} catch {
		throw error(404, 'File not found on disk');
	}
};

/** DELETE — remove an attachment */
export const DELETE: RequestHandler = async ({ params }) => {
	const attachmentId = Number(params.attachmentId);
	const attachment = db.select().from(cardAttachments)
		.where(eq(cardAttachments.id, attachmentId))
		.get();
	if (!attachment) throw error(404, 'Attachment not found');

	// Delete file from disk
	const filePath = join(UPLOADS_DIR, String(attachment.cardId), attachment.filename);
	try { await unlink(filePath); } catch { /* file may already be gone */ }

	// Delete DB record
	db.delete(cardAttachments).where(eq(cardAttachments.id, attachmentId)).run();

	return new Response(JSON.stringify({ success: true }), {
		headers: { 'Content-Type': 'application/json' }
	});
};
