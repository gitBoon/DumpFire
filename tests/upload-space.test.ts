/**
 * The free space on the uploads volume (card 2920): the floor, the line below
 * which uploads are refused, the state and its one line a crossing, the real
 * reader, and the 507 both upload routes answer before the body and at the
 * write.
 *
 * No case reads the real disk's free space as a figure it depends on, and none
 * fills a disk: every case installs a reader of its own (`setFreeSpaceReader`)
 * and puts the setup's "plenty of room" back after it. Case 6 alone asks the
 * real `statfs`, for the shape of its answer on this platform, and writes
 * nothing.
 */
import { existsSync, mkdtempSync, promises as fsPromises, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '$lib/server/db';
import { cardAttachments, type Card } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { subscribeToLogs, type LogEntry } from '$lib/server/logger';
import { allowanceState, inFlightAt, resetAllRateLimits } from '$lib/server/rate-limit';
import { UPLOADS_PER_HOUR } from '$lib/server/upload-allowance';
import {
	databaseBytes,
	FULL_COOL_DOWN_MS,
	INODE_FLOOR,
	LARGEST_UPLOAD_BYTES,
	READ_TIMEOUT_MS,
	readFreeSpace,
	refuseWhenFull,
	requireUploadRoom,
	setFreeSpaceReader,
	UPLOAD_SPACE_FLOOR_BYTES,
	UPLOAD_SPACE_WORDS,
	uploadFloorBytes,
	uploadSpace,
	UploadSpaceRefused
} from '$lib/server/upload-space';
import { api } from './helpers/api';
import { plentyOfSpace } from './helpers/free-space';
import { png } from './helpers/image-bytes';
import { makeBoard, makeCard, makeUser, resetDb, testUploadsDir } from './helpers/fixtures';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const HOUR_MS = 60 * 60 * 1000;
const TOTAL = 100 * GiB;
/** The line the tests' in-memory database gives: the floor and the largest upload, no database share. */
const LINE = UPLOAD_SPACE_FLOOR_BYTES + LARGEST_UPLOAD_BYTES;

let owner: SessionUser;
let card: Card;
const scratch: string[] = [];
/** The real `writeFile`, for a stand-in that writes a little and then fails (C4). */
const realWriteFile = fsPromises.writeFile;

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	owner = makeUser({ username: 'owner' });
	const A = makeBoard({ owner, name: 'A' });
	card = makeCard(A.cols['To Do'], { title: 'Has files' });
});

