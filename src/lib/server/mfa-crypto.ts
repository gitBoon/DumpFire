/**
 * mfa-crypto.ts — sealing and hashing for two-step sign-in (card 2768).
 *
 * An authenticator's secret is kept only sealed: AES-256-GCM under the key
 * derived from the MFA key file (mfa-key.ts), with a nonce of 12 random bytes
 * made for every seal and a 16-byte tag. The additional data binds what is
 * sealed to where it belongs: a factor's secret to its account and its
 * `factor_uid` (`factorAad`), a secret being set up to its account and the
 * hash of its token (`enrolAad`). A sealed secret copied to another row, or to
 * another account, does not open.
 *
 * Pure: it reads no file and no row, and holds nothing. `openSealed` does not
 * look at the key id a sealed secret names: the store does (mfa-store.ts).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { MfaKey } from './mfa-key';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * A sealed secret: the id of the key that sealed it, the nonce, and the
 * ciphertext with its 16-byte tag after it. The nonce and the ciphertext are
 * base64.
 */
export type Sealed = { keyId: string; nonce: string; ciphertext: string };

/** Seal `plaintext` under `key`, bound to `aad`, with a new random nonce. */
export function sealWith(key: MfaKey, plaintext: Buffer, aad: string): Sealed {
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv(ALGORITHM, key.encryptionKey, nonce, { authTagLength: TAG_BYTES });
	cipher.setAAD(Buffer.from(aad, 'utf8'));
	const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
	return { keyId: key.id, nonce: nonce.toString('base64'), ciphertext: body.toString('base64') };
}

/**
 * Open a sealed secret, or null when it does not open: another key, other
 * additional data, a changed byte, a nonce that is not 12 bytes, or a
 * ciphertext too short to hold one byte and its tag. Any failure at all is
 * null; nothing is thrown. The tag is the last 16 bytes, and only those.
 */
export function openSealed(key: MfaKey, sealed: Pick<Sealed, 'nonce' | 'ciphertext'>, aad: string): Buffer | null {
	let part: Buffer | null = null;
	try {
		const nonce = Buffer.from(sealed.nonce, 'base64');
		const body = Buffer.from(sealed.ciphertext, 'base64');
		if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES + 1) return null;

		const decipher = createDecipheriv(ALGORITHM, key.encryptionKey, nonce, { authTagLength: TAG_BYTES });
		decipher.setAAD(Buffer.from(aad, 'utf8'));
		decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
		part = decipher.update(body.subarray(0, body.length - TAG_BYTES));
		const opened = Buffer.concat([part, decipher.final()]);
		part.fill(0);
		return opened;
	} catch {
		// What was deciphered before the tag was refused is not kept.
		part?.fill(0);
		return null;
	}
}

/** The additional data a factor's secret is sealed with. */
export const factorAad = (userId: number, factorUid: string) => `mfa-factor:${userId}:${factorUid}`;

/** The additional data a secret being set up is sealed with. */
export const enrolAad = (userId: number, tokenHash: string) => `mfa-enrol:${userId}:${tokenHash}`;

/** A new `factor_uid`: 128 random bits as hex. */
export function newFactorUid(): string {
	return randomBytes(16).toString('hex');
}

/** The SHA-256 of a text, as lower-case hex. */
export function sha256Hex(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}
