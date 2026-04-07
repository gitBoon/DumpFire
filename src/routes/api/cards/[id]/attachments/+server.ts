import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardAttachments } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { writeFile, mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import type { RequestHandler } from './$types';

const DB_PATH = process.env.DB_PATH || 'dumpfire.db';
const UPLOADS_DIR = join(dirname(DB_PATH), 'uploads');
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

/** GET — list attachments for a card */
export const GET: RequestHandler = async ({ params }) => {
	const cardId = Number(params.id);
	const attachments = db.select().from(cardAttachments)
		.where(eq(cardAttachments.cardId, cardId))
		.all();
	return json(attachments);
};

/** POST — upload file attachment */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const cardId = Number(params.id);
	const user = locals.user!;

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
		uploadedBy: user.id
	}).returning().get();

	return json(attachment);
};
