/**
 * Image retention (card 2754, slice S3; the plan's D14 and D15, and the plan
 * review's S1, S5 and S6): the images of cards closed longer than
 * `IMAGE_RETENTION_DAYS` are moved to the trash by DumpFire itself, inside the
 * attachment file sweep.
 *
 * A card counts as closed when it is archived, or sits now in a Complete-role
 * column, with the stamp older than the cutoff; a stale `completed_at` on a
 * card in any other column, a renamed Complete column among them, keeps its
 * images. Each row deleted writes `attachment_expired`, source `system`, no
 * user, named DumpFire; the files go to the 30-day trash once that commits.
 * At most 200 a run. The setting fails closed. Retention has its own
 * try/catch, so the orphan sweep always runs.
 *
 * Every file is under the tests' own uploads folder (`tests/setup.ts`), which
 * `resetDb()` empties. Ages are set with `utimesSync` where the orphan sweep
 * must see a file as old.
 */
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, sqlite } from '$lib/server/db';
import { activityLog, cardAttachments, columns, type Card, type CardAttachment } from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import type { SessionUser } from '$lib/server/auth';
import { expireClosedCardImages, MOST_EXPIRED_A_RUN, retentionDays } from '$lib/server/image-retention';
import { sweepUploads } from '$lib/server/uploads-sweep';
import { stamp } from '$lib/timestamps';
import { effects } from './helpers/effects';
import { makeAttachment, makeBoard, makeCard, makeUser, makeWebhook, resetDb, testUploadsDir, type BoardFixture } from './helpers/fixtures';

const DAY_MS = 86_400_000;

let owner: SessionUser;
let A: BoardFixture;

beforeEach(() => {
	resetDb();
	owner = makeUser({ username: 'owner' });
	A = makeBoard({ owner, name: 'A' });
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	process.env.LOG_LEVEL = 'ERROR';
});

const NOW = () => new Date();
const daysAgo = (days: number, now: Date = new Date()) => stamp(new Date(now.getTime() - days * DAY_MS));
const at = (...parts: (string | number)[]) => join(testUploadsDir(), ...parts.map(String));
const rows = () => db.select().from(cardAttachments).all();
const expiredEntries = () => db.select().from(activityLog).where(eq(activityLog.action, 'attachment_expired')).all();

