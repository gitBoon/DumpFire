/**
 * The sweep of attachment files no row names (card 2107): what it moves to
 * the trash, everything it leaves alone, when it runs, and that it runs only
 * where the schedulers run.
 *
 * Every file here is under the tests' own uploads folder, which
 * `tests/setup.ts` makes under the operating system's temp folder and
 * `resetDb()` empties, or under a temp folder of the test's own. Nothing here
 * goes near ./uploads. Ages are set with `utimesSync`.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { cardAttachments, type Card } from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import type { SessionUser } from '$lib/server/auth';
import { initBackupScheduler } from '$lib/server/backup';
import { initReportScheduler } from '$lib/server/reports';
import { startSchedulers } from '$lib/server/schedulers';
import { initSnapshotScheduler } from '$lib/server/snapshots';
import { initUploadsSweep, sweepUploads, SWEEP_MARGIN_MS } from '$lib/server/uploads-sweep';
import { api } from './helpers/api';
import { makeAttachment, makeBoard, makeCard, makeUser, resetDb, testUploadsDir, type BoardFixture } from './helpers/fixtures';

// The other schedulers would start real timers that read the database and
// reach for the network. The sweep's own start is watched, and still runs.
vi.mock('$lib/server/backup', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/backup')>()),
	initBackupScheduler: vi.fn()
}));
vi.mock('$lib/server/reports', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/reports')>()),
	initReportScheduler: vi.fn()
}));
vi.mock('$lib/server/snapshots', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/snapshots')>()),
	initSnapshotScheduler: vi.fn()
}));
vi.mock('$lib/server/uploads-sweep', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/uploads-sweep')>();
	return { ...actual, initUploadsSweep: vi.fn(actual.initUploadsSweep) };
});

const DAY = 86_400_000;
const MINUTE = 60_000;

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
const twoDaysAgo = () => new Date(Date.now() - 2 * DAY);
/** Set a path's times to `when`, two days ago unless said. */
const age = (path: string, when: Date = twoDaysAgo()) => utimesSync(path, when, when);

/** A file in `parts`, written now, and two days old unless `fresh`. */
function put(parts: (string | number)[], { fresh = false } = {}): string {
	const path = at(...parts);
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, `stray ${parts.join('/')}`);
	if (!fresh) age(path);
	return path;
}

/** A temp folder of the test's own, outside the uploads folder. */
function outside(): string {
	const dir = mkdtempSync(join(tmpdir(), 'dumpfire-sweep-outside-'));
	tempDirs.push(dir);
	return dir;
}

/** Run `fn` and give back the log lines it wrote at INFO and above, quietly. */
function logged<T>(fn: () => T): { result: T; lines: string[] } {
	process.env.LOG_LEVEL = 'INFO';
	const lines: string[] = [];
	const keep = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
	vi.spyOn(console, 'log').mockImplementation(keep);
	vi.spyOn(console, 'warn').mockImplementation(keep);
	vi.spyOn(console, 'error').mockImplementation(keep);
	return { result: fn(), lines };
}

