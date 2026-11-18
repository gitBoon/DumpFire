/**
 * A card's files through the documented API (card 2754, slice S2b): a key
 * lists them, downloads one, and uploads an image.
 *
 *   GET  /api/v1/cards/{cardId}/attachments                   view access
 *   POST /api/v1/cards/{cardId}/attachments?name=<name>       edit access, raw image bytes
 *   GET  /api/v1/cards/{cardId}/attachments/{attachmentId}    view access, a download
 *
 * The upload is held to the plan's order (docs/planning/card-2754-card-images-over-api.md,
 * section 4, "The v1 contract"): a declared length over 5 MB is the gate's 413
 * before the key; then the card (404), edit access (403), the declared type
 * (415) and the upload count (429), all before a byte of the body is read; then
 * the read (413 past 5 MB), the day's bytes charged with every byte read
 * (429), the check of the bytes (415, 400), and at the write the card, the
 * access and the room on the card again
 * (404, 403, 409). Nothing is written on a refusal, and a file written before
 * a refused row is removed.
 *
 * The allowances are kept in memory for the key's user: they are emptied
 * before each case, and seeded where a case needs them nearly spent, as the
 * 20 images on a card are seeded as rows rather than uploaded (T10).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '$lib/server/db';
import { activityLog, boardMembers, cardAttachments, type Card } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { tooLargeBody } from '$lib/server/body-limits';
import { resetAllRateLimits, resetRateLimit, takeAllowance } from '$lib/server/rate-limit';
import { UPLOAD_BYTES_PER_DAY, UPLOADS_PER_HOUR } from '$lib/server/upload-allowance';
import { attachmentPath } from '$lib/server/uploads';
import { stamp } from '$lib/timestamps';
import { api, type ApiResult } from './helpers/api';
import { effects } from './helpers/effects';
import { gate } from './helpers/gate';
import { sendAround } from './helpers/held-body';
import { jpeg, png, pngChunk } from './helpers/image-bytes';
import {
	addBoardMember,
	makeApiKey,
	makeAttachment,
	makeBoard,
	makeCard,
	makeUser,
	makeWebhook,
	resetDb,
	testUploadsDir,
	type BoardFixture
} from './helpers/fixtures';

const M = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let owner: SessionUser;
let editor: SessionUser;
let viewer: SessionUser;
let outsider: SessionUser;
let A: BoardFixture;
let card: Card;

// The gate's server, started once before the cases that send through it, as tests/body-limits.test.ts starts it:
// started inside the first of them, it can take longer than a case is given while the whole suite runs.
beforeAll(async () => {
	await gate('GET', '/login', { headers: { accept: 'text/html' } });
}, 120_000);

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	owner = makeUser({ username: 'owner' });
	editor = makeUser({ username: 'editor' });
	viewer = makeUser({ username: 'viewer' });
	outsider = makeUser({ username: 'outsider' });
	A = makeBoard({ owner, name: 'A' });
	addBoardMember(A.board, editor, 'editor');
	addBoardMember(A.board, viewer, 'viewer');
	card = makeCard(A.cols['To Do'], { title: 'Has screenshots' });
});

afterEach(() => {
	vi.restoreAllMocks();
});

const PNG = { 'content-type': 'image/png' };
const rows = () => db.select().from(cardAttachments).all();
const entries = () => db.select().from(activityLog).all();
/** Every file in the tests' uploads folder, the trash included. */
const files = () => {
	const dir = testUploadsDir();
	return existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).sort() : [];
};

/** An upload by `user`, through the handler, of `body` as `type`. */
const upload = (user: SessionUser, body: Uint8Array, opts: { type?: string; query?: string; cardId?: number } = {}) =>
	api('POST', `/api/v1/cards/${opts.cardId ?? card.id}/attachments${opts.query ?? ''}`, {
		user,
		body,
		headers: { 'content-type': opts.type ?? 'image/png' }
	});