afterEach(() => {
	vi.useRealTimers();
	plentyOfSpace();
	vi.restoreAllMocks();
	process.env.LOG_LEVEL = 'ERROR';
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A reader that answers `free` bytes free of `TOTAL`. */
const freeOf = (free: number) => setFreeSpaceReader(async () => ({ freeBytes: free, totalBytes: TOTAL }));

/** The UPLOADS lines `run` writes, at every level from INFO. */
async function linesOf(run: () => Promise<unknown>): Promise<LogEntry[]> {
	process.env.LOG_LEVEL = 'INFO';
	for (const method of ['info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
	const lines: LogEntry[] = [];
	const stop = subscribeToLogs((entry) => {
		if (entry.context === 'UPLOADS') lines.push(entry);
	});
	try {
		await run();
	} finally {
		stop();
	}
	return lines;
}

const rows = () => db.select().from(cardAttachments).all();
const filesOnCard = () => (existsSync(join(testUploadsDir(), String(card.id))) ? readdirSync(join(testUploadsDir(), String(card.id))) : []);
const hourUsed = () => allowanceState(`attachment-upload:user:${owner.id}`, UPLOADS_PER_HOUR, HOUR_MS, Date.now()).used;
const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], 'notes.pdf', { type: 'application/pdf' });

/** The card window's upload of `file`, as the browser sends it. */
function webUpload(file: File = pdf()) {
	const form = new FormData();
	form.set('file', file);
	return api('POST', `/api/cards/${card.id}/attachments`, { user: owner, body: form });
}

/** A key's image upload. */
const keyUpload = () => api('POST', `/api/v1/cards/${card.id}/attachments`, { user: owner, body: png(), headers: { 'content-type': 'image/png' } });

describe('the floor and the line (card 2920)', () => {
	it('1. is 1 GiB and twice the database', () => {
		expect(uploadFloorBytes(0)).toBe(GiB);
		expect(uploadFloorBytes(300 * MiB)).toBe(GiB + 600 * MiB);
	});

	it("2. counts the database's file and its -wal, 0 in memory and for a file that is not there", () => {
		const dir = mkdtempSync(join(tmpdir(), 'dumpfire-2920-'));
		scratch.push(dir);
		const path = join(dir, 'dumpfire.db');

		expect(databaseBytes(':memory:')).toBe(0);
		writeFileSync(path, new Uint8Array(1000));
		expect(databaseBytes(path)).toBe(1000);
		writeFileSync(`${path}-wal`, new Uint8Array(500));
		expect(databaseBytes(path)).toBe(1500);
	});

	it('3. has room at the line exactly, and is low, and refused, one byte below it', async () => {
		freeOf(LINE);
		expect(await uploadSpace()).toEqual({ state: 'room', lowBecause: null, freeBytes: LINE, totalBytes: TOTAL, freeInodes: null, refusedBelowBytes: LINE });
		await expect(requireUploadRoom()).resolves.toBeUndefined();

		freeOf(LINE - 1);
		expect((await uploadSpace()).state).toBe('low');
		const refused = requireUploadRoom();
		await expect(refused).rejects.toBeInstanceOf(UploadSpaceRefused);
		await expect(refused).rejects.toThrow(UPLOAD_SPACE_WORDS);
	});

	it('4. writes one line when the state changes, and none while it stays', async () => {
		let free = LINE;
		setFreeSpaceReader(async () => ({ freeBytes: free, totalBytes: TOTAL }));

		const low = LINE - 100 * MiB;
		const lines = await linesOf(async () => {
			await uploadSpace();
			free = low;
			await uploadSpace();
			await uploadSpace();
			free = LINE;
			await uploadSpace();
			free = low;
			await uploadSpace();
		});

		expect(lines.map((line) => line.level)).toEqual(['WARN', 'INFO', 'WARN']);
		expect(lines[0].message).toBe(
			"Uploads are refused: 949.0 MB free on the uploads volume, below 1.0 GB (1 GB plus twice the database's size, and room for a 25 MB upload). Free some space or grow the volume."
		);
		expect(JSON.parse(lines[0].meta!)).toEqual({ freeBytes: low, totalBytes: TOTAL, refusedBelowBytes: LINE });
		expect(lines[1].message).toBe('Uploads are accepted again: 1.0 GB free on the uploads volume.');
	});

	it('5. refuses when the free space cannot be read (fail closed), and says so once', async () => {
		setFreeSpaceReader(async () => {
			throw Object.assign(new Error('EIO: i/o error, statfs'), { code: 'EIO' });
		});

		let first: Awaited<ReturnType<typeof uploadSpace>> | undefined;
		const lines = await linesOf(async () => {
			first = await uploadSpace();
			await expect(requireUploadRoom()).rejects.toBeInstanceOf(UploadSpaceRefused);
		});

		expect(first).toEqual({ state: 'unreadable', lowBecause: null, freeBytes: null, totalBytes: null, freeInodes: null, refusedBelowBytes: LINE });
		expect(lines).toEqual([
			expect.objectContaining({
				level: 'ERROR',
				message: 'Uploads are refused: the free space on the uploads volume could not be read (EIO: i/o error, statfs).'
			})
		]);
	});

	it('6. reads the real volume of a folder not made yet from the nearest folder that is, making nothing', async () => {
		const notMade = join(testUploadsDir(), 'not-made-2920', 'deeper');

		const space = await readFreeSpace(notMade);

		expect(Number.isSafeInteger(space.freeBytes) && Number.isSafeInteger(space.totalBytes)).toBe(true);
		expect(space.totalBytes).toBeGreaterThan(0);
		expect(space.freeBytes).toBeLessThanOrEqual(space.totalBytes);
		// Card 2920's code review (C1): null where the volume counts no inodes (Windows), else a whole number.
		expect(space.freeInodes === null || Number.isSafeInteger(space.freeInodes)).toBe(true);
		expect(existsSync(join(testUploadsDir(), 'not-made-2920'))).toBe(false);
	});

	it('12. refuses below 1,000 free inodes where the volume counts them, and never where it does not (C1)', async () => {
		// The real reader's inodes: `ffree` where `files` is above 0, none where it is 0 (Windows).
		const statfs = vi.spyOn(fsPromises, 'statfs');
		statfs.mockResolvedValueOnce({ bavail: 10, bsize: 4096, blocks: 20, files: 5000, ffree: 10 } as never);
		expect(await readFreeSpace(testUploadsDir())).toEqual({ freeBytes: 40960, totalBytes: 81920, freeInodes: 10 });
		statfs.mockResolvedValueOnce({ bavail: 10, bsize: 4096, blocks: 20, files: 0, ffree: 0 } as never);
		expect((await readFreeSpace(testUploadsDir())).freeInodes).toBeNull();

		// Judged against INODE_FLOOR, with bytes to spare.
		let freeInodes: number | null = INODE_FLOOR - 1;
		setFreeSpaceReader(async () => ({ freeBytes: 10 * GiB, totalBytes: TOTAL, freeInodes }));
		expect(await uploadSpace()).toEqual(expect.objectContaining({ state: 'low', lowBecause: 'inodes', freeInodes: INODE_FLOOR - 1 }));
		await expect(requireUploadRoom()).rejects.toBeInstanceOf(UploadSpaceRefused);
		freeInodes = INODE_FLOOR;
		expect((await uploadSpace()).state).toBe('room');
		freeInodes = null;
		expect((await uploadSpace()).state).toBe('room');
	});

	it('13. holds a write that found the disk full low for 5 minutes, unless the free figure grows past the last look before it (C1)', async () => {
		let t = 1_000_000;
		let free = LINE + 500 * MiB;
		setFreeSpaceReader(async () => ({ freeBytes: free, totalBytes: TOTAL }), () => t);
		const enospc = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });

		// The look before the upload's body read the free figure; its write then found the disk full.
		expect((await uploadSpace()).state).toBe('room');
		expect(() => refuseWhenFull(enospc)).toThrow(UploadSpaceRefused);

		// Above the line, and still refused, as the admin page shows it, until the cool-down ends...
		free = LINE + 400 * MiB;
		expect(await uploadSpace()).toEqual(expect.objectContaining({ state: 'low', lowBecause: 'full', freeBytes: free }));
		t += FULL_COOL_DOWN_MS - 1;
		expect((await uploadSpace()).lowBecause).toBe('full');
		await expect(requireUploadRoom()).rejects.toBeInstanceOf(UploadSpaceRefused);
		// ...or the free figure grows past the one read before the failure.
		free = LINE + 500 * MiB + 1;
		expect((await uploadSpace()).state).toBe('room');

		// Released by the time alone: the figure has not grown.
		expect(() => refuseWhenFull(enospc)).toThrow(UploadSpaceRefused);
		expect((await uploadSpace()).lowBecause).toBe('full');
		t += FULL_COOL_DOWN_MS;
		expect((await uploadSpace()).state).toBe('room');
	});

	it('14. counts a read that takes longer than 2 seconds as unreadable, and starts no second read while it hangs (C3)', async () => {
		vi.useFakeTimers();
		const hung = vi.fn(() => new Promise<never>(() => {}));
		setFreeSpaceReader(hung);

		let settled = false;
		const look = uploadSpace().then((space) => {
			settled = true;
			return space;
		});
		await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await look).toEqual(expect.objectContaining({ state: 'unreadable', freeBytes: null }));

		// The upload's check (and the admin page's load) asks the same bounded read: refused, fail closed.
		const again = requireUploadRoom();
		const refused = expect(again).rejects.toBeInstanceOf(UploadSpaceRefused);
		await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
		await refused;
		expect(hung).toHaveBeenCalledTimes(1);
	});
});