/** An image on `card`, its file written two days ago, so that the orphan sweep would move it once no row names it. */
function image(card: Card, name = 'shot.png', mimeType = 'image/png'): CardAttachment {
	const row = makeAttachment(card, { name, mimeType });
	const old = new Date(Date.now() - 2 * DAY_MS);
	utimesSync(at(card.id, row.filename), old, old);
	return row;
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

describe('what retention takes', () => {
	it('34. an image on a card in Complete, completed 181 days ago: the row, an entry by DumpFire with source system, the file in the trash, the live event, no webhook', async () => {
		makeWebhook(A.board);
		const card = makeCard(A.cols['Complete'], { title: 'Shipped', completedAt: daysAgo(181) });
		const row = image(card, 'login‮page.png');
		const sent = effects();
		try {
			expect(expireClosedCardImages(NOW(), 180)).toEqual({ expired: 1, more: false });
			await sent.settle();

			expect(rows()).toEqual([]);
			expect(expiredEntries()).toEqual([
				expect.objectContaining({
					boardId: A.board.id,
					cardId: card.id,
					userId: null,
					userName: 'DumpFire',
					action: 'attachment_expired',
					source: 'system',
					detail: 'Moved "loginpage.png" on "Shipped" to the trash: the card was closed more than 180 days ago'
				})
			]);
			expect(existsSync(at(card.id, row.filename))).toBe(false);
			expect(readFileSync(at('.trash', card.id, row.filename), 'utf8')).toBe('The contents of login‮page.png');
			expect(existsSync(at('.trash', card.id, '.trashed-at'))).toBe(true);
			expect(sent.events.map((e) => ({ boardId: e.boardId, event: e.event, data: e.data }))).toEqual([
				{ boardId: A.board.id, event: 'update', data: { type: 'attachment', cardId: card.id } }
			]);
			expect(sent.duringTransaction).toEqual([]);
			expect(sent.webhooks).toEqual([]);
		} finally {
			sent.restore();
		}
	});

	it('35. keeps an image on a card completed 179 days ago', () => {
		const card = makeCard(A.cols['Complete'], { completedAt: daysAgo(179) });
		image(card);

		expect(expireClosedCardImages(NOW(), 180)).toEqual({ expired: 0, more: false });
		expect(rows()).toHaveLength(1);
		expect(expiredEntries()).toEqual([]);
	});

	it('36. takes an image on a card archived 181 days ago, whatever column it is in', () => {
		const card = makeCard(A.cols['To Do'], { archivedAt: daysAgo(181) });
		image(card);
		const recent = makeCard(A.cols['To Do'], { archivedAt: daysAgo(179) });
		const kept = image(recent);

		expect(expireClosedCardImages(NOW(), 180)).toEqual({ expired: 1, more: false });
		expect(rows().map((r) => r.id)).toEqual([kept.id]);
	});

	it('37. keeps an image on a card with a completed_at 181 days old in a column that is not Complete, and in a Complete column since renamed (S1)', () => {
		const moved = makeCard(A.cols['In Progress'], { completedAt: daysAgo(181) });
		image(moved);
		const renamed = makeBoard({ owner, name: 'Renamed' });
		const card = makeCard(renamed.cols['Complete'], { completedAt: daysAgo(181) });
		image(card);
		db.update(columns).set({ title: 'Released' }).where(eq(columns.id, renamed.cols['Complete'].id)).run();

		expect(expireClosedCardImages(NOW(), 180)).toEqual({ expired: 0, more: false });
		expect(rows()).toHaveLength(2);

		// A column titled Done is a Complete-role column, as burndown reads it.
		db.update(columns).set({ title: ' done ' }).where(eq(columns.id, renamed.cols['Complete'].id)).run();
		expect(expireClosedCardImages(NOW(), 180)).toEqual({ expired: 1, more: false });
	});

	it('38. keeps an image on a reopened card: completed_at cleared, first_completed_at old', () => {
		const card = makeCard(A.cols['To Do'], { completedAt: null, firstCompletedAt: daysAgo(400) });
		image(card);

		expect(expireClosedCardImages(NOW(), 180)).toEqual({ expired: 0, more: false });
		expect(rows()).toHaveLength(1);
	});

	it('39. keeps a file that is not an image on an old completed card, and reads a stored type as the cap does', () => {
		const card = makeCard(A.cols['Complete'], { completedAt: daysAgo(400) });
		const text = makeAttachment(card, { name: 'notes.txt', mimeType: 'text/plain' });
		const pdf = makeAttachment(card, { name: 'spec.pdf', mimeType: 'application/pdf' });
		image(card, 'shot.jpg', 'IMAGE/JPEG; q=1');

		expect(expireClosedCardImages(NOW(), 180)).toEqual({ expired: 1, more: false });
		expect(rows().map((r) => r.id)).toEqual([text.id, pdf.id]);
	});
});

describe('how much one run takes', () => {
	it('40. with 250 due, moves 200, the oldest first, logs the count and that more are due, and the rest next run', () => {
		const now = NOW();
		const older = makeCard(A.cols['Complete'], { title: 'Older', completedAt: daysAgo(300, now) });
		const newer = makeCard(A.cols['Complete'], { title: 'Newer', completedAt: daysAgo(200, now) });
		// Rows only: 250 files are not needed to count them.
		const insert = sqlite.prepare(
			"INSERT INTO card_attachments (card_id, filename, original_name, mime_type, size_bytes) VALUES (?, ?, ?, 'image/png', 1)"
		);
		sqlite.transaction(() => {
			for (let i = 0; i < 150; i++) insert.run(newer.id, `n-${i}.png`, `n-${i}.png`);
			for (let i = 0; i < 100; i++) insert.run(older.id, `o-${i}.png`, `o-${i}.png`);
		})();

		const first = logged(() => expireClosedCardImages(now, 180));

		expect(first.result).toEqual({ expired: MOST_EXPIRED_A_RUN, more: true });
		expect(MOST_EXPIRED_A_RUN).toBe(200);
		// The older card's hundred first, then the first hundred of the newer one's, by id.
		const left = rows();
		expect(left).toHaveLength(50);
		expect(left.every((r) => r.cardId === newer.id)).toBe(true);
		expect(left.map((r) => r.filename)).toEqual(Array.from({ length: 50 }, (_, i) => `n-${i + 100}.png`));
		expect(expiredEntries()).toHaveLength(200);
		expect(first.lines.filter((line) => line.includes('[UPLOADS]'))).toEqual([
			expect.stringMatching(
				/\[INFO\] \[UPLOADS\] Moved 200 image\(s\) of cards closed more than 180 days ago to the trash; more are due, and the next run takes up to 200 of them$/
			)
		]);

		const second = logged(() => expireClosedCardImages(now, 180));
		expect(second.result).toEqual({ expired: 50, more: false });
		expect(rows()).toEqual([]);
		expect(second.lines.filter((line) => line.includes('[UPLOADS]'))).toEqual([
			expect.stringMatching(/\[INFO\] \[UPLOADS\] Moved 50 image\(s\) of cards closed more than 180 days ago to the trash$/)
		]);
	});
});

describe('IMAGE_RETENTION_DAYS (S6)', () => {
	it('41. reads off as off, a whole number from 30 to 3650 as days, unset as 180, and refuses anything else', () => {
		expect(retentionDays(undefined)).toEqual({ ok: true, days: 180 });
		expect(retentionDays('off')).toEqual({ ok: true, days: null });
		expect(retentionDays('30')).toEqual({ ok: true, days: 30 });
		expect(retentionDays('3650')).toEqual({ ok: true, days: 3650 });
		expect(retentionDays('0090')).toEqual({ ok: true, days: 90 });
		for (const value of ['abc', '10', '29', '3651', ' 180', '180 ', '+180', '-180', '180.5', '1e3', '', 'OFF', 'Off']) {
			const setting = retentionDays(value);
			expect(setting.ok, JSON.stringify(value)).toBe(false);
			if (!setting.ok) expect(setting.message).toContain(`IMAGE_RETENTION_DAYS is set to ${JSON.stringify(value)}`);
		}
	});

	it('41. through the sweep: off moves nothing and says nothing; a refused value moves nothing and logs an error; 30 is taken', () => {
		const card = makeCard(A.cols['Complete'], { completedAt: daysAgo(100) });
		image(card);

		vi.stubEnv('IMAGE_RETENTION_DAYS', 'off');
		const off = logged(() => sweepUploads());
		expect(rows()).toHaveLength(1);
		expect(off.lines.filter((line) => line.includes('[UPLOADS]'))).toEqual([]);

		for (const value of ['abc', '10', '3651', ' 180']) {
			vi.stubEnv('IMAGE_RETENTION_DAYS', value);
			const refused = logged(() => sweepUploads());
			expect(rows(), value).toHaveLength(1);
			expect(refused.lines.filter((line) => line.includes('[UPLOADS]'))).toEqual([
				expect.stringContaining(`[ERROR] [UPLOADS] IMAGE_RETENTION_DAYS is set to ${JSON.stringify(value)}, which is neither off nor a whole number of days from 30 to 3650. No image was moved to the trash`)
			]);
		}
		expect(expiredEntries()).toEqual([]);

		// Unset, 180: the card closed 100 days ago keeps its image. At 30 it does not.
		vi.unstubAllEnvs();
		sweepUploads();
		expect(rows()).toHaveLength(1);
		vi.stubEnv('IMAGE_RETENTION_DAYS', '30');
		sweepUploads();
		expect(rows()).toEqual([]);
		expect(expiredEntries()[0].detail).toContain('the card was closed more than 30 days ago');
	});
});

describe('retention and the sweep', () => {
	it('42. does nothing while a transaction is open', () => {
		const card = makeCard(A.cols['Complete'], { completedAt: daysAgo(181) });
		image(card);

		expect(inTransaction(() => expireClosedCardImages(NOW(), 180))).toBeNull();
		expect(rows()).toHaveLength(1);
		expect(expiredEntries()).toEqual([]);
	});

	it('43. when retention throws, logs an error, writes nothing, and the orphan sweep still runs', () => {
		const card = makeCard(A.cols['Complete'], { completedAt: daysAgo(181) });
		image(card);
		mkdirSync(at(card.id), { recursive: true });
		writeFileSync(at(card.id, 'stray.txt'), 'no row names it');
		const old = new Date(Date.now() - 2 * DAY_MS);
		utimesSync(at(card.id, 'stray.txt'), old, old);
		const prepare = sqlite.prepare.bind(sqlite);
		vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
			if (source.includes('JOIN cards c ON c.id = a.card_id')) throw new Error('disk I/O error');
			return prepare(source);
		}) as typeof sqlite.prepare);

		const { result, lines } = logged(() => sweepUploads());

		expect(result).toMatchObject({ moved: 1 });
		expect(existsSync(at('.trash', card.id, 'stray.txt'))).toBe(true);
		expect(rows()).toHaveLength(1);
		expect(expiredEntries()).toEqual([]);
		expect(lines).toContainEqual(
			expect.stringMatching(/\[ERROR\] \[UPLOADS\] Images of closed cards were not moved to the trash: disk I\/O error\. Nothing of this run was moved; the next run tries again\.$/)
		);
	});

	it('44. when the move to the trash fails, the row is gone, the file stays, and the next sweep moves it as a file no row names', () => {
		const card = makeCard(A.cols['Complete'], { completedAt: daysAgo(181) });
		const row = image(card);
		// The trash is a file, not a folder: nothing can be moved into it.
		mkdirSync(testUploadsDir(), { recursive: true });
		writeFileSync(at('.trash'), 'in the way');

		const first = logged(() => sweepUploads());

		expect(rows()).toEqual([]);
		expect(expiredEntries()).toHaveLength(1);
		expect(existsSync(at(card.id, row.filename))).toBe(true);
		expect(first.lines).toContainEqual(expect.stringMatching(/\[WARN\] \[DELETE\] 1 problem\(s\) moving the files of 1 deleted attachment\(s\) to the trash/));

		rmSync(at('.trash'));
		expect(sweepUploads()).toMatchObject({ moved: 1 });
		expect(existsSync(at(card.id, row.filename))).toBe(false);
		expect(existsSync(at('.trash', card.id, row.filename))).toBe(true);
	});
});
