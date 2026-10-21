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
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { activityLog, boardMembers, cardAttachments, cards, type Card, type CardAttachment } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { initLogMaintenance } from '$lib/server/logger';
import {
	attachmentHeaders,
	attachmentPath,
	emptyTrash,
	moveToTrash,
	putBackFromTrash,
	resolveUploadsDir,
	TRASH_DAYS,
	UploadPathError,
	UploadsDirError
} from '$lib/server/uploads';
import { api } from './helpers/api';
import { eachWriteInTurn } from './helpers/each-write';
import { effects } from './helpers/effects';
import { failingWrite } from './helpers/failing-write';
import {
	makeAttachment,
	makeBoard,
	makeCard,
	makeUser,
	makeWebhook,
	resetDb,
	testUploadsDir,
	type BoardFixture
} from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';
import { sweepUploads } from '$lib/server/uploads-sweep';

// The upload route's `mkdir`, with a hook a test can set to run straight after
// it once: where the sweep can run, between the folder made and the file
// written. Every other call is the real one.
const afterMkdir = vi.hoisted(() => ({ once: null as null | (() => void) }));
vi.mock('fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs/promises')>();
	const mkdir = (async (...args: Parameters<typeof actual.mkdir>) => {
		const made = await actual.mkdir(...args);
		const hook = afterMkdir.once;
		afterMkdir.once = null;
		hook?.();
		return made;
	}) as typeof actual.mkdir;
	return { ...actual, default: { ...actual, mkdir }, mkdir };
});

const DAY = 86_400_000;

let owner: SessionUser;
let A: BoardFixture;
let card: Card;
const tempDirs: string[] = [];

beforeEach(() => {
	resetDb();
	owner = makeUser({ username: 'owner' });
	A = makeBoard({ owner, name: 'A' });
	card = makeCard(A.cols['To Do'], { title: 'Has files' });
});

afterEach(() => {
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
			expect((await api('DELETE', `/api/cards/${card.id}/attachments/${file.id}`, { user: outsider })).status).toBe(403);
			expect((await api('DELETE', `/api/cards/${card.id}/attachments/99999`, { user: owner })).status).toBe(404);
		});

		expect(said).toEqual({ entries: [], events: [], webhooks: [] });
		expectUnchanged(before);
		expect(fileIn(card.id, file.filename)).toBe(true);
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
			headers: { 'content-type': 'application/octet-stream' },
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

		expect((await upload(card, page(), outsider)).status).toBe(403);
		expect(rows()).toEqual([]);
		expect(fileIn(card.id)).toBe(false);
	});
});

// ─── Serving ────────────────────────────────────────────────────────────────

describe('serving an attachment', () => {
	/** Upload a file and open it. */
	const served = async (name: string, type: string, content = 'x') => {
		const sent = await upload(card, new File([content], name, { type }));
		expect(sent.status).toBe(200);
		const res = await api('GET', `/api/cards/${card.id}/attachments/${sent.body.id}`, { user: owner });
		expect(res.status).toBe(200);
		return res;
	};
	const disposition = (res: { headers: Headers }) => res.headers.get('content-disposition') ?? '';

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
			const res = await served(name, type);
			expect(disposition(res), name).toMatch(/^inline; /);
			expect(res.headers.get('content-type'), name).toBe(as);
		}
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
			const res = await served(name, type);
			expect(disposition(res), `${name} as ${type}`).toMatch(/^attachment; /);
			expect(res.headers.get('content-type'), `${name} as ${type}`).toBe('application/octet-stream');
		}
		// A type is compared without its parameters and whatever its case.
		expect(attachmentHeaders({ originalName: 'A.PNG', mimeType: 'IMAGE/PNG; q=1' })['Content-Type']).toBe('image/png');
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
			const res = await served(name, type);
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
		expect(attachmentHeaders({ originalName: '', mimeType: 'text/plain' })['Content-Disposition']).toBe(
			"attachment; filename=\"download\"; filename*=UTF-8''download"
		);
	});

	it('is refused to a caller who cannot view the card, and says so when the file is not on the disk', async () => {
		const file = makeAttachment(card);
		const missing = makeAttachment(card, { file: false });
		const outsider = makeUser({ username: 'outsider' });

		expect((await api('GET', `/api/cards/${card.id}/attachments/${file.id}`, { user: outsider })).status).toBe(403);
		const gone = await api('GET', `/api/cards/${card.id}/attachments/${missing.id}`, { user: owner });
		expect(gone.status).toBe(404);
		expect(gone.body.message).toBe('File not found on disk');
	});
});
