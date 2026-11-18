/**
 * Attachment files: where they are kept, the trash they go to when their row
 * is deleted, and how they are answered when somebody opens one.
 *
 * Every file here is under the tests' own uploads folder, which
 * `tests/setup.ts` makes under the operating system's temp folder and
 * `resetDb()` empties. Nothing here goes near ./uploads.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	promises as fsPromises,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { activityLog, boardMembers, cardAttachments, cards, sessions, type Card, type CardAttachment } from '$lib/server/db/schema';
import { imageTypeOf } from '$lib/server/image-check';
import { stamp } from '$lib/timestamps';
import type { SessionUser } from '$lib/server/auth';
import { initLogMaintenance } from '$lib/server/logger';
import { allowanceState, resetAllRateLimits, takeAllowance } from '$lib/server/rate-limit';
import { UPLOAD_BYTES_PER_DAY, UPLOADS_PER_HOUR } from '$lib/server/upload-allowance';
import {
	attachmentHeaders,
	attachmentPath,
	emptyTrash,
	moveToTrash,
	putBackFromTrash,
	removeUploadFile,
	resolveUploadsDir,
	TRASH_DAYS,
	UploadPathError,
	UploadsDirError,
	writeUploadFile
} from '$lib/server/uploads';
import { bytes, gif, jpeg, le32, png, pngChunk, webp } from './helpers/image-bytes';
import { api } from './helpers/api';
import { eachWriteInTurn } from './helpers/each-write';
import { effects } from './helpers/effects';
import { failingWrite } from './helpers/failing-write';
import {
	importConfirmation,
	makeAttachment,
	makeBoard,
	makeCard,
	makeSession,
	makeUser,
	makeWebhook,
	resetDb,
	sessionCredential,
	sessionHashOf,
	testUploadsDir,
	type BoardFixture
} from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';
import { sweepUploads } from '$lib/server/uploads-sweep';

// The `fs.promises` an upload's file is written with (`writeUploadFile`, which
// was the upload route's own code until card 2754), stood in for in every
// test: `mkdir` with a hook a test can set to run straight after it once,
// where the sweep can run, between the folder made and the file written; and
// `writeFile` with failures a test can queue, one a call, thrown before the
// file is written or after. Every other call is the real one. A spy on the
// object, not a mock of the module: tests/setup.ts has loaded uploads.ts
// before a mock in this file would be registered.
const afterMkdir: { once: null | (() => void) } = { once: null };
const writes = { calls: 0, failures: [] as { error: Error; afterWriting?: boolean }[] };
const realMkdir = fsPromises.mkdir;
const realWriteFile = fsPromises.writeFile;

const DAY = 86_400_000;

let owner: SessionUser;
let A: BoardFixture;
let card: Card;
const tempDirs: string[] = [];

beforeEach(() => {
	vi.spyOn(fsPromises, 'mkdir').mockImplementation((async (...args: Parameters<typeof realMkdir>) => {
		const made = await realMkdir(...args);
		const hook = afterMkdir.once;
		afterMkdir.once = null;
		hook?.();
		return made;
	}) as typeof realMkdir);
	vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (...args: Parameters<typeof realWriteFile>) => {
		writes.calls++;
		const failure = writes.failures.shift();
		if (failure?.afterWriting) await realWriteFile(...args);
		if (failure) throw failure.error;
		return realWriteFile(...args);
	});
	resetDb();
	// The upload allowances are in memory, kept for the account, and outlast a
	// reset of the database: every test starts with the whole hour and day
	// (card 2761, E12).
	resetAllRateLimits();
	owner = makeUser({ username: 'owner' });
	A = makeBoard({ owner, name: 'A' });
	card = makeCard(A.cols['To Do'], { title: 'Has files' });
});

afterEach(() => {
	afterMkdir.once = null;
	writes.calls = 0;
	writes.failures = [];
	vi.useRealTimers();
	vi.restoreAllMocks();
	process.env.LOG_LEVEL = 'ERROR';
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const at = (...parts: (string | number)[]) => join(testUploadsDir(), ...parts.map(String));
const fileIn = (...parts: (string | number)[]) => existsSync(at(...parts));
const rows = () => db.select().from(cardAttachments).all();
const ref = (file: CardAttachment) => ({ cardId: file.cardId, filename: file.filename });
/** The board's log, as an entry is written (card 2337). */
const entries = () =>
	db
		.select({
			boardId: activityLog.boardId,
			cardId: activityLog.cardId,
			userId: activityLog.userId,
			action: activityLog.action,
			detail: activityLog.detail,
			source: activityLog.source
		})
		.from(activityLog)
		.all();

/**
 * Runs `request` with what it tells recorded and sent nowhere (card 2337): the
 * entries it wrote, the live events it sent, and the webhooks it would have
 * delivered. A case makes a webhook for every event on the board first.
 */
async function told(request: () => Promise<unknown>) {
	const sent = effects();
	try {
		await request();
		await sent.settle();
		expect(sent.duringTransaction).toEqual([]);
		return {
			entries: entries(),
			events: sent.events.map((e) => ({ boardId: e.boardId, event: e.event, data: e.data })),
			webhooks: sent.webhooks.map((e) => e.event)
		};
	} finally {
		sent.restore();
	}
}

/** Send a file to a card as the browser does. */
function upload(to: Card, file: File, user: SessionUser = owner) {
	const form = new FormData();
	form.set('file', file);
	return api('POST', `/api/cards/${to.id}/attachments`, { user, body: form });
}

// ─── Where uploads are ──────────────────────────────────────────────────────

describe('the uploads folder', () => {
	const data = resolve('/data');
	const app = resolve('/app');
	const database = join(data, 'dumpfire.db');

	it('is the folder "uploads" beside the database unless UPLOADS_DIR names another', () => {
		expect(resolveUploadsDir(null, database, app)).toBe(join(data, 'uploads'));
		expect(resolveUploadsDir('', database, app)).toBe(join(data, 'uploads'));
		expect(resolveUploadsDir(resolve('/srv/files'), database, app)).toBe(resolve('/srv/files'));
		// A relative database path is relative to the working directory.
		expect(resolveUploadsDir(null, 'data/dumpfire.db', app)).toBe(join(app, 'data', 'uploads'));
		// And so is the default: dumpfire.db in the working directory.
		expect(resolveUploadsDir(null, join(app, 'dumpfire.db'), app)).toBe(join(app, 'uploads'));
	});

	it('is refused when it is, or contains, the folder the database is in', () => {
		expect(() => resolveUploadsDir(data, database, app)).toThrow(UploadsDirError);
		expect(() => resolveUploadsDir(resolve('/'), database, app)).toThrow(/contains, the folder the database is in/);
		expect(() => resolveUploadsDir(data, join(data, 'live', 'dumpfire.db'), app)).toThrow(UploadsDirError);
		// A folder beside the database's, whose name only starts the same, is not it.
		expect(resolveUploadsDir(resolve('/data-uploads'), database, app)).toBe(resolve('/data-uploads'));
	});

	it('is refused when it is, or contains, the working directory', () => {
		expect(() => resolveUploadsDir(app, database, app)).toThrow(/working directory/);
		expect(() => resolveUploadsDir('.', database, app)).toThrow(UploadsDirError);
		expect(() => resolveUploadsDir('..', database, join(app, 'server'))).toThrow(UploadsDirError);
		expect(resolveUploadsDir('uploads', database, app)).toBe(join(app, 'uploads'));
	});

	it('has to be named for an in-memory database, which has no folder to put it beside', () => {
		expect(() => resolveUploadsDir(null, ':memory:', app)).toThrow(/Set UPLOADS_DIR/);
		expect(resolveUploadsDir(resolve('/srv/files'), ':memory:', app)).toBe(resolve('/srv/files'));
		// It has no folder to be contained either, but the working directory still counts.
		expect(() => resolveUploadsDir(app, ':memory:', app)).toThrow(UploadsDirError);
	});

	it('is, for these tests, under the temp folder and outside the repository', () => {
		expect(testUploadsDir().startsWith(tmpdir())).toBe(true);
		expect(testUploadsDir().startsWith(process.cwd())).toBe(false);
	});
});

