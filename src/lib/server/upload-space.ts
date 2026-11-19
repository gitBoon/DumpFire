/**
 * upload-space.ts — whether the disk the uploads are kept on has room for one
 * more upload (card 2920, card 2910's F2).
 *
 * Card 2910's allowances bound one account, not the disk: several accounts,
 * or a large uploads folder copied back onto the volume, can still fill it,
 * and a full disk fails the database's writes and the backups too. So both
 * upload routes ask here, before the body is read, after the card, its access
 * and (for a key) the declared type, and before the place and the hour: an
 * upload is refused 507 when what is free, less room for the largest upload
 * either route takes (`LARGEST_UPLOAD_BYTES`), would fall below the floor.
 *
 *   the floor      1 GiB, and twice the database's size (its file and its
 *                  -wal): a backup writes two copies of the database beside
 *                  it (backup.ts), and the uploads are beside the database
 *                  on the same volume unless UPLOADS_DIR, a setting for the
 *                  tests alone, says otherwise, which only raises the floor
 *   the inodes     at least `INODE_FLOOR` (1,000) free, where the volume
 *                  counts them (`files` above 0; Windows does not): a disk
 *                  with bytes free and no inode left fails every new file
 *   the space      `fs.promises.statfs` of the uploads folder, or of the
 *                  nearest folder above it that exists (the folder is made
 *                  at the first upload): free is `bavail × bsize`, what the
 *                  server's own user may use; total `blocks × bsize`. Given
 *                  `READ_TIMEOUT_MS` (2 seconds), and one read at a time: a
 *                  volume that does not answer holds one of Node's threads,
 *                  never one a look
 *   cannot read    fail closed: uploads are refused as when the space is low
 *
 * A write that runs out of space anyway (something else filled the disk
 * while the body was read) is answered the same way (`refuseWhenFull`), and
 * holds the state low for `FULL_COOL_DOWN_MS` (5 minutes) unless the free
 * figure grows past what the last look read before the failure: so the next
 * uploads are refused before their bodies are read, and the log does not
 * swing between room and low at every upload.
 *
 * The state, `room`, `low` or `unreadable`, is kept in memory and judged at
 * every look, an upload's or the admin page's. A change of it writes one line
 * under UPLOADS (into low a WARN, into unreadable an ERROR, back to room an
 * INFO), and nothing while it stays. No mail.
 *
 * `uploads.ts` must not import the logger (`logger.ts` imports it), so this
 * module is apart from it.
 */
import { promises as fsp, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDbPath } from './db';
import { createLogger } from './logger';
import { uploadsDir } from './uploads';

const log = createLogger('UPLOADS');

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** What always stays free, before the database's share: 1 GiB. */
export const UPLOAD_SPACE_FLOOR_BYTES = GiB;

/**
 * The most either route writes for one upload: the card window's 25 MB file.
 * Counted for every upload, a key's 5 MB image included, so that both routes
 * refuse at the one line the admin page names.
 */
export const LARGEST_UPLOAD_BYTES = 25 * MiB;

/**
 * Free inodes below which uploads are refused, where the volume counts them.
 * An upload takes at most two (its file and its card's folder), six at once
 * twelve; a backup at most eight (two copies, each with a -journal, -wal and
 * -shm); SQLite and the log a few more. 1,000 is many times that, and nothing
 * on a volume of any real size (ext4 gives millions).
 */
export const INODE_FLOOR = 1000;

/** How long a write that found the disk full holds uploads refused, unless the free figure grows: 5 minutes. */
export const FULL_COOL_DOWN_MS = 5 * 60 * 1000;

/** How long a read of the free space is given before it counts as unreadable: 2 seconds. */
export const READ_TIMEOUT_MS = 2000;

/** The words of every refusal for space, on both routes, before the body and at the write. */
export const UPLOAD_SPACE_WORDS =
	'Uploads are paused: the server has too little free disk space, or cannot read how much it has. Nothing was written. ' +
	'An administrator can see which on the admin page.';

/** An upload refused for want of space, or because the space could not be read: answered 507. */
export class UploadSpaceRefused extends Error {
	constructor() {
		super(UPLOAD_SPACE_WORDS);
		this.name = 'UploadSpaceRefused';
	}
}

