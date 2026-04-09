import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardAttachments, cards, columns } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { writeFile, mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { canViewBoard, canEditBoard } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

const DB_PATH = process.env.DB_PATH || 'dumpfire.db';
const UPLOADS_DIR = join(dirname(DB_PATH), 'uploads');
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

/** Resolve the boardId for a given card. */
function getCardBoardId(cardId: number): number | null {
	const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, cardId)).get();
	if (!card) return null;
	const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
	return col?.boardId ?? null;
}

/** GET — list attachments for a card */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.id);
	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');
	if (!canViewBoard(locals.user, boardId)) throw error(403, 'No access to this board');

	const attachments = db.select().from(cardAttachments)
		.where(eq(cardAttachments.cardId, cardId))
		.all();
	return json(attachments);
};

/** POST — upload file attachment */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.id);
	const boardId = getCardBoardId(cardId);
	if (!boardId) throw error(404, 'Card not found');
	if (!canEditBoard(locals.user, boardId)) throw error(403, 'No edit access to this board');

	const formData = await request.formData();
	const file = formData.get('file') as File | null;
	if (!file || !(file instanceof File)) throw error(400, 'No file provided');
	if (file.size > MAX_FILE_SIZE) throw error(400, 'File too large (max 25MB)');

	const uuid = randomUUID();
	const safeOriginalName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
	const filename = `${uuid}-${safeOriginalName}`;
	const cardDir = join(UPLOADS_DIR, String(cardId));

	await mkdir(cardDir, { recursive: true });
	const buffer = Buffer.from(await file.arrayBuffer());
	await writeFile(join(cardDir, filename), buffer);

	const attachment = db.insert(cardAttachments).values({
		cardId,
		filename,
		originalName: file.name,
		mimeType: file.type || 'application/octet-stream',
		sizeBytes: file.size,
		uploadedBy: locals.user.id
	}).returning().get();

	return json(attachment);
};
