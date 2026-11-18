/**
 * attachment-names.ts — the name and the type an uploaded file is stored with
 * (card 2910, D11 and D12; the plan review's E2). Strings in, strings out: no
 * row, no caller, nothing kept. Not a service.
 *
 *   cleanedName   the uploader's name with its folders, the characters the
 *                 log will not print (`UNPRINTABLE` in logger.ts: controls,
 *                 format characters, line and paragraph separators,
 *                 direction controls) and `<>:"|?*` taken out, and its ends
 *                 trimmed. An image's name is built on it too
 *                 (`imageName` in card-attachments.ts).
 *   fileName      a file that is not an image: the cleaned name, its stem cut
 *                 to 100 characters and its extension kept as sent, since the
 *                 extension decides how it is served (`attachmentHeaders` in
 *                 uploads.ts). A name with nothing left is
 *                 `file-<UTC date>-<time>`, with the extension if it had one:
 *                 a dotfile such as `.env` is the extension `env` with
 *                 nothing before it, and is stored `file-<stamp>.env`.
 *   storedType    the declared type, before any parameters, trimmed and in
 *                 lower case, when it is a plain type; else
 *                 `application/octet-stream`.
 *
 * The file on disk is named by the server alone (`<uuid>`, the route's): the
 * name here is shown and given back as the download's, never used as a path.
 */
import { UNPRINTABLE } from './logger';

/** The longest stem a file's name keeps, before its extension. */
const LONGEST_NAME = 100;

/** Every character `cleanedName` takes out: the log's unprintable ones, and those no file system takes in a name. */
const NOT_IN_A_NAME = new RegExp(`${UNPRINTABLE.source}|[<>:"|?*]`, 'gu');

/** An extension at the end of a name: a dot and one to ten letters or digits. */
const EXTENSION = /\.([A-Za-z0-9]{1,10})$/;

/** A type kept as declared: `type/subtype`, each a letter or digit and then up to 63 of the token characters. */
const PLAIN_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

/** The uploader's name, its last part after `/` or `\`, with what `NOT_IN_A_NAME` matches taken out and its ends trimmed. */
export function cleanedName(asked: string): string {
	const last = asked.split(/[\\/]/).pop() ?? '';
	return last.replace(NOT_IN_A_NAME, '').trim();
}

/** `<UTC date>-<time>` of `now`, as `2099-01-02-030405`: the name of a file that has none left. */
export function stampOf(now: Date): string {
	const [date, time] = now.toISOString().split('T');
	return `${date}-${time.slice(0, 8).replace(/:/g, '')}`;
}

/**
 * The name a file that is not an image is stored and shown with, and its
 * extension as sent (null for none): `cleanedName`'s, the stem before the
 * extension cut to `LONGEST_NAME` characters and its trailing dots and spaces
 * trimmed, and the extension put back as it was sent, its case kept. With no
 * stem left, `file-<stamp>` and the extension.
 */
export function fileName(asked: string, now: Date): { name: string; extension: string | null } {
	const cleaned = cleanedName(asked);
	const found = EXTENSION.exec(cleaned);
	const extension = found ? found[1] : null;
	const before = found ? cleaned.slice(0, found.index) : cleaned;
	const stem = Array.from(before).slice(0, LONGEST_NAME).join('').replace(/[.\s]+$/, '').trim();
	const base = stem !== '' ? stem : `file-${stampOf(now)}`;
	return { name: extension === null ? base : `${base}.${extension}`, extension };
}

/** The type a file is stored with: the declared one, before any `;`, trimmed and in lower case, when it is plain; else `application/octet-stream`. */
export function storedType(declared: string): string {
	const type = declared.split(';')[0].trim().toLowerCase();
	return PLAIN_TYPE.test(type) ? type : 'application/octet-stream';
}