/** The upload count of `user` used up to all but `left`. */
const countLeft = (user: SessionUser, left: number) =>
	expect(takeAllowance(`attachment-upload:user:${user.id}`, UPLOADS_PER_HOUR - left, UPLOADS_PER_HOUR, HOUR_MS).taken).toBe(true);
/** The bytes of `user` used up to all but `left`. */
const bytesLeft = (user: SessionUser, left: number) =>
	expect(takeAllowance(`attachment-bytes:user:${user.id}`, UPLOAD_BYTES_PER_DAY - left, UPLOAD_BYTES_PER_DAY, DAY_MS).taken).toBe(true);

/** The request was refused with nothing read, written or kept. */
function expectNothingWritten(before: { rows: unknown[]; entries: unknown[]; files: string[] }): void {
	expect(rows()).toEqual(before.rows);
	expect(entries()).toEqual(before.entries);
	expect(files()).toEqual(before.files);
}
const now = () => ({ rows: rows(), entries: entries(), files: files() });

// ─── The upload, before the body ─────────────────────────────────────────────

describe('POST /api/v1/cards/{cardId}/attachments, before the body is read', () => {
	/** Each request's body read is seen here: the reader is the one the request is guarded with. */
	const watchRead = () => vi.spyOn(Request.prototype, 'arrayBuffer');

	it('22. answers a card that is not there 404, and reads nothing', async () => {
		const read = watchRead();
		const before = now();

		const res = await upload(owner, png(), { cardId: card.id + 1000 });

		expect(res).toMatchObject({ status: 404, body: { message: 'Card not found' } });
		expect(read).not.toHaveBeenCalled();
		expectNothingWritten(before);
	});

	it('23. answers a member who may only view 403, and reads nothing', async () => {
		const read = watchRead();
		const before = now();

		const res = await upload(viewer, png());

		expect(res).toMatchObject({ status: 403, body: { message: 'No edit access to this board' } });
		expect(read).not.toHaveBeenCalled();
		expectNothingWritten(before);
	});

	it('24. answers a type that is not one of the four 415, image/svg+xml among them, and reads nothing', async () => {
		const read = watchRead();
		const before = now();

		for (const type of ['image/svg+xml', 'application/octet-stream', 'text/html', 'image/png-but-not']) {
			const res = await upload(owner, png(), { type });
			expect(res.status, type).toBe(415);
			expect(res.body.message).toMatch(/^Send the image as the body, with Content-Type image\/png/);
		}
		expect(read).not.toHaveBeenCalled();
		expectNothingWritten(before);
	});

	it('is seen reading the body of an upload it takes, so that the cases above are seen not to', async () => {
		const read = watchRead();

		expect((await upload(owner, png())).status).toBe(201);
		expect(read).toHaveBeenCalledTimes(1);
	});

	it('takes nothing from the upload count for a request refused before it', async () => {
		countLeft(owner, 1);
		await upload(owner, png(), { type: 'image/svg+xml' });
		await upload(owner, png(), { cardId: card.id + 1000 });

		expect((await upload(owner, png())).status).toBe(201);
	});
});

// ─── The gate's 413, and a body sent in chunks ───────────────────────────────

