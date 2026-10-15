/**
 * Where the database is, looked at before it is opened and said at start
 * (card 2083).
 *
 * The image sets `DB_PATH=/app/data/dumpfire.db`. A container from an older
 * image started without `DB_PATH` kept its database at `/app/dumpfire.db`, in
 * the working directory. Opening a path creates the file, and a database with
 * no users offers set-up to whoever comes first: so at the image's path, with
 * nothing written there while a database the server can see is somewhere
 * else, the server refuses to start (`databaseLocation` in
 * `src/lib/server/db/location.ts`); and so it does at another path, on Linux,
 * while the image's own database has data, or when something it needed to
 * look at could not be read. Then, once it is open and migrated, it refuses a
 * database with no users while another is beside it, and says three lines at
 * start: the database was new, it is not on a mounted volume, or another
 * database is beside it (`src/lib/server/startup-checks.ts`).
 *
 * Nothing here touches a real file or reads the machine's `/proc`. The guard
 * is asked through its pure function, with the file system it is given and
 * `path.posix` (or `path.win32`), so the Linux case runs the same on Windows.
 * The reports are given their facts as arguments. And that db/index.ts asks
 * before it opens is shown with the driver and the guard replaced, so nothing
 * is opened at all.
 */
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqlite } from '$lib/server/db';
import {
	DatabaseLocationError,
	IMAGE_DB_PATH,
	LEGACY_DB_NAME,
	databaseLocation,
	entryAt,
	heldInContainerLayer,
	type Entry,
	type OtherDatabase,
	type PathModule
} from '$lib/server/db/location';
import {
	refuseUserlessBesideAnother,
	reportDatabaseOffVolume,
	reportNewDatabase,
	reportOtherDatabase
} from '$lib/server/startup-checks';
import { makeUser, resetDb } from './helpers/fixtures';

/** A file system as the guard sees it: a size for each file, 'dir' for a folder, or an error code. */
type Disk = Record<string, number | 'dir' | 'EACCES'>;

/** When every file on a test's disk was last written, and how the lines print it. */
const MODIFIED = Date.UTC(2026, 9, 1, 12, 30);
const WRITTEN = `last written ${new Date(MODIFIED).toISOString()}`;

/** The guard over `disk`, recording every path it looked at and every folder it listed. */
function ask(
	dbPath: string,
	disk: Disk,
	{ cwd = '/app', path = posix as PathModule, unlistable = undefined as string | undefined } = {}
) {
	const looked: string[] = [];
	const listed: string[] = [];
	const entry = (p: string): Entry => {
		looked.push(p);
		const at = disk[p];
		if (at === undefined) return { kind: 'none' };
		if (at === 'dir') return { kind: 'other' };
		if (at === 'EACCES') return { kind: 'unknown', code: 'EACCES' };
		return { kind: 'file', size: at, modified: MODIFIED };
	};
	const list = (dir: string): string[] => {
		listed.push(dir);
		if (unlistable) throw Object.assign(new Error(unlistable), { code: unlistable });
		return Object.keys(disk)
			.filter((p) => path.dirname(p) === dir)
			.map((p) => path.basename(p));
	};
	return { answer: databaseLocation({ dbPath, cwd, entry, list, path }), looked, listed };
}

const refusalOf = (answer: ReturnType<typeof databaseLocation>): string => {
	if (!('refuse' in answer)) throw new Error(`expected a refusal, got ${JSON.stringify(answer)}`);
	return answer.refuse;
};

const LEGACY = '/app/dumpfire.db';