// ─── A file name is data ────────────────────────────────────────────────────

describe('a stored file name', () => {
	it('names a file in the card\'s own folder, or is refused', () => {
		expect(attachmentPath(7, 'a1b2-report.pdf')).toBe(at(7, 'a1b2-report.pdf'));
		expect(attachmentPath(7, '..hidden')).toBe(at(7, '..hidden'));

		for (const name of [
			'../8/theirs.txt',
			'..\\8\\theirs.txt',
			'..',
			'.',
			'',
			'sub/file.txt',
			'/etc/passwd',
			'C:\\Windows\\win.ini',
			'C:evil.txt',
			'file.txt:stream',
			'nul\0.txt',
			'.trashed-at'
		]) {
			expect(() => attachmentPath(7, name), JSON.stringify(name)).toThrow(UploadPathError);
		}
		for (const id of [0, -1, 1.5, NaN, Infinity]) {
			expect(() => attachmentPath(id, 'file.txt'), String(id)).toThrow(UploadPathError);
		}
	});

	it('that climbs out of the folder is not served, and the file it points at is not moved by a delete', async () => {
		process.env.LOG_LEVEL = 'WARN';
		mkdirSync(testUploadsDir(), { recursive: true });
		writeFileSync(at('outside.txt'), 'Not this card\'s');
		const own = makeAttachment(card, { name: 'own.txt' });
		// As a restored backup could hold it.
		const climbing = db
			.insert(cardAttachments)
			.values({ cardId: card.id, filename: '../outside.txt', originalName: 'outside.txt', mimeType: 'text/plain' })
			.returning()
			.get();

		const served = await api('GET', `/api/cards/${card.id}/attachments/${climbing.id}`, { user: owner });
		expect(served.status).toBe(404);
		expect(served.body.message).toBe('File not found on disk');

		// The delete is committed all the same, and its own file is moved.
		const res = await api('DELETE', `/api/cards/${card.id}?permanent=true`, { user: owner });
		expect(res.status).toBe(200);
		expect(rows()).toEqual([]);
		expect(readFileSync(at('outside.txt'), 'utf8')).toBe('Not this card\'s');
		expect(readdirSync(at('.trash', card.id)).sort()).toEqual(['.trashed-at', own.filename].sort());

		const warned = sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'DELETE'").all() as {
			level: string;
			message: string;
		}[];
		expect(warned).toHaveLength(1);
		expect(warned[0].level).toBe('WARN');
		expect(warned[0].message).toMatch(/1 problem\(s\) moving the files of 2 deleted attachment\(s\) to the trash/);
		expect(warned[0].message).toMatch(/outside\.txt.*is not the name of a file in the card's own folder/);
	});
});

// ─── The trash ──────────────────────────────────────────────────────────────

