/**
 * pending-authenticators.ts — an authenticator being added on the Account
 * page, between the step-up that begins it and the new phone's first code
 * (card 2772, D1).
 *
 * Kept in this process's memory, as the import's confirmations are
 * (step-up.ts): nothing of it is at rest, and a restart ends it. One per
 * account (S7): a new start, from any session of the account, replaces the
 * last. Each holds whose it is, the hash of the session that began it, the
 * SHA-256 of its pending id (the id itself is sent to the page only, E19),
 * the password hash the step-up checked, the name it will be given, the new
 * secret sealed under this server's MFA key with additional data of its own
 * (`addAad`, `mfa-add:`), the wrong codes sent for it, when it ends: ten
 * minutes after it began, and the SHA-256 of the last two pending ids it
 * replaced while they were live, so that only a page whose set-up was
 * replaced is told so (card 2772's code review, CS2). At most
 * `MOST_PENDING_ADDS` are held, the oldest going first, and the expired are
 * swept out as each is begun.
 *
 * It is forgotten by the confirm that writes the factor, by its fifth wrong
 * code, and by what ends the proof it was begun with: any sign-out of the
 * account, the account's own password change, a reset of its two-step
 * sign-in, and the removal of an authenticator from another session.
 *
 * Imported by mfa-store.ts and the routes; it imports neither. Nothing of it
 * is logged but its account.
 */
import { randomBytes } from 'node:crypto';
import { currentMfaKey } from './mfa-key';
import { addAad, openSealed, sealWith, sha256Hex, type Sealed } from './mfa-crypto';
import { newTotpSecret } from './totp';

/** How long a pending add can be confirmed for: ten minutes. */
export const PENDING_ADD_MS = 10 * 60 * 1000;

/** The most pending adds held at once; the oldest go first. */
export const MOST_PENDING_ADDS = 1000;

/** A pending add as it is held. */
export type PendingAdd = {
	userId: number;
	/** The hex of the hash of the session that began it. */
	session: string;
	/** The SHA-256 of its pending id, as lower-case hex. */
	idHash: string;
	/** The password hash the step-up that began it checked. */
	passwordHash: string;
	/** The name the authenticator is to be given, as read. */
	label: string;
	sealed: Pick<Sealed, 'nonce' | 'ciphertext'>;
	/** Wrong codes sent for it. */
	wrong: number;
	/** When it ends, in milliseconds since the epoch. */
	expiresAt: number;
	/**
	 * The SHA-256 of the pending ids of the last `REPLACED_KEPT` adds of the
	 * account that this one replaced while they were live, newest first
	 * (card 2772's code review, CS2): only those are told `ADD_REPLACED`.
	 * Forgotten with the entry.
	 */
	replaced: string[];
};

/** How many replaced pending ids an account's entry remembers. */
export const REPLACED_KEPT = 2;

/** The pending adds, by account: one each. */
const pending = new Map<number, PendingAdd>();

/** What a start hands the page once: the pending id, the new secret (zeroed by the caller after use), and when it ends. */
export type PendingAddIssued = { pendingId: string; secret: Buffer; expiresAt: number };

/**
 * Begin adding an authenticator for the account `userId` from the session
 * whose hash is `session`, whose password was checked against
 * `passwordHash`: a new secret, sealed under this server's key, held for
 * `PENDING_ADD_MS`, replacing any the account held. Throws when no MFA key is
 * loaded (the route has refused that before). The secret is handed back for
 * the page to be shown once; the caller zeroes it.
 */
export function issuePendingAdd(userId: number, session: Buffer, passwordHash: string, label: string, now: number = Date.now()): PendingAddIssued {
	const key = currentMfaKey();
	if (key === null) throw new Error('No MFA key is loaded, so no authenticator can be added.');
	// The account's live add, which this one replaces: its id, and the ids it
	// remembered, kept to tell a replaced page so (CS2). An ended one is not
	// replaced, and starts the list again.
	const live = pending.get(userId);
	const replaced = live !== undefined && live.expiresAt > now ? [live.idHash, ...live.replaced].slice(0, REPLACED_KEPT) : [];
	for (const [held, add] of pending) {
		if (add.expiresAt <= now || held === userId) pending.delete(held);
	}
	while (pending.size >= MOST_PENDING_ADDS) pending.delete(pending.keys().next().value!);

	const pendingId = randomBytes(32).toString('base64url');
	const idHash = sha256Hex(pendingId);
	const secret = newTotpSecret();
	const sealed = sealWith(key, secret, addAad(userId, idHash));
	const expiresAt = now + PENDING_ADD_MS;
	pending.set(userId, {
		userId,
		session: session.toString('hex'),
		idHash,
		passwordHash,
		label,
		sealed: { nonce: sealed.nonce, ciphertext: sealed.ciphertext },
		wrong: 0,
		expiresAt,
		replaced
	});
	return { pendingId, secret, expiresAt };
}

/** The account's pending add, or undefined: none, or one that has ended, which is forgotten. */
export function pendingAddOf(userId: number, now: number = Date.now()): PendingAdd | undefined {
	const held = pending.get(userId);
	if (held === undefined) return undefined;
	if (held.expiresAt <= now) {
		pending.delete(userId);
		return undefined;
	}
	return held;
}

/** Whether `pendingId` is the one the pending add was issued with. */
export function isPendingId(add: PendingAdd, pendingId: string): boolean {
	return sha256Hex(pendingId) === add.idHash;
}

/**
 * Whether `pendingId` is one of the adds the live `add` replaced, as far back
 * as it remembers (CS2). Any other id that is not the live one's was never
 * issued to the account, or ended before the live add began.
 */
export function wasReplacedBy(add: PendingAdd, pendingId: string): boolean {
	return add.replaced.includes(sha256Hex(pendingId));
}

/** The pending add's secret, or null: no key is loaded, or it does not open under this one. The caller zeroes it. */
export function openPendingSecret(add: PendingAdd): Buffer | null {
	const key = currentMfaKey();
	if (key === null) return null;
	return openSealed(key, add.sealed, addAad(add.userId, add.idHash));
}

/** Count a wrong code against the pending add, and answer how many it has had. */
export function countPendingWrong(add: PendingAdd): number {
	add.wrong += 1;
	return add.wrong;
}

/**
 * Forget the account's pending add. With `unlessSession`, only one that
 * another session began: the removal of an authenticator ends the other
 * sessions, and keeps the one that removed it (D2).
 */
export function forgetPendingAdd(userId: number, unlessSession?: Buffer): void {
	const held = pending.get(userId);
	if (held === undefined) return;
	if (unlessSession !== undefined && held.session === unlessSession.toString('hex')) return;
	pending.delete(userId);
}

/** Forget every pending add, as a restart does: for tests, between them (`resetDb`). */
export function forgetPendingAuthenticators(): void {
	pending.clear();
}
