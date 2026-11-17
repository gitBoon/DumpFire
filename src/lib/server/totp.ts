/**
 * totp.ts — authenticator-app codes (RFC 6238 over RFC 4226), card 2768.
 *
 * Six digits, a 30-second step, HMAC-SHA1 over a 20-byte secret. A code is
 * accepted for the current step and the one before it, and for no other.
 * Pure: it never looks at what was spent. Spending a step, so that a code is
 * never accepted twice, is the store's (`spendStep`, mfa-store.ts).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** 160 bits. */
export const TOTP_SECRET_BYTES = 20;

/** A new authenticator secret. */
export function newTotpSecret(): Buffer {
	return randomBytes(TOTP_SECRET_BYTES);
}

/** The HOTP code of `secret` at `counter` (RFC 4226): dynamic truncation, zero-padded. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(BigInt(counter));
	const mac = createHmac('sha1', secret).update(message).digest();
	const offset = mac[mac.length - 1] & 0x0f;
	const binary =
		((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
	return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The most characters a code is read to (card 2771, S7): longer is malformed before any pattern is tried. */
export const LONGEST_CODE = 64;

/**
 * An authenticator code by its form, or null for one not in it: text of at
 * most `LONGEST_CODE` characters which, trimmed with every space dropped, is
 * exactly six ASCII digits (`123 456` among them); answers the six digits.
 * One rule for the step-up (card 2771, D2) and the sign-in code page (card
 * 2889), so that a code that cannot be a code is refused before anything is
 * counted on either. Pure: nothing read or counted.
 */
export function readAuthenticatorCode(sent: unknown): string | null {
	if (typeof sent !== 'string' || sent.length > LONGEST_CODE) return null;
	const digits = sent.trim().replace(/ /g, '');
	return /^[0-9]{6}$/.test(digits) ? digits : null;
}

/** The time step a moment is in. */
export function stepAt(ms: number): number {
	return Math.floor(ms / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * The step `code` is the code of, the current one or the one before, or null.
 * Anything but a string is null; spaces are dropped; anything but exactly six
 * ASCII digits is null before any code is worked out. Both codes are always
 * worked out and both compared in constant time, whichever matches; the higher
 * matching step is answered.
 */
export function matchingStep(secret: Buffer, code: unknown, nowMs: number): number | null {
	if (typeof code !== 'string') return null;
	const typed = code.replace(/ /g, '');
	if (!/^[0-9]{6}$/.test(typed)) return null;

	const given = Buffer.from(typed, 'ascii');
	const step = stepAt(nowMs);
	const current = timingSafeEqual(given, Buffer.from(hotp(secret, step), 'ascii'));
	const previous = timingSafeEqual(given, Buffer.from(hotp(secret, step - 1), 'ascii'));
	if (current) return step;
	if (previous) return step - 1;
	return null;
}