describe('deleting an attachment', () => {
	it('removes the row, and moves the file to the trash once that is committed', async () => {
		const run = await eachWriteInTurn({
			build: () => {
				const user = makeUser({ username: 'owner' });
				const board = makeBoard({ owner: user });
				const on = makeCard(board.cols['To Do']);
				return { user, on, kept: makeAttachment(on, { name: 'kept.txt' }), gone: makeAttachment(on, { name: 'gone.txt' }) };
			},
			request: async ({ user, on, kept, gone }) => {
				const call = () => api('DELETE', `/api/cards/${on.id}/attachments/${gone.id}`, { user });
				try {
					return await call();
				} catch (thrown) {
					// It failed, so the file is where it was and nothing is in the trash.
					expect(fileIn(on.id, gone.filename)).toBe(true);
					expect(fileIn(on.id, kept.filename)).toBe(true);
					expect(fileIn('.trash')).toBe(false);
					throw thrown;
				}
			},
			afterSuccess: ({ on, kept, gone }, res) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true });
				expect(rows().map((r) => r.id)).toEqual([kept.id]);

				expect(fileIn(on.id, gone.filename)).toBe(false);
				expect(readFileSync(at('.trash', on.id, gone.filename), 'utf8')).toBe('The contents of gone.txt');
				// Dated, so that it can be emptied in its time.
				expect(Date.parse(readFileSync(at('.trash', on.id, '.trashed-at'), 'utf8'))).toBeGreaterThan(Date.now() - 60_000);
				// Only the file named was moved, and the folder is kept for what is left in it.
				expect(readdirSync(at(on.id))).toEqual([kept.filename]);
			}
		});

		// The row's delete and its entry (card 2337): either failing leaves the file where it was.
		expect(run.writes).toHaveLength(2);
	});

	it('removes the card\'s folder with its last file, and passes over a file that is not there', async () => {
		const last = makeAttachment(card, { name: 'last.txt' });
		const rowOnly = makeAttachment(makeCard(A.cols['To Do']), { name: 'never-copied.txt', file: false });

		expect((await api('DELETE', `/api/cards/${card.id}/attachments/${last.id}`, { user: owner })).status).toBe(200);
		expect(fileIn(card.id)).toBe(false);
		expect(fileIn('.trash', card.id, last.filename)).toBe(true);

		// A working copy restored from a backup has the rows and none of the files.
		const res = await api('DELETE', `/api/cards/${rowOnly.cardId}/attachments/${rowOnly.id}`, { user: owner });
		expect(res.status).toBe(200);
		expect(rows()).toEqual([]);
		expect(fileIn('.trash', rowOnly.cardId)).toBe(false);
		expect(moveToTrash([ref(rowOnly)])).toEqual({ moved: 0, missing: 1, failed: [] });
	});

	it('is refused to a caller who cannot edit the card, with the file left where it is', async () => {
		const file = makeAttachment(card);
		const outsider = makeUser({ username: 'outsider' });
		makeWebhook(A.board);
		const before = snapshotDb();

		// And records and tells nothing (card 2337).
		const said = await told(async () => {
			// The outsider cannot open the card's board: as a card that is not there (card 2719).
			const refused = await api('DELETE', `/api/cards/${card.id}/attachments/${file.id}`, { user: outsider });
			expect([refused.status, refused.body]).toEqual([404, { message: 'Card not found' }]);
			expect((await api('DELETE', `/api/cards/${card.id}/attachments/99999`, { user: owner })).status).toBe(404);
		});

		expect(said).toEqual({ entries: [], events: [], webhooks: [] });
		expectUnchanged(before);
		expect(fileIn(card.id, file.filename)).toBe(true);
	});

	// Card 2361: the attachment was found by its own id and the card in the
	// path was never read, so a file was deleted under the address of any card.
	// Now one not on the card named is answered as one that is not there. Since
	// card 2762 the card is asked first: a caller who cannot open it is answered
	// `Card not found` whatever the id (card 2719's words); only one who can open
	// it is told whether the file is on it, and only then whether they may edit.
	it('is 404 under the address of a card it is not on, with the row and the file left and nothing told (card 2361)', async () => {
		const other = makeCard(A.cols['To Do'], { title: 'Has none' });
		const file = makeAttachment(card);
		const B = makeBoard({ name: 'B' });
		const theirs = makeAttachment(makeCard(B.cols['To Do'], { title: 'Not theirs' }));
		const outsider = makeUser({ username: 'outsider' });
		makeWebhook(A.board);
		const before = snapshotDb();

		const said = await told(async () => {
			// The owner, who can edit both cards, names the other one.
			const res = await api('DELETE', `/api/cards/${other.id}/attachments/${file.id}`, { user: owner });
			expect([res.status, res.body]).toEqual([404, { message: 'Attachment not found' }]);
			// A file on a board the owner cannot open, under a card they can: 404, not 403.
			const elsewhere = await api('DELETE', `/api/cards/${card.id}/attachments/${theirs.id}`, { user: owner });
			expect([elsewhere.status, elsewhere.body]).toEqual([404, { message: 'Attachment not found' }]);
			// Under its own card, to a caller who cannot open its board: as a card that is not there (card 2719).
			const unopenable = await api('DELETE', `/api/cards/${card.id}/attachments/${file.id}`, { user: outsider });
			expect([unopenable.status, unopenable.body]).toEqual([404, { message: 'Card not found' }]);
			// A card id that is no id is refused as one.
			const bad = await api('DELETE', `/api/cards/abc/attachments/${file.id}`, { user: owner });
			expect([bad.status, bad.body]).toEqual([400, { message: 'Invalid card ID' }]);
		});

		expect(said).toEqual({ entries: [], events: [], webhooks: [] });
		expectUnchanged(before);
		expect(fileIn(card.id, file.filename)).toBe(true);
	});

	// Card 2762, case 6: to a caller who can open the card, whether the file is on it comes before whether they may edit.
	it('tells a viewer of the card 403 for a file on it and 404 for one on another card of the board, removing nothing (card 2762)', async () => {
		const viewer = makeUser({ username: 'viewer' });
		db.insert(boardMembers).values({ boardId: A.board.id, userId: viewer.id, role: 'viewer' }).run();
		const file = makeAttachment(card);
		const elsewhere = makeAttachment(makeCard(A.cols['To Do'], { title: 'Another card' }));
		makeWebhook(A.board);
		const before = snapshotDb();

		const said = await told(async () => {
			const onIt = await api('DELETE', `/api/cards/${card.id}/attachments/${file.id}`, { user: viewer });
			expect([onIt.status, onIt.body]).toEqual([403, { message: 'No edit access to this board' }]);
			const notOnIt = await api('DELETE', `/api/cards/${card.id}/attachments/${elsewhere.id}`, { user: viewer });
			expect([notOnIt.status, notOnIt.body]).toEqual([404, { message: 'Attachment not found' }]);
		});

		expect(said).toEqual({ entries: [], events: [], webhooks: [] });
		expectUnchanged(before);
		expect(fileIn(card.id, file.filename)).toBe(true);
		expect(fileIn(elsewhere.cardId, elsewhere.filename)).toBe(true);
	});

	it('records the delete in the board’s log, by whoever deleted it, and tells the board once it is committed; no webhook (card 2337)', async () => {
		const editor = makeUser({ username: 'editor' });
		const theirs = makeAttachment(card, { name: 'old plan.pdf', uploadedBy: owner });
		db.insert(boardMembers).values({ boardId: A.board.id, userId: editor.id, role: 'editor' }).run();
		makeWebhook(A.board);

		const said = await told(async () => {
			expect((await api('DELETE', `/api/cards/${card.id}/attachments/${theirs.id}`, { user: editor })).status).toBe(200);
		});

		expect(said).toEqual({
			entries: [{ boardId: A.board.id, cardId: card.id, userId: editor.id, action: 'attachment_deleted', detail: 'Deleted the file "old plan.pdf" from "Has files"', source: 'ui' }],
			events: [{ boardId: A.board.id, event: 'update', data: { type: 'attachment', cardId: card.id } }],
			webhooks: []
		});
		expect(rows()).toEqual([]);
		expect(fileIn('.trash', card.id, theirs.filename)).toBe(true);
	});
});

describe('the trash', () => {
	/** A file of `card`, deleted now, and so in the trash. */
	const trashed = async () => {
		const file = makeAttachment(card, { name: 'deleted.txt' });
		expect((await api('DELETE', `/api/cards/${card.id}/attachments/${file.id}`, { user: owner })).status).toBe(200);
		expect(fileIn('.trash', card.id, file.filename)).toBe(true);
		return file;
	};
	const later = (days: number) => new Date(Date.now() + days * DAY);

	it('is emptied of a folder after 30 days, and not before', async () => {
		const file = await trashed();
		expect(TRASH_DAYS).toBe(30);

		expect(emptyTrash()).toEqual({ removed: 0, failed: [] });
		expect(emptyTrash(later(29.9))).toEqual({ removed: 0, failed: [] });
		expect(fileIn('.trash', card.id, file.filename)).toBe(true);

		expect(emptyTrash(later(30.1))).toEqual({ removed: 1, failed: [] });
		expect(fileIn('.trash', card.id)).toBe(false);
		// The trash folder itself stays, empty.
		expect(readdirSync(at('.trash'))).toEqual([]);
	});

	it('dates a folder again when it is added to, so nothing in it goes sooner than 30 days after it arrived', () => {
		const first = makeAttachment(card, { name: 'first.txt' });
		const second = makeAttachment(card, { name: 'second.txt' });
		const start = new Date('2026-01-01T00:00:00.000Z');
		const twentyDaysOn = new Date(start.getTime() + 20 * DAY);

		expect(moveToTrash([ref(first)], start)).toEqual({ moved: 1, missing: 0, failed: [] });
		expect(moveToTrash([ref(second)], twentyDaysOn)).toEqual({ moved: 1, missing: 0, failed: [] });

		// 31 days after the first, 11 after the second.
		expect(emptyTrash(new Date(start.getTime() + 31 * DAY)).removed).toBe(0);
		expect(readdirSync(at('.trash', card.id)).sort()).toEqual(['.trashed-at', first.filename, second.filename].sort());
		expect(emptyTrash(new Date(twentyDaysOn.getTime() + 31 * DAY)).removed).toBe(1);
	});

	it('reaches nothing outside the trash, and nothing in it that it did not put there', async () => {
		const longAgo = new Date(Date.now() - 400 * DAY);
		const old = (path: string) => utimesSync(path, longAgo, longAgo);
		await trashed();

		// A card's folder that nobody has touched for a year.
		const live = makeAttachment(makeCard(A.cols['To Do']), { name: 'live.txt' });
		old(at(live.cardId, live.filename));
		old(at(live.cardId));
		// In the trash: a file, a folder that is not named for a card, and a
		// card's folder with a folder inside it. All of them old.
		writeFileSync(at('.trash', '77'), 'a file, not a folder');
		mkdirSync(at('.trash', 'notes'));
		writeFileSync(at('.trash', 'notes', 'keep.txt'), 'keep');
		mkdirSync(at('.trash', '500', 'nested'), { recursive: true });
		writeFileSync(at('.trash', '500', 'nested', 'deep.txt'), 'deep');
		writeFileSync(at('.trash', '500', 'loose.txt'), 'loose');
		writeFileSync(at('.trash', '500', '.trashed-at'), longAgo.toISOString());
		// And one with no marker, which is dated by when it was last changed.
		mkdirSync(at('.trash', '600'));
		writeFileSync(at('.trash', '600', 'unmarked.txt'), 'unmarked');
		for (const path of [at('.trash', '77'), at('.trash', 'notes'), at('.trash', '600')]) old(path);

		const result = emptyTrash();

		// The unmarked one went. The one with a folder in it lost its files and stayed.
		expect(result.removed).toBe(1);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0]).toMatch(/^500: /);
		expect(readdirSync(at('.trash')).sort()).toEqual([String(card.id), '500', '77', 'notes'].sort());
		expect(readdirSync(at('.trash', '500'))).toEqual(['nested']);
		expect(fileIn('.trash', '500', 'nested', 'deep.txt')).toBe(true);
		expect(fileIn('.trash', 'notes', 'keep.txt')).toBe(true);
		// Today's delete is still there, and so is the old card folder.
		expect(fileIn('.trash', card.id, '.trashed-at')).toBe(true);
		expect(fileIn(live.cardId, live.filename)).toBe(true);
	});

	it('does nothing where there is no trash yet', () => {
		expect(fileIn('.trash')).toBe(false);
		expect(emptyTrash(later(365))).toEqual({ removed: 0, failed: [] });
		expect(fileIn('.trash')).toBe(false);
	});

	// The maintenance starts its timers once in the life of a process and has
	// nothing to stop them, and a test file is one process: so this is one test.
	it('is emptied by the log maintenance ten minutes after the server starts and then every six hours, and not as it starts', async () => {
		const MINUTE = 60 * 1000;
		const file = await trashed();
		vi.useFakeTimers({
			toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
			now: later(31)
		});

		// Called twice. One first run and one interval are waiting, not two of each.
		initLogMaintenance();
		initLogMaintenance();
		expect(vi.getTimerCount()).toBe(2);
		expect(fileIn('.trash', card.id, file.filename)).toBe(true);

		// Ten minutes on, and not a millisecond sooner. A server restarted more
		// often than every six hours used never to get as far as emptying it.
		vi.advanceTimersByTime(10 * MINUTE - 1);
		expect(fileIn('.trash', card.id, file.filename)).toBe(true);
		vi.advanceTimersByTime(1);
		expect(fileIn('.trash', card.id)).toBe(false);
		// That run does not come round again: the interval alone is waiting.
		expect(vi.getTimerCount()).toBe(1);

		// What falls due after it is left until the six-hour tick.
		const second = makeAttachment(makeCard(A.cols['To Do']), { name: 'second.txt' });
		expect(moveToTrash([ref(second)], new Date(Date.now() - 31 * DAY))).toEqual({ moved: 1, missing: 0, failed: [] });
		vi.advanceTimersByTime(6 * 60 * MINUTE - 10 * MINUTE - 1);
		expect(fileIn('.trash', second.cardId, second.filename)).toBe(true);
		vi.advanceTimersByTime(1);
		expect(fileIn('.trash', second.cardId)).toBe(false);
	});
});