describe('POST /api/v1/cards/{cardId}/attachments, the size of the body (25)', () => {
	/** A body sent in chunks of 64 KB, with no length declared, `total` bytes in all, starting with `start`. */
	const chunked = (start: Uint8Array, total: number) => {
		let sent = 0;
		return new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= total) return controller.close();
				const size = Math.min(64 * 1024, total - sent);
				const chunk = new Uint8Array(size);
				if (sent === 0) chunk.set(start.subarray(0, size));
				sent += size;
				controller.enqueue(chunk);
			}
		});
	};
	const inOne = (bytes: Uint8Array) =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			}
		});
	const json = async (res: Response) => ({ status: res.status, body: await res.json() });

	it('is 413 with limitBytes for a declared length over 5 MB, before the key is looked at', async () => {
		const res = await gate('POST', `/api/v1/cards/${card.id}/attachments`, {
			headers: { ...PNG, 'content-length': String(5 * M + 1), authorization: 'Bearer df_no_such_key' },
			body: inOne(png())
		});

		expect(await json(res)).toEqual({ status: 413, body: tooLargeBody(5 * M, 5 * M + 1) });
		expect(tooLargeBody(5 * M, 5 * M + 1)).toEqual({
			message: 'The request is larger than this server accepts here: it is 5.0 MB, and the limit is 5 MB',
			limitBytes: 5 * M
		});
	});

	it('is 413 from the count as it is read for a body that runs past the length it declared, and writes nothing', async () => {
		const key = makeApiKey(owner);
		const before = now();

		const res = await gate('POST', `/api/v1/cards/${card.id}/attachments`, {
			headers: { ...PNG, 'content-length': '1000', authorization: `Bearer ${key}` },
			body: chunked(png(), 5 * M + 1)
		});

		expect(await json(res)).toEqual({
			status: 413,
			body: { message: 'The request is larger than this server accepts here: the limit is 5 MB', limitBytes: 5 * M }
		});
		expectNothingWritten(before);
	});

	it('takes a body sent in chunks with no length (no 411), held to 5 MB', async () => {
		const key = makeApiKey(owner);

		const res = await gate('POST', `/api/v1/cards/${card.id}/attachments`, {
			headers: { ...PNG, authorization: `Bearer ${key}` },
			body: inOne(png())
		});

		expect(res.status).toBe(201);
		expect(rows()).toHaveLength(1);
	});
});

// ─── The allowances ──────────────────────────────────────────────────────────

describe('POST /api/v1/cards/{cardId}/attachments, the allowances of the key’s user', () => {
	it('26. refuses the 31st upload in an hour 429 with Retry-After, through either of the user’s keys, and not another user’s', async () => {
		const first = makeApiKey(owner, 'First');
		const second = makeApiKey(owner, 'Second');
		const send = (key: string) =>
			gate('POST', `/api/v1/cards/${card.id}/attachments`, { headers: { ...PNG, authorization: `Bearer ${key}` }, body: png() });
		countLeft(owner, 1);

		expect((await send(first)).status).toBe(201);
		const before = now();
		const refused = await send(second);

		expect(refused.status).toBe(429);
		const retry = Number(refused.headers.get('retry-after'));
		expect(retry).toBeGreaterThan(0);
		expect(retry).toBeLessThanOrEqual(3600);
		expect(await refused.json()).toEqual({
			message: expect.stringMatching(/^An account can upload at most 30 images an hour\. Nothing was read or written\. Try again in \d+ minute\(s\)\.$/),
			retryAfterSecs: retry
		});
		expectNothingWritten(before);
		// Another user's allowance is their own.
		expect((await send(makeApiKey(editor))).status).toBe(201);
	});

	it('27. refuses an image that passes the day’s bytes 429, charged with the bytes read; a refusal after the count was taken still used it', async () => {
		const resetBytes = () => resetRateLimit(`attachment-bytes:user:${owner.id}`);
		// The bytes read are charged, not the bytes kept: this one loses its text chunk, and what is kept would fit
		// in one byte less than was sent, but what was sent does not.
		const sent = png({ before: [pngChunk('tEXt', 'Comment\0a note that is taken out')] });
		expect(png().length).toBeLessThan(sent.length - 1);
		bytesLeft(owner, sent.length - 1);
		const before = now();
		const refused = await upload(owner, sent);
		expect(refused.status).toBe(429);
		expect(refused.body.message).toMatch(/^An account can upload at most 100 MB of images a day, and this image would pass it\. Nothing was written\./);
		expect(refused.body.retryAfterSecs).toBeGreaterThan(0);
		expectNothingWritten(before);

		// With exactly what was sent left, it is taken.
		resetBytes();
		bytesLeft(owner, sent.length);
		expect((await upload(owner, sent)).status).toBe(201);

		// A body the check refuses 415 is charged too, before the check: with room for it and one byte short of a
		// PNG, the PNG sent after it is refused.
		resetBytes();
		bytesLeft(owner, jpeg().length + png().length - 1);
		expect((await upload(owner, jpeg())).status).toBe(415);
		expect((await upload(owner, png())).status).toBe(429);

		// Four uploads above took four of the hour's count, refused or not, and 25 more are taken here: one left.
		// With a day's bytes again, one upload is taken, and then none.
		expect(takeAllowance(`attachment-upload:user:${owner.id}`, 25, UPLOADS_PER_HOUR, HOUR_MS).taken).toBe(true);
		resetBytes();
		expect((await upload(owner, png())).status).toBe(201);
		const countRefused = await upload(owner, png());
		expect(countRefused.status).toBe(429);
		expect(countRefused.body.message).toMatch(/30 images an hour/);
	});
});

