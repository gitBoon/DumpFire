/**
 * upload-allowance.ts — how many files, how many bytes of them, and how many
 * at once one account may upload, through `/api/v1` (card 2754, D6 and the
 * review's S2 and S3) and through the card window (card 2761, D2; card 2910):
 * one allowance for both, so an upload either way counts against the other.
 *
 *   3 at once, 6 on the server  a place taken before the body is read, on
 *                             either route, and given back once the upload is
 *                             answered (`takeUploadPlace`, card 2910, D6); not
 *                             counted against the hour; each place lapses
 *                             after 10 minutes (`IN_FLIGHT_LAPSE_MS`)
 *   30 uploads an hour        taken before the body is read, once the card
 *                             (and, through `/api/v1`, the type) has been
 *                             asked, on either route (card 2910, closing card
 *                             2761's S13)
 *   100 MB a day              charged with the bytes actually read, straight
 *                             after the read and before anything in them is
 *                             checked; a read that fails, is cut off 413
 *                             or runs out of its 120 seconds is charged
 *                             what the gate counted (card 2910's code
 *                             review, CS1 and CS2)
 *
 * Every file counts, image or not (card 2910, D1).
 *
 * All are kept for the account and not for the key or the session, so a
 * second key buys nothing: `attachment-upload:user:<id>`,
 * `attachment-bytes:user:<id>` and `upload-in-flight:user:<id>`, and the
 * server's `upload-in-flight:server`.
 * All are in memory, with the same durability as the gate's 60 a minute
 * (`takeAllowance` in rate-limit.ts). A refusal after an allowance was taken
 * leaves it taken: an upload refused at the check or at the write was still
 * sent.
 *
 * There is no required `Content-Length` (no 411): a body sent in chunks, as
 * Cloudflare Tunnel passes one on, is counted as it is read and held to the
 * route's limit by the gate (`heldToLimit`), and then charged what was read.
 *
 * Each take is handed the caller as the gate read it (the place and the
 * count, quick checks before the body) or as a writeAs callback hands it (the
 * bytes), and refuses with `UploadAllowanceRefused`, which each route answers
 * 429 with `Retry-After`. The first refusal of an account's hour or day in its
 * window, and the first refusal for want of a place in a spell, is one WARN
 * line in the log (card 2910, D8); no mail.
 */
import type { SessionUser } from './auth';
import { createLogger } from './logger';
import { enterInFlight, firstInFlightRefusal, leaveInFlight, takeAllowance } from './rate-limit';
import { requireUser } from './route-guards';

const log = createLogger('UPLOADS');

/** Uploads an account may make in an hour. */
export const UPLOADS_PER_HOUR = 30;
/** Bytes an account may upload in a day, every file together: 100 MB. */
export const UPLOAD_BYTES_PER_DAY = 100 * 1024 * 1024;
/** Uploads one account may have in flight at once, either way. */
export const UPLOADS_AT_ONCE = 3;
/** Uploads the server may have in flight at once, every account's together. */
export const SERVER_UPLOADS_AT_ONCE = 6;
/** The wait a refusal for want of a place gives, in seconds. */
const AT_ONCE_RETRY_SECS = 5;
/**
 * How long an upload's body is given to arrive once its read begins: 120
 * seconds (card 2910's code review, CS2). Past it the read is stopped, its
 * place given back and what was read charged, so a few accounts trickling
 * their bodies cannot hold the server's places for Node's five minutes.
 */
export const UPLOAD_READ_DEADLINE_MS = 120_000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The key of the server's places in flight. */
const SERVER_IN_FLIGHT = 'upload-in-flight:server';

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

/** The refusal for want of a place, the account's or the server's: the same words for both. */
function tooManyAtOnce(): UploadAllowanceRefused {
	return new UploadAllowanceRefused(
		'Too many uploads are in progress. Nothing was read or written. Try again when the others have finished.',
		AT_ONCE_RETRY_SECS
	);
}