describe('an import', () => {
	/** The import route writes two files in the working directory: give it one of its own. */
	const elsewhere = () => {
		const dir = mkdtempSync(join(tmpdir(), 'dumpfire-import-'));
		tempDirs.push(dir);
		vi.spyOn(process, 'cwd').mockReturnValue(dir);
	};
	const importDb = (backup: Uint8Array, admin: SessionUser) =>
		api('POST', '/api/admin/import?outside=keep', {
			user: admin,
			// Their password confirmed first (card 2701).
			headers: { 'content-type': 'application/octet-stream', ...importConfirmation(admin) },
			body: backup
		});

	// The first import of the file loads the import route's modules cold, with
	// every other file loading too: `docker build` runs this.
	it('of a backup taken before a card was deleted puts back the files its rows name', { timeout: 60_000 }, async () => {
		const admin = makeUser({ role: 'superadmin' });
		const other = makeCard(A.cols['To Do'], { title: 'Not deleted' });
		const one = makeAttachment(card, { name: 'one.txt' });
		const two = makeAttachment(card, { name: 'two.txt' });
		const untouched = makeAttachment(other, { name: 'untouched.txt' });
		const backup = sqlite.serialize();

		expect((await api('DELETE', `/api/cards/${card.id}?permanent=true`, { user: owner })).status).toBe(200);
		expect(rows().map((r) => r.id)).toEqual([untouched.id]);
		expect(fileIn(card.id)).toBe(false);
		// A file deleted before the backup was taken has no row in it, and stays in the trash.
		mkdirSync(at('.trash', other.id), { recursive: true });
		writeFileSync(at('.trash', other.id, 'older.txt'), 'deleted long before');
		writeFileSync(at('.trash', other.id, '.trashed-at'), new Date().toISOString());

		elsewhere();
		const res = await importDb(backup, admin);

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.errors).toBeUndefined();
		expect(res.body.attachmentsPutBack).toBe(2);
		expect(res.body.message).toMatch(/\. 2 attachment file\(s\) put back from the trash\.$/);

		expect(rows().map((r) => r.id)).toEqual([one.id, two.id, untouched.id]);
		expect(readFileSync(at(card.id, one.filename), 'utf8')).toBe('The contents of one.txt');
		expect(readFileSync(at(card.id, two.filename), 'utf8')).toBe('The contents of two.txt');
		expect(fileIn(other.id, untouched.filename)).toBe(true);
		// The card's folder of the trash is gone, with its marker. The other is as it was.
		expect(readdirSync(at('.trash'))).toEqual([String(other.id)]);
		expect(readdirSync(at('.trash', other.id)).sort()).toEqual(['.trashed-at', 'older.txt']);

		// And the card opens its file again.
		const served = await api('GET', `/api/cards/${card.id}/attachments/${one.id}`, { user: owner });
		expect(served.body).toBe('The contents of one.txt');
	});

	it('says nothing of the trash when it had nothing to put back', async () => {
		const admin = makeUser({ role: 'superadmin' });
		makeAttachment(card);
		elsewhere();

		const res = await importDb(sqlite.serialize(), admin);

		expect(res.status).toBe(200);
		expect(res.body.attachmentsPutBack).toBe(0);
		expect(res.body.message).not.toMatch(/trash/);
	});

	it('that cannot put a file back says so, and is not undone', async () => {
		const admin = makeUser({ role: 'superadmin' });
		const file = makeAttachment(card, { name: 'stuck.txt' });
		const backup = sqlite.serialize();
		expect((await api('DELETE', `/api/cards/${card.id}?permanent=true`, { user: owner })).status).toBe(200);
		// Something is in the way of the card's folder.
		writeFileSync(at(card.id), 'a file where the folder should be');

		elsewhere();
		const res = await importDb(backup, admin);

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.attachmentsPutBack).toBe(0);
		expect(res.body.errors).toHaveLength(1);
		expect(res.body.errors[0]).toMatch(/^Attachment file not put back from the trash \(card 1, ".*stuck\.txt": /);
		// The rows are in, and the file is still to be had.
		expect(rows().map((r) => r.id)).toEqual([file.id]);
		expect(db.select().from(cards).where(eq(cards.id, card.id)).get()).toBeDefined();
		expect(fileIn('.trash', card.id, file.filename)).toBe(true);
	});

	it('puts back only what is missing, and leaves a file that is in neither place', () => {
		const here = makeAttachment(card, { name: 'here.txt' });
		const nowhere = makeAttachment(card, { name: 'nowhere.txt', file: false });
		// The same name is in the trash as well: the one in the folder wins.
		mkdirSync(at('.trash', card.id), { recursive: true });
		writeFileSync(at('.trash', card.id, here.filename), 'an older copy');

		expect(putBackFromTrash([ref(here), ref(nowhere), { cardId: card.id, filename: '../x' }])).toEqual({
			putBack: 0,
			failed: []
		});
		expect(readFileSync(at(card.id, here.filename), 'utf8')).toBe('The contents of here.txt');
		expect(readFileSync(at('.trash', card.id, here.filename), 'utf8')).toBe('an older copy');
	});
});

