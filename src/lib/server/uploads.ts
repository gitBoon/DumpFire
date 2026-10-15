/**
 * uploads.ts — where attachment files are, and the trash a deleted card's
 * files go to. The one definition of both.
 *
 *     <uploads>/<cardId>/<filename>            a card's file
 *     <uploads>/.trash/<cardId>/<filename>     the same file, once its row is deleted
 *     <uploads>/.trash/<cardId>/.trashed-at    when that folder was last added to
 *
 * An attachment row holds a file name only; the path is the card id and that
 * name, and every path is built here. Backups hold the database and not the
 * files, so a file whose row is deleted is not removed: it is moved to the
 * trash, where an import of an earlier backup can find it again, and the
 * trash is emptied of anything older than 30 days.
 *
 * Nothing here runs when the module is loaded, and nothing here touches the
 * database or the log. Each function says what it did and what it could not
 * do, and the caller logs it: `logger.ts` calls `emptyTrash`, so this module
 * must not import the logger.
 *
 * The files are moved with the synchronous calls, so that a delete has moved
 * them before it answers.
 */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getDbPath } from './db';

/** The uploads folder is somewhere it must not be. */
export class UploadsDirError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UploadsDirError';
	}
}

/** A card id or file name that does not name a file in a card's own folder. */
export class UploadPathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UploadPathError';
	}
}

/** A file as an attachment row names it. */
export type UploadFile = { cardId: number; filename: string };

/** How long a file stays in the trash. */
export const TRASH_DAYS = 30;

const TRASH = '.trash';
/** In each folder of the trash: the date it was last added to, as ISO text. */
const MARKER = '.trashed-at';