/**
 * Take a place in flight for one upload by the caller (401 for no caller):
 * the account's, of `UPLOADS_AT_ONCE`, and then the server's, of
 * `SERVER_UPLOADS_AT_ONCE` (card 2910, D6). Refused with
 * `UploadAllowanceRefused` when either is full, and then nothing is held: a
 * refusal of the server's place gives the account's back before it throws.
 * Reads no row, and counts nothing against the hour.
 *
 * Answers the release: it gives back the two places this take holds, bound to
 * their own tokens, once, however often it is called; a place that lapsed
 * first is not given back twice (the review's S1). The route takes it straight
 * before a `try` and calls it only in that try's `finally`.
 */
export function takeUploadPlace(user: SessionUser | null | undefined): () => void {
	const caller = requireUser(user);
	const own = `upload-in-flight:user:${caller.id}`;
	const ownPlace = enterInFlight(own, UPLOADS_AT_ONCE);
	if (ownPlace === null) {
		if (firstInFlightRefusal(own)) {
			log.warn(
				`Account "${caller.username}" (user ${caller.id}) has ${UPLOADS_AT_ONCE} uploads in progress: more are refused until one finishes`,
				undefined,
				{ userId: caller.id }
			);
		}
		throw tooManyAtOnce();
	}
	const serverPlace = enterInFlight(SERVER_IN_FLIGHT, SERVER_UPLOADS_AT_ONCE);
	if (serverPlace === null) {
		leaveInFlight(own, ownPlace);
		if (firstInFlightRefusal(SERVER_IN_FLIGHT)) {
			log.warn(`${SERVER_UPLOADS_AT_ONCE} uploads are in progress on the server: more are refused until one finishes`);
		}
		throw tooManyAtOnce();
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		leaveInFlight(own, ownPlace);
		leaveInFlight(SERVER_IN_FLIGHT, serverPlace);
	};
}

/**
 * Count one upload against the caller's hour (401 for no caller). Refused
 * with `UploadAllowanceRefused` once there have been `UPLOADS_PER_HOUR`.
 * Reads no row: both routes ask it before they read the body, so its refusal
 * says nothing was read.
 */
export function takeUploadCount(user: SessionUser | null | undefined): void {
	const caller = requireUser(user);
	const took = takeAllowance(`attachment-upload:user:${caller.id}`, 1, UPLOADS_PER_HOUR, HOUR_MS);
	if (took.taken) return;
	if (took.firstRefusal) {
		// The account as the line's user, so the Audit page finds it by user. The logger makes the name printable.
		log.warn(
			`Account "${caller.username}" (user ${caller.id}) reached its limit of ${UPLOADS_PER_HOUR} uploads an hour: uploads are refused until the hour is up`,
			{ used: took.used, retryAfterSecs: took.retryAfterSecs },
			{ userId: caller.id }
		);
	}
	throw new UploadAllowanceRefused(
		`An account can upload at most ${UPLOADS_PER_HOUR} files an hour. Nothing was read or written. Try again in ${waitOf(took.retryAfterSecs)}.`,
		took.retryAfterSecs
	);
}

/**
 * Charge `bytes`, what was read of the upload, against the caller's day (401
 * for no caller). Refused with `UploadAllowanceRefused` when they would pass
 * `UPLOAD_BYTES_PER_DAY`, and then nothing is charged.
 */
export function takeUploadBytes(user: SessionUser | null | undefined, bytes: number): void {
	const caller = requireUser(user);
	const took = takeAllowance(`attachment-bytes:user:${caller.id}`, bytes, UPLOAD_BYTES_PER_DAY, DAY_MS);
	if (took.taken) return;
	if (took.firstRefusal) {
		log.warn(
			`Account "${caller.username}" (user ${caller.id}) reached its limit of 100 MB of uploads a day: uploads are refused until the day is up`,
			{ used: took.used, retryAfterSecs: took.retryAfterSecs },
			{ userId: caller.id }
		);
	}
	throw new UploadAllowanceRefused(
		`An account can upload at most 100 MB a day, and this upload would pass it. Nothing was written. Try again in ${waitOf(took.retryAfterSecs)}.`,
		took.retryAfterSecs
	);
}