// ─── Uploading ──────────────────────────────────────────────────────────────

// Card 2754 (D19, T11): the upload route's file write and its cleanup, moved
// into uploads.ts for both API trees. These were written against the route's
// own behaviour before the move, and the move changed none of it.
describe("an upload's file, written before its row and removed again if the row is not", () => {
	const data = Buffer.from('the bytes');
	const failure = (code: string) => Object.assign(new Error(`${code}: made to fail`), { code });

	it("is written into the card's folder, which it makes, and says it made it", async () => {
		expect(await writeUploadFile(card.id, 'a.txt', data)).toEqual({ cardId: card.id, filename: 'a.txt', madeDir: true });
		expect(readFileSync(at(card.id, 'a.txt'), 'utf8')).toBe('the bytes');
	});

	it('is written into a folder that is there, and says it did not make it', async () => {
		const earlier = makeAttachment(card, { name: 'earlier.txt' });
		expect(await writeUploadFile(card.id, 'b.txt', data)).toEqual({ cardId: card.id, filename: 'b.txt', madeDir: false });
		expect(readdirSync(at(card.id)).sort()).toEqual([earlier.filename, 'b.txt'].sort());
	});

	it('makes the folder again, once, when it goes between the folder made and the file written, and says it made it', async () => {
		mkdirSync(at(card.id), { recursive: true });
		afterMkdir.once = () => rmdirSync(at(card.id));

		expect(await writeUploadFile(card.id, 'c.txt', data)).toEqual({ cardId: card.id, filename: 'c.txt', madeDir: true });
		expect(readFileSync(at(card.id, 'c.txt'), 'utf8')).toBe('the bytes');
		expect(writes.calls).toBe(2);
	});

	it('throws a second ENOENT after that one more try, and removes the folder it made', async () => {
		writes.failures.push({ error: failure('ENOENT') }, { error: failure('ENOENT') });

		await expect(writeUploadFile(card.id, 'd.txt', data)).rejects.toMatchObject({ code: 'ENOENT' });
		expect(writes.calls).toBe(2);
		expect(fileIn(card.id)).toBe(false);
	});

	it('throws any other failure at once, with what it wrote removed, and the folder if it made it', async () => {
		writes.failures.push({ error: failure('EIO'), afterWriting: true });
		await expect(writeUploadFile(card.id, 'e.txt', data)).rejects.toMatchObject({ code: 'EIO' });
		expect(writes.calls).toBe(1);
		expect(fileIn(card.id)).toBe(false);

		// A folder it found stays, with what was in it.
		const earlier = makeAttachment(card, { name: 'earlier.txt' });
		writes.failures.push({ error: failure('ENOSPC'), afterWriting: true });
		await expect(writeUploadFile(card.id, 'f.txt', data)).rejects.toMatchObject({ code: 'ENOSPC' });
		expect(readdirSync(at(card.id))).toEqual([earlier.filename]);
	});

	it("refuses a name that is not a file in the card's own folder before it makes anything", async () => {
		await expect(writeUploadFile(card.id, '../x.txt', data)).rejects.toThrow(UploadPathError);
		expect(fileIn(card.id)).toBe(false);
		expect(writes.calls).toBe(0);
	});

	it('is removed with the folder only if the write made it and nothing else is in it, and the removal never throws', async () => {
		await removeUploadFile(await writeUploadFile(card.id, 'g.txt', data));
		expect(fileIn(card.id)).toBe(false);

		const earlier = makeAttachment(card, { name: 'earlier.txt' });
		await removeUploadFile(await writeUploadFile(card.id, 'h.txt', data));
		expect(readdirSync(at(card.id))).toEqual([earlier.filename]);

		// Made by the write, and another upload's file put in it since: the folder stays.
		const other = makeCard(A.cols['To Do']);
		const first = await writeUploadFile(other.id, 'i.txt', data);
		writeFileSync(at(other.id, 'j.txt'), 'another upload');
		await removeUploadFile(first);
		expect(readdirSync(at(other.id))).toEqual(['j.txt']);

		// A file gone already, and a name that is refused: nothing thrown, nothing else touched.
		await expect(removeUploadFile(first)).resolves.toBeUndefined();
		await expect(removeUploadFile({ cardId: card.id, filename: '../x', madeDir: true })).resolves.toBeUndefined();
		expect(readdirSync(at(card.id))).toEqual([earlier.filename]);
	});
});

