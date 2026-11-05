/**
 * recovery-codes.ts — the single-use recovery codes of two-step sign-in
 * (card 2768).
 *
 * Ten codes of sixteen characters from Crockford's base32 alphabet (no I, L,
 * O or U), shown as four groups of four: 80 random bits each, with no modulo
 * bias. A code is read leniently: either case, spaces and hyphens dropped, O
 * as 0 and I or L as 1. It is kept only as a hash bound to the account's id,
 * so a hash row moved to another account never matches. Pure: the rows are
 * the store's (mfa-store.ts).
 */
import { randomBytes } from 'node:crypto';
import { sha256Hex } from './mfa-crypto';

export const RECOVERY_CODE_COUNT = 10;
/** Crockford base32. */
export const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const CANONICAL = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/** Ten bytes as sixteen 5-bit groups. */
function encode(bytes: Buffer): string {
	let out = '';
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += RECOVERY_ALPHABET[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
		buffer &= (1 << bits) - 1;
	}
	return out;
}

/** Ten new, distinct codes, each as `XXXX-XXXX-XXXX-XXXX`. */
export function newRecoveryCodes(): string[] {
	const codes = new Set<string>();
	while (codes.size < RECOVERY_CODE_COUNT) {
		const plain = encode(randomBytes(10));
		codes.add(plain.match(/.{4}/g)!.join('-'));
	}
	return [...codes];
}

/** A code as typed, in its canonical form (16 alphabet characters), or null. */
export function canonicalRecoveryCode(input: string): string | null {
	if (typeof input !== 'string') return null;
	const read = input.toUpperCase().replace(/[ -]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
	return CANONICAL.test(read) ? read : null;
}

/** What is stored of a code: bound to the account it belongs to. */
export function recoveryCodeHash(userId: number, canonical: string): string {
	return sha256Hex(`dumpfire-recovery-v1:${userId}:${canonical}`);
}
