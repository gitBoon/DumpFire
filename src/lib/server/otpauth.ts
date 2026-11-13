/**
 * otpauth.ts — what an authenticator app is shown when two-step sign-in is
 * set up (card 2769): the secret in RFC 4648 base32, the `otpauth://` text
 * the app reads, the secret in groups of four for typing in by hand, and the
 * QR code of that text.
 *
 * The QR code is drawn on the server by `uqr` (0.1.3, pinned exactly; no
 * dependencies) as SVG, and handed to the page as a `data:image/svg+xml`
 * image (decision 7): an `<img>` that the policy's `img-src 'self' data:`
 * allows, and no markup put into the page with `{@html}`.
 *
 * Pure: it reads no row and keeps nothing. The secret is never logged.
 */
import { renderSVG } from 'uqr';
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from './totp';

/** The issuer an authenticator app files the account under. */
export const OTPAUTH_ISSUER = 'DumpFire';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** `bytes` in base32 (RFC 4648, section 6), padded with `=` to a multiple of eight characters. */
export function base32(bytes: Uint8Array): string {
	let out = '';
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
		buffer &= (1 << bits) - 1;
	}
	if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
	while (out.length % 8 !== 0) out += '=';
	return out;
}

/**
 * The `otpauth://` text an authenticator app reads for this account and
 * secret: the label `DumpFire:<account>`, the account encoded so that a space
 * or a colon in a name stays part of it, the secret unpadded, and the
 * algorithm, digits and period the server checks with.
 */
export function otpauthUri(account: string, secret: Uint8Array): string {
	const label = `${encodeURIComponent(OTPAUTH_ISSUER)}:${encodeURIComponent(account)}`;
	const query =
		`secret=${base32(secret).replace(/=+$/, '')}&issuer=${encodeURIComponent(OTPAUTH_ISSUER)}` +
		`&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
	return `otpauth://totp/${label}?${query}`;
}

/** The secret as a person types it into an app: base32, unpadded, in groups of four. */
export function secretInGroups(secret: Uint8Array): string {
	return base32(secret)
		.replace(/=+$/, '')
		.match(/.{1,4}/g)!
		.join(' ');
}

/** The QR code of `text`, as SVG in a `data:` address for an `<img>`. */
export function qrDataUri(text: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(renderSVG(text), 'utf8').toString('base64')}`;
}
