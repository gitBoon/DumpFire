/**
 * Card 2761, slice S2 (D10, the plan review's S11; the code review's CS1 to
 * CS4 and CR1 to CR4): the images stored before the card, checked once at
 * the first start (`recheckStoredImages`, in `$lib/server/image-recheck`),
 * and again after an import of a backup.
 *
 * Each outcome a row can have (stripped, clean, resized, retyped, missing),
 * the one WARN line and the settings flag; a second start that does nothing;
 * a row that fails, which leaves the flag unwritten for the next start to
 * finish, and one that fails the same way at three starts, which is given up;
 * a phone's JPEG with a video after its image, stripped in place; and an
 * import whose backup has no flag, checked at once.
 *
 * Every file here is under the tests' own uploads folder, which
 * `tests/setup.ts` makes under the operating system's temp folder and
 * `resetDb()` empties. Nothing here goes near ./uploads.
 */
import { mkdtempSync, promises as fsPromises, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { cardAttachments, type Card, type CardAttachment } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { checkImage } from '$lib/server/image-check';
import { recheckStoredImages, STORED_IMAGES_RECHECK_FAILURES, STORED_IMAGES_RECHECKED } from '$lib/server/image-recheck';
import { be32, bytes, phoneExif, phoneJpeg, png, pngChunk } from './helpers/image-bytes';
import { api } from './helpers/api';
import { importConfirmation, makeAttachment, makeBoard, makeCard, makeUser, resetDb, testUploadsDir } from './helpers/fixtures';

let owner: SessionUser;
let card: Card;
const tempDirs: string[] = [];

beforeEach(() => {
	resetDb();
	owner = makeUser({ username: 'owner' });
	card = makeCard(makeBoard({ owner, name: 'A' }).cols['To Do'], { title: 'Has images' });
});

afterEach(() => {
	vi.restoreAllMocks();
	process.env.LOG_LEVEL = 'ERROR';
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const at = (...parts: (string | number)[]) => join(testUploadsDir(), ...parts.map(String));
const rowOf = (file: CardAttachment) => db.select().from(cardAttachments).where(eq(cardAttachments.id, file.id)).get()!;
const setting = (key: string) => (sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
const flag = () => setting(STORED_IMAGES_RECHECKED);
/** A temp file the check left in the card's folder. */
const temps = () => readdirSync(at(card.id)).filter((name) => name.startsWith('.recheck'));
/** A PNG holding a text chunk, which the check takes out. */
const withText = () => png({ before: [pngChunk('tEXt', 'Comment\0secret-location')] });
/** What one run did, with nothing in the fields not named. */
const outcome = (counts: Partial<Record<'checked' | 'clean' | 'resized' | 'stripped' | 'retyped' | 'missing' | 'failed' | 'givenUp', number>>, ids: { retypedIds?: number[]; failedIds?: number[]; givenUpIds?: number[] } = {}) => ({
	checked: 0,
	clean: 0,
	resized: 0,
	stripped: 0,
	retyped: 0,
	missing: 0,
	failed: 0,
	givenUp: 0,
	retypedIds: [],
	failedIds: [],
	givenUpIds: [],
	...counts,
	...ids
});
/** The rest of the line after the counts that stay 0 in a case. */
const REFUSED = 'refused by the check \\(not the image its type names, animated, too large, or malformed\\)';

/** Run the check and give back what it resolved to and the log lines it wrote at INFO and above, quietly. */
async function logged() {
	process.env.LOG_LEVEL = 'INFO';
	const lines: string[] = [];
	const keep = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
	vi.spyOn(console, 'log').mockImplementation(keep);
	vi.spyOn(console, 'warn').mockImplementation(keep);
	vi.spyOn(console, 'error').mockImplementation(keep);
	const result = await recheckStoredImages();
	vi.mocked(console.log).mockRestore();
	vi.mocked(console.warn).mockRestore();
	vi.mocked(console.error).mockRestore();
	return { result, lines };
}

/** `fs.promises.rename` failing with `code` for the files of `ids`' rows, every other call the real one. */
function failRenames(rows: CardAttachment[], code: string) {
	const realRename = fsPromises.rename;
	return vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
		if (rows.some((row) => String(to).endsWith(row.filename))) throw Object.assign(new Error(`${code}: made to fail`), { code });
		return realRename(from, to);
	});
}

describe('the images stored before card 2761, checked once (D10)', () => {
	it('11. strips one in place, leaves a clean one alone, retypes one that is not its image, passes over one with no file; one WARN line and the flag', async () => {
		const stripped = makeAttachment(card, { name: 'photo.png', mimeType: 'image/png', content: withText() });
		const clean = makeAttachment(card, { name: 'clean.png', mimeType: 'IMAGE/PNG', content: png() });
		const page = '<html><script>alert(1)</script></html>';
		const lying = makeAttachment(card, { name: 'shot.png', mimeType: 'image/png', content: page });
		const missing = makeAttachment(card, { name: 'gone.png', mimeType: 'image/png', file: false });
		// Not an image by its stored type: not looked at.
		const notes = makeAttachment(card, { name: 'notes.txt' });
		const old = new Date(Date.now() - 86_400_000);
		utimesSync(at(card.id, clean.filename), old, old);
		const cleanMtime = statSync(at(card.id, clean.filename)).mtimeMs;

		const { result, lines } = await logged();

		expect(result).toEqual(outcome({ checked: 4, clean: 1, stripped: 1, retyped: 1, missing: 1 }, { retypedIds: [lying.id] }));
		// Stripped: the file written again without its text chunk, and its size set.
		expect(Buffer.compare(readFileSync(at(card.id, stripped.filename)), Buffer.from(png()))).toBe(0);
		expect(rowOf(stripped)).toMatchObject({ sizeBytes: png().length, mimeType: 'image/png', originalName: 'photo.png' });
		// Clean: not written.
		expect(statSync(at(card.id, clean.filename)).mtimeMs).toBe(cleanMtime);
		expect(rowOf(clean)).toEqual(clean);
		// Retyped: the file untouched, and from now on only a download.
		expect(readFileSync(at(card.id, lying.filename), 'utf8')).toBe(page);
		expect(rowOf(lying)).toEqual({ ...lying, mimeType: 'application/octet-stream' });
		const served = await api('GET', `/api/cards/${card.id}/attachments/${lying.id}`, { user: owner });
		expect(served.status).toBe(200);
		expect(served.headers.get('content-disposition')).toMatch(/^attachment; /);
		expect(served.headers.get('content-type')).toBe('application/octet-stream');
		// Missing, and not an image: untouched.
		expect(rowOf(missing)).toEqual(missing);
		expect(rowOf(notes)).toEqual(notes);
		// Nothing left beside the files.
		expect(temps()).toEqual([]);

		expect(lines).toEqual([
			expect.stringMatching(
				new RegExp(
					`\\[WARN\\] \\[UPLOADS\\] Checked the 4 images stored before card 2761: 1 had hidden data taken out, 0 had only their recorded size corrected, ` +
						`1 were ${REFUSED} and are now downloads only \\(attachment ids ${lying.id}\\), 1 had no file, 0 could not be checked, ` +
						`0 were given up after failing the same way at 3 starts\\.$`
				)
			)
		]);
		expect(flag()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('12. does nothing at a second start: null, no line, no file read', async () => {
		makeAttachment(card, { name: 'photo.png', mimeType: 'image/png', content: withText() });
		expect((await logged()).result).toMatchObject({ checked: 1, stripped: 1 });
		const reads = vi.spyOn(fsPromises, 'readFile');

		const { result, lines } = await logged();

		expect(result).toBeNull();
		expect(lines).toEqual([]);
		expect(reads).not.toHaveBeenCalled();
	});

	it('13. counts a row whose rename fails as failed, names it, does the others, and writes no flag; the next start finishes it and writes the flag', async () => {
		const first = makeAttachment(card, { name: 'first.png', mimeType: 'image/png', content: withText() });
		const second = makeAttachment(card, { name: 'second.png', mimeType: 'image/png', content: withText() });
		const renames = failRenames([first], 'EIO');

		const { result, lines } = await logged();

		expect(result).toEqual(outcome({ checked: 2, stripped: 1, failed: 1 }, { failedIds: [first.id] }));
		// The first, oldest, failed: as it was, its row untouched, and no temp file left beside it.
		expect(Buffer.compare(readFileSync(at(card.id, first.filename)), Buffer.from(withText()))).toBe(0);
		expect(rowOf(first)).toEqual(first);
		expect(temps()).toEqual([]);
		// The second done.
		expect(Buffer.compare(readFileSync(at(card.id, second.filename)), Buffer.from(png()))).toBe(0);
		expect(rowOf(second).sizeBytes).toBe(png().length);
		expect(lines).toEqual([
			expect.stringMatching(
				new RegExp(
					`\\[WARN\\] \\[UPLOADS\\] Checked the 2 images stored before card 2761: 1 had hidden data taken out, 0 had only their recorded size corrected, ` +
						`0 were ${REFUSED} and are now downloads only, 0 had no file, 1 could not be checked \\(attachment ids ${first.id}\\), ` +
						`0 were given up after failing the same way at 3 starts\\. The next start checks them again\\.$`
				)
			)
		]);
		expect(flag()).toBeUndefined();
		expect(JSON.parse(setting(STORED_IMAGES_RECHECK_FAILURES)!)).toEqual({ [first.id]: { reason: 'EIO', starts: 1 } });

		// The next start: the first stripped, the second checks to itself, the flag written and the failures gone.
		renames.mockRestore();
		const again = await logged();
		expect(again.result).toEqual(outcome({ checked: 2, clean: 1, stripped: 1 }));
		expect(Buffer.compare(readFileSync(at(card.id, first.filename)), Buffer.from(png()))).toBe(0);
		expect(rowOf(first).sizeBytes).toBe(png().length);
		expect(flag()).toBeDefined();
		expect(setting(STORED_IMAGES_RECHECK_FAILURES)).toBeUndefined();
	});
});

describe('the one-off check, after the code review (card 2761, CS1 to CS4)', () => {
	it("16. strips a stored phone JPEG with a video after its image in place, cut at its EOI, its orientation kept; it is not retyped (CS1)", async () => {
		const exif = phoneExif({ order: 'II' });
		const video = bytes(be32(0x18), 'ftypmp42', 'secret-video-frames', exif.position);
		const photo = makeAttachment(card, { name: 'motion.jpg', mimeType: 'image/jpeg', content: bytes(phoneJpeg({ order: 'II' }), video) });

		const { result } = await logged();

		expect(result).toEqual(outcome({ checked: 1, stripped: 1 }));
		const kept = readFileSync(at(card.id, photo.filename));
		const primary = checkImage(phoneJpeg({ order: 'II' }), 'image/jpeg');
		expect(primary.ok).toBe(true);
		expect(Buffer.compare(kept, Buffer.from((primary as { bytes: Uint8Array }).bytes))).toBe(0);
		expect(kept.toString('latin1')).not.toMatch(/ftyp|secret|Pixelphone/);
		expect(kept.indexOf(Buffer.from(exif.position))).toBe(-1);
		expect(rowOf(photo)).toEqual({ ...photo, sizeBytes: kept.length });
		// Still shown as the image it is.
		const served = await api('GET', `/api/cards/${card.id}/attachments/${photo.id}`, { user: owner });
		expect(served.headers.get('content-disposition')).toMatch(/^inline; /);
	});

	it('17. gives up a row that fails the same way at three starts, naming it, and writes the flag; a row whose failure changes starts its count again (CS2)', async () => {
		const stuck = makeAttachment(card, { name: 'stuck.png', mimeType: 'image/png', content: withText() });
		const changing = makeAttachment(card, { name: 'changing.png', mimeType: 'image/png', content: withText() });
		const codes = ['EIO', 'EIO', 'EBUSY'];

		for (const [start, code] of codes.entries()) {
			const realRename = fsPromises.rename;
			const renames = vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
				const failing = String(to).endsWith(stuck.filename) ? 'EIO' : String(to).endsWith(changing.filename) ? code : null;
				if (failing) throw Object.assign(new Error(`${failing}: made to fail`), { code: failing });
				return realRename(from, to);
			});
			const { result, lines } = await logged();
			renames.mockRestore();

			if (start < 2) {
				expect(result, `start ${start + 1}`).toEqual(outcome({ checked: 2, failed: 2 }, { failedIds: [stuck.id, changing.id] }));
				expect(flag(), `start ${start + 1}`).toBeUndefined();
			} else {
				// The third start: the stuck row failed with EIO three times and is given up; the other failed with
				// another code this time, so its count is 1 and it still keeps the flag from being written.
				expect(result).toEqual(outcome({ checked: 2, failed: 1, givenUp: 1 }, { failedIds: [changing.id], givenUpIds: [stuck.id] }));
				expect(lines).toEqual([
					expect.stringMatching(
						new RegExp(
							`1 could not be checked \\(attachment ids ${changing.id}\\), 1 were given up after failing the same way at 3 starts ` +
								`\\(attachment ids ${stuck.id}\\)\\. The next start checks them again\\.$`
						)
					)
				]);
				expect(JSON.parse(setting(STORED_IMAGES_RECHECK_FAILURES)!)).toEqual({
					[stuck.id]: { reason: 'EIO', starts: 3 },
					[changing.id]: { reason: 'EBUSY', starts: 1 }
				});
				expect(flag()).toBeUndefined();
			}
		}

		// The stuck row alone failing: given up again, nothing failed, so the flag is written and the failures cleared.
		const renames = failRenames([stuck], 'EIO');
		const { result } = await logged();
		renames.mockRestore();
		expect(result).toEqual(outcome({ checked: 2, stripped: 1, givenUp: 1 }, { givenUpIds: [stuck.id] }));
		expect(flag()).toBeDefined();
		expect(setting(STORED_IMAGES_RECHECK_FAILURES)).toBeUndefined();
		expect(temps()).toEqual([]);
	});

	it("18. sets a clean image's recorded size when it is not the file's, writing no file (CR2)", async () => {
		const clean = makeAttachment(card, { name: 'clean.png', mimeType: 'image/png', content: png() });
		db.update(cardAttachments).set({ sizeBytes: 12345 }).where(eq(cardAttachments.id, clean.id)).run();
		const old = new Date(Date.now() - 86_400_000);
		utimesSync(at(card.id, clean.filename), old, old);
		const mtime = statSync(at(card.id, clean.filename)).mtimeMs;

		const { result, lines } = await logged();

		expect(result).toEqual(outcome({ checked: 1, clean: 1, resized: 1 }));
		expect(rowOf(clean).sizeBytes).toBe(png().length);
		expect(statSync(at(card.id, clean.filename)).mtimeMs).toBe(mtime);
		expect(lines[0]).toContain('0 had hidden data taken out, 1 had only their recorded size corrected,');
		expect(flag()).toBeDefined();
	});

	it('19. checks the images of an imported backup at once, as a start does, the restore having replaced the flag (CS3)', { timeout: 60_000 }, async () => {
		const admin = makeUser({ role: 'superadmin' });
		const photo = makeAttachment(card, { name: 'photo.png', mimeType: 'image/png', content: withText() });
		// A backup made before the release: no flag in it. The running database has been checked.
		const backup = sqlite.serialize();
		sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(STORED_IMAGES_RECHECKED, '2026-11-17T00:00:00.000Z');
		// The import route writes two files in the working directory: give it one of its own.
		const dir = mkdtempSync(join(tmpdir(), 'dumpfire-import-'));
		tempDirs.push(dir);
		vi.spyOn(process, 'cwd').mockReturnValue(dir);
		process.env.LOG_LEVEL = 'ERROR';

		const res = await api('POST', '/api/admin/import?outside=keep', {
			user: admin,
			headers: { 'content-type': 'application/octet-stream', ...importConfirmation(admin) },
			body: backup
		});

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		await vi.waitFor(() => expect(Buffer.compare(readFileSync(at(card.id, photo.filename)), Buffer.from(png()))).toBe(0));
		await vi.waitFor(() => expect(flag()).toBeDefined());
		expect(rowOf(photo).sizeBytes).toBe(png().length);
	});
});