describe('the sweep moves to the trash', () => {
	it('a file no row names, older than 24 hours, and the card folder it left empty', () => {
		put([card.id, 'stray.txt']);
		const { result, lines } = logged(() => sweepUploads());

		expect(result).toMatchObject({ moved: 1, folders: 1, emptyRemoved: 1, tooNew: 0, failed: [] });
		expect(readFileSync(at('.trash', card.id, 'stray.txt'), 'utf8')).toBe(`stray ${card.id}/stray.txt`);
		expect(fileIn('.trash', card.id, '.trashed-at')).toBe(true);
		expect(fileIn(card.id)).toBe(false);
		expect(lines.filter((line) => line.includes('[UPLOADS]'))).toEqual([
			expect.stringMatching(
				/\[INFO\] \[UPLOADS\] Moved 1 attachment file\(s\) that no attachment names to the trash, from 1 card folder\(s\); 1 card folder\(s\) left empty were removed$/
			)
		]);
	});

	it('only the unnamed files of a folder, which stays while a named file is in it', () => {
		const named = makeAttachment(card, { name: 'named.txt' });
		age(at(card.id, named.filename));
		put([card.id, 'stray.txt']);

		expect(sweepUploads()).toMatchObject({ moved: 1, folders: 1, emptyRemoved: 0 });
		expect(fileIn(card.id, named.filename)).toBe(true);
		expect(fileIn('.trash', card.id, 'stray.txt')).toBe(true);
	});

	it('a file left by a card deleted with no trash, whose folder number is still below the counter', () => {
		const gone = makeCard(A.cols['To Do'], { title: 'Deleted long ago' });
		const file = makeAttachment(gone, { name: 'left.txt' });
		age(at(gone.id, file.filename));
		// The rows go and the file stays, as a permanent delete did before the trash.
		sqlite.prepare('DELETE FROM cards WHERE id = ?').run(gone.id);
		expect(db.select().from(cardAttachments).all()).toEqual([]);

		expect(sweepUploads()).toMatchObject({ moved: 1, otherDatabase: [] });
		expect(fileIn('.trash', gone.id, file.filename)).toBe(true);
	});
});

