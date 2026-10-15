/**
 * location.ts — whether the database the server is about to open is safe to
 * open, looked at before it is opened (card 2083).
 *
 * The image sets `DB_PATH=/app/data/dumpfire.db`, on the volume. Before it
 * did, a container started without `DB_PATH` kept its database at
 * `/app/dumpfire.db`, in the working directory. Opening a path creates the
 * file, and a database with no users sends every page to set-up, where
 * whoever comes first becomes the superadmin. So when the path is the image's
 * and nothing has been written there, while a database this server can see is
 * somewhere else, the server refuses to start and says where that database is
 * and what to do with it. It never moves, renames or deletes a file itself.
 *
 * The guard is for the image's path. On a workstation the repository holds
 * the real `dumpfire.db` and `DB_PATH` is pointed at a new scratch file before
 * a build or a server start: a guard that looked around any path would refuse
 * exactly that. On Windows `/app/data/dumpfire.db` resolves to
 * `C:\app\data\...`, which is never the image's path. For any other path it
 * looks at the file it was given, to say whether that file is new, and, on
 * Linux, when that file is new, at the image's own database too: an empty
 * `DB_PATH` (which falls back to `<working directory>/dumpfire.db`) or a typo
 * on the volume would otherwise open a new database beside the real one. A
 * workstation has no `/app/data/dumpfire.db`, so nothing is refused there.
 *
 * When something it needed to look at could not be read (a folder it could
 * not list, a file it could not stat), and the database is new, it refuses
 * too, and names what it could not read: it cannot say the database is not
 * there.
 *
 * And `heldInContainerLayer`, which reads `/proc/self/mountinfo` text to say
 * whether a folder is in the container's own file system rather than on a
 * mounted volume, for the start-up line in startup-checks.ts.
 *
 * Nothing here runs when the module is loaded. db/index.ts calls
 * `checkDatabaseLocation`; this module must not import the logger, which
 * imports db/index.ts.
 */
import { readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

/** The database the image opens: on the volume the guide mounts at /app/data. */
export const IMAGE_DB_PATH = '/app/data/dumpfire.db';

/** The file a server started without `DB_PATH` opens, in its working directory. */
export const LEGACY_DB_NAME = 'dumpfire.db';

/** What is at a path, as far as the guard needs to know. */
export type Entry =
	/** Nothing there: ENOENT, or ENOTDIR (a part of the path is a file). */
	| { kind: 'none' }
	/** A regular file, of this many bytes, last written at `modified` (milliseconds since 1970). */
	| { kind: 'file'; size: number; modified: number }
	/** A folder, or anything else that is not a regular file: never a database here. */
	| { kind: 'other' }
	/** It could not be looked at (EACCES, EIO, ...), with the error's code. */
	| { kind: 'unknown'; code: string };

/** The path module the answer is worked out with: the tests pass `path.posix` or `path.win32`. */
export type PathModule = Pick<typeof nodePath.posix, 'resolve' | 'dirname' | 'join' | 'basename' | 'sep'>;

export type LocationInput = {
	/** `DB_PATH` as given, or the default the server falls back to. */
	dbPath: string;
	/** The server's working directory. */
	cwd: string;
	entry: (path: string) => Entry;
	/**
	 * The names in a folder. Throws as `readdirSync` does: ENOENT or ENOTDIR
	 * is a folder that is not there, any other error one that could not be read.
	 */
	list: (dir: string) => string[];
	path: PathModule;
};

/** A database file the guard saw: where, how big, and when it was last written. */
export type Seen = { path: string; size: number; modified: number };

/** A database at `<working directory>/dumpfire.db`, and the image's one in use beside it, as it was before the open. */
export type OtherDatabase = Seen & { inUse: Seen };

export type Location =
	/** Do not open: the line says why, what was found and what to do. */
	| { refuse: string }
	/**
	 * Open. `isNew`: there was no file, or an empty one, so opening makes a
	 * new database. `other`: a database at `<working directory>/dumpfire.db`
	 * beside the image's, which is in use (said at start, never refused here).
	 */
	| { isNew: boolean; other: OtherDatabase | null };

/** A database the server can see, that may be this installation's. */
type Found = Seen & { kind: 'legacy' | 'volume' | 'wal' | 'image' };

/** Something the guard needed to look at and could not. */
type Unreadable = { path: string; code: string };

const isMemory = (dbPath: string) => dbPath === ':memory:' || dbPath === '';

/** A regular file with something in it. */
const nonEmpty = (entry: Entry): entry is { kind: 'file'; size: number; modified: number } =>
	entry.kind === 'file' && entry.size > 0;

/** A file's size and when it was last written, as the lines print them. */
export const described = (seen: Seen): string =>
	`${seen.size} bytes, last written ${new Date(seen.modified).toISOString()}`;

const errorCode = (err: unknown): string => (err as NodeJS.ErrnoException)?.code ?? 'an error';

/**
 * Whether the database at `dbPath` may be opened. Pure: the file system is
 * what `entry` and `list` say it is.
 *
 * `:memory:` and `''` pass straight through and look at nothing. A path that
 * is there and is not a regular file, or could not be looked at, is not
 * judged: the open says what is wrong. At the image's path, with a non-empty
 * file there, it opens whatever else is around (and names a non-empty
 * `<working directory>/dumpfire.db` as `other`). With no file there, or an
 * empty one, it is refused when any of these is found: a non-empty
 * `<working directory>/dumpfire.db`, any other non-empty `*.db` file in the
 * image's folder, or a non-empty `dumpfire.db-wal` beside the missing database
 * (the last of a database moved without it: a new database there would start
 * that file afresh). At any other path, on Linux, a new database is refused
 * while the image's own is there and not empty. Only regular files count. And
 * a new database is refused when any of those could not be looked at, or the
 * image's folder could not be listed.
 */
export function databaseLocation({ dbPath, cwd, entry, list, path }: LocationInput): Location {
	if (isMemory(dbPath)) return { isNew: false, other: null };

	const target = path.resolve(cwd, dbPath);
	const here = entry(target);
	if (here.kind === 'other' || here.kind === 'unknown') return { isNew: false, other: null };
	const legacyPath = path.resolve(cwd, LEGACY_DB_NAME);
	const emptyFile = here.kind === 'file' && here.size === 0;

	if (nonEmpty(here)) {
		if (target !== IMAGE_DB_PATH || legacyPath === target) return { isNew: false, other: null };
		const legacy = entry(legacyPath);
		const inUse = { path: target, size: here.size, modified: here.modified };
		return {
			isNew: false,
			other: nonEmpty(legacy) ? { path: legacyPath, size: legacy.size, modified: legacy.modified, inUse } : null
		};
	}

	// New: nothing there, or an empty file. Look for what it would hide.
	const found: Found[] = [];
	const unreadable: Unreadable[] = [];
	const look = (p: string, kind: Found['kind']) => {
		const seen = entry(p);
		if (seen.kind === 'unknown') unreadable.push({ path: p, code: seen.code });
		else if (nonEmpty(seen)) found.push({ path: p, size: seen.size, modified: seen.modified, kind });
	};

	if (target !== IMAGE_DB_PATH) {
		// Only where the image's path is a Linux path: on Windows it is C:\app\...
		if (path.sep !== '/') return { isNew: true, other: null };
		look(IMAGE_DB_PATH, 'image');
	} else {
		if (legacyPath !== target) look(legacyPath, 'legacy');

		const folder = path.dirname(target);
		let names: string[] = [];
		try {
			names = list(folder);
		} catch (err) {
			const code = errorCode(err);
			if (code !== 'ENOENT' && code !== 'ENOTDIR') unreadable.push({ path: folder, code });
		}
		for (const name of [...names].sort()) {
			if (!name.endsWith('.db')) continue;
			const candidate = path.join(folder, name);
			if (candidate === target || candidate === legacyPath) continue;
			look(candidate, 'volume');
		}

		look(`${target}-wal`, 'wal');
	}

	if (found.length === 0 && unreadable.length === 0) return { isNew: true, other: null };
	return {
		refuse: refusal(target, emptyFile, found, unreadable, path.join(cwd, 'uploads'), path.basename(target))
	};
}

/**
 * The refusal, one line. It names each file found, its size and when it was
 * last written (so the operator can tell which is live), and its way forward,
 * and each thing that could not be read. It never tells anyone to delete or
 * remove a file: read while the site is down, that would be an invitation to
 * lose the live database.
 */
function refusal(
	target: string,
	emptyFile: boolean,
	found: Found[],
	unreadable: Unreadable[],
	legacyUploads: string,
	name: string
): string {
	const ways = found.map((f) => {
		const what = `${f.path} (${described(f)})`;
		if (f.kind === 'image') {
			return (
				`${what}, the database the image opens, which DB_PATH does not point at (an empty DB_PATH falls back to ` +
				`the working directory's dumpfire.db): start the container with DB_PATH=${IMAGE_DB_PATH}, or take the ` +
				"DB_PATH setting out so that the image's own applies"
			);
		}
		if (f.kind === 'legacy') {
			return (
				`${what}, where a server started without DB_PATH keeps its database: with the container stopped, move it ` +
				`onto the volume as ${target}, with ${f.path}-wal and ${f.path}-shm if they are there and the uploads ` +
				`folder ${legacyUploads}; or start the container with DB_PATH=${f.path}`
			);
		}
		if (f.kind === 'volume') {
			return (
				`${what}: start the container with DB_PATH=${f.path}; or, with the container stopped, rename it ${name}, ` +
				`with its -wal and -shm files if they are there`
			);
		}
		return (
			`${what}, the write-ahead log of a database that is not there, holding changes no other file has: with ` +
			`the container stopped, put its database file back beside it as ${target}`
		);
	});
	const parts = [
		`The server will not start. ${emptyFile ? `The database file ${target} is empty` : `There is no database at ${target}`}, ` +
			'and opening it would make a new, empty one, which offers set-up to whoever opens the site first.'
	];
	if (ways.length > 0) {
		parts.push(
			`But this server can see what may be this installation's database: ${ways.join('; ')}. If a file named ` +
				"here is not this installation's database, move it out of that folder."
		);
	}
	if (unreadable.length > 0) {
		parts.push(
			`${ways.length > 0 ? 'And it' : 'But it'} could not look at ` +
				`${unreadable.map((u) => `${u.path} (${u.code})`).join(', ')}, where this installation's database may be, ` +
				'so it cannot say that there is none: let the server read it, or start the container with DB_PATH set to ' +
				'where the database is.'
		);
	}
	parts.push('Nothing was created or changed. See docs/deployment.md, under "Moving the database onto the volume".');
	return parts.join(' ');
}

/** Why the server will not open its database. `line` is what was written to the console. */
export class DatabaseLocationError extends Error {
	constructor(
		message: string,
		readonly line: string
	) {
		super(message);
		this.name = 'DatabaseLocationError';
	}
}

/** What is at a path, from the file system. Only ENOENT and ENOTDIR mean "nothing there". */
export function entryAt(path: string): Entry {
	try {
		const stat = statSync(path);
		return stat.isFile() ? { kind: 'file', size: stat.size, modified: stat.mtimeMs } : { kind: 'other' };
	} catch (err) {
		const code = errorCode(err);
		return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'none' } : { kind: 'unknown', code };
	}
}