// ─── The bytes ───────────────────────────────────────────────────────────────

describe('POST /api/v1/cards/{cardId}/attachments, the bytes', () => {
	it('28. refuses bytes that are not the declared type 415, and an image with data after its end 400, writing nothing', async () => {
		const before = now();

		const notPng = await upload(owner, jpeg());
		expect(notPng.status).toBe(415);
		const trailing = await upload(owner, new Uint8Array([...png(), 0x3c, 0x73, 0x76, 0x67, 0x3e]));
		expect(trailing.status).toBe(400);

		expectNothingWritten(before);
	});
});

// ─── The cap on a card ───────────────────────────────────────────────────────

describe('POST /api/v1/cards/{cardId}/attachments, twenty images on a card', () => {
	it('29. refuses the 21st image 409, counting every image row whichever tree attached it, and removes the file it wrote', async () => {
		// Twenty images: some as the card window stores them, its claimed types as sent, and a file that is no image.
		for (let i = 0; i < 20; i++) {
			const mimeType = ['image/png', 'IMAGE/JPEG', 'image/gif; x=1', 'image/webp'][i % 4];
			makeAttachment(card, { name: `shot-${i}.png`, mimeType, file: false });
		}
		makeAttachment(card, { name: 'notes.txt', mimeType: 'text/plain', file: false });
		const before = now();

		const res = await upload(owner, png());

		expect(res).toMatchObject({ status: 409, body: { message: 'This card already has 20 images' } });
		expectNothingWritten(before);
		expect(existsSync(join(testUploadsDir(), String(card.id)))).toBe(false);
	});

	it('counts no file that is not an image', async () => {
		for (let i = 0; i < 19; i++) makeAttachment(card, { name: `shot-${i}.png`, mimeType: 'image/png', file: false });
		for (let i = 0; i < 3; i++) makeAttachment(card, { name: `notes-${i}.txt`, mimeType: 'text/plain', file: false });

		expect((await upload(owner, png())).status).toBe(201);
		expect((await upload(owner, png())).status).toBe(409);
	});
});

// ─── A card retention would take (slice S3) ──────────────────────────────────