describe('the sweep leaves alone', () => {
	it('a named file, a young file, a folder in a card folder, the trash, a folder that is not a card id, and an empty folder', () => {
		const named = makeAttachment(card, { name: 'named.txt' });
		age(at(card.id, named.filename));
		put([card.id, 'young.txt'], { fresh: true });
		put([card.id, 'sub', 'deep.txt']);
		age(at(card.id, 'sub'));
		put(['.trash', card.id, 'old-in-trash.txt']);
		put(['notes', 'keep.txt']);
		age(at('notes'));
		const empty = makeCard(A.cols['To Do'], { title: 'Folder with nothing in it' });
		mkdirSync(at(empty.id));
		age(at(empty.id), new Date(Date.now() - 400 * DAY));
		const before = readdirSync(testUploadsDir(), { recursive: true }).sort();

		const { result, lines } = logged(() => sweepUploads());

		expect(result).toMatchObject({ moved: 0, folders: 0, emptyRemoved: 0, tooNew: 1, otherDatabase: [], failed: [] });
		expect(result?.notCardFolders).toEqual(['notes']);
		expect(readdirSync(testUploadsDir(), { recursive: true }).sort()).toEqual(before);
		// R11: a folder it found empty is not removed, however old.
		expect(fileIn(empty.id)).toBe(true);
		expect(lines.filter((line) => line.includes('[UPLOADS]'))).toEqual([
			expect.stringMatching(/\[WARN\] \[UPLOADS\] 1 name\(s\) in the uploads folder are not a card's folder, and were left alone: "notes"$/)
		]);
	});

	it('a folder numbered above the highest card id this database has issued, with a WARN', () => {
		const above = card.id + 100;
		put([above, 'theirs.txt']);
		age(at(above));

		const { result, lines } = logged(() => sweepUploads());

		expect(result).toMatchObject({ moved: 0, otherDatabase: [String(above)] });
		expect(fileIn(above, 'theirs.txt')).toBe(true);
		expect(lines).toContainEqual(
			expect.stringMatching(
				new RegExp(
					`\\[WARN\\] \\[UPLOADS\\] 1 folder\\(s\\) in the uploads folder are numbered above the highest card id ` +
						`this database has issued \\(${card.id}\\), so were made by another database, and were left alone: ${above}$`
				)
			)
		);
	});

	it('the files of a folder named with a leading zero, though the move would be given the same card id (R4)', () => {
		const named = makeAttachment(card, { name: 'same.txt' });
		age(at(card.id, named.filename));
		// The same name, in a folder that reads as the same number.
		const zero = `0${card.id}`;
		put([zero, named.filename]);
		put([zero, 'unnamed.txt']);
		age(at(zero));

		const result = sweepUploads();

		expect(result).toMatchObject({ moved: 0, notCardFolders: [zero] });
		expect(readFileSync(at(card.id, named.filename), 'utf8')).toBe('The contents of same.txt');
		expect(readdirSync(at(zero)).sort()).toEqual([named.filename, 'unnamed.txt'].sort());
		expect(fileIn('.trash')).toBe(false);
	});

	it('a file whose name differs from a row’s only in case, which is that row’s file where names are not told apart by case (N5)', () => {
		// On Windows and on macOS, `Notes.TXT` and `notes.txt` are one file: the
		// row reads it, and the sweep took it for a file no row names.
		const row = makeAttachment(card, { name: 'x.txt', file: false });
		db.update(cardAttachments).set({ filename: 'Notes.TXT' }).run();
		put([card.id, 'notes.txt']);

		expect(sweepUploads()).toMatchObject({ moved: 0, failed: [] });
		expect(readdirSync(at(card.id))).toEqual(['notes.txt']);
		expect(db.select().from(cardAttachments).all().map((r) => r.id)).toEqual([row.id]);
	});

	it('counts the files it leaves only because a row names them in another case, and names the count in a WARN', () => {
		// Where names are told apart by case (Linux), no row reads such a file,
		// and it was left with nothing said (the second P6 review).
		const exact = makeAttachment(card, { name: 'exact.txt' });
		age(at(card.id, exact.filename));
		const other = makeCard(A.cols['To Do'], { title: 'Case only' });
		const row = makeAttachment(other, { name: 'x.txt', file: false });
		db.update(cardAttachments).set({ filename: 'Notes.TXT' }).where(eq(cardAttachments.id, row.id)).run();
		put([other.id, 'notes.txt']);

		const { result, lines } = logged(() => sweepUploads());

		expect(result).toMatchObject({ moved: 0, caseOnly: 1, failed: [] });
		expect(fileIn(other.id, 'notes.txt')).toBe(true);
		expect(lines.filter((line) => line.includes('[UPLOADS]'))).toEqual([
			expect.stringMatching(
				/\[WARN\] \[UPLOADS\] 1 attachment file\(s\) were left alone because an attachment names each only in another case: .+ look at them by hand$/
			)
		]);
	});

	it('a file just written with no row yet, as an upload in progress leaves it', () => {
		// The upload writes the file, then the row: between the two, the file has no row.
		put([card.id, `${crypto.randomUUID()}-in-progress.txt`], { fresh: true });

		expect(sweepUploads()).toMatchObject({ moved: 0, tooNew: 1 });
		expect(readdirSync(at(card.id))).toHaveLength(1);
	});

	it('a file changed just inside the margin, and moves it once the margin has passed', () => {
		const path = put([card.id, 'edge.txt']);
		const changed = new Date('2026-10-14T08:00:00.000Z');
		age(path, changed);

		expect(sweepUploads(new Date(changed.getTime() + SWEEP_MARGIN_MS - 1000))).toMatchObject({ moved: 0, tooNew: 1 });
		expect(sweepUploads(new Date(changed.getTime() + SWEEP_MARGIN_MS + 1000))).toMatchObject({ moved: 1, tooNew: 0 });
	});
});

describe('the sweep reaches nothing outside the uploads folder', () => {
	it.each([
		['the trash', ['.trash']],
		['the card’s folder in the trash', ['.trash', 'CARD']]
	])('moves nothing into %s when it is a link, and says so in a WARN (S3)', (_where, parts) => {
		// mkdir with `recursive` takes a link to a folder for the folder, and the
		// move then wrote the marker and the file wherever the link pointed.
		const away = outside();
		const linkAt = at(...parts.map((part) => (part === 'CARD' ? card.id : part)));
		mkdirSync(join(linkAt, '..'), { recursive: true });
		symlinkSync(away, linkAt, 'junction');
		put([card.id, 'stray.txt']);

		const { result, lines } = logged(() => sweepUploads());

		expect(result).toMatchObject({ moved: 0, folders: 0 });
		expect(result?.failed).toEqual([expect.stringMatching(/is a link, or not a folder: nothing is moved into it/)]);
		expect(readdirSync(away)).toEqual([]);
		expect(fileIn(card.id, 'stray.txt')).toBe(true);
		expect(lines).toContainEqual(
			expect.stringMatching(/\[WARN\] \[UPLOADS\] 1 attachment file\(s\) that no attachment names could not be moved to the trash, and are where they were: /)
		);
	});

	it('follows no link, and a row whose name climbs out names nothing it moves', () => {
		const away = outside();
		const target = join(away, 'outside.txt');
		writeFileSync(target, 'not an upload');
		age(target);
		// A card's folder that is a link to a folder outside.
		const linked = makeCard(A.cols['To Do'], { title: 'Folder is a link' });
		mkdirSync(testUploadsDir(), { recursive: true });
		symlinkSync(away, at(linked.id), 'junction');
		// A row whose file name climbs out of its folder, to that same file.
		makeAttachment(card, { name: 'x.txt', file: false });
		db.update(cardAttachments).set({ filename: '../../outside.txt' }).run();
		// And, where the system allows it, a link to the file inside a real card folder.
		put([card.id, 'stray.txt']);
		let fileLink = false;
		try {
			symlinkSync(target, at(card.id, 'link.txt'), 'file');
			fileLink = true;
		} catch {
			// Windows without developer mode cannot make a file link. The folder link above still counts.
		}

		const result = sweepUploads();

		expect(result).toMatchObject({ moved: 1, failed: [], notCardFolders: [String(linked.id)] });
		expect(readFileSync(target, 'utf8')).toBe('not an upload');
		expect(readdirSync(away)).toEqual(['outside.txt']);
		expect(fileIn('.trash', card.id, 'stray.txt')).toBe(true);
		if (fileLink) {
			expect(readdirSync(at(card.id))).toEqual(['link.txt']);
			expect(fileIn('.trash', card.id, 'link.txt')).toBe(false);
		}
	});
});

describe('the sweep and the database', () => {
	it('does nothing while a transaction is open on the connection', () => {
		put([card.id, 'stray.txt']);

		const inside = inTransaction(() => sweepUploads());

		expect(inside).toBeNull();
		expect(fileIn(card.id, 'stray.txt')).toBe(true);
		expect(sweepUploads()).toMatchObject({ moved: 1 });
	});

	it('moves nothing, and says so, when the rows cannot be read (R10)', () => {
		put([card.id, 'stray.txt']);
		const prepare = sqlite.prepare.bind(sqlite);
		vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
			if (source.includes('card_attachments')) throw new Error('no such table: card_attachments');
			return prepare(source);
		}) as typeof sqlite.prepare);

		const { result, lines } = logged(() => sweepUploads());

		expect(result).toBeNull();
		expect(fileIn(card.id, 'stray.txt')).toBe(true);
		expect(fileIn('.trash')).toBe(false);
		expect(lines).toContainEqual(
			expect.stringMatching(
				/\[WARN\] \[UPLOADS\] Attachment files were not swept: the attachment rows or the card counter could not be read \(no such table: card_attachments\)\. Nothing was moved\.$/
			)
		);
	});

	it('takes the highest card id in use when the counter has no row for cards (R10)', () => {
		put([card.id, 'stray.txt']);
		sqlite.prepare("DELETE FROM sqlite_sequence WHERE name = 'cards'").run();

		expect(sweepUploads()).toMatchObject({ moved: 1, otherDatabase: [] });
	});

	it('says nothing when there was nothing to do', () => {
		const named = makeAttachment(card);
		age(at(card.id, named.filename));

		const { result, lines } = logged(() => sweepUploads());

		expect(result).toMatchObject({ moved: 0, tooNew: 0, failed: [], otherDatabase: [], notCardFolders: [] });
		expect(lines.filter((line) => line.includes('[UPLOADS]'))).toEqual([]);
	});

	it('does nothing where there is no uploads folder yet', () => {
		expect(fileIn()).toBe(false);
		expect(sweepUploads()).toMatchObject({ moved: 0, notCardFolders: [] });
		expect(fileIn()).toBe(false);
	});
});