describe('uploading an attachment', () => {
	const page = () => new File(['<p>hello</p>'], 'my page.html', { type: 'text/html' });

	it('writes the file and then its row', async () => {
		const res = await upload(card, page());

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			cardId: card.id,
			originalName: 'my page.html',
			mimeType: 'text/html',
			sizeBytes: 12,
			uploadedBy: owner.id
		});
		expect(res.body.filename).toMatch(/^[0-9a-f-]{36}-my_page\.html$/);
		expect(rows()).toHaveLength(1);
		expect(readFileSync(at(card.id, res.body.filename), 'utf8')).toBe('<p>hello</p>');
	});

	it('records the upload in the board’s log, by the uploader, and tells the board once it is committed; no webhook (card 2337)', async () => {
		makeWebhook(A.board);
		let status = 0;
		const said = await told(async () => {
			status = (await upload(card, page())).status;
		});

		expect(status).toBe(200);
		expect(said).toEqual({
			entries: [{ boardId: A.board.id, cardId: card.id, userId: owner.id, action: 'attachment_added', detail: 'Attached "my page.html" to "Has files"', source: 'ui' }],
			events: [{ boardId: A.board.id, event: 'update', data: { type: 'attachment', cardId: card.id } }],
			webhooks: []
		});
	});

	// The card 2337 review: a name's format characters (a right-to-left override,
	// a zero-width space) could reorder or hide part of the entry's line.
	it('quotes the file name in the upload’s and the delete’s entries without its Unicode format characters (card 2337)', async () => {
		const name = 'invoice‮fdp.exe​';
		const res = await upload(card, new File(['x'], name, { type: 'application/octet-stream' }));
		expect(res.status).toBe(200);
		expect(res.body.originalName).toBe(name);
		expect((await api('DELETE', `/api/cards/${card.id}/attachments/${res.body.id}`, { user: owner })).status).toBe(200);

		expect(entries().map((entry) => entry.detail)).toEqual(['Attached "invoicefdp.exe" to "Has files"', 'Deleted the file "invoicefdp.exe" from "Has files"']);
	});

	it('writes no row, no file, no entry and tells nothing when the entry cannot be written (card 2337)', async () => {
		const sent = effects();
		const writes = failingWrite();
		try {
			writes.failNth(2);
			await expect(upload(card, page())).rejects.toThrow(/made to fail/);
			expect(writes.fired).toBe(true);
			await sent.settle();
			expect(sent.events).toEqual([]);
		} finally {
			writes.restore();
			sent.restore();
		}

		expect(rows()).toEqual([]);
		expect(entries()).toEqual([]);
		expect(fileIn(card.id)).toBe(false);
	});

	it('removes the file again if the row cannot be written, and the folder if it made it', async () => {
		const writes = failingWrite();
		try {
			writes.failNth(1);
			await expect(upload(card, page())).rejects.toThrow(/made to fail/);
			expect(writes.fired).toBe(true);
		} finally {
			writes.restore();
		}

		expect(rows()).toEqual([]);
		expect(fileIn(card.id)).toBe(false);
	});

	it('leaves a folder it did not make, with what was in it', async () => {
		const earlier = makeAttachment(card, { name: 'earlier.txt' });
		const writes = failingWrite();
		try {
			writes.failNth(1);
			await expect(upload(card, page())).rejects.toThrow(/made to fail/);
		} finally {
			writes.restore();
		}

		expect(rows().map((r) => r.id)).toEqual([earlier.id]);
		expect(readdirSync(at(card.id))).toEqual([earlier.filename]);
	});

	it('writes no row, and leaves no file, for a card that was deleted while the upload was being read', async () => {
		const mine = page();
		const real = Blob.prototype.arrayBuffer;
		let deleted = false;
		// The route reads the bytes of the file it parsed out of the request,
		// which is not the object made here. The card goes at that moment: after
		// the route's first check of it, and before the row is written.
		vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(function (this: Blob) {
			if (this !== mine && this instanceof File && this.name === mine.name && !deleted) {
				db.delete(cards).where(eq(cards.id, card.id)).run();
				deleted = true;
			}
			return real.call(this);
		});

		const res = await upload(card, mine);

		expect(deleted).toBe(true);
		expect(res.status).toBe(404);
		expect(res.body.message).toBe('Card not found');
		expect(rows()).toEqual([]);
		expect(fileIn(card.id)).toBe(false);
	});

	it('writes the file when the sweep empties and removes the card’s folder between the folder made and the file written (N4)', async () => {
		// The card's folder holds a two-day-old file no row names. The upload's
		// mkdir finds the folder there, the sweep runs on the next turn, moves
		// that file to the trash and removes the folder it left empty, and the
		// write then has no folder to write into.
		mkdirSync(at(card.id), { recursive: true });
		writeFileSync(at(card.id, 'stray.txt'), 'stray');
		const old = new Date(Date.now() - 2 * DAY);
		utimesSync(at(card.id, 'stray.txt'), old, old);
		let swept = false;
		afterMkdir.once = () => {
			swept = sweepUploads()?.emptyRemoved === 1;
		};

		const res = await upload(card, page());

		expect(swept).toBe(true);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(rows()).toHaveLength(1);
		expect(readFileSync(at(card.id, res.body.filename), 'utf8')).toBe('<p>hello</p>');
		expect(fileIn('.trash', card.id, 'stray.txt')).toBe(true);
	});

	it('is refused before anything is written to a caller who cannot edit the card', async () => {
		const outsider = makeUser({ username: 'outsider' });

		// The outsider cannot open the card's board: as a card that is not there (card 2719).
		const refused = await upload(card, page(), outsider);
		expect([refused.status, refused.body]).toEqual([404, { message: 'Card not found' }]);
		expect(rows()).toEqual([]);
		expect(fileIn(card.id)).toBe(false);
	});
});

// ─── An image through the card window (card 2761) ───────────────────────────