/** Whether `inner` is `outer` or is somewhere beneath it. */
function isOrContains(outer: string, inner: string): boolean {
	const rel = relative(outer, inner);
	return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * The uploads folder for these settings, or an `UploadsDirError`.
 *
 * It is the folder `uploads` beside the database, as it always was, unless
 * the environment variable `UPLOADS_DIR` names another. That variable is for
 * the tests, which must not write beside the real database, and is not a
 * documented setting.
 *
 * A folder that is, or contains, the database's folder or the working
 * directory is refused. Deleting a card moves files out of this folder and
 * removes folders from it, and the trash under it is emptied on a timer: none
 * of that may be pointed at the folder the database or the application is in.
 * An in-memory database has no folder, so it has no folder to put uploads
 * beside either, and `UPLOADS_DIR` has to say where they go.
 */
export function resolveUploadsDir(
	configured: string | null | undefined = process.env.UPLOADS_DIR,
	dbPath: string = getDbPath(),
	cwd: string = process.cwd()
): string {
	const dbDir = dbPath === ':memory:' || dbPath === '' ? null : dirname(resolve(cwd, dbPath));
	const named = configured?.trim();

	let dir: string;
	if (named) {
		dir = resolve(cwd, named);
	} else if (dbDir) {
		dir = join(dbDir, 'uploads');
	} else {
		throw new UploadsDirError(
			'The database is in memory, so there is no folder beside it to keep uploads in. Set UPLOADS_DIR.'
		);
	}

	if (dbDir && isOrContains(dir, dbDir)) {
		throw new UploadsDirError(
			`The uploads folder (${dir}) is, or contains, the folder the database is in (${dbDir}). ` +
				'Uploads are kept in a folder of their own.'
		);
	}
	if (isOrContains(dir, cwd)) {
		throw new UploadsDirError(
			`The uploads folder (${dir}) is, or contains, the working directory (${cwd}). ` +
				'Uploads are kept in a folder of their own.'
		);
	}
	return dir;
}

let checked: string | null = null;

/**
 * The uploads folder. Worked out and checked the first time it is asked for,
 * not when the module is loaded, and kept from then on. Throws an
 * `UploadsDirError` every time it is asked while the folder is one that is
 * refused. The folder itself need not exist yet.
 */
export function uploadsDir(): string {
	checked ??= resolveUploadsDir();
	return checked;
}

function folderName(cardId: number): string {
	if (!Number.isSafeInteger(cardId) || cardId < 1) {
		throw new UploadPathError(`${String(cardId)} is not a card id, so it names no uploads folder`);
	}
	return String(cardId);
}

/** The folder a card's files are in. */
export function cardDir(cardId: number): string {
	return join(uploadsDir(), folderName(cardId));
}

/** The folder a card's files are moved to when their rows are deleted. */
function trashDirOf(cardId: number): string {
	return join(uploadsDir(), TRASH, folderName(cardId));
}

/**
 * Refuse a file name that is not the plain name of a file in `dir`.
 *
 * After a restore a file name is data: it is whatever the backup held. A name
 * with a separator, a drive or a `..` in it would be joined into a path
 * outside the card's folder, and the file there read, served or moved.
 */
function plainName(dir: string, filename: string): string {
	const refused =
		typeof filename !== 'string' ||
		filename === '' ||
		filename === '.' ||
		filename === '..' ||
		filename === MARKER ||
		/[/\\:\0]/.test(filename) ||
		dirname(resolve(dir, filename)) !== resolve(dir);
	if (refused) {
		throw new UploadPathError(
			`The file name ${JSON.stringify(filename)} is not the name of a file in the card's own folder`
		);
	}
	return filename;
}

/**
 * The path of a card's file, from the card id and the stored file name.
 * Throws an `UploadPathError` for a name that would resolve anywhere but
 * straight into the card's folder.
 */
export function attachmentPath(cardId: number, filename: string): string {
	const dir = cardDir(cardId);
	return join(dir, plainName(dir, filename));
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Remove a folder if it is there and has nothing in it. Never recursive. */
function removeIfEmpty(dir: string): void {
	try {
		if (readdirSync(dir).length === 0) rmdirSync(dir);
	} catch {
		// Not there, or something was put in it meanwhile: it stays.
	}
}

/** The card ids of `files`, each once. */
function cardIdsOf(files: readonly UploadFile[]): number[] {
	return [...new Set(files.map((f) => f.cardId))];
}

export type TrashResult = {
	/** Files that are in the trash now. */
	moved: number;
	/** Files that were not in the card's folder. Not a failure: a working copy has none. */
	missing: number;
	/** Files that are still where they were, each with why. */
	failed: string[];
};

/**
 * Move the files of deleted attachment rows to the trash.
 *
 * Call it once the delete is committed (`trashAfterCommit`, in `deletes.ts`,
 * does). Only the files named are moved. A card's folder is then removed if
 * nothing is left in it, and is left alone if anything is. A file that is not
 * there is passed over. A file that cannot be moved, or whose name is
 * refused, is reported in `failed` and stops nothing: the rows are gone
 * whatever happens here.
 *
 * Throws only an `UploadsDirError`, for an uploads folder that is refused.
 */
export function moveToTrash(files: readonly UploadFile[], now: Date = new Date()): TrashResult {
	const result: TrashResult = { moved: 0, missing: 0, failed: [] };
	if (files.length === 0) return result;
	uploadsDir();

	const marked = new Set<number>();
	for (const file of files) {
		const called = `card ${file.cardId}, ${JSON.stringify(file.filename)}`;
		try {
			const from = attachmentPath(file.cardId, file.filename);
			if (!existsSync(from)) {
				result.missing++;
				continue;
			}
			const trash = trashDirOf(file.cardId);
			if (!marked.has(file.cardId)) {
				// The marker goes in before the first file, so that a folder of
				// the trash with a file in it always says how old it is. A folder
				// added to again is dated again: nothing in it is removed sooner
				// than 30 days after it arrived.
				mkdirSync(trash, { recursive: true });
				writeFileSync(join(trash, MARKER), now.toISOString());
				marked.add(file.cardId);
			}
			renameSync(from, join(trash, file.filename));
			result.moved++;
		} catch (err) {
			result.failed.push(`${called}: ${messageOf(err)}`);
		}
	}

	for (const cardId of cardIdsOf(files)) {
		try {
			removeIfEmpty(cardDir(cardId));
		} catch {
			// Not a card id: there is no folder to remove.
		}
	}
	return result;
}

export type EmptyTrashResult = {
	/** Folders of the trash that were removed, with the files in them. */
	removed: number;
	/** Folders that were due to go and are still there, each with why. */
	failed: string[];
};

/**
 * Remove from the trash every folder that was last added to more than
 * `TRASH_DAYS` days before `now`, and nothing else.
 *
 * It reads the names in the trash folder and removes only what it finds
 * there: the files in a folder that is due, and then the folder. It follows
 * no link, and it does not remove a folder that has a folder inside it, so
 * it cannot reach anything outside the trash.
 *
 * A folder with no readable marker is dated by when it was last changed.
 */
export function emptyTrash(now: Date = new Date()): EmptyTrashResult {
	const result: EmptyTrashResult = { removed: 0, failed: [] };
	const trash = join(uploadsDir(), TRASH);
	const cutoff = now.getTime() - TRASH_DAYS * 86_400_000;

	let names: string[];
	try {
		if (!lstatSync(trash).isDirectory()) return result;
		names = readdirSync(trash);
	} catch {
		// No trash yet.
		return result;
	}

	for (const name of names) {
		const folder = join(trash, name);
		try {
			const stat = lstatSync(folder);
			// Only the folders this module makes: a card id, and a real folder.
			if (!/^\d+$/.test(name) || !stat.isDirectory()) continue;

			let trashedAt = NaN;
			try {
				trashedAt = Date.parse(readFileSync(join(folder, MARKER), 'utf8').trim());
			} catch {
				// No marker.
			}
			if (Number.isNaN(trashedAt)) trashedAt = stat.mtimeMs;
			if (trashedAt >= cutoff) continue;

			for (const entry of readdirSync(folder)) {
				const path = join(folder, entry);
				// A folder in here was not put here by this module. It is left,
				// and so the folder around it is: removing it fails below.
				if (lstatSync(path).isDirectory()) continue;
				unlinkSync(path);
			}
			rmdirSync(folder);
			result.removed++;
		} catch (err) {
			result.failed.push(`${name}: ${messageOf(err)}`);
		}
	}
	return result;
}

export type PutBackResult = {
	/** Files moved from the trash back to their card's folder. */
	putBack: number;
	/** Files that are in the trash and could not be put back, each with why. */
	failed: string[];
};

/**
 * Put back, from the trash, each of `files` that is missing from its card's
 * folder and is in the trash. For an import, once it is committed: the rows
 * it brought back name files that a delete since the backup had moved away.
 *
 * A file that is where it should be is left alone, and so is one that is in
 * neither place. A folder of the trash left with nothing but its marker is
 * removed.
 *
 * Throws only an `UploadsDirError`, for an uploads folder that is refused.
 */
export function putBackFromTrash(files: readonly UploadFile[]): PutBackResult {
	const result: PutBackResult = { putBack: 0, failed: [] };
	if (files.length === 0) return result;
	uploadsDir();

	const emptied = new Set<number>();
	for (const file of files) {
		const called = `card ${file.cardId}, ${JSON.stringify(file.filename)}`;
		try {
			const to = attachmentPath(file.cardId, file.filename);
			if (existsSync(to)) continue;
			const from = join(trashDirOf(file.cardId), file.filename);
			if (!existsSync(from)) continue;
			mkdirSync(cardDir(file.cardId), { recursive: true });
			renameSync(from, to);
			result.putBack++;
			emptied.add(file.cardId);
		} catch (err) {
			// A name that is refused is in no folder this module would look in.
			if (err instanceof UploadPathError) continue;
			result.failed.push(`${called}: ${messageOf(err)}`);
		}
	}

	for (const cardId of emptied) {
		const trash = trashDirOf(cardId);
		try {
			const left = readdirSync(trash);
			if (left.length === 1 && left[0] === MARKER) unlinkSync(join(trash, MARKER));
		} catch {
			// Gone already.
		}
		removeIfEmpty(trash);
	}
	return result;
}

// ─── Serving ────────────────────────────────────────────────────────────────

/**
 * The types shown in the browser: none of them can run a script. Each needs
 * both its extension and the type stored with the upload, and is answered
 * with the type written here, never with the stored text.
 */
const INERT: { extensions: string[]; stored: string; served: string }[] = [
	{ extensions: ['png'], stored: 'image/png', served: 'image/png' },
	{ extensions: ['jpg', 'jpeg'], stored: 'image/jpeg', served: 'image/jpeg' },
	{ extensions: ['gif'], stored: 'image/gif', served: 'image/gif' },
	{ extensions: ['webp'], stored: 'image/webp', served: 'image/webp' },
	{ extensions: ['txt'], stored: 'text/plain', served: 'text/plain; charset=utf-8' }
];

/**
 * The headers an attachment is answered with.
 *
 * Everything is a download, as `application/octet-stream`, except the short
 * list above. An attachment used to be answered `inline` with whatever type
 * the uploader gave it, so an uploaded HTML or SVG file opened as a page of
 * the application, with the reader's session. The stored type and the name
 * are both the uploader's, so both have to agree: a file named `.png` that
 * was uploaded as `text/html` is a download.
 *
 * A PDF is a download too. A browser shows one in its own viewer, and that
 * viewer does not start inside a sandbox, so a PDF could be shown only by
 * leaving the sandbox off it.
 *
 * `nosniff` goes on every one, so that what is shown in the browser is shown
 * as the type named. `sandbox` goes on every one, so that what is shown can
 * run nothing.
 */
export function attachmentHeaders(attachment: {
	originalName: string;
	mimeType: string;
}): Record<string, string> {
	const name = String(attachment.originalName ?? '');
	const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1].toLowerCase() ?? '';
	const stored = String(attachment.mimeType ?? '').split(';')[0].trim().toLowerCase();
	const inert = INERT.find((type) => type.stored === stored && type.extensions.includes(extension));

	// A plain ASCII name for a browser that does not read `filename*`, and the
	// real one encoded as RFC 5987 has it. The name is the uploader's: put in
	// the header as it was, a quote or a line break in it wrote the header.
	const ascii = name.replace(/[^\x20-\x7E]|["\\]/g, '_').trim() || 'download';
	let encoded: string;
	try {
		encoded = encodeURIComponent(name || 'download');
	} catch {
		// Half of a surrogate pair, which cannot be encoded.
		encoded = encodeURIComponent(ascii);
	}
	encoded = encoded.replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

	return {
		'Content-Type': inert ? inert.served : 'application/octet-stream',
		'Content-Disposition': `${inert ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
		'X-Content-Type-Options': 'nosniff',
		'Content-Security-Policy': 'sandbox'
	};
}