describe('when the sweep runs', () => {
	// The sweep starts its timers once in the life of a process and has
	// nothing to stop them, and a test file is one process: so this is one test.
	it('first 15 minutes after it is started and not before, then every six hours; a second start starts nothing', () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
		put([card.id, 'first.txt']);

		vi.mocked(initUploadsSweep).mockClear();
		logged(() => {
			initUploadsSweep();
			initUploadsSweep();
		});
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(15 * MINUTE - 1);
		expect(fileIn(card.id, 'first.txt')).toBe(true);
		vi.advanceTimersByTime(1);
		expect(fileIn('.trash', card.id, 'first.txt')).toBe(true);
		// The first run does not come round again: the six-hourly one alone is waiting.
		expect(vi.getTimerCount()).toBe(1);

		const later = makeCard(A.cols['To Do'], { title: 'Later' });
		put([later.id, 'second.txt']);
		vi.advanceTimersByTime(6 * 60 * MINUTE - 1);
		expect(fileIn(later.id, 'second.txt')).toBe(true);
		vi.advanceTimersByTime(1);
		expect(fileIn('.trash', later.id, 'second.txt')).toBe(true);

		const third = makeCard(A.cols['To Do'], { title: 'Third' });
		put([third.id, 'third.txt']);
		vi.advanceTimersByTime(6 * 60 * MINUTE);
		expect(fileIn('.trash', third.id, 'third.txt')).toBe(true);
	});

	it('only where the schedulers run: started with them, and not when they are off', () => {
		const sweep = vi.mocked(initUploadsSweep);
		sweep.mockClear();
		// The real start is the test above; here only the call is watched.
		sweep.mockImplementation(() => {});
		try {
			logged(() => startSchedulers('off', false));
			expect(sweep).not.toHaveBeenCalled();
			expect(initBackupScheduler).not.toHaveBeenCalled();

			const { lines } = logged(() => startSchedulers('on', false));
			expect(sweep).toHaveBeenCalledTimes(1);
			expect(initBackupScheduler).toHaveBeenCalledTimes(1);
			expect(initReportScheduler).toHaveBeenCalledTimes(1);
			expect(initSnapshotScheduler).toHaveBeenCalledTimes(1);
			expect(lines.filter((line) => line.includes('Schedulers are off'))).toEqual([]);

			// Under the dev server, with nothing set, it is off as the rest are.
			sweep.mockClear();
			const off = logged(() => startSchedulers(undefined, true));
			expect(sweep).not.toHaveBeenCalled();
			expect(off.lines).toContainEqual(expect.stringMatching(/attachment file sweep will run from this instance/));
		} finally {
			sweep.mockReset();
		}
	});
});