describe('uploading an image through the card window (card 2761)', () => {
	const HOUR_MS = 3_600_000;
	const DAY_MS = 86_400_000;
	const hourKey = () => `attachment-upload:user:${owner.id}`;
	const dayKey = () => `attachment-bytes:user:${owner.id}`;
	/** The account's hour and day as they stand, nothing taken. */
	const allowances = () => ({
		hour: allowanceState(hourKey(), UPLOADS_PER_HOUR, HOUR_MS, Date.now()).used,
		day: allowanceState(dayKey(), UPLOAD_BYTES_PER_DAY, DAY_MS, Date.now()).used
	});
	const image = (content: Uint8Array, name = 'shot.png', type = 'image/png') => new File([content as BlobPart], name, { type });
	const pdf = () => new File(['%PDF-1.4 a paper'], 'paper.pdf', { type: 'application/pdf' });
	const daysAgo = (days: number) => stamp(new Date(Date.now() - days * DAY));

	it('1. checks a PNG, takes its metadata out and stores it as <uuid>.png, named by its bytes, through attachImage', async () => {
		const sent = png({ before: [pngChunk('tEXt', 'Comment\0secret-location')] });
		let status = 0;
		let body: Record<string, unknown> = {};
		const said = await told(async () => {
			const res = await upload(card, image(sent, 'photo.PNG'));
			status = res.status;
			body = res.body;
		});

		expect(status, JSON.stringify(body)).toBe(200);
		// attachImage's answer: the row without its name on disk.
		expect(body).not.toHaveProperty('filename');
		const [row] = rows();
		expect(row.filename).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
		const kept = readFileSync(at(card.id, row.filename));
		// The PNG without its tEXt chunk: what the same image made without one is.
		expect(Buffer.compare(kept, Buffer.from(png()))).toBe(0);
		expect(kept.toString('latin1')).not.toContain('secret-location');
		expect(row).toMatchObject({ originalName: 'photo.png', mimeType: 'image/png', sizeBytes: png().length, uploadedBy: owner.id });
		expect(body).toMatchObject({ id: row.id, originalName: 'photo.png', mimeType: 'image/png', sizeBytes: png().length });
		expect(said.entries).toEqual([
			{ boardId: A.board.id, cardId: card.id, userId: owner.id, action: 'attachment_added', detail: 'Attached "photo.png" to "Has files"', source: 'ui' }
		]);
		expect(said.events).toEqual([{ boardId: A.board.id, event: 'update', data: { type: 'attachment', cardId: card.id } }]);
	});

	it('2. refuses bytes that are not the declared type 415, and an image with bytes after its end 400, writing nothing', async () => {
		const notPng = await upload(card, image(jpeg(), 'shot.png', 'image/png'));
		expect([notPng.status, notPng.body.message]).toEqual([415, 'The body is a JPEG image, not the image/png its Content-Type says']);

		const trailing = await upload(card, image(bytes(png(), 'a second file'), 'shot.png', 'image/png'));
		expect(trailing.status).toBe(400);
		expect(trailing.body.message).toBe('The PNG image is not valid: there are bytes after IEND');

		expect(rows()).toEqual([]);
		expect(entries()).toEqual([]);
		expect(fileIn(card.id)).toBe(false);
	});

	it('3. refuses the 21st image on a card 409, however the 20 were typed, and removes its file and the folder it made; a PDF is still taken', async () => {
		// Rows alone (E17); some typed as the card window stored them before card 2761.
		for (let i = 0; i < 20; i++) {
			makeAttachment(card, { name: `shot-${i}.jpg`, mimeType: i % 2 === 0 ? 'IMAGE/JPEG' : 'image/png', file: false });
		}

		const refused = await upload(card, image(png()));
		expect([refused.status, refused.body.message]).toEqual([409, 'This card already has 20 images']);
		expect(rows()).toHaveLength(20);
		expect(entries()).toEqual([]);
		expect(fileIn(card.id)).toBe(false);

		const paper = await upload(card, pdf());
		expect(paper.status).toBe(200);
		expect(paper.body).toMatchObject({ originalName: 'paper.pdf', mimeType: 'application/pdf' });
		expect(rows()).toHaveLength(21);
	});

	it('4. refuses an image for a card closed longer than IMAGE_RETENTION_DAYS 409, writing nothing; a PDF is taken, and with retention off the image', async () => {
		const closed = makeCard(A.cols['Complete'], { title: 'Shipped', completedAt: daysAgo(181) });

		const refused = await upload(closed, image(png()));
		expect([refused.status, refused.body.message]).toEqual([
			409,
			'This card was closed more than 180 days ago, so its images are moved to the trash: reopen or restore it to attach one'
		]);
		expect(rows()).toEqual([]);
		expect(entries()).toEqual([]);
		expect(fileIn(closed.id)).toBe(false);

		expect((await upload(closed, pdf())).status).toBe(200);

		vi.stubEnv('IMAGE_RETENTION_DAYS', 'off');
		try {
			expect((await upload(closed, image(png()))).status).toBe(200);
		} finally {
			vi.unstubAllEnvs();
		}
		expect(rows().map((row) => row.mimeType)).toEqual(['application/pdf', 'image/png']);
	});

	it("5. shares the account's hour with /api/v1: one left, a key's upload takes it and the card window's image is 429; a PDF takes nothing", async () => {
		expect(takeAllowance(hourKey(), UPLOADS_PER_HOUR - 1, UPLOADS_PER_HOUR, HOUR_MS).taken).toBe(true);

		const byKey = await api('POST', `/api/v1/cards/${card.id}/attachments?name=shot.png`, {
			user: owner,
			body: png(),
			headers: { 'content-type': 'image/png' }
		});
		expect(byKey.status).toBe(201);

		const refused = await upload(card, image(png()));
		expect(refused.status).toBe(429);
		expect(refused.body.message).toMatch(/^An account can upload at most 30 images an hour\. Nothing was written\. Try again in \d+ minute\(s\)\.$/);
		expect(refused.headers.get('retry-after')).toBe(String(refused.body.retryAfterSecs));
		expect(refused.body.retryAfterSecs).toBeGreaterThan(0);
		expect(rows()).toHaveLength(1);

		// The PDF arm (E13): read before and after, nothing taken from either.
		const before = allowances();
		expect(before).toEqual({ hour: UPLOADS_PER_HOUR, day: png().length });
		expect((await upload(card, pdf())).status).toBe(200);
		expect(allowances()).toEqual(before);
	});

	it("6. shares the account's day, charged with the bytes read before they are checked", async () => {
		const sentPng = png();
		const sentJpeg = jpeg();
		// One byte short of the PNG.
		takeAllowance(dayKey(), UPLOAD_BYTES_PER_DAY - (sentPng.length - 1), UPLOAD_BYTES_PER_DAY, DAY_MS);
		const short = await upload(card, image(sentPng));
		expect(short.status).toBe(429);
		expect(short.body.message).toMatch(/^An account can upload at most 100 MB of images a day, and this image would pass it\. Nothing was written\. Try again in \d+ (hour|minute)\(s\)\.$/);
		expect(short.headers.get('retry-after')).toBe(String(short.body.retryAfterSecs));

		// Room for a JPEG sent as a PNG and one byte short of a PNG after it: the JPEG is refused at the check,
		// and still charged, so the PNG no longer fits.
		resetAllRateLimits();
		takeAllowance(dayKey(), UPLOAD_BYTES_PER_DAY - (sentJpeg.length + sentPng.length - 1), UPLOAD_BYTES_PER_DAY, DAY_MS);
		expect((await upload(card, image(sentJpeg, 'shot.png', 'image/png'))).status).toBe(415);
		expect((await upload(card, image(sentPng))).status).toBe(429);
		expect(rows()).toEqual([]);
		expect(fileIn(card.id)).toBe(false);
	});

	it('7. is 401 for a session ended while the form is read, with nothing taken from either allowance and nothing written (E16)', async () => {
		const token = makeSession(owner);
		const mine = image(png());
		const real = Blob.prototype.arrayBuffer;
		let ended = false;
		// The route reads the bytes of the file it parsed out of the request: the session ends then, after
		// the route's first check of the card and before the writeAs that counts the upload.
		vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(function (this: Blob) {
			if (this !== mine && this instanceof File && this.name === mine.name && !ended) {
				db.delete(sessions).where(eq(sessions.tokenHash, sessionHashOf(token))).run();
				ended = true;
			}
			return real.call(this);
		});
		const form = new FormData();
		form.set('file', mine);

		const res = await api('POST', `/api/cards/${card.id}/attachments`, { user: owner, body: form, credential: sessionCredential(token) });

		expect(ended).toBe(true);
		expect([res.status, res.body.message]).toEqual([401, 'Not authenticated']);
		expect(allowances()).toEqual({ hour: 0, day: 0 });
		expect(rows()).toEqual([]);
		expect(entries()).toEqual([]);
		expect(fileIn(card.id)).toBe(false);
	});
});

// ─── Serving ────────────────────────────────────────────────────────────────