describe('the upload routes, short of space (card 2920)', () => {
	it('7. the card window refuses 507 before the form is read, taking no place and counting nothing', async () => {
		freeOf(LINE - 1);
		const read = vi.spyOn(Request.prototype, 'formData');

		const res = await webUpload();

		expect([res.status, res.body, res.headers.get('connection')]).toEqual([507, { message: UPLOAD_SPACE_WORDS }, 'close']);
		expect(read).not.toHaveBeenCalled();
		expect([inFlightAt(`upload-in-flight:user:${owner.id}`), inFlightAt('upload-in-flight:server'), hourUsed()]).toEqual([0, 0, 0]);
		expect([rows(), filesOnCard()]).toEqual([[], []]);
	});

	it("8. a key's upload refuses 507 with the same words before the body is read, taking no place and counting nothing", async () => {
		freeOf(LINE - 1);
		const read = vi.spyOn(Request.prototype, 'arrayBuffer');

		const res = await keyUpload();

		expect([res.status, res.body, res.headers.get('connection')]).toEqual([507, { message: UPLOAD_SPACE_WORDS }, 'close']);
		expect(read).not.toHaveBeenCalled();
		expect([inFlightAt(`upload-in-flight:user:${owner.id}`), inFlightAt('upload-in-flight:server'), hourUsed()]).toEqual([0, 0, 0]);
		expect([rows(), filesOnCard()]).toEqual([[], []]);
	});

	it.each([
		{ row: 'the card window', send: () => webUpload() },
		{ row: "a key's upload", send: keyUpload }
	])('9. a write that runs out of space part way is 507 with the same words, leaving no file, folder or row, and marked low once: $row', async ({ send }) => {
		// Card 2920's code review (C4): a few bytes land before the disk is full, as a real write does.
		vi.spyOn(fsPromises, 'writeFile').mockImplementationOnce(async (path) => {
			await realWriteFile(path, new Uint8Array([1, 2, 3]));
			throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
		});

		let res: Awaited<ReturnType<typeof api>> | undefined;
		const lines = await linesOf(async () => {
			res = await send();
		});

		expect([res!.status, res!.body, res!.headers.get('connection')]).toEqual([507, { message: UPLOAD_SPACE_WORDS }, null]);
		expect(rows()).toEqual([]);
		// The part-written file and the card's folder this upload made are both gone.
		expect(existsSync(join(testUploadsDir(), String(card.id)))).toBe(false);
		// The upload was counted before its body, as any refusal after the read leaves it.
		expect(hourUsed()).toBe(1);
		expect(lines).toEqual([
			expect.objectContaining({
				level: 'WARN',
				message: 'Uploads are refused: an upload could not be written, as the uploads volume is full (ENOSPC). Free some space or grow the volume.'
			})
		]);
	});
});