describe('an import after a sweep', () => {
	/** The import route writes two files in the working directory: give it one of its own. */
	const elsewhere = () => {
		vi.spyOn(process, 'cwd').mockReturnValue(outside());
	};

	// The first import of the file loads the import route's modules cold.
	it('of a backup whose rows name a swept file puts it back', { timeout: 60_000 }, async () => {
		const admin = makeUser({ role: 'superadmin' });
		const file = makeAttachment(card, { name: 'kept.txt' });
		age(at(card.id, file.filename));
		const backup = sqlite.serialize();

		// The row goes and the file stays, as a restore that left the rows out would leave it.
		db.delete(cardAttachments).run();
		expect(sweepUploads()).toMatchObject({ moved: 1 });
		expect(fileIn('.trash', card.id, file.filename)).toBe(true);

		elsewhere();
		const res = await api('POST', '/api/admin/import?outside=keep', {
			user: admin,
			headers: { 'content-type': 'application/octet-stream' },
			body: backup
		});

		expect(res.status).toBe(200);
		expect(res.body.attachmentsPutBack).toBe(1);
		expect(readFileSync(at(card.id, file.filename), 'utf8')).toBe('The contents of kept.txt');
		expect(fileIn('.trash', card.id)).toBe(false);
		// And the next sweep leaves it where it is: its row is back.
		expect(sweepUploads()).toMatchObject({ moved: 0 });
	});
});