describe('the database about to be opened', () => {
	it('is not looked at when it is in memory', () => {
		for (const dbPath of [':memory:', '']) {
			const { answer, looked, listed } = ask(dbPath, { [LEGACY]: 9000 });
			expect(answer).toEqual({ isNew: false, other: null });
			expect(looked).toEqual([]);
			expect(listed).toEqual([]);
		}
	});

	it("is passed straight through at any other path, as on a workstation with the repository's dumpfire.db beside it", () => {
		const scratch = ask('/tmp/scratch.db', { '/repo/dumpfire.db': 9000 }, { cwd: '/repo' });
		expect(scratch.answer).toEqual({ isNew: true, other: null });
		// The file it was given, and the image's own database, which a workstation does not have: no folder
		// listed, the repository's file not looked at.
		expect(scratch.looked).toEqual(['/tmp/scratch.db', IMAGE_DB_PATH]);
		expect(scratch.listed).toEqual([]);

		// The repository's own file, which has data, opens as it always has, and nothing else is looked at.
		const own = ask('dumpfire.db', { '/repo/dumpfire.db': 9000 }, { cwd: '/repo' });
		expect(own.answer).toEqual({ isNew: false, other: null });
		expect(own.looked).toEqual(['/repo/dumpfire.db']);
	});

	it('is never the image\'s on Windows, where /app/data/dumpfire.db is C:\\app\\data\\dumpfire.db', () => {
		const disk = { 'C:\\repo\\dumpfire.db': 9000, '/app/data/dumpfire.db': 9000, 'C:\\app\\data\\kanban.db': 9000 };
		const { answer, looked, listed } = ask(IMAGE_DB_PATH, disk, { cwd: 'C:\\repo', path: win32 });
		expect(answer).toEqual({ isNew: true, other: null });
		// Only the file it was given.
		expect(looked).toEqual(['C:\\app\\data\\dumpfire.db']);
		expect(listed).toEqual([]);
	});

	it("opens the image's database when it has data, and names a database at /app/dumpfire.db beside it", () => {
		const { answer } = ask(IMAGE_DB_PATH, { [IMAGE_DB_PATH]: 4096, [LEGACY]: 9000, '/app/data/kanban.db': 9000 });
		expect(answer).toEqual({
			isNew: false,
			other: { path: LEGACY, size: 9000, modified: MODIFIED, inUse: { path: IMAGE_DB_PATH, size: 4096, modified: MODIFIED } }
		});

		expect(ask(IMAGE_DB_PATH, { [IMAGE_DB_PATH]: 4096 }).answer).toEqual({ isNew: false, other: null });
		// One it could not look at is not named, and stops nothing: the database in use has data.
		expect(ask(IMAGE_DB_PATH, { [IMAGE_DB_PATH]: 4096, [LEGACY]: 'EACCES' }).answer).toEqual({ isNew: false, other: null });
	});

	it('refuses to make a new one at the image\'s path while a database is at /app/dumpfire.db', () => {
		const line = refusalOf(ask(IMAGE_DB_PATH, { [LEGACY]: 9000 }).answer);

		expect(line).toContain(`There is no database at ${IMAGE_DB_PATH}`);
		expect(line).toContain(`${LEGACY} (9000 bytes, ${WRITTEN})`);
		// Its way forward: move it with what goes with it, or point DB_PATH at it.
		expect(line).toContain('with the container stopped, move it onto the volume as /app/data/dumpfire.db');
		expect(line).toContain('/app/dumpfire.db-wal and /app/dumpfire.db-shm if they are there');
		expect(line).toContain('the uploads folder /app/uploads');
		expect(line).toContain('or start the container with DB_PATH=/app/dumpfire.db');
		expect(line).toContain("If a file named here is not this installation's database, move it out of that folder.");
		expect(line).toContain('Nothing was created or changed.');
		expect(line).toContain('"Moving the database onto the volume"');
	});

	it('refuses the same when the file at the image\'s path is there and empty', () => {
		const line = refusalOf(ask(IMAGE_DB_PATH, { [IMAGE_DB_PATH]: 0, [LEGACY]: 9000 }).answer);
		expect(line).toContain(`The database file ${IMAGE_DB_PATH} is empty`);
		expect(line).toContain(LEGACY);
	});

	it('refuses while another database is on the volume, and names it', () => {
		const line = refusalOf(ask(IMAGE_DB_PATH, { '/app/data/kanban.db': 9000 }).answer);
		expect(line).toContain(`/app/data/kanban.db (9000 bytes, ${WRITTEN}): start the container with DB_PATH=/app/data/kanban.db`);
		expect(line).toContain('rename it dumpfire.db, with its -wal and -shm files');
		expect(line).not.toContain(LEGACY);
	});

	it('refuses beside a write-ahead log whose database is not there, and names it', () => {
		const line = refusalOf(ask(IMAGE_DB_PATH, { [`${IMAGE_DB_PATH}-wal`]: 32992 }).answer);
		expect(line).toContain(`${IMAGE_DB_PATH}-wal (32992 bytes, ${WRITTEN}), the write-ahead log of a database that is not there`);
		expect(line).toContain(`put its database file back beside it as ${IMAGE_DB_PATH}`);
	});

	it('names every file found, and never says to remove or delete one', () => {
		const lines = [
			ask(IMAGE_DB_PATH, { [LEGACY]: 9000, '/app/data/a.db': 1, '/app/data/b.db': 2, [`${IMAGE_DB_PATH}-wal`]: 3 }).answer,
			ask(IMAGE_DB_PATH, { [LEGACY]: 9000 }).answer,
			ask(IMAGE_DB_PATH, { '/app/data/kanban.db': 9000 }).answer,
			ask(IMAGE_DB_PATH, { [`${IMAGE_DB_PATH}-wal`]: 3 }).answer,
			ask(LEGACY_DB_NAME, { [IMAGE_DB_PATH]: 9000 }).answer,
			ask(IMAGE_DB_PATH, { '/app/data/kanban.db': 9000 }, { unlistable: 'EACCES' }).answer,
			ask(IMAGE_DB_PATH, { [LEGACY]: 'EACCES' }).answer
		].map(refusalOf);

		for (const name of [LEGACY, '/app/data/a.db', '/app/data/b.db', `${IMAGE_DB_PATH}-wal`]) {
			expect(lines[0]).toContain(name);
		}
		for (const line of lines) {
			expect(line).not.toMatch(/remove|delete/i);
		}
	});

	it('opens as new when nothing else there is a database: an empty -wal, the temporary copies, an empty /app/dumpfire.db', () => {
		const { answer } = ask(IMAGE_DB_PATH, {
			[`${IMAGE_DB_PATH}-wal`]: 0,
			[`${IMAGE_DB_PATH}-shm`]: 32768,
			[`${IMAGE_DB_PATH}.backup-temp`]: 9000,
			'/app/data/x.export-temp': 9000,
			'/app/data/empty.db': 0,
			[LEGACY]: 0
		});
		expect(answer).toEqual({ isNew: true, other: null });
	});

	it('opens as new when there is nothing anywhere', () => {
		expect(ask(IMAGE_DB_PATH, {}).answer).toEqual({ isNew: true, other: null });
	});

	it('counts only regular files: a folder at /app/dumpfire.db, or one named *.db on the volume, is no database', () => {
		// Docker makes a folder at a bind mount's target when the source is missing.
		expect(ask(IMAGE_DB_PATH, { [LEGACY]: 'dir', '/app/data/old.db': 'dir' }).answer).toEqual({ isNew: true, other: null });
	});

	it("does not judge an image's path it could not look at: no refusal, and the open says what is wrong", () => {
		const { answer } = ask(IMAGE_DB_PATH, { [IMAGE_DB_PATH]: 'EACCES', '/app/data/kanban.db': 9000, [LEGACY]: 9000 });
		expect(answer).toEqual({ isNew: false, other: null });
	});

	it('refuses a new database beside a folder it could not list, and names it', () => {
		const line = refusalOf(ask(IMAGE_DB_PATH, { '/app/data/kanban.db': 9000 }, { unlistable: 'EACCES' }).answer);
		expect(line).toContain(`There is no database at ${IMAGE_DB_PATH}`);
		expect(line).toContain("But it could not look at /app/data (EACCES), where this installation's database may be");
		expect(line).toContain('Nothing was created or changed.');

		// A folder that is not there holds nothing: no refusal.
		expect(ask(IMAGE_DB_PATH, {}, { unlistable: 'ENOENT' }).answer).toEqual({ isNew: true, other: null });
	});

	it('refuses a new database beside a file it could not look at, and names it: /app/dumpfire.db, a *.db, the -wal', () => {
		const legacy = refusalOf(ask(IMAGE_DB_PATH, { [LEGACY]: 'EACCES' }).answer);
		expect(legacy).toContain(`could not look at ${LEGACY} (EACCES)`);

		const candidate = refusalOf(ask(IMAGE_DB_PATH, { '/app/data/kanban.db': 'EACCES' }).answer);
		expect(candidate).toContain('could not look at /app/data/kanban.db (EACCES)');

		const wal = refusalOf(ask(IMAGE_DB_PATH, { [`${IMAGE_DB_PATH}-wal`]: 'EACCES' }).answer);
		expect(wal).toContain(`could not look at ${IMAGE_DB_PATH}-wal (EACCES)`);

		// Beside one it found, it says both.
		const both = refusalOf(ask(IMAGE_DB_PATH, { [LEGACY]: 9000, '/app/data/kanban.db': 'EACCES' }).answer);
		expect(both).toContain(`${LEGACY} (9000 bytes, ${WRITTEN})`);
		expect(both).toContain('And it could not look at /app/data/kanban.db (EACCES)');
	});

	it("resolves DB_PATH against the working directory: data/dumpfire.db in /app is the image's path, and guarded", () => {
		const { answer } = ask('data/dumpfire.db', { [LEGACY]: 9000 });
		expect(refusalOf(answer)).toContain(`There is no database at ${IMAGE_DB_PATH}`);
		// Started in /app/data itself, the default file is the image's path and not a second database.
		expect(ask(LEGACY_DB_NAME, {}, { cwd: '/app/data' }).answer).toEqual({ isNew: true, other: null });
	});

	describe("at a path that is not the image's, while the image's database has data", () => {
		const image = { [IMAGE_DB_PATH]: 9000 };

		it('refuses an empty DB_PATH, which falls back to /app/dumpfire.db, and names the image\'s database', () => {
			// db/index.ts gives `DB_PATH || <working directory>/dumpfire.db`: an empty DB_PATH reaches the guard as this.
			for (const dbPath of [LEGACY_DB_NAME, LEGACY]) {
				const line = refusalOf(ask(dbPath, image).answer);
				expect(line).toContain(`There is no database at ${LEGACY}`);
				expect(line).toContain(`${IMAGE_DB_PATH} (9000 bytes, ${WRITTEN}), the database the image opens`);
				expect(line).toContain(`start the container with DB_PATH=${IMAGE_DB_PATH}, or take the DB_PATH setting out`);
			}
		});

		it('refuses a typo on the volume', () => {
			for (const dbPath of ['/app/data/dumpfire.sqlite', '/app/data/dumpfire.db ', '/app/data/Dumpfire.db']) {
				expect(refusalOf(ask(dbPath, image).answer), JSON.stringify(dbPath)).toContain(`There is no database at ${dbPath}`);
			}
		});

		it('opens a database that has data, or the image\'s that is empty, as before', () => {
			// Check 4 of the plan: DB_PATH=/app/dumpfire.db, which has data.
			expect(ask(LEGACY, { ...image, [LEGACY]: 9000 }).answer).toEqual({ isNew: false, other: null });
			expect(ask('/app/data/dumpfire.sqlite', { [IMAGE_DB_PATH]: 0 }).answer).toEqual({ isNew: true, other: null });
		});

		it("refuses when it could not look at the image's database", () => {
			const line = refusalOf(ask('/app/data/dumpfire.sqlite', { [IMAGE_DB_PATH]: 'EACCES' }).answer);
			expect(line).toContain(`could not look at ${IMAGE_DB_PATH} (EACCES)`);
		});
	});
});

