/**
 * upload-allowance.ts — how many images, and how many bytes of them, one
 * account may upload through `/api/v1` (card 2754, D6 and the review's S2
 * and S3) and through the card window (card 2761, D2): one allowance for
 * both, so an upload either way counts against the other.
 *
 *   30 uploads an hour        through `/api/v1`, taken before the body is
 *                             read, once the card and the type have been
 *                             asked; through the card window, whose type is
 *                             inside the form, taken straight after the form
 *                             is read (`afterRead`), in the writeAs that
 *                             charges the bytes (card 2761, S13: counting
 *                             before the body for every upload is card 2910)
 *   100 MB a day              charged with the bytes actually read, straight
 *                             after the read and before the bytes are
 *                             checked; a body refused 413 while it is read
 *                             is not charged
 *
 * Only images count: a file the card window stores as sent, of any other
 * type, takes nothing from either (card 2761, D1).
 *
 * Both are kept for the account and not for the key or the session, so a
 * second key buys nothing: `attachment-upload:user:<id>` and
 * `attachment-bytes:user:<id>`.
 * Both are in memory, with the same durability as the gate's 60 a minute
 * (`takeAllowance` in rate-limit.ts). A refusal after an allowance was taken
 * leaves it taken: an upload refused at the check or at the write was still
 * sent.
 *
 * There is no required `Content-Length` (no 411): a body sent in chunks, as
 * Cloudflare Tunnel passes one on, is counted as it is read and held to the
 * route's 5 MB by the gate (`heldToLimit`), and then charged what was read.
 *
 * Each take is handed the caller as the gate read it (`/api/v1`'s upload
 * count, a quick check before the body) or as a writeAs callback hands it
 * (the bytes, and the card window's count), and refuses with
 * `UploadAllowanceRefused`, which each route answers 429 with `Retry-After`.
 */
import type { SessionUser } from './auth';
import { takeAllowance } from './rate-limit';
import { requireUser } from './route-guards';

/** Uploads an account may make in an hour. */
export const UPLOADS_PER_HOUR = 30;
/** Bytes of image an account may upload in a day: 100 MB. */
export const UPLOAD_BYTES_PER_DAY = 100 * 1024 * 1024;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** An allowance refused: what to say, and when the window it was refused in ends. */
export class UploadAllowanceRefused extends Error {
	readonly retryAfterSecs: number;

	constructor(message: string, retryAfterSecs: number) {
		super(message);
		this.name = 'UploadAllowanceRefused';
		this.retryAfterSecs = retryAfterSecs;
	}
}

/** How long until a window ends, as a person reads it. */
function waitOf(retryAfterSecs: number): string {
	return retryAfterSecs > 3600
		? `${Math.ceil(retryAfterSecs / 3600)} hour(s)`
		: `${Math.max(1, Math.ceil(retryAfterSecs / 60))} minute(s)`;
}

/**
 * Count one upload against the caller's hour (401 for no caller). Refused
 * with `UploadAllowanceRefused` once there have been `UPLOADS_PER_HOUR`.
 * Reads no row: `/api/v1`'s route asks it before it reads the body, and its
 * refusal says nothing was read. The card window's route asks it once the
 * form is read (`afterRead`, card 2761, D3), and its refusal says only that
 * nothing was written.
 */
export function takeUploadCount(user: SessionUser | null | undefined, opts: { afterRead?: boolean } = {}): void {
	const caller = requireUser(user);
	const took = takeAllowance(`attachment-upload:user:${caller.id}`, 1, UPLOADS_PER_HOUR, HOUR_MS);
	if (took.taken) return;
	const nothing = opts.afterRead ? 'Nothing was written.' : 'Nothing was read or written.';
	throw new UploadAllowanceRefused(
		`An account can upload at most ${UPLOADS_PER_HOUR} images an hour. ${nothing} Try again in ${waitOf(took.retryAfterSecs)}.`,
		took.retryAfterSecs
	);
}

/**
 * Charge `bytes` against the caller's day (401 for no caller). Refused with
 * `UploadAllowanceRefused` when they would pass `UPLOAD_BYTES_PER_DAY`, and
 * then nothing is charged.
 */
export function takeUploadBytes(user: SessionUser | null | undefined, bytes: number): void {
	const caller = requireUser(user);
	const took = takeAllowance(`attachment-bytes:user:${caller.id}`, bytes, UPLOAD_BYTES_PER_DAY, DAY_MS);
	if (took.taken) return;
	throw new UploadAllowanceRefused(
		`An account can upload at most 100 MB of images a day, and this image would pass it. Nothing was written. Try again in ${waitOf(took.retryAfterSecs)}.`,
		took.retryAfterSecs
	);
}