/** The free and total bytes of the volume `dir` is on, and its free inodes where it counts them (null where not). */
export type FreeSpace = { freeBytes: number; totalBytes: number; freeInodes?: number | null };
export type FreeSpaceReader = (dir: string) => Promise<FreeSpace>;

export type UploadSpaceState = 'room' | 'low' | 'unreadable';
/** Why uploads are refused while low: too few bytes, too few inodes, or a write found the disk full. */
export type UploadSpaceLow = 'space' | 'inodes' | 'full';

/** What the admin page is given, and what each look judges. */
export type UploadSpace = {
	state: UploadSpaceState;
	/** Null unless low. */
	lowBecause: UploadSpaceLow | null;
	/** Null when the space could not be read. */
	freeBytes: number | null;
	totalBytes: number | null;
	/** Null when it could not be read, or the volume does not count inodes. */
	freeInodes: number | null;
	/** Uploads are refused while less than this is free: the floor and the largest upload. */
	refusedBelowBytes: number;
};

/** The floor for a database of `dbBytes`: 1 GiB and twice the database. */
export function uploadFloorBytes(dbBytes: number): number {
	return UPLOAD_SPACE_FLOOR_BYTES + 2 * dbBytes;
}

/** The database's size on disk, its file and its -wal; 0 in memory, and a file that is not there counts 0. */
export function databaseBytes(dbPath: string = getDbPath()): number {
	if (dbPath === ':memory:' || dbPath === '') return 0;
	let bytes = 0;
	for (const suffix of ['', '-wal']) {
		try {
			bytes += statSync(dbPath + suffix).size;
		} catch {
			// Not there.
		}
	}
	return bytes;
}

/**
 * The real reader: `statfs` of `dir`, or of the nearest folder above it that
 * exists. Called through `fs.promises` as it is when called.
 */
export const readFreeSpace: FreeSpaceReader = async (dir) => {
	let at = dir;
	for (;;) {
		try {
			const stats = await fsp.statfs(at);
			return {
				freeBytes: stats.bavail * stats.bsize,
				totalBytes: stats.blocks * stats.bsize,
				// A volume that counts no inodes (Windows answers 0) has none to run out of.
				freeInodes: stats.files > 0 ? stats.ffree : null
			};
		} catch (err) {
			const up = dirname(at);
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || up === at) throw err;
			at = up;
		}
	}
};

let reader: FreeSpaceReader = readFreeSpace;
let now: () => number = Date.now;
let last: UploadSpaceState = 'room';
/** The free bytes the last look read. */
let lastFree: number | null = null;
/** A write that found the disk full: when, and the free bytes the last look before it read. */
let full: { at: number; free: number | null } | null = null;
/** The read in progress, which every look waits on rather than starting another. */
let pending: Promise<FreeSpace> | null = null;

/**
 * Install the reader every look uses, or put back the real one with null, and
 * the clock the cool-down is timed by (`Date.now` unless given); and forget
 * the state, the cool-down and any read in progress. For the tests:
 * tests/setup.ts installs a reader that answers plenty of room, so that no
 * test depends on the real disk.
 */
export function setFreeSpaceReader(next: FreeSpaceReader | null, clock: (() => number) | null = null): void {
	reader = next ?? readFreeSpace;
	now = clock ?? Date.now;
	last = 'room';
	lastFree = null;
	full = null;
	pending = null;
}

/** The read, one at a time, given `READ_TIMEOUT_MS`: past it, it fails, and the read itself is left to finish. */
function boundedRead(dir: string): Promise<FreeSpace> {
	const read = (pending ??= Promise.resolve()
		.then(() => reader(dir))
		.finally(() => {
			pending = null;
		}));
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`the free space was not read within ${READ_TIMEOUT_MS / 1000} seconds`)), READ_TIMEOUT_MS);
		timer.unref?.();
	});
	return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

/** Whether a write's full disk still holds uploads refused: until the cool-down ends, or the free figure grows past the one before it. */
function stillFull(free: number): boolean {
	if (full === null) return false;
	if (now() - full.at >= FULL_COOL_DOWN_MS || (full.free !== null && free > full.free)) {
		full = null;
		return false;
	}
	return true;
}