describe('what is at a path, on the real file system', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'dumpfire-location-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('is a regular file with its size and when it was last written, a folder, or nothing', () => {
		const file = join(dir, 'kanban.db');
		writeFileSync(file, 'x'.repeat(10));
		const when = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
		utimesSync(file, when, when);

		expect(entryAt(file)).toEqual({ kind: 'file', size: 10, modified: when.getTime() });
		expect(entryAt(dir)).toEqual({ kind: 'other' });
		expect(entryAt(join(dir, 'missing.db'))).toEqual({ kind: 'none' });
		// A part of the path is a file.
		expect(entryAt(join(file, 'inside.db'))).toEqual({ kind: 'none' });
	});
});

/** A mountinfo line: mount point and type, the rest as Docker writes them. */
const mount = (point: string, type: string, id = 100) =>
	`${id} 1 0:${id} / ${point} rw,relatime - ${type} ${type === 'overlay' ? 'overlay' : '/dev/sda1'} rw`;
const ROOT_OVERLAY = '1 0 0:50 / / rw,relatime master:1 - overlay overlay rw,lowerdir=/var/lib/docker/l/A:/var/lib/docker/l/B';

describe('whether a folder is in the container\'s own file system', () => {
	it('is not, on a volume mounted at it', () => {
		expect(heldInContainerLayer('/app/data', [ROOT_OVERLAY, mount('/app/data', 'ext4')].join('\n'))).toBe(false);
	});

	it('is, with no mount for it and the root an overlay', () => {
		expect(heldInContainerLayer('/app/data', [ROOT_OVERLAY, mount('/proc', 'proc')].join('\n'))).toBe(true);
	});

	it("is not on a Linux workstation, whose root is a real file system", () => {
		expect(heldInContainerLayer('/home/me/dumpfire', mount('/', 'ext4'))).toBe(false);
	});

	it('is, on tmpfs', () => {
		expect(heldInContainerLayer('/app/data', [ROOT_OVERLAY, mount('/app/data', 'tmpfs')].join('\n'))).toBe(true);
	});

	it('is, when only the database file is bind-mounted and its folder is in the layer', () => {
		expect(heldInContainerLayer('/app/data', [ROOT_OVERLAY, mount('/app/data/dumpfire.db', 'ext4')].join('\n'))).toBe(true);
	});

	it('goes by whole path segments: a volume at /app/data does not hold /app/data2', () => {
		expect(heldInContainerLayer('/app/data2', [ROOT_OVERLAY, mount('/app/data', 'ext4')].join('\n'))).toBe(true);
		expect(heldInContainerLayer('/app/data/sub', [ROOT_OVERLAY, mount('/app/data', 'ext4')].join('\n'))).toBe(false);
	});

	it('takes the later of two lines for one mount point, the mount on top', () => {
		expect(heldInContainerLayer('/app/data', [ROOT_OVERLAY, mount('/app/data', 'ext4', 101), mount('/app/data', 'tmpfs', 102)].join('\n'))).toBe(true);
		expect(heldInContainerLayer('/app/data', [ROOT_OVERLAY, mount('/app/data', 'tmpfs', 101), mount('/app/data', 'ext4', 102)].join('\n'))).toBe(false);
	});

	it("knows rootless Podman's root, fuse.fuse-overlayfs, and the other overlays", () => {
		for (const type of ['fuse.fuse-overlayfs', 'fuse-overlayfs', 'aufs', 'overlay']) {
			expect(heldInContainerLayer('/app/data', mount('/', type)), type).toBe(true);
		}
		// Another storage driver is not recognised: nothing is said.
		expect(heldInContainerLayer('/app/data', mount('/', 'btrfs'))).toBe(false);
	});

	it('decodes every escape in a mount point: space, tab and backslash', () => {
		expect(heldInContainerLayer('/srv/my data', [ROOT_OVERLAY, mount('/srv/my\\040data', 'ext4')].join('\n'))).toBe(false);
		expect(heldInContainerLayer('/srv/a\tb\\c', [ROOT_OVERLAY, mount('/srv/a\\011b\\134c', 'ext4')].join('\n'))).toBe(false);
		// Undecoded, neither would match, and the folder would read as the layer's.
		expect(heldInContainerLayer('/srv/my data', ROOT_OVERLAY)).toBe(true);
	});

	it('is not, for empty text', () => {
		expect(heldInContainerLayer('/app/data', '')).toBe(false);
	});
});