describe('serving an attachment', () => {
	/** Open a file. */
	const opened = async (id: number) => {
		const res = await api('GET', `/api/cards/${card.id}/attachments/${id}`, { user: owner });
		expect(res.status).toBe(200);
		return res;
	};
	/** Upload a file and open it: only a file the card window's upload accepts (card 2761). */
	const served = async (name: string, type: string, content: string | Uint8Array = 'x') => {
		const sent = await upload(card, new File([content as BlobPart], name, { type }));
		expect(sent.status, `${name} as ${type}: ${JSON.stringify(sent.body)}`).toBe(200);
		return opened(sent.body.id);
	};
	/**
	 * A row and its file as the card window stored them before card 2761, the
	 * type and the name as the browser claimed them, and open it. Such a row is
	 * still served by these rules, whatever the one-off check of stored images
	 * later makes of it.
	 */
	const stored = (name: string, type: string, content: string | Uint8Array = 'x') =>
		opened(makeAttachment(card, { name, mimeType: type, content }).id);
	const disposition = (res: { headers: Headers }) => res.headers.get('content-disposition') ?? '';
	/** Bytes that are an image of `type`, for one of the four; anything else is a byte of text. */
	const contentOf = (type: string): string | Uint8Array =>
		({ 'image/png': png(), 'image/jpeg': jpeg(), 'image/gif': gif(), 'image/webp': webp() } as Record<string, Uint8Array>)[type.split(';')[0]] ?? 'x';

	it('answers an HTML, an SVG or a PDF upload as a download, and never as a page', async () => {
		for (const [name, type] of [
			['page.html', 'text/html'],
			['page.htm', 'text/html; charset=utf-8'],
			['drawing.svg', 'image/svg+xml'],
			['paper.pdf', 'application/pdf'],
			['script.js', 'text/javascript'],
			['data.xml', 'application/xml'],
			['archive.zip', 'application/zip'],
			['unknown', '']
		]) {
			const res = await served(name, type, '<script>alert(1)</script>');
			expect(disposition(res), name).toMatch(/^attachment; /);
			expect(res.headers.get('content-type'), name).toBe('application/octet-stream');
			// The bytes are what was uploaded.
			expect(res.body).toBe('<script>alert(1)</script>');
		}
	});

	it('shows a PNG, a JPEG, a GIF, a WebP and plain text in the browser, each as its own type', async () => {
		for (const [name, type, as] of [
			['shot.png', 'image/png', 'image/png'],
			['photo.jpg', 'image/jpeg', 'image/jpeg'],
			['photo.JPEG', 'image/jpeg', 'image/jpeg'],
			['moving.gif', 'image/gif', 'image/gif'],
			['small.webp', 'image/webp', 'image/webp'],
			['notes.txt', 'text/plain', 'text/plain; charset=utf-8']
		]) {
			const res = await served(name, type, contentOf(type));
			expect(disposition(res), name).toMatch(/^inline; /);
			expect(res.headers.get('content-type'), name).toBe(as);
		}
	});

	// Card 2754 (S12): the name and the stored type are both the uploader's, so
	// an image is shown only when its bytes are that image too.
	it('shows an image only when its bytes are that image, and answers any other as a download (card 2754)', async () => {
		for (const [name, type, content] of [
			['shot.png', 'image/png', '<script>alert(1)</script>'],
			['shot.png', 'image/png', jpeg()],
			['photo.jpg', 'image/jpeg', png()],
			['moving.gif', 'image/gif', 'GIF8'],
			['small.webp', 'image/webp', bytes('RIFF', le32(4), 'WAVE')]
		] as const) {
			// Stored as the card window stored them before card 2761: its upload now refuses each (415 or 400).
			const res = await stored(name, type, content);
			expect(disposition(res), `${name} holding ${String(content).slice(0, 10)}`).toMatch(/^attachment; /);
			expect(res.headers.get('content-type'), name).toBe('application/octet-stream');
		}

		// Text has no magic bytes: it is shown as text whatever it holds, and nosniff keeps it text.
		const notes = await served('notes.txt', 'text/plain', '<script>alert(1)</script>');
		expect(disposition(notes)).toMatch(/^inline; /);
		expect(notes.headers.get('content-type')).toBe('text/plain; charset=utf-8');

		expect(attachmentHeaders({ originalName: 'shot.png', mimeType: 'image/png' }, png())['Content-Disposition']).toMatch(/^inline; /);
		expect(attachmentHeaders({ originalName: 'shot.png', mimeType: 'image/png' }, new Uint8Array())['Content-Type']).toBe('application/octet-stream');
	});

	it('needs the stored type and the name to agree before it shows anything', async () => {
		for (const [name, type] of [
			// Named as an image, uploaded as a page; and the other way about.
			['looks-like.png', 'text/html'],
			['page.html', 'image/png'],
			['drawing.svg', 'image/png'],
			['shot.png', 'image/svg+xml'],
			['photo.jpg', 'image/png'],
			['notes.txt', 'text/html'],
			['shot.png.html', 'image/png']
		]) {
			// The bytes are the stored type's image where it is one, so that only the name disagrees. An image
			// type is stored as before card 2761, whose upload names an image by its bytes' extension.
			const res = imageTypeOf(type) ? await stored(name, type, contentOf(type)) : await served(name, type, contentOf(type));
			expect(disposition(res), `${name} as ${type}`).toMatch(/^attachment; /);
			expect(res.headers.get('content-type'), `${name} as ${type}`).toBe('application/octet-stream');
		}
		// A type is compared without its parameters and whatever its case.
		expect(attachmentHeaders({ originalName: 'A.PNG', mimeType: 'IMAGE/PNG; q=1' }, png())['Content-Type']).toBe('image/png');
	});

	it('sandboxes every answer, and forbids sniffing the type of every one', async () => {
		for (const [name, type] of [
			['page.html', 'text/html'],
			['drawing.svg', 'image/svg+xml'],
			['shot.png', 'image/png'],
			['notes.txt', 'text/plain'],
			['paper.pdf', 'application/pdf'],
			// Named as a PDF and uploaded as a page.
			['paper.pdf', 'text/html']
		]) {
			// A byte that is no PNG, typed as one, as stored before card 2761.
			const res = imageTypeOf(type) ? await stored(name, type) : await served(name, type);
			expect(res.headers.get('content-security-policy'), name).toBe('sandbox');
			expect(res.headers.get('x-content-type-options'), name).toBe('nosniff');
			expect(res.headers.get('content-length'), name).toBe('1');
		}
	});

	it('encodes the file name, which is the uploader\'s, instead of writing it into the header', async () => {
		const res = await served('résumé "final"\r\nSet-Cookie: x=1 (v2).pdf', 'application/pdf');

		// A quote or a line break in it used to end the value and start another header.
		expect(disposition(res)).toBe(
			'attachment; filename="r_sum_ _final___Set-Cookie: x=1 (v2).pdf"; ' +
				"filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22%0D%0ASet-Cookie%3A%20x%3D1%20%28v2%29.pdf"
		);
		expect(res.headers.get('set-cookie')).toBeNull();
		expect(attachmentHeaders({ originalName: '', mimeType: 'text/plain' }, new Uint8Array())['Content-Disposition']).toBe(
			"attachment; filename=\"download\"; filename*=UTF-8''download"
		);
	});

	it('is refused to a caller who cannot view the card, and says so when the file is not on the disk', async () => {
		const file = makeAttachment(card);
		const missing = makeAttachment(card, { file: false });
		const outsider = makeUser({ username: 'outsider' });

		// The outsider cannot open the card's board: as a card that is not there (card 2719).
		const refused = await api('GET', `/api/cards/${card.id}/attachments/${file.id}`, { user: outsider });
		expect([refused.status, refused.body]).toEqual([404, { message: 'Card not found' }]);
		const gone = await api('GET', `/api/cards/${card.id}/attachments/${missing.id}`, { user: owner });
		expect(gone.status).toBe(404);
		expect(gone.body.message).toBe('File not found on disk');
	});

	// Card 2361: served under the address of any card, as the delete was. Since card 2762 the card is asked
	// first, so only a caller who can open it is told whether the file is on it.
	it('is 404 under the address of a card it is not on, once the caller can open that card (cards 2361, 2762)', async () => {
		const file = makeAttachment(card, { name: 'notes.txt' });
		const other = makeCard(A.cols['To Do'], { title: 'Has none' });
		const B = makeBoard({ name: 'B' });
		const theirs = makeAttachment(makeCard(B.cols['To Do'], { title: 'Not theirs' }));
		const outsider = makeUser({ username: 'outsider' });

		const res = await api('GET', `/api/cards/${other.id}/attachments/${file.id}`, { user: owner });
		expect([res.status, res.body]).toEqual([404, { message: 'Attachment not found' }]);
		// A file on a board the caller cannot open, under a card they can: 404, not 403.
		const elsewhere = await api('GET', `/api/cards/${card.id}/attachments/${theirs.id}`, { user: owner });
		expect([elsewhere.status, elsewhere.body]).toEqual([404, { message: 'Attachment not found' }]);
		// Under its own card: 404 to an outsider, who cannot open its board (card 2719), and the file to the owner.
		const unopenable = await api('GET', `/api/cards/${card.id}/attachments/${file.id}`, { user: outsider });
		expect([unopenable.status, unopenable.body]).toEqual([404, { message: 'Card not found' }]);
		const own = await api('GET', `/api/cards/${card.id}/attachments/${file.id}`, { user: owner });
		expect([own.status, own.body]).toEqual([200, 'The contents of notes.txt']);
		const bad = await api('GET', `/api/cards/abc/attachments/${file.id}`, { user: owner });
		expect([bad.status, bad.body]).toEqual([400, { message: 'Invalid card ID' }]);
	});
});
