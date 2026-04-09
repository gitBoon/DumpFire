import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardAttachments, cards, columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { readFile, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

const DB_PATH = process.env.DB_PATH || 'dumpfire.db';
const UPLOADS_DIR = join(dirname(DB_PATH), 'uploads');

/** Resolve the boardId for a given card. */
function getCardBoardId(cardId: number): number | null {
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) return null;
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	return col?.boardId ?? null;
}

/** GET — download/serve a file */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const attachmentId = Number(params.attachmentId);
	const attachment = db.select().from(cardAttachments)
		.where(eq(cardAttachments.id, attachmentId))
		.get();
	if (!attachment) throw error(404, 'Attachment not found');

	// Verify board access
	const boardId = getCardBoardId(attachment.cardId);
	if (boardId && !canViewBoard(locals.user, boardId)) {
		throw error(403, 'No access to this board');
	}

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
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const attachmentId = Number(params.attachmentId);
	const attachment = db.select().from(cardAttachments)
		.where(eq(cardAttachments.id, attachmentId))
		.get();
	if (!attachment) throw error(404, 'Attachment not found');

	// Verify board edit access
	const boardId = getCardBoardId(attachment.cardId);
	if (boardId && !canEditBoard(locals.user, boardId)) {
		throw error(403, 'No edit access to this board');
	}

	// Delete file from disk
	const filePath = join(UPLOADS_DIR, String(attachment.cardId), attachment.filename);
	try { await unlink(filePath); } catch { /* file may already be gone */ }

	// Delete DB record
	db.delete(cardAttachments).where(eq(cardAttachments.id, attachmentId)).run();

	return new Response(JSON.stringify({ success: true }), {
		headers: { 'Content-Type': 'application/json' }
	});
};