describe('the image', () => {
	it("sets DB_PATH to the image's path, on the folder it makes, in the production stage", () => {
		const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
		const production = dockerfile.indexOf('AS production');
		const at = (text: string) => dockerfile.indexOf(text, production);

		expect(/^ENV DB_PATH=(\S+)$/m.exec(dockerfile)?.[1]).toBe(IMAGE_DB_PATH);
		expect(dockerfile.match(/^ENV DB_PATH=/gm)).toHaveLength(1);
		expect(production).toBeGreaterThan(0);
		expect(at('WORKDIR /app')).toBeGreaterThan(production);
		expect(at('RUN mkdir -p /app/data')).toBeGreaterThan(at('WORKDIR /app'));
		expect(at('ENV DB_PATH=')).toBeGreaterThan(at('RUN mkdir -p /app/data'));
		// The builder stage, which runs the tests and the build, has none.
		expect(dockerfile.indexOf('ENV DB_PATH=')).toBeGreaterThan(production);
	});
});

describe('the lines said at start about the database', () => {
	const lines = () =>
		sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'STARTUP' ORDER BY id").all() as {
			level: string;
			message: string;
		}[];
	const level = process.env.LOG_LEVEL;
	let console_: { warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> };

	beforeEach(() => {
		resetDb();
		// vitest.config.ts sets ERROR, which drops a WARN before it is kept.
		process.env.LOG_LEVEL = 'WARN';
		console_ = {
			warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
			error: vi.spyOn(console, 'error').mockImplementation(() => {})
		};
	});
	afterEach(() => {
		vi.restoreAllMocks();
		if (level === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = level;
	});

	it('say a new database once, and nothing for one that had data or is in memory', () => {
		expect(reportNewDatabase(false, IMAGE_DB_PATH)).toBe(false);
		expect(reportNewDatabase(true, ':memory:')).toBe(false);
		expect(reportNewDatabase(true, '')).toBe(false);
		expect(lines()).toEqual([]);

		expect(reportNewDatabase(true, IMAGE_DB_PATH)).toBe(true);
		expect(lines()).toHaveLength(1);
		expect(lines()[0].level).toBe('WARN');
		expect(lines()[0].message).toContain(`No database was at ${IMAGE_DB_PATH}: a new, empty one was created at this start.`);
		expect(lines()[0].message).toContain('stop the container now, before anyone opens the site');
	});

	it('say a database off the volume, and nothing for one on it', () => {
		const onVolume = () => [ROOT_OVERLAY, mount('/app/data', 'ext4')].join('\n');
		expect(reportDatabaseOffVolume(IMAGE_DB_PATH, onVolume)).toBe(false);
		expect(lines()).toEqual([]);

		expect(reportDatabaseOffVolume(IMAGE_DB_PATH, () => ROOT_OVERLAY)).toBe(true);
		expect(lines()).toHaveLength(1);
		expect(lines()[0].level).toBe('WARN');
		expect(lines()[0].message).toContain(`The database, ${IMAGE_DB_PATH}, is in the container's own file system`);
		expect(lines()[0].message).toContain('move them onto a volume mounted at /app/data');
	});

	it('say nothing of an in-memory database, and do not read mountinfo for it', () => {
		const read = vi.fn(() => ROOT_OVERLAY);
		expect(reportDatabaseOffVolume(':memory:', read)).toBe(false);
		expect(reportDatabaseOffVolume('', read)).toBe(false);
		expect(read).not.toHaveBeenCalled();
		expect(lines()).toEqual([]);
	});

	it('say nothing, and do not throw, where mountinfo cannot be read', () => {
		const read = () => {
			throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
		};
		expect(() => reportDatabaseOffVolume(IMAGE_DB_PATH, read)).not.toThrow();
		expect(reportDatabaseOffVolume(IMAGE_DB_PATH, read)).toBe(false);
		expect(lines()).toEqual([]);
		expect(console_.warn).not.toHaveBeenCalled();
		expect(console_.error).not.toHaveBeenCalled();
	});

	it('say another database beside the one in use, naming both with their sizes and times, and nothing when there is none', () => {
		expect(reportOtherDatabase(null, IMAGE_DB_PATH)).toBe(false);
		expect(lines()).toEqual([]);

		expect(reportOtherDatabase(OTHER, IMAGE_DB_PATH)).toBe(true);
		expect(lines()).toHaveLength(1);
		expect(lines()[0].level).toBe('WARN');
		expect(lines()[0].message).toContain(
			`Another database file is at ${LEGACY} (9000 bytes, ${WRITTEN}), beside ${IMAGE_DB_PATH} ` +
				`(4096 bytes, last written ${new Date(LATER).toISOString()}, before this start), which is the one in use.`
		);
		expect(lines()[0].message).toContain(`start it with DB_PATH=${LEGACY}`);
		expect(lines()[0].message).not.toMatch(/remove|delete/i);
	});

	it('write the new-database and off-volume lines to the console whatever LOG_LEVEL is, and once', () => {
		process.env.LOG_LEVEL = 'ERROR';
		expect(reportNewDatabase(true, IMAGE_DB_PATH)).toBe(true);
		expect(reportDatabaseOffVolume(IMAGE_DB_PATH, () => ROOT_OVERLAY)).toBe(true);
		const said = console_.warn.mock.calls.map((call: unknown[]) => String(call[0]));
		expect(said).toHaveLength(2);
		expect(said[0]).toMatch(/^\[\S+\] \[WARN\] \[STARTUP\] No database was at \/app\/data\/dumpfire\.db: a new, empty one/);
		expect(said[1]).toMatch(/^\[\S+\] \[WARN\] \[STARTUP\] The database, \/app\/data\/dumpfire\.db, is in the container's own/);
		// Below the level, the system log keeps nothing, as for any line.
		expect(lines()).toEqual([]);

		// At WARN the logger writes it, and it is not written twice.
		console_.warn.mockClear();
		process.env.LOG_LEVEL = 'WARN';
		reportNewDatabase(true, IMAGE_DB_PATH);
		reportDatabaseOffVolume(IMAGE_DB_PATH, () => ROOT_OVERLAY);
		expect(console_.warn).toHaveBeenCalledTimes(2);
		expect(lines()).toHaveLength(2);
	});
});

/** When the database in use was last written, before the start. */
const LATER = Date.UTC(2026, 9, 14, 8, 0);
const OTHER: OtherDatabase = {
	path: LEGACY,
	size: 9000,
	modified: MODIFIED,
	inUse: { path: IMAGE_DB_PATH, size: 4096, modified: LATER }
};

describe('a database with no users while another is beside it', () => {
	beforeEach(() => {
		resetDb();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('stops the server, naming both files with their sizes and times, and the way forward', () => {
		const said = vi.spyOn(console, 'error').mockImplementation(() => {});

		let thrown: unknown;
		try {
			refuseUserlessBesideAnother(OTHER, () => 0);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(DatabaseLocationError);
		const line = (thrown as DatabaseLocationError).line;
		expect(said.mock.calls.map(([l]) => String(l))).toEqual([line]);
		expect(line).toMatch(/^\[\S+\] \[CRITICAL\] \[DB\] The server will not start\./);
		expect(line).toContain(
			`The database in use, ${IMAGE_DB_PATH} (4096 bytes, last written ${new Date(LATER).toISOString()}, before this start), has no user accounts`
		);
		expect(line).toContain(`another database file is at ${LEGACY} (9000 bytes, ${WRITTEN})`);
		expect(line).toContain(`start the container with DB_PATH=${LEGACY}`);
		expect(line).toContain(`move ${LEGACY} onto the volume as ${IMAGE_DB_PATH}`);
		expect(line).toContain('the uploads folder /app/uploads');
		expect(line).not.toMatch(/remove|delete/i);
	});

	it('lets a database with users start, and says nothing when there is no other database', () => {
		const said = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(() => refuseUserlessBesideAnother(OTHER, () => 1)).not.toThrow();
		expect(() => refuseUserlessBesideAnother(null, () => 0)).not.toThrow();
		expect(said).not.toHaveBeenCalled();
	});

	it("counts the running database's users", () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(() => refuseUserlessBesideAnother(OTHER)).toThrow(DatabaseLocationError);
		makeUser();
		expect(() => refuseUserlessBesideAnother(OTHER)).not.toThrow();
	});

	it('is asked by the server as it starts, after the migrations and before anything else', () => {
		const hooks = readFileSync(join(process.cwd(), 'src', 'hooks.server.ts'), 'utf8');
		const at = (call: string) => hooks.indexOf(`\n${call}`);

		expect(at('runMigrations();')).toBeGreaterThan(-1);
		expect(at('refuseUserlessBesideAnother();')).toBeGreaterThan(at('runMigrations();'));
		for (const later of ['cleanExpiredSessions();', 'maskLiveLog();', 'startSchedulers();', 'reportInstallation();']) {
			expect(at(later), later).toBeGreaterThan(at('refuseUserlessBesideAnother();'));
		}
	});
});

describe('db/index.ts', () => {
	const dbPath = process.env.DB_PATH;
	let order: string[];

	beforeEach(() => {
		order = [];
		vi.resetModules();
		// The driver, recording the path it would have opened: nothing is opened.
		vi.doMock('better-sqlite3', () => ({
			default: class {
				constructor(path: string) {
					order.push(`driver ${path}`);
				}
				pragma() {}
			}
		}));
		vi.doMock('drizzle-orm/better-sqlite3', () => ({ drizzle: () => ({}) }));
		process.env.DB_PATH = IMAGE_DB_PATH;
	});
	afterEach(() => {
		vi.doUnmock('better-sqlite3');
		vi.doUnmock('drizzle-orm/better-sqlite3');
		vi.doUnmock('$lib/server/db/location');
		vi.resetModules();
		vi.restoreAllMocks();
		process.env.DB_PATH = dbPath;
	});

	it('asks where the database is before it opens it, and opens nothing when told not to', async () => {
		const said = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.doMock('$lib/server/db/location', async () => {
			const actual = await vi.importActual<typeof import('$lib/server/db/location')>('$lib/server/db/location');
			return {
				...actual,
				checkDatabaseLocation: (path: string) => {
					order.push(`check ${path}`);
					throw new actual.DatabaseLocationError('refused', '[t] [CRITICAL] [DB] refused');
				}
			};
		});

		await expect(import('$lib/server/db')).rejects.toThrow('refused');
		expect(order).toEqual([`check ${IMAGE_DB_PATH}`]);
		expect(said.mock.calls.map(([line]) => String(line))).toEqual(['[t] [CRITICAL] [DB] refused']);
	});

	it('opens it once told it may, and keeps what was found', async () => {
		vi.doMock('$lib/server/db/location', async () => {
			const actual = await vi.importActual<typeof import('$lib/server/db/location')>('$lib/server/db/location');
			return {
				...actual,
				checkDatabaseLocation: (path: string) => {
					order.push(`check ${path}`);
					return { isNew: true, other: OTHER };
				}
			};
		});

		const db = await import('$lib/server/db');
		expect(order).toEqual([`check ${IMAGE_DB_PATH}`, `driver ${IMAGE_DB_PATH}`]);
		expect(db.createdAtStart()).toBe(true);
		expect(db.otherDatabaseAtStart()).toEqual(OTHER);
	});
});