/** One line under UPLOADS when the state changes, and none while it stays. */
function sayChange(space: UploadSpace, reason: string | null): void {
	if (space.state === last) return;
	last = space.state;
	const free = space.freeBytes === null ? '' : inWords(space.freeBytes);
	if (space.state === 'low' && space.lowBecause === 'full') {
		// A write that ran out of space (`refuseWhenFull`).
		log.warn(
			`Uploads are refused: an upload could not be written, as the uploads volume is full${reason ? ` (${reason})` : ''}. Free some space or grow the volume.`
		);
	} else if (space.state === 'low' && space.lowBecause === 'inodes') {
		log.warn(
			`Uploads are refused: ${space.freeInodes} free inodes on the uploads volume, below ${INODE_FLOOR}. Delete files or grow the volume.`,
			{ freeInodes: space.freeInodes }
		);
	} else if (space.state === 'low') {
		log.warn(
			`Uploads are refused: ${free} free on the uploads volume, below ${inWords(space.refusedBelowBytes)} ` +
				"(1 GB plus twice the database's size, and room for a 25 MB upload). Free some space or grow the volume.",
			{ freeBytes: space.freeBytes, totalBytes: space.totalBytes, refusedBelowBytes: space.refusedBelowBytes }
		);
	} else if (space.state === 'unreadable') {
		log.error(`Uploads are refused: the free space on the uploads volume could not be read (${reason ?? 'unknown'}).`);
	} else {
		log.info(`Uploads are accepted again: ${free} free on the uploads volume.`, {
			freeBytes: space.freeBytes,
			totalBytes: space.totalBytes
		});
	}
}

/** Bytes as a person reads them, to one decimal place. */
function inWords(bytes: number): string {
	if (bytes >= GiB) return `${(bytes / GiB).toFixed(1)} GB`;
	return `${(bytes / MiB).toFixed(1)} MB`;
}

/**
 * Look at the uploads volume: its free and total space and inodes, the line
 * below which uploads are refused, and the state, with one log line if it
 * changed. Never throws: anything that stops the read, an uploads folder that
 * is refused or a read that takes longer than `READ_TIMEOUT_MS` among them,
 * is `unreadable`.
 */
export async function uploadSpace(): Promise<UploadSpace> {
	const refusedBelowBytes = uploadFloorBytes(databaseBytes()) + LARGEST_UPLOAD_BYTES;
	let space: UploadSpace;
	let reason: string | null = null;
	try {
		const read = await boundedRead(uploadsDir());
		const { freeBytes, totalBytes } = read;
		const freeInodes = read.freeInodes ?? null;
		if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || (freeInodes !== null && !Number.isFinite(freeInodes))) {
			throw new Error('the volume answered no figures');
		}
		const lowBecause: UploadSpaceLow | null =
			freeBytes < refusedBelowBytes
				? 'space'
				: freeInodes !== null && freeInodes < INODE_FLOOR
					? 'inodes'
					: stillFull(freeBytes)
						? 'full'
						: null;
		lastFree = freeBytes;
		space = { state: lowBecause === null ? 'room' : 'low', lowBecause, freeBytes, totalBytes, freeInodes, refusedBelowBytes };
	} catch (err) {
		reason = err instanceof Error ? err.message : String(err);
		space = { state: 'unreadable', lowBecause: null, freeBytes: null, totalBytes: null, freeInodes: null, refusedBelowBytes };
	}
	sayChange(space, reason);
	return space;
}

/** Refuse an upload, with `UploadSpaceRefused`, unless the uploads volume has room for it. */
export async function requireUploadRoom(): Promise<void> {
	if ((await uploadSpace()).state !== 'room') throw new UploadSpaceRefused();
}

/**
 * For a write's failure (`writeUploadFile`, which has removed what it wrote):
 * a disk or quota that is full becomes `UploadSpaceRefused`, the state low
 * with its line, and the cool-down begins; anything else is thrown on as it is.
 */
export function refuseWhenFull(err: unknown): never {
	const code = (err as NodeJS.ErrnoException | null)?.code;
	if (code !== 'ENOSPC' && code !== 'EDQUOT') throw err;
	full = { at: now(), free: lastFree };
	sayChange(
		{
			state: 'low',
			lowBecause: 'full',
			freeBytes: null,
			totalBytes: null,
			freeInodes: null,
			refusedBelowBytes: uploadFloorBytes(databaseBytes()) + LARGEST_UPLOAD_BYTES
		},
		code
	);
	throw new UploadSpaceRefused();
}