describe('POST /api/v1/cards/{cardId}/attachments, a card closed longer than IMAGE_RETENTION_DAYS', () => {
	const daysAgo = (days: number) => stamp(new Date(Date.now() - days * DAY_MS));

	it('45. refuses an image for a card closed more than 180 days ago 409, before the cap, writing nothing; with retention off, takes it', async () => {
		const closed = makeCard(A.cols['Complete'], { title: 'Shipped', completedAt: daysAgo(181) });
		const archived = makeCard(A.cols['To Do'], { title: 'Shelved', archivedAt: daysAgo(181) });
		// Twenty images on the completed card: the 409 for its age is asked first.
		for (let i = 0; i < 20; i++) makeAttachment(closed, { name: `shot-${i}.png`, mimeType: 'image/png', file: false });
		const before = now();

		for (const target of [closed, archived]) {
			const res = await upload(owner, png(), { cardId: target.id });
			expect(res).toMatchObject({
				status: 409,
				body: { message: 'This card was closed more than 180 days ago, so its images are moved to the trash: reopen or restore it to attach one' }
			});
		}
		expectNothingWritten(before);

		// Closed for less, or in a column that is not Complete: taken.
		const recent = makeCard(A.cols['Complete'], { title: 'Lately', completedAt: daysAgo(179) });
		const moved = makeCard(A.cols['In Progress'], { title: 'Stale stamp', completedAt: daysAgo(181) });
		expect((await upload(owner, png(), { cardId: recent.id })).status).toBe(201);
		expect((await upload(owner, png(), { cardId: moved.id })).status).toBe(201);

		vi.stubEnv('IMAGE_RETENTION_DAYS', 'off');
		try {
			expect((await upload(owner, png(), { cardId: archived.id })).status).toBe(201);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

// ─── A success ───────────────────────────────────────────────────────────────

describe('POST /api/v1/cards/{cardId}/attachments, an image attached (30)', () => {
	it('is 201 with the attachment, its file stored as <uuid>.png without its metadata, the entry from the API, the live event and no webhook', async () => {
		makeWebhook(A.board);
		const sent = effects();
		let res!: ApiResult;
		try {
			res = await upload(editor, png({ before: [pngChunk('tEXt', 'Author\0someone')] }), { query: '?name=Login%20page.png' });
			await sent.settle();
			expect(sent.duringTransaction).toEqual([]);
			expect(sent.events.map((e) => ({ boardId: e.boardId, event: e.event, data: e.data }))).toEqual([
				{ boardId: A.board.id, event: 'update', data: { type: 'attachment', cardId: card.id } }
			]);
			expect(sent.webhooks).toEqual([]);
		} finally {
			sent.restore();
		}

		const [row] = rows();
		const stored = png();
		expect(res.status).toBe(201);
		expect(res.body).toEqual({
			id: row.id,
			cardId: card.id,
			originalName: 'Login page.png',
			mimeType: 'image/png',
			sizeBytes: stored.length,
			uploadedBy: editor.id,
			createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/)
		});
		expect(row.filename).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
		expect(new Uint8Array(readFileSync(attachmentPath(card.id, row.filename)))).toEqual(stored);
		expect(entries().map((e) => ({ action: e.action, detail: e.detail, source: e.source, userId: e.userId, cardId: e.cardId }))).toEqual([
			{ action: 'api:attachment_added', detail: 'Attached "Login page.png" to "Has screenshots"', source: 'api', userId: editor.id, cardId: card.id }
		]);
	});

	it('names the image by the caller’s name, cleaned, cut to 100 characters and given the extension of its bytes, or by the time with none', async () => {
		const named = async (query: string, body = png(), type = 'image/png') => {
			const res = await upload(owner, body, { query, type });
			expect(res.status, query).toBe(201);
			return res.body.originalName as string;
		};

		expect(await named(`?name=${encodeURIComponent('../../x.svg')}`)).toBe('x.png');
		expect(await named(`?name=${encodeURIComponent('C:\\shots\\a<b>:"|?*\u202e.gif')}`)).toBe('ab.png');
		expect(await named(`?name=${encodeURIComponent(`${'a'.repeat(146)}.png`)}`)).toBe(`${'a'.repeat(100)}.png`);
		expect(await named('?name=photo', jpeg(), 'image/jpeg')).toBe('photo.jpg');
		expect(await named(`?name=${encodeURIComponent('shot.jpeg')}`)).toBe('shot.png');
		// A dot that starts no extension stays.
		expect(await named(`?name=${encodeURIComponent('Fig. 3 login page')}`)).toBe('Fig. 3 login page.png');
		expect(await named(`?name=${encodeURIComponent('v1.2 release notes')}`)).toBe('v1.2 release notes.png');
		expect(await named('')).toMatch(/^image-\d{4}-\d{2}-\d{2}-\d{6}\.png$/);
		expect(await named('?name=')).toMatch(/^image-\d{4}-\d{2}-\d{2}-\d{6}\.png$/);
		expect(await named(`?name=${encodeURIComponent('  .png ')}`)).toMatch(/^image-\d{4}-\d{2}-\d{2}-\d{6}\.png$/);
		// Every file on disk is named by the server.
		for (const row of rows()) expect(row.filename).toMatch(/^[0-9a-f-]{36}\.(png|jpg)$/);
	});

	it('takes a type sent with parameters and in capitals', async () => {
		expect((await upload(owner, png(), { type: 'IMAGE/PNG; q=1' })).status).toBe(201);
	});
});

// ─── Access taken away while the body is read ────────────────────────────────

describe('POST /api/v1/cards/{cardId}/attachments, access taken away while the body is read (31)', () => {
	it('is refused at the write, with the file and the folder the upload made removed', async () => {
		const key = makeApiKey(editor);
		const before = now();

		const res = await sendAround('POST', `/api/v1/cards/${card.id}/attachments`, { key }, png(), () => {
			db.delete(boardMembers).where(and(eq(boardMembers.boardId, A.board.id), eq(boardMembers.userId, editor.id))).run();
		}, { headers: PNG });

		// Taken off the board, the editor can no longer open it: as a card that is not there (card 2719).
		expect(res).toEqual({ status: 404, body: { message: 'Card not found' } });
		expect(rows()).toEqual(before.rows);
		expect(entries()).toEqual(before.entries);
		expect(files()).toEqual(before.files);
	});

	it('leaves a folder the upload found, with what was in it', async () => {
		const kept = makeAttachment(card, { name: 'kept.txt' });
		const key = makeApiKey(editor);
		const before = now();

		const res = await sendAround('POST', `/api/v1/cards/${card.id}/attachments`, { key }, png(), () => {
			db.update(boardMembers)
				.set({ role: 'viewer' })
				.where(and(eq(boardMembers.boardId, A.board.id), eq(boardMembers.userId, editor.id)))
				.run();
		}, { headers: PNG });

		expect(res.status).toBe(403);
		expect(files()).toEqual(before.files);
		expect(readdirSync(join(testUploadsDir(), String(card.id)))).toEqual([kept.filename]);
	});
});

// ─── The list ────────────────────────────────────────────────────────────────

describe('GET /api/v1/cards/{cardId}/attachments (32)', () => {
	it('lists a card’s files oldest first, ties by id, without the name on disk, and not another card’s', async () => {
		const other = makeCard(A.cols['To Do'], { title: 'Another' });
		const second = makeAttachment(card, { name: 'b.png', mimeType: 'image/png', uploadedBy: owner, file: false });
		const first = makeAttachment(card, { name: 'a.txt', uploadedBy: owner, file: false });
		const third = makeAttachment(card, { name: 'c.txt', file: false });
		makeAttachment(other, { name: 'elsewhere.txt', file: false });
		// `first` is the oldest; `second` and `third` were made in one second, and go by id.
		db.update(cardAttachments).set({ createdAt: '2026-02-01 00:00:00' }).where(eq(cardAttachments.cardId, card.id)).run();
		db.update(cardAttachments).set({ createdAt: '2026-01-01 00:00:00' }).where(eq(cardAttachments.id, first.id)).run();

		const res = await api('GET', `/api/v1/cards/${card.id}/attachments`, { user: viewer });

		expect(res.status).toBe(200);
		expect(res.body.map((a: { id: number }) => a.id)).toEqual([first.id, second.id, third.id]);
		expect(res.body[1]).toEqual({
			id: second.id,
			cardId: card.id,
			originalName: 'b.png',
			mimeType: 'image/png',
			sizeBytes: second.sizeBytes,
			uploadedBy: owner.id,
			createdAt: '2026-02-01T00:00:00.000Z'
		});
		expect(res.body[2].uploadedBy).toBeNull();
	});

	it('answers a card that is not there 404, a caller with no access alike (card 2719), and a bad id 400', async () => {
		expect(await api('GET', `/api/v1/cards/${card.id + 1000}/attachments`, { user: owner })).toMatchObject({ status: 404, body: { message: 'Card not found' } });
		expect(await api('GET', `/api/v1/cards/${card.id}/attachments`, { user: outsider })).toMatchObject({ status: 404, body: { message: 'Card not found' } });
		expect(await api('GET', '/api/v1/cards/x/attachments', { user: owner })).toMatchObject({ status: 400, body: { message: 'Invalid card ID' } });
	});
});

// ─── The download ────────────────────────────────────────────────────────────

describe('GET /api/v1/cards/{cardId}/attachments/{attachmentId} (33)', () => {
	const download = (user: SessionUser, cardId: number, attachmentId: number) =>
		api('GET', `/api/v1/cards/${cardId}/attachments/${attachmentId}`, { user });
	const headersOf = (res: ApiResult) => ({
		type: res.headers.get('content-type'),
		disposition: res.headers.get('content-disposition'),
		nosniff: res.headers.get('x-content-type-options'),
		csp: res.headers.get('content-security-policy'),
		cache: res.headers.get('cache-control')
	});

	it('answers an image whose bytes are its type as that type, and always as a download, never cached', async () => {
		const shot = makeAttachment(card, { name: 'shot.png', mimeType: 'image/png', content: png() });

		const res = await download(viewer, card.id, shot.id);

		expect(res.status).toBe(200);
		expect(headersOf(res)).toEqual({
			type: 'image/png',
			disposition: `attachment; filename="shot.png"; filename*=UTF-8''shot.png`,
			nosniff: 'nosniff',
			csp: 'sandbox',
			cache: 'no-store'
		});
		expect(res.headers.get('content-length')).toBe(String(png().length));
	});

	it('answers a row typed image/png whose bytes are HTML, and a .txt, as application/octet-stream', async () => {
		const page = makeAttachment(card, { name: 'shot.png', mimeType: 'image/png', content: '<html><script>alert(1)</script></html>' });
		const notes = makeAttachment(card, { name: 'notes.txt', mimeType: 'text/plain' });

		for (const file of [page, notes]) {
			const res = await download(owner, card.id, file.id);
			expect(res.status).toBe(200);
			expect(headersOf(res)).toMatchObject({ type: 'application/octet-stream', nosniff: 'nosniff', csp: 'sandbox', cache: 'no-store' });
			expect(headersOf(res).disposition).toMatch(/^attachment; /);
		}
	});

	it('answers a file on another card 404 before any question of access, no access 404 (card 2719), a file gone from disk 404, and a bad id 400', async () => {
		const other = makeCard(makeBoard({ owner: outsider, name: 'Not yours' }).cols['To Do'], { title: 'Elsewhere' });
		const theirs = makeAttachment(other, { name: 'theirs.png', mimeType: 'image/png', content: png() });
		const gone = makeAttachment(card, { name: 'gone.png', mimeType: 'image/png', file: false });
		const mine = makeAttachment(card, { name: 'mine.txt' });

		expect(await download(owner, card.id, theirs.id)).toMatchObject({ status: 404, body: { message: 'Attachment not found' } });
		expect(await download(owner, other.id, theirs.id)).toMatchObject({ status: 404, body: { message: 'Card not found' } });
		expect(await download(outsider, card.id, mine.id)).toMatchObject({ status: 404, body: { message: 'Card not found' } });
		expect(await download(owner, card.id, gone.id)).toMatchObject({ status: 404, body: { message: 'File not found on disk' } });
		expect(await download(owner, card.id, mine.id + 1000)).toMatchObject({ status: 404, body: { message: 'Attachment not found' } });
		expect(await api('GET', `/api/v1/cards/${card.id}/attachments/x`, { user: owner })).toMatchObject({ status: 400, body: { message: 'Invalid attachment ID' } });
	});
});