/**
 * `databaseLocation` on the real file system. Throws a `DatabaseLocationError`
 * when the server must not open the database, carrying its `[CRITICAL] [DB]`
 * line in the logger's format, for db/index.ts to write to the console: the
 * system log is in the database, which is not open.
 */
export function checkDatabaseLocation(
	dbPath: string,
	cwd: string = process.cwd()
): { isNew: boolean; other: OtherDatabase | null } {
	const location = databaseLocation({ dbPath, cwd, entry: entryAt, list: (dir) => readdirSync(dir), path: nodePath });
	if ('refuse' in location) {
		const line = `[${new Date().toISOString()}] [CRITICAL] [DB] ${location.refuse}`;
		throw new DatabaseLocationError(location.refuse, line);
	}
	return location;
}

/** The types a container's own file system is mounted with. `fuse.<name>` is matched as `<name>`. */
const LAYER_TYPES = new Set(['overlay', 'fuse-overlayfs', 'aufs']);

/** `\040` and every other octal escape mountinfo writes (space, tab, line break, backslash). */
const unescape = (field: string) => field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));

/** Whether `dir` is `mountPoint` or inside it, by whole path segments. */
const holds = (mountPoint: string, dir: string) =>
	mountPoint === '/' || dir === mountPoint || dir.startsWith(`${mountPoint}/`);

/**
 * Whether the folder `dir` (absolute, Linux) is held by the container's own
 * file system rather than by a mounted volume, from the text of
 * `/proc/self/mountinfo`. Pure.
 *
 * The mount that holds it is the one with the longest mount point (field 5)
 * that contains it, by whole path segments; of two lines with the same mount
 * point, the later is the one on top. It is the container's own when that
 * mount is the root and its type (the first field after ` - `) is an overlay,
 * or when its type is `tmpfs`, which is lost with the container too. A layer
 * on another storage driver (btrfs, zfs, vfs) is not recognised. A Linux
 * workstation's root is a real file system, and empty text holds nothing, so
 * both answer false.
 */
export function heldInContainerLayer(dir: string, mountinfoText: string): boolean {
	let holder: { point: string; type: string } | null = null;
	for (const line of mountinfoText.split('\n')) {
		const fields = line.trim().split(' ');
		const dash = fields.indexOf('-', 6);
		if (fields.length < 5 || dash < 0 || dash + 1 >= fields.length) continue;
		const point = unescape(fields[4]);
		if (!holds(point, dir)) continue;
		if (holder === null || point.length >= holder.point.length) holder = { point, type: fields[dash + 1] };
	}
	if (holder === null) return false;
	const type = holder.type.startsWith('fuse.') ? holder.type.slice('fuse.'.length) : holder.type;
	return type === 'tmpfs' || (holder.point === '/' && LAYER_TYPES.has(type));
}
